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
  /**
   * An AG-UI endpoint that runs this bot's turns instead of Halo's own loop.
   *
   * The agent on the other end can be written on any framework. It is offered Halo's toolset and
   * every call it makes comes back through the same approval gate and audit trail, so hosting
   * somebody else's agent does not mean trusting it. Only a person can set this.
   */
  endpoint?: string;
  /** Sent as the Authorization header to that endpoint. Sealed with the OS keychain like the API key. */
  endpointAuth?: string;
  /**
   * Which preset voice this bot uses, from host/personas.ts. Empty means the default colleague.
   * Kept beside `persona` rather than resolved into it, so the picker can show what is selected and
   * a preset that is later reworded reaches the bots already using it.
   */
  personaId?: string;
  /** A voice written by hand. When set it replaces the preset entirely. */
  persona?: string;
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

export type ApprovalSurface =
  | 'external_shell'
  | 'external_read'
  | 'shell'
  | 'browser'
  | 'file_write'
  | 'agent_write'
  /**
   * Changing or running something in the user's automation tool.
   *
   * Its own surface rather than a borrowed one, because the risk is its own shape: an n8n workflow is
   * not a file and not a command, it is a thing that keeps running after the bot has stopped and can
   * reach every service the user connected to it. Borrowing `external_shell` would have made the
   * approval card say "run a command on your computer", which is not what is being approved.
   */
  | 'automation';

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
  /** The command verbatim, when there is one. "Always allow" is scoped to how it starts. */
  command?: string;
  /** What the action does, so the card can say it and a remembered rule can name it. */
  intent?: string;
}

export type ApprovalDecision = 'always' | 'once' | 'never';

export type RoutineTrigger =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number }
  /** Fired by an HTTP POST to Halo's loopback listener rather than by the clock. */
  | { kind: 'webhook'; token: string };

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
  /**
   * Consecutive failures. A routine that has failed this many times in a row is paused rather than
   * left to fail on a schedule for a week with nobody reading the history.
   */
  failureStreak?: number;
  /**
   * Feeds the routine its own last result on the next run.
   *
   * A watcher that cannot see what it said last time reports the same thing every hour. With this
   * it can say "still down" once and then stay quiet. Borrowed from Hermes's cron continuity.
   */
  continuity?: boolean;
  /** The last thing this routine reported, kept only when `continuity` is on. */
  lastOutput?: string;
}

export interface AutoReviewRule {
  id: string;
  when: string;
  decision: 'allow' | 'ask' | 'deny';
  /** Narrows the rule to one kind of action. Without it the rule is matched on its words alone. */
  surface?: ApprovalSurface;
  /** Narrows the rule to one effect: run_command, write_file, navigate, and so on. */
  intent?: string;
  /**
   * Narrows the rule to commands beginning this way.
   *
   * This is what "Always allow" writes now. A rule that only said "run a command on your computer"
   * matched every later command word for word, so one approval became standing permission to run
   * anything; a prefix keeps the permission to the shape of command that was actually approved.
   */
  commandPrefix?: string;
  /**
   * A rule written as an expression instead of as fields.
   *
   * `intent == "run_command" && contains(command, "npm publish")`. When present it is the whole
   * test — surface, intent and commandPrefix are ignored, because one rule meaning different things
   * depending on which boxes happen to be filled in is worse than two rules.
   */
  expression?: string;
}

/** One decided action, written before it runs. See host/audit.ts. */
export interface AuditRow {
  at: number;
  agentId: string;
  agentName: string;
  tool: string;
  surface: ApprovalSurface | 'plugin';
  intent?: string;
  summary: string;
  detail: string;
  outcome: 'allowed' | 'refused' | 'failed';
  /** Where the verdict came from: hardline, rule, dangerous, granted, mode, review, base. */
  source: string;
  /** The rule or pattern that decided it, when one did. */
  matched?: string;
  /** Set only on a permitted action that then did not succeed. */
  failure?: string;
  /** Present when the decision was recorded but not enforced, because the policy is in dry-run. */
  dryRun?: boolean;
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
  /**
   * What language bots answer in. `match` follows the user message by message; anything else is a
   * language name the prompt names outright. See host/personas.ts.
   */
  replyLanguage: string;
  timezone: string;
  localExecution: 'ask' | 'allow' | 'never';
  /** The master switch. With it off nothing is reviewed and nothing is asked. */
  autoReview: boolean;
  /** rules: local rules only. smart: rules plus a model review of risky actions. */
  autoReviewMode: 'rules' | 'smart';
  /**
   * enforce blocks what the policy refuses. dry-run decides and records and lets the work continue.
   *
   * Dry-run is how somebody writes a rule against real work and reads the audit trail before it
   * starts refusing things. A boundary nobody dares switch on is not a boundary. The hardline floor
   * ignores this: it refuses in both modes.
   */
  policyMode: 'enforce' | 'dry-run';
  startAtLogin: boolean;
  onboarded: boolean;
  minimizeToTray: boolean;
  rules: AutoReviewRule[];
  webSearch: { enabled: boolean; endpoint: string };
  /**
   * The user's own n8n, so a bot can read, write and fire their automations.
   *
   * n8n is where a lot of people already keep the integrations Halo does not have — a bot that can
   * write an n8n workflow inherits every service they have connected to it, which is a far better
   * trade than growing a connector per vendor. The key is sealed like the model key.
   */
  n8n: { enabled: boolean; baseUrl: string; apiKey: string };
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
  /** Who is driving the bot's browser, and why it asked. */
  | { type: 'control'; agentId: string; holder: 'bot' | 'human'; requested: boolean; instruction?: string }
  | { type: 'audit'; row: AuditRow }
  | { type: 'error'; agentId?: string; message: string };

/** Who has the wheel on one bot's browser. */
export interface ControlState {
  holder: 'bot' | 'human';
  since: number;
  /** True once the bot has asked for help and nobody has taken the wheel yet. */
  requested: boolean;
  /** What the bot needs the person to do, shown on the takeover bar. */
  instruction?: string;
}
