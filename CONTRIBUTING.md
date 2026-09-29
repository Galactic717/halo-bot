# Contributing

Keep changes focused, and make them true on both platforms.

## Run it

```bash
npm install
npm start          # build and launch
npm run dev        # hot reload
```

You need Node 22.6+, a model server that speaks OpenAI-compatible chat completions with tool calling,
and — only for the box confinement helper — Rust. Without Rust the app still builds and runs; it says
so on its About screen and the box is a folder rather than a boundary.

The phone build needs Android Studio for the SDK and its bundled JDK:

```bash
cd android && ./gradlew :app:installDebug
```

## Checks before you open a PR

| Command | What it is for |
|---|---|
| `npm run typecheck` | `tsc` across the app and the shared runtime. Must be clean. |
| `npm test` | The pure pieces: the floor's patterns, the scheduler's arithmetic, the fence, the store's round trips. Node's own runner, no framework. |
| `npm run verify` | The loop itself, driven end to end against a scripted model on loopback. This is the one that finds things. |
| `cd android && ./gradlew :app:testDebugUnitTest` | The same properties again, on the JVM. |
| `npm run package` | Only when you shipped a change — otherwise `release/*.exe` silently lags the source. |

CI runs the first four on every push: the desktop job on Windows, because the box helper, the
integrity labelling and half the policy floor are Windows-specific and a green Linux run would be
checking a different program.

## The two rules that are not style

**One product, two platforms.** `host/` and `android/app/.../core/` are the same runtime written
twice. A behaviour that holds on Windows and not on the phone is a bug in whichever half is wrong —
add your change to both in the same pass, and add the same test to both suites. The exception is a
difference the platform forced, and those go in [docs/ANDROID.md](docs/ANDROID.md) with the reason,
not into the code as a silent divergence.

**Say why, not what.** The diff already says what changed. A comment here earns its place by naming
the decision and what it is protecting against — usually a failure that actually happened. Look at
`host/policy.ts` or `host/fence.ts` for the register. The odd-looking choices in this codebase are
deliberate, and the comments are how the next person finds that out before "simplifying" one.

## Where things live

```
electron/   main process: window, IPC, the bot's browser, teach recorder, webhook listener
host/       agent runtime: store, provider, tools, policy, memory, skills, subagents,
            runner, scheduler, MCP, fence, compaction, expression, audit, personas, n8n
src/        renderer: React
native/     halo-box — a Rust helper that runs a box command in the bot's own AppContainer
android/    core/ ports host/ · platform/ replaces electron/ · ui/ follows src/
scripts/    build, icons, and verify.mts — the end-to-end harness
docs/       reference teardowns, the Android notes, and a record of every pass over this code
```

## Adding a tool

A tool is an entry in one of the area modules under `host/tools/` (put together as `TOOLS` in `host/tools.ts`) and its twin in `core/Tools.kt`. Three things are
easy to get wrong:

1. **The surface.** `tool.surface` is what sends it through the approval gate. A tool with no surface
   is never gated — that is right for `SendMessage` and wrong for anything that touches the machine.
2. **The fence.** Everything a tool returns is fenced by default. Add it to `INTERNAL` in
   `host/fence.ts` *only* if its output is Halo's own words about Halo's own state — a count, an
   acknowledgement, a row we just wrote. The safe way round is the default one.
3. **The prompt.** If the system prompt or the reference docs name a tool, it has to exist.
   `MessageSubagent` was documented for weeks and did not, and bots followed the documentation.

## Reporting a security issue

Not here — see [SECURITY.md](SECURITY.md).
