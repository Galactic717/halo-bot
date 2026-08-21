import { useState } from 'react';
import { Avatar, AVATAR_COLORS } from './Avatar';

interface OnboardingProps {
  canCancel: boolean;
  onCancel: () => void;
  onCreate: (input: { name: string; color: string; title?: string; description?: string }) => Promise<unknown>;
}

const SUGGESTIONS = [
  {
    name: 'Night Shift',
    color: 'orange',
    title: 'Works overnight and preps your morning digest',
    description:
      'Runs the long jobs while the user sleeps: builds, downloads, scrapes, batch work. Leaves one short digest of what happened and what needs a decision.',
  },
  {
    name: 'Researcher',
    color: 'green',
    title: 'Digs into any question across the web',
    description:
      'Searches, reads primary sources, and comes back with a short sourced brief. Never guesses a number or a quote; says plainly when something is not findable.',
  },
  {
    name: 'Chief of Staff',
    color: 'red',
    title: 'Runs the other bots and pulls you in for decisions',
    description:
      'Breaks work down, creates or briefs the right specialist bot, chases what is outstanding, and escalates only what genuinely needs the user.',
  },
  {
    name: 'Lookout',
    color: 'cyan',
    title: 'Watches a site and tells you when it changes',
    description:
      'Keeps a routine per watched page, opens it in the browser on schedule, compares against what it saw last time, and messages only on a real change.',
  },
  {
    name: 'File Clerk',
    color: 'brown',
    title: 'Sorts, renames and summarizes your files',
    description:
      'Keeps a catalog in its box, sorts whatever lands in the inbox folder, writes short summaries, and asks before touching anything on the real machine.',
  },
  {
    name: 'Build Bot',
    color: 'purple',
    title: 'Writes and runs code in its own box',
    description:
      'Scripts, builds and tests in its workspace, runs long jobs in the background, and reports what actually passed rather than what should have.',
  },
  {
    name: 'Shopper',
    color: 'magenta',
    title: 'Gathers options into a clear comparison',
    description:
      'Collects prices and specs from real listings, puts them in one table with links, and flags the tradeoff rather than just picking the cheapest.',
  },
  {
    name: 'Prototyper',
    color: 'blue',
    title: 'Turns an idea into something runnable',
    description:
      'Takes a rough idea, builds the smallest working version in its box, and sends back the file plus how to run it.',
  },
];

export function Onboarding({ canCancel, onCancel, onCreate }: OnboardingProps) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>('blue');
  const [busy, setBusy] = useState(false);

  const create = async (input: { name: string; color: string; title?: string; description?: string }) => {
    if (!input.name.trim() || busy) return;
    setBusy(true);
    try {
      await onCreate(input);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat">
      <header className="chat__header">
        <div className="header-agent">
          <Avatar agent={{ name: name || 'New Bot', avatar: { color, face: 0 } }} size={20} />
          <span>{name || 'New Bot'}</span>
        </div>
        {canCancel && (
          <div className="header-actions">
            <button className="btn" onClick={onCancel}>Cancel</button>
          </div>
        )}
      </header>

      <div className="onboarding">
        <Avatar agent={{ name: name || 'New Bot', avatar: { color, face: 0 } }} size={64} />
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
        <div className="field" style={{ width: 300 }}>
          <label>Name</label>
          <input
            className="input"
            value={name}
            placeholder="New Bot"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create({ name, color });
            }}
          />
        </div>
        <button className="btn" data-variant="primary" disabled={!name.trim() || busy} onClick={() => void create({ name, color })}>
          Get started
        </button>
      </div>

      <section aria-label="Suggestions">
        <div className="section-label" style={{ padding: '0 16px' }}>Suggestions</div>
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s.name} className="suggestion" onClick={() => void create(s)}>
              <Avatar agent={{ name: s.name, avatar: { color: s.color, face: 0 } }} size={28} />
              <span>
                <span className="suggestion__title">{s.name}</span>
                <br />
                <span className="suggestion__desc">{s.title}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
