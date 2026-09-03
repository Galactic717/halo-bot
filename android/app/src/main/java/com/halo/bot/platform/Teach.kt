package com.halo.bot.platform

import com.halo.bot.core.HaloJson
import kotlinx.serialization.Serializable

@Serializable
data class TeachEvent(
    val kind: String,
    val at: Long = 0,
    val url: String = "",
    val selector: String? = null,
    val text: String? = null,
    val value: String? = null,
    val key: String? = null,
)

/** Parses one step the recorder pushed through the bridge; null for anything malformed. */
fun parseRecordedLine(json: String): TeachEvent? =
    runCatching { HaloJson.decodeFromString(TeachEvent.serializer(), json) }.getOrNull()

/** Collapses a raw trace into the numbered steps a skill is written from. */
fun describeTrace(events: List<TeachEvent>): String {
    val lines = mutableListOf<String>()
    var lastUrl = ""
    var step = 1
    for (event in events) {
        if (event.url.isNotEmpty() && event.url != lastUrl) {
            lines.add("${step++}. Open ${event.url}")
            lastUrl = event.url
        }
        when (event.kind) {
            "click" -> {
                val what = event.text?.takeIf { it.isNotBlank() }?.let { "\"$it\"" } ?: event.selector.orEmpty()
                val extra = if (!event.selector.isNullOrBlank() && !event.text.isNullOrBlank()) {
                    " (selector: ${event.selector})"
                } else {
                    ""
                }
                lines.add("${step++}. Click $what$extra")
            }

            "input" -> {
                val value = if (event.value == "<secret>") {
                    "a secret the user enters themselves"
                } else {
                    "\"${event.value.orEmpty()}\""
                }
                lines.add("${step++}. Type $value into ${event.selector.orEmpty()}")
            }

            "key" -> lines.add("${step++}. Press ${event.key.orEmpty()} in ${event.selector.orEmpty()}")
        }
    }
    return lines.joinToString("\n")
}

/**
 * What the bot is told after a demonstration.
 *
 * The desktop build's wording, kept verbatim because it is doing real work: it asks for the *shape*
 * of the task rather than a replay, names the inputs that would differ next time, and makes the bot
 * write down what the skill will not do on its own.
 */
fun teachPrompt(trace: String): String = """
The user just demonstrated a task in your browser. Here is the trace of what they actually did:

$trace

Save this as a skill with SaveSkill. Write it as the shape of the task, not as a replay of this one run:
anything that would differ next time — a search term, a date, a name, an amount — becomes a named input
written {like_this}, with the value they used kept as the example. Keep the selectors exactly as recorded;
they are what makes the steps land. A field recorded as <secret> is a password: never store it, and write
the step as "the user signs in themselves".

End the skill with one line naming what it will not do on its own: pay, buy, or send on the user's behalf.

Then tell the user in one short message what you saved and offer a dry run so they can watch it once
before it matters.
""".trimIndent()
