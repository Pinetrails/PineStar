/* sidecar/workspace-owner.js — fail-closed, process-wide ownership for one WORKSPACES root.

   StarNet's durable stores are intentionally single-writer. Atomic individual-file writes prevent torn
   files, but they cannot prevent two sidecars from loading the same snapshot and then overwriting each
   other's later changes. This owner claim makes the existing "one sidecar per WORKSPACES" invariant real.

   There is deliberately NO time-based stale break. A healthy sidecar may run for weeks; age is not proof
   that its claim is abandoned. We reclaim only when process.kill(pid, 0) proves the stamped PID is gone.
   PID reuse can therefore cause a safe false-busy, never an unsafe double-writer.

   The claim uses O_EXCL creation plus read-back verification. Crash recovery atomically renames a
   proven-dead holder's file before attempting a fresh O_EXCL claim, so concurrent reclaimers still yield
   exactly one owner. Release removes the file only when its nonce still matches this instance. */
'use strict';

function defaultNonce() {
  try { return require('node:crypto').randomBytes(16).toString('hex'); }
  catch (_) { try { return require('crypto').randomBytes(16).toString('hex'); } catch (__) { return 'unavailable'; } }
}

function defaultPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return true; // malformed/unprovable is busy, never reclaimable
  if (typeof process === 'undefined' || typeof process.kill !== 'function') return true;
  if (n === process.pid) return true;
  try { process.kill(n, 0); return true; }
  catch (e) {
    if (e && e.code === 'EPERM') return true;
    return false;
  }
}

function makeWorkspaceOwner(deps) {
  const d = deps || {};
  const fs = d.fs;
  const path = d.path;
  const pid = d.pid != null ? Number(d.pid) : ((typeof process !== 'undefined' && process.pid) || 0);
  const now = typeof d.now === 'function' ? d.now : function () { return 0; };
  const nonce = typeof d.nonce === 'function' ? d.nonce : defaultNonce;
  const pidAlive = typeof d.pidAlive === 'function' ? d.pidAlive : defaultPidAlive;
  const filename = String(d.filename || '.starnet-workspace-owner.json');
  if (!fs || typeof fs.openSync !== 'function' || typeof fs.renameSync !== 'function') {
    throw new Error('workspace-owner: an injected fs with openSync/renameSync is required');
  }
  if (!path || typeof path.join !== 'function') throw new Error('workspace-owner: an injected path is required');

  let held = null;

  function readHolder(lockfile) {
    try {
      const raw = String(fs.readFileSync(lockfile, 'utf8'));
      const value = JSON.parse(raw);
      if (!value || value.version !== 1 || !Number.isInteger(Number(value.pid)) || Number(value.pid) <= 0 ||
          typeof value.nonce !== 'string' || !value.nonce) return { valid: false, raw: raw };
      return { valid: true, raw: raw, pid: Number(value.pid), nonce: value.nonce,
        startedAt: Number(value.startedAt) || 0, executable: String(value.executable || '') };
    } catch (e) {
      return { valid: false, unreadable: true, error: (e && e.code) || 'unreadable' };
    }
  }

  function tryCreate(lockfile, root) {
    const claim = {
      version: 1,
      pid: pid,
      nonce: String(nonce()),
      startedAt: Number(now()) || 0,
      executable: (typeof process !== 'undefined' && process.execPath) ? String(process.execPath) : ''
    };
    const raw = JSON.stringify(claim);
    let fd = null;
    try {
      fd = fs.openSync(lockfile, 'wx');
      fs.writeSync(fd, raw);
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
    } catch (e) {
      if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
      return { ok: false, exists: !!(e && e.code === 'EEXIST'), error: e };
    }
    try { fs.closeSync(fd); } catch (_) {}
    let back = '';
    try { back = String(fs.readFileSync(lockfile, 'utf8')); } catch (e) {
      return { ok: false, exists: false, error: e };
    }
    if (back !== raw) return { ok: false, exists: false, error: new Error('workspace owner read-back mismatch') };
    held = { root: root, lockfile: lockfile, raw: raw, claim: claim };
    return { ok: true, root: root, lockfile: lockfile, holder: claim, release: release };
  }

  function acquire(root) {
    const resolved = path.resolve ? path.resolve(String(root || '')) : String(root || '');
    if (!resolved) return { ok: false, code: 'WORKSPACE_PATH_INVALID', message: 'workspace path is required' };
    if (held) {
      if (held.root === resolved) return { ok: true, root: held.root, lockfile: held.lockfile, holder: held.claim, release: release };
      return { ok: false, code: 'WORKSPACE_OWNER_ALREADY_HELD', root: resolved, heldRoot: held.root };
    }
    try { fs.mkdirSync(resolved, { recursive: true }); }
    catch (e) { return { ok: false, code: 'WORKSPACE_OWNER_UNAVAILABLE', root: resolved, error: e }; }
    const lockfile = path.join(resolved, filename);
    let created = tryCreate(lockfile, resolved);
    if (created.ok) return created;
    if (!created.exists) return { ok: false, code: 'WORKSPACE_OWNER_UNAVAILABLE', root: resolved, lockfile: lockfile, error: created.error };

    const holder = readHolder(lockfile);
    if (!holder.valid || pidAlive(holder.pid)) {
      return { ok: false, code: 'WORKSPACE_BUSY', root: resolved, lockfile: lockfile, holder: holder };
    }

    // The stamped process is provably gone. Rename is the atomic reclaim election; only its winner
    // gets to create the replacement. A loser reports busy and retries on its next normal launch.
    const reclaim = lockfile + '.dead-' + pid + '-' + String(nonce());
    try { fs.renameSync(lockfile, reclaim); }
    catch (_) { return { ok: false, code: 'WORKSPACE_BUSY', root: resolved, lockfile: lockfile, holder: holder }; }
    created = tryCreate(lockfile, resolved);
    try { fs.unlinkSync(reclaim); } catch (_) {}
    if (created.ok) return created;
    return { ok: false, code: created.exists ? 'WORKSPACE_BUSY' : 'WORKSPACE_OWNER_UNAVAILABLE',
      root: resolved, lockfile: lockfile, holder: readHolder(lockfile), error: created.error };
  }

  function release() {
    if (!held) return false;
    const mine = held;
    held = null;
    try {
      if (String(fs.readFileSync(mine.lockfile, 'utf8')) !== mine.raw) return false;
      fs.unlinkSync(mine.lockfile);
      return true;
    } catch (_) { return false; }
  }

  return { acquire: acquire, release: release, current: function () { return held && held.claim; } };
}

module.exports = { makeWorkspaceOwner: makeWorkspaceOwner, _internals: { defaultPidAlive: defaultPidAlive } };
