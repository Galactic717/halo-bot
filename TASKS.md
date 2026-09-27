# TASKS — shift of 2026-09-27

Finish line: see top of CLAUDE.md. Decision: **keep** runner/gate/audit/fence/box/store; **replace** the
provider layer; **add** a compact profile for small models and a real-job proof; **freeze** Android.

## Blocker: a small model cannot act
- [ ] provider facade: kind detection (llamacpp / ollama / lmstudio / openrouter / openai-compatible)
- [ ] llama.cpp: retry without stream_options on a 400 that names it; probe /props for n_ctx
- [ ] tool calls parsed out of content (JSON block, `<tool_call>`, bare `{"name","arguments"}`) when native fails
- [ ] `toolMode: 'json'` actually works (catalog in prompt, calls parsed from content) — today it sends no tools and parses nothing
- [ ] compact profile: core tools on the wire + FindTool/UseTool for the rest; short contract prompt
- [ ] auto-select compact for local/small models; setting to force full/compact
- [ ] n8n tools off the wire when n8n is disabled

## Hosted is first-class
- [ ] OpenRouter: HTTP-Referer + X-Title, `usage: {include: true}`, cost recorded per call
- [ ] OpenRouter fallback models (`models: [...]`)
- [ ] usage rows carry cost; Settings shows it

## Proof of a real job
- [ ] verify: scripted model does the page-watch job end to end (fetch → diff → changes.md + review.md → SendMessage)
- [ ] verify: content-mode tool calls drive the same job (model with no native tools)
- [ ] scripts/job.mts: same job against a live model; run on llama.cpp Gemma 4 E4B
- [ ] scripts/job.mts on OpenRouter
- [ ] outbound-drafts job: research list → drafts/ in box, nothing sent

## Truth
- [ ] Setup: llama.cpp + OpenRouter first, probe says what it found (n_ctx, tools)
- [ ] README / About: what this build does; Android frozen; no 24/7-with-PC-off claims
- [ ] docs/WORK_2026_09_27.md

## Found on the way
