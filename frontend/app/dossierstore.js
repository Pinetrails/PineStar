/* STARNET — dossierstore.js : the live wiring around the pure Commander Dossier engine (dossier.js).

   The browser half of the dossier system, modelled on profilestore.js / xpstore.js: it owns the one
   station-wide dossier object, seeds it from the onboarding docs the Commander already authored, persists
   it in the save envelope, and exposes the read + mutation surface the COMMANDER panel and the system-
   prompt composer use.

   Like its siblings it is a READ-ONLY citizen of the event spine: it NEVER emits on U.bus (the frozen
   shared/events.js contract is owned elsewhere). It folds nothing automatically in Phase A — the dossier
   grows only from the Commander's own onboarding docs and explicit panel edits — so it holds only what the
   user themselves authored, local-first by construction. Date.now() lives here (the injection edge); the
   engine stays clock-pure. */
'use strict';
const DossierStore = (() => {
  let dossier = null;
  let persistFn = () => {};
  let onMutateFn = () => {};   // recomposes the live system prompt after a panel edit (set by app.js)

  const now = () => Date.now();
  const ready = () => typeof Dossier !== 'undefined' && dossier;

  function init(opts) {
    opts = opts || {};
    if (opts.persist) persistFn = opts.persist;
    if (typeof opts.onMutate === 'function') onMutateFn = opts.onMutate;
    dossier = (typeof Dossier !== 'undefined')
      ? Dossier.hydrate(opts.dossier)         // resume the saved slice (or a fresh one) — defensively sanitized
      : (opts.dossier || null);
    if (ready() && opts.docs) Dossier.seedFromDocs(dossier, opts.docs, now());   // first-seed-wins per doc
    pushToSidecar();   // Phase C: hand the composed block to the sidecar so server-composed (cron) runs know the Commander
  }

  // Phase C: mirror the composed Commander block to the sidecar so AUTONOMOUS server-composed runs (cron) —
  // which build their own persona and never see the frontend's system prompt — still know who they serve.
  // Fire-and-forget (a no-op if the sidecar isn't reachable), exactly like syncChannels. The browser-direct
  // runs already carry the block in their prompt, so the sidecar only uses this for the runs that compose it.
  function pushToSidecar() {
    if (!ready()) return;
    try {
      fetch('/api/dossier', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ block: composeBlock() }) }).catch(() => {});
    } catch (_) {}
    // NS-1: also mirror a READ-ONLY structured BELIEFS SNAPSHOT (per-dim text + timestamps) to the sidecar, so the
    // SERVER-side night-shift driver can gate ACTING with the same Autopilot.readiness() the frontend autopilot
    // used (the dossier itself stays frontend-owned; this is advisory grounding, never written back). Rides the
    // existing posture route (beliefs-only body). Best-effort; a failed sync just degrades the night shift to
    // EARN-tier (readiness reads 'cold' with no snapshot) — never breaks the dossier.
    try {
      const dimKeys = dims().map(d => d.key);
      const snap = {};
      const known = [];
      for (const k of dimKeys) {
        const arr = (beliefs(k) || []).map(b => ({ text: String((b && b.text) || ''), updatedAt: Number(b && b.updatedAt) || 0, createdAt: Number(b && b.createdAt) || 0 })).filter(b => b.text);
        if (arr.length) { snap[k] = arr; known.push(k); }
      }
      fetch('/api/autonomy/posture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ beliefs: { known: known, beliefs: snap } }) }).catch(() => {});
    } catch (_) {}
  }

  // re-seed from freshly-authored onboarding docs (called from applyAgentConfig when the Commander edits a
  // config .md). First-seed-wins PER DOC, so this only adds a dimension newly filled — never duplicates.
  function syncDocs(docs) {
    if (!ready() || !docs) return;
    Dossier.seedFromDocs(dossier, docs, now());
    try { persistFn(); } catch (_) {}
    pushToSidecar();   // newly-seeded beliefs reach the sidecar for cron runs too
  }

  // the durable COMMANDER block for the system prompt (durable beliefs only → cache-stable). '' when cold.
  function composeBlock() { return ready() ? Dossier.composeBlock(dossier, {}) : ''; }

  // ---- read surface (the COMMANDER panel consumes these) ----
  function summary() {
    if (!ready()) return null;
    const observed = (typeof ProfileStore !== 'undefined' && ProfileStore.summary) ? ProfileStore.summary() : null;   // the "what you work on" affinity, shown alongside — never folded in here
    return Dossier.summary(dossier, { observed });
  }
  function beliefs(dim) { return ready() ? Dossier.beliefs(dossier, dim) : []; }
  function dims() { return (typeof Dossier !== 'undefined') ? Dossier.DIMS : []; }
  function serialize() { return dossier || undefined; }   // folded into the save envelope by App.persist()

  // ---- mutations from the glass box — each recomposes the live prompt (onMutate) AND persists ----
  function commit() { try { onMutateFn(); } catch (_) {} try { persistFn(); } catch (_) {} pushToSidecar(); }
  // upsert = the Commander answered/provided this dimension (via the curiosity nudge, the full interview, onboarding,
  // OR the manual +add). Clearing the curiosity ignored-ask tally HERE — the single chokepoint every answer flows
  // through — keeps the stop-forever counter reflecting IGNORES only, not a dimension the user actually engaged with.
  function upsert(dim, belief) {
    if (!ready()) return;
    Dossier.upsert(dossier, dim, belief, now()); commit();
    if (typeof CuriosityStore !== 'undefined' && CuriosityStore.markAnswered) { try { CuriosityStore.markAnswered(dim); } catch (_) {} }
  }
  function forget(dim, id) { if (ready()) { Dossier.forget(dossier, dim, id, now()); commit(); } }
  function setPinned(dim, id, pinned) { if (ready()) { Dossier.setPinned(dossier, dim, id, pinned, now()); commit(); } }

  return { init, syncDocs, composeBlock, summary, beliefs, dims, serialize, upsert, forget, setPinned };
})();
