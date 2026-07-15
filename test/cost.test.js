/* node test/cost.test.js — token/cost accounting. */
'use strict';
const A = require('./_assert.js');
const { makeCostEngine } = require('../sidecar/cost.js');

const priceOf = id => id === 'm' ? { in: 1, out: 2 } : null; // $1 / 1M in, $2 / 1M out
const ce = makeCostEngine({ priceOf });

// estimate from catalog pricing
const e = ce.estimate({ prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }, 'm');
A.ok(Math.abs(e.usd - (1000 * 1 + 500 * 2) / 1e6) < 1e-12, 'estimate usd from catalog pricing');
A.eq(e.tokens, 1500, 'estimate total tokens');

// provider-reported cost overrides the catalog estimate
A.eq(ce.estimate({ prompt_tokens: 1000, completion_tokens: 500, cost: 0.042 }, 'm').usd, 0.042, 'provider cost wins');

// reconcile splits reasoning + cached out
const r = ce.reconcile({
  prompt_tokens: 1000, completion_tokens: 500,
  prompt_tokens_details: { cached_tokens: 200 }, reasoning_tokens: 50
}, 'm');
A.eq(r.tokensIn, 1000, 'reconcile tokensIn');
A.eq(r.tokensOut, 500, 'reconcile tokensOut');
A.eq(r.cachedTokens, 200, 'cached tokens tracked separately');
A.eq(r.reasoningTokens, 50, 'reasoning tokens tracked separately');
A.ok(Math.abs(r.usd - 2000 / 1e6) < 1e-12, 'reconcile usd');
A.eq(r.costSource, 'catalog', 'catalog-priced reconcile is labeled');
A.eq(r.unpriced, false, 'catalog-priced usage is not unpriced');

const pc = ce.reconcile({ prompt_tokens: 1000, completion_tokens: 500, cost: 0.042 }, 'm');
A.eq(pc.usd, 0.042, 'provider cost wins in reconcile');
A.eq(pc.costSource, 'provider', 'provider-priced reconcile is labeled');
A.eq(ce.reconcile({ prompt_tokens: 1, completion_tokens: 1, cost: '0.125' }, 'm').usd, 0.125, 'numeric string provider cost is preserved');

// xAI reports cost as USD ticks (1 USD = 1e10 ticks) — normalized into real dollars
const ticks = ce.reconcile({ prompt_tokens: 1000, completion_tokens: 500, cost_in_usd_ticks: 420000000 }, 'm');
A.ok(Math.abs(ticks.usd - 0.042) < 1e-12, 'xAI cost_in_usd_ticks normalizes to USD');
A.eq(ticks.costSource, 'provider', 'ticks-priced reconcile is labeled provider');
A.ok(Math.abs(ce.estimate({ prompt_tokens: 1, cost_in_usd_ticks: 420000000 }, 'unknown').usd - 0.042) < 1e-12, 'ticks cost wins in estimate too');
A.eq(ce.reconcile({ prompt_tokens: 1000, completion_tokens: 500, cost: 0.05, cost_in_usd_ticks: 420000000 }, 'm').usd, 0.05, 'dollar cost field wins over ticks when both present');
A.eq(ce.reconcile({ prompt_tokens: 100, completion_tokens: 20, cost_in_usd_ticks: 'junk' }, 'unknown').costSource, 'unpriced', 'non-numeric ticks are ignored, not billed');

// reasoning via completion_tokens_details fallback
A.eq(ce.reconcile({ prompt_tokens: 1, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 7 } }, 'm').reasoningTokens, 7, 'reasoning via completion_tokens_details');

// unknown model + no cost -> 0 usd (never guess)
A.eq(ce.estimate({ prompt_tokens: 100 }, 'unknown').usd, 0, 'no price + no cost -> 0 usd');
const unpriced = ce.reconcile({ prompt_tokens: 100, completion_tokens: 20 }, 'unknown');
A.eq(unpriced.usd, 0, 'unpriced reconcile stays zero before catalog evidence');
A.eq(unpriced.costSource, 'unpriced', 'unpriced usage is labeled');
A.eq(unpriced.unpriced, true, 'unpriced usage is marked for final backfill');

// null usage is safe
A.eq(ce.estimate(null, 'm').usd, 0, 'null usage estimate -> 0');
A.eq(ce.estimate(null, 'm').tokens, 0, 'null usage tokens -> 0');
A.eq(ce.reconcile(null, 'm').tokensIn, 0, 'null usage reconcile -> 0');

A.report('cost.test');
