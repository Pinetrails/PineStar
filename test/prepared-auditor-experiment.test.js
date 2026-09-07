'use strict';
const A = require('./_assert.js');
const M = require('../sidecar/prepared-auditor-experiment.js');

A.eq(M.assertPreparedPlan(), true, 'prepared plan satisfies its fail-closed contract');
A.ok(M.PLAN.executionAuthorized === false && typeof M.execute === 'function', 'prepared digest remains non-authorizing while the separately gated executor is available');
A.eq(M.PLAN.connectTimeoutMs, 240000, 'prepared measurement uses the Ollama operational ceiling');
A.eq(M.PLAN.preHeaderRetries + M.PLAN.retries, 0, 'prepared measurement has no provider or experiment retry');
A.ok(M.PLAN.provider === 'ollama' && M.PLAN.maximumCostUsd === 0, 'prepared measurement is local and zero external cost');
A.ok(M.PLAN.fallbackModels.length + M.PLAN.fallbackProviders.length === 0, 'prepared measurement cannot substitute provider or model');
A.ok(M.PLAN.planId !== 'auditor-matched-local-v1' && M.PLAN.planId !== 'auditor-matched-local-replacement-v1', 'prepared plan does not reuse a consumed plan identity');
A.ok(!/pine-star\.auditor-measurement-receipt\.json$/.test(M.PLAN.receiptFile), 'prepared plan reserves a distinct receipt identity');
const sequence = M.preparedSequence();
A.eq(sequence.filter((row) => row.kind === 'prewarm').length, 2, 'one prewarm is declared per arm');
A.ok(sequence.filter((row) => row.kind === 'prewarm').every((row) => row.evidence === false), 'prewarms are explicitly non-evidence');
A.eq(sequence.filter((row) => row.kind === 'release' && row.evidence === false).length, 2, 'each arm is released without creating evidence');
A.eq(sequence.filter((row) => row.kind === 'measurement').length, 6, 'exactly six measured runs are declared');
A.ok(sequence.slice(0, 5).every((row) => row.arm === 'champion') && sequence.slice(5).every((row) => row.arm === 'challenger'), 'one-arm-at-a-time order avoids unnecessary model swapping');
for (const task of M.PLAN.tasks) {
  const pair = sequence.filter((row) => row.kind === 'measurement' && row.taskId === task.id);
  A.eq(pair.length, 2, task.id + ' has exactly one run per arm');
  A.eq(new Set(pair.map((row) => row.file)).size, 1, task.id + ' names identical immutable input source');
  A.eq(new Set(pair.map(() => M.instruction(task, 'same-input-hash'))).size, 1, task.id + ' uses an identical instruction for both arms');
}
(async () => {
  const input = { planId: M.PLAN.planId, planDigest: M.PLAN_DIGEST, authorityChangeId: 'PS-2026-069', provider: 'ollama', maximumCostUsd: 0, connectTimeoutMs: 240000, preHeaderRetries: 0, retries: 0, recurrence: false, roleId: M.PLAN.roleId, championConfigurationId: M.PLAN.champion.configurationId, challengerConfigurationId: M.PLAN.challenger.configurationId };
  A.eq(M.validateAuthorization(input), true, 'exact Commander authorization is accepted');
  for (const patch of [{ planDigest: 'x' }, { authorityChangeId: 'PS-2026-068' }, { connectTimeoutMs: 240001 }, { preHeaderRetries: 1 }, { retries: 1 }, { maximumCostUsd: 1 }, { challengerConfigurationId: 'other' }]) {
    let refused = false; try { M.validateAuthorization(Object.assign({}, input, patch)); } catch (_) { refused = true; }
    A.ok(refused, 'authorization expansion is refused');
  }
  const bytesByTask = new Map(M.PLAN.tasks.map((task) => [task.id, Buffer.from(task.id === 'runtime-roster-audit' ? JSON.stringify({ agents: [], configurationAudit: [] }) : '[]')]));
  const calls = [], settled = [], prewarms = [], releases = [];
  const deps = {
    halted: () => false, rosterChanged: () => false,
    snapshot: async (task) => ({ bytes: bytesByTask.get(task.id), hash: M.sha(bytesByTask.get(task.id)), path: task.file }),
    prewarm: async (spec) => { prewarms.push(spec); return spec; }, release: async (spec) => { releases.push(spec); return spec; },
    run: async (spec) => { calls.push(spec); return { runId: 'r' + calls.length, modelText: JSON.stringify(M.expected(spec.task.id, spec.snapshot.bytes)), reason: 'done' }; },
    settle: async (row) => { settled.push(row); return row; }
  };
  const preflight = await M.preflight(deps, input);
  A.ok(preflight.modelRuns === 0 && preflight.prewarms === 0 && preflight.measurements === 0 && preflight.tasks.length === 3, 'preflight proves parity without inference or evidence');
  const out = await M.execute(deps, input);
  A.eq(out.runs.length, 6, 'executor produces exactly six measured runs');
  A.eq(prewarms.length, 2, 'executor prewarms exactly once per arm');
  A.eq(releases.length, 2, 'executor releases exactly once per arm');
  A.ok(prewarms.every((row) => row.evidence === false) && releases.every((row) => row.evidence === false), 'prewarm and release remain non-evidence');
  A.ok(settled.every((row) => row.agreement), 'mechanical agreement is independently checked');
  A.eq(new Set(calls.map((row) => row.task.id + ':' + row.snapshot.hash + ':' + row.instructionHash)).size, 3, 'matched pairs preserve input and instruction hash parity');
  let halted = false; try { await M.execute(Object.assign({}, deps, { halted: () => true }), input); } catch (_) { halted = true; }
  A.ok(halted, 'E-stop fails closed before execution');
  A.report('prepared-auditor-experiment.test');
})().catch((error) => { console.error(error); process.exitCode = 1; });
