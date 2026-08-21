# Halo Bot

AI teammates you can give real work to — running entirely on your own Windows machine.

A local clone of the Grok Bot model of working: named bots with persistent memory, their own workspace and browser,
routines on a schedule, skills they learn by watching you, and an approval gate before anything touches your machine.
The teardown that this is built from lives in [docs/GROK_BOT_TEARDOWN.md](docs/GROK_BOT_TEARDOWN.md) and
[docs/GROK_BOT_INTERNALS.md](docs/GROK_BOT_INTERNALS.md).

## Install

Build the installer yourself:

```bash
npm install
npm run package
```

`release/Halo Bot Setup 0.1.0.exe` installs the app, adds a Start-menu and desktop shortcut, and can start with
Windows (Settings → Windows → Start with Windows).

Or run it from source:

```bash
npm start
```

Dev mode with hot reload:

```bash
npm run dev
```

## First run

The setup screen looks for a model server on this machine (Ollama, LM Studio, llama.cpp) and ranks the models it
finds by whether they support tool calling and whether they fit in your memory. You can also paste a key for x.ai,
OpenRouter, OpenAI or DeepSeek. Anything OpenAI-compatible works; the model needs tool calling, and vision if you
want your bots to look at screenshots.

| Setting | Where | What it does |
|---|---|---|
| Model | Settings → Model | The model every bot uses by default |
| Helper model | Settings → Model | Cheap model for memory extraction, safety review and summarising |
| Per-bot model | Bot → Settings | Overrides the default for one bot |
| Context budget | Settings → Model | When a chat passes this, older turns fold into a summary |
| Vision | Settings → Model | Sends screenshots and attached images into the prompt |
| Image endpoint | Settings → Model | Optional, enables `GenerateImage` |

## What a bot can do

- **Its own box** — `%APPDATA%/Halo Bot/agents/<id>/box`. `Shell`, `Read`, `Write`, `Edit`, `ListFiles` run here freely.
  Slow commands go to the background and wake the bot when they finish.
  The box is a working folder, not a sandbox: `Shell` is real PowerShell with your rights. `Read`/`Write`/`Edit`
  are confined to the box, and a `Shell` command that names a path outside it raises the approval bar — but a
  determined model could still reach past that. Give a bot you do not trust `Never` under its own permissions.
- **Its own browser** — a real Chromium screen you can watch live in the details pane and take over with one click.
  Logins persist, so signing in once is enough.
- **Your computer** — `ExternalShell`, `ExternalRead`, `CopyToBox`, `CopyFromBox`, each behind the approval gate.
- **The web** — `WebSearch`, `WebFetch`.
- **Background workers** — `Task` hands a tightly-scoped job to a browser, research or shell worker that reports back.
- **Teammates** — `CreateAgent`, `SendToAgent`, channels with `@mentions`; bots hand work to each other and post into rooms.
- **Memory** — durable facts in three tiers (profile / log / note), extracted automatically after each exchange and
  loaded into every turn.
- **Skills** — reusable recipes, either written with `SaveSkill` or learned by watching you (see below).
- **Routines** — interval, daily, weekdays or weekly triggers, several per routine, with a test run and run history.
- **Plugins** — a marketplace of real MCP servers. Installed tools appear to every bot as `mcp__<server>__<tool>`.

## Teach a task

Open a bot's computer, press **Teach a task**, do the thing once, then press stop. Halo records the real clicks,
typing and navigations, hands the trace to the bot, and the bot saves it as a skill with the selectors intact.
Passwords are never recorded — a password field is captured as `<secret>`.

## Per-bot permissions

A bot's Settings pane carries its own rules, so a research bot and a file bot do not need the same trust:

- **On your computer** — `Use global / Ask every time / Allow / Never` for that bot alone.
- **Folders it may use freely** — pick real folders; anything inside them runs without an approval prompt,
  everything outside still asks.
- **Model** — a heavy bot can run a bigger model than a watcher.

## Staying in control

- Anything that touches your machine or the outside world raises an approval bar above the composer:
  **Always allow / Allow once / Never**. "Always" and "Never" are remembered as rules.
- **Smart review** (Settings → General) additionally asks the model to judge anything the rules would wave through.
- Rules are plain language: "when a bot wants to *read files from my Downloads folder* → allow automatically".
- Closing the window keeps the bots running in the tray; quit from the tray to stop everything.

## Plugins

**Plugins** at the bottom of the sidebar opens the marketplace: a shelf per category, a Featured row,
fuzzy search, and a detail page per plugin showing what it runs and which tools it exposes.

Everything on the shelves is a real, published MCP server — an npm package that exists on the registry,
or a documented hosted endpoint bridged in by `mcp-remote`, where signing in happens in a browser window
the bridge opens itself. A plugin that needs a key or a folder asks for it once in **Plugin Setup**;
keys are encrypted with the OS keychain, paths are not.

**Your own servers** under `N installed` takes any MCP server that speaks stdio — give it a name, a
command and arguments, and its tools reach every bot like any other plugin.

The catalogue lives in `host/catalog.ts`. Brand marks are baked from simple-icons into
`src/components/brandIcons.ts` by `npm run icons:brands`; a plugin with no mark gets a monogram.

## Keyboard

| Shortcut | Action |
|---|---|
| `Ctrl+K` | Search every conversation |
| `Ctrl+N` | New bot |
| `Enter` / `Shift+Enter` | Send / newline |
| Right-click a bot | Pin, move to section, duplicate, export, hide, delete |

## Layout

```
electron/   main process: window, IPC, the bot's browser, teach recorder
host/       agent runtime: store, provider, tools, policy, memory, skills, subagents, runner, scheduler, MCP
src/        renderer: React UI
docs/       teardown and internals of the original
```

## Under the hood

- Turns run as a tool loop against an OpenAI-compatible endpoint, retried on transient failures and cut off if the
  server goes quiet.
- Long chats fold their older turns into a summary once they pass the context budget, so a bot can run for weeks.
- Memory extraction, safety review and summarising all use the helper model, keeping the main model free for work.
- Everything is files: `%APPDATA%/Halo Bot` holds `settings.json`, `channels.json`, `routines.json`, `usage.jsonl`,
  and one folder per bot with its transcript, model history, memory, skills and box.

Tests: `npm test` (node's runner, no framework). Needs Node 22.6+, which runs TypeScript directly.

Secrets: the API key and any plugin credentials are encrypted with the OS keychain (`safeStorage`) before
`settings.json` is written. Everything else in there stays readable.
