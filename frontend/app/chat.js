/* SKYNET — chat.js : the in-game COMMS panel.
   Talking to your agent is a REAL streaming model call (via Harness). While a reply
   the agent walks to its workstation and types (World.setActivity('task')).
   Supports: preloaded history (resume), and an "awaiting purpose" first-message mode. */
'use strict';

// VOICE MODE augmentation — appended to the system prompt (per-turn, ephemeral) only when the
// agent is about to SPEAK a conversational reply. Forces a short, spoken-style answer; the paired
// text/task turns get NO augmentation, so written replies keep full structure (the whole "voice =
// laid-back back-and-forth, type = detailed" split is produced by the presence/absence of this block).
function voiceModeRules() {
  // the format rules are fixed; the closing line is the ACTIVE PERSONA's spoken-delivery hint, so the 5
  // personalities sound distinct out loud (the voice channel was flattening them into one generic-casual tone).
  let hint = 'sound like a relaxed buddy giving a quick answer across the room';
  try {
    if (typeof Voice !== 'undefined' && Voice.personaId && typeof Personas !== 'undefined') {
      const p = Personas.get(Voice.personaId());
      if (p && p.voiceModeHint) hint = p.voiceModeHint;
    }
  } catch (_) {}
  return "\n\n[VOICE MODE — you're talking out loud, not typing.] Reply the way you'd actually SAY it:"
    + " 1-3 short sentences, max. Use contractions (you're, gonna, it's, lemme). Plain spoken words only —"
    + " absolutely NO markdown, asterisks, bullet points, numbered lists, headers, code blocks, emoji, or links;"
    + " those can't be heard. Don't read out URLs or file paths character-by-character — just say what you did."
    + " No throat-clearing, no 'As an AI', no 'I'd be happy to', no recapping the question. " + hint + "."
    + " If the real answer is long, give the one-line version out loud and offer to drop the details in chat.";
}

const Chat = (() => {
  let log, input, statusEl;
  let system = '', name = 'AGENT', activeWs = null;
  let onTurn = null, interview = null;   // interview: the AWAKENING answer handler — while set, COMMS input feeds onboarding, not the model
  // THE GATE: per-workstream run-state (busy / runId / in-flight text / tool lines / pending approval) lives in
  // Channels (channels.js) so streams are isolated and survive a switch — chat.js is the DOM view over it. The
  // one thing that can't live in the pure model is the live AbortController (not serializable), so it stays here.
  const aborters = new Map();   // workstreamId -> AbortController for that stream's in-flight run
  let activeLiveRow = null;     // streaming DOM row for the DISPLAYED stream's in-flight run; rebound by replayChannel on switch
  const el = id => document.getElementById(id);

  function init(opts) {
    system = opts.system || ''; name = opts.name || 'AGENT';
    onTurn = opts.onTurn || null; interview = null;
    log = el('chat-log'); input = el('chat-input'); statusEl = el('chat-status');
    input.value = '';
    load(opts.ws);
    input.onkeydown = e => {
      if (e.key === 'Enter' && !e.isComposing) {
        const t = input.value.trim();
        if (t) { input.value = ''; send(t); }
      }
    };
  }

  // swap the rendered conversation to a workstream (its history). Used on enter/resume and when the
  // Commander clicks another stream in the rail — re-renders without re-wiring the input row.
  function load(ws) {
    activeWs = ws || (typeof Workstreams !== 'undefined' ? Workstreams.active() : null);
    // typing targets the displayed stream (war-room D2: the compose target is decoupled from any camera jump)
    if (activeWs && typeof Channels !== 'undefined') Channels.setComposeTarget(activeWs.id);
    if (log) log.innerHTML = '';
    renderHistory();
    replayChannel();   // re-render an in-flight stream we left running: tool lines / partial reply / pending approval
    status(interview ? 'waking…' : (isBusy() ? 'working…' : 'online'));
  }

  function setSystem(s) { system = s; }
  function getHistory() { return activeWs ? activeWs.history.slice() : []; }
  function isBusy() { return !!(activeWs && typeof Channels !== 'undefined' && Channels.isBusy(activeWs.id)); }
  function isActiveWs(ws) { return !!(ws && activeWs && activeWs.id === ws.id); }   // is THIS stream the one on screen right now?
  function status(s) { if (statusEl) statusEl.textContent = s; }

  function row(role) {
    const d = document.createElement('div'); d.className = 'cmsg ' + role;
    const who = document.createElement('span'); who.className = 'who';
    who.textContent = role === 'user' ? 'COMMANDER' : name;
    const body = document.createElement('span'); body.className = 'body';
    d.appendChild(who); d.appendChild(body);
    log.appendChild(d); log.scrollTop = log.scrollHeight;
    return { d, body };
  }
  function addUser(t) { row('user').body.textContent = t; log.scrollTop = log.scrollHeight; }
  function localLine(t) { row('agent').body.textContent = t; log.scrollTop = log.scrollHeight; }
  // a compact tool-activity line in COMMS (▶ call / ◀ result) — the agent's real work, visible
  function toolLine(text, isErr) {
    const r = row('agent'); r.d.classList.add('tool'); if (isErr) r.d.classList.add('err');
    r.body.textContent = text; log.scrollTop = log.scrollHeight;
  }
  function brief(s) { s = String(s || ''); return s.length > 56 ? s.slice(0, 53) + '…' : s; }
  // a clickable COMMS row for a file the agent produced — opens it via the sidecar's jailed /api/file route
  function deliverableLine(title, agentId) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('deliverable');
    r.body.appendChild(document.createTextNode('▤ saved '));
    const a = document.createElement('a');
    a.href = '/api/file?agent=' + encodeURIComponent(agentId || 'agent') + '&path=' + encodeURIComponent(title);
    a.target = '_blank'; a.rel = 'noopener'; a.textContent = title; a.className = 'deliverable-link';
    r.body.appendChild(a);
    log.scrollTop = log.scrollHeight;
  }
  // a live consent prompt: the agent wants to do something that needs approval (a file write today). The run is
  // PAUSED on the sidecar until the Commander answers — once / always (this kind) / full access (everything this
  // session) / deny. Answering resumes the stream automatically.
  function actionPhrase(ev) {
    const t = ev.tool || 'act';
    if (/notebook/.test(t)) return 'save a note to its memory';
    if (/write|append|edit/.test(t)) return 'write ' + (ev.argsSummary || 'a file');
    return t.replace(/_/g, '.') + (ev.argsSummary ? ' ' + ev.argsSummary : '');
  }
  // p = a consent payload { promptId, tool, argsSummary } — works for both a live onPermission event and a
  // Channels snapshot.pending (re-rendered after a switch). ws is the origin stream, so the answer routes to
  // THAT stream's run (per-channel runId), not a single global one.
  function permissionRow(p, ws) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('consent');
    r.body.appendChild(document.createTextNode('🔒 ' + name + ' wants to ' + actionPhrase(p) + ' '));
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    let decided = false;
    function decide(decision, doneLabel, isDeny) {
      if (decided) return; decided = true;
      const rid = (ws && typeof Channels !== 'undefined') ? Channels.runIdOf(ws.id) : null;
      Harness.consent(rid, p.promptId, decision);
      if (ws && typeof Channels !== 'undefined') Channels.clearPending(ws.id);
      btns.remove();
      const tag = document.createElement('span');
      tag.className = 'consent-result' + (isDeny ? ' err' : '');
      tag.textContent = doneLabel;
      r.body.appendChild(tag);
      status(isBusy() ? 'working…' : 'online');
    }
    const mk = (text, decision, cls, doneLabel, isDeny) => {
      const b = document.createElement('button');
      b.className = 'consent-btn' + (cls ? ' ' + cls : '');
      b.textContent = text;
      b.onclick = () => decide(decision, doneLabel, isDeny);
      btns.appendChild(b);
    };
    mk('Approve once', 'once', '', '✓ approved once', false);
    mk('Always', 'always', '', '✓ always allowed', false);
    mk('Full access', 'full', 'danger', '✓ full access', false);
    mk('Deny', 'deny', 'deny', '✕ denied', true);
    r.body.appendChild(btns);
    status('awaiting your approval…');
    if (typeof StationUI !== 'undefined') StationUI.notify(name + ' needs approval to ' + actionPhrase(p), 'warn');
    log.scrollTop = log.scrollHeight;
  }

  function renderHistory() {
    const h = activeWs ? activeWs.history : [];
    for (const m of h) {
      if (m.role === 'user') addUser(m.content);
      else row('agent').body.textContent = m.content;
    }
  }

  // SWITCH-SURVIVAL: re-render whatever in-flight run we left on the now-displayed stream — its streamed
  // tool lines, its partial reply, and any pending approval — from the Channels snapshot. For an idle stream
  // the snapshot is empty and this is a no-op. (Live token re-binding for a stream switched-to MID-run lands
  // with the frontend-hud change that lifts the "can't switch while busy" guard — see the GATE handoff note.)
  function replayChannel() {
    activeLiveRow = null;
    if (!activeWs || typeof Channels === 'undefined') return;
    const s = Channels.snapshot(activeWs.id);
    if (!s) return;
    for (const t of s.tools) toolLine(t.text, t.isErr);
    if (s.busy || s.acc) {
      const o = streamingAgent(); if (s.acc) o.append(s.acc);
      if (s.busy) activeLiveRow = o; else o.done();   // a still-running stream keeps its live row so new tokens flow into it
    }
    if (s.pending) permissionRow(s.pending, activeWs);
  }

  function streamingAgent() {
    const r = row('agent');
    const caret = document.createElement('span'); caret.className = 'caret'; caret.textContent = '▮';
    r.d.appendChild(caret);
    return {
      append(t) { r.body.textContent += t; log.scrollTop = log.scrollHeight; },
      done() { caret.remove(); },
      error(m) { r.d.classList.add('err'); r.body.textContent = '⚠ ' + m; caret.remove(); }
    };
  }

  // task-vs-chat classification lives in app/classify.js (pure + unit-tested); see Classify.isTaskDirective.

  async function send(text) {
    if (interview) { interview(text); return; }   // THE AWAKENING owns the input: route the answer to onboarding, no model call
    const ws = activeWs;   // CAPTURE the origin stream now — a mid-run switch must not cross-post its cost/files
    if (!ws) return;
    if (Channels.isBusy(ws.id)) return;   // one run per stream — but OTHER streams may be running concurrently
    Channels.begin(ws.id);
    addUser(text); ws.history.push({ role: 'user', content: text });
    // name an untitled stream from its first real message (no-op on General / already-titled)
    if (typeof Workstreams !== 'undefined' && Workstreams.autoTitle(ws.id, text)) {
      if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
    }

    const isTask = Classify.isTaskDirective(text);
    // VOICE CONVERSATION: the speaker toggle (🔊) is the switch. When it's ON the agent VOICES every
    // reply, so we append the short/spoken-style rule (talk OR task) — that's the laid-back back-and-
    // forth. When it's OFF, replies are silent + detailed written text.
    const willSpeak = typeof Voice !== 'undefined' && Voice.isOn && Voice.isOn();
    // In a voice conversation the agent stays ONE-ON-ONE: he faces the Commander and answers on the
    // spot instead of walking to the workstation — even for "task"-classified messages (the work still
    // runs, just not as a visible desk trip). Only a SILENT task (speaker off) walks over to work.
    const stance = (isTask && !willSpeak) ? 'task' : 'talk';
    World.setActivity(stance);
    // in a spoken conversation, gently frame the agent so you can actually see who you're talking to
    // (no-op if he's already comfortably on-screen; self-cancels the moment you pan/zoom).
    if (stance === 'talk' && willSpeak && World.focusAgent) World.focusAgent({ soft: true });
    status(stance === 'task' ? 'working…' : 'thinking…');
    // for a task the agent works at the computer (lit screen) and the result streams to this panel;
    // for talk it speaks the reply as a bubble in the room. The voice rule is appended LAST so it
    // wins on format; it's never baked into the saved prompt.
    const sys = system
      + (isTask ? ' The Commander has just assigned you a task — carry it out as best you can and report the result clearly.' : '')
      + (willSpeak ? voiceModeRules() : '');

    const before = Object.assign({}, Harness.totals());   // COPY (totals is a mutated singleton) so the per-stream diff is real
    const ac = new AbortController();
    aborters.set(ws.id, ac);
    const callNames = {};   // callId -> tool name (the frozen agent.tool_result has no name field)
    const seenDeliv = {};   // title -> true (one openable row per produced file)
    activeLiveRow = streamingAgent();
    let acc = '';
    // VOICE STREAMING: when the agent will speak (🔊 on), hand each COMPLETE sentence to Voice as it
    // streams — so it starts talking while the rest is still generating, instead of after the whole reply
    // is done + synthesized. spokenIdx tracks how much of `acc` we've already queued.
    let spokenIdx = 0, finalReply = '';
    const pushSpeech = (finalize, finalText) => {
      if (typeof Voice === 'undefined' || !willSpeak || !Voice.speakChunk) return;
      const src = finalize ? (finalText || acc) : acc;
      const pending = src.slice(spokenIdx);
      if (!pending) return;
      if (finalize) { if (pending.trim()) { Voice.speakChunk(pending, name); spokenIdx = src.length; } return; }
      let cut = -1;
      if (spokenIdx === 0) {
        // FIRST chunk: get him talking ASAP — flush on the earliest clause boundary (comma/dash/colon/
        // sentence end), or after just a few words if none has appeared, so the voice starts almost as soon
        // as he begins typing instead of waiting for a whole sentence + its synth round-trip.
        const clause = /[,;:—–-]\s|[.!?…]+["')\]]?\s/.exec(pending);
        if (clause) cut = clause.index + clause[0].length;
        else if (pending.length >= 18) { const ls = pending.lastIndexOf(' '); if (ls > 0) cut = ls + 1; }   // ~3-4 words → flush at a word boundary
        if (cut < 0) { if (pending.length < 48) return; cut = pending.length; }
      } else {
        // later chunks: complete sentence(s) for natural prosody. Require trailing whitespace after the
        // terminator so a decimal/abbreviation at the buffer edge ("3." / "e.g.") isn't spoken early.
        const re = /[.!?…]+["')\]]?\s/g; let m;
        while ((m = re.exec(pending)) !== null) cut = re.lastIndex;
        if (cut < 0) { if (pending.length < 200) return; cut = pending.length; }   // runaway guard
      }
      const chunk = pending.slice(0, cut);
      if (chunk.trim()) { Voice.speakChunk(chunk, name); spokenIdx += cut; }
    };
    try {
      const { text: reply, error, endReason } = await Harness.chat({
        system: sys, messages: ws.history, agentId: ws.agentId || 'agent', isTask, signal: ac.signal,
        onRunId: id => { Channels.setRunId(ws.id, id); if (typeof Workstreams !== 'undefined') { Workstreams.appendRun(ws.id, id); if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } },
        onToken: d => { acc += d; Channels.appendToken(ws.id, d); if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.append(d); if (!isTask) World.say(acc); } if (willSpeak) pushSpeech(false); App.refreshUsage(); },
        onUsage: () => App.refreshUsage(),
        onToolCall: ev => { callNames[ev.callId] = ev.name; const t = '▶ ' + ev.name + ' ' + brief(ev.argsSummary); Channels.addTool(ws.id, t, false); if (isActiveWs(ws)) toolLine(t); if (typeof U !== 'undefined' && U.bus && ev.name && ev.name.indexOf('mcp__') === 0) U.bus.emit('agent.tool_call', { name: ev.name }); },
        onToolResult: ev => { const nm = callNames[ev.callId] || 'tool'; const t = (ev.isError ? '◁ ' : '◀ ') + nm + ' · ' + (ev.summary || (ev.isError ? 'error' : 'ok')) + (ev.ms ? ' (' + ev.ms + 'ms)' : ''); Channels.addTool(ws.id, t, ev.isError); if (isActiveWs(ws)) toolLine(t, ev.isError); },
        onDeliverable: ev => {
          if (ev.kind === 'file' && !seenDeliv[ev.title]) {
            seenDeliv[ev.title] = true; if (isActiveWs(ws)) deliverableLine(ev.title, ev.agentId);
            // the frozen 'deliverable' event carries no runId/time — synthesize from the live run + clock
            if (typeof Workstreams !== 'undefined') Workstreams.recordDeliverable(ws.id, { title: ev.title, kind: ev.kind, runId: Channels.runIdOf(ws.id), t: Date.now() });
            if (typeof StationUI !== 'undefined') StationUI.notify('saved ' + ev.title, 'gold');
          }
        },
        onPermission: ev => { Channels.setPending(ws.id, { promptId: ev.promptId, tool: ev.tool, argsSummary: ev.argsSummary, runId: Channels.runIdOf(ws.id) }); if (isActiveWs(ws)) permissionRow(ev, ws); }
      });
      if (error) {
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.error(error); if (!isTask) World.say('…' + (error.length > 40 ? error.slice(0, 40) + '…' : error)); }
        if (typeof StationUI !== 'undefined') StationUI.notify('run error: ' + brief(error), 'warn');
      } else {
        ws.history.push({ role: 'assistant', content: reply || acc });
        if (isActiveWs(ws) && activeLiveRow) activeLiveRow.done();
        finalReply = reply || acc;
        // a talk reply shows as a room bubble; the spoken reply itself is STREAMED sentence-by-sentence as
        // it arrives (onToken → pushSpeech) and flushed in the finally — so the agent starts talking while
        // the rest is still generating, instead of after the whole reply + a full TTS round-trip.
        if (!isTask && isActiveWs(ws)) World.say(reply || acc);
        // the run stopped before a natural finish — tell the Commander why (not a silent dead-end)
        if (endReason && endReason !== 'done') {
          if (isActiveWs(ws)) toolLine('⏹ ' + (endReason === 'max_iters' ? 'reached the step limit — say "continue" to keep going'
            : endReason === 'budget' ? 'reached this run\'s cost limit'
            : endReason === 'cancelled' ? 'run cancelled'
            : 'stopped (' + endReason + ')'));
          if (typeof StationUI !== 'undefined') StationUI.notify('run stopped: ' + endReason, 'warn');
        }
      }
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));
      if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.error(aborted ? '— disconnected —' : (e.message || String(e))); if (!isTask && !aborted) World.say('…connection trouble…'); }
    } finally {
      aborters.delete(ws.id);
      Channels.end(ws.id);
      if (isActiveWs(ws)) { status('online'); activeLiveRow = null; }
      // after a turn: in a hands-free voice conversation keep him facing you (one-on-one, no wandering off
      // between turns); otherwise he stands up and goes back to idle. Only steer the world if THIS finished
      // stream is the one on screen — a background stream finishing must not move the view.
      const stayFacing = typeof Voice !== 'undefined' && Voice.inVoiceMode && Voice.inVoiceMode();
      if (isActiveWs(ws)) { World.setActivity(stayFacing ? 'talk' : 'idle'); if (stayFacing && World.focusAgent) World.focusAgent({ soft: true }); }
      // fold this run's REAL usage delta into the origin stream's per-conversation cost — no double-count:
      // the same deltas already minted the lifetime total inside Harness.
      if (typeof Workstreams !== 'undefined') {
        const a = Harness.totals();
        Workstreams.addCost(ws.id, { tokens: a.tokens - before.tokens, usd: a.cost - before.cost, calls: a.calls - before.calls });
        Workstreams.touch(ws.id);
      }
      App.refreshUsage();
      if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
      if (onTurn) onTurn();
      // flush any trailing spoken text and CLOSE the speech stream — the last chunk's end re-arms the
      // hands-free mic (this is the heartbeat for spoken turns; onTurnEnd covers silent/no-speech turns).
      if (willSpeak && typeof Voice !== 'undefined' && Voice.endReply) { pushSpeech(true, finalReply); Voice.endReply(); }
      // hands-free voice mode: the run is done — let Voice re-open the mic for the next turn.
      if (typeof Voice !== 'undefined' && Voice.onTurnEnd) Voice.onTurnEnd();
    }
  }

  /* DISCONNECT (or any teardown) cancels the in-flight billable run: abort the fetch (the sidecar's
     req.on('close') then stops the loop) AND tell the sidecar to kill the run by id — belt-and-suspenders. */
  function abort() {
    if (typeof Voice !== 'undefined' && Voice.stopConvo) Voice.stopConvo();   // drop hands-free on disconnect
    // cancel EVERY in-flight run (not just one global): abort each fetch + tell the sidecar to kill the run by id
    for (const ac of aborters.values()) { try { ac.abort(); } catch (_) {} }
    if (typeof Channels !== 'undefined') for (const id of Channels.busyIds()) { const rid = Channels.runIdOf(id); if (rid) Harness.cancel(rid); }
    aborters.clear();
  }

  /* ---------- THE AWAKENING (onboarding) interview ----------
     While an interview handler is set, the COMMS input feeds the onboarding script (Onboarding) instead
     of the model: typed answers AND tappable suggestion chips both author config docs — no model call. */
  function beginInterview(onAnswer) {
    interview = onAnswer || null;
    if (input) input.placeholder = 'answer to wake your agent…';
    status('waking…');
  }
  function endInterview() {
    interview = null;
    if (input) input.placeholder = 'speak to your agent…';
    status('online');
  }
  function echoUser(text) { addUser(text); }
  // a row of tappable suggestion pills in COMMS; picking one (or typing) is an answer. onPick gets the item.
  function choices(items, onPick) {
    if (!log) return;
    const rowEl = document.createElement('div'); rowEl.className = 'choice-row';
    let done = false;
    (items || []).forEach(it => {
      const b = document.createElement('button'); b.className = 'choice'; b.textContent = it.label;
      b.onclick = () => { if (done) return; done = true; rowEl.remove(); if (typeof SFX !== 'undefined') SFX.click(); onPick(it); };
      rowEl.appendChild(b);
    });
    log.appendChild(rowEl); log.scrollTop = log.scrollHeight;
  }

  // THE AWAKENING typewriter: reveals fixed text char-by-char (with per-segment speed + holds) through the
  // streaming caret, so the newborn is SEEN assembling its first broken sentence rather than printing it.
  // Pass a string or an array of {text, cps, holdAfter} segments. onDone ALWAYS fires (try/finally) so a
  // missed timer can never leave the awakening stuck. Returns a force-finish handle.
  function typeLine(segments, onDone) {
    if (typeof segments === 'string') segments = [{ text: segments }];
    if (!log || !Array.isArray(segments)) { if (onDone) onDone(); return () => {}; }
    const out = streamingAgent();
    let si = 0, ci = 0, finished = false, killed = false;
    function finish() {
      if (finished) return; finished = true;
      try { out.done(); } catch (_) {}
      try { if (onDone) onDone(); } catch (_) {}
    }
    function stepOne() {
      if (killed || si >= segments.length) { finish(); return; }
      const seg = segments[si] || {};
      const text = String(seg.text || '');
      if (ci >= text.length) { si++; ci = 0; setTimeout(stepOne, seg.holdAfter != null ? seg.holdAfter : 0); return; }
      const ch = text[ci++];
      try { out.append(ch); } catch (_) { finish(); return; }
      if (typeof SFX !== 'undefined' && SFX.type && ch !== ' ' && (ci % 2 === 0)) SFX.type();
      const cps = seg.cps || 40;
      setTimeout(stepOne, (1000 / cps) * (0.6 + Math.random() * 0.8));
    }
    stepOne();
    return () => { killed = true; };
  }

  return { init, load, send, status, localLine, setSystem, getHistory, abort, isBusy, beginInterview, endInterview, echoUser, choices, typeLine };
})();
