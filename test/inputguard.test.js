/* node test/inputguard.test.js — the stuck cursor-confinement release (mouse-confinement incident, 2026-07-12).
   Locks the laws: a confined clip rect is reported AND released, a full-desktop rect is left alone, non-win32
   resolves honestly as skipped, and a probe failure is an error result — never a fake "cleared". Pure fakes
   (injected runPs) — no real PowerShell, fast gate. */
'use strict';
const A = require('./_assert.js');
const { makeInputGuard } = require('../sidecar/inputguard.js');

(async () => {
  // ---- 1. confined rect -> reported + released, and the log line names the reason ----
  const logs = [];
  let calls = 0;
  const g1 = makeInputGuard({
    platform: 'win32',
    log: (m) => logs.push(m),
    runPs: async () => { calls++; return JSON.stringify({ confined: true, cleared: true, rect: [27, 95, 773, 573], screen: [0, 0, 3840, 1080] }); }
  });
  const r1 = await g1.ensureFree('boot');
  A.ok(r1.confined, 'confinement detected');
  A.ok(r1.cleared, 'confinement released');
  A.eq(r1.rect.join(','), '27,95,773,573', 'the stuck rect is reported');
  A.eq(calls, 1, 'one probe per ensureFree');
  A.ok(logs.length === 1 && /confined/.test(logs[0]) && /boot/.test(logs[0]) && /released/.test(logs[0]), 'honest log line: confined + reason + released');

  // ---- 2. full-desktop rect -> untouched, silent ----
  const logs2 = [];
  const g2 = makeInputGuard({ platform: 'win32', log: (m) => logs2.push(m), runPs: async () => JSON.stringify({ confined: false, cleared: false, rect: [0, 0, 3840, 1080] }) });
  const r2 = await g2.ensureFree('shutdown');
  A.ok(!r2.confined && !r2.cleared, 'free cursor is left alone');
  A.eq(logs2.length, 0, 'no log noise when nothing was wrong');

  // ---- 3. a failed release is reported as NOT cleared (truthful telemetry) ----
  const logs3 = [];
  const g3 = makeInputGuard({ platform: 'win32', log: (m) => logs3.push(m), runPs: async () => JSON.stringify({ confined: true, cleared: false, rect: [1, 1, 2, 2] }) });
  const r3 = await g3.ensureFree('halt');
  A.ok(r3.confined && !r3.cleared, 'release failure is not masked');
  A.ok(/RELEASE FAILED/.test(logs3[0] || ''), 'log says the release failed');

  // ---- 4. non-win32 -> honest skip, runPs never invoked ----
  const g4 = makeInputGuard({ platform: 'darwin', runPs: async () => { A.ok(false, 'must not probe off-windows'); } });
  const r4 = await g4.ensureFree('boot');
  A.ok(r4.skipped && !r4.confined && !r4.cleared, 'non-win32 skips honestly');

  // ---- 5. probe failure -> error result, never a fake cleared ----
  const g5 = makeInputGuard({ platform: 'win32', runPs: async () => { throw new Error('powershell exploded'); } });
  const r5 = await g5.ensureFree('boot');
  A.ok(!r5.confined && !r5.cleared && /powershell exploded/.test(r5.error), 'probe failure reported as error');

  // ---- 6. garbage probe output -> error result ----
  const g6 = makeInputGuard({ platform: 'win32', runPs: async () => 'not json' });
  const r6 = await g6.ensureFree('boot');
  A.ok(!r6.cleared && r6.error, 'non-JSON probe output is an error, not a success');

  A.report('inputguard.test');
})().catch(e => { console.error(e); process.exit(1); });
