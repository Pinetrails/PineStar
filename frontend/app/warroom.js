/* STARNET — warroom.js : the LIVING WAR-ROOM visible layer.

   Implements the war-room concept ON the real app, on top of the per-agent Channels gate:
     · a REACTOR spend gauge in the top bar (bound to real lifetime spend),
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
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sfx = n => { try { if (typeof SFX === 'object' && SFX[n]) SFX[n](); } catch (_) {} };

  /* ---------------- REACTOR spend gauge (top bar) ---------------- */
  const RSEGS = 14;
  let lastCost = -1;
  function buildReactor() {
    const stats = $('#topbar .tb-stats'); if (!stats || $('#reactor')) return;
    const r = document.createElement('div');
    r.className = 'tb-stat reactor'; r.id = 'reactor';
    r.title = 'REACTOR — live spend draw (the gauge climbs with real cost)';
    let bars = '';
    for (let i = 0; i < RSEGS; i++) bars += '<span class="rseg" style="height:' + (5 + i * 1.1) + 'px"></span>';
    r.innerHTML = '<span class="rlab">⚡</span><span class="rbars">' + bars + '</span>';
    const station = $('#tb-station');
    if (station) stats.insertBefore(r, station); else stats.appendChild(r);
  }
  function tickReactor() {
    const r = $('#reactor'); if (!r) return;
    let cost = 0; try { cost = (typeof Harness !== 'undefined' && Harness.totals && Harness.totals().cost) || 0; } catch (_) {}
    const segs = r.querySelectorAll('.rseg'); const N = segs.length;
    const frac = 1 - Math.exp(-cost / 0.5);   // asymptotic: more spend -> fuller, never overflows the bar
    const lit = Math.round(frac * N);
    for (let i = 0; i < N; i++) segs[i].className = 'rseg' + (i < lit ? (i >= N - 2 ? ' on hot' : ' on') : '');
    if (lastCost >= 0 && cost > lastCost + 1e-9) {
      r.classList.add('bloom'); clearTimeout(tickReactor._t); tickReactor._t = setTimeout(() => r.classList.remove('bloom'), 320);
    }
    lastCost = cost;
  }

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
      '<div class="wrah-hdr"><span>🔒 APPROVAL REQUIRED</span><span>1 PENDING</span></div>' +
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
  function tickCrew() {
    const dots = document.querySelectorAll('#crew .dot'); if (!dots.length) return;
    let cls = 'wr-idle';
    if (currentPending()) cls = 'wr-await';
    else if (running() > 0) {
      // a REAL agent run is live (hero, summoned worker, or routed) — not merely the hero's status TEXT, which
      // used to light every dot in lockstep with the hero even when no run existed. refine work-vs-think from
      // the hero status line only while something is actually running.
      const st = (($('#chat-status') || {}).textContent || '').toLowerCase();
      cls = st.indexOf('think') >= 0 ? 'wr-think' : 'wr-work';
    }
    for (const d of dots) d.className = 'dot on ' + cls;
  }
  // authoritative per-agent run state — the SAME self-healing map the crew LIST reads (StationUI's runningAgents,
  // fed by real agent.run.start/end), never the global hero status string.
  function running() {
    try { return (typeof StationUI !== 'undefined' && StationUI.runningCount) ? StationUI.runningCount() : 0; } catch (_) { return 0; }
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
    buildReactor(); buildCinema();
    tick(); setInterval(tick, 300);
  }
  function tick() { try { tickReactor(); tickCrew(); } catch (_) {} }
  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
