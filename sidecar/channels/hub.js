/* sidecar/channels/hub.js — the messaging BRIDGE (C5): inbound message -> the run host -> streamed reply back.

   This is the analogue of Hermes's injected `_message_handler`: the ONE seam where a normalized InboundMessage
   drives the EXISTING run host (runOnce, extracted from handleRun) and the agent's reply is delivered back to
   the platform. The hub knows nothing of the loop/provider/broker internals — it is handed `runOnce`, the
   durable `store`, a `send`, the current `secrets` (OR key+model), and a `classify` (task-vs-talk), all injected.

     makeChannelHub({ channel, runOnce, store, send, secrets, persona, classify, redact, emit, newId,
                      maxMessageLength?, agentPrefix? }) -> { onInbound, onCallback, onStatus }

   Per inbound it: (1) maps chatId -> a per-chat agentId (`tg_<chatId>`, isolated notebook/workspace/history);
   (2) loads the durable transcript, appends the user turn; (3) runs `runOnce` with surface:'autonomous' (a
   headless chat has no browser to answer a permission.prompt, so an ungranted mutation default-denies and the
   run continues — never stalls); (4) assembles the reply by concatenating agent.token deltas (the SAME contract
   harness.js uses in the browser — there is no agent.message event); (5) delivers it chunked to the platform's
   message-length limit; (6) emits channel.inbound / channel.delivery telemetry. One run per chat: a new message
   ABORTS the in-flight run for that chat and serves the latest (natural chat behavior). The existing per-run
   caps (maxIters/maxCostUsd/maxToolBytes) still bind — a messaging run is just another caller of runOnce.

   Pure + deterministic: every dependency is injected (no fetch/fs/clock/rng here); ids come from `newId`. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.hub = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TASK_SUFFIX = ' The Commander has just messaged you a task — carry it out as best you can and report the result clearly.';
  const DEFAULT_PERSONA = 'You are the Commander\'s AI agent, reachable over a messaging app. Address the user as "Commander", '
    + 'keep a spark of personality, and keep replies concise and chat-friendly. When given a task you have REAL tools '
    + '(web search/read, files, memory) — use them and report what you actually found.';

  // why a stopped run ended, as a short human note appended to the reply (mirrors chat.js endReason handling).
  function endNote(reason) {
    if (reason === 'max_iters') return '\n\n(reached the step limit — message "continue" to keep going.)';
    if (reason === 'budget') return '\n\n(reached this run\'s cost limit.)';
    if (reason === 'cancelled') return '';
    if (reason === 'refusal') return '';
    return '\n\n(stopped: ' + reason + ')';
  }

  // split text into <=max-length pieces, preferring to break at the last newline/space so words/lines stay whole.
  function chunkText(text, max) {
    const s = String(text == null ? '' : text);
    if (s.length <= max) return s.length ? [s] : [];
    const out = [];
    let i = 0;
    while (i < s.length) {
      let end = Math.min(i + max, s.length);
      if (end < s.length) {
        const slice = s.slice(i, end);
        const nl = slice.lastIndexOf('\n');
        const sp = slice.lastIndexOf(' ');
        const cut = nl > max * 0.5 ? nl : (sp > max * 0.5 ? sp : -1);
        if (cut > 0) end = i + cut + 1;
      }
      out.push(s.slice(i, end));
      i = end;
    }
    return out;
  }

  function makeChannelHub(opts) {
    const o = opts || {};
    const channel = o.channel || 'telegram';
    const runOnce = o.runOnce;
    const store = o.store;
    const send = o.send;
    const secrets = typeof o.secrets === 'function' ? o.secrets : () => ({});
    const classify = typeof o.classify === 'function' ? o.classify : () => true;
    const redact = typeof o.redact === 'function' ? o.redact : (p) => p;
    const emit = typeof o.emit === 'function' ? o.emit : () => {};
    const newId = typeof o.newId === 'function' ? o.newId : (() => { let n = 0; return () => channel + '-run-' + (++n); })();
    const maxMessageLength = o.maxMessageLength || 4096;
    const agentPrefix = o.agentPrefix || 'tg_';
    const resolveAgent = typeof o.resolveAgent === 'function' ? o.resolveAgent : null;   // Phase B: the placed floor's routing plan
    const getTag = typeof o.getTag === 'function' ? o.getTag : null;                     // FILTER content-routing key (B3 classifier)
    const resolveStation = typeof o.resolveStation === 'function' ? o.resolveStation : null;   // B5: per-bay capability station
    if (typeof runOnce !== 'function') throw new Error('makeChannelHub: runOnce is required');
    if (!store || typeof store.loadHistory !== 'function') throw new Error('makeChannelHub: a channel store is required');
    if (typeof send !== 'function') throw new Error('makeChannelHub: a send(chatId,text) is required');

    const personaFor = typeof o.persona === 'function' ? o.persona
      : (() => { const p = (typeof o.persona === 'string' && o.persona) || DEFAULT_PERSONA; return () => p; });

    const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;   // notebook/fs-jail agentId grammar (a configured agentId must match)
    const inflight = new Map();   // chatId -> { runId, abort, superseded } (one run per CONVERSATION, not per agent)

    // chatId -> a per-chat agentId, sanitized to the notebook/fs-jail grammar (/^[A-Za-z0-9_-]{1,40}$/). Telegram
    // chat ids are already safe (numeric, '-' for groups); the prefix namespaces them away from the browser 'agent'.
    function agentIdFor(chatId) {
      const tail = String(chatId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40 - agentPrefix.length);
      return agentPrefix + (tail || '0');
    }

    async function deliver(chatId, text, runId, reason) {
      const chunks = chunkText(text, maxMessageLength);
      let ok = true;
      for (const c of chunks) {
        let r;
        try { r = await send(chatId, c); } catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
        if (!r || r.ok === false) { ok = false; break; }
      }
      try { emit('channel.delivery', { channel, chatId: String(chatId), runId: runId || '', ok, chunks: chunks.length, reason: reason || '' }); } catch (_) {}
      return ok;
    }

    async function onInbound(msg) {
      if (!msg || !msg.text) return;   // non-text already filtered by the adapter; belt-and-suspenders
      const chatId = String(msg.chatId);

      // Runtime config (live each message): { key?, model, provider?, agentId?, system? }. When the app supplies the
      // REAL agentId + composed system prompt at connect, Telegram runs as the SAME agent as in the app —
      // same notebook (memory), workspace, and identity — just a different session. Absent config falls back
      // to a per-chat agent (tg_<chatId>) + the default persona.
      const sec = secrets() || {};
      const provider = String(sec.provider || 'openrouter').trim().toLowerCase() || 'openrouter';
      const usingCodex = provider === 'codex' || provider === 'openai-codex';
      const reasoningEffort = sec.reasoningEffort || sec.reasoning_effort || (usingCodex ? 'low' : 'medium');
      // Phase B routing: the placed floor (a posted RoutingPlan) decides WHICH agent runs. resolveAgent
      // returns the bay-bound agentId, or null -> fall through to today's resolution so real work NEVER stalls.
      const tag = getTag ? getTag(msg.text) : undefined;
      const routed = resolveAgent ? resolveAgent({ tag, chatId, text: msg.text }) : null;
      const agentId = (routed && AID_RE.test(String(routed))) ? String(routed)
        : (sec.agentId && AID_RE.test(String(sec.agentId))) ? String(sec.agentId) : agentIdFor(chatId);

      // B4 — persist the chat→agent binding (+ this hub's channel) so the autonomous notifier can find which chat to
      // ping for a given agent when a cron run produces work. Best-effort: a store hiccup must never block the reply.
      try { if (typeof store.saveChatRecord === 'function') store.saveChatRecord(chatId, { agentId: agentId, channel: channel }); } catch (_) {}

      // one run per CONVERSATION: a new message in THIS chat ABORTS its in-flight run — keyed by chatId, NOT
      // agentId, so two chats routed to the SAME agent (via a splitter/filter) never cross-cancel each other.
      const prev = inflight.get(chatId);
      if (prev) { prev.superseded = true; try { prev.abort.abort(); } catch (_) {} }

      try { emit('channel.inbound', { channel, chatId, agentId, userId: msg.userId || '', kind: msg.chatType === 'group' ? 'group' : 'dm' }); } catch (_) {}

      if (!sec.model || (!usingCodex && !sec.configured && !sec.key)) {
        await deliver(chatId, '⚠ No provider/model is configured yet. Open the STARNET app → Messaging tab and connect.', '', 'error');
        return;
      }

      // durable transcript: load prior turns, persist the new user turn, build the replay messages.
      let history = [];
      try { history = store.loadHistory(agentId); } catch (_) {}
      try { store.appendTurn(agentId, 'user', msg.text); } catch (_) {}
      const messages = history.map(m => ({ role: m.role, content: m.content })).concat([{ role: 'user', content: msg.text }]);

      const isTask = !!classify(msg.text);
      const rec = store.getChatRecord ? store.getChatRecord(chatId) : null;
      const persona = sec.system || personaFor(agentId, rec);   // the agent's REAL composed prompt when configured
      const system = persona + (isTask ? TASK_SUFFIX : '');

      const runId = newId();
      const ac = new AbortController();
      const myRec = { runId, abort: ac, superseded: false };
      inflight.set(chatId, myRec);

      // assemble the reply by buffering agent.token deltas — the SAME reassembly harness.js does in the browser.
      const state = { runId, buf: '', errMsg: null, reason: null };
      const sink = (name, payload) => {
        let p; try { p = redact(payload); } catch (_) { p = payload; }
        if (name === 'agent.run.start') state.runId = p.runId || state.runId;
        else if (name === 'agent.token') state.buf += (p.delta || '');
        else if (name === 'agent.run.error') state.errMsg = p.message || 'run error';
        else if (name === 'capdenied') state.errMsg = state.errMsg || ('no ' + (p.need || 'capability') + ' — ' + (p.reason || ''));
        else if (name === 'agent.run.end') state.reason = p.reason;
      };

      // B5: if this agent runs at a bound BAY, its tools are that bay room's objects (resolveStation), not the
      // default office — so a routed agent's reach is exactly what the floor granted it. null -> office default.
      const bayStation = resolveStation ? resolveStation(agentId) : null;
      try {
        await runOnce({
          key: usingCodex ? '' : sec.key, model: sec.model, provider, baseUrl: sec.baseUrl || sec.base_url || '', reasoningEffort, system, messages, agentId, isTask,
          emit: sink, signal: ac.signal, runId, trigger: 'event', surface: 'autonomous',
          broadcast: true,   // P1: mirror this routed run's lifecycle to the station floor over SSE — it has no browser-local stream
          station: bayStation || undefined
        });
      } catch (e) {
        state.errMsg = state.errMsg || ('run failed: ' + ((e && e.message) || e));
      } finally {
        if (inflight.get(chatId) === myRec) inflight.delete(chatId);
      }

      // a newer message took over this chat — abandon this run's (now stale) partial reply.
      if (myRec.superseded) return;

      // persist the assistant turn only on a real, non-error reply; build the outgoing text.
      let reply;
      if (state.errMsg) {
        reply = '⚠ ' + state.errMsg;
      } else {
        if (state.buf) { try { store.appendTurn(agentId, 'assistant', state.buf); } catch (_) {} }
        reply = state.buf || '(no reply)';
        if (state.reason && state.reason !== 'done') reply += endNote(state.reason);
      }
      await deliver(chatId, reply, runId, state.errMsg ? 'error' : (state.reason || 'done'));
    }

    // inline-keyboard taps (consent buttons) — wired in C6; a noop under the autonomous MVP.
    function onCallback(_cb) { /* C6: route { chatId, data, callbackId } to the pending consent finisher */ }

    // adapter transport health -> channel.connect telemetry (poll up / network down / fatal token error).
    function onStatus(s) {
      try { emit('channel.connect', { channel, state: (s && s.state) || 'down', detail: (s && s.detail) || '' }); } catch (_) {}
    }

    return {
      onInbound, onCallback, onStatus,
      _internals: { agentIdFor, chunkText, endNote, deliver, inflight, TASK_SUFFIX, DEFAULT_PERSONA }
    };
  }

  return { makeChannelHub, chunkText, endNote, _internals: { TASK_SUFFIX, DEFAULT_PERSONA } };
});
