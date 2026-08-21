export type AgentStatus = 'idle' | 'working' | 'waiting' | 'sleeping';

export interface AgentAvatar {
  /** A picture the user picked; when set it replaces the drawn face. */
  image?: string;
  color: string; // token name: blue | orange | brown | cyan | purple | magenta | green | red | yellow | gray
  face: number; // 0..8
}

export interface Agent {
  id: string;
  name: string;
  title: string;
  description: string;
  avatar: AgentAvatar;
  notifications: boolean;
  createdAt: number;
  status: AgentStatus;
  lastActivityAt: number;
  pinned?: boolean;
  hidden?: boolean;
  /** Overrides the global model for this bot; empty means use the default. */
  model?: string;
  /** Per-bot override of the global "execution on your computer" setting. */
  localExecution?: 'inherit' | 'ask' | 'allow' | 'never';
  /** Folders on the user's machine this bot may work in without asking each time. */
  allowedPaths?: string[];
}

export interface UsageRow {
  at: number;
  agentId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  seconds: number;
}

export interface Channel {
  id: string;
  name: string;
  memberIds: string[];
  createdAt: number;
  lastActivityAt: number;
}

export type Role = 'user' | 'agent' | 'system';

export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'error' | 'denied';
  startedAt: number;
  endedAt?: number;
  result?: string;
  error?: string;
}

export interface WidgetOption {
  label: string;
  value: string;
  style?: 'default' | 'primary' | 'danger';
}

/** A question with buttons, answered by the user; their pick comes back as a normal reply. */
export interface Widget {
  prompt: string;
  options: WidgetOption[];
  allowCustom?: boolean;
  answered?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  updatedAt: number;
}

/** A muted, centered line in the transcript: permissions, routines, memory writes, handoffs. */
export interface SystemEvent {
  kind: 'permission' | 'routine' | 'memory' | 'agent' | 'handoff' | 'note';
  label: string;
  chip?: string;
  /** When the chip is a bot, its avatar is shown next to the name. */
  chipAgentId?: string;
}

export interface Message {
  id: string;
  agentId: string;
  role: Role;
  text: string;
  createdAt: number;
  reactions?: string[];
  fromAgentId?: string; // agent-to-agent delivery
  toAgentId?: string;
  toolCalls?: ToolCallRecord[];
  attachments?: { path: string; name: string; size: number }[];
  images?: { path: string; alt?: string }[];
  widget?: Widget;
  event?: SystemEvent;
}

export type ApprovalSurface = 'external_shell' | 'external_read' | 'shell' | 'browser' | 'file_write' | 'agent_write';

export interface ApprovalRequest {
  id: string;
  agentId: string;
  agentName: string;
  surface: ApprovalSurface;
  /** Question shown in the dock, phrased like the original: "Allow ... to ...?" */
  question: string;
  summary: string;
  detail: string;
  reason: string;
  createdAt: number;
}

export type ApprovalDecision = 'always' | 'once' | 'never';

export type RoutineTrigger =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number };

export interface RoutineRun {
  at: number;
  status: 'ok' | 'error';
  note?: string;
}

export interface Routine {
  id: string;
  agentId: string;
  name: string;
  /** What the bot does each time it fires, written to its future self. */
  prompt: string;
  /** A routine can fire on several schedules, like the original's "Add another". */
  triggers: RoutineTrigger[];
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runs?: RoutineRun[];
  /** Safety valve: a misconfigured routine cannot fire more than this in a day. */
  maxRunsPerDay?: number;
}

export interface AutoReviewRule {
  id: string;
  when: string;
  decision: 'allow' | 'ask' | 'deny';
}

export interface Settings {
  provider: {
    baseUrl: string;
    apiKey: string;
    model: string;
    /** some local servers ignore the tools field; keep a switch for the JSON fallback protocol */
    toolMode: 'native' | 'json';
    maxSteps: number;
    /** Cheap model for memory extraction and risk review; empty means reuse the main one. */
    helperModel: string;
    /** Tokens of history kept before older turns are folded into a summary. */
    contextBudget: number;
    /** Send screenshots and attached images to the model. Turn off for text-only models. */
    vision: boolean;
    /** OpenAI-compatible image endpoint; empty disables GenerateImage. */
    imageBaseUrl: string;
    imageModel: string;
  };
  theme: 'system' | 'dark' | 'light';
  timezone: string;
  localExecution: 'ask' | 'allow' | 'never';
  /** The master switch. With it off nothing is reviewed and nothing is asked. */
  autoReview: boolean;
  /** rules: local rules only. smart: rules plus a model review of risky actions. */
  autoReviewMode: 'rules' | 'smart';
  startAtLogin: boolean;
  onboarded: boolean;
  minimizeToTray: boolean;
  rules: AutoReviewRule[];
  webSearch: { enabled: boolean; endpoint: string };
  /** Sidebar grouping; anything not listed here shows under the ungrouped bots. */
  sections: { id: string; name: string; agentIds: string[]; collapsed?: boolean }[];
  /** Installed MCP plugins; the shape matches McpServerSpec. */
  plugins: {
    id: string;
    name: string;
    description: string;
    category: string;
    command: string;
    args: string[];
    requires?: { key: string; label: string; hint?: string; placeholder?: string; flag?: string }[];
    setup?: { key: string; label: string; hint?: string; placeholder?: string; flag?: string }[];
    /** Secrets, sealed with the OS keychain before they reach disk. */
    env?: Record<string, string>;
    /** Non-secret answers appended to the command line. */
    config?: Record<string, string>;
    enabled?: boolean;
    icon?: string;
    featured?: boolean;
    source?: string;
    remote?: boolean;
  }[];
}

/** Everything the renderer needs on boot. */
export interface Snapshot {
  agents: Agent[];
  channels: Channel[];
  settings: Settings;
  routines: Routine[];
  approvals: ApprovalRequest[];
  activeAgentId: string | null;
}

export type HaloEvent =
  | { type: 'agents'; agents: Agent[] }
  | { type: 'message'; message: Message }
  | { type: 'message.patch'; agentId: string; messageId: string; text?: string; reactions?: string[] }
  | { type: 'tool'; agentId: string; messageId: string; call: ToolCallRecord }
  | { type: 'status'; agentId: string; status: AgentStatus; note?: string }
  | { type: 'approval'; approval: ApprovalRequest }
  | { type: 'approval.resolved'; id: string; approved: boolean }
  | { type: 'channels'; channels: Channel[] }
  /** Tray or a notification asking the window to open a particular conversation. */
  | { type: 'focus'; agentId: string }
  | { type: 'teaching'; agentId: string; recording: boolean; seconds: number; steps: number }
  | { type: 'provider'; ok: boolean; baseUrl: string; model: string; error?: string; kind?: 'unreachable' | 'model' }
  | { type: 'routines'; routines: Routine[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'computer'; agentId: string; url: string; title: string; visible: boolean }
  | { type: 'error'; agentId?: string; message: string };
