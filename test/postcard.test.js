/* node test/postcard.test.js — the pure POSTCARD stat-assembly reducer (frontend/app/postcard.js).
   Locks the G5 spectacle honesty contract: EVERY number on the shareable card is a fold of REAL run
   telemetry the frontend already holds, and any stat with no provable value is OMITTED — never faked.
   Specifically:
     • a run with no priced spend shows NO "$0"; a subscription run shows "subscription"; a real cost shows.
     • token/artifact/duration/model chips appear ONLY when they have a real value.
     • the GROWTH line is present only when Xp.compute(stats) is computable; confidence % appears only when
       calibrated (known) — never a fabricated number before MIN_SAMPLES.
     • the STATION record honours the pride "—" law: each counter gated on its own known flag; a wholly
       unknown record drops the block rather than show a hollow one; a 0/absent founded date never renders 1969.
   Pure + deterministic — the caller injects nowMs; no DOM/canvas is touched by assemble(). */
'use strict';
const A = require('./_assert.js');
const P = require('../frontend/app/postcard.js');
const Xp = require('../frontend/app/xp.js');

// a hero stats blob with N kept-feedback samples folded in (real Xp engine, so Level/confidence are honest).
function statsWith(samples, quality) {
  let s = Xp.fresh();
  for (let i = 0; i < samples; i++) {
    s = Xp.applyEvent(s, { name: 'memory.feedback', payload: { reason: quality >= 1 ? 'work_great' : 'work_ok', delta: 3, size: 'medium' } }).stats;
  }
  // ship a couple of tasks too so tasksDone is real
  s = Xp.applyEvent(s, { name: 'agent.run.end', payload: { reason: 'done' } }).stats;
  s = Xp.applyEvent(s, { name: 'agent.run.end', payload: { reason: 'done' } }).stats;
  return s;
}

/* ---------- a clean run with real spend/tokens/artifacts renders every honest chip ---------- */
{
  const run = { reason: 'done', title: 'summarise the Q3 deck', artifacts: [{ path: 'out.md' }, { path: 'a.png' }], usd: 0.042, model: 'anthropic/claude', tokens: 12500 };
  const card = P.assemble({ run, durMs: 95000, agent: { name: 'Ultron', stats: statsWith(3, 1) }, xp: Xp, pride: null, nowMs: 1751000000000 });
  A.eq(card.done, true, 'a done run is done');
  A.eq(card.outcome, 'DELIVERED', 'the outcome headline is DELIVERED');
  A.eq(card.agentName, 'Ultron', 'the agent name is carried');
  A.eq(card.title, 'summarise the Q3 deck', 'the real directive title is on the card');
  A.ok(card.chips.indexOf('2 artifacts') !== -1, '2 real artifacts → a chip');
  A.ok(card.chips.some(c => /1m/.test(c)), '95s duration renders as a minute chip');
  A.ok(card.chips.indexOf('$0.04') !== -1, 'the real reconciled cost shows');
  A.ok(card.chips.indexOf('13k tok') !== -1, 'the real token count shows (k-formatted, 0dp at/above 10k)');
  A.ok(card.chips.indexOf('anthropic/claude') !== -1, 'the real model shows');
  A.ok(!!card.growth, 'a calibrated hero has a growth line');
  A.eq(card.growth.level, Xp.compute(statsWith(3, 1)).level, 'the level matches the honest Xp curve');
}

/* ---------- HONESTY: a free/unpriced run shows NO "$0"; an abnormal end reads honestly ---------- */
{
  const run = { reason: 'max_iters', title: 'endless loop', artifacts: [], usd: 0, model: '(unknown)' };
  const card = P.assemble({ run, durMs: 0, agent: { name: 'X' }, xp: Xp, pride: null, nowMs: 1751000000000 });
  A.eq(card.done, false, 'a max_iters run is not done');
  A.eq(card.outcome, 'ENDED · MAX_ITERS', 'the honest non-done outcome');
  A.ok(!card.chips.some(c => /\$/.test(c)), 'a $0 run shows NO fake cost chip');
  A.ok(!card.chips.some(c => /tok/.test(c)), 'no tokens → no token chip');
  A.ok(card.chips.indexOf('(unknown)') === -1, 'the "(unknown)" model sentinel is suppressed');
  A.eq(card.chips.length, 0, 'nothing provable → an empty chip row, not fabricated filler');
}

/* ---------- a subscription (unmetered) run reads "subscription", never $0 ---------- */
{
  const run = { reason: 'done', title: 't', artifacts: [{ path: 'x' }], usd: 0, unmetered: true, model: 'm', tokens: 400 };
  const card = P.assemble({ run, durMs: 5000, agent: { name: 'A' }, xp: Xp, pride: null, nowMs: 1 });
  A.ok(card.chips.indexOf('subscription') !== -1, 'an unmetered run labels its spend "subscription"');
  A.ok(!card.chips.some(c => /\$/.test(c)), 'and shows no dollar figure');
  A.ok(card.chips.indexOf('1 artifact') !== -1, 'a single artifact is singular');
  A.ok(card.chips.indexOf('400 tok') !== -1, 'a sub-1k token count shows raw');
}

/* ---------- GROWTH: an UNCALIBRATED hero shows a level but NO fabricated confidence % ---------- */
{
  const s = statsWith(1, 1);   // 1 sample < MIN_SAMPLES(3): confidence must be unknown
  const card = P.assemble({ run: { reason: 'done', artifacts: [{ path: 'x' }] }, durMs: 1000, agent: { name: 'A', stats: s }, xp: Xp, pride: null, nowMs: 1 });
  A.ok(!!card.growth, 'a hero with stats still gets a growth line');
  A.eq(card.growth.confLabel, '', 'an uncalibrated hero shows NO confidence % (never fabricated)');
  A.ok(card.growth.tasksDone >= 2, 'the real shipped-task count is honest');
}

/* ---------- GROWTH omitted entirely when there are no stats to compute ---------- */
{
  const card = P.assemble({ run: { reason: 'done', artifacts: [{ path: 'x' }] }, durMs: 1000, agent: { name: 'A' }, xp: Xp, pride: null, nowMs: 1 });
  A.eq(card.growth, null, 'no stats → no growth block (nothing invented)');
}

/* ---------- STATION record: each counter gated on its own known flag; unknowns omitted ---------- */
{
  const pride = { founded: true, foundedAt: 1751000000000, tasks: 7, tasksKnown: true, deliverables: 0, deliverablesKnown: false, workMinutes: 40, workKnown: true };
  const card = P.assemble({ run: { reason: 'done', artifacts: [{ path: 'x' }] }, durMs: 1000, agent: { name: 'A' }, xp: Xp, pride, nowMs: 1 });
  A.ok(!!card.station, 'a pride snapshot with known counters yields a station block');
  A.eq(card.station.tasks, 7, 'a known task count is shown');
  A.eq(card.station.deliverables, null, 'an UNKNOWN deliverables count is omitted (null), not shown as 0');
  A.eq(card.station.workMinutes, 40, 'a known work-minutes count is shown');
  A.ok(!!card.station.founded, 'a real founded date is formatted (non-empty)');
}

/* ---------- STATION record: a wholly-unknown record drops the whole block (no hollow shell) ---------- */
{
  const pride = { founded: false, foundedAt: 0, tasks: 0, tasksKnown: false, deliverables: 0, deliverablesKnown: false, workMinutes: 0, workKnown: false };
  const card = P.assemble({ run: { reason: 'done', artifacts: [{ path: 'x' }] }, durMs: 1000, agent: { name: 'A' }, xp: Xp, pride, nowMs: 1 });
  A.eq(card.station, null, 'a station with nothing real yet shows no record block at all');
}

/* ---------- a 0 / absent founded date never renders epoch-0/1969 ---------- */
{
  A.eq(P._fmt.date(0), '', 'a 0 epoch is not a real date (never 1969)');
  A.eq(P._fmt.date(null), '', 'a null is not a real date');
  A.eq(P._fmt.date(-5), '', 'a negative epoch is not a real date');
  A.ok(P._fmt.date(1751000000000).length > 0, 'a real positive epoch DOES format');
}

/* ---------- formatters: cost + duration are honest ---------- */
{
  A.eq(P._fmt.usd(0), '', 'zero cost formats to empty (no fake $0)');
  A.eq(P._fmt.usd(0.5), '$0.50', 'a normal cost formats to 2dp');
  A.eq(P._fmt.ms(0), '', 'zero duration formats to empty');
  A.eq(P._fmt.ms(45000), '45s', 'under a minute → seconds');
  A.ok(/2m/.test(P._fmt.ms(125000)), 'over a minute → minutes');
}

/* ---------- a monster directive title is clamped so it can't blow out the card ---------- */
{
  const long = 'x'.repeat(200);
  const card = P.assemble({ run: { reason: 'done', title: long, artifacts: [{ path: 'x' }] }, durMs: 1, agent: { name: 'A' }, xp: Xp, pride: null, nowMs: 1 });
  A.ok(card.title.length <= 61, 'the title is clamped (<= 60 + ellipsis)');
  A.ok(/…$/.test(card.title), 'a clamped title ends with an ellipsis');
}

A.report('postcard');
