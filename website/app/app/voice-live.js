/* voice-live.js — persistent local speech session over whichever provider powers the active Starnet agent. */
'use strict';

const VoiceLive = (() => {
  let active = false, ending = false, failed = false, taskTimer = null, modelTimer = null;
  // true while running on the keyless dictation ladder instead of the offline models (see startDictation).
  let dictation = false;
  let sessionSeq = 0;
  let stream = null, context = null, source = null, processor = null, sink = null;
  let calibratedUntil = 0, noiseFloor = 0.006, speechFrames = 0, silenceMs = 0;
  let recording = false, utterance = [], utteranceSamples = 0, preRoll = [], transcriptionPending = false, queuedAudio = null;
  let utteranceSeq = 0, partialPending = false, partialAbort = null, lastPartialAt = 0, partialText = '';
  let finalAbort = null;
  let reconnectTimer = null, reconnectAttempt = 0, transientErrorTimer = null;
  let warmupNotice = false;
  const $ = id => document.getElementById(id);
  const POSITION_KEY = 'starnet.liveVoice.position.v1';
  // SETTLED (Andrew, 2026-07-29): a small pop-up module with NO icon — a state line, the volume
  // indicator, and the transcript. The four-shape and four-icon switchers that got us here are
  // deleted; shipping the candidates was never the goal, choosing one was.
  // Level readout: a rolling window of mic RMS, oldest at the left. The columns ARE the microphone
  // — never animate them off a timer, or the module would claim to hear a room it cannot hear.
  // TYPED, not drawn: one block glyph per column, from the same ▁▂▃ ramp the link-status bars in
  // app.js already speak, so the meter belongs to the CRT instead of sitting on top of it.
  const WAVE_BARS = 17;
  const RAMP = '▁▂▃▄▅▆▇█';
  const glyphFor = level => RAMP[Math.min(RAMP.length - 1, Math.round(level * (RAMP.length - 1)))];
  // TWO VOICES, ONE METER (a phone call shows you both sides): every column remembers WHOSE level it
  // is, so the strip changes colour as the turn changes hands instead of needing a second widget.
  // `agentLevel` is the newest RMS of the agent's own playback, pushed in by Voice's output tap.
  const SELF = 'self', AGENT = 'agent';
  const AGENT_GAIN = 6;    // playback RMS is normalized and hotter than a room mic — matched by ear, see below
  let waveBars = null;
  let waveHistory = new Array(WAVE_BARS).fill(null).map(() => ({ v: 0, src: SELF }));
  let agentLevel = 0;

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
        '<span id="lv-state" class="lv-state" aria-live="polite">CONNECTING</span>',
        '<button id="lv-close" class="x-btn lv-x" type="button" aria-label="End live voice" title="End live voice">✕</button>',
      '</header>',
      // The LEVEL IS THE CONTROL. There is no icon: an orb, a mic glyph, a lamp — anything sitting
      // beside the meter was a second thing to look at, and the meter already says everything this
      // module knows. So the button IS the meter: press anywhere on your own voice to cut in.
      '<div class="lv-stage">',
        '<button id="lv-barge" class="lv-meter" type="button" aria-label="Interrupt and speak" title="Interrupt — speak now">',
          '<div id="lv-wave" class="lv-wave" aria-hidden="true"></div>',
        '</button>',
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
    for (let i = 0; i < WAVE_BARS; i++) {
      const col = document.createElement('i');
      col.textContent = RAMP[0];   // a silent room is a flat line, never an empty row
      col.dataset.src = SELF;
      wave.appendChild(col);
    }
    document.body.appendChild(panel);
    waveBars = Array.from(wave.children);
    restorePosition(panel);
    makeDraggable(panel);
    $('lv-close').onclick = end;
    $('lv-retry').onclick = () => start(true);
    $('lv-barge').onclick = bargeIn;
  }

  // Amplitude drives the meter AND the module's own bloom, so the whole light level of the thing is
  // the real mic level — one signal, never a decorative loop pretending to be one.
  //
  function pushLevel(value, source) {
    const level = Math.max(0, Math.min(1, value));
    const src = source === AGENT ? AGENT : SELF;
    waveHistory.push({ v: level, src: src });
    waveHistory.shift();
    if (waveBars) for (let i = 0; i < waveBars.length; i++) {
      const cell = waveHistory[i], bar = waveBars[i];
      const glyph = glyphFor(cell.v);
      if (bar.textContent !== glyph) bar.textContent = glyph;
      if (bar.dataset.src !== cell.src) bar.dataset.src = cell.src;   // CSS colours the column by whose voice it is
    }
    const panel = $('live-voice-panel');
    if (panel) {
      panel.style.setProperty('--lv-amp', level.toFixed(3));
      // the bloom belongs to whoever is talking, so the module's own light changes hands too
      if (panel.dataset.talker !== src) panel.dataset.talker = src;
    }
  }

  function resetLevel() {
    waveHistory = new Array(WAVE_BARS).fill(null).map(() => ({ v: 0, src: SELF }));
    agentLevel = 0;
    if (waveBars) waveBars.forEach(bar => { bar.textContent = RAMP[0]; bar.dataset.src = SELF; });
    const panel = $('live-voice-panel');
    if (panel) { panel.style.setProperty('--lv-amp', '0'); panel.dataset.talker = SELF; }
  }

  function setState(value) {
    const normalized = String(value || 'ready').toLowerCase();
    if ($('lv-state')) $('lv-state').textContent = normalized.toUpperCase();
    const panel = $('live-voice-panel');
    const meter = $('lv-barge');
    const working = /^(?:connecting|warming|thinking|transcribing|reconnecting)$/.test(normalized);
    if (panel) {
      panel.dataset.state = normalized;
      panel.setAttribute('aria-busy', working ? 'true' : 'false');
    }
    if (meter) {
      const label = normalized === 'speaking'
        ? 'Agent speaking — press to interrupt and speak'
        : normalized === 'hearing'
          ? 'Listening to you — press to interrupt'
          : working
            ? `${normalized} — press to interrupt and speak`
            : 'Voice is listening — press to interrupt and speak';
      meter.setAttribute('aria-label', label);
      meter.title = label;
    }
  }
  function setError(message) {
    const el = $('lv-error');
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || '';
    if ($('lv-retry')) $('lv-retry').hidden = !message;
  }
  // A failure the user cannot retry away: same visible message, but no RETRY affordance — offering one
  // for a capability this build does not carry would just loop them through the same refusal.
  function setUnrecoverableError(message) {
    setError(message);
    if ($('lv-retry')) $('lv-retry').hidden = true;
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

  // One read of the sidecar's installation verdict. Returns null when the sidecar cannot be reached, so
  // callers can tell "proven unavailable" apart from "don't know yet".
  async function probeAvailability() {
    try {
      const response = await fetch('/api/local-voice/status', { cache: 'no-store' });
      return await response.json();
    } catch (_) {
      return null;
    }
  }

  // The keyless listening ladder: Windows System.Speech, driven by the sidecar, needing no npm package and
  // no transcription credential. It ships inside the bundle where the offline models cannot.
  async function probeNativeStt() {
    try {
      const response = await fetch('/api/stt/native/status', { cache: 'no-store' });
      return await response.json();
    } catch (_) {
      return null;
    }
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
  // the agent's live output RMS, straight off the tap on its playback chain. Stored, not drawn: the mic
  // frame is the only thing that scrolls the strip (see processFrame), so this just supplies the value.
  function onOutputLevel(rms) { agentLevel = Math.max(0, +rms || 0); }
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
      partialText = text;
      if ($('lv-heard')) $('lv-heard').textContent = text;
    }).catch(error => {
      if (!error || error.name !== 'AbortError') console.warn('[voice-live] partial transcription:', error && error.message || error);
    }).finally(() => {
      if (partialAbort === ac) partialAbort = null;
      partialPending = false;
    });
  }

  function endpointSilenceMs(durationMs, text) {
    // Human turns contain thinking pauses. The old 560–850ms endpoint was excellent for commands
    // and poor for conversation: it routinely submitted while someone was deciding how to finish
    // a sentence. Keep short turns the most patient, and never make a long reflective turn faster
    // than 950ms. If the partial transcript visibly trails off, grant another half beat.
    let wait = durationMs < 1200 ? 1350 : durationMs < 3200 ? 1150 : 950;
    const partial = String(text || '').trim().toLowerCase();
    const continues = /[,;:—-]\s*$/.test(partial)
      || /\b(?:and|but|or|so|because|then|like|well|actually|basically|uh|um|hmm|i|i'm|we|to|the|a|an|my|your|that|which|if|when|while|with|for|of)\s*[.!?]?$/.test(partial);
    if (continues) wait = Math.min(1750, wait + 450);
    return wait;
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
    const agentTalking = typeof Voice !== 'undefined' && Voice.isSpeaking && Voice.isSpeaking();
    // ONE CLOCK for the strip. The mic frame is what scrolls it — always, even while the agent holds the
    // turn — so the meter keeps a single steady rate instead of speeding up when a second source (the
    // agent's ~60fps output tap) starts pushing. Whoever holds the turn supplies the VALUE and the colour;
    // the mic keeps feeding the VAD below either way, so barge-in detection is untouched.
    if (agentTalking) pushLevel(agentLevel * AGENT_GAIN, AGENT);
    else pushLevel(rms * 14, SELF);
    const frameMs = frame.length / context.sampleRate * 1000;
    if (performance.now() < calibratedUntil) {
      noiseFloor = noiseFloor * 0.92 + rms * 0.08;
      preRoll.push(frame);
      if (preRoll.length > 8) preRoll.shift();
      return;
    }
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
        partialText = '';
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
    const endSilenceMs = endpointSilenceMs(durationMs, partialText);
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
    partialText = '';
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

  function reflectButton(on) {
    const button = $('voice-live');
    if (!button) return;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('aria-label', on ? 'Stop Local Live hands-free voice' : 'Start Local Live hands-free voice');
    button.title = on
      ? 'Stop Local Live hands-free voice'
      : 'Local Live hands-free voice — local speech with your active Starnet agent';
  }

  async function start(retry) {
    ensurePanel();
    if (active && !retry) { $('live-voice-panel').hidden = false; return; }
    if (retry) finish(true);
    // Local Live rides on the offline speech packages, and the shipped desktop bundle carries no
    // node_modules — so ASK the sidecar before opening the microphone. Going live first and failing on the
    // first model import is how this panel used to show users a raw "Cannot find module" string.
    // Only a PROVEN `available:false` refuses; an unreachable sidecar falls through to the existing
    // offline handling below.
    const readiness = await probeAvailability();
    if (readiness && readiness.available === false) {
      // The offline models are absent — the normal case in a packaged build, which ships no node_modules.
      // That is NOT a reason to refuse: listening has a keyless ladder (Windows dictation through the
      // sidecar) and speaking already works through the Edge floor. Only refuse when neither exists.
      const native = await probeNativeStt();
      if (native && native.available) return startDictation();
      $('live-voice-panel').hidden = false;
      setState('unavailable');
      if ($('lv-model')) $('lv-model').textContent = 'LOCAL MODELS: NOT INSTALLED';
      caption('user', 'Local Live is unavailable in this build.');
      caption('agent', 'The offline speech models are not bundled with the installer, and this platform has no keyless dictation engine, so hands-free listening cannot start. The standard voice controls are unaffected.');
      // The sidecar's `reason` carries a source-checkout hint ("run npm install") that is noise to a user
      // of the installer — it stays in the API and the log, not in the panel's error row.
      setUnrecoverableError('Offline speech models are not installed in this build.');
      reflectButton(false);
      return;
    }
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
    reflectButton(true);
    if (typeof Voice !== 'undefined') {
      // Local Live is now Starnet's one hands-free surface. A legacy loop can still exist through
      // older saved state or API callers; close it before attaching this persistent microphone.
      if (Voice.inVoiceMode && Voice.inVoiceMode() && Voice.stopConvo) Voice.stopConvo();
      if (Voice.setLocalTts) Voice.setLocalTts(true);
      if (Voice.attachCoordinator) Voice.attachCoordinator({ onState, onAssistant, onOutputLevel });
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
      reflectButton(false);
      if (typeof Voice !== 'undefined') {
        if (Voice.detachCoordinator) Voice.detachCoordinator();
        if (Voice.setLocalTts) Voice.setLocalTts(false);
      }
    }
  }

  /* DICTATION MODE — Local Live without the offline models.
     Differences from the model path, all deliberate:
       - THIS side never opens the microphone. On the native leg System.Speech listens on the default
         device from inside the sidecar, and two consumers on one microphone fight. (The browser-speech
         leg does open a mic, but the browser engine owns it — we still don't.) Either way there is no
         level meter here, and the native leg has no interim partials: it returns one finished utterance
         per call.
       - local TTS stays OFF (Kokoro is absent too), so speech goes down the normal ladder and lands
         on the keyless Edge floor.
       - `startCoordinator`, not `attachCoordinator`: only the former SELECTS an stt provider, and with
         no browser SpeechRecognition (the WebView2 case) it picks the native dictation provider. This is
         the ladder that already existed and that nothing was calling. */
  function startDictation() {
    const seq = ++sessionSeq;
    setError('');
    resetLevel();
    warmupNotice = false;
    caption('agent', '');
    $('live-voice-panel').hidden = false;
    active = true;
    dictation = true;
    ending = false;
    failed = false;
    reflectButton(true);
    if (typeof Voice !== 'undefined') {
      if (Voice.inVoiceMode && Voice.inVoiceMode() && Voice.stopConvo) Voice.stopConvo();
      if (Voice.setLocalTts) Voice.setLocalTts(false);
      if (Voice.startCoordinator) Voice.startCoordinator({ onState, onAssistant, onOutputLevel });
    }
    if (!active || seq !== sessionSeq) return;
    setState('listening');
    // Name the engine the ladder ACTUALLY chose, read back from Voice rather than re-derived here. In the
    // packaged WebView2 shell there is no SpeechRecognition so this is the sidecar's Windows dictation; in a
    // plain browser the same ladder picks the browser engine, and calling that "Windows dictation" would be
    // a lie of exactly the kind this panel is not allowed to tell.
    const engine = (typeof Voice !== 'undefined' && Voice.sttEngine) ? Voice.sttEngine() : '';
    // Names are voice.js's own provider ids — 'native' | 'web-speech' | 'recorder'. Verified by reading them
    // back live, not assumed: guessing 'web' here rendered "ASR UNKNOWN" in a browser.
    const engineLabel = engine === 'native' ? 'WINDOWS DICTATION'
      : engine === 'web-speech' ? 'BROWSER SPEECH'
      : engine === 'recorder' ? 'SERVER WHISPER'
      : 'UNKNOWN';
    if ($('lv-model')) $('lv-model').textContent = `ASR ${engineLabel} · VOICE EDGE`;
    if ($('lv-heard')) $('lv-heard').textContent = 'Speak naturally — the transcript lands in COMMS.';
    caption('agent', 'The offline speech models are not in this build, so Local Live is listening through Windows dictation — one utterance at a time, no live preview.');
    refreshTask();
    clearInterval(taskTimer);
    taskTimer = setInterval(refreshTask, 500);
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
      // Dictation mode STARTED the coordinator (which armed a listen loop), so detaching the hooks is not
      // enough — that loop has to be stopped or the sidecar keeps being asked to dictate after the panel closes.
      if (dictation && Voice.stopCoordinator) Voice.stopCoordinator();
      if (Voice.detachCoordinator) Voice.detachCoordinator();
      if (Voice.setLocalTts) Voice.setLocalTts(false);
    }
    dictation = false;
    if ($('live-voice-panel')) $('live-voice-panel').hidden = true;
    reflectButton(false);
    ending = false;
  }
  function end() { finish(true); }

  function init() {
    ensurePanel();
    const button = $('voice-live');
    if (button) button.onclick = () => active ? end() : start(false);
    window.addEventListener('resize', () => clampPanel($('live-voice-panel')));
    document.addEventListener('visibilitychange', () => {
      // Dictation mode holds no browser mic, so `stream`/`context` are null by design — the checks below
      // would read that as "microphone lost" and fire a reconnect that opens a device we must not touch.
      if (!active || dictation || document.hidden) return;
      if (context && context.state === 'suspended') context.resume().catch(() => scheduleReconnect('Audio session was suspended.'));
      const track = stream && stream.getAudioTracks()[0];
      if (!track || track.readyState === 'ended') scheduleReconnect('Microphone connection was lost.');
    });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        if (!active || dictation) return;   // no browser mic in dictation mode — see visibilitychange above
        const track = stream && stream.getAudioTracks()[0];
        if (!track || track.readyState === 'ended') scheduleReconnect('Audio device changed.');
      });
    }
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && active) end(); });
  }

  return { init, start, end, isActive: () => active, statusSnapshot };
})();

document.addEventListener('DOMContentLoaded', () => VoiceLive.init());
