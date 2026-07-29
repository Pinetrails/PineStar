/* node test/xp.test.js - the AGENT-GROWTH model.
   XP/levels are satisfaction-gated: only explicit positive user turn-in feedback mints XP.
   Operational events still update counters and milestones, but cannot level an agent by themselves.
   Negative feedback calibrates confidence down without subtracting XP or levels. */
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
// run.end carries a runId in production (schema-required) — the helpers default to 'r' so a [memUsed(), done()]
// sequence shares one run and the buffered memory-reuse credit commits (or, for errd(), is discarded) correctly.
const done = (usd, runId) => ({ name: 'agent.run.end', payload: { agentId: 'a', runId: runId || 'r', reason: 'done', turns: 1, usd: usd == null ? 1 : usd } });
const errd = runId => ({ name: 'agent.run.end', payload: { agentId: 'a', runId: runId || 'r', reason: 'error', turns: 1, usd: 0 } });
const ended = (reason, runId) => ({ name: 'agent.run.end', payload: { agentId: 'a', runId: runId || 'r', reason, turns: 1, usd: 0 } });
const memUsed = (id, runId) => ({ name: 'memory.used', payload: { agentId: 'a', runId: runId || 'r', id: id || 'm1' } });
const feedback = (delta, reason) => ({ name: 'memory.feedback', payload: { agentId: 'a', id: 'm1', delta, reason: reason || 'kept' } });
const keep = () => feedback(2, 'kept');
const edit = () => feedback(1, 'edited');
const discard = () => feedback(-1, 'discarded');
const helpful = () => feedback(2, 'helpful');
const unhelpful = () => feedback(-1, 'unhelpful');
const toolOk = runId => ({ name: 'agent.tool_result', payload: { agentId: 'a', runId, callId: 'c', ok: true, isError: false } });
const delivered = () => ({ name: 'workitem.delivered', payload: { agentId: 'a', workitemId: 'w', finalQueueId: 'q' } });

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
A.eq(r0.stats.xp, 0, 'done awards no xp without user feedback');
A.eq(r0.stats.counters.tasksDone, 1, 'done still updates the shipped-task counter');

// ---- XP per event: only positive feedback mints XP ----
A.eq(Xp.applyEvent(Xp.fresh(), done(0.2)).stats.xp, 0, 'cheap done still earns no xp');
A.eq(Xp.applyEvent(Xp.fresh(), done(0.9)).stats.xp, 0, 'pricey done still earns no xp');
A.eq(run([errd()]).stats.xp, 0, 'error earns no xp');
A.eq(run([memUsed()]).stats.xp, 0, 'memory.used earns no xp');
A.eq(run([toolOk('r1')]).stats.xp, 0, 'tool success earns no xp');
A.eq(run([delivered()]).stats.xp, 0, 'workitem delivery earns no xp without user feedback');
A.eq(run([{ name: 'channel.delivery', payload: { ok: true } }]).stats.xp, 0, 'channel delivery earns no xp without user feedback');
A.eq(Xp.applyEvent(Xp.fresh(), edit()).awards.xp, 10, 'edited/positive feedback delta 1 awards 10 xp');
A.eq(Xp.applyEvent(Xp.fresh(), keep()).awards.xp, 20, 'kept/positive feedback delta 2 awards 20 xp');
A.eq(Xp.applyEvent(Xp.fresh(), discard()).awards.xp, 0, 'negative feedback awards no xp');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(1000, 'kept')).awards.xp, 50, 'a huge finite kept-feedback delta is capped at +50 xp');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(1000, 'huge')).awards.xp, 0, 'unknown memory.feedback reasons do not award xp');

// ---- G2.4 task-size weighting: an optional payload.size hint scales the mint; the CAP stays the ceiling ----
const sized = (delta, reason, size) => ({ name: 'memory.feedback', payload: { agentId: 'a', id: 'w1', delta, reason, size } });
A.eq(Xp.workSize({ tools: 0, usd: 0 }), 'small', 'no tools, no spend -> small');
A.eq(Xp.workSize({ tools: 2, usd: 0.01 }), 'small', 'a couple of tool calls is still small');
A.eq(Xp.workSize({ tools: 3, usd: 0 }), 'medium', '3 successful tools -> medium');
A.eq(Xp.workSize({ tools: 0, usd: 0.08 }), 'medium', 'real spend alone can make medium');
A.eq(Xp.workSize({ tools: 6, usd: 0 }), 'large', '6 successful tools -> large');
A.eq(Xp.workSize({ tools: 0, usd: 0.5 }), 'large', 'heavy spend alone -> large');
A.eq(Xp.workSize(null), 'small', 'missing stash -> small (conservative, never inflating)');
A.eq(Xp.applyEvent(Xp.fresh(), sized(3, 'work_great', 'large')).awards.xp, 45, 'large task: 3*10*1.5 = 45 xp');
A.eq(Xp.applyEvent(Xp.fresh(), sized(3, 'work_great', 'medium')).awards.xp, 38, 'medium task: round(3*10*1.25) = 38 xp');
A.eq(Xp.applyEvent(Xp.fresh(), sized(3, 'work_great', 'small')).awards.xp, 30, 'small task: base mint unchanged');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(3, 'work_great')).awards.xp, 30, 'NO size hint -> exactly the old mint (fully additive)');
A.eq(Xp.applyEvent(Xp.fresh(), sized(3, 'work_great', 'gigantic')).awards.xp, 30, 'an unknown size string is ignored (mult 1)');
A.eq(Xp.applyEvent(Xp.fresh(), sized(4, 'work_great', 'large')).awards.xp, 50, 'weighting never pierces FEEDBACK_XP_CAP (4*10*1.5=60 -> 50)');
A.eq(Xp.applyEvent(Xp.fresh(), sized(8, 'work_great', 'large')).awards.xp, 50, 'a big weighted delta stays capped at +50');
A.eq(Xp.applyEvent(Xp.fresh(), sized(5, 'work_ok', 'large')).awards.xp, 0, 'weighting SCALES a mint, never invents one — work_ok still mints nothing');
A.eq(Xp.applyEvent(Xp.fresh(), sized(5, 'work_miss', 'large')).awards.xp, 0, 'work_miss with a size hint still mints nothing (no penalty either)');
A.eq(Xp.applyEvent(Xp.fresh(), sized(2, 'kept', 'large')).awards.xp, 30, 'the multiplier rides the shared mint path (kept delta 2 * large = 30)');

// ---- "rate the work" verdicts ride memory.feedback (synthetic id, direct XpStore call): only 👍 mints, none penalize ----
A.eq(Xp.applyEvent(Xp.fresh(), feedback(3, 'work_great')).awards.xp, 30, 'work_great delta 3 awards 30 xp (size-weighted)');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(8, 'work_great')).awards.xp, 50, 'work_great big task is capped at +50 xp');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(5, 'work_ok')).awards.xp, 0, 'work_ok (close) never mints xp');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(5, 'work_miss')).awards.xp, 0, 'work_miss never mints xp');
const _wg = Xp.applyEvent(Xp.fresh(), feedback(3, 'work_great'));
A.eq(_wg.stats.counters.positiveFeedback, 1, 'work_great counts as positive feedback (drives APPROVED milestone)');
A.eq((_wg.stats.counters.negativeFeedback || 0), 0, 'work_great is not negative');
const _wo = Xp.applyEvent(Xp.fresh(), feedback(5, 'work_ok'));
A.eq((_wo.stats.counters.positiveFeedback || 0), 0, 'work_ok is neutral — not counted positive');
A.eq((_wo.stats.counters.negativeFeedback || 0), 0, 'work_ok is neutral — not counted negative');
A.eq(_wo.stats.samples, 1, 'work_ok still records one satisfaction sample');
const _wm = Xp.applyEvent(Xp.fresh(), feedback(5, 'work_miss'));
A.eq(_wm.stats.counters.negativeFeedback, 1, 'work_miss counts as negative feedback (confidence down)');
A.ok(_wm.stats.xp === 0 && _wm.stats.lifetimeXp === 0, 'work_miss never subtracts xp (no penalty)');

// ---- confidence: bidirectional EWMA over explicit feedback, honest cold-start ----
A.eq(Xp.compute(Xp.fresh()).known, false, 'fresh agent is calibrating, not known');
A.eq(Xp.compute(Xp.fresh()).confidence, null, 'calibrating exposes no fabricated percent');

const noJudgment = run([done(), toolOk('r1'), memUsed(), delivered()]);
A.eq(noJudgment.stats.samples, 0, 'operational events are not satisfaction samples');
A.eq(noJudgment.stats.confidence, 50, 'operational events leave confidence untouched');

const three = run([keep(), keep(), keep()]);
A.ok(Math.abs(three.stats.confidence - 78.90625) < 1e-6, 'confidence EWMA climbs to 78.90625 over 3 positive feedback samples');
A.eq(Xp.compute(three.stats).known, true, 'known once MIN_SAMPLES feedback samples exist');
A.eq(three.stats.samples, 3, '3 feedback samples');
A.eq(three.stats.counters.positiveFeedback, 3, 'positive feedback counter records approvals');

const dropped = run([discard()], three.stats);
A.ok(dropped.stats.confidence < three.stats.confidence, 'negative feedback LOWERS confidence (moves both ways)');
A.eq(dropped.stats.xp, three.stats.xp, 'negative feedback does not subtract xp');
A.eq(dropped.stats.counters.negativeFeedback, 1, 'negative feedback counter records misses');

const zeroFeedback = run([feedback(0, 'neutral')]);
A.eq(zeroFeedback.stats.samples, 0, 'unknown feedback reason is not a satisfaction sample');
A.eq(zeroFeedback.stats.xp, 0, 'unknown feedback reason awards no xp');

const notebookRatings = run([helpful(), unhelpful()]);
A.eq(notebookRatings.stats.samples, 0, 'notebook feedback ratings are not satisfaction samples');
A.eq(notebookRatings.stats.xp, 0, 'notebook feedback ratings do not mint xp');
A.eq(notebookRatings.stats.counters.positiveFeedback || 0, 0, 'notebook helpful does not count as user approval');
A.eq(notebookRatings.stats.counters.negativeFeedback || 0, 0, 'notebook unhelpful does not count as user rejection');

// cancelled = the user aborted; not a satisfaction verdict -> no xp, no confidence sample
const canc = run([{ name: 'agent.run.end', payload: { reason: 'cancelled', turns: 0, usd: 0 } }]);
A.eq(canc.stats.xp, 0, 'cancelled earns no xp');
A.eq(canc.stats.samples, 0, 'cancelled is not a satisfaction sample');

// ---- levels are monotonic; level-up fires only from positive feedback crossing a threshold ----
const twoKeeps = run([keep(), keep()]);
A.eq(twoKeeps.stats.xp, 40, '2 keeps = 40 xp');
A.eq(twoKeeps.stats.level, 1, '40 xp stays level 1');
const thirdKeep = run([keep()], twoKeeps.stats);
A.eq(thirdKeep.stats.xp, 60, 'third keep crosses the level-2 threshold');
A.eq(thirdKeep.stats.level, 2, '60 xp -> level 2');
A.ok(thirdKeep.awards[0].levelUp === true && thirdKeep.awards[0].levelTo === 2, 'level-up fires crossing 50 xp');

const afterBad = run([errd(), discard(), errd()], thirdKeep.stats);
A.eq(afterBad.stats.level, 2, 'a level is NEVER lost on failure or negative feedback');

// ---- milestones fire exactly once, independently of XP ----
const firstTask = run([done()]);
A.ok(firstTask.awards[0].milestones.indexOf('first_light') !== -1, 'first_light on first shipped task');
A.eq(run([done()], firstTask.stats).awards[0].milestones.indexOf('first_light'), -1, 'first_light does not re-fire');
A.ok(run([keep()]).awards[0].milestones.indexOf('approved') !== -1, 'approved on first positive feedback');
// pack_rat now fires only when the run that recalled memory actually COMPLETES — the operational credit is buffered
// per-run and committed at run.end. So the trophy lands on the run.end award (last event), never on the bare recall.
const packRun = run([memUsed(), done()]);
A.eq(packRun.awards[0].milestones.indexOf('pack_rat'), -1, 'bare memory.used does NOT award pack_rat yet (credit is buffered)');
A.ok(packRun.awards[1].milestones.indexOf('pack_rat') !== -1, 'pack_rat lands when the recalling run completes');
A.eq(packRun.stats.counters.memReused, 1, 'a completed run that recalled memory credits memReused once');

// ---- TRUTHFUL-TELEMETRY REGRESSION (the reproduced bug): a run that recalls memory then produces NOTHING must
//      not mint memory-reuse credit or the PACK RAT trophy. Recall happens at context-assembly, BEFORE the model
//      call — so a 404'd run emitted memory.used ×7 then run.end{error}, and used to award the permanent trophy. ----
// (a) the exact repro: 7 memory.used chunks (one recall of 7 records) then an errored run end.
const deadRun = run([memUsed('m1'), memUsed('m2'), memUsed('m3'), memUsed('m4'), memUsed('m5'), memUsed('m6'), memUsed('m7'), errd()]);
A.eq(deadRun.stats.counters.memReused || 0, 0, 'a run that 404s after recall credits NO memory reuse (was 7 — the bug)');
A.ok(deadRun.awards.every(a => a.milestones.indexOf('pack_rat') === -1), 'no PACK RAT trophy for a recall that never fed a real turn');
A.eq(Xp.milestones(deadRun.stats).find(m => m.id === 'pack_rat').earned, false, 'PACK RAT reads locked after an errored recall run');
// (b) an EMPTY run (degraded provider streamed a zero-tool, zero-text turn) is likewise no work → no credit.
const emptyRun = run([memUsed(), ended('empty')]);
A.eq(emptyRun.stats.counters.memReused || 0, 0, 'an empty run (produced nothing) credits no memory reuse');
A.eq(Xp.milestones(emptyRun.stats).find(m => m.id === 'pack_rat').earned, false, 'PACK RAT stays locked after an empty recall run');
// (c) N-per-recall inflation is gone: a DONE run with a 7-chunk recall credits memReused exactly ONCE (a reuse
//     EVENT, not a chunk tally) — matching the "reuse a memory" trophy copy.
const bigRecall = run([memUsed('m1'), memUsed('m2'), memUsed('m3'), memUsed('m4'), memUsed('m5'), memUsed('m6'), memUsed('m7'), done()]);
A.eq(bigRecall.stats.counters.memReused, 1, 'a completed run crediting memory reuse counts the EVENT once, never 7 chunks');
A.ok(bigRecall.awards[bigRecall.awards.length - 1].milestones.indexOf('pack_rat') !== -1, 'pack_rat awarded once for the completed recall run');
// (d) DEDUP holds across runs: a SECOND completed recall run does not re-award the (already-earned) trophy, and
//     memReused advances by one reuse-event per qualifying run (not per chunk).
const secondRecall = run([memUsed('m1'), memUsed('m2'), done()], bigRecall.stats);
A.eq(secondRecall.awards[secondRecall.awards.length - 1].milestones.indexOf('pack_rat'), -1, 'pack_rat does not re-fire on a later recall run');
A.eq(secondRecall.stats.counters.memReused, 2, 'memReused advances by one PER qualifying run (2 runs → 2), never per chunk');
// (e) partial work still counts: a run that hit its ceiling (max_iters) after recalling DID engage the model, so
//     its reuse credit is kept — withholding provably-real work would be its own dishonesty.
const cappedRecall = run([memUsed(), ended('max_iters')]);
A.eq(cappedRecall.stats.counters.memReused, 1, 'a max_iters run that recalled memory keeps its reuse credit (real work, just capped)');
// (f) buffer isolation across distinct runs: an errored recall run A, then a fresh COMPLETED recall run B, credits
//     exactly the one honest reuse — run A's discarded credit never leaks into run B, and B is not double-counted.
const isolate = run([memUsed('a1', 'runA'), errd('runA'), memUsed('b1', 'runB'), done(1, 'runB')]);
A.eq(isolate.stats.counters.memReused, 1, 'errored run A discarded + completed run B credited = exactly 1 reuse (no leak, no double-count)');

// ---- compute(): render-state for the gauges ----
const g = Xp.compute({ xp: 100, level: 2, lifetimeXp: 100, confidence: 70, samples: 5, counters: { positiveFeedback: 7, negativeFeedback: 2, tasksDone: 3 }, milestones: [] });
A.eq(g.level, 2, 'compute reads level');
A.eq(g.span, 100, 'L2->L3 span = 100');
A.eq(g.inLevel, 50, 'inLevel = 100 - 50');
A.eq(g.toNext, 50, 'toNext = 150 - 100');
A.eq(g.pct, 50, '50% through level 2');
A.eq(g.known, true, 'known with 5 samples');
A.eq(g.confLabel, '70%', 'confLabel renders the percent');
A.eq(g.band, 'reliable', '70% -> reliable band');
A.eq(g.bonus, 30, 'compute exposes the +30% feedback bonus');
A.eq(g.positiveFeedback, 7, 'compute surfaces positive feedback count');
A.eq(g.negativeFeedback, 2, 'compute surfaces negative feedback count');
A.eq(Xp.compute(Xp.fresh()).bonus, 0, 'no feedback bonus while calibrating');

// ---- confidence-scaled feedback XP: satisfied agents grow faster, never a penalty ----
const cal = { xp: 0, level: 1, lifetimeXp: 0, confidence: 90, samples: 5, counters: {}, milestones: [], run: { id: null, toolXp: 0 } };
A.eq(Xp.applyEvent(cal, edit()).awards.xp, 15, 'trusted (90%): feedback 10 base x1.5 = 15');
A.eq(Xp.applyEvent(Object.assign({}, cal, { confidence: 70 }), edit()).awards.xp, 13, 'reliable (70%): feedback 10 x1.3 = 13');
A.eq(Xp.applyEvent(Object.assign({}, cal, { confidence: 30 }), edit()).awards.xp, 10, 'low confidence: feedback earns base only, never a penalty');
A.eq(Xp.applyEvent(Object.assign({}, cal, { samples: 1 }), edit()).awards.xp, 10, 'uncalibrated: no bonus regardless of confidence');

// ---- high-frequency tool successes are counters only, not growth ----
let ts = Xp.fresh();
for (let i = 0; i < 15; i++) ts = Xp.applyEvent(ts, toolOk('r1')).stats;
A.eq(ts.xp, 0, '15 tool successes still award 0 xp');
A.eq(ts.samples, 0, 'tool results carry no satisfaction sample');
A.eq(ts.confidence, 50, 'tool results never move confidence');
A.eq(ts.counters.toolsOk, 15, 'tool successes still update operational counters (a real tool_result IS proof — committed immediately, never buffered)');

// ---- expanded milestone table ----
// memWrites / delivered stay IMMEDIATE (the write/delivery event is itself proof of the real action) — only
// memory-REUSE is buffered to run end, because recall happens speculatively at context-assembly (see pack_rat above).
let ms = Xp.fresh();
for (let i = 0; i < 10; i++) ms = Xp.applyEvent(ms, { name: 'memory.write', payload: { agentId: 'a', runId: 'r', id: 'm' + i, kind: 'fact' } }).stats;
A.eq(ms.xp, 0, 'memory writes do not mint xp');
A.ok(ms.milestones.indexOf('archivist') !== -1, 'archivist at 10 memory writes (a real write IS proof — committed immediately)');
const nightShift = Xp.applyEvent(Xp.fresh(), delivered());
A.eq(nightShift.stats.xp, 0, 'delivery milestone does not mint xp');
A.ok(nightShift.awards.milestones.indexOf('night_shift') !== -1, 'night_shift on first external delivery (a real delivery IS proof — immediate)');
const near = { xp: 2249, level: 9, lifetimeXp: 2249, confidence: 50, samples: 0, counters: {}, milestones: [], run: { id: null, toolXp: 0 } };
const vr = Xp.applyEvent(near, keep());
A.eq(vr.stats.level, 10, 'positive feedback crossing 2250 xp -> level 10');
A.ok(vr.awards.milestones.indexOf('veteran') !== -1, 'veteran milestone at level 10');

// ---- defensive: a corrupted / hand-edited save must never poison the meters with NaN/Infinity ----
const bad = { xp: Infinity, level: Infinity, lifetimeXp: NaN, confidence: Infinity, samples: NaN, counters: {}, milestones: [], run: {} };
const cb = Xp.compute(bad);
A.ok(Number.isFinite(cb.level) && Number.isFinite(cb.pct) && Number.isFinite(cb.toNext), 'compute() never emits NaN/Infinity from a corrupted save');
A.eq(cb.confidence, null, 'corrupted confidence -> calibrating null, never NaN');
const rb = Xp.applyEvent(bad, keep());
A.ok(Number.isFinite(rb.stats.xp) && Number.isFinite(rb.stats.confidence) && Number.isFinite(rb.stats.level), 'applyEvent sanitizes non-finite stats');
A.eq(Xp.levelForXp(Infinity), 1, 'levelForXp(Infinity) -> 1, never Infinity');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(Infinity, 'bad')).awards.xp, 0, 'non-finite feedback delta -> 0 xp');
A.eq(Xp.applyEvent(Xp.fresh(), feedback(1000, 'kept')).awards.xp, 50, 'huge finite kept-feedback delta remains capped at +50 xp');

// ---- milestone CATALOGUE (render-state for the trophy case): every badge, with earned flags + unlock hints ----
const catFresh = Xp.milestones(Xp.fresh());
A.eq(catFresh.length, Xp.MILESTONES.length, 'catalogue lists every milestone');
A.eq(catFresh.filter(m => m.earned).length, 0, 'a fresh agent has earned none');
A.ok(catFresh.every(m => m.label && m.hint), 'every badge carries a label + unlock hint');
const fl = catFresh.find(m => m.id === 'first_light');
A.eq(fl.label, 'FIRST LIGHT', 'first_light label surfaced for the UI');
A.eq(fl.hint, 'ship 1 task', 'locked first_light shows its unlock hint');
const catEarned = Xp.milestones(run([memUsed(), done(), keep()]).stats);
A.eq(catEarned.find(m => m.id === 'first_light').earned, true, 'first_light reads earned once a task ships');
A.eq(catEarned.find(m => m.id === 'pack_rat').earned, true, 'pack_rat reads earned after a reuse');
A.eq(catEarned.find(m => m.id === 'approved').earned, true, 'approved reads earned after positive feedback');
A.eq(catEarned.find(m => m.id === 'veteran').earned, false, 'unmet milestones stay locked');
A.eq(Xp.milestones(null).filter(m => m.earned).length, 0, 'milestones(null) is safe and all-locked');

// ---- compute() exposes tasksDone + samples + feedback receipts for the dossier ----
const cg = Xp.compute(run([done(), done(), done(), keep(), discard()]).stats);
A.eq(cg.tasksDone, 3, 'compute surfaces shipped-task count');
A.eq(cg.samples, 2, 'compute surfaces the feedback sample count');
A.eq(cg.positiveFeedback, 1, 'compute surfaces positive feedback count');
A.eq(cg.negativeFeedback, 1, 'compute surfaces negative feedback count');
A.eq(Xp.compute(Xp.fresh()).tasksDone, 0, 'fresh agent has 0 tasks done');

/* ---- S2 RELIABILITY: the SECOND axis — what the HARNESS observed, not what the Commander said ----
   The whole point is that it is provable without a single user tap, AND that it never becomes a second XP
   faucet. Every assertion below pairs "the meter moved" with "the ladder did not". */

// calibration honesty, exactly like confidence: no number before there is evidence for one
const rFresh = Xp.reliability(Xp.fresh());
A.eq(rFresh.known, false, 'a fresh agent reports reliability known:false (never a made-up %)');
A.eq(rFresh.pct, null, 'an uncalibrated reliability has NO percentage');
A.eq(rFresh.label, '—', 'an uncalibrated reliability renders as a dash');
A.eq(rFresh.band, 'calibrating', 'an uncalibrated reliability bands as calibrating');
A.eq(rFresh.toKnown, Xp.MIN_RUNS, 'a fresh agent needs MIN_RUNS attributable runs before a % is honest');
A.eq(Xp.reliability(null).known, false, 'reliability(null) is safe and uncalibrated');

// a clean track record
const rAll = Xp.reliability(run([done(), done(), done()]).stats);
A.eq(rAll.known, true, 'MIN_RUNS attributable runs calibrate the meter');
A.eq(rAll.completed, 3, 'completed counts the done runs');
A.eq(rAll.attempted, 3, 'attempted counts the runs the agent owned');
A.eq(rAll.pct, 100, 'three clean runs read 100%');
A.eq(rAll.band, 'dependable', '100% bands as dependable');

// engaged-but-fell-short IS the agent's own outcome and DOES count against it
const rShort = Xp.reliability(run([done(), done(), ended('max_iters')]).stats);
A.eq(rShort.attempted, 3, 'a max_iters run is attributable (the agent engaged and fell short)');
A.eq(rShort.completed, 2, 'a max_iters run is not a completion');
A.eq(rShort.pct, 67, 'two of three reads 67%');
A.eq(rShort.band, 'consistent', '67% bands as consistent');
A.eq(Xp.reliability(run([done(), done(), ended('budget')]).stats).attempted, 3, 'a budget stop is attributable');
A.eq(Xp.reliability(run([done(), done(), ended('refusal')]).stats).attempted, 3, 'a refusal is attributable');

/* THE HONESTY LINE — a provider fault is NOT the agent's failure. This is the case that actually happens: a
   dead model id, a 404, an out-of-credit key. Charging it to the agent would understate every agent on a
   misconfigured station. Excluded runs are still COUNTED so the dossier can name them. */
const rFault = Xp.reliability(run([done(), done(), done(), errd(), errd(), ended('empty')]).stats);
A.eq(rFault.attempted, 3, 'provider faults (error/empty) are EXCLUDED from the denominator');
A.eq(rFault.pct, 100, 'a provider outage cannot drag an agent\'s reliability down');
A.eq(rFault.faulted, 3, 'faulted runs are still counted, so the dossier can name them');
A.eq(rFault.excluded, 3, 'excluded = faulted + neutral');

// a Commander cancel, and a neutral Task Brief question, are likewise not the agent's outcome
const rNeutral = Xp.reliability(run([done(), done(), done(), ended('cancelled'), ended('clarifying')]).stats);
A.eq(rNeutral.attempted, 3, 'cancelled + clarifying are EXCLUDED from the denominator');
A.eq(rNeutral.neutral, 2, 'neutral runs are counted separately from provider faults');
A.eq(rNeutral.pct, 100, 'stopping a run yourself never marks the agent down');

// an unknown FUTURE terminal value falls through to neither bucket — the safe, non-lying default
const rUnknown = run([done(), done(), done(), ended('some_future_reason')]).stats;
A.eq(Xp.reliability(rUnknown).attempted, 3, 'an unrecognised terminal reason is never guessed into a bucket');
A.eq(Xp.reliability(rUnknown).excluded, 0, 'an unrecognised terminal reason is not counted as excluded either');
A.eq(rUnknown.counters.runs, 4, 'but every attempt still increments the raw run count (unchanged meaning)');

/* THE XP LAW HOLDS: reliability reads real outcomes, and NONE of them mint XP, move the level, or touch the
   satisfaction meter. If this ever goes red, the two axes have been blurred back into one. */
const mixed = run([done(), done(), done(), ended('max_iters'), errd(), ended('cancelled')]).stats;
A.eq(mixed.xp, 0, 'S2 outcomes mint NO XP — XP stays explicit-user-approval-only');
A.eq(mixed.level, 1, 'S2 outcomes never move the level ladder');
A.eq(mixed.samples, 0, 'S2 outcomes are not satisfaction samples');
A.eq(Xp.compute(mixed).known, false, 'S2 outcomes never calibrate the CONFIDENCE meter');
A.eq(Xp.reliability(mixed).known, true, '…while the reliability meter IS calibrated by those same runs');

/* LEGACY SAVES: a save written before S2 has no buckets. We report calibrating rather than back-filling from
   runs/tasksDone — `runs` counts provider errors and cancellations too, so a derived number would understate
   every existing agent. Never ship a number you cannot stand behind. */
const legacy = Xp.fresh(); legacy.counters = { runs: 40, tasksDone: 31, toolsOk: 90 };
const rLegacy = Xp.reliability(legacy);
A.eq(rLegacy.known, false, 'a pre-S2 save reads calibrating, not a number derived from the raw run count');
A.eq(rLegacy.pct, null, 'a pre-S2 save shows no fabricated percentage');
A.eq(rLegacy.attempted, 0, 'a pre-S2 save proves NOTHING about reliability — the S2 counters are the only source');
A.eq(Xp.compute(legacy).tasksDone, 31, 'its older, differently-scoped counters are untouched and still surface elsewhere');
// and it recalibrates from real evidence once it runs again, without inheriting the legacy history
const rLegacyRan = Xp.reliability(run([done(), done(), done()], legacy).stats);
A.eq(rLegacyRan.attempted, 3, 'a pre-S2 agent calibrates from its NEW runs only');
A.eq(rLegacyRan.known, true, 'and becomes known after MIN_RUNS real, attributable runs');

A.report('xp.test');
