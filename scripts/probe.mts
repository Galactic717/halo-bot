import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../host/store.ts';
import { Runner } from '../host/runner.ts';
import type { ComputerPort } from '../host/tools.ts';
import type { HaloEvent } from '../host/types.ts';

const stubComputer: ComputerPort = {
  async ensure() {},
  async handOver() {},
  async navigate() { return { url: 'about:blank', title: 'stub' }; },
  async act() { return 'stub'; },
  async readPage() { return 'stub page'; },
  async screenshot() { return 'stub.png'; },
};

const root = mkdtempSync(join(tmpdir(), 'halo-e2e-'));
const store = new Store(root);
store.saveSettings({ localExecution: 'allow', provider: { ...store.getSettings().provider, maxSteps: 8 } });

const events: HaloEvent[] = [];
const runner = new Runner({
  store,
  computer: stubComputer,
  emit: (e) => {
    events.push(e);
    if (e.type === 'message' && e.message.role === 'agent' && e.message.text) console.log('[agent]', e.message.text.slice(0, 300));
    if (e.type === 'tool') console.log('[tool]', e.call.name, e.call.status, (e.call.result ?? e.call.error ?? '').slice(0, 120).replace(/\n/g, ' '));
    if (e.type === 'status') console.log('[status]', e.status, e.note ?? '');
    if (e.type === 'error') console.log('[error]', e.message);
  },
});

const agent = runner.createAgent({ name: 'Probe', title: 'test bot', description: 'verifies the runtime works' });
console.log('agent', agent.id, 'box', store.boxDir(agent.id));

runner.submitUserMessage(
  agent.id,
  'Write a file called hello.txt in your box containing the text "halo works", then read it back and tell me exactly what it says.',
);

const started = Date.now();
const timer = setInterval(() => {
  if (!runner.isBusy(agent.id)) {
    clearInterval(timer);
    const transcript = store.transcript(agent.id);
    console.log('\n--- transcript ---');
    for (const m of transcript) console.log(`${m.role}: ${m.text.slice(0, 200)}${(m.toolCalls ?? []).map((c) => `\n   tool ${c.name} -> ${c.status}`).join('')}`);
    console.log(`\ndone in ${Math.round((Date.now() - started) / 1000)}s, ${events.length} events`);
    process.exit(0);
  }
}, 1000);

setTimeout(() => {
  console.log('TIMEOUT');
  process.exit(1);
}, 600_000);
