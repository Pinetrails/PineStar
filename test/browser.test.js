/* node test/browser.test.js - browser automation contract:
   action surface, URL/redirect guards, snapshot refs, consent flags,
   capability projection, and graceful Chromium-missing errors. */
'use strict';
const A = require('./_assert.js');
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
  const log = { clicked: [], typed: [], pressed: [], scrolled: [], navigated: [] };
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
    screenshot: async () => Buffer.from('png').toString('base64')
  };
}

(async () => {
  // URL guard
  A.notThrows(() => T.assertSafeUrl('https://example.com/path'), 'public HTTPS URL is allowed');
  A.throws(() => T.assertSafeUrl('http://localhost:3000'), 'localhost URL is blocked');
  A.throws(() => T.assertSafeUrl('http://192.168.0.5'), 'private IPv4 URL is blocked');
  A.throws(() => T.assertSafeUrl('https://printer.lan'), 'intranet suffix URL is blocked');

  const driver = fakeDriver();
  const B = makeBrowserTools({ driver, vision: async ({ question }) => 'vision answer: ' + question });
  const names = B.tools.map(t => t.name).sort();
  A.eq(names, [
    'browser.back', 'browser.click', 'browser.console', 'browser.dialog', 'browser.get_text',
    'browser.navigate', 'browser.press', 'browser.scroll', 'browser.snapshot', 'browser.type', 'browser.vision'
  ], 'browser action surface is complete');
  A.eq(B.tools.find(t => t.name === 'browser.click').requiresConsent, true, 'click is consent-gated');
  A.eq(B.tools.find(t => t.name === 'browser.snapshot').requiresConsent, false, 'snapshot is read-only');

  // navigate + redirect guard
  {
    const out = await B.tools.find(t => t.name === 'browser.navigate').run({ url: 'https://example.com' }, {});
    A.ok(/https:\/\/example\.com/.test(out.content), 'navigate returns the final public URL');
    await rejects(B.session.navigate('https://redirect-private.example'), /blocked unsafe redirect/, 'unsafe redirect is refused explicitly');
  }

  // refs expire after the next snapshot
  {
    const snap = await B.tools.find(t => t.name === 'browser.snapshot').run({}, {});
    A.ok(/b1 \[button\] Search/.test(snap.content), 'snapshot returns stable element refs');
    const click = await B.tools.find(t => t.name === 'browser.click').run({ ref: 'b1' }, {});
    A.ok(/clicked Search/.test(click.content), 'click uses a snapshot ref');
    await B.session.snapshot();
    await rejects(B.session.click('b1'), /stale browser ref/, 'old refs expire after a new snapshot');
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
    const mkSession = (env) => T.makeBrowserSession({
      env: env || {},
      makeDriver: (d) => { const drv = fakeDriver(); drv.headed = !!d.headed; drv.visible = () => !!d.headed; drv.close = () => { drv.closed = true; }; made.push(drv); return drv; }
    });

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
  }

  // the tool surface: browser.navigate accepts visible and reports visibility truthfully
  {
    const made = [];
    const B2 = makeBrowserTools({
      makeDriver: (d) => { const drv = fakeDriver(); drv.headed = !!d.headed; drv.visible = () => !!d.headed; drv.close = () => {}; made.push(drv); return drv; }
    });
    const nav = B2.tools.find(t => t.name === 'browser.navigate');
    A.ok(nav.schema.properties.visible, 'browser.navigate exposes the visible flag');
    A.ok(/HEADLESS BY DEFAULT/i.test(nav.description), 'the description states the headless default');
    const r1 = await nav.run({ url: 'https://example.com' }, {});
    A.ok(/headless — not visible/.test(r1.content), 'a research navigate reports headless honestly');
    const r2 = await nav.run({ url: 'https://example.com', visible: true }, {});
    A.ok(/visible window/.test(r2.content), 'a visible:true navigate reports the window on screen');
    A.eq(made.map(d => d.headed), [false, true], 'headless first, headed only on request');
  }

  A.report('browser.test');
})();
