/* STARNET — curiosity.js : the PURE engine for JUST-IN-TIME CURIOSITY (Commander Dossier, Phase B slice 2).

   The gentle counterpart to the full intake interview: when the station notices it still doesn't know
   something about its Commander that shapes how it works, it asks about ONE thing — once, never naggy. This
   engine is the pure decision: given the dossier's still-blank dimensions, what the user has dismissed, and
   how many times we've already asked this session, pick the single dimension to ask about next (or nothing).

   Anti-nag by construction: a hard per-session cap, dimensions are asked in canonical order, and a dimension
   is never raised again once the Commander DISMISSES it OR once it has been asked-and-ignored enough times
   (stop-forever after ASK_LIMIT unanswered asks — silence reads as "leave it" so we don't loop the same
   question across sessions). PURE + node-testable (a `Curiosity` global in the browser, module.exports under
   node); the session count, the persisted dismissals, and the persisted per-dimension ask counts live in
   curiositystore.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Curiosity = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CAP = 1;        // at most one curiosity nudge per session (the rest of "getting to know you" is the opt-in interview)
  const ASK_LIMIT = 2;  // after this many asked-and-ignored sessions, stop raising a dimension FOR GOOD (anti-loop)

  // the persisted shape: which dimensions the Commander has waved off (dismissed → never again), and how many
  // times each blank dimension has been ASKED-and-ignored (asked → stop after ASK_LIMIT, so silence ends the loop).
  function fresh() { return { v: 1, dismissed: {}, asked: {} }; }

  // is this dimension worn out — explicitly dismissed, or asked-and-ignored to the limit?
  function exhausted(dim, dismissed, asked, askLimit) {
    if (dismissed && dismissed[dim]) return true;
    const n = asked && Number.isFinite(asked[dim]) ? asked[dim] : 0;
    return n >= askLimit;
  }

  // the decision. Returns the single dimension key to ask about next, or null for "stay quiet".
  //   blank     — dossier dimensions with no belief yet (canonical order; from Dossier.summary().blank)
  //   dismissed — map of dimension keys the user has waved off ({ stack: true, ... })
  //   asked     — map of dimension key -> times asked-and-not-answered ({ stack: 2, ... }); stop at askLimit
  //   count     — how many nudges already shown THIS session
  //   cap       — the per-session ceiling (defaults to CAP)
  //   askLimit  — the stop-forever ceiling on unanswered asks (defaults to ASK_LIMIT)
  function pick(opts) {
    opts = opts || {};
    const blank = Array.isArray(opts.blank) ? opts.blank : [];
    const dismissed = (opts.dismissed && typeof opts.dismissed === 'object') ? opts.dismissed : {};
    const asked = (opts.asked && typeof opts.asked === 'object') ? opts.asked : {};
    const count = Number.isFinite(opts.count) ? opts.count : 0;
    const cap = Number.isFinite(opts.cap) ? opts.cap : CAP;
    const askLimit = Number.isFinite(opts.askLimit) ? opts.askLimit : ASK_LIMIT;
    if (count >= cap) return null;            // budget spent for this session — stay quiet
    for (const dim of blank) if (!exhausted(dim, dismissed, asked, askLimit)) return dim;   // first still-live dimension
    return null;                              // nothing left worth asking
  }

  // defensively rebuild the persisted state from a (possibly malformed / old) blob.
  function hydrate(raw) {
    const s = fresh();
    if (raw && typeof raw === 'object') {
      if (raw.dismissed && typeof raw.dismissed === 'object') {
        for (const k of Object.keys(raw.dismissed)) if (raw.dismissed[k]) s.dismissed[k] = true;
      }
      if (raw.asked && typeof raw.asked === 'object') {
        for (const k of Object.keys(raw.asked)) { const n = Math.floor(Number(raw.asked[k])); if (Number.isFinite(n) && n > 0) s.asked[k] = n; }
      }
    }
    return s;
  }

  return { fresh, pick, hydrate, exhausted, CAP, ASK_LIMIT };
});
