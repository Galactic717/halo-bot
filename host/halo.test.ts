import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './memory.ts';
import { Store } from './store.ts';
import { isOverDailyCap, nextRun } from './scheduler.ts';
import { decide, isInsideAllowed, matchRule, reachesOutsideBox, summarize, type ActionSummary } from './policy.ts';
import { parseTrigger, describeTrigger } from './tools.ts';
import { DEFAULT_SETTINGS } from './store.ts';
import { mentionedNames } from './mentions.ts';
import { buildPortableBot, parsePortableBot } from './portable.ts';
import { compactHistory, estimateTokens } from './compaction.ts';
import { rankModels, type ChatMessage } from './provider.ts';
import type { Routine, Settings } from './types.ts';

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });
const routine = (...triggers: Routine['triggers']): Routine => ({
  id: 'r',
  agentId: 'a',
  name: 'n',
  prompt: 'p',
  triggers,
  enabled: true,
  createdAt: 0,
});

test('interval routines fire one period ahead', () => {
  const from = Date.UTC(2026, 0, 1, 10, 0, 0);
  assert.equal(nextRun(routine({ kind: 'interval', everyMinutes: 30 }), from), from + 30 * 60_000);
});

test('daily routine rolls to tomorrow once the time has passed', () => {
  const base = new Date(2026, 0, 1, 12, 0, 0).getTime();
  const at9 = nextRun(routine({ kind: 'daily', hour: 9, minute: 0 }), base);
  assert.equal(new Date(at9).getDate(), 2);
  const at18 = nextRun(routine({ kind: 'daily', hour: 18, minute: 30 }), base);
  assert.equal(new Date(at18).getDate(), 1);
  assert.equal(new Date(at18).getHours(), 18);
});

test('weekdays routine skips the weekend', () => {
  const friday = new Date(2026, 0, 2, 12, 0, 0).getTime(); // 2026-01-02 is a Friday
  const next = new Date(nextRun(routine({ kind: 'weekdays', hour: 9, minute: 0 }), friday));
  assert.equal(next.getDay(), 1); // Monday
});

test('a routine with several triggers fires at the earliest one', () => {
  const base = new Date(2026, 0, 1, 12, 0, 0).getTime();
  const next = nextRun(routine({ kind: 'daily', hour: 23, minute: 0 }, { kind: 'daily', hour: 18, minute: 0 }), base);
  assert.equal(new Date(next).getHours(), 18);
});

test('weekly routine lands on the requested weekday', () => {
  const thursday = new Date(2026, 0, 1, 12, 0, 0); // 2026-01-01 is a Thursday
  const next = new Date(nextRun(routine({ kind: 'weekly', weekday: 1, hour: 9, minute: 0 }), thursday.getTime()));
  assert.equal(next.getDay(), 1);
  assert.ok(next.getTime() > thursday.getTime());
});

const action = (summary: string, detail: string, extra: Partial<ActionSummary> = {}): ActionSummary => ({ summary, detail, ...extra });

test('actions on the user machine ask by default and can be turned off entirely', () => {
  assert.equal(decide(settings(), 'external_shell', action('Run a command on your computer', 'dir')), 'ask');
  assert.equal(decide(settings({ localExecution: 'never' }), 'external_shell', action('x', 'dir')), 'deny');
  assert.equal(decide(settings({ localExecution: 'allow' }), 'external_shell', action('x', 'dir')), 'allow');
});

test('destructive commands are escalated even inside the box', () => {
  assert.equal(decide(settings(), 'shell', action('Run a command', 'Get-ChildItem')), 'allow');
  assert.equal(decide(settings(), 'shell', action('Run a command', 'Remove-Item C:\\data -Recurse -Force')), 'ask');
  assert.equal(decide(settings({ autoReview: false }), 'shell', action('Run a command', 'Remove-Item C:\\data -Recurse')), 'allow');
});

test('a blanket allow on the user machine still stops at a destructive command', () => {
  const wideOpen = settings({ localExecution: 'allow' });
  assert.equal(decide(wideOpen, 'external_shell', action('Run a command on your computer', 'dir')), 'allow');
  assert.equal(decide(wideOpen, 'external_shell', action('Run a command on your computer', 'Remove-Item C:\\ -Recurse -Force')), 'ask');
  assert.equal(decide(wideOpen, 'external_shell', action('Run a command on your computer', 'vssadmin delete shadows')), 'ask');
});

test('a box command that reaches out of the box is treated as touching the machine', () => {
  const box = 'C:\\Users\\me\\AppData\\Roaming\\Halo Bot\\agents\\a1\\box';
  assert.equal(reachesOutsideBox('npm install; node build.mjs', box), false);
  assert.equal(reachesOutsideBox('Get-Content notes/todo.md', box), false);
  // an https url is not a drive letter
  assert.equal(reachesOutsideBox('curl https://example.com -o page.html', box), false);
  // the bot naming its own box is not an escape
  assert.equal(reachesOutsideBox(`Get-Content ${box}\\notes.md`, box), false);
  assert.equal(reachesOutsideBox('Get-Content C:\\Users\\me\\taxes.xlsx', box), true);
  assert.equal(reachesOutsideBox('Get-ChildItem $env:USERPROFILE', box), true);
  assert.equal(reachesOutsideBox('cd ..\\..\\secrets; dir', box), true);

  const escaping = summarize('Shell', { command: 'Get-Content C:\\Users\\me\\taxes.xlsx' }, box);
  assert.equal(escaping.outsideBox, true);
  assert.equal(decide(settings(), 'shell', escaping), 'ask');
  assert.equal(decide(settings(), 'shell', summarize('Shell', { command: 'node build.mjs' }, box)), 'allow');
});

test('a rule with no matchable words does not gate every action', () => {
  const noisy = settings({ rules: [{ id: '1', when: 'do it', decision: 'ask' }] });
  assert.equal(decide(noisy, 'shell', action('Run a command', 'Get-ChildItem')), 'allow');
});

test('allowedPaths is matched against the path, never against the command text', () => {
  const agent = { localExecution: 'inherit' as const, allowedPaths: [process.cwd()] };
  // a bare command resolved against the process cwd must not count as "inside a granted folder"
  assert.equal(decide(settings(), 'external_shell', summarize('ExternalShell', { command: 'Get-ChildItem' }), agent), 'ask');
});

test('natural language rules match on word overlap', () => {
  const withRule = settings({
    rules: [{ id: '1', when: 'read files from downloads folder', decision: 'allow' }],
    localExecution: 'ask',
  });
  assert.equal(matchRule(withRule, 'Read a file from your computer', 'C:/Users/me/Downloads/report.pdf files folder'), 'allow');
  assert.equal(matchRule(withRule, 'Run a command', 'shutdown /s'), null);
});

test('trigger parsing accepts the three shapes and renders them back', () => {
  assert.deepEqual(parseTrigger({ every_minutes: 15 }), { kind: 'interval', everyMinutes: 15 });
  assert.deepEqual(parseTrigger({ daily_at: '07:30' }), { kind: 'daily', hour: 7, minute: 30 });
  assert.deepEqual(parseTrigger({ weekly_on: 'fri 18:00' }), { kind: 'weekly', weekday: 5, hour: 18, minute: 0 });
  assert.equal(parseTrigger({}), null);
  assert.equal(describeTrigger({ kind: 'daily', hour: 7, minute: 30 }), 'daily at 07:30');
});

test('@mentions match whole names, case-insensitively', () => {
  const names = ['Scout', 'Archive', 'Ops Lead'];
  assert.deepEqual(mentionedNames(names, 'hey @scout can you look'), ['Scout']);
  assert.deepEqual(mentionedNames(names, '@Archive and @Scout both'), ['Scout', 'Archive']);
  assert.deepEqual(mentionedNames(names, 'no mentions here'), []);
  assert.deepEqual(mentionedNames(names, 'email me at scout@example.com'), []);
});

test('compaction keeps the tail and never orphans a tool result', async () => {
  const long: ChatMessage[] = [];
  for (let i = 0; i < 40; i++) {
    long.push({ role: 'user', content: `question ${i} `.repeat(80) });
    long.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'Shell', arguments: '{}' } }] });
    long.push({ role: 'tool', tool_call_id: `c${i}`, name: 'Shell', content: `output ${i} `.repeat(60) });
  }

  assert.ok(estimateTokens(long) > 5000);

  // The summariser is stubbed by pointing the provider at a server that is not there:
  // compaction must then leave the history untouched rather than dropping turns.
  const offline = { ...DEFAULT_SETTINGS.provider, baseUrl: 'http://127.0.0.1:9', model: 'none' };
  const unchanged = await compactHistory(offline, long, { tokenBudget: 1000, keepLast: 12 });
  assert.equal(unchanged.compacted, false);
  assert.equal(unchanged.messages.length, long.length);

  // A short history is never compacted at all.
  const short = await compactHistory(offline, long.slice(0, 6), { tokenBudget: 1, keepLast: 12 });
  assert.equal(short.compacted, false);
});

test('model ranking prefers tool-capable models that fit in memory', () => {
  const models = [
    { id: 'bge-m3:latest', size: 1.2e9, capabilities: ['embedding'] },
    { id: 'huge:70b', size: 40e9, capabilities: ['tools'] },
    { id: 'mid:9b', size: 6.6e9, capabilities: ['tools'] },
    { id: 'small:4b', size: 3e9, capabilities: ['tools'] },
    { id: 'notools:8b', size: 5e9, capabilities: ['completion'] },
  ];
  const ranked = rankModels(models, 16e9);
  assert.equal(ranked[0]?.id, 'mid:9b');
  assert.ok(!ranked.some((m) => m.id.startsWith('bge')));
  assert.ok(!ranked.some((m) => m.id === 'notools:8b'));
  assert.equal(ranked.at(-1)?.id, 'huge:70b');
});

test('a routine stops firing once it has used its daily allowance', () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  const hourly = Array.from({ length: 24 }, (_, i) => ({ at: now - i * 3_600_000, status: 'ok' as const }));
  assert.equal(isOverDailyCap(hourly, 24, now), true);
  assert.equal(isOverDailyCap(hourly.slice(0, 5), 24, now), false);
  // runs older than a day do not count towards the cap
  const stale = hourly.map((run) => ({ ...run, at: run.at - 3 * 86_400_000 }));
  assert.equal(isOverDailyCap(stale, 24, now), false);
});

test('a granted folder skips the approval prompt, anything outside it does not', () => {
  const agent = { localExecution: 'inherit' as const, allowedPaths: ['D:/projects/halo'] };
  assert.equal(isInsideAllowed('D:/projects/halo/src/index.ts', agent.allowedPaths), true);
  assert.equal(isInsideAllowed('D:/projects/halo', agent.allowedPaths), true);
  assert.equal(isInsideAllowed('D:/projects/other/secrets.txt', agent.allowedPaths), false);
  assert.equal(isInsideAllowed('D:/projects/halo/../other', agent.allowedPaths), false);

  const settings = { ...DEFAULT_SETTINGS };
  const read = (path: string) => summarize('ExternalRead', { path });
  assert.equal(decide(settings, 'external_read', read('D:/projects/halo/notes.md'), agent), 'allow');
  assert.equal(decide(settings, 'external_read', read('C:/Users/me/taxes.xlsx'), agent), 'ask');

  // a per-bot "never" beats the global default
  const locked = { localExecution: 'never' as const, allowedPaths: [] };
  assert.equal(decide(settings, 'external_shell', action('Run a command', 'dir'), locked), 'deny');
});

test('a bot survives an export and import round trip', () => {
  const agent = {
    id: 'a1',
    name: 'Recon',
    title: 'Web research',
    description: 'Looks things up',
    avatar: { color: 'green', face: 2 },
    notifications: true,
    createdAt: 1,
    status: 'idle' as const,
    lastActivityAt: 2,
    model: 'qwen3.5:9b',
  };
  const routine = {
    id: 'r1',
    agentId: 'a1',
    name: 'Morning check',
    prompt: 'check the thing',
    triggers: [{ kind: 'weekdays' as const, hour: 9, minute: 0 }],
    enabled: true,
    createdAt: 3,
  };

  const file = buildPortableBot({
    agent,
    memory: '- (2026-01-01) The user ships on Fridays',
    skills: [{ file: 'lookup.md', body: '# Lookup\n> use this when asked for a version' }],
    routines: [routine],
  });

  const back = parsePortableBot(JSON.parse(JSON.stringify(file)));
  assert.ok(back);
  assert.equal(back.agent.name, 'Recon');
  assert.equal(back.agent.model, 'qwen3.5:9b');
  assert.equal(back.skills.length, 1);
  assert.deepEqual(back.routines[0]?.triggers, routine.triggers);
  assert.match(back.memory, /ships on Fridays/);

  // anything that is not a Halo bot file is rejected rather than half-imported
  assert.equal(parsePortableBot({ kind: 'something-else' }), null);
  assert.equal(parsePortableBot({ kind: 'halo-bot', agent: {} }), null);
  assert.equal(parsePortableBot('nonsense'), null);
});

function scratchStore(): Store {
  return new Store(mkdtempSync(join(tmpdir(), 'halo-test-')));
}

test('memory survives a round trip through its text form, and the prompt sees it', () => {
  const store = scratchStore();
  const agent = store.createAgent({ name: 'Scribe' });
  const memory = new MemoryStore(store, agent.id);

  memory.add('profile', 'The user is called Gleb');
  memory.add('log', 'Makes car CGI shorts in Blender');
  memory.add('note', 'Prefers dark themes');

  const text = memory.exportText();
  assert.match(text, /^profile: The user is called Gleb$/m);
  assert.match(text, /^log: Makes car CGI shorts in Blender$/m);

  const restored = new MemoryStore(scratchStore(), agent.id);
  restored.importText(text);
  assert.deepEqual(
    restored.list().map((f) => `${f.tier}:${f.text}`).sort(),
    memory.list().map((f) => `${f.tier}:${f.text}`).sort(),
  );
  // what the bot actually reads each turn is the same store, not a separate file
  assert.match(restored.render(), /Gleb/);
  assert.match(restored.render(), /Blender/);
});

test('an old memory.md is folded in once and then removed', () => {
  const store = scratchStore();
  const agent = store.createAgent({ name: 'Legacy' });
  const legacy = join(store.agentDir(agent.id), 'memory.md');
  writeFileSync(legacy, '# Legacy — memory\n\n- (2026-01-01) Ships on Fridays\n', 'utf8');

  const memory = new MemoryStore(store, agent.id);
  assert.equal(existsSync(legacy), false);
  assert.match(memory.render(), /Ships on Fridays/);
});

test('memory ranking decays with age instead of being swamped by the timestamp', () => {
  const store = scratchStore();
  const agent = store.createAgent({ name: 'Ranker' });
  const memory = new MemoryStore(store, agent.id);
  const now = Date.now();
  const day = 86_400_000;

  memory.add('note', 'trivial thing from today', now);
  memory.add('log', 'real thing from a week ago', now - 7 * day);
  memory.add('log', 'ancient thing', now - 400 * day);

  const rendered = memory.render();
  // a week-old log beats a note from today, and the ancient one comes last
  const order = ['real thing from a week ago', 'trivial thing from today', 'ancient thing'].map((t) => rendered.indexOf(t));
  assert.ok(order.every((i) => i >= 0), 'every fact is rendered');
  assert.deepEqual([...order].sort((a, b) => a - b), order, `unexpected order: ${rendered}`);
});

test('a message patch reaches disk even though the write is coalesced', () => {
  const store = scratchStore();
  const agent = store.createAgent({ name: 'Writer' });
  const message = store.appendMessage({ id: 'm1', agentId: agent.id, role: 'agent', text: 'first', createdAt: 1 });

  store.updateMessage(agent.id, message.id, { text: 'patched' });
  store.flush();

  const path = join(store.agentDir(agent.id), 'transcript.jsonl');
  assert.match(readFileSync(path, 'utf8'), /"text":"patched"/);
});

test('settings survive a save and reload, and a half-written file cannot appear', () => {
  const root = mkdtempSync(join(tmpdir(), 'halo-test-'));
  const store = new Store(root);
  store.saveSettings({ localExecution: 'never', provider: { ...store.getSettings().provider, model: 'qwen3:8b' } });

  assert.equal(existsSync(join(root, 'settings.json.tmp')), false);
  const reloaded = new Store(root);
  assert.equal(reloaded.getSettings().localExecution, 'never');
  assert.equal(reloaded.getSettings().provider.model, 'qwen3:8b');
});

test('sealed secrets never reach the settings file in the clear', () => {
  const root = mkdtempSync(join(tmpdir(), 'halo-test-'));
  const codec = {
    encrypt: (v: string) => Buffer.from(v, 'utf8').toString('base64'),
    decrypt: (v: string) => Buffer.from(v, 'base64').toString('utf8'),
  };
  const store = new Store(root, codec);
  store.saveSettings({
    provider: { ...store.getSettings().provider, apiKey: 'sk-super-secret' },
    plugins: [{ id: 'gh', name: 'GitHub', description: '', category: 'Code', command: 'npx', args: [], env: { TOKEN: 'ghp_secret' } }],
  });

  const onDisk = readFileSync(join(root, 'settings.json'), 'utf8');
  assert.ok(!onDisk.includes('sk-super-secret'), 'api key is not stored in the clear');
  assert.ok(!onDisk.includes('ghp_secret'), 'plugin credentials are not stored in the clear');

  const reloaded = new Store(root, codec);
  assert.equal(reloaded.getSettings().provider.apiKey, 'sk-super-secret');
  assert.equal(reloaded.getSettings().plugins[0]?.env?.TOKEN, 'ghp_secret');
});
