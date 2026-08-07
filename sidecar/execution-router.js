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
  if (!environments[defaultBackendId]) throw new Error('execution router missing default backend "' + defaultBackendId + '"');

  function backendForProfile(profileId) {
    profileId = String(profileId || 'station-gear');
    if (profileId === 'safe-cell') return environments.docker ? 'docker' : defaultBackendId;
    if (profileId === 'trusted-project' || profileId === 'this-computer') return environments.local ? 'local' : defaultBackendId;
    return defaultBackendId;
  }
  function backendIdFor(agentId) { return backendForProfile(profileForAgent(String(agentId || 'agent'))); }
  function forAgent(agentId) {
    const id = backendIdFor(agentId);
    return environments[id] || environments[defaultBackendId];
  }
  function fromOpts(opts) { return forAgent(opts && opts.agentId); }
  function describeAgent(agentId) {
    const backend = forAgent(agentId);
    const effectiveBackend = String(backend.backendId || backend.id || backendIdFor(agentId));
    return Object.assign({}, backend.describe(), {
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
    killAllBackground,
    _environments: environments
  };
  Object.defineProperty(api, 'backendId', { enumerable: true, get: () => defaultBackendId });
  return api;
}

module.exports = { makeExecutionRouter };
