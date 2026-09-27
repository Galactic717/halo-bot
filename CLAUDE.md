# Halo Bot — working notes for an agent on shift

## Finish line (the product contract — do not trade any of it away)

1. A named bot is a durable teammate: own memory, workspace (box), browser session, permissions,
   optional schedule, optional model.
2. On this Windows PC, with llama.cpp at localhost:8080 (Gemma 4 E4B) **and** with an OpenRouter key,
   a bot takes a real job and finishes it (watch a page → extract what changed → write an artifact in
   its box → leave a review list; or research a list → draft messages that are never sent). Proven by
   an end-to-end run against a scripted model **and** a live turn where tools fire.
3. A ~4B local model can ACT: compact tool catalog, short contract prompt, and tool calls parsed out of
   content when native tool calling fails.
4. Hosted APIs are first-class: OpenRouter headers (HTTP-Referer, X-Title), fallbacks, usage + cost
   recorded. llama.cpp quirks (stream_options, missing tool_calls) handled, not assumed away.
5. Irreversible actions stop for a human; the audit row exists before the action; bots stay out of each
   other's logins; anything from web/files/other bots arrives fenced as data.
6. Builds and runs on Windows. `npm run typecheck`, `npm test`, `npm run verify` green.
7. README / Setup / About say what this build actually does.

## Layout

- `host/` — runtime, no Electron imports. `runner.ts` is the loop + the one gate. `provider.ts` speaks to
  models. `tools.ts` is the tool table. `prompt.ts` builds the system prompt. `policy.ts` decides,
  `audit.ts` records (hash-chained), `fence.ts` marks untrusted text, `box.ts` + `native/halo-box`
  confine a bot's shell in its own AppContainer.
- `electron/` — main process, per-bot browser partition (`computer.ts`), IPC.
- `src/` — React renderer.
- `android/` — Kotlin port. **Frozen**: it does not have the small-model path or the provider work of
  2026-09-27. Do not claim parity.
- `scripts/verify.mts` — scripted-model end-to-end checks of the gate, fence, floor and a real job.
- `scripts/job.mts` — the same real job against a live model (llama.cpp or OpenRouter).

## Rules

- npm is not on the Bash tool PATH here — run npm through PowerShell.
- Commits are authored by the owner only: no Co-Authored-By / "Generated with" lines.
- Never print or commit keys. OpenRouter key: `D:\openrouterAPI.md` → env `OPENROUTER_API_KEY` at run time.
- llama.cpp: `D:\llm\llama.cpp\llama-server.exe -m D:\llm\gemma-4-E4B-it-Q4_0.gguf -c 16384 -ngl 99 --jinja --port 8080`.
- Track work in `TASKS.md`. End-of-shift log goes in `docs/WORK_<date>.md`, brutal register.
