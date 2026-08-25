import { WebContentsView, session, type BaseWindow, type Rectangle } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComputerPort } from '../host/tools';
import { describeTrace, drainRecorder, injectRecorder, parseRecordedLine, type TeachEvent } from './teach';
import type { ControlState, HaloEvent } from '../host/types';

/**
 * A refusal because a person is driving. Distinct from a failure, so the bot can be told to wait
 * rather than to try something else.
 */
export class HumanHasControlError extends Error {
  constructor() {
    super('A person has the wheel on your browser right now. Wait for them to hand it back, and say so if the wait matters.');
    this.name = 'HumanHasControlError';
  }
}

/** A ref the model cited that is not on the page the browser is actually showing. */
export class StaleRefError extends Error {
  constructor(ref: string) {
    super(`${ref} is not on the page this browser is showing. Take a fresh Browser snapshot and use the refs it returns.`);
    this.name = 'StaleRefError';
  }
}

/** An unanswered request for help stops being shown after this, rather than following the bot to tomorrow. */
const HELP_REQUEST_TTL_MS = 10 * 60_000;

interface SnapshotEntry {
  /** Which snapshot these refs came from. A ref only resolves against its own generation. */
  generation: number;
  url: string;
  elements: Map<string, { ref: string; role: string; name: string; selector: string }>;
}

const HOME = 'https://duckduckgo.com';
/** Parked position: large enough to render a real page, far enough out to be invisible. */
const OFFSCREEN: Rectangle = { x: -4000, y: 0, width: 1280, height: 800 };
/** Layout width a shrunk preview still renders at. */
const VIRTUAL_WIDTH = 1280;

interface Screen {
  view: WebContentsView;
  attached: boolean;
  previewCss?: string;
  lastUsed: number;
}

/**
 * Live Chromium screens kept around. Each one is a real page with throttling off, so a bot per
 * screen does not scale. The persistent session outlives the view, so a reopened screen is still
 * signed in — only the current page is lost.
 */
const MAX_LIVE_SCREENS = 3;

/**
 * The bot's computer: a real Chromium window the user can watch and take over.
 * One screen per bot, all sharing a persistent session so logins survive restarts —
 * the same "sign in once, the bot keeps using it" model as the original.
 */
export class Computer implements ComputerPort {
  private screens = new Map<string, Screen>();
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private visibleAgentId: string | null = null;
  private previewAgentId: string | null = null;
  private previewBounds: Rectangle | null = null;
  private suspended = false;
  private resumeState: { kind: 'full' | 'preview'; agentId: string; bounds: Rectangle } | null = null;
  private teaching: { agentId: string; startedAt: number; events: TeachEvent[]; timer: NodeJS.Timeout } | null = null;
  /** Who is driving each bot's browser. Absent means the bot has it, which is the normal case. */
  private control = new Map<string, ControlState>();
  /** The elements the last snapshot named, per bot, so a ref is resolved here and not by the model. */
  private snapshots = new Map<string, SnapshotEntry>();
  private generation = 0;

  constructor(
    private window: BaseWindow,
    private boxDirFor: (agentId: string) => string,
    private emit: (event: HaloEvent) => void,
  ) {}

  private screen(agentId: string): Screen {
    const existing = this.screens.get(agentId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    // A view only paints once it is in the window, so every screen lives there from the start,
    // parked off-canvas until it is shown. That is what makes the preview thumbnail real.
    const view = new WebContentsView({
      webPreferences: {
        session: session.fromPartition('persist:halo-computer'),
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
      },
    });
    view.setBackgroundColor('#111111');
    view.webContents.setWindowOpenHandler(({ url }) => {
      void view.webContents.loadURL(url);
      return { action: 'deny' };
    });
    const report = () => {
      this.emit({
        type: 'computer',
        agentId,
        url: view.webContents.getURL(),
        title: view.webContents.getTitle(),
        visible: this.visibleAgentId === agentId,
      });
    };
    view.webContents.on('did-navigate', report);
    view.webContents.on('dom-ready', () => {
      if (this.teaching?.agentId === agentId) void injectRecorder(view.webContents);
    });
    // The recorder streams each step out as a console line, so nothing is lost to a navigation.
    view.webContents.on('console-message', (...args: unknown[]) => {
      if (this.teaching?.agentId !== agentId) return;
      const text =
        typeof args[2] === 'string'
          ? (args[2] as string)
          : typeof (args[0] as { message?: string })?.message === 'string'
            ? ((args[0] as { message?: string }).message as string)
            : '';
      const event = parseRecordedLine(text);
      if (event) this.teaching.events.push(event);
    });
    // A navigation destroys the page's recorder, so its events are collected first.
    view.webContents.on('will-navigate', () => {
      if (this.teaching?.agentId === agentId) void this.drainTeaching(view.webContents);
    });
    view.webContents.on('did-start-navigation', () => {
      if (this.teaching?.agentId === agentId) void this.drainTeaching(view.webContents);
    });
    view.webContents.on('did-navigate-in-page', report);
    view.webContents.on('page-title-updated', report);
    const screen: Screen = { view, attached: true, lastUsed: Date.now() };
    this.window.contentView.addChildView(view);
    view.setBounds(OFFSCREEN);
    view.setVisible(true);
    this.screens.set(agentId, screen);
    this.evictIdleScreens();
    return screen;
  }

  /** Closes the screens nobody is looking at, keeping whatever is on show or being recorded. */
  private evictIdleScreens() {
    if (this.screens.size <= MAX_LIVE_SCREENS) return;
    const keep = new Set([this.visibleAgentId, this.previewAgentId, this.teaching?.agentId].filter(Boolean) as string[]);
    const idle = [...this.screens.entries()]
      .filter(([id]) => !keep.has(id))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (this.screens.size > MAX_LIVE_SCREENS && idle.length > 0) {
      const [id, screen] = idle.shift()!;
      this.screens.delete(id);
      try {
        this.window.contentView.removeChildView(screen.view);
        screen.view.webContents.close();
      } catch {
        /* already gone */
      }
    }
  }

  async ensure(agentId: string): Promise<void> {
    const s = this.screen(agentId);
    if (s.view.webContents.getURL()) return;
    try {
      await s.view.webContents.loadURL(HOME);
    } catch {
      // A load aborted by a second navigation is normal here, not a failure.
    }
  }

  /** Renderer reports where the computer pane sits so the view can be laid over it. */
  setBounds(bounds: Rectangle) {
    this.bounds = bounds;
    const s = this.visibleAgentId ? this.screens.get(this.visibleAgentId) : null;
    if (s?.attached) s.view.setBounds(bounds);
  }

  /**
   * The details pane preview is the real screen, shrunk: same view, small bounds, zoomed out.
   * That keeps it live instead of a stale snapshot.
   */
  /**
   * Native views paint above the page, so a modal would end up behind them.
   * The renderer suspends them for as long as an overlay is open.
   */
  setSuspended(suspended: boolean) {
    if (suspended === this.suspended) return;
    this.suspended = suspended;
    if (suspended) {
      if (this.visibleAgentId) {
        this.resumeState = { kind: 'full', agentId: this.visibleAgentId, bounds: this.bounds };
        this.hide();
      } else if (this.previewAgentId && this.previewBounds) {
        this.resumeState = { kind: 'preview', agentId: this.previewAgentId, bounds: this.previewBounds };
        this.clearPreview();
      }
      return;
    }
    const state = this.resumeState;
    this.resumeState = null;
    if (!state) return;
    if (state.kind === 'full') {
      this.setBounds(state.bounds);
      this.show(state.agentId);
    } else {
      this.preview(state.agentId, state.bounds);
    }
  }

  preview(agentId: string, bounds: Rectangle) {
    if (this.visibleAgentId || this.suspended) return;
    if (this.previewAgentId && this.previewAgentId !== agentId) this.park(this.previewAgentId);
    this.previewAgentId = agentId;
    this.previewBounds = bounds;
    const s = this.screen(agentId);
    s.view.setBounds(bounds);
    s.view.webContents.setZoomFactor(Math.max(0.1, Math.min(1, bounds.width / VIRTUAL_WIDTH)));
    s.view.setVisible(true);
    void this.ensure(agentId).then(() => this.setPreviewChrome(s, true));
  }

  clearPreview() {
    if (!this.previewAgentId) return;
    this.park(this.previewAgentId);
    this.previewAgentId = null;
    this.previewBounds = null;
  }

  private park(agentId: string) {
    const s = this.screens.get(agentId);
    if (!s) return;
    void this.setPreviewChrome(s, false);
    s.view.webContents.setZoomFactor(1);
    s.view.setBounds(OFFSCREEN);
  }

  /** Scrollbars look like breakage in a thumbnail, so they are hidden while shrunk. */
  private async setPreviewChrome(screen: Screen, preview: boolean) {
    try {
      if (preview) {
        if (screen.previewCss) return;
        screen.previewCss = await screen.view.webContents.insertCSS(
          '::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}',
        );
      } else if (screen.previewCss) {
        await screen.view.webContents.removeInsertedCSS(screen.previewCss);
        delete screen.previewCss;
      }
    } catch {
      /* the page may be mid-navigation; the next preview call re-applies it */
    }
  }

  show(agentId: string) {
    if (this.suspended) {
      this.resumeState = { kind: 'full', agentId, bounds: this.bounds };
      return;
    }
    if (this.visibleAgentId && this.visibleAgentId !== agentId) this.hide();
    this.clearPreview();
    const s = this.screen(agentId);
    void this.setPreviewChrome(s, false);
    s.view.webContents.setZoomFactor(1);
    s.view.setBounds(this.bounds);
    s.view.setVisible(true);
    this.visibleAgentId = agentId;
    void this.ensure(agentId);
    this.emit({ type: 'computer', agentId, url: s.view.webContents.getURL(), title: s.view.webContents.getTitle(), visible: true });
  }

  hide() {
    const id = this.visibleAgentId;
    if (!id) return;
    const s = this.screens.get(id);
    // Parked, not destroyed: the page keeps running.
    if (s) {
      s.view.webContents.setZoomFactor(1);
      s.view.setBounds(OFFSCREEN);
    }
    this.visibleAgentId = null;
    this.emit({ type: 'computer', agentId: id, url: s?.view.webContents.getURL() ?? '', title: '', visible: false });
  }

  /** Brings the screen up for the user so they can sign in or take over. */
  async handOver(agentId: string, instruction: string): Promise<void> {
    await this.ensure(agentId);
    this.setControl(agentId, { holder: 'bot', since: Date.now(), requested: true, instruction });
    this.onHandOver?.(agentId, instruction);
  }

  /** Set by main so a handover can open the pane in the renderer. */
  onHandOver?: (agentId: string, instruction: string) => void;

  // ----------------------------------------------------------------- control

  /**
   * Who has the wheel.
   *
   * One browser has at most one driver. A bot that meets a login wall asks for help; the person
   * takes control, does the part only they can do, and hands it back. While they hold it every
   * acting call from the bot is refused, because two drivers on one page is how a bot presses
   * Confirm on a form somebody was still filling in. Modelled on OpenBot's control state, which
   * lives beside the browser for the same reason this does: a takeover the browser does not know
   * about is not a takeover.
   */
  controlOf(agentId: string): ControlState {
    const state = this.control.get(agentId);
    if (!state) return { holder: 'bot', since: 0, requested: false };
    // An unanswered request belongs to a run that has long since ended; stop showing it.
    if (state.holder === 'bot' && state.requested && Date.now() - state.since > HELP_REQUEST_TTL_MS) {
      const cleared: ControlState = { holder: 'bot', since: Date.now(), requested: false };
      this.control.set(agentId, cleared);
      return cleared;
    }
    return state;
  }

  private setControl(agentId: string, state: ControlState) {
    this.control.set(agentId, state);
    this.emit({
      type: 'control',
      agentId,
      holder: state.holder,
      requested: state.requested,
      ...(state.instruction ? { instruction: state.instruction } : {}),
    });
  }

  /** The person takes the wheel. Every bot action on this browser is refused until they give it back. */
  takeControl(agentId: string) {
    const prior = this.control.get(agentId);
    this.setControl(agentId, {
      holder: 'human',
      since: Date.now(),
      requested: false,
      ...(prior?.instruction ? { instruction: prior.instruction } : {}),
    });
  }

  releaseControl(agentId: string) {
    this.setControl(agentId, { holder: 'bot', since: Date.now(), requested: false });
    // The page almost certainly moved while they were driving, so nothing the bot is still holding
    // describes it any more.
    this.snapshots.delete(agentId);
  }

  /** Throws when a person is driving. Called by every acting path, never by a read. */
  private assertBotHasControl(agentId: string) {
    if (this.controlOf(agentId).holder === 'human') throw new HumanHasControlError();
  }

  // ---------------------------------------------------------------- snapshot

  /**
   * The controls on the page, each with an opaque ref.
   *
   * A ref, not a selector the model made up. The mapping is held here, so an action names something
   * this process resolved from a page it actually looked at: "click e12" cannot become a click on
   * whatever the model wished were there. It also makes the approval card able to say what is being
   * pressed, which a raw CSS selector never could. The generation counter means a ref from a
   * superseded page resolves to nothing rather than to whatever now holds that ref.
   */
  async snapshot(agentId: string): Promise<string> {
    const wc = this.screen(agentId).view.webContents;
    /*
     * The accessible name and role of everything on the page a person could act on.
     *
     * Not Playwright's `mode: "ai"` tree, which would mean a second browser beside the one Halo
     * already owns — the wrong trade for an app whose whole point is *this* Chromium with *these*
     * logins. It is the same idea done in the page: resolve the name the way a screen reader would
     * (aria-labelledby, then aria-label, then the associated <label>, then placeholder, title, alt,
     * then text), and take the roles rather than the tags, so a `div[role=button]` is a button and a
     * custom component with a proper label is visible instead of skipped.
     *
     * The ref is written onto the node as an attribute, so resolving it later is a selector this
     * process wrote rather than one the model guessed.
     */
    const script = `(() => {
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
      };
      const roleOf = (el) => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit.split(/\\s+/)[0];
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
        if (tag === 'button' || tag === 'summary') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') {
          const t = (el.getAttribute('type') || 'text').toLowerCase();
          if (t === 'checkbox' || t === 'radio') return t;
          if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
          if (t === 'range') return 'slider';
          if (t === 'search') return 'searchbox';
          if (t === 'hidden') return '';
          return 'textbox';
        }
        if (el.isContentEditable) return 'textbox';
        return 'generic';
      };
      // Roughly the accessible-name computation, in the order a screen reader applies it.
      const nameOf = (el) => {
        const by = el.getAttribute('aria-labelledby');
        if (by) {
          const parts = by.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean);
          const joined = clean(parts.map((n) => n.innerText || n.textContent || '').join(' '));
          if (joined) return joined;
        }
        const label = el.getAttribute('aria-label');
        if (clean(label)) return clean(label);
        if (el.id) {
          const associated = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (associated && clean(associated.innerText)) return clean(associated.innerText);
        }
        const wrapping = el.closest('label');
        if (wrapping && clean(wrapping.innerText)) return clean(wrapping.innerText);
        for (const attr of ['placeholder', 'title', 'alt', 'value', 'name']) {
          const v = clean(el.getAttribute(attr));
          if (v) return v;
        }
        return clean(el.innerText || el.textContent || '');
      };
      const selector = 'a, button, summary, input, textarea, select, [role], [contenteditable=""], [contenteditable="true"], [tabindex]';
      const acting = new Set(['button','link','checkbox','radio','textbox','searchbox','combobox','listbox','option','slider','spinbutton','switch','tab','menuitem','menuitemcheckbox','menuitemradio','treeitem']);
      const out = [];
      let n = 0;
      for (const el of document.querySelectorAll(selector)) {
        const role = roleOf(el);
        if (!acting.has(role)) continue;
        if (!visible(el)) continue;
        if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') continue;
        const name = nameOf(el);
        if (!name) continue;
        n += 1;
        el.setAttribute('data-halo-ref', 'e' + n);
        const state = el.checked === true ? ' [checked]' : el.getAttribute('aria-expanded') === 'true' ? ' [expanded]' : '';
        out.push({ ref: 'e' + n, role: role + state, name: name.slice(0, 80), selector: '[data-halo-ref="e' + n + '"]' });
        if (out.length >= 150) break;
      }
      return JSON.stringify({ url: location.href, title: document.title, elements: out });
    })()`;
    const raw = (await wc.executeJavaScript(script, true)) as string;
    const page = JSON.parse(raw) as {
      url: string;
      title: string;
      elements: { ref: string; role: string; name: string; selector: string }[];
    };
    this.generation += 1;
    this.snapshots.set(agentId, {
      generation: this.generation,
      url: page.url,
      elements: new Map(page.elements.map((e) => [e.ref, e])),
    });
    const listed = page.elements.map((e) => `${e.ref}  ${e.role}  "${e.name}"`).join('\n');
    return `# ${page.title}\n${page.url}\nsnapshot ${this.generation}\n\n${listed || '(no controls found)'}`;
  }

  /**
   * What a ref points at, or undefined.
   *
   * Undefined rather than a throw, because the approval gate still has to run on an action whose
   * element could not be identified: a rule written about a page the bot has not snapshotted should
   * still be able to refuse it.
   */
  describeRef(agentId: string, ref: string): { role: string; name: string } | undefined {
    const entry = this.snapshots.get(agentId);
    const element = entry?.elements.get(ref);
    return element ? { role: element.role, name: element.name } : undefined;
  }

  // ---------------------------------------------------------------- teaching

  /** Records what the user does on the bot's screen so it can be replayed as a skill. */
  async startTeaching(agentId: string): Promise<void> {
    await this.stopTeaching();
    await this.ensure(agentId);
    const wc = this.screen(agentId).view.webContents;
    await injectRecorder(wc);
    const timer = setInterval(() => {
      void this.drainTeaching(wc);
    }, 1500);
    this.teaching = { agentId, startedAt: Date.now(), events: [], timer };
    this.emit({ type: 'teaching', agentId, recording: true, seconds: 0, steps: 0 });
  }

  private async drainTeaching(wc: Electron.WebContents) {
    if (!this.teaching) return;
    const events = await drainRecorder(wc);
    // Console streaming is the primary channel; this only catches anything it missed.
    for (const event of events) {
      const duplicate = this.teaching.events.some((seen) => seen.at === event.at && seen.kind === event.kind);
      if (!duplicate) this.teaching.events.push(event);
    }
  }

  teachingStatus(): { agentId: string; seconds: number; steps: number } | null {
    if (!this.teaching) return null;
    return {
      agentId: this.teaching.agentId,
      seconds: Math.round((Date.now() - this.teaching.startedAt) / 1000),
      steps: this.teaching.events.length,
    };
  }

  /** Stops recording and returns the trace as numbered steps, or null if nothing was captured. */
  async stopTeaching(): Promise<{ agentId: string; steps: string; count: number } | null> {
    const session = this.teaching;
    if (!session) return null;
    clearInterval(session.timer);
    this.teaching = null;
    const screen = this.screens.get(session.agentId);
    if (screen) {
      const tail = await drainRecorder(screen.view.webContents);
      session.events.push(...tail);
    }
    this.emit({ type: 'teaching', agentId: session.agentId, recording: false, seconds: 0, steps: session.events.length });
    if (session.events.length === 0) return { agentId: session.agentId, steps: '', count: 0 };
    return { agentId: session.agentId, steps: describeTrace(session.events), count: session.events.length };
  }

  async navigate(agentId: string, url: string) {
    this.assertBotHasControl(agentId);
    // The page is about to change, so the refs the bot is holding describe something that is gone.
    this.snapshots.delete(agentId);
    const s = this.screen(agentId);
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    try {
      await s.view.webContents.loadURL(target);
    } catch (error) {
      const message = String((error as Error).message ?? error);
      if (!message.includes('ERR_ABORTED')) throw error;
    }
    await this.settle(agentId);
    return { url: s.view.webContents.getURL(), title: s.view.webContents.getTitle() };
  }

  private settle(agentId: string): Promise<void> {
    const wc = this.screen(agentId).view.webContents;
    if (!wc.isLoading()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      wc.once('did-stop-loading', done);
      setTimeout(done, 15_000);
    });
  }

  async readPage(agentId: string): Promise<string> {
    const wc = this.screen(agentId).view.webContents;
    const script = `(() => {
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const text = clean(document.body ? document.body.innerText : '');
      const controls = [];
      const nodes = document.querySelectorAll('a[href], button, input, textarea, select, [role=button], [role=link]');
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const label = clean(el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.name || '');
        if (!label) continue;
        const sel = el.id ? '#' + CSS.escape(el.id) : (el.name ? el.tagName.toLowerCase() + '[name="' + el.name + '"]' : '');
        controls.push('- ' + el.tagName.toLowerCase() + ' "' + label.slice(0, 60) + '"' + (sel ? ' selector=' + sel : ''));
        if (controls.length > 60) break;
      }
      return JSON.stringify({ url: location.href, title: document.title, text: text.slice(0, 12000), controls: controls.join('\\n') });
    })()`;
    const raw = (await wc.executeJavaScript(script, true)) as string;
    const page = JSON.parse(raw) as { url: string; title: string; text: string; controls: string };
    return `# ${page.title}\n${page.url}\n\n${page.text}\n\n## Clickable / fillable\n${page.controls || '(none found)'}`;
  }

  async act(agentId: string, action: string, params: Record<string, unknown>): Promise<string> {
    this.assertBotHasControl(agentId);
    const wc = this.screen(agentId).view.webContents;
    const text = typeof params.text === 'string' ? params.text : '';
    const ref = typeof params.ref === 'string' ? params.ref.trim() : '';
    /*
     * A cited ref resolves here or the action is refused.
     *
     * Falling back to the raw text when a ref does not resolve is the failure mode this whole
     * mechanism exists to prevent: the approval card would have named the button from the snapshot,
     * and the click would land on whatever that ref points at now. A stale citation is a reason to
     * take a fresh snapshot, not to guess.
     */
    let selector = typeof params.selector === 'string' ? params.selector : '';
    if (ref) {
      const entry = this.snapshots.get(agentId);
      const element = entry?.elements.get(ref);
      if (!element) throw new StaleRefError(ref);
      selector = element.selector;
    }

    if (action === 'back') {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      await this.settle(agentId);
      return `Back to ${wc.getURL()}`;
    }

    if (action === 'scroll') {
      const amount = typeof params.amount === 'number' ? params.amount : 600;
      await wc.executeJavaScript(`window.scrollBy(0, ${amount}); 'ok'`, true);
      return `Scrolled ${amount}px.`;
    }

    if (action === 'press') {
      const key = typeof params.key === 'string' ? params.key : 'Enter';
      wc.focus();
      wc.sendInputEvent({ type: 'keyDown', keyCode: key });
      wc.sendInputEvent({ type: 'char', keyCode: key });
      wc.sendInputEvent({ type: 'keyUp', keyCode: key });
      await this.settle(agentId);
      return `Pressed ${key}.`;
    }

    if (action === 'click' || action === 'type') {
      const script = `(() => {
        const want = ${JSON.stringify(selector)};
        const findByText = (t) => {
          const all = document.querySelectorAll('a, button, [role=button], input[type=submit], label, li, div, span');
          const needle = t.toLowerCase();
          for (const el of all) {
            const label = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().toLowerCase();
            if (label && label.length < 120 && label.includes(needle)) return el;
          }
          return null;
        };
        let el = null;
        try { el = want ? document.querySelector(want) : null; } catch (e) { el = null; }
        if (!el && want) el = findByText(want.replace(/^["']|["']$/g, ''));
        if (!el) return 'NOT_FOUND';
        el.scrollIntoView({ block: 'center' });
        if (${JSON.stringify(action)} === 'click') {
          el.click();
          return 'clicked ' + (el.tagName || '');
        }
        const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value');
        el.focus();
        if (setter && setter.set) { setter.set.call(el, ${JSON.stringify(text)}); }
        else { el.textContent = ${JSON.stringify(text)}; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'typed into ' + (el.tagName || '');
      })()`;
      const result = (await wc.executeJavaScript(script, true)) as string;
      if (result === 'NOT_FOUND') return `No element matched "${selector}". Call Browser read first to see what is on the page.`;
      await this.settle(agentId);
      return `${result} — now on ${wc.getURL()}`;
    }

    return `Unknown browser action: ${action}`;
  }

  async screenshot(agentId: string): Promise<string> {
    const wc = this.screen(agentId).view.webContents;
    const image = await wc.capturePage();
    const dir = join(this.boxDirFor(agentId), 'screenshots');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `screen-${Date.now()}.png`);
    writeFileSync(file, image.toPNG());
    return file;
  }

  /** Boots the screen on first ask, so the details pane shows a live picture instead of a blank box. */
  async thumbnail(agentId: string): Promise<string | null> {
    await this.ensure(agentId);
    const s = this.screens.get(agentId);
    if (!s) return null;
    const image = await s.view.webContents.capturePage();
    if (image.isEmpty()) return null;
    return image.resize({ width: 480 }).toDataURL();
  }

  dispose() {
    for (const [, s] of this.screens) {
      this.window.contentView.removeChildView(s.view);
      s.view.webContents.close();
    }
    this.screens.clear();
  }
}
