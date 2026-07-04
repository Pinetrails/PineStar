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
    // Windows drive-ROOT-relative paths: a leading BACKSLASH with no drive letter (`type \Users\x`, `cd \`) resolves
    // to the root of the CURRENT drive — i.e. OUTSIDE the workspace, just like C:\. Block a single leading backslash
    // in path position that is NOT the start of a `\\server` UNC (that's caught above). We deliberately do NOT block
    // forward-slash-rooted forms: `/S`, `/c` etc. are overwhelmingly option flags (robocopy /S) and `/c/Users` is a
    // normalized cwd form, so there is no safe way to tell a root path from a flag — backslash-rooted only.
    if (/(^|[\s"'`=(])\\(?![\\])/.test(cmd)) return 'drive-root paths (\\…) are not allowed — use paths inside your workspace';
    if (/\.checkpoints|permissions\.allow|\.notebook\.json|channels[\\/]+secrets|codex[\\/]+tokens|ledger\.jsonl|cron\.jobs\.json/i.test(cmd)) return 'that path is a protected harness control file';
    return null;
  }

  /* H2.1 — persistent session cwd. A command runs in one shell invocation, so a `cd` only survives if we
     RECOVER the final cwd from that same invocation. We append a marker that prints the working dir + the real
     exit code (captured BEFORE the marker so the appended echo can't mask it), parse it back, strip it from the
     shown output, and persist the cwd PER AGENT — clamped to the fs jail so it can never drift outside. */
  const MARK_A = '__SK_CWD__', MARK_EC = '__SK_EC__', MARK_END = '__SK_END__';
  function buildMarkedCmd(cmd, isWin) {
    if (isWin) return cmd + ' & call echo ' + MARK_A + '%CD%' + MARK_EC + '%ERRORLEVEL%' + MARK_END;   // `call echo` re-expands %ERRORLEVEL% at runtime
    return cmd + '\n__sk_ec=$?; printf "\\n' + MARK_A + '%s' + MARK_EC + '%s' + MARK_END + '" "$(pwd)" "$__sk_ec"';
  }
  function parseMarker(out) {
    out = String(out == null ? '' : out);
    const re = new RegExp(MARK_A + '([\\s\\S]*?)' + MARK_EC + '(-?\\d+)' + MARK_END);
    const m = out.match(re);
    if (!m) return { cwd: null, ec: null, cleanOut: out };
    const ec = parseInt(m[2], 10);
    const cleanOut = (out.slice(0, m.index).replace(/\n$/, '')) + out.slice(m.index + m[0].length);
    return { cwd: m[1].trim(), ec: isFinite(ec) ? ec : null, cleanOut: cleanOut };
  }
  // is `cwd` the jail root or strictly inside it? (resolve both so .. / symlinks can't sneak past)
  function withinJail(P, cwd, jailRoot) {
    try { const r = P.resolve(cwd), j = P.resolve(jailRoot); return r === j || r.indexOf(j + P.sep) === 0; } catch (_) { return false; }
  }
  function pathInside(P, child, parent) {
    try {
      let c = P.resolve(child), p = P.resolve(parent);
      if (P.sep === '\\') { c = c.toLowerCase(); p = p.toLowerCase(); }
      return c === p || c.indexOf(p + P.sep) === 0;
    } catch (_) { return false; }
  }
  function normalizeWinCwd(P, cwd, isWin) {
    cwd = String(cwd == null ? '' : cwd).trim();
    if (!isWin) return cwd;
    const m = cwd.match(/^\/([a-zA-Z])(?:\/|$)(.*)$/);
    if (!m) return cwd;
    const tail = m[2] ? m[2].replace(/[\\/]+/g, '\\') : '';
    return m[1].toUpperCase() + ':\\' + tail;
  }
  function resolveShellCwd(opts) {
    opts = opts || {};
    const P = opts.pathMod, fs = opts.fs, requested = opts.requested;
    const current = opts.current, jailRoot = opts.jailRoot, root = opts.root;
    const isWin = !!opts.isWin, allowExternal = !!opts.allowExternal;
    let raw = String(requested == null ? '' : requested).trim();
    if (!raw) return current;
    if (/[\0\r\n]/.test(raw)) throw new Error('cwd contains a control character');
    if (/^\\\\[^\s\\]/.test(raw)) throw new Error('UNC cwd paths are not allowed');
    raw = normalizeWinCwd(P, raw, isWin);
    const abs = P.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? P.resolve(raw) : P.resolve(current, raw);
    if (!withinJail(P, abs, jailRoot) && !allowExternal) throw new Error('cwd must stay inside your workspace');
    if (!withinJail(P, abs, jailRoot) && root && pathInside(P, abs, root))
      throw new Error('cwd cannot point at another agent or protected StarNet workspace sibling');
    if (fs && fs.existsSync && !fs.existsSync(abs)) throw new Error('cwd does not exist: ' + raw);
    if (fs && fs.statSync) {
      try { if (!fs.statSync(abs).isDirectory()) throw new Error('cwd is not a directory: ' + raw); }
      catch (e) { if (e && /^cwd is not a directory/.test(e.message || '')) throw e; throw new Error('cwd is not accessible: ' + raw); }
    }
    return abs;
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
    const environment = deps.environment || null;
    const spawn = deps.spawn, fs = deps.fs || null, P = deps.pathMod || (typeof require === 'function' ? require('node:path') : null), ROOT = deps.root || '';
    const bg = deps.bg || null;   // H2.2: the singleton background-process manager (shellbg.js); null -> bg disabled
    if (!environment && (typeof spawn !== 'function' || !fs || !P || !ROOT)) throw new Error('shell.js requires { spawn, fs, pathMod, root } or { environment }');
    const redact = typeof deps.redact === 'function' ? deps.redact : (s) => s;
    const now = (deps.clock && typeof deps.clock.now === 'function') ? deps.clock.now : () => 0;
    const isWin = (deps.platform != null) ? (deps.platform === 'win32') : WIN;
    const L = deps.limits || {};
    const MAX_BYTES = L.maxBytes || 64000;
    const DEFAULT_MS = L.defaultTimeoutMs || 30000;
    const MAX_MS = L.maxTimeoutMs || 120000;
    const sessions = new Map();   // H2.1: aid -> { cwd } — a persistent working dir that survives across calls (jail-clamped)

    const execTool = {
      name: 'shell.exec', capability: 'workbench', scope: 'execute', requiresConsent: true,
      timeoutMs: MAX_MS + 10000,   // registry backstop ABOVE our own kill logic, so withTimeout never preempts the child-kill
      description: 'Run a shell command in your workspace directory and get back its combined stdout/stderr + exit code. '
        + 'Use it to run tests, builds, git, scripts — anything you would type in a terminal. Commands run INSIDE your own '
        + 'workspace folder, and your working directory PERSISTS across calls (a `cd` carries over). Absolute and parent (..) '
        + 'paths are refused in cmd; pass cwd to run from a specific existing folder instead. On Windows local shells, cwd accepts C:\\Users\\...; /c/Users/... is normalized for compatibility, but prefer the exact path the Commander gave you. Commands use cmd.exe syntax. Optional timeoutMs (default 30s, max 120s). Set background:true for a long-running process '
        + '(e.g. a dev server) — it returns immediately with a handle; check it with shell.bg.status, stop it with shell.bg.kill.',
      schema: { type: 'object', required: ['cmd'], properties: { cmd: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'number' }, background: { type: 'boolean' } } },
      run: function (args, ctx) {
        ctx = ctx || {};
        const aid = safeAgentId((ctx && ctx.agentId) || 'agent');
        const cmd = String((args && args.cmd) || '').trim();
        if (!cmd) throw new Error('empty command');
        const deny = escapesWorkspace(cmd);
        if (deny) throw new Error('refused: ' + deny);
        const jailRoot = environment ? environment.ensureWorkspace(aid) : P.join(ROOT, aid);
        // H2.1: start in this agent's PERSISTED cwd (default = jail root). Defensive: only honor a stored cwd
        // that is still in-jail and still exists; otherwise fall back to the jail root.
        const sess = sessions.get(aid);
        let cwd = environment ? environment.getCwd(aid) : jailRoot;
        if (sess && sess.cwd) {
          try { cwd = resolveShellCwd({ pathMod: P, fs: fs, requested: sess.cwd, current: cwd, jailRoot: jailRoot, root: ROOT, isWin: isWin, allowExternal: environment && environment.backendId === 'local' }); }
          catch (_) {}
        }
        if (!environment && sess && sess.cwd && withinJail(P, sess.cwd, jailRoot) && (!fs.existsSync || fs.existsSync(sess.cwd))) cwd = sess.cwd;
        if (args && args.cwd != null) {
          if (environment && environment.backendId !== 'local') throw new Error('cwd is only supported on the local execution backend; use cd inside the container workspace instead');
          cwd = resolveShellCwd({ pathMod: P, fs: fs, requested: args.cwd, current: cwd, jailRoot: jailRoot, root: ROOT, isWin: isWin, allowExternal: environment ? environment.backendId === 'local' : false });
          sessions.set(aid, { cwd: cwd });
        }
        if (!environment) { try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) {} }
        // H2.2: a long-running process — hand it to the singleton bg manager (detached, ring-buffered, capped)
        // and return immediately. Inherits the persisted cwd. Still consent-gated (this IS shell.exec).
        if (args && args.background) {
          if (!environment && !bg) return Promise.resolve({ content: 'Background processes are not available in this build.', summary: 'unavailable' });
          const r = environment && typeof environment.startBackground === 'function'
            ? environment.startBackground({ agentId: aid, cmd: cmd, cwd: cwd, isWin: isWin })
            : bg.start({ agentId: aid, cmd: cmd, cwd: cwd, isWin: isWin });
          const content = r.ok
            ? 'Started background process ' + r.bgId + ' in your workspace. It keeps running while you work — check it with shell.bg.status (id "' + r.bgId + '"), stop it with shell.bg.kill.'
            : 'Could not start a background process: ' + r.error;
          return Promise.resolve({ content: content, summary: r.ok ? ('bg started ' + r.bgId) : 'bg refused' });
        }
        const timeoutMs = clamp((args && args.timeoutMs) || DEFAULT_MS, 1000, MAX_MS);
        const markerIsWin = environment && environment.backendId !== 'local' ? false : isWin;
        const run = environment && typeof environment.execute === 'function'
          ? environment.execute({ agentId: aid, cmd: buildMarkedCmd(cmd, markerIsWin), cwd: cwd, timeoutMs: timeoutMs, maxBytes: MAX_BYTES, signal: ctx.signal, clock: { now: now } })
          : runCommand({ spawn: spawn, cmd: buildMarkedCmd(cmd, isWin), cwd: cwd, timeoutMs: timeoutMs, maxBytes: MAX_BYTES, signal: ctx.signal, clock: { now: now }, isWin: isWin });
        return run.then(function (res) {
          // recover the final cwd + the REAL exit code from the marker; persist the cwd only if it stayed in-jail.
          const pm = parseMarker(res.out);
          if (environment && pm.cwd && environment.backendId !== 'local') environment.rememberCwd(aid, pm.cwd);
          else if (environment && pm.cwd && withinJail(P, pm.cwd, jailRoot)) environment.rememberCwd(aid, pm.cwd);
          else if (environment && pm.cwd && environment.backendId === 'local') {
            try { sessions.set(aid, { cwd: resolveShellCwd({ pathMod: P, fs: fs, requested: pm.cwd, current: cwd, jailRoot: jailRoot, root: ROOT, isWin: isWin, allowExternal: true }) }); } catch (_) {}
          }
          else if (pm.cwd && withinJail(P, pm.cwd, jailRoot)) sessions.set(aid, { cwd: pm.cwd });
          const exitCode = (pm.ec != null && !res.timedOut && !res.aborted) ? pm.ec : res.exitCode;
          const note = res.timedOut ? ' — KILLED (timed out after ' + timeoutMs + 'ms)' : res.aborted ? ' — KILLED (aborted)' : '';
          const body = redact(pm.cleanOut || '(no output)');
          const content = body + '\n[exit ' + exitCode + (res.truncated ? ', output truncated to ' + Math.round(MAX_BYTES / 1000) + 'KB' : '') + note + ']';
          try {
            if (typeof ctx.emit === 'function') ctx.emit('shell.exec', {
              agentId: aid, runId: ctx.runId || '', callId: ctx.callId || 'call',
              cmdSummary: redact(clip(cmd)), cwd: aid, exitCode: exitCode, ms: res.ms, truncated: res.truncated
            });
          } catch (_) {}
          return { content: content, summary: 'exit ' + exitCode + ' (' + res.ms + 'ms)' + (res.truncated ? ', truncated' : '') };
        });
      }
    };

    // H2.2: inspect / stop the agent's own background processes (started via shell.exec background:true).
    const bgStatusTool = {
      name: 'shell.bg.status', capability: 'workbench', scope: 'read', requiresConsent: false,
      description: 'List your running/finished background processes (from shell.exec background:true), or pass an id '
        + 'for one process — shows whether it is still running, its exit code if done, and a tail of its output.',
      schema: { type: 'object', properties: { id: { type: 'string' } } },
      run: function (args, ctx) {
        const aid = safeAgentId((ctx && ctx.agentId) || 'agent');
        const source = environment && typeof environment.statusBackground === 'function' ? environment : null;
        if (!source && !bg) return { content: 'Background processes are not available in this build.', summary: 'unavailable' };
        const id = args && args.id ? String(args.id) : null;
        if (id) {
          const v = source ? source.statusBackground(aid, id) : bg.status(aid, id);
          if (!v) return { content: 'No background process "' + id + '".', summary: 'not found' };
          return { content: '[' + v.bgId + '] ' + (v.running ? 'RUNNING' : 'exited ' + v.exitCode + (v.killed ? ' (killed)' : '')) + ' · ' + v.ms + 'ms · ' + v.cmd + '\n--- output tail ---\n' + redact(v.tail || '(none)'), summary: v.running ? 'running' : 'exited ' + v.exitCode };
        }
        const list = source ? (source.statusBackground(aid) || []) : (bg.status(aid) || []);
        if (!list.length) return { content: 'No background processes.', summary: '0' };
        return { content: list.map(function (v) { return '[' + v.bgId + '] ' + (v.running ? 'RUNNING' : 'exited ' + v.exitCode) + ' · ' + v.cmd; }).join('\n'), summary: list.length + ' process(es)' };
      }
    };
    const bgKillTool = {
      name: 'shell.bg.kill', capability: 'workbench', scope: 'write', requiresConsent: false,
      description: 'Stop one of your background processes by id (from shell.bg.status). Kills the whole process tree.',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: function (args, ctx) {
        const aid = safeAgentId((ctx && ctx.agentId) || 'agent');
        const source = environment && typeof environment.killBackground === 'function' ? environment : null;
        if (!source && !bg) return { content: 'Background processes are not available in this build.', summary: 'unavailable' };
        const id = args && args.id ? String(args.id) : '';
        const r = source ? source.killBackground(aid, id) : bg.kill(aid, id);
        return { content: r.ok ? (r.alreadyExited ? 'Process ' + id + ' had already exited.' : 'Killed background process ' + id + '.') : ('Could not kill: ' + r.error), summary: r.ok ? 'killed' : 'not killed' };
      }
    };

    return {
      execTool: execTool, bgStatusTool: bgStatusTool, bgKillTool: bgKillTool,
      _internals: { escapesWorkspace: escapesWorkspace, killTree: killTree, safeAgentId: safeAgentId, normalizeWinCwd: normalizeWinCwd, resolveShellCwd: resolveShellCwd },
      register: function (reg) { reg.register(execTool); reg.register(bgStatusTool); reg.register(bgKillTool); return reg; }
    };
  }

  return { makeShellTool: makeShellTool, runCommand: runCommand, escapesWorkspace: escapesWorkspace, safeAgentId: safeAgentId, buildMarkedCmd: buildMarkedCmd, parseMarker: parseMarker, withinJail: withinJail, normalizeWinCwd: normalizeWinCwd, resolveShellCwd: resolveShellCwd };
});
