import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, ApprovalRequest, Channel, HaloEvent, Message, Routine, Settings } from '../host/types';
import { Sidebar } from './components/Sidebar';
import { Chat } from './components/Chat';
import { Details } from './components/Details';
import { SettingsModal } from './components/SettingsModal';
import { Onboarding, type NewBotInput } from './components/Onboarding';
import { ComputerPane } from './components/ComputerPane';
import { ChannelDetails } from './components/ChannelDetails';
import { PluginsModal } from './components/PluginsModal';
import { SearchModal } from './components/SearchModal';
import { Setup } from './components/Setup';
import { WarningIcon } from './components/Icons';
import { AboutModal } from './components/AboutModal';

export interface ComputerState {
  agentId: string | null;
  url: string;
  title: string;
  visible: boolean;
}

export function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Record<string, Message[]>>({});
  const [settings, setSettings] = useState<Settings | null>(null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [statuses, setStatuses] = useState<Record<string, { status: Agent['status']; note?: string }>>({});
  const [computer, setComputer] = useState<ComputerState>({ agentId: null, url: '', title: '', visible: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [confinementError, setConfinementError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, { text: string; at: number; fromAgentId?: string }>>({});
  const [detailsTab, setDetailsTab] = useState<'details' | 'settings' | null>('details');
  const [creating, setCreating] = useState(false);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [teaching, setTeaching] = useState<{ agentId: string; seconds: number; steps: number } | null>(null);
  /** Who has the wheel on each bot's browser, and what it asked for when it handed over. */
  const [control, setControl] = useState<Record<string, { holder: 'bot' | 'human'; requested: boolean; instruction?: string }>>({});
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  /**
   * Which transcripts have been read off disk. A background bot's message creates an entry in
   * `transcripts` on its own, so the presence of an entry says nothing about whether the history
   * behind it was ever loaded.
   */
  const loaded = useRef<Set<string>>(new Set());

  // -------------------------------------------------------------- bootstrap
  useEffect(() => {
    void (async () => {
      const snap = await window.halo.snapshot();
      setAgents(snap.agents);
      setChannels(snap.channels ?? []);
      setSettings(snap.settings);
      setRoutines(snap.routines);
      setApprovals(snap.approvals);
      setActiveId(snap.activeAgentId);
      if (snap.confinement && !snap.confinement.confined) setConfinementError(snap.confinement.detail);
      setPreviews(await window.halo.previews());
      setTeaching(await window.halo.teachStatus());
      document.documentElement.dataset.theme = resolveTheme(snap.settings.theme);
    })();
  }, []);

  useEffect(() => {
    return window.halo.onEvent((event: HaloEvent) => {
      switch (event.type) {
        case 'agents':
          setAgents(event.agents);
          break;
        case 'message':
          setTranscripts((cur) => {
            const list = cur[event.message.agentId] ?? [];
            if (list.some((m) => m.id === event.message.id)) return cur;
            return { ...cur, [event.message.agentId]: [...list, event.message] };
          });
          if (event.message.agentId !== activeIdRef.current && event.message.role !== 'user') {
            setUnread((cur) => ({ ...cur, [event.message.agentId]: (cur[event.message.agentId] ?? 0) + 1 }));
          }
          break;
        case 'message.patch':
          setTranscripts((cur) => {
            const list = cur[event.agentId];
            if (!list) return cur;
            return {
              ...cur,
              [event.agentId]: list.map((m) =>
                m.id === event.messageId
                  ? { ...m, ...(event.text !== undefined ? { text: event.text } : {}), ...(event.reactions ? { reactions: event.reactions } : {}) }
                  : m,
              ),
            };
          });
          break;
        case 'tool':
          setTranscripts((cur) => {
            const list = cur[event.agentId];
            if (!list) return cur;
            return {
              ...cur,
              [event.agentId]: list.map((m) => {
                if (m.id !== event.messageId) return m;
                const calls = [...(m.toolCalls ?? [])];
                const i = calls.findIndex((c) => c.id === event.call.id);
                if (i >= 0) calls[i] = event.call;
                else calls.push(event.call);
                return { ...m, toolCalls: calls };
              }),
            };
          });
          break;
        case 'status':
          setStatuses((cur) => ({ ...cur, [event.agentId]: { status: event.status, note: event.note } }));
          setAgents((cur) => cur.map((a) => (a.id === event.agentId ? { ...a, status: event.status } : a)));
          break;
        case 'approval':
          setApprovals((cur) => [...cur, event.approval]);
          break;
        case 'approval.resolved':
          setApprovals((cur) => cur.filter((a) => a.id !== event.id));
          break;
        case 'routines':
          setRoutines(event.routines);
          break;
        case 'channels':
          setChannels(event.channels);
          break;
        case 'confinement':
          setConfinementError(event.confined ? null : event.detail);
          break;
        case 'provider':
          setProviderError(
            event.ok
              ? null
              : event.kind === 'model'
                ? (event.error ?? 'this model will not work')
                : `Model server unreachable at ${event.baseUrl} — ${event.error ?? 'no answer'}`,
          );
          break;
        case 'settings':
          setSettings(event.settings);
          document.documentElement.dataset.theme = resolveTheme(event.settings.theme);
          break;
        case 'computer':
          setComputer({ agentId: event.agentId, url: event.url, title: event.title, visible: event.visible });
          break;
        case 'control':
          setControl((cur) => ({
            ...cur,
            [event.agentId]: {
              holder: event.holder,
              requested: event.requested,
              ...(event.instruction ? { instruction: event.instruction } : {}),
            },
          }));
          break;
        case 'teaching':
          setTeaching(event.recording ? { agentId: event.agentId, seconds: event.seconds, steps: event.steps } : null);
          break;
        case 'focus':
          setActiveId(event.agentId);
          setUnread((cur) => ({ ...cur, [event.agentId]: 0 }));
          break;
        case 'error':
          console.error('[halo]', event.message);
          break;
        default:
          break;
      }
    });
  }, []);

  // load transcript lazily per conversation, once
  useEffect(() => {
    if (!activeId || loaded.current.has(activeId)) return;
    loaded.current.add(activeId);
    void window.halo.transcript(activeId).then((list) =>
      setTranscripts((cur) => {
        // anything that arrived while the file was being read is kept, not overwritten
        const live = cur[activeId] ?? [];
        const known = new Set(list.map((m) => m.id));
        return { ...cur, [activeId]: [...list, ...live.filter((m) => !known.has(m.id))] };
      }),
    );
  }, [activeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    void window.halo.reportUnread(unread);
  }, [unread]);

  const overlayOpen = settingsOpen || pluginsOpen || aboutOpen || searchOpen || creating;
  useEffect(() => {
    void window.halo.computerSuspend(overlayOpen);
  }, [overlayOpen]);

  const activeAgent = useMemo(() => agents.find((a) => a.id === activeId) ?? null, [agents, activeId]);
  const activeChannel = useMemo(() => channels.find((c) => c.id === activeId) ?? null, [channels, activeId]);
  const channelMembers = useMemo(
    () => (activeChannel ? activeChannel.memberIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => Boolean(a)) : []),
    [activeChannel, agents],
  );
  const messages = activeId ? transcripts[activeId] ?? [] : [];
  const activeApprovals = approvals.filter((a) => a.agentId === activeId);

  const send = useCallback(
    async (text: string, attachments: { path: string; name: string; size: number }[]) => {
      if (!activeId) return;
      await window.halo.send(activeId, text, attachments);
    },
    [activeId],
  );

  const createAgent = useCallback(async (input: NewBotInput) => {
    const agent = await window.halo.createAgent({
      name: input.name,
      title: input.title ?? '',
      description: input.description ?? '',
      avatar: { color: input.color, face: 0 },
      ...(input.personaId ? { personaId: input.personaId } : {}),
      ...(input.persona ? { persona: input.persona } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
    setActiveId(agent.id);
    setCreating(false);
    return agent;
  }, []);

  const toggleComputer = useCallback(() => {
    if (!activeId) return;
    if (computer.visible && computer.agentId === activeId) void window.halo.computerHide();
    else setComputer((c) => ({ ...c, agentId: activeId, visible: true }));
  }, [activeId, computer]);

  const accountName = 'This machine';

  if (!settings) return <div className="app" />;

  if (!settings.onboarded) {
    return (
      <>
        <div className="titlebar" />
        <Setup
          settings={settings}
          onSave={async (patch) => {
            const next = await window.halo.saveSettings(patch);
            setSettings(next);
          }}
          onDone={() => setCreating(true)}
        />
      </>
    );
  }

  const showOnboarding = creating || (agents.length === 0 && channels.length === 0);

  return (
    <div className="app" style={{ gridTemplateColumns: `var(--sidebar-width) minmax(424px, 1fr) ${detailsTab ? 'auto' : '0'}` }}>
      <div className="titlebar" />
      {(providerError || confinementError) && (
        <div className="banners">
          {confinementError && (
            <div className="provider-banner" role="alert">
              <WarningIcon size={14} />
              <span>Bot shells are switched off: {confinementError}. Reinstall Halo to restore the box.</span>
            </div>
          )}
          {providerError && (
            <div className="provider-banner" role="status">
              <WarningIcon size={14} />
              <span>{providerError}</span>
              <button className="btn" onClick={() => void window.halo.checkProvider()}>
                Retry
              </button>
              <button className="btn" data-variant="primary" onClick={() => setSettingsOpen(true)}>
                Open settings
              </button>
            </div>
          )}
        </div>
      )}
      <Sidebar
        agents={agents}
        channels={channels}
        onNewChannel={async (name, memberIds) => {
          const channel = await window.halo.createChannel(name, memberIds);
          setActiveId(channel.id);
        }}
        activeId={activeId}
        approvals={approvals}
        unread={unread}
        onSelect={(id) => {
          setActiveId(id);
          setUnread((cur) => ({ ...cur, [id]: 0 }));
          setCreating(false);
          if (computer.visible) void window.halo.computerHide();
        }}
        onNew={() => setCreating(true)}
        onEditProfile={() => setDetailsTab('settings')}
        sections={settings.sections ?? []}
        onSaveSections={(sections) => void window.halo.saveSettings({ sections })}
        onMarkUnread={(id) => setUnread((cur) => ({ ...cur, [id]: Math.max(1, cur[id] ?? 0) }))}
        onOpenPlugins={() => setPluginsOpen(true)}
        onAbout={() => setAboutOpen(true)}
        accountName={accountName}
        transcripts={transcripts}
        previews={previews}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {showOnboarding ? (
        <Onboarding
          onCreate={createAgent}
          canCancel={agents.length > 0}
          onCancel={() => setCreating(false)}
          defaultModel={settings.provider.model}
        />
      ) : computer.visible && computer.agentId === activeId ? (
        <ComputerPane
          agentId={activeId!}
          state={computer}
          teaching={teaching && teaching.agentId === activeId ? teaching : null}
          onTeaching={setTeaching}
          control={control[activeId!] ?? { holder: 'bot', requested: false }}
          onControl={(next) =>
            setControl((cur) => ({ ...cur, [activeId!]: { ...(cur[activeId!] ?? { holder: 'bot', requested: false }), ...next } }))
          }
          onClose={() => void window.halo.computerHide()}
        />
      ) : (
        <Chat
          agent={activeAgent}
          channel={activeChannel}
          members={channelMembers}
          allAgents={agents}
          messages={messages}
          approvals={activeApprovals}
          status={statuses[activeId ?? '']}
          onSend={send}
          onStop={() => activeId && void window.halo.stop(activeId)}
          onToggleComputer={toggleComputer}
          computerOpen={computer.visible && computer.agentId === activeId}
          onOpenDetails={() => setDetailsTab((t) => (t ? null : 'details'))}
          conversationId={activeId ?? ''}
          onQuote={(text) => setDraft(`> ${text.replace(/\n/g, '\n> ').slice(0, 500)}\n`)}
          draft={draft}
          onDraftUsed={() => setDraft(undefined)}
        />
      )}

      {detailsTab && activeChannel && (
        <ChannelDetails
          channel={activeChannel}
          members={channelMembers}
          allAgents={agents}
          onClose={() => setDetailsTab(null)}
          onDelete={async () => {
            await window.halo.deleteChannel(activeChannel.id);
            setActiveId(agents[0]?.id ?? null);
          }}
        />
      )}

      {detailsTab && activeAgent && (
        <Details
          agent={activeAgent}
          tab={detailsTab}
          routines={routines.filter((r) => r.agentId === activeAgent.id)}
          onTab={setDetailsTab}
          onClose={() => setDetailsTab(null)}
          onUpdateAgent={async (patch) => {
            const next = await window.halo.updateAgent(activeAgent.id, patch);
            if (next) setAgents((cur) => cur.map((a) => (a.id === next.id ? next : a)));
          }}
          onDeleteAgent={async () => {
            await window.halo.deleteAgent(activeAgent.id);
            setActiveId(null);
          }}
          onOpenComputer={toggleComputer}
        />
      )}

      {searchOpen && (
        <SearchModal
          agents={agents}
          routines={routines}
          actions={[
            { label: 'New bot', detail: 'Ctrl+N', run: () => setCreating(true) },
            { label: 'Plugins', detail: 'MCP servers and skills', run: () => setPluginsOpen(true) },
            { label: 'Settings', detail: 'Model, permissions, activity', run: () => setSettingsOpen(true) },
            { label: 'About Halo Bot', run: () => setAboutOpen(true) },
          ]}
          onClose={() => setSearchOpen(false)}
          onOpen={(id) => {
            setActiveId(id);
            setUnread((cur) => ({ ...cur, [id]: 0 }));
          }}
        />
      )}
      {pluginsOpen && <PluginsModal onClose={() => setPluginsOpen(false)} />}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}

      {settingsOpen && settings && (
        <SettingsModal
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSave={async (patch) => {
            const next = await window.halo.saveSettings(patch);
            setSettings(next);
            document.documentElement.dataset.theme = resolveTheme(next.theme);
          }}
        />
      )}
    </div>
  );
}

function resolveTheme(theme: Settings['theme']): 'dark' | 'light' {
  const resolved = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
  // The native title bar is painted by Windows, so it has to be told about the theme too.
  void window.halo.setTheme(resolved);
  return resolved;
}
