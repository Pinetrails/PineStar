/* STARNET — northstar.js : the AMBIENT NORTH-STAR surface (Concept A).

   A diegetic bearing-star pinned into the station's live-feed overlay (#stage-wrap / .cam-hud): the
   station's own SENSE OF YOUR HEADING, rendered as certainty. It reads the pure understanding engine
   (via UnderstandingStore) and draws the goal as a star that is HAZY when the station barely knows you
   and SHARPENS + brightens as understanding climbs. Almost no numbers on the face — you FEEL the model
   getting clearer. When a clean run just sharpened understanding, it pulses once (the "you got clearer"
   moment). Hover = a GLANCE (a tiny nameplate: the heading + the honest read), never a window
   (frontend-law: hover = glance). A ring of ticks around it shows REAL milestone progress (a separate
   axis from clarity).

   Truthful telemetry: every pixel maps to a provable read — a cold station is fog with no heading text;
   the % and the progress ring are the engine's real numbers, never invented. Self-mounts, owns its own
   DOM, and is a read-only citizen (it subscribes to UnderstandingStore; it never emits on U.bus). */
'use strict';
const NorthStar = (() => {
  let root = null, cv = null, cx = null, plate = null;
  let cur = null;              // the latest read
  let seeded = false;          // first read snaps clarity to target (so the first paint is correct without waiting for the ease)
  let clarityShown = 0;        // eased display clarity (smooths jumps between reads)
  let pulse = 0;               // 0..1 decaying "just got clearer" flash
  let raf = 0, t = 0;
  let reduce = false;
  const DPR = () => (typeof window !== 'undefined' && window.devicePixelRatio) ? Math.min(3, window.devicePixelRatio) : 1;

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  function mount() {
    if (root || typeof document === 'undefined') return;
    const host = document.getElementById('stage-wrap');
    if (!host) return;
    root = document.createElement('div');
    root.className = 'northstar';
    root.setAttribute('role', 'img');
    root.setAttribute('tabindex', '0');
    root.setAttribute('aria-label', 'Station understanding of your heading');
    cv = document.createElement('canvas');
    cv.className = 'northstar-cv';
    root.appendChild(cv);
    plate = document.createElement('div');
    plate.className = 'northstar-plate';
    plate.hidden = true;
    root.appendChild(plate);
    host.appendChild(root);
    cx = cv.getContext('2d');
    sizeCanvas();

    // hover / focus = GLANCE (nameplate only). Never opens a window.
    const show = () => { updatePlate(); plate.hidden = false; };
    const hide = () => { plate.hidden = true; };
    root.addEventListener('pointerenter', show);
    root.addEventListener('pointerleave', hide);
    root.addEventListener('focus', show);
    root.addEventListener('blur', hide);

    if (typeof window !== 'undefined') {
      reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.addEventListener('resize', sizeCanvas);
    }
  }

  function sizeCanvas() {
    if (!cv) return;
    const dpr = DPR();
    const w = cv.clientWidth || 120, h = cv.clientHeight || 120;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    if (cx) { cx.setTransform(1, 0, 0, 1, 0, 0); cx.scale(dpr, dpr); }
  }

  // the honest glance: the heading + the real read. Cold → "no heading set yet".
  function updatePlate() {
    if (!plate) return;
    const u = cur;
    if (!u) { plate.textContent = 'reading the station…'; return; }
    const pct = Math.round((u.overall || 0) * 100);
    const g = u.goal;
    let html = '';
    if (g && g.text) {
      html += '<span class="ns-head">' + esc(g.text) + '</span>';
      html += '<span class="ns-sub">reads you <b>' + pct + '%</b>' +
        (Number.isFinite(g.total) && g.total > 0 ? ' · <b>' + g.done + '/' + g.total + '</b> shipped' : '') + '</span>';
      if (g.next) html += '<span class="ns-next">next → ' + esc(g.next) + '</span>';
    } else {
      html += '<span class="ns-head">no heading set yet</span>';
      html += '<span class="ns-sub">reads you <b>' + pct + '%</b> · set a goal to give the station a star to steer by</span>';
    }
    plate.innerHTML = html;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---- the star ----
  function draw() {
    if (!cx || !cv) return;
    const W = cv.clientWidth || 120, H = cv.clientHeight || 120;
    const cxp = W / 2, cyp = H / 2;
    cx.clearRect(0, 0, W, H);
    const clarity = clamp01(clarityShown);
    const glowK = 0.28 + clarity * 0.72 + pulse * 0.5;     // brighter with clarity + the pulse flash

    // ambient halo
    const halo = cx.createRadialGradient(cxp, cyp, 2, cxp, cyp, W * 0.5);
    halo.addColorStop(0, 'rgba(255,178,72,' + (0.04 + clarity * 0.18 + pulse * 0.15).toFixed(3) + ')');
    halo.addColorStop(1, 'rgba(255,178,72,0)');
    cx.fillStyle = halo; cx.fillRect(0, 0, W, H);

    const blur = (1 - clarity) * 6;                         // the FOG: heavy when the station barely knows you
    cx.save();
    cx.filter = 'blur(' + blur.toFixed(2) + 'px)';
    cx.translate(cxp, cyp);
    const R = W * (0.24 + clarity * 0.05), r = W * (0.045 + clarity * 0.02);
    const col = 'rgba(255,' + Math.round(200 + clarity * 40) + ',' + Math.round(140 + clarity * 70) + ',' + (0.5 + clarity * 0.5).toFixed(3) + ')';
    cx.fillStyle = col;
    cx.shadowColor = 'rgba(255,190,90,' + glowK.toFixed(3) + ')';
    cx.shadowBlur = 6 + clarity * 20 + pulse * 16;
    spike(0, R, r); spike(Math.PI, R, r);                  // vertical
    spike(Math.PI / 2, R * 0.62, r); spike(-Math.PI / 2, R * 0.62, r);  // horizontal
    cx.globalAlpha = clarity * 0.5;                          // diagonal minor rays fade in with clarity
    spike(Math.PI / 4, R * 0.34, r * 0.7); spike(3 * Math.PI / 4, R * 0.34, r * 0.7);
    spike(-Math.PI / 4, R * 0.34, r * 0.7); spike(-3 * Math.PI / 4, R * 0.34, r * 0.7);
    cx.globalAlpha = 1;
    cx.beginPath(); cx.arc(0, 0, 2 + clarity * 3, 0, Math.PI * 2);       // bright core
    cx.fillStyle = 'rgba(255,240,210,' + (0.6 + clarity * 0.4).toFixed(3) + ')';
    cx.shadowBlur = 10 + clarity * 18; cx.fill();
    cx.restore();

    drawProgressRing(cxp, cyp, R);
  }
  function spike(rot, len, wide) {
    cx.save(); cx.rotate(rot);
    cx.beginPath(); cx.moveTo(0, -len); cx.lineTo(wide, 0); cx.lineTo(0, len * 0.16); cx.lineTo(-wide, 0); cx.closePath();
    cx.fill(); cx.restore();
  }
  // real milestone progress as a ring of ticks (done = green, remaining = dim). Silent when no goal/total.
  function drawProgressRing(cxp, cyp, R) {
    const g = cur && cur.goal;
    if (!g || !Number.isFinite(g.total) || g.total <= 0) return;
    const total = Math.min(24, g.total | 0), done = Math.max(0, Math.min(total, g.done | 0));
    cx.save(); cx.translate(cxp, cyp);
    for (let i = 0; i < total; i++) {
      const a = -Math.PI / 2 + i * (Math.PI * 2 / total);
      const rx = Math.cos(a) * (R + 8), ry = Math.sin(a) * (R + 8);
      cx.beginPath(); cx.arc(rx, ry, 2.4, 0, Math.PI * 2);
      if (i < done) { cx.fillStyle = 'rgba(123,200,138,.95)'; cx.shadowColor = 'rgba(123,200,138,.6)'; cx.shadowBlur = 6; }
      else { cx.fillStyle = 'rgba(150,100,35,.55)'; cx.shadowBlur = 0; }
      cx.fill();
    }
    cx.restore();
  }

  function frame() {
    t += 0.02;
    const target = cur ? clamp01(cur.overall || 0) : 0;
    clarityShown += (target - clarityShown) * 0.08;         // ease toward the real value (smooth, not jumpy)
    if (pulse > 0) pulse = Math.max(0, pulse - 0.02);
    // a calm living shimmer on the glow only (never busy); frozen under reduced-motion.
    const shimmer = reduce ? 0 : Math.sin(t) * 0.015;
    const saved = clarityShown; clarityShown = clamp01(clarityShown + shimmer * clarityShown);
    draw();
    clarityShown = saved;
    raf = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(frame) : 0;
  }

  function onRead(u) {
    cur = u;
    if (u && u.rose) pulse = 1;                              // the "you just got clearer" flash
    const target = u ? clamp01(u.overall || 0) : 0;
    if (!seeded) { clarityShown = target; seeded = true; }   // first read: no easing, paint the real value
    if (!plate.hidden) updatePlate();
    // paint immediately on every read so a state change is reflected even when rAF is throttled (hidden tab);
    // the rAF loop then only smooths the transition + runs the shimmer/pulse decay when the tab is visible.
    draw();
  }

  function init() {
    if (typeof document === 'undefined') return;
    mount();
    if (!root) return;
    if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.subscribe) UnderstandingStore.subscribe(onRead);
    else if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.read) cur = UnderstandingStore.read();
    // pick up rare panel edits (a new belief between runs) on a cheap cadence, without a per-frame recompute.
    if (typeof setInterval !== 'undefined') setInterval(() => { try { if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.refresh) UnderstandingStore.refresh(false); } catch (_) {} }, 1500);
    if (typeof requestAnimationFrame !== 'undefined' && !raf) raf = requestAnimationFrame(frame);
  }

  return { init, _draw: draw, _onRead: onRead };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { NorthStar };
