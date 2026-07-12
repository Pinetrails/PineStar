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

  const MAX_TEXT = 12000;
  const DEFAULT_PORT = Number(process.env.STARNET_BROWSER_CDP || process.env.SKYNET_BROWSER_CDP || 9347);
  // Installed Chrome's "new" headless mode can still enter the platform pointer-lock path after
  // a CDP click. On Windows that path calls ClipCursor and moves the REAL cursor. Install this
  // bootstrap before every navigation so game code observes a faithful logical lock while the
  // browser never reaches native pointer/keyboard lock. CDP Input.* remains fully synthetic.
  const SYNTHETIC_INPUT_BOOTSTRAP = String.raw`(() => {
    if (globalThis.__STARNET_SYNTHETIC_INPUT__) return;
    const state = { pointer: null, keyboard: false, ready: false, popupBlocked: false, error: null };
    let request = null, exit = null, blockedOpen = null, keyboardLock = null, keyboardUnlock = null;
    const attestation = {};
    Object.defineProperties(attestation, {
      pointer: { get: () => state.pointer },
      ready: { get: () => state.ready },
      popupBlocked: { get: () => state.popupBlocked },
      error: { get: () => state.error },
      requestPointerLock: { get: () => request },
      exitPointerLock: { get: () => exit },
      blockedOpen: { get: () => blockedOpen },
      keyboardLock: { get: () => keyboardLock },
      keyboardUnlock: { get: () => keyboardUnlock }
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
      if (navigator.keyboard) {
        keyboardLock = async function () { state.keyboard = true; return undefined; };
        keyboardUnlock = function () { state.keyboard = false; };
        Object.defineProperty(navigator.keyboard, 'lock', { configurable: false, writable: false, value: keyboardLock });
        Object.defineProperty(navigator.keyboard, 'unlock', { configurable: false, writable: false, value: keyboardUnlock });
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
      state.ready = Element.prototype.requestPointerLock === request && Document.prototype.exitPointerLock === exit && aliasesReady && keyboardReady && state.popupBlocked;
      if (!state.ready) throw new Error('pointer-lock override did not stick');
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
  function clamp(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n).trimEnd() + ' ...' : s; }
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
    // Production passes port 0 so Chromium allocates a private endpoint and writes it into
    // this run's unique profile. A process-wide port can attach to another agent's browser.
    const cdpPort = deps.cdpPort == null ? DEFAULT_PORT : Number(deps.cdpPort);
    const profileDir = deps.profileDir || P.join(OS.tmpdir(), 'starnet-browser-' + process.pid);
    const activePortFile = P.join(profileDir, 'DevToolsActivePort');
    const timeoutMs = deps.timeoutMs || 15000;
    if (!fetchImpl || !WebSocketImpl) throw new Error('browser unavailable: Node WebSocket/fetch is not available');
    if (!chromePath) throw new Error('browser unavailable: Chromium not found; set STARNET_CHROME');
    // We run headed only if requested AND the chosen binary can actually show a window.
    const headed = wantHeaded && !binIsHeadlessOnly;

    let proc = null, procExited = false, procError = null, procClosePromise = null, cdp = null, consoleLog = [], dialog = null, attachedPort = null;
    async function connect() {
      if (cdp) return cdp;
      try { FS.mkdirSync(profileDir, { recursive: true }); } catch (_) {}
      if (cdpPort === 0) { try { FS.rmSync(activePortFile, { force: true }); } catch (_) {} }
      const args = ['--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=' + cdpPort, '--window-size=1440,900',
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
          let port = cdpPort;
          if (port === 0) {
            const line = String(FS.readFileSync(activePortFile, 'utf8') || '').split(/\r?\n/)[0];
            port = Number(line);
            if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid private CDP port');
          }
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
                  .then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, sid))
                  .catch(() => { if (info.targetId) cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {}); });
              });
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
    async function navigate(url) {
      const c = await connect();
      await c.send('Page.navigate', { url });
      await sleep(900);
      const finalUrl = await evalJS('location.href');
      if (deps.syntheticInputOnly !== false) {
        const isolation = await evalJS(`(() => {
          const s=globalThis.__STARNET_SYNTHETIC_INPUT__;
          const rd=Object.getOwnPropertyDescriptor(Element.prototype,'requestPointerLock');
          const ed=Object.getOwnPropertyDescriptor(Document.prototype,'exitPointerLock');
          const od=Object.getOwnPropertyDescriptor(globalThis,'open');
          const kd=navigator.keyboard&&Object.getOwnPropertyDescriptor(navigator.keyboard,'lock');
          const ku=navigator.keyboard&&Object.getOwnPropertyDescriptor(navigator.keyboard,'unlock');
          const pointerReady=!!(s&&rd&&ed&&rd.value===s.requestPointerLock&&ed.value===s.exitPointerLock&&rd.writable===false&&ed.writable===false&&rd.configurable===false&&ed.configurable===false);
          const popupReady=!!(s&&od&&od.value===s.blockedOpen&&od.writable===false&&od.configurable===false);
          const keyboardReady=!navigator.keyboard||!!(kd&&ku&&kd.value===s.keyboardLock&&ku.value===s.keyboardUnlock&&kd.writable===false&&ku.writable===false&&kd.configurable===false&&ku.configurable===false);
          return {ready:!!(s&&s.ready&&pointerReady&&popupReady&&keyboardReady),error:s&&s.error||null};
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
    async function snapshot(limit) {
      return evalJS(`(() => {
        const q = 'a,button,input,textarea,select,[role="button"],[onclick],summary,label';
        return Array.from(document.querySelectorAll(q)).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && r.bottom >= 0 && r.right >= 0 && r.top <= innerHeight && r.left <= innerWidth;
        }).slice(0, ${Math.max(1, Math.min(200, Number(limit || 80)))}).map((el, i) => {
          const r = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' || tag === 'textarea' ? 'textbox' : tag);
          const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
          return { index: i, role, text, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        });
      })()`);
    }
    async function click(node) {
      const c = await connect();
      const x = node.x + Math.max(1, Math.floor(node.w / 2));
      const y = node.y + Math.max(1, Math.floor(node.h / 2));
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      return 'clicked';
    }
    async function type(node, text) {
      await click(node);
      const c = await connect();
      await c.send('Input.insertText', { text: String(text || '') });
      return 'typed';
    }
    async function press(key) {
      const c = await connect();
      key = String(key || 'Enter');
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
      return 'pressed ' + key;
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
    async function scroll(x, y) { await evalJS('window.scrollBy(' + (Number(x) || 0) + ',' + (Number(y) || 0) + ')'); return 'scrolled'; }
    async function back() { await evalJS('history.back()'); await sleep(500); return evalJS('location.href'); }
    async function getText(selector) {
      const sel = selector ? JSON.stringify(String(selector)) : 'null';
      return evalJS(`(() => { const el = ${sel} ? document.querySelector(${sel}) : document.body; return (el && (el.innerText || el.textContent) || '').replace(/\\s+\\n/g, '\\n').trim(); })()`);
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
    return { navigate, snapshot, click, type, press, testInput, testEval, testState, scroll, back, getText, handleDialog, screenshot, close, consoleLog: () => consoleLog.slice(), lastDialog: () => dialog, visible, headed, headlessFallback: wantHeaded && binIsHeadlessOnly, attachedPort: () => attachedPort, profileDir };
  }

  function makeBrowserSession(deps) {
    deps = deps || {};
    let driver = deps.driver || null;
    const injected = !!deps.driver;            // a test-injected driver never mode-switches
    const makeDriver = deps.makeDriver || makeCdpDriver;   // seam so tests can observe the headed flag
    let driverHeaded = null;                    // the REAL driver's current mode (null = none yet)
    let version = 0, seq = 0, localMode = false, localOrigin = null;
    const refs = new Map();
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
      driver = makeDriver(Object.assign({}, deps, { headed }));
      driverHeaded = headed;
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
    async function snapshot(limit) {
      const nodes = await ensureDriver().snapshot(limit);
      version++;
      const out = (nodes || []).map(n => Object.assign({}, n, { ref: refFor(n) }));
      return out;
    }
    async function click(ref) { return ensureDriver().click(requireRef(ref)); }
    async function type(ref, text) { return ensureDriver().type(requireRef(ref), text); }
    async function press(key) { return ensureDriver().press(key); }
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
    async function vision(question) {
      const data = await ensureDriver().screenshot();
      const bytes = Math.round(String(data || '').length * 3 / 4);
      if (deps.vision) {
        const answer = await deps.vision({ imageBase64: data, question: question || '' });
        return { ok: true, answer: String(answer == null ? '' : answer), bytes };
      }
      // No vision provider wired — do NOT fake an answer. Report honestly.
      return { ok: false, bytes, reason: 'no vision model configured — connect an OpenRouter key to enable browser.vision' };
    }
    async function close() { if (driver && driver.close) await driver.close(); }
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
    return { navigate, snapshot, click, type, press, testInput, testEval, testState, testSnapshot, scroll, back, getText, consoleLog, dialog, vision, close, visible, headlessFallback, attachedPort, _internals: { refs, version: () => version, localMode: () => localMode, localOrigin: () => localOrigin } };
  }

  function makeBrowserTools(deps) {
    deps = deps || {};
    const session = deps.session || makeBrowserSession(deps);
    const allowVisible = deps.allowVisible === true;
    const read = (name, description, schema, run) => ({ name, capability: 'web', scope: 'read', requiresConsent: false, timeoutMs: 20000, description, schema, run });
    const exec = (name, description, schema, run, consent) => ({ name, capability: 'web', scope: 'execute', requiresConsent: consent !== false, timeoutMs: 20000, description, schema, run });
    const testRead = (name, description, schema, run) => ({ name, capability: 'workbench', scope: 'read', requiresConsent: false, timeoutMs: 20000, description, schema, run });
    const testExec = (name, description, schema, run) => ({ name, capability: 'workbench', scope: 'execute', requiresConsent: false, timeoutMs: 20000, description, schema, run });
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
          return { content: 'Browser navigated to ' + url + suffix, summary: 'navigated' };
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
          const lines = nodes.map(n => n.ref + ' [' + n.role + '] ' + (n.text || '(no text)') + ' @ ' + n.x + ',' + n.y + ' ' + n.w + 'x' + n.h);
          return { content: lines.join('\n') || 'No visible interactive elements.', summary: nodes.length + ' ref(s)' };
        }),
      exec('browser.click', 'Click a visible element by ref from the latest browser.snapshot.', { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } } },
        async a => ({ content: await session.click(a.ref), summary: 'clicked' })),
      exec('browser.type', 'Click/focus an element by ref from the latest browser.snapshot, then type text into it.', { type: 'object', required: ['ref', 'text'], properties: { ref: { type: 'string' }, text: { type: 'string' } } },
        async a => ({ content: await session.type(a.ref, a.text), summary: 'typed' })),
      exec('browser.scroll', 'Scroll the page by x/y CSS pixels.', { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        async a => ({ content: await session.scroll(a.x || 0, a.y || 0), summary: 'scrolled' }), false),
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
      read('browser.vision', 'Capture the current viewport and, if a vision model is configured (OpenRouter key connected), answer a question about what is on screen. Without a vision model this returns a clear "unavailable" result — it never fabricates a description.', { type: 'object', properties: { question: { type: 'string' } } },
        async a => {
          const r = await session.vision(a.question || '');
          if (r && r.ok) {
            return { content: r.answer || '(vision model returned no text)', summary: 'vision' };
          }
          const reason = (r && r.reason) || 'vision model is not configured';
          return { content: 'browser.vision unavailable: ' + reason + ' (captured ' + ((r && r.bytes) || 0) + ' bytes but did not analyze them).', summary: 'vision unavailable' };
        })
    ];
    return { tools, session, register(reg) { tools.forEach(t => reg.register(t)); return reg; }, _internals: { assertSafeUrl, assertLoopbackUrl, isPrivateV4, isPrivateV6, makeBrowserSession, makeCdpDriver, findChrome, resolveChrome, headlessRequested, SYNTHETIC_INPUT_BOOTSTRAP, CHROME_CANDIDATES } };
  }

  return { makeBrowserTools, _internals: { assertSafeUrl, assertLoopbackUrl, isPrivateV4, isPrivateV6, makeBrowserSession, makeCdpDriver, findChrome, resolveChrome, headlessRequested, SYNTHETIC_INPUT_BOOTSTRAP, CHROME_CANDIDATES } };
});
