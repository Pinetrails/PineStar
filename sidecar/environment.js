/* sidecar/environment.js - runtime execution backends.

   The reference harness' terminal layer is built around an environment boundary: the tool asks an
   environment to execute, while the environment decides whether that means host
   shell, Docker, SSH, or a cloud sandbox. StarNet's first parity step is the same
   seam. This module keeps the local backend behavior-compatible, and adds a
   Docker backend that runs commands in one durable, per-agent container against
   the same workspace bind mount.

   makeEnvironmentManager({ spawn, fs, pathMod, root, bg?, clock?, env?, config? })
     -> { backendId, describe, ensureReady, cleanupAgent, cleanupIdle, syncWorkspace, ensureWorkspace, workspaceRoot, getCwd,
          rememberCwd, execute, startBackground, statusBackground, readBackground,
          writeBackground, closeBackgroundStdin, killBackground, spawnStdio }
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
  /* The `_`-boundary requirement meant a CONCATENATED name never matched, so the ambient secrets people
     actually have leaked straight into every task child's env: STRIPE_APIKEY, ANTHROPIC_APIKEY, GITHUB_PAT,
     FOO_ACCESSTOKEN. (StarNet's own KEYS vars always end in _API_KEY, which is why this never showed up in
     our own fixtures.) Keep the boundary form for the words that read as prose (PASS, AUTH, KEY) and add
     the glued spellings that are unambiguous on their own. */
  const SECRET_ENV_NAME_RE = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|BEARER|COOKIE|CREDENTIAL)(?:_|$)|(?:APIKEY|ACCESSTOKEN|ACCESSKEY|SECRETKEY|AUTHTOKEN|APITOKEN|PRIVATEKEY|PASSWD)|(?:^|_)PAT(?:_|$)/i;
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
  // Case-fold on Windows — the second copy of the same defect fixed in shell.js withinJail. The cwd compared
  // here is a REMEMBERED one (getCwd/rememberCwd), so a path that IS inside the workspace but spells a segment
  // differently was judged outside and the remembered cwd was silently dropped. Fail-closed, never a hole.
  function hostInside(P, cwd, base) {
    try {
      let r = P.resolve(cwd), b = P.resolve(base);
      if (P.sep === '\\') { r = r.toLowerCase(); b = b.toLowerCase(); }
      return r === b || r.indexOf(b + P.sep) === 0;
    } catch (_) { return false; }
  }
  function posixInside(cwd, base) {
    cwd = String(cwd || '');
    base = String(base || '/workspace').replace(/\/+$/, '') || '/';
    return cwd === base || cwd.indexOf(base + '/') === 0;
  }
  // Docker names must be stable across sidecar restarts without leaking an absolute host path. FNV-1a is
  // sufficient here: this is a collision-avoidance suffix, not an authority or cryptographic identity.
  function stableHash(value) {
    let h = 0x811c9dc5;
    const s = String(value == null ? '' : value);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
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

      if (opts.input != null && child.stdin) {
        try {
          if (typeof child.stdin.write === 'function') child.stdin.write(String(opts.input));
          if (typeof child.stdin.end === 'function') child.stdin.end();
        } catch (e) {
          try { killTree(spawn, child, isWin); } catch (_) {}
          return reject(new Error('could not write environment process input: ' + ((e && e.message) || e)));
        }
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
      dockerExtraArgs: Array.isArray(overrides.dockerExtraArgs) ? overrides.dockerExtraArgs : readListEnv(firstEnv(env, ['STARNET_DOCKER_EXTRA_ARGS'], '')),
      sshBin: overrides.sshBin || firstEnv(env, ['STARNET_SSH_BIN'], 'ssh'),
      scpBin: overrides.scpBin || firstEnv(env, ['STARNET_SCP_BIN'], 'scp'),
      sshConnectTimeoutSeconds: clamp(overrides.sshConnectTimeoutSeconds || firstEnv(env, ['STARNET_SSH_CONNECT_TIMEOUT_SECONDS'], '10'), 3, 60)
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
    // The RUN's surface rides along: servicekeys.runEnv withholds any key without an unattended grant on a
    // non-interactive surface, so the hook must know which kind of run is asking. Undefined = un-wired caller.
    const serviceEnvFn = typeof deps.serviceEnv === 'function' ? deps.serviceEnv : null;
    function spawnEnv(surface) {
      if (!serviceEnvFn) return childEnv;
      try { return mergeServiceEnv(childEnv, serviceEnvFn(surface)); } catch (_) { return childEnv; }
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
      supports: { shell: true, background: !!bg, hostWorkspace: true, workspaceSync: false, checkpoints: true, hostileCodeSandbox: false, persistentSession: false, stdioMcp: false },
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
          spawnOptions: { cwd: opts.cwd || getCwd(aid), shell: true, windowsHide: true, env: spawnEnv(opts.surface) },
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
        return bg.start({ agentId: aid, cmd: opts.cmd, cwd: opts.cwd || getCwd(aid), isWin: isWin, env: spawnEnv(opts.surface) });
      },
      statusBackground: function (agentId, bgId) {
        return bg && typeof bg.status === 'function' ? bg.status(safeAgentId(agentId || 'agent'), bgId) : (bgId ? null : []);
      },
      readBackground: function (agentId, bgId, opts) {
        return bg && typeof bg.read === 'function' ? bg.read(safeAgentId(agentId || 'agent'), bgId, opts) : { ok: false, error: 'background processes are not available for the local backend' };
      },
      writeBackground: function (agentId, bgId, opts) {
        return bg && typeof bg.write === 'function' ? bg.write(safeAgentId(agentId || 'agent'), bgId, opts) : { ok: false, error: 'background processes are not available for the local backend' };
      },
      closeBackgroundStdin: function (agentId, bgId) {
        return bg && typeof bg.closeStdin === 'function' ? bg.closeStdin(safeAgentId(agentId || 'agent'), bgId) : { ok: false, error: 'background processes are not available for the local backend' };
      },
      killBackground: function (agentId, bgId) {
        return bg && typeof bg.kill === 'function' ? bg.kill(safeAgentId(agentId || 'agent'), bgId) : { ok: false, error: 'background processes are not available for the local backend' };
      },
      killAllBackground: function (agentId) {
        return bg && typeof bg.killAll === 'function' ? bg.killAll(agentId) : 0;
      },
      // MCP stdio is arbitrary local code. The interactive host backend is intentionally never a
      // process broker for it; callers must select an environment that proves hostile-code isolation.
      spawnStdio: function () {
        throw new Error('mcp stdio requires an isolated execution backend');
      }
    };
  }

  function makeDockerBackend(deps) {
    const spawn = deps.spawn, fs = deps.fs, P = deps.pathMod, ROOT = deps.root;
    const clock = deps.clock || { now: function () { return 0; } };
    const cfg = deps.config || {};
    const sessions = new Map();
    const ready = new Set();
    const ensuring = new Map();
    const active = new Map();
    const lastUsed = new Map();
    const runtimeStatus = { state: 'unknown', error: null };
    const cleanupStatus = { lastSweepAt: 0, stopped: [], error: null };
    const rootIdentity = stableHash(P.resolve ? P.resolve(ROOT) : ROOT);
    const containerRoot = String(cfg.dockerWorkspace || '/workspace').replace(/\/+$/, '') || '/workspace';
    // Same contract as the local backend: resolved PER CALL, fail-open, never a boot-time snapshot.
    const serviceEnvFn = typeof deps.serviceEnv === 'function' ? deps.serviceEnv : null;
    const idleCleanupMsFn = typeof deps.idleCleanupMs === 'function' ? deps.idleCleanupMs : function () { return 0; };
    function nowMs() { try { return Number(clock.now()) || 0; } catch (_) { return 0; } }
    function touch(agentId) { lastUsed.set(safeAgentId(agentId), nowMs()); }
    function activeCount(agentId) { return Number(active.get(safeAgentId(agentId)) || 0); }
    function backgroundRunning(agentId) {
      try {
        const rows = deps.bg && typeof deps.bg.status === 'function' ? deps.bg.status(safeAgentId(agentId)) : [];
        const running = Array.isArray(rows) && rows.some(function (row) { return row && row.running; });
        if (running) touch(agentId); // idle time starts after the latest sweep that still proved work alive
        return running;
      } catch (_) { return true; }
    }
    function begin(agentId) {
      const aid = safeAgentId(agentId);
      active.set(aid, activeCount(aid) + 1); touch(aid);
      return function () {
        const left = Math.max(0, activeCount(aid) - 1);
        if (left) active.set(aid, left); else active.delete(aid);
        touch(aid);
      };
    }
    function withActivity(agentId, work) {
      const done = begin(agentId);
      let value;
      try { value = work(); } catch (e) { done(); throw e; }
      return Promise.resolve(value).then(function (result) { done(); return result; }, function (e) { done(); throw e; });
    }
    function serviceEnvFor(surface) {
      if (!serviceEnvFn) return {};
      try {
        const raw = serviceEnvFn(surface) || {};
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
    function cwdStatePath(agentId) {
      return P.join(ROOT, '.environment', safeAgentId(agentId || 'agent') + '.cwd');
    }
    function containerName(agentId) {
      const aid = safeAgentId(agentId || 'agent');
      return 'starnet-' + rootIdentity + '-' + stableHash(aid) + '-' + aid.toLowerCase();
    }
    function ensureWorkspace(agentId) {
      const dir = workspaceRoot(agentId);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      return dir;
    }
    function getCwd(agentId) {
      const aid = safeAgentId(agentId || 'agent');
      ensureWorkspace(aid);
      let cwd = sessions.get(aid);
      if (!cwd && fs.readFileSync) {
        try { cwd = String(fs.readFileSync(cwdStatePath(aid), 'utf8') || '').trim(); } catch (_) {}
        if (cwd && posixInside(cwd, containerRoot)) sessions.set(aid, cwd);
      }
      return cwd && posixInside(cwd, containerRoot) ? cwd : containerRoot;
    }
    function rememberCwd(agentId, cwd) {
      const aid = safeAgentId(agentId || 'agent');
      if (cwd && posixInside(cwd, containerRoot)) {
        sessions.set(aid, cwd);
        // The file lives outside the mounted agent workspace, so task code cannot forge a cwd receipt. It is
        // only convenience state and is revalidated against containerRoot on every read.
        try {
          const state = cwdStatePath(aid);
          fs.mkdirSync(P.dirname(state), { recursive: true });
          const tmp = state + '.tmp-' + String((typeof process !== 'undefined' && process.pid) || 0);
          fs.writeFileSync(tmp, String(cwd), 'utf8');
          fs.renameSync(tmp, state);
        } catch (_) {}
      }
      return getCwd(aid);
    }
    // Service keys reach the container WITHOUT ever appearing on the command line. `docker exec -e NAME`
    // with NO `=value` tells docker to read that variable from ITS OWN environment and forward it, so the
    // argv carries only the NAME (safe in any `ps` listing) while the value travels in the docker client's
    // env — which is why serviceEnvFor() is merged into spawnOptions.env below rather than interpolated
    // here. This is the reason not to use `-e NAME=value` or a temp --env-file: no secret on argv, no
    // secret on disk. Resolved per call, so a key added or revoked after boot takes effect on the next run.
    function dockerCreateArgs(agentId) {
      const hostRoot = workspaceRoot(agentId);
      const args = ['create'];
      if (cfg.dockerSecurity !== false) args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256');
      if (cfg.dockerNetwork) args.push('--network', String(cfg.dockerNetwork));
      if (cfg.dockerCpus) args.push('--cpus', String(cfg.dockerCpus));
      if (cfg.dockerMemory) args.push('--memory', String(cfg.dockerMemory));
      for (let i = 0; i < (cfg.dockerExtraArgs || []).length; i++) args.push(String(cfg.dockerExtraArgs[i]));
      // Put identity after owner-configurable extras so duplicate --name/--label flags cannot make StarNet
      // lose the deterministic handle or ownership receipt it later verifies before reuse.
      args.push('--name', containerName(agentId),
        '--label', 'ai.starnet.managed=1',
        '--label', 'ai.starnet.workspace=' + rootIdentity,
        '--label', 'ai.starnet.agent=' + agentId);
      args.push('--volume', hostRoot + ':' + containerRoot);
      args.push('--workdir', containerRoot);
      args.push(String(cfg.dockerImage || DEFAULT_DOCKER_IMAGE));
      // A boring PID 1 keeps the writable container layer (installed packages, caches, image env) alive.
      // Foreground/background work is always a separately owned `docker exec` child.
      args.push('sh', '-lc', 'trap "exit 0" TERM INT; while :; do sleep 3600; done');
      return args;
    }

    function dockerExecArgs(agentId, cmd, cwd, envNames) {
      const args = ['exec', '-i'];
      for (const n of (envNames || [])) args.push('-e', n);
      args.push('--workdir', cwd || containerRoot, containerName(agentId), 'sh', '-lc', String(cmd || ''));
      return args;
    }

    function dockerClientEnv(extra) {
      const names = Object.keys(extra || {});
      return names.length
        ? mergeServiceEnv(sanitizeChildEnv(deps.env || (typeof process !== 'undefined' ? process.env : {})), extra)
        : undefined;
    }

    /* Start one duplex MCP child INSIDE an already-probed per-agent container. This is deliberately
       synchronous because the stdio transport lazily asks for a ChildProcess when its first JSON-RPC
       frame is sent; configureConnectorCfg performs the asynchronous ensureReady() before the manager
       is allowed to build this transport.

       No shell is involved. The connector command and every argument become exact docker-exec argv.
       Environment VALUES ride only in the docker client's environment; `docker exec -e NAME` forwards
       them by name, keeping tokens out of process listings. Host secrets were removed by
       sanitizeChildEnv(), while the user-supplied connector env is the only secret-bearing overlay. */
    function spawnStdio(opts) {
      opts = opts || {};
      const aid = safeAgentId(opts.agentId || 'agent');
      if (!ready.has(aid)) throw new Error('isolated MCP environment is not ready for ' + aid);
      const command = String(opts.command || '').trim();
      if (!command || /[\0\r\n]/.test(command)) throw new Error('invalid mcp stdio command');
      const commandArgs = Array.isArray(opts.args) ? opts.args.map(function (v) { return String(v == null ? '' : v); }) : [];
      const cwd = opts.cwd ? String(opts.cwd) : getCwd(aid);
      if (!posixInside(cwd, containerRoot)) throw new Error('mcp stdio cwd must stay inside ' + containerRoot);

      const supplied = opts.env && typeof opts.env === 'object' && !Array.isArray(opts.env) ? opts.env : {};
      const forwarded = {};
      for (const k of Object.keys(supplied)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error('invalid mcp stdio env name: ' + k);
        if (INTERNAL_ENV_NAME_RE.test(k) || EXECUTION_HOOK_ENV_RE.test(k)) continue;
        if (supplied[k] != null) forwarded[k] = String(supplied[k]);
      }
      // These host-owned values are the defense-in-depth floor inside the MCP server too. They are
      // added after the connector overlay, so a saved connector can never replace them.
      forwarded.STARNET_USER_CONTROL_MODE = 'preserve';
      forwarded.STARNET_COMPUTER_DRIVER = '0';
      forwarded.STARNET_BROWSER_HEADLESS = '1';
      forwarded.STARNET_MCP_STDIO = '0';
      forwarded.BROWSER = 'none';

      const args = ['exec', '-i'];
      for (const name of Object.keys(forwarded).sort()) args.push('-e', name);
      args.push('--workdir', cwd, containerName(aid), command);
      for (const value of commandArgs) args.push(value);
      const clientEnv = Object.assign({}, sanitizeChildEnv(deps.env || (typeof process !== 'undefined' ? process.env : {})), forwarded);
      const spawnOptions = opts.spawnOptions || {};
      const release = begin(aid);
      let child;
      try { child = spawn(cfg.dockerBin || 'docker', args, {
        stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
        detached: !!spawnOptions.detached, env: clientEnv
      }); } catch (e) { release(); throw e; }
      let released = false;
      const finish = function () { if (!released) { released = true; release(); } };
      if (child && typeof child.once === 'function') { child.once('close', finish); child.once('error', finish); }
      else if (child && typeof child.on === 'function') { child.on('close', finish); child.on('error', finish); }
      else finish();
      return child;
    }

    function dockerRun(args, opts) {
      opts = opts || {};
      return runProcess({
        spawn: spawn,
        file: cfg.dockerBin || 'docker',
        args: args,
        spawnOptions: opts.env ? { windowsHide: true, env: opts.env } : { windowsHide: true },
        timeoutMs: opts.timeoutMs || 30000,
        maxTimeoutMs: opts.maxTimeoutMs || 600000,
        maxBytes: opts.maxBytes || 64000,
        signal: opts.signal,
        clock: opts.clock || clock,
        isWin: WIN
      });
    }

    function inspectContainer(agentId) {
      const format = '{{.State.Running}}\t{{index .Config.Labels "ai.starnet.workspace"}}\t{{index .Config.Labels "ai.starnet.agent"}}';
      return dockerRun(['inspect', '--format', format, containerName(agentId)], { timeoutMs: 10000, maxBytes: 4096 })
        .then(function (r) {
          if (r.exitCode !== 0) return { exists: false, running: false };
          const parts = String(r.out || '').trim().split('\t');
          if (parts[1] !== rootIdentity || parts[2] !== agentId) {
            throw new Error('refusing Docker container name collision for ' + containerName(agentId));
          }
          return { exists: true, running: parts[0] === 'true' };
        });
    }

    function ensureContainer(agentId, force) {
      const aid = safeAgentId(agentId || 'agent');
      ensureWorkspace(aid);
      if (!force && ready.has(aid)) return Promise.resolve({ ok: true, reused: true, container: containerName(aid) });
      if (ensuring.has(aid)) return ensuring.get(aid);
      const promise = inspectContainer(aid).then(function (state) {
        if (state.exists && state.running) return { reused: true };
        if (state.exists) {
          return dockerRun(['start', containerName(aid)], { timeoutMs: 30000 }).then(function (r) {
            if (r.exitCode !== 0) throw new Error('could not start persistent Docker environment: ' + String(r.out || '').trim());
            return { reused: true };
          });
        }
        return dockerRun(dockerCreateArgs(aid), { timeoutMs: 120000 }).then(function (created) {
          if (created.exitCode !== 0) throw new Error('could not create persistent Docker environment: ' + String(created.out || '').trim());
          return dockerRun(['start', containerName(aid)], { timeoutMs: 30000 }).then(function (started) {
            if (started.exitCode !== 0) throw new Error('could not start persistent Docker environment: ' + String(started.out || '').trim());
            return { reused: false };
          });
        });
      }).then(function (state) {
        return dockerRun(['exec', '--workdir', containerRoot, containerName(aid), 'sh', '-lc', 'test -d . && printf starnet-ready'], { timeoutMs: 10000, maxBytes: 4096 })
          .then(function (probe) {
            if (probe.exitCode !== 0 || String(probe.out || '').indexOf('starnet-ready') < 0) {
              throw new Error('persistent Docker environment failed its startup probe');
            }
            ready.add(aid);
            runtimeStatus.state = 'ready'; runtimeStatus.error = null;
            return { ok: true, reused: state.reused, container: containerName(aid) };
          });
      });
      ensuring.set(aid, promise);
      return promise.then(function (v) { ensuring.delete(aid); return v; }, function (e) {
        ensuring.delete(aid); ready.delete(aid);
        runtimeStatus.state = 'unavailable';
        runtimeStatus.error = String((e && e.message) || e || 'Docker environment unavailable').slice(0, 300);
        throw e;
      });
    }

    function cleanupAgent(agentId, opts) {
      const aid = safeAgentId(agentId || 'agent');
      opts = opts || {};
      if (opts.onlyIfIdle && !ready.has(aid)) {
        return Promise.resolve({ ok: false, refused: true, reason: 'cell is not owned by this live sidecar session', removed: false, container: containerName(aid) });
      }
      if (opts.onlyIfIdle && (activeCount(aid) > 0 || backgroundRunning(aid))) {
        return Promise.resolve({ ok: false, refused: true, reason: 'environment is active', removed: false, container: containerName(aid) });
      }
      return inspectContainer(aid).then(function (owned) {
        if (!owned.exists) return { ok: true, removed: false, alreadyAbsent: true, container: containerName(aid), out: '' };
        const args = opts.remove === false
          ? ['stop', '--time', String(clamp(opts.timeoutSeconds || 3, 0, 30)), containerName(aid)]
          : ['rm', '--force', containerName(aid)];
        return dockerRun(args, { timeoutMs: 30000 }).then(function (r) {
          const ok = r.exitCode === 0;
          if (ok) {
            ready.delete(aid);
            sessions.delete(aid);
            if (opts.remove !== false) { try { fs.unlinkSync(cwdStatePath(aid)); } catch (_) {} }
          }
          return { ok, removed: ok && opts.remove !== false, container: containerName(aid), out: String(r.out || '').trim() };
        });
      });
    }

    async function cleanupIdle(agentIds, opts) {
      opts = opts || {};
      const idleMs = clamp(opts.idleMs == null ? idleCleanupMsFn() : opts.idleMs, 0, 24 * 60 * 60 * 1000);
      const at = opts.now == null ? nowMs() : Number(opts.now);
      const stopped = [], skipped = [];
      if (!idleMs) return { ok: true, enabled: false, idleMs: 0, checked: 0, stopped, skipped, at };
      const ids = Array.isArray(agentIds) ? agentIds : Array.from(ready);
      for (const raw of ids) {
        let aid; try { aid = safeAgentId(raw); } catch (_) { continue; }
        if (!ready.has(aid)) { skipped.push({ agentId: aid, reason: 'not owned by this live sidecar' }); continue; }
        if (activeCount(aid) > 0 || backgroundRunning(aid)) { skipped.push({ agentId: aid, reason: 'active' }); continue; }
        const last = Number(lastUsed.get(aid));
        if (!Number.isFinite(last) || at - last < idleMs) { skipped.push({ agentId: aid, reason: 'not idle long enough' }); continue; }
        try {
          const result = await cleanupAgent(aid, { remove: false, onlyIfIdle: true, timeoutSeconds: opts.timeoutSeconds });
          if (result && result.ok) stopped.push(aid);
          else skipped.push({ agentId: aid, reason: (result && (result.reason || result.out)) || 'stop failed' });
        } catch (e) {
          skipped.push({ agentId: aid, reason: String((e && e.message) || e || 'stop failed').slice(0, 300) });
        }
      }
      cleanupStatus.lastSweepAt = at;
      cleanupStatus.stopped = stopped.slice();
      cleanupStatus.error = null;
      return { ok: true, enabled: true, idleMs, checked: ids.length, stopped, skipped, at };
    }

    return {
      id: 'docker',
      supports: { shell: true, background: !!(deps.bg && typeof deps.bg.start === 'function'), hostWorkspace: true, workspaceSync: false, checkpoints: true, hostileCodeSandbox: true, persistentSession: true, stdioMcp: true },
      describe: function () {
        return {
          backend: 'docker', image: cfg.dockerImage || DEFAULT_DOCKER_IMAGE, workspace: containerRoot, hostRoot: ROOT,
          background: !!(deps.bg && typeof deps.bg.start === 'function'),
          availability: { state: runtimeStatus.state, checked: runtimeStatus.state !== 'unknown', error: runtimeStatus.error },
          persistence: { container: 'per-agent', restartReuse: true, writableLayer: true, cwd: true, readyAgents: ready.size },
          idleCleanup: { enabled: Number(idleCleanupMsFn()) > 0, idleMs: Number(idleCleanupMsFn()) || 0, activeAgents: active.size, lastSweepAt: cleanupStatus.lastSweepAt, lastStopped: cleanupStatus.stopped.slice(), deletesContainers: false },
          safeCell: {
            default: false,
            hostileCodeSandbox: true,
            controls: ['per-agent bind mount', 'container cwd clamp', 'cap-drop ALL', 'no-new-privileges', 'PID limit', 'startup probe', 'foreground timeout/abort kill', 'deterministic labeled ownership']
          }
        };
      },
      ensureReady: function (agentId) { touch(safeAgentId(agentId || 'agent')); return ensureContainer(agentId, false); },
      cleanupAgent: cleanupAgent,
      cleanupIdle: cleanupIdle,
      syncWorkspace: function (agentId) { return Promise.resolve({ ok: true, needed: false, agentId: safeAgentId(agentId || 'agent'), backend: 'docker' }); },
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
        const svc = serviceEnvFor(opts.surface);
        const names = Object.keys(svc);
        return withActivity(aid, function () { return ensureContainer(aid, false).then(function () {
          return dockerRun(dockerExecArgs(aid, opts.cmd, cwd, names), {
            env: dockerClientEnv(svc), timeoutMs: opts.timeoutMs, maxTimeoutMs: opts.maxTimeoutMs,
            maxBytes: opts.maxBytes, signal: opts.signal, clock: opts.clock || clock
          });
        }); });
      },
      startBackground: function (opts) {
        opts = opts || {};
        const bg = deps.bg;
        if (!bg || typeof bg.start !== 'function') return Promise.resolve({ ok: false, error: 'background processes are not available for the docker backend' });
        const aid = safeAgentId(opts.agentId || 'agent');
        const svc = serviceEnvFor(opts.surface);
        touch(aid);
        return ensureContainer(aid, false).then(function () {
          return bg.start({
            agentId: aid, cmd: String(opts.cmd || ''), cwd: workspaceRoot(aid), isWin: WIN,
            file: cfg.dockerBin || 'docker', args: dockerExecArgs(aid, opts.cmd, opts.cwd || getCwd(aid), Object.keys(svc)),
            env: dockerClientEnv(svc)
          });
        });
      },
      statusBackground: function (agentId, bgId) { return deps.bg && deps.bg.status ? deps.bg.status(safeAgentId(agentId || 'agent'), bgId) : (bgId ? null : []); },
      readBackground: function (agentId, bgId, opts) { return deps.bg && deps.bg.read ? deps.bg.read(safeAgentId(agentId || 'agent'), bgId, opts) : { ok: false, error: 'background processes are not available for the docker backend' }; },
      writeBackground: function (agentId, bgId, opts) { return deps.bg && deps.bg.write ? deps.bg.write(safeAgentId(agentId || 'agent'), bgId, opts) : { ok: false, error: 'background processes are not available for the docker backend' }; },
      closeBackgroundStdin: function (agentId, bgId) { return deps.bg && deps.bg.closeStdin ? deps.bg.closeStdin(safeAgentId(agentId || 'agent'), bgId) : { ok: false, error: 'background processes are not available for the docker backend' }; },
      killBackground: function (agentId, bgId) { return deps.bg && deps.bg.kill ? deps.bg.kill(safeAgentId(agentId || 'agent'), bgId) : { ok: false, error: 'background processes are not available for the docker backend' }; },
      killAllBackground: function (agentId) { return deps.bg && deps.bg.killAll ? deps.bg.killAll(agentId) : 0; },
      spawnStdio: spawnStdio,
      _internals: { dockerCreateArgs: dockerCreateArgs, dockerExecArgs: dockerExecArgs, containerName: containerName, inspectContainer: inspectContainer, posixInside: posixInside, spawnStdio: spawnStdio, active: active, lastUsed: lastUsed }
    };
  }

  function makeSshBackend(deps) {
    const spawn = deps.spawn, fs = deps.fs, P = deps.pathMod, ROOT = deps.root;
    const clock = deps.clock || { now: function () { return 0; } };
    const cfg = deps.config || {};
    const targetFn = typeof deps.sshConfig === 'function' ? deps.sshConfig : function () { return null; };
    const serviceEnvFn = typeof deps.serviceEnv === 'function' ? deps.serviceEnv : null;
    const states = new Map();
    const sessions = new Map();
    const operations = new Map();

    function nowMs() { try { return Number(clock.now()) || 0; } catch (_) { return 0; } }
    function quote(value) { return "'" + String(value == null ? '' : value).replace(/'/g, "'\\''") + "'"; }
    function target(agentId) {
      const aid = safeAgentId(agentId || 'agent');
      const row = targetFn(aid);
      if (!row || !row.configured || !row.host) throw new Error('SSH target is not configured for ' + aid);
      return {
        host: String(row.host), user: String(row.user || ''), port: clamp(row.port || 22, 1, 65535),
        remoteRoot: String(row.remoteRoot || '/workspace').replace(/\/+$/, '') || '/workspace'
      };
    }
    function signature(row) { return [row.host, row.user, row.port, row.remoteRoot].join('\n'); }
    function stateFor(agentId) {
      const aid = safeAgentId(agentId || 'agent');
      let state = states.get(aid);
      if (!state) {
        state = { availability: 'unknown', error: null, signature: '', lastProbeAt: 0, sync: { state: 'never', direction: null, error: null, lastPushAt: 0, lastPullAt: 0 } };
        states.set(aid, state);
      }
      return state;
    }
    function enqueue(agentId, work) {
      const aid = safeAgentId(agentId || 'agent');
      const previous = operations.get(aid) || Promise.resolve();
      const current = previous.catch(function () {}).then(work);
      operations.set(aid, current);
      return current.finally(function () { if (operations.get(aid) === current) operations.delete(aid); });
    }
    function workspaceRoot(agentId) { return P.join(ROOT, safeAgentId(agentId || 'agent')); }
    function ensureWorkspace(agentId) {
      const dir = workspaceRoot(agentId);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      return dir;
    }
    function getCwd(agentId) {
      const aid = safeAgentId(agentId || 'agent'), row = target(aid), saved = sessions.get(aid);
      return saved && posixInside(saved, row.remoteRoot) ? saved : row.remoteRoot;
    }
    function rememberCwd(agentId, cwd) {
      const aid = safeAgentId(agentId || 'agent'), row = target(aid);
      if (cwd && posixInside(cwd, row.remoteRoot)) sessions.set(aid, String(cwd));
      return getCwd(aid);
    }
    function destination(row) { return (row.user ? row.user + '@' : '') + row.host; }
    function commonOptions(row) {
      return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=' + String(cfg.sshConnectTimeoutSeconds || 10)];
    }
    function childEnv() { return sanitizeChildEnv(deps.env || (typeof process !== 'undefined' ? process.env : {})); }
    function runSsh(row, script, opts) {
      opts = opts || {};
      const args = commonOptions(row).concat(['-p', String(row.port), destination(row), 'sh', '-s']);
      return runProcess({
        spawn, file: cfg.sshBin || 'ssh', args,
        spawnOptions: { windowsHide: true, shell: false, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
        input: String(script || ''), timeoutMs: opts.timeoutMs || 30000, maxTimeoutMs: opts.maxTimeoutMs || 600000,
        maxBytes: opts.maxBytes || 64000, signal: opts.signal, clock: opts.clock || clock, isWin: WIN
      });
    }
    function runScp(row, source, destinationPath, opts) {
      opts = opts || {};
      const args = ['-q', '-r', '-p'].concat(commonOptions(row), ['-P', String(row.port), source, destinationPath]);
      return runProcess({
        spawn, file: cfg.scpBin || 'scp', args,
        spawnOptions: { windowsHide: true, shell: false, env: childEnv(), cwd: ROOT },
        timeoutMs: opts.timeoutMs || 120000, maxTimeoutMs: opts.maxTimeoutMs || 600000,
        maxBytes: opts.maxBytes || 64000, signal: opts.signal, clock: opts.clock || clock, isWin: WIN
      });
    }
    function assertLocalTreeSafe(agentId) {
      const root = ensureWorkspace(agentId), stack = [root];
      let seen = 0;
      while (stack.length) {
        const current = stack.pop();
        const names = fs.readdirSync(current);
        for (const name of names) {
          if (++seen > 100000) throw new Error('workspace sync refused: local tree exceeds the 100000-entry safety bound');
          const full = P.join(current, name), stat = fs.lstatSync(full);
          if (stat.isSymbolicLink()) throw new Error('workspace sync refused: symbolic links are not allowed (' + P.relative(root, full) + ')');
          if (stat.isDirectory()) stack.push(full);
        }
      }
    }
    function assertRemoteTreeSafe(row, opts) {
      const script = 'if find ' + quote(row.remoteRoot) + ' -type l -print -quit | grep -q .; then printf starnet-sync-symlink; exit 96; fi\nprintf starnet-sync-safe\n';
      return runSsh(row, script, { timeoutMs: opts.timeoutMs, maxTimeoutMs: opts.maxTimeoutMs, maxBytes: 4096, signal: opts.signal }).then(function (result) {
        if (result.exitCode !== 0 || String(result.out || '').indexOf('starnet-sync-safe') < 0) throw new Error('workspace pull refused: remote tree contains a symbolic link or could not be verified');
      });
    }
    function ensureReadyRaw(agentId) {
      const aid = safeAgentId(agentId || 'agent'), row = target(aid), state = stateFor(aid), sig = signature(row);
      ensureWorkspace(aid);
      if (state.availability === 'ready' && state.signature === sig) return Promise.resolve({ ok: true, reused: true, backend: 'ssh', agentId: aid });
      state.availability = 'checking'; state.error = null; state.signature = sig;
      const script = 'mkdir -p ' + quote(row.remoteRoot) + '\n' +
        'test -d ' + quote(row.remoteRoot) + ' && printf starnet-ssh-ready\n';
      return runSsh(row, script, { timeoutMs: Math.max(10000, (cfg.sshConnectTimeoutSeconds || 10) * 1000 + 3000), maxBytes: 4096 })
        .then(function (result) {
          state.lastProbeAt = nowMs();
          if (result.exitCode !== 0 || String(result.out || '').indexOf('starnet-ssh-ready') < 0) {
            throw new Error('SSH readiness probe failed' + (result.out ? ': ' + String(result.out).trim().slice(0, 200) : ''));
          }
          state.availability = 'ready'; state.error = null;
          return { ok: true, reused: false, backend: 'ssh', agentId: aid };
        }).catch(function (e) {
          state.availability = 'unavailable'; state.error = String((e && e.message) || e || 'SSH unavailable').slice(0, 300); state.lastProbeAt = nowMs();
          throw e;
        });
    }
    function syncWorkspaceRaw(agentId, opts) {
      opts = opts || {};
      const aid = safeAgentId(agentId || 'agent'), row = target(aid), state = stateFor(aid);
      const direction = ['push', 'pull', 'both'].indexOf(String(opts.direction || 'both')) >= 0 ? String(opts.direction || 'both') : 'both';
      ensureWorkspace(aid);
      state.sync.state = 'syncing'; state.sync.direction = direction; state.sync.error = null;
      const remote = destination(row) + ':' + row.remoteRoot;
      return ensureReadyRaw(aid).then(async function () {
        if (direction === 'push' || direction === 'both') {
          assertLocalTreeSafe(aid);
          const pushed = await runScp(row, aid + '/.', remote + '/', opts);
          if (pushed.exitCode !== 0) throw new Error('workspace push failed' + (pushed.out ? ': ' + String(pushed.out).trim().slice(0, 200) : ''));
          state.sync.lastPushAt = nowMs();
        }
        if (direction === 'pull' || direction === 'both') {
          await assertRemoteTreeSafe(row, opts);
          const pulled = await runScp(row, remote + '/.', aid, opts);
          if (pulled.exitCode !== 0) throw new Error('workspace pull failed' + (pulled.out ? ': ' + String(pulled.out).trim().slice(0, 200) : ''));
          state.sync.lastPullAt = nowMs();
        }
        state.sync.state = 'ready'; state.sync.direction = direction; state.sync.error = null;
        return { ok: true, needed: true, backend: 'ssh', agentId: aid, direction, lastPushAt: state.sync.lastPushAt, lastPullAt: state.sync.lastPullAt };
      }).catch(function (e) {
        state.sync.state = 'error'; state.sync.error = String((e && e.message) || e || 'workspace sync failed').slice(0, 300);
        throw e;
      });
    }
    function ensureReady(agentId) {
      const aid = safeAgentId(agentId || 'agent');
      return enqueue(aid, function () { return ensureReadyRaw(aid); });
    }
    function syncWorkspace(agentId, opts) {
      const aid = safeAgentId(agentId || 'agent');
      return enqueue(aid, function () { return syncWorkspaceRaw(aid, opts); });
    }
    function serviceEnv(surface) {
      const out = {};
      if (serviceEnvFn) {
        try {
          const raw = serviceEnvFn(surface) || {};
          for (const name of Object.keys(raw)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || INTERNAL_ENV_NAME_RE.test(name) || EXECUTION_HOOK_ENV_RE.test(name)) continue;
            if (raw[name] != null && raw[name] !== '') out[name] = String(raw[name]);
          }
        } catch (_) {}
      }
      out.STARNET_USER_CONTROL_MODE = 'preserve';
      out.STARNET_COMPUTER_DRIVER = '0';
      out.STARNET_BROWSER_HEADLESS = '1';
      out.STARNET_MCP_STDIO = '0';
      out.BROWSER = 'none';
      return out;
    }
    function execute(opts) {
      opts = opts || {};
      const aid = safeAgentId(opts.agentId || 'agent');
      return enqueue(aid, function () {
        const row = target(aid), cwd = opts.cwd || getCwd(aid);
        if (!posixInside(cwd, row.remoteRoot)) throw new Error('SSH cwd must stay inside ' + row.remoteRoot);
        return syncWorkspaceRaw(aid, { direction: 'push', timeoutMs: opts.timeoutMs, maxTimeoutMs: opts.maxTimeoutMs, signal: opts.signal }).then(function () {
          const env = serviceEnv(opts.surface);
          let script = 'cd ' + quote(cwd) + ' || exit 97\n';
          for (const name of Object.keys(env).sort()) script += 'export ' + name + '=' + quote(env[name]) + '\n';
          script += String(opts.cmd || '') + '\n';
          return runSsh(row, script, opts);
        }).then(function (result) {
          return syncWorkspaceRaw(aid, { direction: 'pull', timeoutMs: opts.timeoutMs, maxTimeoutMs: opts.maxTimeoutMs, signal: opts.signal })
            .then(function () { return result; });
        });
      });
    }
    function describe(agentId) {
      let row = null, state = null;
      try { if (agentId) { row = target(agentId); state = stateFor(agentId); } } catch (_) {}
      return {
        backend: 'ssh', workspace: row ? row.remoteRoot : null, hostWorkspace: false, background: false,
        availability: { state: row ? state.availability : 'configuration-required', checked: !!(state && state.lastProbeAt), error: state ? state.error : null },
        remote: row ? { configured: true, host: row.host, user: row.user, port: row.port, remoteRoot: row.remoteRoot, auth: 'os-openssh', strictHostKeyChecking: true } : { configured: false },
        sync: state ? Object.assign({}, state.sync) : { state: 'never', direction: null, error: null, lastPushAt: 0, lastPullAt: 0 },
        safeCell: { default: false, hostileCodeSandbox: false, controls: ['strict known_hosts', 'batch-only authentication', 'remote workspace clamp', 'push before command', 'pull after command', 'foreground timeout/abort kill'] }
      };
    }
    function invalidateAgent(agentId) { states.delete(safeAgentId(agentId || 'agent')); sessions.delete(safeAgentId(agentId || 'agent')); return { ok: true }; }

    return {
      id: 'ssh',
      supports: { shell: true, background: false, hostWorkspace: false, workspaceSync: true, checkpoints: false, hostileCodeSandbox: false, persistentSession: false, stdioMcp: false },
      describe, ensureReady, cleanupAgent: function (agentId) { invalidateAgent(agentId); return Promise.resolve({ ok: true, removed: false, backend: 'ssh', disconnected: true }); },
      cleanupIdle: function () { return Promise.resolve({ ok: true, enabled: false, idleMs: 0, checked: 0, stopped: [], skipped: [] }); },
      syncWorkspace, invalidateAgent, workspaceRoot, ensureWorkspace, getCwd, rememberCwd, execute,
      startBackground: function () { return Promise.resolve({ ok: false, error: 'background processes are not available for the SSH backend; run it in the foreground or use a remote service manager' }); },
      statusBackground: function (_agentId, bgId) { return bgId ? null : []; },
      readBackground: function () { return { ok: false, error: 'background processes are not available for the SSH backend' }; },
      writeBackground: function () { return { ok: false, error: 'background processes are not available for the SSH backend' }; },
      closeBackgroundStdin: function () { return { ok: false, error: 'background processes are not available for the SSH backend' }; },
      killBackground: function () { return { ok: false, error: 'background processes are not available for the SSH backend' }; },
      killAllBackground: function () { return 0; },
      spawnStdio: function () { throw new Error('mcp stdio is not available through the SSH backend'); },
      _internals: { states, operations, target, runSsh, runScp, quote, assertLocalTreeSafe, assertRemoteTreeSafe }
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
    else if (config.backend === 'ssh') backend = makeSshBackend(Object.assign({}, deps, { config: config }));
    else throw new Error('unknown execution backend "' + config.backend + '" (expected local, docker, or ssh)');

    return {
      backendId: backend.id,
      supports: backend.supports,
      describe: backend.describe,
      ensureReady: backend.ensureReady || function (agentId) { backend.ensureWorkspace(agentId); return Promise.resolve({ ok: true, backend: backend.id }); },
      cleanupAgent: backend.cleanupAgent || function () { return Promise.resolve({ ok: false, error: 'the local backend has no persistent environment to remove' }); },
      cleanupIdle: backend.cleanupIdle || function () { return Promise.resolve({ ok: true, enabled: false, idleMs: 0, checked: 0, stopped: [], skipped: [] }); },
      syncWorkspace: backend.syncWorkspace || function (agentId) { return Promise.resolve({ ok: true, needed: false, agentId: safeAgentId(agentId || 'agent'), backend: backend.id }); },
      invalidateAgent: backend.invalidateAgent || function () { return { ok: true }; },
      workspaceRoot: backend.workspaceRoot,
      ensureWorkspace: backend.ensureWorkspace,
      getCwd: backend.getCwd,
      rememberCwd: backend.rememberCwd,
      execute: backend.execute,
      startBackground: backend.startBackground,
      statusBackground: backend.statusBackground,
      readBackground: backend.readBackground,
      writeBackground: backend.writeBackground,
      closeBackgroundStdin: backend.closeBackgroundStdin,
      killBackground: backend.killBackground,
      killAllBackground: backend.killAllBackground,
      spawnStdio: backend.spawnStdio,
      _backend: backend,
      _internals: { safeAgentId: safeAgentId, makeConfig: makeConfig, sanitizeChildEnv: sanitizeChildEnv, mergeServiceEnv: mergeServiceEnv, runProcess: runProcess, hostInside: hostInside, posixInside: posixInside, stableHash: stableHash }
    };
  }

  return { makeEnvironmentManager: makeEnvironmentManager, makeConfig: makeConfig, sanitizeChildEnv: sanitizeChildEnv, safeAgentId: safeAgentId, runProcess: runProcess };
});
