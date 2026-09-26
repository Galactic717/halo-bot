import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { MemoryStore, extractMemories } from './memory.ts';
import { SkillStore } from './skills.ts';
import { runShell } from './tools.ts';
import { chat, classifyProviderError, describeFailure, providerFor, ProviderError, type ChatMessage, type ToolSchema } from './provider.ts';
import { buildSystemPrompt, REPLY_REMINDER } from './prompt.ts';
import { decideDetailed, reviewWithModel, summarize, type Verdict } from './policy.ts';
import { AuditLog } from './audit.ts';
import { runAgUi, type AgUiMessage } from './agui.ts';
import { TOOLS, TOOLS_BY_NAME, describeTriggers, type ComputerPort, type RunnerPort, type Tool, type ToolContext } from './tools.ts';
import type { SubagentKind, SubagentRun } from './subagents.ts';
import { mentionedNames } from './mentions.ts';
import { compactHistory, estimateTokens } from './compaction.ts';
import { fenceContent, fenceToolResult } from './fence.ts';
import { ensureReference } from './reference.ts';
import { McpManager } from './mcp.ts';
import { SUBAGENT_TOOLS, subagentSystemPrompt } from './subagents.ts';
import type { Store } from './store.ts';
import type { Agent, ApprovalDecision, ApprovalRequest, AuditRow, Channel, HaloEvent, Message, SystemEvent, ToolCallRecord, Widget } from './types.ts';

const HISTORY_LIMIT = 80;

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

/** One queued turn. `done` reports the outcome back to whoever scheduled it, e.g. a routine. */
interface QueueItem {
  text: string;
  images: string[];
  done?: (ok: boolean, note?: string) => void;
}

export interface RunnerOptions {
  store: Store;
  computer: ComputerPort;
  emit: (event: HaloEvent) => void;
  notify?: (agent: Agent, message: Message) => void;
  mcp?: McpManager;
}

export class Runner implements RunnerPort {
  private store: Store;
  private computer: ComputerPort;
  private emitEvent: (event: HaloEvent) => void;
  private notify?: (agent: Agent, message: Message) => void;
  private mcp?: McpManager;
  readonly audit: AuditLog;

  private queues = new Map<string, QueueItem[]>();
  private running = new Set<string>();
  private aborts = new Map<string, AbortController>();
  private approvals = new Map<string, PendingApproval>();
  private memories = new Map<string, MemoryStore>();
  private skillStores = new Map<string, SkillStore>();
  private background = new Map<
    string,
    { promise: Promise<{ code: number; out: string }>; done: boolean; command: string; agentId: string; startedAt: number }
  >();
  private subagents = new Map<string, SubagentRun>();
  /** How many bot-to-bot hops a room has taken since the user last spoke. */
  private channelHops = new Map<string, number>();
  /** Run state an AG-UI agent handed back, per conversation, so a graph keeps its place. */
  private remoteState = new Map<string, unknown>();

  constructor(opts: RunnerOptions) {
    this.store = opts.store;
    this.computer = opts.computer;
    this.emitEvent = opts.emit;
    this.notify = opts.notify;
    this.mcp = opts.mcp;
    this.audit = new AuditLog(opts.store.root);
  }

  /**
   * One row on the trail. Written before the action runs, never after it succeeded.
   *
   * An action that was not recorded did not happen, because there is no path that acts without
   * writing the row first. A permitted action that then fails gets its own row rather than an edit
   * to this one: "allowed" and "happened" are different facts, and a reader takes the first for the
   * second unless the trail says otherwise.
   */
  private record(
    agentId: string,
    tool: string,
    surface: AuditRow['surface'],
    action: { summary: string; detail: string; intent?: string },
    outcome: AuditRow['outcome'],
    verdict?: { source: string; matched?: string | null },
    extra: { failure?: string; dryRun?: boolean } = {},
  ) {
    const row = this.audit.write({
      at: Date.now(),
      agentId,
      agentName: this.store.getAgent(agentId)?.name ?? 'a deleted bot',
      tool,
      surface,
      ...(action.intent ? { intent: action.intent } : {}),
      summary: action.summary,
      detail: action.detail,
      outcome,
      source: verdict?.source ?? 'none',
      ...(verdict?.matched ? { matched: verdict.matched } : {}),
      ...(extra.failure ? { failure: extra.failure } : {}),
      ...(extra.dryRun ? { dryRun: true } : {}),
    });
    this.emitEvent({ type: 'audit', row });
  }

  // ---------------------------------------------------------------- public API

  pendingApprovals(): ApprovalRequest[] {
    return [...this.approvals.values()].map((p) => p.request);
  }

  isBusy(agentId: string): boolean {
    return [...this.running].some((key) => parseConversationKey(key).agentId === agentId);
  }

  /** A message the user posted in a channel: every addressed bot answers in the same room. */
  submitChannelMessage(channelId: string, text: string): Message | undefined {
    const channel = this.store.getChannel(channelId);
    if (!channel) return undefined;
    const msg = this.store.appendMessage({
      id: randomUUID(),
      agentId: channelId,
      role: 'user',
      text,
      createdAt: Date.now(),
    });
    this.emitEvent({ type: 'message', message: msg });
    this.channelHops.set(channelId, 0);
    for (const botId of this.addressedMembers(channel, text)) {
      this.enqueue(botId, text, channelId);
    }
    return msg;
  }

  /**
   * A bot posting into a channel. Only an explicit @mention pulls a teammate in, and the room
   * stops after a few hops so two bots cannot volley forever without the user.
   */
  postToChannel(channelId: string, fromAgentId: string, text: string) {
    const channel = this.store.getChannel(channelId);
    if (!channel) return;
    const hops = this.channelHops.get(channelId) ?? 0;
    if (hops >= MAX_CHANNEL_HOPS) return;

    const mentioned = this.mentionedMembers(channel, text).filter((id) => id !== fromAgentId);
    if (mentioned.length === 0) return;

    this.channelHops.set(channelId, hops + 1);
    for (const botId of mentioned) this.enqueue(botId, text, channelId);
  }

  /** @mentions pick the responders; with none, everyone in the room answers. */
  private addressedMembers(channel: Channel, text: string): string[] {
    const mentioned = this.mentionedMembers(channel, text);
    if (mentioned.length > 0) return mentioned;
    return channel.memberIds.filter((id) => this.store.getAgent(id));
  }

  private mentionedMembers(channel: Channel, text: string): string[] {
    const members = channel.memberIds.map((id) => this.store.getAgent(id)).filter((a): a is Agent => Boolean(a));
    const hit = new Set(mentionedNames(members.map((a) => a.name), text));
    return members.filter((a) => hit.has(a.name)).map((a) => a.id);
  }

  /** A message typed by the user. */
  submitUserMessage(agentId: string, text: string, attachments: Message['attachments'] = []): Message {
    const images = (attachments ?? []).filter((a) => IMAGE_TYPES[extname(a.path).toLowerCase()]);
    const msg = this.store.appendMessage({
      id: randomUUID(),
      agentId,
      role: 'user',
      text,
      createdAt: Date.now(),
      attachments,
    });
    this.emitEvent({ type: 'message', message: msg });
    const other = (attachments ?? []).filter((a) => !images.includes(a));
    const attachmentNote = other.length
      ? `\n\nThe user attached: ${other.map((a) => a.path).join(', ')} (on their computer — use ExternalRead or CopyToBox).`
      : '';
    // Images are shown to the model directly rather than described as file paths.
    const inline = this.store.getSettings().provider.vision
      ? images.map((a) => imageDataUrl(a.path)).filter((url): url is string => Boolean(url))
      : [];
    this.enqueue(agentId, `${text}${attachmentNote}`, undefined, inline);
    return msg;
  }

  /** A routine firing, or another bot handing over work. */
  submitSystemTurn(
    agentId: string,
    text: string,
    label: string,
    kind: SystemEvent['kind'] = 'note',
    done?: (ok: boolean, note?: string) => void,
  ) {
    this.systemEvent(agentId, { kind, label, chip: text.replace(/\s+/g, ' ').slice(0, 80) });
    this.enqueue(agentId, `[${label}]\n${text}`, undefined, [], done);
  }

  stop(agentId: string) {
    // An approval nobody will answer would hold the turn open forever, and with it the whole
    // conversation queue. Stopping has to settle it, not just abort the model call.
    for (const [id, pending] of [...this.approvals]) {
      if (pending.request.agentId !== agentId) continue;
      this.approvals.delete(id);
      pending.resolve('never');
      this.emitEvent({ type: 'approval.resolved', id, approved: false });
    }
    for (const [key, controller] of this.aborts) {
      if (parseConversationKey(key).agentId === agentId) controller.abort();
    }
    for (const key of [...this.queues.keys()]) {
      if (parseConversationKey(key).agentId !== agentId) continue;
      for (const item of this.queues.get(key) ?? []) item.done?.(false, 'stopped');
      this.queues.set(key, []);
    }
  }

  resolveApproval(id: string, decision: ApprovalDecision) {
    const pending = this.approvals.get(id);
    if (!pending) return;
    this.approvals.delete(id);
    if (decision === 'always' || decision === 'never') this.rememberDecision(pending.request, decision);
    pending.resolve(decision);
    this.emitEvent({ type: 'approval.resolved', id, approved: decision !== 'never' });
  }

  /**
   * "Always allow" and "Never" are sticky, and scoped to the action that was in front of the user.
   *
   * The old version wrote a rule from the approval line alone, and every ExternalShell approval
   * carried the same line — "Run a command on your computer" — so one "Always allow" matched every
   * later command word for word and became standing permission to run anything on the machine. The
   * rule now carries the surface, the intent, and for a shell the first words of the command, so
   * approving `git status` grants `git`, not the shell.
   */
  private rememberDecision(request: ApprovalRequest, decision: ApprovalDecision) {
    const settings = this.store.getSettings();
    const rule = {
      id: randomUUID(),
      when: request.summary,
      decision: decision === 'always' ? ('allow' as const) : ('deny' as const),
      surface: request.surface,
      ...(request.intent ? { intent: request.intent } : {}),
      ...(request.command ? { commandPrefix: commandPrefixOf(request.command) } : {}),
    };
    const already = settings.rules.some(
      (r) => r.surface === rule.surface && r.commandPrefix === rule.commandPrefix && (r.commandPrefix ? true : r.when === rule.when),
    );
    if (already) return;
    this.store.saveSettings({ rules: [...settings.rules, rule] });
    this.emitEvent({ type: 'settings', settings: this.store.getSettings() });
  }

  /** A muted, centered line in the transcript. */
  systemEvent(agentId: string, event: SystemEvent) {
    const msg = this.store.appendMessage({
      id: randomUUID(),
      agentId,
      role: 'system',
      text: event.label,
      createdAt: Date.now(),
      event,
    });
    this.emitEvent({ type: 'message', message: msg });
    return msg;
  }

  // ------------------------------------------------------------- RunnerPort

  createAgent(input: { name: string; title?: string; description?: string; color?: string; face?: number }): Agent {
    const agent = this.store.createAgent({
      name: input.name,
      title: input.title ?? '',
      description: input.description ?? '',
      avatar: { color: input.color ?? 'blue', face: input.face ?? 0 },
    });
    this.emitEvent({ type: 'agents', agents: this.store.listAgents() });
    return agent;
  }

  updateAgent(id: string, patch: Partial<Agent>): Agent | undefined {
    const next = this.store.updateAgent(id, patch);
    if (next) this.emitEvent({ type: 'agents', agents: this.store.listAgents() });
    return next;
  }

  /** A bot posting into a room it belongs to: the message lands in the transcript for everyone. */
  postToRoom(channelId: string, fromAgentId: string, text: string) {
    const channel = this.store.getChannel(channelId);
    if (!channel) return;
    const message = this.store.appendMessage({
      id: randomUUID(),
      agentId: channelId,
      role: 'agent',
      text,
      createdAt: Date.now(),
      fromAgentId,
    });
    this.emitEvent({ type: 'message', message });
    this.postToChannel(channelId, fromAgentId, text);
  }

  deliverToAgent(fromAgentId: string, toAgentId: string, text: string) {
    const from = this.store.getAgent(fromAgentId);
    const name = from?.name ?? 'another bot';
    this.systemEvent(toAgentId, {
      kind: 'handoff',
      label: 'Message from',
      chip: name,
      ...(from ? { chipAgentId: from.id } : {}),
    });
    // A teammate is another model, which may itself have been talked into something by a page it read.
    // Its message is outside content and arrives fenced, the same as anything a tool brought back.
    this.enqueue(toAgentId, `[Message from ${name}]\n${fenceContent(`teammate:${name}`, text)}`);
  }

  /**
   * A subagent is a narrow, background run of the same loop with a subset of tools and no voice
   * of its own: it reports back to the bot that dispatched it, the way the original's Task works.
   */
  dispatchSubagent(parentAgentId: string, kind: SubagentKind, description: string, prompt: string): string {
    const id = `task_${Math.random().toString(36).slice(2, 8)}`;
    const abort = new AbortController();
    const run: SubagentRun = {
      id,
      kind,
      parentAgentId,
      description,
      status: 'running',
      startedAt: Date.now(),
      steps: [],
      abort,
      report: '',
      inbox: [],
    };
    this.subagents.set(id, run);
    void this.runSubagent(parentAgentId, run, prompt);
    return id;
  }

  /** Everything currently running for a bot: background workers and background shells. */
  listTasks(agentId: string): {
    id: string;
    kind: string;
    description: string;
    status: string;
    seconds: number;
    steps: number;
  }[] {
    const out: { id: string; kind: string; description: string; status: string; seconds: number; steps: number }[] = [];
    for (const [, run] of this.subagents) {
      if (run.parentAgentId !== agentId) continue;
      out.push({
        id: run.id,
        kind: run.kind,
        description: run.description,
        status: run.status,
        seconds: Math.round((Date.now() - run.startedAt) / 1000),
        steps: run.steps.length,
      });
    }
    for (const [id, entry] of this.background) {
      if (entry.agentId !== agentId || entry.done) continue;
      out.push({
        id,
        kind: 'shell',
        description: entry.command.slice(0, 80),
        status: 'running',
        seconds: Math.round((Date.now() - entry.startedAt) / 1000),
        steps: 0,
      });
    }
    return out.sort((a, b) => b.seconds - a.seconds);
  }

  checkSubagent(id: string): string {
    const run = this.subagents.get(id);
    if (!run) return `No subagent called ${id}.`;
    const age = Math.round((Date.now() - run.startedAt) / 1000);
    const steps = run.steps.slice(-8).join('\n') || '(nothing yet)';
    return `${id} [${run.kind}] ${run.status}, ${age}s in.\nRecent actions:\n${steps}${run.report ? `\n\nReport:\n${run.report}` : ''}`;
  }

  stopSubagent(id: string): string {
    const run = this.subagents.get(id);
    if (!run) return `No subagent called ${id}.`;
    run.abort.abort();
    run.status = 'stopped';
    return `Stopped ${id}.`;
  }

  /**
   * A correction to a worker that is already running, rather than a replacement for it.
   *
   * The original's `MessageSubagent` (docs/GROK_BOT_INTERNALS.md) exists because stopping a worker and
   * dispatching a new one throws away everything it has already found — the pages it read, the files it
   * wrote — to deliver one sentence. The note is picked up before the worker's next step, so it lands
   * between two model calls rather than in the middle of one.
   */
  messageSubagent(id: string, text: string): string {
    const run = this.subagents.get(id);
    if (!run) return `No subagent called ${id}.`;
    if (run.status !== 'running') return `${id} already finished (${run.status}). Its report is in your chat.`;
    if (!text.trim()) return 'Give it something to act on.';
    run.inbox.push(text.trim());
    return `Passed on to ${id}. It reads this before its next step and keeps everything it has done so far.`;
  }

  private async runSubagent(parentAgentId: string, run: SubagentRun, prompt: string) {
    const settings = this.store.getSettings();
    const allowed = SUBAGENT_TOOLS[run.kind];
    const tools = TOOLS.filter((t) => allowed.includes(t.schema.name));
    const agent = this.store.getAgent(parentAgentId);
    // A worker dispatched by a bot runs on that bot's model, the same as the bot's own turns.
    const provider = providerFor(settings.provider, agent);

    const ctx: ToolContext = {
      agentId: parentAgentId,
      store: this.store,
      emit: () => {},
      sendMessage: (text: string) => {
        run.report += `${text}\n`;
        return { id: 'sub', agentId: parentAgentId, role: 'agent', text, createdAt: Date.now() } as Message;
      },
      requestApproval: (req) => this.ask(req),
      systemEvent: () => {},
      computer: this.computer,
      runner: this,
      signal: run.abort.signal,
      memory: this.memory(parentAgentId),
      skills: this.skills(parentAgentId),
      sendWidget: () => ({ id: 'sub', agentId: parentAgentId, role: 'agent', text: '', createdAt: Date.now() } as Message),
      startBackground: (command, cwd, confined) => this.startBackground(parentAgentId, command, cwd, confined),
      awaitBackground: (id, timeoutMs) => this.awaitBackground(id, timeoutMs),
    };

    const history: ChatMessage[] = [
      { role: 'system', content: subagentSystemPrompt(run.kind, agent?.name ?? 'the bot') },
      { role: 'user', content: prompt },
    ];

    try {
      for (let step = 0; step < 14; step++) {
        if (run.abort.signal.aborted) break;
        // A note from the parent lands between two model calls, never inside one.
        for (const note of run.inbox.splice(0)) {
          run.steps.push(`redirected: ${note.slice(0, 60)}`);
          history.push({
            role: 'user',
            content: `[New instruction from ${agent?.name ?? 'the bot that dispatched you'}]\n${note}\nThis replaces anything it contradicts. Keep what you have already done.`,
          });
        }
        const startedAt = Date.now();
        const result = await chat(provider, history, tools.map((t) => t.schema), () => {}, run.abort.signal);
        this.store.recordUsage({
          at: Date.now(),
          agentId: parentAgentId,
          model: provider.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          seconds: Math.round((Date.now() - startedAt) / 100) / 10,
        });
        history.push({
          role: 'assistant',
          content: result.text,
          ...(result.toolCalls.length
            ? {
                tool_calls: result.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              }
            : {}),
        });
        if (result.text.trim()) run.report = result.text.trim();
        if (result.toolCalls.length === 0) break;

        for (const call of result.toolCalls) {
          const tool = TOOLS_BY_NAME.get(call.name);
          run.steps.push(`${call.name} ${JSON.stringify(call.args).slice(0, 90)}`);
          if (!tool || !allowed.includes(call.name)) {
            history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: `${call.name} is not available to you.` });
            continue;
          }
          try {
            // A background worker is still this bot acting, so it goes through the same gate.
            const gate = await this.gate(parentAgentId, tool, call.args, run.abort.signal);
            const out = gate.allowed ? await tool.run(ctx, call.args) : { output: gate.output };
            history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: fenceToolResult(call.name, out.output) });
          } catch (error) {
            history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: `Failed: ${String((error as Error).message)}` });
          }
        }
      }
      if (run.status === 'running') run.status = 'done';
    } catch (error) {
      run.status = 'error';
      run.report = `Subagent failed: ${String((error as Error).message ?? error)}`;
    }

    if (run.abort.signal.aborted) return;
    // The report is written by a model that has been reading web pages and files, so it is outside
    // content like any other and comes back fenced. The description is Halo's own line and stays out
    // of the fence, which is also what keeps the transcript chip readable.
    this.submitSystemTurn(
      parentAgentId,
      `${run.description}\n\n${fenceContent(`task:${run.id}`, run.report || '(no report)')}`,
      `Background task ${run.id} finished`,
      'note',
    );
  }

  /**
   * Drops everything this process still holds for a bot, so deleting one is actually final.
   *
   * `rememberExchange` runs detached after a turn and calls `memory(agentId)`; a MemoryStore cached
   * for a bot the user has just deleted recreates `agents/<id>/memory/` on its way past, and the bot
   * comes back as an empty folder that survives the next restart.
   */
  forget(agentId: string) {
    this.memories.delete(agentId);
    this.skillStores.delete(agentId);
    this.remoteState.delete(agentId);
    this.channelHops.delete(agentId);
    for (const [id, run] of [...this.subagents]) if (run.parentAgentId === agentId) this.subagents.delete(id);
    for (const [id, entry] of [...this.background]) if (entry.agentId === agentId) this.background.delete(id);
  }

  memory(agentId: string): MemoryStore {
    let store = this.memories.get(agentId);
    if (!store) {
      store = new MemoryStore(this.store, agentId);
      this.memories.set(agentId, store);
    }
    return store;
  }

  skills(agentId: string): SkillStore {
    let store = this.skillStores.get(agentId);
    if (!store) {
      store = new SkillStore(this.store, agentId);
      this.skillStores.set(agentId, store);
    }
    return store;
  }

  /** Long commands run detached and wake the agent up when they finish. */
  private startBackground(agentId: string, command: string, cwd: string, confined = false): string {
    const id = `sh_${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    const box = confined ? { dir: this.store.boxDir(agentId), network: this.store.getAgent(agentId)?.boxNetwork === true } : undefined;
    const promise = runShell(command, cwd, controller.signal, 30 * 60_000, box);
    const entry = { promise, done: false, command, agentId, startedAt: Date.now() };
    this.background.set(id, entry);
    void promise.then(({ code, out }) => {
      entry.done = true;
      const tail = out.trim().split('\n').slice(-20).join('\n');
      this.submitSystemTurn(
        agentId,
        `Background shell ${id} finished with exit ${code}.\nCommand: ${command}\nLast output:\n${fenceContent(`shell:${id}`, tail)}`,
        'Background command finished',
      );
    });
    return id;
  }

  private async awaitBackground(id: string, timeoutMs: number): Promise<string> {
    const entry = this.background.get(id);
    if (!entry) return `No background shell called ${id}.`;
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const result = await Promise.race([entry.promise, timeout]);
    if (result === null) return `${id} is still running. Keep working; you will be told when it finishes.`;
    return `exit ${result.code}\n${result.out || '(no output)'}`;
  }

  // ------------------------------------------------------------------ engine

  private enqueue(
    agentId: string,
    text: string,
    channelId?: string,
    images: string[] = [],
    done?: QueueItem['done'],
  ) {
    const key = conversationKey(agentId, channelId);
    const q = this.queues.get(key) ?? [];
    q.push({ text, images, ...(done ? { done } : {}) });
    this.queues.set(key, q);
    void this.drain(key);
  }

  private async drain(key: string) {
    if (this.running.has(key)) return;
    const q = this.queues.get(key) ?? [];
    if (q.length === 0) return;
    const { agentId, channelId } = parseConversationKey(key);
    this.running.add(key);
    this.setStatus(agentId, 'working');
    try {
      while ((this.queues.get(key) ?? []).length > 0) {
        const item = (this.queues.get(key) ?? []).shift()!;
        const outcome = await this.runTurn(agentId, item.text, channelId, item.images);
        item.done?.(outcome.ok, outcome.note);
      }
    } finally {
      this.running.delete(key);
      this.aborts.delete(key);
      this.setStatus(agentId, 'idle');
    }
  }

  private setStatus(agentId: string, status: Agent['status'], note?: string) {
    this.store.updateAgent(agentId, { status });
    this.emitEvent({ type: 'status', agentId, status, note });
  }

  private toolSchemas(): ToolSchema[] {
    const base = TOOLS.map((t) => t.schema);
    const plugins = this.mcp?.toolSchemas() ?? [];
    // A handful of plugin tools is cheaper to carry than to look up. A shelf of them is not: past the
    // limit they turn into two meta-tools the bot calls on demand, which is what keeps the prompt
    // inside a small local model's window.
    if (plugins.length <= McpManager.INLINE_LIMIT) return [...base, ...plugins];
    return [...base, ...(this.mcp?.metaSchemas() ?? [])];
  }

  /** Folds old turns into a summary so a long-running bot never outgrows its context. */
  private async compactIfNeeded(
    historyId: string,
    historySuffix: string | undefined,
    agentId: string,
    signal?: AbortSignal,
    /** Set when the model has already said the context is too long, so the budget is not the judge. */
    forced = false,
  ) {
    const settings = this.store.getSettings();
    const raw = this.store.llmHistory(historyId, historySuffix) as unknown as ChatMessage[];
    if (raw.length < 12) return;
    if (!forced && estimateTokens(raw) <= settings.provider.contextBudget) return;

    const provider = settings.provider.helperModel
      ? { ...settings.provider, model: settings.provider.helperModel }
      : settings.provider;
    const result = await compactHistory(provider, raw, {
      // Forced means the model itself refused the length, so the configured budget was wrong for
      // this model. Aim well under it rather than at it, or the retry overflows again.
      tokenBudget: forced ? Math.floor(settings.provider.contextBudget / 2) : settings.provider.contextBudget,
      keepLast: forced ? 6 : 12,
      forced,
      ...(signal ? { signal } : {}),
    });
    if (!result.compacted) return;

    this.store.replaceLlmHistory(historyId, result.messages as unknown as Record<string, unknown>[], historySuffix);
    this.systemEvent(agentId, { kind: 'note', label: 'Older turns folded into a summary' });
  }

  private history(agentId: string, suffix?: string): ChatMessage[] {
    const raw = this.store.llmHistory(agentId, suffix) as unknown as ChatMessage[];
    if (raw.length <= HISTORY_LIMIT) return [...raw];
    // keep the tail, but never start on an orphaned tool result
    let start = raw.length - HISTORY_LIMIT;
    while (start < raw.length && raw[start]!.role === 'tool') start++;
    return raw.slice(start);
  }

  private systemPrompt(agent: Agent, channelId?: string): string {
    // Kept in step with the running version rather than with whatever version created the box.
    ensureReference(this.store.boxDir(agent.id));
    const routines = this.store
      .listRoutines()
      .filter((r) => r.agentId === agent.id)
      .map((r) => `${r.name} — ${describeTriggers(r.triggers)}${r.enabled ? '' : ' (disabled)'}`);
    return buildSystemPrompt({
      agent,
      settings: this.store.getSettings(),
      boxDir: this.store.boxDir(agent.id),
      memory: this.memory(agent.id).render(),
      teammates: this.store.listAgents(),
      routines,
      skills: this.skills(agent.id).list().map((s) => `${s.name} — ${s.description}`),
      channels: this.store
        .listChannels()
        .filter((c) => c.memberIds.includes(agent.id))
        .map((c) => `${c.name} (id ${c.id})`),
      ...(channelId
        ? (() => {
            const channel = this.store.getChannel(channelId);
            return channel
              ? {
                  channel: {
                    name: channel.name,
                    members: channel.memberIds
                      .map((id) => this.store.getAgent(id)?.name)
                      .filter((n): n is string => Boolean(n)),
                  },
                }
              : {};
          })()
        : {}),
    });
  }

  private async runTurn(
    agentId: string,
    userText: string,
    channelId?: string,
    images: string[] = [],
  ): Promise<{ ok: boolean; note?: string }> {
    const agent = this.store.getAgent(agentId);
    if (!agent) return { ok: false, note: 'the bot no longer exists' };
    const settings = this.store.getSettings();
    const abort = new AbortController();
    const key = conversationKey(agentId, channelId);
    this.aborts.set(key, abort);

    // In a channel the transcript belongs to the room; each bot keeps its own model history inside it.
    const target = channelId ?? agentId;
    const historyId = channelId ?? agentId;
    const historySuffix = channelId ? agentId : undefined;

    try {
      await this.compactIfNeeded(historyId, historySuffix, agentId, abort.signal);
    } catch {
      // A summariser that is down must not stop the turn; the history stays long instead.
    }
    // The reminder is added to the request, not to the stored history: it is a nudge for this call,
    // not a fact about the conversation, and storing it would re-send it forever.
    this.store.appendLlm(
      historyId,
      { role: 'user', content: userText, ...(images.length ? { images } : {}) },
      historySuffix,
    );

    // The assistant "activity" record: tool cards attach to it, and the UI streams into it.
    let activity: Message | null = null;
    const ensureActivity = (): Message => {
      if (activity) return activity;
      activity = this.store.appendMessage({
        id: randomUUID(),
        agentId: target,
        role: 'agent',
        text: '',
        createdAt: Date.now(),
        toolCalls: [],
        ...(channelId ? { fromAgentId: agentId } : {}),
      });
      this.emitEvent({ type: 'message', message: activity });
      return activity;
    };

    let deliveredSomething = false;
    /*
     * Grok Bot 0.24 stopped treating "reply first" as advice and made the runtime count a delivery the
     * turn owes (`sand_send_message_delivery_owed`, docs/GROK_BOT_0.24_0.27_TEARDOWN.md §3). The failure
     * it catches is the expensive one: the bot does the work, then ends the turn with the result only in
     * its own head. One nudge, once — a second would be a loop, and the system event below already tells
     * the user when even that did not land.
     */
    let workedThisTurn = false;
    let nudgedForDelivery = false;
    let widgetSent = false;
    /** One compaction per turn: a second overflow means the tail alone does not fit, and looping would not help. */
    let compactedForOverflow = false;
    /*
     * Whether the activity record is currently carrying streamed text.
     *
     * A flag rather than a look at `activity.text`, because `Store.updateMessage` replaces the object
     * in its list instead of mutating it: the local `activity` reference keeps the empty string it was
     * created with no matter how much text is written to the stored record. The clearing below tested
     * that reference, so it never once fired, and every turn that both streamed text and called
     * SendMessage put the same paragraph in the transcript twice.
     */
    let activityHasText = false;
    /** What the bot actually told the user, so a routine can be fed its own last report. */
    let lastDelivered = '';
    /** How much of the request the server admitted it read, used to spot a truncating context window. */
    let lastPromptTokens = 0;
    const sentTexts = new Set<string>();
    const ctx: ToolContext = {
      agentId,
      store: this.store,
      emit: (e) => this.emitEvent(e),
      sendMessage: (text: string, images?: { path: string; alt?: string }[]) => {
        // A weak model can re-send the same line five times; deliver it once.
        const key = text.trim().toLowerCase();
        if (key && sentTexts.has(key)) {
          deliveredSomething = true;
          return { id: 'duplicate', agentId: target, role: 'agent', text, createdAt: Date.now() } as Message;
        }
        if (key) sentTexts.add(key);
        lastDelivered = text;
        const msg = this.store.appendMessage({
          id: randomUUID(),
          agentId: target,
          role: 'agent',
          text,
          createdAt: Date.now(),
          ...(images && images.length ? { images } : {}),
          ...(channelId ? { fromAgentId: agentId } : {}),
        });
        this.emitEvent({ type: 'message', message: msg });
        deliveredSomething = true;
        const a = this.store.getAgent(agentId);
        if (a?.notifications && this.notify) this.notify(a, msg);
        if (channelId) this.postToChannel(channelId, agentId, text);
        return msg;
      },
      requestApproval: (req) => this.ask(req),
      memory: this.memory(agentId),
      skills: this.skills(agentId),
      sendWidget: (widget: Widget) => {
        widgetSent = true;
        const msg = this.store.appendMessage({
          id: randomUUID(),
          // a question asked in a room belongs in that room, next to the rest of the exchange
          agentId: target,
          role: 'agent',
          text: '',
          createdAt: Date.now(),
          widget,
          ...(channelId ? { fromAgentId: agentId } : {}),
        });
        this.emitEvent({ type: 'message', message: msg });
        deliveredSomething = true;
        return msg;
      },
      startBackground: (command, cwd, confined) => this.startBackground(agentId, command, cwd, confined),
      awaitBackground: (id, timeoutMs) => this.awaitBackground(id, timeoutMs),
      pluginStatus: () => this.mcp?.statuses() ?? [],
      systemEvent: (event) => {
        this.systemEvent(agentId, event);
      },
      computer: this.computer,
      runner: this,
      signal: abort.signal,
    };

    try {
      for (let step = 0; step < settings.provider.maxSteps; step++) {
        if (abort.signal.aborted) break;
        // A question ends the turn: their answer arrives as the next message. Checked before the
        // call, so asking never costs an extra round trip or leaves tool_calls without results.
        if (widgetSent) break;

        const messages: ChatMessage[] = withReplyReminder([
          { role: 'system', content: this.systemPrompt(agent, channelId) },
          ...this.history(historyId, historySuffix),
        ]);

        let streamed = '';
        const startedAt = Date.now();
        const providerForAgent = providerFor(settings.provider, agent);
        const stream = (chunk: string) => {
          streamed += chunk;
          const a = ensureActivity();
          // `target`, not `agentId`: in a room the activity record belongs to the room's transcript,
          // and a patch addressed to the bot's own id lands on a conversation that does not hold it,
          // so nothing streamed ever appeared in a channel.
          this.emitEvent({ type: 'message.patch', agentId: target, messageId: a.id, text: streamed });
        };

        let result;
        try {
          /*
           * A bot with an endpoint is somebody else's agent, on any framework, run through AG-UI.
           * It is offered Halo's toolset and the calls it makes come back here — through the same
           * gate, onto the same trail — so hosting a foreign agent is not the same as trusting it.
           */
          result = agent.endpoint
            ? await this.runRemote(agent, historyId, messages, stream, abort.signal)
            : await chat(providerForAgent, messages, this.toolSchemas(), stream, abort.signal);
        } catch (error) {
          /*
           * The one failure worth a second attempt after changing something.
           *
           * A context overflow is not transient — the same call fails the same way forever — but it
           * has exactly one fix, and the app already has it. Compact, then try once more, on the
           * same conversation rather than a fresh one, so nothing the bot knows is thrown away to
           * recover from being verbose. Every other class falls straight through: an expired key is
           * not going to work on the third try. This is Hermes's retry policy for bot turns.
           */
          if (classifyProviderError(error) !== 'context_overflow' || compactedForOverflow) throw error;
          compactedForOverflow = true;
          this.systemEvent(agentId, { kind: 'note', label: 'Ran out of context — folding older turns into a summary and trying again' });
          await this.compactIfNeeded(historyId, historySuffix, agentId, abort.signal, true);
          const retried: ChatMessage[] = withReplyReminder([
            { role: 'system', content: this.systemPrompt(agent, channelId) },
            ...this.history(historyId, historySuffix),
          ]);
          streamed = '';
          result = agent.endpoint
            ? await this.runRemote(agent, historyId, retried, stream, abort.signal)
            : await chat(providerForAgent, retried, this.toolSchemas(), stream, abort.signal);
        }

        lastPromptTokens = result.usage.promptTokens;
        this.store.recordUsage({
          at: Date.now(),
          agentId,
          model: providerForAgent.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          seconds: Math.round((Date.now() - startedAt) / 100) / 10,
        });

        if (result.text.trim()) {
          const a = ensureActivity();
          this.store.updateMessage(target, a.id, { text: result.text });
          activityHasText = true;
        }

        this.store.appendLlm(historyId, {
          role: 'assistant',
          content: result.text,
          ...(result.toolCalls.length
            ? {
                tool_calls: result.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              }
            : {}),
        }, historySuffix);

        if (result.toolCalls.length === 0) {
          // Work happened but nothing was sent: the turn owes a message it never wrote.
          if (!deliveredSomething && !nudgedForDelivery && workedThisTurn && !result.text.trim()) {
            nudgedForDelivery = true;
            this.store.appendLlm(historyId, {
              role: 'user',
              content:
                'You finished the work but never called SendMessage, so the user has seen nothing at all. Send them the result now, in one or two short messages.',
            }, historySuffix);
            continue;
          }
          // Model answered in plain text. That never reaches the user, so nudge it once.
          if (!deliveredSomething && result.text.trim()) {
            this.store.appendLlm(historyId, {
              role: 'user',
              content:
                'That text was not delivered — the user cannot see assistant text. Send the same thing through SendMessage now.',
            }, historySuffix);
            continue;
          }
          break;
        }

        workedThisTurn = true;
        for (const call of result.toolCalls) {
          if (abort.signal.aborted) break;
          if (widgetSent && call.name === 'AskUser') {
            this.store.appendLlm(
              historyId,
              {
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                content: 'You already asked. End the turn and wait for their answer.',
              },
              historySuffix,
            );
            continue;
          }
          const { output, imagePath } = await this.executeTool(ctx, ensureActivity, call, target);
          this.store.appendLlm(
            historyId,
            { role: 'tool', tool_call_id: call.id, name: call.name, content: fenceToolResult(call.name, output) },
            historySuffix,
          );

          // A screenshot is only useful if the model can actually see it.
          const dataUrl = imagePath && settings.provider.vision ? imageDataUrl(imagePath) : null;
          if (dataUrl) {
            this.store.appendLlm(
              historyId,
              { role: 'user', content: 'Here is the image that tool produced. Look at it before your next step.', images: [dataUrl] },
              historySuffix,
            );
          }
        }
      }

      /*
       * The streaming preview is a preview, not a delivery.
       *
       * A model that writes "Done: X" as plain text and then calls SendMessage with the same line is
       * doing what it was asked — SendMessage is the only channel — but the transcript ends up saying
       * it twice, because the activity record kept the streamed text as well. Once the turn has
       * actually delivered something, the preview has served its purpose: the tool cards stay on the
       * activity record and the text comes off it.
       */
      if (deliveredSomething && activity && activityHasText) {
        const record = activity as Message;
        this.store.updateMessage(target, record.id, { text: '' });
        activityHasText = false;
        this.emitEvent({ type: 'message.patch', agentId: target, messageId: record.id, text: '' });
      }

      if (!deliveredSomething && !abort.signal.aborted) {
        /*
         * Almost always the same cause, and it is worth naming rather than leaving as a shrug.
         *
         * Halo's system prompt plus its tool schemas is several thousand tokens. A server running a
         * smaller context window than that silently truncates the request, so the model never sees
         * the instructions it is being judged against — it answers in plain text, gets nudged, and
         * then produces nothing. Ollama ships a 4096-token default, which is below the floor here.
         */
        const short = lastPromptTokens > 0 && lastPromptTokens < PROMPT_FLOOR_TOKENS;
        this.systemEvent(agentId, {
          kind: 'note',
          label: short
            ? `Finished without sending a message — the model only saw ${lastPromptTokens} tokens of a longer prompt, so its context window is too small. Raise it (for Ollama: OLLAMA_CONTEXT_LENGTH=16384).`
            : 'Finished without sending a message',
        });
      }

      void this.rememberExchange(agentId, userText);
      if (abort.signal.aborted) return { ok: false, note: 'stopped' };
      return { ok: true, ...(lastDelivered ? { note: lastDelivered } : {}) };
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      const reason = error instanceof ProviderError ? error.reason : classifyProviderError(error);
      const text = error instanceof ProviderError ? describeFailure(reason, message) : `Turn failed: ${message}`;
      this.emitEvent({ type: 'error', agentId, message: text });
      ctx.sendMessage(text);
      // The note is what a routine's run history shows, so it carries the code a person can act on.
      return { ok: false, note: `[${reason}] ${text}`.slice(0, 160) };
    }
  }

  /**
   * The approval gate. Every path that runs a tool goes through it — the main loop and background
   * workers alike — so there is exactly one place where permission is decided.
   */
  private async gate(
    agentId: string,
    tool: Tool,
    args: Record<string, unknown>,
    signal: AbortSignal,
    onNote?: (note: string) => void,
  ): Promise<{ allowed: true } | { allowed: false; error: string; output: string }> {
    if (!tool.surface) return { allowed: true };

    const settings = this.store.getSettings();
    const action = summarize(tool.schema.name, args, this.store.boxDir(agentId));
    // A click names a ref; the card and the trail should say what that ref is, resolved from the
    // page this process looked at rather than from whatever the model called it.
    if (tool.schema.name === 'Browser' && typeof args.ref === 'string') {
      const element = this.computer.describeRef(agentId, args.ref);
      if (element) {
        action.element = element;
        action.summary = `${action.summary} — ${element.role} "${element.name}"`;
      }
    }
    // A broken rule fails closed by design; it must not do so silently, or somebody's typo becomes a
    // bot that refuses everything for a week with nothing saying why.
    const broken: string[] = [];
    let verdict: Verdict = decideDetailed(settings, tool.surface, action, this.store.getAgent(agentId), agentId, (message) =>
      broken.push(message),
    );
    for (const message of broken) {
      this.systemEvent(agentId, { kind: 'permission', label: message.slice(0, 160) });
      onNote?.(message);
    }

    // Smart mode asks the model about anything the local rules would wave through.
    if (
      verdict.decision === 'allow' &&
      verdict.source !== 'granted' &&
      settings.autoReview &&
      settings.autoReviewMode === 'smart' &&
      REVIEWED_SURFACES.has(tool.surface)
    ) {
      const review = await reviewWithModel(settings, tool.surface, action, signal);
      if (review.decision !== 'allow') {
        verdict = { decision: review.decision, source: 'review', matched: null, reason: review.reason };
        onNote?.(`Safety review: ${review.decision} — ${review.reason}`);
      }
    }

    /*
     * Dry-run decides and records without blocking, so somebody can write a rule against real work
     * and read the trail before it starts refusing things. The hardline floor ignores it: those are
     * not a policy anybody is tuning.
     */
    const dryRun = settings.policyMode === 'dry-run' && verdict.source !== 'hardline';
    if (verdict.decision !== 'allow' && dryRun) {
      this.record(agentId, tool.schema.name, tool.surface, action, 'allowed', verdict, { dryRun: true });
      return { allowed: true };
    }

    if (verdict.decision === 'deny') {
      this.record(agentId, tool.schema.name, tool.surface, action, 'refused', verdict);
      return {
        allowed: false,
        error: verdict.source === 'hardline' ? 'blocked by Halo' : 'blocked by settings',
        output: `${verdict.reason} Tell the user what you wanted to do and why, and do not look for another way round this.`,
      };
    }

    if (verdict.decision === 'ask') {
      // A background worker can ask while its parent sits idle, so the old status is put back.
      const prior = this.store.getAgent(agentId)?.status ?? 'idle';
      this.setStatus(agentId, 'waiting', action.summary);
      const decision = await this.ask({
        agentId,
        surface: tool.surface,
        summary: action.summary,
        detail: action.detail,
        reason: verdict.reason,
        ...(action.command ? { command: action.command } : {}),
        ...(action.intent ? { intent: action.intent } : {}),
      });
      this.setStatus(agentId, prior);
      if (decision === 'never') {
        this.record(agentId, tool.schema.name, tool.surface, action, 'refused', { source: 'user', matched: 'declined' });
        return {
          allowed: false,
          error: 'user declined',
          output: 'The user declined this and asked not to be asked again. Find another way, or tell them what is blocked.',
        };
      }
      if (decision === 'always') {
        this.systemEvent(agentId, {
          kind: 'permission',
          label: `${this.store.getAgent(agentId)?.name ?? 'This bot'} can ${permissionPhrase(tool.surface)}${
            action.command ? ` starting "${commandPrefixOf(action.command)}"` : ''
          }.`,
        });
      }
      this.record(agentId, tool.schema.name, tool.surface, action, 'allowed', { source: 'user', matched: decision });
      return { allowed: true };
    }

    this.record(agentId, tool.schema.name, tool.surface, action, 'allowed', verdict);
    return { allowed: true };
  }

  private async executeTool(
    ctx: ToolContext,
    ensureActivity: () => Message,
    call: { id: string; name: string; args: Record<string, unknown> },
    transcriptId: string = ctx.agentId,
  ): Promise<{ output: string; imagePath?: string }> {
    const activity = ensureActivity();
    const tool = TOOLS_BY_NAME.get(call.name);
    const record: ToolCallRecord = {
      id: call.id,
      name: call.name,
      args: call.args,
      status: 'running',
      startedAt: Date.now(),
    };
    const attach = (patch: Partial<ToolCallRecord>) => {
      Object.assign(record, patch);
      const calls = [...(activity.toolCalls ?? []).filter((c) => c.id !== record.id), record];
      activity.toolCalls = calls;
      this.store.updateMessage(transcriptId, activity.id, { toolCalls: calls });
      this.emitEvent({ type: 'tool', agentId: transcriptId, messageId: activity.id, call: { ...record } });
    };
    attach({});

    if (!tool) {
      // The two meta-tools that stand in for inlined plugin schemas. Listing is read-only; calling is
      // routed straight into the plugin path below so it lands on the trail like any other plugin call.
      if (this.mcp && call.name === 'ListPluginTools') {
        const output = this.mcp.catalogue(typeof call.args.plugin === 'string' ? call.args.plugin : undefined);
        attach({ status: 'done', endedAt: Date.now(), result: output.slice(0, 4000) });
        return { output };
      }
      if (this.mcp && call.name === 'CallPluginTool') {
        const name = typeof call.args.name === 'string' ? call.args.name : '';
        const args = (call.args.arguments ?? {}) as Record<string, unknown>;
        if (!this.mcp.isPluginTool(name)) {
          const output = `${name || '(no name)'} is not a plugin tool. Call ListPluginTools and use a name from it.`;
          attach({ status: 'error', endedAt: Date.now(), error: output });
          return { output };
        }
        return this.executeTool(ctx, ensureActivity, { ...call, name, args }, transcriptId);
      }
      if (this.mcp?.isPluginTool(call.name)) {
        // A plugin reaches somebody else's service with the user's credentials, so it belongs on the
        // trail beside everything else even though there is no local policy to decide it against.
        const plugin = { summary: `Plugin call ${call.name}`, detail: JSON.stringify(redactArgs(call.args)).slice(0, 800), intent: 'plugin_call' };
        this.record(ctx.agentId, call.name, 'plugin', plugin, 'allowed', { source: 'plugin' });
        try {
          const output = await this.mcp.call(call.name, call.args);
          attach({ status: 'done', endedAt: Date.now(), result: output.slice(0, 4000) });
          return { output };
        } catch (error) {
          const message = String((error as Error)?.message ?? error);
          this.record(ctx.agentId, call.name, 'plugin', plugin, 'failed', { source: 'plugin' }, { failure: message });
          attach({ status: 'error', endedAt: Date.now(), error: message });
          return { output: `Plugin call failed: ${message}` };
        }
      }
      attach({ status: 'error', error: 'unknown tool', endedAt: Date.now() });
      return { output: `No tool named ${call.name}.` };
    }

    const gate = await this.gate(ctx.agentId, tool, call.args, ctx.signal, (note) => attach({ result: note }));
    if (!gate.allowed) {
      attach({ status: 'denied', endedAt: Date.now(), error: gate.error });
      return { output: gate.output };
    }

    try {
      const res = await tool.run(ctx, call.args);
      attach({ status: res.isError ? 'error' : 'done', endedAt: Date.now(), result: res.output.slice(0, 4000) });
      return res.imagePath ? { output: res.output, imagePath: res.imagePath } : { output: res.output };
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      // A permitted action that did not happen gets its own row. Without it the trail lies by
      // omission: the decision row says "allowed", and a reader takes that to mean it ran.
      if (tool.surface) {
        const action = summarize(tool.schema.name, call.args, this.store.boxDir(ctx.agentId));
        this.record(ctx.agentId, call.name, tool.surface, action, 'failed', { source: 'attempt' }, { failure: message });
      }
      attach({ status: 'error', endedAt: Date.now(), error: message });
      return { output: `Tool failed: ${message}` };
    }
  }
  /**
   * One turn against an AG-UI endpoint, shaped like a provider result so the loop above does not
   * care which kind of bot it is driving.
   *
   * The run state the agent hands back is kept per conversation and given straight back on the next
   * turn: an agent built on a graph keeps its own place in that graph, which is the point of the
   * protocol carrying state at all. Usage comes back as zeroes because somebody else's endpoint bills
   * somebody else's tokens, and inventing numbers for the Usage screen would be worse than a gap.
   */
  private async runRemote(
    agent: Agent,
    historyId: string,
    messages: ChatMessage[],
    onDelta: (chunk: string) => void,
    signal: AbortSignal,
  ) {
    const run = await runAgUi({
      endpoint: agent.endpoint!,
      ...(agent.endpointAuth ? { authHeader: agent.endpointAuth } : {}),
      threadId: historyId,
      runId: randomUUID(),
      messages: messages.map(toAgUiMessage),
      tools: this.toolSchemas(),
      state: this.remoteState.get(historyId),
      onDelta,
      signal,
    });
    this.remoteState.set(historyId, run.state);
    return {
      text: run.text,
      toolCalls: run.toolCalls,
      finishReason: run.toolCalls.length ? 'tool_calls' : 'stop',
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }

  /**
   * Runs one tool through the real gate, with no model in the loop.
   *
   * For scripts/verify.mts. Asking a model to attempt a wipe tests whether that model is willing,
   * which is not a property of Halo — a well-behaved one refuses on its own and the floor is never
   * reached. This drives the gate directly, which is the thing that has to hold when the model is
   * not well behaved.
   */
  async runToolForTest(agentId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const tool = TOOLS_BY_NAME.get(toolName);
    if (!tool) return `No tool named ${toolName}.`;
    const gate = await this.gate(agentId, tool, args, new AbortController().signal);
    if (!gate.allowed) return gate.output;
    const ctx = {
      agentId,
      store: this.store,
      emit: () => {},
      sendMessage: () => ({}) as Message,
      requestApproval: () => Promise.resolve('never' as ApprovalDecision),
      systemEvent: () => {},
      computer: this.computer,
      runner: this,
      signal: new AbortController().signal,
      memory: this.memory(agentId),
      skills: this.skills(agentId),
      sendWidget: () => ({}) as Message,
      startBackground: (command: string, cwd: string, confined: boolean) => this.startBackground(agentId, command, cwd, confined),
      awaitBackground: (id: string, timeoutMs: number) => this.awaitBackground(id, timeoutMs),
    } as ToolContext;
    return (await tool.run(ctx, args)).output;
  }

  private async rememberExchange(agentId: string, userText: string) {
    const transcript = this.store.transcript(agentId);
    const reply = [...transcript].reverse().find((m) => m.role === 'agent' && m.text.trim().length > 0);
    const settings = this.store.getSettings();
    const changed = await extractMemories(
      settings.provider.helperModel ? { ...settings.provider, model: settings.provider.helperModel } : settings.provider,
      this.memory(agentId),
      userText,
      reply?.text ?? '',
    );
    if (changed > 0) this.systemEvent(agentId, { kind: 'memory', label: 'Updated memory' });
  }

  private ask(req: Omit<ApprovalRequest, 'id' | 'createdAt' | 'agentName' | 'question'>): Promise<ApprovalDecision> {
    const agent = this.store.getAgent(req.agentId);
    const name = agent?.name ?? 'this bot';
    const request: ApprovalRequest = {
      ...req,
      agentName: name,
      question: approvalQuestion(req.surface, name),
      id: randomUUID(),
      createdAt: Date.now(),
    };
    /*
     * Registered before it is announced, never the other way round.
     *
     * The old order emitted the card and only then, inside the promise executor, recorded who was
     * waiting for the answer. That is safe for exactly one kind of listener: the renderer, which
     * answers over IPC a tick later. Anything that answers synchronously — a test harness, a future
     * auto-approve rule, a second window — calls `resolveApproval` while `approvals` is still empty,
     * the decision is dropped on the floor, and the turn waits for an answer that already came.
     */
    return new Promise<ApprovalDecision>((resolve) => {
      this.approvals.set(request.id, { request, resolve });
      this.emitEvent({ type: 'approval', approval: request });
    });
  }
}

function approvalQuestion(surface: ApprovalRequest['surface'], agentName: string): string {
  switch (surface) {
    case 'external_shell':
      return `Allow ${agentName} to run commands on your computer?`;
    case 'external_read':
      return `Allow ${agentName} to read files from your computer?`;
    case 'file_write':
      return `Allow ${agentName} to write files onto your computer?`;
    case 'browser':
      return `Allow ${agentName} to use the browser for this?`;
    case 'shell':
      return `Allow ${agentName} to run this command?`;
    case 'automation':
      return `Allow ${agentName} to change your automations?`;
    default:
      return `Allow ${agentName} to make this change?`;
  }
}

function permissionPhrase(surface: ApprovalRequest['surface']): string {
  switch (surface) {
    case 'external_shell':
      return 'run commands on your computer';
    case 'external_read':
      return 'read files from your computer';
    case 'file_write':
      return 'write files onto your computer';
    case 'automation':
      return 'change and run your automations';
    default:
      return 'do this without asking';
  }
}

/**
 * How much of a command a remembered "Always allow" covers.
 *
 * The executable and its first subcommand: `git push` rather than `git`, so approving a push does
 * not also approve `git config --global`; and `git` alone when there is no subcommand. Long enough
 * to be a decision about something, short enough that the rule is still useful the second time.
 */
export function commandPrefixOf(command: string): string {
  const words = command.trim().split(/\s+/).filter(Boolean);
  const head = words[0] ?? '';
  const second = words[1] ?? '';
  // A flag or a path is not a subcommand; those change every run and would make the rule fire once.
  const takesSecond = second && !second.startsWith('-') && !/[\\/:]/.test(second) && /^[\w.-]+$/.test(second);
  return (takesSecond ? `${head} ${second}` : head).toLowerCase();
}

/**
 * Below this, a prompt cannot have carried Halo's instructions and its toolset.
 *
 * The system prompt is ~1500 tokens and the 41 tool schemas are a few thousand more, so a server
 * that reports having read fewer than this truncated the request rather than answered it.
 */
const PROMPT_FLOOR_TOKENS = 4200;

const MAX_CHANNEL_HOPS = 3;

/** Surfaces worth a model review; reading a page or listing files is not one of them. */
const REVIEWED_SURFACES = new Set(['external_shell', 'external_read', 'file_write', 'shell']);

function conversationKey(agentId: string, channelId?: string): string {
  return channelId ? `${agentId}@${channelId}` : agentId;
}

function parseConversationKey(key: string): { agentId: string; channelId?: string } {
  const at = key.indexOf('@');
  if (at < 0) return { agentId: key };
  return { agentId: key.slice(0, at), channelId: key.slice(at + 1) };
}

/**
 * Puts the "your text is not delivered" nudge on the last user message of the request.
 * It rides along with the call rather than being stored, so it is never re-sent from history.
 */
function withReplyReminder(messages: ChatMessage[]): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    const patched = [...messages];
    patched[i] = { ...message, content: `${message.content}\n\n${REPLY_REMINDER}` };
    return patched;
  }
  return messages;
}

/** Plugin arguments go on the trail, so anything shaped like a credential is dropped first. */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = /token|secret|password|key|auth/i.test(key) ? '[withheld]' : value;
  }
  return out;
}

/** Halo's stored message shape as AG-UI sees it. Ids are stable per position within one run. */
function toAgUiMessage(message: ChatMessage, index: number): AgUiMessage {
  const role = message.role === 'tool' ? 'tool' : message.role;
  return {
    id: `m${index}`,
    role: role as AgUiMessage['role'],
    content: message.content ?? '',
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
    ...(message.tool_calls ? { toolCalls: message.tool_calls } : {}),
  };
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** Inlines an image for the model; oversized or unknown formats are skipped rather than sent broken. */
function imageDataUrl(path: string): string | null {
  const type = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!type) return null;
  try {
    if (statSync(path).size > MAX_IMAGE_BYTES) return null;
    return `data:${type};base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return null;
  }
}
