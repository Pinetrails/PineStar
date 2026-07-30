/* node test/voice.button.test.js — behavioral guard for the voice mic BUTTON state machine.

   Andrew reported "the voice button does not always work reliably." The intermittent failures were
   button states that could WEDGE (stuck 'rec' / listening=true with no way back) rather than always
   recovering to a usable state. This test boots the real frontend/app/voice.js in a fabricated window
   (no DOM/jsdom needed — voice.js only touches a handful of globals) and drives the recovery paths:

     • webSpeech: recognition.start() throws (double-start / InvalidStateError) → button recovers.
     • webSpeech: a STALE errored recognition fires onend LATE, after a fresh listen started — it must
       NOT null/clear the new listen (the orphan-instance wedge).
     • recorder (desktop): getUserMedia HANGS (dismissed permission prompt) → a timeout returns the
       button to usable instead of a permanent dead 'rec' button.
     • recorder: getUserMedia denied then re-granted → mic works again.

   Every path asserts the button ends in a usable, non-listening state — the task's core law:
   "every error path returns the button to a usable state; never a dead/stuck button." */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'voice.js'), 'utf8');

// ---- controllable browser mocks --------------------------------------------------------------
let liveRecs = 0, srStartMode = 'ok', srInstances = [];
class MockSR {
  constructor() { this.started = false; this.onresult = this.onerror = this.onend = null; srInstances.push(this); }
  start() { if (srStartMode === 'throw' || this.started) { const e = new Error('already started'); e.name = 'InvalidStateError'; throw e; } this.started = true; liveRecs++; }
  stop() { if (this.started) { this.started = false; liveRecs--; const s = this; setTimeout(() => { s.onend && s.onend(); }, 0); } }
  abort() { if (this.started) { this.started = false; liveRecs--; } const s = this; setTimeout(() => { s.onend && s.onend(); }, 0); }
  fireError(err) { this.onerror && this.onerror({ error: err }); }
  fireFinal(t) { if (this.onresult) this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] }); if (this.started) { this.started = false; liveRecs--; } this.onend && this.onend(); }
}

let gumMode = 'ok', gumPending = [];
function fakeStream() { return { getTracks: () => [{ stop() {} }] }; }
function makeGum() {
  return () => new Promise((res, rej) => {
    if (gumMode === 'ok') res(fakeStream());
    else if (gumMode === 'deny') { const e = new Error('denied'); e.name = 'NotAllowedError'; rej(e); }
    else gumPending.push({ res, rej });   // 'hang'
  });
}
let mrInstances = [];
class MockMR {
  static isTypeSupported() { return true; }
  constructor(stream, opts) { this.stream = stream; this.mimeType = (opts && opts.mimeType) || 'audio/webm'; this.state = 'inactive'; this.ondataavailable = this.onstop = this.onerror = null; mrInstances.push(this); }
  start() { this.state = 'recording'; }
  stop() { if (this.state !== 'inactive') { this.state = 'inactive'; const s = this; setTimeout(() => { s.onstop && s.onstop(); }, 0); } }
}
class MockAnalyser { constructor() { this.fftSize = 2048; } getFloatTimeDomainData(b) { for (let i = 0; i < b.length; i++) b[i] = 0; } }
/* canSpeak() is `typeof Audio !== 'undefined' && typeof fetch !== 'undefined'`, and without it init() HIDES
   the speaker toggle and never calls reflectToggle — so any test of the tooltip's reflect path is vacuous.
   Opt in with boot({ audio: true }). Only ever constructed on a SUCCESSFUL synth, so a degrade test never
   reaches it. */
class MockAudio {
  constructor(src) { this.src = src || ''; this.onended = this.onerror = this.onpause = null; this.currentTime = 0; this.playbackRate = 1; this.preload = ''; }
  play() { return Promise.resolve(); }
  pause() {} load() {} addEventListener() {} removeEventListener() {}
}
class MockAC { constructor() { this.state = 'running'; this.sampleRate = 48000; } createMediaStreamSource() { return { connect() {} }; } createAnalyser() { return new MockAnalyser(); } createGain() { return { connect() {}, gain: { value: 0 } }; } close() {} resume() {} }

function mkEl(id) {
  const cls = new Set();
  const e = {
    id, value: '', textContent: '', title: '', innerHTML: '', style: {}, _attrs: {},
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => { if (on === undefined) { cls.has(c) ? cls.delete(c) : cls.add(c); } else { on ? cls.add(c) : cls.delete(c); } }, contains: c => cls.has(c) },
    setAttribute(k, v) { e._attrs[k] = v; }, getAttribute(k) { return e._attrs[k]; }, addEventListener() {}, onclick: null
  };
  return e;
}

// Build a fresh voice.js instance in its own sandbox. `recorder` = force the desktop recorder path.
function boot(opts) {
  opts = opts || {};
  liveRecs = 0; srInstances = []; gumMode = 'ok'; gumPending = []; mrInstances = [];
  const nodes = {}; ['chat-input', 'chat-status', 'chat-mic', 'voice-toggle', 'voice-mode'].forEach(id => nodes[id] = mkEl(id));
  const statusLog = [];
  const win = {};
  // TIME-COMPRESS the long ceilings (12s gUM, 30s hard cap) so the test runs fast; short timers unchanged.
  const st = (fn, ms, ...a) => setTimeout(fn, ms >= 1000 ? Math.min(ms, 20) : ms, ...a);
  const sandbox = {
    window: win,
    document: { getElementById: id => nodes[id] || null, addEventListener() {} },
    navigator: opts.recorder ? { mediaDevices: { getUserMedia: makeGum() } } : { mediaDevices: undefined },
    location: { search: opts.recorder ? '?stt=recorder' : '' },
    localStorage: (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => m[k] = String(v), removeItem: k => delete m[k] }; })(),
    SpeechRecognition: opts.recorder ? undefined : MockSR,
    MediaRecorder: opts.recorder ? MockMR : undefined,
    AudioContext: MockAC,
    Audio: opts.Audio || (opts.audio ? MockAudio : undefined),
    requestAnimationFrame: cb => st(() => cb(Date.now()), 16), cancelAnimationFrame: clearTimeout,
    setTimeout: st, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {} },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: url => { if (opts.onRevoke) opts.onRevoke(url); } },
    AbortController,   // neural-TTS synth uses one per request to allow barge-in cancel
    Blob: class { constructor(parts, o) { this.size = (parts && parts.length) ? 1 : 0; this.type = (o && o.type) || ''; } },
    fetch: opts.fetch || (() => Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) })),
    Chat: { isBusy: () => sandbox.__busy, status: s => { statusLog.push(s); nodes['chat-status'].textContent = s; }, send: t => sandbox.__sent.push(t), autoGrowInput() {} },
    SFX: { open() {}, click() {}, think() {}, boot() {} },
    Personas: { DEFAULT_ID: 'professional', get: () => ({ ttsVoice: 'Umbriel', ttsSpeed: 1 }) },
    Harness: { getKey: () => (opts.ttsKey ? 'k' : ''), configured: () => false },
    __busy: false, __sent: []
  };
  // speechSynthesis is DELETED from the speak path; a test may inject a spy to prove it's never invoked.
  sandbox.globalThis = sandbox; win.SpeechRecognition = MockSR; win.speechSynthesis = opts.speechSynthesis || undefined;
  vm.createContext(sandbox);
  vm.runInContext(SRC + '\nthis.__Voice = Voice;', sandbox, { filename: 'voice.js' });
  const Voice = sandbox.__Voice;
  Voice.init({ name: 'Tester' });
  return { Voice, nodes, statusLog, sandbox, micRec: () => nodes['chat-mic'].classList.contains('rec') };
}

// a /api/tts endpoint that always FAILS with a given reason (→ neural voice degrades to the browser
// voice). Any non-TTS call (e.g. STT transcribe) keeps the normal success shape.
function ttsFailFetch(reason) {
  return (url) => (String(url).indexOf('/api/tts') >= 0)
    ? Promise.resolve({ ok: false, status: 402, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ reason }) })
    : Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) });
}

// a /api/tts endpoint that always returns a {fallback,reason} (NON-audio) response and COUNTS how many
// times it was actually hit — so a test can prove the client re-probes (fetches) vs. stays latched off.
function countingFetch(state, reason) {
  return (url) => {
    if (String(url).indexOf('/api/tts') >= 0) {
      state.tts++;
      return Promise.resolve({ ok: false, status: 401, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ fallback: true, reason }) });
    }
    return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) });
  };
}

const tick = (n = 12) => new Promise(r => setTimeout(r, n));
// Wait for an OUTCOME, never a fixed sleep. The recorder's stop -> onstop -> finish -> transcribe().then
// chain is several await hops deep, and inside the full gate it competes with hundreds of other node
// processes for the event loop — a fixed budget that passes alone becomes a coin flip under load. This
// exits the instant the condition holds, so the ceiling is free on a green run.
async function until(pred, ms) {
  for (let waited = 0; waited < ms; waited += 10) { if (pred()) return true; await tick(10); }
  return pred();
}
// Did the mic open at ANY point inside the window? The rig compresses the listen hard cap to 20ms, so a
// healthy hands-free loop is a rapid open/close cycle — a single sample lands in a gap half the time.
async function opensWithin(t, ms) {
  for (let waited = 0; waited < ms; waited += 10) {
    if (t.Voice.isListening()) return true;
    await tick(10);
  }
  return t.Voice.isListening();
}

(async () => {
  // --- webSpeech: recognition.start() throws (double-start / InvalidStateError) -----------------
  {
    const t = boot(); srStartMode = 'throw';
    t.Voice.startListening(); await tick();
    A.ok(t.Voice.isListening() === false, 'webSpeech: start() throw → listening recovers to false (no wedge)');
    A.ok(!t.micRec(), 'webSpeech: start() throw → mic button not stuck in rec state');
    srStartMode = 'ok';
    t.Voice.startListening(); await tick();
    A.ok(t.Voice.isListening() === true, 'webSpeech: mic works again after a start-failure');
    if (srInstances.length) srInstances[srInstances.length - 1].fireFinal('hi'); await tick();
  }

  // --- webSpeech: STALE errored recognition fires onend LATE (orphan-instance wedge) ------------
  {
    const t = boot();
    t.Voice.startListening(); await tick();                 // listen A
    const recA = srInstances[srInstances.length - 1];
    recA.fireError('network'); await tick();                 // A errors; listening cleared
    A.ok(t.Voice.isListening() === false, 'webSpeech: listening cleared after A errors');
    t.Voice.startListening(); await tick();                 // listen B
    const recB = srInstances[srInstances.length - 1];
    A.ok(t.Voice.isListening() === true && recB !== recA, 'webSpeech: fresh listen B started after A errored');
    recA.onend && recA.onend(); await tick();                // A's late onend — must NOT touch B
    A.ok(t.Voice.isListening() === true, 'webSpeech: B survives A late onend (stale instance does not null the live one)');
    t.Voice.stopListening(); await tick();
    A.ok(t.Voice.isListening() === false, 'webSpeech: B is still stoppable after A late onend (not wedged)');
  }

  // --- recorder (desktop): getUserMedia HANGS (dismissed prompt) → recover, not a dead button ---
  {
    const t = boot({ recorder: true });
    A.ok(t.Voice.canListen() === true, 'recorder path is active when SR is absent');
    gumMode = 'hang';
    t.Voice.startListening(); await tick(60);                // wait past the compressed gUM ceiling
    A.ok(t.Voice.isListening() === false, 'recorder: gUM hang times out → button recovers (NOT a dead mic)');
    A.ok(!t.micRec(), 'recorder: gUM hang → mic button cleared out of rec state');
    A.ok(t.statusLog.some(s => /mic|allow|blocked|try again/i.test(s)), 'recorder: gUM hang → a visible cue is shown');
  }

  // --- recorder: getUserMedia denied then re-granted -------------------------------------------
  {
    const t = boot({ recorder: true });
    gumMode = 'deny';
    t.Voice.startListening(); await tick();
    A.ok(t.Voice.isListening() === false, 'recorder: denial → listening false');
    A.ok(t.statusLog.some(s => /blocked|allow/i.test(s)), 'recorder: denial → actionable cue shown');
    gumMode = 'ok';
    t.Voice.startListening(); await tick();
    A.ok(t.Voice.isListening() === true, 'recorder: mic works after re-grant');
  }

  // --- OAuth Live coordinator: keyless speech stays open while a task is busy ------------------
  {
    const t = boot();
    const heard = [], states = [];
    t.sandbox.__busy = true;
    const started = t.Voice.startCoordinator({
      onState: state => states.push(state),
      onTranscript: text => { heard.push(text); return true; }
    });
    await tick();
    A.ok(started === true, 'oauth live: coordinator starts when browser speech recognition is available');
    A.ok(t.Voice.isListening() === true, 'oauth live: mic opens while the active task is busy (steer/barge-in path)');
    A.ok(states.includes('listening'), 'oauth live: listening state is surfaced to the live panel');
    srInstances[srInstances.length - 1].fireFinal('change direction'); await tick();
    A.ok(heard[0] === 'change direction', 'oauth live: final transcript reaches the coordinator');
    A.ok(t.sandbox.__sent.length === 0, 'oauth live: a claimed transcript is not double-sent through classic Chat.send');
    t.Voice.stopCoordinator(); await tick();
    A.ok(t.Voice.inVoiceMode() === false, 'oauth live: coordinator teardown closes hands-free mode');
  }

  // --- voice degrade NEVER writes to the COMMS status bar (#chat-status) ------------------------
  // When neural TTS fails, the honest "backup voice active" reason must ride the speaker toggle's
  // TOOLTIP only — never the run-state header bar (Andrew 2026-07-13: "there should never be text on
  // the comms panel on that bar"). Truthful telemetry is preserved (the reason stays inspectable on
  // hover); the header stays clean of voice-outage banners.
  {
    const t = boot({ ttsKey: true, fetch: ttsFailFetch('insufficient credits') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('hello commander, systems are nominal', 'agent'); await tick(40);
    const title = String(t.nodes['voice-toggle'].title || '');
    A.ok(/real voice|backup voice/i.test(title), 'voice degrade: honest reason pinned on the speaker-toggle tooltip (telemetry preserved)');
    A.ok(!t.statusLog.some(s => /real voice|backup voice|voice provider/i.test(String(s))), 'voice degrade: outage banner is NEVER pushed to the COMMS status bar');
    A.ok(!/real voice|backup voice/i.test(String(t.nodes['chat-status'].textContent || '')), 'voice degrade: #chat-status text carries no voice-outage banner');
  }

  // --- a 'no key' TTS response does NOT permanently disable neural (un-latched cold-off) --------
  // Previously a single {fallback,reason:'no key'} latched ttsDisabled for the whole session — robotic
  // (now silent) until reload. New contract: 'no key' is a 60s cold-off that ANY speaker toggle clears,
  // after which the very next speak attempts the sidecar fetch again.
  {
    const state = { tts: 0 };
    const t = boot({ ttsKey: true, fetch: countingFetch(state, 'no key') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('first line to the commander', 'agent'); await tick(40);
    const afterFirst = state.tts;
    A.ok(afterFirst >= 1, 'no-key: the first speak actually hits /api/tts (always asks the sidecar)');
    t.Voice.speak('second line while still cold', 'agent'); await tick(40);
    A.ok(state.tts === afterFirst, 'no-key: while the cold-off is active the neural path is skipped, not re-fetched');
    // toggle the speaker (off, then on) — this must clear the cold-off and re-probe fresh.
    t.Voice.setSpeakReplies(false);
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('third line after re-toggle', 'agent'); await tick(40);
    A.ok(state.tts > afterFirst, 'no-key: a speaker toggle clears the cold-off → the next speak fetches again (NOT permanently disabled)');
  }

  // --- media decode failure AFTER playback starts clears speaking + the live output meter -------
  // This is the dangerous ordering: `onplay` turns speaking on, then the media element fails. The
  // queue may advance, but the shared live panel must not remain pinned to the agent forever.
  {
    class FailingAudio {
      constructor() { this.volume = 1; this.playbackRate = 1; this.onplay = this.onended = this.onerror = null; }
      play() {
        if (this.onplay) this.onplay();
        setTimeout(() => { if (this.onerror) this.onerror(new Error('decode failed')); }, 25);
        return Promise.resolve();
      }
      pause() {}
    }
    let revoked = 0;
    const audioFetch = () => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'audio/wav' },
      blob: () => Promise.resolve({ size: 128 })
    });
    const t = boot({ ttsKey: true, fetch: audioFetch, Audio: FailingAudio, onRevoke: () => { revoked++; } });
    const states = [], levels = [];
    t.Voice.attachCoordinator({ onState: state => states.push(state), onOutputLevel: level => levels.push(level) });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('this chunk begins and then fails to decode', 'agent');
    await tick(70);
    A.ok(states.includes('speaking'), 'post-play failure: speaking state was genuinely entered');
    A.ok(t.Voice.isSpeaking() === false, 'post-play failure: speaking state is cleared (no stuck agent turn)');
    A.ok(states.includes('ready'), 'post-play failure: coordinator returns to ready');
    A.ok(levels.some(level => level === 0), 'post-play failure: live output meter receives its terminal zero');
    A.ok(revoked === 1, 'post-play failure: playback blob URL is revoked exactly once');
  }

  // --- a FAILED neural chunk NEVER invokes speechSynthesis.speak (robotic path deleted) ---------
  // The browser speechSynthesis speak path is gone: a neural failure degrades to SILENCE (skip the chunk)
  // + the tooltip reason, never the robotic voice. Inject a speechSynthesis spy and prove it stays untouched.
  {
    const synthSpy = { speakCalls: 0, speak() { this.speakCalls++; }, cancel() {}, resume() {}, getVoices: () => [], speaking: false, pending: false, paused: false };
    const t = boot({ ttsKey: true, fetch: ttsFailFetch('insufficient credits'), speechSynthesis: synthSpy });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('this reply cannot be synthesized', 'agent'); await tick(40);
    A.ok(synthSpy.speakCalls === 0, 'failed neural chunk NEVER calls speechSynthesis.speak (no robotic fallback)');
  }

  // --- ONE transient blip must NOT silence the rest of a reply ("it only says the first word") ---
  // 2026-07-28 user report: with the agent voice on, the agent spoke its opening words and then went quiet
  // for the whole rest of the reply. Mechanism: any failed chunk armed a 4s neural cold-off, and every LATER
  // chunk of the SAME reply then short-circuited to silence without even attempting its round-trip — one blip
  // on sentence 2 guillotined sentences 3..N. Contract now: a reply already speaking keeps asking (with one
  // immediate retry for a transient class), so a single blip costs at most a beat, never the rest of the reply.
  {
    const state = { tts: 0, spoken: [] };
    // Fail the 2nd request AND its retry (a blip that outlives one retry — otherwise the retry alone rescues
    // the chunk and the cold-off gate is never exercised). Everything after returns real audio, so the ONLY
    // thing that can keep sentences 3..N silent is the cold-off leaking across the rest of the reply.
    const blipFetch = (url, o) => {
      if (String(url).indexOf('/api/tts') >= 0) {
        state.tts++;
        if (state.tts === 2 || state.tts === 3) return Promise.resolve({ ok: false, status: 429, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ fallback: true, reason: 'openrouter 429 — rate limited' }) });
        try { state.spoken.push(JSON.parse(o.body).text); } catch (_) {}
        return Promise.resolve({ ok: true, headers: { get: () => 'audio/mpeg' }, blob: () => Promise.resolve({ size: 128 }) });
      }
      return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) });
    };
    const t = boot({ ttsKey: true, fetch: blipFetch });
    t.Voice.setSpeakReplies(true);
    // stream a reply the way chat.js does: chunk by chunk, then close it.
    t.Voice.speakChunk('Right, ', 'agent'); await tick(20);
    t.Voice.speakChunk('here is the first full sentence. ', 'agent'); await tick(20);
    t.Voice.speakChunk('This is the second sentence. ', 'agent'); await tick(20);
    t.Voice.speakChunk('Third sentence lands here. ', 'agent'); await tick(20);
    t.Voice.speakChunk('And a fourth to close it out. ', 'agent'); await tick(20);
    t.Voice.endReply(); await tick(80);
    A.ok(state.tts > 3, 'blip: a failed chunk does NOT stop the reply — later chunks still attempt their round-trip');
    A.ok(state.spoken.some(s => /fourth to close/.test(s)), 'blip: the LAST sentence of the reply is still synthesized (reply spoken through to the end)');
    A.ok(state.spoken.some(s => /second sentence/.test(s)), 'blip: the sentence after the failure is spoken (cold-off never guillotines a live reply)');
    A.ok(state.spoken.some(s => /Third sentence/.test(s)), 'blip: every remaining sentence is spoken, not just the one after the failure');
  }

  // --- a transient failure is RETRIED once, so a one-shot blip loses NOTHING -------------------
  // Narrower guard on the retry itself: fail exactly one request and prove the same chunk's text is
  // re-requested and spoken (a single 429 must cost a beat of latency, never a whole sentence).
  {
    const state = { tts: 0, spoken: [] };
    const oneBlip = (url, o) => {
      if (String(url).indexOf('/api/tts') >= 0) {
        state.tts++;
        if (state.tts === 2) return Promise.resolve({ ok: false, status: 429, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ fallback: true, reason: 'openrouter 429 — rate limited' }) });
        try { state.spoken.push(JSON.parse(o.body).text); } catch (_) {}
        return Promise.resolve({ ok: true, headers: { get: () => 'audio/mpeg' }, blob: () => Promise.resolve({ size: 128 }) });
      }
      return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) });
    };
    const t = boot({ ttsKey: true, fetch: oneBlip });
    t.Voice.setSpeakReplies(true);
    t.Voice.speakChunk('Right, ', 'agent'); await tick(20);
    t.Voice.speakChunk('here is the first full sentence. ', 'agent'); await tick(20);
    t.Voice.endReply(); await tick(80);
    A.ok(state.spoken.some(s => /first full sentence/.test(s)), 'retry: a transient failure is retried once, so the blipped sentence is still spoken');
    A.ok(!/real voice/i.test(String(t.nodes['voice-toggle'].title || '')), 'retry: a blip that the retry rescued does NOT pin an outage banner on the toggle');
  }

  // --- a KEYLESS station: an Edge blip is a BLIP, not a missing credential -----------------------
  // The sidecar prefixes 'no key' structurally whenever the keyed tier has no credential, so on the exact
  // station the free keyless Edge floor exists for, every transient Edge failure arrived as
  // 'no key; edge: <transient>'. The client tested the terminal class FIRST, so: no retry, a 60s
  // dead-voice cold-off instead of 4s, and a tooltip telling the user to buy an API key to fix a network
  // hiccup. The whole transient-failure path was unreachable code on a keyless station.
  {
    const state = { tts: 0 };
    const t = boot({ fetch: countingFetch(state, 'no key; edge: edge timeout') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('first line on a keyless station', 'agent'); await tick(40);
    A.eq(state.tts, 2, 'keyless + edge blip: the transient RETRY fires (2 round-trips, not 1)');
    A.ok(!/needs an OpenRouter, Gemini, or OpenAI credential/.test(String(t.nodes['voice-toggle'].title || '')),
      'keyless + edge blip: the tooltip does NOT demand a credential for a network blip');
    // the SHORT (4s) cold-off, not the 60s billing one → the next reply re-probes
    const afterFirst = state.tts;
    t.Voice.speak('second line while still cold', 'agent'); await tick(40);
    A.eq(state.tts, afterFirst, 'keyless + edge blip: the cold-off is honored while it holds');
    // The ONLY way to tell the 4s transient cool-off from the 60s billing one is to outlast it. The
    // register measured exactly this at t+4.2s; a 60s cold-off leaves the station mute for a full minute.
    await new Promise(r => setTimeout(r, 4200));
    t.Voice.speak('third line after the SHORT cold-off', 'agent'); await tick(40);
    A.ok(state.tts > afterFirst, 'keyless + edge blip: the cool-off was the 4s transient one, not 60s of dead voice');
  }
  // ...while a station that genuinely holds no credential AND no floor still gets the honest terminal copy.
  {
    const state = { tts: 0 };
    const t = boot({ fetch: countingFetch(state, 'no key') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('a line with no key and no floor', 'agent'); await tick(40);
    A.eq(state.tts, 1, 'bare no-key: NOT retried — a missing credential will not fix itself');
    A.ok(/needs an OpenRouter, Gemini, or OpenAI credential/.test(String(t.nodes['voice-toggle'].title || '')),
      'bare no-key: the tooltip names the missing credential');
    t.Voice.speak('a second line while cold', 'agent'); await tick(40);
    A.eq(state.tts, 1, 'bare no-key: the 60s cold-off holds');
  }
  // A per-minute rate limit is not an empty wallet. Gemini answers a 429 with "Quota exceeded for quota
  // metric", which the old /quota/ test read as 'credits' → "out of credits" + 60s of silence.
  {
    const state = { tts: 0 };
    const t = boot({ ttsKey: true, fetch: countingFetch(state, 'gemini 429 — {"message":"Quota exceeded for quota metric"}') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('a line during a rate limit', 'agent'); await tick(40);
    A.ok(!/out of credits/.test(String(t.nodes['voice-toggle'].title || '')), 'a per-minute 429 is NOT reported as "out of credits"');
    A.eq(state.tts, 2, 'a per-minute 429 IS retried');
  }
  // ...but OpenAI's terminal insufficient_quota (also a 429) must stay in the billing class.
  {
    const state = { tts: 0 };
    const t = boot({ ttsKey: true, fetch: countingFetch(state, 'openai 429 — {"code":"insufficient_quota"}') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('a line with a spent account', 'agent'); await tick(40);
    A.ok(/out of credits/.test(String(t.nodes['voice-toggle'].title || '')), 'insufficient_quota IS the billing class, 429 or not');
  }

  // --- the pinned degrade reason survives Voice.init (agent focus / persona / dossier apply) -----
  // init() calls reflectToggle() without clearing fbNotified, and reflectToggle wrote the plain on/off copy
  // over the pinned reason. noteFallback then early-returns for the rest of the outage class, so the station
  // sat silent asserting 'agent voice: ON' with no way to find out why — the 2026-07-07 escape exactly.
  {
    const t = boot({ ttsKey: true, audio: true, fetch: ttsFailFetch('openrouter 402 — insufficient credits') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('a line that cannot be spoken', 'agent'); await tick(40);
    A.ok(/out of credits/.test(String(t.nodes['voice-toggle'].title || '')), 'the degrade reason is pinned on the toggle');
    t.Voice.init({ name: 'Tester', personaId: 'professional' });      // app.js does this on agent focus
    A.ok(/out of credits/.test(String(t.nodes['voice-toggle'].title || '')), 'Voice.init does NOT wipe the pinned reason');
    t.Voice.speak('another line, still failing', 'agent'); await tick(40);
    A.ok(/out of credits/.test(String(t.nodes['voice-toggle'].title || '')), 'and it is still there after further failures');
    // a deliberate speaker toggle still clears it (no latch) — that path calls clearNeuralCold() first
    t.Voice.setSpeakReplies(false); t.Voice.setSpeakReplies(true);
    A.ok(!/out of credits/.test(String(t.nodes['voice-toggle'].title || '')), 'a deliberate speaker toggle still clears the reason (no latch)');
  }

  // --- /api/stt: an UNREACHABLE endpoint is not a CONFIRMED-EMPTY transcript --------------------
  // transcribe() never checked r.ok. rejectBadApiToken answers 403 with plain text BEFORE routing (the
  // documented state after a sidecar respawn), so r.json() threw, the catch yielded {}, and the user's
  // spoken sentence was laundered into '' with NO diagnostic — identical to having said nothing.
  {
    const sttFail = (url) => (String(url).indexOf('/api/stt') >= 0)
      ? Promise.resolve({ ok: false, status: 403, headers: { get: () => 'text/plain' }, json: () => Promise.reject(new SyntaxError('Unexpected token f')) })
      : Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({}), blob: () => Promise.resolve({ size: 1 }) });
    const t = boot({ recorder: true, fetch: sttFail });
    t.Voice.startListening(); await tick(30);
    mrInstances[mrInstances.length - 1].ondataavailable({ data: { size: 1 } });   // some audio got recorded
    t.Voice.stopListening();
    await until(() => /restarted|reload/i.test(String(t.nodes['chat-status'].textContent || '')), 5000);
    A.eq(t.sandbox.__sent.length, 0, 'stt 403: nothing is sent (there is no transcript)');
    A.ok(t.statusLog.some(s => /restarted|reload/i.test(String(s))), 'stt 403: the failure is NAMED, not silently dropped');
    A.ok(/restarted|reload/i.test(String(t.nodes['chat-status'].textContent || '')),
      'stt 403: and the diagnostic SURVIVES endListening\'s same-tick restore (it is actually painted)');
  }
  // the documented 200-degrade envelope keeps working, and its reason is painted too
  {
    const sttDegrade = (url) => (String(url).indexOf('/api/stt') >= 0)
      ? Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: '', reason: 'groq: whisper-large-v3-turbo 500' }) })
      : Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({}), blob: () => Promise.resolve({ size: 1 }) });
    const t = boot({ recorder: true, fetch: sttDegrade });
    t.Voice.startListening(); await tick(30);
    mrInstances[mrInstances.length - 1].ondataavailable({ data: { size: 1 } });
    t.Voice.stopListening();
    await until(() => /whisper-large-v3-turbo 500/.test(String(t.nodes['chat-status'].textContent || '')), 5000);
    A.ok(/whisper-large-v3-turbo 500/.test(String(t.nodes['chat-status'].textContent || '')),
      'stt degrade: the reason is the status the user is left looking at, not a zero-frame flash');
  }
  // a SUCCESSFUL listen is unaffected — no diagnostic, and the transcript is sent
  {
    const t = boot({ recorder: true });
    t.Voice.startListening(); await tick(30);
    mrInstances[mrInstances.length - 1].ondataavailable({ data: { size: 1 } });
    t.Voice.stopListening();
    await until(() => t.sandbox.__sent.length === 1, 5000);
    A.eq(t.sandbox.__sent.length, 1, 'a successful listen still sends the transcript');
    A.ok(!/unreachable|restarted/i.test(String(t.nodes['chat-status'].textContent || '')), 'and leaves no diagnostic behind');
  }

  // --- muting the speaker MID-REPLY in hands-free must not wedge the mic shut --------------------
  // stopSpeaking() nulls onReplyDone, and after chat.js's onTurnEnd() has already bailed (audio still
  // draining) that callback is the ONLY surviving rearm trigger. Muting mid-reply discarded it, so the mic
  // never re-opened while the mode button still read 'hands-free ON'.
  {
    // A reply is DRAINING for as long as a queued chunk has not resolved, so a /api/tts that never answers
    // holds the exact state the bug needs: onTurnEnd lands, sees talking(), and correctly bails.
    const hangTts = (url) => (String(url).indexOf('/api/tts') >= 0)
      ? new Promise(() => {})
      : Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) });
    const drive = async (mute) => {
      const t = boot({ recorder: true, ttsKey: true, fetch: hangTts });
      t.sandbox.__busy = true;                                   // the agent's turn is running → the loop is parked
      t.Voice.toggleVoiceMode(); await tick(60);
      A.ok(t.Voice.inVoiceMode(), 'hands-free is on');
      A.ok(!t.Voice.isListening(), 'the mic is parked while the agent works');
      t.Voice.speakChunk('The answer is ', 'agent'); await tick(20);   // draining = true; the synth never resolves
      t.Voice.endReply();
      t.sandbox.__busy = false;                                  // run teardown...
      t.Voice.onTurnEnd();                                       // ...and chat.js's rearm trigger fires HERE,
      await tick(200);                                           //    while audio is still draining, so it bails
      A.ok(!t.Voice.isListening(), 'onTurnEnd alone does NOT re-open the mic mid-reply (by design)');
      if (mute) t.Voice.setSpeakReplies(false);                   // the user mutes 🔊 mid-reply
      // The rig time-compresses the 30s hard cap to 20ms, so a re-opened listen closes again almost at once.
      // Poll for the OPEN rather than sampling one instant, or the assertion measures scheduling luck.
      const opened = await opensWithin(t, 4000);
      return { t, opened };
    };
    // Control: with no mute the reply is still draining, so the mic legitimately stays shut — this is what
    // proves the assertion below is measuring the MUTE and not some other rearm path.
    const baseline = await drive(false);
    A.eq(baseline.opened, false, 'control: with the reply still draining the mic NEVER re-opens');
    const muted = await drive(true);
    A.ok(muted.t.Voice.inVoiceMode(), 'still in hands-free after the mute');
    A.eq(muted.opened, true, 'the mic RE-OPENS after muting mid-reply (no wedge)');
  }

  A.report('voice.button.test');
})().catch(e => { console.log('FAIL: harness threw — ' + (e && e.stack || e)); process.exit(1); });
