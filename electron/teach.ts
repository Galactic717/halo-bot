import type { WebContents } from 'electron';

export interface TeachEvent {
  kind: 'click' | 'input' | 'key' | 'navigate';
  at: number;
  url: string;
  selector?: string;
  text?: string;
  value?: string;
  key?: string;
}

/**
 * Recorder injected into the bot's browser while the user demonstrates a task.
 * It only collects what a step needs — never the contents of a password field.
 */
const RECORDER = `(() => {
  if (window.__haloRec) return 'already';
  window.__haloRec = [];
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const selectorFor = (el) => {
    if (!el || !el.tagName) return '';
    const tag = el.tagName.toLowerCase();
    if (el.id) return '#' + CSS.escape(el.id);
    const label = el.getAttribute && el.getAttribute('aria-label');
    if (label) return tag + '[aria-label="' + label.replace(/"/g, '') + '"]';
    if (el.name) return tag + '[name="' + el.name + '"]';
    const text = clean(el.innerText || el.value || '');
    if (text && text.length < 40) return text;
    if (el.className && typeof el.className === 'string') {
      const first = el.className.split(/\\s+/).filter(Boolean)[0];
      if (first) return tag + '.' + CSS.escape(first);
    }
    return tag;
  };
  const push = (event) => {
    const full = Object.assign({ at: Date.now(), url: location.href }, event);
    window.__haloRec.push(full);
    // Streamed out immediately: a click that navigates would otherwise be lost with its page.
    try { console.log('__HALO_REC__' + JSON.stringify(full)); } catch (e) {}
  };
  document.addEventListener(
    'click',
    (ev) => {
      const target = ev.target;
      const el = (target.closest && target.closest('a,button,input,select,[role=button],[role=link],label,summary')) || target;
      push({ kind: 'click', selector: selectorFor(el), text: clean(el.innerText || el.value || '').slice(0, 60) });
    },
    true,
  );
  document.addEventListener(
    'change',
    (ev) => {
      const el = ev.target;
      if (!el || !el.matches || !el.matches('input,textarea,select')) return;
      const secret = el.type === 'password';
      push({ kind: 'input', selector: selectorFor(el), value: secret ? '<secret>' : String(el.value || '').slice(0, 120) });
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key !== 'Enter') return;
      push({ kind: 'key', key: 'Enter', selector: selectorFor(ev.target) });
    },
    true,
  );
  return 'ok';
})()`;

export async function injectRecorder(wc: WebContents): Promise<void> {
  try {
    await wc.executeJavaScript(RECORDER, true);
  } catch {
    /* page is mid-navigation; the next did-finish-load re-injects */
  }
}

export const RECORD_PREFIX = '__HALO_REC__';

/** Parses one console line the recorder emitted; returns null for ordinary page logs. */
export function parseRecordedLine(message: string): TeachEvent | null {
  if (!message.startsWith(RECORD_PREFIX)) return null;
  try {
    return JSON.parse(message.slice(RECORD_PREFIX.length)) as TeachEvent;
  } catch {
    return null;
  }
}

export async function drainRecorder(wc: WebContents): Promise<TeachEvent[]> {
  try {
    const raw = (await wc.executeJavaScript(
      'JSON.stringify(window.__haloRec ? window.__haloRec.splice(0) : [])',
      true,
    )) as string;
    return JSON.parse(raw) as TeachEvent[];
  } catch {
    return [];
  }
}

/** Collapses a raw trace into the numbered steps a skill is written from. */
export function describeTrace(events: TeachEvent[]): string {
  const lines: string[] = [];
  let lastUrl = '';
  let step = 1;
  for (const event of events) {
    if (event.url && event.url !== lastUrl) {
      lines.push(`${step++}. Open ${event.url}`);
      lastUrl = event.url;
    }
    if (event.kind === 'click') {
      const what = event.text ? `"${event.text}"` : event.selector;
      lines.push(`${step++}. Click ${what}${event.selector && event.text ? ` (selector: ${event.selector})` : ''}`);
    } else if (event.kind === 'input') {
      lines.push(`${step++}. Type ${event.value === '<secret>' ? 'a secret the user enters themselves' : `"${event.value}"`} into ${event.selector}`);
    } else if (event.kind === 'key') {
      lines.push(`${step++}. Press ${event.key} in ${event.selector}`);
    }
  }
  return lines.join('\n');
}
