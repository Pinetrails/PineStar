/* sidecar/nightshift-driver.js — the NIGHT-SHIFT tick DRIVER (autonomy layer, NS-1), determinism-split clean.

   The orchestration half of the server-owned idle-autonomy loop: it owns the per-tick decision flow (roll the
   day → ask the pure planner whether a beat may fire → if so, take the same-agent mutex, run the ported act
   pipeline as ONE autonomous beat, record the beat + persist, log the decision to the ledger) and NOTHING
   ambient. Every dependency is INJECTED — there is NO Date.now / Math.random / new Date() / setInterval /
   setTimeout / fs / crypto here — so it passes lint-determinism.js and is headless-testable with a fake clock +
   fakes (exactly like cron-driver.js). The ambient half — the real setInterval, Date.now, the state file
   load/persist, the runOnce fire, the ledger append — lives ONLY in sidecar/index.js (the composition root).

   makeNightshiftDriver(deps) -> { applyTick(nowMs) -> {fired, binding, decision}, runInFlight:()=>bool, _internals }
     deps.getState()                 -> state            // the persisted driver state (index.js mirror)
     deps.setState(state)            -> void             // replace + PERSIST (index.js: state=…; saveState())
     deps.getPosture()               -> { actsUnattended, leashPerDay } | null   // the SERVER copy of the dial
     deps.lastActivity()             -> int ms           // lastUserActivityAt (index.js tracks it)
     deps.isHalted()                 -> bool             // the E-STOP is engaged (index.js: no live run + a halt flag)
     deps.concurrencyFree(agentId)   -> bool             // the same-agent run mutex is free for this agent
     deps.beat({ agentId, signal }) -> Promise<{ delivered, reason, title?, archetype? }>   // the ported act pipeline
     deps.newAbort()                 -> AbortController
     deps.now()                      -> int ms           // wall clock for beat-COMPLETION timestamps
     deps.ledger(entry)              -> void             // append one decision record (NS-0 ledger; a thin helper)
     deps.emit(name, payload)        -> void             // OPTIONAL: a validated emitter for a status pulse (no-op default)
     deps.agentId                    -> string           // the agent the night shift acts as (default 'agent')
     deps.awayThresholdMs, deps.beatIntervalMs -> int    // the knobs (env-tunable + a dev override in index.js)

   ONE BEAT AT A TIME: a beat runs asynchronously (the model calls take seconds); `beatRunning` guards re-entry so
   a second tick during an in-flight beat is a clean no-op (like cron's per-job lease, but there is exactly ONE
   night-shift worker). The leash counter is incremented + persisted the moment a beat is ACCEPTED to fire (before
   the async pipeline resolves), so a crash mid-beat cannot lose the accounting and re-fire on restart. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./nightshift.js') : (root.SK && root.SK.nightshift));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).nightshiftDriver = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nightshift) {
  'use strict';

  function makeNightshiftDriver(deps) {
    const d = deps || {};
    const getState = d.getState, setState = d.setState;
    const getPosture = typeof d.getPosture === 'function' ? d.getPosture : function () { return null; };
    const lastActivity = typeof d.lastActivity === 'function' ? d.lastActivity : function () { return 0; };
    const isHalted = typeof d.isHalted === 'function' ? d.isHalted : function () { return false; };
    const concurrencyFree = typeof d.concurrencyFree === 'function' ? d.concurrencyFree : function () { return true; };
    const beat = d.beat;
    const newAbort = typeof d.newAbort === 'function' ? d.newAbort : function () { return { signal: null, abort: function () {} }; };
    const now = typeof d.now === 'function' ? d.now : function () { return 0; };
    const ledger = typeof d.ledger === 'function' ? d.ledger : function () {};
    const emit = typeof d.emit === 'function' ? d.emit : function () {};
    const agentId = String(d.agentId || 'agent');
    const awayThresholdMs = d.awayThresholdMs;
    const beatIntervalMs = d.beatIntervalMs;
    if (typeof getState !== 'function' || typeof setState !== 'function') throw new Error('nightshift-driver: getState/setState are required');
    if (typeof beat !== 'function') throw new Error('nightshift-driver: beat is required');

    let beatRunning = false;               // the one-beat-at-a-time guard (a beat's model calls take seconds)
    let currentAbort = null;               // the in-flight beat's AbortController (for the E-STOP hook)

    // gather the live gate inputs the pure planner needs (posture booleans + the knobs + presence + halt).
    function gather(nowMs) {
      const posture = getPosture() || {};
      return {
        now: nowMs,
        lastUserActivityAt: Number(lastActivity()) || 0,
        actsUnattended: !!posture.actsUnattended,
        leashPerDay: Number.isFinite(posture.leashPerDay) ? posture.leashPerDay : (posture.leashPerDay != null ? Number(posture.leashPerDay) : NaN),
        halted: !!isHalted(),
        concurrencyFree: concurrencyFree(agentId) !== false,
        awayThresholdMs: awayThresholdMs, beatIntervalMs: beatIntervalMs
      };
    }

    // the pure decision over the live inputs (side-effect free — the test asserts it directly through decide()).
    function decideNow(nowMs) {
      const rolled = nightshift.rollDay(getState(), nowMs);
      return nightshift.decide(rolled, gather(nowMs));
    }

    /* applyTick — ONE night-shift pass at wall-clock `nowMs`. Synchronous decision; if a beat is accepted it is
       launched (settles later) and the accounting is persisted IMMEDIATELY. Returns a small summary. Never throws
       (the host also wraps it, but each step is guarded). A tick during an in-flight beat is a no-op. */
    function applyTick(nowMs) {
      nowMs = Number.isFinite(nowMs) ? nowMs : now();

      // DAY ROLLOVER always runs (even when a beat can't fire) so the persisted counter is correct the instant a
      // new day begins — otherwise a status read at 00:01 would show yesterday's spent leash until the first fire.
      try {
        const rolled = nightshift.rollDay(getState(), nowMs);
        const cur = getState() || {};
        if (rolled.day !== cur.day || rolled.beatsUsedToday !== cur.beatsUsedToday) setState(rolled);
      } catch (_) { /* a persist hiccup must never wedge the tick */ }

      if (beatRunning) return { fired: false, binding: 'in-flight', decision: null };

      const decision = decideNow(nowMs);
      // record EVERY tick's decision — acted, or declined-with-which-gate-bound (the honest decision trail).
      try { ledger({ ts: nowMs, kind: decision.fire ? 'beat' : 'decline', binding: decision.binding, agentId: agentId, beatsLeft: decision.beatsLeft, away: decision.away }); } catch (_) {}

      if (!decision.fire) return { fired: false, binding: decision.binding, decision: decision };

      // ACCEPT the beat: increment the leash + stamp lastBeatAt and PERSIST NOW (before the async pipeline
      // resolves), so a crash mid-beat cannot both spend nothing and re-fire on restart. This is the leash's
      // server-enforcement point.
      try { setState(nightshift.recordBeat(getState(), nowMs)); } catch (e) { /* if we can't persist the spend, do NOT fire (fail closed) */ return { fired: false, binding: 'persist-failed', decision: decision }; }

      beatRunning = true;
      const ac = newAbort();
      currentAbort = ac;
      // NOTE: no bus event is emitted here. `nightshift.beat`/`.outcome` are NOT in the frozen event registry
      // (shared/events.js is owned + additive-only), and a war-room pulse is optional. The full decision trail
      // lives in the LEDGER (above) + GET /api/nightshift/status — the truthful-telemetry surfaces this lane owns.

      let p;
      try { p = beat({ agentId: agentId, signal: ac && ac.signal }); }
      catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(
        function (r) { finishBeat(r || {}, null); },
        function (e) { finishBeat(null, e || new Error('beat rejected')); }
      );
      return { fired: true, binding: null, decision: decision };
    }

    // record the outcome of a fired beat once it settles. The leash was already spent at accept-time (correct:
    // an autonomous ATTEMPT consumed the budget even if the pipeline stood down with no draft — that is the
    // anti-runaway guarantee; a stood-down beat still cost a model call or two). We only clear the guard + log.
    function finishBeat(result, threw) {
      beatRunning = false;
      currentAbort = null;
      const at = now();
      const delivered = !!(result && result.delivered);
      const reason = threw ? ('error: ' + ((threw && threw.message) || threw)) : (result && result.reason) || (delivered ? 'delivered' : 'stood-down');
      try { ledger({ ts: at, kind: 'outcome', agentId: agentId, delivered: delivered, reason: reason, title: (result && result.title) || null, archetype: (result && result.archetype) || null }); } catch (_) {}
    }

    // abortBeat — the E-STOP hook: abort an in-flight beat's run so a HALT stops unattended night-shift spend too.
    // The beat settles through finishBeat (guard cleared) either way. Never throws. Returns 1 if a beat was aborted.
    function abortBeat() {
      let n = 0;
      try { if (currentAbort && typeof currentAbort.abort === 'function') { currentAbort.abort(); n = 1; } } catch (_) {}
      return n;
    }

    return {
      applyTick: applyTick,
      decideNow: decideNow,
      runInFlight: function () { return beatRunning; },
      abortBeat: abortBeat,
      _internals: { finishBeat: finishBeat, gather: gather }
    };
  }

  return { makeNightshiftDriver: makeNightshiftDriver };
});
