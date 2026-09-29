// What every tool module shares: the context a tool runs in, and the helpers that confine it.
import { spawn } from 'node:child_process';
import { boxHelper, confinementProblem } from '../box.ts';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';
import type { Store } from '../store.ts';
import type { Agent, ApprovalDecision, ApprovalRequest, HaloEvent, Message, SystemEvent } from '../types.ts';
import type { ToolSchema } from '../provider.ts';
import type { MemoryStore } from '../memory.ts';
import type { SkillStore } from '../skills.ts';
// Type-only on the way back (scheduler imports Runner as a type), so this is not a runtime cycle.
import type { Widget } from '../types.ts';

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

export const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
export const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export const MAX_OUTPUT = 24_000;
export function clip(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n... [${text.length - MAX_OUTPUT} more characters truncated]`;
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Nearest ancestor that exists, so a path being created can still be resolved for real. */
export function nearestExisting(p: string): string {
  let cur = p;
  for (let i = 0; i < 64 && !existsSync(cur); i++) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

/** Confines a path to the agent's box; throws when the model tries to escape it. */
export function boxPath(ctx: ToolContext, p: string): string {
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
export const SHELL_ENV_NAMES = [
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

export function htmlToText(html: string): string {
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

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

/** Text, an image the model can look at, or bytes that would only pollute the context. */
export function fileKind(path: string): 'text' | 'image' | 'binary' {
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
