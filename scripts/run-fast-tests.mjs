#!/usr/bin/env node
/*
 * run-fast-tests.mjs — sequential runner for the fast test gate.
 *
 * WHY: test:fast:raw used to be one giant "node a && node b && ..." chain in
 * package.json. On Windows, cmd.exe hard-caps a command line at 8191 chars; the
 * chain crossed that limit on 2026-07-06 (247 steps) and the gate died with
 * "The command line is too long" before running a single test.
 *
 * The step list now lives in test/fast.list (one path per line, # comments and
 * blanks ignored, order matters). Add new fast-gate steps THERE, never back into
 * package.json.
 *
 * Behavior matches the old chain exactly: run each step with inherited stdio,
 * stop at the first non-zero exit, propagate that exit code.
 *
 * Optional args act as substring filters, e.g.:
 *   node scripts/run-fast-tests.mjs release-bump   -> run only matching steps
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIST_FILE = join(ROOT, 'test', 'fast.list');

const STEPS = readFileSync(LIST_FILE, 'utf8')
  .replace(/^﻿/, '')
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'));

const only = process.argv.slice(2);
const list = only.length ? STEPS.filter(s => only.some(o => s.includes(o))) : STEPS;
if (only.length && !list.length) {
  console.error('run-fast-tests: no step in test/fast.list matches ' + only.join(', '));
  process.exit(1);
}

let n = 0;
for (const step of list) {
  n++;
  const res = spawnSync(process.execPath, [step], { stdio: 'inherit', cwd: ROOT });
  if (res.status !== 0) {
    console.error('run-fast-tests: FAILED at step ' + n + '/' + list.length + ': node ' + step +
      ' (exit ' + (res.status == null ? 'signal ' + res.signal : res.status) + ')');
    process.exit(res.status == null ? 1 : res.status);
  }
}
console.log('run-fast-tests: OK — ' + list.length + ' step(s) green');
