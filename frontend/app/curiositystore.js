/* SKYNET — curiositystore.js : the thin wiring around the pure just-in-time curiosity engine (curiosity.js).

   Holds the two pieces of state the pure engine can't: the per-SESSION nudge count (in memory, resets each
   run of the app — keeps "one gentle ask per session") and the persisted set of dimensions the Commander has
   waved off (so a dismissed question never returns). Self-persists to its own localStorage key (rides the
   backup prefix, like mintstore) — no save.js change. All the decision logic lives in curiosity.js; this is
   just the live read of the dossier's blank dimensions + the budget bookkeeping. NEVER emits on U.bus. */
'use strict';
const CuriosityStore = (() => {
  const KEY = 'skynet.curiosity.v1';
  let state = null;
  let sessionCount = 0;

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  const ready = () => typeof Curiosity !== 'undefined' && state;

  function init() {
    state = (typeof Curiosity !== 'undefined') ? Curiosity.hydrate(load()) : { v: 1, dismissed: {} };
    sessionCount = 0;   // a fresh session gets its one nudge back
  }

  // the dimension to gently ask about now, or null. Reads the dossier's still-blank dimensions live.
  function consider() {
    if (!ready()) return null;
    const sum = (typeof DossierStore !== 'undefined' && DossierStore.summary) ? DossierStore.summary() : null;
    if (!sum) return null;
    return Curiosity.pick({ blank: sum.blank, dismissed: state.dismissed, count: sessionCount, cap: Curiosity.CAP });
  }

  function markShown() { sessionCount++; }   // spend this session's budget (whether or not the Commander answers)
  function markDismissed(dim) { if (ready() && dim) { state.dismissed[dim] = true; save(); } }   // never raise it again

  // S2: a NEW AGENT starts with no waved-off dimensions. Drop the self-persisted key so the next init()
  // hydrates clean (Save.clear() only wipes skynet.save — this store persists to its own key).
  function reset() { state = null; sessionCount = 0; try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, consider, markShown, markDismissed, reset };
})();
