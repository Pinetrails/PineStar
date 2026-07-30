#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const script = path.join(ROOT, 'scripts', 't5-public-distribution.mjs');
const lint = path.join(ROOT, 'scripts', 'lint-evidence-secrets.mjs');
const TAURI_CONF = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const APP_VERSION = TAURI_CONF.version;
// The updater endpoint is the single source of truth; the T5 hosting proof compares the
// evidence's latestJsonUrl against it. Derive the installer asset URL from the same channel
// so this fixture tracks the configured endpoint instead of hardcoding a dead host.
const LATEST_JSON_URL = TAURI_CONF.plugins.updater.endpoints[0];
const INSTALLER_URL = LATEST_JSON_URL.replace(/\/releases\/latest\/download\/latest\.json$/, '/releases/download/v' + APP_VERSION + '/StarNet_' + APP_VERSION + '_x64-setup.exe');

function cleanEnv(extra) {
  const env = Object.assign({}, process.env);
  delete env.STARNET_T5_DISTRIBUTION_EVIDENCE;
  delete env.STARNET_T5_MANIFEST;
  delete env.STARNET_T5_INSTALLER_EXE;
  Object.assign(env, extra || {});
  return env;
}
function run(args, env) {
  return spawnSync(process.execPath, [script].concat(args || []), {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanEnv(env)
  });
}
function writeJson(file, value, bom) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (bom ? '\ufeff' : '') + JSON.stringify(value, null, 2));
}
function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function status(verdict, key, ready, extra) {
  return Object.assign({ verdict, [key]: ready }, extra || {});
}
function proof(hash, bytes, version, overrides) {
  const doc = {
    schema: 'starnet.t5-public-distribution-proof.v1',
    generatedAt: new Date().toISOString(),
    release: {
      version,
      channel: 'stable',
      installerSha256: hash,
      installerBytes: bytes
    },
    hosting: {
      latestJsonUrl: LATEST_JSON_URL,
      installerUrl: INSTALLER_URL,
      latestStatus: 200,
      installerStatus: 200,
      manifestInstallerUrlMatches: true,
      installerHashMatches: true,
      installerBytesMatch: true
    },
    channels: {
      publicChannel: 'stable',
      singlePublicChannel: true,
      dailyDriverPinnedStable: true,
      devTreeSeparate: true
    },
    notes: []
  };
  if (overrides) overrides(doc);
  return doc;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't5-public-distribution-'));
try {
  const installer = path.join(tmp, 'StarNet_' + APP_VERSION + '_x64-setup.exe');
  fs.writeFileSync(installer, 'fake installer');
  fs.writeFileSync(installer + '.sig', 'fake-updater-signature');
  const hash = hashFile(installer);
  const bytes = fs.statSync(installer).size;
  const manifest = path.join(tmp, 'latest.json');
  writeJson(manifest, {
    version: APP_VERSION,
    notes: 'test',
    pub_date: '2026-06-28T00:00:00.000Z',
    platforms: {
      'windows-x86_64': {
        signature: 'fake-updater-signature',
        url: INSTALLER_URL
      }
    }
  }, true);

  const t0 = path.join(tmp, 't0.json');
  const t1 = path.join(tmp, 't1.json');
  const t2 = path.join(tmp, 't2.json');
  const t3 = path.join(tmp, 't3.json');
  const t4 = path.join(tmp, 't4.json');
  writeJson(t0, status('green', 'cleanInstallProofReady', true));
  writeJson(t1, status('green', 'publicReleaseReady', true));
  writeJson(t2, status('green', 'stateSafetyReady', true));
  writeJson(t3, status('green', 'releaseSmokeReady', true));
  writeJson(t4, status('green', 'updateDeliveryReady', true));
  const baseEnv = {
    STARNET_T5_INSTALLER_EXE: installer,
    STARNET_T5_MANIFEST: manifest,
    STARNET_T5_T0_STATUS: t0,
    STARNET_T5_T1_STATUS: t1,
    STARNET_T5_T2_STATUS: t2,
    STARNET_T5_T3_STATUS: t3,
    STARNET_T5_T4_STATUS: t4
  };

  {
    fs.utimesSync(installer + '.sig', new Date('2026-06-28T00:00:00.000Z'), new Date('2026-06-28T00:00:00.000Z'));
    fs.utimesSync(installer, new Date('2026-06-29T00:00:00.000Z'), new Date('2026-06-29T00:00:00.000Z'));
    const goodProof = path.join(tmp, 'good-proof-for-stale-sig.json');
    writeJson(goodProof, proof(hash, bytes, APP_VERSION));
    const out = path.join(tmp, 'stale-sig-out');
    const res = run(['--distribution-evidence', goodProof], Object.assign({}, baseEnv, {
      STARNET_T5_PUBLIC_DISTRIBUTION_DIR: out,
      STARNET_T5_PUBLIC_DISTRIBUTION_LATEST_DIR: path.join(tmp, 'stale-sig-latest')
    }));
    assert.equal(res.status, 2, res.stderr || res.stdout);
    const got = JSON.parse(fs.readFileSync(path.join(out, 't5-public-distribution-status.json'), 'utf8'));
    const artifacts = got.results.find(r => r.id === 't5.2-signed-updater-artifacts');
    assert.equal(got.verdict, 'blocked');
    assert.equal(artifacts.status, 'blocked');
    assert.match(artifacts.reason, /older than the current installer/);
    assert.equal(got.nextAction.id, 't5.2-signed-updater-artifacts');
    fs.utimesSync(installer + '.sig', new Date('2026-06-29T00:01:00.000Z'), new Date('2026-06-29T00:01:00.000Z'));
  }

  {
    const out = path.join(tmp, 'blocked-proof-out');
    const res = run(['--loop=2'], Object.assign({}, baseEnv, {
      STARNET_T5_PUBLIC_DISTRIBUTION_DIR: out,
      STARNET_T5_PUBLIC_DISTRIBUTION_LATEST_DIR: path.join(tmp, 'blocked-proof-latest')
    }));
    assert.equal(res.status, 2, res.stderr || res.stdout);
    const got = JSON.parse(fs.readFileSync(path.join(out, 't5-public-distribution-status.json'), 'utf8'));
    assert.equal(got.verdict, 'blocked');
    assert.equal(got.publicDistributionReady, false);
    assert.equal(got.nextAction.id, 't5.3-public-hosting-proof');
  }

  {
    writeJson(t1, status('green', 'publicReleaseReady', false));
    const goodProof = path.join(tmp, 'good-proof-for-blocked-t1.json');
    writeJson(goodProof, proof(hash, bytes, APP_VERSION));
    const out = path.join(tmp, 'blocked-t1-out');
    const res = run(['--distribution-evidence', goodProof], Object.assign({}, baseEnv, {
      STARNET_T5_PUBLIC_DISTRIBUTION_DIR: out,
      STARNET_T5_PUBLIC_DISTRIBUTION_LATEST_DIR: path.join(tmp, 'blocked-t1-latest')
    }));
    assert.equal(res.status, 2, res.stderr || res.stdout);
    const got = JSON.parse(fs.readFileSync(path.join(out, 't5-public-distribution-status.json'), 'utf8'));
    assert.equal(got.verdict, 'blocked');
    assert.equal(got.nextAction.id, 't5.1-prerequisite-gates');
    writeJson(t1, status('green', 'publicReleaseReady', true));
  }

  {
    const badProof = path.join(tmp, 'bad-proof.json');
    writeJson(badProof, proof(hash, bytes, APP_VERSION, doc => {
      doc.hosting.latestStatus = 404;
    }));
    const out = path.join(tmp, 'red-out');
    const res = run(['--distribution-evidence', badProof], Object.assign({}, baseEnv, {
      STARNET_T5_PUBLIC_DISTRIBUTION_DIR: out,
      STARNET_T5_PUBLIC_DISTRIBUTION_LATEST_DIR: path.join(tmp, 'red-latest')
    }));
    assert.equal(res.status, 1, res.stderr || res.stdout);
    const got = JSON.parse(fs.readFileSync(path.join(out, 't5-public-distribution-status.json'), 'utf8'));
    assert.equal(got.verdict, 'red');
    assert.equal(got.nextAction.id, 't5.3-public-hosting-proof');
  }

  {
    const goodProof = path.join(tmp, 'good-proof.json');
    writeJson(goodProof, proof(hash, bytes, APP_VERSION), true);
    const out = path.join(tmp, 'green-out');
    const latest = path.join(tmp, 'green-latest');
    const res = run(['--loop=2', '--distribution-evidence=' + goodProof], Object.assign({}, baseEnv, {
      STARNET_T5_PUBLIC_DISTRIBUTION_DIR: out,
      STARNET_T5_PUBLIC_DISTRIBUTION_LATEST_DIR: latest
    }));
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const got = JSON.parse(fs.readFileSync(path.join(out, 't5-public-distribution-status.json'), 'utf8'));
    assert.equal(got.schema, 'starnet.t5-public-distribution-status.v1');
    assert.equal(got.verdict, 'green');
    assert.equal(got.publicDistributionReady, true);
    assert.equal(got.nextAction, null);
    assert.ok(got.results.every(r => r.status === 'pass'), 'all T5 steps should pass');
    assert.ok(fs.existsSync(path.join(latest, 't5-public-distribution-status.json')), 'latest status should be copied');
    const lintRes = spawnSync(process.execPath, [lint, latest], { cwd: ROOT, encoding: 'utf8', env: cleanEnv() });
    assert.equal(lintRes.status, 0, lintRes.stderr || lintRes.stdout);
  }
  /* ---- T5.1 MUST BIND ITS PREREQ VERDICTS TO THIS INSTALLER ---------------------------------------
     checkPrereqs read only verdict/ready booleans, and copyLatest() unconditionally re-stamps the `-latest`
     dirs on every run of every rung, so those verdicts persist across rebuilds indefinitely. Build installer
     A, take t0-t4 green, rebuild, then run only t5: T5.1 passed on A's leftover evidence while T5.2 hashed the
     NEW installer — and the lane stamped publicDistributionReady=true for a binary that was never
     clean-installed, never state-safety tested and never update-delivery tested. On the LAST gate before
     publishing to real users, that is the false green this lane's governing law calls the worst outcome in
     the repo. t3.2 already binds T0's recorded hash; t5 skipped it for all five. */
  {
    // the prereq statuses now record which installer they were about — here, a DIFFERENT one
    const staleHash = 'a'.repeat(64);
    const artifactsOf = (h, b) => ({ results: [{ artifacts: { installer: { sha256: h, bytes: b == null ? 4242 : b } } }] });
    const s0 = path.join(tmp, 'stale-t0.json'), s1 = path.join(tmp, 'stale-t1.json');
    const s2 = path.join(tmp, 'stale-t2.json'), s3 = path.join(tmp, 'stale-t3.json'), s4 = path.join(tmp, 'stale-t4.json');
    writeJson(s0, Object.assign(status('green', 'cleanInstallProofReady', true), artifactsOf(staleHash)));
    writeJson(s1, Object.assign(status('green', 'publicReleaseReady', true), artifactsOf(staleHash)));
    writeJson(s2, Object.assign(status('green', 'stateSafetyReady', true), artifactsOf(staleHash)));
    writeJson(s3, Object.assign(status('green', 'releaseSmokeReady', true), artifactsOf(staleHash)));
    writeJson(s4, Object.assign(status('green', 'updateDeliveryReady', true), artifactsOf(staleHash)));
    const out = path.join(tmp, 'stale-prereq-out');
    const res = run(['--distribution-evidence', path.join(tmp, 'good-proof-for-stale-sig.json')], Object.assign({}, baseEnv, {
      STARNET_T5_T0_STATUS: s0, STARNET_T5_T1_STATUS: s1, STARNET_T5_T2_STATUS: s2,
      STARNET_T5_T3_STATUS: s3, STARNET_T5_T4_STATUS: s4,
      STARNET_T5_PUBLIC_DISTRIBUTION_DIR: out,
      STARNET_T5_PUBLIC_DISTRIBUTION_LATEST_DIR: path.join(tmp, 'stale-prereq-latest')
    }));
    const got = JSON.parse(fs.readFileSync(path.join(out, 't5-public-distribution-status.json'), 'utf8'));
    const pre = got.results.find(r => r.id === 't5.1-prerequisite-gates');
    assert.equal(pre.status, 'blocked', 'green prereqs for a DIFFERENT installer must BLOCK T5.1');
    assert.match(pre.reason, /DIFFERENT installer/, 'and say so plainly: ' + pre.reason);
    assert.equal(got.publicDistributionReady, true !== true, 'the lane is NOT public-distribution ready');
    assert.equal(got.verdict, 'blocked');
    // the status document now RECORDS which binary each verdict was about, so it can be audited
    assert.equal(pre.gates.t0.installer.sha256, staleHash, 'T5.1 records the installer each prereq verdict covered');
    assert.ok(pre.installer && pre.installer.sha256, 'and the installer it was compared against');

    // ...and with the prereqs recorded against THIS installer it passes again
    const cur = hashFile(installer);
    const g0 = path.join(tmp, 'good-t0.json');
    writeJson(g0, Object.assign(status('green', 'cleanInstallProofReady', true), artifactsOf(cur, fs.statSync(installer).size)));
    const out2 = path.join(tmp, 'fresh-prereq-out');
    run(['--distribution-evidence', path.join(tmp, 'good-proof-for-stale-sig.json')], Object.assign({}, baseEnv, {
      STARNET_T5_T0_STATUS: g0,
      STARNET_T5_PUBLIC_DISTRIBUTION_DIR: out2,
      STARNET_T5_PUBLIC_DISTRIBUTION_LATEST_DIR: path.join(tmp, 'fresh-prereq-latest')
    }));
    const got2 = JSON.parse(fs.readFileSync(path.join(out2, 't5-public-distribution-status.json'), 'utf8'));
    const pre2 = got2.results.find(r => r.id === 't5.1-prerequisite-gates');
    assert.equal(pre2.status, 'pass', 'a prereq recorded for THIS installer passes: ' + pre2.reason);
    // a rung that records no installer at all (older status shape) is not punished for it
    assert.equal(pre2.gates.t2.installer, null, 'a status with no recorded installer is reported as unbound, not stale');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('t5-public-distribution.test: OK (29 assertions)');
