/* SKYNET — world.js : the LIVE station the agent lives inside.

   Renders the player-built WorldModel station (multi-room) with the generalized
   procedural bake (stationbake.js), under a pan/zoom camera. The agent has a
   workstation in its spawn room and ACTUALLY WALKS the rooms + corridors — pathing
   through doors via the model's BFS path() — to reach its seat when given a task,
   then wanders the whole reachable station when idle. Edits made in REFIT build mode
   re-bake the world live (the agent re-homes if the floor under it is reclaimed).

   Coordinate frame: everything here is in the bake's LOCAL tile frame (tile*TILE px);
   the camera maps local→screen. The WorldModel's world/local offset is handled inside
   projectGeometry(); when the station grows north/west the origin shifts and the agent
   is translated to stay put. */
'use strict';

const World = (() => {
  let T = 12;

  /* ---------- station + bake cache ---------- */
  let station = null, geo = null, cache = null, geoDirty = true, bakeDirty = true, unsub = null;
  let desk = null, seat = null, blocked = new Set();   // desk footprint (local tiles) blocks pathing
  let convey = null;   // live conveyor transport sim (boxes riding the belts)

  /* ---------- canvas + camera ---------- */
  let cv, ctx, raf = 0, last = 0, fnow = 0, running = false, ro = null;
  let scale = 2, panX = 0, panY = 0, fitNeeded = true;
  const MINZ = 0.5, MAXZ = 6;
  const clampz = (v, a, b) => v < a ? a : v > b ? b : v;
  let drag = null, hoverAgent = false, onClick = null, wakeAt = 0;
  const stars = [];

  /* ---------- agent ---------- */
  let agent = null, activity = 'idle';
  const footOf = (lx, ly) => ({ x: lx * T + T / 2, y: ly * T + T - 1 });
  const tileOf = (px, py) => ({ x: Math.floor(px / T), y: Math.floor(py / T) });

  /* ================= furniture (ported v7 sprites.js F.desk / F.chair) ================= */
  const fpx = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  const fblink = (p, ph) => ((fnow / p + (ph || 0)) % 1) < 0.5;
  const fscrCols = ['#62ff9e', '#3fd07c', '#7adfb0', '#2fa863'];
  const fscr = (ph) => fscrCols[Math.floor((fnow / 700 + ph) % fscrCols.length)];
  const fsh = (x, y, w) => { ctx.globalAlpha = 0.22; fpx(x, y, w, 2, '#000'); ctx.globalAlpha = 1; };
  const fglow = (x, y, w, h, c, a) => { ctx.globalAlpha = a; fpx(x, y, w, h, c); ctx.globalAlpha = 1; };
  const fbox = (x, y, w, h, c) => {
    fpx(x - 1, y - 1, w + 2, h + 2, '#06090c'); fpx(x, y, w, h, c);
    fpx(x, y, w, 1, U.shade(c, 0.28)); fpx(x, y + h - 1, w, 1, U.shade(c, -0.4));
    fpx(x + w - 1, y + 1, 1, h - 2, U.shade(c, -0.22)); fpx(x, y + 1, 1, h - 2, U.shade(c, 0.08));
  };
  const finset = (x, y, w, h, c) => { fpx(x, y, w, h, U.shade(c, -0.6)); fpx(x + 1, y + 1, w - 2, h - 2, c); fpx(x + 1, y + 1, w - 2, 1, U.shade(c, -0.3)); };
  const fseamH = (x, y, w, c) => { fpx(x, y, w, 1, U.shade(c, -0.45)); fpx(x, y + 1, w, 1, U.shade(c, 0.14)); };
  const frivets = (x, y, w, h, lc, dc) => { fpx(x, y, 1, 1, lc); fpx(x + w - 1, y, 1, 1, lc); fpx(x, y + h - 1, 1, 1, dc); fpx(x + w - 1, y + h - 1, 1, 1, dc); };
  const fwear = (x, y, w, h, n, c) => { if (w < 4 || h < 4) return; for (let i = 0; i < n; i++) { const hx = U.hash('w' + x + ',' + y + ',' + i); fpx(x + 1 + (hx % (w - 2)), y + 1 + ((hx >> 5) % (h - 2)), 1 + (hx % 2), 1, c); } };
  const fscanl = (x, y, w, h, a) => { ctx.globalAlpha = a; for (let j = 1; j < h; j += 2) fpx(x, y + j, w, 1, '#000'); ctx.globalAlpha = 1; };

  function F_desk(x, y, w, h, f) {
    fsh(x + 1, y + h, w - 2);
    fbox(x, y + 3, w, h - 2, '#343e46');
    fpx(x + 1, y + 4, w - 2, h - 4, '#414d56');
    fpx(x + 1, y + 4, w - 2, 1, '#54626c');
    fpx(x + 1, y + 4, 6, 1, '#64727c');
    fseamH(x + 1, y + h - 3, w - 2, '#414d56');
    fpx(x + w - 8, y + h - 2, 3, 1, '#2a343c');
    frivets(x + 1, y + 4, w - 2, h - 5, '#5e6c76', '#222b32');
    fwear(x + 1, y + 4, w - 2, h - 5, 3, '#37424a');
    fpx(x + 5, y + 4, 2, 1, '#1a241e'); fpx(x + 4, y + 5, 4, 1, '#222c26');
    fbox(x + 2, y - 3, 8, 7, '#1a241e'); fpx(x + 3, y - 3, 6, 1, '#2c3a30');
    finset(x + 3, y - 2, 6, 5, '#0d150f');
    if (f.work) {
      fpx(x + 4, y - 1, 4, 3, fscr(f.x)); fpx(x + 4, y - 1, 2, 1, '#dfffe8');
      fpx(x + 4, y + 1, 3, 1, U.shade(fscr(f.x), -0.3));
      if (fblink(180, f.x)) fpx(x + 4, y - 1, 3, 1, '#dfffe8');
      fpx(x + 7, y + 1, 1, 1, fblink(400, f.x) ? '#dfffe8' : '#101a14');
      fscanl(x + 4, y - 1, 4, 3, 0.2);
      fglow(x + 2, y + 4, 8, 2, fscr(f.x), 0.18); fglow(x + 3, y - 2, 6, 5, fscr(f.x), 0.10);
    } else {
      fpx(x + 4, y - 1, 4, 3, '#101a14'); fpx(x + 4, y - 1, 1, 1, '#1c2a22');
      fpx(x + 9, y + 2, 1, 1, fblink(1600) ? '#ff9d2e' : '#33241a');
    }
    fpx(x + 9, y + 4, 1, 2, '#222b32');
    finset(x + 13, y + 6, 6, 3, '#262e2a'); fpx(x + 14, y + 7, 4, 1, '#39443e'); fpx(x + 14, y + 7, 2, 1, '#46544a');
    fpx(x + 20, y + 7, 1, 1, '#39443e'); fpx(x + 20, y + 7, 1, 1, '#46544a');
    fpx(x + 2, y + 8, 2, 2, '#3a6a62'); fpx(x + 2, y + 8, 2, 1, '#5aa89c');
    if (f.work && fblink(700)) fpx(x + 3, y + 6, 1, 1, '#8a8a8a');
    fpx(x + 11, y + 5, 2, 2, '#ffe066'); fpx(x + 11, y + 5, 2, 1, '#fff0a8');
  }

  function F_chair(x, y) {
    ctx.globalAlpha = 0.2; fpx(x + 3, y + 9, 6, 2, '#000'); ctx.globalAlpha = 1;
    fpx(x + 3, y + 1, 6, 2, '#3a4a40'); fpx(x + 3, y + 1, 6, 1, '#46584c');
    fpx(x + 3, y + 1, 1, 2, '#41544a'); fpx(x + 8, y + 1, 1, 2, '#2e3c34');
    fpx(x + 4, y + 2, 4, 1, '#33413a');
    fpx(x + 3, y + 3, 6, 6, '#2e3a34');
    fpx(x + 4, y + 4, 4, 2, '#39463f'); fpx(x + 4, y + 4, 4, 1, '#41504a');
    fpx(x + 4, y + 6, 1, 1, '#27322c'); fpx(x + 7, y + 6, 1, 1, '#27322c');
    fpx(x + 3, y + 8, 6, 1, '#242e29');
    fpx(x + 5, y + 9, 2, 1, '#39434b'); fpx(x + 5, y + 9, 1, 1, '#46535c');
    fpx(x + 4, y + 10, 1, 1, '#222'); fpx(x + 7, y + 10, 1, 1, '#222');
    fpx(x + 5, y + 10, 2, 1, '#2a2a2a'); fpx(x + 4, y + 11, 1, 1, '#1a1a1a'); fpx(x + 7, y + 11, 1, 1, '#1a1a1a');
  }

  /* ================= station model + bake ================= */
  function loadStation(st) {
    if (unsub) { unsub(); unsub = null; }
    station = st; geo = null; cache = null; geoDirty = true; bakeDirty = true; fitNeeded = true;
    if (station && station.onChange) unsub = station.onChange(() => { geoDirty = true; });
    rederive();
  }

  function rederive() {
    if (!station) return;
    const next = station.projectGeometry();
    const oldOrigin = geo ? geo.origin : null;
    geo = next; T = geo.TILE;
    placeDesk();
    if (agent) {
      if (agent.unplaced) placeAgent();
      else {
        if (oldOrigin) { const dx = (oldOrigin.tx - geo.origin.tx) * T, dy = (oldOrigin.ty - geo.origin.ty) * T; agent.px += dx; agent.py += dy; }
        agent.pathPts = null; agent.target = null;   // the in-flight path is in the OLD frame — re-path fresh
        if ((agent.sitting || agent.working) && seat) { const f = footOf(seat.tx, seat.ty); agent.px = f.x; agent.py = f.y; agent.dir = 'north'; }  // follow the desk
        ensureAgentValid();
      }
    }
    geoDirty = false; bakeDirty = true;
  }

  function rebake() {
    if (geoDirty || !geo) rederive();
    if (!geo) return;
    cache = StationBake.bake(geo);
    bakeDirty = false;
  }

  // the workstation: a 2-wide desk on the spawn room's north wall, seat one row below
  function placeDesk() {
    const sid = station.spawnRoomId(), z = sid && geo.zones[sid];
    blocked = new Set();
    if (!z || (z.x2 - z.x1) < 1 || (z.y2 - z.y1) < 1) { desk = seat = null; return; }
    let dtx = z.x1 + Math.max(1, Math.floor((z.x2 - z.x1) / 2));
    if (dtx + 1 > z.x2) dtx = Math.max(z.x1, z.x2 - 1);
    const dty = Math.min(z.y1 + 1, z.y2 - 1);
    desk = { tx: dtx, ty: dty, w: 2, h: 1 };
    seat = { tx: dtx, ty: Math.min(dty + 1, z.y2) };
    blocked.add(dtx + ',' + dty); blocked.add((dtx + 1) + ',' + dty);
  }

  function spawnTileLocal() {
    const sid = station.spawnRoomId(), z = sid && geo.zones[sid];
    const cx = z ? ((z.x1 + z.x2) >> 1) : (geo.COLS >> 1);
    const cy = z ? ((z.y1 + z.y2) >> 1) : (geo.ROWS >> 1);
    if (geo.walkable(cx, cy, blocked)) return { x: cx, y: cy };
    for (let r = 1; r < 14; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (geo.walkable(cx + dx, cy + dy, blocked)) return { x: cx + dx, y: cy + dy };
    }
    return { x: cx, y: cy };
  }

  function placeAgent() {
    const t = spawnTileLocal(), f = footOf(t.x, t.y);
    agent.px = f.x; agent.py = f.y; agent.unplaced = false;
    agent.pathPts = null; agent.target = null; agent.sitting = false; agent.working = false; agent.state = 'idle';
  }

  function ensureAgentValid() {
    const cur = tileOf(agent.px, agent.py);
    if (geo.walkable(cur.x, cur.y, blocked)) return;
    placeAgent();   // floor reclaimed under the agent — re-home to the spawn room
  }

  /* ---------- agent lifecycle ---------- */
  function spawn(a) {
    agent = {
      id: a.id, name: a.name, color: a.color || '#5ad0ff',
      px: 0, py: 0, dir: 'south', state: 'idle', sitting: false, working: false, unplaced: true,
      phase: U.hash(a.id) % 6, target: null, pathPts: null, pathIdx: 0, idleUntil: 0, goal: null, say: { text: '', until: 0 }
    };
    if (geo) placeAgent();
  }

  function init(canvas) {
    cv = canvas; ctx = cv.getContext('2d');
    if (!stars.length) for (let i = 0; i < 90; i++) stars.push({ x: Math.random(), y: Math.random(), r: Math.random() < 0.85 ? 1 : 2, ph: Math.random() * 10 });
    resize();
    try { if (ro) ro.disconnect(); ro = new ResizeObserver(() => { resize(); fitNeeded = true; }); ro.observe(cv.parentElement || cv); } catch (e) {}
    window.addEventListener('resize', resize);

    cv.addEventListener('wheel', ev => {
      ev.preventDefault();
      const c = toCanvas(ev), wx = (c.x - panX) / scale, wy = (c.y - panY) / scale;
      scale = clampz(scale * Math.exp(-ev.deltaY * 0.0015), MINZ, MAXZ);
      panX = c.x - wx * scale; panY = c.y - wy * scale;
    }, { passive: false });
    cv.addEventListener('mousedown', ev => { const c = toCanvas(ev); drag = { sx: c.x, sy: c.y, moved: false }; });
    cv.addEventListener('mousemove', ev => {
      if (drag) {
        const c = toCanvas(ev);
        panX += c.x - drag.sx; panY += c.y - drag.sy; drag.sx = c.x; drag.sy = c.y; drag.moved = true;
        cv.style.cursor = 'grabbing'; return;
      }
      const hit = agentHit(toWorld(ev));
      if (hit !== hoverAgent) { hoverAgent = hit; cv.style.cursor = hit ? 'pointer' : 'default'; }
    });
    cv.addEventListener('mouseup', ev => {
      const wasDrag = drag && drag.moved; drag = null; cv.style.cursor = 'default';
      if (!wasDrag && agentHit(toWorld(ev)) && onClick) onClick();
    });
    cv.addEventListener('mouseleave', () => { hoverAgent = false; if (!drag) cv.style.cursor = 'default'; });
    connectChannelBridge();   // open the SSE bridge so real inbound work animates as boxes on the belts
  }

  function resize() {
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || cv.parentElement.clientWidth, h = cv.clientHeight || cv.parentElement.clientHeight;
    cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr));
  }

  function start() { if (running) return; running = true; last = performance.now(); frame(last); }
  function stop() { running = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  function wakeIn() { wakeAt = performance.now(); }
  function refit() { fitNeeded = true; }
  function say(text) {
    if (!agent) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    agent.say = { text: t.slice(0, 160), until: performance.now() + 4200 };
  }
  /* kind: 'task' (walk to the workstation + work) | 'talk' (face the Commander) | 'idle' (wander the station) */
  function setActivity(kind) {
    activity = kind;
    if (!agent) return;
    if (kind === 'talk') { agent.target = null; agent.pathPts = null; agent.state = 'idle'; agent.sitting = false; agent.working = false; agent.goal = null; agent.dir = 'south'; }
  }

  /* ---------- camera helpers ---------- */
  function fitCamera() {
    if (!cache) return;
    const W = cache.W, H = cache.H;
    scale = clampz(Math.min(cv.width / W, cv.height / H), MINZ, MAXZ);
    panX = (cv.width - W * scale) / 2; panY = (cv.height - H * scale) / 2;
  }
  function toCanvas(ev) {
    const r = cv.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (cv.width / r.width), y: (ev.clientY - r.top) * (cv.height / r.height) };
  }
  function toWorld(ev) { const c = toCanvas(ev); return { x: (c.x - panX) / scale, y: (c.y - panY) / scale }; }
  function agentHit(wp) {
    if (!agent || agent.unplaced) return false;
    const dx = wp.x - agent.px, dy = wp.y - agent.py;
    return (dx * dx + dy * dy) < 14 * 14;
  }

  /* ---------- pathing + behaviour ---------- */
  function setPathTo(dest) {
    agent.pathPts = null; agent.target = null;
    if (!dest || !geo) return false;
    const cur = tileOf(agent.px, agent.py);
    const p = geo.path(cur.x, cur.y, dest.x, dest.y, blocked);
    if (!p) return false;
    agent.pathPts = p; agent.pathIdx = 0; agent.state = 'walk';
    nextWaypoint();
    return true;
  }
  function nextWaypoint() {
    if (!agent.pathPts || agent.pathIdx >= agent.pathPts.length) { agent.target = null; return; }
    const wp = agent.pathPts[agent.pathIdx++];
    agent.target = footOf(wp.x, wp.y);
  }
  function arrive(now) {
    agent.pathPts = null; agent.target = null;
    if (agent.goal === 'work') { agent.sitting = true; agent.working = true; agent.dir = 'north'; agent.state = 'idle'; }
    else { agent.state = 'idle'; agent.idleUntil = now + U.irnd(800, 2600); }
  }
  function wander(now) {
    const rects = geo.allRects;
    if (!rects.length) { agent.idleUntil = now + 800; return; }
    const cur = tileOf(agent.px, agent.py);
    for (let i = 0; i < 24; i++) {
      const r = rects[U.irnd(0, rects.length - 1)];
      const x = U.irnd(r.x1, r.x2), y = U.irnd(r.y1, r.y2);
      if (!geo.walkable(x, y, blocked)) continue;
      const p = geo.path(cur.x, cur.y, x, y, blocked);
      if (p && p.length) { agent.goal = null; agent.pathPts = p; agent.pathIdx = 0; agent.state = 'walk'; nextWaypoint(); return; }
    }
    agent.idleUntil = now + 800;
  }

  function tick(dt, now) {
    if (!agent || agent.unplaced || !geo) return;
    const SPEED = 34;
    if (activity === 'task' && agent.goal !== 'work') {
      agent.goal = 'work'; agent.sitting = false; agent.working = false;
      if (!seat || !setPathTo({ x: seat.tx, y: seat.ty })) { /* already at seat or unreachable */ if (seat) { const f = footOf(seat.tx, seat.ty); agent.px = f.x; agent.py = f.y; agent.sitting = true; agent.working = true; agent.dir = 'north'; } }
    }
    if (activity !== 'task' && agent.goal === 'work') {
      agent.goal = null; agent.sitting = false; agent.working = false; agent.pathPts = null; agent.target = null; agent.state = 'idle'; agent.idleUntil = now + 200;
    }
    if (agent.target) {
      const dx = agent.target.x - agent.px, dy = agent.target.y - agent.py, d = Math.hypot(dx, dy);
      if (d < 1.1) {
        agent.px = agent.target.x; agent.py = agent.target.y;
        if (agent.pathPts && agent.pathIdx < agent.pathPts.length) nextWaypoint();
        else arrive(now);
      } else {
        const s = Math.min(d, SPEED * dt / 1000);
        agent.px += dx / d * s; agent.py += dy / d * s; agent.state = 'walk';
        agent.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north');
      }
    } else if (activity === 'idle' && agent.state !== 'walk' && !agent.sitting && now >= agent.idleUntil) {
      wander(now);
    }
  }

  /* ---------- render ---------- */
  function frame(now) {
    const dt = Math.min(64, now - last); last = now; fnow = now;
    if (geoDirty) rederive();
    if (bakeDirty || !cache) rebake();
    tick(dt, now);

    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#040302'; ctx.fillRect(0, 0, cv.width, cv.height);
    for (const s of stars) {
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(now / (900 + s.ph * 300) + s.ph));
      ctx.fillStyle = 'rgba(180,200,230,' + tw + ')';
      ctx.fillRect((s.x * cv.width + now / 1000 * 8) % cv.width, s.y * cv.height, s.r, s.r);
    }

    if (!cache) { if (running) raf = requestAnimationFrame(frame); return; }
    if (fitNeeded) { fitCamera(); fitNeeded = false; }
    ctx.setTransform(scale, 0, 0, scale, panX, panY); ctx.imageSmoothingEnabled = false;

    ctx.drawImage(cache.baseCv, 0, 0);

    // conveyor belts (floor machinery) + the live transport sim — local frame, under entities
    if (geo && geo.belts && typeof Conveyor !== 'undefined') {
      if (!convey) convey = Conveyor.create({ onDeliver: onWorkitemDeliver });
      convey.tick(dt, now, geo.belts);
      convey.drawBelts(ctx, now, T, geo.belts);
    }

    const items = [];
    // placeable props (furniture) — drawn over the bake, y-sorted with agents, under the lightmap
    if (geo && geo.props && geo.props.length && typeof PropSprites !== 'undefined') {
      PropSprites.setCtx(ctx); PropSprites.setNow(now);
      const outboxLit = now - lastOutboxFlash < 600;   // the OUTBOX flares for 600ms after a reply dispatches
      for (const p of geo.props) {
        const work = p.t === 'outbox' && outboxLit;
        items.push({ y: (p.y + (p.h || 1)) * T, draw: () => PropSprites.draw(p, work) });
      }
    }
    if (desk) items.push({ y: (desk.ty + desk.h) * T, draw: () => F_desk(desk.tx * T, desk.ty * T, desk.w * T, desk.h * T, { x: desk.tx, work: !!(agent && agent.working) }) });
    if (seat) items.push({ y: (seat.ty + 1) * T, draw: () => F_chair(seat.tx * T, seat.ty * T) });
    if (agent && !agent.unplaced) items.push({ y: agent.py, draw: () => drawAgent(now) });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
    if (convey) convey.drawBoxes(ctx, now, T);   // boxes ride on top of the belts

    ctx.drawImage(cache.lightCv, 0, 0);
    drawGlows(now);
    if (agent && !agent.unplaced) drawBubble(now);
    if (agent && !agent.unplaced && hoverAgent) drawNameTag();
    drawQueueDepth();   // screen-space backpressure gauge (resets transform; drawn last)

    if (running) raf = requestAnimationFrame(frame);
  }

  function drawGlows(now) {
    if (!cache || !cache.flickers) return;
    ctx.globalCompositeOperation = 'lighter';
    for (const f of cache.flickers) {
      const a = Math.max(0, 0.085 * (0.55 + 0.45 * Math.sin(now / 210 + f.x) * Math.sin(now / 83 + f.y)));
      const g = ctx.createRadialGradient(f.x, f.y, 1, f.x, f.y, f.r * 0.7);
      g.addColorStop(0, 'rgba(240,230,206,' + a + ')'); g.addColorStop(1, 'rgba(240,230,206,0)');
      ctx.fillStyle = g; ctx.fillRect(f.x - f.r * 0.7, f.y - f.r * 0.7, f.r * 1.4, f.r * 1.4);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawAgent(now) {
    let geom = null;
    if (typeof SPRITES !== 'undefined' && SPRITES.ready) geom = SPRITES.drawBody(ctx, agent, now);
    if (!geom) drawFallback(now);
    if (wakeAt && now - wakeAt < 1300) {
      const t = (now - wakeAt) / 1300;
      ctx.save(); ctx.globalAlpha = (1 - t) * 0.8; ctx.strokeStyle = agent.color; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(agent.px, agent.py, 4 + t * 16, 2 + t * 7, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
  }

  function drawFallback(now) {
    const a = agent, x = Math.round(a.px), y = Math.round(a.py), h = 13;
    const step = a.state === 'walk' ? (Math.floor(now / 140) % 2) : 0;
    const bob = (a.state !== 'walk' && !a.sitting) ? Math.round(Math.sin(now / 600 + a.phase) * 0.7) : 0;
    ctx.globalAlpha = 0.3; ctx.fillStyle = '#000'; ctx.fillRect(x - 4, y - 1, 8, 2); ctx.globalAlpha = 1;
    const top = y - h + bob;
    ctx.fillStyle = a.color; ctx.fillRect(x - 3, top + 3, 6, h - 6);
    ctx.fillStyle = '#f0e6c0'; ctx.fillRect(x - 2, top, 5, 4);
    ctx.fillStyle = U.shade(a.color, -0.45);
    if (a.sitting) ctx.fillRect(x - 3, y - 3, 6, 2);
    else { ctx.fillRect(x - 3 + (step ? 1 : 0), y - 2, 2, 2); ctx.fillRect(x + 1 - (step ? 1 : 0), y - 2, 2, 2); }
  }

  function drawNameTag() {
    ctx.save();
    ctx.font = '9px monospace';
    const label = agent.name;
    const tw = ctx.measureText(label).width, bw = tw + 8, bh = 11;
    const bx = Math.round(agent.px - bw / 2), by = Math.round(agent.py - 30);
    ctx.fillStyle = 'rgba(4,3,2,0.88)'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = agent.color; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    ctx.fillStyle = agent.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, agent.px, by + bh / 2);
    ctx.restore();
  }

  function drawBubble(now) {
    const s = agent.say;
    if (!s.text || s.until < now) return;
    ctx.font = '8px monospace';
    const maxW = 96, padb = 3, lh = 9;
    const words = s.text.split(' '), lines = []; let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; if (lines.length >= 3) break; } else line = test;
    }
    if (line && lines.length < 3) lines.push(line);
    if (lines.length === 3) lines[2] = lines[2].replace(/.{0,2}$/, '…');
    const bw = Math.min(maxW, Math.max(...lines.map(l => ctx.measureText(l).width))) + padb * 2;
    const bh = lines.length * lh + padb * 2;
    let bx = Math.round(agent.px - bw / 2); const by = Math.round(agent.py - 22 - bh);
    bx = Math.max(2, Math.min((cache ? cache.W : 9999) - bw - 2, bx));
    ctx.fillStyle = 'rgba(3,2,1,0.92)'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#ffaa33'; ctx.lineWidth = 1; ctx.strokeRect(bx + .5, by + .5, bw - 1, bh - 1);
    ctx.fillStyle = '#ffaa33'; ctx.fillRect(Math.round(agent.px) - 1, by + bh, 3, 2);
    ctx.fillStyle = '#ffd9a3'; ctx.textAlign = 'left';
    lines.forEach((l, i) => ctx.fillText(l, bx + padb, by + padb + lh * (i + 1) - 2));
  }

  function setOnClick(fn) { onClick = fn; }

  /* ---------- work-item pipeline: the conveyor carries REAL inbound work to the agent ----------
     A real admitted message (Telegram) arrives over the SSE bridge as `workitem.placed`; we drop a
     box at the INTAKE prop so it rides the player-laid belts to the desk. Pure visualization — if no
     INTAKE/belt path exists, nothing rides (the sidecar already ran the work either way). */
  const chanQueues = new Map();   // queueId -> depth (from queue.status) — drives the backpressure HUD
  let bridged = false, lastOutboxFlash = -1e9;

  // a belt tile on/adjacent to a footprint (its tiles + a 1-tile ring), used as a box spawn point (local frame)
  function beltTileNear(tx, ty, tw, th) {
    if (!geo || !geo.belts || !geo.belts.length) return null;
    const beltSet = new Set(geo.belts.map(b => b.x + ',' + b.y));
    for (let yy = ty - 1; yy <= ty + th; yy++)
      for (let xx = tx - 1; xx <= tx + tw; xx++)
        if (beltSet.has(xx + ',' + yy)) return { x: xx, y: yy };
    return null;
  }
  function intakeTile() {
    const intake = geo && geo.props && geo.props.find(p => p.t === 'intake');
    return intake ? beltTileNear(intake.x, intake.y, intake.w || 1, intake.h || 1) : null;
  }
  // a real inbound message arrived — drop a box at the INTAKE so it rides the belts to the desk
  function intakeMessage(payload) {
    if (!convey) return;
    const t = intakeTile();
    if (t) convey.enqueueAt(t.x, t.y, payload || {});
  }
  // the agent's reply heads out — enqueue an OUTBOUND box at a desk-adjacent belt tile, riding to the OUTBOX
  function outboundMessage(payload) {
    if (!convey || !desk) return;
    const t = beltTileNear(desk.tx, desk.ty, desk.w, desk.h);
    if (t) convey.enqueueAt(t.x, t.y, { outbound: true, workitemId: (payload && payload.workitemId) || '' });
  }
  // a payload box reached an open end: inbound -> the agent receives it; outbound -> the OUTBOX dispatches it
  function onWorkitemDeliver(bx) {
    const p = (bx && bx.payload) || {};
    if (p.outbound) { lastOutboxFlash = fnow; return; }   // reply reached the OUTBOX -> flash the chute
    say('received: ' + (p.preview || 'message'));
    wakeIn();
  }
  // one app-level EventSource: re-emit validated channel/work-item events onto U.bus, and react in-world
  function connectChannelBridge() {
    if (bridged || typeof U === 'undefined' || !U.bus) return;
    bridged = true;
    U.bus.on('workitem.placed', p => intakeMessage(p));
    U.bus.on('workitem.delivered', p => outboundMessage(p));
    U.bus.on('workitem.superseded', p => { if (p && p.workitemId && convey) convey.dropWorkitem(p.workitemId); });
    U.bus.on('queue.status', p => { if (p && p.queueId != null) chanQueues.set(p.queueId, Math.max(0, p.depth | 0)); });
    if (typeof EventSource === 'undefined') return;
    let es = null, backoff = 1000;
    const open = () => {
      try { es = new EventSource('/api/channels/events'); } catch (_) { return; }
      es.onopen = () => { backoff = 1000; };
      es.onmessage = ev => { try { const m = JSON.parse(ev.data); if (m && m.name) U.bus.emit(m.name, m.payload); } catch (_) {} };
      es.onerror = () => { try { es.close(); } catch (_) {} es = null; setTimeout(open, backoff); backoff = Math.min(15000, backoff * 2); };
    };
    open();
  }
  // bottom-right INTAKE queue-depth gauge — backpressure made visible (screen-space overlay)
  function drawQueueDepth() {
    let depth = 0; for (const d of chanQueues.values()) depth += d;
    if (depth <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false;
    const W = cv.width / dpr, H = cv.height / dpr, pad = 8, bw = 88, bh = 16;
    const x = W - bw - pad, y = H - bh - pad;
    ctx.fillStyle = 'rgba(8,10,9,0.85)'; ctx.fillRect(x, y, bw, bh);
    ctx.strokeStyle = '#caa84a'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
    ctx.fillStyle = '#e8c860'; ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('INTAKE ' + '▮'.repeat(Math.min(6, depth)) + ' ' + depth, x + 6, y + bh / 2 + 0.5);
  }

  return { init, loadStation, spawn, start, stop, setActivity, wakeIn, say, getActivity: () => activity, setOnClick, refit };
})();
