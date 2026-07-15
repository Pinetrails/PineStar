#!/usr/bin/env node
/*
 * update-canary.mjs — prove the desktop update system END-TO-END with zero public
 * exposure. Everything runs on 127.0.0.1: no GitHub, no published release, no users.
 *
 * WHAT IT PROVES (the exact machinery production uses):
 *   check loop → manifest fetch → version compare → download → minisign signature
 *   verification against the baked pubkey → NSIS passive install → restart as the
 *   new version. The manifest is assembled by the REAL release-assemble-manifest.mjs
 *   (including its cryptographic artifact/.sig verification) — only the asset-base
 *   URL differs from production.
 *
 * ISOLATION: canary builds carry productName "StarNet Canary" + identifier
 *   ai.skynet.harness.canary, so they install SIDE BY SIDE with the real StarNet —
 *   different install dir, different %APPDATA% workspace. Your real install and data
 *   are untouched. Uninstall "StarNet Canary" from Windows when done.
 *
 * USAGE (Windows, in order):
 *   node scripts/update-canary.mjs build-old    # OLD installer @ current version, endpoint = localhost
 *   node scripts/update-canary.mjs build-new    # NEW installer @ patch-bumped version + signed feed
 *   node scripts/update-canary.mjs serve        # serve the feed on 127.0.0.1:8799 (leave running)
 *   → run .canary/old/*.exe to install, open StarNet Canary, SYSTEM → UPDATE CENTER →
 *     CHECK NOW → INSTALL UPDATE. Watch the serve log take the hits; the app restarts
 *     as the bumped version (title/Update Center show it).
 *   node scripts/update-canary.mjs status       # what's staged + the next step
 *
 * AUTOMATED PATH (instead of clicking through the UI yourself):
 *   node scripts/update-canary.mjs install-old  # silent NSIS install + launch with CDP open
 *   node scripts/update-canary.mjs drive        # CDP-drive check → install → restart, print receipts
 *   (serve must be running in another terminal; drive polls the app over CDP port 9333.)
 *
 * Options: --port <n> (default 8799) · --dir <path> (default .canary) ·
 *          --version <X.Y.Z> (build-new only; default = conf patch+1) ·
 *          --cdp-port <n> (default 9333, installed-smoke convention)
 *
 * NOTES:
 *   - Needs the updater private key at ~/.tauri/starnet-updater.key (or
 *     TAURI_SIGNING_PRIVATE_KEY in the env). Same key as production — that's the point.
 *   - Each build is a full Rust release build (10–30 min; first run in a fresh worktree
 *     is slowest). A rustc ctor-race crash = re-run the same command, the cache resumes.
 *   - The localhost endpoint needs the updater's dangerousInsecureTransportProtocol
 *     flag; it is set ONLY in the canary overlay, never in the shipped conf.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCDP, evalJS, sleep } from './lib/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const cmd = args[0] || 'status';
function argVal(name, dflt) {
  const i = args.indexOf(name);
  return (i >= 0 && args[i + 1]) ? args[i + 1] : dflt;
}
const PORT = +argVal('--port', '8799');
const DIR = resolve(ROOT, argVal('--dir', '.canary'));
const FEED = join(DIR, 'feed');
const OLD = join(DIR, 'old');

function log(m) { process.stdout.write(m + '\n'); }
function fail(m) { process.stderr.write('update-canary: ' + m + '\n'); process.exit(1); }

function conf() {
  return JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8').replace(/^﻿/, ''));
}
function bumpPatch(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) fail('cannot parse version "' + v + '"');
  return m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1);
}

function signingEnv() {
  const env = Object.assign({}, process.env);
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    const keyFile = join(homedir(), '.tauri', 'starnet-updater.key');
    if (!existsSync(keyFile)) fail('no TAURI_SIGNING_PRIVATE_KEY in env and no ' + keyFile);
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, 'utf8').trim();
  }
  if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
  return env;
}

// Build-time overlay: same source, same frontend, same pubkey — different identity
// (side-by-side install) and a localhost updater endpoint.
function overlayFor(version) {
  return {
    productName: 'StarNet Canary',
    identifier: 'ai.skynet.harness.canary',
    version,
    plugins: {
      updater: {
        endpoints: ['http://127.0.0.1:' + PORT + '/latest.json'],
        dangerousInsecureTransportProtocol: true
      }
    }
  };
}

function buildCanary(version, destDir) {
  if (process.platform !== 'win32') fail('canary builds are Windows-only for now (NSIS leg)');
  mkdirSync(destDir, { recursive: true });
  const overlayPath = join(DIR, 'overlay-' + version + '.json');
  mkdirSync(DIR, { recursive: true });
  writeFileSync(overlayPath, JSON.stringify(overlayFor(version), null, 2) + '\n');

  log('staging bundled Node sidecar (idempotent)…');
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'prepare-node.mjs'), 'win-x64'], { cwd: ROOT, stdio: 'inherit' });

  log('building StarNet Canary v' + version + ' (full Rust release build — 10-30 min; a rustc ctor-race crash = just re-run)…');
  const r = spawnSync('npm', ['run', 'tauri', '--', 'build', '--bundles', 'nsis', '--config', overlayPath],
    { cwd: ROOT, stdio: 'inherit', env: signingEnv(), shell: true });
  if (r.status !== 0) fail('tauri build failed (exit ' + r.status + '). If rustc crashed (ctor race), re-run this exact command — the cache resumes.');

  // Locate the produced canary installer (+ .sig) and stage it.
  const nsisDir = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const made = readdirSync(nsisDir).filter(f => f.startsWith('StarNet Canary_' + version + '_') && f.endsWith('-setup.exe'));
  if (made.length !== 1) fail('expected exactly one StarNet Canary_' + version + '_*-setup.exe in ' + nsisDir + ', found ' + made.length);
  const exe = made[0];
  copyFileSync(join(nsisDir, exe), join(destDir, exe));
  if (existsSync(join(nsisDir, exe + '.sig'))) copyFileSync(join(nsisDir, exe + '.sig'), join(destDir, exe + '.sig'));
  log('staged: ' + join(destDir, exe));
  return exe;
}

function assembleFeed(version) {
  // The REAL manifest builder — including its minisign verification of the .sig
  // against the baked pubkey — with only the asset base swapped to localhost.
  const r = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'release-assemble-manifest.mjs'),
    '--dist', FEED,
    '--version', version,
    '--repo', 'nonfungiblefunyuns-ship-it/starnet-releases',
    '--tag', 'v' + version,
    '--asset-base', 'http://127.0.0.1:' + PORT + '/',
    '--allow-missing', 'darwin-aarch64,darwin-x86_64,linux-x86_64,linux-x86_64-deb',
    '--out', join(FEED, 'latest.json')
  ], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) fail('manifest assembly failed — the canary feed was NOT staged');
}

function serve() {
  if (!existsSync(join(FEED, 'latest.json'))) fail('no feed staged — run build-new first');
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0].replace(/^\/+/, '')) || 'latest.json';
    const file = join(FEED, name);
    if (!file.startsWith(FEED) || !existsSync(file)) {
      log('[canary-feed] 404 ' + req.method + ' ' + req.url);
      res.writeHead(404); res.end('not found'); return;
    }
    const body = readFileSync(file);
    log('[canary-feed] 200 ' + req.method + ' /' + name + ' (' + body.length + ' bytes)');
    res.writeHead(200, {
      'content-type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      'content-length': body.length
    });
    res.end(body);
  });
  server.listen(PORT, '127.0.0.1', () => {
    log('canary feed serving on http://127.0.0.1:' + PORT + '/latest.json — leave this running.');
    log('Now: install ' + OLD + '\\*.exe, open StarNet Canary, SYSTEM → UPDATE CENTER → CHECK NOW → INSTALL.');
    log('Every request the installed app makes is logged below — that log IS the canary evidence.');
  });
}

function status() {
  const v = conf().version;
  const oldExes = existsSync(OLD) ? readdirSync(OLD).filter(f => f.endsWith('.exe')) : [];
  const feedFiles = existsSync(FEED) ? readdirSync(FEED) : [];
  log('conf version      : ' + v + '  (old canary builds at this, new at ' + bumpPatch(v) + ')');
  log('old installer     : ' + (oldExes.length ? oldExes.join(', ') : 'NOT BUILT — run build-old'));
  log('feed              : ' + (feedFiles.length ? feedFiles.join(', ') : 'NOT STAGED — run build-new'));
  log('endpoint          : http://127.0.0.1:' + PORT + '/latest.json');
  log('next              : ' + (!oldExes.length ? 'build-old' : !feedFiles.includes('latest.json') ? 'build-new' : 'serve, then install the old exe and update through the UI'));
}

const CDP_PORT = +argVal('--cdp-port', '9333');
const INSTALL_DIR = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'StarNet Canary');
// NSIS keeps the crate's mainBinaryName — the productName only names the install dir/shortcuts.
const INSTALLED_EXE = join(INSTALL_DIR, 'skynet-desktop.exe');

function installedVersion() {
  if (!existsSync(INSTALLED_EXE)) return null;
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '(Get-Item ' + JSON.stringify(INSTALLED_EXE) + ').VersionInfo.ProductVersion'], { encoding: 'utf8' });
  return (r.stdout || '').trim() || null;
}

function launchWithCdp() {
  if (!existsSync(INSTALLED_EXE)) fail('installed exe not found at ' + INSTALLED_EXE);
  const child = spawn(INSTALLED_EXE, [], {
    detached: true,
    stdio: 'ignore',
    env: Object.assign({}, process.env, {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + CDP_PORT
    })
  });
  child.unref();
  log('launched ' + INSTALLED_EXE + ' with CDP on :' + CDP_PORT);
}

function installOld() {
  const exes = existsSync(OLD) ? readdirSync(OLD).filter(f => f.endsWith('-setup.exe')) : [];
  if (exes.length !== 1) fail('expected exactly one installer in ' + OLD + ' (run build-old first)');
  const installer = join(OLD, exes[0]);
  log('silent NSIS install: ' + installer + ' /S  (per-user, no admin prompt)…');
  const r = spawnSync(installer, ['/S'], { stdio: 'inherit' });
  if (r.status !== 0) fail('installer exited ' + r.status);
  const v = installedVersion();
  if (!v) fail('install finished but ' + INSTALLED_EXE + ' is missing');
  log('installed StarNet Canary v' + v + ' at ' + INSTALL_DIR);
  launchWithCdp();
  log('next: keep serve running, then `node scripts/update-canary.mjs drive`');
}

// CDP-drive the running canary through the real Update Center flow and print receipts.
async function drive() {
  const startVersion = installedVersion();
  log('installed exe version before update: ' + startVersion);
  log('attaching to CDP :' + CDP_PORT + ' …');
  let cdp = null;
  for (let i = 0; i < 20 && !cdp; i++) {
    try { cdp = await connectCDP(CDP_PORT); } catch (_) { await sleep(500); }
  }
  if (!cdp) fail('cannot attach to the canary app on :' + CDP_PORT + ' — launch it via install-old (or set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS yourself)');

  const origin = await evalJS(cdp, 'location.origin');
  const appVer = await evalJS(cdp, '(typeof Updates!=="undefined" && Updates.snapshot) ? Updates.snapshot().currentVersion : "no-updates-module"');
  log('attached: origin=' + JSON.stringify(origin) + ' app-reported version=' + JSON.stringify(appVer));

  log('driving Updates.check(true) …');
  await evalJS(cdp, 'Updates.check(true, "canary")');
  let snap = null;
  for (let i = 0; i < 60; i++) {
    snap = await evalJS(cdp, 'JSON.stringify(Updates.snapshot())');
    const s = JSON.parse(snap || '{}');
    if (s.phase === 'available' && s.update) { log('update visible: v' + s.update.version + ' (phase=' + s.phase + ')'); break; }
    if (s.phase === 'error') fail('update check errored: ' + s.error);
    await sleep(1000);
  }
  const seen = JSON.parse(snap || '{}');
  if (!(seen.phase === 'available' && seen.update)) fail('update never became available; last snapshot: ' + snap);

  log('driving Updates.install() — the app will exit, NSIS installs passively, then it relaunches …');
  // Fire-and-forget: the webview dies mid-install, so the eval may never return.
  evalJS(cdp, 'Updates.install()').catch(() => {});

  // A CLEAN update must reach ALL THREE of these — checking only the version resource is a
  // FALSE GREEN: NSIS overwrites skynet-desktop.exe (flipping the version) BEFORE it hits the
  // locked node.exe and hangs on an error dialog, so the version can advance while the install
  // is actually frozen. So we also require: the NSIS installer process EXITED, and a fresh app
  // process RELAUNCHED. A hung installer still running past the deadline = HUNG, not success.
  const deadline = Date.now() + 5 * 60 * 1000;
  let after = startVersion, versionFlipped = false, installerGone = false, relaunched = false;
  while (Date.now() < deadline) {
    await sleep(3000);
    const v = installedVersion();
    if (v && v !== startVersion) { after = v; versionFlipped = true; }
    installerGone = !installerRunning();
    relaunched = appRunning();
    if (versionFlipped && installerGone && relaunched) break;
  }
  if (!versionFlipped) fail('installed exe version never changed (still ' + startVersion + ') — update did not land within 5 min');
  if (!installerGone) {
    fail('UPDATE HUNG: version flipped to ' + after + ' but the NSIS installer is STILL RUNNING past the deadline.\n' +
      '  This is the sidecar-lock hang — the running node.exe sidecar blocks NSIS from overwriting node.exe.\n' +
      '  Diagnostic: ' + hangDiagnostic() + '\n' +
      '  The fix is on_before_exit killing the sidecar before the plugin exits (src-tauri/src/main.rs, starnet_update_check).');
  }
  if (!relaunched) log('NOTE: version flipped and installer exited, but no relaunched app seen yet (it may still be starting).');
  log('');
  log('================ CANARY RECEIPT ================');
  log(' installed exe version: ' + startVersion + '  →  ' + after + '   [version resource advanced]');
  log(' installer exited     : ' + (installerGone ? 'yes (no NSIS process left — no lock hang)' : 'NO'));
  log(' app relaunched       : ' + (relaunched ? 'yes (new version is running)' : 'not yet'));
  log(' endpoint used        : http://127.0.0.1:' + PORT + '/latest.json (see serve log for the GET hits)');
  log(' signature check      : performed by the installed app against the baked pubkey (a bad sig would have failed the install)');
  log('================================================');
  log('CLEAN UPDATE PROVEN end-to-end. Uninstall "StarNet Canary" from Windows when done.');
  process.exit(0);
}

// Is an NSIS canary installer/uninstaller process still alive? (the hang signature)
function installerRunning() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    "(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*Canary*installer*' -or $_.MainWindowTitle -like '*Canary*Setup*' } | Measure-Object).Count"],
    { encoding: 'utf8' });
  return (parseInt((r.stdout || '0').trim(), 10) || 0) > 0;
}
function appRunning() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    "(Get-Process skynet-desktop -ErrorAction SilentlyContinue | Where-Object Path -like '*Canary*' | Measure-Object).Count"],
    { encoding: 'utf8' });
  return (parseInt((r.stdout || '0').trim(), 10) || 0) > 0;
}
function hangDiagnostic() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    "$n=(Get-Process node -ErrorAction SilentlyContinue | Where-Object Path -like '*StarNet Canary*' | Measure-Object).Count; \"orphan sidecar node.exe still alive: $n\""],
    { encoding: 'utf8' });
  return (r.stdout || '').trim() || 'unavailable';
}

if (cmd === 'build-old') {
  const v = conf().version;
  buildCanary(v, OLD);
  log('OLD canary staged at v' + v + '. Next: build-new.');
} else if (cmd === 'build-new') {
  const v = argVal('--version', bumpPatch(conf().version));
  mkdirSync(FEED, { recursive: true });
  const exe = buildCanary(v, FEED);
  assembleFeed(v);
  log('NEW canary v' + v + ' staged + signed feed assembled (' + exe + '). Next: serve.');
} else if (cmd === 'serve') {
  serve();
} else if (cmd === 'install-old') {
  installOld();
} else if (cmd === 'drive') {
  drive().catch(e => fail(e && e.message || String(e)));
} else if (cmd === 'status') {
  status();
} else {
  fail('unknown command "' + cmd + '" (build-old | build-new | serve | install-old | drive | status)');
}
