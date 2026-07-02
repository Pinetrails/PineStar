/* node test/queststate.test.js — the pure durable-quest-memory engine (frontend/app/queststate.js).
   Locks the G1a contract: first sight is baseline (a quest already done backfills completedAt, NEVER
   celebrates — no celebration storm on resume); an open→done diff celebrates exactly once and stamps
   completedAt; dismissed = stop forever (never re-renders, never re-fires, even when the underlying thing
   later completes); only dossier "get to know you" quests are dismissible — milestones are achievements.
   Pure + deterministic: the clock is injected, so every timestamp is asserted exactly. */
'use strict';
const A = require('./_assert.js');
const QS = require('../frontend/app/queststate.js');

const q = (id, status, kind) => ({ id, status, kind: kind || (id.indexOf('dim:') === 0 ? 'dossier' : 'milestone'), title: 'T ' + id, reward: 'real work' });

/* ---------- fresh / hydrate are defensive ---------- */
let s = QS.hydrate(null);
A.ok(s && s.v === 1 && s.seen && s.dismissed, 'hydrate(null) → a fresh, well-formed state');
const junk = QS.hydrate({ v: 9, seen: { a: null, b: {}, c: { firstSeenAt: 'x' }, ok: { firstSeenAt: 5, completedAt: 'nope', lastStatus: 'weird' } }, dismissed: { d: 'NaN', e: 7 } });
A.eq(Object.keys(junk.seen), ['ok'], 'hydrate drops malformed seen entries, keeps the valid one');
A.eq(junk.seen.ok, { firstSeenAt: 5, completedAt: null, lastStatus: 'open' }, 'hydrate sanitizes completedAt/lastStatus');
A.eq(Object.keys(junk.dismissed), ['e'], 'hydrate drops non-numeric dismissal stamps');

/* ---------- first sight = baseline, never a celebration ---------- */
s = QS.fresh();
let r = QS.fold(s, [q('dim:goals', 'open'), q('ms:first_light', 'done')], 1000);
A.eq(r.completions, [], 'first sight never celebrates — even a quest first seen done (resume backfill)');
A.eq(QS.stateOf(s, 'dim:goals'), { firstSeenAt: 1000, completedAt: null, lastStatus: 'open', dismissedAt: null }, 'an open quest records firstSeenAt only');
A.eq(QS.stateOf(s, 'ms:first_light').completedAt, 1000, 'done-at-first-sight backfills completedAt for the future trophy case');

/* ---------- open→done celebrates exactly once, with completedAt ---------- */
r = QS.fold(s, [q('dim:goals', 'done'), q('ms:first_light', 'done')], 2000);
A.eq(r.completions.length, 1, 'exactly one completion on the open→done edge');
A.eq(r.completions[0].id, 'dim:goals', 'the transitioned quest is the completion');
A.eq(QS.stateOf(s, 'dim:goals').completedAt, 2000, 'completedAt is stamped at the transition');
r = QS.fold(s, [q('dim:goals', 'done'), q('ms:first_light', 'done')], 3000);
A.eq(r.completions, [], 'the same projection folded again is silent — one celebration per completion');
A.eq(QS.stateOf(s, 'dim:goals').completedAt, 2000, 'completedAt is not re-stamped by a repeat fold');

/* ---------- a real regression then a real re-completion celebrates again ---------- */
r = QS.fold(s, [q('dim:goals', 'open')], 4000);
A.eq(r.completions, [], 'done→open (e.g. a forgotten belief) never celebrates');
A.eq(QS.stateOf(s, 'dim:goals').completedAt, 2000, 'the regression keeps the LAST real completion time');
r = QS.fold(s, [q('dim:goals', 'done')], 5000);
A.eq(r.completions.length, 1, 'a genuinely new open→done edge celebrates again');
A.eq(QS.stateOf(s, 'dim:goals').completedAt, 5000, '…and re-stamps completedAt');

/* ---------- a quest may vanish and return without a phantom celebration ---------- */
r = QS.fold(s, [], 5500);
A.eq(r.completions, [], 'an empty projection is silent');
r = QS.fold(s, [q('dim:goals', 'done')], 5600);
A.eq(r.completions, [], 'reappearing still-done is not a new completion');

/* ---------- dismissibility: dossier yes, milestone/idea no ---------- */
A.eq(QS.dismissible({ kind: 'dossier' }), true, 'get-to-know-you quests are dismissible');
A.eq(QS.dismissible({ kind: 'milestone' }), false, 'milestones are achievements — never dismissible');
A.eq(QS.dismissible({ kind: 'idea' }), false, 'the idea quest is owned by the COMMS suggestion cadence — not dismissible here');
A.eq(QS.dismissible(null), false, 'dismissible(null) never throws');

/* ---------- dismiss: only dismissible kinds take; idempotent ---------- */
A.eq(QS.dismiss(s, q('ms:first_light', 'done'), 6000), false, 'dismissing a milestone is refused');
A.eq(QS.isDismissed(s, 'ms:first_light'), false, '…and leaves no mark');
A.eq(QS.dismiss(s, q('dim:stack', 'open'), 6000), true, 'dismissing an open dossier quest takes');
A.eq(QS.isDismissed(s, 'dim:stack'), true, '…and is recorded');
A.eq(QS.stateOf(s, 'dim:stack').dismissedAt, 6000, 'dismissedAt is stamped');
A.eq(QS.dismiss(s, q('dim:stack', 'open'), 7000), false, 'a second dismiss is a no-op');
A.eq(QS.stateOf(s, 'dim:stack').dismissedAt, 6000, '…and never re-stamps');

/* ---------- dismissed = never re-renders ---------- */
const vis = QS.visible(s, [q('dim:stack', 'open'), q('dim:goals', 'done'), q('ms:first_light', 'done')]);
A.eq(vis.map(x => x.id), ['dim:goals', 'ms:first_light'], 'visible() drops the dismissed quest, keeps the rest');

/* ---------- dismissed = never re-fires (the anti-nag law) ---------- */
r = QS.fold(s, [q('dim:stack', 'done')], 8000);
A.eq(r.completions, [], 'even a REAL completion of a dismissed quest stays silent forever');

/* ---------- malformed input never crashes ---------- */
A.notThrows(() => QS.fold(s, [null, {}, { id: '' }, { id: 'x' }], 9000), 'malformed quests are skipped, never a crash');
A.eq(QS.fold(null, [q('dim:goals', 'done')], 9100).completions, [], 'fold(null state) degrades to no completions');
A.eq(QS.visible(null, [q('a', 'open', 'dossier')]).length, 1, 'visible(null state) passes quests through');
A.eq(QS.stateOf(s, null), null, 'stateOf(null id) is null');
A.eq(QS.stateOf(s, 'never-seen'), null, 'stateOf(unknown id) is null');

/* ---------- persistence round-trip ---------- */
const back = QS.hydrate(JSON.parse(JSON.stringify(s)));
A.eq(back.seen['dim:goals'], s.seen['dim:goals'], 'seen records survive a JSON round-trip');
A.eq(QS.isDismissed(back, 'dim:stack'), true, 'dismissals survive a JSON round-trip');
r = QS.fold(back, [q('dim:goals', 'done'), q('dim:stack', 'done')], 10000);
A.eq(r.completions, [], 'a rehydrated state stays silent for already-done and dismissed quests alike');

A.report('queststate.test');
