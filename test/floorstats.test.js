/* node test/floorstats.test.js — the FACTORY-FLOOR economy fold. Pure accumulator: REAL harness
   events (agent.cost / agent.run.end / workitem.delivered) → one render-agnostic floor snapshot
   (spend, yield, slag, cache%). The honesty rule under test mirrors ctxgauge: a metric with no
   samples reports known:false (the HUD shows "—"), never a fabricated number; and 'cancelled' — a
   human stop, not waste — never inflates the slag tally. */
'use strict';
const A = require('./_assert.js');
const FloorStats = require('../frontend/app/floorstats.js');

// ---- a fresh floor knows nothing: no fabricated yield/cache, clean, zero spend ----
const f = FloorStats.create();
let s = f.snapshot();
A.eq(s.spendUsd, 0, 'fresh: no spend');
A.eq(s.runs, 0, 'fresh: no decisive runs');
A.ok(s.yieldKnown === false, 'fresh: yield unknown (no samples)');
A.ok(s.cacheKnown === false, 'fresh: cache unknown (no tokens)');
A.ok(s.clean === true, 'fresh: clean (no slag)');

// ---- agent.cost folds RECONCILED spend + tokens + cached tokens (and sums across calls) ----
f.onEvent('agent.cost', { usd: 0.02, tokensIn: 1000, tokensOut: 300, cachedTokens: 400, reconciled: true });
f.onEvent('agent.cost', { usd: 0.03, tokensIn: 1000, tokensOut: 200, cachedTokens: 200 });
s = f.snapshot();
A.ok(Math.abs(s.spendUsd - 0.05) < 1e-9, 'spend sums across agent.cost events');
A.eq(s.tokensIn, 2000, 'tokensIn sums');
A.eq(s.cachedTokens, 600, 'cachedTokens sums');
A.ok(s.cacheKnown === true, 'cache known once tokens seen');
A.eq(s.cachePct, 30, 'cache% = 600/2000 = 30%');

// ---- agent.run.end: done banks a PRODUCT; the four waste reasons bank SLAG + its wasted $ ----
f.onEvent('agent.run.end', { reason: 'done', usd: 0.02 });
f.onEvent('agent.run.end', { reason: 'done', usd: 0.02 });
f.onEvent('agent.run.end', { reason: 'done', usd: 0.01 });
f.onEvent('agent.run.end', { reason: 'budget', usd: 0.10 });
s = f.snapshot();
A.eq(s.products, 3, 'three done runs -> 3 products');
A.eq(s.slag, 1, 'one budget run -> 1 slag');
A.ok(Math.abs(s.slagUsd - 0.10) < 1e-9, 'slag$ = the wasted run usd');
A.eq(s.runs, 4, 'decisive runs = products + slag');
A.ok(s.yieldKnown === true, 'yield known once a run decided');
A.eq(s.yieldPct, 75, 'yield% = 3/4 = 75%');
A.ok(s.clean === false, 'slag>0 -> not clean');

// ---- all four waste reasons count as slag; cancelled is NEUTRAL (never slag, never a run) ----
const g = FloorStats.create();
for (const r of ['max_iters', 'error', 'refusal']) g.onEvent('agent.run.end', { reason: r, usd: 0.01 });
g.onEvent('agent.run.end', { reason: 'cancelled', usd: 0.5 });
s = g.snapshot();
A.eq(s.slag, 3, 'max_iters + error + refusal = 3 slag');
A.eq(s.products, 0, 'no products');
A.eq(s.runs, 3, 'cancelled is not a decisive run');
A.ok(Math.abs(s.slagUsd - 0.03) < 1e-9, 'cancelled $ never enters slag$');

// ---- workitem.delivered increments throughput; unknown events are ignored (no throw, no change) ----
const h = FloorStats.create();
h.onEvent('workitem.delivered', { workitemId: 'w1' });
h.onEvent('workitem.delivered', { workitemId: 'w2' });
A.notThrows(() => h.onEvent('agent.token', { delta: 'x' }), 'unknown event ignored, no throw');
A.notThrows(() => h.onEvent('totally.made.up', null), 'unknown event w/ null payload ignored');
s = h.snapshot();
A.eq(s.delivered, 2, 'two deliveries counted');
A.eq(s.runs, 0, 'deliveries are not runs');

// ---- defensive coercion: garbage/missing fields never produce NaN ----
const j = FloorStats.create();
j.onEvent('agent.cost', { usd: 'nope', tokensIn: undefined, cachedTokens: null });
j.onEvent('agent.cost', {});
s = j.snapshot();
A.ok(isFinite(s.spendUsd) && s.spendUsd === 0, 'garbage usd -> 0, not NaN');
A.ok(isFinite(s.cachePct) && s.cachePct === 0, 'no tokens -> cache% 0, not NaN');
A.ok(s.cacheKnown === false, 'still unknown after junk');

// ---- reset wipes back to the fresh, knows-nothing state ----
f.reset();
s = f.snapshot();
A.eq(s.spendUsd, 0, 'reset clears spend');
A.eq(s.runs, 0, 'reset clears runs');
A.ok(s.yieldKnown === false && s.cacheKnown === false, 'reset returns to honest-unknown');

A.report('floorstats.test');
