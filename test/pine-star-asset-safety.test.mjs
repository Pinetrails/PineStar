import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PLACEHOLDER_MARKER, scanDistributableRoots } from '../scripts/pine-star-asset-safety.mjs';

const root = mkdtempSync(join(tmpdir(), 'pine-star-asset-safety-'));
try {
  mkdirSync(join(root, 'frontend', 'assets'), { recursive: true });
  writeFileSync(join(root, 'frontend', 'assets', 'original.svg'), '<svg><title>Original Pine Star mark</title></svg>');
  assert.deepEqual(scanDistributableRoots(root, ['frontend/assets']), [], 'original distributable art passes');

  writeFileSync(join(root, 'frontend', 'assets', 'study-notes.txt'), PLACEHOLDER_MARKER);
  let findings = scanDistributableRoots(root, ['frontend/assets']);
  assert.equal(findings.length, 1, 'exact private-reference marker blocks distribution');
  assert.equal(findings[0].reason, 'distribution-blocking marker');

  writeFileSync(join(root, 'frontend', 'assets', 'reference-do-not-distribute.png'), Buffer.from([0, 1, 2]));
  findings = scanDistributableRoots(root, ['frontend/assets']);
  assert.ok(findings.some(item => item.reason === 'placeholder filename'), 'a clearly blocked binary filename is caught without parsing binary data');

  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'policy.md'), PLACEHOLDER_MARKER);
  assert.equal(scanDistributableRoots(root, ['frontend/assets']).filter(item => item.path.startsWith('docs/')).length, 0,
    'policy documentation outside distributable roots is not a false positive');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('pine-star-asset-safety.test: OK');
