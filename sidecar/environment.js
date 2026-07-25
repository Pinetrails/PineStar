/* sidecar/environment.js - runtime execution backends.

   The reference harness' terminal layer is built around an environment boundary: the tool asks an
   environment to execute, while the environment decides whether that means host
   shell, Docker, SSH, or a cloud sandbox. StarNet's first parity step is the same
   seam. This module keeps the local backend behavior-compatible, and adds a
   Docker backend that runs commands against the same per-agent workspace via a
   bind mount.

   makeEnvironmentManager({ spawn, fs, pathMod, root, bg?, clock?, env?, config? })
     -> { backendId, describe, ensureWorkspace, workspaceRoot, getCwd,
          rememberCwd, execute, startBackground, statusBackground, killBackground }
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).environment = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  const WIN = (typeof process !== 'undefined' && process.platform) === 'win32';
  const DEFAULT_DOCKER_IMAGE = 'node:20-bookworm';

  function safeAgentId(id) {
    if (!AID_RE.test(id || '')) throw new Error('bad agentId');
    return id;
  }
  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }
  function toBool(v, dflt) {
    if (v == null || v === '') return !!dflt;
    return /^(1|true|yes|on)$/i.test(String(v));
  }
  function readListEnv(raw) {
    if (raw == null || raw === '') return [];
    try {
      const v = JSON.parse(String(raw));
      return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];
    } catch (_) { return []; }
  }
  function firstEnv(env, names, dflt) {
    env = env || {};
    for (let i = 0; i < names.length; i++) {
      const v = env[names[i]];
      if (v != null && v !== '') return String(v);
    }
    return dflt;
  }
  const SECRET_ENV_NAME_RE = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|BEARER|COOKIE|CREDENTIAL)(?:_|$)/i;
  const INTERNAL_ENV_NAME_RE = /^(?:STARNET|SKYNET)_/i;
  const EXECUTION_HOOK_ENV_RE = /^(?:NODE_OPTIONS|NODE_PATH|npm_config_script_shell|COMSPEC)$/i;
  function sanitizeChildEnv(base) {
    const src = base || {};
    const out = {};
    for (const k of Object.keys(src)) {
      if (SECRET_ENV_NAME_RE.test(k) || INTERNAL_ENV_NAME_RE.test(k) || EXECUTION_HOOK_ENV_RE.test(k)) continue;
      const v = src[k];
      if (v != null) out[k] = String(v);
    }
    // Reserved safety pins are host authority. A task command/project hook cannot inherit or
    // override a switch that re-enables physical input, headed browsing, or local MCP children.
    out.STARNET_USER_CONTROL_MODE = 'preserve';
    out.STARNET_COMPUTER_DRIVER = '0';
    out.STARNET_BROWSER_HEADLESS = '1';
    out.STARNET_MCP_STDIO = '0';
    out.BROWSER = 'none';
    if (src.SystemRoot) out.ComSpec = String(src.SystemRoot).replace(/[\\/]+$/, '') + '\\System32\\cmd.exe';
    return out;
  }
  /* Service keys (the KEYS tab) are the ONE class of secret the Commander pasted expressly SO an agent's
     shell can spend it — "use it to call that service's API directly (curl etc.)" is what the system prompt
     promises. sanitizeChildEnv's blanket scrub strips every one of them (servicekeys.deriveEnvVar always
     ends in _API_KEY), which silently severed the entire feature. They are merged back in per call, but
     stay subordinate to host authority: a pasted var may never become a reserved safety pin
     (STARNET_/SKYNET_*) or an execution hook (NODE_OPTIONS/COMSPEC/…), so a KEYS row can't re-enable
     physical input or hijack the shell. Callers supply only provider-key-filtered maps (servicekeys.runEnv). */
  function mergeServiceEnv(base, extra) {
    if (!extra) return base;
    const names = Object.keys(extra);
    if (!names.length) return base;
    const out = Object.assign({}, base);
    for (const k of names) {
      if (INTERNAL_ENV_NAME_RE.test(k) || EXECUTION_HOOK_ENV_RE.test(k)) continue;
      const v = extra[k];
      if (v != null && v !== '') out[k] = String(v);
    }
    return out;
  }
  function backendFromEnv(env) {
    return firstEnv(env, ['STARNET_EXEC_BACKEND', 'SKYNET_EXEC_BACKEND'], 'local').trim().toLowerCase();
  }
  function hostInside(P, cwd, base) {
    try {
      const r = P.resolve(cwd), b = P.resolve(base);
      return r === b || r.indexOf(b + P.sep) === 0;
    } catch (_) { return false; }
  }
  function posixInside(cwd, base) {
    cwd = String(cwd || '');
    base = String(base || '/workspace').replace(/\/+$/, '') || '/';
    return cwd === base || cwd.indexOf(base + '/') === 0;
  }
  function killTree(spawn, child, isWin) {
    try { child.kill(); } catch (_) {}
    try {
      if (isWin && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else if (child.pid && typeof process !== 'undefined') process.kill(child.pid, 'SIGKILL');
    } catch (_) {}
  }

  function runProcess(opts) {
    const spawn = opts.spawn, file = opts.file, args = opts.args, spawnOptions = opts.spawnOptions || {};
    const timeoutMs = clamp(opts.timeoutMs, 1000, opts.maxTimeoutMs || 600000);
    const maxBytes = opts.maxBytes || 64000;
    const now = (opts.clock && typeof opts.clock.now === 'function') ? opts.clock.now : function () { return 0; };
    const sig = opts.signal;
    const isWin = opts.isWin != null ? opts.isWin : WIN;

    return new Promise(function (resolve, reject) {
      let child;
      try {
        child = Array.isArray(args) ? spawn(file, args, spawnOptions) : spawn(file, spawnOptions);
      } catch (e) {
        return reject(new Error('could not start environment process: ' + ((e && e.message) || e)));
      }

      const t0 = now();
      let out = '', total = 0, truncated = false, timedOut = false, aborted = false, settled = false;
      const append = function (buf) {
        if (total >= maxBytes) { truncated = true; return; }
        let s = buf == null ? '' : String(buf);
        if (total + s.length > maxBytes) { s = s.slice(0, maxBytes - total); truncated = true; }
        out += s;
        total += s.length;
      };
      if (child.stdout && child.stdout.on) child.stdout.on('data', append);
      if (child.stderr && child.stderr.on) child.stderr.on('data', append);

      const timer = setTimeout(function () { timedOut = true; killTree(spawn, child, isWin); }, timeoutMs);
      const onAbort = function () { aborted = true; killTree(spawn, child, isWin); };
      if (sig) {
        if (sig.aborted) onAbort();
        else { try { sig.addEventListener('abort', onAbort, { once: true }); } catch (_) {} }
      }
      function finish(code) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sig) { try { sig.removeEventListener('abort', onAbort); } catch (_) {} }
        resolve({
          exitCode: (typeof code === 'number' && !timedOut && !aborted) ? code : -1,
          out: out,
          ms: Math.max(0, now() - t0),
          truncated: truncated,
          timedOut: timedOut,
          aborted: aborted
        });
      }
      if (child.on) {
        child.on('error', function (e) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (sig) { try { sig.removeEventListener('abort', onAbort); } catch (_) {} }
          reject(new Error('environment process error: ' + ((e && e.message) || e)));
        });
        child.on('close', finish);
      } else {
        finish(-1);
      }
    });
  }

  function makeConfig(env, overrides) {
    env = env || {};
    overrides = overrides || {};
    const backend = (overrides.backend || backendFromEnv(env) || 'local').trim().toLowerCase();
    return {
      backend: backend,
      dockerBin: overrides.dockerBin || firstEnv(env, ['STARNET_DOCKER_BIN', 'SKYNET_DOCKER_BIN'], 'docker'),
      dockerImage: overrides.dockerImage || firstEnv(env, ['STARNET_DOCKER_IMAGE', 'SKYNET_DOCKER_IMAGE'], DEFAULT_DOCKER_IMAGE),
      dockerWorkspace: overrides.dockerWorkspace || firstEnv(env, ['STARNET_DOCKER_WORKSPACE'], '/workspace'),
      dockerNetwork: overrides.dockerNetwork != null ? overrides.dockerNetwork : firstEnv(env, ['STARNET_DOCKER_NETWORK'], ''),
      dockerSecurity: overrides.dockerSecurity != null ? !!overrides.dockerSecurity : toBool(firstEnv(env, ['STARNET_DOCKER_SECURITY'], 'true'), true),
      dockerCpus: overrides.dockerCpus || firstEnv(env, ['STARNET_DOCKER_CPUS'], ''),
      dockerMemory: overrides.dockerMemory || firstEnv(env, ['STARNET_DOCKER_MEMORY'], ''),
      dockerExtraArgs: Array.isArray(overrides.dockerExtraArgs) ? overrides.dockerExtraArgs : readListEnv(firstEnv(env, ['STARNET_DOCKER_EXTRA_ARGS'], ''))
    };
  }

  function makeLocalBackend(deps) {
    const spawn = deps.spawn, fs = deps.fs, P = deps.pathMod, ROOT = deps.root;
    const bg = deps.bg || null;
    const clock = deps.clock || { now: function () { return 0; } };
    const platform = deps.platform || (WIN ? 'win32' : 'posix');
    const isWin = platform === 'win32';
    const childEnv = sanitizeChildEnv(deps.env || (typeof process !== 'undefined' ? process.env : {}));
    // Resolved PER CALL, never snapshotted: a key pasted after boot must be live on the very next run,
    // and a disabled one gone on the very next run. Fail-open — a broken provider never breaks a shell.
    const serviceEnvFn = typeof deps.serviceEnv === 'function' ? deps.serviceEnv : null;
    function spawnEnv() {
      if (!serviceEnvFn) return childEnv;
      try { return mergeServiceEnv(childEnv, serviceEnvFn()); } catch (_) { return childEnv; }
    }
    const sessions = new Map();

    function workspaceRoot(agentId) {
      return P.join(ROOT, safeAgentId(agentId || 'agent'));
    }
    function ensureWorkspace(agentId) {
      const dir = workspaceRoot(agentId);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      return dir;
    }
    function getCwd(agentId) {
      const aid = safeAgentId(agentId || 'agent');
      const base = ensureWorkspace(aid);
      const s = sessions.get(aid);
      if (s && s.cwd && hostInside(P, s.cwd, base) && (!fs.existsSync || fs.existsSync(s.cwd))) return s.cwd;
      return base;
    }
    function rememberCwd(agentId, cwd) {
      const aid = safeAgentId(agentId || 'agent');
      const base = ensureWorkspace(aid);
      if (cwd && hostInside(P, cwd, base) && (!fs.existsSync || fs.existsSync(cwd))) sessions.set(aid, { cwd: cwd });
      return getCwd(aid);
    }

    return {
      id: 'local',
      supports: { shell: true, background: !!bg, hostWorkspace: true, checkpoints: true, hostileCodeSandbox: false },
      describe: function () { return {
        backend: 'local', workspace: ROOT, background: !!bg,
        safeCell: {
          default: true,
          hostileCodeSandbox: false,
          controls: ['per-agent workspace', 'fs realpath jail', 'consent gate', 'auto-checkpoint before execution', 'foreground timeout/abort kill', 'background kill/status']
        }
      }; },
      workspaceRoot: workspaceRoot,
      ensureWorkspace: ensureWorkspace,
      getCwd: getCwd,
      rememberCwd: rememberCwd,
      execute: function (opts) {
        opts = opts || {};
        const aid = safeAgentId(opts.agentId || 'agent');
        return runProcess({
          spawn: spawn,
          file: String(opts.cmd || ''),
          args: null,
          spawnOptions: { cwd: opts.cwd || getCwd(aid), shell: true, windowsHide: true, env: spawnEnv() },
          timeoutMs: opts.timeoutMs,
          maxTimeoutMs: opts.maxTimeoutMs,
          maxBytes: opts.maxBytes,
          signal: opts.signal,
          clock: opts.clock || clock,
          isWin: isWin
        });
      },
      startBackground: function (opts) {
        if (!bg || typeof bg.start !== 'function') return { ok: false, error: 'background processes are not available for the local backend' };
        const aid = safeAgentId((opts && opts.agentId) || 'agent');
        return bg.start({ agentId: aid, cmd: opts.cmd, cwd: opts.cwd || getCwd(aid), isWin: isWin, env: spawnEnv() });
      },
      statusBackground: function (agentId, bgId) {
        return bg && typeof bg.status === 'function' ? bg.status(safeAgentId(agentId || 'agent'), bgId) : (bgId ? null : []);
      },
      killBackground: function (agentId, bgId) {
        return bg && typeof bg.kill === 'function' ? bg.kill(safeAgentId(agentId || 'agent'), bgId) : { ok: false, error: 'background processes are not available for the local backend' };
      },
      killAllBackground: function (agentId) {
        return bg && typeof bg.killAll === 'function' ? bg.killAll(agentId) : 0;
      }
    };
  }

  function makeDockerBackend(deps) {
    const spawn = deps.spawn, fs = deps.fs, P = deps.pathMod, ROOT = deps.root;
    const clock = deps.clock || { now: function () { return 0; } };
    const cfg = deps.config || {};
    const sessions = new Map();
    const containerRoot = String(cfg.dockerWorkspace || '/workspace').replace(/\/+$/, '') || '/workspace';
    // Same contract as the local backend: resolved PER CALL, fail-open, never a boot-time snapshot.
    const serviceEnvFn = typeof deps.serviceEnv === 'function' ? deps.serviceEnv : null;
    function serviceEnvFor() {
      if (!serviceEnvFn) return {};
      try {
        const raw = serviceEnvFn() || {};
        const out = {};
        for (const k of Object.keys(raw)) {
          // a container env name must never be a host safety pin or an execution hook, and must be a legal
          // env identifier — `-e` takes the name verbatim, so a malformed one would become a docker flag.
          if (INTERNAL_ENV_NAME_RE.test(k) || EXECUTION_HOOK_ENV_RE.test(k)) continue;
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
          if (raw[k] != null && raw[k] !== '') out[k] = String(raw[k]);
        }
        return out;
      } catch (_) { return {}; }
    }

    function workspaceRoot(agentId) {
      return P.join(ROOT, safeAgentId(agentId || 'agent'));
    }
    function ensureWorkspace(agentId) {
      const dir = workspaceRoot(agentId);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      return dir;
    }
    function getCwd(agentId) {
      const aid = safeAgentId(agentId || 'agent');
      ensureWorkspace(aid);
      const cwd = sessions.get(aid);
      return cwd && posixInside(cwd, containerRoot) ? cwd : containerRoot;
    }
    function rememberCwd(agentId, cwd) {
      const aid = safeAgentId(agentId || 'agent');
      if (cwd && posixInside(cwd, containerRoot)) sessions.set(aid, cwd);
      return getCwd(aid);
    }
    // Service keys reach the container WITHOUT ever appearing on the command line. `docker run -e NAME`
    // with NO `=value` tells docker to read that variable from ITS OWN environment and forward it, so the
    // argv carries only the NAME (safe in any `ps` listing) while the value travels in the docker client's
    // env — which is why serviceEnvFor() is merged into spawnOptions.env below rather than interpolated
    // here. This is the reason not to use `-e NAME=value` or a temp --env-file: no secret on argv, no
    // secret on disk. Resolved per call, so a key added or revoked after boot takes effect on the next run.
    function dockerArgs(agentId, cmd, cwd, envNames) {
      const hostRoot = workspaceRoot(agentId);
      const args = ['run', '--rm', '-i'];
      for (const n of (envNames || [])) args.push('-e', n);
      if (cfg.dockerSecurity !== false) args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256');
      if (cfg.dockerNetwork) args.push('--network', String(cfg.dockerNetwork));
      if (cfg.dockerCpus) args.push('--cpus', String(cfg.dockerCpus));
      if (cfg.dockerMemory) args.push('--memory', String(cfg.dockerMemory));
      for (let i = 0; i < (cfg.dockerExtraArgs || []).length; i++) args.push(String(cfg.dockerExtraArgs[i]));
      args.push('--volume', hostRoot + ':' + containerRoot);
      args.push('--workdir', cwd || containerRoot);
      args.push(String(cfg.dockerImage || DEFAULT_DOCKER_IMAGE));
      args.push('sh', '-lc', String(cmd || ''));
      return args;
    }

    return {
      id: 'docker',
      supports: { shell: true, background: false, hostWorkspace: true, checkpoints: true, hostileCodeSandbox: true },
      describe: function () {
        return {
          backend: 'docker', image: cfg.dockerImage || DEFAULT_DOCKER_IMAGE, workspace: containerRoot, hostRoot: ROOT, background: false,
          safeCell: {
            default: false,
            hostileCodeSandbox: true,
            controls: ['per-agent bind mount', 'container cwd clamp', 'cap-drop ALL', 'no-new-privileges', 'PID limit', 'foreground timeout/abort kill']
          }
        };
      },
      workspaceRoot: workspaceRoot,
      ensureWorkspace: ensureWorkspace,
      getCwd: getCwd,
      rememberCwd: rememberCwd,
      execute: function (opts) {
        opts = opts || {};
        const aid = safeAgentId(opts.agentId || 'agent');
        const cwd = opts.cwd || getCwd(aid);
        // Names go on the argv (`-e NAME`), values go in the DOCKER CLIENT's env — so the secret is never
        // in a command line, and a container only ever receives keys the Commander connected.
        const svc = serviceEnvFor();
        const names = Object.keys(svc);
        return runProcess({
          spawn: spawn,
          file: cfg.dockerBin || 'docker',
          args: dockerArgs(aid, opts.cmd, cwd, names),
          spawnOptions: names.length
            ? { windowsHide: true, env: mergeServiceEnv(sanitizeChildEnv(deps.env || (typeof process !== 'undefined' ? process.env : {})), svc) }
            : { windowsHide: true },
          timeoutMs: opts.timeoutMs,
          maxTimeoutMs: opts.maxTimeoutMs,
          maxBytes: opts.maxBytes,
          signal: opts.signal,
          clock: opts.clock || clock,
          isWin: WIN
        });
      },
      startBackground: function () {
        return { ok: false, error: 'background processes are not available for the docker backend yet; run a foreground command or switch STARNET_EXEC_BACKEND=local' };
      },
      statusBackground: function () { return []; },
      killBackground: function () { return { ok: false, error: 'background processes are not available for the docker backend yet' }; },
      killAllBackground: function () { return 0; },
      _internals: { dockerArgs: dockerArgs, posixInside: posixInside }
    };
  }

  function makeEnvironmentManager(deps) {
    deps = deps || {};
    const spawn = deps.spawn, fs = deps.fs, P = deps.pathMod, ROOT = deps.root;
    if (typeof spawn !== 'function' || !fs || !P || !ROOT) throw new Error('environment.js requires { spawn, fs, pathMod, root }');
    const config = makeConfig(deps.env || (typeof process !== 'undefined' ? process.env : {}), deps.config || {});
    let backend;
    if (config.backend === 'local') backend = makeLocalBackend(Object.assign({}, deps, { config: config }));
    else if (config.backend === 'docker') backend = makeDockerBackend(Object.assign({}, deps, { config: config }));
    else throw new Error('unknown execution backend "' + config.backend + '" (expected local or docker)');

    return {
      backendId: backend.id,
      supports: backend.supports,
      describe: backend.describe,
      workspaceRoot: backend.workspaceRoot,
      ensureWorkspace: backend.ensureWorkspace,
      getCwd: backend.getCwd,
      rememberCwd: backend.rememberCwd,
      execute: backend.execute,
      startBackground: backend.startBackground,
      statusBackground: backend.statusBackground,
      killBackground: backend.killBackground,
      killAllBackground: backend.killAllBackground,
      _backend: backend,
      _internals: { safeAgentId: safeAgentId, makeConfig: makeConfig, sanitizeChildEnv: sanitizeChildEnv, mergeServiceEnv: mergeServiceEnv, runProcess: runProcess, hostInside: hostInside, posixInside: posixInside }
    };
  }

  return { makeEnvironmentManager: makeEnvironmentManager, makeConfig: makeConfig, sanitizeChildEnv: sanitizeChildEnv, safeAgentId: safeAgentId, runProcess: runProcess };
});
