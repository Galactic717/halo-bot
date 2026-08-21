import { useEffect, useRef, useState } from 'react';
import type { ComputerState } from '../App';
import { CloseIcon, RefreshIcon, RecordIcon } from './Icons';

interface Teaching {
  agentId: string;
  seconds: number;
  steps: number;
}

interface ComputerPaneProps {
  agentId: string;
  state: ComputerState;
  /** Owned by the app, not by this pane: a recording outlives the pane being closed and reopened. */
  teaching: Teaching | null;
  onTeaching: (teaching: Teaching | null) => void;
  onClose: () => void;
}

/**
 * The bot's screen. The actual page is an Electron WebContentsView owned by the main
 * process; this component only reserves the rectangle and tells main where it is.
 */
function formatSeconds(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function ComputerPane({ agentId, state, teaching, onTeaching, onClose }: ComputerPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(state.url);

  useEffect(() => setUrl(state.url), [state.url]);

  const recording = Boolean(teaching);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      void window.halo.teachStatus().then((status) => onTeaching(status));
    }, 1000);
    return () => clearInterval(timer);
  }, [recording, onTeaching]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      const bounds = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
      void window.halo.computerShow(agentId, bounds);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [agentId]);

  return (
    <div className="chat">
      <div className="computer-bar">
        <input
          className="computer-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void window.halo.computerNavigate(agentId, url);
          }}
          aria-label="Address"
        />
        <button className="icon-button" onClick={() => void window.halo.computerNavigate(agentId, url)} aria-label="Reload">
          <RefreshIcon />
        </button>
        {teaching ? (
          <button
            className="btn teach-btn"
            data-recording="true"
            onClick={async () => {
              onTeaching(null);
              await window.halo.teachStop();
            }}
            aria-label="Stop and save recording"
          >
            <span className="rec-dot" />
            {formatSeconds(teaching.seconds)} · {teaching.steps} steps · Stop &amp; teach
          </button>
        ) : (
          <button
            className="btn teach-btn"
            onClick={async () => {
              await window.halo.teachStart(agentId);
              onTeaching({ agentId, seconds: 0, steps: 0 });
            }}
            aria-label="Teach a task"
          >
            <RecordIcon size={13} /> Teach a task
          </button>
        )}
        <button className="icon-button" onClick={onClose} aria-label="Close computer">
          <CloseIcon />
        </button>
      </div>
      <div className="computer-host" ref={host} data-recording={recording} />
    </div>
  );
}
