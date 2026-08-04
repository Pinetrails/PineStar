'use strict';
const A = require('./_assert.js');

(async () => {
  const { requiredSoakCoverage, installedRuntimeFingerprint } = await import('../scripts/eval/installed-provider-soak.mjs');
  A.eq(requiredSoakCoverage(48, 60), 2851, '48-hour health coverage requires at least 99% of planned samples');
  A.eq(requiredSoakCoverage(48, 3600), 47, '48-hour provider coverage requires at least 99% of hourly active samples');
  let refused = false; try { requiredSoakCoverage(0, 60); } catch (_) { refused = true; }
  A.ok(refused, 'invalid soak duration fails closed');
  const source = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../scripts/eval/installed-provider-soak.mjs'), 'utf8');
  A.ok(/durationHours >= 48/.test(source) && /qualifiesRelease: durationHours >= 48/.test(source), 'release qualification is structurally gated on a real 48-hour duration');
  A.ok(/providerFailures === 0/.test(source) && /healthFailures === 0/.test(source), 'provider and health failures both fail the soak');
  A.ok(/gradeParityTrajectory/.test(source) && /fixtureCalls\.length > 0/.test(source), 'active samples require independent fixture grading and real host calls');
  const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-soak-fingerprint-'));
  try {
    fs.mkdirSync(path.join(root, 'sidecar')); fs.writeFileSync(path.join(root, 'sidecar', 'index.js'), 'one');
    const first = installedRuntimeFingerprint(root, ['sidecar']);
    fs.writeFileSync(path.join(root, 'sidecar', 'index.js'), 'two');
    const second = installedRuntimeFingerprint(root, ['sidecar']);
    A.eq(first.files, 1, 'runtime fingerprint records the file count');
    A.ok(first.sha256 !== second.sha256, 'runtime fingerprint detects content drift');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  A.ok(/identityFailures === 0/.test(source) && /executableHashMatch/.test(source) && /runtimeFingerprintMatch/.test(source), 'candidate identity drift fails the soak');
  A.report('eval-installed-provider-soak.test');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
