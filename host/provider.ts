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

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number };
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
      return 'The model is not configured. Pick one in Settings → Model.';
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

/**
 * Streams one completion, retrying transient failures.
 * A retry only happens before any text has been streamed, so the user never sees a doubled answer.
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
    try {
      return await chatOnce(
        settings,
        messages,
        tools,
        (chunk) => {
          streamedAnything = true;
          onDelta(chunk);
        },
        signal,
      );
    } catch (error) {
      lastError = error;
      if (signal?.aborted || streamedAnything || !isTransient(error) || attempt === RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}

async function chatOnce(
  settings: Settings['provider'],
  messages: ChatMessage[],
  tools: ToolSchema[],
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: wireMessages(messages),
    stream: true,
    // Most OpenAI-compatible servers send a final usage chunk when asked; the rest ignore it.
    stream_options: { include_usage: true },
  };
  if (tools.length > 0 && settings.toolMode === 'native') {
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
      headers: {
        'content-type': 'application/json',
        ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
      },
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
  let usage = { promptTokens: 0, completionTokens: 0 };
  const calls = new Map<number, { id: string; name: string; args: string }>();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
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
      if (json.usage) {
        usage = {
          promptTokens: json.usage.prompt_tokens ?? usage.promptTokens,
          completionTokens: json.usage.completion_tokens ?? usage.completionTokens,
        };
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

  return {
    text,
    finishReason,
    usage,
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
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const guard = new AbortController();
  const onAbort = () => guard.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => guard.abort(), HELPER_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}) },
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
  const base = settings.baseUrl.replace(/\/+$/, '');
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
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/models`;
  const res = await fetch(url, { headers: settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {} });
  if (!res.ok) throw new ProviderError(`${res.status} ${res.statusText}`, res.status);
  const json: any = await res.json();
  return (json.data ?? []).map((m: any) => m.id).filter(Boolean);
}
