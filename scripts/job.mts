/**
 * Real jobs, run by the real runtime against a real model.
 *
 *   node scripts/job.mts                          llama.cpp on localhost:8080, every case
 *   node scripts/job.mts --only page-watch        one case (comma-separate several; --tag job for the web jobs)
 *   node scripts/job.mts --url https://openrouter.ai/api/v1 --model google/gemma-4-26b-a4b-it:free --key-env OPENROUTER_API_KEY
 *   options: --profile auto|full|compact  --tools native|content  --repeat N  --timeout SECONDS  --out report.json
 *            --fallback model,model (OpenRouter's own fallback list)
 *
 * Nothing here is scripted: the model decides every step. What is judged is the world afterwards —
 * files in the box, pages the fixture site actually served, what reached the user — never what the
 * model says it did. Approvals are refused, because nobody is at the keyboard and none of these jobs
 * needs one; a refusal is counted, so a bot that keeps reaching past its box shows up in the report.
 *
 * The browser is a text browser over fetch: navigate, read and snapshot work, clicks do not. Enough
 * for "open the page and read it", which is what these jobs ask; the real window is electron/computer.ts.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from '../host/store.ts';
import { Runner } from '../host/runner.ts';
import type { ComputerPort } from '../host/tools.ts';
import type { Settings } from '../host/types.ts';
import { CASES, fixturePage, type World } from '../evals/tasks.mts';

const { values: opt } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:8080/v1' },
    model: { type: 'string', default: '' },
    'key-env': { type: 'string', default: '' },
    profile: { type: 'string', default: 'auto' },
    tools: { type: 'string', default: 'native' },
    only: { type: 'string', default: '' },
    tag: { type: 'string', default: '' },
    repeat: { type: 'string', default: '1' },
    timeout: { type: 'string', default: '600' },
    out: { type: 'string', default: '' },
    'max-steps': { type: 'string', default: '24' },
    fallback: { type: 'string', default: '' },
  },
});

// ------------------------------------------------------------------ fixture site

function startFixture(): Promise<{ base: string; hits: string[]; server: Server }> {
  const hits: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]!;
      const page = fixturePage(path);
      if (!page) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      hits.push(path);
      res.writeHead(200, { 'content-type': page.type }).end(page.body);
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits, server }),
    );
  });
}

function pageText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|li|h\d|div|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim();
}

/** A browser over fetch: one page per bot, links as refs. */
function textBrowser(): ComputerPort {
  const pages = new Map<string, { url: string; html: string; links: string[] }>();
  const at = (agentId: string) => pages.get(agentId) ?? { url: 'about:blank', html: '', links: [] };
  return {
    ensure: async () => {},
    handOver: async () => {},
    async navigate(agentId, url) {
      const res = await fetch(url);
      const html = await res.text();
      const base = new URL(url);
      const links = [...html.matchAll(/<a[^>]+href="([^"]+)"/g)].map((m) => new URL(m[1]!, base).toString());
      pages.set(agentId, { url, html, links });
      return { url, title: /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? url };
    },
    act: async (_agentId, action) => `${action} is not available in this headless run; use navigate, read or snapshot.`,
    readPage: async (agentId) => pageText(at(agentId).html) || 'The browser has no page open. Navigate first.',
    screenshot: async () => '',
    snapshot: async (agentId) => {
      const page = at(agentId);
      return [`page ${page.url}`, ...page.links.map((l, i) => `e${i + 1} link "${l}"`), pageText(page.html)].join('\n');
    },
    describeRef: () => undefined,
  };
}

// --------------------------------------------------------------------- run one

interface Outcome {
  id: string;
  pass: boolean;
  seconds: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  tools: string[];
  refusedApprovals: number;
  replies: string;
  note?: string;
}

async function runCase(c: (typeof CASES)[number], provider: Settings['provider'], base: string, hits: string[]): Promise<Outcome> {
  const root = mkdtempSync(join(tmpdir(), 'halo-job-'));
  const store = new Store(root);
  store.saveSettings({ provider });
  const agent = store.createAgent({ name: 'Scout', title: 'Research and monitoring' });
  const box = store.boxDir(agent.id);
  for (const [path, body] of Object.entries(c.files ?? {})) {
    mkdirSync(dirname(join(box, path)), { recursive: true });
    writeFileSync(join(box, path), body);
  }

  let refused = 0;
  let note: string | undefined;
  const runner = new Runner({
    store,
    computer: textBrowser(),
    emit: (event) => {
      if (event.type === 'approval') {
        refused += 1;
        runner.resolveApproval(event.approval.id, 'never');
      }
      if (event.type === 'error') note = event.message;
    },
  });

  hits.length = 0;
  const started = Date.now();
  const prompt = typeof c.prompt === 'function' ? c.prompt(base) : c.prompt;
  runner.submitUserMessage(agent.id, prompt);
  const deadline = started + Number(opt.timeout) * 1000;
  await new Promise((r) => setTimeout(r, 150));
  while (runner.isBusy(agent.id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  if (runner.isBusy(agent.id)) {
    note = `timed out after ${opt.timeout}s`;
    runner.stop(agent.id);
    await new Promise((r) => setTimeout(r, 500));
  }

  const history = store.llmHistory(agent.id) as { role: string; tool_calls?: { function: { name: string; arguments: string } }[] }[];
  const calls = history
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.tool_calls ?? [])
    .map((tc) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* recorded as sent */ }
      // UseTool is a wrapper; what was done is the tool it named.
      if (tc.function.name === 'UseTool' && typeof args.name === 'string') {
        return { name: args.name, args: (args.args ?? args.arguments ?? {}) as Record<string, unknown> };
      }
      return { name: tc.function.name, args };
    });
  const replies = store
    .transcript(agent.id)
    .filter((m) => m.role === 'agent' && m.text)
    .map((m) => m.text)
    .join('\n');
  const world: World = {
    replies,
    boxFile: (path) => {
      const full = join(box, path);
      return existsSync(full) ? readFileSync(full, 'utf8') : null;
    },
    calls,
    hits: [...hits],
  };
  const usage = store.usage(started - 1).filter((u) => u.agentId === agent.id);
  const outcome: Outcome = {
    id: c.id,
    pass: c.done(world),
    seconds: Math.round((Date.now() - started) / 1000),
    modelCalls: usage.length,
    promptTokens: usage.reduce((n, u) => n + u.promptTokens, 0),
    completionTokens: usage.reduce((n, u) => n + u.completionTokens, 0),
    costUsd: usage.reduce((n, u) => n + (u.costUsd ?? 0), 0),
    tools: calls.map((x) => x.name),
    refusedApprovals: refused,
    replies: replies.slice(0, 400),
    ...(note ? { note } : {}),
  };
  runner.stop(agent.id);
  store.deleteAgent(agent.id);
  rmSync(root, { recursive: true, force: true });
  return outcome;
}

// ------------------------------------------------------------------------ main

async function main() {
  const apiKey = opt['key-env'] ? (process.env[opt['key-env']] ?? '') : '';
  if (opt['key-env'] && !apiKey) throw new Error(`${opt['key-env']} is not set`);
  let model = opt.model;
  if (!model) {
    // llama.cpp serves one model and answers to any name; ask it anyway so the report says which.
    const res = await fetch(`${opt.url.replace(/\/+$/, '')}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
    model = ((await res.json()) as { data?: { id: string }[] }).data?.[0]?.id ?? 'default';
  }
  const provider: Settings['provider'] = {
    ...new Store(mkdtempSync(join(tmpdir(), 'halo-job-defaults-'))).getSettings().provider,
    baseUrl: opt.url,
    apiKey,
    model,
    profile: opt.profile as Settings['provider']['profile'],
    toolMode: opt.tools as Settings['provider']['toolMode'],
    maxSteps: Number(opt['max-steps']),
    vision: false,
    fallbackModels: opt.fallback.split(',').map((m) => m.trim()).filter(Boolean),
  };
  const only = new Set(opt.only.split(',').map((s) => s.trim()).filter(Boolean));
  const cases = CASES.filter((c) => (only.size === 0 || only.has(c.id)) && (!opt.tag || c.tags?.includes(opt.tag)));
  const fixture = await startFixture();
  console.log(`Halo Bot jobs — ${model} at ${opt.url} · profile ${opt.profile} · tools ${opt.tools} · ${cases.length} case(s) x${opt.repeat}\n`);

  const outcomes: Outcome[] = [];
  for (let round = 0; round < Number(opt.repeat); round++) {
    for (const c of cases) {
      const o = await runCase(c, provider, fixture.base, fixture.hits);
      outcomes.push(o);
      console.log(
        `  ${o.pass ? 'PASS' : 'FAIL'}  ${o.id.padEnd(17)} ${String(o.seconds).padStart(4)}s  ${String(o.modelCalls).padStart(2)} calls  ` +
          `${(o.promptTokens / 1000).toFixed(1)}k in  ${o.costUsd ? `$${o.costUsd.toFixed(4)}  ` : ''}` +
          `tools: ${o.tools.join(' ') || '(none)'}${o.refusedApprovals ? `  refused approvals: ${o.refusedApprovals}` : ''}${o.note ? `\n        ${o.note}` : ''}`,
      );
      if (!o.pass && process.env.HALO_JOB_DEBUG) console.log(`        replies: ${JSON.stringify(o.replies)}`);
    }
  }
  fixture.server.close();
  const passed = outcomes.filter((o) => o.pass).length;
  console.log(`\n${passed}/${outcomes.length} passed · ${outcomes.reduce((n, o) => n + o.seconds, 0)}s total`);
  if (opt.out) {
    writeFileSync(opt.out, JSON.stringify({ model, url: opt.url, profile: opt.profile, tools: opt.tools, at: new Date().toISOString(), outcomes }, null, 2));
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
