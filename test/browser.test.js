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
    'browser.login', 'browser.navigate', 'browser.press', 'browser.scroll', 'browser.snapshot',
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

  /* ---- a STALLED navigation must not poison the session (2026-07-25, from a real user report) ----
     Page.navigate does not resolve until the navigation commits, so a slow or challenge-walled origin blew
     the 15s command budget and threw "CDP timeout: Page.navigate". Nothing cancelled the load, so the
     renderer stayed busy and the NEXT tool call (browser.snapshot's Runtime.evaluate) queued behind it and
     timed out too — the user saw both fail and read it as "the browser is broken". */
  {
    // The CDP client unrefs its timeout timers, so while awaiting a deliberately-stalled navigation there
    // is nothing left holding the event loop open and node would EXIT mid-test with code 0 — scoring green
    // having verified nothing. (_assert.js now catches that, but the cure is to hold the loop open.)
    const keepAlive = setInterval(() => {}, 50);
    const sent = [];
    let currentUrl = 'about:blank';
    let stall = true;
    class StallWS {
      constructor() { this.h = {}; setTimeout(() => this.fire('open', {}), 0); }
      addEventListener(n, f) { (this.h[n] = this.h[n] || []).push(f); }
      fire(n, v) { for (const f of this.h[n] || []) f(v); }
      send(raw) {
        const m = JSON.parse(raw); sent.push(m);
        if (m.method === 'Page.navigate') { currentUrl = m.params.url; if (stall) return; }   // never answers
        const value = m.method === 'Runtime.evaluate' ? currentUrl : undefined;
        const result = m.method === 'Runtime.evaluate' ? { result: { value } } : {};
        setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
      }
      close() {}
    }
    const d = T.makeCdpDriver({
      chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: false,
      timeoutMs: 400, navTimeoutMs: 800, cdpPort: 9361,
      fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://stall' }] }),
      WebSocketImpl: StallWS,
      // kill() must actually signal 'close', or session.close() rightly refuses to believe Chromium exited.
      spawn: () => { let onClose = null; return { pid: 7, on(ev, fn) { if (ev === 'close') onClose = fn; }, kill() { if (onClose) queueMicrotask(() => onClose(0)); } }; }
    });

    let navErr = null;
    try { await d.navigate('https://slow.example.com/listing/1'); } catch (e) { navErr = e; }
    A.ok(!!navErr, 'a stalled navigation still fails rather than hanging forever');
    A.ok(!/CDP timeout/.test(navErr.message), 'the raw "CDP timeout: Page.navigate" no longer reaches the agent');
    A.ok(/did not finish loading/.test(navErr.message), 'the error says what actually happened');
    A.ok(/slow\.example\.com/.test(navErr.message), 'the error names the host that stalled');
    A.ok(/web_request|get_text/.test(navErr.message), 'the error offers a next move');
    A.ok(sent.some(m => m.method === 'Page.stopLoading'), 'THE FIX: the stalled load is cancelled so the renderer is freed');

    // the session must be usable immediately afterwards — this is the half the user actually lost
    const after = await d.snapshot(5);
    A.ok(after !== undefined, 'the NEXT call succeeds instead of inheriting the wedge');
    stall = false;
    A.eq(await d.navigate('https://example.com/'), 'https://example.com/', 'a later healthy navigation still works');
    await d.close();
    clearInterval(keepAlive);
  }

  /* The driver's navigation budget must stay UNDER browser.navigate's tool budget. If the outer tool
     timeout fired first it would abort run() mid-flight and the stopLoading recovery above would never
     happen — re-creating the exact wedge. Locked here because the two numbers live in different places. */
  {
    const navTool = makeBrowserTools({ existsSync: () => false, WebSocketImpl: null }).tools
      .find(t => t.name === 'browser.navigate');
    A.ok(navTool.timeoutMs >= 45000, 'browser.navigate gets a larger tool budget than other browser tools');
    const others = makeBrowserTools({ existsSync: () => false, WebSocketImpl: null }).tools
      .filter(t => t.name !== 'browser.navigate' && t.name !== 'browser.login');
    A.ok(others.every(t => t.timeoutMs < navTool.timeoutMs), 'and it is the longest of the ordinary browser tools');
  }

  A.report('browser.test');
})();
