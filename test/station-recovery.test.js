/* node test/station-recovery.test.js — complete-station disaster recovery contract.

   Uses only disposable directories. It proves a populated station can cross into a clean profile, system
   credentials are excluded with exact reauthentication receipts, corrupt/incomplete bundles fail closed,
   interrupted/disk-full backups preserve the prior artifact, and an older bundle can atomically replace a
   newer restored generation while retaining that newer generation for rollback.
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const A = require('./_assert.js');
const R = require('../sidecar/station-recovery.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-disaster-recovery-'));
const source = path.join(tmp, 'source-profile', 'workspaces');
const backups = path.join(tmp, 'backups');

function write(rel, value) {
  const file = path.join(source, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2));
}
function read(root, rel) { return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'); }
function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function seedCompleteStation() {
  fs.mkdirSync(source, { recursive: true });
  write('agent.roster.json', { version: 1, agents: [{ agentId: 'agent', name: 'NOVA', provider: 'openrouter', model: 'test/model' }, { agentId: 'scribe', name: 'SCRIBE', provider: 'openai', model: 'test/other' }] });
  write('agent.save.json', { version: 1, agentId: 'agent', updatedAt: 100, savedAt: 100, doc: { schema: 'starnet.save', version: 6, updatedAt: 100, agent: { id: 'agent', name: 'NOVA' }, station: { rooms: [{ id: 'command' }], props: [{ id: 'terminal-1', roomId: 'command' }] }, workstreams: [{ id: 'general', title: 'General', messages: [{ role: 'user', content: 'preserve this conversation' }] }] } });
  write('transcript.jsonl', JSON.stringify({ workstreamId: 'general', role: 'assistant', content: 'conversation survives', ts: 1 }) + '\n');
  write('channels/agent.history.json', { version: 1, messages: [{ role: 'user', content: 'telegram conversation', ts: 2 }] });
  write('agent.notebook.json', { entries: [{ id: 'memory-1', title: 'Remember', body: 'the station' }] });
  write('_commander.dossier.json', { version: 1, block: 'Commander context' });
  write('cron.jobs.json', { version: 1, jobs: [{ id: 'routine-1', schedule: '0 9 * * 1-5', prompt: 'weekday briefing' }] });
  write('loops.json', { version: 1, loops: [{ id: 'loop-1', objective: 'keep testing until green', status: 'active' }] });
  write('agent.todo.json', { items: [{ id: 'task-1', text: 'ship recovery', done: false }] });
  write('_station.quests.json', { version: 1, quests: [{ id: 'quest-1', title: 'Restore station', state: 'open' }] });
  write('projects.json', { version: 1, projects: [{ id: 'project-1', root: 'C:/Projects/demo', blessed: true }] });
  write('agent.deliverables.json', { version: 1, records: [{ id: 'deliverable-1', path: 'agent/workshop/run-1/report.md', state: 'kept' }] });
  write('agent/workshop/run-1/report.md', '# Recovery report\nUser-created deliverable bytes survive.\n');
  write('permissions.allow.json', { version: 1, allow: ['fs.write:workspace', 'shell.exec:*'] });
  write('connectors/state.json', { version: 2, configs: [{ id: 'notion', transport: 'http', url: 'https://mcp.example/api?token=URL_SECRET', headers: { Authorization: 'Bearer MCP_SECRET', 'X-Safe': 'kept' }, oauth: true }], oauth: { byId: { notion: { accessToken: 'ACCESS_SECRET', refreshToken: 'REFRESH_SECRET', clientId: 'client-id', tokenEndpoint: 'https://auth.example/token' } }, clients: { 'https://auth.example': { clientId: 'dynamic-client', clientSecret: 'CLIENT_SECRET' } } } });
  write('channels/secrets.json', { telegram: { enabled: true, botName: 'station-bot', token: 'TELEGRAM_SECRET', key: 'PROVIDER_SECRET' }, notifyAutonomous: true });
  write('connectors/servicekeys.json', { version: 1, keys: [{ id: 'weather', name: 'Weather', env: 'WEATHER_API_KEY', key: 'SERVICE_SECRET', enabled: true }] });
  write('.secrets/spotify.json', { accessToken: 'SPOTIFY_SECRET' });
  write('codex/auth.json', { access_token: 'CODEX_SECRET' });
  write('.browser-profile/Cookies', 'COOKIE_SECRET');
  write('proc-ledger.json', { procs: [{ pid: 1 }] });
  write('.recovery-mutation.json', { lastCompletedMutation: 100 });
}

seedCompleteStation();
const browserV1 = {
  'starnet.save': JSON.stringify({ schema: 'starnet.save', version: 6, updatedAt: 100, agent: { id: 'agent', name: 'NOVA' }, station: { rooms: [{ id: 'command' }], props: [{ id: 'terminal-1' }] } }),
  'starnet.station.v1': JSON.stringify({ selectedRoom: 'command', camera: { x: 5, y: 7 } }),
  'starnet.queststate.v1': JSON.stringify({ seen: ['quest-1'] }),
  'starnet.byok.model': 'test/model',
  'starnet.byok.key': 'BROWSER_SECRET',
  'foreign.app': 'not ours'
};

// A. A complete quiescent station produces a checksum-bound, credential-free bundle.
const v1 = R.capture({ workspaceRoot: source, browserStore: browserV1, now: 1000, appVersion: '0.9.0-test', lastCompletedMutation: 100 });
A.eq(v1.schema, R.SCHEMA, 'bundle schema is explicit');
A.eq(v1.version, R.VERSION, 'bundle version is explicit');
A.eq(v1.report.complete, true, 'all required semantic categories are present');
A.eq(v1.report.requirements.filter(x => x.status === 'present').length, R.REQUIRED_CATEGORIES.length, 'every required category is accounted for');
A.eq(v1.recoveryPoint.completedMutationsLostAtPoint, 0, 'successful quiescent snapshot establishes zero loss through its mutation barrier');
A.eq(v1.recoveryPoint.continuousRpoCompletedMutations, null, 'bundle does not invent an unproven continuous RPO');
const bundleText = JSON.stringify(v1);
for (const secret of ['URL_SECRET', 'MCP_SECRET', 'ACCESS_SECRET', 'REFRESH_SECRET', 'CLIENT_SECRET', 'TELEGRAM_SECRET', 'PROVIDER_SECRET', 'SERVICE_SECRET', 'SPOTIFY_SECRET', 'CODEX_SECRET', 'COOKIE_SECRET', 'BROWSER_SECRET']) {
  A.ok(bundleText.indexOf(secret) < 0, 'bundle excludes secret: ' + secret);
}
A.ok(v1.report.reauthentication.some(x => x.kind === 'connector' && x.id === 'notion'), 'connector reference survives with OAuth reauthentication receipt');
A.ok(v1.report.reauthentication.some(x => x.kind === 'channel' && x.id === 'telegram'), 'channel reference survives with token reauthentication receipt');
A.ok(v1.report.reauthentication.some(x => x.kind === 'service-key' && x.id === 'weather'), 'service key reference survives with reauthentication receipt');
A.ok(v1.report.skipped.some(x => x.path === '.browser-profile/Cookies'), 'browser cookie profile is explicitly skipped');
A.ok(v1.report.skipped.some(x => x.path === 'proc-ledger.json'), 'ephemeral process ownership is explicitly skipped');
A.eq(R.validate(v1).ok, true, 'fresh bundle validates');

// B. Atomic bundle creation and genuinely clean-profile restore preserve the semantic fingerprint.
fs.mkdirSync(backups, { recursive: true });
const v1File = path.join(backups, 'station-v1.starnet-recovery.json');
const receipt = R.writeBundleAtomic({ bundle: v1, file: v1File, nonce: 'v1' });
A.ok(receipt.ok && fs.existsSync(v1File), 'verified bundle commits atomically');
const loadedV1 = R.readBundle(v1File);
A.eq(loadedV1.manifestSha256, v1.manifestSha256, 'read bundle preserves manifest identity');
const cleanTarget = path.join(tmp, 'clean-profile', 'workspaces');
const cleanBrowser = {};
const restoredV1 = R.restore({ bundle: loadedV1, targetRoot: cleanTarget, browserSink: cleanBrowser, nonce: 'clean' });
A.eq(restoredV1.ok, true, 'complete bundle restores onto a clean profile');
A.eq(restoredV1.rollback, null, 'clean restore needs no rollback generation');
A.eq(cleanBrowser['starnet.station.v1'], browserV1['starnet.station.v1'], 'browser-owned station layout state restores');
A.eq(cleanBrowser['starnet.byok.key'], undefined, 'browser credential is not restored');
A.ok(read(cleanTarget, 'agent/workshop/run-1/report.md').includes('User-created deliverable bytes survive'), 'deliverable bytes restore');
const recaptured = R.capture({ workspaceRoot: cleanTarget, browserStore: cleanBrowser, now: 1001, appVersion: '0.9.0-test', lastCompletedMutation: 100 });
A.eq(JSON.stringify(R.semanticFingerprint(recaptured)), JSON.stringify(R.semanticFingerprint(v1)), 'clean-profile semantic fingerprint exactly matches the recovery point');

// C. Corrupt archives fail before touching the requested destination.
const corrupt = JSON.parse(JSON.stringify(v1));
corrupt.files.find(x => x.path === 'loops.json').data = Buffer.from('corrupted').toString('base64');
A.eq(R.validate(corrupt).ok, false, 'corrupt payload is detected');
const corruptTarget = path.join(tmp, 'corrupt-target');
A.throws(() => R.restore({ bundle: corrupt, targetRoot: corruptTarget }), 'corrupt bundle restore is refused');
A.eq(fs.existsSync(corruptTarget), false, 'corrupt restore leaves no destination behind');

// D. Missing required files are reported and cannot become a supposedly complete backup.
const missingRoot = path.join(tmp, 'missing-profile');
fs.cpSync(source, missingRoot, { recursive: true });
fs.unlinkSync(path.join(missingRoot, 'loops.json'));
const missing = R.capture({ workspaceRoot: missingRoot, browserStore: browserV1, now: 1100, lastCompletedMutation: 100 });
A.eq(missing.report.complete, false, 'missing loop store makes the station bundle incomplete');
A.ok(missing.report.requirements.some(x => x.category === 'loops' && x.status === 'missing'), 'missing category is named exactly');
A.throws(() => R.writeBundleAtomic({ bundle: missing, file: path.join(backups, 'incomplete.json') }), 'incomplete bundle is not committed as a recovery point');

// E. Interrupted backup and disk-full failures preserve the prior verified backup byte-for-byte.
const stableFile = path.join(backups, 'stable.json');
R.writeBundleAtomic({ bundle: v1, file: stableFile, nonce: 'stable' });
const stableHash = hashFile(stableFile);
A.throws(() => R.writeBundleAtomic({ bundle: v1, file: stableFile, nonce: 'interrupt', beforeCommit() { throw new Error('simulated power loss'); } }), 'interrupted backup reports failure');
A.eq(hashFile(stableFile), stableHash, 'interrupted backup preserves the previous recovery point');
A.eq(fs.readdirSync(backups).some(x => x.includes('interrupt')), false, 'interrupted temp file is cleaned');
const diskFullFs = new Proxy(fs, {
  get(target, prop) {
    if (prop === 'writeFileSync') return function (fd, data) {
      if (typeof fd === 'number') { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; }
      return target.writeFileSync(fd, data);
    };
    const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v;
  }
});
A.throws(() => R.writeBundleAtomic({ bundle: v1, file: stableFile, nonce: 'enospc', fs: diskFullFs }), 'disk-full backup reports failure');
A.eq(hashFile(stableFile), stableHash, 'disk-full failure preserves the previous recovery point');

// F. A newer station can roll back to a prior version while retaining the replaced generation.
write('agent.todo.json', { items: [{ id: 'task-1', text: 'ship recovery', done: true }, { id: 'task-2', text: 'post-v1 mutation', done: false }] });
write('.recovery-mutation.json', { lastCompletedMutation: 101 });
const browserV2 = Object.assign({}, browserV1, { 'starnet.station.v1': JSON.stringify({ selectedRoom: 'lab', camera: { x: 9, y: 9 } }) });
const v2 = R.capture({ workspaceRoot: source, browserStore: browserV2, now: 2000, appVersion: '0.9.1-test', lastCompletedMutation: 101 });
const rollbackTarget = path.join(tmp, 'rollback-profile', 'workspaces');
const rollbackBrowser = {};
R.restore({ bundle: v2, targetRoot: rollbackTarget, browserSink: rollbackBrowser, nonce: 'v2' });
A.ok(read(rollbackTarget, 'agent.todo.json').includes('task-2'), 'newer generation is active before rollback');
const rollbackReceipt = R.restore({ bundle: v1, targetRoot: rollbackTarget, browserSink: rollbackBrowser, replaceExisting: true, nonce: 'v1-rollback', rollbackId: 'newer-generation' });
A.ok(rollbackReceipt.rollback && fs.existsSync(rollbackReceipt.rollback), 'replaced newer generation is retained');
A.ok(!read(rollbackTarget, 'agent.todo.json').includes('task-2'), 'previous recovery point becomes active');
A.ok(read(rollbackReceipt.rollback, 'agent.todo.json').includes('task-2'), 'newer generation remains recoverable after rollback');
A.eq(rollbackBrowser['starnet.station.v1'], browserV1['starnet.station.v1'], 'browser-owned state rolls back with the workspace generation');

// G. Restore activation failure cannot displace a currently healthy generation.
const beforeActivationHash = hashFile(path.join(rollbackTarget, 'agent.todo.json'));
A.throws(() => R.restore({ bundle: v2, targetRoot: rollbackTarget, replaceExisting: true, nonce: 'activation-fail', rollbackId: 'should-not-exist', beforeActivate() { throw new Error('injected activation failure'); } }), 'activation failure is reported');
A.eq(hashFile(path.join(rollbackTarget, 'agent.todo.json')), beforeActivationHash, 'activation failure leaves current generation unchanged');
A.eq(fs.existsSync(rollbackTarget + '.rollback-should-not-exist'), false, 'activation failure creates no false rollback generation');

fs.rmSync(tmp, { recursive: true, force: true });
A.report('station-recovery.test');
