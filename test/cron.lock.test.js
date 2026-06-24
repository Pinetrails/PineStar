/* node test/cron.lock.test.js — G4.3: cross-process / reentrancy exactly-once cron lock.

   Proves cron fires EXACTLY ONCE even when two sidecars (or a boot-reconcile racing the first
   timer tick, or a CRUD save racing an advance) hit the schedule at the same instant. All headless
   with injected fs/clock/nonce — no real timer, no wall-clock or rng read in the logic under test
   (lint-determinism stays green: the lock module takes now()+nonce as injected deps).

   Three load-bearing properties, each red on the pre-fix tree:

     · IN-PROCESS REENTRANCY (tickInFlight): two back-to-back applyTick at the SAME instant produce
       a SINGLE cron.fire — a re-entrant tick is a no-op, never a second launch.

     · STALE-RECLAIM RACE (the TOCTOU bug the file lock exists to prevent): a STALE lockfile (mtime
       older than maxRunMs) is reclaimed by exactly ONE of two distinct holders racing at the same
       now. Reclaim is a SINGLE atomic step (rename the stale lockfile to a holder-stamped name);
       the LOSER of the rename gets ENOENT and NO-OPS. Two applyTick passes over the SAME on-disk
       store, each guarded by a distinct lock holder, fire EXACTLY ONCE TOTAL. An in-process-only
       guard does NOT satisfy this — both holders exercise the real file-lock reclaim path.

     · CRUD SERIALIZATION (re-read-modify-write under the lock): a concurrent CRUD setJobs cannot
       clobber an in-flight advance. The lock serializes the two writers and the CRUD write re-reads
       the freshest on-disk store before applying its delta, so the advanced nextRunAt survives.

   The lock module (sidecar/cron-lock.js) is the testable seam, exactly like durable-write.js — it
   is importable and exercises the REAL acquire/reclaim/release path against a real temp dir. */
'use strict';
const A = require('./_assert.js');
const os = require('node:os');
const realFs = require('node:fs');
const path = require('node:path');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const { makeCronLock } = require('../sidecar/cron-lock.js');

const T0 = 1700000000000;
const tmpRoot = realFs.mkdtempSync(path.join(os.tmpdir(), 'cron-lock-'));
const cleanup = [];
function tmpFile(name) { const f = path.join(tmpRoot, name); cleanup.push(f); return f; }

(function () {

  /* ---- 1. IN-PROCESS REENTRANCY (tickInFlight): a re-entrant applyTick at the same instant is a NO-OP ----
     Drive ONE driver whose runOnce, when invoked, synchronously re-enters applyTick at the SAME now (the
     boot-reconcile-racing-the-first-tick shape collapsed into one process). The reentrancy guard must
     SHORT-CIRCUIT that inner pass entirely — it must NOT walk the plan / advance / emit a second cron.tick.
     Without the guard the inner pass runs its full body (the lease then suppresses the duplicate fire, so a
     fired-count assertion alone is vacuous) — so we assert the guard's DISTINCT signal: the inner pass
     returns reentered:true and produces ZERO extra cron.tick pulses. Fired-count stays 1 as a backstop. */
  {
    const period = 10 * 60 * 1000;
    const dueAt = T0 + period;
    const job = cronStore.makeJob({ id: 'iv', prompt: 'tick', agentId: 'cron_iv', schedule: cron.parseSchedule('every 10m', T0) }, { id: 'iv', now: T0 });
    let store = [job];
    const clock = makeClock(dueAt);
    const fired = [];
    const ticks = [];
    let driver = null;
    let innerResult = null;
    let reenterAttempted = false;
    driver = makeCronDriver({
      getJobs: () => store,
      setJobs: (j) => { store = j; },
      // the run host RE-ENTERS applyTick at the same now (a second tick racing the first) before the
      // first launch settles — the reentrancy guard must make that inner pass a no-op.
      runOnce: () => {
        if (!reenterAttempted) { reenterAttempted = true; innerResult = driver.applyTick(clock.now()); }
        return new Promise(() => {});   // never settles -> stays in-flight
      },
      emit: (name, payload) => { if (name === 'cron.fire') fired.push(payload); else if (name === 'cron.tick') ticks.push(payload); },
      newId: () => 'rid', newAbort: () => new AbortController(), now: () => clock.now(),
      getKey: () => 'sk', defaultModel: 'm', maxRunMs: 480000
    });
    driver.applyTick(clock.now());
    A.ok(reenterAttempted, 'the run host re-entered applyTick (the reentrancy path was exercised)');
    A.ok(innerResult && innerResult.reentered === true, 'the re-entrant applyTick SHORT-CIRCUITED (reentered:true) — the tickInFlight guard fired');
    A.eq(innerResult.fired, 0, 'the re-entrant pass launched ZERO runs (it never reached the fire loop)');
    A.eq(ticks.length, 1, 'exactly ONE cron.tick pulse — the re-entrant pass emitted no second tick (guard short-circuit, not just lease-suppressed)');
    A.eq(fired.length, 1, 'exactly one cron.fire across the outer + re-entrant pass');
  }

  /* ---- 2. NAIVE double-tick across the FILE LOCK: two driver passes wrapped in two distinct lock
     holders over the SAME on-disk store at the same now fire exactly once ----
     This is the two-sidecars / boot-reconcile-racing-the-timer case. Each pass takes the cross-process
     lock; whoever wins runs the tick and persists the advance, the loser no-ops (lock held) — but here
     they run SERIALLY (single thread), so holder A acquires, fires, advances+persists+releases; holder
     B then acquires, re-reads the advanced store, finds nothing due -> ZERO fires. */
  {
    const lockfile = tmpFile('cron-A.lock');
    const jobsFile = tmpFile('jobs-A.json');
    const period = 10 * 60 * 1000;
    const dueAt = T0 + period;
    const job = cronStore.makeJob({ id: 'iv', prompt: 'tick', agentId: 'cron_iv', schedule: cron.parseSchedule('every 10m', T0) }, { id: 'iv', now: T0 });
    writeFileDurable({ fs: realFs, path }, jobsFile, JSON.stringify(cronStore.toEnvelope([job])));
    const clock = makeClock(dueAt);
    const fired = [];

    function mkHolder(pid, nonce) {
      const lock = makeCronLock({ fs: realFs, path, lockfile, now: () => clock.now(), maxRunMs: 480000, pid, nonce: () => nonce });
      const driver = makeCronDriver({
        getJobs: () => cronStore.loadEnvelope(realFs.readFileSync(jobsFile, 'utf8')).jobs,
        setJobs: (j) => writeFileDurable({ fs: realFs, path }, jobsFile, JSON.stringify(cronStore.toEnvelope(j))),
        runOnce: () => new Promise(() => {}),
        emit: (name, payload) => { if (name === 'cron.fire') fired.push({ pid, payload }); },
        newId: () => 'rid' + pid, newAbort: () => new AbortController(), now: () => clock.now(),
        getKey: () => 'sk', defaultModel: 'm', maxRunMs: 480000
      });
      return { lock, driver };
    }
    const a = mkHolder(101, 'na');
    const b = mkHolder(202, 'nb');
    a.lock.withLock(() => a.driver.applyTick(clock.now()));
    b.lock.withLock(() => b.driver.applyTick(clock.now()));
    A.eq(fired.length, 1, 'two serial lock-wrapped ticks over the same store fire EXACTLY ONCE (the second re-reads the advanced store)');
  }

  /* ---- 3. STALE-RECLAIM RACE (mandatory — the critic's flag): a STALE lockfile, TWO distinct
     holders BOTH attempting reclaim at the SAME now, exactly ONE acquires, the loser no-ops ----
     Construct a stale lock (old mtime, a crashed holder's pid:nonce). The reclaim must be a SINGLE
     atomic step: the winner renames the stale lockfile to its own stamped name; the loser's rename of
     the (now-gone) stale file gets ENOENT and the loser does NOT acquire. We drive the acquire path
     DIRECTLY for two holders before either releases, then assert exactly one held the lock. */
  {
    const lockfile = tmpFile('cron-stale.lock');
    const clock = makeClock(T0);

    // a crashed holder's lock, written long ago (stale): set its mtime well past maxRunMs.
    realFs.writeFileSync(lockfile, '999:deadbeef');
    const oldMs = (T0 - 60 * 60 * 1000) / 1000;   // 1h ago, in seconds for utimesSync
    realFs.utimesSync(lockfile, oldMs, oldMs);

    const maxRunMs = 8 * 60 * 1000;
    const holderA = makeCronLock({ fs: realFs, path, lockfile, now: () => clock.now(), maxRunMs, pid: 101, nonce: () => 'AAA' });
    const holderB = makeCronLock({ fs: realFs, path, lockfile, now: () => clock.now(), maxRunMs, pid: 202, nonce: () => 'BBB' });

    // Model the TRUE concurrent interleave at the TOCTOU window: BOTH holders observe the SAME stale
    // lock (both pass the stale CHECK) BEFORE either ACTS on it. The atomic claim is the rename of the
    // ORIGINAL stale inode out of the way — exactly one racer can move it; the other gets ENOENT. A
    // non-atomic reclaim (check-then-unlink-then-write) lets BOTH proceed — the bug this test catches.
    A.ok(holderA._internals.isStale(), 'holder A sees the lock as stale');
    A.ok(holderB._internals.isStale(), 'holder B sees the lock as stale (same TOCTOU window — neither has acted yet)');
    // both attempt the SINGLE atomic claim step (rename the original away) BEFORE either recreates —
    // the genuine race point. Exactly one moves the original stale inode.
    const claimA = holderA._internals.claimStaleRename();
    const claimB = holderB._internals.claimStaleRename();

    const wonA = !!claimA, wonB = !!claimB;
    A.ok(wonA !== wonB, 'exactly ONE of two holders moved the stale lock (the other got ENOENT) — A=' + wonA + ' B=' + wonB);
    A.ok((wonA ? 1 : 0) + (wonB ? 1 : 0) === 1, 'exactly one holder claimed (TOCTOU-safe atomic rename — both observed stale, only one moved the original)');
    // the winner finishes the reclaim (O_EXCL recreate under its stamp); the loser no-ops.
    if (claimA) { const mine = holderA._internals.tryCreateOwn(); try { realFs.unlinkSync(claimA); } catch (_) {} A.ok(mine === '101:AAA', 'winner A recreated the lock under its own stamp'); }
    if (claimB) { const mine = holderB._internals.tryCreateOwn(); try { realFs.unlinkSync(claimB); } catch (_) {} A.ok(mine === '202:BBB', 'winner B recreated the lock under its own stamp'); }
    // the lockfile now exists and is stamped with the WINNER's pid:nonce (not the stale 999:deadbeef).
    const held = realFs.readFileSync(lockfile, 'utf8');
    A.ok(held === '101:AAA' || held === '202:BBB', 'lockfile is stamped with the winning holder, not the stale content — got ' + held);
    try { realFs.unlinkSync(lockfile); } catch (_) {}
  }

  /* ---- 3b. STALE-RECLAIM via the DRIVER + lock, end-to-end: a stale lock, two applyTick passes both
     attempting reclaim at the same now, EXACTLY ONE cron.fire total ----
     This is the integration form: the file-lock reclaim path is exercised by two distinct holders
     wrapping two real driver passes over the same due store. */
  {
    const lockfile = tmpFile('cron-stale2.lock');
    const jobsFile = tmpFile('jobs-stale2.json');
    const period = 10 * 60 * 1000;
    const dueAt = T0 + period;
    const job = cronStore.makeJob({ id: 'iv', prompt: 'tick', agentId: 'cron_iv', schedule: cron.parseSchedule('every 10m', T0) }, { id: 'iv', now: T0 });
    writeFileDurable({ fs: realFs, path }, jobsFile, JSON.stringify(cronStore.toEnvelope([job])));
    const clock = makeClock(dueAt);
    const fired = [];

    // a stale lock left by a crashed holder, mtime well past maxRunMs.
    realFs.writeFileSync(lockfile, '999:zombie');
    const oldMs = (dueAt - 60 * 60 * 1000) / 1000;
    realFs.utimesSync(lockfile, oldMs, oldMs);
    const maxRunMs = 8 * 60 * 1000;

    function mkHolder(pid, nonce) {
      const lock = makeCronLock({ fs: realFs, path, lockfile, now: () => clock.now(), maxRunMs, pid, nonce: () => nonce });
      const driver = makeCronDriver({
        getJobs: () => cronStore.loadEnvelope(realFs.readFileSync(jobsFile, 'utf8')).jobs,
        setJobs: (j) => writeFileDurable({ fs: realFs, path }, jobsFile, JSON.stringify(cronStore.toEnvelope(j))),
        runOnce: () => new Promise(() => {}),
        emit: (name, payload) => { if (name === 'cron.fire') fired.push({ pid, payload }); },
        newId: () => 'rid' + pid, newAbort: () => new AbortController(), now: () => clock.now(),
        getKey: () => 'sk', defaultModel: 'm', maxRunMs
      });
      return { lock, driver };
    }
    const a = mkHolder(101, 'AAA');
    const b = mkHolder(202, 'BBB');
    // both reclaim the SAME stale lock at the SAME now; run serially (single thread). Whoever reclaims
    // first fires + advances + releases; the second reclaims the now-free lock, re-reads the advanced
    // store, finds nothing due -> ZERO. Exactly ONE fire total.
    a.lock.withLock(() => a.driver.applyTick(clock.now()));
    b.lock.withLock(() => b.driver.applyTick(clock.now()));
    A.eq(fired.length, 1, 'stale-reclaim end-to-end: exactly ONE cron.fire total across two reclaiming passes');
  }

  /* ---- 4. CRUD SERIALIZATION: a CRUD setJobs re-reads the freshest store under the lock and cannot
     clobber an in-flight advance ----
     Sequence: (1) a tick advances job iv's nextRunAt and persists it under the lock; (2) a CRUD write
     ADDS a new job — done as a re-read-modify-write under the lock, so it re-reads the advanced store
     from disk, appends, and persists. The advance must SURVIVE: the on-disk store has BOTH the advanced
     iv AND the new job. A naive last-write-wins CRUD (operating on a STALE in-memory snapshot taken
     before the advance) would clobber the advance back to the old due time -> double-fire. */
  {
    const lockfile = tmpFile('cron-crud.lock');
    const jobsFile = tmpFile('jobs-crud.json');
    const period = 10 * 60 * 1000;
    const dueAt = T0 + period;
    const job = cronStore.makeJob({ id: 'iv', prompt: 'tick', agentId: 'cron_iv', schedule: cron.parseSchedule('every 10m', T0) }, { id: 'iv', now: T0 });
    writeFileDurable({ fs: realFs, path }, jobsFile, JSON.stringify(cronStore.toEnvelope([job])));
    const clock = makeClock(dueAt);

    const lock = makeCronLock({ fs: realFs, path, lockfile, now: () => clock.now(), maxRunMs: 480000, pid: 101, nonce: () => 'L' });
    const loadDisk = () => cronStore.loadEnvelope(realFs.readFileSync(jobsFile, 'utf8')).jobs;
    const saveDisk = (j) => writeFileDurable({ fs: realFs, path }, jobsFile, JSON.stringify(cronStore.toEnvelope(j)));

    // a CRUD client takes a STALE snapshot of the store BEFORE the advance (the clobber window).
    const staleSnapshot = loadDisk();

    // (1) the tick: advance iv + persist, under the lock (re-read-modify-write).
    const fired = [];
    const driver = makeCronDriver({
      getJobs: loadDisk, setJobs: saveDisk, runOnce: () => new Promise(() => {}),
      emit: (name, payload) => { if (name === 'cron.fire') fired.push(payload); },
      newId: () => 'rid', newAbort: () => new AbortController(), now: () => clock.now(),
      getKey: () => 'sk', defaultModel: 'm', maxRunMs: 480000
    });
    lock.withLock(() => driver.applyTick(clock.now()));
    A.eq(fired.length, 1, 'the tick fired iv and advanced it under the lock');
    const afterTick = loadDisk();
    const advancedIso = afterTick.find(j => j.id === 'iv').nextRunAt;
    A.eq(advancedIso, new Date(dueAt + period).toISOString(), 'iv advanced one period on disk');

    // (2) the CRUD write, done CORRECTLY as a re-read-modify-write UNDER the lock: it must re-read the
    //     advanced store from disk (NOT use staleSnapshot) and append the new job.
    const newJob = cronStore.makeJob({ id: 'cr', prompt: 'new', agentId: 'cron_cr', schedule: cron.parseSchedule('every 30m', dueAt) }, { id: 'cr', now: dueAt });
    lock.withLock(() => {
      const fresh = loadDisk();                  // re-read UNDER the lock — the advance is visible here
      saveDisk(cronStore.createJob(fresh, newJob, { id: 'cr', now: dueAt }));
    });

    const finalStore = loadDisk();
    A.eq(finalStore.length, 2, 'the CRUD add did not drop the advanced job (both jobs on disk)');
    const ivFinal = finalStore.find(j => j.id === 'iv');
    A.ok(!!ivFinal, 'the advanced iv job survived the concurrent CRUD save');
    A.eq(ivFinal.nextRunAt, advancedIso, 'the CRUD re-read-modify-write did NOT clobber the advance (no double-fire) — still ' + advancedIso);
    A.ok(!!finalStore.find(j => j.id === 'cr'), 'the new CRUD job was added');

    // proof of the failure mode being real: a NAIVE CRUD save from the stale snapshot WOULD clobber.
    const naive = cronStore.createJob(staleSnapshot, newJob, { id: 'cr', now: dueAt });
    const naiveIv = naive.find(j => j.id === 'iv');
    A.ok(naiveIv && naiveIv.nextRunAt === new Date(dueAt).toISOString(), 'control: a naive stale-snapshot CRUD save WOULD revert iv to the old due time (the clobber the lock prevents)');
  }

  /* ---- 5. STALE-AGE BREAK ONLY when stale: a FRESH lock held by another holder is NOT reclaimed ----
     A non-stale lock (mtime within maxRunMs) blocks a second holder — withLock's fn does NOT run, so a
     crashed holder past the ceiling is reclaimable but a live holder is respected. */
  {
    const lockfile = tmpFile('cron-fresh.lock');
    const clock = makeClock(T0);
    const maxRunMs = 8 * 60 * 1000;
    const holderA = makeCronLock({ fs: realFs, path, lockfile, now: () => clock.now(), maxRunMs, pid: 101, nonce: () => 'AAA' });
    const holderB = makeCronLock({ fs: realFs, path, lockfile, now: () => clock.now(), maxRunMs, pid: 202, nonce: () => 'BBB' });

    A.ok(holderA._internals.acquire(), 'holder A acquires a free lock');
    // B attempts while A holds it FRESH (now is barely past) -> must NOT acquire.
    clock.advance(60 * 1000);   // 1m later, well within maxRunMs
    let bRan = false;
    holderB.withLock(() => { bRan = true; });
    A.ok(!bRan, 'holder B did NOT run while holder A holds a FRESH lock (no premature reclaim)');
    holderA.release ? holderA.release() : holderA._internals.release();

    // once A releases, B can acquire.
    let bRan2 = false;
    holderB.withLock(() => { bRan2 = true; });
    A.ok(bRan2, 'holder B runs once the lock is released');
  }

  /* ---- 6. RE-ENTRANT within one instance: nested withLock keeps the lock until the OUTERMOST release ----
     index.js wraps applyTick in the lock, and applyTick's setJobs calls saveCronJobs which is ALSO
     lock-wrapped — a nested acquire+release must NOT drop the lock mid-tick. We assert the lockfile stays
     present across the inner scope and a SECOND holder cannot acquire while the nested scope runs. */
  {
    const lockfile = tmpFile('cron-reentrant.lock');
    const clock = makeClock(T0);
    const lock = makeCronLock({ fs: realFs, path, lockfile, now: () => clock.now(), maxRunMs: 480000, pid: 101, nonce: () => 'L' });
    const other = makeCronLock({ fs: realFs, path, lockfile, now: () => clock.now(), maxRunMs: 480000, pid: 202, nonce: () => 'O' });
    let innerRan = false, otherRanInside = false;
    let lockPresentAfterInner = false;
    lock.withLock(() => {
      // nested write under the SAME instance's lock (the saveCronJobs-inside-applyTick shape).
      lock.withLock(() => { innerRan = true; });
      // after the INNER release the lock must STILL be held (outer scope) — file present, no other holder.
      lockPresentAfterInner = realFs.existsSync(lockfile);
      other.withLock(() => { otherRanInside = true; });
    });
    A.ok(innerRan, 'the nested (re-entrant) withLock body ran');
    A.ok(lockPresentAfterInner, 'the lockfile is STILL held after the inner (nested) release — re-entrant, not dropped mid-scope');
    A.ok(!otherRanInside, 'a DIFFERENT holder could not acquire while the re-entrant outer scope still holds the lock');
    A.ok(!realFs.existsSync(lockfile), 'the lockfile is released after the OUTERMOST scope exits');
  }

  // tidy up the temp dir (best-effort).
  try { for (const f of cleanup) { try { realFs.unlinkSync(f); } catch (_) {} } realFs.rmdirSync(tmpRoot, { recursive: true }); } catch (_) {}

  A.report('cron.lock');
})();
