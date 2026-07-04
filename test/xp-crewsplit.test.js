/* node test/xp-crewsplit.test.js — P3.2 CREW-RUN ATTRIBUTION (Xp.crewSplit).

   A 👍 on a LEAD run that dispatched crew splits the size-weighted mint across the lead + its workers HONESTLY. The
   only per-worker signal the harness can PROVE for an in-stream crew run is each worker's reconciled spend (usd) —
   token/tool-call streams aren't forwarded onto the lead's bus. So the split weight is COST, and the laws are:
     • the LEAD always keeps its full-size delta (it owns + synthesized the run);
     • a worker earns a cost-PROPORTIONAL share ONLY when its own spend is provable (usd > 0);
     • if NO worker cost is provable, the lead is credited alone and NOTHING false is fabricated (truthful telemetry
       overrides symmetry). */
'use strict';
const A = require('./_assert.js');
const Xp = require('../frontend/app/xp.js');

/* ---------- 1. no workers → lead-only, no fabricated split ---------- */
let r = Xp.crewSplit({ leadDelta: 6, leadCost: 0.4, workers: [] });
A.eq(r.lead.delta, 6, 'the lead keeps its full delta when there is no crew');
A.eq(r.workers.length, 0, 'no workers → no worker shares (nothing fabricated)');

/* ---------- 2. workers with NO provable cost earn nothing (honesty floor) ---------- */
r = Xp.crewSplit({ leadDelta: 6, leadCost: 0.4, workers: [{ agentId: 'w1', usd: 0 }, { agentId: 'w2' }] });
A.eq(r.workers.length, 0, 'a worker with usd=0 / missing usd is NOT credited (unprovable = no split)');
A.eq(r.lead.delta, 6, 'the lead still keeps its full delta');

/* ---------- 3. a proven worker earns a cost-proportional share, capped at the lead's delta ---------- */
r = Xp.crewSplit({ leadDelta: 8, leadCost: 0.5, workers: [{ agentId: 'w1', usd: 0.5 }] });
A.eq(r.lead.delta, 8, 'the lead keeps its full delta regardless of the split');
A.eq(r.workers.length, 1, 'a worker with provable cost is credited');
A.eq(r.workers[0].agentId, 'w1', 'the credited worker is identified by its real agentId');
A.ok(r.workers[0].delta >= 1 && r.workers[0].delta <= 8, 'a proven worker earns between 1 and the lead\'s delta');
// w1 did half the run's total spend (0.5 of 1.0) → ~half the lead delta.
A.eq(r.workers[0].delta, 4, 'a worker that did ~half the run\'s spend earns ~half the lead delta (8 * 0.5 = 4)');

/* ---------- 4. proportional across multiple workers (bigger spender earns more) ---------- */
r = Xp.crewSplit({ leadDelta: 10, leadCost: 0, workers: [{ agentId: 'big', usd: 0.9 }, { agentId: 'small', usd: 0.1 }] });
const big = r.workers.find(w => w.agentId === 'big');
const small = r.workers.find(w => w.agentId === 'small');
A.ok(big && small, 'both proven workers are credited');
A.ok(big.delta > small.delta, 'the bigger spender earns the bigger share (proportional to real cost)');
A.eq(big.delta, 9, 'big (0.9 of 1.0 spend) earns 9 of the lead\'s 10 delta');
A.eq(small.delta, 1, 'small (0.1 of 1.0 spend) earns the floor of 1 (a proven contributor always earns something)');

/* ---------- 5. a worker share NEVER exceeds the lead delta, and floors at 1 ---------- */
r = Xp.crewSplit({ leadDelta: 3, leadCost: 0, workers: [{ agentId: 'w1', usd: 100 }] });
A.eq(r.workers[0].delta, 3, 'a lone proven worker share is capped at the lead\'s delta (never more than the whole)');
r = Xp.crewSplit({ leadDelta: 5, leadCost: 100, workers: [{ agentId: 'w1', usd: 0.001 }] });
A.eq(r.workers[0].delta, 1, 'a tiny-fraction proven worker still floors at 1 (it did prove SOME work)');

/* ---------- 6. the size hint each worker rides matches its own spend (feeds xp.js scoreEvent) ---------- */
r = Xp.crewSplit({ leadDelta: 6, leadCost: 0.2, workers: [{ agentId: 'w1', usd: 0.6 }] });
A.eq(r.workers[0].size, 'large', 'a worker\'s size hint derives from ITS OWN spend (0.6 usd → large)');

/* ---------- 7. defensive: garbage / missing args never throw, never fabricate ---------- */
A.eq(Xp.crewSplit().workers.length, 0, 'no args → empty split, no throw');
A.eq(Xp.crewSplit({ leadDelta: 5 }).workers.length, 0, 'missing workers → empty split');
r = Xp.crewSplit({ leadDelta: NaN, workers: [{ agentId: 'w1', usd: 0.5 }] });
A.ok(r.lead.delta >= 1, 'a NaN leadDelta is sanitized to a valid delta (>=1)');

A.report('xp-crewsplit.test');
