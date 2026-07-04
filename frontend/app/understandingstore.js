/* STARNET — understandingstore.js : the live wiring around the pure understanding engine (understanding.js).

   The browser half of the "how well the station understands its Commander" read-model, modelled on
   goalstore.js / dossierstore.js: a READ-ONLY citizen of the event spine (subscribes to agent.run.end,
   NEVER emits — the frozen shared/events.js contract is owned elsewhere). It holds NO state of its own —
   it composes the pure Understanding.understanding() read from state that already persists:
     • the Commander dossier beliefs (DossierStore.beliefs per dimension) — the confidence substrate,
     • the work-observation count (ProfileStore.summary().samples) — the honest "learned from N runs",
     • the active goal + real milestone progress (GoalStore.activeGoal → Goals.progress) — what the star
       points AT (the PROGRESS axis, distinct from understanding's CLARITY axis).
   After a clean hero run it recomputes and flags whether understanding ROSE (so the ambient surface can
   pulse — the "you just got clearer" moment), then notifies subscribers. Date.now() lives here (the
   injection edge); the engine stays clock-pure. node-exportable for its test. */
'use strict';
const UnderstandingStore = (() => {
  let bound = false;
  let last = null;          // the last composed read (the surface reads this)
  let prevOverall = 0;      // baseline to detect a post-run RISE
  let deps = {};
  const listeners = [];     // surfaces subscribe here; notified on every refresh

  const now = () => { try { if (typeof deps.now === 'function') return deps.now(); } catch (_) {} return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; };
  const hasEngine = () => typeof Understanding !== 'undefined' && Understanding && typeof Understanding.understanding === 'function';

  // build the dossier-shaped input the pure engine expects ({ dims: { key: [belief] } }) from the live store.
  function dossierShape() {
    const dims = {};
    const keys = hasEngine() ? Understanding.DIM_KEYS : [];
    for (const k of keys) {
      let arr = [];
      try { if (typeof DossierStore !== 'undefined' && DossierStore.beliefs) arr = DossierStore.beliefs(k) || []; } catch (_) {}
      dims[k] = arr;
    }
    return { dims };
  }

  // the honest work-observation count (learned-from-N-runs), or null when the profile is absent/cold.
  function workSamples() {
    try {
      if (typeof ProfileStore !== 'undefined' && ProfileStore.summary) {
        const s = ProfileStore.summary();
        if (s && Number.isFinite(s.samples)) return s.samples;
      }
    } catch (_) {}
    return null;
  }

  // the active goal the star points at + its REAL milestone progress (null when no goal is set — the star
  // then reads "no heading set yet", never a fabricated target).
  function goalRead() {
    try {
      if (typeof GoalStore !== 'undefined' && GoalStore.activeGoal && typeof Goals !== 'undefined' && Goals.progress) {
        const g = GoalStore.activeGoal();
        if (g) {
          const pr = Goals.progress(g);
          const nx = (typeof Goals.nextMilestone === 'function') ? Goals.nextMilestone(g) : null;
          return { text: g.text, done: pr.done, total: pr.total, pct: pr.pct, next: nx ? nx.text : null };
        }
      }
    } catch (_) {}
    return null;
  }

  // compose the full read (understanding + the goal it points at). null only if the engine isn't loaded.
  function compute() {
    if (!hasEngine()) return null;
    let u;
    try { u = Understanding.understanding(dossierShape(), { now: now(), workSamples: workSamples() }); }
    catch (_) { return null; }
    u.goal = goalRead();
    return u;
  }

  // recompute, remember, and (when markRise) flag whether understanding climbed since the last run-driven
  // read — the ambient surface uses `rose` to pulse. Always notifies subscribers.
  function refresh(markRise) {
    const u = compute();
    if (!u) return last;
    u.rose = markRise ? (u.overall > prevOverall + 1e-6) : false;
    prevOverall = u.overall;
    last = u;
    for (const fn of listeners) { try { fn(u); } catch (_) {} }
    return u;
  }

  function read() { return last || refresh(false); }

  // subscribe to reads (returns the current read immediately so a late subscriber isn't blank).
  function subscribe(fn) {
    if (typeof fn === 'function') { listeners.push(fn); try { fn(read()); } catch (_) {} }
    return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }

  function onRunEnd(p) {
    if (!p || p.reason !== 'done') return;               // only a clean run can have sharpened understanding
    if ((p.agentId || 'agent') !== 'agent') return;      // hero runs only (a summoned worker never moves the model)
    refresh(true);
  }
  function bind() {
    if (bound) return;
    if (typeof U !== 'undefined' && U.bus && U.bus.on) { U.bus.on('agent.run.end', onRunEnd); bound = true; }
  }

  function init(opts) {
    deps = opts || {};
    prevOverall = 0;
    refresh(false);   // baseline on enter/resume — never pulses on a resumed save
    bind();
  }

  return { init, read, refresh, subscribe, _onRunEnd: onRunEnd, _compute: compute };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { UnderstandingStore };
