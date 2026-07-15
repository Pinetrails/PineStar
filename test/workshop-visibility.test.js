/* node test/workshop-visibility.test.js — the "it never tells me what it did" fix (2026-07-14).

   A night-shift build lands while the Commander is away BY DEFINITION, so the live card + toast play to
   an empty room. Pre-fix, the frontend WorkshopStore then persisted its seen/later ledger to localStorage,
   so the undecided deliverable was filtered out of every future attach poll: pending server-side, invisible
   forever. This proves the three legs of the fix over the real store with injected fakes:

     1. SESSION-SCOPED LEDGER — a prior session's persisted seen/later is ignored; the attach poll re-offers
        the oldest UNDECIDED deliverable every session until the Commander decides.
     2. RETURN RE-PRESENT — presentOnReturn() (wired to AutopilotStore's genuine-return hook) re-offers an
        undecided deliverable even if its card already rendered this session; an explicit 'later' still
        silences it for the rest of the session (anti-nag), and server-decided work drops out.
     3. LIVE PUSH — onBuilt presents toast + card once per runId (the duplicate-event guard holds).

   Plus source-guards for the browser-only wiring: chat.js's one-live-card-per-runId dedupe (data-wsrun),
   app.js's onReturn → WorkshopStore.presentOnReturn bridge, and autopilotstore.js's deps.onReturn call. */
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
// a PRIOR SESSION's persisted ledger (the pre-fix bug): both pending runs already "seen", one later'd.
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
let cards = [];
global.Chat = { workshopReturn: (m, o) => { cards.push({ m: m, o: o }); } };
let toasts = [];
global.StationUI = { notify: (msg, kind, cat) => toasts.push({ msg: msg, kind: kind, cat: cat }) };

const { WorkshopStore } = require('../frontend/app/workshopstore.js');

(async () => {
  /* ---------- 1. the attach poll IGNORES a prior session's persisted ledger ---------- */
  WorkshopStore.init({ enabled: true, agentIds: () => ['agent'] });
  await new Promise(r => setTimeout(r, 2300));   // past ATTACH_DELAY_MS (1800)
  A.eq(cards.length, 1, 'attach poll presents exactly ONE return card');
  A.eq(cards[0].m.runId, 'run-A', 'the OLDEST undecided deliverable is re-offered — a prior session\'s seen/later ledger is IGNORED (session-scoped)');

  /* ---------- 2a. presentOnReturn re-offers even a card already shown THIS session ---------- */
  cards = [];
  await WorkshopStore.presentOnReturn();
  A.eq(cards.length, 1, 'return-from-away re-presents an undecided deliverable');
  A.eq(cards[0].m.runId, 'run-A', 'the session "seen" mark does not hide it — shown-to-nobody must not count as told');

  /* ---------- 2b. an explicit LATER silences it for the rest of THIS session ---------- */
  await WorkshopStore.decide('agent', 'run-A', 'later');
  cards = [];
  await WorkshopStore.presentOnReturn();
  A.eq(cards.length, 1, 'the return re-present moves on to the next undecided deliverable');
  A.eq(cards[0].m.runId, 'run-B', 'a later\'d card stays dismissed this session (anti-nag) — the NEXT undecided one is offered');

  /* ---------- 2c. server-decided work drops out entirely ---------- */
  pending = [];
  cards = [];
  await WorkshopStore.presentOnReturn();
  A.eq(cards.length, 0, 'nothing pending server-side → no card, no fabricated beat (fail-open)');

  /* ---------- 3. the live workshop.built push: toast + card, once per runId ---------- */
  cards = []; toasts = [];
  const builtPayload = { agentId: 'agent', runId: 'run-C', manifest: { title: 'fresh build', files: [] } };
  WorkshopStore.onBuilt(builtPayload);
  A.eq(cards.length, 1, 'a live build presents its return card immediately');
  A.eq(cards[0].m.runId, 'run-C', 'the card carries the built run');
  A.eq(toasts.length, 1, 'the live build announces ONE toast');
  A.ok(/built while you were away/.test(toasts[0].msg), 'the toast says what happened');
  A.eq(toasts[0].cat, 'cronDigest', 'the toast stays in the Commander-mutable autonomous category (P1-8 mute works)');
  WorkshopStore.onBuilt(builtPayload);
  A.eq(cards.length, 1, 'a duplicate workshop.built event never double-presents (seen guard)');

  /* ---------- 4. the ledger never persists (the root regression) ---------- */
  A.eq(mem.get('starnet.workshop.v1'), STALE, 'no session state was written back to localStorage — the ledger is in-memory only');

  /* ---------- 5. source-guards for the browser-only wiring (not node-loadable) ---------- */
  const chatSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
  A.ok(/setAttribute\('data-wsrun'/.test(chatSrc), 'chat.js tags each workshop return card with its runId (data-wsrun)');
  A.ok(/\.workshop-return\[data-wsrun=/.test(chatSrc), 'chat.js drops the stale duplicate card before re-presenting (one live card per deliverable)');

  const appSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
  A.ok(/onReturn:\s*\(\)\s*=>/.test(appSrc), 'app.js wires the genuine-return hook into AutopilotStore');
  A.ok(/WorkshopStore\.presentOnReturn/.test(appSrc), 'app.js routes the return hook to WorkshopStore.presentOnReturn');

  const apSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/autopilotstore.js'), 'utf8');
  A.ok(/deps\.onReturn/.test(apSrc), 'autopilotstore.js fires deps.onReturn on a genuine return (independent of the local draft log)');

  A.report('workshop-visibility.test');
})();
