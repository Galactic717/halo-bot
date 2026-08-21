import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolSchema } from './provider.ts';

export interface McpServerSpec {
  id: string;
  name: string;
  description: string;
  category: string;
  command: string;
  args: string[];
  /** Env vars the server needs; the user fills them in when installing. */
  requires?: { key: string; label: string }[];
  /** Filled from the user's answers at install time. */
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface McpServerStatus {
  id: string;
  name: string;
  state: 'stopped' | 'starting' | 'ready' | 'error';
  toolCount: number;
  error?: string;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const START_TIMEOUT_MS = 30_000;

/** One MCP server over stdio, speaking newline-delimited JSON-RPC 2.0. */
class McpClient {
  private spec: McpServerSpec;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  tools: McpTool[] = [];
  state: McpServerStatus['state'] = 'stopped';
  error?: string;

  constructor(spec: McpServerSpec) {
    this.spec = spec;
  }

  async start(): Promise<void> {
    if (this.state === 'ready' || this.state === 'starting') return;
    this.state = 'starting';
    delete this.error;
    try {
      const launch = resolveLaunch(this.spec);
      this.child = spawn(launch.file, launch.args, {
        env: { ...process.env, ...launch.env, ...(this.spec.env ?? {}) },
        windowsHide: true,
        ...(launch.shell ? { shell: true } : {}),
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      this.fail(String((error as Error).message ?? error));
      return;
    }

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      // Servers chat on stderr; only remember it if we end up failing.
      this.error = String(chunk).slice(-400);
    });
    this.child.on('exit', (code) => {
      if (this.state !== 'error') this.fail(`server exited with code ${code}`);
    });
    this.child.on('error', (err) => this.fail(String(err.message)));

    try {
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'Halo Bot', version: '0.1.0' },
      });
      this.notify('notifications/initialized', {});
      const listed = (await this.request('tools/list', {})) as { tools?: McpTool[] };
      this.tools = listed.tools ?? [];
      this.state = 'ready';
    } catch (error) {
      this.fail(String((error as Error).message ?? error));
    }
  }

  private fail(message: string) {
    this.state = 'error';
    this.error = message;
    for (const [, pending] of this.pending) pending.reject(new Error(message));
    this.pending.clear();
  }

  stop() {
    this.child?.kill();
    this.child = null;
    this.state = 'stopped';
    this.tools = [];
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const id = message.id as number | undefined;
      if (id === undefined) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error).slice(0, 300)));
      else pending.resolve(message.result);
    }
  }

  private send(payload: Record<string, unknown>) {
    this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private notify(method: string, params: Record<string, unknown>) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = START_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // The timer is cleared on the way out; otherwise every call holds the event loop open for its timeout.
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request('tools/call', { name, arguments: args }, 120_000)) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((part) => (part.type === 'text' ? part.text ?? '' : `[${part.type}]`))
      .join('\n')
      .trim();
    return text || '(no output)';
  }
}

const TOOL_PREFIX = 'mcp__';

/** Owns every installed plugin, starts them on demand and exposes their tools to the bots. */
export class McpManager {
  private clients = new Map<string, McpClient>();
  private getSpecs: () => McpServerSpec[];

  constructor(getSpecs: () => McpServerSpec[]) {
    this.getSpecs = getSpecs;
  }

  private client(spec: McpServerSpec): McpClient {
    let client = this.clients.get(spec.id);
    if (!client) {
      client = new McpClient(spec);
      this.clients.set(spec.id, client);
    }
    return client;
  }

  /** Starts every enabled plugin; safe to call repeatedly. */
  async startAll(): Promise<void> {
    await Promise.all(
      this.getSpecs()
        .filter((spec) => spec.enabled !== false)
        .map((spec) => this.client(spec).start().catch(() => {})),
    );
  }

  stop(id: string) {
    this.clients.get(id)?.stop();
    this.clients.delete(id);
  }

  stopAll() {
    for (const [, client] of this.clients) client.stop();
    this.clients.clear();
  }

  statuses(): McpServerStatus[] {
    return this.getSpecs().map((spec) => {
      const client = this.clients.get(spec.id);
      return {
        id: spec.id,
        name: spec.name,
        state: spec.enabled === false ? 'stopped' : client?.state ?? 'stopped',
        toolCount: client?.tools.length ?? 0,
        // stderr chatter is only interesting when the server actually failed
        ...(client?.state === 'error' && client.error ? { error: client.error } : {}),
      };
    });
  }

  /** Every ready plugin tool, namespaced so it cannot collide with a built-in. */
  toolSchemas(): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const spec of this.getSpecs()) {
      if (spec.enabled === false) continue;
      const client = this.clients.get(spec.id);
      if (!client || client.state !== 'ready') continue;
      for (const tool of client.tools) {
        out.push({
          name: `${TOOL_PREFIX}${spec.id}__${tool.name}`.replace(/[^a-zA-Z0-9_]/g, '_'),
          description: `[${spec.name}] ${tool.description ?? tool.name}`,
          parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        });
      }
    }
    return out;
  }

  isPluginTool(name: string): boolean {
    return name.startsWith(TOOL_PREFIX);
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    for (const spec of this.getSpecs()) {
      const prefix = `${TOOL_PREFIX}${spec.id}__`.replace(/[^a-zA-Z0-9_]/g, '_');
      if (!name.startsWith(prefix)) continue;
      const client = this.client(spec);
      if (client.state !== 'ready') await client.start();
      if (client.state !== 'ready') return `Plugin ${spec.name} is not running: ${client.error ?? 'unknown error'}`;
      const toolName = client.tools.find((t) => `${prefix}${t.name}`.replace(/[^a-zA-Z0-9_]/g, '_') === name)?.name;
      if (!toolName) return `Plugin ${spec.name} has no tool matching ${name}.`;
      return client.callTool(toolName, args);
    }
    return `No plugin owns the tool ${name}.`;
  }
}

const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/**
 * Windows cannot spawn a .cmd without a shell, and a shell means the arguments are concatenated.
 * Running npx's own script through this process's node avoids both problems; the shell is only a fallback.
 */
function resolveLaunch(spec: McpServerSpec): { file: string; args: string[]; env: Record<string, string>; shell: boolean } {
  const isNpx = /^npx(\.cmd)?$/i.test(spec.command);
  if (!isNpx) return { file: spec.command, args: spec.args, env: {}, shell: false };

  const fromPath = (process.env.PATH ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .flatMap((dir) => [
      join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
      join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    ]);

  const candidates = [
    ...(process.env.NPX_CLI_JS ? [process.env.NPX_CLI_JS] : []),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    join(process.env.ProgramFiles ?? '', 'nodejs', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    join(process.execPath, '..', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    ...fromPath,
  ];
  const cli = candidates.find((path) => path && existsSync(path));
  if (!cli) return { file: spec.command, args: spec.args, env: {}, shell: process.platform === 'win32' };

  return { file: process.execPath, args: [cli, ...spec.args], env: { ELECTRON_RUN_AS_NODE: '1' }, shell: false };
}

/** Curated marketplace. Everything here is a real, published MCP server. */
export const MCP_CATALOG: McpServerSpec[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write and search files in folders you choose.',
    category: 'Files',
    command: NPX,
    args: ['-y', '@modelcontextprotocol/server-filesystem', process.env.USERPROFILE ?? '.'],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch a URL and get clean markdown back.',
    category: 'Web',
    command: NPX,
    args: ['-y', 'mcp-server-fetch'],
  },
  {
    id: 'memory',
    name: 'Knowledge Graph',
    description: 'A persistent knowledge graph the bots can write facts and relations into.',
    category: 'Memory',
    command: NPX,
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Structured step-by-step reasoning for harder problems.',
    category: 'Reasoning',
    command: NPX,
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Read history, diffs and blame from local repositories.',
    category: 'Code',
    command: NPX,
    args: ['-y', '@cyanheads/git-mcp-server'],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and edit a local SQLite database.',
    category: 'Data',
    command: NPX,
    args: ['-y', 'mcp-server-sqlite-npx'],
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Drive a full browser with accessibility-tree actions.',
    category: 'Web',
    command: NPX,
    args: ['-y', '@playwright/mcp@latest'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, pull requests and code search on GitHub.',
    category: 'Code',
    command: NPX,
    args: ['-y', '@modelcontextprotocol/server-github'],
    requires: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub personal access token' }],
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web and local search through the Brave API.',
    category: 'Web',
    command: NPX,
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    requires: [{ key: 'BRAVE_API_KEY', label: 'Brave Search API key' }],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read channels and post messages in a Slack workspace.',
    category: 'Communication',
    command: NPX,
    args: ['-y', '@modelcontextprotocol/server-slack'],
    requires: [
      { key: 'SLACK_BOT_TOKEN', label: 'Slack bot token (xoxb-…)' },
      { key: 'SLACK_TEAM_ID', label: 'Slack team id' },
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search, read and update Notion pages and databases.',
    category: 'Docs',
    command: NPX,
    args: ['-y', '@notionhq/notion-mcp-server'],
    requires: [{ key: 'NOTION_API_KEY', label: 'Notion integration token' }],
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Current time and timezone conversion the model can trust.',
    category: 'Utilities',
    command: NPX,
    args: ['-y', 'time-mcp'],
  },
];
