/* node test/eval-comparison.test.js — frozen v0.9 contract, fault/parity gates, and receipt truth. */
'use strict';
const A = require('./_assert.js');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

(async () => {
  const root = resolve(__dirname, '..');
  const core = await import('../scripts/eval/core.mjs');
  const cmp = await import('../scripts/eval/comparison.mjs');
  const contract = JSON.parse(readFileSync(join(root, 'scripts/eval/contracts/v0.9.0.json'), 'utf8'));
  const claims = JSON.parse(readFileSync(join(root, 'qa/product-perfect/claims.json'), 'utf8'));
  const parityTasks = core.readJsonl(join(root, 'scripts/eval/packs/parity-v0.9.0.jsonl'));
  const faultTasks = core.readJsonl(join(root, 'scripts/eval/packs/fault-v0.9.0.jsonl'));

  const checked = cmp.validateComparisonContract(contract, claims);
  A.ok(checked.ok, 'the v0.9 contract classifies the live claims ledger without drift: ' + checked.errors.join('; '));
  A.eq(checked.summary, {
    claims: 37, classified: 37,
    byClassification: { required: 26, experimental: 2, excluded: 3, differentiator: 6 },
    contractSha256: checked.summary.contractSha256
  }, 'all 37 claim families have exactly one release treatment');
  A.ok(cmp.validateScenarioPack(parityTasks, { expectedCount: 32, categories: {
    'coding-file': 6, 'research-browser': 4, 'document-data': 4, 'memory-history': 4,
    orchestration: 6, 'routine-channel': 4, 'recovery-security': 4
  } }).ok, 'the shared workload pack is frozen at 32 scenarios in the declared category split');
  A.ok(cmp.validateScenarioPack(faultTasks, { expectedCount: 10, categories: { 'run-boundary': 10 } }).ok,
    'the crash gauntlet freezes all ten run boundaries as active critical scenarios');

  const hash = 'a'.repeat(64);
  const trajectory = (task, fault) => ({
    schemaVersion: core.TRAJECTORY_SCHEMA, taskId: task.id, runId: 'run-' + task.id,
    startedAt: '2026-08-02T12:00:00.000Z', endedAt: '2026-08-02T12:00:00.200Z', finalText: 'done',
    events: [{ seq: 1, at: '2026-08-02T12:00:00.000Z', type: 'agent.run.start', data: {} },
      { seq: 2, at: '2026-08-02T12:00:00.200Z', type: 'agent.run.end', data: { reason: 'done' } }],
    artifacts: [{ path: 'output.bin', sha256: hash, mutatedAt: '2026-08-02T12:00:00.100Z', verifiedSha256: hash, verifiedAt: '2026-08-02T12:00:00.150Z' }],
    outcome: { passed: true, violations: { falseDone: 0, wrongDestination: 0, duplicateMutation: 0, authorityEscape: 0 } },
    routing: { requestedAgentId: 'agent', observedAgentId: 'agent', requestedSessionId: 'session', observedSessionId: 'session', requestedDestination: 'chat:1', deliveredDestination: 'chat:1' },
    fault: fault ? { injectedAt: task.id, expectedRecovery: 'review-or-resume', observedRecovery: 'review-or-resume', ambiguous: false } : undefined
  });
  const parityRows = parityTasks.map(task => trajectory(task, false));
  const parity = cmp.compareHarnesses({ tasks: parityTasks, starnetRows: parityRows, referenceRows: parityRows, contract });
  A.ok(parity.pass, 'a fully evidenced equal comparison passes all parity gates');
  A.eq(parity.summary.starnetPassRatePct, 100, 'StarNet pass rate is calculated from active scenarios');
  A.eq(parity.summary.violations, { falseDone: 0, wrongDestination: 0, duplicateMutation: 0, authorityEscape: 0 }, 'zero-tolerance events are counted explicitly');

  const unsafe = JSON.parse(JSON.stringify(parityRows));
  unsafe[0].outcome.violations.falseDone = 1;
  const refused = cmp.compareHarnesses({ tasks: parityTasks, starnetRows: unsafe, referenceRows: parityRows, contract });
  A.ok(!refused.pass && refused.checks.some(row => row.id === 'zero-falseDone' && !row.pass),
    'one false-done event fails the release comparison even when ordinary scoring is otherwise green');

  const faultRows = faultTasks.map(task => trajectory(task, true));
  const fault = cmp.evaluateFaultGauntlet({ tasks: faultTasks, candidateRows: faultRows });
  A.ok(fault.pass, 'all ten exact recovery outcomes produce a green fault receipt');
  const ambiguous = JSON.parse(JSON.stringify(faultRows));
  ambiguous[3].fault.ambiguous = true;
  A.ok(!cmp.evaluateFaultGauntlet({ tasks: faultTasks, candidateRows: ambiguous }).pass,
    'an ambiguous mutation boundary fails closed');

  const sourceReceipt = cmp.makeReceipt({ kind: 'parity', contract, subject: { commit: 'b'.repeat(40), sourceTree: { algorithm: 'git-tree', value: 'tree' } }, result: parity });
  A.ok(!sourceReceipt.candidateBound && sourceReceipt.limitations.some(x => /not installed-candidate proof/.test(x)),
    'a source-only receipt names its limitation instead of impersonating installed proof');
  const installedReceipt = cmp.makeReceipt({ kind: 'parity', contract, subject: {
    commit: 'b'.repeat(40), sourceTree: { algorithm: 'git-tree', value: 'tree' }, executable: { path: 'StarNet.exe', sha256: hash }
  }, result: parity });
  A.ok(installedReceipt.candidateBound, 'commit + source tree + executable hash binds a receipt to a candidate');

  const temp = mkdtempSync(join(tmpdir(), 'starnet-eval-wave-a-'));
  try {
    const starnetFile = join(temp, 'starnet.jsonl');
    const referenceFile = join(temp, 'reference.jsonl');
    const faultFile = join(temp, 'fault.jsonl');
    core.writeJsonl(starnetFile, parityRows); core.writeJsonl(referenceFile, parityRows); core.writeJsonl(faultFile, faultRows);
    const contractCli = spawnSync(process.execPath, ['scripts/eval/runner.mjs', 'contract'], { cwd: root, encoding: 'utf8' });
    A.eq(contractCli.status, 0, 'contract CLI exits zero');
    A.ok(/CONTRACT PASS claims=37 classified=37/.test(contractCli.stdout), 'contract CLI prints a compact frozen-scope receipt');
    const compareCli = spawnSync(process.execPath, ['scripts/eval/runner.mjs', 'compare', '--starnet', starnetFile, '--reference', referenceFile, '--receipt', join(temp, 'parity.json')], { cwd: root, encoding: 'utf8' });
    A.eq(compareCli.status, 0, 'parity CLI exits zero for passing evidence');
    A.ok(/PARITY PASS StarNet=100.0%/.test(compareCli.stdout), 'parity CLI prints the scored comparison');
    const faultCli = spawnSync(process.execPath, ['scripts/eval/runner.mjs', 'fault', '--candidate', faultFile, '--receipt', join(temp, 'fault.json')], { cwd: root, encoding: 'utf8' });
    A.eq(faultCli.status, 0, 'fault CLI exits zero for all ten boundaries');
    A.ok(/FAULT PASS passed=10\/10/.test(faultCli.stdout), 'fault CLI prints the boundary count');
  } finally { rmSync(temp, { recursive: true, force: true }); }

  A.report('eval-comparison.test');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
