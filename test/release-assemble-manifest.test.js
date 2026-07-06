#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const script = path.join(ROOT, 'scripts', 'release-assemble-manifest.mjs');

let assertions = 0;
function ok(cond, msg) { assert.ok(cond, msg); assertions++; }
function eq(a, b, msg) { assert.equal(a, b, msg); assertions++; }

function run(args) {
  return spawnSync(process.execPath, [script].concat(args || []), { cwd: ROOT, encoding: 'utf8' });
}
function writeArtifact(dir, rel, sig) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'fake artifact bytes for ' + rel);
  if (sig !== null && sig !== undefined) fs.writeFileSync(full + '.sig', sig);
  return full;
}
// Build a full four-platform dist tree; caller may then mutate it.
function fullDist(base) {
  writeArtifact(base, 'StarNet_0.2.0_x64-setup.exe', 'SIG-WIN');
  writeArtifact(base, path.join('macos', 'aarch64', 'StarNet.app.tar.gz'), 'SIG-MAC-ARM');
  writeArtifact(base, path.join('macos', 'x86_64', 'StarNet.app.tar.gz'), 'SIG-MAC-X64');
  writeArtifact(base, 'StarNet_0.2.0_amd64.AppImage', 'SIG-LINUX');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-assemble-'));
try {
  const COMMON = ['--version', '0.2.0', '--repo', 'nonfungiblefunyuns-ship-it/starnet-releases', '--tag', 'v0.2.0'];

  // 1. Happy 4-platform path.
  {
    const dist = path.join(tmp, 'happy');
    fs.mkdirSync(dist);
    fullDist(dist);
    const out = path.join(tmp, 'happy-latest.json');
    const res = run(['--dist', dist, ...COMMON, '--out', out]);
    eq(res.status, 0, res.stderr || res.stdout);
    const m = JSON.parse(fs.readFileSync(out, 'utf8'));
    eq(m.version, '0.2.0', 'version');
    ok(typeof m.pub_date === 'string' && m.pub_date.length > 0, 'pub_date present');
    eq(Object.keys(m.platforms).sort().join(','),
      'darwin-aarch64,darwin-x86_64,linux-x86_64,windows-x86_64', 'all four platforms');
    eq(m.platforms['windows-x86_64'].signature, 'SIG-WIN', 'win sig');
    eq(m.platforms['darwin-aarch64'].signature, 'SIG-MAC-ARM', 'mac-arm sig');
    eq(m.platforms['darwin-x86_64'].signature, 'SIG-MAC-X64', 'mac-x64 sig');
    eq(m.platforms['linux-x86_64'].signature, 'SIG-LINUX', 'linux sig');
    eq(m.platforms['windows-x86_64'].url,
      'https://github.com/nonfungiblefunyuns-ship-it/starnet-releases/releases/download/v0.2.0/StarNet_0.2.0_x64-setup.exe',
      'win url points at versioned tag asset');
    ok(m.platforms['darwin-aarch64'].url.endsWith('/v0.2.0/StarNet.app.tar.gz'), 'mac url basename');
    ok(m.platforms['windows-x86_64'].url.startsWith('https://'), 'https url');
  }

  // 2. Missing platform → hard fail.
  {
    const dist = path.join(tmp, 'missing');
    fs.mkdirSync(dist);
    fullDist(dist);
    fs.rmSync(path.join(dist, 'StarNet_0.2.0_amd64.AppImage'));
    fs.rmSync(path.join(dist, 'StarNet_0.2.0_amd64.AppImage.sig'));
    const res = run(['--dist', dist, ...COMMON, '--out', path.join(tmp, 'missing-latest.json')]);
    eq(res.status, 1, 'missing platform should fail');
    ok(/missing artifacts for platform/i.test(res.stderr), 'missing message');
    ok(/linux-x86_64/.test(res.stderr), 'names missing platform');
  }

  // 3. allow-missing → pass with a 3-platform manifest.
  {
    const dist = path.join(tmp, 'allow');
    fs.mkdirSync(dist);
    fullDist(dist);
    fs.rmSync(path.join(dist, 'StarNet_0.2.0_amd64.AppImage'));
    fs.rmSync(path.join(dist, 'StarNet_0.2.0_amd64.AppImage.sig'));
    const out = path.join(tmp, 'allow-latest.json');
    const res = run(['--dist', dist, ...COMMON, '--out', out, '--allow-missing', 'linux-x86_64']);
    eq(res.status, 0, res.stderr || res.stdout);
    const m = JSON.parse(fs.readFileSync(out, 'utf8'));
    ok(!m.platforms['linux-x86_64'], 'waived platform absent from manifest');
    eq(Object.keys(m.platforms).length, 3, 'three platforms emitted');
  }

  // 4. Missing sig → hard fail.
  {
    const dist = path.join(tmp, 'nosig');
    fs.mkdirSync(dist);
    fullDist(dist);
    fs.rmSync(path.join(dist, 'StarNet_0.2.0_x64-setup.exe.sig'));
    const res = run(['--dist', dist, ...COMMON, '--out', path.join(tmp, 'nosig-latest.json')]);
    eq(res.status, 1, 'artifact without sig should fail');
    ok(/without signature/i.test(res.stderr), 'no-sig message');
  }

  // 5. Duplicate platform match → hard fail.
  {
    const dist = path.join(tmp, 'dup');
    fs.mkdirSync(dist);
    fullDist(dist);
    // second AppImage in a subdir → two linux-x86_64 hits.
    writeArtifact(dist, path.join('extra', 'StarNet_0.2.0_amd64.AppImage'), 'SIG-LINUX-2');
    const res = run(['--dist', dist, ...COMMON, '--out', path.join(tmp, 'dup-latest.json')]);
    eq(res.status, 1, 'duplicate match should fail');
    ok(/duplicate artifact for platform/i.test(res.stderr), 'duplicate message');
  }

  // 6. Empty sig → hard fail.
  {
    const dist = path.join(tmp, 'emptysig');
    fs.mkdirSync(dist);
    fullDist(dist);
    fs.writeFileSync(path.join(dist, 'StarNet_0.2.0_x64-setup.exe.sig'), '   \n');
    const res = run(['--dist', dist, ...COMMON, '--out', path.join(tmp, 'emptysig-latest.json')]);
    eq(res.status, 1, 'empty sig should fail');
    ok(/signature file is empty/i.test(res.stderr), 'empty-sig message');
  }

  // 7. Non-SemVer version → hard fail.
  {
    const dist = path.join(tmp, 'semver');
    fs.mkdirSync(dist);
    fullDist(dist);
    const res = run(['--dist', dist, '--version', '0.2', '--repo', 'a/b', '--tag', 'v0.2',
      '--out', path.join(tmp, 'semver-latest.json')]);
    eq(res.status, 1, 'non-semver should fail');
    ok(/SemVer/i.test(res.stderr), 'semver message');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('release-assemble-manifest.test: OK (' + assertions + ' assertions)');
