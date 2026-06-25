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
  const proposalRunsSeen = new Set();   // runIds already turned into a beat (memory.proposed fires once per proposal)
  const el = id => document.getElementById(id);
  let stick = true;   // STICKY-BOTTOM: auto-scroll only fires when the Commander is already at/near the bottom,
                      // so scrolling UP to re-read history mid-stream isn't yanked back down by every token.
  function nearBottom() { return !log || (log.scrollHeight - log.scrollTop - log.clientHeight < 40); }
  function autoscroll() { if (stick && log) log.scrollTop = log.scrollHeight; }

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
    proposalRunsSeen.clear(); wiQDepth.clear(); queued.clear(); interrupted.clear();   // C2: per-session run-tracking + the queue gauge + turn-control state start clean for each agent (listeners stay once-registered)
    log = el('chat-log'); input = el('chat-input'); statusEl = el('chat-status');
    if (log) log.addEventListener('scroll', () => { stick = nearBottom(); });   // track whether the user is following the bottom
    // COPY: one delegated click handler for every (current + future) message row's ⧉ button — copies the
    // row's prose, then flashes a ✓ confirm. Wired once per log element so a re-init can't stack handlers.
    if (log && !log.__copyWired) {
      log.__copyWired = true;
      log.addEventListener('click', e => {
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
    warmSlashCatalog();
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
    // typing targets the displayed stream (war-room D2: the compose target is decoupled from any camera jump)
    if (activeWs && typeof Channels !== 'undefined') Channels.setComposeTarget(activeWs.id);
    if (log) log.innerHTML = '';
    stick = true;   // a freshly-loaded / switched-to stream starts pinned to its latest line
    renderHistory();
    replayChannel();   // re-render an in-flight stream we left running: tool lines / partial reply / pending approval
    syncStatus();      // also paints the Stop control + this stream's queued pills (updateControls)
    maybeEmptyState();   // brand-new / empty + idle stream → a one-line hint instead of a blank void
    if (activeWs) flushQueued(activeWs.id);   // returned to an idle stream that has a queued follow-up → send it now
  }

  function setSystem(s) { system = s; }
  function getHistory() { return activeWs ? activeWs.history.slice() : []; }
  function isBusy() { return !!(activeWs && typeof Channels !== 'undefined' && Channels.isBusy(activeWs.id)); }
  function isActiveWs(ws) { return !!(ws && activeWs && activeWs.id === ws.id); }   // is THIS stream the one on screen right now?
  function status(s) { if (statusEl) statusEl.textContent = s; }
  // derive the DISPLAYED stream's status from real state, so a low-priority write (a finishing turn) can't
  // clobber the high-priority 'awaiting your approval…' after a switch-back. One source of truth.
  function syncStatus() {
    if (interview) { status('waking…'); stopElapsedTimer(); return; }
    const p = (activeWs && typeof Channels !== 'undefined') ? Channels.pendingOf(activeWs.id) : null;
    status(p ? 'awaiting your approval…' : (isBusy() ? 'working…' : 'online'));
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
    const who = document.createElement('span'); who.className = 'who';
    who.textContent = role === 'user' ? 'COMMANDER' : name;
    const body = document.createElement('span'); body.className = 'body';
    d.appendChild(who); d.appendChild(body);
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
  // an image the agent generated (image_generate / the `studio` capability) — render it INLINE as a small
  // thumbnail (src = the sidecar's jailed /api/file viewer URL, served with an image content-type); clicking
  // opens the full image in a new tab. Built with DOM nodes (never innerHTML) so the title can't inject markup.
  function imageDeliverableLine(title, agentId) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('deliverable'); r.d.classList.add('image');
    const url = '/api/file?agent=' + encodeURIComponent(agentId || 'agent') + '&path=' + encodeURIComponent(title);
    r.body.appendChild(document.createTextNode('▤ made '));
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    a.className = 'deliverable-thumb';
    a.title = title;                                               // full path on hover
    const img = document.createElement('img');
    img.src = url; img.loading = 'lazy';
    img.alt = String(title).split(/[\\/]/).pop() || title;
    a.appendChild(img);
    r.body.appendChild(a);
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
    return '/api/file?agent=' + encodeURIComponent(agentId || 'agent') + '&path=' + encodeURIComponent(title);
  }
  // append a small "open in a new tab" fallback link — shown when an inline player can't decode the file
  // (e.g. an .mkv/.avi the browser won't play), mirroring Hermes's OpenMediaButton.
  function openFallback(parent, label, url, title) {
    if (parent.querySelector('.media-fallback')) return;   // once
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.className = 'deliverable-link media-fallback';
    a.textContent = label; a.title = title;
    parent.appendChild(a);
  }
  // a media deliverable rendered INLINE as a seekable player. The src is the jailed /api/file route, which
  // now streams with HTTP Range so <video>/<audio> can seek without loading the whole file. preload=metadata
  // fetches just enough for a duration + scrubber. On a decode error we drop in an open-externally link.
  function mediaPlayerLine(title, agentId, kind) {
    const r = row('agent'); r.d.classList.add('tool'); r.d.classList.add('deliverable'); r.d.classList.add(kind);
    const url = fileUrl(title, agentId);
    const name = String(title).split(/[\\/]/).pop() || title;
    r.body.appendChild(document.createTextNode('▤ made '));
    const cap = document.createElement('span'); cap.className = 'media-name'; cap.textContent = name; cap.title = title;
    r.body.appendChild(cap);
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.controls = true; el.preload = 'metadata'; el.src = url; el.className = 'deliverable-' + kind;
    el.addEventListener('error', () => openFallback(r.body, 'open ' + kind + ' ↗', url, title), { once: true });
    r.body.appendChild(el);
    autoscroll();
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
    r.body.appendChild(document.createTextNode('🔒 ' + name + ' wants to ' + actionPhrase(p) + ' '));
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

  // Cortex (M-mem.5b) — THE TURN-IN BEAT. After a run, reflection proposes durable memories; the Commander
  // decides Keep / Edit / Discard. Keep/Edit commit a real memory (the click IS the consent, §5.6); every
  // verdict feeds the agent's confidence. This is the gamified formation loop — the agent learns, you approve.
  function proposalCard(batch, ws) {
    if (!batch || !batch.proposals || !batch.proposals.length) return;
    clearNudge();   // ONE post-run beat at a time: the turn-in owns the moment, so retire any curiosity nudge that beat it here
    const head = row('agent'); head.d.classList.add('tool'); head.d.classList.add('turnin');
    const n = batch.proposals.length;
    head.body.appendChild(document.createTextNode('🧠 ' + name + ' picked up ' + n + (n > 1 ? ' things' : ' thing') + ' worth remembering — keep ' + (n > 1 ? 'them' : 'it') + '?'));

    let remaining = n;
    // a card is settled → it fades out; when the last one goes, the whole header retires with it (no empty husk).
    function onItemGone() { if (--remaining <= 0) vanish(head.d); }

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
        setTimeout(() => vanish(item, onItemGone), 600);   // flash the verdict, then the card retires for good — vanish entirely
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
  // retire the live curiosity nudge (its prompt row AND its choice chips) — called when it's answered or when a
  // turn-in beat supersedes it. Both halves fade out together so no orphan chip row is left behind.
  function clearNudge() {
    if (!activeNudge) return;
    const a = activeNudge; activeNudge = null;
    vanish(a.choiceRow); vanish(a.row);
  }
  function curiosityNudge(dim) {
    if (!log) return;
    const r = row('agent'); r.d.classList.add('nudge');   // a quiet aside, NOT the lit headline (.reply) — it was reading as a 2nd reply
    r.body.textContent = '✦ one curious thing — i still don’t know your ' + dimLabel(dim).toLowerCase() + '. want to tell me? it sharpens how every agent here works for you.';
    autoscroll();
    const choiceRow = choices([{ label: 'sure — ask me', value: 'yes' }, { label: 'not now', value: 'no', skip: true }], item => {
      activeNudge = null;   // answered → release the post-run beat slot (the choice row removes itself)
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
    activeNudge = { row: r.d, choiceRow: choiceRow, dim: dim };   // track both halves so a turn-in can retire the whole nudge
  }
  function wireCuriosity() {
    if (curiosityWired || typeof U === 'undefined' || !U.bus) return;
    curiosityWired = true;
    U.bus.on('agent.run.end', p => {
      if (!p || p.reason !== 'done') return;   // only after a clean, successful run — never nag after a stop/limit/error
      const runId = p.runId || p.id;
      setTimeout(() => {
        if (isBusy() || interview) return;     // another run started, or we're already mid-interview/awakening
        if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return;
        if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return;
        // ONE post-run beat per run: if this run produced a memory turn-in (or a card is still open in the
        // feed), let the turn-in own the moment — don't stack a curiosity nudge under it (the visible dogpile).
        if (runId && proposalRunsSeen.has(runId)) return;
        if (log && log.querySelector('.turnin-item')) return;
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
      const r = row('agent');   // past turns render as plain GROUPED messages; only the LIVE reply is the lit headline
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
      seg = row('agent'); raw = '';
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
      error(m) { if (!seg) open(); seg.d.classList.add('err'); raw += (raw ? '\n' : '') + '⚠ ' + m; renderProse(seg.body, raw); if (caret) { caret.remove(); caret = null; } seg = null; raw = ''; }
    };
  }
  // close the live paragraph (if any) so the action about to render lands BELOW the prose, in order
  function breakLive() { if (activeLiveRow && activeLiveRow.breakSeg) activeLiveRow.breakSeg(); }

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
  // a one-tap "↻ retry" chip dropped under a failed turn (reuses the suggestion-pill row, which self-removes on tap).
  function offerRetry() { if (log) choices([{ label: '↻ retry', value: 'retry' }], () => retryLast()); }

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
  let slashServerCommands = null, slashCatalogLoading = false, slashCatalogLoaded = false;
  const FALLBACK_SLASH_COMMANDS = Object.freeze([
    Object.freeze({ name: 'retry', desc: 're-run the last turn', action: 'retry' }),
    Object.freeze({ name: 'stop', desc: 'interrupt the running turn', action: 'stop' }),
    Object.freeze({ name: 'copy', desc: "copy the agent's last reply", action: 'copy' }),
    Object.freeze({ name: 'help', desc: 'list available commands', action: 'help' })
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
  function localSlashActions() {
    return { retry: retryLast, stop: stopActive, copy: copyLastReply, help: showHelp };
  }
  function showHelp() {
    const builtins = buildCommands().filter(c => c.source !== 'recipe').map(c => '/' + c.name);
    const recipes = buildCommands().filter(c => c.source === 'recipe').length;
    localLine('Commands - ' + builtins.slice(0, 8).join(', ') + (recipes ? ', plus ' + recipes + ' recipe commands.' : '.') + ' Type "/" to browse.');
  }
  function warmSlashCatalog() {
    if (slashCatalogLoaded || slashCatalogLoading || typeof fetch === 'undefined') return;
    slashCatalogLoading = true;
    fetch('/api/slash/catalog', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        slashServerCommands = (j && Array.isArray(j.commands)) ? j.commands : null;
        slashCatalogLoaded = true;
      })
      .catch(() => { slashServerCommands = null; slashCatalogLoaded = true; })
      .then(() => {
        slashCatalogLoading = false;
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
      source: source || c.source || 'server',
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
  function applySlashDirective(directive) {
    if (!directive || directive.type !== 'client') return false;
    const fn = localSlashActions()[directive.action];
    if (!fn) return false;
    fn(directive.args || '');
    return true;
  }
  async function dispatchSlash(item) {
    try {
      const r = await fetch('/api/slash/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '/' + item.name })
      });
      const j = await r.json().catch(() => null);
      return !!(r.ok && j && j.ok && applySlashDirective(j.directive));
    } catch (_) { return false; }
  }
  async function runSlash(item) {
    if (!item) { closeSlash(); return; }
    input.value = ''; closeSlash();   // consume the "/query"; a recipe's run() then refills the input
    if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
    if (item.serverBacked && await dispatchSlash(item)) return;
    try { item.run(); } catch (_) {}
  }

  async function send(text, opts) {
    const retry = !!(opts && opts.retry);   // RETRY re-runs the last user message (already in the thread) — don't echo it again
    if (interview) { interview(text); return; }   // THE AWAKENING owns the input: route the answer to onboarding, no model call
    const ws = activeWs;   // CAPTURE the origin stream now — a mid-run switch must not cross-post its cost/files
    if (!ws) return;
    if (Channels.isBusy(ws.id)) return;   // one run per stream — but OTHER streams may be running concurrently
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
    if (isTask && typeof ProfileStore !== 'undefined') ProfileStore.observeMessage(text);
    if (isTask && typeof MintStore !== 'undefined') MintStore.observe(text);   // notice recurring jobs → propose minting them as one-tap missions
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
      if (isActiveWs(ws)) status('working…');
    }
    // turn to face the Commander and listen (no camera yank); a spoken CHAT also softly frames the agent.
    if (World.setActivityFor) World.setActivityFor(turnAgentId, 'talk'); else World.setActivity('talk');
    if (!isTask && willSpeak && World.focusAgent) World.focusAgent({ soft: true });
    status('thinking…');
    ensureElapsedTimer();   // start the live wall-clock the instant the turn begins (before the first token)
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
        placed: (typeof World !== 'undefined' && World.heroCaps) ? World.heroCaps(ws.agentId || 'agent') : [],   // THE MOAT: this run's reach = the agent's REAL placed props (dish→web · cabinet→files · workbench→terminal · …); compute is the freebie
        onRunId: id => { Channels.setRunId(ws.id, id); if (typeof Workstreams !== 'undefined') { Workstreams.appendRun(ws.id, id); if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } },
        onToken: d => { acc += d; Channels.appendToken(ws.id, d); if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.append(d); if (!isTask) World.say(acc); } if (willSpeak) pushSpeech(false); App.refreshUsage(); },
        onUsage: () => App.refreshUsage(),
        onToolCall: ev => { callNames[ev.callId] = ev.name; const t = '▶ ' + ev.name + ' ' + brief(ev.argsSummary); Channels.addTool(ws.id, t, false); walkToDesk(); if (isActiveWs(ws)) { breakLive(); toolLine(t); } if (typeof U !== 'undefined' && U.bus && ev.name && ev.name.indexOf('mcp__') === 0) U.bus.emit('agent.tool_call', { name: ev.name }); },
        onToolResult: ev => { const nm = callNames[ev.callId] || 'tool'; const t = (ev.isError ? '✕ ' : '◀ ') + nm + ' · ' + brief(ev.summary || (ev.isError ? 'error' : 'ok')) + (ev.isError ? ' — failed' : '') + (ev.ms ? ' (' + fmtMs(ev.ms) + ')' : ''); Channels.addTool(ws.id, t, ev.isError); if (isActiveWs(ws)) { breakLive(); toolLine(t, ev.isError); } },
        onDeliverable: ev => {
          // Any produced file is an openable product (image_generate emits kind:'image', fs.write emits
          // kind:'file'). How we RENDER it is decided client-side from the EXTENSION (the Hermes model), not
          // from the backend's kind — so a .mp4/.webm the agent writes becomes an inline player and a .png a
          // thumbnail, with no backend change. Unknown extensions fall back to the plain clickable row.
          if ((ev.kind === 'file' || ev.kind === 'image') && !seenDeliv[ev.title]) {
            seenDeliv[ev.title] = true;
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
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.error(error); if (!isTask) World.say('…' + (error.length > 40 ? error.slice(0, 40) + '…' : error)); }
        ws.history.push({ role: 'assistant', content: '⚠ ' + error, error: true });   // so the failure survives a switch-back, not just a transient notify
        if (typeof StationUI !== 'undefined') StationUI.notify('run error: ' + brief(error), 'warn');
        if (isActiveWs(ws)) offerRetry();   // RETRY: one tap re-runs the failed turn
      } else {
        const replyText = reply || acc;
        finalReply = replyText;
        if (replyText.trim()) ws.history.push({ role: 'assistant', content: replyText });   // never persist an empty turn
        // the stop-reason is part of the WORK log → close the live paragraph, then drop it in chronologically.
        if (endReason && endReason !== 'done') {
          if (isActiveWs(ws)) breakLive(), toolLine('⏹ ' + (endReason === 'max_iters' ? 'reached the step limit — say "continue" to keep going'
            : endReason === 'budget' ? 'reached this run\'s cost limit'
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
        // error/refusal stop is wasted spend (the agent.run.end SLAG path owns that); abort/hard-error never
        // reach this branch. (Not gated on isActiveWs: a background stream's work still ships.)
        if (!endReason || endReason === 'done') wiEmit('workitem.delivered', { workitemId: wiId, finalQueueId: 'outbox', agentId: wiAid, box: '', ms: Date.now() - wiPlacedTs, ts: Date.now() });
      }
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));
      const stopped = interrupted.has(ws.id);   // the Commander pressed Stop on THIS stream — a graceful interrupt, not a fault
      if (stopped) {
        // keep whatever already streamed, mark it stopped, and log NO error (the stop was intentional).
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.done(); toolLine('⏹ stopped'); }
        if (acc.trim()) ws.history.push({ role: 'assistant', content: acc });   // the partial reply survives a switch
        if (!isTask && isActiveWs(ws) && acc.trim()) World.say(acc);
      } else {
        if (isActiveWs(ws)) { if (activeLiveRow) activeLiveRow.error(aborted ? '— disconnected —' : (e.message || String(e))); if (!isTask && !aborted) World.say('…connection trouble…'); }
        if (!aborted) ws.history.push({ role: 'assistant', content: '⚠ ' + (e.message || String(e)), error: true });   // keep a trace; skip on deliberate teardown
        if (isActiveWs(ws) && !aborted) offerRetry();   // RETRY: a network/connection failure (not a deliberate teardown) gets a re-run chip
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
      // flush any trailing spoken text and CLOSE the speech stream — the last chunk's end re-arms the
      // hands-free mic (this is the heartbeat for spoken turns; onTurnEnd covers silent/no-speech turns).
      if (willSpeak && typeof Voice !== 'undefined' && Voice.endReply) { pushSpeech(true, finalReply); Voice.endReply(); }
      // hands-free voice mode: the run is done — let Voice re-open the mic for the next turn.
      if (typeof Voice !== 'undefined' && Voice.onTurnEnd) Voice.onTurnEnd();
      // TYPE-AHEAD: the stream just freed — send its next queued follow-up (after this call fully unwinds).
      setTimeout(() => flushQueued(ws.id), 0);
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

  return { init, load, send, status, localLine, setSystem, getHistory, abort, isBusy, beginInterview, endInterview, echoUser, prefill, choices, typeLine };
})();
