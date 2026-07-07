/* node test/nightreport.test.js — the PURE morning-report engine (frontend/app/nightreport.js), NS-4.

   Locks the honest digest: compose() turns { status, ledger, drafts } into a report that names the acts AND the
   declined half (which gate bound them), the "did nothing and why" sentence, LOCAL-time formatting, and the
   no-absence/no-decision → no-beat rule. Pure + deterministic — nowMs and tz-offset are always explicit. */
'use strict';
const A = require('./_assert.js');
const NR = require('../frontend/app/nightreport.js');

/* ---------- fmtLocalTime(): LOCAL clock, explicit offset, honest empties ---------- */
// 2026-01-01T06:10:00Z = 1735711800000. At UTC (offset 0) that is 6:10 AM.
const T0610Z = Date.UTC(2026, 0, 1, 6, 10, 0);
A.eq(NR.fmtLocalTime(T0610Z, 0), '6:10 AM', 'UTC render of 06:10Z is 6:10 AM');
// EST is UTC-5 → offset -300 → 1:10 AM local (the task's worked example).
A.eq(NR.fmtLocalTime(T0610Z, -300), '1:10 AM', 'offset -300 (EST) renders 06:10Z as LOCAL 1:10 AM');
// crossing midnight backward stays a valid clock (no negative/25h times).
A.eq(NR.fmtLocalTime(Date.UTC(2026, 0, 1, 2, 0, 0), -300), '9:00 PM', 'offset -300 wraps 02:00Z back to 9:00 PM prev day');
A.eq(NR.fmtLocalTime(Date.UTC(2026, 0, 1, 0, 0, 0), 0), '12:00 AM', 'midnight renders as 12:00 AM not 0:00');
A.eq(NR.fmtLocalTime(Date.UTC(2026, 0, 1, 12, 0, 0), 0), '12:00 PM', 'noon renders as 12:00 PM not 0:00');
A.eq(NR.fmtLocalTime(0, -300), '', '0 ms → empty string (no fake clock for no data)');
A.eq(NR.fmtLocalTime(null, -300), '', 'null ms → empty string');

/* ---------- bindingPhrase(): every gate has an honest sentence; unknowns stay honest ---------- */
A.ok(/not allowed to act/i.test(NR.bindingPhrase('posture')), 'posture phrase says it may not act unattended');
A.ok(/away/i.test(NR.bindingPhrase('present')), 'present phrase names your presence');
A.ok(/leash/i.test(NR.bindingPhrase('leash')), 'leash phrase names the leash');
A.ok(/gate/i.test(NR.bindingPhrase('some-future-gate')), 'an unknown binding renders honestly (names the gate), never a fabricated reason');
A.ok(/no gate/i.test(NR.bindingPhrase(null)), 'null binding → "no gate is blocking" (a beat could fire now)');

/* ---------- compose(): the no-report rule (no absence / no decision → no beat) ---------- */
const empty = NR.compose({ status: null, ledger: [], drafts: [], awaySince: 1000, nowMs: 9999, tzOffsetMin: 0 });
A.eq(empty.hasReport, false, 'zero acts + zero declines → hasReport:false (caller shows NO beat, never a nag)');

// a ledger with only entries BEFORE the away window is out of scope → still no report.
const stale = NR.compose({
  status: null, awaySince: 5000, nowMs: 9999, tzOffsetMin: 0,
  ledger: [{ source: 'nightshift', kind: 'decline', binding: 'leash', ts: 1000 }], drafts: []
});
A.eq(stale.hasReport, false, 'a decline BEFORE awaySince is out of scope → no report');

/* ---------- compose(): acts + drafts → the headline + act lines ---------- */
const acted = NR.compose({
  status: { active: true, binding: 'cooldown' },
  awaySince: 1000, nowMs: 999999, tzOffsetMin: -300,
  ledger: [
    { source: 'nightshift', kind: 'act', ts: 2000 },
    { source: 'nightshift', kind: 'act', ts: 3000 }
  ],
  drafts: [
    { title: 'Refactor plan', at: 2000, body: 'the body', archetype: 'plan' },
    { title: 'Test outline', at: 3000, body: '', archetype: 'test' }
  ]
});
A.eq(acted.hasReport, true, 'acts present → hasReport:true');
A.eq(acted.actCount, 2, 'two acts counted');
A.ok(/2 beats fired/.test(acted.headline), 'headline names the beats fired');
A.ok(/2 drafts on your desk/.test(acted.headline), 'headline names the drafts on the desk');
A.eq(acted.actLines, ['✓ Refactor plan', '✓ Test outline'], 'one act line per draft, by real title');
A.eq(acted.idleReason, '', 'a night that ACTED has no idle sentence');
A.eq(acted.drafts.length, 2, 'drafts carried through for the "show me" reveal');

/* ---------- compose(): the honest DECLINED half — grouped by gate, LOCAL time ---------- */
const mixed = NR.compose({
  status: { active: true, binding: 'leash' },
  awaySince: 1000, nowMs: 999999, tzOffsetMin: -300,
  ledger: [
    { source: 'nightshift', kind: 'act', ts: 2000 },
    { source: 'nightshift', kind: 'decline', binding: 'leash', ts: T0610Z },
    { source: 'nightshift', kind: 'decline', binding: 'leash', ts: T0610Z - 60000 }
  ],
  drafts: [{ title: 'Did a thing', at: 2000, body: 'x' }]
});
A.eq(mixed.declineCount, 2, 'two declines counted');
A.eq(mixed.declineLines.length, 1, 'two declines on the SAME gate collapse to one grouped line');
A.ok(/2 beats skipped/.test(mixed.declineLines[0]), 'the decline line names the count');
A.ok(/leash/i.test(mixed.declineLines[0]), 'the decline line names the binding gate');
A.ok(/by 1:10 AM/.test(mixed.declineLines[0]), 'the decline line names the LOCAL time of the last occurrence');

/* ---------- compose(): "did NOTHING and why" — one plain sentence from the dominant binding ---------- */
const idle = NR.compose({
  status: { active: true, binding: 'posture' },
  awaySince: 1000, nowMs: 999999, tzOffsetMin: 0,
  ledger: [
    { source: 'nightshift', kind: 'decline', binding: 'posture', ts: 2000 },
    { source: 'nightshift', kind: 'decline', binding: 'posture', ts: 3000 },
    { source: 'nightshift', kind: 'decline', binding: 'cooldown', ts: 4000 }
  ],
  drafts: []
});
A.eq(idle.actCount, 0, 'no acts → an idle night');
A.ok(idle.hasReport, 'an idle night with declines STILL reports (the honest "why nothing" half)');
A.ok(/Nothing landed on your desk/.test(idle.idleReason), 'idle sentence leads with nothing landing');
A.ok(/not allowed to act/i.test(idle.idleReason), 'idle sentence derives its reason from the DOMINANT binding (posture, 2×)');

// scoping: a non-nightshift ledger source (e.g. cron) never leaks into the night-shift report.
const cronOnly = NR.compose({
  status: null, awaySince: 1000, nowMs: 9999, tzOffsetMin: 0,
  ledger: [{ source: 'cron', kind: 'act', ts: 2000 }], drafts: []
});
A.eq(cronOnly.hasReport, false, 'a cron ledger entry is NOT a night-shift act (scoped by source)');

/* ---------- panelModel(): honest telemetry, no fake-zero ---------- */
const unreachable = NR.panelModel({ status: null, tzOffsetMin: 0 });
A.eq(unreachable.reachable, false, 'null status → reachable:false');
A.ok(/unreachable/i.test(unreachable.stateText), 'unreachable state says so plainly (never a fake 0/3)');

const panelOff = NR.panelModel({ status: { active: false, away: false, beatsUsedToday: 0, leashPerDay: 3, binding: 'present', lastBeatAt: 0, nextEligibleAt: 0 }, tzOffsetMin: -300 });
A.eq(panelOff.reachable, true, 'a real status → reachable:true');
A.eq(panelOff.stateText, 'OFF', 'inactive timer → OFF');
A.ok(/away/i.test(panelOff.why), 'OFF-because-present names the reason from the binding');
A.eq(panelOff.leashText, '0/3 beats today', 'leash text is used/leash, honest');
A.eq(panelOff.lastBeatText, 'no beat yet', 'no last beat → honest "no beat yet", not a fake time');

const panelActive = NR.panelModel({ status: { active: true, away: true, beatsUsedToday: 2, leashPerDay: 3, binding: 'cooldown', lastBeatAt: T0610Z, nextEligibleAt: T0610Z + 2700000 }, tzOffsetMin: -300 });
A.ok(/ACTIVE/.test(panelActive.stateText), 'active + away → ACTIVE on watch');
A.eq(panelActive.leashText, '2/3 beats today', 'leash reflects beats used');
A.eq(panelActive.leashSpent, false, '2/3 is not spent');
A.eq(panelActive.lastBeatText, '1:10 AM', 'last beat renders in LOCAL time');
A.eq(NR.panelModel({ status: { active: true, away: true, beatsUsedToday: 3, leashPerDay: 3 }, tzOffsetMin: 0 }).leashSpent, true, '3/3 → leashSpent:true');
// a null leashPerDay (never configured) must NOT render "used/null" — honest fallback.
A.eq(NR.panelModel({ status: { active: true, away: true, beatsUsedToday: 1, leashPerDay: null }, tzOffsetMin: 0 }).leashText, '1 beats today', 'null leash → "N beats today", never "1/null"');

/* ---------- trailLine(): one honest ledger row for the panel ---------- */
A.eq(NR.trailLine({ ts: T0610Z, kind: 'decline', binding: 'leash' }, -300), '1:10 AM · declined · the daily leash was already spent', 'a decline row: local time · declined · gate reason');
A.eq(NR.trailLine({ ts: T0610Z, kind: 'act', detail: { title: 'Wrote X' } }, -300), '1:10 AM · acted · Wrote X', 'an act row names the title from detail');
A.ok(/noted/.test(NR.trailLine({ ts: T0610Z, kind: 'note', reason: 'delivered' }, -300)), 'a note row renders its reason');

/* ---------- purity / determinism ---------- */
const args = { status: { active: true, binding: 'leash' }, awaySince: 1000, nowMs: 5, tzOffsetMin: 0, ledger: [{ source: 'nightshift', kind: 'decline', binding: 'leash', ts: 2000 }], drafts: [] };
A.eq(NR.compose(args), NR.compose(args), 'compose() is deterministic for the same input');

A.report('nightreport.test');
