/* STARNET — voice.js : two-way voice for the COMMS panel.

   INPUT  (push-to-talk): a mic button transcribes your speech and feeds the text
          straight through Chat.send — identical to typing — so all of chat.js's
          busy / purpose / task-vs-talk logic is reused with zero duplication.
   OUTPUT (agent voice): when an agent speaks a conversational reply (the same moment
          it shows a speech bubble via World.say), it is spoken ALOUD in the ONE locked
          station voice (Personas.STATION_VOICE — Ultron); personality changes what the
          agent SAYS, never how it sounds.

   STT prefers the recorder → /api/stt (server Whisper) wherever the mic can be recorded — Chrome's
   browser-native SpeechRecognition is Google-served and CENSORS profanity to asterisks with no opt-out,
   so it is only the fallback (no MediaRecorder, `?stt=web`, or a sidecar with no STT credential).
   TTS is NEURAL-ONLY via the sidecar /api/tts. The client always asks the sidecar when the
   speaker is on — the sidecar owns the tier ladder (run-provider native voice → OpenRouter/
   Gemini/OpenAI → a free keyless neural floor) and decides what it can serve. There is NO
   robotic browser-speechSynthesis fallback: if every neural tier fails (total network loss),
   the chunk is simply SKIPPED (silence) and the honest degrade reason is pinned on the
   speaker-toggle tooltip. The reply text is always visible in COMMS — silence over cringe.

   Graceful degradation: no SpeechRecognition → the mic button hides; the speaker toggle needs
   only Audio + fetch (never speechSynthesis). A failed neural chunk plays nothing (the reply
   still shows as text + a room bubble); no permanent latch — the next reply re-probes. */
'use strict';

const Voice = (() => {
  const el = id => document.getElementById(id);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  // does this environment let us RECORD the mic (MediaRecorder → /api/stt)? This is the desktop path:
  // WebView2 ships getUserMedia/MediaRecorder but NOT SpeechRecognition, so browser-native STT is dead
  // there and voice mode was completely broken. `?stt=recorder` forces this path in a normal browser so
  // the desktop flow can be exercised without a Tauri build.
  const canRecordMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
  let forceRecorder = false, forceWebSpeech = false;
  try {
    forceRecorder = /(?:^|[?&])stt=recorder(?:&|$)/.test(location.search);
    forceWebSpeech = /(?:^|[?&])stt=web(?:&|$)/.test(location.search);
  } catch (_) {}
  const LS_SPEAK = 'starnet.voice.speak';
  const LS_CONVO = 'starnet.voice.convo';   // remembers the user WAS hands-free, so a refresh can offer one-tap resume
  const REARM_DELAY = 150;                 // ms after the agent stops talking before the mic re-opens (echo guard).
                                           // Neural <audio> stops synchronously on teardown, so a short guard is enough.
  const MAX_EMPTY = 3;                      // consecutive silent listens before the loop goes passive

  // Phosphor line-icons for the voice controls — single-color (currentColor) so they inherit the active
  // theme's phosphor tint + glow, matching the terminal UI instead of the off-brand OS color emoji.
  // Swapped by reflect*()/init below.
  const ICON = {
    mic: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.8" y="1.7" width="4.4" height="7.2" rx="2.2"/><path d="M3.7 7.5a4.3 4.3 0 0 0 8.6 0"/><path d="M8 11.8v2.4"/><path d="M5.4 14.2h5.2"/></svg>',
    spkOn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 6.1h2.1L7.7 3.3v9.4L4.3 9.9H2.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="miter"/><g fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10.3 6a3.2 3.2 0 0 1 0 4"/><path d="M12.4 4a6.2 6.2 0 0 1 0 8"/></g></svg>',
    spkOff: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 6.1h2.1L7.7 3.3v9.4L4.3 9.9H2.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="miter"/><g fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10.6 6.4 13.4 9.2"/><path d="M13.4 6.4 10.6 9.2"/></g></svg>',
    modePtt: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor"><path d="M2.2 3.2h11.6v7.2H7.4L4.6 12.9v-2.5H2.2z" stroke-width="1.4" stroke-linejoin="miter"/><g stroke-width="1.4"><path d="M5.5 5.9v1.8"/><path d="M8 5v3.6"/><path d="M10.5 5.9v1.8"/></g></svg>',
    modeLive: '<svg viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.8 6.4v3.2"/><path d="M6.27 3.8v8.4"/><path d="M9.73 5.2v5.6"/><path d="M13.2 6.7v2.6"/></g></svg>'
  };

  // STT works if EITHER provider is usable: mic recording → /api/stt, or browser-native SpeechRecognition.
  // `?stt=recorder` forces the recorder; `?stt=web` forces browser-native SR (each hides the mic if its
  // forced provider is unusable, so the forced path is what actually gets exercised).
  const canListen = () => forceRecorder ? canRecordMic : (forceWebSpeech ? !!SR : (canRecordMic || !!SR));
  // can we produce the agent's (neural) voice at all? Neural playback needs only an <audio> element and
  // fetch — NOT speechSynthesis. The sidecar owns the tier ladder incl. a free keyless floor, so any
  // browser that can play audio can speak. (Used to gate the speaker toggle's visibility.)
  const canSpeak = () => (typeof Audio !== 'undefined') && (typeof fetch !== 'undefined');

  // ---- prefs --------------------------------------------------------------
  // do agents speak their replies aloud? (persisted). DEFAULT OFF — and keep it off: when the speaker is
  // on, chat.js routes even a real TASK to the one-on-one 'talk' stance (the agent faces you and answers on
  // the spot) INSTEAD of walking to its workstation. Defaulting this ON silently suppressed the signature
  // desk trip for every task on an untouched agent ("gave it a task, it just stood there"). Voice is opt-in;
  // a user who turns it on (or enters hands-free mode, which force-enables it) gets the spoken one-on-one.
  let speakReplies = loadPref(LS_SPEAK, false);
  let convoMode = false;     // hands-free loop — a per-session mode (each game starts in push-to-talk)
  function loadPref(k, dflt) { try { const v = localStorage.getItem(k); return v == null ? dflt : v === '1'; } catch (_) { return dflt; } }
  function savePref(k, on) { try { localStorage.setItem(k, on ? '1' : '0'); } catch (_) {} }

  // ---- UI handles (wired in init) -----------------------------------------
  let micBtn = null, toggleBtn = null, modeBtn = null, inputEl = null, statusEl = null;
  let dictShown = '';   // DRAFT PROTECTION: exactly what dictation last wrote into the composer — the only text a listen is ever allowed to overwrite or clear
  let activeVoiceId = 'agent';      // identity used to pick the current agent's voice
  let activePersonaId = (typeof Personas !== 'undefined' && Personas.DEFAULT_ID) || 'professional';   // drives the in-character task acknowledgments (overwritten from the live agent in Voice.init)
  let listening = false, speaking = false, savedStatus = '';
  let coordinator = null;           // OAuth/local live surface hooks; null preserves the classic voice path
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
  function coordinatorEvent(name, payload) {
    try { if (coordinator && typeof coordinator[name] === 'function') coordinator[name](payload); } catch (_) {}
  }
  /* A DIAGNOSTIC status must outlive the same-tick restore. The recorder's finish() writes the /api/stt
     degrade reason and then calls cb.onEnd() -> endListening() inside the SAME synchronous .then body, and
     Chat.status is a plain `textContent =` with no queue, so the browser only ever painted the LAST write:
     the reason had a zero-frame lifetime and the only surviving trace was a console.warn nobody has open.
     Park it here instead — endListening's restore and the hands-free give-up line both prefer it, and it is
     cleared as soon as it has been honored or a listen actually produces a transcript. */
  let pendingDiag = '';
  function setDiagStatus(msg) { pendingDiag = String(msg == null ? '' : msg); setStatus(pendingDiag); }
  function takeDiag() { const d = pendingDiag; pendingDiag = ''; return d; }

  /* ======================================================================
     OUTPUT — the agent's voice (TTS)
     ====================================================================== */

  function onSpeakStart() { speaking = true; setSpeaking(true); duckSfx(true); coordinatorEvent('onState', 'speaking'); startOutputMeter(); }
  function onSpeakEnd() {
    // Meter teardown is deliberately unconditional. A failed media element can fire after another
    // path already cleared `speaking`; leaving the rAF alive in that race would pin the live panel
    // to the agent side forever.
    stopOutputMeter();
    outAnalyser = null;
    if (!speaking) return;
    speaking = false;
    setSpeaking(false);
    coordinatorEvent('onState', busyNow() ? 'thinking' : 'ready');
  }

  /* ---- THE AGENT'S SIDE OF THE METER ------------------------------------------------------------
     A phone call shows you both voices: your own level, and the other party's in its own colour. The
     agent's half is read off `outAnalyser` — a tap on whichever chain (transmission / machine shell)
     the CURRENT playback is routed through, i.e. the exact signal leaving for the speakers.
     It is NOT a timer and NOT an envelope guessed from the text: when playback is dry (WebAudio routing
     failed) there is no tap, so this reports 0 and the agent's half of the meter stays flat rather than
     inventing motion the speakers aren't making. Only runs while a live panel is attached. */
  let outAnalyser = null, outRaf = 0, outBuf = null;
  function outputLevelTick() {
    outRaf = 0;
    if (!speaking || !coordinator) return;
    let rms = 0;
    const an = outAnalyser;
    if (an) {
      try {
        if (!outBuf || outBuf.length !== an.fftSize) outBuf = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(outBuf);
        let e = 0;
        for (let i = 0; i < outBuf.length; i++) e += outBuf[i] * outBuf[i];
        rms = Math.sqrt(e / outBuf.length);
      } catch (_) { rms = 0; }
    }
    coordinatorEvent('onOutputLevel', rms);
    if (typeof requestAnimationFrame === 'function') outRaf = requestAnimationFrame(outputLevelTick);
  }
  function startOutputMeter() {
    if (!coordinator || outRaf || typeof requestAnimationFrame !== 'function') return;
    outRaf = requestAnimationFrame(outputLevelTick);
  }
  function stopOutputMeter() {
    if (outRaf && typeof cancelAnimationFrame === 'function') { try { cancelAnimationFrame(outRaf); } catch (_) {} }
    outRaf = 0;
    coordinatorEvent('onOutputLevel', 0);   // the agent stopped talking: say so, don't leave the last frame lit
  }

  /* ---- neural TTS — the agent's ONLY voice -----------------------------------------------------
     Hits the sidecar /api/tts and plays the returned audio. The sidecar owns the whole tier ladder
     (run-provider native voice → OpenRouter/Gemini/OpenAI → a free keyless neural floor), so the client
     always asks whenever the speaker is on and the sidecar decides what it can serve. There is NO robotic
     speechSynthesis fallback: any failure just SKIPS that chunk (silence) and pins the honest reason on the
     speaker-toggle tooltip. No permanent latch — a 'no key'/error only cools the neural path off briefly. */
  const TTS_MODEL = 'google/gemini-3.1-flash-tts-preview';
  let neuralColdUntil = 0;        // after a neural error, skip the round-trip (stay silent) until this time (ms)
  // how long to cool off after a TRANSIENT neural error. Keep this SHORT: one blip shouldn't rob several
  // replies of the real voice — we retry neural on essentially the next reply.
  const NEURAL_COLD_MS = 4000;
  // 'no key' and billing failures (402 / "insufficient credits") are NOT transient — retrying on every reply
  // just burns a round-trip per sentence. Back off much longer, and above all TELL the user (2026-07-07
  // escape: OpenRouter credits ran dry and the whole station went silent with zero explanation — the degrade
  // itself was fine, the silence ABOUT it wasn't). NB: NO permanent latch — this is a 60s cold-off that ANY
  // speaker-toggle clears, so a spurious startup 'no key' never disables voice for the whole session.
  const BILLING_COLD_MS = 60000;
  // consecutive neural failures inside the reply that is CURRENTLY speaking. A cold-off may never guillotine
  // a reply already in flight (see startSynth) — this counter is what eventually lets it, so a genuinely dead
  // provider costs a couple of round-trips per reply instead of one per sentence.
  let replyFails = 0;
  let replyTried = false;  // has the reply currently speaking already ATTEMPTED a synth? Only then may it
                           // outrank the cold-off — a BRAND-NEW reply still honors it in full (no hammering).
  const MID_REPLY_GIVEUP = 2;
  let fbStreak = 0;        // consecutive neural failures (reset by the next neural success)
  let fbNotified = '';     // reason class already surfaced this outage — notify once, not once per sentence
  /* A reason is a semicolon-joined LADDER of everything the sidecar tried, not one verdict:
       'no key; edge: edge timeout'                              (keyless station, the free floor blipped)
       'openrouter 402 — insufficient credits; edge: empty audio' (wallet empty AND the floor blipped)
     Two different questions get asked of it, and answering both with one terminal-class-first substring
     test was the bug: on a keyless station 'no key' is a STRUCTURAL constant the sidecar always prefixes,
     so the transient half was invisible — the one-shot retry never fired, the 60s billing cold-off armed
     instead of the 4s one, and the tooltip demanded a credential for a network hiccup on a voice path that
     is keyless by design. Split the two questions:
       classifyFallback  -> WHAT TO SAY   (the worst thing that is actually actionable)
       retryableFallback -> HOW LONG TO BACK OFF (is any leg worth trying again in seconds?) */
  // An empty wallet will not fix itself. NB 'insufficient_quota' is OpenAI's TERMINAL billing error and
  // must stay here, while Gemini answers a PER-MINUTE 429 with "Quota exceeded for quota metric" — a bare
  // /quota/ test conflated the two and bought 60s of silence for something that clears in seconds.
  const TERMINAL_BILLING = /\b402\b|insufficient[ _-]?credit|insufficient[ _-]?quota|payment required|billing|out of credit/i;
  const TRANSIENT_LEG = /\b429\b|\b5\d\d\b|rate[ _-]?limit|quota exceeded|too many requests|timeout|timed out|temporarily|unavailable|unreachable|network|socket|ECONN|ETIMEDOUT|EAI_AGAIN|empty audio|aborted/i;
  function classifyFallback(reason) {
    const r = String(reason == null ? '' : reason);
    if (TERMINAL_BILLING.test(r)) return 'credits';
    // 'no key' is structural. With a transient leg in the ladder the station does NOT need a credential —
    // the free floor does have voice and simply blipped, so sending the user to buy a key would be a lie.
    if (/no key/i.test(r)) return TRANSIENT_LEG.test(r) ? 'error' : 'nokey';
    return 'error';
  }
  function retryableFallback(reason) {
    const r = String(reason == null ? '' : reason);
    if (TRANSIENT_LEG.test(r)) return true;                        // something in the ladder may well work now
    if (TERMINAL_BILLING.test(r) || /no key/i.test(r)) return false;
    return true;                                                   // an unclassified error is treated as transient
  }
  // TRUTHFUL TELEMETRY, off the header. The voice swap must never be silent, but the COMMS status bar
  // (#chat-status) is for RUN-STATE only — never voice-outage banners (Andrew 2026-07-13: "there should
  // never be text on the comms panel on that bar"). So pin the honest reason on the speaker toggle's
  // TOOLTIP once per outage (transient blips only after they prove persistent, so a one-off hiccup doesn't
  // nag); it stays inspectable on hover and the recovery path (noteNeuralOk→reflectToggle) clears it once
  // the neural voice is back. We never call setStatus() with it.
  let fbMsg = '';          // the honest degrade reason — shown ONLY on the toggle tooltip, cleared on neural recovery
  function noteFallback(reason) {
    fbStreak++;
    const cls = classifyFallback(reason);
    // The long cold-off is bought by IRRECOVERABILITY, not by the message class: a ladder whose last leg
    // was a timeout or a rate limit is worth retrying in seconds even when an earlier leg said 402.
    if (!retryableFallback(reason)) neuralColdUntil = Date.now() + BILLING_COLD_MS;
    if (fbNotified === cls || (cls === 'error' && fbStreak < 3)) return;
    fbNotified = cls;
    // Truthful: there is no "backup voice" anymore — a failed chunk plays nothing and the reply stays
    // visible as text in COMMS. Say exactly that. Pinned on the toggle tooltip only, never #chat-status.
    fbMsg = cls === 'credits' ? '🔇 real voice offline — voice provider out of credits · reply shown as text'
      : cls === 'nokey' ? '🔇 real voice needs an OpenRouter, Gemini, or OpenAI credential · reply shown as text'
      : '🔇 real voice unreachable · reply shown as text';
    if (toggleBtn) toggleBtn.title = fbMsg;
  }
  // a chunk actually spoke → the neural path is PROVEN alive, so LIFT the cold-off too. Without this, a
  // single blip's 4s cold-off kept suppressing the rest of the reply (and the next reply's opening words)
  // even though the very next call would have succeeded.
  function noteNeuralOk() { fbStreak = 0; replyFails = 0; neuralColdUntil = 0; if (fbNotified) { fbNotified = ''; fbMsg = ''; reflectToggle(); } }
  // ANY toggle of the speaker button clears all cold-offs and re-probes the neural path fresh (no latch).
  function clearNeuralCold() { neuralColdUntil = 0; fbStreak = 0; if (fbNotified) { fbNotified = ''; fbMsg = ''; } }
  function apiKey() { return (typeof Harness !== 'undefined' && Harness.getKey) ? (Harness.getKey() || '') : ''; }
  // Providers whose credential can synthesize the neural voice, in default preference order. The sidecar
  // mirrors this list — Codex (ChatGPT OAuth) is NOT on it because that token has no audio endpoint to call.
  const TTS_PROVIDERS = ['openrouter', 'gemini', 'openai'];
  // the provider the user actually RUNS agents on (the connect-screen choice). Its NATIVE voice API is
  // preferred, so the station speaks from the same account it thinks with — an OpenAI station speaks via
  // OpenAI, a Gemini station via Gemini. A run provider with no voice API (codex/anthropic/…) simply isn't
  // in TTS_PROVIDERS and the default order stands.
  function runProvider() {
    try { return (typeof Harness !== 'undefined' && Harness.getProv) ? String(Harness.getProv() || '') : ''; } catch (_) { return ''; }
  }
  function ttsProviderOrder() {
    const p = runProvider();
    return TTS_PROVIDERS.indexOf(p) >= 0 ? [p].concat(TTS_PROVIDERS.filter(x => x !== p)) : TTS_PROVIDERS;
  }
  // the best TTS-capable credential the PAGE holds → {key, provider}. Empty key is fine (desktop / dev:
  // the sidecar resolves its own keychain/env credential); provider then rides along as '' too.
  function ttsCred() {
    if (typeof Harness !== 'undefined' && Harness.getKey) {
      for (const p of ttsProviderOrder()) { const k = Harness.getKey(p) || ''; if (k) return { key: k, provider: p }; }
    }
    return { key: '', provider: '' };
  }
  function ttsConfig() {
    // ONE LOCKED VOICE (Andrew, 2026-07-12): every agent, every persona, speaks as ULTRON —
    // Personas.STATION_VOICE (Algenib + machine shell). Personality changes the WORDS only; the
    // literal fallback below keeps the same identity if personas.js isn't loaded (tests, tools).
    // ttsStyle is the natural-language delivery instruction the sidecar folds into the input (and the
    // cache key). ttsShell is the "machine shell" FX chain ({metal,digitize,reverb} in 0..1) applied on
    // playback — Ultron's cold-metal body; a shell bypasses the transmission color (below).
    const v = (typeof Personas !== 'undefined' && Personas.STATION_VOICE) || null;
    return {
      model: TTS_MODEL,
      voice: (v && v.ttsVoice) || 'Algenib',
      speed: (v && v.ttsSpeed) || 1.0,
      style: (v && v.ttsStyle) || '',
      deep: !!(v && v.ttsDeep),
      shell: (v && v.ttsShell) || { metal: 1.0, digitize: 0.4, reverb: 0.6 }
    };
  }
  /* PRE-WARM the voice cache: when the speaker turns on, quietly synthesize the active persona's stock lines
     (ambient mutters + the sample reply) so those exact lines later play INSTANTLY from the sidecar's disk
     cache instead of paying a synth round-trip mid-conversation. Sequential + fire-and-forget + low urgency:
     never blocks the UI, never fights a live reply for bandwidth. Always asks the sidecar (it owns the tier
     ladder incl. a free keyless floor); skips only while the neural path is cooling off after a failure.
     Idempotent per persona so toggling doesn't re-warm needlessly. */
  let prewarmedFor = null;
  async function prewarmVoice() {
    if (!speakReplies) return;
    if (Date.now() < neuralColdUntil) return;        // neural path cooling off after a failure → don't hammer
    if (draining) return;                            // a LIVE reply owns the voice path — never warm in front of it
    if (prewarmedFor === activePersonaId) return;   // already warmed this persona's shelf
    prewarmedFor = activePersonaId;
    const p = (typeof Personas !== 'undefined' && Personas.get) ? Personas.get(activePersonaId) : null;
    if (!p) return;
    const cfg = ttsConfig(), cred = ttsCred();
    const lines = [];
    if (Array.isArray(p.ambientLines)) for (const l of p.ambientLines) lines.push(l);
    if (p.sampleVoiceReply) lines.push(p.sampleVoiceReply);
    for (const raw of lines) {
      const text = speakable(raw);
      if (!text) continue;
      // a reply started mid-warm → YIELD the provider to it at once. Background warm calls racing the live
      // reply's chunks is exactly how a rate-limited provider 429s the reply's second sentence — and a single
      // failed chunk is what used to take the whole rest of the reply down with it. Re-armed for a later warm.
      if (draining) { prewarmedFor = null; break; }
      try {
        // warm the SAME cache key the live path will request (model|voice|style|text) — we only need the
        // sidecar to synthesize + cache it; we discard the audio. A failure is silent (best-effort).
        const r = await fetch('/api/tts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: cred.key, keyProvider: cred.provider, preferProvider: runProvider(), text, model: cfg.model, voice: cfg.voice, style: cfg.style })
        });
        try { await r.arrayBuffer(); } catch (_) {}
      } catch (_) { break; }   // network gone → stop warming, don't hammer
      if (!speakReplies) break;   // user muted mid-warm → abandon
    }
  }

  /* text → speakable: strip what TTS would otherwise read LITERALLY (markdown, emoji, URLs/paths, and
     ALL-CAPS names it'd spell out letter-by-letter). VOICE_MODE_RULES only ASKS the model to avoid these;
     this is the enforcement the prompt can't guarantee. Pure + cheap; runs on every spoken line. */
  function speakable(s) {
    s = String(s || '');
    s = s.replace(/\b(?:FORK|TASK_QUESTION)\s*:[^\n]*/gi, ' ');     // choice markers (chips carry them; spoken they're "pipe pipe" + every option) — chat.js suppresses these upstream, this is the last line of defense
    s = s.replace(/```[\s\S]*?```/g, ' ');                          // code fences
    s = s.replace(/`([^`]+)`/g, '$1');                              // inline code
    s = s.replace(/!?\[([^\]]*)\]\(([^)]+)\)/g, '$1');              // [label](url) / ![alt](url) → label
    s = s.replace(/https?:\/\/\S+/g, 'a link');                     // bare URLs
    s = s.replace(/(^|\s)[~.]?[\/\\][\w./\\-]+/g, '$1that file');   // file paths → "that file"
    s = s.replace(/(^|\s)[A-Za-z]:[\/\\][\w./\\-]+/g, '$1that file'); // Windows drive paths (C:\…) — else TTS spells them out
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
      // an oversize sentence gets hard-sliced straight into `out` — flush the accumulator FIRST or the
      // preceding sentences would play AFTER this one's head slices (out-of-order speech).
      if (s.length > max && cur.trim()) { out.push(cur.trim()); cur = ''; }
      while (s.length > max) { out.push(s.slice(0, max).trim()); s = s.slice(max); }
      if ((cur + s).length > max) { if (cur.trim()) out.push(cur.trim()); cur = s; } else cur += s;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  let currentAudio = null, currentAudioCleanup = null;
  function stopAudio() {
    if (currentAudio) { try { currentAudio.pause(); } catch (_) {} currentAudio = null; }
    // pause() does not fire `ended`, so revoke the blob URL here as well as on a natural finish.
    // This path is used by barge-in and replacement playback and must not leak one URL per turn.
    if (currentAudioCleanup) {
      const cleanup = currentAudioCleanup;
      currentAudioCleanup = null;
      try { cleanup(); } catch (_) {}
    }
    onSpeakEnd();
  }

  /* ---- "transmission" color on neural playback -------------------------------------------------
     A subtle atmosphere pass so the crew sounds like a voice coming over the station's comms, not a
     browser <audio> tag. SUBTLE by design — the voice stays fully intelligible; this is seasoning, not a
     walkie-talkie gimmick. Chain: highpass ~120Hz + lowpass ~7kHz (band-limit to a comms channel) →
     a whisper of WaveShaper saturation → a very low-mix ~90ms slapback echo → out. One shared AudioContext,
     created lazily on the first neural play (after a gesture) and reused. Fully guarded: any failure (no
     WebAudio, a browser that won't route a blob through MediaElementSource) falls back to plain <audio>. */
  const TRANSMISSION_FX = true;   // module toggle — set false to ship the neural voice dry
  let fxCtx = null, fxIn = null, fxReady = false, fxBroken = false;
  // A TAP on the chain's output, so the live panel can meter the agent's voice from the SAME signal the
  // speakers get. Its own try/catch: an engine without createAnalyser must lose the meter, never the voice.
  let fxAnalyser = null;
  // a mild tanh-ish curve → gentle harmonic warmth, NOT distortion. `k` small = barely-there.
  function makeSaturationCurve(k) {
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); }
    return curve;
  }
  function ensureFxGraph() {
    if (fxReady || fxBroken) return fxReady;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { fxBroken = true; return false; }
      fxCtx = new AC();
      // input node every source connects to → the processing chain → destination.
      fxIn = fxCtx.createGain();
      const hp = fxCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120;
      const lp = fxCtx.createBiquadFilter(); lp.type = 'lowpass';  lp.frequency.value = 7000;
      const sat = fxCtx.createWaveShaper(); sat.curve = makeSaturationCurve(1.6); sat.oversample = '2x';
      const drive = fxCtx.createGain(); drive.gain.value = 0.9;   // trim the tiny level bump saturation adds
      // slapback: a short delayed, low-gain copy summed back in — a hair of "room on the channel".
      const delay = fxCtx.createDelay(0.5); delay.delayTime.value = 0.09;
      const echo = fxCtx.createGain(); echo.gain.value = 0.10;    // whisper-low mix
      const out = fxCtx.createGain(); out.gain.value = 1.0;
      fxIn.connect(hp); hp.connect(lp); lp.connect(sat); sat.connect(drive);
      drive.connect(out);                 // dry (processed) path
      drive.connect(delay); delay.connect(echo); echo.connect(out);   // slapback path
      out.connect(fxCtx.destination);
      // parallel tap — an AnalyserNode reads whatever reaches it and needs no output of its own
      try { fxAnalyser = fxCtx.createAnalyser(); fxAnalyser.fftSize = 1024; out.connect(fxAnalyser); } catch (_) { fxAnalyser = null; }
      fxReady = true;
      return true;
    } catch (_) { fxBroken = true; try { if (fxCtx) fxCtx.close(); } catch (__) {} fxCtx = null; fxIn = null; return false; }
  }
  // route an <audio> element through the FX graph. Returns true if wired; false → caller plays it dry.
  // Each element gets ONE MediaElementSource (creating a second on the same element throws), tracked via _fxSrc.
  function routeThroughFx(a) {
    if (!TRANSMISSION_FX) return false;
    if (!ensureFxGraph()) return false;
    try {
      if (fxCtx.state === 'suspended') { try { fxCtx.resume(); } catch (_) {} }
      if (!a._fxSrc) a._fxSrc = fxCtx.createMediaElementSource(a);
      a._fxSrc.connect(fxIn);
      return true;
    } catch (_) { return false; }   // routing failed → dry playback (the element still outputs normally)
  }

  /* ---- MACHINE SHELL — a persona's cold-metal body (personas.js: ttsShell {metal,digitize,reverb}) --------
     Ultron's voice: a low raspy human (Algenib) pushed through a metal shell. Tuned live in the voicelab and
     ported here VERBATIM so in-game == what was auditioned. Layers, each 0..1:
       metal    → two parallel comb resonators (~278Hz body + ~870Hz sheen) = the metallic ring
       digitize → a bit-depth quantizer (11→4 bits) + a 47Hz ring-mod shimmer = the "synthesized" edge
       reverb   → a synthetic metal-chamber impulse (rings ~950Hz) = voice inside the chassis
     Compression + band-limit (95Hz/8.5k) + a presence peak sit in front. The dry human voice yields as metal
     and digitize rise but never below 0.15 (the human stays underneath). Its own AudioContext; a shell persona
     BYPASSES routeThroughFx. Fully guarded: any failure → the caller's transmission/dry fallback. */
  let shCtx = null, shIn = null, shN = null, shBroken = false;
  let shAnalyser = null;    // the shell chain's own output tap (see fxAnalyser)
  function makeQuantCurve(bits) {
    const n = 4096, c = new Float32Array(n), L = Math.pow(2, bits);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.round(x * L) / L; }
    return c;
  }
  function makeMetalIR(ctx, dur) {
    const sr = ctx.sampleRate, len = Math.max(1, (dur * sr) | 0), buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) { const t = i / sr, env = Math.exp(-t * 5.5), ring = 0.55 + 0.45 * Math.sin(2 * Math.PI * 950 * t + ch * 1.7); d[i] = (Math.random() * 2 - 1) * env * ring * 0.5; } }
    return buf;
  }
  function ensureShellGraph() {
    if (shN || shBroken) return !!shN;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) { shBroken = true; return false; }
      shCtx = new AC();
      shIn = shCtx.createGain();
      const comp = shCtx.createDynamicsCompressor();
      comp.threshold.value = -28; comp.knee.value = 18; comp.ratio.value = 7; comp.attack.value = 0.004; comp.release.value = 0.12;
      const hp = shCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 95;
      const lp = shCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 8500;
      const peak = shCtx.createBiquadFilter(); peak.type = 'peaking'; peak.frequency.value = 2800; peak.Q.value = 1.1; peak.gain.value = 0;
      const delay = shCtx.createDelay(0.05); delay.delayTime.value = 0.0036;
      const fb = shCtx.createGain(); fb.gain.value = 0;
      const mix = shCtx.createGain(); mix.gain.value = 0;
      const delay2 = shCtx.createDelay(0.05); delay2.delayTime.value = 0.00115;
      const fb2 = shCtx.createGain(); fb2.gain.value = 0;
      const mix2 = shCtx.createGain(); mix2.gain.value = 0;
      const rm = shCtx.createGain(); rm.gain.value = 0;
      const osc = shCtx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 47;
      const rmDepth = shCtx.createGain(); rmDepth.gain.value = 1.0;
      osc.connect(rmDepth); rmDepth.connect(rm.gain); osc.start();
      const rmMix = shCtx.createGain(); rmMix.gain.value = 0;
      const quant = shCtx.createWaveShaper(); quant.curve = makeQuantCurve(11); quant.oversample = 'none';
      const qMix = shCtx.createGain(); qMix.gain.value = 0;
      const conv = shCtx.createConvolver(); conv.buffer = makeMetalIR(shCtx, 0.9);
      const revMix = shCtx.createGain(); revMix.gain.value = 0;
      const dry = shCtx.createGain(); dry.gain.value = 1.0;
      const out = shCtx.createGain(); out.gain.value = 0.96;
      shIn.connect(comp); comp.connect(hp); hp.connect(lp); lp.connect(peak);
      peak.connect(dry); dry.connect(out);
      peak.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(mix); mix.connect(out);
      peak.connect(delay2); delay2.connect(fb2); fb2.connect(delay2); delay2.connect(mix2); mix2.connect(out);
      peak.connect(rm); rm.connect(rmMix); rmMix.connect(out);
      peak.connect(quant); quant.connect(qMix); qMix.connect(out);
      peak.connect(conv); conv.connect(revMix); revMix.connect(out);
      out.connect(shCtx.destination);
      try { shAnalyser = shCtx.createAnalyser(); shAnalyser.fftSize = 1024; out.connect(shAnalyser); } catch (_) { shAnalyser = null; }
      shN = { comb: { fb, mix }, comb2: { fb: fb2, mix: mix2 }, rmMix, quant, qMix, revMix, peak, dry };
      return true;
    } catch (_) { shBroken = true; try { if (shCtx) shCtx.close(); } catch (__) {} shCtx = null; shIn = null; return false; }
  }
  // set the shell amounts from a persona cfg {metal,digitize,reverb} (0..1). Identical math to the voicelab.
  function applyShellAmounts(cfg) {
    if (!shN) return;
    const m = Math.max(0, Math.min(1, +cfg.metal || 0)), d = Math.max(0, Math.min(1, +cfg.digitize || 0)), r = Math.max(0, Math.min(1, +cfg.reverb || 0));
    shN.comb.fb.gain.value = 0.30 + m * 0.35; shN.comb.mix.gain.value = m * 0.34;
    shN.comb2.fb.gain.value = 0.25 + m * 0.35; shN.comb2.mix.gain.value = m * 0.26;
    shN.peak.gain.value = m * 6;
    shN.quant.curve = makeQuantCurve(Math.round(11 - d * 7)); shN.qMix.gain.value = d * 1.0; shN.rmMix.gain.value = d * 0.30;
    shN.revMix.gain.value = r * 1.1;
    shN.dry.gain.value = Math.max(0.15, 1.0 - m * 0.18 - d * 0.60);
  }
  function routeThroughShell(a, cfg) {
    if (!ensureShellGraph()) return false;
    try {
      if (shCtx.state === 'suspended') { try { shCtx.resume(); } catch (_) {} }
      applyShellAmounts(cfg);
      if (!a._shSrc) a._shSrc = shCtx.createMediaElementSource(a);
      a._shSrc.connect(shIn);
      return true;
    } catch (_) { return false; }
  }

  // play an audio blob (mp3/wav), wiring start/end into the same speaking-state + loop hooks as the
  // browser path. playbackRate gives the per-personality pacing (Gemini TTS takes no speed param).
  // deep=true disables pitch-preservation, so a sub-1 rate lowers PITCH along with pace — the character-
  // voice register (persona ttsDeep). Vendor-prefixed setters for older engines; all guarded.
  function playBlob(blob, onEnd, volume, onFail, rate, deep, shell) {
    let url = null, a = null, done = false;
    const cleanup = () => {
      if (url) { try { URL.revokeObjectURL(url); } catch (_) {} url = null; }
      if (currentAudio === a) currentAudio = null;
      if (currentAudioCleanup === cleanup) currentAudioCleanup = null;
    };
    const endOk = () => { if (done) return; done = true; cleanup(); onSpeakEnd(); onEnd && onEnd(); };
    const endFailed = () => {
      if (done) return;
      done = true;
      cleanup();
      // A decode error may arrive after `onplay`; always leave speaking + metering before advancing.
      onSpeakEnd();
      if (onFail) onFail();
      else if (onEnd) onEnd();
    };
    try {
      stopAudio();
      url = URL.createObjectURL(blob);
      a = new Audio(url); currentAudio = a;
      currentAudioCleanup = cleanup;
      a.volume = (volume == null ? 1 : volume);
      if (rate && rate > 0) a.playbackRate = Math.max(0.5, Math.min(2, rate));
      if (deep) { try { a.preservesPitch = false; } catch (_) {} try { a.webkitPreservesPitch = false; } catch (_) {} try { a.mozPreservesPitch = false; } catch (_) {} }
      // add the station "transmission" color (guarded; dry playback if WebAudio routing fails). When routed
      // through WebAudio, crossOrigin must be set before load for some engines — the blob is same-origin so
      // this is a no-op, but harmless. Routing an element captures its output into the graph → the element's
      // own output goes silent, so ONLY route when the graph actually wires up.
      // A persona with a machine shell (Ultron) routes through the shell and SKIPS the transmission color; if
      // the shell graph can't wire, fall back to transmission (best-effort) rather than nothing.
      // remember WHICH chain took this element — that chain's tap is what the live meter reads.
      if (shell && routeThroughShell(a, shell)) outAnalyser = shAnalyser;
      else if (routeThroughFx(a)) outAnalyser = fxAnalyser;
      else outAnalyser = null;              // dry playback: no tap, so the meter reports nothing rather than lying
      a.onplay = () => onSpeakStart();
      a.onended = endOk;
      // a decode/format error on the neural blob is exactly the "try the browser voice" case — route
      // it to onFail (fallback) rather than treating it as a clean finish (which would go SILENT).
      a.onerror = endFailed;
      const p = a.play();
      if (p && p.catch) p.catch(err => {
        if (done) return;
        // browser still blocking audio (no gesture yet) → tell the user instead of going silently quiet
        if (err && err.name === 'NotAllowedError') setStatus('🔇 tap anywhere to turn on the agent\'s voice');
        endFailed();
      });
    } catch (_) { endFailed(); }
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
  let preferLocalTts = false;
  let playIdx = 0;        // next job to PLAY
  let synthIdx = 0;       // next job to begin SYNTHESIZING (runs ahead of playIdx for prefetch)
  let draining = false;   // a reply is in progress (queue non-empty or awaiting more chunks)
  let replyClosed = true; // producer has signalled "no more chunks for this reply"
  let playing = false;    // a chunk is currently playing (serializes playback)
  let speakSeq = 0;       // monotonic token; bump to invalidate all in-flight speak work
  let ttsAbort = null;    // controller of the most-recent in-flight fetch
  let onReplyDone = null; // heartbeat fired ONCE when the whole reply finishes (→ maybeRearm)
  const MAX_INFLIGHT = 2;        // synth at most this many chunks ahead of playback
  const TTS_CHUNK_MAX = 1000;    // keep each synth call under the sidecar's 1200-char cap

  function resetQueue() { jobs = []; playIdx = 0; synthIdx = 0; draining = false; playing = false; replyClosed = true; replyFails = 0; replyTried = false; }

  // begin synthesizing one job → resolves to {kind:'neural',blob} | {kind:'silent'} | {kind:'skip'}.
  // 'neural' plays; 'silent' means "no neural audio for this chunk — advance the queue, stay quiet" (there
  // is NO robotic fallback); 'skip' is an intentional barge-in/teardown cancel. The page holds no key on
  // desktop — the sidecar /api/tts resolves its own credential (keychain/env) or the free keyless floor.
  // ONE round-trip for one chunk → {kind:'neural',blob} | {kind:'fail',reason} | {kind:'skip'}. Deliberately
  // records NO failure state: startSynth owns the retry/cold-off policy so a retried blip isn't counted twice.
  function synthOnce(job) {
    const cred = ttsCred(), cfg = ttsConfig();
    const ac = new AbortController(); job.ac = ac; ttsAbort = ac;
    return fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({
        key: cred.key, keyProvider: cred.provider, preferProvider: runProvider(),
        text: job.text, model: cfg.model, voice: cfg.voice, style: cfg.style,
        local: preferLocalTts, localVoice: 'af_heart', speed: cfg.speed
      })
    }).then(async r => {
      const ct = r.headers.get('Content-Type') || '';
      if (r.ok && ct.indexOf('audio') === 0) { const blob = await r.blob(); if (blob && blob.size) return { kind: 'neural', blob }; }
      let reason = 'http ' + r.status;
      try { const j = await r.json(); if (j && j.reason) reason = j.reason; } catch (_) {}
      return { kind: 'fail', reason };
    }).catch(e => {
      if (e && e.name === 'AbortError') return { kind: 'skip' };   // intentionally cancelled — stay silent
      return { kind: 'fail', reason: 'network: ' + ((e && e.message) || e) };
    });
  }
  function startSynth(job) {
    if (job.result) return;
    // always ask the sidecar — it owns the tier ladder and decides what it can serve. The cold-off exists so
    // a DEAD provider isn't hammered once per sentence, but it must NEVER guillotine a reply that is ALREADY
    // SPEAKING: one transient blip on the second chunk used to skip every remaining chunk's round-trip, so the
    // agent stopped dead after its opening words ("it only says the first word", reported 2026-07-28). While a
    // reply is mid-flight we keep asking until THIS reply has failed MID_REPLY_GIVEUP times in a row; only then
    // does the cold-off apply to it. A reply that has not yet attempted anything (replyTried false — i.e. its
    // OPENING chunk) still honors the cold-off in full, so a dead provider is not hammered once per sentence.
    if (Date.now() < neuralColdUntil && (!replyTried || replyFails >= MID_REPLY_GIVEUP)) { job.result = Promise.resolve({ kind: 'silent' }); return; }
    replyTried = true;
    const seq = job.seq;
    job.result = synthOnce(job)
      // ONE immediate retry for a TRANSIENT failure (429 / network / 5xx) — a single provider blip must cost a
      // beat of latency, not a whole sentence of the reply. A missing credential and an empty wallet are NOT
      // transient: don't burn a second call on them. Ask retryableFallback, not the message class: a keyless
      // station's reason ALWAYS carried the structural 'no key', which made this branch dead code there.
      // A torn-down job (barge-in bumped speakSeq) is never retried.
      .then(res => (res.kind === 'fail' && retryableFallback(res.reason) && seq === speakSeq) ? synthOnce(job) : res)
      .then(res => {
        if (res.kind === 'neural') { noteNeuralOk(); return res; }
        if (res.kind === 'skip') return res;   // intentional barge-in/teardown cancel — not a failure
        replyFails++;
        // cool the neural path off briefly (noteFallback lengthens this for 'no key'/'credits'); never latch.
        neuralColdUntil = Date.now() + NEURAL_COLD_MS;
        console.warn('[voice] neural TTS unavailable → chunk silent:', res.reason);
        noteFallback(res.reason);
        return { kind: 'silent' };
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
        const cfg = ttsConfig();
        const rate = cfg.speed * (job.opts.speedMul || 1);
        // a decode/playback failure on the neural blob → advance (skip this chunk silently). No robotic fallback.
        playBlob(res.blob, advance, job.opts.volume, advance, rate, cfg.deep, cfg.shell);
      } else { advance(); }   // 'silent' (no neural audio) or 'skip' (aborted) → play nothing, keep the queue moving
    });
  }
  function finishReply() {
    const wasDraining = draining;
    resetQueue();
    duckSfx(false);
    if (wasDraining) { const cb = onReplyDone; onReplyDone = null; if (cb) cb(); }
  }

  // FIRST-WORD fast path: the time-to-first-audio is dominated by how long the FIRST TTS call takes, which
  // scales with the chunk's length. When a reply opens with one long chunk, peel a SHORT lead off the front
  // (first clause: comma/semicolon/dash, else a word break near ~120 chars) so the first synth call is tiny
  // and audio starts almost immediately; the remainder rides the normal queue behind it. Only splits a big
  // first chunk — short chunks are already fast, and later chunks already overlap playback. Returns [lead, rest]
  // or [whole] if no worthwhile split exists.
  const FASTPATH_MIN = 140;   // only bother splitting a first chunk longer than this
  function firstClauseSplit(s) {
    if (s.length <= FASTPATH_MIN) return [s];
    // prefer a natural clause boundary in the first ~130 chars. A SHORT lead is the whole point (fast first
    // audio), so take the earliest usable clause break; only fall back to a word split if there's none.
    const head = s.slice(0, 130);
    let cut = -1;
    const m = head.match(/^[\s\S]*?[,;:—–-](?=\s)/);    // up to & incl. the first clause punctuation followed by space
    if (m && m[0].length >= 10) cut = m[0].length;      // ≥10 so we don't split on a 2-3 char stub ("Oh, ")
    if (cut < 0) {                                        // no clause break → last word boundary before ~120
      const back = s.slice(0, 120).lastIndexOf(' ');
      if (back >= 40) cut = back;
    }
    if (cut < 0 || cut >= s.length - 10) return [s];      // nothing useful (or the split leaves a tiny tail)
    return [s.slice(0, cut).trim(), s.slice(cut).trim()];
  }

  /* ---- PRODUCER API ---- */
  // push one chunk of an in-progress reply (chat.js streams these sentence-by-sentence). The first chunk
  // opens a reply; endReply() closes it. mutter() rides the same path as a one-shot quiet aside.
  function speakChunk(text, voiceId, opts) {
    if (!speakReplies) return;
    if (voiceId) activeVoiceId = voiceId;
    opts = opts || {};
    const clean = speakable(text);
    let body = opts.mutter ? clean.slice(0, 80) : clean;
    if (!body.trim()) return;
    const opening = (jobs.length === 0);   // FIRST chunk of this reply → eligible for the fast-path lead split
    if (!opts.mutter) coordinatorEvent('onAssistant', { text: body, opening });
    replyClosed = false; draining = true;
    // on the opening chunk, peel a short lead so the first synth call (and thus first audio) is fast.
    let pieces;
    if (opening && !opts.mutter) {
      const [lead, rest] = firstClauseSplit(body);
      pieces = rest ? [lead].concat(splitForTts(rest, TTS_CHUNK_MAX)) : splitForTts(lead, TTS_CHUNK_MAX);
    } else {
      pieces = splitForTts(body, TTS_CHUNK_MAX);
    }
    for (const seg of pieces) { if (seg && seg.trim()) jobs.push({ text: seg, opts, seq: speakSeq, result: null, ac: null }); }
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

  // tear everything down NOW: invalidate in-flight work, abort fetches, cut audio.
  // Used by barge-in, mute, voice-mode-off, and DISCONNECT — the agent must go silent immediately.
  function stopSpeaking() {
    speakSeq++;
    for (const j of jobs) { if (j.ac) { try { j.ac.abort(); } catch (_) {} } }
    if (ttsAbort) { try { ttsAbort.abort(); } catch (_) {} ttsAbort = null; }
    stopAudio();
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
  // NB: a reply enqueues its chunks (draining=true) before the first <audio> starts, so chat.js's
  // run-end hook can land while `speaking` is still false but audio is imminent. We must treat that
  // enqueued/in-flight state as "not done" — otherwise the mic would re-open into the agent's own
  // voice (echo) or clip the not-yet-started reply (swallow). onReplyEnded then arms it.
  // "is the agent making (or about to make) sound?" — `draining` covers the whole streamed reply incl.
  // every inter-chunk fetch gap, `playing`/`currentAudio` cover the live neural <audio>. The loop waits
  // through all of it, or the re-opened mic would capture the agent's own voice (echo). (No synth queue
  // to consider — neural is the only voice path now.)
  function talking() { return draining || playing || !!currentAudio; }
  /* MUTING MID-REPLY MUST NOT WEDGE HANDS-FREE. The rearm heartbeat has exactly two triggers: chat.js's
     onTurnEnd(), which lands FIRST while audio is still draining and then correctly bails (the mic must
     never open into the agent's own voice), and the queue's onReplyDone. stopSpeaking() nulls onReplyDone,
     so muting the speaker while the agent was still speaking discarded the ONE surviving trigger — the mic
     never re-opened and the mode button went on reading 'hands-free ON' over a dead conversation. Every
     other stopSpeaking() caller covers itself (onMicClick re-arms after 150ms, stopConvo/init leave the
     mode entirely); the two mute paths were the leak, so they share this one. */
  function muteStopSpeaking() {
    stopSpeaking();
    if (convoMode) maybeRearm();
  }
  function maybeRearm() {
    if (!convoMode || !canListen() || rearmTimer) return;
    if (busyNow() || listening || talking()) return;   // not ready — a finishing event re-calls this
    const delay = REARM_DELAY;   // neural <audio> stops cleanly → a short echo guard is enough
    rearmTimer = setTimeout(() => {
      rearmTimer = null;
      if (convoMode && !busyNow() && !listening && !talking()) startListening();
    }, delay);
  }

  // turn hands-free on/off. ON jumps straight into listening; agents must be audible to converse,
  // so it also flips the speaker on. OFF tears the loop down.
  function toggleVoiceMode() {
    if (!canListen()) return;
    clearResumeCue();
    convoMode = !convoMode;
    coordinatorEvent('onState', 'listening');
    if (typeof SFX !== 'undefined') SFX.open();
    if (convoMode) {
      savePref(LS_CONVO, true);   // remember the hands-free intent so a refresh can offer one-tap resume
      if (!speakReplies) { speakReplies = true; savePref(LS_SPEAK, true); forcedSpeak = true; reflectToggle(); }  // you have to hear it (restored on exit)
      emptyStreak = 0;
      reflectMode();
      if ((!busyNow() || coordinator) && !listening && !speaking) startListening();
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
    if (was) coordinatorEvent('onState', 'ended');
  }

  // a silent listen in voice mode: try again a few times, then go passive so the mic isn't hot forever.
  function handleEmptyListen() {
    emptyStreak++;
    // Hands-free gave up after three "empty" listens without ever naming why. If those listens failed for a
    // REASON (a 403 after a respawn, a provider 500), say that instead of implying nobody spoke.
    if (emptyStreak >= MAX_EMPTY) { emptyStreak = 0; setStatus(takeDiag() || 'voice mode — tap 🎤 when ready'); return; }
    maybeRearm();
  }

  /* ======================================================================
     INPUT — speak to your agent (STT)
     ====================================================================== */

  let rec = null;
  /* the STT provider seam. start(cbs) opens a listen; callbacks: onInterim(partial), onFinal(text),
     onEnd(), onError(msg). Two implementations share this contract so the whole listen loop (push-to-talk
     + hands-free) is provider-agnostic:
       • recorderProvider  — MediaRecorder → POST /api/stt (server Whisper). The PREFERRED path everywhere
                             the mic can be recorded: verbatim transcripts (browser SR censors profanity),
                             and the only path on desktop (WebView2 has no SpeechRecognition). No interim
                             text (that's fine — the UI shows a live 'listening…' state instead).
       • webSpeechProvider — browser-native SpeechRecognition (real interim results, but Google-censored).
                             The FALLBACK: no MediaRecorder, `?stt=web`, or a keyless sidecar (the 'no key'
                             latch).
     `activeStt` is chosen once at module load and used everywhere; nothing else in this file references SR
     or MediaRecorder directly. */
  const webSpeechProvider = {
    name: 'web-speech',
    start(cbs) {
      if (!SR) { cbs.onError && cbs.onError('unsupported'); return; }
      const r = new SR();
      rec = r;
      // STALE-INSTANCE GUARD: a recognition that errored may fire its `onend` LATE — after the user has
      // started a fresh listen (rec now points at a NEW instance). Two hazards this closes:
      //   1. `rec = null` in a late onend would null the *new* instance → stop()/abort() silently no-op →
      //      a mic stuck listening forever.
      //   2. late onend/onerror would fire this listen's callbacks (onFinal/onEnd) into the module state of
      //      an unrelated live listen → swallowed transcript or a spuriously-cleared button.
      // `superseded()` is true once `rec` no longer points at THIS instance; a superseded instance goes quiet
      // and never touches module state. `settle()` nulls `rec` only if it still points here.
      const superseded = () => rec !== r;
      let ended = false;
      const settle = () => { if (rec === r) rec = null; };
      r.lang = 'en-US';
      r.interimResults = true;
      r.continuous = false;     // one utterance per push-to-talk press; auto-stops on a pause
      r.maxAlternatives = 1;
      let finalText = '';
      r.onresult = e => {
        if (superseded()) return;
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const rr = e.results[i];
          if (rr.isFinal) finalText += rr[0].transcript;
          else interim += rr[0].transcript;
        }
        cbs.onInterim && cbs.onInterim((finalText + interim).trim());
      };
      r.onerror = e => { if (superseded()) return; cbs.onError && cbs.onError((e && e.error) || 'error'); };
      r.onend = () => {
        if (ended) return; ended = true;   // some engines fire onend twice — deliver exactly once
        if (superseded()) return;           // a fresh listen already owns the mic; stay silent
        settle();
        cbs.onFinal && cbs.onFinal(finalText.trim()); cbs.onEnd && cbs.onEnd();
      };
      try { r.start(); } catch (_) { settle(); cbs.onError && cbs.onError('start-failed'); }
    },
    stop() { if (rec) { try { rec.stop(); } catch (_) {} } },          // flush + deliver the final result (push-to-talk send)
    abort() { if (rec) { try { rec.abort(); } catch (_) {} } }          // hard stop, suppress the final result (teardown)
  };

  /* recorderProvider — record the mic, POST the clip to /api/stt, deliver the transcription as onFinal.
     No browser-native STT is used, so this is what makes voice mode work on desktop (and under ?stt=recorder).
     Auto-stops on silence via a WebAudio AnalyserNode: it calibrates an ambient floor from the first ~300ms,
     then ends the take after ~1.4s below (floor + margin). Hard cap ~30s. stop() ends+delivers; abort()
     discards. A mic-permission denial is mapped to the SAME 'not-allowed' string SpeechRecognition emits, so
     the existing UX copy ('allow microphone access…') fires unchanged. */
  const REC = {
    SILENCE_MS: 1400,        // trailing quiet before we auto-stop
    HARD_CAP_MS: 30000,      // absolute ceiling on one take
    MIN_MS: 500,             // ignore silence detection for the first moment (let the speaker start)
    CALIBRATE_MS: 300,       // sample ambient level over this window to set the noise floor
    MARGIN: 0.010,           // RMS above (floor+margin) counts as speech
    // the SILENCE_MS cut only arms after a voiced frame — a take where you never speak would otherwise
    // hold the mic the full HARD_CAP (30s; ~90s of dead air across the hands-free retries). Cut a
    // never-voiced take here instead (≈ SpeechRecognition's own no-speech give-up). The clip still goes
    // to /api/stt — VAD miscalibration (e.g. talking during CALIBRATE_MS) must shorten the take, never
    // silently discard real words.
    NOSPEECH_MS: 6500
  };
  // ceiling on how long we wait for the mic-permission prompt / getUserMedia to settle. A DISMISSED prompt
  // (user clicks away without choosing) leaves the promise pending forever on WebView2 + some browsers; this
  // turns that into a recoverable 'mic-failed' instead of a mic button wedged in the 'rec' state until reload.
  const GUM_TIMEOUT_MS = 12000;
  const recorderProvider = (() => {
    let stream = null, mr = null, chunks = [], ac = null, analyser = null, rafId = null;
    let cb = null, mime = '', startedAt = 0, floor = null, lastVoiceAt = 0, calibrateUntil = 0, silenceTimer = null;
    let aborted = false, delivered = false, hardCapTimer = null;

    function pickMime() {
      const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      for (const m of prefs) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {} }
      return '';   // let the browser choose
    }
    function fmtFromMime(m) {
      if (/webm/.test(m)) return 'webm';
      if (/ogg/.test(m)) return 'ogg';
      if (/mp4|m4a|aac/.test(m)) return 'mp4';
      if (/wav/.test(m)) return 'wav';
      return 'webm';
    }
    function teardownAudio() {
      if (rafId) { try { cancelAnimationFrame(rafId); } catch (_) {} rafId = null; }
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      if (hardCapTimer) { clearTimeout(hardCapTimer); hardCapTimer = null; }
      if (ac) { try { ac.close(); } catch (_) {} ac = null; }
      analyser = null;
      if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch (_) {} stream = null; }
    }
    // WebAudio VAD: read the analyser's RMS each frame; below the calibrated floor for SILENCE_MS → stop().
    function watchLevel() {
      if (!analyser) return;
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        if (!analyser) return;
        try { analyser.getFloatTimeDomainData(buf); } catch (_) { rafId = requestAnimationFrame(tick); return; }
        let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();
        if (now < calibrateUntil) { floor = (floor == null) ? rms : Math.max(floor, rms); }   // ambient = loudest calm sample
        else {
          const thresh = (floor == null ? 0.02 : floor) + REC.MARGIN;
          if (rms > thresh) lastVoiceAt = now;
          // only arm the silence cut once we're past MIN_MS AND have heard at least one voiced frame
          if (now - startedAt > REC.MIN_MS && lastVoiceAt && (now - lastVoiceAt) > REC.SILENCE_MS) { stop(); return; }
          // never-voiced take → give up early instead of sitting hot until HARD_CAP (see REC.NOSPEECH_MS)
          if (!lastVoiceAt && (now - startedAt) > REC.NOSPEECH_MS) { stop(); return; }
        }
        // surface a coarse "still listening" pulse (no real interim text on this path) — dots by elapsed seconds
        if (cb && cb.onInterim) { const secs = Math.floor((now - startedAt) / 1000); cb.onInterim(secs > 0 ? '·'.repeat(Math.min(secs, 8)) : ''); }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }
    async function transcribe(blob) {
      const fmt = fmtFromMime(mime || blob.type || '');
      // desktop: apiKey() is '' (key is in the sidecar env) — send it as a header when we DO have one (browser).
      const key = apiKey();
      const headers = { 'Content-Type': blob.type || ('audio/' + fmt) };
      if (key) headers['X-OpenRouter-Key'] = key;
      const r = await fetch('/api/stt', { method: 'POST', headers, body: blob });
      const j = await r.json().catch(() => ({}));
      /* CHECK r.ok. `fetch` RESOLVES on 4xx/5xx, and the route's honest 200-degrade envelope is not the only
         thing that can come back: rejectBadApiToken answers 403 with the plain text 'forbidden token' BEFORE
         the route table is reached — the documented state after a sidecar respawn, where the page still holds
         the old X-StarNet-Token — and any 5xx/HTML/empty error body behaves the same. r.json() then rejects,
         the catch yields {}, and an UNREACHABLE endpoint was laundered into a CONFIRMED-EMPTY transcript:
         the user's spoken sentence disappeared with no error and no diagnostic, byte-identical to having said
         nothing into a dead room. An unknown is not an empty. */
      if (!r.ok && !(j && (j.text || j.reason))) {
        const reason = r.status === 403
          ? 'the station restarted — reload the page to reconnect'
          : 'transcription unreachable (HTTP ' + r.status + ')';
        console.warn('[voice] STT HTTP', r.status);
        return { text: '', reason, failed: true };
      }
      if (j && j.reason) console.warn('[voice] STT:', j.reason);
      return { text: (j && j.text) || '', reason: j && j.reason };
    }
    function finish() {
      if (delivered) return; delivered = true;
      const blob = chunks.length ? new Blob(chunks, { type: mime || 'audio/webm' }) : null;
      chunks = [];
      if (aborted || !blob || !blob.size) { cb && cb.onEnd && cb.onEnd(); return; }
      transcribe(blob).then(({ text, reason }) => {
        if (aborted) { cb && cb.onEnd && cb.onEnd(); return; }
        // setDiagStatus, not setStatus: cb.onEnd() below runs endListening() in this same synchronous block
        // and its restore would otherwise repaint 'online' over this before a single frame is drawn.
        if (!text && reason) { setDiagStatus('voice: ' + String(reason).slice(0, 60)); maybeFallbackToWebSpeech(reason); }
        cb && cb.onFinal && cb.onFinal(String(text || '').trim());
        cb && cb.onEnd && cb.onEnd();
      }).catch(e => {
        console.warn('[voice] STT post failed:', (e && e.message) || e);
        cb && cb.onError && cb.onError('stt-failed');
        cb && cb.onEnd && cb.onEnd();
      });
    }
    async function start(cbs) {
      cb = cbs; chunks = []; aborted = false; delivered = false; floor = null; lastVoiceAt = 0;
      try {
        // DEAD-BUTTON GUARD: getUserMedia can hang forever if the mic-permission prompt is DISMISSED (not
        // answered) — WebView2 and some browsers never settle the promise. Without a ceiling, `listening`
        // stays true and the mic button is wedged 'rec' until a page reload. Race the request against a
        // timeout so a stuck prompt degrades to a recoverable error instead of a permanently dead button.
        stream = await Promise.race([
          navigator.mediaDevices.getUserMedia({ audio: true }),
          new Promise((_, rej) => setTimeout(() => { const e = new Error('mic prompt timed out'); e.name = 'TimeoutError'; rej(e); }, GUM_TIMEOUT_MS))
        ]);
      } catch (e) {
        // NotAllowedError / SecurityError → the user (or policy) denied the mic. Map to the SR error string
        // so startListening()'s existing not-allowed branch (drop hands-free + clear copy) fires unchanged.
        const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
        cb && cb.onError && cb.onError(denied ? 'not-allowed' : 'mic-failed');
        return;
      }
      // RE-ENTRY GUARD: stop()/abort() may have run WHILE getUserMedia was in flight (user clicked the mic
      // again, or a teardown/barge-in landed). If so, don't spin up a hot recorder no one is listening to —
      // release the just-granted stream and bail. `aborted` is set by abort(); `delivered` by a stop() that
      // ran before the stream arrived (mr was still null → it went straight to finish()).
      if (aborted || delivered) { try { stream.getTracks().forEach(t => t.stop()); } catch (_) {} stream = null; return; }
      try {
        mime = pickMime();
        mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        mime = mr.mimeType || mime;
        mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        mr.onstop = () => { teardownAudio(); finish(); };
        mr.onerror = () => { teardownAudio(); if (!delivered) { cb && cb.onError && cb.onError('rec-error'); } };
        // WebAudio level meter for silence auto-stop (guarded — if it fails we still record, just no VAD).
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          ac = new AC(); const src = ac.createMediaStreamSource(stream);
          analyser = ac.createAnalyser(); analyser.fftSize = 2048; src.connect(analyser);
        } catch (_) { ac = null; analyser = null; }
        startedAt = Date.now(); calibrateUntil = startedAt + REC.CALIBRATE_MS; lastVoiceAt = 0;
        mr.start();
        watchLevel();
        hardCapTimer = setTimeout(() => { stop(); }, REC.HARD_CAP_MS);   // absolute ceiling
      } catch (e) {
        teardownAudio();
        cb && cb.onError && cb.onError('rec-failed');
      }
    }
    function stop() {   // end + deliver
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      if (mr && mr.state !== 'inactive') { try { mr.stop(); } catch (_) { teardownAudio(); finish(); } }
      else { teardownAudio(); finish(); }
    }
    function abort() {   // hard stop, discard (teardown / barge-in)
      aborted = true;
      if (mr && mr.state !== 'inactive') { try { mr.stop(); } catch (_) {} }
      teardownAudio();
      // deliver an onEnd so endListening() runs its teardown branch; onFinal is suppressed by `aborted`.
      if (!delivered) { delivered = true; cb && cb.onEnd && cb.onEnd(); }
    }
    return { name: 'recorder', start, stop, abort };
  })();

  // OAuth Live fallback for embedded Windows WebView2, which has MediaRecorder but no SpeechRecognition.
  // The local sidecar invokes the OS dictation engine against the default mic; no cloud speech key is used.
  const nativeSpeechProvider = (() => {
    let ac = null, hooks = null;
    async function start(h) {
      hooks = h; ac = new AbortController();
      try {
        const r = await fetch('/api/stt/native', { method: 'POST', signal: ac.signal });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error && !j.text) {
          if (j.error === 'no-speech') hooks && hooks.onError && hooks.onError('no-speech');
          else hooks && hooks.onError && hooks.onError('native-unavailable');
        } else if (j.text) hooks && hooks.onFinal && hooks.onFinal(j.text);
      } catch (e) {
        if (!(e && e.name === 'AbortError')) hooks && hooks.onError && hooks.onError('native-unavailable');
      } finally {
        const done = hooks; hooks = null; ac = null;
        if (done && done.onEnd) done.onEnd();
      }
    }
    function stop() {
      const done = hooks; hooks = null;
      if (ac) { try { ac.abort(); } catch (_) {} ac = null; }
      if (done && done.onEnd) done.onEnd();
    }
    function abort() { stop(); }
    return { name: 'native', start, stop, abort };
  })();

  /* provider selection: prefer the RECORDER (server Whisper via /api/stt) wherever the mic can be recorded.
     Browser-native SpeechRecognition (Chrome) is Google-served and CENSORS profanity to asterisks with no
     opt-out — the station must transcribe what you actually said, so web-speech is only the fallback:
     no MediaRecorder, `?stt=web`, or a sidecar with no STT credential (see the 'no key' latch below —
     keyless voice keeps working through the browser engine). `let`, not `const`: the latch swaps it. */
  let sttProvider =
    forceRecorder  ? (canRecordMic ? recorderProvider : webSpeechProvider) :
    forceWebSpeech ? webSpeechProvider :
    (canRecordMic ? recorderProvider : webSpeechProvider);
  const usingRecorder = () => sttProvider === recorderProvider;
  /* the 'no key' latch: /api/stt fail-opens with {text:'', reason:'no key'} when the sidecar has NO
     transcription credential (no Groq/OpenAI/OpenRouter key). A keyless browser session would otherwise
     get silent empty listens forever — fall back to browser-native SR (censored, but working) for the
     rest of the session. Any OTHER degrade reason (network, provider 4xx) does NOT latch: the credential
     exists, so the verbatim path stays preferred and the next listen re-tries it. */
  function maybeFallbackToWebSpeech(reason) {
    if (String(reason || '') !== 'no key') return;
    if (forceRecorder || !SR || sttProvider !== recorderProvider) return;
    sttProvider = webSpeechProvider;
    console.warn('[voice] server STT has no credential — falling back to browser speech recognition (it censors profanity; add a Groq/OpenAI/OpenRouter key for verbatim transcripts)');
  }

  function busyNow() { return typeof Chat !== 'undefined' && Chat.isBusy && Chat.isBusy(); }

  function startListening() {
    if (!canListen() || listening) return;
    if (busyNow() && !coordinator) { setStatus('busy — wait for the reply'); return; }  // classic mode stays half-duplex
    clearTimeout(rearmTimer); rearmTimer = null;
    stopSpeaking();                       // don't let the agent's voice bleed into the mic
    listening = true; sentThisListen = false; discarding = false; setMicState(true);
    dictShown = '';   // fresh listen: dictation has written nothing yet — a typed draft in the box stays untouchable
    savedStatus = currentStatusText();
    setStatus(convoMode ? 'voice mode — listening…' : 'listening…');
    if (typeof SFX !== 'undefined') SFX.open();
    sttProvider.start({
      onInterim: t => {
        coordinatorEvent('onInterim', String(t || ''));
        // DRAFT PROTECTION: an interim may only replace what dictation itself wrote — never a typed draft.
        // A non-empty composer that isn't our own last interim means the Commander is typing; leave it alone
        // (the status line still shows 'listening…', so dictation isn't silently lost — it lands via onFinal).
        if (!inputEl || (inputEl.value && inputEl.value !== dictShown)) return;
        inputEl.value = t; dictShown = t;
        if (typeof Chat !== 'undefined' && Chat.autoGrowInput) Chat.autoGrowInput();
      },
      onFinal: text => { submitTranscript(text); },
      onError: msg => {
        coordinatorEvent('onError', String(msg || 'speech recognition failed'));
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
        // a failed mic OPEN (timeout on a dismissed prompt, getUserMedia error, recorder start failure) is
        // recoverable — say so plainly and invite a retry, rather than a cryptic 'mic: mic-failed' dead end.
        if (msg === 'mic-failed' || msg === 'rec-failed' || msg === 'rec-error') setStatus('mic didn\'t open — click 🎤 to try again');
        else if (msg !== 'no-speech' && msg !== 'aborted') setStatus('mic: ' + msg);
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
    // A diagnostic written by this listen OUTRANKS the restore — savedStatus was captured at startListening,
    // before the failure existed, so it can never carry it.
    if (!busyNow() && !speaking) setStatus(takeDiag() || savedStatus || (convoMode ? 'voice mode on' : 'online'));
    coordinatorEvent('onState', busyNow() ? 'thinking' : 'ready');
  }

  // a final transcript from the mic — sent exactly like a typed message (busy/purpose/task/cost logic
  // is reused). The agent's spoken reply is driven by the 🔊 toggle in chat.js, not by this path.
  function submitTranscript(text) {
    if (discarding) return;   // teardown in progress — drop the buffered transcript, never send it
    const t = String(text || '').trim();
    // DRAFT PROTECTION (text-deletion bug): a listen used to clear the composer UNCONDITIONALLY here — wiping
    // whatever the Commander had TYPED whenever the mic finalized (even an empty/noise transcript). Only text
    // dictation itself wrote (dictShown, the interim preview) is ours to clear; a typed draft is never touched.
    if (inputEl && inputEl.value && inputEl.value === dictShown) { inputEl.value = ''; if (typeof Chat !== 'undefined' && Chat.autoGrowInput) Chat.autoGrowInput(); }
    dictShown = '';
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
    let handled = false;
    try { handled = !!(coordinator && typeof coordinator.onTranscript === 'function' && coordinator.onTranscript(t)); } catch (_) {}
    if (!handled && typeof Chat !== 'undefined' && Chat.send) Chat.send(t);
  }

  // mic button: interrupt the agent if it's talking (barge-in), else start/stop a listen. In voice
  // mode the loop manages re-opening; clicking just lets you jump in (or resume from passive).
  function onMicClick() {
    if (!canListen()) return;
    clearResumeCue();
    // barge-in: interrupt whenever the agent is making OR about to make sound (talking() also covers the
    // neural-fetch gap, where `speaking` is still false but a reply is imminent) — stopSpeaking aborts it.
    if (talking()) { stopSpeaking(); setTimeout(() => { if (!busyNow() && !listening) startListening(); }, 150); return; }
    if (convoMode) { if (!listening && !busyNow()) startListening(); return; }
    if (listening) stopListening(); else startListening();
  }

  function toggleListen() {
    if (!canListen()) return;
    if (listening) stopListening(); else startListening();
  }

  // OAuth/local live mode keeps authentication on the existing Chat/Codex path and deliberately selects
  // browser speech recognition for input, so the voice layer itself needs no transcription API credential.
  function startCoordinator(hooks) {
    if (!SR && typeof fetch === 'undefined') return false;
    coordinator = hooks || {};
    sttProvider = SR ? webSpeechProvider : nativeSpeechProvider;
    if (!convoMode) toggleVoiceMode();
    else if (!listening && !talking()) startListening();
    return true;
  }
  function stopCoordinator() {
    if (convoMode) stopConvo();
    coordinator = null;
  }
  // The downloaded local speech surface owns its persistent microphone/VAD loop, but still needs the mature
  // reply-stream hooks (captions, speaking state, barge-in) from this module.
  function attachCoordinator(hooks) { coordinator = hooks || {}; return true; }
  function detachCoordinator() {
    // End the meter while its listener still exists so the panel receives the final zero sample.
    stopOutputMeter();
    coordinator = null;
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
    /* The pinned degrade reason OUTRANKS the plain on/off copy. This tooltip is the only sanctioned channel
       for voice-outage telemetry (#chat-status is run-state only), so overwriting it unconditionally left the
       station silent while asserting 'agent voice: ON' with no way to find out why — the exact 2026-07-07
       escape the fbMsg machinery exists to prevent. Every path that legitimately clears the reason calls
       clearNeuralCold()/noteNeuralOk() first, which empty fbMsg; init() did not, and it runs on agent focus,
       persona change and dossier apply. Guarding here covers every caller instead of one. */
    toggleBtn.title = (speakReplies && fbMsg) ? fbMsg
      : (speakReplies ? 'agent voice: ON — click to mute' : 'agent voice: OFF — click to unmute');
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
    clearNeuralCold();     // ANY toggle re-probes the neural path fresh — no cold-off survives a deliberate flip
    if (!speakReplies) muteStopSpeaking();
    else prewarmVoice();   // turning ON → quietly warm the stock lines so mutters/samples play instantly
    reflectToggle();
    if (typeof SFX !== 'undefined') SFX.click();
  }
  function setSpeakReplies(on) {
    const want = on !== false;
    clearNeuralCold();     // ANY toggle re-probes the neural path fresh — no cold-off survives a deliberate flip
    if (speakReplies === want) { reflectToggle(); return speakReplies; }
    speakReplies = want; savePref(LS_SPEAK, speakReplies);
    forcedSpeak = false;
    if (!speakReplies) muteStopSpeaking();
    else prewarmVoice();
    reflectToggle();
    return speakReplies;
  }

  // init is called from app.js right after Chat.init — agentName seeds this agent's voice.
  function init(opts) {
    opts = opts || {};
    activeVoiceId = opts.name || 'agent';
    if (opts.personaId) activePersonaId = opts.personaId;
    convoMode = false;   // a fresh game session starts in push-to-talk; the toggle opts into hands-free
    clearTimeout(rearmTimer); rearmTimer = null; emptyStreak = 0;
    stopSpeaking();      // C4: cut any in-flight speech left by a PRIOR agent before this one takes the mic
    forcedSpeak = false; // C3: clear the "we force-enabled the speaker, restore on exit" bookkeeping so it never carries across agents
    inputEl = el('chat-input'); statusEl = el('chat-status');
    micBtn = el('chat-mic'); toggleBtn = el('voice-toggle'); modeBtn = el('voice-mode');

    if (micBtn) {
      if (!canListen()) micBtn.style.display = 'none';      // graceful degradation
      else { micBtn.onclick = () => onMicClick(); micBtn.innerHTML = ICON.mic; }
    }
    if (toggleBtn) {
      // The speaker toggle needs only Audio + fetch (neural playback) — it is NO LONGER hidden when
      // speechSynthesis is missing (the desktop WebView2 case, which has neural audio but no synth).
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
    // if the speaker is already on for this agent AND the harness is configured, warm the stock lines now
    // (background, fire-and-forget) so the very first mutter/sample plays from cache. No key → no-op.
    prewarmedFor = null;   // new agent/persona → allow a fresh warm
    if (speakReplies) prewarmVoice();
  }

  // let other code (or a future hotkey) retarget the active voice when the workstream's agent changes.
  function setAgent(name) { if (name) activeVoiceId = name; }

  // is the agent going to SPEAK this reply? true when the speaker toggle is on and this environment can
  // play neural audio (Audio + fetch) — NOT gated on speechSynthesis anymore. chat.js uses this to decide
  // whether a conversational turn is "voice mode" (short/casual spoken reply) vs "type mode" (written).
  function isOn() { return !!(speakReplies && canSpeak()); }

  return {
    init, speak, speakChunk, endReply, mutter, ambientLine, setAgent, isOn, setSpeakReplies,
    startListening, stopListening, toggleListen, stopSpeaking,
    toggleVoiceMode, stopConvo, onTurnEnd,
    canListen, canSpeak, startCoordinator, stopCoordinator, attachCoordinator, detachCoordinator,
    canOAuthLive: () => !!SR || typeof fetch !== 'undefined', personaId: () => activePersonaId,
    setLocalTts: value => { preferLocalTts = !!value; },
    // Which transcription engine is ACTUALLY selected right now ('recorder' | 'web' | 'native'). A UI that
    // names the engine has to read it rather than re-derive the selection rule, or the label drifts from
    // the truth the moment the ladder changes.
    sttEngine: () => (sttProvider && sttProvider.name) || '',
    isListening: () => listening, isSpeaking: () => speaking, inVoiceMode: () => convoMode
  };
})();
