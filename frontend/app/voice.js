/* SKYNET — voice.js : two-way voice for the COMMS panel.

   INPUT  (push-to-talk): a mic button transcribes your speech and feeds the text
          straight through Chat.send — identical to typing — so all of chat.js's
          busy / purpose / task-vs-talk logic is reused with zero duplication.
   OUTPUT (agent voice): when an agent speaks a conversational reply (the same moment
          it shows a speech bubble via World.say), it is spoken ALOUD with a per-agent
          voice identity — distinct, stable pitch/rate/voice derived from the agent's
          name, so every crew member sounds like itself.

   STT is the browser-native SpeechRecognition (push-to-talk + the hands-free loop).
   TTS goes through output(): it first tries NEURAL voices via the sidecar /api/tts
   (OpenRouter /audio/speech, using the same OpenRouter key the browser already sends to
   /api/run — a distinct Gemini voice per personality), and falls back to the browser's
   speechSynthesis on no-key / error / offline — so the worst case is the old robotic voice,
   never silence. Per-personality voice + speed live on the persona (personas.js: ttsVoice/ttsSpeed).

   Graceful degradation: no SpeechRecognition → the mic button hides; no neural key AND no
   speechSynthesis → speak() is a no-op (the reply still shows as text + a room bubble). */
'use strict';

const Voice = (() => {
  const el = id => document.getElementById(id);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const synth = ('speechSynthesis' in window) ? window.speechSynthesis : null;
  const LS_SPEAK = 'skynet.voice.speak';
  const LS_CONVO = 'skynet.voice.convo';   // remembers the user WAS hands-free, so a refresh can offer one-tap resume
  const REARM_DELAY = 350;                 // ms after the agent stops talking before the mic re-opens (echo guard)
  const MAX_EMPTY = 3;                      // consecutive silent listens before the loop goes passive

  // Phosphor line-icons for the voice controls — single-color (currentColor) so they inherit the active
  // theme's phosphor tint + glow, matching the terminal UI instead of the off-brand OS color emoji.
  // Swapped by reflect*()/init below.
  const ICON = {
    mic: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.6" y="1.6" width="4.8" height="8" rx="2.4" fill="currentColor"/><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3.6 7.4a4.4 4.4 0 0 0 8.8 0"/><path d="M8 11.8v2.6"/><path d="M5.5 14.4h5"/></g></svg>',
    spkOn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2L8 3.2v9.6L4.5 10h-2z" fill="currentColor"/><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M10.4 6.3a2.7 2.7 0 0 1 0 3.4"/><path d="M12.1 4.7a5 5 0 0 1 0 6.6"/></g></svg>',
    spkOff: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2L8 3.2v9.6L4.5 10h-2z" fill="currentColor"/><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M10.9 6.3 13.5 8.9"/><path d="M13.5 6.3 10.9 8.9"/></g></svg>',
    modePtt: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 3.4H13.4V10H7L4 12.6V10H2.6Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><g fill="currentColor"><circle cx="5.5" cy="6.7" r=".85"/><circle cx="8" cy="6.7" r=".85"/><circle cx="10.5" cy="6.7" r=".85"/></g></svg>',
    modeLive: '<svg viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 6.5v3"/><path d="M6.33 4v8"/><path d="M9.67 5.5v5"/><path d="M13 6.8v2.4"/></g></svg>'
  };

  const canListen = () => !!SR;
  const canSpeak = () => !!synth;

  // ---- prefs --------------------------------------------------------------
  let speakReplies = loadPref(LS_SPEAK, true);   // do agents speak their replies aloud? (persisted)
  let convoMode = false;     // hands-free loop — a per-session mode (each game starts in push-to-talk)
  function loadPref(k, dflt) { try { const v = localStorage.getItem(k); return v == null ? dflt : v === '1'; } catch (_) { return dflt; } }
  function savePref(k, on) { try { localStorage.setItem(k, on ? '1' : '0'); } catch (_) {} }

  // ---- UI handles (wired in init) -----------------------------------------
  let micBtn = null, toggleBtn = null, modeBtn = null, inputEl = null, statusEl = null;
  let activeVoiceId = 'agent';      // identity used to pick the current agent's voice
  let activePersonaId = 'worker-homie';   // drives the in-character task acknowledgments
  let listening = false, speaking = false, savedStatus = '';
  // hands-free loop bookkeeping
  let rearmTimer = null;            // pending mic re-open
  let emptyStreak = 0;              // silent listens in a row (→ go passive instead of looping forever)
  let sentThisListen = false;       // did the just-finished listen actually send a message?
  let discarding = false;           // teardown in progress → drop any buffered transcript (don't send)
  let forcedSpeak = false;          // voice mode flipped the speaker on for us → restore the user's mute on exit
  let resumePending = false;        // a refresh dropped hands-free → the mode button pulses to invite one-tap resume

  // a single status seam: prefer Chat.status (it owns #chat-status), fall back to the DOM node.
  function setStatus(s) {
    if (typeof Chat !== 'undefined' && Chat.status) Chat.status(s);
    else if (statusEl) statusEl.textContent = s;
  }
  function currentStatusText() { return statusEl ? statusEl.textContent : ''; }

  /* ======================================================================
     OUTPUT — the agent's voice (TTS)
     ====================================================================== */

  // speechSynthesis.getVoices() populates asynchronously; cache it and refresh on voiceschanged.
  let voiceCache = [];
  function refreshVoices() { if (synth) { try { voiceCache = synth.getVoices() || []; } catch (_) { voiceCache = []; } } }
  if (synth) { refreshVoices(); try { synth.onvoiceschanged = refreshVoices; } catch (_) {} }

  // --- Chrome speechSynthesis self-healing -------------------------------------------------
  // Chrome has two long-standing TTS bugs this app trips over:
  //  (a) after SpeechRecognition (the mic) has run, the synth engine is left paused/idle and
  //      synth.speak() silently does nothing until synth.resume() is called. startListening()
  //      also calls synth.cancel(), which on some builds wedges the queue the same way. This is
  //      why voice works on turn 1 (no mic yet) but goes silent on every later mic-driven turn.
  //  (b) the engine auto-pauses on utterances longer than ~15s; resume() un-sticks it.
  // Fix: kick resume() right before/after speak, and run a low-frequency watchdog that resumes
  // the engine whenever it reports paused while something is pending. Cheap, idempotent, no-op
  // in Firefox/Safari (resume() there is harmless).
  function kickResume() { if (synth) { try { synth.resume(); } catch (_) {} } }
  let watchdog = null;
  function startWatchdog() {
    if (watchdog || !synth) return;
    watchdog = setInterval(() => {
      try {
        if (synth.paused && (synth.speaking || synth.pending)) synth.resume();
        else if (!synth.speaking && !synth.pending) { clearInterval(watchdog); watchdog = null; }
      } catch (_) { clearInterval(watchdog); watchdog = null; }
    }, 4000);
  }

  // FNV-1a — a stable, dependency-free string hash so an agent's voice never changes between sessions.
  function hash(s) { let h = 2166136261 >>> 0; s = String(s || 'agent'); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  // derive a distinct-but-stable voice for an identity: pick from the installed voices and
  // spread pitch/rate deterministically so even agents sharing a base voice sound different.
  function voiceFor(id) {
    const h = hash(id);
    const all = voiceCache.length ? voiceCache : (refreshVoices(), voiceCache);
    const en = all.filter(v => /^en[-_]/i.test(v.lang || ''));
    const pool = en.length ? en : all;
    const voice = pool.length ? pool[h % pool.length] : null;
    const pitch = 0.8 + ((h >>> 3) % 9) * 0.05;    // 0.80 .. 1.20
    const rate = 0.9 + ((h >>> 7) % 7) * 0.05;     // 0.90 .. 1.20
    return { voice, pitch, rate };
  }

  function onSpeakStart() { speaking = true; setSpeaking(true); duckSfx(true); }
  function onSpeakEnd() { if (!speaking) return; speaking = false; setSpeaking(false); }

  /* ---- web-speech (browser) FALLBACK -----------------------------------------------------------
     The built-in speechSynthesis voices, used when neural TTS has no key / errors / is offline.
     opts: { volume, speedMul }. */
  function doSpeak(text, id, onEnd, opts) {
    opts = opts || {};
    if (!synth) { onSpeakEnd(); onEnd && onEnd(); return; }
    kickResume();
    try { if (synth.speaking || synth.pending) synth.cancel(); } catch (_) {}
    const u = new SpeechSynthesisUtterance(text);
    const v = voiceFor(id);
    if (v.voice) u.voice = v.voice;
    u.pitch = v.pitch;
    u.rate = Math.max(0.6, Math.min(1.6, v.rate * (opts.speedMul || 1)));
    u.volume = (opts.volume == null ? 1 : opts.volume);
    u.onstart = () => onSpeakStart();
    u.onend = () => { onSpeakEnd(); onEnd && onEnd(); };
    u.onerror = () => { onSpeakEnd(); onEnd && onEnd(); };
    try { synth.speak(u); kickResume(); startWatchdog(); }
    catch (_) { onSpeakEnd(); onEnd && onEnd(); }
  }
  function webSpeechSpeak(text, id, onEnd, opts) {
    if (!synth) { onSpeakEnd(); onEnd && onEnd(); return; }
    if (!voiceCache.length) {
      refreshVoices();
      if (!voiceCache.length) {
        let fired = false;
        const go = () => { if (fired) return; fired = true; refreshVoices(); doSpeak(text, id, onEnd, opts); };
        try { synth.addEventListener('voiceschanged', go, { once: true }); } catch (_) {}
        setTimeout(go, 250);   // hard fallback if voiceschanged never fires
        return;
      }
    }
    doSpeak(text, id, onEnd, opts);
  }

  /* ---- neural TTS via OpenRouter — the agent's real per-personality voice ----------------------
     Hits the sidecar /api/tts (which calls OpenRouter /audio/speech with the SAME OpenRouter key the
     browser already uses) and plays the returned mp3. Any failure (no key / error / offline) falls
     straight back to the browser voice, so the worst case is exactly the Phase-1 behavior. */
  const TTS_MODEL = 'google/gemini-3.1-flash-tts-preview';
  let ttsDisabled = false;        // latched once we learn there's no usable key — skip the round-trip after that
  let neuralColdUntil = 0;        // after a transient neural error, prefer the browser voice until this time (ms)
  function apiKey() { return (typeof Harness !== 'undefined' && Harness.getKey) ? (Harness.getKey() || '') : ''; }
  function ttsConfig() {
    const p = (typeof Personas !== 'undefined' && Personas.get) ? Personas.get(activePersonaId) : null;
    return { model: TTS_MODEL, voice: (p && p.ttsVoice) || 'Umbriel', speed: (p && p.ttsSpeed) || 1.0 };
  }

  /* text → speakable: strip what TTS would otherwise read LITERALLY (markdown, emoji, URLs/paths, and
     ALL-CAPS names it'd spell out letter-by-letter). VOICE_MODE_RULES only ASKS the model to avoid these;
     this is the enforcement the prompt can't guarantee. Pure + cheap; runs on every spoken line. */
  function speakable(s) {
    s = String(s || '');
    s = s.replace(/```[\s\S]*?```/g, ' ');                          // code fences
    s = s.replace(/`([^`]+)`/g, '$1');                              // inline code
    s = s.replace(/!?\[([^\]]*)\]\(([^)]+)\)/g, '$1');              // [label](url) / ![alt](url) → label
    s = s.replace(/https?:\/\/\S+/g, 'a link');                     // bare URLs
    s = s.replace(/(^|\s)[~.]?[\/\\][\w./\\-]+/g, '$1that file');   // file paths → "that file"
    s = s.replace(/^#{1,6}\s*/gm, '');                              // headers
    s = s.replace(/^\s*[-*+]\s+/gm, '');                            // bullet markers
    s = s.replace(/^\s*\d+\.\s+/gm, '');                            // numbered-list markers
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/_([^_]+)_/g, '$1'); // emphasis
    s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/gu, ' '); // emoji/arrows
    s = s.replace(/\b([A-Z]{4,})\b/g, m => m[0] + m.slice(1).toLowerCase()); // ULTRON → Ultron (keep AI/OK/API)
    return s.replace(/\s+/g, ' ').trim();
  }

  /* duck the game SFX while the agent talks so its voice isn't fought by station blips. SFX.vol is a
     plain master multiplier; save it once on the first chunk and restore when the WHOLE reply ends
     (not per-chunk, so the bed doesn't pump between sentences). Idempotent + try/guarded. */
  let _duckSaved = null;
  function duckSfx(on) {
    try {
      if (typeof SFX === 'undefined') return;
      if (on) { if (_duckSaved == null) { _duckSaved = SFX.vol; SFX.vol = SFX.vol * 0.28; } }
      else if (_duckSaved != null) { SFX.vol = _duckSaved; _duckSaved = null; }
    } catch (_) {}
  }

  /* split one utterance that's too long for a single synth call, keeping each piece under the sidecar's
     1200-char cap — so a long reply is spoken IN FULL instead of guillotined mid-word. */
  function splitForTts(t, max) {
    if (t.length <= max) return [t];
    const out = [], parts = t.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) || [t];
    let cur = '';
    for (const p of parts) {
      let s = p;
      while (s.length > max) { out.push(s.slice(0, max).trim()); s = s.slice(max); }
      if ((cur + s).length > max) { if (cur.trim()) out.push(cur.trim()); cur = s; } else cur += s;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  let currentAudio = null;
  function stopAudio() { if (currentAudio) { try { currentAudio.pause(); } catch (_) {} currentAudio = null; } }
  // play an audio blob (mp3/wav), wiring start/end into the same speaking-state + loop hooks as the
  // browser path. playbackRate gives the per-personality pacing (Gemini TTS takes no speed param).
  function playBlob(blob, onEnd, volume, onFail, rate) {
    let url = null, a = null, done = false;
    const cleanup = () => { if (url) { try { URL.revokeObjectURL(url); } catch (_) {} } if (currentAudio === a) currentAudio = null; };
    const endOk = () => { if (done) return; done = true; cleanup(); onSpeakEnd(); onEnd && onEnd(); };
    try {
      stopAudio();
      url = URL.createObjectURL(blob);
      a = new Audio(url); currentAudio = a;
      a.volume = (volume == null ? 1 : volume);
      if (rate && rate > 0) a.playbackRate = Math.max(0.5, Math.min(2, rate));
      a.onplay = () => onSpeakStart();
      a.onended = endOk;
      // a decode/format error on the neural blob is exactly the "try the browser voice" case — route
      // it to onFail (fallback) rather than treating it as a clean finish (which would go SILENT).
      a.onerror = () => { if (done) return; done = true; cleanup(); onFail ? onFail() : (onSpeakEnd(), onEnd && onEnd()); };
      const p = a.play();
      if (p && p.catch) p.catch(err => {
        if (done) return; done = true; cleanup();
        // browser still blocking audio (no gesture yet) → tell the user instead of going silently quiet
        if (err && err.name === 'NotAllowedError') setStatus('🔇 tap anywhere to turn on the agent\'s voice');
        onFail ? onFail() : endOk();
      });
    } catch (_) { cleanup(); onFail ? onFail() : (onSpeakEnd(), onEnd && onEnd()); }
  }

  /* Browsers block programmatic <audio> playback until the page has had a user gesture — so right after a
     hard refresh the agent's FIRST spoken reply can come back SILENT (the audio plays seconds after you
     typed, not tied to that gesture). Unlock the audio path on the first gesture with a muted, valid silent
     WAV play, so the neural voice always plays. Idempotent; runs exactly once. */
  let audioArmed = false;
  function silentWav() {
    const n = 8, b = new ArrayBuffer(44 + n), v = new DataView(b);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
    v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);   // unsigned-8-bit silence
    return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  }
  function armAudio() {
    if (audioArmed) return; audioArmed = true;
    try { const u = silentWav(); const a = new Audio(u); a.volume = 0; const p = a.play(); if (p && p.catch) p.catch(() => {}); setTimeout(() => { try { URL.revokeObjectURL(u); } catch (_) {} }, 1000); } catch (_) {}
    try { if (typeof SFX !== 'undefined' && SFX.boot) SFX.boot(); } catch (_) {}   // also resume the SFX audio context
  }

  /* ======================================================================
     SPEAK QUEUE — stream the reply sentence-by-sentence so the FIRST words play while the rest is still
     being generated/synthesized (kills the multi-second "dead air" before the agent talks). Chunks are
     synthesized one-ahead but ALWAYS played in order. `draining` stays true across the whole queue AND
     every fetch gap, so the hands-free mic can't re-open into the agent's own voice (echo). Bumping
     `speakSeq` (barge-in / teardown) invalidates every in-flight fetch + queued playback at once. */
  let jobs = [];          // queued chunks: { text, opts, seq, result(Promise), ac(AbortController) }
  let playIdx = 0;        // next job to PLAY
  let synthIdx = 0;       // next job to begin SYNTHESIZING (runs ahead of playIdx for prefetch)
  let draining = false;   // a reply is in progress (queue non-empty or awaiting more chunks)
  let replyClosed = true; // producer has signalled "no more chunks for this reply"
  let playing = false;    // a chunk is currently playing (serializes playback)
  let speakSeq = 0;       // monotonic token; bump to invalidate all in-flight speak work
  let ttsAbort = null;    // controller of the most-recent in-flight fetch
  let onReplyDone = null; // heartbeat fired ONCE when the whole reply finishes (→ maybeRearm)
  let lastAudioPath = 'neural';  // 'neural' (stops synchronously) | 'synth' (messier cancel tail)
  const MAX_INFLIGHT = 2;        // synth at most this many chunks ahead of playback
  const TTS_CHUNK_MAX = 1000;    // keep each synth call under the sidecar's 1200-char cap

  function resetQueue() { jobs = []; playIdx = 0; synthIdx = 0; draining = false; playing = false; replyClosed = true; }

  // begin synthesizing one job → resolves to {kind:'neural',blob} | {kind:'browser'} | {kind:'skip'}.
  function startSynth(job) {
    if (job.result) return;
    const key = apiKey(), cfg = ttsConfig();
    if (!key || ttsDisabled || Date.now() < neuralColdUntil) { job.result = Promise.resolve({ kind: 'browser' }); return; }
    const ac = new AbortController(); job.ac = ac; ttsAbort = ac;
    job.result = fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({ key, text: job.text, model: cfg.model, voice: cfg.voice })
    }).then(async r => {
      const ct = r.headers.get('Content-Type') || '';
      if (r.ok && ct.indexOf('audio') === 0) { const blob = await r.blob(); if (blob && blob.size) return { kind: 'neural', blob }; }
      let reason = 'http ' + r.status;
      try { const j = await r.json(); if (j && j.reason) reason = j.reason; } catch (_) {}
      if (/no key/i.test(reason)) ttsDisabled = true; else neuralColdUntil = Date.now() + 8000;
      console.warn('[voice] neural TTS → browser fallback:', reason);
      return { kind: 'browser' };
    }).catch(e => {
      if (e && e.name === 'AbortError') return { kind: 'skip' };   // intentionally cancelled — stay silent
      console.warn('[voice] neural TTS error:', (e && e.message) || e);
      neuralColdUntil = Date.now() + 8000;
      return { kind: 'browser' };
    });
  }
  function pumpSynth() { while (synthIdx < jobs.length && (synthIdx - playIdx) < MAX_INFLIGHT) startSynth(jobs[synthIdx++]); }

  function pumpPlay() {
    if (playing) return;
    if (playIdx >= jobs.length) { if (replyClosed && synthIdx >= jobs.length) finishReply(); return; }
    const job = jobs[playIdx];
    if (!job.result) { startSynth(job); if (synthIdx <= playIdx) synthIdx = playIdx + 1; }
    playing = true;
    pumpSynth();   // keep the prefetch window full while this chunk plays
    job.result.then(res => {
      if (job.seq !== speakSeq) { playing = false; return; }   // torn down → stop the loop
      const advance = () => { playing = false; playIdx++; pumpPlay(); };
      if (res.kind === 'neural') {
        lastAudioPath = 'neural';
        const rate = ttsConfig().speed * (job.opts.speedMul || 1);
        playBlob(res.blob, advance, job.opts.volume, () => browserPlay(job, advance), rate);
      } else if (res.kind === 'browser') {
        browserPlay(job, advance);
      } else { advance(); }   // 'skip' (aborted)
    });
  }
  // browser-synth fallback — fold the persona's pace into the rate so even the OS voice tracks the personality.
  function browserPlay(job, advance) {
    lastAudioPath = 'synth';
    const opts = Object.assign({}, job.opts, { speedMul: (job.opts.speedMul || 1) * ttsConfig().speed });
    webSpeechSpeak(job.text, activeVoiceId, advance, opts);
  }
  function finishReply() {
    const wasDraining = draining;
    resetQueue();
    duckSfx(false);
    if (wasDraining) { const cb = onReplyDone; onReplyDone = null; if (cb) cb(); }
  }

  /* ---- PRODUCER API ---- */
  // push one chunk of an in-progress reply (chat.js streams these sentence-by-sentence). The first chunk
  // opens a reply; endReply() closes it. mutter() rides the same path as a one-shot quiet aside.
  function speakChunk(text, voiceId, opts) {
    if (!speakReplies) return;
    if (voiceId) activeVoiceId = voiceId;
    opts = opts || {};
    const clean = speakable(text);
    const body = opts.mutter ? clean.slice(0, 80) : clean;
    if (!body.trim()) return;
    replyClosed = false; draining = true;
    for (const seg of splitForTts(body, TTS_CHUNK_MAX)) jobs.push({ text: seg, opts, seq: speakSeq, result: null, ac: null });
    pumpSynth(); pumpPlay();
  }
  // signal end-of-reply; the heartbeat (default: re-arm the hands-free loop) fires once the LAST chunk ends.
  function endReply(onDone) {
    onReplyDone = onDone || onReplyEnded;
    replyClosed = true;
    if (!draining && jobs.length === 0) { const cb = onReplyDone; onReplyDone = null; if (cb) cb(); return; }
    pumpPlay();
  }
  // public one-shot (non-streaming callers): speak a whole finished reply.
  function speak(text, voiceId) { speakChunk(text, voiceId); endReply(onReplyEnded); }

  // tear everything down NOW: invalidate in-flight work, abort fetches, cut audio, kill the watchdog.
  // Used by barge-in, mute, voice-mode-off, and DISCONNECT — the agent must go silent immediately.
  function stopSpeaking() {
    speakSeq++;
    for (const j of jobs) { if (j.ac) { try { j.ac.abort(); } catch (_) {} } }
    if (ttsAbort) { try { ttsAbort.abort(); } catch (_) {} ttsAbort = null; }
    stopAudio();
    if (synth) { try { if (synth.speaking || synth.pending) synth.cancel(); } catch (_) {} kickResume(); }
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    onReplyDone = null;
    resetQueue();
    duckSfx(false);
    onSpeakEnd();
  }

  // an ambient, muttered aside — station-life flavor (from world.js curiosity remarks), in the agent's
  // own voice but quieter + slower so it reads as talking to itself. It stays silent during any live
  // exchange (incl. an open hands-free loop) so it can't collide with conversation or feed the open mic;
  // re-arming on end covers "voice mode toggled on mid-mutter" so the loop never hangs.
  function mutter(text) {
    if (!speakReplies) return;
    if (convoMode || speaking || draining || currentAudio || listening || rearmTimer || busyNow()) return;
    const t = String(text || '').trim();
    if (!t) return;
    speakChunk(t, activeVoiceId, { volume: 0.5, speedMul: 0.88, mutter: true });
    endReply(maybeRearm);
  }

  // pick an in-character ambient line for the active persona (so the gremlin and the old-salt don't both
  // mutter a flat "noted."). Falls back to the generic pool. world.js uses the SAME returned line for the
  // bubble AND the spoken aside, so caption and voice always match.
  function ambientLine(fallback) {
    try {
      const p = (typeof Personas !== 'undefined' && Personas.get) ? Personas.get(activePersonaId) : null;
      if (p && p.ambientLines && p.ambientLines.length && Math.random() < 0.65) return p.ambientLines[(Math.random() * p.ambientLines.length) | 0];
    } catch (_) {}
    return (fallback && fallback.length) ? fallback[(Math.random() * fallback.length) | 0] : '';
  }

  /* ======================================================================
     HANDS-FREE VOICE MODE — the self-driving listen → send → speak → listen loop
     ====================================================================== */

  // the agent finished speaking a reply → try to re-open the mic (no-op unless in voice mode).
  function onReplyEnded() { maybeRearm(); }
  // a run fully finished (called from chat.js's finally — covers task turns that never spoke).
  function onTurnEnd() { maybeRearm(); }

  // re-open the mic once the turn is genuinely done: not in a run, not still speaking, not already
  // listening. Whichever finishing event (TTS end / run end) lands last is the one that arms it.
  // NB: a reply is enqueued via synth.speak() before its `onstart` fires, so chat.js's run-end hook
  // can land while `speaking` is still false but the utterance is queued. We must also treat a
  // pending/speaking synth queue as "not done" — otherwise the mic would re-open into the agent's
  // own voice (echo) or cancel the not-yet-started reply (swallow). onReplyEnded then arms it.
  // "is the agent making (or about to make) sound?" — covers the browser synth queue, a playing neural
  // audio element, AND the gap while a neural request is in flight (pendingSpeech). The loop must wait
  // through all of it, or the re-opened mic would capture the agent's own voice (echo).
  // "is the agent making (or about to make) sound?" — `draining` covers the whole streamed reply incl.
  // every inter-chunk fetch gap, so the loop waits through all of it (no echo, no swallowed chunk).
  function talking() { return draining || playing || !!currentAudio || !!(synth && (synth.speaking || synth.pending)); }
  function maybeRearm() {
    if (!convoMode || !SR || rearmTimer) return;
    if (busyNow() || listening || talking()) return;   // not ready — a finishing event re-calls this
    const delay = (lastAudioPath === 'synth') ? REARM_DELAY : 150;   // neural <audio> stops cleanly → shorter guard
    rearmTimer = setTimeout(() => {
      rearmTimer = null;
      if (convoMode && !busyNow() && !listening && !talking()) startListening();
    }, delay);
  }

  // turn hands-free on/off. ON jumps straight into listening; agents must be audible to converse,
  // so it also flips the speaker on. OFF tears the loop down.
  function toggleVoiceMode() {
    if (!SR) return;
    clearResumeCue();
    convoMode = !convoMode;
    if (typeof SFX !== 'undefined') SFX.open();
    if (convoMode) {
      savePref(LS_CONVO, true);   // remember the hands-free intent so a refresh can offer one-tap resume
      if (!speakReplies) { speakReplies = true; savePref(LS_SPEAK, true); forcedSpeak = true; reflectToggle(); }  // you have to hear it (restored on exit)
      emptyStreak = 0;
      reflectMode();
      if (!busyNow() && !listening && !speaking) startListening();
      else setStatus('voice mode on');
    } else {
      savePref(LS_CONVO, false);   // deliberate exit — don't nag to resume next session
      stopConvo();
    }
  }

  // fully stop the loop (toggle off, DISCONNECT, teardown).
  function stopConvo() {
    const was = convoMode;
    convoMode = false;
    clearTimeout(rearmTimer); rearmTimer = null;
    // tear down WITHOUT sending a half-spoken utterance: abort() suppresses the final result, and the
    // discarding flag drops it even if a final already arrived (else turning off mid-sentence, or a
    // DISCONNECT, would fire the buffered words at the agent as a brand-new run).
    if (listening) { discarding = true; sttProvider.abort(); }
    stopSpeaking();
    // restore the speaker mute that voice-mode-on force-flipped — don't let a transient mode permanently
    // clobber a deliberate preference (only if the user didn't manually re-touch the speaker meanwhile).
    if (forcedSpeak) { forcedSpeak = false; speakReplies = false; savePref(LS_SPEAK, false); reflectToggle(); }
    reflectMode();
    if (was && !busyNow()) setStatus('online');
  }

  // a silent listen in voice mode: try again a few times, then go passive so the mic isn't hot forever.
  function handleEmptyListen() {
    emptyStreak++;
    if (emptyStreak >= MAX_EMPTY) { emptyStreak = 0; setStatus('voice mode — tap 🎤 when ready'); return; }
    maybeRearm();
  }

  /* ======================================================================
     INPUT — speak to your agent (STT)
     ====================================================================== */

  let rec = null;
  // the STT provider seam — Phase 2 swaps this for record→Whisper. start(cbs) opens a stream;
  // callbacks: onInterim(partial), onFinal(text), onEnd(), onError(msg).
  const sttProvider = {
    name: 'web-speech',
    start(cbs) {
      if (!SR) { cbs.onError && cbs.onError('unsupported'); return; }
      rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.continuous = false;     // one utterance per push-to-talk press; auto-stops on a pause
      rec.maxAlternatives = 1;
      let finalText = '';
      rec.onresult = e => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        cbs.onInterim && cbs.onInterim((finalText + interim).trim());
      };
      rec.onerror = e => { cbs.onError && cbs.onError(e.error || 'error'); };
      rec.onend = () => { cbs.onFinal && cbs.onFinal(finalText.trim()); cbs.onEnd && cbs.onEnd(); rec = null; };
      try { rec.start(); } catch (_) { cbs.onError && cbs.onError('start-failed'); rec = null; }
    },
    stop() { if (rec) { try { rec.stop(); } catch (_) {} } },          // flush + deliver the final result (push-to-talk send)
    abort() { if (rec) { try { rec.abort(); } catch (_) {} } }          // hard stop, suppress the final result (teardown)
  };

  function busyNow() { return typeof Chat !== 'undefined' && Chat.isBusy && Chat.isBusy(); }

  function startListening() {
    if (!SR || listening) return;
    if (busyNow()) { setStatus('busy — wait for the reply'); return; }  // don't talk over a live run
    clearTimeout(rearmTimer); rearmTimer = null;
    stopSpeaking();                       // don't let the agent's voice bleed into the mic
    listening = true; sentThisListen = false; discarding = false; setMicState(true);
    savedStatus = currentStatusText();
    setStatus(convoMode ? 'voice mode — listening…' : 'listening…');
    if (typeof SFX !== 'undefined') SFX.open();
    sttProvider.start({
      onInterim: t => { if (inputEl) inputEl.value = t; },
      onFinal: text => { submitTranscript(text); },
      onError: msg => {
        // a DENIED mic is a hard stop, not a recoverable hiccup: don't silently retry/re-arm into a mic
        // that can never open — drop hands-free and tell the user the real problem + how to fix it.
        if (msg === 'not-allowed' || msg === 'service-not-allowed') {
          listening = false; setMicState(false);
          clearTimeout(rearmTimer); rearmTimer = null;
          stopConvo();
          setStatus('mic blocked — allow microphone access in your browser, then click 🎤');
          return;
        }
        endListening();
        if (msg !== 'no-speech' && msg !== 'aborted') setStatus('mic: ' + msg);
      },
      onEnd: () => { endListening(); }
    });
  }

  function stopListening() { if (listening) sttProvider.stop(); }   // onend → onFinal handles the rest

  function endListening() {
    if (!listening) return;
    listening = false; setMicState(false);
    if (discarding) { discarding = false; return; }   // teardown — no retry, no rearm, no status churn
    // hands-free: if this listen heard nothing, keep the loop alive (retry, then go passive).
    if (convoMode && !sentThisListen && !busyNow() && !speaking) { handleEmptyListen(); return; }
    // otherwise restore whatever status was showing before we grabbed the mic (a send already set
    // 'thinking…'/'working…' via Chat, so this only fires for a plain idle stop).
    if (!busyNow() && !speaking) setStatus(savedStatus || (convoMode ? 'voice mode on' : 'online'));
  }

  // a final transcript from the mic — sent exactly like a typed message (busy/purpose/task/cost logic
  // is reused). The agent's spoken reply is driven by the 🔊 toggle in chat.js, not by this path.
  function submitTranscript(text) {
    if (discarding) return;   // teardown in progress — drop the buffered transcript, never send it
    const t = String(text || '').trim();
    if (inputEl) inputEl.value = '';
    if (!t) return;   // heard nothing — endListening() handles the hands-free retry
    // spoken exit: leave voice mode by voice. Loosened so STT variants land ("stop the voice mode",
    // "turn off voice mode please") while still needing an explicit verb + the word "voice".
    const norm = t.toLowerCase().replace(/[.!,?\s]+$/, '');
    // drop a small closed set of polite lead-ins so "okay, stop voice mode" / "can you turn off voice mode"
    // still match, then require an explicit verb DIRECTLY on "voice mode" — so a normal request that merely
    // mentions "voice" ("stop using that formal voice") no longer tears the session down by accident.
    const cmd = norm.replace(/^(?:ok(?:ay)?|hey|um|uh|so|please|yeah|now|can you|could you|would you|i want to|i'd like to|let'?s)[,\s]+/, '').trim();
    if (convoMode && (/^(?:exit|stop|end|leave|quit|turn off)\s+(?:the\s+|this\s+)?voice\s*mode\b/.test(cmd)
                      || /^(?:exit|leave)\s+(?:the\s+|this\s+)?voice\b/.test(cmd))) { savePref(LS_CONVO, false); stopConvo(); return; }
    sentThisListen = true; emptyStreak = 0;
    // a dedicated "got it" cue (not the generic send click) so the user knows their words landed —
    // closes the perceived gap until the agent's first spoken word.
    if (typeof SFX !== 'undefined') (SFX.think || SFX.click)();
    if (typeof Chat !== 'undefined' && Chat.send) Chat.send(t);
  }

  // mic button: interrupt the agent if it's talking (barge-in), else start/stop a listen. In voice
  // mode the loop manages re-opening; clicking just lets you jump in (or resume from passive).
  function onMicClick() {
    if (!SR) return;
    clearResumeCue();
    // barge-in: interrupt whenever the agent is making OR about to make sound (talking() also covers the
    // neural-fetch gap, where `speaking` is still false but a reply is imminent) — stopSpeaking aborts it.
    if (talking()) { stopSpeaking(); setTimeout(() => { if (!busyNow() && !listening) startListening(); }, 150); return; }
    if (convoMode) { if (!listening && !busyNow()) startListening(); return; }
    if (listening) stopListening(); else startListening();
  }

  function toggleListen() {
    if (!SR) return;
    if (listening) stopListening(); else startListening();
  }

  /* ======================================================================
     UI wiring
     ====================================================================== */

  function setMicState(on) {
    if (!micBtn) return;
    micBtn.classList.toggle('rec', on);
    micBtn.title = on ? 'listening — click to stop' : 'push to talk';
    micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    micBtn.setAttribute('aria-label', on ? 'Listening, click to stop' : 'Push to talk');
  }
  function setSpeaking(on) {
    if (toggleBtn) toggleBtn.classList.toggle('speaking', on);
    // a spoken reply streams as several chunks — don't flip back to 'online' between them (draining),
    // and don't clobber a still-running task's 'working…' status.
    if (on) { if (!busyNow()) setStatus('speaking…'); }
    else if (!listening && !busyNow() && !draining) setStatus('online');
  }
  function reflectToggle() {
    if (!toggleBtn) return;
    toggleBtn.classList.toggle('off', !speakReplies);
    toggleBtn.innerHTML = speakReplies ? ICON.spkOn : ICON.spkOff;
    toggleBtn.title = speakReplies ? 'agent voice: ON — click to mute' : 'agent voice: OFF — click to unmute';
    toggleBtn.setAttribute('aria-pressed', speakReplies ? 'true' : 'false');
    toggleBtn.setAttribute('aria-label', speakReplies ? 'Agent voice: on, click to mute' : 'Agent voice: off, click to unmute');
  }
  function reflectMode() {
    if (!modeBtn) return;
    modeBtn.classList.toggle('on', convoMode);
    modeBtn.innerHTML = convoMode ? ICON.modeLive : ICON.modePtt;
    modeBtn.title = convoMode
      ? 'voice mode: ON (hands-free) — click for push-to-talk'
      : 'voice mode: OFF (push-to-talk) — click for hands-free conversation';
    modeBtn.setAttribute('aria-pressed', convoMode ? 'true' : 'false');
    modeBtn.setAttribute('aria-label', convoMode ? 'Voice mode: on (hands-free), click for push-to-talk' : 'Voice mode: off (push-to-talk), click for hands-free');
  }
  // a refresh always drops hands-free to push-to-talk (the first listen needs a fresh click for mic
  // permission — we can't auto-open it). Instead of going silently quiet, pulse the mode button and hint so
  // resuming the conversation is one obvious tap. Cleared the moment the user engages voice again.
  function showResumeCue() {
    if (!modeBtn || !canListen()) return;
    resumePending = true;
    modeBtn.classList.add('resume');
    modeBtn.title = 'tap to resume hands-free voice mode';
    modeBtn.setAttribute('aria-label', 'Resume hands-free voice mode');
    setStatus('tap 🎙️ to resume voice mode');
  }
  function clearResumeCue() {
    if (!resumePending) return;
    resumePending = false;
    if (modeBtn) modeBtn.classList.remove('resume');
    reflectMode();   // restore the normal title/aria for the current mode
  }
  function toggleSpeakReplies() {
    speakReplies = !speakReplies; savePref(LS_SPEAK, speakReplies);
    forcedSpeak = false;   // a manual speaker change is the user's own choice — keep it (don't restore on voice-mode exit)
    if (!speakReplies) stopSpeaking();
    reflectToggle();
    if (typeof SFX !== 'undefined') SFX.click();
  }

  // init is called from app.js right after Chat.init — agentName seeds this agent's voice.
  function init(opts) {
    opts = opts || {};
    activeVoiceId = opts.name || 'agent';
    if (opts.personaId) activePersonaId = opts.personaId;
    convoMode = false;   // a fresh game session starts in push-to-talk; the toggle opts into hands-free
    clearTimeout(rearmTimer); rearmTimer = null; emptyStreak = 0;
    inputEl = el('chat-input'); statusEl = el('chat-status');
    micBtn = el('chat-mic'); toggleBtn = el('voice-toggle'); modeBtn = el('voice-mode');

    if (micBtn) {
      if (!canListen()) micBtn.style.display = 'none';      // graceful degradation
      else { micBtn.onclick = () => onMicClick(); micBtn.innerHTML = ICON.mic; }
    }
    if (toggleBtn) {
      if (!canSpeak()) toggleBtn.style.display = 'none';
      else { toggleBtn.onclick = () => toggleSpeakReplies(); reflectToggle(); }
    }
    if (modeBtn) {
      if (!canListen()) modeBtn.style.display = 'none';     // no STT → no hands-free
      else { modeBtn.onclick = () => toggleVoiceMode(); reflectMode(); }
    }
    // Escape always drops out of hands-free (never auto-arm on load — the first listen needs a click,
    // which also satisfies the browser mic-permission gesture).
    if (!init._esc) { init._esc = true; document.addEventListener('keydown', e => { if (e.key === 'Escape' && convoMode) { savePref(LS_CONVO, false); stopConvo(); } }); }
    // unlock browser audio on the first user gesture so the agent's voice is never silently swallowed after a reload
    if (!init._audio) { init._audio = true; ['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, armAudio, { once: true, capture: true })); }
    // were they hands-free last session? the refresh reset it — invite a one-tap resume (skipped during the
    // awakening, which owns the COMMS input). Never auto-starts; the click is the required mic-permission gesture.
    if (opts.resumeCue !== false && canListen() && loadPref(LS_CONVO, false)) showResumeCue();
    else clearResumeCue();
  }

  // let other code (or a future hotkey) retarget the active voice when the workstream's agent changes.
  function setAgent(name) { if (name) activeVoiceId = name; }

  // is the agent going to SPEAK this reply? true when synth is available and the speaker toggle is on.
  // chat.js uses this to decide whether a conversational turn is "voice mode" (short/casual spoken
  // reply) vs "type mode" (detailed written reply). Stage 4's hands-free toggle will fold in here too.
  function isOn() { return !!(synth && speakReplies); }

  return {
    init, speak, speakChunk, endReply, mutter, ambientLine, setAgent, isOn,
    startListening, stopListening, toggleListen, stopSpeaking,
    toggleVoiceMode, stopConvo, onTurnEnd,
    canListen, canSpeak, personaId: () => activePersonaId,
    isListening: () => listening, isSpeaking: () => speaking, inVoiceMode: () => convoMode
  };
})();
