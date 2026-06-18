/* node test/verify.run.test.js — the verify.run tool (execution-spine Commit 4), with REAL subprocesses.
   A passing check verdicts PASS; a failing one verdicts FAIL (a non-zero exit is a verdict, not a thrown error);
   the floor refuses escapes; no-cmd + no-package.json is an actionable error; verify.result fires with the
   verdict. Spawns processes → rides test:http, not the fast gate. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeVerifyTool } = require('../sidecar/tools/builtin/verify.js');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-vr-'));
  fs.mkdirSync(path.join(root, 'a1'), { recursive: true });
  const events = [];
  const tool = makeVerifyTool({ spawn, fs, pathMod: path, root, clock: makeClock(0), redact: (s) => s }).verifyTool;
  const ctx = { agentId: 'a1', runId: 'r1', emit: (n, p) => events.push({ name: n, payload: p }) };

  try {
    // ---- a passing check -> PASSED verdict + verify.result{passed:true} ----
    const ok = await tool.run({ cmd: 'echo tests ok && exit 0' }, ctx);
    A.ok(/✓ PASSED/.test(ok.content), 'a zero-exit check verdicts PASSED');
    A.ok(/verify passed/.test(ok.summary), 'summary says passed');
    const okEv = events.find(e => e.name === 'verify.result');
    A.ok(okEv && okEv.payload.passed === true, 'verify.result emitted with passed:true');
    A.ok(okEv.payload.added === 0 && okEv.payload.removed === 0, 'test-runner path reports a zero diagnostics delta');

    // ---- a failing check -> FAILED verdict (a non-zero exit is a verdict, not a thrown tool error) ----
    events.length = 0;
    const bad = await tool.run({ cmd: 'exit 1' }, ctx);
    A.ok(/✗ FAILED/.test(bad.content), 'a non-zero check verdicts FAILED');
    A.ok(events.some(e => e.name === 'verify.result' && e.payload.passed === false), 'verify.result emitted with passed:false');

    // ---- the floor + actionable errors (sync throws) ----
    A.throws(() => tool.run({ cmd: 'cat ../secret' }, ctx), 'an escaping check command is refused');
    A.throws(() => tool.run({}, ctx), 'no cmd + no package.json -> actionable error');

    // ---- auto-detect: a package.json makes a bare verify.run use "npm test" (here a passing stub) ----
    fs.writeFileSync(path.join(root, 'a1', 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'exit 0' } }));
    const auto = await tool.run({ timeoutMs: 60000 }, ctx);
    A.ok(/PASSED|FAILED/.test(auto.content), 'a bare verify.run auto-detects + runs the project check');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('verify.run.test');
})().catch(e => { console.log('FAIL: verify.run.test threw — ' + (e && e.stack || e)); process.exit(1); });
