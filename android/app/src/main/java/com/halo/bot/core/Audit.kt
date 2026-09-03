package com.halo.bot.core

// The decide-record-act ordering is adapted from OpenBot (MIT, (c) 2026 CopilotKit). See NOTICE.

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File

/**
 * What each bot was allowed to do, what it was refused, and what then failed.
 *
 * The record is not a report written alongside the work, it is the thing the work goes through: the
 * gate writes the row before the action runs, so there is no path that acts without appearing here.
 * That ordering is the whole point, and it is borrowed wholesale from OpenBot's gateway — a trail
 * that only contains successes cannot show the sequence somebody needs when something has gone wrong.
 *
 * A permitted action that then failed gets a second row rather than an edit, because "allowed" and
 * "happened" are different facts and a reader will otherwise take the first for the second.
 *
 * ponytail: append-only JSONL with a size roll. One phone, one person. If this ever needs filtering
 * by more than the loaded window, it wants Room, not a bigger read.
 */

/** Rolled at this size so the file can always be read into memory to be searched. */
private const val MAX_BYTES = 4L * 1024 * 1024

/** Field names whose values never go in the trail, whatever they are nested inside. */
private val SECRET_KEYS =
    Regex("^(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|auth|credential|cookie|session)$", RegexOption.IGNORE_CASE)

/** The trail says a secret was there and how long it was. It never says what it said. */
fun redact(value: JsonElement, depth: Int = 0): JsonElement {
    if (depth > 6) return JsonPrimitive("…")
    return when (value) {
        is JsonArray -> JsonArray(value.map { redact(it, depth + 1) })
        is JsonObject -> JsonObject(
            value.mapValues { (key, inner) ->
                if (SECRET_KEYS.matches(key)) {
                    val length = (inner as? JsonPrimitive)?.content?.length ?: 0
                    JsonPrimitive("[$length characters withheld]")
                } else {
                    redact(inner, depth + 1)
                }
            },
        )

        else -> value
    }
}

private val KEY_SHAPES = Regex("\\b(sk|pk|ghp|gho|ghs|xoxb|xoxp|AIza)[-_A-Za-z0-9]{12,}")
private val BEARER = Regex("\\b(Bearer|Basic)\\s+[A-Za-z0-9._~+/-]{12,}=*", RegexOption.IGNORE_CASE)
private val FLAGGED_SECRET =
    Regex("(-{1,2}(?:password|token|api[_-]?key|secret)[=\\s]+)(\"[^\"]*\"|'[^']*'|\\S+)", RegexOption.IGNORE_CASE)
private val EXPORTED_SECRET =
    Regex("((?:export\\s+)?[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*\\s*=\\s*)(\"[^\"]*\"|'[^']*'|\\S+)")

/**
 * Masks anything in free text that looks like a key.
 *
 * A command is recorded verbatim because a rule about a shell can only be written against what was
 * actually typed — but `curl -H "Authorization: Bearer sk-…"` is a command *and* a secret, and the
 * trail is a file on disk that outlives the reason it was written.
 */
fun scrub(text: String): String = text
    .replace(KEY_SHAPES, "[key withheld]")
    .replace(BEARER) { m -> m.groupValues[1] + " [withheld]" }
    .replace(FLAGGED_SECRET) { m -> m.groupValues[1] + "[withheld]" }
    .replace(EXPORTED_SECRET) { m -> m.groupValues[1] + "[withheld]" }

class AuditLog(root: File) {
    private val path = File(root, "audit.jsonl")

    /** Writes one row. Never throws: a trail that cannot be written must not stop the decision. */
    fun write(row: AuditRow): AuditRow {
        val clean = row.copy(
            summary = scrub(row.summary).take(400),
            detail = scrub(row.detail).take(2000),
            failure = row.failure?.let { scrub(it).take(400) },
        )
        try {
            roll()
            path.appendText(HaloJson.encodeToString(AuditRow.serializer(), clean) + "\n")
        } catch (_: Exception) {
            // A full or locked disk is not a reason to stop deciding.
        }
        return clean
    }

    /** Keeps one generation, so a roll never silently discards the week somebody is looking for. */
    private fun roll() {
        try {
            if (!path.exists() || path.length() < MAX_BYTES) return
            val old = File(path.parentFile, path.name + ".1")
            if (old.exists()) old.delete()
            path.renameTo(old)
        } catch (_: Exception) {
            // Nothing to roll.
        }
    }

    /**
     * The most recent rows, newest first, optionally narrowed.
     *
     * Reads the file each time rather than holding it: the trail is looked at when something went
     * wrong, which is rare, and keeping megabytes of it resident for that is the wrong trade.
     */
    fun read(
        limit: Int = 200,
        agentId: String? = null,
        outcome: String? = null,
        query: String? = null,
    ): List<AuditRow> {
        val needle = query?.trim()?.lowercase().orEmpty()
        val rows = mutableListOf<AuditRow>()
        for (file in listOf(path, File(path.parentFile, path.name + ".1"))) {
            if (!file.exists()) continue
            val lines = file.readLines()
            var i = lines.size - 1
            while (i >= 0 && rows.size < limit) {
                val line = lines[i].trim()
                i--
                if (line.isEmpty()) continue
                val row = runCatching { HaloJson.decodeFromString(AuditRow.serializer(), line) }.getOrNull() ?: continue
                if (agentId != null && row.agentId != agentId) continue
                if (outcome != null && row.outcome != outcome) continue
                if (needle.isNotEmpty() &&
                    !"${row.summary} ${row.detail} ${row.tool} ${row.agentName}".lowercase().contains(needle)
                ) {
                    continue
                }
                rows.add(row)
            }
            if (rows.size >= limit) break
        }
        return rows
    }

    /** Counts for the last `days`, for the summary strip above the trail. */
    fun summary(days: Int = 7): Triple<Int, Int, Int> {
        val since = System.currentTimeMillis() - days * 86_400_000L
        var allowed = 0
        var refused = 0
        var failed = 0
        for (row in read(limit = 5000)) {
            if (row.at < since) break
            when (row.outcome) {
                "allowed" -> allowed++
                "refused" -> refused++
                "failed" -> failed++
            }
        }
        return Triple(allowed, refused, failed)
    }
}
