/* voice-live.js — persistent local speech session over whichever provider powers the active Starnet agent. */
'use strict';

const VoiceLive = (() => {
  let active = false, ending = false, failed = false, taskTimer = null, modelTimer = null;
  let sessionSeq = 0;
  let stream = null, context = null, source = null, processor = null, sink = null;
  let calibratedUntil = 0, noiseFloor = 0.006, speechFrames = 0, silenceMs = 0;
  let recording = false, utterance = [], utteranceSamples = 0, preRoll = [], transcriptionPending = false, queuedAudio = null;
  let utteranceSeq = 0, partialPending = false, partialAbort = null, lastPartialAt = 0;
  let finalAbort = null;
  let reconnectTimer = null, reconnectAttempt = 0, transientErrorTimer = null;
  let warmupNotice = false;
  const $ = id => document.getElementById(id);
  const POSITION_KEY = 'starnet.liveVoice.position.v1';
  // Four shapes of ONE small pop-up module over ONE markup tree, so the readouts, the telemetry
  // wiring and the state machine can never drift between them — only the styling does.
  // pod (lamp + level + transcript) · tower (handheld) · eye (one big lens) · slate (level +
  // readout). Pop-up station hardware, never a typical window. VoiceLive.setSkin() flips live.
  const SKIN_KEY = 'starnet.liveVoice.skin.v1';
  const SKINS = ['pod', 'tower', 'eye', 'slate'];
  // Scope readout: a rolling window of mic RMS, oldest at the left. The bars ARE the microphone —
  // never animate them off a timer, or the panel would claim to hear a room it cannot hear.
  const WAVE_BARS = 17;
  let waveBars = null, waveHistory = new Array(WAVE_BARS).fill(0);

  function clampPanel(panel) {
    if (!panel || panel.hidden || !panel.style.left) return;
    const rect = panel.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, rect.left));
    const top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, rect.top));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function savePosition(panel) {
    try {
      const rect = panel.getBoundingClientRect();
      localStorage.setItem(POSITION_KEY, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
    } catch (_) {}
  }

  function restorePosition(panel) {
    try {
      const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
      if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;
      panel.style.left = `${saved.left}px`;
      panel.style.top = `${saved.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      requestAnimationFrame(() => clampPanel(panel));
    } catch (_) {}
  }

  function makeDraggable(panel) {
    const handle = panel.querySelector('.lv-head');
    if (!handle) return;
    let drag = null;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      panel.dataset.dragging = 'true';
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (!drag) return;
      const left = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, event.clientX - drag.x));
      const top = Math.max(8, Math.min(window.innerHeight - panel.offsetHeight - 8, event.clientY - drag.y));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    const release = event => {
      if (!drag) return;
      drag = null;
      delete panel.dataset.dragging;
      try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
      savePosition(panel);
    };
    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);
  }

  function ensurePanel() {
    if ($('live-voice-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'live-voice-panel';
    panel.className = 'live-voice-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', 'Starnet local live voice');
    panel.innerHTML = [
      '<header class="lv-head">',
        '<span class="lv-brand">LOCAL LIVE</span>',
        '<span class="lv-pip" aria-hidden="true"></span>',
        '<span id="lv-state" class="lv-state">CONNECTING</span>',
        '<button id="lv-close" class="x-btn lv-x" type="button" aria-label="End live voice" title="End live voice">✕</button>',
      '</header>',
      '<div class="lv-stage">',
        '<button id="lv-barge" class="lv-orb" type="button" aria-label="Interrupt and speak" title="Interrupt — speak now">',
          '<span class="lv-halo"></span><span class="lv-iris"></span><span class="lv-pupil"></span>',
        '</button>',
        '<div id="lv-wave" class="lv-wave" aria-hidden="true"></div>',
      '</div>',
      '<p id="lv-heard" class="lv-heard" aria-live="polite">Speak naturally — the transcript lands in COMMS.</p>',
      '<p id="lv-agent" class="lv-say"></p>',
      '<dl class="lv-rail">',
        '<div class="lv-row"><dt>ROUTE</dt><dd id="lv-route">LOCAL SPEECH · ACTIVE STARNET AGENT</dd></div>',
        '<div class="lv-row lv-row-dl"><dt>SPEECH</dt><dd id="lv-model">LOCAL MODELS: CHECKING</dd></div>',
        '<div class="lv-row"><dt>TASK</dt><dd id="lv-task" class="lv-task">No active task detected.</dd></div>',
      '</dl>',
      '<div id="lv-error" class="lv-error" hidden></div>',
      '<button id="lv-retry" class="lv-retry" type="button" hidden>TRY AGAIN</button>'
    ].join('');
    const wave = panel.querySelector('#lv-wave');
    for (let i = 0; i < WAVE_BARS; i++) wave.appendChild(document.createElement('i'));
    document.body.appendChild(panel);
    waveBars = Array.from(wave.children);
    applySkin(readSkin());
    restorePosition(panel);
    makeDraggable(panel);
    $('lv-close').onclick = end;
    $('lv-retry').onclick = () => start(true);
    $('lv-barge').onclick = bargeIn;
  }

  function readSkin() {
    try { const saved = localStorage.getItem(SKIN_KEY); if (SKINS.includes(saved)) return saved; } catch (_) {}
    return SKINS[0];
  }
  function applySkin(name) {
    const skin = SKINS.includes(name) ? name : SKINS[0];
    const panel = $('live-voice-panel');
    if (panel) {
      panel.dataset.skin = skin;
      // A skin changes the panel's whole silhouette, so a position saved under the old one can
      // strand it half off-screen. Re-clamp against the new geometry.
      requestAnimationFrame(() => clampPanel(panel));
    }
    return skin;
  }
  function setSkin(name) {
    const skin = applySkin(name);
    try { localStorage.setItem(SKIN_KEY, skin); } catch (_) {}
    return skin;
  }

  // Amplitude drives BOTH the scope and the orb bloom, so the panel's whole light level is the
  // real mic level — one signal, never a decorative loop pretending to be one.
  function pushLevel(value) {
    const level = Math.max(0, Math.min(1, value));
    waveHistory.push(level);
    waveHistory.shift();
    if (waveBars) for (let i = 0; i < waveBars.length; i++) {
      waveBars[i].style.transform = `scaleY(${(0.09 + waveHistory[i] * 0.91).toFixed(3)})`;
    }
    const panel = $('live-voice-panel');
    if (panel) panel.style.setProperty('--lv-amp', level.toFixed(3));
  }

  function resetLevel() {
    waveHistory = new Array(WAVE_BARS).fill(0);
    if (waveBars) waveBars.forEach(bar => { bar.style.transform = 'scaleY(0.09)'; });
    const panel = $('live-voice-panel');
    if (panel) panel.style.setProperty('--lv-amp', '0');
  }

  function setState(value) {
    const normalized = String(value || 'ready').toLowerCase();
    if ($('lv-state')) $('lv-state').textContent = normalized.toUpperCase();
    if ($('live-voice-panel')) $('live-voice-panel').dataset.state = normalized;
  }
  function setError(message) {
    const el = $('lv-error');
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || '';
    if ($('lv-retry')) $('lv-retry').hidden = !message;
  }
  function setTransientError(message, ms = 4500) {
    setError(message);
    clearTimeout(transientErrorTimer);
    transientErrorTimer = setTimeout(() => { if (active) setError(''); }, ms);
  }
  // 'user' writes the heard line, 'agent' the reply line. These IDs must exist in ensurePanel —
  // the first draft addressed a #lv-user that was never built, so every reply the controller
  // spoke ("Approved once.", "Queued behind the current task.") was painted into nothing.
  function caption(who, text, append) {
    const el = $(who === 'user' ? 'lv-heard' : 'lv-agent');
    if (!el || text == null) return;
    el.textContent = append ? el.textContent + String(text) : String(text);
    if (el.id === 'lv-agent') el.classList.toggle('on', !!el.textContent.trim());
  }

  function statusSnapshot() {
    if (typeof Workstreams === 'undefined' || typeof Channels === 'undefined') return { active: null, workstreams: [] };
    const current = Workstreams.active();
    return {
      active: current ? current.id : null,
      workstreams: Workstreams.list().slice(0, 12).map(ws => ({
        id: ws.id, title: ws.title || 'General', lane: ws.lane || null,
        busy: Channels.isBusy(ws.id), status: Channels.statusOf(ws.id),
        approvalRequired: !!Channels.pendingOf(ws.id)
      }))
    };
  }

  function providerName(value) {
    const id = String(value || '').trim().toLowerCase();
    const names = { codex: 'CODEX', openai: 'OPENAI', openrouter: 'OPENROUTER', gemini: 'GEMINI', anthropic: 'ANTHROPIC', grok: 'GROK', kimi: 'KIMI' };
    return names[id] || (id ? id.replace(/[-_]+/g, ' ').toUpperCase() : 'MODEL NOT CONNECTED');
  }

  function refreshRoute() {
    const el = $('lv-route');
    if (!el) return;
    let provider = '', model = '', agent = '';
    try {
      if (typeof Harness !== 'undefined') {
        provider = Harness.getProv ? Harness.getProv() : '';
        model = Harness.getModel ? Harness.getModel() : '';
      }
      const select = $('comms-agent-select');
      if (select) agent = select.options && select.selectedIndex >= 0
        ? select.options[select.selectedIndex].textContent : select.value;
    } catch (_) {}
    const route = [providerName(provider), String(agent || '').trim().toUpperCase()].filter(Boolean).join(' · ');
    el.textContent = `LOCAL SPEECH · ${route}`;
    el.title = model ? `${providerName(provider)} · ${model}` : providerName(provider);
  }

  function refreshTask() {
    const el = $('lv-task');
    refreshRoute();
    if (!el || typeof Workstreams === 'undefined' || typeof Channels === 'undefined') return;
    const ws = Workstreams.active();
    if (!ws) { el.textContent = 'No active workstream.'; return; }
    const busy = Channels.isBusy(ws.id), pending = Channels.pendingOf(ws.id);
    el.textContent = (pending ? 'APPROVAL NEEDED · ' : busy ? 'WORKING · ' : 'READY · ') + (ws.title || 'GENERAL');
    el.title = pending ? `${pending.tool || 'Action'} needs approval${pending.argsSummary ? `: ${pending.argsSummary}` : ''}` : (Channels.statusOf(ws.id) || ws.title || 'Ready');
    el.classList.toggle('busy', busy);
    el.classList.toggle('pending', !!pending);
  }

  async function pollModels() {
    try {
      const response = await fetch('/api/local-voice/status', { cache: 'no-store' });
      const data = await response.json();
      const percent = data.progress && data.progress.percent != null ? data.progress.percent : null;
      const progress = percent != null ? ` ${percent}%` : '';
      if ($('lv-model')) $('lv-model').textContent = `ASR ${String(data.asr).toUpperCase()} · VOICE ${String(data.tts).toUpperCase()}${progress}`;
      // A download that reports a percent gets a real fill behind the row; no percent, no fill.
      const shell = $('live-voice-panel');
      if (shell) shell.style.setProperty('--lv-dl', percent != null ? `${percent}%` : '0%');
      const currentState = $('live-voice-panel') && $('live-voice-panel').dataset.state;
      if (data.asr === 'ready' && active && !recording && !transcriptionPending &&
          /^(?:connecting|warming|reconnecting)$/.test(currentState || '')) {
        setState('listening');
        // The warm-up notice claimed models were still downloading long after they were ready —
        // it is the ONLY line we are allowed to retract, and only once its claim stops being true.
        if (warmupNotice) { warmupNotice = false; caption('agent', ''); }
      }
      if (data.error && (data.asr === 'error' || data.tts === 'error')) setError(`Local speech model failed: ${data.error}`);
      return data;
    } catch (_) {
      if ($('lv-model')) $('lv-model').textContent = 'LOCAL MODELS: SIDECAR OFFLINE';
      return null;
    }
  }

  function speakLocal(text) {
    caption('agent', text);
    if (typeof Voice !== 'undefined' && Voice.speak) Voice.speak(text);
  }

  function answerStatusQuestion() {
    const snap = statusSnapshot();
    const current = snap.workstreams.find(item => item.id === snap.active);
    const busy = snap.workstreams.filter(item => item.busy);
    const approvals = snap.workstreams.filter(item => item.approvalRequired);
    let lead = !current ? 'There is no active task.'
      : current.approvalRequired ? `${current.title} is waiting for your approval.`
      : current.busy ? `${current.title} is still working. ${current.status || ''}`.trim()
      : `${current.title} is ready.`;
    const otherBusy = busy.filter(item => !current || item.id !== current.id).length;
    const otherApprovals = approvals.filter(item => !current || item.id !== current.id).length;
    if (otherBusy) lead += ` ${otherBusy} other ${otherBusy === 1 ? 'task is' : 'tasks are'} running.`;
    if (otherApprovals) lead += ` ${otherApprovals} other ${otherApprovals === 1 ? 'task needs' : 'tasks need'} approval.`;
    return lead;
  }

  function agentCommand(value, lower) {
    const select = $('comms-agent-select');
    if (!select) return false;
    if (/^(?:list|who are) (?:my )?agents$/.test(lower)) {
      const names = Array.from(select.options || []).map(option => String(option.textContent || option.value).trim()).filter(Boolean);
      speakLocal(names.length ? `Your agents are ${names.join(', ')}.` : 'There are no agents available.');
      return true;
    }
    const match = /^(?:switch|talk|speak) to (?:agent )?(.+)$/i.exec(value);
    if (!match) return false;
    const wanted = match[1].trim().toLowerCase();
    const option = Array.from(select.options || []).find(item =>
      String(item.value || '').toLowerCase() === wanted ||
      String(item.textContent || '').trim().toLowerCase() === wanted);
    if (!option) {
      speakLocal(`I could not find an agent named ${match[1].trim()}.`);
      return true;
    }
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    refreshRoute();
    speakLocal(`Now talking to ${String(option.textContent || option.value).trim()}.`);
    return true;
  }

  function approvalCommand(lower) {
    if (typeof Workstreams === 'undefined' || typeof Channels === 'undefined') return false;
    const ws = Workstreams.active();
    const pending = ws && Channels.pendingOf(ws.id);
    if (!pending) return false;
    let decision = '';
    if (/^(?:approve|approve once|yes[, ]+approve|allow it|go ahead)$/.test(lower)) decision = 'once';
    else if (/^(?:always allow|approve always|always approve)$/.test(lower)) decision = 'always';
    else if (/^(?:deny|deny it|do not allow|don't allow|reject)$/.test(lower)) decision = 'deny';
    if (!decision) return false;

    // The visible card owns specialized approval effects and settlement. The run-scoped fallback covers the
    // short interval where Channels knows about a prompt before COMMS has painted its buttons.
    const buttons = Array.from(document.querySelectorAll('#chat-log .cmsg.consent .consent-btn'));
    const wanted = decision === 'deny' ? /deny|cancel/i : decision === 'always' ? /^always$/i : /approve once|open login|done/i;
    const button = buttons.reverse().find(item => wanted.test(String(item.textContent || '').trim()) && !item.disabled);
    if (button) button.click();
    else {
      const runId = Channels.runIdOf(ws.id) || pending.runId;
      if (typeof Harness !== 'undefined' && Harness.consent) Harness.consent(runId, pending.promptId, decision);
      Channels.clearPending(ws.id, Date.now());
      try { if (typeof U !== 'undefined' && U.bus) U.bus.emit('permission.response', { promptId: pending.promptId, decision }); } catch (_) {}
    }
    speakLocal(decision === 'deny' ? 'Denied.' : decision === 'always' ? 'Always allowed.' : 'Approved once.');
    refreshTask();
    return true;
  }

  function handleTranscript(text) {
    const value = String(text || '').trim();
    if (!value) { setState('listening'); return true; }
    caption('user', value);
    caption('agent', '');
    setState('thinking');
    refreshTask();
    const lower = value.toLowerCase().replace(/[.!?]+$/, '').trim();
    if (approvalCommand(lower)) return true;
    if (agentCommand(value, lower)) return true;
    if (/^(?:what(?:'s| is) (?:the )?status|status update|task status|what are (?:my )?agents doing|how(?:'s| is) (?:it|the task) going)$/.test(lower)) {
      speakLocal(answerStatusQuestion());
      return true;
    }
    const stopOnly = /^(?:stop|cancel|interrupt|hold on|wait|never ?mind)(?: the task| that)?$/.test(lower);
    const redirect = /^(?:stop|cancel|interrupt|hold on|wait)[,;:\s]+(.{3,})$/i.exec(value);
    if (stopOnly) {
      const wasBusy = !!(typeof Chat !== 'undefined' && Chat.isBusy && Chat.isBusy());
      if (wasBusy && Chat.stopActive) Chat.stopActive();
      speakLocal(wasBusy ? 'Stopped.' : 'Nothing is running.');
      return true;
    }
    if (redirect && typeof Chat !== 'undefined') {
      if (Chat.isBusy && Chat.isBusy() && Chat.stopActive) Chat.stopActive();
      const next = redirect[1].trim();
      if (Chat.sendOrQueue) Chat.sendOrQueue(next);
      caption('agent', 'Changing direction.');
      refreshTask();
      return true;
    }
    if (typeof Chat === 'undefined' || !Chat.sendOrQueue) {
      setError('The signed-in Starnet agent is not ready yet.');
      return true;
    }
    const result = Chat.sendOrQueue(value);
    caption('agent', result && result.state === 'queued' ? 'Queued behind the current task.' : 'Working on it.');
    refreshTask();
    return true;
  }

  function onAssistant(part) {
    part = part || {};
    caption('agent', part.text || '', !part.opening);
  }
  function onState(state) {
    if (!active || state === 'ended') return;
    setState(state === 'ready' ? 'listening' : state);
    refreshTask();
  }

  function downsample(frames, fromRate) {
    let total = 0;
    for (const frame of frames) total += frame.length;
    const input = new Float32Array(total);
    let offset = 0;
    for (const frame of frames) { input.set(frame, offset); offset += frame.length; }
    if (fromRate === 16000) return input;
    const ratio = fromRate / 16000;
    const output = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < output.length; i++) {
      const start = Math.floor(i * ratio), endAt = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < endAt; j++) sum += input[j];
      output[i] = sum / Math.max(1, endAt - start);
    }
    return output;
  }

  async function postPcm(pcm, signal) {
    const response = await fetch('/api/local-voice/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: pcm.buffer,
      signal
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return String(result.text || '').trim();
  }

  function requestPartial(frames, id) {
    if (!active || partialPending || !context || frames.length < 8) return;
    const now = performance.now();
    if (now - lastPartialAt < 1250) return;
    lastPartialAt = now;
    partialPending = true;
    const pcm = downsample(frames.slice(), context.sampleRate);
    const ac = new AbortController();
    partialAbort = ac;
    postPcm(pcm, ac.signal).then(text => {
      if (!active || id !== utteranceSeq || !recording || !text) return;
      if ($('lv-heard')) $('lv-heard').textContent = text;
    }).catch(error => {
      if (!error || error.name !== 'AbortError') console.warn('[voice-live] partial transcription:', error && error.message || error);
    }).finally(() => {
      if (partialAbort === ac) partialAbort = null;
      partialPending = false;
    });
  }

  async function transcribe(frames, seq = sessionSeq) {
    if (!context) return;
    if (partialAbort) { partialAbort.abort(); partialAbort = null; }
    const pcm = downsample(frames, context.sampleRate);
    if (pcm.length < 3200) { setState('listening'); return; }
    if (transcriptionPending) { queuedAudio = { frames, seq }; return; }
    transcriptionPending = true;
    const ac = new AbortController();
    finalAbort = ac;
    setState('transcribing');
    if ($('lv-heard')) $('lv-heard').textContent = 'Finalizing your turn…';
    try {
      const text = await postPcm(pcm, ac.signal);
      if (!active || seq !== sessionSeq) return;
      if ($('lv-heard')) $('lv-heard').textContent = text || 'No speech detected — still listening.';
      handleTranscript(text);
    } catch (error) {
      if (!error || error.name !== 'AbortError') {
        setTransientError(`Transcription hiccup: ${error && error.message || error}`);
        setState('listening');
      }
    } finally {
      if (finalAbort === ac) finalAbort = null;
      transcriptionPending = false;
      if (queuedAudio) { const next = queuedAudio; queuedAudio = null; transcribe(next.frames, next.seq); }
      else if (active && !(typeof Voice !== 'undefined' && Voice.isSpeaking && Voice.isSpeaking())) setState('listening');
    }
  }

  function processFrame(event) {
    if (!active) return;
    const frame = new Float32Array(event.inputBuffer.getChannelData(0));
    let energy = 0;
    for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
    const rms = Math.sqrt(energy / frame.length);
    pushLevel(rms * 14);
    const frameMs = frame.length / context.sampleRate * 1000;
    if (performance.now() < calibratedUntil) {
      noiseFloor = noiseFloor * 0.92 + rms * 0.08;
      preRoll.push(frame);
      if (preRoll.length > 8) preRoll.shift();
      return;
    }
    const agentTalking = typeof Voice !== 'undefined' && Voice.isSpeaking && Voice.isSpeaking();
    const threshold = Math.max(0.012, noiseFloor * (agentTalking ? 5.5 : 2.8));
    const voiced = rms > threshold;
    if (!recording) {
      if (!voiced) noiseFloor = noiseFloor * 0.995 + rms * 0.005;
      preRoll.push(frame);
      if (preRoll.length > 8) preRoll.shift();
      speechFrames = voiced ? speechFrames + 1 : 0;
      if (speechFrames >= 3) {
        recording = true;
        utteranceSeq++;
        utterance = preRoll.slice();
        utteranceSamples = utterance.reduce((sum, item) => sum + item.length, 0);
        lastPartialAt = performance.now();
        silenceMs = 0;
        if (agentTalking && Voice.stopSpeaking) Voice.stopSpeaking();
        setState('hearing');
        if ($('lv-heard')) $('lv-heard').textContent = 'Listening…';
      }
      return;
    }
    utterance.push(frame);
    utteranceSamples += frame.length;
    silenceMs = voiced ? 0 : silenceMs + frameMs;
    const durationMs = utteranceSamples / context.sampleRate * 1000;
    if (durationMs >= 1000) requestPartial(utterance, utteranceSeq);
    const endSilenceMs = durationMs < 900 ? 850 : durationMs < 2200 ? 700 : 560;
    if (silenceMs >= endSilenceMs || durationMs >= 20000) {
      const captured = utterance;
      recording = false;
      utterance = [];
      utteranceSamples = 0;
      preRoll = [];
      speechFrames = 0;
      silenceMs = 0;
      transcribe(captured, sessionSeq);
    }
  }

  async function openMicrophone(seq) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot open a microphone.');
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
    // Permission prompts can outlive a quick on→off click. Never let that late result resurrect a closed
    // session or tear down a newer one.
    if (!active || seq !== sessionSeq) {
      acquired.getTracks().forEach(track => track.stop());
      return false;
    }
    stream = acquired;
    const track = stream.getAudioTracks()[0];
    if (track) track.onended = () => { if (active && seq === sessionSeq) scheduleReconnect('Microphone disconnected.'); };
    context = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await context.resume();
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(2048, 1, 1);
    sink = context.createGain();
    sink.gain.value = 0;
    processor.onaudioprocess = processFrame;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    calibratedUntil = performance.now() + 700;
    return true;
  }

  function closeMicrophone() {
    if (partialAbort) { partialAbort.abort(); partialAbort = null; }
    if (finalAbort) { finalAbort.abort(); finalAbort = null; }
    try { if (processor) processor.disconnect(); } catch (_) {}
    try { if (source) source.disconnect(); } catch (_) {}
    try { if (sink) sink.disconnect(); } catch (_) {}
    try { if (stream) stream.getTracks().forEach(track => { track.onended = null; track.stop(); }); } catch (_) {}
    try { if (context) context.close(); } catch (_) {}
    stream = context = source = processor = sink = null;
    recording = false;
    utterance = [];
    utteranceSamples = 0;
    preRoll = [];
    resetLevel();
  }

  function scheduleReconnect(reason) {
    if (!active || reconnectTimer) return;
    closeMicrophone();
    reconnectAttempt++;
    setState('reconnecting');
    setTransientError(`${reason} Reconnecting…`, 8000);
    const seq = sessionSeq;
    const delay = Math.min(6000, 600 * Math.pow(2, Math.min(4, reconnectAttempt - 1)));
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (!active || seq !== sessionSeq) return;
      try {
        const opened = await openMicrophone(seq);
        if (!opened) return;
        reconnectAttempt = 0;
        setError('');
        setState('listening');
        if ($('lv-heard')) $('lv-heard').textContent = 'Microphone reconnected — listening.';
      } catch (error) {
        scheduleReconnect(`Could not reopen the microphone: ${error && error.message || error}.`);
      }
    }, delay);
  }

  function bargeIn() {
    if (!active) return;
    if (typeof Voice !== 'undefined' && Voice.stopSpeaking) Voice.stopSpeaking();
    setState('listening');
    caption('user', 'Listening…');
  }

  async function start(retry) {
    ensurePanel();
    if (active && !retry) { $('live-voice-panel').hidden = false; return; }
    if (retry) finish(true);
    const seq = ++sessionSeq;
    setError('');
    setState('connecting');
    resetLevel();
    warmupNotice = false;
    caption('agent', '');
    if ($('lv-heard')) $('lv-heard').textContent = 'Opening the microphone…';
    $('live-voice-panel').hidden = false;
    active = true;
    ending = false;
    failed = false;
    const button = $('voice-live');
    if (button) button.setAttribute('aria-pressed', 'true');
    if (typeof Voice !== 'undefined') {
      if (Voice.setLocalTts) Voice.setLocalTts(true);
      if (Voice.attachCoordinator) Voice.attachCoordinator({ onState, onAssistant });
    }
    try {
      const opened = await openMicrophone(seq);
      if (!opened || !active || seq !== sessionSeq) return;
      fetch('/api/local-voice/warm', { method: 'POST' }).catch(() => {});
      setState('warming');
      // The hero line is "what you said" — once the mic is genuinely open it goes back to the
      // invitation instead of stalling on the opening message the whole warm-up.
      if ($('lv-heard')) $('lv-heard').textContent = 'Speak naturally — the transcript lands in COMMS.';
      warmupNotice = true;
      caption('agent', 'Microphone is live. Downloading or loading local speech models; this first start can take a few minutes.');
      await pollModels();
      if (!active || seq !== sessionSeq) return;
      clearInterval(modelTimer);
      modelTimer = setInterval(pollModels, 800);
      refreshTask();
      clearInterval(taskTimer);
      taskTimer = setInterval(refreshTask, 500);
    } catch (error) {
      active = false;
      sessionSeq++;
      failed = true;
      setState('offline');
      setError(/permission|denied|allowed/i.test(String(error && error.message || error))
        ? 'Microphone access is blocked. Allow it for this local page, then try again.'
        : String(error && error.message || error));
      closeMicrophone();
      const button = $('voice-live');
      if (button) button.setAttribute('aria-pressed', 'false');
      if (typeof Voice !== 'undefined') {
        if (Voice.detachCoordinator) Voice.detachCoordinator();
        if (Voice.setLocalTts) Voice.setLocalTts(false);
      }
    }
  }

  function finish(stopVoice) {
    if (ending) return;
    ending = true;
    active = false;
    sessionSeq++;
    clearInterval(taskTimer); taskTimer = null;
    clearInterval(modelTimer); modelTimer = null;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    clearTimeout(transientErrorTimer); transientErrorTimer = null;
    reconnectAttempt = 0;
    queuedAudio = null;
    closeMicrophone();
    if (typeof Voice !== 'undefined') {
      if (stopVoice && Voice.stopSpeaking) Voice.stopSpeaking();
      if (Voice.detachCoordinator) Voice.detachCoordinator();
      if (Voice.setLocalTts) Voice.setLocalTts(false);
    }
    if ($('live-voice-panel')) $('live-voice-panel').hidden = true;
    const button = $('voice-live');
    if (button) button.setAttribute('aria-pressed', 'false');
    ending = false;
  }
  function end() { finish(true); }

  function init() {
    ensurePanel();
    const button = $('voice-live');
    if (button) button.onclick = () => active ? end() : start(false);
    window.addEventListener('resize', () => clampPanel($('live-voice-panel')));
    document.addEventListener('visibilitychange', () => {
      if (!active || document.hidden) return;
      if (context && context.state === 'suspended') context.resume().catch(() => scheduleReconnect('Audio session was suspended.'));
      const track = stream && stream.getAudioTracks()[0];
      if (!track || track.readyState === 'ended') scheduleReconnect('Microphone connection was lost.');
    });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        if (!active) return;
        const track = stream && stream.getAudioTracks()[0];
        if (!track || track.readyState === 'ended') scheduleReconnect('Audio device changed.');
      });
    }
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && active) end(); });
  }

  return { init, start, end, isActive: () => active, statusSnapshot, setSkin, skins: () => SKINS.slice() };
})();

document.addEventListener('DOMContentLoaded', () => VoiceLive.init());
