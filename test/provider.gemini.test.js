/* node test/provider.gemini.test.js - native Google Gemini provider seam. */
'use strict';
const A = require('./_assert.js');
const { makeGeminiProvider, _internals } = require('../sidecar/providers/gemini.js');

const line = obj => 'data: ' + JSON.stringify(obj);
const sseFetch = (sseText, status) => async () => new Response(sseText, { status: status || 200, headers: { 'Content-Type': 'text/event-stream' } });
async function collect(provider, req) { const out = []; for await (const e of provider.stream(req)) out.push(e); return out; }

(async () => {
  // A. text turn: GenerateContentResponse chunks become text, usage, and normalized done.
  {
    const sse = [
      line({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }),
      line({ candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }),
      ''
    ].join('\n');
    const p = makeGeminiProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'gemini-test', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Hello', 'text chunks stream');
    A.eq(evs.find(e => e.type === 'usage').usage.total_tokens, 5, 'usageMetadata remapped');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'stop', 'STOP -> stop');
  }

  // B. functionCall parts become one harness tool call with JSON args.
  {
    const sse = [
      line({ candidates: [{ content: { parts: [{ functionCall: { name: 'web_search', args: { q: 'x' } } }] }, finishReason: 'STOP' }] }),
      ''
    ].join('\n');
    const p = makeGeminiProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'models/gemini-test', messages: [], tools: [{ type: 'function', function: { name: 'web_search' } }] });
    const start = evs.find(e => e.type === 'tool_start');
    A.eq(start, { type: 'tool_start', index: 0, id: 'call_0', name: 'web_search' }, 'functionCall start normalized');
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"q":"x"}', 'functionCall args JSON emitted');
    A.ok(evs.find(e => e.type === 'tool_done' && e.index === 0), 'tool_done emitted');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'functionCall finish -> tool_calls');
  }

  // B2. a repeated ci:pi:name across SSE frames, each with its OWN nonempty args, is TWO distinct calls — the
  //     args must NOT be concatenated into invalid JSON ({"q":"x"}{"q":"y"}); each gets its own dense index.
  {
    const sse = [
      line({ candidates: [{ content: { parts: [{ functionCall: { name: 'web_search', args: { q: 'x' } } }] } }] }),
      line({ candidates: [{ content: { parts: [{ functionCall: { name: 'web_search', args: { q: 'y' } } }] }, finishReason: 'STOP' }] }),
      ''
    ].join('\n');
    const p = makeGeminiProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'gemini-test', messages: [], tools: [{ type: 'function', function: { name: 'web_search' } }] });
    const starts = evs.filter(e => e.type === 'tool_start');
    A.eq(starts.length, 2, 'two distinct tool_start events for the repeated-key-but-distinct-args calls');
    A.eq(starts.map(e => e.index), [0, 1], 'the second call gets its own dense index (not index 0 again)');
    const argsByIdx = {};
    for (const e of evs.filter(e => e.type === 'tool_args')) argsByIdx[e.index] = (argsByIdx[e.index] || '') + e.chunk;
    A.eq(argsByIdx[0], '{"q":"x"}', 'call 0 args are intact (not corrupted by the second call)');
    A.eq(argsByIdx[1], '{"q":"y"}', 'call 1 args are their own valid JSON, never concatenated onto call 0');
  }

  // B3. the NORMAL whole-functionCall case is unchanged: one part, one call, args emitted once.
  {
    const sse = [
      line({ candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: { id: 1 } } }] }, finishReason: 'STOP' }] }),
      ''
    ].join('\n');
    const p = makeGeminiProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'gemini-test', messages: [], tools: [{ type: 'function', function: { name: 'lookup' } }] });
    A.eq(evs.filter(e => e.type === 'tool_start').length, 1, 'a single whole functionCall is still exactly one call');
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"id":1}', 'whole-call args intact');
  }

  // C. request conversion and URL shape.
  {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response([line({ candidates: [{ finishReason: 'STOP' }] }), ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeGeminiProvider({ fetch: fetchImpl, key: 'KEY', baseUrl: 'https://gemini.test/v1beta/' });
    await collect(p, {
      model: 'gemini-test',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'ok', tool_calls: [{ id: 'call_7', function: { name: 'web', arguments: '{"q":1}' } }] },
        { role: 'tool', tool_call_id: 'call_7', content: '{"result":"yes"}' }
      ],
      tools: [{ type: 'function', function: { name: 'web', description: 'd', parameters: { type: 'object' } } }]
    });
    A.eq(captured.url, 'https://gemini.test/v1beta/models/gemini-test:streamGenerateContent?alt=sse', 'POSTs to streamGenerateContent SSE endpoint');
    A.eq(captured.headers['x-goog-api-key'], 'KEY', 'api key sent as x-goog-api-key');
    A.eq(captured.body.systemInstruction, { parts: [{ text: 'sys' }] }, 'leading system -> systemInstruction');
    A.eq(captured.body.tools[0].functionDeclarations[0], { name: 'web', description: 'd', parameters: { type: 'object' } }, 'OpenAI tool -> Gemini functionDeclaration');
    A.eq(captured.body.contents[0].parts[1], { functionCall: { name: 'web', args: { q: 1 } } }, 'assistant tool_call -> functionCall part');
    A.eq(captured.body.contents[1].parts[0], { functionResponse: { name: 'web', response: { result: 'yes' } } }, 'tool result -> functionResponse part');
  }

  // D. model catalog strips models/ for friendly stored IDs, but modelPath adds it back for calls.
  {
    const fetchImpl = async (url, init) => {
      A.eq(url, 'https://generativelanguage.googleapis.com/v1beta/models', 'lists /models');
      A.eq(init.headers['x-goog-api-key'], 'KEY', 'model listing is authenticated');
      return new Response(JSON.stringify({ models: [{ name: 'models/gemini-x', displayName: 'Gemini X', inputTokenLimit: 1000, outputTokenLimit: 200, supportedGenerationMethods: ['generateContent'] }] }), { status: 200 });
    };
    const p = makeGeminiProvider({ fetch: fetchImpl, key: 'KEY' });
    const models = await p.listModels();
    A.eq(models[0].id, 'gemini-x', 'models/ prefix stripped for UI');
    A.eq(p.contextLimit('gemini-x'), 1000, 'context limit from inputTokenLimit');
    A.eq(_internals.modelPath('gemini-x'), 'models/gemini-x', 'modelPath restores models/ prefix');
  }

  // E. USER ATTACHMENTS: a user message with an image_url part maps to a Gemini inlineData part (base64 data,
  //    no data: prefix); text is preserved; a plain-string user turn is unchanged.
  {
    const png = 'AAAABBBBCCCC';
    const conv = _internals.messagesToGemini([
      { role: 'user', content: [
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'data:image/webp;base64,' + png } }
      ] }
    ]);
    A.eq(conv.contents[0].parts[0], { text: 'describe' }, 'text part preserved');
    A.eq(conv.contents[0].parts[1], { inlineData: { mimeType: 'image/webp', data: png } }, 'data: URL image_url -> inlineData part');

    const plain = _internals.messagesToGemini([{ role: 'user', content: 'hello' }]);
    A.eq(plain.contents[0].parts[0], { text: 'hello' }, 'plain string user turn unchanged');
  }

  A.eq(_internals.finishFor('MAX_TOKENS', false), 'length', 'MAX_TOKENS -> length');
  A.report('provider.gemini.test');
})().catch(e => { console.log('FAIL: provider.gemini.test threw -- ' + (e && e.stack || e)); process.exit(1); });
