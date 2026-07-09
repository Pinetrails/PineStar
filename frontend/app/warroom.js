/* STARNET — warroom.js : the LIVING WAR-ROOM visible layer.

   Implements the war-room concept ON the real app, on top of the per-agent Channels gate:
     · an always-visible APPROVAL HOTSPOT pinned above COMMS — tool-consent can never scroll off
       (read live from Channels' pending consent; the buttons resolve the REAL run via Harness.consent),
     · CREW instrument-cluster dots that pulse with real per-agent activity,
     · a CINEMA toggle (C / on-feed button) that fills the frame with the living station.

   Self-contained: it builds its own DOM into the existing HUD and reads real state — it edits no other
   module, so it cannot break the harness. Everything is guarded; a missing dependency just no-ops. */
'use strict';
(function () {
  if (typeof document === 'undefined') return;
  const $ = s => document.querySelector(s);
  // Delegates to the one complete implementation. The old local copy missed ' (apostrophe) — U.esc escapes
  // all of & < > " ', so a name/argsSummary carrying an apostrophe can't break a single-quoted attribute.
  const esc = s => U.esc(s == null ? '' : s);
  const sfx = n => { try { if (typeof SFX === 'object' && SFX[n]) SFX[n](); } catch (_) {} };

  /* ---------------- APPROVAL HOTSPOT (pinned above COMMS) ---------------- */
  let lastKey = null;   // wsId:promptId of the rendered consent, so we only rebuild on a real change
  function buildHotspot() {
    const panel = $('#chat-panel'), log = $('#chat-log');
    if (!panel || !log || $('#wr-approval')) return;
    const h = document.createElement('section'); h.id = 'wr-approval'; h.className = 'calm';
    h.innerHTML = calmHTML();
    panel.insertBefore(h, log);
  }
  function calmHTML() {
    return '<div class="wrah-hdr"><span>▮ APPROVALS</span><span></span></div>' +
      '<div class="wrah-body">no pending approvals — the agent is cleared to act within policy.</div>';
  }
  function currentPending() {
    if (typeof Channels === 'undefined') return null;
    try {
      const ids = Channels.pendingIds(); if (!ids || !ids.length) return null;
      const wsId = ids[0]; const p = Channels.pendingOf(wsId);
      return p ? { wsId: wsId, p: p } : null;
    } catch (_) { return null; }
  }
  function actionPhrase(p) {
    const t = p.tool || 'act';
    if (/notebook/.test(t)) return 'save a note to its memory';
    if (/write|append|edit/.test(t)) return 'write <span class="wrah-args">' + esc(p.argsSummary || 'a file') + '</span>';
    return esc(t.replace(/_/g, '.')) + (p.argsSummary ? ' <span class="wrah-args">' + esc(p.argsSummary) + '</span>' : '');
  }
  function tickHotspot() {
    const h = $('#wr-approval'); if (!h) return;
    const cur = currentPending();
    const key = cur ? (cur.wsId + ':' + cur.p.promptId) : null;
    if (key === lastKey) return;
    lastKey = key;
    if (!cur) { h.className = 'calm'; h.innerHTML = calmHTML(); return; }
    const name = ($('#gt-agent') && $('#gt-agent').textContent.trim()) || 'the agent';
    h.className = 'pending';
    h.innerHTML =
      '<div class="wrah-hdr"><span>▣ APPROVAL REQUIRED</span><span>1 PENDING</span></div>' +
      '<div class="wrah-who"><b>' + esc(name) + '</b> wants to ' + actionPhrase(cur.p) + '</div>' +
      '<div class="wrah-btns">' +
      '<button class="wrah-btn" data-d="once">Approve once</button>' +
      '<button class="wrah-btn" data-d="always">Always</button>' +
      '<button class="wrah-btn danger" data-d="full">Full access</button>' +
      '<button class="wrah-btn deny" data-d="deny">Deny</button>' +
      '</div>';
    const p = cur.p, wsId = cur.wsId;
    h.querySelectorAll('.wrah-btn').forEach(b => b.addEventListener('click', () => {
      const decision = b.dataset.d, isDeny = decision === 'deny';
      try { if (typeof Harness !== 'undefined' && Harness.consent) Harness.consent(p.runId, p.promptId, decision); } catch (_) {}
      try { if (typeof Channels !== 'undefined') Channels.clearPending(wsId); } catch (_) {}
      sfx(isDeny ? 'close' : 'click');
      h.className = 'calm';
      h.innerHTML = '<div class="wrah-hdr"><span>▮ APPROVALS</span><span></span></div>' +
        '<div class="wrah-done' + (isDeny ? ' deny' : '') + '">' + (isDeny ? '✕ denied' : '✓ ' + decision) + '</div>';
      lastKey = '__resolved__';   // hold the result until the next genuine state change
    }));
    sfx('alarm');   // the distinct "needs you" cue
  }

  /* ---------------- CREW instrument-cluster pulse (real activity) ---------------- */
  // EL-11 FIX 1b: which AGENTS actually own a pending consent — resolved per workstream via Channels →
  // Workstreams binding. The old global flip lit EVERY crew dot wr-await for ONE agent's prompt (untruthful
  // telemetry: N-1 of those dots asserted a state their agent wasn't in), and being unlabeled it was the ONLY
  // trace a background session's prompt left on screen.
  function pendingAgentIds() {
    const out = new Set();
    if (typeof Channels === 'undefined') return out;
    try {
      for (const wsId of Channels.pendingIds()) {
        const w = (typeof Workstreams !== 'undefined' && Workstreams.get) ? Workstreams.get(wsId) : null;
        out.add((w && w.agentId) || 'agent');
      }
    } catch (_) {}
    return out;
  }
  function tickCrew() {
    const rows = document.querySelectorAll('#crew .crew-row'); if (!rows.length) return;
    // AWAIT is per-agent truth: only the agent(s) whose own workstream holds the pending consent flip —
    // every other dot keeps reflecting ITS OWN agent's live run (read per-agent from StationUI).
    const pendingAgents = pendingAgentIds();
    // work-vs-think flavour comes from the hero status line — only meaningful for the common single-agent station.
    const thinking = (($('#chat-status') || {}).textContent || '').toLowerCase().indexOf('think') >= 0;
    for (const row of rows) {
      const d = row.querySelector('.dot'); if (!d) continue;
      // this tick runs ~3x/sec for the app's lifetime, so keep it cheap: read the agent id straight off the
      // row (StationUI stamps data-agent-id) instead of a second querySelector + string slice, and only touch
      // the DOM when the class actually changes (no redundant style invalidation every tick).
      const id = row.dataset.agentId || '';
      let cls = 'wr-idle';
      if (pendingAgents.has(id)) cls = 'wr-await';
      else if (id && isAgentRunning(id)) cls = thinking ? 'wr-think' : 'wr-work';
      const next = 'dot on ' + cls;
      if (d.className !== next) d.className = next;
    }
  }
  // authoritative per-agent run state — the SAME self-healing map the crew LIST reads (StationUI's runningAgents,
  // fed by real agent.run.start/end), never the global hero status string. Each crew dot lights for ITS OWN live run.
  function isAgentRunning(id) {
    try { return !!(typeof StationUI !== 'undefined' && StationUI.isAgentRunning && StationUI.isAgentRunning(id)); } catch (_) { return false; }
  }

  /* ---------------- CINEMA mode ---------------- */
  function buildCinema() {
    const hud = $('#stage-wrap .cam-hud');
    if (hud && !hud.querySelector('.cam-cine')) {
      const b = document.createElement('button');
      b.className = 'cam-cine'; b.textContent = '▣ CINEMA'; b.title = 'fill the frame with the station (C)';
      b.addEventListener('click', toggleCinema); hud.appendChild(b);
    }
    if (!$('#wr-cine-hint')) {
      const hint = document.createElement('div'); hint.id = 'wr-cine-hint'; hint.textContent = 'CINEMA — press C to exit';
      document.body.appendChild(hint);
    }
  }
  function toggleCinema() {
    const g = $('#screen-game'); if (!g || !g.classList.contains('active')) return;
    const on = g.classList.toggle('cinema');
    const hint = $('#wr-cine-hint'); if (hint) hint.style.display = on ? 'block' : 'none';
    const b = $('.cam-cine'); if (b) b.textContent = on ? '▣ EXIT' : '▣ CINEMA';
    sfx('click');
  }
  window.addEventListener('keydown', e => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'c' || e.key === 'C') toggleCinema();
  });

  /* ---------------- boot + tick ---------------- */
  function boot() {
    // NOTE: the old top APPROVALS hotspot is gone — approvals now render INLINE at the bottom of COMMS
    // (chat.js permissionRow), classic-harness style, in the conversation flow where the agent paused.
    buildCinema();
    tick(); setInterval(tick, 300);
  }
  function tick() { try { tickCrew(); } catch (_) {} }
  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
