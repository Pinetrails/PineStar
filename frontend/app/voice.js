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

  const canListen = () => !!SR;
  const canSpeak = () => !!synth;

  // ---- persisted prefs ----------------------------------------------------
  let speakReplies = loadPref(LS_SPEAK, true);   // do agents speak their replies aloud?
  function loadPref(k, dflt) { try { const v = localStorage.getItem(k); return v == null ? dflt : v === '1'; } catch (_) { return dflt; } }
  function savePref(k, on) { try { localStorage.setItem(k, on ? '1' : '0'); } catch (_) {} }

  // ---- UI handles (wired in init) -----------------------------------------
  let micBtn = null, toggleBtn = null, inputEl = null, statusEl = null;
  let activeVoiceId = 'agent';      // identity used to pick the current agent's voice
  let listening = false, speaking = false, savedStatus = '';

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

  // the TTS provider seam — Phase 2 swaps this for a neural backend (return a Promise that resolves on end).
  const ttsProvider = {
    name: 'web-speech',
    speak(text, id, onEnd) {
      if (!synth) { onEnd && onEnd(); return; }
      try { synth.cancel(); } catch (_) {}        // never let two utterances overlap
      const u = new SpeechSynthesisUtterance(text);
      const v = voiceFor(id);
      if (v.voice) u.voice = v.voice;
      u.pitch = v.pitch; u.rate = v.rate; u.volume = 1;
      u.onstart = () => onSpeakStart();
      u.onend = () => { onSpeakEnd(); onEnd && onEnd(); };
      u.onerror = () => { onSpeakEnd(); onEnd && onEnd(); };
      try { synth.speak(u); } catch (_) { onSpeakEnd(); onEnd && onEnd(); }
    },
    stop() { if (synth) { try { synth.cancel(); } catch (_) {} } onSpeakEnd(); }
  };

  function onSpeakStart() { speaking = true; setSpeaking(true); }
  function onSpeakEnd() { if (!speaking) return; speaking = false; setSpeaking(false); }

  // public: speak a finished reply. Called from chat.js at the same seam that shows the bubble.
  function speak(text, voiceId) {
    if (!speakReplies || !synth) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (voiceId) activeVoiceId = voiceId;
    ttsProvider.speak(t.slice(0, 600), activeVoiceId, null);
  }

  function stopSpeaking() { ttsProvider.stop(); }

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
    stopSpeaking();                       // don't let the agent's voice bleed into the mic
    listening = true; setMicState(true);
    savedStatus = currentStatusText();
    setStatus('listening…');
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
    // if nothing was submitted, restore whatever status was showing before we grabbed it
    if (!busyNow()) setStatus(savedStatus || 'online');
  }

  // a final transcript: drop it in the box for a beat of visual confirmation, then send as if typed.
  function submitTranscript(text) {
    const t = String(text || '').trim();
    if (inputEl) inputEl.value = '';
    if (!t) return;
    if (typeof SFX !== 'undefined') SFX.click();
    if (typeof Chat !== 'undefined' && Chat.send) Chat.send(t);   // reuses busy/purpose/task logic + cost accounting
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
    inputEl = el('chat-input'); statusEl = el('chat-status');
    micBtn = el('chat-mic'); toggleBtn = el('voice-toggle');

    if (micBtn) {
      if (!canListen()) micBtn.style.display = 'none';      // graceful degradation
      else micBtn.onclick = () => toggleListen();
    }
    if (toggleBtn) {
      if (!canSpeak()) toggleBtn.style.display = 'none';
      else { toggleBtn.onclick = () => toggleSpeakReplies(); reflectToggle(); }
    }
  }

  // let other code (or a future hotkey) retarget the active voice when the workstream's agent changes.
  function setAgent(name) { if (name) activeVoiceId = name; }

  return {
    init, speak, setAgent,
    startListening, stopListening, toggleListen, stopSpeaking,
    canListen, canSpeak,
    isListening: () => listening, isSpeaking: () => speaking
  };
})();
