/* sidecar/tools/builtin/desktop.js - open-on-the-user's-real-screen tool.

   desktop.open is the ONE builtin that surfaces a VISIBLE window on the user's
   actual screen: it hands a URL (or an app name) to the OS default handler
   (Windows Start-Process, macOS `open`, Linux `xdg-open`) so the human SEES it.
   This is deliberately distinct from browser.* — that family drives a HEADLESS
   Chromium the user cannot see. When a beginner says "open youtube for me / on
   my screen / pull up X", THIS is the tool to use.

   SECURITY:
   - URLs reuse browser.js assertSafeUrl (http(s) only; private/loopback/intranet
     refused) so this can't be used to reach the user's LAN or localhost services.
   - App launches are limited to a bare program name (a single token: letters,
     digits, dot, dash, underscore) — no path separators, no arguments, no shell
     metacharacters — and are handed to the opener as a discrete argv token, never
     interpolated into a shell string. That keeps "open notepad" working while
     making "open <arbitrary command line>" impossible.

   makeDesktopTools({ opener?, assertSafeUrl?, platform? }) -> { tools, register, _internals }
     opener({ kind:'url'|'app', target }) -> Promise<string>   (injected in tests)
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).desktop = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CP = require('node:child_process');
  const browser = require('./browser.js');
  const defaultAssertSafeUrl = browser._internals.assertSafeUrl;

  // A launchable app name: one token, no path/args/shell metacharacters. This is
  // NOT a path — the OS resolves it against PATH / registered app names.
  const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  // Anything that looks like a URL should go through the URL path, not the app path.
  const LOOKS_URLISH = /:\/\/|^[a-z][a-z0-9+.-]*:/i;

  function classify(target) {
    const t = String(target == null ? '' : target).trim();
    if (!t) throw new Error('desktop.open needs a url or app name');
    // Bare host like "youtube.com" or "www.youtube.com" -> assume https.
    const looksHost = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(t) && !/\s/.test(t);
    if (LOOKS_URLISH.test(t) || looksHost) {
      const withScheme = LOOKS_URLISH.test(t) ? t : 'https://' + t;
      return { kind: 'url', target: withScheme };
    }
    if (APP_NAME_RE.test(t)) return { kind: 'app', target: t };
    throw new Error('desktop.open: not a valid url or a bare app name: ' + t);
  }

  function makeShellOpener(deps) {
    deps = deps || {};
    const platform = deps.platform || process.platform;
    const timeoutMs = deps.timeoutMs || 15000;
    // ASYNC by default: an OS "open" hands off to the default handler and returns fast, but a wedged handler
    // could block the whole sidecar event loop for the full timeout under the old spawnSync. execFile runs it
    // off-thread so /api/health and every other run stay responsive. A test may still inject a SYNCHRONOUS
    // spawnSync stub (deps.spawnSync) — we adapt its {status,stdout,stderr,error} return into the same async
    // result so the injected-opener contract is unchanged.
    const spawnSyncStub = deps.spawnSync;
    function runViaSpawnSync(cmd, args) {
      const res = spawnSyncStub(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
      if (res && res.error) throw res.error;
      if (res && res.status != null && res.status !== 0) {
        throw new Error((res.stderr || res.stdout || (cmd + ' exited ' + res.status)).toString().trim());
      }
      return 'launched';
    }
    function runViaExecFile(cmd, args) {
      return new Promise((resolve, reject) => {
        CP.execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
          if (err) {
            // execFile surfaces a non-zero exit / spawn failure / timeout as err; mirror the old error text shape.
            return reject(new Error((stderr || stdout || (err && err.message) || (cmd + ' failed')).toString().trim()));
          }
          resolve('launched');
        });
      });
    }
    const run = spawnSyncStub ? (cmd, args) => Promise.resolve().then(() => runViaSpawnSync(cmd, args)) : runViaExecFile;
    return async ({ kind, target }) => {
      if (platform === 'win32') {
        // Start-Process resolves both URLs (default browser) and app names (PATH /
        // App Paths). target is passed as a discrete argv token via -ArgumentList-free
        // form; PowerShell receives it as the -FilePath value, not a shell string.
        const psExe = process.env.SystemRoot
          ? process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
          : 'powershell.exe';
        // Single-quote-escape for the literal PowerShell string; target is already
        // validated (safe URL or bare app name) so this is defense in depth.
        const lit = "'" + String(target).replace(/'/g, "''") + "'";
        return run(psExe, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath ' + lit]);
      }
      if (platform === 'darwin') {
        return kind === 'app' ? run('open', ['-a', target]) : run('open', [target]);
      }
      // linux / other posix
      if (kind === 'app') return run(target, []);
      return run('xdg-open', [target]);
    };
  }

  function makeDesktopTools(deps) {
    deps = deps || {};
    const assertSafeUrl = deps.assertSafeUrl || defaultAssertSafeUrl;
    const opener = deps.opener || makeShellOpener(deps);

    async function open(target) {
      const c = classify(target);
      if (c.kind === 'url') {
        const u = assertSafeUrl(c.target);   // throws on private/loopback/intranet/non-http(s)
        c.target = u.href;
      }
      const result = await opener(c);
      return { kind: c.kind, target: c.target, result: result || 'launched' };
    }

    const openTool = {
      name: 'desktop.open',
      capability: 'web',
      scope: 'execute',
      requiresConsent: true,
      timeoutMs: 20000,
      description: 'Open a URL or a desktop app on the USER\'S REAL SCREEN — hands it to the OS default handler so a VISIBLE window (their normal browser / the app) actually appears in front of the user. Use THIS whenever the user says "for me", "on my screen", "open/pull up X", or otherwise wants to see something themselves. This is the opposite of browser.* (which drives a headless browser the user cannot see). Only public http(s) URLs (private/loopback/intranet refused) or a bare app name (e.g. "notepad"); no paths, arguments, or shell commands.',
      schema: {
        type: 'object',
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'A public http(s) URL (or bare host like youtube.com), or a bare app name like "notepad".' }
        }
      },
      run: async (args) => {
        const r = await open((args && args.target) || '');
        const label = r.kind === 'url' ? r.target : 'app ' + r.target;
        return { content: 'Opened ' + label + ' on the user\'s screen (' + r.result + ').', summary: 'opened ' + r.kind };
      }
    };

    const tools = [openTool];
    return {
      tools,
      register(reg) { tools.forEach(t => reg.register(t)); return reg; },
      _internals: { classify, makeShellOpener, open, APP_NAME_RE }
    };
  }

  return { makeDesktopTools, _internals: { classify, makeShellOpener, APP_NAME_RE } };
});
