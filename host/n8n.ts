/**
 * The user's own n8n, as five tools.
 *
 * WHY N8N AND NOT A CONNECTOR PER VENDOR. Halo will never have a Google Calendar tool, a Notion tool
 * and a Shopify tool that are all as good as the real ones. A lot of people already keep those
 * integrations in an n8n instance, wired up and authorised. A bot that can read, write and fire an
 * n8n workflow inherits every service the user has already connected, and the credentials stay in
 * n8n rather than arriving in this app.
 *
 * WHAT IS GATED AND WHAT IS NOT. Listing and reading workflows is a read of the user's own service,
 * like fetching a page — no prompt. Writing one, activating one and firing one go through the
 * approval gate on the `automation` surface, because a workflow keeps running after the turn ends
 * and can reach everything n8n is connected to. That asymmetry is the whole design: a bot can look
 * at the automations freely and cannot change them quietly.
 *
 * ponytail: the public REST API and one webhook POST, no websocket and no execution streaming. If a
 * bot ever needs to watch a run rather than start it, that wants n8n's own event stream, not polling
 * harder here.
 */
import type { Settings } from './types.ts';
import { omit } from './omit.ts';

export interface N8nSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
}

export class N8nError extends Error {}

/** The base with any trailing slash and any accidental `/api/v1` removed, so callers can add it once. */
export function n8nRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

function assertReady(n8n: N8nSettings | undefined): asserts n8n is N8nSettings {
  if (!n8n?.enabled || !n8n.baseUrl.trim()) {
    throw new N8nError(
      'n8n is not connected. The user turns it on in Settings → General → Automation and gives Halo the ' +
        'address of their n8n and an API key from n8n → Settings → n8n API.',
    );
  }
}

async function api(
  n8n: N8nSettings,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<unknown> {
  const url = `${n8nRoot(n8n.baseUrl)}/api/v1${path}`;
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(n8n.apiKey.trim() ? { 'X-N8N-API-KEY': n8n.apiKey.trim() } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    // n8n answers 401 with an HTML login page when the key is missing, which reads as nonsense in a
    // tool result; name the likely cause instead of pasting the page.
    if (response.status === 401 || response.status === 403) {
      throw new N8nError('n8n refused the API key. Check Settings → General → Automation against n8n → Settings → n8n API.');
    }
    throw new N8nError(`n8n answered ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new N8nError(`n8n answered with something that is not JSON: ${text.slice(0, 200)}`);
  }
}

interface WorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  updatedAt?: string;
  tags?: { name?: string }[];
  nodes?: { type?: string; name?: string; parameters?: Record<string, unknown> }[];
}

/** Every workflow, one line each. What a bot reads before it decides which one to touch. */
export async function listWorkflows(settings: Settings, signal?: AbortSignal): Promise<string> {
  assertReady(settings.n8n);
  const result = (await api(settings.n8n, '?limit=100'.replace('?', '/workflows?'), { ...(signal ? { signal } : {}) })) as {
    data?: WorkflowSummary[];
  };
  const rows = result.data ?? [];
  if (rows.length === 0) return 'There are no workflows on that n8n yet.';
  return rows
    .map((w) => {
      const tags = (w.tags ?? []).map((t) => t.name).filter(Boolean).join(', ');
      return `- ${w.name} (id ${w.id})${w.active ? ' [active]' : ' [inactive]'}${tags ? ` — ${tags}` : ''}`;
    })
    .join('\n');
}

/** One workflow, as JSON. A bot reads this before editing so it changes rather than replaces. */
export async function getWorkflow(settings: Settings, id: string, signal?: AbortSignal): Promise<string> {
  assertReady(settings.n8n);
  const workflow = (await api(settings.n8n, `/workflows/${encodeURIComponent(id)}`, {
    ...(signal ? { signal } : {}),
  })) as Record<string, unknown>;
  return JSON.stringify(workflow, null, 2);
}

/**
 * Creates or replaces a workflow.
 *
 * n8n's create endpoint refuses fields it considers read-only (`active`, `id`, `tags`, `createdAt`),
 * so they are stripped rather than passed through — a model that copied a workflow it had just read
 * would otherwise get a 400 it cannot diagnose.
 */
export async function saveWorkflow(
  settings: Settings,
  input: { workflowId?: string; name?: string; workflow: string },
  signal?: AbortSignal,
): Promise<string> {
  assertReady(settings.n8n);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input.workflow) as Record<string, unknown>;
  } catch (error) {
    throw new N8nError(`The workflow is not valid JSON: ${String((error as Error).message).slice(0, 160)}`);
  }
  // n8n rejects its own read-only fields on create, so a pasted export is stripped of them.
  const rest = omit(parsed, 'id', 'active', 'tags', 'createdAt', 'updatedAt', 'versionId');
  const body = {
    name: input.name?.trim() || (typeof parsed.name === 'string' ? parsed.name : 'Untitled workflow'),
    nodes: rest.nodes ?? [],
    connections: rest.connections ?? {},
    settings: rest.settings ?? {},
  };
  const saved = (await api(
    settings.n8n,
    input.workflowId ? `/workflows/${encodeURIComponent(input.workflowId)}` : '/workflows',
    { method: input.workflowId ? 'PUT' : 'POST', body, ...(signal ? { signal } : {}) },
  )) as { id?: string; name?: string };
  return `${input.workflowId ? 'Updated' : 'Created'} "${saved.name ?? body.name}" (id ${saved.id ?? input.workflowId}). ` +
    'It is inactive until you activate it.';
}

export async function activateWorkflow(settings: Settings, id: string, active: boolean, signal?: AbortSignal): Promise<string> {
  assertReady(settings.n8n);
  await api(settings.n8n, `/workflows/${encodeURIComponent(id)}/${active ? 'activate' : 'deactivate'}`, {
    method: 'POST',
    ...(signal ? { signal } : {}),
  });
  return `${active ? 'Activated' : 'Deactivated'} workflow ${id}.`;
}

/** The last executions, newest first, so a bot can say whether the thing it built actually ran. */
export async function listExecutions(settings: Settings, workflowId: string | undefined, signal?: AbortSignal): Promise<string> {
  assertReady(settings.n8n);
  const query = workflowId ? `?limit=20&workflowId=${encodeURIComponent(workflowId)}` : '?limit=20';
  const result = (await api(settings.n8n, `/executions${query}`, { ...(signal ? { signal } : {}) })) as {
    data?: { id?: string | number; status?: string; startedAt?: string; workflowId?: string }[];
  };
  const rows = result.data ?? [];
  if (rows.length === 0) return 'No executions recorded.';
  return rows.map((e) => `- ${e.startedAt ?? '?'} ${e.status ?? '?'} (execution ${e.id}, workflow ${e.workflowId})`).join('\n');
}

/**
 * Fires a workflow by calling its webhook.
 *
 * n8n's public API deliberately has no "run this workflow" endpoint — a workflow is started by its
 * trigger, and for one a bot can start that means a Webhook node. So this posts to the webhook path,
 * and says so plainly when the workflow has no webhook rather than pretending the API could have
 * done it.
 */
export async function runWorkflow(
  settings: Settings,
  input: { path: string; method?: string; body?: string; test?: boolean },
  signal?: AbortSignal,
): Promise<string> {
  assertReady(settings.n8n);
  const path = input.path.trim().replace(/^\/+/, '');
  if (!path) throw new N8nError('Give the webhook path from the workflow’s Webhook node.');
  const prefix = input.test ? 'webhook-test' : 'webhook';
  const url = /^https?:\/\//i.test(input.path) ? input.path : `${n8nRoot(settings.n8n.baseUrl)}/${prefix}/${path}`;
  const method = (input.method ?? 'POST').toUpperCase();
  const response = await fetch(url, {
    method,
    ...(method === 'GET' || !input.body
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: input.body }),
    ...(signal ? { signal } : {}),
  });
  const text = await response.text();
  if (response.status === 404) {
    return `n8n has no webhook at ${url}. A workflow only answers on its production webhook once it is active; ` +
      'while you are testing, set test: true and press "Test workflow" in n8n first.';
  }
  return `${response.status} ${response.statusText}\n${text.slice(0, 4000) || '(no body)'}`;
}

/** One line for SelfCheck: is the configured n8n actually there. */
export async function probeN8n(settings: Settings): Promise<{ ok: boolean; detail: string }> {
  if (!settings.n8n?.enabled) return { ok: true, detail: 'not connected' };
  try {
    const result = (await api(settings.n8n, '/workflows?limit=1')) as { data?: unknown[] };
    return { ok: true, detail: `${n8nRoot(settings.n8n.baseUrl)} answered (${(result.data ?? []).length ? 'has workflows' : 'no workflows yet'})` };
  } catch (error) {
    return { ok: false, detail: String((error as Error).message).slice(0, 160) };
  }
}
