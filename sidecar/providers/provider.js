/* sidecar/providers/provider.js — the LLMProvider interface (the transport seam).
   Every provider (replay, openrouter, later tauri-sidecar) implements:

     stream(req) -> AsyncIterable<HarnessEvent>
       req = { model, messages, tools, signal, stream:true, ... }
       HarnessEvent =
         | { type:'text',       delta }
         | { type:'tool_start', index, id, name }
         | { type:'tool_args',  index, chunk }   // argument STRING fragment
         | { type:'tool_done',  index }
         | { type:'usage',      usage }          // prompt_tokens, completion_tokens, total_tokens,
         |                                       //   prompt_tokens_details.cached_tokens, reasoning_tokens, cost
         | { type:'done',       finishReason }   // normalized via normalizeFinish()
     listModels()     -> [{ id, context_length, max_completion_tokens, pricing, supportsTools }]
     contextLimit(id) -> number
     priceOf(id)      -> { in, out } | null      // per-million USD

   This module is the shared contract + a finish-reason normalizer used by adapters. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.providers = root.SK.providers || {}).provider = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EVENT_TYPES = ['text', 'tool_start', 'tool_args', 'tool_done', 'usage', 'done'];
  const FINISH = ['tool_calls', 'stop', 'length', 'content_filter', 'error'];

  function normalizeFinish(r) {
    if (!r) return 'stop';
    if (r === 'tool_calls' || r === 'tool_use' || r === 'function_call') return 'tool_calls';
    if (r === 'length' || r === 'max_tokens') return 'length';
    if (r === 'content_filter') return 'content_filter';
    if (r === 'stop' || r === 'end_turn' || r === 'stop_sequence') return 'stop';
    return 'error';
  }

  return { EVENT_TYPES, FINISH, normalizeFinish };
});
