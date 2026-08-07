'use strict';
const A = require('./_assert.js');
const { makeExecutionRouter } = require('../sidecar/execution-router.js');

const profiles = { legacy: 'station-gear', safe: 'safe-cell', trusted: 'trusted-project', host: 'this-computer' };
function fake(id) {
  return {
    id, backendId: id, supports: { hostileCodeSandbox: id === 'docker' },
    describe: () => ({ backend: id, availability: { state: id === 'docker' ? 'unknown' : 'ready' } }),
    ensureReady: agentId => Promise.resolve({ ok: true, backend: id, agentId }),
    cleanupAgent: (agentId, opts) => Promise.resolve({ ok: true, backend: id, agentId, opts }),
    workspaceRoot: agentId => id + ':root:' + agentId,
    ensureWorkspace: agentId => id + ':workspace:' + agentId,
    getCwd: agentId => id + ':cwd:' + agentId,
    rememberCwd: (agentId, cwd) => id + ':remember:' + agentId + ':' + cwd,
    execute: opts => Promise.resolve({ backend: id, opts }),
    startBackground: opts => ({ ok: true, backend: id, opts }),
    statusBackground: (agentId, bgId) => ({ backend: id, agentId, bgId }),
    readBackground: (agentId, bgId) => ({ ok: true, backend: id, agentId, bgId }),
    writeBackground: (agentId, bgId) => ({ ok: true, backend: id, agentId, bgId }),
    closeBackgroundStdin: (agentId, bgId) => ({ ok: true, backend: id, agentId, bgId }),
    killBackground: (agentId, bgId) => ({ ok: true, backend: id, agentId, bgId }),
    spawnStdio: opts => ({ backend: id, opts }),
    killAllBackground: () => 1
  };
}
const local = fake('local'), docker = fake('docker');
const router = makeExecutionRouter({
  environments: { local, docker }, defaultBackendId: 'local',
  profileForAgent: agentId => profiles[agentId] || 'station-gear'
});

A.eq(router.backendId, 'local', 'legacy backendId remains the station default for old callers');
A.eq(router.backendIdFor('legacy'), 'local', 'compatibility profile follows the station default');
A.eq(router.backendIdFor('safe'), 'docker', 'Safe Cell routes to Docker immediately');
A.eq(router.backendIdFor('trusted'), 'local', 'Trusted Project routes local');
A.eq(router.backendIdFor('host'), 'local', 'This Computer routes local');
A.eq(router.forAgent('safe').supports.hostileCodeSandbox, true, 'authority can inspect the selected isolated environment');
A.eq(router.ensureWorkspace('safe'), 'docker:workspace:safe', 'workspace calls route by agent');
A.eq(router.getCwd('trusted'), 'local:cwd:trusted', 'cwd calls route by agent');
router.execute({ agentId: 'safe', cmd: 'x' }).then(result => {
  A.eq(result.backend, 'docker', 'foreground execution uses the profile backend');
  A.eq(router.startBackground({ agentId: 'trusted', cmd: 'x' }).backend, 'local', 'background execution uses the profile backend');
  A.eq(router.statusBackground('safe', 'bg_1').backend, 'docker', 'background inspection uses the profile backend');
  A.eq(router.spawnStdio({ agentId: 'safe', command: 'node' }).backend, 'docker', 'stdio MCP spawn routes through the selected agent environment');
  A.eq(router.describeAgent('safe').effectiveBackend, 'docker', 'per-agent runtime truth names Docker');
  A.eq(router.describe().routing.perAgent, true, 'station execution status exposes dynamic routing');
  A.eq(router.killAllBackground(), 2, 'station halt reaches every distinct backend');
  A.report('execution-router.test');
}).catch(e => { console.error(e); process.exitCode = 1; });
