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
  // Keyboard input lands in whatever window has FOCUS — these are the actions the focus-truth guard covers.
  const KEYBOARD_ACTIONS = ['type', 'key', 'hotkey'];
  // The harness's own window (desktop shell exe or a browser tab titled STARNET). Typing into it is never the
  // intent — it means the target app lost focus (the 2026-07-08 "typed the song into its own chat box" incident).
  const SELF_WINDOW_RE = /starnet/i;
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
    if (a.expectApp != null) a.expectApp = String(a.expectApp);
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
  // FOCUS-TRUTH GUARD: keyboard input is only delivered when we can prove (or the driver cannot know) which
  // window will receive it. Returns a human-readable foreground note for the tool result; throws when input
  // must NOT be sent: foreground is StarNet's own window, or it doesn't match the model's declared expectApp.
  async function checkFocus(driver, action) {
    if (KEYBOARD_ACTIONS.indexOf(action.action) < 0) return '';
    if (typeof driver.foreground !== 'function') {
      if (action.expectApp) throw new Error('focus check unavailable: this desktop driver cannot report the foreground window — input NOT sent');
      return '';
    }
    const fg = (await driver.foreground()) || {};
    const title = String(fg.title || ''), proc = String(fg.process || '');
    if (SELF_WINDOW_RE.test(title) || SELF_WINDOW_RE.test(proc)) {
      throw new Error('refused: the foreground window is StarNet itself ("' + (title || proc) + '") — the target app lost focus, so input was NOT sent; re-focus the target app (click it) before typing');
    }
    if (action.expectApp) {
      const want = action.expectApp.toLowerCase();
      if (title.toLowerCase().indexOf(want) < 0 && proc.toLowerCase().indexOf(want) < 0) {
        throw new Error('focus check failed: the foreground window is "' + title + '" (' + proc + '), expected "' + action.expectApp + '" — input was NOT sent; re-focus the target app and retry');
      }
    }
    return 'foreground="' + title + '" (' + proc + ')';
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
  // Environment selection is only ONE half of the authority check. Presence under the
  // desktop shell used to auto-enable physical input for every task; that was unsafe.
  // The shell marker is informational now: Windows plus an explicit driver selection is
  // necessary, and makeComputerTools still requires a host-minted attended lease per call.
  function win32DriverActive(env, platform) {
    // The real Win32 driver no longer lives on an activatable production path. Environment
    // variables are data a same-user child can forge; they can never mint desktop authority.
    void env; void platform;
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
    // Removed from the ordinary sidecar trust domain. A future attended-control feature must
    // be implemented by a native broker on a separate authority boundary with a one-shot,
    // exact-action user lease. Keeping this factory inert prevents an env flip or accidental
    // registration from reviving SetCursorPos/mouse_event.
    return makeInertDriver('the Win32 physical-input driver was removed from the task sidecar');
    /* istanbul ignore next - legacy implementation retained temporarily for source archaeology */
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
      // Which window will keyboard input actually land in? Title + owning process of the OS foreground window.
      foreground: async () => runPowerShellJson(`
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class StarNetFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$h = [StarNetFg]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[StarNetFg]::GetWindowText($h, $sb, 512) | Out-Null
$fgPid = [uint32]0
[StarNetFg]::GetWindowThreadProcessId($h, [ref]$fgPid) | Out-Null
$pname = ''
try { $pname = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName } catch {}
[Console]::Out.Write((@{ title = $sb.ToString(); process = $pname } | ConvertTo-Json -Compress))
`),
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

  // Fail-closed driver injected into every ordinary StarNet run. It throws instead of
  // returning success, so telemetry never claims an input action that policy prevented.
  function makeInertDriver(reason) {
    const why = reason || 'physical input is disabled for agent runs';
    const unavailable = async () => { throw new Error(why); };
    return { perform: unavailable, capture: unavailable, foreground: unavailable, inert: true };
  }

  // A task, autonomous/test surface, standing approval, Full Access, and the desktop-shell
  // environment are not input authority. The sole positive shape is reserved for a future
  // host-owned one-shot attended channel. No current runOnce caller mints this lease.
  function physicalInputAllowed(deps, ctx) {
    deps = deps || {}; ctx = ctx || {};
    return deps.allowPhysicalInput === true &&
      ctx.physicalInputAuthorized === true &&
      ctx.surface === 'interactive' &&
      ctx.isTask === false &&
      ctx.inputMode === 'attended';
  }
  function assertPhysicalInputAllowed(deps, ctx) {
    if (!physicalInputAllowed(deps, ctx)) {
      throw new Error('physical input is disabled: no explicit attended input lease; use headless CDP synthetic input instead');
    }
  }

  function makeDriver(deps) {
    deps = deps || {};
    if (deps.allowPhysicalInput !== true) return makeInertDriver();
    const d = deps && deps.driver;
    if (d && typeof d.perform === 'function') return d;
    if (process.platform === 'win32' && win32DriverActive(process.env, process.platform)) return makeWin32DesktopDriver();
    return makeInertDriver('computer-use unavailable: no explicitly configured attended desktop driver');
  }

  function makeComputerTools(deps) {
    deps = deps || {};
    const driver = makeDriver(deps);
    const useTool = {
      name: 'computer.use',
      // A cached shell/verify approval (`workbench:execute`) must never authorize input.
      capability: 'physical-input',
      impact: 'physical-input',
      scope: 'execute',
      requiresConsent: true,
      timeoutMs: 15000,
      description: 'PHYSICAL mouse/keyboard/screen control. Disabled in ordinary task, autonomous, and test runs; use browser.test_* for headless CDP synthetic input. It can run only through a separate host-minted attended input lease (not a prompt, standing approval, or Full Access grant).',
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
          capture_after: { type: 'boolean' },
          expectApp: { type: 'string', description: 'For type/key/hotkey: app or window-title substring that must be in the foreground, or the input is refused. Always pass it.' }
        }
      },
      run: async (args, ctx) => {
        assertPhysicalInputAllowed(deps, ctx);
        const action = hardBlock(args || {});
        const fgNote = await checkFocus(driver, action);   // throws BEFORE any input is sent when focus is wrong
        const result = await driver.perform(action);
        let proof = '';
        if (action.capture_after || action.action === 'screenshot') {
          const cap = await driver.capture();
          if (!cap) throw new Error('capture_after failed: no capture returned');
          if (typeof cap === 'string') proof = 'capture_after=' + cap;
          else proof = 'capture_after=' + JSON.stringify(cap);
        }
        const content = 'computer.' + action.action + ' ok' + (fgNote ? '\n' + fgNote : '') + (proof ? '\n' + proof : '') + (result ? '\n' + String(result) : '');
        return { content, summary: summarize(action) };
      }
    };
    return { useTool, register(reg) { reg.register(useTool); return reg; }, _internals: { ACTIONS, KEYBOARD_ACTIONS, SELF_WINDOW_RE, checkFocus, hardBlock, validateAction, summarize, COMMAND_TEXT_RE, win32DriverRequested, win32DriverActive, win32DriverDisabled, underDesktopShell, makeWin32DesktopDriver, makeInertDriver, physicalInputAllowed, assertPhysicalInputAllowed, keyToSendKeys, hotkeyToSendKeys, sendKeysEscapeLiteral } };
  }

  return { makeComputerTools, _internals: { ACTIONS, KEYBOARD_ACTIONS, SELF_WINDOW_RE, checkFocus, hardBlock, validateAction, summarize, COMMAND_TEXT_RE, win32DriverRequested, win32DriverActive, win32DriverDisabled, underDesktopShell, makeWin32DesktopDriver, makeInertDriver, physicalInputAllowed, assertPhysicalInputAllowed, keyToSendKeys, hotkeyToSendKeys, sendKeysEscapeLiteral } };
});
