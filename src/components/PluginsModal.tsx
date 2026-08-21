import { useCallback, useEffect, useMemo, useState } from 'react';
import type { McpField, McpServerSpec, McpServerStatus } from '../../host/mcp';
import { PLUGIN_FILTERS, filterInstalled, shelves, type PluginFilter } from '../../host/plugins';
import { PluginIcon } from './PluginIcon';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, ExternalLinkIcon, SearchIcon } from './Icons';

interface PluginsModalProps {
  onClose: () => void;
}

type View = { kind: 'marketplace' } | { kind: 'installed' } | { kind: 'detail'; id: string };

export function PluginsModal({ onClose }: PluginsModalProps) {
  const [catalog, setCatalog] = useState<McpServerSpec[]>([]);
  const [installed, setInstalled] = useState<McpServerSpec[]>([]);
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [view, setView] = useState<View>({ kind: 'marketplace' });
  const [filter, setFilter] = useState<PluginFilter>('All');
  const [query, setQuery] = useState('');
  const [setup, setSetup] = useState<{ spec: McpServerSpec; fields: McpField[] } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    setInstalled(await window.halo.pluginsInstalled());
    setStatuses(await window.halo.pluginStatus());
  }, []);

  useEffect(() => {
    void window.halo.pluginCatalog().then(setCatalog);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (customOpen) setCustomOpen(false);
      else if (setup) setSetup(null);
      else if (view.kind !== 'marketplace') setView({ kind: 'marketplace' });
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, setup, customOpen, view.kind]);

  const installedById = useMemo(() => new Map(installed.map((p) => [p.id, p])), [installed]);
  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);

  /** The catalogue, with an installed plugin's own answers merged over the shelf copy. */
  const merged = useMemo(
    () => catalog.map((spec) => ({ ...spec, ...(installedById.get(spec.id) ?? {}) })),
    [catalog, installedById],
  );

  /** Plugins the user added by hand are not on any shelf, so they only appear under "Your plugins". */
  const custom = useMemo(() => installed.filter((p) => !catalog.some((c) => c.id === p.id)), [installed, catalog]);

  const install = async (spec: McpServerSpec, env: Record<string, string>, config: Record<string, string>) => {
    setBusy(spec.id);
    try {
      setStatuses(await window.halo.installPlugin({ ...spec, env, config, enabled: true }));
      await refresh();
    } finally {
      setBusy('');
    }
  };

  const startInstall = (spec: McpServerSpec) => {
    const fields = [...(spec.requires ?? []), ...(spec.setup ?? [])];
    if (fields.length > 0) {
      setSetup({ spec, fields });
      return;
    }
    void install(spec, {}, {});
  };

  const uninstall = async (id: string) => {
    setBusy(id);
    try {
      setStatuses(await window.halo.removePlugin(id));
      await refresh();
    } finally {
      setBusy('');
    }
  };

  const detail = view.kind === 'detail' ? merged.find((p) => p.id === view.id) ?? custom.find((p) => p.id === view.id) : null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal--plugins" role="dialog" aria-label="Plugins">
        {detail ? (
          <PluginDetail
            spec={detail}
            status={statusById.get(detail.id)}
            installed={installedById.has(detail.id)}
            busy={busy === detail.id}
            onBack={() => setView({ kind: 'marketplace' })}
            onClose={onClose}
            onAdd={() => startInstall(detail)}
            onRemove={() => void uninstall(detail.id)}
          />
        ) : (
          <div className="plugins">
            <header className="plugins__head">
              <h2>Plugins</h2>
              <button className="icon-button" onClick={onClose} aria-label="Close">
                <CloseIcon />
              </button>
            </header>

            {view.kind === 'installed' ? (
              <button className="plugins__crumb" onClick={() => setView({ kind: 'marketplace' })}>
                <ChevronLeftIcon size={13} /> Back to Marketplace
              </button>
            ) : (
              <button className="plugins__crumb" onClick={() => setView({ kind: 'installed' })}>
                {installed.length} installed <ChevronRightIcon size={13} />
              </button>
            )}

            <div className="plugins__search">
              <SearchIcon size={14} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search plugins"
                aria-label="Search plugins"
              />
            </div>

            {view.kind === 'marketplace' && (
              <div className="plugins__chips" role="tablist" aria-label="Plugin categories">
                {PLUGIN_FILTERS.map((name) => (
                  <button
                    key={name}
                    role="tab"
                    aria-selected={filter === name}
                    data-active={filter === name}
                    onClick={() => setFilter(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}

            <div className="plugins__scroll">
              {view.kind === 'marketplace' ? (
                <Marketplace
                  catalog={merged}
                  filter={filter}
                  query={query}
                  installedIds={installedById}
                  statusById={statusById}
                  busy={busy}
                  onViewAll={setFilter}
                  onOpen={(id) => setView({ kind: 'detail', id })}
                  onAdd={startInstall}
                  onRemove={(id) => void uninstall(id)}
                />
              ) : (
                <Installed
                  installed={filterInstalled(installed, query)}
                  custom={custom}
                  query={query}
                  statusById={statusById}
                  busy={busy}
                  onOpen={(id) => setView({ kind: 'detail', id })}
                  onRemove={(id) => void uninstall(id)}
                  onToggle={async (id, enabled) => {
                    setStatuses(await window.halo.togglePlugin(id, enabled));
                    await refresh();
                  }}
                  onAddCustom={() => setCustomOpen(true)}
                />
              )}
            </div>
          </div>
        )}

        {customOpen && (
          <CustomServerForm
            onCancel={() => setCustomOpen(false)}
            onSave={async (input) => {
              setCustomOpen(false);
              setBusy('custom');
              try {
                await window.halo.addCustomPlugin(input);
                await refresh();
              } finally {
                setBusy('');
              }
            }}
          />
        )}

        {setup && (
          <PluginSetup
            spec={setup.spec}
            fields={setup.fields}
            onCancel={() => setSetup(null)}
            onSave={(env, config) => {
              const spec = setup.spec;
              setSetup(null);
              void install(spec, env, config);
            }}
          />
        )}
      </div>
    </div>
  );
}

function Marketplace({
  catalog,
  filter,
  query,
  installedIds,
  statusById,
  busy,
  onViewAll,
  onOpen,
  onAdd,
  onRemove,
}: {
  catalog: McpServerSpec[];
  filter: PluginFilter;
  query: string;
  installedIds: Map<string, McpServerSpec>;
  statusById: Map<string, McpServerStatus>;
  busy: string;
  onViewAll: (filter: PluginFilter) => void;
  onOpen: (id: string) => void;
  onAdd: (spec: McpServerSpec) => void;
  onRemove: (id: string) => void;
}) {
  const groups = shelves(catalog, filter, query);
  const empty = groups.every((group) => group.plugins.length === 0);

  if (empty) {
    return (
      <p className="empty-note">
        {query.trim() ? `No plugins match "${query.trim()}"` : 'Nothing on this shelf yet.'}
      </p>
    );
  }

  // A search flattens everything into one ranked list; a chosen category is a full-width column.
  const columns = query.trim() || filter === 'All' ? 2 : 1;

  return (
    <>
      {groups.map((group) => (
        <section className="shelf" key={group.title}>
          <div className="shelf__head">
            <span className="section-label">{group.title}</span>
            {group.hidden > 0 && group.filter && (
              <button className="shelf__all" onClick={() => onViewAll(group.filter!)}>
                View all
              </button>
            )}
          </div>
          <div className="shelf__grid" data-columns={columns}>
            {group.plugins.map((spec) => (
              <PluginRow
                key={spec.id}
                spec={spec}
                status={statusById.get(spec.id)}
                installed={installedIds.has(spec.id)}
                busy={busy === spec.id}
                onOpen={() => onOpen(spec.id)}
                onAdd={() => onAdd(spec)}
                onRemove={() => onRemove(spec.id)}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function Installed({
  installed,
  custom,
  query,
  statusById,
  busy,
  onOpen,
  onRemove,
  onToggle,
  onAddCustom,
}: {
  installed: McpServerSpec[];
  custom: McpServerSpec[];
  query: string;
  statusById: Map<string, McpServerStatus>;
  busy: string;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onAddCustom: () => void;
}) {
  const customIds = new Set(custom.map((p) => p.id));
  const fromCatalog = installed.filter((p) => !customIds.has(p.id));
  const yours = installed.filter((p) => customIds.has(p.id));
  const trimmed = query.trim();

  return (
    <>
      <section className="shelf">
        <div className="section-label">Installed</div>
        {fromCatalog.length === 0 ? (
          <p className="empty-note">
            {trimmed ? `No installed plugins match "${trimmed}"` : 'Nothing installed yet. Find plugins in the marketplace.'}
          </p>
        ) : (
          <div className="shelf__grid" data-columns={1}>
            {fromCatalog.map((spec) => (
              <PluginRow
                key={spec.id}
                spec={spec}
                status={statusById.get(spec.id)}
                installed
                busy={busy === spec.id}
                onOpen={() => onOpen(spec.id)}
                onAdd={() => {}}
                onRemove={() => onRemove(spec.id)}
                onToggle={(enabled) => void onToggle(spec.id, enabled)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="shelf">
        <div className="shelf__head">
          <span className="section-label">Your own servers</span>
          <button className="shelf__all" onClick={onAddCustom}>
            Add a server
          </button>
        </div>
        {yours.length === 0 ? (
          <p className="empty-note">
            No servers of your own yet. Add any MCP server by its command, and its tools reach every bot.
          </p>
        ) : (
          <div className="shelf__grid" data-columns={1}>
            {yours.map((spec) => (
              <PluginRow
                key={spec.id}
                spec={spec}
                status={statusById.get(spec.id)}
                installed
                busy={busy === spec.id}
                onOpen={() => onOpen(spec.id)}
                onAdd={() => {}}
                onRemove={() => onRemove(spec.id)}
                onToggle={(enabled) => void onToggle(spec.id, enabled)}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function statusLabel(status: McpServerStatus | undefined, enabled: boolean | undefined): string {
  if (enabled === false) return 'paused';
  if (!status) return '';
  if (status.state === 'ready') return `${status.toolCount} tool${status.toolCount === 1 ? '' : 's'}`;
  if (status.state === 'error') return 'failed to start';
  if (status.state === 'starting') return 'starting…';
  return 'stopped';
}

function PluginRow({
  spec,
  status,
  installed,
  busy,
  onOpen,
  onAdd,
  onRemove,
  onToggle,
}: {
  spec: McpServerSpec;
  status: McpServerStatus | undefined;
  installed: boolean;
  busy: boolean;
  onOpen: () => void;
  onAdd: () => void;
  onRemove: () => void;
  onToggle?: (enabled: boolean) => void;
}) {
  const label = installed ? statusLabel(status, spec.enabled) : '';

  return (
    <div className="plugin-row" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <PluginIcon name={spec.name} icon={spec.icon} />
      <span className="plugin-row__body">
        <span className="plugin-row__name">{spec.name}</span>
        {spec.description && <span className="plugin-row__desc">{spec.description}</span>}
      </span>
      {label && (
        <span className="plugin-row__status" data-state={spec.enabled === false ? 'paused' : status?.state ?? 'stopped'}>
          {label}
        </span>
      )}
      {installed && onToggle && (
        <button
          className="switch"
          data-on={spec.enabled !== false}
          aria-label={spec.enabled === false ? `Resume ${spec.name}` : `Pause ${spec.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(spec.enabled === false);
          }}
        />
      )}
      <button
        className="btn plugin-row__action"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          installed ? onRemove() : onAdd();
        }}
      >
        {busy ? '…' : installed ? 'Uninstall' : 'Add'}
      </button>
    </div>
  );
}

function PluginDetail({
  spec,
  status,
  installed,
  busy,
  onBack,
  onClose,
  onAdd,
  onRemove,
}: {
  spec: McpServerSpec;
  status: McpServerStatus | undefined;
  installed: boolean;
  busy: boolean;
  onBack: () => void;
  onClose: () => void;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const [tools, setTools] = useState<{ name: string; description: string }[]>([]);
  const [toolsOpen, setToolsOpen] = useState(false);

  useEffect(() => {
    if (!installed) {
      setTools([]);
      return;
    }
    void window.halo.pluginTools(spec.id).then(setTools);
  }, [spec.id, installed, status?.state]);

  const command = [spec.command, ...spec.args].join(' ');

  return (
    <div className="plugins">
      <header className="plugins__head plugins__head--detail">
        <button className="icon-button" onClick={onBack} aria-label="Back">
          <ChevronLeftIcon />
        </button>
        <span className="plugins__title">{spec.name}</span>
        <button className="icon-button" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </header>

      <div className="plugins__scroll">
        <div className="plugin-detail__top">
          <PluginIcon name={spec.name} icon={spec.icon} size={44} />
          <div className="plugin-detail__ident">
            <div className="plugin-detail__name">{spec.name}</div>
            {spec.source && (
              <button className="plugin-detail__source" onClick={() => void window.halo.openPath(spec.source!)}>
                View Source <ExternalLinkIcon size={11} />
              </button>
            )}
          </div>
          <button className="btn" data-variant={installed ? undefined : 'primary'} disabled={busy} onClick={installed ? onRemove : onAdd}>
            {busy ? '…' : installed ? 'Uninstall' : 'Add'}
          </button>
        </div>

        {spec.description && <p className="plugin-detail__desc">{spec.description}</p>}

        {status?.state === 'error' && status.error && (
          <div className="plugin-detail__error">
            <strong>This server did not start.</strong>
            <span>{status.error}</span>
          </div>
        )}

        <div className="section-label">{spec.remote ? 'Connector' : 'Server'}</div>
        <div className="card plugin-detail__server">
          <div className="setting-row">
            <div className="setting-row__text">
              <div>{spec.remote ? 'Hosted, bridged over the network' : 'Runs on this machine'}</div>
              <div className="setting-row__desc plugin-detail__command">{command}</div>
            </div>
            <span className="setting-row__desc">{spec.remote ? 'Remote' : 'Local'}</span>
          </div>
          {(spec.requires ?? []).map((field) => (
            <div className="setting-row" key={field.key}>
              <div className="setting-row__text">
                <div>{field.label}</div>
                {field.hint && <div className="setting-row__desc">{field.hint}</div>}
              </div>
              <span className="setting-row__desc">{spec.env?.[field.key] ? 'set' : 'needed'}</span>
            </div>
          ))}
          {(spec.setup ?? []).map((field) => (
            <div className="setting-row" key={field.key}>
              <div className="setting-row__text">
                <div>{field.label}</div>
                <div className="setting-row__desc">{spec.config?.[field.key] || field.placeholder || 'not set'}</div>
              </div>
            </div>
          ))}
        </div>

        {installed && (
          <>
            <div className="section-label">Tools</div>
            <div className="card">
              <button className="plugin-detail__toggle" onClick={() => setToolsOpen((v) => !v)}>
                <span>
                  {tools.length > 0
                    ? `${tools.length} tool${tools.length === 1 ? '' : 's'}`
                    : status?.state === 'ready'
                      ? 'No tools exposed'
                      : 'Not running'}
                </span>
                <span className="chevron" data-collapsed={!toolsOpen}>
                  ›
                </span>
              </button>
              {toolsOpen &&
                tools.map((tool) => (
                  <div className="setting-row" key={tool.name}>
                    <div className="setting-row__text">
                      <div className="plugin-detail__tool">mcp__{spec.id.replace(/[^a-zA-Z0-9_]/g, '_')}__{tool.name}</div>
                      {tool.description && <div className="setting-row__desc">{tool.description.slice(0, 160)}</div>}
                    </div>
                  </div>
                ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The credentials and paths a server needs before it can start. */
function PluginSetup({
  spec,
  fields,
  onCancel,
  onSave,
}: {
  spec: McpServerSpec;
  fields: McpField[];
  onCancel: () => void;
  onSave: (env: Record<string, string>, config: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const start: Record<string, string> = {};
    for (const field of fields) start[field.key] = spec.env?.[field.key] ?? spec.config?.[field.key] ?? '';
    return start;
  });

  const secretKeys = new Set((spec.requires ?? []).map((f) => f.key));
  const complete = fields.every((field) => values[field.key]?.trim());

  const save = () => {
    const env: Record<string, string> = {};
    const config: Record<string, string> = {};
    for (const field of fields) {
      const value = values[field.key]?.trim() ?? '';
      if (secretKeys.has(field.key)) env[field.key] = value;
      else config[field.key] = value;
    }
    onSave(env, config);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal--small" role="dialog" aria-label={`Set up ${spec.name}`}>
        <div className="modal__body">
          <h2>Plugin Setup</h2>
          <p className="setting-row__desc" style={{ marginTop: -12 }}>
            {spec.name} needs a few values before it can start. Credentials are encrypted with the OS keychain and
            passed straight to the server.
          </p>
          {fields.map((field) => (
            <div className="field" key={field.key}>
              <label htmlFor={`setup-${field.key}`}>{field.label}</label>
              <input
                id={`setup-${field.key}`}
                className="input"
                type={secretKeys.has(field.key) ? 'password' : 'text'}
                value={values[field.key] ?? ''}
                placeholder={field.placeholder ?? ''}
                autoFocus={field === fields[0]}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && complete) save();
                }}
              />
              {field.hint && <div className="setting-row__desc">{field.hint}</div>}
            </div>
          ))}
          <div className="approval__actions">
            <button className="btn" data-variant="primary" disabled={!complete} onClick={save}>
              Add plugin
            </button>
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Any MCP server the user runs themselves, described by its command line. */
function CustomServerForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (input: { name: string; command: string; args: string; description: string }) => void;
}) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('npx');
  const [args, setArgs] = useState('');
  const [description, setDescription] = useState('');
  const ready = name.trim().length > 0 && command.trim().length > 0;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal--small" role="dialog" aria-label="Add a server">
        <div className="modal__body">
          <h2>Add a server</h2>
          <p className="setting-row__desc" style={{ marginTop: -12 }}>
            Any MCP server that speaks stdio. Its tools reach every bot as <code>mcp__…</code>, the same as a
            marketplace plugin.
          </p>
          <div className="field">
            <label htmlFor="custom-name">Name</label>
            <input id="custom-name" className="input" autoFocus value={name} placeholder="My Server" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="custom-command">Command</label>
            <input id="custom-command" className="input" value={command} placeholder="npx" onChange={(e) => setCommand(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="custom-args">Arguments</label>
            <input
              id="custom-args"
              className="input"
              value={args}
              placeholder="-y my-mcp-server --flag"
              onChange={(e) => setArgs(e.target.value)}
            />
            <div className="setting-row__desc">Split on spaces; wrap a path with spaces in "quotes".</div>
          </div>
          <div className="field">
            <label htmlFor="custom-desc">Description</label>
            <input
              id="custom-desc"
              className="input"
              value={description}
              placeholder="What it is for"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="approval__actions">
            <button
              className="btn"
              data-variant="primary"
              disabled={!ready}
              onClick={() => onSave({ name: name.trim(), command: command.trim(), args: args.trim(), description: description.trim() })}
            >
              Add server
            </button>
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
