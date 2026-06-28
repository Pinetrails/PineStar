/* STARNET — autojobstore.js : the browser wiring around the pure self-initiation engine (autojobs.js). Slice 2 of
   the autonomy layer.

   It does two things, both routed through the same flow (reason-only model call → parse → approval beat → schedule):
   - PROACTIVE (fire-once): after the First Pitch, once the Commander has turned autonomy on (Initiative ≥ propose)
     and the station knows enough, it offers — ONCE — a few standing-job proposals on a clean run.end. Hard-gated +
     anti-nag; the manual entry takes over after.
   - MANUAL: the ROUTINES panel's "propose standing jobs" button calls propose() directly (an explicit ask always
     allowed, even after the one-time proactive offer is spent).

   Discipline mirrors pitchstore.js / suggeststore.js:
   - READ-ONLY citizen of U.bus — it .on()s 'agent.run.end' and NEVER .emit()s (lint-emits stays green).
   - Self-persists a single {proposed} fire-once flag to its OWN localStorage key (no save.js change).
   - All decision logic lives in the pure AutoJobs engine; this is the live glue: the gate inputs, the model call,
     the Dialogue approval loop, and the POST to /api/cron (via an injected dep so it stays node-testable).
   - The actual jobs live SERVER-side (cron); this store only remembers whether the one-time offer has happened. */
'use strict';
const AutoJobStore = (() => {
  const KEY = 'starnet.autojobs.v1';
  let state = null;            // { v:1, proposed:bool } — the proactive fire-once flag (self-persisted)
  let deps = {};               // accessors/actions injected by app.js
  let firing = false;          // re-entrancy guard while a proposal flow is mid-air

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  const ready = () => typeof AutoJobs !== 'undefined' && state;

  function hydrate(raw) {
    const s = { v: 1, proposed: false };
    if (raw && typeof raw === 'object' && raw.proposed) s.proposed = true;
    return s;
  }

  // opts: { getSystem(), getName(), getBeliefs(), getExistingJobs(), scheduleJob(body) }
  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    firing = false;
    if (typeof U !== 'undefined' && U.bus && U.bus.on) U.bus.on('agent.run.end', onRunEnd);
  }

  const pitchDone = () => (typeof PitchStore !== 'undefined' && PitchStore.done) ? PitchStore.done() : false;
  const autonomyOn = () => (typeof AutonomyStore !== 'undefined' && AutonomyStore.summary && AutonomyStore.summary()) ? !!AutonomyStore.summary().enabled : false;

  // the PROACTIVE gate (live inputs → the pure engine). Side-effect free so the test can assert it. The fire-once
  // proactive offer only; the manual button bypasses this entirely.
  function decide(p) {
    if (!ready()) return { go: false, reason: 'not-ready' };
    if (firing) return { go: false, reason: 'firing' };
    if (state.proposed) return { go: false, reason: 'already-proposed' };
    p = p || {};
    if (p.reason !== 'done') return { go: false, reason: 'not-done' };
    if ((p.agentId || 'agent') !== 'agent') return { go: false, reason: 'not-hero' };
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return { go: false, reason: 'onboarding' };
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return { go: false, reason: 'intake' };
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return { go: false, reason: 'dialogue-open' };
    const sum = (typeof DossierStore !== 'undefined' && DossierStore.summary) ? DossierStore.summary() : null;
    const known = sum ? sum.known : [];
    return AutoJobs.shouldPropose({ enabled: autonomyOn(), alreadyProposed: state.proposed, firstPitchDone: pitchDone(), knownDims: known });
  }

  function onRunEnd(p) { if (decide(p).go) propose({ proactive: true }); }

  // collect the grounding beliefs the engine wants ({ dim: [texts] }) from the injected accessor.
  function beliefs() { try { return deps.getBeliefs ? (deps.getBeliefs() || {}) : {}; } catch (_) { return {}; } }

  // THE FLOW (awaitable for the test): reason out proposals → present them one at a time → schedule the approved
  // ones via /api/cron. Used by BOTH the proactive offer and the manual button. `proactive` only controls the
  // fire-once bookkeeping (a manual run never burns or needs the flag).
  async function propose(opts) {
    opts = opts || {};
    if (firing || !ready()) return { scheduled: 0 };
    if (typeof Harness === 'undefined' || !Harness.chat || typeof Dialogue === 'undefined') return { scheduled: 0 };
    firing = true;
    let scheduled = 0;
    try {
      let existing = [];
      try { existing = deps.getExistingJobs ? (await deps.getExistingJobs()) || [] : []; } catch (_) { existing = []; }
      const directive = AutoJobs.buildProposalDirective({ beliefs: beliefs(), existingJobs: existing });
      const system = deps.getSystem ? deps.getSystem() : '';
      const name = deps.getName ? deps.getName() : 'AGENT';

      if (typeof Chat !== 'undefined' && Chat.clearNudge) Chat.clearNudge();   // retire any stale gentle nudge before the focused panel opens
      Dialogue.open({ name });
      await Dialogue.say('give me a second — let me think about what would be worth running for you on a schedule…');
      const res = await Harness.chat({ system, messages: [{ role: 'user', content: directive }], agentId: 'agent', isTask: false, placed: [], internal: true });
      const proposals = (res && !res.error) ? AutoJobs.parseProposals(res.text) : [];
      if (!proposals.length) {   // model hiccup / nothing groundable → say nothing useful, leave the flag UNSET so a later run can retry
        if (Dialogue.isOpen()) Dialogue.close();
        return { scheduled: 0 };
      }

      await Dialogue.say(AutoJobs.introLine(proposals.length));
      for (const pr of proposals) {
        if (!Dialogue.isOpen()) break;
        const choice = await Dialogue.node({ lines: AutoJobs.proposalLines(pr), options: AutoJobs.approveChoices() });
        if (choice && choice.value === 'yes' && deps.scheduleJob) {
          try { const r = await deps.scheduleJob(AutoJobs.toCronBody(pr)); if (r && r.ok !== false) scheduled++; } catch (_) {}
        }
      }
      if (Dialogue.isOpen()) { await Dialogue.say(AutoJobs.doneLine(scheduled)); Dialogue.close(); }
      if (opts.proactive) { state.proposed = true; save(); }   // the one-time proactive offer is spent (delivered)
    } catch (_) {
      try { if (Dialogue.isOpen()) Dialogue.close(); } catch (__) {}
    } finally {
      firing = false;
    }
    return { scheduled };
  }

  // S2: a brand-new hero re-earns the proactive offer (own key, like the other proactive stores).
  function reset() { state = { v: 1, proposed: false }; firing = false; try { localStorage.removeItem(KEY); } catch (_) {} }

  // has the one-time proactive offer already happened? (read by the ROUTINES button to label itself).
  function proposed() { return !!(state && state.proposed); }

  // _-prefixed handles are for the deterministic node test (harmless in the browser).
  return { init, reset, onRunEnd, propose, proposed, _decide: decide, _state: () => state };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { AutoJobStore };
