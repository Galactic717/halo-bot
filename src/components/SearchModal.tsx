import { useEffect, useState } from 'react';
import { SearchIcon } from './Icons';

interface Hit {
  conversationId: string;
  name: string;
  messageId: string;
  text: string;
  role: string;
  createdAt: number;
}

interface SearchModalProps {
  onClose: () => void;
  onOpen: (conversationId: string) => void;
}

export function SearchModal({ onClose, onOpen }: SearchModalProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (query.trim().length < 2) {
      setHits([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void window.halo.search(query).then((rows) => {
        if (alive) {
          setHits(rows);
          setSelected(0);
        }
      });
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, hits.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
      }
      if (e.key === 'Enter' && hits[selected]) {
        onOpen(hits[selected]!.conversationId);
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hits, selected, onClose, onOpen]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Search">
        <div className="palette__input">
          <SearchIcon size={16} />
          <input
            autoFocus
            value={query}
            placeholder="Search every conversation"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search query"
          />
        </div>

        <div className="palette__results">
          {query.trim().length >= 2 && hits.length === 0 && <p className="empty-note">Nothing found.</p>}
          {hits.map((hit, i) => (
            <button
              key={`${hit.conversationId}-${hit.messageId}`}
              className="palette__row"
              data-selected={i === selected}
              onMouseEnter={() => setSelected(i)}
              onClick={() => {
                onOpen(hit.conversationId);
                onClose();
              }}
            >
              <span className="palette__row-top">
                <span className="palette__name">{hit.name}</span>
                <span className="palette__time">{new Date(hit.createdAt).toLocaleString()}</span>
              </span>
              <span className="palette__snippet">{highlight(hit.text, query)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function highlight(text: string, query: string) {
  const at = text.toLowerCase().indexOf(query.trim().toLowerCase());
  if (at < 0) return text;
  const end = at + query.trim().length;
  return (
    <>
      {text.slice(Math.max(0, at - 60), at)}
      <mark>{text.slice(at, end)}</mark>
      {text.slice(end, end + 90)}
    </>
  );
}
