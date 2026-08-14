/* sidecar/execution-router.js — per-agent execution backend routing.

   Execution profiles are per agent, while the original environment manager was selected once at boot.
   This facade keeps the manager contract intact and routes every operation by agent id, so choosing Safe
   Cell changes the next real command to Docker immediately instead of merely painting a requested backend.
*/
'use strict';

function makeExecutionRouter(deps) {
  deps = deps || {};
  const environments = deps.environments || {};
  const defaultBackendId = String(deps.defaultBackendId || 'local');
  const profileForAgent = typeof deps.profileForAgent === 'function' ? deps.profileForAgent : (() => 'station-gear');
  const forceLocalForAgent = typeof deps.forceLocalForAgent === 'function' ? deps.forceLocalForAgent : (() => false);
  if (!environments[defaultBackendId]) throw new Error('execution router missing default backend "' + defaultBackendId + '"');

  function backendForProfile(profileId) {
    profileId = String(profileId || 'station-gear');
    if (profileId === 'safe-cell') return environments.docker ? 'docker' : defaultBackendId;
    if (profileId === 'remote-ssh') return environments.ssh ? 'ssh' : defaultBackendId;
    if (profileId === 'trusted-project' || profileId === 'this-computer') return environments.local ? 'local' : defaultBackendId;
    return defaultBackendId;
  }
  function backendIdFor(agentId) {
    const id = String(agentId || 'agent');
    try { if (environments.local && forceLocalForAgent(id) === true) return 'local'; } catch (_) {}
    return backendForProfile(profileForAgent(id));
  }
  function forAgent(agentId) {
    const id = backendIdFor(agentId);
    return environments[id] || environments[defaultBackendId];
  }
  function fromOpts(opts) { return forAgent(opts && opts.agentId); }
  function describeAgent(agentId) {
    const backend = forAgent(agentId);
    const effectiveBackend = String(backend.backendId || backend.id || backendIdFor(agentId));
    return Object.assign({}, backend.describe(agentId), {
      routed: true,
      executionProfile: String(profileForAgent(String(agentId || 'agent')) || 'station-gear'),
      effectiveBackend
    });
  }
  function describe() {
    const base = Object.assign({}, environments[defaultBackendId].describe());
    base.routing = {
      perAgent: true,
      defaultBackend: defaultBackendId,
      availableBackends: Object.keys(environments).filter(id => environments[id])
    };
    return base;
  }
  function callAgent(method, agentId, rest) {
    const env = forAgent(agentId);
    return env[method].apply(env, [agentId].concat(rest || []));
  }
  function killAllBackground(agentId) {
    if (agentId != null) return callAgent('killAllBackground', agentId, []);
    let count = 0;
    const seen = new Set();
    for (const env of Object.values(environments)) {
      if (!env || seen.has(env) || typeof env.killAllBackground !== 'function') continue;
      seen.add(env);
      count += Number(env.killAllBackground()) || 0;
    }
    return count;
  }

  const api = {
    id: 'router',
    supports: environments[defaultBackendId].supports,
    describe,
    describeAgent,
    backendIdFor,
    backendIdForProfile: backendForProfile,
    forAgent,
    ensureReady: agentId => callAgent('ensureReady', agentId, []),
    cleanupAgent: (agentId, opts) => callAgent('cleanupAgent', agentId, [opts]),
    cleanupIdle: (agentIds, opts) => environments.docker && typeof environments.docker.cleanupIdle === 'function'
      ? environments.docker.cleanupIdle(agentIds, opts)
      : Promise.resolve({ ok: true, enabled: false, checked: 0, stopped: [], skipped: [] }),
    syncWorkspace: (agentId, opts) => callAgent('syncWorkspace', agentId, [opts]),
    invalidateAgent: agentId => callAgent('invalidateAgent', agentId, []),
    workspaceRoot: agentId => callAgent('workspaceRoot', agentId, []),
    ensureWorkspace: agentId => callAgent('ensureWorkspace', agentId, []),
    getCwd: agentId => callAgent('getCwd', agentId, []),
    rememberCwd: (agentId, cwd) => callAgent('rememberCwd', agentId, [cwd]),
    execute: opts => fromOpts(opts).execute(opts),
    startBackground: opts => fromOpts(opts).startBackground(opts),
    statusBackground: (agentId, bgId) => callAgent('statusBackground', agentId, [bgId]),
    readBackground: (agentId, bgId, opts) => callAgent('readBackground', agentId, [bgId, opts]),
    writeBackground: (agentId, bgId, opts) => callAgent('writeBackground', agentId, [bgId, opts]),
    closeBackgroundStdin: (agentId, bgId) => callAgent('closeBackgroundStdin', agentId, [bgId]),
    killBackground: (agentId, bgId) => callAgent('killBackground', agentId, [bgId]),
    spawnStdio: opts => fromOpts(opts).spawnStdio(opts),
    killAllBackground,
    _environments: environments
  };
  Object.defineProperty(api, 'backendId', { enumerable: true, get: () => defaultBackendId });
  return api;
}

module.exports = { makeExecutionRouter };
