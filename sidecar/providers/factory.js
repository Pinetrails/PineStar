/* sidecar/providers/factory.js - provider profile to concrete LLMProvider adapter.
   runOnce() asks for selectProvider({ provider, ... }) and then drives the returned seam.
   Adding an OpenAI-compatible provider is now a registry entry; adding a new wire format
   is one adapter case here. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./openrouter.js'),
      require('./codex.js'),
      require('./openai-compatible.js'),
      require('./anthropic.js'),
      require('./gemini.js'),
      require('./registry.js')
    );
  } else {
    root.SK = root.SK || {};
    root.SK.providers = root.SK.providers || {};
    root.SK.providers.factory = factory(root.SK.providers.openrouter, root.SK.providers.codex, root.SK.providers.openaiCompatible, root.SK.providers.anthropic, root.SK.providers.gemini, root.SK.providers.registry);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (openrouter, codex, openaiCompatible, anthropic, gemini, registry) {
  'use strict';

  const PROVIDER_IDS = registry.providerIds();

  function selectProvider(opts) {
    opts = opts || {};
    const id = registry.normalizeProviderId(opts.provider, registry.DEFAULT_PROVIDER_ID);
    const profile = registry.getProviderProfile(id);
    if (!profile) throw new Error('unknown provider: ' + (opts.provider || ''));

    if (profile.adapter === 'codex') {
      return codex.makeCodexProvider({
        fetch: opts.fetch,
        token: opts.token,
        baseUrl: opts.baseUrl || profile.baseUrl,
        reasoningEffort: opts.reasoningEffort
      });
    }
    if (profile.adapter === 'openrouter') {
      return openrouter.makeOpenRouterProvider({
        fetch: opts.fetch,
        key: opts.key,
        baseUrl: opts.baseUrl || profile.baseUrl,
        referer: opts.referer,
        reasoningEffort: opts.reasoningEffort
      });
    }
    if (profile.adapter === 'openai-compatible') {
      return openaiCompatible.makeOpenAICompatibleProvider({
        fetch: opts.fetch,
        key: opts.key,
        baseUrl: opts.baseUrl || profile.baseUrl,
        chatPath: profile.chatPath,
        modelsPath: profile.modelsPath,
        reasoningEffort: opts.reasoningEffort,
        includeUsage: opts.includeUsage,
        defaultContext: opts.defaultContext,
        headers: opts.headers
      });
    }
    if (profile.adapter === 'anthropic') {
      return anthropic.makeAnthropicProvider({
        fetch: opts.fetch,
        key: opts.key,
        baseUrl: opts.baseUrl || profile.baseUrl,
        reasoningEffort: opts.reasoningEffort
      });
    }
    if (profile.adapter === 'gemini') {
      return gemini.makeGeminiProvider({
        fetch: opts.fetch,
        key: opts.key,
        baseUrl: opts.baseUrl || profile.baseUrl,
        reasoningEffort: opts.reasoningEffort
      });
    }
    throw new Error('provider adapter is not wired: ' + profile.adapter);
  }

  return {
    selectProvider,
    PROVIDER_IDS,
    getProviderProfile: registry.getProviderProfile,
    listProviderProfiles: registry.listProviderProfiles,
    normalizeProviderId: registry.normalizeProviderId,
    providerUsesCodex: registry.providerUsesCodex,
    defaultReasoningEffortForProvider: registry.defaultReasoningEffortForProvider,
    providerRequiresKey: registry.providerRequiresKey,
    providerRequiresBaseUrl: registry.providerRequiresBaseUrl
  };
});
