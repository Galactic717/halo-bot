import { useState } from 'react';
import type { Agent, ApprovalRequest, Channel, Message, Settings } from '../../host/types';
import { Avatar } from './Avatar';
import { PlusIcon, SearchIcon, GearIcon, PlugIcon, FolderIcon, InfoIcon, PowerIcon } from './Icons';

interface SidebarProps {
  agents: Agent[];
  channels: Channel[];
  activeId: string | null;
  transcripts: Record<string, Message[]>;
  previews: Record<string, { text: string; at: number; fromAgentId?: string }>;
  approvals: ApprovalRequest[];
  unread: Record<string, number>;
  sections: Settings['sections'];
  accountName: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onNewChannel: (name: string, memberIds: string[]) => Promise<void>;
  onEditProfile: (agentId: string) => void;
  onOpenPlugins: () => void;
  onOpenSettings: () => void;
  onAbout: () => void;
  onSaveSections: (sections: Settings['sections']) => void;
  onMarkUnread: (agentId: string) => void;
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

export function Sidebar({
  agents,
  channels,
  activeId,
  transcripts,
  previews,
  approvals,
  unread,
  sections,
  accountName,
  onSelect,
  onNew,
  onNewChannel,
  onEditProfile,
  onOpenPlugins,
  onOpenSettings,
  onAbout,
  onSaveSections,
  onMarkUnread,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [channelDraft, setChannelDraft] = useState<{ name: string; members: string[] } | null>(null);
  const [rowMenu, setRowMenu] = useState<{ agent: Agent; x: number; y: number } | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  const initials =
    accountName
      .split(/\s+/)
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || 'H';

  const searching = query.trim().length > 0;
  const matches = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());

  const visibleAgents = agents.filter((a) => matches(a.name) && (!a.hidden || searching));
  const visibleChannels = channels.filter((c) => matches(c.name));
  const pinnedAgents = visibleAgents.filter((a) => a.pinned);
  const unpinned = visibleAgents.filter((a) => !a.pinned);
  const sectioned = new Set(sections.flatMap((s) => s.agentIds));
  const loose = unpinned.filter((a) => !sectioned.has(a.id));

  const moveToSection = (agentId: string, sectionId: string | null) => {
    const cleaned = sections.map((section) => ({ ...section, agentIds: section.agentIds.filter((id) => id !== agentId) }));
    if (sectionId === null) {
      onSaveSections(cleaned.filter((section) => section.agentIds.length > 0));
      return;
    }
    if (sectionId === '__new__') {
      const name = window.prompt('Name the new section');
      if (!name?.trim()) return;
      onSaveSections([...cleaned, { id: crypto.randomUUID(), name: name.trim(), agentIds: [agentId] }]);
      return;
    }
    onSaveSections(
      cleaned.map((section) => (section.id === sectionId ? { ...section, agentIds: [...section.agentIds, agentId] } : section)),
    );
  };

  const lastOf = (id: string): { text: string; createdAt: number; fromAgentId?: string } | undefined => {
    const loaded = [...(transcripts[id] ?? [])].reverse().find((m) => m.text.trim().length > 0);
    if (loaded) return { text: loaded.text, createdAt: loaded.createdAt, ...(loaded.fromAgentId ? { fromAgentId: loaded.fromAgentId } : {}) };
    const preview = previews[id];
    return preview ? { text: preview.text, createdAt: preview.at, ...(preview.fromAgentId ? { fromAgentId: preview.fromAgentId } : {}) } : undefined;
  };

  const renderAgent = (agent: Agent) => {
    const last = lastOf(agent.id);
    const pending = approvals.find((a) => a.agentId === agent.id);
    const unreadCount = unread[agent.id] ?? 0;

    return (
      <button
        key={agent.id}
        className="agent-row"
        data-selected={agent.id === activeId}
        onClick={() => onSelect(agent.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMoveOpen(false);
          setRowMenu({ agent, x: e.clientX, y: e.clientY });
        }}
        aria-label={agent.name}
      >
        <Avatar agent={agent} size={32} showStatus />
        <span className="agent-row__body">
          <span className="agent-row__title">
            <span className="agent-row__name">
              {agent.pinned && <span className="pin-dot" aria-label="Pinned" />}
              {agent.name}
            </span>
            <span className="agent-row__time">
              {unreadCount > 0 && agent.id !== activeId ? <span className="unread-dot" aria-label="Unread activity" /> : null}
              {timeLabel(last?.createdAt ?? agent.lastActivityAt)}
            </span>
          </span>
          <span className="agent-row__preview">
            {pending ? (
              <span className="agent-row__pending">Permission required: {pending.summary}</span>
            ) : agent.status === 'working' ? (
              <span className="shimmer">Working…</span>
            ) : (
              last?.text.replace(/\s+/g, ' ').slice(0, 80) || agent.title || 'No messages yet'
            )}
          </span>
        </span>
      </button>
    );
  };

  const renderChannel = (channel: Channel) => {
    const last = lastOf(channel.id);
    const members = channel.memberIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => Boolean(a));
    const sender = last?.fromAgentId ? agents.find((a) => a.id === last.fromAgentId)?.name : undefined;

    return (
      <button
        key={channel.id}
        className="agent-row"
        data-selected={channel.id === activeId}
        onClick={() => onSelect(channel.id)}
        aria-label={channel.name}
      >
        <span className="avatar-stack">
          {members.slice(0, 3).map((member) => (
            <Avatar key={member.id} agent={member} size={22} />
          ))}
        </span>
        <span className="agent-row__body">
          <span className="agent-row__title">
            <span className="agent-row__name">{channel.name}</span>
            <span className="agent-row__time">
              {(unread[channel.id] ?? 0) > 0 && channel.id !== activeId ? <span className="unread-dot" /> : null}
              {timeLabel(last?.createdAt ?? channel.lastActivityAt)}
            </span>
          </span>
          <span className="agent-row__preview">
            {last ? `${sender ? `${sender}: ` : ''}${last.text.replace(/\s+/g, ' ').slice(0, 70)}` : 'No messages yet'}
          </span>
        </span>
      </button>
    );
  };

  return (
    <aside className="sidebar" aria-label="Halo Bot agents">
      <div className="sidebar__top">
        <div className="menu-anchor">
          <button
            className="icon-button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="New bot or channel"
            title="New bot or channel"
          >
            <PlusIcon />
          </button>
          {menuOpen && (
            <>
              <div className="menu-scrim" onClick={() => setMenuOpen(false)} />
              <div className="menu" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onNew();
                  }}
                >
                  New bot
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setChannelDraft({ name: '', members: [] });
                  }}
                >
                  New channel
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void window.halo.importAgent().then((agent) => agent && onSelect(agent.id));
                  }}
                >
                  Import bot…
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="sidebar__search">
        <SearchIcon />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search" />
      </div>

      {pinnedAgents.length > 0 && (
        <div className="pin-grid" aria-label="Pinned bots">
          {pinnedAgents.map((agent) => (
            <button
              key={agent.id}
              className="pin-tile"
              data-selected={agent.id === activeId}
              onClick={() => onSelect(agent.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMoveOpen(false);
                setRowMenu({ agent, x: e.clientX, y: e.clientY });
              }}
              aria-label={agent.name}
            >
              <Avatar agent={agent} size={36} showStatus />
              <span className="pin-tile__name">
                {agent.status === 'working' ? <span className="shimmer">Working…</span> : agent.name}
              </span>
              {(unread[agent.id] ?? 0) > 0 && agent.id !== activeId && <span className="unread-dot pin-tile__dot" />}
            </button>
          ))}
        </div>
      )}

      <div className="sidebar__list" aria-label="Agent list">
        {visibleAgents.length === 0 && visibleChannels.length === 0 && <p className="sidebar__empty">No chats yet</p>}

        {visibleChannels.map(renderChannel)}

        {sections.map((section) => {
          const members = section.agentIds
            .map((id) => unpinned.find((a) => a.id === id))
            .filter((a): a is Agent => Boolean(a));
          if (members.length === 0) return null;
          return (
            <div className="sidebar__section" key={section.id}>
              <button
                className="sidebar__section-head"
                onClick={() => onSaveSections(sections.map((s) => (s.id === section.id ? { ...s, collapsed: !s.collapsed } : s)))}
                aria-label={`Toggle ${section.name}`}
              >
                <span className="chevron" data-collapsed={Boolean(section.collapsed)}>
                  ›
                </span>
                <span>{section.name}</span>
                <span className="sidebar__section-count">{members.length}</span>
              </button>
              {!section.collapsed && members.map(renderAgent)}
            </div>
          );
        })}

        {loose.map(renderAgent)}
      </div>

      {rowMenu && (
        <>
          <div
            className="menu-scrim"
            onClick={() => setRowMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setRowMenu(null);
            }}
          />
          <div
            className="menu"
            role="menu"
            style={{ position: 'fixed', top: rowMenu.y, left: Math.min(rowMenu.x, 200), right: 'auto' }}
          >
            <button
              role="menuitem"
              onClick={() => {
                void window.halo.updateAgent(rowMenu.agent.id, { pinned: !rowMenu.agent.pinned });
                setRowMenu(null);
              }}
            >
              {rowMenu.agent.pinned ? 'Unpin' : 'Pin'}
            </button>
            <div className="menu-anchor">
              <button role="menuitem" onClick={() => setMoveOpen((v) => !v)}>
                Move to section ›
              </button>
              {moveOpen && (
                <div className="menu menu--sub" role="menu">
                  {sections.map((section) => (
                    <button
                      key={section.id}
                      role="menuitem"
                      onClick={() => {
                        moveToSection(rowMenu.agent.id, section.id);
                        setRowMenu(null);
                        setMoveOpen(false);
                      }}
                    >
                      {section.name}
                    </button>
                  ))}
                  <button
                    role="menuitem"
                    onClick={() => {
                      moveToSection(rowMenu.agent.id, '__new__');
                      setRowMenu(null);
                      setMoveOpen(false);
                    }}
                  >
                    New section…
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      moveToSection(rowMenu.agent.id, null);
                      setRowMenu(null);
                      setMoveOpen(false);
                    }}
                  >
                    Remove from section
                  </button>
                </div>
              )}
            </div>
            <button
              role="menuitem"
              onClick={() => {
                onSelect(rowMenu.agent.id);
                onEditProfile(rowMenu.agent.id);
                setRowMenu(null);
              }}
            >
              Edit profile
            </button>
            <button
              role="menuitem"
              onClick={() => {
                void window.halo.duplicateAgent(rowMenu.agent.id);
                setRowMenu(null);
              }}
            >
              Duplicate
            </button>
            <button
              role="menuitem"
              onClick={() => {
                void window.halo.exportAgent(rowMenu.agent.id);
                setRowMenu(null);
              }}
            >
              Export bot…
            </button>
            <button
              role="menuitem"
              onClick={() => {
                onMarkUnread(rowMenu.agent.id);
                setRowMenu(null);
              }}
            >
              Mark as unread
            </button>
            <button
              role="menuitem"
              onClick={() => {
                void navigator.clipboard.writeText(rowMenu.agent.id);
                setRowMenu(null);
              }}
            >
              Copy bot id
            </button>
            <button
              role="menuitem"
              onClick={() => {
                void window.halo.updateAgent(rowMenu.agent.id, { hidden: !rowMenu.agent.hidden });
                setRowMenu(null);
              }}
            >
              {rowMenu.agent.hidden ? 'Show in sidebar' : 'Hide from sidebar'}
            </button>
            <button
              role="menuitem"
              data-danger="true"
              onClick={() => {
                if (window.confirm(`Delete ${rowMenu.agent.name} and all of its history?`)) {
                  void window.halo.deleteAgent(rowMenu.agent.id);
                }
                setRowMenu(null);
              }}
            >
              Delete
            </button>
          </div>
        </>
      )}

      {channelDraft && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setChannelDraft(null)}>
          <div className="modal modal--small" role="dialog" aria-label="New channel">
            <div className="modal__body">
              <h2>New channel</h2>
              <div className="field">
                <label>Name</label>
                <input
                  className="input"
                  autoFocus
                  value={channelDraft.name}
                  placeholder="Ops Room"
                  onChange={(e) => setChannelDraft({ ...channelDraft, name: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Bots</label>
                <div className="card">
                  {agents.map((agent) => (
                    <label className="member-row" key={agent.id}>
                      <input
                        type="checkbox"
                        checked={channelDraft.members.includes(agent.id)}
                        onChange={(e) =>
                          setChannelDraft({
                            ...channelDraft,
                            members: e.target.checked
                              ? [...channelDraft.members, agent.id]
                              : channelDraft.members.filter((id) => id !== agent.id),
                          })
                        }
                      />
                      <Avatar agent={agent} size={22} />
                      <span>{agent.name}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="approval__actions">
                <button
                  className="btn"
                  data-variant="primary"
                  disabled={!channelDraft.name.trim() || channelDraft.members.length === 0}
                  onClick={() => {
                    void onNewChannel(channelDraft.name.trim(), channelDraft.members);
                    setChannelDraft(null);
                  }}
                >
                  Create
                </button>
                <button className="btn" onClick={() => setChannelDraft(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="sidebar__footer">
        <button className="footer-row" onClick={onOpenPlugins}>
          <PlugIcon />
          <span>Plugins</span>
        </button>

        <div className="menu-anchor">
          <button className="footer-row" onClick={() => setAccountOpen((v) => !v)} aria-label="Open account menu">
            <span className="account-badge">{initials}</span>
            <span>{accountName}</span>
          </button>
          {accountOpen && (
            <>
              <div className="menu-scrim" onClick={() => setAccountOpen(false)} />
              <div className="menu menu--up" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setAccountOpen(false);
                    onOpenSettings();
                  }}
                >
                  <GearIcon size={14} /> Settings
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setAccountOpen(false);
                    onOpenPlugins();
                  }}
                >
                  <PlugIcon size={14} /> Plugins
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setAccountOpen(false);
                    void window.halo.openDataDir();
                  }}
                >
                  <FolderIcon size={14} /> Open data folder
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setAccountOpen(false);
                    onAbout();
                  }}
                >
                  <InfoIcon size={14} /> About Halo Bot
                </button>
                <button role="menuitem" data-danger="true" onClick={() => void window.halo.quit()}>
                  <PowerIcon size={14} /> Quit
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
