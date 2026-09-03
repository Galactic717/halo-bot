package com.halo.bot.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * The user's own n8n, as six tools. The Kotlin half of host/n8n.ts, kept in step with it.
 *
 * WHY N8N AND NOT A CONNECTOR PER VENDOR. Halo will never have a Google Calendar tool, a Notion tool
 * and a Shopify tool that are all as good as the real ones. A lot of people already keep those
 * integrations in an n8n instance, wired up and authorised. A bot that can read, write and fire an
 * n8n workflow inherits every service the user has already connected, and the credentials stay in
 * n8n rather than arriving in this app.
 *
 * WHAT IS GATED AND WHAT IS NOT. Listing and reading is a read of the user's own service, like
 * fetching a page — no prompt. Writing, activating and firing go through the approval gate on the
 * `automation` surface, because a workflow keeps running after the turn ends and can reach
 * everything n8n is connected to.
 */

class N8nError(message: String) : Exception(message)

private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

/** The base with any trailing slash and any accidental `/api/v1` removed, so callers add it once. */
fun n8nRoot(baseUrl: String): String =
    baseUrl.trim().trimEnd('/').removeSuffix("/api/v1")

private fun ready(settings: Settings): N8nSettings {
    val n8n = settings.n8n
    if (!n8n.enabled || n8n.baseUrl.isBlank()) {
        throw N8nError(
            "n8n is not connected. The user turns it on in Settings - General - Automation and gives Halo the " +
                "address of their n8n and an API key from n8n - Settings - n8n API.",
        )
    }
    return n8n
}

private suspend fun api(
    n8n: N8nSettings,
    path: String,
    method: String = "GET",
    body: String? = null,
): JsonObject = withContext(Dispatchers.IO) {
    val builder = Request.Builder()
        .url(n8nRoot(n8n.baseUrl) + "/api/v1" + path)
        .header("Accept", "application/json")
    if (n8n.apiKey.isNotBlank()) builder.header("X-N8N-API-KEY", n8n.apiKey.trim())
    when (method) {
        "GET" -> builder.get()
        "POST" -> builder.post((body ?: "{}").toRequestBody(JSON_MEDIA))
        "PUT" -> builder.put((body ?: "{}").toRequestBody(JSON_MEDIA))
        "PATCH" -> builder.patch((body ?: "{}").toRequestBody(JSON_MEDIA))
        else -> builder.method(method, body?.toRequestBody(JSON_MEDIA))
    }
    Http.client.newCall(builder.build()).execute().use { response ->
        val text = runCatching { response.body.string() }.getOrDefault("")
        if (!response.isSuccessful) {
            // n8n answers 401 with an HTML login page, which reads as nonsense in a tool result.
            if (response.code == 401 || response.code == 403) {
                throw N8nError("n8n refused the API key. Check Settings - General - Automation against n8n - Settings - n8n API.")
            }
            throw N8nError("n8n answered ${response.code}: " + text.take(300))
        }
        if (text.isBlank()) return@use JsonObject(emptyMap())
        runCatching { HaloJson.parseToJsonElement(text) as JsonObject }
            .getOrElse { throw N8nError("n8n answered with something that is not JSON: " + text.take(200)) }
    }
}

private fun JsonObject.text(key: String): String = (this[key] as? JsonPrimitive)?.content.orEmpty()

/** Every workflow, one line each. What a bot reads before it decides which one to touch. */
suspend fun listWorkflows(settings: Settings): String {
    val result = api(ready(settings), "/workflows?limit=100")
    val rows = (result["data"] as? JsonArray).orEmpty()
    if (rows.isEmpty()) return "There are no workflows on that n8n yet."
    return rows.mapNotNull { it as? JsonObject }.joinToString("\n") { w ->
        val active = (w["active"] as? JsonPrimitive)?.content == "true"
        val tags = (w["tags"] as? JsonArray).orEmpty()
            .mapNotNull { (it as? JsonObject)?.text("name") }
            .filter { it.isNotBlank() }
            .joinToString(", ")
        "- " + w.text("name") + " (id " + w.text("id") + ")" +
            (if (active) " [active]" else " [inactive]") +
            (if (tags.isNotEmpty()) " - $tags" else "")
    }
}

/** One workflow, as JSON. A bot reads this before editing so it changes rather than replaces. */
suspend fun getWorkflow(settings: Settings, id: String): String =
    HaloJsonPretty.encodeToString(JsonObject.serializer(), api(ready(settings), "/workflows/" + id.trim()))

/**
 * Creates or replaces a workflow.
 *
 * n8n's create endpoint refuses fields it considers read-only (`active`, `id`, `tags`, timestamps),
 * so they are stripped rather than passed through — a model that copied a workflow it had just read
 * would otherwise get a 400 it cannot diagnose.
 */
suspend fun saveWorkflow(settings: Settings, workflowId: String, name: String, workflow: String): String {
    val n8n = ready(settings)
    val parsed = runCatching { HaloJson.parseToJsonElement(workflow) as JsonObject }
        .getOrElse { throw N8nError("The workflow is not valid JSON: " + (it.message ?: "").take(160)) }
    val label = name.trim().ifBlank { parsed.text("name").ifBlank { "Untitled workflow" } }
    val body = buildJsonObject {
        put("name", label)
        put("nodes", parsed["nodes"] ?: JsonArray(emptyList()))
        put("connections", parsed["connections"] ?: JsonObject(emptyMap()))
        put("settings", parsed["settings"] ?: JsonObject(emptyMap()))
    }
    val saved = api(
        n8n,
        if (workflowId.isBlank()) "/workflows" else "/workflows/" + workflowId.trim(),
        if (workflowId.isBlank()) "POST" else "PUT",
        body.toString(),
    )
    val verb = if (workflowId.isBlank()) "Created" else "Updated"
    return "$verb \"" + saved.text("name").ifBlank { label } + "\" (id " +
        saved.text("id").ifBlank { workflowId } + "). It is inactive until you activate it."
}

suspend fun activateWorkflow(settings: Settings, id: String, active: Boolean): String {
    api(ready(settings), "/workflows/" + id.trim() + "/" + (if (active) "activate" else "deactivate"), "POST")
    return (if (active) "Activated" else "Deactivated") + " workflow " + id + "."
}

/** The last executions, newest first, so a bot can say whether the thing it built actually ran. */
suspend fun listExecutions(settings: Settings, workflowId: String): String {
    val query = if (workflowId.isBlank()) "?limit=20" else "?limit=20&workflowId=" + workflowId.trim()
    val result = api(ready(settings), "/executions$query")
    val rows = (result["data"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
    if (rows.isEmpty()) return "No executions recorded."
    return rows.joinToString("\n") { e ->
        "- " + e.text("startedAt").ifBlank { "?" } + " " + e.text("status").ifBlank { "?" } +
            " (execution " + e.text("id") + ", workflow " + e.text("workflowId") + ")"
    }
}

/**
 * Fires a workflow by calling its webhook.
 *
 * n8n's public API deliberately has no "run this workflow" endpoint — a workflow is started by its
 * trigger, and for one a bot can start that means a Webhook node. So this posts to the webhook path,
 * and says so plainly when the workflow has no webhook rather than pretending the API could have
 * done it.
 */
suspend fun runWorkflow(settings: Settings, path: String, method: String, body: String, test: Boolean): String {
    val n8n = ready(settings)
    val trimmed = path.trim().trimStart('/')
    if (trimmed.isEmpty()) throw N8nError("Give the webhook path from the workflow's Webhook node.")
    val url = if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(path)) {
        path.trim()
    } else {
        n8nRoot(n8n.baseUrl) + "/" + (if (test) "webhook-test" else "webhook") + "/" + trimmed
    }
    val verb = method.ifBlank { "POST" }.uppercase()
    return withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(url)
        if (verb == "GET" || body.isBlank()) builder.method(verb, if (verb == "GET") null else "".toRequestBody(JSON_MEDIA))
        else builder.method(verb, body.toRequestBody(JSON_MEDIA))
        Http.client.newCall(builder.build()).execute().use { response ->
            val text = runCatching { response.body.string() }.getOrDefault("")
            if (response.code == 404) {
                return@use "n8n has no webhook at $url. A workflow only answers on its production webhook once it " +
                    "is active; while you are testing, set test: true and press \"Test workflow\" in n8n first."
            }
            "${response.code} ${response.message}\n" + text.take(4000).ifBlank { "(no body)" }
        }
    }
}

/** One line for SelfCheck: is the configured n8n actually there. */
suspend fun probeN8n(settings: Settings): Pair<Boolean, String> {
    if (!settings.n8n.enabled) return true to "not connected"
    return runCatching {
        val result = api(settings.n8n, "/workflows?limit=1")
        val has = (result["data"] as? JsonArray).orEmpty().isNotEmpty()
        true to (n8nRoot(settings.n8n.baseUrl) + " answered (" + (if (has) "has workflows" else "no workflows yet") + ")")
    }.getOrElse { false to (it.message ?: it.toString()).take(160) }
}

private fun JsonArray?.orEmpty(): List<kotlinx.serialization.json.JsonElement> = this ?: emptyList()

@Suppress("unused")
private fun JsonPrimitive.asText(): String = jsonPrimitive.content
