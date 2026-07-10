/* Product-perfect controller: dependency order, exact candidate binding, definition staleness,
   dirty-tree fail-closed behavior, and terminal verdict. Pure; no disk or subprocesses. */
'use strict';
const A = require('./_assert.js');
const {
  definitionHash, validateManifest, receiptValidity, deriveStatus
} = require('../scripts/qa/product-perfect.mjs');

const manifest = {
  schemaVersion: 1,
  terminalVerdict: 'PRODUCT PERFECT',
  waves: [
    { id: 'W0', name: 'Proof', goal: 'Trust proof', conditions: ['Proof is exact.'], dependsOn: [], verifier: { command: ['node', 'gate-0.mjs'], timeoutMs: 1000 } },
    { id: 'W1', name: 'Truth', goal: 'Trust state', conditions: ['State is true.'], dependsOn: ['W0'], verifier: { command: ['node', 'gate-1.mjs'], timeoutMs: 1000 } }
  ]
};
const candidate = { sha: 'a'.repeat(40), clean: true, dirtyPaths: [] };
const mHash = definitionHash(manifest);
const receipt = (wave) => ({
  schemaVersion: 1,
  waveId: wave.id,
  candidateSha: candidate.sha,
  manifestHash: mHash,
  waveDefinitionHash: definitionHash(wave),
  result: 'PASS',
  exitCode: 0,
  startedAt: '2026-07-10T00:00:00.000Z',
  finishedAt: '2026-07-10T00:01:00.000Z'
});

{
  A.eq(validateManifest(manifest).ok, true, 'valid serialized manifest passes');
  const bad = JSON.parse(JSON.stringify(manifest));
  bad.waves[1].dependsOn = [];
  A.eq(validateManifest(bad).ok, false, 'a skipped dependency is rejected');
  const dup = JSON.parse(JSON.stringify(manifest));
  dup.waves[1].id = 'W0';
  A.eq(validateManifest(dup).ok, false, 'duplicate wave IDs are rejected');
}

{
  const empty = deriveStatus(manifest, candidate, {});
  A.eq(empty.productPerfect, false, 'no receipts never means perfect');
  A.eq(empty.currentWave, 'W0', 'first missing wave is active');
  A.eq(empty.waves[1].status, 'pending', 'later wave waits on dependency');

  const w0 = receipt(manifest.waves[0]);
  const afterW0 = deriveStatus(manifest, candidate, { W0: w0 });
  A.eq(afterW0.currentWave, 'W1', 'controller advances only after W0 exact pass');
  A.eq(afterW0.waves[0].status, 'pass', 'exact W0 receipt is accepted');

  const all = deriveStatus(manifest, candidate, { W0: w0, W1: receipt(manifest.waves[1]) });
  A.eq(all.productPerfect, true, 'all exact receipts reach terminal state');
  A.eq(all.verdict, 'PRODUCT PERFECT', 'terminal verdict is exact');
}

{
  const w0 = receipt(manifest.waves[0]);
  const staleSha = Object.assign({}, w0, { candidateSha: 'b'.repeat(40) });
  A.eq(receiptValidity(staleSha, { wave: manifest.waves[0], candidate, manifestHash: mHash }).ok, false, 'receipt from another commit is stale');
  const staleStatus = deriveStatus({ schemaVersion: 1, terminalVerdict: 'PRODUCT PERFECT', waves: [manifest.waves[0]] }, candidate, { W0: staleSha });
  A.eq(staleStatus.productPerfect, false, 'a stale PASS receipt cannot reach the terminal verdict');
  A.eq(staleStatus.waves[0].status, 'blocked', 'stale PASS is visibly non-passing');
  const staleDefinition = Object.assign({}, w0, { waveDefinitionHash: '0'.repeat(64) });
  A.eq(receiptValidity(staleDefinition, { wave: manifest.waves[0], candidate, manifestHash: mHash }).ok, false, 'changed wave definition re-queues proof');
  const asserted = Object.assign({}, w0, { result: 'PASS', exitCode: null, manuallyDone: true });
  A.eq(receiptValidity(asserted, { wave: manifest.waves[0], candidate, manifestHash: mHash }).ok, false, 'hand assertion cannot replace a verifier exit');
  const dirty = deriveStatus(manifest, { sha: candidate.sha, clean: false, dirtyPaths: [' M sidecar/index.js'] }, { W0: w0 });
  A.eq(dirty.productPerfect, false, 'dirty source invalidates a prior green receipt');
  A.eq(dirty.currentWave, 'W0', 'dirty source re-queues from the first wave');
}

A.report('qa-product-perfect.test');
