/* node test/ledger.test.js — the append-only spend ledger, fed an in-memory io + a controllable clock
   (zero disk). Asserts: record stamps ts + persists, totals/day-window/per-run/per-agent queries, a
   prior log is loaded on construction, and corrupt io degrades to empty (never throws into a run). */
'use strict';
const A = require('./_assert.js');
const { makeLedger } = require('../sidecar/ledger.js');

// a fake io with an inspectable backing array + a clock we step by hand
function fakeIo(seed) { const rows = (seed || []).slice(); return { rows, readAll() { return rows.slice(); }, append(e) { rows.push(e); } }; }
let t = 1_000_000;
const clock = { now: () => t };

// ---- record stamps ts, persists through io, returns the entry ----
{
  const io = fakeIo();
  const L = makeLedger({ io, clock });
  const e = L.record({ runId: 'r1', agentId: 'a', turns: 3, usd: 0.5, tokens: 1200 });
  A.eq(e.ts, t, 'record stamps the injected clock time');
  A.eq(e.usd, 0.5, 'usd preserved');
  A.eq(io.rows.length, 1, 'entry persisted through io.append');
  A.eq(L.count(), 1, 'count reflects the recorded run');
  A.eq(io.rows[0].runId, 'r1', 'persisted entry carries the runId');
}

// ---- an explicit ts wins over the clock; missing/garbage fields coerce to safe zeros/strings ----
{
  const L = makeLedger({ io: fakeIo(), clock });
  A.eq(L.record({ runId: 'r', usd: 1, ts: 42 }).ts, 42, 'explicit ts is honored');
  const z = L.record({});
  A.eq([z.runId, z.agentId, z.turns, z.usd, z.tokens], ['', '', 0, 0, 0], 'absent fields coerce to safe defaults');
  A.eq(z.ts, t, 'absent ts falls back to the clock');
}

// ---- totals + scoped queries ----
{
  const L = makeLedger({ io: fakeIo(), clock });
  L.record({ runId: 'r1', agentId: 'alice', usd: 1.0, ts: t });
  L.record({ runId: 'r2', agentId: 'bob', usd: 2.0, ts: t });
  L.record({ runId: 'r1', agentId: 'alice', usd: 0.5, ts: t });   // same run, second turn-batch
  A.ok(Math.abs(L.totalUsd() - 3.5) < 1e-9, 'totalUsd sums every entry');
  A.ok(Math.abs(L.usdForRun('r1') - 1.5) < 1e-9, 'usdForRun sums one run across entries');
  A.ok(Math.abs(L.usdForAgent('alice') - 1.5) < 1e-9, 'usdForAgent sums one agent');
  A.ok(Math.abs(L.usdForAgent('bob') - 2.0) < 1e-9, 'usdForAgent isolates agents');
  A.eq(L.usdForRun('nope'), 0, 'unknown run -> 0');
}

// ---- usdForDay: only spend inside the trailing dayMs window counts ----
{
  const dayMs = 1000;   // tiny window for the test
  const L = makeLedger({ io: fakeIo(), clock, dayMs });
  L.record({ runId: 'old', usd: 5, ts: 100 });      // far in the past
  L.record({ runId: 'recent', usd: 2, ts: 9500 });  // inside the last 1000ms before now=10000
  t = 10_000;
  A.ok(Math.abs(L.usdForDay() - 2) < 1e-9, 'only spend within the trailing day window counts (now from clock)');
  A.eq(L.usdForDay(12000), 0, 'a later explicit "now" slides the window past every entry');
  A.ok(Math.abs(L.totalUsd() - 7) < 1e-9, 'totalUsd ignores the window');
  t = 1_000_000;
}

// ---- a prior on-disk log is loaded on construction ----
{
  const io = fakeIo([{ runId: 'pre', agentId: 'a', turns: 1, usd: 4, tokens: 10, ts: 5 }]);
  const L = makeLedger({ io, clock });
  A.eq(L.count(), 1, 'pre-existing rows loaded');
  A.eq(L.totalUsd(), 4, 'pre-existing spend counted');
  A.eq(L.usdForRun('pre'), 4, 'pre-existing run queryable');
}

// ---- corrupt io degrades to empty; a failing append never throws into the run ----
{
  const bad = { readAll() { throw new Error('disk gone'); }, append() { throw new Error('disk gone'); } };
  let L;
  A.notThrows(() => { L = makeLedger({ io: bad, clock }); }, 'construction tolerates a throwing readAll');
  A.eq(L.count(), 0, 'corrupt readAll -> empty ledger');
  A.notThrows(() => L.record({ runId: 'r', usd: 1 }), 'a throwing append does not crash record');
  A.eq(L.count(), 1, 'the RAM mirror still answers after an append failure');
  A.eq(L.totalUsd(), 1, 'in-memory total holds even when persistence failed');
}

// ---- strict record is available for paid-credit paths that must fail closed on durable append failure ----
{
  const bad = { readAll() { return []; }, append() { throw new Error('disk gone'); } };
  const L = makeLedger({ io: bad, clock });
  A.throws(() => L.recordStrict({ runId: 'r', usd: 1 }), 'recordStrict throws on append failure');
  A.eq(L.count(), 0, 'recordStrict does not update the RAM mirror when append fails');

  const io = fakeIo();
  const ok = makeLedger({ io, clock });
  const e = ok.recordStrict({ runId: 'strict', agentId: 'a', usd: 2 });
  A.eq(e.runId, 'strict', 'recordStrict returns the persisted entry');
  A.eq(ok.count(), 1, 'recordStrict updates the RAM mirror after append succeeds');
  A.eq(io.rows.length, 1, 'recordStrict persists through io.append');
}

A.report('ledger.test');
