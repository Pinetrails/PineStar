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
  schema: 'starnet.save', version: 1,
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

/* ---------- title upgrade: retitle replaces the placeholder; a manual rename locks it forever ---------- */
W.reset();
const tg = W.generalId();
const up = W.create(null);
A.eq(up.titleAuto, true, 'a fresh stream starts title-auto (eligible for the summary upgrade)');
A.ok(W.autoTitle(up.id, 'help me find a budget mechanical keyboard') === true, 'instant placeholder set from first message');
A.eq(up.titleAuto, true, 'the auto placeholder keeps the stream eligible for the upgrade');
A.ok(W.retitle(up.id, '  Budget   Keyboard Hunt  ') === true, 'retitle upgrades the auto placeholder');
A.eq(up.title, 'Budget Keyboard Hunt', 'retitle collapses whitespace and applies the summary');
A.eq(up.titleAuto, true, 'still auto after a machine upgrade (a later refine could re-run)');
A.ok(W.rename(up.id, 'My Keyboard Project') === true, 'manual rename applies');
A.eq(up.titleAuto, false, 'a manual rename LOCKS the title (titleAuto=false)');
A.ok(W.retitle(up.id, 'Something Else') === false, 'retitle never stomps a manually-renamed title');
A.eq(up.title, 'My Keyboard Project', 'the human title survives a later upgrade attempt');
A.ok(W.retitle(tg, 'General Summary') === false, 'General is never titled by an upgrade');
A.eq(W.get(tg).title, null, 'General stays untitled (the chat home)');
A.ok(W.retitle(up.id, '   ') === false && up.title === 'My Keyboard Project', 'an empty summary is a no-op');
const dumpedAuto = JSON.parse(JSON.stringify(W.serialize()));
W.init(dumpedAuto);
A.eq(W.get(up.id).titleAuto, false, 'titleAuto survives a save/load round-trip (the manual lock persists)');

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

/* ---------- multi-agent: create({agentId}) binds, setAgent re-binds, both reject a bad id ---------- */
W.reset();
const def = W.create('hero stream');
A.eq(def.agentId, 'agent', 'a stream defaults to the hero agentId');
const sum = W.create('researcher stream', { agentId: 'researcher-2' });
A.eq(sum.agentId, 'researcher-2', 'create({agentId}) binds the stream to a summoned agent');
const activeBeforeScout = W.activeId();
const scout = W.create('scout stream', { agentId: 'scout-3', activate: false });
A.eq(scout.agentId, 'scout-3', 'create({agentId, activate:false}) binds the inactive specialist stream');
A.eq(W.activeId(), activeBeforeScout, 'creating an inactive specialist stream does NOT hijack active COMMS');
A.ok(W.setAgent(def.id, 'analyst_7') === true, 'setAgent re-binds a stream to another agent');
A.eq(W.get(def.id).agentId, 'analyst_7', 'the new binding is stored');
A.ok(W.setAgent(def.id, '../evil') === false, 'setAgent rejects a non-conforming agentId (path-safety)');
A.eq(W.get(def.id).agentId, 'analyst_7', 'a rejected setAgent leaves the prior binding intact');
A.ok(W.setAgent('nope', 'researcher-2') === false, 'setAgent on an unknown stream -> false');

/* ---------- adopt(id): caller-chosen id, idempotent, never hijacks active (the cron-session seam) ---------- */
W.reset();
const activeBeforeAdopt = W.activeId();
const cronId = 'cron-2f1a9c00-1111-4222-8333-444455556666';
const ad = W.adopt({ id: cronId, title: 'Daily digest', agentId: 'cron_daily', lane: 'active', history: [{ role: 'user', content: 'summarize the day' }] });
A.eq(ad.id, cronId, 'adopt uses the caller-chosen id verbatim');
A.eq(ad.title, 'Daily digest', 'adopt carries the title');
A.eq(ad.agentId, 'cron_daily', 'adopt binds the routine agent');
A.eq(ad.lane, 'active', 'adopt honors the lane');
A.eq(ad.history.length, 1, 'adopt seeds history');
A.eq(W.activeId(), activeBeforeAdopt, 'adopt does NOT hijack the active stream (appears without stealing focus)');
A.ok(W.list().some(x => x.id === cronId), 'the adopted stream is listed');
const ad2 = W.adopt({ id: cronId, title: 'different title' });
A.ok(ad2 === ad, 'adopt is idempotent — re-adopting the same id returns the existing record untouched');
A.eq(W.get(cronId).title, 'Daily digest', 'a re-adopt never stomps the existing title/history');

/* ---------- TASK-BOARD TRUTH: kind field ('task' = board card, 'chat' = rail-only session) ---------- */
W.reset();
// create() defaults to 'chat' — a plain new stream (summon/newWorkstream) is a session, not a board task.
const chatWs = W.create('plain session');
A.eq(chatWs.kind, 'chat', 'create() defaults kind to chat (a session is not a board task)');
// create({kind:'task'}) mints a board card (addTask / recipe mission / goal milestone / /background).
const taskWs = W.create('board directive', { kind: 'task', activate: false });
A.eq(taskWs.kind, 'task', 'create({kind:task}) mints a board task');
A.eq(taskWs.lane, 'todo', 'a new task still starts in to-do');
// appendRun advances a task todo->active but the kind is unchanged (still a board card while running).
A.ok(W.appendRun(taskWs.id, 'run_t1') === true, 'appendRun files the run on the task');
A.eq(taskWs.lane, 'active', 'appendRun still advances todo->active');
A.eq(taskWs.kind, 'task', 'a run does NOT change kind — a task stays a task while in progress');
// a chat that gets a run auto-advances to active too, but must NEVER become a board task.
A.ok(W.appendRun(chatWs.id, 'run_c1') === true, 'appendRun files the run on the chat');
A.eq(chatWs.lane, 'active', 'a chat with a real run auto-advances todo->active (rail state)');
A.eq(chatWs.kind, 'chat', 'a run does NOT promote a chat to a task (it stays off the board)');

/* ---------- init() upgrade inference for PRE-UPGRADE saves (no kind field) ---------- */
// A saved slice from before this change carries no `kind`. Infer: the two lanes only a deliberate board action
// can produce (todo/shipped) => task; everything else (active sessions, General) => chat.
W.init({
  workstreams: [
    { id: 'ws_general', title: null, lane: 'active' },      // General (no kind) -> chat
    { id: 'old_todo', title: 'queued task', lane: 'todo' },   // a board card that never ran -> task
    { id: 'old_shipped', title: 'finished task', lane: 'shipped' }, // a shipped card -> task
    { id: 'old_active', title: 'ran session', lane: 'active' }       // an auto-advanced session -> chat
  ],
  activeId: 'ws_general', generalId: 'ws_general'
});
A.eq(W.get('ws_general').kind, 'chat', 'upgrade infer: General (active, no kind) -> chat');
A.eq(W.get('old_todo').kind, 'task', 'upgrade infer: a todo card with no kind -> task');
A.eq(W.get('old_shipped').kind, 'task', 'upgrade infer: a shipped card with no kind -> task');
A.eq(W.get('old_active').kind, 'chat', 'upgrade infer: an active (auto-advanced) session with no kind -> chat');

/* ---------- kind is preserved verbatim through serialize/init (no re-inference on a saved kind) ---------- */
// a chat card that was manually pushed to a board lane (todo/shipped) still round-trips as chat — the saved
// kind wins over the lane inference, so init never re-classifies a record that already declared its kind.
W.init({
  workstreams: [
    { id: 'ws_general', title: null, lane: 'active', kind: 'chat' },
    { id: 'kept_task', title: 'a task in active', lane: 'active', kind: 'task' },   // task in active lane, kept
    { id: 'kept_chat', title: 'a chat in todo', lane: 'todo', kind: 'chat' }         // chat in todo lane, kept
  ],
  activeId: 'ws_general', generalId: 'ws_general'
});
A.eq(W.get('kept_task').kind, 'task', 'a saved kind:task in the active lane is kept (not re-inferred to chat)');
A.eq(W.get('kept_chat').kind, 'chat', 'a saved kind:chat in the todo lane is kept (not re-inferred to task)');
const dumpedKind = JSON.parse(JSON.stringify(W.serialize()));
W.init(dumpedKind);
A.eq(W.get('kept_task').kind, 'task', 'kind survives a serialize/init round-trip (task)');
A.eq(W.get('kept_chat').kind, 'chat', 'kind survives a serialize/init round-trip (chat)');

A.report('workstreams.test');
