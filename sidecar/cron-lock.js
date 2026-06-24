/* sidecar/cron-lock.js — the cross-process advisory lock that makes cron fire EXACTLY ONCE (G4.3).

   The problem (parity Hermes' .tick.lock / .jobs.lock): the in-process tickInFlight guard
   (cron-driver.applyTick) stops a re-entrant tick in ONE process, but two sidecars sharing one
   WORKSPACES dir — or a second sidecar booting and running its resume-reconcile while the first's
   timer fires — would BOTH read the same due store and BOTH launch the run (double-fire), and a CRUD
   save in one process can clobber an advance persisted by the other (last-write-wins on the jobs
   mirror). This module serializes every cron WRITE (applyTick AND each CRUD saveCronJobs/setJobs)
   behind one advisory lockfile so at most one writer is ever in the critical section.

   Windows has NO flock, so this is the PORTABLE O_EXCL + pid:nonce + READ-BACK-VERIFY path with an
   mtime-based stale break (mirrors the cron lease ceiling) so a crashed holder never wedges cron
   forever:

     ACQUIRE
       1. open(lockfile, 'wx')  — O_EXCL create. If it succeeds, write our `pid:nonce`, close, then
          READ IT BACK and verify it is byte-for-byte ours (defends against a torn write / a racer
          that O_EXCL-won between our create and our read). Verified -> we hold it.
       2. EEXIST -> the lock is held. stat it: if mtimeMs is within maxRunMs the holder is LIVE ->
          we do NOT acquire (the caller's tick/write is a no-op this pass). If it is STALE (older than
          maxRunMs, a crashed holder), RECLAIM it atomically:

       ATOMIC RECLAIM (the TOCTOU bug this lock exists to prevent — a SINGLE atomic step, the loser
       no-ops): rename(lockfile -> lockfile + '.' + pid + '.' + nonce + '.reclaim'). renameSync over
       an existing source is atomic and exactly ONE of two racers can move the ORIGINAL stale file —
       the loser's rename gets ENOENT (the file is already gone) and NO-OPS (returns not-acquired).
       The winner then O_EXCL-creates the fresh lockfile with our pid:nonce, reads it back, verifies,
       and unlinks the stamped reclaim file. Two processes both observing the stale lock can NOT both
       proceed: only the rename WINNER ever reaches the O_EXCL create.

     RELEASE  — unlink the lockfile, but ONLY if it still carries OUR pid:nonce (a later stale sweep
       may have reclaimed+replaced it; we must not unlink a successor's lock).

   Determinism: pure injected I/O. now() and the nonce are INJECTED (the nonce defaults to a lazy
   node:crypto only when not supplied), pid is injected-or-process.pid — there is NO Date.now /
   new Date() / Math.random literal here, so it passes lint-determinism.js (same shape as
   durable-write.js).

   makeCronLock({ fs, path, lockfile, now, maxRunMs, pid?, nonce? }) -> { withLock(fn), release, _internals }
     fs       : node:fs (needs openSync/writeSync/closeSync/readFileSync/statSync/renameSync/unlinkSync).
     path     : node:path (unused today; accepted for symmetry / future dir work).
     lockfile : absolute path to the advisory lockfile (e.g. WORKSPACES/cron.lock).
     now      : () -> ms wall clock — used only for the stale-age comparison against statSync mtime.
     maxRunMs : a lock older than this is STALE and reclaimable (mirror the cron lease ceiling).
     pid      : optional holder id (defaults to process.pid). nonce: optional ()->string (defaults
                to a crypto random hex) — pid:nonce is the holder stamp written + read-back-verified. */
'use strict';

function defaultNonce() {
  try { return require('node:crypto').randomBytes(8).toString('hex'); }
  catch (_) { try { return require('crypto').randomBytes(8).toString('hex'); } catch (__) { return 'x'; } }
}

function makeCronLock(deps) {
  const d = deps || {};
  const fs = d.fs;
  const lockfile = d.lockfile;
  const now = typeof d.now === 'function' ? d.now : function () { return 0; };
  const maxRunMs = d.maxRunMs || (8 * 60 * 1000);
  const pid = (d.pid != null) ? d.pid : (typeof process !== 'undefined' && process.pid) || 0;
  const nonceFn = typeof d.nonce === 'function' ? d.nonce : defaultNonce;
  if (!fs || typeof fs.openSync !== 'function' || typeof fs.renameSync !== 'function') {
    throw new Error('cron-lock: an injected fs with openSync/renameSync is required');
  }
  if (!lockfile) throw new Error('cron-lock: a lockfile path is required');

  // our holder stamp for the CURRENT acquisition (set on acquire, cleared on the OUTERMOST release).
  let heldStamp = null;
  // re-entrancy depth: nested withLock/acquire+release pairs in the SAME instance (e.g. applyTick wrapped
  // in the lock calling setJobs -> saveCronJobs, itself lock-wrapped) must NOT drop the lock until the
  // OUTERMOST release. Each acquire that finds the lock already held bumps the depth; each release decrements
  // and only the one that hits zero unlinks. This makes the lock a re-entrant mutex within one process.
  let depth = 0;

  function stamp(n) { return pid + ':' + n; }

  // O_EXCL-create the lockfile with our stamp, then READ IT BACK and verify it's ours. Returns the
  // stamp on success, null if the create lost the race (EEXIST) or the read-back is not ours.
  function tryCreateOwn() {
    const n = nonceFn();
    const mine = stamp(n);
    let fd = null;
    try {
      fd = fs.openSync(lockfile, 'wx');     // O_EXCL | O_CREAT | O_WRONLY — fails EEXIST if present
      fs.writeSync(fd, mine);
    } catch (e) {
      if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
      return null;                          // EEXIST (someone holds it) or a write error -> not ours
    }
    try { fs.closeSync(fd); } catch (_) {}
    // READ-BACK VERIFY: confirm the bytes on disk are exactly ours (no torn write / no racer clobber).
    let back = '';
    try { back = String(fs.readFileSync(lockfile, 'utf8')); } catch (_) { return null; }
    return back === mine ? mine : null;
  }

  // Is the existing lockfile STALE (older than maxRunMs)? A missing file is treated as not-stale here
  // (the EEXIST branch only runs when the create saw it present); a stat error is conservatively
  // treated as NOT stale so we never reclaim a lock we cannot prove is dead.
  function isStale() {
    try {
      const st = fs.statSync(lockfile);
      const mtime = (st && typeof st.mtimeMs === 'number') ? st.mtimeMs : (st && st.mtime ? st.mtime.getTime() : 0);
      return (now() - mtime) > maxRunMs;
    } catch (_) { return false; }
  }

  // claimStaleRename — the SINGLE atomic mutual-exclusion step of a stale reclaim: rename the stale
  // lockfile OUT of the way to OUR uniquely-stamped reclaim name. renameSync of the ORIGINAL stale
  // inode can succeed for exactly ONE racer; every other racer's rename of that same source gets ENOENT
  // (it is already gone) and returns null (no-op). This is the TOCTOU-safe claim: two processes that
  // BOTH passed the stale check can NOT both move the original — only the winner gets a reclaim path.
  function claimStaleRename() {
    const reclaimPath = lockfile + '.' + pid + '.' + nonceFn() + '.reclaim';
    try {
      fs.renameSync(lockfile, reclaimPath);   // <-- the one atomic step; the loser hits ENOENT
      return reclaimPath;
    } catch (e) {
      return null;                            // lost the race (the original was already moved) -> no-op
    }
  }

  // tryReclaimStale — claim the stale lock atomically (above), then, ONLY as the rename winner, O_EXCL-
  // create a fresh lock under our stamp (read-back-verified) and drop the stamped stale file. Returns
  // our stamp on success, null if we lost the rename race OR the fresh create itself lost a brand-new
  // race (caller no-ops either way).
  function tryReclaimStale() {
    const reclaimPath = claimStaleRename();
    if (!reclaimPath) return null;            // we did NOT move the original stale inode -> no-op
    const mine = tryCreateOwn();              // O_EXCL fresh lock; a concurrent recreate serializes here
    try { fs.unlinkSync(reclaimPath); } catch (_) {}   // best-effort cleanup of the stamped stale file
    return mine;
  }

  // acquire() -> true if we now hold the lock (heldStamp set), false otherwise (caller no-ops this pass).
  // Re-entrant: a second acquire by the SAME instance that already holds it bumps the depth and succeeds.
  function acquire() {
    if (heldStamp) { depth++; return true; }   // already held by this instance -> re-entrant (depth-counted)
    let mine = tryCreateOwn();
    if (!mine) {
      // the lock exists. Reclaim it iff it is stale; a LIVE holder is respected (we no-op).
      if (isStale()) mine = tryReclaimStale();
    }
    if (mine) { heldStamp = mine; depth = 1; return true; }
    return false;
  }

  // release() -> decrement the re-entrancy depth; only the OUTERMOST release (depth -> 0) actually drops the
  // lock, and only if it still carries OUR stamp (a stale sweep may have reclaimed+replaced it with a
  // successor's — never unlink that).
  function release() {
    if (!heldStamp) return;
    if (depth > 1) { depth--; return; }   // an inner (nested) release — keep the lock for the outer scope
    const mine = heldStamp;
    heldStamp = null; depth = 0;
    try {
      const cur = String(fs.readFileSync(lockfile, 'utf8'));
      if (cur === mine) fs.unlinkSync(lockfile);
    } catch (_) { /* already gone / unreadable — nothing to release */ }
  }

  // withLock(fn) — acquire, run fn() if acquired (else NO-OP this pass), always release on the way out.
  // Returns { ran:bool, result } so callers can tell an executed write from a no-op (lock-held) pass.
  function withLock(fn) {
    if (!acquire()) return { ran: false, result: undefined };
    let result, threw = null;
    try { result = (typeof fn === 'function') ? fn() : undefined; }
    catch (e) { threw = e; }
    finally { release(); }
    if (threw) throw threw;
    return { ran: true, result: result };
  }

  return { withLock: withLock, release: release, _internals: { acquire: acquire, release: release, tryCreateOwn: tryCreateOwn, claimStaleRename: claimStaleRename, tryReclaimStale: tryReclaimStale, isStale: isStale } };
}

module.exports = { makeCronLock };
