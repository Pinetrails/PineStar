/* STARNET — chat.js : the in-game COMMS panel.
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
  const interrupted = new Set();   // wsIds the Commander deliberately STOPPED this turn — send()'s catch reads this as a
                                   // graceful stop (keep the partial reply, log no error) rather than a disconnect. Consumed in finally.
  const queued = new Map();        // TYPE-AHEAD: wsId -> [text,…] follow-ups typed while the stream was busy; auto-sent in order as it frees
  let activeLiveRow = null;     // streaming text controller for the DISPLAYED stream's in-flight run; rebound by replayChannel on switch
                                // CLASSIC HARNESS FLOW: prose and the agent's actions (tool ▶/◀ lines, deliverables, approval
                                // prompts) render CHRONOLOGICALLY — newest at the bottom — instead of pinning one reply block to
                                // the bottom with work floating above it. streamingAgent() segments the prose so an action drops
                                // in BETWEEN text blocks, exactly where it happened.
  let proposalsWired = false;   // the memory.proposed (turn-in) U.bus listener is registered exactly once
  let curiosityWired = false;   // the agent.run.end curiosity-nudge listener is registered exactly once
  let activeNudge = null;       // the live curiosity nudge { row, choiceRow, dim } — retired if a turn-in claims the post-run beat
  let activeTurnin = null;      // the single visible memory-review deck; later batches queue behind it
  const turninQueue = [];       // memory-review batches waiting for the visible deck to finish
  const activeChoiceRows = new Set();   // one-shot chip rows; cleared when a typed answer supersedes them
  const proposalRunsSeen = new Set();   // runIds already turned into a beat (memory.proposed fires once per proposal)
  const runWork = new Map();    // runId -> { toolsOk, delivered, cost, agentId } captured at run end → the "rate the work"
                                // beat's HONEST, un-farmable size + the delivery gate (real tools/deliverables only). FIFO-capped.
  const workRatedRuns = new Set();   // runIds already given a 👍/👌/👎 work verdict → one rating per run, never double-mint
  const RUN_META = new Map();   // runId -> { isTask, title } recorded at run START. The bus agent.run.end payload
                                // carries neither flag, so the post-run advice beats (the First Pitch graduation gate)
                                // read this to tell a real TASK from casual chat AND to name the run that actually just
                                // finished. Capped FIFO so a long session can't leak runIds.
  const el = id => document.getElementById(id);
  let stick = true;   // STICKY-BOTTOM: auto-scroll only fires when the Commander is already at/near the bottom,
                      // so scrolling UP to re-read history mid-stream isn't yanked back down by every token.
  function nearBottom() { return !log || (log.scrollHeight - log.scrollTop - log.clientHeight < 40); }
  function autoscroll() { if (stick && log) log.scrollTop = log.scrollHeight; else if (log) showNewPill(); }

  /* COMMS-PREMIUM · "new messages ↓" pill — when the Commander has scrolled UP to re-read (stick=false) and
     fresh content lands (autoscroll can't follow the bottom), a pill fades in over the transcript foot. Click
     jumps to the bottom and re-arms stickiness; it also self-hides the moment the scroll listener re-detects
     near-bottom. Reuses the existing stick machinery — no new scroll state. */
  function jumpToBottom() { if (log) { log.scrollTop = log.scrollHeight; stick = true; hideNewPill(); } }
  function showNewPill() {
    const panel = el('chat-panel'); if (!panel || stick) return;
    let pill = el('comms-newpill');
    if (!pill) {
      pill = document.createElement('button'); pill.id = 'comms-newpill'; pill.type = 'button'; pill.className = 'comms-newpill';
      pill.setAttribute('aria-label', 'Jump to newest messages');
      pill.textContent = 'new messages ↓';
      pill.onclick = () => { if (typeof SFX !== 'undefined' && SFX.click) SFX.click(); jumpToBottom(); };
      panel.appendChild(pill);
    }
    pill.classList.add('show');
  }
  function hideNewPill() { const p = el('comms-newpill'); if (p) p.classList.remove('show'); }

  /* COMMS PROCESSING TIMER — a live wall-clock readout in the header (▸ thinking · 3s) that counts how long
     the DISPLAYED stream's turn has been running. The start instant lives on the channel (Channels.startedAt),
     so the count is per-stream and survives a switch: jump to a background run and the timer shows ITS elapsed,
     not a reset. Honest by construction — it reads real wall-clock, never a fabricated number, and is empty
     (→ hidden) the moment the shown stream isn't running. */
  let elapsedTimer = 0;
  function fmtElapsed(ms) {
    const s = Math.floor((ms < 0 ? 0 : ms) / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;   // 3s · 42s · 1:05 · 12:30
  }
  function renderElapsed() {
    const ce = el('chat-elapsed'); if (!ce) return;
    const started = (activeWs && typeof Channels !== 'undefined') ? Channels.startedAtOf(activeWs.id) : 0;
    if (!isBusy() || !started) { if (ce.firstChild) ce.textContent = ''; return; }   // empty → CSS hides it
    const txt = fmtElapsed(Date.now() - started);
    let num = ce.querySelector('.ce-num');
    if (!num) { ce.textContent = ''; num = document.createElement('span'); num.className = 'ce-num'; ce.appendChild(num); }
    if (num.textContent !== txt) num.textContent = txt;   // only the digits change → the pulsing dot never restarts
    renderPresence();   // the presence card rides the same tick (single source of the elapsed wall-clock)
  }
  function ensureElapsedTimer() {
    renderElapsed();
    if (elapsedTimer) return;
    elapsedTimer = setInterval(() => { renderElapsed(); if (!isBusy()) stopElapsedTimer(); }, 250);   // sub-second tick so seconds land on time
  }
  function stopElapsedTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = 0; }
    const ce = el('chat-elapsed'); if (ce && ce.firstChild) ce.textContent = '';
  }

  /* ── COMMS-PREMIUM · LIVE WORKING-PRESENCE CARD ─────────────────────────────────────────────────────
     While a run is in flight ONE presence card is pinned at the transcript bottom (a real last-child of
     #chat-log, so it sits above the composer and scrolls with the feed): a blinking ▮, the current status
     VERB (THINKING / WORKING / AWAITING APPROVAL — derived from the SAME state that drives #chat-status),
     the CURRENT tool (latest onToolCall name, cleared on its result), and the elapsed time (reuses the
     existing per-stream wall-clock — Channels.startedAtOf — never a second counter). It appears on run
     start, updates IN PLACE via the elapsed tick (no transcript spam), and on run end resolves into a
     compact one-line summary (■ RUN COMPLETE · 2:14 [· N steps][· $x]); on error it resolves red. Truthful
     telemetry only: turns/cost are shown ONLY when a real value is handed in, never invented. */
  let presenceCurTool = null;   // the DISPLAYED stream's latest un-resolved tool name (or null)
  function presenceCard() {
    if (!log) return null;
    let card = log.querySelector('#comms-presence');
    if (!card) {
      clearEmptyState();
      card = document.createElement('div'); card.id = 'comms-presence'; card.className = 'comms-presence';
      card.setAttribute('aria-live', 'polite');
      const dot = document.createElement('span'); dot.className = 'cp-dot'; dot.textContent = '▮';
      const verb = document.createElement('span'); verb.className = 'cp-verb';
      const tool = document.createElement('span'); tool.className = 'cp-tool';
      const time = document.createElement('span'); time.className = 'cp-time';
      card.appendChild(dot); card.appendChild(verb); card.appendChild(tool); card.appendChild(time);
      log.appendChild(card);   // last child → pinned at the transcript bottom
    } else if (card !== log.lastElementChild) {
      log.appendChild(card);   // a row landed after it (tool chip / prose) → re-pin to the bottom
    }
    return card;
  }
  // derive the presence VERB from the same real state syncStatus() reads (pending approval > working > thinking)
  function presenceVerb() {
    const p = (activeWs && typeof Channels !== 'undefined') ? Channels.pendingOf(activeWs.id) : null;
    if (p) return 'AWAITING APPROVAL';
    const cs = (activeWs && typeof Channels !== 'undefined' && Channels.statusOf) ? Channels.statusOf(activeWs.id) : '';
    return (cs && /work/i.test(cs)) ? 'WORKING' : 'THINKING';
  }
  function renderPresence() {
    if (!log) return;
    const started = (activeWs && typeof Channels !== 'undefined') ? Channels.startedAtOf(activeWs.id) : 0;
    if (!isBusy() || !started) return;   // teardown resolves/removes it; never draw an idle presence card
    const card = presenceCard(); if (!card) return;
    const verb = card.querySelector('.cp-verb'); if (verb) verb.textContent = presenceVerb();
    const tool = card.querySelector('.cp-tool');
    if (tool) { const t = presenceCurTool ? shortName(presenceCurTool) : ''; if (tool.textContent !== t) tool.textContent = t; tool.classList.toggle('has', !!t); }
    const time = card.querySelector('.cp-time'); const txt = fmtElapsed(Date.now() - started);
    if (time && time.textContent !== txt) time.textContent = txt;
  }
  function startPresence(ws) {
    presenceCurTool = null;
    if (isActiveWs(ws)) { renderPresence(); ensureElapsedTimer(); }   // the elapsed tick also drives the presence update
  }
  function presenceToolCall(ws, name) { presenceCurTool = name || null; if (isActiveWs(ws)) renderPresence(); }
  function presenceToolResult(ws) { presenceCurTool = null; if (isActiveWs(ws)) renderPresence(); }
  // remove any live presence card without a summary (used when switching away / re-rendering a stream)
  function clearPresence() { const c = log && log.querySelector('#comms-presence'); if (c) c.remove(); presenceCurTool = null; }
  // resolve the live card into a compact one-line summary that STAYS in the transcript. opts: { error, raw,
  // stopped, endReason, steps, cost }. Truthful: steps/cost only appear when a real number is supplied.
  function resolvePresence(ws, opts) {
    if (!isActiveWs(ws)) { clearPresence(); return; }
    opts = opts || {};
    const started = (typeof Channels !== 'undefined') ? Channels.startedAtOf(ws.id) : 0;
    const dur = started ? fmtElapsed(Date.now() - started) : '';
    const card = log && log.querySelector('#comms-presence');
    if (!card) return;
    card.classList.remove('cp-live');
    presenceCurTool = null;
    const isErr = !!opts.error, isStop = !!opts.stopped || (opts.endReason && opts.endReason !== 'done');
    card.classList.add('resolved'); if (isErr) card.classList.add('err'); else if (isStop) card.classList.add('stopped');
    let label = isErr ? '■ RUN FAILED' : isStop ? '■ RUN STOPPED' : '■ RUN COMPLETE';
    const bits = [];
    if (dur) bits.push(dur);
    if (typeof opts.steps === 'number' && opts.steps > 0) bits.push(opts.steps + (opts.steps === 1 ? ' step' : ' steps'));
    if (typeof opts.cost === 'number' && opts.cost > 0) bits.push('$' + (Math.round(opts.cost * 100) / 100).toFixed(2));
    card.textContent = label + (bits.length ? ' · ' + bits.join(' · ') : '');
    card.setAttribute('role', 'note');
    autoscroll();
  }

  // RETIRE A SETTLED BEAT: a decided memory card / answered nudge fades + collapses, then drops out of the
  // DOM so the feed never accumulates dead cards (the "discarded cards don't disappear" bug). Pure view —
  // the decision was already committed by the caller. onGone fires once, after removal. Resilient: a missed
  // transitionend can't leave a ghost (fallback timer), and a double-call is a no-op.
  function vanish(node, onGone) {
    if (!node) { if (onGone) onGone(); return; }
    if (node.__vanishing) return;
    node.__vanishing = true;
    node.style.maxHeight = node.scrollHeight + 'px';                 // pin current height so the collapse can animate from it
    requestAnimationFrame(() => { node.classList.add('beat-vanish'); node.style.maxHeight = '0px'; });
    let done = false;
    const finish = () => { if (done) return; done = true; if (node.parentNode) node.remove(); if (onGone) onGone(); };
    node.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 460);   // fallback: a dropped transitionend (engine quirk / not displayed) still clears the card
  }

  const KIND_TAG = { profile: 'PREFERENCE', fact: 'FACT', skill: 'SKILL', note: 'NOTE' };

  // COMMS-PREMIUM — a subtle HH:MM stamp for a transmission-card header. The stored history carries no
  // per-message time, so replayed history gets NO stamp (never fabricate one); only rows created live at
  // render time get a real wall-clock stamp. Pure presentation, dim + right-aligned in the header row.
  function fmtClock(d) {
    d = d || new Date();
    const h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  // LINKIFY (XSS-safe): model output is untrusted, so we NEVER assign raw model text to innerHTML. Instead we
  // HTML-escape the WHOLE string first, then wrap only matched http(s) URL substrings in anchors. Escaping before
  // matching means the resulting markup can contain nothing the model authored as live HTML — only our own <a>
  // tags around escaped text. Used identically for live-streamed tokens, the final reply, and replayed history.
  const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => HTML_ESC[c]); }
  function linkify(text) {
    const s = String(text == null ? '' : text);
    const re = /https?:\/\/[^\s<>"']+/g;   // a run of non-space, non-markup chars after the scheme
    let out = '', last = 0, m;
    while ((m = re.exec(s)) !== null) {
      let url = m[0];
      const trail = /[.,;:!?'")\]}>]+$/.exec(url);   // don't swallow sentence punctuation trailing the URL
      if (trail) url = url.slice(0, url.length - trail[0].length);
      if (!url) continue;                            // pathological match (scheme only) — let escape handle it
      out += escapeHtml(s.slice(last, m.index));     // escaped text before the URL
      const safe = escapeHtml(url);                  // escape the URL too (its href + visible text are both safe)
      out += '<a href="' + safe + '" target="_blank" rel="noopener">' + safe + '</a>';
      last = m.index + url.length;                   // trailing punctuation (if trimmed) re-enters as escaped text
    }
    out += escapeHtml(s.slice(last));
    return out;
  }
  // render agent prose into a body span: fast textContent path when no URL is possible, else escaped+linkified
  // innerHTML. The fast path keeps the common (URL-free) streamed token cheap — no per-token HTML reparse.
  function renderProse(bodyEl, raw) {
    if (!bodyEl) return;
    if (String(raw).indexOf('http') === -1) bodyEl.textContent = raw;
    else bodyEl.innerHTML = linkify(raw);
  }

  // COPY-TO-CLIPBOARD: the async Clipboard API (works on localhost, a secure context), with a hidden-textarea
  // execCommand fallback for any context where it's unavailable. Resolves true on success so the button can confirm.
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
    } catch (_) {}
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea'); ta.value = text;
      ta.style.position = 'fixed'; ta.style.top = '-9999px'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (_) { return false; }
  }

  function init(opts) {
    system = opts.system || ''; name = opts.name || 'AGENT';
    onTurn = opts.onTurn || null; interview = null;
    proposalRunsSeen.clear(); clearChoices(); turninQueue.length = 0; activeTurnin = null; wiQDepth.clear(); queued.clear(); interrupted.clear();   // C2: per-session run-tracking + the queue gauge + turn-control state start clean for each agent (listeners stay once-registered)
    log = el('chat-log'); input = el('chat-input'); statusEl = el('chat-status');
    if (log) log.addEventListener('scroll', () => { stick = nearBottom(); if (stick) hideNewPill(); });   // track whether the user is following the bottom; back at the bottom retires the "new messages" pill
    // COPY: one delegated click handler for every (current + future) message row's ⧉ button — copies the
    // row's prose, then flashes a ✓ confirm. Wired once per log element so a re-init can't stack handlers.
    if (log && !log.__copyWired) {
      log.__copyWired = true;
      log.addEventListener('click', e => {
        // TOOL CHIP: clicking a chip's head toggles its expanded detail (checked before the copy button)
        const chipHead = e.target.closest('.tc-head');
        if (chipHead) { toggleChip(chipHead); if (typeof SFX !== 'undefined' && SFX.click) SFX.click(); return; }
        const btn = e.target.closest('.cmsg-copy'); if (!btn) return;
        const bodyEl = btn.closest('.cmsg') && btn.closest('.cmsg').querySelector('.body');
        const txt = bodyEl ? bodyEl.textContent : '';
        if (!txt) return;
        copyText(txt).then(ok => {
          if (!ok) return;
          btn.classList.add('copied'); btn.textContent = '✓';
          if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
          setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '⧉'; }, 1100);
        });
      });
    }
    input.value = '';
    wireProposals();   // Cortex turn-in beat: listen for reflection's memory.proposed (registers once)
    wireCuriosity();   // Commander Dossier: one gentle "tell me about X" nudge after a clean run (registers once)
    load(opts.ws);
    input.onkeydown = e => {
      // SLASH PALETTE owns the nav keys while open (a "/command" menu over the input)
      if (isSlashOpen()) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSlash(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveSlash(-1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); runSlash(slashItems[slashSel]); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSlash(); return; }
        // any other key falls through to normal typing → the 'input' listener re-filters the palette
      }
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        const t = input.value.trim();
        if (!t) return;
        input.value = ''; closeSlash();
        if (isBusy()) enqueue(t); else send(t);   // TYPE-AHEAD: queue a follow-up rather than dropping it while the stream is busy
      } else if (e.key === 'Escape' && isBusy()) {
        e.preventDefault(); e.stopPropagation();   // INTERRUPT: beat navdock's global Esc-closes-menus while a run is live
        stopActive();
      }
    };
    // SLASH PALETTE: a leading "/" opens the command menu and filters it live as you type past it.
    input.addEventListener('input', () => { const v = input.value; if (v[0] === '/') openSlash(v.slice(1)); else closeSlash(); });
    const stopBtn = el('chat-stop'); if (stopBtn) stopBtn.onclick = stopActive;
  }

  // swap the rendered conversation to a workstream (its history). Used on enter/resume and when the
  // Commander clicks another stream in the rail — re-renders without re-wiring the input row.
  function load(ws) {
    activeWs = ws || (typeof Workstreams !== 'undefined' ? Workstreams.active() : null);
    activeTurnin = null; turninQueue.length = 0; clearChoices();   // visible review/choice layers belong to the current COMMS DOM
    endToolRail(); presenceCurTool = null;   // COMMS-PREMIUM: the tool rail + live-tool state belong to the OUTGOING stream's DOM
    // typing targets the displayed stream (war-room D2: the compose target is decoupled from any camera jump)
    if (activeWs && typeof Channels !== 'undefined') Channels.setComposeTarget(activeWs.id);
    if (log) log.innerHTML = '';
    stick = true; hideNewPill();   // a freshly-loaded / switched-to stream starts pinned to its latest line
    renderHistory();
    replayChannel();   // re-render an in-flight stream we left running: tool lines / partial reply / pending approval
    syncStatus();      // also paints the Stop control + this stream's queued pills (updateControls)
    maybeEmptyState();   // brand-new / empty + idle stream → a one-line hint instead of a blank void
    if (activeWs) flushQueued(activeWs.id);   // returned to an idle stream that has a queued follow-up → send it now
    // TIER D · D1 ATTENTIVE AUDIENCE: announce which agent the Commander now has COMMS focus on. load(ws) is the
    // sole conversation-rebind boundary (open + every switch), and the persistent COMMS panel has no separate
    // close — so this one hook covers focus on/switch, and null when there's no active stream. world.js owns all
    // behavior: the focused body, while idle, stops wandering and holds its attention on you (faces you, tracks the
    // cursor); it yields instantly to a reply run and resumes after. This is the ONLY chat.js change for D1 (G7).
    if (typeof World !== 'undefined' && World.setChatFocus) World.setChatFocus(activeWs ? (activeWs.agentId || 'agent') : null);
  }

  function setSystem(s) { system = s; }
  function getHistory() { return activeWs ? activeWs.history.slice() : []; }
  function isBusy() { return !!(activeWs && typeof Channels !== 'undefined' && Channels.isBusy(activeWs.id)); }
  function isActiveWs(ws) { return !!(ws && activeWs && activeWs.id === ws.id); }   // is THIS stream the one on screen right now?
  function status(s) {
    if (!statusEl) return;
    statusEl.textContent = s;
    const low = String(s || '').toLowerCase();
    statusEl.classList.remove('status-thinking', 'status-working', 'status-approval', 'status-stopping', 'status-online');
    statusEl.classList.add(low.indexOf('approval') >= 0 ? 'status-approval'
      : low.indexOf('stopping') >= 0 ? 'status-stopping'
      : low.indexOf('working') >= 0 ? 'status-working'
      : low.indexOf('thinking') >= 0 ? 'status-thinking'
      : 'status-online');
  }
  // derive the DISPLAYED stream's status from real state, so a low-priority write (a finishing turn) can't
  // clobber the high-priority 'awaiting your approval…' after a switch-back. One source of truth.
  function syncStatus() {
    if (interview) { status('waking…'); stopElapsedTimer(); return; }
    const p = (activeWs && typeof Channels !== 'undefined') ? Channels.pendingOf(activeWs.id) : null;
    const channelStatus = (activeWs && typeof Channels !== 'undefined' && Channels.statusOf) ? Channels.statusOf(activeWs.id) : '';
    status(p ? 'awaiting your approval…' : (isBusy() ? (channelStatus || 'thinking…') : 'online'));
    // keep the elapsed readout matched to the DISPLAYED stream — switching to a busy stream picks up its
    // live count, switching to an idle one clears it. (send() also starts it the instant a run begins.)
    if (isBusy()) ensureElapsedTimer(); else stopElapsedTimer();
    updateControls();   // Stop button visibility + queued pills follow the displayed stream too
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
    // COMMS-PREMIUM: the speaker chip + a dim HH:MM stamp share one header row (a flex .cmsg-head). The
    // stamp is a REAL wall-clock render-time stamp — replayed history passes stamp:false (no fabricated time).
    const who = document.createElement('span'); who.className = 'who';
    who.textContent = role === 'user' ? 'COMMANDER' : name;
    const body = document.createElement('span'); body.className = 'body';
    const wantStamp = !!(opts && opts.stamp);
    if (wantStamp) {
      const head = document.createElement('span'); head.className = 'cmsg-head';
      const ts = document.createElement('span'); ts.className = 'cmsg-ts'; ts.textContent = fmtClock();
      head.appendChild(who); head.appendChild(ts);
      d.appendChild(head); d.appendChild(body);
    } else {
      d.appendChild(who); d.appendChild(body);
    }
    // COPY: a hover-revealed copy button on the agent's MESSAGE rows. CSS hides it on the work-log beats
    // (tool / consent / turn-in / nudge / deliverable) — those aren't prose to copy. One delegated handler
    // in init() reads the row's .body text, so a streamed reply gains the button the moment its row exists.
    if (role === 'agent') {
      const cp = document.createElement('button'); cp.className = 'cmsg-copy'; cp.type = 'button';
      cp.title = 'copy message'; cp.setAttribute('aria-label', 'Copy message'); cp.textContent = '⧉';
      d.appendChild(cp);
    }
    log.appendChild(d);   // CHRONOLOGICAL: every row lands at the bottom, in the order it happened (classic chat)
    autoscroll();
    return { d, body };
  }
  function addUser(t) { row('user', { stamp: true }).body.textContent = t; autoscroll(); }
  function localLine(t) { row('agent', { stamp: true }).body.textContent = t; autoscroll(); }

  /* ---------- CELEBRATION broadcast: a terse station system line (level-up / quest / trophy) ----------
     NOT a beat-slot card: it never touches activeNudge/the post-run precedence chain (turn-in→suggestion→
     seed→curiosity), so it can never compete with or suppress a real ask. It's an ambient system line —
     dim, letter-spaced, centered, hairline rules either side — appended to the transcript exactly where it
     happened (so it slots UNDER a live presence card, never over it). The eerie register: a terse broadcast,
     never a party. `tint` (an agent suit colour) is the ONE established colour exception, applied to a
     highlighted span only. RESTRAINT enforced here: fires only in-game (never on the create/onboarding
     screens), and coalesces — two broadcasts inside ~3s never stack; the later one is dropped. */
  const BROADCAST_COALESCE_MS = 3000;
  let lastBroadcastAt = 0;
  function broadcastBlocked() {
    // never during the create/onboarding/interview flows — a celebration must land only on the live station
    const game = el('screen-game');
    if (!game || !game.classList.contains('active')) return true;
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return true;
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return true;
    return false;
  }
  // text: the terse line WITHOUT the leading ▸ (added here). opts.highlight: the substring to tint (the agent
  // name); opts.tint: the suit colour for that span; opts.tone: 'gold' brightens the whole line (trophies).
  function broadcast(text, opts) {
    if (!log) return false;
    opts = opts || {};
    if (broadcastBlocked()) return false;
    const now = Date.now();
    if (now - lastBroadcastAt < BROADCAST_COALESCE_MS) return false;   // coalesce: no back-to-back broadcasts
    lastBroadcastAt = now;
    clearEmptyState();
    const d = document.createElement('div');
    d.className = 'cmsg broadcast' + (opts.tone === 'gold' ? ' broadcast-gold' : '');
    d.setAttribute('role', 'status');   // a live-region system line for AT (it renders no speaker chip)
    const line = document.createElement('span'); line.className = 'bc-line';
    const raw = String(text == null ? '' : text);
    const hi = opts.highlight ? String(opts.highlight) : '';
    const ix = hi ? raw.indexOf(hi) : -1;
    // prefix glyph
    const pre = document.createElement('span'); pre.className = 'bc-glyph'; pre.textContent = '▸ ';
    line.appendChild(pre);
    if (ix >= 0) {
      if (ix > 0) line.appendChild(document.createTextNode(raw.slice(0, ix)));
      const em = document.createElement('span'); em.className = 'bc-name'; em.textContent = hi;
      if (opts.tint) { em.style.color = opts.tint; em.style.textShadow = '0 0 6px ' + opts.tint; }
      line.appendChild(em);
      line.appendChild(document.createTextNode(raw.slice(ix + hi.length)));
    } else {
      line.appendChild(document.createTextNode(raw));
    }
    d.appendChild(line);
    log.appendChild(d);
    autoscroll();
    return true;
  }
  // a compact tool-activity line in COMMS (▶ call / ◀ result) — the agent's real work, visible. Kept for
  // REPLAY (Channels stores pre-formatted strings) and for the ⏹ stop-reason line; the LIVE call/result path
  // now renders structured tool CHIPS (toolChip / resolveChip) instead. Ends any open chip rail first so the
  // stored line lands after the rail, not glued into it.
  function toolLine(text, isErr) {
    endToolRail();
    const r = row('agent'); r.d.classList.add('tool'); if (isErr) r.d.classList.add('err');
    r.body.textContent = text; autoscroll();
  }
  function brief(s) { s = String(s || ''); return s.length > 56 ? s.slice(0, 53) + '…' : s; }
  function fmtMs(ms) { return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's'; }   // 8423 → '8.4s'

  /* ── COMMS-PREMIUM · TOOL CHIPS ──────────────────────────────────────────────────────────────────────
     The agent's real actions render as compact one-line chips (glyph · tool name · short args) instead of
     the old "▶ toolname args" text lines. Consecutive chips in the same run group tightly into ONE thin
     activity rail (.tool-rail). When the result callback pairs to the call (by callId), the result FOLDS
     back into the same chip (✓/✗ + duration) rather than emitting a second line. Click toggles an expanded
     view (full args + result summary, length-capped). Cheap by design: a one-time fade-in per chip, no
     per-chip looping animation, and the expanded text is capped so a long run stays DOM-lean. */
  let toolRail = null;                 // the currently-open .tool-rail container (consecutive chips join it)
  const pendingChips = new Map();      // callId -> chip element awaiting its result (for call→result folding)
  const CHIP_CAP = 600;                // cap on stored expand text length — a long run must not bloat the DOM
  const cap = s => { s = String(s == null ? '' : s); return s.length > CHIP_CAP ? s.slice(0, CHIP_CAP) + '…' : s; };
  const shortName = n => String(n || 'tool').replace(/^mcp__/, '').replace(/_/g, '.');   // mcp__x__y → x.y, readable
  function ensureToolRail() {
    if (toolRail && toolRail.isConnected) return toolRail;
    clearEmptyState();
    toolRail = document.createElement('div'); toolRail.className = 'tool-rail';
    log.appendChild(toolRail); autoscroll();
    return toolRail;
  }
  function endToolRail() { toolRail = null; pendingChips.clear(); }   // a break (prose / beat / deliverable) closes the rail
  // one delegated toggle handler for the whole log's chips (wired once alongside the copy handler)
  function toggleChip(head) {
    const chip = head && head.closest && head.closest('.tool-chip'); if (!chip) return;
    const body = chip.querySelector('.tc-detail'); if (!body) return;
    const open = chip.classList.toggle('open');
    chip.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  // render a tool CALL as a chip; returns the chip element. ev: { callId, name, argsSummary }
  function toolChip(ev) {
    const rail = ensureToolRail();
    const chip = document.createElement('div'); chip.className = 'tool-chip pending';
    chip.setAttribute('aria-expanded', 'false');
    const head = document.createElement('button'); head.type = 'button'; head.className = 'tc-head';
    const glyph = document.createElement('span'); glyph.className = 'tc-glyph'; glyph.textContent = '▸';
    const nm = document.createElement('span'); nm.className = 'tc-name'; nm.textContent = shortName(ev.name);
    const args = document.createElement('span'); args.className = 'tc-args'; args.textContent = ev.argsSummary ? brief(ev.argsSummary) : '';
    const stat = document.createElement('span'); stat.className = 'tc-stat'; stat.textContent = '';   // filled by resolveChip
    head.appendChild(glyph); head.appendChild(nm); if (ev.argsSummary) head.appendChild(args); head.appendChild(stat);
    const detail = document.createElement('div'); detail.className = 'tc-detail';
    const dArgs = document.createElement('div'); dArgs.className = 'tc-d-args';
    dArgs.textContent = ev.argsSummary ? cap(ev.argsSummary) : '(no arguments)';
    detail.appendChild(dArgs);
    chip.appendChild(head); chip.appendChild(detail);
    rail.appendChild(chip);
    if (ev.callId != null) { pendingChips.set(ev.callId, chip); if (pendingChips.size > 200) pendingChips.delete(pendingChips.keys().next().value); }
    autoscroll();
    return chip;
  }
  // fold a tool RESULT into its paired chip (✓/✗ + duration + result summary). ev: { callId, summary, isError, ms }
  function resolveChip(ev, fallbackName) {
    let chip = (ev.callId != null) ? pendingChips.get(ev.callId) : null;
    if (chip) pendingChips.delete(ev.callId);
    if (!chip) {
      // ORPHAN result (no paired call — e.g. switched-to mid-run): render a standalone resolved chip
      chip = toolChip({ callId: null, name: fallbackName || 'tool', argsSummary: '' });
    }
    chip.classList.remove('pending');
    chip.classList.add(ev.isError ? 'err' : 'ok');
    const glyph = chip.querySelector('.tc-glyph'); if (glyph) glyph.textContent = ev.isError ? '✗' : '✓';
    const stat = chip.querySelector('.tc-stat');
    if (stat) stat.textContent = ev.ms ? fmtMs(ev.ms) : (ev.isError ? 'failed' : '');
    const detail = chip.querySelector('.tc-detail');
    if (detail) {
      const dRes = document.createElement('div'); dRes.className = 'tc-d-res' + (ev.isError ? ' err' : '');
      dRes.textContent = (ev.isError ? '✗ ' : '✓ ') + cap(ev.summary || (ev.isError ? 'error' : 'ok'));
      detail.appendChild(dRes);
    }
    autoscroll();
    return chip;
  }
  // a clickable COMMS row for a file the agent produced — opens it via the sidecar's jailed /api/file route
  function fileBlobUrl(title, agentId) {
    const url = fileUrl(title, agentId);
    return fetch(url, { cache: 'no-store' }).then(r => {
      if (!r.ok) throw new Error('file HTTP ' + r.status);
      return r.blob();
    }).then(b => URL.createObjectURL(b));
  }
  function wireBlobOpen(a, title, agentId) {
    a.href = '#'; a.target = '_blank'; a.rel = 'noopener';
    a.addEventListener('click', ev => {
      ev.preventDefault();
      fileBlobUrl(title, agentId).then(u => { try { window.open(u, '_blank', 'noopener'); } catch (_) {} }).catch(() => {});
    });
  }
  function deliverableLine(title, agentId) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('deliverable');
    r.body.appendChild(document.createTextNode('▤ saved '));
    const a = document.createElement('a');
    wireBlobOpen(a, title, agentId);
    a.textContent = String(title).split(/[\\/]/).pop() || title;   // show the filename, not the whole path
    a.title = title;                                               // full path on hover
    a.className = 'deliverable-link';
    r.body.appendChild(a);
    autoscroll();
  }
  // an image the agent generated (image_generate / the `studio` capability) — render it INLINE as a small
  // thumbnail (src = the sidecar's jailed /api/file viewer URL, served with an image content-type); clicking
  // opens the full image in a new tab. Built with DOM nodes (never innerHTML) so the title can't inject markup.
  function imageDeliverableLine(title, agentId) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('deliverable'); r.d.classList.add('image');
    r.body.appendChild(document.createTextNode('▤ made '));
    const a = document.createElement('a');
    wireBlobOpen(a, title, agentId);
    a.className = 'deliverable-thumb';
    a.title = title;                                               // full path on hover
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = String(title).split(/[\\/]/).pop() || title;
    a.appendChild(img);
    r.body.appendChild(a);
    fileBlobUrl(title, agentId).then(u => { img.src = u; a.href = u; }).catch(() => {});
    autoscroll();
  }
  // CLIENT-SIDE MEDIA KIND, keyed off the file extension (the Hermes media.ts model): the backend doesn't
  // declare "this is a video" — we decide from the path, so any .mp4 an agent writes/downloads renders as a
  // player with zero backend wiring. Unknown extensions fall through to 'file' (the plain clickable row).
  const MEDIA_KIND_BY_EXT = {
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image',
    mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video',
    mp3: 'audio', m4a: 'audio', ogg: 'audio', wav: 'audio', flac: 'audio', opus: 'audio'
  };
  function mediaKindOf(title) {
    const ext = String(title || '').split(/[?#]/, 1)[0].split('.').pop().toLowerCase();
    return MEDIA_KIND_BY_EXT[ext] || 'file';
  }
  function fileUrl(title, agentId) {
    const tok = (typeof Harness !== 'undefined' && Harness.apiToken) ? String(Harness.apiToken() || '') : '';
    return '/api/file?agent=' + encodeURIComponent(agentId || 'agent') +
      '&path=' + encodeURIComponent(title) +
      (tok ? '&token=' + encodeURIComponent(tok) : '');
  }
  // append a small "open in a new tab" fallback link — shown when an inline player can't decode the file
  // (e.g. an .mkv/.avi the browser won't play), mirroring Hermes's OpenMediaButton.
  function openFallback(parent, label, url, title, agentId) {
    if (parent.querySelector('.media-fallback')) return;   // once
    const a = document.createElement('a');
    a.href = url || '#'; a.target = '_blank'; a.rel = 'noopener'; a.className = 'deliverable-link media-fallback';
    if (!url) wireBlobOpen(a, title, agentId);
    a.textContent = label; a.title = title;
    parent.appendChild(a);
  }
  // a media deliverable rendered INLINE as a seekable player. The src is the jailed /api/file route, which
  // now streams with HTTP Range so <video>/<audio> can seek without loading the whole file. preload=metadata
  // fetches just enough for a duration + scrubber. On a decode error we drop in an open-externally link.
  function mediaPlayerLine(title, agentId, kind) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('deliverable'); r.d.classList.add(kind);
    const name = String(title).split(/[\\/]/).pop() || title;
    r.body.appendChild(document.createTextNode('▤ made '));
    const cap = document.createElement('span'); cap.className = 'media-name'; cap.textContent = name; cap.title = title;
    r.body.appendChild(cap);
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.controls = true; el.preload = 'metadata'; el.className = 'deliverable-' + kind;
    let blobUrl = '';
    el.addEventListener('error', () => openFallback(r.body, 'open ' + kind, blobUrl, title, agentId), { once: true });
    r.body.appendChild(el);
    fileBlobUrl(title, agentId).then(u => { blobUrl = u; el.src = u; }).catch(() => openFallback(r.body, 'open ' + kind, '', title, agentId));
    autoscroll();
  }

  /* ── END-OF-RUN RECAP (work-visibility slice 1) — a passive REPORT card in the run's own message flow.
     On run end we fetch the run's recorded outcome (GET /api/runs?agent=&runId= — the sidecar's append-only
     artifacts ledger, recorded by runOnce) and, ONLY when the run produced artifacts or ended abnormally,
     render ONE compact work-log card: an outcome line (title/reason), the artifact list, and cost + duration
     + model. It is NOT an ask: it never touches the single post-run beat slot (no clearNudge, no .turnin /
     .nudge class, nothing the beat guards match) and it stays in the log like tool lines do — no vanish().
     A quiet artifact-less clean finish renders nothing: the existing reply/⏹ flow already said everything. */
  function fmtRecapCost(entry) {
    if (entry.unmetered) return 'subscription';
    const v = Number(entry.usd) || 0;
    if (v <= 0) return '';                                   // a free/unpriced run shows no fake $0
    return '$' + (v >= 0.01 ? v.toFixed(2) : v.toFixed(4));
  }
  function fmtBytes(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }
  function recapArtifactLine(a, agentId) {
    const d = document.createElement('div'); d.className = 'recap-line';
    if (a.kind === 'message') { d.textContent = '✉ sent to ' + (a.target || 'a channel'); return d; }
    const path = String(a.path || '');
    d.appendChild(document.createTextNode(a.kind === 'image' ? '▤ made ' : '▤ wrote '));
    const link = document.createElement('a');
    wireBlobOpen(link, path, agentId);                       // the same jailed /api/file open every deliverable row uses
    link.className = 'deliverable-link';
    link.textContent = path.split(/[\\/]/).pop() || path;    // filename shown, full path on hover
    link.title = path;
    d.appendChild(link);
    if (typeof a.bytes === 'number' && a.bytes >= 0) d.appendChild(document.createTextNode(' — ' + fmtBytes(a.bytes)));
    // reveal the path: click-to-copy of the workspace path (no shell-open pattern exists in this frontend —
    // per the design contract we don't invent new Tauri permissions for it).
    const cp = document.createElement('button'); cp.type = 'button'; cp.className = 'recap-copy';
    cp.textContent = '⧉'; cp.title = 'copy path: ' + path;
    cp.onclick = () => copyText(path).then(ok => { if (!ok) return; cp.textContent = '✓'; setTimeout(() => { cp.textContent = '⧉'; }, 1100); });
    d.appendChild(cp);
    return d;
  }
  const RECAP_MAX_ROWS = 12;   // a monster run lists the first dozen + a "+N more" note (the RUNS panel has the rest)
  function recapCard(entry, arts, agentId, durMs) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('recap');
    const done = (entry.reason || 'done') === 'done';
    const head = document.createElement('div'); head.className = 'recap-line recap-head';
    head.textContent = (done ? '◈ delivered' : '◈ ended: ' + entry.reason) + (entry.title ? ' — ' + brief(entry.title) : '');
    r.body.appendChild(head);
    for (const a of arts.slice(0, RECAP_MAX_ROWS)) r.body.appendChild(recapArtifactLine(a, agentId));
    if (arts.length > RECAP_MAX_ROWS) {
      const more = document.createElement('div'); more.className = 'recap-line';
      more.textContent = '… +' + (arts.length - RECAP_MAX_ROWS) + ' more';
      r.body.appendChild(more);
    }
    const foot = document.createElement('div'); foot.className = 'recap-line recap-foot';
    foot.textContent = [fmtRecapCost(entry), durMs > 0 ? fmtMs(durMs) : '', (entry.model && entry.model !== '(unknown)') ? entry.model : ''].filter(Boolean).join(' · ');
    if (foot.textContent) r.body.appendChild(foot);
    autoscroll();
  }
  async function renderRunRecap(ws, runId, durMs) {
    try {
      const agentId = ws.agentId || 'agent';
      const res = await fetch('/api/runs?agent=' + encodeURIComponent(agentId) + '&runId=' + encodeURIComponent(runId), { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      const entry = (j && Array.isArray(j.runs)) ? j.runs.find(x => x && x.runId === runId) : null;
      if (!entry) return;                                              // truthful: no recorded entry, no recap
      const arts = Array.isArray(entry.artifacts) ? entry.artifacts : [];   // a legacy row fails open to []
      if (!arts.length && (entry.reason || 'done') === 'done') return;      // quiet clean finish — leave the flow untouched
      if (!isActiveWs(ws)) return;   // the work-log register renders on the on-screen stream only, same as tool lines
      recapCard(entry, arts, agentId, durMs);
    } catch (_) { /* the recap is best-effort — it must never disturb the turn teardown */ }
  }

  // a live consent prompt: the agent wants to do something that needs approval (a file write today). The run is
  // PAUSED on the sidecar until the Commander answers — once / always (this kind) / full access (everything this
  // session) / deny. Answering resumes the stream automatically.
  function actionPhrase(ev) {
    const t = ev.tool || 'act';
    if (/notebook/.test(t)) return 'save a note to its memory';
    if (/summon/.test(t)) return 'summon a new agent onto the crew' + (ev.argsSummary ? ' (' + ev.argsSummary + ')' : '');
    if (/write|append|edit/.test(t)) return 'write ' + (ev.argsSummary || 'a file');
    return t.replace(/_/g, '.') + (ev.argsSummary ? ' ' + ev.argsSummary : '');
  }
  // p = a consent payload { promptId, tool, argsSummary } — works for both a live onPermission event and a
  // Channels snapshot.pending (re-rendered after a switch). ws is the origin stream, so the answer routes to
  // THAT stream's run (per-channel runId), not a single global one.
  function permissionRow(p, ws) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('consent');
    r.body.appendChild(document.createTextNode('▣ ' + name + ' wants to ' + actionPhrase(p) + ' '));
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    let decided = false;
    function decide(decision, doneLabel, isDeny) {
      if (decided) return; decided = true;
      const rid = (ws && typeof Channels !== 'undefined') ? Channels.runIdOf(ws.id) : null;
      Harness.consent(rid, p.promptId, decision);
      // surface the decision on the bus (schema: permission.response) so listeners — e.g. the first-run tutorial —
      // can tell an approve from a deny and narrate the consent loop honestly. Additive; the run resumes via Harness.consent.
      try { if (typeof U !== 'undefined' && U.bus) U.bus.emit('permission.response', { promptId: p.promptId, decision: decision }); } catch (_) {}
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

  // ── "RATE THE WORK" — the PRIMARY leveling beat. After a run that actually DID work, the Commander gives a
  //    one-tap verdict on the OUTPUT (👍 nailed it / 👌 close / 👎 missed). 👍 mints size-weighted XP; 👌/👎 only
  //    nudge the satisfaction meter (never a penalty, never XP). It rides memory.feedback with a SYNTHETIC id,
  //    called DIRECTLY into XpStore — never the bus, never the sidecar memory store — so memory trust is untouched.
  function workSizeDelta(w) {
    if (!w) return 1;
    const tools = Math.min(Math.max(0, w.toolsOk || 0), 8);
    const deliv = Math.min(Math.max(0, w.delivered || 0), 3);
    const usd = Math.max(0, w.cost || 0);
    // honest + un-farmable: real successful tool calls + produced files + a little for spend, bucketed 1..10.
    const raw = Math.log2(1 + tools) * 2.2 + deliv * 1.2 + Math.min(usd * 6, 3);
    return Math.max(1, Math.min(10, Math.round(raw) || 1));
  }
  function rateWork(agentId, runId, verdict) {
    if (!runId || workRatedRuns.has(runId)) return;
    workRatedRuns.add(runId);
    if (workRatedRuns.size > 120) workRatedRuns.delete(workRatedRuns.values().next().value);
    const reason = verdict === 'great' ? 'work_great' : verdict === 'ok' ? 'work_ok' : 'work_miss';
    const w = runWork.get(runId);
    const delta = workSizeDelta(w);
    // G2.4 task-size weighting: the same real stash also derives a small/medium/large hint (Xp.workSize —
    // successful tools + reconciled spend); xp.js scales the mint by it, FEEDBACK_XP_CAP still the ceiling.
    const size = (typeof Xp !== 'undefined' && Xp.workSize) ? Xp.workSize({ tools: (w && w.toolsOk) || 0, usd: (w && w.cost) || 0 }) : undefined;
    // DIRECT call — never U.bus.emit / never /api/memory/turnin. The 'work:'+runId id resolves to NO memory
    // record, so the sidecar memcore trust path is never touched (delta here is an XP size only).
    if (typeof XpStore !== 'undefined' && XpStore.onEvent) XpStore.onEvent('memory.feedback', { agentId: agentId || 'agent', id: 'work:' + runId, runId: runId, delta: delta, reason: reason, size: size });
    // G3a confidence narrative: the same DIRECT hand-off (this verdict never rides the bus, so the fire-once
    // calibration/TRUSTED beats must be told here, AFTER the meter folded). Speaks at most twice, ever; mints nothing.
    if (typeof ConfBeats !== 'undefined' && ConfBeats.onFeedback) { try { ConfBeats.onFeedback({ agentId: agentId || 'agent', id: 'work:' + runId, delta: delta, reason: reason }); } catch (_) {} }
  }
  // render the rate-the-work control into `host` (a span/div). onSettle fires after the verdict flashes.
  function workRateControl(host, agentId, runId, onSettle) {
    const lbl = document.createElement('span'); lbl.className = 'work-rate-label';
    lbl.textContent = '◈ rate ' + name + '’s work — ';
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    host.appendChild(lbl); host.appendChild(btns);
    let done = false;
    function settle(verdict, flash, isDeny) {
      if (done) return; done = true;
      rateWork(agentId, runId, verdict);
      btns.remove();
      const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = flash;
      host.appendChild(tag);
      if (onSettle) setTimeout(onSettle, 700);   // flash the verdict, then let the caller fade the beat
    }
    function mk(label, cls, verdict, flash, isDeny) {
      const b = document.createElement('button'); b.className = 'consent-btn' + (cls ? ' ' + cls : ''); b.textContent = label;
      b.onclick = () => settle(verdict, flash, isDeny); btns.appendChild(b);
    }
    mk('👍 nailed it', '', 'great', '★ +XP', false);
    mk('👌 close', '', 'ok', 'noted', false);
    mk('👎 missed', 'deny', 'miss', 'noted', true);
  }
  // STANDALONE rate-the-work beat (when a run produced NO memory proposal) — its own gold-inset row in the ONE
  // post-run slot. Hero-only, mirroring the curiosity/suggestion beats.
  function workRateBeat(agentId, runId) {
    if (!log) return;
    clearNudge();   // claim the one post-run beat slot, retiring any prior gentle nudge
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('work-rate');
    workRateControl(r.body, agentId, runId, () => vanish(r.d));
    autoscroll();
  }

  /* G2.4 — CLOSE THE RATE-STARVE HOLE. The rate control used to reach the Commander on exactly two
     paths: embedded in a turn-in card, or the standalone beat — and the standalone beat stood down the
     moment memory.proposed fired (proposalRunsSeen). Three ways that starved rating forever:
       1. reflection proposed but the batch fetch came back EMPTY -> no card, no control;
       2. the turn-in deck rendered WITH the embedded control, but the Commander decided every memory
          without rating -> finishBatch vanished the whole card, control and all;
       3. the batch landed on a NON-displayed stream -> a soft notify, no card, no control.
       4. a focused panel (the tutorial's Dialogue on the FIRST command, an intake interview) held the
          post-run slot at the 650ms moment -> every beat stood down with no retry, ever.
     Every hole now funnels into maybeStandaloneRate; armRateFallback (armed per run at run end)
     re-attempts on a 5s cadence until the beat fires or the run is permanently ineligible. */
  // one attempt at the standalone rate beat. Returns:
  //   'fired'   — the beat rendered (this hero run did real work, was unrated, and the moment was free)
  //   'blocked' — TRANSIENT: a run is live / a focused panel (tutorial Dialogue, intake) is up / a
  //               review deck or another rate control is on screen — worth retrying later
  //   'never'   — PERMANENT: rated already, not the hero, or no real work — stop asking
  function maybeStandaloneRate(agentId, runId) {
    if (!log || !runId || workRatedRuns.has(runId)) return 'never';
    if ((agentId || 'agent') !== 'agent') return 'never';               // hero-only, mirroring the post-run slot
    const w = runWork.get(runId);
    if (!w || ((w.toolsOk || 0) < 1 && (w.delivered || 0) < 1)) return 'never';   // real work only — pure chat is never rate-prompted
    if (isBusy() || interview) return 'blocked';                        // never mid-run / mid-awakening
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return 'blocked';
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return 'blocked';
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return 'blocked';   // a focused panel is up (e.g. the tutorial) — retry after it closes
    if (activeTurnin && activeTurnin.node && activeTurnin.node.isConnected) return 'blocked';   // a review deck is up (it carries its own control)
    if (log.querySelector('.cmsg.work-rate') || log.querySelector('.turnin-rate')) return 'blocked';   // a rate control is already live somewhere (one ask at a time)
    workRateBeat(agentId || 'agent', runId);
    return 'fired';
  }
  // the self-retrying fallback: armed once per completed task run at run end, it keeps re-attempting
  // (5s cadence, bounded ~5min) until the beat fires or the run is permanently ineligible — so a
  // tutorial panel, a live turn-in deck, or a busy stream can DELAY the rating but never STARVE it.
  // Its first attempt is DEFERRED: the post-run slot's own inline attempt owns the immediate moment.
  const armedRateRuns = new Set();
  function armRateFallback(agentId, runId, tries) {
    if (!runId || armedRateRuns.has(runId)) return;
    armedRateRuns.add(runId);
    if (armedRateRuns.size > 120) armedRateRuns.delete(armedRateRuns.values().next().value);
    (function attempt(left) {
      setTimeout(() => {
        const r = maybeStandaloneRate(agentId, runId);
        if (r === 'blocked' && left > 0) attempt(left - 1);
      }, 5000);
    })(typeof tries === 'number' ? tries : 60);
  }

  /* ── G2 RETURN RITUAL — the "while you were away" digest + the per-run collect beat. ──
     A SESSION-OPEN beat (fired once by ReturnStore after app open), distinct from the post-run slot:
     it lists the REAL unattended runs the sidecar's run history recorded since the app was last
     attended, each with a review (rate-the-work) affordance. Rating a row IS the collect tap — it
     rides the same direct rateWork path (XP law: only user feedback on real work mints), and clears
     that run's OUTBOX crate via onRated. Gold-inset family; decided rows vanish(); dismissed = the
     whole beat vanishes and never re-fires (the crates stay collectable from the OUTBOX). */
  // an away run has no live runWork stash — seed one from its HONEST history row so the rating's
  // size derives from real recorded turns/spend (turns-1 ≈ tool rounds: each loop turn past the
  // first was a tool round; conservative, never farmable — the row is server-recorded).
  function seedAwayWork(rw) {
    if (!rw || !rw.runId || runWork.has(rw.runId)) return;
    runWork.set(rw.runId, { toolsOk: Math.max(0, (rw.turns | 0) - 1), delivered: 0, cost: Math.max(0, +rw.usd || 0), agentId: rw.agentId || 'agent' });
    if (runWork.size > 60) runWork.delete(runWork.keys().next().value);
  }
  function awayRowLabel(rw) {
    const name = rw.routine ? ('“' + rw.routine + '” ran on its own') : (rw.title || 'an unnamed run');
    const who = (rw.agentId && rw.agentId !== 'agent') ? (' · ' + String(rw.agentId).slice(0, 12)) : '';
    const usd = (+rw.usd > 0) ? (' · $' + (Math.round(rw.usd * 100) / 100).toFixed(2)) : '';
    // G3a seed callout: an unattended run that reuses a Commander-saved seed credits it inline (rw.seed is
    // annotated by ReturnStore via SeedCredit — provenance-matched, never guessed). A credit line, not a beat.
    const seed = rw.seed ? (' · from the seed you saved — “' + rw.seed + '”') : '';
    return '◷ ' + name + who + usd + seed;
  }
  // ONE digest per session (ReturnStore owns the budget + the row data). opts.onRated(runId) clears the crate.
  function awayDigest(rows, opts, _try) {
    if (!log || !rows || !rows.length) return;
    const onRated = (opts && opts.onRated) || (() => {});
    // session-open coordination: never collide with a live run, the awakening/interview, a focused
    // panel, an open turn-in deck, or a live gentle beat (incl. the autopilot welcome-back nudge).
    const blocked = isBusy() || interview || activeTurnin || activeNudge
      || (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning())
      || (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning())
      || (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen());
    if (blocked) {   // defer, bounded — if the moment never frees, the OUTBOX crates still carry the flow
      if ((_try || 0) < 25) setTimeout(() => awayDigest(rows, opts, (_try || 0) + 1), 7000);
      return;
    }
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('away-digest');
    const title = document.createElement('span'); title.className = 'turnin-title';
    title.textContent = '◈ while you were away — ' + rows.length + (rows.length > 1 ? ' runs' : ' run') + ' finished. the work is waiting.';
    r.body.appendChild(title);
    let open = rows.length;
    const settleRow = (item) => { vanish(item); if (--open <= 0) vanish(r.d); };
    for (const rw of rows) {
      const item = document.createElement('div'); item.className = 'turnin-item';
      const text = document.createElement('span'); text.className = 'turnin-text'; text.textContent = awayRowLabel(rw);
      const btns = document.createElement('span'); btns.className = 'consent-btns';
      item.appendChild(text); item.appendChild(btns);
      const b = document.createElement('button'); b.className = 'consent-btn'; b.textContent = 'review';
      b.onclick = () => {   // swap the review affordance for the real rate control, in place
        btns.remove();
        const rate = document.createElement('div'); rate.className = 'turnin-rate';
        item.appendChild(rate);
        seedAwayWork(rw);
        workRateControl(rate, rw.agentId || 'agent', rw.runId, () => { try { onRated(rw.runId); } catch (_) {} settleRow(item); });
        autoscroll();
      };
      btns.appendChild(b);
      r.body.appendChild(item);
    }
    // dismissed = gone (anti-nag law). Uncollected crates remain on the OUTBOX — evidence, not nagging.
    const foot = document.createElement('div'); foot.className = 'turnin-rate';
    const dis = document.createElement('button'); dis.className = 'consent-btn deny'; dis.textContent = 'dismiss';
    dis.onclick = () => vanish(r.d);
    foot.appendChild(dis);
    r.body.appendChild(foot);
    autoscroll();
  }
  // the OUTBOX collect beat: clicking the chute (or a stacked crate) reviews ONE pending away run.
  // Same gold-inset family; rating clears the crate (onRated) and the beat vanishes.
  function awayReview(rw, opts) {
    if (!log || !rw || !rw.runId) return;
    const onRated = (opts && opts.onRated) || (() => {});
    if (workRatedRuns.has(rw.runId)) { try { onRated(rw.runId); } catch (_) {} return; }   // already judged — just clear the crate
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('work-rate');
    const title = document.createElement('span'); title.className = 'turnin-title';
    title.textContent = '◈ from the OUTBOX — ' + awayRowLabel(rw);
    r.body.appendChild(title);
    const rate = document.createElement('div'); rate.className = 'turnin-rate';
    r.body.appendChild(rate);
    seedAwayWork(rw);
    workRateControl(rate, rw.agentId || 'agent', rw.runId, () => { try { onRated(rw.runId); } catch (_) {} vanish(r.d); });
    autoscroll();
  }

  // Cortex (M-mem.5b) — THE TURN-IN BEAT. After a run, reflection proposes durable memories; the Commander
  // decides Keep / Edit / Discard. Keep/Edit commit a real memory (the click IS the consent, §5.6); every
  // verdict feeds the agent's confidence. This is the gamified formation loop — the agent learns, you approve.
  function proposalCard(batch, ws) {
    if (!batch || !batch.proposals || !batch.proposals.length) return;
    clearNudge();   // ONE post-run beat at a time: the turn-in owns the moment, so retire any curiosity nudge that beat it here
    if (activeTurnin && (!activeTurnin.node || !activeTurnin.node.isConnected)) activeTurnin = null;
    if (activeTurnin) {
      turninQueue.push(batch);
      updateTurninQueueNote();
      autoscroll();
      return;
    }
    renderTurninBatch(batch);
  }

  function updateTurninQueueNote() {
    if (!activeTurnin || !activeTurnin.queueNote) return;
    const waiting = turninQueue.length;
    activeTurnin.queueNote.textContent = waiting ? waiting + ' more review ' + (waiting > 1 ? 'batches' : 'batch') + ' waiting' : '';
    activeTurnin.queueNote.hidden = !waiting;
  }

  function showNextTurnin() {
    if (activeTurnin) return;
    const next = turninQueue.shift();
    if (next) renderTurninBatch(next);
  }

  function renderTurninBatch(batch) {
    const head = row('agent'); head.d.classList.add('tool'); head.d.classList.add('turnin');
    const n = batch.proposals.length;
    const title = document.createElement('span'); title.className = 'turnin-title';
    const queueNote = document.createElement('span'); queueNote.className = 'turnin-queue'; queueNote.hidden = true;
    const slot = document.createElement('span'); slot.className = 'turnin-slot';
    head.body.appendChild(title);
    head.body.appendChild(queueNote);
    head.body.appendChild(slot);
    // RATE THE WORK first (the primary leveling beat), THEN curate memories below — two honest judgments, one card.
    if (batch.runId && !workRatedRuns.has(batch.runId)) {
      const rate = document.createElement('div'); rate.className = 'turnin-rate';
      head.body.insertBefore(rate, slot);
      workRateControl(rate, batch.agentId || 'agent', batch.runId, () => vanish(rate));
    }

    const state = { node: head.d, queueNote, index: 0 };
    activeTurnin = state;
    updateTurninQueueNote();

    function finishBatch() {
      activeTurnin = null;
      vanish(head.d, () => {
        showNextTurnin();
        // G2.4 starve hole 2: the deck (and its embedded control) just vanished — if the Commander
        // curated the memories but never rated the WORK, the standalone beat picks the rating up.
        if (batch.runId) maybeStandaloneRate(batch.agentId || 'agent', batch.runId);
      });
    }
    function updateTitle() {
      title.textContent = '◈ ' + name + ' picked up ' + n + (n > 1 ? ' things' : ' thing') + ' worth remembering — review ' + (state.index + 1) + ' of ' + n;
    }
    function renderCurrent() {
      const prop = batch.proposals[state.index];
      if (!prop) { finishBatch(); return; }
      updateTitle();
      slot.innerHTML = '';
      const item = document.createElement('div'); item.className = 'turnin-item';
      const kind = document.createElement('span'); kind.className = 'turnin-kind'; kind.textContent = KIND_TAG[prop.kind] || 'NOTE';
      const text = document.createElement('span'); text.className = 'turnin-text'; text.textContent = prop.content;
      const btns = document.createElement('span'); btns.className = 'consent-btns';
      item.appendChild(kind); item.appendChild(text); item.appendChild(btns);
      slot.appendChild(item);

      let decided = false;
      function settle(label, isDeny) {
        decided = true; btns.remove();
        const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = label;
        item.appendChild(tag);
        setTimeout(() => vanish(item, () => {
          state.index += 1;
          if (state.index >= n) finishBatch();
          else { renderCurrent(); autoscroll(); }
        }), 600);   // flash the verdict, then advance the deck instead of stacking more cards
      }
      async function submit(verdict, content, label, isDeny) {
        if (decided) return; decided = true;
        const r = await Harness.memoryTurnin({ agentId: batch.agentId, runId: batch.runId, id: prop.id, verdict, content });
        if (r && r.ok) settle(label, isDeny);
        else { decided = false; if (typeof StationUI !== 'undefined') StationUI.notify('could not save that ' + (prop.kind === 'skill' ? 'skill' : 'memory') + ' - try again', 'warn'); }
      }
      function mkBtn(label, cls, onClick) {
        const b = document.createElement('button'); b.className = 'consent-btn' + (cls ? ' ' + cls : ''); b.textContent = label; b.onclick = onClick; btns.appendChild(b); return b;
      }
      function renderChoices() {
        btns.innerHTML = '';
        mkBtn(prop.kind === 'skill' ? 'Save skill' : 'Keep', '', () => submit('keep', null, prop.kind === 'skill' ? 'saved as skill' : 'kept in memory', false));
        mkBtn('Edit', '', enterEdit);
        mkBtn('Discard', 'deny', () => submit('discard', null, '✕ discarded', true));
      }
      // inline edit: swap the belief into an input; Save commits the edited text (verdict 'edit'), Cancel restores.
      function enterEdit() {
        if (decided) return;
        const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'turnin-edit'; inp.value = prop.content;
        item.replaceChild(inp, text); inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) {}
        const commit = () => { const v = inp.value.trim(); if (!v) { inp.focus(); return; } text.textContent = v; item.replaceChild(text, inp); submit('edit', v, prop.kind === 'skill' ? 'saved skill (edited)' : 'saved (edited)', false); };
        const cancel = () => { item.replaceChild(text, inp); renderChoices(); };
        btns.innerHTML = '';
        mkBtn('Save', '', commit);
        mkBtn('Cancel', '', cancel);
        inp.onkeydown = e => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') cancel(); };
      }
      renderChoices();
    }
    renderCurrent();
    autoscroll();   // the inline card IS the prompt — no extra toast (it just doubled the noise the card already shows)
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
        // G2.4 starve hole 1: memory.proposed fired (so the post-run slot stood down for the turn-in)
        // but the batch fetch came back empty — no card would ever carry the rate control. Rate now.
        if (!proposals.length) { maybeStandaloneRate(agentId, runId); return; }
        const batch = { runId, agentId, proposals };
        // route to the ORIGIN stream (the one whose run proposed these) — many streams share agentId 'agent',
        // so gating on agentId can drop the card into the wrong COMMS after a mid-window switch.
        let originWs = null;
        if (typeof Workstreams !== 'undefined' && Workstreams.all) { try { originWs = Workstreams.all().find(w => (w.runIds || []).indexOf(runId) >= 0) || null; } catch (_) {} }
        const onActive = originWs ? (activeWs && activeWs.id === originWs.id) : (activeWs && (activeWs.agentId || 'agent') === agentId);
        if (onActive) proposalCard(batch, activeWs);
        else {
          if (typeof StationUI !== 'undefined') StationUI.notify('an agent has ' + proposals.length + ' memories to review', 'gold');
          // G2.4 starve hole 3: the batch landed on a NON-displayed stream — a soft notify carries no
          // rate control. The hero's work still deserves its rating in the visible COMMS.
          maybeStandaloneRate(agentId, runId);
        }
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
  // retire the live curiosity nudge (its prompt row AND its choice chips) — called when it's answered or when a
  // turn-in beat supersedes it. Both halves fade out together so no orphan chip row is left behind.
  function clearNudge() {
    if (!activeNudge) return;
    const a = activeNudge; activeNudge = null;
    if (a.choiceRow) activeChoiceRows.delete(a.choiceRow);
    vanish(a.choiceRow); vanish(a.row);
  }
  function curiosityNudge(dim) {
    if (!log) return;
    clearNudge();   // one gentle beat at a time: retire any prior unanswered nudge before this one (no cross-run stacking)
    const r = row('agent'); r.d.classList.add('nudge');   // a quiet aside, NOT the lit headline (.reply) — it was reading as a 2nd reply
    r.body.textContent = '✦ one curious thing — i still don’t know your ' + dimLabel(dim).toLowerCase() + '. want to tell me? it sharpens how every agent here works for you.';
    autoscroll();
    const choiceRow = choices([{ label: 'sure — ask me', value: 'yes' }, { label: 'not now', value: 'no', skip: true }], item => {
      activeNudge = null;   // answered → release the post-run beat slot (the choice row removes itself)
      if (item.value === 'yes' && typeof Intake !== 'undefined' && typeof Dossier !== 'undefined') {
        const skip = Dossier.DIM_KEYS.filter(k => k !== dim);   // ask ONLY this dimension (plan() returns just its question)
        Intake.start({
          skip: skip,
          onCommit: b => { if (typeof DossierStore !== 'undefined') DossierStore.upsert(b.dim, { text: b.text, source: 'curiosity' }); if (typeof CuriosityStore !== 'undefined' && CuriosityStore.markAnswered) CuriosityStore.markAnswered(b.dim); },
          onDone: () => { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('commander'); }
        });
      } else if (typeof CuriosityStore !== 'undefined') {
        CuriosityStore.markDismissed(dim);   // waved off → never raise this dimension again
      }
    });
    activeNudge = { row: r.d, choiceRow: choiceRow, dim: dim };   // track both halves so a turn-in can retire the whole nudge
  }
  // a reusable GENTLE post-run beat (used by the ongoing-suggestion engine, suggeststore.js) — the same quiet
  // register as the curiosity nudge: a .nudge aside, never the lit .reply headline. text = the line; options =
  // [{label,value,skip}]; onPick(item) fires on a choice (the choice row removes itself on pick).
  function nudge(text, options, onPick) {
    if (!log) return null;
    clearNudge();   // one gentle beat at a time: retire any prior unanswered nudge before this one (no cross-run stacking)
    const r = row('agent'); r.d.classList.add('nudge');
    r.body.textContent = String(text == null ? '' : text);
    autoscroll();
    const choiceRow = choices(options || [], item => { activeNudge = null; try { if (onPick) onPick(item); } catch (_) {} });
    activeNudge = { row: r.d, choiceRow: choiceRow, dim: null };   // share the curiosity-nudge lifecycle so a turn-in's clearNudge() retires a suggestion beat too (keeps "one beat at a time")
    return { row: r.d, choiceRow: choiceRow };
  }
  function wireCuriosity() {
    if (curiosityWired || typeof U === 'undefined' || !U.bus) return;
    curiosityWired = true;
    U.bus.on('agent.run.end', p => {
      if (!p || p.reason !== 'done') return;   // only after a clean, successful run — never nag after a stop/limit/error
      if ((p.agentId || 'agent') !== 'agent') return;   // only the HERO's runs drive the hero-dossier beat — a summoned worker's run must not fire a curiosity/suggestion/seed nudge
      const runId = p.runId || p.id;
      setTimeout(() => {
        // G2.4: arm the self-retrying rate fallback FIRST, before any stand-down guard — a focused
        // tutorial panel / busy stream / open deck may block THIS moment, but the rating for a run
        // that did real work must eventually fire (permanent ineligibility stops it inside).
        if (runId) armRateFallback(p.agentId || 'agent', runId);
        if (isBusy() || interview) return;     // another run started, or we're already mid-interview/awakening
        if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return;
        if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return;
        if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return;   // a focused panel is up (First Pitch graduation / awakening / tutorial) — never slot a gentle nudge behind it
        // ONE post-run beat per run: if this run produced a memory turn-in (or a card is still open in the
        // feed), let the turn-in own the moment — don't stack a curiosity nudge under it (the visible
        // dogpile). Standing down can no longer STARVE the rating: the armRateFallback armed above (plus
        // the wireProposals empty/off-stream hooks and the finishBatch hand-off) keeps re-attempting the
        // standalone beat until it fires or the run is permanently ineligible.
        if (runId && proposalRunsSeen.has(runId)) return;
        // (scoped to REAL turn-in decks: the away-digest reuses .turnin-item for styling, but a
        // session-open digest sitting in the feed must not suppress a fresh run's rate beat — G2.4)
        if (log && log.querySelector('.cmsg.turnin:not(.away-digest) .turnin-item')) return;
        // RATE THE WORK (the primary leveling beat): if this run actually did real work and isn't rated yet,
        // it takes the one post-run slot (the same attempt the armed fallback retries — real-work-gated, so
        // a pure chat reply is never rate-prompted; 'blocked'/'never' fall through to the gentler beats).
        if (runId && maybeStandaloneRate(p.agentId || 'agent', runId) === 'fired') return;
        // FIRE ON SALIENCE, not after every run: a basic conversational turn (not a task) earns NO proactive beat —
        // the station only reaches for a suggestion / seed / get-to-know-you question after it did real WORK. This
        // mirrors the server's reflection gate (isTask) so chatter never triggers an ask. Fail-open if meta is unknown.
        const meta = runId ? runMeta(runId) : null;
        if (meta && !meta.isTask) return;
        // ONGOING SUGGESTION (Slice 3): if the station has learned something new and an idea is due, it takes this
        // ONE post-run beat — gently — and curiosity stands down for the run (the agent never stacks an idea AND a
        // question on the same task). Shares this slot's guards (busy/interview/onboarding/intake/turn-in) for free.
        if (typeof SuggestStore !== 'undefined' && SuggestStore.willSuggest && SuggestStore.fire && SuggestStore.willSuggest()) { SuggestStore.fire(); return; }
        // SELF-GROWING SEED (Slice 5): if a recurring pattern is ripe, the agent offers to author it as a one-tap
        // seed — takes this one beat (after a suggestion, before curiosity) so it never stacks two asks on a task.
        if (typeof SeedStore !== 'undefined' && SeedStore.willPropose && SeedStore.propose && SeedStore.willPropose()) { SeedStore.propose(); return; }
        if (typeof CuriosityStore === 'undefined') return;
        const dim = CuriosityStore.consider();
        if (!dim) return;
        CuriosityStore.markShown(dim);         // spend the session nudge AND durably tally this dim's ask (ignored asks stop it for good)
        curiosityNudge(dim);
      }, 650);   // let the reply finish rendering before the nudge slots in below it
    });
  }
  // IDLE-DRIVEN curiosity (the autopilot EARN-CONTEXT branch, autonomy Slice A): the SAME gentle get-to-know-you
  // ask the post-run slot makes, but triggered when the Commander goes IDLE with autonomy enabled — so turning the
  // dial up makes the station proactively LEARN about them between tasks. Shares the curiosity anti-nag (the
  // per-session CAP in CuriosityStore + the single activeNudge), so it can never stack with, or double-ask
  // alongside, the post-run nudge. Defined AFTER wireCuriosity so the post-run slot stays the first occurrence of
  // the suggestion→seed→curiosity precedence (beat-coordination.test locks that ordering by position). Returns
  // true iff a nudge was actually shown (the bool just aids testing).
  function offerCuriosity() {
    if (!log) return false;
    if (isBusy() || interview) return false;                                                       // mid-run / mid-interview
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return false;
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return false;
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return false;     // a focused panel is up
    if (activeNudge) return false;                                                                  // a gentle beat is already live — one at a time
    if (typeof CuriosityStore === 'undefined') return false;
    const dim = CuriosityStore.consider();                                                          // null once the session cap is spent / nothing live to ask
    if (!dim) return false;
    CuriosityStore.markShown(dim);                                                                  // spend the session nudge + durably tally the ask (shared with the post-run path)
    curiosityNudge(dim);
    return true;
  }

  function renderHistory() {
    const h = activeWs ? activeWs.history : [];
    for (const m of h) {
      if (m.role === 'user') { addUser(m.content); continue; }
      if (!(m.content || '').trim()) continue;   // skip a turn that produced no prose (tool-only / stopped run)
      const r = row('agent', { stamp: true });   // past turns render as plain GROUPED messages; only the LIVE reply is the lit headline
      if (m.error) r.d.classList.add('err');
      renderProse(r.body, m.content);   // same linkify path as live tokens, so replayed history matches
    }
  }

  // SWITCH-SURVIVAL: re-render whatever in-flight run we left on the now-displayed stream — its streamed
  // tool lines, its partial reply, and any pending approval — from the Channels snapshot. For an idle stream
  // the snapshot is empty and this is a no-op. (Live token re-binding for a stream switched-to MID-run lands
  // with the frontend-hud change that lifts the "can't switch while busy" guard — see the GATE handoff note.)
  function replayChannel() {
    activeLiveRow = null;   // log was just cleared by load(); drop any stale live controller before re-rendering
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

  // A streaming turn's PROSE controller. The agent's text streams into an open paragraph row with a blinking
  // caret; when an action happens (tool call/result, deliverable, approval) the caller breaks the current
  // paragraph so the action row lands BELOW it, and the next tokens open a fresh paragraph under the action —
  // so a turn reads top-to-bottom as "said this → did that → said this", classic-harness style.
  function streamingAgent() {
    let seg = null, caret = null, raw = '';   // seg: the currently-open agent row; raw: its accumulated prose (so URLs can be linkified as they complete)
    function open() {
      endToolRail();   // a fresh prose paragraph opening below a rail closes it, so the next tool call starts a NEW rail under this prose (keeps chronological "said → did → said → did")
      seg = row('agent', { stamp: true }); raw = '';
      caret = document.createElement('span'); caret.className = 'caret'; caret.textContent = '▮';
      seg.d.appendChild(caret);   // caret is a sibling of .body, so re-rendering .body's content never disturbs it
    }
    function closeSeg() {   // drop the caret, discard an empty stub, and arm the next token to start fresh
      if (caret) { caret.remove(); caret = null; }
      if (seg && !seg.body.textContent.trim()) seg.d.remove();
      seg = null; raw = '';
    }
    return {
      append(t) { if (!t) return; if (!seg) open(); raw += t; renderProse(seg.body, raw); autoscroll(); },
      breakSeg() { closeSeg(); },   // an inline action is about to render below — end this paragraph
      done() { closeSeg(); },
      // m = the plain-language headline to LEAD with; rawDetail (optional) = the original technical text, kept
      // accessible as a dim sub-line + a title tooltip so debugging info isn't lost, just de-emphasized.
      error(m, rawDetail) {
        if (!seg) open();
        seg.d.classList.add('err');
        raw += (raw ? '\n' : '') + '⚠ ' + m; renderProse(seg.body, raw);
        if (rawDetail && String(rawDetail).trim() && String(rawDetail).trim() !== String(m).trim()) {
          const sub = document.createElement('span'); sub.className = 'err-detail dim';
          sub.textContent = String(rawDetail).trim();
          sub.title = String(rawDetail).trim();
          seg.d.appendChild(sub);
        }
        if (caret) { caret.remove(); caret = null; } seg = null; raw = '';
      }
    };
  }
  // close the live paragraph (if any) so the action about to render lands BELOW the prose, in order.
  // Also closes any open tool-chip rail — prose resuming means the next tool call starts a fresh rail
  // below the new paragraph, so the feed reads "said → did (rail) → said → did (rail)" in order.
  function breakLive() { if (activeLiveRow && activeLiveRow.breakSeg) activeLiveRow.breakSeg(); endToolRail(); }

  // task-vs-chat classification lives in app/classify.js (pure + unit-tested); see Classify.isTaskDirective.

  // ── in-app WORK-ITEM lifecycle (WIRING_AUDIT P1, slice 1): make the directive the Commander sends RIDE A
  //    BELT the same way an admitted Telegram message does. workitem.placed / queue.status / workitem.delivered
  //    have NO NDJSON twin (harness.js streams only agent.* / token / tool / deliverable), so emitting them
  //    locally on U.bus animates the inbound box + the outbound product crate and folds INTAKE/THRU/DWELL/QUEUE
  //    — with zero double-render (U.bus is the only consumer surface; nothing re-broadcasts these back).
  const wiQDepth = new Map();   // agentId -> directive runs in flight (the honest QUEUE gauge for the in-app loop)
  let wiSeq = 0;
  function wiBump(aid, d) { const n = Math.max(0, (wiQDepth.get(aid) || 0) + d); wiQDepth.set(aid, n); return n; }
  function wiEmit(name, payload) { try { if (typeof U !== 'undefined' && U.bus) U.bus.emit(name, payload); } catch (_) {} }

  /* ---------- TURN CONTROLS (harness-standard): interrupt + type-ahead ---------- */
  // INTERRUPT — a gentle, per-stream stop, distinct from safety.js's Alt+H "halt EVERYTHING + alarm". It cancels
  // only the DISPLAYED stream's in-flight run; the plumbing already exists (each stream owns an AbortController
  // here + a server runId) so this just exposes a ⏹ button / Esc for it. Flag the stream interrupted so send()'s
  // catch keeps what already streamed instead of logging an error, and drop that stream's type-ahead queue — a
  // deliberate stop means "I'm taking over", not "now run my backlog".
  function stopActive() {
    if (!activeWs || !isBusy()) return;
    const id = activeWs.id;
    interrupted.add(id);
    queued.delete(id);
    if (typeof Channels !== 'undefined' && Channels.clearPending) Channels.clearPending(id);   // a pending approval is moot once stopped
    const ac = aborters.get(id); if (ac) { try { ac.abort(); } catch (_) {} }   // aborts the fetch → reader throws → send()'s catch
    const rid = (typeof Channels !== 'undefined') ? Channels.runIdOf(id) : null;
    if (rid && typeof Harness !== 'undefined' && Harness.cancel) Harness.cancel(rid);   // server-side kill (belt-and-suspenders)
    status('stopping…'); updateControls();
    if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
  }

  // TYPE-AHEAD — a message typed while the stream is busy is QUEUED, not dropped, and auto-sent in order as the
  // stream frees. (A concurrent run on a DIFFERENT stream is still one switch away — this is the same-stream
  // follow-up case.) The pills above the input show what's pending; ✕ cancels one before it sends.
  function enqueue(text) {
    if (!activeWs) return;
    const id = activeWs.id;
    const arr = queued.get(id) || []; arr.push(text); queued.set(id, arr);
    renderQueued();
    if (typeof SFX !== 'undefined' && SFX.type) SFX.type();
  }
  function renderQueued() {
    const strip = el('chat-queued'); if (!strip) return;
    const arr = (activeWs && queued.get(activeWs.id)) || [];
    strip.innerHTML = '';
    arr.forEach((t, i) => {
      const pill = document.createElement('span'); pill.className = 'queued-pill'; pill.title = t;
      const label = document.createElement('span'); label.className = 'queued-text'; label.textContent = t;
      const x = document.createElement('button'); x.className = 'queued-x'; x.type = 'button'; x.textContent = '✕';
      x.setAttribute('aria-label', 'Cancel queued message');
      x.onclick = () => { const a = queued.get(activeWs.id) || []; a.splice(i, 1); a.length ? queued.set(activeWs.id, a) : queued.delete(activeWs.id); renderQueued(); };
      pill.appendChild(document.createTextNode('⤷ ')); pill.appendChild(label); pill.appendChild(x);
      strip.appendChild(pill);
    });
  }
  // a stream just freed (or was switched back to while idle) — send its next queued follow-up. Guarded to the
  // DISPLAYED stream so send()'s DOM writes always target the visible log; a backgrounded queue waits for return.
  function flushQueued(id) {
    if (!id || !activeWs || activeWs.id !== id) return;
    if (isBusy()) return;
    const arr = queued.get(id); if (!arr || !arr.length) return;
    const next = arr.shift(); arr.length ? queued.set(id, arr) : queued.delete(id);
    renderQueued();
    send(next);
  }
  // RETRY — re-run the last turn after an outage / connection drop / in-band error. Discard the trailing failed
  // reply, re-render the thread (dropping the ⚠ row), then resend the last user message WITHOUT echoing it again.
  function retryLast() {
    if (!activeWs || isBusy()) return;
    const h = activeWs.history;
    if (h.length && h[h.length - 1].role === 'assistant' && h[h.length - 1].error) h.pop();   // drop the failed reply
    let text = null;
    for (let i = h.length - 1; i >= 0; i--) { if (h[i].role === 'user') { text = h[i].content; break; } }
    if (text == null) return;
    load(activeWs);                 // re-render the thread cleanly (the popped ⚠ row is gone)
    send(text, { retry: true });    // re-run it; the user turn is already present, so don't echo it
  }
  // a one-tap recovery chip dropped under a failed turn (reuses the suggestion-pill row, which self-removes on
  // tap). CONTEXT-AWARE on the classified verdict: a retryable fault offers "↻ Try again"; an auth/billing
  // fault points at SETTINGS (fix the key) instead of a doomed retry; a capability denial points at SKILLS;
  // a non-retryable, non-actionable fault offers nothing (no blind retry). Falls back to a plain retry chip
  // when called without a verdict (legacy callers / unknowns), preserving the old behavior + value:'retry'.
  function offerRetry(verdict) {
    if (!log) return;
    if (!verdict) { choices([{ label: '↻ Try again', value: 'retry' }], () => retryLast()); return; }
    if (verdict.action === 'settings') {
      choices([{ label: '⚙ Open Settings', value: 'settings' }], () => { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('settings'); });
      return;
    }
    if (verdict.action === 'skills') {
      choices([{ label: '✦ Open SKILLS', value: 'skills' }], () => { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('skills'); });
      return;
    }
    if (verdict.retryable) { choices([{ label: '↻ Try again', value: 'retry' }], () => retryLast()); return; }
    // non-retryable with no destination: leave no chip rather than inviting a doomed re-run.
  }

  // show the Stop control + the queued pills for whatever stream is on screen. Called from syncStatus (covers
  // switch + turn-end) and at send() start (status goes 'thinking…' without a syncStatus).
  function updateControls() {
    const stop = el('chat-stop'); if (stop) stop.hidden = !isBusy();
    renderQueued();
  }

  /* ---------- SLASH COMMANDS: a "/command" palette over the input (harness-standard) ----------
     A leading "/" opens a filterable menu of built-in turn-control commands PLUS the whole recipe
     library — so the missions that live in the dock are one keystroke away in chat too. Selecting a
     recipe drops its directive into the input (first {blank} pre-selected) to fill + send; a built-in
     runs immediately. ↑/↓ move, Enter/Tab run, Esc closes. */
  let slashItems = [], slashSel = 0;
  function isSlashOpen() { const p = el('chat-slash'); return !!(p && !p.hidden); }
  function copyLastReply() {
    if (!activeWs) return;
    const h = activeWs.history;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].role === 'assistant' && !h[i].error && (h[i].content || '').trim()) {
        copyText(h[i].content).then(ok => { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(ok ? 'copied the last reply' : 'copy failed', ok ? 'good' : 'warn'); });
        return;
      }
    }
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('no reply to copy yet', '');
  }
  function showHelp() { localLine('Commands — /retry · /stop · /copy · /help, and /<recipe> to drop a recipe into the box. Type “/” to browse.'); }
  // drop a recipe's directive into the input: apply each OPTIONAL param's default, but leave REQUIRED blanks
  // visible as {tokens} so the Commander can see what to fill — and pre-select the first one to type over.
  function insertRecipe(r) {
    if (!input) return;
    let directive = (r && r.task) || (r && r.name) || '';
    for (const p of (r && r.params) || []) {
      if (p && p.key && p.default != null && p.default !== '') directive = directive.split('{' + p.key + '}').join(p.default);
    }
    input.value = directive; input.focus();
    const m = /\{[^}]+\}/.exec(directive);   // select the first remaining blank to type over (else cursor at end)
    try { if (m) input.setSelectionRange(m.index, m.index + m[0].length); else input.setSelectionRange(directive.length, directive.length); } catch (_) {}
  }
  function buildCommands() {
    const cmds = [
      { name: 'retry', desc: 're-run the last turn', run: retryLast },
      { name: 'stop', desc: 'interrupt the running turn', run: stopActive },
      { name: 'copy', desc: 'copy the agent’s last reply', run: copyLastReply },
      { name: 'help', desc: 'list these commands', run: showHelp }
    ];
    if (typeof Recipes !== 'undefined' && Recipes.list) {
      for (const r of Recipes.list()) cmds.push({ name: r.id, desc: (r.emoji ? r.emoji + ' ' : '') + (r.name || r.id) + (r.tagline ? ' — ' + r.tagline : ''), run: () => insertRecipe(r) });
    }
    return cmds;
  }
  function matchCommands(q) {
    q = (q || '').toLowerCase().trim();
    const all = buildCommands();
    if (!q) return all.slice(0, 8);
    const pref = [], sub = [];
    for (const c of all) {
      const n = c.name.toLowerCase();
      if (n.indexOf(q) === 0) pref.push(c);
      else if (n.indexOf(q) >= 0 || (c.desc || '').toLowerCase().indexOf(q) >= 0) sub.push(c);
    }
    return pref.concat(sub).slice(0, 8);
  }
  function openSlash(query) {
    const pop = el('chat-slash'); if (!pop) return;
    slashItems = matchCommands(query);
    if (!slashItems.length) { closeSlash(); return; }
    if (slashSel >= slashItems.length) slashSel = 0;
    renderSlash(); pop.hidden = false;
  }
  function closeSlash() { const pop = el('chat-slash'); if (pop) pop.hidden = true; slashItems = []; slashSel = 0; }
  function moveSlash(d) { if (!slashItems.length) return; slashSel = (slashSel + d + slashItems.length) % slashItems.length; renderSlash(); }
  function renderSlash() {
    const pop = el('chat-slash'); if (!pop) return;
    pop.innerHTML = '';
    const head = document.createElement('div'); head.className = 'slash-head'; head.textContent = '/ COMMANDS';
    pop.appendChild(head);
    slashItems.forEach((c, i) => {
      const it = document.createElement('div'); it.className = 'slash-item' + (i === slashSel ? ' sel' : ''); it.setAttribute('role', 'option');
      const nm = document.createElement('span'); nm.className = 'slash-name'; nm.textContent = '/' + c.name;
      const ds = document.createElement('span'); ds.className = 'slash-desc'; ds.textContent = c.desc || '';
      it.appendChild(nm); it.appendChild(ds);
      it.onmouseenter = () => { slashSel = i; renderSlash(); };
      it.onmousedown = e => { e.preventDefault(); runSlash(c); };   // mousedown keeps input focus
      pop.appendChild(it);
    });
  }
  function runSlash(item) {
    if (!item) { closeSlash(); return; }
    input.value = ''; closeSlash();   // consume the "/query"; a recipe's run() then refills the input
    if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
    try { item.run(); } catch (_) {}
  }

  async function send(text, opts) {
    const retry = !!(opts && opts.retry);   // RETRY re-runs the last user message (already in the thread) — don't echo it again
    if (interview) { clearChoices(); interview(text); return; }   // THE AWAKENING owns the input: typed answers retire any stale chip row
    const ws = activeWs;   // CAPTURE the origin stream now — a mid-run switch must not cross-post its cost/files
    if (!ws) return;
    if (Channels.isBusy(ws.id)) return;   // one run per stream — but OTHER streams may be running concurrently
    // FIRST-TURN TITLE UPGRADE: is THIS the stream's first user turn (still on its machine-derived placeholder)?
    // Captured BEFORE we push this message, so after the run lands we can replace the truncated first-sentence
    // title with a model-written summary. General is excluded — it stays the untitled chat home.
    const firstTurn = (typeof Workstreams !== 'undefined') && ws.id !== Workstreams.generalId()
      && !ws.history.some(m => m && m.role === 'user');
    Channels.begin(ws.id, Date.now());   // stamp the run start so the COMMS elapsed timer counts real wall-clock
    // P1: drop this directive's INTAKE ore box on the belt + start its DWELL clock (mirrors the Telegram
    // admit shape). queueId === agentId so the box routes to the hero / bound desk in world.js.
    const wiAid = ws.agentId || 'agent';
    const wiId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('wi-' + Date.now() + '-' + (++wiSeq));
    const wiPlacedTs = Date.now();
    { const depth = wiBump(wiAid, 1);
      wiEmit('workitem.placed', { workitemId: wiId, queueId: wiAid, agentId: wiAid, kind: 'directive', preview: String(text || '').replace(/\s+/g, ' ').slice(0, 40), queueDepth: depth, ts: wiPlacedTs });
      wiEmit('queue.status', { queueId: wiAid, depth: depth, maxCapacity: 64, nextAdvanceAt: 0 }); }
    stick = true;   // sending a message means you want to watch the exchange — re-follow the bottom
    if (!retry) { addUser(text); ws.history.push({ role: 'user', content: text }); }   // on RETRY the user turn is already in the thread + on screen
    // name an untitled stream from its first real message (no-op on General / already-titled)
    if (typeof Workstreams !== 'undefined' && Workstreams.autoTitle(ws.id, text)) {
      if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
    }

    const isTask = Classify.isTaskDirective(text);
    // fold the interest tag of a real task into the local user-affinity profile (the signal classify.js
    // already computes here and otherwise discards). Captures only a derived {code|research|general}
    // count — never the message text. Gated on the user's learning flag inside the store.
    // observe ONLY a genuine new directive — never on RETRY (re-running the same text must not double-count the
    // shape, which would inflate the recurrence signal and let a true one-off wrongly fire the memory beat).
    if (!retry && isTask && typeof ProfileStore !== 'undefined') ProfileStore.observeMessage(text);
    if (!retry && isTask && typeof MintStore !== 'undefined') MintStore.observe(text);   // notice recurring jobs → propose minting them as one-tap missions
    // SALIENCE (decision 3): has this task SHAPE recurred? Read AFTER observe so it counts this run (the read itself is
    // safe on retry — it doesn't mutate the count). Passed to the run so the server fires the memory turn-in on
    // recurring work even when a terse exchange otherwise wouldn't, while a basic one-off is left to reflect()'s floor.
    const recurring = !!(isTask && typeof MintStore !== 'undefined' && MintStore.recurringNow && MintStore.recurringNow(text));
    // VOICE: the speaker toggle (🔊) controls whether the agent SPEAKS its reply (and in the short,
    // spoken style — voiceModeRules appended below). It does NOT control the desk trip: the walk is driven
    // by REAL tool use (walkToDesk, below), so the speaker setting can't suppress it. When voice is on, a
    // task's result is also spoken — it's just no longer answered "on the spot" in place of the desk trip.
    // VOICE OWNERSHIP: ONLY the orchestrator (the hero, id 'agent') speaks aloud. A summoned/secondary agent
    // exists for the orchestrator to DELEGATE to — the Commander talks to the orchestrator, not to a crowd of
    // agents — so a summoned agent's replies are never voiced (and never get the short spoken-style prompt).
    const isOrchestrator = !ws.agentId || ws.agentId === 'agent';
    const willSpeak = isOrchestrator && typeof Voice !== 'undefined' && Voice.isOn && Voice.isOn();
    // REACTIVE DESK TRIP — the honest signal. We no longer pre-commit the walk on the classifier's GUESS:
    // every turn the agent first turns to face the Commander (listen), and it only gets up and walks to its
    // workstation the instant it ACTUALLY reaches for a tool (web / files / terminal) — see walkToDesk(),
    // fired from onToolCall / onPermission below. So a basic question, an opinion, or a one-word answer the
    // agent handles from its own knowledge NEVER runs to the PC; the desk trip now means "real tool-work is
    // happening", not "the Commander typed something". isTask still gates TOOL AVAILABILITY (so a genuine
    // task is never left tool-less) — it just no longer forces the walk. Voice/speaker state can't touch it.
    const turnAgentId = ws.agentId || 'agent';
    let walkedToDesk = false;
    function walkToDesk() {   // idempotent: the FIRST real tool action of the turn sends THIS agent to its station
      if (walkedToDesk) return; walkedToDesk = true;
      if (World.setActivityFor) World.setActivityFor(turnAgentId, 'task'); else World.setActivity('task');
      if (typeof Channels !== 'undefined' && Channels.setStatus) Channels.setStatus(ws.id, 'working…');
      if (isActiveWs(ws)) syncStatus();
    }
    // turn to face the Commander and listen (no camera yank); a spoken CHAT also softly frames the agent.
    if (World.setActivityFor) World.setActivityFor(turnAgentId, 'talk'); else World.setActivity('talk');
    if (!isTask && willSpeak && World.focusAgent) World.focusAgent({ soft: true });
    status('thinking…');
    ensureElapsedTimer();   // start the live wall-clock the instant the turn begins (before the first token)
    if (isActiveWs(ws)) startPresence(ws);   // COMMS-PREMIUM: pin the live working-presence card at the transcript bottom
    updateControls();       // reveal the ⏹ Stop control for this run
    // for a task the agent works at the computer (lit screen) and the result streams to this panel;
    // for talk it speaks the reply as a bubble in the room. The voice rule is appended LAST so it
    // wins on format; it's never baked into the saved prompt.
    const sys = system
      + (isTask ? ' If this needs real work — searching the web, reading or writing files, running a tool — do it and report the result clearly. If you can answer it directly from what you already know, just answer; don\'t reach for tools you don\'t need.' : '')
      + (willSpeak ? voiceModeRules() : '');

    const before = Object.assign({}, Harness.totals());   // COPY (totals is a mutated singleton) so the per-stream diff is real
    const ac = new AbortController();
    aborters.set(ws.id, ac);
    const callNames = {};   // callId -> tool name (the frozen agent.tool_result has no name field)
    const seenDeliv = {};   // title -> true (one openable row per produced file)
    let runToolsOk = 0, runDeliv = 0, thisRunId = null;   // per-run work tally → the "rate the work" beat's size + delivery gate
    activeLiveRow = streamingAgent();
    let acc = '';
    // VOICE STREAMING: when the agent will speak (🔊 on), hand each COMPLETE sentence to Voice as it
    // streams — so it starts talking while the rest is still generating, instead of after the whole reply
    // is done + synthesized. spokenIdx tracks how much of `acc` we've already queued.
    let spokenIdx = 0, finalReply = '', titleOk = false;
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
        system: sys, messages: ws.history, agentId: ws.agentId || 'agent', isTask, recurring, signal: ac.signal, streamId: ws.id,
        placed: (typeof World !== 'undefined' && World.heroCaps) ? World.heroCaps(ws.agentId || 'agent') : [],   // THE MOAT: this run's reach = the agent's REAL placed props (dish→web · cabinet→files · workbench→terminal · …); compute is the freebie
        onRunId: id => { thisRunId = id; try { RUN_META.set(id, { isTask: !!isTask, title: (ws && ws.title) || '' }); if (RUN_META.size > 60) RUN_META.delete(RUN_META.keys().next().value); } catch (_) {} Channels.setRunId(ws.id, id); if (typeof Workstreams !== 'undefined') { Workstreams.appendRun(ws.id, id); if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } },
        onToken: d => { acc += d; Channels.appendToken(ws.id, d); if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.append(d); if (!isTask) World.say(acc); } if (willSpeak) pushSpeech(false); App.refreshUsage(); },
        onUsage: () => App.refreshUsage(),
        // COMMS-PREMIUM: the Channels store still records the pre-formatted STRING (replay/switch-survival is
        // unchanged — replayChannel renders those via toolLine), but the LIVE surface renders a structured CHIP.
        // breakLive() closes the prose paragraph AND the prior chip rail only when it's a *call after prose*; a
        // run of consecutive calls shares one rail because onToolResult below never breaks it.
        onToolCall: ev => { callNames[ev.callId] = ev.name; const t = '▶ ' + ev.name + ' ' + brief(ev.argsSummary); Channels.addTool(ws.id, t, false); walkToDesk(); presenceToolCall(ws, ev.name); if (isActiveWs(ws)) { if (activeLiveRow && activeLiveRow.breakSeg) activeLiveRow.breakSeg(); toolChip(ev); } if (typeof U !== 'undefined' && U.bus && ev.name && ev.name.indexOf('mcp__') === 0) U.bus.emit('agent.tool_call', { name: ev.name }); },
        onToolResult: ev => { if (!ev.isError) runToolsOk++; const nm = callNames[ev.callId] || 'tool'; const t = (ev.isError ? '✕ ' : '◀ ') + nm + ' · ' + brief(ev.summary || (ev.isError ? 'error' : 'ok')) + (ev.isError ? ' — failed' : '') + (ev.ms ? ' (' + fmtMs(ev.ms) + ')' : ''); Channels.addTool(ws.id, t, ev.isError); presenceToolResult(ws); if (isActiveWs(ws)) resolveChip(ev, nm); },
        onDeliverable: ev => {
          // Any produced file is an openable product (image_generate emits kind:'image', fs.write emits
          // kind:'file'). How we RENDER it is decided client-side from the EXTENSION (the Hermes model), not
          // from the backend's kind — so a .mp4/.webm the agent writes becomes an inline player and a .png a
          // thumbnail, with no backend change. Unknown extensions fall back to the plain clickable row.
          if ((ev.kind === 'file' || ev.kind === 'image') && !seenDeliv[ev.title]) {
            seenDeliv[ev.title] = true; runDeliv++;
            const mk = mediaKindOf(ev.title);
            if (isActiveWs(ws)) {
              breakLive();
              if (mk === 'image') imageDeliverableLine(ev.title, ev.agentId);
              else if (mk === 'video' || mk === 'audio') mediaPlayerLine(ev.title, ev.agentId, mk);
              else deliverableLine(ev.title, ev.agentId);
            }
            // the frozen 'deliverable' event carries no runId/time — synthesize from the live run + clock.
            // record the rendered media kind so a future history/replay surface can re-render the same way.
            if (typeof Workstreams !== 'undefined') Workstreams.recordDeliverable(ws.id, { title: ev.title, kind: mk === 'file' ? ev.kind : mk, runId: Channels.runIdOf(ws.id), t: Date.now() });
            if (typeof StationUI !== 'undefined') StationUI.notify((mk === 'file' ? 'saved ' : 'made ') + ev.title, 'gold');
          }
        },
        onPermission: ev => { Channels.setPending(ws.id, { promptId: ev.promptId, tool: ev.tool, argsSummary: ev.argsSummary, runId: Channels.runIdOf(ws.id) }); walkToDesk(); if (isActiveWs(ws)) { breakLive(); permissionRow(ev, ws); } },
        // the lead's team.summon tool asked the station to create a worker: run the REAL summon (App.summonForRequest
        // → the Recruitment Bay's own summonAgent), then ack with the new id so the lead can delegate to it. The id
        // resolves only after the roster POST lands (App awaits it), so the lead's next team.dispatch finds the worker.
        onSummon: ev => {
          const rid = Channels.runIdOf(ws.id);
          Promise.resolve((typeof App !== 'undefined' && App.summonForRequest) ? App.summonForRequest(ev) : null)
            .then(newId => Harness.summonAck(rid, ev.requestId, newId))
            .catch(() => Harness.summonAck(rid, ev.requestId, null));
        }
      });
      if (error) {
        // PLAIN-LANGUAGE: lead with the beginner-facing message, keep the raw error as a dim sub-line; persist
        // the friendly text (not the plumbing) so a switch-back / replay shows the same readable failure.
        const v = (typeof Friendly !== 'undefined') ? Friendly.friendlyError(error) : { userMessage: error, retryable: true, action: null, raw: error };
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.error(v.userMessage, v.raw); if (!isTask) World.say('…' + (v.userMessage.length > 40 ? v.userMessage.slice(0, 40) + '…' : v.userMessage)); }
        ws.history.push({ role: 'assistant', content: '⚠ ' + v.userMessage, error: true });   // so the failure survives a switch-back, not just a transient notify
        if (typeof StationUI !== 'undefined') StationUI.notify(brief(v.userMessage), 'warn');
        if (isActiveWs(ws)) resolvePresence(ws, { error: true });   // COMMS-PREMIUM: presence card resolves red
        if (isActiveWs(ws)) offerRetry(v);   // RETRY: context-aware recovery chip (retry / Settings / SKILLS / none)
      } else {
        const replyText = reply || acc;
        finalReply = replyText;
        titleOk = !!replyText.trim();   // a real, non-empty reply landed → this stream is eligible for a summary title
        if (replyText.trim()) ws.history.push({ role: 'assistant', content: replyText });   // never persist an empty turn
        // the stop-reason is part of the WORK log → close the live paragraph, then drop it in chronologically.
        if (endReason && endReason !== 'done') {
          if (isActiveWs(ws)) breakLive(), toolLine('⏹ ' + (endReason === 'max_iters' ? 'reached the step limit — say "continue" to keep going'
            : endReason === 'budget' ? 'reached this run\'s limit'
            : endReason === 'cancelled' ? (interrupted.has(ws.id) ? 'stopped' : 'run cancelled')
            : 'stopped (' + endReason + ')'));
          if (typeof StationUI !== 'undefined') StationUI.notify('run stopped: ' + endReason, 'warn');
        }
        if (isActiveWs(ws) && activeLiveRow) activeLiveRow.done();
        // a talk reply shows as a room bubble; the spoken reply itself is STREAMED sentence-by-sentence as
        // it arrives (onToken → pushSpeech) and flushed in the finally.
        if (!isTask && isActiveWs(ws)) World.say(replyText);
        // SHIPPED (P1): a clean finish delivers the work-item → the ONE outbound product crate + the weight-3
        // profile/XP ship-signal + the "tasks shipped" milestone. Only on done/undefined — a max_iters/budget/
        // error/refusal stop is an unproductive run (the agent.run.end SLAG path owns that); abort/hard-error never
        // reach this branch. (Not gated on isActiveWs: a background stream's work still ships.)
        if (!endReason || endReason === 'done') wiEmit('workitem.delivered', { workitemId: wiId, finalQueueId: 'outbox', agentId: wiAid, box: '', ms: Date.now() - wiPlacedTs, ts: Date.now() });
        // stash this run's REAL work so the post-run "rate the work" beat can size the XP honestly + gate on real work.
        let runCost = 0;
        if (thisRunId) { runCost = Math.max(0, (Harness.totals().cost || 0) - (before.cost || 0)); runWork.set(thisRunId, { toolsOk: runToolsOk, delivered: runDeliv, cost: runCost, agentId: ws.agentId || 'agent' }); if (runWork.size > 60) runWork.delete(runWork.keys().next().value); }
        // COMMS-PREMIUM: resolve the presence card into a compact summary. steps = real successful tool rounds,
        // cost = this run's REAL usd delta — both truthful (shown only when > 0), never fabricated.
        if (isActiveWs(ws)) resolvePresence(ws, { endReason: endReason, steps: runToolsOk, cost: runCost });
        // WORK VISIBILITY: a passive recap of what this run PRODUCED, fetched from the run's recorded
        // artifacts ledger. A report, not an ask — it never claims the post-run beat slot. Fire-and-forget.
        if (thisRunId) renderRunRecap(ws, thisRunId, Date.now() - wiPlacedTs);
      }
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));
      const stopped = interrupted.has(ws.id);   // the Commander pressed Stop on THIS stream — a graceful interrupt, not a fault
      if (stopped) {
        // keep whatever already streamed, mark it stopped, and log NO error (the stop was intentional).
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.done(); toolLine('⏹ stopped'); resolvePresence(ws, { stopped: true, steps: runToolsOk }); }
        if (acc.trim()) ws.history.push({ role: 'assistant', content: acc });   // the partial reply survives a switch
        if (!isTask && isActiveWs(ws) && acc.trim()) World.say(acc);
      } else {
        // A throw that is NOT a deliberate Stop: an unexpected disconnect (the reader aborted with no Stop) or a
        // hard fetch/network error. An unexpected abort here means the connection dropped — classify it as a
        // network fault (NOT a user cancel) so it reads "can't reach the sidecar" and still offers a retry.
        const v = (typeof Friendly !== 'undefined')
          ? Friendly.friendlyError(aborted ? new Error('cannot reach the STARNET sidecar — connection dropped') : e)
          : { userMessage: aborted ? 'Lost the connection — try again.' : (e.message || String(e)), retryable: true, action: null, raw: (e && e.message) || String(e) };
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.error(v.userMessage, v.raw); if (!isTask) World.say('…connection trouble…'); resolvePresence(ws, { error: true }); }
        ws.history.push({ role: 'assistant', content: '⚠ ' + v.userMessage, error: true });   // keep a readable trace of the failure
        if (isActiveWs(ws)) offerRetry(v);   // RETRY: context-aware recovery chip (a dropped connection is retryable)
      }
      // a THROWN teardown (abort/cancel/disconnect/network drop) means agent.run.end was LOST on the bus, so the
      // crew HUD would stick at WORKING — clear this run's count here. Normal + in-band-error completions deliver
      // run.end (decremented by the bus listener), so we must NOT clear there or a concurrent sibling under-counts.
      if (typeof StationUI !== 'undefined' && StationUI.clearRunning) StationUI.clearRunning(ws.agentId || 'agent');
    } finally {
      aborters.delete(ws.id);
      interrupted.delete(ws.id);   // consume the stop flag (whether or not it fired)
      Channels.end(ws.id);
      // P1: drain this directive from the QUEUE gauge on ANY teardown (shipped, in-band error, or abort) —
      // the backlog is "runs in flight", independent of whether the work shipped.
      { const depth = wiBump(wiAid, -1); wiEmit('queue.status', { queueId: wiAid, depth: depth, maxCapacity: 64, nextAdvanceAt: 0 }); }
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
      // FIRST-TURN TITLE: replace the instant first-sentence placeholder with a model-written summary. Quiet
      // (internal call, off the floor/telemetry) and fire-and-forget so it never delays this turn's teardown.
      if (firstTurn && titleOk) maybeRetitle(ws, text, finalReply);
      // flush any trailing spoken text and CLOSE the speech stream — the last chunk's end re-arms the
      // hands-free mic (this is the heartbeat for spoken turns; onTurnEnd covers silent/no-speech turns).
      if (willSpeak && typeof Voice !== 'undefined' && Voice.endReply) { pushSpeech(true, finalReply); Voice.endReply(); }
      // hands-free voice mode: the run is done — let Voice re-open the mic for the next turn.
      if (typeof Voice !== 'undefined' && Voice.onTurnEnd) Voice.onTurnEnd();
      // TYPE-AHEAD: the stream just freed — send its next queued follow-up (after this call fully unwinds).
      setTimeout(() => flushQueued(ws.id), 0);
    }
  }

  /* QUIET TITLE SUMMARY — one tiny internal model call (no tools, suppressed from the floor + telemetry exactly
     like the pitch/suggest self-talk: internal:true drops its run.start/run.end so it never counts as a delivered
     task, walks a sprite, or earns XP) that turns a new stream's first message into a 3-6 word title. Best-effort:
     any failure or an unparseable reply silently leaves the instant first-sentence placeholder in place. The tiny
     usage delta is folded into THIS stream's per-conversation cost so the telemetry stays truthful. */
  async function maybeRetitle(ws, userText, replyText) {
    if (typeof Harness === 'undefined' || typeof Workstreams === 'undefined' || !ws) return;
    const cur = Workstreams.get(ws.id);
    if (!cur || cur.titleAuto === false || ws.id === Workstreams.generalId()) return;   // never stomp a manual rename / title General
    const sys = 'You generate a terse title for a work session. Reply with ONLY a 3 to 6 word title that summarizes'
      + ' what the user wants done. Use Title Case. No surrounding quotes, no trailing punctuation, no preamble —'
      + ' output the title and nothing else.';
    const prompt = String(userText || '').replace(/\s+/g, ' ').slice(0, 500)
      + (replyText ? ('\n\nAssistant reply (context only): ' + String(replyText).replace(/\s+/g, ' ').slice(0, 200)) : '');
    if (!prompt.trim()) return;
    const before = Object.assign({}, Harness.totals());   // COPY (totals is a mutated singleton)
    let res;
    try {
      res = await Harness.chat({ system: sys, messages: [{ role: 'user', content: prompt }], agentId: ws.agentId || 'agent', isTask: false, placed: [], internal: true });
    } catch (_) { return; }   // network/hiccup → keep the placeholder, no noise
    // fold the quiet call's REAL usage into the origin stream (same truthful-telemetry path as a normal turn)
    try { const a = Harness.totals(); Workstreams.addCost(ws.id, { tokens: a.tokens - before.tokens, usd: a.cost - before.cost, calls: a.calls - before.calls }); } catch (_) {}
    if (!res || res.error) return;
    const t = cleanTitle(res.text);
    if (t && Workstreams.retitle(ws.id, t)) {
      if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
      if (onTurn) onTurn();   // persist the upgraded title
    }
  }
  /* scrub a model title reply to a clean short label: first non-empty line, strip wrapping quotes/asterisks, drop
     trailing punctuation, collapse whitespace, length-cap, and reject an obvious non-title (a refusal or a whole
     sentence) so a bad reply leaves the placeholder rather than writing garbage into the rail. */
  function cleanTitle(raw) {
    let t = String(raw == null ? '' : raw).trim();
    if (!t) return '';
    t = (t.split(/\r?\n/).find(l => l.trim()) || '').trim();   // first non-empty line only
    t = t.replace(/^["'`*\s]+|["'`*\s]+$/g, '').replace(/[\s.:;,—–-]+$/g, '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 64) return '';                        // empty or a paragraph came back → keep placeholder
    if (/\b(sorry|cannot|can't|unable|as an ai|here(?:'s| is)|i (?:can|am|will|would))\b/i.test(t)) return '';   // refusal / chatty
    return t;
  }

  /* DISCONNECT (or any teardown) cancels the in-flight billable run: abort the fetch (the sidecar's
     req.on('close') then stops the loop) AND tell the sidecar to kill the run by id — belt-and-suspenders. */
  function abort() {
    if (typeof Voice !== 'undefined' && Voice.stopConvo) Voice.stopConvo();   // drop hands-free on disconnect
    // teardown is a DELIBERATE interrupt, not a dropped connection: flag every in-flight stream interrupted BEFORE
    // aborting so send()'s catch reads `stopped` and stays silent — otherwise the AbortError gets reclassified as a
    // network fault and a spurious "can't reach the sidecar" row is pushed into ws.history + persisted. (A reader
    // that aborts WITHOUT going through here = a genuine dropped connection → still a network error + retry.)
    for (const id of aborters.keys()) interrupted.add(id);
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
    clearChoices();
    if (input) input.placeholder = opts.placeholder || 'answer to wake your agent…';
    status(opts.status || 'waking…');
  }
  function endInterview() {
    interview = null;
    clearChoices();
    if (input) input.placeholder = 'speak to your agent…';
    status('online');
  }
  function echoUser(text) { addUser(text); }
  // scaffold the COMMS input with a starter the Commander finishes typing (the awakening's open CONTEXT
  // question uses this so a chip seeds "what i'm building: …" instead of committing a half-empty answer).
  function prefill(t) {
    if (!input) return;
    const add = String(t == null ? '' : t);
    const cur = input.value;
    // APPEND, never replace: tapping a 2nd facet chip must not wipe what the 1st started (or what the Commander
    // already typed). Separate with "; " unless the line already ends on a separator or is empty.
    if (cur.trim()) input.value = /[;:,]\s*$/.test(cur) ? cur.replace(/\s+$/, '') + ' ' + add : cur.replace(/\s+$/, '') + '; ' + add;
    else input.value = add;
    input.focus();
    try { const n = input.value.length; input.setSelectionRange(n, n); } catch (_) {}
  }
  // a row of tappable suggestion pills in COMMS; picking one (or typing) is an answer. onPick gets the item.
  function clearChoices() {
    for (const r of Array.from(activeChoiceRows)) { if (r && r.parentNode) r.remove(); }
    activeChoiceRows.clear();
  }
  function choices(items, onPick) {
    if (!log) return;
    clearEmptyState();
    clearChoices();   // chips are a focused prompt, never a background layer behind the next question
    const rowEl = document.createElement('div'); rowEl.className = 'choice-row';
    activeChoiceRows.add(rowEl);
    let done = false;
    (items || []).forEach(it => {
      const b = document.createElement('button'); b.className = 'choice'; b.textContent = it.label;
      b.onclick = () => { if (done) return; done = true; activeChoiceRows.delete(rowEl); rowEl.remove(); if (typeof SFX !== 'undefined') SFX.click(); onPick(it); };
      rowEl.appendChild(b);
    });
    log.appendChild(rowEl); autoscroll();
    return rowEl;   // caller (curiosity nudge) keeps a handle so the chip row can be retired with its prompt
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

  // read-only lookup of a run's start-time metadata ({ isTask, title }) by runId, or null. Used by the proactive
  // advice stores (pitchstore) to gate on a real task and to name the run that just finished. Never mutated outside.
  function runMeta(id) { return (id && RUN_META.has(id)) ? RUN_META.get(id) : null; }

  return { init, load, send, status, localLine, broadcast, setSystem, getHistory, abort, isBusy, beginInterview, endInterview, echoUser, prefill, choices, clearChoices, typeLine, nudge, clearNudge, offerCuriosity, runMeta, awayDigest, awayReview };
})();
