/* STARNET — autopilotstore.js : the thin live wiring around the pure idle self-direction engine (autopilot.js).
   Slice A of the autonomy layer — the first thing that makes the posture dial actually drive the floor.

   It is the EDGE the pure engine isn't allowed to be: it owns the live clock, the "Commander is interacting"
   stamping, and the periodic idle check, and it hands the EARN decision off to the chat curiosity nudge. Mirrors
   the discipline of autonomystore.js / autojobstore.js:
   - READ-ONLY citizen of the app — it takes NO U.bus dependency and NEVER emits (lint-emits stays green).
   - All decision logic lives in the pure Autopilot engine; this is glue: stamp activity, tick, dispatch.
   - node-exportable for its test (inject `now` + a fake `offerCuriosity`; pass install:false to skip the DOM).

   SLICE A1 ships the EARN branch only: when the Commander goes idle with autonomy enabled, the station asks ONE
   gentle get-to-know-you question (reusing the curiosity nudge, which already caps itself at one per session). The
   ACT branch (pick + do a small reason/draft job) lands in Slice A2 — until then an act-eligible idle still does
   the safe, useful thing (earns one more piece of context), so a freshly-enabled dial is never inert.

   It persists NOTHING of its own in A1 — the anti-nag memory already lives in CuriosityStore (its own key), and
   idle/armed are ephemeral session state. (A2 adds the leash-per-day accounting that needs its own key.) */
'use strict';
const AutopilotStore = (() => {
  let deps = {};
  let lastActivity = 0;     // wall-clock of the Commander's last interaction (set by noteActivity)
  let armed = false;        // false = this idle EPISODE still has its one autopilot beat; true = spent until next activity
  let installed = false;    // the DOM listeners + interval are installed exactly once
  let timer = null;

  const ready = () => typeof Autopilot !== 'undefined';
  const now = () => {
    try { if (typeof deps.now === 'function') return deps.now(); } catch (_) {}
    return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
  };

  // gather the live inputs the pure engine needs (posture booleans, the readiness tier, idleness).
  function gather() {
    const posture = (() => { try { return (deps.getPosture ? deps.getPosture() : null) || {}; } catch (_) { return {}; } })();
    const summary = (() => { try { return (deps.getDossier ? deps.getDossier() : null) || {}; } catch (_) { return {}; } })();
    const beliefs = (dim) => { try { return deps.getBeliefs ? (deps.getBeliefs(dim) || []) : []; } catch (_) { return []; } };
    const t = now();
    const rd = ready() ? Autopilot.readiness(summary, beliefs, t, {}) : { tier: 'cold' };
    const idle = ready() ? Autopilot.idleFor(t, lastActivity, deps.idleMs) : false;
    return { posture, rd, idle, t };
  }

  // the pure decision over the live inputs (side-effect free — the test asserts it directly).
  function decideNow() {
    if (!ready()) return { go: false, mode: 'none', reason: 'not-ready', binding: null };
    const g = gather();
    return Autopilot.decide({
      enabled: !!g.posture.enabled,
      actsUnattended: !!g.posture.actsUnattended,
      idle: g.idle,
      tier: g.rd.tier,
      budgetLeft: Infinity   // A1: the earn branch is not leash-budgeted (curiosity self-caps). A2 wires real per-day budget for ACT.
    });
  }

  // ONE autopilot beat per idle episode. Re-arms when the Commander next interacts (noteActivity).
  function tick() {
    if (!ready() || armed) return null;
    const d = decideNow();
    if (!d.go) return d;
    armed = true;   // spend this idle episode's single beat (A2 replaces per-episode arming with leash-budgeted re-fire)
    // A1 ships EARN; ACT lands in A2. Until then an act-eligible idle still earns one more piece of context rather
    // than doing nothing — a freshly-enabled dial must never feel inert.
    earn();
    return d;
  }

  // the EARN branch: hand off to the chat curiosity nudge (it picks a still-blank dim, shows the gentle ask, and
  // shares the per-session anti-nag cap — so this can never stack with or double-ask the post-run nudge).
  function earn() { try { if (typeof deps.offerCuriosity === 'function') deps.offerCuriosity(); } catch (_) {} }

  // the Commander interacted — reset the idle clock and re-arm the next idle beat.
  function noteActivity() { lastActivity = now(); armed = false; }

  // install the edge ONCE: stamp activity on real input, and re-check idleness on an interval. Guarded so a
  // resume/re-enter never double-installs, and skipped entirely under node (no document/setInterval) + when the
  // caller passes install:false (the test drives tick()/noteActivity() by hand).
  function install() {
    if (installed) return;
    installed = true;
    if (typeof document !== 'undefined' && document.addEventListener) {
      const mark = () => noteActivity();
      document.addEventListener('pointerdown', mark, true);
      document.addEventListener('keydown', mark, true);
    }
    if (typeof setInterval === 'function') {
      const every = Number.isFinite(deps.tickMs) ? deps.tickMs : (ready() ? Autopilot.DEFAULT_TICK_MS : 20000);
      timer = setInterval(() => { try { tick(); } catch (_) {} }, every);
    }
  }

  // opts: { now(), getPosture(), getDossier(), getBeliefs(dim), offerCuriosity(), idleMs, tickMs, install:bool }
  function init(opts) {
    deps = opts || {};
    lastActivity = now();   // a freshly-entered station starts ACTIVE (no instant idle fire on load)
    armed = false;
    if (!deps || deps.install !== false) install();
  }

  // a brand-new hero starts with no inherited idle/armed state. (No own key in A1 — nothing persisted to clear.)
  function reset() { lastActivity = now(); armed = false; }

  return { init, tick, noteActivity, decideNow, reset, _state: () => ({ lastActivity, armed, installed }) };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { AutopilotStore };
