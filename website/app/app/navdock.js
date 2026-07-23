/* STARNET — navdock.js : the grouped bottom-bar navigation.
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

  // the menuitem buttons inside a group's popover (role=menuitem; see index.html .bb-menu)
  const itemsOf = g => Array.from(g.querySelectorAll('.bb-menu .bb'));

  /* ---------- popover open/close (one at a time) ---------- */
  function closeAll(except) {
    groups.forEach(g => {
      if (g === except) return;
      const wasOpen = g.classList.contains('open');
      g.classList.remove('open');
      const t = g.querySelector('.bb-grp');
      if (t) t.setAttribute('aria-expanded', 'false');
      // a11y: if focus was inside the popover we just closed, hand it back to the trigger
      if (wasOpen && t && g.contains(document.activeElement)) { try { t.focus(); } catch (_) {} }
    });
  }
  // viaKeyboard: only a KEYBOARD-initiated open moves focus into the popover (menu-button pattern).
  // A mouse open must NOT transfer focus to the first item (TASKS in the WORK dock) — that invisible
  // focus meant any stray Enter/Space afterwards "clicked" TASKS, so the task board popped open
  // seemingly at random. Mouse users keep their focus; keyboard users still land on the first item.
  function toggle(g, viaKeyboard) {
    const willOpen = !g.classList.contains('open');
    closeAll(g);
    g.classList.toggle('open', willOpen);
    const t = g.querySelector('.bb-grp');
    if (t) t.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
      dismissCoach();   // they found the docks — retire the hint for good
      // a11y: on a keyboard open, move focus to the first menu item so the popover is navigable
      if (viaKeyboard) { const first = itemsOf(g)[0]; if (first) { try { first.focus(); } catch (_) {} } }
    }
    try { if (typeof SFX === 'object' && SFX[willOpen ? 'open' : 'close']) SFX[willOpen ? 'open' : 'close'](); } catch (_) {}
  }

  /* ---------- one-time "what now" coach: teach the new grouped-dock model ----------
     The interaction model changed (flat buttons -> dock popovers), so a brand-new station
     gets one dismissible hint pointing at the docks. Shown on first game-screen view, then
     retired permanently the moment the Commander opens any dock or taps ✕. */
  const COACH_KEY = 'starnet.navcoach.seen';
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
    // ev.detail === 0 ⇒ the click was synthesized by Enter/Space on the trigger (keyboard); > 0 ⇒ real mouse.
    // After a MOUSE toggle, also drop focus from the trigger — otherwise it silently keeps focus and a stray
    // Space/Enter later re-toggles the dock (the same "opens by itself" class of bug, one level up).
    if (trigger) trigger.addEventListener('click', ev => {
      ev.stopPropagation();
      const viaKeyboard = ev.detail === 0;
      toggle(g, viaKeyboard);
      if (!viaKeyboard) { try { trigger.blur(); } catch (_) {} }
    });
    // picking an item runs its own (existing) handler — just collapse the dock after.
    itemsOf(g).forEach(item => {
      item.setAttribute('role', 'menuitem');   // a11y: items inside the role=menu popover
      item.addEventListener('click', () => closeAll(null));
    });
    // a11y: full role=menu keyboard model — ArrowUp/Down cycle the items (wrapping),
    // Home/End jump, ArrowUp/Down on the closed trigger opens the menu, and Tab is
    // trapped inside an open popover so focus can't wander to the page behind it.
    // the adjacent group in the visual row (wrapping), for horizontal dock navigation.
    const sibling = (dir) => { const gi = groups.indexOf(g); return groups[(gi + (dir > 0 ? 1 : groups.length - 1)) % groups.length]; };
    g.addEventListener('keydown', ev => {
      const open = g.classList.contains('open');
      if (!open && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && document.activeElement === trigger) {
        ev.preventDefault(); toggle(g, true); return;   // keyboard open → toggle() focuses the first item
      }
      // closed trigger: Left/Right walks to the adjacent dock trigger (menubar-style), no popover opened.
      if (!open && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && document.activeElement === trigger) {
        ev.preventDefault();
        const nt = sibling(ev.key === 'ArrowRight' ? 1 : -1).querySelector('.bb-grp');
        if (nt) { try { nt.focus(); } catch (_) {} }
        return;
      }
      if (!open) return;
      // open popover: Left/Right moves to the neighbouring dock's popover (open it there, focus its first item).
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        ev.preventDefault();
        const nb = sibling(ev.key === 'ArrowRight' ? 1 : -1);
        if (nb && nb !== g) toggle(nb, true);   // keyboard walk: closes this one + focuses the neighbour's first item
        return;
      }
      const items = itemsOf(g); if (!items.length) return;
      const first = items[0], last = items[items.length - 1], act = document.activeElement;
      const i = items.indexOf(act);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); (items[i + 1] || first).focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); (i > 0 ? items[i - 1] : last).focus(); }
      else if (ev.key === 'Home') { ev.preventDefault(); first.focus(); }
      else if (ev.key === 'End') { ev.preventDefault(); last.focus(); }
      else if (ev.key === 'Tab') {
        if (ev.shiftKey && act === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && act === last) { ev.preventDefault(); first.focus(); }
      }
    });
  });

  // click anywhere else, or Escape, dismisses an open dock
  document.addEventListener('click', ev => { if (!bar.contains(ev.target)) closeAll(null); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeAll(null); });

  /* ---------- reflect live state onto the collapsed trigger ----------
     A group underlines its trigger while one of its panels is open (mirrors stationui's
     .bb.active), and the SYSTEM trigger mirrors the pending NOTIFS COUNT into its own chip
     so the badge isn't buried inside a closed menu. NOTE: never probe the in-menu badge via
     offsetParent — a closed .bb-menu is display:none, so offsetParent is null exactly when
     the mirror matters; read the textContent + inline display that stationui.badges() writes. */
  const nfBadge = document.getElementById('nf-badge');
  const sysBadge = document.getElementById('bb-sys-badge');
  function syncGroupState() {
    groups.forEach(g => {
      const anyOpen = !!g.querySelector('.bb-menu .bb.active');
      g.classList.toggle('has-active', anyOpen);
    });
    if (nfBadge) {
      const sys = bar.querySelector('.bb-group[data-group="system"]');
      const n = (nfBadge.style.display !== 'none' && nfBadge.textContent) ? nfBadge.textContent : '';
      if (sys) sys.classList.toggle('has-alert', !!n);
      // guard the writes: this runs inside a MutationObserver on the bar's subtree, and an
      // unconditional textContent set replaces the text node even when the value is identical —
      // a new mutation record every pass = an infinite observer loop that pegs the main thread.
      if (sysBadge) {
        if (sysBadge.textContent !== n) sysBadge.textContent = n;
        if (sysBadge.hidden === !!n) sysBadge.hidden = !n;
      }
    }
  }

  // stationui toggles .bb.active and the nf-badge imperatively — observe the bar so the
  // collapsed triggers stay truthful without coupling the two files together.
  const mo = new MutationObserver(syncGroupState);
  mo.observe(bar, { subtree: true, attributes: true, attributeFilter: ['class', 'style'], childList: true, characterData: true });
  syncGroupState();
})();
