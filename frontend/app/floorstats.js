/* SKYNET — floorstats.js : the FACTORY-FLOOR economy readout (pure, testable).

   Folds the harness's already-frozen cost/outcome events into ONE render-agnostic
   snapshot the live floor HUD reads at a glance — so the running station is legible
   the way a Factorio belt is: you look, and you know. Four numbers:
     - SPEND : real dollars burned this session (reconciled agent.cost.usd).
     - YIELD : the productive-run rate — products / decisive runs. The "are my agents
               actually finishing useful work, or thrashing?" number.
     - SLAG  : runs that burned spend for nothing (max_iters / budget / error / refusal)
               + the dollars they wasted. The thing you optimise DOWN.
     - CACHE : cachedTokens / promptTokens — the prompt-cache "smelter" signal. A stable
               system-prompt + memory fence runs the cache hot (~10× cheaper input);
               thrash it and this craters. An invisible win, made visible.

   Truthful by construction (the workstreams.js telemetry rule): every number is a fold
   of REAL events — agent.cost (RECONCILED usd + cachedTokens), agent.run.end (the
   decisive reason), workitem.delivered (a real outbound delivery). Nothing is estimated
   or invented; a metric with no samples yet reports known:false so the HUD shows "—"
   instead of a fabricated figure (the same honesty rule ctxgauge.js applies to context).

   Pure + dependency-free (no DOM / time / rng): a `FloorStats` global in the browser,
   module.exports under node — unit-testable headless like ctxgauge.js / classify.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.FloorStats = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // agent.run.end.reason buckets. 'done' banks a PRODUCT; these four burned spend for nothing → SLAG.
  // 'cancelled' is a human stop (not waste) and counts as NEITHER — it never inflates the slag tally.
  const SLAG_REASONS = { max_iters: 1, budget: 1, error: 1, refusal: 1 };

  function num(n) { n = Number(n); return isFinite(n) ? n : 0; }

  function create() {
    let s = blank();
    function blank() {
      return {
        spendUsd: 0, tokensIn: 0, tokensOut: 0, cachedTokens: 0,
        products: 0, slag: 0, slagUsd: 0, delivered: 0
      };
    }
    function reset() { s = blank(); }

    // Fold ONE bus event into the running totals. Unknown names are ignored, so the caller can
    // point the whole event firehose at it without filtering. Defensive coercion → never a NaN.
    function onEvent(name, p) {
      p = p || {};
      if (name === 'agent.cost') {
        s.spendUsd += num(p.usd);
        s.tokensIn += num(p.tokensIn);
        s.tokensOut += num(p.tokensOut);
        s.cachedTokens += num(p.cachedTokens);
      } else if (name === 'agent.run.end') {
        if (p.reason === 'done') s.products++;
        else if (SLAG_REASONS[p.reason]) { s.slag++; s.slagUsd += num(p.usd); }
      } else if (name === 'workitem.delivered') {
        s.delivered++;
      }
    }

    // Render-agnostic snapshot. Honest unknowns: yield/cache report known:false until they have a
    // real sample (≥1 decisive run / ≥1 prompt token), so the HUD shows "—" not a made-up %.
    function snapshot() {
      const decided = s.products + s.slag;
      const yieldKnown = decided > 0;
      const cacheKnown = s.tokensIn > 0;
      const yieldFrac = yieldKnown ? s.products / decided : 0;
      const cacheFrac = cacheKnown ? s.cachedTokens / s.tokensIn : 0;
      return {
        spendUsd: s.spendUsd, slagUsd: s.slagUsd,
        runs: decided, products: s.products, slag: s.slag, delivered: s.delivered,
        tokensIn: s.tokensIn, tokensOut: s.tokensOut, cachedTokens: s.cachedTokens,
        yieldKnown, yieldFrac, yieldPct: Math.round(yieldFrac * 100),
        cacheKnown, cacheFrac, cachePct: Math.round(cacheFrac * 100),
        clean: s.slag === 0
      };
    }

    return { onEvent, snapshot, reset };
  }

  return { create };
});
