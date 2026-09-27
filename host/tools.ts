import { spawn } from 'node:child_process';
import { boxHelper, confinementProblem } from './box.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, statfsSync, copyFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.ts';
import type { Agent, ApprovalDecision, ApprovalRequest, HaloEvent, Message, Routine, RoutineTrigger, SystemEvent } from './types.ts';
import type { ToolSchema } from './provider.ts';
import type { MemoryStore, MemoryTier } from './memory.ts';
import type { SkillStore } from './skills.ts';
import { REFERENCE_DIR, referenceFiles } from './reference.ts';
import { listModels } from './provider.ts';
import { activateWorkflow, getWorkflow, listExecutions, listWorkflows, probeN8n, runWorkflow, saveWorkflow } from './n8n.ts';
// Type-only on the way back (scheduler imports Runner as a type), so this is not a runtime cycle.
import { clampTrigger, enabledSlot, MIN_INTERVAL_MINUTES } from './scheduler.ts';
import type { Widget } from './types.ts';

export interface ComputerPort {
  ensure(agentId: string): Promise<void>;
  /** Shows the screen to the user so they can sign in or take over. */
  handOver(agentId: string, instruction: string): Promise<void>;
  navigate(agentId: string, url: string): Promise<{ url: string; title: string }>;
  act(agentId: string, action: string, params: Record<string, unknown>): Promise<string>;
  readPage(agentId: string): Promise<string>;
  screenshot(agentId: string): Promise<string>;
  /** The page's controls, each with an opaque ref this process resolves later. */
  snapshot(agentId: string): Promise<string>;
  /** What a ref points at, for the approval card and the audit row. Undefined when it does not resolve. */
  describeRef(agentId: string, ref: string): { role: string; name: string } | undefined;
}

export interface RunnerPort {
  createAgent(input: { name: string; title?: string; description?: string; color?: string; face?: number }): Agent;
  updateAgent(id: string, patch: Partial<Agent>): Agent | undefined;
  deliverToAgent(fromAgentId: string, toAgentId: string, text: string): void;
  postToRoom(channelId: string, fromAgentId: string, text: string): void;
  dispatchSubagent(parentAgentId: string, kind: 'browser' | 'research' | 'shell', description: string, prompt: string): string;
  checkSubagent(id: string): string;
  messageSubagent(id: string, text: string): string;
  stopSubagent(id: string): string;
}

export interface ToolContext {
  agentId: string;
  store: Store;
  emit: (event: HaloEvent) => void;
  sendMessage: (text: string, images?: { path: string; alt?: string }[]) => Message;
  requestApproval: (req: Omit<ApprovalRequest, 'id' | 'createdAt' | 'agentName' | 'question'>) => Promise<ApprovalDecision>;
  systemEvent: (event: SystemEvent) => void;
  computer: ComputerPort;
  runner: RunnerPort;
  signal: AbortSignal;
  memory: MemoryStore;
  skills: SkillStore;
  sendWidget: (widget: Widget) => Message;
  /** Plugin health for SelfCheck. Absent in contexts that have no plugin manager, such as a subagent. */
  pluginStatus?: () => { name: string; state: string; toolCount: number; error?: string }[];
  /** `confined` runs it through the low-integrity box helper, the same as a foreground box command. */
  startBackground: (command: string, cwd: string, confined: boolean) => string;
  awaitBackground: (id: string, timeoutMs: number) => Promise<string>;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  /** A picture the model should actually look at, not just be told about. */
  imagePath?: string;
}

export interface Tool {
  schema: ToolSchema;
  /** Surface used by the approval gate; undefined means never gated. */
  surface?: ApprovalRequest['surface'];
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const MAX_OUTPUT = 24_000;
function clip(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n... [${text.length - MAX_OUTPUT} more characters truncated]`;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Nearest ancestor that exists, so a path being created can still be resolved for real. */
function nearestExisting(p: string): string {
  let cur = p;
  for (let i = 0; i < 64 && !existsSync(cur); i++) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

/** Confines a path to the agent's box; throws when the model tries to escape it. */
function boxPath(ctx: ToolContext, p: string): string {
  const box = ctx.store.boxDir(ctx.agentId);
  mkdirSync(box, { recursive: true });
  const full = isAbsolute(p) ? normalize(p) : resolve(box, p);
  const outside = () =>
    new Error(`Path is outside your box: ${p}. Use ExternalRead/ExternalShell for the user's machine, or CopyToBox first.`);
  if (!isInside(box, full)) throw outside();
  // A junction or symlink planted inside the box would otherwise be a way straight out of it.
  try {
    if (!isInside(realpathSync(box), realpathSync(nearestExisting(full)))) throw outside();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Path is outside your box')) throw error;
    // realpath can fail on a path we are about to create; the textual check above already passed
  }
  return full;
}

/**
 * The environment a command sees.
 *
 * An allow list, not a deny list. This process holds the user's API key and every plugin credential
 * it decrypted at boot, and spreading `process.env` into a child makes `Get-ChildItem env:` print
 * them — a deny list is only the secrets that existed the day it was written. PATH, locale and the
 * proxy variables pass, because a command that cannot find `git`, cannot speak the user's language,
 * or cannot reach the network behind a proxy is not a shell. Lifted from OpenBot's shell, which
 * makes the same argument at more length.
 */
const SHELL_ENV_NAMES = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'COMPUTERNAME', 'LANG', 'LC_ALL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  // Where PowerShell keeps its module analysis; the box helper seeds its own cache from it.
  'PSModuleAnalysisCachePath',
];

export function shellEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of SHELL_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Runs a command, confined when it is the bot's own and it can be.
 *
 * `confined` is the difference between the two shells Halo has. A command in the box runs through
 * `halo-box.exe` at Low integrity inside a job object, so the kernel refuses every write outside the
 * box whatever the command says. A command on the user's machine — `ExternalShell`, already through
 * the approval gate — deliberately does not: the whole point of that surface is to act with the
 * user's own rights, on purpose, once they have said yes.
 *
 * A box command that cannot be confined is not run at all. It used to fall back to plain PowerShell,
 * which handed the bot the user's full rights in exactly the case where the boundary was missing.
 */
export function runShell(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs = 120_000,
  /** The bot's box, when the command is the bot's own: it then runs in that box's AppContainer. */
  box?: { dir: string; network?: boolean },
): Promise<{ code: number; out: string }> {
  const confined = box !== undefined;
  return new Promise((resolveP) => {
    /*
     * A box is Halo's to create; the user's machine is not.
     *
     * This used to `mkdirSync` whatever it was handed. For the box that is right — it may not exist
     * yet on the first command. For `ExternalShell` it is both wrong and broken: a working directory
     * on the user's machine already exists or the command should say so, and creating one that is a
     * drive root throws EPERM, which surfaced as "the tool failed" with no hint of why.
     */
    if (confined) {
      mkdirSync(cwd, { recursive: true });
      const problem = confinementProblem(box.dir, process.resourcesPath);
      if (problem) {
        resolveP({
          code: -1,
          out: `Halo did not run this: ${problem}, and an unconfined box command would run with the user's full rights. Tell the user; reinstalling Halo restores the helper.`,
        });
        return;
      }
    } else if (!existsSync(cwd)) {
      resolveP({ code: -1, out: `No such directory on this machine: ${cwd}` });
      return;
    }
    // stdin is NUL: nobody can type into a bot's shell, so a command that reads input (Read-Host, a
    // REPL, an installer's prompt) gets end-of-file at once instead of hanging until the timeout.
    const base = { cwd, windowsHide: true, env: shellEnvironment() };
    const child = confined
      ? spawn(boxHelper(process.resourcesPath)!, ['--box', box.dir, '--cwd', cwd, ...(box.network ? ['--network'] : []), '--timeout-ms', String(timeoutMs), '--', command], {
          ...base,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
          ...base,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    let out = '';
    const push = (b: Buffer) => {
      out += b.toString('utf8');
      if (out.length > MAX_OUTPUT * 2) out = out.slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => {
      out += `\n[timed out after ${timeoutMs}ms]`;
      child.kill();
    }, timeoutMs);
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolveP({ code: code ?? -1, out });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveP({ code: -1, out: `${out}\n${String(err)}` });
    });
  });
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

/** Text, an image the model can look at, or bytes that would only pollute the context. */
function fileKind(path: string): 'text' | 'image' | 'binary' {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  try {
    const head = readFileSync(path).subarray(0, 4096);
    for (const byte of head) if (byte === 0) return 'binary';
  } catch {
    return 'binary';
  }
  return 'text';
}

export const TOOLS: Tool[] = [
  {
    schema: {
      name: 'SendMessage',
      description:
        'Say something to the user in the chat. This is the ONLY way the user hears from you - plain assistant text is never delivered. Use it to report progress, ask a question, or hand over finished work.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Markdown message shown in the chat.' },
          images: {
            type: 'array',
            description: 'Absolute paths of images to show inside this message. Only paths a tool actually returned.',
            items: { type: 'string' },
          },
        },
        required: ['text'],
      },
    },
    async run(ctx, args) {
      const text = str(args.text).trim();
      const images = (Array.isArray(args.images) ? args.images : [])
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((path) => ({ path: normalize(path) }))
        .filter((image) => existsSync(image.path));
      if (!text && images.length === 0) return { output: 'Nothing sent: text was empty.', isError: true };
      ctx.sendMessage(text, images);
      return { output: images.length ? `Delivered with ${images.length} image(s).` : 'Delivered to the user.' };
    },
  },

  {
    schema: {
      name: 'ReactToMessage',
      description: 'Put an emoji reaction on a message in this chat.',
      parameters: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'Id of the message to react to; omit for the latest user message.' },
          emoji: { type: 'string', description: 'A single emoji.' },
        },
        required: ['emoji'],
      },
    },
    async run(ctx, args) {
      const transcript = ctx.store.transcript(ctx.agentId);
      const target = str(args.message_id)
        ? transcript.find((m) => m.id === str(args.message_id))
        : [...transcript].reverse().find((m) => m.role === 'user');
      if (!target) return { output: 'No such message.', isError: true };
      const reactions = [...(target.reactions ?? []), str(args.emoji)];
      ctx.store.updateMessage(ctx.agentId, target.id, { reactions });
      ctx.emit({ type: 'message.patch', agentId: ctx.agentId, messageId: target.id, reactions });
      return { output: 'Reaction added.' };
    },
  },

  {
    schema: {
      name: 'Shell',
      description:
        "Run a PowerShell command in your box: your own sandboxed folder and shell. Use it for anything scriptable: files, git, python. It cannot see the user's files or other bots' boxes, and it has no network unless the user turned it on for you — use the browser and fetch tools for the web.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: "Directory inside your box. Defaults to the box root." },
          timeout_ms: { type: 'number' },
          background: {
            type: 'boolean',
            description:
              'Set true for anything slow or never-ending (installs, builds, dev servers, watchers). Returns a shell id immediately; you are told when it finishes.',
          },
        },
        required: ['command'],
      },
    },
    surface: 'shell',
    async run(ctx, args) {
      const cwd = str(args.cwd) ? boxPath(ctx, str(args.cwd)) : ctx.store.boxDir(ctx.agentId);
      if (args.background === true) {
        const id = ctx.startBackground(str(args.command), cwd, true);
        return { output: `Started in the background as ${id}. Keep working; you will be told when it finishes.` };
      }
      const box = { dir: ctx.store.boxDir(ctx.agentId), network: ctx.store.getAgent(ctx.agentId)?.boxNetwork === true };
      const { code, out } = await runShell(str(args.command), cwd, ctx.signal, num(args.timeout_ms, 120_000), box);
      return { output: clip(`exit ${code}\n${out || '(no output)'}`), isError: code !== 0 };
    },
  },

  {
    schema: {
      name: 'Read',
      description: 'Read a text file from your box.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
        required: ['path'],
      },
    },
    async run(ctx, args) {
      const p = boxPath(ctx, str(args.path));
      if (!existsSync(p)) return { output: `No such file: ${str(args.path)}`, isError: true };

      // An image is something to look at, not to read; other binaries would only pollute the context.
      const kind = fileKind(p);
      if (kind === 'image') return { output: `${basename(p)} is an image. Look at it below.`, imagePath: p };
      if (kind === 'binary') {
        return { output: `${basename(p)} is a binary file (${statSync(p).size} bytes). Use Shell to inspect it.`, isError: true };
      }

      const lines = readFileSync(p, 'utf8').split('\n');
      const offset = Math.max(0, num(args.offset, 0));
      const limit = num(args.limit, 800);
      const slice = lines.slice(offset, offset + limit).map((l, i) => `${offset + i + 1}\t${l}`);
      return { output: clip(slice.join('\n')) };
    },
  },

  {
    schema: {
      name: 'Write',
      description: 'Create or overwrite a file in your box.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
    async run(ctx, args) {
      const p = boxPath(ctx, str(args.path));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, str(args.content), 'utf8');
      return { output: `Wrote ${str(args.content).length} characters to ${relative(ctx.store.boxDir(ctx.agentId), p) || basename(p)}` };
    },
  },

  {
    schema: {
      name: 'Edit',
      description: 'Replace an exact string inside a file in your box.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    async run(ctx, args) {
      const p = boxPath(ctx, str(args.path));
      if (!existsSync(p)) return { output: `No such file: ${str(args.path)}`, isError: true };
      const cur = readFileSync(p, 'utf8');
      const old = str(args.old_string);
      if (!cur.includes(old)) return { output: 'old_string not found in the file.', isError: true };
      writeFileSync(p, cur.replace(old, str(args.new_string)), 'utf8');
      return { output: 'Edited.' };
    },
  },

  {
    schema: {
      name: 'ListFiles',
      description: 'List files and folders in your box.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
    async run(ctx, args) {
      const p = str(args.path) ? boxPath(ctx, str(args.path)) : ctx.store.boxDir(ctx.agentId);
      if (!existsSync(p)) return { output: 'No such directory.', isError: true };
      const entries = readdirSync(p, { withFileTypes: true }).map((d) => {
        const full = join(p, d.name);
        const size = d.isFile() ? statSync(full).size : 0;
        return d.isDirectory() ? `${d.name}/` : `${d.name} (${size} B)`;
      });
      return { output: entries.join('\n') || '(empty)' };
    },
  },

  {
    schema: {
      name: 'ExternalShell',
      description:
        "Run a PowerShell command on the USER'S computer, outside your box. Needs the user's approval. Use it only when the work has to happen on their machine.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          reason: { type: 'string', description: 'Why this has to run on their machine.' },
          timeout_ms: { type: 'number' },
        },
        required: ['command'],
      },
    },
    surface: 'external_shell',
    async run(ctx, args) {
      const cwd = str(args.cwd) || process.env.USERPROFILE || 'C:/';
      const { code, out } = await runShell(str(args.command), cwd, ctx.signal, num(args.timeout_ms, 120_000));
      return { output: clip(`exit ${code}\n${out || '(no output)'}`), isError: code !== 0 };
    },
  },

  {
    schema: {
      name: 'ExternalRead',
      description: "Read a file from the USER'S computer (any absolute path). Needs approval.",
      parameters: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'number' } }, required: ['path'] },
    },
    surface: 'external_read',
    async run(_ctx, args) {
      const p = normalize(str(args.path));
      if (!existsSync(p)) return { output: `No such file: ${p}`, isError: true };
      const kind = fileKind(p);
      if (kind === 'image') return { output: `${basename(p)} is an image; look at it below.`, imagePath: p };
      if (kind === 'binary') return { output: `${basename(p)} is a binary file. Use ExternalShell if you need to inspect it.`, isError: true };
      const lines = readFileSync(p, 'utf8').split(/\r?\n/).slice(0, num(args.limit, 800));
      return { output: clip(lines.join('\n')) };
    },
  },

  {
    schema: {
      name: 'CopyToBox',
      description: "Copy a file from the user's computer into your box so you can work on it.",
      parameters: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' } }, required: ['source'] },
    },
    surface: 'external_read',
    async run(ctx, args) {
      const src = normalize(str(args.source));
      if (!existsSync(src)) return { output: `No such file: ${src}`, isError: true };
      const dst = boxPath(ctx, str(args.destination) || basename(src));
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      return { output: `Copied to ${relative(ctx.store.boxDir(ctx.agentId), dst)}` };
    },
  },

  {
    schema: {
      name: 'CopyFromBox',
      description: "Copy a file out of your box onto the user's computer. Needs approval.",
      parameters: { type: 'object', properties: { box_path: { type: 'string' }, destination: { type: 'string' } }, required: ['box_path', 'destination'] },
    },
    surface: 'file_write',
    async run(ctx, args) {
      const src = boxPath(ctx, str(args.box_path));
      if (!existsSync(src)) return { output: 'No such file in your box.', isError: true };
      const dst = normalize(str(args.destination));
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      return { output: `Copied to ${dst}` };
    },
  },

  {
    schema: {
      name: 'WebSearch',
      description: 'Search the web and get back result titles, urls and snippets.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    async run(ctx, args) {
      const settings = ctx.store.getSettings();
      if (!settings.webSearch.enabled) return { output: 'Web search is disabled in settings.', isError: true };
      const url = `${settings.webSearch.endpoint}${encodeURIComponent(str(args.query))}`;
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 HaloBot' }, signal: ctx.signal });
      if (!res.ok) return { output: `Search failed: ${res.status}`, isError: true };
      const html = await res.text();
      const out: string[] = [];
      const seen = new Set<string>();
      // Two shapes of the same page: the classed result link, and the bare redirect link it degrades to.
      const patterns = [
        /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
        /<a[^>]+href="(\/\/duckduckgo\.com\/l\/\?uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
      ];
      for (const re of patterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) && out.length < 10) {
          const raw = (m[1] ?? '').replace(/^.*uddg=/, '').split('&')[0] ?? '';
          let url = raw;
          try { url = decodeURIComponent(raw); } catch { /* leave it as sent */ }
          const title = htmlToText(m[2] ?? '');
          if (!url || !title || seen.has(url)) continue;
          seen.add(url);
          out.push(`${out.length + 1}. ${title}\n   ${url}`);
        }
        if (out.length > 0) break;
      }
      if (out.length > 0) return { output: out.join('\n') };
      // No links at all usually means a bot check, not an empty result set. Say which it is.
      const text = htmlToText(html);
      if (/unusual traffic|are you a robot|captcha|challenge/i.test(text)) {
        return {
          output: 'The search engine served a bot check instead of results. Use WebFetch on a specific url, or the Browser tool.',
          isError: true,
        };
      }
      return { output: clip(text.slice(0, 3000)) };
    },
  },

  {
    schema: {
      name: 'WebFetch',
      description: 'Fetch a url and return its readable text.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
    async run(ctx, args) {
      const res = await fetch(str(args.url), { headers: { 'user-agent': 'Mozilla/5.0 HaloBot' }, signal: ctx.signal });
      if (!res.ok) return { output: `Fetch failed: ${res.status} ${res.statusText}`, isError: true };
      const type = res.headers.get('content-type') ?? '';
      const body = await res.text();
      return { output: clip(type.includes('html') ? htmlToText(body) : body) };
    },
  },

  {
    schema: {
      name: 'Browser',
      description:
        'Drive the browser on your computer - this is how you use websites and apps the user is already signed into. Actions: navigate, read, snapshot, click, type, press, scroll, back, screenshot. Take a snapshot before you click or type: it lists the controls on the page with a ref each, and acting by ref is what makes the action land on the thing you actually saw.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['navigate', 'read', 'snapshot', 'click', 'type', 'press', 'scroll', 'back', 'screenshot'] },
          url: { type: 'string' },
          ref: { type: 'string', description: 'A ref from the last snapshot, e.g. "e12". Preferred over selector.' },
          selector: { type: 'string', description: 'CSS selector, or visible text. Only when you have no ref.' },
          text: { type: 'string' },
          key: { type: 'string' },
          amount: { type: 'number' },
        },
        required: ['action'],
      },
    },
    surface: 'browser',
    async run(ctx, args) {
      const action = str(args.action, 'read');
      await ctx.computer.ensure(ctx.agentId);
      if (action === 'navigate') {
        const r = await ctx.computer.navigate(ctx.agentId, str(args.url));
        return { output: `Now on ${r.title} - ${r.url}` };
      }
      if (action === 'read') return { output: clip(await ctx.computer.readPage(ctx.agentId)) };
      if (action === 'snapshot') return { output: clip(await ctx.computer.snapshot(ctx.agentId)) };
      if (action === 'screenshot') {
        const path = await ctx.computer.screenshot(ctx.agentId);
        return { output: `Screenshot saved to ${path}`, imagePath: path };
      }
      return { output: clip(await ctx.computer.act(ctx.agentId, action, args)) };
    },
  },

  {
    schema: {
      name: 'Screenshot',
      // It captures the browser view and nothing else. The old wording said "your computer's screen",
      // which invited a bot to promise the user a look at their desktop and then hand them a web page.
      description: 'Take a picture of the page your browser is showing and save it into your box. This is your browser, not the user\'s desktop — Halo never captures that.',
      parameters: { type: 'object', properties: {} },
    },
    async run(ctx) {
      await ctx.computer.ensure(ctx.agentId);
      const path = await ctx.computer.screenshot(ctx.agentId);
      return { output: `Screenshot saved to ${path}`, imagePath: path };
    },
  },

  {
    schema: {
      name: 'GenerateImage',
      description:
        'Make a picture from a description — an icon, a mockup, an illustration. Never use it to depict a real person or to fake a real photo; to show something real, find and fetch the actual image instead.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          size: { type: 'string', description: 'e.g. 1024x1024' },
        },
        required: ['prompt'],
      },
    },
    async run(ctx, args) {
      const provider = ctx.store.getSettings().provider;
      const base = (provider.imageBaseUrl || '').replace(/\/+$/, '');
      if (!base) {
        return {
          output: 'No image endpoint is configured. Tell the user to set one in Settings → Model if they want generated images.',
          isError: true,
        };
      }
      const res = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
        body: JSON.stringify({
          model: provider.imageModel || 'gpt-image-1',
          prompt: str(args.prompt),
          size: str(args.size, '1024x1024'),
          n: 1,
          response_format: 'b64_json',
        }),
        signal: ctx.signal,
      });
      if (!res.ok) return { output: `Image generation failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300), isError: true };
      const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
      const first = json.data?.[0];
      const dir = join(ctx.store.boxDir(ctx.agentId), 'images');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `image-${Date.now()}.png`);
      if (first?.b64_json) {
        writeFileSync(file, Buffer.from(first.b64_json, 'base64'));
      } else if (first?.url) {
        const bytes = await fetch(first.url, { signal: ctx.signal }).then((r) => r.arrayBuffer());
        writeFileSync(file, Buffer.from(bytes));
      } else {
        return { output: 'The image endpoint returned nothing usable.', isError: true };
      }
      return { output: `Image saved to ${file}. Attach it with SendMessage images: ["${file}"]`, imagePath: file };
    },
  },

  {
    schema: {
      name: 'CreateAgent',
      description: 'Create another bot (a teammate) with its own chat, box and memory.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string', description: 'What this teammate is for.' },
          color: { type: 'string' },
        },
        required: ['name'],
      },
    },
    surface: 'agent_write',
    async run(ctx, args) {
      const agent = ctx.runner.createAgent({
        name: str(args.name),
        title: str(args.title),
        description: str(args.description),
        color: str(args.color, 'purple'),
      });
      ctx.systemEvent({ kind: 'agent', label: 'Created bot', chip: agent.name, chipAgentId: agent.id });
      return { output: `Created bot "${agent.name}" (id ${agent.id}). Use SendToAgent to give it work.` };
    },
  },

  {
    schema: {
      name: 'UpdateAgent',
      description: 'Update your own profile (or another bot): name, title, description.',
      parameters: {
        type: 'object',
        properties: { agent_id: { type: 'string' }, name: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } },
      },
    },
    surface: 'agent_write',
    async run(ctx, args) {
      const id = str(args.agent_id) || ctx.agentId;
      const patch: Partial<Agent> = {};
      if (str(args.name)) patch.name = str(args.name);
      if (typeof args.title === 'string') patch.title = str(args.title);
      if (typeof args.description === 'string') patch.description = str(args.description);
      const next = ctx.runner.updateAgent(id, patch);
      return next ? { output: `Updated ${next.name}.` } : { output: 'No such bot.', isError: true };
    },
  },

  {
    schema: {
      name: 'SendToAgent',
      description:
        'Message another bot, or post into a room you belong to. Asynchronous: it returns right away and wakes them to work in their own chat. Give the id of a bot or of a channel.',
      parameters: { type: 'object', properties: { agent_id: { type: 'string' }, text: { type: 'string' } }, required: ['agent_id', 'text'] },
    },
    async run(ctx, args) {
      const id = str(args.agent_id);
      const channel = ctx.store.getChannel(id);
      if (channel) {
        if (!channel.memberIds.includes(ctx.agentId)) return { output: `You are not in the ${channel.name} room.`, isError: true };
        ctx.runner.postToRoom(channel.id, ctx.agentId, str(args.text));
        ctx.systemEvent({ kind: 'handoff', label: 'Posted to', chip: channel.name });
        return { output: `Posted in ${channel.name}. Everyone in the room sees it.` };
      }

      const target = ctx.store.getAgent(id);
      if (!target) {
        const list = ctx.store.listAgents().map((a) => `${a.name} -> ${a.id}`).join('\n');
        return { output: `No such bot or room. Known bots:\n${list}`, isError: true };
      }
      ctx.runner.deliverToAgent(ctx.agentId, target.id, str(args.text));
      ctx.systemEvent({ kind: 'handoff', label: 'Messaged', chip: target.name, chipAgentId: target.id });
      return { output: `Sent to ${target.name}. They will work on it in their own chat.` };
    },
  },

  {
    schema: {
      name: 'ListAgents',
      description: 'List the other bots on this machine with their ids.',
      parameters: { type: 'object', properties: {} },
    },
    async run(ctx) {
      const list = ctx.store.listAgents().map((a) => `- ${a.name} (${a.id})${a.title ? ` - ${a.title}` : ''} [${a.status}]`);
      return { output: list.join('\n') || 'No other bots yet.' };
    },
  },

  {
    schema: {
      name: 'UpdateMemory',
      description:
        'Write something durable about how the user works, their preferences, or facts you should not have to ask twice. This memory is loaded into every future turn.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'A self-contained statement, e.g. "The user ships on Fridays".' },
          tier: {
            type: 'string',
            enum: ['profile', 'log', 'note'],
            description:
              'profile = who the user is, kept in mind every turn. log = substantive history (default). note = minor detail that fades fast.',
          },
          forget: { type: 'string', description: 'Exact text of a recorded fact to drop. Pair with a fact to correct it.' },
        },
      },
    },
    async run(ctx, args) {
      const forget = str(args.forget);
      const fact = str(args.fact);
      if (forget) ctx.memory.forget(forget);
      if (fact) ctx.memory.add((str(args.tier, 'log') as MemoryTier) || 'log', fact);
      if (!forget && !fact) return { output: 'Give a fact to remember or a fact to forget.', isError: true };
      ctx.systemEvent({ kind: 'memory', label: 'Updated memory', chip: (fact || forget).slice(0, 60) });
      return { output: 'Memory updated.' };
    },
  },

  {
    schema: {
      name: 'CreateRoutine',
      description: 'Save a recurring task for yourself. It fires on a schedule and you run the prompt as if the user had sent it.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          prompt: { type: 'string' },
          every_minutes: { type: 'number', description: `Minutes between runs. ${MIN_INTERVAL_MINUTES} is the shortest Halo allows; anything less is raised to it.` },
          daily_at: { type: 'string', description: 'HH:MM, 24h' },
          weekdays_at: { type: 'string', description: 'HH:MM, Monday to Friday only' },
          weekly_on: { type: 'string', description: 'e.g. "mon 09:00"' },
          webhook: {
            type: 'boolean',
            description:
              'Instead of a schedule, fire when something calls in. Halo returns a loopback URL to give the user; anything that can POST to it starts this routine.',
          },
        },
        required: ['name', 'prompt'],
      },
    },
    surface: 'agent_write',
    async run(ctx, args) {
      const trigger = parseTrigger(args);
      if (!trigger) return { output: 'Give one of every_minutes, daily_at, weekdays_at, weekly_on, or webhook: true.', isError: true };
      const slot = enabledSlot(ctx.store.listRoutines());
      if (!slot.ok) return { output: `${slot.reason} Tell the user, and offer to switch one off.`, isError: true };
      const routine: Routine = {
        id: randomUUID(),
        agentId: ctx.agentId,
        name: str(args.name),
        prompt: str(args.prompt),
        triggers: [trigger],
        enabled: true,
        createdAt: Date.now(),
      };
      ctx.store.saveRoutine(routine);
      ctx.emit({ type: 'routines', routines: ctx.store.listRoutines() });
      ctx.systemEvent({ kind: 'routine', label: 'Created routine', chip: routine.name });
      return { output: `Routine "${routine.name}" saved (${describeTrigger(trigger)}).` };
    },
  },

  {
    schema: {
      name: 'ListRoutines',
      description: 'List your routines.',
      parameters: { type: 'object', properties: {} },
    },
    async run(ctx) {
      const rs = ctx.store.listRoutines().filter((r) => r.agentId === ctx.agentId);
      return {
        output: rs.map((r) => `- ${r.name} [${describeTriggers(r.triggers)}]${r.enabled ? '' : ' (disabled)'} id=${r.id}`).join('\n') || 'No routines.',
      };
    },
  },

  {
    schema: {
      name: 'DeleteRoutine',
      description: 'Delete one of your routines.',
      parameters: { type: 'object', properties: { routine_id: { type: 'string' } }, required: ['routine_id'] },
    },
    surface: 'agent_write',
    async run(ctx, args) {
      ctx.store.deleteRoutine(str(args.routine_id));
      ctx.emit({ type: 'routines', routines: ctx.store.listRoutines() });
      return { output: 'Deleted.' };
    },
  },

  {
    schema: {
      name: 'TodoWrite',
      description: 'Keep a visible plan for a longer task. Replaces the current list.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
    async run(ctx, args) {
      const todos = Array.isArray(args.todos) ? (args.todos as { content: string; status: string }[]) : [];
      writeFileSync(join(ctx.store.agentDir(ctx.agentId), 'todos.json'), JSON.stringify(todos, null, 2), 'utf8');
      const rendered = todos
        .map((t) => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'} ${t.content}`)
        .join('\n');
      return { output: rendered || 'Cleared.' };
    },
  },
  {
    schema: {
      name: 'AskUser',
      description:
        'Ask the user a question with buttons instead of prose, when you genuinely need a decision. Their pick comes back as their next message, so this ends your turn — stop after calling it.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'A natural question, exactly as you would say it. Not "pick an option below".' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'string', description: 'What comes back as their reply. Defaults to the label.' },
                style: { type: 'string', enum: ['default', 'primary', 'danger'] },
              },
              required: ['label'],
            },
          },
          allow_custom: { type: 'boolean', description: 'Let them type their own answer too.' },
        },
        required: ['prompt', 'options'],
      },
    },
    async run(ctx, args) {
      const raw = Array.isArray(args.options) ? (args.options as Record<string, unknown>[]) : [];
      const options = raw
        .map((o) => ({
          label: str(o.label),
          value: str(o.value) || str(o.label),
          style: (str(o.style, 'default') as 'default' | 'primary' | 'danger') || 'default',
        }))
        .filter((o) => o.label);
      if (options.length === 0) return { output: 'Give at least one option.', isError: true };
      ctx.sendWidget({ prompt: str(args.prompt), options, allowCustom: args.allow_custom === true });
      return { output: 'Question sent. End your turn now — their answer arrives as the next message.' };
    },
  },

  {
    schema: {
      name: 'SaveSkill',
      description:
        'Save a reusable recipe you can look up later. The description decides when it applies, so write it as "use this when ...". A skill has no schedule — use CreateRoutine for something that should run on its own.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string', description: 'Use this when ...' },
          body: { type: 'string', description: 'The recipe, in markdown.' },
        },
        required: ['name', 'description', 'body'],
      },
    },
    surface: 'agent_write',
    async run(ctx, args) {
      const skill = ctx.skills.write(str(args.name), str(args.description), str(args.body));
      ctx.systemEvent({ kind: 'note', label: 'Saved skill', chip: skill.name });
      return { output: `Saved skill "${skill.name}".` };
    },
  },

  {
    schema: {
      name: 'ReadSkill',
      description: 'Read the full body of one of your saved skills before following it.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    async run(ctx, args) {
      const skill = ctx.skills.read(str(args.name));
      if (!skill) return { output: 'No skill by that name.', isError: true };
      return { output: `# ${skill.name}\n> ${skill.description}\n\n${skill.body}` };
    },
  },

  {
    schema: {
      name: 'DeleteSkill',
      description: 'Delete one of your saved skills.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    surface: 'agent_write',
    async run(ctx, args) {
      return { output: ctx.skills.delete(str(args.name)) ? 'Deleted.' : 'No skill by that name.' };
    },
  },

  {
    schema: {
      name: 'HandOverComputer',
      description:
        "Show the user your screen and ask them to do the one step only they can do — a sign-in, 2FA, a captcha, a payment. You never see their credentials. Say what you need in one short line, then end your turn.",
      parameters: {
        type: 'object',
        properties: { instruction: { type: 'string', description: 'One short line, e.g. "Sign in to your Google account".' } },
        required: ['instruction'],
      },
    },
    async run(ctx, args) {
      await ctx.computer.handOver(ctx.agentId, str(args.instruction));
      ctx.sendMessage(`${str(args.instruction)} — I opened the screen for you. Tell me when you're done and I'll pick it back up.`);
      return { output: 'Handed the screen over. End your turn and wait for the user.' };
    },
  },

  {
    schema: {
      name: 'Task',
      description:
        'Hand a self-contained chunk of work to a background worker and keep going. It runs on its own and reports back to you when it finishes, so never sit and wait for it. Scope it tight: the exact step, the specifics it needs, what "done" looks like, and what to report.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['browser', 'research', 'shell'],
            description: 'browser drives your browser, research searches and reads the web, shell works in your box.',
          },
          description: { type: 'string', description: 'Three to five words naming the job.' },
          prompt: { type: 'string', description: 'The full task, standalone — the worker sees none of this conversation.' },
        },
        required: ['kind', 'description', 'prompt'],
      },
    },
    async run(ctx, args) {
      const kind = str(args.kind, 'research') as 'browser' | 'research' | 'shell';
      const id = ctx.runner.dispatchSubagent(ctx.agentId, kind, str(args.description), str(args.prompt));
      return {
        output: `Dispatched ${id} (${kind}). Keep working; you will be woken with its report. Use CheckSubagent ${id} if it seems stuck.`,
      };
    },
  },

  {
    schema: {
      name: 'CheckSubagent',
      description: 'Look in on a background worker: status, recent actions, and its report so far. Use it to spot a stall, not to poll for completion.',
      parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    },
    async run(ctx, args) {
      return { output: ctx.runner.checkSubagent(str(args.task_id)) };
    },
  },

  {
    schema: {
      name: 'MessageSubagent',
      description:
        'Correct or narrow a background worker that is already running. It reads this before its next step and keeps everything it has done so far — which is why this beats stopping it and dispatching a new one.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' }, text: { type: 'string', description: 'The correction, in one or two sentences.' } },
        required: ['task_id', 'text'],
      },
    },
    async run(ctx, args) {
      return { output: ctx.runner.messageSubagent(str(args.task_id), str(args.text)) };
    },
  },

  {
    schema: {
      name: 'StopSubagent',
      description: 'Abort a background worker that is wedged or no longer needed. Prefer MessageSubagent when it only needs redirecting.',
      parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    },
    async run(ctx, args) {
      return { output: ctx.runner.stopSubagent(str(args.task_id)) };
    },
  },

  {
    schema: {
      name: 'AwaitShell',
      description: 'Wait for a background command you started earlier and read its output.',
      parameters: {
        type: 'object',
        properties: { shell_id: { type: 'string' }, timeout_ms: { type: 'number' } },
        required: ['shell_id'],
      },
    },
    async run(ctx, args) {
      return { output: clip(await ctx.awaitBackground(str(args.shell_id), num(args.timeout_ms, 120_000))) };
    },
  },


  // ---- the user's own automation -------------------------------------------------
  //
  // Halo will never have a Calendar tool, a Notion tool and a Shopify tool that are as good as the
  // real ones. A lot of people already keep those, wired up and authorised, in an n8n instance. A bot
  // that can read, write and fire an n8n workflow inherits every service they have already connected,
  // and the credentials stay in n8n rather than arriving here. See host/n8n.ts.

  {
    schema: {
      name: 'N8nWorkflows',
      description:
        "List the workflows on the user's n8n, with their ids and whether they are active. Read this before " +
        'you touch anything: the id is what every other n8n tool takes.',
      parameters: { type: 'object', properties: {} },
    },
    async run(ctx) {
      return { output: clip(await listWorkflows(ctx.store.getSettings(), ctx.signal)) };
    },
  },

  {
    schema: {
      name: 'N8nWorkflow',
      description:
        'Read one workflow as JSON — its nodes, its connections and its webhook paths. Read it before you edit ' +
        'it, and send the whole thing back to N8nSaveWorkflow so you change it rather than replace it.',
      parameters: { type: 'object', properties: { workflow_id: { type: 'string' } }, required: ['workflow_id'] },
    },
    async run(ctx, args) {
      return { output: clip(await getWorkflow(ctx.store.getSettings(), str(args.workflow_id), ctx.signal)) };
    },
  },

  {
    schema: {
      name: 'N8nSaveWorkflow',
      description:
        "Create a workflow on the user's n8n, or replace an existing one. Needs approval. The workflow is n8n's " +
        'own JSON: nodes and connections. A new one arrives inactive — say so, and let the user activate it.',
      parameters: {
        type: 'object',
        properties: {
          workflow: { type: 'string', description: "The workflow JSON: { name, nodes, connections }." },
          name: { type: 'string', description: 'Overrides the name inside the JSON.' },
          workflow_id: { type: 'string', description: 'Set to replace an existing workflow; omit to create one.' },
        },
        required: ['workflow'],
      },
    },
    surface: 'automation',
    async run(ctx, args) {
      return {
        output: await saveWorkflow(
          ctx.store.getSettings(),
          {
            workflow: str(args.workflow),
            ...(str(args.name) ? { name: str(args.name) } : {}),
            ...(str(args.workflow_id) ? { workflowId: str(args.workflow_id) } : {}),
          },
          ctx.signal,
        ),
      };
    },
  },

  {
    schema: {
      name: 'N8nActivateWorkflow',
      description: 'Turn a workflow on or off. Needs approval: an active workflow keeps running after you stop.',
      parameters: {
        type: 'object',
        properties: { workflow_id: { type: 'string' }, active: { type: 'boolean' } },
        required: ['workflow_id'],
      },
    },
    surface: 'automation',
    async run(ctx, args) {
      return {
        output: await activateWorkflow(ctx.store.getSettings(), str(args.workflow_id), args.active !== false, ctx.signal),
      };
    },
  },

  {
    schema: {
      name: 'N8nRunWorkflow',
      description:
        'Fire a workflow by calling its webhook, and get back what it answered. Needs approval. n8n has no ' +
        '"run this" API — a workflow starts from its trigger — so this only works on one with a Webhook node, ' +
        'and the path is the one that node shows.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The webhook path from the Webhook node, or a full url.' },
          method: { type: 'string', description: 'POST unless the node says otherwise.' },
          body: { type: 'string', description: 'JSON body to send.' },
          test: { type: 'boolean', description: 'Use the test webhook, which needs "Test workflow" pressed in n8n.' },
        },
        required: ['path'],
      },
    },
    surface: 'automation',
    async run(ctx, args) {
      return {
        output: clip(
          await runWorkflow(
            ctx.store.getSettings(),
            {
              path: str(args.path),
              ...(str(args.method) ? { method: str(args.method) } : {}),
              ...(str(args.body) ? { body: str(args.body) } : {}),
              ...(args.test === true ? { test: true } : {}),
            },
            ctx.signal,
          ),
        ),
      };
    },
  },

  {
    schema: {
      name: 'N8nExecutions',
      description: 'Recent executions, newest first — how you check whether the workflow you built actually ran.',
      parameters: { type: 'object', properties: { workflow_id: { type: 'string' } } },
    },
    async run(ctx, args) {
      return {
        output: clip(await listExecutions(ctx.store.getSettings(), str(args.workflow_id) || undefined, ctx.signal)),
      };
    },
  },

  {
    schema: {
      name: 'SelfCheck',
      description:
        'Probe the things that break Halo silently — model server, your box, browser, plugins, disk — and get one PASS/FAIL line each. Run this first when something is wrong, before guessing.',
      parameters: { type: 'object', properties: {} },
    },
    async run(ctx) {
      return { output: await selfCheck(ctx) };
    },
  },
];

/**
 * Halo's answer to Grok Bot's `box-doctor` (docs/GROK_BOT_0.24_0.27_TEARDOWN.md §11.3): one command
 * that probes the handful of things whose failure looks like a dozen unrelated failures, and prints a
 * line per check that a bot can quote to the user instead of speculating.
 */
async function selfCheck(ctx: ToolContext): Promise<string> {
  const lines: string[] = [];
  const say = (ok: boolean, name: string, detail: string) => lines.push(`[selfcheck] ${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  const settings = ctx.store.getSettings();

  // The model server, which is the cause far more often than anything else here.
  const model = settings.provider.model.trim();
  if (!model) {
    say(false, 'model', 'no model chosen — Settings → Model');
  } else {
    try {
      const models = await listModels(settings.provider);
      const known = models.length === 0 || models.includes(model);
      say(known, 'model', known ? `${model} at ${settings.provider.baseUrl}` : `${settings.provider.baseUrl} answers but does not serve ${model}`);
    } catch (error) {
      say(false, 'model', `${settings.provider.baseUrl} unreachable — ${String((error as Error)?.message ?? error).slice(0, 120)}`);
    }
  }

  // The box: writable, and holding the reference docs the bot is told to read.
  const box = ctx.store.boxDir(ctx.agentId);
  try {
    const probe = join(box, `.selfcheck-${randomUUID().slice(0, 8)}`);
    writeFileSync(probe, 'ok', 'utf8');
    rmSync(probe, { force: true });
    say(true, 'box', box);
  } catch (error) {
    say(false, 'box', `cannot write ${box} — ${String((error as Error)?.message ?? error).slice(0, 120)}`);
  }
  const refs = referenceFiles().filter((name) => existsSync(join(box, REFERENCE_DIR, name)));
  say(refs.length === referenceFiles().length, 'reference', refs.length ? `${REFERENCE_DIR}/: ${refs.join(', ')}` : 'missing');

  // Free space, because a box that cannot write fails in a dozen unrelated-looking ways.
  try {
    const fs = statfsSync(box);
    const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3;
    say(freeGb > 1, 'disk', `${freeGb.toFixed(1)} GB free`);
  } catch {
    say(true, 'disk', 'not reported on this volume');
  }

  // The browser view, which is started on demand and can fail long before anyone clicks anything.
  try {
    await ctx.computer.ensure(ctx.agentId);
    say(true, 'browser', 'window ready');
  } catch (error) {
    say(false, 'browser', String((error as Error)?.message ?? error).slice(0, 160));
  }

  // The automation the bots may have been told to use, if the user connected one.
  if (settings.n8n?.enabled) {
    const probe = await probeN8n(settings);
    say(probe.ok, 'n8n', probe.detail);
  }

  const plugins = ctx.pluginStatus?.() ?? [];
  if (plugins.length === 0) {
    say(true, 'plugins', 'none installed');
  } else {
    for (const plugin of plugins) {
      say(plugin.state === 'ready', `plugin:${plugin.name}`, plugin.state === 'ready' ? `${plugin.toolCount} tools` : `${plugin.state}${plugin.error ? ` — ${plugin.error.slice(0, 120)}` : ''}`);
    }
  }

  const failed = lines.filter((l) => l.includes('] FAIL ')).length;
  lines.push(`[selfcheck] SUMMARY ${lines.length - failed} passed, ${failed} failed`);
  return lines.join('\n');
}

export function parseTrigger(args: Record<string, unknown>): RoutineTrigger | null {
  // A webhook routine waits to be called rather than watching the clock; the token is its whole address,
  // so it is generated here and never taken from the model.
  if (args.webhook === true) return { kind: 'webhook', token: randomUUID().replace(/-/g, '') };
  // The floor is applied here rather than trusted to the caller: this is the path a model writes.
  if (typeof args.every_minutes === 'number' && args.every_minutes > 0) {
    return clampTrigger({ kind: 'interval', everyMinutes: args.every_minutes });
  }

  const weekdays = str(args.weekdays_at);
  if (/^\d{1,2}:\d{2}$/.test(weekdays)) {
    const [h, m] = weekdays.split(':');
    return { kind: 'weekdays', hour: Number(h), minute: Number(m) };
  }

  const daily = str(args.daily_at);
  if (/^\d{1,2}:\d{2}$/.test(daily)) {
    const [h, m] = daily.split(':');
    return { kind: 'daily', hour: Number(h), minute: Number(m) };
  }

  const weekly = str(args.weekly_on).toLowerCase();
  const wm = /^(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/.exec(weekly);
  if (wm) {
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    return { kind: 'weekly', weekday: days.indexOf(wm[1]!), hour: Number(wm[2]), minute: Number(wm[3]) };
  }
  return null;
}

export function describeTrigger(t: RoutineTrigger): string {
  if (t.kind === 'webhook') return 'when its webhook is called';
  if (t.kind === 'interval') return `every ${t.everyMinutes} min`;
  const hh = String(t.hour).padStart(2, '0');
  const mm = String(t.minute).padStart(2, '0');
  if (t.kind === 'daily') return `daily at ${hh}:${mm}`;
  if (t.kind === 'weekdays') return `weekdays at ${hh}:${mm}`;
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.weekday]} at ${hh}:${mm}`;
}

export function describeTriggers(triggers: RoutineTrigger[]): string {
  return triggers.map(describeTrigger).join(', ') || 'no schedule';
}

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.schema.name, t]));

// ----------------------------------------------------------------- compact profile

/**
 * What a small model is handed on the wire: enough to do a job end to end in its box and on the web,
 * and a way to find the rest. Forty-odd schemas cost a 4B model ~4.6k tokens of every request and a
 * good part of its attention; routines, teammates, skills and the user's own machine are one FindTool
 * away instead. Grok Build hides its MCP schemas behind a search tool for the same reason.
 */
export const CORE_TOOL_NAMES = [
  'SendMessage',
  'AskUser',
  'Shell',
  'Read',
  'Write',
  'Edit',
  'ListFiles',
  'WebFetch',
  'WebSearch',
  'Browser',
  'UpdateMemory',
] as const;

export const FIND_TOOL: ToolSchema = {
  name: 'FindTool',
  description:
    'Look up tools that are not in your list: routines, teammates, skills, plugins, the user\'s own computer, subagents, images. Returns names, what they do and their arguments. Then call one with UseTool.',
  parameters: { type: 'object', properties: { query: { type: 'string', description: 'What you need, in a few words. Empty lists everything.' } } },
};

export const USE_TOOL: ToolSchema = {
  name: 'UseTool',
  description: 'Call a tool you found with FindTool. It goes through the same approval as any other call.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string' }, args: { type: 'object', description: 'The arguments FindTool listed for it.' } },
    required: ['name'],
  },
};

/** FindTool's answer: the best matches with their arguments, or every name when the query is empty. */
export function findTools(query: string, schemas: ToolSchema[]): string {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (words.length === 0) {
    return `Tools you can call with UseTool:\n${schemas.map((s) => `- ${s.name} — ${s.description.split(/(?<=\.)\s/)[0]?.slice(0, 120)}`).join('\n')}`;
  }
  const scored = schemas
    .map((s) => {
      const hay = `${s.name} ${s.description}`.toLowerCase();
      return { s, score: words.reduce((n, w) => n + (s.name.toLowerCase().includes(w) ? 3 : 0) + (hay.includes(w) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (scored.length === 0) return `Nothing matched "${query}". FindTool with an empty query lists every tool.`;
  return scored
    .map(({ s }) => `${s.name} — ${s.description}\n  args: ${JSON.stringify(s.parameters.properties ?? {})}${(s.parameters.required as string[] | undefined)?.length ? `\n  required: ${(s.parameters.required as string[]).join(', ')}` : ''}`)
    .join('\n\n');
}
