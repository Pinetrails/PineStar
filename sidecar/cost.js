/* sidecar/cost.js — token/cost accounting.
   estimate(usage, model)  -> { usd, tokens }                      (live, during stream)
   reconcile(usage, model) -> { usd, tokensIn, tokensOut, reasoningTokens, cachedTokens }  (authoritative)
   Provider-reported cost (`usage.cost` in dollars, or xAI's `usage.cost_in_usd_ticks`,
   1 USD = 1e10 ticks) always wins; otherwise dollars are
   computed from the catalog priceOf(model) (per-million in/out). Reasoning + cached tokens
   are tracked separately so the "truthful cost" ledger stays honest. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).cost = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

  function makeCostEngine(opts) {
    opts = opts || {};
    const priceOf = opts.priceOf;

    // Provider-reported real billed cost, normalized to USD. `usage.cost` is already dollars
    // (OpenRouter). xAI reports `usage.cost_in_usd_ticks` where 1 USD = 10^10 ticks
    // (docs.x.ai/developers/cost-tracking). Returns null when the provider reported nothing.
    function providerCostUsd(usage) {
      if (!usage) return null;
      if (usage.cost != null && isFinite(Number(usage.cost))) return Number(usage.cost);
      if (usage.cost_in_usd_ticks != null && isFinite(Number(usage.cost_in_usd_ticks))) return Number(usage.cost_in_usd_ticks) / 1e10;
      return null;
    }
    function hasProviderCost(usage) { return providerCostUsd(usage) != null; }
    function catalogPrice(model) {
      const p = priceOf && priceOf(model);
      if (!p) return 0;
      const i = num(p.in != null ? p.in : p.prompt);
      const o = num(p.out != null ? p.out : p.completion);
      return (i || o) ? { in: i, out: o } : null;
    }
    function dollars(usage, model) {
      const reported = providerCostUsd(usage);
      if (reported != null) return reported;
      const p = catalogPrice(model);
      if (!p) return 0;
      const inT = num(usage && usage.prompt_tokens), outT = num(usage && usage.completion_tokens);
      return (inT * p.in + outT * p.out) / 1e6;
    }
    function totalTokens(usage) {
      if (!usage) return 0;
      return num(usage.total_tokens) || (num(usage.prompt_tokens) + num(usage.completion_tokens));
    }

    return {
      estimate(usage, model) {
        return { usd: dollars(usage, model), tokens: totalTokens(usage) };
      },
      reconcile(usage, model) {
        const cached = num(usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens);
        const reasoning = num(usage && (usage.reasoning_tokens ||
          (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens)));
        const reported = providerCostUsd(usage);
        const providerCost = reported != null;
        const price = providerCost ? null : catalogPrice(model);
        const tokensIn = num(usage && usage.prompt_tokens);
        const tokensOut = num(usage && usage.completion_tokens);
        const usd = providerCost ? reported : (price ? (tokensIn * price.in + tokensOut * price.out) / 1e6 : 0);
        return {
          usd: usd,
          tokensIn: tokensIn,
          tokensOut: tokensOut,
          reasoningTokens: reasoning,
          cachedTokens: cached,
          costSource: providerCost ? 'provider' : (price ? 'catalog' : 'unpriced'),
          providerCost: providerCost,
          catalogPriced: !!price,
          unpriced: !providerCost && !price && (tokensIn + tokensOut > 0)
        };
      }
    };
  }

  return { makeCostEngine };
});
