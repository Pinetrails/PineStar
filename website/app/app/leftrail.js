/* STARNET — leftrail.js : the CREW rail's own layout. Three things, in this order:
   (1) the ROSTER WINDOW — how many crew rows the rail shows whole before it scrolls;
   (2) hide/show — ◂ in the rail header hides the whole left column (the stage absorbs the space
       via the body.crew-rail-off grid overrides in app.css); a slim ▸ CREW drawer tab on the
       stage's left edge brings it back;
   (3) WIDTH — the seam on the stage's left edge writes --crew-w, the same way chatresize.js
       writes --chat-w.
   All three persist per machine; the width also resets on double-click. (1) re-measures on any
   of the others moving — its ResizeObserver watches #left, which a width drag resizes too. */
'use strict';

(() => {
  const KEY = 'starnet.crewrail';

  /* ================= ROSTER WINDOW (2026-08-07) =================
     The roster used to be capped at a flat max-height:40% of the column, and a percentage is never
     a whole number of rows — so the cap landed MID-ROW and sliced the last agent in half. Measured
     on a 6-agent station that is 10px of a row at 1440x900, 18px at 780, 25px at 660: enough to
     read as BROKEN rather than as scrollable, which is exactly how it was reported.

     So the window is measured instead, and it always ends flush under a row:
       · it wants ROWS_MIN agents visible whole — the floor the rail promises;
       · past that it keeps the old 40% space split (RAIL SPACE SPLIT, 2026-07-27: the roster is
         content-sized and #ws-wrap takes the column's slack), so a tall rail still shows MORE
         than the floor rather than parking dead black under a short roster;
       · and it never takes so much that SESSIONS drops below WS_FLOOR.
     Whatever that budget works out to, the cap is then rounded DOWN to a whole row.

     Rows are not a fixed height — a WORKING row grows the in-flight bar, a duplicate name grows an
     id chip — so the cap is summed from real row geometry every time, never from a constant. */
  const ROWS_MIN = 4;     // agents the rail shows whole even when the column is tight
  const SHARE = 0.4;      // …and past that, the roster's historic share of the column
  const WS_FLOOR = 132;   // px SESSIONS keeps below no matter how deep the crew: head + search + ~2 rows

  /* THE decision, kept separate from the measuring so it is testable without a layout engine.
     `cuts` is the max-height that would end the window flush under each row in turn (so it is
     already monotonically increasing and already carries the list's own padding). Returns the
     largest of those that the budget allows — never a value BETWEEN two cuts, which is the whole
     point — and never fewer than one row, however tight the column gets. */
  function crewCap(cuts, o) {
    o = o || {};
    const n = cuts.length;
    if (!n) return 0;
    const rowsMin = o.rowsMin > 0 ? o.rowsMin : ROWS_MIN;
    const share = o.share >= 0 ? o.share : SHARE;
    const spare = isFinite(o.spare) ? o.spare : Infinity;
    const budget = Math.min(Math.max(cuts[Math.min(rowsMin, n) - 1], (o.railH || 0) * share), spare);
    let i = n - 1;
    while (i > 0 && cuts[i] > budget) i--;
    return Math.ceil(cuts[i]);
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { crewCap, ROWS_MIN, SHARE, WS_FLOOR };
  if (typeof document === 'undefined') return;   // headless require(): the decision only, no rail to wire

  const ul = document.getElementById('crew');
  const left = document.getElementById('left');
  const sumEl = document.getElementById('crew-sum');

  function fitCrew() {
    if (!ul || !left || left.offsetParent === null) return;   // rail hidden — nothing to measure
    const rows = ul.querySelectorAll('.crew-row');
    if (!rows.length) { ul.style.removeProperty('--crew-cap'); return; }   // empty state sizes itself
    const cs = getComputedStyle(ul);
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    // offsetTop is measured from the offsetParent, which is #crew itself only if #crew is
    // positioned (then row tops exclude its border) and the shared ancestor otherwise.
    const base = rows[0].offsetParent === ul ? -(parseFloat(cs.borderTopWidth) || 0) : ul.offsetTop;
    // the max-height that ends the list flush under each row (border-box sizing, so padding counts)
    const cuts = [].map.call(rows, (r) => (r.offsetTop - base) + r.offsetHeight + padBottom);

    // What the column can actually spare. Rects are VISUAL px while the cap we write is #crew's own
    // px — TEXT SIZE zooms the body — so convert once (uiZoom law); clientHeight is already in
    // #crew's px and needs no conversion.
    const z = (typeof U !== 'undefined' && U.elZoom) ? (U.elZoom(ul) || 1) : 1;
    const sumH = sumEl ? sumEl.getBoundingClientRect().height : 0;
    const spare = (left.getBoundingClientRect().bottom - ul.getBoundingClientRect().top - sumH) / z - WS_FLOOR;

    const next = crewCap(cuts, { railH: left.clientHeight, spare: spare }) + 'px';
    if (ul.style.getPropertyValue('--crew-cap') !== next) ul.style.setProperty('--crew-cap', next);
  }

  let pending = 0;
  function schedule() {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; try { fitCrew(); } catch (_) {} });
  }

  if (ul && left) {
    // ROW COUNT — crewRender replaces the list wholesale. Deliberately NOT subtree: crewTick
    // rewrites every status line's textContent once a second, and a subtree childList observer
    // turns that into ~8 forced layouts a second for nothing.
    new MutationObserver(schedule).observe(ul, { childList: true });
    // ROW HEIGHT — crewTick toggles .working, which opens the in-flight bar inside the row.
    new MutationObserver(schedule).observe(ul, { subtree: true, attributeFilter: ['class'] });
    // …and that bar is TRANSITIONED (motion.css §17, --t-med 220ms), so the class toggle above
    // fires while the row is still the OLD height and ANY single re-measure after it samples the
    // animation mid-flight — measured: 13px of the next agent showing until something else
    // happened to re-measure. So FOLLOW the animation instead of sampling it: while a row height
    // is in flight the whole list is still moving, so re-measure every frame until it settles, and
    // once more on transitionend for the exact landing. Frames are only spent while a run starts
    // or ends, and following is what keeps the window flush at every step of the collapse.
    let followUntil = 0, following = false;
    function follow() {
      fitCrew();
      if (performance.now() < followUntil) requestAnimationFrame(follow);
      else following = false;
    }
    ul.addEventListener('transitionrun', (e) => {
      if (e.propertyName !== 'height') return;
      followUntil = performance.now() + 400;   // covers --t-med plus a re-toggle queued behind it
      if (!following) { following = true; requestAnimationFrame(follow); }
    });
    ul.addEventListener('transitionend', (e) => {
      if (e.propertyName === 'height' || e.propertyName === 'margin-top') schedule();
    });
    // window resize, rail show/hide, and TEXT SIZE (a body zoom re-lays the column out)
    if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(left);
    window.addEventListener('resize', schedule);
    schedule();
  }

  /* ================= HIDE / SHOW ================= */
  const hideBtn = document.getElementById('crew-hide');
  const showTab = document.getElementById('crew-show');
  if (!hideBtn || !showTab) return;

  function apply(off) {
    document.body.classList.toggle('crew-rail-off', off);
    showTab.hidden = !off;
    hideBtn.setAttribute('aria-expanded', String(!off));
    schedule();   // coming back from hidden, the rail must re-measure before it paints
  }
  function set(off) {
    apply(off);
    try { off ? localStorage.setItem(KEY, 'off') : localStorage.removeItem(KEY); } catch (_) {}
  }

  // restore the saved state (default: rail shown)
  try { if (localStorage.getItem(KEY) === 'off') apply(true); } catch (_) {}

  hideBtn.addEventListener('click', () => {
    set(true);
    try { if (typeof SFX === 'object' && SFX.close) SFX.close(); } catch (_) {}
  });
  showTab.addEventListener('click', () => {
    set(false);
    try { if (typeof SFX === 'object' && SFX.click) SFX.click(); } catch (_) {}
  });

  /* ---------- the CREW seam: drag the rail wider / narrower ----------
     Mirrors chatresize.js exactly (visual px, rAF-coalesced writes, per-machine persistence,
     double-click to reset) with one difference: COMMS is allowed to swallow the stage whole,
     the rail is NOT. The rail is a fixed-content column — a Commander widens it to read long
     session titles, not to hide the station — so it stops at WMAX, and never at a width that
     would leave the stage thinner than STAGE_MIN. */
  const WKEY = 'starnet.crewrail.w';
  const seam = document.getElementById('crew-resizer');
  const game = document.getElementById('screen-game');
  if (!seam || !game) return;

  // visual px, like --crew-w / --chat-w: the grid holds the cabinet at its designed size at every
  // TEXT SIZE (app.css `#screen-game.active` counter-zooms every frame dimension), so a dragged
  // width means the same thing at HUGE as it does at NORMAL.
  // WMIN is the rail's DESIGNED width, not an arbitrary floor: the ask was "move the left panel
  // farther", i.e. more room, and every fixed label in the rail (the SESSIONS/PROJECTS + NEW strip
  // most of all) was laid out against 232. Letting the drag go under it only bought a squeezed
  // rail — so the seam widens and returns, and never narrows past the design.
  const PAD = 11, GAP = 9, WMIN = 232, WMAX = 400, STAGE_MIN = 220, CHAT_DEFAULT = 360;
  function maxWidth() {
    const chat = parseInt(getComputedStyle(game).getPropertyValue('--chat-w'), 10) || CHAT_DEFAULT;
    const room = window.innerWidth - (PAD * 2) - (GAP * 2) - chat - STAGE_MIN;
    return Math.max(WMIN, Math.min(WMAX, room));
  }
  const clamp = w => Math.max(WMIN, Math.min(maxWidth(), w));
  function applyW(w) { game.style.setProperty('--crew-w', clamp(w) + 'px'); }

  // restore a saved width (re-clamped to the current window)
  try { const s = parseInt(localStorage.getItem(WKEY), 10); if (s) applyW(s); } catch (_) {}

  let dragging = false, pendingW = null, moveRaf = 0;
  // one width write per frame: each write re-lays the grid and resizes the stage canvas, so batching
  // to rAF keeps the resize cadence in step with paint (world.js observes #stage-wrap).
  function flushMove() {
    moveRaf = 0;
    if (pendingW != null) { applyW(pendingW); pendingW = null; }
  }
  function onMove(e) {
    if (!dragging) return;
    // the rail's left edge is the grid's padding, so its width is the cursor minus that.
    pendingW = e.clientX - PAD;
    if (!moveRaf) moveRaf = requestAnimationFrame(flushMove);
    e.preventDefault();
  }
  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
    if (pendingW != null) { applyW(pendingW); pendingW = null; }   // land the position the rAF hadn't flushed
    document.body.classList.remove('col-resizing');
    try { seam.releasePointerCapture(e.pointerId); } catch (_) {}
    const cur = getComputedStyle(game).getPropertyValue('--crew-w').trim();
    try { if (cur) localStorage.setItem(WKEY, parseInt(cur, 10)); } catch (_) {}
    try { if (typeof SFX === 'object' && SFX.click) SFX.click(); } catch (_) {}
  }
  seam.addEventListener('pointerdown', e => {
    dragging = true;
    document.body.classList.add('col-resizing');
    try { seam.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  seam.addEventListener('pointermove', onMove);
  seam.addEventListener('pointerup', onUp);
  seam.addEventListener('pointercancel', onUp);

  // double-click the seam to snap the rail back to its designed width
  seam.addEventListener('dblclick', () => {
    game.style.removeProperty('--crew-w');
    try { localStorage.removeItem(WKEY); } catch (_) {}
    try { if (typeof SFX === 'object' && SFX.close) SFX.close(); } catch (_) {}
  });

  // a shrinking window (or a widened COMMS) can leave a stored width too wide — re-clamp
  window.addEventListener('resize', () => {
    const cur = parseInt(getComputedStyle(game).getPropertyValue('--crew-w'), 10);
    if (cur) applyW(cur);
  });
})();
