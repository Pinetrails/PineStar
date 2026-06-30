/* STARNET — curiositystore.js : the thin wiring around the pure just-in-time curiosity engine (curiosity.js).

   Holds the state the pure engine can't: the per-SESSION nudge count (in memory, resets each run of the app —
   keeps "one gentle ask per session"), the persisted set of dimensions the Commander has waved off (so a
   dismissed question never returns), AND a persisted per-dimension ASKED count (so a question shown-and-ignored
   across enough sessions stops for good — the fix for the "same question over and over" loop: an ignored nudge
   now leaves a DURABLE mark, not just an in-memory one that resets on reload). Self-persists to its own
   localStorage key (rides the backup prefix, like mintstore) — no save.js change. All the decision logic lives
   in curiosity.js; this is just the live read of the dossier's blank dimensions + the budget bookkeeping.
   NEVER emits on U.bus. */
'use strict';
const CuriosityStore = (() => {
  const KEY = 'starnet.curiosity.v1';
  let state = null;
  let sessionCount = 0;

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  const ready = () => typeof Curiosity !== 'undefined' && state;

  function init() {
    state = (typeof Curiosity !== 'undefined') ? Curiosity.hydrate(load()) : { v: 1, dismissed: {}, asked: {} };
    sessionCount = 0;   // a fresh session gets its one nudge back
  }

  // the dimension to gently ask about now, or null. Reads the dossier's still-blank dimensions live.
  function consider() {
    if (!ready()) return null;
    const sum = (typeof DossierStore !== 'undefined' && DossierStore.summary) ? DossierStore.summary() : null;
    if (!sum) return null;
    return Curiosity.pick({ blank: sum.blank, dismissed: state.dismissed, asked: state.asked, count: sessionCount, cap: Curiosity.CAP });
  }

  // spend this session's budget AND durably tally the ask on this dimension (called whether or not the Commander
  // answers). The persisted asked-count is what lets pick() stop raising a shown-and-ignored dimension for good —
  // without it, the in-memory session cap resets on reload and the same question loops forever.
  function markShown(dim) {
    sessionCount++;
    if (ready() && dim) { if (!state.asked || typeof state.asked !== 'object') state.asked = {}; state.asked[dim] = (Number(state.asked[dim]) || 0) + 1; save(); }
  }
  function markDismissed(dim) { if (ready() && dim) { state.dismissed[dim] = true; save(); } }   // never raise it again
  // the dimension was actually ANSWERED (or genuinely re-emptied) — clear its ignored-ask tally so the stop-forever
  // counter only ever reflects IGNORES (decision 1). Without this, a dimension answered-then-forgotten stays silenced.
  function markAnswered(dim) { if (ready() && dim && state.asked && state.asked[dim] != null) { delete state.asked[dim]; save(); } }

  // observability: the question-state for ONE dimension, for the COMMANDER DOSSIER readout.
  //   { asked:count, dismissed:bool, stopped:bool } — stopped = waved off OR asked-and-ignored to the limit.
  function statusOf(dim) {
    if (!ready() || !dim) return { asked: 0, dismissed: false, stopped: false };
    const asked = Number(state.asked && state.asked[dim]) || 0;
    const dismissed = !!(state.dismissed && state.dismissed[dim]);
    const limit = (typeof Curiosity !== 'undefined' && Number.isFinite(Curiosity.ASK_LIMIT)) ? Curiosity.ASK_LIMIT : 2;
    return { asked: asked, dismissed: dismissed, stopped: dismissed || asked >= limit };
  }
  // the escape hatch: turn a stopped/waved-off question back ON (clears both the dismissal and the ignored-ask
  // tally), so the station may ask about this dimension again. Mirrors a Restore on the memory side.
  function reEnable(dim) {
    if (!ready() || !dim) return;
    let changed = false;
    if (state.dismissed && state.dismissed[dim]) { delete state.dismissed[dim]; changed = true; }
    if (state.asked && state.asked[dim] != null) { delete state.asked[dim]; changed = true; }
    if (changed) save();
  }

  // S2: a NEW AGENT starts with no waved-off dimensions. Drop the self-persisted key so the next init()
  // hydrates clean (Save.clear() only wipes starnet.save — this store persists to its own key).
  function reset() { state = null; sessionCount = 0; try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, consider, markShown, markDismissed, markAnswered, statusOf, reEnable, reset };
})();
