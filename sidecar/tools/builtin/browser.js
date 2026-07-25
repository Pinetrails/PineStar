/* sidecar/tools/builtin/browser.js - browser automation tools.
   A small CDP-backed browser surface with an injected-driver seam for tests:
   navigate, snapshot, click, type, scroll, back, press, console, dialog,
   get_text, and vision. Element refs are valid only until the next snapshot.

   SECURITY: browser.navigate refuses private/loopback/intranet URLs before
   navigation and validates the final URL after redirects. Mutating actions are
   consent-gated by the same registry/capability path as every other tool. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).browser = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const P = require('node:path');
  const OS = require('node:os');
  const FS = require('node:fs');
  const CP = require('node:child_process');
  const NET = require('node:net');

  const MAX_TEXT = 12000;
  /* AUTO-WAIT (2026-07-25). The whole wait vocabulary used to be three fixed sleeps — navigate 900ms,
     back 500ms, connect-retry 250ms — and click/type/press returned with ZERO settle time. So the
     snapshot after a click read the PRE-CLICK DOM, and any SPA that hydrated past 900ms answered an
     empty page, which the agent reported as "no interactive elements". A fixed sleep is wrong in both
     directions: too short for a slow app, wasted latency on a static one.
     Instead the page tells us when it went quiet. A MutationObserver counts DOM changes; we poll that
     counter and proceed as soon as readyState is complete AND the count has held still across
     SETTLE_QUIET_POLLS polls, giving up at a budget. A static page now settles in ~1 poll (FASTER than
     the old 900ms blind wait) and a slow SPA gets the time it actually needs.
     The page keeps a mutation COUNTER, never a timestamp: the determinism law bans ambient time in
     backend logic, and a counter is the better primitive anyway — the sidecar owns the notion of
     "quiet" (counter unchanged across N consecutive polls) and the page just reports what happened. */
  const SETTLE_POLL_MS = 40;
  const SETTLE_QUIET_POLLS = 3;         // consecutive unchanged polls (~120ms) before we call it settled
  const SETTLE_NAV_BUDGET_MS = 8000;    // ceiling for a navigation/history move
  const SETTLE_ACTION_BUDGET_MS = 3000; // ceiling after click/type/press/scroll
  const SETTLE_BOOTSTRAP = String.raw`(() => {
    if (globalThis.__STARNET_SETTLE__) return;
    const s = { n: 0 };
    try { Object.defineProperty(globalThis, '__STARNET_SETTLE__', { value: s, configurable: false, writable: false }); } catch (e) { return; }
    const bump = () => { s.n++; };
    const observe = () => {
      try { new MutationObserver(bump).observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, characterData: true }); } catch (e) {}
    };
    // addScriptToEvaluateOnNewDocument runs before <html> exists, so defer until there is a root.
    try { if (document.documentElement) observe(); else document.addEventListener('readystatechange', observe, { once: true }); } catch (e) {}
    // A resource landing (or a history move) is a change even when it mutates no nodes.
    try { addEventListener('load', bump); addEventListener('popstate', bump); } catch (e) {}
  })()`;
  // Cheap per-poll read: is the document done, and how many mutations has it seen so far?
  const SETTLE_PROBE = `(() => { const s = globalThis.__STARNET_SETTLE__;
    return { ok: !!s, ready: document.readyState, n: s ? s.n : -1 }; })()`;
  const DEFAULT_PORT = Number(process.env.STARNET_BROWSER_CDP || process.env.SKYNET_BROWSER_CDP || 9347);
  // Installed Chrome's "new" headless mode can still enter the platform pointer-lock path after
  // a CDP click. On Windows that path calls ClipCursor and moves the REAL cursor. Install this
  // bootstrap before every navigation so game code observes a faithful logical lock while the
  // browser never reaches native pointer/keyboard lock. CDP Input.* remains fully synthetic.
  const SYNTHETIC_INPUT_BOOTSTRAP = String.raw`(() => {
    if (globalThis.__STARNET_SYNTHETIC_INPUT__) return;
    const state = { pointer: null, fullscreen: null, keyboard: false, ready: false, popupBlocked: false, error: null };
    let request = null, exit = null, fullscreenRequest = null, fullscreenExit = null, blockedOpen = null, keyboardLock = null, keyboardUnlock = null, wakeRequest = null, orientationLock = null, orientationUnlock = null;
    const attestation = {};
    Object.defineProperties(attestation, {
      pointer: { get: () => state.pointer },
      fullscreen: { get: () => state.fullscreen },
      ready: { get: () => state.ready },
      popupBlocked: { get: () => state.popupBlocked },
      error: { get: () => state.error },
      requestPointerLock: { get: () => request },
      exitPointerLock: { get: () => exit },
      requestFullscreen: { get: () => fullscreenRequest },
      exitFullscreen: { get: () => fullscreenExit },
      blockedOpen: { get: () => blockedOpen },
      keyboardLock: { get: () => keyboardLock },
      keyboardUnlock: { get: () => keyboardUnlock },
      wakeRequest: { get: () => wakeRequest },
      orientationLock: { get: () => orientationLock },
      orientationUnlock: { get: () => orientationUnlock }
    });
    Object.freeze(attestation);
    Object.defineProperty(globalThis, '__STARNET_SYNTHETIC_INPUT__', { value: attestation, configurable: false, writable: false });
    const fire = (name) => queueMicrotask(() => document.dispatchEvent(new Event(name)));
    try {
      request = function () { state.pointer = this; fire('pointerlockchange'); return Promise.resolve(); };
      exit = function () { state.pointer = null; fire('pointerlockchange'); };
      Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: false, get() { return state.pointer; } });
      Object.defineProperty(Element.prototype, 'requestPointerLock', { configurable: false, writable: false, value: request });
      Object.defineProperty(Document.prototype, 'exitPointerLock', { configurable: false, writable: false, value: exit });
      for (const name of ['webkitRequestPointerLock','mozRequestPointerLock']) {
        if (name in Element.prototype) Object.defineProperty(Element.prototype, name, { configurable: false, writable: false, value: request });
      }
      for (const name of ['webkitExitPointerLock','mozExitPointerLock']) {
        if (name in Document.prototype) Object.defineProperty(Document.prototype, name, { configurable: false, writable: false, value: exit });
      }
      for (const name of ['webkitPointerLockElement','mozPointerLockElement']) {
        if (name in Document.prototype) Object.defineProperty(Document.prototype, name, { configurable: false, get() { return state.pointer; } });
      }
      fullscreenRequest = function () { state.fullscreen = this; fire('fullscreenchange'); return Promise.resolve(); };
      fullscreenExit = function () { state.fullscreen = null; fire('fullscreenchange'); return Promise.resolve(); };
      Object.defineProperty(Document.prototype, 'fullscreenElement', { configurable: false, get() { return state.fullscreen; } });
      Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: false, writable: false, value: fullscreenRequest });
      Object.defineProperty(Document.prototype, 'exitFullscreen', { configurable: false, writable: false, value: fullscreenExit });
      for (const name of ['webkitRequestFullscreen','webkitRequestFullScreen','mozRequestFullScreen','msRequestFullscreen']) {
        if (name in Element.prototype) Object.defineProperty(Element.prototype, name, { configurable: false, writable: false, value: fullscreenRequest });
      }
      for (const name of ['webkitExitFullscreen','webkitCancelFullScreen','mozCancelFullScreen','msExitFullscreen']) {
        if (name in Document.prototype) Object.defineProperty(Document.prototype, name, { configurable: false, writable: false, value: fullscreenExit });
      }
      if (navigator.keyboard) {
        keyboardLock = async function () { state.keyboard = true; return undefined; };
        keyboardUnlock = function () { state.keyboard = false; };
        Object.defineProperty(navigator.keyboard, 'lock', { configurable: false, writable: false, value: keyboardLock });
        Object.defineProperty(navigator.keyboard, 'unlock', { configurable: false, writable: false, value: keyboardUnlock });
      }
      if (navigator.wakeLock) {
        wakeRequest = async function (type) {
          let released = false;
          return Object.freeze({ type: String(type || 'screen'), get released() { return released; }, async release() { released = true; }, addEventListener() {}, removeEventListener() {} });
        };
        Object.defineProperty(navigator.wakeLock, 'request', { configurable: false, writable: false, value: wakeRequest });
      }
      if (globalThis.screen && screen.orientation) {
        orientationLock = async function () { return undefined; };
        orientationUnlock = function () {};
        Object.defineProperty(screen.orientation, 'lock', { configurable: false, writable: false, value: orientationLock });
        Object.defineProperty(screen.orientation, 'unlock', { configurable: false, writable: false, value: orientationUnlock });
      }
      // A popup is a new CDP target and would not inherit a target-scoped preload. Local test
      // sessions do not need new browsing contexts, so block them before any synthetic click
      // can carry a user-activation token into an unshimmed page.
      blockedOpen = function () { return null; };
      Object.defineProperty(globalThis, 'open', { configurable: false, writable: false, value: blockedOpen });
      const escapesTarget = (el, override) => {
        const base=document.querySelector&&document.querySelector('base[target]');
        const t=String(override||el&&el.target||base&&base.target||'').trim().toLowerCase();
        return !!t && t !== '_self' && t !== '_top' && t !== '_parent';
      };
      globalThis.addEventListener('click', e => {
        const p=typeof e.composedPath==='function'?e.composedPath():[];
        const el=p.find(x => x instanceof HTMLAnchorElement || x instanceof HTMLAreaElement);
        if(escapesTarget(el)){e.preventDefault();e.stopImmediatePropagation();}
      }, true);
      globalThis.addEventListener('submit', e => {
        const ft=e.submitter&&(e.submitter.formTarget||e.submitter.getAttribute&&e.submitter.getAttribute('formtarget'));
        if(escapesTarget(e.target,ft)){e.preventDefault();e.stopImmediatePropagation();}
      }, true);
      if (globalThis.HTMLFormElement) {
        const nativeSubmit=HTMLFormElement.prototype.submit;
        Object.defineProperty(HTMLFormElement.prototype,'submit',{configurable:false,writable:false,value:function(){
          if(escapesTarget(this)) return undefined;
          return nativeSubmit.call(this);
        }});
      }
      state.popupBlocked = globalThis.open === blockedOpen;
      const aliasesReady = ['webkitRequestPointerLock','mozRequestPointerLock'].every(n => !(n in Element.prototype) || Element.prototype[n] === request)
        && ['webkitExitPointerLock','mozExitPointerLock'].every(n => !(n in Document.prototype) || Document.prototype[n] === exit);
      const keyboardReady = !navigator.keyboard || (navigator.keyboard.lock === keyboardLock && navigator.keyboard.unlock === keyboardUnlock);
      const fullscreenReady = Element.prototype.requestFullscreen === fullscreenRequest && Document.prototype.exitFullscreen === fullscreenExit;
      const wakeReady = !navigator.wakeLock || navigator.wakeLock.request === wakeRequest;
      const orientationReady = !globalThis.screen || !screen.orientation || (screen.orientation.lock === orientationLock && screen.orientation.unlock === orientationUnlock);
      state.ready = Element.prototype.requestPointerLock === request && Document.prototype.exitPointerLock === exit && aliasesReady && fullscreenReady && keyboardReady && wakeReady && orientationReady && state.popupBlocked;
      if (!state.ready) throw new Error('user-control override did not stick');
    } catch (e) {
      state.ready = false;
      state.error = String(e && e.message || e || 'bootstrap failed');
    }
  })();`;
  // Environment-level headless selection. Production runOnce additionally passes forceHeadless,
  // so neither model arguments nor desktop-shell presence can create a window there.
  function headlessRequested(env) {
    env = env || process.env;
    return /^(1|true|yes|on)$/i.test(String(env.STARNET_BROWSER_HEADLESS || env.SKYNET_BROWSER_HEADLESS || ''));
  }
  function playwrightChromes() {
    // ms-playwright caches live under per-user app data with a versioned dir name;
    // scan for them instead of pinning any machine-specific path or revision.
    // Each candidate is tagged headless:true when it is a chrome-headless-shell build
    // (those CANNOT run headed — a headed launch must skip them).
    const roots = [];
    if (process.env.LOCALAPPDATA) roots.push(P.join(process.env.LOCALAPPDATA, 'ms-playwright'));
    roots.push(P.join(OS.homedir(), '.cache', 'ms-playwright'));
    roots.push(P.join(OS.homedir(), 'Library', 'Caches', 'ms-playwright'));
    const out = [];
    for (const root of roots) {
      let dirs = [];
      try { dirs = FS.readdirSync(root); } catch (_) { continue; }
      for (const d of dirs.sort().reverse()) {
        if (/^chromium_headless_shell-\d+$/.test(d)) {
          out.push({ path: P.join(root, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'), headless: true });
          out.push({ path: P.join(root, d, 'chrome-headless-shell-linux', 'headless_shell'), headless: true });
        } else if (/^chromium-\d+$/.test(d)) {
          out.push({ path: P.join(root, d, 'chrome-win64', 'chrome.exe'), headless: false });
          out.push({ path: P.join(root, d, 'chrome-linux', 'chrome'), headless: false });
          out.push({ path: P.join(root, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'), headless: false });
        }
      }
    }
    return out;
  }
  // Candidate list, each tagged whether it is a headless-only binary. Env overrides and
  // real installed browsers are full Chrome (can run headed or headless).
  const CHROME_CANDIDATES = [
    process.env.STARNET_CHROME && { path: process.env.STARNET_CHROME, headless: false },
    process.env.SKYNET_CHROME && { path: process.env.SKYNET_CHROME, headless: false },
    ...playwrightChromes(),
    { path: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false },
    { path: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: false },
    process.env.LOCALAPPDATA && { path: P.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'), headless: false },
    { path: '/usr/bin/google-chrome', headless: false },
    { path: '/usr/bin/chromium-browser', headless: false },
    { path: '/usr/bin/chromium', headless: false },
    { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false }
  ].filter(Boolean);

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  /* A private, per-run CDP endpoint that does NOT announce itself as automation.
     `--remote-debugging-port=0` asks Chromium to pick the port, but Chromium's
     content/child/runtime_features.cc special-cases port 0 and calls
     WebRuntimeFeatures::EnableAutomationControlled(true) — i.e. it sets navigator.webdriver.
     Sites key off that flag; Google refuses sign-in to browsers "being controlled through
     software automation" (support.google.com/accounts/answer/7675428), which would break the
     attended-login takeover for the very human who is supposed to be driving. A NON-zero port
     carries no such flag, and a CDP client attaching later cannot set it (it is a startup-time
     Blink runtime feature). So we do the ephemeral allocation ourselves: bind 127.0.0.1:0, keep
     whatever the OS hands us, release it, and pass that number to Chromium. Same private
     per-run endpoint as before — no process-wide port another agent's run could attach to. */
  function allocateEphemeralPort() {
    return new Promise((resolve, reject) => {
      let srv;
      try { srv = NET.createServer(); } catch (e) { reject(e); return; }
      srv.unref();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const port = addr && addr.port;
        srv.close(() => {
          if (Number.isInteger(port) && port > 0 && port < 65536) resolve(port);
          else reject(new Error('could not allocate a private CDP port'));
        });
      });
    });
  }
  function clamp(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n).trimEnd() + ' ...' : s; }
  /* Embed an agent-supplied VALUE in a fixed page expression as a string literal. JSON.stringify covers
     quotes/backslashes/control chars; U+2028 and U+2029 are legal in JSON but were line terminators in
     JS before ES2019, so they are escaped explicitly rather than trusted to the engine's edition. */
  function jsLiteral(v) {
    var LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
    return JSON.stringify(String(v == null ? '' : v)).split(LS).join('\\u2028').split(PS).join('\\u2029');
  }
  /* Render the main document's real HTTP outcome for the agent. A non-2xx is NOT an error the tool
     throws on — the page may still be worth reading — but the agent must be told, or it will report an
     error page's contents as the answer. A driver that cannot observe the network says nothing. */
  function describeResponse(r) {
    if (!r) return { text: '', summary: '' };
    if (r.failure) return { text: ' — REQUEST FAILED (' + r.failure + ')', summary: ' (failed)' };
    const code = Number(r.status) || 0;
    if (!code) return { text: '', summary: '' };
    if (code >= 200 && code < 300) return { text: ' (HTTP ' + code + ')', summary: ' ' + code };
    return { text: ' — HTTP ' + code + (r.statusText ? ' ' + r.statusText : '') +
             ' (the page below is the server\'s error response, not the content you asked for)', summary: ' ' + code };
  }
  function hostOf(u) {
    let h = u.hostname.toLowerCase();
    if (h.charAt(0) === '[') h = h.slice(1, -1);
    return h;
  }
  function isPrivateV4(h) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;
    const p = h.split('.').map(Number);
    if (p.some(n => n > 255)) return true;
    const a = p[0], b = p[1];
    return a === 0 || a === 127 || a === 10 ||
      (a === 192 && b === 168) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  function isPrivateV6(h) {
    h = String(h).toLowerCase();
    return h === '::1' || h === '::' || /^::ffff:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h);
  }
  function assertSafeUrl(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { throw new Error('invalid URL: ' + raw); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs are allowed');
    const h = hostOf(u);
    const numericHost = /^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h);
    const blockedName = h === 'localhost' || h === '0.0.0.0' || h.endsWith('.localhost') || h.endsWith('.local') ||
      h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.intranet') || h.endsWith('.home') || h.endsWith('.corp');
    const bareName = h.indexOf('.') < 0 && h.indexOf(':') < 0 && !numericHost;
    if (blockedName || bareName || numericHost || isPrivateV4(h) || isPrivateV6(h)) {
      throw new Error('refusing to navigate to private/loopback/intranet host: ' + h);
    }
    return u;
  }
  // Separate from assertSafeUrl: public browsing retains its SSRF boundary. Only the workbench-
  // scoped browser.test_navigate tool may use this validator, and only for an agent's local dev UI.
  function assertLoopbackUrl(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { throw new Error('invalid local test URL: ' + raw); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('local browser tests allow http(s) only');
    const h = hostOf(u);
    if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') {
      throw new Error('local browser tests are restricted to loopback (127.0.0.1/localhost/::1)');
    }
    return u;
  }
  // Resolve a Chrome binary. When wantHeaded is true, PREFER a full Chrome (headless-shell
  // builds can't show a window); only fall back to a headless-shell binary if nothing else
  // exists. Returns { path, headless } where headless=true means "this binary is headless-only,
  // a visible window is impossible" so the caller can report the truth.
  function resolveChrome(wantHeaded, existsSync) {
    existsSync = existsSync || FS.existsSync;
    const exists = (c) => { try { return existsSync(c.path); } catch (_) { return false; } };
    if (wantHeaded) {
      for (const c of CHROME_CANDIDATES) { if (!c.headless && exists(c)) return { path: c.path, headless: false }; }
      // no full Chrome found — fall back to a headless-only binary (window impossible)
      for (const c of CHROME_CANDIDATES) { if (c.headless && exists(c)) return { path: c.path, headless: true }; }
      return null;
    }
    for (const c of CHROME_CANDIDATES) { if (exists(c)) return { path: c.path, headless: c.headless }; }
    return null;
  }
  // Back-compat shim (tests/other callers): return just the path of the first existing binary.
  function findChrome(existsSync) {
    const r = resolveChrome(false, existsSync);
    return r ? r.path : '';
  }

  class CdpClient {
    constructor(ws, timeoutMs) {
      this.ws = ws;
      this.timeoutMs = timeoutMs || 15000;
      this.id = 0;
      this.pending = new Map();
      this.handlers = new Map();
      ws.addEventListener('message', e => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id); this.pending.delete(m.id);
          if (p.timer) clearTimeout(p.timer);
          m.error ? p.reject(new Error(m.error.message || 'CDP error')) : p.resolve(m.result || {});
        } else if (m.method) {
          const hs = this.handlers.get(m.method) || [];
          for (const h of hs) { try { h(m.params || {}); } catch (_) {} }
        }
      });
    }
    send(method, params, sessionId) {
      const id = ++this.id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, this.timeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
        this.pending.set(id, { resolve, reject, timer });
        const message = { id, method, params: params || {} };
        if (sessionId) message.sessionId = sessionId;
        this.ws.send(JSON.stringify(message));
      });
    }
    on(method, fn) {
      const hs = this.handlers.get(method) || [];
      hs.push(fn); this.handlers.set(method, hs);
    }
    close() { try { this.ws.close(); } catch (_) {} }
  }

  function makeCdpDriver(deps) {
    deps = deps || {};
    const fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    const WebSocketImpl = deps.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    const spawn = deps.spawn || CP.spawn;
    // HEADLESS BY DEFAULT (2026-07-07 direction): research must never open a window on the user's screen.
    // A window appears only when the CALL asked for one (deps.headed — browser.navigate visible:true, i.e.
    // the Commander asked to watch) and no headless env pins it down (CI/soak rigs still win). Legacy
    // deps.headless===true keeps forcing headless for injected test rigs.
    const wantHeaded = deps.forceHeadless !== true && !!deps.headed && !headlessRequested(deps.env) && deps.headless !== true;
    // Resolve the binary honoring the headed preference (skip headless-shell when headed).
    let chromePath = deps.chrome || null, binIsHeadlessOnly = false;
    if (!chromePath) {
      const r = resolveChrome(wantHeaded, deps.existsSync);
      if (r) { chromePath = r.path; binIsHeadlessOnly = r.headless; }
    }
    // Production passes cdpPort 0, meaning "give this run its own private endpoint" — a
    // process-wide port can attach to another agent's browser. We honour that request by
    // allocating a NON-zero ephemeral port ourselves (see allocateEphemeralPort): literal 0
    // reaches Chromium as an automation signal and sets navigator.webdriver.
    const cdpPort = deps.cdpPort == null ? DEFAULT_PORT : Number(deps.cdpPort);
    const privatePort = cdpPort === 0;
    const profileDir = deps.profileDir || P.join(OS.tmpdir(), 'starnet-browser-' + process.pid);
    // Stale from a previous run on this profile; cleared so nothing can mistake it for live state.
    const activePortFile = P.join(profileDir, 'DevToolsActivePort');
    const timeoutMs = deps.timeoutMs || 15000;
    // Auto-wait thresholds are injectable so a test can drive the real settle loop (including the
    // budget-exhausted path) without burning the production ceilings in wall-clock time.
    const settleQuietPolls = deps.settleQuietPolls == null ? SETTLE_QUIET_POLLS : Number(deps.settleQuietPolls);
    const settleNavBudgetMs = deps.settleNavBudgetMs == null ? SETTLE_NAV_BUDGET_MS : Number(deps.settleNavBudgetMs);
    const settleActionBudgetMs = deps.settleActionBudgetMs == null ? SETTLE_ACTION_BUDGET_MS : Number(deps.settleActionBudgetMs);
    if (!fetchImpl || !WebSocketImpl) throw new Error('browser unavailable: Node WebSocket/fetch is not available');
    if (!chromePath) throw new Error('browser unavailable: Chromium not found; set STARNET_CHROME');
    // We run headed only if requested AND the chosen binary can actually show a window.
    const headed = wantHeaded && !binIsHeadlessOnly;

    let proc = null, procExited = false, procError = null, procClosePromise = null, cdp = null, consoleLog = [], dialog = null, attachedPort = null;
    /* NETWORK TRUTH. navigate() used to return only location.href, so a 403, a 404 and a page that
       simply rendered nothing were indistinguishable to the agent — it would "read" an error page and
       report its contents as the answer. The Network domain gives the main document's real status, and
       an in-flight request count that makes auto-wait aware of XHR that has not landed yet. */
    let mainFrameId = null, lastResponse = null;
    const inflight = new Set();
    const frameSessions = new Map();   // CDP sessionId -> frameId, for every adopted (out-of-process) iframe
    async function connect() {
      if (cdp) return cdp;
      try { FS.mkdirSync(profileDir, { recursive: true }); } catch (_) {}
      if (privatePort) { try { FS.rmSync(activePortFile, { force: true }); } catch (_) {} }
      // Allocated here, not by Chromium, so the launch carries no automation flag. Chromium still
      // writes the bound port into this profile's DevToolsActivePort, which stays the readiness proof.
      const launchPort = privatePort ? await allocateEphemeralPort() : cdpPort;
      const args = ['--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=' + launchPort, '--window-size=1440,900',
        '--user-data-dir=' + profileDir];
      if (headed) {
        // Visible window the user can watch (and hear — no --mute-audio in headed mode).
        args.push('--new-window');
      } else {
        args.push('--headless=new', '--hide-scrollbars', '--mute-audio');
      }
      args.push('about:blank');
      proc = spawn(chromePath, args, { stdio: 'ignore', windowsHide: !headed });
      procClosePromise = new Promise(resolve => {
        if (proc && proc.on) proc.on('close', () => { procExited = true; resolve(true); });
        else resolve(true);
        if (proc && proc.on) proc.on('error', e => { procError = (e && e.message) || String(e); procExited = true; resolve(true); });
      });
      // proc-ledger: a force-killed sidecar can't run close() — record the browser so the next boot's sweep
      // reaps it. The unique profile dir is the identity token, so PID reuse (or the user's OWN Chrome,
      // same exe) never matches and is never killed.
      try {
        if (deps.ledger && proc && proc.pid) {
          const pid = proc.pid;
          deps.ledger.record({ pid, cmd: chromePath + ' --user-data-dir=' + profileDir, kind: 'browser' });
          if (proc.on) proc.on('close', () => { try { deps.ledger.release(pid); } catch (_) {} });
        }
      } catch (_) {}
      for (let i = 0; i < 40; i++) {
        if (procExited) throw new Error('spawned Chromium exited before CDP ownership was established' + (procError ? ': ' + procError : ''));
        try {
          // We chose launchPort ourselves, so it IS the endpoint — no DevToolsActivePort read-back.
          // (Chromium only writes that file when IT picked the port; installed Chrome launched on an
          // explicit port may never write it, which would strand the loop.) A successful /json/list
          // on our own private port is the readiness proof.
          const port = launchPort;
          const r = await fetchImpl('http://127.0.0.1:' + port + '/json/list');
          const targets = await r.json();
          const page = targets.find(t => t && t.type === 'page');
          if (page && page.webSocketDebuggerUrl) {
            const ws = new WebSocketImpl(page.webSocketDebuggerUrl);
            await new Promise((resolve, reject) => {
              ws.addEventListener('open', resolve, { once: true });
              ws.addEventListener('error', reject, { once: true });
            });
            cdp = new CdpClient(ws, timeoutMs);
            attachedPort = port;
            if (deps.syntheticInputOnly !== false) {
              // New page targets do not inherit a target-scoped preload. Pause every related
              // target before its scripts run and close popups; inject the same shim into any
              // out-of-process iframe before resuming it.
              cdp.on('Target.attachedToTarget', p => {
                const info = p.targetInfo || {}, sid = p.sessionId;
                if (!sid) return;
                if (info.type === 'page') {
                  Promise.resolve(cdp.send('Target.closeTarget', { targetId: info.targetId })).catch(() => {});
                  return;
                }
                if (info.type !== 'iframe') {
                  // Workers have no DOM/input APIs. Resume them untouched so physics/service
                  // workers keep working; only DOM-capable targets need the preload.
                  Promise.resolve(cdp.send('Runtime.runIfWaitingForDebugger', {}, sid)).catch(() => {});
                  return;
                }
                Promise.resolve()
                  .then(() => cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SYNTHETIC_INPUT_BOOTSTRAP }, sid))
                  .then(() => cdp.send('Runtime.evaluate', { expression: SYNTHETIC_INPUT_BOOTSTRAP, awaitPromise: true }, sid))
                  .then(() => cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SETTLE_BOOTSTRAP }, sid))
                  .then(() => cdp.send('Runtime.evaluate', { expression: SETTLE_BOOTSTRAP }, sid))
                  // Remember the adopted frame. It was already attached and shimmed, but nothing ever
                  // recorded its session, so snapshot/get_text could never look inside it: a login form
                  // in an Auth0/Okta/Stripe iframe, or a consent banner, was simply invisible.
                  .then(() => { if (info.targetId) frameSessions.set(sid, info.targetId); })
                  .then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, sid))
                  .catch(() => { if (info.targetId) cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {}); });
              });
              cdp.on('Target.detachedFromTarget', p => { if (p && p.sessionId) frameSessions.delete(p.sessionId); });
              await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
            }
            await cdp.send('Page.enable');
            await cdp.send('Runtime.enable');
            if (deps.syntheticInputOnly !== false) {
              // Install for all future documents AND the current about:blank. A page click can
              // now satisfy its logical pointer-lock contract without touching Win32 ClipCursor.
              await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SYNTHETIC_INPUT_BOOTSTRAP });
              await cdp.send('Runtime.evaluate', { expression: SYNTHETIC_INPUT_BOOTSTRAP, awaitPromise: true });
            }
            // The settle marker is measurement, not a security shim, so it installs UNCONDITIONALLY —
            // auto-wait must still work on a rig that disabled the synthetic-input isolation.
            await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SETTLE_BOOTSTRAP });
            await cdp.send('Runtime.evaluate', { expression: SETTLE_BOOTSTRAP });
            await cdp.send('Network.enable');
            await cdp.send('DOM.enable');   // getFrameOwner/getBoxModel, for placing iframe content in the top page
            // Identify the top frame so a sub-frame's document response can never be mistaken for the
            // page's own status (an ad iframe 404 must not read as "the page 404'd").
            try {
              const tree = await cdp.send('Page.getFrameTree');
              mainFrameId = (tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id) || null;
            } catch (_) { mainFrameId = null; }
            /* DOWNLOADS INTO THE JAIL. The Chrome profile lives in OS.tmpdir(), outside WORKSPACES, so
               anything the agent downloaded landed where it could not read it back — the bytes were
               unreachable even by accident. Point Chrome at the agent's own downloads/ directory.
               Browser.setDownloadBehavior is browser-scoped and not always accepted on a page
               connection; Page.setDownloadBehavior is the deprecated page-scoped equivalent. Try both. */
            if (deps.downloadDir) {
              try { FS.mkdirSync(deps.downloadDir, { recursive: true }); } catch (_) {}
              const behavior = { behavior: 'allow', downloadPath: deps.downloadDir };
              try { await cdp.send('Browser.setDownloadBehavior', Object.assign({ eventsEnabled: true }, behavior)); }
              catch (_) { try { await cdp.send('Page.setDownloadBehavior', behavior); } catch (_) {} }
            }
            cdp.on('Network.requestWillBeSent', p => { if (p && p.requestId) inflight.add(p.requestId); });
            cdp.on('Network.loadingFinished', p => { if (p && p.requestId) inflight.delete(p.requestId); });
            cdp.on('Network.responseReceived', p => {
              if (!p || p.type !== 'Document') return;
              if (mainFrameId && p.frameId && p.frameId !== mainFrameId) return;
              const r = p.response || {};
              lastResponse = { status: Number(r.status) || 0, statusText: r.statusText || '', url: r.url || '', mimeType: r.mimeType || '', failure: null };
            });
            cdp.on('Network.loadingFailed', p => {
              if (!p) return;
              if (p.requestId) inflight.delete(p.requestId);
              // A transport-level failure (DNS, refused, cert) never produces a response at all.
              if (p.type === 'Document') lastResponse = { status: 0, statusText: '', url: '', mimeType: '', failure: p.errorText || 'request failed' };
            });
            cdp.on('Runtime.consoleAPICalled', p => {
              const text = (p.args || []).map(a => a.value != null ? a.value : (a.description || a.type || '')).join(' ');
              consoleLog.push({ type: p.type || 'log', text: clamp(text, 500) });
              if (consoleLog.length > 200) consoleLog = consoleLog.slice(-200);
            });
            cdp.on('Page.javascriptDialogOpening', p => { dialog = { type: p.type || 'alert', message: p.message || '' }; });
            return cdp;
          }
        } catch (_) {}
        await sleep(250);
      }
      throw new Error('browser unavailable: could not attach to Chromium');
    }
    async function evalJS(expression) {
      const c = await connect();
      const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('page eval failed: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || 'exception'));
      return r.result && r.result.value;
    }
    /* Wait for the page to go quiet. Returns true if it genuinely settled, false if the budget ran out
       or the settle marker was unavailable (a page that blocked the bootstrap, or a bare CDP endpoint).
       NEVER throws and NEVER waits past the budget: a wait helper that can hang would be worse than the
       fixed sleeps it replaces. `fallbackMs` is the legacy blind sleep used only when we cannot measure. */
    async function waitForSettle(c, opts) {
      opts = opts || {};
      const quietPolls = opts.quietPolls == null ? settleQuietPolls : opts.quietPolls;
      const budgetMs = opts.budgetMs || settleActionBudgetMs;
      // The budget is a TIMER, not a clock read — determinism law bans ambient time in backend logic,
      // and a timer expresses "stop waiting" just as well.
      let expired = false;
      const timer = setTimeout(() => { expired = true; }, budgetMs);
      try {
        let lastN = null, stable = 0;
        for (;;) {
          let probe = null;
          try {
            const r = await c.send('Runtime.evaluate', { expression: SETTLE_PROBE, returnByValue: true });
            probe = r && r.result && r.result.value;
          } catch (_) { probe = null; }
          // Marker absent (or a non-object answer from a stub endpoint): we cannot measure quiescence.
          if (!probe || typeof probe !== 'object' || probe.ok !== true) {
            const fb = Number(opts.fallbackMs || 0);
            if (fb > 0) await sleep(fb);
            return false;
          }
          stable = (lastN !== null && probe.n === lastN) ? stable + 1 : 0;
          lastN = probe.n;
          // A quiet DOM is not proof of a quiet page: an XHR can still be in flight with nothing
          // rendered yet. Wait for the network too — but a long-poll/SSE/websocket connection never
          // finishes, so a much longer run of DOM stillness releases us regardless.
          const netIdle = inflight.size === 0;
          if (probe.ready === 'complete' && stable >= quietPolls && (netIdle || stable >= quietPolls * 3)) return true;
          if (expired) return false;                  // spend the budget, then proceed with what we have
          await sleep(SETTLE_POLL_MS);
        }
      } finally { clearTimeout(timer); }
    }
    async function navigate(url) {
      const c = await connect();
      lastResponse = null;   // this navigation's status, never the previous page's
      await c.send('Page.navigate', { url });
      await waitForSettle(c, { budgetMs: settleNavBudgetMs, fallbackMs: 900 });
      const finalUrl = await evalJS('location.href');
      if (deps.syntheticInputOnly !== false) {
        const isolation = await evalJS(`(() => {
          const s=globalThis.__STARNET_SYNTHETIC_INPUT__;
           const rd=Object.getOwnPropertyDescriptor(Element.prototype,'requestPointerLock');
           const ed=Object.getOwnPropertyDescriptor(Document.prototype,'exitPointerLock');
           const fd=Object.getOwnPropertyDescriptor(Element.prototype,'requestFullscreen');
           const fe=Object.getOwnPropertyDescriptor(Document.prototype,'exitFullscreen');
           const od=Object.getOwnPropertyDescriptor(globalThis,'open');
          const kd=navigator.keyboard&&Object.getOwnPropertyDescriptor(navigator.keyboard,'lock');
          const ku=navigator.keyboard&&Object.getOwnPropertyDescriptor(navigator.keyboard,'unlock');
           const pointerReady=!!(s&&rd&&ed&&rd.value===s.requestPointerLock&&ed.value===s.exitPointerLock&&rd.writable===false&&ed.writable===false&&rd.configurable===false&&ed.configurable===false);
           const fullscreenReady=!!(s&&fd&&fe&&fd.value===s.requestFullscreen&&fe.value===s.exitFullscreen&&fd.writable===false&&fe.writable===false&&fd.configurable===false&&fe.configurable===false);
           const popupReady=!!(s&&od&&od.value===s.blockedOpen&&od.writable===false&&od.configurable===false);
           const keyboardReady=!navigator.keyboard||!!(kd&&ku&&kd.value===s.keyboardLock&&ku.value===s.keyboardUnlock&&kd.writable===false&&ku.writable===false&&kd.configurable===false&&ku.configurable===false);
           const wakeReady=!navigator.wakeLock||navigator.wakeLock.request===s.wakeRequest;
           const orientationReady=!globalThis.screen||!screen.orientation||(screen.orientation.lock===s.orientationLock&&screen.orientation.unlock===s.orientationUnlock);
           return {ready:!!(s&&s.ready&&pointerReady&&fullscreenReady&&popupReady&&keyboardReady&&wakeReady&&orientationReady),error:s&&s.error||null};
        })()`);
        if (!isolation || isolation.ready !== true) {
          // Fail closed before the caller can dispatch a click/user gesture. Pointer lock cannot
          // normally activate without that gesture, so an unsuccessful shim never gets driven.
          try { await c.send('Page.navigate', { url: 'about:blank' }); } catch (_) {}
          throw new Error('synthetic input isolation failed to install: ' + ((isolation && isolation.error) || 'unknown bootstrap failure'));
        }
      }
      return finalUrl;
    }
    /* Where an adopted iframe sits in the TOP page. Elements inside a frame report coordinates relative
       to that frame, so without this offset every click into an iframe would land somewhere else. If the
       offset cannot be determined the frame's elements are OMITTED rather than offered at coordinates we
       know are wrong — an invisible element is a gap, a mis-aimed one is a wrong action. */
    async function frameOffset(c, frameId) {
      try {
        const owner = await c.send('DOM.getFrameOwner', { frameId });
        if (!owner || !owner.backendNodeId) return null;
        const box = await c.send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
        const quad = box && box.model && box.model.content;
        if (!quad || quad.length < 2) return null;
        return { x: Math.round(quad[0]), y: Math.round(quad[1]) };
      } catch (_) { return null; }
    }
    async function evalIn(c, expression, sessionId) {
      try {
        const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (r && r.exceptionDetails) return null;
        return r && r.result && r.result.value;
      } catch (_) { return null; }
    }
    async function snapshot(limit) {
      const c = await connect();
      const cap = Math.max(1, Math.min(200, Number(limit || 80)));
      const expr = snapshotExpr(cap);
      const out = (await evalIn(c, expr)) || [];
      let frameNo = 0;
      for (const [sid, frameId] of frameSessions) {
        if (out.length >= cap) break;
        frameNo++;
        const off = await frameOffset(c, frameId);
        if (!off) continue;
        const nodes = (await evalIn(c, expr, sid)) || [];
        for (const n of nodes) {
          if (out.length >= cap) break;
          out.push(Object.assign({}, n, { x: n.x + off.x, y: n.y + off.y, frame: frameNo }));
        }
      }
      return out.map((n, i) => Object.assign({}, n, { index: i }));
    }
    function snapshotExpr(cap) {
      return `(() => {
        const q = 'a,button,input,textarea,select,[role="button"],[onclick],summary,label';
        return Array.from(document.querySelectorAll(q)).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && r.bottom >= 0 && r.right >= 0 && r.top <= innerHeight && r.left <= innerWidth;
        }).slice(0, ${cap}).map((el, i) => {
          const r = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' || tag === 'textarea' ? 'textbox' : tag);
          const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
          return { index: i, role, text, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        });
      })()`;
    }
    // Every mutating action settles before it returns, so the NEXT snapshot/get_text reads the DOM the
    // action produced rather than the one it replaced. This is the fix for the silent corrupter: these
    // three used to return with zero settle time.
    function center(node) {
      return { x: node.x + Math.max(1, Math.floor(node.w / 2)), y: node.y + Math.max(1, Math.floor(node.h / 2)) };
    }
    async function click(node) {
      const c = await connect();
      const x = node.x + Math.max(1, Math.floor(node.w / 2));
      const y = node.y + Math.max(1, Math.floor(node.h / 2));
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      return 'clicked';
    }
    async function type(node, text) {
      await click(node);
      const c = await connect();
      await c.send('Input.insertText', { text: String(text || '') });
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      return 'typed';
    }
    async function press(key) {
      const c = await connect();
      key = String(key || 'Enter');
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
      // Enter/Escape routinely submit or dismiss, so a keypress gets a navigation-sized budget.
      await waitForSettle(c, { budgetMs: settleNavBudgetMs });
      return 'pressed ' + key;
    }
    /* Hover is not a nicety: menus, tooltips and disclosure widgets render their real targets only on
       mouseover, so without it whole navigations are unreachable from a snapshot. */
    async function hover(node) {
      const c = await connect();
      const p = center(node);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      return 'hovered';
    }
    /* HTML5 drag-and-drop needs intermediate move events — a press/release pair at two points is
       ignored by every library that listens for dragover. */
    async function drag(from, to) {
      const c = await connect();
      const a = center(from), b = center(to);
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        await c.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', button: 'left',
          x: Math.round(a.x + (b.x - a.x) * i / steps),
          y: Math.round(a.y + (b.y - a.y) * i / steps)
        });
      }
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      return 'dragged';
    }
    /* A <select> cannot be driven by synthetic clicks — the popup is native chrome, outside the page.
       Set the value and fire the events a framework listens for. The agent supplies only a VALUE, never
       code: it is embedded as a JS string literal, so no page script can be composed from tool input. */
    async function selectOption(node, value) {
      const p = center(node);
      const lit = jsLiteral(value);
      const r = await evalJS(`(() => {
        const el = document.elementFromPoint(${p.x}, ${p.y});
        const sel = el && (el.tagName === 'SELECT' ? el : el.closest && el.closest('select'));
        if (!sel) return { ok: false, reason: 'no <select> at this ref' };
        const want = ${lit};
        const opts = Array.from(sel.options || []);
        const hit = opts.find(o => o.value === want) || opts.find(o => (o.label || o.text || '').trim() === want);
        if (!hit) return { ok: false, reason: 'no option matching ' + JSON.stringify(want), options: opts.slice(0, 40).map(o => o.value) };
        sel.value = hit.value;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: hit.value, label: (hit.label || hit.text || '').trim() };
      })()`);
      await waitForSettle(await connect(), { budgetMs: settleActionBudgetMs });
      return r;
    }
    /* The viewport was pinned to the launch flag --window-size=1440,900, so mobile layouts and
       responsive breakpoints were simply unreachable. */
    async function viewport(width, height, opts) {
      opts = opts || {};
      const c = await connect();
      await c.send('Emulation.setDeviceMetricsOverride', {
        width: Math.max(1, Math.round(Number(width) || 0)),
        height: Math.max(1, Math.round(Number(height) || 0)),
        deviceScaleFactor: Number(opts.scale) > 0 ? Number(opts.scale) : 1,
        mobile: opts.mobile === true
      });
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      return Math.round(Number(width) || 0) + 'x' + Math.round(Number(height) || 0);
    }
    async function forward() {
      await evalJS('history.forward()');
      await waitForSettle(await connect(), { budgetMs: settleNavBudgetMs, fallbackMs: 500 });
      return evalJS('location.href');
    }
    /* FILE UPLOAD. Without DOM.setFileInputFiles any form with an attachment step is a dead end.
       The ref usually points at a styled LABEL, because real file inputs are routinely hidden — so
       resolve from the click point to the actual <input type=file> (self, the label's control, or the
       nearest one in the same container) and hand CDP that element's objectId. Paths are resolved and
       jail-checked by the caller; this only ever sees absolute paths. */
    async function upload(node, absPaths) {
      const c = await connect();
      await c.send('DOM.enable');
      const p = center(node);
      const r = await c.send('Runtime.evaluate', { expression: `(() => {
        const el = document.elementFromPoint(${p.x}, ${p.y});
        if (!el) return null;
        if (el.tagName === 'INPUT' && el.type === 'file') return el;
        if (el.control && el.control.tagName === 'INPUT' && el.control.type === 'file') return el.control;
        const lbl = el.closest && el.closest('label');
        if (lbl && lbl.control && lbl.control.type === 'file') return lbl.control;
        const scope = (el.closest && el.closest('form,fieldset,section,div')) || document;
        return scope.querySelector('input[type=file]');
      })()` });
      const objectId = r && r.result && r.result.objectId;
      if (!objectId) throw new Error('no file input found at this ref — snapshot the page and pick the upload control');
      await c.send('DOM.setFileInputFiles', { files: absPaths, objectId });
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      return absPaths.length + ' file(s) attached';
    }
    async function testInput(action) {
      const a = Object.assign({}, action || {});
      const c = await connect();
      const kind = String(a.action || '');
      const code = String(a.key || a.code || '');
      const key = code.indexOf('Key') === 0 ? code.slice(3).toLowerCase()
        : code.indexOf('Digit') === 0 ? code.slice(5) : (code || '');
      if (kind === 'key_down' || kind === 'key_up') {
        await c.send('Input.dispatchKeyEvent', { type: kind === 'key_down' ? 'keyDown' : 'keyUp', key, code });
        return kind + ' ' + code;
      }
      if (kind === 'key_press') {
        await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code });
        await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
        if (/^Escape$/i.test(code || key)) await evalJS('document.exitPointerLock()');
        return 'key_press ' + code;
      }
      const x = Number(a.x) || 0, y = Number(a.y) || 0;
      const button = String(a.button || 'left');
      if (kind === 'mouse_move' && (a.dx != null || a.dy != null)) {
        // Pointer lock is emulated, so synthesize relative motion in the page realm. The game
        // receives movementX/Y while no platform cursor exists to confine or warp.
        const dx = Number(a.dx) || 0, dy = Number(a.dy) || 0;
        await evalJS(`(() => {
          const s=globalThis.__STARNET_SYNTHETIC_INPUT__;
          if(!s||!s.ready) throw new Error('synthetic input isolation is not active');
          const e=new MouseEvent('mousemove',{bubbles:true,clientX:${JSON.stringify(x)},clientY:${JSON.stringify(y)}});
          Object.defineProperty(e,'movementX',{value:${JSON.stringify(dx)}});
          Object.defineProperty(e,'movementY',{value:${JSON.stringify(dy)}});
          (s.pointer||document).dispatchEvent(e);
        })()`);
        return 'mouse_move relative ' + dx + ',' + dy;
      }
      if (kind === 'mouse_move') {
        await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
        return 'mouse_move ' + x + ',' + y;
      }
      if (kind === 'mouse_down' || kind === 'mouse_up') {
        await c.send('Input.dispatchMouseEvent', { type: kind === 'mouse_down' ? 'mousePressed' : 'mouseReleased', x, y, button, clickCount: 1 });
        return kind + ' ' + button;
      }
      if (kind === 'click') {
        await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
        await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
        return 'click ' + x + ',' + y;
      }
      throw new Error('unsupported synthetic browser input action: ' + kind);
    }
    async function testEval(expression) { return evalJS(String(expression || '')); }
    async function testState(selector) {
      const sel = selector == null ? 'null' : JSON.stringify(String(selector));
      return evalJS(`(() => {
        const s=globalThis.__STARNET_SYNTHETIC_INPUT__;
        const q=${sel}; const el=q?document.querySelector(q):null;
        let element=null;
        if(q){
          const r=el&&el.getBoundingClientRect();
          element={exists:!!el,tag:el&&el.tagName||null,text:el&&String(el.innerText||el.textContent||'').trim().slice(0,4000),value:el&&'value'in el?String(el.value).slice(0,1000):null,visible:!!(r&&r.width>0&&r.height>0),className:el&&String(el.className||'').slice(0,1000)};
        }
        return {url:location.href,title:document.title,syntheticReady:!!(s&&s.ready),popupBlocked:!!(s&&s.popupBlocked),pointerLockTag:document.pointerLockElement&&document.pointerLockElement.tagName||null,element};
      })()`);
    }
    // Scrolling is what triggers lazy-load / infinite-scroll, so it settles too — otherwise the very
    // content the scroll was meant to reveal is missing from the next snapshot.
    async function scroll(x, y) {
      await evalJS('window.scrollBy(' + (Number(x) || 0) + ',' + (Number(y) || 0) + ')');
      await waitForSettle(await connect(), { budgetMs: settleActionBudgetMs });
      return 'scrolled';
    }
    async function back() {
      await evalJS('history.back()');
      await waitForSettle(await connect(), { budgetMs: settleNavBudgetMs, fallbackMs: 500 });
      return evalJS('location.href');
    }
    async function getText(selector) {
      const sel = selector ? jsLiteral(String(selector)) : 'null';
      const expr = `(() => { const el = ${sel} ? document.querySelector(${sel}) : document.body; return (el && (el.innerText || el.textContent) || '').replace(/\\s+\\n/g, '\\n').trim(); })()`;
      const c = await connect();
      const parts = [String((await evalIn(c, expr)) || '')];
      // Read adopted iframes too. A consent wall, a payment form or an SSO login is routinely the
      // ONLY meaningful text on the page and lives entirely inside a frame — reading just the top
      // document returns an empty-looking page and the agent concludes there is nothing there.
      let frameNo = 0;
      for (const [sid] of frameSessions) {
        frameNo++;
        const t = String((await evalIn(c, expr, sid)) || '').trim();
        if (t) parts.push('\n--- frame ' + frameNo + ' ---\n' + t);
      }
      return parts.join('').trim();
    }
    async function handleDialog(action, promptText) {
      const c = await connect();
      await c.send('Page.handleJavaScriptDialog', { accept: action !== 'dismiss', promptText: promptText || '' });
      const d = dialog; dialog = null; return d || { type: 'none', message: '' };
    }
    async function screenshot() {
      const c = await connect();
      const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      return r.data || '';
    }
    async function close() {
      const owned = proc, waitForClose = procClosePromise;
      try { cdp && cdp.close(); } catch (_) {}
      try { owned && owned.kill('SIGKILL'); } catch (_) {}
      cdp = null; proc = null;
      if (owned && waitForClose) {
        let timer;
        const timed = new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); if (timer.unref) timer.unref(); });
        const exited = await Promise.race([waitForClose, timed]);
        clearTimeout(timer);
        if (!exited) throw new Error('owned Chromium did not exit after synthetic test session closed');
      }
      if (deps.cleanupProfile === true) { try { FS.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {} }
    }
    // visible() is the TRUTH the model reports: true only if the controlled window is
    // actually on the user's screen. Headless mode, or a headless-only binary fallback in
    // a headed request, both read as not visible.
    function visible() { return headed; }
    return { navigate, snapshot, click, type, press, hover, drag, selectOption, viewport, forward, upload, testInput, testEval, testState, scroll, back, getText, handleDialog, screenshot, close, consoleLog: () => consoleLog.slice(), lastDialog: () => dialog, lastResponse: () => lastResponse, visible, headed, headlessFallback: wantHeaded && binIsHeadlessOnly, attachedPort: () => attachedPort, profileDir };
  }

  function makeBrowserSession(deps) {
    deps = deps || {};
    let driver = deps.driver || null;
    const injected = !!deps.driver;            // a test-injected driver never mode-switches
    const makeDriver = deps.makeDriver || makeCdpDriver;   // seam so tests can observe the headed flag
    let driverHeaded = null;                    // the REAL driver's current mode (null = none yet)
    let version = 0, seq = 0, localMode = false, localOrigin = null;
    const refs = new Map();
    // ATTENDED LOGIN (persistent profile): deps.persistentProfile = { dir, acquire(), release() } names the
    // ONE durable station browser profile (cookies survive run end and sidecar restarts). acquire/release is
    // an in-process single-owner lease supplied by the host — Chrome cannot share a user-data-dir between
    // processes, and one-sidecar-per-save-dir is a hard invariant, so an in-process lease is sufficient.
    // Every run TRIES the persistent profile first (so research runs browse with saved logins) and quietly
    // falls back to the caller's ephemeral profile when another run holds the lease.
    let leaseHeld = false;
    function acquirePersistent() {
      const pp = deps.persistentProfile;
      if (!pp || !pp.dir || typeof pp.acquire !== 'function') return false;
      if (leaseHeld) return true;
      try { leaseHeld = pp.acquire() === true; } catch (_) { leaseHeld = false; }
      return leaseHeld;
    }
    function profileDeps() {
      // cleanupProfile:false is load-bearing — the durable profile must never ride the ephemeral rm on close.
      return acquirePersistent() ? { profileDir: deps.persistentProfile.dir, cleanupProfile: false } : {};
    }
    function releasePersistent() {
      const pp = deps.persistentProfile;
      if (leaseHeld && pp && typeof pp.release === 'function') { try { pp.release(); } catch (_) {} }
      leaseHeld = false;
    }
    /* ensureDriver(wantVisible):
         undefined  -> reuse whatever is running (or start HEADLESS — the default posture).
         false/true -> if the running driver's mode differs, RELAUNCH in the requested mode on the same
                       profile dir (cookies/logins survive the swap). Headless is the default; a visible
                       window exists only while the Commander asked for one. */
    function ensureDriver(wantVisible) {
      const headed = deps.forceHeadless === true ? false
        : (wantVisible === undefined ? (driverHeaded === null ? false : driverHeaded)
          : (!!wantVisible && !headlessRequested(deps.env) && deps.headless !== true));
      if (driver) {
        if (injected || wantVisible === undefined || driverHeaded === headed) return driver;
        try { driver.close(); } catch (_) {}   // mode change -> relaunch (SIGKILL frees the CDP port)
        driver = null;
      }
      driver = makeDriver(Object.assign({}, deps, profileDeps(), { headed }));
      driverHeaded = headed;
      return driver;
    }
    // Tear down the current driver and relaunch with explicit overrides on the SAME persistent profile
    // (cookies survive the swap). Injected test drivers never mode-switch — the flow still runs so the
    // consent contract is testable, but the driver object stays the same.
    function relaunch(overrides) {
      if (injected) return driver;
      if (driver) { try { driver.close(); } catch (_) {} driver = null; }
      driver = makeDriver(Object.assign({}, deps, profileDeps(), overrides));
      driverHeaded = !!overrides.headed;
      version++;   // any element refs belong to the torn-down browser
      return driver;
    }
    function refFor(node) {
      const ref = 'b' + (++seq);
      refs.set(ref, { version, node });
      return ref;
    }
    function requireRef(ref) {
      const r = refs.get(String(ref || ''));
      if (!r) throw new Error('unknown browser ref: ' + ref + ' (take a fresh browser.snapshot)');
      if (r.version !== version) throw new Error('stale browser ref: ' + ref + ' (refs expire after each browser.snapshot)');
      return r.node;
    }
    async function navigate(url, opts) {
      opts = opts || {};
      const local = opts.local === true;
      const validate = local ? assertLoopbackUrl : assertSafeUrl;
      const u = validate(url);
      const d = ensureDriver(local ? false : ('visible' in opts ? !!opts.visible : undefined));
      const finalUrl = await d.navigate(u.href);
      if (finalUrl) {
        try { validate(finalUrl); } catch (e) {
          try { await d.navigate('about:blank'); } catch (_) {}
          throw new Error('blocked unsafe redirect: ' + e.message);
        }
      }
      if (local && new URL(finalUrl || u.href).origin !== u.origin) {
        try { await d.navigate('about:blank'); } catch (_) {}
        throw new Error('blocked local redirect outside the owned server origin');
      }
      localMode = local;
      localOrigin = local ? u.origin : null;
      version++;
      return finalUrl || u.href;
    }
    // A driver predating this accessor (an injected test fake) simply reports no status.
    function lastResponse() {
      const d = driver;
      return (d && typeof d.lastResponse === 'function') ? d.lastResponse() : null;
    }
    async function snapshot(limit) {
      const nodes = await ensureDriver().snapshot(limit);
      version++;
      const out = (nodes || []).map(n => Object.assign({}, n, { ref: refFor(n) }));
      return out;
    }
    async function click(ref) { return ensureDriver().click(requireRef(ref)); }
    async function type(ref, text) { return ensureDriver().type(requireRef(ref), text); }
    async function press(key) { return ensureDriver().press(key); }
    // A driver that predates one of these (an injected fake) says so plainly instead of throwing a
    // TypeError the agent cannot interpret.
    function driverFn(d, name) {
      if (typeof d[name] !== 'function') throw new Error('browser.' + name + ' is unavailable in this driver');
      return d[name].bind(d);
    }
    async function hover(ref) { const d = ensureDriver(); return driverFn(d, 'hover')(requireRef(ref)); }
    async function drag(fromRef, toRef) { const d = ensureDriver(); return driverFn(d, 'drag')(requireRef(fromRef), requireRef(toRef)); }
    async function selectOption(ref, value) { const d = ensureDriver(); return driverFn(d, 'selectOption')(requireRef(ref), value); }
    async function viewport(width, height, opts) {
      const d = ensureDriver();
      const out = await driverFn(d, 'viewport')(width, height, opts || {});
      version++;   // a resize relays the page: every ref from the previous layout is now meaningless
      return out;
    }
    async function forward() { const d = ensureDriver(); version++; return driverFn(d, 'forward')(); }
    async function upload(ref, absPaths) { const d = ensureDriver(); return driverFn(d, 'upload')(requireRef(ref), absPaths); }
    async function requireLocalDriver() {
      if (!localMode) throw new Error('browser.test_input requires browser.test_navigate to a loopback URL first');
      const d = ensureDriver(false);
      if (typeof d.testEval !== 'function') throw new Error('local browser URL verification is unavailable in this driver');
      const href = await d.testEval('location.href');
      let current;
      try { current = assertLoopbackUrl(href); } catch (e) { localMode = false; localOrigin = null; throw new Error('local test page left its owned server: ' + e.message); }
      if (current.origin !== localOrigin) { localMode = false; localOrigin = null; throw new Error('local test page left its owned server origin'); }
      return d;
    }
    async function testInput(action) {
      const d = await requireLocalDriver();
      if (typeof d.testInput !== 'function') throw new Error('synthetic browser input is unavailable in this driver');
      return d.testInput(action || {});
    }
    async function testEval(expression) {
      const d = await requireLocalDriver();
      if (typeof d.testEval !== 'function') throw new Error('local browser evaluation is unavailable in this driver');
      return d.testEval(expression);
    }
    async function testState(selector) {
      const d = await requireLocalDriver();
      if (typeof d.testState !== 'function') throw new Error('local browser state inspection is unavailable in this driver');
      return d.testState(selector);
    }
    async function testSnapshot(limit) { await requireLocalDriver(); return snapshot(limit); }
    async function scroll(x, y) { return ensureDriver().scroll(x, y); }
    async function back() { version++; return ensureDriver().back(); }
    async function getText(selector) { return ensureDriver().getText(selector); }
    async function consoleLog(limit) {
      const list = ensureDriver().consoleLog ? ensureDriver().consoleLog() : [];
      return list.slice(-(limit || 40));
    }
    async function dialog(action, promptText) { return ensureDriver().handleDialog(action || 'accept', promptText || ''); }
    async function screenshot() { return ensureDriver().screenshot(); }
    async function vision(question) {
      const data = await ensureDriver().screenshot();
      const bytes = Math.round(String(data || '').length * 3 / 4);
      // `image` rides along so the caller can PERSIST the analyzed frame — the screenshot used to be
      // handed to the model and dropped, leaving the user unable to check what the agent actually saw.
      if (deps.vision) {
        const answer = await deps.vision({ imageBase64: data, question: question || '' });
        return { ok: true, answer: String(answer == null ? '' : answer), bytes, image: data };
      }
      // No vision provider wired — do NOT fake an answer. Report honestly.
      return { ok: false, bytes, image: data, reason: 'no vision route wired into this run — do not ask the user for an API key; report the screenshot as unavailable' };
    }
    /* ATTENDED LOGIN TAKEOVER: the agent hit a login wall and asks the Commander to sign in THEMSELVES.
       Two live consent asks bracket a headed relaunch on the persistent profile:
         1. permission.prompt tool:'browser.login'      — "open a visible window so you can log in to <host>?"
         2. permission.prompt tool:'browser.login.done' — blocks until the Commander clicks Done (or cancels).
       While the window is up, synthetic-input shims are OFF (the human is driving real Chrome; SSO popups and
       redirects must work) and the agent's driving tools are the ones paused — this function doesn't return
       until the window is torn down and the browser is back to shimmed HEADLESS mode on the same profile.
       Credentials are typed into real Chrome by the human; they never transit the agent or the sidecar.
       Fail-closed inheritance: both asks ride the run's consent channel (auto-deny on timeout/disconnect),
       and env-pinned headless (CI/soak) refuses before any window can appear. */
    async function login(url) {
      const attended = deps.attendedLogin;
      if (!attended || typeof attended.prompt !== 'function') {
        throw new Error('browser.login needs a watched COMMS session — an unattended run cannot open a login window for the Commander');
      }
      if (headlessRequested(deps.env) || deps.headless === true) {
        throw new Error('browser.login unavailable: this host pins the browser headless (STARNET_BROWSER_HEADLESS)');
      }
      const u = assertSafeUrl(url);
      const host = hostOf(u);
      const approved = d => !!d && d !== 'deny';
      if (!approved(await attended.prompt({ tool: 'browser.login', scope: 'execute', argsSummary: host }))) {
        return { status: 'declined', host };
      }
      // The durable profile is what makes the login outlive this run. When a host wires one, contention is a
      // hard stop (logging into a throwaway profile would silently lose the session at run end — dishonest);
      // a host with NO persistent profile still gets a within-run login on its ephemeral profile.
      if (deps.persistentProfile && !acquirePersistent()) {
        throw new Error('the station browser profile is in use by another agent run — retry after it finishes');
      }
      // Headed + real input: forceHeadless is HOST authority for model-driven navigation; this relaunch is
      // human-consented (the prompt above), so it may override it. syntheticInputOnly:false drops the popup
      // block and input shims — SSO login flows need real popups and the human's real pointer.
      const d = relaunch({ headed: true, forceHeadless: false, headless: false, syntheticInputOnly: false });
      localMode = false; localOrigin = null;
      let finalUrl = null;
      try {
        finalUrl = await d.navigate(u.href);
        if (finalUrl) assertSafeUrl(finalUrl);
        const vis = typeof d.visible === 'function' ? d.visible() : true;
        if (!vis) throw new Error('no full Chrome found — only a headless-shell binary, so a visible login window is impossible; install Chrome or set STARNET_CHROME');
      } catch (e) {
        // restore the shimmed headless posture before surfacing the failure
        relaunch({ headed: false });
        throw e;
      }
      const done = approved(await attended.prompt({ tool: 'browser.login.done', scope: 'execute', argsSummary: host }));
      // Done or cancelled, the window closes and research mode resumes on the SAME profile — any cookies the
      // site set during the attempt are already durable.
      relaunch({ headed: false });
      return { status: done ? 'done' : 'unconfirmed', host, url: finalUrl || u.href };
    }
    async function close() {
      try { if (driver && driver.close) await driver.close(); }
      finally { releasePersistent(); }
    }
    // Visibility of the controlled window, for truthful navigate reporting. Only meaningful
    // once a driver exists; an injected test driver may not expose it (default true = don't lie about headless).
    function visible() {
      const d = ensureDriver();
      return typeof d.visible === 'function' ? d.visible() : (d.visible != null ? !!d.visible : true);
    }
    function headlessFallback() {
      const d = driver || null;
      return !!(d && d.headlessFallback);
    }
    function attachedPort() {
      const d = driver || null;
      return d && typeof d.attachedPort === 'function' ? d.attachedPort() : null;
    }
    return { navigate, snapshot, click, type, press, hover, drag, select: selectOption, viewport, forward, upload, testInput, testEval, testState, testSnapshot, scroll, back, getText, consoleLog, dialog, vision, screenshot, login, close, visible, headlessFallback, attachedPort, lastResponse, _internals: { refs, version: () => version, localMode: () => localMode, localOrigin: () => localOrigin, leaseHeld: () => leaseHeld } };
  }

  function makeBrowserTools(deps) {
    deps = deps || {};
    const session = deps.session || makeBrowserSession(deps);
    const allowVisible = deps.allowVisible === true;
    const read = (name, description, schema, run) => ({ name, capability: 'web', impact: 'synthetic-browser', scope: 'read', requiresConsent: false, timeoutMs: 20000, description, schema, run });
    const exec = (name, description, schema, run, consent) => ({ name, capability: 'web', impact: 'synthetic-browser', scope: 'execute', requiresConsent: consent !== false, timeoutMs: 20000, description, schema, run });
    const testRead = (name, description, schema, run) => ({ name, capability: 'workbench', impact: 'synthetic-browser', scope: 'read', requiresConsent: false, timeoutMs: 20000, description, schema, run });
    const testExec = (name, description, schema, run) => ({ name, capability: 'workbench', impact: 'synthetic-browser', scope: 'execute', requiresConsent: false, timeoutMs: 20000, description, schema, run });
    /* SCREENSHOTS WERE WRITE-ONLY. screenshot() had exactly one consumer — vision() — which handed the
       base64 to a model and returned a BYTE COUNT, so the user could never see what the agent saw and
       the agent could never re-examine it. Frames now land in the agent's jailed workspace and emit the
       same `deliverable` event image_generate already uses, so a capture shows up in the station.
       Saving needs the workspace jail; a rig without it degrades to the old capture-only behaviour
       rather than pretending a file exists. */
    const shotFsp = deps.fsp, shotPath = deps.pathMod, shotRoot = deps.root;
    const canSaveShots = !!(shotFsp && shotPath && shotRoot);
    const shotJail = canSaveShots ? require('./fs.js').makeFsTools({ fsp: shotFsp, pathMod: shotPath, root: shotRoot })._internals : null;
    async function saveShot(ctx, b64) {
      if (!canSaveShots) return null;
      const aid = (ctx && ctx.agentId) || 'agent';
      const buffer = Buffer.from(String(b64 || ''), 'base64');
      if (!buffer.length) return null;
      // Content-addressed name: deterministic (no ambient clock/rng — determinism law) and idempotent,
      // so re-capturing an unchanged viewport reuses one file instead of piling up near-duplicates.
      const h = require('node:crypto').createHash('sha1').update(buffer).digest('hex').slice(0, 12);
      const rel = 'shots/shot-' + h + '.png';
      const { abs } = await shotJail.resolveInside(aid, rel);   // throws on jail escape / abs / '..'
      await shotFsp.mkdir(shotPath.dirname(abs), { recursive: true });
      await shotFsp.writeFile(abs, buffer);
      if (ctx && typeof ctx.emit === 'function') {
        const d = { id: 'shot_' + h, agentId: aid, kind: 'image', title: rel };
        if (ctx.room) d.room = ctx.room;
        ctx.emit('deliverable', d);
      }
      return { rel, bytes: buffer.length, viewer: '/api/file?agent=' + encodeURIComponent(aid) + '&path=' + encodeURIComponent(rel) };
    }
    const navProps = { url: { type: 'string' } };
    if (allowVisible) navProps.visible = { type: 'boolean' };
    const localNavRequired = deps.requireOwnedServer === true ? ['url', 'serverId'] : ['url'];
    const tools = [
      read('browser.navigate', 'Navigate the AGENT-CONTROLLED browser to a public http(s) URL. HEADLESS in ordinary agent runs: it never opens a window or uses the user\'s input. Private, loopback, intranet, and unsafe redirects remain refused; use browser.test_navigate for a local dev server.', { type: 'object', required: ['url'], properties: navProps },
        async a => {
          if (a && a.visible === true && !allowVisible) throw new Error('visible browser mode is disabled: this run is headless-only');
          const url = await session.navigate(a.url, ('visible' in (a || {})) ? { visible: a.visible === true } : undefined);
          let vis = true;
          try { vis = session.visible(); } catch (_) {}
          const suffix = vis
            ? ' (visible window on the user\'s screen)'
            : (session.headlessFallback && session.headlessFallback()
              ? ' (headless fallback — no visible window; no full Chrome found, only a headless-shell binary)'
              : ' (headless — not visible to the user)');
          // HONEST STATUS. Without this the agent cannot tell a 403/404 from a page that simply
          // rendered nothing, and will happily read an error page back as the answer.
          const http = describeResponse(session.lastResponse && session.lastResponse());
          return { content: 'Browser navigated to ' + url + http.text + suffix, summary: 'navigated' + http.summary };
        }),
      testRead('browser.test_navigate', 'Open an agent-owned local dev URL (127.0.0.1/localhost/::1 only) in the HEADLESS CDP browser for UI/game testing. In normal runs serverId must name this agent\'s running shell background server. Physical pointer/keyboard locks are emulated inside the page, so they never reach Windows.', { type: 'object', required: localNavRequired, properties: { url: { type: 'string' }, serverId: { type: 'string' } } },
        async (a, ctx) => {
          assertLoopbackUrl(a.url);
          if (deps.requireOwnedServer === true) {
            const owns = typeof deps.ownsLocalUrl === 'function' && await deps.ownsLocalUrl({ url: a.url, serverId: String(a.serverId || ''), agentId: ctx && ctx.agentId, runId: ctx && ctx.runId });
            if (!owns) throw new Error('local test URL is not proven to belong to this agent\'s running background server');
          }
          const url = await session.navigate(a.url, { local: true, visible: false });
          return { content: 'Local browser navigated to ' + url + ' (headless, synthetic-input isolated; physical mouse/keyboard untouched)', summary: 'local test navigated' };
        }),
      testRead('browser.test_snapshot', 'Return interactive elements and coordinates from the current browser.test_navigate page. Refs expire after the next snapshot; use the reported coordinates with browser.test_input.', { type: 'object', properties: { limit: { type: 'number' } } },
        async a => {
          const nodes = await session.testSnapshot((a && a.limit) || 80);
          return { content: nodes.length ? nodes.map(n => '[' + n.ref + '] ' + n.role + (n.text ? ' "' + n.text + '"' : '') + ' @ ' + n.x + ',' + n.y + ' ' + n.w + 'x' + n.h).join('\n') : '(no visible interactive elements)', summary: nodes.length + ' local elements' };
        }),
      testExec('browser.test_input', 'Dispatch synthetic input inside the current browser.test_navigate page through CDP/page events. Key down/up supports holds; relative mouse_move supplies movementX/Y for FPS camera tests. This never moves, clicks, confines, or types through the operating system.', {
        type: 'object', required: ['action'], properties: {
          action: { type: 'string', enum: ['key_down', 'key_up', 'key_press', 'mouse_move', 'mouse_down', 'mouse_up', 'click'] },
          key: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' }, button: { type: 'string' }
        }
      }, async a => ({ content: await session.testInput(a), summary: 'synthetic input' })),
      testRead('browser.test_state', 'Read non-mutating state from the current local test page: URL/title, synthetic-isolation status, logical pointer-lock tag, and optional element text/value/visibility/class. Arbitrary page JavaScript and navigation are not exposed.', { type: 'object', properties: { selector: { type: 'string' } } },
        async a => {
          const value = await session.testState(a && a.selector);
          return { content: JSON.stringify(value == null ? null : value), summary: 'local state' };
        }),
      read('browser.snapshot', 'Return a structured snapshot of visible interactive elements. Element refs expire after the next snapshot.', { type: 'object', properties: { limit: { type: 'number' } } },
        async a => {
          const nodes = await session.snapshot(a.limit || 80);
          // The frame marker matters to the agent: an element inside an iframe belongs to a different
          // document (a payment form, an SSO login), and its coordinates are already translated here.
          const lines = nodes.map(n => n.ref + ' [' + n.role + '] ' + (n.text || '(no text)') + ' @ ' + n.x + ',' + n.y + ' ' + n.w + 'x' + n.h + (n.frame ? ' (iframe ' + n.frame + ')' : ''));
          return { content: lines.join('\n') || 'No visible interactive elements.', summary: nodes.length + ' ref(s)' + (nodes.some(n => n.frame) ? ' (incl. iframes)' : '') };
        }),
      exec('browser.click', 'Click a visible element by ref from the latest browser.snapshot.', { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } } },
        async a => ({ content: await session.click(a.ref), summary: 'clicked' })),
      exec('browser.type', 'Click/focus an element by ref from the latest browser.snapshot, then type text into it.', { type: 'object', required: ['ref', 'text'], properties: { ref: { type: 'string' }, text: { type: 'string' } } },
        async a => ({ content: await session.type(a.ref, a.text), summary: 'typed' })),
      exec('browser.scroll', 'Scroll the page by x/y CSS pixels.', { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        async a => ({ content: await session.scroll(a.x || 0, a.y || 0), summary: 'scrolled' }), false),
      exec('browser.hover', 'Move the pointer over an element by ref from the latest browser.snapshot. Menus, tooltips and disclosure widgets only render their real targets on hover — take a fresh snapshot afterwards to see what appeared.', { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } } },
        async a => ({ content: await session.hover(a.ref), summary: 'hovered' }), false),
      exec('browser.select', 'Choose an option in a <select> dropdown by ref. Pass the option value OR its visible label. A native dropdown cannot be driven by clicking — its popup is browser chrome, not part of the page.', { type: 'object', required: ['ref', 'value'], properties: { ref: { type: 'string' }, value: { type: 'string' } } },
        async a => {
          const r = await session.select(a.ref, a.value);
          if (r && r.ok) return { content: 'Selected "' + (r.label || r.value) + '".', summary: 'selected' };
          const opts = r && r.options && r.options.length ? ' Available values: ' + r.options.join(', ') : '';
          return { content: 'Could not select: ' + ((r && r.reason) || 'unknown') + '.' + opts, summary: 'not selected' };
        }),
      exec('browser.drag', 'Drag one element onto another (both refs from the latest browser.snapshot). Sends the intermediate move events HTML5 drag-and-drop listeners require.', { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } },
        async a => ({ content: await session.drag(a.from, a.to), summary: 'dragged' })),
      exec('browser.viewport', 'Resize the page viewport, e.g. to check a mobile layout (375x812) or a wide desktop one. Element refs from earlier snapshots stop being valid — take a fresh browser.snapshot after resizing.', { type: 'object', required: ['width', 'height'], properties: { width: { type: 'number' }, height: { type: 'number' }, mobile: { type: 'boolean' }, scale: { type: 'number' } } },
        async a => ({ content: 'Viewport is now ' + await session.viewport(a.width, a.height, { mobile: a.mobile === true, scale: a.scale }) + ' — take a fresh browser.snapshot.', summary: 'viewport' }), false),
      exec('browser.forward', 'Go forward in browser history (the counterpart of browser.back).', { type: 'object', properties: {} },
        async () => ({ content: 'Browser moved forward to ' + await session.forward(), summary: 'forward' }), false),
      exec('browser.upload', 'Attach files from your workspace to a file-upload control on the page. "ref" is the upload control (or its visible label) from the latest browser.snapshot; "paths" are workspace-relative files. Submitting the form is a separate click.', { type: 'object', required: ['ref', 'paths'], properties: { ref: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } } },
        async (a, ctx) => {
          if (!canSaveShots) throw new Error('browser.upload needs a workspace; this run has none');
          const aid = (ctx && ctx.agentId) || 'agent';
          const rels = Array.isArray(a.paths) ? a.paths : [a.paths];
          if (!rels.length) throw new Error('browser.upload needs at least one path');
          // Resolve through the SAME jail as fs.* — an upload must never be able to post a file from
          // outside the agent's workspace (resolveInside throws on '..', absolute paths, escapes).
          const abs = [];
          for (const rel of rels) {
            const r = await shotJail.resolveInside(aid, String(rel));
            await shotFsp.stat(r.abs);   // fail loudly here, not silently inside the page
            abs.push(r.abs);
          }
          return { content: await session.upload(a.ref, abs) + ': ' + rels.join(', ') + '. Submit the form when ready.', summary: 'uploaded ' + abs.length };
        }),
      exec('browser.back', 'Go back in browser history.', { type: 'object', properties: {} },
        async () => ({ content: 'Browser went back to ' + await session.back(), summary: 'back' }), false),
      exec('browser.press', 'Press a keyboard key in the browser.', { type: 'object', required: ['key'], properties: { key: { type: 'string' } } },
        async a => ({ content: await session.press(a.key), summary: 'pressed' })),
      read('browser.console', 'Read recent browser console warnings/errors/logs.', { type: 'object', properties: { limit: { type: 'number' } } },
        async a => {
          const rows = await session.consoleLog(a.limit || 40);
          return { content: rows.map(r => '[' + r.type + '] ' + r.text).join('\n') || 'No console messages.', summary: rows.length + ' console row(s)' };
        }),
      exec('browser.dialog', 'Accept or dismiss the current JavaScript dialog.', { type: 'object', properties: { action: { type: 'string' }, promptText: { type: 'string' } } },
        async a => {
          const d = await session.dialog(a.action || 'accept', a.promptText || '');
          return { content: 'Dialog ' + (d.type || 'none') + ': ' + (d.message || ''), summary: 'dialog' };
        }),
      read('browser.get_text', 'Return visible page text, optionally scoped by CSS selector.', { type: 'object', properties: { selector: { type: 'string' } } },
        async a => ({ content: clamp(await session.getText(a.selector || ''), MAX_TEXT), summary: 'text' })),
      // ATTENDED LOGIN: requiresConsent stays false because the flow runs its OWN two-phase live consent
      // (open-window ask + done-wait) — the generic broker card would double-prompt. timeoutMs must outlive
      // both consent waits (each fail-closes on its own CONSENT timer + rendered-ack extension), so the only
      // job of this bound is to stop a wedged flow from pinning the run forever.
      {
        name: 'browser.login', capability: 'web', impact: 'synthetic-browser', scope: 'execute', requiresConsent: false, timeoutMs: 60 * 60 * 1000,
        description: 'Ask the Commander to open a VISIBLE browser window and log in to a site THEMSELVES (their password is typed into real Chrome — it never passes through you; never ask for credentials in chat). Blocks until they finish, then returns to headless mode with the authenticated session. Cookies persist in the station browser profile, so future runs stay signed in. Use only when a site genuinely requires login; works only in a watched COMMS session.',
        schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
        run: async a => {
          const r = await session.login(a.url);
          if (r.status === 'declined') return { content: 'Commander declined to open a login window for ' + r.host + '. Continue without authentication and say what is blocked.', summary: 'login declined' };
          if (r.status === 'unconfirmed') return { content: 'Login window for ' + r.host + ' closed without a Done confirmation. Any cookies the site set were saved to the station profile; verify with browser.navigate whether you are signed in before relying on it.', summary: 'login unconfirmed' };
          return { content: 'Commander finished logging in at ' + r.host + '. The browser is back in headless research mode with the authenticated session — continue with browser.navigate.', summary: 'login done' };
        }
      },
      read('browser.vision', 'Capture the current viewport and answer a question about what is on screen (vision rides the session\'s own model when no dedicated vision key exists — never ask the user for an API key). If no vision route is available this returns a clear "unavailable" result — it never fabricates a description.', { type: 'object', properties: { question: { type: 'string' } } },
        async (a, ctx) => {
          const r = await session.vision(a.question || '');
          // Save the analyzed frame either way: on success so the user can check the model's reading
          // against the actual pixels, and on failure so the capture is not simply thrown away.
          let shot = null;
          try { shot = await saveShot(ctx, r && r.image); } catch (_) { shot = null; }
          const saved = shot ? '\n\nScreenshot saved to ' + shot.rel + '\nView: ' + shot.viewer : '';
          if (r && r.ok) {
            return { content: (r.answer || '(vision model returned no text)') + saved, summary: 'vision' };
          }
          const reason = (r && r.reason) || 'vision model is not configured';
          return { content: 'browser.vision unavailable: ' + reason + ' (captured ' + ((r && r.bytes) || 0) + ' bytes but did not analyze them).' + saved, summary: 'vision unavailable' };
        }),
      read('browser.screenshot', 'Capture the current viewport as a PNG, save it into your workspace, and show it to the user. Use this to prove what a page actually looked like, or to keep a frame you want to refer back to. Returns the saved path; browser.vision is the tool that ANSWERS QUESTIONS about a page.', { type: 'object', properties: {} },
        async (a, ctx) => {
          const data = await session.screenshot();
          if (!data) return { content: 'Screenshot unavailable: this browser driver captured no image.', summary: 'no image' };
          const shot = await saveShot(ctx, data);
          if (!shot) {
            const bytes = Math.round(String(data).length * 3 / 4);
            return { content: 'Captured ' + bytes + ' bytes but this run has no workspace to save into, so the image was discarded.', summary: 'not saved' };
          }
          return {
            content: 'Screenshot saved to ' + shot.rel + ' (' + (shot.bytes / 1024).toFixed(0) + ' KB).\nView: ' + shot.viewer,
            summary: 'shot → ' + shot.rel
          };
        })
    ];
    return { tools, session, register(reg) { tools.forEach(t => reg.register(t)); return reg; }, _internals: { assertSafeUrl, assertLoopbackUrl, isPrivateV4, isPrivateV6, makeBrowserSession, makeCdpDriver, findChrome, resolveChrome, headlessRequested, SYNTHETIC_INPUT_BOOTSTRAP, CHROME_CANDIDATES } };
  }

  return { makeBrowserTools, _internals: { assertSafeUrl, assertLoopbackUrl, isPrivateV4, isPrivateV6, makeBrowserSession, makeCdpDriver, findChrome, resolveChrome, headlessRequested, SYNTHETIC_INPUT_BOOTSTRAP, SETTLE_BOOTSTRAP, SETTLE_PROBE, SETTLE_QUIET_POLLS, describeResponse, jsLiteral, CHROME_CANDIDATES } };
});
