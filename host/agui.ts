// AG-UI as the way a foreign agent arrives is OpenBot's design (MIT, (c) 2026 CopilotKit). See NOTICE.
import type { ToolSchema } from './provider.ts';
import { ProviderError } from './provider.ts';

/**
 * Speaking to an agent somebody else wrote.
 *
 * WHY. Everything else in Halo assumes the bot is Halo's own tool loop against an OpenAI-compatible
 * endpoint. That is one agent design, and the interesting ones are being written in LangGraph, Mastra,
 * CrewAI, Pydantic AI and by hand. AG-UI is the open protocol those already speak, and it is what lets
 * OpenBot say "bring any agent and it arrives as a coworker". This is the same door on this app.
 *
 * WHAT IT BUYS, beyond hosting somebody's agent: the governance rides the protocol. Halo hands the
 * remote agent *Halo's* toolset — Shell, ExternalShell, Browser, the plugins — and every call it makes
 * comes back here to go through the same approval gate and land on the same audit trail. A foreign
 * agent gets a box, a browser, a memory and a floor it cannot lower, without knowing any of that.
 *
 * WHAT THIS IS NOT. Not the AG-UI SDK: this is the wire protocol read directly off an SSE stream, in
 * one file, because Halo carries four dependencies and they are all React. The events it does not
 * understand are ignored rather than fatal, which is what the protocol asks of a client anyway.
 */

/** The events this client acts on. Everything else in the protocol is ignored, by design. */
export type AgUiEvent =
  | { type: 'RUN_STARTED' }
  | { type: 'RUN_FINISHED' }
  | { type: 'RUN_ERROR'; message?: string; code?: string }
  | { type: 'TEXT_MESSAGE_START'; messageId?: string; role?: string }
  | { type: 'TEXT_MESSAGE_CONTENT'; messageId?: string; delta?: string }
  | { type: 'TEXT_MESSAGE_END'; messageId?: string }
  | { type: 'TOOL_CALL_START'; toolCallId?: string; toolCallName?: string; parentMessageId?: string }
  | { type: 'TOOL_CALL_ARGS'; toolCallId?: string; delta?: string }
  | { type: 'TOOL_CALL_END'; toolCallId?: string }
  | { type: string; [key: string]: unknown };

export interface AgUiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'developer';
  content?: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}

export interface AgUiRun {
  text: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  /** Whatever the agent said its run state was, kept so the next turn can hand it back. */
  state: unknown;
}

export interface AgUiOptions {
  endpoint: string;
  /** Sent as `Authorization`. Stored write-only, like every other credential here. */
  authHeader?: string;
  threadId: string;
  runId: string;
  messages: AgUiMessage[];
  tools: ToolSchema[];
  state?: unknown;
  onDelta: (chunk: string) => void;
  signal?: AbortSignal;
}

/** A single model call that has produced nothing for this long is treated as hung, as with the provider. */
const IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * The endpoint check.
 *
 * Only a person types this, in the bot's settings — no tool can set it, which is the real boundary.
 * What is left is catching the shapes that are a mistake rather than a decision: a non-http scheme,
 * and the cloud metadata address, which is never what somebody meant and is the one private address
 * worth naming. Loopback and the LAN stay allowed, because on a desktop the whole point is the
 * LangGraph server the user just started on their own machine.
 */
export function checkEndpoint(url: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'that is not a URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'an agent endpoint has to be http or https' };
  }
  if (/^(169\.254\.169\.254|metadata\.google\.internal|metadata\.goog)$/i.test(parsed.hostname)) {
    return { ok: false, reason: 'that is a cloud metadata address, which holds credentials rather than an agent' };
  }
  return { ok: true, url: parsed.toString() };
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : { value };
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return { _raw: raw };
  }
}

/**
 * Runs one turn against an AG-UI agent and returns what it said and what it wants called.
 *
 * The tool calls are *not* executed here. They go back to the runner, which puts every one through
 * the approval gate and the audit trail before anything happens — the whole reason a foreign agent
 * is worth hosting rather than just linking to.
 */
export async function runAgUi(options: AgUiOptions): Promise<AgUiRun> {
  const verdict = checkEndpoint(options.endpoint);
  if (!verdict.ok) throw new ProviderError(`This bot's endpoint was refused: ${verdict.reason}`);

  const guard = new AbortController();
  const onAbort = () => guard.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  let idle = setTimeout(() => guard.abort(), IDLE_TIMEOUT_MS);
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => guard.abort(), IDLE_TIMEOUT_MS);
  };

  let response: Response;
  try {
    response = await fetch(verdict.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(options.authHeader ? { authorization: options.authHeader } : {}),
      },
      body: JSON.stringify({
        threadId: options.threadId,
        runId: options.runId,
        state: options.state ?? {},
        messages: options.messages,
        // Halo's own tools, offered to somebody else's agent. It calls them by name; they come back
        // here and go through the gate.
        tools: options.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
        context: [],
        forwardedProps: {},
      }),
      signal: guard.signal,
    });
  } catch (error) {
    clearTimeout(idle);
    options.signal?.removeEventListener('abort', onAbort);
    if (guard.signal.aborted && !options.signal?.aborted) throw new ProviderError('the agent endpoint stopped responding');
    throw error;
  }

  if (!response.ok || !response.body) {
    clearTimeout(idle);
    options.signal?.removeEventListener('abort', onAbort);
    const detail = await response.text().catch(() => '');
    throw new ProviderError(`${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 400)}` : ''}`, response.status);
  }

  let text = '';
  let state: unknown = options.state ?? {};
  let runError: string | null = null;
  const calls = new Map<string, { id: string; name: string; args: string }>();
  let order: string[] = [];

  const handle = (event: AgUiEvent) => {
    switch (event.type) {
      case 'TEXT_MESSAGE_CONTENT': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (!delta) return;
        text += delta;
        options.onDelta(delta);
        return;
      }
      case 'TOOL_CALL_START': {
        const id = String(event.toolCallId ?? `call_${calls.size}`);
        calls.set(id, { id, name: String(event.toolCallName ?? ''), args: '' });
        order.push(id);
        return;
      }
      case 'TOOL_CALL_ARGS': {
        const id = String(event.toolCallId ?? '');
        const current = calls.get(id);
        if (current && typeof event.delta === 'string') current.args += event.delta;
        return;
      }
      case 'STATE_SNAPSHOT':
        state = (event as { snapshot?: unknown }).snapshot ?? state;
        return;
      case 'RUN_ERROR':
        // Kept rather than thrown here: the stream may still carry a partial answer worth showing,
        // and the caller decides what a failed run means for the turn.
        runError = String((event as { message?: string }).message ?? 'the agent reported an error');
        return;
      default:
        return;
    }
  };

  const reader = response.body.getReader();
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
      // SSE, but some servers stream bare JSON lines. Both are read, because refusing the second
      // would mean rejecting working agents over a framing detail.
      const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
      if (!payload || payload === '[DONE]' || payload.startsWith(':') || payload.startsWith('event:') || payload.startsWith('id:')) {
        continue;
      }
      try {
        handle(JSON.parse(payload) as AgUiEvent);
      } catch {
        // An unparseable frame is one frame, not the end of the run.
      }
    }
  }

  clearTimeout(idle);
  options.signal?.removeEventListener('abort', onAbort);

  if (runError && !text.trim() && calls.size === 0) throw new ProviderError(runError);

  return {
    text,
    state,
    toolCalls: order
      .map((id) => calls.get(id))
      .filter((call): call is { id: string; name: string; args: string } => Boolean(call?.name))
      .map((call) => ({ id: call.id, name: call.name, args: parseArgs(call.args) })),
  };
}
