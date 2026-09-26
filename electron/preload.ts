import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Agent, ApprovalDecision, AuditRow, AuditVerdict, Channel, ControlState, HaloEvent, Message, Routine, Settings, Snapshot } from '../host/types';
import type { McpServerSpec, McpServerStatus } from '../host/mcp';

type Rect = { x: number; y: number; width: number; height: number };

const api = {
  snapshot: (): Promise<Snapshot> => ipcRenderer.invoke('halo:snapshot'),
  transcript: (agentId: string): Promise<Message[]> => ipcRenderer.invoke('halo:transcript', agentId),
  busy: (agentId: string): Promise<boolean> => ipcRenderer.invoke('halo:busy', agentId),
  previews: (): Promise<Record<string, { text: string; at: number; fromAgentId?: string }>> => ipcRenderer.invoke('halo:previews'),

  createAgent: (input: Partial<Agent> & { name: string }): Promise<Agent> => ipcRenderer.invoke('halo:agent.create', input),
  updateAgent: (id: string, patch: Partial<Agent>): Promise<Agent | null> => ipcRenderer.invoke('halo:agent.update', id, patch),
  deleteAgent: (id: string): Promise<void> => ipcRenderer.invoke('halo:agent.delete', id),
  duplicateAgent: (id: string): Promise<Agent | null> => ipcRenderer.invoke('halo:agent.duplicate', id),
  exportAgent: (id: string): Promise<string | null> => ipcRenderer.invoke('halo:agent.export', id),
  importAgent: (): Promise<Agent | null> => ipcRenderer.invoke('halo:agent.import'),

  createChannel: (name: string, memberIds: string[]): Promise<Channel> => ipcRenderer.invoke('halo:channel.create', name, memberIds),
  updateChannel: (id: string, patch: Partial<Channel>): Promise<Channel | null> => ipcRenderer.invoke('halo:channel.update', id, patch),
  deleteChannel: (id: string): Promise<void> => ipcRenderer.invoke('halo:channel.delete', id),

  send: (agentId: string, text: string, attachments: { path: string; name: string; size: number }[] = []): Promise<Message> =>
    ipcRenderer.invoke('halo:send', agentId, text, attachments),
  stop: (agentId: string): Promise<void> => ipcRenderer.invoke('halo:stop', agentId),
  respondApproval: (id: string, decision: ApprovalDecision): Promise<void> => ipcRenderer.invoke('halo:approval', id, decision),

  saveSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('halo:settings.save', patch),
  models: (): Promise<string[] | { error: string }> => ipcRenderer.invoke('halo:settings.models'),
  probeProvider: (baseUrl: string, apiKey: string): Promise<string[] | { error: string }> =>
    ipcRenderer.invoke('halo:probeProvider', baseUrl, apiKey),

  saveRoutine: (input: Record<string, unknown>): Promise<Routine | null> => ipcRenderer.invoke('halo:routine.save', input),
  deleteRoutine: (id: string): Promise<void> => ipcRenderer.invoke('halo:routine.delete', id),
  runRoutine: (id: string): Promise<void> => ipcRenderer.invoke('halo:routine.run', id),
  webhookUrl: (token: string): Promise<string> => ipcRenderer.invoke('halo:webhook.url', token),

  computerShow: (agentId: string, bounds: Rect): Promise<void> => ipcRenderer.invoke('halo:computer.show', agentId, bounds),
  computerHide: (): Promise<void> => ipcRenderer.invoke('halo:computer.hide'),
  computerBounds: (bounds: Rect): Promise<void> => ipcRenderer.invoke('halo:computer.bounds', bounds),
  computerNavigate: (agentId: string, url: string): Promise<{ url: string; title: string }> =>
    ipcRenderer.invoke('halo:computer.navigate', agentId, url),
  computerThumbnail: (agentId: string): Promise<string | null> => ipcRenderer.invoke('halo:computer.thumbnail', agentId),
  computerPreview: (agentId: string, bounds: Rect): Promise<void> => ipcRenderer.invoke('halo:computer.preview', agentId, bounds),
  computerPreviewClear: (): Promise<void> => ipcRenderer.invoke('halo:computer.preview.clear'),
  computerSuspend: (suspended: boolean): Promise<void> => ipcRenderer.invoke('halo:computer.suspend', suspended),
  teachStart: (agentId: string): Promise<void> => ipcRenderer.invoke('halo:teach.start', agentId),
  teachStatus: (): Promise<{ agentId: string; seconds: number; steps: number } | null> => ipcRenderer.invoke('halo:teach.status'),
  teachStop: (): Promise<{ agentId: string; steps: string; count: number } | null> => ipcRenderer.invoke('halo:teach.stop'),

  deleteMessage: (conversationId: string, messageId: string): Promise<void> =>
    ipcRenderer.invoke('halo:message.delete', conversationId, messageId),
  reactToMessage: (conversationId: string, messageId: string, emoji: string): Promise<void> =>
    ipcRenderer.invoke('halo:message.react', conversationId, messageId, emoji),
  answerWidget: (conversationId: string, messageId: string, value: string): Promise<void> =>
    ipcRenderer.invoke('halo:message.answer', conversationId, messageId, value),
  skills: (agentId: string): Promise<{ id: string; name: string; description: string; body: string }[]> =>
    ipcRenderer.invoke('halo:skills', agentId),
  deleteSkill: (agentId: string, name: string): Promise<boolean> => ipcRenderer.invoke('halo:skill.delete', agentId, name),

  tasks: (
    agentId: string,
  ): Promise<{ id: string; kind: string; description: string; status: string; seconds: number; steps: number }[]> =>
    ipcRenderer.invoke('halo:tasks', agentId),
  stopTask: (id: string): Promise<string> => ipcRenderer.invoke('halo:task.stop', id),

  usage: (
    days: number,
  ): Promise<{
    totals: { prompt: number; completion: number; turns: number; seconds: number };
    byAgent: { id: string; name: string; prompt: number; completion: number; turns: number; seconds: number }[];
  }> => ipcRenderer.invoke('halo:usage', days),

  search: (
    query: string,
  ): Promise<{ conversationId: string; name: string; messageId: string; text: string; role: string; createdAt: number }[]> =>
    ipcRenderer.invoke('halo:search', query),

  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('halo:attach'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('halo:pickFolder'),
  pickAvatar: (agentId: string): Promise<Agent | null> => ipcRenderer.invoke('halo:agent.avatar', agentId),
  /** Real path of a dropped or pasted file — the renderer never sees it otherwise. */
  filePath: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('halo:openPath', path),
  openDataDir: (): Promise<string> => ipcRenderer.invoke('halo:openDataDir'),
  setTheme: (theme: 'dark' | 'light'): Promise<void> => ipcRenderer.invoke('halo:theme', theme),
  checkProvider: (): Promise<void> => ipcRenderer.invoke('halo:provider.check'),
  reportUnread: (counts: Record<string, number>): Promise<void> => ipcRenderer.invoke('halo:unread', counts),
  quit: (): Promise<void> => ipcRenderer.invoke('halo:quit'),

  pluginCatalog: (): Promise<McpServerSpec[]> => ipcRenderer.invoke('halo:plugins.catalog'),
  pluginTools: (id: string): Promise<{ name: string; description: string }[]> => ipcRenderer.invoke('halo:plugins.tools', id),
  addCustomPlugin: (input: { name: string; command: string; args: string; description: string }): Promise<McpServerSpec | null> =>
    ipcRenderer.invoke('halo:plugins.addCustom', input),
  addPluginsFromJson: (text: string): Promise<{ added: string[]; error?: string }> =>
    ipcRenderer.invoke('halo:plugins.addFromJson', text),
  pluginsInstalled: (): Promise<McpServerSpec[]> => ipcRenderer.invoke('halo:plugins.installed'),
  pluginStatus: (): Promise<McpServerStatus[]> => ipcRenderer.invoke('halo:plugins.status'),
  installPlugin: (spec: McpServerSpec): Promise<McpServerStatus[]> => ipcRenderer.invoke('halo:plugins.install', spec),
  removePlugin: (id: string): Promise<McpServerStatus[]> => ipcRenderer.invoke('halo:plugins.remove', id),
  togglePlugin: (id: string, enabled: boolean): Promise<McpServerStatus[]> => ipcRenderer.invoke('halo:plugins.toggle', id, enabled),
  audit: (options: { limit?: number; agentId?: string; outcome?: 'allowed' | 'refused' | 'failed'; query?: string } = {}): Promise<AuditRow[]> =>
    ipcRenderer.invoke('halo:audit', options),
  auditSummary: (days: number): Promise<{ allowed: number; refused: number; failed: number }> =>
    ipcRenderer.invoke('halo:audit.summary', days),
  auditVerify: (): Promise<AuditVerdict> => ipcRenderer.invoke('halo:audit.verify'),
  openLogs: (): Promise<string> => ipcRenderer.invoke('halo:openLogs'),
  diagnostics: (): Promise<string> => ipcRenderer.invoke('halo:diagnostics'),

  control: (agentId: string): Promise<ControlState> => ipcRenderer.invoke('halo:control', agentId),
  takeControl: (agentId: string): Promise<void> => ipcRenderer.invoke('halo:control.take', agentId),
  releaseControl: (agentId: string): Promise<void> => ipcRenderer.invoke('halo:control.release', agentId),

  boxDir: (agentId: string): Promise<string> => ipcRenderer.invoke('halo:boxDir', agentId),
  memory: (agentId: string): Promise<string> => ipcRenderer.invoke('halo:memory', agentId),
  saveMemory: (agentId: string, text: string): Promise<void> => ipcRenderer.invoke('halo:memory.save', agentId, text),

  onEvent: (handler: (event: HaloEvent) => void) => {
    const listener = (_e: unknown, event: HaloEvent) => handler(event);
    ipcRenderer.on('halo:event', listener);
    return () => {
      ipcRenderer.removeListener('halo:event', listener);
    };
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('halo', api);

export type HaloApi = typeof api;
