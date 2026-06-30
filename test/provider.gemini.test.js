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

  A.eq(_internals.finishFor('MAX_TOKENS', false), 'length', 'MAX_TOKENS -> length');
  A.report('provider.gemini.test');
})().catch(e => { console.log('FAIL: provider.gemini.test threw -- ' + (e && e.stack || e)); process.exit(1); });
