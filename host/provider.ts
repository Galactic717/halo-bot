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

export class ProviderError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
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

function isTransient(error: unknown): boolean {
  if (error instanceof ProviderError) return error.status === undefined || error.status >= 500 || error.status === 429;
  const message = String((error as Error)?.message ?? error);
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|fetch failed|socket hang up|network/i.test(message);
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
