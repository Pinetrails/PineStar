/* node test/provider.openai-compatible.test.js - generic chat/completions provider seam. */
'use strict';
const A = require('./_assert.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');

const line = obj => 'data: ' + JSON.stringify(obj);
async function collect(provider, req) { const out = []; for await (const e of provider.stream(req)) out.push(e); return out; }

module.exports = (async () => {
  // text, usage, finish, and request/header shape
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const sse = [
        line({ choices: [{ delta: { content: 'Hel' } }] }),
        line({ choices: [{ delta: { content: 'lo' } }] }),
        line({ usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }),
        line({ choices: [{ finish_reason: 'stop', delta: {} }] }),
        'data: [DONE]', ''
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, key: 'KEY', baseUrl: 'https://example.test/v1/', includeUsage: true });
    const evs = await collect(p, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Hello', 'text deltas stream');
    A.eq(evs.find(e => e.type === 'usage').usage.total_tokens, 5, 'usage event streams');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'stop', 'finish is normalized');
    A.eq(calls[0].url, 'https://example.test/v1/chat/completions', 'posts to chat/completions');
    A.eq(calls[0].init.headers.Authorization, 'Bearer KEY', 'api key is sent as bearer auth');
    A.eq(JSON.parse(calls[0].init.body).stream_options, { include_usage: true }, 'optional usage include is wired');
  }

  // tool-call streaming
  {
    const fetchImpl = async () => {
      const sse = [
        line({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"q":' } }] } }] }),
        line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] }),
        line({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }),
        'data: [DONE]', ''
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1' });
    const evs = await collect(p, { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'web_search' } }] });
    A.eq(evs.find(e => e.type === 'tool_start').name, 'web_search', 'tool_start carries name');
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"q":"x"}', 'tool args concatenate');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'tool finish is normalized');
  }

  // model catalog parsing and no-auth local shape
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ id: 'local-model', context_length: 1234, supported_parameters: ['tools'] }] }), { status: 200 });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://127.0.0.1:11434/v1' });
    const models = await p.listModels();
    A.eq(calls[0].url, 'http://127.0.0.1:11434/v1/models', 'lists /models');
    A.eq(calls[0].init.headers.Authorization, undefined, 'no auth header when no key');
    A.eq(models[0].id, 'local-model', 'catalog id parsed');
    A.eq(p.contextLimit('local-model'), 1234, 'context length from catalog');
    A.eq(p.supportsTools('local-model'), true, 'tool support from supported_parameters');
  }

  // provider profile paths can override the default /chat/completions and /models endpoints
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (init && init.method === 'POST') {
        return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'https://example.test/root/', chatPath: 'responses', modelsPath: 'catalog/models' });
    await collect(p, { model: 'm', messages: [] });
    await p.listModels();
    A.eq(calls[0].url, 'https://example.test/root/responses', 'custom chat path is honored');
    A.eq(calls[1].url, 'https://example.test/root/catalog/models', 'custom models path is honored');
  }

  A.report('provider.openai-compatible.test');
})();
