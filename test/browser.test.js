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
    'browser.navigate', 'browser.press', 'browser.scroll', 'browser.snapshot', 'browser.test_input',
    'browser.test_navigate', 'browser.test_snapshot', 'browser.test_state', 'browser.type', 'browser.vision'
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
    A.ok(/unavailable/i.test(un.content) && /OpenRouter key|vision model/i.test(un.content), 'unavailable content says what would enable it');
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
  A.ok(/keyboard/.test(T.SYNTHETIC_INPUT_BOOTSTRAP) && /lock/.test(T.SYNTHETIC_INPUT_BOOTSTRAP), 'isolation bootstrap neutralizes keyboard lock');
  A.ok(/Object\.freeze\(attestation\)/.test(T.SYNTHETIC_INPUT_BOOTSTRAP), 'page code cannot forge the synthetic-isolation ready attestation');
  A.ok(/getOwnPropertyDescriptor\(Element\.prototype,'requestPointerLock'\)/.test(T.makeCdpDriver.toString()), 'navigation verifies the actual non-writable pointer-lock descriptor');

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
      spawn: (exe, args) => { privateLaunches.push(args); fs.writeFileSync(path.join(privateProfile, 'DevToolsActivePort'), '45678\n/devtools/browser/private\n'); return fakeProc(44); }
    });
    await privatePort.navigate('http://127.0.0.1:5173/');
    A.ok(privateLaunches[0].includes('--remote-debugging-port=0'), 'production mode asks Chromium for an ephemeral CDP port');
    A.ok(fetched.some(u => /127\.0\.0\.1:45678\/json\/list/.test(u)), 'driver attaches only through the port written by its private profile');
    A.eq(privatePort.attachedPort(), 45678, 'driver reports the privately owned attached port');
    await privatePort.close();
    fs.rmSync(privateProfile, { recursive: true, force: true });
  }

  A.report('browser.test');
})();
