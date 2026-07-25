/* node test/browser.test.js - browser automation contract:
   action surface, URL/redirect guards, snapshot refs, consent flags,
   capability projection, and graceful Chromium-missing errors. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const { makeBrowserTools, _internals: T } = require('../sidecar/tools/builtin/browser.js');

const call = (name, args) => ({ id: 'c_' + name, name, args: args || {}, argsRaw: JSON.stringify(args || {}), parseError: null });
async function rejects(p, re, msg) {
  try { await p; A.ok(false, msg + ' - did not reject'); }
  catch (e) { A.ok(re.test((e && e.message) || String(e)), msg); }
}

function fakeDriver() {
  const log = { clicked: [], typed: [], pressed: [], scrolled: [], navigated: [], testInput: [], evaluated: [], states: [] };
  let pageText = 'Example page text';
  return {
    log,
    navigate: async url => {
      log.navigated.push(url);
      if (/redirect-private/.test(url)) return 'http://127.0.0.1/admin';
      return url;
    },
    snapshot: async () => [
      { role: 'button', text: 'Search', x: 10, y: 20, w: 80, h: 30 },
      { role: 'textbox', text: 'Query', x: 10, y: 60, w: 200, h: 24 }
    ],
    click: async node => { log.clicked.push(node.text); return 'clicked ' + node.text; },
    type: async (node, text) => { log.typed.push([node.text, text]); pageText += ' ' + text; return 'typed ' + text; },
    press: async key => { log.pressed.push(key); return 'pressed ' + key; },
    scroll: async (x, y) => { log.scrolled.push([x, y]); return 'scrolled ' + y; },
    back: async () => 'https://example.com/back',
    getText: async () => pageText,
    consoleLog: () => [{ type: 'warning', text: 'careful' }],
    handleDialog: async action => ({ type: action === 'dismiss' ? 'confirm' : 'alert', message: 'hello' }),
    screenshot: async () => Buffer.from('png').toString('base64'),
    testInput: async action => { log.testInput.push(action); return 'synthetic ' + action.action; },
    testEval: async expression => {
      log.evaluated.push(expression);
      if (String(expression).trim() === 'location.href') return log.navigated[log.navigated.length - 1] || 'about:blank';
      return { ok: true, expression };
    },
    testState: async selector => { log.states.push(selector); return { syntheticReady: true, pointerLockTag: 'CANVAS', element: { exists: true } }; }
  };
}

(async () => {
  // URL guard
  A.notThrows(() => T.assertSafeUrl('https://example.com/path'), 'public HTTPS URL is allowed');
  A.throws(() => T.assertSafeUrl('http://localhost:3000'), 'localhost URL is blocked');
  A.throws(() => T.assertSafeUrl('http://192.168.0.5'), 'private IPv4 URL is blocked');
  A.throws(() => T.assertSafeUrl('https://printer.lan'), 'intranet suffix URL is blocked');
  A.notThrows(() => T.assertLoopbackUrl('http://127.0.0.1:5173/game'), 'local test route accepts numeric loopback');
  A.notThrows(() => T.assertLoopbackUrl('http://localhost:4173/'), 'local test route accepts localhost');
  A.throws(() => T.assertLoopbackUrl('http://192.168.0.5'), 'local test route never widens to the LAN');
  A.throws(() => T.assertLoopbackUrl('https://example.com'), 'local test route accepts loopback only');

  const driver = fakeDriver();
  const B = makeBrowserTools({ driver, vision: async ({ question }) => 'vision answer: ' + question });
  const names = B.tools.map(t => t.name).sort();
  A.eq(names, [
    'browser.back', 'browser.click', 'browser.console', 'browser.dialog', 'browser.get_text',
    'browser.login', 'browser.navigate', 'browser.press', 'browser.screenshot', 'browser.scroll', 'browser.snapshot',
    'browser.test_input', 'browser.test_navigate', 'browser.test_snapshot', 'browser.test_state',
    'browser.type', 'browser.vision'
  ], 'browser action surface is complete');
  A.eq(B.tools.find(t => t.name === 'browser.click').requiresConsent, true, 'click is consent-gated');
  A.eq(B.tools.find(t => t.name === 'browser.snapshot').requiresConsent, false, 'snapshot is read-only');

  // navigate + redirect guard
  {
    const out = await B.tools.find(t => t.name === 'browser.navigate').run({ url: 'https://example.com' }, {});
    A.ok(/https:\/\/example\.com/.test(out.content), 'navigate returns the final public URL');
    await rejects(B.session.navigate('https://redirect-private.example'), /blocked unsafe redirect/, 'unsafe redirect is refused explicitly');
    const local = await B.tools.find(t => t.name === 'browser.test_navigate').run({ url: 'http://127.0.0.1:5173/' }, {});
    A.ok(/synthetic-input isolated|headless/i.test(local.content), 'local test navigation reports its isolated posture');
    await B.tools.find(t => t.name === 'browser.test_input').run({ action: 'key_down', key: 'KeyW' }, {});
    await B.tools.find(t => t.name === 'browser.test_state').run({ selector: '#hud' }, {});
    const localSnap = await B.tools.find(t => t.name === 'browser.test_snapshot').run({ limit: 5 }, {});
    A.ok(/button|link|textbox/.test(localSnap.content), 'local snapshot exposes synthetic-click coordinates without arbitrary JavaScript');
    A.eq(driver.log.testInput[0].action, 'key_down', 'local game input routes through the synthetic driver');
    A.eq(driver.log.states[0], '#hud', 'local game state inspection routes through the bounded CDP state reader');

    const ownedDriver = fakeDriver();
    const owned = makeBrowserTools({ driver: ownedDriver, requireOwnedServer: true, ownsLocalUrl: async o => o.serverId === 'bg_1' });
    const ownedNav = owned.tools.find(t => t.name === 'browser.test_navigate');
    A.ok(ownedNav.schema.required.includes('serverId'), 'production local navigation requires an owned background-server handle');
    await rejects(ownedNav.run({ url: 'http://127.0.0.1:5173/', serverId: 'bg_other' }, { agentId: 'ag' }), /not proven to belong/i, 'unowned localhost service is refused');
    await ownedNav.run({ url: 'http://127.0.0.1:5173/', serverId: 'bg_1' }, { agentId: 'ag' });
    A.eq(ownedDriver.log.navigated.length, 1, 'owned background service may enter the isolated browser');
    ownedDriver.log.navigated.push('http://127.0.0.1:9999/admin');
    await rejects(owned.tools.find(t => t.name === 'browser.test_input').run({ action: 'click', x: 1, y: 1 }, {}), /left its owned server origin/i, 'synthetic input is disabled if the page leaves its owned origin');
    A.eq(ownedDriver.log.testInput.length, 0, 'origin drift is refused before another input event dispatches');
  }

  // refs expire after the next snapshot
  {
    const snap = await B.tools.find(t => t.name === 'browser.snapshot').run({}, {});
    const searchRef = (snap.content.match(/(b\d+) \[button\] Search/) || [])[1];
    A.ok(!!searchRef, 'snapshot returns stable element refs');
    const click = await B.tools.find(t => t.name === 'browser.click').run({ ref: searchRef }, {});
    A.ok(/clicked Search/.test(click.content), 'click uses a snapshot ref');
    await B.session.snapshot();
    await rejects(B.session.click(searchRef), /stale browser ref/, 'old refs expire after a new snapshot');
  }

  // type/press/scroll/back/console/dialog/get_text/vision all route through the driver
  {
    const nodes = await B.session.snapshot();
    const textbox = nodes.find(n => n.role === 'textbox');
    await B.tools.find(t => t.name === 'browser.type').run({ ref: textbox.ref, text: 'hello' }, {});
    await B.tools.find(t => t.name === 'browser.press').run({ key: 'Enter' }, {});
    await B.tools.find(t => t.name === 'browser.scroll').run({ y: 250 }, {});
    const back = await B.tools.find(t => t.name === 'browser.back').run({}, {});
    const con = await B.tools.find(t => t.name === 'browser.console').run({}, {});
    const dlg = await B.tools.find(t => t.name === 'browser.dialog').run({ action: 'dismiss' }, {});
    const txt = await B.tools.find(t => t.name === 'browser.get_text').run({}, {});
    const vis = await B.tools.find(t => t.name === 'browser.vision').run({ question: 'what changed?' }, {});
    A.eq(driver.log.typed[0], ['Query', 'hello'], 'type routes to the textbox ref');
    A.eq(driver.log.pressed[0], 'Enter', 'press routes to driver');
    A.eq(driver.log.scrolled[0], [0, 250], 'scroll routes to driver');
    A.ok(/back/.test(back.content), 'back returns the resulting URL');
    A.ok(/careful/.test(con.content), 'console returns recent messages');
    A.ok(/confirm/.test(dlg.content), 'dialog action routes to driver');
    A.ok(/hello/.test(txt.content), 'get_text returns page text');
    A.ok(/vision answer/.test(vis.content), 'vision hook is available');
  }

  // registry/capability integration
  {
    const reg = makeRegistry();
    makeBrowserTools({ driver: fakeDriver() }).register(reg);
    const station = { agents: { ag: { id: 'ag', room: 'r' } }, rooms: { r: { id: 'r', objects: [{ objectType: 'computer' }, { objectType: 'dish' }] } } };
    const resolved = resolveTools('ag', station);
    A.ok(resolved.tools.indexOf('browser.navigate') >= 0 && resolved.tools.indexOf('browser.click') >= 0, 'dish grants browser tools');
    A.eq(resolved.approvalRules['browser.click'].requiresConsent, true, 'mutating browser tools carry consent rules');
    const noDish = resolveTools('ag', { agents: { ag: { id: 'ag', room: 'r' } }, rooms: { r: { id: 'r', objects: [{ objectType: 'computer' }] } } });
    const denied = await reg.dispatch(call('browser.navigate', { url: 'https://example.com' }), makeCapCtx(noDish));
    A.eq(denied.summary, 'capdenied', 'without a dish, browser tools are capability-denied');

    const workbench = resolveTools('ag', { agents: { ag: { id: 'ag', room: 'r' } }, rooms: { r: { id: 'r', objects: [{ objectType: 'computer' }, { objectType: 'workbench' }] } } });
    A.ok(workbench.tools.indexOf('browser.test_navigate') >= 0 && workbench.tools.indexOf('browser.test_input') >= 0 && workbench.tools.indexOf('browser.test_state') >= 0, 'workbench grants the isolated local-game CDP surface');
  }

  // Chromium-missing degrades as a clean tool error through dispatch
  {
    const reg = makeRegistry();
    makeBrowserTools({ existsSync: () => false, WebSocketImpl: null }).register(reg);
    const r = await reg.dispatch(call('browser.navigate', { url: 'https://example.com' }));
    A.eq(r.isError, true, 'missing Chromium returns tool error');
    A.ok(/browser unavailable/.test(r.content), 'missing Chromium error is explicit');
  }

  // browser.vision: with a vision dep the answer flows through; with NONE it is honestly unavailable
  {
    const withVision = makeBrowserTools({ driver: fakeDriver(), vision: async ({ question }) => 'I see: ' + question });
    const ok = await withVision.tools.find(t => t.name === 'browser.vision').run({ question: 'what page?' }, {});
    A.eq(ok.summary, 'vision', 'wired vision reports success summary');
    A.ok(/I see: what page\?/.test(ok.content), 'wired vision answer flows through');

    const noVision = makeBrowserTools({ driver: fakeDriver() });   // no vision dep
    const un = await noVision.tools.find(t => t.name === 'browser.vision').run({ question: 'what page?' }, {});
    A.eq(un.summary, 'vision unavailable', 'missing vision provider yields an honest unavailable summary, not a success stub');
    // 2026-07-22: the unavailable message must NEVER solicit an API key from the user (that wording primed
    // agents to demand OpenRouter keys — the Telegram media bug); it names the missing route and forbids asking.
    A.ok(/unavailable/i.test(un.content) && /vision route/i.test(un.content), 'unavailable content names the missing vision route');
    A.ok(/do not ask the user for an api key/i.test(un.content), 'unavailable content forbids soliciting a key');
    A.ok(!/connect an? (OpenRouter|API) key/i.test(un.content), 'unavailable content never tells the agent to request a key');
    A.ok(!/I see:/.test(un.content), 'unavailable content never fabricates a description');
  }

  // ---- HEADLESS-BY-DEFAULT (2026-07-07 direction: research must never open a window on the user's
  //      screen; a visible window exists ONLY while the Commander asked to watch) ----
  {
    const made = [];   // capture every driver launch + its mode via the makeDriver seam
    const mkSession = (env, extra) => T.makeBrowserSession(Object.assign({
      env: env || {},
      makeDriver: (d) => { const drv = fakeDriver(); drv.headed = !!d.headed; drv.visible = () => !!d.headed; drv.close = () => { drv.closed = true; }; made.push(drv); return drv; }
    }, extra || {}));

    const s = mkSession();
    await s.navigate('https://example.com');                        // plain research navigate
    A.eq(made.length, 1, 'first navigate launches one driver');
    A.eq(made[0].headed, false, 'DEFAULT IS HEADLESS: research never opens a window');

    await s.navigate('https://example.com/2');                       // still no visibility request
    A.eq(made.length, 1, 'mode unchanged -> no relaunch');

    await s.navigate('https://example.com/3', { visible: true });    // the Commander asked to watch
    A.eq(made.length, 2, 'visible:true relaunches the driver');
    A.eq(made[1].headed, true, 'visible:true opens the HEADED window');
    A.eq(made[0].closed, true, 'the headless driver was closed on the mode switch');

    await s.navigate('https://example.com/4');                       // follow-up drive of the SAME window
    A.eq(made.length, 2, 'a plain navigate after visible:true keeps the watched window (no relaunch)');

    await s.navigate('https://example.com/5', { visible: false });   // done watching
    A.eq(made.length, 3, 'visible:false relaunches back');
    A.eq(made[2].headed, false, 'visible:false returns to headless');

    // a headless env pins the posture: even an explicit visible:true stays headless (CI/soak safety)
    const s2 = mkSession({ SKYNET_BROWSER_HEADLESS: '1' });
    await s2.navigate('https://example.com', { visible: true });
    A.eq(made[made.length - 1].headed, false, 'SKYNET_BROWSER_HEADLESS=1 wins over visible:true');

    const s3 = mkSession({}, { forceHeadless: true });
    await s3.navigate('https://example.com', { visible: true });
    A.eq(made[made.length - 1].headed, false, 'host forceHeadless policy wins over model-controlled visible:true');
  }

  // The default tool surface is fail-closed: no model-controlled visible flag. A separately
  // constructed attended host may opt in, but runOnce never does for tasks/autonomy/tests.
  {
    const made = [];
    const B2 = makeBrowserTools({
      makeDriver: (d) => { const drv = fakeDriver(); drv.headed = !!d.headed; drv.visible = () => !!d.headed; drv.close = () => {}; made.push(drv); return drv; }
    });
    const nav = B2.tools.find(t => t.name === 'browser.navigate');
    A.eq(nav.schema.properties.visible, undefined, 'ordinary task browser schema cannot request a visible window');
    A.ok(/HEADLESS/i.test(nav.description), 'the description states the headless posture');
    const r1 = await nav.run({ url: 'https://example.com' }, {});
    A.ok(/headless — not visible/.test(r1.content), 'a research navigate reports headless honestly');
    await rejects(nav.run({ url: 'https://example.com', visible: true }, {}), /visible.*disabled|headless-only/i, 'forged visible:true is refused by host policy');
    A.eq(made.map(d => d.headed), [false], 'ordinary task browsing never creates a headed driver');

    const attended = makeBrowserTools({
      allowVisible: true,
      makeDriver: (d) => { const drv = fakeDriver(); drv.headed = !!d.headed; drv.visible = () => !!d.headed; drv.close = () => {}; made.push(drv); return drv; }
    });
    const attendedNav = attended.tools.find(t => t.name === 'browser.navigate');
    A.ok(attendedNav.schema.properties.visible, 'a separately constructed attended surface may expose visible');
    const r2 = await attendedNav.run({ url: 'https://example.com', visible: true }, {});
    A.ok(/visible window/.test(r2.content), 'explicit attended surface reports its visible window truthfully');
  }

  // Pointer/keyboard locks are emulated inside the CDP page before navigation; the native
  // browser implementation (and therefore Win32 ClipCursor) is never reached.
  A.ok(/requestPointerLock/.test(T.SYNTHETIC_INPUT_BOOTSTRAP), 'isolation bootstrap overrides requestPointerLock');
  A.ok(/exitPointerLock/.test(T.SYNTHETIC_INPUT_BOOTSTRAP), 'isolation bootstrap overrides exitPointerLock');
  A.ok(/requestFullscreen/.test(T.SYNTHETIC_INPUT_BOOTSTRAP) && /exitFullscreen/.test(T.SYNTHETIC_INPUT_BOOTSTRAP), 'isolation bootstrap emulates fullscreen without a platform transition');
  A.ok(/keyboard/.test(T.SYNTHETIC_INPUT_BOOTSTRAP) && /lock/.test(T.SYNTHETIC_INPUT_BOOTSTRAP), 'isolation bootstrap neutralizes keyboard lock');
  A.ok(/wakeLock/.test(T.SYNTHETIC_INPUT_BOOTSTRAP) && /orientation/.test(T.SYNTHETIC_INPUT_BOOTSTRAP), 'isolation bootstrap neutralizes wake/orientation locks');
  A.ok(/Object\.freeze\(attestation\)/.test(T.SYNTHETIC_INPUT_BOOTSTRAP), 'page code cannot forge the synthetic-isolation ready attestation');
  A.ok(/getOwnPropertyDescriptor\(Element\.prototype,'requestPointerLock'\)/.test(T.makeCdpDriver.toString()), 'navigation verifies the actual non-writable pointer-lock descriptor');
  A.ok(/getOwnPropertyDescriptor\(Element\.prototype,'requestFullscreen'\)/.test(T.makeCdpDriver.toString()), 'navigation verifies the actual non-writable fullscreen descriptor');

  // Drive the real CDP adapter against an in-memory protocol peer: the bootstrap must be
  // registered BEFORE Page.navigate, and the launched process must stay headless/muted.
  {
    const sent = [], launches = [];
    let currentUrl = 'about:blank', isolationReady = true;
    const fakeProc = pid => {
      let close;
      return { pid, on(ev, fn) { if (ev === 'close') close = fn; }, kill() { if (close) queueMicrotask(() => close(0)); } };
    };
    class FakeWS {
      constructor() { this.handlers = {}; FakeWS.last = this; setTimeout(() => this.fire('open', {}), 0); }
      addEventListener(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
      fire(name, value) { for (const fn of this.handlers[name] || []) fn(value); }
      send(raw) {
        const m = JSON.parse(raw); sent.push(m);
        if (m.method === 'Page.navigate') currentUrl = m.params.url;
        let value = currentUrl;
        if (m.method === 'Runtime.evaluate' && /return \{ready:/.test(String(m.params && m.params.expression || ''))) {
          value = { ready: isolationReady, error: isolationReady ? null : 'simulated bootstrap refusal' };
        }
        const result = m.method === 'Runtime.evaluate' ? { result: { value } } : {};
        setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
      }
      close() {}
    }
    const d = T.makeCdpDriver({
      chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: true, timeoutMs: 1000, cdpPort: 9347,
      fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://fake' }] }),
      WebSocketImpl: FakeWS,
      spawn: (exe, args) => { launches.push({ exe, args }); return fakeProc(42); }
    });
    await d.navigate('http://127.0.0.1:5173/');
    const installAt = sent.findIndex(m => m.method === 'Page.addScriptToEvaluateOnNewDocument');
    const navAt = sent.findIndex(m => m.method === 'Page.navigate');
    A.ok(installAt >= 0 && installAt < navAt, 'synthetic input bootstrap is installed before navigation');
    A.ok(/requestPointerLock/.test(sent[installAt].params.source), 'CDP installs the pointer-lock override source');
    A.ok(/state\.ready/.test(sent[installAt].params.source), 'pointer-lock bootstrap exposes a verifiable ready marker');
    A.ok(launches[0].args.some(a => /^--headless/.test(a)) && launches[0].args.includes('--mute-audio'), 'CDP browser process is headless and muted');
    A.ok(!launches[0].args.includes('--new-window'), 'synthetic test browser never requests a window');
    A.ok(sent.some(m => m.method === 'Target.setAutoAttach' && m.params.waitForDebuggerOnStart === true), 'new targets are paused before scripts can reach native input APIs');
    FakeWS.last.fire('message', { data: JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'popup-session', targetInfo: { type: 'page', targetId: 'popup-target' } } }) });
    await new Promise(resolve => setTimeout(resolve, 10));
    A.ok(sent.some(m => m.method === 'Target.closeTarget' && m.params.targetId === 'popup-target'), 'unexpected popup target is closed while paused');
    await d.close();

    isolationReady = false; currentUrl = 'about:blank'; sent.length = 0;
    const refused = T.makeCdpDriver({
      chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: true, timeoutMs: 1000, cdpPort: 9348,
      fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://fake-refused' }] }),
      WebSocketImpl: FakeWS,
      spawn: () => fakeProc(43)
    });
    await rejects(refused.navigate('http://127.0.0.1:5173/'), /isolation failed to install.*simulated bootstrap refusal/i, 'navigation fails closed before input when the lock shim is not proven');
    A.ok(sent.some(m => m.method === 'Page.navigate' && m.params.url === 'about:blank'), 'failed isolation navigates away from the unshimmed page');
    await refused.close();

    const privateProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-cdp-owner-'));
    const fetched = [], privateLaunches = [];
    isolationReady = true; currentUrl = 'about:blank'; sent.length = 0;
    const privatePort = T.makeCdpDriver({
      chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: true, timeoutMs: 1000,
      cdpPort: 0, profileDir: privateProfile,
      fetchImpl: async url => { fetched.push(url); return { json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://owned-private' }] }; },
      WebSocketImpl: FakeWS,
      spawn: (exe, args) => { privateLaunches.push(args); return fakeProc(44); }
    });
    await privatePort.navigate('http://127.0.0.1:5173/');
    // FINGERPRINT GUARD: production must launch on a private port it allocated ITSELF, never on
    // literal 0. Chromium's runtime_features.cc special-cases --remote-debugging-port=0 and turns on
    // AutomationControlled (navigator.webdriver), and Google refuses sign-in to browsers "being
    // controlled through software automation" — which would break attended login for the human driving it.
    const portArg = privateLaunches[0].find(a => /^--remote-debugging-port=/.test(a));
    A.ok(portArg, 'production launch carries a private CDP port');
    const launchedPort = Number(String(portArg).split('=')[1]);
    A.ok(Number.isInteger(launchedPort) && launchedPort > 0 && launchedPort < 65536, 'the private CDP port is a real ephemeral port, never literal 0 (port 0 sets navigator.webdriver)');
    A.ok(launchedPort !== 9347, 'the private port is per-run, never the process-wide default another agent run could attach to');
    A.ok(fetched.some(u => u === 'http://127.0.0.1:' + launchedPort + '/json/list'), 'driver attaches only through the private port it allocated for this run');
    A.eq(privatePort.attachedPort(), launchedPort, 'driver reports the privately owned attached port');
    await privatePort.close();
    fs.rmSync(privateProfile, { recursive: true, force: true });
  }

  // ---- AUTO-WAIT: actions settle before they return ------------------------------------------
  // THE SILENT CORRUPTER this replaces: the whole wait vocabulary was three fixed sleeps, and
  // click/type/press returned with ZERO settle, so the next snapshot read the PRE-CLICK DOM and any
  // SPA hydrating past the blind 900ms answered an empty page ("no interactive elements").
  {
    // A fake page whose settle probe reports a scripted hydration timeline.
    function settleRig(script) {
      const state = { probes: 0, sent: [], url: 'about:blank' };
      class WS {
        constructor() { this.handlers = {}; WS.last = this; setTimeout(() => this.fire('open', {}), 0); }
        addEventListener(n, fn) { (this.handlers[n] = this.handlers[n] || []).push(fn); }
        fire(n, v) { for (const fn of this.handlers[n] || []) fn(v); }
        send(raw) {
          const m = JSON.parse(raw); state.sent.push(m);
          if (m.method === 'Page.navigate') state.url = m.params.url;
          const expr = String((m.params && m.params.expression) || '');
          let value = state.url;
          if (/return \{ready:/.test(expr)) value = { ready: true, error: null };          // isolation attestation
          else if (/__STARNET_SETTLE__/.test(expr) && /document\.readyState/.test(expr)) {  // the settle probe
            value = script(state.probes++);
          }
          const result = m.method === 'Runtime.evaluate' ? { result: { value } } : {};
          setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
        }
        close() {}
      }
      const driver = T.makeCdpDriver({
        chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: true, timeoutMs: 1000, cdpPort: 9349,
        settleQuietPolls: 2, settleNavBudgetMs: 400, settleActionBudgetMs: 400,
        fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://settle' }] }),
        WebSocketImpl: WS,
        spawn: () => ({ pid: 51, on(ev, fn) { if (ev === 'close') this._c = fn; }, kill() { if (this._c) queueMicrotask(() => this._c(0)); } })
      });
      return { driver, state };
    }

    // The settle marker itself must observe the DOM and survive a page that has no <html> yet.
    A.ok(/MutationObserver/.test(T.SETTLE_BOOTSTRAP), 'settle bootstrap observes DOM mutations');
    A.ok(/documentElement \? observe\(\) :/.test(T.SETTLE_BOOTSTRAP) || /documentElement/.test(T.SETTLE_BOOTSTRAP), 'settle bootstrap defers until a document root exists');
    A.ok(/document\.readyState/.test(T.SETTLE_PROBE) && /s\.n/.test(T.SETTLE_PROBE), 'settle probe reads readyState and the mutation counter');
    A.ok(!/Date\.now|performance\.now/.test(T.SETTLE_BOOTSTRAP), 'settle marker counts mutations rather than reading a clock (determinism law)');
    A.ok(/addScriptToEvaluateOnNewDocument/.test(T.makeCdpDriver.toString()), 'settle marker is reinstalled for every new document');

    // A. a page that hydrates late: navigate must NOT return on the first look.
    {
      const rig = settleRig(i => i < 3 ? { ok: true, ready: 'loading', n: i } : { ok: true, ready: 'complete', n: 99 });
      await rig.driver.navigate('http://127.0.0.1:5173/');
      A.ok(rig.state.probes >= 4, 'navigate keeps polling a hydrating page instead of a blind fixed sleep (probes=' + rig.state.probes + ')');
      await rig.driver.close();
    }

    // B. a static page settles on the FIRST quiet read — auto-wait is faster than the old 900ms sleep.
    {
      const t0 = Date.now();
      const rig = settleRig(() => ({ ok: true, ready: 'complete', n: 7 }));
      await rig.driver.navigate('http://127.0.0.1:5173/');
      A.ok(Date.now() - t0 < 800, 'an already-quiet page returns well inside the old 900ms blind wait');
      A.ok(rig.state.probes <= 4, 'a settled page costs only the quiet-confirmation polls (' + rig.state.probes + ')');
      await rig.driver.close();
    }

    // C. THE REGRESSION: click/type/press must settle. Previously they issued Input.* and returned.
    {
      const rig = settleRig(() => ({ ok: true, ready: 'complete', n: 0 }));
      await rig.driver.navigate('http://127.0.0.1:5173/');
      const before = rig.state.probes;
      await rig.driver.click({ x: 1, y: 1, w: 10, h: 10 });
      A.ok(rig.state.probes > before, 'click settles before returning');
      const afterClick = rig.state.probes;
      await rig.driver.press('Enter');
      A.ok(rig.state.probes > afterClick, 'press settles before returning');
      const afterPress = rig.state.probes;
      await rig.driver.scroll(0, 400);
      A.ok(rig.state.probes > afterPress, 'scroll settles (lazy-load/infinite-scroll content lands before the next snapshot)');
      await rig.driver.close();
    }

    // D. a page that NEVER goes quiet (a spinner, a poller) must still return at the budget.
    {
      let tick = 0;
      const rig = settleRig(() => ({ ok: true, ready: 'complete', n: tick++ }));
      const t0 = Date.now();
      await rig.driver.navigate('http://127.0.0.1:5173/');
      const ms = Date.now() - t0;
      A.ok(ms >= 350, 'a never-quiet page spends its settle budget');
      A.ok(ms < 3000, 'a never-quiet page still returns — auto-wait can never hang the run (' + ms + 'ms)');
      await rig.driver.close();
    }

    // E. no settle marker (a page that blocked the bootstrap) falls back to the legacy blind sleep
    // rather than skipping the wait entirely.
    {
      const rig = settleRig(() => 'http://127.0.0.1:5173/');   // a non-object answer = unmeasurable
      const t0 = Date.now();
      await rig.driver.navigate('http://127.0.0.1:5173/');
      A.ok(Date.now() - t0 >= 850, 'an unmeasurable page still gets the legacy 900ms settle');
      await rig.driver.close();
    }
  }

  // ---- SCREENSHOTS ARE NO LONGER WRITE-ONLY --------------------------------------------------
  // screenshot() had exactly ONE consumer - vision() - which handed the base64 to a model and
  // returned a BYTE COUNT. The user could never see what the agent saw, and the frame was dropped.
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-shots-'));
    try {
      const fsp = require('node:fs/promises');
      const emitted = [];
      const ctx = { agentId: 'ag', room: 'lab', emit: (name, payload) => emitted.push([name, payload]) };
      const S = makeBrowserTools({ driver: fakeDriver(), fsp, pathMod: path, root: ws });

      const out = await S.tools.find(t => t.name === 'browser.screenshot').run({}, ctx);
      const rel = (out.content.match(/shots\/shot-[a-f0-9]+\.png/) || [])[0];
      A.ok(!!rel, 'screenshot reports the saved path');
      A.ok(fs.existsSync(path.join(ws, 'ag', rel)), 'the PNG is actually written into the agent workspace jail');
      A.eq(fs.readFileSync(path.join(ws, 'ag', rel)).toString(), 'png', 'the captured bytes are what got written');
      const deliv = emitted.find(e => e[0] === 'deliverable');
      A.ok(!!deliv, 'a deliverable event is emitted so the capture shows up in the station');
      A.eq(deliv[1].kind, 'image', 'the deliverable is an image');
      A.eq(deliv[1].agentId, 'ag', 'the deliverable is attributed to the capturing agent');
      A.eq(deliv[1].room, 'lab', 'the deliverable carries the room');
      A.ok(/\/api\/file\?agent=ag/.test(out.content), 'a viewer link is offered');

      // Content-addressed: the same viewport twice is ONE file, not a pile of near-duplicates.
      const again = await S.tools.find(t => t.name === 'browser.screenshot').run({}, ctx);
      A.eq((again.content.match(/shots\/shot-[a-f0-9]+\.png/) || [])[0], rel, 'an unchanged capture is idempotent (content-addressed)');

      // vision now PERSISTS the frame it analyzed, so the model's reading can be checked against pixels.
      const V = makeBrowserTools({ driver: fakeDriver(), fsp, pathMod: path, root: ws, vision: async () => 'a login form' });
      const vout = await V.tools.find(t => t.name === 'browser.vision').run({ question: 'what is this?' }, ctx);
      A.ok(/a login form/.test(vout.content), 'vision still answers the question');
      A.ok(/Screenshot saved to shots\//.test(vout.content), 'vision saves the frame it analyzed instead of dropping it');

      // No workspace wired: say so honestly rather than naming a file that does not exist.
      const N = makeBrowserTools({ driver: fakeDriver() });
      const nout = await N.tools.find(t => t.name === 'browser.screenshot').run({}, ctx);
      A.ok(/no workspace to save into/.test(nout.content), 'a run without a workspace admits the image was discarded');
      A.ok(!/shots\//.test(nout.content), 'and never invents a saved path');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }

  // ---- NETWORK TRUTH: the agent is told the main document's real HTTP status ------------------
  // Before this, navigate() returned only location.href, so a 403, a 404 and a page that rendered
  // nothing were indistinguishable — the agent read the error page and reported it as the answer.
  {
    A.eq(T.describeResponse(null), { text: '', summary: '' }, 'a driver that cannot observe the network claims nothing');
    A.eq(T.describeResponse({ status: 200 }).text, ' (HTTP 200)', 'a 2xx is reported plainly');
    A.ok(/HTTP 403/.test(T.describeResponse({ status: 403, statusText: 'Forbidden' }).text), 'a 403 is surfaced');
    A.ok(/error response, not the content/.test(T.describeResponse({ status: 404 }).text), 'a non-2xx warns that the body is an error page');
    A.ok(/REQUEST FAILED/.test(T.describeResponse({ status: 0, failure: 'net::ERR_NAME_NOT_RESOLVED' }).text), 'a transport failure is distinguished from an HTTP status');

    // Fake CDP that emits Network events for the page it "loads".
    function netRig(events) {
      const state = { sent: [], url: 'about:blank' };
      class WS {
        constructor() { this.handlers = {}; WS.last = this; setTimeout(() => this.fire('open', {}), 0); }
        addEventListener(n, fn) { (this.handlers[n] = this.handlers[n] || []).push(fn); }
        fire(n, v) { for (const fn of this.handlers[n] || []) fn(v); }
        emit(method, params) { this.fire('message', { data: JSON.stringify({ method, params }) }); }
        send(raw) {
          const m = JSON.parse(raw); state.sent.push(m);
          const expr = String((m.params && m.params.expression) || '');
          let result = {};
          if (m.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'MAIN' } } };
          else if (m.method === 'Runtime.evaluate') {
            let value = state.url;
            if (/return \{ready:/.test(expr)) value = { ready: true, error: null };
            else if (/__STARNET_SETTLE__/.test(expr) && /document\.readyState/.test(expr)) value = { ok: true, ready: 'complete', n: 0 };
            result = { result: { value } };
          }
          if (m.method === 'Page.navigate') { state.url = m.params.url; for (const e of events) this.emit(e[0], e[1]); }
          setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
        }
        close() {}
      }
      const driver = T.makeCdpDriver({
        chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: true, timeoutMs: 1000, cdpPort: 9350,
        settleQuietPolls: 1, settleNavBudgetMs: 300, settleActionBudgetMs: 300,
        fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://net' }] }),
        WebSocketImpl: WS,
        spawn: () => ({ pid: 61, on(ev, fn) { if (ev === 'close') this._c = fn; }, kill() { if (this._c) queueMicrotask(() => this._c(0)); } })
      });
      return { driver, state };
    }

    // A. a 403 main document is captured and reported.
    {
      const rig = netRig([['Network.responseReceived', { type: 'Document', frameId: 'MAIN', response: { status: 403, statusText: 'Forbidden', url: 'https://x.test/' } }]]);
      await rig.driver.navigate('https://x.test/');
      A.eq(rig.driver.lastResponse().status, 403, 'main-document 403 captured from the Network domain');
      await rig.driver.close();
    }

    // B. THE SUB-FRAME TRAP: an ad/iframe 404 must never read as the page's own status.
    {
      const rig = netRig([
        ['Network.responseReceived', { type: 'Document', frameId: 'MAIN', response: { status: 200, statusText: 'OK', url: 'https://x.test/' } }],
        ['Network.responseReceived', { type: 'Document', frameId: 'IFRAME', response: { status: 404, statusText: 'Not Found', url: 'https://ads.test/' } }]
      ]);
      await rig.driver.navigate('https://x.test/');
      A.eq(rig.driver.lastResponse().status, 200, 'a sub-frame document response never overwrites the top frame status');
      await rig.driver.close();
    }

    // C. a transport failure (DNS/refused/cert) produces no response at all.
    {
      const rig = netRig([['Network.loadingFailed', { requestId: 'r1', type: 'Document', errorText: 'net::ERR_NAME_NOT_RESOLVED' }]]);
      await rig.driver.navigate('https://nope.test/');
      A.eq(rig.driver.lastResponse().failure, 'net::ERR_NAME_NOT_RESOLVED', 'transport failure recorded');
      A.eq(rig.driver.lastResponse().status, 0, 'a failed request has no HTTP status');
      await rig.driver.close();
    }

    // D. status must not leak from the previous page.
    {
      const rig = netRig([['Network.responseReceived', { type: 'Document', frameId: 'MAIN', response: { status: 500, statusText: 'Server Error', url: 'https://x.test/' } }]]);
      await rig.driver.navigate('https://x.test/');
      A.eq(rig.driver.lastResponse().status, 500, 'first navigation records its status');
      rig.state.sent.length = 0;
      const quiet = netRig([]);                       // a second navigation that emits nothing
      await quiet.driver.navigate('https://y.test/');
      A.eq(quiet.driver.lastResponse(), null, 'a navigation with no observed response reports NOTHING rather than a stale status');
      await rig.driver.close(); await quiet.driver.close();
    }

    // E. the tool text the agent actually reads carries the status.
    {
      const statusDriver = fakeDriver();
      statusDriver.lastResponse = () => ({ status: 403, statusText: 'Forbidden', failure: null });
      const B403 = makeBrowserTools({ driver: statusDriver });
      const out = await B403.tools.find(t => t.name === 'browser.navigate').run({ url: 'https://example.com' }, {});
      A.ok(/HTTP 403/.test(out.content), 'browser.navigate tells the agent the page was a 403');
      A.ok(/error response, not the content/.test(out.content), 'and warns that the body is the error page');
      // A driver with no network visibility must not invent a status.
      const plain = await makeBrowserTools({ driver: fakeDriver() }).tools.find(t => t.name === 'browser.navigate').run({ url: 'https://example.com' }, {});
      A.ok(!/HTTP/.test(plain.content), 'a driver without network visibility claims no status (truthful telemetry)');
    }
  }

  // ---- ATTENDED BROWSER LOGIN (browser.login): human-driven headed takeover on the persistent
  //      station profile, bracketed by two live consent asks; unattended runs refuse. ----
  {
    const mkLease = () => {
      const l = { acquired: 0, released: 0, ok: true };
      l.profile = { dir: '/station-profile', acquire: () => { if (!l.ok) return false; l.acquired++; return true; }, release: () => { l.released++; } };
      return l;
    };
    const mkSeam = () => {
      const made = [];
      const makeDriver = (d) => {
        const drv = fakeDriver();
        drv.headed = !!d.headed; drv.profileDir = d.profileDir; drv.cleanupProfile = d.cleanupProfile;
        drv.synthetic = d.syntheticInputOnly; drv.visible = () => !!d.headed; drv.close = () => { drv.closed = true; };
        made.push(drv); return drv;
      };
      return { made, makeDriver };
    };

    // 1. UNATTENDED RUNS REFUSE: no attendedLogin dep (cron/hub/night-shift) -> honest error, no window.
    {
      const seam = mkSeam();
      const B2 = makeBrowserTools({ makeDriver: seam.makeDriver });
      await rejects(B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com/login' }, {}),
        /watched COMMS session|unattended/i, 'browser.login refuses without the attended channel');
      A.eq(seam.made.length, 0, 'an unattended login attempt never launches any browser');
    }

    // 2. ENV-PINNED HEADLESS REFUSES before any consent ask or window.
    {
      const seam = mkSeam();
      const B2 = makeBrowserTools({ makeDriver: seam.makeDriver, env: { STARNET_BROWSER_HEADLESS: '1' }, attendedLogin: { prompt: async () => 'once' } });
      await rejects(B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com' }, {}),
        /pins the browser headless/i, 'env headless pin refuses a login window');
      A.eq(seam.made.length, 0, 'env-pinned headless never launches a headed browser');
    }

    // 3. URL guard applies BEFORE any prompt: private hosts never reach the Commander.
    {
      let prompts = 0;
      const seam = mkSeam();
      const B2 = makeBrowserTools({ makeDriver: seam.makeDriver, attendedLogin: { prompt: async () => { prompts++; return 'once'; } } });
      await rejects(B2.tools.find(t => t.name === 'browser.login').run({ url: 'http://192.168.0.5/router' }, {}),
        /private\/loopback\/intranet/i, 'login URL rides the same SSRF guard as navigate');
      A.eq(prompts, 0, 'a refused URL never generates a consent ask');
    }

    // 4. COMMANDER DECLINES: no window, honest content back to the model.
    {
      const seam = mkSeam();
      const asked = [];
      const B2 = makeBrowserTools({ makeDriver: seam.makeDriver, attendedLogin: { prompt: async f => { asked.push(f.tool); return 'deny'; } } });
      const out = await B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com/login' }, {});
      A.eq(asked, ['browser.login'], 'a declined open ask never proceeds to the done-wait');
      A.ok(/declined/i.test(out.content), 'declined login reports honestly');
      A.eq(seam.made.length, 0, 'declined login never launches a browser');
    }

    // 5. FULL APPROVED FLOW: headed relaunch on the persistent profile with shims OFF, done-wait,
    //    then headless restore with shims back ON — same profile, refs invalidated, lease held.
    {
      const seam = mkSeam();
      const lease = mkLease();
      const asked = [];
      const B2 = makeBrowserTools({
        makeDriver: seam.makeDriver, forceHeadless: true, syntheticInputOnly: true,
        persistentProfile: lease.profile,
        attendedLogin: { prompt: async f => { asked.push({ tool: f.tool, host: f.argsSummary }); return 'once'; } }
      });
      const out = await B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com/login' }, {});
      A.eq(asked.map(a => a.tool), ['browser.login', 'browser.login.done'], 'both consent phases ride the live channel in order');
      A.eq(asked[0].host, 'erank.com', 'the consent ask names the host, not the full URL');
      A.eq(seam.made.length, 2, 'login = one headed launch + one headless restore');
      A.eq(seam.made[0].headed, true, 'the login window is headed');
      A.eq(seam.made[0].synthetic, false, 'the human-driven window carries NO synthetic-input shims (SSO popups must work)');
      A.eq(seam.made[0].profileDir, '/station-profile', 'the login window uses the persistent station profile');
      A.eq(seam.made[0].cleanupProfile, false, 'the persistent profile is never marked for cleanup');
      A.eq(seam.made[0].closed, true, 'the headed window is torn down after Done');
      A.eq(seam.made[1].headed, false, 'after Done the browser is headless again');
      A.eq(seam.made[1].profileDir, '/station-profile', 'the restored headless browser keeps the authenticated profile');
      A.ok(/finished logging in/i.test(out.content), 'completed login reports honestly');
      A.ok(lease.acquired >= 1 && lease.released === 0, 'the profile lease is held for the rest of the run');
      await B2.session.close();
      A.ok(lease.released >= 1, 'session close releases the profile lease');
    }

    // 6. LEASE CONTENTION: another run holds the profile -> honest error, no window.
    {
      const seam = mkSeam();
      const lease = mkLease(); lease.ok = false;
      const B2 = makeBrowserTools({ makeDriver: seam.makeDriver, persistentProfile: lease.profile, attendedLogin: { prompt: async () => 'once' } });
      await rejects(B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com' }, {}),
        /in use by another agent run/i, 'a held profile lease refuses the login honestly');
      A.eq(seam.made.length, 0, 'lease contention never opens a window');
    }

    // 7. HEADLESS-ONLY BINARY: window impossible -> restore headless posture, honest error.
    {
      const made = [];
      const B2 = makeBrowserTools({
        makeDriver: (d) => { const drv = fakeDriver(); drv.headed = !!d.headed; drv.visible = () => false; drv.close = () => {}; made.push(drv); return drv; },
        attendedLogin: { prompt: async () => 'once' }
      });
      await rejects(B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com' }, {}),
        /visible login window is impossible/i, 'a headless-only binary reports the truth instead of pretending a window exists');
      A.eq(made.length, 2 , 'the failed headed attempt is restored to headless');
      A.eq(made[1].headed, false, 'restore after headless-only failure is headless');
    }

    // 8. DONE-WAIT CANCELLED: window closes, honest "unconfirmed" content (cookies may exist).
    {
      const seam = mkSeam();
      let n = 0;
      const B2 = makeBrowserTools({ makeDriver: seam.makeDriver, persistentProfile: mkLease().profile, attendedLogin: { prompt: async () => (++n === 1 ? 'once' : 'deny') } });
      const out = await B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com' }, {});
      A.ok(/without a Done confirmation/i.test(out.content), 'a cancelled done-wait reports unconfirmed honestly');
      A.eq(seam.made[seam.made.length - 1].headed, false, 'cancelled login still restores headless mode');
    }

    // 9. ORDINARY RESEARCH RUNS reuse the persistent profile when free (signed-in browsing), and
    //    fall back to the ephemeral per-run profile when another run holds the lease.
    {
      const seam = mkSeam();
      const lease = mkLease();
      const B2 = makeBrowserTools({ makeDriver: seam.makeDriver, forceHeadless: true, profileDir: '/ephemeral', persistentProfile: lease.profile });
      await B2.session.navigate('https://example.com');
      A.eq(seam.made[0].profileDir, '/station-profile', 'a plain research run browses on the station profile (saved logins apply)');
      A.eq(seam.made[0].headed, false, 'the persistent profile never changes the headless posture');
      A.eq(seam.made[0].cleanupProfile, false, 'the persistent profile is not cleaned up by a research run');

      const seam2 = mkSeam();
      const held = mkLease(); held.ok = false;
      const B3 = makeBrowserTools({ makeDriver: seam2.makeDriver, forceHeadless: true, profileDir: '/ephemeral', persistentProfile: held.profile });
      await B3.session.navigate('https://example.com');
      A.eq(seam2.made[0].profileDir, '/ephemeral', 'a held lease falls back to the ephemeral per-run profile');
    }

    // 10. browser.login carries a long tool timeout (it wraps two human-paced consent waits).
    {
      const B2 = makeBrowserTools({ driver: fakeDriver() });
      const t = B2.tools.find(x => x.name === 'browser.login');
      A.ok(t.timeoutMs >= 30 * 60 * 1000, 'login tool timeout outlives the fail-closed consent timers');
      A.eq(t.requiresConsent, false, 'login runs its OWN two-phase consent (no double prompt)');
      A.eq(t.capability, 'web', 'login rides the web capability (dish object), no new grant surface');
    }
  }

  A.report('browser.test');
})();
