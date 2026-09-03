package com.halo.bot.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * A pasted MCP config, read.
 *
 * WHY THIS EXISTS. Every MCP server on the internet documents itself the same way: a JSON snippet you
 * drop into a client's config file. Asking somebody to read that snippet and retype its address and
 * its header into separate boxes is the step where installing a plugin stops being worth it — and it
 * is the step that makes "add absolutely anything" a slogan rather than a feature. The desktop build
 * reads the same shapes in host/plugins.ts; this is its other half.
 *
 * WHAT ANDROID CANNOT TAKE. A `command`/`args` server is a child process, and this app has neither a
 * node to run one with nor anywhere to install it. Those are *named* in the result rather than
 * silently dropped, so somebody pasting a Claude Desktop config learns which half arrived and why —
 * a plugin that quietly did not install is worse than one that says it cannot.
 */
data class ParsedConfig(
    val servers: List<PluginSpec>,
    /** Servers in the paste that only exist as a local command, with the reason. */
    val skipped: List<String>,
    val error: String? = null,
)

private fun stringOf(obj: JsonObject, vararg keys: String): String {
    for (key in keys) {
        val value = (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()
        if (!value.isNullOrEmpty()) return value
    }
    return ""
}

private fun mapOf(obj: JsonObject, key: String): Map<String, String> {
    val nested = obj[key] as? JsonObject ?: return emptyMap()
    return nested.mapNotNull { (k, v) ->
        val text = (v as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@mapNotNull null
        k to text
    }.toMap()
}

private fun slugId(name: String): String =
    ("custom-" + name.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')).take(60)

/**
 * The credential a pasted server carries, as Halo stores one.
 *
 * A config's `headers` block is where a hosted server's token lives, and `Authorization: Bearer x` is
 * the overwhelmingly common shape. Halo keeps one credential per server plus the header it goes in,
 * so the bearer case is unwrapped into that pair and anything else is kept as a literal header.
 */
private fun credentialOf(headers: Map<String, String>): Triple<Map<String, String>, String?, Map<String, String>> {
    val authKey = headers.keys.firstOrNull { it.equals("Authorization", ignoreCase = true) }
    if (authKey != null) {
        val value = headers.getValue(authKey)
        val bearer = value.removePrefix("Bearer ").removePrefix("bearer ")
        val rest = headers.filterKeys { it != authKey }.mapKeys { "header:" + it.key }
        return Triple(mapOf("token" to bearer), if (bearer == value) authKey else null, rest)
    }
    // A single custom header holding a token: keep the header name so it is sent as written.
    val single = headers.entries.firstOrNull()
    if (headers.size == 1 && single != null) {
        return Triple(mapOf("token" to single.value), single.key, emptyMap())
    }
    return Triple(emptyMap(), null, headers.mapKeys { "header:" + it.key })
}

private fun readServer(name: String, raw: JsonObject, taken: Set<String>): Pair<PluginSpec?, String?> {
    val url = stringOf(raw, "url", "serverUrl", "httpUrl", "endpoint")
    val command = stringOf(raw, "command")
    val label = stringOf(raw, "name").ifEmpty { name }
    if (url.isEmpty()) {
        return null to if (command.isNotEmpty()) {
            "$label runs as a local command, which a phone cannot do. It works in the Windows build."
        } else {
            null
        }
    }
    val headers = mapOf(raw, "headers")
    val (env, header, extra) = credentialOf(headers)
    var id = slugId(label)
    if (id in taken) id = id + "-" + (System.currentTimeMillis() % 10_000).toString()
    return PluginSpec(
        id = id,
        name = label,
        description = "A server you added: $url",
        category = "Your own",
        url = url,
        env = env,
        config = extra,
        authHeader = header,
        enabled = true,
        source = url,
    ) to null
}

/** Reads a pasted config. Returns an empty list and a reason rather than throwing. */
fun parseMcpConfig(text: String, taken: Set<String> = emptySet()): ParsedConfig {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return ParsedConfig(emptyList(), emptyList(), "Nothing to read.")
    val root = runCatching { HaloJson.parseToJsonElement(trimmed) as? JsonObject }.getOrNull()
        ?: return ParsedConfig(emptyList(), emptyList(), "That is not a JSON object.")

    // A single definition pasted on its own, rather than a map of them.
    if (root["command"] != null || root["url"] != null || root["serverUrl"] != null || root["endpoint"] != null) {
        val (spec, skipped) = readServer("Server", root, taken)
        return ParsedConfig(listOfNotNull(spec), listOfNotNull(skipped))
    }

    val map = (root["mcpServers"] as? JsonObject) ?: (root["servers"] as? JsonObject) ?: root
    val servers = mutableListOf<PluginSpec>()
    val skipped = mutableListOf<String>()
    val used = taken.toMutableSet()
    for ((name, element) in map) {
        if (element is JsonArray) continue
        val obj = element as? JsonObject ?: continue
        val (spec, reason) = readServer(name, obj, used)
        if (spec != null) {
            servers.add(spec)
            used.add(spec.id)
        }
        if (reason != null) skipped.add(reason)
    }
    if (servers.isEmpty() && skipped.isEmpty()) {
        return ParsedConfig(emptyList(), emptyList(), "No server in there had a url. Paste the whole mcpServers block.")
    }
    return ParsedConfig(servers, skipped)
}
