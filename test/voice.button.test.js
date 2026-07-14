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
    requestAnimationFrame: cb => st(() => cb(Date.now()), 16), cancelAnimationFrame: clearTimeout,
    setTimeout: st, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {} },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    AbortController,   // neural-TTS synth uses one per request to allow barge-in cancel
    Blob: class { constructor(parts, o) { this.size = (parts && parts.length) ? 1 : 0; this.type = (o && o.type) || ''; } },
    fetch: opts.fetch || (() => Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) })),
    Chat: { isBusy: () => sandbox.__busy, status: s => { statusLog.push(s); nodes['chat-status'].textContent = s; }, send: t => sandbox.__sent.push(t), autoGrowInput() {} },
    SFX: { open() {}, click() {}, think() {}, boot() {} },
    Personas: { DEFAULT_ID: 'professional', get: () => ({ ttsVoice: 'Umbriel', ttsSpeed: 1 }) },
    Harness: { getKey: () => (opts.ttsKey ? 'k' : ''), configured: () => false },
    __busy: false, __sent: []
  };
  sandbox.globalThis = sandbox; win.SpeechRecognition = MockSR; win.speechSynthesis = undefined;
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

const tick = (n = 12) => new Promise(r => setTimeout(r, n));

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

  A.report('voice.button.test');
})().catch(e => { console.log('FAIL: harness threw — ' + (e && e.stack || e)); process.exit(1); });
