import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync, cpSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Agent, Channel, Message, Routine, Settings, UsageRow } from './types.ts';
import { forgetBox } from './box.ts';
import { omit } from './omit.ts';

// ponytail: flat JSON + JSONL transcripts. One user, a few thousand messages.
// Swap in SQLite only when a single agent's transcript stops fitting in memory.

export const DEFAULT_SETTINGS: Settings = {
  provider: {
    baseUrl: 'http://localhost:8080/v1',
    apiKey: '',
    model: '',
    toolMode: 'native',
    profile: 'auto',
    fallbackModels: [],
    maxSteps: 24,
    helperModel: '',
    contextBudget: 12000,
    vision: true,
    imageBaseUrl: '',
    imageModel: '',
  },
  theme: 'system',
  replyLanguage: 'match',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  localExecution: 'ask',
  autoReview: true,
  autoReviewMode: 'smart',
  policyMode: 'enforce',
  startAtLogin: false,
  onboarded: false,
  minimizeToTray: true,
  rules: [],
  webSearch: { enabled: true, endpoint: 'https://html.duckduckgo.com/html/?q=' },
  n8n: { enabled: false, baseUrl: 'http://localhost:5678', apiKey: '' },
  plugins: [],
  sections: [],
};

/**
 * Encrypts the few fields worth protecting at rest. Supplied by the Electron layer, which has the
 * OS keychain; without one the settings file stays plain, exactly as before.
 */
export interface SecretCodec {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

const SEALED = 'enc:v1:';

/** Conversations kept in memory. Everything is on disk, so eviction only costs a re-read. */
const TRANSCRIPT_CACHE_LIMIT = 12;
/** Tool cards tick several times a second; rewriting the file for each one is the hot spot. */
const FLUSH_DELAY_MS = 200;

export class Store {
  readonly root: string;
  private settings: Settings;
  private agents = new Map<string, Agent>();
  private routines = new Map<string, Routine>();
  private transcripts = new Map<string, Message[]>();
  private llm = new Map<string, Record<string, unknown>[]>();
  private channels = new Map<string, Channel>();
  private dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private secrets: SecretCodec | undefined;

  // Plain fields, not parameter properties: node runs these files by stripping types, and it cannot strip those.
  constructor(root: string, secrets?: SecretCodec) {
    this.root = root;
    this.secrets = secrets;
    mkdirSync(this.agentsDir, { recursive: true });
    this.settings = this.unseal(this.readJson(this.settingsPath, DEFAULT_SETTINGS));
    // merge so new setting keys appear after an upgrade
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...this.settings,
      provider: { ...DEFAULT_SETTINGS.provider, ...this.settings.provider },
      n8n: { ...DEFAULT_SETTINGS.n8n, ...(this.settings.n8n ?? {}) },
    };
    // Seal on the first run that has a keychain, so a key written before this existed does not stay in the clear.
    if (this.secrets && existsSync(this.settingsPath)) this.writeJson(this.settingsPath, this.seal(this.settings));
    for (const r of this.readJson<Routine[]>(this.routinesPath, [])) this.routines.set(r.id, r);
    for (const c of this.readJson<Channel[]>(this.channelsPath, [])) this.channels.set(c.id, c);
    for (const id of this.listAgentIds()) {
      const a = this.readJson<Agent | null>(join(this.agentsDir, id, 'agent.json'), null);
      if (a) this.agents.set(a.id, { ...a, status: 'idle', ...this.unsealAgent(a) });
    }
  }

  get agentsDir() { return join(this.root, 'agents'); }
  private get settingsPath() { return join(this.root, 'settings.json'); }
  private get routinesPath() { return join(this.root, 'routines.json'); }
  private get channelsPath() { return join(this.root, 'channels.json'); }

  agentDir(id: string) { return join(this.agentsDir, id); }
  boxDir(id: string) { return join(this.agentDir(id), 'box'); }
  private transcriptPath(id: string) { return join(this.agentDir(id), 'transcript.jsonl'); }

  private listAgentIds(): string[] {
    if (!existsSync(this.agentsDir)) return [];
    return readdirSync(this.agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  }

  /**
   * Reads a JSON file, and never turns a bad read into a silent permanent loss.
   *
   * The fallback is what keeps the app usable when a file cannot be parsed — but every one of these
   * files is also written back later, so a single unreadable read used to mean the next write
   * overwrote the real data with an empty list, and the only copy was gone. A file that exists and
   * will not parse is moved aside instead: the app starts from the fallback exactly as before, the
   * bytes are still on disk under `<name>.corrupt-<timestamp>`, and the next write lands on a name
   * that is no longer holding anybody's data.
   */
  private readJson<T>(path: string, fallback: T): T {
    if (!existsSync(path)) return fallback;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      // Locked or unreadable right now, which is not the same as damaged: leave it alone.
      return fallback;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      try {
        renameSync(path, `${path}.corrupt-${Date.now()}`);
      } catch {
        /* nothing more to do; the fallback still keeps the app running */
      }
      return fallback;
    }
  }

  /** Write-then-rename: a crash mid-write leaves the old file intact instead of a half-written one. */
  private writeJson(path: string, value: unknown) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmp, path);
  }

  // ---- settings ----
  getSettings(): Settings { return this.settings; }
  saveSettings(next: Partial<Settings>): Settings {
    this.settings = {
      ...this.settings,
      ...next,
      provider: { ...this.settings.provider, ...(next.provider ?? {}) },
      n8n: { ...this.settings.n8n, ...(next.n8n ?? {}) },
    };
    this.writeJson(this.settingsPath, this.seal(this.settings));
    return this.settings;
  }

  private mapSecrets(settings: Settings, fn: (value: string) => string): Settings {
    if (!this.secrets) return settings;
    return {
      ...settings,
      provider: { ...settings.provider, apiKey: fn(settings.provider.apiKey) },
      n8n: { ...settings.n8n, apiKey: fn(settings.n8n?.apiKey ?? '') },
      plugins: settings.plugins.map((plugin) =>
        plugin.env
          ? { ...plugin, env: Object.fromEntries(Object.entries(plugin.env).map(([k, v]) => [k, fn(v)])) }
          : plugin,
      ),
    };
  }

  /** API keys and plugin credentials go to disk sealed; everything else stays readable. */
  private seal(settings: Settings): Settings {
    return this.mapSecrets(settings, (value) => {
      if (!value || value.startsWith(SEALED)) return value;
      try {
        return `${SEALED}${this.secrets!.encrypt(value)}`;
      } catch {
        return value;
      }
    });
  }

  private unseal(settings: Settings): Settings {
    return this.mapSecrets(settings, (value) => {
      if (!value || !value.startsWith(SEALED)) return value;
      try {
        return this.secrets!.decrypt(value.slice(SEALED.length));
      } catch {
        // A key sealed on another machine or profile cannot be recovered; an empty one asks to be re-entered.
        return '';
      }
    });
  }

  // ---- agents ----
  listAgents(): Agent[] {
    return [...this.agents.values()].sort(
      (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.lastActivityAt - a.lastActivityAt,
    );
  }

  /** A copy with the same profile, settings and skills but a fresh, empty history. */
  duplicateAgent(id: string): Agent | undefined {
    const source = this.agents.get(id);
    if (!source) return undefined;
    const copy = this.createAgent({
      name: `${source.name} copy`,
      title: source.title,
      description: source.description,
      avatar: source.avatar,
      notifications: source.notifications,
      ...(source.model ? { model: source.model } : {}),
      ...(source.localExecution ? { localExecution: source.localExecution } : {}),
      ...(source.allowedPaths ? { allowedPaths: [...source.allowedPaths] } : {}),
      ...(source.personaId ? { personaId: source.personaId } : {}),
      ...(source.persona ? { persona: source.persona } : {}),
    });
    try {
      cpSync(join(this.agentDir(id), 'skills'), join(this.agentDir(copy.id), 'skills'), { recursive: true });
    } catch { /* no skills to carry over */ }
    return copy;
  }
  getAgent(id: string): Agent | undefined { return this.agents.get(id); }

  createAgent(input: Partial<Agent> & { name: string }): Agent {
    const id = input.id ?? randomUUID();
    const agent: Agent = {
      id,
      name: input.name,
      title: input.title ?? '',
      description: input.description ?? '',
      avatar: input.avatar ?? { color: 'blue', face: 0 },
      notifications: input.notifications ?? true,
      createdAt: Date.now(),
      status: 'idle',
      lastActivityAt: Date.now(),
      // carried through so an imported or duplicated bot keeps its model and its permissions
      ...(input.model ? { model: input.model } : {}),
      ...(input.localExecution ? { localExecution: input.localExecution } : {}),
      ...(input.allowedPaths?.length ? { allowedPaths: [...input.allowedPaths] } : {}),
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
      ...(input.endpointAuth ? { endpointAuth: input.endpointAuth } : {}),
      ...(input.personaId ? { personaId: input.personaId } : {}),
      ...(input.persona ? { persona: input.persona } : {}),
      ...(input.pinned ? { pinned: true } : {}),
      ...(input.hidden ? { hidden: true } : {}),
    };
    mkdirSync(this.boxDir(id), { recursive: true });
    this.agents.set(id, agent);
    this.persistAgent(agent);
    return agent;
  }

  updateAgent(id: string, patch: Partial<Agent>): Agent | undefined {
    const cur = this.agents.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    this.agents.set(id, next);
    this.persistAgent(next);
    return next;
  }

  deleteAgent(id: string) {
    this.dirty.delete(id);
    this.agents.delete(id);
    this.transcripts.delete(id);
    // Its model history too, including the per-room copies. A cached one left behind would be written
    // back out by the next append and recreate the folder this call is deleting.
    for (const key of [...this.llm.keys()]) if (key === id || key.startsWith(`${id}#`)) this.llm.delete(key);
    for (const r of [...this.routines.values()]) if (r.agentId === id) this.routines.delete(r.id);
    this.saveRoutines();
    forgetBox(this.boxDir(id));
    rmSync(this.agentDir(id), { recursive: true, force: true });
  }

  private persistAgent(agent: Agent) {
    mkdirSync(this.agentDir(agent.id), { recursive: true });
    const rest = omit(agent, 'status');
    // The endpoint's Authorization header is a credential like any other: sealed before it reaches
    // disk, and re-sealed on every write so one written before a keychain existed does not stay clear.
    this.writeJson(join(this.agentDir(agent.id), 'agent.json'), { ...rest, ...this.sealAgent(rest) });
  }

  private sealAgent(agent: Partial<Agent>): Partial<Agent> {
    const value = agent.endpointAuth;
    if (!this.secrets || !value || value.startsWith(SEALED)) return {};
    try {
      return { endpointAuth: `${SEALED}${this.secrets.encrypt(value)}` };
    } catch {
      return {};
    }
  }

  private unsealAgent(agent: Partial<Agent>): Partial<Agent> {
    const value = agent.endpointAuth;
    if (!this.secrets || !value || !value.startsWith(SEALED)) return {};
    try {
      return { endpointAuth: this.secrets.decrypt(value.slice(SEALED.length)) };
    } catch {
      // Sealed on another machine or profile: unrecoverable, and an empty one asks to be re-entered.
      return { endpointAuth: '' };
    }
  }

  touchAgent(id: string) {
    const a = this.agents.get(id);
    if (a) { a.lastActivityAt = Date.now(); this.persistAgent(a); }
  }

  // ---- transcript ----
  private parseTranscript(path: string): Message[] {
    const out: Message[] = [];
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as Message); } catch { /* skip torn line */ }
    }
    return out;
  }

  transcript(agentId: string): Message[] {
    const cached = this.transcripts.get(agentId);
    if (cached) {
      // touch for LRU: re-inserting moves the key to the end of the Map's order
      this.transcripts.delete(agentId);
      this.transcripts.set(agentId, cached);
      return cached;
    }
    const out = this.parseTranscript(this.transcriptPath(agentId));
    this.transcripts.set(agentId, out);
    this.evictTranscripts();
    return out;
  }

  private evictTranscripts() {
    while (this.transcripts.size > TRANSCRIPT_CACHE_LIMIT) {
      const oldest = [...this.transcripts.keys()].find((id) => !this.dirty.has(id));
      if (!oldest) return;
      this.transcripts.delete(oldest);
    }
  }

  appendMessage(msg: Message): Message {
    const list = this.transcript(msg.agentId);
    list.push(msg);
    mkdirSync(this.agentDir(msg.agentId), { recursive: true });
    appendFileSync(this.transcriptPath(msg.agentId), `${JSON.stringify(msg)}\n`, 'utf8');
    if (this.agents.has(msg.agentId)) this.touchAgent(msg.agentId);
    else if (this.channels.has(msg.agentId)) this.touchChannel(msg.agentId);
    return msg;
  }

  /**
   * Patches a message in place. The file rewrite is coalesced, because a running tool card ticks
   * several times a second and each rewrite costs the whole transcript.
   * ponytail: 200ms of tool-card status is the most a crash can lose; move to SQLite if that stops being true.
   */
  updateMessage(agentId: string, messageId: string, patch: Partial<Message>) {
    const list = this.transcript(agentId);
    const i = list.findIndex((m) => m.id === messageId);
    if (i < 0) return;
    list[i] = { ...list[i]!, ...patch };
    this.dirty.add(agentId);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  /** Writes out every coalesced transcript patch. Safe to call at any time. */
  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const id of this.dirty) this.rewriteTranscript(id);
    this.dirty.clear();
  }

  private rewriteTranscript(conversationId: string) {
    const list = this.transcripts.get(conversationId);
    if (!list) return;
    mkdirSync(this.agentDir(conversationId), { recursive: true });
    writeFileSync(this.transcriptPath(conversationId), list.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
  }

  // ---- usage ----
  private get usagePath() { return join(this.root, 'usage.jsonl'); }

  recordUsage(row: UsageRow) {
    if (row.promptTokens === 0 && row.completionTokens === 0) return;
    appendFileSync(this.usagePath, `${JSON.stringify(row)}\n`, 'utf8');
  }

  usage(sinceMs: number): UsageRow[] {
    if (!existsSync(this.usagePath)) return [];
    const rows: UsageRow[] = [];
    for (const line of readFileSync(this.usagePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as UsageRow;
        if (row.at >= sinceMs) rows.push(row);
      } catch { /* skip torn line */ }
    }
    return rows;
  }

  deleteMessage(conversationId: string, messageId: string) {
    const list = this.transcript(conversationId).filter((m) => m.id !== messageId);
    this.transcripts.set(conversationId, list);
    this.dirty.delete(conversationId);
    this.rewriteTranscript(conversationId);
  }

  /**
   * Full-text scan across every conversation. Reads straight from disk for anything not already
   * open, so searching does not pull every transcript into memory for good.
   */
  search(query: string, limit = 40): { conversationId: string; message: Message }[] {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    const ids = [...this.agents.keys(), ...this.channels.keys()];
    const hits: { conversationId: string; message: Message }[] = [];
    for (const id of ids) {
      const messages = this.transcripts.get(id) ?? this.parseTranscript(this.transcriptPath(id));
      for (const message of messages) {
        if (!message.text.toLowerCase().includes(needle)) continue;
        hits.push({ conversationId: id, message });
        if (hits.length >= limit * 4) break;
      }
    }
    return hits.sort((a, b) => b.message.createdAt - a.message.createdAt).slice(0, limit);
  }

  // ---- raw model conversation (tool calls need to survive restarts intact) ----
  private llmPath(id: string, suffix?: string) {
    return join(this.agentDir(id), suffix ? `llm-${suffix}.jsonl` : 'llm.jsonl');
  }

  llmHistory(agentId: string, suffix?: string): Record<string, unknown>[] {
    const key = suffix ? `${agentId}#${suffix}` : agentId;
    const cached = this.llm.get(key);
    if (cached) return cached;
    const out: Record<string, unknown>[] = [];
    const path = this.llmPath(agentId, suffix);
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
      }
    }
    this.llm.set(key, out);
    return out;
  }

  /** Replaces a conversation's model history, used after compaction. */
  replaceLlmHistory(agentId: string, messages: Record<string, unknown>[], suffix?: string) {
    const key = suffix ? `${agentId}#${suffix}` : agentId;
    this.llm.set(key, [...messages]);
    mkdirSync(this.agentDir(agentId), { recursive: true });
    writeFileSync(this.llmPath(agentId, suffix), messages.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
  }

  appendLlm(agentId: string, msg: Record<string, unknown>, suffix?: string) {
    this.llmHistory(agentId, suffix).push(msg);
    mkdirSync(this.agentDir(agentId), { recursive: true });
    appendFileSync(this.llmPath(agentId, suffix), `${JSON.stringify(msg)}\n`, 'utf8');
  }

  // ---- channels ----
  listChannels(): Channel[] {
    return [...this.channels.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  getChannel(id: string): Channel | undefined { return this.channels.get(id); }

  createChannel(name: string, memberIds: string[]): Channel {
    const channel: Channel = {
      id: randomUUID(),
      name: name.trim() || 'New channel',
      memberIds: [...new Set(memberIds)],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    mkdirSync(this.agentDir(channel.id), { recursive: true });
    this.channels.set(channel.id, channel);
    this.saveChannels();
    return channel;
  }

  updateChannel(id: string, patch: Partial<Channel>): Channel | undefined {
    const cur = this.channels.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    this.channels.set(id, next);
    this.saveChannels();
    return next;
  }

  deleteChannel(id: string) {
    this.dirty.delete(id);
    this.channels.delete(id);
    this.transcripts.delete(id);
    this.saveChannels();
    rmSync(this.agentDir(id), { recursive: true, force: true });
  }

  touchChannel(id: string) {
    const c = this.channels.get(id);
    if (c) { c.lastActivityAt = Date.now(); this.saveChannels(); }
  }

  private saveChannels() { this.writeJson(this.channelsPath, [...this.channels.values()]); }

  // ---- routines ----
  listRoutines(): Routine[] { return [...this.routines.values()]; }
  getRoutine(id: string): Routine | undefined { return this.routines.get(id); }
  saveRoutine(r: Routine): Routine {
    this.routines.set(r.id, r);
    this.saveRoutines();
    return r;
  }
  deleteRoutine(id: string) { this.routines.delete(id); this.saveRoutines(); }
  private saveRoutines() { this.writeJson(this.routinesPath, [...this.routines.values()]); }
}
