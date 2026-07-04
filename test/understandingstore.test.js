/* node test/understandingstore.test.js — the live wiring around the pure understanding engine
   (frontend/app/understandingstore.js). Stubs the sibling globals (DossierStore / ProfileStore /
   GoalStore+Goals / U.bus) and locks: the read composes overall confidence from live dossier beliefs;
   the active goal + real progress ride along (null when no goal); a clean HERO run recomputes and flags
   a RISE when understanding climbed (the pulse trigger); a non-done / non-hero run is ignored; and
   subscribers are notified immediately + on every refresh. Clock injected. */
'use strict';
const A = require('./_assert.js');

// ---- stub the browser globals the store reads (must exist BEFORE any method call; the IIFE reads them lazily) ----
global.Understanding = require('../frontend/app/understanding.js');

const dims = { goals: [], ambition: [], pain: [], identity: [], stack: [], style: [], standing_orders: [] };
global.DossierStore = { beliefs: (k) => dims[k] || [] };
function belief(text, source) { return { id: 'cd_x', text, source: source || 'commander', createdAt: 1000, updatedAt: 1000, pinned: false }; }

let samples = 3;
global.ProfileStore = { summary: () => ({ samples }) };

let activeGoal = null;
global.Goals = {
  progress: (g) => ({ done: g._done, total: g._total, pct: Math.round((g._done / g._total) * 100) }),
  nextMilestone: (g) => (g._next ? { text: g._next } : null)
};
global.GoalStore = { activeGoal: () => activeGoal };

// a tiny synchronous bus stub
const handlers = {};
global.U = { bus: { on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); } } };
function emit(name, p) { for (const fn of (handlers[name] || [])) fn(p); }

const { UnderstandingStore } = require('../frontend/app/understandingstore.js');

/* ---------- init: baseline read, no pulse on resume ---------- */
dims.goals = [belief('ship the harness to a thousand builders')];
UnderstandingStore.init({ now: () => 5000 });
let r = UnderstandingStore.read();
A.ok(r && r.overall > 0, 'the read composes a positive overall from a live dossier belief');
A.eq(r.rose, false, 'the baseline read on init never pulses (no rise on resume)');
A.eq(r.workSamples, 3, 'the work-observation count passes through from ProfileStore');
A.eq(r.goal, null, 'no active goal → goal is null (never a fabricated heading)');

/* ---------- a clean HERO run that sharpened understanding flags a RISE ---------- */
dims.ambition = [belief('launch the newsletter')];   // new belief → understanding climbs
emit('agent.run.end', { reason: 'done', agentId: 'agent' });
r = UnderstandingStore.read();
A.ok(r.rose, 'a clean hero run that raised understanding flags rose=true (the pulse trigger)');
const afterRise = r.overall;

/* a subsequent run with NO change does not pulse */
emit('agent.run.end', { reason: 'done', agentId: 'agent' });
r = UnderstandingStore.read();
A.eq(r.rose, false, 'a run that did not raise understanding does not pulse');
A.eq(r.overall, afterRise, 'overall is stable when nothing changed');

/* ---------- a non-hero / non-done run is ignored (no recompute) ---------- */
dims.pain = [belief('writing standup notes by hand')];   // change the world…
emit('agent.run.end', { reason: 'done', agentId: 'worker-2' });   // …but a summoned worker must not move the model
A.eq(UnderstandingStore.read().overall, afterRise, 'a summoned-worker run never recomputes the Commander model');
emit('agent.run.end', { reason: 'error', agentId: 'agent' });     // a failed hero run is not a clean signal
A.eq(UnderstandingStore.read().overall, afterRise, 'a non-done run never recomputes');
// a clean hero run now DOES fold the pain belief in
emit('agent.run.end', { reason: 'done', agentId: 'agent' });
A.ok(UnderstandingStore.read().overall > afterRise, 'the next clean hero run folds the intervening belief');

/* ---------- the active goal + REAL progress ride along ---------- */
activeGoal = { text: 'ship the harness to a thousand builders', _done: 2, _total: 5, _next: 'self-serve onboarding' };
r = UnderstandingStore.refresh(false);
A.eq(r.goal.text, 'ship the harness to a thousand builders', 'the read carries the active goal text');
A.eq(r.goal.done, 2, 'the read carries REAL milestone progress (done)');
A.eq(r.goal.total, 5, 'the read carries REAL milestone progress (total)');
A.eq(r.goal.next, 'self-serve onboarding', 'the read carries the next milestone');

/* ---------- subscribe: notified immediately + on refresh ---------- */
let got = null, calls = 0;
const unsub = UnderstandingStore.subscribe((u) => { got = u; calls++; });
A.ok(got && calls === 1, 'a subscriber is notified immediately with the current read');
UnderstandingStore.refresh(false);
A.eq(calls, 2, 'a subscriber is notified on every refresh');
unsub();
UnderstandingStore.refresh(false);
A.eq(calls, 2, 'an unsubscribed listener stops receiving reads');

A.report('understandingstore.test');
