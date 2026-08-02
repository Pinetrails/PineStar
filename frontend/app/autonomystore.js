/* STARNET — autonomystore.js : the thin browser wiring around the pure autonomy-posture engine (autonomy.js).

   Holds the Commander's tunable "alive between sessions" posture and persists it. Mirrors the discipline of
   pitchstore / suggeststore / curiositystore:
   - SELF-PERSISTS to its OWN localStorage key (no save.js change; rides nothing else).
   - READ-ONLY citizen of the app: it NEVER emits on U.bus (lint-emits stays green). In Slice 1 it subscribes to
     nothing either — a posture is set by exactly two writers (the awakening cadence beat + the station dial panel)
     and read by the runtime in later slices. All posture LOGIC lives in the pure engine; this is just the glue:
     hydrate, persist, and the new-hero reset.
   - node-exportable for its test.

   The stored shape is whatever autonomy.js defines ({ v, initiative, reach, leashPerDay }); every read goes through
   Autonomy.normalize so a corrupt/old key degrades to the safe floor (fully wait-for-me, Sandbox ceiling), never an
   invalid posture the runtime gates could misread. */
'use strict';
const AutonomyStore = (() => {
  const KEY = 'starnet.autonomy.v1';
  let state = null;                       // the persisted posture (engine-shaped)
  const ready = () => typeof Autonomy !== 'undefined';
  const floor = () => ready() ? Autonomy.fresh() : { v: 1, initiative: 'wait', reach: 'sandbox', leashPerDay: 3 };

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }

  // hydrate from the own key, clamped to a valid posture. Idempotent — safe to call on every awake.
  function init() { state = ready() ? Autonomy.normalize(load()) : (load() || floor()); try { syncServer(false); } catch (_) {} }   // mirror on awake, but a page load is never consent to lift E-STOP

  // the live posture (always normalized). Lazily hydrates if a reader beats init().
  function get() { if (!state) init(); return ready() ? Autonomy.normalize(state) : state; }
  // the derived read surface + the one-line description (delegated to the pure engine).
  function summary() { return ready() ? Autonomy.summary(get()) : null; }
  function describe() { return ready() ? Autonomy.describe(get()) : ''; }

  // NS-1: mirror the posture to the SERVER on every change, so the sidecar-owned night-shift driver reads a truth
  // it owns (not this webview it can't see) and the leash is ENFORCED server-side. Fire-and-forget, best-effort —
  // a failed sync leaves the server on its last good posture (or the safe floor); the dial UI is unaffected. This
  // is the ONLY thing that turns a dialed-up posture into actual overnight autonomy now that the loop is server-side.
  function syncServer(resumeHalt) {
    try {
      const p = get();
      fetch('/api/autonomy/posture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posture: { initiative: p.initiative, reach: p.reach, leashPerDay: p.leashPerDay }, resumeHalt: resumeHalt === true }) }).catch(() => {});
    } catch (_) {}
  }

  // the WRITERS (the awakening cadence beat + the dial panel). Each commits + persists, MIRRORS to the server, and returns the new posture.
  function applyPreset(id) { if (!ready()) return get(); state = Autonomy.applyPreset(get(), id); save(); syncServer(true); return get(); }
  function setInitiative(level) { if (!ready()) return get(); state = Autonomy.setInitiative(get(), level); save(); syncServer(true); return get(); }
  function setReach(level) { if (!ready()) return get(); state = Autonomy.setReach(get(), level); save(); syncServer(true); return get(); }
  function setLeash(n) { if (!ready()) return get(); state = Autonomy.setLeash(get(), n); save(); syncServer(true); return get(); }

  // a brand-new hero starts from the safe floor (own key, like the other proactive stores). Wired into app.js's
  // onWake new-hero reset block so a fresh Commander isn't handed the previous one's autonomy posture.
  function reset() { state = floor(); try { localStorage.removeItem(KEY); } catch (_) {} }

  // P1-7 station backup: dump/restore the posture as plain data. exportState is the normalized posture (safe to
  // serialize); importState clamps whatever it's handed back to a valid posture and persists it.
  function exportState() { return get(); }
  function importState(obj) { if (!obj || typeof obj !== 'object') return get(); state = ready() ? Autonomy.normalize(obj) : obj; save(); syncServer(true); return get(); }

  return { init, get, summary, describe, applyPreset, setInitiative, setReach, setLeash, reset, exportState, importState, _state: () => state };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { AutonomyStore };
