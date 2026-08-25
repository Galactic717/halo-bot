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
  /** Who is driving. While a person holds the wheel every bot action on this browser is refused. */
  control: { holder: 'bot' | 'human'; requested: boolean; instruction?: string };
  onControl: (next: { holder?: 'bot' | 'human'; requested?: boolean }) => void;
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

export function ComputerPane({ agentId, state, teaching, onTeaching, control, onControl, onClose }: ComputerPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(state.url);

  useEffect(() => setUrl(state.url), [state.url]);

  // Control belongs to the browser, not to this pane: a request made while the pane was closed is
  // still live when it opens.
  useEffect(() => {
    void window.halo.control(agentId).then((state) => onControl({ holder: state.holder, requested: state.requested }));
  }, [agentId]);

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
      {/*
        One browser, one driver. A bot that hits a sign-in asks for the wheel; while a person holds
        it, every action the bot tries is refused rather than queued, because two drivers on one page
        is how a bot presses Confirm on a form somebody was still filling in.
      */}
      {(control.holder === 'human' || control.requested) && (
        <div className="control-bar" data-holder={control.holder}>
          <span className="control-bar__text">
            {control.holder === 'human'
              ? 'You have the wheel. The bot is waiting and cannot touch this page.'
              : control.instruction || 'The bot needs you to do something here.'}
          </span>
          {control.holder === 'human' ? (
            <button
              className="btn"
              data-variant="primary"
              onClick={async () => {
                await window.halo.releaseControl(agentId);
                onControl({ holder: 'bot', requested: false });
              }}
            >
              Give it back
            </button>
          ) : (
            <button
              className="btn"
              data-variant="primary"
              onClick={async () => {
                await window.halo.takeControl(agentId);
                onControl({ holder: 'human', requested: false });
              }}
            >
              Take control
            </button>
          )}
        </div>
      )}
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
