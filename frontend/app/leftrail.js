/* STARNET — leftrail.js : hide/show AND resize the CREW rail.
   ◂ in the rail header hides the whole left column (the stage absorbs the space via the
   body.crew-rail-off grid overrides in app.css); a slim ▸ CREW drawer tab on the stage's
   left edge brings it back. Persisted per machine, like the COMMS width (chatresize.js).
   The rail's WIDTH is draggable too — the seam on the stage's left edge writes --crew-w, the
   same way chatresize.js writes --chat-w. Both are persisted; both reset on double-click. */
'use strict';

(() => {
  const KEY = 'starnet.crewrail';
  const hideBtn = document.getElementById('crew-hide');
  const showTab = document.getElementById('crew-show');
  if (!hideBtn || !showTab) return;

  function apply(off) {
    document.body.classList.toggle('crew-rail-off', off);
    showTab.hidden = !off;
    hideBtn.setAttribute('aria-expanded', String(!off));
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
