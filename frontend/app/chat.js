/* SKYNET — chat.js : the in-game COMMS panel.
   Talking to your agent is a REAL streaming model call (via Harness). While a reply
   streams, the agent walks to its workstation and types (World.setThinking).
   Supports: preloaded history (resume), and an "awaiting purpose" first-message mode. */
'use strict';

const Chat = (() => {
  let log, input, statusEl;
  let system = '', name = 'AGENT', history = [], busy = false;
  let awaitingPurpose = false, onPurpose = null, onTurn = null;
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

  async function send(text) {
    if (busy) return;
    // first message after waking sets the agent's purpose (writes its system prompt)
    if (awaitingPurpose) { awaitingPurpose = false; if (onPurpose) onPurpose(text); }
    busy = true; status('thinking…');
    addUser(text); history.push({ role: 'user', content: text });
    World.setThinking(true);
    const out = streamingAgent();
    let acc = '';
    try {
      const { text: reply } = await Harness.chat({
        system, messages: history,
        onToken: d => { acc += d; out.append(d); World.say(acc); App.refreshUsage(); },
        onUsage: () => App.refreshUsage()
      });
      history.push({ role: 'assistant', content: reply || acc });
      out.done(); World.say(reply || acc);
    } catch (e) {
      out.error(e.message || String(e));
      World.say('…connection trouble…');
    } finally {
      busy = false; status('online'); World.setThinking(false);
      App.refreshUsage();
      if (onTurn) onTurn();
    }
  }

  return { init, send, localLine, setSystem, getHistory };
})();
