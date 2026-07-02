/* STARNET — topbar.js : the TOPBAR INSTRUMENT-CLUSTER logic (read-only wiring).

   The topbar holds one cockpit gauge group: STATION (level + an XP-progress sliver),
   SPEND TODAY, and the moved-up session-status instruments (UPLINK / ONLINE / save).

   This module OWNS none of the data. It is a pure read-only consumer:
     - STATION level      — written into #gt-station by xpstore.js (untouched); we only
                             ADD the XP sliver, painted from Xp.compute(XpStore.stationStats())
                             (a read-only exported getter) on the same U.bus growth events.
     - SPEND TODAY        — the authoritative day-scoped figure is the sidecar's
                             /api/budget/status { spentToday } (the same source the SETTINGS
                             budget panel reads). We poll it at most once / 30s AND fold live
                             agent.cost {usd} events on U.bus between polls, so the number ticks
                             up the instant a run bills and reconciles to the ledger truth on the
                             next poll. When the sidecar is absent (pure localStorage boot) the
                             poll fails quietly and we fall back to the live event sum from $0.00.
     - UPLINK / ONLINE / save — their markup was moved up from #bottombar .bb-right with ids
                             intact, so main.js save() and stationui.js tick()/flashSave() keep
                             writing them with zero changes here.

   It NEVER emits a bus event and never mutates another module's state — the frozen
   shared/events.js contract stays untouched, and the lint-emits gate has nothing to catch. */
'use strict';
const Topbar = (() => {
  let wired = false;
  let pollTimer = 0;
  let liveSpend = 0;          // running sum of agent.cost usd this session — the between-poll live tick
  let ledgerToday = null;     // last authoritative /api/budget/status spentToday ($/day), null until first good poll
  let ledgerLiveBase = 0;     // liveSpend value AT the moment of the last good poll, so we add only the delta since

  const $ = sel => document.querySelector(sel);

  /* ---- SPEND: format a dollar figure sensibly. Sub-cent shows more precision so a
     $0.0043 haiku ping is visible; larger sums round to cents; zero is a quiet $0.00. */
  function fmtSpend(v) {
    v = Number(v);
    if (!isFinite(v) || v <= 0) return '$0.00';
    if (v < 0.1) return '$' + v.toFixed(4);      // sub-dime: 4 decimals ($0.0043)
    if (v < 100) return '$' + v.toFixed(2);      // normal: cents ($4.32)
    return '$' + Math.round(v).toLocaleString(); // large: whole dollars ($1,204)
  }

  // the number to display = the authoritative ledger day-total (if we have one) PLUS any
  // live cost that has landed since that poll; else just the live session sum.
  function displaySpend() {
    if (ledgerToday != null) return ledgerToday + Math.max(0, liveSpend - ledgerLiveBase);
    return liveSpend;
  }

  function paintSpend(pulse) {
    const inst = $('#tb-spend'); if (!inst) return;
    const valEl = inst.querySelector('.tb-val'); if (!valEl) return;
    const v = displaySpend();
    valEl.textContent = fmtSpend(v);
    inst.setAttribute('data-zero', v > 0 ? '0' : '1');
    if (pulse) {
      inst.classList.remove('tb-tick'); void inst.offsetWidth; inst.classList.add('tb-tick');
    }
  }

  // ---- STATION XP sliver: read-only compute over the live station rollup ----
  function paintXp() {
    try {
      if (typeof Xp === 'undefined' || typeof XpStore === 'undefined' || !XpStore.stationStats) return;
      const stats = XpStore.stationStats();
      if (!stats) return;
      const g = Xp.compute(stats);
      const fill = $('#tb-station .tb-xp-fill');
      if (fill && g && isFinite(g.frac)) {
        const pct = Math.max(0, Math.min(100, Math.round(g.frac * 100)));
        fill.style.width = pct + '%';
        const xp = $('#tb-station .tb-xp');
        if (xp) xp.title = 'STATION Lv ' + g.level + ' — ' + pct + '% to Lv ' + (g.level + 1)
          + (isFinite(g.toNext) ? ' (' + g.toNext + ' XP to go)' : '');
      }
    } catch (_) { /* honest no-op: leave the sliver where it is */ }
  }

  // ---- the authoritative day-scoped poll (≤1 / 30s). Reconciles the live tick to ledger truth. ----
  function poll() {
    fetch('/api/budget/status', { cache: 'no-store' })
      .then(r => (r && r.ok) ? r.json() : null)
      .then(st => {
        if (!st) return;                 // no sidecar / bad response: keep the live-sum fallback
        const today = Number(st.spentToday);
        if (isFinite(today)) { ledgerToday = today; ledgerLiveBase = liveSpend; paintSpend(false); }
      })
      .catch(() => { /* sidecar absent (localStorage boot): live-sum fallback already shows */ });
  }

  // ---- live cost event: fold usd, repaint with a brief glow-pulse ----
  function onCost(p) {
    const usd = p && Number(p.usd);
    if (isFinite(usd) && usd > 0) { liveSpend += usd; paintSpend(true); }
  }

  function init() {
    if (wired) return;
    wired = true;

    // first paints (may run before any event / poll — honest zeros / current level)
    paintXp();
    paintSpend(false);

    if (typeof U !== 'undefined' && U.bus) {
      // SPEND ticks the instant a run bills; the growth events also advance the XP sliver.
      U.bus.on('agent.cost', p => { try { onCost(p); } catch (_) {} });
      // the same real outcomes xpstore.js grows the station on — repaint the sliver after it folds.
      for (const n of ['agent.run.end', 'agent.tool_result', 'memory.feedback', 'workitem.delivered', 'channel.delivery']) {
        U.bus.on(n, () => { try { paintXp(); } catch (_) {} });
      }
    }

    // authoritative day-total: poll now + every 30s (event-driven between polls; never aggressive).
    poll();
    pollTimer = setInterval(poll, 30000);

    // repaint the XP sliver on a slow cadence too, in case a level-up celebration reset the level
    // (cheap: one read-only compute; no network). Piggybacks the same 30s tick.
    setInterval(paintXp, 30000);
  }

  // start once the DOM + app globals exist (this script loads after app.js)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // expose a tiny read-only surface for dev/verification (mirrors testapi.js style; inert otherwise)
  return { init, _paintSpend: paintSpend, _paintXp: paintXp, _displaySpend: displaySpend };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { Topbar };
