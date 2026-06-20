/* SKYNET — navdock.js : the grouped bottom-bar navigation.
   The 13 station panels were a flat, undifferentiated row of cryptic glyphs. They're now
   regrouped (in index.html) into 4 labelled docks — CREW / WORK / BUILD / SYSTEM — each a
   .bb-grp trigger that opens a .bb-menu popover of its items. The item buttons keep their
   original id / data-term, so stationui/app handlers fire unchanged; this file only manages
   the popover open/close + reflects each group's live state (a panel open under it, or a
   pending notification) onto the collapsed trigger so nothing important hides in a closed menu. */
'use strict';

(() => {
  const bar = document.getElementById('bottombar');
  if (!bar) return;
  const groups = Array.from(bar.querySelectorAll('.bb-group'));
  if (!groups.length) return;

  /* ---------- popover open/close (one at a time) ---------- */
  function closeAll(except) {
    groups.forEach(g => {
      if (g === except) return;
      g.classList.remove('open');
      const t = g.querySelector('.bb-grp');
      if (t) t.setAttribute('aria-expanded', 'false');
    });
  }
  function toggle(g) {
    const willOpen = !g.classList.contains('open');
    closeAll(g);
    g.classList.toggle('open', willOpen);
    const t = g.querySelector('.bb-grp');
    if (t) t.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) dismissCoach();   // they found the docks — retire the hint for good
    try { if (typeof SFX === 'object' && SFX[willOpen ? 'open' : 'close']) SFX[willOpen ? 'open' : 'close'](); } catch (_) {}
  }

  /* ---------- one-time "what now" coach: teach the new grouped-dock model ----------
     The interaction model changed (flat buttons -> dock popovers), so a brand-new station
     gets one dismissible hint pointing at the docks. Shown on first game-screen view, then
     retired permanently the moment the Commander opens any dock or taps ✕. */
  const COACH_KEY = 'skynet.navcoach.seen';
  const coach = document.getElementById('nav-coach');
  let coachTimer = 0;
  function dismissCoach(persist) {
    if (!coach || coach.hidden) return;
    coach.hidden = true;
    if (coachTimer) { clearTimeout(coachTimer); coachTimer = 0; }
    if (persist !== false) { try { localStorage.setItem(COACH_KEY, '1'); } catch (_) {} }
  }
  function showCoachOnce() {
    if (!coach || !coach.hidden) return;
    try { if (localStorage.getItem(COACH_KEY)) return; } catch (_) {}
    coach.hidden = false;
    coachTimer = setTimeout(() => dismissCoach(false), 15000);   // fade out after a while, but let it return next session
  }
  if (coach) {
    const x = document.getElementById('nav-coach-x');
    if (x) x.addEventListener('click', () => dismissCoach(true));
    const game = document.getElementById('screen-game');
    if (game) {
      if (game.classList.contains('active')) showCoachOnce();
      new MutationObserver(() => { if (game.classList.contains('active')) showCoachOnce(); })
        .observe(game, { attributes: true, attributeFilter: ['class'] });
    }
  }

  groups.forEach(g => {
    const trigger = g.querySelector('.bb-grp');
    if (trigger) trigger.addEventListener('click', ev => { ev.stopPropagation(); toggle(g); });
    // picking an item runs its own (existing) handler — just collapse the dock after.
    g.querySelectorAll('.bb-menu .bb').forEach(item =>
      item.addEventListener('click', () => closeAll(null)));
  });

  // click anywhere else, or Escape, dismisses an open dock
  document.addEventListener('click', ev => { if (!bar.contains(ev.target)) closeAll(null); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeAll(null); });

  /* ---------- reflect live state onto the collapsed trigger ----------
     A group lights its dot when one of its panels is open (mirrors stationui's .bb.active),
     and the SYSTEM group additionally surfaces a pending NOTIFS count so the badge isn't
     buried inside a closed menu. */
  const nfBadge = document.getElementById('nf-badge');
  function syncGroupState() {
    groups.forEach(g => {
      const anyOpen = !!g.querySelector('.bb-menu .bb.active');
      g.classList.toggle('has-active', anyOpen);
    });
    if (nfBadge) {
      const sys = bar.querySelector('.bb-group[data-group="system"]');
      if (sys) {
        const shown = nfBadge.textContent && nfBadge.offsetParent !== null;
        sys.classList.toggle('has-alert', !!shown);
      }
    }
  }

  // stationui toggles .bb.active and the nf-badge imperatively — observe the bar so the
  // collapsed triggers stay truthful without coupling the two files together.
  const mo = new MutationObserver(syncGroupState);
  mo.observe(bar, { subtree: true, attributes: true, attributeFilter: ['class', 'style'], childList: true, characterData: true });
  syncGroupState();
})();
