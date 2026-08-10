/* Pure admission + completion policy for explicit image-generation tasks.

   STUDIO generation has one proven wire today: OpenRouter chat completions with an
   image-output model. A run's ordinary provider/model may still be Gemini, Codex,
   Anthropic, or a custom endpoint; those credentials are not silently portable to
   OpenRouter. This module keeps that routing fact separate from image.js's transport
   and makes completion depend on the artifact ledger, not the model's prose. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.imageTask = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ACTION = '(?:create|generate|make|draw|render|illustrate|produce)';
  const SUBJECT = '(?:image|picture|illustration|artwork|graphic)';
  const ACTION_THEN_SUBJECT = new RegExp('\\b' + ACTION + '\\b[\\s\\S]{0,120}\\b' + SUBJECT + 's?\\b', 'i');
  const SUBJECT_THEN_ACTION = new RegExp('\\b' + SUBJECT + 's?\\b[\\s\\S]{0,80}\\b' + ACTION + '\\b', 'i');
  const INHERENTLY_VISUAL_ACTION = /\b(?:draw|illustrate)\b/i;
  const NEGATED = new RegExp('\\b(?:do not|don(?:\'|\\u2019|`)t|never)\\s+' + ACTION + '\\b', 'i');

  // Conservative on purpose: a false negative keeps the ordinary task path, while a
  // false positive would demand a new image from a request that only discusses images.
  function classify(text) {
    const src = String(text || '').trim();
    if (!src || NEGATED.test(src)) return null;
    if (!ACTION_THEN_SUBJECT.test(src) && !SUBJECT_THEN_ACTION.test(src) && !INHERENTLY_VISUAL_ACTION.test(src)) return null;
    return { kind: 'image-generation' };
  }

  // Provider credentials are scoped. The selected run key is usable for STUDIO only
  // when the selected provider itself is OpenRouter. Other runs may borrow the
  // station's separately connected OpenRouter key, which is the behavior the host has
  // historically authorized; a Gemini/OpenAI/custom key is never relabelled as one.
  function resolveRoute(input) {
    input = input || {};
    const providerId = String(input.providerId || '').trim().toLowerCase();
    const runKey = String(input.runKey || '').trim();
    const stationOpenRouterKey = String(input.stationOpenRouterKey || '').trim();
    if (providerId === 'openrouter' && runKey) {
      return { ok: true, provider: 'openrouter', key: runKey, keySource: 'run' };
    }
    if (stationOpenRouterKey) {
      return { ok: true, provider: 'openrouter', key: stationOpenRouterKey, keySource: 'station' };
    }
    return { ok: false, code: 'openrouter-key-required' };
  }

  function label(providerId, model) {
    const p = String(providerId || 'selected provider').trim() || 'selected provider';
    const m = String(model || '').trim();
    return m ? p + ' / ' + m : p;
  }

  // Returns null when admission is safe, otherwise the exact user-facing blocker.
  // Gear is checked first: connecting another key cannot grant a missing floor object.
  function admissionBlocker(input) {
    input = input || {};
    if (!input.hasStudio) {
      return 'Image task blocked: this agent has no STUDIO. Open REFIT, place a STUDIO in this agent\'s room, and retry. No image artifact was produced.';
    }
    if (!input.studioEnabled) {
      return 'Image task blocked: a STUDIO is present, but MEDIA STUDIO is disabled for this run. Enable MEDIA STUDIO in ABILITIES > TOOLSETS (and include studio in the routine toolsets if this run is restricted), then retry. No image artifact was produced.';
    }
    if (!(input.route && input.route.ok)) {
      return 'Image task blocked: STUDIO generation uses OpenRouter, but this run is configured for '
        + label(input.providerId, input.model) + ' and no OpenRouter provider key is connected. Open SETTINGS > PROVIDERS and connect OpenRouter (the agent may keep its current model), then retry. No image artifact was produced.';
    }
    return null;
  }

  function hasImageArtifact(artifacts) {
    return Array.isArray(artifacts) && artifacts.some(a => a && a.kind === 'image' && String(a.path || '').trim());
  }

  // Mutates the actual run result at the host's settle seam. Returning a message tells
  // the host to emit agent.run.error; null means the existing terminal is truthful.
  function enforceCompletion(result, artifacts, input) {
    input = input || {};
    if (!result || result.reason !== 'done' || input.clarifying || hasImageArtifact(artifacts)) return null;
    result.reason = 'error';
    return 'Image task did not complete: the run ended without a produced image artifact. Nothing was marked OK; retry after checking the STUDIO route.';
  }

  return { classify, resolveRoute, admissionBlocker, hasImageArtifact, enforceCompletion };
});
