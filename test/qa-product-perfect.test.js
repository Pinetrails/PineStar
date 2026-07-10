/* Product-perfect controller: locked campaign shape, signed/fresh evidence receipts, exact
   candidate binding, authority composition, operational evidence dirt, and terminal verdict. */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const {
  definitionHash, validateManifest, sealReceipt, receiptValidity, deriveStatus,
  candidateFromGitStatus, loadReceiptKey
} = require('../scripts/qa/product-perfect.mjs');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'qa', 'product-perfect', 'waves.json'), 'utf8'));
const candidate = { sha: 'a'.repeat(40), clean: true, dirtyPaths: [], operationalDirtyPaths: [] };
const mHash = definitionHash(manifest);
const key = Buffer.alloc(32, 7);
const NOW = Date.parse('2026-07-10T00:02:00.000Z');
const evidence = new Map();
const authorities = {
  ready: { ok: true, status: 'PASS', reasons: [] },
  ledger: { ok: true, status: 'PASS', reasons: [] },
  atlas: { ok: true, status: 'PASS', reasons: [] }
};

function descriptor(wave, stream, text) {
  const content = Buffer.from(text);
  const entry = {
    path: ['receipts', candidate.sha, wave.id + '.' + stream + '.log'].join('/'),
    bytes: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex')
  };
  evidence.set(entry.path, content);
  return entry;
}

function receipt(wave, overrides) {
  const base = {
    schemaVersion: 1,
    waveId: wave.id,
    waveName: wave.name,
    candidateSha: candidate.sha,
    manifestHash: mHash,
    waveDefinitionHash: definitionHash(wave),
    result: 'PASS',
    exitCode: 0,
    signal: null,
    startedAt: '2026-07-10T00:00:00.000Z',
    finishedAt: '2026-07-10T00:01:00.000Z',
    verifier: wave.verifier.command,
    verifierOutput: {
      stdout: descriptor(wave, 'stdout', wave.id + ' stdout\n'),
      stderr: descriptor(wave, 'stderr', '')
    },
    blockReason: ''
  };
  return sealReceipt(Object.assign(base, overrides || {}), key);
}

const validityContext = (wave, extra) => Object.assign({
  wave, candidate, manifestHash: mHash, nowMs: NOW, key,
  readEvidence: entry => {
    if (!evidence.has(entry.path)) throw new Error('missing');
    return evidence.get(entry.path);
  }
}, extra || {});
const statusContext = { nowMs: NOW, key, readEvidence: validityContext(manifest.waves[0]).readEvidence };

{
  A.eq(validateManifest(manifest).ok, true, 'tracked serialized manifest passes');
  const short = JSON.parse(JSON.stringify(manifest));
  short.waves.pop();
  A.eq(validateManifest(short).ok, false, 'a shortened campaign is rejected');
  const reordered = JSON.parse(JSON.stringify(manifest));
  [reordered.waves[0], reordered.waves[1]] = [reordered.waves[1], reordered.waves[0]];
  A.eq(validateManifest(reordered).ok, false, 'a reordered campaign is rejected');
  const policy = JSON.parse(JSON.stringify(manifest));
  policy.policy.publishAuthorized = true;
  A.eq(validateManifest(policy).ok, false, 'a publishing-authorized policy is rejected');
  const command = JSON.parse(JSON.stringify(manifest));
  command.waves[0].verifier.command = ['node', '-e', 'process.exit(0)'];
  A.eq(validateManifest(command).ok, false, 'an arbitrary verifier command is rejected');
  const staleWindow = JSON.parse(JSON.stringify(manifest));
  staleWindow.waves[0].maxReceiptAgeMs *= 100;
  A.eq(validateManifest(staleWindow).ok, false, 'a weakened receipt freshness window is rejected');
}

{
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'product-perfect-key-'));
  try {
    A.eq(loadReceiptKey(runtime, { create: false }), null, 'status-style key read does not create authority state');
    A.eq(fs.existsSync(path.join(runtime, 'receipt-hmac.key')), false, 'non-creating key read leaves disk untouched');
    A.eq(loadReceiptKey(runtime, { create: true }).length, 32, 'run-style key creation issues a 32-byte machine-local key');
  } finally { fs.rmSync(runtime, { recursive: true, force: true }); }
}

{
  const empty = deriveStatus(manifest, candidate, {}, authorities, statusContext);
  A.eq(empty.productPerfect, false, 'no receipts never means perfect');
  A.eq(empty.currentWave, 'W0', 'first missing wave is active');
  A.eq(empty.waves[1].status, 'pending', 'later wave waits on dependency');

  const w0 = receipt(manifest.waves[0]);
  const afterW0 = deriveStatus(manifest, candidate, { W0: w0 }, authorities, statusContext);
  A.eq(afterW0.currentWave, 'W1', 'controller advances only after W0 exact pass');
  A.eq(afterW0.waves[0].status, 'pass', 'signed exact W0 receipt is accepted');

  const receipts = Object.fromEntries(manifest.waves.map(wave => [wave.id, receipt(wave)]));
  const all = deriveStatus(manifest, candidate, receipts, authorities, statusContext);
  A.eq(all.productPerfect, true, 'all signed exact receipts plus authorities reach terminal state');
  A.eq(all.verdict, 'PRODUCT PERFECT', 'terminal verdict is exact');
  const noAtlas = deriveStatus(manifest, candidate, receipts, Object.assign({}, authorities, { atlas: { ok: false, status: 'FAIL', reasons: ['not complete'] } }), statusContext);
  A.eq(noAtlas.productPerfect, false, 'receipts cannot bypass a terminal authority');
}

{
  const wave = manifest.waves[0];
  const good = receipt(wave);
  A.eq(receiptValidity(good, validityContext(wave)).ok, true, 'fresh signed receipt with intact evidence passes');
  A.eq(receiptValidity(Object.assign({}, good, { candidateSha: 'b'.repeat(40) }), validityContext(wave)).ok, false, 'receipt from another commit is stale');
  A.eq(receiptValidity(Object.assign({}, good, { waveDefinitionHash: '0'.repeat(64) }), validityContext(wave)).ok, false, 'changed wave definition re-queues proof');
  const unsigned = Object.assign({}, good); delete unsigned.attestation;
  A.eq(receiptValidity(unsigned, validityContext(wave)).ok, false, 'unsigned hand-written receipt is rejected');
  const ancient = receipt(wave, { startedAt: '2026-07-01T00:00:00.000Z', finishedAt: '2026-07-01T00:01:00.000Z' });
  A.eq(receiptValidity(ancient, validityContext(wave)).ok, false, 'ancient receipt expires');
  const future = receipt(wave, { startedAt: '2027-07-10T00:00:00.000Z', finishedAt: '2027-07-10T00:01:00.000Z' });
  A.eq(receiptValidity(future, validityContext(wave)).ok, false, 'future receipt is rejected');
  const reversed = receipt(wave, { startedAt: '2026-07-10T00:01:00.000Z', finishedAt: '2026-07-10T00:00:00.000Z' });
  A.eq(receiptValidity(reversed, validityContext(wave)).ok, false, 'reversed timestamps are rejected');
  const arbitrary = receipt(wave, { verifier: ['node', '-e', 'process.exit(0)'] });
  A.eq(receiptValidity(arbitrary, validityContext(wave)).ok, false, 'signed receipt still must use exact verifier argv');
  const missingEvidence = receipt(wave);
  evidence.delete(missingEvidence.verifierOutput.stdout.path);
  A.eq(receiptValidity(missingEvidence, validityContext(wave)).ok, false, 'missing verifier evidence is rejected');
  evidence.set(missingEvidence.verifierOutput.stdout.path, Buffer.from('tampered'));
  A.eq(receiptValidity(missingEvidence, validityContext(wave)).ok, false, 'tampered verifier evidence is rejected');
}

{
  const onlyStatus = candidateFromGitStatus(candidate.sha, ' M qa/STATUS.md');
  A.eq(onlyStatus.clean, true, 'operational qa/STATUS dirt does not alter shipped source');
  A.eq(onlyStatus.operationalDirtyPaths.length, 1, 'operational dirt remains visible');
  const codeDirt = candidateFromGitStatus(candidate.sha, ' M qa/STATUS.md\n M sidecar/index.js');
  A.eq(codeDirt.clean, false, 'any shipped code dirt blocks the candidate');
  const manifestDirt = candidateFromGitStatus(candidate.sha, ' M qa/product-perfect/waves.json');
  A.eq(manifestDirt.clean, false, 'manifest dirt blocks the candidate');
  const dirty = deriveStatus(manifest, codeDirt, { W0: receipt(manifest.waves[0]) }, authorities, statusContext);
  A.eq(dirty.productPerfect, false, 'dirty source invalidates a prior green receipt');
  A.eq(dirty.currentWave, 'W0', 'dirty source re-queues from the first wave');
}

A.report('qa-product-perfect.test');
