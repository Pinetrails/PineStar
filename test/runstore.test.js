/* node test/runstore.test.js — the append-only run-history store (M-save P4).
   An in-memory io proves: a run outcome round-trips, the reason is clamped to the known enum, the title is
   length-capped, list() returns newest-first filtered by agentId and respects the limit, ts comes from the
   injected clock, and the on-disk log is replayed into a fresh store. Pure + deterministic. */
'use strict';
const A = require('./_assert.js');
const { makeRunStore } = require('../sidecar/runstore.js');

// in-memory io mirroring the host's JSONL adapter (readAll + append).
function memIo() {
  const lines = [];
  return { lines, readAll() { return lines.slice(); }, append(e) { lines.push(e); } };
}
let clk = 1000;
const clock = { now: () => clk };

// ---- A. record stamps ts from the clock, returns the entry, persists it ----
{
  const io = memIo();
  const s = makeRunStore({ io, clock });
  clk = 1111;
  const e = s.record({ runId: 'r1', agentId: 'agent', reason: 'done', turns: 3, tokens: 500, usd: 0.02, title: 'fix the bug' });
  A.eq(e.runId, 'r1', 'runId recorded');
  A.eq(e.reason, 'done', 'reason recorded');
  A.eq(e.ts, 1111, 'ts stamped from injected clock');
  A.eq(s.count(), 1, 'one row');
  A.eq(io.lines.length, 1, 'appended to io');
}

// ---- B. reason clamped to the known enum; unknown -> 'done' ----
{
  const s = makeRunStore({ io: memIo(), clock });
  A.eq(s.record({ runId: 'r', reason: 'refusal' }).reason, 'refusal', 'valid reason kept');
  A.eq(s.record({ runId: 'r', reason: 'budget' }).reason, 'budget', 'budget reason kept');
  A.eq(s.record({ runId: 'r', reason: 'kaboom' }).reason, 'done', 'unknown reason clamped to done');
  A.eq(s.record({ runId: 'r' }).reason, 'done', 'missing reason defaults to done');
}

// ---- C. title is length-capped (no unbounded blob on disk) ----
{
  const s = makeRunStore({ io: memIo(), clock });
  const e = s.record({ runId: 'r', title: 'x'.repeat(500) });
  A.ok(e.title.length <= 120, 'title capped to 120 chars');
}

// ---- D. list(): newest-first, filtered by agentId, limit respected ----
{
  const s = makeRunStore({ io: memIo(), clock });
  clk = 1; s.record({ runId: 'a1', agentId: 'A' });
  clk = 2; s.record({ runId: 'b1', agentId: 'B' });
  clk = 3; s.record({ runId: 'a2', agentId: 'A' });
  const A_runs = s.list('A');
  A.eq(A_runs.map(r => r.runId), ['a2', 'a1'], 'agent A runs newest-first');
  A.eq(s.list('B').map(r => r.runId), ['b1'], 'agent B filtered');
  A.eq(s.list(null).length, 3, 'no agentId -> all runs');
  A.eq(s.list('A', { limit: 1 }).map(r => r.runId), ['a2'], 'limit respected (newest)');
  A.eq(s.list('NONE'), [], 'unknown agent -> empty');
}

// ---- E. durable: a fresh store replays the on-disk log ----
{
  const io = memIo();
  let s = makeRunStore({ io, clock });
  s.record({ runId: 'r1', agentId: 'agent', reason: 'done' });
  s.record({ runId: 'r2', agentId: 'agent', reason: 'error' });
  s = makeRunStore({ io, clock });   // rebuilt from the same io
  A.eq(s.count(), 2, 'history replayed into a fresh store');
  A.eq(s.list('agent').map(r => r.runId), ['r2', 'r1'], 'replayed order intact');
}

// ---- F. corrupt/missing log -> empty history, record still works (fail-open) ----
{
  const bad = { readAll() { throw new Error('corrupt'); }, append() {} };
  const s = makeRunStore({ io: bad, clock });
  A.eq(s.count(), 0, 'corrupt log -> empty');
  A.eq(s.record({ runId: 'r', reason: 'done' }).runId, 'r', 'record still works over a corrupt log');
}

// ---- G. (H3.2) a run records its streamId so the RUNS row can open its transcript ----
{
  const s = makeRunStore({ io: memIo(), clock });
  const e = s.record({ runId: 'r9', agentId: 'a', reason: 'done', streamId: 'general' });
  A.eq(e.streamId, 'general', 'record stores the run\'s streamId');
  A.eq(s.list('a')[0].streamId, 'general', 'list surfaces streamId (join key to GET /api/transcript)');
  A.eq(s.record({ runId: 'r10', agentId: 'a' }).streamId, '', 'a streamless run -> empty streamId (no crash)');
}

// ---- G2. recipe provenance spine: a recipe-launched run records WHICH recipe fired it (additive) ----
{
  const s = makeRunStore({ io: memIo(), clock });
  const e = s.record({ runId: 'rp1', agentId: 'a', reason: 'done', recipeId: 'morning-brief' });
  A.eq(e.recipeId, 'morning-brief', 'record stores the launching recipeId');
  A.eq(s.list('a')[0].recipeId, 'morning-brief', 'list surfaces recipeId (the outcome-loop join key)');
  A.eq(s.record({ runId: 'rp2', agentId: 'a' }).recipeId, '', 'a non-recipe run -> empty recipeId (old rows fail-open)');
  A.eq(s.record({ runId: 'rp3', agentId: 'a', recipeId: 'x'.repeat(200) }).recipeId.length, 60, 'recipeId is clamped to 60 chars');
}

// ---- H. model identity is durable; subscription runs are explicitly unmetered ----
{
  const s = makeRunStore({ io: memIo(), clock });
  const e = s.record({ runId: 'm1', agentId: 'a', model: '  gpt-5.5  ', unmetered: true, usd: 0, tokens: 900000 });
  A.eq(e.model, 'gpt-5.5', 'model is trimmed and recorded');
  A.eq(e.unmetered, true, 'unmetered flag is recorded');
  A.eq(s.list('a')[0].model, 'gpt-5.5', 'list surfaces model identity');
  A.eq(s.record({ runId: 'm2', agentId: 'a', model: '' }).model, '(unknown)', 'empty model becomes explicit unknown');
}

// ---- I. (work-visibility) artifacts ride the entry: sanitized, capped, [] default ----
{
  const io = memIo();
  const s = makeRunStore({ io, clock });
  const e = s.record({ runId: 'w1', agentId: 'a', reason: 'done', artifacts: [
    { kind: 'file', path: 'report.md', bytes: 2150 },
    { kind: 'image', path: 'images/gen-ab.png' },
    { kind: 'message', target: 'telegram' },
    { kind: 'bogus', path: 'nope' },                    // unknown kind dropped
    { kind: 'file' },                                    // no path/target -> dropped
    'garbage', null                                      // non-objects dropped
  ] });
  A.eq(e.artifacts, [
    { kind: 'file', path: 'report.md', bytes: 2150 },
    { kind: 'image', path: 'images/gen-ab.png' },
    { kind: 'message', target: 'telegram' }
  ], 'artifacts sanitized to known kinds with path/target/bytes only');
  A.eq(s.record({ runId: 'w2', agentId: 'a' }).artifacts, [], 'missing artifacts defaults to []');
  A.eq(s.record({ runId: 'w3', agentId: 'a', artifacts: 'nope' }).artifacts, [], 'non-array artifacts defaults to []');
  const big = s.record({ runId: 'w4', agentId: 'a', artifacts: Array.from({ length: 80 }, (_, i) => ({ kind: 'file', path: 'f' + i })) });
  A.eq(big.artifacts.length, 50, 'artifacts capped at 50 records');
  const long = s.record({ runId: 'w5', agentId: 'a', artifacts: [{ kind: 'file', path: 'x'.repeat(999) }] });
  A.ok(long.artifacts[0].path.length <= 260, 'artifact path capped at 260 chars');
  A.eq(io.lines[0].artifacts.length, 3, 'artifacts persisted on the appended JSONL row');
  // ---- (crate-honesty) toolsOk rides the row: proven work count, 0 default ----
  A.eq(s.record({ runId: 'w6', agentId: 'a', reason: 'done', toolsOk: 4 }).toolsOk, 4, 'toolsOk recorded on the row');
  A.eq(s.record({ runId: 'w7', agentId: 'a', reason: 'done' }).toolsOk, 0, 'missing toolsOk defaults to 0 (old rows under-claim, never over)');
  A.eq(s.record({ runId: 'w8', agentId: 'a', toolsOk: 'nope' }).toolsOk, 0, 'non-numeric toolsOk clamps to 0');

  // ---- (P1.2 identity-honesty) identityFallback rides the row: honest marker when the agentId missed the roster ----
  A.eq(s.record({ runId: 'w9', agentId: 'a', reason: 'done', identityFallback: true }).identityFallback, true, 'identityFallback:true recorded on a fallback run (was not the named specialist)');
  A.eq(s.record({ runId: 'w10', agentId: 'a', reason: 'done' }).identityFallback, false, 'missing identityFallback defaults to false (old rows / normal runs are not falsely flagged)');
  A.eq(s.record({ runId: 'w11', agentId: 'a', identityFallback: 1 }).identityFallback, true, 'truthy identityFallback coerces to a strict boolean');
}

// ---- J. (work-visibility) OLD JSONL rows WITHOUT artifacts still parse + list (fail-open) ----
{
  const io = memIo();
  // legacy rows, written before the artifacts field existed (exactly the pre-slice entry shape)
  io.lines.push({ runId: 'old1', agentId: 'a', reason: 'done', turns: 2, tokens: 10, usd: 0.01, title: 't', streamId: '', model: 'm', unmetered: false, ts: 5 });
  io.lines.push({ runId: 'old2', agentId: 'a', reason: 'error', turns: 0, tokens: 0, usd: 0, title: '', streamId: '', model: 'm', unmetered: false, ts: 6 });
  const s = makeRunStore({ io, clock });
  A.eq(s.count(), 2, 'legacy rows replay into the store');
  const rows = s.list('a');
  A.eq(rows.map(r => r.runId), ['old2', 'old1'], 'legacy rows list newest-first, unchanged');
  A.ok(!('artifacts' in rows[0]) || Array.isArray(rows[0].artifacts), 'a legacy row is served as-is (no crash, no fabricated field)');
  const e = s.record({ runId: 'new1', agentId: 'a', artifacts: [{ kind: 'file', path: 'n.txt' }] });
  A.eq(e.artifacts, [{ kind: 'file', path: 'n.txt' }], 'new records alongside legacy rows carry artifacts');
  A.eq(s.list('a').map(r => r.runId), ['new1', 'old2', 'old1'], 'mixed old/new history lists together');
}

// ---- K. delegated-session delivery is durable enough for a page that was closed or stale to heal later ----
{
  const s = makeRunStore({ io: memIo(), clock });
  const e = s.record({
    runId: 'delegated-1', agentId: 'researcher', reason: 'done', streamId: 'ws_server_copy',
    sessionTitle: 'business research session',
    deliveryPrompt: 'research three AI businesses',
    deliveryText: 'three sourced ideas'
  });
  A.eq(e.sessionTitle, 'business research session', 'the Commander-visible session name is durable');
  A.eq(e.deliveryPrompt, 'research three AI businesses', 'the delegated instruction is durable for the framing marker');
  A.eq(e.deliveryText, 'three sourced ideas', 'the final answer is durable for missed-page replay');
  A.eq(s.record({ runId: 'plain' }).sessionTitle, '', 'ordinary runs carry no fake delivery target');
  A.eq(s.record({ runId: 'capped', sessionTitle: 's'.repeat(300), deliveryPrompt: 'p'.repeat(5000), deliveryText: 't'.repeat(100000) }).sessionTitle.length, 80, 'session title is bounded');
  A.ok(s.list(null)[0].deliveryPrompt.length <= 4000, 'delivery prompt is bounded');
  A.ok(s.list(null)[0].deliveryText.length <= 24000, 'delivery result is bounded');
}

// ---- RAM mirror trim: the in-process rows array is bounded; disk keeps the full log; recent list unaffected ----
{
  const io = memIo();
  const s = makeRunStore({ io, clock, ramMax: 50 });   // tiny cap for the test
  for (let i = 0; i < 200; i++) s.record({ runId: 'r' + i, agentId: 'a', reason: 'done', usd: 1, title: 't' + i });
  A.eq(s.count(), 50, 'RAM mirror is bounded to ramMax (oldest spliced off)');
  A.eq(io.lines.length, 200, 'disk kept EVERY appended row (only RAM was trimmed)');
  const recent = s.list('a', { limit: 10 });
  A.eq(recent[0].runId, 'r199', 'newest run still listed after trimming');
  A.eq(recent[9].runId, 'r190', 'the last 10 are intact');
  const s2 = makeRunStore({ io, clock, ramMax: 50 });
  A.eq(s2.count(), 50, 'a boot load over the cap is trimmed at construction too');
  A.eq(s2.list('a', { limit: 1 })[0].runId, 'r199', 'the trimmed boot load keeps the NEWEST rows');
}

A.report('runstore.test');
