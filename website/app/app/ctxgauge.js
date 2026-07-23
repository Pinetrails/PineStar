/* STARNET — ctxgauge.js : the CONTEXT-WINDOW gauge model. Pure + testable
   (UMD: a `CtxGauge` global in the browser, module.exports under node).

   Turns two REAL numbers into a render-agnostic gauge state:
     - used  = tokens in the agent's most recent request — its current context
               occupancy (the provider's reconciled prompt_tokens, surfaced to the
               frontend as agent.cost.tokensIn).
     - limit = the model's real max context length (OpenRouter catalog
               context_length).

   No fabricated values: when the limit is unknown (cold catalog / a model the
   catalog doesn't list) the gauge reports known:false so the renderer shows a
   "calibrating" state — never a made-up percentage. This is the truthful-telemetry
   rule applied to context: the bar can only assert a fill it can actually prove. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CtxGauge = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WARN = 0.75;   // amber: context getting full
  const CRIT = 0.90;   // red: near the model's real ceiling → overflow / compaction risk

  function clampInt(n) {
    n = Number(n);
    if (!isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  // human token count: 850 → "850", 64000 → "64k", 1500000 → "1.5M".
  // NOTE: kept self-contained (not routed through U.tokens) because this UMD module is pure +
  // node-testable and must not depend on the browser-global U (util.js). U.tokens mirrors this exact
  // logic — they are the one canonical token format, just duplicated across the node/browser seam.
  function fmtTokens(n) {
    n = clampInt(n);
    if (n < 1000) return String(n);
    if (n < 1e6) {
      const k = n / 1000;
      return (k < 10 ? k.toFixed(1).replace(/\.0$/, '') : String(Math.round(k))) + 'k';
    }
    const m = n / 1e6;
    return (m < 10 ? m.toFixed(1).replace(/\.0$/, '') : String(Math.round(m))) + 'M';
  }

  // used = tokens in the latest real request (prompt_tokens); limit = the model's max context.
  // opts.measured === false means no authoritative prompt_tokens reading exists for this agent/model yet.
  // Returns a pure, render-agnostic snapshot. level ∈ unknown | idle | ok | warn | crit.
  function compute(used, limit, opts) {
    opts = opts || {};
    const measured = opts.measured !== false;
    used = clampInt(used);
    limit = clampInt(limit);
    const known = measured && limit > 0;
    let frac = 0;
    if (known) { frac = used / limit; if (frac > 1) frac = 1; if (frac < 0) frac = 0; }
    const pct = Math.round(frac * 100);
    let level;
    if (!known) level = 'unknown';
    else if (used === 0) level = 'idle';
    else if (frac >= CRIT) level = 'crit';
    else if (frac >= WARN) level = 'warn';
    else level = 'ok';
    return {
      known, measured, used, limit, frac, pct, level,
      label: known ? (fmtTokens(used) + ' / ' + fmtTokens(limit))
        : (limit ? ('-- / ' + fmtTokens(limit)) : (used ? fmtTokens(used) : '--')),
      pctLabel: known ? (pct + '%') : '—'
    };
  }

  return { compute, fmtTokens, WARN, CRIT };
});
