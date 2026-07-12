/* node test/procledger.test.js — the persistent child-PID ledger + boot orphan sweep (mouse-confinement
   incident, 2026-07-12). Locks the laws: every recorded child survives in the ledger FILE (a force-killed
   sidecar can't release anything), the next boot's sweep kills exactly the recorded-and-still-matching
   PIDs, and a recycled PID whose live command line no longer matches is NEVER killed. Pure fakes — no
   real processes, fast gate. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeProcLedger, _internals } = require('../sidecar/procledger.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-ledger-'));
  const file = path.join(dir, 'proc-ledger.json');
  const clock = { now: () => 1234 };

  // ---- 1. cmdMatches: token-wise reuse guard ----
  A.ok(_internals.cmdMatches('npm run dev', 'cmd.exe /d /s /c "npm run dev"'), 'shell:true child matches (tokens adjacent)');
  A.ok(_internals.cmdMatches('C:\\chrome.exe --user-data-dir=C:\\tmp\\sb-1', '"C:\\chrome.exe" --disable-gpu --headless=new --user-data-dir=C:\\tmp\\sb-1 about:blank'),
    'browser matches even with flags BETWEEN the recorded tokens');
  A.ok(!_internals.cmdMatches('C:\\chrome.exe --user-data-dir=C:\\tmp\\sb-1', '"C:\\chrome.exe" --user-data-dir=C:\\Users\\me\\profile'),
    'the user\'s OWN chrome (same exe, different profile) does NOT match');
  A.ok(!_internals.cmdMatches('npm run dev', 'C:\\Windows\\explorer.exe'), 'recycled PID with unrelated cmdline does NOT match');
  A.ok(!_internals.cmdMatches('', 'anything'), 'empty recorded cmd never matches');

  // ---- 2. record/release round-trips the FILE (what a force-kill leaves behind) ----
  const l1 = makeProcLedger({ fs, pathMod: path, file, clock, probe: async () => new Map(), killTree: async () => {} });
  l1.record({ pid: 101, cmd: 'npm run dev', kind: 'shell.bg' });
  l1.record({ pid: 102, cmd: 'chrome.exe --user-data-dir=X', kind: 'browser' });
  l1.record({ pid: 103, cmd: 'node server.js', kind: 'shell.bg' });
  l1.release(103);   // clean exit -> gone from the file
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  A.eq(onDisk.procs.length, 2, 'released pid left the file; recorded pids persist');
  A.ok(onDisk.procs.some(p => p.pid === 101) && onDisk.procs.some(p => p.pid === 102), 'both live pids on disk');

  // ---- 3. next boot sweeps: kills the match, skips the recycled pid, drops the dead one ----
  const killed = [];
  const l2 = makeProcLedger({
    fs, pathMod: path, file, clock,
    probe: async (pids) => {
      A.eq(pids.slice().sort().join(','), '101,102', 'sweep probes exactly the recorded pids');
      // 101 still runs the same command; 102 was recycled by an unrelated process; (dead pids just absent)
      return new Map([[101, 'cmd.exe /d /s /c "npm run dev"'], [102, 'C:\\Windows\\System32\\svchost.exe']]);
    },
    killTree: async (pid) => killed.push(pid)
  });
  const s = await l2.sweep();
  A.eq(killed.join(','), '101', 'ONLY the still-matching orphan is killed');
  A.eq(s.killed, 1, 'summary counts the kill');
  A.eq(s.reused, 1, 'summary counts the recycled pid (not killed)');
  A.eq(s.examined, 2, 'summary examined everything recorded');
  const afterSweep = JSON.parse(fs.readFileSync(file, 'utf8'));
  A.eq(afterSweep.procs.length, 0, 'sweep clears the previous life\'s entries');

  // ---- 3b. creation-time guard: a matching cmdline is STILL not killed if the live process started after we
  //         recorded it (a recycled PID whose command coincidentally matches the user's own process) ----
  const killedT = [];
  const fileT = path.join(dir, 'ct.json');
  const lT1 = makeProcLedger({ fs, pathMod: path, file: fileT, clock: { now: () => 100000 }, probe: async () => new Map(), killTree: async () => {} });
  lT1.record({ pid: 700, cmd: 'npm run dev', kind: 'shell.bg' });   // recorded at t=100000
  const lT2 = makeProcLedger({
    fs, pathMod: path, file: fileT, clock: { now: () => 100000 },
    // same command, but the live process was created LONG AFTER we recorded (200000 >> 100000) -> recycled PID
    probe: async () => new Map([[700, { cmd: 'cmd.exe /d /s /c "npm run dev"', created: 200000 }]]),
    killTree: async (pid) => killedT.push(pid)
  });
  const sT = await lT2.sweep();
  A.eq(killedT.length, 0, 'a newer-than-recorded process is NOT killed even though its command matches');
  A.eq(sT.reused, 1, 'creation-time guard counts it as a recycled pid');
  // and the inverse: a process created BEFORE we recorded (our real orphan) IS killed
  const killedT2 = [];
  const fileT2 = path.join(dir, 'ct2.json');
  const lU1 = makeProcLedger({ fs, pathMod: path, file: fileT2, clock: { now: () => 100000 }, probe: async () => new Map(), killTree: async () => {} });
  lU1.record({ pid: 701, cmd: 'npm run dev', kind: 'shell.bg' });
  const lU2 = makeProcLedger({
    fs, pathMod: path, file: fileT2, clock: { now: () => 100000 },
    probe: async () => new Map([[701, { cmd: 'cmd.exe /d /s /c "npm run dev"', created: 99000 }]]),   // created before startedAt
    killTree: async (pid) => killedT2.push(pid)
  });
  await lU2.sweep();
  A.eq(killedT2.join(','), '701', 'our real orphan (created before we recorded it) IS reaped');

  // ---- 4. sweep with an empty ledger is a no-op that never probes ----
  let probed = false;
  const l3 = makeProcLedger({ fs, pathMod: path, file, clock, probe: async () => { probed = true; return new Map(); }, killTree: async () => {} });
  const s3 = await l3.sweep();
  A.eq(s3.examined, 0, 'nothing recorded -> nothing examined');
  A.ok(!probed, 'no probe subprocess for an empty ledger');

  // ---- 5. probe failure kills NOTHING (safe default) ----
  const l4 = makeProcLedger({ fs, pathMod: path, file, clock, probe: async () => { throw new Error('boom'); }, killTree: async () => { throw new Error('must not be called'); } });
  l4.record({ pid: 555, cmd: 'x y z' });
  const l5 = makeProcLedger({ fs, pathMod: path, file, clock, probe: async () => { throw new Error('boom'); }, killTree: async () => { A.ok(false, 'killTree must not run on probe failure'); } });
  const s5 = await l5.sweep();
  A.eq(s5.killed, 0, 'probe failure -> zero kills');

  // ---- 6. bad pids are refused ----
  const l6 = makeProcLedger({ fs, pathMod: path, file: path.join(dir, 'l6.json'), clock, probe: async () => new Map(), killTree: async () => {} });
  A.eq(l6.record({ pid: 0, cmd: 'x' }), null, 'pid 0 refused');
  A.eq(l6.record({ pid: -4, cmd: 'x' }), null, 'negative pid refused');
  A.eq(l6.list().length, 0, 'nothing recorded from bad pids');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  A.report('procledger.test');
})().catch(e => { console.error(e); process.exit(1); });
