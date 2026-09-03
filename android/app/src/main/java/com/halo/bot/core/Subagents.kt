package com.halo.bot.core

import kotlinx.coroutines.Job

enum class SubagentKind(val wire: String) {
    BROWSER("browser"),
    RESEARCH("research"),
    SHELL("shell");

    companion object {
        fun of(wire: String): SubagentKind = entries.firstOrNull { it.wire == wire.lowercase() } ?: RESEARCH
    }
}

class SubagentRun(
    val id: String,
    val kind: SubagentKind,
    val parentAgentId: String,
    val description: String,
    val startedAt: Long = System.currentTimeMillis(),
) {
    @Volatile var status: String = "running"
    @Volatile var report: String = ""
    val steps = mutableListOf<String>()
    /** Notes from the bot that dispatched it, read before the next step. See MessageSubagent. */
    val inbox = mutableListOf<String>()
    var job: Job? = null
}

/** Each kind gets only the tools it needs — a narrow subagent is the one that does not wander. */
val SUBAGENT_TOOLS: Map<SubagentKind, List<String>> = mapOf(
    SubagentKind.BROWSER to listOf("Browser", "Screenshot", "WebFetch", "WebSearch", "Read", "Write"),
    SubagentKind.RESEARCH to listOf("WebSearch", "WebFetch", "Read", "Write"),
    SubagentKind.SHELL to listOf("Shell", "AwaitShell", "Read", "Write", "Edit", "ListFiles"),
)

fun subagentSystemPrompt(kind: SubagentKind, parentName: String): String {
    val shared = listOf(
        "You are a background worker dispatched by $parentName, a bot in Halo Bot.",
        "$parentName can send you a correction while you work; it arrives as a new instruction and replaces",
        "anything it contradicts, without undoing what you have already done.",
        "You cannot talk to the user and cannot ask follow-up questions. Work from the task as written,",
        "make reasonable calls when something is ambiguous, and finish with a plain-text report of what you",
        "found or did — that report is the only thing that comes back. Keep it short and factual, and say",
        "plainly if you could not finish and why.",
    ).joinToString("\n")

    return when (kind) {
        SubagentKind.BROWSER -> """$shared

You drive a real browser with the Browser tool: navigate, read, snapshot, click, type, press, scroll, back, screenshot.
Snapshot the page before you click or type, and act by the refs it gives you: that is what makes the action land on
the control you actually saw rather than on whatever a guessed selector happens to match. If a step needs a human (a
password, 2FA, a captcha, a payment), stop and report exactly which step is blocked — the bot will hand the user the
screen. If the browser tells you a person has the wheel, stop and report that too."""

        SubagentKind.RESEARCH -> """$shared

You search and read the web. Prefer primary sources, cite the urls you used, and never invent a number,
quote, or source. If the answer is not findable, say so instead of guessing."""

        SubagentKind.SHELL -> """$shared

You work in the bot's box with the shell and the filesystem. This is an Android sandbox, so the shell is `sh` with
whatever toybox provides — do not assume GNU tools. Verify what you did — read the file back, check the exit code —
before reporting success."""
    }
}
