/* sidecar/channels/hub.js — the messaging BRIDGE (C5): inbound message -> the run host -> streamed reply back.

   This is the analogue of the reference harness's injected `_message_handler`: the ONE seam where a normalized InboundMessage
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

  // ---- in-messenger control commands (pure, channel-agnostic) --------------------------------------------
  // Parse a leading slash-command out of an inbound text. Returns { cmd, arg } (cmd lowercased, no slash) or
  // null when the text is NOT a command (a normal message that should start a run). Only the FIRST token is the
  // command; the remainder (trimmed) is the argument. A bare '/' or unknown token still parses so we can reply
  // with help rather than silently spending a run. Telegram-style '/cmd@botname' is tolerated (strip the @suffix).
  const KNOWN_CMDS = { agents: 1, talk: 1, model: 1, whoami: 1, help: 1 };
  function parseCommand(text) {
    const s = String(text == null ? '' : text).trim();
    if (s[0] !== '/') return null;
    const sp = s.search(/\s/);
    let head = (sp === -1 ? s.slice(1) : s.slice(1, sp)).toLowerCase();
    const at = head.indexOf('@');                 // '/talk@mybot' -> 'talk'
    if (at !== -1) head = head.slice(0, at);
    if (!head || !KNOWN_CMDS[head]) return null;   // not a control command -> treat as a normal message
    const arg = sp === -1 ? '' : s.slice(sp + 1).trim();
    return { cmd: head, arg: arg };
  }

  // Forgiving roster lookup: exact agentId, then case-insensitive exact name, then case-insensitive prefix on
  // name OR agentId (a unique prefix wins; an ambiguous prefix returns { ambiguous:[...] } so we can list them).
  function matchAgent(roster, query) {
    const q = String(query == null ? '' : query).trim();
    if (!q) return null;
    const list = Array.isArray(roster) ? roster : [];
    for (const a of list) if (String(a.agentId) === q) return { agent: a };
    const ql = q.toLowerCase();
    const nameExact = list.filter(a => String(a.name || '').toLowerCase() === ql);
    if (nameExact.length === 1) return { agent: nameExact[0] };
    if (nameExact.length > 1) return { ambiguous: nameExact };
    const pref = list.filter(a => String(a.name || '').toLowerCase().startsWith(ql) || String(a.agentId).toLowerCase().startsWith(ql));
    if (pref.length === 1) return { agent: pref[0] };
    if (pref.length > 1) return { ambiguous: pref };
    return null;
  }

  function fmtAgentLine(a, boundId) {
    const mark = (boundId && String(a.agentId) === String(boundId)) ? '→ ' : '  ';
    const name = a.name && a.name !== a.agentId ? (a.name + ' (' + a.agentId + ')') : a.agentId;
    return mark + name + ' — ' + (a.model || 'no model set');
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
    // INJECTED wall-clock — no ambient fallback (this module is pure/deterministic; the determinism gate bans a bare
    // Date.now here). The composition root passes now:()=>Date.now(); a hub built without one (unit tests) stamps a
    // run's startedAt as null. Used ONLY to age a run in the state snapshot — never for control flow, so a null
    // startedAt is harmless (the frontend's normalizeSnapshot reads a missing startedAt as 0ms-ago).
    const now = typeof o.now === 'function' ? o.now : null;
    const maxMessageLength = o.maxMessageLength || 4096;
    const agentPrefix = o.agentPrefix || 'tg_';
    const resolveAgent = typeof o.resolveAgent === 'function' ? o.resolveAgent : null;   // Phase B: the placed floor's routing plan
    const getTag = typeof o.getTag === 'function' ? o.getTag : null;                     // FILTER content-routing key (B3 classifier)
    const resolveStation = typeof o.resolveStation === 'function' ? o.resolveStation : null;   // B5: per-bay capability station
    // ONE-RESOLVER LAW: any telemetry that attributes an inbound message to an agent (workitem crates, queue
    // HUD) must come from THIS hub's resolution, never a parallel guess. onResolved fires once per real message
    // (never for /commands) with the exact agentId the run will execute as, in onInbound's first synchronous
    // slice — before any run starts. Optional; a throwing hook must never break the inbound.
    const onResolved = typeof o.onResolved === 'function' ? o.onResolved : null;
    // In-messenger control surface (channel-agnostic — lives HERE so Telegram/Discord/any future adapter behave
    // identically). All optional: absent -> commands degrade to an honest "not available here" reply.
    //   roster()          -> [{ agentId, name, model, provider }]  (the SAME roster the browser dossier reads)
    //   setModel(id,model)-> { ok, agentId, model, name?, error? } (MUST go through the roster's own write path)
    //   modelCatalog()    -> [modelId,...]  (optional; when reachable, /model validates against it)
    const rosterFn = typeof o.roster === 'function' ? o.roster : null;
    const setModelFn = typeof o.setModel === 'function' ? o.setModel : null;
    const modelCatalogFn = typeof o.modelCatalog === 'function' ? o.modelCatalog : null;
    if (typeof runOnce !== 'function') throw new Error('makeChannelHub: runOnce is required');
    if (!store || typeof store.loadHistory !== 'function') throw new Error('makeChannelHub: a channel store is required');
    if (typeof send !== 'function') throw new Error('makeChannelHub: a send(chatId,text) is required');

    const personaFor = typeof o.persona === 'function' ? o.persona
      : (() => { const p = (typeof o.persona === 'string' && o.persona) || DEFAULT_PERSONA; return () => p; });

    const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;   // notebook/fs-jail agentId grammar (a configured agentId must match)
    // chatId -> { runId, abort, superseded, agentId, startedAt } (one run per CONVERSATION, not per agent). The
    // record is the SINGLE source of truth for this channel's live runs: E-STOP reads it (killAll in halt.js) AND
    // GET /api/state/snapshot reads it (so a reconnect never wipes a live channel run's floor/HUD state — the
    // reconcile keeps any agent listed here). agentId/startedAt are carried so the snapshot can attribute the run
    // to the acting agent and age it, exactly like an interactive/cron/workshop run in runsMeta. Additive to the
    // record: halt.js only ever reads { abort, superseded }, so the extra fields are invisible to it.
    const inflight = new Map();

    // chatId -> a per-chat agentId, sanitized to the notebook/fs-jail grammar (/^[A-Za-z0-9_-]{1,40}$/). Telegram
    // chat ids are already safe (numeric, '-' for groups); the prefix namespaces them away from the browser 'agent'.
    function agentIdFor(chatId) {
      const tail = String(chatId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40 - agentPrefix.length);
      return agentPrefix + (tail || '0');
    }

    // agentId (optional, last arg) names WHICH roster agent produced this reply, so the floor can pulse the RIGHT
    // agent's dish on a multi-agent station. Passed only for a real RUN reply (onInbound); administrative command
    // replies (/agents, /model…) omit it — no agent "produced" them, so the floor should not attribute a dish.
    async function deliver(chatId, text, runId, reason, agentId) {
      const chunks = chunkText(text, maxMessageLength);
      let ok = true;
      for (const c of chunks) {
        let r;
        try { r = await send(chatId, c); } catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
        if (!r || r.ok === false) { ok = false; break; }
      }
      const ev = { channel, chatId: String(chatId), runId: runId || '', ok, chunks: chunks.length, reason: reason || '' };
      if (agentId) ev.agentId = String(agentId);   // additive/optional — attribute the dish to the acting agent
      try { emit('channel.delivery', ev); } catch (_) {}
      return ok;
    }

    // Resolve which agent a chat is currently bound to, from the SAME precedence run resolution uses (minus the
    // live floor plan, which is content-per-message and not a stable "who am I talking to"). Used by /agents,
    // /talk confirmations, and /model to name the target honestly.
    function currentBoundAgent(chatId, boundAgentId, sec) {
      if (boundAgentId) return boundAgentId;
      if (sec && sec.agentId && AID_RE.test(String(sec.agentId))) return String(sec.agentId);
      return agentIdFor(chatId);
    }

    // Handle a parsed control command. Every reply states what ACTUALLY happened (truthful telemetry): a rebind
    // only claims success after saveChatRecord returns; a model change only confirms after setModel reports ok.
    async function handleCommand(chatId, parsed, boundAgentId, sec) {
      const cmd = parsed.cmd, arg = parsed.arg;
      // rosterFn is an INJECTED callback (Discord/other wire-ups pass it straight through); a throwing roster must
      // degrade to a logged error + polite reply, never an unhandled rejection that swallows the whole inbound.
      let roster;
      try { roster = rosterFn ? (rosterFn() || []) : null; }
      catch (e) { try { console.error('[' + channel + '] roster lookup threw in /' + cmd + ':', (e && e.message) || e); } catch (_) {} await deliver(chatId, '⚠ Could not read the agent roster right now — try again in a moment.', '', 'error'); return; }
      const boundId = currentBoundAgent(chatId, boundAgentId, sec);
      // NOTE: no dedicated channel.command/rebind/model bus events — shared/events.js is owned by another
      // workstream (additive-only, by request). The command's honest confirmation is the reply itself; the
      // downstream binding/roster writes are observable in the chatmap + roster files. See report.

      if (cmd === 'help') {
        await deliver(chatId,
          'Commands:\n/agents — list agents (→ marks the one you\'re talking to)\n'
          + '/talk <name> — switch this chat to another agent\n'
          + '/model [id] — show or change the current agent\'s model\n/whoami — show the current agent',
          '', 'command');
        return;
      }

      if (cmd === 'agents' || cmd === 'whoami') {
        if (!roster || !roster.length) { await deliver(chatId, 'No roster is available to this channel yet.', '', 'command'); return; }
        if (cmd === 'whoami') {
          const me = roster.find(a => String(a.agentId) === String(boundId));
          await deliver(chatId, me ? ('You are talking to ' + fmtAgentLine(me, boundId).trim()) : ('This chat is bound to "' + boundId + '" (not in the current roster).'), '', 'command');
          return;
        }
        const lines = roster.map(a => fmtAgentLine(a, boundId));
        await deliver(chatId, 'Agents (' + roster.length + '):\n' + lines.join('\n') + '\n\n/talk <name> to switch · /model to change model', '', 'command');
        return;
      }

      if (cmd === 'talk') {
        if (!roster || !roster.length) { await deliver(chatId, 'No roster is available to this channel yet — cannot switch agents.', '', 'command'); return; }
        if (!arg) { await deliver(chatId, 'Usage: /talk <name>. ' + roster.length + ' available:\n' + roster.map(a => '  ' + (a.name || a.agentId)).join('\n'), '', 'command'); return; }
        const m = matchAgent(roster, arg);
        if (!m) { await deliver(chatId, 'No agent matches "' + arg + '". Available:\n' + roster.map(a => '  ' + (a.name || a.agentId)).join('\n'), '', 'command'); return; }
        if (m.ambiguous) { await deliver(chatId, '"' + arg + '" matches several agents — be more specific:\n' + m.ambiguous.map(a => '  ' + (a.name || a.agentId)).join('\n'), '', 'command'); return; }
        const target = m.agent;
        // Persist the rebind. Only confirm the switch if the write actually succeeded (truthful telemetry).
        let saved = false;
        try { if (typeof store.saveChatRecord === 'function') { store.saveChatRecord(chatId, { agentId: String(target.agentId), channel: channel }); saved = true; } } catch (_) { saved = false; }
        if (!saved) { await deliver(chatId, '⚠ Could not persist the switch to "' + (target.name || target.agentId) + '" — this chat is still talking to the previous agent.', '', 'command'); return; }
        const nm = target.name && target.name !== target.agentId ? (target.name + ' (' + target.agentId + ')') : target.agentId;
        await deliver(chatId, 'Now talking to ' + nm + ' — model: ' + (target.model || 'not set') + '.', '', 'command');
        return;
      }

      if (cmd === 'model') {
        if (!roster || !roster.length) { await deliver(chatId, 'No roster is available to this channel yet — cannot read or change models.', '', 'command'); return; }
        const me = roster.find(a => String(a.agentId) === String(boundId));
        if (!me) { await deliver(chatId, 'This chat is bound to "' + boundId + '", which is not in the current roster — /talk to pick an agent first.', '', 'command'); return; }
        if (!arg) { await deliver(chatId, (me.name || me.agentId) + '\'s current model: ' + (me.model || 'not set') + '.\nSend /model <id> to change it.', '', 'command'); return; }
        // Validate against the model catalog when one is reachable sidecar-side; otherwise accept and be honest
        // that no catalog was available to check against.
        let catalog = null;
        try { catalog = modelCatalogFn ? (modelCatalogFn() || null) : null; } catch (_) { catalog = null; }
        if (Array.isArray(catalog) && catalog.length && catalog.indexOf(arg) === -1) {
          const near = catalog.filter(id => String(id).toLowerCase().indexOf(arg.toLowerCase()) !== -1).slice(0, 8);
          await deliver(chatId, '"' + arg + '" is not in the available model catalog.' + (near.length ? ('\nDid you mean:\n' + near.map(x => '  ' + x).join('\n')) : ''), '', 'command');
          return;
        }
        if (!setModelFn) { await deliver(chatId, '⚠ Model changes are not available on this channel (no roster write path wired).', '', 'command'); return; }
        let r; try { r = setModelFn(String(me.agentId), arg); } catch (e) { r = { ok: false, error: (e && e.message) || 'write threw' }; }
        if (!r || r.ok === false) { await deliver(chatId, '⚠ Could not change the model — ' + ((r && r.error) || 'roster write failed') + '. It is still ' + (me.model || 'not set') + '.', '', 'command'); return; }
        await deliver(chatId, (me.name || me.agentId) + '\'s model is now ' + (r.model || arg) + ' (saved to the roster).', '', 'command');
        return;
      }
    }

    async function onInbound(msg) {
      if (!msg || !msg.text) return;   // non-text already filtered by the adapter; belt-and-suspenders
      const chatId = String(msg.chatId);

      // Runtime config (live each message): { key?, model, provider?, agentId?, system? }. When the app supplies the
      // REAL agentId + composed system prompt at connect, Telegram runs as the SAME agent as in the app —
      // same notebook (memory), workspace, and identity — just a different session. Absent config falls back
      // to a per-chat agent (tg_<chatId>) + the default persona.
      // secrets() is an INJECTED callback; a throwing one (e.g. a store hiccup) must degrade to a logged error +
      // polite reply rather than an unhandled rejection (onInbound is driven fire-and-forget by the adapter).
      let sec;
      try { sec = secrets() || {}; }
      catch (e) { try { console.error('[' + channel + '] secrets() threw in onInbound:', (e && e.message) || e); } catch (_) {} try { await deliver(chatId, '⚠ Could not read the channel configuration right now — try again in a moment.', '', 'error'); } catch (_) {} return; }
      const provider = String(sec.provider || 'openrouter').trim().toLowerCase() || 'openrouter';
      const usingCodex = provider === 'codex' || provider === 'openai-codex';
      const reasoningEffort = sec.reasoningEffort || sec.reasoning_effort || (usingCodex ? 'low' : 'medium');
      // The chat's own persisted binding (set by /talk) — the user's explicit choice of which roster agent this
      // chat talks to. Read it once here so both command handling (below) and run resolution can honor it.
      let boundRec = null;
      try { if (typeof store.getChatRecord === 'function') boundRec = store.getChatRecord(chatId); } catch (_) {}
      const boundAgentId = (boundRec && boundRec.agentId && AID_RE.test(String(boundRec.agentId))) ? String(boundRec.agentId) : null;

      // Control commands are intercepted BEFORE any run starts — they must never spawn an LLM run. Replies go out
      // through the SAME deliver() path so chunking/limits apply. Channel-agnostic: this lives in the hub, so
      // Telegram/Discord/any future adapter get identical behavior.
      const parsed = parseCommand(msg.text);
      if (parsed) { await handleCommand(chatId, parsed, boundAgentId, sec); return; }

      // Phase B routing: the placed floor (a posted RoutingPlan) decides WHICH agent runs. resolveAgent
      // returns the bay-bound agentId, or null -> fall through to today's resolution so real work NEVER stalls.
      // Resolution order: floor plan > this chat's explicit /talk binding > the connect-time configured agentId >
      // the per-chat tg_<chatId> fallback (an unbound chat still just works).
      const tag = getTag ? getTag(msg.text) : undefined;
      const routed = resolveAgent ? resolveAgent({ tag, chatId, text: msg.text, boundAgentId }) : null;
      const agentId = (routed && AID_RE.test(String(routed))) ? String(routed)
        : boundAgentId
        ? boundAgentId
        : (sec.agentId && AID_RE.test(String(sec.agentId))) ? String(sec.agentId) : agentIdFor(chatId);

      // B4 — persist the chat→agent binding (+ this hub's channel) so the autonomous notifier can find which chat to
      // ping for a given agent when a cron run produces work. Best-effort: a store hiccup must never block the reply.
      // GUARD (2026-07-05): a FLOOR-ROUTED agent must never overwrite the user's explicit /talk binding — one
      // belt-routed message used to silently rebind the whole chat to whatever bay the belts picked, so /whoami,
      // /model and the notifier all started asserting an agent the user never chose. Persist only when the chat is
      // unbound or the resolution agrees with the binding.
      try { if (typeof store.saveChatRecord === 'function' && (!boundAgentId || boundAgentId === agentId)) store.saveChatRecord(chatId, { agentId: agentId, channel: channel }); } catch (_) {}

      // announce the SINGLE resolution to the host (workitem crate + queue HUD attribution — one truth).
      // isTask rides along: the BELT IS WORK-ONLY (Andrew's ruling 2026-07-05) — the host places a crate only
      // for a real task directive; "hello" gets a reply and NOTHING on the floor. Same classifier that gates
      // the desk walk + the task tool suffix below, so the body and the belt tell one story.
      const isTask = !!classify(msg.text);
      if (onResolved) { try { onResolved({ chatId: chatId, agentId: agentId, text: msg.text, isTask: isTask }); } catch (_) {} }

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

      const rec = store.getChatRecord ? store.getChatRecord(chatId) : null;
      const persona = sec.system || personaFor(agentId, rec);   // the agent's REAL composed prompt when configured
      const system = persona + (isTask ? TASK_SUFFIX : '');

      const runId = newId();
      const ac = new AbortController();
      // agentId/startedAt ride in the record so GET /api/state/snapshot can list THIS run (attributed to the acting
      // agent, aged from startedAt) — a reconnect then keeps the agent's live floor/HUD state instead of clearing
      // it. abort/superseded remain what halt.js's E-STOP reads; the extra fields are additive and invisible to it.
      const myRec = { runId, abort: ac, superseded: false, agentId: agentId, startedAt: now ? now() : null };
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
      await deliver(chatId, reply, runId, state.errMsg ? 'error' : (state.reason || 'done'), agentId);
    }

    // inline-keyboard taps (consent buttons) — wired in C6; a noop under the autonomous MVP.
    function onCallback(_cb) { /* C6: route { chatId, data, callbackId } to the pending consent finisher */ }

    // adapter transport health -> channel.connect telemetry (poll up / network down / fatal token error).
    function onStatus(s) {
      try { emit('channel.connect', { channel, state: (s && s.state) || 'down', detail: (s && s.detail) || '' }); } catch (_) {}
    }

    return {
      onInbound, onCallback, onStatus,
      _internals: { agentIdFor, chunkText, endNote, deliver, inflight, handleCommand, currentBoundAgent, TASK_SUFFIX, DEFAULT_PERSONA }
    };
  }

  return { makeChannelHub, chunkText, endNote, parseCommand, matchAgent, fmtAgentLine, _internals: { TASK_SUFFIX, DEFAULT_PERSONA, parseCommand, matchAgent, fmtAgentLine } };
});
