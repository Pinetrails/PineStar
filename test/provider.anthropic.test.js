/* node test/provider.anthropic.test.js - native Anthropic Messages provider seam. */
'use strict';
const A = require('./_assert.js');
const { makeAnthropicProvider, _internals } = require('../sidecar/providers/anthropic.js');

const line = obj => 'data: ' + JSON.stringify(obj);
const sseFetch = (sseText, status) => async () => new Response(sseText, { status: status || 200, headers: { 'Content-Type': 'text/event-stream' } });
async function collect(provider, req) { const out = []; for await (const e of provider.stream(req)) out.push(e); return out; }

(async () => {
  // A. text turn: Anthropic text deltas, split usage, and end_turn normalize to the harness stream.
  {
    const sse = [
      line({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }),
      line({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
      line({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      line({ type: 'message_stop' }),
      ''
    ].join('\n');
    const p = makeAnthropicProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Hello', 'text deltas stream');
    const usage = evs.filter(e => e.type === 'usage').pop().usage;
    A.eq(usage.prompt_tokens, 3, 'message_start input_tokens are retained in final usage');
    A.eq(usage.completion_tokens, 2, 'message_delta output_tokens -> completion_tokens');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'stop', 'end_turn -> stop');
  }

  // B. tool call: content_block_start/tool_use + input_json_delta fragments become harness tool events.
  {
    const sse = [
      line({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: {} } }),
      line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } }),
      line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"x"}' } }),
      line({ type: 'content_block_stop', index: 1 }),
      line({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }),
      line({ type: 'message_stop' }),
      ''
    ].join('\n');
    const p = makeAnthropicProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'claude-test', messages: [], tools: [{ type: 'function', function: { name: 'web_search' } }] });
    const start = evs.find(e => e.type === 'tool_start');
    A.eq(start, { type: 'tool_start', index: 0, id: 'toolu_1', name: 'web_search' }, 'tool_use start is remapped to dense harness index');
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"q":"x"}', 'input_json_delta fragments concatenate');
    A.ok(evs.find(e => e.type === 'tool_done' && e.index === 0), 'tool_done emitted');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'tool_use -> tool_calls');
  }

  // C. request conversion: leading system lifts to top-level system; tools and tool-results use Anthropic shape.
  {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response([line({ type: 'message_stop' }), ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeAnthropicProvider({ fetch: fetchImpl, key: 'KEY', baseUrl: 'https://anthropic.test/v1/' });
    await collect(p, {
      model: 'claude-test',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'ok', tool_calls: [{ id: 'call_7', function: { name: 'web', arguments: '{"q":1}' } }] },
        { role: 'tool', tool_call_id: 'call_7', content: 'result text' }
      ],
      tools: [{ type: 'function', function: { name: 'web', description: 'd', parameters: { type: 'object' } } }]
    });
    A.eq(captured.url, 'https://anthropic.test/v1/messages', 'POSTs to /messages');
    A.eq(captured.headers['x-api-key'], 'KEY', 'api key sent as x-api-key');
    A.eq(captured.headers['anthropic-version'], '2023-06-01', 'Anthropic API version header set');
    A.eq(captured.body.system, 'sys', 'leading system lifted');
    A.eq(captured.body.tools[0], { name: 'web', description: 'd', input_schema: { type: 'object' } }, 'OpenAI tool -> Anthropic tool');
    A.eq(captured.body.messages[0].content[1], { type: 'tool_use', id: 'call_7', name: 'web', input: { q: 1 } }, 'assistant tool_call -> tool_use block');
    A.eq(captured.body.messages[1].content[0], { type: 'tool_result', tool_use_id: 'call_7', content: 'result text' }, 'tool result -> tool_result block');
  }

  // D. model catalog parses /models.
  {
    const fetchImpl = async (url, init) => {
      A.eq(url, 'https://api.anthropic.com/v1/models', 'lists /models');
      A.eq(init.headers['x-api-key'], 'KEY', 'model listing is authenticated');
      return new Response(JSON.stringify({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }), { status: 200 });
    };
    const p = makeAnthropicProvider({ fetch: fetchImpl, key: 'KEY' });
    const models = await p.listModels();
    A.eq(models[0].id, 'claude-x', 'catalog id parsed');
    A.eq(models[0].supportsTools, true, 'Anthropic native models are marked tool-capable');
  }

  A.eq(_internals.normalizeUsage({ input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 }).prompt_tokens, 3, 'cache read tokens are included in prompt total');
  A.report('provider.anthropic.test');
})().catch(e => { console.log('FAIL: provider.anthropic.test threw -- ' + (e && e.stack || e)); process.exit(1); });
