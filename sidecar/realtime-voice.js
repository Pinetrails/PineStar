'use strict';

const DEFAULT_MODEL = 'gpt-realtime-2.1';
const DEFAULT_VOICE = 'marin';

const TOOLS = [
  {
    type: 'function',
    name: 'get_starnet_status',
    description: 'Read the visible Starnet workstreams, active task state, and approval state.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    type: 'function',
    name: 'start_starnet_task',
    description: 'Send a concrete instruction to Starnet. If its current workstream is busy, the instruction is queued as a follow-up.',
    parameters: {
      type: 'object',
      properties: { instruction: { type: 'string', description: 'The complete instruction to send to the active Starnet agent.' } },
      required: ['instruction'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'interrupt_starnet_task',
    description: 'Stop the active Starnet task when the user explicitly asks to stop, cancel, or change direction.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'A short user-stated reason for the interruption.' } },
      additionalProperties: false
    }
  }
];

function sessionConfig(opts) {
  opts = opts || {};
  return {
    type: 'realtime',
    model: opts.model || DEFAULT_MODEL,
    output_modalities: ['audio'],
    instructions: [
      'You are Starnet Voice, a concise spoken control layer for the Starnet agent workspace.',
      'Speak naturally and briefly. Let the user interrupt you.',
      'For requests that require research, coding, file changes, tools, or sustained work, call start_starnet_task instead of claiming you performed the work yourself.',
      'Use get_starnet_status for progress questions. Never invent task state, tool results, approvals, or files.',
      'Use interrupt_starnet_task only after the user clearly asks to stop or redirect current work.',
      'After starting or queuing work, confirm in one short sentence and explain that progress remains visible in Starnet.',
      'Do not ask for credentials or repeat secrets aloud.'
    ].join(' '),
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription: { model: 'gpt-4o-mini-transcribe' },
        turn_detection: {
          type: 'semantic_vad',
          eagerness: 'auto',
          create_response: true,
          interrupt_response: true
        }
      },
      output: { voice: opts.voice || DEFAULT_VOICE }
    },
    tools: TOOLS,
    tool_choice: 'auto'
  };
}

function safetyIdentifier(seed) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(String(seed || 'starnet-local')).digest('hex').slice(0, 64);
}

function makeRealtimeVoice(opts) {
  opts = opts || {};
  const fetchFn = opts.fetch || globalThis.fetch;
  const resolveKey = opts.resolveKey || (() => '');
  const model = opts.model || DEFAULT_MODEL;
  const voice = opts.voice || DEFAULT_VOICE;
  const safetyId = safetyIdentifier(opts.safetySeed);

  function status() {
    return { available: !!String(resolveKey() || '').trim(), model, voice, transport: 'webrtc' };
  }

  async function createCall(sdp) {
    const offer = String(sdp || '').trim();
    if (!offer || offer.length > (1 << 20)) {
      return { status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid SDP offer' }) };
    }
    const key = String(resolveKey() || '').trim();
    if (!key) {
      return { status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'OpenAI API key required for live voice' }) };
    }
    const form = new FormData();
    form.set('sdp', offer);
    form.set('session', JSON.stringify(sessionConfig({ model, voice })));
    let upstream;
    try {
      upstream = await fetchFn('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          'OpenAI-Safety-Identifier': safetyId
        },
        body: form
      });
    } catch (_) {
      return { status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Realtime service could not be reached' }) };
    }
    const body = await upstream.text();
    const contentType = upstream.headers && upstream.headers.get
      ? (upstream.headers.get('content-type') || (upstream.ok ? 'application/sdp' : 'application/json'))
      : (upstream.ok ? 'application/sdp' : 'application/json');
    return { status: upstream.status, contentType, body };
  }

  return { status, createCall };
}

module.exports = { DEFAULT_MODEL, DEFAULT_VOICE, TOOLS, sessionConfig, safetyIdentifier, makeRealtimeVoice };
