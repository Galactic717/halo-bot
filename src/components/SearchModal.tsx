import { useEffect, useMemo, useState } from 'react';
import { SearchIcon } from './Icons';
import type { Agent, Routine } from '../../host/types';

interface Hit {
  conversationId: string;
  name: string;
  messageId: string;
  text: string;
  role: string;
  createdAt: number;
}

/**
 * Ctrl+K is a command palette, not a message search.
 *
 * Grok Bot's is tabbed — messages, bots, groups, files, links, routines, actions — and the tabs are the
 * point: half of what anyone reaches for here is a place, not a phrase
 * (docs/GROK_BOT_0.24_0.27_TEARDOWN.md §11.4). Halo indexes messages, so Messages stays an async search
 * against the store; bots, routines and actions are already in memory and filter as you type.
 */
type Tab = 'all' | 'messages' | 'bots' | 'routines' | 'actions';

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'messages', label: 'Messages' },
  { id: 'bots', label: 'Bots' },
  { id: 'routines', label: 'Routines' },
  { id: 'actions', label: 'Actions' },
];

/** One thing the palette can land on, whatever kind it is. */
interface Row {
  key: string;
  kind: Exclude<Tab, 'all'>;
  name: string;
  detail?: string;
  meta?: string;
  run: () => void;
}

export interface PaletteAction {
  label: string;
  detail?: string;
  run: () => void;
}

interface SearchModalProps {
  agents: Agent[];
  routines: Routine[];
  actions: PaletteAction[];
  onClose: () => void;
  onOpen: (conversationId: string) => void;
}

const KIND_LABEL: Record<Exclude<Tab, 'all'>, string> = {
  messages: 'Message',
  bots: 'Bot',
  routines: 'Routine',
  actions: 'Action',
};

export function SearchModal({ agents, routines, actions, onClose, onOpen }: SearchModalProps) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [hits, setHits] = useState<Hit[]>([]);
  const [selected, setSelected] = useState(0);

  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < 2) {
      setHits([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void window.halo.search(trimmed).then((rows) => {
        if (alive) setHits(rows);
      });
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [trimmed]);

  const rows = useMemo(() => {
    const needle = trimmed.toLowerCase();
    const matches = (text: string) => !needle || text.toLowerCase().includes(needle);

    const bots: Row[] = agents
      .filter((a) => matches(`${a.name} ${a.title ?? ''} ${a.description ?? ''}`))
      .map((a) => ({
        key: `bot-${a.id}`,
        kind: 'bots',
        name: a.name,
        ...(a.title ? { detail: a.title } : {}),
        run: () => onOpen(a.id),
      }));

    const routineRows: Row[] = routines
      .filter((r) => matches(`${r.name} ${r.prompt}`))
      .map((r) => {
        const owner = agents.find((a) => a.id === r.agentId);
        return {
          key: `routine-${r.id}`,
          kind: 'routines' as const,
          name: r.name,
          detail: r.prompt.slice(0, 90),
          ...(owner ? { meta: owner.name } : {}),
          run: () => owner && onOpen(owner.id),
        };
      });

    const actionRows: Row[] = actions
      .filter((a) => matches(`${a.label} ${a.detail ?? ''}`))
      .map((a) => ({
        key: `action-${a.label}`,
        kind: 'actions',
        name: a.label,
        ...(a.detail ? { detail: a.detail } : {}),
        run: a.run,
      }));

    const messageRows: Row[] = hits.map((hit) => ({
      key: `msg-${hit.conversationId}-${hit.messageId}`,
      kind: 'messages',
      name: hit.name,
      detail: hit.text,
      meta: new Date(hit.createdAt).toLocaleString(),
      run: () => onOpen(hit.conversationId),
    }));

    const all = [...botsFirst(bots, actionRows, routineRows), ...messageRows];
    return tab === 'all' ? all : all.filter((row) => row.kind === tab);
  }, [agents, routines, actions, hits, trimmed, tab, onOpen]);

  // The selection is an index into a list that changes as you type; snap it back rather than leaving it
  // pointing past the end, where Enter would do nothing.
  useEffect(() => setSelected(0), [trimmed, tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, rows.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const at = TABS.findIndex((t) => t.id === tab);
        setTab(TABS[(at + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length]!.id);
      }
      if (e.key === 'Enter' && rows[selected]) {
        rows[selected]!.run();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, selected, tab, onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Search">
        <div className="palette__input">
          <SearchIcon size={16} />
          <input
            autoFocus
            value={query}
            placeholder="Search bots, routines, messages and actions"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search query"
          />
        </div>

        <div className="palette__tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              className="palette__tab"
              aria-selected={tab === t.id}
              data-selected={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="palette__results">
          {rows.length === 0 && (
            <p className="empty-note">{trimmed.length >= 2 || tab !== 'all' ? 'Nothing found.' : 'Type to search.'}</p>
          )}
          {rows.map((row, i) => (
            <button
              key={row.key}
              className="palette__row"
              data-selected={i === selected}
              onMouseEnter={() => setSelected(i)}
              onClick={() => {
                row.run();
                onClose();
              }}
            >
              <span className="palette__row-top">
                <span className="palette__name">{row.name}</span>
                <span className="palette__time">{row.meta ?? KIND_LABEL[row.kind]}</span>
              </span>
              {row.detail && (
                <span className="palette__snippet">
                  {row.kind === 'messages' ? highlight(row.detail, trimmed) : row.detail}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Places and commands before prose: with no query typed, a message hit is the least likely target. */
function botsFirst(bots: Row[], actions: Row[], routines: Row[]): Row[] {
  return [...bots, ...routines, ...actions];
}

function highlight(text: string, query: string) {
  if (!query) return text;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text;
  const end = at + query.length;
  return (
    <>
      {text.slice(Math.max(0, at - 60), at)}
      <mark>{text.slice(at, end)}</mark>
      {text.slice(end, end + 90)}
    </>
  );
}
