/* node test/connector-required.test.js — beginner seam Lane 1: "connector_required" at the moment of need.

   1) SIDECAR: a tool call against a connector that is not wired STILL throws the historic
      'connector "<id>" is not connected' error (the model needs the text), and ALSO emits a structured
      connector_required {runId, connectorId, kind, reason, toolName} on the run's own emit (ctx.emit) —
      validated against the frozen shared/events.js contract. Both the unknown-id and the known-but-down
      paths fire it; a healthy call fires nothing. The ctx rides through makeMcpToolDef's run(args, ctx).
   2) FRONTEND: Friendly.connectorDoor(ev) builds the post-run chip ("⇄ CONNECT GMAIL — 2 clicks") whose
      run() opens ABILITIES on the CATALOG section and pre-fills the console search with the connector id
      (the existing "what are you trying to connect?" router window), re-asserting the filter until the
      async catalog has rendered a card.
   3) chat.js SEAM (source lock — chat.js is DOM flow and not require-able): the bus listener is wired at
      init, the chip is offered from the run-end branch ONLY on a clean end, through the same choices()
      row offerRetry uses (one post-run layer), and the listener's catch is never bare. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeConnectorManager } = require('../sidecar/mcp/manager.js');
const { makeMcpToolDef } = require('../sidecar/mcp/translate.js');

function stack(opts) {
  opts = opts || {};
  return {
    makeTransport: () => ({ send() {}, onMessage() {}, close() {} }),
    makeClient: () => ({
      initialize: () => opts.failInit ? Promise.reject(new Error('server down')) : Promise.resolve({}),
      listTools: () => Promise.resolve([{ name: 'send_email' }]),
      callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'sent' }] }),
      close() {}
    })
  };
}
function ctxFor(runId) {
  const emitted = [];
  return { runId, emit: (name, payload) => emitted.push({ name, payload }), emitted };
}

(async () => {
  // ---------- 1a. unknown connector id: throw + event ----------
  {
    const m = makeConnectorManager(Object.assign({ makeToolDef: makeMcpToolDef, timeoutMs: 1000 }, stack()));
    const ctx = ctxFor('run-1');
    let err = null;
    try { await m.call('gmail', 'send_email', { to: 'x' }, ctx); } catch (e) { err = e; }
    A.ok(err && /connector "gmail" is not connected/.test(err.message), 'the historic not-connected error still throws');
    A.eq(ctx.emitted.length, 1, 'exactly one event rides the run emit');
    const ev = ctx.emitted[0];
    A.eq(ev.name, 'connector_required', 'event name');
    A.eq(ev.payload, { runId: 'run-1', connectorId: 'gmail', kind: 'mcp', reason: 'connector "gmail" is not connected', toolName: 'send_email' }, 'structured payload');
    const v = events.validate(ev.name, ev.payload);
    A.ok(v.ok, 'payload validates against shared/events.js: ' + JSON.stringify(v.errors || []));
  }
  // ---------- 1b. known connector whose server is DOWN: same event through the tool def's run(args, ctx) ----------
  {
    const seen = [];
    const m = makeConnectorManager(Object.assign({ makeToolDef: makeMcpToolDef, timeoutMs: 1000, onEvent: e => seen.push(e) }, stack({ failInit: true })));
    const r = await m.configure('gmail', { transport: 'http', url: 'https://mcp.example/gmail' });
    A.eq(r.ok, false, 'connector configured but its server refused to start');
    const ctx = ctxFor('run-2');
    let err = null;
    try { await m.call('gmail', 'send_email', {}, ctx); } catch (e) { err = e; }
    A.ok(err && /not connected/.test(err.message), 'down connector throws not-connected');
    A.eq(ctx.emitted.map(e => e.name), ['connector_required'], 'down connector emits connector_required on the run');
    A.eq(ctx.emitted[0].payload.runId, 'run-2', 'runId comes from the dispatch ctx');
    A.ok(seen.some(e => e.type === 'connector_required' && e.connectorId === 'gmail'), 'the host onEvent sees it too (boot log line)');
  }
  // ---------- 1c. the tool def threads ctx into the manager; a healthy call emits NOTHING ----------
  {
    const m = makeConnectorManager(Object.assign({ makeToolDef: makeMcpToolDef, timeoutMs: 1000 }, stack()));
    const r = await m.configure('gmail', { transport: 'http', url: 'https://mcp.example/gmail' });
    A.eq(r.ok, true, 'healthy connector is up');
    const defs = m.toolDefsFor('gmail');
    const def = defs.find(d => /send_email/.test(d.name));
    A.ok(def, 'the projected tool def exists');
    const ctx = ctxFor('run-3');
    const res = await def.run({ to: 'x' }, ctx);
    A.ok(/sent/.test(res.content), 'healthy call returns the server result');
    A.eq(ctx.emitted.length, 0, 'a healthy call emits no connector_required');
    // no ctx at all (a caller outside a run) still throws cleanly and never crashes on the missing emit
    let err = null;
    try { await m.call('nope', 'x', {}); } catch (e) { err = e; }
    A.ok(err && /not connected/.test(err.message), 'ctx-less caller still gets the throw');
    // the catch around the emit is NOT fail-open: a throwing emit still yields the same error, with the loss pinned on it
    const bad = { runId: 'run-4', emit: () => { throw new Error('bus dead'); } };
    err = null;
    try { await m.call('nope', 'x', {}, bad); } catch (e) { err = e; }
    A.ok(err && /not connected/.test(err.message), 'a throwing emit never changes the error the model sees');
    A.eq(err.telemetryLost, ['emit: bus dead'], 'the lost event is pinned on the error (the catch fires, and says so)');
  }
  // ---------- 1d. the ratchet: the emit sites are try-wrapped but NEVER a bare silent promise catch ----------
  {
    const src = fs.readFileSync(path.join(__dirname, '../sidecar/mcp/manager.js'), 'utf8');
    const body = A.fnBody(src, 'function notConnected(');
    A.ok(body.length > 50 && body.length < 2000, 'notConnected helper is present and bounded');
    A.ok(/ctx\.emit\('connector_required'/.test(body), 'the helper emits connector_required on the run ctx');
    A.ok(/onEvent\(Object\.assign\(\{ type: 'connector_required' \}/.test(body), 'the helper reports to the host onEvent');
    A.ok(!/\.catch\(/.test(body), 'no promise .catch in the helper (sync try/catch only — nothing to swallow)');
  }

  // ---------- 2. the chip door (friendlyerror.js is require-able) ----------
  {
    const Friendly = require('../frontend/app/friendlyerror.js');
    A.eq(Friendly.connectorChipLabel({ connectorId: 'gmail' }), '⇄ CONNECT GMAIL — 2 clicks', 'chip label');
    A.eq(Friendly.connectorChipLabel({ connectorId: 'google-calendar' }), '⇄ CONNECT GOOGLE CALENDAR — 2 clicks', 'dashes read as spaces');
    A.eq(Friendly.connectorDoor({}), null, 'no connector id -> no chip (never an empty door)');
    const door = Friendly.connectorDoor({ runId: 'r', connectorId: 'gmail', kind: 'mcp', reason: 'x', toolName: 'send_email' });
    A.eq(door.connectorId, 'gmail', 'door names its connector');
    // run(): opens the ABILITIES window on CATALOG and pre-fills the console search
    const opened = [];
    const inputEvents = [];
    const input = { value: '', dispatchEvent: e => inputEvents.push(e.type) };
    const list = { closest: () => ({ querySelector: sel => sel === '.con-search-in' ? input : null }), querySelector: sel => sel === '.cc-card' ? {} : null };
    const timers = [];
    global.StationUI = { openTerm: (k, s) => opened.push([k, s]) };
    global.document = { querySelector: sel => sel === '#cc-list' ? list : null, defaultView: { Event: function (type) { this.type = type; } } };
    try {
      A.eq(door.run(), true, 'run() reports it opened the door');
      A.eq(opened, [['connectors', 'catalog']], 'opens ABILITIES on the CATALOG section (the router window)');
      A.eq(input.value, 'gmail', 'console search pre-filled with the connector id');
      A.eq(inputEvents, ['input'], 'search filter fired once a card exists');
      // catalog not rendered yet: the filter re-arms on a timer until a card appears (bounded)
      const listEmpty = { closest: list.closest, querySelector: () => null };
      global.document.querySelector = sel => sel === '#cc-list' ? listEmpty : null;
      Friendly.routeConsoleSearch(global.document, 'gmail', (fn, ms) => timers.push({ fn, ms }));
      A.eq(timers.length, 1, 'no card yet -> one re-assert timer armed');
      A.eq(timers[0].ms, 250, 'poll cadence');
      for (let i = 0; i < 20 && timers.length; i++) { const t = timers.shift(); t.fn(); }
      A.ok(timers.length === 0, 'the re-assert loop is bounded (stops without a card)');
    } finally { delete global.StationUI; delete global.document; }
    // no StationUI at all (a test/headless context) -> false, never a throw
    A.eq(door.run(), false, 'run() without StationUI is a clean false');
  }

  // ---------- 3. chat.js seam (source lock) ----------
  {
    const src = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
    const wire = A.fnBody(src, 'function wireConnectorRequired(');
    A.ok(wire.length > 50 && wire.length < 1500, 'wireConnectorRequired exists and is bounded');
    A.ok(/U\.bus\.on\('connector_required'/.test(wire), 'chat subscribes to connector_required on U.bus');
    A.ok(!/\.catch\(/.test(wire) && !/catch\s*\(\s*_?\w*\s*\)\s*\{\s*\}/.test(wire), 'the listener has no bare catch');
    A.ok(/wireConnectorRequired\(\);/.test(src), 'the listener is wired at init');
    const offer = A.fnBody(src, 'function offerConnectorDoor(');
    A.ok(offer.length > 50 && offer.length < 1500, 'offerConnectorDoor exists and is bounded');
    A.ok(/Friendly\.connectorDoor\(ev\)/.test(offer), 'the chip comes from Friendly.connectorDoor (one door source)');
    A.ok(/choices\(\[\{ label: door\.label, value: 'connect' \}\], \(\) => door\.run\(\)\)/.test(offer), 'rendered through the shared choices() row (one post-run layer)');
    A.ok(/CONNECTOR_NEEDED\.delete\(runId\)/.test(offer), 'the pending event is consumed once offered');
    // offered from the run-end branch, on a CLEAN end only (a stopped run owns the slot with its retry chip)
    A.ok(/if \(isActiveWs\(ws\) && !taskQuestion && \(!endReason \|\| endReason === 'done'\)\) offerConnectorDoor\(thisRunId\);/.test(src),
      'offered at run end, active stream, clean end only');
    const callAt = src.indexOf('offerConnectorDoor(thisRunId)');
    const stopAt = src.indexOf("if (endReason === 'budget') offerBudgetDoor(); else offerTryAgain();");
    A.ok(stopAt > 0 && callAt > stopAt, 'the connect offer sits AFTER the stop-reason branch in the same run-end block');
  }
  A.report('connector-required.test');
})().catch(e => { console.error(e); process.exit(1); });
