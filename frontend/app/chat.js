/* SKYNET — chat.js : the in-game COMMS panel.
   Talking to your agent is a REAL streaming model call (via Harness). While a reply
   the agent walks to its workstation and types (World.setActivity('task')).
   Supports: preloaded history (resume), and an "awaiting purpose" first-message mode. */
'use strict';

const Chat = (() => {
  let log, input, statusEl;
  let system = '', name = 'AGENT', history = [], busy = false;
  let awaitingPurpose = false, onPurpose = null, onTurn = null;
  let currentAbort = null, currentRunId = null;   // the in-flight run, so DISCONNECT can cancel it
  const el = id => document.getElementById(id);

  function init(opts) {
    system = opts.system || ''; name = opts.name || 'AGENT';
    history = Array.isArray(opts.history) ? opts.history.slice() : [];
    awaitingPurpose = !!opts.awaitingPurpose;
    onPurpose = opts.onPurpose || null; onTurn = opts.onTurn || null;
    busy = false;
    log = el('chat-log'); input = el('chat-input'); statusEl = el('chat-status');
    log.innerHTML = ''; input.value = '';
    renderHistory();
    input.onkeydown = e => {
      if (e.key === 'Enter' && !e.isComposing) {
        const t = input.value.trim();
        if (t) { input.value = ''; send(t); }
      }
    };
    status(awaitingPurpose ? 'awaiting purpose' : 'online');
  }

  function setSystem(s) { system = s; }
  function getHistory() { return history.slice(); }
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
  function renderHistory() {
    for (const m of history) {
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

  async function send(text) {
    if (busy) return;
    // first message after waking sets the agent's purpose (writes its system prompt)
    let purposeTurn = false;
    if (awaitingPurpose) { awaitingPurpose = false; purposeTurn = true; if (onPurpose) onPurpose(text); }
    busy = true;
    addUser(text); history.push({ role: 'user', content: text });

    const isTask = !purposeTurn && Classify.isTaskDirective(text);
    World.setActivity(isTask ? 'task' : 'talk');
    status(isTask ? 'working…' : 'thinking…');
    // for a task the agent works at the computer (lit screen) and the result streams to
    // this panel; for talk it speaks the reply as a bubble in the room.
    const sys = system + (isTask ? ' The Commander has just assigned you a task — carry it out as best you can and report the result clearly.' : '');

    const ac = new AbortController();
    currentAbort = ac; currentRunId = null;
    const callNames = {};   // callId -> tool name (the frozen agent.tool_result has no name field)
    const seenDeliv = {};   // title -> true (one openable row per produced file)
    const out = streamingAgent();
    let acc = '';
    try {
      const { text: reply, error, endReason } = await Harness.chat({
        system: sys, messages: history, agentId: 'agent', isTask, signal: ac.signal,
        onRunId: id => { currentRunId = id; },
        onToken: d => { acc += d; out.append(d); if (!isTask) World.say(acc); App.refreshUsage(); },
        onUsage: () => App.refreshUsage(),
        onToolCall: ev => { callNames[ev.callId] = ev.name; toolLine('▶ ' + ev.name + ' ' + brief(ev.argsSummary)); },
        onToolResult: ev => { const nm = callNames[ev.callId] || 'tool'; toolLine((ev.isError ? '◁ ' : '◀ ') + nm + ' · ' + (ev.summary || (ev.isError ? 'error' : 'ok')) + (ev.ms ? ' (' + ev.ms + 'ms)' : ''), ev.isError); },
        onDeliverable: ev => { if (ev.kind === 'file' && !seenDeliv[ev.title]) { seenDeliv[ev.title] = true; deliverableLine(ev.title, ev.agentId); if (typeof StationUI !== 'undefined') StationUI.notify('saved ' + ev.title, 'gold'); } }
      });
      if (error) {
        out.error(error);
        if (!isTask) World.say('…' + (error.length > 40 ? error.slice(0, 40) + '…' : error));
        if (typeof StationUI !== 'undefined') StationUI.notify('run error: ' + brief(error), 'warn');
      } else {
        history.push({ role: 'assistant', content: reply || acc });
        out.done(); if (!isTask) World.say(reply || acc);
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
      App.refreshUsage();
      if (onTurn) onTurn();
    }
  }

  /* DISCONNECT (or any teardown) cancels the in-flight billable run: abort the fetch (the sidecar's
     req.on('close') then stops the loop) AND tell the sidecar to kill the run by id — belt-and-suspenders. */
  function abort() {
    if (currentAbort) { try { currentAbort.abort(); } catch (_) {} }
    if (currentRunId) Harness.cancel(currentRunId);
  }

  return { init, send, localLine, setSystem, getHistory, abort };
})();
