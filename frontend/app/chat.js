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
  let attachInput = null, attachStrip = null;   // ATTACHMENTS: the hidden <input type=file> + the composer preview strip
  let pendingAtts = [];   // ATTACHMENTS: files staged in the composer for the NEXT send — { name, kind, localUrl, status, ref }
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
  let threadWired = false;      // NS-6: the agent.run.end THREAD turn-in beat listener is registered exactly once
  let threadRunsSeen = new Set();  // NS-6: runIds already thread-fetched (agent.run.end can re-fire; fetch once per run)
  let activeThreadCard = null;  // NS-6: the single visible thread turn-in card { node, prop, decided }
  let activeNudge = null;       // the live curiosity nudge { row, choiceRow, dim } — retired if a turn-in claims the post-run beat
  let recruitShown = false;     // adaptive recruitment: the ONE recruit beat is offered at most once per session (in-memory, resets each app run)
  let activeTurnin = null;      // the single visible memory-review deck; later batches queue behind it
  const turninQueue = [];       // memory-review batches waiting for the visible deck to finish
  const activeChoiceRows = new Set();   // one-shot chip rows; cleared when a typed answer supersedes them
  const proposalRunsSeen = new Set();   // runIds already turned into a beat (memory.proposed fires once per proposal)
  const receiptRunsSeen = new Set();    // runIds whose SILENT auto-saved receipts already rendered (memory.write triggers once per run)
  const clarificationRuns = new Set();  // an intent-question turn is a continuation, not completed work
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

  const el = id => document.getElementById(id);
  let stick = true;   // STICKY-BOTTOM: auto-scroll only fires when the Commander is already at/near the bottom,
                      // so scrolling UP to re-read history mid-stream isn't yanked back down by every token.
  function nearBottom() { return !log || (log.scrollHeight - log.scrollTop - log.clientHeight < 40); }
  function autoscroll() { if (stick && log) log.scrollTop = log.scrollHeight; else if (log) showNewPill(true); }   // content landed while unstuck → "new messages"

  /* COMMS-PREMIUM · the jump-to-bottom pill. Two states over ONE control (stick machinery, no new scroll state):
     • scrolled UP to re-read (stick=false) → a dim, PERSISTENT "↓ latest" affordance (so a keyboard/AT user
       always has a way back to the newest line, not only when new content happens to land);
     • fresh content lands while unstuck → it brightens to "new messages ↓".
     Anchored to #chat-log's bottom EDGE (just above the composer) by measuring the composer height each show,
     so it rides a one- or multi-line composer instead of a magic offset. Click jumps down + re-arms stickiness. */
  function jumpToBottom() { if (log) { log.scrollTop = log.scrollHeight; stick = true; hideNewPill(); } }
  function positionNewPill(pill) {
    // sit the pill just above the composer: distance from the panel's bottom = the composer stack's height.
    const composer = el('chat-inputrow'), queuedEl = el('chat-queued');
    const h = (composer ? composer.offsetHeight : 0) + (queuedEl ? queuedEl.offsetHeight : 0) + 8;
    pill.style.bottom = h + 'px';
  }
  function showNewPill(hasNew) {
    const panel = el('chat-panel'); if (!panel || stick) return;
    let pill = el('comms-newpill');
    if (!pill) {
      pill = document.createElement('button'); pill.id = 'comms-newpill'; pill.type = 'button'; pill.className = 'comms-newpill';
      pill.onclick = () => { if (typeof SFX !== 'undefined' && SFX.click) SFX.click(); jumpToBottom(); };
      panel.appendChild(pill);
    }
    if (hasNew) pill.classList.add('hasnew');
    const isNew = pill.classList.contains('hasnew');
    pill.textContent = isNew ? 'new messages' : 'latest';   // the ▾ chevron is drawn by CSS (::after), not a font glyph
    pill.setAttribute('aria-label', isNew ? 'Jump to newest messages' : 'Scroll to latest');
    positionNewPill(pill);
    pill.classList.add('show');
  }
  function hideNewPill() { const p = el('comms-newpill'); if (p) { p.classList.remove('show'); p.classList.remove('hasnew'); } }

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
    const txt = fmtElapsed(Channels.elapsedOf(activeWs.id, Date.now()));   // honest elapsed: re-stamped to the confirmed run start, approval pauses excluded
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
    // a RESOLVED card is transcript history ("■ RUN COMPLETE · …"), not the live indicator. Resurrecting it
    // by id broke every run after a stream's first: its children were destroyed by the summary write, so the
    // live verb/tool/time could never render again, and the re-pin below dragged the old summary under the
    // new turn. Strip its id (it stays in place as history) and build a fresh live card.
    if (card && card.classList.contains('resolved')) { card.removeAttribute('id'); card = null; }
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
    // TRUTHFUL TELEMETRY: until the sidecar's agent.run.start lands the card says CONNECTING — it never
    // claims the agent is thinking/working on the strength of a click alone (a downed sidecar would
    // otherwise show "THINKING" forever).
    if (cs && /connect/i.test(cs)) return 'CONNECTING';
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
    const time = card.querySelector('.cp-time'); const txt = fmtElapsed(Channels.elapsedOf(activeWs.id, Date.now()));
    if (time && time.textContent !== txt) time.textContent = txt;
  }
  function startPresence(ws) {
    presenceCurTool = null;
    if (isActiveWs(ws)) { renderPresence(); ensureElapsedTimer(); }   // the elapsed tick also drives the presence update
  }
  function presenceToolCall(ws, name) { presenceCurTool = name || null; if (isActiveWs(ws)) renderPresence(); }
  function presenceToolResult(ws) { presenceCurTool = null; if (isActiveWs(ws)) renderPresence(); }
  // remove any live presence card without a summary (used when switching away / re-rendering a stream)
  function clearPresence() { const c = log && log.querySelector('#comms-presence'); if (c) { if (c.classList.contains('resolved')) c.removeAttribute('id'); else c.remove(); } presenceCurTool = null; }   // a resolved summary is history — keep it, only live cards are torn down
  // resolve the live card into a compact one-line summary that STAYS in the transcript. opts: { error, raw,
  // stopped, endReason, steps, cost }. Truthful: steps/cost only appear when a real number is supplied.
  function resolvePresence(ws, opts) {
    if (!isActiveWs(ws)) { clearPresence(); return; }
    opts = opts || {};
    const started = (typeof Channels !== 'undefined') ? Channels.startedAtOf(ws.id) : 0;
    const dur = started ? fmtElapsed(Channels.elapsedOf(ws.id, Date.now())) : '';   // machine time only — approval pauses excluded
    const card = log && log.querySelector('#comms-presence');
    if (!card) return;
    card.classList.remove('cp-live');
    presenceCurTool = null;
    const isErr = !!opts.error, isStop = !!opts.stopped || (opts.endReason && opts.endReason !== 'done') || !!opts.cutShort;
    card.classList.add('resolved'); if (isErr) card.classList.add('err'); else if (isStop) card.classList.add('stopped');
    let label = isErr ? '■ RUN FAILED' : opts.cutShort ? '■ CUT SHORT' : isStop ? '■ RUN STOPPED' : '■ RUN COMPLETE';
    const bits = [];
    if (dur) bits.push(dur);
    if (typeof opts.steps === 'number' && opts.steps > 0) bits.push(opts.steps + (opts.steps === 1 ? ' step' : ' steps'));
    if (typeof opts.cost === 'number' && opts.cost > 0) bits.push(U.usd(opts.cost));
    card.textContent = label + (bits.length ? ' · ' + bits.join(' · ') : '');
    card.setAttribute('role', 'note');
    autoscroll();
  }
  // POST-RUN DEDUPE: when a recap card is about to render (it owns cost · duration · model + the artifact list),
  // strip the metrics from the already-resolved presence line above it so the two don't print the same numbers.
  // Keeps just the terse status label (the part before the first ' · '). No-op if there's no resolved card.
  function foldPresenceIntoRecap() {
    const card = log && log.querySelector('#comms-presence.resolved');
    if (!card) return;
    const label = String(card.textContent || '').split(' · ')[0];
    if (label && card.textContent !== label) card.textContent = label;
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

  // COMMS GLYPHS — small currentColor SVGs that replace color emoji (📁/📄/🖼/📋) so they inherit the phosphor
  // theme instead of puncturing the CRT look with an OS-coloured emoji. Static developer markup (no model/user
  // text) → assigning via innerHTML on a fresh element is XSS-safe. Sized in em so they ride the text they sit in.
  const SVG_FOLDER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 3.6h4l1.2 1.5h7.6v7.8H1.6z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  const SVG_FILE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.6h5l3 3v9.8H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.6v3h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  const SVG_IMAGE = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="5.7" cy="6.3" r="1" fill="currentColor"/><path d="M2.8 12l3.6-3.6 2.3 2.3L11 8.6l2.2 2.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  const SVG_CLIP = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 8.2 8.5 4.3a2.2 2.2 0 0 1 3.1 3.1l-4.8 4.8a3.4 3.4 0 0 1-4.8-4.8l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // build a span carrying one of the static SVGs above (a leading COMMS glyph before a text label)
  function glyphSpan(svg, cls) { const s = document.createElement('span'); s.className = 'comms-glyph' + (cls ? ' ' + cls : ''); s.setAttribute('aria-hidden', 'true'); s.innerHTML = svg; return s; }

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
  /* MINIMAL TERMINAL-MARKDOWN (XSS-SAFE) — model prose often carries light markdown (**bold**, `code`, fenced
     blocks, - lists, # headers). We render a SMALL subset as phosphor spans, NEVER as heavy web type. The XSS
     invariant is inviolate: every model substring is HTML-ESCAPED first (escapeHtml / linkify both escape), and
     we only ever wrap ALREADY-ESCAPED text in our OWN tags — model output never reaches innerHTML raw. `code`
     spans are pulled to placeholders before the bold pass so a ** inside code stays literal. */
  const MD_MARKERS = /\*\*|`|^#{1,6}\s|^[ \t]*[-*]\s/m;   // cheap gate: does this text carry any markdown we render?
  function mdInline(safe) {
    // `safe` is escaped-and-linkified HTML. Pull `inline code` to placeholders, bold the rest, restore code.
    const codes = [];
    let s = safe.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '' + (codes.length - 1) + ''; });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<span class="md-b">$1</span>');
    s = s.replace(/(\d+)/g, (m, i) => '<code class="md-code">' + codes[+i] + '</code>');
    return s;
  }
  function renderMarkdown(raw) {
    const lines = String(raw).split('\n');
    const parts = [];
    let fence = null;   // collecting a ``` fenced block
    for (const ln of lines) {
      if (/^[ \t]*```/.test(ln)) {
        if (fence) { parts.push('<span class="md-pre">' + escapeHtml(fence.join('\n')) + '</span>'); fence = null; }
        else fence = [];
        continue;
      }
      if (fence) { fence.push(ln); continue; }
      const h = /^(#{1,6})\s+(.*)$/.exec(ln);
      if (h) { parts.push('<span class="md-h">' + mdInline(linkify(h[2])) + '</span>'); continue; }
      const li = /^([ \t]*)[-*]\s+(.*)$/.exec(ln);
      if (li) { parts.push('<span class="md-li"><span class="md-bul">▪ </span>' + mdInline(linkify(li[2])) + '</span>'); continue; }
      parts.push(mdInline(linkify(ln)));
    }
    if (fence) parts.push('<span class="md-pre">' + escapeHtml(fence.join('\n')) + '</span>');   // unterminated (mid-stream) — render what we have
    return parts.join('\n');
  }
  // render agent prose into a body span. Fast textContent path when there's no URL AND no markdown marker (the
  // common streamed token) — no per-token HTML reparse; otherwise the escaped+linkified+markdown pipeline.
  function renderProse(bodyEl, raw) {
    if (!bodyEl) return;
    raw = String(raw == null ? '' : raw);
    if (raw.indexOf('http') === -1 && !MD_MARKERS.test(raw)) { bodyEl.textContent = raw; return; }
    bodyEl.innerHTML = renderMarkdown(raw);
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

  // INPUT HISTORY — terminal-style recall of what the Commander already sent this session. ArrowUp in an
  // EMPTY composer (or while already recalling) walks back; ArrowDown walks forward and lands back on the
  // in-progress draft. Typing anything exits recall mode (the 'input' listener resets histIdx), so a
  // multiline draft is never hijacked mid-edit. Session-scoped, never persisted.
  const sentHistory = []; let histIdx = -1, histDraft = '';
  const HIST_CAP = 100;
  function recordSent(t) { if (!t) return; if (sentHistory[sentHistory.length - 1] !== t) { sentHistory.push(t); if (sentHistory.length > HIST_CAP) sentHistory.shift(); } histIdx = -1; histDraft = ''; }
  function recallInto(v) { input.value = v; autoGrowInput(); try { input.setSelectionRange(v.length, v.length); } catch (_) {} }

  function init(opts) {
    system = opts.system || ''; name = opts.name || 'AGENT';
    sentHistory.length = 0; histIdx = -1; histDraft = '';   // recall never crosses a session/agent switch
    onTurn = opts.onTurn || null; interview = null;
    proposalRunsSeen.clear(); receiptRunsSeen.clear(); studyRunsSeen.clear(); clearChoices(); turninQueue.length = 0; activeTurnin = null; wiQDepth.clear(); queued.clear(); interrupted.clear();   // C2: per-session run-tracking + the queue gauge + turn-control state start clean for each agent (listeners stay once-registered)
    // GROWTH Tier 1: the study side starts clean per session too — a prior hero's deferred study/taste beats must
    // never flush into a new session (same law as turninQueue above). A fresh beat-slot arbiter matches the DOM.
    studyPending.length = 0; tastePending.length = 0; activeStudy = null;
    arcRunsSeen.clear();   // GROWTH Tier 2: the arc side starts clean per session (a prior hero's arc offers never carry over)
    trustRunsSeen.clear(); activeTrust = null;   // GROWTH Tier 3: the trust side starts clean per session (a prior hero's earned-autonomy offers never carry over)
    threadRunsSeen.clear(); threadPending.length = 0; activeThreadCard = null;   // NS-6: the thread turn-in side starts clean per session (same law)
    beatSlot = (typeof Study !== 'undefined' && Study.makeBeatSlot) ? Study.makeBeatSlot() : null;
    log = el('chat-log'); input = el('chat-input'); statusEl = el('chat-status');
    // F2: re-derive the idle status on the same cadence the topbar repaints #sig (3s) so a link that dies with
    // NO run in flight still downgrades 'online' → 'station unreachable'. Once-armed (init re-runs per session).
    if (typeof window !== 'undefined' && !window.__chatLinkStatusTimer) {
      window.__chatLinkStatusTimer = setInterval(() => { try { if (!isBusy()) syncStatus(); } catch (_) {} }, 3000);
    }
    attachInput = el('chat-attach-input'); attachStrip = el('chat-attach-strip');
    clearAttachments();   // a fresh agent session starts with no staged attachments (matches the clean-slate init above)
    if (log) log.addEventListener('scroll', () => { stick = nearBottom(); if (stick) hideNewPill(); else showNewPill(false); });   // at the bottom → retire the pill; scrolled up → a persistent "↓ latest" affordance
    // COPY: one delegated click handler for every (current + future) message row's ⧉ button — copies the
    // row's prose, then flashes a ✓ confirm. Wired once per log element so a re-init can't stack handlers.
    if (log && !log.__copyWired) {
      log.__copyWired = true;
      log.addEventListener('click', e => {
        // SELECTION GUARD: the transcript is selectable text — a mouse-up that ENDS a drag-selection must
        // never also fire a click action (chip toggle), or selecting inside a chip snaps it shut.
        const selecting = !!(window.getSelection && String(window.getSelection()));
        // LINKS (desktop): a linkified <a target=_blank> is silently dead under the Tauri window policy
        // (same law as openSignIn / the workshop Open-it action) — hand real http(s) hrefs to the OS
        // browser. In a plain browser the default target=_blank behavior stands.
        const link = e.target.closest('a');
        if (link && /^https?:\/\//i.test(link.getAttribute('href') || '')) {
          if (selecting) { e.preventDefault(); return; }
          const invoke = (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core.invoke : null;
          if (invoke) {
            e.preventDefault();
            invoke('open_external_url', { url: link.href }).catch(() => { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('could not open your browser for that link', 'warn'); });
          }
          return;
        }
        // TOOL CHIP: clicking a chip's head toggles its expanded detail (checked before the copy button)
        const chipHead = e.target.closest('.tc-head');
        if (chipHead) { if (selecting) return; toggleChip(chipHead); if (typeof SFX !== 'undefined' && SFX.click) SFX.click(); return; }
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
    wireThreads();     // NS-6: after a mined task run, offer ONE thread turn-in (Keep/Edit/Discard) at the lowest beat priority — study wins the moment first (registers once)
    wireCrewCapture(); // P3.2: record each dispatched worker's forwarded run-end spend so a 👍 on a crew run splits XP honestly (registers once)
    wireCuriosity();   // Commander Dossier: one gentle "tell me about X" nudge after a clean run (registers once)
    wireBgExit();      // E6: surface shell.bg.exit (a background dev-server/watcher ended) as a terse COMMS system line — was a zero-listener event (registers once)
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
      // INPUT HISTORY — recall starts only from an EMPTY box (a draft in progress is never hijacked);
      // once recalling, ArrowUp/ArrowDown walk the sent list, ArrowDown past the newest restores the draft.
      if (e.key === 'ArrowUp' && sentHistory.length && (histIdx >= 0 || input.value === '')) {
        e.preventDefault();
        if (histIdx < 0) { histDraft = input.value; histIdx = sentHistory.length; }
        if (histIdx > 0) { histIdx--; recallInto(sentHistory[histIdx]); }
        return;
      }
      if (e.key === 'ArrowDown' && histIdx >= 0) {
        e.preventDefault();
        histIdx++;
        if (histIdx >= sentHistory.length) { histIdx = -1; recallInto(histDraft); histDraft = ''; }
        else recallInto(sentHistory[histIdx]);
        return;
      }
      if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) {   // Shift+Enter falls through → newline in the textarea
        e.preventDefault();
        submitComposer();
      } else if (e.key === 'Escape' && isBusy()) {
        e.preventDefault(); e.stopPropagation();   // INTERRUPT: beat navdock's global Esc-closes-menus while a run is live
        stopActive();
      }
    };
    // SLASH PALETTE: a leading "/" opens the command menu and filters it live as you type past it.
    input.addEventListener('input', () => { autoGrowInput(); warmChat(); histIdx = -1; const v = input.value; if (v[0] === '/') openSlash(v.slice(1)); else closeSlash(); });   // real typing exits history-recall mode
    const stopBtn = el('chat-stop'); if (stopBtn) stopBtn.onclick = stopActive;
    const sendBtn = el('chat-send'); if (sendBtn) sendBtn.onclick = () => { submitComposer(); input.focus(); };   // SEND chip: same path as Enter, keep the caret
    wireComposerAttachments();   // ATTACHMENTS: paperclip · paste · drag-drop -> stage files in the composer
  }

  // THE ONE SEND PATH — shared by Enter and the SEND chip. Handles: attachment-only sends, session history recall,
  // typo'd/unknown slash commands (a LOCAL system line, never a paid model turn), type-ahead queueing while busy,
  // and settling in-flight uploads so a staged file is never silently dropped.
  async function submitComposer() {
    const t = input.value.trim();
    const hasStaged = pendingAtts.length > 0;   // ANY staged file (uploading or ready) makes this a valid send
    if (!t && !hasStaged) return;
    if (t) recordSent(t);   // history records every sent line — commands included, like a shell
    // SLASH: a "/name …" line dispatches as a command, never chat. A recognised command runs; an UNKNOWN one
    // (a typo like "/hlep") gets a local "unknown command" line — NOT sent to the agent as a paid model turn.
    // Gate on a command-SHAPED first token (letters/digits/hyphen) so a real message that starts with a path
    // ("/etc/hosts is broken") still goes to the agent instead of tripping the unknown-command line.
    if (t && /^\/[a-z][\w-]*(?:\s|$)/i.test(t)) {
      const cmd = commandFromLine(t);
      closeSlash();
      if (cmd) { runSlash(cmd); return; }
      input.value = ''; autoGrowInput();
      const nm = (t.match(/^\/(\S+)/) || ['', ''])[1];
      localLine('Unknown command: /' + nm + '. Type "/" to browse commands, or /help.');
      return;
    }
    // BUSY: type-ahead queues TEXT; staged files wait in the strip for the next idle send (one run per stream).
    if (isBusy()) { if (t) { input.value = ''; closeSlash(); autoGrowInput(); enqueue(t); } return; }
    // SETTLE UPLOADS: a staged attachment still uploading must not be silently dropped — uploads to the local
    // sidecar are near-instant, so we AWAIT them before snapshotting. A failed one already notified per-file.
    if (hasStaged) await settleAttachments();
    const atts = takeAttachments();   // snapshot the READY refs + clear the composer strip
    if (!t && !atts.length) return;   // everything failed to upload and there's no text → nothing to send
    input.value = ''; closeSlash(); autoGrowInput();   // COMPOSER: collapse back to one line after a send
    send(t, { attachments: atts });
  }

  /* ── ATTACHMENTS ────────────────────────────────────────────────────────────────────────────────────
     Photos/files the Commander attaches to a message (like Claude Code / Codex). Three ways in: the 📎
     button (file picker), paste from the clipboard, and drag-drop onto the composer. Each file is uploaded
     to the sidecar (POST /api/attachments -> saved in the agent's workspace, jailed) and staged as a chip;
     on send, the READY refs ride the user turn as lightweight { id,name,path,mediaType,kind } records (never
     base64 — localStorage stays tiny), and the sidecar re-expands them into image/text content at run time. */
  const ATTACH_IMG_EXT = { png:1, jpg:1, jpeg:1, gif:1, webp:1 };   // types the model can actually SEE as images
  const ATTACH_MAX_FILE_BYTES = 8 * 1024 * 1024;
  function attachAgentId() { return (activeWs && activeWs.agentId) || 'agent'; }
  function fileKind(file) {
    const ext = String(file && file.name || '').split('.').pop().toLowerCase();
    if (ATTACH_IMG_EXT[ext] || /^image\/(png|jpeg|gif|webp)$/.test(String(file && file.type || ''))) return 'image';
    return 'file';
  }
  function wireComposerAttachments() {
    const btn = el('chat-attach');
    if (btn) btn.onclick = () => { if (attachInput) attachInput.click(); };
    if (attachInput) attachInput.onchange = () => { handleFiles(attachInput.files); attachInput.value = ''; };
    // PASTE: a screenshot or copied file pasted into the message box becomes an attachment (text still types normally)
    input.addEventListener('paste', ev => {
      const items = ev.clipboardData && ev.clipboardData.files;
      if (items && items.length) { ev.preventDefault(); handleFiles(items); }
    });
    // DRAG-DROP onto the whole composer. preventDefault on dragover is what enables the drop.
    const row = el('chat-inputrow');
    if (row) {
      const show = e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; row.classList.add('attach-dragover'); };
      row.addEventListener('dragenter', show);
      row.addEventListener('dragover', show);
      row.addEventListener('dragleave', e => { if (e.target === row) row.classList.remove('attach-dragover'); });
      row.addEventListener('drop', e => { e.preventDefault(); row.classList.remove('attach-dragover'); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
    }
  }
  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const f of files) {
      if (!f) continue;
      if (f.size > ATTACH_MAX_FILE_BYTES) { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('“' + f.name + '” is too large to attach (max 8MB)', 'warn'); continue; }
      stageFile(f);
    }
    renderAttachStrip();
  }
  // stage one file: show a chip immediately (local thumbnail for images), then upload it in the background.
  // The upload promise is kept on the entry (entry.p) so a send can AWAIT an in-flight upload instead of dropping it.
  function stageFile(file) {
    const kind = fileKind(file);
    const entry = { name: file.name || 'file', kind, localUrl: (kind === 'image') ? URL.createObjectURL(file) : '', status: 'uploading', ref: null, p: null };
    pendingAtts.push(entry);
    entry.p = uploadAttachment(file).then(ref => {
      entry.status = 'ready'; entry.ref = ref;
    }).catch(() => {
      entry.status = 'error';
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('could not attach “' + entry.name + '”', 'warn');
    }).then(() => renderAttachStrip());
  }
  // wait for every still-uploading staged file to settle (resolve or fail) so a send never silently drops one
  // that was mid-flight. Local-sidecar uploads are near-instant; this is a very short await in practice.
  async function settleAttachments() {
    const inflight = pendingAtts.filter(e => e && e.status === 'uploading' && e.p).map(e => e.p);
    if (inflight.length) { try { await Promise.allSettled(inflight); } catch (_) {} }
  }
  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('read failed'));
      fr.readAsDataURL(file);
    });
  }
  async function uploadAttachment(file) {
    const dataUrl = await readAsDataUrl(file);
    const tok = (typeof Harness !== 'undefined' && Harness.apiToken) ? String(Harness.apiToken() || '') : '';
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers['X-StarNet-Token'] = tok;
    const res = await fetch('/api/attachments', { method: 'POST', headers, body: JSON.stringify({ agent: attachAgentId(), name: file.name || 'file', dataUrl }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j || !j.ok) throw new Error((j && j.error) || ('upload HTTP ' + res.status));
    return { id: j.id, name: j.name, path: j.path, mediaType: j.mediaType, kind: j.kind };
  }
  // render the composer preview strip from pendingAtts (thumbnails for images, a glyph + name for files).
  function renderAttachStrip() {
    if (!attachStrip) return;
    attachStrip.textContent = '';
    if (!pendingAtts.length) { attachStrip.hidden = true; return; }
    attachStrip.hidden = false;
    pendingAtts.forEach((entry, i) => {
      const chip = document.createElement('span');
      chip.className = 'chat-attach-chip' + (entry.status === 'uploading' ? ' uploading' : '') + (entry.status === 'error' ? ' err' : '');
      if (entry.kind === 'image' && entry.localUrl) {
        const img = document.createElement('img'); img.className = 'thumb'; img.src = entry.localUrl; img.alt = entry.name;
        img.title = 'click to enlarge';
        // enlarge the STAGED image before sending it — the strip still owns entry.localUrl, so no revoke here
        img.addEventListener('click', () => openLightbox(() => entry.localUrl, entry.name, { revoke: false }));
        chip.appendChild(img);
      } else {
        const g = document.createElement('span'); g.className = 'glyph'; g.setAttribute('aria-hidden', 'true');
        g.innerHTML = entry.kind === 'image' ? SVG_IMAGE : SVG_FILE;   // themed glyph, not a color emoji
        chip.appendChild(g);
      }
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = entry.name; nm.title = entry.name;
      chip.appendChild(nm);
      const rm = document.createElement('button'); rm.className = 'rm'; rm.type = 'button'; rm.textContent = '×';
      rm.title = 'remove'; rm.setAttribute('aria-label', 'Remove ' + entry.name);
      rm.onclick = () => removePending(i);
      chip.appendChild(rm);
      attachStrip.appendChild(chip);
    });
  }
  function removePending(i) {
    const entry = pendingAtts[i];
    if (!entry) return;
    if (entry.localUrl) { try { URL.revokeObjectURL(entry.localUrl); } catch (_) {} }
    // best-effort: prune the uploaded bytes so an attach-then-remove doesn't orphan a file in the workspace
    if (entry.ref && entry.ref.path) {
      const tok = (typeof Harness !== 'undefined' && Harness.apiToken) ? String(Harness.apiToken() || '') : '';
      const headers = { 'Content-Type': 'application/json' }; if (tok) headers['X-StarNet-Token'] = tok;
      fetch('/api/attachments', { method: 'POST', headers, body: JSON.stringify({ op: 'delete', agent: attachAgentId(), path: entry.ref.path }) }).catch(() => {});
    }
    pendingAtts.splice(i, 1);
    renderAttachStrip();
  }
  // snapshot the READY refs for a send, then clear the strip. (submitComposer awaits settleAttachments first, so
  // an upload that was in flight is settled — not dropped — before this snapshot runs.)
  function takeAttachments() {
    const ready = pendingAtts.filter(e => e.status === 'ready' && e.ref).map(e => e.ref);
    clearAttachments();
    return ready;
  }
  function hasStagedAttachments() { return pendingAtts.some(e => e.status === 'ready' && e.ref); }
  function clearAttachments() {
    for (const e of pendingAtts) { if (e.localUrl) { try { URL.revokeObjectURL(e.localUrl); } catch (_) {} } }
    pendingAtts = [];
    renderAttachStrip();
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
    updateCharCount();   // the char counter rides every value change (typed, recalled, recipe-filled, send-reset)
  }
  // COMPOSER CAP READOUT — the textarea maxlength is 4000; a dim counter appears only as the message NEARS the
  // cap (so it never nags a normal message) and turns --warn at the very edge. Truthful: it reads the real length.
  const COMPOSER_MAX = 4000, COMPOSER_WARN_AT = 3600;
  function updateCharCount() {
    const cc = el('chat-charcount'); if (!cc) return;
    const n = input ? input.value.length : 0;
    if (n < COMPOSER_WARN_AT) { if (!cc.hidden) { cc.hidden = true; cc.textContent = ''; cc.classList.remove('warn'); } return; }
    cc.hidden = false;
    cc.textContent = n + ' / ' + COMPOSER_MAX;
    cc.classList.toggle('warn', n >= COMPOSER_MAX - 100);
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
  // P1.2 (UPDATE_STATE_SAFETY_AUDIT) — an honest one-line notice shown in the COMMS header's model slot when the
  // focused agent id is NOT in the live registry (roster out of sync). focusAgent sets it instead of silently
  // rebinding to the overseer; a subsequent focus onto a REAL agent clears it (''). No new window, no .reply beat —
  // it reuses the existing aria-live model-readout element + a modifier class, per frontend law.
  let rosterStatusMsg = '';
  function setRosterStatus(msg) {
    rosterStatusMsg = String(msg == null ? '' : msg);
    const modelEl = el('comms-agent-model');
    if (modelEl && rosterStatusMsg) { modelEl.textContent = rosterStatusMsg; modelEl.classList.add('comms-agent-warn'); }
    else if (modelEl) { modelEl.classList.remove('comms-agent-warn'); renderIdBar(); }
  }
  function renderIdBar() {
    const sel = el('comms-agent-select'); const modelEl = el('comms-agent-model'); const bar = el('comms-idbar');
    if (!sel) return;
    // an active roster-out-of-sync notice wins the model slot: don't overwrite the honest state with a stale
    // model readout while the focused id can't be resolved (focusAgent clears it once a real agent is focused).
    if (rosterStatusMsg) { if (modelEl) { modelEl.textContent = rosterStatusMsg; modelEl.classList.add('comms-agent-warn'); } if (bar) bar.hidden = false; return; }
    if (modelEl) modelEl.classList.remove('comms-agent-warn');
    const list = (typeof App !== 'undefined' && App.agents) ? (App.agents() || []) : [];
    const duplicateAgentName = a => {
      const key = String((a && a.name) || '').trim().toUpperCase();
      return !!key && list.filter(x => String((x && x.name) || '').trim().toUpperCase() === key).length > 1;
    };
    const activeId = activeWs ? (activeWs.agentId || 'agent') : null;
    // rebuild the <option> set only when the roster (ids+names) or selection changed, so a redundant re-render
    // never collapses a mid-open native dropdown.
    const key = list.map(a => a.id + ':' + (a.name || a.id)).join('|') + '#' + (activeId == null ? '' : activeId);
    if (sel.__idKey !== key) {
      sel.__idKey = key;
      sel.innerHTML = '';
      for (const a of list) { const o = document.createElement('option'); o.value = a.id; o.textContent = (a.name || a.id) + (duplicateAgentName(a) ? ' [' + a.id + ']' : ''); sel.appendChild(o); }
      if (activeId != null) sel.value = activeId;
    }
    const cur = list.find(a => a.id === activeId) || null;
    // "pin:" prefix so this per-agent PINNED model readout can't be misread as the dock's active-model chip
    if (modelEl) modelEl.textContent = cur ? ('pin: ' + agentModelText(cur)) : '';
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
    activeThreadCard = null;   // NS-6: the thread turn-in card is likewise a visible review layer bound to the outgoing DOM
    if (beatSlot && beatSlot.visibleBeat()) beatSlot = (typeof Study !== 'undefined' && Study.makeBeatSlot) ? Study.makeBeatSlot() : null;   // the visible beat left with its DOM; a fresh arbiter matches the new stream
    endToolRail(); presenceCurTool = null;   // COMMS-PREMIUM: the tool rail + live-tool state belong to the OUTGOING stream's DOM
    // typing targets the displayed stream (war-room D2: the compose target is decoupled from any camera jump)
    if (activeWs && typeof Channels !== 'undefined') Channels.setComposeTarget(activeWs.id);
    if (log) log.innerHTML = '';
    stick = true; hideNewPill();   // a freshly-loaded / switched-to stream starts pinned to its latest line
    renderHistory();
    restoreTaskQuestion(activeWs);   // restart/switch continuity: re-present a real still-unanswered durable brief
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
    // SESSION DELIVERY (2026-07-15): opening a deliverable's own session ('workshop-<runId>') is what renders
    // its return card — never a pop-up into whichever stream happened to be selected. presentFor no-ops fast on
    // every other id, re-checks the server (undecided only), and the card itself is pinned to this session.
    if (activeWs && typeof WorkshopStore !== 'undefined' && WorkshopStore.presentFor) {
      try { WorkshopStore.presentFor(activeWs.id).catch(() => {}); } catch (_) {}
    }
  }

  async function restoreTaskQuestion(ws) {
    if (!ws || !ws.id) return;
    const id = String(ws.id), key = 'stream:' + id;
    try {
      const r = await fetch('/api/task-briefs?key=' + encodeURIComponent(key) + '&status=clarifying&limit=1', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (!activeWs || activeWs.id !== id || isBusy()) return;
      const b = j && Array.isArray(j.briefs) && j.briefs[0];
      const q = b && Array.isArray(b.questions) && b.questions[b.questions.length - 1];
      if (q && !q.answer && Array.isArray(q.options) && q.options.length >= 2) offerTaskQuestion({ question: q.text, options: q.options, recommended: q.recommended || '', reason: q.reason || '' });
    } catch (_) { /* a missing/offline sidecar leaves history readable; the next load retries */ }
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
    // drop LOCAL markers that are records, not dialogue: the history-cap marker (truncated) and any system status
    // line (sys — e.g. an autosessions "routine ran, nothing to report" / "couldn't load the output" framing line).
    // These must NEVER be replayed to the model as prior turns (a frontend-authored string is not the agent's word).
    const real = ws.history.filter(m => !(m && (m.truncated || m.sys)));
    return real.length > HISTORY_CAP ? real.slice(-HISTORY_CAP) : real;
  }
  function getHistory() { return activeWs ? activeWs.history.slice() : []; }
  // A streamed fragment is real assistant output even when the transport dies before a clean result envelope.
  // Persist it as its own turn before the failure marker so switch/reload cannot erase what was already visible.
  function persistPartial(ws, text) {
    if (!ws || !ws.history) return false;
    const content = String(text == null ? '' : text);
    if (!content.trim()) return false;
    const last = ws.history[ws.history.length - 1];
    if (last && last.role === 'assistant' && !last.error && last.content === content) return false;
    ws.history.push({ role: 'assistant', content: content, ts: Date.now() });
    capHistory(ws);
    return true;
  }
  function isBusy() { return !!(activeWs && typeof Channels !== 'undefined' && Channels.isBusy(activeWs.id)); }
  function isActiveWs(ws) { return !!(ws && activeWs && activeWs.id === ws.id); }   // is THIS stream the one on screen right now?
  // The backend mutex is per AGENT/workspace, not per session. Resolve that same scope locally so a fresh
  // session never claims ONLINE or accepts a doomed turn while another session owns this agent's run.
  function busyPeerFor(ws) {
    if (!ws || typeof Workstreams === 'undefined' || typeof Channels === 'undefined') return null;
    const aid = ws.agentId || 'agent';
    const list = Workstreams.list ? Workstreams.list({ includeArchived: true }) : (Workstreams.all ? Workstreams.all() : []);
    return list.find(w => w && w.id !== ws.id && (w.agentId || 'agent') === aid && Channels.isBusy(w.id)) || null;
  }
  function renderAgentBusy(peer, detail) {
    if (!log) return;
    const old = log.querySelector('#comms-agent-busy');
    if (!peer && !detail) { if (old) old.remove(); return; }
    const rowEl = old || document.createElement('div');
    rowEl.id = 'comms-agent-busy'; rowEl.className = 'choice-row comms-agent-busy'; rowEl.textContent = '';
    const label = document.createElement('span'); label.className = 'dim';
    label.textContent = peer ? ('BUSY IN ' + streamLabel(peer).toUpperCase()) : String(detail || 'AGENT BUSY');
    rowEl.appendChild(label);
    if (peer) {
      const view = document.createElement('button'); view.type = 'button'; view.className = 'choice'; view.textContent = 'VIEW ACTIVE RUN';
      view.onclick = () => { if (typeof App !== 'undefined' && App.openWorkstream) App.openWorkstream(peer.id); };
      rowEl.appendChild(view);
    }
    if (!old) log.appendChild(rowEl);
  }
  function status(s) {
    if (!statusEl) return;
    statusEl.textContent = s;
    const low = String(s || '').toLowerCase();
    statusEl.classList.remove('status-thinking', 'status-working', 'status-approval', 'status-stopping', 'status-connecting', 'status-online', 'status-down');
    statusEl.classList.add(low.indexOf('approval') >= 0 ? 'status-approval'
      : low.indexOf('stopping') >= 0 ? 'status-stopping'
      : low.indexOf('working') >= 0 ? 'status-working'
      : low.indexOf('thinking') >= 0 ? 'status-thinking'
      : low.indexOf('connecting') >= 0 ? 'status-connecting'
      : low.indexOf('unreachable') >= 0 ? 'status-down'
      : 'status-online');
  }
  // derive the DISPLAYED stream's status from real state, so a low-priority write (a finishing turn) can't
  // clobber the high-priority 'awaiting your approval…' after a switch-back. One source of truth.
  function syncStatus() {
    if (interview) { status('waking…'); stopElapsedTimer(); return; }
    const p = (activeWs && typeof Channels !== 'undefined') ? Channels.pendingOf(activeWs.id) : null;
    const channelStatus = (activeWs && typeof Channels !== 'undefined' && Channels.statusOf) ? Channels.statusOf(activeWs.id) : '';
    // F2 (2026-07-14 adversarial sweep): the idle claim folds the REAL bridge health (World.linkState — the
    // same E1 predicate the topbar #sig / canvas LINK DOWN already read). A dead sidecar kept this label
    // asserting 'online' indefinitely — connectivity the harness (being gone) provably couldn't back. Only a
    // genuinely bridged-but-dead link downgrades; pre-entry and a deliberate pause still read as before.
    let down = false;
    try { const ls = (typeof World !== 'undefined' && World.linkState) ? World.linkState() : null; down = !!(ls && ls.bridged && !ls.paused && ls.down); } catch (_) {}
    const peer = !isBusy() ? busyPeerFor(activeWs) : null;
    status(p ? 'awaiting your approval…' : (isBusy() ? (channelStatus || 'thinking…') : (peer ? ('busy in ' + streamLabel(peer)) : (down ? 'station unreachable' : 'online'))));
    renderAgentBusy(peer);
    // keep the elapsed readout matched to the DISPLAYED stream — switching to a busy stream picks up its
    // live count, switching to an idle one clears it. (send() also starts it the instant a run begins.)
    if (isBusy()) ensureElapsedTimer(); else stopElapsedTimer();
    updateControls();   // Stop button visibility + queued pills follow the displayed stream too
  }
  function clearEmptyState() { const e = log && log.querySelector('.cmsg-empty'); if (e) e.remove(); }
  // first-run state: an empty + idle + non-interview stream shows a single dim hint instead of a black void.
  // gather the HONEST signals the starter engine ranks on: catalog, real launch history, whether the
  // station has any prior life, and the local clock. Every read fails open — a missing store just means
  // fewer signals, never a crash (the engine degrades to the classic orientation set).
  function pickStarters() {
    const recipes = (typeof Recipes !== 'undefined' && Recipes.list) ? (Recipes.list() || []) : [];
    let recent = [], valuesOf = () => null;
    if (typeof LaunchMemory !== 'undefined' && LaunchMemory.recent) {
      try { recent = LaunchMemory.recent(8) || []; valuesOf = id => LaunchMemory.get(id); } catch (_) {}
    }
    // returning = any OTHER session ever had a real row, or anything was ever launched from the catalog.
    // (maybeEmptyState only renders when the ACTIVE session is empty, so it can't vouch for itself.)
    let returning = recent.length > 0;
    try {
      if (!returning && typeof Workstreams !== 'undefined' && Workstreams.list) {
        returning = (Workstreams.list() || []).some(w => w && w !== activeWs && w.history && w.history.length > 0);
      }
    } catch (_) {}
    const now = new Date();
    const sig = { recipes, recent, valuesOf, returning, hour: now.getHours(), day: Math.floor(now.getTime() / 86400000) };
    if (typeof Starters !== 'undefined' && Starters.pick) {
      try { const out = Starters.pick(sig); if (out && out.length) return out; } catch (_) {}
    }
    // engine missing/hiccuped → the classic orientation set, verbatim.
    const fallback = [{ label: 'what can you do here', send: 'What can you do here? Give me a short tour of what you can actually do for me.' }];
    if (recipes[0]) fallback.push({ label: String(recipes[0].name || recipes[0].id), recipe: recipes[0] });
    fallback.push({ label: 'brief me on this station', send: 'Brief me on this station — what is around me and what I can do from here.' });
    return fallback;
  }

  function maybeEmptyState() {
    if (!log || interview) return;
    if (activeWs && activeWs.history && activeWs.history.length) return;
    if (busyPeerFor(activeWs)) return;   // never pair BUSY IN … with the contradictory "COMMS online" empty hint
    if (isBusy() || log.querySelector('.cmsg')) return;
    const s = (typeof Channels !== 'undefined' && activeWs) ? Channels.snapshot(activeWs.id) : null;
    if (s && ((s.toolEvents && s.toolEvents.length) || s.tools.length || s.acc || s.pending)) return;
    const d = document.createElement('div'); d.className = 'cmsg-empty';
    const line = document.createElement('div'); line.className = 'cmsg-empty-line';
    line.textContent = 'COMMS online. Type a task or a question to ' + name + '.';
    d.appendChild(line);
    // STARTER CHIPS — tappable openers so the first prompt isn't a blank void. Sandbox tone,
    // eerie-not-cute, no exclamation marks. A chip fills the composer and sends; a recipe fills its directive
    // (blanks left for the Commander to complete) instead of firing blind. Children of .cmsg-empty, so any real
    // row (clearEmptyState) retires them with the hint.
    // WHICH chips is the Starters engine's call (starters.js): fresh station → the orientation set;
    // returning Commander → their usual recipe (prefilled from LaunchMemory), a discovery pick, a pitch ask.
    const starters = pickStarters();
    const chips = document.createElement('div'); chips.className = 'cmsg-empty-chips';
    for (const st of starters.slice(0, 3)) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'choice cmsg-starter'; b.textContent = st.label;
      b.addEventListener('click', () => {
        if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
        if (st.recipe) { insertRecipe(st.recipe, st.values); return; }   // fill the directive to edit, don't auto-fire
        if (input) { input.value = st.send; autoGrowInput(); }
        submitComposer();
      });
      chips.appendChild(b);
    }
    d.appendChild(chips);
    log.appendChild(d);
  }

  // opts.live === true marks the streaming reply row, which always pins to the BOTTOM. Every other row (tool
  // ▶/◀ lines, deliverables, consent, turn-in) inserts ABOVE the pinned reply while one is live — so the work
  // log stacks above and the message the agent is actually saying stays at the bottom, never scrolled away.
  let renderingHistory = false;   // true only during renderHistory: mark rows .no-anim so a full replay doesn't fire up to 120 entrance animations at once
  function row(role, opts) {
    clearEmptyState();   // any real row supersedes the first-run hint
    const d = document.createElement('div'); d.className = 'cmsg ' + role + (renderingHistory ? ' no-anim' : '');
    // COMMS-PREMIUM: the speaker chip + a dim HH:MM stamp share one header row (a flex .cmsg-head).
    const who = document.createElement('span'); who.className = 'who';
    who.textContent = role === 'user' ? 'COMMANDER' : role === 'system' ? 'SYSTEM' : name;
    const body = document.createElement('span'); body.className = 'body';
    // TIMESTAMP TRUTH (P0): opts.stamp is `true` for a row created LIVE (real wall-clock now), a number/Date for a
    // stored turn's REAL recorded time, or falsy for a legacy turn that carries no time — in which case we render
    // NO stamp rather than fabricate the current clock (the module's own rule + truthful telemetry).
    const stampVal = opts && opts.stamp;
    if (stampVal) {
      const head = document.createElement('span'); head.className = 'cmsg-head';
      const ts = document.createElement('span'); ts.className = 'cmsg-ts';
      ts.textContent = fmtClock(stampVal === true ? null : new Date(stampVal));
      head.appendChild(who); head.appendChild(ts);
      d.appendChild(head); d.appendChild(body);
    } else {
      d.appendChild(who); d.appendChild(body);
    }
    // COPY: a hover-revealed copy button on MESSAGE rows (agent + Commander). CSS hides it on the work-log beats
    // (tool / consent / turn-in / nudge / deliverable) — those aren't prose to copy. One delegated handler
    // in init() reads the row's .body text, so a streamed reply gains the button the moment its row exists.
    if (role === 'agent' || role === 'user') {
      const cp = document.createElement('button'); cp.className = 'cmsg-copy'; cp.type = 'button';
      cp.title = 'copy message'; cp.setAttribute('aria-label', 'Copy message'); cp.textContent = '⧉';
      d.appendChild(cp);
    }
    log.appendChild(d);   // CHRONOLOGICAL: every row lands at the bottom, in the order it happened (classic chat)
    autoscroll();
    return { d, body };
  }
  // stamp: omitted → live now (real); a number/Date → the turn's stored real time; false → no stamp (replay of a
  // legacy turn that carries no time — never fabricate the current clock).
  function addUser(t, atts, stamp) {
    const r = row('user', { stamp: stamp === undefined ? true : stamp });
    if (t) r.body.textContent = t;
    if (atts && atts.length) renderUserAttachments(r.d, atts);   // ATTACHMENTS: thumbnails/file-chips under the message text
    autoscroll();
  }
  // render a SENT user turn's attachments: images as clickable thumbnails, other files as openable chips — both
  // served by the sidecar's jailed /api/file route (so they survive a reload, exactly like agent deliverables).
  function renderUserAttachments(rowEl, atts) {
    const aid = attachAgentId();
    const view = document.createElement('div'); view.className = 'chat-attach-view';
    for (const att of atts) {
      const a = att || {};
      const name = String(a.name || 'file');
      const rel = String(a.path || '');
      if (!rel) continue;
      if (a.kind === 'image') {
        const link = document.createElement('a'); link.className = 'thumb'; link.title = name;
        wireLightbox(link, rel, aid, name);   // click enlarges in-app (Esc / click-out / × to leave)
        const img = document.createElement('img'); img.loading = 'lazy'; img.alt = name;
        link.appendChild(img); view.appendChild(link);
        // fetch->blob->objectURL (NOT a direct <img src=/api/file>): a native image GET sends no Origin header,
        // which the API-auth gate rejects — the fetch path carries same-origin auth. Mirrors imageDeliverableLine,
        // including revoking the object URL once the bitmap has decoded so a 24/7 station never leaks one per image.
        fileBlobUrl(rel, aid).then(u => {
          img.src = u;
          const free = () => { try { URL.revokeObjectURL(u); } catch (_) {} };
          img.addEventListener('load', free, { once: true });
          img.addEventListener('error', free, { once: true });
        }).catch(() => {});
      } else {
        const chip = document.createElement('a'); chip.className = 'filechip'; chip.title = name;
        wireBlobOpen(chip, rel, aid);
        chip.appendChild(glyphSpan(SVG_FILE));   // themed file glyph, not 📄
        chip.appendChild(document.createTextNode(' ' + (name.split(/[\\/]/).pop() || name)));
        view.appendChild(chip);
      }
    }
    if (view.childNodes.length) rowEl.appendChild(view);
  }
  // command / client-side output (/help, /whoami, version, unknown-command, …). A SYSTEM register — dim, no
  // speaker chip, never copyable — so the station's own words are never mistaken for the agent's speech.
  function localLine(t) { row('system').body.textContent = t; autoscroll(); }
  // the history-cap marker ("…N earlier turns trimmed …") as a dim, centered, hairline-flanked system line —
  // a scrollback boundary, not a dropped record. Reuses the broadcast register's chrome (theme tokens only).
  function trimMarkerLine(t) {
    if (!log) return;
    clearEmptyState();
    const d = document.createElement('div'); d.className = 'cmsg trim-marker'; d.setAttribute('role', 'separator');
    const line = document.createElement('span'); line.className = 'tm-line'; line.textContent = String(t || '').replace(/^…?\(?/, '').replace(/\)$/, '');
    d.appendChild(line); log.appendChild(d); autoscroll();
  }
  // a COLLAPSED SYSTEM CARD for verbose command output (/history, /help) — one dim header row that expands its
  // body of lines on click, so a 30-row dump doesn't flood the transcript. Header is a real <button> (keyboard-
  // operable, aria-expanded). `lines` are plain strings (textContent — never innerHTML, so no injection).
  function systemCard(title, lines, opts) {
    if (!log) return;
    clearEmptyState();
    opts = opts || {};
    const d = document.createElement('div'); d.className = 'cmsg system syscard';
    const head = document.createElement('button'); head.type = 'button'; head.className = 'syscard-head';
    const open0 = !!opts.open;
    head.setAttribute('aria-expanded', open0 ? 'true' : 'false');
    const chev = document.createElement('span'); chev.className = 'syscard-chev'; chev.setAttribute('aria-hidden', 'true'); chev.textContent = '▸';
    const ttl = document.createElement('span'); ttl.className = 'syscard-title'; ttl.textContent = title;
    head.appendChild(chev); head.appendChild(ttl);
    const bodyWrap = document.createElement('div'); bodyWrap.className = 'syscard-body'; bodyWrap.hidden = !open0;
    for (const ln of (lines || [])) { const r = document.createElement('div'); r.className = 'syscard-row'; r.textContent = String(ln); bodyWrap.appendChild(r); }
    head.addEventListener('click', () => {
      const open = bodyWrap.hidden; bodyWrap.hidden = !open;
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      d.classList.toggle('open', open);
      if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
    });
    if (open0) d.classList.add('open');
    d.appendChild(head); d.appendChild(bodyWrap);
    log.appendChild(d); autoscroll();
  }

  /* ---------- CELEBRATION broadcast: a terse station system line (level-up / quest / trophy) ----------
     NOT a beat-slot card: it never touches activeNudge/the post-run precedence chain (turn-in→suggestion→
     seed→curiosity), so it can never compete with or suppress a real ask. It's an ambient system line —
     dim, letter-spaced, centered, hairline rules either side — appended to the transcript exactly where it
     happened (so it slots UNDER a live presence card, never over it). The eerie register: a terse broadcast,
     never a party. `tint` (an agent suit colour) is the ONE established colour exception, applied to a
     highlighted span only. RESTRAINT enforced here: fires only in-game (never on the create/onboarding
     screens), and rate-limits — two broadcasts inside ~3s never stack. But a broadcast caught inside the
     window is QUEUED (small bounded FIFO), not dropped, and drained in order once the window elapses: a
     quest COMMS line sharing this path with a level-up/trophy must never be silently lost. */
  const BROADCAST_COALESCE_MS = 3000;
  const BROADCAST_QUEUE_CAP = 8;   // bounded FIFO: a celebration flood drops the OLDEST queued line, never grows unbounded
  let lastBroadcastAt = 0;
  const broadcastQueue = [];       // {text, opts} coalesced inside the window — drained in order, one per window slot
  let broadcastDrainTimer = null;
  function broadcastBlocked() {
    // never during the create/onboarding/interview flows — a celebration must land only on the live station
    const game = el('screen-game');
    if (!game || !game.classList.contains('active')) return true;
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return true;
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return true;
    return false;
  }
  // drain ONE queued broadcast (oldest first) then reschedule until the queue empties — each drained line still
  // respects the one-per-window rate limit, so a burst plays out as an ordered trickle instead of stacking. A
  // queued line that turned invalid mid-wait (Commander left the station) is dropped, but the rest keep draining.
  function drainBroadcasts() {
    broadcastDrainTimer = null;
    if (!broadcastQueue.length) return;
    const item = broadcastQueue.shift();
    if (!broadcastBlocked()) renderBroadcast(item.text, item.opts);
    if (broadcastQueue.length) broadcastDrainTimer = setTimeout(drainBroadcasts, BROADCAST_COALESCE_MS);
  }
  // text: the terse line WITHOUT the leading ▸ (added here). opts.highlight: the substring to tint (the agent
  // name); opts.tint: the suit colour for that span; opts.tone: 'gold' brightens the whole line (trophies).
  function broadcast(text, opts) {
    if (!log) return false;
    opts = opts || {};
    if (broadcastBlocked()) return false;   // blocked (onboarding/interview/offscreen) → dropped, never queued
    const now = Date.now();
    // inside the rate-limit window, OR a drain is already in flight: QUEUE (preserving order) rather than drop.
    // Bounded — at the cap the oldest queued line is discarded so the queue can never grow without limit.
    if (broadcastDrainTimer || now - lastBroadcastAt < BROADCAST_COALESCE_MS) {
      broadcastQueue.push({ text, opts });
      while (broadcastQueue.length > BROADCAST_QUEUE_CAP) broadcastQueue.shift();
      if (!broadcastDrainTimer) broadcastDrainTimer = setTimeout(drainBroadcasts, Math.max(0, BROADCAST_COALESCE_MS - (now - lastBroadcastAt)));
      return true;
    }
    return renderBroadcast(text, opts);
  }
  // the actual render: append the terse system line + stamp the rate-limit clock. Shared by the live path and
  // the queue drainer (ONE renderer). Returns false only when there's no log node to append to.
  function renderBroadcast(text, opts) {
    if (!log) return false;
    opts = opts || {};
    lastBroadcastAt = Date.now();
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
    // ASCII-motion (asciifx.js): the station line DECODES out of glyph-static — the eerie register the
    // broadcast asks for (a signal resolving, never a party). scramble walks leaf text nodes only, so the
    // tinted agent-name span keeps its colour; it restores the exact text on completion; reduced-motion no-op.
    try { if (typeof AsciiFX !== 'undefined') AsciiFX.scramble(line, { duration: 700 }); } catch (_) {}
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
    // aria-expanded lives on the .tc-head BUTTON (the operable control), not the wrapper div — AT reads the
    // disclosure state from the thing it can activate.
    const btn = chip.querySelector('.tc-head'); if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  // render a tool CALL as a chip; returns the chip element. ev: { callId, name, argsSummary }
  function toolChip(ev) {
    const rail = ensureToolRail();
    const flav = skillFlavor(ev);   // A1: skill.* tools re-labelled in the agent's voice
    const chip = document.createElement('div'); chip.className = 'tool-chip pending' + (flav ? ' skill' : '');
    const head = document.createElement('button'); head.type = 'button'; head.className = 'tc-head';
    head.setAttribute('aria-expanded', 'false');   // the head IS the disclosure control (detail = its region)
    const glyph = document.createElement('span'); glyph.className = 'tc-glyph'; glyph.textContent = flav ? flav.glyph : '▸';
    const nm = document.createElement('span'); nm.className = 'tc-name'; nm.textContent = flav ? flav.label : shortName(ev.name);
    // for a flavored skill chip the human phrase already carries the skill name, so the raw args stay in the
    // expand detail only (kept below) — the chip head is clean.
    const args = document.createElement('span'); args.className = 'tc-args'; args.textContent = (!flav && ev.argsSummary) ? brief(ev.argsSummary) : '';
    const stat = document.createElement('span'); stat.className = 'tc-stat'; stat.textContent = '';   // filled by resolveChip
    const exp = document.createElement('span'); exp.className = 'tc-exp'; exp.setAttribute('aria-hidden', 'true'); exp.textContent = '▸';   // disclosure chevron (rotates when open)
    head.appendChild(glyph); head.appendChild(nm); if (args.textContent) head.appendChild(args); head.appendChild(stat); head.appendChild(exp);
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
      fileBlobUrl(title, agentId).then(u => {
        try { window.open(u, '_blank', 'noopener'); } catch (_) {}
        // the new tab has taken the blob by now — revoke so a 24/7 station doesn't leak one object URL per
        // deliverable opened (matches backup.js/clip.js delayed-revoke; every other createObjectURL site frees).
        setTimeout(() => { try { URL.revokeObjectURL(u); } catch (_) {} }, 60000);
      })
        .catch(() => { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('could not open that file — the sidecar may be unreachable', 'warn'); });
    });
  }

  /* ── IMAGE LIGHTBOX ─ clicking any COMMS image (sent attachment, staged composer attachment, agent image
     deliverable) enlarges it IN-APP over everything else; click the backdrop, the ×, or Esc to leave. One
     instance at a time. Esc is caught on document CAPTURE with stopPropagation so it dismisses the lightbox
     only — it must never fall through to the window-level Esc handler and close COMMS underneath the viewer. */
  let lightbox = null;   // { root, onKey, revokeUrl } while open
  function closeLightbox() {
    if (!lightbox) return;
    const lb = lightbox; lightbox = null;
    document.removeEventListener('keydown', lb.onKey, true);
    // blob URLs fetched FOR the lightbox are freed with it (the decoded thumbnail elsewhere keeps its own)
    if (lb.revokeUrl) { try { URL.revokeObjectURL(lb.revokeUrl); } catch (_) {} }
    lb.root.remove();
    if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
  }
  // `load` -> Promise<objectURL>; opts.revoke says the URL is ours to free on close (false for a staged
  // attachment's localUrl, which renderAttachStrip still owns and revokes on remove/clear).
  function openLightbox(load, name, opts) {
    closeLightbox();
    const root = document.createElement('div'); root.className = 'comms-lightbox';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Enlarged image: ' + name);
    const fig = document.createElement('figure'); fig.className = 'lb-frame loading';
    const img = document.createElement('img'); img.alt = name; img.decoding = 'async';
    const cap = document.createElement('figcaption'); cap.className = 'lb-name'; cap.textContent = name; cap.title = name;
    fig.appendChild(img); fig.appendChild(cap);
    const x = document.createElement('button'); x.type = 'button'; x.className = 'lb-close';
    x.textContent = '×'; x.title = 'close'; x.setAttribute('aria-label', 'Close enlarged image');
    root.appendChild(fig); root.appendChild(x);
    // click-OUT closes; clicks on the image/caption/frame do not (so a viewer can't lose it by mis-clicking)
    root.addEventListener('click', ev => { if (ev.target === root) closeLightbox(); });
    x.onclick = closeLightbox;
    const onKey = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeLightbox(); } };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    x.focus();
    lightbox = { root, onKey, revokeUrl: '' };
    const mine = lightbox;
    if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
    Promise.resolve().then(load).then(u => {
      if (lightbox !== mine) {   // closed (or replaced) before the bytes arrived — free a URL we now own
        if (opts && opts.revoke) { try { URL.revokeObjectURL(u); } catch (_) {} }
        return;
      }
      if (opts && opts.revoke) mine.revokeUrl = u;
      img.addEventListener('load', () => fig.classList.remove('loading'), { once: true });
      img.addEventListener('error', () => { if (lightbox === mine) closeLightbox(); }, { once: true });
      img.src = u;
    }).catch(() => {
      if (lightbox === mine) closeLightbox();
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('could not load that image — the sidecar may be unreachable', 'warn');
    });
  }
  // wire an image thumb in the transcript: click enlarges via the jailed /api/file route (fresh blob each
  // view — the thumbnail's own object URL was already revoked after its bitmap decoded).
  function wireLightbox(a, rel, aid, name) {
    a.href = '#';
    a.addEventListener('click', ev => { ev.preventDefault(); openLightbox(() => fileBlobUrl(rel, aid), name, { revoke: true }); });
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
  // Build a small folder control (a themed folder glyph + a label). `relPath` (optional) is the deliverable's
  // own path so a future native reveal can select the file; today it reveals/copies the containing workspace dir.
  function folderButton(agentId, relPath) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'deliverable-folder';
    b.appendChild(glyphSpan(SVG_FOLDER));
    const lbl = document.createElement('span'); lbl.className = 'fb-label'; lbl.textContent = 'folder'; b.appendChild(lbl);
    const desktop = !!tauriCore();
    b.title = desktop ? 'reveal this deliverable’s folder on disk' : 'copy the folder path on disk';
    let dirP = null;
    b.addEventListener('click', () => {
      if (!dirP) dirP = workspaceDir(agentId);
      dirP.then(dir => {
        if (!dir) { lbl.textContent = 'no path'; setTimeout(() => { lbl.textContent = 'folder'; }, 1400); return; }
        const core = tauriCore();
        if (core && core.invoke) {
          // native reveal IF the shell exposes it; otherwise fall through to copy (never a silent no-op)
          Promise.resolve(core.invoke('starnet_reveal_path', { path: dir })).then(() => {
            lbl.textContent = 'opened'; setTimeout(() => { lbl.textContent = 'folder'; }, 1400);
          }).catch(() => copyPathFeedback(b, dir));
        } else {
          copyPathFeedback(b, dir);
        }
      });
    });
    return b;
  }
  function copyPathFeedback(btn, dir) {
    const lbl = btn.querySelector('.fb-label');
    copyText(dir).then(ok => {
      if (lbl) lbl.textContent = ok ? 'path copied' : dir;
      setTimeout(() => { if (lbl) lbl.textContent = 'folder'; }, 1600);
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
    const shortName = String(title).split(/[\\/]/).pop() || title;
    wireLightbox(a, title, agentId, shortName);   // click enlarges in-app (Esc / click-out / × to leave)
    a.className = 'deliverable-thumb';
    a.title = title;                                               // full path on hover
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = shortName;
    a.appendChild(img);
    r.body.appendChild(a);
    fileBlobUrl(title, agentId).then(u => {
      img.src = u;
      // once the <img> has decoded (or failed) it no longer needs the object URL — the decoded bitmap
      // survives revocation, so the thumbnail keeps rendering. Revoke to avoid leaking one URL per image
      // deliverable on a long-running station (mirrors voice.js freeing its audio blob after use).
      const free = () => { try { URL.revokeObjectURL(u); } catch (_) {} };
      img.addEventListener('load', free, { once: true });
      img.addEventListener('error', free, { once: true });
    }).catch(() => {});
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
    // a <video>/<audio> keeps needing its object URL for the WHOLE row lifetime (seek/replay re-read it, and
    // the error fallback links to it), so we don't revoke on load here. But free any prior URL before we
    // replace it (defensive against a double-resolve leaking the first one) — the general revoke-before-
    // replace discipline every other createObjectURL site follows.
    fileBlobUrl(title, agentId).then(u => {
      if (blobUrl && blobUrl !== u) { try { URL.revokeObjectURL(blobUrl); } catch (_) {} }
      blobUrl = u; el.src = u;
    }).catch(() => openFallback(r.body, 'open ' + kind, '', title, agentId));
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
      // POST-RUN DEDUPE: this recap card IS the run's ledger — its foot carries cost · duration · model and its
      // rows carry the artifacts. So the resolved presence line above it should stop repeating those numbers:
      // collapse it to just its terse status label (■ RUN COMPLETE), letting the recap own the metrics.
      foldPresenceIntoRecap();
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
    // NS-5 conversational path trust: a file was referenced OUTSIDE the agent's workspace — "Always" blesses
    // the whole project folder for future reads (revocable in Permissions); argsSummary is the proposed root.
    if (t === 'path.trust') return 'work with files in ' + (ev.argsSummary || 'a project folder') + ' (reads; "Always" trusts it for later)';
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
      // NS conversational anchor: "Always" on a path.trust card IS the project bless (a standing path grant +
      // known-projects row land on the sidecar). Stamp the origin session's projectRoot with the SAME proposed
      // root so the PROJECTS rail lists this session under its project — the identical anchor "Work here" stamps.
      // Only "Always" (once/full grant nothing standing, so there is no project row to attach to), and never
      // overwrite an anchor the session already has.
      if (p.tool === 'path.trust' && decision === 'always' && ws && typeof Workstreams !== 'undefined' && Workstreams.setProjectRoot) {
        try { if (p.argsSummary && !(Workstreams.get(ws.id) || {}).projectRoot) Workstreams.setProjectRoot(ws.id, p.argsSummary); } catch (_) {}
      }
      if (ws && typeof Channels !== 'undefined') Channels.clearPending(ws.id, Date.now());   // closes the paused span — approval wait never counts as run time
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
    mk('Approve once', 'once', '', '✓ approved once', false);
    mk('Always', 'always', '', '✓ always allowed', false);
    mk('Full access', 'full', 'danger', '✓ full access', false);
    mk('Deny', 'deny', 'deny', '✕ denied', true);
    r.body.appendChild(btns);
    // a blocking, run-pausing prompt: make it keyboard-operable. Esc on the focused CONTAINER = Deny (the row,
    // not a button — so a reflexive Enter never lands on Approve and greenlights a write the user didn't read).
    r.d.tabIndex = -1;
    r.d.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); decide('deny', '✕ denied', true); } });
    status('awaiting your approval…');
    if (typeof StationUI !== 'undefined') StationUI.notify(name + ' needs approval to ' + actionPhrase(p), 'warn', 'needsApproval');   // P1-8 category: consent prompt
    // FOCUS-STEAL GUARD (P0): a consent prompt must NEVER hijack focus from a Commander who is mid-typing or holds
    // a draft — a stolen focus + a reflexive Enter could approve a file write they never read. Only follow the
    // scroll when they were already at the bottom (honor stick), and only take focus (onto the row CONTAINER, so
    // Esc=deny works but Enter can't approve) when the composer is idle. Esc still denies either way: an idle
    // composer gets the row's Esc handler; a busy composer's own Esc handler stops the paused run (also a deny).
    autoscroll();   // honors stick — never yanks a reader who scrolled up
    const composerBusy = !!(input && (document.activeElement === input || (input.value && input.value.trim())));
    if (!composerBusy) { try { r.d.focus({ preventScroll: true }); } catch (_) { try { r.d.focus(); } catch (_) {} } }
  }

  // EL-11 FIX 1a: a consent prompt on a NON-displayed session used to be invisible — permissionRow (and its
  // notify) render for the active stream only, so a background prompt's run silently auto-denied on the sidecar's
  // consent timeout. A deny nobody saw is a consent violation. This is the GLOBAL surface: the moment a background
  // session gains a pending consent, fire a clickable toast naming the AGENT + the action; clicking it opens THAT
  // session via the same restore path as a rail-row click (Chat.load re-renders the consent card from the Channels
  // snapshot). Also refresh the rail immediately so the row's NEEDS-YOU marker lands without waiting for the ticker.
  function backgroundPermissionNotify(ev, ws) {
    const who = (typeof App !== 'undefined' && App.agentName && App.agentName(ws.agentId || 'agent')) || ws.agentId || 'an agent';
    if (typeof StationUI !== 'undefined' && StationUI.notify) {
      StationUI.notify(who + ' needs approval to ' + actionPhrase(ev) + ' — click here to answer', 'warn', 'needsApproval',
        { onClick: () => { try { if (typeof App !== 'undefined' && App.openWorkstream) App.openWorkstream(ws.id); } catch (_) {} } });
    }
    try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
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
    // OUTCOME LOOP (recipe lane B): if THIS run was launched from a recipe (RUN_META provenance spine), fold the
    // verdict onto that recipe's own counters — what actually HELPED ranks the FOR-YOU shelf, not just what was
    // clicked. Missing meta (ledger evicted / page reloaded) → no rating recorded, never guessed. Fail-open.
    try { const rmp = runMeta(runId); if (rmp && rmp.recipeId && typeof ProspectStore !== 'undefined' && ProspectStore.noteRated) ProspectStore.noteRated(rmp.recipeId, verdict); } catch (_) {}
  }
  // render the rate-the-work control into `host` (a span/div). onSettle fires after the verdict flashes.
  const WORKRATE_COACH_KEY = 'starnet.workrate.seen';
  function workRateControl(host, agentId, runId, onSettle) {
    // one-time explainer: the FIRST rate surface a Commander ever sees gets one honest line about what a
    // verdict does (👍 mints size-weighted XP + raises satisfaction/trust; 👌/👎 only move the satisfaction
    // meter, never XP, never a penalty — see xp.js scoreEvent/verdictQuality). Retired permanently after one
    // render via the house one-shot pattern (cf. navcoach.seen / modeldock.seen). Fail-open — a storage
    // block just shows the line again next time, never breaks the control.
    let coached = false;
    try { coached = localStorage.getItem(WORKRATE_COACH_KEY) === '1'; } catch (_) {}
    if (!coached) {
      const hint = document.createElement('span'); hint.className = 'work-rate-hint';
      hint.textContent = 'rating trains your agent — the top mark earns XP and builds trust';
      host.appendChild(hint);
      try { localStorage.setItem(WORKRATE_COACH_KEY, '1'); } catch (_) {}
    }
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
    // CRT glyphs, not color emoji: ▲ nailed it · ◆ close · ▼ missed (semantics preserved, phosphor-themed)
    mk('▲ nailed it', '', 'great', '★ +XP', false);
    mk('◆ close', '', 'ok', 'noted', false);
    mk('▼ missed', 'deny', 'miss', 'noted', true);
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
        // Marker parsing happens as the stream closes, before this delayed post-run beat. A question turn did
        // not ship work and must not bank curiosity credit, earn a rating, or trigger another proactive ask.
        if (runId && clarificationRuns.has(runId)) { clarificationRuns.delete(runId); return; }
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
  // the "↗ read the work" affordance (2026-07-16 UX fix): every review surface must let the Commander SEE
  // the run's actual output before rating it — the old beat showed only the raw prompt title and a rate
  // control, which read as a context-free popup ("what is this? where's the work?"). opts.openWork(rw)
  // (ReturnStore.openWork) opens the run's transcript session in COMMS; an unreachable transcript says so
  // honestly in place — never a dead click.
  function openWorkBtn(host, rw, openWork) {
    if (!openWork) return;
    const b = document.createElement('button'); b.className = 'consent-btn'; b.textContent = '↗ read the work';
    b.onclick = () => {
      b.disabled = true; b.textContent = 'opening…';
      Promise.resolve().then(() => openWork(rw)).then(ok => {
        if (ok) { b.disabled = false; b.textContent = '↗ read the work'; return; }   // reusable — the beat stays for rating
        const note = document.createElement('span'); note.className = 'consent-result err'; note.textContent = 'transcript unreachable';
        b.replaceWith(note);
      }).catch(() => { b.disabled = false; b.textContent = '↗ read the work'; });
    };
    host.appendChild(b);
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
    title.textContent = '◈ while you were away — ' + rows.length + (rows.length > 1 ? ' runs' : ' run') + ' finished. read each one, then rate it:';
    r.body.appendChild(title);
    let open = rows.length;
    const settleRow = (item) => { vanish(item); if (--open <= 0) vanish(r.d); };
    for (const rw of rows) {
      const item = document.createElement('div'); item.className = 'turnin-item';
      const text = document.createElement('span'); text.className = 'turnin-text'; text.textContent = awayRowLabel(rw);
      const btns = document.createElement('span'); btns.className = 'consent-btns';
      item.appendChild(text); item.appendChild(btns);
      openWorkBtn(btns, rw, opts && opts.openWork);   // SEE the output first — rating blind was the confusion
      const b = document.createElement('button'); b.className = 'consent-btn'; b.textContent = 'rate it';
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
    // the ONE door that always works, prop or no prop on the floor: open the OUTBOX window — every listed
    // run readable + rateable in one place (2026-07-16; a floor with no OUTBOX placed had no other path).
    if (typeof StationUI !== 'undefined' && StationUI.openTerm) {
      const ob = document.createElement('button'); ob.className = 'consent-btn'; ob.textContent = '▸ open the OUTBOX';
      ob.onclick = () => StationUI.openTerm('outbox');
      foot.appendChild(ob);
    }
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
  // awayRate(host, rw, onSettle) — mount the real rate-the-work control for an away run into any DOM host
  // (the OUTBOX window uses this). Same XP-law path as every attended run (seedAwayWork → workRateControl →
  // rateWork). Returns false when the run was already judged this session (the caller just collects the crate).
  function awayRate(host, rw, onSettle) {
    if (!host || !rw || !rw.runId) return false;
    if (workRatedRuns.has(rw.runId)) return false;   // already judged — nothing to mount, crate is collectable
    seedAwayWork(rw);
    workRateControl(host, rw.agentId || 'agent', rw.runId, onSettle);
    return true;
  }
  // the OUTBOX collect beat: clicking the chute (or a stacked crate) reviews ONE pending away run.
  // Same gold-inset family; rating clears the crate (onRated) and the beat vanishes.
  // Reshaped 2026-07-16: the beat now SAYS what it is (a run that finished while you were away), offers
  // "↗ read the work" (open the run's transcript session) BEFORE asking for a verdict, and has a "later"
  // out that keeps the crate on the chute — the old shape was a bare prompt-title + rate control, which
  // read as a context-free popup with no way to see the work it asked you to judge.
  function awayReview(rw, opts) {
    if (!log || !rw || !rw.runId) return;
    const onRated = (opts && opts.onRated) || (() => {});
    if (workRatedRuns.has(rw.runId)) { try { onRated(rw.runId); } catch (_) {} return; }   // already judged — just clear the crate
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('work-rate');
    const title = document.createElement('span'); title.className = 'turnin-title';
    title.textContent = '◈ OUTBOX crate — this run finished while you were away:';
    r.body.appendChild(title);
    const item = document.createElement('div'); item.className = 'turnin-item';
    const text = document.createElement('span'); text.className = 'turnin-text'; text.textContent = awayRowLabel(rw);
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    item.appendChild(text); item.appendChild(btns);
    openWorkBtn(btns, rw, opts && opts.openWork);
    const later = document.createElement('button'); later.className = 'consent-btn deny'; later.textContent = 'later';
    later.onclick = () => vanish(r.d);   // the crate STAYS on the chute — deferring never loses the work
    btns.appendChild(later);
    r.body.appendChild(item);
    const rate = document.createElement('div'); rate.className = 'turnin-rate';
    r.body.appendChild(rate);
    seedAwayWork(rw);
    workRateControl(rate, rw.agentId || 'agent', rw.runId, () => { try { onRated(rw.runId); } catch (_) {} vanish(r.d); });
    autoscroll();
  }

  /* W3 — THE DELIVERY CARD (reshaped 2026-07-15). WorkshopStore adopts one SESSION per idle-work
     deliverable ('workshop-<runId>', unread in the rail) and calls this ONLY when the Commander opens that
     session — opts.sessionId pins the card to it, so a delivery can never paint into an unrelated stream.
     Simple by design: the headline, the honest verification line, WHAT it did, a link that RUNS it (when a
     web entry exists), the files, and ONE action row — an optional message to the agent plus three one-click
     decisions: Implement (decide keep — the sidecar applies a patch deliverable to a new branch, or lands
     files in the default deliverables folder), Later (dismiss; the session stays), Discard (single confirm →
     wipe + denylist). A typed message rides the decision as a REAL user turn in this same session — the
     session id IS the shift's durable streamId, so the agent replies with the build's actual transcript
     behind it. Decided cards vanish(); the outcome persists as a sys marker (opts.noteDecision).
     TRUTHFUL TELEMETRY: the verification line renders "tested — N passed" ONLY from a real manifest.verified
     block; absent → honest not-tested copy. The card never asserts status the manifest doesn't prove.
     opts: { sessionId, onDecide(decision, destPath?, extra?) -> Promise<{ok,destPath?,applied?,branch?,root?,error?}>,
             readFile(agentId,runId,path) -> Promise<string>, runUrl(relPath), openFile(relPath),
             noteDecision(text) }. */
  function workshopReturn(m, opts, _try) {
    if (!log || !m || !m.runId) return;
    opts = opts || {};
    const onDecide = opts.onDecide || (() => Promise.resolve({ ok: true }));
    // SESSION PIN: render only while the card's OWN delivery session is on screen. Switched away → just
    // stop (no retry) — chat.js load() re-fires WorkshopStore.presentFor when the Commander comes back.
    const inOwnSession = () => !opts.sessionId || !!(activeWs && activeWs.id === opts.sessionId);
    if (!inOwnSession()) return;
    const blocked = isBusy() || interview || activeTurnin || activeNudge
      || (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning())
      || (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning())
      || (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen());
    if (blocked) {   // defer — DELAY but never STARVE (same law as awayDigest): fast retry, then slow; the session pin above retires a stale retry chain.
      const t = (_try || 0);
      setTimeout(() => workshopReturn(m, opts, t + 1), t < 25 ? 7000 : 60000);
      return;
    }
    // ONE LIVE CARD PER DELIVERABLE (2026-07-14): an undecided card may be RE-offered (return-from-away,
    // next-session attach) until decided — drop the stale instance first so the feed never holds two live
    // cards for the same runId (deciding one would strand a dead twin whose decide can only fail).
    try { const stale = log.querySelector('.workshop-return[data-wsrun="' + String(m.runId).replace(/["\\]/g, '') + '"]'); if (stale) stale.remove(); } catch (_) {}
    const agentId = m.agentId || 'agent';
    const who = (agentId === 'agent') ? name : agentId;
    // W7 — the Commander receives a TOOL, not a repo. If the deliverable has a web entry point (index.html
    // preferred, else the first .html), the PRIMARY action becomes "Open it": it opens the RUNNING tool in a
    // browser tab from the jailed /workshop-run/ static route. No html → no runnable entry, so Keep stays primary.
    const files = Array.isArray(m.files) ? m.files.filter(f => f && f.path) : [];
    const htmlFiles = files.filter(f => /\.html?$/i.test(f.path));
    const htmlEntry = htmlFiles.length
      ? ((htmlFiles.find(f => /(^|\/)index\.html?$/i.test(f.path)) || htmlFiles[0]).path)
      : '';
    const openRunTab = (relPath) => {
      const url = opts.runUrl ? opts.runUrl(relPath) : '';
      const warn = (msg) => { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(msg, 'warn'); };
      if (!url) { warn('could not open that — the station may be unreachable'); return; }
      // Desktop (Tauri): a raw window.open silently fails under the window policy — hand the absolute
      // sidecar URL to the OS default browser and report a real failure if it doesn't open (same law as
      // stationui.js openSignIn: never pretend a tab exists). Browser: window.open, where null = popup-blocked.
      const invoke = (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core.invoke : null;
      if (invoke) {
        invoke('open_external_url', { url }).catch(() => warn('could not open your browser — open this in one yourself: ' + url));
        return;
      }
      let win = null;
      try { win = window.open(url, '_blank', 'noopener'); } catch (_) {}
      if (!win) warn('your browser blocked the new tab — allow popups for the station, then try again');
    };
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('workshop-return');
    try { r.d.setAttribute('data-wsrun', String(m.runId)); } catch (_) {}   // the re-present dedupe key (above)

    // ── headline (+ an honest kind chip straight off the validated manifest) ──
    const title = document.createElement('span'); title.className = 'turnin-title';
    title.textContent = '◈ while you were away — ' + who + ' built: ' + String(m.title || 'a deliverable');
    if (m.kind && m.kind !== 'other') {
      const chip = document.createElement('span'); chip.className = 'ws-kindchip'; chip.textContent = String(m.kind);
      title.appendChild(chip);
    }
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

    // labeled section rows — the premium dossier grammar (gold uppercase micro-label over a bright value),
    // same ws-k/ws-v vocabulary the old summary pane and the config cards speak.
    const mkSection = (label, value, cls) => {
      const d = document.createElement('div'); d.className = 'ws-line ' + cls;
      const kk = document.createElement('span'); kk.className = 'ws-k'; kk.textContent = label;
      const vv = document.createElement('span'); vv.className = 'ws-v'; vv.textContent = value;
      d.appendChild(kk); d.appendChild(vv); r.body.appendChild(d);
    };
    // ── WHAT it did — the one paragraph the agent wrote, plain ──
    if (m.summary) mkSection('what it did', String(m.summary), 'ws-what');
    // ── how to use — ONE short line. The workshop prompt now caps this to a sentence; a verbose legacy
    // manifest is clamped here rather than dumped as a wall of instructions (the old confusing card).
    if (m.howToUse) {
      const one = String(m.howToUse).replace(/\s+/g, ' ').trim();
      if (one) mkSection('how to use', one.length > 200 ? one.slice(0, 200) + '…' : one, 'ws-how');
    }
    // what a human still needs to check — honest, compact (never implied failure, never hidden).
    if (Array.isArray(m.notVerified) && m.notVerified.length) mkSection('check yourself', m.notVerified.join('; '), 'ws-notver');
    // per-command verification detail: the ACTUAL commands run + each one's pass/fail from the manifest
    // (renders only when the manifest actually recorded them — never invents a command or a result).
    if (vcmds && vcmds.length) {
      const vd = document.createElement('div'); vd.className = 'ws-verdetail';
      vcmds.forEach(c => {
        const ok = Number(c.exit) === 0;
        const line = document.createElement('div'); line.className = 'ws-vcmd ' + (ok ? 'ok' : 'bad');
        const mark = document.createElement('span'); mark.className = 'ws-vmark'; mark.textContent = ok ? '✓' : '✕';
        const cmd = document.createElement('code'); cmd.className = 'ws-vcmdtext'; cmd.textContent = String(c.cmd);
        line.appendChild(mark); line.appendChild(cmd);
        if (!ok && c.exit != null) { const ex = document.createElement('span'); ex.className = 'ws-vexit'; ex.textContent = 'exit ' + c.exit; line.appendChild(ex); }
        vd.appendChild(line);
      });
      r.body.appendChild(vd);
    }

    // ── TRY IT — the link that RUNS the deliverable (jailed /workshop-run/ route), when a web entry exists ──
    if (htmlEntry) {
      // disk-proven by validateWorkshopManifest (never the model's claim): this deliverable requests pointer
      // lock / fullscreen, i.e. opening it will capture the Commander's REAL mouse. Say so BEFORE the click.
      if (m.capturesInput) {
        const warn = document.createElement('div'); warn.className = 'ws-line ws-capture-warn';
        warn.textContent = '⚠ captures your mouse/keyboard when opened (pointer lock) — press Esc to release it';
        r.body.appendChild(warn);
      }
      if (m.usesMedia) {
        const warn = document.createElement('div'); warn.className = 'ws-line ws-capture-warn';
        warn.textContent = '⚠ may ask to use your camera, microphone, or screen when opened';
        r.body.appendChild(warn);
      }
      const tryRow = document.createElement('div'); tryRow.className = 'turnin-rate ws-try';
      const openItBtn = document.createElement('button'); openItBtn.className = 'consent-btn ws-openit'; openItBtn.textContent = '▶ Open it — try it in a tab';
      openItBtn.title = m.capturesInput
        ? 'run this tool in a new browser tab — it will capture your mouse; Esc releases it'
        : 'run this tool in a new browser tab';
      openItBtn.onclick = () => openRunTab(htmlEntry);
      tryRow.appendChild(openItBtn);
      r.body.appendChild(tryRow);
    }

    // ── the files — every row's click ACTUALLY WORKS (2026-07-15 UX audit: the old "open in your default
    // app" affordance was a guaranteed dead end — OS-launch is deliberately impossible from a run). Now:
    //   .html and browser-renderable media → the jailed /workshop-run/ tab (runs/renders read-only);
    //   everything else → the inline reader, right here in the card. No promise the station can't keep.
    const TAB_RE = /\.(html?|png|jpe?g|gif|webp|svg|mp4|webm|mp3|wav|txt|csv|log|json)$/i;
    const fb = document.createElement('div'); fb.className = 'ws-pane ws-files';
    const fhead = document.createElement('div'); fhead.className = 'ws-fhead'; fhead.textContent = 'files' + (files.length ? ' · ' + files.length : '');
    fb.appendChild(fhead);
    const list = document.createElement('div'); list.className = 'ws-flist';
    const view = document.createElement('pre'); view.className = 'ws-fview'; view.hidden = true;   // hidden until a file is viewed inline
    if (!files.length) { const e = document.createElement('div'); e.className = 'dim'; e.textContent = '(no files listed)'; list.appendChild(e); }
    const viewInline = async (b, relPath) => {
      list.querySelectorAll('.ws-file.sel').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
      view.hidden = false; view.textContent = 'loading…';
      let content = '';
      try { content = opts.readFile ? await opts.readFile(agentId, m.runId, relPath) : ''; } catch (_) { content = ''; }
      view.textContent = content || '(no preview available)';
      autoscroll();
    };
    files.forEach(f => {
      if (!f || !f.path) return;
      const inTab = TAB_RE.test(f.path);
      const rowEl = document.createElement('div'); rowEl.className = 'ws-filerow';
      const b = document.createElement('button'); b.className = 'ws-file'; b.type = 'button';
      b.textContent = f.path + (f.bytes != null ? '  ·  ' + f.bytes + 'B' : '');
      b.title = inTab ? 'open this file in a new tab' : 'read this file here';
      b.onclick = () => { if (inTab) openRunTab(f.path); else viewInline(b, f.path); };
      rowEl.appendChild(b);
      if (inTab) {   // a tab-openable file keeps the inline reader as the opt-in secondary (read the code without leaving)
        const src = document.createElement('button'); src.className = 'ws-viewsrc'; src.type = 'button'; src.textContent = 'view source';
        src.title = 'show this file’s contents inline';
        src.onclick = () => viewInline(b, f.path);
        rowEl.appendChild(src);
      }
      list.appendChild(rowEl);
    });
    fb.appendChild(list); fb.appendChild(view);
    r.body.appendChild(fb);

    // ── WHAT IMPLEMENT WILL DO — the server-resolved plan (current blessed roots), stated BEFORE the click.
    // A patch that can't auto-apply is the loudest case: the old card let "files saved" read as an apply.
    const plan = (m.implementPlan && typeof m.implementPlan === 'object') ? m.implementPlan : null;
    if (plan && plan.action === 'apply') {
      const pl = document.createElement('div'); pl.className = 'ws-line ws-plan';
      pl.textContent = 'implement → applies this patch to a NEW branch in ' + plan.root + ' (your current branch is untouched)';
      r.body.appendChild(pl);
    } else if (plan && m.kind === 'patch') {
      const pl = document.createElement('div'); pl.className = 'ws-line ws-capture-warn';
      pl.textContent = '⚠ this patch can’t be auto-applied (' + (plan.patchRefused || 'no valid target') + '). '
        + 'The button below only SAVES the .patch file — bless the target project in PROJECTS to enable auto-apply.';
      r.body.appendChild(pl);
    } else if (plan && plan.dest) {
      const pl = document.createElement('div'); pl.className = 'ws-line ws-plan';
      pl.textContent = 'implement → saves the files to ' + plan.dest;
      r.body.appendChild(pl);
    }

    // ── decide: an optional message + Implement / Later / Discard ──
    const acts = document.createElement('div'); acts.className = 'turnin-rate ws-acts';
    // the message rides the decision as a REAL user turn in THIS session — its id is the shift's durable
    // streamId, so the agent replies with the build's actual transcript behind it (server-side resume seed).
    const msgInput = document.createElement('input'); msgInput.className = 'turnin-edit ws-msg'; msgInput.type = 'text';
    msgInput.placeholder = 'tell ' + who + ' anything about this (optional)';
    msgInput.setAttribute('aria-label', 'Optional message to the agent, sent with your decision');
    acts.appendChild(msgInput);

    let settled = false;
    // settle: flash the outcome on the card, then the card leaves and ONE honest line stays in the feed.
    // destPath (when the decision landed files) adds copy-path / reveal-folder chips to that line — the old
    // flow stranded the user with a long un-clickable path (2026-07-15 UX audit).
    const settle = (label, isDeny, destPath) => {
      if (settled) return; settled = true;
      acts.remove();
      const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = label;
      r.body.appendChild(tag);
      setTimeout(() => {
        vanish(r.d);
        if (!inOwnSession()) return;
        const lr = row('system'); lr.body.textContent = label;
        if (destPath) {
          const chips = document.createElement('span'); chips.className = 'consent-btns ws-destchips';
          const cp = document.createElement('button'); cp.className = 'consent-btn'; cp.textContent = 'copy path';
          cp.onclick = () => {
            const done = () => { cp.textContent = 'copied ✓'; setTimeout(() => { cp.textContent = 'copy path'; }, 1400); };
            try { navigator.clipboard.writeText(destPath).then(done, done); } catch (_) { done(); }
          };
          chips.appendChild(cp);
          const core = tauriCore();   // desktop shell only — a real Explorer/Finder reveal exists there
          if (core && core.invoke) {
            const rv = document.createElement('button'); rv.className = 'consent-btn'; rv.textContent = '📂 open folder';
            rv.onclick = () => { Promise.resolve(core.invoke('starnet_reveal_path', { path: destPath })).catch(() => { rv.textContent = 'could not open'; setTimeout(() => { rv.textContent = '📂 open folder'; }, 1600); }); };
            chips.appendChild(rv);
          }
          lr.body.appendChild(chips);
        }
        autoscroll();
      }, 900);
    };
    const sendNote = () => {   // the optional typed message → a REAL user turn in this session
      const msg = String(msgInput.value || '').trim();
      if (!msg || !inOwnSession()) return;
      send('About the “' + String(m.title || 'away build') + '” build you delivered: ' + msg);
    };
    const decideNote = (label) => { try { if (opts.noteDecision) opts.noteDecision(label); } catch (_) {} };

    // IMPLEMENT — decide keep. The label states the plan's REAL consequence (apply vs save), and the outcome
    // line is driven by the server's response: an apply says branch+repo; a patch that could only be SAVED
    // never reads as "implemented" (res.savedOnly — the fallback-honesty fields from handleWorkshopDecide).
    const patchSaveOnly = !!(plan && m.kind === 'patch' && plan.action !== 'apply');
    // gold PRIMARY when the click really implements; a fallback save stays neutral so the gold always means "accept"
    const implBtn = document.createElement('button'); implBtn.className = 'consent-btn' + (patchSaveOnly ? '' : ' ws-primary');
    implBtn.textContent = patchSaveOnly ? 'Save patch file' : 'Implement';
    implBtn.title = (plan && plan.action === 'apply') ? ('applies this patch to a new branch in ' + plan.root)
      : patchSaveOnly ? 'saves the .patch file only — it will NOT be applied to your project'
      : ('saves the files to ' + ((plan && plan.dest) || 'your StarNet deliverables folder'));
    implBtn.onclick = async () => {
      if (implBtn.disabled) return;
      implBtn.disabled = true; implBtn.textContent = patchSaveOnly ? 'saving…' : 'implementing…';
      let res = null; try { res = await onDecide('keep'); } catch (_) { res = { ok: false }; }
      if (res && res.ok) {
        const done = res.applied
          ? ('✓ implemented — applied to branch ' + (res.branch || '?') + (res.root ? (' in ' + res.root) : ''))
          : res.savedOnly
            ? ('⚠ patch file saved to ' + (res.destPath || 'your StarNet deliverables folder') + ' — NOT applied to your project')
            : ('✓ implemented — files saved to ' + (res.destPath || 'your StarNet deliverables folder'));
        decideNote(done); sendNote(); settle(done, false, res.applied ? '' : (res.destPath || ''));
      } else {
        implBtn.disabled = false; implBtn.textContent = patchSaveOnly ? 'Save patch file' : 'Implement';
        localLine('Could not implement this: ' + ((res && res.error) || 'the station refused') + '.');
      }
    };
    acts.appendChild(implBtn);

    // LATER — dismiss; the session stays in the rail and the card returns next time this session opens.
    const laterBtn = document.createElement('button'); laterBtn.className = 'consent-btn'; laterBtn.textContent = 'Later';
    laterBtn.onclick = async () => { try { await onDecide('later'); } catch (_) {} sendNote(); settle('↩ left in the workshop — reopen this session any time to decide', false); };
    acts.appendChild(laterBtn);

    // DISCARD — the ONE confirm (single click to arm, second to confirm). Honest about its weight: discard
    // wipes the files AND denylists the idea so it is never rebuilt or re-proposed (UX audit: the old confirm
    // undersold a permanent decision).
    const discardBtn = document.createElement('button'); discardBtn.className = 'consent-btn deny'; discardBtn.textContent = 'Discard';
    discardBtn.title = 'delete these files and never rebuild or re-propose this idea';
    let armed = false;
    discardBtn.onclick = async () => {
      if (!armed) { armed = true; discardBtn.textContent = 'Discard forever?'; setTimeout(() => { if (!settled) { armed = false; discardBtn.textContent = 'Discard'; } }, 4000); return; }
      discardBtn.disabled = true;
      let res = null; try { res = await onDecide('discard'); } catch (_) { res = { ok: false }; }
      if (res && res.ok) { const done = '✕ discarded — this idea won’t be rebuilt or re-proposed'; decideNote(done); sendNote(); settle(done, true); }
      else { discardBtn.disabled = false; armed = false; discardBtn.textContent = 'Discard'; localLine('Could not discard this: ' + ((res && res.error) || 'the station kept it') + '.'); }
    };
    acts.appendChild(discardBtn);

    r.body.appendChild(acts);
    autoscroll();
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
    // ONE header owns the "remembered" claim; each line below is just the memory itself (repeating
    // "◈ remembered:" per line + a bordered box per line is what made the post-run feed read as stacked popups).
    const cap = document.createElement('div'); cap.className = 'receipt-head';
    cap.textContent = '◈ remembered · ' + batch.proposals.length;
    head.body.appendChild(cap);
    for (const prop of batch.proposals) {
      const item = document.createElement('div'); item.className = 'receipt-item';
      const kind = document.createElement('span'); kind.className = 'turnin-kind'; kind.textContent = KIND_TAG[prop.kind] || 'NOTE';
      const text = document.createElement('span'); text.className = 'receipt-text'; text.textContent = prop.content;
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
          text.textContent = 'forgotten: ' + prop.content;   // muted state; stays denylisted (Memory Core Restore is the undo)
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

  // A task-specific decision resumes the sidecar-owned brief. It is deliberately NOT banked into the global dossier.
  let pendingTaskQuestion = null;
  function offerTaskQuestion(tq) {
    pendingTaskQuestion = Object.assign({}, tq, { streamId: activeWs && activeWs.id });
    // The host-validated recommended default (brief_ask path) gets the gold suggested chip + a one-line why.
    // A marker-path question stores no recommendation, so rec resolves empty and this renders plain chips.
    const rec = String(tq.recommended || '').trim().toLowerCase();
    const items = tq.options.map(o => {
      const suggested = !!(rec && o.toLowerCase() === rec);
      return { label: suggested ? '★ ' + o : o, value: o, suggested };
    });
    items.push({ label: 'use your judgment', value: '', skip: true });
    const q = row('agent'); q.d.classList.add('nudge');
    q.body.textContent = '⌖ ' + tq.question;
    if (rec && items.some(it => it.suggested) && String(tq.reason || '').trim()) {
      const why = document.createElement('div'); why.className = 'tq-reason';
      why.textContent = '★ suggested: ' + tq.recommended + ' — ' + String(tq.reason).trim();
      q.body.appendChild(why);
    }
    autoscroll();
    choices(items, item => {
      vanish(q.d);
      const ans = (item && !item.skip) ? String(item.value || '').trim() : '';
      const msg = (typeof TaskIntent !== 'undefined' && TaskIntent.answerMessage)
        ? TaskIntent.answerMessage(tq.question, ans)
        : (ans || 'Use your judgment and continue the original task.');
      if (!isBusy()) send(msg, { taskAction: 'answer' }); else echoUser(msg);
    });
  }

  // TASK BRIEF v2: enrich a run-end marker question with the durable brief's host-validated recommendation
  // before rendering the chips. Safe ordering: the sidecar persists the question BEFORE it emits the buffered
  // task run-end, so one fetch here always sees the stored row. Fail-open on every path — offline sidecar,
  // mismatched text, or a marker-path question (no recommendation stored) renders exactly the plain chips.
  async function presentTaskQuestion(ws, tq) {
    let recommended = '', reason = '';
    try {
      const r = await fetch('/api/task-briefs?key=' + encodeURIComponent('stream:' + ws.id) + '&status=clarifying&limit=1', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const b = j && Array.isArray(j.briefs) && j.briefs[0];
        const q = b && Array.isArray(b.questions) && b.questions[b.questions.length - 1];
        if (q && !q.answer && q.text === tq.question) { recommended = q.recommended || ''; reason = q.reason || ''; }
      }
    } catch (_) { /* enrichment only — the question itself never depends on this fetch */ }
    if (!isActiveWs(ws)) return;   // the Commander switched away mid-fetch; restoreTaskQuestion re-presents on return
    offerTaskQuestion(Object.assign({}, tq, { recommended, reason }));
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
  // NS-6 — the THREAD turn-in beat: the LOWEST-priority participant (memory > study > arc > trust > thread —
  // study always wins the moment first). null arbiter OR an older bundle without canThread -> thread stands down.
  function slotCanThread() { return (beatSlot && beatSlot.canThread) ? beatSlot.canThread() : 'busy'; }
  function slotThreadShown() { if (beatSlot && beatSlot.threadShown) beatSlot.threadShown(); }
  function slotThreadDone(more) { if (beatSlot && beatSlot.threadDone) beatSlot.threadDone(more); }
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
    if (why.length) { const ev = document.createElement('div'); ev.className = 'turnin-evidence'; ev.textContent = '↳ ' + why.join(' · '); item.insertBefore(ev, btns); }
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
    { const ev = document.createElement('div'); ev.className = 'turnin-evidence'; ev.textContent = '↳ ' + why.join(' · '); item.insertBefore(ev, btns); }
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
  /* NS-6 — THE THREAD TURN-IN BEAT (mined ideas → the durable thread ledger). After a salient task run the
     sidecar MINES "threads" — ideas the Commander floated but never acted on, each grounded by a VERBATIM quote —
     and STASHES the candidates (/api/threads/proposals; never auto-commits). Here we fetch them on agent.run.end
     and offer ONE for Keep / Edit / Discard: the click IS the consent — keep/edit commits an OPEN thread on the
     ledger (POST /api/threads/turnin; the night shift's propose step draws open threads FIRST), discard
     PERMANENTLY denylists the idea's fingerprint. It is the LOWEST post-run priority: it arms after the trust
     offer (THREAD_ARM_MS > TRUST_ARM_MS — memory, study, arc and trust all win the moment first, so study & thread
     proposals take turns, study first) and only takes a WHOLLY FREE beat slot through the SAME arbiter
     (slotCanThread), obeying the SAME stand-down guards (studyBlocked). Blocked moments QUEUE (FIFO, deduped) —
     deferred, never starved, never stacked. Leaving a card undecided tallies an ignore (2× = stop offering). */
  const THREAD_ARM_MS = 18000;   // later than TRUST_ARM_MS (16000): the thread turn-in yields the moment to every other beat
  const threadPending = [];      // {runId, agentId} thread offers deferred behind a busy moment — FIFO, retried next run end
  function threadBusy() { return !!(activeThreadCard && activeThreadCard.node && activeThreadCard.node.isConnected); }
  // defer a thread offer for a later moment — SINGLE queue path, FIFO, deduped by runId (mirrors queueStudy).
  function queueThread(runId, agentId) {
    if (!runId) return;
    for (const q of threadPending) if (q.runId === runId) return;
    threadPending.push({ runId: runId, agentId: agentId });
  }
  // an undecided thread card from a PRIOR task end EXPIRES when a new task ends — the "ignored" verdict
  // (2× = stop offering that idea) — and releases the slot so queued beats can't starve (mirrors expireActiveStudy).
  function expireActiveThread() {
    if (!activeThreadCard) return;
    const a = activeThreadCard;
    if (!a.node || !a.node.isConnected) { activeThreadCard = null; slotThreadDone(turninQueue.length > 0); return; }   // COMMS re-rendered under it
    if (a.decided) return;   // mid-settle — its own timer is about to close it
    activeThreadCard = null;
    try { if (a.prop && typeof ThreadStore !== 'undefined' && ThreadStore.ignore) ThreadStore.ignore(a.prop); } catch (_) {}
    slotThreadDone(turninQueue.length > 0);
    vanish(a.node, () => { if (turninQueue.length && !activeTurnin) showNextTurnin(); });
  }
  // render ONE mined thread candidate as a gold-inset turn-in card (Keep / Edit / Discard). Mirrors studyCard's
  // family + lifecycle discipline exactly; consent routes to ThreadStore → POST /api/threads/turnin (awaited —
  // the card only claims what the ledger verified: truthful telemetry). Returns true iff the card rendered.
  function threadCard(prop, agentId, batchRunId) {
    if (!log || !prop || typeof ThreadStore === 'undefined') return false;
    clearNudge();                      // claim the one post-run beat slot, retiring any gentle nudge
    if (typeof ThreadStore.markShown === 'function') ThreadStore.markShown();   // spend the one session-cap slot
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('turnin'); r.d.classList.add('thread');
    const title = document.createElement('span'); title.className = 'turnin-title';
    title.textContent = '◈ ' + name + ' caught an idea you floated but never picked up — keep the thread?';
    const slotEl = document.createElement('span'); slotEl.className = 'turnin-slot';
    r.body.appendChild(title); r.body.appendChild(slotEl);
    const item = document.createElement('div'); item.className = 'turnin-item';
    const kind = document.createElement('span'); kind.className = 'turnin-kind'; kind.textContent = 'THREAD';
    const text = document.createElement('span'); text.className = 'turnin-text'; text.textContent = prop.title;
    const btns = document.createElement('span'); btns.className = 'consent-btns';
    item.appendChild(kind); item.appendChild(text); item.appendChild(btns);
    // provenance line: the VERBATIM quote the mine grounded this idea in (the evidence, never a paraphrase).
    if (prop.spec) { const ev = document.createElement('div'); ev.className = 'turnin-evidence'; ev.textContent = '↳ you said “' + prop.spec + '” · kept threads feed the night shift'; item.insertBefore(ev, btns); }
    slotEl.appendChild(item);
    const card = { node: r.d, prop: prop, decided: false };
    activeThreadCard = card;
    slotThreadShown();
    function done() {
      if (activeThreadCard === card) activeThreadCard = null;
      slotThreadDone(turninQueue.length > 0);
      // hand the moment to a memory deck that queued behind this card (mirrors studyCard's done()).
      vanish(r.d, () => { if (turninQueue.length && !activeTurnin) showNextTurnin(); });
    }
    function settle(label, isDeny) {
      card.decided = true; btns.remove();
      const tag = document.createElement('span'); tag.className = 'consent-result' + (isDeny ? ' err' : ''); tag.textContent = label;
      item.appendChild(tag);
      setTimeout(done, 600);
    }
    // ASYNC-SAFE VERDICTS (the trustCard accept pattern): every verdict resolves against the server — disable the
    // buttons while pending + mark the card decided NOW (the user answered; an expiry sweep must not tally an
    // "ignore" under an in-flight verdict). Settle only on the VERIFIED result — never flash "kept" on a refusal.
    function commit(verdict, edits) {
      if (card.decided) return;
      card.decided = true;
      btns.querySelectorAll('button').forEach(b => { b.disabled = true; });
      if (verdict === 'keep') {
        Promise.resolve(ThreadStore.keep(prop, batchRunId, agentId, edits || null)).then(res => {
          if (!res || res.ok !== true) { settle('✕ couldn’t reach the ledger', true); return; }
          if (res.reason === 'added') settle(edits ? '✓ kept (edited) — on the ledger' : '✓ kept — on the ledger', false);
          else if (res.reason === 'duplicate') settle('✓ already on the ledger', false);
          else if (res.reason === 'declined') settle('✕ you discarded this idea before', true);   // the permanent denylist refused it — honest
          else settle('✕ the ledger refused it', true);   // 'unknown'/stale — nothing was committed
        }).catch(() => { settle('✕ couldn’t reach the ledger', true); });
        return;
      }
      Promise.resolve(ThreadStore.discard(prop, batchRunId, agentId)).then(res => {
        settle((res && res.ok === true) ? '✕ discarded — never again' : '✕ couldn’t reach the ledger', true);
      }).catch(() => { settle('✕ couldn’t reach the ledger', true); });
    }
    function renderChoices() {
      btns.innerHTML = '';
      const mk = (lbl, cls, fn) => { const b = document.createElement('button'); b.className = 'consent-btn' + (cls ? ' ' + cls : ''); b.textContent = lbl; b.onclick = fn; btns.appendChild(b); };
      mk('Keep', '', () => commit('keep'));
      mk('Edit', '', enterEdit);
      mk('Discard', 'deny', () => commit('discard'));
    }
    function enterEdit() {
      if (card.decided) return;
      // inline title + spec tweak, then keep (verdict 'edit' carries both to the ledger).
      const wrap = document.createElement('span'); wrap.style.display = 'grid'; wrap.style.gap = '4px'; wrap.style.minWidth = '0';
      const inpTitle = document.createElement('input'); inpTitle.type = 'text'; inpTitle.className = 'turnin-edit'; inpTitle.value = prop.title;
      const inpSpec = document.createElement('input'); inpSpec.type = 'text'; inpSpec.className = 'turnin-edit'; inpSpec.value = prop.spec || '';
      wrap.appendChild(inpTitle); wrap.appendChild(inpSpec);
      item.replaceChild(wrap, text); inpTitle.focus(); try { inpTitle.setSelectionRange(inpTitle.value.length, inpTitle.value.length); } catch (_) {}
      const commitEdit = () => {
        const t = inpTitle.value.trim(); if (!t) { inpTitle.focus(); return; }
        text.textContent = t; item.replaceChild(text, wrap);
        commit('keep', { title: t, spec: inpSpec.value.trim() });
      };
      const cancel = () => { item.replaceChild(text, wrap); renderChoices(); };
      btns.innerHTML = '';
      const mk = (lbl, fn) => { const b = document.createElement('button'); b.className = 'consent-btn'; b.textContent = lbl; b.onclick = fn; btns.appendChild(b); };
      mk('Save', commitEdit); mk('Cancel', cancel);
      const keydown = e => { if (e.key === 'Enter') commitEdit(); else if (e.key === 'Escape') cancel(); };
      inpTitle.onkeydown = keydown; inpSpec.onkeydown = keydown;
    }
    renderChoices();
    autoscroll();
    return true;
  }
  // try to place the OLDEST deferred thread offer (FIFO) now that a new task end may have freed the moment.
  // Never chains: one card per flush (mirrors flushStudyPending).
  function flushThreadPending() {
    if (typeof ThreadStore === 'undefined' || threadBusy() || slotCanThread() !== 'free' || studyBlocked()) return;
    if (!ThreadStore.canShow || !ThreadStore.canShow()) return;
    if (threadPending.length) { const next = threadPending.shift(); if (next) offerThread(next.runId, next.agentId); }
  }
  // fetch + offer ONE live mined thread candidate for a run, obeying the one-beat arbiter + stand-down guards +
  // session cap. Any blocked moment QUEUES (single path, FIFO, deduped) — deferred, never starved, never stacked.
  async function offerThread(runId, agentId) {
    if (typeof ThreadStore === 'undefined') return;
    if (threadBusy() || slotCanThread() !== 'free' || studyBlocked()) { queueThread(runId, agentId); return; }
    if (!ThreadStore.canShow || !ThreadStore.canShow()) return;                    // session cap spent (per-session, not deferrable)
    const batch = await ThreadStore.fetchProposals(runId, agentId);
    const prop = ThreadStore.nextLive(batch.proposals);   // drops resolved/ignored candidates
    if (!prop) return;
    // re-check the moment after the async fetch — a higher-priority beat may have claimed it meanwhile.
    if (threadBusy() || slotCanThread() !== 'free' || studyBlocked()) { queueThread(runId, agentId); return; }
    threadCard(prop, agentId, batch.runId || runId);
  }
  function wireThreads() {
    if (threadWired || typeof U === 'undefined' || !U.bus) return;
    threadWired = true;
    U.bus.on('agent.run.end', p => {
      if (!p || p.reason !== 'done') return;                       // only after a clean run
      if ((p.agentId || 'agent') !== 'agent') return;             // hero runs only (a summoned worker never turns in threads)
      const runId = p.runId || p.id;
      // a new task ended: the PREVIOUS task's undecided thread card expires as an "ignore", then one deferred
      // offer may take the freed moment (anti-starve). Short delay = after the reply renders.
      setTimeout(() => { expireActiveThread(); flushThreadPending(); }, 900);
      // THIS run's own offer arms LAST (THREAD_ARM_MS): memory turn-in, study, arc and trust all claim the moment
      // first — the mine itself is an aux LLM round-trip away, so by now the stash is populated if it fired.
      setTimeout(() => {
        if (!runId || threadRunsSeen.has(runId)) return;           // fetch a run's thread proposals at most once
        threadRunsSeen.add(runId);
        if (threadRunsSeen.size > 200) threadRunsSeen.delete(threadRunsSeen.values().next().value);
        offerThread(runId, p.agentId || 'agent');
      }, THREAD_ARM_MS);
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
          onDone: () => { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('commander'); },
          // LEAVING the curiosity-launched interview = the same "not now" wave-off: mark the dimension dismissed so it
          // isn't raised again this session (existing store, no new persistence — mirrors the choice-row "not now").
          onLeave: () => { if (typeof CuriosityStore !== 'undefined') CuriosityStore.markDismissed(dim); }
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
  /* E6 — shell.bg.exit consumer. The sidecar announces when a background/long-running shell process
     (shell.exec background:true — a dev server, a watcher) ends, riding the durable SSE bus. That event
     existed SOLELY for the UI yet had zero listeners, so a crashed dev server kept reading as alive with
     no surface anywhere. Give it a minimal honest system line in COMMS: a terse station broadcast (not a
     beat-slot card — never competes for the post-run slot). Renders directly (no coalesce/screen gate),
     because a process fault must never be silently dropped. Scoped to the owning agent's name when
     resolvable. Truthful telemetry: it states what the harness proved — the process exited, with its code. */
  let bgExitWired = false;
  function wireBgExit() {
    if (bgExitWired || typeof U === 'undefined' || !U.bus) return;
    bgExitWired = true;
    U.bus.on('shell.bg.exit', p => {
      try {
        if (!p || !p.bgId || !log) return;
        const code = (typeof p.exitCode === 'number') ? p.exitCode : null;
        const killed = !!p.killed;
        const nm = (typeof App !== 'undefined' && App.agentName) ? (App.agentName(p.agentId || 'agent') || '') : '';
        // terse, honest: WHO (if known) · WHAT · the proven exit code / killed state
        const verb = killed ? 'was stopped' : (code === 0 ? 'exited cleanly' : 'exited');
        const codeStr = killed ? '' : (code == null ? '' : ' (code ' + code + ')');
        const who = nm ? nm + '’s ' : '';
        const line = who + 'background process ' + String(p.bgId) + ' ' + verb + codeStr;
        // render as a station system line (broadcast register) — dim, centered, hairline; NOT a card.
        const d = document.createElement('div');
        d.className = 'cmsg broadcast' + (killed || code === 0 ? '' : ' broadcast-warn');
        d.setAttribute('role', 'status');
        const span = document.createElement('span'); span.className = 'bc-line';
        const pre = document.createElement('span'); pre.className = 'bc-glyph'; pre.textContent = '▸ ';
        span.appendChild(pre);
        span.appendChild(document.createTextNode(line));
        d.appendChild(span);
        if (typeof clearEmptyState === 'function') clearEmptyState();
        log.appendChild(d);
        autoscroll();
      } catch (_) {}
    });
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
        // ROUTINE NUDGE (recipe lane D): a naturally-recurring recipe the Commander keeps hand-launching earns ONE
        // offer to put it on a schedule — after suggestion/seed (rarer, more specific asks), before recruitment.
        // Accepting deep-links into the SCHEDULE IT form (propose-and-confirm; never a silent cron write).
        if (typeof RoutineNudgeStore !== 'undefined' && RoutineNudgeStore.onRunEnd) { try { RoutineNudgeStore.onRunEnd(); } catch (_) {} }
        if (typeof RoutineNudgeStore !== 'undefined' && RoutineNudgeStore.willPropose && RoutineNudgeStore.propose && RoutineNudgeStore.willPropose()) { RoutineNudgeStore.propose(); return; }
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
    let lastReal = null;   // the trailing dialogue turn (for the error-recovery re-offer below)
    renderingHistory = true;   // suppress the per-row entrance animation across this bulk replay (restored below)
    try {
    for (const m of h) {
      if (m && m.truncated) {   // E3: the local history-cap marker — render it as a dim centered SYSTEM line (not a dropped record)
        if ((m.content || '').trim()) trimMarkerLine(m.content);
        continue;
      }
      // TIMESTAMP TRUTH (P0): pass the turn's STORED real time (m.ts), or `false` when a legacy turn carries none —
      // never `true` here (that would re-stamp replayed history with the current clock, the fabrication we're killing).
      const stamp = (m && m.ts != null) ? m.ts : false;
      if (m.role === 'user') { addUser(m.content, m.attachments, stamp); lastReal = m; continue; }
      // a SYSTEM STATUS marker (sys — e.g. an autosessions run-outcome framing line) renders as a system-styled
      // line, NOT as agent speech; it never seeds the model (historyWindow drops it) and it stays visible in-thread.
      if (m && m.sys) { if ((m.content || '').trim()) toolLine(m.content, !!m.error); continue; }
      if (m.role !== 'assistant') continue;   // only dialogue turns render (a stray system marker never shows as an agent reply)
      if (!(m.content || '').trim()) { if (m.stopped) lastReal = m; continue; }   // zero-token stop: durable recovery truth, never a blank speech row
      const r = row('agent', { stamp: stamp });   // past turns render as plain GROUPED messages; only the LIVE reply is the lit headline
      if (m.error) r.d.classList.add('err');
      renderProse(r.body, m.content);   // same linkify path as live tokens, so replayed history matches
      lastReal = m;
    }
    } finally { renderingHistory = false; }   // future LIVE rows animate again
    // STRANDED-USER LAW: a reload/switch onto a stream whose LAST turn failed (error:true) must not leave the
    // Commander with a dead thread and no way out — load() wiped the live recovery chips. Re-offer a plain retry
    // (offerRetry's context-aware verdict isn't stored per-turn, so the safe universal recovery is a re-run).
    if (lastReal && lastReal.role === 'assistant' && (lastReal.error || lastReal.stopped) && !isBusy()) {
      if (lastReal.stopped) offerTryAgain();
      else offerRetry(null);
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
    // TOOL-RENDER UNIFICATION: re-draw the run's tool activity as the SAME premium chips a live run shows
    // (call → pending chip; result → folds into it by callId), instead of the old dim toolLine downgrade.
    // Fall back to the legacy string lines only if this snapshot predates structured events (older bundle).
    if (s.toolEvents && s.toolEvents.length) {
      for (const e of s.toolEvents) {
        if (e.t === 'result') resolveChip({ callId: e.callId, summary: e.summary, isError: e.isError, ms: e.ms }, e.name);
        else toolChip({ callId: e.callId, name: e.name, argsSummary: e.argsSummary });
      }
      endToolRail();   // close the rail so the partial reply below opens a fresh paragraph, not glued into the chips
    } else {
      for (const t of s.tools) toolLine(t.text, t.isErr);
    }
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
      cleanTaskIntent() { if (seg && typeof TaskIntent !== 'undefined' && TaskIntent.strip) { raw = TaskIntent.strip(raw); renderProse(seg.body, raw); } },
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
    if (typeof Channels !== 'undefined' && Channels.clearPending) Channels.clearPending(id, Date.now());   // a pending approval is moot once stopped
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
  // Persist the truthful tail of a non-clean run. Normal envelopes may already have appended their partial
  // assistant prose; thrown aborts have not. Mark the matching tail or add one durable marker (including empty
  // output), so reload restores recovery without ever rendering a synthetic blank assistant message.
  function markStoppedTurn(ws, content) {
    if (!ws || !Array.isArray(ws.history)) return;
    const text = String(content || '');
    const last = ws.history[ws.history.length - 1];
    if (last && last.role === 'assistant' && !last.error && String(last.content || '') === text) {
      last.stopped = true;
      return;
    }
    ws.history.push({ role: 'assistant', content: text, stopped: true, ts: Date.now() });
  }
  // RETRY — re-run the last turn after an outage / connection drop / in-band error. Discard the trailing failed
  // reply, re-render the thread (dropping the ⚠ row), then resend the last user message WITHOUT echoing it again.
  function retryLast() {
    if (!activeWs || isBusy()) return;
    const h = activeWs.history;
    if (h.length && h[h.length - 1].role === 'assistant' && (h[h.length - 1].error || h[h.length - 1].stopped)) h.pop();   // drop the failed/stopped partial reply
    let text = null;
    for (let i = h.length - 1; i >= 0; i--) { if (h[i].role === 'user') { text = h[i].content; break; } }
    if (text == null) return;
    load(activeWs);                 // re-render the thread cleanly (the popped ⚠ row is gone)
    send(text, { retry: true });    // re-run it; the user turn is already present, so don't echo it
  }
  // The shared plain recovery action for an intentional Stop and unknown retryable faults. It delegates to the
  // same guarded retryLast path as `/retry`, so an inactive/busy stream cannot start a duplicate run.
  function offerTryAgain() {
    choices([{ label: '↻ Try again', value: 'retry' }], () => retryLast());
  }
  // a one-tap recovery chip dropped under a failed turn (reuses the suggestion-pill row, which self-removes on
  // tap). CONTEXT-AWARE on the classified verdict: a retryable fault offers "↻ Try again"; an auth/billing
  // fault points at SETTINGS (fix the key) instead of a doomed retry; a capability denial points at SKILLS;
  // a non-retryable, non-actionable fault offers nothing (no blind retry). Falls back to a plain retry chip
  // when called without a verdict (legacy callers / unknowns), preserving the old behavior + value:'retry'.
  function offerRetry(verdict) {
    if (!log) return;
    if (!verdict) { offerTryAgain(); diagAffordance(); return; }
    // ADOPTION (Lane A): every error names its DOOR and opens the exact one. Friendly.actionButton maps the
    // verdict to { label, run } — capdenied -> REFIT (with the named capability), auth/no-key -> the real key
    // field or "reconnect ChatGPT", model-not-found -> models. One source of truth; no local per-action ladder.
    const btn = (typeof Friendly !== 'undefined' && Friendly.actionButton) ? Friendly.actionButton(verdict) : null;
    if (btn) { choices([{ label: btn.label, value: verdict.action }], () => btn.run()); diagAffordance(); return; }
    if (verdict.retryable) { offerTryAgain(); diagAffordance(); return; }
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
    b.textContent = '⧉ copy diagnostics for a bug report';   // ⧉ = the house copy glyph (not the 📋 emoji)
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
    const peer = !isBusy() ? busyPeerFor(activeWs) : null;
    if (input) { input.disabled = !!peer; input.title = peer ? ('This agent is busy in ' + streamLabel(peer)) : ''; }
    const sendBtn = el('chat-send'); if (sendBtn) sendBtn.disabled = !!peer;
    const attachBtn = el('chat-attach'); if (attachBtn) attachBtn.disabled = !!peer;
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
    const ws = Workstreams.create(title, { agentId: (activeWs && activeWs.agentId) || 'agent', kind: 'task' });   // /background is a directive → a board task
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
    if (activeTurnin || activeNudge || studyBusy() || threadBusy()) return true;   // a visible review/beat is up
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
    const ws = Workstreams.create(title, { agentId: src.agentId || 'agent', kind: src.kind === 'task' ? 'task' : 'chat' });   // a branch inherits the SOURCE stream's kind
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
    localLine('Usage: lifetime ' + (t.tokens || 0) + ' tokens (≈¾ word each), ' + U.usd(t.cost || 0) + ' spent, ' + (t.calls || 0)
      + ' model calls. This stream: ' + (c.tokens || 0) + ' tokens, ' + U.usd(c.usd || 0) + ', ' + (c.calls || 0) + ' calls.');
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
    // F3 (2026-07-14 adversarial sweep): with NOTHING running there is nothing to steer — refuse honestly.
    // The old fallthrough send(note) silently minted a FULL model run out of a steering note (real-provider
    // spend for a no-op; the sidecar's own /api/run/steer honestly 404s in this state and was never asked).
    localLine('Nothing is running to steer. Start a task first, or /queue <text> to stage it for the next run.');
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
    const cs = (typeof Harness !== 'undefined' && Harness.contextState) ? Harness.contextState((activeWs && activeWs.agentId) || 'agent') : null;
    // The run host is STATELESS — the conversation lives in the browser and is sent per call — so there is no
    // persistent server-side context to fold on demand between runs. Auto-compaction runs INSIDE a run when the
    // live prompt crosses the threshold. This is the honest status; see the slash-parity report for the rationale.
    if (cs && cs.limit) {
      const pct = Math.round(((cs.used || 0) / cs.limit) * 100);
      localLine('Chat memory: ' + (cs.used || 0) + ' / ' + cs.limit + ' tokens used (' + pct + '% — a token is roughly ¾ of a word). When it nears full, older turns are folded into a summary automatically during the next run; there is nothing you need to do.');
    } else {
      localLine('Chat memory is managed automatically: when a conversation grows past what the model can hold, older turns are folded into a summary during the next run. There is nothing you need to do.');
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
    // ONE collapsed card instead of up to 31 flooding rows — click to expand the turns.
    const lines = slice.map(m => (m.role === 'user' ? 'You' : 'Agent') + ': ' + String(m.content).replace(/\s+/g, ' ').slice(0, 160));
    systemCard('History — last ' + slice.length + ' of ' + h.length + ' turn' + (h.length === 1 ? '' : 's') + ' (click to expand)', lines);
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
        const models = Array.isArray(j.byModel) ? j.byModel.slice(0, 3).map(m => (m.model || '?') + ' (' + U.usd(m.usd || 0) + ')') : [];
        const succ = (j.successPct == null) ? '' : ', ' + j.successPct + '% completed';
        return localLine('Insights (lifetime run history for ' + agentId + '): ' + (j.totalRuns || 0) + ' run' + (j.totalRuns === 1 ? '' : 's')
          + ', ' + U.usd(j.totalUsd || 0) + ', ' + (j.totalTokens || 0) + ' tokens'
          + (j.avgUsdPerRun ? ', ' + U.usd(j.avgUsdPerRun) + '/run' : '') + succ
          + (models.length ? '. Top models: ' + models.join(', ') : '') + '.');
      }
    } catch (_) {}
    // sidecar offline / no fold — honest session-only fallback, never fabricated.
    const t = (typeof Harness !== 'undefined' && Harness.totals) ? Harness.totals() : { tokens: 0, cost: 0, calls: 0 };
    localLine('Insights: the durable run history is unavailable (sidecar offline). This SESSION only: ' + (t.tokens || 0) + ' tokens, '
      + U.usd(t.cost || 0) + ', ' + (t.calls || 0) + ' calls.');
  }
  function activeAgent() {
    try { return (typeof App !== 'undefined' && App.currentAgent) ? App.currentAgent() : null; } catch (_) { return null; }
  }
  function applyAgentPatch(patch) {
    try { if (typeof App !== 'undefined' && App.applyConfig) { App.applyConfig(patch); return true; } } catch (_) {}
    return false;
  }
  // F4 (adversarial sweep 2026-07-14): /model used to ack ANY id with a confident success line —
  // a garbage id then 404s every real-provider run while /whoami reports it as live. Warn-not-block
  // at the ack seam (sandbox law: the id stays set — custom endpoints can serve ids the catalog
  // doesn't know); an EMPTY catalog is honest uncertainty (offline / cold warm-up), never an alarm.
  function modelAckWarning(id, list) {
    const models = Array.isArray(list) ? list.filter(m => m && m.id) : [];
    if (!models.length) return '';
    if (models.some(m => m.id === id)) return '';
    return 'Warning: "' + id + '" is not in the current model catalog (' + models.length
      + ' known ids) — runs may fail with model-not-found. It stays set; /model <id> to change, /model to inspect.';
  }
  async function warnUnknownModel(id) {
    try {
      if (typeof Harness === 'undefined' || !Harness.listModels) return;
      const warn = modelAckWarning(id, await Harness.listModels());
      if (warn) localLine(warn);
    } catch (_) {}
  }
  function modelCommand(args) {
    const next = String(args || '').trim();
    if (next) {
      let set = false;
      if (applyAgentPatch({ model: next })) { localLine('Model set to ' + next + ' for future runs.'); set = true; }
      else if (typeof Harness !== 'undefined' && Harness.setModel) { Harness.setModel(next); localLine('Model set to ' + next + ' for this harness session.'); set = true; }
      else localLine('Model setting is not available yet.');
      if (set) warnUnknownModel(next);
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
    const cs = (typeof Harness !== 'undefined' && Harness.contextState) ? Harness.contextState((activeWs && activeWs.agentId) || 'agent') : null;
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
  async function toolsCommand() {
    const placed = slashPlacedTypes();
    const have = {}; placed.forEach(t => { have[t] = true; });
    const active = toolRows().filter(r => r.cap == null || have[r.cap]);
    const missing = toolRows().filter(r => r.cap && !have[r.cap]).map(r => r.label);
    // JUKEBOX is a two-step unlock: place the prop (grants the tools) AND connect Spotify in Settings (the tools
    // are inert until the OAuth session exists). If it's placed but Spotify isn't connected, say so honestly
    // rather than listing spotify as fully live — the truthful-telemetry law applies to /tools too.
    let jukeNote = '';
    if (have.jukebox) {
      let connected = false;
      try { const j = await (await fetch('/api/spotify/status', { cache: 'no-store' })).json(); connected = !!(j && j.connected); } catch (_) {}
      if (!connected) jukeNote = ' Spotify not connected — connect it in Settings to use the JUKEBOX.';
    }
    localLine('Tools: ' + active.map(r => r.label + ' (' + r.tools + ')').join('; ')
      + (missing.length ? '. Locked until placed: ' + missing.join(', ') + '.' : '.')
      + jukeNote);
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
    const cmds = buildCommands().filter(c => c.source !== 'recipe');
    const recipes = buildCommands().filter(c => c.source === 'recipe').length;
    // group by the existing `category` field so the command surface reads by area, not one flat blob
    const groups = new Map();
    for (const c of cmds) { const cat = c.category || 'General'; if (!groups.has(cat)) groups.set(cat, []); groups.get(cat).push('/' + c.name); }
    const lines = [];
    for (const [cat, names] of groups) lines.push(cat + ' — ' + names.join(', '));
    if (recipes) lines.push('Recipes — ' + recipes + ' available (type "/" to browse)');
    lines.push('Tip: press ↑ in an empty box to recall your last message.');   // ArrowUp recall hint
    systemCard('Commands (' + cmds.length + ') — click to expand', lines);
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
  function insertRecipe(r, values) {
    if (!input) return;
    let directive = (r && r.task) || (r && r.name) || '';
    for (const p of (r && r.params) || []) {
      if (!p || !p.key) continue;
      // last-used inputs (confirm-by-sight: they land visibly in the composer) beat catalog defaults.
      const remembered = values && typeof values[p.key] === 'string' && values[p.key].trim() ? values[p.key] : null;
      const v = remembered != null ? remembered : ((p.default != null && p.default !== '') ? p.default : null);
      if (v != null) directive = directive.split('{' + p.key + '}').join(v);
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
    // Match on the command NAME only (the first token). Once the user types a space into the arguments
    // ("/personality direct"), the full string stops prefix-matching any command name and the palette used
    // to CLOSE — which dropped Enter through to send(), firing the whole "/cmd args" line at the agent as a
    // chat message instead of running the command. Matching the first token keeps the command shown so Enter
    // dispatches it (with its args parsed off input.value in runSlash).
    slashItems = matchCommands(String(query || '').split(/\s+/)[0]);
    if (!slashItems.length) { closeSlash(); return; }
    if (slashSel >= slashItems.length) slashSel = 0;
    renderSlash(); pop.hidden = false;
  }
  // resolve a "/name …" line to its command by exact name/alias (first token) — the belt-and-suspenders path
  // for Enter when the palette isn't open (e.g. the server catalog is still loading), so an arg-taking command
  // still dispatches instead of being sent to the agent as plain text.
  function commandFromLine(raw) {
    const m = String(raw || '').match(/^\/(\S+)/);
    if (!m) return null;
    const name = m[1].toLowerCase();
    return buildCommands().find(c => c.name.toLowerCase() === name || (c.aliases || []).some(a => String(a || '').toLowerCase() === name)) || null;
  }
  function closeSlash() {
    const pop = el('chat-slash'); if (pop) pop.hidden = true; slashItems = []; slashSel = 0;
    if (input) { input.removeAttribute('aria-activedescendant'); input.setAttribute('aria-expanded', 'false'); }
  }
  function moveSlash(d) { if (!slashItems.length) return; slashSel = (slashSel + d + slashItems.length) % slashItems.length; renderSlash(); }
  const SLASH_OPT_ID = i => 'slash-opt-' + i;   // stable per-position option id for aria-activedescendant
  function renderSlash() {
    const pop = el('chat-slash'); if (!pop) return;
    pop.innerHTML = '';
    const head = document.createElement('div'); head.className = 'slash-head'; head.textContent = '/ COMMANDS';
    pop.appendChild(head);
    slashItems.forEach((c, i) => {
      const it = document.createElement('div'); it.className = 'slash-item' + (i === slashSel ? ' sel' : ''); it.setAttribute('role', 'option');
      it.id = SLASH_OPT_ID(i); it.setAttribute('aria-selected', i === slashSel ? 'true' : 'false');
      const nm = document.createElement('span'); nm.className = 'slash-name'; nm.textContent = '/' + c.name;
      const ds = document.createElement('span'); ds.className = 'slash-desc'; ds.textContent = c.desc || '';
      it.appendChild(nm); it.appendChild(ds);
      // reveal the command SURFACE: a dim category tag (the existing `category` field) so the palette groups
      // legibly by area without reordering the relevance-ranked matches.
      if (c.category && c.category !== 'General') { const tag = document.createElement('span'); tag.className = 'slash-cat'; tag.textContent = c.category; it.appendChild(tag); }
      it.onmouseenter = () => { slashSel = i; renderSlash(); };
      it.onmousedown = e => { e.preventDefault(); runSlash(c); };   // mousedown keeps input focus
      pop.appendChild(it);
    });
    // AT: point the focused composer at the active option (the listbox is separate, so activedescendant lives on
    // the input) + mark the palette open. Keyboard nav (moveSlash) re-renders → this follows the selection.
    if (input) { input.setAttribute('aria-expanded', 'true'); if (slashItems[slashSel]) input.setAttribute('aria-activedescendant', SLASH_OPT_ID(slashSel)); }
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
    // ATTACHMENTS: photos/files staged in the composer, snapshotted by the Enter handler into opts.attachments as
    // lightweight refs { id,name,path,mediaType,kind }. They ride the user turn (history + /api/run) and the
    // sidecar expands them into image/text content blocks at run time. Empty on a plain text turn / a RETRY.
    const attsIn = (opts && Array.isArray(opts.attachments)) ? opts.attachments : [];
    // R5 "Bottle a run": did THIS directive come from a recipe launch? launchRecipe() passes fromRecipe:true. A
    // recipe-launched run must NEVER be offered for bottling (it already IS a recipe) — recorded in RUN_META below.
    const fromRecipe = !!(opts && opts.fromRecipe);
    // provenance SPINE: WHICH recipe launched this run (null for everything else). Rides RUN_META (so rateWork can
    // attribute the verdict to the recipe) and the /api/run body (so the durable run row carries it).
    const recipeId = (opts && opts.recipeId != null && String(opts.recipeId).trim()) ? String(opts.recipeId).slice(0, 60) : null;
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
    const preflightPeer = busyPeerFor(ws);
    if (preflightPeer) { renderAgentBusy(preflightPeer); syncStatus(); return; }
    const pending = pendingTaskQuestion && pendingTaskQuestion.streamId === ws.id ? pendingTaskQuestion : null;
    const routedTaskReply = pending && typeof TaskIntent !== 'undefined' && TaskIntent.routeReply ? TaskIntent.routeReply(text) : null;
    const taskAction = (opts && opts.taskAction) || (routedTaskReply && routedTaskReply.action) || '';
    if (Channels.isBusy(ws.id)) return;   // one run per stream — but OTHER streams may be running concurrently
    warmChat();   // D1 WARMTH: sending to the focused stream is real engagement — keep the chat-stare alive
    // FIRST-TURN TITLE UPGRADE: is THIS the stream's first user turn (still on its machine-derived placeholder)?
    // Captured BEFORE we push this message, so after the run lands we can replace the truncated first-sentence
    // title with a model-written summary. General is excluded — it stays the untitled chat home.
    if (pending) pendingTaskQuestion = null;
    const firstTurn = (typeof Workstreams !== 'undefined') && ws.id !== Workstreams.generalId()
      && !ws.history.some(m => m && m.role === 'user');
    Channels.begin(ws.id, Date.now());   // stamp the run start so the COMMS elapsed timer counts real wall-clock
    const wiAid = ws.agentId || 'agent';
    const wiId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('wi-' + Date.now() + '-' + (++wiSeq));
    const wiPlacedTs = Date.now();
    let wiPlaced = false;   // set below iff a crate actually rode — every wi* beat downstream gates on it
    stick = true;   // sending a message means you want to watch the exchange — re-follow the bottom
    // TIMESTAMP TRUTH (P0): stamp the turn with its REAL wall-clock time at push, and render the same instant on
    // screen — so a later replay/switch shows this turn's actual time, never the reload clock.
    if (!retry) { const uts = Date.now(); addUser(text, attsIn, uts); ws.history.push(attsIn.length ? { role: 'user', content: text, attachments: attsIn, ts: uts } : { role: 'user', content: text, ts: uts }); capHistory(ws); }   // on RETRY the user turn is already in the thread + on screen
    // name an untitled stream from its first real message (no-op on General / already-titled)
    if (typeof Workstreams !== 'undefined' && Workstreams.autoTitle(ws.id, text)) {
      if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
    }

    const isTask = !!pending || Classify.isTaskDirective(text);
    // P1 + BELT IS WORK-ONLY (Andrew's ruling 2026-07-05): only a real TASK directive drops an INTAKE ore box
    // on the belt / bumps the queue gauge (mirrors the Telegram admit shape — the sidecar gates on the SAME
    // classifier). Pure chat ("hello") gets its reply with NOTHING on the floor.
    if (isTask) {
      wiPlaced = true;
      const depth = wiBump(wiAid, 1);
      wiEmit('workitem.placed', { workitemId: wiId, queueId: wiAid, agentId: wiAid, kind: 'directive', preview: String(text || '').replace(/\s+/g, ' ').slice(0, 40), queueDepth: depth, ts: wiPlacedTs });
      wiEmit('queue.status', { queueId: wiAid, depth: depth, maxCapacity: 64, nextAdvanceAt: 0 });
    }
    // fold the interest tag of a real task into the local user-affinity profile (the signal classify.js
    // already computes here and otherwise discards). Captures only a derived {code|research|general}
    // count — never the message text. Gated on the user's learning flag inside the store.
    // observe ONLY a genuine new directive — never on RETRY (re-running the same text must not double-count the
    // shape, which would inflate the recurrence signal and let a true one-off wrongly fire the memory beat).
    if (!retry && isTask && !pending && typeof ProfileStore !== 'undefined') ProfileStore.observeMessage(text);
    if (!retry && isTask && !pending && typeof MintStore !== 'undefined') MintStore.observe(text);   // notice recurring jobs → propose minting them as one-tap missions
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
      // TRUTHFUL TELEMETRY: 'working…' is only claimed once the sidecar has confirmed the run (runId set).
      // The eager isTask walk fires before that — the walk happens, but the status stays 'connecting…' until
      // agent.run.start lands (onRunId then upgrades it, honoring the task ruling: a confirmed task = working).
      if (typeof Channels !== 'undefined' && Channels.setStatus && Channels.runIdOf(ws.id)) Channels.setStatus(ws.id, 'working…');
      if (isActiveWs(ws)) syncStatus();
    }
    // turn to face the Commander and listen (no camera yank); a spoken CHAT also softly frames the agent.
    if (World.setActivityFor) World.setActivityFor(turnAgentId, 'talk'); else World.setActivity('talk');
    // A TASK ALWAYS WORKS AT THE WORKSTATION (Andrew's ruling, 2026-07-05, supersedes the reactive-only
    // rule): a turn the classifier reads as a task sends the agent to its desk IMMEDIATELY — even if the
    // model ends up answering without a tool. Pure chat still stays in place; walkToDesk stays idempotent
    // and still also fires on the first real tool call / permission prompt (covers a misclassified task).
    if (isTask) walkToDesk();
    if (!isTask && willSpeak && World.focusAgent) World.focusAgent({ soft: true });
    syncStatus();           // header reads the channel truth: 'connecting…' until the sidecar confirms the run
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
    let busyRefusal = null;   // race-time server mutex refusal: restore the directive instead of minting failed turns
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
      const { text: reply, error, endReason, finishReason } = await Harness.chat({
        system: sys, messages: historyWindow(ws), agentId: ws.agentId || 'agent', isTask, recurring, signal: ac.signal, streamId: ws.id,
        taskAction: taskAction || undefined,
        recipeId: recipeId || undefined,   // provenance spine: the launching recipe rides to the durable run row (undefined for non-recipe runs)
        projectRoot: ws.projectRoot || undefined,   // project-anchored session: the sidecar injects the folder context ONLY if the root is still a standing blessed grant (truthful)
        placed: (typeof World !== 'undefined' && World.heroCaps) ? World.heroCaps(ws.agentId || 'agent') : [],   // THE MOAT: this run's TOOL reach = the agent's REAL placed props (dish→web · cabinet→files · workbench→terminal · …); compute is the freebie
        stationPlaced: (typeof World !== 'undefined' && World.stationCaps) ? World.stationCaps() : [],   // Class Loadouts (shared-gear): station-wide gear for SKILL availability — a desk-only specialist still gets its class skills when the STATION has the gear (tools stay room-scoped via `placed`)
        onRunId: id => { thisRunId = id; runStartedAt = Date.now(); try { RUN_META.set(id, { isTask: !!isTask, title: (ws && ws.title) || '', directive: String(text || ''), fromRecipe: fromRecipe, recipeId: recipeId, agentId: ws.agentId || 'agent' }); if (RUN_META.size > 60) RUN_META.delete(RUN_META.keys().next().value); } catch (_) {} Channels.setRunId(ws.id, id, Date.now()); if (walkedToDesk && Channels.setStatus) Channels.setStatus(ws.id, 'working…'); if (isActiveWs(ws)) { syncStatus(); renderPresence(); } if (typeof Workstreams !== 'undefined') { Workstreams.appendRun(ws.id, id); if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } },
        onToken: d => { acc += d; Channels.appendToken(ws.id, d); if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.append(d); if (!isTask) World.say(acc); } if (willSpeak) pushSpeech(false); App.refreshUsage(); },
        onUsage: () => App.refreshUsage(),
        // COMMS-PREMIUM: the Channels store still records the pre-formatted STRING (replay/switch-survival is
        // unchanged — replayChannel renders those via toolLine), but the LIVE surface renders a structured CHIP.
        // breakLive() closes the prose paragraph AND the prior chip rail only when it's a *call after prose*; a
        // run of consecutive calls shares one rail because onToolResult below never breaks it.
        // NOTE (truthful telemetry, audit 0.4): this callback RENDERS only — it must NOT re-emit agent.tool_call.
        // harness.js already emits the AUTHORITATIVE agent.tool_call onto U.bus for EVERY hero tool step (the full
        // frozen shape { agentId, runId, callId, name, argsSummary }) before invoking this onToolCall. A synthetic
        // copy here double-counted worksignalstore's EWMA (recruiter signal) + printed duplicate ticker lines, and
        // its name-only `{ name }` variant was schema-invalid. The world/worksignal/quest listeners consume the
        // harness emit; this handler owns the transcript chips + desk walk + presence only.
        onToolCall: ev => { callNames[ev.callId] = ev.name; Channels.addToolCall(ws.id, { callId: ev.callId, name: ev.name, argsSummary: ev.argsSummary }); walkToDesk(); presenceToolCall(ws, ev.name); if (skillFlavor(ev)) recentInRunSkill = Date.now(); if (isActiveWs(ws)) { if (activeLiveRow && activeLiveRow.breakSeg) activeLiveRow.breakSeg(); toolChip(ev); } },
        // Re-emit the hero's tool RESULT onto U.bus so the world's per-prop capability surge fires on the REAL
        // outcome (the station SSE tee drops tool_result; the hero's interactive stream is the only place it's
        // seen). callId joins it to its tool_call; isError drives the success-vs-failure (green-vs-red) surge.
        onToolResult: ev => { if (!ev.isError) runToolsOk++; const nm = callNames[ev.callId] || 'tool'; Channels.addToolResult(ws.id, { callId: ev.callId, name: nm, summary: ev.summary, isError: ev.isError, ms: ev.ms }); presenceToolResult(ws); if (isActiveWs(ws)) resolveChip(ev, nm); if (typeof U !== 'undefined' && U.bus && ev.callId) U.bus.emit('agent.tool_result', { name: nm, agentId: ws.agentId, callId: ev.callId, ok: !ev.isError, isError: !!ev.isError }); },
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
            // POST-RUN DEDUPE: the recap card is the single artifact ledger. When the deliverable is ALREADY
            // visible in the on-screen transcript (inline row above + recap card below), the toast is a third
            // copy that also parks over the composer — suppress it. A BACKGROUND-stream deliverable isn't shown
            // anywhere on screen, so its toast is the only signal → keep it.
            if (!isActiveWs(ws) && typeof StationUI !== 'undefined') StationUI.notify((mk === 'file' ? 'saved ' : 'made ') + ev.title, 'gold', 'runComplete');   // P1-8 category: run produced a deliverable
          }
        },
        // EL-11: EVERY prompt now reaches a human surface — the active stream renders the inline consent card;
        // a background stream fires the global clickable toast + rail marker (backgroundPermissionNotify). Both
        // paths then ACK the sidecar (consentAck) that the prompt is human-visible, earning the paused run its
        // one bounded extension of the fail-closed auto-deny timer.
        onPermission: ev => { Channels.setPending(ws.id, { promptId: ev.promptId, tool: ev.tool, argsSummary: ev.argsSummary, runId: Channels.runIdOf(ws.id) }, Date.now()); walkToDesk(); if (isActiveWs(ws)) { breakLive(); permissionRow(ev, ws); renderPresence(); } else { backgroundPermissionNotify(ev, ws); } try { Harness.consentAck(Channels.runIdOf(ws.id), ev.promptId); } catch (_) {} },
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
        // A mutex race can still happen after the local preflight. The sidecar is authoritative, but this is an
        // availability state — not an assistant turn. Undo the optimistic user row, restore its directive to the
        // composer, and let the existing run remain the only durable conversation activity.
        if (v.kind === 'agent_busy') {
          busyRefusal = v.userMessage;
          if (!retry) {
            const last = ws.history[ws.history.length - 1];
            if (last && last.role === 'user' && last.content === text) ws.history.pop();
            if (isActiveWs(ws) && input) { input.value = text; autoGrowInput(); }
          }
        } else {
        // CRASH HONESTY: a network-kind failure on an in-flight run = the stream to the sidecar dropped (the
        // sidecar crashed / the app lost the connection). The run can't be resumed — the sidecar respawns fresh.
        // Flag this stream so that WHEN the sidecar is provably back (health probe on reconnect) we tell the
        // Commander their run was interrupted and must be restarted, instead of leaving a silent dead run.
        if (v.kind === 'network' && thisRunId) { interruptedStreams.add(ws.id); armReconnectWatch(); }
        persistPartial(ws, acc);
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.error(v.userMessage, v.raw); }
        ws.history.push({ role: 'assistant', content: '⚠ ' + v.userMessage, error: true, ts: Date.now() });   // so the failure survives a switch-back, not just a transient notify
        if (typeof StationUI !== 'undefined') StationUI.notify(brief(v.userMessage), 'warn');
        if (isActiveWs(ws)) resolvePresence(ws, { error: true });   // COMMS-PREMIUM: presence card resolves red
        if (isActiveWs(ws)) offerRetry(v);   // RETRY: context-aware recovery chip (retry / Settings / SKILLS / none)
        }
      } else {
        let replyText = reply || acc;
        const taskQuestion = (isTask && typeof TaskIntent !== 'undefined' && TaskIntent.parse) ? TaskIntent.parse(replyText) : null;
        if (taskQuestion) {
          if (thisRunId) {
            clarificationRuns.add(thisRunId);
            if (clarificationRuns.size > 60) clarificationRuns.delete(clarificationRuns.values().next().value);
          }
          replyText = TaskIntent.strip(replyText);
          if (isActiveWs(ws) && activeLiveRow && activeLiveRow.cleanTaskIntent) activeLiveRow.cleanTaskIntent();
        }
        finalReply = replyText;
        titleOk = !!replyText.trim();   // a real, non-empty reply landed → this stream is eligible for a summary title
        if (replyText.trim()) ws.history.push({ role: 'assistant', content: replyText, ts: Date.now() });   // never persist an empty turn
        // Lane 5 (truthful telemetry): a reply the PROVIDER cut off — finishReason 'length' (hit max_tokens
        // mid-thought) or 'content_filter' (output filtered) — is an AMPUTATED turn even though endReason==='done'.
        // It must NOT ship a "◈ delivered" crate / XP / workitem.delivered as if it were complete. Treat it like a
        // non-clean stop for the delivery decision (but keep the partial text above — it's real, just incomplete).
        const cutShort = finishReason === 'length' || finishReason === 'content_filter';
        // GOAL LOOP: a clean turn (done / no endReason) with a real reply is judgeable. A max_iters/budget/refusal
        // stop — or a provider-truncated reply — is NOT — the agent didn't get to finish its thought, so re-judging
        // would be premature. The judge runs in the finally (after teardown) so it never delays this turn's unwind.
        if (!taskQuestion && (!endReason || endReason === 'done') && !cutShort && replyText.trim() && typeof GoalLoop !== 'undefined' && goalOf(ws)) goalJudgeReply = replyText;
        // the stop-reason is part of the WORK log → close the live paragraph, then drop it in chronologically.
        if (endReason && endReason !== 'done' && !taskQuestion) {
          if (isActiveWs(ws)) breakLive(), toolLine('⏹ ' + (endReason === 'max_iters' ? 'reached the step limit — say "continue" to keep going'
            : endReason === 'budget' ? 'reached this run\'s limit'
            : endReason === 'cancelled' ? (interrupted.has(ws.id) ? 'stopped' : 'run cancelled')
            : 'stopped (' + endReason + ')'));
          markStoppedTurn(ws, replyText);
          if (isActiveWs(ws)) offerTryAgain();
          if (typeof StationUI !== 'undefined') StationUI.notify('run stopped: ' + endReason, 'warn');
        } else if (cutShort) {
          // distinct honest "cut short" recap: the reply is truncated/filtered, not a clean delivery.
          if (isActiveWs(ws)) breakLive(), toolLine('⏹ ' + (finishReason === 'content_filter'
            ? 'reply cut short — the model\'s output was filtered'
            : 'reply cut short — hit the response length limit; say "continue" for the rest'));
          if (typeof StationUI !== 'undefined') StationUI.notify('reply cut short: ' + finishReason, 'warn');
        }
        if (isActiveWs(ws) && activeLiveRow) activeLiveRow.done();
        if (isActiveWs(ws) && taskQuestion) presentTaskQuestion(ws, taskQuestion);   // enriches with the stored recommendation, then renders
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
        if (wiPlaced && !taskQuestion && (!endReason || endReason === 'done') && !cutShort) wiEmit('workitem.delivered', { workitemId: wiId, finalQueueId: 'outbox', agentId: wiAid, box: '', ms: Date.now() - wiPlacedTs, ts: Date.now() });
        // stash this run's REAL work so the post-run "rate the work" beat can size the XP honestly + gate on real work.
        // Lane 5: a cut-short run (provider truncated/filtered) is NOT rateable work — leaving no runWork stash makes
        // maybeStandaloneRate return 'never', so no XP is ever minted for an amputated reply. runCost is still computed
        // for the honest presence/recap readout.
        let runCost = 0;
        if (thisRunId) { runCost = Math.max(0, (Harness.totals().cost || 0) - (before.cost || 0)); if (!cutShort && !taskQuestion) { runWork.set(thisRunId, { toolsOk: runToolsOk, delivered: runDeliv, cost: runCost, agentId: ws.agentId || 'agent' }); if (runWork.size > 60) runWork.delete(runWork.keys().next().value); } }
        // P3.2 — CLAIM this lead run's dispatched crew (workers whose forwarded run.end fell inside its live window)
        // so a 👍 verdict can split its XP mint honestly. A run that dispatched no crew records nothing (empty list),
        // and the split falls back to lead-only — no fabricated attribution. Only a HERO lead run has crew to claim.
        if (thisRunId && (ws.agentId || 'agent') === 'agent') { const crew = claimCrew(runStartedAt); if (crew.length) { runCrew.set(thisRunId, crew); if (runCrew.size > 60) runCrew.delete(runCrew.keys().next().value); } }
        // COMMS-PREMIUM: resolve the presence card into a compact summary. steps = real successful tool rounds,
        // cost = this run's REAL usd delta — both truthful (shown only when > 0), never fabricated.
        if (isActiveWs(ws)) resolvePresence(ws, { endReason: taskQuestion ? 'done' : endReason, cutShort: cutShort, steps: runToolsOk, cost: runCost });
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
        markStoppedTurn(ws, acc);
        if (isActiveWs(ws)) offerTryAgain();
        if (!isTask && isActiveWs(ws) && acc.trim()) World.say(acc);
      } else {
        // A throw that is NOT a deliberate Stop: an unexpected disconnect (the reader aborted with no Stop) or a
        // hard fetch/network error. An unexpected abort here means the connection dropped — classify it as a
        // network fault (NOT a user cancel) so it reads "can't reach the sidecar" and still offers a retry.
        const v = (typeof Friendly !== 'undefined')
          ? Friendly.friendlyError(aborted ? new Error('cannot reach the STARNET sidecar — connection dropped') : e)
          : { userMessage: aborted ? 'Lost the connection — try again.' : (e.message || String(e)), retryable: true, action: null, raw: (e && e.message) || String(e) };
        persistPartial(ws, acc);
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.error(v.userMessage, v.raw); resolvePresence(ws, { error: true }); }
        ws.history.push({ role: 'assistant', content: '⚠ ' + v.userMessage, error: true, ts: Date.now() });   // keep a readable trace of the failure
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
      if (wiPlaced) { const depth = wiBump(wiAid, -1); wiEmit('queue.status', { queueId: wiAid, depth: depth, maxCapacity: 64, nextAdvanceAt: 0 }); }
      if (isActiveWs(ws)) {
        activeLiveRow = null;
        if (busyRefusal) { load(ws); renderAgentBusy(busyPeerFor(ws), busyRefusal); }
        else syncStatus();
      }
      // after a turn: in a hands-free voice conversation keep him facing you (one-on-one, no wandering off
      // between turns); otherwise he stands up and goes back to idle. Only steer the world if THIS finished
      // stream is the one on screen — a background stream finishing must not move the view.
      const stayFacing = typeof Voice !== 'undefined' && Voice.inVoiceMode && Voice.inVoiceMode();
      // OVERLAP GUARD (the black-screen fix): this stream's run is over, but the SAME agent may still be
      // working another live run (a scheduled routine, a channel run, another workstream). Extinguishing the
      // pose then darkens the workstation screens of an agent that is provably still working. dropRun retires
      // THIS run from World's refcount (idempotent — the bus run.end usually already did; an aborted stream's
      // run.end was LOST so this is its cleanup) and the pose is only released when NO run remains live.
      const othersLive = (World.dropRun && World.agentRunsLive)
        ? (World.dropRun(ws.agentId || 'agent', thisRunId), World.agentRunsLive(ws.agentId || 'agent') > 0) : false;
      // a summoned crew body extinguishes the moment its LAST live run ends — even if it finished off-screen
      // (a background crew run must stop "working").
      if ((ws.agentId || 'agent') !== 'agent') { if (!othersLive && World.setActivityFor) World.setActivityFor(ws.agentId, 'idle'); }
      else if (othersLive) { /* the hero is still mid-run elsewhere — leave the working pose alone (work wins) */ }
      else {
        // HERO: split the two concerns the old single gate conflated. (1) POSE — a hero run that finished in a
        // BACKGROUND workstream must ALSO stop "working" (the tick tears it out of the desk pose the instant
        // activity flips off 'task'); setActivity('idle') does that WITHOUT touching the camera. (2) VIEW — only
        // steer the world (voice-facing talk pose + soft focus) when THIS finished stream is the one on screen,
        // so a background run finishing never moves the camera. (Lane 5 truth-run-lifecycle: was gated entirely on
        // isActiveWs, leaving a background hero run stuck in the working pose forever.)
        if (isActiveWs(ws)) { World.setActivity(stayFacing ? 'talk' : 'idle'); if (stayFacing && World.focusAgent) World.focusAgent({ soft: true }); }
        else World.setActivity('idle');
      }
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
    if (input) input.placeholder = 'speak to your agent… ( / for commands )';
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
      const b = document.createElement('button'); b.className = 'choice' + (it.quiet ? ' quiet' : '') + (it.suggested ? ' suggested' : ''); b.textContent = it.label;   // .quiet = subdued secondary chip; .suggested = the task brief's host-validated recommended default (gold)
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

  return { init, load, send, status, localLine, broadcast, setSystem, getHistory, abort, isBusy, beatBusy: skillBeatBusy, beginInterview, endInterview, echoUser, prefill, autoGrowInput, choices, clearChoices, typeLine, nudge, clearNudge, offerCuriosity, offerFork, briefingReceipt, runMeta, runDidWork, awayDigest, awayReview, awayRate, workshopReturn, refreshIdBar: renderIdBar, setRosterStatus };
})();
