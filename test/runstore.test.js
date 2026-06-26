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

// ---- H. model identity is durable; subscription runs are explicitly unmetered ----
{
  const s = makeRunStore({ io: memIo(), clock });
  const e = s.record({ runId: 'm1', agentId: 'a', model: '  gpt-5.5  ', unmetered: true, usd: 0, tokens: 900000 });
  A.eq(e.model, 'gpt-5.5', 'model is trimmed and recorded');
  A.eq(e.unmetered, true, 'unmetered flag is recorded');
  A.eq(s.list('a')[0].model, 'gpt-5.5', 'list surfaces model identity');
  A.eq(s.record({ runId: 'm2', agentId: 'a', model: '' }).model, '(unknown)', 'empty model becomes explicit unknown');
}

A.report('runstore.test');
