package com.halo.bot.core

/** Rough but stable: 4 characters per token is close enough for budgeting. */
fun estimateTokens(messages: List<ChatMessage>): Int {
    var chars = 0
    for (message in messages) {
        chars += message.content.length
        for (call in message.toolCalls) chars += call.arguments.length + call.name.length
    }
    return (chars + 3) / 4
}

private const val SUMMARY_MARKER = "[conversation so far]"

fun isSummary(message: ChatMessage): Boolean =
    message.role == "system" && message.content.startsWith(SUMMARY_MARKER)

private val SUMMARY_SYSTEM = listOf(
    "You compact an assistant conversation so it can keep going in a smaller context.",
    "Write a dense summary of what happened, in this order:",
    "1. What the user asked for and any standing preferences or constraints they stated.",
    "2. What was actually done, with concrete results: file paths, urls, names, numbers, commands that worked.",
    "3. What is still open or was promised.",
    "Keep every fact that a future turn would need. Drop pleasantries, retries and dead ends.",
    "No preamble, no headings, under 400 words.",
).joinToString("\n")

data class CompactionResult(val messages: List<ChatMessage>, val compacted: Boolean)

/**
 * Keeps the tail verbatim and folds everything older into one summary message.
 * Tool results are never left orphaned: the tail always starts on a user message.
 */
suspend fun compactHistory(
    provider: ProviderSettings,
    messages: List<ChatMessage>,
    tokenBudget: Int,
    keepLast: Int,
    forced: Boolean = false,
): CompactionResult {
    if (messages.size <= keepLast + 2) return CompactionResult(messages, false)
    // `forced` means the model has already refused this conversation for being too long, so the local
    // token estimate has been proved wrong about it and must not be allowed to veto the fix.
    if (!forced && estimateTokens(messages) <= tokenBudget) return CompactionResult(messages, false)

    var cut = messages.size - keepLast
    while (cut < messages.size && (messages[cut].role == "tool" || messages[cut].role == "assistant")) cut++
    if (cut <= 1) return CompactionResult(messages, false)

    val older = messages.take(cut)
    val tail = messages.drop(cut)
    val previousSummary = older.firstOrNull { isSummary(it) }?.content.orEmpty()

    val transcript = older
        .filterNot { isSummary(it) }
        .joinToString("\n") { m ->
            if (m.role == "tool") {
                "tool(${m.name ?: "result"}): ${m.content.take(400)}"
            } else {
                val calls = m.toolCalls.joinToString(" ") { "${it.name}(${it.arguments.take(200)})" }
                "${m.role}: ${m.content.take(1200)}" + if (calls.isNotEmpty()) " [called $calls]" else ""
            }
        }
        .takeLast(24_000)

    val summary = try {
        complete(
            provider,
            listOf(
                ChatMessage("system", SUMMARY_SYSTEM),
                ChatMessage(
                    "user",
                    listOf(
                        if (previousSummary.isNotEmpty()) "Earlier summary:\n$previousSummary\n" else "",
                        "Conversation to compact:",
                        transcript,
                    ).joinToString("\n"),
                ),
            ),
        )
    } catch (_: Exception) {
        // Without a summary, dropping history would lose facts silently — keep it as is.
        return CompactionResult(messages, false)
    }

    if (summary.isBlank()) return CompactionResult(messages, false)

    return CompactionResult(
        listOf(ChatMessage("system", "$SUMMARY_MARKER\n" + summary.trim())) + tail,
        true,
    )
}
