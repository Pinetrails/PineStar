/* sidecar/tools/builtin/shell.js — the WORKBENCH capability: shell.exec, run a command in the agent's workspace.

   This is the harness's real code-execution capability (execution-spine Commit 3) — the single most dangerous
   tool, so it ships behind every safety control at once:
     - CAPABILITY-GATED: appears only when a "workbench" object is placed in the agent's room (CAP_REGISTRY).
     - CONSENT-GATED (scope 'execute', requiresConsent): walks the existing ladder. Interactive prompts live;
       AUTONOMOUS (cron/headless) is denied by the broker's exec-lockout — un-pre-blessable, no "approve all".
     - AUTO-CHECKPOINT: the host snapshots the workspace BEFORE dispatching a shell call (index.js dispatch hook,
       unconditional for shell.*), so any command is one rollback away.
     - cwd PINNED to the per-agent fs jail; a best-effort floor refuses obvious workspace escapes.
     - Its OWN timeout + abort that KILL the child tree (the registry's withTimeout only rejects, never kills),
       and a hard output cap + secret redaction before stdout reaches the model/bus.

   `runCommand` (the spawn → capture → timeout/abort-kill core) is exported so verify.run reuses it verbatim —
   one battle-tested execution primitive, not two. Every ambient dependency is INJECTED (spawn, fs, path, redact,
   clock) so it is headless-testable and determinism-clean (no Date.now / Math.random / new Date(); ms via clock).

   makeShellTool({ spawn, fs, pathMod, root, redact?, clock?, limits? }) -> { execTool, register(reg) } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).shell = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  function safeAgentId(id) { if (!AID_RE.test(id || '')) throw new Error('bad agentId'); return id; }
  function clip(s, n) { s = String(s == null ? '' : s); n = n || 200; return s.length > n ? s.slice(0, n) + '…' : s; }
  function clamp(n, lo, hi) { n = Number(n); if (!isFinite(n)) return lo; return Math.max(lo, Math.min(hi, n)); }
  const WIN = (typeof process !== 'undefined' && process.platform) === 'win32';

  /* best-effort blast wall (true confinement needs a container — a deferred backend). A command confined to its
     own workspace never needs to escape it, so refuse obvious filesystem escapes + references to the harness's
     own control siblings. Tuned NOT to trip on git range syntax (main..HEAD) — only `..` as a path segment. */
  function escapesWorkspace(cmd) {
    if (/(^|[\s"'`=(])\.\.([\\/]|$)/.test(cmd)) return 'parent-directory (..) paths are not allowed — commands run inside your own workspace';
    if (/(^|[\s"'`=(])[A-Za-z]:[\\/]/.test(cmd)) return 'drive-absolute paths (C:\\…) are not allowed — use paths inside your workspace';
    if (/(^|[\s"'`=(])\\\\[^\s\\]/.test(cmd)) return 'UNC paths (\\\\server) are not allowed';
    if (/\.checkpoints|permissions\.allow|\.notebook\.json|channels[\\/]+secrets|codex[\\/]+tokens|ledger\.jsonl|cron\.jobs\.json/i.test(cmd)) return 'that path is a protected harness control file';
    return null;
  }

  // best-effort tree-kill: child.kill() reaps the shell; on Windows taskkill /T also reaps its grandchildren.
  function killTree(spawn, child, isWin) {
    try { child.kill(); } catch (_) {}
    try {
      if (isWin && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else if (child.pid) process.kill(child.pid, 'SIGKILL');
    } catch (_) {}
  }

  /* runCommand — the shared execution primitive: spawn `cmd` in `cwd` (shell:true), capture combined stdout/stderr
     up to maxBytes, enforce the per-call timeout + abort signal by KILLING the child tree, and resolve a plain
     result. Never rejects on a non-zero exit (that is a RESULT); rejects ONLY if the process can't be started.
     opts = { spawn, cmd, cwd, timeoutMs, maxBytes, signal?, clock?, isWin? }
       -> Promise<{ exitCode:int, out:string, ms:int, truncated:bool, timedOut:bool, aborted:bool }> */
  function runCommand(opts) {
    const spawn = opts.spawn, cmd = opts.cmd, cwd = opts.cwd;
    const timeoutMs = opts.timeoutMs, maxBytes = opts.maxBytes || 64000;
    const now = (opts.clock && typeof opts.clock.now === 'function') ? opts.clock.now : () => 0;
    const isWin = (opts.isWin != null) ? opts.isWin : WIN;
    const sig = opts.signal;
    return new Promise(function (resolve, reject) {
      let child;
      try { child = spawn(cmd, { cwd: cwd, shell: true, windowsHide: true }); }
      catch (e) { return reject(new Error('could not start shell: ' + ((e && e.message) || e))); }
      const t0 = now();
      let out = '', total = 0, truncated = false, settled = false, timedOut = false, aborted = false;
      const append = function (buf) {
        if (total >= maxBytes) { truncated = true; return; }
        let s = buf.toString();
        if (total + s.length > maxBytes) { s = s.slice(0, maxBytes - total); truncated = true; }
        out += s; total += s.length;
      };
      if (child.stdout) child.stdout.on('data', append);
      if (child.stderr) child.stderr.on('data', append);
      const timer = setTimeout(function () { timedOut = true; killTree(spawn, child, isWin); }, timeoutMs);
      const onAbort = function () { aborted = true; killTree(spawn, child, isWin); };
      if (sig) { if (sig.aborted) { onAbort(); } else { try { sig.addEventListener('abort', onAbort, { once: true }); } catch (_) {} } }
      function finish(code) {
        if (settled) return; settled = true;
        clearTimeout(timer);
        if (sig) { try { sig.removeEventListener('abort', onAbort); } catch (_) {} }
        resolve({ exitCode: (typeof code === 'number') ? code : -1, out: out, ms: Math.max(0, now() - t0), truncated: truncated, timedOut: timedOut, aborted: aborted });
      }
      child.on('error', function (e) { if (settled) return; settled = true; clearTimeout(timer); if (sig) { try { sig.removeEventListener('abort', onAbort); } catch (_) {} } reject(new Error('shell error: ' + ((e && e.message) || e))); });
      child.on('close', function (code) { finish(timedOut || aborted ? null : code); });
    });
  }

  function makeShellTool(deps) {
    deps = deps || {};
    const spawn = deps.spawn, fs = deps.fs, P = deps.pathMod, ROOT = deps.root;
    if (typeof spawn !== 'function' || !fs || !P || !ROOT) throw new Error('shell.js requires { spawn, fs, pathMod, root }');
    const redact = typeof deps.redact === 'function' ? deps.redact : (s) => s;
    const now = (deps.clock && typeof deps.clock.now === 'function') ? deps.clock.now : () => 0;
    const isWin = (deps.platform != null) ? (deps.platform === 'win32') : WIN;
    const L = deps.limits || {};
    const MAX_BYTES = L.maxBytes || 64000;
    const DEFAULT_MS = L.defaultTimeoutMs || 30000;
    const MAX_MS = L.maxTimeoutMs || 120000;

    const execTool = {
      name: 'shell.exec', capability: 'workbench', scope: 'execute', requiresConsent: true,
      timeoutMs: MAX_MS + 10000,   // registry backstop ABOVE our own kill logic, so withTimeout never preempts the child-kill
      description: 'Run a shell command in your workspace directory and get back its combined stdout/stderr + exit code. '
        + 'Use it to run tests, builds, git, scripts — anything you would type in a terminal. Commands run INSIDE your own '
        + 'workspace folder; absolute paths and parent (..) paths are refused. Optional timeoutMs (default 30s, max 120s).',
      schema: { type: 'object', required: ['cmd'], properties: { cmd: { type: 'string' }, timeoutMs: { type: 'number' } } },
      run: function (args, ctx) {
        ctx = ctx || {};
        const aid = safeAgentId((ctx && ctx.agentId) || 'agent');
        const cmd = String((args && args.cmd) || '').trim();
        if (!cmd) throw new Error('empty command');
        const deny = escapesWorkspace(cmd);
        if (deny) throw new Error('refused: ' + deny);
        const cwd = P.join(ROOT, aid);
        try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) {}
        const timeoutMs = clamp((args && args.timeoutMs) || DEFAULT_MS, 1000, MAX_MS);
        return runCommand({ spawn: spawn, cmd: cmd, cwd: cwd, timeoutMs: timeoutMs, maxBytes: MAX_BYTES, signal: ctx.signal, clock: { now: now }, isWin: isWin }).then(function (res) {
          const note = res.timedOut ? ' — KILLED (timed out after ' + timeoutMs + 'ms)' : res.aborted ? ' — KILLED (aborted)' : '';
          const body = redact(res.out || '(no output)');
          const content = body + '\n[exit ' + res.exitCode + (res.truncated ? ', output truncated to ' + Math.round(MAX_BYTES / 1000) + 'KB' : '') + note + ']';
          try {
            if (typeof ctx.emit === 'function') ctx.emit('shell.exec', {
              agentId: aid, runId: ctx.runId || '', callId: ctx.callId || 'call',
              cmdSummary: redact(clip(cmd)), cwd: aid, exitCode: res.exitCode, ms: res.ms, truncated: res.truncated
            });
          } catch (_) {}
          return { content: content, summary: 'exit ' + res.exitCode + ' (' + res.ms + 'ms)' + (res.truncated ? ', truncated' : '') };
        });
      }
    };

    return {
      execTool: execTool,
      _internals: { escapesWorkspace: escapesWorkspace, killTree: killTree, safeAgentId: safeAgentId },
      register: function (reg) { reg.register(execTool); return reg; }
    };
  }

  return { makeShellTool: makeShellTool, runCommand: runCommand, escapesWorkspace: escapesWorkspace, safeAgentId: safeAgentId };
});
