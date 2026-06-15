/* SKYNET — voice.js : two-way voice for the COMMS panel.

   INPUT  (push-to-talk): a mic button transcribes your speech and feeds the text
          straight through Chat.send — identical to typing — so all of chat.js's
          busy / purpose / task-vs-talk logic is reused with zero duplication.
   OUTPUT (agent voice): when an agent speaks a conversational reply (the same moment
          it shows a speech bubble via World.say), it is spoken ALOUD with a per-agent
          voice identity — distinct, stable pitch/rate/voice derived from the agent's
          name, so every crew member sounds like itself.

   PHASE 1 (this file) uses the browser-native Web Speech API: SpeechRecognition for
   STT and speechSynthesis for TTS. Zero keys, zero cost, works offline. Both directions
   sit behind a tiny provider seam (sttProvider / ttsProvider) so a neural backend
   (Whisper transcription, neural per-agent voices) can drop in LATER without touching
   the UI or chat.js. See docs/VOICE_CHAT_PLAN.md for the Phase 2 path.

   Graceful degradation: if the browser exposes no SpeechRecognition the mic button hides
   itself; if no speechSynthesis the speaker toggle hides itself. Everything else still works. */
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
  let listening = false, speaking = false, savedStatus = '';
  // hands-free loop bookkeeping
  let rearmTimer = null;            // pending mic re-open
  let emptyStreak = 0;              // silent listens in a row (→ go passive instead of looping forever)
  let sentThisListen = false;       // did the just-finished listen actually send a message?

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

  // the real utterance build + queue, shared by speak() and its voices-ready retry path.
  function doSpeak(text, id, onEnd) {
    if (!synth) { onEnd && onEnd(); return; }
    // Only cancel when something is actually queued/playing. A cancel() on an empty queue can
    // leave Chrome's engine paused (the later-turn silence). resume() first un-sticks any pause
    // left over from the mic's SpeechRecognition run before we enqueue.
    kickResume();
    try { if (synth.speaking || synth.pending) synth.cancel(); } catch (_) {}
    const u = new SpeechSynthesisUtterance(text);
    const v = voiceFor(id);
    if (v.voice) u.voice = v.voice;
    u.pitch = v.pitch; u.rate = v.rate; u.volume = 1;
    u.onstart = () => onSpeakStart();
    u.onend = () => { onSpeakEnd(); onEnd && onEnd(); };
    u.onerror = () => { onSpeakEnd(); onEnd && onEnd(); };
    try {
      synth.speak(u);
      kickResume();        // Chrome sometimes enqueues paused — resume right after speak()
      startWatchdog();     // keep resuming if it pauses mid-utterance (~15s bug) or stalls
    } catch (_) { onSpeakEnd(); onEnd && onEnd(); }
  }

  // the TTS provider seam — Phase 2 swaps this for a neural backend (return a Promise that resolves on end).
  const ttsProvider = {
    name: 'web-speech',
    speak(text, id, onEnd) {
      if (!synth) { onEnd && onEnd(); return; }
      // voices may not be loaded yet on a cold first paint — if empty, refresh and retry once on
      // voiceschanged so we don't speak with a null/default voice (or, on some builds, not at all).
      if (!voiceCache.length) {
        refreshVoices();
        if (!voiceCache.length) {
          let fired = false;
          const go = () => { if (fired) return; fired = true; refreshVoices(); doSpeak(text, id, onEnd); };
          try { synth.addEventListener('voiceschanged', go, { once: true }); } catch (_) {}
          setTimeout(go, 250);   // hard fallback if voiceschanged never fires
          return;
        }
      }
      doSpeak(text, id, onEnd);
    },
    stop() {
      if (synth) {
        // only cancel if there is actually something queued/playing — a cancel() on an empty queue
        // can leave Chrome's engine wedged (paused), which is what silences later turns.
        try { if (synth.speaking || synth.pending) synth.cancel(); } catch (_) {}
        kickResume();   // un-stick the engine after recognition / a prior cancel
      }
      onSpeakEnd();
    }
  };

  function onSpeakStart() { speaking = true; setSpeaking(true); }
  function onSpeakEnd() { if (!speaking) return; speaking = false; setSpeaking(false); }

  // public: speak a finished reply. Called from chat.js at the same seam that shows the bubble.
  // The onReplyEnded callback is the hands-free loop's heartbeat: when the agent truly stops
  // talking, re-open the mic so the conversation just continues.
  function speak(text, voiceId) {
    if (!speakReplies || !synth) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (voiceId) activeVoiceId = voiceId;
    ttsProvider.speak(t.slice(0, 600), activeVoiceId, onReplyEnded);
  }

  function stopSpeaking() { ttsProvider.stop(); }

  /* ======================================================================
     HANDS-FREE VOICE MODE — the self-driving listen → send → speak → listen loop
     ====================================================================== */

  // the agent finished speaking a reply → try to re-open the mic (no-op unless in voice mode).
  function onReplyEnded() { maybeRearm(); }
  // a run fully finished (called from chat.js's finally — covers task turns that never spoke).
  function onTurnEnd() { maybeRearm(); }

  // re-open the mic once the turn is genuinely done: not in a run, not still speaking, not already
  // listening. Whichever finishing event (TTS end / run end) lands last is the one that arms it.
  function maybeRearm() {
    if (!convoMode || !SR || rearmTimer) return;
    if (busyNow() || speaking || listening) return;   // not ready — the finishing event will re-call this
    rearmTimer = setTimeout(() => {
      rearmTimer = null;
      if (convoMode && !busyNow() && !speaking && !listening) startListening();
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
    stopListening(); stopSpeaking();
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
    stop() { if (rec) { try { rec.stop(); } catch (_) {} } }
  };

  function busyNow() { return typeof Chat !== 'undefined' && Chat.isBusy && Chat.isBusy(); }

  function startListening() {
    if (!SR || listening) return;
    if (busyNow()) { setStatus('busy — wait for the reply'); return; }  // don't talk over a live run
    clearTimeout(rearmTimer); rearmTimer = null;
    stopSpeaking();                       // don't let the agent's voice bleed into the mic
    listening = true; sentThisListen = false; setMicState(true);
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
    // hands-free: if this listen heard nothing, keep the loop alive (retry, then go passive).
    if (convoMode && !sentThisListen && !busyNow() && !speaking) { handleEmptyListen(); return; }
    // otherwise restore whatever status was showing before we grabbed the mic (a send already set
    // 'thinking…'/'working…' via Chat, so this only fires for a plain idle stop).
    if (!busyNow() && !speaking) setStatus(savedStatus || (convoMode ? 'voice mode on' : 'online'));
  }

  // a final transcript: drop it in the box for a beat of visual confirmation, then send as if typed.
  function submitTranscript(text) {
    const t = String(text || '').trim();
    if (inputEl) inputEl.value = '';
    if (!t) return;   // heard nothing — endListening() handles the hands-free retry
    // spoken exit: let the Commander leave voice mode without touching the keyboard.
    if (convoMode && /^(exit|stop|end|leave|quit)\s+voice(\s+mode)?[.!]?$/i.test(t)) { stopConvo(); return; }
    sentThisListen = true; emptyStreak = 0;
    if (typeof SFX !== 'undefined') SFX.click();
    if (typeof Chat !== 'undefined' && Chat.send) Chat.send(t);   // reuses busy/purpose/task logic + cost accounting
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
    if (on) setStatus('speaking…');
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
    init, speak, setAgent, isOn,
    startListening, stopListening, toggleListen, stopSpeaking,
    toggleVoiceMode, stopConvo, onTurnEnd,
    canListen, canSpeak,
    isListening: () => listening, isSpeaking: () => speaking, inVoiceMode: () => convoMode
  };
})();
