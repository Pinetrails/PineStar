/* test/subagentsprites.test.js — the pure ledger fold behind the Meeseeks sub-agent sprite layer (G4 feature 3).

   Verifies the truthfulness law (a helper exists IFF a real sub-agent is live), the materialize→dissolve→prune
   lifecycle, the visible cap + '+N' overflow, and that non-subagent 'task' events never touch the ledger. Time is
   injected so the fold is deterministic. */
'use strict';
const A = require('./_assert.js');
const SS = require('../frontend/app/subagentsprites.js');

const ev = (id, status, extra) => Object.assign({ id, status, kind: 'subagent', title: 'sub ' + id }, extra || {});

/* ---- materialize on running ---- */
let L = SS.makeLedger();
L.fold(ev('a', 'running'), 0, 'lead1');
A.eq(L.count(), 1, 'a running sub-agent materializes one helper');
let v = L.list(0);
A.eq(v.shown.length, 1, 'the helper is in the draw list');
A.eq(v.shown[0].phase, 'materialize', 'a fresh helper is materializing');
A.eq(v.shown[0].alpha, 0, 'materialize alpha starts at 0');
A.eq(v.shown[0].leadId, 'lead1', 'the helper remembers its lead (for positioning near the lead desk)');

// alpha ramps to 1 over MATERIALIZE_MS
v = L.list(SS.MATERIALIZE_MS);
A.eq(v.shown[0].alpha, 1, 'materialize alpha reaches 1 after the fade window');

/* ---- truthfulness: a helper exists IFF the sub-agent is live ---- */
// a NON-subagent task event never touches the ledger (the desk-progress 'task' stream must not spawn helpers).
L.fold({ id: 'x', status: 'running', kind: 'sim' }, 10);
A.eq(L.count(), 1, 'a non-subagent task event spawns no helper');

/* ---- dissolve on completion, then prune ---- */
L.fold(ev('a', 'done'), 1000);
A.eq(L.count(), 0, 'a completed sub-agent is no longer counted LIVE the instant it ends');
v = L.list(1000);
A.eq(v.shown[0].phase, 'dissolve', 'a completed helper enters the dissolve (poof) phase');
A.eq(v.shown[0].alpha, 1, 'dissolve alpha starts at 1');
v = L.list(1000 + SS.DISSOLVE_MS);
A.eq(v.shown[0].alpha, 0, 'dissolve alpha reaches 0 at the end of the poof');
A.eq(L.prune(1000 + SS.DISSOLVE_MS), 1, 'prune drops the fully-dissolved helper');
A.eq(L.list(9999).total, 0, 'the ledger is empty after the poof finishes');

/* ---- a terminal state for an UNTRACKED id is a no-op (never spawns a dying ghost) ---- */
L.clear();
L.fold(ev('ghost', 'failed'), 0);
A.eq(L.list(0).total, 0, 'a terminal event for an unknown sub-agent creates nothing');

/* ---- resume revives a dying helper (a re-emitted running) ---- */
L.clear();
L.fold(ev('r', 'running'), 0);
L.fold(ev('r', 'interrupted'), 100);
A.eq(L.list(100).shown[0].phase, 'dissolve', 'an interrupt begins the dissolve');
L.fold(ev('r', 'running'), 200);
A.eq(L.list(200).shown[0].phase, 'materialize', 'a resume (re-emitted running) revives the helper');
A.eq(L.count(), 1, 'the revived helper counts live again');

/* ---- cap + overflow: many live sub-agents fold into a visible cap + '+N' ---- */
L = SS.makeLedger({ cap: 3 });
for (let i = 0; i < 6; i++) L.fold(ev('s' + i, 'running'), i);   // stagger bornAt so the sort is stable
v = L.list(1000);
A.eq(v.shown.length, 3, 'only cap=3 helpers are drawn');
A.eq(v.overflow, 3, 'the remaining live helpers fold into +3');
A.eq(v.liveCount, 6, 'all six are counted as live (the truthful gauge)');
// the shown set is the OLDEST first (stable), so s0..s2 draw and s3..s5 overflow
A.eq(v.shown.map(s => s.id).join(','), 's0,s1,s2', 'the visible helpers are the oldest, stably ordered');

/* ---- a dissolving helper beyond the cap does not inflate the overflow count ---- */
L.fold(ev('s5', 'done'), 2000);
v = L.list(2000);
A.eq(v.overflow, 2, 'a dissolving overflow helper drops out of the +N count');

A.report('subagentsprites');
