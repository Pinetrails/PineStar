/* node test/provider.registry.test.js - provider profile registry/factory conformance. */
'use strict';
const A = require('./_assert.js');
const factory = require('../sidecar/providers/factory.js');

module.exports = (async () => {
  const ids = factory.PROVIDER_IDS;
  A.ok(ids.indexOf('openrouter') >= 0, 'openrouter is registered');
  A.ok(ids.indexOf('codex') >= 0, 'codex is registered');
  A.ok(ids.indexOf('openai') >= 0, 'openai is registered');
  A.ok(ids.indexOf('anthropic') >= 0, 'anthropic is registered');
  A.ok(ids.indexOf('gemini') >= 0, 'gemini is registered');
  ['xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras'].forEach(id => {
    A.ok(ids.indexOf(id) >= 0, id + ' is registered');
  });
  A.ok(ids.indexOf('ollama') >= 0, 'ollama is registered');
  A.ok(ids.indexOf('custom') >= 0, 'custom is registered');

  A.eq(factory.normalizeProviderId('openai-codex', ''), 'codex', 'codex alias normalizes');
  A.eq(factory.normalizeProviderId('openai-compatible', ''), 'custom', 'custom alias normalizes');
  A.eq(factory.normalizeProviderId('claude', ''), 'anthropic', 'anthropic alias normalizes');
  A.eq(factory.normalizeProviderId('google-ai', ''), 'gemini', 'gemini alias normalizes');
  A.eq(factory.normalizeProviderId('grok', ''), 'xai', 'xAI alias normalizes');
  A.eq(factory.normalizeProviderId('together-ai', ''), 'together', 'Together alias normalizes');
  A.eq(factory.normalizeProviderId('fireworks-ai', ''), 'fireworks', 'Fireworks alias normalizes');
  A.eq(factory.normalizeProviderId('sonar', ''), 'perplexity', 'Perplexity alias normalizes');
  A.eq(factory.normalizeProviderId('', 'openrouter'), 'openrouter', 'fallback is honored');
  A.eq(factory.defaultReasoningEffortForProvider('codex'), 'low', 'codex default reasoning');
  A.eq(factory.defaultReasoningEffortForProvider('ollama'), 'none', 'ollama default reasoning');
  A.eq(factory.providerRequiresKey('openai'), true, 'openai requires a key');
  A.eq(factory.providerRequiresKey('anthropic'), true, 'anthropic requires a key');
  A.eq(factory.providerRequiresKey('gemini'), true, 'gemini requires a key');
  ['xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras'].forEach(id => {
    A.eq(factory.providerRequiresKey(id), true, id + ' requires a key');
  });
  A.eq(factory.providerRequiresKey('ollama'), false, 'ollama is keyless');
  A.eq(factory.providerRequiresBaseUrl('custom'), true, 'custom requires a base URL');

  const profiles = factory.listProviderProfiles();
  const pub = profiles.find(p => p.id === 'openrouter');
  A.ok(pub && Array.isArray(pub.keyEnv) && pub.keyEnv.indexOf('OPENROUTER_KEY') >= 0, 'public profiles include env names only');
  const xai = profiles.find(p => p.id === 'xai');
  A.ok(xai && xai.baseUrl === 'https://api.x.ai/v1' && xai.keyEnv.indexOf('XAI_API_KEY') >= 0, 'xAI public profile exposes official base URL and env names');
  const deepseek = profiles.find(p => p.id === 'deepseek');
  A.ok(deepseek && deepseek.baseUrl === 'https://api.deepseek.com', 'DeepSeek profile uses its non-/v1 base URL');
  const together = profiles.find(p => p.id === 'together');
  A.ok(together && together.baseUrl === 'https://api.together.ai/v1', 'Together profile uses its current official base URL');
  const perplexity = profiles.find(p => p.id === 'perplexity');
  A.ok(perplexity && perplexity.baseUrl === 'https://api.perplexity.ai', 'Perplexity profile uses Sonar base URL');

  const p = factory.selectProvider({ provider: 'ollama', fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) });
  A.ok(p && typeof p.stream === 'function' && typeof p.listModels === 'function', 'factory returns an adapter for OpenAI-compatible profiles');
  for (const id of ['xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras']) {
    const hosted = factory.selectProvider({ provider: id, fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) });
    A.ok(hosted && typeof hosted.stream === 'function' && typeof hosted.listModels === 'function', 'factory returns OpenAI-compatible adapter for ' + id);
  }

  const anthropic = factory.selectProvider({ provider: 'anthropic', fetch: async () => new Response('', { status: 200 }) });
  A.ok(anthropic && typeof anthropic.stream === 'function', 'factory returns Anthropic adapter');
  const gemini = factory.selectProvider({ provider: 'gemini', fetch: async () => new Response('', { status: 200 }) });
  A.ok(gemini && typeof gemini.stream === 'function', 'factory returns Gemini adapter');

  A.report('provider.registry.test');
})();
