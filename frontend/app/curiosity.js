/* STARNET — curiosity.js : the PURE engine for JUST-IN-TIME CURIOSITY (Commander Dossier, Phase B slice 2).

   The gentle counterpart to the full intake interview: when the station notices it still doesn't know
   something about its Commander that shapes how it works, it asks about ONE thing — once, never naggy. This
   engine is the pure decision: given the dossier's still-blank dimensions, what the user has dismissed, and
   how many times we've already asked this session, pick the single dimension to ask about next (or nothing).

   Anti-nag by construction: a hard per-session cap, dimensions are asked in canonical order, and a dismissed
   dimension is never raised again (its dismissal persists). PURE + node-testable (a `Curiosity` global in the
   browser, module.exports under node); the session count + the persisted dismissals live in curiositystore.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Curiosity = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CAP = 1;   // at most one curiosity nudge per session (the rest of "getting to know you" is the opt-in interview)

  // the persisted shape: which dimensions the Commander has waved off (so we never raise them again).
  function fresh() { return { v: 1, dismissed: {} }; }

  // the decision. Returns the single dimension key to ask about next, or null for "stay quiet".
  //   blank     — dossier dimensions with no belief yet (canonical order; from Dossier.summary().blank)
  //   dismissed — map of dimension keys the user has waved off ({ stack: true, ... })
  //   count     — how many nudges already shown THIS session
  //   cap       — the per-session ceiling (defaults to CAP)
  function pick(opts) {
    opts = opts || {};
    const blank = Array.isArray(opts.blank) ? opts.blank : [];
    const dismissed = (opts.dismissed && typeof opts.dismissed === 'object') ? opts.dismissed : {};
    const count = Number.isFinite(opts.count) ? opts.count : 0;
    const cap = Number.isFinite(opts.cap) ? opts.cap : CAP;
    if (count >= cap) return null;            // budget spent for this session — stay quiet
    for (const dim of blank) if (!dismissed[dim]) return dim;   // first still-blank, not-waved-off dimension
    return null;                              // nothing left worth asking
  }

  // defensively rebuild the persisted state from a (possibly malformed / old) blob.
  function hydrate(raw) {
    const s = fresh();
    if (raw && typeof raw === 'object' && raw.dismissed && typeof raw.dismissed === 'object') {
      for (const k of Object.keys(raw.dismissed)) if (raw.dismissed[k]) s.dismissed[k] = true;
    }
    return s;
  }

  return { fresh, pick, hydrate, CAP };
});
