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
  const REARM_DELAY = 350;                 // ms after the agent stops talking before the mic re-opens (echo guard)
  const MAX_EMPTY = 3;                      // consecutive silent listens before the loop goes passive

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
  let pendingSpeech = false;        // a neural TTS request is in flight / about to play (covers the fetch gap)
  // hands-free loop bookkeeping
  let rearmTimer = null;            // pending mic re-open
  let emptyStreak = 0;              // silent listens in a row (→ go passive instead of looping forever)
  let sentThisListen = false;       // did the just-finished listen actually send a message?
  let discarding = false;           // teardown in progress → drop any buffered transcript (don't send)

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

  function onSpeakStart() { speaking = true; setSpeaking(true); }
  // clears pendingSpeech FIRST (before the speaking guard) so the hands-free loop never wedges even if
  // a neural attempt ended before any audio actually started.
  function onSpeakEnd() { pendingSpeech = false; if (!speaking) return; speaking = false; setSpeaking(false); }

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
  let ttsDisabled = false;   // flip true once we learn there's no usable key — skip the round-trip after that
  function apiKey() { return (typeof Harness !== 'undefined' && Harness.getKey) ? (Harness.getKey() || '') : ''; }
  function ttsConfig() {
    const p = (typeof Personas !== 'undefined' && Personas.get) ? Personas.get(activePersonaId) : null;
    return { model: TTS_MODEL, voice: (p && p.ttsVoice) || 'Umbriel', speed: (p && p.ttsSpeed) || 1.0 };
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
      a.onended = endOk; a.onerror = endOk;
      const p = a.play();
      if (p && p.catch) p.catch(() => { if (done) return; done = true; cleanup(); onFail ? onFail() : endOk(); });
    } catch (_) { cleanup(); onFail ? onFail() : (onSpeakEnd(), onEnd && onEnd()); }
  }
  // the unified output path used by speak()/mutter(): try neural, fall back to browser.
  function output(text, id, onEnd, opts) {
    opts = opts || {};
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) { onEnd && onEnd(); return; }
    pendingSpeech = true;   // the agent is about to make sound — the loop must wait through the fetch gap
    const fb = () => webSpeechSpeak(t, id, onEnd, opts);
    const key = apiKey();
    if (!key || ttsDisabled) { fb(); return; }
    const cfg = ttsConfig();
    const rate = cfg.speed * (opts.speedMul || 1);   // applied client-side via Audio.playbackRate
    fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, text: t, model: cfg.model, voice: cfg.voice }) })
      .then(async r => {
        const ct = r.headers.get('Content-Type') || '';
        if (r.ok && ct.indexOf('audio') === 0) {
          const blob = await r.blob();
          if (blob && blob.size) { playBlob(blob, onEnd, opts.volume, fb, rate); return; }
        }
        let reason = 'http ' + r.status;
        try { const j = await r.json(); if (j && j.reason) reason = j.reason; } catch (_) {}
        if (/no key/i.test(reason)) ttsDisabled = true;
        console.warn('[voice] neural TTS → browser fallback:', reason);
        fb();
      })
      .catch(e => { console.warn('[voice] neural TTS error:', (e && e.message) || e); fb(); });
  }
  function stopSpeaking() {
    stopAudio();
    if (synth) { try { if (synth.speaking || synth.pending) synth.cancel(); } catch (_) {} kickResume(); }
    onSpeakEnd();
  }

  // public: speak a finished reply. onReplyEnded is the hands-free loop's heartbeat.
  function speak(text, voiceId) {
    if (!speakReplies) return;
    if (voiceId) activeVoiceId = voiceId;
    output(text, activeVoiceId, onReplyEnded, {});
  }

  // an ambient, muttered aside — station-life flavor (from world.js curiosity remarks), in the agent's
  // own voice but quieter + a touch slower so it reads as it talking to itself, not answering. It NEVER
  // cuts off a real reply and stays silent during a live exchange (speaking / listening / a run / a
  // pending re-arm) so it can't collide with conversation or feed the open mic. maybeRearm on end
  // covers "voice mode switched on mid-mutter" so the loop never hangs.
  function mutter(text) {
    if (!speakReplies) return;
    if (speaking || pendingSpeech || currentAudio || listening || rearmTimer || busyNow()) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    output(t.slice(0, 80), activeVoiceId, maybeRearm, { volume: 0.5, speedMul: 0.88 });
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
  function talking() { return speaking || pendingSpeech || !!currentAudio || !!(synth && (synth.speaking || synth.pending)); }
  function maybeRearm() {
    if (!convoMode || !SR || rearmTimer) return;
    if (busyNow() || listening || talking()) return;   // not ready — a finishing event re-calls this
    rearmTimer = setTimeout(() => {
      rearmTimer = null;
      if (convoMode && !busyNow() && !listening && !talking()) startListening();
    }, REARM_DELAY);
  }

  // turn hands-free on/off. ON jumps straight into listening; agents must be audible to converse,
  // so it also flips the speaker on. OFF tears the loop down.
  function toggleVoiceMode() {
    if (!SR) return;
    convoMode = !convoMode;
    if (typeof SFX !== 'undefined') SFX.open();
    if (convoMode) {
      if (!speakReplies) { speakReplies = true; savePref(LS_SPEAK, true); reflectToggle(); }  // you have to hear it
      emptyStreak = 0;
      reflectMode();
      if (!busyNow() && !listening && !speaking) startListening();
      else setStatus('voice mode on');
    } else {
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
      onError: msg => { endListening(); if (msg !== 'no-speech' && msg !== 'aborted') setStatus('mic: ' + msg); },
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
    if (convoMode && /^(exit|stop|end|leave|quit|turn off)\b.*\bvoice\b/.test(norm)) { stopConvo(); return; }
    sentThisListen = true; emptyStreak = 0;
    if (typeof SFX !== 'undefined') SFX.click();
    if (typeof Chat !== 'undefined' && Chat.send) Chat.send(t);
  }

  // mic button: interrupt the agent if it's talking (barge-in), else start/stop a listen. In voice
  // mode the loop manages re-opening; clicking just lets you jump in (or resume from passive).
  function onMicClick() {
    if (!SR) return;
    if (speaking) { stopSpeaking(); setTimeout(() => { if (!busyNow() && !listening) startListening(); }, 150); return; }
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
  }
  function setSpeaking(on) {
    if (toggleBtn) toggleBtn.classList.toggle('speaking', on);
    // a task acknowledgment speaks while the run is still going — don't clobber the 'working…' status.
    if (on) { if (!busyNow()) setStatus('speaking…'); }
    else if (!listening && !busyNow()) setStatus('online');
  }
  function reflectToggle() {
    if (!toggleBtn) return;
    toggleBtn.classList.toggle('off', !speakReplies);
    toggleBtn.textContent = speakReplies ? '🔊' : '🔇';
    toggleBtn.title = speakReplies ? 'agent voice: ON — click to mute' : 'agent voice: OFF — click to unmute';
  }
  function reflectMode() {
    if (!modeBtn) return;
    modeBtn.classList.toggle('on', convoMode);
    modeBtn.textContent = convoMode ? '🎙️' : '💬';
    modeBtn.title = convoMode
      ? 'voice mode: ON (hands-free) — click for push-to-talk'
      : 'voice mode: OFF (push-to-talk) — click for hands-free conversation';
  }
  function toggleSpeakReplies() {
    speakReplies = !speakReplies; savePref(LS_SPEAK, speakReplies);
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
      else micBtn.onclick = () => onMicClick();
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
    if (!init._esc) { init._esc = true; document.addEventListener('keydown', e => { if (e.key === 'Escape' && convoMode) stopConvo(); }); }
  }

  // let other code (or a future hotkey) retarget the active voice when the workstream's agent changes.
  function setAgent(name) { if (name) activeVoiceId = name; }

  // is the agent going to SPEAK this reply? true when synth is available and the speaker toggle is on.
  // chat.js uses this to decide whether a conversational turn is "voice mode" (short/casual spoken
  // reply) vs "type mode" (detailed written reply). Stage 4's hands-free toggle will fold in here too.
  function isOn() { return !!(synth && speakReplies); }

  return {
    init, speak, mutter, setAgent, isOn,
    startListening, stopListening, toggleListen, stopSpeaking,
    toggleVoiceMode, stopConvo, onTurnEnd,
    canListen, canSpeak,
    isListening: () => listening, isSpeaking: () => speaking, inVoiceMode: () => convoMode
  };
})();
