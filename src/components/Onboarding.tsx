import { useEffect, useState } from 'react';
import { Avatar, AVATAR_COLORS } from './Avatar';
import { PERSONAS } from '../../host/personas';

export interface NewBotInput {
  name: string;
  color: string;
  title?: string;
  description?: string;
  personaId?: string;
  persona?: string;
  /** Empty means "whatever Settings says". Anything else overrides it for this bot alone. */
  model?: string;
}

interface OnboardingProps {
  canCancel: boolean;
  onCancel: () => void;
  onCreate: (input: NewBotInput) => Promise<unknown>;
  /** The model from Settings, shown as the first option so the choice is a real one. */
  defaultModel: string;
}

/**
 * A template is a whole bot, not a name.
 *
 * Making a bot used to be a name and a colour, which is fast and tells the model nothing: a bot with
 * no description is a bot whose first turn is spent asking what it is for. Every template here fills
 * in the role, the brief and a voice that suits the job, so one click produces something that starts
 * working — and every field stays editable underneath, because a template that cannot be adjusted is
 * a menu rather than a starting point.
 */
const TEMPLATES: (NewBotInput & { blurb: string })[] = [
  {
    name: 'Scout',
    color: 'blue',
    title: 'General assistant',
    description: 'A general-purpose teammate. Give it anything and it works out how.',
    personaId: 'colleague',
    blurb: 'Anything and everything',
  },
  {
    name: 'Researcher',
    color: 'green',
    title: 'Digs into any question across the web',
    description:
      'Searches, reads primary sources, and comes back with a short sourced brief. Never guesses a number or a quote; says plainly when something is not findable.',
    personaId: 'analyst',
    blurb: 'Sourced answers, no guessing',
  },
  {
    name: 'Night Shift',
    color: 'orange',
    title: 'Works overnight and preps your morning digest',
    description:
      'Runs the long jobs while the user sleeps: builds, downloads, scrapes, batch work. Leaves one short digest of what happened and what needs a decision.',
    personaId: 'terse',
    blurb: 'Long jobs while you sleep',
  },
  {
    name: 'Lookout',
    color: 'cyan',
    title: 'Watches a site and tells you when it changes',
    description:
      'Keeps a routine per watched page, opens it in the browser on schedule, compares against what it saw last time, and messages only on a real change.',
    personaId: 'terse',
    blurb: 'Tells you when something moves',
  },
  {
    name: 'Build Bot',
    color: 'purple',
    title: 'Writes and runs code in its own box',
    description:
      'Scripts, builds and tests in its workspace, runs long jobs in the background, and reports what actually passed rather than what should have.',
    personaId: 'senior',
    blurb: 'Code, builds, tests',
  },
  {
    name: 'Tutor',
    color: 'yellow',
    title: 'Teaches whatever you are trying to learn',
    description:
      'Explains a topic at the level the user is actually at, sets small exercises, checks the answers, and keeps track of what has stuck in memory.',
    personaId: 'mentor',
    blurb: 'Explains and quizzes you',
  },
  {
    name: 'Chief of Staff',
    color: 'red',
    title: 'Runs the other bots and pulls you in for decisions',
    description:
      'Breaks work down, creates or briefs the right specialist bot, chases what is outstanding, and escalates only what genuinely needs the user.',
    personaId: 'colleague',
    blurb: 'Delegates and chases',
  },
  {
    name: 'File Clerk',
    color: 'brown',
    title: 'Sorts, renames and summarizes your files',
    description:
      'Keeps a catalog in its box, sorts whatever lands in the inbox folder, writes short summaries, and asks before touching anything on the real machine.',
    personaId: 'colleague',
    blurb: 'Keeps the folders tidy',
  },
  {
    name: 'Shopper',
    color: 'magenta',
    title: 'Gathers options into a clear comparison',
    description:
      'Collects prices and specs from real listings, puts them in one table with links, and flags the tradeoff rather than just picking the cheapest.',
    personaId: 'analyst',
    blurb: 'One table, real links',
  },
];

export function Onboarding({ canCancel, onCancel, onCreate, defaultModel }: OnboardingProps) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>('blue');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [personaId, setPersonaId] = useState('colleague');
  const [custom, setCustom] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);

  // The models the configured server actually serves. A failure is silent: the field still takes a
  // typed id, which is the case that matters for a server whose /models endpoint is not a list.
  useEffect(() => {
    void window.halo.models().then((result) => {
      if (Array.isArray(result)) setModels(result);
    });
  }, []);

  const create = async (input: NewBotInput) => {
    if (!input.name.trim() || busy) return;
    setBusy(true);
    try {
      await onCreate(input);
    } finally {
      setBusy(false);
    }
  };

  const submit = () =>
    void create({
      name,
      color,
      title,
      description,
      ...(customOpen && custom.trim() ? { persona: custom.trim() } : { personaId }),
      ...(model.trim() ? { model: model.trim() } : {}),
    });

  /** A template fills the form rather than creating straight away, so it can be adjusted first. */
  const apply = (template: NewBotInput) => {
    setName(template.name);
    setColor(template.color);
    setTitle(template.title ?? '');
    setDescription(template.description ?? '');
    setPersonaId(template.personaId ?? 'colleague');
    setCustomOpen(false);
    setMore(true);
  };

  const preview = { name: name || 'New bot', avatar: { color, face: 0 } };

  return (
    <div className="chat">
      <header className="chat__header">
        <div className="header-agent">
          <Avatar agent={preview} size={20} />
          <span>{name || 'New bot'}</span>
        </div>
        {canCancel && (
          <div className="header-actions">
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        )}
      </header>

      <div className="onboarding onboarding--scroll">
        <Avatar agent={preview} size={64} />
        <div className="swatches">
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              className="swatch"
              data-selected={c === color}
              style={{ background: `var(--avatar-${c})` }}
              aria-label={c}
              onClick={() => setColor(c)}
            />
          ))}
        </div>

        <div className="field onboarding__field">
          <label>Name</label>
          <input
            className="input"
            value={name}
            placeholder="New bot"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </div>

        <div className="field onboarding__field">
          <label>How it talks</label>
          <div className="persona-grid">
            {PERSONAS.map((p) => (
              <button
                key={p.id}
                className="persona-chip"
                data-selected={!customOpen && p.id === personaId}
                onClick={() => {
                  setPersonaId(p.id);
                  setCustomOpen(false);
                }}
                title={p.blurb}
              >
                <span className="persona-chip__glyph">{p.glyph}</span>
                <span className="persona-chip__label">{p.label}</span>
              </button>
            ))}
            <button className="persona-chip" data-selected={customOpen} onClick={() => setCustomOpen(true)} title="Write your own">
              <span className="persona-chip__glyph">✎</span>
              <span className="persona-chip__label">Custom</span>
            </button>
          </div>
          <div className="persona-blurb">
            {customOpen ? 'Write the voice yourself. It changes how the bot sounds, never what it is allowed to do.' : PERSONAS.find((p) => p.id === personaId)?.blurb}
          </div>
          {customOpen && (
            <textarea
              className="input"
              rows={4}
              value={custom}
              placeholder={'Talk like a 1940s newsreel announcer. Keep every fact, path and number exact.'}
              onChange={(e) => setCustom(e.target.value)}
            />
          )}
        </div>

        <div className="field onboarding__field">
          <label>Model</label>
          <div className="persona-grid">
            <button className="persona-chip" data-selected={!model} onClick={() => setModel('')}>
              <span className="persona-chip__label">Default{defaultModel ? ` · ${defaultModel}` : ''}</span>
            </button>
            <button
              className="persona-chip"
              data-selected={Boolean(model)}
              onClick={() => setModel(model || models[0] || defaultModel || 'gpt-4o-mini')}
            >
              <span className="persona-chip__label">Another model</span>
            </button>
          </div>
          {model ? (
            <>
              <input
                className="input"
                value={model}
                list="halo-new-bot-models"
                placeholder="model id on your server"
                onChange={(e) => setModel(e.target.value)}
              />
              <datalist id="halo-new-bot-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </>
          ) : (
            <div className="persona-blurb">
              Whatever Settings &rarr; Model says. Give a heavy bot a bigger model and a watcher a small one.
            </div>
          )}
        </div>

        <button className="onboarding__more" onClick={() => setMore((v) => !v)}>
          {more ? '⌄' : '›'} Role and brief {more ? '' : '(optional)'}
        </button>

        {more && (
          <>
            <div className="field onboarding__field">
              <label>Role</label>
              <input
                className="input"
                value={title}
                placeholder="Watches a site and tells me when it changes"
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="field onboarding__field">
              <label>What it is for</label>
              <textarea
                className="input"
                rows={3}
                value={description}
                placeholder="The brief it works from. A bot created with one takes a first pass on its own."
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </>
        )}

        <button className="btn" data-variant="primary" disabled={!name.trim() || busy} onClick={submit}>
          Create bot
        </button>
      </div>

      <section aria-label="Templates">
        <div className="section-label" style={{ padding: '0 16px' }}>Start from a template</div>
        <div className="suggestions">
          {TEMPLATES.map((t) => (
            <button key={t.name} className="suggestion" onClick={() => apply(t)}>
              <Avatar agent={{ name: t.name, avatar: { color: t.color, face: 0 } }} size={28} />
              <span>
                <span className="suggestion__title">{t.name}</span>
                <br />
                <span className="suggestion__desc">{t.blurb}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
