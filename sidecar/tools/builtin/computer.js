/* sidecar/tools/builtin/computer.js - desktop computer-use tool.
   The real OS driver is injected by the desktop shell. This module owns the
   harness contract: action enum, consent/execute scope, destructive input
   hard-blocks, and capture_after proof.

   makeComputerTools({ driver? }) -> { useTool, register(reg), _internals }
     driver.perform(action) -> Promise
     driver.capture()       -> Promise<{ width, height, ... } | string>
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).computer = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CP = require('node:child_process');

  const ACTIONS = ['screenshot', 'move', 'click', 'double_click', 'drag', 'scroll', 'type', 'key', 'hotkey', 'wait'];
  const DESTRUCTIVE_HOTKEYS = [
    'ctrl+alt+delete',
    'ctrl+shift+esc',
    'alt+f4',
    'meta+r',
    'win+r',
    'meta+x',
    'win+x',
    'ctrl+w',
    'ctrl+q'
  ];
  const COMMAND_TEXT_RE = /\b(cmd|powershell|pwsh|bash|sh)\s+(\/c|-c)\b|(^|\s)(rm\s+-rf|del\s+\/[sq]|format\s+[a-z]:|shutdown\b|restart-computer\b|reg\s+delete\b|curl\s+.*\|\s*(sh|bash|pwsh|powershell))/i;

  function normKey(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/windows/g, 'win').replace(/command/g, 'meta');
  }
  function validateAction(raw) {
    const a = Object.assign({}, raw || {});
    a.action = String(a.action || '').trim();
    if (ACTIONS.indexOf(a.action) < 0) throw new Error('unsupported computer action: ' + a.action);
    if (a.x != null) a.x = Number(a.x);
    if (a.y != null) a.y = Number(a.y);
    if (a.dx != null) a.dx = Number(a.dx);
    if (a.dy != null) a.dy = Number(a.dy);
    if (a.durationMs != null) a.durationMs = Math.max(0, Math.min(10000, Number(a.durationMs) || 0));
    if (a.button != null) a.button = String(a.button);
    if (a.text != null) a.text = String(a.text);
    if (a.key != null) a.key = String(a.key);
    if (a.keys != null && !Array.isArray(a.keys)) throw new Error('computer hotkey keys must be an array');
    if (Array.isArray(a.keys)) a.keys = a.keys.map(k => String(k));
    return a;
  }
  function hardBlock(action) {
    const a = validateAction(action);
    if (a.action === 'type' && COMMAND_TEXT_RE.test(a.text || '')) {
      throw new Error('blocked command-like desktop typing pattern');
    }
    if (a.action === 'hotkey') {
      const combo = normKey((a.keys || []).join('+') || a.key);
      if (DESTRUCTIVE_HOTKEYS.indexOf(combo) >= 0) throw new Error('blocked destructive desktop hotkey: ' + combo);
    }
    if (a.action === 'key') {
      const key = normKey(a.key);
      if (DESTRUCTIVE_HOTKEYS.indexOf(key) >= 0) throw new Error('blocked destructive desktop key: ' + key);
    }
    return a;
  }
  function summarize(action) {
    const a = action || {};
    if (a.action === 'type') return 'type ' + String(a.text || '').length + ' chars';
    if (a.action === 'hotkey') return 'hotkey ' + ((a.keys || []).join('+') || a.key || '');
    if (a.action === 'click' || a.action === 'double_click' || a.action === 'move') return a.action + ' ' + a.x + ',' + a.y;
    if (a.action === 'drag') return 'drag ' + a.x + ',' + a.y + ' by ' + (a.dx || 0) + ',' + (a.dy || 0);
    if (a.action === 'scroll') return 'scroll ' + (a.dx || 0) + ',' + (a.dy || 0);
    return a.action;
  }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  // ASYNC (was CP.spawnSync): a computer.use action drives PowerShell for up to 15s; spawnSync BLOCKED the whole
  // sidecar event loop for that entire window — /api/health, every other run, and the SSE keep-alives all froze
  // behind a single mouse move. execFile runs the child off-thread so the host stays responsive. Same argv,
  // timeout, and windowsHide; the {error,status,stdout,stderr} handling maps onto execFile's (err, stdout, stderr).
  function runPowerShell(script, timeoutMs) {
    const exe = process.env.SystemRoot ? process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'powershell.exe';
    return new Promise((resolve, reject) => {
      CP.execFile(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-Command', script], {
        encoding: 'utf8',
        timeout: timeoutMs || 15000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024   // a screenshot capture returns a JSON blob; keep headroom (spawnSync had no cap)
      }, (err, stdout, stderr) => {
        if (err) {
          // execFile folds a non-zero exit, a spawn failure, and a timeout into err; preserve the old message shape
          // (prefer stderr, then stdout, then a generic fallback).
          const msg = (String(stderr || '').trim() || String(stdout || '').trim() || (err && err.message) || 'PowerShell desktop driver failed');
          return reject(new Error(msg));
        }
        resolve(String(stdout || '').trim());
      });
    });
  }
  async function runPowerShellJson(script, timeoutMs) {
    const out = await runPowerShell(script, timeoutMs);
    try { return JSON.parse(out); } catch (e) { throw new Error('desktop driver returned invalid JSON: ' + out.slice(0, 200)); }
  }
  function win32DriverRequested(env) {
    env = env || process.env;
    return /^(1|true|win32|windows)$/i.test(String(env.STARNET_COMPUTER_DRIVER || env.SKYNET_COMPUTER_DRIVER || ''));
  }
  // Was the driver explicitly DISABLED? Lets a desktop-shell run opt back out (e.g. QA)
  // without unsetting the shell marker.
  function win32DriverDisabled(env) {
    env = env || process.env;
    return /^(0|false|off|none)$/i.test(String(env.STARNET_COMPUTER_DRIVER || env.SKYNET_COMPUTER_DRIVER || ''));
  }
  function underDesktopShell(env) {
    env = env || process.env;
    return /^(1|true|yes|on)$/i.test(String(env.STARNET_DESKTOP_SHELL || env.SKYNET_DESKTOP_SHELL || ''));
  }
  // The real win32 desktop driver is active when: explicitly requested by env, OR we are
  // on win32 running under the real desktop shell (and not explicitly disabled). A headless
  // / server / CI `node sidecar/index.js` sets neither, so it keeps the safe no-driver stub.
  function win32DriverActive(env, platform) {
    env = env || process.env;
    platform = platform || process.platform;
    if (win32DriverRequested(env)) return true;
    if (platform === 'win32' && underDesktopShell(env) && !win32DriverDisabled(env)) return true;
    return false;
  }
  // ---- win32 keyboard (SendKeys) helpers ----
  // SendKeys treats + ^ % ~ ( ) { } [ ] as control chars; escape each by wrapping in {}
  // so LITERAL text types verbatim. (hardBlock already ran in the tool layer.)
  function sendKeysEscapeLiteral(s) {
    return String(s == null ? '' : s).replace(/[+^%~(){}\[\]]/g, ch => '{' + ch + '}');
  }
  // Named single keys -> SendKeys tokens. Printable single chars pass through (escaped).
  const SENDKEYS_NAMED = {
    enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
    backspace: '{BACKSPACE}', bs: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}',
    pageup: '{PGUP}', pagedown: '{PGDN}', space: ' ', spacebar: ' ', insert: '{INSERT}',
    f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}', f7: '{F7}',
    f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}'
  };
  const SENDKEYS_MOD = { ctrl: '^', control: '^', alt: '%', shift: '+', win: '', meta: '' };
  function keyToSendKeys(key) {
    const k = String(key == null ? '' : key).trim();
    const named = SENDKEYS_NAMED[k.toLowerCase()];
    if (named) return named;
    if (k.length === 1) return sendKeysEscapeLiteral(k);
    throw new Error('unsupported desktop key: ' + key);
  }
  // A hotkey combo: last token is the key, the rest are modifiers. Win/meta cannot be
  // expressed via SendKeys, so a combo requiring it is refused (rather than silently dropped).
  function hotkeyToSendKeys(keys) {
    const arr = (Array.isArray(keys) ? keys : String(keys || '').split('+')).map(s => String(s).trim()).filter(Boolean);
    if (!arr.length) throw new Error('empty desktop hotkey');
    const mods = arr.slice(0, -1), main = arr[arr.length - 1];
    let prefix = '';
    for (const m of mods) {
      const ml = m.toLowerCase();
      if (!(ml in SENDKEYS_MOD)) throw new Error('unsupported hotkey modifier: ' + m);
      if (ml === 'win' || ml === 'meta') throw new Error('win/meta hotkeys are not supported by the local driver: ' + arr.join('+'));
      prefix += SENDKEYS_MOD[ml];
    }
    return prefix + '(' + keyToSendKeys(main) + ')';
  }
  // Build the PowerShell that SendWait's a SendKeys token string. The token string is passed
  // base64-encoded so no quoting/interpolation of user text ever reaches the shell.
  function sendKeysScript(tokens) {
    const b64 = Buffer.from(String(tokens || ''), 'utf16le').toString('base64');
    return `
Add-Type -AssemblyName System.Windows.Forms
$keys = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${b64}'))
[System.Windows.Forms.SendKeys]::SendWait($keys)
[Console]::Out.Write((@{ ok = $true } | ConvertTo-Json -Compress))
`;
  }
  function makeWin32DesktopDriver() {
    function mouseScript(body) {
      return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class StarNetMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra);
}
"@
${body}
[Console]::Out.Write((@{ ok = $true } | ConvertTo-Json -Compress))
`;
    }
    return {
      perform: async (action) => {
        const a = validateAction(action);
        if (a.action === 'screenshot') return 'desktop screenshot requested';
        if (a.action === 'wait') { await sleep(a.durationMs || 500); return 'waited ' + (a.durationMs || 500) + 'ms'; }
        if (a.action === 'move') {
          await runPowerShellJson(mouseScript('[StarNetMouse]::SetCursorPos(' + Math.round(a.x || 0) + ', ' + Math.round(a.y || 0) + ') | Out-Null'));
          return 'moved pointer';
        }
        if (a.action === 'click' || a.action === 'double_click') {
          const x = Math.round(a.x || 0), y = Math.round(a.y || 0);
          const click = '[StarNetMouse]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 40; [StarNetMouse]::mouse_event(4,0,0,0,0);';
          const body = '[StarNetMouse]::SetCursorPos(' + x + ', ' + y + ') | Out-Null; ' + click + (a.action === 'double_click' ? ' Start-Sleep -Milliseconds 80; ' + click : '');
          await runPowerShellJson(mouseScript(body));
          return a.action + ' delivered';
        }
        if (a.action === 'scroll') {
          const data = Math.round(Number(a.dy || 0) || Number(a.y || 0) || 0);
          await runPowerShellJson(mouseScript('[StarNetMouse]::mouse_event(2048,0,0,' + data + ',0);'));
          return 'scroll delivered';
        }
        if (a.action === 'type') {
          // hardBlock (command-like typing) already ran in the tool layer.
          await runPowerShellJson(sendKeysScript(sendKeysEscapeLiteral(a.text || '')));
          return 'typed ' + String(a.text || '').length + ' chars';
        }
        if (a.action === 'key') {
          // hardBlock (destructive key) already ran in the tool layer.
          await runPowerShellJson(sendKeysScript(keyToSendKeys(a.key)));
          return 'key ' + a.key + ' delivered';
        }
        if (a.action === 'hotkey') {
          // hardBlock (destructive hotkey) already ran in the tool layer.
          const combo = (a.keys && a.keys.length) ? a.keys : a.key;
          await runPowerShellJson(sendKeysScript(hotkeyToSendKeys(combo)));
          return 'hotkey ' + ((a.keys || []).join('+') || a.key || '') + ' delivered';
        }
        if (a.action === 'drag') throw new Error('local win32 desktop driver does not yet support drag');
        throw new Error('unsupported win32 desktop action: ' + a.action);
      },
      capture: async () => runPowerShellJson(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw "primary screen has no size" }
$path = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "starnet-computer-" + [guid]::NewGuid().ToString() + ".png")
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  $bytes = (Get-Item -LiteralPath $path).Length
  [Console]::Out.Write((@{ width = $bounds.Width; height = $bounds.Height; bytes = $bytes; sha256 = $hash } | ConvertTo-Json -Compress))
} finally {
  try { $g.Dispose() } catch {}
  try { $bmp.Dispose() } catch {}
  try { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue } catch {}
}
`, 20000)
    };
  }
  function makeDriver(deps) {
    const d = deps && deps.driver;
    if (d && typeof d.perform === 'function') return d;
    if (process.platform === 'win32' && win32DriverActive(process.env, process.platform)) return makeWin32DesktopDriver();
    return {
      perform: async () => { throw new Error('computer-use unavailable: no desktop driver configured'); },
      capture: async () => { throw new Error('computer-use unavailable: no desktop capture driver configured'); }
    };
  }

  function makeComputerTools(deps) {
    deps = deps || {};
    const driver = makeDriver(deps);
    const useTool = {
      name: 'computer.use',
      capability: 'workbench',
      scope: 'execute',
      requiresConsent: true,
      timeoutMs: 15000,
      description: 'Control the local desktop through an attended, consent-gated computer-use driver. Supports screenshot, move, click, double_click, drag, scroll, type, key, hotkey, and wait. Destructive shortcuts and command-like typing are blocked.',
      schema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ACTIONS },
          x: { type: 'number' },
          y: { type: 'number' },
          dx: { type: 'number' },
          dy: { type: 'number' },
          button: { type: 'string' },
          text: { type: 'string' },
          key: { type: 'string' },
          keys: { type: 'array', items: { type: 'string' } },
          durationMs: { type: 'number' },
          capture_after: { type: 'boolean' }
        }
      },
      run: async (args, ctx) => {
        const action = hardBlock(args || {});
        const result = await driver.perform(action);
        let proof = '';
        if (action.capture_after || action.action === 'screenshot') {
          const cap = await driver.capture();
          if (!cap) throw new Error('capture_after failed: no capture returned');
          if (typeof cap === 'string') proof = 'capture_after=' + cap;
          else proof = 'capture_after=' + JSON.stringify(cap);
        }
        const content = 'computer.' + action.action + ' ok' + (proof ? '\n' + proof : '') + (result ? '\n' + String(result) : '');
        return { content, summary: summarize(action) };
      }
    };
    return { useTool, register(reg) { reg.register(useTool); return reg; }, _internals: { ACTIONS, hardBlock, validateAction, summarize, COMMAND_TEXT_RE, win32DriverRequested, win32DriverActive, win32DriverDisabled, underDesktopShell, makeWin32DesktopDriver, keyToSendKeys, hotkeyToSendKeys, sendKeysEscapeLiteral } };
  }

  return { makeComputerTools, _internals: { ACTIONS, hardBlock, validateAction, summarize, COMMAND_TEXT_RE, win32DriverRequested, win32DriverActive, win32DriverDisabled, underDesktopShell, makeWin32DesktopDriver, keyToSendKeys, hotkeyToSendKeys, sendKeysEscapeLiteral } };
});
