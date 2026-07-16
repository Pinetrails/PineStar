/* node test/workshop-visibility.test.js — SESSION DELIVERY for idle-work deliverables (2026-07-15).

   Two locked behaviors, per Andrew:
     A. An automated (idle) build must NEVER pop its card into whatever session the Commander has open.
        Every deliverable gets its OWN workstream ('workshop-<runId>' — the shift's durable streamId),
        adopted UNREAD in the rail, focus untouched. The card renders ONLY when that session is opened
        (chat.js load() → WorkshopStore.presentFor), pinned to it via opts.sessionId.
     B. The 2026-07-14 honesty laws survive the reshape: a prior session's persisted seen/later ledger is
        ignored (session-scoped), undecided = still owed (re-surfaced every session until decided), an
        explicit 'later' stays quiet for the session, and a duplicate workshop.built never double-delivers.

   Proven over the real store with injected fakes (Workstreams/Chat/StationUI/fetch), plus source-guards
   for the browser-only wiring: chat.js load() calls presentFor, the card is session-pinned, and app.js
   still routes the genuine-return hook to WorkshopStore.presentOnReturn. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

/* ---------- fakes ---------- */
const mem = new Map();
global.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k)
};
// a PRIOR SESSION's persisted ledger (the pre-2026-07-14 bug): both pending runs already "seen", one later'd.
const STALE = JSON.stringify({ v: 1, later: { 'run-A': true }, seen: ['run-A', 'run-B'] });
mem.set('starnet.workshop.v1', STALE);

let pending = [
  { runId: 'run-A', title: 'older build', files: [] },
  { runId: 'run-B', title: 'newer build', files: [] }
];
let decides = [];
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.indexOf('/api/workshop/pending') === 0) return { ok: true, json: async () => ({ pending: pending.slice() }) };
  if (u.indexOf('/api/workshop/decide') === 0) { decides.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true }) }; }
  return { ok: false, json: async () => null };
};

// a minimal Workstreams fake with the REAL unread semantics (lastActiveAt > lastReadAt, never the active stream)
const streams = new Map();
let activeStreamId = 'ws_general';
global.Workstreams = {
  adopt(opts) {
    if (streams.has(opts.id)) return streams.get(opts.id);
    const w = Object.assign({ history: [] }, opts);
    streams.set(w.id, w);
    return w;
  },
  get(id) { return streams.get(id) || null; },
  touch(id) { const w = streams.get(id); if (w) { w.lastActiveAt = Date.now(); if (id === activeStreamId) w.lastReadAt = w.lastActiveAt; } return !!w; },
  unread(w) { w = (w && w.id) ? w : streams.get(w); return !!w && w.id !== activeStreamId && (w.lastActiveAt || 0) > (w.lastReadAt || 0); }
};

let cards = [];
global.Chat = { workshopReturn: (m, o) => { cards.push({ m: m, o: o }); } };
let toasts = [];
global.StationUI = { notify: (msg, kind, cat) => toasts.push({ msg: msg, kind: kind, cat: cat }) };

const { WorkshopStore } = require('../frontend/app/workshopstore.js');

(async () => {
  /* ---------- A1. the attach poll adopts ONE UNREAD SESSION PER deliverable — and NO card into the open feed ---------- */
  WorkshopStore.init({ enabled: true, agentIds: () => ['agent'] });
  await new Promise(r => setTimeout(r, 2300));   // past ATTACH_DELAY_MS (1800)
  A.eq(cards.length, 0, 'attach delivers NO card into whatever session is selected — session delivery, not pop-ups');
  A.ok(streams.has('workshop-run-A') && streams.has('workshop-run-B'), 'every undecided deliverable got its own session (a prior session\'s persisted seen/later ledger is IGNORED)');
  A.ok(Workstreams.unread(streams.get('workshop-run-A')), 'the delivery session lands UNREAD in the rail');
  A.eq(activeStreamId, 'ws_general', 'focus was never stolen from the Commander\'s open stream');
  A.ok((streams.get('workshop-run-A').history || []).some(m2 => m2 && m2.sys), 'the session opens with an honest sys marker, never fabricated agent speech');

  /* ---------- A2. the card renders ONLY when its session is opened (presentFor), pinned to it ---------- */
  cards = [];
  await WorkshopStore.presentFor('workshop-run-A');
  A.eq(cards.length, 1, 'opening the delivery session presents its return card');
  A.eq(cards[0].m.runId, 'run-A', 'the card carries THAT session\'s deliverable');
  A.eq(cards[0].o.sessionId, 'workshop-run-A', 'the card is PINNED to its own session (chat.js refuses to paint it elsewhere)');
  cards = [];
  await WorkshopStore.presentFor('ws_general');
  A.eq(cards.length, 0, 'a non-delivery session id never presents a card');
  await WorkshopStore.presentFor('workshop-run-GONE');
  A.eq(cards.length, 0, 'a decided/unknown run presents nothing (server truth, fail-open)');

  /* ---------- B1. return-from-away re-surfaces UNDECIDED work by bumping its session, never a pop-up ---------- */
  const wsA = streams.get('workshop-run-A');
  wsA.lastReadAt = Date.now() + 1;   // simulate: the Commander read it, then went away
  await new Promise(r => setTimeout(r, 5));
  cards = [];
  await WorkshopStore.presentOnReturn();
  A.eq(cards.length, 0, 'the genuine-return hook injects no card anywhere');
  A.ok(Workstreams.unread(wsA), 'an undecided deliverable\'s session goes unread again on a genuine return — undecided = still owed');

  /* ---------- B2. an explicit LATER stays quiet for the session; an explicit OPEN still shows the card ---------- */
  await WorkshopStore.decide('agent', 'run-A', 'later');
  A.ok(decides.some(d => d.runId === 'run-A' && d.decision === 'later'), 'later reached the server');
  wsA.lastReadAt = Date.now() + 1;
  await new Promise(r => setTimeout(r, 5));
  await WorkshopStore.presentOnReturn();
  A.ok(!Workstreams.unread(wsA), 'a later\'d deliverable is not re-bumped on return (anti-nag)');
  cards = [];
  await WorkshopStore.presentFor('workshop-run-A');
  A.eq(cards.length, 1, 'but deliberately OPENING its session still shows the card — an explicit open is the opposite of nagging');

  /* ---------- B3. the live workshop.built push: unread session + ONE toast, once per runId ---------- */
  cards = []; toasts = [];
  const builtPayload = { agentId: 'agent', runId: 'run-C', manifest: { title: 'fresh build', files: [] } };
  WorkshopStore.onBuilt(builtPayload);
  A.eq(cards.length, 0, 'a live build never pops a card into the open stream');
  A.ok(streams.has('workshop-run-C'), 'a live build adopts its own session immediately');
  A.ok(Workstreams.unread(streams.get('workshop-run-C')), 'the live-built session lands unread');
  A.eq(toasts.length, 1, 'the live build announces ONE toast');
  A.ok(/built while you were away/.test(toasts[0].msg), 'the toast says what happened');
  A.eq(toasts[0].cat, 'cronDigest', 'the toast stays in the Commander-mutable autonomous category (P1-8 mute works)');
  WorkshopStore.onBuilt(builtPayload);
  A.eq(toasts.length, 1, 'a duplicate workshop.built event never double-delivers (seen guard)');

  /* ---------- B4. the ledger never persists (the 2026-07-14 root regression) ---------- */
  A.eq(mem.get('starnet.workshop.v1'), STALE, 'no session state was written back to localStorage — the ledger is in-memory only');

  /* ---------- C. source-guards for the browser-only wiring (not node-loadable) ---------- */
  const chatSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
  A.ok(/WorkshopStore\.presentFor/.test(chatSrc), 'chat.js load() routes a freshly opened session through WorkshopStore.presentFor');
  A.ok(/opts\.sessionId/.test(chatSrc) && /inOwnSession/.test(chatSrc), 'chat.js pins the delivery card to its own session (never another stream\'s feed)');
  A.ok(/setAttribute\('data-wsrun'/.test(chatSrc), 'chat.js tags each delivery card with its runId (data-wsrun)');
  A.ok(/\.workshop-return\[data-wsrun=/.test(chatSrc), 'chat.js drops a stale duplicate card before re-presenting (one live card per deliverable)');
  A.ok(!/folder to copy into/.test(chatSrc), 'the folder-picker Keep flow is gone from the card (simplified: message + Implement/Later/Discard)');
  A.ok(/Implement/.test(chatSrc), 'the card offers the one-click Implement decision');

  const appSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
  A.ok(/onReturn:\s*\(\)\s*=>/.test(appSrc), 'app.js wires the genuine-return hook into AutopilotStore');
  A.ok(/WorkshopStore\.presentOnReturn/.test(appSrc), 'app.js routes the return hook to WorkshopStore.presentOnReturn');

  const apSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/autopilotstore.js'), 'utf8');
  A.ok(/deps\.onReturn/.test(apSrc), 'autopilotstore.js fires deps.onReturn on a genuine return (independent of the local draft log)');

  A.report('workshop-visibility.test');
})();
