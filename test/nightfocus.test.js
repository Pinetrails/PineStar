/* node test/nightfocus.test.js — the PURE FOCUS RESOLVER (NS-5b).

   Andrew direction: "hone in on moving the needle" — single-priority nights, evidence-cited, never scattered.
   Proves the deterministic focus resolver (clock INJECTED, no wall-clock / rng / fs):
     · a shift declares ONE focus ranked from real evidence (blessed projects · open threads · goal arc)
     · the declared focus ALWAYS carries a non-empty cited `why` (truthful-telemetry law — never an unexplained pick)
     · a durable user STEER outranks derived evidence until it goes stale (~7d) or is cleared
     · ensureFocus is day-keyed + steer-aware: same day + no newer steer ⇒ the SAME focus (single-focus-per-night),
       re-resolving only on a day-roll / a fresh steer (the persisted-across-restart property the host round-trips)
     · loadEnvelope/toEnvelope are tolerant + fail-closed (garbage → floor) so a restart resumes, never resets. */
'use strict';
const A = require('./_assert.js');
const F = require('../sidecar/nightfocus.js');

const DAY = 86400000;
const T0 = Math.floor(1700000000000 / DAY) * DAY + 8 * 3600000;   // 08:00 UTC on a fixed day (so +Nh stays same day)

function projects(over) {
  return [
    { root: 'C:/repo/alpha', displayPath: 'C:/repo/alpha', lastTouchedAt: T0 - 2 * 3600000, isGitRepo: true },   // touched 2h ago
    { root: 'C:/repo/beta', displayPath: 'C:/repo/beta', lastTouchedAt: T0 - 10 * DAY, isGitRepo: false },        // 10d stale
    ...(over || [])
  ];
}
const threads = [{ id: 'th1', title: 'ship the invoice export', spec: 'CSV of paid invoices', updatedAt: T0 - 3 * DAY }];
const goal = { text: 'launch the beta', done: 1, total: 4, next: 'wire the signup' };

// ---- a focus is declared, single, and cited ----
(function declaresCitedFocus() {
  const f = F.resolveFocus({ projects: projects(), threads, goal }, { now: T0 });
  A.ok(f && f.kind, 'a focus is declared');
  A.ok(Array.isArray(f.why) && f.why.length > 0, 'focus carries non-empty cited evidence');
  A.eq(f.kind, 'project', 'the freshest blessed project outranks a 3d thread + a goal');
  A.eq(f.ref, 'C:/repo/alpha', 'the most-recently-touched root wins, not the stale one');
})();

// ---- an empty evidence field yields no focus (honest, never a fabricated pick) ----
(function noEvidenceNoFocus() {
  const f = F.resolveFocus({ projects: [], threads: [], goal: null }, { now: T0 });
  A.eq(f, null, 'nothing to cite ⇒ no focus (improv fallback territory)');
})();

// ---- a stale project (outside the recency window) does not become the focus on its own ----
(function staleProjectYieldsThreadOrGoal() {
  const f = F.resolveFocus({ projects: [{ root: 'C:/repo/beta', displayPath: 'C:/repo/beta', lastTouchedAt: T0 - 40 * DAY }], threads, goal }, { now: T0 });
  A.ok(f && f.kind !== 'project', 'a 40d-stale project loses to a live thread/goal');
})();

// ---- STEER outranks derived evidence, and cites itself ----
(function steerOutranks() {
  const steer = { ref: 'C:/repo/beta', kind: 'project', setAt: T0 - 1 * DAY };
  const f = F.resolveFocus({ projects: projects(), threads, goal, steer }, { now: T0 });
  A.eq(f.ref, 'C:/repo/beta', 'a fresh steer outranks the freshest derived project');
  A.eq(f.source, 'steer', 'the focus reports it came from a steer');
  A.ok(f.why.length > 0 && /focus/i.test(f.why.join(' ')), 'the steer focus cites the user directive');
})();

// ---- a STALE steer (>7d) is ignored; derived evidence wins again ----
(function staleSteerIgnored() {
  const steer = { ref: 'C:/repo/beta', kind: 'project', setAt: T0 - 8 * DAY };
  A.eq(F.steerActive(steer, T0), false, 'a >7d steer is stale');
  const f = F.resolveFocus({ projects: projects(), threads, goal, steer }, { now: T0 });
  A.eq(f.ref, 'C:/repo/alpha', 'a stale steer falls back to derived evidence');
})();

// ---- ensureFocus: single-focus-per-night, persisted, re-resolved only on a day-roll / a fresh steer ----
(function ensureFocusStable() {
  let st = F.fresh(T0);
  const inputs = { projects: projects(), threads, goal };
  const a = F.ensureFocus(st, inputs, { now: T0 });
  A.ok(a.focus && a.resolved, 'first beat of the night resolves a focus');
  st = a.state;
  // a later beat SAME day with the SAME evidence keeps the same focus (does not re-scatter)
  const b = F.ensureFocus(st, inputs, { now: T0 + 3 * 3600000 });
  A.eq(b.resolved, false, 'a later same-night beat does NOT re-resolve');
  A.eq(b.focus.ref, a.focus.ref, 'the night keeps ONE focus');
  st = b.state;
  // a NEW day re-resolves
  const c = F.ensureFocus(st, inputs, { now: T0 + 1 * DAY });
  A.eq(c.resolved, true, 'a new day re-resolves the focus');
})();

// ---- a fresh steer applied mid-night re-resolves toward the steered ref ----
(function steerReResolves() {
  let st = F.fresh(T0);
  st = F.ensureFocus(st, { projects: projects(), threads, goal }, { now: T0 }).state;
  st = F.applySteer(st, { ref: 'C:/repo/beta', kind: 'project' }, T0 + 3600000);
  const r = F.ensureFocus(st, { projects: projects(), threads, goal }, { now: T0 + 2 * 3600000 });
  A.eq(r.resolved, true, 'a fresh steer forces a re-resolve');
  A.eq(r.focus.ref, 'C:/repo/beta', 'the steered ref becomes the focus');
  A.eq(r.focus.source, 'steer', 'and it is flagged as steer-sourced');
})();

// ---- clearSteer drops the durable steer ----
(function clearSteerWorks() {
  let st = F.applySteer(F.fresh(T0), { ref: 'C:/repo/beta', kind: 'project' }, T0);
  st = F.ensureFocus(st, { projects: projects(), threads, goal }, { now: T0 + 1 }).state;
  A.eq(st.focus.source, 'steer', 'precondition: the cached focus came from the steer');
  st = F.clearSteer(st);
  A.eq(st.steer, null, 'clearSteer removes the steer');
  A.eq(st.focus, null, 'clearSteer also removes the steer-derived cached focus');
  const fresh = F.ensureFocus(st, { projects: projects(), threads, goal }, { now: T0 + 2 });
  A.ok(fresh.resolved && fresh.focus && fresh.focus.source === 'evidence', 'the next resolution is fresh evidence, never the cleared directive');
  A.eq(fresh.focus.ref, 'C:/repo/alpha', 'clearing the steer reveals the current best evidence');
})();

// ---- envelope round-trips + tolerant hydrate ----
(function envelope() {
  let st = F.ensureFocus(F.fresh(T0), { projects: projects(), threads, goal }, { now: T0 }).state;
  const env = F.toEnvelope(st, T0);
  const back = F.loadEnvelope(JSON.stringify(env), T0);
  A.eq(back.focus.ref, st.focus.ref, 'focus survives a serialize round-trip (restart-safe)');
  A.notThrows(() => F.loadEnvelope('not json at all', T0), 'garbage envelope never throws');
  A.eq(F.loadEnvelope('garbage', T0).focus, null, 'a corrupt envelope degrades to no-focus floor');
})();

// ---- FLAGSHIP CROSS-WIRE: open ledger QUESTS rank as evidence (a fresh explicit quest beats a stale project) ----
(function questsRank() {
  const quests = [{ id: 'q:1', title: 'ship the CSV export', contractType: 'artifact', createdAt: T0 - 1 * 3600000 }];   // 1h-old work quest
  // only a 20d-stale project on the board (no fresh project, no thread, no goal) — the fresh work quest must win.
  const f = F.resolveFocus({ projects: [{ root: 'C:/repo/old', displayPath: 'C:/repo/old', lastTouchedAt: T0 - 20 * DAY }], threads: [], goal: null, quests }, { now: T0 });
  A.eq(f.kind, 'quest', 'a fresh work quest outranks a 20d-stale project');
  A.eq(f.ref, 'q:1', 'the quest ref is the ledger id');
  A.ok(f.why.length > 0 && /work quest/i.test(f.why.join(' ')), 'the quest focus cites the open work quest');
})();

// ---- a WORK quest (run/artifact) outranks a weaker prop/fact/attest quest of the same age ----
(function workQuestBeatsWeakQuest() {
  const now = T0;
  const quests = [
    { id: 'q:work', title: 'build the deploy script', contractType: 'artifact', createdAt: now - 2 * 3600000 },
    { id: 'q:weak', title: 'confirm the launch date', contractType: 'attest', createdAt: now - 1 * 3600000 }   // fresher but weaker
  ];
  const f = F.resolveFocus({ projects: [], threads: [], goal: null, quests }, { now });
  A.eq(f.ref, 'q:work', 'the work quest outranks the fresher-but-weaker attest quest');
})();

// ---- CONFIRMED north star is ranked + cited; northStarEvidence gates confirmed/goal/proposal correctly ----
(function northStarEvidenceGate() {
  const adopted = { text: 'become a full-time AI-content creator', groundedIn: 'dossier + recent activity', source: 'model', status: 'adopted' };
  const ev = F.northStarEvidence(adopted, null);
  A.ok(ev && ev.text, 'a confirmed model-sourced star yields evidence');
  const f = F.resolveFocus({ projects: [], threads: [], goal: null, northStar: ev }, { now: T0 });
  A.eq(f.kind, 'northstar', 'the confirmed north star can be the focus when nothing else is on the board');
  A.ok(/north star/i.test(f.why.join(' ')), 'the north-star focus cites the star');
  // UNCONFIRMED proposal is ignored (consent law — a guess never steers autonomous work).
  const proposal = { text: 'pivot to enterprise SaaS', source: 'model', status: 'proposed' };
  A.eq(F.northStarEvidence(proposal, null), null, 'an unconfirmed proposal yields no evidence');
})();

// ---- NO DOUBLE-COUNT: a goal-sourced star, or a star equal to the active goal, is suppressed (goal already ranks it) ----
(function northStarNoDoubleCount() {
  const goal = { text: 'launch the beta', done: 1, total: 4, next: 'wire the signup' };
  const goalStar = { text: 'launch the beta', groundedIn: "the Commander's active goal arc", source: 'goal', status: 'adopted' };
  A.eq(F.northStarEvidence(goalStar, goal), null, 'a goal-sourced star is not re-counted (the goal input covers it)');
  const echoStar = { text: 'launch the beta', source: 'model', status: 'adopted' };   // model text == goal text
  A.eq(F.northStarEvidence(echoStar, goal), null, 'a model star echoing the goal text is not double-counted');
  // and end-to-end: with a goal AND a goal-sourced star, the focus is the goal — exactly one goal-direction candidate.
  const f = F.resolveFocus({ projects: [], threads: [], goal, northStar: F.northStarEvidence(goalStar, goal) }, { now: T0 });
  A.eq(f.kind, 'goal', 'the goal wins its own direction; the star did not add a second candidate');
})();

// ---- focusLine renders a cited, human-legible directive header ----
(function focusLineCited() {
  const f = F.resolveFocus({ projects: projects(), threads, goal }, { now: T0 });
  const line = F.focusLine(f);
  A.ok(/TONIGHT'S FOCUS/i.test(line), 'the directive header names the focus');
  A.ok(/because/i.test(line), 'and cites WHY (the evidence)');
})();

A.report();
