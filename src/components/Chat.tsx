import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Agent, ApprovalRequest, Channel, Message, ToolCallRecord, Widget } from '../../host/types';
import { Avatar } from './Avatar';
import {
  ArrowUpIcon,
  MonitorIcon,
  PaperclipIcon,
  StopIcon,
  ChevronsRightIcon,
  CloseIcon,
  ClockIcon,
  ListIcon,
  WarningIcon,
  SmileIcon,
  ReplyIcon,
  CopyIcon,
  TrashIcon,
} from './Icons';

interface ChatProps {
  agent: Agent | null;
  channel?: Channel | null;
  members?: Agent[];
  allAgents?: Agent[];
  messages: Message[];
  approvals: ApprovalRequest[];
  status?: { status: Agent['status']; note?: string };
  computerOpen: boolean;
  onSend: (text: string, attachments: { path: string; name: string; size: number }[]) => Promise<void>;
  onStop: () => void;
  onToggleComputer: () => void;
  onOpenDetails: () => void;
  conversationId: string;
  onQuote: (text: string) => void;
  draft?: string;
  onDraftUsed?: () => void;
}

export function Chat({
  agent,
  channel,
  members = [],
  allAgents = [],
  messages,
  approvals,
  status,
  computerOpen,
  onSend,
  onStop,
  onToggleComputer,
  onOpenDetails,
  conversationId,
  onQuote,
  draft,
  onDraftUsed,
}: ChatProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showActivity, setShowActivity] = useState(false);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, approvals]);

  if (!agent && !channel) return <div className="chat" />;

  const title = channel ? channel.name : agent!.name;
  const byId = new Map(members.map((m) => [m.id, m]));
  const agentsById = new Map([...allAgents, ...members].map((m) => [m.id, m]));
  const working = channel
    ? members.some((m) => m.status === 'working')
    : status?.status === 'working' || agent!.status === 'working';
  // The original keeps the transcript conversational: no raw tool log unless you ask for it.
  const visible = messages.filter(
    (m) => showActivity || m.text.trim().length > 0 || m.event || m.widget || (m.toolCalls?.length ?? 0) > 0,
  );

  return (
    <div className="chat">
      <header className="chat__header">
        <button className="header-agent" onClick={onOpenDetails} aria-label="View agent settings">
          {channel ? (
            <span className="avatar-stack">
              {members.slice(0, 3).map((member) => (
                <Avatar key={member.id} agent={member} size={18} />
              ))}
            </span>
          ) : (
            <Avatar agent={agent!} size={20} />
          )}
          <span>{title}</span>
        </button>
        <div className="header-actions">
          <button
            className="icon-button"
            data-active={showActivity}
            onClick={() => setShowActivity((v) => !v)}
            aria-label="Show activity"
            title="Show what the bot is doing step by step"
          >
            <ListIcon />
          </button>
          {!channel && (
            <button
              className="icon-button"
              data-active={computerOpen}
              onClick={onToggleComputer}
              aria-label={`${agent!.name}'s computer`}
              title={`${agent!.name}'s computer`}
            >
              <MonitorIcon />
            </button>
          )}
          <button className="icon-button" onClick={onOpenDetails} aria-label="Toggle details">
            <ChevronsRightIcon />
          </button>
        </div>
      </header>

      <div
        className="transcript"
        ref={scroller}
        aria-label="Conversation transcript"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="transcript__inner">
          {visible.map((message, i) => (
            <MessageView
              key={message.id}
              message={message}
              previous={visible[i - 1]}
              sender={message.fromAgentId ? byId.get(message.fromAgentId) ?? null : agent}
              inChannel={Boolean(channel)}
              agentsById={agentsById}
              showActivity={showActivity}
              onAnswer={(value) => void onSend(value, [])}
              conversationId={conversationId}
              onQuote={onQuote}
            />
          ))}

          {visible.length === 0 && !working && agent && (
            <div className="chat-empty">
              <Avatar agent={agent} size={44} />
              <div className="chat-empty__title">{agent.name} is ready</div>
              <div className="chat-empty__hint">Give it something concrete. It works in the background and comes back when it matters.</div>
              <div className="chat-empty__ideas">
                {[
                  'Search the web for X and send me a short sourced summary.',
                  'Open my browser, sign in where needed, and pull the data I asked for.',
                  'Every weekday at 09:00, check X and send me one line.',
                ].map((idea) => (
                  <button key={idea} className="chat-empty__idea" onClick={() => onQuote(idea)}>
                    {idea}
                  </button>
                ))}
              </div>
            </div>
          )}

          {working && (
            <div className="status-line">
              <span className="spinner" />
              <span className="shimmer">
                {channel
                  ? `${members.filter((m) => m.status === 'working').map((m) => m.name).join(', ')} working`
                  : status?.note ?? `${agent!.name} is working`}
              </span>
            </div>
          )}
        </div>
      </div>

      {approvals.length > 0 && <ApprovalDock approval={approvals[0]!} />}

      <Composer agentName={title} working={working} onSend={onSend} onStop={onStop} draft={draft} onDraftUsed={onDraftUsed} />
    </div>
  );
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}

function eventIcon(kind: string) {
  if (kind === 'routine') return <ClockIcon size={12} />;
  if (kind === 'permission') return <WarningIcon size={12} />;
  return null;
}

function MessageView({
  message,
  previous,
  sender,
  inChannel,
  agentsById,
  showActivity,
  onAnswer,
  conversationId,
  onQuote,
}: {
  message: Message;
  previous?: Message;
  sender: Agent | null;
  inChannel: boolean;
  agentsById: Map<string, Agent>;
  showActivity: boolean;
  onAnswer: (value: string) => void;
  conversationId: string;
  onQuote: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const showDay = !previous || new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
  const tools = message.toolCalls ?? [];
  const hasText = message.text.trim().length > 0;

  if (message.event) {
    return (
      <>
        {showDay && <div className="day-divider">{dayLabel(message.createdAt)}</div>}
        <div className="system-event">
          {eventIcon(message.event.kind)}
          <span>{message.event.label}</span>
          {message.event.chip && (
            <span className="system-event__chip">
              {message.event.chipAgentId && agentsById.get(message.event.chipAgentId) && (
                <Avatar agent={agentsById.get(message.event.chipAgentId)!} size={13} />
              )}
              {message.event.chip}
            </span>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {showDay && <div className="day-divider">{dayLabel(message.createdAt)}</div>}
      <div className="msg" data-role={message.role} aria-label={`${message.role} message`}>
        {inChannel && message.role === 'agent' && sender && (
          <div className="msg__sender">
            <Avatar agent={sender} size={16} />
            <span>{sender.name}</span>
          </div>
        )}
        {tools.length > 0 &&
          (showActivity ? (
            <div className="tools">
              {tools.map((call) => (
                <ToolCard key={call.id} call={call} />
              ))}
            </div>
          ) : (
            // Quiet by default, like the original: one line saying work happened, expandable.
            <button className="steps-chip" onClick={() => setExpanded((v) => !v)}>
              {expanded ? '⌄' : '›'} {tools.length} step{tools.length === 1 ? '' : 's'} ·{' '}
              {[...new Set(tools.map((t) => t.name))].slice(0, 4).join(', ')}
            </button>
          ))}

        {!showActivity && expanded && tools.length > 0 && (
          <div className="tools">
            {tools.map((call) => (
              <ToolCard key={call.id} call={call} />
            ))}
          </div>
        )}
        {hasText && (
          <div className="bubble-row">
            <div className="bubble" data-role={message.role}>
              {message.role === 'agent' ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
              ) : (
                message.text
              )}
            </div>
            <div className="msg__meta">
              <MessageActions message={message} conversationId={conversationId} onQuote={onQuote} />
              <span>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          </div>
        )}
        {message.widget && (
          <WidgetCard widget={message.widget} conversationId={conversationId} messageId={message.id} onAnswer={onAnswer} />
        )}
        {message.images && message.images.length > 0 && (
          <div className="message-images" data-count={message.images.length}>
            {message.images.map((image) => (
              <img
                key={image.path}
                src={`file://${image.path.replace(/\\/g, '/')}`}
                alt={image.alt ?? ''}
                onClick={() => void window.halo.openPath(image.path)}
              />
            ))}
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className="attachments">
            {message.attachments.map((a) => (
              <button key={a.path} className="attachment" onClick={() => void window.halo.openPath(a.path)}>
                <PaperclipIcon size={12} />
                {a.name}
              </button>
            ))}
          </div>
        )}
        {message.reactions && message.reactions.length > 0 && (
          <div className="reactions">
            {message.reactions.map((r, i) => (
              <span className="reaction" key={i}>
                {r}
              </span>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const QUICK_REACTIONS = ['👍', '🎉', '👀', '❤️', '😄'];

function MessageActions({
  message,
  conversationId,
  onQuote,
}: {
  message: Message;
  conversationId: string;
  onQuote: (text: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <span className="msg__actions">
      <span className="menu-anchor">
        <button className="icon-button icon-button--tiny" aria-label="Add reaction" onClick={() => setPickerOpen((v) => !v)}>
          <SmileIcon size={13} />
        </button>
        {pickerOpen && (
          <>
            <span className="menu-scrim" onClick={() => setPickerOpen(false)} />
            <span className="reaction-picker">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => {
                    void window.halo.reactToMessage(conversationId, message.id, emoji);
                    setPickerOpen(false);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </span>
          </>
        )}
      </span>
      <button className="icon-button icon-button--tiny" aria-label="Quote in reply" onClick={() => onQuote(message.text)}>
        <ReplyIcon size={13} />
      </button>
      <button
        className="icon-button icon-button--tiny"
        aria-label="Copy message"
        onClick={() => void navigator.clipboard.writeText(message.text)}
      >
        <CopyIcon size={13} />
      </button>
      <button
        className="icon-button icon-button--tiny"
        aria-label="Delete message"
        onClick={() => void window.halo.deleteMessage(conversationId, message.id)}
      >
        <TrashIcon size={13} />
      </button>
    </span>
  );
}

function summarizeArgs(call: ToolCallRecord): string {
  const args = call.args ?? {};
  for (const key of ['command', 'url', 'path', 'query', 'text', 'name', 'selector', 'action', 'agent_id']) {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').slice(0, 140);
  }
  return JSON.stringify(args).slice(0, 140);
}

function ToolCard({ call }: { call: ToolCallRecord }) {
  const [open, setOpen] = useState(false);
  const body = call.error ?? call.result ?? '';
  return (
    <div className="tool-card" data-status={call.status}>
      <button className="tool-card__head" onClick={() => setOpen((v) => !v)}>
        {call.status === 'running' ? <span className="spinner" /> : null}
        <span className="tool-card__name">{call.name}</span>
        <span className="tool-card__arg">{summarizeArgs(call)}</span>
        <span className="tool-card__status">
          {call.status === 'done' && call.endedAt
            ? `${Math.max(1, Math.round((call.endedAt - call.startedAt) / 100) / 10)}s`
            : call.status}
        </span>
      </button>
      {open && body && <div className="tool-card__body">{body}</div>}
    </div>
  );
}

function WidgetCard({
  widget,
  conversationId,
  messageId,
  onAnswer,
}: {
  widget: Widget;
  conversationId: string;
  messageId: string;
  onAnswer: (value: string) => void;
}) {
  const [custom, setCustom] = useState('');
  const [answered, setAnswered] = useState(widget.answered ?? '');

  const pick = (value: string) => {
    if (answered) return;
    setAnswered(value);
    // Written down, not only remembered: the pick lived in component state, so reopening the chat
    // read the message back off disk with no answer on it and offered the buttons again.
    void window.halo.answerWidget(conversationId, messageId, value);
    onAnswer(value);
  };

  return (
    <div className="widget">
      <div className="widget__prompt">{widget.prompt}</div>
      <div className="widget__options">
        {widget.options.map((option) => (
          <button
            key={option.value}
            className="btn"
            data-variant={option.style === 'primary' ? 'primary' : option.style === 'danger' ? 'danger' : undefined}
            data-picked={answered === option.value}
            disabled={Boolean(answered)}
            onClick={() => pick(option.value)}
          >
            {answered === option.value ? '✓ ' : ''}
            {option.label}
          </button>
        ))}
      </div>
      {widget.allowCustom && !answered && (
        <div className="widget__custom">
          <input
            className="input"
            value={custom}
            placeholder="Or type your own answer"
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && custom.trim()) pick(custom.trim());
            }}
          />
        </div>
      )}
    </div>
  );
}

/** Mirrors commandPrefixOf in the runner: the executable and its subcommand, and nothing more. */
function prefixOf(command: string): string {
  const words = command.trim().split(/\s+/).filter(Boolean);
  const head = words[0] ?? '';
  const second = words[1] ?? '';
  const takesSecond = second && !second.startsWith('-') && !/[\\/:]/.test(second) && /^[\w.-]+$/.test(second);
  return (takesSecond ? `${head} ${second}` : head).toLowerCase();
}

/** Docked above the composer, like the original's permission bar. */
function ApprovalDock({ approval }: { approval: ApprovalRequest }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const respond = async (decision: 'always' | 'once' | 'never') => {
    setBusy(true);
    await window.halo.respondApproval(approval.id, decision);
  };

  return (
    <div className="approval-dock" role="alertdialog" aria-label="Permission required">
      <div className="approval-dock__title">
        <WarningIcon size={14} />
        <span>{approval.question}</span>
      </div>
      {/*
        What "Always allow" actually grants. It used to say "every bot, every action of this kind",
        which was true and much too broad: one approval to run a command became standing permission
        to run any command. The rule is scoped now, and the card says to what.
      */}
      <div className="approval-dock__subtitle">
        {approval.command
          ? `“Always allow” remembers commands starting “${prefixOf(approval.command)}”, for every bot. Change it in Settings.`
          : 'This applies to every bot in Halo. You can always change it in Settings.'}
      </div>
      {approval.reason && <div className="approval-dock__subtitle">{approval.reason}</div>}
      <button className="approval-dock__disclosure" onClick={() => setOpen((v) => !v)}>
        {open ? '⌄' : '›'} {approval.summary}
      </button>
      {open && <div className="approval__detail">{approval.detail || '(no detail)'}</div>}
      <div className="approval-dock__actions">
        <button className="btn" data-variant="primary" disabled={busy} onClick={() => void respond('always')}>
          Always allow
        </button>
        <button className="btn" disabled={busy} onClick={() => void respond('once')}>
          Allow once
        </button>
        <button className="btn" disabled={busy} onClick={() => void respond('never')}>
          Never
        </button>
      </div>
    </div>
  );
}

function Composer({
  agentName,
  working,
  onSend,
  onStop,
  draft,
  onDraftUsed,
}: {
  agentName: string;
  working: boolean;
  onSend: ChatProps['onSend'];
  onStop: () => void;
  draft?: string;
  onDraftUsed?: () => void;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<{ path: string; name: string; size: number }[]>([]);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const addPaths = (paths: string[]) => {
    setAttachments((cur) => {
      const merged = [...cur];
      for (const path of paths) {
        if (!path || merged.some((a) => a.path === path)) continue;
        merged.push({ path, name: path.split(/[\\/]/).pop() ?? path, size: 0 });
      }
      return merged;
    });
  };

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, [text]);

  useEffect(() => {
    if (!draft) return;
    setText((cur) => (cur ? `${cur}\n${draft}` : draft));
    area.current?.focus();
    onDraftUsed?.();
  }, [draft, onDraftUsed]);

  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    setAttachments([]);
    await onSend(value, attachments);
  };

  return (
    <div
      className="composer"
      data-dragging={dragging}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const paths: string[] = [];
        for (const file of Array.from(e.dataTransfer.files)) {
          const path = window.halo.filePath(file);
          if (path) paths.push(path);
        }
        addPaths(paths);
      }}
    >
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <span className="attachment" key={a.path}>
              <PaperclipIcon size={12} />
              {a.name}
              <button onClick={() => setAttachments((cur) => cur.filter((x) => x.path !== a.path))} aria-label="Remove">
                <CloseIcon size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer__inner">
        <button
          className="icon-button"
          aria-label="Attach file"
          onClick={async () => addPaths(await window.halo.pickFiles())}
        >
          <PaperclipIcon />
        </button>
        <textarea
          ref={area}
          value={text}
          rows={1}
          placeholder={`Message ${agentName}`}
          aria-label="Prompt"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          onPaste={(e) => {
            const paths: string[] = [];
            for (const file of Array.from(e.clipboardData.files)) {
              const path = window.halo.filePath(file);
              if (path) paths.push(path);
            }
            if (paths.length > 0) {
              e.preventDefault();
              addPaths(paths);
            }
          }}
        />
        {working ? (
          <button className="composer__send" onClick={onStop} aria-label="Stop">
            <StopIcon />
          </button>
        ) : (
          <button className="composer__send" disabled={!text.trim()} onClick={() => void submit()} aria-label="Send">
            <ArrowUpIcon />
          </button>
        )}
      </div>
    </div>
  );
}
