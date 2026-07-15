/* sidecar/providers/registry.js - provider profiles, following the reference harness.
   Profiles are metadata only: adapters still implement the LLMProvider stream seam.
   This keeps provider discovery, auth shape, defaults, aliases, model endpoints, and UI
   labels in one place instead of spreading hardcoded provider ids through the host. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.registry = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_PROVIDER_ID = 'openrouter';

  // Wire-hint fields on openai-compatible profiles (all sourced from the provider's official API docs,
  // verified 2026-07; the adapter also self-heals by dropping any optional param a provider 400s on):
  //   wireReasoningEffort — endpoint documents the `reasoning_effort` chat-completions param.
  //   wireStreamOptions: false — endpoint does not accept `stream_options` (usage still arrives:
  //     these providers report usage in the stream by default).
  const PROFILES = [
    {
      id: 'openrouter',
      aliases: ['or'],
      name: 'OpenRouter',
      label: 'OPENROUTER',
      endpoint: 'openrouter.ai/api/v1',
      blurb: 'one key, broad model catalog',
      live: true,
      adapter: 'openrouter',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['OPENROUTER_KEY', 'OPENROUTER_API_KEY'],
      modelsRequireAuth: false,
      baseUrl: 'https://openrouter.ai/api/v1',
      baseUrlEnv: ['OPENROUTER_BASE'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: 'catalog',
      supportsReasoning: 'catalog',
      order: 20
    },
    {
      id: 'codex',
      aliases: ['openai-codex'],
      name: 'ChatGPT Codex',
      label: 'CHATGPT (CODEX)',
      endpoint: 'OAuth, ChatGPT subscription',
      blurb: 'sign in, no API key',
      live: true,
      adapter: 'codex',
      apiMode: 'codex_responses',
      authType: 'oauth_device_code',
      keyRequired: false,
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      defaultReasoningEffort: 'low',
      unmetered: true,
      credentialPool: false,
      supportsTools: true,
      supportsReasoning: true,
      order: 10
    },
    {
      id: 'openai',
      aliases: ['openai-api'],
      name: 'OpenAI API',
      label: 'OPENAI API',
      endpoint: 'api.openai.com/v1',
      blurb: 'OpenAI-compatible chat completions',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['OPENAI_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.openai.com/v1',
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      order: 30
    },
    {
      id: 'anthropic',
      aliases: ['claude'],
      name: 'Anthropic',
      label: 'ANTHROPIC',
      endpoint: 'api.anthropic.com/v1',
      blurb: 'Claude native Messages API',
      live: true,
      adapter: 'anthropic',
      apiMode: 'anthropic_messages',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['ANTHROPIC_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.anthropic.com/v1',
      baseUrlEnv: ['ANTHROPIC_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: true,
      supportsReasoning: null,
      order: 35
    },
    {
      id: 'gemini',
      aliases: ['google', 'google-ai', 'google-gemini'],
      name: 'Google Gemini',
      label: 'GEMINI',
      endpoint: 'generativelanguage.googleapis.com/v1beta',
      blurb: 'Gemini native GenerateContent API',
      live: true,
      adapter: 'gemini',
      apiMode: 'gemini_generate_content',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_AI_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      baseUrlEnv: ['GEMINI_BASE_URL', 'GOOGLE_AI_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: true,
      supportsReasoning: null,
      order: 36
    },
    {
      id: 'xai',
      aliases: ['x-ai', 'grok'],
      name: 'xAI',
      label: 'XAI',
      endpoint: 'api.x.ai/v1',
      blurb: 'Grok OpenAI-compatible API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['XAI_API_KEY', 'X_AI_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.x.ai/v1',
      baseUrlEnv: ['XAI_BASE_URL', 'X_AI_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      order: 37
    },
    {
      id: 'groq',
      aliases: [],
      name: 'Groq',
      label: 'GROQ',
      endpoint: 'api.groq.com/openai/v1',
      blurb: 'fast OpenAI-compatible inference',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['GROQ_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.groq.com/openai/v1',
      baseUrlEnv: ['GROQ_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      order: 38
    },
    {
      id: 'mistral',
      aliases: ['mistralai'],
      name: 'Mistral AI',
      label: 'MISTRAL',
      endpoint: 'api.mistral.ai/v1',
      blurb: 'Mistral OpenAI-compatible API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['MISTRAL_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.mistral.ai/v1',
      baseUrlEnv: ['MISTRAL_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      // Mistral strictly validates request bodies (422 "Extra inputs are not permitted") and its spec
      // has no stream_options; its stream reports usage in the final chunk without it.
      wireStreamOptions: false,
      order: 39
    },
    {
      id: 'deepseek',
      aliases: [],
      name: 'DeepSeek',
      label: 'DEEPSEEK',
      endpoint: 'api.deepseek.com',
      blurb: 'DeepSeek OpenAI-compatible API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['DEEPSEEK_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.deepseek.com',
      baseUrlEnv: ['DEEPSEEK_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      order: 40
    },
    {
      id: 'together',
      aliases: ['together-ai'],
      name: 'Together AI',
      label: 'TOGETHER',
      endpoint: 'api.together.ai/v1',
      blurb: 'Together OpenAI-compatible API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['TOGETHER_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.together.ai/v1',
      baseUrlEnv: ['TOGETHER_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      order: 41
    },
    {
      id: 'fireworks',
      aliases: ['fireworks-ai'],
      name: 'Fireworks AI',
      label: 'FIREWORKS',
      endpoint: 'api.fireworks.ai/inference/v1',
      blurb: 'Fireworks OpenAI-compatible API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['FIREWORKS_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      baseUrlEnv: ['FIREWORKS_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      order: 42
    },
    {
      id: 'perplexity',
      aliases: ['pplx', 'sonar'],
      name: 'Perplexity',
      label: 'PERPLEXITY',
      endpoint: 'api.perplexity.ai',
      blurb: 'Sonar chat completions API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['PERPLEXITY_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.perplexity.ai',
      baseUrlEnv: ['PERPLEXITY_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      // Perplexity's /chat/completions schema has no tools/tool_choice — function calling lives on its
      // separate Agent API. It DOES document its own reasoning_effort, and streams usage by default.
      supportsTools: false,
      supportsReasoning: null,
      wireReasoningEffort: true,
      wireStreamOptions: false,
      // Perplexity has NO usable /models for chat completions (its /v1/models lists Agent-API ids),
      // so the connect screen would be empty and contextLimit 0 (compaction off). Static Sonar roster
      // from docs.perplexity.ai/docs/sonar/models, verified 2026-07 (sonar-reasoning was removed
      // 2025-12-15). Deliberately NO pricing: Perplexity bills per-request search fees on top of
      // tokens, so token-only catalog pricing would under-report real cost — 'unpriced' is the
      // honest label until the provider reports cost on the wire.
      staticModels: [
        { id: 'sonar', name: 'Sonar', context_length: 128000, supportsTools: false, supportsReasoning: false },
        { id: 'sonar-pro', name: 'Sonar Pro', context_length: 200000, supportsTools: false, supportsReasoning: false },
        { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro', context_length: 128000, supportsTools: false, supportsReasoning: true },
        { id: 'sonar-deep-research', name: 'Sonar Deep Research', context_length: 128000, supportsTools: false, supportsReasoning: true }
      ],
      order: 43
    },
    {
      id: 'cerebras',
      aliases: [],
      name: 'Cerebras',
      label: 'CEREBRAS',
      endpoint: 'api.cerebras.ai/v1',
      blurb: 'Cerebras OpenAI-compatible API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['CEREBRAS_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.cerebras.ai/v1',
      baseUrlEnv: ['CEREBRAS_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      order: 44
    },
    {
      id: 'ollama',
      aliases: ['ollama-local'],
      name: 'Ollama',
      label: 'OLLAMA',
      endpoint: '127.0.0.1:11434/v1',
      blurb: 'local OpenAI-compatible endpoint',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'none',
      keyRequired: false,
      modelsRequireAuth: false,
      baseUrl: 'http://127.0.0.1:11434/v1',
      baseUrlEnv: ['OLLAMA_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'none',
      unmetered: true,
      credentialPool: false,
      supportsTools: null,
      supportsReasoning: false,
      wireReasoningEffort: true,
      order: 60
    },
    {
      id: 'custom',
      aliases: ['openai-compatible', 'local', 'vllm', 'lmstudio'],
      name: 'Custom OpenAI-Compatible',
      label: 'CUSTOM',
      endpoint: 'your /v1 endpoint',
      blurb: 'bring any OpenAI-compatible endpoint',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key_optional',
      keyRequired: false,
      keyEnv: ['CUSTOM_OPENAI_KEY', 'OPENAI_COMPATIBLE_KEY'],
      modelsRequireAuth: false,
      baseUrl: '',
      baseUrlEnv: ['CUSTOM_OPENAI_BASE_URL', 'OPENAI_COMPATIBLE_BASE_URL'],
      modelsPath: '/models',
      requiresBaseUrl: true,
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      order: 70
    }
  ];

  const BY_ID = new Map();
  const ALIASES = new Map();
  for (const profile of PROFILES) {
    BY_ID.set(profile.id, profile);
    ALIASES.set(profile.id, profile.id);
    for (const a of (profile.aliases || [])) ALIASES.set(String(a).toLowerCase(), profile.id);
  }

  function canonicalKey(value) {
    return String(value || '').trim().toLowerCase();
  }
  function getProviderProfile(value) {
    const key = canonicalKey(value);
    if (!key) return null;
    const id = ALIASES.get(key);
    return id ? BY_ID.get(id) || null : null;
  }
  function normalizeProviderId(value, fallback) {
    const profile = getProviderProfile(value);
    if (profile) return profile.id;
    return fallback == null ? '' : String(fallback);
  }
  function providerUsesCodex(value) {
    return normalizeProviderId(value, '') === 'codex';
  }
  function defaultReasoningEffortForProvider(value) {
    const profile = getProviderProfile(value) || BY_ID.get(DEFAULT_PROVIDER_ID);
    return (profile && profile.defaultReasoningEffort) || 'medium';
  }
  function providerRequiresKey(value) {
    const profile = getProviderProfile(value);
    return !!(profile && profile.keyRequired);
  }
  function providerRequiresBaseUrl(value) {
    const profile = getProviderProfile(value);
    return !!(profile && profile.requiresBaseUrl);
  }
  function toPublicProfile(profile) {
    return {
      id: profile.id,
      aliases: (profile.aliases || []).slice(),
      name: profile.name,
      label: profile.label,
      endpoint: profile.endpoint,
      blurb: profile.blurb,
      live: profile.live !== false,
      apiMode: profile.apiMode,
      authType: profile.authType,
      keyRequired: !!profile.keyRequired,
      keyEnv: (profile.keyEnv || []).slice(),
      modelsRequireAuth: profile.modelsRequireAuth !== false,
      baseUrl: profile.baseUrl || '',
      baseUrlEnv: (profile.baseUrlEnv || []).slice(),
      requiresBaseUrl: !!profile.requiresBaseUrl,
      defaultReasoningEffort: profile.defaultReasoningEffort || 'medium',
      unmetered: !!profile.unmetered,
      supportsTools: profile.supportsTools,
      supportsReasoning: profile.supportsReasoning,
      credentialPool: !!profile.credentialPool
    };
  }
  function listProviderProfiles(opts) {
    opts = opts || {};
    return PROFILES
      .filter(p => opts.includeInactive || p.live !== false)
      .slice()
      .sort((a, b) => (a.order || 1000) - (b.order || 1000) || a.id.localeCompare(b.id))
      .map(p => opts.public === false ? Object.assign({}, p) : toPublicProfile(p));
  }
  function providerIds(opts) {
    return listProviderProfiles(Object.assign({}, opts, { public: false })).map(p => p.id);
  }

  return {
    DEFAULT_PROVIDER_ID,
    getProviderProfile,
    listProviderProfiles,
    normalizeProviderId,
    providerUsesCodex,
    defaultReasoningEffortForProvider,
    providerRequiresKey,
    providerRequiresBaseUrl,
    providerIds,
    _profiles: PROFILES
  };
});
