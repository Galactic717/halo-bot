import { useEffect, useRef, useState } from 'react';
import type { Agent, Routine, RoutineTrigger } from '../../host/types';
import { checkEndpoint } from '../../host/agui';
import { PERSONAS } from '../../host/personas';
import { Avatar, AVATAR_COLORS } from './Avatar';
import {
  ChevronLeftIcon,
  ChevronsRightIcon,
  ClockIcon,
  FolderIcon,
  GearIcon,
  MonitorIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  SparkIcon,
  TrashIcon,
} from './Icons';

interface DetailsProps {
  agent: Agent;
  tab: 'details' | 'settings';
  routines: Routine[];
  onTab: (tab: 'details' | 'settings') => void;
  onClose: () => void;
  onUpdateAgent: (patch: Partial<Agent>) => Promise<void>;
  onDeleteAgent: () => Promise<void>;
  onOpenComputer: () => void;
}

export function describeTrigger(trigger: RoutineTrigger): string {
  const hh = 'hour' in trigger ? String(trigger.hour).padStart(2, '0') : '';
  const mm = 'minute' in trigger ? String(trigger.minute).padStart(2, '0') : '';
  switch (trigger.kind) {
    case 'interval':
      return `every ${trigger.everyMinutes} min`;
    case 'daily':
      return `every day at ${hh}:${mm}`;
    case 'weekdays':
      return `weekdays at ${hh}:${mm}`;
    case 'webhook':
      return 'when its webhook is called';
    default:
      return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][trigger.weekday]} at ${hh}:${mm}`;
  }
}

export function Details({ agent, tab, routines, onTab, onClose, onUpdateAgent, onDeleteAgent, onOpenComputer }: DetailsProps) {
  const [openRoutineId, setOpenRoutineId] = useState<string | null>(null);

  useEffect(() => setOpenRoutineId(null), [agent.id]);

  const openRoutine = routines.find((r) => r.id === openRoutineId) ?? null;

  return (
    <aside className="details" aria-label="Conversation details">
      <div className="details__header">
        {tab === 'settings' || openRoutine ? (
          <button
            className="icon-button"
            onClick={() => (openRoutine ? setOpenRoutineId(null) : onTab('details'))}
            aria-label="Back to details"
          >
            <ChevronLeftIcon />
          </button>
        ) : (
          <button className="icon-button" onClick={() => onTab('settings')} aria-label="Agent settings">
            <GearIcon />
          </button>
        )}
        <span className="details__title">{openRoutine ? 'Routine' : tab === 'settings' ? 'Settings' : agent.name}</span>
        <button className="icon-button" onClick={onClose} aria-label="Close details">
          <ChevronsRightIcon />
        </button>
      </div>

      <div className="details__body">
        {openRoutine ? (
          <RoutineEditor routine={openRoutine} onDone={() => setOpenRoutineId(null)} />
        ) : tab === 'details' ? (
          <>
            <ScreenPreview agent={agent} onOpen={onOpenComputer} />

            <TasksSection agent={agent} />

            <RoutinesSection agent={agent} routines={routines} onOpen={setOpenRoutineId} />

            <SkillsSection agent={agent} />
          </>
        ) : (
          <AgentSettings agent={agent} onUpdateAgent={onUpdateAgent} onDeleteAgent={onDeleteAgent} />
        )}
      </div>
    </aside>
  );
}

function RoutinesSection({
  agent,
  routines,
  onOpen,
}: {
  agent: Agent;
  routines: Routine[];
  onOpen: (id: string) => void;
}) {
  const create = async () => {
    const routine = await window.halo.saveRoutine({
      agentId: agent.id,
      name: 'New routine',
      prompt: '',
      daily_at: '09:00',
      enabled: false,
    });
    if (routine) onOpen(routine.id);
  };

  return (
    <div>
      <div className="section-header">
        <span className="section-label">Routines</span>
        <button className="icon-button" onClick={() => void create()} aria-label="New routine">
          <PlusIcon size={14} />
        </button>
      </div>

      {routines.length === 0 && <p className="empty-note">Routines are recurring tasks this bot runs on a schedule.</p>}

      {routines.map((routine) => (
        <button className="routine" key={routine.id} onClick={() => onOpen(routine.id)} aria-label={`Open routine ${routine.name}`}>
          <ClockIcon />
          <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
            <span className="routine__name">{routine.name}</span>
            <br />
            <span className="routine__when">
              {routine.triggers.map(describeTrigger).join(', ')}
              {routine.enabled ? '' : ' · paused'}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** What this bot has learned: skills it wrote itself or picked up from a demonstration. */
function SkillsSection({ agent }: { agent: Agent }) {
  const [skills, setSkills] = useState<{ id: string; name: string; description: string; body: string }[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = () => {
    void window.halo.skills(agent.id).then(setSkills);
  };

  useEffect(load, [agent.id]);

  return (
    <div>
      <div className="section-header">
        <span className="section-label">Skills</span>
        <button className="icon-button" onClick={load} aria-label="Refresh skills">
          <RefreshIcon />
        </button>
      </div>

      {skills.length === 0 && (
        <p className="empty-note">
          Nothing learned yet. Open the computer, press Teach a task, and do it once — the bot writes the skill itself.
        </p>
      )}

      {skills.map((skill) => (
        <div key={skill.id}>
          <button className="routine" onClick={() => setOpen(open === skill.id ? null : skill.id)}>
            <SparkIcon />
            <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
              <span className="routine__name">{skill.name}</span>
              <br />
              <span className="routine__when">{skill.description || 'no description'}</span>
            </span>
            <button
              className="icon-button"
              aria-label={`Delete ${skill.name}`}
              onClick={(e) => {
                e.stopPropagation();
                void window.halo.deleteSkill(agent.id, skill.name).then(load);
              }}
            >
              <TrashIcon />
            </button>
          </button>
          {open === skill.id && <div className="skill-body">{skill.body}</div>}
        </div>
      ))}
    </div>
  );
}

/** Background workers and long shells, with a way to stop one that is stuck. */
function TasksSection({ agent }: { agent: Agent }) {
  const [tasks, setTasks] = useState<{ id: string; kind: string; description: string; status: string; seconds: number; steps: number }[]>(
    [],
  );

  useEffect(() => {
    let alive = true;
    const load = () => {
      void window.halo.tasks(agent.id).then((rows) => {
        if (alive) setTasks(rows);
      });
    };
    load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [agent.id]);

  if (tasks.length === 0) return null;

  return (
    <div>
      <div className="section-label">Running now</div>
      {tasks.map((task) => (
        <div className="routine" key={task.id}>
          <span className="spinner" />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="routine__name">{task.description || task.kind}</span>
            <br />
            <span className="routine__when">
              {task.kind} · {task.seconds}s{task.steps > 0 ? ` · ${task.steps} steps` : ''}
            </span>
          </span>
          {task.kind !== 'shell' && (
            <button className="icon-button" aria-label="Stop task" onClick={() => void window.halo.stopTask(task.id)}>
              <TrashIcon />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** The preview is the bot's real screen, laid over this slot at a quarter scale. */
function ScreenPreview({ agent, onOpen }: { agent: Agent; onOpen: () => void }) {
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = slot.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return;
      void window.halo.computerPreview(agent.id, {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    window.addEventListener('resize', report);
    const timer = setInterval(report, 1500);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      clearInterval(timer);
      void window.halo.computerPreviewClear();
    };
  }, [agent.id]);

  return (
    <div>
      <button className="screen-preview" onClick={onOpen} aria-label={`${agent.name}'s screen`}>
        <div className="screen-preview__slot" ref={slot}>
          <MonitorIcon size={22} />
        </div>
      </button>
      <div className="screen-caption">{agent.name}&apos;s screen — click to take over</div>
    </div>
  );
}

const EMPTY_TRIGGER: RoutineTrigger = { kind: 'daily', hour: 9, minute: 0 };

function RoutineEditor({ routine, onDone }: { routine: Routine; onDone: () => void }) {
  const [name, setName] = useState(routine.name);
  const [prompt, setPrompt] = useState(routine.prompt);
  const [triggers, setTriggers] = useState<RoutineTrigger[]>(routine.triggers.length ? routine.triggers : [EMPTY_TRIGGER]);

  useEffect(() => {
    setName(routine.name);
    setPrompt(routine.prompt);
    setTriggers(routine.triggers.length ? routine.triggers : [EMPTY_TRIGGER]);
  }, [routine.id, routine.name, routine.prompt, routine.triggers]);

  const save = (patch: Partial<Routine> = {}) => {
    void window.halo.saveRoutine({
      id: routine.id,
      agentId: routine.agentId,
      createdAt: routine.createdAt,
      runs: routine.runs,
      lastRunAt: routine.lastRunAt,
      enabled: routine.enabled,
      name,
      prompt,
      triggers,
      ...patch,
    });
  };

  const setTrigger = (index: number, next: RoutineTrigger) => {
    const list = triggers.map((t, i) => (i === index ? next : t));
    setTriggers(list);
    save({ triggers: list });
  };

  return (
    <>
      <div className="routine-editor__top">
        <button
          className="switch"
          data-on={routine.enabled}
          aria-label="Active"
          onClick={() => save({ enabled: !routine.enabled })}
        />
        <span style={{ flex: 1 }}>{routine.enabled ? 'Active' : 'Paused'}</span>
        <button
          className="btn"
          onClick={() => {
            void window.halo.deleteRoutine(routine.id);
            onDone();
          }}
        >
          Delete
        </button>
        <button className="btn" data-variant="primary" onClick={() => void window.halo.runRoutine(routine.id)}>
          <PlayIcon size={12} /> Test run
        </button>
      </div>

      <div className="field">
        <label>Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => save()} />
      </div>

      <div className="field">
        <label>Instruction</label>
        <textarea
          className="textarea"
          style={{ minHeight: 120 }}
          value={prompt}
          placeholder="What should happen each time this fires?"
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => save()}
        />
      </div>

      <div>
        <div className="section-label">When to run</div>
        <div className="card">
          {triggers.map((trigger, i) => (
            <TriggerRow
              key={i}
              trigger={trigger}
              onChange={(next) => setTrigger(i, next)}
              onRemove={
                triggers.length > 1
                  ? () => {
                      const list = triggers.filter((_, index) => index !== i);
                      setTriggers(list);
                      save({ triggers: list });
                    }
                  : undefined
              }
            />
          ))}
          <button
            className="btn"
            style={{ width: '100%', marginTop: 8 }}
            onClick={() => {
              const list = [...triggers, EMPTY_TRIGGER];
              setTriggers(list);
              save({ triggers: list });
            }}
          >
            <PlusIcon size={13} /> Add another
          </button>
        </div>
      </div>

      <div className="field">
        <label>Most runs per day</label>
        <input
          className="input"
          type="number"
          min={1}
          max={500}
          value={routine.maxRunsPerDay ?? 24}
          onChange={(e) => save({ maxRunsPerDay: Math.max(1, Number(e.target.value)) })}
        />
        <div className="setting-row__desc">If it hits this, Halo pauses the routine instead of running it again.</div>
      </div>

      {/*
        A watcher that cannot see what it said last time says the same thing every hour, and a
        routine that reports "still fine" hourly is one the user mutes. With this it is fed its own
        last report and told to stay quiet when nothing has moved.
      */}
      <div className="setting-row">
        <div className="setting-row__text">
          <div>Remember its last report</div>
          <div className="setting-row__desc">Feeds the bot what it told you last time so it can stay quiet when nothing changed.</div>
        </div>
        <button
          className="switch"
          data-on={routine.continuity === true}
          aria-label="Remember its last report"
          onClick={() => save({ continuity: !routine.continuity })}
        />
      </div>

      <div>
        <div className="section-label">Run history</div>
        {(routine.failureStreak ?? 0) > 0 && (
          <p className="empty-note">Failed {routine.failureStreak} time(s) in a row. Halo pauses a routine after three.</p>
        )}
        {(routine.runs ?? []).length === 0 ? (
          <p className="empty-note">No runs yet</p>
        ) : (
          [...(routine.runs ?? [])].reverse().map((run, i) => (
            <div className="routine__when" key={i} style={{ padding: '4px 0' }}>
              {new Date(run.at).toLocaleString()} · {run.status}
              {run.note ? ` · ${run.note}` : ''}
            </div>
          ))
        )}
      </div>
    </>
  );
}

function TriggerRow({
  trigger,
  onChange,
  onRemove,
}: {
  trigger: RoutineTrigger;
  onChange: (next: RoutineTrigger) => void;
  onRemove?: () => void;
}) {
  const time = 'hour' in trigger ? `${String(trigger.hour).padStart(2, '0')}:${String(trigger.minute).padStart(2, '0')}` : '09:00';

  const changeKind = (kind: RoutineTrigger['kind']) => {
    const [h, m] = time.split(':').map(Number);
    if (kind === 'interval') onChange({ kind: 'interval', everyMinutes: 60 });
    else if (kind === 'weekly') onChange({ kind: 'weekly', weekday: 1, hour: h ?? 9, minute: m ?? 0 });
    // The token is the hook's whole address, so it is minted once here and never edited afterwards.
    else if (kind === 'webhook') onChange({ kind: 'webhook', token: crypto.randomUUID().replace(/-/g, '') });
    else onChange({ kind, hour: h ?? 9, minute: m ?? 0 } as RoutineTrigger);
  };

  const changeTime = (value: string) => {
    const [h, m] = value.split(':').map(Number);
    if (trigger.kind === 'interval' || trigger.kind === 'webhook') return;
    onChange({ ...trigger, hour: h ?? 9, minute: m ?? 0 });
  };

  return (
    <div className="trigger-row">
      <ClockIcon />
      <select className="input" value={trigger.kind} onChange={(e) => changeKind(e.target.value as RoutineTrigger['kind'])}>
        <option value="daily">Every day</option>
        <option value="weekdays">Weekdays</option>
        <option value="weekly">Weekly</option>
        <option value="interval">Every N minutes</option>
        <option value="webhook">Webhook</option>
      </select>

      {trigger.kind === 'weekly' && (
        <select
          className="input"
          value={trigger.weekday}
          onChange={(e) => onChange({ ...trigger, weekday: Number(e.target.value) })}
        >
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
            <option key={d} value={i}>
              {d}
            </option>
          ))}
        </select>
      )}

      {trigger.kind === 'webhook' ? (
        <WebhookUrl token={trigger.token} />
      ) : trigger.kind === 'interval' ? (
        <input
          className="input"
          type="number"
          min={5}
          value={trigger.everyMinutes}
          onChange={(e) => onChange({ kind: 'interval', everyMinutes: Math.max(5, Number(e.target.value)) })}
        />
      ) : (
        <input className="input" type="time" value={time} onChange={(e) => changeTime(e.target.value)} />
      )}

      {onRemove && (
        <button className="icon-button" onClick={onRemove} aria-label="Remove trigger">
          <TrashIcon />
        </button>
      )}
    </div>
  );
}

/**
 * The loopback URL that fires this routine. Read-only and click-to-copy: it is an address to paste into
 * Task Scheduler or a script, never something to type by hand.
 */
function WebhookUrl({ token }: { token: string }) {
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void window.halo.webhookUrl(token).then(setUrl);
  }, [token]);

  return (
    <input
      className="input"
      readOnly
      value={copied ? 'Copied' : url || 'listener not running'}
      title={url ? `POST or GET ${url} to run this routine` : 'The webhook listener could not start'}
      onFocus={(e) => e.currentTarget.select()}
      onClick={() => {
        if (!url) return;
        void navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    />
  );
}

function AgentSettings({
  agent,
  onUpdateAgent,
  onDeleteAgent,
}: {
  agent: Agent;
  onUpdateAgent: (patch: Partial<Agent>) => Promise<void>;
  onDeleteAgent: () => Promise<void>;
}) {
  const [name, setName] = useState(agent.name);
  const [title, setTitle] = useState(agent.title);
  const [description, setDescription] = useState(agent.description);
  const [memory, setMemory] = useState('');
  const [boxDir, setBoxDir] = useState('');
  const [model, setModel] = useState(agent.model ?? '');
  const [persona, setPersona] = useState(agent.persona ?? '');
  const [models, setModels] = useState<string[]>([]);
  const [endpoint, setEndpoint] = useState(agent.endpoint ?? '');
  const [endpointAuth, setEndpointAuth] = useState('');
  const [endpointError, setEndpointError] = useState('');

  useEffect(() => {
    setName(agent.name);
    setTitle(agent.title);
    setPersona(agent.persona ?? '');
    setDescription(agent.description);
    setModel(agent.model ?? '');
    setEndpoint(agent.endpoint ?? '');
    void window.halo.memory(agent.id).then(setMemory);
    void window.halo.boxDir(agent.id).then(setBoxDir);
    void window.halo.models().then((result) => {
      if (Array.isArray(result)) setModels(result);
    });
  }, [agent.id, agent.name, agent.title, agent.description]);

  return (
    <>
      <div style={{ display: 'grid', placeItems: 'center', gap: 12 }}>
        <Avatar agent={agent} size={56} />
        <div className="approval__actions">
          <button
            className="btn"
            onClick={async () => {
              const next = await window.halo.pickAvatar(agent.id);
              if (next) void onUpdateAgent({ avatar: next.avatar });
            }}
          >
            Upload picture
          </button>
          {agent.avatar.image && (
            <button className="btn" onClick={() => void onUpdateAgent({ avatar: { color: agent.avatar.color, face: agent.avatar.face } })}>
              Use the drawn face
            </button>
          )}
        </div>

        <div className="swatches">
          {AVATAR_COLORS.map((color) => (
            <button
              key={color}
              className="swatch"
              data-selected={agent.avatar.color === color}
              style={{ background: `var(--avatar-${color})` }}
              aria-label={color}
              onClick={() => void onUpdateAgent({ avatar: { ...agent.avatar, color } })}
            />
          ))}
        </div>
      </div>

      <div>
        <div className="field">
          <label>Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void onUpdateAgent({ name })} />
        </div>
        <div className="field">
          <label>Title</label>
          <input
            className="input"
            value={title}
            placeholder="Describe what this bot does"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void onUpdateAgent({ title })}
          />
        </div>
        <div className="field">
          <label>Description</label>
          <textarea
            className="textarea"
            value={description}
            placeholder="What this bot is for"
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => void onUpdateAgent({ description })}
          />
        </div>
      </div>

      <div className="field">
        <label>How it talks</label>
        <div className="persona-grid">
          {PERSONAS.map((p) => (
            <button
              key={p.id}
              className="persona-chip"
              data-selected={!agent.persona && (agent.personaId ?? 'colleague') === p.id}
              title={p.blurb}
              onClick={() => void onUpdateAgent({ personaId: p.id, persona: '' })}
            >
              <span className="persona-chip__glyph">{p.glyph}</span>
              <span className="persona-chip__label">{p.label}</span>
            </button>
          ))}
          <button
            className="persona-chip"
            data-selected={Boolean(agent.persona)}
            title="Write your own"
            onClick={() => void onUpdateAgent({ persona: agent.persona || ' ' })}
          >
            <span className="persona-chip__glyph">✎</span>
            <span className="persona-chip__label">Custom</span>
          </button>
        </div>
        {agent.persona ? (
          <textarea
            className="textarea"
            value={persona}
            placeholder="Talk like a 1940s newsreel announcer. Keep every fact, path and number exact."
            onChange={(e) => setPersona(e.target.value)}
            onBlur={() => void onUpdateAgent({ persona: persona.trim() })}
          />
        ) : (
          <div className="setting-row__desc">
            {PERSONAS.find((p) => p.id === (agent.personaId ?? 'colleague'))?.blurb}
          </div>
        )}
        <div className="setting-row__desc">
          A voice changes how it sounds, never what it is allowed to do. The approval gate and Halo's floor are
          the same whichever one you pick.
        </div>
      </div>

      <div className="field">
        <label>Model</label>
        <input
          className="input"
          value={model}
          placeholder="use the default"
          list="halo-agent-models"
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => void onUpdateAgent({ model: model.trim() })}
        />
        <datalist id="halo-agent-models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <div className="setting-row__desc">Give a heavy bot a bigger model and a watcher a small one.</div>
      </div>

      {/*
        An agent somebody else wrote, on any framework, over AG-UI. It is offered Halo's tools and
        every call it makes still goes through the approval gate and onto the trail — which is why
        this can be a text box rather than a decision about trust. Only a person sets it; no tool can.
      */}
      <div className="field">
        <label>Agent endpoint</label>
        <input
          className="input"
          value={endpoint}
          placeholder="http://localhost:8000/ (AG-UI, optional)"
          onChange={(e) => setEndpoint(e.target.value)}
          onBlur={() => {
            const value = endpoint.trim();
            const verdict = value ? checkEndpoint(value) : ({ ok: true, url: '' } as const);
            if (!verdict.ok) {
              setEndpointError(verdict.reason);
              return;
            }
            setEndpointError('');
            void onUpdateAgent({ endpoint: value });
          }}
        />
        <div className="setting-row__desc" data-tone={endpointError ? 'danger' : undefined}>
          {endpointError || 'Runs this bot on an AG-UI agent instead of the local loop. Leave empty for the normal bot.'}
        </div>
      </div>

      {endpoint.trim() !== '' && (
        <div className="field">
          <label>Authorization header</label>
          <input
            className="input"
            type="password"
            value={endpointAuth}
            placeholder={agent.endpointAuth ? '••••••••' : 'Bearer …'}
            onChange={(e) => setEndpointAuth(e.target.value)}
            onBlur={() => endpointAuth && void onUpdateAgent({ endpointAuth })}
          />
          <div className="setting-row__desc">Encrypted with the OS keychain before it is written, like the API key.</div>
        </div>
      )}

      <div className="card">
        <div className="setting-row">
          <div className="setting-row__text">
            <div>Notifications</div>
            <div className="setting-row__desc">Get notified when this bot finishes or needs input</div>
          </div>
          <button
            className="switch"
            data-on={agent.notifications}
            aria-label="Notifications"
            onClick={() => void onUpdateAgent({ notifications: !agent.notifications })}
          />
        </div>
      </div>

      <div>
        <div className="section-label">Permissions</div>
        <div className="card">
          <div className="setting-row">
            <div className="setting-row__text">
              <div>On your computer</div>
              <div className="setting-row__desc">Overrides the global setting for this bot alone.</div>
            </div>
            <select
              className="input"
              style={{ width: 150 }}
              value={agent.localExecution ?? 'inherit'}
              onChange={(e) => void onUpdateAgent({ localExecution: e.target.value as NonNullable<Agent['localExecution']> })}
            >
              <option value="inherit">Use global</option>
              <option value="ask">Ask every time</option>
              <option value="allow">Allow</option>
              <option value="never">Never</option>
            </select>
          </div>

          <div className="setting-row" style={{ display: 'block' }}>
            <div className="setting-row__text">
              <div>Folders it may use freely</div>
              <div className="setting-row__desc">Anything inside these runs without an approval prompt.</div>
            </div>
            {(agent.allowedPaths ?? []).map((path) => (
              <div className="member-row" key={path}>
                <FolderIcon size={14} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{path}</span>
                <button
                  className="icon-button"
                  aria-label={`Remove ${path}`}
                  onClick={() => void onUpdateAgent({ allowedPaths: (agent.allowedPaths ?? []).filter((p) => p !== path) })}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
            <button
              className="btn"
              style={{ width: '100%', marginTop: 8 }}
              onClick={async () => {
                const picked = await window.halo.pickFolder();
                if (picked) void onUpdateAgent({ allowedPaths: [...new Set([...(agent.allowedPaths ?? []), picked])] });
              }}
            >
              <PlusIcon size={13} /> Add a folder
            </button>
          </div>
        </div>
      </div>

      <div>
        <div className="section-label">Memory</div>
        <textarea
          className="textarea"
          style={{ minHeight: 160, fontFamily: 'var(--font-mono)', fontSize: 12 }}
          value={memory}
          placeholder={'profile: who the user is\nlog: what is going on\nnote: minor detail'}
          onChange={(e) => setMemory(e.target.value)}
          onBlur={() => void window.halo.saveMemory(agent.id, memory).then(() => window.halo.memory(agent.id).then(setMemory))}
        />
        <div className="setting-row__desc">
          One fact per line, tagged <code>profile</code>, <code>log</code> or <code>note</code>. This is what the bot
          actually reads at the start of every turn.
        </div>
      </div>

      <div>
        <div className="section-label">Box</div>
        <button className="btn" style={{ width: '100%' }} onClick={() => void window.halo.openPath(boxDir)}>
          Open {boxDir.split(/[\\/]/).slice(-2).join('/')}
        </button>
      </div>

      <button
        className="btn"
        data-variant="danger"
        onClick={() => {
          if (confirm(`Delete ${agent.name} and all of its history?`)) void onDeleteAgent();
        }}
      >
        <TrashIcon /> Delete bot
      </button>
    </>
  );
}
