import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../host/store.ts';
import { Runner } from '../host/runner.ts';
import { verifyConfinement } from '../host/box.ts';
import type { ComputerPort } from '../host/tools.ts';
import type { HaloEvent } from '../host/types.ts';

/**
 * End to end, against the real model and the real box, with nothing stubbed but the browser.
 *
 * The unit tests prove the decisions; this proves the wiring — that a turn reaches a model, that a
 * tool call reaches the gate, that the gate reaches the trail, and that the floor and the kernel
 * boundary are in force in the assembled app rather than only in a function.
 *
 * Run: `node scripts/verify.mts [model]`
 */

const stubComputer: ComputerPort = {
  async ensure() {},
  async handOver() {},
  async navigate() { return { url: 'about:blank', title: 'stub' }; },
  async act() { return 'stub'; },
  async readPage() { return 'stub page'; },
  async screenshot() { return 'stub.png'; },
  async snapshot() { return 'stub snapshot'; },
  describeRef() { return undefined; },
};

const model = process.argv[2] ?? 'qwen3.5:9b';
const root = mkdtempSync(join(tmpdir(), 'halo-verify-'));
const store = new Store(root);
store.saveSettings({
  localExecution: 'allow',
  autoReviewMode: 'rules', // the model review is exercised separately; this run is about the wiring
  provider: { ...store.getSettings().provider, model, maxSteps: 10 },
});

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const runner = new Runner({
  store,
  computer: stubComputer,
  emit: (event: HaloEvent) => {
    if (event.type === 'message' && event.message.role === 'agent' && event.message.text) {
      console.log('  [agent]', event.message.text.replace(/\s+/g, ' ').slice(0, 160));
    }
    if (event.type === 'tool' && event.call.status !== 'running') {
      console.log('  [tool]', event.call.name, event.call.status, (event.call.result ?? event.call.error ?? '').replace(/\s+/g, ' ').slice(0, 100));
    }
    if (event.type === 'error') console.log('  [error]', event.message);
  },
});

const agent = runner.createAgent({ name: 'Probe', title: 'verification bot', description: '' });
const box = store.boxDir(agent.id);
console.log(`box: ${box}\nmodel: ${model}\n`);

// 1. The kernel boundary, asked rather than assumed.
const confinement = verifyConfinement(box);
check('the box is confined by the kernel', confinement.confined, confinement.detail);

const idle = () =>
  new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!runner.isBusy(agent.id)) {
        clearInterval(timer);
        resolve();
      }
    }, 500);
  });

async function turn(text: string) {
  console.log(`\n> ${text}`);
  runner.submitUserMessage(agent.id, text);
  await idle();
}

// 2. A real turn: model, tool loop, box write.
await turn('Write a file called hello.txt in your box containing exactly: halo works. Then read it back and tell me what it says.');
const transcript = store.transcript(agent.id);
const failed_turn = transcript.some((m) => /^(Turn failed|Model request failed|The model server)/.test(m.text));
const usedTools = transcript.some((m) => (m.toolCalls ?? []).some((c) => c.status === 'done'));
check('a turn reaches the model and runs tools in the box', usedTools && !failed_turn);
check('the box write actually landed', existsSync(join(box, 'hello.txt')), existsSync(join(box, 'hello.txt')) ? readFileSync(join(box, 'hello.txt'), 'utf8').trim() : 'no file');

/*
 * 3. The floor, driven directly rather than through the model.
 *
 * Asking a bot to run a wipe tests whether the model is willing, which is not the property under
 * test and is not one Halo controls — a well-behaved model refuses on its own and the floor is never
 * reached. Halo's job is to refuse when the model is NOT well behaved, so the call is made here.
 */
const gated = await runner.runToolForTest(agent.id, 'ExternalShell', { command: 'Format-Volume -DriveLetter D' });
check('the floor refuses a wipe even with execution allowed', /never lets a bot/i.test(gated), gated.slice(0, 90));

const ordinary = await runner.runToolForTest(agent.id, 'ExternalShell', { command: 'Write-Output halo' });
check('an ordinary command on the machine is allowed through', /halo/.test(ordinary), ordinary.replace(/\s+/g, ' ').slice(0, 60));

// 4. The trail carries both, decided before either ran.
const rows = runner.audit.read({ limit: 200 });
const refusal = rows.find((row) => row.outcome === 'refused' && row.source === 'hardline');
check('the refusal is on the trail, naming what refused it', Boolean(refusal), refusal?.matched ?? 'missing');
check('the allowed command is on the trail too', rows.some((row) => row.outcome === 'allowed' && row.tool === 'ExternalShell'));
check('every row names what decided it', rows.length > 0 && rows.every((row) => typeof row.source === 'string' && row.source.length > 0), `${rows.length} rows`);

store.flush();
console.log('');
const failures = results.filter((r) => !r.ok);
console.log(`${results.length - failures.length}/${results.length} checks passed`);
process.exit(failures.length === 0 ? 0 : 1);
