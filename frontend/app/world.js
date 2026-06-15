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
  let junctions = null;   // splitter/merger/filter routing overrides keyed by tile (rebuilt on geo change)

  /* ---------- canvas + camera ---------- */
  let cv, ctx, raf = 0, last = 0, fnow = 0, running = false, ro = null;
  let scale = 2, panX = 0, panY = 0, fitNeeded = true;
  const MINZ = 0.5, MAXZ = 6;
  const clampz = (v, a, b) => v < a ? a : v > b ? b : v;
  let drag = null, hoverAgent = false, onClick = null, onArcade = null, wakeAt = 0;
  let wakeDark = 0, wakeDarkTarget = 0, awakeFrozen = false;   // the AWAKENING: a darkness veil that lifts to first light, + a freeze so the newborn holds still during its first meeting
  let camAnim = null;                                          // {fromS,toS,fromX,toX,fromY,toY,t,dur,ease,onEnd} — a scripted awakening camera move
  let sparkAt = 0, bornAt = 0, dawnAt = 0, truthPulseAt = 0;   // ignition spark / color-into-being / dawn-bloom / per-truth-flare timestamps
  const stars = [];

  /* ---------- agent ---------- */
  let agent = null, activity = 'idle';
  const footOf = (lx, ly) => ({ x: lx * T + T / 2, y: ly * T + T - 1 });
  const tileOf = (px, py) => ({ x: Math.floor(px / T), y: Math.floor(py / T) });

  /* ---------- awareness & curiosity ----------
     novelty = freshly placed things the agent should wander over and inspect; seen* track what the
     agent has already taken in (null until the first geo is observed, so a fresh station doesn't
     trigger a boot-time inspection storm). Curiosity remarks are short, apostrophe-free, and only
     ever spoken when no real message bubble is live. */
  let novelty = [], seenProps = null, seenBelts = null;
  const NOVELTY_MAX = 4;
  const CURIO_NEW_PROP = ['what is that?', 'new hardware', 'fresh kit', 'ooh, new toy', 'when did this arrive?'];
  const CURIO_NEW_BELT = ['a conveyor!', 'cargo line', 'where does this go?', 'belt is live'];
  const CURIO_WATCH = ['cargo inbound', 'steady flow', 'keep it moving', 'hmm', '...'];
  const CURIO_STUDY = ['interesting', 'huh.', 'noted.', 'fascinating', 'let me see'];
  const CURIO_LOOK = ['hm.', 'all quiet', 'nice station', 'cozy in here', '...'];
  const specOf = t => (typeof PropSprites !== 'undefined' && PropSprites.spec) ? PropSprites.spec(t) : null;
  const dirToward = (fx, fy, tx, ty) => (Math.abs(tx - fx) > Math.abs(ty - fy)) ? (tx > fx ? 'east' : 'west') : (ty > fy ? 'south' : 'north');

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
    novelty = []; seenProps = null; seenBelts = null;   // re-learn the scene from scratch (no cross-station novelty)
    if (station && station.onChange) unsub = station.onChange(() => { geoDirty = true; });
    rederive();
  }

  function rederive() {
    if (!station) return;
    const next = station.projectGeometry();
    const oldOrigin = geo ? geo.origin : null;
    geo = next; T = geo.TILE;
    placeDesk();
    junctions = buildJunctions();
    if (agent) {
      if (agent.unplaced) placeAgent();
      else {
        if (oldOrigin) { const dx = (oldOrigin.tx - geo.origin.tx) * T, dy = (oldOrigin.ty - geo.origin.ty) * T; agent.px += dx; agent.py += dy; }
        agent.pathPts = null; agent.target = null;   // the in-flight path is in the OLD frame — re-path fresh
        if (agent.state === 'walk') { agent.state = 'idle'; agent.idleUntil = 0; }  // target's gone — never leave the agent stuck in the walk pose, or it moonwalks in place forever (tick's idle re-decision is gated on state!=='walk')
        if (agent.goal === 'use' || agent.goal === 'lounge' || agent.goal === 'inspect' || agent.goal === 'watch') { agent.goal = null; agent.usingProp = null; agent.watchProp = null; agent.sitting = false; }  // the prop/belt list may have changed — drop leisure/observation, re-decide next idle tick
        if (agent.goal === 'work' && !agent.working) agent.goal = null;  // was mid-walk to the desk — drop it so tick's summon logic re-paths in the new frame
        if (agent.working && seat) { const f = footOf(seat.tx, seat.ty); agent.px = f.x; agent.py = f.y; agent.dir = 'north'; }  // follow the desk (work only — a lounging agent must NOT teleport to the desk)
        ensureAgentValid();
      }
    }
    scanNovelty();   // diff props/belts vs last frame — anything new becomes a "go check it out" target
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
    agent.goal = null; agent.usingProp = null;
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
      phase: U.hash(a.id) % 6, target: null, pathPts: null, pathIdx: 0, idleUntil: 0, goal: null, say: { text: '', until: 0 },
      usingProp: null, useUntil: 0, useFace: 'south', useSit: false,  // idle leisure: which prop the agent is at + dwell timer + pose
      watchProp: null,   // lounge: the TV the couch-sitter is watching (kept lit while it watches)
      // awareness & curiosity: head-turn glance (drawBody reads agent.glance), study/observe dwell, fidget + notice cooldowns
      glance: null, glanceCd: 0, nextFidget: 0, studyUntil: 0, noticeCd: 0
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
      const wp = toWorld(ev);
      const hit = agentHit(wp);
      if (hit !== hoverAgent) hoverAgent = hit;
      cv.style.cursor = (hit || arcadeAt(wp)) ? 'pointer' : 'default';   // arcade cabinets are clickable too
    });
    cv.addEventListener('mouseup', ev => {
      const wasDrag = drag && drag.moved; drag = null; cv.style.cursor = 'default';
      if (wasDrag) return;
      const wp = toWorld(ev);
      if (agentHit(wp)) { if (onClick) onClick(); return; }
      const arc = arcadeAt(wp);
      if (arc && onArcade) onArcade(arc);
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

  /* ---------- THE AWAKENING — a witnessed birth (cinematic camera + spark + dark->dawn) ----------
     The room opens near-black with the newborn frozen and facing AWAY; a scripted camera pushes in as it
     stirs, holds close through the four self-discovery beats, then pulls back to reveal its whole world at
     dawn. All self-contained + gated to the awakening so it never fights the general camera path. */
  const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const lerpv = (a, b, k) => a + (b - a) * k;
  function camTweenTo(toS, toX, toY, dur, ease, onEnd) {
    camAnim = { fromS: scale, toS: clampz(toS, MINZ, MAXZ), fromX: panX, toX, fromY: panY, toY, t: 0, dur: dur || 1500, ease: ease || easeInOut, onEnd: onEnd || null };
  }
  // a camera target that centers world point (px,py) on screen at zoom sc — 0.46 height leaves headroom above
  function camCenterOn(px, py, sc) { sc = clampz(sc, MINZ, MAXZ); return [sc, cv.width / 2 - px * sc, cv.height * 0.46 - py * sc]; }
  function beginAwakening() { awakeFrozen = true; wakeDark = 0.92; wakeDarkTarget = 0.92; camAnim = null; if (agent) agent.dir = 'north'; }   // newborn faces AWAY until the Turn
  function setWakeProgress(p) { p = p < 0 ? 0 : p > 1 ? 1 : p; wakeDarkTarget = 0.92 * (1 - p); }
  function igniteSpark() { sparkAt = performance.now(); bornAt = performance.now(); wakeDark = 0.985; wakeDarkTarget = 0.985; }   // the mind catches fire — snap to near-total dark so the spark is the ONLY light
  function camPushIn() { if (!cache || !agent || agent.unplaced) return; const [s, x, y] = camCenterOn(agent.px, agent.py - 4, 3.2); camTweenTo(s, x, y, 2600); }
  function camCreep() { if (!cache || !agent || agent.unplaced || camAnim) return; const [s, x, y] = camCenterOn(agent.px, agent.py - 4, scale * 1.035); camTweenTo(s, x, y, 600); }   // a hair closer with each truth
  function camPunch() { if (!agent || agent.unplaced || camAnim) return; const b = scale; const [s1, x1, y1] = camCenterOn(agent.px, agent.py - 4, b * 1.06); const [s0, x0, y0] = camCenterOn(agent.px, agent.py - 4, b); camTweenTo(s1, x1, y1, 150, t => t, () => camTweenTo(s0, x0, y0, 240)); }   // eyes finding yours
  function camPullBack() { if (!cache) return; const W = cache.W, H = cache.H; const s = clampz(Math.min(cv.width / W, cv.height / H), MINZ, MAXZ); camTweenTo(s, (cv.width - W * s) / 2, (cv.height - H * s) / 2, 1700); }   // recompute fit at fire time -> no jump on release
  // the Turn: the newborn finds the Commander — head leads, then the body pivots north -> side -> south and holds your gaze
  function awakenTurn() {
    if (!agent) return;
    const side = (cache && agent.px > cache.W / 2) ? 'west' : 'east';
    setGlance(side, 650, performance.now());
    setTimeout(() => { if (agent) agent.dir = side; }, 240);
    setTimeout(() => { if (agent) setGlance('south', 700, performance.now()); }, 760);
    setTimeout(() => { if (agent) agent.dir = 'south'; }, 1000);
  }
  function truthPulse() { truthPulseAt = performance.now(); }
  function endAwakening() { wakeDarkTarget = 0; dawnAt = performance.now(); wakeIn(); }   // DAWN: light floods + ripple fires (agent stays frozen/facing-you for the final line)
  function releaseAwakening() { awakeFrozen = false; sparkAt = 0; }                        // hand the newborn back to its own autonomous life
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
    if (kind === 'talk') { agent.target = null; agent.pathPts = null; agent.state = 'idle'; agent.sitting = false; agent.working = false; agent.goal = null; agent.usingProp = null; agent.dir = 'south'; }
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
    agent.pathPts = null; agent.target = null; agent.glance = null;
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
    else if (agent.goal === 'use') { agent.sitting = agent.useSit; agent.working = false; agent.dir = agent.useFace; agent.state = 'idle'; agent.useUntil = now + U.irnd(10000, 22000); }
    else if (agent.goal === 'lounge') {
      // settled on the couch, watching the paired TV — sit, face the screen, a longer dwell than a one-off prop
      agent.sitting = true; agent.working = false; agent.dir = agent.useFace; agent.state = 'idle';
      agent.useUntil = now + U.irnd(18000, 30000); agent.glanceCd = 0; agent.nextFidget = now + U.irnd(1500, 3500);
      curiositySay(CURIO_WATCH, 0.4, now);
    }
    else if (agent.goal === 'inspect' || agent.goal === 'watch') {
      // reached the thing — stand, face it, and observe for a spell (belts hold the gaze longer)
      agent.sitting = false; agent.working = false; agent.dir = agent.useFace || 'south'; agent.state = 'idle';
      agent.studyUntil = now + (agent.goal === 'watch' ? U.irnd(6000, 14000) : U.irnd(2600, 6000));
      agent.glanceCd = 0; agent.nextFidget = now + U.irnd(700, 1600);
      if (agent.goal === 'watch') curiositySay(CURIO_WATCH, 0.5, now);
      else curiositySay(agent.inspectNovel ? CURIO_NEW_PROP : CURIO_STUDY, 0.65, now);
    }
    else { agent.state = 'idle'; agent.idleUntil = now + U.irnd(800, 2600); }
  }
  function wander(now) {
    const rects = geo.allRects;
    if (!rects.length) { agent.idleUntil = now + 800; return; }
    const cur = tileOf(agent.px, agent.py);
    const avoid = beltUnion();   // desk footprint + belt tiles: an idle stroll should step AROUND the machinery
    for (let i = 0; i < 24; i++) {
      const r = rects[U.irnd(0, rects.length - 1)];
      const x = U.irnd(r.x1, r.x2), y = U.irnd(r.y1, r.y2);
      if (!geo.walkable(x, y, blocked)) continue;
      if (avoid.has(x + ',' + y)) continue;                  // don't stroll to a belt tile
      let p = geo.path(cur.x, cur.y, x, y, avoid);           // prefer a belt-free route
      if (!p) p = geo.path(cur.x, cur.y, x, y, blocked);     // fall back: a belt bridges the only way across
      if (p && p.length) { agent.goal = null; agent.pathPts = p; agent.pathIdx = 0; agent.state = 'walk'; nextWaypoint(); return; }
    }
    agent.idleUntil = now + 800;
  }

  /* desk footprint ∪ all belt tiles — the soft no-tread set for casual wandering */
  function beltUnion() {
    const s = new Set(blocked);
    const belts = (geo && geo.belts) || [];
    for (const b of belts) s.add(b.x + ',' + b.y);
    return s;
  }

  // the catalog `use` descriptor for a placed prop, or null if it isn't a leisure prop
  function propUse(p) {
    if (typeof PropSprites === 'undefined' || typeof PropAnchor === 'undefined') return null;
    const s = PropSprites.spec(p.t);
    return s && s.use ? s.use : null;
  }

  /* v7 lounge port: a couch placed near a TV → walk over, SIT ON THE COUCH, and watch the TV.
     The sit is IDENTICAL to a normal couch-use — the couch's own front approach tile, the only one
     that reads as sitting ON the couch (the y-sort draws the agent over the couch sprite; any other
     edge leaves it on bare floor, which looks like sitting on a "black chair"). We just turn the
     seated agent to FACE the nearest TV (any direction) and keep that TV lit. gen has no authored
     couch/TV pairs (props placed live in REFIT), so the TV is found by proximity at decision time.
     Returns true if it committed a lounge; false → caller falls back to single-prop use. */
  const LOUNGE_MAXT = 7;
  function tryLounge(now) {
    const couches = [], tvs = [];
    for (const p of geo.props) {
      const use = propUse(p); if (!use) continue;
      if (use.kind === 'couch') couches.push({ p, approach: use.approach || 'south' });
      else if (use.kind === 'tv') tvs.push({ p, cx: p.x + (p.w || 1) / 2, cy: p.y + (p.h || 1) / 2 });
    }
    if (!couches.length || !tvs.length) return false;
    const order = U.irnd(0, couches.length - 1);   // don't always favour the same couch
    for (let k = 0; k < couches.length; k++) {
      const couch = couches[(order + k) % couches.length];
      // sit EXACTLY where a normal couch-use sits (the front edge) so it always looks like sitting on the couch
      const a = PropAnchor.deriveAnchor(couch.p, geo, { approach: couch.approach, sit: true, extra: blocked });
      if (!a) continue;
      // pick the nearest TV within range; the agent turns to face it from the couch (never walks to the TV)
      let best = null;
      for (const tv of tvs) {
        const d = Math.hypot(tv.cx - (a.tx + 0.5), tv.cy - (a.ty + 0.5));
        if (d <= LOUNGE_MAXT && (!best || d < best.d)) best = { tv, d };
      }
      if (!best) continue;
      if (!setPathTo({ x: a.tx, y: a.ty })) continue;
      agent.goal = 'lounge'; agent.usingProp = couch.p.id; agent.watchProp = best.tv.p.id;
      agent.useFace = dirToward(a.tx, a.ty, best.tv.cx, best.tv.cy);   // sit on the couch, head turned to the TV
      agent.useSit = true;
      if (!agent.target) arrive(now);   // already on the sit tile
      return true;
    }
    return false;
  }

  // idle leisure: pick a reachable interactive prop (couch/tv/arcade/jukebox/bar), walk to
  // its approach tile, and commit to goal='use'. Returns false if none is reachable (→ wander).
  function planProp(now) {
    if (!geo || !geo.props || !geo.props.length) return false;
    if (tryLounge(now)) return true;   // couch + TV in front of it → sit and watch (the v7 lounge)
    const cands = [];
    for (const p of geo.props) {
      const use = propUse(p); if (!use) continue;
      const a = PropAnchor.deriveAnchor(p, geo, { approach: use.approach || 'south', sit: !!use.sit, extra: blocked });
      if (a) cands.push({ id: p.id, a });
    }
    if (!cands.length) return false;
    const start = U.irnd(0, cands.length - 1);   // random offset, but try each prop at most once
    for (let k = 0; k < cands.length; k++) {
      const c = cands[(start + k) % cands.length];
      if (setPathTo({ x: c.a.tx, y: c.a.ty })) {
        agent.goal = 'use'; agent.usingProp = c.id; agent.useFace = c.a.face; agent.useSit = c.a.sit;
        if (!agent.target) arrive(now);   // already standing on the approach tile
        return true;
      }
    }
    return false;
  }

  /* ---------- awareness: notice new placements ---------- */
  // diff this frame's props/belts against what the agent has already taken in; queue the additions
  function scanNovelty() {
    const props = (geo && geo.props) || [], belts = (geo && geo.belts) || [];
    const propIds = new Set(props.map(p => p.id));
    const beltKeys = new Set(belts.map(b => b.x + ',' + b.y));
    if (seenProps === null) { seenProps = propIds; seenBelts = beltKeys; return; }   // first look: learn the scene, react to nothing
    for (const p of props) {
      if (seenProps.has(p.id)) continue;
      pushNovelty(Math.floor(p.x + (p.w || 1) / 2), Math.floor(p.y + (p.h || 1) / 2), 'prop', p.id);
    }
    for (const b of belts) {                       // a long run lands as one tile-flag, not a spam of them
      if (seenBelts.has(b.x + ',' + b.y)) continue;
      pushNovelty(b.x, b.y, 'belt', null); break;
    }
    seenProps = propIds; seenBelts = beltKeys;
  }
  function pushNovelty(tx, ty, kind, pid) {
    novelty = novelty.filter(n => !(n.tx === tx && n.ty === ty));   // dedupe the same tile
    novelty.push({ tx, ty, kind, pid });
    if (novelty.length > NOVELTY_MAX) novelty.shift();
    if (agent && activity === 'idle') agent.idleUntil = Math.min(agent.idleUntil || 0, fnow + 350);   // react within ~1s
  }

  /* pixel position of the nearest riding belt box, or null (for gaze-tracking cargo) */
  function nearestBox() {
    if (!convey || !convey.peekBoxes) return null;
    const boxes = convey.peekBoxes(); if (!boxes || !boxes.length) return null;
    const DV = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
    let best = null, bd = Infinity;
    for (const b of boxes) {
      if (b.sink > 0) continue;
      const v = DV[b.dir] || [0, 0];
      const bx = (b.x + 0.5 + (b.prog - 0.5) * v[0]) * T, by = (b.y + 0.5 + (b.prog - 0.5) * v[1]) * T;
      const d = Math.hypot(bx - agent.px, by - agent.py);
      if (d < bd) { bd = d; best = { x: bx, y: by, d }; }
    }
    return best;
  }

  function setGlance(dir, ms, now) { if (agent) agent.glance = { dir, until: now + ms }; }

  // go inspect the freshest queued placement (pops the queue; tries each until one is reachable)
  function planInspect(now) {
    while (novelty.length) {
      const n = novelty.pop();
      let foot = { x: n.tx, y: n.ty, w: 1, h: 1 };
      if (n.kind === 'prop' && n.pid && geo.props) { const p = geo.props.find(q => q.id === n.pid); if (!p) continue; foot = p; }
      const extra = n.kind === 'belt' ? beltUnion() : blocked;   // for a belt, stand beside it — not on the machinery
      const a = PropAnchor.deriveAnchor(foot, geo, { approach: 'auto', extra });
      if (a && setPathTo({ x: a.tx, y: a.ty })) {
        agent.goal = 'inspect'; agent.useFace = a.face; agent.usingProp = null; agent.inspectNovel = true;
        if (!agent.target) arrive(now);
        return true;
      }
    }
    return false;
  }

  // ambient curiosity (no fresh placement): study a machine or watch a belt go by
  function planPOI(now) {
    const cands = [];
    const belts = (geo && geo.belts) || [];
    if (belts.length) { const b = belts[U.irnd(0, belts.length - 1)]; cands.push({ kind: 'watch', foot: { x: b.x, y: b.y, w: 1, h: 1 }, extra: beltUnion() }); }
    const props = (geo && geo.props) || [];
    const machines = props.filter(p => { const s = specOf(p.t); return s && !s.use && s.blocks; });   // non-leisure kit (leisure is planProp's job)
    if (machines.length) { const p = machines[U.irnd(0, machines.length - 1)]; cands.push({ kind: 'inspect', foot: p, extra: blocked }); }
    if (cands.length === 2 && U.chance(0.5)) cands.reverse();
    for (const c of cands) {
      const a = PropAnchor.deriveAnchor(c.foot, geo, { approach: 'auto', extra: c.extra });
      if (a && setPathTo({ x: a.tx, y: a.ty })) {
        agent.goal = c.kind; agent.useFace = a.face; agent.usingProp = null; agent.inspectNovel = false;
        if (!agent.target) arrive(now);
        return true;
      }
    }
    return false;
  }

  // pan the gaze around without moving — "taking the place in"
  function lookAround(now) {
    const dir = U.pick(['east', 'west', 'south', 'north']);
    setGlance(dir, U.irnd(600, 1100), now); agent.dir = dir;
    agent.idleUntil = now + U.irnd(900, 2200);
    if (U.chance(0.15)) curiositySay(CURIO_LOOK, 1, now);
  }

  // the idle menu: new things first, then lounging / studying-a-machine / watching-a-belt, and
  // failing those (or by default) mostly stroll — but pause to look around a fair bit too.
  function decideIdle(now) {
    if (novelty.length && planInspect(now)) return;
    const r = U.irnd(0, 99);
    if (r < 30 && planProp(now)) return;
    if (r < 55 && planPOI(now)) return;
    if (U.chance(0.4)) lookAround(now); else wander(now);
  }

  // head-turns that sell "alive": track passing cargo, fidget at the desk, glance at new kit, look around
  function maybeGlance(now) {
    if (!agent || agent.unplaced || activity === 'talk') return;
    if (agent.state === 'walk') return;                              // walking owns the facing
    if (agent.glance && agent.glance.until > now) return;
    if (now < (agent.glanceCd || 0)) return;
    // watching a belt → follow the nearest box
    if (agent.goal === 'watch') {
      const box = nearestBox();
      if (box && box.d < 80) { setGlance(dirToward(agent.px, agent.py, box.x, box.y), U.irnd(500, 900), now); agent.glanceCd = now + U.irnd(700, 1400); return; }
    }
    // lounging on the couch: eyes settle on the TV (base facing), with the odd glance around the room
    if (agent.goal === 'lounge') {
      if (U.chance(0.25)) { setGlance(U.pick(['east', 'west', 'south']), U.irnd(400, 800), now); agent.glanceCd = now + U.irnd(2600, 5200); }
      else agent.glanceCd = now + U.irnd(1200, 2400);
      return;
    }
    // working at the desk: glance at a freshly placed thing nearby, else fidget-look up from the screen
    if (agent.working) {
      if (novelty.length) {
        const n = novelty[novelty.length - 1], nx = (n.tx + 0.5) * T, ny = (n.ty + 0.5) * T;
        if (Math.hypot(nx - agent.px, ny - agent.py) < 130) {
          setGlance(dirToward(agent.px, agent.py, nx, ny), U.irnd(700, 1200), now); agent.glanceCd = now + U.irnd(3000, 5000);
          curiositySay(n.kind === 'belt' ? CURIO_NEW_BELT : CURIO_NEW_PROP, 0.4, now); return;
        }
      }
      if (now > (agent.nextFidget || 0)) { setGlance(U.pick(['east', 'west', 'south']), U.irnd(500, 950), now); agent.nextFidget = now + U.irnd(9000, 20000); agent.glanceCd = now + 3000; }
      return;
    }
    // a box trundles past an idle agent → a quick look over
    if (U.chance(0.6)) { const box = nearestBox(); if (box && box.d < 46) { setGlance(dirToward(agent.px, agent.py, box.x, box.y), U.irnd(400, 800), now); agent.glanceCd = now + U.irnd(3500, 6000); return; } }
    // idle / studying: occasional ambient look around
    if ((agent.goal === 'inspect' || agent.goal == null) && U.chance(0.5)) { setGlance(U.pick(['east', 'west', 'south', 'north']), U.irnd(450, 850), now); agent.glanceCd = now + U.irnd(2500, 5000); }
  }

  // a short curiosity remark — only when nothing real is on screen, and only sometimes
  function curiositySay(lines, prob, now) {
    if (!lines || !lines.length || !agent) return;
    if (agent.say && agent.say.until > now) return;   // never stomp a live (real) message
    if (!U.chance(prob)) return;
    say(U.pick(lines));
  }

  function tick(dt, now) {
    if (!agent || agent.unplaced || !geo || awakeFrozen) return;   // frozen during the awakening: the newborn holds still, facing the Commander
    const SPEED = 34;
    // self-heal a stuck walker: the walk pose with nowhere to go (target + path both gone —
    // e.g. a REFIT re-bake cleared the in-flight path, or a path came back empty). The idle
    // re-decision below is gated on state !== 'walk', so without this the legs cycle in place
    // forever (moonwalk). Drop to idle and let this same tick re-path / re-summon.
    if (agent.state === 'walk' && !agent.target && (!agent.pathPts || agent.pathIdx >= agent.pathPts.length)) {
      agent.state = 'idle'; agent.idleUntil = 0;
    }
    if (activity === 'task' && agent.goal !== 'work') {
      agent.goal = 'work'; agent.sitting = false; agent.working = false; agent.usingProp = null; agent.watchProp = null;   // summoned: get up off any prop and head to the desk
      if (!seat || !setPathTo({ x: seat.tx, y: seat.ty })) { /* already at seat or unreachable */ if (seat) { const f = footOf(seat.tx, seat.ty); agent.px = f.x; agent.py = f.y; agent.sitting = true; agent.working = true; agent.dir = 'north'; } }
    }
    if (activity !== 'task' && agent.goal === 'work') {
      agent.goal = null; agent.sitting = false; agent.working = false; agent.pathPts = null; agent.target = null; agent.state = 'idle'; agent.idleUntil = now + 200;
    }
    // freshly placed thing + free to roam → divert and go check it out (even mid-stroll), throttled
    if (activity === 'idle' && novelty.length && agent.goal === null && !agent.working && !agent.sitting && now >= (agent.noticeCd || 0)) {
      if (planInspect(now)) agent.noticeCd = now + 1500;
    }
    maybeGlance(now);   // head-turns over the top of whatever else the agent is doing
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
    } else if (agent.goal === 'use') {
      // lounging at a prop: hold the pose until the dwell timer ends, then drift back to wandering
      if (now >= agent.useUntil) { agent.goal = null; agent.usingProp = null; agent.sitting = false; agent.state = 'idle'; agent.idleUntil = now + U.irnd(400, 1200); }
    } else if (agent.goal === 'lounge') {
      // sitting on the couch watching the TV: maybeGlance animates the gaze; clear both props when done
      if (now >= agent.useUntil) { agent.goal = null; agent.usingProp = null; agent.watchProp = null; agent.sitting = false; agent.state = 'idle'; agent.idleUntil = now + U.irnd(400, 1200); }
    } else if (agent.goal === 'inspect' || agent.goal === 'watch') {
      // observing a machine / belt: hold the gaze until the study timer ends (maybeGlance animates it)
      if (now >= agent.studyUntil) { agent.goal = null; agent.usingProp = null; agent.state = 'idle'; agent.idleUntil = now + U.irnd(500, 1500); }
    } else if (activity === 'idle' && agent.state !== 'walk' && !agent.sitting && now >= agent.idleUntil) {
      decideIdle(now);
    }
  }

  /* ---------- render ---------- */
  function frame(now) {
    const dt = Math.min(64, now - last); last = now; fnow = now;
    if (wakeDark !== wakeDarkTarget) { wakeDark += (wakeDarkTarget - wakeDark) * Math.min(1, dt / 260); if (Math.abs(wakeDark - wakeDarkTarget) < 0.002) wakeDark = wakeDarkTarget; }
    if (camAnim) {   // the scripted awakening camera owns {scale,panX,panY} while a move runs
      camAnim.t = Math.min(1, camAnim.t + dt / camAnim.dur);
      const k = camAnim.ease(camAnim.t);
      scale = lerpv(camAnim.fromS, camAnim.toS, k); panX = lerpv(camAnim.fromX, camAnim.toX, k); panY = lerpv(camAnim.fromY, camAnim.toY, k);
      if (camAnim.t >= 1) { const oe = camAnim.onEnd; camAnim = null; if (oe) oe(); }
    }
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
    if (fitNeeded && !camAnim) { fitCamera(); fitNeeded = false; }   // the scripted awakening camera owns the transform while it runs
    ctx.setTransform(scale, 0, 0, scale, panX, panY); ctx.imageSmoothingEnabled = false;

    ctx.drawImage(cache.baseCv, 0, 0);

    // conveyor belts (floor machinery) + the live transport sim — local frame, under entities
    if (geo && geo.belts && typeof Conveyor !== 'undefined') {
      if (!convey) convey = Conveyor.create({ onDeliver: onWorkitemDeliver });
      convey.tick(dt, now, geo.belts, junctions);
      convey.drawBelts(ctx, now, T, geo.belts);
    }

    const items = [];
    // placeable props (furniture) — drawn over the bake, y-sorted with agents, under the lightmap
    if (geo && geo.props && geo.props.length && typeof PropSprites !== 'undefined') {
      PropSprites.setCtx(ctx); PropSprites.setNow(now);
      const outboxLit = now - lastOutboxFlash < 600;   // the OUTBOX flares for 600ms after a reply dispatches
      for (const p of geo.props) {
        const work = (p.t === 'outbox' && outboxLit) || !!(agent && (agent.usingProp === p.id || agent.watchProp === p.id));
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
    drawAwakenLight(now);   // the soul kindling: ignition spark + a growing halo + motes (world-space additive, awakening only)
    // the AWAKENING veil — now a SPOTLIGHT on the newborn (center light, corners dark) that warms cold->dawn,
    // drawn UNDER the speech bubble so its first words still glow while the room is dark.
    if (wakeDark > 0.002) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const prog = Math.max(0, Math.min(1, 1 - wakeDark / 0.92));
      const tr = Math.round(2 + prog * 12), tg = Math.round(3 + prog * 5), tb = Math.round(8 - prog * 4);   // cold blue-black -> warm ember
      if (agent && !agent.unplaced) {
        const ax = agent.px * scale + panX, ay = (agent.py - 8) * scale + panY;
        const r0 = 22 * scale, r1 = Math.max(r0 + 12, Math.min(cv.width, cv.height) * 0.62);
        const g = ctx.createRadialGradient(ax, ay, r0, ax, ay, r1);
        g.addColorStop(0, 'rgba(' + tr + ',' + tg + ',' + tb + ',' + (wakeDark * 0.16).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(' + tr + ',' + tg + ',' + tb + ',' + wakeDark.toFixed(3) + ')');
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = 'rgba(' + tr + ',' + tg + ',' + tb + ',' + wakeDark.toFixed(3) + ')';
      }
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.setTransform(scale, 0, 0, scale, panX, panY);
    }
    if (dawnAt && now - dawnAt < 1300) drawDawnBloom(now);   // the room takes its first breath of light
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

  // the soul kindling: an ignition spark at the head, a halo that grows with consciousness, drifting motes.
  function drawAwakenLight(now) {
    if (!agent || agent.unplaced) return;
    const live = awakeFrozen || (dawnAt && now - dawnAt < 1200);
    if (!live && !(sparkAt && now - sparkAt < 1200)) return;
    const prog = Math.max(0, Math.min(1, 1 - wakeDark / 0.92));
    const pulse = (truthPulseAt && now - truthPulseAt < 360) ? (1 - (now - truthPulseAt) / 360) : 0;   // a flare as each truth is written in
    const hx = agent.px, hy = agent.py - 12;
    ctx.globalCompositeOperation = 'lighter';
    // halo
    const hr = 14 + prog * 30 + pulse * 10;
    let g = ctx.createRadialGradient(hx, hy, 1, hx, hy, hr);
    g.addColorStop(0, 'rgba(255,236,200,' + (0.05 + 0.13 * prog + pulse * 0.12).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255,236,200,0)');
    ctx.fillStyle = g; ctx.fillRect(hx - hr, hy - hr, hr * 2, hr * 2);
    // ignition spark — the discrete instant the mind catches fire (the ONLY light in the dark)
    if (sparkAt && now - sparkAt < 1100) {
      const t = (now - sparkAt) / 1100;
      const flick = t < 0.4 ? (Math.sin(now / 26) > 0 ? 1 : 0.35) : 1;
      const sr = 2 + t * 9, a = flick * (t < 0.5 ? 0.95 : Math.max(0, 0.95 * (1 - (t - 0.5) / 0.5)));
      const gs = ctx.createRadialGradient(hx, hy, 0.5, hx, hy, sr);
      gs.addColorStop(0, 'rgba(255,252,240,' + a.toFixed(3) + ')'); gs.addColorStop(1, 'rgba(255,252,240,0)');
      ctx.fillStyle = gs; ctx.fillRect(hx - sr, hy - sr, sr * 2, sr * 2);
    }
    // motes of consciousness — slow orbital, thicken as it wakes (computed from time, no state to leak)
    if (live) {
      const n = Math.floor(5 + 9 * prog);
      for (let i = 0; i < n; i++) {
        const seed = i * 1.7, ang = now / 1500 + seed * 2.4, rad = 9 + (i % 5) * 4 + Math.sin(now / 760 + seed) * 2;
        const mx = hx + Math.cos(ang) * rad, my = hy + Math.sin(ang) * rad * 0.5;
        const tw = 0.3 + 0.5 * Math.abs(Math.sin(now / 520 + seed));
        ctx.fillStyle = 'rgba(255,244,214,' + (0.38 * tw * (0.4 + 0.6 * prog)).toFixed(3) + ')';
        ctx.fillRect(mx - 0.6, my - 0.6, 1.4, 1.4);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  // dawn bloom — a brief warm wash flooding the whole room as the veil reaches light
  function drawDawnBloom(now) {
    const t = (now - dawnAt) / 1300, a = Math.sin(Math.min(1, t) * Math.PI) * 0.2;
    if (a <= 0.003) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'lighter';
    const cx = cv.width / 2, cy = cv.height * 0.46, r = Math.max(cv.width, cv.height) * 0.75;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,214,150,' + a.toFixed(3) + ')'); g.addColorStop(1, 'rgba(255,214,150,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.globalCompositeOperation = 'source-over'; ctx.setTransform(scale, 0, 0, scale, panX, panY);
  }

  function drawAgent(now) {
    // color-into-being: the body fades up from a faint silhouette to full as the spark blooms (sprite path)
    let bornA = 1;
    if (bornAt && now - bornAt < 1000) bornA = 0.16 + 0.84 * ((now - bornAt) / 1000);
    const prevA = ctx.globalAlpha;
    if (bornA < 1) ctx.globalAlpha = prevA * bornA;
    let geom = null;
    if (typeof SPRITES !== 'undefined' && SPRITES.ready) geom = SPRITES.drawBody(ctx, agent, now);
    if (!geom) drawFallback(now);
    ctx.globalAlpha = prevA;
    // the wake ripple — a triple-ringed sonar pulse of first breath, in the suit color
    if (wakeAt && now - wakeAt < 1500) {
      ctx.save(); ctx.strokeStyle = agent.color;
      for (let k = 0; k < 3; k++) {
        const tk = (now - wakeAt) / 1300 - k * 0.18;
        if (tk <= 0 || tk >= 1) continue;
        ctx.globalAlpha = (1 - tk) * 0.6 * (1 - k * 0.22); ctx.lineWidth = Math.max(0.5, 1.5 - tk);
        ctx.beginPath(); ctx.ellipse(agent.px, agent.py, 4 + tk * 22, 2 + tk * 9, 0, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
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
  function setOnArcade(fn) { onArcade = fn; }
  // hit-test: the arcade cabinet prop under a world-space point (null if none). The cabinet
  // art spills a few px below its tile footprint, so extend the box down to keep it clickable.
  function arcadeAt(wp) {
    if (!geo || !geo.props) return null;
    for (const p of geo.props) {
      const s = specOf(p.t);
      if (!s || !s.use || s.use.kind !== 'arcade') continue;
      const x0 = p.x * T, y0 = p.y * T - 2;
      const x1 = (p.x + (p.w || s.w || 1)) * T, y1 = (p.y + (p.h || s.h || 1)) * T + 8;
      if (wp.x >= x0 && wp.x < x1 && wp.y >= y0 && wp.y < y1) return p;
    }
    return null;
  }

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
  // junction props (splitter/...) keyed by tile — the conveyor routes boxes at these tiles
  function buildJunctions() {
    let j = null;
    if (geo && geo.props) for (const p of geo.props) {
      if (p.t === 'splitter') (j = j || new Map()).set(p.x + ',' + p.y, { kind: 'split' });
    }
    return j;
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

  return { init, loadStation, spawn, start, stop, setActivity, wakeIn, beginAwakening, setWakeProgress, igniteSpark, camPushIn, camCreep, camPunch, camPullBack, awakenTurn, truthPulse, endAwakening, releaseAwakening, say, getActivity: () => activity, getUse: () => (agent ? agent.usingProp : null), setOnClick, setOnArcade, refit };
})();
