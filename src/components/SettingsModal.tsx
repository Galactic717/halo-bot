import { useEffect, useState } from 'react';
import { REPLY_LANGUAGES } from '../../host/personas';
import type { AuditRow, AuditVerdict, AutoReviewRule, Settings } from '../../host/types';
import { CloseIcon, PlusIcon, RefreshIcon, TrashIcon } from './Icons';

interface SettingsModalProps {
  settings: Settings;
  onClose: () => void;
  onSave: (patch: Partial<Settings>) => Promise<void>;
}

type Tab = 'general' | 'model' | 'trail' | 'usage' | 'about';

export function SettingsModal({ settings, onClose, onSave }: SettingsModalProps) {
  const [tab, setTab] = useState<Tab>('general');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Settings">
        <nav className="modal__nav">
          <button data-active={tab === 'general'} onClick={() => setTab('general')}>General</button>
          <button data-active={tab === 'model'} onClick={() => setTab('model')}>Model</button>
          <button data-active={tab === 'trail'} onClick={() => setTab('trail')}>Activity</button>
          <button data-active={tab === 'usage'} onClick={() => setTab('usage')}>Usage</button>
          <button data-active={tab === 'about'} onClick={() => setTab('about')}>About</button>
        </nav>
        <div className="modal__body">
          <button className="icon-button modal__close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
          {tab === 'general' && <General settings={settings} onSave={onSave} />}
          {tab === 'model' && <Model settings={settings} onSave={onSave} />}
          {tab === 'trail' && <Trail />}
          {tab === 'usage' && <Usage />}
          {tab === 'about' && <About />}
        </div>
      </div>
    </div>
  );
}

function General({ settings, onSave }: { settings: Settings; onSave: SettingsModalProps['onSave'] }) {
  const [ruleWhen, setRuleWhen] = useState('');
  const [ruleDecision, setRuleDecision] = useState<AutoReviewRule['decision']>('allow');

  const addRule = () => {
    if (!ruleWhen.trim()) return;
    const rules = [...settings.rules, { id: crypto.randomUUID(), when: ruleWhen.trim(), decision: ruleDecision }];
    void onSave({ rules });
    setRuleWhen('');
  };

  return (
    <>
      <h2>General</h2>

      <div className="section-label">Appearance</div>
      <div className="card">
        <div className="setting-row">
          <div className="setting-row__text">Theme</div>
          <select className="input" style={{ width: 160 }} value={settings.theme} onChange={(e) => void onSave({ theme: e.target.value as Settings['theme'] })}>
            <option value="system">Follow system</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>Agent</div>
      <div className="card">
        <div className="setting-row">
          <div className="setting-row__text">
            <div>Reply language</div>
            <div className="setting-row__desc">
              What your bots answer in. Matching follows each message rather than the conversation, so a bot
              switches with you mid-thread. Code, paths and error strings are never translated.
            </div>
          </div>
          <select
            className="input"
            style={{ width: 200 }}
            value={settings.replyLanguage ?? 'match'}
            onChange={(e) => void onSave({ replyLanguage: e.target.value })}
          >
            {REPLY_LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div>Timezone</div>
            <div className="setting-row__desc">Used for routines and for telling the bot what time it is.</div>
          </div>
          <input className="input" style={{ width: 200 }} value={settings.timezone} onChange={(e) => void onSave({ timezone: e.target.value })} />
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div>Execution on your computer</div>
            <div className="setting-row__desc">Let bots open files and run commands outside their box. Auto-review still checks everything first.</div>
          </div>
          <select
            className="input"
            style={{ width: 160 }}
            value={settings.localExecution}
            onChange={(e) => void onSave({ localExecution: e.target.value as Settings['localExecution'] })}
          >
            <option value="ask">Ask every time</option>
            <option value="allow">Allow</option>
            <option value="never">Never</option>
          </select>
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div>Auto-review</div>
            <div className="setting-row__desc">Halo checks each action before it runs and asks you when it matters.</div>
          </div>
          <button className="switch" data-on={settings.autoReview} aria-label="Auto-review" onClick={() => void onSave({ autoReview: !settings.autoReview })} />
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div>Review depth</div>
            <div className="setting-row__desc">
              Rules only is instant. Smart also asks the model about anything that touches your machine — safer, a little slower.
            </div>
          </div>
          <select
            className="input"
            style={{ width: 160 }}
            value={settings.autoReviewMode}
            disabled={!settings.autoReview}
            onChange={(e) => void onSave({ autoReviewMode: e.target.value as Settings['autoReviewMode'] })}
          >
            <option value="rules">Rules only</option>
            <option value="smart">Smart</option>
          </select>
        </div>

        <div className="setting-row">
          <div className="setting-row__text">
            <div>What a refusal does</div>
            <div className="setting-row__desc">
              Dry run decides and writes it to Activity without stopping the bot, so you can watch a new rule work
              before it starts refusing things. Halo&apos;s own floor — wiping a drive, deleting your backups — still
              refuses in both.
            </div>
          </div>
          <select
            className="input"
            style={{ width: 160 }}
            value={settings.policyMode ?? 'enforce'}
            onChange={(e) => void onSave({ policyMode: e.target.value as Settings['policyMode'] })}
          >
            <option value="enforce">Refuse</option>
            <option value="dry-run">Dry run</option>
          </select>
        </div>
      </div>

      <HiddenBots />

      <div className="section-label" style={{ marginTop: 24 }}>Automation</div>
        <div className="setting-row">
          <div className="setting-row__text">
            <div>Connect n8n</div>
            <div className="setting-row__desc">
              Lets your bots read, write and fire workflows on your own n8n. Every service you have connected there
              becomes something a bot can use, and those credentials stay in n8n rather than coming in here.
              Writing, activating and firing a workflow all ask you first.
            </div>
          </div>
          <button
            className="switch"
            data-on={settings.n8n?.enabled ?? false}
            aria-label="Connect n8n"
            onClick={() =>
              void onSave({
                n8n: {
                  ...(settings.n8n ?? { baseUrl: 'http://localhost:5678', apiKey: '' }),
                  enabled: !(settings.n8n?.enabled ?? false),
                },
              })
            }
          />
        </div>
        {settings.n8n?.enabled && (
          <>
            <div className="setting-row">
              <div className="setting-row__text">
                <div>Address</div>
                <div className="setting-row__desc">Where n8n is, e.g. http://localhost:5678.</div>
              </div>
              <input
                className="input"
                style={{ width: 240 }}
                value={settings.n8n.baseUrl}
                placeholder="http://localhost:5678"
                onChange={(e) => void onSave({ n8n: { ...settings.n8n, baseUrl: e.target.value } })}
              />
            </div>
            <div className="setting-row">
              <div className="setting-row__text">
                <div>API key</div>
                <div className="setting-row__desc">
                  n8n → Settings → n8n API → Create an API key. Sealed with the OS keychain before it reaches disk.
                </div>
              </div>
              <input
                className="input"
                style={{ width: 240 }}
                type="password"
                value={settings.n8n.apiKey}
                onChange={(e) => void onSave({ n8n: { ...settings.n8n, apiKey: e.target.value } })}
              />
            </div>
          </>
        )}

      <div className="section-label" style={{ marginTop: 24 }}>Windows</div>
      <div className="card">
        <div className="setting-row">
          <div className="setting-row__text">
            <div>Start with Windows</div>
            <div className="setting-row__desc">Halo starts hidden in the tray so routines keep firing.</div>
          </div>
          <button
            className="switch"
            data-on={settings.startAtLogin}
            aria-label="Start with Windows"
            onClick={() => void onSave({ startAtLogin: !settings.startAtLogin })}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__text">
            <div>Close to tray</div>
            <div className="setting-row__desc">Closing the window keeps the bots running in the background.</div>
          </div>
          <button
            className="switch"
            data-on={settings.minimizeToTray}
            aria-label="Close to tray"
            onClick={() => void onSave({ minimizeToTray: !settings.minimizeToTray })}
          />
        </div>
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>Auto-review rules</div>
      <div className="card">
        <div className="setting-row__desc" style={{ marginBottom: 12 }}>
          One short rule per action. &quot;Ask first&quot; wins when rules conflict.
        </div>
        {settings.rules.map((rule) => (
          <div className="setting-row" key={rule.id}>
            <div className="setting-row__text">
              <div>{rule.when}</div>
              {/* What the rule actually covers, so a scoped one does not read as a blanket. */}
              {(rule.commandPrefix || rule.surface) && (
                <div className="setting-row__desc">
                  {rule.commandPrefix ? `only commands starting "${rule.commandPrefix}"` : `only ${rule.surface?.replace(/_/g, ' ')}`}
                </div>
              )}
            </div>
            <span className="setting-row__desc">{rule.decision}</span>
            <button
              className="icon-button"
              aria-label="Delete rule"
              onClick={() => void onSave({ rules: settings.rules.filter((r) => r.id !== rule.id) })}
            >
              <TrashIcon />
            </button>
          </div>
        ))}
        <div className="field" style={{ marginTop: 12 }}>
          <label>When a bot wants to…</label>
          <input className="input" value={ruleWhen} placeholder="read files from my Downloads folder" onChange={(e) => setRuleWhen(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="input" style={{ width: 180 }} value={ruleDecision} onChange={(e) => setRuleDecision(e.target.value as AutoReviewRule['decision'])}>
            <option value="allow">Allow automatically</option>
            <option value="ask">Ask first</option>
            <option value="deny">Never allow</option>
          </select>
          <button className="btn" onClick={addRule}><PlusIcon size={13} /> Add rule</button>
        </div>
      </div>
    </>
  );
}

function Model({ settings, onSave }: { settings: Settings; onSave: SettingsModalProps['onSave'] }) {
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [provider, setProvider] = useState(settings.provider);

  const refresh = async () => {
    setError('');
    const result = await window.halo.models();
    if (Array.isArray(result)) setModels(result);
    else setError(result.error);
  };

  useEffect(() => {
    setProvider(settings.provider);
  }, [settings.provider]);

  const commit = (patch: Partial<Settings['provider']>) => {
    const next = { ...provider, ...patch };
    setProvider(next);
    void onSave({ provider: next });
  };

  return (
    <>
      <h2>Model</h2>
      <div className="setting-row__desc" style={{ marginBottom: 16 }}>
        Any OpenAI-compatible endpoint: llama.cpp, Ollama, LM Studio, OpenRouter, x.ai, DeepSeek. Tested end to end on
        llama.cpp (Gemma 4 E4B) and OpenRouter.
      </div>

      <div className="field">
        <label>Base URL</label>
        <input className="input" value={provider.baseUrl} onChange={(e) => setProvider({ ...provider, baseUrl: e.target.value })} onBlur={() => commit({})} />
      </div>
      <div className="field">
        <label>API key</label>
        <input
          className="input"
          type="password"
          value={provider.apiKey}
          placeholder="not needed for local servers"
          onChange={(e) => setProvider({ ...provider, apiKey: e.target.value })}
          onBlur={() => commit({})}
        />
      </div>
      <div className="field">
        <label>Model</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" value={provider.model} onChange={(e) => setProvider({ ...provider, model: e.target.value })} onBlur={() => commit({})} list="halo-models" />
          <datalist id="halo-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button className="btn" onClick={() => void refresh()}><RefreshIcon /> Load list</button>
        </div>
        {models.length > 0 && <div className="setting-row__desc">{models.length} models available</div>}
        {error && <div className="setting-row__desc" style={{ color: 'var(--text-danger)' }}>{error}</div>}
      </div>
      <div className="field">
        <label>Profile</label>
        <select className="input" value={provider.profile} onChange={(e) => commit({ profile: e.target.value as Settings['provider']['profile'] })}>
          <option value="auto">Auto — compact for a model on this machine, full for a hosted one</option>
          <option value="compact">Compact — core tools, FindTool for the rest, short prompt</option>
          <option value="full">Full — every tool and the long prompt</option>
        </select>
        <div className="setting-row__desc">A ~4B model acts reliably only on the compact profile.</div>
      </div>
      <div className="field">
        <label>Tool calls</label>
        <select className="input" value={provider.toolMode} onChange={(e) => commit({ toolMode: e.target.value as Settings['provider']['toolMode'] })}>
          <option value="native">Native — the server's tool calling, with calls written as text picked up too</option>
          <option value="content">Text protocol — tools described in the prompt, calls parsed from the reply</option>
        </select>
        <div className="setting-row__desc">A server that rejects tools is switched to the text protocol on its own.</div>
      </div>
      {provider.baseUrl.includes('openrouter.ai') && (
        <div className="field">
          <label>Fallback models</label>
          <input
            className="input"
            value={(provider.fallbackModels ?? []).join(', ')}
            placeholder="nvidia/nemotron-3-super-120b-a12b:free"
            onChange={(e) => setProvider({ ...provider, fallbackModels: e.target.value.split(',').map((m) => m.trim()).filter(Boolean) })}
            onBlur={() => commit({})}
          />
          <div className="setting-row__desc">Tried in order when the main model is rate limited or failing — free models often are. Usage shows which one answered.</div>
        </div>
      )}
      <div className="field">
        <label>Helper model</label>
        <input
          className="input"
          value={provider.helperModel}
          placeholder="same as above"
          onChange={(e) => setProvider({ ...provider, helperModel: e.target.value })}
          onBlur={() => commit({})}
          list="halo-models"
        />
        <div className="setting-row__desc">Used for memory extraction and safety review. A smaller, faster model is ideal.</div>
      </div>

      <div className="setting-row">
        <div className="setting-row__text">
          <div>Send images to the model</div>
          <div className="setting-row__desc">Screenshots and attached pictures go into the prompt. Needs a vision model.</div>
        </div>
        <button
          className="switch"
          data-on={provider.vision}
          aria-label="Vision"
          onClick={() => commit({ vision: !provider.vision })}
        />
      </div>

      <div className="field">
        <label>Image endpoint (optional)</label>
        <input
          className="input"
          value={provider.imageBaseUrl}
          placeholder="https://api.openai.com/v1"
          onChange={(e) => setProvider({ ...provider, imageBaseUrl: e.target.value })}
          onBlur={() => commit({})}
        />
        <div className="setting-row__desc">Enables GenerateImage. Any OpenAI-compatible /images/generations endpoint.</div>
      </div>

      <div className="field">
        <label>Image model</label>
        <input
          className="input"
          value={provider.imageModel}
          placeholder="gpt-image-1"
          onChange={(e) => setProvider({ ...provider, imageModel: e.target.value })}
          onBlur={() => commit({})}
        />
      </div>

      <div className="field">
        <label>Context budget (tokens)</label>
        <input
          className="input"
          type="number"
          min={2000}
          step={1000}
          value={provider.contextBudget}
          onChange={(e) => commit({ contextBudget: Math.max(2000, Number(e.target.value)) })}
        />
        <div className="setting-row__desc">
          When a conversation passes this, older turns are folded into a summary. Keep it under what your model can hold.
        </div>
      </div>

      <div className="field">
        <label>Max tool steps per turn</label>
        <input
          className="input"
          type="number"
          min={1}
          max={100}
          value={provider.maxSteps}
          onChange={(e) => commit({ maxSteps: Number(e.target.value) })}
        />
      </div>
    </>
  );
}

/**
 * What the bots were allowed to do, what they were refused, and what then failed.
 *
 * The refusals are the interesting rows and they used to be invisible: a denied tool call became one
 * muted line in a transcript nobody scrolls back through, and a rule that was quietly refusing work
 * every day looked like a bot being unhelpful.
 */
function Trail() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [totals, setTotals] = useState({ allowed: 0, refused: 0, failed: 0 });
  const [chain, setChain] = useState<AuditVerdict | null>(null);
  const [outcome, setOutcome] = useState<'' | AuditRow['outcome']>('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = () => {
    void window.halo
      .audit({ limit: 300, ...(outcome ? { outcome } : {}), ...(query.trim() ? { query: query.trim() } : {}) })
      .then(setRows);
    void window.halo.auditSummary(7).then(setTotals);
    void window.halo.auditVerify().then(setChain);
  };

  useEffect(load, [outcome, query]);

  return (
    <>
      <h2>Activity</h2>
      <div className="setting-row__desc" style={{ marginBottom: 12 }}>
        Every action that went through the approval gate, decided before it ran. Last seven days:{' '}
        <b>{totals.allowed}</b> allowed, <b>{totals.refused}</b> refused, <b>{totals.failed}</b> failed.
      </div>
      {chain && (
        <div className="setting-row__desc" style={{ marginBottom: 12 }} role={chain.intact ? undefined : 'alert'}>
          {chain.intact
            ? `Chain intact: every one of ${chain.rows} rows follows the one before it, unchanged.`
            : `Chain broken at row ${chain.brokenAt} of ${chain.rows}: ${chain.reason}. Rows after it cannot be trusted.`}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input className="input" style={{ flex: 1 }} placeholder="Search the trail" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="input" style={{ width: 150 }} value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
          <option value="">Everything</option>
          <option value="refused">Refused</option>
          <option value="failed">Failed</option>
          <option value="allowed">Allowed</option>
        </select>
        <button className="icon-button" onClick={load} aria-label="Refresh"><RefreshIcon /></button>
      </div>

      <div className="card">
        {rows.length === 0 && <div className="setting-row__desc">Nothing on the trail yet.</div>}
        {rows.map((row, i) => {
          const id = `${row.at}-${i}`;
          return (
            <div className="trail-row" key={id} data-outcome={row.outcome}>
              <button className="trail-row__head" onClick={() => setOpen(open === id ? null : id)}>
                <span className="trail-row__dot" data-outcome={row.outcome} />
                <span className="trail-row__who">{row.agentName}</span>
                <span className="trail-row__what">{row.summary}</span>
                <span className="trail-row__when">{new Date(row.at).toLocaleString()}</span>
              </button>
              {open === id && (
                <div className="trail-row__body">
                  <div>
                    {row.tool} · {row.surface}
                    {row.intent ? ` · ${row.intent}` : ''} · {row.outcome}
                    {row.dryRun ? ' (dry run — recorded, not blocked)' : ''}
                  </div>
                  {row.matched && (
                    <div>
                      {row.outcome === 'refused' ? 'Refused by' : 'Decided by'} {row.source}: <b>{row.matched}</b>
                    </div>
                  )}
                  {row.failure && <div className="trail-row__failure">Failed: {row.failure}</div>}
                  {row.detail && <pre>{row.detail}</pre>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function HiddenBots() {
  const [hidden, setHidden] = useState<{ id: string; name: string }[]>([]);

  const load = () => {
    void window.halo.snapshot().then((snap) => setHidden(snap.agents.filter((a) => a.hidden).map((a) => ({ id: a.id, name: a.name }))));
  };

  useEffect(load, []);

  if (hidden.length === 0) return null;

  return (
    <>
      <div className="section-label" style={{ marginTop: 24 }}>Hidden bots</div>
      <div className="card">
        {hidden.map((bot) => (
          <div className="setting-row" key={bot.id}>
            <div className="setting-row__text">{bot.name}</div>
            <button
              className="btn"
              onClick={async () => {
                await window.halo.updateAgent(bot.id, { hidden: false });
                load();
              }}
            >
              Show again
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function Usage() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<{
    totals: { prompt: number; completion: number; turns: number; seconds: number; cost: number };
    byAgent: { id: string; name: string; prompt: number; completion: number; turns: number; seconds: number; cost: number }[];
  } | null>(null);

  useEffect(() => {
    void window.halo.usage(days).then(setData);
  }, [days]);

  const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  return (
    <>
      <h2>Usage</h2>
      <div className="setting-row__desc" style={{ marginTop: -12, marginBottom: 16 }}>
        Counted from what your model server reports. Local models cost nothing but time — the seconds column is the one
        that matters there. Cost is shown only where the server reports it (OpenRouter does).
      </div>

      <div className="tabs" style={{ width: 'fit-content', marginBottom: 16 }}>
        {[1, 7, 30].map((d) => (
          <button key={d} data-active={days === d} onClick={() => setDays(d)}>
            {d === 1 ? 'Today' : `${d} days`}
          </button>
        ))}
      </div>

      <div className="usage-grid">
        <div className="usage-card">
          <span className="usage-card__value">{data ? fmt(data.totals.completion) : '—'}</span>
          <span className="usage-card__label">tokens generated</span>
        </div>
        <div className="usage-card">
          <span className="usage-card__value">{data ? fmt(data.totals.prompt) : '—'}</span>
          <span className="usage-card__label">tokens read</span>
        </div>
        <div className="usage-card">
          <span className="usage-card__value">{data ? data.totals.turns : '—'}</span>
          <span className="usage-card__label">model calls</span>
        </div>
        <div className="usage-card">
          <span className="usage-card__value">{data ? `${Math.round(data.totals.seconds / 60)}m` : '—'}</span>
          <span className="usage-card__label">thinking time</span>
        </div>
        {data && data.totals.cost > 0 && (
          <div className="usage-card">
            <span className="usage-card__value">${data.totals.cost.toFixed(data.totals.cost < 1 ? 4 : 2)}</span>
            <span className="usage-card__label">reported cost</span>
          </div>
        )}
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>By bot</div>
      <div className="card">
        {data && data.byAgent.length === 0 && <p className="empty-note">Nothing in this window yet.</p>}
        {data?.byAgent.map((row) => (
          <div className="setting-row" key={row.id}>
            <div className="setting-row__text">
              <div>{row.name}</div>
              <div className="setting-row__desc">
                {row.turns} calls · {Math.round(row.seconds)}s{row.cost > 0 ? ` · $${row.cost.toFixed(4)}` : ''}
              </div>
            </div>
            <span className="setting-row__desc">
              {fmt(row.prompt)} in / {fmt(row.completion)} out
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function About() {
  const [confinement, setConfinement] = useState<{ confined: boolean; detail: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void window.halo.snapshot().then((snap) => setConfinement(snap.confinement));
  }, []);
  return (
    <>
      <h2>About</h2>
      <p className="setting-row__desc">
        Halo Bot — AI teammates that run on your own Windows machine. Each bot has its own box, browser, memory and
        routines, and asks before it touches anything outside its box.
      </p>
      <h3>The box</h3>
      <p className="setting-row__desc">
        {confinement === null
          ? 'Checking whether the box is enforced…'
          : confinement.confined
            ? `Enforced: ${confinement.detail}.`
            : `Not enforced, so bot shells are switched off: ${confinement.detail}.`}
      </p>
      <h3>When something goes wrong</h3>
      <p className="setting-row__desc">
        Halo keeps a log of what it did and what failed. Diagnostics are safe to paste into an issue: no key, no conversation,
        and anything shaped like a secret is masked.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" onClick={() => void window.halo.openLogs()}>
          Open logs folder
        </button>
        <button
          className="btn"
          onClick={() =>
            void window.halo.diagnostics().then((text) => {
              void navigator.clipboard.writeText(text);
              setCopied(true);
            })
          }
        >
          {copied ? 'Copied' : 'Copy diagnostics'}
        </button>
      </div>
    </>
  );
}
