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
  function runPowerShell(script, timeoutMs) {
    const exe = process.env.SystemRoot ? process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'powershell.exe';
    const res = CP.spawnSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-Command', script], {
      encoding: 'utf8',
      timeout: timeoutMs || 15000,
      windowsHide: true
    });
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error((res.stderr || res.stdout || 'PowerShell desktop driver failed').trim());
    return String(res.stdout || '').trim();
  }
  function runPowerShellJson(script, timeoutMs) {
    const out = runPowerShell(script, timeoutMs);
    try { return JSON.parse(out); } catch (e) { throw new Error('desktop driver returned invalid JSON: ' + out.slice(0, 200)); }
  }
  function win32DriverRequested(env) {
    env = env || process.env;
    return /^(1|true|win32|windows)$/i.test(String(env.STARNET_COMPUTER_DRIVER || env.SKYNET_COMPUTER_DRIVER || ''));
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
          runPowerShellJson(mouseScript('[StarNetMouse]::SetCursorPos(' + Math.round(a.x || 0) + ', ' + Math.round(a.y || 0) + ') | Out-Null'));
          return 'moved pointer';
        }
        if (a.action === 'click' || a.action === 'double_click') {
          const x = Math.round(a.x || 0), y = Math.round(a.y || 0);
          const click = '[StarNetMouse]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 40; [StarNetMouse]::mouse_event(4,0,0,0,0);';
          const body = '[StarNetMouse]::SetCursorPos(' + x + ', ' + y + ') | Out-Null; ' + click + (a.action === 'double_click' ? ' Start-Sleep -Milliseconds 80; ' + click : '');
          runPowerShellJson(mouseScript(body));
          return a.action + ' delivered';
        }
        if (a.action === 'scroll') {
          const data = Math.round(Number(a.dy || 0) || Number(a.y || 0) || 0);
          runPowerShellJson(mouseScript('[StarNetMouse]::mouse_event(2048,0,0,' + data + ',0);'));
          return 'scroll delivered';
        }
        throw new Error('local win32 desktop driver currently supports screenshot, wait, move, click, double_click, and scroll');
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
    if (process.platform === 'win32' && win32DriverRequested(process.env)) return makeWin32DesktopDriver();
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
    return { useTool, register(reg) { reg.register(useTool); return reg; }, _internals: { ACTIONS, hardBlock, validateAction, summarize, COMMAND_TEXT_RE, win32DriverRequested, makeWin32DesktopDriver } };
  }

  return { makeComputerTools, _internals: { ACTIONS, hardBlock, validateAction, summarize, COMMAND_TEXT_RE, win32DriverRequested, makeWin32DesktopDriver } };
});
