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
  // TIER D · D1 WARMTH (2026-07-02): COMMS is a persistent panel, so setChatFocus never clears — the focused
  // body would otherwise chat-stare (track your cursor) forever. world.js decays the stare after a random
  // 30-90s warmth window (drawn fresh per engagement — unpredictable by design); this re-warms it on the genuine
  // engagement moments (typing / sending / run-end return-to-stare of the focused stream) so an ACTIVE
  // conversation holds the stare, an idle one lets go. O(1); no-ops when no focus is set. Engagement points only.
  function warmChat() { if (typeof World !== 'undefined' && World.chatFocusPing) World.chatFocusPing(); }
  let onTurn = null, interview = null;   // interview: the AWAKENING answer handler — while set, COMMS input feeds onboarding, not the model
  // THE GATE: per-workstream run-state (busy / runId / in-flight text / tool lines / pending approval) lives in
  // Channels (channels.js) so streams are isolated and survive a switch — chat.js is the DOM view over it. The
  // one thing that can't live in the pure model is the live AbortController (not serializable), so it stays here.
  const aborters = new Map();   // workstreamId -> AbortController for that stream's in-flight run
  const interrupted = new Set();   // wsIds the Commander deliberately STOPPED this turn — send()'s catch reads this as a
                                   // graceful stop (keep the partial reply, log no error) rather than a disconnect. Consumed in finally.
  const interruptedStreams = new Set();   // CRASH HONESTY: wsIds whose in-flight run died on a NETWORK drop (sidecar
                                   // crash / lost connection). On a proven reconnect we tell the Commander the run can't resume.
  let reconnectTimer = 0;          // the single reconnect health-probe poll (armed only while interruptedStreams is non-empty)
  const queued = new Map();        // TYPE-AHEAD: wsId -> [text,…] follow-ups typed while the stream was busy; auto-sent in order as it frees
  let activeLiveRow = null;     // streaming text controller for the DISPLAYED stream's in-flight run; rebound by replayChannel on switch
                                // CLASSIC HARNESS FLOW: prose and the agent's actions (tool ▶/◀ lines, deliverables, approval
                                // prompts) render CHRONOLOGICALLY — newest at the bottom — instead of pinning one reply block to
                                // the bottom with work floating above it. streamingAgent() segments the prose so an action drops
                                // in BETWEEN text blocks, exactly where it happened.
  let proposalsWired = false;   // the memory.proposed (turn-in) U.bus listener is registered exactly once
  let studyWired = false;       // the agent.run.end STUDY (dossier Phase B) listener is registered exactly once
  let studyRunsSeen = new Set();   // runIds already study-fetched (agent.run.end can re-fire; fetch once per run)
  let curiosityWired = false;   // the agent.run.end curiosity-nudge listener is registered exactly once
  let arcWired = false;         // GROWTH Tier 2: the agent.run.end goal-arc confirm-beat listener (registers once)
  let arcRunsSeen = new Set();  // GROWTH Tier 2: runIds already arc-offered (agent.run.end can re-fire; offer once per run)
  let skillAsideWired = false;  // the deliverable(kind:skill) background-review aside listener is registered exactly once
  let skillDelivSeen = new Set();   // deliverable ids already asided → the background review re-firing never double-asides
  let recentInRunSkill = 0;     // ts of the last IN-RUN skill.* tool call — suppresses the aside for a save the A1 chip already showed
  let trustWired = false;       // GROWTH Tier 3: the agent.run.end earned-autonomy offer-beat listener (registers once)
  let trustRunsSeen = new Set();// GROWTH Tier 3: runIds already trust-offered (agent.run.end can re-fire; offer once per run)
  let activeTrust = null;       // GROWTH Tier 3: the single visible trust offer card { node, offer, decided }
  let activeNudge = null;       // the live curiosity nudge { row, choiceRow, dim } — retired if a turn-in claims the post-run beat
  let recruitShown = false;     // adaptive recruitment: the ONE recruit beat is offered at most once per session (in-memory, resets each app run)
  let activeTurnin = null;      // the single visible memory-review deck; later batches queue behind it
  const turninQueue = [];       // memory-review batches waiting for the visible deck to finish
  const activeChoiceRows = new Set();   // one-shot chip rows; cleared when a typed answer supersedes them
  const proposalRunsSeen = new Set();   // runIds already turned into a beat (memory.proposed fires once per proposal)
  const receiptRunsSeen = new Set();    // runIds whose SILENT auto-saved receipts already rendered (memory.write triggers once per run)
  const runWork = new Map();    // runId -> { toolsOk, delivered, cost, agentId } captured at run end → the "rate the work"
                                // beat's HONEST, un-farmable size + the delivery gate (real tools/deliverables only). FIFO-capped.
  // P3.2 CREW ATTRIBUTION: a lead run that dispatched crew gets each worker's PROVABLE spend so a 👍 on the run
  // can split its XP mint honestly. Fed by wireCrewCapture (below): every forwarded worker agent.run.end lands in
  // a rolling buffer keyed by the worker's OWN runId; at the lead's run.end we CLAIM the workers whose run fell
  // inside this lead run's live window (start→end). Only NAMED roster workers (team.dispatch) are attributable —
  // ephemeral team.spawn clones (sub-* ids, no persistent identity) are filtered out (crediting a vanished clone
  // would be a lie). runCrew: leadRunId -> [{ agentId, usd }]. crewSeen: the rolling worker buffer.
  const crewSeen = [];          // [{ agentId, usd, runId, at }] — recent forwarded worker run-ends (FIFO, time-windowed)
  const runCrew = new Map();    // leadRunId -> [{ agentId, usd }] claimed at lead run.end. FIFO-capped alongside runWork.
  const workRatedRuns = new Set();   // runIds already given a 👍/👌/👎 work verdict → one rating per run, never double-mint
  const RUN_META = new Map();   // runId -> { isTask, title } recorded at run START. The bus agent.run.end payload
                                // carries neither flag, so the post-run advice beats (the First Pitch graduation gate)
                                // read this to tell a real TASK from casual chat AND to name the run that actually just
                                // finished. Capped FIFO so a long session can't leak runIds.
  // G5 SPECTACLE slice 2 — the shareable CLIP recorder. ONE shared bounded ring buffer that quietly samples the
  // live #stage during a TASK run's active beat (armed at run start, disarmed at run end) so "the last ~10 seconds"
  // of the floor are always grabbable when the recap card lands. Decoupled from the world rAF loop (its own timer),
  // so arming never tanks the render loop. Absent module (older bundle) = a null recorder = no clip button. Lazy so
  // it constructs only when first needed.
  let clipRecorder = null;
  const runClip = new Map();   // runId -> [{canvas,t}] the ring-tail snapshot taken at that run's end (FIFO-capped, ≤8 runs)
  function clipRec() {
    if (clipRecorder) return clipRecorder;
    if (typeof Clip === 'undefined' || !Clip.recorder) return null;
    try { clipRecorder = Clip.recorder({ fps: Clip.DEFAULT_FPS, seconds: Clip.DEFAULT_SECONDS }); } catch (_) { clipRecorder = null; }
    return clipRecorder;
  }
  function armClip() { const r = clipRec(); if (r && !r.armed()) { try { r.arm(); } catch (_) {} } }
  function disarmClip() { const r = clipRecorder; if (r && r.armed()) { try { r.disarm(); } catch (_) {} } }

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
    // PAUSED-ON-APPROVAL: the run is stopped on the sidecar waiting for the Commander. Restyle the card so it
    // reads as a deliberate pause (no working pulse) and NAME the pending action — truth source is the same
    // Channels.pendingOf payload that renders the approval prompt, so this can never claim a pause that isn't real.
    const pend = (activeWs && typeof Channels !== 'undefined') ? Channels.pendingOf(activeWs.id) : null;
    const paused = !!pend;
    card.classList.toggle('paused', paused);
    const verb = card.querySelector('.cp-verb'); if (verb) verb.textContent = presenceVerb();
    const tool = card.querySelector('.cp-tool');
    if (tool) {
      if (paused) {
        // e.g. "paused — waiting for you to approve fs.write"
        const t = 'paused — waiting for you to approve ' + shortName(pend.tool);
        if (tool.textContent !== t) tool.textContent = t;
        tool.classList.add('has'); tool.classList.add('paused-note');
      } else {
        tool.classList.remove('paused-note');
        const t = presenceCurTool ? shortName(presenceCurTool) : '';
        if (tool.textContent !== t) tool.textContent = t; tool.classList.toggle('has', !!t);
      }
    }
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
    if (typeof opts.cost === 'number' && opts.cost > 0) bits.push(U.usd(opts.cost));
    card.textContent = label + (bits.length ? ' · ' + bits.join(' · ') : '');
    card.setAttribute('role', 'note');
    autoscroll();
  }

  // CRASH HONESTY (Theme 2) — after a run stream died on a network drop, poll /api/health until the sidecar is
  // PROVABLY back, then tell the Commander their interrupted run can't resume. Truthful telemetry: the
  // "connection restored" line renders ONLY after a real 200 from the respawned sidecar, never on hope. The
  // probe self-arms on the drop and self-clears once every interrupted stream has been reported.
  async function probeReconnect() {
    if (!interruptedStreams.size) { reconnectTimer = 0; return; }
    let alive = false;
    try { const r = await fetch('/api/health', { cache: 'no-store' }); alive = !!(r && r.ok); } catch (_) { alive = false; }
    if (alive) {
      // report each interrupted stream once. Only the DISPLAYED stream draws a line (same rule as tool/error
      // lines); a background stream's flag is cleared quietly — its error row already recorded the failure.
      const wasActive = activeWs && interruptedStreams.has(activeWs.id);
      interruptedStreams.clear();
      reconnectTimer = 0;
      if (wasActive) toolLine('⏹ connection restored — your last run was interrupted and can\'t resume; start it again.', true);
    } else {
      reconnectTimer = setTimeout(probeReconnect, 3000);   // still down — keep watching
    }
  }
  function armReconnectWatch() {
    if (reconnectTimer) return;
    // if the browser signals it's back online, probe immediately; otherwise poll on a slow cadence.
    reconnectTimer = setTimeout(probeReconnect, 2000);
    try { if (typeof window !== 'undefined' && !window.__runtruthOnlineHook) { window.__runtruthOnlineHook = true; window.addEventListener('online', () => { if (interruptedStreams.size && !reconnectTimer) probeReconnect(); }); } } catch (_) {}
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
    proposalRunsSeen.clear(); receiptRunsSeen.clear(); studyRunsSeen.clear(); clearChoices(); turninQueue.length = 0; activeTurnin = null; wiQDepth.clear(); queued.clear(); interrupted.clear();   // C2: per-session run-tracking + the queue gauge + turn-control state start clean for each agent (listeners stay once-registered)
    // GROWTH Tier 1: the study side starts clean per session too — a prior hero's deferred study/taste beats must
    // never flush into a new session (same law as turninQueue above). A fresh beat-slot arbiter matches the DOM.
    studyPending.length = 0; tastePending.length = 0; activeStudy = null;
    arcRunsSeen.clear();   // GROWTH Tier 2: the arc side starts clean per session (a prior hero's arc offers never carry over)
    trustRunsSeen.clear(); activeTrust = null;   // GROWTH Tier 3: the trust side starts clean per session (a prior hero's earned-autonomy offers never carry over)
    beatSlot = (typeof Study !== 'undefined' && Study.makeBeatSlot) ? Study.makeBeatSlot() : null;
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
    autoGrowInput();   // COMPOSER: settle the textarea at its resting one-line height
    warmSlashCatalog();
    wireProposals();   // Cortex turn-in beat: listen for reflection's memory.proposed (registers once)
    wireStudy();       // GROWTH Tier 1: after a salient run, offer ≤1 dossier belief-update at turn-in priority (registers once)
    wireArc();         // GROWTH Tier 2: after a clean run, offer ONE goal-decomposition confirm at the LOWEST beat priority (registers once)
    wireTrust();       // GROWTH Tier 3: after a clean run, offer ONE earned-autonomy raise at the LOWEST beat priority — below the arc (registers once)
    wireCrewCapture(); // P3.2: record each dispatched worker's forwarded run-end spend so a 👍 on a crew run splits XP honestly (registers once)
    wireCuriosity();   // Commander Dossier: one gentle "tell me about X" nudge after a clean run (registers once)
    wireSkillAside();  // A2: after a background review distills a skill, ONE quiet "distilled this run…" aside (registers once)
    wireIdBar();       // COMMS agent selector: a change switches to (or mints) a workstream bound to that agent (registers once)
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
      if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) {   // Shift+Enter falls through → newline in the textarea
        e.preventDefault();
        const t = input.value.trim();
        if (!t) return;
        input.value = ''; closeSlash(); autoGrowInput();   // COMPOSER: collapse back to one line after a send
        if (isBusy()) enqueue(t); else send(t);   // TYPE-AHEAD: queue a follow-up rather than dropping it while the stream is busy
      } else if (e.key === 'Escape' && isBusy()) {
        e.preventDefault(); e.stopPropagation();   // INTERRUPT: beat navdock's global Esc-closes-menus while a run is live
        stopActive();
      }
    };
    // SLASH PALETTE: a leading "/" opens the command menu and filters it live as you type past it.
    input.addEventListener('input', () => { autoGrowInput(); warmChat(); const v = input.value; if (v[0] === '/') openSlash(v.slice(1)); else closeSlash(); });
    const stopBtn = el('chat-stop'); if (stopBtn) stopBtn.onclick = stopActive;
  }

  // COMPOSER auto-grow: the message field is a <textarea>, so keep its rendered height matched to its
  // content — one line at rest, growing with the message up to comms.css's max-height, then it scrolls.
  // This is what lets the Commander SEE a whole long message being typed at any COMMS width (the old
  // single-line <input> could only ever show a sliver). Called on every edit (typed, dictated, or
  // programmatically filled) and after a send resets the box. Cheap: height:'auto' lets scrollHeight
  // report the true wrapped content height before we pin it.
  function autoGrowInput() {
    if (!input) return;
    input.style.height = 'auto';
    // An EMPTY box rests at the CSS one-line min-height. We must NOT pin it to scrollHeight when empty:
    // a long placeholder wraps to 2 lines on a narrow panel, and its wrapped height would puff the
    // resting box up. Only a real value grows the box.
    if (input.value) input.style.height = input.scrollHeight + 'px';
  }

  /* ── COMMS AGENT LINE ────────────────────────────────────────────────────────────────────────────────
     The top-of-panel identity row: a <select> of every live roster agent (so the Commander picks who's on
     the line) + a truthful readout of THAT agent's model. Both are filled from App.agents() — never
     hardcoded — so the header can only ever assert a real roster identity (truthful telemetry). Selecting
     an agent hands off to App.selectAgent, which switches to (or mints) a workstream bound to that agentId;
     it never rebinds the current conversation to a different agent. Re-rendered on every load()/switch so the
     selection + model always match the displayed stream (including changes made in the footer dock/dossier). */
  function agentModelText(a) {
    if (!a) return '';
    const model = a.model ? String(a.model) : '';
    if (!model) return 'follows station default';
    // reuse the dock's short-label vocabulary when present; else the last path segment (never invent a name)
    return (typeof ModelDock !== 'undefined' && ModelDock.labels && ModelDock.labels.short)
      ? ModelDock.labels.short(model)
      : ((model.split('/').pop() || model).toUpperCase());
  }
  function renderIdBar() {
    const sel = el('comms-agent-select'); const modelEl = el('comms-agent-model'); const bar = el('comms-idbar');
    if (!sel) return;
    const list = (typeof App !== 'undefined' && App.agents) ? (App.agents() || []) : [];
    const activeId = activeWs ? (activeWs.agentId || 'agent') : null;
    // rebuild the <option> set only when the roster (ids+names) or selection changed, so a redundant re-render
    // never collapses a mid-open native dropdown.
    const key = list.map(a => a.id + ':' + (a.name || a.id)).join('|') + '#' + (activeId == null ? '' : activeId);
    if (sel.__idKey !== key) {
      sel.__idKey = key;
      sel.innerHTML = '';
      for (const a of list) { const o = document.createElement('option'); o.value = a.id; o.textContent = a.name || a.id; sel.appendChild(o); }
      if (activeId != null) sel.value = activeId;
    }
    const cur = list.find(a => a.id === activeId) || null;
    if (modelEl) modelEl.textContent = cur ? agentModelText(cur) : '';
    if (bar) bar.hidden = !list.length;   // no roster yet (pre-wake) → hide the row rather than show an empty selector
  }
  // wire the agent <select> once: a change hands off to App.selectAgent (switch/mint a stream bound to that
  // agent). Registered from init() so a re-init can't stack handlers.
  function wireIdBar() {
    const sel = el('comms-agent-select');
    if (!sel || sel.__wired) return;
    sel.__wired = true;
    sel.addEventListener('change', () => {
      const id = sel.value;
      if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
      if (typeof App !== 'undefined' && App.selectAgent) App.selectAgent(id);
      // App.selectAgent → switchWorkstream → Chat.load → renderIdBar, so the model readout follows the switch.
    });
  }

  // swap the rendered conversation to a workstream (its history). Used on enter/resume and when the
  // Commander clicks another stream in the rail — re-renders without re-wiring the input row.
  function load(ws) {
    activeWs = ws || (typeof Workstreams !== 'undefined' ? Workstreams.active() : null);
    // SPEAKER IDENTITY: re-resolve `name` (the reply-chip + agent-beat speaker, else stuck at init's hero) from the
    // displayed stream's agent, so switching agents relabels replies. Guard: an unknown id keeps the current name.
    if (activeWs && typeof App !== 'undefined' && App.agentName) { const nm = App.agentName(activeWs.agentId || 'agent'); if (nm) name = nm; }
    activeTurnin = null; turninQueue.length = 0; clearChoices();   // visible review/choice layers belong to the current COMMS DOM
    activeStudy = null;   // the study card is the same kind of visible review layer — it belongs to the outgoing DOM
    activeTrust = null;   // GROWTH Tier 3: the trust offer card is likewise a visible review layer bound to the outgoing DOM
    if (beatSlot && beatSlot.visibleBeat()) beatSlot = (typeof Study !== 'undefined' && Study.makeBeatSlot) ? Study.makeBeatSlot() : null;   // the visible beat left with its DOM; a fresh arbiter matches the new stream
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
    // GOAL LOOP: returned to an idle stream with an ACTIVE standing goal (its moment was blocked / it was
    // backgrounded mid-loop) → continue it. kickGoal no-ops when busy/blocked/paused, so this is always safe.
    if (activeWs && typeof GoalLoop !== 'undefined' && goalOf(activeWs)) { const w = activeWs; setTimeout(() => { if (isActiveWs(w)) kickGoal(w); }, 0); }
    // TIER D · D1 ATTENTIVE AUDIENCE: announce which agent the Commander now has COMMS focus on. load(ws) is the
    // sole conversation-rebind boundary (open + every switch), and the persistent COMMS panel has no separate
    // close — so this one hook covers focus on/switch, and null when there's no active stream. world.js owns all
    // behavior: the focused body, while idle, stops wandering and holds its attention on you (faces you, tracks the
    // cursor); it yields instantly to a reply run and resumes after. This is the ONLY chat.js change for D1 (G7).
    if (typeof World !== 'undefined' && World.setChatFocus) World.setChatFocus(activeWs ? (activeWs.agentId || 'agent') : null);
    renderIdBar();   // the agent selector + model readout follow the displayed stream's agent
  }

  function setSystem(s) { system = s; }
  // HISTORY CAP (Lane E3): ws.history grew unbounded across a session, and the WHOLE array was POSTed as `messages`
  // on every run — memory + payload both climbing forever on a 24/7 station. Cap the STORED history and send only a
  // capped window. Chosen to preserve behavior for any normal session:
  //   • The sidecar (index.js) only auto-seeds from the durable transcript when the client sends ≤1 non-system
  //     message, and its own resume horizon is transcriptStore.reconstruct(streamId,{limit:100}) — the server
  //     already treats ~100 turns as the memory horizon.
  //   • Within a run, loop.js token-auto-compacts the working array, so older turns beyond the model's context are
  //     summarized away server-side regardless of how many the client sends.
  // So capping at 120 kept turns (> the server's 100 resume horizon) is byte-identical for normal sessions and only
  // bites pathologically long ones — exactly where the server would have compacted anyway. A single truncation
  // marker object (role:'system', truncated:true) records the drop honestly for readers of the array.
  const HISTORY_CAP = 120;
  function capHistory(ws) {
    if (!ws || !Array.isArray(ws.history)) return;
    // count only real dialogue turns (skip a prior truncation marker) so the marker never inflates the count
    const real = ws.history.filter(m => !(m && m.truncated));
    if (real.length <= HISTORY_CAP) { if (real.length !== ws.history.length) ws.history = real; return; }
    const dropped = real.length - HISTORY_CAP;
    const kept = real.slice(-HISTORY_CAP);
    ws.history = [{ role: 'system', truncated: true, content: '…(' + dropped + ' earlier turn' + (dropped === 1 ? '' : 's') + ' trimmed from local history)' }].concat(kept);
  }
  // the outbound window: the messages actually POSTed as `messages`. Drops the local-only truncation marker (the
  // server never expects it) and hard-caps to HISTORY_CAP dialogue turns as a belt-and-suspenders bound.
  function historyWindow(ws) {
    if (!ws || !Array.isArray(ws.history)) return [];
    const real = ws.history.filter(m => !(m && m.truncated));
    return real.length > HISTORY_CAP ? real.slice(-HISTORY_CAP) : real;
  }
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
  // A1: skill-flavored tool beats. The skill.* tools ride the ordinary agent.tool_call chip, but a raw
  // "skill.view {name:…}" reads as noise. Re-label them in the agent's own voice so the Commander SEES the
  // agent consulting/writing its skillbase — pure rendering over the existing event (no new bus traffic).
  //   skill.view  → consulting skill: <name>      skill.list   → scanning skill index
  //   skill.manage(create/edit/patch) → wrote skill <name> → SKILLS menu   (write actions only)
  // Returns { label, glyph } to override the chip head, or null for a non-skill / read-shaped call.
  function skillFlavor(ev) {
    const canon = shortName(ev && ev.name);   // skill_view / skill.view → skill.view
    if (canon.indexOf('skill.') !== 0) return null;
    const kind = canon.slice('skill.'.length);
    let args = {}; try { args = JSON.parse(ev.argsSummary || '{}') || {}; } catch (_) { args = {}; }
    const nm = String(args.name || args.target || '').trim();
    const nmTail = nm ? (': ' + brief(nm)) : '';
    if (kind === 'view' || kind === 'write' && !nm) return { label: 'consulting skill' + nmTail, glyph: '▤' };
    if (kind === 'list') return { label: 'scanning skill index', glyph: '▤' };
    if (kind === 'write') return { label: 'wrote skill' + (nm ? ' ' + brief(nm) : '') + ' → SKILLS menu', glyph: '✎' };
    if (kind === 'manage') {
      const action = String(args.action || '').toLowerCase();
      const WRITE = { create: 1, edit: 1, patch: 1, archive: 1, restore: 1, pin: 1, unpin: 1, write_file: 1, remove_file: 1 };
      if (WRITE[action]) {
        const verb = action === 'create' || action === 'edit' || action === 'patch' ? 'wrote skill' : action.replace(/_/g, ' ') + ' skill';
        return { label: verb + (nm ? ' ' + brief(nm) : '') + ' → SKILLS menu', glyph: '✎' };
      }
      return { label: 'tending the skillbase' + nmTail, glyph: '▤' };   // delete has no returned name; still legible
    }
    return null;
  }
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
    const flav = skillFlavor(ev);   // A1: skill.* tools re-labelled in the agent's voice
    const chip = document.createElement('div'); chip.className = 'tool-chip pending' + (flav ? ' skill' : '');
    chip.setAttribute('aria-expanded', 'false');
    const head = document.createElement('button'); head.type = 'button'; head.className = 'tc-head';
    const glyph = document.createElement('span'); glyph.className = 'tc-glyph'; glyph.textContent = flav ? flav.glyph : '▸';
    const nm = document.createElement('span'); nm.className = 'tc-name'; nm.textContent = flav ? flav.label : shortName(ev.name);
    // for a flavored skill chip the human phrase already carries the skill name, so the raw args stay in the
    // expand detail only (kept below) — the chip head is clean.
    const args = document.createElement('span'); args.className = 'tc-args'; args.textContent = (!flav && ev.argsSummary) ? brief(ev.argsSummary) : '';
    const stat = document.createElement('span'); stat.className = 'tc-stat'; stat.textContent = '';   // filled by resolveChip
    head.appendChild(glyph); head.appendChild(nm); if (args.textContent) head.appendChild(args); head.appendChild(stat);
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
      fileBlobUrl(title, agentId).then(u => { try { window.open(u, '_blank', 'noopener'); } catch (_) {} })
        .catch(() => { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('could not open that file — the sidecar may be unreachable', 'warn'); });
    });
  }

  // ── "OPEN FOLDER" AFFORDANCE (Theme 4: outputs are findable) ──────────────────────────────────
  // A deliverable landed on disk in the agent's workspace; a beginner needs to be able to FIND it.
  // The absolute per-agent dir comes from the additive /api/workspace/dir route (the frontend otherwise
  // only knows the relative filename). On desktop we try a native reveal-in-folder command IF the shell
  // ever exposes one (starnet_reveal_path), and ALWAYS fall back to copying the real path; in the browser
  // there is no filesystem to open, so the button copies the path. Truthful: the button does exactly what
  // its label says — it never claims to open a folder it can't.
  const _wsDirCache = new Map();   // agentId -> Promise<absolute dir | ''>
  function workspaceDir(agentId) {
    const aid = agentId || 'agent';
    if (_wsDirCache.has(aid)) return _wsDirCache.get(aid);
    const tok = (typeof Harness !== 'undefined' && Harness.apiToken) ? String(Harness.apiToken() || '') : '';
    const p = fetch('/api/workspace/dir?agent=' + encodeURIComponent(aid) + (tok ? '&token=' + encodeURIComponent(tok) : ''), { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null).then(j => (j && j.dir) ? String(j.dir) : '').catch(() => '');
    _wsDirCache.set(aid, p);
    return p;
  }
  function tauriCore() {
    return (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
  }
  // Build a small "📁 folder" control. `relPath` (optional) is the deliverable's own path so a future
  // native reveal can select the file; today it reveals/copies the containing workspace dir.
  function folderButton(agentId, relPath) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'deliverable-folder';
    b.textContent = '📁 folder';
    const desktop = !!tauriCore();
    b.title = desktop ? 'reveal this deliverable’s folder on disk' : 'copy the folder path on disk';
    let dirP = null;
    b.addEventListener('click', () => {
      if (!dirP) dirP = workspaceDir(agentId);
      dirP.then(dir => {
        if (!dir) { b.textContent = '📁 no path'; setTimeout(() => { b.textContent = '📁 folder'; }, 1400); return; }
        const core = tauriCore();
        if (core && core.invoke) {
          // native reveal IF the shell exposes it; otherwise fall through to copy (never a silent no-op)
          Promise.resolve(core.invoke('starnet_reveal_path', { path: dir })).then(() => {
            b.textContent = '📁 opened'; setTimeout(() => { b.textContent = '📁 folder'; }, 1400);
          }).catch(() => copyPathFeedback(b, dir));
        } else {
          copyPathFeedback(b, dir);
        }
      });
    });
    return b;
  }
  function copyPathFeedback(btn, dir) {
    copyText(dir).then(ok => {
      btn.textContent = ok ? '📁 path copied' : '📁 ' + dir;
      setTimeout(() => { btn.textContent = '📁 folder'; }, 1600);
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
    r.body.appendChild(folderButton(agentId, title));             // Theme 4: make the file findable on disk
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
  // CLIENT-SIDE MEDIA KIND, keyed off the file extension (the reference harness's extension-keyed media model): the backend doesn't
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
  // (e.g. an .mkv/.avi the browser won't play), mirroring the reference harness's OpenMediaButton.
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
    return U.usd(v);                                         // canonical spend formatter (util.js)
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
    // click-to-copy of the deliverable's own (relative) path — kept for quick reference.
    const cp = document.createElement('button'); cp.type = 'button'; cp.className = 'recap-copy';
    cp.textContent = '⧉'; cp.title = 'copy path: ' + path;
    cp.onclick = () => copyText(path).then(ok => { if (!ok) return; cp.textContent = '✓'; setTimeout(() => { cp.textContent = '⧉'; }, 1100); });
    d.appendChild(cp);
    // Theme 4: an "open folder" affordance that resolves the REAL absolute workspace dir on disk
    // (desktop reveals if the shell supports it; browser copies the path) so the file is findable.
    if (a.kind !== 'message') d.appendChild(folderButton(agentId, path));
    return d;
  }
  const RECAP_MAX_ROWS = 12;   // a monster run lists the first dozen + a "+N more" note (the RUNS panel has the rest)
  function recapCard(entry, arts, agentId, durMs, runId) {
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
    // G5 SPECTACLE — the SHAREABLE POSTCARD affordance. A quiet button on the recap card (NOT the one post-run
    // beat slot — the recap deliberately never claims it): capture the live station scene + this run's REAL
    // summary + the agent's honest growth into a draggable/saveable PNG. Fail-open: absent module = no button.
    if (typeof Postcard !== 'undefined' && Postcard.capture) {
      const share = document.createElement('button'); share.type = 'button'; share.className = 'recap-postcard';
      share.textContent = '⎙ postcard'; share.title = 'save a shareable PNG of this run';
      share.onclick = () => firePostcard(entry, arts, agentId, durMs, share);
      r.body.appendChild(share);
    }
    // G5 SPECTACLE slice 2 — the SHAREABLE CLIP affordance (⏺). Sibling of ⎙ postcard, same quiet chrome, same
    // "never the beat slot" rule. Only shown when this run actually captured floor frames (the ring was armed for
    // a task run AND held frames at run end) — a run with nothing recorded gets no dead button. Mints the ~10s GIF.
    const frames = (runId && runClip.has(runId)) ? runClip.get(runId) : null;
    if (typeof Clip !== 'undefined' && Clip.capture && frames && frames.length) {
      const rec = document.createElement('button'); rec.type = 'button'; rec.className = 'recap-clip';
      rec.textContent = '⏺ clip'; rec.title = 'save a shareable ~10s GIF of this run';
      rec.onclick = () => fireClip(entry, arts, agentId, durMs, frames, rec);
      r.body.appendChild(rec);
    }
    autoscroll();
  }

  /* Mint the shareable CLIP for a completed run. Feeds the Clip reducer ONLY provable telemetry (the same run
     entry the postcard uses) plus the run's captured floor frames; the overlay carries NO XP delta (XP mints only
     from user feedback, so it is unknowable at clip time). Encodes the GIF in-page (no network) + downloads it. */
  function fireClip(entry, arts, agentId, durMs, frames, btn) {
    const agent = (typeof App !== 'undefined' && App.currentAgent) ? App.currentAgent() : null;
    const run = {
      reason: entry.reason, title: entry.title,
      artifacts: Array.isArray(arts) ? arts : (entry.artifacts || []),
      usd: entry.usd, unmetered: entry.unmetered, model: entry.model, tokens: entry.tokens,
    };
    // a throwaway recorder-shaped view over the already-captured frames (Clip.capture reads .frames()/.fps()).
    const view = { frames: () => frames, fps: () => (typeof Clip !== 'undefined' ? Clip.DEFAULT_FPS : 10) };
    if (btn) { btn.disabled = true; btn.textContent = '⏺ encoding…'; }
    // encode off the paint path so the button repaint lands first (GIF encode is a few hundred ms of array math).
    setTimeout(() => {
      Clip.capture({ run: run, durMs: durMs, agent: agent, recorder: view })
        .then(res => {
          if (btn) { btn.textContent = '⏺ saved'; btn.title = res.name + ' — ' + res.frames + ' frames · ' + res.seconds + 's'; }
          if (typeof SFX !== 'undefined' && SFX.click) { try { SFX.click(); } catch (_) {} }
        })
        .catch(() => {
          if (btn) { btn.disabled = false; btn.textContent = '⏺ clip'; }
          if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('could not save the clip — try again', 'warn');
        });
    }, 20);
  }

  /* Capture the postcard for a completed run. Assembles ONLY provable numbers (the Postcard reducer decides
     inclusion): the run entry's real reason/title/artifacts/cost/duration/model/tokens, the hero's honest
     Level/lifetime from Xp.compute(agent.stats), and the lifetime station record from PrideStore.snapshot().
     The scene is the live #stage canvas pixels at click time. Downloads the PNG + shows a brief inline stamp. */
  function firePostcard(entry, arts, agentId, durMs, btn) {
    const agent = (typeof App !== 'undefined' && App.currentAgent) ? App.currentAgent() : null;
    const pride = (typeof PrideStore !== 'undefined' && PrideStore.snapshot) ? PrideStore.snapshot() : null;
    const run = {
      reason: entry.reason, title: entry.title,
      artifacts: Array.isArray(arts) ? arts : (entry.artifacts || []),
      usd: entry.usd, unmetered: entry.unmetered, model: entry.model, tokens: entry.tokens,
    };
    if (btn) { btn.disabled = true; btn.textContent = '⎙ …'; }
    Postcard.capture({ run: run, durMs: durMs, agent: agent, pride: pride })
      .then(res => {
        if (btn) { btn.textContent = '⎙ saved'; btn.title = res.name; }
        if (typeof SFX !== 'undefined' && SFX.click) { try { SFX.click(); } catch (_) {} }
      })
      .catch(() => { if (btn) { btn.disabled = false; btn.textContent = '⎙ postcard'; } });
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
      recapCard(entry, arts, agentId, durMs, runId);
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
      if (isActiveWs(ws)) renderPresence();   // drop the paused styling the instant the run resumes
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
    if (typeof StationUI !== 'undefined') StationUI.notify(name + ' needs approval to ' + actionPhrase(p), 'warn', 'needsApproval');   // P1-8 category: consent prompt
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
    // P3.2 CREW-RUN RATEABILITY — if this LEAD run dispatched crew whose spend is provable, split the SAME verdict
    // across them HONESTLY: each worker earns a cost-proportional share of the size-weighted mint (crewSplit), riding
    // the identical direct memory.feedback path into ITS OWN XpStore identity. Truthful attribution: a worker earns
    // only when the harness proved its contribution (usd > 0); if no split is provable, no worker is credited and
    // nothing false is said. The LEAD keeps its full delta above (it owns + synthesized the run). Only hero-lead runs
    // carry crew (runCrew is populated only for agentId 'agent'). Fail-open — a missing split never blocks the rating.
    try {
      const crew = (agentId || 'agent') === 'agent' ? runCrew.get(runId) : null;
      if (crew && crew.length && typeof Xp !== 'undefined' && Xp.crewSplit && typeof XpStore !== 'undefined' && XpStore.onEvent) {
        const split = Xp.crewSplit({ leadDelta: delta, leadCost: (w && w.cost) || 0, workers: crew });
        for (const wk of split.workers) {
          if (!wk || !wk.agentId) continue;
          // a worker's share rides the SAME synthetic-id mint path — its own agentId resolves to its roster stats.
          XpStore.onEvent('memory.feedback', { agentId: wk.agentId, id: 'work:' + runId + ':' + wk.agentId, runId: runId, delta: wk.delta, reason: reason, size: wk.size });
        }
      }
    } catch (_) {}
    // G3a confidence narrative: the same DIRECT hand-off (this verdict never rides the bus, so the fire-once
    // calibration/TRUSTED beats must be told here, AFTER the meter folded). Speaks at most twice, ever; mints nothing.
    if (typeof ConfBeats !== 'undefined' && ConfBeats.onFeedback) { try { ConfBeats.onFeedback({ agentId: agentId || 'agent', id: 'work:' + runId, delta: delta, reason: reason }); } catch (_) {} }
    // GROWTH Tier 1 §4 — RATINGS → TASTE: fold this verdict into the per-archetype streak; a fresh 3-streak mints
    // ONE style-dim study proposal (Commander consistently likes/dislikes <archetype> work), surfaced at the same
    // one beat. The archetype is classified from the run's directive (RUN_META.title). Fail-open.
    try { const rm = runMeta(runId); maybeTasteBeat(agentId, runId, rm && rm.title, verdict); } catch (_) {}
    // R2: same DIRECT hand-off; 👍 corroborates / 👎 counter-evidences the style-model confidence (re-aims the VOI ask).
    if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.noteRating) { try { UnderstandingStore.noteRating(verdict); } catch (_) {} }
    // R5 "BOTTLE A RUN": a 👍 ('great') verdict on a real interactive run (not recipe-launched, not cron) may earn a
    // one-time "bottle it as a recipe?" offer — SAME direct hand-off (this verdict never rides the bus). BottleStore
    // gates on the run's honest info (via App.runBottleInfo → RUN_META) and defers behind the shared beat slot; it
    // mints nothing here (the editor confirm does that). Fail-open — a bottle offer is never load-bearing. Placed
    // AFTER the taste beat so this verdict's other one-beat consumers keep their precedence; BottleStore's own slot
    // guards (busy / a live rate|turn-in control) already stop it from stacking on any beat still on screen.
    if (typeof BottleStore !== 'undefined' && BottleStore.onVerdict) { try { BottleStore.onVerdict(runId, verdict, agentId || 'agent'); } catch (_) {} }
    // P3.1 RE-SUMMON SIGNAL: a 👍 on a real interactive run may earn a one-time "run it again?" beat — SAME direct
    // hand-off, SAME shared gold-inset slot + defer-not-stack discipline as BottleStore. Bottle and re-summon are
    // BOTH 👍-triggered offers competing for the ONE post-run beat, so they must be MUTUALLY EXCLUSIVE per run:
    // BottleStore keeps priority (the marketplace-growth signal). We fire re-summon ONLY when bottle will NOT offer
    // for this run — computed synchronously via BottleStore's pure gate on the run's honest info — so a given 👍
    // run shows at most ONE of the two (never a bottle→re-summon double-ask, never a slot clobber). A recipe-launched
    // run (bottle stands down: it already IS a recipe) is exactly where re-summon shines. Fail-open.
    if (typeof ResummonStore !== 'undefined' && ResummonStore.onVerdict) {
      try {
        let bottleWillOffer = false;
        if (typeof BottleStore !== 'undefined' && BottleStore.shouldOffer && typeof App !== 'undefined' && App.runBottleInfo && BottleStore.isDecided && BottleStore._state) {
          const bs = BottleStore._state(); const bi = App.runBottleInfo(runId);
          bottleWillOffer = !!(bi && !BottleStore.isDecided(bs, runId) && BottleStore.shouldOffer(bs, verdict, bi));
        }
        if (!bottleWillOffer) ResummonStore.onVerdict(runId, verdict, agentId || 'agent');
      } catch (_) {}
    }
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
    const usd = (+rw.usd > 0) ? (' · ' + U.usd(+rw.usd)) : '';
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
    if (blocked) {   // defer — a gate is up (interview / focused panel / live turn-in / welcome-back nudge).
      // "deferred" must NEVER become "lost": the crates are already pending in the OUTBOX (ReturnStore
      // folded them before this beat), but the digest beat itself keeps waiting for a free moment.
      // Fast cadence (7s) while the moment is likely to free soon, then a low-frequency retry (60s) that
      // never gives up — same DELAY-but-never-STARVE law as armRateFallback. Fires exactly once (anti-nag:
      // once it renders below, it returns and there is no re-fire path).
      const t = (_try || 0);
      const delay = t < 25 ? 7000 : 60000;
      setTimeout(() => awayDigest(rows, opts, t + 1), delay);
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
    // ADOPTION (Lane F): a dim line so dismissing doesn't read as LOSING the runs — they wait on the OUTBOX crate.
    if (typeof ReturnStore !== 'undefined' && ReturnStore.outboxLine) {
      const keep = document.createElement('span'); keep.className = 'turnin-queue'; keep.textContent = ReturnStore.outboxLine();
      foot.appendChild(keep);
    }
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

  /* W3 — THE AWAY-WORKSHOP RETURN CARD. On attach, WorkshopStore polls /api/workshop/pending and hands ONE
     undecided manifest here. Same gold-inset family + the ONE post-run beat slot every return beat rides:
     it DEFERS (bounded, never starved — awayDigest cadence) behind a live run / the awakening / a focused
     panel / a live turn-in or nudge, then renders exactly once. Collapsed = a one-glance headline with an
     "open" affordance; expanded = a two-pane viewer (manifest summary + jailed file browser) and EXACTLY
     three one-click actions: Keep (default-Desktop path input → decide keep), Later (dismiss, may return
     next session), Discard (single confirm → decide discard). Decided cards vanish().
     TRUTHFUL TELEMETRY: the verification line renders "tested — N passed" ONLY from a real manifest.verified
     block; absent → "built, not yet tested". The card never asserts status the manifest doesn't prove.
     opts: { onDecide(decision, destPath) -> Promise<{ok,destPath?,error?}>, readFile(agentId,runId,path)
             -> Promise<string>, desktopDefault: string }. */
  function workshopReturn(m, opts, _try) {
    if (!log || !m || !m.runId) return;
    opts = opts || {};
    const onDecide = opts.onDecide || (() => Promise.resolve({ ok: true }));
    const blocked = isBusy() || interview || activeTurnin || activeNudge
      || (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning())
      || (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning())
      || (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen());
    if (blocked) {   // defer — DELAY but never STARVE (same law as awayDigest): fast retry, then slow, never gives up.
      const t = (_try || 0);
      setTimeout(() => workshopReturn(m, opts, t + 1), t < 25 ? 7000 : 60000);
      return;
    }
    const agentId = m.agentId || 'agent';
    const who = (agentId === 'agent') ? name : agentId;
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('workshop-return');

    // ── collapsed headline (one glance) ──
    const title = document.createElement('span'); title.className = 'turnin-title';
    title.textContent = '◈ while you were away — ' + who + ' built: ' + String(m.title || 'a deliverable');
    r.body.appendChild(title);

    // HONEST verification line — proves off the manifest ONLY. Three truthful states:
    //   1. the manifest recorded verify commands  → "tested — N of M passed" (+ per-command detail in the pane)
    //   2. the agent flagged things a human must check (notVerified) → say so, don't imply failure
    //   3. neither                                → "built — no test commands were defined"
    // NOTE: today's workshop agent cannot run commands (it is told so in workshopPrompt), so a real manifest
    // carries no verified.commands — the notVerified path is the common case. State 1 is future-proofing for
    // when a shift can run tests; it never fabricates a result the manifest doesn't hold.
    const ver = document.createElement('span'); ver.className = 'ws-verline';
    const vcmds = (m.verified && Array.isArray(m.verified.commands)) ? m.verified.commands.filter(c => c && c.cmd) : null;
    const notVer = Array.isArray(m.notVerified) ? m.notVerified.filter(Boolean) : [];
    if (vcmds && vcmds.length) {
      const passed = vcmds.filter(c => Number(c.exit) === 0).length;
      ver.textContent = 'tested — ' + passed + ' of ' + vcmds.length + ' command' + (vcmds.length > 1 ? 's' : '') + ' passed';
      ver.classList.add(passed === vcmds.length ? 'ok' : 'dim');
    } else if (notVer.length) {
      ver.textContent = 'built — the agent couldn’t test here; ' + notVer.length + ' thing' + (notVer.length > 1 ? 's' : '') + ' for you to check';
      ver.classList.add('dim');
    } else {
      ver.textContent = 'built — no test commands were defined';
      ver.classList.add('dim');
    }
    r.body.appendChild(ver);

    const slot = document.createElement('div'); slot.className = 'ws-slot';
    r.body.appendChild(slot);

    const foot = document.createElement('div'); foot.className = 'turnin-rate';
    const openBtn = document.createElement('button'); openBtn.className = 'consent-btn'; openBtn.textContent = 'review';
    foot.appendChild(openBtn);
    r.body.appendChild(foot);
    autoscroll();

    let expanded = false, settled = false;
    const settle = (label, isDeny) => {
      if (settled) return; settled = true;
      slot.innerHTML = ''; foot.remove();
      const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = label;
      r.body.appendChild(tag);
      setTimeout(() => vanish(r.d), 900);   // flash the outcome, then the decided card leaves
    };

    openBtn.onclick = () => {
      if (expanded) return; expanded = true;
      foot.remove();
      renderExpanded();
      autoscroll();
    };

    function renderExpanded() {
      slot.innerHTML = '';
      const pane = document.createElement('div'); pane.className = 'ws-panes';

      // ── pane 1: manifest summary ──
      const sum = document.createElement('div'); sum.className = 'ws-pane ws-summary';
      const mkLine = (k, v) => { if (!v) return; const d = document.createElement('div'); d.className = 'ws-line';
        const kk = document.createElement('span'); kk.className = 'ws-k'; kk.textContent = k;
        const vv = document.createElement('span'); vv.className = 'ws-v'; vv.textContent = v;
        d.appendChild(kk); d.appendChild(vv); sum.appendChild(d); };
      mkLine('kind', m.kind || 'other');
      mkLine('what', m.summary || '');
      mkLine('how to use', m.howToUse || '');
      if (Array.isArray(m.notVerified) && m.notVerified.length) mkLine('not verified', m.notVerified.join('; '));
      // per-command verification detail: the ACTUAL commands run + each one's pass/fail from the manifest
      // (renders only when the manifest actually recorded them — never invents a command or a result).
      if (vcmds && vcmds.length) {
        const vd = document.createElement('div'); vd.className = 'ws-verdetail';
        const vh = document.createElement('div'); vh.className = 'ws-k'; vh.textContent = 'verification'; vd.appendChild(vh);
        vcmds.forEach(c => {
          const ok = Number(c.exit) === 0;
          const line = document.createElement('div'); line.className = 'ws-vcmd ' + (ok ? 'ok' : 'bad');
          const mark = document.createElement('span'); mark.className = 'ws-vmark'; mark.textContent = ok ? '✓' : '✕';
          const cmd = document.createElement('code'); cmd.className = 'ws-vcmdtext'; cmd.textContent = String(c.cmd);
          line.appendChild(mark); line.appendChild(cmd);
          if (!ok && c.exit != null) { const ex = document.createElement('span'); ex.className = 'ws-vexit'; ex.textContent = 'exit ' + c.exit; line.appendChild(ex); }
          vd.appendChild(line);
        });
        sum.appendChild(vd);
      }
      pane.appendChild(sum);

      // ── pane 2: jailed file browser ──
      const fb = document.createElement('div'); fb.className = 'ws-pane ws-files';
      const fhead = document.createElement('div'); fhead.className = 'ws-fhead'; fhead.textContent = 'files';
      fb.appendChild(fhead);
      const list = document.createElement('div'); list.className = 'ws-flist';
      const view = document.createElement('pre'); view.className = 'ws-fview'; view.textContent = '(select a file)';
      const files = Array.isArray(m.files) ? m.files : [];
      if (!files.length) { const e = document.createElement('div'); e.className = 'dim'; e.textContent = '(no files listed)'; list.appendChild(e); }
      files.forEach(f => {
        if (!f || !f.path) return;
        const b = document.createElement('button'); b.className = 'ws-file'; b.type = 'button';
        b.textContent = f.path + (f.bytes != null ? '  ·  ' + f.bytes + 'B' : '');
        b.onclick = async () => {
          list.querySelectorAll('.ws-file.sel').forEach(x => x.classList.remove('sel'));
          b.classList.add('sel');
          view.textContent = 'loading…';
          let content = '';
          try { content = opts.readFile ? await opts.readFile(agentId, m.runId, f.path) : ''; } catch (_) { content = ''; }
          view.textContent = content || '(no preview available)';
        };
        list.appendChild(b);
      });
      fb.appendChild(list); fb.appendChild(view);
      pane.appendChild(fb);
      slot.appendChild(pane);

      // ── three actions, one row ──
      const acts = document.createElement('div'); acts.className = 'turnin-rate ws-acts';
      // KEEP — pick a destination folder. On desktop we offer a native folder picker (Tauri) IF the shell
      // exposes one, and ALWAYS keep the typed path as a fallback with INLINE validation (does the folder
      // exist? — asked of the sidecar) so a bad path is caught before Keep instead of failing silently.
      const keepWrap = document.createElement('span'); keepWrap.className = 'ws-keep';
      const path = document.createElement('input'); path.className = 'turnin-edit ws-path'; path.type = 'text';
      path.placeholder = 'folder to copy into'; path.value = opts.desktopDefault || '';
      path.setAttribute('aria-label', 'Destination folder to keep the deliverable in');
      const hint = document.createElement('span'); hint.className = 'ws-pathhint'; hint.hidden = true;
      const keepBtn = document.createElement('button'); keepBtn.className = 'consent-btn'; keepBtn.textContent = 'Keep';

      // inline validation: debounced dirstat; a nonexistent/typo'd folder shows a quiet warning (never blocks —
      // keep still creates the folder, but the Commander sees the truth about their path first).
      let validateTimer = null;
      function validatePath() {
        const dest = String(path.value || '').trim();
        if (!dest) { hint.hidden = true; return; }
        fetch('/api/fs/dirstat?path=' + encodeURIComponent(dest), { cache: 'no-store' })
          .then(r => r.ok ? r.json() : null).then(j => {
            if (!j) { hint.hidden = true; return; }
            if (j.exists && j.isDir) { hint.hidden = true; }
            else if (j.exists && !j.isDir) { hint.hidden = false; hint.textContent = '⚠ that path is a file, not a folder'; }
            else { hint.hidden = false; hint.textContent = '⚠ that folder doesn’t exist yet — it will be created'; }
          }).catch(() => { hint.hidden = true; });
      }
      path.addEventListener('input', () => { if (validateTimer) clearTimeout(validateTimer); validateTimer = setTimeout(validatePath, 400); });

      const core = tauriCore();
      let pickBtn = null;
      if (core && core.invoke) {
        pickBtn = document.createElement('button'); pickBtn.className = 'consent-btn ws-pick'; pickBtn.textContent = '📁 choose…';
        pickBtn.title = 'pick a folder';
        pickBtn.onclick = () => {
          Promise.resolve(core.invoke('starnet_pick_folder', {})).then(dir => {
            if (dir) { path.value = String(dir); validatePath(); }
          }).catch(() => { /* shell has no picker yet — the typed path is the fallback */ path.focus(); });
        };
      }

      keepBtn.onclick = async () => {
        const dest = String(path.value || '').trim();
        if (!dest) { path.focus(); return; }
        keepBtn.disabled = true; keepBtn.textContent = 'keeping…';
        let res = null; try { res = await onDecide('keep', dest); } catch (_) { res = { ok: false }; }
        if (res && res.ok) settle('✓ kept — files copied to ' + (res.destPath || dest), false);
        else { keepBtn.disabled = false; keepBtn.textContent = 'Keep'; localLine('Could not keep this: ' + ((res && res.error) || 'the station refused the copy') + '.'); }
      };
      keepWrap.appendChild(path); if (pickBtn) keepWrap.appendChild(pickBtn); keepWrap.appendChild(keepBtn); keepWrap.appendChild(hint);
      acts.appendChild(keepWrap);

      // LATER — dismiss; the card may return next session (no confirm).
      const laterBtn = document.createElement('button'); laterBtn.className = 'consent-btn'; laterBtn.textContent = 'Later';
      laterBtn.onclick = async () => { try { await onDecide('later'); } catch (_) {} settle('↩ left in the workshop', false); };
      acts.appendChild(laterBtn);

      // DISCARD — the ONE confirm (single click to arm, second to confirm). decide discard → wipe + denylist.
      const discardBtn = document.createElement('button'); discardBtn.className = 'consent-btn deny'; discardBtn.textContent = 'Discard';
      let armed = false;
      discardBtn.onclick = async () => {
        if (!armed) { armed = true; discardBtn.textContent = 'Discard — sure?'; setTimeout(() => { if (!settled) { armed = false; discardBtn.textContent = 'Discard'; } }, 4000); return; }
        discardBtn.disabled = true;
        let res = null; try { res = await onDecide('discard'); } catch (_) { res = { ok: false }; }
        if (res && res.ok) settle('✕ discarded', true);
        else { discardBtn.disabled = false; armed = false; discardBtn.textContent = 'Discard'; localLine('Could not discard this: ' + ((res && res.error) || 'the station kept it') + '.'); }
      };
      acts.appendChild(discardBtn);
      slot.appendChild(acts);
    }
  }

  // Cortex (M-mem.5b) — THE TURN-IN BEAT. After a run, reflection proposes durable memories; the Commander
  // decides Keep / Edit / Discard. Keep/Edit commit a real memory (the click IS the consent, §5.6); every
  // verdict feeds the agent's confidence. This is the gamified formation loop — the agent learns, you approve.
  function proposalCard(batch, ws) {
    if (!batch || !batch.proposals || !batch.proposals.length) return;
    clearNudge();   // ONE post-run beat at a time: the turn-in owns the moment, so retire any curiosity nudge that beat it here
    if (activeTurnin && (!activeTurnin.node || !activeTurnin.node.isConnected)) activeTurnin = null;
    // one visible consent beat, EVER: a deck arriving over another deck OR over a live STUDY card queues (the
    // beat-slot arbiter is consulted so a memory deck can never stack on a study card — it renders the moment
    // the card resolves; memory keeps priority via the queue-first drain in the study card's done()). A deck
    // arriving over a FOCUSED FLOW (awakening/intake question, Dialogue panel) queues too — memory wins the
    // post-run moment, but never by stacking on top of a question the Commander is mid-answering.
    if (activeTurnin || turninBlocked() || slotMemoryDeck() === 'queue') {
      turninQueue.push(batch);
      updateTurninQueueNote();
      autoscroll();
      armTurninDrain();
      return;
    }
    renderTurninBatch(batch);
  }

  function updateTurninQueueNote() {
    if (!activeTurnin || !activeTurnin.queueNote) return;
    const waiting = turninQueue.length;
    // A passive counter (NOT a second beat — one-beat-at-a-time is untouched): naming that another
    // follow-up is queued keeps the ~1-2s inter-beat gap from reading as a hang/crash to a beginner.
    activeTurnin.queueNote.textContent = waiting
      ? (waiting === 1 ? '1 more follow-up after this…' : waiting + ' more follow-ups after this…')
      : '';
    activeTurnin.queueNote.hidden = !waiting;
  }

  // the FOCUSED-FLOW gate for the memory deck: an interview question (awakening/intake) or a focused Dialogue
  // panel owns the input AND the moment — the deck queues behind it. Mirrors studyBlocked MINUS isBusy: the
  // turn-in deliberately still renders while the next run streams (memory wins the post-run moment).
  function turninBlocked() {
    if (interview) return true;
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return true;
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return true;
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return true;
    return false;
  }
  // bounded re-drain for a deck queued behind a focused flow: endInterview kicks the queue immediately; this
  // retry covers the Dialogue-close and onboarding-end paths (delayed, never starved — armRateFallback-style).
  let turninDrainTimer = null;
  function armTurninDrain(tries) {
    if (turninDrainTimer) return;
    const t = (tries == null) ? 200 : tries;   // ~5min at 1.5s cadence
    if (t <= 0) return;
    turninDrainTimer = setTimeout(() => { turninDrainTimer = null; showNextTurnin(t - 1); }, 1500);
  }
  function showNextTurnin(drainTries) {
    if (activeTurnin) return;
    if (!turninQueue.length) return;
    if (turninBlocked()) { armTurninDrain(drainTries); return; }
    const next = turninQueue.shift();
    if (next) renderTurninBatch(next);
  }

  function renderTurninBatch(batch) {
    if (beatSlot) beatSlot.memoryShown();   // hard-claim the beat slot on EVERY deck-render path (idempotent)
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
      slotMemoryDone(batch.runId, turninQueue.length > 0);   // release (or hand on) the beat slot + clear this run's pending claim
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
    // TWO triggers, ONE fetch+route (deduped per-run by proposalRunsSeen):
    //  - memory.proposed fires ONLY for HIGH-STAKES proposals (the rare-confirm deck). It reserves the beat slot
    //    BEFORE the fetch so study/arc/trust cede across the proposed→fetch→deck window (the fetch-gap race).
    //  - memory.write fires for the SILENTLY AUTO-SAVED memories (the common case). Those render a PASSIVE receipt
    //    that must NOT claim the beat slot — so this trigger reserves nothing.
    // A MIXED batch (some high-stakes) fires both; the shared guard renders it once (receipts + deck together).
    U.bus.on('memory.proposed', p => {
      const runId = p && p.runId; const agentId = (p && p.agentId) || 'agent';
      if (!runId || proposalRunsSeen.has(runId)) return;
      proposalRunsSeen.add(runId);
      slotMemoryProposed(runId);   // reserve the slot for the coming confirm deck (released if the fetch is deck-empty)
      setTimeout(() => routeProposalBatch(runId, agentId, true), 350);
    });
    U.bus.on('memory.write', p => {
      const runId = p && p.runId; const agentId = (p && p.agentId) || 'agent';
      // dedup vs BOTH the deck path (proposalRunsSeen, set by memory.proposed) and this receipt path. Deliberately
      // NOT added to proposalRunsSeen: a passive receipt is not a review DECK, so it must not suppress the run's
      // curiosity/suggestion nudge (the wireCuriosity guard keys on proposalRunsSeen = "a deck owns the moment").
      if (!runId || proposalRunsSeen.has(runId) || receiptRunsSeen.has(runId)) return;
      receiptRunsSeen.add(runId);
      if (receiptRunsSeen.size > 200) receiptRunsSeen.delete(receiptRunsSeen.values().next().value);
      // NO slot reservation — receipts are passive log lines. A tiny debounce lets the per-record memory.write
      // events + the server-side batch stash settle before the single fetch (mirrors the proposed path's 350ms).
      setTimeout(() => routeProposalBatch(runId, agentId, false), 350);
    });
  }

  // fetch the run's batch and route it: SAVED items (saved:true) render passive receipts; PENDING items (the
  // high-stakes fallback) render the Keep/Edit/Discard confirm deck. `reservedSlot` = memory.proposed already
  // claimed the beat slot for a deck; if the fetch yields no deck items, release it.
  async function routeProposalBatch(runId, agentId, reservedSlot) {
    // MIXED-BATCH RACE: the server emits memory.write (auto-saves) BEFORE memory.proposed (high-stakes) for the
    // same run, so both triggers can schedule a route before either fires. At fire time the deck route owns the
    // whole render (receipts + deck together); the receipt-only route bails so nothing draws twice.
    if (!reservedSlot && proposalRunsSeen.has(runId)) return;
    const items = await Harness.memoryProposals(runId, agentId);
    const saved = items.filter(p => p && p.saved);
    const pending = items.filter(p => p && !p.saved);
    // route to the ORIGIN stream (many streams share agentId 'agent', so agentId-gating can drop the card into
    // the wrong COMMS after a mid-window switch).
    let originWs = null;
    if (typeof Workstreams !== 'undefined' && Workstreams.all) { try { originWs = Workstreams.all().find(w => (w.runIds || []).indexOf(runId) >= 0) || null; } catch (_) {} }
    const onActive = originWs ? (activeWs && activeWs.id === originWs.id) : (activeWs && (activeWs.agentId || 'agent') === agentId);

    if (onActive && saved.length) renderReceipts({ runId, agentId, proposals: saved });   // passive — no beat slot
    else if (saved.length && typeof StationUI !== 'undefined') {
      // origin stream not displayed (or gone): don't lose the transparency signal — the memories ARE saved, so
      // surface a soft notify instead of a receipt (Memory Core shows the records; ✕ undo lives there too).
      StationUI.notify('an agent remembered ' + saved.length + ' ' + (saved.length > 1 ? 'things' : 'thing'), 'gold');
    }
    if (pending.length) {
      const deck = { runId, agentId, proposals: pending };
      if (onActive) proposalCard(deck, activeWs);
      else {
        slotMemoryEmpty(runId);   // release the reserved claim — no deck renders on a non-displayed stream
        if (typeof StationUI !== 'undefined') StationUI.notify('an agent has ' + pending.length + ' ' + (pending.length > 1 ? 'memories' : 'memory') + ' to review', 'gold');
        maybeStandaloneRate(agentId, runId);
      }
    } else {
      // no deck will render. Release any reserved slot so study/arc/trust aren't wedged, and make sure the run's
      // rating still fires (the receipt carries no rate control — that lives on the standalone beat / deck).
      if (reservedSlot) slotMemoryEmpty(runId);
      maybeStandaloneRate(agentId, runId);
    }
  }

  // PASSIVE RECEIPT (silent-save UX): one compact non-blocking line per auto-saved memory — "◈ remembered: <text>"
  // + kind tag + a small ✕ veto. It does NOT claim the one-beat slot, does not wait for input, and stays in the
  // stream as a quiet log line (no auto-collapse). The ✕ UNDOES the save (record removed + text denylisted); the
  // line then shows a muted "✕ forgotten" (Memory Core Restore is the undo-for-the-undo). Reuses the gold-inset
  // turn-in visual family. Receipts render even during a focused flow (interview/onboarding) — they're passive
  // and carry no input to compete with, so unlike the confirm deck they don't gate behind turninBlocked().
  function renderReceipts(batch) {
    if (!batch || !batch.proposals || !batch.proposals.length) return;
    const head = row('agent'); head.d.classList.add('tool'); head.d.classList.add('turnin'); head.d.classList.add('receipts');
    for (const prop of batch.proposals) {
      const item = document.createElement('div'); item.className = 'receipt-item';
      const kind = document.createElement('span'); kind.className = 'turnin-kind'; kind.textContent = KIND_TAG[prop.kind] || 'NOTE';
      const text = document.createElement('span'); text.className = 'receipt-text'; text.textContent = '◈ remembered: ' + prop.content;
      const veto = document.createElement('button'); veto.className = 'receipt-veto'; veto.type = 'button';
      veto.textContent = '✕'; veto.title = 'forget this — undo the save';
      veto.setAttribute('aria-label', 'forget this memory');
      let busy = false;
      veto.onclick = async () => {
        if (busy) return; busy = true; veto.disabled = true;
        const r = await Harness.memoryVeto({ agentId: batch.agentId, id: prop.id, kind: prop.kind, content: prop.content });
        if (r && r.ok) {
          veto.remove();
          item.classList.add('vetoed');
          text.textContent = '✕ forgotten: ' + prop.content;   // muted state; stays denylisted (Memory Core Restore is the undo)
        } else {
          busy = false; veto.disabled = false;
          if (typeof StationUI !== 'undefined') StationUI.notify('could not forget that ' + (prop.kind === 'skill' ? 'skill' : 'memory') + ' - try again', 'warn');
        }
      };
      item.appendChild(kind); item.appendChild(text); item.appendChild(veto);
      head.body.appendChild(item);
    }
    autoscroll();
  }

  // R1 MID-TASK FORK — the answer that IS work: render the agent's preference fork as one-tap chips. The
  // pick does double duty — it banks as a Commander-authored STYLE belief (full confidence weight: given in
  // context, about a real decision, immediately acted on; + the R4 receipt proves it stuck) AND continues
  // the conversation as the Commander's next message so the task proceeds with it. "you decide" banks
  // nothing and hands the choice back. One fork per reply by construction (parse reads the first marker).
  function offerFork(fk) {
    const items = fk.options.map(o => ({ label: o, value: o }));
    items.push({ label: 'you decide', value: '', skip: true });
    const q = row('agent'); q.d.classList.add('nudge');
    q.body.textContent = '⌖ ' + fk.question;
    autoscroll();
    choices(items, item => {
      vanish(q.d);
      const ans = (item && !item.skip) ? String(item.value || '').trim() : '';
      if (ans) {
        try {
          const bt = Fork.beliefText ? Fork.beliefText(fk.question, ans) : ans;
          if (bt && typeof DossierStore !== 'undefined' && DossierStore.upsert) {
            DossierStore.upsert('style', { text: bt, source: 'commander' });
            briefingReceipt('style');
            // re-read NOW so the gate re-evaluates before the continuation run composes its prompt —
            // one banked answer usually grounds the style model and retires the fork directive.
            if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.refresh) { try { UnderstandingStore.refresh(false); } catch (_) {} }
          }
        } catch (_) {}
      }
      const msg = ans || 'either works — your call.';
      if (!isBusy()) send(msg); else echoUser(msg);   // continue the task with the answer (busy = a rare race; the echo still records it)
    });
  }

  // R4 PAYOFF RECEIPT: one provable line at the exact moment an answer/observation lands in the dossier, so
  // feeding the station visibly pays off. Truthful by construction: the dossier block folds into EVERY agent's
  // system prompt (DossierStore.composeBlock), so "every agent now knows" states the wiring, not a wish. Same
  // passive gold-inset receipt family as renderReceipts — never claims the beat slot, carries no input. No veto:
  // the dossier belief it points at is edited/forgotten in the COMMANDER panel, which stays the one owner of undo.
  function briefingReceipt(dim) {
    try {
      const d = (typeof Dossier !== 'undefined' && Dossier.DIMS) ? Dossier.DIMS.find(x => x.key === dim) : null;
      const label = d ? String(d.label).toLowerCase() : 'profile';
      const head = row('agent'); head.d.classList.add('tool'); head.d.classList.add('turnin'); head.d.classList.add('receipts');
      const item = document.createElement('div'); item.className = 'receipt-item';
      const kind = document.createElement('span'); kind.className = 'turnin-kind'; kind.textContent = 'BRIEFING';
      const text = document.createElement('span'); text.className = 'receipt-text';
      text.textContent = '◈ briefing updated — every agent on this station now knows your ' + label + '.';
      item.appendChild(kind); item.appendChild(text);
      head.body.appendChild(item);
      autoscroll();
    } catch (_) {}
  }

  /* GROWTH Tier 1 — THE STUDY BEAT (dossier Phase B: work → understanding). After a salient run the sidecar
     studies the transcript and stashes DOSSIER belief-update proposals; here we fetch them and — at TURN-IN
     PRIORITY but NEVER stacking a second beat — offer ONE for Keep / Edit / Discard. Keep folds the belief into
     the dossier (source:'study'); Discard denylists it forever; leaving it undecided tallies an ignore (2× =
     stop). ONE-BEAT DISCIPLINE: the memory turn-in and the study card arrive on different clocks (memory.proposed
     lands only after reflection's LLM round-trip), so both sides route every render/queue decision through the
     PURE beat-slot arbiter (Study.makeBeatSlot — behaviorally tested in study.test.js). MEMORY WINS: while any
     reflection is proposed-but-unresolved study cedes; a memory deck arriving over a visible study card QUEUES
     and renders the moment the card resolves; a deferred study re-offers at the next task end. */
  const STUDY_ARM_MS = 12000;        // arm the study offer WELL after run end so reflection's memory.proposed (an LLM
                                     // round-trip away) claims the moment first; the beat-slot closes the residual race.
  let beatSlot = null;               // the pure one-beat arbiter (created per session in init; null-safe wrappers below)
  let activeStudy = null;            // the single visible study card { node, prop, decided } — one at a time
  const studyPending = [];           // {runId, agentId} study offers deferred behind a busy moment — FIFO, retried next run end
  const tastePending = [];           // ready-made taste proposals (from a ratings streak) waiting for a free beat — FIFO
  function studyBusy() { return !!(activeStudy && activeStudy.node && activeStudy.node.isConnected); }
  // null-safe slot wrappers (Study may be absent under old bundles — memory then behaves exactly as before).
  function slotMemoryProposed(runId) { if (beatSlot) beatSlot.memoryProposed(runId); }
  function slotMemoryDeck() { return beatSlot ? beatSlot.memoryDeck() : 'render'; }
  function slotMemoryDone(runId, more) { if (beatSlot) beatSlot.memoryDone(runId, more); }
  function slotMemoryEmpty(runId) { if (beatSlot) beatSlot.memoryEmpty(runId); }
  function slotCanStudy() { return beatSlot ? beatSlot.canStudy() : 'busy'; }   // no arbiter -> study stands down
  function slotStudyShown() { if (beatSlot) beatSlot.studyShown(); }
  function slotStudyDone(more) { if (beatSlot) beatSlot.studyDone(more); }
  // GROWTH Tier 2 — the goal-arc confirm beat: the LOWEST-priority participant (memory turn-in + study both win
  // first). null arbiter OR an older bundle without canArc -> arc stands down (byte-identical pre-Tier-2 behavior).
  function slotCanArc() { return (beatSlot && beatSlot.canArc) ? beatSlot.canArc() : 'busy'; }
  function slotArcShown() { if (beatSlot && beatSlot.arcShown) beatSlot.arcShown(); }
  function slotArcDone(more) { if (beatSlot && beatSlot.arcDone) beatSlot.arcDone(more); }
  // GROWTH Tier 3 — the earned-autonomy offer beat: the LOWEST-priority participant (memory + study + arc all win
  // first). null arbiter OR an older bundle without canTrust -> trust stands down (byte-identical pre-Tier-3 behavior).
  function slotCanTrust() { return (beatSlot && beatSlot.canTrust) ? beatSlot.canTrust() : 'busy'; }
  function slotTrustShown() { if (beatSlot && beatSlot.trustShown) beatSlot.trustShown(); }
  function slotTrustDone(more) { if (beatSlot && beatSlot.trustDone) beatSlot.trustDone(more); }
  // the same stand-down guards the curiosity slot honors (First Pitch lesson): a study card must never render
  // mid-awakening/interview/tutorial-panel or while the next run is already streaming. Blocked = queue, not drop.
  function studyBlocked() {
    if (isBusy() || interview) return true;
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return true;
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return true;
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return true;
    return false;
  }
  // defer a study offer for a later moment — SINGLE queue path, FIFO, deduped by runId (no double-queue).
  function queueStudy(runId, agentId) {
    if (!runId) return;
    for (const q of studyPending) if (q.runId === runId) return;
    studyPending.push({ runId: runId, agentId: agentId });
  }
  // FINDING-4 lifecycle: an undecided study card from a PRIOR task end EXPIRES when a new task ends — that is the
  // "ignored" verdict (2× = stop proposing that belief) — and releases the slot so queued beats can't starve.
  function expireActiveStudy() {
    if (!activeStudy) return;
    const a = activeStudy;
    if (!a.node || !a.node.isConnected) { activeStudy = null; slotStudyDone(turninQueue.length > 0); return; }   // COMMS re-rendered under it
    if (a.decided) return;   // mid-settle — its own 600ms timer is about to close it
    activeStudy = null;
    try { if (a.prop && typeof StudyStore !== 'undefined' && StudyStore.ignore) StudyStore.ignore(a.prop); } catch (_) {}
    slotStudyDone(turninQueue.length > 0);
    vanish(a.node, () => { if (turninQueue.length && !activeTurnin) showNextTurnin(); });
  }
  // render ONE study proposal as a gold-inset turn-in card (Keep / Edit / Discard). Mirrors renderTurninBatch's
  // family but routes consent to StudyStore (the dossier write is client-side; the server batch is consumed via
  // /api/study/resolve inside StudyStore). Returns true iff the card actually rendered.
  function studyCard(prop, agentId, runId) {
    if (!log || !prop || typeof StudyStore === 'undefined') return false;
    // a RETIRE card must show the Commander the ACTUAL belief it will delete — re-resolve the (never-pinned)
    // target at render time; if the dossier changed and nothing (unpinned) matches anymore, there is no card.
    let target = null;
    if (prop.kind === 'retire') {
      target = (typeof StudyStore.retireTarget === 'function') ? StudyStore.retireTarget(prop) : null;
      if (!target) return false;
    }
    clearNudge();                      // claim the one post-run beat slot, retiring any gentle nudge
    if (typeof StudyStore.markShown === 'function') StudyStore.markShown();   // spend one session-cap slot
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('study');
    const dimName = (typeof Dossier !== 'undefined' && Dossier.DIMS) ? ((Dossier.DIMS.find(d => d.key === prop.dim) || {}).label || prop.dim) : prop.dim;
    const verb = prop.kind === 'retire' ? 'thinks one of your beliefs no longer holds' : 'learned something about your ' + String(dimName).toLowerCase();
    const title = document.createElement('span'); title.className = 'turnin-title';
    title.textContent = '◈ ' + name + ' ' + verb + ' — keep it?';
    const slotEl = document.createElement('span'); slotEl.className = 'turnin-slot';
    r.body.appendChild(title); r.body.appendChild(slotEl);
    const item = document.createElement('div'); item.className = 'turnin-item';
    const kind = document.createElement('span'); kind.className = 'turnin-kind'; kind.textContent = prop.kind === 'retire' ? 'RETIRE' : String(dimName).toUpperCase();
    // the card's main text is what will actually happen: the belief to be ADDED, or (retire) the EXACT stored
    // belief that would be deleted — never just the model's paraphrase of it.
    const text = document.createElement('span'); text.className = 'turnin-text';
    text.textContent = prop.kind === 'retire' ? target.text : prop.text;
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    item.appendChild(kind); item.appendChild(text); item.appendChild(btns);
    // provenance line: the model's reasoning (for a retire) + the directive this was observed from.
    const why = [];
    if (prop.kind === 'retire') why.push(prop.text);
    if (prop.evidence) why.push('from “' + prop.evidence + '”');
    if (why.length) { const ev = document.createElement('div'); ev.className = 'turnin-queue'; ev.hidden = false; ev.textContent = '↳ ' + why.join(' · '); item.appendChild(ev); }
    slotEl.appendChild(item);
    const card = { node: r.d, prop: prop, decided: false };
    activeStudy = card;
    slotStudyShown();
    function done() {
      if (activeStudy === card) activeStudy = null;
      slotStudyDone(turninQueue.length > 0);
      // hand the moment to a memory deck that queued behind this card (memory wins; no study chains here —
      // at most ONE study proposal per task end, the next deferred one waits for the next run end).
      vanish(r.d, () => { if (turninQueue.length && !activeTurnin) showNextTurnin(); });
    }
    function settle(label, isDeny) {
      card.decided = true; btns.remove();
      const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = label;
      item.appendChild(tag);
      setTimeout(done, 600);
    }
    function commit(verdict, editedText) {
      if (card.decided) return;
      if (verdict === 'keep') {
        const ok = StudyStore.accept(prop, editedText, agentId);
        if (!ok) { settle('✕ couldn’t apply — it changed', true); return; }   // honest: never flash "✓ retired" on a failed write
        settle(prop.kind === 'retire' ? '✓ retired' : (editedText != null ? 'saved (edited)' : 'kept'), false);
        if (prop.kind !== 'retire') briefingReceipt(prop.dim);   // R4: a KEPT observation visibly propagates ("now in every agent's briefing"); a retire removes knowledge — nothing new to announce
        return;
      }
      StudyStore.discard(prop, agentId); settle('✕ discarded', true);
    }
    function renderChoices() {
      btns.innerHTML = '';
      const mk = (lbl, cls, fn) => { const b = document.createElement('button'); b.className = 'consent-btn' + (cls ? ' ' + cls : ''); b.textContent = lbl; b.onclick = fn; btns.appendChild(b); };
      mk(prop.kind === 'retire' ? 'Retire it' : 'Keep', '', () => commit('keep'));
      if (prop.kind !== 'retire') mk('Edit', '', enterEdit);
      mk('Discard', 'deny', () => commit('discard'));
    }
    function enterEdit() {
      if (card.decided) return;
      const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'turnin-edit'; inp.value = prop.text;
      item.replaceChild(inp, text); inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) {}
      const commitEdit = () => { const v = inp.value.trim(); if (!v) { inp.focus(); return; } text.textContent = v; item.replaceChild(text, inp); commit('keep', v); };
      const cancel = () => { item.replaceChild(text, inp); renderChoices(); };
      btns.innerHTML = '';
      const mk = (lbl, fn) => { const b = document.createElement('button'); b.className = 'consent-btn'; b.textContent = lbl; b.onclick = fn; btns.appendChild(b); };
      mk('Save', commitEdit); mk('Cancel', cancel);
      inp.onkeydown = e => { if (e.key === 'Enter') commitEdit(); else if (e.key === 'Escape') cancel(); };
    }
    renderChoices();
    autoscroll();
    return true;
  }
  // try to place ONE deferred beat (a ready taste proposal first, else the OLDEST deferred study — FIFO) now
  // that a new task end may have freed the moment. Never chains: one card per flush.
  function flushStudyPending() {
    if (typeof StudyStore === 'undefined' || studyBusy() || slotCanStudy() !== 'free' || studyBlocked()) return;
    if (!StudyStore.canShow || !StudyStore.canShow()) return;
    if (tastePending.length) { const t = tastePending.shift(); if (t && studyCard(t, 'agent', null)) return; }
    if (studyPending.length) { const next = studyPending.shift(); if (next) offerStudy(next.runId, next.agentId); }
  }
  // fetch + offer ONE live study proposal for a run, obeying the one-beat arbiter + stand-down guards + session
  // cap. Any blocked moment QUEUES (single path, FIFO, deduped) — deferred, never starved, never stacked.
  async function offerStudy(runId, agentId) {
    if (typeof StudyStore === 'undefined') return;
    if (studyBusy() || slotCanStudy() !== 'free' || studyBlocked()) { queueStudy(runId, agentId); return; }
    if (!StudyStore.canShow || !StudyStore.canShow()) return;                    // session cap spent (per-session, not deferrable)
    const proposals = await StudyStore.fetchProposals(runId, agentId);
    const prop = StudyStore.nextLive(proposals);   // drops resolved/declined/ignored + unmatchable retires
    if (!prop) return;
    // re-check the moment after the async fetch — reflection's memory.proposed may have claimed it meanwhile.
    if (studyBusy() || slotCanStudy() !== 'free' || studyBlocked()) { queueStudy(runId, agentId); return; }
    studyCard(prop, agentId, runId);
  }
  function wireStudy() {
    if (studyWired || typeof U === 'undefined' || !U.bus) return;
    studyWired = true;
    U.bus.on('agent.run.end', p => {
      if (!p || p.reason !== 'done') return;                       // only after a clean run
      if ((p.agentId || 'agent') !== 'agent') return;             // hero runs only (a summoned worker never study-nudges)
      const runId = p.runId || p.id;
      // a new task ended: the PREVIOUS task's undecided study card expires as an "ignore" (finding-4 lifecycle),
      // then one deferred beat may take the freed moment (anti-starve). Short delay = after the reply renders.
      setTimeout(() => { expireActiveStudy(); flushStudyPending(); }, 900);
      // THIS run's own study offer arms much later (STUDY_ARM_MS): reflection's memory.proposed is a whole LLM
      // round-trip away, and MEMORY WINS the moment — by then the beat-slot knows whether reflection claimed it.
      setTimeout(() => {
        if (!runId || studyRunsSeen.has(runId)) return;            // fetch a run's study proposals at most once
        studyRunsSeen.add(runId);
        if (studyRunsSeen.size > 200) studyRunsSeen.delete(studyRunsSeen.values().next().value);
        offerStudy(runId, p.agentId || 'agent');
      }, STUDY_ARM_MS);
    });
  }

  /* GROWTH Tier 2 — THE GOAL-ARC CONFIRM BEAT (understanding → direction). When a goals-dim belief exists with no
     goal tree, the station proposes a decomposition (3-5 milestones) and asks the Commander to Confirm / Edit /
     Not-now — a focused Dialogue panel, exactly like the First Pitch. It is the LOWEST post-run priority: it arms
     AFTER the study offer (ARC_ARM_MS > STUDY_ARM_MS) and only takes a WHOLLY FREE beat slot (slotCanArc() ===
     'free' — memory turn-in + study both win first), obeying the SAME stand-down guards as the study/curiosity
     beats (studyBlocked). Confirm persists the tree (GoalStore.confirm); Not-now re-offers only when the belief
     changes (GoalStore.declineDecomposition). One confirm per task end, never stacked (the shared arbiter). */
  const ARC_ARM_MS = 14000;   // later than STUDY_ARM_MS (12000): the arc yields the moment to memory AND study
  function arcBlocked() {
    // the SAME stand-down set the study beat honors (a confirm panel must never render mid-awakening/interview/
    // tutorial-panel or while the next run streams). Reuses studyBlocked for one home for the guard set.
    if (typeof studyBlocked === 'function') return studyBlocked();
    return isBusy() || interview;
  }
  async function offerArc() {
    if (typeof GoalStore === 'undefined' || typeof Dialogue === 'undefined') return;
    if (!GoalStore.willOfferDecomposition || !GoalStore.willOfferDecomposition()) return;
    if (slotCanArc() !== 'free' || arcBlocked()) return;   // the LOWEST priority: a taken/blocked moment just drops (re-offers next run end)
    if (GoalStore.isFiring && GoalStore.isFiring()) return;
    GoalStore.setFiring && GoalStore.setFiring(true);
    try {
      const res = await GoalStore.proposeDecomposition();   // the aux model call (reason-only) + parse
      if (!res || !res.belief || !Array.isArray(res.texts) || res.texts.length < 3) return;   // no usable path — stay un-offered so a later belief change retries
      // re-check the moment after the async model round-trip — memory/study may have claimed it meanwhile.
      if (slotCanArc() !== 'free' || arcBlocked()) return;
      clearNudge();                 // claim the one post-run beat, retiring any gentle nudge
      slotArcShown();
      let path = res.texts.slice();
      try {
        Dialogue.open({ name: (name || 'AGENT') });
        await Dialogue.say('i think i see the path to that goal — here’s how i’d break it down. does this look right?');
        const linesOf = ts => ts.map((t, i) => (i + 1) + '. ' + t).join('\n');
        // Confirm / Not-now + an ✎ EDIT custom path (allowCustom): typing a revised path (steps separated by a
        // newline OR a semicolon) replaces it, then re-applies the pure floor/cap on Confirm. The custom text is
        // user-typed (never model markup); Dialogue renders it via textContent only.
        const choice = await Dialogue.node({
          lines: linesOf(path),
          options: [ { label: 'confirm the path', value: 'confirm' }, { label: 'not now', value: 'other', skip: true } ],
          allowCustom: true, customLabel: '✎ edit the milestones', customPlaceholder: 'your milestones, separated by ; …'
        });
        if (Dialogue.isOpen && Dialogue.isOpen()) Dialogue.close();
        // route the choice through the PURE resolver (Goals.resolveConfirmChoice, behaviorally tested): an explicit
        // Confirm or a VALID edit (≥3 steps) persists; a too-short edit is a REJECTION of the model tree and
        // declines — the unedited path is never silently persisted. Not-now declines (re-offer only on belief change).
        const decision = (typeof Goals !== 'undefined' && Goals.resolveConfirmChoice)
          ? Goals.resolveConfirmChoice(choice, path)
          : { action: (choice && choice.value === 'confirm') ? 'confirm' : 'decline', path: path };
        if (decision.action === 'confirm') {
          const g = GoalStore.confirm(res.belief, decision.path);
          if (g) {
            if (typeof SFX !== 'undefined' && SFX.quest) { try { SFX.quest(); } catch (_) {} }
            if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('◇ goal path set — track it under ⚑ QUESTS', 'gold');
          }
        } else {
          GoalStore.declineDecomposition(res.belief);   // not-now / rejected edit: re-offer only when the belief changes (never nag)
        }
      } finally {
        // release the moment — and if a memory deck QUEUED behind this panel (a late memory.proposed during a
        // minutes-long confirm), HAND it the slot and render it now (mirrors studyCard's done()): the consent deck
        // must never sit invisible while its pendingMemory claim freezes the study/arc lanes.
        slotArcDone(turninQueue.length > 0);
        try { if (Dialogue.isOpen && Dialogue.isOpen()) Dialogue.close(); } catch (_) {}
        if (turninQueue.length && !activeTurnin) showNextTurnin();
      }
    } catch (_) {
    } finally {
      GoalStore.setFiring && GoalStore.setFiring(false);
    }
  }
  function wireArc() {
    if (arcWired || typeof U === 'undefined' || !U.bus) return;
    arcWired = true;
    U.bus.on('agent.run.end', p => {
      if (!p || p.reason !== 'done') return;                       // only after a clean run
      if ((p.agentId || 'agent') !== 'agent') return;             // hero runs only
      const runId = p.runId || p.id;
      // arms LAST (ARC_ARM_MS): memory turn-in + the study offer both claim the moment first; only a wholly free
      // slot at this point lets the confirm panel open (slotCanArc gate inside offerArc).
      setTimeout(() => {
        if (runId && arcRunsSeen.has(runId)) return;
        if (runId) { arcRunsSeen.add(runId); if (arcRunsSeen.size > 200) arcRunsSeen.delete(arcRunsSeen.values().next().value); }
        offerArc();
      }, ARC_ARM_MS);
    });
  }

  /* GROWTH Tier 3 — THE EARNED-AUTONOMY OFFER BEAT (track record → trust). After a clean run, if the demonstrated
     track record has crossed the thresholds (TrustStore/trust.js), the station offers to raise the autonomy dial
     ONE rung (or pre-bless a GRANTABLE capability) — a one-tap consent card, NEVER a silent escalation. It is the
     LOWEST post-run priority: it arms AFTER the arc (TRUST_ARM_MS > ARC_ARM_MS) and only takes a WHOLLY FREE beat
     slot (slotCanTrust() === 'free' — memory turn-in, study, AND the arc all win first), obeying the SAME stand-down
     guards as the other beats (studyBlocked). Accept applies the earned rung with provenance (TrustStore.accept →
     the existing AutonomyStore/permgrants plumbing); Not-yet declines (stop offering that rung this level band);
     leaving it undecided tallies an ignore (2× in a band = stop). One trust offer per session (TrustStore cap). */
  const TRUST_ARM_MS = 16000;   // later than ARC_ARM_MS (14000): the trust offer yields the moment to memory, study AND the arc
  function trustBusy() { return !!(activeTrust && activeTrust.node && activeTrust.node.isConnected); }
  // an undecided trust card from a PRIOR task end EXPIRES when a new task ends — that's the "ignored" verdict
  // (2× in a band = stop) — and releases the slot so queued beats can't starve (mirrors expireActiveStudy).
  function expireActiveTrust() {
    if (!activeTrust) return;
    const a = activeTrust;
    if (!a.node || !a.node.isConnected) { activeTrust = null; slotTrustDone(turninQueue.length > 0); return; }   // COMMS re-rendered under it
    if (a.decided) return;   // mid-settle — its own timer is about to close it
    activeTrust = null;
    try { if (a.offer && typeof TrustStore !== 'undefined' && TrustStore.ignore) TrustStore.ignore(a.offer); } catch (_) {}
    slotTrustDone(turninQueue.length > 0);
    vanish(a.node, () => { if (turninQueue.length && !activeTurnin) showNextTurnin(); });
  }
  // render ONE trust offer as a gold-inset beat card (Accept / Not yet). Mirrors studyCard's family + lifecycle
  // discipline exactly (the finally-hands-off-to-queued-memory pattern both prior review rounds hit). textContent
  // only for the dynamic copy. Returns true iff the card actually rendered.
  function trustCard(offer) {
    if (!log || !offer || typeof TrustStore === 'undefined') return false;
    clearNudge();                      // claim the one post-run beat slot, retiring any gentle nudge
    if (typeof TrustStore.markShown === 'function') TrustStore.markShown();   // spend the one session-cap slot
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('trust');
    const title = document.createElement('span'); title.className = 'turnin-title';
    title.textContent = '◈ ' + name + ' has earned your trust';
    const slotEl = document.createElement('span'); slotEl.className = 'turnin-slot';
    r.body.appendChild(title); r.body.appendChild(slotEl);
    const item = document.createElement('div'); item.className = 'turnin-item';
    const kind = document.createElement('span'); kind.className = 'turnin-kind'; kind.textContent = offer.kind === 'grant' ? 'GRANT' : 'AUTONOMY';
    // the ask, composed from the REAL track record (task count + satisfaction %) — never fabricated.
    const pv = offer.provenance || {};
    const ask = offer.kind === 'grant'
      ? (pv.runs || 0) + ' tasks, ' + (pv.confidence || 0) + '% satisfaction — trust me to write files on my own?'
      : (pv.runs || 0) + ' tasks, ' + (pv.confidence || 0) + '% satisfaction — grant me free rein on small jobs?';
    const text = document.createElement('span'); text.className = 'turnin-text'; text.textContent = ask;
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    item.appendChild(kind); item.appendChild(text); item.appendChild(btns);
    // provenance line: the honest track record behind the offer (streak + what it raises to).
    const why = [];
    if (pv.streak) why.push(pv.streak + ' approvals in a row');
    why.push(offer.kind === 'grant' ? 'writes stay jailed + reversible' : 'raises the dial to ' + String(offer.to).toUpperCase());
    { const ev = document.createElement('div'); ev.className = 'turnin-queue'; ev.hidden = false; ev.textContent = '↳ ' + why.join(' · '); item.appendChild(ev); }
    slotEl.appendChild(item);
    const card = { node: r.d, offer: offer, decided: false };
    activeTrust = card;
    slotTrustShown();
    function done() {
      if (activeTrust === card) activeTrust = null;
      slotTrustDone(turninQueue.length > 0);
      // hand the moment to a memory deck that queued behind this card (mirrors studyCard's done()).
      vanish(r.d, () => { if (turninQueue.length && !activeTurnin) showNextTurnin(); });
    }
    function settle(label, isDeny) {
      card.decided = true; btns.remove();
      const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = label;
      item.appendChild(tag);
      setTimeout(done, 600);
    }
    function commit(verdict) {
      if (card.decided) return;
      if (verdict === 'accept') {
        // ASYNC-SAFE ACCEPT (review fix 2): a grant accept resolves against the server — disable the buttons while
        // pending (no double-tap, no decline-during-apply) and mark the card decided NOW (the user answered; an
        // expiry sweep must not tally an "ignore" under an in-flight accept). Settle only on the VERIFIED result.
        card.decided = true;
        btns.querySelectorAll('button').forEach(b => { b.disabled = true; });
        Promise.resolve(TrustStore.accept(offer)).then(ok => {
          if (!ok) { settle('✕ couldn’t apply', true); return; }   // honest: never flash "✓ granted" on a failed/unverified apply
          settle(offer.kind === 'grant' ? '✓ granted' : '✓ ' + String(offer.to).toLowerCase(), false);
          if (typeof SFX !== 'undefined' && SFX.level) { try { SFX.level(); } catch (_) {} }
          if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(offer.kind === 'grant' ? '◈ earned — it may write files on its own now (revoke any time in Settings)' : '◈ earned — autonomy raised to ' + String(offer.to).toUpperCase() + ' (adjust any time in Settings)', 'gold');
          // if the Settings AUTONOMY panel is open, repaint its EARNED badge live (fail-open no-op otherwise).
          if (typeof StationUI !== 'undefined' && StationUI.repaintAutonomy) { try { StationUI.repaintAutonomy(); } catch (_) {} }
        }).catch(() => { settle('✕ couldn’t apply', true); });
        return;
      }
      TrustStore.decline(offer); settle('✕ not yet', true);
    }
    const mk = (lbl, cls, fn) => { const b = document.createElement('button'); b.className = 'consent-btn' + (cls ? ' ' + cls : ''); b.textContent = lbl; b.onclick = fn; btns.appendChild(b); };
    mk('Accept', '', () => commit('accept'));
    mk('Not yet', 'deny', () => commit('decline'));
    autoscroll();
    return true;
  }
  // fetch + offer ONE live trust offer for a run, obeying the one-beat arbiter + stand-down guards + session cap.
  // The LOWEST priority: a taken/blocked moment just DROPS (it re-offers at the next task end — a rung offer is
  // rare by construction, so it need not queue like study/taste; anti-nag).
  function offerTrust() {
    if (typeof TrustStore === 'undefined') return;
    if (trustBusy() || slotCanTrust() !== 'free' || studyBlocked()) return;
    if (!TrustStore.canShow || !TrustStore.canShow()) return;        // session cap spent
    const offer = TrustStore.currentOffer ? TrustStore.currentOffer() : null;
    if (!offer) return;
    trustCard(offer);
  }
  function wireTrust() {
    if (trustWired || typeof U === 'undefined' || !U.bus) return;
    trustWired = true;
    U.bus.on('agent.run.end', p => {
      if (!p || p.reason !== 'done') return;                       // only after a clean run
      if ((p.agentId || 'agent') !== 'agent') return;             // hero runs only (a summoned worker never trust-offers)
      const runId = p.runId || p.id;
      // a new task ended: the PREVIOUS task's undecided trust card expires as an "ignore", freeing the slot.
      setTimeout(() => { expireActiveTrust(); }, 900);
      // THIS run's own offer arms LAST (TRUST_ARM_MS): memory turn-in + study + the arc all claim the moment first;
      // only a wholly free slot at this point lets the offer open (slotCanTrust gate inside offerTrust).
      setTimeout(() => {
        if (runId && trustRunsSeen.has(runId)) return;
        if (runId) { trustRunsSeen.add(runId); if (trustRunsSeen.size > 200) trustRunsSeen.delete(trustRunsSeen.values().next().value); }
        offerTrust();
      }, TRUST_ARM_MS);
    });
  }
  // GROWTH Tier 1 §4 — RATINGS → TASTE: after a work verdict folds, a 3-streak on one archetype may mint a
  // style-dim taste proposal. Surfaced through the SAME study card (one beat), obeying the same gates. Called
  // from rateWork with the run's directive (for the archetype) + the verdict.
  function maybeTasteBeat(agentId, runId, directive, verdict) {
    if (typeof StudyStore === 'undefined' || typeof Study === 'undefined') return;
    const arch = Study.classifyArchetype(directive || '');
    const prop = StudyStore.noteRating(arch, verdict);   // persists the streak; returns a proposal only on a fresh 3-streak
    if (!prop) return;
    // ride the one-beat discipline: if the moment is taken/blocked, queue it (FIFO; drained at the next task end).
    setTimeout(() => {
      if (studyBusy() || slotCanStudy() !== 'free' || studyBlocked() || !StudyStore.canShow()) { tastePending.push(prop); return; }
      studyCard(prop, agentId || 'agent', runId);
    }, 300);
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
      const a = activeNudge; activeNudge = null;   // answered → release the post-run beat slot (the choice row removes itself)
      if (a) vanish(a.row);   // decided beats LEAVE: the prompt goes with its chips, never lingers over what follows
      if (item.value === 'yes' && typeof Intake !== 'undefined' && typeof Dossier !== 'undefined') {
        const skip = Dossier.DIM_KEYS.filter(k => k !== dim);   // ask ONLY this dimension (plan() returns just its question)
        Intake.start({
          skip: skip,
          onCommit: b => { if (typeof DossierStore !== 'undefined') DossierStore.upsert(b.dim, { text: b.text, source: 'curiosity' }); if (typeof CuriosityStore !== 'undefined' && CuriosityStore.markAnswered) CuriosityStore.markAnswered(b.dim); briefingReceipt(b.dim); },   // R4: the answer visibly pays off — one provable "now in every agent's briefing" line (this was the ONE commit path with zero acknowledgment)
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
    const choiceRow = choices(options || [], item => {
      const a = activeNudge; activeNudge = null;
      if (a) vanish(a.row);   // decided beats LEAVE (same law as the curiosity nudge — no stacked residue)
      try { if (onPick) onPick(item); } catch (_) {}
    });
    activeNudge = { row: r.d, choiceRow: choiceRow, dim: null };   // share the curiosity-nudge lifecycle so a turn-in's clearNudge() retires a suggestion beat too (keeps "one beat at a time")
    return { row: r.d, choiceRow: choiceRow };
  }

  // ADAPTIVE RECRUITMENT beat: propose the single NEW teammate the Commander's real workflow points to, ONCE per
  // session, through the shared gentle nudge (so it rides the same one-beat-at-a-time lifecycle + vanish()). The
  // WHY is the exact same honest, counter-derived line the bay's CURATED shelf shows (both read RecruiterStore) —
  // so the beat and the shelf can never disagree. Accepting deep-links into the recruitment bay's summon flow.
  // Returns true iff a beat was actually shown (so the caller can claim the slot). Never fabricates: a cold/thin
  // signal → RecruiterStore.topPick() is null → this is a no-op and the chain falls through to curiosity.
  function maybeRecruit() {
    if (recruitShown) return false;                                        // one recruit offer per session (anti-nag)
    if (typeof RecruiterStore === 'undefined' || !RecruiterStore.topPick) return false;
    if (typeof App === 'undefined' || !App.openSummonBay) return false;    // no deep-link target → don't offer
    let pick = null; try { pick = RecruiterStore.topPick(); } catch (_) { return false; }
    if (!pick || !pick.spec) return false;                                 // not warm / nobody to recommend honestly
    const name = pick.spec.name || pick.classId;
    // the line: name the class + its honest, real-counter why. Lower-cased why joins mid-sentence cleanly.
    const line = '✦ your crew could use a ' + name + ' — ' + String(pick.why || '').replace(/^./, c => c.toLowerCase());
    recruitShown = true;                                                   // spend the session's single recruit offer (even on dismiss — never re-ask this session)
    if (typeof SFX !== 'undefined' && SFX.idea) { try { SFX.idea(); } catch (_) {} }   // same soft chime as the idea beat
    nudge(line, [{ label: 'meet them', value: 'go' }, { label: 'not now', value: 'no', skip: true }], choice => {
      if (choice && choice.value === 'go') { try { App.openSummonBay(); } catch (_) {} }
    });
    return true;
  }

  /* A2 — THE SKILL ASIDE. When the quiet background review distills a completed run into a saved skill it fires
     the EXISTING `deliverable` (kind:'skill') event (see skillreview.makeReviewObserver). Here we surface ONE
     gentle, NON-interactive gold-inset aside — "◈ <agent> distilled this run into skill: <name>" — so the
     Commander SEES the agent grow its own skillbase. HARD anti-nag / one-beat discipline:
       • it is INFORMATIONAL (no choice row), so it never claims the post-run ask slot; if a real beat
         (memory turn-in / study card / suggestion / curiosity nudge) is live or in flight, the aside is DROPPED
         — never queued, never stacked over another beat (COMMS beat rules).
       • deduped by deliverable id (the review can re-fire), and suppressed when an IN-RUN skill.* tool call just
         rendered its own A1 chip for the same save — no double surface.
     The aside auto-vanishes so it leaves no residue in the feed. */
  function skillBeatBusy() {
    // any live/in-flight ask beat owns the moment — the aside must stand down (drop).
    if (isBusy() || interview) return true;
    if (activeNudge) return true;                                   // a gentle suggestion/curiosity beat is up
    if (activeTurnin || turninQueue.length) return true;            // a memory-review deck is live/queued
    if (typeof studyBusy === 'function' && studyBusy()) return true;// a study card is visible
    if (beatSlot && beatSlot.visibleBeat()) return true;            // the arbiter says a beat holds the slot
    if (beatSlot && beatSlot.canStudy && beatSlot.canStudy() !== 'free') return true;   // reflection in flight → memory wins
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return true;
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return true;
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return true;
    return false;
  }
  function skillAside(skillName, agentId) {
    if (!log) return false;
    const who = name || 'the agent';   // the module's live agent name — the aside only renders on this agent's own stream
    const r = row('agent'); r.d.classList.add('nudge'); r.d.classList.add('skill-aside');
    r.body.textContent = '◈ ' + who + ' distilled this run into skill: ' + brief(String(skillName || 'a new skill'));
    autoscroll();
    // fleeting: fade it out after a beat so it never lingers as a fake unresolved card.
    setTimeout(() => { try { vanish(r.d); } catch (_) {} }, 9000);
    return true;
  }
  function wireSkillAside() {
    if (skillAsideWired || typeof U === 'undefined' || !U.bus) return;
    skillAsideWired = true;
    U.bus.on('deliverable', p => {
      if (!p || p.kind !== 'skill') return;                         // only skill deliverables get the aside
      const id = String(p.id || p.title || '');
      if (!id || skillDelivSeen.has(id)) return;                    // dedup: the review can re-fire the same skill
      skillDelivSeen.add(id);
      if (skillDelivSeen.size > 200) skillDelivSeen = new Set(Array.from(skillDelivSeen).slice(-100));
      // an in-run save already showed its A1 chip a moment ago → the flavored chip IS the surface; no aside.
      if (Date.now() - recentInRunSkill < 8000) return;
      // only aside into the agent's OWN visible stream, and only when the moment is free (else drop — anti-nag).
      const agentId = p.agentId || 'agent';
      const onAgent = activeWs && (activeWs.agentId || 'agent') === agentId;
      if (!onAgent || skillBeatBusy()) return;
      skillAside(p.title, agentId);
    });
  }
  // P3.2 — CAPTURE FORWARDED CREW SPEND. A team.dispatch worker runs its own agent loop and its agent.run.end is
  // forwarded onto the lead's stream (orchestration.js FORWARD) → it reaches U.bus with the worker's OWN runId,
  // agentId, and reconciled usd. We record every such worker end into a rolling, time-stamped buffer; the lead's
  // own run.end (handled in the Harness.chat block) CLAIMS the workers that fired inside its live window. Only a
  // NAMED roster worker is attributable: an ephemeral team.spawn clone (sub-* id, no persistent identity) vanishes,
  // so crediting it would be a lie — filtered here. Hero self-runs (agentId 'agent') are never crew. Read-only.
  let crewCaptureWired = false;
  function wireCrewCapture() {
    if (crewCaptureWired || typeof U === 'undefined' || !U.bus) return;
    crewCaptureWired = true;
    U.bus.on('agent.run.end', p => {
      if (!p) return;
      const aid = String(p.agentId || 'agent');
      if (aid === 'agent') return;                      // the hero's own run, not a delegated worker
      if (/^sub-/.test(aid)) return;                    // ephemeral team.spawn clone — no persistent XP identity, never credited
      const usd = Math.max(0, (typeof p.usd === 'number' && isFinite(p.usd)) ? p.usd : 0);
      crewSeen.push({ agentId: aid, usd: usd, runId: String(p.runId || p.id || ''), at: Date.now() });
      if (crewSeen.length > 80) crewSeen.shift();       // rolling window — a long session can't grow it forever
    });
  }
  // claim the crew workers that ran inside a lead run's live window [startedAt, now]. Returns [{ agentId, usd }],
  // aggregated per worker (a worker dispatched twice in one run sums its spend). Consumes matched entries so a
  // later lead run can't re-claim them. Pure-ish (mutates crewSeen); the honest attribution list for crewSplit.
  function claimCrew(startedAt) {
    if (!(startedAt > 0) || !crewSeen.length) return [];
    const lo = startedAt - 250;   // small slop: a worker's forwarded end can arrive a beat before the lead's onRunId lands
    const byAgent = new Map();
    for (let i = crewSeen.length - 1; i >= 0; i--) {
      const e = crewSeen[i];
      if (e.at < lo) break;        // buffer is time-ordered; older than this window → stop scanning
      byAgent.set(e.agentId, { agentId: e.agentId, usd: (byAgent.get(e.agentId) || { usd: 0 }).usd + e.usd });
      crewSeen.splice(i, 1);       // consumed — never double-attributed to a second lead run
    }
    return Array.from(byAgent.values());
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
        // WORK-EARNED ASK FLOOR (beat-fat trim, 2026-07-03): a real task-run banks toward the session's ask
        // budget, and NO gentle unsolicited beat (suggestion / seed / curiosity) fires until the station has
        // completed Curiosity.MIN_WORK task-runs this session. The first thing a fresh session shows the
        // Commander must be WORK, never an idea/question that reads as pre-generated. Rate-the-work above is
        // exempt (it's about the run itself, not an unsolicited ask); study/arc/trust have their own arbiter.
        if (typeof CuriosityStore !== 'undefined' && CuriosityStore.noteWork) CuriosityStore.noteWork();
        if (typeof CuriosityStore !== 'undefined' && CuriosityStore.earned && !CuriosityStore.earned()) return;
        // ONGOING SUGGESTION (Slice 3): if the station has learned something new and an idea is due, it takes this
        // ONE post-run beat — gently — and curiosity stands down for the run (the agent never stacks an idea AND a
        // question on the same task). Shares this slot's guards (busy/interview/onboarding/intake/turn-in) for free.
        if (typeof SuggestStore !== 'undefined' && SuggestStore.willSuggest && SuggestStore.fire && SuggestStore.willSuggest()) { SuggestStore.fire(); return; }
        // SELF-GROWING SEED (Slice 5): if a recurring pattern is ripe, the agent offers to author it as a one-tap
        // seed — takes this one beat (after a suggestion, before curiosity) so it never stacks two asks on a task.
        if (typeof SeedStore !== 'undefined' && SeedStore.willPropose && SeedStore.propose && SeedStore.willPropose()) { SeedStore.propose(); return; }
        // ADAPTIVE RECRUITMENT: once the station has a WARM read of the Commander's real workflow and it points to a
        // NEW teammate the crew doesn't have, offer ONCE — through THIS single post-run beat, sharing every guard
        // above (work-earned floor, busy/interview/turn-in, one-beat-at-a-time). Never a parallel nag channel: it
        // competes for the same slot and only takes it when the suggestion/seed didn't. Accepting deep-links into
        // the recruitment bay's summon flow. At most once per session.
        if (maybeRecruit()) return;
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
      if (m && m.truncated) continue;   // E3: the local history-cap marker is a data record, not a dialogue turn
      if (m.role === 'user') { addUser(m.content); continue; }
      if (m.role !== 'assistant') continue;   // only dialogue turns render (a stray system marker never shows as an agent reply)
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
    // GOAL LOOP: a deliberate Stop means "I'm taking over" — pause any active loop so the teardown's judge doesn't
    // fire the next continuation. (The user resumes it explicitly with /goal resume.)
    if (typeof GoalLoop !== 'undefined') { const g = goalOf(activeWs); if (g && GoalLoop.isActive(g)) { GoalLoop.pause(g, 'you stopped the run'); persistGoal(); } }
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
    if (!verdict) { choices([{ label: '↻ Try again', value: 'retry' }], () => retryLast()); diagAffordance(); return; }
    // ADOPTION (Lane A): every error names its DOOR and opens the exact one. Friendly.actionButton maps the
    // verdict to { label, run } — capdenied -> REFIT (with the named capability), auth/no-key -> the real key
    // field or "reconnect ChatGPT", model-not-found -> models. One source of truth; no local per-action ladder.
    const btn = (typeof Friendly !== 'undefined' && Friendly.actionButton) ? Friendly.actionButton(verdict) : null;
    if (btn) { choices([{ label: btn.label, value: verdict.action }], () => btn.run()); diagAffordance(); return; }
    if (verdict.retryable) { choices([{ label: '↻ Try again', value: 'retry' }], () => retryLast()); diagAffordance(); return; }
    // non-retryable with no destination: leave no primary chip rather than inviting a doomed re-run — but a stuck
    // user still gets the quiet bug-report affordance so they can grab a diagnostic readout in place.
    diagAffordance();
  }
  // T3.9 — a SECONDARY, quiet "copy diagnostics for a bug report" affordance dropped under a failed turn, alongside
  // whatever recovery chip offerRetry rendered. Kept low-key (a subdued pill) so it never competes with the primary
  // action; one tap copies the sidecar-assembled, SECRET-FREE report (Diag.copy) so a user in a failure state can
  // email a useful report without leaving the moment. Appends its OWN row so picking the primary chip doesn't wipe it.
  function diagAffordance() {
    if (!log || typeof Diag === 'undefined' || !Diag.copy) return;
    const rowEl = document.createElement('div'); rowEl.className = 'choice-row';
    const b = document.createElement('button'); b.className = 'choice quiet'; b.type = 'button';
    b.textContent = '📋 copy diagnostics for a bug report';
    b.addEventListener('click', () => {
      b.disabled = true;
      Diag.copy({ notify: false }).then(ok => {
        b.textContent = ok ? '✓ diagnostics copied — paste into your report' : 'copy failed — try again';
        if (!ok) { b.disabled = false; return; }
        if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
        setTimeout(() => { try { rowEl.remove(); } catch (_) {} }, 2600);
      });
    });
    rowEl.appendChild(b);
    log.appendChild(rowEl); autoscroll();
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
  let slashServerCommands = null, slashCatalogLoading = null, slashCatalogLoaded = null;
  /* ---------- /goal AUTONOMOUS LOOP (StarNet's "Ralph loop") ----------
     The loop STATE (goal / status / turnsUsed / subgoals / …) rides on the workstream record as ws.goalLoop, so a
     standing goal survives a reload/switch exactly like the thread history (workstreams.js carries the field through
     serialize()). GoalLoop (goalloop.js) owns the PURE parse + state machine; here we own the aux JUDGE model call
     (the same internal:true Harness.chat path goalstore/pitchstore use), queueing the continuation into the existing
     type-ahead queue, and honoring the one-beat discipline. `goalJudging` guards against a second judge round-trip
     racing the first for one stream. */
  const goalJudging = new Set();       // wsIds with a judge round-trip in flight (one at a time per stream)
  function goalOf(ws) {                 // the live loop state for a stream (re-normalized from its persisted row)
    if (!ws) return null;
    if (ws.goalLoop && typeof GoalLoop !== 'undefined') { const n = GoalLoop.normalize(ws.goalLoop); ws.goalLoop = n || undefined; return ws.goalLoop || null; }
    return null;
  }
  function persistGoal() { if (onTurn) onTurn(); }   // the loop state is part of the ws record → App.persist writes it
  const FALLBACK_SLASH_COMMANDS = Object.freeze([
    Object.freeze({ name: 'retry', desc: 're-run the last turn', action: 'retry' }),
    Object.freeze({ name: 'stop', desc: 'interrupt the running turn', action: 'stop' }),
    Object.freeze({ name: 'copy', desc: "copy the agent's last reply", action: 'copy' }),
    Object.freeze({ name: 'help', desc: 'list available commands', action: 'help' }),
    Object.freeze({ name: 'new', aliases: ['reset'], desc: 'start a fresh workstream', action: 'new' }),
    Object.freeze({ name: 'clear', aliases: ['cls'], desc: 'clear COMMS and start a fresh workstream', action: 'clear' }),
    Object.freeze({ name: 'history', aliases: ['hist'], desc: 'show recent turns of this workstream', action: 'history' }),
    Object.freeze({ name: 'whoami', desc: 'show the current agent identity', action: 'whoami' }),
    Object.freeze({ name: 'insights', desc: 'usage rollup from the run history', action: 'insights' }),
    Object.freeze({ name: 'branch', aliases: ['fork'], desc: 'fork this conversation into a new workstream', action: 'branch' }),
    Object.freeze({ name: 'status', desc: 'show current stream and run state', action: 'status' }),
    Object.freeze({ name: 'usage', desc: 'show token and spend totals', action: 'usage' }),
    Object.freeze({ name: 'queue', aliases: ['q'], desc: 'show or add queued follow-up text', action: 'queue' }),
    Object.freeze({ name: 'steer', desc: 'queue steering guidance for the current task', action: 'steer' }),
    Object.freeze({ name: 'undo', desc: 'remove the last local exchange', action: 'undo' }),
    Object.freeze({ name: 'compress', desc: 'show context compaction status', action: 'compress' }),
    Object.freeze({ name: 'title', desc: 'show or rename the current workstream', action: 'title' }),
    Object.freeze({ name: 'resume', aliases: ['sessions', 'switch'], desc: 'list or switch workstreams', action: 'resume' }),
    Object.freeze({ name: 'save', desc: 'save the current station state', action: 'save' }),
    Object.freeze({ name: 'agents', aliases: ['tasks'], desc: 'show active agents and running streams', action: 'agents' }),
    Object.freeze({ name: 'background', aliases: ['bg', 'btw'], desc: 'run a prompt in a new background workstream', action: 'background' }),
    Object.freeze({ name: 'build-away', aliases: ['buildaway', 'away'], desc: 'queue an idea for this agent to build while you are away', action: 'build-away' }),
    Object.freeze({ name: 'goal', desc: 'set an autonomous standing goal (status/pause/resume/clear)', action: 'goal' }),
    Object.freeze({ name: 'subgoal', desc: 'add a criterion the goal loop must also satisfy', action: 'subgoal' }),
    Object.freeze({ name: 'model', desc: 'show or set the active model', action: 'model' }),
    Object.freeze({ name: 'personality', desc: 'show or set the active personality', action: 'personality' }),
    Object.freeze({ name: 'yolo', desc: 'toggle full-access approval mode', action: 'yolo' }),
    Object.freeze({ name: 'reasoning', desc: 'show reasoning-mode support status', action: 'reasoning' }),
    Object.freeze({ name: 'fast', desc: 'show fast-mode support status', action: 'fast' }),
    Object.freeze({ name: 'voice', desc: 'show or toggle spoken replies', action: 'voice' }),
    Object.freeze({ name: 'tools', desc: 'show tools granted by the workstation', action: 'tools' }),
    Object.freeze({ name: 'skills', desc: 'show installed skill recipes', action: 'skills' }),
    Object.freeze({ name: 'memory', desc: 'show the active agent memory records', action: 'memory' }),
    Object.freeze({ name: 'bundles', desc: 'list recipe and skill slash bundles', action: 'bundles' }),
    Object.freeze({ name: 'cron', desc: 'show or arm scheduled routines', action: 'cron' }),
    Object.freeze({ name: 'suggestions', aliases: ['suggest'], desc: 'review recurring-task recipe suggestions', action: 'suggestions' }),
    Object.freeze({ name: 'blueprint', aliases: ['bp'], desc: 'load a recipe blueprint into the composer', action: 'blueprint' }),
    Object.freeze({ name: 'reload-mcp', aliases: ['reload_mcp'], desc: 'refresh configured MCP connectors', action: 'reload-mcp' }),
    Object.freeze({ name: 'reload-skills', aliases: ['reload_skills'], desc: 'refresh the slash skill catalog', action: 'reload-skills' }),
    Object.freeze({ name: 'debug', desc: 'show chat and slash debug state', action: 'debug' }),
    Object.freeze({ name: 'version', aliases: ['v'], desc: 'show StarNet version information', action: 'version' })
  ]);
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
  function refreshWorkflowViews() {
    try { if (typeof App !== 'undefined' && App.refreshUsage) App.refreshUsage(); } catch (_) {}
    try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
    try { if (typeof App !== 'undefined' && App.persist) App.persist(); } catch (_) {}
  }
  function streamLabel(w) { return (w && (w.title || (w.id === (typeof Workstreams !== 'undefined' && Workstreams.generalId && Workstreams.generalId()) ? 'General' : 'Untitled'))) || 'current stream'; }
  function workstreamList() {
    try { return (typeof Workstreams !== 'undefined' && Workstreams.list) ? Workstreams.list() : []; } catch (_) { return []; }
  }
  function findWorkstreamRef(args) {
    const raw = String(args || '').trim();
    const list = workstreamList();
    if (!raw) return null;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1];
    const q = raw.toLowerCase();
    return list.find(w => String(w.id || '').toLowerCase() === q)
      || list.find(w => String(streamLabel(w)).toLowerCase() === q)
      || list.find(w => String(streamLabel(w)).toLowerCase().indexOf(q) >= 0)
      || null;
  }
  function summarizeStreams() {
    const list = workstreamList();
    if (!list.length) return 'No saved workstreams.';
    const bits = list.slice(0, 8).map((w, i) => {
      const busy = (typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(w.id)) ? '*' : '';
      const here = activeWs && w.id === activeWs.id ? '>' : '';
      const turns = (w.history && w.history.length) || 0;
      return here + (i + 1) + '. ' + streamLabel(w) + busy + ' (' + turns + ')';
    });
    return 'Workstreams: ' + bits.join(' | ') + (list.length > 8 ? ' | +' + (list.length - 8) + ' more' : '') + '. Use /resume <number|title>.';
  }
  function titleCommand(args) {
    if (!activeWs || typeof Workstreams === 'undefined' || !Workstreams.rename) return localLine('No active workstream to rename.');
    const title = String(args || '').trim();
    if (!title) return localLine('Title: ' + streamLabel(activeWs) + '. Use /title <name> to rename this workstream.');
    Workstreams.rename(activeWs.id, title);
    refreshWorkflowViews();
    localLine('Renamed this workstream to ' + streamLabel(activeWs) + '.');
  }
  function resumeCommand(args) {
    if (typeof Workstreams === 'undefined' || !Workstreams.switch) return localLine('Workstreams are not available yet.');
    const target = findWorkstreamRef(args);
    if (!String(args || '').trim()) return localLine(summarizeStreams());
    if (!target) return localLine('No workstream matched "' + String(args || '').trim() + '". ' + summarizeStreams());
    const ws = Workstreams.switch(target.id);
    if (!ws) return localLine('Could not switch workstreams.');
    load(ws); refreshWorkflowViews();
    localLine('Resumed ' + streamLabel(ws) + '.');
  }
  function saveCommand() {
    try { if (typeof App !== 'undefined' && App.persist) { App.persist(); localLine('Saved the current station state.'); return; } } catch (_) {}
    localLine('Save is not available yet.');
  }
  function appAgents() {
    try {
      if (typeof App !== 'undefined' && App.agents) return App.agents() || [];
      const a = activeAgent();
      return a ? [a] : [];
    } catch (_) { return []; }
  }
  function agentsCommand() {
    const agents = appAgents();
    const streams = workstreamList();
    const busy = streams.filter(w => typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(w.id));
    const names = agents.map(a => (a.name || a.id || 'agent') + ((a.id && a.id !== 'agent') ? ' [' + a.id + ']' : '')).slice(0, 6);
    localLine('Agents: ' + (names.length ? names.join(', ') : 'none loaded') + '. Streams: ' + streams.length + '; running: '
      + (busy.length ? busy.map(streamLabel).join(', ') : 'none') + '.');
  }
  function backgroundCommand(args) {
    const text = String(args || '').trim();
    if (!text) return localLine('Usage: /background <prompt>');
    if (typeof Workstreams === 'undefined' || !Workstreams.create) return localLine('Workstreams are not available yet.');
    const prev = activeWs;
    const title = Workstreams.deriveTitle ? (Workstreams.deriveTitle(text) || 'Background task') : 'Background task';
    const ws = Workstreams.create(title, { agentId: (activeWs && activeWs.agentId) || 'agent' });
    load(ws);
    send(text);
    if (prev && Workstreams.switch) {
      const back = Workstreams.switch(prev.id);
      if (back) load(back);
    }
    refreshWorkflowViews();
    localLine('Started background workstream: ' + streamLabel(ws) + '.');
  }
  // /goal <text>            — set + kick off an autonomous loop toward <text> on this stream
  // /goal (or /goal status)  — show the loop status
  // /goal pause|resume|clear — control it
  function goalCommand(args) {
    const raw = String(args || '').trim();
    const low = raw.toLowerCase();
    if (typeof GoalLoop === 'undefined') return localLine('The goal loop is not available in this build.');
    if (!activeWs) return localLine('Open a workstream first.');
    const cur = goalOf(activeWs);
    if (!raw || low === 'status') return localLine(GoalLoop.statusLine(cur));
    if (low === 'pause') {
      if (!cur || cur.status === 'cleared') return localLine('No goal loop to pause.');
      GoalLoop.pause(cur, 'you paused it'); persistGoal();
      return localLine('⏸ goal loop paused. /goal resume to continue.');
    }
    if (low === 'resume') {
      if (!cur || cur.status !== 'paused') return localLine('No paused goal loop to resume.');
      GoalLoop.resume(cur); persistGoal();
      localLine('▶ goal loop resumed (' + cur.turnsUsed + '/' + cur.maxTurns + '). Kicking off the next step…');
      return kickGoal(activeWs);   // resume immediately fires the next continuation if the stream is free
    }
    if (low === 'clear') {
      if (!cur || cur.status === 'cleared') return localLine('No goal loop to clear.');
      GoalLoop.clear(cur); activeWs.goalLoop = undefined; persistGoal();
      return localLine('Cleared the goal loop.');
    }
    // /goal <text> — set (or replace) the standing goal and start working toward it
    const s = GoalLoop.create(raw, { now: Date.now() });
    if (!s) return localLine('Usage: /goal <what you want done>');
    activeWs.goalLoop = s; persistGoal();
    localLine('⊙ goal loop set: ' + s.goal + '  (budget ' + s.maxTurns + ' turns). Working toward it…');
    kickGoal(activeWs);
  }
  // /subgoal <text>          — append a criterion the loop must ALSO satisfy before it's done
  // /subgoal (bare)          — list the criteria; /subgoal clear wipes them
  function subgoalCommand(args) {
    const raw = String(args || '').trim();
    const low = raw.toLowerCase();
    if (typeof GoalLoop === 'undefined') return localLine('The goal loop is not available in this build.');
    const cur = activeWs && goalOf(activeWs);
    if (!raw) {
      const subs = (cur && cur.subgoals) || [];
      return localLine(subs.length ? ('Subgoals: ' + subs.map((t, i) => (i + 1) + '. ' + t).join(' | ')) : 'No subgoals set. Use /subgoal <text> once a goal loop is running.');
    }
    if (!cur || !GoalLoop.hasGoal(cur)) return localLine('Set a goal first with /goal <text>, then add criteria with /subgoal.');
    if (low === 'clear') { cur.subgoals = []; persistGoal(); return localLine('Cleared subgoals.'); }
    const rm = /^remove\s+(\d+)$/i.exec(raw);
    if (rm) {
      const i = Number(rm[1]) - 1;
      if (i >= 0 && i < cur.subgoals.length) { const old = cur.subgoals.splice(i, 1)[0]; persistGoal(); return localLine('Removed subgoal: ' + old); }
      return localLine('No subgoal #' + rm[1] + '.');
    }
    const added = GoalLoop.addSubgoal(cur, raw); persistGoal();
    localLine(added ? ('Added subgoal #' + cur.subgoals.length + '. The loop will now require: ' + added) : 'Could not add that subgoal.');
  }

  /* THE GOAL LOOP ENGINE.
     goalBlocked() — never drive a continuation while a beat / consent card is pending approval (the one-beat
     discipline) or while an interview owns the input; the continuation waits for a free moment (it re-fires from
     the next send() teardown, or from /goal resume). A pending permission approval on THIS stream also blocks —
     the human must decide the tool call before we pile on the next turn. */
  function goalBlocked(ws) {
    if (interview) return true;
    if (activeTurnin || activeNudge || studyBusy()) return true;   // a visible review/beat is up
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return true;
    if (ws && typeof Channels !== 'undefined' && Channels.pendingOf && Channels.pendingOf(ws.id)) return true;   // a tool approval is pending
    return false;
  }
  // kick the loop forward on `ws`: if the stream is free + unblocked and the loop is active, send the next
  // continuation as a real turn (routed through send(), so it walks the desk / bills / streams like any turn).
  // Called after a set/resume and after each judged turn. Idempotent + safe when there's no active loop.
  const goalRetry = new Set();   // wsIds with a blocked-moment retry armed (one pending re-check per stream, never stacked)
  function kickGoal(ws) {
    const s = goalOf(ws);
    if (!s || !GoalLoop.isActive(s)) return;
    if (!isActiveWs(ws)) return;                 // the continuation drives the DISPLAYED stream (send()'s DOM writes)
    if (isBusy()) return;                        // a run is already in flight — the teardown judge re-drives the loop
    if (goalBlocked(ws)) {
      // a beat/consent card owns the moment — "deferred" must not become "stalled": re-check on a slow cadence
      // (one armed retry per stream; gives up silently when the loop is paused/cleared meanwhile).
      if (!goalRetry.has(ws.id)) { goalRetry.add(ws.id); setTimeout(() => { goalRetry.delete(ws.id); kickGoal(ws); }, 7000); }
      return;
    }
    const prompt = GoalLoop.continuationPrompt(s);
    if (!prompt) return;
    send(prompt, { goalContinuation: true });    // flag it so send() knows this turn IS the loop (not a user preempt)
  }
  // after a turn on `ws` completes, judge it against the standing goal and decide whether to fire another turn.
  // `wasContinuation` = this turn WAS a loop-driven continuation (vs a real user message). A real user message
  // PREEMPTS: it pauses the loop for this turn (their message wins) — we don't judge, we don't queue. reply is the
  // agent's last assistant text (what the judge evaluates).
  async function judgeGoalTurn(ws, reply, wasContinuation) {
    const s = goalOf(ws);
    if (!s || !GoalLoop.isActive(s)) return;
    // a REAL user message mid-loop preempts: pause, judge nothing, queue nothing (they took over). Checked BEFORE
    // the goalJudging guard: even while a judge round-trip is in flight the pause must land — the in-flight judge
    // re-reads the state after its await and sees the loop inactive, so it can never fire over the human's head.
    if (!wasContinuation) {
      const d = GoalLoop.evaluate(s, null, { preempt: true }); persistGoal();
      if (d.message && isActiveWs(ws)) localLine(d.message);
      return;
    }
    if (goalJudging.has(ws.id)) return;          // a judge is already deciding this stream — don't double-fire
    // a continuation turn that produced NO clean reply (errored / stopped mid-thought) is not judgeable — leave the
    // loop as-is (it advances no turn); a later free moment or /goal resume continues it. Don't claim done on nothing.
    if (!reply || !String(reply).trim()) return;
    goalJudging.add(ws.id);
    let judged;
    try {
      // the aux JUDGE call — reason-only, internal (no floor/telemetry/tool reach), same path pitchstore/goalstore
      // use. Fail-open: any error → a CONTINUE parse-failure verdict (the state machine's budget + parse-fail guard
      // are the backstops; a broken judge must never wedge or falsely claim done).
      let raw = '';
      try {
        const sys = GoalLoop.judgeSystem();
        const usr = GoalLoop.judgeUser(s, reply, { now: new Date().toISOString() });
        const res = await Harness.chat({ system: sys, messages: [{ role: 'user', content: usr }], agentId: ws.agentId || 'agent', isTask: false, placed: [], internal: true });
        raw = (res && !res.error) ? (res.text || '') : '';
      } catch (_) { raw = ''; }
      judged = GoalLoop.parseVerdict(raw);
    } finally {
      goalJudging.delete(ws.id);
    }
    // re-read state: a /goal pause|clear or a user message may have landed during the async judge round-trip.
    const s2 = goalOf(ws);
    if (!s2 || !GoalLoop.isActive(s2)) return;
    const d = GoalLoop.evaluate(s2, judged, { now: Date.now() });
    persistGoal();
    if (d.message && isActiveWs(ws)) localLine(d.message);
    if (d.shouldContinue) kickGoal(ws);          // fire the next continuation (guards for busy/blocked inside)
  }
  function newWorkstreamCommand(args) {
    if (typeof Workstreams === 'undefined' || !Workstreams.create) return localLine('Workstreams are not available yet.');
    const title = String(args || '').trim() || null;
    const ws = Workstreams.create(title, { agentId: (activeWs && activeWs.agentId) || 'agent' });
    load(ws); refreshWorkflowViews();
    localLine('Started a fresh workstream' + (title ? ': ' + title : '.') );
  }
  function branchWorkstreamCommand(args) {
    if (!activeWs || typeof Workstreams === 'undefined' || !Workstreams.create) return localLine('No active workstream to branch.');
    const src = activeWs;
    const title = String(args || '').trim() || ((src.title || 'General') + ' branch');
    const ws = Workstreams.create(title, { agentId: src.agentId || 'agent' });
    ws.history = (src.history || []).map(m => Object.assign({}, m));
    ws.lane = 'todo';
    load(ws); refreshWorkflowViews();
    localLine('Branched from ' + streamLabel(src) + '.');
  }
  function statusCommand() {
    const q = (activeWs && queued.get(activeWs.id)) || [];
    const model = (typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : '';
    const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : '';
    const state = isBusy() ? 'working' : 'idle';
    const turns = activeWs && activeWs.history ? activeWs.history.length : 0;
    const g = (typeof GoalLoop !== 'undefined') ? goalOf(activeWs) : null;
    localLine('Status: ' + state + ' on ' + streamLabel(activeWs) + ' (' + turns + ' turn' + (turns === 1 ? '' : 's') + ', ' + q.length + ' queued)'
      + (model ? '; model ' + model + (provider ? ' via ' + provider : '') : '') + '.'
      + (g && g.status !== 'cleared' ? (' ' + GoalLoop.statusLine(g)) : ''));
  }
  function usageCommand() {
    const t = (typeof Harness !== 'undefined' && Harness.totals) ? Harness.totals() : { tokens: 0, cost: 0, calls: 0 };
    const c = (activeWs && typeof Workstreams !== 'undefined' && Workstreams.costOf) ? Workstreams.costOf(activeWs.id) : { tokens: 0, usd: 0, calls: 0 };
    localLine('Usage: lifetime ' + (t.tokens || 0) + ' tokens, $' + ((t.cost || 0).toFixed ? t.cost.toFixed(6) : '0.000000') + ', ' + (t.calls || 0)
      + ' calls. This stream: ' + (c.tokens || 0) + ' tokens, $' + ((c.usd || 0).toFixed ? c.usd.toFixed(6) : '0.000000') + ', ' + (c.calls || 0) + ' calls.');
  }
  function queueCommand(args) {
    if (!activeWs) return localLine('No active workstream.');
    const text = String(args || '').trim();
    if (text) {
      if (isBusy()) { enqueue(text); localLine('Queued one follow-up for this stream.'); }
      else send(text);
      return;
    }
    const arr = queued.get(activeWs.id) || [];
    localLine(arr.length ? ('Queue: ' + arr.length + ' pending - ' + arr.map((t, i) => (i + 1) + '. ' + String(t).slice(0, 80)).join(' | ')) : 'Queue is empty for this stream.');
  }
  // W3 — the free-text "build this while I'm away" entry point. Queues the typed idea onto the focused
  // agent's away-workshop backlog (POST /api/workshop/queue via WorkshopStore). One line in, one confirm out.
  function buildAwayCommand(args) {
    const text = String(args || '').trim();
    if (!text) return localLine('Usage: /build-away <what to build> — queues it for this agent to build on its own recurring away shift.');
    if (typeof WorkshopStore === 'undefined' || !WorkshopStore.queue) return localLine('Away workshop isn’t available on this station.');
    const agentId = (activeWs && activeWs.agentId) || 'agent';
    // pass the display name so a needsGrant warning can name the agent.
    WorkshopStore.queue({ agentId: agentId, text: text, sourceType: 'text', name: name }).then(res => {
      if (!res || !res.ok) { localLine('Couldn’t queue that: ' + ((res && res.error) || 'the station refused it') + '.'); return; }
      // ADOPTION (Lane F): the confirm copy comes from WorkshopStore.queueConfirmLine — it encodes the TRUTH that
      // away builds run on a recurring shift WHILE THE STATION IS UP (never "while the app is closed").
      if (res.needsGrant) {
        // queued, but the grant is OFF → it will never build. Show the honest warn + a one-tap toggle (openGrant).
        localLine(res.warn || 'saved to the build list — but “build while away” is off, so it won’t be built yet.');
        choices([{ label: '⚙ Turn on “build while away”', value: 'grant' }], () => {
          WorkshopStore.openGrant(res.agentId || agentId).then(g => {
            localLine((g && g.ok) ? '✓ “build while away” is on — ' + name + ' will build this on its next away shift.'
              : 'Couldn’t turn it on: ' + ((g && g.error) || 'try the AUTONOMY settings') + '.');
          });
        });
        return;
      }
      localLine(WorkshopStore.queueConfirmLine(name));
    });
  }
  function steerCommand(args) {
    if (!activeWs) return localLine('No active workstream.');
    const text = String(args || '').trim();
    if (!text) return localLine('Usage: /steer <guidance>');
    const note = 'Steering note for the current task: ' + text;
    if (isBusy()) {
      // LIVE MID-RUN STEERING: if the running turn has a known runId, POST it to the sidecar's per-run steer
      // buffer; the loop folds it in before its NEXT model call (after the current tool result). Fall back to the
      // queue only when there is no live runId (e.g. a run whose id we never captured) or the POST fails — so a
      // steer is NEVER silently dropped and NEVER injected into a run we can't address.
      const rid = (typeof Channels !== 'undefined' && Channels.runIdOf) ? Channels.runIdOf(activeWs.id) : null;
      if (rid && typeof fetch !== 'undefined') {
        fetch('/api/run/steer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: rid, text: text }) })
          .then(r => r.ok ? r.json().catch(() => null) : null)
          .then(j => {
            if (j && j.ok) localLine('Steering the live run — it will fold your note in on its next step.');
            else steerQueueFallback(note);   // run already ended / buffer full → queue it
          })
          .catch(() => steerQueueFallback(note));
        return;
      }
      return steerQueueFallback(note);
    }
    send(note);
  }
  function steerQueueFallback(note) {
    if (!activeWs) return;
    const arr = queued.get(activeWs.id) || [];
    arr.unshift(note); queued.set(activeWs.id, arr); renderQueued();
    localLine('Steering note queued to run next.');
  }
  function undoCommand() {
    if (!activeWs) return localLine('No active workstream.');
    if (isBusy()) return localLine('Stop the running turn before undoing history.');
    const h = activeWs.history || [];
    if (!h.length) return localLine('Nothing to undo.');
    let removed = 0;
    if (h[h.length - 1] && h[h.length - 1].role === 'assistant') { h.pop(); removed++; }
    if (h[h.length - 1] && h[h.length - 1].role === 'user') { h.pop(); removed++; }
    if (!removed && h.length) { h.pop(); removed++; }
    load(activeWs); refreshWorkflowViews();
    localLine('Undid ' + removed + ' message' + (removed === 1 ? '' : 's') + '.');
  }
  function compressCommand() {
    const cs = (typeof Harness !== 'undefined' && Harness.contextState) ? Harness.contextState() : null;
    // The run host is STATELESS — the conversation lives in the browser and is sent per call — so there is no
    // persistent server-side context to fold on demand between runs. Auto-compaction runs INSIDE a run when the
    // live prompt crosses the threshold. This is the honest status; see the slash-parity report for the rationale.
    if (cs && cs.limit) {
      const pct = Math.round(((cs.used || 0) / cs.limit) * 100);
      localLine('Context: ' + (cs.used || 0) + ' / ' + cs.limit + ' tokens (' + pct + '%). Auto-compaction folds older turns into a summary automatically during a run once the prompt nears the window; because the run host is stateless there is no idle prompt to compact on demand between runs.');
    } else {
      localLine('Context compaction is automatic: during a run, once the live prompt nears the model window, older turns are folded into a running summary. There is no idle context to compact between runs (the run host is stateless — the conversation is sent per call).');
    }
  }
  // /clear — wipe the rendered COMMS panel and start a fresh workstream. Shares newWorkstreamCommand's create+load
  // (which itself clears the log via load()), so it can NEVER touch another stream's in-flight run: it only ever
  // spins up a brand-new stream and rebinds the panel to it. Purely additive over /new (aliased for parity with the reference harness).
  function clearCommand(args) {
    newWorkstreamCommand(args);
    if (log) log.innerHTML = '';   // belt-and-suspenders: guarantee a clean panel even if load() left an empty-state hint
    localLine('Cleared COMMS and started a fresh workstream.');
  }
  // /history [n] — print the last n turns (default 10) of the ACTIVE workstream from ws.history, role-prefixed and
  // truncated. Read-only; never mutates history or touches any run.
  function historyCommand(args) {
    if (!activeWs) return localLine('No active workstream.');
    const h = (activeWs.history || []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && (m.content || '').trim());
    if (!h.length) return localLine('No conversation history in this workstream yet.');
    let n = parseInt(String(args || '').trim(), 10);
    if (!Number.isInteger(n) || n <= 0) n = 10;
    n = Math.min(n, 30);
    const slice = h.slice(-n);
    localLine('History (last ' + slice.length + ' of ' + h.length + ' turn' + (h.length === 1 ? '' : 's') + '):');
    for (const m of slice) {
      const who = m.role === 'user' ? 'You' : 'Agent';
      localLine(who + ': ' + String(m.content).replace(/\s+/g, ' ').slice(0, 160));
    }
  }
  // /whoami — the current agent identity: id/name, role/class, level + XP (Xp.compute), model + provider, and the
  // capabilities placed on the floor (slashPlacedTypes). Read-only.
  function whoamiCommand() {
    const a = activeAgent() || {};
    const id = (activeWs && activeWs.agentId) || a.id || 'agent';
    const name = a.name || id;
    const spec = (a.specialtyId && typeof Specialties !== 'undefined' && Specialties.get) ? Specialties.get(a.specialtyId) : null;
    const klass = (spec && (spec.name || spec.id)) || a.role || (id === 'agent' ? 'orchestrator' : 'specialist');
    let lvl = '';
    try { if (typeof Xp !== 'undefined' && Xp.compute && a.stats) { const g = Xp.compute(a.stats); lvl = ', Lv ' + g.level + ' (' + (g.xp != null ? g.xp + ' XP, ' : '') + g.pct + '% to Lv ' + (g.level + 1) + ')'; } } catch (_) {}
    const model = (typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : (a.model || '');
    const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : (a.provider || '');
    const placed = slashPlacedTypes();
    localLine('You are ' + name + ' [' + id + '] — ' + klass + lvl + '. Model: ' + (model || 'not selected') + (provider ? ' via ' + provider : '')
      + '. Placed capabilities: ' + (placed.length ? placed.join(', ') : 'none on the floor yet') + '.');
  }
  // /insights — a usage rollup from the DURABLE run history (GET /api/insights): total runs, spend, tokens,
  // success rate, and top models. This is the persisted lifetime ledger for this agent — honestly labelled as such
  // (the run store keeps every run, so it is not windowed to 30 days). A per-session fallback uses Harness.totals()
  // when the sidecar is offline, clearly marked session-only so no number is ever faked.
  async function insightsCommand() {
    const agentId = (activeWs && activeWs.agentId) || (activeAgent() && activeAgent().id) || 'agent';
    try {
      const r = await fetch('/api/insights?agent=' + encodeURIComponent(agentId), { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      if (j && (j.totalRuns != null)) {
        const models = Array.isArray(j.byModel) ? j.byModel.slice(0, 3).map(m => (m.model || '?') + ' ($' + (m.usd || 0) + ')') : [];
        const succ = (j.successPct == null) ? '' : ', ' + j.successPct + '% completed';
        return localLine('Insights (lifetime run history for ' + agentId + '): ' + (j.totalRuns || 0) + ' run' + (j.totalRuns === 1 ? '' : 's')
          + ', $' + (j.totalUsd || 0) + ', ' + (j.totalTokens || 0) + ' tokens'
          + (j.avgUsdPerRun ? ', $' + j.avgUsdPerRun + '/run' : '') + succ
          + (models.length ? '. Top models: ' + models.join(', ') : '') + '.');
      }
    } catch (_) {}
    // sidecar offline / no fold — honest session-only fallback, never fabricated.
    const t = (typeof Harness !== 'undefined' && Harness.totals) ? Harness.totals() : { tokens: 0, cost: 0, calls: 0 };
    localLine('Insights: the durable run history is unavailable (sidecar offline). This SESSION only: ' + (t.tokens || 0) + ' tokens, $'
      + ((t.cost || 0).toFixed ? t.cost.toFixed(6) : '0.000000') + ', ' + (t.calls || 0) + ' calls.');
  }
  function activeAgent() {
    try { return (typeof App !== 'undefined' && App.currentAgent) ? App.currentAgent() : null; } catch (_) { return null; }
  }
  function applyAgentPatch(patch) {
    try { if (typeof App !== 'undefined' && App.applyConfig) { App.applyConfig(patch); return true; } } catch (_) {}
    return false;
  }
  function modelCommand(args) {
    const next = String(args || '').trim();
    if (next) {
      if (applyAgentPatch({ model: next })) localLine('Model set to ' + next + ' for future runs.');
      else if (typeof Harness !== 'undefined' && Harness.setModel) { Harness.setModel(next); localLine('Model set to ' + next + ' for this harness session.'); }
      else localLine('Model setting is not available yet.');
      refreshWorkflowViews();
      return;
    }
    const a = activeAgent();
    const model = (typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : ((a && a.model) || '');
    const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : '';
    localLine('Model: ' + (model || 'not selected') + (provider ? ' via ' + provider : '') + '. Use /model <model-id> to switch.');
  }
  function personalityCommand(args) {
    const raw = String(args || '').trim();
    const key = raw.toLowerCase();
    if (key && typeof Personas !== 'undefined' && Personas.exists && Personas.exists(key)) {
      const id = Personas.resolve ? Personas.resolve(key) : key;
      if (applyAgentPatch({ personaId: id })) localLine('Personality set to ' + Personas.get(id).name + '.');
      else localLine('Personality setting is not available yet.');
      return;
    }
    const list = (typeof Personas !== 'undefined' && Personas.list) ? Personas.list() : [];
    const currentId = (activeAgent() && activeAgent().personaId) || (typeof Voice !== 'undefined' && Voice.personaId ? Voice.personaId() : '');
    const current = (typeof Personas !== 'undefined' && Personas.get) ? Personas.get(currentId) : null;
    localLine((raw ? 'Unknown personality "' + raw + '". ' : '') + 'Personality: ' + ((current && current.name) || currentId || 'unknown')
      + (list.length ? '. Options: ' + list.map(p => p.id).join(', ') + '.' : '.'));
  }
  function yoloCommand(args) {
    const a = activeAgent();
    if (!a) return localLine('Approval mode is not available yet.');
    const raw = String(args || '').trim().toLowerCase();
    const want = raw ? /^(1|true|yes|on|full|yolo)$/i.test(raw) : a.approvalMode !== 'full';
    if (applyAgentPatch({ approvalMode: want ? 'full' : 'ask' })) {
      localLine('Approval mode: ' + (want ? 'full access. The agent will not pause for approval prompts.' : 'ask first. The agent will pause before gated actions.') );
    } else localLine('Could not change approval mode.');
  }
  function reasoningCommand(args) {
    const raw = String(args || '').trim();
    const cs = (typeof Harness !== 'undefined' && Harness.contextState) ? Harness.contextState() : null;
    const model = (typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : '';
    if (raw && raw.toLowerCase() !== 'status') return localLine('Reasoning effort is not a separate StarNet toggle yet. Pick a reasoning-capable model with /model; usage events still track reasoning tokens when the provider reports them.');
    localLine('Reasoning: controlled by the selected model' + (model ? ' (' + model + ')' : '') + '. '
      + (cs && cs.limit ? 'Context window ' + (cs.used || 0) + '/' + cs.limit + ' tokens.' : 'Context window is still calibrating.'));
  }
  function fastCommand(args) {
    const raw = String(args || '').trim();
    const model = (typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : '';
    if (raw && raw.toLowerCase() !== 'status') return localLine('Fast mode is not a separate runtime toggle yet. Use /model <fast-model-id> to switch to a cheaper or lower-latency model.');
    localLine('Fast mode: no global toggle is active. Current model: ' + (model || 'not selected') + '.');
  }
  function voiceCommand(args) {
    if (typeof Voice === 'undefined') return localLine('Voice controls are not available in this surface.');
    const raw = String(args || '').trim().toLowerCase();
    if (!raw || raw === 'status') {
      return localLine('Voice: replies ' + (Voice.isOn && Voice.isOn() ? 'on' : 'off')
        + ', hands-free ' + (Voice.inVoiceMode && Voice.inVoiceMode() ? 'on' : 'off')
        + ', listening support ' + (Voice.canListen && Voice.canListen() ? 'yes' : 'no')
        + ', speech support ' + (Voice.canSpeak && Voice.canSpeak() ? 'yes' : 'no') + '.');
    }
    if (/^(on|true|yes|speak|tts)$/.test(raw)) {
      if (Voice.setSpeakReplies) Voice.setSpeakReplies(true);
      return localLine('Voice replies are on.');
    }
    if (/^(off|false|no|mute)$/.test(raw)) {
      if (Voice.stopConvo) Voice.stopConvo();
      if (Voice.setSpeakReplies) Voice.setSpeakReplies(false);
      return localLine('Voice replies are off.');
    }
    if (/^(handsfree|hands-free|convo|conversation|live)$/.test(raw)) {
      if (Voice.toggleVoiceMode) Voice.toggleVoiceMode();
      return localLine('Hands-free voice mode toggled.');
    }
    localLine('Usage: /voice [on|off|status|handsfree]');
  }
  function toolRows() {
    return [
      { cap: null, label: 'compute', tools: 'model.chat' },
      { cap: 'dish', label: 'web', tools: 'web_search, web_fetch' },
      { cap: 'cabinet', label: 'files', tools: 'fs.read, fs.list, fs.write/edit' },
      { cap: 'notebook', label: 'memory', tools: 'notebook.read, notebook.write' },
      { cap: 'workbench', label: 'terminal', tools: 'shell.exec, verify.run' },
      { cap: 'studio', label: 'image', tools: 'image.generate, image.analyze' },
      { cap: 'jukebox', label: 'spotify', tools: 'spotify controls' }
    ];
  }
  function toolsCommand() {
    const placed = slashPlacedTypes();
    const have = {}; placed.forEach(t => { have[t] = true; });
    const active = toolRows().filter(r => r.cap == null || have[r.cap]);
    const missing = toolRows().filter(r => r.cap && !have[r.cap]).map(r => r.label);
    localLine('Tools: ' + active.map(r => r.label + ' (' + r.tools + ')').join('; ')
      + (missing.length ? '. Locked until placed: ' + missing.join(', ') + '.' : '.'));
  }
  async function skillsCommand() {
    try {
      const key = slashCatalogKey();
      const r = await fetch('/api/skills?placed=' + encodeURIComponent(key), { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      const skills = (j && Array.isArray(j.skills)) ? j.skills : [];
      if (!skills.length) return localLine('No skill recipes are installed.');
      const active = skills.filter(s => s.enabled && s.available).map(s => s.slug);
      const locked = skills.filter(s => s.enabled && !s.available).map(s => s.slug);
      const off = skills.filter(s => !s.enabled).length;
      localLine('Skills: ' + active.length + ' active' + (active.length ? ' (' + active.slice(0, 8).join(', ') + ')' : '')
        + (locked.length ? '; ' + locked.length + ' enabled but locked (' + locked.slice(0, 5).join(', ') + ')' : '')
        + (off ? '; ' + off + ' off' : '') + '. Use /<skill-slug> to draft with an available skill.');
    } catch (_) { localLine('Could not load skills from the sidecar.'); }
  }
  async function memoryCommand(args) {
    if (typeof Harness === 'undefined' || !Harness.memoryRecords) return localLine('Memory records are not available yet.');
    const agentId = (activeWs && activeWs.agentId) || (activeAgent() && activeAgent().id) || 'agent';
    const q = String(args || '').trim().toLowerCase();
    try {
      let recs = await Harness.memoryRecords(agentId);
      recs = Array.isArray(recs) ? recs : [];
      const shown = q ? recs.filter(r => String((r && (r.content || r.text || r.kind)) || '').toLowerCase().indexOf(q) >= 0) : recs;
      const top = shown.slice(0, 4).map(r => String((r && (r.content || r.text)) || '').replace(/\s+/g, ' ').slice(0, 56));
      localLine('Memory: ' + recs.length + ' record' + (recs.length === 1 ? '' : 's')
        + (q ? ', ' + shown.length + ' matching "' + q + '"' : '')
        + (top.length ? ' - ' + top.join(' | ') : '.'));
    } catch (_) { localLine('Could not load memory records from the sidecar.'); }
  }
  async function bundlesCommand() {
    const recipes = (typeof Recipes !== 'undefined' && Recipes.list) ? Recipes.list() : [];
    let skillCount = 0, activeSkills = [];
    try {
      const r = await fetch('/api/skills?placed=' + encodeURIComponent(slashCatalogKey()), { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      const skills = (j && Array.isArray(j.skills)) ? j.skills : [];
      skillCount = skills.length;
      activeSkills = skills.filter(s => s.enabled && s.available).map(s => s.slug);
    } catch (_) {}
    localLine('Bundles: ' + recipes.length + ' recipe blueprint' + (recipes.length === 1 ? '' : 's')
      + (recipes.length ? ' (' + recipes.slice(0, 6).map(r => r.id).join(', ') + ')' : '')
      + '; ' + skillCount + ' skill recipe' + (skillCount === 1 ? '' : 's')
      + (activeSkills.length ? ', active: ' + activeSkills.slice(0, 6).join(', ') : '') + '.');
  }
  function recipeByRef(raw) {
    const q = String(raw || '').trim().toLowerCase();
    const list = (typeof Recipes !== 'undefined' && Recipes.list) ? Recipes.list() : [];
    if (!q) return null;
    return list.find(r => String(r.id || '').toLowerCase() === q)
      || list.find(r => String(r.name || '').toLowerCase() === q)
      || list.find(r => String(r.id || '').toLowerCase().indexOf(q) >= 0 || String(r.name || '').toLowerCase().indexOf(q) >= 0)
      || null;
  }
  function blueprintCommand(args) {
    const raw = String(args || '').trim();
    const list = (typeof Recipes !== 'undefined' && Recipes.list) ? Recipes.list() : [];
    if (!raw) return localLine('Blueprints: ' + (list.length ? list.slice(0, 10).map(r => '/' + r.id).join(', ') : 'none') + '. Use /blueprint <name> to load one.');
    const r = recipeByRef(raw);
    if (!r) return localLine('No blueprint matched "' + raw + '".');
    insertRecipe(r);
    localLine('Loaded blueprint ' + (r.name || r.id) + ' into the composer.');
  }
  function suggestionsCommand(args) {
    if (typeof MintStore === 'undefined' || !MintStore.candidates) return localLine('Suggestions are not available yet.');
    const raw = String(args || '').trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const action = (parts[0] || '').toLowerCase();
    const candidates = MintStore.candidates() || [];
    if (!raw || action === 'catalog' || action === 'list') {
      if (!candidates.length) return localLine('No recurring-task suggestions are ready yet.');
      return localLine('Suggestions: ' + candidates.map((c, i) => (i + 1) + '. ' + String(c.template || c.lastText || c.key).slice(0, 70)).join(' | ')
        + '. Use /suggestions accept N or /suggestions dismiss N.');
    }
    if (action === 'clear') { if (MintStore.forget) MintStore.forget(); return localLine('Cleared recurring-task suggestion history.'); }
    const n = Number(parts[1] || parts[0]);
    const c = Number.isInteger(n) ? candidates[n - 1] : null;
    if (!c) return localLine('Pick a suggestion number from /suggestions.');
    if (action === 'dismiss' || action === 'reject') {
      MintStore.markDismissed(c.key);
      return localLine('Dismissed suggestion #' + n + '.');
    }
    if (action === 'accept' || action === 'save' || action === 'approve') {
      if (typeof Recipes !== 'undefined' && Recipes.saveCustom && Recipes.draft) {
        const rec = Recipes.saveCustom(Recipes.draft({ name: 'Suggested Mission', tagline: 'learned from recurring tasks', task: c.template || c.lastText || '' }));
        MintStore.markMinted(c.key);
        warmSlashCatalog();
        return localLine('Saved suggestion #' + n + ' as /' + rec.id + '.');
      }
      MintStore.markMinted(c.key);
      return localLine('Marked suggestion #' + n + ' accepted.');
    }
    localLine('Usage: /suggestions [accept N|dismiss N|clear]');
  }
  async function cronCommand(args) {
    const raw = String(args || '').trim().toLowerCase();
    try {
      if (/^(on|enable|enabled|arm)$/.test(raw) || /^(off|disable|disabled|disarm)$/.test(raw)) {
        const want = /^(on|enable|enabled|arm)$/.test(raw);
        const r = await fetch('/api/cron/arm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: want }) });
        const j = await r.json().catch(() => null);
        return localLine(r.ok && j ? ('Routines scheduler ' + (j.enabled ? 'enabled' : 'disabled') + '.') : 'Could not update the routines scheduler.');
      }
      const r = await fetch('/api/cron', { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      const jobs = (j && Array.isArray(j.jobs)) ? j.jobs : [];
      const bits = jobs.slice(0, 5).map((job, i) => (i + 1) + '. ' + (job.name || job.id || 'routine') + (job.enabled === false ? ' [paused]' : ''));
      localLine('Routines: scheduler ' + (j && j.enabled ? 'on' : 'off') + ', ' + jobs.length + ' job' + (jobs.length === 1 ? '' : 's')
        + (bits.length ? ' - ' + bits.join(' | ') : '.') + ' Use /cron on or /cron off to arm/disarm.');
    } catch (_) { localLine('Could not load routines from the sidecar.'); }
  }
  async function reloadMcpCommand(args) {
    const target = String(args || '').trim();
    try {
      const r = await fetch('/api/connectors', { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      let conns = (j && Array.isArray(j.connectors)) ? j.connectors : [];
      if (target) conns = conns.filter(c => String(c.id || '').toLowerCase() === target.toLowerCase());
      if (!conns.length) return localLine(target ? ('No MCP connector matched "' + target + '".') : 'No MCP connectors are configured.');
      const results = [];
      for (const c of conns) {
        const rr = await fetch('/api/connectors/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id }) });
        const jj = await rr.json().catch(() => null);
        const st = (jj && (jj.status || jj));
        results.push(String(c.id) + ':' + ((st && st.state) || (rr.ok ? 'refreshed' : 'error')) + ((st && st.toolCount != null) ? '/' + st.toolCount + ' tools' : ''));
      }
      localLine('MCP refresh: ' + results.join(', ') + '.');
    } catch (_) { localLine('Could not refresh MCP connectors.'); }
  }
  function reloadSkillsCommand() {
    slashServerCommands = null; slashCatalogLoaded = null; slashCatalogLoading = null;
    warmSlashCatalog();
    localLine('Refreshing slash skills and command catalog for this workstation.');
  }
  async function versionCommand() {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      if (j) {
        const bits = [];
        if (j.app) bits.push('StarNet ' + j.app);
        if (j.harness && j.harness !== j.app) bits.push('harness ' + j.harness);
        if (j.node) bits.push('Node ' + j.node);
        return localLine('Version: ' + (bits.length ? bits.join(', ') : 'unknown') + '.');
      }
    } catch (_) {}
    localLine('Version: could not reach the sidecar (/api/version). It is likely offline.');
  }
  function debugCommand() {
    const ws = activeWs || {};
    const rid = (typeof Channels !== 'undefined' && Channels.runIdOf && ws.id) ? Channels.runIdOf(ws.id) : '';
    const pending = (ws.id && queued.get(ws.id)) || [];
    const a = activeAgent();
    localLine('Debug: stream=' + (ws.id || 'none') + ', agent=' + ((ws.agentId || (a && a.id)) || 'agent')
      + ', run=' + (rid || 'none') + ', busy=' + (isBusy() ? 'yes' : 'no') + ', queued=' + pending.length
      + ', slashCatalog=' + (slashServerCommands ? slashServerCommands.length : 0) + ', model=' + ((typeof Harness !== 'undefined' && Harness.getModel && Harness.getModel()) || 'unset') + '.');
  }
  function localSlashActions() {
    return {
      retry: retryLast, stop: stopActive, copy: copyLastReply, help: showHelp,
      new: newWorkstreamCommand, branch: branchWorkstreamCommand, status: statusCommand,
      usage: usageCommand, queue: queueCommand, steer: steerCommand, undo: undoCommand,
      compress: compressCommand, title: titleCommand, resume: resumeCommand,
      save: saveCommand, agents: agentsCommand, background: backgroundCommand,
      goal: goalCommand, subgoal: subgoalCommand, 'build-away': buildAwayCommand,
      clear: clearCommand, history: historyCommand, whoami: whoamiCommand, insights: insightsCommand,
      model: modelCommand, personality: personalityCommand, yolo: yoloCommand,
      reasoning: reasoningCommand, fast: fastCommand, voice: voiceCommand,
      tools: toolsCommand, skills: skillsCommand, memory: memoryCommand,
      bundles: bundlesCommand, cron: cronCommand, suggestions: suggestionsCommand,
      blueprint: blueprintCommand, 'reload-mcp': reloadMcpCommand,
      'reload-skills': reloadSkillsCommand, debug: debugCommand, version: versionCommand
    };
  }
  function showHelp() {
    const builtins = buildCommands().filter(c => c.source !== 'recipe').map(c => '/' + c.name);
    const recipes = buildCommands().filter(c => c.source === 'recipe').length;
    localLine('Commands - ' + builtins.slice(0, 8).join(', ') + (recipes ? ', plus ' + recipes + ' recipe commands.' : '.') + ' Type "/" to browse.');
  }
  function slashPlacedTypes() {
    try {
      if (typeof World === 'undefined' || !World.heroCaps) return [];
      const caps = World.heroCaps((activeWs && activeWs.agentId) || 'agent') || [];
      const out = [], seen = {};
      for (const c of caps) {
        const t = String((c && c.objectType) || c || '').trim();
        if (!t || seen[t]) continue;
        seen[t] = true; out.push(t);
      }
      out.sort();
      return out;
    } catch (_) { return []; }
  }
  function slashCatalogKey() {
    return slashPlacedTypes().join(',');
  }
  function warmSlashCatalog() {
    const key = slashCatalogKey();
    if (slashCatalogLoaded === key) return;
    if (slashCatalogLoading === key || typeof fetch === 'undefined') return;
    slashCatalogLoading = key;
    fetch('/api/slash/catalog?placed=' + encodeURIComponent(key), { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        slashServerCommands = (j && Array.isArray(j.commands)) ? j.commands : null;
        slashCatalogLoaded = key;
      })
      .catch(() => { slashServerCommands = null; slashCatalogLoaded = key; })
      .then(() => {
        slashCatalogLoading = null;
        if (input && input.value && input.value[0] === '/') openSlash(input.value.slice(1));
      });
  }
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
    autoGrowInput();   // COMPOSER: a filled recipe directive can be multi-line — grow to show it
  }
  function normalizeSlashCommand(raw, source) {
    const c = raw || {};
    const name = String(c.name || '').replace(/^\//, '').trim();
    if (!name) return null;
    const action = String(c.action || name).trim();
    return {
      name: name,
      aliases: Array.isArray(c.aliases) ? c.aliases.slice() : [],
      desc: c.desc || c.description || '',
      category: c.category || 'General',
      action: action,
      source: c.source || source || 'server',
      serverBacked: source === 'server',
      run: localSlashActions()[action] || null
    };
  }
  function buildCommands() {
    const cmds = [], seen = {};
    const add = c => {
      if (!c || seen[c.name]) return;
      seen[c.name] = true; cmds.push(c);
    };
    if (slashServerCommands && slashServerCommands.length) {
      for (const c of slashServerCommands) add(normalizeSlashCommand(c, 'server'));
    }
    for (const c of FALLBACK_SLASH_COMMANDS) add(normalizeSlashCommand(c, 'builtin'));
    if (typeof Recipes !== 'undefined' && Recipes.list) {
      for (const r of Recipes.list()) add({ name: r.id, aliases: [], desc: (r.emoji ? r.emoji + ' ' : '') + (r.name || r.id) + (r.tagline ? ' - ' + r.tagline : ''), source: 'recipe', run: () => insertRecipe(r) });
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
      const aliases = (c.aliases || []).map(a => String(a || '').toLowerCase());
      if (n.indexOf(q) === 0 || aliases.some(a => a.indexOf(q) === 0)) pref.push(c);
      else if (n.indexOf(q) >= 0 || aliases.some(a => a.indexOf(q) >= 0) || (c.desc || '').toLowerCase().indexOf(q) >= 0) sub.push(c);
    }
    return pref.concat(sub).slice(0, 8);
  }
  function openSlash(query) {
    const pop = el('chat-slash'); if (!pop) return;
    warmSlashCatalog();
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
  function insertSlashText(text, select) {
    if (!input) return false;
    const directive = String(text || '');
    input.value = directive; input.focus();
    if (select === 'first-placeholder') {
      const m = /\{[^}]+\}/.exec(directive);
      try { if (m) input.setSelectionRange(m.index, m.index + m[0].length); else input.setSelectionRange(directive.length, directive.length); } catch (_) {}
    }
    autoGrowInput();   // COMPOSER: match the box to the inserted directive's height
    return true;
  }
  function applySlashDirective(directive) {
    if (!directive) return false;
    if (directive.type === 'client') {
      const fn = localSlashActions()[directive.action];
      if (!fn) return false;
      fn(directive.args || '');
      return true;
    }
    if (directive.type === 'insert') return insertSlashText(directive.text, directive.select);
    return false;
  }
  async function dispatchSlash(item, rawInput) {
    try {
      const r = await fetch('/api/slash/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: rawInput || ('/' + item.name), placed: slashPlacedTypes() })
      });
      const j = await r.json().catch(() => null);
      return !!(r.ok && j && j.ok && applySlashDirective(j.directive));
    } catch (_) { return false; }
  }
  async function runSlash(item) {
    if (!item) { closeSlash(); return; }
    const rawInput = input ? input.value : '';
    input.value = ''; closeSlash(); autoGrowInput();   // consume the "/query"; a recipe's run() then refills the input
    if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
    if (item.serverBacked && await dispatchSlash(item, rawInput)) return;
    // FALLBACK path (command not resolved by the server dispatcher): parse the trailing text off the raw
    // "/name rest…" input and hand it to the local action, so an arg-taking builtin (e.g. /build-away) still
    // gets its argument even when the server slash catalog doesn't know it. Arg-less actions ignore it.
    const args = String(rawInput || '').replace(/^\/\S+\s*/, '');
    try { item.run(args); } catch (_) {}
  }

  async function send(text, opts) {
    const retry = !!(opts && opts.retry);   // RETRY re-runs the last user message (already in the thread) — don't echo it again
    // R5 "Bottle a run": did THIS directive come from a recipe launch? launchRecipe() passes fromRecipe:true. A
    // recipe-launched run must NEVER be offered for bottling (it already IS a recipe) — recorded in RUN_META below.
    const fromRecipe = !!(opts && opts.fromRecipe);
    // GOAL LOOP: is THIS turn a loop-driven continuation (kickGoal) rather than a real user message? A real user
    // message mid-loop PREEMPTS the loop; a continuation is judged and may fire the next one. Captured here so the
    // teardown routes correctly even if the active loop is paused/cleared mid-run.
    const goalContinuation = !!(opts && opts.goalContinuation);
    // capture whether an active loop already existed WHEN this turn began: only THEN does a real (non-continuation)
    // user message count as a mid-loop preemption. A /goal set DURING this turn must not be preempt-paused by its
    // own triggering turn — that loop simply wasn't running yet when the turn started.
    const goalActiveAtStart = !goalContinuation && typeof GoalLoop !== 'undefined' && (() => { const g = goalOf(activeWs); return !!(g && GoalLoop.isActive(g)); })();
    if (interview) { clearChoices(); interview(text); return; }   // THE AWAKENING owns the input: typed answers retire any stale chip row
    const ws = activeWs;   // CAPTURE the origin stream now — a mid-run switch must not cross-post its cost/files
    if (!ws) return;
    if (Channels.isBusy(ws.id)) return;   // one run per stream — but OTHER streams may be running concurrently
    warmChat();   // D1 WARMTH: sending to the focused stream is real engagement — keep the chat-stare alive
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
    if (!retry) { addUser(text); ws.history.push({ role: 'user', content: text }); capHistory(ws); }   // on RETRY the user turn is already in the thread + on screen
    // name an untitled stream from its first real message (no-op on General / already-titled)
    if (typeof Workstreams !== 'undefined' && Workstreams.autoTitle(ws.id, text)) {
      if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
    }

    const isTask = Classify.isTaskDirective(text);
    // G5 SPECTACLE — a TASK run is the watchable beat: arm the clip ring buffer so its last ~10s are grabbable
    // when the recap lands. Casual chat never records (nothing to share). Disarmed at run end (finally block).
    if (isTask) armClip();
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
    let runStartedAt = 0;   // P3.2: this lead run's start wall-clock → the window claimCrew uses to attribute forwarded worker spend
    activeLiveRow = streamingAgent();
    let acc = '';
    // VOICE STREAMING: when the agent will speak (🔊 on), hand each COMPLETE sentence to Voice as it
    // streams — so it starts talking while the rest is still generating, instead of after the whole reply
    // is done + synthesized. spokenIdx tracks how much of `acc` we've already queued.
    let spokenIdx = 0, finalReply = '', titleOk = false;
    let goalJudgeReply = null;   // GOAL LOOP: set to the clean assistant reply when a turn should be judged; fired in finally
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
        system: sys, messages: historyWindow(ws), agentId: ws.agentId || 'agent', isTask, recurring, signal: ac.signal, streamId: ws.id,
        placed: (typeof World !== 'undefined' && World.heroCaps) ? World.heroCaps(ws.agentId || 'agent') : [],   // THE MOAT: this run's TOOL reach = the agent's REAL placed props (dish→web · cabinet→files · workbench→terminal · …); compute is the freebie
        stationPlaced: (typeof World !== 'undefined' && World.stationCaps) ? World.stationCaps() : [],   // Class Loadouts (shared-gear): station-wide gear for SKILL availability — a desk-only specialist still gets its class skills when the STATION has the gear (tools stay room-scoped via `placed`)
        onRunId: id => { thisRunId = id; runStartedAt = Date.now(); try { RUN_META.set(id, { isTask: !!isTask, title: (ws && ws.title) || '', directive: String(text || ''), fromRecipe: fromRecipe, agentId: ws.agentId || 'agent' }); if (RUN_META.size > 60) RUN_META.delete(RUN_META.keys().next().value); } catch (_) {} Channels.setRunId(ws.id, id); if (typeof Workstreams !== 'undefined') { Workstreams.appendRun(ws.id, id); if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } },
        onToken: d => { acc += d; Channels.appendToken(ws.id, d); if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.append(d); if (!isTask) World.say(acc); } if (willSpeak) pushSpeech(false); App.refreshUsage(); },
        onUsage: () => App.refreshUsage(),
        // COMMS-PREMIUM: the Channels store still records the pre-formatted STRING (replay/switch-survival is
        // unchanged — replayChannel renders those via toolLine), but the LIVE surface renders a structured CHIP.
        // breakLive() closes the prose paragraph AND the prior chip rail only when it's a *call after prose*; a
        // run of consecutive calls shares one rail because onToolResult below never breaks it.
        onToolCall: ev => { callNames[ev.callId] = ev.name; const t = '▶ ' + ev.name + ' ' + brief(ev.argsSummary); Channels.addTool(ws.id, t, false); walkToDesk(); presenceToolCall(ws, ev.name); if (skillFlavor(ev)) recentInRunSkill = Date.now(); if (isActiveWs(ws)) { if (activeLiveRow && activeLiveRow.breakSeg) activeLiveRow.breakSeg(); toolChip(ev); } if (typeof U !== 'undefined' && U.bus && ev.name && ev.name.indexOf('mcp__') === 0) U.bus.emit('agent.tool_call', { name: ev.name }); },
        onToolResult: ev => { if (!ev.isError) runToolsOk++; const nm = callNames[ev.callId] || 'tool'; const t = (ev.isError ? '✕ ' : '◀ ') + nm + ' · ' + brief(ev.summary || (ev.isError ? 'error' : 'ok')) + (ev.isError ? ' — failed' : '') + (ev.ms ? ' (' + fmtMs(ev.ms) + ')' : ''); Channels.addTool(ws.id, t, ev.isError); presenceToolResult(ws); if (isActiveWs(ws)) resolveChip(ev, nm); },
        onDeliverable: ev => {
          // Any produced file is an openable product (image_generate emits kind:'image', fs.write emits
          // kind:'file'). How we RENDER it is decided client-side from the EXTENSION (the reference harness's model), not
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
            if (typeof StationUI !== 'undefined') StationUI.notify((mk === 'file' ? 'saved ' : 'made ') + ev.title, 'gold', 'runComplete');   // P1-8 category: run produced a deliverable
          }
        },
        onPermission: ev => { Channels.setPending(ws.id, { promptId: ev.promptId, tool: ev.tool, argsSummary: ev.argsSummary, runId: Channels.runIdOf(ws.id) }); walkToDesk(); if (isActiveWs(ws)) { breakLive(); permissionRow(ev, ws); renderPresence(); } },
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
        // CRASH HONESTY: a network-kind failure on an in-flight run = the stream to the sidecar dropped (the
        // sidecar crashed / the app lost the connection). The run can't be resumed — the sidecar respawns fresh.
        // Flag this stream so that WHEN the sidecar is provably back (health probe on reconnect) we tell the
        // Commander their run was interrupted and must be restarted, instead of leaving a silent dead run.
        if (v.kind === 'network' && thisRunId) { interruptedStreams.add(ws.id); armReconnectWatch(); }
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
        // GOAL LOOP: a clean turn (done / no endReason) with a real reply is judgeable. A max_iters/budget/refusal
        // stop is NOT — the agent didn't get to finish its thought, so re-judging would be premature. The judge runs
        // in the finally (after teardown) so it never delays this turn's unwind.
        if ((!endReason || endReason === 'done') && replyText.trim() && typeof GoalLoop !== 'undefined' && goalOf(ws)) goalJudgeReply = replyText;
        // the stop-reason is part of the WORK log → close the live paragraph, then drop it in chronologically.
        if (endReason && endReason !== 'done') {
          if (isActiveWs(ws)) breakLive(), toolLine('⏹ ' + (endReason === 'max_iters' ? 'reached the step limit — say "continue" to keep going'
            : endReason === 'budget' ? 'reached this run\'s limit'
            : endReason === 'cancelled' ? (interrupted.has(ws.id) ? 'stopped' : 'run cancelled')
            : 'stopped (' + endReason + ')'));
          if (typeof StationUI !== 'undefined') StationUI.notify('run stopped: ' + endReason, 'warn');
        }
        if (isActiveWs(ws) && activeLiveRow) activeLiveRow.done();
        // R1 MID-TASK FORK: the agent may have ended this reply with one FORK marker (earned only while the
        // style model's confidence is low — the directive isn't even in the prompt otherwise). Render the
        // one-tap chips at the run boundary; a malformed marker parses null and stays plain text.
        if (isActiveWs(ws) && replyText && typeof Fork !== 'undefined' && Fork.parse) {
          const fk = Fork.parse(replyText);
          if (fk) offerFork(fk);
        }
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
        // P3.2 — CLAIM this lead run's dispatched crew (workers whose forwarded run.end fell inside its live window)
        // so a 👍 verdict can split its XP mint honestly. A run that dispatched no crew records nothing (empty list),
        // and the split falls back to lead-only — no fabricated attribution. Only a HERO lead run has crew to claim.
        if (thisRunId && (ws.agentId || 'agent') === 'agent') { const crew = claimCrew(runStartedAt); if (crew.length) { runCrew.set(thisRunId, crew); if (runCrew.size > 60) runCrew.delete(runCrew.keys().next().value); } }
        // COMMS-PREMIUM: resolve the presence card into a compact summary. steps = real successful tool rounds,
        // cost = this run's REAL usd delta — both truthful (shown only when > 0), never fabricated.
        if (isActiveWs(ws)) resolvePresence(ws, { endReason: endReason, steps: runToolsOk, cost: runCost });
        // G5 SPECTACLE — snapshot the clip ring's tail (the run's last ~10s of floor) for THIS run so the recap
        // card's ⏺ affordance can mint it. Taken at run end while the ring is freshest; disarm happens in finally.
        if (thisRunId && isTask) { const r = clipRecorder; const fr = (r && r.frames) ? r.frames() : []; if (fr.length) { runClip.set(thisRunId, fr); if (runClip.size > 8) runClip.delete(runClip.keys().next().value); } }
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
      disarmClip();   // G5: stop sampling the floor when the run ends (the tail snapshot was already taken above)
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
      // D1 WARMTH: a run for the on-screen stream just ended → the focused agent returns to the chat-stare per the
      // D1 loop; re-warm so the stare holds for a fresh window after it answers (the "watch you type ↔ work the
      // answer" beat), instead of the reply-run wall-clock counting against warmth. Only the visible stream re-warms.
      if (isActiveWs(ws)) warmChat();
      // fold this run's REAL usage delta into the origin stream's per-conversation cost — no double-count:
      // the same deltas already minted the lifetime total inside Harness.
      if (typeof Workstreams !== 'undefined') {
        const a = Harness.totals();
        Workstreams.addCost(ws.id, { tokens: a.tokens - before.tokens, usd: a.cost - before.cost, calls: a.calls - before.calls });
        Workstreams.touch(ws.id);
      }
      App.refreshUsage();
      if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
      capHistory(ws);   // E3: bound the stored thread AFTER this turn's assistant reply landed, before it persists
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
      // GOAL LOOP: after the teardown, judge this turn against the standing goal and maybe fire the next continuation.
      // A QUEUED user follow-up wins first — it's the human steering, so let it drain (it will preempt/pause the loop
      // when IT is judged as a non-continuation). Only judge when nothing is queued. Deferred (setTimeout) so it runs
      // after this call fully unwinds and after flushQueued, and re-checks busy/blocked inside judgeGoalTurn/kickGoal.
      const hasQueued = (queued.get(ws.id) || []).length > 0;
      if (typeof GoalLoop !== 'undefined' && goalOf(ws) && !hasQueued) {
        const reply = goalJudgeReply, wasCont = goalContinuation;
        if (wasCont || goalActiveAtStart) {
          // a continuation turn → judge it; a REAL user turn that ran while the loop was already active → preempt.
          setTimeout(() => { judgeGoalTurn(ws, reply, wasCont); }, 0);
        } else {
          // the loop was SET during this very turn (/goal <text> while the stream was busy): this turn isn't a
          // preemption — it's the turn that triggered the loop. Kick the first continuation now the stream freed.
          setTimeout(() => { kickGoal(ws); }, 0);
        }
      }
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
    // a memory deck that arrived MID-interview queued behind the focused flow — drain it now that the
    // question is answered (short hold so the interview's closing line lands first, not under the deck).
    setTimeout(() => showNextTurnin(), 700);
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
    autoGrowInput();   // COMPOSER: appended facets can push the message to multiple lines — grow to fit
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
      const pick = () => { if (done) return; done = true; activeChoiceRows.delete(rowEl); rowEl.remove(); if (typeof SFX !== 'undefined') SFX.click(); onPick(it); };
      // activate on POINTERDOWN, not click: a document-level activity listener (autopilotstore's welcome-back
      // digest) can fire during the capture phase of this same press and remove this row mid-dispatch. The event
      // path is fixed at dispatch start, so this listener still runs on the detached button — whereas the later
      // `click` (press+release) never fires on a removed element and the answer was silently eaten.
      b.addEventListener('pointerdown', e => { if (e.button === 0) pick(); });
      b.onclick = pick;   // keyboard activation (Enter/Space synthesizes click, no pointerdown)
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
  // read-only: did this run do REAL work (>=1 successful tool call OR >=1 delivered product)? The same "real work
  // only" gate maybeStandaloneRate uses — so a pure-chat run is never bottle-offered. Used by App.runBottleInfo (R5).
  function runDidWork(id) { const w = id ? runWork.get(id) : null; return !!(w && ((w.toolsOk || 0) >= 1 || (w.delivered || 0) >= 1)); }

  return { init, load, send, status, localLine, broadcast, setSystem, getHistory, abort, isBusy, beginInterview, endInterview, echoUser, prefill, autoGrowInput, choices, clearChoices, typeLine, nudge, clearNudge, offerCuriosity, offerFork, briefingReceipt, runMeta, runDidWork, awayDigest, awayReview, workshopReturn, refreshIdBar: renderIdBar };
})();
