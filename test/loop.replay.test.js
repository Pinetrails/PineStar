/* node test/loop.replay.test.js — the agentic loop driven by the replay provider (zero spend).
   Proves: exact event sequence, token count, single run.end, cost reconciliation,
   determinism (byte-identical across runs), and cancellation (pre + mid-stream). */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');

function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { bus, seq, emit };
}
const names = seq => seq.map(e => e.name);

function chatFixture() {
  return {
    models: [{ id: 'replay/model', context_length: 8000, pricing: { prompt: '0.000001', completion: '0.000002' }, supportsTools: true }],
    turns: [[
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo,' },
      { type: 'text', delta: ' Commander' },
      { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      { type: 'done', finishReason: 'stop' }
    ]]
  };
}

(async () => {
  // ---- happy path: exact sequence + cost + assistant message ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider(chatFixture());
    const cost = makeCostEngine({ priceOf: provider.priceOf });
    const messages = [{ role: 'user', content: 'hi' }];
    const res = await runAgentLoop({ messages, provider, emit, cost, model: 'replay/model', agentId: 'a', runId: 'r1' });

    A.eq(names(seq), ['agent.run.start', 'agent.token', 'agent.token', 'agent.token', 'cost.estimate', 'agent.cost', 'agent.run.end'], 'exact event sequence');
    A.eq(res.reason, 'done', 'loop ends done');
    A.eq(seq.filter(e => e.name === 'agent.token').length, 3, 'token count == fixture chunks');
    A.eq(seq.filter(e => e.name === 'agent.run.end').length, 1, 'run.end emitted exactly once');

    const c = seq.find(e => e.name === 'agent.cost').payload;
    A.eq(c.reconciled, true, 'agent.cost is reconciled');
    A.eq(c.tokensIn, 10, 'reconciled tokensIn');
    A.eq(c.tokensOut, 5, 'reconciled tokensOut');
    A.ok(Math.abs(c.usd - 20 / 1e6) < 1e-12, 'reconciled usd from catalog pricing');

    const last = messages[messages.length - 1];
    A.eq(last.role, 'assistant', 'assistant turn appended');
    A.eq(last.content, 'Hello, Commander', 'full streamed text assembled');
    A.eq(provider.callCount(), 1, 'exactly one model call');
  }

  // ---- determinism: byte-identical event stream across runs ----
  {
    const r1 = setup(); const p1 = makeReplayProvider(chatFixture());
    await runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], provider: p1, emit: r1.emit, cost: makeCostEngine({ priceOf: p1.priceOf }), model: 'replay/model' });
    const r2 = setup(); const p2 = makeReplayProvider(chatFixture());
    await runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], provider: p2, emit: r2.emit, cost: makeCostEngine({ priceOf: p2.priceOf }), model: 'replay/model' });
    A.eq(JSON.stringify(r1.seq), JSON.stringify(r2.seq), 'same fixture + inputs -> byte-identical event stream');
  }

  // ---- pre-aborted signal: no model call, no tokens ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider(chatFixture());
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', signal: { aborted: true } });
    A.eq(res.reason, 'cancelled', 'pre-aborted -> cancelled');
    A.eq(names(seq), ['agent.run.start', 'agent.run.end'], 'no tokens when pre-aborted');
    A.eq(provider.callCount(), 0, 'no model call when pre-aborted');
  }

  // ---- mid-stream cancel: partial tokens + partial assistant text, no cost ----
  {
    const { bus, seq, emit } = setup();
    const provider = makeReplayProvider(chatFixture());
    const signal = { aborted: false };
    let n = 0;
    bus.on('agent.token', () => { if (++n === 2) signal.aborted = true; });
    const messages = [{ role: 'user', content: 'hi' }];
    const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', signal });
    A.eq(res.reason, 'cancelled', 'mid-stream abort -> cancelled');
    A.eq(seq.filter(e => e.name === 'agent.token').length, 2, 'exactly 2 tokens before cancel');
    A.ok(seq.find(e => e.name === 'agent.cost') === undefined, 'no cost emitted on mid-stream cancel');
    A.eq(messages[messages.length - 1].content, 'Hello,', 'partial assistant text appended');
    A.eq(names(seq)[names(seq).length - 1], 'agent.run.end', 'ends with run.end');
  }

  // ---- no usage event: cost.estimate skipped, agent.cost still emitted with zeros ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider({ turns: [[{ type: 'text', delta: 'hi' }, { type: 'done', finishReason: 'stop' }]] });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model' });
    A.eq(res.reason, 'done', 'ends done without usage');
    A.ok(seq.find(e => e.name === 'cost.estimate') === undefined, 'no cost.estimate without a usage event');
    A.eq(seq.find(e => e.name === 'agent.cost').payload.tokensIn, 0, 'agent.cost zeros without usage');
  }

  A.report('loop.replay.test');
})();
