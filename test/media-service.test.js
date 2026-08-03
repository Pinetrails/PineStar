'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  makeMediaService, pcmToWav, wavToMono16kFloat32, sttMultipartBody
} = require('../sidecar/media-service.js');

const roots = [];

async function make(overrides) {
  const workspaces = await fsp.mkdtemp(path.join(os.tmpdir(), 'starnet-media-'));
  roots.push(workspaces);
  const opts = Object.assign({
    workspaces,
    fs,
    fsp,
    fetch: async () => { throw new Error('unexpected network'); },
    edgetts: { enabled: () => false, resolveVoice: () => 'en-US-ChristopherNeural', synth: async () => Buffer.alloc(0) },
    localVoice: {
      status: () => ({ available: false }),
      defaultVoice: () => 'af_heart',
      edgeVoiceFor: () => 'en-US-ChristopherNeural',
      synthesize: async () => { throw new Error('local unavailable'); },
      transcribe: async () => ''
    },
    nativeStt: { status: () => ({ available: false }), recognize: async () => ({ ok: false, text: '' }) },
    readBody: async () => '{}',
    readBodyBuffer: async () => Buffer.alloc(0),
    providerRuntimeKey: () => '',
    providerRuntimeBaseUrl: () => '',
    normalizeProviderId: value => String(value || '').toLowerCase(),
    getRuntimeKey: () => '',
    env: () => '',
    processEnv: {},
    redact: String,
    logger: { error() {}, warn() {} },
    now: () => 1234,
    randomUUID: () => 'uuid',
    randomBytes: n => Buffer.alloc(n, 0xab)
  }, overrides || {});
  return makeMediaService(opts);
}

(async () => {
  // PCM wrapping and the local-ASR decoder remain exact inverses at their shared boundary.
  const pcm = Buffer.alloc(4 * 2 * 2);
  for (let frame = 0; frame < 4; frame++) {
    const sample = frame < 2 ? 32767 : -32768;
    pcm.writeInt16LE(sample, frame * 4);
    pcm.writeInt16LE(sample, frame * 4 + 2);
  }
  const wav = pcmToWav(pcm, 32000, 2);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 32000);
  assert.equal(wav.readUInt16LE(22), 2);
  const decoded = wavToMono16kFloat32(wav);
  assert.equal(decoded.length, 2, '32 kHz stereo is downsampled to 16 kHz mono');
  assert.ok(decoded[0] > 0.99);
  assert.equal(decoded[1], -1);
  assert.equal(wavToMono16kFloat32(Buffer.from('not wav')), null);

  // Multipart construction preserves the audio byte-for-byte and names the Whisper model/file parts.
  const audio = Buffer.from([0, 1, 2, 255, 13, 10]);
  const multipart = sttMultipartBody(audio, 'clip.webm', 'audio/webm', { model: 'whisper-test' }, n => Buffer.alloc(n, 7));
  assert.match(multipart.contentType, /^multipart\/form-data; boundary=----StarNetSTT/);
  assert.ok(multipart.body.includes(Buffer.from('name="model"')));
  assert.ok(multipart.body.includes(Buffer.from('whisper-test')));
  assert.ok(multipart.body.includes(Buffer.from('name="file"; filename="clip.webm"')));
  assert.ok(multipart.body.includes(audio), 'multipart body carries the original audio bytes');

  // No credentials and no local engine is an honest terminal capability result.
  const keyless = await make();
  assert.deepEqual(await keyless.transcribeAudioBuffer(Buffer.from('audio'), 'webm'), { ok: false, reason: 'no key' });
  assert.match((await keyless.synthesizeForAgent({ text: 'hello' })).reason, /edge: disabled/);

  // A keyed TTS failure falls through to the free Edge floor instead of committing a hard failure.
  let ttsFetches = 0;
  const edge = await make({
    providerRuntimeKey: provider => provider === 'openrouter' ? 'key' : '',
    fetch: async url => {
      ttsFetches++;
      assert.equal(url, 'https://openrouter.ai/api/v1/audio/speech');
      return { ok: false, status: 402, text: async () => 'credits exhausted' };
    },
    edgetts: { enabled: () => true, resolveVoice: () => 'en-US-ChristopherNeural', synth: async () => Buffer.from('edge-mp3') }
  });
  const spoken = await edge.synthesizeForAgent({ text: 'fallback line', voice: 'Umbriel' });
  assert.equal(ttsFetches, 1);
  assert.equal(spoken.ok, true);
  assert.equal(spoken.provider, 'edge');
  assert.equal(spoken.buf.toString(), 'edge-mp3');

  // Dedicated ASR preserves the Groq -> OpenAI order and continues after a failed first tier.
  const asrCalls = [];
  const asr = await make({
    providerRuntimeKey: provider => provider === 'groq' ? 'groq-key' : (provider === 'openai' ? 'openai-key' : ''),
    providerRuntimeBaseUrl: provider => 'https://' + provider + '.invalid/v1',
    fetch: async (url, init) => {
      asrCalls.push({ url, init });
      if (url.startsWith('https://groq.invalid/')) return { ok: false, status: 503, text: async () => 'busy' };
      return { ok: true, status: 200, json: async () => ({ text: 'heard by openai' }) };
    }
  });
  assert.deepEqual(await asr.transcribeAudioBuffer(audio, 'webm'), { ok: true, text: 'heard by openai' });
  assert.equal(asrCalls.length, 2);
  assert.match(asrCalls[0].url, /groq\.invalid\/v1\/audio\/transcriptions$/);
  assert.match(asrCalls[1].url, /openai\.invalid\/v1\/audio\/transcriptions$/);
  assert.ok(asrCalls[0].init.body.includes(audio));
  assert.ok(asrCalls[1].init.body.includes(Buffer.from('whisper-1')));

  // The keyless local floor receives decoded/resampled Float32 PCM, never compressed container bytes.
  let localPcm = null;
  const local = await make({
    localVoice: {
      status: () => ({ available: true }),
      transcribe: async bytes => { localPcm = Buffer.from(bytes); return 'local words'; },
      defaultVoice: () => 'af_heart', edgeVoiceFor: () => 'en-US-ChristopherNeural',
      synthesize: async () => { throw new Error('unused'); }
    }
  });
  assert.deepEqual(await local.transcribeAudioBuffer(wav, 'wav'), { ok: true, text: 'local words' });
  assert.equal(localPcm.length, decoded.length * 4);
  assert.match((await local.transcribeAudioBuffer(Buffer.from('compressed'), 'ogg')).reason, /local engine needs wav/);

  console.log('media-service: OK (25 assertions)');
})().finally(async () => {
  for (const root of roots) await fsp.rm(root, { recursive: true, force: true });
}).catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
