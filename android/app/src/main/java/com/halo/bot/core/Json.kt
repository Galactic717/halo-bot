package com.halo.bot.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * One tolerant parser for the whole app.
 *
 * `ignoreUnknownKeys` is what lets a file written by a newer build still load in an older one, and
 * `encodeDefaults = false` keeps the files small and diffable. `isLenient` matters for the model
 * side: an OpenAI-compatible server is not obliged to be strict, and a turn should not die because
 * one field arrived unquoted.
 */
val HaloJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = false
    isLenient = true
    explicitNulls = false
    prettyPrint = false
}

val HaloJsonPretty = Json(HaloJson) { prettyPrint = true }

// ---------------------------------------------------------------- argument readers
//
// A model's arguments are JSON of whatever shape it felt like. These read one field and give a
// usable default rather than throwing, because a tool that dies on a malformed argument teaches the
// model nothing, and a tool that says "path was empty" teaches it what to fix.

fun Args.str(key: String, fallback: String = ""): String {
    val value = this[key] ?: return fallback
    if (value is JsonNull) return fallback
    return when (value) {
        is JsonPrimitive -> value.content
        else -> value.toString()
    }
}

fun Args.int(key: String, fallback: Int): Int =
    (this[key] as? JsonPrimitive)?.intOrNull ?: fallback

fun Args.double(key: String, fallback: Double): Double =
    (this[key] as? JsonPrimitive)?.doubleOrNull ?: fallback

fun Args.bool(key: String, fallback: Boolean = false): Boolean {
    val value = this[key] as? JsonPrimitive ?: return fallback
    return value.booleanOrNull ?: (value.content.equals("true", ignoreCase = true))
}

fun Args.strings(key: String): List<String> {
    val value = this[key] ?: return emptyList()
    if (value is JsonArray) return value.mapNotNull { (it as? JsonPrimitive)?.content }
    if (value is JsonPrimitive && value.content.isNotBlank()) return listOf(value.content)
    return emptyList()
}

fun Args.obj(key: String): JsonObject = this[key] as? JsonObject ?: JsonObject(emptyMap())

fun JsonElement.asArgs(): Args = (this as? JsonObject) ?: emptyMap()

fun jsonOf(vararg pairs: Pair<String, String>): JsonObject =
    JsonObject(pairs.associate { it.first to JsonPrimitive(it.second) })

/** Short, readable form of a call's arguments for a card or an audit row. */
fun Args.preview(limit: Int = 120): String {
    val text = JsonObject(this).toString()
    return if (text.length <= limit) text else text.take(limit) + "…"
}

fun String.jsonPrimitiveOrNull(): String? = try {
    HaloJson.parseToJsonElement(this).jsonPrimitive.content
} catch (_: Exception) {
    null
}
