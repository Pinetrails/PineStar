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
  // Headless by default ONLY when a headless env is set; on a real desktop run the
  // controlled browser is HEADED so the user can watch (and hear) what the agent drives.
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
    send(method, params) {
      const id = ++this.id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, this.timeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
        this.pending.set(id, { resolve, reject, timer });
        this.ws.send(JSON.stringify({ id, method, params: params || {} }));
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
    // Headed unless a headless env is set (or deps.headless forces it, e.g. tests/soak rigs).
    const wantHeaded = deps.headless != null ? !deps.headless : !headlessRequested(deps.env);
    // Resolve the binary honoring the headed preference (skip headless-shell when headed).
    let chromePath = deps.chrome || null, binIsHeadlessOnly = false;
    if (!chromePath) {
      const r = resolveChrome(wantHeaded, deps.existsSync);
      if (r) { chromePath = r.path; binIsHeadlessOnly = r.headless; }
    }
    const cdpPort = deps.cdpPort || DEFAULT_PORT;
    const profileDir = deps.profileDir || P.join(OS.tmpdir(), 'starnet-browser-' + process.pid);
    const timeoutMs = deps.timeoutMs || 15000;
    if (!fetchImpl || !WebSocketImpl) throw new Error('browser unavailable: Node WebSocket/fetch is not available');
    if (!chromePath) throw new Error('browser unavailable: Chromium not found; set STARNET_CHROME');
    // We run headed only if requested AND the chosen binary can actually show a window.
    const headed = wantHeaded && !binIsHeadlessOnly;

    let proc = null, cdp = null, consoleLog = [], dialog = null;
    async function connect() {
      if (cdp) return cdp;
      try { FS.mkdirSync(profileDir, { recursive: true }); } catch (_) {}
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
      for (let i = 0; i < 40; i++) {
        try {
          const r = await fetchImpl('http://127.0.0.1:' + cdpPort + '/json/list');
          const targets = await r.json();
          const page = targets.find(t => t && t.type === 'page');
          if (page && page.webSocketDebuggerUrl) {
            const ws = new WebSocketImpl(page.webSocketDebuggerUrl);
            await new Promise((resolve, reject) => {
              ws.addEventListener('open', resolve, { once: true });
              ws.addEventListener('error', reject, { once: true });
            });
            cdp = new CdpClient(ws, timeoutMs);
            await cdp.send('Page.enable');
            await cdp.send('Runtime.enable');
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
      return evalJS('location.href');
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
    function close() {
      try { cdp && cdp.close(); } catch (_) {}
      try { proc && proc.kill('SIGKILL'); } catch (_) {}
      cdp = null; proc = null;
    }
    // visible() is the TRUTH the model reports: true only if the controlled window is
    // actually on the user's screen. Headless mode, or a headless-only binary fallback in
    // a headed request, both read as not visible.
    function visible() { return headed; }
    return { navigate, snapshot, click, type, press, scroll, back, getText, handleDialog, screenshot, close, consoleLog: () => consoleLog.slice(), lastDialog: () => dialog, visible, headed, headlessFallback: wantHeaded && binIsHeadlessOnly };
  }

  function makeBrowserSession(deps) {
    deps = deps || {};
    let driver = deps.driver || null;
    let version = 0, seq = 0;
    const refs = new Map();
    function ensureDriver() {
      if (driver) return driver;
      driver = makeCdpDriver(deps);
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
    async function navigate(url) {
      const u = assertSafeUrl(url);
      const finalUrl = await ensureDriver().navigate(u.href);
      if (finalUrl) {
        try { assertSafeUrl(finalUrl); } catch (e) {
          try { await ensureDriver().navigate('about:blank'); } catch (_) {}
          throw new Error('blocked unsafe redirect: ' + e.message);
        }
      }
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
      if (deps.vision) return deps.vision({ imageBase64: data, question: question || '' });
      return 'Captured viewport screenshot (' + Math.round(String(data || '').length * 3 / 4) + ' bytes). Vision model is not configured in this harness slice.';
    }
    function close() { if (driver && driver.close) driver.close(); }
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
    return { navigate, snapshot, click, type, press, scroll, back, getText, consoleLog, dialog, vision, close, visible, headlessFallback, _internals: { refs, version: () => version } };
  }

  function makeBrowserTools(deps) {
    deps = deps || {};
    const session = deps.session || makeBrowserSession(deps);
    const read = (name, description, schema, run) => ({ name, capability: 'web', scope: 'read', requiresConsent: false, timeoutMs: 20000, description, schema, run });
    const exec = (name, description, schema, run, consent) => ({ name, capability: 'web', scope: 'execute', requiresConsent: consent !== false, timeoutMs: 20000, description, schema, run });
    const tools = [
      read('browser.navigate', 'Navigate the AGENT-CONTROLLED browser to a public http(s) URL. On a real desktop this opens a VISIBLE Chrome window the user can watch (and hear) while you drive it with browser.snapshot/click/type — the same window you control. (In headless/CI mode, set by STARNET_BROWSER_HEADLESS, no window is shown; the result says so.) Use this whenever the user wants to SEE you open/browse a page ("open youtube for me", "on my screen") AND you may then interact with it. For a fire-and-forget open in the user\'s OWN default browser that you will NOT control afterward, use desktop.open. Private, loopback, intranet, and unsafe redirects are refused, so local dev servers need shell/HTTP verification instead.', { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
        async a => {
          const url = await session.navigate(a.url);
          let vis = true;
          try { vis = session.visible(); } catch (_) {}
          const suffix = vis
            ? ' (visible window on the user\'s screen)'
            : (session.headlessFallback && session.headlessFallback()
              ? ' (headless fallback — no visible window; no full Chrome found, only a headless-shell binary)'
              : ' (headless — not visible to the user)');
          return { content: 'Browser navigated to ' + url + suffix, summary: 'navigated' };
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
      read('browser.vision', 'Capture the current viewport for visual inspection. If a vision provider is configured, answer the supplied question.', { type: 'object', properties: { question: { type: 'string' } } },
        async a => ({ content: await session.vision(a.question || ''), summary: 'vision' }))
    ];
    return { tools, session, register(reg) { tools.forEach(t => reg.register(t)); return reg; }, _internals: { assertSafeUrl, isPrivateV4, isPrivateV6, makeBrowserSession, makeCdpDriver, findChrome, resolveChrome, headlessRequested, CHROME_CANDIDATES } };
  }

  return { makeBrowserTools, _internals: { assertSafeUrl, isPrivateV4, isPrivateV6, makeBrowserSession, makeCdpDriver, findChrome, resolveChrome, headlessRequested, CHROME_CANDIDATES } };
});
