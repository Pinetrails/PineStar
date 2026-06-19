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
  let pinnedReplyEl = null;     // THE PINNED REPLY: while a reply streams, its DOM row is held as the LAST log child so the
                                // actual message sits at the bottom of COMMS; work lines (tool ▶/◀, deliverables, consent) slot
                                // in ABOVE it instead of pushing it up out of view. Cleared the moment the reply finishes.
  let proposalsWired = false;   // the memory.proposed (turn-in) U.bus listener is registered exactly once
  let curiosityWired = false;   // the agent.run.end curiosity-nudge listener is registered exactly once
  const proposalRunsSeen = new Set();   // runIds already turned into a beat (memory.proposed fires once per proposal)
  const el = id => document.getElementById(id);
  let stick = true;   // STICKY-BOTTOM: auto-scroll only fires when the Commander is already at/near the bottom,
                      // so scrolling UP to re-read history mid-stream isn't yanked back down by every token.
  function nearBottom() { return !log || (log.scrollHeight - log.scrollTop - log.clientHeight < 40); }
  function autoscroll() { if (stick && log) log.scrollTop = log.scrollHeight; }

  const KIND_TAG = { profile: 'PREFERENCE', fact: 'FACT', skill: 'SKILL', note: 'NOTE' };

  function init(opts) {
    system = opts.system || ''; name = opts.name || 'AGENT';
    onTurn = opts.onTurn || null; interview = null;
    log = el('chat-log'); input = el('chat-input'); statusEl = el('chat-status');
    if (log) log.addEventListener('scroll', () => { stick = nearBottom(); });   // track whether the user is following the bottom
    input.value = '';
    wireProposals();   // Cortex turn-in beat: listen for reflection's memory.proposed (registers once)
    wireCuriosity();   // Commander Dossier: one gentle "tell me about X" nudge after a clean run (registers once)
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
    stick = true;   // a freshly-loaded / switched-to stream starts pinned to its latest line
    renderHistory();
    replayChannel();   // re-render an in-flight stream we left running: tool lines / partial reply / pending approval
    syncStatus();
    maybeEmptyState();   // brand-new / empty + idle stream → a one-line hint instead of a blank void
  }

  function setSystem(s, agentName) { system = s; if (agentName) name = agentName; }
  function getHistory() { return activeWs ? activeWs.history.slice() : []; }
  function isBusy() { return !!(activeWs && typeof Channels !== 'undefined' && Channels.isBusy(activeWs.id)); }
  function isActiveWs(ws) { return !!(ws && activeWs && activeWs.id === ws.id); }   // is THIS stream the one on screen right now?
  function status(s) { if (statusEl) statusEl.textContent = s; }
  // derive the DISPLAYED stream's status from real state, so a low-priority write (a finishing turn) can't
  // clobber the high-priority 'awaiting your approval…' after a switch-back. One source of truth.
  function syncStatus() {
    if (interview) { status('waking…'); return; }
    const p = (activeWs && typeof Channels !== 'undefined') ? Channels.pendingOf(activeWs.id) : null;
    status(p ? 'awaiting your approval…' : (isBusy() ? 'working…' : 'online'));
  }
  function clearEmptyState() { const e = log && log.querySelector('.cmsg-empty'); if (e) e.remove(); }
  // first-run state: an empty + idle + non-interview stream shows a single dim hint instead of a black void.
  function maybeEmptyState() {
    if (!log || interview) return;
    if (activeWs && activeWs.history && activeWs.history.length) return;
    if (isBusy() || log.querySelector('.cmsg')) return;
    const s = (typeof Channels !== 'undefined' && activeWs) ? Channels.snapshot(activeWs.id) : null;
    if (s && (s.tools.length || s.acc || s.pending)) return;
    const d = document.createElement('div'); d.className = 'cmsg-empty';
    d.textContent = 'COMMS online. Type a task or a question to ' + name + '.';
    log.appendChild(d);
  }

  // opts.live === true marks the streaming reply row, which always pins to the BOTTOM. Every other row (tool
  // ▶/◀ lines, deliverables, consent, turn-in) inserts ABOVE the pinned reply while one is live — so the work
  // log stacks above and the message the agent is actually saying stays at the bottom, never scrolled away.
  function row(role, opts) {
    clearEmptyState();   // any real row supersedes the first-run hint
    const d = document.createElement('div'); d.className = 'cmsg ' + role;
    const who = document.createElement('span'); who.className = 'who';
    who.textContent = role === 'user' ? 'COMMANDER' : name;
    const body = document.createElement('span'); body.className = 'body';
    d.appendChild(who); d.appendChild(body);
    if (!(opts && opts.live) && pinnedReplyEl && pinnedReplyEl.parentNode === log) log.insertBefore(d, pinnedReplyEl);
    else log.appendChild(d);
    autoscroll();
    return { d, body };
  }
  function addUser(t) { row('user').body.textContent = t; autoscroll(); }
  function localLine(t) { row('agent').body.textContent = t; autoscroll(); }
  // a compact tool-activity line in COMMS (▶ call / ◀ result) — the agent's real work, visible
  function toolLine(text, isErr) {
    const r = row('agent'); r.d.classList.add('tool'); if (isErr) r.d.classList.add('err');
    r.body.textContent = text; autoscroll();
  }
  function brief(s) { s = String(s || ''); return s.length > 56 ? s.slice(0, 53) + '…' : s; }
  function fmtMs(ms) { return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's'; }   // 8423 → '8.4s'
  // a clickable COMMS row for a file the agent produced — opens it via the sidecar's jailed /api/file route
  function deliverableLine(title, agentId) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('deliverable');
    r.body.appendChild(document.createTextNode('▤ saved '));
    const a = document.createElement('a');
    a.href = '/api/file?agent=' + encodeURIComponent(agentId || 'agent') + '&path=' + encodeURIComponent(title);
    a.target = '_blank'; a.rel = 'noopener';
    a.textContent = String(title).split(/[\\/]/).pop() || title;   // show the filename, not the whole path
    a.title = title;                                               // full path on hover
    a.className = 'deliverable-link';
    r.body.appendChild(a);
    autoscroll();
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
      syncStatus();
    }
    const mk = (text, decision, cls, doneLabel, isDeny) => {
      const b = document.createElement('button');
      b.className = 'consent-btn' + (cls ? ' ' + cls : '');
      b.textContent = text;
      b.onclick = () => decide(decision, doneLabel, isDeny);
      btns.appendChild(b); return b;
    };
    const approveBtn = mk('Approve once', 'once', '', '✓ approved once', false);
    mk('Always', 'always', '', '✓ always allowed', false);
    mk('Full access', 'full', 'danger', '✓ full access', false);
    mk('Deny', 'deny', 'deny', '✕ denied', true);
    r.body.appendChild(btns);
    // a blocking, run-pausing prompt: make it keyboard-operable (Esc = Deny; the focused Approve takes Enter/Space)
    r.d.tabIndex = -1;
    r.d.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); decide('deny', '✕ denied', true); } });
    status('awaiting your approval…');
    if (typeof StationUI !== 'undefined') StationUI.notify(name + ' needs approval to ' + actionPhrase(p), 'warn');
    log.scrollTop = log.scrollHeight;   // force into view: the run is paused until this is answered
    try { approveBtn.focus(); } catch (_) {}
  }

  // Cortex (M-mem.5b) — THE TURN-IN BEAT. After a run, reflection proposes durable memories; the Commander
  // decides Keep / Edit / Discard. Keep/Edit commit a real memory (the click IS the consent, §5.6); every
  // verdict feeds the agent's confidence. This is the gamified formation loop — the agent learns, you approve.
  function proposalCard(batch, ws) {
    if (!batch || !batch.proposals || !batch.proposals.length) return;
    const head = row('agent'); head.d.classList.add('tool'); head.d.classList.add('turnin');
    const n = batch.proposals.length;
    head.body.appendChild(document.createTextNode('🧠 ' + name + ' picked up ' + n + (n > 1 ? ' things' : ' thing') + ' worth remembering — keep ' + (n > 1 ? 'them' : 'it') + '?'));

    for (const prop of batch.proposals) {
      const item = document.createElement('div'); item.className = 'turnin-item';
      const kind = document.createElement('span'); kind.className = 'turnin-kind'; kind.textContent = KIND_TAG[prop.kind] || 'NOTE';
      const text = document.createElement('span'); text.className = 'turnin-text'; text.textContent = prop.content;
      const btns = document.createElement('span'); btns.className = 'consent-btns';
      item.appendChild(kind); item.appendChild(text); item.appendChild(btns);
      head.body.appendChild(item);

      let decided = false;
      function settle(label, isDeny) {
        decided = true; btns.remove();
        const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = label;
        item.appendChild(tag);
      }
      async function submit(verdict, content, label, isDeny) {
        if (decided) return; decided = true;
        const r = await Harness.memoryTurnin({ agentId: batch.agentId, runId: batch.runId, id: prop.id, verdict, content });
        if (r && r.ok) settle(label, isDeny);
        else { decided = false; if (typeof StationUI !== 'undefined') StationUI.notify('could not save that memory — try again', 'warn'); }
      }
      function mkBtn(label, cls, onClick) {
        const b = document.createElement('button'); b.className = 'consent-btn' + (cls ? ' ' + cls : ''); b.textContent = label; b.onclick = onClick; btns.appendChild(b); return b;
      }
      function renderChoices() {
        btns.innerHTML = '';
        mkBtn('Keep', '', () => submit('keep', null, '✓ kept in memory', false));
        mkBtn('Edit', '', enterEdit);
        mkBtn('Discard', 'deny', () => submit('discard', null, '✕ discarded', true));
      }
      // inline edit: swap the belief into an input; Save commits the edited text (verdict 'edit'), Cancel restores.
      function enterEdit() {
        if (decided) return;
        const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'turnin-edit'; inp.value = prop.content;
        item.replaceChild(inp, text); inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) {}
        const commit = () => { const v = inp.value.trim(); if (!v) { inp.focus(); return; } text.textContent = v; item.replaceChild(text, inp); submit('edit', v, '✓ saved (edited)', false); };
        const cancel = () => { item.replaceChild(text, inp); renderChoices(); };
        btns.innerHTML = '';
        mkBtn('Save', '', commit);
        mkBtn('Cancel', '', cancel);
        inp.onkeydown = e => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') cancel(); };
      }
      renderChoices();
    }
    if (typeof StationUI !== 'undefined') StationUI.notify(name + ' has ' + n + (n > 1 ? ' memories' : ' memory') + ' to review', 'gold');
    autoscroll();
  }

  // register ONCE: reflection announces proposals via the memory.proposed SSE event (re-emitted on U.bus). It
  // fires once per proposal, so debounce per-run, then fetch the full batch (with content) and render the beat
  // in the active stream when it's the proposing agent (else a soft notify — the agent learned something).
  function wireProposals() {
    if (proposalsWired || typeof U === 'undefined' || !U.bus) return;
    proposalsWired = true;
    U.bus.on('memory.proposed', p => {
      const runId = p && p.runId; const agentId = (p && p.agentId) || 'agent';
      if (!runId || proposalRunsSeen.has(runId)) return;
      proposalRunsSeen.add(runId);
      setTimeout(async () => {
        const proposals = await Harness.memoryProposals(runId, agentId);
        if (!proposals.length) return;
        const batch = { runId, agentId, proposals };
        // route to the ORIGIN stream (the one whose run proposed these) — many streams share agentId 'agent',
        // so gating on agentId can drop the card into the wrong COMMS after a mid-window switch.
        let originWs = null;
        if (typeof Workstreams !== 'undefined' && Workstreams.all) { try { originWs = Workstreams.all().find(w => (w.runIds || []).indexOf(runId) >= 0) || null; } catch (_) {} }
        const onActive = originWs ? (activeWs && activeWs.id === originWs.id) : (activeWs && (activeWs.agentId || 'agent') === agentId);
        if (onActive) proposalCard(batch, activeWs);
        else if (typeof StationUI !== 'undefined') StationUI.notify('an agent has ' + proposals.length + ' memories to review', 'gold');
      }, 350);   // let the per-proposal SSE events + the stash settle before the single fetch
    });
  }

  /* JUST-IN-TIME CURIOSITY (Commander Dossier, Phase B slice 2): after a clean run, the station may ask
     about ONE thing it still doesn't know about its Commander — gentle, budgeted (curiosity.js caps it at
     one per session), never after a stop/error. Mirrors the wireProposals turn-in beat. A "sure" launches a
     one-question intake interview for just that dimension; "not now" dismisses it for good. */
  function dimLabel(dim) {
    if (typeof Dossier !== 'undefined' && Dossier.DIMS) { const d = Dossier.DIMS.find(x => x.key === dim); if (d) return d.label; }
    return String(dim);
  }
  function curiosityNudge(dim) {
    if (!log) return;
    const r = row('agent'); r.d.classList.add('reply');
    r.body.textContent = '✦ one curious thing — i still don’t know your ' + dimLabel(dim).toLowerCase() + '. want to tell me? it sharpens how every agent here works for you.';
    autoscroll();
    choices([{ label: 'sure — ask me', value: 'yes' }, { label: 'not now', value: 'no', skip: true }], item => {
      if (item.value === 'yes' && typeof Intake !== 'undefined' && typeof Dossier !== 'undefined') {
        const skip = Dossier.DIM_KEYS.filter(k => k !== dim);   // ask ONLY this dimension (plan() returns just its question)
        Intake.start({
          skip: skip,
          onCommit: b => { if (typeof DossierStore !== 'undefined') DossierStore.upsert(b.dim, { text: b.text, source: 'curiosity' }); },
          onDone: () => { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('commander'); }
        });
      } else if (typeof CuriosityStore !== 'undefined') {
        CuriosityStore.markDismissed(dim);   // waved off → never raise this dimension again
      }
    });
  }
  function wireCuriosity() {
    if (curiosityWired || typeof U === 'undefined' || !U.bus) return;
    curiosityWired = true;
    U.bus.on('agent.run.end', p => {
      if (!p || p.reason !== 'done') return;   // only after a clean, successful run — never nag after a stop/limit/error
      setTimeout(() => {
        if (isBusy() || interview) return;     // another run started, or we're already mid-interview/awakening
        if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return;
        if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return;
        if (typeof CuriosityStore === 'undefined') return;
        const dim = CuriosityStore.consider();
        if (!dim) return;
        CuriosityStore.markShown();            // spend this session's single nudge whether or not they answer
        curiosityNudge(dim);
      }, 650);   // let the reply finish rendering before the nudge slots in below it
    });
  }

  function renderHistory() {
    const h = activeWs ? activeWs.history : [];
    for (const m of h) {
      if (m.role === 'user') { addUser(m.content); continue; }
      if (!(m.content || '').trim()) continue;   // skip a turn that produced no prose (tool-only / stopped run)
      const r = row('agent'); r.d.classList.add('reply');   // past agent turns get the same framed-headline look as live ones
      if (m.error) r.d.classList.add('err');
      r.body.textContent = m.content;
    }
  }

  // SWITCH-SURVIVAL: re-render whatever in-flight run we left on the now-displayed stream — its streamed
  // tool lines, its partial reply, and any pending approval — from the Channels snapshot. For an idle stream
  // the snapshot is empty and this is a no-op. (Live token re-binding for a stream switched-to MID-run lands
  // with the frontend-hud change that lifts the "can't switch while busy" guard — see the GATE handoff note.)
  function replayChannel() {
    activeLiveRow = null; pinnedReplyEl = null;   // log was just cleared by load(); drop any stale pin before re-rendering
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
    const r = row('agent', { live: true });   // the reply row pins to the bottom; work lines stack above it
    pinnedReplyEl = r.d;
    // bare name + blinking caret = "agent is composing"; the framed .reply headline is added on the FIRST real
    // token, so a tool-only turn never leaves an empty framed box at the bottom of COMMS.
    const caret = document.createElement('span'); caret.className = 'caret'; caret.textContent = '▮';
    r.d.appendChild(caret);
    const unpin = () => { if (pinnedReplyEl === r.d) pinnedReplyEl = null; };   // reply finished — later rows append at the very bottom again
    return {
      el: r.d,
      append(t) { r.body.textContent += t; if (r.body.textContent && !r.d.classList.contains('reply')) r.d.classList.add('reply'); autoscroll(); },
      done() { caret.remove(); unpin(); if (!r.body.textContent.trim()) r.d.remove(); },   // collapse a no-prose stub
      error(m) { r.d.classList.add('reply', 'err'); r.body.textContent = '⚠ ' + m; caret.remove(); unpin(); }
    };
  }

  // task-vs-chat classification lives in app/classify.js (pure + unit-tested); see Classify.isTaskDirective.

  async function send(text) {
    if (interview) { interview(text); return; }   // THE AWAKENING owns the input: route the answer to onboarding, no model call
    const ws = activeWs;   // CAPTURE the origin stream now — a mid-run switch must not cross-post its cost/files
    if (!ws) return;
    if (Channels.isBusy(ws.id)) return;   // one run per stream — but OTHER streams may be running concurrently
    stick = true;   // sending a message means you want to watch the exchange — re-follow the bottom
    addUser(text); ws.history.push({ role: 'user', content: text });
    // name an untitled stream from its first real message (no-op on General / already-titled)
    if (typeof Workstreams !== 'undefined' && Workstreams.autoTitle(ws.id, text)) {
      if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
    }

    const isTask = Classify.isTaskDirective(text);
    const targetAgentId = ws.agentId || 'agent';
    // a recruited/summoned (non-hero) agent should have its OWN workstation so its work visibly lands on the
    // floor. If it somehow doesn't (a pre-fix save, or a full station), best-effort auto-equip one — then run
    // REGARDLESS. The run is never hard-blocked: the sidecar grants default compute, so a task always proceeds.
    if (isTask && targetAgentId !== 'agent' && typeof App !== 'undefined') {
      let st = App.workstationStatus ? App.workstationStatus(targetAgentId) : null;
      if (st && !st.ok && App.ensureWorkstation) { App.ensureWorkstation(targetAgentId); st = App.workstationStatus(targetAgentId); }
      if (st && !st.ok && typeof StationUI !== 'undefined') StationUI.notify('no station workstation yet — place one in BUILD to watch this agent work on the floor', 'warn');
    }
    Channels.begin(ws.id);
    // fold the interest tag of a real task into the local user-affinity profile (the signal classify.js
    // already computes here and otherwise discards). Captures only a derived {code|research|general}
    // count — never the message text. Gated on the user's learning flag inside the store.
    if (isTask && typeof ProfileStore !== 'undefined') ProfileStore.observeMessage(text);
    if (isTask && typeof MintStore !== 'undefined') MintStore.observe(text);   // notice recurring jobs → propose minting them as one-tap missions
    // VOICE: the speaker toggle (🔊) controls whether the agent SPEAKS its reply (and in the short,
    // spoken style — voiceModeRules appended below). It does NOT control the desk trip: a real TASK is
    // real work, so it ALWAYS walks to the workstation and works there until done (the signature visible
    // loop), speaker on or off. When voice is on, a task's result is also spoken — it's just no longer
    // answered "on the spot" in place of the desk trip.
    const willSpeak = typeof Voice !== 'undefined' && Voice.isOn && Voice.isOn();
    // A TASK -> walk to the workstation + work there until the run completes (visible desk trip), whatever
    // the speaker setting. A CHAT (no task) -> face the Commander one-on-one (framed below when voice is on).
    // The decision lives in Classify.stanceFor, which takes ONLY isTask BY DESIGN: voice/speaker/UI state
    // can NEVER suppress a task's desk trip (the exact regression we fixed). Locked by classify.test.js.
    const stance = Classify.stanceFor(isTask);
    // per-agent: the HERO routes to setActivity (single-agent path unchanged); a summoned crew agent lights
    // ITS own body at ITS station, so tasking a summoned agent never moves the hero.
    if (World.setActivityFor) World.setActivityFor(ws.agentId || 'agent', stance); else World.setActivity(stance);
    // a spoken CHAT gently frames the agent one-on-one so you can see who you're talking to; a TASK is at
    // the desk instead (no-op if already comfortably on-screen; self-cancels the moment you pan/zoom).
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
        system: sys, messages: ws.history, agentId: ws.agentId || 'agent', isTask, signal: ac.signal, streamId: ws.id,
        workbench: (typeof World !== 'undefined' && World.heroWorkbench) ? World.heroWorkbench(ws.agentId || 'agent') : false,   // placed WORKBENCH -> this run gains shell.exec + verify.run
        onRunId: id => { Channels.setRunId(ws.id, id); if (typeof Workstreams !== 'undefined') { Workstreams.appendRun(ws.id, id); if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } },
        onToken: d => { acc += d; Channels.appendToken(ws.id, d); if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.append(d); if (!isTask) World.say(acc); } if (willSpeak) pushSpeech(false); App.refreshUsage(); },
        onUsage: () => App.refreshUsage(),
        onToolCall: ev => { callNames[ev.callId] = ev.name; const t = '▶ ' + ev.name + ' ' + brief(ev.argsSummary); Channels.addTool(ws.id, t, false); if (isActiveWs(ws)) toolLine(t); if (typeof U !== 'undefined' && U.bus && ev.name && ev.name.indexOf('mcp__') === 0) U.bus.emit('agent.tool_call', { name: ev.name }); },
        onToolResult: ev => { const nm = callNames[ev.callId] || 'tool'; const t = (ev.isError ? '✕ ' : '◀ ') + nm + ' · ' + brief(ev.summary || (ev.isError ? 'error' : 'ok')) + (ev.isError ? ' — failed' : '') + (ev.ms ? ' (' + fmtMs(ev.ms) + ')' : ''); Channels.addTool(ws.id, t, ev.isError); if (isActiveWs(ws)) toolLine(t, ev.isError); },
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
        ws.history.push({ role: 'assistant', content: '⚠ ' + error, error: true });   // so the failure survives a switch-back, not just a transient notify
        if (typeof StationUI !== 'undefined') StationUI.notify('run error: ' + brief(error), 'warn');
      } else {
        const replyText = reply || acc;
        finalReply = replyText;
        if (replyText.trim()) ws.history.push({ role: 'assistant', content: replyText });   // never persist an empty turn
        // the stop-reason is part of the WORK log → render it ABOVE the message (while the reply is still
        // pinned), THEN unpin via done(). done() also collapses the reply row if the turn produced no prose.
        if (endReason && endReason !== 'done') {
          if (isActiveWs(ws)) toolLine('⏹ ' + (endReason === 'max_iters' ? 'reached the step limit — say "continue" to keep going'
            : endReason === 'budget' ? 'reached this run\'s cost limit'
            : endReason === 'cancelled' ? 'run cancelled'
            : 'stopped (' + endReason + ')'));
          if (typeof StationUI !== 'undefined') StationUI.notify('run stopped: ' + endReason, 'warn');
        }
        if (isActiveWs(ws) && activeLiveRow) activeLiveRow.done();
        // a talk reply shows as a room bubble; the spoken reply itself is STREAMED sentence-by-sentence as
        // it arrives (onToken → pushSpeech) and flushed in the finally.
        if (!isTask && isActiveWs(ws)) World.say(replyText);
      }
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));
      if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.error(aborted ? '— disconnected —' : (e.message || String(e))); if (!isTask && !aborted) World.say('…connection trouble…'); }
      if (!aborted) ws.history.push({ role: 'assistant', content: '⚠ ' + (e.message || String(e)), error: true });   // keep a trace; skip on deliberate teardown
      // a THROWN teardown (abort/cancel/disconnect/network drop) means agent.run.end was LOST on the bus, so the
      // crew HUD would stick at WORKING — clear this run's count here. Normal + in-band-error completions deliver
      // run.end (decremented by the bus listener), so we must NOT clear there or a concurrent sibling under-counts.
      if (typeof StationUI !== 'undefined' && StationUI.clearRunning) StationUI.clearRunning(ws.agentId || 'agent');
    } finally {
      aborters.delete(ws.id);
      Channels.end(ws.id);
      if (isActiveWs(ws)) { syncStatus(); activeLiveRow = null; }
      // after a turn: in a hands-free voice conversation keep him facing you (one-on-one, no wandering off
      // between turns); otherwise he stands up and goes back to idle. Only steer the world if THIS finished
      // stream is the one on screen — a background stream finishing must not move the view.
      const stayFacing = typeof Voice !== 'undefined' && Voice.inVoiceMode && Voice.inVoiceMode();
      // a summoned crew body extinguishes the moment ITS run ends — even if it finished off-screen (a
      // background crew run must stop "working"). The hero keeps its original active-stream-gated stance.
      if ((ws.agentId || 'agent') !== 'agent') { if (World.setActivityFor) World.setActivityFor(ws.agentId, 'idle'); }
      else if (isActiveWs(ws)) { World.setActivity(stayFacing ? 'talk' : 'idle'); if (stayFacing && World.focusAgent) World.focusAgent({ soft: true }); }
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
  function beginInterview(onAnswer, opts) {
    interview = onAnswer || null;
    opts = opts || {};
    if (input) input.placeholder = opts.placeholder || 'answer to wake your agent…';
    status(opts.status || 'waking…');
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
    clearEmptyState();
    const rowEl = document.createElement('div'); rowEl.className = 'choice-row';
    let done = false;
    (items || []).forEach(it => {
      const b = document.createElement('button'); b.className = 'choice'; b.textContent = it.label;
      b.onclick = () => { if (done) return; done = true; rowEl.remove(); if (typeof SFX !== 'undefined') SFX.click(); onPick(it); };
      rowEl.appendChild(b);
    });
    log.appendChild(rowEl); autoscroll();
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
