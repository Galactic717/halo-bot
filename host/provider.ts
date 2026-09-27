// The failure-reason vocabulary and retry policy are adapted from Hermes Agent (MIT, (c) 2025 Nous
// Research). See NOTICE.
import type { Settings } from './types.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
  /** data: URLs the model should look at; only sent when the model supports vision. */
  images?: string[];
}

/** Expands our simple message shape into the OpenAI content-parts form when images are attached. */
export function wireMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    const { images, ...rest } = message;
    if (!images || images.length === 0) return rest as unknown as Record<string, unknown>;
    return {
      ...rest,
      content: [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
      ],
    };
  });
}

/**
 * The model one bot runs on: its own when it has one, the global default otherwise.
 *
 * One function rather than the same three lines at each call site — the second copy was in the
 * subagent loop and had been written as "the global model", so a bot the user had deliberately put on
 * a bigger model handed its background work to a smaller one.
 */
export function providerFor(provider: Settings['provider'], agent?: { model?: string } | null): Settings['provider'] {
  const model = agent?.model?.trim();
  return model ? { ...provider, model } : provider;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number; costUsd?: number };
  /** The model that actually answered, when the server says — a router may have fallen back. */
  model?: string;
}

/**
 * Why a model call failed, as a code rather than a sentence.
 *
 * A caller has to branch on this — a rate limit is worth waiting out, an expired key never is, and
 * a context overflow is fixed by compacting rather than by trying again — and branching on the text
 * of somebody's error message is how that goes subtly wrong the next time a provider rewords one.
 * The vocabulary and the precedence are Hermes's: auth wins over quota, because a real 401 body
 * often mentions funds and must not be misread as a quota problem.
 */
export type FailureReason =
  | 'provider_auth_or_access'
  | 'provider_quota_limit'
  | 'provider_rate_limit'
  | 'provider_server_error'
  | 'context_overflow'
  | 'missing_config'
  | 'model_unavailable'
  | 'network'
  | 'unknown';

/** The reasons a retry can help with on its own, without changing anything first. */
const TRANSIENT: ReadonlySet<FailureReason> = new Set(['provider_rate_limit', 'provider_server_error', 'network']);

export function classifyProviderError(error: unknown): FailureReason {
  const status = error instanceof ProviderError ? error.status : undefined;
  const text = String((error as Error)?.message ?? error).toLowerCase();

  if (status === 401 || status === 403 || /invalid api key|unauthor|forbidden|authentication/.test(text)) return 'provider_auth_or_access';
  if (status === 402 || /out of funds|quota|insufficient|billing|credit balance/.test(text)) return 'provider_quota_limit';
  if (status === 429 || /rate limit|too many requests/.test(text)) return 'provider_rate_limit';
  if ((status !== undefined && status >= 500) || /server error|overloaded|bad gateway|service unavailable/.test(text)) {
    return 'provider_server_error';
  }
  if (/context length|context_length|maximum context|too many tokens|prompt is too long/.test(text)) return 'context_overflow';
  if (/no model|model not found|does not exist|unknown model/.test(text)) return 'model_unavailable';
  if (/no api key|missing|not configured/.test(text)) return 'missing_config';
  if (/econnreset|econnrefused|etimedout|epipe|fetch failed|socket hang up|network|stopped responding/.test(text)) return 'network';
  return 'unknown';
}

export function isRetryable(reason: FailureReason): boolean {
  return TRANSIENT.has(reason);
}

/** What to tell the user, per reason. Short, and it says what would fix it. */
export function describeFailure(reason: FailureReason, message: string): string {
  switch (reason) {
    case 'provider_auth_or_access':
      return 'The model server rejected the API key. Put a working one in Settings → Model.';
    case 'provider_quota_limit':
      return 'The model account is out of credit or over its quota.';
    case 'provider_rate_limit':
      return 'The model server is rate limiting this key; it kept refusing after retries.';
    case 'provider_server_error':
      return 'The model server is failing on its side and did not recover on retry.';
    case 'context_overflow':
      return 'The conversation outgrew the model context even after compacting.';
    case 'model_unavailable':
      return `That model is not available on this server: ${message}`;
    case 'missing_config':
      // Every missing_config message names the thing that is missing and the screen that fixes it,
      // which is more use than a generic line about the model.
      return message || 'The model is not configured. Pick one in Settings → Model.';
    case 'network':
      return 'The model server could not be reached.';
    default:
      return `Model request failed: ${message}`;
  }
}

export class ProviderError extends Error {
  status?: number;
  readonly reason: FailureReason;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
    this.reason = classifyProviderError(this);
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : { value: v };
  } catch {
    // models sometimes emit trailing prose after the JSON object
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>; } catch { /* fall through */ }
    }
    return { _raw: raw };
  }
}

const RETRY_DELAYS_MS = [800, 2500];
/** A single model call that has produced nothing for this long is treated as hung. */
const CALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Whether trying the same call again could help.
 *
 * An expired key, a model that does not exist and a prompt that is too long all fail the same way
 * three times in a row; retrying them costs the user a minute and tells them nothing. Only the
 * genuinely transient classes are retried here — a context overflow is handled a level up, by
 * compacting first, which is the one thing that actually changes the outcome.
 */
function isTransient(error: unknown): boolean {
  return isRetryable(classifyProviderError(error));
}

// ------------------------------------------------------------------ kinds of server

/**
 * Which server is on the other end, read off the address.
 *
 * They all speak /chat/completions, and they all differ in the parts that decide whether a bot can
 * act: OpenRouter wants to be told who is calling and can report what a call cost, llama.cpp only
 * parses tool calls with --jinja and older builds reject stream_options, Ollama answers a model that
 * cannot take tools with a 400. Treating them as one server is how a Setup label passed for support.
 */
export type ProviderKind = 'llamacpp' | 'ollama' | 'lmstudio' | 'openrouter' | 'openai';

export function providerKind(baseUrl: string): ProviderKind {
  const url = baseUrl.toLowerCase();
  if (url.includes('openrouter.ai')) return 'openrouter';
  if (/:11434(\/|$)/.test(url)) return 'ollama';
  if (/:1234(\/|$)/.test(url)) return 'lmstudio';
  if (/:8080(\/|$)/.test(url) || /\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url)) return 'llamacpp';
  return 'openai';
}

/** A server on this machine, where every token is free and the window is whatever the user loaded. */
export function isLocalKind(kind: ProviderKind): boolean {
  return kind === 'llamacpp' || kind === 'ollama' || kind === 'lmstudio';
}

/** Where OpenRouter's app attribution points. It shows up on their dashboard next to the spend. */
const APP_URL = 'https://github.com/Galactic717/halo-bot';

export function requestHeaders(settings: Settings['provider']): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
    // OpenRouter's app attribution: the Referer is the identifier, the title is the display name.
    // X-OpenRouter-Title is the current name; X-Title the one older docs and gateways still read.
    ...(providerKind(settings.baseUrl) === 'openrouter'
      ? { 'HTTP-Referer': APP_URL, 'X-OpenRouter-Title': 'Halo Bot', 'X-Title': 'Halo Bot' }
      : {}),
  };
}

/**
 * What one server has been caught refusing, so the next call does not ask again.
 * Keyed by address and model: one llama.cpp build rejects stream_options, the next one does not.
 */
interface Quirks {
  noStreamOptions?: boolean;
  /** The server rejected the `tools` field; calls go through the content protocol instead. */
  contentTools?: boolean;
}
const quirks = new Map<string, Quirks>();
const quirkKey = (settings: Settings['provider']) => `${settings.baseUrl.trim().replace(/\/+$/, '')}|${settings.model}`;
function quirksOf(settings: Settings['provider']): Quirks {
  const key = quirkKey(settings);
  let q = quirks.get(key);
  if (!q) quirks.set(key, (q = {}));
  return q;
}
/** For tests: forget what servers were caught doing. */
export function resetQuirks() {
  quirks.clear();
}

/** A 4xx that names stream_options: the server does not know the field, not a broken request. */
function rejectsStreamOptions(error: unknown): boolean {
  return error instanceof ProviderError && (error.status ?? 0) >= 400 && /stream_options/i.test(error.message);
}

/**
 * A server or model that will not take the `tools` field at all.
 * Ollama: "does not support tools". OpenRouter: "No endpoints found that support tool use".
 * llama.cpp without --jinja: "tools param requires --jinja flag".
 */
function rejectsTools(error: unknown): boolean {
  if (!(error instanceof ProviderError) || (error.status ?? 0) < 400) return false;
  return /tool/i.test(error.message) && /support|require|jinja|not allowed|no endpoints|unsupported|unrecognized|unknown/i.test(error.message);
}

/** Whether this call goes out with a `tools` field, or with the catalog written into the prompt. */
export function usesContentTools(settings: Settings['provider']): boolean {
  return settings.toolMode === 'content' || quirksOf(settings).contentTools === true;
}

/**
 * Streams one completion, retrying transient failures.
 * A retry only happens before any text has been streamed, so the user never sees a doubled answer.
 *
 * Tool calling has two wires and one result. Natively, the schemas go in `tools` and calls come back
 * as `tool_calls` — and when a model writes its call into the text instead, which small models and
 * half-configured servers both do, it is picked up from there rather than delivered as prose that
 * never reaches anyone. Through the content protocol the catalog is written into the system prompt,
 * the history is rewritten into plain turns, and calls are parsed out of the reply. The caller sees
 * the same ChatResult either way.
 */
export async function chat(
  settings: Settings['provider'],
  messages: ChatMessage[],
  tools: ToolSchema[],
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<ChatResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let streamedAnything = false;
    const content = tools.length > 0 && usesContentTools(settings);
    try {
      const result = await chatOnce(
        settings,
        content ? toContentProtocol(messages, tools) : messages,
        content ? [] : tools,
        (chunk) => {
          streamedAnything = true;
          onDelta(chunk);
        },
        signal,
      );
      if (result.toolCalls.length === 0 && tools.length > 0) {
        const parsed = parseContentToolCalls(result.text, tools.map((t) => t.name));
        if (parsed.calls.length > 0) return { ...result, text: parsed.rest, toolCalls: parsed.calls, finishReason: 'tool_calls' };
      }
      return result;
    } catch (error) {
      lastError = error;
      if (signal?.aborted || streamedAnything) throw error;
      // Two refusals that are about the request's shape, not the moment: fix the shape, go again, and
      // remember it so the next call does not pay for the same 400.
      if (rejectsStreamOptions(error) && !quirksOf(settings).noStreamOptions) {
        quirksOf(settings).noStreamOptions = true;
        attempt--;
        continue;
      }
      if (!content && tools.length > 0 && rejectsTools(error)) {
        quirksOf(settings).contentTools = true;
        attempt--;
        continue;
      }
      if (!isTransient(error) || attempt === RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}

// --------------------------------------------------------- the content protocol

/** `Name(a: string, b?: number) — first sentence of the description.` One line a small model can read. */
export function catalogLine(schema: ToolSchema): string {
  const props = (schema.parameters.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
  const required = new Set((schema.parameters.required as string[] | undefined) ?? []);
  const params = Object.entries(props)
    .map(([name, p]) => `${name}${required.has(name) ? '' : '?'}: ${p.enum ? p.enum.map((v) => JSON.stringify(v)).join('|') : (p.type ?? 'any')}`)
    .join(', ');
  const first = schema.description.split(/(?<=\.)\s/)[0]?.trim() ?? '';
  return `- ${schema.name}(${params}) — ${first.slice(0, 200)}`;
}

export function contentProtocolRules(tools: ToolSchema[]): string {
  return `# Calling tools
You act by calling tools, never by describing what you would do. To call one, write a JSON block like this:
\`\`\`json
{"tool": "Write", "args": {"path": "notes.md", "content": "first line"}}
\`\`\`
Several blocks in one reply run in order. Each result comes back in the next message; then carry on.
Use only these tools, with exactly these argument names:
${tools.map(catalogLine).join('\n')}`;
}

/**
 * Rewrites a native tool-calling history into plain turns, for a server that is not sent `tools`.
 *
 * Such a server either rejects `tool` roles and `tool_calls` fields or renders them into a template
 * the model was never trained on. So an assistant call becomes the JSON block the model is told to
 * write, a result becomes a user turn that says whose result it is, and consecutive turns of one role
 * are merged — Gemma's chat template refuses two user turns in a row.
 */
export function toContentProtocol(messages: ChatMessage[], tools: ToolSchema[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const push = (m: ChatMessage) => {
    const last = out[out.length - 1];
    if (last && last.role === m.role && m.role !== 'system') {
      last.content = [last.content, m.content].filter(Boolean).join('\n\n');
      if (m.images?.length) last.images = [...(last.images ?? []), ...m.images];
      return;
    }
    out.push({ ...m });
  };
  let systemDone = false;
  for (const m of messages) {
    if (m.role === 'system' && !systemDone) {
      push({ role: 'system', content: `${m.content}\n\n${contentProtocolRules(tools)}` });
      systemDone = true;
    } else if (m.role === 'assistant') {
      const blocks = (m.tool_calls ?? []).map((c) => {
        let args: unknown = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch { args = c.function.arguments; }
        return '```json\n' + JSON.stringify({ tool: c.function.name, args }) + '\n```';
      });
      push({ role: 'assistant', content: [m.content, ...blocks].filter((s) => s && s.trim()).join('\n') || '(no reply)' });
    } else if (m.role === 'tool') {
      push({ role: 'user', content: `Result of ${m.name ?? 'the tool'}:\n${m.content}` });
    } else {
      const { tool_calls: _calls, tool_call_id: _id, name: _name, ...rest } = m;
      push(rest);
    }
  }
  if (!systemDone) out.unshift({ role: 'system', content: contentProtocolRules(tools) });
  return out;
}

/** Every balanced `{...}` in the text, outermost only, with where it sat. Strings are respected. */
function objectSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = depth > 0;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) spans.push({ start, end: i + 1 });
    }
  }
  return spans;
}

/** JSON, or the looser dialect Gemma leaks when its template is not applied: bare keys, <|"|> quotes. */
function parseLoose(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const fixed = raw
      .replace(/<\|"\|>/g, '"')
      .replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
      .replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(fixed); } catch { return undefined; }
  }
}

/**
 * Tool calls a model wrote into its reply instead of the tool_calls field.
 *
 * Accepts the shapes models actually produce: our `{"tool","args"}` block, OpenAI's
 * `{"name","arguments"}`, Hermes-style `<tool_call>` tags, Gemma's `call:Name{...}`, and lists of
 * any of them. Only names in `known` count, so a reply that merely contains some JSON — a file it
 * is quoting, `{"name": "Olena"}` — is never mistaken for a call. What is left is the prose around them.
 */
export function parseContentToolCalls(
  text: string,
  known: string[],
): { calls: { id: string; name: string; args: Record<string, unknown> }[]; rest: string } {
  const byLower = new Map(known.map((n) => [n.toLowerCase(), n]));
  const calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
  const cut: { start: number; end: number }[] = [];
  const toArgs = (v: unknown): Record<string, unknown> =>
    typeof v === 'string' ? parseArgs(v) : v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const take = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.map(take).some(Boolean);
    const o = value as Record<string, any>;
    if (Array.isArray(o.tool_calls)) return take(o.tool_calls);
    const rawName = o.tool ?? o.name ?? o.tool_name ?? o.function?.name;
    const name = typeof rawName === 'string' ? byLower.get(rawName.trim().toLowerCase()) : undefined;
    if (!name) return false;
    const args = o.args ?? o.arguments ?? o.parameters ?? o.input ?? o.function?.arguments ?? {};
    calls.push({ id: `call_${globalThis.crypto.randomUUID().slice(0, 8)}`, name, args: toArgs(args) });
    return true;
  };

  // Gemma's own call syntax, when the server did not turn it into tool_calls.
  for (const m of text.matchAll(/(?:<\|tool_call>\s*)?call:([A-Za-z_]\w*)\s*(\{[\s\S]*?\})\s*(?:<tool_call\|>|$)/g)) {
    const name = byLower.get(m[1]!.toLowerCase());
    if (!name) continue;
    calls.push({ id: `call_${globalThis.crypto.randomUUID().slice(0, 8)}`, name, args: toArgs(parseLoose(m[2]!)) });
    cut.push({ start: m.index!, end: m.index! + m[0].length });
  }
  if (calls.length === 0) {
    for (const span of objectSpans(text)) {
      if (take(parseLoose(text.slice(span.start, span.end)))) cut.push(span);
    }
  }
  if (calls.length === 0) return { calls, rest: text };

  let rest = '';
  let at = 0;
  for (const span of cut.sort((a, b) => a.start - b.start)) {
    rest += text.slice(at, span.start);
    at = span.end;
  }
  rest += text.slice(at);
  rest = rest
    .replace(/```(?:json|tool_call|tool_code)?\s*```/g, '')
    .replace(/<\/?tool_call>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { calls, rest };
}

/**
 * The address every request is built from, checked once here rather than at four call sites.
 *
 * An empty or malformed address is a configuration mistake, not a network failure, and `fetch`
 * reports it as "Failed to parse URL from /chat/completions" — which reads like a bug in Halo rather
 * than an empty box in Settings. Raised as a ProviderError here it classifies as missing_config and
 * says which screen fixes it.
 */
function endpoint(settings: Settings['provider'], path: string): string {
  const base = settings.baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new ProviderError('the model server address is not configured — set one in Settings → Model');
  if (!/^https?:\/\//i.test(base)) {
    throw new ProviderError(`the model server address is not configured correctly: "${base}" has to start with http:// or https://`);
  }
  return base + path;
}

async function chatOnce(
  settings: Settings['provider'],
  messages: ChatMessage[],
  tools: ToolSchema[],
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const url = endpoint(settings, '/chat/completions');
  const kind = providerKind(settings.baseUrl);
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: wireMessages(messages),
    stream: true,
  };
  // Most OpenAI-compatible servers send a final usage chunk when asked; an older llama.cpp 400s on it.
  if (!quirksOf(settings).noStreamOptions) body.stream_options = { include_usage: true };
  if (kind === 'openrouter') {
    // Its last chunk always carries usage with `cost`; `models` is OpenRouter's own fallback list.
    const fallbacks = (settings.fallbackModels ?? []).map((m) => m.trim()).filter((m) => m && m !== settings.model);
    if (fallbacks.length) body.models = [settings.model, ...fallbacks];
  }
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }

  // Two ways out: the caller aborting, or the server going quiet for too long.
  const guard = new AbortController();
  const onAbort = () => guard.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let idleTimer = setTimeout(() => guard.abort(), CALL_TIMEOUT_MS);
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => guard.abort(), CALL_TIMEOUT_MS);
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: requestHeaders(settings),
      body: JSON.stringify(body),
      signal: guard.signal,
    });
  } catch (error) {
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onAbort);
    if (guard.signal.aborted && !signal?.aborted) throw new ProviderError('the model server stopped responding');
    throw error;
  }

  if (!res.ok || !res.body) {
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onAbort);
    const detail = await res.text().catch(() => '');
    throw new ProviderError(`${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 400)}` : ''}`, res.status);
  }

  let text = '';
  let finishReason = 'stop';
  let usage: ChatResult['usage'] = { promptTokens: 0, completionTokens: 0 };
  let servedBy: string | undefined;
  const calls = new Map<number, { id: string; name: string; args: string }>();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamError: ProviderError | undefined;
  read: for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    touch();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json: any;
      try { json = JSON.parse(payload); } catch { continue; }
      if (typeof json.model === 'string' && json.model) servedBy = json.model;
      if (json.usage) {
        usage = {
          promptTokens: json.usage.prompt_tokens ?? usage.promptTokens,
          completionTokens: json.usage.completion_tokens ?? usage.completionTokens,
          ...(typeof json.usage.cost === 'number' ? { costUsd: json.usage.cost } : usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        };
      }
      // A mid-stream error: OpenRouter reports a provider failing after the 200 this way.
      if (json.error && !json.choices) {
        streamError = new ProviderError(String(json.error.message ?? JSON.stringify(json.error)), Number(json.error.code) || undefined);
        break read;
      }
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? choice.message ?? {};
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content;
        onDelta(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? calls.size;
        const cur = calls.get(idx) ?? { id: tc.id ?? `call_${idx}`, name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(idx, cur);
      }
    }
  }

  clearTimeout(idleTimer);
  signal?.removeEventListener('abort', onAbort);
  if (streamError) {
    await reader.cancel().catch(() => {});
    throw streamError;
  }

  return {
    text,
    finishReason,
    usage,
    ...(servedBy ? { model: servedBy } : {}),
    toolCalls: [...calls.values()].filter((c) => c.name).map((c) => ({ id: c.id, name: c.name, args: parseArgs(c.args) })),
  };
}

/** A background job blocks a turn, so it gets a much shorter leash than a streamed answer. */
const HELPER_TIMEOUT_MS = 90_000;

/**
 * Non-streaming helper used for small background jobs (memory synthesis, risk review, compaction).
 * Always bounded: a helper that hangs would otherwise wedge the turn that is waiting on it.
 */
export async function complete(settings: Settings['provider'], messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const url = endpoint(settings, '/chat/completions');
  const guard = new AbortController();
  const onAbort = () => guard.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => guard.abort(), HELPER_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: requestHeaders(settings),
      body: JSON.stringify({ model: settings.model, messages: wireMessages(messages), stream: false }),
      signal: guard.signal,
    });
    if (!res.ok) throw new ProviderError(`${res.status} ${res.statusText}`, res.status);
    const json: any = await res.json();
    return json.choices?.[0]?.message?.content ?? '';
  } catch (error) {
    if (guard.signal.aborted && !signal?.aborted) throw new ProviderError('the model server stopped responding');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface ServerInfo {
  kind: ProviderKind;
  /** Tokens per request the server will hold, when it says. */
  contextWindow?: number;
  /** Whether its chat template can render tool calls; false means the content protocol is the only way. */
  nativeTools?: boolean;
}

/**
 * What Setup can learn about a server beyond its model list. llama.cpp is the one that says the
 * things that decide whether a bot can act at all: the window it was started with, and whether the
 * chat template it loaded (--jinja) understands tools.
 */
export async function serverInfo(settings: Settings['provider']): Promise<ServerInfo> {
  const kind = providerKind(settings.baseUrl);
  if (kind !== 'llamacpp') return { kind };
  try {
    const root = endpoint(settings, '').replace(/\/v1$/, '');
    const res = await fetch(`${root}/props`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { kind };
    const json: any = await res.json();
    const n = Number(json.default_generation_settings?.n_ctx ?? json.n_ctx);
    const caps = json.chat_template_caps;
    return {
      kind,
      ...(n > 0 ? { contextWindow: n } : {}),
      ...(caps && typeof caps.supports_tool_calls === 'boolean' ? { nativeTools: caps.supports_tool_calls } : {}),
    };
  } catch {
    return { kind };
  }
}

export interface ModelInfo {
  id: string;
  /** Bytes on disk, when the server tells us. */
  size?: number;
  parameterSize?: string;
  capabilities?: string[];
}

/**
 * Ollama exposes size and capabilities on its native endpoint, which is what makes it possible
 * to pick a model that actually fits the machine instead of the first one in the list.
 */
export async function listModelsDetailed(settings: Settings['provider']): Promise<ModelInfo[]> {
  const base = endpoint(settings, '');
  if (/:11434(\/|$)/.test(base) || base.includes('11434')) {
    const root = base.replace(/\/v1$/, '');
    try {
      const res = await fetch(`${root}/api/tags`);
      if (res.ok) {
        const json: any = await res.json();
        const models: ModelInfo[] = (json.models ?? []).map((m: any) => ({
          id: m.name,
          size: m.size,
          parameterSize: m.details?.parameter_size,
          capabilities: m.capabilities ?? [],
        }));
        if (models.length > 0) return models;
      }
    } catch {
      /* fall through to the OpenAI-compatible listing */
    }
  }
  return (await listModels(settings)).map((id) => ({ id }));
}

/** Best local pick: supports tools, and the largest that still fits comfortably in memory. */
export function rankModels(models: ModelInfo[], memoryBytes: number): ModelInfo[] {
  const budget = memoryBytes * 0.55;
  return [...models]
    .filter((m) => !/embed|bge|nomic|reranker/i.test(m.id))
    .filter((m) => !m.capabilities || m.capabilities.length === 0 || m.capabilities.includes('tools'))
    .sort((a, b) => {
      const fitsA = (a.size ?? 0) <= budget ? 1 : 0;
      const fitsB = (b.size ?? 0) <= budget ? 1 : 0;
      if (fitsA !== fitsB) return fitsB - fitsA;
      return (b.size ?? 0) - (a.size ?? 0);
    });
}

export async function listModels(settings: Settings['provider']): Promise<string[]> {
  const url = endpoint(settings, '/models');
  const res = await fetch(url, { headers: requestHeaders(settings) });
  if (!res.ok) throw new ProviderError(`${res.status} ${res.statusText}`, res.status);
  const json: any = await res.json();
  return (json.data ?? []).map((m: any) => m.id).filter(Boolean);
}
