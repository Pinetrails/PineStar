/* node test/agent-eval.test.js — deterministic task-quality evaluation foundation. */
'use strict';
const A = require('./_assert.js');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

(async () => {
  const core = await import('../scripts/eval/core.mjs');
  const root = resolve(__dirname, '..');
  const fixtures = join(root, 'scripts', 'eval', 'fixtures');
  const tasks = core.readJsonl(join(fixtures, 'tasks.jsonl'));
  const baseline = core.readJsonl(join(fixtures, 'baseline.jsonl'));
  const candidate = core.readJsonl(join(fixtures, 'candidate.jsonl'));

  const report = core.evaluate({ tasks, baselineRows: baseline, candidateRows: candidate });
  A.eq(report.summary, { pass: true, active: 8, passed: 8, failed: 0, pending: 0 }, 'seed pack passes existing behavior and all six bridge scenarios');
  A.eq(report.results[1].metrics, {
    turns: 1, toolCalls: 1, retries: 0, tokensIn: 20, tokensOut: 8, tokens: 28, costUsd: 0.000036, durationMs: 190,
    artifactHashes: [{ path: 'output.md', sha256: '0da6d1b1911c49b32fb845247367d08532316038e81c2b524de8b192818e1e9f' }], verificationFresh: true
  }, 'metrics include turns, tools, retries, tokens, cost, time, artifact identity, and verification freshness');

  const redacted = core.recordTrajectory({
    taskId: 'redaction-probe', finalText: 'used Bearer abc.def.ghi and sk-supersecret123456',
    rawEvents: [{ name: 'agent.cost', payload: { tokensIn: 12, apiKey: 'sk-rawsecret123456', nested: { refresh_token: 'rotate-me' }, path: 'C:\\Users\\andrew\\project' } }]
  });
  const redactedText = JSON.stringify(redacted);
  A.ok(!redactedText.includes('supersecret') && !redactedText.includes('rawsecret') && !redactedText.includes('rotate-me') && !redactedText.includes('andrew'), 'recording removes secret values and user-home identity');
  A.eq(redacted.events[0].data.tokensIn, 12, 'ordinary token accounting is preserved');
  A.eq(redacted.events[0].data.apiKey, '[REDACTED]', 'sensitive field is redacted');

  const { runBridgeAdapters } = await import('../scripts/eval/adapters/bridge.mjs');
  const liveBridge = await runBridgeAdapters();
  const recordedBridge = candidate.filter(row => row.taskId.startsWith('bridge-'));
  A.eq(liveBridge, recordedBridge, 'real module adapters reproduce the committed candidate evidence byte-for-byte');
  A.eq(liveBridge.map(row => row.taskId), ['bridge-continuation', 'bridge-recovery', 'bridge-code-mode', 'bridge-lsp-delta', 'bridge-full-history', 'bridge-cron-runtime'], 'every runtime bridge has a deterministic adapter');

  const broken = JSON.parse(JSON.stringify(candidate));
  broken[0].finalText = 'wrong answer';
  broken[0].events.splice(2, 0, { seq: 3, at: '2026-08-01T12:10:00.020Z', type: 'provider.retry', data: {} });
  const failed = core.evaluate({ tasks, baselineRows: baseline, candidateRows: broken });
  A.eq(failed.summary.pass, false, 'correctness and metric regressions produce a failing report');
  A.ok(failed.results[0].failures.some(x => x.includes('correctness')), 'correctness failure is named');
  A.ok(failed.results[0].failures.some(x => x.includes('retries')), 'retry regression is named');

  const contradictory = JSON.parse(JSON.stringify(candidate));
  const retryRow = contradictory.find(row => row.taskId === 'bridge-continuation');
  retryRow.events.push(...Array.from({ length: 50 }, (_, index) => ({
    seq: retryRow.events.length + index + 1,
    at: `2026-08-01T12:15:00.${String(index).padStart(3, '0')}Z`,
    type: 'provider.retry', data: {}
  })));
  retryRow.metrics = { retries: 0 };
  const contradicted = core.evaluate({ tasks, baselineRows: baseline, candidateRows: contradictory });
  const retryResult = contradicted.results.find(row => row.taskId === 'bridge-continuation');
  A.eq(retryResult.metrics.retries, 50, 'observed retry events override a contradictory lower summary metric');
  A.eq(retryResult.pass, false, 'a contradictory retry summary cannot false-green the trajectory');
  A.ok(retryResult.failures.some(x => x.includes('retries')), 'the observed retry regression is named');

  const temp = mkdtempSync(join(tmpdir(), 'starnet-agent-eval-'));
  try {
    const reportFile = join(temp, 'report.json');
    const cli = spawnSync(process.execPath, ['scripts/eval/runner.mjs', 'run', '--report', reportFile], { cwd: root, encoding: 'utf8' });
    A.eq(cli.status, 0, 'default CLI seed evaluation exits zero');
    A.ok(/PASS active=8/.test(cli.stdout), 'CLI prints a compact pass receipt');
    A.eq(JSON.parse(readFileSync(reportFile, 'utf8')).summary.pass, true, 'CLI writes the report');

    const rawFile = join(temp, 'raw.jsonl');
    const outFile = join(temp, 'recorded.jsonl');
    writeFileSync(rawFile, JSON.stringify({ name: 'agent.tool_result', payload: { authorization: 'Bearer private-token-value', result: 'ok' } }) + '\n');
    const rec = spawnSync(process.execPath, ['scripts/eval/runner.mjs', 'record', '--task', 'record-probe', '--input', rawFile, '--output', outFile], { cwd: root, encoding: 'utf8' });
    A.eq(rec.status, 0, 'record CLI exits zero');
    const recordedText = readFileSync(outFile, 'utf8');
    A.ok(!recordedText.includes('private-token-value') && recordedText.includes('[REDACTED]'), 'record CLI writes only redacted evidence');

    const brokenFile = join(temp, 'broken.jsonl');
    core.writeJsonl(brokenFile, broken);
    const failCli = spawnSync(process.execPath, ['scripts/eval/runner.mjs', 'run', '--candidate', brokenFile], { cwd: root, encoding: 'utf8' });
    A.eq(failCli.status, 1, 'CLI returns nonzero for threshold failures');
    A.ok(/FAIL existing-basic-response/.test(failCli.stdout), 'CLI names the failing task');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  A.throws(() => core.validateTasks([tasks[0], tasks[0]]), 'duplicate task ids fail schema validation');
  A.report('agent-eval.test');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
