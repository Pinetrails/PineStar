/* node test/credrotate.test.js — credential rotation through the REAL agent loop (P0.2 integration).
   Drives runAgentLoop with a primary provider that throws a 429 (rate_limit) and a fallback entry on a fresh
   key that succeeds. Proves the headline daily-driver behavior: a rate-limited key does NOT stall the agent —
   the loop rotates to the next key, the run completes, the failed key is reported to onFallback and cooled in
   credpool so it isn't tried first next run. No real keys / no network. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCredPool } = require('../sidecar/credpool.js');
const { makeCostEngine } = require('../sidecar/cost.js');

function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { seq, emit };
}

// a provider whose stream immediately throws a 429 — the "exhausted / rate-limited key".
function rateLimitedProvider() {
  return { async *stream() { throw Object.assign(new Error('429 Too Many Requests'), { status: 429 }); } };
}
// a provider that streams a normal reply — the "fresh key".
function okProvider(text) {
  return { async *stream() {
    yield { type: 'text', delta: text };
    yield { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
    yield { type: 'done', finishReason: 'stop' };
  } };
}

(async () => {
  // ---- rotation recovers the run + cools the failed key ----
  {
    const { seq, emit } = setup();
    const calls = [];
    const credPool = makeCredPool({ clock: { now: () => 1000 } });
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }], emit, model: 'replay/model', agentId: 'a', runId: 'rot',
      provider: rateLimitedProvider(),
      credKey: 'KEYA',
      fallbacks: [{ provider: okProvider('rotated reply'), model: 'replay/model', credKey: 'KEYB' }],
      onFallback: (info) => { calls.push(info); if (info.rotate && info.credKey) credPool.penalize(info.credKey); }
    });

    A.eq(res.reason, 'done', 'run recovers by rotating to the fresh key (not stalled)');
    A.eq(calls.length, 1, 'onFallback fired once');
    A.eq(calls[0].rotate, true, 'rotate flagged (rate_limit is a shouldRotateCredential reason)');
    A.eq(calls[0].credKey, 'KEYA', 'the OUTGOING (failed) key A is reported, not the new one');
    A.eq(credPool.order(['KEYA', 'KEYB']), ['KEYB', 'KEYA'], 'failed key A is now cooled to the back of the order');
    const assistant = res.messages.filter(m => m.role === 'assistant').pop();
    A.ok(assistant && String(assistant.content).indexOf('rotated reply') !== -1, 'assistant carries the fresh-key reply');
    A.eq(seq.filter(e => e.name === 'agent.run.end').length, 1, 'exactly one run.end despite the rotation');
    // P3.1 telemetry: the failover is observable on the bus, not just implied by the switched agent.cost.model
    const fb = seq.filter(e => e.name === 'provider.fallback');
    A.eq(fb.length, 1, 'a provider.fallback telemetry event is emitted on rotation');
    A.eq(fb[0].payload.reason, 'rate_limit', 'fallback event carries the classified reason');
    A.eq(fb[0].payload.rotate, true, 'fallback event flags it as a credential rotation');
  }

  // ---- exhausted pool: primary + the only fallback both rate-limit -> honest error, no infinite spin ----
  {
    const { emit } = setup();
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }], emit, model: 'replay/model', agentId: 'a', runId: 'rot2',
      provider: rateLimitedProvider(),
      credKey: 'KEYA',
      fallbacks: [{ provider: rateLimitedProvider(), model: 'replay/model', credKey: 'KEYB' }]
    });
    A.eq(res.reason, 'error', 'all keys exhausted -> a clean error, bounded (no spin)');
  }

  // ---- no hook / no credKey -> the loop behaves exactly as before (byte-identical contract) ----
  {
    const { seq, emit } = setup();
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }], emit, model: 'replay/model', agentId: 'a', runId: 'plain',
      provider: okProvider('plain reply')
    });
    A.eq(res.reason, 'done', 'single-provider run unaffected by the rotation additions');
    A.eq(seq.filter(e => e.name === 'agent.run.end').length, 1, 'one run.end');
  }

  // ---- cross-provider failover prices subsequent turns by the NEW provider's cost engine (P3.1) ----
  {
    const { seq, emit } = setup();
    const primaryCost = makeCostEngine({ priceOf: () => ({ in: 0, out: 0 }) });           // primary: free
    const fbCost = makeCostEngine({ priceOf: () => ({ in: 1000, out: 1000 }) });          // fallback provider: priced (per-million)
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }], emit, model: 'provA/model', agentId: 'a', runId: 'xprov',
      provider: rateLimitedProvider(), cost: primaryCost,
      fallbacks: [{ provider: okProvider('done'), model: 'provB/model', cost: fbCost, credKey: 'B' }]
    });
    A.eq(res.reason, 'done', 'cross-provider failover completes');
    const cost = seq.filter(e => e.name === 'agent.cost').pop();
    A.ok(cost && cost.payload.usd > 0, 'spend is priced by the FALLBACK provider cost engine, not the free primary');
    A.eq(cost.payload.model, 'provB/model', 'the reconciled cost carries the switched-to model');
    const fb = seq.filter(e => e.name === 'provider.fallback').pop();
    A.eq(fb.payload.toModel, 'provB/model', 'telemetry records the cross-provider target model');
  }

  A.report('credrotate.test');
})();
