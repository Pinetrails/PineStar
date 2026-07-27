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
   run continues — never stalls) UNLESS this chat opted into approve/deny buttons via `/approvals on`, in which
   case it runs 'interactive' and an ungranted mutation asks on the channel and fail-closes on silence (C6);
   (4) assembles the reply by concatenating agent.token deltas (the SAME contract
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
    // A non-positive `max` makes `end === i` below, so the loop pushes '' forever without advancing. No
    // caller passes one today (adapters default to 4096), but an unbounded loop is not a thing to leave
    // one bad config away.
    max = (typeof max === 'number' && isFinite(max) && max > 0) ? Math.floor(max) : 4096;
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

  // Map a TYPED reply onto a live choice keyboard: "2" / "2." / "2)" pick by position, and an exact
  // (case-insensitive) option text picks itself. Everything else returns null and passes straight through as a
  // new instruction — a Commander who changes their mind mid-question must never have that silently re-read as
  // an answer to it. Typing and tapping therefore produce the IDENTICAL canonical option text downstream.
  function coerceChoice(options, raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    const list = Array.isArray(options) ? options : [];
    const n = /^([1-9][0-9]?)[.)]?$/.exec(s);
    if (n) { const o = list[Number(n[1]) - 1]; return o ? o.value : null; }
    const low = s.toLowerCase();
    for (const o of list) if (String(o.value).toLowerCase() === low) return o.value;
    return null;
  }

  // ---- in-messenger control commands (pure, channel-agnostic) --------------------------------------------
  // Parse a leading slash-command out of an inbound text. Returns { cmd, arg } (cmd lowercased, no slash) or
  // null when the text is NOT a command (a normal message that should start a run). Only the FIRST token is the
  // command; the remainder (trimmed) is the argument. A bare '/' or unknown token still parses so we can reply
  // with help rather than silently spending a run. Telegram-style '/cmd@botname' is tolerated (strip the @suffix).
  // ONE command table — the single source of truth for (a) what parseCommand accepts, (b) what /help prints, and
  // (c) what setMyCommands publishes into Telegram's blue "/" menu. They drifted apart the moment they were three
  // separate lists, so they are now derived from this one array: adding a command here lights it up everywhere.
  // `menu:false` keeps a command working but off the published menu (help is redundant next to Telegram's menu).
  // Names must satisfy Telegram's command grammar (lowercase a-z0-9_, 1-32) — asserted by the unit test.
  // `slash:true` marks a command the SIDECAR executes through the shared slash registry (sidecar/slash.js →
  // slash-actions.js) — the same code path the desktop palette uses, so the answer here is byte-identical to the
  // answer there instead of a second implementation that drifts. Everything else is control-plane work only this
  // hub can do (it owns the in-flight run and the transcript file).
  const COMMANDS = [
    { command: 'status', description: 'What this chat is doing right now' },
    { command: 'stop', description: 'Stop the run in progress' },
    { command: 'new', description: 'Forget this chat\'s history and start fresh' },
    { command: 'agents', description: 'List agents (→ marks the one you are talking to)' },
    { command: 'talk', description: 'Switch this chat to another agent', usage: '/talk <name>' },
    { command: 'model', description: 'Show or change the current agent\'s model', usage: '/model [id]' },
    { command: 'usage', description: 'Real spend from the station ledger', slash: true },
    { command: 'tools', description: 'The tools this agent can actually call', slash: true },
    { command: 'routine', description: 'List, create or pause scheduled routines', usage: '/routine [list|add <schedule> | <task>|pause N|rm N]', slash: true },
    { command: 'away', description: 'Queue work to build on the away shift', usage: '/away [<what to build>|list|on|off]', slash: true },
    { command: 'approvals', description: 'Approve/deny buttons for this chat (on or off)', usage: '/approvals [on|off]' },
    { command: 'whoami', description: 'Show which agent this chat is talking to' },
    { command: 'help', description: 'List these commands', menu: false }
  ];
  const SLASH_CMDS = COMMANDS.reduce((m, c) => { if (c.slash) m[c.command] = 1; return m; }, {});
  const KNOWN_CMDS = COMMANDS.reduce((m, c) => { m[c.command] = 1; return m; }, {});
  // the setMyCommands payload (name + one-line description only — Telegram renders no usage strings).
  function menuCommands() {
    return COMMANDS.filter(c => c.menu !== false).map(c => ({ command: c.command, description: c.description }));
  }
  // the /help body, rendered from the SAME table so it can never claim a command the parser doesn't accept.
  function helpText() {
    return 'Commands:\n' + COMMANDS.map(c => (c.usage || '/' + c.command) + ' — ' + c.description).join('\n');
  }
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
    const groundedFor = typeof o.groundedFor === 'function' ? o.groundedFor : null;
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
    // AGENTIC GRAPHS: the dock resolveAgent picked is stage ONE; the belts drawn PAST it say where its output
    // goes. `chain` is the injected executor (sidecar/routing/chain.js) already bound to the floor's edge
    // function — the hub hands it a way to run one hop and stays require-free. Absent -> a single-stage run,
    // byte-identical to the behaviour before work lines existed.
    const chain = (o.chain && typeof o.chain.advance === 'function') ? o.chain : null;
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
    // runSlash(input, ctx) -> { ok, text } — executes a slash command through the SHARED registry the desktop
    // palette uses, in-process (no self-HTTP, no api token). Injected so this module stays testable and so a
    // wire-up that has no slash layer simply reports the command as unavailable rather than crashing.
    const runSlashFn = typeof o.runSlash === 'function' ? o.runSlash : null;
    // names of the Commander's own commands, so this hub can recognise one without owning the list
    const userCommandNames = typeof o.userCommandNames === 'function' ? o.userCommandNames : (() => []);
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
    // TYPING INDICATOR (Hermes parity): chatAction(chatId) fires ONE platform "typing…" action (adapter.chatAction
    // -> Telegram sendChatAction). Optional — absent means the channel simply shows no typing bubble, exactly the
    // old behavior. Telegram's bubble expires ~5s after each action, so the keep-alive loop below refreshes every
    // typingRefreshMs (default 4s: safely inside the 5s window at half the API traffic of the reference's 2s).
    const chatAction = typeof o.chatAction === 'function' ? o.chatAction : null;
    const typingRefreshMs = Number.isFinite(o.typingRefreshMs) ? Math.max(250, o.typingRefreshMs) : 4000;
    // ---- INLINE KEYBOARDS (C6) ---------------------------------------------------------------------------
    // All four are optional and travel together: a hub missing ANY of them renders questions as the numbered
    // text list it always did and never offers approve/deny buttons. That is what keeps every other channel
    // (Discord/Slack/Matrix/Signal) byte-identical while Telegram gains buttons.
    //   prompts        -> the bounded token→meaning registry (channels/prompts.js); the callback_data codec
    //   answerCallback(callbackId, text)            -> ack a tap (kills Telegram's button spinner)
    //   editMessage(chatId, messageId, text, opts)  -> stamp the decision + strip the spent keyboard
    //   askConsent({ agentId, runId, signal, call, tool, onPrompt }) -> Promise<decision>
    //     The HOST owns the pause/resolve (it registers the prompt in the same pendingByRun map the browser's
    //     POST /api/consent answers, so a Telegram prompt is ALSO answerable from the app). The hub owns only
    //     the display and the button→decision hop. onPrompt(promptId, fields) fires synchronously at register
    //     time — that is the hub's cue to render the keyboard.
    //   resolveConsent(runId, promptId, decision)   -> bool (the host's finisher lookup)
    const prompts = o.prompts && typeof o.prompts.create === 'function' ? o.prompts : null;
    const answerCallback = typeof o.answerCallback === 'function' ? o.answerCallback : null;
    const editMessage = typeof o.editMessage === 'function' ? o.editMessage : null;
    const askConsent = typeof o.askConsent === 'function' ? o.askConsent : null;
    const resolveConsent = typeof o.resolveConsent === 'function' ? o.resolveConsent : null;
    const buttonsOk = !!(prompts && answerCallback);   // the minimum to render a tappable keyboard at all
    // Telegram truncates long inline-button labels on narrow phones, so the FULL option text always stays in the
    // message body and the button carries a short, numbered echo of it (reference-harness lesson). 30 chars fits
    // comfortably on a small screen; the leading "N." ties every button to its line in the body list.
    const BTN_LABEL_MAX = 30;
    function btnLabel(n, text) {
      const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
      const head = n + '. ';
      return s.length + head.length <= BTN_LABEL_MAX ? head + s : head + s.slice(0, Math.max(1, BTN_LABEL_MAX - head.length - 1)) + '…';
    }
    // Build the Bot API reply_markup for a registered prompt: one button per row (a vertical list stays readable
    // on a phone, and option text is far too long for side-by-side buttons).
    function keyboardFor(entry) {
      return { inline_keyboard: entry.options.map((opt, i) => [{ text: opt.label, callback_data: prompts.data(entry.token, i) }]) };
    }

    // Render ONE live permission ask as an inline keyboard. The four decisions are exactly the broker's own
    // vocabulary (once/session/always/deny) so a tap here means precisely what the same word means on the
    // browser's consent card — this is a second display of one mechanism, not a parallel one.
    //
    // FIRE-AND-FORGET BY CONTRACT: the host calls onPrompt synchronously while registering the prompt, and its
    // fail-closed deny timer is ALREADY running. So this must never throw back into that path and never be
    // awaited by it. If the keyboard fails to send, the prompt simply goes unanswered and the host denies it on
    // schedule — the safe direction, and the same outcome as a Commander who never looks at their phone.
    function sendConsentPrompt(chatId, runId, promptId, fields) {
      (async () => {
        const f = fields || {};
        const entry = prompts.create({
          kind: 'consent',
          chatId: chatId,
          options: [
            { label: '✅ Allow once', value: 'once' },
            { label: '✅ Allow for this session', value: 'session' },
            { label: '♾️ Always allow', value: 'always' },
            { label: '❌ Deny', value: 'deny' }
          ],
          meta: { runId: runId, promptId: promptId }
        });
        if (!entry) return;
        const args = String(f.argsSummary || '').trim();
        const body = '🔐 Permission needed\n\n' + String(f.tool || 'a tool')
          + (f.scope ? '  (' + f.scope + ')' : '')
          + (args ? '\n' + args.slice(0, 600) : '')
          + '\n\nIf you don\'t answer, this is denied and the run moves on.';
        entry.meta.text = body;
        const r = await deliver(chatId, body, runId, 'prompt', '', { reply_markup: keyboardFor(entry) });
        // Only a message that actually LANDED can be edited when tapped.
        if (r && r.ok) { if (r.messageId) prompts.attach(entry.token, r.messageId); return; }
        // THE KEYBOARD NEVER LANDED. Retire the token, then DENY IMMEDIATELY instead of letting the host's
        // fail-closed timer run its full course. The Commander was never actually asked, so making them wait out
        // CONSENT_TIMEOUT_MS for the answer that is already certain would turn an undeliverable prompt into a
        // two-minute stall — strictly worse than the autonomous floor this chat opted IN from. Same decision,
        // no wait. (No apology message here: the send path is the thing that just failed.)
        prompts.take(entry.token);
        try { if (resolveConsent) resolveConsent(runId, promptId, 'deny'); } catch (_) {}
      })().catch(function () {});
    }
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

    // ---- typing keep-alive: refresh the platform's "typing…" bubble while a run is in flight ---------------
    // Returns a stop() closure. The loop is detached (fire-and-forget) and PURELY cosmetic: any failure degrades
    // to no bubble, never touches the reply path. Backoff mirrors send(): a 429's retry_after (capped 30s) is
    // waited out; a non-retryable failure (bad chat, unsupported channel) stops the loop for this run entirely —
    // one probe, no hammering. There is no "stop typing" API on any platform: stopping just means ceasing
    // refreshes and letting the client-side ~5s timer expire, which is why stop() runs BEFORE deliver() — the
    // final reply must never race a fresh 5s bubble that would linger after the answer (reference-harness lesson).
    function startTyping(chatId) {
      if (!chatAction) return function () {};
      let stopped = false;
      (async () => {
        while (!stopped) {
          let r;
          try { r = await chatAction(chatId); } catch (e) { r = { ok: false, retryable: true }; }
          if (stopped) break;
          if (r && r.ok === false && !r.retryable) break;
          const waitMs = (r && r.ok === false && Number(r.retryAfter) > 0)
            ? Math.min(Number(r.retryAfter) * 1000, 30000)
            : typingRefreshMs;
          await sleep(waitMs);
        }
      })().catch(function () {});
      return function () { stopped = true; };
    }

    // agentId (optional, last arg) names WHICH roster agent produced this reply, so the floor can pulse the RIGHT
    // agent's dish on a multi-agent station. Passed only for a real RUN reply (onInbound); administrative command
    // replies (/agents, /model…) omit it — no agent "produced" them, so the floor should not attribute a dish.
    // sendOpts (optional) rides ONLY on the FINAL chunk — a keyboard must land under the last thing the user
    // reads, and Telegram would otherwise render one set of buttons per chunk of a long reply. Returns the final
    // chunk's messageId too, which is what a keyboard needs in order to be edited/stripped once it is tapped.
    async function deliver(chatId, text, runId, reason, agentId, sendOpts) {
      const chunks = chunkText(text, maxMessageLength);
      let ok = true, failedAt = -1, messageId = '';
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        let r;
        try { r = await send(chatId, chunks[i], (last && sendOpts) ? sendOpts : undefined); } catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
        if (!r || r.ok === false) { ok = false; failedAt = i; break; }
        if (last && r.messageId) messageId = String(r.messageId);
      }
      // DURABLE OUTBOX: a reply that failed to send used to be recorded (channel.delivery ok:false) and then
      // LOST — the agent did the work and the Commander never saw the result. Queue the undelivered remainder
      // (only the chunks that did NOT go out) in the store's bounded outbox; flushOutbox redelivers it when the
      // transport is proven healthy again (next successful delivery, or the adapter's next 'up' status). Command
      // replies (/help, /agents…) are ephemeral and stay fire-and-forget — a stale command menu hours later is
      // noise, not a lost result. Guarded on pushOutbox so hubs built over older/test stores behave as before.
      // 'prompt' joins 'command' as ephemeral: a permission ask whose keyboard failed to send is answered by the
      // host's fail-closed timer within seconds — redelivering that dead question hours later would invite a tap
      // on a run that ended long ago.
      if (!ok && reason !== 'command' && reason !== 'prompt' && typeof store.pushOutbox === 'function') {
        try {
          const remainder = '⌛ delayed reply — the channel was unreachable when this was first sent:\n' + chunks.slice(failedAt).join('');
          store.pushOutbox({ channel: channel, chatId: String(chatId), text: remainder, runId: runId || '', agentId: agentId ? String(agentId) : '', reason: reason || '' });
        } catch (_) {}
      }
      const ev = { channel, chatId: String(chatId), runId: runId || '', ok, chunks: chunks.length, reason: reason || '' };
      if (agentId) ev.agentId = String(agentId);   // additive/optional — attribute the dish to the acting agent
      try { emit('channel.delivery', ev); } catch (_) {}
      if (ok) { try { const p = flushOutbox(); if (p && typeof p.catch === 'function') p.catch(function () {}); } catch (_) {} }   // a proven-healthy send is the cue to drain any backlog
      // `text` is the FINAL chunk's text — the one a keyboard was attached to, and therefore the exact string a
      // later editMessage must rebuild on top of when it stamps the chosen answer in place.
      return { ok: ok, messageId: messageId, text: chunks.length ? chunks[chunks.length - 1] : '' };
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
    // boundRec is this chat's persisted record (or null) — /approvals reads its opt-in flag and writes it back.
    async function handleCommand(chatId, parsed, boundAgentId, sec, boundRec) {
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
        await deliver(chatId, helpText(), '', 'command');
        return;
      }

      // ---- SHARED SLASH COMMANDS (/usage /tools /routine /away) ----------------------------------------
      // Executed by the sidecar's own registry, so what you read on your phone is what you'd read on the
      // desktop — the same text from the same code, not a second implementation that drifts. A card-shaped
      // reply (title + lines) is flattened to plain text: Telegram has no card.
      if (SLASH_CMDS[cmd]) {
        if (!runSlashFn) { await deliver(chatId, '⚠ ' + '/' + cmd + ' is not available on this channel.', '', 'command'); return; }
        let r;
        try { r = await runSlashFn('/' + cmd + (arg ? ' ' + arg : ''), { agentId: boundId }); }
        catch (e) { try { console.error('[' + channel + '] /' + cmd + ' threw:', (e && e.message) || e); } catch (_) {} r = null; }
        if (!r) { await deliver(chatId, '⚠ Could not run /' + cmd + ' right now — try again in a moment.', '', 'command'); return; }
        const body = (r.lines && r.lines.length)
          ? ((r.title ? r.title + '\n' : '') + r.lines.join('\n'))
          : String(r.text || '');
        await deliver(chatId, body || ('/' + cmd + ' had nothing to report.'), '', 'command');
        return;
      }

      // ---- /stop — abort the run this CHAT has in flight -------------------------------------------------
      // Only this hub can do it: it owns the inflight record (chatId -> { runId, abort, ... }). Marked
      // superseded first so the run's own teardown stays quiet rather than reporting a failure you caused.
      if (cmd === 'stop') {
        const live = inflight.get(chatId);
        if (!live) { await deliver(chatId, 'Nothing is running for this chat right now.', '', 'command'); return; }
        live.superseded = true;
        let aborted = false;
        try { live.abort.abort(); aborted = true; } catch (_) { aborted = false; }
        await deliver(chatId, aborted ? 'Stopped the run in progress.' : '⚠ Could not stop that run — it may already be finishing.', '', 'command');
        return;
      }

      // ---- /new — forget this chat's transcript ----------------------------------------------------------
      // A browser chat can start over because its history lives in localStorage. A messaging chat has no
      // browser: the store file IS the conversation, so this is the only way to start fresh. It refuses while
      // a run is in flight — clearing the history under a live run would strand it mid-conversation.
      if (cmd === 'new') {
        if (inflight.get(chatId)) { await deliver(chatId, 'A run is still going — send /stop first, then /new.', '', 'command'); return; }
        if (!store || typeof store.clearHistory !== 'function') { await deliver(chatId, '⚠ Clearing history is not available on this channel.', '', 'command'); return; }
        let dropped = 0;
        try { dropped = store.clearHistory(boundId); }
        catch (e) { await deliver(chatId, '⚠ Could not clear this chat: ' + ((e && e.message) || 'the write failed') + '.', '', 'command'); return; }
        await deliver(chatId, dropped
          ? ('Cleared ' + dropped + ' message' + (dropped === 1 ? '' : 's') + ' — this chat starts fresh. I no longer remember what we discussed.')
          : 'Nothing to clear — this chat had no history yet.', '', 'command');
        return;
      }

      // ---- /status — what is this chat doing RIGHT NOW ---------------------------------------------------
      // Reads only live in-memory state + the stored transcript, so it can never claim a run that isn't there.
      if (cmd === 'status') {
        const live = inflight.get(chatId);
        const bits = [];
        if (live) {
          // only quote a duration when BOTH a clock and a start stamp exist — a hub built without a clock
          // (unit wire-ups) must say it is working, never invent an elapsed time.
          const t = now ? now() : 0;
          bits.push((t && live.startedAt)
            ? ('Working — ' + Math.max(0, Math.round((t - live.startedAt) / 1000)) + 's so far.')
            : 'Working on something right now.');
        } else bits.push('Idle — nothing running.');
        const me = (roster || []).find(x => String(x.agentId) === String(boundId));
        bits.push('Agent: ' + (me ? (me.name || me.agentId) : boundId) + (me && me.model ? ' (' + me.model + ')' : ''));
        let turns = 0;
        try { turns = (store && typeof store.loadHistory === 'function') ? store.loadHistory(boundId).length : 0; } catch (_) { turns = 0; }
        bits.push('History: ' + turns + ' message' + (turns === 1 ? '' : 's') + ' remembered.');
        bits.push('Approve/deny buttons: ' + ((boundRec && boundRec.approvals) ? 'ON' : 'OFF') + '.');
        await deliver(chatId, bits.join('\n'), '', 'command');
        return;
      }

      // /approvals [on|off] — the per-chat opt-in for approve/deny buttons. DEFAULT OFF: with it off this chat
      // runs surface:'autonomous' exactly as before (an ungranted write default-denies and the run continues,
      // never stalling). Turning it ON switches the chat to surface:'interactive', so an ungranted write pauses
      // and asks you here — which also means an UNANSWERED prompt holds that run until the host's fail-closed
      // consent timeout denies it. Both halves of that trade are stated to the user, never just the upside.
      if (cmd === 'approvals') {
        const canPrompt = buttonsOk && !!askConsent && !!resolveConsent;
        const on = !!(boundRec && boundRec.approvals);
        if (!arg) {
          await deliver(chatId, canPrompt
            ? ('Approve/deny buttons are ' + (on ? 'ON' : 'OFF') + ' for this chat.\n'
               + (on ? 'When I need permission to write a file or run a tool, I\'ll ask you here with buttons.\nSend /approvals off to go back to silently skipping those actions.'
                     : 'Right now I silently skip any action that needs permission and carry on.\nSend /approvals on to be asked here instead.'))
            : '⚠ Approve/deny buttons are not available on this channel.', '', 'command');
          return;
        }
        const want = /^(on|yes|enable|enabled|true|1)$/i.test(arg) ? true : (/^(off|no|disable|disabled|false|0)$/i.test(arg) ? false : null);
        if (want === null) { await deliver(chatId, 'Usage: /approvals on  ·  /approvals off', '', 'command'); return; }
        if (want && !canPrompt) { await deliver(chatId, '⚠ Approve/deny buttons are not available on this channel — leaving them off.', '', 'command'); return; }
        // truthful telemetry: only claim the setting changed once the durable write actually returned.
        let saved = false;
        try { if (typeof store.saveChatRecord === 'function') { store.saveChatRecord(chatId, { approvals: want }); saved = true; } } catch (_) { saved = false; }
        if (!saved) { await deliver(chatId, '⚠ Could not save that — approve/deny buttons are still ' + (on ? 'ON' : 'OFF') + ' for this chat.', '', 'command'); return; }
        await deliver(chatId, want
          ? 'Approve/deny buttons are ON. I\'ll ask here before any action that needs permission — if you don\'t answer, that action is denied and the run moves on.'
          : 'Approve/deny buttons are OFF. I\'ll silently skip actions that need permission and carry on.', '', 'command');
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
      // Per-chat opt-in for approve/deny buttons (/approvals; default OFF). Requires BOTH the user's opt-in AND a
      // channel that can actually render and resolve a keyboard — a chat that opted in but is now running over a
      // transport without buttons must fall back to the safe autonomous floor, never stall on a prompt that
      // physically cannot be answered.
      const wantApprovals = !!(boundRec && boundRec.approvals) && buttonsOk && !!askConsent && !!resolveConsent;

      // Control commands are intercepted BEFORE any run starts — they must never spawn an LLM run. Replies go out
      // through the SAME deliver() path so chunking/limits apply. Channel-agnostic: this lives in the hub, so
      // Telegram/Discord/any future adapter get identical behavior.
      const parsed = parseCommand(msg.text);
      if (parsed) { await handleCommand(chatId, parsed, boundAgentId, sec, boundRec); return; }

      // COMMANDER-DEFINED commands are not in this hub's table (the sidecar owns them), so a "/standup" would
      // otherwise fall through and be answered by the MODEL — spending a turn to say it doesn't understand.
      // Match only against the names the sidecar actually reports, so an ordinary message that happens to start
      // with a slash (a path, say) still reaches the agent untouched. The registry itself decides what a given
      // command may do here: an alias resolves and runs, a shell exec is refused off-desktop.
      const userNamed = /^\/([A-Za-z0-9_-]+)/.exec(String(msg.text || ''));
      if (userNamed && runSlashFn && userCommandNames().indexOf(userNamed[1].toLowerCase()) !== -1) {
        // resolve the agent the SAME way handleCommand does, so a user command is scoped to whoever this chat
        // is actually talking to rather than a default
        const ucAgent = currentBoundAgent(chatId, boundAgentId, sec);
        let r;
        try { r = await runSlashFn(String(msg.text).trim(), { agentId: ucAgent }); }
        catch (e) { try { console.error('[' + channel + '] user command threw:', (e && e.message) || e); } catch (_) {} r = null; }
        const body = (r && Array.isArray(r.lines) && r.lines.length)
          ? ((r.title ? r.title + '\n' : '') + r.lines.join('\n'))
          : String((r && r.text) || '');
        await deliver(chatId, body || ('/' + userNamed[1] + ' had nothing to report.'), '', 'command');
        return;
      }

      // ---- a TYPED answer to a live choice keyboard ---------------------------------------------------------
      // Resolve it to the canonical option text BEFORE anything reads msg.text (routing, the classifier and the
      // stored turn all must see the real answer, not a bare "2"). Then retire this chat's keyboards either way:
      // if that was the answer it is spent, and if it was NOT, the conversation has moved past the question and
      // a late tap must not reopen it. The buttons stay visible but now answer honestly that they're closed.
      if (prompts) {
        const live = prompts.peekChat(chatId, 'choice');
        if (live) {
          const picked = coerceChoice(live.options, msg.text);
          if (picked) msg = Object.assign({}, msg, { text: picked });
        }
        prompts.dropChat(chatId, 'choice');
      }

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

      // TYPING: from here on a real run WILL happen — light the platform's "typing…" bubble now (it also covers
      // media download/ingest, which can take seconds) and keep refreshing until the reply is built. Stopped in
      // the finally BEFORE deliver() so the bubble can expire rather than linger past the answer. The wrapper
      // try/finally does not re-indent the body (matches this file's existing low-indent try style below).
      const stopTyping = startTyping(chatId);
      // hoisted OUT of the typing try-block: deliver() below the finally reads all three.
      let state = null;          // the LAST attempt's assembled state (buf/errMsg/reason/transient)
      let lastRunId = '';        // the runId actually delivered under (the last attempt's)
      let reply;
      let choiceEntry = null;    // the registered choice keyboard for a TASK_QUESTION reply (null = plain text)
      let finalAgentId = agentId;   // WHO produced the delivered reply — the LAST stage of the work line, not the first
      try {

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

        // CONSENT SURFACE (per-chat, default OFF — see /approvals). With it off nothing changes: the run stays
        // 'autonomous' and the broker default-denies an ungranted mutation without ever stalling. With it ON the
        // run becomes 'interactive' and `prompt` is the live channel the broker pauses on — the host owns that
        // pause/resolve (askConsent registers it in the SAME pendingByRun the browser answers), while the hub
        // only renders the keyboard and routes the tap back. Built per ATTEMPT so it closes over this attempt's
        // runId + AbortController; a superseded attempt's prompts die with its signal.
        const consentPrompt = wantApprovals ? function (call, tool) {
          return askConsent({
            agentId: agentId, runId: runId, signal: ac.signal, call: call, tool: tool,
            onPrompt: function (promptId, fields) { sendConsentPrompt(chatId, runId, promptId, fields); }
          });
        } : undefined;

        try {
          await runOnce({
            key: usingCodex ? '' : sec.key, model: sec.model, provider, baseUrl: sec.baseUrl || sec.base_url || '', reasoningEffort, system, messages, agentId, isTask,
            emit: sink, signal: ac.signal, runId, trigger: 'event',
            surface: wantApprovals ? 'interactive' : 'autonomous',
            prompt: consentPrompt,
            broadcast: true,   // P1: mirror this routed run's lifecycle to the station floor over SSE — it has no browser-local stream
            // A channel task is real work the agent should learn from, exactly like a COMMS task. Admission is
            // already owner-gated upstream (adapter.js ownerOk: a non-owner DM never reaches this host, a group
            // must be whitelisted), and each record is stamped with its origin (channel:<name>) so the Commander
            // can see in Memory Core which surface formed a belief.
            reflect: true,
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

      /* ---- THE WORK LINE: run every stage the Commander drew downstream of this dock -------------------
         resolveAgent picked WHICH dock; the belts past it say what happens to its output. Deliberately INSIDE
         the inflight try: myRec stays registered for the whole line, so E-STOP (halt.js reads this record) and
         a superseding message reach the downstream stages too — a chain that outlived its own abort handle
         would be an unstoppable spend. The reply that finally leaves is the LAST stage's. */
      if (chain && !state.errMsg && !myRec.superseded && String(state.buf || '').trim()) {
        const line = await chain.advance({
          agentId: agentId, text: state.buf, originalText: msg.text,
          signal: myRec.abort ? myRec.abort.signal : null,
          runAgent: async function (h) {
            // a hop is a plain autonomous run of ANOTHER agent: its OWN composed persona (never this channel's
            // configured system prompt — that belongs to the agent the connection names), its OWN bay station,
            // its OWN durable transcript. No consent keyboard: a downstream stage is machine-to-machine.
            const hopRunId = newId();
            myRec.runId = hopRunId; myRec.agentId = h.agentId; myRec.startedAt = now ? now() : null;
            const hs = { buf: '', errMsg: null, usd: 0 };
            const hopSink = (name, payload) => {
              let p; try { p = redact(payload); } catch (_) { p = payload; }
              if (name === 'agent.token') hs.buf += (p.delta || '');
              else if (name === 'agent.run.error') hs.errMsg = p.message || 'run error';
              else if (name === 'capdenied') hs.errMsg = hs.errMsg || ('no ' + (p.need || 'capability') + ' — ' + (p.reason || ''));
              else if (name === 'agent.run.end') { if (typeof p.usd === 'number' && isFinite(p.usd)) hs.usd = p.usd; }
            };
            let hist = [];
            try { hist = store.loadHistory(h.agentId); } catch (_) {}
            try { store.appendTurn(h.agentId, 'user', h.text); } catch (_) {}
            try {
              await runOnce({
                key: usingCodex ? '' : sec.key, model: sec.model, provider, baseUrl: sec.baseUrl || sec.base_url || '', reasoningEffort,
                system: personaFor(h.agentId, rec), messages: hist.map(m => ({ role: m.role, content: m.content })).concat([{ role: 'user', content: h.text }]),
                agentId: h.agentId, isTask: true, emit: hopSink, signal: h.signal, runId: hopRunId, trigger: 'event',
                surface: 'autonomous', broadcast: true, reflect: true,
                station: (resolveStation ? resolveStation(h.agentId) : null) || undefined,
                taskKey: 'chain:' + channel + ':' + chatId + ':' + h.agentId, taskSource: channel
              });
            } catch (e) { hs.errMsg = hs.errMsg || ('run failed: ' + ((e && e.message) || e)); }
            if (hs.buf.trim() && !hs.errMsg) { try { store.appendTurn(h.agentId, 'assistant', hs.buf); } catch (_) {} }
            return { text: hs.buf, usd: hs.usd, error: hs.errMsg };
          }
        });
        if (!myRec.superseded && line.hops.length) {
          // the line's answer replaces the first stage's — and the floor/channel agree on who produced it
          state.buf = line.text + chain.stopNote(line);
          finalAgentId = line.agentId;
        } else if (!myRec.superseded && line.stopped && line.stopped !== 'stopped') {
          state.buf = state.buf + chain.stopNote(line);   // stage one answered but the line never got going — say so
        }
      }
      if (myRec.superseded) return;
      } finally {
        // release the (single) inflight record exactly once — but only if a NEWER message hasn't already replaced it
        // (the supersede path installs its own record under this chatId; clobbering it would drop the live run).
        if (inflight.get(chatId) === myRec) inflight.delete(chatId);
      }

      // persist the assistant turn only on a real, non-error reply; build the outgoing text.
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
            // A GROUNDED suggestion (the Commander's own answered history, with a count) is provable, so it
            // outranks the model's guess here exactly as it does in COMMS — the surfaces must not disagree.
            let suggested = '';
            try {
              const b = briefFor ? briefFor('channel:' + channel + ':' + chatId) : null;
              const q = b && b.status === 'clarifying' && Array.isArray(b.questions) ? b.questions[b.questions.length - 1] : null;
              if (q && !q.answer && q.text === tq.question) {
                const g = groundedFor ? groundedFor(q) : null;
                if (g && g.option) suggested = '\nsuggested: ' + g.option + ' — you chose this ' + g.count + ' times before';
                else if (q.recommended) suggested = '\nsuggested: ' + q.recommended + (q.reason ? ' — ' + q.reason : '');
              }
            } catch (_) { /* enrichment only; the question always renders */ }
            // Register the tappable version FIRST — if the registry refuses (bounded/duplicate token), we simply
            // fall through to the numbered text below, which is a complete answer path on its own.
            if (buttonsOk) {
              choiceEntry = prompts.create({
                kind: 'choice', chatId: chatId, chatType: msg.chatType,
                // label = short numbered echo (Telegram truncates long labels on a phone); value/display = the
                // FULL option text, which is what re-enters the conversation when tapped.
                options: tq.options.map((x, i) => ({ label: btnLabel(i + 1, x), value: String(x), display: String(x) })),
                meta: { question: tq.question }
              });
            }
            // The numbered list stays in the body even when buttons render: it is what makes a long option
            // readable (the button label had to be truncated), and it is the whole answer path on a channel
            // without keyboards. The closing line only promises typing when that is the ONLY way to answer.
            reply = (pre ? pre + '\n\n' : '') + tq.question + '\n'
              + tq.options.map((x, i) => (i + 1) + '. ' + x).join('\n')
              + suggested
              + (choiceEntry ? '\nTap a choice below — or reply in your own words.'
                             : '\nReply with a choice, or say "use your judgment."');
          }
        }
        if (reply) { try { store.appendTurn(agentId, 'assistant', reply); } catch (_) {} }
        if (state.reason && state.reason !== 'done') reply += endNote(state.reason, state);
      }

      } finally { stopTyping(); }   // cease refreshes BEFORE deliver — the bubble must die with the reply, not after
      const dr = await deliver(chatId, reply, lastRunId, state.errMsg ? 'error' : (state.reason || 'done'), finalAgentId,
        choiceEntry ? { reply_markup: keyboardFor(choiceEntry) } : undefined);
      // Stitch the delivered message onto the keyboard's registry entry so a tap can edit THAT message in place.
      // A send that failed retires the token immediately: leaving it would let a phantom keyboard (buttons the
      // user can see from a partially-sent reply) resolve against a question they never fully received.
      if (choiceEntry) {
        if (dr && dr.ok && dr.messageId) { prompts.attach(choiceEntry.token, dr.messageId); choiceEntry.meta.text = dr.text || reply; }
        else if (!dr || !dr.ok) prompts.take(choiceEntry.token);
      }
    }

    // ---- inline-keyboard taps (C6) -------------------------------------------------------------------------
    // One tap = { chatId, userId, data, callbackId, messageId }. The adapter has ALREADY owner-gated this (a
    // non-owner's tap never reaches here), so this is the display/decision hop only. Order matters and mirrors
    // the reference harness: resolve the token (single-use) → ACK the tap → stamp the message → act.
    //
    // The ack is not optional politeness: until answerCallbackQuery lands, Telegram spins a loader on the button
    // and eventually shows the user a client-side error, so an unacked tap reads as a broken bot even when the
    // decision was recorded perfectly. It therefore happens BEFORE the (slower, failure-prone) edit and action.
    async function onCallback(cb) {
      if (!cb || !prompts || !answerCallback) return;
      const chatId = String(cb.chatId == null ? '' : cb.chatId);
      const ack = async (text) => { try { await answerCallback(cb.callbackId, text); } catch (_) {} };

      const hit = prompts.parse(cb.data);
      if (!hit) { await ack(); return; }   // a stale keyboard from an older build — ack so the spinner stops

      // SINGLE-USE. A double-tap, a tap on a question the conversation already moved past, and a tap that lost
      // the race with a typed answer all land here. Say so plainly rather than silently doing nothing — and
      // never re-run a decision. The chatId re-check makes a token from one chat unusable in another.
      const entry = prompts.take(hit.token);
      if (!entry || entry.chatId !== chatId) { await ack('That question is no longer open.'); return; }
      const opt = entry.options[hit.idx];
      if (!opt) { await ack('That option is no longer available.'); return; }

      // Only add the tick when the label doesn't already open with its own marker — a consent button reads
      // "✅ Allow for this session", and prefixing that produced a doubled "✓ ✅" in the live toast.
      const shown = String(opt.display || opt.label).trim().slice(0, 60);
      await ack((/^[\p{L}\p{N}]/u.test(shown) ? '✓ ' : '') + shown);

      // Stamp the decision into the original message and strip the spent buttons. Cosmetic ONLY: the decision
      // below is recorded whether or not this edit lands (Telegram 400s a no-op edit, and the message may have
      // been deleted by the user), which is why it is fired inside its own guard and its result is not read.
      if (editMessage && entry.messageId) {
        try { await editMessage(chatId, entry.messageId, String(entry.meta.text || '') + '\n\n▸ ' + String(opt.display || opt.value), {}); } catch (_) {}
      }

      if (entry.kind === 'consent') {
        let done = false;
        try { done = !!resolveConsent(entry.meta.runId, entry.meta.promptId, opt.value); } catch (_) { done = false; }
        // The host had already settled it — the fail-closed timer fired, the run was superseded, or E-STOP hit.
        // Telling the user their tap landed would be a lie about what the harness actually did.
        if (!done) { try { await deliver(chatId, '⚠ That permission request had already expired — the action was denied and the run moved on.', entry.meta.runId || '', 'prompt'); } catch (_) {} }
        return;
      }

      // A CHOICE tap re-enters the NORMAL inbound path carrying the option's own text — byte-identical to the
      // Commander having typed that option. So history, agent routing, Task Brief continuity and the run itself
      // are all exactly the typed-answer path; there is no second, divergent "button answer" code path to keep
      // in sync. (processInbound is fire-and-forget from the adapter's perspective; a throw here must not escape
      // into the poll loop, hence the guard.)
      try {
        await processInbound({
          channel: channel, chatId: chatId, chatType: entry.chatType,
          userId: cb.userId == null ? '' : String(cb.userId), userName: '',
          text: opt.value, messageId: '', ts: now ? now() : 0
        });
      } catch (e) {
        try { console.error('[' + channel + '] choice tap failed for chat ' + chatId + ':', (e && e.message) || e); } catch (_) {}
      }
    }

    // adapter transport health -> channel.connect telemetry (poll up / network down / fatal token error).
    // An 'up' is also the durable-outbox recovery cue: the transport just PROVED a round-trip, so any reply
    // queued while it was down (or while the sidecar was off — the outbox survives restarts) redelivers now.
    function onStatus(s) {
      try { emit('channel.connect', { channel, state: (s && s.state) || 'down', detail: (s && s.detail) || '' }); } catch (_) {}
      if (s && s.state === 'up') { try { const p = flushOutbox(); if (p && typeof p.catch === 'function') p.catch(function () {}); } catch (_) {} }
    }

    return {
      onInbound, onCallback, onStatus,
      _internals: { agentIdFor, chunkText, endNote, deliver, inflight, handleCommand, currentBoundAgent, isSupersedeRaceRefusal, flushOutbox, MAX_OUTBOX_TRIES, TASK_SUFFIX, DEFAULT_PERSONA, keyboardFor, btnLabel, sendConsentPrompt, buttonsOk }
    };
  }

  return { makeChannelHub, chunkText, endNote, parseCommand, matchAgent, fmtAgentLine, isSupersedeRaceRefusal, coerceChoice, menuCommands, helpText, COMMANDS, _internals: { TASK_SUFFIX, DEFAULT_PERSONA, parseCommand, matchAgent, fmtAgentLine, isSupersedeRaceRefusal, coerceChoice, menuCommands, helpText, COMMANDS } };
});
