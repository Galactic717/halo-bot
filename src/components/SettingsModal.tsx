import { useEffect, useState } from 'react';
import type { AutoReviewRule, Settings } from '../../host/types';
import { CloseIcon, PlusIcon, RefreshIcon, TrashIcon } from './Icons';

interface SettingsModalProps {
  settings: Settings;
  onClose: () => void;
  onSave: (patch: Partial<Settings>) => Promise<void>;
}

type Tab = 'general' | 'model' | 'usage' | 'about';

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
          <button data-active={tab === 'usage'} onClick={() => setTab('usage')}>Usage</button>
          <button data-active={tab === 'about'} onClick={() => setTab('about')}>About</button>
        </nav>
        <div className="modal__body">
          <button className="icon-button modal__close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
          {tab === 'general' && <General settings={settings} onSave={onSave} />}
          {tab === 'model' && <Model settings={settings} onSave={onSave} />}
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
      </div>

      <HiddenBots />

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
            <div className="setting-row__text">{rule.when}</div>
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
        Any OpenAI-compatible endpoint works: Ollama, LM Studio, x.ai, OpenRouter, DeepSeek. The model needs tool calling.
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
    totals: { prompt: number; completion: number; turns: number; seconds: number };
    byAgent: { id: string; name: string; prompt: number; completion: number; turns: number; seconds: number }[];
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
        that matters there.
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
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>By bot</div>
      <div className="card">
        {data && data.byAgent.length === 0 && <p className="empty-note">Nothing in this window yet.</p>}
        {data?.byAgent.map((row) => (
          <div className="setting-row" key={row.id}>
            <div className="setting-row__text">
              <div>{row.name}</div>
              <div className="setting-row__desc">
                {row.turns} calls · {Math.round(row.seconds)}s
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
  return (
    <>
      <h2>About</h2>
      <p className="setting-row__desc">
        Halo Bot — AI teammates that run on your own Windows machine. Each bot has its own box, browser, memory and
        routines, and asks before it touches anything outside its box.
      </p>
    </>
  );
}
