/* node test/workstreams.test.js — the unified session record (frontend/app/workstreams.js).
   Locks the slice-1 promises: v1->v2 migration is lossless (legacy convo becomes General, cost
   seeded from real usage, agent/usage untouched at root — verified here at the slice level),
   the General default always exists, per-stream cost is isolated (no double-count), and lanes are
   hybrid-honest (a real run auto-advances todo->active; 'shipped' is only ever set deliberately). */
'use strict';
const A = require('./_assert.js');
const W = require('../frontend/app/workstreams.js');

/* ---------- migrateV1: lossless v1 -> v2 workstreams slice ---------- */
const V1 = {
  schema: 'skynet.save', version: 1,
  agent: { id: 'agent', name: 'ULTRON', model: 'anthropic/claude-sonnet-4.5' },
  history: [
    { role: 'user', content: 'what is my purpose?' },
    { role: 'assistant', content: 'to serve, Commander.' }
  ],
  usage: { tokens: 1200, cost: 0.0345, calls: 3 },
  updatedAt: 1700000000000
};
const slice = W.migrateV1(V1);
A.eq(slice.workstreams.length, 1, 'migrate -> exactly one General workstream');
const g0 = slice.workstreams[0];
A.eq(slice.activeId, 'ws_general', 'activeId is the General id');
A.eq(slice.generalId, 'ws_general', 'generalId is the General id');
A.eq(g0.title, null, 'General is untitled (title null)');
A.eq(g0.lane, 'active', 'General lane = active');
A.eq(g0.history, V1.history, 'history carried over identically (by value)');
A.eq(g0.cost, { tokens: 1200, usd: 0.0345, calls: 3 }, 'cost SEEDED from lifetime usage (cost->usd)');
A.eq(g0.roomId, null, 'dormant roomId builder seam present and null');
A.ok(g0.history !== V1.history, 'history is a copy, not aliasing the save doc');
A.ok(!('agent' in slice) && !('usage' in slice), 'slice carries only workstream state; agent/usage stay at root');

/* ---------- init from the migrated slice, then a fresh init ---------- */
A.eq(W.init(slice).id, 'ws_general', 'init returns the active (General) workstream');
A.eq(W.list().length, 1, 'one stream after migrate+init');
A.eq(W.active().history.length, 2, 'active stream has the resumed history');
A.eq(W.generalId(), 'ws_general', 'generalId preserved through init');

W.init(null);
A.eq(W.list().length, 1, 'init(null) mints a fresh General');
A.eq(W.active().title, null, 'fresh General is untitled');
A.ok(W.generalId() === W.activeId(), 'fresh: active === general');

/* ---------- create / switch / auto-title ---------- */
W.reset();
const genId = W.generalId();
const a = W.create('Q3 research');
A.eq(W.activeId(), a.id, 'create makes the new stream active');
A.eq(a.lane, 'todo', 'a brand-new stream starts in to-do (no run yet)');
A.ok(a.id !== genId, 'new stream is distinct from General');
A.eq(W.list().length, 2, 'General + new stream');
A.ok(W.switch(genId).id === genId, 'switch flips the active stream');
A.eq(W.activeId(), genId, 'active is now General again');
const backlog = W.create('backlog item', { activate: false });
A.eq(W.activeId(), genId, 'create({activate:false}) does NOT hijack the active stream');
A.ok(W.list().some(x => x.id === backlog.id), 'the non-activating create still adds the stream');

const b = W.create(null);  // untitled "+ New"
A.ok(W.autoTitle(b.id, 'find the best budget mechanical keyboard under $80') === true, 'untitled stream auto-titles from first msg');
A.eq(b.title, 'find the best budget mechanical keyboard under $80', 'title = first sentence, kept whole under the cap');
A.ok(W.autoTitle(b.id, 'changed my mind') === false, 'already-titled stream is not re-titled');
A.ok(W.autoTitle(genId, 'hello there') === false, 'General never auto-titles (stays the chat home)');
A.eq(W.deriveTitle('  summarize   the\nnews! and more'), 'summarize the news', 'deriveTitle: collapse ws, first sentence');
const longT = W.deriveTitle('research the global semiconductor supply chain and write a detailed quarterly report');
A.ok(longT.length <= 61 && /…$/.test(longT) && !/ …$/.test(longT), 'long title trims at a word boundary with an ellipsis, no mid-word cut');
A.eq(W.deriveTitle('x'.repeat(90)).length, 61, 'an unbroken 90-char token hard-caps to 60 + ellipsis');

/* ---------- hybrid-honest lanes: a real run auto-advances todo->active ---------- */
W.reset();
const c = W.create('write a report');
A.eq(c.lane, 'todo', 'pre-run lane is to-do');
A.ok(W.appendRun(c.id, 'run_1') === true, 'appendRun files the runId');
A.eq(c.lane, 'active', 'first real run auto-advances to active');
A.ok(W.appendRun(c.id, 'run_1') === true, 'duplicate runId tolerated');
A.eq(c.runIds.length, 1, 'runIds deduped');
A.ok(W.appendRun(c.id, 'run_2') && c.runIds.length === 2, 'second distinct run appended');
A.eq(c.lane, 'active', 'further runs leave it active (not auto-shipped)');
A.ok(W.setLane(c.id, 'shipped') === true, "'shipped' is set deliberately");
A.eq(c.lane, 'shipped', 'lane is now shipped');
A.ok(W.setLane(c.id, 'bogus') === false, 'invalid lane rejected');

/* ---------- per-stream cost isolation (truthful telemetry, no double-count) ---------- */
W.reset();
const x = W.create('stream X'); const y = W.create('stream Y');
W.addCost(x.id, { tokens: 100, usd: 0.01, calls: 1 });
W.addCost(x.id, { tokens: 50, usd: 0.005, calls: 1 });
W.addCost(y.id, { tokens: 7, usd: 0.001, calls: 1 });
A.eq(W.costOf(x.id), { tokens: 150, usd: 0.015, calls: 2 }, 'X cost sums only X deltas');
A.eq(W.costOf(y.id), { tokens: 7, usd: 0.001, calls: 1 }, 'Y cost is isolated from X');

/* ---------- deliverables filed onto the stream ---------- */
W.recordDeliverable(x.id, { title: 'report.md', kind: 'file', runId: 'run_9', t: 1700000001000 });
A.eq(x.deliverables.length, 1, 'deliverable recorded');
A.eq(x.deliverables[0].title, 'report.md', 'deliverable title kept');
A.eq(x.deliverables[0].runId, 'run_9', 'deliverable runId synthesized by caller is stored');

/* ---------- pin / archive / delete protect General; active falls back ---------- */
W.reset();
const gen = W.generalId();
const m = W.create('mission');
A.ok(W.pin(m.id, true) && W.get(m.id).pinned, 'pin works');
A.ok(W.archive(gen, true) === false, 'General cannot be archived');
A.ok(W.del(gen) === false, 'General cannot be deleted');
W.switch(m.id);
A.ok(W.archive(m.id, true) === true, 'archive a normal stream');
A.eq(W.activeId(), gen, 'archiving the active stream falls back to General');
A.ok(W.list().every(w => w.id !== m.id), 'archived hidden from default list');
A.ok(W.list({ includeArchived: true }).some(w => w.id === m.id), 'archived findable with includeArchived');
const n = W.create('to-delete'); W.switch(n.id);
A.ok(W.del(n.id) === true && W.activeId() === gen, 'delete removes and falls back to General');

/* ---------- search over title + body ---------- */
W.reset();
const s = W.create('candle market');
s.history.push({ role: 'user', content: 'research the 2026 candle market and write candles.md' });
const hits = W.search('candles.md');
A.ok(hits.length === 1 && hits[0].id === s.id, 'search matches a message body');
A.ok(/candles\.md/.test(hits[0].snippet), 'search returns a snippet around the match');
A.ok(W.search('CANDLE MARKET').length === 1, 'search matches title, case-insensitive');
A.eq(W.search('   ').length, 0, 'blank query -> no hits');

/* ---------- importTasks: station kanban col -> lane, empty history ---------- */
W.reset();
const made = W.importTasks([
  { id: 't1', title: 'todo card', col: 'todo', t: 1 },
  { id: 't2', title: 'doing card', col: 'doing', t: 2 },
  { id: 't3', title: 'done card', col: 'done', t: 3 },
  { id: 't4', title: 'weird card', col: 'mystery', t: 4 }
]);
A.eq(made.map(w => w.lane), ['todo', 'active', 'shipped', 'todo'], 'col->lane map (unknown col -> todo)');
A.ok(made.every(w => w.history.length === 0), 'imported cards start with empty history');
A.ok(W.list().some(w => w.title === 'doing card'), 'imported cards become real workstreams in the store');

/* ---------- serialize round-trips ---------- */
W.reset(); W.create('round trip');
const dumped = W.serialize();
A.ok(Array.isArray(dumped.workstreams) && dumped.activeId && dumped.generalId, 'serialize shape');
const reactiveId = W.init(JSON.parse(JSON.stringify(dumped))).id;
A.eq(reactiveId, dumped.activeId, 'init(serialize()) preserves the active stream');
A.eq(W.list().length, 2, 'round-trip preserves both streams');

A.report('workstreams.test');
