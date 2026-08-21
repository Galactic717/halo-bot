import type { Agent, AgentStatus } from '../../host/types';

export const AVATAR_COLORS = ['blue', 'purple', 'green', 'orange', 'magenta', 'cyan', 'red', 'yellow', 'brown', 'gray'] as const;

const SLEEP_AFTER_MS = 30 * 60_000;

interface AvatarProps {
  agent: Pick<Agent, 'name' | 'avatar'> & { status?: AgentStatus; lastActivityAt?: number };
  size?: number;
  showStatus?: boolean;
}

/** Halo's own mark: a filled disc with a two-dot face whose eyes react to the bot's state. */
export function Avatar({ agent, size = 32, showStatus = false }: AvatarProps) {
  const color = `var(--avatar-${agent.avatar?.color ?? 'blue'})`;
  const idleFor = agent.lastActivityAt ? Date.now() - agent.lastActivityAt : 0;
  // A bot nobody has spoken to in a while dozes off, the way the original's avatars do.
  const status: AgentStatus = agent.status === 'idle' && idleFor > SLEEP_AFTER_MS ? 'sleeping' : agent.status ?? 'idle';
  const sleeping = status === 'sleeping';

  if (agent.avatar?.image) {
    return (
      <span className="avatar" style={{ width: size, height: size }}>
        <img
          className="avatar__image"
          src={`file://${agent.avatar.image.replace(/\\/g, '/')}`}
          alt=""
          width={size}
          height={size}
        />
        {showStatus && <span className="avatar__dot" data-status={status} />}
      </span>
    );
  }

  return (
    <span className="avatar" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden>
        <circle cx="20" cy="20" r="20" fill={color} />
        {sleeping ? (
          <>
            <path d="M12 19q3 3 6 0" stroke="#0d0d0d" strokeWidth="2.6" fill="none" strokeLinecap="round" />
            <path d="M22 19q3 3 6 0" stroke="#0d0d0d" strokeWidth="2.6" fill="none" strokeLinecap="round" />
          </>
        ) : (
          <>
            <ellipse cx="15" cy="17.5" rx="2.6" ry="3.6" fill="#0d0d0d" />
            <ellipse cx="25" cy="17.5" rx="2.6" ry="3.6" fill="#0d0d0d" />
          </>
        )}
        {status === 'working' && <path d="M15 26q5 4 10 0" stroke="#0d0d0d" strokeWidth="2.2" fill="none" strokeLinecap="round" />}
      </svg>
      {showStatus && <span className="avatar__dot" data-status={status} />}
    </span>
  );
}
