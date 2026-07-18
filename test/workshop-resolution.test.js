/* test/workshop-resolution.test.js — the deliverable session must ALWAYS tell the truth on open.

   THE BUG THIS LOCKS OUT (2026-07-18): a 'workshop-<runId>' session's stub line promises "open this
   session any time to review and decide", but when the run stopped being pending server-side (decided
   from another surface/origin, files wiped, workspace moved) presentFor() went TOTALLY SILENT — the
   Commander opened the session and saw only the naked stub, which read as a broken/old UI (no card,
   no Open-it, no decisions, no explanation). Truthful telemetry says the session must state what
   actually happened, from server truth (the deliverable lifecycle library), or honestly say the files
   are gone — and must stay SILENT only when the station is unreachable (never assert an unproven
   resolution).

   Proven over the real store with injected fakes (Workstreams/Chat/fetch), same harness style as
   workshop-visibility.test.js. */
'use strict';
const A = require('./_assert.js');

/* ---------- fakes ---------- */
const mem = new Map();
global.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k)
};

let pending = [];            // rows served by /api/workshop/pending
let libraryRows = [];        // rows served by /api/deliverables
let pendingUnreachable = false;   // simulate a dead station for the pending probe
global.fetch = async (url) => {
  const u = String(url);
  if (u.indexOf('/api/workshop/pending') === 0) {
    if (pendingUnreachable) throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => ({ pending: pending.slice() }) };
  }
  if (u.indexOf('/api/deliverables') === 0) return { ok: true, json: async () => ({ ok: true, items: libraryRows.slice() }) };
  return { ok: false, json: async () => null };
};

const streams = new Map();
let activeStreamId = 'ws_general';
global.Workstreams = {
  adopt(opts) { if (streams.has(opts.id)) return streams.get(opts.id); const w = Object.assign({ history: [] }, opts); streams.set(w.id, w); return w; },
  get(id) { return streams.get(id) || null; },
  touch(id) { return streams.has(id); },
  activeId() { return activeStreamId; }
};

let cards = [];
global.Chat = { workshopReturn: (m, o) => { cards.push({ m: m, o: o }); } };
let persists = 0;
global.App = { persist: () => { persists++; }, refreshRail: () => {} };

const { WorkshopStore } = require('../frontend/app/workshopstore.js');

const sysLines = (id) => (streams.get(id).history || []).filter(m => m && m.sys).map(m => String(m.content));
const seedSession = (runId, extraHistory) => {
  streams.set('workshop-' + runId, {
    id: 'workshop-' + runId, agentId: 'agent', history: [
      { role: 'system', sys: true, content: '⚒ built while you were away — “x”. open this session any time to review and decide.' }
    ].concat(extraHistory || [])
  });
};

(async () => {
  WorkshopStore.init({ enabled: false, agentIds: () => ['agent'] });   // enabled:false = no attach poll; we drive presentFor directly

  /* ---------- 1. still pending → the full card renders, no resolution marker ---------- */
  seedSession('run-P');
  pending = [{ runId: 'run-P', title: 'still owed', files: [] }];
  await WorkshopStore.presentFor('workshop-run-P');
  A.eq(cards.length, 1, 'a still-pending run presents its return card on open');
  A.eq(cards[0].o.sessionId, 'workshop-run-P', 'the card stays pinned to its own session');
  A.ok(!sysLines('workshop-run-P').some(c => c.indexOf('◈') === 0), 'no resolution marker while the run is genuinely pending');

  /* ---------- 2. not pending + a KEPT lifecycle row → the honest decided line, exactly once ---------- */
  seedSession('run-K');
  pending = [];
  libraryRows = [{ id: 'workshop:agent:run-K', agentId: 'agent', runId: 'run-K', status: 'kept', title: 'kept build' }];
  cards = [];
  await WorkshopStore.presentFor('workshop-run-K');
  A.eq(cards.length, 0, 'a decided run never re-presents a card');
  A.ok(sysLines('workshop-run-K').some(c => c.indexOf('◈ decided — ') === 0 && c.indexOf('KEPT') >= 0), 'the session states the KEPT outcome from server truth');
  A.ok(persists > 0, 'the resolution line is persisted (durable across reloads)');
  await WorkshopStore.presentFor('workshop-run-K');   // reopen
  A.eq(sysLines('workshop-run-K').filter(c => c.indexOf('◈ decided — ') === 0).length, 1, 'reopening never stacks a second resolution line');

  /* ---------- 3. not pending + a DISCARDED row → says discarded ---------- */
  seedSession('run-D');
  libraryRows = [{ id: 'workshop:agent:run-D', agentId: 'agent', runId: 'run-D', status: 'discarded', title: 'gone build' }];
  await WorkshopStore.presentFor('workshop-run-D');
  A.ok(sysLines('workshop-run-D').some(c => c.indexOf('◈ decided — ') === 0 && c.indexOf('DISCARDED') >= 0), 'a discarded build says so');

  /* ---------- 4. not pending + NO record anywhere → the honest "nothing left to review" line ---------- */
  seedSession('run-G');
  libraryRows = [];
  await WorkshopStore.presentFor('workshop-run-G');
  A.ok(sysLines('workshop-run-G').some(c => c.indexOf('◈ nothing left to review — ') === 0), 'a vanished build gets the honest no-record line (never silence, never a guess)');

  /* ---------- 5. the session already tells the story (live-card decision marker) → no double-tell ---------- */
  seedSession('run-M', [{ role: 'system', sys: true, content: '✓ implemented — files saved to C:/somewhere' }]);
  await WorkshopStore.presentFor('workshop-run-M');
  A.ok(!sysLines('workshop-run-M').some(c => c.indexOf('◈') === 0), 'a session that already carries its ✓ decision marker gets no extra resolution line');

  /* ---------- 6. station unreachable → SILENCE (never assert a resolution the server didn't prove) ---------- */
  seedSession('run-U');
  pendingUnreachable = true;
  await WorkshopStore.presentFor('workshop-run-U');
  A.ok(!sysLines('workshop-run-U').some(c => c.indexOf('◈') === 0), 'an unreachable station appends NOTHING — fail-open stays honest');
  pendingUnreachable = false;

  A.report('workshop-resolution');
})().catch(e => { console.error(e); process.exit(1); });
