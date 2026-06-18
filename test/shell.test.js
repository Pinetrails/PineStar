/* node test/shell.test.js — the WORKBENCH capability shell.exec (execution-spine Commit 3), with REAL subprocesses.

   Drives the actual tool against a real temp workspace: a command runs in the jail cwd and returns combined
   output + exit code; a non-zero exit is a RESULT (not a thrown tool error); the best-effort floor refuses
   obvious workspace escapes; the per-call timeout AND an abort signal both KILL the child; output is capped;
   the shell.exec telemetry rung carries the exit code. Spawns processes → rides test:http, not the fast gate. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');

const SLEEP = process.platform === 'win32' ? 'ping -n 5 127.0.0.1 > NUL' : 'sleep 5';

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-sh-'));
  const events = [];
  const shell = makeShellTool({ spawn, fs, pathMod: path, root, clock: makeClock(0), redact: (s) => s });
  const tool = shell.execTool;
  const ctx = (extra) => Object.assign({ agentId: 'a1', runId: 'r1', callId: 'c1', emit: (n, p) => events.push({ name: n, payload: p }) }, extra || {});

  try {
    // ---- 1. echo: exit 0 + the output comes back, and runs in the jail cwd ----
    const r1 = await tool.run({ cmd: 'echo skynet-shell-ok' }, ctx());
    A.ok(/skynet-shell-ok/.test(r1.content), 'stdout returned');
    A.ok(/\[exit 0/.test(r1.content), 'exit 0 noted in the content');
    A.ok(/exit 0/.test(r1.summary), 'summary names the exit code');

    // ---- 2. a non-zero exit is a RESULT, not a thrown tool error ----
    const r2 = await tool.run({ cmd: 'exit 3' }, ctx());
    A.ok(/\[exit 3/.test(r2.content), 'non-zero exit captured (3)');

    // ---- 3. the shell.exec telemetry rung fired with the exit code ----
    const ev = events.find(e => e.name === 'shell.exec');
    A.ok(ev && ev.payload.exitCode === 0, 'shell.exec event carries exitCode');
    A.ok(ev.payload.cwd === 'a1' && ev.payload.callId === 'c1', 'shell.exec event carries the jail label + callId (no abs path)');

    // ---- 4. the escape floor refuses obvious workspace escapes (sync throw) ----
    A.throws(() => tool.run({ cmd: 'type ..\\secret.txt' }, ctx()), 'parent (..) path refused');
    A.throws(() => tool.run({ cmd: 'cat C:\\Windows\\system32\\drivers\\etc\\hosts' }, ctx()), 'drive-absolute path refused');
    A.throws(() => tool.run({ cmd: 'cat .checkpoints/index.json' }, ctx()), 'protected control file refused');
    A.throws(() => tool.run({ cmd: '   ' }, ctx()), 'empty command refused');
    // the floor does NOT trip on git range syntax (main..HEAD) — only `..` as a path segment
    A.eq(shell._internals.escapesWorkspace('git log main..HEAD'), null, 'git range main..HEAD is NOT a floor escape');
    A.ok(shell._internals.escapesWorkspace('cat ../x') !== null, '../x IS a floor escape');

    // ---- 5. output cap: a tiny maxBytes truncates ----
    const small = makeShellTool({ spawn, fs, pathMod: path, root, clock: makeClock(0), limits: { maxBytes: 5 } }).execTool;
    const r5 = await small.run({ cmd: 'echo hello world this is long' }, ctx());
    A.ok(/truncated/.test(r5.content), 'oversized output truncated');

    // ---- 6. the per-call timeout KILLS the child ----
    const t0 = Date.now();
    const r6 = await tool.run({ cmd: SLEEP, timeoutMs: 600 }, ctx());
    A.ok(/timed out/.test(r6.content), 'a slow command is killed on timeout');
    A.ok(Date.now() - t0 < 4500, 'timeout fired well before the 5s sleep would finish');

    // ---- 7. an abort signal KILLS the child ----
    const ac = new AbortController();
    const tA = Date.now();
    const p7 = tool.run({ cmd: SLEEP, timeoutMs: 10000 }, ctx({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 200);
    const r7 = await p7;
    A.ok(/aborted|\[exit -1/.test(r7.content), 'aborted command is killed');
    A.ok(Date.now() - tA < 4500, 'abort fired well before the sleep would finish');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('shell.test');
})().catch(e => { console.log('FAIL: shell.test threw — ' + (e && e.stack || e)); process.exit(1); });
