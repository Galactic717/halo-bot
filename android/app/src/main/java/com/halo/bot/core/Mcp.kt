package com.halo.bot.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.atomic.AtomicInteger

/**
 * Plugins, as MCP servers reached over the network.
 *
 * This is the one place the desktop build's design could not be carried over unchanged. There, a
 * plugin is an npm package Halo spawns as a child process and talks to over stdio. Android has no
 * child processes it can install anything into and no node to run them with, so every plugin here is
 * a **remote** server spoken to over Streamable HTTP — the transport the MCP specification added
 * precisely for clients that cannot fork. What a bot sees is identical: tools named
 * `mcp__<server>__<tool>`, listed and called the same way, gated and audited the same way.
 *
 * ponytail: one request per call, no session resumption, no server-initiated messages. Halo only
 * ever asks questions; if a server ever needs to push, this wants a real SSE reader, not a bigger
 * request.
 */

data class McpServerStatus(
    val id: String,
    val name: String,
    val state: String,
    val toolCount: Int,
    val error: String? = null,
)

data class McpTool(val name: String, val description: String, val inputSchema: JsonObject)

/** Everything a spec needs before it can start. */
fun missingFields(spec: PluginSpec): List<McpField> {
    val missing = mutableListOf<McpField>()
    for (field in spec.requires) if (!field.optional && spec.env[field.key].isNullOrBlank()) missing.add(field)
    for (field in spec.setup) if (!field.optional && spec.config[field.key].isNullOrBlank()) missing.add(field)
    return missing
}

private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
private const val CALL_TIMEOUT_SECONDS = 120L

/** One MCP server over Streamable HTTP, speaking JSON-RPC 2.0. */
private class McpClient(val spec: PluginSpec) {
    var tools: List<McpTool> = emptyList()
    var state: String = "stopped"
    var error: String? = null
    private var sessionId: String? = null
    private val nextId = AtomicInteger(1)

    suspend fun start() {
        if (state == "ready" || state == "starting") return
        state = "starting"
        error = null
        try {
            request(
                "initialize",
                buildJsonObject {
                    put("protocolVersion", "2025-06-18")
                    putJsonObject("capabilities") {}
                    putJsonObject("clientInfo") {
                        put("name", "Halo Bot")
                        put("version", "0.1.0")
                    }
                },
            )
            notify("notifications/initialized")
            val listed = request("tools/list", buildJsonObject {})
            tools = (listed?.get("tools") as? JsonArray)?.mapNotNull { element ->
                val tool = element as? JsonObject ?: return@mapNotNull null
                McpTool(
                    name = (tool["name"] as? JsonPrimitive)?.content ?: return@mapNotNull null,
                    description = (tool["description"] as? JsonPrimitive)?.content.orEmpty(),
                    inputSchema = (tool["inputSchema"] as? JsonObject) ?: JsonObject(emptyMap()),
                )
            } ?: emptyList()
            state = "ready"
        } catch (e: Exception) {
            state = "error"
            error = e.message ?: e.toString()
        }
    }

    fun stop() {
        state = "stopped"
        tools = emptyList()
        sessionId = null
    }

    suspend fun callTool(name: String, args: Args): String {
        val result = request(
            "tools/call",
            buildJsonObject {
                put("name", name)
                put("arguments", JsonObject(args))
            },
        ) ?: return "(no output)"
        val text = (result["content"] as? JsonArray)?.joinToString("\n") { part ->
            val obj = part as? JsonObject ?: return@joinToString ""
            val type = (obj["type"] as? JsonPrimitive)?.content
            if (type == "text") (obj["text"] as? JsonPrimitive)?.content.orEmpty() else "[$type]"
        }?.trim().orEmpty()
        return text.ifEmpty { "(no output)" }
    }

    private fun notify(method: String) {
        runCatching { send(buildJsonObject { put("jsonrpc", "2.0"); put("method", method) }) }
    }

    private suspend fun request(method: String, params: JsonObject): JsonObject? = withContext(Dispatchers.IO) {
        val payload = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", nextId.getAndIncrement())
            put("method", method)
            put("params", params)
        }
        val body = send(payload) ?: throw Exception("$method returned nothing")
        (body["error"] as? JsonObject)?.let { throw Exception(it.toString().take(300)) }
        body["result"] as? JsonObject
    }

    /**
     * One JSON-RPC exchange.
     *
     * A Streamable HTTP server may answer with plain JSON or with an SSE stream carrying one
     * `message` event; both are legal for a request-response, and a client that only handles the
     * first works with about half the servers in the wild. The stream is read to its first data
     * frame, which is the answer.
     */
    private fun send(payload: JsonObject): JsonObject? {
        val builder = Request.Builder()
            .url(spec.url)
            .post(payload.toString().toRequestBody(JSON_MEDIA))
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-06-18")
        sessionId?.let { builder.header("Mcp-Session-Id", it) }
        credential()?.let { (header, value) -> builder.header(header, value) }
        for ((key, value) in spec.config) if (key.startsWith("header:")) builder.header(key.removePrefix("header:"), value)

        val client = Http.client.newBuilder()
            .callTimeout(CALL_TIMEOUT_SECONDS, java.util.concurrent.TimeUnit.SECONDS)
            .build()
        client.newCall(builder.build()).execute().use { res ->
            res.header("Mcp-Session-Id")?.let { sessionId = it }
            if (!res.isSuccessful) {
                throw Exception("${res.code} ${res.message} — " + runCatching { res.body.string() }.getOrDefault("").take(300))
            }
            val type = res.header("Content-Type").orEmpty()
            if (type.contains("text/event-stream")) {
                val source = res.body.source()
                while (true) {
                    val line = source.readUtf8Line() ?: break
                    val trimmed = line.trim()
                    if (!trimmed.startsWith("data:")) continue
                    val data = trimmed.removePrefix("data:").trim()
                    if (data.isEmpty() || data == "[DONE]") continue
                    return runCatching { HaloJson.parseToJsonElement(data) as JsonObject }.getOrNull() ?: continue
                }
                return null
            }
            val text = res.body.string()
            if (text.isBlank()) return null
            return runCatching { HaloJson.parseToJsonElement(text) as JsonObject }.getOrNull()
        }
    }

    /** The one secret a remote server needs, sent the way that server asks for it. */
    private fun credential(): Pair<String, String>? {
        val value = spec.requires.firstNotNullOfOrNull { spec.env[it.key]?.takeIf { v -> v.isNotBlank() } }
            ?: spec.env.values.firstOrNull { it.isNotBlank() }
            ?: return null
        val header = spec.authHeader
        return if (header.isNullOrBlank()) "Authorization" to "Bearer $value" else header to value
    }
}

private const val TOOL_PREFIX = "mcp__"

class McpManager {
    companion object {
        /**
         * A handful of plugin tools is cheaper to carry than to look up. A shelf of them is not: past
         * this the toolset turns into two meta-tools the bot calls on demand, which is what keeps the
         * prompt inside a small model's window.
         */
        const val INLINE_LIMIT = 8
    }

    private val clients = LinkedHashMap<String, McpClient>()
    private val mutex = Mutex()

    /** Brings the running set in line with what is installed and enabled. */
    suspend fun sync(specs: List<PluginSpec>) = mutex.withLock {
        val wanted = specs.filter { it.enabled && it.url.isNotBlank() && missingFields(it).isEmpty() }
        for (id in clients.keys.toList()) {
            if (wanted.none { it.id == id }) clients.remove(id)?.stop()
        }
        for (spec in wanted) {
            val existing = clients[spec.id]
            if (existing != null && existing.spec == spec && existing.state == "ready") continue
            existing?.stop()
            val client = McpClient(spec)
            clients[spec.id] = client
            client.start()
        }
    }

    fun statuses(): List<McpServerStatus> = clients.values.map {
        McpServerStatus(it.spec.id, it.spec.name, it.state, it.tools.size, it.error)
    }

    fun tools(id: String): List<McpTool> = clients[id]?.tools.orEmpty()

    private fun qualified(spec: PluginSpec, tool: McpTool) = "$TOOL_PREFIX${spec.id}__${tool.name}"

    fun toolSchemas(): List<ToolSchema> = clients.values.filter { it.state == "ready" }.flatMap { client ->
        client.tools.map { tool ->
            ToolSchema(
                name = qualified(client.spec, tool),
                description = "[${client.spec.name}] " + tool.description.take(400),
                parameters = tool.inputSchema,
            )
        }
    }

    fun isPluginTool(name: String): Boolean = name.startsWith(TOOL_PREFIX) && resolve(name) != null

    private fun resolve(name: String): Pair<McpClient, String>? {
        if (!name.startsWith(TOOL_PREFIX)) return null
        val rest = name.removePrefix(TOOL_PREFIX)
        for (client in clients.values) {
            val prefix = client.spec.id + "__"
            if (!rest.startsWith(prefix)) continue
            val toolName = rest.removePrefix(prefix)
            if (client.tools.any { it.name == toolName }) return client to toolName
        }
        return null
    }

    suspend fun call(name: String, args: Args): String {
        val (client, toolName) = resolve(name) ?: throw Exception("$name is not a plugin tool.")
        if (client.state != "ready") throw Exception("${client.spec.name} is not running: ${client.error ?: client.state}")
        return client.callTool(toolName, args)
    }

    /**
     * The two meta-tools that stand in for inlined plugin schemas once there are too many of them.
     * Listing is read-only; calling is routed straight into the plugin path, so it lands on the trail
     * like any other plugin call.
     */
    fun metaSchemas(): List<ToolSchema> = listOf(
        ToolSchema(
            name = "ListPluginTools",
            description = "List the tools the installed plugins expose, with their arguments. Call this before CallPluginTool so you use a real name.",
            parameters = HaloJson.parseToJsonElement(
                """{"type":"object","properties":{"plugin":{"type":"string","description":"Only this plugin's tools. Omit for all of them."}}}""",
            ) as JsonObject,
        ),
        ToolSchema(
            name = "CallPluginTool",
            description = "Call one plugin tool by its full name, as ListPluginTools reported it.",
            parameters = HaloJson.parseToJsonElement(
                """{"type":"object","properties":{"name":{"type":"string"},"arguments":{"type":"object"}},"required":["name"]}""",
            ) as JsonObject,
        ),
    )

    fun catalogue(plugin: String? = null): String {
        val ready = clients.values.filter { it.state == "ready" }
            .filter { plugin.isNullOrBlank() || it.spec.id == plugin || it.spec.name.equals(plugin, true) }
        if (ready.isEmpty()) return "No plugin tools are available."
        return ready.joinToString("\n\n") { client ->
            val lines = client.tools.joinToString("\n") { tool ->
                val props = (tool.inputSchema["properties"] as? JsonObject)?.keys?.joinToString(", ").orEmpty()
                "  ${qualified(client.spec, tool)}(${props}) — ${tool.description.take(160)}"
            }
            "${client.spec.name}:\n$lines"
        }
    }
}
