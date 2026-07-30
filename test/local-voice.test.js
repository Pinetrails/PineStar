'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const localVoice = require('../sidecar/local-voice.js');

// Offline speech needs `@huggingface/transformers` + `kokoro-js`, which the shipped desktop bundle does
// NOT carry (Tauri ships sidecar/ frontend/ shared/ and no node_modules). So this test may not assume
// either environment: it independently decides whether the packages are on disk and then holds the module
// to the matching contract. The previous version asserted `available === true` unconditionally and never
// touched an import, so it stayed green on a machine with the packages absent — the exact state of every
// installed build — while the panel told users the capability was there.
function packageOnDisk(name) {
  const parts = name.split('/');
  let dir = path.resolve(__dirname, '..');
  for (;;) {
    if (fs.existsSync(path.join(dir, 'node_modules', ...parts, 'package.json'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

(async () => {
  const expected = packageOnDisk('@huggingface/transformers') && packageOnDisk('kokoro-js');
  const status = localVoice.status();

  assert.equal(
    status.available, expected,
    `status().available must match whether the model packages are actually installed (expected ${expected})`
  );
  assert.equal(typeof status.cacheRoot, 'string');
  assert.ok(status.cacheRoot.length > 3);
  assert.ok(
    !/[\\/]node_modules[\\/]/.test(status.cacheRoot),
    'downloaded weights live in the per-user data root, never inside the checkout'
  );
  assert.equal(status.asrBusy, 0);
  assert.equal(status.lastAsrMs, null);
  assert.equal(status.ttsBusy, 0);
  assert.equal(status.lastTtsMs, null);

  // Payload validation runs before anything else, installed or not.
  await assert.rejects(() => localVoice.transcribe(Buffer.alloc(3)), /invalid 16 kHz/);

  if (expected) {
    assert.equal(status.reason, '');
    assert.equal(status.asr, 'cold');
    assert.equal(status.tts, 'cold');
    const silence = await localVoice.transcribe(Buffer.alloc(16000 * 4));
    assert.equal(silence, '', 'digital silence is rejected before Whisper can hallucinate');
  } else {
    // The honest-refusal contract: no state that implies a warm-up is coming, and a reason the UI can print.
    assert.equal(status.asr, 'unavailable');
    assert.equal(status.tts, 'unavailable');
    assert.match(status.reason, /not installed in this build/);
    assert.match(status.error, /not installed in this build/);
    // Silence must NOT resolve to '' here — an empty transcript reads as "you said nothing", which is a
    // claim this build cannot make.
    await assert.rejects(
      () => localVoice.transcribe(Buffer.alloc(16000 * 4)),
      error => error && error.unavailable === true && /not installed in this build/.test(error.message)
    );
    await assert.rejects(() => localVoice.warm(), error => error && error.unavailable === true);
    await assert.rejects(() => localVoice.synthesize('hello'), error => error && error.unavailable === true);
  }

  console.log(`local-voice.test.js: ok (models ${expected ? 'installed' : 'absent'})`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
