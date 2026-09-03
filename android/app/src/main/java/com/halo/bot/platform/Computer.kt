package com.halo.bot.platform

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import com.halo.bot.core.Args
import com.halo.bot.core.ComputerPort
import com.halo.bot.core.ControlState
import com.halo.bot.core.HaloEvent
import com.halo.bot.core.HaloJson
import com.halo.bot.core.str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import kotlin.coroutines.resume

/**
 * A refusal because a person is driving. Distinct from a failure, so the bot can be told to wait
 * rather than to try something else.
 */
class HumanHasControlError : Exception(
    "A person has the wheel on your browser right now. Wait for them to hand it back, and say so if the wait matters.",
)

/** A ref the model cited that is not on the page the browser is actually showing. */
class StaleRefError(ref: String) : Exception(
    "$ref is not on the page this browser is showing. Take a fresh Browser snapshot and use the refs it returns.",
)

/** An unanswered request for help stops being shown after this, rather than following the bot to tomorrow. */
private const val HELP_REQUEST_TTL_MS = 10 * 60_000L

private const val HOME = "https://duckduckgo.com"

/** A detached WebView still needs a size to lay out at, or nothing renders and every ref is invisible. */
private const val VIRTUAL_WIDTH = 1080
private const val VIRTUAL_HEIGHT = 1920

/**
 * Live screens kept around. Each is a real page, so a bot per screen does not scale. Cookies live in
 * the app-wide WebView store rather than in the view, so a screen that is evicted and reopened is
 * still signed in — only the current page is lost.
 */
private const val MAX_LIVE_SCREENS = 3

data class SnapshotElement(val ref: String, val role: String, val name: String, val selector: String)

private class SnapshotEntry(
    /** Which snapshot these refs came from. A ref only resolves against its own generation. */
    val generation: Int,
    val url: String,
    val elements: Map<String, SnapshotElement>,
)

private class Screen(val view: WebView) {
    var lastUsed: Long = System.currentTimeMillis()

    /** Set while a page load is in flight, so `settle` waits for the real thing rather than a timer. */
    @Volatile var loading: Boolean = false
    var attached: Boolean = false
}

/**
 * The bot's browser: one WebView per bot, which the user can watch in the Computer pane and take over
 * with one tap.
 *
 * The desktop build hosts a Chromium `WebContentsView` in the Electron window. The idea survives
 * intact — a real browser the bot drives and the user can watch, with logins that persist — but the
 * mechanics are Android's: a WebView per bot, cookies in the app-wide CookieManager, JavaScript
 * evaluated through `evaluateJavascript`, and screenshots taken by drawing the view onto a bitmap.
 * The snapshot-and-ref model is ported verbatim, because it is the part that makes a click land on
 * the control Halo actually saw rather than on a selector the model invented.
 */
@SuppressLint("SetJavaScriptEnabled")
class Computer(
    private val context: Context,
    private val boxDirFor: (String) -> File,
    private val emit: (HaloEvent) -> Unit,
) : ComputerPort {

    private val screens = LinkedHashMap<String, Screen>()

    /** Who is driving each bot's browser. Absent means the bot has it, which is the normal case. */
    private val control = HashMap<String, ControlState>()

    /** The elements the last snapshot named, per bot, so a ref is resolved here and not by the model. */
    private val snapshots = HashMap<String, SnapshotEntry>()
    private var generation = 0

    /** Which bot's screen the user is looking at, so events can say whether it is visible. */
    @Volatile var visibleAgentId: String? = null

    private var teaching: Teaching? = null

    private class Teaching(val agentId: String, val startedAt: Long) {
        val events = mutableListOf<TeachEvent>()
    }

    // ------------------------------------------------------------------ screens

    private suspend fun screen(agentId: String): Screen = withContext(Dispatchers.Main) {
        screens[agentId]?.let {
            it.lastUsed = System.currentTimeMillis()
            return@withContext it
        }
        val view = WebView(context)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            userAgentString = view.settings.userAgentString + " HaloBot/0.1"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true)
        val screen = Screen(view)
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = false

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                screen.loading = true
                // The refs the bot is holding describe the page that is going away. Dropping the
                // map here is what turns a ref cited after a tap that navigated into "take a fresh
                // snapshot" rather than into a tap on whatever now sits at that ref.
                snapshots.remove(agentId)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                screen.loading = false
                if (teaching?.agentId == agentId) view.evaluateJavascript(RECORDER, null)
                emit(
                    HaloEvent.ComputerChanged(
                        agentId,
                        view.url.orEmpty(),
                        view.title.orEmpty(),
                        visibleAgentId == agentId,
                    ),
                )
            }
        }
        view.addJavascriptInterface(Recorder(agentId), "HaloRecorder")
        // A detached view lays out at nothing, and a page rendered at zero size has no visible
        // controls at all — every snapshot would come back empty. Giving it a virtual phone-sized
        // viewport is what makes an off-screen screen behave like the one on the pane.
        view.measure(
            View.MeasureSpec.makeMeasureSpec(VIRTUAL_WIDTH, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(VIRTUAL_HEIGHT, View.MeasureSpec.EXACTLY),
        )
        view.layout(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT)
        screens[agentId] = screen
        evictIdleScreens()
        screen
    }

    /** Closes the screens nobody is looking at, keeping whatever is on show or being recorded. */
    private fun evictIdleScreens() {
        if (screens.size <= MAX_LIVE_SCREENS) return
        val keep = setOfNotNull(visibleAgentId, teaching?.agentId)
        val idle = screens.entries.filter { it.key !in keep }.sortedBy { it.value.lastUsed }.toMutableList()
        while (screens.size > MAX_LIVE_SCREENS && idle.isNotEmpty()) {
            val (id, screen) = idle.removeAt(0)
            screens.remove(id)
            snapshots.remove(id)
            runCatching {
                (screen.view.parent as? android.view.ViewGroup)?.removeView(screen.view)
                screen.view.destroy()
            }
        }
    }

    /** The view for a bot, for the Compose pane to host. Null until the bot has used its browser. */
    fun viewFor(agentId: String): WebView? = screens[agentId]?.view

    suspend fun ensureView(agentId: String): WebView = screen(agentId).view

    override suspend fun ensure(agentId: String) {
        val s = screen(agentId)
        withContext(Dispatchers.Main) {
            if (s.view.url.isNullOrBlank()) s.view.loadUrl(HOME)
        }
    }

    // ------------------------------------------------------------------ control

    override suspend fun handOver(agentId: String, instruction: String) {
        setControl(
            agentId,
            ControlState(holder = "human", since = System.currentTimeMillis(), requested = true, instruction = instruction),
        )
        emit(HaloEvent.Focus(agentId))
    }

    fun controlOf(agentId: String): ControlState {
        val state = control[agentId] ?: return ControlState()
        // An unanswered ask goes quiet after a while rather than following the bot into tomorrow.
        if (state.requested && System.currentTimeMillis() - state.since > HELP_REQUEST_TTL_MS) {
            val next = state.copy(requested = false)
            control[agentId] = next
            return next
        }
        return state
    }

    private fun setControl(agentId: String, state: ControlState) {
        control[agentId] = state
        emit(HaloEvent.ControlChanged(agentId, state.holder, state.requested, state.instruction))
    }

    fun takeControl(agentId: String) {
        setControl(agentId, ControlState(holder = "human", since = System.currentTimeMillis(), requested = false))
    }

    fun releaseControl(agentId: String) {
        setControl(agentId, ControlState(holder = "bot", since = System.currentTimeMillis(), requested = false))
    }

    private fun assertBotHasControl(agentId: String) {
        if (controlOf(agentId).holder == "human") throw HumanHasControlError()
    }

    // ------------------------------------------------------------- driving

    override suspend fun navigate(agentId: String, url: String): Pair<String, String> {
        assertBotHasControl(agentId)
        val s = screen(agentId)
        val target = if (Regex("^[a-z]+://", RegexOption.IGNORE_CASE).containsMatchIn(url)) url else "https://$url"
        withContext(Dispatchers.Main) {
            s.loading = true
            s.view.loadUrl(target)
        }
        settle(s)
        return withContext(Dispatchers.Main) { s.view.url.orEmpty() to s.view.title.orEmpty() }
    }

    /** Waits for the page to stop loading, with a ceiling so a never-finishing page cannot wedge a turn. */
    private suspend fun settle(s: Screen) {
        val deadline = System.currentTimeMillis() + 15_000
        while (s.loading && System.currentTimeMillis() < deadline) delay(120)
        delay(250)
    }

    private suspend fun eval(view: WebView, script: String): String = withContext(Dispatchers.Main) {
        suspendCancellableCoroutine { cont ->
            view.evaluateJavascript(script) { value ->
                // evaluateJavascript hands back a JSON-encoded value, so a returned string arrives
                // quoted and escaped. Decoding here keeps every caller working in plain text.
                val decoded = when {
                    value == null || value == "null" -> ""
                    value.startsWith("\"") -> runCatching {
                        (HaloJson.parseToJsonElement(value) as JsonPrimitive).content
                    }.getOrDefault(value)

                    else -> value
                }
                cont.resume(decoded)
            }
        }
    }

    override suspend fun readPage(agentId: String): String {
        val s = screen(agentId)
        val raw = eval(s.view, READ_PAGE)
        val page = runCatching { HaloJson.parseToJsonElement(raw) as JsonObject }.getOrNull()
            ?: return "The page could not be read."
        val text = (page["text"] as? JsonPrimitive)?.content.orEmpty()
        val controls = (page["controls"] as? JsonPrimitive)?.content.orEmpty()
        return "# ${(page["title"] as? JsonPrimitive)?.content.orEmpty()}\n" +
            "${(page["url"] as? JsonPrimitive)?.content.orEmpty()}\n\n$text\n\n" +
            "## Clickable / fillable\n" + controls.ifEmpty { "(none found)" }
    }

    override suspend fun snapshot(agentId: String): String {
        val s = screen(agentId)
        // Stamped into the attribute below, so a selector this snapshot wrote can never match a
        // node a different snapshot marked. Without it, a single-page app that recycles a DOM node
        // keeps the last snapshot's `data-halo-ref` on a control whose label has since changed —
        // and the approval card then names one button while the tap lands on another.
        val generation = ++this.generation
        val raw = eval(s.view, SNAPSHOT.replace("%GEN%", generation.toString()))
        val page = runCatching { HaloJson.parseToJsonElement(raw) as JsonObject }.getOrNull()
            ?: return "The page could not be snapshotted."
        val elements = (page["elements"] as? JsonArray).orEmpty().mapNotNull { element ->
            val e = element as? JsonObject ?: return@mapNotNull null
            SnapshotElement(
                ref = (e["ref"] as? JsonPrimitive)?.content ?: return@mapNotNull null,
                role = (e["role"] as? JsonPrimitive)?.content.orEmpty(),
                name = (e["name"] as? JsonPrimitive)?.content.orEmpty(),
                selector = (e["selector"] as? JsonPrimitive)?.content.orEmpty(),
            )
        }
        snapshots[agentId] = SnapshotEntry(
            generation,
            (page["url"] as? JsonPrimitive)?.content.orEmpty(),
            elements.associateBy { it.ref },
        )
        val listed = elements.joinToString("\n") { "${it.ref}  ${it.role}  \"${it.name}\"" }
        return "# ${(page["title"] as? JsonPrimitive)?.content.orEmpty()}\n" +
            "${(page["url"] as? JsonPrimitive)?.content.orEmpty()}\nsnapshot $generation\n\n" +
            listed.ifEmpty { "(no controls found)" }
    }

    /**
     * What a ref points at, or null.
     *
     * Null rather than a throw, because the approval gate still has to run on an action whose element
     * could not be identified: a rule written about a page the bot has not snapshotted should still be
     * able to refuse it.
     */
    override fun describeRef(agentId: String, ref: String): Pair<String, String>? {
        val element = snapshots[agentId]?.elements?.get(ref) ?: return null
        return element.role to element.name
    }

    override suspend fun act(agentId: String, action: String, params: Args): String {
        assertBotHasControl(agentId)
        val s = screen(agentId)
        val text = params.str("text")
        val ref = params.str("ref").trim()
        /*
         * A cited ref resolves here or the action is refused.
         *
         * Falling back to the raw text when a ref does not resolve is the failure mode this whole
         * mechanism exists to prevent: the approval card would have named the button from the
         * snapshot, and the tap would land on whatever that ref points at now. A stale citation is a
         * reason to take a fresh snapshot, not to guess.
         */
        var selector = params.str("selector")
        if (ref.isNotEmpty()) {
            val element = snapshots[agentId]?.elements?.get(ref) ?: throw StaleRefError(ref)
            selector = element.selector
        }

        when (action) {
            "back" -> {
                val went = withContext(Dispatchers.Main) {
                    if (s.view.canGoBack()) {
                        s.loading = true
                        s.view.goBack()
                        true
                    } else {
                        false
                    }
                }
                if (!went) return "There is nothing to go back to."
                settle(s)
                return "Back to " + withContext(Dispatchers.Main) { s.view.url.orEmpty() }
            }

            "scroll" -> {
                val amount = (params["amount"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 600
                eval(s.view, "window.scrollBy(0, $amount); 'ok'")
                return "Scrolled ${amount}px."
            }

            "press" -> {
                val key = params.str("key").ifBlank { "Enter" }
                val script = pressScript(key)
                eval(s.view, script)
                settle(s)
                return "Pressed $key."
            }

            "click", "type" -> {
                val script = actScript(action, selector, text)
                val result = eval(s.view, script)
                if (result == "NOT_FOUND") {
                    return "No element matched \"$selector\". Call Browser snapshot first to see what is on the page."
                }
                settle(s)
                return result + " — now on " + withContext(Dispatchers.Main) { s.view.url.orEmpty() }
            }
        }
        return "Unknown browser action: $action"
    }

    override suspend fun screenshot(agentId: String): String {
        val s = screen(agentId)
        val dir = File(boxDirFor(agentId), "screenshots").apply { mkdirs() }
        val file = File(dir, "screen-" + System.currentTimeMillis() + ".png")
        val bitmap = capture(s) ?: throw Exception("the browser had nothing to show yet")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 90, it) }
        bitmap.recycle()
        return file.absolutePath
    }

    /** Draws whatever the view is showing onto a bitmap. Works attached or off-screen. */
    private suspend fun capture(s: Screen): Bitmap? = withContext(Dispatchers.Main) {
        val width = if (s.view.width > 0) s.view.width else VIRTUAL_WIDTH
        val height = if (s.view.height > 0) s.view.height else VIRTUAL_HEIGHT
        if (width <= 0 || height <= 0) return@withContext null
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        s.view.draw(Canvas(bitmap))
        bitmap
    }

    // ------------------------------------------------------------------ teaching

    /**
     * The recorder streams each step out through a JavaScript bridge rather than the console, because
     * a navigation destroys the page's recorder and anything still sitting in it. Passwords are never
     * recorded — a password field is captured as `<secret>`.
     */
    private inner class Recorder(private val agentId: String) {
        @JavascriptInterface
        fun step(json: String) {
            val session = teaching ?: return
            if (session.agentId != agentId) return
            val event = parseRecordedLine(json) ?: return
            synchronized(session.events) { session.events.add(event) }
        }
    }

    suspend fun startTeaching(agentId: String) {
        teaching = Teaching(agentId, System.currentTimeMillis())
        val s = screen(agentId)
        withContext(Dispatchers.Main) { s.view.evaluateJavascript(RECORDER, null) }
        emit(HaloEvent.Teaching(agentId, true, 0, 0))
    }

    fun teachingStatus(): Triple<String, Int, Int>? {
        val session = teaching ?: return null
        return Triple(
            session.agentId,
            ((System.currentTimeMillis() - session.startedAt) / 1000).toInt(),
            synchronized(session.events) { session.events.size },
        )
    }

    fun stopTeaching(): Pair<String, String>? {
        val session = teaching ?: return null
        teaching = null
        val events = synchronized(session.events) { session.events.toList() }
        emit(HaloEvent.Teaching(session.agentId, false, 0, events.size))
        if (events.isEmpty()) return null
        return session.agentId to describeTrace(events)
    }

    fun dispose() {
        for ((_, s) in screens) {
            runCatching {
                (s.view.parent as? android.view.ViewGroup)?.removeView(s.view)
                s.view.destroy()
            }
        }
        screens.clear()
    }
}

// ------------------------------------------------------------------ page scripts
//
// These are the desktop build's scripts, unchanged apart from the bridge the recorder reports on.
// The accessible-name computation and the role mapping are what make a snapshot readable by a model,
// and they are not Chromium-specific — a WebView runs the same engine.

private val SNAPSHOT = """(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
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
  const nameOf = (el) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const parts = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean);
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
    const tag = 'g%GEN%e' + n;
    el.setAttribute('data-halo-ref', tag);
    const state = el.checked === true ? ' [checked]' : el.getAttribute('aria-expanded') === 'true' ? ' [expanded]' : '';
    out.push({ ref: 'e' + n, role: role + state, name: name.slice(0, 80), selector: '[data-halo-ref="' + tag + '"]' });
    if (out.length >= 150) break;
  }
  return JSON.stringify({ url: location.href, title: document.title, elements: out });
})()"""

private val READ_PAGE = """(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
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
  return JSON.stringify({ url: location.href, title: document.title, text: text.slice(0, 12000), controls: controls.join('\n') });
})()"""

private fun jsString(value: String): String = JsonPrimitive(value).toString()

private fun actScript(action: String, selector: String, text: String): String = """(() => {
  const want = ${jsString(selector)};
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
  if (!el && want) el = findByText(want.replace(/^["']|["']${'$'}/g, ''));
  if (!el) return 'NOT_FOUND';
  el.scrollIntoView({ block: 'center' });
  if (${jsString(action)} === 'click') {
    el.click();
    return 'clicked ' + (el.tagName || '');
  }
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
  el.focus();
  if (setter && setter.set) { setter.set.call(el, ${jsString(text)}); }
  else { el.textContent = ${jsString(text)}; }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'typed into ' + (el.tagName || '');
})()"""

/**
 * A key press, dispatched in the page.
 *
 * The desktop build sends a real input event to Chromium; a WebView has no equivalent from the app
 * side without synthesising motion events at the wrong layer. Dispatching the keyboard event to the
 * focused element is what the page itself listens for, and for the case this exists to serve —
 * submitting a form with Enter — it also calls `form.requestSubmit()`, which is what the browser
 * would have done.
 */
private fun pressScript(key: String): String = """(() => {
  const key = ${jsString(key)};
  const el = document.activeElement || document.body;
  const opts = { key: key, code: key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  if (key === 'Enter' && el.form && typeof el.form.requestSubmit === 'function') {
    el.form.requestSubmit();
  }
  return 'ok';
})()"""

private val RECORDER = """(() => {
  if (window.__haloRec) return 'already';
  window.__haloRec = true;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
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
      const first = el.className.split(/\s+/).filter(Boolean)[0];
      if (first) return tag + '.' + CSS.escape(first);
    }
    return tag;
  };
  const push = (event) => {
    const full = Object.assign({ at: Date.now(), url: location.href }, event);
    try { HaloRecorder.step(JSON.stringify(full)); } catch (e) {}
  };
  document.addEventListener('click', (ev) => {
    const target = ev.target;
    const el = (target.closest && target.closest('a,button,input,select,[role=button],[role=link],label,summary')) || target;
    push({ kind: 'click', selector: selectorFor(el), text: clean(el.innerText || el.value || '').slice(0, 60) });
  }, true);
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el || !el.matches || !el.matches('input,textarea,select')) return;
    const secret = el.type === 'password';
    push({ kind: 'input', selector: selectorFor(el), value: secret ? '<secret>' : String(el.value || '').slice(0, 120) });
  }, true);
  push({ kind: 'navigate', url: location.href });
  return 'ok';
})()"""
