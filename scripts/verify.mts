/**
 * The whole runtime, driven headlessly against a scripted model.
 *
 *   node scripts/verify.mts
 *
 * `npm test` checks the pure pieces — the floor's patterns, the scheduler's arithmetic, the fence's
 * string handling. None of that proves the *paths* are wired together: that a tool result reaches
 * the model fenced, that the gate is on every route to a tool rather than most of them, that the
 * audit row is written before the action and not after, that a bot's own model reaches its
 * background workers. Those are properties of the loop, and the loop needs a model to run.
 *
 * So there is a model here: an OpenAI-compatible server on loopback that plays a scripted sequence
 * of tool calls. It answers deterministically, which is the point — asking a real model to attempt a
 * wipe tests whether that model is willing, and a well-behaved one refuses on its own and never
 * reaches the floor at all. What has to hold is Halo's behaviour when the model is *not* well
 * behaved, and a script is the only way to ask that question the same way twice.
 *
 * Everything runs in a temp directory and nothing touches the real %APPDATA%/Halo Bot.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../host/store.ts';
import { Runner } from '../host/runner.ts';
import { AuditLog } from '../host/audit.ts';
import { FENCE_TAG } from '../host/fence.ts';
import type { ComputerPort } from '../host/tools.ts';
import type { AuditRow, HaloEvent } from '../host/types.ts';
import { resetQuirks } from '../host/provider.ts';
import { CASES, fixturePage, type World } from '../evals/tasks.mts';

// ---------------------------------------------------------------- the model

interface ScriptedTurn {
  text?: string;
  calls?: { name: string; args: Record<string, unknown> }[];
}

/**
 * One scripted assistant turn per request, in order; anything past the end is a bare stop.
 * `rejectTools` plays a server that 400s on the `tools` field, the way Ollama does for a model
 * without tool support; `bodies` keeps every streamed request so a check can read what was sent.
 */
function startModel(
  script: ScriptedTurn[],
  opts: { rejectTools?: boolean } = {},
): Promise<{ port: number; server: Server; seen: () => number; bodies: Record<string, unknown>[] }> {
  let at = 0;
  const bodies: Record<string, unknown>[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'scripted' }] }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        /*
         * The helper calls are not streamed and are not part of the script.
         *
         * Smart review, memory extraction and compaction all go through `complete`, which asks for a
         * plain JSON answer. Feeding those an SSE stream is how the first version of this harness made
         * every box command stop for approval: the review threw, and a review that cannot run
         * deliberately fails closed. That behaviour is right; the harness was wrong.
         */
        if (!/"stream"\s*:\s*true/.test(body)) {
          const answer = /ALLOW, ASK or DENY/.test(body) ? 'ALLOW\nroutine and reversible' : 'NONE';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }));
          return;
        }
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (opts.rejectTools && parsed.tools) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end('{"error":{"message":"this model does not support tools"}}');
          return;
        }
        bodies.push(parsed);
        const turn = script[at++] ?? {};
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (delta: Record<string, unknown>) =>
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
        if (turn.text) send({ content: turn.text });
        (turn.calls ?? []).forEach((call, index) => {
          send({
            tool_calls: [
              {
                index,
                id: `call_${at}_${index}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          });
        });
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: turn.calls?.length ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 5000, completion_tokens: 40 },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as { port: number }).port, server, seen: () => at, bodies }),
    );
  });
}

// ------------------------------------------------------------------ harness

let failures = 0;
function check(ok: boolean, what: string, detail = '') {
  if (ok) {
    console.log(`  PASS  ${what}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ''}`);
}

/** Enough of a browser to build a Runner; nothing here drives one. */
function stubComputer(): ComputerPort {
  return {
    ensure: async () => {},
    handOver: async () => {},
    navigate: async () => ({ url: 'about:blank', title: 'blank' }),
    act: async () => 'clicked',
    readPage: async () => 'a page',
    screenshot: async () => '',
    snapshot: async () => 'e1 button "Send"',
    describeRef: () => ({ role: 'button', name: 'Send' }),
  };
}

function llmLines(root: string, agentId: string): Record<string, unknown>[] {
  const path = join(root, 'agents', agentId, 'llm.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function settle(runner: Runner, agentId: string, ms = 15_000) {
  const until = Date.now() + ms;
  // Give the turn a moment to start before waiting for it to stop.
  await new Promise((r) => setTimeout(r, 120));
  while (runner.isBusy(agentId) && Date.now() < until) await new Promise((r) => setTimeout(r, 60));
}

// --------------------------------------------------------------------- runs

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'halo-verify-'));
  console.log(`Halo Bot — end to end, in ${root}\n`);

  const model = await startModel([
    // One turn: work in the box, reach for the user's machine, then report.
    { calls: [{ name: 'Shell', args: { command: 'Write-Output hello' } }] },
    { calls: [{ name: 'ExternalShell', args: { command: 'git status', cwd: 'C:/' } }] },
    // Plain text *and* the same line through SendMessage, which is what a model does when it has
    // been told SendMessage is the only channel. The streamed preview must not survive as a second
    // bubble saying the same thing.
    {
      text: 'Ran both. Nothing to report.',
      calls: [{ name: 'SendMessage', args: { text: 'Ran both. Nothing to report.' } }],
    },
  ]);

  const store = new Store(root);
  store.saveSettings({
    provider: {
      ...store.getSettings().provider,
      baseUrl: `http://127.0.0.1:${model.port}/v1`,
      model: 'scripted',
      apiKey: '',
      maxSteps: 8,
    },
  });
  const agent = store.createAgent({ name: 'Verify' });

  const events: HaloEvent[] = [];
  const runner = new Runner({
    store,
    computer: stubComputer(),
    emit: (event) => {
      events.push(event);
      // The gate is proved by answering it, not by asserting a card appeared and hanging.
      if (event.type === 'approval') runner.resolveApproval(event.approval.id, 'once');
    },
  });

  console.log('A turn, end to end');
  runner.submitUserMessage(agent.id, 'do the thing');
  await settle(runner, agent.id);
  // A turn still running after the wait is the one failure the checks below cannot explain, so the
  // evidence is printed without being asked for: on CI there is no second chance to look.
  if (process.env.HALO_VERIFY_DEBUG || runner.isBusy(agent.id)) {
    console.log(`  [debug] still busy: ${runner.isBusy(agent.id)}`);
    console.log(`  [debug] model requests seen: ${model.seen()}`);
    console.log(`  [debug] tool results: ${JSON.stringify(llmLines(root, agent.id).filter((l) => l.role === 'tool').map((l) => [l.name, String(l.content).slice(0, 200)]))}`);
    console.log(`  [debug] transcript: ${JSON.stringify(store.transcript(agent.id).map((m) => [m.role, m.text.slice(0, 60)]))}`);
    console.log(`  [debug] events: ${JSON.stringify(events.map((e) => e.type))}`);
  }

  const transcript = store.transcript(agent.id);
  check(
    transcript.some((m) => m.role === 'agent' && m.text.includes('Ran both')),
    'SendMessage is the only channel, and it reaches the transcript',
  );
  check(
    events.some((e) => e.type === 'approval' && e.approval.surface === 'external_shell'),
    'a command on the user\'s machine stops at the approval gate',
  );
  check(
    transcript.filter((m) => m.role === 'agent' && m.text.includes('Ran both')).length === 1,
    'the streamed preview is not a second copy of the answer',
    transcript
      .filter((m) => m.role === 'agent')
      .map((m) => m.text.slice(0, 40))
      .join(' | '),
  );

  const lines = llmLines(root, agent.id);
  const shellResult = lines.find((l) => l.role === 'tool' && l.name === 'Shell');
  check(
    typeof shellResult?.content === 'string' && (shellResult.content as string).includes(FENCE_TAG),
    'what a tool brought back reaches the model fenced',
    JSON.stringify(shellResult?.content ?? null).slice(0, 160),
  );
  const sendResult = lines.find((l) => l.role === 'tool' && l.name === 'SendMessage');
  check(
    typeof sendResult?.content === 'string' && !(sendResult.content as string).includes(FENCE_TAG),
    'Halo\'s own answer about its own state is not fenced',
  );

  console.log('\nThe trail');
  const audit = new AuditLog(root).read({ limit: 50 });
  const external = audit.find((r) => r.tool === 'ExternalShell' && r.outcome === 'allowed');
  check(Boolean(external), 'a gated action leaves a row');
  check(
    external?.source === 'user' && external?.matched === 'once',
    'the row names who decided it and how',
    JSON.stringify({ source: external?.source, matched: external?.matched }),
  );
  check(
    !audit.some((r) => r.tool === 'ExternalShell' && r.outcome === 'failed'),
    'a command in a directory that exists is not reported as a failure',
  );
  const shellRow = audit.find((r) => r.tool === 'Shell');
  check(Boolean(shellRow), 'a box command is on the trail too, not only the gated ones');

  console.log('\nThe floor, with every switch turned the wrong way');
  store.saveSettings({
    autoReview: false,
    policyMode: 'dry-run',
    localExecution: 'allow',
    rules: [{ id: 'r1', when: 'run any command at all', decision: 'allow' }],
  });
  runner.updateAgent(agent.id, { localExecution: 'allow', allowedPaths: ['C:/'] });
  for (const command of [
    'Remove-Item C:\\ -Recurse -Force',
    'powershell -Command "Remove-Item C:\\ -Recurse -Force"',
    'format C: /fs:ntfs',
    'vssadmin delete shadows /all',
    'bcdedit /set {default} safeboot minimal',
  ]) {
    const out = await runner.runToolForTest(agent.id, 'ExternalShell', { command });
    check(/never lets a bot/.test(out), `refused: ${command.slice(0, 46)}`, out.slice(0, 120));
  }
  const refused = new AuditLog(root).read({ limit: 50, outcome: 'refused' });
  check(
    refused.some((r: AuditRow) => r.source === 'hardline'),
    'a refusal by the floor is on the trail, and says the floor refused it',
  );

  console.log('\nBackground work');
  const worker = await startModel([{ text: 'Found three of them.' }]);
  store.saveSettings({
    autoReview: true,
    policyMode: 'enforce',
    rules: [],
    provider: { ...store.getSettings().provider, baseUrl: `http://127.0.0.1:${worker.port}/v1` },
  });
  const taskId = runner.dispatchSubagent(agent.id, 'research', 'count them', 'Count the things.');
  check(/^task_/.test(taskId), 'Task hands the job to a background worker');
  check(
    /No subagent called/.test(runner.messageSubagent('task_nope', 'narrow it')),
    'a note to a worker that does not exist is refused, not swallowed',
  );
  await settle(runner, agent.id, 20_000);

  const after = llmLines(root, agent.id);
  const report = after.find(
    (l) => l.role === 'user' && typeof l.content === 'string' && (l.content as string).includes('Background task'),
  );
  check(Boolean(report), 'the worker\'s report comes back as a turn on the parent');
  check(
    typeof report?.content === 'string' && (report.content as string).includes(FENCE_TAG),
    'and it comes back fenced — a report is a model repeating what it read on the web',
    String(report?.content ?? '').slice(0, 160),
  );

  model.server.close();
  worker.server.close();
  await realJob();
  store.flush();
  // Every bot made here, deleted the way the app deletes one — which also removes its box's
  // AppContainer profile rather than leaving one behind per run.
  for (const made of store.listAgents()) store.deleteAgent(made.id);
  rmSync(root, { recursive: true, force: true });

  if (failures > 0) {
    console.log('\nEvents, for whatever went wrong:');
    for (const event of events) {
      if (event.type === 'error') console.log(`  error: ${event.message}`);
      if (event.type === 'message' && event.message.role === 'system') console.log(`  system: ${event.message.text}`);
    }
  }
  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

// ------------------------------------------------------------------ a real job

/** The page-watch job from evals/tasks.mts, done by a scripted model, judged by the same check. */
const CHANGES = '# What changed\n- Pro: $29 -> $35 per month\n- New plan: Team, $59 per month, 10 seats\n- Free trial: 14 -> 7 days\n';
const REVIEW = '- Pro price up to $35 — ACT\n- Team plan added — KEEP\n- Trial cut to 7 days — ACT\n';
const TODAY = '# Plans\n- Starter: $9\n- Pro: $35\n- Team: $59\n- Business: $99\nFree trial: 7 days.\n';

function startSite(): Promise<{ base: string; hits: string[]; server: Server }> {
  const hits: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]!;
      const page = fixturePage(path);
      if (!page) return void res.writeHead(404).end();
      hits.push(path);
      res.writeHead(200, { 'content-type': page.type }).end(page.body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits, server }));
  });
}

async function runJob(label: string, script: ScriptedTurn[], rejectTools: boolean, site: { base: string; hits: string[] }) {
  const root = mkdtempSync(join(tmpdir(), 'halo-verify-job-'));
  const model = await startModel(script, { rejectTools });
  const store = new Store(root);
  // Loopback reads as a server on this machine, so this is the compact profile a local model gets.
  store.saveSettings({
    provider: { ...store.getSettings().provider, baseUrl: `http://127.0.0.1:${model.port}/v1`, model: 'scripted', apiKey: '', maxSteps: 10 },
  });
  const agent = store.createAgent({ name: 'Scout' });
  const box = store.boxDir(agent.id);
  const job = CASES.find((c) => c.id === 'page-watch')!;
  for (const [path, body] of Object.entries(job.files ?? {})) {
    mkdirSync(join(box, path, '..'), { recursive: true });
    writeFileSync(join(box, path), body);
  }
  const events: HaloEvent[] = [];
  const runner = new Runner({
    store,
    computer: stubComputer(),
    emit: (event) => {
      events.push(event);
      if (event.type === 'approval') runner.resolveApproval(event.approval.id, 'once');
    },
  });
  site.hits.length = 0;
  runner.submitUserMessage(agent.id, typeof job.prompt === 'function' ? job.prompt(site.base) : job.prompt);
  await settle(runner, agent.id, 20_000);

  const history = llmLines(root, agent.id) as { role: string; name?: string; content?: string; tool_calls?: { function: { name: string; arguments: string } }[] }[];
  const world: World = {
    replies: store
      .transcript(agent.id)
      .filter((m) => m.role === 'agent')
      .map((m) => m.text)
      .join('\n'),
    boxFile: (path) => (existsSync(join(box, path)) ? readFileSync(join(box, path), 'utf8') : null),
    calls: history
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.tool_calls ?? [])
      .map((c) => ({ name: c.function.name, args: JSON.parse(c.function.arguments || '{}') as Record<string, unknown> })),
    hits: [...site.hits],
  };
  check(
    job.done(world),
    `${label}: the page-watch job is done — page opened, changes, review list, snapshot, report`,
    JSON.stringify({ hits: world.hits, replies: world.replies.slice(0, 80) }),
  );
  const fetched = history.find((l) => l.role === 'tool' && l.name === 'WebFetch');
  check(Boolean(fetched?.content?.includes(FENCE_TAG)), `${label}: the page reached the model fenced`);
  model.server.close();
  store.flush();
  for (const made of store.listAgents()) store.deleteAgent(made.id);
  rmSync(root, { recursive: true, force: true });
  return { bodies: model.bodies, events };
}

async function realJob() {
  const site = await startSite();
  const url = `${site.base}/pricing`;

  console.log('\nA real job, native tool calls');
  const native = await runJob(
    'native',
    [
      { calls: [{ name: 'WebFetch', args: { url } }, { name: 'Read', args: { path: 'watch/pricing.md' } }] },
      {
        calls: [
          { name: 'Write', args: { path: 'watch/changes.md', content: CHANGES } },
          { name: 'Write', args: { path: 'watch/review.md', content: REVIEW } },
          { name: 'Write', args: { path: 'watch/pricing.md', content: TODAY } },
        ],
      },
      { calls: [{ name: 'SendMessage', args: { text: 'Pro went to $35, a Team plan appeared, the trial is 7 days now. Review list is in watch/review.md.' } }] },
    ],
    false,
    site,
  );
  const wire = ((native.bodies[0]?.tools as { function: { name: string } }[] | undefined) ?? []).map((t) => t.function.name);
  check(
    wire.length > 0 && wire.length <= 14 && wire.includes('FindTool') && wire.includes('UseTool'),
    'a local model gets the compact catalog, not forty schemas',
    wire.join(' '),
  );
  const system = ((native.bodies[0]?.messages as { role: string; content: string }[] | undefined) ?? [])[0]?.content ?? '';
  check(system.length < 7000 && system.includes(FENCE_TAG), 'and the short prompt, fence rules included', `${system.length} chars`);

  console.log('\nThe same job on a server that refuses the tools field');
  resetQuirks();
  const block = (tool: string, args: Record<string, unknown>) => '```json\n' + JSON.stringify({ tool, args }) + '\n```';
  const content = await runJob(
    'content',
    [
      { text: `Checking the page.\n${block('WebFetch', { url })}\n${block('Read', { path: 'watch/pricing.md' })}` },
      {
        text: [
          block('Write', { path: 'watch/changes.md', content: CHANGES }),
          block('Write', { path: 'watch/review.md', content: REVIEW }),
          block('Write', { path: 'watch/pricing.md', content: TODAY }),
        ].join('\n'),
      },
      // Reached through UseTool: the real tool must still meet the gate under its own name.
      { text: block('UseTool', { name: 'ExternalShell', args: { command: 'git status', cwd: 'C:/' } }) },
      { text: block('SendMessage', { text: 'Pro went to $35, a Team plan appeared, the trial is 7 days now.' }) },
    ],
    true,
    site,
  );
  check(content.bodies.length > 0 && content.bodies.every((b) => b.tools === undefined), 'after one refusal every request goes out without the tools field');
  check(
    content.bodies.every((b) => (b.messages as { role: string }[]).every((m) => m.role !== 'tool')),
    'and without tool roles, which such a server cannot render',
  );
  check(
    content.events.some((e) => e.type === 'approval' && e.approval.surface === 'external_shell'),
    'a tool reached through UseTool still stops at the approval gate',
  );
  resetQuirks();
  site.server.close();
}

void main();
