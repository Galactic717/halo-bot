# Halo Bot on Android

The same product, on a phone. Same bots, same memory, same routines, same approval gate, same audit
trail, same file layout on disk — a transcript written by the Windows build and one written here are
the same JSONL.

It is a port, not a wrapper: `android/` is a Kotlin/Compose application, and nothing from `electron/`
or `src/` runs on it. What was worth carrying over is the *design*, and the parts of it that could
not survive the move are listed below rather than quietly dropped.

```
android/app/src/main/java/com/halo/bot/
  Halo.kt            the one long-lived object — what electron/main.ts owns on the desktop
  MainActivity.kt    the only window
  core/              the runtime, ported from host/: Store, Runner, Tools, Policy, Provider,
                     Memory, Skills, Subagents, Scheduler, Mcp, Fence, Compaction, Expression,
                     Audit, Reference, Catalog
  platform/          what Electron used to do: Computer (the WebView), Storage (SAF), Secrets
                     (keystore), Notifications, HaloService, BootReceiver, Webhook, Teach
  ui/                Compose, following src/ screen for screen
```

There is no IPC layer. A phone has one window, so the interface observes `Halo.events` directly and
a hop through a message channel would buy nothing but latency.

## What the platform changed, and why

**The box is the app's sandbox, not the bot's.** On Windows each box is an AppContainer of its own,
built by `native/halo-box`. Here a command is a child of this app: it runs as this app's uid, inside
the app sandbox, and the kernel refuses it every path outside Halo's own storage — but every bot's
shell shares that uid, so one bot can read another's box and Halo's data, and it has the app's
network access. The desktop build is now the stronger of the two; per-bot isolation here (an
`isolatedProcess` service is the candidate) is not built yet.

**`ExternalShell` is gone.** There is no shell outside the app on an unrooted phone, so a tool that
promised one would be a lie. What replaces it is narrower and honest: `ExternalRead`, `ExternalList`,
`CopyToBox`, `CopyFromBox` and `ShareFile`, all against folders the user picked in the system
document picker.

**The user's files are a grant Android holds, not a path Halo polices.** `allowedPaths` on the
desktop is a list Halo keeps and Halo enforces, and a determined model reaching past it is stopped by
a regex. Here the same list is a set of persisted SAF tree uris: a folder the user has not picked is
unreachable whatever a bot tries. Halo's own check still runs on top, so a bot can be given fewer
folders than the app has — it is now the inner of two boundaries rather than the only one.

**The browser is a WebView in the details pane.** Same contract as the desktop's Chromium window:
the bot works from a snapshot and clicks by ref, one browser has one driver, and the user can take
the wheel with one tap. `Screenshot` captures that view rather than the phone's screen — Android does
not hand an app the screen without a MediaProjection consent flow, and the tool's description says so
rather than implying otherwise.

**Plugins are remote servers.** The desktop spawns an npm package per plugin and talks to it over
stdio. Android has no child processes it can install anything into and no node to run them with, so
every plugin here is an MCP server reached over Streamable HTTP — the transport the specification
added for clients that cannot fork. What a bot sees is identical: `mcp__<server>__<tool>`, listed and
called the same way, gated and audited the same way, and the same eight-tool limit before the schemas
stop travelling in the prompt.

The catalogue is therefore shorter and different, and it is honest about the gap: the hosted servers
that sign you in through a browser (Linear, Notion, Jira, Asana, Canva, Sentry, Vercel, PayPal,
Square, Intercom) need an OAuth authorization-code flow that Halo does not do yet. They are named on
the Plugins screen as not-yet-supported rather than listed as installable and then failing on the
first call.

**One cookie jar, not one per bot — and this one is not in Halo's favour.** On Windows each bot's
browser gets its own session partition, so a bot given a narrow job cannot reach a site another bot
signed into, and deleting a bot takes its logins with it. Android's `CookieManager` is a singleton
over the WebView data directory, and the data directory suffix is process-wide and set once, so a
second cookie jar would need a second process. Until that is worth building, every bot on the phone
shares one set of logins: treat a phone bot's browser as the account boundary, not the bot.

**"Close to tray" becomes a foreground service.** Windows keeps the process alive when the window
closes; Android kills it. `HaloService` holds the process up with a quiet notification so routines
still fire and long jobs still finish, and `BootReceiver` brings it back after a restart — the same
promise "start with Windows" makes. It is a setting, not a default the user cannot see: a process
that never sleeps is a real cost on a phone.

**The hardline floor is rewritten for this shell.** The desktop's floor is about drives, shadow
copies and boot configuration, none of which exist here. The Android floor is about the things with
no benign reading on a phone: wiping `/sdcard` or `/data`, `pm clear com.halo.bot` (which would
destroy the record of the actions), `mkfs`, a factory-reset broadcast, `su`, `setenforce 0`,
remounting `/system` writable. Like the desktop's, it is not something the settings can turn off, and
`the hardline floor holds with every switch turned the wrong way` in `app/src/test/` is the test that
says so.

**Secrets use the Android keystore.** Electron's `safeStorage` becomes an AES-GCM key generated
inside the keystore, never exported and unusable outside this app's uid. It is deliberately not bound
to user authentication: a routine that fires at 07:00 has to reach the model server without somebody
unlocking the phone for it.

**Cleartext HTTP is allowed to your own network and to nowhere else.** Android refuses cleartext by
default, which is right for everything on the internet and wrong for the case this app exists to
serve — a model server at `http://192.168.1.10:11434` is never going to have a certificate. The
manifest permits cleartext, because Android's config file can name hosts but not address ranges; the
rule it cannot express is enforced in `Http.PrivateCleartextOnly`, an interceptor on the single
OkHttp client every request goes through. Plain `http` reaches loopback, RFC1918, CGNAT and
link-local addresses and is refused for anything else.

**The webhook listener binds loopback.** Same design as the desktop's, different callers: on Windows
it was Task Scheduler and build scripts, here it is Tasker, MacroDroid, Automate or a Shortcut. The
token is the whole address and an unknown one is a flat 404.

## Running it

Needs Android Studio (for the SDK and its bundled JDK) and a device or emulator on API 26+.

```bash
cd android && ./gradlew :app:installDebug
```

`android/local.properties` points at the SDK (`sdk.dir=...`). On Windows, set `JAVA_HOME` to Android
Studio's bundled JDK if there is no other JDK 17+ on the machine.

Tests are plain JVM tests — the policy floor, the scheduler's arithmetic, the fence, the store's
round trips — and run in a second:

```bash
cd android && ./gradlew :app:testDebugUnitTest
```

## First run

The setup screen asks where the model runs. A phone almost never has Ollama on it, so the order is
the honest one for this platform: the hosted providers first, and "a server on my network" last but
spelled out. For a local server on your own machine, that machine has to accept connections from the
phone — Ollama needs `OLLAMA_HOST=0.0.0.0` — and the same context-window floor applies as on the
desktop: the system prompt plus the tool schemas is several thousand tokens, so
`OLLAMA_CONTEXT_LENGTH=16384` or a model with a bigger window.

On an emulator the host is `10.0.2.2`; if that is firewalled, `adb reverse tcp:11434 tcp:11434` makes
`http://127.0.0.1:11434/v1` work from inside the emulator instead.

## What is the same, deliberately

The two builds are one product, and the phone is not a cut-down version of it. Everything below exists
on both, adapted to the platform rather than dropped:

| | Windows | Android |
|---|---|---|
| Making a bot | templates, voice, per-bot model | the same, as a sheet |
| Transcript | tool calls collapsed to one line, day dividers, per-message actions | the same, actions on long press |
| Sidebar / list | pinned grid, sections, previews, times, unread | the same, sections collapse on tap |
| Bot menu | pin, move to section, duplicate, export, hide, delete | the same, on long press |
| Search | Ctrl+K over messages, bots and routines | the same, as a screen |
| Routines | daily, weekdays, weekly, interval, webhook, daily cap, run history | the same |
| Plugins | command, URL or pasted config | URL or pasted config (a local command has nothing to run in) |
| Automation | n8n: read, write, activate, fire | the same |
| Export / import | a `.halobot.json` file | the same file, through the document picker |

A bot exported on Windows imports here with its voice, memory, skills and routines intact, and back
again, because both builds read and write the same file.

## Not done yet

- OAuth for hosted MCP servers, which is what the ten named above need.
- Sidebar sections can be made and collapsed here, but not reordered by dragging.
- On-device inference. The model is always something Halo talks to over the network.
