#!/usr/bin/env node
// phase4-recovery-proof.mjs - targeted automated failure/recovery proof for P4.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedCommand } from './lib/run-command.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.env.STARNET_PHASE4_RECOVERY_DIR || join(ROOT, '.dogfood', 'phase4-recovery-proof'));
const nodeCmd = process.execPath;

function ensureDir(p) { mkdirSync(p, { recursive: true }); }

const tests = [
  ['cancel-proof', 'test/halt.test.js'],
  ['budget-proof', 'test/budget.test.js'],
  ['checkpoint-proof', 'test/checkpoint.test.js'],
  ['consent-proof', 'test/consent.interactive.test.js'],
  ['shell-proof', 'test/shell.test.js'],
  ['verify-proof', 'test/verify.run.test.js'],
  ['patch-restore-proof', 'test/fs.patch.test.js']
];

ensureDir(OUT);
const results = [];
for (const [id, testFile] of tests) {
  console.log('[phase4-recovery] ' + id + ' - ' + testFile);
  const result = await runBoundedCommand({
    cmd: nodeCmd,
    args: [testFile],
    cwd: ROOT,
    env: process.env,
    timeoutMs: 120000,
    label: 'phase4-recovery/' + id
  });
  const logFile = join(OUT, id + '.log');
  writeFileSync(logFile, result.output);
  const status = result.exitCode === 0 ? 'pass' : 'fail';
  results.push({ id, testFile, status, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, logFile });
  console.log('[phase4-recovery]   ' + status.toUpperCase() + ' exit=' + result.exitCode);
  if (status === 'fail') break;
}

const fail = results.filter(r => r.status === 'fail').length;
const json = {
  generatedAt: new Date().toISOString(),
  verdict: fail ? 'red' : 'green',
  counts: { pass: results.filter(r => r.status === 'pass').length, fail },
  results
};
writeFileSync(join(OUT, 'phase4-recovery-status.json'), JSON.stringify(json, null, 2));
process.exit(fail ? 1 : 0);
