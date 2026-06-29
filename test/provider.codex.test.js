/* node test/provider.codex.test.js — the OpenAI Codex (ChatGPT-subscription) provider. Feeds canned
   *Responses API* SSE (response.output_text.delta / response.function_call_arguments.* / response.completed)
   through an injected fake fetch and asserts the SAME normalized HarnessEvent stream the loop consumes as
   for OpenRouter — proving the different wire is fully absorbed behind the seam. Also covers the chat->
   Responses input conversion and the request shape. Zero network. */
'use strict';
const A = require('./_assert.js');
const { makeCodexProvider, _internals } = require('../sidecar/providers/codex.js');

const ev = obj => 'data: ' + JSON.stringify(obj);
const sseFetch = (sseText, status) => async () => new Response(sseText, { status: status || 200, headers: { 'Content-Type': 'text/event-stream' } });
async function collect(provider, req) { const out = []; for await (const e of provider.stream(req)) out.push(e); return out; }

(async () => {
  // A. text turn: output_text deltas assembled, usage remapped (input/output -> prompt/completion), done=stop
  {
    const sse = [
      ev({ type: 'response.created', response: { id: 'r1' } }),
      ev({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } }),
      ev({ type: 'response.output_text.delta', output_index: 0, delta: 'Hel' }),
      ev({ type: 'response.output_text.delta', output_index: 0, delta: 'lo' }),
      ev({ type: 'response.output_item.done', output_index: 0, item: { type: 'message' } }),
      ev({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, output_tokens_details: { reasoning_tokens: 1 } } } }),
      'data: [DONE]', ''
    ].join('\n');
    const p = makeCodexProvider({ fetch: sseFetch(sse), token: 'acc' });
    const evs = await collect(p, { model: 'gpt-5.1-codex', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] });
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Hello', 'output_text deltas assembled');
    const u = evs.find(e => e.type === 'usage');
    A.ok(u, 'usage event emitted');
    A.eq(u.usage.prompt_tokens, 12, 'input_tokens -> prompt_tokens');
    A.eq(u.usage.completion_tokens, 3, 'output_tokens -> completion_tokens');
    A.eq(u.usage.reasoning_tokens, 1, 'reasoning_tokens carried');
    A.eq(u.usage.cost, 0, 'subscription -> cost 0');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'stop', 'no tool calls -> finish stop');
  }

  // B. tool call: function_call item -> tool_start, arg deltas -> tool_args, item.done -> tool_done, finish tool_calls
  {
    const sse = [
      ev({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'web_search' } }),
      ev({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"query":' }),
      ev({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '"candles 2026"}' }),
      ev({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_1' } }),
      ev({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 9 } } }),
      'data: [DONE]', ''
    ].join('\n');
    const p = makeCodexProvider({ fetch: sseFetch(sse), token: 'acc' });
    const evs = await collect(p, { model: 'gpt-5.1-codex', messages: [], tools: [{ type: 'function', function: { name: 'web_search' } }] });
    const start = evs.find(e => e.type === 'tool_start');
    A.eq(start.index, 0, 'tool_start index'); A.eq(start.id, 'call_1', 'tool_start id'); A.eq(start.name, 'web_search', 'tool_start name');
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"query":"candles 2026"}', 'arg fragments concatenate to valid JSON');
    A.ok(evs.find(e => e.type === 'tool_done' && e.index === 0), 'tool_done emitted for the call');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'a function_call -> finish tool_calls');
  }

  // B2. arguments that arrive INLINE on output_item.added (no later delta) are still emitted
  {
    const sse = [
      ev({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c9', name: 'noop', arguments: '{"a":1}' } }),
      ev({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c9' } }),
      ev({ type: 'response.completed', response: { status: 'completed' } }),
      'data: [DONE]', ''
    ].join('\n');
    const p = makeCodexProvider({ fetch: sseFetch(sse), token: 'acc' });
    const evs = await collect(p, { model: 'gpt-5.1-codex', messages: [], tools: [{ type: 'function', function: { name: 'noop' } }] });
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"a":1}', 'inline arguments on item.added are emitted');
  }

  // B3. REASONING-MODEL shape (gpt-5.3-codex-spark): args arrive ONLY in function_call_arguments.done, with NO
  //     .delta stream. The whole arguments JSON must still be emitted exactly once (was dropped -> empty call).
  {
    const sse = [
      ev({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_z', name: 'fs_write', arguments: '' } }),
      ev({ type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"path":"t.txt","content":"hi"}', item_id: 'fc_z' }),
      ev({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_z', arguments: '{"path":"t.txt","content":"hi"}' } }),
      ev({ type: 'response.completed', response: { status: 'completed' } }),
      'data: [DONE]', ''
    ].join('\n');
    const p = makeCodexProvider({ fetch: sseFetch(sse), token: 'acc' });
    const evs = await collect(p, { model: 'gpt-5.3-codex-spark', messages: [], tools: [{ type: 'function', function: { name: 'fs_write' } }] });
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"path":"t.txt","content":"hi"}', 'args.done-only shape emits the full arguments');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'still finishes as tool_calls');
  }

  // B4. NO DOUBLE-EMIT: when BOTH .delta fragments AND a terminal .done arrive (the gpt-5.4/5.5 shape), the
  //     args must concatenate to the JSON ONCE — the .done is a terminator, not a re-send.
  {
    const sse = [
      ev({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'fs_write' } }),
      ev({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' }),
      ev({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '"a.txt"}' }),
      ev({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"path":"a.txt"}' }),
      ev({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c', arguments: '{"path":"a.txt"}' } }),
      ev({ type: 'response.completed', response: { status: 'completed' } }),
      'data: [DONE]', ''
    ].join('\n');
    const p = makeCodexProvider({ fetch: sseFetch(sse), token: 'acc' });
    const evs = await collect(p, { model: 'gpt-5.5', messages: [], tools: [{ type: 'function', function: { name: 'fs_write' } }] });
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"path":"a.txt"}', 'delta+done shape concatenates the args exactly once (no duplication)');
  }

  // C. request shape + chat->Responses input conversion (system lifted to instructions, store:false, stream:true, tools mapped)
  {
    let captured = null;
    const f = async (url, init) => { captured = { url, body: JSON.parse(init.body), headers: init.headers }; return new Response(['data: [DONE]', ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); };
    const p = makeCodexProvider({ fetch: f, token: 'ACCESS' });
    await collect(p, { model: 'gpt-5.1-codex', messages: [{ role: 'system', content: 'You are X.' }, { role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'fetch', description: 'd', parameters: { type: 'object' } } }] });
    A.ok(/\/responses$/.test(captured.url), 'POSTs to the /responses endpoint');
    A.eq(captured.headers['Authorization'], 'Bearer ACCESS', 'access_token sent as a bearer token');
    A.eq(captured.body.instructions, 'You are X.', 'system message lifted into instructions');
    A.eq(captured.body.store, false, 'store:false (no server-side persistence)');
    A.eq(captured.body.stream, true, 'stream:true');
    A.eq(captured.body.input[0], { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }, 'user turn -> input_text part');
    A.eq(captured.body.tools[0], { type: 'function', name: 'fetch', description: 'd', strict: false, parameters: { type: 'object' } }, 'chat tool -> Responses function tool');
    A.eq(captured.body.tool_choice, 'auto', 'tool_choice auto when tools present');
    A.eq(captured.body.reasoning, { effort: 'low', summary: 'auto' }, 'default reasoning effort is low');
    A.eq(captured.body.include, ['reasoning.encrypted_content'], 'reasoning carry-over requested when thinking is on');
  }

  // C1b. Codex effort aliases clamp to the backend scale; reasoning-off skips encrypted reasoning carry-over.
  {
    const bodies = [];
    const f = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(['data: [DONE]', ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); };
    await collect(makeCodexProvider({ fetch: f, token: 'ACCESS', reasoningEffort: 'max' }), { model: 'gpt-5.3-codex', messages: [] });
    await collect(makeCodexProvider({ fetch: f, token: 'ACCESS', reasoningEffort: 'medium' }), { model: 'gpt-5.3-codex', messages: [], reasoningEffort: 'none' });
    A.eq(_internals.normalizeCodexReasoningEffort('minimal'), 'low', 'minimal maps to Codex low');
    A.eq(bodies[0].reasoning, { effort: 'xhigh', summary: 'auto' }, 'max maps to Codex xhigh');
    A.eq(bodies[0].include, ['reasoning.encrypted_content'], 'reasoning carry-over remains on for xhigh');
    A.eq(bodies[1].reasoning, { effort: 'none', summary: 'auto' }, 'per-request reasoning can turn thinking off');
    A.eq(bodies[1].include, undefined, 'reasoning-off omits encrypted reasoning include');
  }

  // C2. input conversion internals: assistant text + tool_calls, and a tool result message
  {
    const input = _internals.messagesToInput([
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 'call_7', function: { name: 'web', arguments: '{"q":1}' } }] },
      { role: 'tool', tool_call_id: 'call_7', content: 'result text' }
    ]);
    A.eq(input[0], { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }, 'assistant text -> output_text part');
    A.eq(input[1], { type: 'function_call', call_id: 'call_7', name: 'web', arguments: '{"q":1}' }, 'assistant tool_call -> function_call item');
    A.eq(input[2], { type: 'function_call_output', call_id: 'call_7', output: 'result text' }, 'tool result -> function_call_output item');
  }

  // D. HTTP error surfaces status + provider body
  {
    const bad = async () => new Response(JSON.stringify({ error: { message: 'token expired' } }), { status: 401 });
    const p = makeCodexProvider({ fetch: bad, token: '' });
    let msg = '';
    try { await collect(p, { model: 'gpt-5.1-codex', messages: [] }); } catch (e) { msg = e.message; }
    A.ok(/401/.test(msg) && /token expired/.test(msg), 'http error surfaces status + message');
  }

  // E. a response.failed event throws (a server-side generation failure is not a clean turn)
  {
    const sse = [ev({ type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } }), ''].join('\n');
    const p = makeCodexProvider({ fetch: sseFetch(sse), token: 'acc' });
    let threw = false;
    try { await collect(p, { model: 'gpt-5.1-codex', messages: [] }); } catch (e) { threw = /boom/.test(e.message); }
    A.ok(threw, 'response.failed throws with the error message');
  }

  // F. a transient 503 is retried, then streams normally
  {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) return new Response('{"error":{"message":"overloaded"}}', { status: 503 });
      return new Response([ev({ type: 'response.output_text.delta', output_index: 0, delta: 'hi' }), ev({ type: 'response.completed', response: { status: 'completed' } }), 'data: [DONE]', ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeCodexProvider({ fetch: flaky, token: 'acc' });
    const evs = await collect(p, { model: 'gpt-5.1-codex', messages: [] });
    A.eq(calls, 2, 'a transient 503 triggers exactly one retry');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'hi', 'after retry it streams normally');
  }

  // G. an incomplete response capped by max_output_tokens normalizes to finish=length
  {
    const sse = [
      ev({ type: 'response.output_text.delta', output_index: 0, delta: 'partial' }),
      ev({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 1 } } }),
      'data: [DONE]', ''
    ].join('\n');
    const p = makeCodexProvider({ fetch: sseFetch(sse), token: 'acc' });
    const evs = await collect(p, { model: 'gpt-5.1-codex', messages: [] });
    A.eq(evs.find(e => e.type === 'done').finishReason, 'length', 'max_output_tokens -> finish length');
  }

  // H. capability surface: known Codex models are tool-capable; unknown -> true (never a false refusal); price null
  {
    const p = makeCodexProvider({ fetch: async () => new Response('', { status: 200 }), token: 'acc' });
    A.eq(p.supportsTools('gpt-5.3-codex'), true, 'known Codex model is tool-capable');
    A.eq(p.supportsTools('some-future-model'), true, 'unknown model -> true (do not false-refuse)');
    A.eq(p.priceOf('gpt-5.3-codex'), null, 'subscription model has no per-token price');
    A.ok(p.contextLimit('gpt-5.3-codex') > 0, 'context limit reported');
  }

  // I. listModels discovers the account's REAL catalog live: queries /models, drops hidden, sorts by priority
  {
    const modelsResp = { models: [
      { slug: 'gpt-5.4', priority: 2, visibility: 'show' },
      { slug: 'gpt-5.3-codex', priority: 1 },
      { slug: 'secret-internal', priority: 0, visibility: 'hidden' },
      { slug: 'gpt-5.5', priority: 3 }
    ] };
    let url = '', auth = '';
    const f = async (u, init) => { url = u; auth = (init && init.headers && init.headers['Authorization']) || ''; return new Response(JSON.stringify(modelsResp), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
    const ids = (await makeCodexProvider({ fetch: f, token: 'ACC' }).listModels()).map(m => m.id);
    A.ok(/\/models\?client_version=/.test(url), 'queries the codex /models endpoint with a client_version');
    A.eq(auth, 'Bearer ACC', 'discovery is authenticated with the access token');
    A.eq(ids, ['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.5'], 'priority-sorted; hidden slug dropped');
  }

  // J. discovery failure (offline / 500) falls back to the curated static list — never an empty menu
  {
    const ids = (await makeCodexProvider({ fetch: async () => new Response('nope', { status: 500 }), token: 'acc' }).listModels()).map(m => m.id);
    A.ok(ids.length > 0 && ids.indexOf('gpt-5.3-codex') >= 0, 'falls back to curated models on discovery failure');
  }

  A.report('provider.codex.test');
})();
