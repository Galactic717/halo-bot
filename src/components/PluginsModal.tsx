import { useEffect, useMemo, useState } from 'react';
import type { McpServerSpec, McpServerStatus } from '../../host/mcp';
import { CloseIcon, PlugIcon, RefreshIcon, SearchIcon, TrashIcon } from './Icons';

interface PluginsModalProps {
  onClose: () => void;
}

export function PluginsModal({ onClose }: PluginsModalProps) {
  const [tab, setTab] = useState<'marketplace' | 'yours'>('marketplace');
  const [catalog, setCatalog] = useState<McpServerSpec[]>([]);
  const [installed, setInstalled] = useState<McpServerSpec[]>([]);
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<McpServerSpec | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');

  const refresh = async () => {
    setInstalled(await window.halo.pluginsInstalled());
    setStatuses(await window.halo.pluginStatus());
  };

  useEffect(() => {
    void window.halo.pluginCatalog().then(setCatalog);
    void refresh();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const installedIds = new Set(installed.map((p) => p.id));
  const statusById = new Map(statuses.map((s) => [s.id, s]));

  const shown = useMemo(() => {
    const list = tab === 'marketplace' ? catalog : installed;
    const needle = query.trim().toLowerCase();
    return list.filter((p) => !needle || `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(needle));
  }, [tab, catalog, installed, query]);

  const categories = useMemo(() => {
    const groups = new Map<string, McpServerSpec[]>();
    for (const plugin of shown) {
      const list = groups.get(plugin.category) ?? [];
      list.push(plugin);
      groups.set(plugin.category, list);
    }
    return [...groups.entries()];
  }, [shown]);

  const install = async (spec: McpServerSpec, env: Record<string, string> = {}) => {
    setBusy(spec.id);
    try {
      setStatuses(await window.halo.installPlugin({ ...spec, env, enabled: true }));
      await refresh();
    } finally {
      setBusy('');
    }
  };

  const startInstall = (spec: McpServerSpec) => {
    if (spec.requires?.length) {
      setSecrets({});
      setPending(spec);
      return;
    }
    void install(spec);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal--plugins" role="dialog" aria-label="Plugins">
        <div className="modal__body">
          <button className="icon-button modal__close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>

          <h2>Plugins</h2>
          <p className="setting-row__desc" style={{ marginTop: -12, marginBottom: 16 }}>
            Plugins are MCP servers. Installing one gives every bot its tools, namespaced as <code>mcp__…</code>.
          </p>

          <div className="plugins__bar">
            <div className="tabs">
              <button data-active={tab === 'marketplace'} onClick={() => setTab('marketplace')}>
                Marketplace
              </button>
              <button data-active={tab === 'yours'} onClick={() => setTab('yours')}>
                Yours {installed.length > 0 ? `(${installed.length})` : ''}
              </button>
            </div>
            <div className="sidebar__search" style={{ margin: 0, flex: 1, maxWidth: 260 }}>
              <SearchIcon />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search plugins" />
            </div>
            <button className="icon-button" onClick={() => void refresh()} aria-label="Refresh status">
              <RefreshIcon />
            </button>
          </div>

          {shown.length === 0 && (
            <p className="empty-note">{tab === 'yours' ? 'No plugins installed yet.' : 'Nothing matches that search.'}</p>
          )}

          {categories.map(([category, plugins]) => (
            <div key={category} className="plugins__group">
              <div className="section-label">{category}</div>
              <div className="plugins__grid">
                {plugins.map((plugin) => {
                  const status = statusById.get(plugin.id);
                  const isInstalled = installedIds.has(plugin.id);
                  return (
                    <div className="plugin-card" key={plugin.id}>
                      <span className="plugin-card__icon">
                        <PlugIcon size={15} />
                      </span>
                      <span className="plugin-card__body">
                        <span className="plugin-card__title">{plugin.name}</span>
                        <span className="plugin-card__desc">{plugin.description}</span>
                        {isInstalled && status && (
                          <span className="plugin-card__status" data-state={status.state}>
                            {status.state === 'ready'
                              ? `${status.toolCount} tools`
                              : status.state === 'error'
                                ? `error: ${(status.error ?? '').slice(0, 60)}`
                                : status.state}
                          </span>
                        )}
                      </span>
                      {isInstalled ? (
                        <button
                          className="icon-button"
                          aria-label={`Remove ${plugin.name}`}
                          onClick={async () => {
                            setStatuses(await window.halo.removePlugin(plugin.id));
                            await refresh();
                          }}
                        >
                          <TrashIcon />
                        </button>
                      ) : (
                        <button className="btn" disabled={busy === plugin.id} onClick={() => startInstall(plugin)}>
                          {busy === plugin.id ? 'Adding…' : 'Add'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {pending && (
          <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setPending(null)}>
            <div className="modal modal--small" role="dialog" aria-label={`Set up ${pending.name}`}>
              <div className="modal__body">
                <h2>{pending.name}</h2>
                <p className="setting-row__desc" style={{ marginTop: -12 }}>
                  This plugin needs credentials. They are stored on this machine and passed straight to the server.
                </p>
                {pending.requires?.map((req) => (
                  <div className="field" key={req.key}>
                    <label>{req.label}</label>
                    <input
                      className="input"
                      type="password"
                      value={secrets[req.key] ?? ''}
                      onChange={(e) => setSecrets({ ...secrets, [req.key]: e.target.value })}
                    />
                  </div>
                ))}
                <div className="approval__actions">
                  <button
                    className="btn"
                    data-variant="primary"
                    disabled={(pending.requires ?? []).some((r) => !secrets[r.key])}
                    onClick={() => {
                      const spec = pending;
                      setPending(null);
                      void install(spec, secrets);
                    }}
                  >
                    Add plugin
                  </button>
                  <button className="btn" onClick={() => setPending(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
