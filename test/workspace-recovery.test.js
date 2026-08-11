/* node test/workspace-recovery.test.js — stranded-root discovery, redaction and atomic activation. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Recovery = require('../sidecar/workspace-recovery.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-workspace-recovery-'));
const current = path.join(home, 'Library', 'Application Support', 'ai.skynet.harness', 'workspaces');
const legacyA = path.join(home, '.local', 'share', 'StarNet', 'workspaces');
const legacyB = path.join(home, '.local', 'share', 'Skynet', 'workspaces');

function save(name, updatedAt, marker) {
  return {
    version: 1, agentId: 'agent', updatedAt, savedAt: updatedAt,
    doc: {
      schema: 'starnet.save', version: 5, updatedAt,
      agent: { id: 'agent', name }, station: { rooms: [{ id: marker }], props: [] },
      workstreams: [{ id: 'general', history: [{ role: 'user', content: marker }] }]
    }
  };
}
function write(root, rel, value) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

try {
  write(current, '.migration-receipt.json', { version: 1, validated: true, files: [] });
  write(current, '.migrated', '1');
  write(legacyA, 'agent.save.json', save('NOVA', 1000, 'legacy-a'));
  write(legacyA, 'agent/report.md', 'source must stay byte-exact');
  write(legacyA, '.starnet-workspace-owner.json', JSON.stringify({ pid: 999999 }));

  const one = Recovery.inspectCandidates({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA, legacyB] });
  A.eq(one.recoverableCount, 1, 'one valid stranded station is recoverable');
  A.eq(one.automaticCandidateId, one.candidates[0].id, 'one valid root is an unambiguous automatic candidate');
  A.ok(one.candidates[0].displayRoot.startsWith('~'), 'candidate path redacts the user home');
  A.eq(one.candidates[0].stationName, 'NOVA', 'candidate names the station from the valid save envelope');
  A.eq(Recovery._internals.displayPath('D:\\Profiles\\StarNet\\workspaces', 'C:\\Users\\Ada', require('node:path').win32, 'win32'),
    '[local-data]/StarNet/workspaces', 'a custom data shelf outside the home is never disclosed as an absolute path');

  const report = Recovery.recoveryReport({ fs, path, platform: 'darwin', arch: 'x64', home, workspaceRoot: current, candidateRoots: [legacyA], inspection: one, publicLineage: { evidence: [] } });
  const reportRaw = JSON.stringify(report);
  A.eq(report.architecture, 'x64', 'report records Intel architecture truthfully');
  A.ok(reportRaw.indexOf(home) < 0, 'redacted report contains no absolute user-home path');
  A.ok(reportRaw.indexOf('legacy-a') < 0 && reportRaw.indexOf('source must stay') < 0, 'report contains no save or artifact contents');

  const sourceHash = Recovery._internals.sha256(fs.readFileSync(path.join(legacyA, 'agent.save.json')));
  const requested = Recovery.requestRecovery({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA], inspection: one, candidateId: one.automaticCandidateId });
  A.eq(requested.ok, true, 'authenticated selection produces a pending recovery request');
  const applied = Recovery.applyPendingRecovery({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA], now: () => 2000 });
  A.eq(applied.applied, true, 'next pre-store boot activates the requested station');
  A.eq(JSON.parse(fs.readFileSync(path.join(current, 'agent.save.json'), 'utf8')).doc.agent.name, 'NOVA', 'selected station is active');
  A.eq(fs.readFileSync(path.join(current, 'agent', 'report.md'), 'utf8'), 'source must stay byte-exact', 'complete selected generation is active');
  A.eq(Recovery._internals.sha256(fs.readFileSync(path.join(legacyA, 'agent.save.json'))), sourceHash, 'legacy source remains byte-exact');
  A.eq(fs.existsSync(path.join(legacyA, '.starnet-workspace-owner.json')), true, 'source is not cleaned or mutated');
  A.eq(fs.existsSync(path.join(current, '.starnet-workspace-owner.json')), false, 'stale runtime ownership is not copied into the active generation');
  A.ok(fs.readdirSync(path.dirname(current)).some(name => name.startsWith('workspaces.recovery-rollback-')), 'prior current generation is retained as rollback');
  A.eq(Recovery.readRootCandidate(current, { fs, path }).stationName, 'NOVA', 'fresh store boot can read the recovered canonical save');
  fs.writeFileSync(Recovery._internals.lastResultFile(current, path), JSON.stringify({ ok: false, error: 'rename failed at ' + legacyA }));
  const redactedFailure = Recovery.recoveryReport({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA] });
  A.ok(!JSON.stringify(redactedFailure).includes(home), 'support report redacts absolute paths from recovery errors too');

  // Reset to an empty active root and prove two distinct valid stations require an explicit choice.
  fs.rmSync(current, { recursive: true, force: true });
  write(current, '.migrated', '1');
  write(legacyB, 'agent.save.json', save('ORION', 2000, 'legacy-b'));
  const conflict = Recovery.inspectCandidates({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA, legacyB] });
  A.eq(conflict.recoverableCount, 2, 'both valid station generations are shown');
  A.eq(conflict.distinctSaveCount, 2, 'different save bytes are identified as a real conflict');
  A.eq(conflict.automaticCandidateId, null, 'conflict has no automatic winner');
  const untouched = Recovery.applyPendingRecovery({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA, legacyB], auto: true });
  A.eq(untouched.applied, false, 'automatic boot refuses to choose between stations');
  A.eq(fs.existsSync(path.join(current, 'agent.save.json')), false, 'conflict leaves active workspace empty and unmodified');

  const selectedB = conflict.candidates.find(row => row.stationName === 'ORION');
  Recovery.requestRecovery({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA, legacyB], inspection: conflict, candidateId: selectedB.id });
  const resolved = Recovery.applyPendingRecovery({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA, legacyB], now: () => 3000 });
  A.eq(resolved.stationName, 'ORION', 'explicit conflict selection activates exactly the chosen station');
  A.eq(JSON.parse(fs.readFileSync(path.join(current, 'agent.save.json'), 'utf8')).doc.station.rooms[0].id, 'legacy-b', 'unselected station never contaminates the chosen generation');

  // An unreadable save remains visible for reporting but can never become a selectable request.
  fs.rmSync(current, { recursive: true, force: true });
  fs.rmSync(legacyA, { recursive: true, force: true });
  fs.rmSync(legacyB, { recursive: true, force: true });
  write(legacyA, 'agent.save.json', '{not json');
  const invalid = Recovery.inspectCandidates({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA] });
  A.eq(invalid.candidates[0].recoverable, false, 'invalid prior save is disclosed without claiming recoverability');
  A.throws(() => Recovery.requestRecovery({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA], inspection: invalid, candidateId: invalid.candidates[0].id }), 'invalid candidate cannot be requested');

  // Concurrency: activation is serialized behind the PARENT-level recovery lock. A live holder
  // fails the second boot CLOSED (no mutation, request untouched); a provably-dead holder's lock
  // is broken and recovery proceeds.
  fs.rmSync(current, { recursive: true, force: true });
  fs.rmSync(legacyA, { recursive: true, force: true });
  write(current, '.migrated', '1');
  write(legacyA, 'agent.save.json', save('VEGA', 4000, 'legacy-lock'));
  const lockInspection = Recovery.inspectCandidates({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA] });
  Recovery.requestRecovery({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA], inspection: lockInspection, candidateId: lockInspection.automaticCandidateId, now: () => 4500 });
  const lockfile = Recovery._internals.recoveryLockFile(current, path);
  A.ok(lockfile.indexOf(current + path.sep) < 0, 'recovery lock lives BESIDE the workspace root, never inside the directory recovery renames');
  fs.writeFileSync(lockfile, '999999:cafe');   // a concurrent holder's stamp
  const refused = Recovery.applyPendingRecovery({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA], now: () => 5000, lockPidAlive: () => true });
  A.eq(refused.lockUnavailable, true, 'a live-held recovery lock refuses a second activation');
  A.eq(refused.applied, false, 'refused activation applies nothing');
  A.eq(fs.existsSync(Recovery._internals.requestFile(current, path)), true, 'refused activation leaves the pending request untouched');
  A.eq(fs.existsSync(path.join(current, 'agent.save.json')), false, 'refused activation never mutates the active workspace');
  A.eq(fs.readFileSync(lockfile, 'utf8'), '999999:cafe', 'refused activation never steals the live holder\'s lock');
  fs.utimesSync(lockfile, 0, 0);
  const agedLiveRefused = Recovery.applyPendingRecovery({
    fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA],
    now: () => 9 * 60 * 1000, lockMaxRunMs: 8 * 60 * 1000, lockPidAlive: () => true
  });
  A.eq(agedLiveRefused.lockUnavailable, true, 'an aged recovery lock is NEVER stolen while its holder pid is still alive');
  A.eq(fs.readFileSync(lockfile, 'utf8'), '999999:cafe', 'the aged live holder keeps the exact parent-level lock stamp');
  A.eq(fs.existsSync(path.join(current, 'agent.save.json')), false, 'an aged live holder still blocks every workspace mutation');
  const reclaimed = Recovery.applyPendingRecovery({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA], now: () => 6000, lockPidAlive: () => false });
  A.eq(reclaimed.applied, true, 'a provably-dead holder\'s stale lock is broken and recovery proceeds');
  A.eq(JSON.parse(fs.readFileSync(path.join(current, 'agent.save.json'), 'utf8')).doc.agent.name, 'VEGA', 'stale-break activation lands the requested station');
  A.eq(fs.existsSync(lockfile), false, 'recovery lock is released after activation');

  // Size guard: a pathological source fails CLOSED with a clear error before it can be buffered.
  fs.rmSync(current, { recursive: true, force: true });
  fs.rmSync(legacyA, { recursive: true, force: true });
  write(current, '.migrated', '1');
  write(legacyA, 'agent.save.json', save('RIGEL', 7000, 'legacy-big'));
  write(legacyA, 'artifacts/huge.bin', 'x'.repeat(4096));
  const bigInspection = Recovery.inspectCandidates({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA] });
  Recovery.requestRecovery({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA], inspection: bigInspection, candidateId: bigInspection.automaticCandidateId, now: () => 7500 });
  const tooBig = Recovery.applyPendingRecovery({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA], now: () => 8000, maxTotalBytes: 1024 });
  A.eq(tooBig.ok, false, 'over-limit aggregate recovery source fails closed');
  A.eq(tooBig.applied, false, 'over-limit source applies nothing');
  A.ok(/too large/.test(String(tooBig.error)), 'aggregate failure names the size limit: ' + tooBig.error);
  A.eq(fs.existsSync(path.join(current, 'agent.save.json')), false, 'over-limit source never mutates the active workspace');
  A.eq(fs.existsSync(Recovery._internals.requestFile(current, path)), false, 'failed over-limit request is retired, not retried forever');
  Recovery.requestRecovery({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA], inspection: bigInspection, candidateId: bigInspection.automaticCandidateId, now: () => 8500 });
  const fileTooBig = Recovery.applyPendingRecovery({ fs, path, platform: 'darwin', home, workspaceRoot: current, candidateRoots: [legacyA], now: () => 9000, maxFileBytes: 256 });
  A.eq(fileTooBig.ok, false, 'a single over-limit file fails the recovery closed');
  A.ok(/per-file/.test(String(fileTooBig.error)), 'per-file failure names the per-file limit: ' + fileTooBig.error);
  A.eq(fs.existsSync(path.join(current, 'agent.save.json')), false, 'per-file over-limit source never mutates the active workspace');

  A.report('workspace-recovery.test');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
