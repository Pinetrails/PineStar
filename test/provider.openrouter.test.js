/* node test/provider.openrouter.test.js — the OpenRouter SSE adapter, fed canned bytes
   through an injected fake fetch. Asserts the exact HarnessEvent stream the proven loop
   consumes: text deltas (keep-alives skipped), index-keyed tool-call accumulation,
   usage with cost, normalized finishReason, and error surfacing. Zero network. */
'use strict';
const A = require('./_assert.js');
const { makeOpenRouterProvider } = require('../sidecar/providers/openrouter.js');

const line = obj => 'data: ' + JSON.stringify(obj);
const sseFetch = (sseText, status) => async () => new Response(sseText, { status: status || 200, headers: { 'Content-Type': 'text/event-stream' } });
async function collect(provider, req) { const out = []; for await (const e of provider.stream(req)) out.push(e); return out; }

(async () => {
  // A. text turn: deltas assembled, ':' keep-alive skipped, usage(cost), done normalized
  {
    const sse = [
      line({ choices: [{ delta: { content: 'Hel' } }] }),
      ': OPENROUTER PROCESSING',
      line({ choices: [{ delta: { content: 'lo' } }] }),
      line({ usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 } }),
      line({ choices: [{ finish_reason: 'stop', delta: {} }] }),
      'data: [DONE]', ''
    ].join('\n');
    const p = makeOpenRouterProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'm', messages: [], tools: [] });
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Hello', 'text deltas assembled; keep-alive skipped');
    const u = evs.find(e => e.type === 'usage');
    A.ok(u && u.usage.cost === 0.0001, 'usage event carries real cost');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'stop', 'finishReason normalized');
  }

  // B. tool call: id+name on first fragment, args split across chunks, concatenated to valid JSON
  {
    const sse = [
      line({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":' } }] } }] }),
      line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"candles 2026"}' } }] } }] }),
      line({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }),
      'data: [DONE]', ''
    ].join('\n');
    const p = makeOpenRouterProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'web_search' } }] });
    const start = evs.find(e => e.type === 'tool_start');
    A.eq(start.index, 0, 'tool_start index'); A.eq(start.id, 'call_1', 'tool_start id'); A.eq(start.name, 'web_search', 'tool_start name');
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"query":"candles 2026"}', 'tool_args fragments concatenate to valid JSON');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'finishReason tool_calls');
  }

  // C. mid-stream error chunk throws with the provider message
  {
    const sse = [line({ error: { message: 'rate limited', code: 429 } }), ''].join('\n');
    const p = makeOpenRouterProvider({ fetch: sseFetch(sse), key: 'k' });
    let threw = false;
    try { await collect(p, { model: 'm', messages: [] }); } catch (e) { threw = /rate limited/.test(e.message); }
    A.ok(threw, 'mid-stream error chunk throws with its message');
  }

  // D. HTTP error surfaces status + provider body
  {
    const badFetch = async () => new Response(JSON.stringify({ error: { message: 'no key' } }), { status: 401 });
    const p = makeOpenRouterProvider({ fetch: badFetch, key: '' });
    let msg = '';
    try { await collect(p, { model: 'm', messages: [] }); } catch (e) { msg = e.message; }
    A.ok(/401/.test(msg) && /no key/.test(msg), 'http error surfaces status + provider message');
  }

  // E. REGRESSION LOCK: a genuine error whose message merely CONTAINS "abort" still THROWS — it must
  //    not be swallowed as a clean, empty, "successful" turn. Cancellation is detected by signal/name only.
  {
    const sse = [line({ error: { message: 'upstream request was aborted by origin', code: 502 } }), ''].join('\n');
    const p = makeOpenRouterProvider({ fetch: sseFetch(sse), key: 'k' });
    let threw = false;
    try { await collect(p, { model: 'm', messages: [] }); } catch (e) { threw = /aborted/.test(e.message); }
    A.ok(threw, 'a real error containing "abort" is surfaced, not swallowed');
  }

  // F. a genuine cancellation (the reader throws AbortError) ends the stream CLEANLY — no throw, no events,
  //    so the loop then reports 'cancelled' (not 'error' and not a fake 'done').
  {
    const abortingFetch = async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; } }) }
    });
    const p = makeOpenRouterProvider({ fetch: abortingFetch, key: 'k' });
    let threw = false, evs = [];
    try { evs = await collect(p, { model: 'm', messages: [] }); } catch (e) { threw = true; }
    A.ok(!threw, 'a genuine AbortError ends the stream cleanly');
    A.eq(evs.length, 0, 'no events emitted after a clean cancel');
  }

  // G. a transient 503 is retried, then streams normally (no tokens lost — retry is pre-stream)
  {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) return new Response('{"error":{"message":"overloaded"}}', { status: 503 });
      return new Response(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }), 'data: [DONE]', ''].join('\n'),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenRouterProvider({ fetch: flaky, key: 'k' });
    const evs = await collect(p, { model: 'm', messages: [] });
    A.eq(calls, 2, 'a transient 503 triggers exactly one retry');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'hi', 'after retry it streams normally');
  }

  // H. a non-transient 400 fails fast with NO retry
  {
    let calls = 0;
    const bad = async () => { calls++; return new Response('{"error":{"message":"bad request"}}', { status: 400 }); };
    const p = makeOpenRouterProvider({ fetch: bad, key: 'k' });
    let threw = false;
    try { await collect(p, { model: 'm', messages: [] }); } catch (e) { threw = /400/.test(e.message); }
    A.ok(threw && calls === 1, 'a 400 fails fast with no retry');
  }

  // I. supportsTools reflects the warmed catalog; unknown -> null (never a false refusal)
  {
    const modelsFetch = async () => new Response(JSON.stringify({ data: [
      { id: 'tooly', supported_parameters: ['tools'] }, { id: 'plain', supported_parameters: [] }
    ] }), { status: 200 });
    const p = makeOpenRouterProvider({ fetch: modelsFetch });
    await p.listModels();
    A.eq(p.supportsTools('tooly'), true, 'tool-capable model -> true');
    A.eq(p.supportsTools('plain'), false, 'non-tool model -> false');
    A.eq(p.supportsTools('unknown-xyz'), null, 'unknown model -> null (do not false-refuse)');
  }

  // J. REGRESSION LOCK: a cancel during the PRE-STREAM request (POST / retry backoff) ends cleanly as a
  //    cancel — not a thrown error — so the loop reports 'cancelled'. (Caught by the regression review.)
  {
    let calls = 0;
    const p = makeOpenRouterProvider({ fetch: async () => { calls++; return new Response('', { status: 200 }); }, key: 'k' });
    let threw = false, evs = [];
    try { evs = await collect(p, { model: 'm', messages: [], signal: { aborted: true } }); } catch (e) { threw = true; }
    A.ok(!threw, 'a cancel during the pre-stream request ends cleanly (no throw)');
    A.eq(evs.length, 0, 'no events on a pre-stream cancel');
    A.eq(calls, 0, 'aborted before the request was even sent');
  }

  // K. classifier-driven retry replaces the old status whitelist: a 402 (billing) fails fast; a 408
  //    (timeout) now retries — the genuinely new behavior (408 was fail-fast under the hardcoded set).
  {
    let n = 0;
    const billing = async () => { n++; return new Response('{"error":{"message":"insufficient credits"}}', { status: 402 }); };
    let threw = false;
    try { await collect(makeOpenRouterProvider({ fetch: billing, key: 'k' }), { model: 'm', messages: [] }); } catch (e) { threw = /402/.test(e.message); }
    A.ok(threw && n === 1, 'a 402 billing error fails fast (no paid retry burned)');

    let m = 0;
    const timeout = async () => {
      m++;
      if (m === 1) return new Response('{"error":{"message":"request timeout"}}', { status: 408 });
      return new Response(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]', ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const evs = await collect(makeOpenRouterProvider({ fetch: timeout, key: 'k' }), { model: 'm', messages: [] });
    A.eq(m, 2, 'a 408 timeout now retries (classifier-derived; was fail-fast under the status whitelist)');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'ok', 'after the 408 retry it streams normally');
  }

  // L. prompt caching: applyCacheControl marks the system prefix cacheable for Anthropic-style models ONLY.
  //    NOTE: this asserts the wire SHAPE, not a real cache HIT — Anthropic only caches a prefix above a per-model
  //    minimum (~1024–4096 tokens), so the tiny 'SYS PREFIX' here would run uncached live. A real hit is proven by
  //    test/live.smoke.js (which pads the system prompt past the floor and checks cached_tokens > 0).
  {
    const { applyCacheControl } = require('../sidecar/providers/openrouter.js');
    const msgs = [{ role: 'system', content: 'SYS PREFIX' }, { role: 'user', content: 'hi' }];

    const cached = applyCacheControl(msgs, 'anthropic/claude-sonnet-4.6');
    A.eq(Array.isArray(cached[0].content), true, 'anthropic: system content becomes a block array');
    A.eq(cached[0].content[0].text, 'SYS PREFIX', 'system text preserved in the block');
    A.eq(cached[0].content[0].cache_control.type, 'ephemeral', 'ephemeral cache_control breakpoint set on the system block');
    A.eq(cached[1], msgs[1], 'non-system messages untouched');
    A.eq(msgs[0].content, 'SYS PREFIX', 'pure: input is NOT mutated');

    A.eq(applyCacheControl(msgs, 'openai/gpt-4o')[0].content, 'SYS PREFIX', 'non-anthropic model: system left as a plain string (no-op)');
    A.eq(applyCacheControl([{ role: 'user', content: 'hi' }], 'anthropic/claude-3.5')[0].content, 'hi', 'no leading system message -> unchanged');
    A.eq(applyCacheControl([], 'anthropic/claude-3.5').length, 0, 'empty messages -> unchanged');
  }

  // L2. caching is actually WIRED into the request body for Anthropic models (and absent for others)
  {
    const grab = async (model) => {
      const calls = [];
      const capFetch = async (url, opts) => { calls.push(opts); return new Response(['data: [DONE]', ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); };
      await collect(makeOpenRouterProvider({ fetch: capFetch, key: 'k' }), { model, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }] });
      return JSON.parse(calls[0].body);
    };
    const ant = await grab('anthropic/claude-sonnet-4.6');
    A.ok(Array.isArray(ant.messages[0].content) && ant.messages[0].content[0].cache_control, 'stream() sends cache_control on the system block for anthropic');
    const gpt = await grab('openai/gpt-4o');
    A.eq(gpt.messages[0].content, 'S', 'stream() leaves the system content a plain string for non-anthropic');
  }

  A.report('provider.openrouter.test');
})();
