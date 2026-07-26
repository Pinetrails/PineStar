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

    // TOOL-TIMEOUT ABORTS THE WORK: the dispatch threads a per-call AbortController into ctx.signal; on timeout it
    // aborts BEFORE rejecting, so a signal-honoring tool can stop running/spending instead of continuing forever.
    {
      let sawSignal = false, abortedAfterTimeout = false;
      reg.register({
        name: 'observes_signal', timeoutMs: 20, schema: { type: 'object' },
        run: (args, ctx) => new Promise((resolve) => {
          sawSignal = !!(ctx && ctx.signal);
          if (ctx && ctx.signal) ctx.signal.addEventListener('abort', () => { abortedAfterTimeout = true; resolve('late'); }, { once: true });
        })
      });
      const ot = await reg.dispatch(call('observes_signal', {}), {});
      A.eq(ot.summary, 'timeout', 'a signal-observing tool still times out');
      A.ok(sawSignal, 'the dispatched tool received a ctx.signal (per-call AbortController)');
      A.ok(abortedAfterTimeout, 'ctx.signal was ABORTED on timeout so the tool can stop its work');
    }

    // parent-signal chaining: aborting the RUN's signal aborts the per-call child signal too (cancel propagates).
    {
      const parent = new AbortController();
      let childAborted = false;
      reg.register({
        name: 'watches_parent', timeoutMs: 0, schema: { type: 'object' },
        run: (args, ctx) => new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => { childAborted = true; resolve('cancelled'); }, { once: true });
        })
      });
      const p = reg.dispatch(call('watches_parent', {}), { signal: parent.signal });
      parent.abort();
      await p;
      A.ok(childAborted, 'aborting the parent run signal aborts the per-call child signal (cancel propagates to the tool)');
    }

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
      model: 'replay/model', limits: { maxIters: 3, grace: false }, tools: reg.wireFormat(),
      dispatch: (c, ctx) => reg.dispatch(c, ctx)
    });
    A.eq(res.reason, 'max_iters', 'max_iters bounds an always-tool-calling loop');
    A.eq(provider.callCount(), 3, 'exactly maxIters model calls (grace:false -> raw cap)');
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

  /* CENTRAL OUTPUT CAP. Every builtin clamps itself, so the protection was a convention a NEW tool inherited
     nothing from — one unbounded result blows the context window and ends the run. This pins the backstop at
     the single seam every result passes through. */
  {
    const { makeRegistry } = require('../sidecar/tools/registry.js');
    const reg = makeRegistry();
    const HUGE = 'x'.repeat(500000);
    reg.register({
      name: 'flood', capability: 'compute', scope: 'read', requiresConsent: false,
      description: 'returns far too much', schema: { type: 'object', properties: {} },
      run: async () => ({ content: HUGE, summary: 'ok' })
    });
    reg.register({
      name: 'polite', capability: 'compute', scope: 'read', requiresConsent: false,
      description: 'returns a sane amount', schema: { type: 'object', properties: {} },
      run: async () => ({ content: 'short and useful', summary: 'ok' })
    });
    const ctx = { timeoutMs: 5000 };

    const big = await reg.dispatch({ id: 'c1', name: 'flood', args: {} }, ctx);
    A.ok(big.ok, 'an over-long result is still a SUCCESS — capping is not failing');
    A.ok(big.content.length < HUGE.length, 'the unbounded result was capped');
    A.ok(big.content.length <= 81000, 'capped to the host limit, not merely trimmed');
    A.ok(/output cap/.test(big.content), 'the model is told the host cut it, not left to wonder');
    A.ok(/narrow it|filter, page/.test(big.content), 'the note names a NEXT ACTION so the model does not just retry the same call');

    // Head AND tail: the answer in command output usually lives at the end.
    reg.register({
      name: 'trace', capability: 'compute', scope: 'read', requiresConsent: false,
      description: 'head and tail matter', schema: { type: 'object', properties: {} },
      run: async () => ({ content: 'FIRSTLINE\n' + 'p'.repeat(300000) + '\nEXIT CODE 1', summary: 'ok' })
    });
    const t = await reg.dispatch({ id: 'c2', name: 'trace', args: {} }, ctx);
    A.ok(t.content.indexOf('FIRSTLINE') >= 0, 'the head survives');
    A.ok(t.content.indexOf('EXIT CODE 1') >= 0, 'and so does the TAIL — a head-only cut hides the answer');

    // The common case must be untouched, and the cap must sit ABOVE the per-tool clamps so a result that
    // already carries its own honest "truncated" note is never re-cut.
    const small = await reg.dispatch({ id: 'c3', name: 'polite', args: {} }, ctx);
    A.eq(small.content, 'short and useful', 'ordinary output passes through byte-identical');

    // An error result is capped too — a stack trace or an API error body can be just as large.
    reg.register({
      name: 'blowup', capability: 'compute', scope: 'read', requiresConsent: false,
      description: 'throws hugely', schema: { type: 'object', properties: {} },
      run: async () => { throw new Error('E'.repeat(400000)); }
    });
    const boom = await reg.dispatch({ id: 'c4', name: 'blowup', args: {} }, ctx);
    A.ok(boom.isError, 'a throw is still an error result');
    A.ok(boom.content.length <= 81000, 'a huge error message is capped on the same path');
  }

  A.report('tools.test');
})();
