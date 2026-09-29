import { useEffect, useState } from 'react';
import type { Settings } from '../../host/types';
import { CheckIcon, RefreshIcon } from './Icons';

interface SetupProps {
  settings: Settings;
  onSave: (patch: Partial<Settings>) => Promise<void>;
  onDone: () => void;
}

interface Candidate {
  label: string;
  baseUrl: string;
  models: string[];
  /** What the server said about itself, when it says anything (llama.cpp does). */
  info?: { contextWindow?: number; nativeTools?: boolean };
}

// llama.cpp first: it is the one tested end to end on this build (Gemma 4 E4B, scripts/job.mts).
const KNOWN = [
  { label: 'llama.cpp', baseUrl: 'http://localhost:8080/v1', apiKey: '' },
  { label: 'Ollama', baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama' },
  { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiKey: 'lm-studio' },
];

/** Below this a local server cannot hold even the compact prompt plus a few tool results. */
const MIN_WINDOW = 8192;

const CLOUD = [
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', hint: 'google/gemma-4-26b-a4b-it:free' },
  { label: 'x.ai', baseUrl: 'https://api.x.ai/v1', hint: 'grok-4' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', hint: 'gpt-4.1' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', hint: 'deepseek-chat' },
];

/** First run: find a model server before the user meets their first bot. */
export function Setup({ settings, onSave, onDone }: SetupProps) {
  const [scanning, setScanning] = useState(true);
  const [found, setFound] = useState<Candidate[]>([]);
  const [choice, setChoice] = useState<{ baseUrl: string; apiKey: string; model: string } | null>(null);
  const [manual, setManual] = useState({ baseUrl: '', apiKey: '', model: '' });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>('');

  const scan = async () => {
    setScanning(true);
    const hits: Candidate[] = [];
    for (const server of KNOWN) {
      const models = await window.halo.probeProvider(server.baseUrl, server.apiKey);
      if (Array.isArray(models) && models.length > 0) {
        const info = await window.halo.serverInfo(server.baseUrl).catch(() => undefined);
        hits.push({ label: server.label, baseUrl: server.baseUrl, models, ...(info ? { info } : {}) });
      }
    }
    setFound(hits);
    setScanning(false);
    const first = hits[0];
    if (first) {
      const preferred =
        first.models.find((m) => /qwen|llama|mistral|gemma|grok|gpt|claude/i.test(m) && !/embed|bge|nomic/i.test(m)) ?? first.models[0]!;
      setChoice({ baseUrl: first.baseUrl, apiKey: KNOWN.find((k) => k.baseUrl === first.baseUrl)?.apiKey ?? '', model: preferred });
    }
  };

  useEffect(() => {
    void scan();
  }, []);

  const finish = async (provider: { baseUrl: string; apiKey: string; model: string }) => {
    setTesting(true);
    setTestResult('');
    const models = await window.halo.probeProvider(provider.baseUrl, provider.apiKey);
    if (!Array.isArray(models)) {
      setTesting(false);
      setTestResult(models.error);
      return;
    }
    await onSave({
      provider: { ...settings.provider, baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model },
      onboarded: true,
    });
    setTesting(false);
    onDone();
  };

  return (
    <div className="setup">
      <div className="setup__card">
        <h1>Set up Halo Bot</h1>
        <p className="setup__lead">
          Halo runs your bots on a model on this machine (llama.cpp, Ollama, LM Studio) or on a hosted OpenAI-compatible
          API — OpenRouter is the tested one. Small local models get a compact toolset and a short prompt so they can
          still act. You can change this later in Settings.
        </p>

        <div className="section-header">
          <span className="section-label">On this machine</span>
          <button className="icon-button" onClick={() => void scan()} aria-label="Rescan">
            <RefreshIcon />
          </button>
        </div>

        {scanning && <p className="empty-note">Looking for a local model server…</p>}
        {!scanning && found.length === 0 && (
          <p className="empty-note">
            Nothing local found. Start llama-server with --jinja (or Ollama, or LM Studio) and rescan, or use a hosted
            model below.
          </p>
        )}

        {found.map((candidate) => (
          <div className="card setup__server" key={candidate.baseUrl}>
            <div className="setting-row" style={{ borderBottom: 'none' }}>
              <div className="setting-row__text">
                <div>
                  {candidate.label} <span className="setting-row__desc">· {candidate.models.length} models</span>
                </div>
                <div className="setting-row__desc">
                  {candidate.baseUrl}
                  {candidate.info?.contextWindow ? ` · ${candidate.info.contextWindow}-token window` : ''}
                  {candidate.info?.nativeTools === false ? ' · no tool template, calls go through the text protocol' : ''}
                </div>
                {candidate.info?.contextWindow !== undefined && candidate.info.contextWindow < MIN_WINDOW && (
                  <div className="setting-row__desc" style={{ color: 'var(--text-danger)' }}>
                    A {candidate.info.contextWindow}-token window is too small for a bot. Restart the server with -c 16384.
                  </div>
                )}
              </div>
              <select
                className="input"
                style={{ width: 220 }}
                value={choice?.baseUrl === candidate.baseUrl ? choice.model : ''}
                onChange={(e) =>
                  setChoice({
                    baseUrl: candidate.baseUrl,
                    apiKey: KNOWN.find((k) => k.baseUrl === candidate.baseUrl)?.apiKey ?? '',
                    model: e.target.value,
                  })
                }
              >
                <option value="">Pick a model…</option>
                {candidate.models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}

        <div className="section-label" style={{ marginTop: 20 }}>Hosted</div>
        <div className="setup__cloud">
          {CLOUD.map((server) => (
            <button
              key={server.baseUrl}
              className="btn"
              data-variant={manual.baseUrl === server.baseUrl ? 'primary' : undefined}
              onClick={() => setManual({ baseUrl: server.baseUrl, apiKey: manual.apiKey, model: server.hint })}
            >
              {server.label}
            </button>
          ))}
        </div>

        {manual.baseUrl && (
          <div className="card" style={{ marginTop: 12 }}>
            <div className="field">
              <label>Base URL</label>
              <input className="input" value={manual.baseUrl} onChange={(e) => setManual({ ...manual, baseUrl: e.target.value })} />
            </div>
            <div className="field">
              <label>API key</label>
              <input
                className="input"
                type="password"
                value={manual.apiKey}
                placeholder="paste your key"
                onChange={(e) => setManual({ ...manual, apiKey: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Model</label>
              <input className="input" value={manual.model} onChange={(e) => setManual({ ...manual, model: e.target.value })} />
            </div>
          </div>
        )}

        {testResult && <p className="setup__error">{testResult}</p>}

        <div className="setup__actions">
          <button
            className="btn"
            data-variant="primary"
            disabled={testing || (!manual.model && !choice?.model)}
            onClick={() => void finish(manual.model ? manual : choice!)}
          >
            {testing ? 'Checking…' : (
              <>
                <CheckIcon size={13} /> Use this model
              </>
            )}
          </button>
          <button className="btn" onClick={() => void onSave({ onboarded: true }).then(onDone)}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
