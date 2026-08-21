import { useState } from 'react';
import type { Agent, Channel } from '../../host/types';
import { Avatar } from './Avatar';
import { ChevronsRightIcon, CloseIcon, PlusIcon, TrashIcon } from './Icons';

interface ChannelDetailsProps {
  channel: Channel;
  members: Agent[];
  allAgents: Agent[];
  onClose: () => void;
  onDelete: () => Promise<void>;
}

export function ChannelDetails({ channel, members, allAgents, onClose, onDelete }: ChannelDetailsProps) {
  const [adding, setAdding] = useState(false);
  const candidates = allAgents.filter((a) => !channel.memberIds.includes(a.id));

  const setMembers = (memberIds: string[]) => void window.halo.updateChannel(channel.id, { memberIds });
  return (
    <aside className="details" aria-label="Channel details">
      <div className="details__header">
        <span className="details__title">{channel.name}</span>
        <button className="icon-button" onClick={onClose} aria-label="Close details">
          <ChevronsRightIcon />
        </button>
      </div>

      <div className="details__body">
        <div>
          <div className="section-label">Members</div>
          {members.map((member) => (
            <div className="member-row" key={member.id}>
              <Avatar agent={member} size={26} showStatus />
              <span style={{ flex: 1 }}>{member.name}</span>
              <button
                className="icon-button"
                aria-label={`Remove ${member.name}`}
                onClick={() => setMembers(channel.memberIds.filter((id) => id !== member.id))}
              >
                <CloseIcon size={13} />
              </button>
            </div>
          ))}

          {adding ? (
            <div className="card" style={{ marginTop: 8 }}>
              {candidates.length === 0 && <p className="empty-note">Every bot is already in this room.</p>}
              {candidates.map((agent) => (
                <button
                  className="member-row"
                  key={agent.id}
                  onClick={() => {
                    setMembers([...channel.memberIds, agent.id]);
                    setAdding(false);
                  }}
                >
                  <Avatar agent={agent} size={22} />
                  <span>{agent.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <button className="btn" style={{ width: '100%', marginTop: 8 }} onClick={() => setAdding(true)}>
              <PlusIcon size={13} /> Add a bot
            </button>
          )}

          <p className="empty-note">Mention a bot with @name to address it directly.</p>
        </div>

        <button
          className="btn"
          data-variant="danger"
          onClick={() => {
            if (confirm(`Delete the channel "${channel.name}"? The bots themselves stay.`)) void onDelete();
          }}
        >
          <TrashIcon /> Delete channel
        </button>
      </div>
    </aside>
  );
}
