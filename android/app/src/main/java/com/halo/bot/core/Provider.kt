package com.halo.bot.core

// The failure-reason vocabulary and retry policy are adapted from Hermes Agent (MIT, (c) 2025 Nous
// Research), by way of the desktop build's host/provider.ts. See NOTICE.

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** One message on the wire, in the shape both our history and OpenAI's API use. */
data class ChatMessage(
    val role: String,
    val content: String,
    val toolCalls: List<WireToolCall> = emptyList(),
    val toolCallId: String? = null,
    val name: String? = null,
    /** data: URLs the model should look at; only sent when the model supports vision. */
    val images: List<String> = emptyList(),
)

data class WireToolCall(val id: String, val name: String, val arguments: String)

data class ToolSchema(val name: String, val description: String, val parameters: JsonObject)

data class ParsedToolCall(val id: String, val name: String, val args: Args)

data class ChatResult(
    val text: String,
    val toolCalls: List<ParsedToolCall>,
    val finishReason: String,
    val promptTokens: Int,
    val completionTokens: Int,
)

/**
 * Why a model call failed, as a code rather than a sentence.
 *
 * A caller has to branch on this — a rate limit is worth waiting out, an expired key never is, and a
 * context overflow is fixed by compacting rather than by trying again — and branching on the text of
 * somebody's error message is how that goes subtly wrong the next time a provider rewords one. The
 * vocabulary and the precedence are Hermes's: auth wins over quota, because a real 401 body often
 * mentions funds and must not be misread as a quota problem.
 */
enum class FailureReason {
    PROVIDER_AUTH_OR_ACCESS,
    PROVIDER_QUOTA_LIMIT,
    PROVIDER_RATE_LIMIT,
    PROVIDER_SERVER_ERROR,
    CONTEXT_OVERFLOW,
    MISSING_CONFIG,
    MODEL_UNAVAILABLE,
    NETWORK,
    UNKNOWN,
}

/** The reasons a retry can help with on its own, without changing anything first. */
private val TRANSIENT = setOf(
    FailureReason.PROVIDER_RATE_LIMIT,
    FailureReason.PROVIDER_SERVER_ERROR,
    FailureReason.NETWORK,
)

class ProviderError(message: String, val status: Int? = null) : Exception(message) {
    val reason: FailureReason = classifyProviderError(this)
}

fun classifyProviderError(error: Throwable?): FailureReason {
    val status = (error as? ProviderError)?.status
    val text = (error?.message ?: error.toString()).lowercase()

    if (status == 401 || status == 403 || Regex("invalid api key|unauthor|forbidden|authentication").containsMatchIn(text)) {
        return FailureReason.PROVIDER_AUTH_OR_ACCESS
    }
    if (status == 402 || Regex("out of funds|quota|insufficient|billing|credit balance").containsMatchIn(text)) {
        return FailureReason.PROVIDER_QUOTA_LIMIT
    }
    if (status == 429 || Regex("rate limit|too many requests").containsMatchIn(text)) {
        return FailureReason.PROVIDER_RATE_LIMIT
    }
    if ((status != null && status >= 500) ||
        Regex("server error|overloaded|bad gateway|service unavailable").containsMatchIn(text)
    ) {
        return FailureReason.PROVIDER_SERVER_ERROR
    }
    if (Regex("context length|context_length|maximum context|too many tokens|prompt is too long").containsMatchIn(text)) {
        return FailureReason.CONTEXT_OVERFLOW
    }
    if (Regex("no model|model not found|does not exist|unknown model").containsMatchIn(text)) {
        return FailureReason.MODEL_UNAVAILABLE
    }
    if (Regex("no api key|missing|not configured").containsMatchIn(text)) return FailureReason.MISSING_CONFIG
    if (Regex("econnreset|econnrefused|etimedout|epipe|failed to connect|unable to resolve host|timeout|network|stopped responding|socket").containsMatchIn(text)) {
        return FailureReason.NETWORK
    }
    return FailureReason.UNKNOWN
}

fun isRetryable(reason: FailureReason): Boolean = reason in TRANSIENT

/** What to tell the user, per reason. Short, and it says what would fix it. */
fun describeFailure(reason: FailureReason, message: String): String = when (reason) {
    FailureReason.PROVIDER_AUTH_OR_ACCESS -> "The model server rejected the API key. Put a working one in Settings → Model."
    FailureReason.PROVIDER_QUOTA_LIMIT -> "The model account is out of credit or over its quota."
    FailureReason.PROVIDER_RATE_LIMIT -> "The model server is rate limiting this key; it kept refusing after retries."
    FailureReason.PROVIDER_SERVER_ERROR -> "The model server is failing on its side and did not recover on retry."
    FailureReason.CONTEXT_OVERFLOW -> "The conversation outgrew the model context even after compacting."
    FailureReason.MODEL_UNAVAILABLE -> "That model is not available on this server: $message"
    // Every MISSING_CONFIG message names the thing that is missing and the screen that fixes it,
    // which is more use than a generic line about the model.
    FailureReason.MISSING_CONFIG -> message.ifBlank { "The model is not configured. Pick one in Settings → Model." }
    FailureReason.NETWORK -> "The model server could not be reached."
    FailureReason.UNKNOWN -> "Model request failed: $message"
}

private val RETRY_DELAYS_MS = longArrayOf(800, 2500)

/** A single model call that has produced nothing for this long is treated as hung. */
private const val CALL_TIMEOUT_MINUTES = 10L

/** A background job blocks a turn, so it gets a much shorter leash than a streamed answer. */
private const val HELPER_TIMEOUT_SECONDS = 90L

private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

/**
 * The address every request is built from, checked once here rather than at four call sites.
 *
 * An empty or schemeless address is a configuration mistake, not a network failure, and OkHttp says
 * so from `Request.Builder().url()` — which throws before the call exists, so it escapes the
 * `IOException` catch below and reaches the user as library jargon about URL schemes. Turned into a
 * ProviderError here it classifies as MISSING_CONFIG and says which screen fixes it.
 */
private fun endpoint(settings: ProviderSettings, path: String): String {
    val base = settings.baseUrl.trim().trimEnd('/')
    if (base.isEmpty()) {
        throw ProviderError("the model server address is not configured — set one in Settings → Model")
    }
    if (!base.startsWith("http://", ignoreCase = true) && !base.startsWith("https://", ignoreCase = true)) {
        throw ProviderError(
            "the model server address is not configured correctly: \"$base\" has to start with http:// or https://",
        )
    }
    return base + path
}

object Http {
    /**
     * One client for the whole app, so connections and the thread pool are shared.
     *
     * No call timeout: a streamed completion is allowed to take as long as it takes, and the read
     * timeout is what catches a server that has gone quiet mid-stream — which is the failure that
     * actually happens, rather than one that runs too long while still sending.
     */
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(CALL_TIMEOUT_MINUTES, TimeUnit.MINUTES)
        .writeTimeout(60, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .addInterceptor(PrivateCleartextOnly)
        .build()
}

/**
 * Plain HTTP is allowed to this phone and to this network, and to nowhere else.
 *
 * Android refuses cleartext by default and that default is right for everything Halo talks to over
 * the internet. It is wrong for the one case this app exists to support: a model server on the
 * user's own machine, which is `http://192.168.x.x:11434` and is never going to have a certificate.
 * The manifest therefore permits cleartext — Android's config file cannot express "private
 * addresses only", it only knows host names — and the rule that the manifest cannot state is
 * enforced here instead, on the one client every request in the app goes through.
 *
 * So an `http://` URL reaches a loopback, RFC1918, carrier-grade-NAT or link-local address and is
 * refused for anything else, with a message that says what to do about it. A key or a page fetched
 * in the clear across the internet is a real leak; the same request to the machine on your desk is
 * the feature.
 */
object PrivateCleartextOnly : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val url = chain.request().url
        if (!url.isHttps && !isPrivateHost(url.host)) {
            throw IOException(
                "Refusing to send this in the clear to ${url.host}. Plain http is allowed only to this " +
                    "phone or to a machine on your own network; use https for anything on the internet.",
            )
        }
        return chain.proceed(chain.request())
    }
}

/** Loopback, RFC1918, CGNAT, link-local, and the emulator's alias for the host machine. */
fun isPrivateHost(host: String): Boolean {
    val name = host.trim().trim('[', ']').lowercase()
    if (name == "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) return true
    if (name == "::1" || name.startsWith("fe80:") || name.startsWith("fc") || name.startsWith("fd")) return true
    val parts = name.split('.')
    if (parts.size != 4) return false
    val octets = parts.map { it.toIntOrNull() ?: return false }
    if (octets.any { it !in 0..255 }) return false
    val (a, b) = octets
    return when {
        a == 127 -> true
        a == 10 -> true
        a == 192 && b == 168 -> true
        a == 172 && b in 16..31 -> true
        a == 169 && b == 254 -> true
        // Carrier-grade NAT, which is what some phone hotspots hand out.
        a == 100 && b in 64..127 -> true
        else -> false
    }
}

/** Expands our simple message shape into the OpenAI content-parts form when images are attached. */
fun wireMessage(message: ChatMessage): JsonObject = buildJsonObject {
    put("role", message.role)
    if (message.images.isEmpty()) {
        put("content", message.content)
    } else {
        put(
            "content",
            buildJsonArray {
                if (message.content.isNotEmpty()) {
                    add(buildJsonObject { put("type", "text"); put("text", message.content) })
                }
                for (url in message.images) {
                    add(
                        buildJsonObject {
                            put("type", "image_url")
                            putJsonObject("image_url") { put("url", url) }
                        },
                    )
                }
            },
        )
    }
    message.name?.let { put("name", it) }
    message.toolCallId?.let { put("tool_call_id", it) }
    if (message.toolCalls.isNotEmpty()) {
        put(
            "tool_calls",
            buildJsonArray {
                for (call in message.toolCalls) {
                    add(
                        buildJsonObject {
                            put("id", call.id)
                            put("type", "function")
                            putJsonObject("function") {
                                put("name", call.name)
                                put("arguments", call.arguments)
                            }
                        },
                    )
                }
            },
        )
    }
}

/** The stored JSONL form of a message, read back into the shape the wire wants. */
fun chatMessageFromJson(obj: JsonObject): ChatMessage {
    val calls = (obj["tool_calls"] as? JsonArray)?.mapNotNull { element ->
        val o = element as? JsonObject ?: return@mapNotNull null
        val fn = o["function"]?.jsonObject ?: return@mapNotNull null
        WireToolCall(
            id = o["id"]?.jsonPrimitive?.content ?: "",
            name = fn["name"]?.jsonPrimitive?.content ?: "",
            arguments = fn["arguments"]?.jsonPrimitive?.content ?: "{}",
        )
    } ?: emptyList()
    return ChatMessage(
        role = obj["role"]?.jsonPrimitive?.content ?: "user",
        content = obj["content"]?.let { if (it is JsonPrimitive) it.content else it.toString() } ?: "",
        toolCalls = calls,
        toolCallId = obj["tool_call_id"]?.jsonPrimitive?.content,
        name = obj["name"]?.jsonPrimitive?.content,
        images = (obj["images"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList(),
    )
}

fun chatMessageToJson(message: ChatMessage): JsonObject = buildJsonObject {
    put("role", message.role)
    put("content", message.content)
    message.name?.let { put("name", it) }
    message.toolCallId?.let { put("tool_call_id", it) }
    if (message.images.isNotEmpty()) {
        put("images", buildJsonArray { message.images.forEach { add(it) } })
    }
    if (message.toolCalls.isNotEmpty()) {
        put(
            "tool_calls",
            buildJsonArray {
                for (call in message.toolCalls) {
                    add(
                        buildJsonObject {
                            put("id", call.id)
                            put("type", "function")
                            putJsonObject("function") {
                                put("name", call.name)
                                put("arguments", call.arguments)
                            }
                        },
                    )
                }
            },
        )
    }
}

private fun parseArgs(raw: String): Args {
    if (raw.isBlank()) return emptyMap()
    runCatching { return (HaloJson.parseToJsonElement(raw) as? JsonObject) ?: emptyMap() }
    // Models sometimes emit trailing prose after the JSON object.
    val start = raw.indexOf('{')
    val end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) {
        runCatching { return (HaloJson.parseToJsonElement(raw.substring(start, end + 1)) as? JsonObject) ?: emptyMap() }
    }
    return mapOf("_raw" to JsonPrimitive(raw))
}

/**
 * Streams one completion, retrying transient failures.
 *
 * A retry only happens before any text has been streamed, so the user never sees a doubled answer.
 * An expired key, a model that does not exist and a prompt that is too long all fail the same way
 * three times in a row; retrying them costs the user a minute and tells them nothing. A context
 * overflow is handled a level up, by compacting first, which is the one thing that changes the
 * outcome.
 */
suspend fun chat(
    settings: ProviderSettings,
    messages: List<ChatMessage>,
    tools: List<ToolSchema>,
    onDelta: (String) -> Unit,
    isCancelled: () -> Boolean = { false },
): ChatResult {
    var lastError: Throwable? = null
    for (attempt in 0..RETRY_DELAYS_MS.size) {
        var streamedAnything = false
        try {
            return chatOnce(settings, messages, tools, { chunk ->
                streamedAnything = true
                onDelta(chunk)
            }, isCancelled)
        } catch (error: Throwable) {
            lastError = error
            val transient = isRetryable(classifyProviderError(error))
            if (isCancelled() || streamedAnything || !transient || attempt == RETRY_DELAYS_MS.size) throw error
            kotlinx.coroutines.delay(RETRY_DELAYS_MS[attempt])
        }
    }
    throw lastError ?: ProviderError("the model call failed for an unknown reason")
}

private suspend fun chatOnce(
    settings: ProviderSettings,
    messages: List<ChatMessage>,
    tools: List<ToolSchema>,
    onDelta: (String) -> Unit,
    isCancelled: () -> Boolean,
): ChatResult = withContext(Dispatchers.IO) {
    val url = endpoint(settings, "/chat/completions")
    val body = buildJsonObject {
        put("model", settings.model)
        put("messages", buildJsonArray { messages.forEach { add(wireMessage(it)) } })
        put("stream", true)
        // Most OpenAI-compatible servers send a final usage chunk when asked; the rest ignore it.
        putJsonObject("stream_options") { put("include_usage", true) }
        if (tools.isNotEmpty() && settings.toolMode == "native") {
            put(
                "tools",
                buildJsonArray {
                    for (tool in tools) {
                        add(
                            buildJsonObject {
                                put("type", "function")
                                putJsonObject("function") {
                                    put("name", tool.name)
                                    put("description", tool.description)
                                    put("parameters", tool.parameters)
                                }
                            },
                        )
                    }
                },
            )
            put("tool_choice", "auto")
        }
    }

    val request = Request.Builder()
        .url(url)
        .post(body.toString().toRequestBody(JSON_MEDIA))
        .apply { if (settings.apiKey.isNotBlank()) header("Authorization", "Bearer " + settings.apiKey) }
        .build()

    val call = Http.client.newCall(request)
    val response = try {
        call.execute()
    } catch (e: IOException) {
        throw ProviderError(e.message ?: "the model server could not be reached")
    }

    response.use { res ->
        if (!res.isSuccessful) {
            val detail = runCatching { res.body.string() }.getOrDefault("")
            throw ProviderError(
                "${res.code} ${res.message}" + if (detail.isNotBlank()) " — " + detail.take(400) else "",
                res.code,
            )
        }
        var text = StringBuilder()
        var finishReason = "stop"
        var promptTokens = 0
        var completionTokens = 0
        val calls = LinkedHashMap<Int, WireToolCall>()

        val source = res.body.source()
        while (true) {
            if (isCancelled()) {
                call.cancel()
                break
            }
            val line = try {
                source.readUtf8Line() ?: break
            } catch (e: IOException) {
                if (isCancelled()) break
                throw ProviderError("the model server stopped responding: " + (e.message ?: ""))
            }
            val trimmed = line.trim()
            if (!trimmed.startsWith("data:")) continue
            val payload = trimmed.removePrefix("data:").trim()
            if (payload == "[DONE]") continue
            val json = runCatching { HaloJson.parseToJsonElement(payload) as JsonObject }.getOrNull() ?: continue

            (json["usage"] as? JsonObject)?.let { usage ->
                promptTokens = usage["prompt_tokens"]?.jsonPrimitive?.content?.toIntOrNull() ?: promptTokens
                completionTokens = usage["completion_tokens"]?.jsonPrimitive?.content?.toIntOrNull() ?: completionTokens
            }
            val choice = (json["choices"] as? JsonArray)?.firstOrNull() as? JsonObject ?: continue
            choice["finish_reason"]?.let { if (it is JsonPrimitive && it.content != "null") finishReason = it.content }
            val delta = (choice["delta"] as? JsonObject) ?: (choice["message"] as? JsonObject) ?: continue
            (delta["content"] as? JsonPrimitive)?.let { c ->
                if (c.content.isNotEmpty() && c.content != "null") {
                    text.append(c.content)
                    onDelta(c.content)
                }
            }
            (delta["tool_calls"] as? JsonArray)?.forEachIndexed { position, element ->
                val tc = element as? JsonObject ?: return@forEachIndexed
                val idx = tc["index"]?.jsonPrimitive?.content?.toIntOrNull() ?: position
                val cur = calls[idx] ?: WireToolCall("call_$idx", "", "")
                val fn = tc["function"] as? JsonObject
                calls[idx] = cur.copy(
                    id = tc["id"]?.jsonPrimitive?.content ?: cur.id,
                    name = fn?.get("name")?.jsonPrimitive?.content ?: cur.name,
                    arguments = cur.arguments + (fn?.get("arguments")?.jsonPrimitive?.content ?: ""),
                )
            }
        }

        ChatResult(
            text = text.toString(),
            toolCalls = calls.values.filter { it.name.isNotBlank() }
                .map { ParsedToolCall(it.id, it.name, parseArgs(it.arguments)) },
            finishReason = finishReason,
            promptTokens = promptTokens,
            completionTokens = completionTokens,
        )
    }
}

/**
 * Non-streaming helper used for small background jobs (memory synthesis, risk review, compaction).
 * Always bounded: a helper that hangs would otherwise wedge the turn that is waiting on it.
 */
suspend fun complete(settings: ProviderSettings, messages: List<ChatMessage>): String = withContext(Dispatchers.IO) {
    val url = endpoint(settings, "/chat/completions")
    val body = buildJsonObject {
        put("model", settings.model)
        put("messages", buildJsonArray { messages.forEach { add(wireMessage(it)) } })
        put("stream", false)
    }
    val request = Request.Builder()
        .url(url)
        .post(body.toString().toRequestBody(JSON_MEDIA))
        .apply { if (settings.apiKey.isNotBlank()) header("Authorization", "Bearer " + settings.apiKey) }
        .build()
    val client = Http.client.newBuilder()
        .readTimeout(HELPER_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .callTimeout(HELPER_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()
    try {
        client.newCall(request).execute().use { res ->
            if (!res.isSuccessful) throw ProviderError("${res.code} ${res.message}", res.code)
            val json = HaloJson.parseToJsonElement(res.body.string()) as JsonObject
            val choice = (json["choices"] as? JsonArray)?.firstOrNull() as? JsonObject
            (choice?.get("message") as? JsonObject)?.get("content")?.jsonPrimitive?.content ?: ""
        }
    } catch (e: IOException) {
        throw ProviderError("the model server stopped responding: " + (e.message ?: ""))
    }
}

data class ModelInfo(
    val id: String,
    /** Bytes on disk, when the server tells us. */
    val size: Long? = null,
    val parameterSize: String? = null,
    val capabilities: List<String> = emptyList(),
)

suspend fun listModels(settings: ProviderSettings): List<String> = withContext(Dispatchers.IO) {
    val url = endpoint(settings, "/models")
    val request = Request.Builder().url(url)
        .apply { if (settings.apiKey.isNotBlank()) header("Authorization", "Bearer " + settings.apiKey) }
        .build()
    Http.client.newCall(request).execute().use { res ->
        if (!res.isSuccessful) throw ProviderError("${res.code} ${res.message}", res.code)
        val json = HaloJson.parseToJsonElement(res.body.string()) as JsonObject
        (json["data"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.get("id")?.jsonPrimitive?.content }
            ?: emptyList()
    }
}

/**
 * Ollama exposes size and capabilities on its native endpoint, which is what makes it possible to
 * pick a model that actually fits the machine instead of the first one in the list. A phone talking
 * to a desktop Ollama over the LAN gets the same benefit.
 */
suspend fun listModelsDetailed(settings: ProviderSettings): List<ModelInfo> = withContext(Dispatchers.IO) {
    val base = endpoint(settings, "")
    if (base.contains("11434")) {
        val root = base.removeSuffix("/v1")
        runCatching {
            Http.client.newCall(Request.Builder().url("$root/api/tags").build()).execute().use { res ->
                if (res.isSuccessful) {
                    val json = HaloJson.parseToJsonElement(res.body.string()) as JsonObject
                    val models = (json["models"] as? JsonArray)?.mapNotNull { element ->
                        val m = element as? JsonObject ?: return@mapNotNull null
                        ModelInfo(
                            id = m["name"]?.jsonPrimitive?.content ?: return@mapNotNull null,
                            size = m["size"]?.jsonPrimitive?.content?.toLongOrNull(),
                            parameterSize = (m["details"] as? JsonObject)?.get("parameter_size")?.jsonPrimitive?.content,
                            capabilities = (m["capabilities"] as? JsonArray)?.mapNotNull { c -> (c as? JsonPrimitive)?.content }
                                ?: emptyList(),
                        )
                    } ?: emptyList()
                    if (models.isNotEmpty()) return@withContext models
                }
            }
        }
    }
    listModels(settings).map { ModelInfo(it) }
}

/** Best pick: supports tools, and the largest that still fits comfortably in memory. */
/**
 * The model one bot runs on: its own when it has one, the global default otherwise.
 *
 * One function rather than the same three lines at each call site — the second copy was in the
 * subagent loop and had been written as "the global model", so a bot the user had deliberately put
 * on a bigger model handed its background work to a smaller one.
 */
fun providerFor(provider: ProviderSettings, agent: Agent?): ProviderSettings {
    val model = agent?.model?.trim().orEmpty()
    return if (model.isEmpty()) provider else provider.copy(model = model)
}

/**
 * Best pick, with `memoryBytes` describing the machine the *model server* runs on.
 *
 * On the desktop that is this machine, so "does it fit in memory" is a real question. On a phone the
 * server is somebody else's — a box on the wifi, or a hosted API — and this app has no way to know
 * how much memory it has. Pass 0 there: the size ordering is dropped and the ranking is only the two
 * things that are still true anywhere, which is that an embedding model cannot chat and a model
 * without tool calling cannot drive anything.
 */
fun rankModels(models: List<ModelInfo>, memoryBytes: Long): List<ModelInfo> {
    val usable = models
        .filterNot { Regex("embed|bge|nomic|reranker", RegexOption.IGNORE_CASE).containsMatchIn(it.id) }
        .filter { it.capabilities.isEmpty() || it.capabilities.contains("tools") }
    if (memoryBytes <= 0) return usable
    val budget = (memoryBytes * 0.55).toLong()
    return usable.sortedWith(
        compareByDescending<ModelInfo> { if ((it.size ?: 0) <= budget) 1 else 0 }
            .thenByDescending { it.size ?: 0 },
    )
}
