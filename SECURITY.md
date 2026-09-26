# Security

Halo Bot runs an autonomous model on a personal machine and hands it a shell, a browser and the
user's files. Most of this repository is the part that decides what it may do with them, so a hole in
that part is the interesting kind of bug here.

## Reporting a vulnerability

Open a **private security advisory** on this repository
([Security → Report a vulnerability](https://github.com/Galactic717/halo-bot/security/advisories/new)).
Please do not open a public issue for an unfixed hole.

Useful things to include:

- What an attacker gets. "A page can make a bot delete a file without an approval card" is a report;
  "prompt injection is possible" is a topic.
- Whether it needs the user to have configured something unusual, or works on a default install.
- The smallest reproduction you have — a page, a file, a tool result, a routine prompt.

There is no bounty. Credit in the fix's commit and the release notes if you want it.

## What is in scope

The boundaries this project claims, which are the ones worth attacking:

| Claim | Where it lives |
|---|---|
| The hardline floor refuses whatever the settings say | `host/policy.ts` `HARDLINE`, `core/Policy.kt` |
| A bot's shell cannot write outside its box, or read or write another bot's box (Windows) | `native/halo-box`, `host/box.ts`; tests in `host/box.test.ts` |
| A bot's shell cannot read the user's files, and has no network unless that bot is given it (Windows) | the same AppContainer; `host/box.test.ts` |
| A box command that cannot be confined is refused, never run with the user's rights | `host/tools.ts` `runShell`, `host/box.ts` `confinementProblem` |
| Anything from outside is fenced and cannot forge the marker | `host/fence.ts`, `core/Fence.kt` |
| Every gated action is recorded before it runs | `host/audit.ts`, `host/runner.ts` `gate` |
| A row changed, removed or inserted in the trail afterwards is detected | `host/audit.ts` `verify` |
| A `ref` resolves against the page Halo actually looked at | `electron/computer.ts`, `platform/Computer.kt` |
| A bot cannot reach another bot's browser session | `electron/computer.ts` `partitionFor` |
| Deny beats allow, and a broken rule refuses rather than opens | `host/policy.ts`, `host/expression.ts` |
| Secrets are sealed before they reach disk and masked before they reach the trail | `host/store.ts`, `host/audit.ts` |
| A shell sees an allow-list, not this process's environment | `host/tools.ts` `shellEnvironment` |

A bypass of any row above is a vulnerability. `npm run verify` asserts several of them; a report that
adds a failing check to that harness is the most useful shape a report can take.

## What is not in scope

- **The model doing something unwise inside its own box.** That is what the box is for. A bot that
  fills its own workspace with nonsense is a bad prompt, not a security bug.
- **`ExternalShell` doing what it was approved to do.** The gate asks; a user who says yes has said
  yes. The bug would be reaching that surface *without* the card, or the card describing something
  other than what runs.
- **Third-party MCP servers.** A plugin is code the user chose and installed, and it is given the
  environment on purpose ([`host/mcp.ts`](host/mcp.ts) says why). Report those to their own projects.
- **The model provider.** Halo sends the prompt you configured to the endpoint you configured.
- **Misconfiguration.** A model server exposed to the internet, or a bot granted `C:\` and set to
  `Allow`, is a choice the app makes visible and does not prevent.

## Supported versions

The `master` branch. This is alpha software; there are no maintained release branches yet.

## Notes for anybody auditing it

- `npm run verify` drives the real runtime against a scripted model and asserts the floor holds with
  every switch in the app turned the wrong way. Start there; it is the shortest path to the parts
  that matter.
- The approval gate is one function, `Runner.gate`. Every path to a tool goes through it, including
  background workers. If you find a second path, that is a finding.
- The Windows box is an AppContainer per bot plus a job object and a private desktop, built by
  `native/halo-box`. Windows checks every access the shell makes twice — as the user and as that
  bot's container — and the container is granted its own box and nothing of the user's. Each claim
  in the table is a test in `host/box.test.ts` that runs the real helper against the kernel, and
  `verifyConfinement` re-asks at startup rather than trusting the mechanism.

## Known limits

Stated so nobody has to discover them:

- **The browser is not in the box.** A bot's browser can reach any site; it is gated by the approval
  rules and Smart review, and its cookie jar is per bot, but a page it is allowed to open can carry
  what the bot read. The shell being offline closes one exfiltration path, not all of them.
- **Smart review is a model.** It sees rule-passing actions and can refuse them, but it is
  probabilistic and can itself be argued with. It is a layer, not the boundary.
- **The hardline floor is a pattern list.** It stops the obvious disasters with every switch turned
  the wrong way; it is trivially bypassed by rewriting a command, which is why the box, not the list,
  is the boundary for a bot's own shell.
- **`ExternalShell` runs with the user's rights** once they approve it. That is its job.
- **The trail is tamper-evident, not tamper-proof.** A process with the user's rights can rewrite
  it and recompute every hash; a bot's container cannot reach it at all.
- **Android's box is the app's sandbox, shared by every bot.** It keeps bots out of the rest of the
  phone, but one bot's shell can read another bot's box and Halo's own data, and it has the app's
  network access. Per-bot isolation there is not built yet.
