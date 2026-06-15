/* SKYNET — conveyor.js : directional belts + the boxes that ride them.

   The WorldModel owns belt TOPOLOGY (a keyed "x,y"->dir graph, walkable floor machinery). This
   module owns everything ALIVE: the transport simulation (boxes flowing tile-to-tile, spawned at
   sources, sinking at open ends) and the direction-aware belt + box pixel art (treads scrolling
   in the flow direction, ported from v7 F.beltH).

   Frame-agnostic by design: `Conveyor.create()` returns a self-contained instance handed a belt
   list in whatever tile frame the caller draws in (build.js = world coords, world.js = local
   coords). One sim powers REFIT preview and the live world, each with its own box state.

   DETERMINISM: no Math.random, no wall-clock — nowMs/dtMs are injected, spawn cadence is derived
   from nowMs + a per-source tile hash. Depends only on the global `U` + a 2D ctx. */
'use strict';

const Conveyor = (() => {
  const DIRV = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
  const SPEED = 1.7;        // tiles / second a box travels
  const SPAWN_MS = 1500;    // a source emits a box this often
  const SINK_MS = 280;      // fade-out time once a box rides off the end
  const MAX_BOXES = 80;     // hard cap (a runaway loop can't explode)

  const key = (x, y) => x + ',' + y;
  const buildMap = belts => { const m = new Map(); for (const b of belts) m.set(key(b.x, b.y), b.dir); return m; };
  // a tile is a SOURCE if no neighbouring belt flows INTO it (nothing upstream feeds it)
  function isSource(map, x, y) {
    for (const d in DIRV) {
      const v = DIRV[d], nx = x - v[0], ny = y - v[1];   // the tile that would feed (x,y) from dir d
      if (map.get(key(nx, ny)) === d) return false;
    }
    return true;
  }

  function create() {
    let boxes = [];
    let nid = 1;
    const lastSpawn = new Map();   // source key -> last spawn bucket (so cadence survives across ticks)

    function reset() { boxes = []; lastSpawn.clear(); }

    function tick(dtMs, nowMs, belts) {
      const map = buildMap(belts || []);
      const dt = Math.min(64, dtMs) / 1000;

      // spawn at sources on a hash-staggered cadence
      if (map.size && boxes.length < MAX_BOXES) {
        for (const b of belts) {
          if (!isSource(map, b.x, b.y)) continue;
          const k = key(b.x, b.y);
          const phase = (U.hash('belt' + k) % SPAWN_MS);
          const bucket = Math.floor((nowMs + phase) / SPAWN_MS);
          if (lastSpawn.get(k) === bucket) continue;
          if (lastSpawn.has(k) && boxes.length < MAX_BOXES) boxes.push({ id: nid++, x: b.x, y: b.y, dir: b.dir, prog: 0, sink: 0 });
          lastSpawn.set(k, bucket);
        }
      }

      // advance every box along its belt; adopt the next tile's direction at junctions/corners
      for (let i = boxes.length - 1; i >= 0; i--) {
        const bx = boxes[i];
        if (bx.sink > 0) { bx.sink += dtMs; if (bx.sink > SINK_MS) boxes.splice(i, 1); continue; }
        const here = map.get(key(bx.x, bx.y));
        if (!here) { bx.sink = 1; continue; }        // belt pulled out from under it → sink
        bx.dir = here;
        bx.prog += SPEED * dt;
        let guard = 0;
        while (bx.prog >= 1 && guard++ < 8) {
          const v = DIRV[bx.dir], nx = bx.x + v[0], ny = bx.y + v[1];
          const nd = map.get(key(nx, ny));
          if (nd) { bx.x = nx; bx.y = ny; bx.dir = nd; bx.prog -= 1; }
          else { bx.prog = 1; bx.sink = 1; break; }   // rode off the open end
        }
      }
      // trim oldest if some upstream change overran the cap
      if (boxes.length > MAX_BOXES) boxes.splice(0, boxes.length - MAX_BOXES);
    }

    /* ---------- belt art (direction-aware, ported from v7 F.beltH) ---------- */
    function drawBelts(ctx, nowMs, T, belts) {
      if (!belts || !belts.length) return;
      const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
      const scroll = ((nowMs / 90) % 4);             // tread phase, 0..4 px
      for (const b of belts) {
        const X = b.x * T, Y = b.y * T, v = DIRV[b.dir];
        const horiz = v[0] !== 0;
        // bed
        px(X, Y, T, T, '#222a26');
        px(X + 1, Y + 1, T - 2, T - 2, '#161c1a');
        // rails on the two edges PARALLEL to flow (the sides the cargo can't fall off)
        if (horiz) { px(X, Y, T, 1, '#46544c'); px(X, Y + T - 1, T, 1, '#46544c'); px(X + 1, Y + 1, T - 2, 1, '#0e1412'); }
        else { px(X, Y, 1, T, '#46544c'); px(X + T - 1, Y, 1, T, '#46544c'); px(X + 1, Y + 1, 1, T - 2, '#0e1412'); }
        // moving treads: short bars across the belt, marching in the flow direction
        ctx.fillStyle = '#3a4a42';
        for (let s = -4; s < T; s += 4) {
          if (horiz) { const tx = X + (v[0] > 0 ? (s + scroll) : (T - 1 - s - scroll)); if (tx > X && tx < X + T - 1) px(Math.round(tx), Y + 2, 1, T - 4, '#3a4a42'); }
          else { const ty = Y + (v[1] > 0 ? (s + scroll) : (T - 1 - s - scroll)); if (ty > Y && ty < Y + T - 1) px(X + 2, Math.round(ty), T - 4, 1, '#3a4a42'); }
        }
        // a phosphor flow chevron, marching — makes direction legible at a glance
        const cphase = ((nowMs / 220) % 1);
        const cx = X + T / 2, cy = Y + T / 2;
        ctx.strokeStyle = 'rgba(90,230,150,0.7)'; ctx.lineWidth = 1;
        ctx.beginPath();
        const reach = T * 0.32, off = (cphase - 0.5) * T * 0.5;
        if (horiz) { const dx = v[0], hx = cx + off * dx; ctx.moveTo(hx - reach * dx, cy - reach); ctx.lineTo(hx, cy); ctx.lineTo(hx - reach * dx, cy + reach); }
        else { const dy = v[1], hy = cy + off * dy; ctx.moveTo(cx - reach, hy - reach * dy); ctx.lineTo(cx, hy); ctx.lineTo(cx + reach, hy - reach * dy); }
        ctx.stroke();
        // drive LED on a corner, slow blink
        px(X + 1, Y + T - 2, 1, 1, ((nowMs / 300) % 1) < 0.5 ? '#41ff8a' : '#1a2a22');
      }
    }

    /* ---------- box art (a small riding crate w/ contact shadow) ---------- */
    function drawBoxes(ctx, nowMs, T) {
      if (!boxes.length) return;
      const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
      // y-sort so nearer boxes overlap farther ones cleanly
      const order = boxes.slice().sort((a, b) => boxPix(a, T).py - boxPix(b, T).py);
      for (const bx of order) {
        const { cx, py } = boxPix(bx, T);
        let a = 1;
        if (bx.sink > 0) a = Math.max(0, 1 - bx.sink / SINK_MS);
        ctx.globalAlpha = a * 0.28; px(Math.round(cx) - 4, Math.round(py) + 3, 9, 2, '#000'); ctx.globalAlpha = a;  // contact shadow
        const bxl = Math.round(cx) - 4, byl = Math.round(py) - 4;
        px(bxl, byl, 9, 8, '#36424c');               // body
        px(bxl, byl, 9, 1, '#56646e');               // lit top edge
        px(bxl, byl + 1, 1, 6, '#3e4a54');           // lit left
        px(bxl + 8, byl + 1, 1, 6, '#222a30');       // shaded right
        px(bxl + 3, byl, 3, 8, '#2e3840');           // tape seam down
        px(bxl + 1, byl + 2, 9 - 2, 1, '#caa84a');   // strap label (amber)
        px(bxl + 5, byl + 5, 2, 1, '#1f262b');       // barcode fleck
        ctx.globalAlpha = 1;
      }
    }
    function boxPix(bx, T) {
      const v = DIRV[bx.dir] || [0, 0];
      const cx = (bx.x + 0.5) * T + (bx.prog - 0.5) * T * v[0];
      const cy = (bx.y + 0.5) * T + (bx.prog - 0.5) * T * v[1];
      return { cx, py: cy };
    }

    return { tick, drawBelts, drawBoxes, reset, boxCount: () => boxes.length, peekBoxes: () => boxes.map(b => ({ x: b.x, y: b.y, dir: b.dir, sink: b.sink })) };
  }

  return { create };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Conveyor;
