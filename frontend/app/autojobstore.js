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

  // G4 feature 2 — PIN-TO-BOARD. When a MISSION BOARD is placed, a parsed proposal gets a BODY: instead of the
  // inline Dialogue approval, the agent walks to the board and pins an amber PROPOSAL card. The pending ledger
  // below is the source of truth the board pin-feed projects and the quest log renders (approve → the real POST
  // /api/cron via deps.scheduleJob; decline → drop it, dismissed-forever). Self-persisted under the same KEY so a
  // pending proposal survives a reload (a real "waiting for you" state, honest across sessions). No board placed →
  // this ledger stays empty and the existing Dialogue flow runs untouched (the pin is a projection, never a gate).
  let pinSeq = 0;
  function hydrate(raw) {
    const s = { v: 1, proposed: false, pending: [] };
    if (raw && typeof raw === 'object') {
      if (raw.proposed) s.proposed = true;
      if (Array.isArray(raw.pending)) s.pending = raw.pending.filter(p => p && p.id && p.title);
    }
    return s;
  }
  // is a MISSION BOARD placed on the live floor? (injected so the store stays node-testable). Default: no board.
  const boardPlaced = () => { try { return !!(deps.boardPlaced && deps.boardPlaced()); } catch (_) { return false; } };

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

      // G4 feature 2: a MISSION BOARD is placed → the proposals get a BODY. Park them in the pending ledger (the
      // board pin-feed + quest log project them), close the panel, and let the agent walk-and-pin. No inline
      // Dialogue approval — the Commander decides at the board / quest log (approve → the real cron POST). The
      // fire-once flag is still spent (the offer was delivered — it now lives on the board, not in a settings toggle).
      if (boardPlaced()) {
        if (Dialogue.isOpen()) Dialogue.close();
        const added = pinProposals(proposals);
        if (opts.proactive) { state.proposed = true; }
        save();
        return { scheduled: 0, pinned: added };
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

  // ── G4 feature 2 — THE PENDING-PROPOSAL LEDGER (the board body) ─────────────────────────────────────────
  // park parsed proposals as amber PROPOSAL cards on the board. De-duped by title (a re-propose of the same job
  // doesn't stack), so the walk-and-pin plays once per distinct proposal (anti-nag). Returns how many were added.
  function pinProposals(proposals) {
    if (!state) return 0;
    if (!Array.isArray(state.pending)) state.pending = [];
    let added = 0;
    for (const pr of (proposals || [])) {
      if (!pr || !pr.title) continue;
      if (state.pending.some(x => x && x.title === pr.title)) continue;   // already pinned — don't re-pin (once per proposal)
      state.pending.push({
        id: 'ajp_' + (Date.now().toString(36)) + '_' + (++pinSeq),
        title: pr.title, why: pr.why || '', grounds: pr.grounds || '', cadenceId: pr.cadenceId, prompt: pr.prompt || '', at: Date.now()
      });
      added++;
    }
    return added;
  }
  // the live pending proposals (read by the board pin-feed + the quest log). A fresh copy — callers never mutate ours.
  function pendingList() { return (state && Array.isArray(state.pending)) ? state.pending.map(p => Object.assign({}, p)) : []; }
  function pendingCount() { return (state && Array.isArray(state.pending)) ? state.pending.length : 0; }
  function findPending(id) { return (state && Array.isArray(state.pending)) ? state.pending.find(p => p && p.id === id) : null; }
  // APPROVE: schedule the real cron routine (the SAME POST /api/cron path the Dialogue flow uses), then drop the
  // card. Returns { ok }. A failed POST leaves the card pinned so the Commander can retry — never a silent loss.
  async function acceptPending(id) {
    const pr = findPending(id);
    if (!pr || !ready()) return { ok: false };
    let ok = false;
    if (deps.scheduleJob) { try { const r = await deps.scheduleJob(AutoJobs.toCronBody(pr)); ok = !!(r && r.ok !== false); } catch (_) { ok = false; } }
    if (ok) { state.pending = state.pending.filter(p => p && p.id !== id); save(); }
    return { ok };
  }
  // DECLINE: drop the card (dismissed → gone; the walk-and-pin already played once, it never re-nags for this one).
  function declinePending(id) {
    if (!state || !Array.isArray(state.pending)) return false;
    const before = state.pending.length;
    state.pending = state.pending.filter(p => p && p.id !== id);
    if (state.pending.length !== before) { save(); return true; }
    return false;
  }

  // S2: a brand-new hero re-earns the proactive offer (own key, like the other proactive stores).
  function reset() { state = { v: 1, proposed: false, pending: [] }; firing = false; try { localStorage.removeItem(KEY); } catch (_) {} }

  // has the one-time proactive offer already happened? (read by the ROUTINES button to label itself).
  function proposed() { return !!(state && state.proposed); }

  // _-prefixed handles are for the deterministic node test (harmless in the browser).
  return { init, reset, onRunEnd, propose, proposed, pinProposals, pendingList, pendingCount, acceptPending, declinePending, _decide: decide, _state: () => state };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { AutoJobStore };
