package com.halo.bot.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.UUID

interface RunnerPort {
    fun createAgent(name: String, title: String, description: String, color: String): Agent
    fun updateAgent(id: String, patch: (Agent) -> Agent): Agent?
    fun deliverToAgent(fromAgentId: String, toAgentId: String, text: String)
    fun postToRoom(channelId: String, fromAgentId: String, text: String)
    fun dispatchSubagent(parentAgentId: String, kind: SubagentKind, description: String, prompt: String): String
    fun checkSubagent(id: String): String
    fun messageSubagent(id: String, text: String): String
    fun stopSubagent(id: String): String
}

class ToolContext(
    val agentId: String,
    val store: Store,
    val emit: (HaloEvent) -> Unit,
    val sendMessage: (String, List<InlineImage>) -> Message,
    val systemEvent: (SystemEvent) -> Unit,
    val sendWidget: (Widget) -> Message,
    val computer: ComputerPort,
    val storage: StoragePort,
    val host: HostPort,
    val runner: RunnerPort,
    val memory: MemoryStore,
    val skills: SkillStore,
    val isCancelled: () -> Boolean,
    val startBackground: (String, File) -> String,
    val awaitBackground: suspend (String, Long) -> String,
    /** Plugin health for SelfCheck. Absent in contexts that have no plugin manager, such as a subagent. */
    val pluginStatus: (() -> List<McpServerStatus>)? = null,
)

data class ToolResult(
    val output: String,
    val isError: Boolean = false,
    /** A picture the model should actually look at, not just be told about. */
    val imagePath: String? = null,
)

class Tool(
    val schema: ToolSchema,
    /** Surface used by the approval gate; null means never gated. */
    val surface: ApprovalSurface? = null,
    val run: suspend (ToolContext, Args) -> ToolResult,
)

private fun params(json: String): JsonObject = HaloJson.parseToJsonElement(json) as JsonObject

private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

// --------------------------------------------------------------------- box paths

/**
 * Confines a path to the agent's box; throws when the model tries to escape it.
 *
 * The check is textual and then real: the canonical path has to sit inside the canonical box, so a
 * symlink planted inside the box is not a way straight out of it.
 */
private fun boxPath(ctx: ToolContext, path: String): File {
    val box = ctx.store.boxDir(ctx.agentId)
    box.mkdirs()
    val full = if (File(path).isAbsolute) File(path) else File(box, path)
    fun outside(): Nothing = throw IllegalArgumentException(
        "Path is outside your box: $path. Use ExternalRead or CopyToBox for the user's own files.",
    )
    val boxCanonical = runCatching { box.canonicalPath }.getOrDefault(box.absolutePath)
    val target = runCatching { full.canonicalPath }.getOrDefault(full.absolutePath)
    if (target != boxCanonical && !target.startsWith(boxCanonical.trimEnd(File.separatorChar) + File.separator)) outside()
    return File(target)
}

private fun relativeToBox(ctx: ToolContext, file: File): String {
    val box = ctx.store.boxDir(ctx.agentId).absolutePath
    return file.absolutePath.removePrefix(box).trimStart(File.separatorChar).ifEmpty { file.name }
}

// ------------------------------------------------------------------------ tools

val TOOLS: List<Tool> = listOf(

    Tool(
        ToolSchema(
            "SendMessage",
            "Say something to the user in the chat. This is the ONLY way the user hears from you - plain assistant text is never delivered. Use it to report progress, ask a question, or hand over finished work.",
            params("""{"type":"object","properties":{"text":{"type":"string","description":"Markdown message shown in the chat."},"images":{"type":"array","description":"Absolute paths of images to show inside this message. Only paths a tool actually returned.","items":{"type":"string"}}},"required":["text"]}"""),
        ),
    ) { ctx, args ->
        val text = args.str("text").trim()
        val images = args.strings("images").filter { it.isNotBlank() }.map { InlineImage(it) }.filter { File(it.path).exists() }
        if (text.isEmpty() && images.isEmpty()) {
            ToolResult("Nothing sent: text was empty.", isError = true)
        } else {
            ctx.sendMessage(text, images)
            ToolResult(if (images.isEmpty()) "Delivered to the user." else "Delivered with ${images.size} image(s).")
        }
    },

    Tool(
        ToolSchema(
            "ReactToMessage",
            "Put an emoji reaction on a message in this chat.",
            params("""{"type":"object","properties":{"message_id":{"type":"string","description":"Id of the message to react to; omit for the latest user message."},"emoji":{"type":"string","description":"A single emoji."}},"required":["emoji"]}"""),
        ),
    ) { ctx, args ->
        val transcript = ctx.store.transcript(ctx.agentId)
        val target = if (args.str("message_id").isNotBlank()) {
            transcript.firstOrNull { it.id == args.str("message_id") }
        } else {
            transcript.lastOrNull { it.role == Role.USER }
        }
        if (target == null) {
            ToolResult("No such message.", isError = true)
        } else {
            val reactions = target.reactions + args.str("emoji")
            ctx.store.updateMessage(ctx.agentId, target.id) { it.copy(reactions = reactions) }
            ctx.emit(HaloEvent.MessagePatch(ctx.agentId, target.id, reactions = reactions))
            ToolResult("Reaction added.")
        }
    },

    Tool(
        ToolSchema(
            "Shell",
            "Run a shell command in your own box. This is Android's `sh` (toybox), not bash and not PowerShell. Use it for anything scriptable inside your workspace.",
            params("""{"type":"object","properties":{"command":{"type":"string"},"cwd":{"type":"string","description":"Directory inside your box. Defaults to the box root."},"timeout_ms":{"type":"number"},"background":{"type":"boolean","description":"Set true for anything slow. Returns a shell id immediately; you are told when it finishes."}},"required":["command"]}"""),
        ),
        ApprovalSurface.SHELL,
    ) { ctx, args ->
        val cwd = if (args.str("cwd").isNotBlank()) boxPath(ctx, args.str("cwd")) else ctx.store.boxDir(ctx.agentId)
        if (args.bool("background")) {
            val id = ctx.startBackground(args.str("command"), cwd)
            ToolResult("Started in the background as $id. Keep working; you will be told when it finishes.")
        } else {
            val result = runShell(args.str("command"), cwd, args.int("timeout_ms", 120_000).toLong(), ctx.isCancelled)
            ToolResult(
                clip("exit ${result.code}\n" + result.out.ifBlank { "(no output)" }),
                isError = result.code != 0,
            )
        }
    },

    Tool(
        ToolSchema(
            "Read",
            "Read a text file from your box.",
            params("""{"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"number"},"limit":{"type":"number"}},"required":["path"]}"""),
        ),
    ) { ctx, args ->
        val file = boxPath(ctx, args.str("path"))
        when {
            !file.exists() -> ToolResult("No such file: " + args.str("path"), isError = true)
            fileKind(file) == FileKind.IMAGE ->
                ToolResult("${file.name} is an image. Look at it below.", imagePath = file.absolutePath)

            fileKind(file) == FileKind.BINARY ->
                ToolResult("${file.name} is a binary file (${file.length()} bytes). Use Shell to inspect it.", isError = true)

            else -> {
                val lines = file.readText().split("\n")
                val offset = maxOf(0, args.int("offset", 0))
                val limit = args.int("limit", 800)
                val slice = lines.drop(offset).take(limit).mapIndexed { i, line -> "${offset + i + 1}\t$line" }
                ToolResult(clip(slice.joinToString("\n")))
            }
        }
    },

    Tool(
        ToolSchema(
            "Write",
            "Create or overwrite a file in your box.",
            params("""{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}"""),
        ),
    ) { ctx, args ->
        val file = boxPath(ctx, args.str("path"))
        file.parentFile?.mkdirs()
        file.writeText(args.str("content"))
        ToolResult("Wrote " + args.str("content").length + " characters to " + relativeToBox(ctx, file))
    },

    Tool(
        ToolSchema(
            "Edit",
            "Replace an exact string inside a file in your box.",
            params("""{"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"}},"required":["path","old_string","new_string"]}"""),
        ),
    ) { ctx, args ->
        val file = boxPath(ctx, args.str("path"))
        when {
            !file.exists() -> ToolResult("No such file: " + args.str("path"), isError = true)
            !file.readText().contains(args.str("old_string")) ->
                ToolResult("old_string not found in the file.", isError = true)

            else -> {
                file.writeText(file.readText().replaceFirst(args.str("old_string"), args.str("new_string")))
                ToolResult("Edited.")
            }
        }
    },

    Tool(
        ToolSchema(
            "ListFiles",
            "List files and folders in your box.",
            params("""{"type":"object","properties":{"path":{"type":"string"}}}"""),
        ),
    ) { ctx, args ->
        val dir = if (args.str("path").isNotBlank()) boxPath(ctx, args.str("path")) else ctx.store.boxDir(ctx.agentId)
        if (!dir.exists()) {
            ToolResult("No such directory.", isError = true)
        } else {
            val entries = dir.listFiles().orEmpty().sortedBy { it.name }.map {
                if (it.isDirectory) it.name + "/" else "${it.name} (${it.length()} B)"
            }
            ToolResult(entries.joinToString("\n").ifEmpty { "(empty)" })
        }
    },

    // ---- the user's own files, through the folders they granted -------------------
    //
    // The desktop build has ExternalShell here as well: a real PowerShell on the user's machine with
    // the user's rights. Android has no equivalent and inventing one would be a lie — a command Halo
    // starts is Halo, sandboxed, whatever the approval card said. What exists instead is the
    // Storage Access Framework: the user picks a folder in the system picker, and that grant is
    // enforced by Android rather than only by Halo's rules. So these tools speak in documents.

    Tool(
        ToolSchema(
            "ExternalRead",
            "Read a file from the user's own storage — a folder they granted you, or a content:// uri. Needs approval. Say the path as they would: \"Documents/notes.md\".",
            params("""{"type":"object","properties":{"path":{"type":"string"},"limit":{"type":"number"}},"required":["path"]}"""),
        ),
        ApprovalSurface.EXTERNAL_READ,
    ) { ctx, args ->
        val uri = ctx.storage.resolve(args.str("path"))
            ?: return@Tool ToolResult(
                "No such file in the folders you can reach: " + args.str("path") +
                    ". The user grants a folder in the bot's Settings → Folders it may use freely.",
                isError = true,
            )
        val entry = ctx.storage.describe(uri)
        if (entry != null && entry.isDirectory) {
            return@Tool ToolResult("That is a folder. Use ExternalList to see what is in it.", isError = true)
        }
        val name = entry?.name ?: args.str("path")
        if (name.substringAfterLast('.', "").lowercase() in setOf("png", "jpg", "jpeg", "webp", "gif")) {
            // An image is something to look at. It is copied into the box first so the model can be
            // handed a real file rather than a uri only the app can open.
            val dest = File(ctx.store.boxDir(ctx.agentId), "incoming/$name")
            dest.parentFile?.mkdirs()
            ctx.storage.copyIn(uri, dest)
            return@Tool ToolResult("$name is an image; look at it below.", imagePath = dest.absolutePath)
        }
        val text = ctx.storage.readText(uri)
        ToolResult(clip(text.split("\n").take(args.int("limit", 800)).joinToString("\n")))
    },

    Tool(
        ToolSchema(
            "ExternalList",
            "List what is in one of the folders the user granted you.",
            params("""{"type":"object","properties":{"path":{"type":"string","description":"A granted folder, or a path inside one. Omit to list the granted folders themselves."}}}"""),
        ),
        ApprovalSurface.EXTERNAL_READ,
    ) { ctx, args ->
        val target = args.str("path")
        if (target.isBlank()) {
            val trees = ctx.storage.grantedTrees()
            return@Tool ToolResult(
                if (trees.isEmpty()) "The user has not granted you any folders yet."
                else trees.joinToString("\n") { "- " + shortUri(it) + "  [$it]" },
            )
        }
        val uri = ctx.storage.resolve(target)
            ?: return@Tool ToolResult("No such folder: $target", isError = true)
        val entries = ctx.storage.list(uri)
        ToolResult(
            entries.joinToString("\n") { if (it.isDirectory) it.name + "/" else "${it.name} (${it.size} B)" }
                .ifEmpty { "(empty)" },
        )
    },

    Tool(
        ToolSchema(
            "CopyToBox",
            "Copy a file from the user's storage into your box so you can work on it.",
            params("""{"type":"object","properties":{"source":{"type":"string"},"destination":{"type":"string"}},"required":["source"]}"""),
        ),
        ApprovalSurface.EXTERNAL_READ,
    ) { ctx, args ->
        val uri = ctx.storage.resolve(args.str("source"))
            ?: return@Tool ToolResult("No such file: " + args.str("source"), isError = true)
        val name = ctx.storage.describe(uri)?.name ?: args.str("source").substringAfterLast('/')
        val dest = boxPath(ctx, args.str("destination").ifBlank { name })
        dest.parentFile?.mkdirs()
        ctx.storage.copyIn(uri, dest)
        ToolResult("Copied to " + relativeToBox(ctx, dest))
    },

    Tool(
        ToolSchema(
            "CopyFromBox",
            "Copy a file out of your box onto the user's storage. Needs approval. Without a folder it lands in Downloads.",
            params("""{"type":"object","properties":{"box_path":{"type":"string"},"destination":{"type":"string","description":"A file name, optionally inside a granted folder: \"Documents/report.md\"."}},"required":["box_path"]}"""),
        ),
        ApprovalSurface.FILE_WRITE,
    ) { ctx, args ->
        val source = boxPath(ctx, args.str("box_path"))
        if (!source.exists()) return@Tool ToolResult("No such file in your box.", isError = true)
        val destination = args.str("destination").ifBlank { source.name }
        val tree = destination.substringBeforeLast('/', "").takeIf { it.isNotBlank() }?.let { ctx.storage.resolve(it) }
        val uri = ctx.storage.copyOut(source, destination.substringAfterLast('/'), tree)
        ToolResult("Wrote " + destination.substringAfterLast('/') + " to " + (tree?.let { shortUri(it) } ?: "Downloads") + " ($uri)")
    },

    Tool(
        ToolSchema(
            "ShareFile",
            "Hand a file from your box to another app through Android's share sheet — mail, chat, a note-taking app. The user picks the app and can cancel. Needs approval, because it sends the file out of Halo.",
            params("""{"type":"object","properties":{"box_path":{"type":"string"},"mime_type":{"type":"string","description":"e.g. text/markdown, image/png. Guessed when omitted."}},"required":["box_path"]}"""),
        ),
        ApprovalSurface.FILE_WRITE,
    ) { ctx, args ->
        val source = boxPath(ctx, args.str("box_path"))
        if (!source.exists()) return@Tool ToolResult("No such file in your box.", isError = true)
        val ok = ctx.storage.share(source, args.str("mime_type").takeIf { it.isNotBlank() })
        ToolResult(
            if (ok) "Opened the share sheet with ${source.name}. The user chooses where it goes, so wait for them to say."
            else "Could not open the share sheet.",
            isError = !ok,
        )
    },

    // ---- the web -----------------------------------------------------------------

    Tool(
        ToolSchema(
            "WebSearch",
            "Search the web and get back result titles, urls and snippets.",
            params("""{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}"""),
        ),
    ) { ctx, args ->
        val settings = ctx.store.getSettings()
        if (!settings.webSearch.enabled) return@Tool ToolResult("Web search is disabled in settings.", isError = true)
        val url = settings.webSearch.endpoint + java.net.URLEncoder.encode(args.str("query"), "UTF-8")
        val html = runCatching {
            Http.client.newCall(
                Request.Builder().url(url).header("user-agent", "Mozilla/5.0 HaloBot").build(),
            ).execute().use { res ->
                if (!res.isSuccessful) return@Tool ToolResult("Search failed: ${res.code}", isError = true)
                res.body.string()
            }
        }.getOrElse { return@Tool ToolResult("Search failed: " + (it.message ?: it.toString()), isError = true) }

        val out = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        // Two shapes of the same page: the classed result link, and the bare redirect link it degrades to.
        val patterns = listOf(
            Regex("<a[^>]+class=\"[^\"]*result__a[^\"]*\"[^>]*href=\"([^\"]+)\"[^>]*>([\\s\\S]*?)</a>"),
            Regex("<a[^>]+href=\"(//duckduckgo\\.com/l/\\?uddg=[^\"]+)\"[^>]*>([\\s\\S]*?)</a>"),
        )
        for (re in patterns) {
            for (m in re.findAll(html)) {
                if (out.size >= 10) break
                val raw = m.groupValues[1].replace(Regex("^.*uddg="), "").substringBefore("&")
                val link = runCatching { java.net.URLDecoder.decode(raw, "UTF-8") }.getOrDefault(raw)
                val title = htmlToText(m.groupValues[2])
                if (link.isBlank() || title.isBlank() || !seen.add(link)) continue
                out.add("${out.size + 1}. $title\n   $link")
            }
            if (out.isNotEmpty()) break
        }
        if (out.isNotEmpty()) return@Tool ToolResult(out.joinToString("\n"))

        // No links at all usually means a bot check, not an empty result set. Say which it is.
        val text = htmlToText(html)
        if (Regex("unusual traffic|are you a robot|captcha|challenge", RegexOption.IGNORE_CASE).containsMatchIn(text)) {
            ToolResult(
                "The search engine served a bot check instead of results. Use WebFetch on a specific url, or the Browser tool.",
                isError = true,
            )
        } else {
            ToolResult(clip(text.take(3000)))
        }
    },

    Tool(
        ToolSchema(
            "WebFetch",
            "Fetch a url and return its readable text.",
            params("""{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}"""),
        ),
    ) { _, args ->
        runCatching {
            Http.client.newCall(
                Request.Builder().url(args.str("url")).header("user-agent", "Mozilla/5.0 HaloBot").build(),
            ).execute().use { res ->
                if (!res.isSuccessful) return@Tool ToolResult("Fetch failed: ${res.code} ${res.message}", isError = true)
                val type = res.header("content-type").orEmpty()
                val body = res.body.string()
                ToolResult(clip(if (type.contains("html")) htmlToText(body) else body))
            }
        }.getOrElse { ToolResult("Fetch failed: " + (it.message ?: it.toString()), isError = true) }
    },

    // ---- the bot's browser --------------------------------------------------------

    Tool(
        ToolSchema(
            "Browser",
            "Drive your own browser - this is how you use websites and apps the user is already signed into. Actions: navigate, read, snapshot, click, type, press, scroll, back, screenshot. Take a snapshot before you click or type: it lists the controls on the page with a ref each, and acting by ref is what makes the action land on the thing you actually saw.",
            params("""{"type":"object","properties":{"action":{"type":"string","enum":["navigate","read","snapshot","click","type","press","scroll","back","screenshot"]},"url":{"type":"string"},"ref":{"type":"string","description":"A ref from the last snapshot, e.g. \"e12\". Preferred over selector."},"selector":{"type":"string","description":"CSS selector, or visible text. Only when you have no ref."},"text":{"type":"string"},"key":{"type":"string"},"amount":{"type":"number"}},"required":["action"]}"""),
        ),
        ApprovalSurface.BROWSER,
    ) { ctx, args ->
        val action = args.str("action").ifBlank { "read" }
        ctx.computer.ensure(ctx.agentId)
        when (action) {
            "navigate" -> {
                val (url, title) = ctx.computer.navigate(ctx.agentId, args.str("url"))
                ToolResult("Now on $title - $url")
            }

            "read" -> ToolResult(clip(ctx.computer.readPage(ctx.agentId)))
            "snapshot" -> ToolResult(clip(ctx.computer.snapshot(ctx.agentId)))
            "screenshot" -> {
                val path = ctx.computer.screenshot(ctx.agentId)
                ToolResult("Screenshot saved to $path", imagePath = path)
            }

            else -> ToolResult(clip(ctx.computer.act(ctx.agentId, action, args)))
        }
    },

    Tool(
        ToolSchema(
            "Screenshot",
            "Take a picture of what your browser is showing and save it into your box.",
            params("""{"type":"object","properties":{}}"""),
        ),
    ) { ctx, _ ->
        ctx.computer.ensure(ctx.agentId)
        val path = ctx.computer.screenshot(ctx.agentId)
        ToolResult("Screenshot saved to $path", imagePath = path)
    },

    Tool(
        ToolSchema(
            "GenerateImage",
            "Make a picture from a description — an icon, a mockup, an illustration. Never use it to depict a real person or to fake a real photo; to show something real, find and fetch the actual image instead.",
            params("""{"type":"object","properties":{"prompt":{"type":"string"},"size":{"type":"string","description":"e.g. 1024x1024"}},"required":["prompt"]}"""),
        ),
    ) { ctx, args ->
        val provider = ctx.store.getSettings().provider
        val base = provider.imageBaseUrl.trimEnd('/')
        if (base.isBlank()) {
            return@Tool ToolResult(
                "No image endpoint is configured. Tell the user to set one in Settings → Model if they want generated images.",
                isError = true,
            )
        }
        val body = kotlinx.serialization.json.buildJsonObject {
            put("model", JsonPrimitive(provider.imageModel.ifBlank { "gpt-image-1" }))
            put("prompt", JsonPrimitive(args.str("prompt")))
            put("size", JsonPrimitive(args.str("size").ifBlank { "1024x1024" }))
            put("n", JsonPrimitive(1))
            put("response_format", JsonPrimitive("b64_json"))
        }
        val request = Request.Builder()
            .url("$base/images/generations")
            .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
            .apply { if (provider.apiKey.isNotBlank()) header("Authorization", "Bearer " + provider.apiKey) }
            .build()
        val json = runCatching {
            Http.client.newCall(request).execute().use { res ->
                if (!res.isSuccessful) {
                    return@Tool ToolResult(
                        ("Image generation failed: ${res.code} " + runCatching { res.body.string() }.getOrDefault("")).take(300),
                        isError = true,
                    )
                }
                HaloJson.parseToJsonElement(res.body.string()) as JsonObject
            }
        }.getOrElse { return@Tool ToolResult("Image generation failed: " + (it.message ?: ""), isError = true) }

        val first = (json["data"] as? JsonArray)?.firstOrNull() as? JsonObject
        val dir = File(ctx.store.boxDir(ctx.agentId), "images").apply { mkdirs() }
        val file = File(dir, "image-" + System.currentTimeMillis() + ".png")
        val b64 = (first?.get("b64_json") as? JsonPrimitive)?.content
        val url = (first?.get("url") as? JsonPrimitive)?.content
        when {
            b64 != null -> file.writeBytes(android.util.Base64.decode(b64, android.util.Base64.DEFAULT))
            url != null -> Http.client.newCall(Request.Builder().url(url).build()).execute().use { res ->
                file.writeBytes(res.body.bytes())
            }

            else -> return@Tool ToolResult("The image endpoint returned nothing usable.", isError = true)
        }
        ToolResult(
            "Image saved to ${file.absolutePath}. Attach it with SendMessage images: [\"${file.absolutePath}\"]",
            imagePath = file.absolutePath,
        )
    },

    // ---- teammates ---------------------------------------------------------------

    Tool(
        ToolSchema(
            "CreateAgent",
            "Create another bot (a teammate) with its own chat, box and memory.",
            params("""{"type":"object","properties":{"name":{"type":"string"},"title":{"type":"string"},"description":{"type":"string","description":"What this teammate is for."},"color":{"type":"string"}},"required":["name"]}"""),
        ),
        ApprovalSurface.AGENT_WRITE,
    ) { ctx, args ->
        val agent = ctx.runner.createAgent(
            args.str("name"),
            args.str("title"),
            args.str("description"),
            args.str("color").ifBlank { "purple" },
        )
        ctx.systemEvent(SystemEvent("agent", "Created bot", agent.name, agent.id))
        ToolResult("Created bot \"${agent.name}\" (id ${agent.id}). Use SendToAgent to give it work.")
    },

    Tool(
        ToolSchema(
            "UpdateAgent",
            "Update your own profile (or another bot): name, title, description.",
            params("""{"type":"object","properties":{"agent_id":{"type":"string"},"name":{"type":"string"},"title":{"type":"string"},"description":{"type":"string"}}}"""),
        ),
        ApprovalSurface.AGENT_WRITE,
    ) { ctx, args ->
        val id = args.str("agent_id").ifBlank { ctx.agentId }
        val next = ctx.runner.updateAgent(id) { agent ->
            agent.copy(
                name = args.str("name").ifBlank { agent.name },
                title = if (args.containsKey("title")) args.str("title") else agent.title,
                description = if (args.containsKey("description")) args.str("description") else agent.description,
            )
        }
        if (next != null) ToolResult("Updated ${next.name}.") else ToolResult("No such bot.", isError = true)
    },

    Tool(
        ToolSchema(
            "SendToAgent",
            "Message another bot, or post into a room you belong to. Asynchronous: it returns right away and wakes them to work in their own chat. Give the id of a bot or of a channel.",
            params("""{"type":"object","properties":{"agent_id":{"type":"string"},"text":{"type":"string"}},"required":["agent_id","text"]}"""),
        ),
    ) { ctx, args ->
        val id = args.str("agent_id")
        val channel = ctx.store.getChannel(id)
        if (channel != null) {
            if (ctx.agentId !in channel.memberIds) {
                return@Tool ToolResult("You are not in the ${channel.name} room.", isError = true)
            }
            ctx.runner.postToRoom(channel.id, ctx.agentId, args.str("text"))
            ctx.systemEvent(SystemEvent("handoff", "Posted to", channel.name))
            return@Tool ToolResult("Posted in ${channel.name}. Everyone in the room sees it.")
        }
        val target = ctx.store.getAgent(id)
        if (target == null) {
            val list = ctx.store.listAgents().joinToString("\n") { "${it.name} -> ${it.id}" }
            return@Tool ToolResult("No such bot or room. Known bots:\n$list", isError = true)
        }
        ctx.runner.deliverToAgent(ctx.agentId, target.id, args.str("text"))
        ctx.systemEvent(SystemEvent("handoff", "Messaged", target.name, target.id))
        ToolResult("Sent to ${target.name}. They will work on it in their own chat.")
    },

    Tool(
        ToolSchema(
            "ListAgents",
            "List the other bots on this phone with their ids.",
            params("""{"type":"object","properties":{}}"""),
        ),
    ) { ctx, _ ->
        val list = ctx.store.listAgents().map { a ->
            "- ${a.name} (${a.id})" + (if (a.title.isNotBlank()) " - ${a.title}" else "") + " [${a.status.name.lowercase()}]"
        }
        ToolResult(list.joinToString("\n").ifEmpty { "No other bots yet." })
    },

    // ---- memory, routines, plans -------------------------------------------------

    Tool(
        ToolSchema(
            "UpdateMemory",
            "Write something durable about how the user works, their preferences, or facts you should not have to ask twice. This memory is loaded into every future turn.",
            params("""{"type":"object","properties":{"fact":{"type":"string","description":"A self-contained statement, e.g. \"The user ships on Fridays\"."},"tier":{"type":"string","enum":["profile","log","note"],"description":"profile = who the user is, kept in mind every turn. log = substantive history (default). note = minor detail that fades fast."},"forget":{"type":"string","description":"Exact text of a recorded fact to drop. Pair with a fact to correct it."}}}"""),
        ),
    ) { ctx, args ->
        val forget = args.str("forget")
        val fact = args.str("fact")
        if (forget.isNotBlank()) ctx.memory.forget(forget)
        if (fact.isNotBlank()) ctx.memory.add(MemoryTier.of(args.str("tier").ifBlank { "log" }) ?: MemoryTier.LOG, fact)
        if (forget.isBlank() && fact.isBlank()) {
            ToolResult("Give a fact to remember or a fact to forget.", isError = true)
        } else {
            ctx.systemEvent(SystemEvent("memory", "Updated memory", fact.ifBlank { forget }.take(60)))
            ToolResult("Memory updated.")
        }
    },

    Tool(
        ToolSchema(
            "CreateRoutine",
            "Save a recurring task for yourself. It fires on a schedule and you run the prompt as if the user had sent it.",
            params("""{"type":"object","properties":{"name":{"type":"string"},"prompt":{"type":"string"},"every_minutes":{"type":"number"},"daily_at":{"type":"string","description":"HH:MM, 24h"},"weekdays_at":{"type":"string","description":"HH:MM, Monday to Friday only"},"weekly_on":{"type":"string","description":"e.g. \"mon 09:00\""},"webhook":{"type":"boolean","description":"Instead of a schedule, fire when something calls in. Halo returns a loopback URL to give the user."}},"required":["name","prompt"]}"""),
        ),
        ApprovalSurface.AGENT_WRITE,
    ) { ctx, args ->
        val trigger = parseTrigger(args)
            ?: return@Tool ToolResult(
                "Give one of every_minutes, daily_at, weekdays_at, weekly_on, or webhook: true.",
                isError = true,
            )
        val routine = Routine(
            id = UUID.randomUUID().toString(),
            agentId = ctx.agentId,
            name = args.str("name"),
            prompt = args.str("prompt"),
            triggers = listOf(trigger),
            enabled = true,
            createdAt = System.currentTimeMillis(),
        )
        ctx.store.saveRoutine(routine)
        ctx.emit(HaloEvent.RoutinesChanged(ctx.store.listRoutines()))
        ctx.systemEvent(SystemEvent("routine", "Created routine", routine.name))
        val extra = if (trigger.kind == "webhook") {
            val url = ctx.host.webhookUrl(trigger.token)
            if (url.isNotBlank()) " Give the user this address to call: $url" else ""
        } else {
            ""
        }
        ToolResult("Routine \"${routine.name}\" saved (${describeTrigger(trigger)}).$extra")
    },

    Tool(
        ToolSchema("ListRoutines", "List your routines.", params("""{"type":"object","properties":{}}""")),
    ) { ctx, _ ->
        val rs = ctx.store.listRoutines().filter { it.agentId == ctx.agentId }
        ToolResult(
            rs.joinToString("\n") { r ->
                "- ${r.name} [${describeTriggers(r.triggers)}]" + (if (r.enabled) "" else " (disabled)") + " id=${r.id}"
            }.ifEmpty { "No routines." },
        )
    },

    Tool(
        ToolSchema(
            "DeleteRoutine",
            "Delete one of your routines.",
            params("""{"type":"object","properties":{"routine_id":{"type":"string"}},"required":["routine_id"]}"""),
        ),
        ApprovalSurface.AGENT_WRITE,
    ) { ctx, args ->
        ctx.store.deleteRoutine(args.str("routine_id"))
        ctx.emit(HaloEvent.RoutinesChanged(ctx.store.listRoutines()))
        ToolResult("Deleted.")
    },

    Tool(
        ToolSchema(
            "TodoWrite",
            "Keep a visible plan for a longer task. Replaces the current list.",
            params("""{"type":"object","properties":{"todos":{"type":"array","items":{"type":"object","properties":{"content":{"type":"string"},"status":{"type":"string","enum":["pending","in_progress","completed"]}},"required":["content","status"]}}},"required":["todos"]}"""),
        ),
    ) { ctx, args ->
        val todos = (args["todos"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        File(ctx.store.agentDir(ctx.agentId), "todos.json").writeText(JsonArray(todos).toString())
        val rendered = todos.joinToString("\n") { t ->
            val status = (t["status"] as? JsonPrimitive)?.content
            val mark = when (status) {
                "completed" -> "[x]"
                "in_progress" -> "[~]"
                else -> "[ ]"
            }
            "$mark " + ((t["content"] as? JsonPrimitive)?.content ?: "")
        }
        ToolResult(rendered.ifEmpty { "Cleared." })
    },

    Tool(
        ToolSchema(
            "AskUser",
            "Ask the user a question with buttons instead of prose, when you genuinely need a decision. Their pick comes back as their next message, so this ends your turn — stop after calling it.",
            params("""{"type":"object","properties":{"prompt":{"type":"string","description":"A natural question, exactly as you would say it. Not \"pick an option below\"."},"options":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string"},"value":{"type":"string","description":"What comes back as their reply. Defaults to the label."},"style":{"type":"string","enum":["default","primary","danger"]}},"required":["label"]}},"allow_custom":{"type":"boolean","description":"Let them type their own answer too."}},"required":["prompt","options"]}"""),
        ),
    ) { ctx, args ->
        val options = (args["options"] as? JsonArray).orEmpty().mapNotNull { element ->
            val o = element as? JsonObject ?: return@mapNotNull null
            val label = (o["label"] as? JsonPrimitive)?.content.orEmpty()
            if (label.isBlank()) return@mapNotNull null
            WidgetOption(
                label = label,
                value = (o["value"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() } ?: label,
                style = (o["style"] as? JsonPrimitive)?.content ?: "default",
            )
        }
        if (options.isEmpty()) {
            ToolResult("Give at least one option.", isError = true)
        } else {
            ctx.sendWidget(Widget(args.str("prompt"), options, args.bool("allow_custom")))
            ToolResult("Question sent. End your turn now — their answer arrives as the next message.")
        }
    },

    // ---- skills ------------------------------------------------------------------

    Tool(
        ToolSchema(
            "SaveSkill",
            "Save a reusable recipe you can look up later. The description decides when it applies, so write it as \"use this when ...\". A skill has no schedule — use CreateRoutine for something that should run on its own.",
            params("""{"type":"object","properties":{"name":{"type":"string"},"description":{"type":"string","description":"Use this when ..."},"body":{"type":"string","description":"The recipe, in markdown."}},"required":["name","description","body"]}"""),
        ),
        ApprovalSurface.AGENT_WRITE,
    ) { ctx, args ->
        val skill = ctx.skills.write(args.str("name"), args.str("description"), args.str("body"))
        ctx.systemEvent(SystemEvent("note", "Saved skill", skill.name))
        ToolResult("Saved skill \"${skill.name}\".")
    },

    Tool(
        ToolSchema(
            "ReadSkill",
            "Read the full body of one of your saved skills before following it.",
            params("""{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}"""),
        ),
    ) { ctx, args ->
        val skill = ctx.skills.read(args.str("name"))
        if (skill == null) ToolResult("No skill by that name.", isError = true)
        else ToolResult("# ${skill.name}\n> ${skill.description}\n\n${skill.body}")
    },

    Tool(
        ToolSchema(
            "DeleteSkill",
            "Delete one of your saved skills.",
            params("""{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}"""),
        ),
        ApprovalSurface.AGENT_WRITE,
    ) { ctx, args ->
        ToolResult(if (ctx.skills.delete(args.str("name"))) "Deleted." else "No skill by that name.")
    },

    // ---- handing over, background work -------------------------------------------

    Tool(
        ToolSchema(
            "HandOverComputer",
            "Show the user your browser and ask them to do the one step only they can do — a sign-in, 2FA, a captcha, a payment. You never see their credentials. Say what you need in one short line, then end your turn.",
            params("""{"type":"object","properties":{"instruction":{"type":"string","description":"One short line, e.g. \"Sign in to your Google account\"."}},"required":["instruction"]}"""),
        ),
    ) { ctx, args ->
        ctx.computer.handOver(ctx.agentId, args.str("instruction"))
        ctx.sendMessage(
            args.str("instruction") + " — I opened the browser for you. Tell me when you're done and I'll pick it back up.",
            emptyList(),
        )
        ToolResult("Handed the screen over. End your turn and wait for the user.")
    },

    Tool(
        ToolSchema(
            "Task",
            "Hand a self-contained chunk of work to a background worker and keep going. It runs on its own and reports back to you when it finishes, so never sit and wait for it. Scope it tight: the exact step, the specifics it needs, what \"done\" looks like, and what to report.",
            params("""{"type":"object","properties":{"kind":{"type":"string","enum":["browser","research","shell"],"description":"browser drives your browser, research searches and reads the web, shell works in your box."},"description":{"type":"string","description":"Three to five words naming the job."},"prompt":{"type":"string","description":"The full task, standalone — the worker sees none of this conversation."}},"required":["kind","description","prompt"]}"""),
        ),
    ) { ctx, args ->
        val kind = SubagentKind.of(args.str("kind").ifBlank { "research" })
        val id = ctx.runner.dispatchSubagent(ctx.agentId, kind, args.str("description"), args.str("prompt"))
        ToolResult("Dispatched $id (${kind.wire}). Keep working; you will be woken with its report. Use CheckSubagent $id if it seems stuck.")
    },

    Tool(
        ToolSchema(
            "CheckSubagent",
            "Look in on a background worker: status, recent actions, and its report so far. Use it to spot a stall, not to poll for completion.",
            params("""{"type":"object","properties":{"task_id":{"type":"string"}},"required":["task_id"]}"""),
        ),
    ) { ctx, args -> ToolResult(ctx.runner.checkSubagent(args.str("task_id"))) },

    Tool(
        ToolSchema(
            "MessageSubagent",
            "Correct or narrow a background worker that is already running. It reads this before its next step and keeps everything it has done so far — which is why this beats stopping it and dispatching a new one.",
            params("""{"type":"object","properties":{"task_id":{"type":"string"},"text":{"type":"string","description":"The correction, in one or two sentences."}},"required":["task_id","text"]}"""),
        ),
    ) { ctx, args -> ToolResult(ctx.runner.messageSubagent(args.str("task_id"), args.str("text"))) },

    Tool(
        ToolSchema(
            "StopSubagent",
            "Abort a background worker that is wedged or no longer needed. Prefer MessageSubagent when it only needs redirecting.",
            params("""{"type":"object","properties":{"task_id":{"type":"string"}},"required":["task_id"]}"""),
        ),
    ) { ctx, args -> ToolResult(ctx.runner.stopSubagent(args.str("task_id"))) },

    Tool(
        ToolSchema(
            "AwaitShell",
            "Wait for a background command you started earlier and read its output.",
            params("""{"type":"object","properties":{"shell_id":{"type":"string"},"timeout_ms":{"type":"number"}},"required":["shell_id"]}"""),
        ),
    ) { ctx, args ->
        ToolResult(clip(ctx.awaitBackground(args.str("shell_id"), args.int("timeout_ms", 120_000).toLong())))
    },


    // ---- the user's own automation -------------------------------------------------
    //
    // Halo will never have a Calendar tool, a Notion tool and a Shopify tool that are as good as the
    // real ones. A lot of people already keep those, wired up and authorised, in an n8n instance. A
    // bot that can read, write and fire an n8n workflow inherits every service they have already
    // connected, and the credentials stay in n8n rather than arriving here. See core/N8n.kt.

    Tool(
        ToolSchema(
            "N8nWorkflows",
            "List the workflows on the user's n8n, with their ids and whether they are active. Read this before you touch anything: the id is what every other n8n tool takes.",
            params("""{"type":"object","properties":{}}"""),
        ),
    ) { ctx, _ ->
        ToolResult(clip(listWorkflows(ctx.store.getSettings())))
    },

    Tool(
        ToolSchema(
            "N8nWorkflow",
            "Read one workflow as JSON - its nodes, its connections and its webhook paths. Read it before you edit it, and send the whole thing back to N8nSaveWorkflow so you change it rather than replace it.",
            params("""{"type":"object","properties":{"workflow_id":{"type":"string"}},"required":["workflow_id"]}"""),
        ),
    ) { ctx, args ->
        ToolResult(clip(getWorkflow(ctx.store.getSettings(), args.str("workflow_id"))))
    },

    Tool(
        ToolSchema(
            "N8nSaveWorkflow",
            "Create a workflow on the user's n8n, or replace an existing one. Needs approval. The workflow is n8n's own JSON: nodes and connections. A new one arrives inactive - say so, and let the user activate it.",
            params("""{"type":"object","properties":{"workflow":{"type":"string","description":"The workflow JSON: { name, nodes, connections }."},"name":{"type":"string","description":"Overrides the name inside the JSON."},"workflow_id":{"type":"string","description":"Set to replace an existing workflow; omit to create one."}},"required":["workflow"]}"""),
        ),
        ApprovalSurface.AUTOMATION,
    ) { ctx, args ->
        ToolResult(
            saveWorkflow(
                ctx.store.getSettings(),
                args.str("workflow_id"),
                args.str("name"),
                args.str("workflow"),
            ),
        )
    },

    Tool(
        ToolSchema(
            "N8nActivateWorkflow",
            "Turn a workflow on or off. Needs approval: an active workflow keeps running after you stop.",
            params("""{"type":"object","properties":{"workflow_id":{"type":"string"},"active":{"type":"boolean"}},"required":["workflow_id"]}"""),
        ),
        ApprovalSurface.AUTOMATION,
    ) { ctx, args ->
        val active = !args.containsKey("active") || args.bool("active")
        ToolResult(activateWorkflow(ctx.store.getSettings(), args.str("workflow_id"), active))
    },

    Tool(
        ToolSchema(
            "N8nRunWorkflow",
            "Fire a workflow by calling its webhook, and get back what it answered. Needs approval. n8n has no \"run this\" API - a workflow starts from its trigger - so this only works on one with a Webhook node, and the path is the one that node shows.",
            params("""{"type":"object","properties":{"path":{"type":"string","description":"The webhook path from the Webhook node, or a full url."},"method":{"type":"string","description":"POST unless the node says otherwise."},"body":{"type":"string","description":"JSON body to send."},"test":{"type":"boolean","description":"Use the test webhook, which needs \"Test workflow\" pressed in n8n."}},"required":["path"]}"""),
        ),
        ApprovalSurface.AUTOMATION,
    ) { ctx, args ->
        ToolResult(
            clip(
                runWorkflow(
                    ctx.store.getSettings(),
                    args.str("path"),
                    args.str("method"),
                    args.str("body"),
                    args.bool("test"),
                ),
            ),
        )
    },

    Tool(
        ToolSchema(
            "N8nExecutions",
            "Recent executions, newest first - how you check whether the workflow you built actually ran.",
            params("""{"type":"object","properties":{"workflow_id":{"type":"string"}}}"""),
        ),
    ) { ctx, args ->
        ToolResult(clip(listExecutions(ctx.store.getSettings(), args.str("workflow_id"))))
    },

    Tool(
        ToolSchema(
            "SelfCheck",
            "Probe the things that break Halo silently — model server, your box, browser, plugins, storage — and get one PASS/FAIL line each. Run this first when something is wrong, before guessing.",
            params("""{"type":"object","properties":{}}"""),
        ),
    ) { ctx, _ -> ToolResult(selfCheck(ctx)) },
)

/**
 * Halo's answer to Grok Bot's `box-doctor` (docs/GROK_BOT_0.24_0.27_TEARDOWN.md §11.3): one command
 * that probes the handful of things whose failure looks like a dozen unrelated failures, and prints a
 * line per check that a bot can quote to the user instead of speculating.
 */
private suspend fun selfCheck(ctx: ToolContext): String {
    val lines = mutableListOf<String>()
    fun say(ok: Boolean, name: String, detail: String) {
        lines.add("[selfcheck] " + (if (ok) "PASS" else "FAIL") + " $name: $detail")
    }

    val settings = ctx.store.getSettings()

    // The model server, which is the cause far more often than anything else here.
    val model = settings.provider.model.trim()
    if (model.isEmpty()) {
        say(false, "model", "no model chosen — Settings → Model")
    } else {
        try {
            val models = listModels(settings.provider)
            val known = models.isEmpty() || model in models
            say(
                known,
                "model",
                if (known) "$model at ${settings.provider.baseUrl}"
                else "${settings.provider.baseUrl} answers but does not serve $model",
            )
        } catch (e: Exception) {
            say(false, "model", "${settings.provider.baseUrl} unreachable — " + (e.message ?: "").take(120))
        }
    }

    // The box: writable, and holding the reference docs the bot is told to read.
    val box = ctx.store.boxDir(ctx.agentId)
    try {
        val probe = File(box, ".selfcheck-" + UUID.randomUUID().toString().take(8))
        probe.writeText("ok")
        probe.delete()
        say(true, "box", box.absolutePath)
    } catch (e: Exception) {
        say(false, "box", "cannot write ${box.absolutePath} — " + (e.message ?: "").take(120))
    }
    val refs = referenceFiles().filter { File(File(box, REFERENCE_DIR), it).exists() }
    say(refs.size == referenceFiles().size, "reference", if (refs.isEmpty()) "missing" else "$REFERENCE_DIR/: " + refs.joinToString(", "))

    // Free space, because a box that cannot write fails in a dozen unrelated-looking ways.
    val freeGb = ctx.host.freeBytes(box) / (1024.0 * 1024.0 * 1024.0)
    say(freeGb > 0.5, "storage", String.format(java.util.Locale.US, "%.1f GB free", freeGb))

    // The browser, which is created on demand and can fail long before anyone taps anything.
    try {
        ctx.computer.ensure(ctx.agentId)
        say(true, "browser", "ready")
    } catch (e: Exception) {
        say(false, "browser", (e.message ?: e.toString()).take(160))
    }

    // The automation the bots may have been told to use, if the user connected one.
    if (settings.n8n.enabled) {
        val probe = probeN8n(settings)
        say(probe.first, "n8n", probe.second)
    }

    val plugins = ctx.pluginStatus?.invoke().orEmpty()
    if (plugins.isEmpty()) {
        say(true, "plugins", "none installed")
    } else {
        for (plugin in plugins) {
            say(
                plugin.state == "ready",
                "plugin:${plugin.name}",
                if (plugin.state == "ready") "${plugin.toolCount} tools"
                else plugin.state + (plugin.error?.let { " — " + it.take(120) } ?: ""),
            )
        }
    }

    val failed = lines.count { it.contains("] FAIL ") }
    lines.add("[selfcheck] SUMMARY ${lines.size - failed} passed, $failed failed")
    return lines.joinToString("\n")
}

// ------------------------------------------------------------------- routine triggers

fun parseTrigger(args: Args): RoutineTrigger? {
    // A webhook routine waits to be called rather than watching the clock; the token is its whole
    // address, so it is generated here and never taken from the model.
    if (args.bool("webhook")) {
        return RoutineTrigger(kind = "webhook", token = UUID.randomUUID().toString().replace("-", ""))
    }
    val every = args.int("every_minutes", 0)
    if (every > 0) return RoutineTrigger(kind = "interval", everyMinutes = every)

    val weekdays = args.str("weekdays_at")
    Regex("^(\\d{1,2}):(\\d{2})$").find(weekdays)?.let {
        return RoutineTrigger(kind = "weekdays", hour = it.groupValues[1].toInt(), minute = it.groupValues[2].toInt())
    }
    val daily = args.str("daily_at")
    Regex("^(\\d{1,2}):(\\d{2})$").find(daily)?.let {
        return RoutineTrigger(kind = "daily", hour = it.groupValues[1].toInt(), minute = it.groupValues[2].toInt())
    }
    val weekly = args.str("weekly_on").lowercase()
    Regex("^(mon|tue|wed|thu|fri|sat|sun)\\s+(\\d{1,2}):(\\d{2})$").find(weekly)?.let { m ->
        val days = listOf("sun", "mon", "tue", "wed", "thu", "fri", "sat")
        return RoutineTrigger(
            kind = "weekly",
            weekday = days.indexOf(m.groupValues[1]),
            hour = m.groupValues[2].toInt(),
            minute = m.groupValues[3].toInt(),
        )
    }
    return null
}

fun describeTrigger(t: RoutineTrigger): String {
    if (t.kind == "webhook") return "when its webhook is called"
    if (t.kind == "interval") return "every ${t.everyMinutes} min"
    val hh = t.hour.toString().padStart(2, '0')
    val mm = t.minute.toString().padStart(2, '0')
    return when (t.kind) {
        "daily" -> "daily at $hh:$mm"
        "weekdays" -> "weekdays at $hh:$mm"
        else -> listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat").getOrElse(t.weekday) { "?" } + " at $hh:$mm"
    }
}

fun describeTriggers(triggers: List<RoutineTrigger>): String =
    triggers.joinToString(", ") { describeTrigger(it) }.ifEmpty { "no schedule" }

val TOOLS_BY_NAME: Map<String, Tool> = TOOLS.associateBy { it.schema.name }
