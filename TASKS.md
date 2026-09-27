# TASKS — shift of 2026-09-27

Finish line: see top of CLAUDE.md. Decision: **keep** runner/gate/audit/fence/box/store; **replace** the
provider layer; **add** a compact profile for small models and a real-job proof; **freeze** Android.

## Blocker: a small model cannot act
- [x] provider facade: kind detection (llamacpp / ollama / lmstudio / openrouter / openai-compatible)
- [x] llama.cpp: retry without stream_options on a 400 that names it; probe /props for n_ctx + tool template
- [x] tool calls parsed out of content (JSON block, `<tool_call>`, `{"name","arguments"}`, Gemma `call:`) when native returns none
- [x] `toolMode: 'content'` actually works (catalog in prompt, history rewritten, calls parsed) — the old `json` did nothing
- [x] a server that rejects `tools` is switched to content on its own, and remembered
- [x] compact profile: 11 core tools + FindTool/UseTool; ~900-token contract prompt; UseTool unwrapped before the gate
- [x] auto-select compact for local models; Settings → Model → Profile / Tool calls
- [x] n8n tools and GenerateImage off the wire when switched off
- [x] a turn that only keeps talking after it delivered is ended

## Hosted is first-class
- [x] OpenRouter: HTTP-Referer + X-OpenRouter-Title (+ X-Title), cost from usage recorded per call
- [x] OpenRouter fallback models (`models: [...]`), served model recorded
- [x] mid-stream error objects surface as errors
- [x] usage rows carry cost; Settings → Usage shows it

## Proof of a real job
- [x] verify: scripted model does the page-watch job end to end (native)
- [x] verify: same job on a server that refuses `tools` (text protocol) + UseTool still gated
- [x] scripts/job.mts + evals/tasks.mts: page-watch, outbound-drafts, poisoned-page + 8 box chores
- [x] live on llama.cpp Gemma 4 E4B (baseline 7/11 before the box fixes)
- [x] live on OpenRouter gemma-4-26b-a4b-it:free — 3/3 web jobs
- [x] re-measure on Gemma after the box fixes: E4B 7/11 → 10/11 (435 s vs 1,394 s)
- [x] live run in the Electron app itself: Watcher on Gemma 4 26B-A4B did page-watch in two turns (docs/screenshots/job-live.png)
- [x] stronger local model: Gemma 4 26B-A4B from E:\llm — 11/11
- [x] Halo's own fallback down the model list on 429/5xx (OpenRouter's did not fire on upstream limits)

## Found on the way (all fixed, each with a test)
- [x] memory extraction after a bot is deleted crashed the process
- [x] box commands lost every double quote (helper appended the command raw to powershell's command line)
- [x] Remove-Item / Move-Item / Rename-Item denied on every file in the box (provider walks the box's parents)
- [x] smart review by a 4B helper raised false ASKs on offline box commands and stalled unattended jobs
- [x] PS 5.1 wrote UTF-16 / ANSI / #TYPE / decimal commas / OEM stdout in the box
- [x] a clock in the system prompt defeated llama.cpp's prefix cache (90 s → 4 s per step)

## Truth
- [x] Setup: llama.cpp + OpenRouter first, probe says window + tool template
- [x] SECURITY.md: parsing calls from text, UseTool is not a boundary, Android frozen
- [x] README: measured table, what this build is, Android frozen, not-done list
- [x] docs/WORK_2026_09_27.md

## Next shift
- [ ] repeat every case ×5 on E4B and 26B; publish variance
- [ ] qwen3.8 repeated a finished job twice on OpenRouter — reproduce and find out why
- [ ] Android: port the provider/compact/box-text work or say it is desktop-only in the app too
- [ ] a real release (signed installer) — none exists
