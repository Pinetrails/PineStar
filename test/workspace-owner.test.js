/* node test/workspace-owner.test.js — process-wide ownership for StarNet's single-writer stores. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const { makeWorkspaceOwner } = require('../sidecar/workspace-owner.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-owner-'));
const lockfile = path.join(root, '.starnet-workspace-owner.json');
try {
  const first = makeWorkspaceOwner({ fs, path, pid: 41001, now: () => 100, nonce: () => 'first', pidAlive: p => p === 41001 });
  const a = first.acquire(root);
  A.eq(a.ok, true, 'first sidecar owns a free workspace');
  A.eq(JSON.parse(fs.readFileSync(lockfile, 'utf8')).pid, 41001, 'claim identifies its holder');

  const second = makeWorkspaceOwner({ fs, path, pid: 41002, now: () => 200, nonce: () => 'second', pidAlive: p => p === 41001 });
  const blocked = second.acquire(root);
  A.eq(blocked.ok, false, 'a second live sidecar is refused');
  A.eq(blocked.code, 'WORKSPACE_BUSY', 'collision fails with the stable safety code');
  A.eq(blocked.holder.pid, 41001, 'collision names the current holder');

  A.eq(second.release(), false, 'a non-owner cannot release another process claim');
  A.eq(fs.existsSync(lockfile), true, 'the legitimate holder claim remains');
  A.eq(first.release(), true, 'the legitimate holder can release');
  A.eq(fs.existsSync(lockfile), false, 'clean release removes the claim');

  const crashed = makeWorkspaceOwner({ fs, path, pid: 41003, now: () => 300, nonce: () => 'crashed', pidAlive: () => false });
  A.eq(crashed.acquire(root).ok, true, 'a replacement holder can acquire');
  // Simulate an uncatchable desktop kill: no release. A subsequent process proves the PID dead and reclaims.
  const recovered = makeWorkspaceOwner({ fs, path, pid: 41004, now: () => 400,
    nonce: (() => { let n = 0; return () => 'recovery-' + (++n); })(), pidAlive: () => false });
  A.eq(recovered.acquire(root).ok, true, 'a provably dead holder is reclaimed immediately');
  A.eq(JSON.parse(fs.readFileSync(lockfile, 'utf8')).pid, 41004, 'recovery installs the successor claim');
  A.eq(crashed.release(), false, 'a stale process instance cannot unlink its successor claim');

  recovered.release();
  fs.writeFileSync(lockfile, '{not-json');
  const cautious = makeWorkspaceOwner({ fs, path, pid: 41005, now: () => 500, nonce: () => 'cautious', pidAlive: () => false });
  const malformed = cautious.acquire(root);
  A.eq(malformed.ok, false, 'a malformed holder claim is never guessed stale');
  A.eq(malformed.code, 'WORKSPACE_BUSY', 'unprovable ownership fails closed');

  A.report('workspace-owner.test');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
