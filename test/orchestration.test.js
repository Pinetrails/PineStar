/* node test/orchestration.test.js — team.dispatch (Stage 2 lead->worker delegation). Drives the tool against
   a FAKE runOnce (no live key, no network): verifies it spawns one child run per worker with the worker's
   identity, threads the parent signal + per-worker cost cap, forwards ONLY lifecycle/cost to the lead bus,
   rejects self/unknown targets without a run, null-guards a refused child, and is capability-gated. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
const { makeSubagentManager } = require('../sidecar/subagents.js');
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
const tick = () => new Promise(resolve => setImmediate(resolve));

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
  const leadBroker = { _isLeadConsent: true };   // stand-in for the lead's consent broker (ctx.consent)
  const ctx = { agentId: 'agent', signal, emit: (name, p) => emitted.push({ name, p }), consent: leadBroker };
  const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'find X' }, { agentId: 'analyst', prompt: 'analyze Y' }] }, ctx);

  A.eq(ro.calls.length, 2, 'two child runs dispatched (one per worker)');
  A.eq(ro.calls[0].agentId, 'researcher', 'first child is the researcher');
  A.eq(ro.calls[0].system, 'R-SYS', "child runs with the worker's composed system prompt");
  A.eq(ro.calls[0].model, 'm1', 'child uses the worker model when set');
  A.eq(ro.calls[1].model, 'lead-model', 'child falls back to the lead model when the worker has none');
  A.ok(ro.calls[0].signal === signal, 'the parent signal is threaded into the child (abort propagation)');
  A.eq(ro.calls[0].maxCostUsd, 1, 'per-worker cost cap is passed to the child');
  A.eq(ro.calls[0].surface, 'autonomous', 'workers run headless on the autonomous office baseline');
  // SAME ACCESS AS THE ORCHESTRATOR: a worker shares the lead's consent broker (its APPROVAL posture + grants)
  // and is handed the WORKBENCH, so shell/writes are available and gated by the lead's approvals — not auto-denied.
  A.ok(ro.calls[0].consent === leadBroker, "worker shares the lead's consent broker (same access as the orchestrator)");
  A.ok(Array.isArray(ro.calls[0].extraObjects) && ro.calls[0].extraObjects.some(o => o.objectType === 'workbench'), 'worker is equipped with the workbench (terminal) on top of the office');
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
// ---- background mode returns durable handles immediately and records watch events/results ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-orch-bg-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'subagents.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const ro = fakeRunOnce(async (o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'directive', model: 'm' });
      return { reason: 'done', messages: [{ role: 'assistant', content: 'bg:' + o.agentId }], usd: 0.3 };
    });
    const roster = new Map([['researcher', { system: 'R' }]]);
    const { dispatchTool, subagentsTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), subagents });
    const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }], background: true }, { agentId: 'lead', emit: () => {} });
    const handle = JSON.parse(out.content)[0];
    A.ok(handle.id && handle.status === 'running', 'background dispatch returns a running durable handle immediately');
    await tick(); await tick();
    const rec = subagents.get(handle.id);
    A.eq(rec.status, 'done', 'background worker completes into the durable record');
    A.eq(rec.result, 'bg:researcher', 'background worker stores final text');
    A.ok(rec.events.some(e => e.name === 'agent.run.start'), 'background worker stores watchable lifecycle events');
    const listed = await subagentsTool.run({}, { agentId: 'lead' });
    A.eq(JSON.parse(listed.content).length, 1, 'team.subagents lists this lead\'s durable workers');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---- background interrupt aborts the worker signal and marks the record resumable ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-orch-cut-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'subagents.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    let childSignal = null;
    const ro = fakeRunOnce(async (o) => {
      childSignal = o.signal;
      return new Promise(() => {});
    });
    const roster = new Map([['researcher', { system: 'R' }]]);
    const { dispatchTool, interruptTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), subagents });
    const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }], background: true }, { agentId: 'lead', emit: () => {} });
    const handle = JSON.parse(out.content)[0];
    await tick();
    const cut = await interruptTool.run({ id: handle.id }, { agentId: 'lead' });
    A.ok(/interrupted/.test(cut.summary), 'team.interrupt reports interrupted');
    A.ok(childSignal && childSignal.aborted, 'team.interrupt aborts the child run signal');
    A.eq(subagents.get(handle.id).status, 'interrupted', 'team.interrupt marks the durable record interrupted');
    A.eq(subagents.get(handle.id).canResume, true, 'interrupted background worker can be resumed');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
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

// ---- dispatch carries its OWN long timeout, never the 30s fast-tool default (regression: a real worker loop
//      runs for minutes; inheriting ctx.timeoutMs=30000 made team.dispatch always time out before returning) ----
{
  const ro = fakeRunOnce();
  const roster = new Map([['researcher', { system: 'R' }]]);
  // default: no dispatchTimeoutMs passed -> a generous built-in (minutes), far above the 30s fast-tool cap
  const def = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() }).dispatchTool;
  A.ok(typeof def.timeoutMs === 'number' && def.timeoutMs > 60000, 'team.dispatch carries its own multi-minute timeout, not the 30s fast-tool default');
  // the registry honors tool.timeoutMs OVER ctx.timeoutMs, so a 30s ctx can never clamp a dispatch
  A.ok(def.timeoutMs > 30000, 'dispatch timeout outlasts CAPS.toolTimeoutMs (30s) so a worker loop is never cut short');
  // an explicit override is honored (the host wires this from CRON_MAX_RUN_MS)
  const over = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), dispatchTimeoutMs: 123456 }).dispatchTool;
  A.eq(over.timeoutMs, 123456, 'deps.dispatchTimeoutMs overrides the dispatch wall-clock');
}

// ============================ team.summon (create a NEW worker live) ============================

// ---- the tool's shape: lead-gated, consent-gated, and outlasts the 120s browser-ack backstop ----
{
  const { summonTool } = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() });
  A.eq(summonTool.name, 'team.summon', 'tool is team.summon');
  A.eq(summonTool.capability, 'orchestrator', 'gated by the orchestrator object (lead-only, like team.dispatch)');
  A.eq(summonTool.scope, 'write', 'summon is a write-scope mutation');
  A.eq(summonTool.requiresConsent, true, 'summon IS consent-gated (the APPROVAL beat) — unlike team.dispatch');
  A.ok(typeof summonTool.timeoutMs === 'number' && summonTool.timeoutMs > 120000, 'tool wall-clock outlasts the 120s summon ack backstop (clean null, not a tool timeout)');
}

// ---- happy path: ctx.summon resolves a new id; the spec is forwarded; the result carries the id for dispatch ----
{
  const { summonTool } = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() });
  let gotSpec = null;
  const ctx = { agentId: 'agent', summon: async (s) => { gotSpec = s; return 'researcher-2'; } };
  const out = await summonTool.run({ name: 'Researcher', specId: 'researcher', purpose: 'find things' }, ctx);
  A.ok(gotSpec && gotSpec.name === 'Researcher' && gotSpec.specId === 'researcher', 'the spec (name + specId) is forwarded to ctx.summon');
  A.eq(gotSpec.purpose, 'find things', 'a custom purpose is forwarded');
  const parsed = JSON.parse(out.content);
  A.eq(parsed.agentId, 'researcher-2', 'the new agentId comes back for the lead to delegate to');
  A.ok(/team\.dispatch/.test(out.summary), 'the summary nudges the lead to delegate to the new worker');
}

// ---- declined / no browser: ctx.summon resolves null -> a clean "not completed", no crash ----
{
  const { summonTool } = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() });
  const out = await summonTool.run({ name: 'Ghost' }, { agentId: 'agent', summon: async () => null });
  A.eq(out.summary, 'declined', 'a null ack (decline/timeout/disconnect) reports declined');
  A.ok(/No agent was created/.test(out.content), 'declined summon says plainly that nothing was created');
}

// ---- headless / worker: no ctx.summon closure -> degrades to a clear "not available" (fails closed) ----
{
  const { summonTool } = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() });
  const out = await summonTool.run({ name: 'X' }, { agentId: 'worker' });   // no summon on ctx (autonomous run)
  A.eq(out.summary, 'unavailable', 'summon without a live station is unavailable, not a crash');
}

// ---- nothing to summon: neither name nor specId -> noop, never calls ctx.summon ----
{
  const { summonTool } = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() });
  let called = false;
  const out = await summonTool.run({ name: '   ' }, { agentId: 'agent', summon: async () => { called = true; return 'x'; } });
  A.eq(out.summary, 'noop', 'an empty spec is a noop');
  A.ok(!called, 'a noop never reaches ctx.summon');
}

// ---- capability gate: team.summon denied without the orchestrator grant, runs with it ----
{
  const reg = makeRegistry();
  makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() }).register(reg);
  let summoned = 0;
  const summon = async () => { summoned++; return 'researcher-2'; };

  const denyCtx = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: [], approvalRules: {} }, { emit: () => {}, summon });
  const r1 = await reg.dispatch({ name: 'team.summon', args: { name: 'R', specId: 'researcher' } }, denyCtx);
  A.ok(r1.isError && /capability denied/.test(r1.content), 'team.summon denied without the orchestrator object');
  A.eq(summoned, 0, 'a denied summon never reaches ctx.summon');

  const allowCtx = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: ['team.summon'], approvalRules: {} }, { emit: () => {}, summon });
  const r2 = await reg.dispatch({ name: 'team.summon', args: { name: 'R', specId: 'researcher' } }, allowCtx);
  A.ok(!r2.isError, 'team.summon runs when the orchestrator object is present');
  A.eq(summoned, 1, 'a granted summon reaches ctx.summon');
}

// ============================ team.spawn (ephemeral self-clone sub-agents / Meeseeks) ============================

// ---- spawns N ephemeral clones: clone identity (lead system+model), ephemeral non-roster id, flat depth, results,
//      and the Meeseeks visual feed (lifecycle forwarded + task{kind:'subagent'} emitted, tokens NOT forwarded) ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-spawn-'));
  try {
    const taskEvents = [];
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sub.json'), clock: { now: () => 1000 }, emit: (n, p) => { if (n === 'task') taskEvents.push(p); }, newId: counter() });
    const ro = fakeRunOnce(async (o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'directive', model: 'm' });
      o.emit('agent.token', { agentId: o.agentId, delta: 'secret' });
      return { reason: 'done', messages: [{ role: 'assistant', content: 'res:' + o.agentId }], usd: 0.4 };
    });
    const emitted = [];
    const leadBroker = { _isLeadConsent: true };
    const { spawnTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'lead-model', selfSystem: 'LEAD-SYS', perWorker: 2, newId: counter(), subagents });
    const ctx = { agentId: 'lead', emit: (n) => emitted.push(n), consent: leadBroker };
    const out = await spawnTool.run({ tasks: [{ prompt: 'sub A', label: 'alpha' }, { prompt: 'sub B' }] }, ctx);

    A.eq(ro.calls.length, 2, 'two ephemeral clones spawned (one per task)');
    A.eq(ro.calls[0].system, 'LEAD-SYS', "the clone runs with the LEAD's OWN base identity (clone of self)");
    A.eq(ro.calls[0].model, 'lead-model', 'the clone uses the lead model');
    A.ok(/^sub-/.test(ro.calls[0].agentId), 'the clone gets an anonymous ephemeral agentId (sub- prefix, not a roster id)');
    A.ok(ro.calls[0].agentId !== ro.calls[1].agentId && ro.calls[0].agentId !== 'lead', 'each clone is a distinct, non-lead id');
    A.eq(ro.calls[0].isTask, true, 'the clone run is a task (tool-capable)');
    A.eq(ro.calls[0].maxCostUsd, 2, 'per-worker cost cap is passed to the clone');
    A.ok(ro.calls[0].consent === leadBroker, 'the clone shares the lead consent broker (same approval posture)');
    A.ok(Array.isArray(ro.calls[0].extraObjects) && ro.calls[0].extraObjects.some(o => o.objectType === 'workbench'), 'the clone gets the workbench (terminal)');
    A.ok(!ro.calls[0].lead, 'FLAT DEPTH: the clone is NOT a lead (no orchestrator object) so it cannot re-spawn');
    A.eq(ro.calls[0].surface, 'autonomous', 'the clone runs headless on the autonomous baseline');

    const parsed = JSON.parse(out.content);
    A.eq(parsed.length, 2, 'both clone results returned');
    A.eq(parsed[0].label, 'alpha', 'a provided label is carried back');
    A.eq(parsed[1].label, 'subagent 2', 'an unlabelled task gets a default label');
    A.ok(/^res:sub-/.test(parsed[0].result), 'the clone final text is returned');
    A.eq(parsed[0].reason, 'done', 'the clone run reason is carried');

    A.ok(emitted.indexOf('agent.run.start') >= 0, 'clone lifecycle forwarded to the lead bus (floor materializes the Meeseeks)');
    A.ok(emitted.indexOf('agent.token') < 0, "clone tokens are NOT forwarded (no pollution of the lead's COMMS)");
    A.ok(taskEvents.some(e => e.kind === 'subagent'), 'a task{kind:subagent} record is emitted (the Meeseeks identity signal)');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
}

// ---- background mode returns durable handles immediately and completes into the record ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-spawn-bg-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sub.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const ro = fakeRunOnce(async (o) => ({ reason: 'done', messages: [{ role: 'assistant', content: 'bg:' + o.agentId }], usd: 0.1 }));
    const { spawnTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents });
    const out = await spawnTool.run({ tasks: [{ prompt: 'x' }], background: true }, { agentId: 'lead', emit: () => {} });
    const handle = JSON.parse(out.content)[0];
    A.ok(handle.id && handle.status === 'running', 'background spawn returns a running durable handle immediately');
    A.eq(handle.label, 'subagent 1', 'the handle carries the label');
    await tick(); await tick();
    A.eq(subagents.get(handle.id).status, 'done', 'the background clone completes into the durable record');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
}

// ---- guards: no subagent manager → unavailable (no run); empty tasks → noop ----
{
  const ro = fakeRunOnce();
  const { spawnTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter() });   // no subagents dep
  const out = await spawnTool.run({ tasks: [{ prompt: 'x' }] }, { agentId: 'lead', emit: () => {} });
  A.eq(out.summary, 'unavailable', 'team.spawn without a subagent manager is unavailable, not a crash');
  A.eq(ro.calls.length, 0, 'unavailable spawn never reaches runOnce');
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-spawn-noop-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sub.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const { spawnTool } = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents });
    const out = await spawnTool.run({ tasks: [] }, { agentId: 'lead', emit: () => {} });
    A.eq(out.summary, 'noop', 'empty tasks is a noop');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
}

// ---- capability gate: team.spawn is denied without the orchestrator grant, runs with it ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-spawn-cap-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sub.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const ro = fakeRunOnce();
    const reg = makeRegistry();
    makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents }).register(reg);
    const denyCtx = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: [], approvalRules: {} }, { emit: () => {} });
    const r1 = await reg.dispatch({ name: 'team.spawn', args: { tasks: [{ prompt: 'x' }] } }, denyCtx);
    A.ok(r1.isError && /capability denied/.test(r1.content), 'team.spawn denied without the orchestrator object');
    const allowCtx = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: ['team.spawn'], approvalRules: {} }, { emit: () => {} });
    const r2 = await reg.dispatch({ name: 'team.spawn', args: { tasks: [{ prompt: 'x' }] } }, allowCtx);
    A.ok(!r2.isError, 'team.spawn runs when the orchestrator object is present');
    await tick(); await tick();
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
}

A.report('orchestration.test');

})();
