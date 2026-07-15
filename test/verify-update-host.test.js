#!/usr/bin/env node
'use strict';

// Fixture-driven test for scripts/verify-update-host.mjs --manifest mode.
// No network: --manifest without --check-urls does schema/platform-set/sig-shape/URL-shape
// validation only. Fixtures are written to a temp dir and run through child_process.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const script = path.join(ROOT, 'scripts', 'verify-update-host.mjs');

const REPO = 'nonfungiblefunyuns-ship-it/starnet-releases';
// Far-future fixture version: --manifest mode compares manifest.version >= the SHIPPED
// tauri.conf.json version, so a fixture pinned near the current release becomes a gate
// time-bomb on the next bump (broke the v0.2.1 train gate on 2026-07-06).
const VERSION = '99.0.0';
const GOOD_SIG = 'a'.repeat(80); // >40 chars trimmed = valid updater-signature shape

function url(plat, asset, version) {
  return 'https://github.com/' + REPO + '/releases/download/v' + (version || VERSION) + '/' + asset;
}

function fullPlatform(version) {
  return {
    version: version || VERSION,
    notes: 'test release',
    pub_date: '2026-07-06T00:00:00.000Z',
    platforms: {
      'windows-x86_64': { signature: GOOD_SIG, url: url('win', 'StarNet_' + (version || VERSION) + '_x64-setup.exe', version) },
      'darwin-aarch64': { signature: GOOD_SIG, url: url('mac', 'StarNet_aarch64.app.tar.gz', version) },
      'darwin-x86_64': { signature: GOOD_SIG, url: url('mac', 'StarNet_x64.app.tar.gz', version) },
      'linux-x86_64': { signature: GOOD_SIG, url: url('lin', 'StarNet_amd64.AppImage', version) },
      // Required alongside the AppImage: .deb installs resolve this key first and hard-fail
      // on the AppImage fallback, so a manifest without it strands every .deb user.
      'linux-x86_64-deb': { signature: GOOD_SIG, url: url('lin', 'StarNet_amd64.deb', version) }
    }
  };
}

function run(args) {
  return spawnSync(process.execPath, [script].concat(args || []), {
    cwd: ROOT, encoding: 'utf8', env: process.env
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-update-host-'));
function writeManifest(name, obj) {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  return f;
}

try {
  // 1. Good 4-platform manifest → PASS (exit 0).
  {
    const f = writeManifest('good.json', fullPlatform());
    const res = run(['--manifest', f]);
    assert.equal(res.status, 0, 'good full-platform manifest should pass\n' + res.stdout + res.stderr);
    assert.match(res.stdout, /ALL CHECKS PASSED/);
    assert.match(res.stdout, /required platform present: darwin-aarch64/);
  }

  // 2. Missing a required platform → FAIL (exit 1).
  {
    const m = fullPlatform();
    delete m.platforms['linux-x86_64'];
    const f = writeManifest('missing.json', m);
    const res = run(['--manifest', f]);
    assert.equal(res.status, 1, 'missing platform should fail\n' + res.stdout);
    assert.match(res.stdout, /FAIL required platform present: linux-x86_64/);
  }

  // 2b. Missing platform but opted-down via --require-platforms → PASS.
  {
    const m = fullPlatform();
    delete m.platforms['linux-x86_64'];
    delete m.platforms['darwin-aarch64'];
    delete m.platforms['darwin-x86_64'];
    const f = writeManifest('winonly.json', m);
    const res = run(['--manifest', f, '--require-platforms', 'windows-x86_64']);
    assert.equal(res.status, 0, 'windows-only with opt-down should pass\n' + res.stdout);
    assert.match(res.stdout, /ALL CHECKS PASSED/);
  }

  // 3. Bad signature (empty / too short) → FAIL.
  {
    const m = fullPlatform();
    m.platforms['darwin-x86_64'].signature = 'short';
    const f = writeManifest('badsig.json', m);
    const res = run(['--manifest', f]);
    assert.equal(res.status, 1, 'bad sig should fail\n' + res.stdout);
    assert.match(res.stdout, /FAIL platform\["darwin-x86_64"\]\.signature/);
  }

  // 4. Wrong URL version path (url points at a different release tag) → FAIL.
  {
    const m = fullPlatform();
    // manifest says 99.0.0 but this URL is pinned to v0.1.9
    m.platforms['windows-x86_64'].url = url('win', 'StarNet_0.1.9_x64-setup.exe', '0.1.9');
    const f = writeManifest('wrongurl.json', m);
    const res = run(['--manifest', f]);
    assert.equal(res.status, 1, 'wrong url version path should fail\n' + res.stdout);
    assert.match(res.stdout, /FAIL platform\["windows-x86_64"\]\.url pinned to \/download\/v99\.0\.0\//);
  }

  // 5. --expect-version mismatch → FAIL.
  {
    const f = writeManifest('expect.json', fullPlatform());
    const res = run(['--manifest', f, '--expect-version', '9.9.9']);
    assert.equal(res.status, 1, 'expect-version mismatch should fail\n' + res.stdout);
    assert.match(res.stdout, /FAIL manifest\.version matches --expect-version/);
  }

  // 6. Malformed JSON → FAIL cleanly.
  {
    const f = path.join(tmp, 'broken.json');
    fs.writeFileSync(f, '{ not valid json');
    const res = run(['--manifest', f]);
    assert.equal(res.status, 1, 'malformed json should fail\n' + res.stdout);
    assert.match(res.stdout, /FAIL manifest file is readable JSON/);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('verify-update-host.test: OK (13 assertions)');
