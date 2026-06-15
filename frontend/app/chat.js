/* SKYNET — chat.js : the in-game COMMS panel.
   Talking to your agent is a REAL streaming model call (via Harness). While a reply
   the agent walks to its workstation and types (World.setActivity('task')).
   Supports: preloaded history (resume), and an "awaiting purpose" first-message mode. */
'use strict';

// VOICE MODE augmentation — appended to the system prompt (per-turn, ephemeral) only when the
// agent is about to SPEAK a conversational reply. Forces a short, spoken-style answer; the paired
// text/task turns get NO augmentation, so written replies keep full structure (the whole "voice =
// laid-back back-and-forth, type = detailed" split is produced by the presence/absence of this block).
const VOICE_MODE_RULES = "\n\n[VOICE MODE — you're talking out loud, not typing.] Reply the way you'd actually SAY it:"
  + " 1-3 short sentences, max. Use contractions (you're, gonna, it's, lemme). Plain spoken words only —"
  + " absolutely NO markdown, asterisks, bullet points, numbered lists, headers, code blocks, emoji, or links;"
  + " those can't be heard. Don't read out URLs or file paths character-by-character — just say what you did."
  + " No throat-clearing, no 'As an AI', no 'I'd be happy to', no recapping the question. Sound like a relaxed"
  + " buddy giving a quick answer across the room. If the real answer is long, give the one-line version out"
  + " loud and offer to drop the details in chat.";

const Chat = (() => {
  let log, input, statusEl;
  let system = '', name = 'AGENT', activeWs = null, busy = false;
  let awaitingPurpose = false, onPurpose = null, onTurn = null;
  let currentAbort = null, currentRunId = null;   // the in-flight run, so DISCONNECT can cancel it
  const el = id => document.getElementById(id);

  function init(opts) {
    system = opts.system || ''; name = opts.name || 'AGENT';
    awaitingPurpose = !!opts.awaitingPurpose;
    onPurpose = opts.onPurpose || null; onTurn = opts.onTurn || null;
    busy = false;
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
    if (log) log.innerHTML = '';
    renderHistory();
    status(awaitingPurpose ? 'awaiting purpose' : (busy ? 'working…' : 'online'));
  }

  function setSystem(s) { system = s; }
  function getHistory() { return activeWs ? activeWs.history.slice() : []; }
  function isBusy() { return busy; }
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
    r.body.appendChild(document.createTextNode('📄 saved '));
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
  function permissionRow(ev) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('consent');
    r.body.appendChild(document.createTextNode('🔒 ' + name + ' wants to ' + actionPhrase(ev) + ' '));
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    let decided = false;
    function decide(decision, doneLabel, isDeny) {
      if (decided) return; decided = true;
      Harness.consent(currentRunId, ev.promptId, decision);
      btns.remove();
      const tag = document.createElement('span');
      tag.className = 'consent-result' + (isDeny ? ' err' : '');
      tag.textContent = doneLabel;
      r.body.appendChild(tag);
      status(busy ? 'working…' : 'online');
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
    if (typeof StationUI !== 'undefined') StationUI.notify(name + ' needs approval to ' + actionPhrase(ev), 'warn');
    log.scrollTop = log.scrollHeight;
  }

  function renderHistory() {
    const h = activeWs ? activeWs.history : [];
    for (const m of h) {
      if (m.role === 'user') addUser(m.content);
      else row('agent').body.textContent = m.content;
    }
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

  async function send(text, opts) {
    opts = opts || {};   // { spoken } — true when this came from the mic (drives the voice-mode brevity below)
    if (busy) return;
    const ws = activeWs;   // CAPTURE the origin stream now — a mid-run switch must not cross-post its cost/files
    if (!ws) return;
    // first message after waking sets the agent's purpose (writes its system prompt)
    let purposeTurn = false;
    if (awaitingPurpose) { awaitingPurpose = false; purposeTurn = true; if (onPurpose) onPurpose(text); }
    busy = true;
    addUser(text); ws.history.push({ role: 'user', content: text });
    // name an untitled stream from its first real message (no-op on General / already-titled)
    if (!purposeTurn && typeof Workstreams !== 'undefined' && Workstreams.autoTitle(ws.id, text)) {
      if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
    }

    const isTask = !purposeTurn && Classify.isTaskDirective(text);
    World.setActivity(isTask ? 'task' : 'talk');
    status(isTask ? 'working…' : 'thinking…');
    // for a task the agent works at the computer (lit screen) and the result streams to
    // this panel; for talk it speaks the reply as a bubble in the room.
    // VOICE MODE: only when the Commander actually SPOKE this turn (and the agent will answer aloud)
    // do we append the short/spoken-style rule. A TYPED conversational question — even with the
    // speaker on — keeps full written detail (it's just read aloud). Appended LAST so it wins on
    // format; never baked into the saved prompt and never sent on text/task turns.
    const voiceTurn = !isTask && !!opts.spoken && typeof Voice !== 'undefined' && Voice.isOn && Voice.isOn();
    const sys = system
      + (isTask ? ' The Commander has just assigned you a task — carry it out as best you can and report the result clearly.' : '')
      + (voiceTurn ? VOICE_MODE_RULES : '');

    const before = Object.assign({}, Harness.totals());   // COPY (totals is a mutated singleton) so the per-stream diff is real
    const ac = new AbortController();
    currentAbort = ac; currentRunId = null;
    const callNames = {};   // callId -> tool name (the frozen agent.tool_result has no name field)
    const seenDeliv = {};   // title -> true (one openable row per produced file)
    const out = streamingAgent();
    let acc = '';
    try {
      const { text: reply, error, endReason } = await Harness.chat({
        system: sys, messages: ws.history, agentId: ws.agentId || 'agent', isTask, signal: ac.signal,
        onRunId: id => { currentRunId = id; if (typeof Workstreams !== 'undefined') { Workstreams.appendRun(ws.id, id); if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } },
        onToken: d => { acc += d; out.append(d); if (!isTask) World.say(acc); App.refreshUsage(); },
        onUsage: () => App.refreshUsage(),
        onToolCall: ev => { callNames[ev.callId] = ev.name; toolLine('▶ ' + ev.name + ' ' + brief(ev.argsSummary)); },
        onToolResult: ev => { const nm = callNames[ev.callId] || 'tool'; toolLine((ev.isError ? '◁ ' : '◀ ') + nm + ' · ' + (ev.summary || (ev.isError ? 'error' : 'ok')) + (ev.ms ? ' (' + ev.ms + 'ms)' : ''), ev.isError); },
        onDeliverable: ev => {
          if (ev.kind === 'file' && !seenDeliv[ev.title]) {
            seenDeliv[ev.title] = true; deliverableLine(ev.title, ev.agentId);
            // the frozen 'deliverable' event carries no runId/time — synthesize from the live run + clock
            if (typeof Workstreams !== 'undefined') Workstreams.recordDeliverable(ws.id, { title: ev.title, kind: ev.kind, runId: currentRunId, t: Date.now() });
            if (typeof StationUI !== 'undefined') StationUI.notify('saved ' + ev.title, 'gold');
          }
        },
        onPermission: ev => permissionRow(ev)
      });
      if (error) {
        out.error(error);
        if (!isTask) World.say('…' + (error.length > 40 ? error.slice(0, 40) + '…' : error));
        if (typeof StationUI !== 'undefined') StationUI.notify('run error: ' + brief(error), 'warn');
      } else {
        ws.history.push({ role: 'assistant', content: reply || acc });
        out.done();
        // a conversational reply: the agent shows it as a room bubble AND speaks it aloud (per-agent voice).
        if (!isTask) { World.say(reply || acc); if (typeof Voice !== 'undefined') Voice.speak(reply || acc, name); }
        // the run stopped before a natural finish — tell the Commander why (not a silent dead-end)
        if (endReason && endReason !== 'done') {
          toolLine('⏹ ' + (endReason === 'max_iters' ? 'reached the step limit — say "continue" to keep going'
            : endReason === 'budget' ? 'reached this run\'s cost limit'
            : endReason === 'cancelled' ? 'run cancelled'
            : 'stopped (' + endReason + ')'));
          if (typeof StationUI !== 'undefined') StationUI.notify('run stopped: ' + endReason, 'warn');
        }
      }
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));
      out.error(aborted ? '— disconnected —' : (e.message || String(e)));
      if (!isTask && !aborted) World.say('…connection trouble…');
    } finally {
      currentAbort = null; currentRunId = null;
      busy = false; status('online'); World.setActivity('idle');   // task done → agent stands up
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
      // hands-free voice mode: the run is done — let Voice re-open the mic for the next turn.
      if (typeof Voice !== 'undefined' && Voice.onTurnEnd) Voice.onTurnEnd();
    }
  }

  /* DISCONNECT (or any teardown) cancels the in-flight billable run: abort the fetch (the sidecar's
     req.on('close') then stops the loop) AND tell the sidecar to kill the run by id — belt-and-suspenders. */
  function abort() {
    if (typeof Voice !== 'undefined' && Voice.stopConvo) Voice.stopConvo();   // drop hands-free on disconnect
    if (currentAbort) { try { currentAbort.abort(); } catch (_) {} }
    if (currentRunId) Harness.cancel(currentRunId);
  }

  return { init, load, send, status, localLine, setSystem, getHistory, abort, isBusy };
})();
