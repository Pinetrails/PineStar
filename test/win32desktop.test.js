'use strict';
const A = require('./_assert.js');
const { makeWin32DesktopDriver, powershellPath } = require('../sidecar/tools/builtin/win32desktop.js');

(async () => {
  const seen = [];
  const driver = makeWin32DesktopDriver({
    platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
    execFile: (exe, args, opts, cb) => {
      seen.push({ exe, args, opts });
      const request = JSON.parse(opts.env.STARNET_REMOTE_DESKTOP_REQUEST);
      if (request.kind === 'capture') return cb(null, JSON.stringify({ width: 2, height: 1, data: 'iVBORw0KGgo=' }), '');
      if (request.kind === 'foreground') return cb(null, JSON.stringify({ title: 'Notepad', process: 'notepad' }), '');
      cb(null, JSON.stringify({ ok: true, action: request.action.action }), '');
    }
  });
  A.ok(driver, 'Windows creates the native driver');
  A.eq(powershellPath({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'native driver resolves the system PowerShell path');
  A.eq(await driver.perform({ action: 'type', text: "x'; Remove-Item C:\\*" }), 'performed type', 'action data is treated as data by the native bridge');
  A.eq(JSON.parse(seen[0].opts.env.STARNET_REMOTE_DESKTOP_REQUEST).action.text, "x'; Remove-Item C:\\*", 'untrusted action text travels only inside JSON');
  A.ok(!seen[0].args.join(' ').includes("Remove-Item"), 'action text is never interpolated into the PowerShell program');
  A.eq(await driver.foreground(), { title: 'Notepad', process: 'notepad' }, 'native foreground probe is returned as structured data');
  A.eq((await driver.capture()).width, 2, 'native capture returns image metadata');
  A.eq(makeWin32DesktopDriver({ platform: 'linux' }), null, 'non-Windows host has no native driver');
  A.report('win32desktop.test');
})().catch(e => { console.error(e); process.exit(1); });
