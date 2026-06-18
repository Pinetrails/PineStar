/* node test/orchestration.test.js — team.dispatch (Stage 2 lead->worker delegation). Drives the tool against
   a FAKE runOnce (no live key, no network): verifies it spawns one child run per worker with the worker's
   identity, threads the parent signal + per-worker cost cap, forwards ONLY lifecycle/cost to the lead bus,
   rejects self/unknown targets without a run, null-guards a refused child, and is capability-gated. */
'use strict';
const A = require('./_assert.js');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');

// a fake run host that records every child runOnce call and returns a configurable result.
function fakeRunOnce(impl) {
  const calls = [];
  const fn = async (o) => { calls.push(o); return impl ? impl(o) : { reason: 'done', messages: [{ role: 'assistant', content: 'out:' + o.agentId }], usd: 0.2 }; };
  fn.calls = calls;
  return fn;
}
const counter = () => { let n = 0; return () => 'child_' + (++n); };

(async () => {

// ---- sequential dispatch to two workers: identity, signal, cost cap, aggregated result ----
{
  const ro = fakeRunOnce();
  const roster = new Map([
    ['researcher', { system: 'R-SYS', name: 'RESEARCHER', model: 'm1' }],
    ['analyst', { system: 'A-SYS', name: 'ANALYST', model: null }]
  ]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'lead-model', perWorker: 1, newId: counter() });
  const signal = { aborted: false };
  const emitted = [];
  const ctx = { agentId: 'agent', signal, emit: (name, p) => emitted.push({ name, p }) };
  const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'find X' }, { agentId: 'analyst', prompt: 'analyze Y' }] }, ctx);

  A.eq(ro.calls.length, 2, 'two child runs dispatched (one per worker)');
  A.eq(ro.calls[0].agentId, 'researcher', 'first child is the researcher');
  A.eq(ro.calls[0].system, 'R-SYS', "child runs with the worker's composed system prompt");
  A.eq(ro.calls[0].model, 'm1', 'child uses the worker model when set');
  A.eq(ro.calls[1].model, 'lead-model', 'child falls back to the lead model when the worker has none');
  A.ok(ro.calls[0].signal === signal, 'the parent signal is threaded into the child (abort propagation)');
  A.eq(ro.calls[0].maxCostUsd, 1, 'per-worker cost cap is passed to the child');
  A.eq(ro.calls[0].surface, 'autonomous', 'workers run headless (no consent prompts)');
  A.eq(ro.calls[0].isTask, true, 'worker run is a task (tool-capable)');
  A.ok(ro.calls[0].runId && ro.calls[0].runId !== ro.calls[1].runId, 'each child gets a distinct runId');

  const parsed = JSON.parse(out.content);
  A.eq(parsed.length, 2, 'aggregated result carries both workers');
  A.eq(parsed[0].agentId, 'researcher', 'result carries the worker agentId');
  A.eq(parsed[0].result, 'out:researcher', "result carries the worker's final assistant text");
  A.eq(parsed[0].reason, 'done', 'result carries the run reason');
  A.ok(Math.abs(parsed[0].usd - 0.2) < 1e-9, 'result carries the worker spend');
}

// ---- child emit forwarding: ONLY lifecycle/cost reach the lead bus (no token/COMMS pollution) ----
{
  const ro = fakeRunOnce(async (o) => {
    o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'directive', model: 'm' });
    o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'secret thinking' });
    o.emit('agent.cost', { agentId: o.agentId, runId: o.runId, usd: 0.1, model: 'm', reconciled: true });
    o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0.1 });
    return { reason: 'done', messages: [{ role: 'assistant', content: 'r' }], usd: 0.1 };
  });
  const roster = new Map([['researcher', { system: 'R' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  const emitted = [];
  await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }] }, { agentId: 'agent', emit: (n, p) => emitted.push(n) });
  A.ok(emitted.indexOf('agent.run.start') >= 0 && emitted.indexOf('agent.run.end') >= 0, 'child lifecycle forwarded to the lead bus (drives the floor animation)');
  A.ok(emitted.indexOf('agent.cost') >= 0, 'child cost forwarded (honest lifetime total)');
  A.ok(emitted.indexOf('agent.token') < 0, "child tokens are NOT forwarded (no pollution of the lead's COMMS)");
}

// ---- self / unknown targets are rejected WITHOUT a run ----
{
  const ro = fakeRunOnce();
  const roster = new Map([['researcher', { system: 'R' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  const out = await dispatchTool.run({ workers: [{ agentId: 'agent', prompt: 'x' }, { agentId: 'ghost', prompt: 'y' }] }, { agentId: 'agent', emit: () => {} });
  A.eq(ro.calls.length, 0, 'no runOnce fired for a self/unknown target');
  const parsed = JSON.parse(out.content);
  A.eq(parsed[0].reason, 'error', 'self-delegation is an error');
  A.ok(/yourself/.test(parsed[0].result), 'self rejection explains why');
  A.eq(parsed[1].reason, 'error', 'unknown worker is an error');
  A.ok(/no such live worker/.test(parsed[1].result), 'unknown rejection points at the roster');
}

// ---- a child that could not start (runOnce -> undefined) is reported, not a crash ----
{
  const ro = fakeRunOnce(async () => undefined);   // mirrors a concurrency refusal / up-front error
  const roster = new Map([['researcher', { system: 'R' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }] }, { agentId: 'agent', emit: () => {} });
  const parsed = JSON.parse(out.content);
  A.eq(parsed[0].reason, 'refused', 'a child that could not start is reported as refused (null-guarded)');
  A.ok(/concurrency cap/.test(parsed[0].result), 'the refusal explains the likely cause');
}

// ---- parallel mode dispatches all workers ----
{
  const ro = fakeRunOnce(async () => { await Promise.resolve(); return { reason: 'done', messages: [{ role: 'assistant', content: 'r' }], usd: 0 }; });
  const roster = new Map([['a', {}], ['b', {}]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  const out = await dispatchTool.run({ workers: [{ agentId: 'a', prompt: '1' }, { agentId: 'b', prompt: '2' }], parallel: true }, { agentId: 'lead', emit: () => {} });
  A.eq(ro.calls.length, 2, 'parallel dispatches both workers');
  A.eq(JSON.parse(out.content).length, 2, 'parallel returns both results');
}

// ---- capability gate: team.dispatch is denied without the orchestrator grant, runs with it ----
{
  const ro = fakeRunOnce();
  const roster = new Map([['researcher', { system: 'R' }]]);
  const reg = makeRegistry();
  makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() }).register(reg);

  const denyCtx = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: [], approvalRules: {} }, { emit: () => {} });
  const r1 = await reg.dispatch({ name: 'team.dispatch', args: { workers: [{ agentId: 'researcher', prompt: 'x' }] } }, denyCtx);
  A.ok(r1.isError && /capability denied/.test(r1.content), 'team.dispatch denied without the orchestrator object');
  A.eq(ro.calls.length, 0, 'a denied dispatch never reaches runOnce');

  const allowCtx = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: ['team.dispatch'], approvalRules: {} }, { emit: () => {} });
  const r2 = await reg.dispatch({ name: 'team.dispatch', args: { workers: [{ agentId: 'researcher', prompt: 'x' }] } }, allowCtx);
  A.ok(!r2.isError, 'team.dispatch runs when the orchestrator object is present');
  A.eq(ro.calls.length, 1, 'a granted dispatch reaches runOnce');
}

A.report('orchestration.test');

})();
