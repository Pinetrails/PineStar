/* sidecar/tools/builtin/verify.js — the WORKBENCH verify.run tool (execution-spine Commit 4): run the project's
   own check (tests/build) in the jail and report a pass/fail VERDICT — the proof that an edit actually worked.

   The 80/20 of verification: once shell exists, the highest-value signal is "did my change pass the suite." This
   tool runs a configured-or-auto-detected check command through the SAME execution primitive shell.exec uses
   (shell.js runCommand — one battle-tested spawn/timeout/abort core), judges it with the pure sidecar/verify.js
   interpret(), emits the verify.result rung (the war-room pass/fail glow), and hands the model a clear verdict.

   It is a 'workbench'/execute capability exactly like shell.exec — same danger gate: interactive prompts, the
   autonomous EXEC-LOCKOUT denies it, and the host auto-checkpoints before it runs. Diagnostics-delta (the LSP
   lint noise filter) is the pure diagnosticDelta() in verify.js, ready for a future linter provider; the
   test-runner path reports added/removed = 0.

   makeVerifyTool({ spawn, fs, pathMod, root, redact?, clock?, limits? }) -> { verifyTool, register(reg) } */
'use strict';
(function (root, factory) {
  const api = factory(
    typeof require === 'function' ? require('./shell.js') : (root.SK && root.SK.tools && root.SK.tools.builtin && root.SK.tools.builtin.shell),
    typeof require === 'function' ? require('../../verify.js') : (root.SK && root.SK.verify)
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).verify = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shell, verifyCore) {
  'use strict';

  const runCommand = shell.runCommand, escapesWorkspace = shell.escapesWorkspace, safeAgentId = shell.safeAgentId;
  const interpret = verifyCore.interpret;
  const WIN = (typeof process !== 'undefined' && process.platform) === 'win32';
  function clamp(n, lo, hi) { n = Number(n); if (!isFinite(n)) return lo; return Math.max(lo, Math.min(hi, n)); }

  function makeVerifyTool(deps) {
    deps = deps || {};
    const environment = deps.environment || null;
    const spawn = deps.spawn, fs = deps.fs, P = deps.pathMod, ROOT = deps.root;
    if (!environment && (typeof spawn !== 'function' || !fs || !P || !ROOT)) throw new Error('verify.js requires { spawn, fs, pathMod, root } or { environment }');
    const redact = typeof deps.redact === 'function' ? deps.redact : (s) => s;
    const now = (deps.clock && typeof deps.clock.now === 'function') ? deps.clock.now : () => 0;
    const isWin = (deps.platform != null) ? (deps.platform === 'win32') : WIN;
    const L = deps.limits || {};
    const MAX_BYTES = L.maxBytes || 64000;
    const DEFAULT_MS = L.defaultTimeoutMs || 120000;   // a test suite/build is slower than a shell one-liner
    const MAX_MS = L.maxTimeoutMs || 600000;

    const verifyTool = {
      name: 'verify.run', capability: 'workbench', scope: 'execute', requiresConsent: true,
      timeoutMs: MAX_MS + 10000,
      description: 'Run your project\'s check (tests/build) and get back a clear PASS/FAIL verdict — proof your '
        + 'change works. Pass { "cmd": "npm test" } (or your build/lint command); with no cmd it runs "npm test" '
        + 'when a package.json is present. Runs in your workspace; optional timeoutMs (default 2m, max 10m).',
      schema: { type: 'object', properties: { cmd: { type: 'string' }, timeoutMs: { type: 'number' } } },
      run: function (args, ctx) {
        ctx = ctx || {};
        const aid = safeAgentId((ctx && ctx.agentId) || 'agent');
        const cwd = environment ? environment.getCwd(aid) : P.join(ROOT, aid);
        const hostCwd = environment && typeof environment.workspaceRoot === 'function' ? environment.workspaceRoot(aid) : cwd;
        let cmd = String((args && args.cmd) || '').trim();
        if (!cmd) {
          if (fs && fs.existsSync && fs.existsSync(P.join(hostCwd, 'package.json'))) cmd = 'npm test';
          else throw new Error('no check command given and no package.json found — pass { "cmd": "<your check>" }');
        }
        const deny = escapesWorkspace(cmd);
        if (deny) throw new Error('refused: ' + deny);
        if (!environment) { try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) {} }
        const timeoutMs = clamp((args && args.timeoutMs) || DEFAULT_MS, 1000, MAX_MS);
        const run = environment && typeof environment.execute === 'function'
          ? environment.execute({ agentId: aid, cmd: cmd, cwd: cwd, timeoutMs: timeoutMs, maxBytes: MAX_BYTES, signal: ctx.signal, clock: { now: now } })
          : runCommand({ spawn: spawn, cmd: cmd, cwd: cwd, timeoutMs: timeoutMs, maxBytes: MAX_BYTES, signal: ctx.signal, clock: { now: now }, isWin: isWin });
        return run.then(function (res) {
          const verdict = interpret(res);
          const body = redact(res.out || '(no output)');
          const content = (verdict.passed ? '✓ PASSED' : '✗ FAILED') + ' — `' + cmd + '`\n' + body
            + '\n[exit ' + res.exitCode + (res.truncated ? ', output truncated' : '') + (res.timedOut ? ', TIMED OUT' : '') + ']';
          try {
            if (typeof ctx.emit === 'function') ctx.emit('verify.result', {
              agentId: aid, runId: ctx.runId || '', tool: cmd.slice(0, 60),
              passed: verdict.passed, added: 0, removed: 0, summary: redact(verdict.summary)
            });
          } catch (_) {}
          return { content: content, summary: (verdict.passed ? 'verify passed' : 'verify FAILED') + ' (' + res.ms + 'ms)' };
        });
      }
    };

    return { verifyTool: verifyTool, register: function (reg) { reg.register(verifyTool); return reg; } };
  }

  return { makeVerifyTool: makeVerifyTool };
});
