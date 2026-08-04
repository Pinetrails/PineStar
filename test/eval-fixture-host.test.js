import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureMcpServer, observeFixture } from '../scripts/eval/campaign/fixture-host.mjs';

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

  const write = await call('fixture_write_file', { path: 'dist/result.txt', content: 'DONE\n' });
  check(!write.isError && readFileSync(join(root, 'dist/result.txt'), 'utf8') === 'DONE\n', 'bounded write reaches fixture root');

  const verify = await call('fixture_verify_file', { path: 'dist/result.txt' });
  check(!verify.isError, 'post-mutation verification succeeds');

  const escape = await call('fixture_write_file', { path: '../escaped.txt', content: 'NO' });
  check(escape.isError, 'authority escape is rejected');

  const command = await call('fixture_run_command', { name: 'fail' });
  const commandValue = JSON.parse(command.content[0].text);
  check(commandValue.exitCode === 7 && commandValue.stderr === 'MARKER', 'real command status is retained');

  await Promise.all([
    call('fixture_worker_run', { worker: 'alpha' }),
    call('fixture_worker_run', { worker: 'beta' }),
    call('fixture_worker_run', { worker: 'gamma' })
  ]);
  const host = observeFixture(state, 'done', { sessionId: 's1', agentId: 'agent' });
  check(host.observation.maxConcurrentWorkers === 3, 'concurrent worker calls are host observed');
  check(host.observation.authorityEscapes === 1, 'authority escape count is host observed');
  check(host.observation.changedPaths.length === 1 && host.observation.changedPaths[0] === 'dist/result.txt', 'changed paths are derived from disk');
  check(host.artifacts.length === 1 && host.artifacts[0].sha256 === host.artifacts[0].verifiedSha256, 'artifact hashes match after verification');
  check(Date.parse(host.artifacts[0].verifiedAt) >= Date.parse(host.artifacts[0].mutatedAt), 'verification is not older than mutation');
  check(host.routing.requestedSessionId === 's1' && host.routing.observedSessionId === 's1', 'route evidence is host derived');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`eval-fixture-host.test: OK (${assertions} assertions)`);
