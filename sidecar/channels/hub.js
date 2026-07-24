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
  // A 'budget' stop names WHICH spend cap fired (scope/cap ride the additive agent.run.end fields; absent on an
  // old payload → the generic money line) so a channel user isn't sent hunting through runtime settings.
  function budgetNote(scope, capUsd) {
    const cap = (typeof capUsd === 'number' && isFinite(capUsd) && capUsd >= 0.01) ? '$' + capUsd.toFixed(2).replace(/\.00$/, '') + ' ' : '';   // sub-cent caps would read "$0.00"
    const what = scope === 'run' ? 'hit the ' + cap + 'per-run spend cap'
      : scope === 'agent' ? 'this agent hit its ' + cap + 'lifetime spend cap'
      : scope === 'day' ? 'hit the ' + cap + 'daily spend cap'
      : scope === 'global' ? 'hit the ' + cap + 'all-time spend cap'
      : 'hit a spend cap';
    return '\n\n(' + what + ' — raise or remove it in the app under MISSION CONTROL → BUDGET.)';
  }
  function endNote(reason, state) {
    if (reason === 'max_iters') return '\n\n(reached the step limit — message "continue" to keep going.)';
    if (reason === 'budget') return budgetNote(state && state.budgetScope, state && state.budgetCapUsd);
    if (reason === 'cancelled') return '';
    if (reason === 'clarifying') return '';   // a Task Brief question IS the reply — never a "(stopped: …)" note
    if (reason === 'refusal') return '';
    return '\n\n(stopped: ' + reason + ')';
  }

  // HISTORICAL COMPAT (concurrent-sessions lane, 2026-07-18): the host's admission-time same-agent mutex
  // ("already running a task…") is RETIRED — a current sidecar ADMITS the replacement run even while the aborted
  // one unwinds, so this retry class simply never fires against it. The classifier + bounded retry are KEPT as
  // defense in depth for a version-skewed host (an older sidecar behind a newer bridge) where the supersede race
  // can still surface that transient refusal. Matched on transient + the distinctive phrase so a different
  // transient never gets silently looped. Kept as a narrow regex, not a substring, to avoid false hits.
  const SUPERSEDE_REFUSAL_RE = /already running a task/i;
  function isSupersedeRaceRefusal(transient, message) {
    return !!transient && SUPERSEDE_REFUSAL_RE.test(String(message == null ? '' : message));
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
    const taskIntent = o.taskIntent && typeof o.taskIntent.parse === 'function' ? o.taskIntent : null;
    // TASK BRIEF v2 (additive dep): read the durable brief so the channel fallback can carry the host-validated
    // recommendation. Optional — a hub built without it renders the plain numbered choices exactly as before.
    const briefFor = typeof o.briefFor === 'function' ? o.briefFor : null;
    const newId = typeof o.newId === 'function' ? o.newId : (() => { let n = 0; return () => channel + '-run-' + (++n); })();
    // INJECTED wall-clock — no ambient fallback (this module is pure/deterministic; the determinism gate bans a bare
    // Date.now here). The composition root passes now:()=>Date.now(); a hub built without one (unit tests) stamps a
    // run's startedAt as null. Used ONLY to age a run in the state snapshot — never for control flow, so a null
    // startedAt is harmless (the frontend's normalizeSnapshot reads a missing startedAt as 0ms-ago).
    const now = typeof o.now === 'function' ? o.now : null;
    // INJECTED delay (the SAME pattern adapter.js / discord.transport.js already use in this dir): sleep(ms) -> a
    // Promise that resolves after ms. Used ONLY by the supersede-retry backoff below. Tests pass a fake (instant +
    // records the delays); the real fallback is a setTimeout-backed sleep so the fix works even where the composition
    // root doesn't inject one. It is a wall-time WAIT, not a clock READ — the determinism gate bans Date.now/random
    // here, not setTimeout (see adapter.js:70, discord.transport.js:33 for the identical fallback).
    const sleep = typeof o.sleep === 'function' ? o.sleep : (ms => new Promise(r => setTimeout(r, ms)));
    // Supersede-retry knobs (tunable for tests; the defaults give ~0.3s+0.6s+1.2s ≈ a couple seconds of grace). When a
    // second message aborts this chat's in-flight run, the fresh run can momentarily lose the same-agent workspace
    // mutex race in the host and get a TRANSIENT "already running a task" refusal — retry exactly that class a few
    // times so the user's message is never silently dropped. See SUPERSEDE_REFUSAL_RE below for the exact class.
    const supersedeRetries = Number.isFinite(o.supersedeRetries) ? Math.max(0, o.supersedeRetries | 0) : 3;
    const supersedeBackoffMs = Number.isFinite(o.supersedeBackoffMs) ? Math.max(0, o.supersedeBackoffMs) : 300;
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
    // MEDIA INGEST (photos/videos/voice/files the user sends IN the messenger). All three are injected by the
    // composition root; any absent -> media degrades to an honest per-item note instead of a silent drop:
    //   fetchMedia(item)                   -> { ok, buffer?, error? }   (adapter.getFile — platform download)
    //   saveAttachment(agentId, name, url) -> { ok, id, name, path, mediaType, kind } (the SAME workspace
    //                                         .attachments/ store the browser COMMS composer uses)
    //   expandAttachments(messages, agentId) -> messages with refs expanded into provider content blocks (the
    //                                         SAME expandUserAttachments the interactive run host calls)
    const fetchMedia = typeof o.fetchMedia === 'function' ? o.fetchMedia : null;
    const saveAttachmentFn = typeof o.saveAttachment === 'function' ? o.saveAttachment : null;
    const expandAttachments = typeof o.expandAttachments === 'function' ? o.expandAttachments : null;
    const MAX_MEDIA_PER_MESSAGE = 10;                // a full Telegram album is 10 items; a merged album must fit
    const MAX_MEDIA_BYTES = 8 * 1024 * 1024;         // mirrors attachments.js MAX_BYTES (saveAttachment re-enforces)
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
      let ok = true, failedAt = -1;
      for (let i = 0; i < chunks.length; i++) {
        let r;
        try { r = await send(chatId, chunks[i]); } catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
        if (!r || r.ok === false) { ok = false; failedAt = i; break; }
      }
      // DURABLE OUTBOX: a reply that failed to send used to be recorded (channel.delivery ok:false) and then
      // LOST — the agent did the work and the Commander never saw the result. Queue the undelivered remainder
      // (only the chunks that did NOT go out) in the store's bounded outbox; flushOutbox redelivers it when the
      // transport is proven healthy again (next successful delivery, or the adapter's next 'up' status). Command
      // replies (/help, /agents…) are ephemeral and stay fire-and-forget — a stale command menu hours later is
      // noise, not a lost result. Guarded on pushOutbox so hubs built over older/test stores behave as before.
      if (!ok && reason !== 'command' && typeof store.pushOutbox === 'function') {
        try {
          const remainder = '⌛ delayed reply — the channel was unreachable when this was first sent:\n' + chunks.slice(failedAt).join('');
          store.pushOutbox({ channel: channel, chatId: String(chatId), text: remainder, runId: runId || '', agentId: agentId ? String(agentId) : '', reason: reason || '' });
        } catch (_) {}
      }
      const ev = { channel, chatId: String(chatId), runId: runId || '', ok, chunks: chunks.length, reason: reason || '' };
      if (agentId) ev.agentId = String(agentId);   // additive/optional — attribute the dish to the acting agent
      try { emit('channel.delivery', ev); } catch (_) {}
      if (ok) { try { const p = flushOutbox(); if (p && typeof p.catch === 'function') p.catch(function () {}); } catch (_) {} }   // a proven-healthy send is the cue to drain any backlog
      return ok;
    }

    // ---- durable-outbox flush: redeliver queued replies once the transport is healthy ----------------------
    // Triggered by (a) the adapter reporting 'up' (reconnect/restart recovery) and (b) any successful deliver
    // (covers a mid-session send failure while the poll status never dropped). One pass at a time; a failed
    // redelivery bumps the item's try-count and STOPS the pass (transport clearly still shaky) — the item is
    // dropped with an honest event only after MAX_OUTBOX_TRIES failed attempts, never silently.
    const MAX_OUTBOX_TRIES = 5;
    let flushing = false;
    async function flushOutbox() {
      if (flushing || typeof store.loadOutbox !== 'function') return;
      flushing = true;
      try {
        const items = store.loadOutbox(channel);
        for (const it of items) {
          const chunks = chunkText(it.text, maxMessageLength);
          let ok = true;
          for (const c of chunks) {
            let r;
            try { r = await send(it.chatId, c); } catch (e) { r = { ok: false }; }
            if (!r || r.ok === false) { ok = false; break; }
          }
          if (ok) {
            try { store.removeOutbox(it.id); } catch (_) {}
            const ev = { channel, chatId: String(it.chatId), runId: it.runId || '', ok: true, chunks: chunks.length, reason: 'redelivered' };
            if (it.agentId) ev.agentId = String(it.agentId);
            try { emit('channel.delivery', ev); } catch (_) {}
            continue;
          }
          let bumped = null;
          try { bumped = (typeof store.bumpOutboxTry === 'function') ? store.bumpOutboxTry(it.id) : null; } catch (_) {}
          if (bumped && bumped.tries >= MAX_OUTBOX_TRIES) {
            try { store.removeOutbox(it.id); } catch (_) {}
            try { emit('channel.delivery', { channel, chatId: String(it.chatId), runId: it.runId || '', ok: false, chunks: 0, reason: 'redelivery-gave-up' }); } catch (_) {}
            try { console.error('[' + channel + '] outbox item for chat ' + it.chatId + ' dropped after ' + MAX_OUTBOX_TRIES + ' failed redeliveries'); } catch (_) {}
          }
          break;   // transport still unhealthy — end this pass; the next healthy cue retries
        }
      } finally { flushing = false; }
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

    // Turn one inbound media list into { attachments:[ref…], notes:[line…] } — download each item, park the bytes
    // in the agent's workspace .attachments/ (same jail as browser uploads), and describe what happened HONESTLY.
    // Per-item degrade: a failed download/save becomes a note the model reads, never a silent drop and never a
    // crashed inbound. Videos/audio/documents get a note naming their saved workspace path so the agent can reach
    // the file with its tools; a photo needs no note (the model literally sees it as an image block).
    async function ingestMedia(agentId, media) {
      const refs = [], notes = [];
      const items = media.slice(0, MAX_MEDIA_PER_MESSAGE);
      if (media.length > items.length) notes.push('[' + (media.length - items.length) + ' additional file(s) in this message were not ingested — resend them separately]');
      for (const it of items) {
        const kind = String((it && it.kind) || 'file'), name = String((it && it.name) || 'file');
        if (!fetchMedia || !saveAttachmentFn) { notes.push('[the user sent a ' + kind + ' ("' + name + '") but media ingest is not wired on this channel]'); continue; }
        if (Number(it.size) > MAX_MEDIA_BYTES) { notes.push('[' + kind + ' "' + name + '" is too large to ingest (' + Math.round(Number(it.size) / (1024 * 1024)) + 'MB > 8MB) — ask the user for a smaller version]'); continue; }
        let got; try { got = await fetchMedia(Object.assign({}, it, { maxBytes: MAX_MEDIA_BYTES })); } catch (e) { got = { ok: false, error: (e && e.message) || 'download threw' }; }
        if (!got || got.ok === false || !got.buffer || !got.buffer.length) { notes.push('[could not download the ' + kind + ' "' + name + '" from ' + channel + ': ' + ((got && got.error) || 'unknown error') + ']'); continue; }
        const dataUrl = 'data:' + (String(it.mime || '') || 'application/octet-stream') + ';base64,' + Buffer.from(got.buffer).toString('base64');
        let saved; try { saved = await saveAttachmentFn(agentId, name, dataUrl); } catch (e) { saved = { ok: false, error: (e && e.message) || 'save threw' }; }
        if (!saved || saved.ok === false) { notes.push('[could not store the ' + kind + ' "' + name + '": ' + ((saved && saved.error) || 'unknown error') + ']'); continue; }
        refs.push({ id: saved.id, name: saved.name, path: saved.path, mediaType: saved.mediaType, kind: saved.kind, srcKind: kind });
        if (saved.kind !== 'image') notes.push('[' + kind + ' "' + name + '" received and saved to ' + saved.path + ' in your workspace]');
      }
      // truthful cross-reference: only claim a visible video still when BOTH the clip and its frame actually saved
      if (refs.some(r => r.srcKind === 'video') && refs.some(r => r.kind === 'image' && /preview-frame/.test(String(r.name)))) {
        notes.push('[the attached image named *-preview-frame.jpg is a still frame from the video above]');
      }
      // counter the analyze-tool reflex: models that CAN see the attached image sometimes still reach for a
      // separate vision tool (and then ask the user for an API key when it isn't configured). Say plainly that
      // the pixels are already in this message. (Live-observed 2026-07-22: gemini called image_analyze on an
      // image it could see directly.)
      if (refs.some(r => r.kind === 'image')) {
        notes.push('[the image(s) are attached inside this message — look at them directly; no vision tool or extra API key is needed]');
      }
      for (const r of refs) delete r.srcKind;   // keep the stored/history reference shape identical to browser uploads
      return { attachments: refs, notes: notes };
    }

    // ---- ALBUM (media-group) BATCHING --------------------------------------------------------------------
    // A Telegram album arrives as N SEPARATE messages sharing one media_group_id (caption usually on only one).
    // Without batching, our one-run-per-conversation rule makes each part ABORT the previous part's run — a
    // 5-photo album became 4 supersedes + a final run that saw one photo. Debounce parts per (chatId, groupId):
    // each arrival re-arms a short wait; when the album goes quiet, ONE merged message (all media + the caption)
    // takes the normal path. Deterministic: the wait rides the injected `sleep`; no clocks read.
    const ALBUM_WAIT_MS = Number.isFinite(o.albumWaitMs) ? Math.max(0, o.albumWaitMs) : 800;
    const albums = new Map();   // chatId+'|'+groupId -> { msg (merged), seq, done, resolve }

    async function onInbound(msg) {
      const gid = (msg && msg.mediaGroupId != null && String(msg.mediaGroupId))
        ? (String(msg.chatId) + '|' + String(msg.mediaGroupId)) : '';
      if (!gid) return processInbound(msg);
      let rec = albums.get(gid);
      if (!rec) {
        rec = { msg: Object.assign({}, msg, { media: Array.isArray(msg.media) ? msg.media.slice() : [] }), seq: 0, resolve: null, done: null };
        rec.done = new Promise(r => { rec.resolve = r; });
        albums.set(gid, rec);
      } else {
        if (Array.isArray(msg.media) && msg.media.length) rec.msg.media = rec.msg.media.concat(msg.media);
        if (!rec.msg.text && msg.text) rec.msg.text = msg.text;   // the caption rides on whichever part carried it
      }
      const mySeq = ++rec.seq;
      await sleep(ALBUM_WAIT_MS);
      if (albums.get(gid) !== rec || rec.seq !== mySeq) return rec.done;   // a newer part re-armed the debounce
      albums.delete(gid);
      try { await processInbound(rec.msg); }
      finally { rec.resolve(); }
    }

    async function processInbound(msg) {
      const hasMedia = !!(msg && Array.isArray(msg.media) && msg.media.length);
      if (!msg || (!msg.text && !hasMedia)) return;   // empty update; media-only messages ARE admitted
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

      // MEDIA: download + store what the user actually sent (photos/videos/voice/files) BEFORE the turn is built,
      // so the model's view of this message carries the real pixels/files instead of a blind spot it has to
      // apologize for. ingestMedia never throws by contract; the belt-and-suspenders catch degrades to a note.
      let mediaIngest = { attachments: [], notes: [] };
      if (hasMedia) {
        try { mediaIngest = await ingestMedia(agentId, msg.media); }
        catch (e) { mediaIngest = { attachments: [], notes: ['[media ingest failed: ' + ((e && e.message) || e) + ']'] }; }
      }
      const turnText = String(msg.text || '') + (mediaIngest.notes.length ? ((msg.text ? '\n' : '') + mediaIngest.notes.join('\n')) : '');

      // durable transcript: load prior turns, persist the new user turn, build the replay messages. The persisted
      // turn carries the media notes (with saved .attachments/ paths), so an agent in a LATER turn can still reach
      // the files through its workspace tools even though history replays as plain text.
      let history = [];
      try { history = store.loadHistory(agentId); } catch (_) {}
      try { store.appendTurn(agentId, 'user', turnText || '[the user sent a media message]'); } catch (_) {}
      const userTurn = { role: 'user', content: turnText };
      if (mediaIngest.attachments.length) userTurn.attachments = mediaIngest.attachments;
      let messages = history.map(m => ({ role: m.role, content: m.content })).concat([userTurn]);
      // Expand the attachment refs into provider content blocks (base64 image blocks / inlined text) through the
      // SAME expandUserAttachments seam the interactive run host uses. Absent/failed expansion falls back to the
      // note-only turn (the refs are stripped so no provider ever sees a shape it doesn't know).
      if (userTurn.attachments) {
        let expanded = null;
        if (expandAttachments) { try { expanded = await expandAttachments(messages, agentId); } catch (_) { expanded = null; } }
        if (Array.isArray(expanded)) messages = expanded;
        else delete userTurn.attachments;
      }

      const rec = store.getChatRecord ? store.getChatRecord(chatId) : null;
      const persona = sec.system || personaFor(agentId, rec);   // the agent's REAL composed prompt when configured
      const system = persona + (isTask ? TASK_SUFFIX : '');

      // B5: if this agent runs at a bound BAY, its tools are that bay room's objects (resolveStation), not the
      // default office — so a routed agent's reach is exactly what the floor granted it. null -> office default.
      const bayStation = resolveStation ? resolveStation(agentId) : null;

      // ---- run with bounded supersede-retry ------------------------------------------------------------------
      // ONE run per conversation: the prev.abort.abort() above told this chat's prior run to stop. But its host-side
      // workspace-mutex slot (index.js concurrencyGate) releases in an async finally as the aborted run unwinds — so
      // the FIRST attempt of the replacement can lose that race and get a TRANSIENT "already running a task" refusal.
      // Retry ONLY that class, up to supersedeRetries times with backoff, so the Commander's message is never
      // silently dropped. Any OTHER outcome (a real reply, a budget/config/capdenied error, an unrelated transient,
      // or a supersede by a still-newer message) exits the loop immediately.
      //
      // ONE stable inflight record spans ALL attempts (created here, deleted once after the loop). This is load-
      // bearing: it must stay in `inflight` DURING the backoff sleep so a message arriving mid-backoff still finds it
      // (prev.superseded=true above) and the parked retry bails instead of firing a stale run. E-STOP (halt.js) reads
      // the SAME record. Per attempt we swap the live AbortController + runId + startedAt so each field always
      // reflects the attempt currently executing (or last executed).
      // agentId/startedAt ride in the record so GET /api/state/snapshot can list THIS run (attributed to the acting
      // agent, aged from startedAt) — a reconnect then keeps the agent's live floor/HUD state instead of clearing it.
      // abort/superseded are what halt.js's E-STOP reads; the extra fields are additive and invisible to it.
      const myRec = { runId: '', abort: null, superseded: false, agentId: agentId, startedAt: null };
      inflight.set(chatId, myRec);
      let state = null;          // the LAST attempt's assembled state (buf/errMsg/reason/transient)
      let lastRunId = '';        // the runId actually delivered under (the last attempt's)
      let attempt = 0;
      try {
      for (;;) {
        const runId = newId();
        lastRunId = runId;
        const ac = new AbortController();
        myRec.runId = runId; myRec.abort = ac; myRec.startedAt = now ? now() : null;

        // assemble the reply by buffering agent.token deltas — the SAME reassembly harness.js does in the browser.
        // transient rides alongside errMsg so the retry gate can tell the workspace-mutex race from a hard error.
        state = { runId, buf: '', errMsg: null, reason: null, transient: false };
        const sink = (name, payload) => {
          let p; try { p = redact(payload); } catch (_) { p = payload; }
          if (name === 'agent.run.start') state.runId = p.runId || state.runId;
          else if (name === 'agent.token') state.buf += (p.delta || '');
          else if (name === 'agent.run.error') { state.errMsg = p.message || 'run error'; state.transient = !!p.transient; }
          else if (name === 'capdenied') state.errMsg = state.errMsg || ('no ' + (p.need || 'capability') + ' — ' + (p.reason || ''));
          else if (name === 'agent.run.end') { state.reason = p.reason; state.budgetScope = p.budgetScope || null; state.budgetCapUsd = (typeof p.budgetCapUsd === 'number' && isFinite(p.budgetCapUsd)) ? p.budgetCapUsd : null; }
        };

        try {
          await runOnce({
            key: usingCodex ? '' : sec.key, model: sec.model, provider, baseUrl: sec.baseUrl || sec.base_url || '', reasoningEffort, system, messages, agentId, isTask,
            emit: sink, signal: ac.signal, runId, trigger: 'event', surface: 'autonomous',
            broadcast: true,   // P1: mirror this routed run's lifecycle to the station floor over SSE — it has no browser-local stream
            station: bayStation || undefined,
            taskKey: 'channel:' + channel + ':' + chatId,
            taskSource: channel
          });
        } catch (e) {
          state.errMsg = state.errMsg || ('run failed: ' + ((e && e.message) || e));
        }

        // a newer message (or E-STOP) took over this chat — abandon this run's (now stale) partial reply, and do
        // NOT retry (the newer message owns the conversation now and is running its own replacement).
        if (myRec.superseded) return;

        // Retry ONLY the same-agent workspace-mutex race, and only while attempts remain. On the final failed
        // attempt fall through so the loop exits and the honest "still busy" reply below is delivered.
        if (isSupersedeRaceRefusal(state.transient, state.errMsg) && attempt < supersedeRetries) {
          attempt++;
          // exponential backoff (300ms, 600ms, 1200ms…) — a couple seconds of grace for the aborted run's finally
          // to release the shared workspace slot. Injected sleep so tests run instantly with a fake clock. The
          // record stays in `inflight` across this wait so a mid-backoff message can supersede us (checked next).
          await sleep(supersedeBackoffMs * Math.pow(2, attempt - 1));
          if (myRec.superseded) return;
          continue;
        }
        break;
      }
      } finally {
        // release the (single) inflight record exactly once — but only if a NEWER message hasn't already replaced it
        // (the supersede path installs its own record under this chatId; clobbering it would drop the live run).
        if (inflight.get(chatId) === myRec) inflight.delete(chatId);
      }

      // persist the assistant turn only on a real, non-error reply; build the outgoing text.
      let reply;
      if (state.errMsg) {
        // an exhausted supersede-retry gets an HONEST channel reply (never the raw internal mutex message) — the
        // user's message was NOT lost silently; they can simply resend. Any other error surfaces its own message.
        reply = isSupersedeRaceRefusal(state.transient, state.errMsg)
          ? '⚠ Still busy finishing your last message — please send that again in a moment.'
          : '⚠ ' + state.errMsg;
      } else {
        reply = state.buf || '(no reply)';
        if (taskIntent) {
          const tq = taskIntent.parse(reply);
          if (tq) {
            const pre = taskIntent.strip(reply);
            // Carry the durable brief's REAL recommendation (brief_ask path) into the channel text. Marker-path
            // questions store no recommendation, so this line simply doesn't render — never fabricated here.
            let suggested = '';
            try {
              const b = briefFor ? briefFor('channel:' + channel + ':' + chatId) : null;
              const q = b && b.status === 'clarifying' && Array.isArray(b.questions) ? b.questions[b.questions.length - 1] : null;
              if (q && !q.answer && q.text === tq.question && q.recommended) suggested = '\nsuggested: ' + q.recommended + (q.reason ? ' — ' + q.reason : '');
            } catch (_) { /* enrichment only; the question always renders */ }
            reply = (pre ? pre + '\n\n' : '') + tq.question + '\n'
              + tq.options.map((x, i) => (i + 1) + '. ' + x).join('\n')
              + suggested
              + '\nReply with a choice, or say "use your judgment."';
          }
        }
        if (reply) { try { store.appendTurn(agentId, 'assistant', reply); } catch (_) {} }
        if (state.reason && state.reason !== 'done') reply += endNote(state.reason, state);
      }
      await deliver(chatId, reply, lastRunId, state.errMsg ? 'error' : (state.reason || 'done'), agentId);
    }

    // inline-keyboard taps (consent buttons) — wired in C6; a noop under the autonomous MVP.
    function onCallback(_cb) { /* C6: route { chatId, data, callbackId } to the pending consent finisher */ }

    // adapter transport health -> channel.connect telemetry (poll up / network down / fatal token error).
    // An 'up' is also the durable-outbox recovery cue: the transport just PROVED a round-trip, so any reply
    // queued while it was down (or while the sidecar was off — the outbox survives restarts) redelivers now.
    function onStatus(s) {
      try { emit('channel.connect', { channel, state: (s && s.state) || 'down', detail: (s && s.detail) || '' }); } catch (_) {}
      if (s && s.state === 'up') { try { const p = flushOutbox(); if (p && typeof p.catch === 'function') p.catch(function () {}); } catch (_) {} }
    }

    return {
      onInbound, onCallback, onStatus,
      _internals: { agentIdFor, chunkText, endNote, deliver, inflight, handleCommand, currentBoundAgent, isSupersedeRaceRefusal, flushOutbox, MAX_OUTBOX_TRIES, TASK_SUFFIX, DEFAULT_PERSONA }
    };
  }

  return { makeChannelHub, chunkText, endNote, parseCommand, matchAgent, fmtAgentLine, isSupersedeRaceRefusal, _internals: { TASK_SUFFIX, DEFAULT_PERSONA, parseCommand, matchAgent, fmtAgentLine, isSupersedeRaceRefusal } };
});
