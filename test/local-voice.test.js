'use strict';

const assert = require('node:assert/strict');
const localVoice = require('../sidecar/local-voice.js');

(async () => {
  const status = localVoice.status();
  assert.equal(status.available, true);
  assert.equal(typeof status.cacheRoot, 'string');
  assert.ok(status.cacheRoot.length > 3);
  assert.equal(status.asrBusy, 0);
  assert.equal(status.lastAsrMs, null);
  assert.equal(status.ttsBusy, 0);
  assert.equal(status.lastTtsMs, null);

  await assert.rejects(() => localVoice.transcribe(Buffer.alloc(3)), /invalid 16 kHz/);
  const silence = await localVoice.transcribe(Buffer.alloc(16000 * 4));
  assert.equal(silence, '', 'digital silence is rejected before Whisper can hallucinate');

  console.log('local-voice.test.js: ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
