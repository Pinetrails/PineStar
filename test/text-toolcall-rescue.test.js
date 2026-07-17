/* node test/text-toolcall-rescue.test.js — the TEXT TOOL-CALL RESCUE (sidecar/loop.js, model-consistency
   sweep 2026-07-17). Some models (Kimi/Qwen/GLM families) emit their tool call as plain-text
   `<tool_call>{"name":…,"arguments":{…}}</tool_call>` markup instead of the tool_calls wire; the loop used
   to show the raw XML and end the run 'done'. Proves: a marked-up turn is recovered into a REAL dispatched
   call and the run continues to delivery; markup is stripped from the kept assistant text; unknown tool
   names and unparseable blocks are never guessed at (left as text); ordinary text mentioning the literal
   tag is untouched; the wire path always wins. Replay provider -> zero spend. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop, _internals } = require('../sidecar/loop.js');
const { rescueTextToolCalls } = _internals;

const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
const TOOLS = [{ type: 'function', function: { name: 'fs_read', description: 'r', parameters: { type: 'object' } } }];
function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { seq, emit };
}
const textTurn = (t) => [{ type: 'text', delta: t }, { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, { type: 'done', finishReason: 'stop' }];
function scripted(turns) {
  let n = 0;
  return { async *stream() { const t = turns[Math.min(n, turns.length - 1)]; n++; for (const ev of t) yield ev; },
           priceOf: () => ({ prompt: '0', completion: '0' }), contextLimit: () => 8000, callCount: () => n };
}

(async () => {
  // ---- unit: the pure rescuer ----
  {
    const r = rescueTextToolCalls('Reading it.\n<tool_call>{"name":"fs_read","arguments":{"path":"a.js"}}</tool_call>', TOOLS);
    A.ok(r && r.calls.length === 1, 'one block rescued');
    A.eq(r.calls[0].name, 'fs_read', 'wired tool name kept');
    A.eq(r.calls[0].args.path, 'a.js', 'arguments parsed');
    A.eq(r.text, 'Reading it.', 'markup stripped from kept text');

    A.eq(rescueTextToolCalls('<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>', TOOLS), null, 'unknown tool never rescued');
    A.eq(rescueTextToolCalls('<tool_call>not json at all ???</tool_call>', TOOLS), null, 'unparseable block never rescued');
    A.eq(rescueTextToolCalls('the <tool_call> tag is how some models emit calls', TOOLS), null, 'prose mentioning the tag untouched');
    A.eq(rescueTextToolCalls('<tool_call>{"name":"fs_read","arguments":{}}</tool_call>', []), null, 'no wired tools = no rescue');
    // "parameters" alias + trailing-comma repair both accepted
    const r2 = rescueTextToolCalls('<tool_call>{"name":"fs_read","parameters":{"path":"b.js",}}</tool_call>', TOOLS);
    A.ok(r2 && r2.calls[0].args.path === 'b.js', 'parameters alias + mechanical JSON repair accepted');
  }

  // ---- e2e: rescued call is DISPATCHED and the run continues to a real delivery ----
  {
    const dispatched = [];
    const dispatch = async (call) => { dispatched.push(call.name); return { ok: true, isError: false, content: 'file text', summary: 'ok' }; };
    const provider = scripted([
      textTurn('<tool_call>{"name":"fs_read","arguments":{"path":"main.js"}}</tool_call>'),
      textTurn('The file shows the bug; here is the fix summary.')
    ]);
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider, emit: setup().emit,
      cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', agentId: 'a', runId: 'r',
      tools: TOOLS, dispatch, capCtx: openCtx() });
    A.eq(res.reason, 'done', 'rescued run continues to a clean delivery');
    A.eq(dispatched.join(','), 'fs_read', 'the text-emitted call was really dispatched');
    A.eq(provider.callCount(), 2, 'tool turn + final answer');
    const toolMsgs = res.messages.filter(m => m.role === 'tool');
    A.eq(toolMsgs.length, 1, 'tool result paired into the transcript');
    const asst = res.messages.filter(m => m.role === 'assistant')[0];
    A.ok(asst.tool_calls && asst.tool_calls.length === 1, 'assistant turn replays as a REAL tool_calls turn');
    A.ok(!/<tool_call>/.test(String(asst.content)), 'no raw markup left in the assistant text');
  }

  console.log('text-toolcall-rescue.test: OK');
})().catch(e => { console.error(e); process.exit(1); });
