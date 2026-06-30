/* node test/autopilot.test.js — the PURE idle self-direction engine (autonomy Slice A).
   Locks the two things the floor behaviour hinges on: the readiness TIER (the confidence floor, read from the
   confirmed-only dossier) and the DECISION (ceiling-vs-earned: act only when the dial permits AND the tier is hot,
   else earn context and name what's binding). Deterministic — an injected clock, no Date.now. */
'use strict';
const A = require('./_assert.js');
const Autopilot = require('../frontend/app/autopilot.js');

const t = 1700000000000;                             // a fixed "now" (realistic epoch ms — larger than the stale window)
const fresh = () => [{ text: 'x', createdAt: t, updatedAt: t }];

/* ---------- idleFor ---------- */
A.eq(Autopilot.idleFor(t + Autopilot.DEFAULT_IDLE_MS, t, Autopilot.DEFAULT_IDLE_MS), true, 'idle once the span elapsed');
A.eq(Autopilot.idleFor(t + 1000, t, 5000), false, 'not idle before the span');
A.eq(Autopilot.idleFor(NaN, t, 5000), false, 'a bad clock is never idle (fail safe)');

/* ---------- readiness tiers ---------- */
let rd = Autopilot.readiness({ known: ['stack'], familiarity: 1 / 7 }, { stack: fresh() }, t, {});
A.eq(rd.tier, 'cold', 'no goals → cold (no keystone to ground acting)');

rd = Autopilot.readiness({ known: ['goals', 'stack'], familiarity: 2 / 7 }, { goals: fresh(), stack: fresh() }, t, {});
A.eq(rd.tier, 'warm', 'goals + 2 usable dims → warm (may earn / propose, not yet act)');

rd = Autopilot.readiness(
  { known: ['goals', 'stack', 'pain', 'identity'], familiarity: 4 / 7 },
  { goals: fresh(), stack: fresh(), pain: fresh(), identity: fresh() }, t, {});
A.eq(rd.tier, 'hot', 'goals + 4 usable dims → hot (has EARNED the right to act)');

// recency: a goals belief older than the stale window is no longer usable → drops back below the floor.
const old = t - (Autopilot.STALE_MS + 1);
rd = Autopilot.readiness(
  { known: ['goals', 'stack', 'pain', 'identity'], familiarity: 4 / 7 },
  { goals: [{ text: 'x', createdAt: old, updatedAt: old }], stack: fresh(), pain: fresh(), identity: fresh() }, t, {});
A.eq(rd.goalsUsable, false, 'a stale goals belief is not usable grounding');
A.eq(rd.tier, 'cold', 'stale keystone → cold even with breadth (recency gates acting)');

// an UNDATED belief (legacy/seeded, pre-timestamps) counts as fresh — never punish an old save.
rd = Autopilot.readiness({ known: ['goals', 'stack'], familiarity: 2 / 7 }, { goals: [{ text: 'x' }], stack: [{ text: 'y' }] }, t, {});
A.eq(rd.tier, 'warm', 'undated beliefs are treated as fresh (no staleness penalty for old saves)');

/* ---------- decide: the ceiling-vs-earned matrix ---------- */
const D = Autopilot.decide;
A.eq(D({ enabled: false, idle: true, tier: 'hot', actsUnattended: true }).mode, 'none', 'WAIT (disabled) → none, ever — regardless of confidence');
A.eq(D({ enabled: true, idle: false, tier: 'hot', actsUnattended: true }).mode, 'none', 'active (not idle) → none');
A.eq(D({ enabled: true, idle: true, tier: 'cold', actsUnattended: false }).mode, 'earn', 'enabled + idle + cold → earn (learn first)');

let d = D({ enabled: true, idle: true, tier: 'hot', actsUnattended: true });
A.eq([d.mode, d.binding], ['act', null], 'idle + hot + dial-permits-acting → ACT, nothing binding');

d = D({ enabled: true, idle: true, tier: 'hot', actsUnattended: false });
A.eq([d.mode, d.binding], ['earn', 'dial'], 'knows them well but dial is propose-only → earn, the DIAL is binding (legible)');

d = D({ enabled: true, idle: true, tier: 'warm', actsUnattended: true });
A.eq([d.mode, d.binding], ['earn', 'confidence'], 'dial permits acting but not-yet-confident → earn, CONFIDENCE is binding (the flywheel)');

d = D({ enabled: true, idle: true, tier: 'hot', actsUnattended: true, budgetLeft: 0 });
A.eq([d.mode, d.binding], ['earn', 'budget'], "permitted + confident but today's leash spent → earn, BUDGET is binding");

A.report('autopilot.test');
