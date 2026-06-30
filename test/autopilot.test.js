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

/* ---------- A2: the anti-slop selection pipeline ---------- */
// eligibility follows the usable dims
const elig = Autopilot.eligibleArchetypes(['goals', 'stack']);
A.eq(elig.map(a => a.id).sort(), ['advance-goal', 'maintain-extend', 'prep-next', 'scout'], 'eligible archetypes follow usable dims (goals→advance/prep/maintain, stack→scout; no pain→no kill-pain)');
A.eq(Autopilot.eligibleArchetypes([]).length, 0, 'no usable dims → no eligible archetypes (nothing to ground a job in)');

// grounded(): the structural anti-slop floor
A.eq(Autopilot.grounded('ship the StarNet beta', ['ship the StarNet beta to 100 users']), true, 'grounds that is a substring of a belief → grounded');
A.eq(Autopilot.grounded('migrate the billing system', ['ship the StarNet beta', 'reduce churn']), false, 'grounds with no overlap → not grounded (invented)');
A.eq(Autopilot.grounded('grow the StarNet community', ['ship the StarNet beta to users']), true, 'a shared significant token (starnet) → grounded (tolerates paraphrase)');

// parseCandidates + the GROUNDING VETO
const b2 = { goals: ['ship the StarNet beta to 100 users'], pain: ['manual release notes eat my fridays'] };
const eligAll = Autopilot.eligibleArchetypes(['goals', 'pain', 'stack']);
const reply = [
  'JOB: Draft the beta launch checklist', 'KIND: advance-goal', 'GROUNDS: ship the StarNet beta to 100 users', 'CONFIDENCE: high', 'SPEC: a step-by-step pre-launch checklist', '',
  'JOB: Draft release-notes template', 'KIND: kill-pain', 'GROUNDS: manual release notes eat my fridays', 'CONFIDENCE: medium', 'SPEC: a reusable release-notes template', '',
  'JOB: Rewrite your database layer', 'KIND: advance-goal', 'GROUNDS: migrate everything to Postgres', 'CONFIDENCE: high', 'SPEC: a migration plan'
].join('\n');
const cands = Autopilot.parseCandidates(reply, { eligible: eligAll, beliefs: b2 });
A.eq(cands.length, 2, 'the grounding veto drops the candidate whose GROUNDS is invented (not in the dossier)');
A.eq(cands[0].archetype, 'advance-goal', 'a surviving candidate carries its kind');
A.eq(cands[1].confidence, 'medium', 'confidence is parsed');
A.eq(Autopilot.parseCandidates('JOB: x\nKIND: scout\nGROUNDS: ship the StarNet beta\nCONFIDENCE: high\nSPEC: y', { eligible: Autopilot.eligibleArchetypes(['goals']), beliefs: b2 }).length, 0, 'a KIND outside the eligible set is dropped (no scout without usable stack)');

// scoreAndSelect + the CONFIDENCE GATE
const pick = Autopilot.scoreAndSelect(cands);
A.eq([pick.selected.archetype, pick.reason], ['advance-goal', 'selected'], 'the highest-confidence candidate is selected');
const tie = [{ title: 'a', archetype: 'kill-pain', grounds: 'g', confidence: 'high', spec: 's' }, { title: 'b', archetype: 'advance-goal', grounds: 'g', confidence: 'high', spec: 's' }];
A.eq(Autopilot.scoreAndSelect(tie).selected.archetype, 'advance-goal', 'a confidence tie breaks by the fixed order (advance › kill-pain)');
A.eq(Autopilot.scoreAndSelect([{ title: 'a', archetype: 'scout', grounds: 'g', confidence: 'low', spec: 's' }]).selected, null, 'all-low candidates → selected null (the confidence gate: idle-doing-nothing beats slop)');
A.eq(Autopilot.scoreAndSelect([]).reason, 'no-candidates', 'no candidates → no-candidates');

// the directives carry the constraints; parseDeliverable reads the run output
const cd = Autopilot.buildCandidateDirective({ beliefs: b2, eligible: eligAll });
A.ok(/no tools/i.test(cd) && /GROUNDED/i.test(cd) && /CONFIDENCE/i.test(cd), 'the candidate directive constrains to grounded, reason/draft-only, confidence-rated output');
const dd = Autopilot.buildDoDirective(cands[0], { name: 'NOVA' });
A.ok(/TITLE:/i.test(dd) && /no tools/i.test(dd), 'the do directive demands a titled draft, reason/draft only');
const del = Autopilot.parseDeliverable('TITLE: Beta launch checklist\n1. Freeze the build\n2. Tag the release', { fallbackTitle: 'x' });
A.eq(del.title, 'Beta launch checklist', 'deliverable title is parsed from the TITLE line');
A.ok(/Freeze the build/.test(del.body), 'deliverable body is the rest after the title');
A.eq(Autopilot.parseDeliverable('', { fallbackTitle: 'x' }), null, 'an empty run output yields no deliverable');
A.eq(Autopilot.parseDeliverable('just a draft, no title line', { fallbackTitle: 'Fallback' }).title, 'Fallback', 'a missing TITLE falls back to the selected job title');

A.report('autopilot.test');
