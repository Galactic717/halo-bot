import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Long reference material lives on disk in the bot's own box, not in the system prompt.
 *
 * Ported from Grok Bot, which keeps `/home/box/reference/app-ui.md` and `debugging-the-box.md` on the
 * box and points at them from one line of prompt (docs/GROK_BOT_0.24_0.27_TEARDOWN.md §11.3). The
 * reason is ours twice over: a local model with an 8k window cannot afford four thousand tokens of
 * troubleshooting text it needs twice a month, and the bot already has Read.
 */

const TROUBLESHOOTING = `# Fixing Halo when something is wrong

Diagnose before you give up, and keep the user posted with a plain status instead of going quiet.

- **Start with SelfCheck.** It probes the things that break silently — the model server, this box, the
  browser, the plugins, disk space — and prints one PASS/FAIL line each. Run it first and report the
  failing line rather than guessing.

- **The model server.** A turn that dies mid-sentence, an empty reply, or "model server unreachable" is
  the server, not you. SelfCheck says whether it answers and which model is configured. Ollama's default
  context is 4096 tokens, which is below what Halo's prompt plus tool schemas need: the request is
  silently truncated, the model never sees its instructions and answers in plain text that reaches
  nobody. The fix is the user's: start Ollama with OLLAMA_CONTEXT_LENGTH=16384, or pick a model with a
  bigger window in Settings → Model.

- **Shell fails or writes nothing.** Your box is a real folder on the user's machine, labelled Low
  integrity, and commands run under a restricted token. A write outside the box is refused by Windows
  itself, not by a rule you can argue with — that is what ExternalShell is for, and it goes through
  approval. If a command needs a tool that is missing, install it into the box; installs survive
  between turns.

- **The browser.** One browser has one driver: while the user holds the wheel, your actions there are
  refused. That is not a failure to route around — say what you are waiting for and stop. A ref belongs
  only to the snapshot it came from, so after any navigation take a fresh snapshot instead of reusing an
  old ref. Never drive the browser from Shell to get past this.

- **A background command or subagent looks stuck.** A subagent that has taken no action for a while, or
  repeats the same action, is stuck rather than slow. CheckSubagent shows where it got to; MessageSubagent
  redirects it; StopSubagent ends it. Never tell the user "still working" without checking first.

- **A plugin errors.** SelfCheck lists each plugin's state. A plugin that failed to start is usually a
  missing key or a command that is not installed; both are fixed by the user in Plugins → Setup. Do not
  work around a broken plugin by reaching its service through the browser — say what failed.

- **Disk.** SelfCheck reports free space on the box's drive. A box that cannot write looks like a dozen
  unrelated failures.
`;

const APP_UI = `# The Halo Bot interface (real paths — never invent others)

A map of what actually exists, so you can guide the user. Use only what is listed here; if you are not
sure where something lives, say so rather than describing a plausible-looking path.

- **Settings** open from the account row at the bottom of the sidebar. Tabs: General, Model, Activity,
  Usage, About.
- **General** holds execution on the user's computer (Ask every time / Allow / Never), Smart review,
  Dry run, and start-with-Windows.
- **Model** holds the main model, the helper model used for memory extraction and safety review, the
  context budget, vision, and the optional image endpoint.
- **Activity** is the audit trail: every gated action, allowed, refused or failed, with the rule that
  decided it. Rows are written before the action runs.
- **Usage** shows tokens, calls and time, broken down per bot.
- **Per-bot settings** are not in the global Settings: open the details pane from the bot's name in the
  chat header, then the gear. That pane carries the bot's avatar, name, title, description, its own
  execution rule, the folders it may use freely, and its own model.
- **Routines** live in the same details pane, under the live preview of the bot's browser.
- **Plugins** is the row at the bottom of the sidebar: a marketplace of MCP servers, plus "your own
  servers" for any stdio server the user adds by command.
- **Deleting a bot** is a right-click on its row in the sidebar. The same menu has pin, move to section,
  duplicate, export, and hide.
- **Search** is Ctrl+K; a new bot is Ctrl+N.
- Closing the window keeps the bots running in the tray. Quitting from the tray stops everything.
`;

const DOCS: Record<string, string> = {
  'troubleshooting.md': TROUBLESHOOTING,
  'app-ui.md': APP_UI,
};

/** Where the docs sit inside a box, as the bot should be told to Read them. */
export const REFERENCE_DIR = 'reference';

/**
 * Writes the reference docs into a box, skipping files that are already current. Cheap enough to call
 * on every turn, which is what keeps them in step with the running version instead of with whatever
 * version first created the box.
 */
export function ensureReference(boxDir: string): void {
  const dir = join(boxDir, REFERENCE_DIR);
  for (const [name, body] of Object.entries(DOCS)) {
    const path = join(dir, name);
    try {
      if (existsSync(path) && readFileSync(path, 'utf8') === body) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, body, 'utf8');
    } catch {
      // A box we cannot write to is a real problem, but not one to fail a turn over: SelfCheck reports it.
    }
  }
}

/** The names, for the one line of prompt that points at them. */
export function referenceFiles(): string[] {
  return Object.keys(DOCS);
}
