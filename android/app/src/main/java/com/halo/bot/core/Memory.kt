package com.halo.bot.core

import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.ln
import kotlin.math.max

enum class MemoryTier(val wire: String) {
    PROFILE("profile"),
    LOG("log"),
    NOTE("note");

    companion object {
        fun of(wire: String): MemoryTier? = entries.firstOrNull { it.wire == wire.lowercase() }
    }
}

data class MemoryFact(val tier: MemoryTier, val text: String, val createdAt: Long)

private const val MAX_FACT_CHARS = 500
private const val PROMPT_RECENT_LIMIT = 30
private const val PROMPT_CHAR_BUDGET = 4000
private const val PROFILE_LIMIT = 100
private const val HALF_LIFE_DAYS = 30.0
private const val DAY_MS = 86_400_000.0

private val IMPORTANCE = mapOf(MemoryTier.PROFILE to 1.5, MemoryTier.LOG to 1.0, MemoryTier.NOTE to 0.5)

/** Small talk is not worth a model call, let alone a memory. */
private val TRIVIAL = setOf(
    "hi", "hey", "hello", "yo", "sup", "thanks", "thank you", "ty", "thx", "ok", "okay", "k", "kk",
    "cool", "nice", "great", "awesome", "perfect", "yes", "yep", "yeah", "no", "nope", "sure",
    "got it", "gotcha", "lol", "haha", "np", "done", "good", "bye", "ага", "ок", "добре", "дякую",
)

fun isMemorable(userMessage: String): Boolean {
    val text = userMessage.trim()
    if (text.isEmpty()) return false
    if (text.length > 40 || text.contains("?")) return true
    val normalized = text.lowercase().trimEnd(' ', '!', '.', '…', ',', '~', ')', ']').replace(Regex("\\s+"), " ")
    return normalized !in TRIVIAL
}

private val DAY_FORMAT = SimpleDateFormat("yyyy-MM-dd", Locale.US)

class MemoryStore(store: Store, agentId: String) {
    private val dir = File(store.agentDir(agentId), "memory")

    init {
        File(dir, "log").mkdirs()
    }

    private fun profilePath() = File(dir, "profile.md")
    private fun logPath() = File(dir, "log/facts.jsonl")

    fun list(): List<MemoryFact> {
        val out = mutableListOf<MemoryFact>()
        val profile = profilePath()
        if (profile.exists()) {
            for (line in profile.readLines()) {
                val m = Regex("^- \\((\\d{4}-\\d{2}-\\d{2})\\) (.+)$").find(line.trim()) ?: continue
                val at = runCatching { DAY_FORMAT.parse(m.groupValues[1])?.time ?: 0L }.getOrDefault(0L)
                out.add(MemoryFact(MemoryTier.PROFILE, m.groupValues[2], at))
            }
        }
        val log = logPath()
        if (log.exists()) {
            for (line in log.readLines()) {
                if (line.isBlank()) continue
                val obj = runCatching { HaloJson.parseToJsonElement(line) as kotlinx.serialization.json.JsonObject }
                    .getOrNull() ?: continue
                val text = (obj["text"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: continue
                val tier = MemoryTier.of(
                    (obj["tier"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: "log",
                ) ?: MemoryTier.LOG
                val at = (obj["createdAt"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull() ?: 0L
                out.add(MemoryFact(tier, text, at))
            }
        }
        return out
    }

    fun add(tier: MemoryTier, text: String, now: Long = System.currentTimeMillis()) {
        val clean = text.trim().take(MAX_FACT_CHARS)
        if (clean.isEmpty()) return
        val existing = list()
        if (existing.any { it.text.equals(clean, ignoreCase = true) }) return
        if (tier == MemoryTier.PROFILE) {
            val kept = existing.filter { it.tier == MemoryTier.PROFILE }.takeLast(PROFILE_LIMIT - 1)
            val lines = (kept + MemoryFact(tier, clean, now)).joinToString("\n") { factFileLine(it) }
            profilePath().writeText("# Profile\n\n$lines\n")
            return
        }
        logPath().appendText(
            kotlinx.serialization.json.buildJsonObject {
                put("tier", kotlinx.serialization.json.JsonPrimitive(tier.wire))
                put("text", kotlinx.serialization.json.JsonPrimitive(clean))
                put("createdAt", kotlinx.serialization.json.JsonPrimitive(now))
            }.toString() + "\n",
        )
    }

    fun forget(text: String) {
        val target = text.trim().lowercase()
        val kept = list().filterNot { it.text.lowercase() == target }
        val profile = kept.filter { it.tier == MemoryTier.PROFILE }
        profilePath().writeText("# Profile\n\n" + profile.joinToString("\n") { factFileLine(it) } + "\n")
        logPath().writeText(
            kept.filter { it.tier != MemoryTier.PROFILE }.joinToString("\n") { fact ->
                kotlinx.serialization.json.buildJsonObject {
                    put("tier", kotlinx.serialization.json.JsonPrimitive(fact.tier.wire))
                    put("text", kotlinx.serialization.json.JsonPrimitive(fact.text))
                    put("createdAt", kotlinx.serialization.json.JsonPrimitive(fact.createdAt))
                }.toString()
            } + "\n",
        )
    }

    /**
     * Importance decayed by a 30-day half-life: log2(importance) - age/halfLife.
     * Written as a subtraction so the age term cannot dwarf importance the way a raw timestamp does.
     */
    private fun rank(fact: MemoryFact, now: Long): Double {
        val ageDays = max(0.0, (now - fact.createdAt).toDouble()) / DAY_MS
        return ln(IMPORTANCE[fact.tier] ?: 1.0) / ln(2.0) - ageDays / HALF_LIFE_DAYS
    }

    /** The whole memory as editable text — one `tier: fact` per line. What Settings shows. */
    fun exportText(): String {
        val lines = list().map { "${it.tier.wire}: ${it.text}" }
        return if (lines.isEmpty()) "" else lines.joinToString("\n") + "\n"
    }

    /** Replaces the whole memory from the text form. Unknown lines are kept as log facts. */
    fun importText(text: String) {
        profilePath().writeText("# Profile\n\n")
        logPath().writeText("")
        for (raw in text.split("\n")) {
            val line = raw.replace(Regex("^\\s*(?:[-*•]|\\d+[.)])\\s+"), "").trim()
            if (line.isEmpty() || line.startsWith("#")) continue
            val m = Regex("^(profile|log|note)\\s*:\\s*(.+)$", RegexOption.IGNORE_CASE).find(line)
            if (m != null) {
                add(MemoryTier.of(m.groupValues[1]) ?: MemoryTier.LOG, m.groupValues[2].trim())
            } else {
                add(MemoryTier.LOG, line.replace(Regex("^\\(\\d{4}-\\d{2}-\\d{2}\\)\\s*"), ""))
            }
        }
    }

    fun render(): String {
        val all = list()
        if (all.isEmpty()) return ""
        val now = System.currentTimeMillis()
        val profile = all.filter { it.tier == MemoryTier.PROFILE }
        val rest = all.filter { it.tier != MemoryTier.PROFILE }.sortedByDescending { rank(it, now) }

        val lines = mutableListOf(
            "Memory: durable facts you have learned about the user and their world.",
            "They live in ${dir.absolutePath} — profile.md and log/. Read or grep them when you need something older than this list.",
        )
        if (profile.isNotEmpty()) {
            lines.add("")
            lines.add("About the user:")
            profile.forEach { lines.add(factLine(it)) }
        }
        if (rest.isNotEmpty()) {
            lines.add("")
            lines.add("Recently:")
            var budget = PROMPT_CHAR_BUDGET
            var shown = 0
            for (fact in rest.take(PROMPT_RECENT_LIMIT)) {
                val line = factLine(fact)
                if (shown > 0 && line.length > budget) break
                lines.add(line)
                budget -= line.length
                shown++
            }
            val omitted = rest.size - shown
            if (omitted > 0) lines.add("($omitted more on disk — grep log/ for them.)")
        }
        return lines.joinToString("\n")
    }
}

private fun factFileLine(fact: MemoryFact) = "- (${DAY_FORMAT.format(Date(fact.createdAt))}) ${fact.text}"
private fun factLine(fact: MemoryFact) = "- (learned ${DAY_FORMAT.format(Date(fact.createdAt))}) ${fact.text}"

private val EXTRACTION_SYSTEM = listOf(
    "You maintain the long-term memory of a personal assistant. Read the latest exchange and decide what, if anything,",
    "is worth remembering for future, unrelated conversations.",
    "",
    "Tag each fact you keep with a category:",
    "- \"profile\": enduring facts about who the user is and how to work with them — name, role, location, languages,",
    "  lasting preferences and constraints, important people. Kept indefinitely.",
    "- \"log\": substantive history — ongoing projects, decisions, commitments, time-bound details.",
    "- \"note\": minor details that might help someday but are not worth keeping in mind every turn.",
    "",
    "Do NOT record one-off request mechanics, what the assistant did this turn, general knowledge, or anything already",
    "in the existing memory list.",
    "",
    "If the exchange contradicts an existing fact, output \"remove: <the exact existing fact text>\" and then add the",
    "corrected fact. Only remove facts that appear verbatim in the existing list.",
    "",
    "Write one fact per line: \"profile: <fact>\", \"log: <fact>\", \"note: <fact>\", or \"remove: <existing fact>\".",
    "Output exactly NONE (and nothing else) when there is nothing to add or remove.",
).joinToString("\n")

private val LINE = Regex("^(profile|log|note|remove)\\s*:\\s*(.+)$", RegexOption.IGNORE_CASE)

/** Runs after a turn, on a cheap non-streaming call. Failures are silent by design. */
suspend fun extractMemories(
    provider: ProviderSettings,
    memory: MemoryStore,
    userMessage: String,
    agentMessage: String,
): Int {
    if (!isMemorable(userMessage)) return 0
    val existing = memory.list().map { it.text }
    val messages = listOf(
        ChatMessage("system", EXTRACTION_SYSTEM),
        ChatMessage(
            "user",
            listOf(
                "Existing memory:",
                if (existing.isEmpty()) "(empty)" else existing.joinToString("\n") { "- $it" },
                "",
                "Latest exchange:",
                "User: " + userMessage.trim().ifBlank { "(no message)" },
                "Assistant: " + agentMessage.trim().ifBlank { "(no message)" },
            ).joinToString("\n"),
        ),
    )

    val raw = try {
        complete(provider, messages)
    } catch (_: Exception) {
        return 0
    }
    val trimmed = raw.trim()
    if (trimmed.isEmpty() || trimmed.uppercase().startsWith("NONE")) return 0

    var changes = 0
    for (rawLine in trimmed.split("\n")) {
        val line = rawLine.replace(Regex("^\\s*(?:[-*•]|\\d+[.)])\\s+"), "").trim()
        val m = LINE.find(line) ?: continue
        val kind = m.groupValues[1].lowercase()
        val text = m.groupValues[2].trim()
        if (text.isEmpty()) continue
        if (kind == "remove") memory.forget(text) else memory.add(MemoryTier.of(kind) ?: MemoryTier.LOG, text)
        changes++
    }
    return changes
}
