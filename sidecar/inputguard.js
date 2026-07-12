/* sidecar/inputguard.js — release a stuck cursor confinement (mouse-confinement incident, 2026-07-12).

   Windows keeps ONE global cursor clip rectangle (win32 ClipCursor). It is supposed to be released by
   whoever set it — but when the setter dies without calling ClipCursor(NULL) (a pointer-lock game whose
   browser was killed, a crashed test process), the user's REAL mouse stays walled into a small box with
   nothing left alive to blame. In the incident the confinement survived closing StarNet entirely.

   ensureFree(reason) reads GetClipCursor, compares it to the virtual screen (GetSystemMetrics 76-79), and
   calls ClipCursor(NULL) only when the rect is actually smaller than the desktop. One PowerShell one-shot,
   win32 only (no cursor clip concept to un-stick elsewhere); non-win32 resolves honestly as skipped.

   Wired at: sidecar boot (after the proc-ledger orphan sweep), graceful shutdown, and E-STOP. Deliberately
   NOT run periodically — while the user is playing their own game, its legitimate confinement is theirs;
   we only clean at harness-lifecycle moments, where a constrained clip is either ours or abandoned.

     makeInputGuard({ runPs?, platform?, log? }) -> { ensureFree(reason) -> Promise<{confined,cleared,rect}> } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).inputguard = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct SNRECT { public int Left, Top, Right, Bottom; }
public class SNInputGuard {
  [DllImport("user32.dll")] public static extern bool GetClipCursor(out SNRECT rect);
  [DllImport("user32.dll")] public static extern bool ClipCursor(IntPtr rect);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
"@
$r = New-Object SNRECT
[SNInputGuard]::GetClipCursor([ref]$r) | Out-Null
$vx = [SNInputGuard]::GetSystemMetrics(76); $vy = [SNInputGuard]::GetSystemMetrics(77)
$vw = [SNInputGuard]::GetSystemMetrics(78); $vh = [SNInputGuard]::GetSystemMetrics(79)
$confined = ($r.Left -gt $vx) -or ($r.Top -gt $vy) -or ($r.Right -lt ($vx + $vw)) -or ($r.Bottom -lt ($vy + $vh))
$cleared = $false
if ($confined) { $cleared = [SNInputGuard]::ClipCursor([IntPtr]::Zero) }
[Console]::Out.Write((@{ confined = [bool]$confined; cleared = [bool]$cleared; rect = @($r.Left, $r.Top, $r.Right, $r.Bottom); screen = @($vx, $vy, $vw, $vh) } | ConvertTo-Json -Compress))
`;

  function defaultRunPs() {
    const CP = require('node:child_process');
    return () => new Promise((resolve, reject) => {
      const exe = process.env.SystemRoot ? process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'powershell.exe';
      CP.execFile(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, stdout) => {
        if (err) return reject(new Error(String(err.message || 'input guard probe failed')));
        resolve(String(stdout || '').trim());
      });
    });
  }

  function makeInputGuard(deps) {
    deps = deps || {};
    const platform = deps.platform || (typeof process !== 'undefined' ? process.platform : '');
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const runPs = deps.runPs || (platform === 'win32' ? defaultRunPs() : null);

    async function ensureFree(reason) {
      if (platform !== 'win32' || !runPs) return { confined: false, cleared: false, skipped: true };
      let out;
      try { out = JSON.parse(await runPs()); }
      catch (e) { return { confined: false, cleared: false, error: String((e && e.message) || e) }; }
      const res = { confined: !!(out && out.confined), cleared: !!(out && out.cleared), rect: (out && out.rect) || null };
      if (res.confined) {
        log('[input-guard] cursor was confined to [' + (res.rect || []).join(',') + '] at ' + (reason || 'check') + (res.cleared ? ' — confinement released' : ' — RELEASE FAILED'));
      }
      return res;
    }

    return { ensureFree, _internals: { SCRIPT } };
  }

  return { makeInputGuard, _internals: { SCRIPT } };
});
