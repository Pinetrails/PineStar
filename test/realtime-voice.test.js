'use strict';

const assert = require('node:assert/strict');
const {
  DEFAULT_MODEL,
  sessionConfig,
  safetyIdentifier,
  makeRealtimeVoice
} = require('../sidecar/realtime-voice.js');

(async () => {
  const config = sessionConfig();
  assert.equal(config.type, 'realtime');
  assert.equal(config.model, DEFAULT_MODEL);
  assert.deepEqual(config.output_modalities, ['audio']);
  assert.equal(config.audio.input.turn_detection.type, 'semantic_vad');
  assert.equal(config.audio.input.turn_detection.interrupt_response, true);
  assert.equal(config.audio.output.voice, 'marin');
  assert.ok(config.tools.some(tool => tool.name === 'start_starnet_task'));
  assert.ok(config.tools.some(tool => tool.name === 'interrupt_starnet_task'));

  const a = safetyIdentifier('same-install');
  const b = safetyIdentifier('same-install');
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);

  const unavailable = makeRealtimeVoice({ resolveKey: () => '' });
  assert.equal(unavailable.status().available, false);
  const noKey = await unavailable.createCall('v=0\r\n');
  assert.equal(noKey.status, 409);
  assert.match(noKey.body, /API key required/);

  let captured = null;
  const live = makeRealtimeVoice({
    resolveKey: () => 'test-secret',
    safetySeed: 'install-1',
    fetch: async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 201,
        headers: { get: name => name === 'content-type' ? 'application/sdp' : null },
        text: async () => 'v=0\r\no=answer'
      };
    }
  });
  assert.equal(live.status().available, true);
  const result = await live.createCall('v=0\r\no=offer');
  assert.equal(result.status, 201);
  assert.equal(result.contentType, 'application/sdp');
  assert.equal(captured.url, 'https://api.openai.com/v1/realtime/calls');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer test-secret');
  assert.match(captured.init.headers['OpenAI-Safety-Identifier'], /^[a-f0-9]{64}$/);
  assert.equal(captured.init.body.get('sdp'), 'v=0\r\no=offer');
  const sentSession = JSON.parse(captured.init.body.get('session'));
  assert.equal(sentSession.model, DEFAULT_MODEL);
  assert.equal(sentSession.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
  assert.equal(captured.init.headers.Authorization.includes('test-secret'), true);
  assert.equal(JSON.stringify(sentSession).includes('test-secret'), false);

  const failed = makeRealtimeVoice({
    resolveKey: () => 'key',
    fetch: async () => { throw new Error('network details that should not leak'); }
  });
  const failure = await failed.createCall('v=0\r\n');
  assert.equal(failure.status, 502);
  assert.equal(failure.body.includes('network details'), false);

  console.log('realtime-voice.test.js: ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
