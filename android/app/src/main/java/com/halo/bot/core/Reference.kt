package com.halo.bot.core

import java.io.File

/**
 * Long reference material lives on disk in the bot's own box, not in the system prompt.
 *
 * Ported from Grok Bot, which keeps `/home/box/reference/app-ui.md` and `debugging-the-box.md` on the
 * box and points at them from one line of prompt (docs/GROK_BOT_0.24_0.27_TEARDOWN.md §11.3). The
 * reason is ours twice over on a phone: a small model cannot afford four thousand tokens of
 * troubleshooting text it needs twice a month, and the bot already has Read.
 */

private val TROUBLESHOOTING = """
# Fixing Halo when something is wrong

Diagnose before you give up, and keep the user posted with a plain status instead of going quiet.

- **Start with SelfCheck.** It probes the things that break silently — the model server, this box, the
  browser, the plugins, storage space — and prints one PASS/FAIL line each. Run it first and report the
  failing line rather than guessing.

- **The model server.** A turn that dies mid-sentence, an empty reply, or "model server unreachable" is
  the server, not you. SelfCheck says whether it answers and which model is configured. A phone is
  usually talking to that server over the network, so a flaky answer can be the network rather than the
  model: SelfCheck distinguishes them. If the server is a desktop Ollama on the same wifi, its default
  context is 4096 tokens, which is below what Halo's prompt plus tool schemas need — the request is
  silently truncated, the model never sees its instructions, and answers in plain text that reaches
  nobody. The fix is the user's: start Ollama with OLLAMA_CONTEXT_LENGTH=16384, or pick a model with a
  bigger window in Settings → Model.

- **Shell fails or writes nothing.** Your box is a folder inside Halo's own private storage, and a
  command you run is this app and nothing more. Android refuses it every path outside that storage —
  that is the sandbox, not a rule you can argue with. Reaching the user's own files is what ExternalRead
  and CopyToBox are for, and they go through approval and only reach folders the user has granted.
  Do not try to widen this with `su`, and do not expect tools that are not installed: this is a phone,
  so `sh`, `toybox` and whatever the user has put in the box are what exists.

- **The browser.** One browser has one driver: while the user holds the wheel, your actions there are
  refused. That is not a failure to route around — say what you are waiting for and stop. A ref belongs
  only to the snapshot it came from, so after any navigation take a fresh snapshot instead of reusing an
  old ref. Never drive the browser from Shell, and never use `input tap` to do what a refused click
  would have done.

- **A background command or subagent looks stuck.** A subagent that has taken no action for a while, or
  repeats the same action, is stuck rather than slow. CheckSubagent shows where it got to; MessageSubagent
  redirects it without losing what it has; StopSubagent
  ends it. Never tell the user "still working" without checking first.

- **A plugin errors.** SelfCheck lists each plugin's state. Plugins on Android are remote MCP servers
  reached over HTTP, so a failure is usually a missing key, an expired one, or no network. All three are
  fixed by the user in Plugins → Setup. Do not work around a broken plugin by reaching its service
  through the browser — say what failed.

- **Storage.** SelfCheck reports free space. A box that cannot write looks like a dozen unrelated
  failures.

- **The app was in the background.** Android may stop a long turn when Halo is not on screen and the
  background service is off. If a turn ended abruptly with no error, say so and offer to run it again
  with the screen on.
""".trimIndent()

private val APP_UI = """
# The Halo Bot interface (real paths — never invent others)

A map of what actually exists, so you can guide the user. Use only what is listed here; if you are not
sure where something lives, say so rather than describing a plausible-looking path.

- **Settings** open from the account row at the bottom of the bot list. Tabs: General, Model, Activity,
  Usage, About.
- **General** holds work on your phone's storage (Ask every time / Allow / Never), Smart review, Dry run,
  and whether bots keep working in the background.
- **Model** holds the main model, the helper model used for memory extraction and safety review, the
  context budget, vision, and the optional image endpoint.
- **Activity** is the audit trail: every gated action, allowed, refused or failed, with the rule that
  decided it. Rows are written before the action runs.
- **Usage** shows tokens, calls and time, broken down per bot.
- **Per-bot settings** are not in the global Settings: tap the bot's name in the chat header to open its
  details sheet, then Settings. That sheet carries the bot's avatar, name, title, description, its own
  execution rule, the folders it may use freely, and its own model.
- **Routines** live in the same details sheet, under the live preview of the bot's browser.
- **Plugins** is a row at the bottom of the bot list: a marketplace of remote MCP servers, plus "your own
  servers" for any HTTP MCP endpoint the user adds by URL.
- **Deleting a bot** is a long-press on its row in the list. The same menu has pin, duplicate and hide.
- **Search** is the magnifier in the bot list.
- The bot's browser is the Computer tab in the details sheet; "Take over" hands the user the wheel.
- Closing Halo keeps the bots working while the background service is on; turning that off in Settings →
  General stops everything when the app leaves the screen.
""".trimIndent()

private val DOCS = linkedMapOf(
    "troubleshooting.md" to TROUBLESHOOTING,
    "app-ui.md" to APP_UI,
)

/** Where the docs sit inside a box, as the bot should be told to Read them. */
const val REFERENCE_DIR = "reference"

/**
 * Writes the reference docs into a box, skipping files that are already current. Cheap enough to call
 * on every turn, which is what keeps them in step with the running version instead of with whatever
 * version first created the box.
 */
fun ensureReference(boxDir: File) {
    val dir = File(boxDir, REFERENCE_DIR)
    for ((name, body) in DOCS) {
        val path = File(dir, name)
        try {
            if (path.exists() && path.readText() == body) continue
            dir.mkdirs()
            path.writeText(body)
        } catch (_: Exception) {
            // A box we cannot write to is a real problem, but not one to fail a turn over: SelfCheck
            // reports it.
        }
    }
}

/** The names, for the one line of prompt that points at them. */
fun referenceFiles(): List<String> = DOCS.keys.toList()

/** Which of these names is @-mentioned in the text. Case-insensitive, whole word. */
fun mentionedNames(names: List<String>, text: String): List<String> = names.filter { name ->
    val escaped = Regex.escape(name)
    Regex("(^|[^\\w@])@$escaped\\b", RegexOption.IGNORE_CASE).containsMatchIn(text)
}
