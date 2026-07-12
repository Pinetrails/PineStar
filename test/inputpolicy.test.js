/* node test/inputpolicy.test.js — ordinary run capabilities are synthetic-only. */
'use strict';
const A = require('./_assert.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeComputerTools } = require('../sidecar/tools/builtin/computer.js');
const { makeDesktopTools } = require('../sidecar/tools/builtin/desktop.js');
const { enforceSyntheticOnly, runInputContext, backgroundOwnsLoopbackUrl, backgroundOwnsLocalUrl, makeLoopbackListenerProbe } = require('../sidecar/inputpolicy.js');

const station = {
  agents: { ag: { id: 'ag', room: 'r' } },
  rooms: { r: { id: 'r', objects: [{ objectType: 'computer' }, { objectType: 'workbench' }, { objectType: 'dish' }] } }
};
const raw = resolveTools('ag', station);
A.ok(!raw.tools.includes('computer.use'), 'ordinary capability telemetry never advertises physical input');
A.ok(!raw.tools.includes('desktop.open'), 'ordinary capability telemetry never advertises real-screen launch');
// Also simulate a stale/forged legacy resolver result: the per-run policy must still strip it.
const legacyRaw = Object.assign({}, raw, {
  tools: raw.tools.concat('computer.use', 'desktop.open'),
  grants: raw.grants.concat(
    { capId: 'workbench', tool: 'computer.use', scope: 'execute', requiresConsent: true, network: false },
    { capId: 'web', tool: 'desktop.open', scope: 'execute', requiresConsent: true, network: true }
  ),
  approvalRules: Object.assign({}, raw.approvalRules, {
    'computer.use': { requiresConsent: true, scope: 'execute', network: false },
    'desktop.open': { requiresConsent: true, scope: 'execute', network: true }
  }),
  networkCaps: Object.assign({}, raw.networkCaps, { 'computer.use': false, 'desktop.open': true })
});
const safe = enforceSyntheticOnly(legacyRaw);
A.ok(!safe.tools.includes('computer.use'), 'physical input is absent from provider/dispatch tool names');
A.ok(!safe.tools.includes('desktop.open'), 'real-window launch is absent from provider/dispatch tool names');
A.ok(!safe.grants.some(g => g.tool === 'computer.use'), 'physical input is absent from resolved grant telemetry');
A.ok(!safe.grants.some(g => g.tool === 'desktop.open'), 'real-window launch is absent from resolved grant telemetry');
A.eq(safe.approvalRules['computer.use'], undefined, 'physical input has no ordinary approval rule');
A.eq(safe.approvalRules['desktop.open'], undefined, 'real-window launch has no ordinary approval rule');
A.ok(safe.tools.includes('shell.exec') && safe.tools.includes('verify.run'), 'workbench build/test tools remain available');
A.ok(safe.tools.includes('browser.test_navigate') && safe.tools.includes('browser.test_input') && safe.tools.includes('browser.test_state'), 'safe local CDP route replaces physical input');
A.ok(legacyRaw.tools.includes('computer.use') && legacyRaw.tools.includes('desktop.open'), 'policy returns an isolated copy and does not corrupt source results');

for (const [surface, isTask] of [['interactive', true], ['autonomous', true], ['test', false]]) {
  const ctx = runInputContext(surface, isTask);
  A.eq(ctx.physicalInputAuthorized, false, surface + ' context has explicit physical-input deny');
  A.eq(ctx.inputMode, 'synthetic', surface + ' context is synthetic-only');
}

const viteFallback = { running: true, killed: false, cmd: 'vite --port 5173', tail: '\u001b[32mLocal: http://localhost:5174/\u001b[0m' };
A.eq(backgroundOwnsLoopbackUrl(viteFallback, 'http://127.0.0.1:5173/'), false, 'requested command port cannot impersonate another localhost service after dev-server fallback');
A.eq(backgroundOwnsLoopbackUrl(viteFallback, 'http://127.0.0.1:5174/'), true, 'actual advertised loopback endpoint is accepted for the owned background handle');
A.eq(backgroundOwnsLoopbackUrl(Object.assign({}, viteFallback, { running: false }), 'http://127.0.0.1:5174/'), false, 'exited background server owns no local test URL');
A.eq(backgroundOwnsLoopbackUrl({ running: true, tail: 'Local: https://[::1]:4443/' }, 'https://localhost:4443/'), true, 'IPv6 loopback advertisement binds by actual port');

(async () => {
  const probeCalls = [];
  const ownedProbe = makeLoopbackListenerProbe({
    platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
    execFile: (exe, args, options, cb) => { probeCalls.push({ exe, args, options }); cb(null, '', ''); }
  });
  const ownedStatus = { running: true, killed: false, pid: 4321, tail: 'Local: http://localhost:5174/' };
  A.eq(await backgroundOwnsLocalUrl(ownedStatus, 'http://127.0.0.1:5174/', ownedProbe), true, 'advertised endpoint is accepted only after OS listener ancestry proof');
  A.ok(/powershell/i.test(probeCalls[0].exe) && probeCalls[0].args.some(x => /\$root=4321/.test(x)), 'Windows listener probe binds the check to the background root PID');
  A.ok(probeCalls[0].args.some(x => /foreach\(\$owner in \$owners\)[\s\S]*if\(-not \$owned\)\{exit 3\}[\s\S]*exit 0/.test(x)), 'mixed owned/unowned listeners fail closed instead of accepting the first owned PID');
  A.eq(await backgroundOwnsLocalUrl(ownedStatus, 'http://127.0.0.1:5174/', async () => false), false, 'spoofed stdout URL cannot authorize a listener owned by another process');
  A.eq(await backgroundOwnsLocalUrl(Object.assign({}, ownedStatus, { pid: null }), 'http://127.0.0.1:5174/', ownedProbe), false, 'missing background PID fails listener ownership closed');
  let driverCalls = 0, openerCalls = 0;
  const registry = makeRegistry();
  makeComputerTools({ allowPhysicalInput: true, driver: { perform: async () => { driverCalls++; return {}; } } }).register(registry);
  makeDesktopTools({ opener: async () => { openerCalls++; return 'opened'; } }).register(registry);
  const exposed = registry.wireFormat(registry.list(safe.tools)).map(x => x.function.name);
  A.ok(!exposed.includes('computer.use') && !exposed.includes('desktop.open'), 'provider wire format contains no real-input/real-screen tool');
  const ctx = Object.assign(makeCapCtx(safe), {
    // Simulate the strongest consent bypass: capability denial must still win first.
    consent: async () => ({ allow: true, reason: 'full-access' }),
    surface: 'interactive', isTask: false, physicalInputAuthorized: true, inputMode: 'attended'
  });
  const computer = await registry.dispatch({ id: 'c1', name: 'computer.use', args: { action: 'screenshot' } }, ctx);
  const desktop = await registry.dispatch({ id: 'c2', name: 'desktop.open', args: { target: 'notepad' } }, ctx);
  A.eq(computer.summary, 'capdenied', 'forged computer.use is capability-denied even with full consent');
  A.eq(desktop.summary, 'capdenied', 'forged desktop.open is capability-denied even with full consent');
  A.eq(driverCalls, 0, 'forged physical-input dispatch never reaches the driver');
  A.eq(openerCalls, 0, 'forged real-window dispatch never reaches the opener');
  A.report('inputpolicy.test');
})().catch(e => { console.error(e); process.exit(1); });
