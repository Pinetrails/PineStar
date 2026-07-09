/* STARNET — warroom.js : the LIVING WAR-ROOM visible layer.

   Implements the war-room concept ON the real app, on top of the per-agent Channels gate:
     · CREW instrument-cluster dots that pulse with real per-agent activity (and glow AWAIT on a pending consent),
     · a CINEMA toggle (C / on-feed button) that fills the frame with the living station.
   (The old pinned-above-COMMS APPROVAL HOTSPOT is gone — tool-consent now renders INLINE at the bottom of COMMS,
   classic-harness style, in the conversation flow where the agent paused, via chat.js permissionRow.)

   Self-contained: it builds its own DOM into the existing HUD and reads real state — it edits no other
   module, so it cannot break the harness. Everything is guarded; a missing dependency just no-ops. */
'use strict';
(function () {
  if (typeof document === 'undefined') return;
  const $ = s => document.querySelector(s);
  const sfx = n => { try { if (typeof SFX === 'object' && SFX[n]) SFX[n](); } catch (_) {} };

  /* ---------------- pending-consent probe (feeds the CREW AWAIT state) ---------------- */
  // A pending consent blocks the WHOLE station, so tickCrew lights every dot AWAIT while one is open. Returns the
  // first pending {wsId, p} or null. (The old top APPROVAL HOTSPOT that also consumed this is gone; approvals now
  // render inline in COMMS via chat.js. This probe stays because the crew cluster still reads the global await.)
  function currentPending() {
    if (typeof Channels === 'undefined') return null;
    try {
      const ids = Channels.pendingIds(); if (!ids || !ids.length) return null;
      const wsId = ids[0]; const p = Channels.pendingOf(wsId);
      return p ? { wsId: wsId, p: p } : null;
    } catch (_) { return null; }
  }
  /* ---------------- CREW instrument-cluster pulse (real activity) ---------------- */
  function tickCrew() {
    const rows = document.querySelectorAll('#crew .crew-row'); if (!rows.length) return;
    // A pending consent blocks the WHOLE station, so AWAIT is global; otherwise each dot reflects ITS OWN agent's
    // live run (read per-agent from StationUI), not the single hero state that used to light every dot in lockstep.
    const awaiting = !!currentPending();
    // work-vs-think flavour comes from the hero status line — only meaningful for the common single-agent station.
    const thinking = (($('#chat-status') || {}).textContent || '').toLowerCase().indexOf('think') >= 0;
    for (const row of rows) {
      const d = row.querySelector('.dot'); if (!d) continue;
      // this tick runs ~3x/sec for the app's lifetime, so keep it cheap: read the agent id straight off the
      // row (StationUI stamps data-agent-id) instead of a second querySelector + string slice, and only touch
      // the DOM when the class actually changes (no redundant style invalidation every tick).
      const id = row.dataset.agentId || '';
      let cls = 'wr-idle';
      if (awaiting) cls = 'wr-await';
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
