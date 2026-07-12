/* node test/folderpick.test.js — the native folder-picker core (sidecar/folderpick.js).
   Locks: per-platform command shapes, cancel-is-not-an-error interpretation, THE UNATTENDED RULE
   (interactive-only), single-flight (one dialog at a time), and honest 'unavailable' degradation
   when the platform has no picker or the binary can't launch. Headless — spawn is always faked. */
'use strict';
const A = require('./_assert.js');
const FP = require('../sidecar/folderpick.js');
const EventEmitter = require('node:events');

/* ---------- buildCommand: per-platform shapes ---------- */
const win = FP.buildCommand('win32');
A.eq(win.cmd, 'powershell.exe', 'win32 uses powershell');
A.ok(win.args.indexOf('-STA') >= 0, 'win32 dialog runs STA (WinForms requirement)');
A.ok(win.args.join(' ').indexOf('FolderBrowserDialog') >= 0, 'win32 uses FolderBrowserDialog');
const mac = FP.buildCommand('darwin');
A.eq(mac.cmd, 'osascript', 'darwin uses osascript');
A.ok(mac.args.join(' ').indexOf('choose folder') >= 0, 'darwin uses choose folder');
const lin = FP.buildCommand('linux');
A.eq(lin.cmd, 'zenity', 'linux uses zenity');
A.eq(FP.buildCommand('sunos'), null, 'unknown platform -> null (honest unavailable)');

/* ---------- interpret: OK / cancel / failure per platform ---------- */
A.eq(FP.interpret('win32', { code: 0, stdout: 'C:\\Users\\me\\proj\r\n' }), { ok: true, path: 'C:\\Users\\me\\proj' }, 'win32 OK path trimmed');
A.eq(FP.interpret('win32', { code: 0, stdout: '' }), { ok: true, cancelled: true }, 'win32 empty stdout = cancel');
A.eq(FP.interpret('darwin', { code: 0, stdout: '/Users/me/proj/\n' }), { ok: true, path: '/Users/me/proj' }, 'darwin trailing slash stripped');
A.eq(FP.interpret('darwin', { code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' }), { ok: true, cancelled: true }, 'darwin -128 = cancel');
A.eq(FP.interpret('linux', { code: 1, stdout: '' }), { ok: true, cancelled: true }, 'linux zenity exit 1 empty = cancel');
const fail = FP.interpret('linux', { code: 127, stdout: '', stderr: 'zenity: not found' });
A.eq(fail.ok, false, 'real failure is not a cancel');
A.eq(fail.code, 'failed', 'failure code');

/* ---------- pick(): unattended rule, single-flight, spawn error ---------- */
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => {};
  return c;
}

(async () => {
  // THE UNATTENDED RULE: no surface / autonomous surface -> deny, spawn never called.
  let spawned = 0;
  const denyPick = FP.makeFolderPick({ platform: 'win32', spawn: () => { spawned++; return fakeChild(); } });
  const denied = await denyPick.pick({ surface: 'autonomous' });
  A.eq(denied.ok, false, 'autonomous surface denied');
  A.eq(denied.code, 'autonomous', 'denial names the unattended rule');
  A.eq(spawned, 0, 'denied pick never spawns a process');

  // unknown platform -> unavailable without spawning.
  const noPick = FP.makeFolderPick({ platform: 'sunos', spawn: () => { spawned++; return fakeChild(); } });
  const un = await noPick.pick({ surface: 'interactive' });
  A.eq(un.code, 'unavailable', 'platform without a picker reports unavailable');
  A.eq(spawned, 0, 'unavailable pick never spawns');

  // happy path + SINGLE-FLIGHT: a second pick while the dialog is open answers busy.
  let child = null;
  const fp = FP.makeFolderPick({ platform: 'win32', spawn: () => { child = fakeChild(); return child; } });
  const first = fp.pick({ surface: 'interactive' });
  await new Promise(r => setImmediate(r));   // let the spawn land
  const busy = await fp.pick({ surface: 'interactive' });
  A.eq(busy.ok, false, 'second concurrent pick refused');
  A.eq(busy.code, 'busy', 'refusal names busy');
  child.stdout.emit('data', 'C:\\picked\\folder');
  child.emit('close', 0);
  const got = await first;
  A.eq(got, { ok: true, path: 'C:\\picked\\folder' }, 'dialog OK returns the picked path');

  // after the first resolves the lock is released.
  const again = fp.pick({ surface: 'interactive' });
  await new Promise(r => setImmediate(r));
  child.emit('close', 0);   // empty stdout = cancel
  A.eq(await again, { ok: true, cancelled: true }, 'lock released; cancel is not an error');

  // spawn error (binary missing) -> honest unavailable, lock released.
  const broken = FP.makeFolderPick({ platform: 'linux', spawn: () => { throw new Error('ENOENT'); } });
  const b1 = await broken.pick({ surface: 'interactive' });
  A.eq(b1.code, 'unavailable', 'spawn throw reports unavailable');
  const b2 = await broken.pick({ surface: 'interactive' });
  A.eq(b2.code, 'unavailable', 'lock is released after a spawn throw (not stuck busy)');

  A.report('folderpick.test');
})();
