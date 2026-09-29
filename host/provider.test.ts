import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  chat,
  parseContentToolCalls,
  providerKind,
  requestHeaders,
  resetQuirks,
  toContentProtocol,
  usesContentTools,
  type ChatMessage,
  type ToolSchema,
} from './provider.ts';
import { DEFAULT_SETTINGS } from './store.ts';
import { findTools, TOOLS } from './tools.ts';

const KNOWN = ['Write', 'Read', 'SendMessage'];

test('a call written into the reply is picked up in every shape models produce', () => {
  const block = parseContentToolCalls('On it.\n```json\n{"tool": "Write", "args": {"path": "a.txt", "content": "hi"}}\n```', KNOWN);
  assert.deepEqual(block.calls.map((c) => [c.name, c.args]), [['Write', { path: 'a.txt', content: 'hi' }]]);
  assert.equal(block.rest, 'On it.');

  const openai = parseContentToolCalls('{"name": "write", "arguments": "{\\"path\\": \\"b.txt\\"}"}', KNOWN);
  assert.deepEqual(openai.calls.map((c) => [c.name, c.args]), [['Write', { path: 'b.txt' }]]);

  const hermes = parseContentToolCalls('<tool_call>\n{"name": "Read", "arguments": {"path": "x"}}\n</tool_call>', KNOWN);
  assert.deepEqual(hermes.calls.map((c) => c.name), ['Read']);
  assert.equal(hermes.rest, '');

  const gemma = parseContentToolCalls('<|tool_call>call:Write{path:<|"|>hello.txt<|"|>,content:<|"|>hello<|"|>}<tool_call|>', KNOWN);
  assert.deepEqual(gemma.calls.map((c) => [c.name, c.args]), [['Write', { path: 'hello.txt', content: 'hello' }]]);

  const two = parseContentToolCalls('```json\n{"tool":"Read","args":{"path":"a"}}\n```\n```json\n{"tool":"SendMessage","args":{"text":"done"}}\n```', KNOWN);
  assert.deepEqual(two.calls.map((c) => c.name), ['Read', 'SendMessage']);

  const list = parseContentToolCalls('[{"name":"Read","arguments":{"path":"a"}},{"name":"Read","arguments":{"path":"b"}}]', KNOWN);
  assert.equal(list.calls.length, 2);
});

test('JSON that is not a call to a known tool stays prose', () => {
  const text = 'people.json holds {"name": "Olena"} and {"tool": "Nuke", "args": {}}';
  const parsed = parseContentToolCalls(text, KNOWN);
  assert.equal(parsed.calls.length, 0);
  assert.equal(parsed.rest, text);
});

test('the content protocol has no tool roles, no two turns of one role in a row, and the catalog in the system turn', () => {
  const tools = TOOLS.filter((t) => KNOWN.includes(t.schema.name)).map((t) => t.schema);
  const history: ChatMessage[] = [
    { role: 'system', content: 'You are a bot.' },
    { role: 'user', content: 'write a.txt' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Write', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'Write', content: 'Wrote a.txt' },
    { role: 'user', content: 'thanks' },
  ];
  const out = toContentProtocol(history, tools);
  assert.ok(out.every((m) => m.role !== 'tool' && !m.tool_calls && !m.tool_call_id));
  for (let i = 1; i < out.length; i++) assert.notEqual(out[i]!.role, out[i - 1]!.role);
  assert.match(out[0]!.content, /Write\(path: string, content: string\)/);
  assert.match(out[2]!.content, /"tool":"Write"/);
  assert.match(out[3]!.content, /Result of Write:\nWrote a.txt\n\nthanks/);
});

test('the server kind is read off the address, and OpenRouter is told who is calling', () => {
  assert.equal(providerKind('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(providerKind('http://localhost:8080/v1'), 'llamacpp');
  assert.equal(providerKind('http://127.0.0.1:11434/v1'), 'ollama');
  assert.equal(providerKind('http://localhost:1234/v1'), 'lmstudio');
  assert.equal(providerKind('https://api.openai.com/v1'), 'openai');
  const or = requestHeaders({ ...DEFAULT_SETTINGS.provider, baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' });
  assert.equal(or['X-OpenRouter-Title'], 'Halo Bot');
  assert.equal(or['X-Title'], 'Halo Bot');
  assert.match(or['HTTP-Referer'] ?? '', /^https:\/\//);
  assert.equal(or.authorization, 'Bearer k');
  assert.equal(requestHeaders({ ...DEFAULT_SETTINGS.provider, apiKey: '' })['X-Title'], undefined);
});

/** A server that refuses stream_options, then refuses tools, then answers with a call in its text. */
function quirkyServer(): Promise<{ url: string; bodies: Record<string, unknown>[]; close: () => void }> {
  const bodies: Record<string, unknown>[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        bodies.push(body);
        if (body.stream_options) {
          res.writeHead(400).end('{"error":"unknown field stream_options"}');
          return;
        }
        if (body.tools) {
          res.writeHead(400).end('{"error":"this model does not support tools"}');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const text = 'Writing it.\n```json\n{"tool": "Write", "args": {"path": "a.txt", "content": "x"}}\n```';
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0012 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, bodies, close: () => server.close() }),
    );
  });
}

test('a server that rejects stream_options and tools still gets a call made, and the switch is remembered', async () => {
  resetQuirks();
  const server = await quirkyServer();
  try {
    const provider = { ...DEFAULT_SETTINGS.provider, baseUrl: server.url, model: 'm' };
    const tools: ToolSchema[] = TOOLS.filter((t) => KNOWN.includes(t.schema.name)).map((t) => t.schema);
    const result = await chat(provider, [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }], tools, () => {});
    assert.deepEqual(result.toolCalls.map((c) => [c.name, c.args]), [['Write', { path: 'a.txt', content: 'x' }]]);
    assert.equal(result.text, 'Writing it.');
    assert.equal(result.usage.costUsd, 0.0012);
    assert.equal(server.bodies.length, 3);
    assert.ok(usesContentTools(provider));
    // The next call goes straight out in the shape that worked.
    await chat(provider, [{ role: 'user', content: 'again' }], tools, () => {});
    assert.equal(server.bodies.length, 4);
    assert.equal(server.bodies[3]!.tools, undefined);
    assert.equal(server.bodies[3]!.stream_options, undefined);
  } finally {
    server.close();
    resetQuirks();
  }
});

test('FindTool finds what is off the wire, with its arguments', () => {
  const out = findTools('schedule a routine', TOOLS.map((t) => t.schema));
  assert.match(out, /^CreateRoutine — /m);
  assert.match(out, /args: \{/);
  assert.match(findTools('', TOOLS.map((t) => t.schema)), /- ExternalShell — /);
});

test('a rate-limited model hands the call to the next fallback, and says which one answered', async () => {
  resetQuirks();
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const model = (JSON.parse(raw) as { model: string }).model;
      seen.push(model);
      if (model === 'busy:free') return void res.writeHead(429).end('{"error":{"message":"busy:free is temporarily rate-limited upstream"}}');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const provider = { ...DEFAULT_SETTINGS.provider, baseUrl: url, model: 'busy:free', fallbackModels: ['calm:free'] };
    const result = await chat(provider, [{ role: 'user', content: 'hi' }], [], () => {});
    assert.equal(result.text, 'ok');
    assert.equal(result.model, 'calm:free');
    assert.deepEqual(seen, ['busy:free', 'calm:free']);
  } finally {
    server.close();
  }
});
