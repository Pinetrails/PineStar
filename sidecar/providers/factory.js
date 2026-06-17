/* sidecar/providers/factory.js — the one place a provider id maps to a concrete LLMProvider adapter.
   Keeps runOnce() provider-agnostic: it asks for `selectProvider({ provider, ... })` and drives the
   returned seam, never naming a wire format. Adding a provider = one case here + its adapter module.

     'openrouter' (default) -> makeOpenRouterProvider({ fetch, key })          // pay-per-token API key
     'codex'                -> makeCodexProvider({ fetch, token })             // personal ChatGPT sub (OAuth)

   The Codex path takes an OAuth access_token (a JWT), NOT an API key — the caller (runOnce) is
   responsible for refreshing it before the run; this factory just wires the token in. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./openrouter.js'), require('./codex.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.factory = factory(root.SK.providers.openrouter, root.SK.providers.codex); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (openrouter, codex) {
  'use strict';

  const PROVIDER_IDS = ['openrouter', 'codex'];

  function selectProvider(opts) {
    opts = opts || {};
    const id = (opts.provider || 'openrouter').toLowerCase();
    if (id === 'codex' || id === 'openai-codex') {
      return codex.makeCodexProvider({ fetch: opts.fetch, token: opts.token, baseUrl: opts.baseUrl, reasoningEffort: opts.reasoningEffort });
    }
    return openrouter.makeOpenRouterProvider({ fetch: opts.fetch, key: opts.key, baseUrl: opts.baseUrl, referer: opts.referer });
  }

  return { selectProvider, PROVIDER_IDS };
});
