/* sidecar/providers/prices.js — published list prices for the providers whose API does NOT report them.

   Most adapters get pricing off the wire: the OpenRouter and OpenAI-compatible catalogs carry a `pricing`
   block per model, and some providers report a real billed `usage.cost`, which cost.js always prefers.
   Anthropic's /v1/models and Google's /v1beta/models return NO price data at all, so both adapters hardcoded
   `pricing: null` -> priceOf() -> null -> cost.js dollars() -> 0.

   That zero was not cosmetic. `spentUsd` stayed 0.00 for an entire run, so the per-run hard ceiling in
   loop.js ("if (spentUsd >= maxCostUsd) return end('budget')") and the day/global pools could never fire on
   those providers — the spend seatbelt was structurally disconnected on two of the three biggest ones, and
   the budget UI rendered a permanent $0.00.

   WHAT THESE NUMBERS ARE: published list rates, USD per MILLION tokens, standard non-batch tier. They are
   an ESTIMATE, never a billed amount. cost.js labels anything derived from here `costSource: 'catalog'` —
   distinct from 'provider' (a real billed figure that came over the wire) — so the honesty channel stays
   intact and a caller can always tell an estimate from a fact. A model that matches nothing here stays
   `unpriced` rather than being guessed at, exactly like the Perplexity entry in registry.js.

   KNOWN IMPRECISION, stated rather than hidden:
     · Long-context tiers are not modelled. Gemini 2.5 Pro and the Claude 1M-context beta bill a higher rate
       above a prompt threshold, so a very long prompt UNDER-reports here (the cap fires later than it
       should, never earlier).
     · Cache reads/writes bill at different rates than fresh input; normalizeUsage folds them into
       prompt_tokens, so a heavily-cached run OVER-reports.
     · Batch/priority tiers are not modelled.
   For a spend SEATBELT an approximate number is enormously better than a structural zero, which is the
   trade being made here.

   Rates verified against the vendors' public pricing pages, 2026-07-24. They WILL go stale — override any
   entry without a code change via SKYNET_MODEL_PRICES, a JSON object of
   { "<model-id-or-prefix>": { "in": <usd per Mtok>, "out": <usd per Mtok> } }. An override whose key is a
   prefix of the model id wins over every built-in rule below.

   Patterns are tried IN ORDER, so a specific id beats its family fallback. The family fallbacks at the end
   of each list exist so a newly-released model in a known family gets an approximately-right cap instead of
   silently disabling the seatbelt again. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.providers = root.SK.providers || {}).prices = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // [pattern, { in, out }] — USD per MILLION tokens. Order matters: specific before family fallback.
  const ANTHROPIC = [
    [/^claude-opus-4-5/i,            { in: 5.00, out: 25.00 }],
    [/^claude-haiku-4-5/i,           { in: 1.00, out: 5.00 }],
    [/^claude-sonnet-4/i,            { in: 3.00, out: 15.00 }],   // sonnet 4 and 4.5 share a rate
    [/^claude-opus-4/i,              { in: 15.00, out: 75.00 }],  // opus 4 / 4.1 (4.5 matched above)
    [/^claude-3-5-haiku/i,           { in: 0.80, out: 4.00 }],
    [/^claude-3-haiku/i,             { in: 0.25, out: 1.25 }],
    [/^claude-3-(5|7)-sonnet/i,      { in: 3.00, out: 15.00 }],
    [/^claude-3-sonnet/i,            { in: 3.00, out: 15.00 }],
    [/^claude-3-opus/i,              { in: 15.00, out: 75.00 }],
    // family fallbacks for ids this table has not seen yet
    [/opus/i,                        { in: 15.00, out: 75.00 }],
    [/sonnet/i,                      { in: 3.00, out: 15.00 }],
    [/haiku/i,                       { in: 1.00, out: 5.00 }]
  ];

  const GEMINI = [
    [/^gemini-2\.5-flash-lite/i,     { in: 0.10, out: 0.40 }],
    [/^gemini-2\.5-flash/i,          { in: 0.30, out: 2.50 }],
    [/^gemini-2\.5-pro/i,            { in: 1.25, out: 10.00 }],   // base tier; >200k prompt bills higher
    [/^gemini-2\.0-flash-lite/i,     { in: 0.075, out: 0.30 }],
    [/^gemini-2\.0-flash/i,          { in: 0.10, out: 0.40 }],
    [/^gemini-1\.5-pro/i,            { in: 1.25, out: 5.00 }],
    [/^gemini-1\.5-flash/i,          { in: 0.075, out: 0.30 }],
    // family fallbacks for ids this table has not seen yet
    [/flash-lite/i,                  { in: 0.10, out: 0.40 }],
    [/flash/i,                       { in: 0.30, out: 2.50 }],
    [/pro/i,                         { in: 1.25, out: 10.00 }]
  ];

  const TABLES = { anthropic: ANTHROPIC, gemini: GEMINI };

  // Operator overrides, parsed ONCE and tolerant of garbage — a typo in the env must never wedge a run
  // (same discipline as SKYNET_ANTHROPIC_MAX_TOKENS in anthropic.js). Longest matching key wins, so a full
  // model id beats a family prefix.
  const OVERRIDES = (function () {
    try {
      const raw = (typeof process !== 'undefined' && process.env) ? process.env.SKYNET_MODEL_PRICES : '';
      const s = String(raw == null ? '' : raw).trim();
      if (!s) return [];
      const obj = JSON.parse(s);
      if (!obj || typeof obj !== 'object') return [];
      const out = [];
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (!v || typeof v !== 'object') continue;
        const i = Number(v.in), o = Number(v.out);
        if (!Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) continue;
        out.push({ key: String(k).toLowerCase(), price: { in: i, out: o } });
      }
      return out.sort((a, b) => b.key.length - a.key.length);   // longest (most specific) key first
    } catch (_) { return []; }
  })();

  /* priceOf(family, id) -> { in, out } | null   — per-million USD, or null when nothing matches (honest
     'unpriced'). Deliberately INDEPENDENT of catalog warm state: contextLimit() is 0 until a catalog loads,
     and the spend cap must not inherit that same cold-start hole — it has to work from the very first turn. */
  function priceOf(family, id) {
    const key = String(id == null ? '' : id).trim();
    if (!key) return null;
    const lower = key.toLowerCase();
    for (const o of OVERRIDES) if (lower.indexOf(o.key) === 0) return { in: o.price.in, out: o.price.out };
    const table = TABLES[family];
    if (!table) return null;
    for (const [re, price] of table) if (re.test(key)) return { in: price.in, out: price.out };
    return null;
  }

  /* The catalog `pricing` block shape the other adapters already publish: per-TOKEN decimal strings under
     {prompt, completion} (openrouter.js / openai-compatible.js both parseFloat(...) * 1e6 to get back to
     per-million). Returning the same shape keeps listModels() consistent across every provider, so the
     connect screen and priceOf() can never disagree. */
  function pricingBlock(family, id) {
    const p = priceOf(family, id);
    if (!p) return null;
    return { prompt: String(p.in / 1e6), completion: String(p.out / 1e6) };
  }

  return { priceOf, pricingBlock, _internals: { ANTHROPIC, GEMINI, OVERRIDES } };
});
