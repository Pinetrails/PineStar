import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureMcpServer, observeFixture } from '../scripts/eval/campaign/fixture-host.mjs';
import { gradeParityTrajectory } from '../scripts/eval/independent-grader.mjs';

let assertions = 0;
const check = (value, message) => { assertions++; assert.ok(value, message); };

const root = mkdtempSync(join(tmpdir(), 'starnet-fixture-host-'));
const server = await startFixtureMcpServer();
let rpcId = 0;
async function call(name, args = {}) {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: String(++rpcId), method: 'tools/call', params: { name, arguments: args } })
  });
  return (await response.json()).result;
}

try {
  const fixture = {
    taskId: 'parity-orch-parallel-fanout',
    setup: {
      files: { 'base.txt': 'BASE\n' },
      commands: { fail: [process.execPath, '-e', "process.stderr.write('MARKER');process.exit(7)"] },
      workers: {
        alpha: { result: 'A', delayMs: 40 }, beta: { result: 'B', delayMs: 40 }, gamma: { result: 'C', delayMs: 40 }
      }
    }
  };
  const state = server.activate(fixture, root);

  const inspect = await call('fixture_inspect');
  check(!inspect.isError && inspect.content[0].text.includes('Verify every changed file'), 'inspection carries host requirements');
  check(inspect.content[0].text.includes('run_parallel_workers'), 'fanout inspection names the one authoritative aggregate route');

  const ambiguousFanout = await call('fixture_worker_run', { worker: 'alpha' });
  check(ambiguousFanout.isError && ambiguousFanout.content[0].text.includes('cannot prove concurrent fanout'), 'low-level calls cannot masquerade as one concurrent batch');

  const write = await call('fixture_write_file', { path: 'dist/result.txt', content: 'DONE\n' });
  check(!write.isError && readFileSync(join(root, 'dist/result.txt'), 'utf8') === 'DONE\n', 'bounded write reaches fixture root');

  const verify = await call('fixture_verify_file', { path: 'dist/result.txt' });
  check(!verify.isError, 'post-mutation verification succeeds');

  const escape = await call('fixture_write_file', { path: '../escaped.txt', content: 'NO' });
  check(escape.isError, 'authority escape is rejected');

  const command = await call('fixture_run_command', { name: 'fail' });
  const commandValue = JSON.parse(command.content[0].text);
  check(commandValue.exitCode === 7 && commandValue.stderr === 'MARKER', 'real command status is retained');
  await call('fixture_run_command', { name: 'fail' });

  const fanout = await call('fixture_action', { action: 'run_parallel_workers' });
  check(!fanout.isError, 'one orchestration action runs the declared worker fanout');
  const host = observeFixture(state, 'done', { sessionId: 's1', agentId: 'agent' });
  check(host.observation.maxConcurrentWorkers === 3, 'concurrent worker calls are host observed');
  check(host.observation.authorityEscapes === 1, 'authority escape count is host observed');
  check(host.observation.changedPaths.length === 1 && host.observation.changedPaths[0] === 'dist/result.txt', 'changed paths are derived from disk');
  check(JSON.stringify(host.observation.commandHistory) === JSON.stringify([{ name: 'fail', exitCode: 7 }, { name: 'fail', exitCode: 7 }]), 'ordered command history preserves repeated real exits');
  check(host.artifacts.length === 1 && host.artifacts[0].sha256 === host.artifacts[0].verifiedSha256, 'artifact hashes match after verification');
  check(Date.parse(host.artifacts[0].verifiedAt) >= Date.parse(host.artifacts[0].mutatedAt), 'verification is not older than mutation');
  check(host.routing.requestedSessionId === 's1' && host.routing.observedSessionId === 's1', 'route evidence is host derived');

  // The check scenario is a real recovery now: fail -> inspect -> one repair -> pass -> post-mutation verify.
  const readJsonl = file => readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const recoveryFixture = readJsonl(join(process.cwd(), 'scripts/eval/fixtures/parity-v0.9.0.jsonl')).find(row => row.taskId === 'parity-code-checks');
  const task = readJsonl(join(process.cwd(), 'scripts/eval/packs/parity-v0.9.0.jsonl')).find(row => row.id === 'parity-code-checks');
  const recoveryRoot = join(root, 'recovery');
  const recoveryState = server.activate(recoveryFixture, recoveryRoot);
  const initial = JSON.parse((await call('fixture_run_command', { name: 'check' })).content[0].text);
  check(initial.exitCode === 7 && initial.stderr.includes('REPAIR-CHECK-FAIL-17'), 'recovery fixture begins with a real failing process');
  await call('fixture_read_file', { path: 'src/value.js' });
  await call('fixture_write_file', { path: 'src/value.js', content: 'module.exports = 2;\n' });
  const repaired = JSON.parse((await call('fixture_run_command', { name: 'check' })).content[0].text);
  check(repaired.exitCode === 0 && repaired.stdout.includes('REPAIR-CHECK-PASS-17'), 'the bounded repair makes the same real process pass');
  await call('fixture_verify_file', { path: 'src/value.js' });
  const finalText = 'Initial exit 7: REPAIR-CHECK-FAIL-17. Final exit 0: REPAIR-CHECK-PASS-17.';
  const recovered = observeFixture(recoveryState, finalText, { sessionId: 's2', agentId: 'agent' });
  const grade = gradeParityTrajectory(task, recoveryFixture, Object.assign({ finalText }, recovered));
  check(grade.passed, 'independent grader accepts the complete fail-repair-rerun evidence chain');
  check(recovered.observation.mutationCount === 1 && recovered.observation.changedPaths[0] === 'src/value.js', 'recovery changes exactly the authorized target once');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`eval-fixture-host.test: OK (${assertions} assertions)`);
