/* node test/insights.test.js — usage insights folded from run history (H3.3).
   Proves foldInsights computes the overview (spend/runs/tokens/avg), an honest successPct (null when nothing is
   decided), per-model spend ranked, outcome breakdown, per-agent, and a runs/spend-over-time series anchored at
   nowMs. Pure (rows in, object out). */
'use strict';
const A = require('./_assert.js');
const { foldInsights } = require('../sidecar/insights.js');

const H = 3600000;
const rows = [
  { reason: 'done', usd: 0.02, tokens: 1000, model: 'gpt-5.5', agentId: 'a', ts: 1000 },
  { reason: 'done', usd: 0.03, tokens: 500, model: 'gpt-5.5', agentId: 'a', ts: 1000 + H },
  { reason: 'error', usd: 0.01, tokens: 200, model: 'claude-opus-4.8', agentId: 'b', ts: 1000 + 2 * H },
];
const r = foldInsights(rows, { nowMs: 1000 + 2 * H, bucketMs: H, buckets: 3 });

// ---- overview ----
A.eq(r.totalRuns, 3, 'total runs');
A.ok(Math.abs(r.totalUsd - 0.06) < 1e-9, 'total spend sums');
A.eq(r.totalTokens, 1700, 'total tokens sum');
A.ok(Math.abs(r.avgUsdPerRun - 0.02) < 1e-9, 'avg $/run');
A.eq(r.successPct, 67, 'successPct = 2 done / 3 decided -> 67%');

// ---- outcome breakdown ----
A.eq(r.byReason.done, 2, 'done count'); A.eq(r.byReason.error, 1, 'error count');

// ---- per-model spend, ranked by $ ----
A.eq(r.byModel[0].model, 'gpt-5.5', 'top model by spend');
A.ok(Math.abs(r.byModel[0].usd - 0.05) < 1e-9, 'top model spend = 0.02+0.03');
A.eq(r.byModel[0].runs, 2, 'top model run count');
A.eq(r.byModel[1].model, 'claude-opus-4.8', 'second model');

// ---- per-agent ----
A.eq(r.byAgent[0].agentId, 'a', 'top agent by spend');

// ---- runs/spend over time ----
A.eq(r.overTime.length, 3, '3 time buckets');
A.eq(r.overTime.reduce((s, b) => s + b.runs, 0), 3, 'every run lands in a bucket');
A.ok(Math.abs(r.overTime.reduce((s, b) => s + b.usd, 0) - 0.06) < 1e-9, 'bucketed spend sums to total');

// ---- empty: honest, no fabrication ----
const e = foldInsights([], { nowMs: 1000 });
A.eq(e.totalRuns, 0, 'empty: 0 runs');
A.eq(e.successPct, null, 'empty: successPct null (honest unknown, not 0%)');
A.eq(e.byModel.length, 0, 'empty: no models');

// ---- a row with no model folds under (unknown) (never crashes) ----
const u = foldInsights([{ reason: 'done', usd: 0.01, ts: 1000 }], { nowMs: 1000 });
A.eq(u.byModel[0].model, '(unknown)', 'a model-less run folds under (unknown)');

A.report('insights.test');
