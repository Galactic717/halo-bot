import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { MemoryStore, extractMemories } from './memory.ts';
import { SkillStore } from './skills.ts';
import { runShell } from './tools.ts';
import { chat, ProviderError, type ChatMessage, type ToolSchema } from './provider.ts';
import { buildSystemPrompt, REPLY_REMINDER } from './prompt.ts';
import { decide, reviewWithModel, summarize } from './policy.ts';
import { TOOLS, TOOLS_BY_NAME, describeTriggers, type ComputerPort, type RunnerPort, type Tool, type ToolContext } from './tools.ts';
import type { SubagentKind, SubagentRun } from './subagents.ts';
import { mentionedNames } from './mentions.ts';
import { compactHistory, estimateTokens } from './compaction.ts';
import type { McpManager } from './mcp.ts';
import { SUBAGENT_TOOLS, subagentSystemPrompt } from './subagents.ts';
import type { Store } from './store.ts';
import type { Agent, ApprovalDecision, ApprovalRequest, Channel, HaloEvent, Message, SystemEvent, ToolCallRecord, Widget } from './types.ts';

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

  constructor(opts: RunnerOptions) {
    this.store = opts.store;
    this.computer = opts.computer;
    this.emitEvent = opts.emit;
    this.notify = opts.notify;
    this.mcp = opts.mcp;
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
    const { surface, summary } = pending.request;
    if (decision === 'always' || decision === 'never') this.rememberDecision(surface, summary, decision);
    pending.resolve(decision);
    this.emitEvent({ type: 'approval.resolved', id, approved: decision !== 'never' });
  }

  /**
   * "Always allow" and "Never" are sticky, the way the original writes them into settings.
   * They become a rule about *this* action. Flipping the global execution switch instead would turn
   * one approval to read a file into standing permission to run any command.
   */
  private rememberDecision(_surface: ApprovalRequest['surface'], summary: string, decision: ApprovalDecision) {
    const settings = this.store.getSettings();
    if (settings.rules.some((r) => r.when === summary)) return;
    this.store.saveSettings({
      rules: [...settings.rules, { id: randomUUID(), when: summary, decision: decision === 'always' ? 'allow' : 'deny' }],
    });
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
    this.systemEvent(toAgentId, {
      kind: 'handoff',
      label: 'Message from',
      chip: from?.name ?? 'another bot',
      ...(from ? { chipAgentId: from.id } : {}),
    });
    this.enqueue(toAgentId, `[Message from ${from?.name ?? 'another bot'}]\n${text}`);
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

  private async runSubagent(parentAgentId: string, run: SubagentRun, prompt: string) {
    const settings = this.store.getSettings();
    const allowed = SUBAGENT_TOOLS[run.kind];
    const tools = TOOLS.filter((t) => allowed.includes(t.schema.name));
    const agent = this.store.getAgent(parentAgentId);

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
      startBackground: (command, cwd) => this.startBackground(parentAgentId, command, cwd),
      awaitBackground: (id, timeoutMs) => this.awaitBackground(id, timeoutMs),
    };

    const history: ChatMessage[] = [
      { role: 'system', content: subagentSystemPrompt(run.kind, agent?.name ?? 'the bot') },
      { role: 'user', content: prompt },
    ];

    try {
      for (let step = 0; step < 14; step++) {
        if (run.abort.signal.aborted) break;
        const startedAt = Date.now();
        const result = await chat(settings.provider, history, tools.map((t) => t.schema), () => {}, run.abort.signal);
        this.store.recordUsage({
          at: Date.now(),
          agentId: parentAgentId,
          model: settings.provider.model,
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
            history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: out.output });
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
    this.submitSystemTurn(
      parentAgentId,
      `${run.description}\n\n${run.report || '(no report)'}`,
      `Background task ${run.id} finished`,
      'note',
    );
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
  private startBackground(agentId: string, command: string, cwd: string): string {
    const id = `sh_${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    const promise = runShell(command, cwd, controller.signal, 30 * 60_000);
    const entry = { promise, done: false, command, agentId, startedAt: Date.now() };
    this.background.set(id, entry);
    void promise.then(({ code, out }) => {
      entry.done = true;
      const tail = out.trim().split('\n').slice(-20).join('\n');
      this.submitSystemTurn(
        agentId,
        `Background shell ${id} finished with exit ${code}.\nCommand: ${command}\nLast output:\n${tail}`,
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
    return [...TOOLS.map((t) => t.schema), ...(this.mcp?.toolSchemas() ?? [])];
  }

  /** Folds old turns into a summary so a long-running bot never outgrows its context. */
  private async compactIfNeeded(historyId: string, historySuffix: string | undefined, agentId: string, signal?: AbortSignal) {
    const settings = this.store.getSettings();
    const raw = this.store.llmHistory(historyId, historySuffix) as unknown as ChatMessage[];
    if (raw.length < 12) return;
    if (estimateTokens(raw) <= settings.provider.contextBudget) return;

    const provider = settings.provider.helperModel
      ? { ...settings.provider, model: settings.provider.helperModel }
      : settings.provider;
    const result = await compactHistory(provider, raw, {
      tokenBudget: settings.provider.contextBudget,
      keepLast: 12,
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
    let widgetSent = false;
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
      startBackground: (command, cwd) => this.startBackground(agentId, command, cwd),
      awaitBackground: (id, timeoutMs) => this.awaitBackground(id, timeoutMs),
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
        const providerForAgent = agent.model ? { ...settings.provider, model: agent.model } : settings.provider;
        const result = await chat(
          providerForAgent,
          messages,
          this.toolSchemas(),
          (chunk) => {
            streamed += chunk;
            const a = ensureActivity();
            this.emitEvent({ type: 'message.patch', agentId, messageId: a.id, text: streamed });
          },
          abort.signal,
        );

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
          this.store.appendLlm(historyId, { role: 'tool', tool_call_id: call.id, name: call.name, content: output }, historySuffix);

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

      if (!deliveredSomething && !abort.signal.aborted) {
        this.systemEvent(agentId, { kind: 'note', label: 'Finished without sending a message' });
      }

      void this.rememberExchange(agentId, userText);
      if (abort.signal.aborted) return { ok: false, note: 'stopped' };
      return { ok: true };
    } catch (error) {
      const text =
        error instanceof ProviderError
          ? `Model request failed: ${error.message}. Check Settings → Model.`
          : `Turn failed: ${String((error as Error)?.message ?? error)}`;
      this.emitEvent({ type: 'error', agentId, message: text });
      ctx.sendMessage(text);
      return { ok: false, note: text.slice(0, 120) };
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
    let verdict = decide(settings, tool.surface, action, this.store.getAgent(agentId));

    // Smart mode asks the model about anything the local rules would wave through.
    if (verdict === 'allow' && settings.autoReview && settings.autoReviewMode === 'smart' && REVIEWED_SURFACES.has(tool.surface)) {
      const review = await reviewWithModel(settings, tool.surface, action, signal);
      if (review.decision !== 'allow') {
        verdict = review.decision;
        onNote?.(`Safety review: ${review.decision} — ${review.reason}`);
      }
    }

    if (verdict === 'deny') {
      return {
        allowed: false,
        error: 'blocked by settings',
        output: 'Blocked by the user settings. Tell the user what you wanted to do and why.',
      };
    }

    if (verdict === 'ask') {
      // A background worker can ask while its parent sits idle, so the old status is put back.
      const prior = this.store.getAgent(agentId)?.status ?? 'idle';
      this.setStatus(agentId, 'waiting', action.summary);
      const decision = await this.ask({
        agentId,
        surface: tool.surface,
        summary: action.summary,
        detail: action.detail,
        reason: 'This action affects your machine or the outside world.',
      });
      this.setStatus(agentId, prior);
      if (decision === 'never') {
        return {
          allowed: false,
          error: 'user declined',
          output: 'The user declined this and asked not to be asked again. Find another way, or tell them what is blocked.',
        };
      }
      if (decision === 'always') {
        this.systemEvent(agentId, {
          kind: 'permission',
          label: `${this.store.getAgent(agentId)?.name ?? 'This bot'} can ${permissionPhrase(tool.surface)}.`,
        });
      }
    }

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
      if (this.mcp?.isPluginTool(call.name)) {
        try {
          const output = await this.mcp.call(call.name, call.args);
          attach({ status: 'done', endedAt: Date.now(), result: output.slice(0, 4000) });
          return { output };
        } catch (error) {
          const message = String((error as Error)?.message ?? error);
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
      attach({ status: 'error', endedAt: Date.now(), error: message });
      return { output: `Tool failed: ${message}` };
    }
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
    this.emitEvent({ type: 'approval', approval: request });
    return new Promise<ApprovalDecision>((resolve) => {
      this.approvals.set(request.id, { request, resolve });
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
    default:
      return 'do this without asking';
  }
}

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
