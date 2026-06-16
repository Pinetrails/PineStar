/* node test/xp.test.js — the AGENT-GROWTH model. Pure transform from REAL run outcomes to two
   honest meters: a MONOTONIC XP/Level ladder and a BIDIRECTIONAL confidence (reliability) EWMA.
   Honesty rules under test: confidence reports "calibrating" (never a number) until MIN_SAMPLES
   real signals exist; failures earn 0 XP but never subtract; a level is never lost. */
'use strict';
const A = require('./_assert.js');
const Xp = require('../frontend/app/xp.js');

// ---- helpers ----
function run(events, start) {
  let s = start ? Xp.clone(start) : Xp.fresh();
  const awards = [];
  for (const e of events) { const r = Xp.applyEvent(s, e); s = r.stats; awards.push(r.awards); }
  return { stats: s, awards };
}
const done = usd => ({ name: 'agent.run.end', payload: { reason: 'done', turns: 1, usd: usd == null ? 1 : usd } });
const errd = () => ({ name: 'agent.run.end', payload: { reason: 'error', turns: 1, usd: 0 } });
const memUsed = () => ({ name: 'memory.used', payload: { id: 'm1' } });

// ---- the curve: cumulative XP to REACH level n = 25*n*(n-1) ----
A.eq(Xp.xpForLevel(1), 0, 'L1 = 0 xp');
A.eq(Xp.xpForLevel(2), 50, 'L2 = 50');
A.eq(Xp.xpForLevel(3), 150, 'L3 = 150');
A.eq(Xp.xpForLevel(5), 500, 'L5 = 500');
A.eq(Xp.xpForLevel(10), 2250, 'L10 = 2250');
A.eq(Xp.xpForLevel(28), 18900, 'L28 = 18900 (the long-haul station number)');

A.eq(Xp.levelForXp(0), 1, '0 xp -> L1');
A.eq(Xp.levelForXp(49), 1, 'just below L2 -> L1');
A.eq(Xp.levelForXp(50), 2, 'at threshold -> L2');
A.eq(Xp.levelForXp(149), 2, 'just below L3 -> L2');
A.eq(Xp.levelForXp(150), 3, 'at threshold -> L3');
A.eq(Xp.levelForXp(2249), 9, 'just below L10 -> L9');
A.eq(Xp.levelForXp(2250), 10, 'at threshold -> L10');

// ---- purity: applyEvent never mutates its input ----
const f0 = Xp.fresh();
const r0 = Xp.applyEvent(f0, done());
A.eq(f0.xp, 0, 'input xp untouched');
A.eq(f0.confidence, 50, 'input confidence untouched');
A.eq(r0.stats.xp, 15, 'done awards 15 xp');

// ---- XP per outcome ----
A.eq(Xp.applyEvent(Xp.fresh(), done(0.2)).stats.xp, 20, 'cheap done = 15 + 5 efficiency bonus');
A.eq(Xp.applyEvent(Xp.fresh(), done(0.9)).stats.xp, 15, 'pricey done = base 15, no bonus');
A.eq(run([errd()]).stats.xp, 0, 'error earns no xp');
A.eq(run([memUsed()]).stats.xp, 8, 'memory.used awards 8 xp (reuse is the prized behaviour)');

// ---- confidence: bidirectional EWMA, honest cold-start ----
A.eq(Xp.compute(Xp.fresh()).known, false, 'fresh agent is calibrating, not known');
A.eq(Xp.compute(Xp.fresh()).confLabel, '—', 'calibrating shows a dash, never a fabricated number');

const three = run([done(), done(), done()]);
A.ok(Math.abs(three.stats.confidence - 78.90625) < 1e-6, 'confidence EWMA climbs to 78.90625 over 3 done runs');
A.eq(Xp.compute(three.stats).known, true, 'known once MIN_SAMPLES real signals exist');
A.eq(three.stats.samples, 3, '3 reliability samples');

const dropped = run([errd()], three.stats);
A.ok(dropped.stats.confidence < three.stats.confidence, 'an error LOWERS confidence (moves both ways)');

// memory.used carries no reliability signal — XP only, no confidence move
const mem = run([memUsed()]);
A.eq(mem.stats.samples, 0, 'memory.used is not a reliability sample');
A.eq(mem.stats.confidence, 50, 'memory.used leaves confidence untouched');

// cancelled = the user aborted; not the agent's fault → no xp, no reliability sample
const canc = run([{ name: 'agent.run.end', payload: { reason: 'cancelled', turns: 0, usd: 0 } }]);
A.eq(canc.stats.xp, 0, 'cancelled earns no xp');
A.eq(canc.stats.samples, 0, 'cancelled is not a reliability sample');

// ---- levels are monotonic; level-up fires on threshold crossing ----
const four = run([done(), done(), done(), done()]);
A.eq(four.stats.xp, 60, '4 done = 60 xp');
A.eq(four.stats.level, 2, '60 xp -> level 2');
A.eq(four.awards[0].levelUp, false, 'no level-up on the first run');
A.ok(four.awards[3].levelUp === true && four.awards[3].levelTo === 2, 'level-up fires crossing 50 xp');

const afterFail = run([errd(), errd()], four.stats);
A.eq(afterFail.stats.level, 2, 'a level is NEVER lost on failure');

// ---- milestones fire exactly once ----
A.ok(four.awards[0].milestones.indexOf('first_light') !== -1, 'first_light on first shipped task');
A.eq(four.awards[1].milestones.indexOf('first_light'), -1, 'first_light does not re-fire');
A.ok(run([memUsed()]).awards[0].milestones.indexOf('pack_rat') !== -1, 'pack_rat on first memory reuse');

// ---- compute(): render-state for the gauges ----
const g = Xp.compute({ xp: 100, level: 2, lifetimeXp: 100, confidence: 70, samples: 5, counters: {}, milestones: [] });
A.eq(g.level, 2, 'compute reads level');
A.eq(g.span, 100, 'L2->L3 span = 100');
A.eq(g.inLevel, 50, 'inLevel = 100 - 50');
A.eq(g.toNext, 50, 'toNext = 150 - 100');
A.eq(g.pct, 50, '50% through level 2');
A.eq(g.known, true, 'known with 5 samples');
A.eq(g.confLabel, '70%', 'confLabel renders the percent');
A.eq(g.band, 'reliable', '70% -> reliable band');

A.report('xp.test');
