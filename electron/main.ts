import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Notification, Tray, Menu, nativeImage, type Rectangle } from 'electron';
import { join, basename, extname } from 'node:path';
import { totalmem } from 'node:os';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Store } from '../host/store';
import { Runner } from '../host/runner';
import { Scheduler, nextRun } from '../host/scheduler';
import { Computer } from './computer';
import { buildPortableBot, parsePortableBot } from '../host/portable';
import { McpManager, MCP_CATALOG, type McpServerSpec } from '../host/mcp';
import { listModels, listModelsDetailed, rankModels } from '../host/provider';
import { parseTrigger } from '../host/tools';
import type { Agent, ApprovalDecision, Channel, HaloEvent, Routine, Settings } from '../host/types';

const DEV = process.env.HALO_DEV === '1';
const BG = '#070707';
const TITLEBAR_HEIGHT = 51;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: Store;
let runner: Runner;
let computer: Computer;
let scheduler: Scheduler;
let mcp: McpManager;
let quitting = false;

function emit(event: HaloEvent) {
  if (win && !win.isDestroyed()) win.webContents.send('halo:event', event);
  if (event.type === 'status' || event.type === 'agents') refreshTray();
  // A bot waiting on permission is the one thing worth interrupting the user for.
  if (event.type === 'approval' && Notification.isSupported() && !win?.isFocused()) {
    const notification = new Notification({
      title: `${event.approval.agentName} needs permission`,
      body: event.approval.summary,
      urgency: 'critical',
    });
    notification.on('click', () => {
      win?.show();
      win?.focus();
      emit({ type: 'focus', agentId: event.approval.agentId });
    });
    notification.show();
  }
}

function windowStatePath() {
  return join(app.getPath('userData'), 'window.json');
}

function loadWindowState(): { width: number; height: number; x?: number; y?: number; maximized?: boolean } {
  try {
    const raw = JSON.parse(readFileSync(windowStatePath(), 'utf8'));
    if (typeof raw.width === 'number' && typeof raw.height === 'number') return raw;
  } catch { /* first run */ }
  return { width: 1180, height: 820 };
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getNormalBounds();
  writeFileSync(windowStatePath(), JSON.stringify({ ...bounds, maximized: win.isMaximized() }, null, 2), 'utf8');
}

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 512,
    minHeight: 520,
    backgroundColor: BG,
    show: false,
    title: 'Halo Bot',
    frame: process.platform !== 'win32',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { color: BG, symbolColor: '#fcfcfc', height: TITLEBAR_HEIGHT } }
      : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      spellcheck: true,
    },
  });

  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  win.on('close', (event) => {
    saveWindowState();
    // Bots keep working in the background, exactly like the original — closing hides to tray.
    if (!quitting && tray && store.getSettings().minimizeToTray) {
      event.preventDefault();
      win?.hide();
    }
  });
  win.on('resize', saveWindowState);
  win.on('move', saveWindowState);
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV) {
    void win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/** Tray menu lists the bots, so the app is usable while the window is closed. */
function refreshTray() {
  if (!tray) return;
  const agents = store.listAgents().filter((a) => !a.hidden);
  const working = agents.filter((a) => a.status === 'working').length;
  const unread = totalUnread();

  tray.setToolTip(working > 0 ? `Halo Bot — ${working} working` : 'Halo Bot');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: working > 0 ? `${working} bot${working === 1 ? '' : 's'} working` : 'All bots idle', enabled: false },
      { type: 'separator' },
      ...agents.slice(0, 12).map((agent) => ({
        label: `${agent.status === 'working' ? '● ' : ''}${agent.name}`,
        click: () => {
          win?.show();
          win?.focus();
          emit({ type: 'focus', agentId: agent.id });
        },
      })),
      ...(agents.length > 0 ? [{ type: 'separator' as const }] : []),
      { label: 'Open Halo Bot', click: () => { win?.show(); win?.focus(); } },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]),
  );

  if (process.platform === 'win32' && win && !win.isDestroyed()) {
    win.setOverlayIcon(unread > 0 ? badgeIcon(unread) : null, unread > 0 ? `${unread} unread` : '');
  }
}

let unreadByAgent = new Map<string, number>();

function totalUnread(): number {
  let total = 0;
  for (const [, count] of unreadByAgent) total += count;
  return total;
}

/** Small red count drawn as an SVG data URL — no asset files needed. */
function badgeIcon(count: number) {
  const label = count > 9 ? '9+' : String(count);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#ff263c"/><text x="16" y="22" font-family="Segoe UI, sans-serif" font-size="17" font-weight="600" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    // 16x16 blue dot — placeholder tray icon
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVR42mNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsHQBQCk0AAB6mCJ7QAAAABJRU5ErkJggg==',
  );
  tray = new Tray(icon);
  tray.on('double-click', () => { win?.show(); win?.focus(); });
  tray.on('click', () => { win?.show(); win?.focus(); });
  refreshTray();
}

function notify(agent: Agent, message: { text: string }) {
  if (!Notification.isSupported()) return;
  if (win?.isFocused()) return;
  const n = new Notification({ title: agent.name, body: message.text.slice(0, 220) });
  n.on('click', () => { win?.show(); win?.focus(); });
  n.show();
}

let providerHealthy: boolean | null = null;

/** Tells the user the model server is down before a bot fails mid-task. */
async function checkProvider(force = false) {
  const provider = store.getSettings().provider;
  // No default model ships any more: a made-up tag fails on the first turn instead of at setup.
  if (!provider.model.trim()) {
    if (force || providerHealthy !== false) {
      providerHealthy = false;
      emit({
        type: 'provider',
        ok: false,
        baseUrl: provider.baseUrl,
        model: '',
        error: 'no model chosen yet — pick one in Settings → Model',
        kind: 'model',
      });
    }
    return;
  }
  try {
    const detailed = await listModelsDetailed(provider);
    const models = detailed.map((m) => m.id);
    const chosen = detailed.find((m) => m.id === provider.model);
    // A model without tool support cannot drive anything, so say so instead of failing every turn.
    if (chosen?.capabilities && chosen.capabilities.length > 0 && !chosen.capabilities.includes('tools')) {
      providerHealthy = false;
      emit({
        type: 'provider',
        ok: false,
        baseUrl: provider.baseUrl,
        model: provider.model,
        error: `${provider.model} does not support tool calling — pick another model`,
        kind: 'model',
      });
      return;
    }
    const ok = models.length > 0;
    if (force || providerHealthy !== ok) {
      providerHealthy = ok;
      emit({
        type: 'provider',
        ok,
        baseUrl: provider.baseUrl,
        model: provider.model,
        ...(ok ? {} : { error: 'the server answered but offers no models', kind: 'model' as const }),
      });
    }
  } catch (error) {
    if (force || providerHealthy !== false) {
      providerHealthy = false;
      emit({
        type: 'provider',
        ok: false,
        baseUrl: provider.baseUrl,
        model: provider.model,
        error: String((error as Error).message ?? error).slice(0, 200),
        kind: 'unreachable',
      });
    }
  }
}

/** Writes the real outcome of a routine turn into its history once the turn has finished. */
function recordRoutineRun(id: string, at: number, ok: boolean, note?: string) {
  const routine = store.getRoutine(id);
  if (!routine) return;
  store.saveRoutine({
    ...routine,
    runs: [...(routine.runs ?? []), { at, status: ok ? ('ok' as const) : ('error' as const), ...(note ? { note } : {}) }].slice(-20),
  });
  emit({ type: 'routines', routines: store.listRoutines() });
}

/** OS-backed encryption for the api key and plugin credentials. Undefined where it is unavailable. */
function secretCodec() {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  return {
    encrypt: (value: string) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value: string) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  };
}

function snapshot() {
  return {
    agents: store.listAgents(),
    channels: store.listChannels(),
    settings: store.getSettings(),
    routines: store.listRoutines(),
    approvals: runner.pendingApprovals(),
    activeAgentId: store.listAgents()[0]?.id ?? null,
  };
}

function registerIpc() {
  ipcMain.handle('halo:snapshot', () => snapshot());
  ipcMain.handle('halo:transcript', (_e, agentId: string) => store.transcript(agentId));

  /** One line per conversation so the sidebar is right before anything is opened. */
  ipcMain.handle('halo:previews', () => {
    const previews: Record<string, { text: string; at: number; fromAgentId?: string }> = {};
    for (const conversation of [...store.listAgents(), ...store.listChannels()]) {
      const last = [...store.transcript(conversation.id)].reverse().find((m) => m.text.trim().length > 0);
      if (last) {
        previews[conversation.id] = {
          text: last.text.slice(0, 200),
          at: last.createdAt,
          ...(last.fromAgentId ? { fromAgentId: last.fromAgentId } : {}),
        };
      }
    }
    return previews;
  });
  ipcMain.handle('halo:busy', (_e, agentId: string) => runner.isBusy(agentId));

  ipcMain.handle('halo:agent.create', (_e, input: Partial<Agent> & { name: string }) => {
    const agent = store.createAgent(input);
    emit({ type: 'agents', agents: store.listAgents() });
    // greet, so a fresh bot behaves like a colleague instead of an empty box
    const greeting = store.appendMessage({
      id: randomUUID(),
      agentId: agent.id,
      role: 'agent',
      text: `Hey, I'm ${agent.name}. What do you want me working on? Give me something concrete and I'll take it from there.`,
      createdAt: Date.now(),
    });
    emit({ type: 'message', message: greeting });

    // Like the original's kickstart: a bot created with a role does a first pass on its own.
    if (agent.description.trim().length > 0) {
      runner.submitSystemTurn(
        agent.id,
        [
          'You were just created for this role. Take one short first pass on your own:',
          'look at what is already in your box, set up whatever your role needs (folders, a catalog, a routine),',
          'then send ONE short message saying what you found and what you will do. Do not ask questions yet.',
        ].join(' '),
        'First pass',
        'note',
      );
    }
    return agent;
  });

  ipcMain.handle('halo:agent.update', (_e, id: string, patch: Partial<Agent>) => {
    const next = runner.updateAgent(id, patch);
    return next ?? null;
  });

  ipcMain.handle('halo:agent.duplicate', (_e, id: string) => {
    const copy = store.duplicateAgent(id);
    emit({ type: 'agents', agents: store.listAgents() });
    return copy ?? null;
  });

  ipcMain.handle('halo:agent.delete', (_e, id: string) => {
    runner.stop(id);
    store.deleteAgent(id);
    emit({ type: 'agents', agents: store.listAgents() });
    emit({ type: 'routines', routines: store.listRoutines() });
  });

  ipcMain.handle('halo:send', (_e, targetId: string, text: string, attachments: { path: string; name: string; size: number }[]) =>
    store.getChannel(targetId)
      ? runner.submitChannelMessage(targetId, text)
      : runner.submitUserMessage(targetId, text, attachments ?? []),
  );

  ipcMain.handle('halo:channel.create', (_e, name: string, memberIds: string[]) => {
    const channel = store.createChannel(name, memberIds);
    emit({ type: 'channels', channels: store.listChannels() });
    return channel;
  });

  ipcMain.handle('halo:channel.update', (_e, id: string, patch: Partial<Channel>) => {
    const next = store.updateChannel(id, patch);
    emit({ type: 'channels', channels: store.listChannels() });
    return next ?? null;
  });

  ipcMain.handle('halo:channel.delete', (_e, id: string) => {
    store.deleteChannel(id);
    emit({ type: 'channels', channels: store.listChannels() });
  });
  ipcMain.handle('halo:stop', (_e, agentId: string) => runner.stop(agentId));
  ipcMain.handle('halo:approval', (_e, id: string, decision: ApprovalDecision) => runner.resolveApproval(id, decision));

  ipcMain.handle('halo:settings.save', (_e, patch: Partial<Settings>) => {
    const next = store.saveSettings(patch);
    if (patch.startAtLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: patch.startAtLogin, args: ['--hidden'] });
    }
    emit({ type: 'settings', settings: next });
    return next;
  });

  /** The renderer owns unread counts; the tray badge mirrors them. */
  ipcMain.handle('halo:unread', (_e, counts: Record<string, number>) => {
    unreadByAgent = new Map(Object.entries(counts));
    refreshTray();
  });
  ipcMain.handle('halo:probeProvider', async (_e, baseUrl: string, apiKey: string) => {
    try {
      const detailed = await listModelsDetailed({ ...store.getSettings().provider, baseUrl, apiKey });
      const ranked = rankModels(detailed, totalmem());
      return ranked.map((m) => m.id);
    } catch (error) {
      return { error: String((error as Error).message ?? error) };
    }
  });

  ipcMain.handle('halo:settings.models', async () => {
    try {
      return await listModels(store.getSettings().provider);
    } catch (error) {
      return { error: String((error as Error).message ?? error) };
    }
  });

  ipcMain.handle('halo:routine.save', (_e, input: Partial<Routine> & { agentId: string; name: string; prompt: string }) => {
    const fromArgs = parseTrigger({
      every_minutes: (input as Record<string, unknown>).every_minutes,
      daily_at: (input as Record<string, unknown>).daily_at,
      weekdays_at: (input as Record<string, unknown>).weekdays_at,
      weekly_on: (input as Record<string, unknown>).weekly_on,
    });
    const triggers = input.triggers?.length ? input.triggers : fromArgs ? [fromArgs] : [];
    if (triggers.length === 0) return null;
    const routine: Routine = {
      id: input.id ?? randomUUID(),
      agentId: input.agentId,
      name: input.name,
      prompt: input.prompt,
      triggers,
      enabled: input.enabled ?? true,
      createdAt: input.createdAt ?? Date.now(),
      nextRunAt: nextRun({ triggers }),
      ...(input.runs ? { runs: input.runs } : {}),
      ...(input.maxRunsPerDay ? { maxRunsPerDay: input.maxRunsPerDay } : {}),
      ...(input.lastRunAt ? { lastRunAt: input.lastRunAt } : {}),
    };
    store.saveRoutine(routine);
    emit({ type: 'routines', routines: store.listRoutines() });
    return routine;
  });
  ipcMain.handle('halo:routine.delete', (_e, id: string) => {
    store.deleteRoutine(id);
    emit({ type: 'routines', routines: store.listRoutines() });
  });
  ipcMain.handle('halo:routine.run', (_e, id: string) => {
    const routine = store.getRoutine(id);
    if (!routine) return;
    const at = Date.now();
    runner.submitSystemTurn(routine.agentId, routine.prompt, `Routine "${routine.name}" (test run)`, 'routine', (ok, note) =>
      recordRoutineRun(id, at, ok, note ? `test run — ${note}` : 'test run'),
    );
    store.saveRoutine({ ...routine, lastRunAt: at });
    emit({ type: 'routines', routines: store.listRoutines() });
  });

  ipcMain.handle('halo:computer.show', (_e, agentId: string, bounds: Rectangle) => {
    computer.setBounds(bounds);
    computer.show(agentId);
  });
  ipcMain.handle('halo:computer.hide', () => computer.hide());
  ipcMain.handle('halo:computer.bounds', (_e, bounds: Rectangle) => computer.setBounds(bounds));
  ipcMain.handle('halo:computer.navigate', (_e, agentId: string, url: string) => computer.navigate(agentId, url));
  ipcMain.handle('halo:computer.thumbnail', (_e, agentId: string) => computer.thumbnail(agentId));
  ipcMain.handle('halo:computer.preview', (_e, agentId: string, bounds: Rectangle) => computer.preview(agentId, bounds));
  ipcMain.handle('halo:computer.preview.clear', () => computer.clearPreview());
  ipcMain.handle('halo:computer.suspend', (_e, suspended: boolean) => computer.setSuspended(suspended));

  ipcMain.handle('halo:teach.start', async (_e, agentId: string) => {
    await computer.startTeaching(agentId);
  });

  ipcMain.handle('halo:teach.status', () => computer.teachingStatus());

  ipcMain.handle('halo:teach.stop', async () => {
    const result = await computer.stopTeaching();
    if (!result) return null;
    if (result.count === 0) {
      runner.systemEvent(result.agentId, { kind: 'note', label: 'Nothing was recorded' });
      return result;
    }
    runner.submitSystemTurn(
      result.agentId,
      [
        'The user just demonstrated a task on your screen. Here is exactly what they did:',
        '',
        result.steps,
        '',
        'Turn this into a reusable skill with SaveSkill: a clear name, a description that starts with "use this when",',
        'and a body with the steps written so you can follow them yourself later (keep the selectors).',
        'Then send one short message naming the skill you saved.',
      ].join('\n'),
      'Learn from demonstration',
      'note',
    );
    return result;
  });

  ipcMain.handle('halo:attach', async () => {
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return result.filePaths;
  });

  ipcMain.handle('halo:message.delete', (_e, conversationId: string, messageId: string) => {
    store.deleteMessage(conversationId, messageId);
  });

  ipcMain.handle('halo:message.react', (_e, conversationId: string, messageId: string, emoji: string) => {
    const message = store.transcript(conversationId).find((m) => m.id === messageId);
    if (!message) return;
    const reactions = [...(message.reactions ?? [])];
    const at = reactions.indexOf(emoji);
    if (at >= 0) reactions.splice(at, 1);
    else reactions.push(emoji);
    store.updateMessage(conversationId, messageId, { reactions });
    emit({ type: 'message.patch', agentId: conversationId, messageId, reactions });
  });

  ipcMain.handle('halo:agent.export', async (_e, id: string) => {
    const agent = store.getAgent(id);
    if (!agent || !win) return null;
    const result = await dialog.showSaveDialog(win, {
      defaultPath: `${agent.name.replace(/[^\w -]/g, '')}.halobot.json`,
      filters: [{ name: 'Halo bot', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;

    const skillsDir = join(store.agentDir(id), 'skills');
    const skills = existsSync(skillsDir)
      ? readdirSync(skillsDir)
          .filter((f) => f.endsWith('.md'))
          .map((file) => ({ file, body: readFileSync(join(skillsDir, file), 'utf8') }))
      : [];

    writeFileSync(
      result.filePath,
      JSON.stringify(
        buildPortableBot({
          agent,
          memory: runner.memory(id).exportText(),
          skills,
          routines: store.listRoutines().filter((r) => r.agentId === id),
        }),
        null,
        2,
      ),
      'utf8',
    );
    return result.filePath;
  });

  ipcMain.handle('halo:agent.import', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Halo bot', extensions: ['json'] }],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;

    let payload: ReturnType<typeof parsePortableBot> = null;
    try {
      payload = parsePortableBot(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return null;
    }
    if (!payload) return null;

    const agent = store.createAgent({
      name: payload.agent.name,
      title: payload.agent.title,
      description: payload.agent.description,
      avatar: payload.agent.avatar,
      ...(payload.agent.model ? { model: payload.agent.model } : {}),
    });
    if (payload.memory.trim()) runner.memory(agent.id).importText(payload.memory);
    if (payload.skills.length > 0) {
      const dir = join(store.agentDir(agent.id), 'skills');
      mkdirSync(dir, { recursive: true });
      for (const skill of payload.skills) writeFileSync(join(dir, basename(skill.file)), skill.body, 'utf8');
    }
    for (const routine of payload.routines) {
      store.saveRoutine({
        id: randomUUID(),
        agentId: agent.id,
        name: routine.name,
        prompt: routine.prompt,
        triggers: routine.triggers,
        enabled: routine.enabled,
        createdAt: Date.now(),
        nextRunAt: nextRun({ triggers: routine.triggers }),
      });
    }
    emit({ type: 'agents', agents: store.listAgents() });
    emit({ type: 'routines', routines: store.listRoutines() });
    return agent;
  });

  ipcMain.handle('halo:skills', (_e, agentId: string) => runner.skills(agentId).list());
  ipcMain.handle('halo:skill.delete', (_e, agentId: string, name: string) => runner.skills(agentId).delete(name));

  ipcMain.handle('halo:tasks', (_e, agentId: string) => runner.listTasks(agentId));
  ipcMain.handle('halo:task.stop', (_e, id: string) => runner.stopSubagent(id));

  ipcMain.handle('halo:usage', (_e, days: number) => {
    const since = Date.now() - Math.max(1, days) * 86_400_000;
    const rows = store.usage(since);
    const byAgent = new Map<string, { name: string; prompt: number; completion: number; turns: number; seconds: number }>();
    for (const row of rows) {
      const name = store.getAgent(row.agentId)?.name ?? 'Deleted bot';
      const cur = byAgent.get(row.agentId) ?? { name, prompt: 0, completion: 0, turns: 0, seconds: 0 };
      cur.prompt += row.promptTokens;
      cur.completion += row.completionTokens;
      cur.turns += 1;
      cur.seconds += row.seconds;
      byAgent.set(row.agentId, cur);
    }
    return {
      totals: rows.reduce(
        (acc, row) => ({
          prompt: acc.prompt + row.promptTokens,
          completion: acc.completion + row.completionTokens,
          turns: acc.turns + 1,
          seconds: acc.seconds + row.seconds,
        }),
        { prompt: 0, completion: 0, turns: 0, seconds: 0 },
      ),
      byAgent: [...byAgent.entries()].map(([id, value]) => ({ id, ...value })).sort((a, b) => b.completion - a.completion),
    };
  });

  ipcMain.handle('halo:search', (_e, query: string) => {
    const hits = store.search(query);
    return hits.map((hit) => ({
      conversationId: hit.conversationId,
      name: store.getAgent(hit.conversationId)?.name ?? store.getChannel(hit.conversationId)?.name ?? 'Unknown',
      messageId: hit.message.id,
      text: hit.message.text.slice(0, 200),
      role: hit.message.role,
      createdAt: hit.message.createdAt,
    }));
  });

  ipcMain.handle('halo:provider.check', () => checkProvider(true));

  ipcMain.handle('halo:theme', (_e, theme: 'dark' | 'light') => {
    if (!win || win.isDestroyed()) return;
    const background = theme === 'light' ? '#fcfcfc' : '#070707';
    win.setBackgroundColor(background);
    if (process.platform === 'win32') {
      win.setTitleBarOverlay({ color: background, symbolColor: theme === 'light' ? '#141414' : '#fcfcfc', height: TITLEBAR_HEIGHT });
    }
  });

  ipcMain.handle('halo:agent.avatar', async (_e, agentId: string) => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    const source = result.filePaths[0];
    if (result.canceled || !source) return null;

    const agent = store.getAgent(agentId);
    if (!agent) return null;
    const target = join(store.agentDir(agentId), `avatar${extname(source).toLowerCase()}`);
    copyFileSync(source, target);
    const next = runner.updateAgent(agentId, { avatar: { ...agent.avatar, image: target } });
    return next ?? null;
  });

  ipcMain.handle('halo:pickFolder', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('halo:openPath', (_e, path: string) => shell.openPath(path));
  ipcMain.handle('halo:openDataDir', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('halo:quit', () => {
    quitting = true;
    app.quit();
  });

  ipcMain.handle('halo:plugins.catalog', () => MCP_CATALOG);
  ipcMain.handle('halo:plugins.installed', () => store.getSettings().plugins);
  ipcMain.handle('halo:plugins.status', async () => {
    await mcp.startAll();
    return mcp.statuses();
  });

  ipcMain.handle('halo:plugins.install', async (_e, spec: McpServerSpec) => {
    const plugins = store.getSettings().plugins.filter((p) => p.id !== spec.id);
    const next = store.saveSettings({ plugins: [...plugins, { ...spec, enabled: true }] });
    emit({ type: 'settings', settings: next });
    await mcp.startAll();
    return mcp.statuses();
  });

  ipcMain.handle('halo:plugins.remove', async (_e, id: string) => {
    mcp.stop(id);
    const next = store.saveSettings({ plugins: store.getSettings().plugins.filter((p) => p.id !== id) });
    emit({ type: 'settings', settings: next });
    return mcp.statuses();
  });

  ipcMain.handle('halo:plugins.toggle', async (_e, id: string, enabled: boolean) => {
    const next = store.saveSettings({
      plugins: store.getSettings().plugins.map((p) => (p.id === id ? { ...p, enabled } : p)),
    });
    emit({ type: 'settings', settings: next });
    if (enabled) await mcp.startAll();
    else mcp.stop(id);
    return mcp.statuses();
  });
  ipcMain.handle('halo:boxDir', (_e, agentId: string) => store.boxDir(agentId));
  ipcMain.handle('halo:memory', (_e, agentId: string) => runner.memory(agentId).exportText());
  ipcMain.handle('halo:memory.save', (_e, agentId: string, text: string) => runner.memory(agentId).importText(text));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.halo.bot');
    store = new Store(app.getPath('userData'), secretCodec());
    createWindow();
    mcp = new McpManager(() => store.getSettings().plugins as McpServerSpec[]);
    void mcp.startAll();
    computer = new Computer(win!, (id) => store.boxDir(id), emit);
    computer.onHandOver = (agentId) => {
      win?.show();
      win?.webContents.send('halo:event', { type: 'computer', agentId, url: '', title: '', visible: true });
    };
    runner = new Runner({ store, computer, emit, notify, mcp });
    scheduler = new Scheduler(store, runner, emit);
    scheduler.start();
    createTray();
    registerIpc();
    app.setLoginItemSettings({ openAtLogin: store.getSettings().startAtLogin, args: ['--hidden'] });
    setTimeout(() => void checkProvider(true), 2500);
    setInterval(() => void checkProvider(), 60_000);
    if (process.argv.includes('--hidden')) win?.hide();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else win?.show();
    });
  });

  app.on('before-quit', () => {
    quitting = true;
    mcp?.stopAll();
    scheduler?.stop();
    computer?.dispose();
    store?.flush();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && quitting) app.quit();
  });
}
