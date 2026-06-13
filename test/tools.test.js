/* node test/tools.test.js — tool registry + dispatch pipeline, and the loop's first
   real multi-turn tool exercise (tool_call -> tool_result -> final answer). */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

const call = (name, args, id) => ({ id: id || 'c1', name, args, argsRaw: JSON.stringify(args || {}), parseError: null });

(async () => {
  // ============ A. registry units ============
  {
    const reg = makeRegistry();
    let runs = 0;
    reg.register({ name: 'echo', description: 'echo text', capability: 'memory',
      schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
      run: async args => { runs++; return 'echoed: ' + args.text; } });

    A.eq(reg.list().length, 1, 'one tool registered');
    A.eq(reg.list(['echo']).length, 1, 'list by tool name');
    A.eq(reg.list(['memory']).length, 1, 'list by capability id');
    A.eq(reg.list(['nope']).length, 0, 'list filters out non-granted');
    const wf = reg.wireFormat();
    A.eq(wf[0].type, 'function', 'wireFormat type');
    A.eq(wf[0].function.name, 'echo', 'wireFormat name');
    A.eq(wf[0].function.parameters.required[0], 'text', 'wireFormat carries the schema');

    // valid dispatch runs once
    const r = await reg.dispatch(call('echo', { text: 'hi' }));
    A.eq(r.ok, true, 'valid dispatch ok'); A.eq(r.isError, false, 'valid dispatch not error');
    A.eq(r.content, 'echoed: hi', 'tool output'); A.eq(runs, 1, 'run called once');

    // unknown tool -> isError, run not called
    const u = await reg.dispatch(call('ghost', {}));
    A.eq(u.isError, true, 'unknown tool -> isError'); A.eq(runs, 1, 'unknown tool did not run anything');

    // parse error -> isError, run not called
    const p = await reg.dispatch({ id: 'c', name: 'echo', args: {}, argsRaw: '{bad', parseError: 'invalid tool arguments JSON' });
    A.eq(p.isError, true, 'parseError -> isError'); A.eq(runs, 1, 'parseError did not run');

    // bad schema args -> isError, run not called
    const b = await reg.dispatch(call('echo', { text: 123 }));
    A.eq(b.isError, true, 'bad args -> isError'); A.eq(runs, 1, 'bad args did not run');
  }

  // ============ B. dispatch: throw / timeout / consent / capability gate ============
  {
    const reg = makeRegistry();
    reg.register({ name: 'boom', schema: { type: 'object' }, run: async () => { throw new Error('kaboom'); } });
    reg.register({ name: 'hang', timeoutMs: 20, schema: { type: 'object' }, run: () => new Promise(() => {}) });
    let consentRuns = 0;
    reg.register({ name: 'guarded', requiresConsent: true, scope: 'write', schema: { type: 'object' }, run: async () => { consentRuns++; return 'wrote'; } });

    const t = await reg.dispatch(call('boom', {}));
    A.eq(t.isError, true, 'throwing tool -> isError (not thrown)');
    A.ok(t.content.indexOf('kaboom') >= 0, 'error message surfaced for the model');

    const to = await reg.dispatch(call('hang', {}));
    A.eq(to.isError, true, 'hanging tool -> timeout isError');
    A.eq(to.summary, 'timeout', 'timeout summary');

    // consent denied -> no run
    const d = await reg.dispatch(call('guarded', {}), { consent: async () => ({ allow: false, reason: 'user said no' }) });
    A.eq(d.isError, true, 'consent denied -> isError'); A.eq(consentRuns, 0, 'denied consent did not run');
    // consent allowed -> runs
    const a = await reg.dispatch(call('guarded', {}), { consent: async () => ({ allow: true }) });
    A.eq(a.ok, true, 'consent allowed -> ok'); A.eq(consentRuns, 1, 'allowed consent ran once');

    // capability gate denied -> capdenied, no run
    let gated = 0;
    reg.register({ name: 'priv', schema: { type: 'object' }, run: async () => { gated++; return 'x'; } });
    const cg = await reg.dispatch(call('priv', {}), { canUse: () => ({ ok: false, reason: 'no compute placed' }) });
    A.eq(cg.isError, true, 'capability denied -> isError'); A.eq(cg.summary, 'capdenied', 'capdenied summary'); A.eq(gated, 0, 'capability denial did not run');
  }

  // ============ C. loop integration: tool_call -> tool_result -> final answer ============
  function setup() {
    const bus = A.makeBus();
    const seq = A.collectBus(bus, events.names());
    const emit = makeEmitter(bus, () => {});
    return { bus, seq, emit };
  }
  const names = seq => seq.map(e => e.name);

  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider({
      models: [{ id: 'replay/model', context_length: 8000, pricing: { prompt: '0.000001', completion: '0.000002' }, supportsTools: true }],
      turns: [
        [ { type: 'tool_start', index: 0, id: 'call_1', name: 'echo' },
          { type: 'tool_args', index: 0, chunk: '{"text":' },
          { type: 'tool_args', index: 0, chunk: '"hi"}' },
          { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
          { type: 'done', finishReason: 'tool_calls' } ],
        [ { type: 'text', delta: 'done!' },
          { type: 'usage', usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
          { type: 'done', finishReason: 'stop' } ]
      ]
    });
    const reg = makeRegistry();
    reg.register({ name: 'echo', schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }, run: async a => 'echoed: ' + a.text });

    const messages = [{ role: 'user', content: 'please echo hi' }];
    const res = await runAgentLoop({
      messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', tools: reg.wireFormat(),
      dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: {}
    });

    A.eq(names(seq), ['agent.run.start', 'cost.estimate', 'agent.cost', 'agent.tool_call', 'agent.tool_result', 'agent.token', 'cost.estimate', 'agent.cost', 'agent.run.end'], 'multi-turn tool sequence');
    A.eq(res.reason, 'done', 'loop ends done after the tool turn');
    A.eq(provider.callCount(), 2, 'two model calls (tool turn + final)');

    // requested-ids === answered-ids
    const tc = seq.find(e => e.name === 'agent.tool_call').payload;
    const tr = seq.find(e => e.name === 'agent.tool_result').payload;
    A.eq(tc.callId, 'call_1', 'tool_call id'); A.eq(tr.callId, 'call_1', 'tool_result id matches the call');
    A.eq(tr.isError, false, 'tool succeeded');

    // messages: user, assistant(tool_calls), tool(result), assistant(final)
    A.eq(messages.length, 4, 'four messages after the run');
    A.eq(messages[1].tool_calls[0].function.name, 'echo', 'assistant carried the tool call');
    A.eq(messages[2].role, 'tool', 'tool result message');
    A.eq(messages[2].tool_call_id, 'call_1', 'tool result references the call id');
    A.eq(messages[2].content, 'echoed: hi', 'tool result content fed back');
    A.eq(messages[3].content, 'done!', 'final assistant answer');
  }

  // ============ D. loop guards (need multi-turn tool fixtures) ============
  // budget: a per-run cap trips BEFORE the second model call
  {
    const { seq, emit } = setup();
    const toolTurn = [ { type: 'tool_start', index: 0, id: 'c', name: 'echo' }, { type: 'tool_args', index: 0, chunk: '{}' },
      { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 3 } }, { type: 'done', finishReason: 'tool_calls' } ];
    const provider = makeReplayProvider({ turns: [toolTurn, toolTurn, toolTurn] });
    const reg = makeRegistry();
    reg.register({ name: 'echo', schema: { type: 'object' }, run: async () => 'ok' });
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'x' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', limits: { maxCostUsd: 1e-6, maxIters: 99 }, tools: reg.wireFormat(),
      dispatch: (c, ctx) => reg.dispatch(c, ctx)
    });
    A.eq(res.reason, 'budget', 'per-run cap trips the loop');
    A.eq(provider.callCount(), 1, 'budget stops before the 2nd paid call');
    A.eq(names(seq)[names(seq).length - 1], 'agent.run.end', 'ends with run.end{budget}');
  }

  // max_iters: an always-tool-calling fixture is bounded
  {
    const { emit } = setup();
    const toolTurn = [ { type: 'tool_start', index: 0, id: 'c', name: 'echo' }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' } ];
    const provider = makeReplayProvider({ turns: [toolTurn, toolTurn, toolTurn, toolTurn, toolTurn] });
    const reg = makeRegistry();
    reg.register({ name: 'echo', schema: { type: 'object' }, run: async () => 'ok' });
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'x' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', limits: { maxIters: 3 }, tools: reg.wireFormat(),
      dispatch: (c, ctx) => reg.dispatch(c, ctx)
    });
    A.eq(res.reason, 'max_iters', 'max_iters bounds an always-tool-calling loop');
    A.eq(provider.callCount(), 3, 'exactly maxIters model calls');
  }

  // no dispatcher configured but a tool is requested -> typed error, still paired
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider({ turns: [[ { type: 'tool_start', index: 0, id: 'c9', name: 'echo' }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' } ]] });
    const messages = [{ role: 'user', content: 'x' }];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model' });
    A.eq(res.reason, 'error', 'tool requested with no dispatcher -> error');
    A.ok(seq.find(e => e.name === 'agent.run.error') !== undefined, 'run.error emitted');
    A.eq(messages[messages.length - 1].role, 'tool', 'a tool result is still appended (pairing held)');
  }

  A.report('tools.test');
})();
