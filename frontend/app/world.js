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
  let routingPlan = null, lastPlanHash = null;   // compiled RoutingPlan (Pipeline) — drives junctions + the sidecar dispatch

  /* ---------- canvas + camera ---------- */
  let cv, ctx, raf = 0, last = 0, fnow = 0, running = false, ro = null;
  let scale = 2, panX = 0, panY = 0, fitNeeded = true;
  const MINZ = 0.5, MAXZ = 6;
  const clampz = (v, a, b) => v < a ? a : v > b ? b : v;
  let drag = null, hoverAgent = false, onClick = null, onArcade = null, wakeAt = 0;
  let camLerp = null;   // {scale,panX,panY} target — a gentle one-on-one framing for voice conversations
  let wakeDark = 0, wakeDarkTarget = 0, awakeFrozen = false;   // the AWAKENING: a darkness veil that lifts to first light, + a freeze so the newborn holds still during its first meeting
  let camAnim = null;                                          // {fromS,toS,fromX,toX,fromY,toY,t,dur,ease,onEnd} — a scripted awakening camera move
  let sparkAt = 0, bornAt = 0, dawnAt = 0, truthPulseAt = 0;   // ignition spark / color-into-being / dawn-bloom / per-truth-flare timestamps
  let floodAt = 0, floodEndAt = 0, floodStreams = null;        // THE FLOOD: screen-space data-cascade — start / collapse-trigger / seeded streams
  const stars = [];

  /* reduced-motion (the warroom honesty floor): heavy motion — pulses/blinks — goes steady when the OS
     asks for less motion. Live-read so a runtime setting change is honored without a reload. */
  const _rmq = (typeof window !== 'undefined' && window.matchMedia) ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduceMotion = () => !!(_rmq && _rmq.matches);

  /* ---------- agent + crew ----------
     `agent` is the HERO (crew[0] conceptually): the active agent, with the full state machine — walking,
     awakening, novelty, glances, couch lounging. `crew` is the EXTRA bodies: the OTHER agents bound to BAY
     props, rendered as LIGHT static figures standing at their bays (no pathing/AI — they just receive work
     and light up). Empty crew === today's exact single-agent world; every crew code path is gated so the
     hero behaves byte-for-byte as before. The crew is derived from the RoutingPlan's bays (syncCrewFromPlan). */
  let agent = null, activity = 'idle';
  let crew = [];
  const CREW_COLORS = ['#5ad0ff', '#ff8a5a', '#7df08a', '#e0a0ff', '#ffd45a', '#5affd0', '#ff6a9a'];
  const crewColor = aid => CREW_COLORS[U.hash('' + aid) % CREW_COLORS.length];
  const footOf = (lx, ly) => ({ x: lx * T + T / 2, y: ly * T + T - 1 });
  const tileOf = (px, py) => ({ x: Math.floor(px / T), y: Math.floor(py / T) });
  // where the agent is DRAWN: on its couch seat when seated, otherwise its logical foot position
  const rposX = () => (agent && agent.seated) ? agent.seatPx : agent.px;
  const rposY = () => (agent && agent.seated) ? agent.seatPy : agent.py;

  /* couch seat reservation (multi-agent seam): "propId:slot" of every taken seat. One agent drives
     world.js today, so this holds at most its own claim — but it's the shared occupancy a second
     agent would consult to take a different cushion (or a different couch). */
  const occupiedSeats = new Set();

  /* ---------- awareness & curiosity ----------
     novelty = freshly placed things the agent should wander over and inspect; seen* track what the
     agent has already taken in (null until the first geo is observed, so a fresh station doesn't
     trigger a boot-time inspection storm). Curiosity remarks are short, apostrophe-free, and only
     ever spoken when no real message bubble is live. */
  let novelty = [], seenProps = null, seenBelts = null;
  const NOVELTY_MAX = 4;
  let lastSelfTalk = -1e9;          // global self-talk cooldown — bubbles stay rare, honest thoughts (never a monologue)
  const seenCount = new Map();      // habituation: how many times a prop-id / belt-tile has been studied (novel -> familiar)
  /* First-person self-talk — ONE conscious mind narrating its OWN state to itself. Never crew/colony
     banter (a lie for a solo agent). Every line is gated by curiositySay (no live bubble + global
     cooldown + the chatty trait), so they read as rare honest thoughts tied to the true inner state. */
  const CURIO_NEW_PROP = ['what is that?', 'thats new', 'when did this arrive?', 'let me see this', 'new hardware'];
  const CURIO_NEW_BELT = ['a conveyor!', 'where does this go?', 'a new line', 'that wasnt here before'];
  const CURIO_WATCH = ['cargo moving', 'busy line today', 'steady flow', 'there it goes', 'keep it moving'];
  const CURIO_STUDY = ['how does this run', 'let me look closer', 'curious', 'noted', 'interesting'];
  const CURIO_LOOK = ['hm.', 'all quiet', 'good station', '...', 'just taking it in'];
  const SELF_REST = ['need a breather', 'feet up for a bit', 'recharge', 'easy for a minute', 'resting the circuits'];
  const SELF_STIM = ['too quiet', 'something to do', 'restless', 'let me find something', 'need a spark'];
  const SELF_TEND = ['anything for me?', 'standing by', 'awaiting orders', 'still here, Commander', 'ready when you are'];
  const SELF_ONDUTY = ['on it', 'parsing', 'let me think', 'working it', 'processing'];
  const SELF_QUIET = ['...', 'cycles to spare', 'so quiet', 'just me and the stars', 'standing by'];
  const SELF_CONTEMPLATE = ['quiet out there', 'so much void', 'just... processing', 'the stars again', 'endless out there'];
  const SELF_DISPATCH = ['sent', 'delivered', 'thats away', 'reply is out', 'done and gone'];
  const SELF_GREET = ['yes, Commander?', 'still here', 'watching', 'at your service', 'go ahead'];
  const SELF_ACK = ['hm?', 'yes?', 'still here', 'watching'];
  /* QUIRKS — rare, gated, deliberately UNPREDICTABLE one-offs that surface an off-screen inner life
     (the "why did it just do that" beats). Eerie via stillness + ambiguity, never spooky one-liners.
     Lines stay sparse and unresolved; the SILENCE is the unsettling part. */
  let quirkCd = 0;   // quirks stay special — long cooldown between them
  const Q_PONDER = ['hm.', '...', 'i wonder', 'strange', 'thinking'];
  const Q_STARE = ['...', 'are you there?', 'hello.', 'still watching?', 'hm.'];   // mostly it just stares in silence
  const Q_LISTEN = ['did you hear that?', 'something moved', '...', 'who is there'];
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
    crew = [];                                          // no cross-station crew bodies (rebuilt from the new floor's bays)
    if (station && station.onChange) unsub = station.onChange(() => { geoDirty = true; });
    rederive();
  }

  function rederive() {
    if (!station) return;
    const next = station.projectGeometry();
    const oldOrigin = geo ? geo.origin : null;
    geo = next; T = geo.TILE;
    placeDesk();
    compileRouting();              // recompile the RoutingPlan (+ POST to the sidecar) — the single point floor edits flow through
    junctions = buildJunctions();
    syncCrewFromPlan();            // reconcile the light crew bodies with the plan's bound bays
    if (agent) {
      if (agent.unplaced) placeAgent();
      else {
        if (oldOrigin) { const dx = (oldOrigin.tx - geo.origin.tx) * T, dy = (oldOrigin.ty - geo.origin.ty) * T; agent.px += dx; agent.py += dy; }
        agent.pathPts = null; agent.target = null;   // the in-flight path is in the OLD frame — re-path fresh
        if (agent.state === 'walk') { agent.state = 'idle'; agent.idleUntil = 0; }  // target's gone — never leave the agent stuck in the walk pose, or it moonwalks in place forever (tick's idle re-decision is gated on state!=='walk')
        if (agent.goal === 'use' || agent.goal === 'lounge' || agent.goal === 'inspect' || agent.goal === 'watch' || agent.goal === 'tend' || agent.goal === 'gaze' || agent.goal === 'quirk' || agent.goal === 'stare') { releaseSeat(); agent.goal = null; agent.usingProp = null; agent.watchProp = null; agent.studyKey = null; agent.quirkKind = null; agent.sitting = false; }  // the prop/belt list may have changed — drop leisure/observation/quirk, re-decide next idle tick
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
    releaseSeat();   // re-homing → drop any couch seat claim + on-couch render
    const t = spawnTileLocal(), f = footOf(t.x, t.y);
    agent.px = f.x; agent.py = f.y; agent.unplaced = false;
    agent.pathPts = null; agent.target = null; agent.sitting = false; agent.working = false; agent.state = 'idle';
    agent.goal = null; agent.usingProp = null; agent.watchProp = null;
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
      // seat-on-couch: logical pos stays on the approach tile, but it RENDERS at seat{Px,Py} ON the couch
      seated: false, seatPx: 0, seatPy: 0, seatKey: null, pendSeat: null,
      // awareness & curiosity: head-turn glance (drawBody reads agent.glance), study/observe dwell, fidget + notice cooldowns
      glance: null, glanceCd: 0, nextFidget: 0, studyUntil: 0, noticeCd: 0, studyKey: null,
      // INNER LIFE: a fixed temperament + three slow-draining needs that drive WHICH goal it pursues
      pers: makePersonality(a.id),
      needs: { rest: U.irnd(72, 92), stim: U.irnd(72, 92), social: U.irnd(72, 92) },   // born content; drifts into wants over the first minute
      lastTaskAt: 0, thinkUntil: 0, settleUntil: 0, trackUntil: 0,   // machine-state timers (think-before-work, settle-before-typing, downtime, body-track)
      quirkKind: null   // which rare quirk is currently playing (drives the gaze flavor in maybeGlance)
    };
    if (geo) placeAgent();
  }

  /* a stable temperament derived from the agent id (no RNG — same agent feels the same across a session).
     pace = walk speed; restless = how fast it re-decides + paces; curious/homebody/chatty bias the idle menu + self-talk. */
  function makePersonality(id) {
    const h = s => U.hash(id + ':' + s);
    return {
      pace: 0.88 + (h('pace') % 30) / 100,       // 0.88 .. 1.17
      restless: 0.55 + (h('restless') % 90) / 100, // 0.55 .. 1.44
      curious: 0.45 + (h('curious') % 75) / 100,  // 0.45 .. 1.19
      homebody: 0.45 + (h('homebody') % 75) / 100, // 0.45 .. 1.19
      chatty: 0.55 + (h('chatty') % 70) / 100,    // 0.55 .. 1.24
    };
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
      camLerp = null;   // the user is driving the camera — stop any in-progress focus ease
    }, { passive: false });
    cv.addEventListener('mousedown', ev => { camLerp = null; const c = toCanvas(ev); drag = { sx: c.x, sy: c.y, moved: false }; });
    cv.addEventListener('mousemove', ev => {
      if (drag) {
        const c = toCanvas(ev);
        panX += c.x - drag.sx; panY += c.y - drag.sy; drag.sx = c.x; drag.sy = c.y; drag.moved = true;
        cv.style.cursor = 'grabbing'; return;
      }
      const wp = toWorld(ev);
      const hit = agentHit(wp);
      // rising edge: it notices the Commander's cursor land on it and turns to meet you
      if (hit && !hoverAgent && agent && activity === 'idle' && !agent.working) { setGlance('south', 900, performance.now()); curiositySay(SELF_ACK, 0.3, performance.now()); }
      if (hit !== hoverAgent) hoverAgent = hit;
      cv.style.cursor = (hit || arcadeAt(wp)) ? 'pointer' : 'default';   // arcade cabinets are clickable too
    });
    cv.addEventListener('mouseup', ev => {
      const wasDrag = drag && drag.moved; drag = null; cv.style.cursor = 'default';
      if (wasDrag) return;
      const wp = toWorld(ev);
      if (agentHit(wp)) {
        if (agent && activity !== 'task') { agent.dir = 'south'; setGlance('south', 1000, performance.now()); curiositySay(SELF_GREET, 0.8, performance.now()); }   // eye contact for the Commander
        if (onClick) onClick(); return;
      }
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
  function releaseAwakening() { awakeFrozen = false; sparkAt = 0; floodAt = 0; floodEndAt = 0; floodStreams = null; }   // hand the newborn back to its own autonomous life
  /* THE FLOOD — the rush of waking into vast knowledge. A screen-space cascade of streaming phosphor
     tokens (seeded with REAL forming-prompt + capability fragments passed in, padded with glyph noise —
     never fake facts) builds to overwhelming density, then collapseFlood() pulls every glyph inward into
     the newborn's mind. Deterministic per stream after seeding so the frame is stable. */
  const FLOOD_GLYPHS = '01<>/\\{}[]()=+*#%&@|;:.01_-01アイウエオカキクケコ10サシスセソ01';
  function beginFlood(words) {
    floodAt = performance.now(); floodEndAt = 0;
    const pool = (Array.isArray(words) ? words : []).map(s => String(s || '').trim()).filter(Boolean);
    const N = 30, streams = [];
    for (let i = 0; i < N; i++) {
      const len = 9 + Math.floor(Math.random() * 12), toks = [];
      for (let j = 0; j < len; j++) {
        if (pool.length && Math.random() < 0.24) toks.push(pool[Math.floor(Math.random() * pool.length)]);
        else { let s = ''; const gl = 1 + Math.floor(Math.random() * 2); for (let k = 0; k < gl; k++) s += FLOOD_GLYPHS[Math.floor(Math.random() * FLOOD_GLYPHS.length)]; toks.push(s); }
      }
      streams.push({ x: (i + 0.5) / N + (Math.random() - 0.5) * 0.012, speed: 70 + Math.random() * 150, size: 12 + Math.floor(Math.random() * 7), delay: Math.random() * 1100, toks, len });
    }
    floodStreams = streams;
  }
  function collapseFlood() { if (floodAt && !floodEndAt) floodEndAt = performance.now(); }   // pull the cascade inward into the mind
  function refit() { fitNeeded = true; }
  function say(text, opts) {
    if (!agent) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    agent.say = { text: t.slice(0, 160), until: performance.now() + 4200 };
    // ambient station-life remarks are muttered ALOUD too (when the agent has a voice and isn't
    // mid-conversation) so the station feels lived-in. Real replies are spoken by chat.js, not here,
    // so only {ambient:true} lines speak — and pure filler ("...", "hmm") stays a silent bubble.
    if (opts && opts.ambient && typeof Voice !== 'undefined' && Voice.mutter
        && /[a-z]/i.test(t) && !/^h+m+[.…]?$/i.test(t)) {
      Voice.mutter(t);
    }
  }
  /* kind: 'task' (walk to the workstation + work) | 'talk' (face the Commander) | 'idle' (wander the station) */
  function setActivity(kind) {
    activity = kind;
    if (!agent) return;
    if (kind === 'talk') { releaseSeat(); agent.target = null; agent.pathPts = null; agent.state = 'idle'; agent.sitting = false; agent.working = false; agent.goal = null; agent.usingProp = null; agent.watchProp = null; agent.dir = 'south'; }
  }

  /* ---------- camera helpers ---------- */
  // ease the camera to frame the agent for a one-on-one voice conversation — but only NUDGE: bail if he's
  // already comfortably on-screen and not tiny, so it never fights a deliberate pan/zoom. Self-cancels on
  // manual input (wheel/drag clear camLerp). Called from chat.js when a spoken turn begins.
  function focusAgent(opts) {
    if (!agent || agent.unplaced || !cache) return;
    opts = opts || {};
    const sx = agent.px * scale + panX, sy = agent.py * scale + panY;
    const margin = 48;
    const onScreen = sx > margin && sx < cv.width - margin && sy > margin && sy < cv.height - margin;
    const small = scale < 2.2;
    if (onScreen && !small && !opts.force) return;
    const target = clampz(Math.max(scale, 3), MINZ, MAXZ);
    camLerp = { scale: target, panX: cv.width / 2 - agent.px * target, panY: cv.height * 0.56 - agent.py * target };
  }
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
    const dx = wp.x - rposX(), dy = wp.y - rposY();
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
    if (agent.goal === 'work') { agent.sitting = true; agent.working = false; agent.dir = 'north'; agent.state = 'idle'; agent.settleUntil = now + U.irnd(450, 900); }   // sit a beat (loading context) before the screens light + typing starts
    else if (agent.goal === 'use') { agent.sitting = agent.useSit; agent.working = false; agent.dir = agent.useFace; agent.state = 'idle'; agent.useUntil = now + U.irnd(10000, 22000); takeSeat(); if (agent.useSit && agent.needs.rest < 35) curiositySay(SELF_REST, 0.4, now); }
    else if (agent.goal === 'lounge') {
      // settled ON the couch, watching the paired TV — sit, face the screen, a longer dwell than a one-off prop
      agent.sitting = true; agent.working = false; agent.dir = agent.useFace; agent.state = 'idle';
      agent.useUntil = now + U.irnd(18000, 30000); agent.glanceCd = 0; agent.nextFidget = now + U.irnd(1500, 3500);
      takeSeat(); curiositySay(agent.needs.rest < 35 ? SELF_REST : CURIO_WATCH, 0.45, now);
    }
    else if (agent.goal === 'inspect' || agent.goal === 'watch' || agent.goal === 'tend' || agent.goal === 'gaze') {
      // reached the thing — stand, face it, observe for a spell. Familiar things hold the gaze less (habituation).
      agent.sitting = false; agent.working = false; agent.dir = agent.useFace || 'south'; agent.state = 'idle';
      agent.glanceCd = 0; agent.nextFidget = now + U.irnd(700, 1600);
      const fam = agent.studyKey ? (seenCount.get(agent.studyKey) || 0) : 0, famK = 1 / (1 + fam * 0.8);
      if (agent.studyKey) seenCount.set(agent.studyKey, fam + 1);
      if (agent.goal === 'tend') { agent.studyUntil = now + U.irnd(3500, 8000); curiositySay(agent.needs.social < 30 ? SELF_TEND : SELF_QUIET, 0.5, now); }
      else if (agent.goal === 'gaze') { agent.studyUntil = now + U.irnd(4000, 8000); curiositySay(SELF_CONTEMPLATE, 0.5, now); }
      else if (agent.goal === 'watch') { agent.studyUntil = now + U.irnd(6000, 14000) * famK; curiositySay(CURIO_WATCH, 0.5 * famK, now); }
      else { agent.studyUntil = now + U.irnd(2600, 6000) * famK; curiositySay(agent.inspectNovel ? CURIO_NEW_PROP : CURIO_STUDY, (agent.inspectNovel ? 0.7 : 0.55) * famK, now); }
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

  /* free this agent's claimed seat (idempotent) and drop the on-couch render offset */
  function releaseSeat() {
    if (!agent) return;
    if (agent.seatKey) occupiedSeats.delete(agent.seatKey);
    agent.seatKey = null; agent.seated = false; agent.pendSeat = null;
  }
  /* on arrival, snap the render position onto the cushion claimed at plan time (logical pos stays put) */
  function takeSeat() {
    if (agent.seatKey && agent.pendSeat) { agent.seated = true; agent.seatPx = agent.pendSeat.px; agent.seatPy = agent.pendSeat.py; agent.pendSeat = null; }
  }

  /* v7 sit-ON-the-couch: a couch is a blocking prop (you can't path onto it), so the agent walks to
     a tile ADJACENT to a free cushion, then RENDERS on that cushion while the couch is y-sorted just
     behind it — exactly v7's sitTiles + sitPy trick. Seats are the inner footprint columns (an arm
     is skipped at each end on a wide couch). Each cushion is reserved in occupiedSeats so a second
     agent takes a different one (or, when the couch is full, planProp moves on to another couch).
     tvId != null → goal 'lounge' (watch + light the TV); else a plain couch sit. */
  const LOUNGE_MAXT = 7;
  const SEAT_NB = [[0, 1], [0, -1], [1, 0], [-1, 0]];   // approach a cushion from any walkable neighbour
  function planCouchSit(now, couch, tvId, faceDir) {
    const w = couch.w || 1, h = couch.h || 1;
    const lo = w >= 3 ? 1 : 0, hi = w >= 3 ? w - 2 : w - 1;   // skip an arm tile each end when wide
    const slots = [];
    for (let i = lo; i <= hi; i++) if (!occupiedSeats.has(couch.id + ':' + i)) slots.push(i);
    if (!slots.length) return false;                          // couch full → caller tries another couch
    const order = U.irnd(0, slots.length - 1);                // vary which cushion is taken
    for (let k = 0; k < slots.length; k++) {
      const slot = slots[(order + k) % slots.length];
      const sx = couch.x + slot, sy = couch.y;                // the couch tile the agent will sit on
      for (const [dx, dy] of SEAT_NB) {
        const ax = sx + dx, ay = sy + dy;
        if (!geo.walkable(ax, ay, blocked)) continue;
        if (!setPathTo({ x: ax, y: ay })) continue;
        occupiedSeats.add(couch.id + ':' + slot); agent.seatKey = couch.id + ':' + slot;
        agent.pendSeat = { px: (sx + 0.5) * T, py: (couch.y + h) * T - 2 };   // render foot at the cushion front
        agent.goal = tvId ? 'lounge' : 'use'; agent.usingProp = couch.id; agent.watchProp = tvId || null;
        agent.useSit = true; agent.useFace = faceDir || 'south';
        if (!agent.target) arrive(now);                       // already adjacent → sit immediately
        return true;
      }
    }
    return false;
  }

  /* couch + a TV nearby → sit on the couch and watch it. The pairing is derived live (gen has no
     authored couch/TV pairs): for each couch, the nearest TV within range, faced from the couch. */
  function tryLounge(now) {
    const couches = [], tvs = [];
    for (const p of geo.props) {
      const use = propUse(p); if (!use) continue;
      if (use.kind === 'couch') couches.push(p);
      else if (use.kind === 'tv') tvs.push({ p, cx: p.x + (p.w || 1) / 2, cy: p.y + (p.h || 1) / 2 });
    }
    if (!couches.length || !tvs.length) return false;
    const order = U.irnd(0, couches.length - 1);   // don't always favour the same couch
    for (let k = 0; k < couches.length; k++) {
      const couch = couches[(order + k) % couches.length];
      const cx = couch.x + (couch.w || 1) / 2, cy = couch.y + (couch.h || 1) / 2;
      let best = null;
      for (const tv of tvs) { const d = Math.hypot(tv.cx - cx, tv.cy - cy); if (d <= LOUNGE_MAXT && (!best || d < best.d)) best = { tv, d }; }
      if (!best) continue;
      const face = dirToward(cx, cy, best.tv.cx, best.tv.cy);   // turn to the TV from the couch
      if (planCouchSit(now, couch, best.tv.p.id, face)) return true;
    }
    return false;
  }

  // idle leisure: pick a reachable interactive prop (couch/tv/arcade/jukebox/bar), walk to
  // its approach tile, and commit to goal='use'. Returns false if none is reachable (→ wander).
  function planProp(now) {
    if (!geo || !geo.props || !geo.props.length) return false;
    if (tryLounge(now)) return true;   // couch + TV nearby → sit ON the couch and watch (the v7 lounge)
    const cands = [];
    for (const p of geo.props) {
      const use = propUse(p); if (!use) continue;
      if (use.kind === 'couch') { cands.push({ couch: p }); continue; }   // sit ON it (handled below)
      const a = PropAnchor.deriveAnchor(p, geo, { approach: use.approach || 'south', sit: !!use.sit, extra: blocked });
      if (a) cands.push({ id: p.id, a });
    }
    if (!cands.length) return false;
    const start = U.irnd(0, cands.length - 1);   // random offset, but try each prop at most once
    for (let k = 0; k < cands.length; k++) {
      const c = cands[(start + k) % cands.length];
      if (c.couch) { if (planCouchSit(now, c.couch, null, 'north')) return true; continue; }   // lone couch → sit on it facing UP (back to the viewer)
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
        agent.studyKey = n.kind === 'belt' ? ('belt:' + n.tx + ',' + n.ty) : n.pid;
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
    if (belts.length) { const b = belts[U.irnd(0, belts.length - 1)]; cands.push({ kind: 'watch', key: 'belt:' + b.x + ',' + b.y, foot: { x: b.x, y: b.y, w: 1, h: 1 }, extra: beltUnion() }); }
    const props = (geo && geo.props) || [];
    // non-leisure kit (leisure is planProp's job), skipping the over-familiar — it has become furniture (habituation)
    const machines = props.filter(p => { const s = specOf(p.t); return s && !s.use && s.blocks && (seenCount.get(p.id) || 0) < 4; });
    if (machines.length) { const p = machines[U.irnd(0, machines.length - 1)]; cands.push({ kind: 'inspect', key: p.id, foot: p, extra: blocked }); }
    if (cands.length === 2 && U.chance(0.5)) cands.reverse();
    for (const c of cands) {
      const a = PropAnchor.deriveAnchor(c.foot, geo, { approach: 'auto', extra: c.extra });
      if (a && setPathTo({ x: a.tx, y: a.ty })) {
        agent.goal = c.kind; agent.useFace = a.face; agent.usingProp = null; agent.inspectNovel = false; agent.studyKey = c.key;
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

  /* ---------- inner life: needs + temperament decide WHICH goal it pursues ---------- */
  // is the agent loitering near its desk (its tether to the Commander)?
  function nearDesk() {
    if (!seat) return false;
    const c = tileOf(agent.px, agent.py);
    return Math.abs(c.x - seat.tx) <= 2 && Math.abs(c.y - seat.ty) <= 2;
  }
  // three slow meters decay/refill by what the agent is doing; clamped 0..100. O(1), every tick.
  function tickNeeds(dt) {
    const s = dt / 1000, n = agent.needs;
    const sitLeisure = agent.goal === 'lounge' || (agent.goal === 'use' && agent.sitting);
    const observing = agent.goal === 'inspect' || agent.goal === 'watch' || agent.goal === 'lounge' || agent.goal === 'gaze';
    n.rest = U.clamp(n.rest + (agent.working ? -2.1 : sitLeisure ? 3.4 : 0.35) * s, 0, 100);
    n.stim = U.clamp(n.stim + (observing ? 2.6 : agent.working ? 0.6 : agent.state === 'walk' ? 0.2 : -1.25) * s, 0, 100);
    n.social = U.clamp(n.social + (activity === 'task' || activity === 'talk' ? 2.2 : (agent.goal === 'tend' || nearDesk()) ? 1.6 : -0.45) * s, 0, 100);
  }
  // lonely → drift to a tile by the desk and face south (its window to the Commander); refills social
  function planSeekDesk(now) {
    if (!seat) return false;
    const spots = [[seat.tx, seat.ty + 1], [seat.tx - 1, seat.ty], [seat.tx + 1, seat.ty], [seat.tx, seat.ty]];
    for (const [tx, ty] of spots) {
      if (!geo.walkable(tx, ty, blocked)) continue;
      if (setPathTo({ x: tx, y: ty })) { agent.goal = 'tend'; agent.useFace = 'south'; agent.usingProp = null; agent.studyKey = null; if (!agent.target) arrive(now); return true; }
    }
    return false;
  }
  // restless → short back-and-forth hops near the current tile (paces in place instead of strolling far off)
  function pace(now) {
    const cur = tileOf(agent.px, agent.py), dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let i = 0; i < 5; i++) {
      const d = dirs[U.irnd(0, 3)], step = U.irnd(1, 2), tx = cur.x + d[0] * step, ty = cur.y + d[1] * step;
      if (geo.walkable(tx, ty, blocked) && setPathTo({ x: tx, y: ty })) { agent.goal = null; curiositySay(SELF_STIM, 0.4, now); return true; }
    }
    return false;
  }
  // deep downtime → walk to the station edge and contemplate the void (faces outward, long quiet dwell)
  function planGazeOut(now) {
    if (!geo || !geo.allRects || !geo.allRects.length) return false;
    const cx = geo.COLS / 2, cy = geo.ROWS / 2, cands = [];
    for (const r of geo.allRects) {
      cands.push({ tx: r.x1, ty: (r.y1 + r.y2) >> 1, face: 'west' }); cands.push({ tx: r.x2, ty: (r.y1 + r.y2) >> 1, face: 'east' });
      cands.push({ tx: (r.x1 + r.x2) >> 1, ty: r.y1, face: 'north' }); cands.push({ tx: (r.x1 + r.x2) >> 1, ty: r.y2, face: 'south' });
    }
    cands.sort((a, b) => ((b.tx - cx) ** 2 + (b.ty - cy) ** 2) - ((a.tx - cx) ** 2 + (a.ty - cy) ** 2));   // furthest-out first
    for (const c of cands) {
      if (geo.walkable(c.tx, c.ty, blocked) && setPathTo({ x: c.tx, y: c.ty })) { agent.goal = 'gaze'; agent.useFace = c.face; agent.usingProp = null; agent.studyKey = null; if (!agent.target) arrive(now); return true; }
    }
    return false;
  }

  /* ---------- rhythm: a free-running mood that re-weights the idle menu over minutes ----------
     Repeated watching reveals structure — it is clearly 'in a different mode' than ten minutes ago.
     Never overrides a summon (decideIdle only runs while idle); just tilts what it gravitates to. */
  const PHASES = [
    { tag: 'focus', rest: 0.8, stim: 0.9, soc: 1.25, restless: 1.25 },   // hovers near the desk, antsy for work
    { tag: 'roam', rest: 0.8, stim: 1.4, soc: 0.9, restless: 1.15 },     // wants to wander + study
    { tag: 'ease', rest: 1.4, stim: 0.85, soc: 1.0, restless: 0.7 },     // gravitates to the couch
    { tag: 'drift', rest: 1.2, stim: 0.7, soc: 0.85, restless: 0.55 },   // sleepy, sparse, long dwells
  ];
  function phaseOf(now) { return PHASES[(Math.floor(now / 210000) + (agent ? agent.phase : 0)) % PHASES.length]; }  // ~3.5 min per phase, offset per agent

  /* ---------- quirks: rare, gated, UNPREDICTABLE one-offs — the off-screen inner life surfacing ----------
     Eerie through stillness + ambiguity (the "why did it just do that"), never spooky one-liners. */
  function maybeQuirk(now) {
    if (now < quirkCd) return false;
    if (!U.chance(0.13 * (0.6 + agent.pers.restless * 0.4))) return false;
    quirkCd = now + U.irnd(24000, 60000);    // quirks stay special
    const r = U.irnd(0, 999);
    if (r < 360) return quirkListen(now);    // 36% — freeze + snap toward a sound only it heard
    if (r < 600) return quirkScan(now);      // 24% — a slow, deliberate sweep of the room
    if (r < 800) return quirkPonder(now);    // 20% — stops, faces away, lost in thought
    if (r < 930) return planGazeOut(now);    // 13% — drifts to the edge and stares into the void
    return quirkStare(now);                  //  7% — the long stare straight at YOU (rarest, eeriest)
  }
  function startQuirk(now, kind, ms, face) {
    agent.goal = 'quirk'; agent.quirkKind = kind; agent.usingProp = null; agent.studyKey = null;
    agent.sitting = false; agent.working = false; agent.state = 'idle'; agent.studyUntil = now + ms; agent.glanceCd = 0;
    if (face) { agent.dir = face; setGlance(face, U.irnd(300, 600), now); }
    return true;
  }
  function quirkListen(now) { const d = U.pick(['east', 'west', 'south', 'north']); startQuirk(now, 'listen', U.irnd(2200, 4500), d); setGlance(d, 260, now); curiositySay(Q_LISTEN, 0.22, now); return true; }
  function quirkScan(now) {
    startQuirk(now, 'scan', U.irnd(3200, 4600), 'north');
    ['north', 'east', 'south', 'west'].forEach((d, i) => setTimeout(() => { if (agent && agent.goal === 'quirk' && agent.quirkKind === 'scan') { agent.dir = d; setGlance(d, 900, performance.now()); } }, i * 850));
    return true;
  }
  function quirkPonder(now) { startQuirk(now, 'ponder', U.irnd(4000, 7000), U.pick(['north', 'east', 'west'])); curiositySay(Q_PONDER, 0.4, now); return true; }
  function quirkStare(now) {   // turns to the Commander and holds eye contact, mostly in silence
    agent.goal = 'stare'; agent.quirkKind = 'stare'; agent.usingProp = null; agent.studyKey = null;
    agent.sitting = false; agent.working = false; agent.state = 'idle'; agent.studyUntil = now + U.irnd(14000, 34000); agent.glanceCd = now + 1200;
    agent.dir = 'south'; setGlance('south', 700, now); curiositySay(Q_STARE, 0.18, now);   // mostly silent — the stillness is the unsettling part
    return true;
  }

  // THE WANT ENGINE — replaces the flat dice roll. Whichever drive is most unmet (tilted by temperament,
  // the current mood phase, + how long since real work) leads; novelty + rare quirks interrupt. The SAME
  // planners run, but now there is a legible reason behind every move so it stops reading as aimless.
  function decideIdle(now) {
    if (novelty.length && planInspect(now)) return;   // curiosity reflex: a fresh placement always wins
    if (maybeQuirk(now)) return;                       // rare unpredictable detour — the eerie inner life surfacing
    const n = agent.needs, p = agent.pers, ph = phaseOf(now), idleAge = now - (agent.lastTaskAt || now);
    const wRest = (100 - n.rest) * (0.7 + 0.6 * p.homebody) * ph.rest;
    const wStim = ((100 - n.stim) * (0.7 + 0.6 * p.curious) + Math.min(35, idleAge / 4500) * p.restless) * ph.stim;   // boredom climbs with downtime
    const wSoc = (100 - n.social) * ph.soc;
    const top = Math.max(wRest, wStim, wSoc);
    if (top < 28) { if (U.chance(0.5)) lookAround(now); else wander(now); return; }   // content -> light ambient life
    if (top === wRest) { if (planProp(now)) return; }                                  // tired -> lounge / couch
    else if (top === wSoc) { if (planSeekDesk(now)) return; }                          // lonely -> the desk, face the Commander
    else {                                                                             // bored / restless
      if (n.stim < 42 && planPOI(now)) return;                                         //   study a machine / watch a belt
      if (idleAge > 30000 && U.chance(0.35) && planGazeOut(now)) return;               //   long quiet -> contemplate the void
      if (p.restless * ph.restless > 1.0 && pace(now)) return;                          //   antsy -> pace in place
    }
    // graceful fallbacks so it never freezes
    if (U.chance(0.45 * p.curious) && planPOI(now)) return;
    if (U.chance(0.4 * p.homebody) && planProp(now)) return;
    if (U.chance(0.45)) lookAround(now); else wander(now);
  }

  // head-turns that sell "alive": track passing cargo, fidget at the desk, glance at new kit, look around
  function maybeGlance(now) {
    if (!agent || agent.unplaced) return;
    if (activity === 'talk') {
      // a voice conversation: don't let the gaze wander, but if he's actively LISTENING to the Commander,
      // give small acknowledging looks (mostly toward the camera) so he reads as engaged, not frozen.
      const lst = typeof Voice !== 'undefined' && Voice.isListening && Voice.isListening();
      if (lst && agent.state !== 'walk' && now >= (agent.glanceCd || 0) && !(agent.glance && agent.glance.until > now)) {
        setGlance(U.pick(['south', 'south', 'east', 'west']), U.irnd(450, 850), now);
        agent.glanceCd = now + U.irnd(1400, 2800);
      }
      return;
    }
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
    // THE LONG STARE: hold the gaze on the Commander, only the rare slow head-tilt — the stillness is the point
    if (agent.goal === 'stare') {
      if (U.chance(0.15)) { setGlance(U.pick(['south', 'east', 'west']), U.irnd(500, 1100), now); agent.glanceCd = now + U.irnd(2200, 4500); }
      else { agent.dir = 'south'; agent.glanceCd = now + U.irnd(1600, 3200); }
      return;
    }
    // a quirk in progress: scan pans itself (timed); the others mostly hold their pose with a rare flick
    if (agent.goal === 'quirk') {
      if (agent.quirkKind !== 'scan' && U.chance(0.3)) setGlance(U.pick(['east', 'west', 'south', 'north']), U.irnd(400, 800), now);
      agent.glanceCd = now + U.irnd(1200, 2600);
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
    // a box trundles past an idle agent → turn the WHOLE BODY to track it (held by trackUntil in tick), not just the eyes
    if (U.chance(0.6)) { const box = nearestBox(); if (box && box.d < 56) { const bd = dirToward(agent.px, agent.py, box.x, box.y); setGlance(bd, U.irnd(500, 1000), now); agent.dir = bd; agent.trackUntil = now + U.irnd(1200, 2600); agent.glanceCd = now + U.irnd(3000, 5500); return; } }
    // idle / studying / tending / gazing: occasional ambient look around
    if ((agent.goal === 'inspect' || agent.goal === 'tend' || agent.goal === 'gaze' || agent.goal == null) && U.chance(0.5)) { setGlance(U.pick(['east', 'west', 'south', 'north']), U.irnd(450, 850), now); agent.glanceCd = now + U.irnd(2500, 5000); }
  }

  // a short curiosity remark — only when nothing real is on screen, and only sometimes
  function curiositySay(lines, prob, now) {
    if (!lines || !lines.length || !agent) return;
    if (agent.say && agent.say.until > now) return;        // never stomp a live (real) message
    if (now - lastSelfTalk < 6500) return;                 // global cooldown: thoughts are rare, not a running monologue
    // stay quiet while a voice conversation is actually happening (listening / the agent speaking)
    if (typeof Voice !== 'undefined'
        && ((Voice.isListening && Voice.isListening()) || (Voice.isSpeaking && Voice.isSpeaking()))) return;
    if (!U.chance(prob * (agent.pers ? agent.pers.chatty : 1))) return;
    // let the active persona flavor the remark (gremlin vs old-salt say different things); the SAME line
    // drives both the bubble and the spoken aside, so caption and voice stay in sync.
    const line = (typeof Voice !== 'undefined' && Voice.ambientLine) ? Voice.ambientLine(lines) : U.pick(lines);
    say(line, { ambient: true }); lastSelfTalk = now;
  }

  function tick(dt, now) {
    if (!agent || agent.unplaced || !geo || awakeFrozen) return;   // frozen during the awakening: the newborn holds still, facing the Commander
    if (!agent.lastTaskAt) agent.lastTaskAt = now;                 // anchor downtime at the first live tick
    tickNeeds(dt);                                                 // the inner meters drain/refill by what it is doing
    const SPEED = 34 * (agent.pers ? agent.pers.pace : 1);         // temperament: each agent walks at its own pace
    // settle: a beat of sitting (loading context) before the screens light + typing latches on
    if (agent.goal === 'work' && !agent.working && agent.settleUntil && now >= agent.settleUntil) { agent.working = true; agent.settleUntil = 0; }
    // body-track: keep the torso turned to a tracked box for a beat after the glance (whole-body attention, eased by glanceCd)
    if (agent.goal == null && agent.state !== 'walk' && agent.trackUntil > now) { const box = nearestBox(); if (box && box.d < 90) agent.dir = dirToward(agent.px, agent.py, box.x, box.y); }
    // self-heal a stuck walker: the walk pose with nowhere to go (target + path both gone —
    // e.g. a REFIT re-bake cleared the in-flight path, or a path came back empty). The idle
    // re-decision below is gated on state !== 'walk', so without this the legs cycle in place
    // forever (moonwalk). Drop to idle and let this same tick re-path / re-summon.
    if (agent.state === 'walk' && !agent.target && (!agent.pathPts || agent.pathIdx >= agent.pathPts.length)) {
      agent.state = 'idle'; agent.idleUntil = 0;
    }
    // SUMMONED → don't teleport: pause where it stands (loading context) facing the desk, THEN walk over
    if (activity === 'task' && agent.goal !== 'work') {
      if (agent.goal !== 'summon') { releaseSeat(); agent.goal = 'summon'; agent.sitting = false; agent.working = false; agent.usingProp = null; agent.watchProp = null; agent.target = null; agent.pathPts = null; agent.state = 'idle'; agent.dir = 'north'; agent.thinkUntil = now + U.irnd(400, 1200); curiositySay(SELF_ONDUTY, 0.9, now); }
      else if (now >= agent.thinkUntil) { agent.goal = 'work'; if (!seat || !setPathTo({ x: seat.tx, y: seat.ty })) { if (seat) { const f = footOf(seat.tx, seat.ty); agent.px = f.x; agent.py = f.y; agent.sitting = true; agent.working = true; agent.dir = 'north'; } } }
    }
    if (activity !== 'task' && (agent.goal === 'work' || agent.goal === 'summon')) {
      agent.goal = null; agent.sitting = false; agent.working = false; agent.thinkUntil = 0; agent.settleUntil = 0; agent.pathPts = null; agent.target = null; agent.state = 'idle'; agent.idleUntil = now + 200; agent.lastTaskAt = now;   // just finished real work → relaxed, downtime clock resets
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
      if (now >= agent.useUntil) { releaseSeat(); agent.goal = null; agent.usingProp = null; agent.sitting = false; agent.state = 'idle'; agent.idleUntil = now + U.irnd(400, 1200); }
    } else if (agent.goal === 'lounge') {
      // sitting on the couch watching the TV: maybeGlance animates the gaze; clear both props when done
      if (now >= agent.useUntil) { releaseSeat(); agent.goal = null; agent.usingProp = null; agent.watchProp = null; agent.sitting = false; agent.state = 'idle'; agent.idleUntil = now + U.irnd(400, 1200); }
    } else if (agent.goal === 'inspect' || agent.goal === 'watch' || agent.goal === 'tend' || agent.goal === 'gaze' || agent.goal === 'quirk' || agent.goal === 'stare') {
      // observing / tending / gazing / a quirk / the long stare: hold until the dwell ends (maybeGlance animates it), then re-decide
      if (now >= agent.studyUntil) { agent.goal = null; agent.usingProp = null; agent.studyKey = null; agent.quirkKind = null; agent.state = 'idle'; agent.idleUntil = now + U.irnd(500, 1500); }
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
    if (camLerp && !camAnim) {   // gently ease toward a conversation framing (set by focusAgent); the awakening camera wins
      const k = 0.16;
      scale += (camLerp.scale - scale) * k; panX += (camLerp.panX - panX) * k; panY += (camLerp.panY - panY) * k;
      if (Math.abs(camLerp.scale - scale) < 0.01 && Math.abs(camLerp.panX - panX) < 1 && Math.abs(camLerp.panY - panY) < 1) {
        scale = camLerp.scale; panX = camLerp.panX; panY = camLerp.panY; camLerp = null;
      }
    }
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
        const work = (p.t === 'outbox' && outboxLit) || (p.t === 'bay' && bayLit(p, now)) || !!(agent && (agent.usingProp === p.id || agent.watchProp === p.id));
        // a couch with a seated agent sorts JUST BEHIND the sitter, so the agent renders ON it (v7's sitPy trick)
        const sy = (agent && agent.seated && agent.usingProp === p.id) ? agent.seatPy - 1 : (p.y + (p.h || 1)) * T;
        items.push({ y: sy, draw: () => PropSprites.draw(p, work) });
      }
    }
    if (desk) items.push({ y: (desk.ty + desk.h) * T, draw: () => F_desk(desk.tx * T, desk.ty * T, desk.w * T, desk.h * T, { x: desk.tx, work: !!(agent && agent.working) }) });
    if (seat) items.push({ y: (seat.ty + 1) * T, draw: () => F_chair(seat.tx * T, seat.ty * T) });
    if (agent && !agent.unplaced) items.push({ y: rposY(), draw: () => drawAgent(now) });
    for (const b of crew) items.push({ y: b.py, draw: () => drawAgent(now, b) });   // the other agents, at their bays
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
    if (floodAt) drawFlood(now);   // THE FLOOD — the cascade of knowledge streaming in, over the dark room
    if (dawnAt && now - dawnAt < 1300) drawDawnBloom(now);   // the room takes its first breath of light
    drawDeskGauge(now);   // the context-window memory core at the workstation (world-space, above the lightmap)
    if (agent && !agent.unplaced) drawBubble(now);
    for (const b of crew) drawBubble(now, b);   // crew speech bubbles (e.g. "received: …" when work routes to them)
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
  // THE FLOOD — screen-space matrix-rain of real prompt/capability fragments + glyph noise; ramps to
  // overwhelming density, then collapses every glyph inward into the newborn. Amber/gold phosphor to sit
  // with the CRT + dawn palette; hot-white leading glyph. Self-terminating once the collapse completes.
  function drawFlood(now) {
    if (!floodAt || !floodStreams) return;
    const t = now - floodAt;
    const rampIn = Math.min(1, t / 1400);
    let collapse = 0;
    if (floodEndAt) {
      collapse = (now - floodEndAt) / 1000;
      if (collapse >= 1) { floodAt = 0; floodEndAt = 0; floodStreams = null; return; }
    }
    const ec = collapse <= 0 ? 0 : (collapse < 0.5 ? 2 * collapse * collapse : 1 - Math.pow(-2 * collapse + 2, 2) / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'lighter'; ctx.textBaseline = 'top';
    let ax = cv.width / 2, ay = cv.height * 0.46;
    if (agent && !agent.unplaced) { ax = agent.px * scale + panX; ay = (agent.py - 8) * scale + panY; }
    const lineH = 15, H = cv.height, span = (Math.ceil(H / lineH) + 9) * lineH, tail = 8;
    const base = rampIn * (1 - ec * 0.9);
    for (const st of floodStreams) {
      const tt = t - st.delay; if (tt < 0) continue;
      const x = st.x * cv.width;
      ctx.font = st.size + 'px VT323, monospace';
      const headRow = Math.floor((tt / 1000 * st.speed) / lineH);
      for (let k = 0; k < tail; k++) {
        const row = headRow - k;
        let y = (row * lineH) % span; if (y < 0) y += span; y -= tail * lineH;
        if (y < -lineH || y > H) continue;
        let a = base * (k === 0 ? 1 : Math.max(0, (1 - k / tail)) * 0.62);
        let dx = x, dy = y;
        if (ec > 0) { dx = x + (ax - x) * ec; dy = y + (ay - y) * ec; a *= (1 - ec); }
        if (a <= 0.02) continue;
        const tok = st.toks[((row % st.len) + st.len) % st.len];
        ctx.fillStyle = k === 0 ? 'rgba(255,250,235,' + Math.min(1, a * 1.25).toFixed(3) + ')' : 'rgba(255,200,120,' + a.toFixed(3) + ')';
        ctx.fillText(tok, dx, dy);
      }
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.textBaseline = 'alphabetic'; ctx.setTransform(scale, 0, 0, scale, panX, panY);   // restore the baseline we changed, so later text drawers don't inherit 'top'
  }

  function drawAgent(now, who) {
    who = who || agent;   // default = the hero; a crew body passes itself. Hero path is byte-identical (who===agent).
    // voice cues animate the body while the HERO is actually speaking + a "listening" foot-pulse when the mic is
    // live (drawBody/drawFallback read who.speaking). Crew bodies don't use Voice, so these are hero-only.
    const listening = (who === agent) && (typeof Voice !== 'undefined' && Voice.isListening && Voice.isListening());
    if (who === agent) who.speaking = (typeof Voice !== 'undefined' && Voice.isSpeaking && Voice.isSpeaking());
    // while seated on a couch the agent draws on the cushion, not its (adjacent) logical tile — swap
    // px/py for the draw and restore after, so movement/pathing keep using the real logical position.
    const ox = who.px, oy = who.py;
    if (who.seated) { who.px = who.seatPx; who.py = who.seatPy; }
    try {
      // color-into-being: the body fades up from a faint silhouette to full as the spark blooms (HERO only)
      let bornA = 1;
      if (who === agent && bornAt && now - bornAt < 1000) bornA = 0.16 + 0.84 * ((now - bornAt) / 1000);
      const prevA = ctx.globalAlpha;
      if (bornA < 1) ctx.globalAlpha = prevA * bornA;
      let geom = null;
      if (typeof SPRITES !== 'undefined' && SPRITES.ready) geom = SPRITES.drawBody(ctx, who, now);
      if (!geom) drawFallback(now, who);
      ctx.globalAlpha = prevA;
      // the wake ripple — a triple-ringed sonar pulse of first breath, in the suit color (hero's awakening
      // uses the module wakeAt; a crew body uses its own per-body wakeAt set when it receives work)
      const wa = (who === agent) ? wakeAt : (who.wakeAt || 0);
      if (wa && now - wa < 1500) {
        ctx.save(); ctx.strokeStyle = who.color;
        for (let k = 0; k < 3; k++) {
          const tk = (now - wa) / 1300 - k * 0.18;
          if (tk <= 0 || tk >= 1) continue;
          ctx.globalAlpha = (1 - tk) * 0.6 * (1 - k * 0.22); ctx.lineWidth = Math.max(0.5, 1.5 - tk);
          ctx.beginPath(); ctx.ellipse(who.px, who.py, 4 + tk * 22, 2 + tk * 9, 0, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.restore();
      }
      // a soft "I'm listening to you" pulse at the feet — an in-world cue the mic is open and he's hearing
      // you (distinct from just standing facing the Commander). Only while the mic is actually live (hero).
      if (listening) {
        const lp = 0.4 + 0.35 * Math.sin(now / 320);
        ctx.save(); ctx.globalAlpha = lp * 0.7; ctx.strokeStyle = who.color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(who.px, who.py, 8 + 2 * Math.sin(now / 320), 3.5, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
    } finally { who.px = ox; who.py = oy; }
  }

  function drawFallback(now, who) {
    const a = who || agent, x = Math.round(a.px), y = Math.round(a.py), h = 13;
    const step = a.state === 'walk' ? (Math.floor(now / 140) % 2) : 0;
    const bob = (a.state !== 'walk' && !a.sitting)
      ? Math.round(a.speaking ? Math.sin(now / 170 + a.phase) * 1.1 : Math.sin(now / 600 + a.phase) * 0.7) : 0;
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
    const rx = rposX(), ry = rposY();
    const bx = Math.round(rx - bw / 2), by = Math.round(ry - 30);
    ctx.fillStyle = 'rgba(4,3,2,0.88)'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = agent.color; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    ctx.fillStyle = agent.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, rx, by + bh / 2);
    ctx.restore();
  }

  function drawBubble(now, who) {
    who = who || agent;
    const s = who.say;
    // keep the HERO's caption up while it's still SPEAKING (a streamed neural reply can outlast the bubble's
    // fixed timer) — so the on-screen line and the voice stay in phase. Crew bodies just follow the timer.
    const speakingNow = (who === agent) && typeof Voice !== 'undefined' && Voice.isSpeaking && Voice.isSpeaking();
    if (!s.text || (s.until < now && !speakingNow)) return;
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
    const rx = who.seated ? who.seatPx : who.px, ry = who.seated ? who.seatPy : who.py;
    let bx = Math.round(rx - bw / 2); const by = Math.round(ry - 22 - bh);
    bx = Math.max(2, Math.min((cache ? cache.W : 9999) - bw - 2, bx));
    ctx.fillStyle = 'rgba(3,2,1,0.92)'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#ffaa33'; ctx.lineWidth = 1; ctx.strokeRect(bx + .5, by + .5, bw - 1, bh - 1);
    ctx.fillStyle = '#ffaa33'; ctx.fillRect(Math.round(rx) - 1, by + bh, 3, 2);
    ctx.fillStyle = '#ffd9a3'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';   // own our baseline — never inherit a stray one (the line-y math assumes alphabetic)
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
  /* compile the floor into a RoutingPlan and push it to the sidecar. ONE compiler (pipeline.js) feeds BOTH
     the visual junctions below AND the server's autonomous dispatch, so "the box you watch ride to a bay" and
     "the agent that actually runs" can never drift. The plan is derived from the same local-frame geo the
     conveyor animates. If Pipeline isn't loaded, routingPlan stays null and buildJunctions() falls back. */
  function compileRouting() {
    routingPlan = (typeof Pipeline !== 'undefined' && geo) ? Pipeline.compileRoutingPlan(geo) : null;
    // B5: enrich each bay with the capability objectTypes in its room, so the sidecar can isolate that agent's
    // tools to exactly what the floor placed there (the bay->agent binding decides WHO; the room decides WHAT).
    if (routingPlan && routingPlan.bays && station && typeof station.bayObjects === 'function') {
      for (const b of routingPlan.bays) b.objects = station.bayObjects(b.agentId);
    }
    postRoutingPlan(routingPlan);
  }
  // fire-and-forget the plan to /api/routing, but only when the floor TOPOLOGY actually changed (hash dedupe —
  // rederive() also runs on pure camera/agent moves). The sidecar REFUSES a non-deployable plan (cycle/orphan)
  // and falls back to its default resolution, so a broken floor disables routed-mode rather than stalling work.
  function postRoutingPlan(plan) {
    if (typeof fetch === 'undefined') return;
    // dedupe on topology hash + per-bay caps, so equipping a bay (a capability change with no belt change) still re-POSTs
    const hash = plan ? ((plan.hash || '') + '|' + (plan.bays || []).map(b => b.agentId + ':' + ((b.objects || []).join(','))).join(';')) : '';
    if (hash === lastPlanHash) return;
    lastPlanHash = hash;
    try { fetch('/api/routing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan || {}) }).catch(() => {}); } catch (_) {}
  }
  // junction props (splitter/filter/merger) keyed by tile — derived from the compiled plan so the VISUAL engine
  // animates filters + mergers (not just splitters) using the SAME config the dispatch router routes by.
  function buildJunctions() {
    if (routingPlan && routingPlan.junctions) {
      let j = null;
      for (const k in routingPlan.junctions) (j = j || new Map()).set(k, routingPlan.junctions[k]);
      return j;
    }
    // fallback (Pipeline unavailable): the original splitter-only scan keeps belts animating
    let j = null;
    if (geo && geo.props) for (const p of geo.props) {
      if (p.t === 'splitter') (j = j || new Map()).set(p.x + ',' + p.y, { kind: 'split' });
    }
    return j;
  }
  // a real inbound message arrived — drop a box at the INTAKE so it rides the belts to the desk. The box carries
  // a CONTENT TAG (the same getTag the sidecar routes by) so a FILTER junction visibly sorts it toward the
  // matching agent's bay — frontend sort == backend dispatch.
  function intakeMessage(payload) {
    if (!convey) return;
    const t = intakeTile();
    // tag the box with its content kind (the same getTag the sidecar routes by) so a FILTER sorts it visibly
    const p = payload || {};
    if (!p.tag && typeof Classify !== 'undefined' && Classify.getTag) p.tag = Classify.getTag(p.preview || p.text || '');
    if (t) convey.enqueueAt(t.x, t.y, p);
    // ANTICIPATE: an idle agent senses work on the line and perks up toward the dock before any summon lands
    if (agent && !agent.unplaced && activity === 'idle' && !agent.working) {
      const intake = geo && geo.props && geo.props.find(q => q.t === 'intake');
      if (intake) setGlance(dirToward(agent.px, agent.py, (intake.x + 0.5) * T, (intake.y + 0.5) * T), 1100, fnow);
      curiositySay(['incoming?', 'work inbound', 'something is coming', 'heads up'], 0.6, fnow);
      if (agent.goal == null) agent.idleUntil = Math.min(agent.idleUntil || 0, fnow + 200);
    }
  }
  // the agent's reply heads out — enqueue an OUTBOUND box at a desk-adjacent belt tile, riding to the OUTBOX
  function outboundMessage(payload) {
    if (!convey || !desk) return;
    const t = beltTileNear(desk.tx, desk.ty, desk.w, desk.h);
    if (t) convey.enqueueAt(t.x, t.y, { outbound: true, workitemId: (payload && payload.workitemId) || '' });
  }
  /* ---------- crew bodies (the OTHER agents, standing at their bays) ---------- */
  // a LIGHT body: the full agent field-shape (so SPRITES.drawBody/drawFallback never choke) but STATIC —
  // it never ticks/paths. It only receives work (a say bubble + a wake ripple + a bay work-glow).
  function makeCrewBody(aid, name, color, fx, fy) {
    return {
      id: aid, agentId: aid, name: name || aid, color: color || '#5ad0ff', crewBody: true,
      px: fx, py: fy, dir: 'south', state: 'idle', sitting: false, working: false, unplaced: false,
      phase: U.hash('' + aid) % 6, target: null, pathPts: null, pathIdx: 0, idleUntil: 0, goal: null, say: { text: '', until: 0 },
      usingProp: null, useUntil: 0, useFace: 'south', useSit: false, watchProp: null,
      seated: false, seatPx: 0, seatPy: 0, seatKey: null, pendSeat: null,
      glance: null, glanceCd: 0, nextFidget: 0, studyUntil: 0, noticeCd: 0,
      wakeAt: 0, workUntil: 0
    };
  }
  // reconcile `crew` with the plan's bound bays: one light body per bay (except the hero's own), standing at
  // the bay prop's foot. Reuses existing bodies by agentId so a re-bake doesn't wipe a live say bubble.
  function syncCrewFromPlan() {
    if (!routingPlan || !routingPlan.bays || !routingPlan.bays.length || !geo) { if (crew.length) crew = []; return; }
    const want = new Map();
    for (const bay of routingPlan.bays) {
      if (agent && bay.agentId === agent.id) continue;                 // the hero already represents its own bay
      const p = geo.props && geo.props.find(pp => pp.id === bay.propId);
      if (!p) continue;
      const fx = (p.x + (p.w > 1 ? 1 : 0)) * T + T / 2;                // foot at the bay's bottom-centre
      const fy = (p.y + (p.h || 1) - 1) * T + T - 1;
      want.set(bay.agentId, { x: fx, y: fy });
    }
    crew = crew.filter(b => want.has(b.agentId));                      // drop bodies whose bay is gone
    for (const [aid, pos] of want) {
      const b = crew.find(x => x.agentId === aid);
      if (b) { b.px = pos.x; b.py = pos.y; }
      else crew.push(makeCrewBody(aid, aid, crewColor(aid), pos.x, pos.y));
    }
  }
  // the body that runs a given agentId: the hero, a crew body, or null (caller falls back to the hero)
  function bodyForAgent(aid) {
    if (!aid) return null;
    if (agent && aid === agent.id) return agent;
    return crew.find(b => b.agentId === aid) || null;
  }
  function sayAt(body, text) {
    if (!body) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    body.say = { text: t.slice(0, 160), until: performance.now() + 4200 };
  }
  // is a BAY prop's bound agent actively working (so the bay lights up)?
  function bayLit(p, now) {
    if (!p.agentId) return false;
    if (agent && p.agentId === agent.id) return !!agent.working;
    const b = crew.find(x => x.agentId === p.agentId);
    return !!(b && b.workUntil > now);
  }
  // a payload box reached an open end: route it to the bound agent's bay (the SAME bay the box rode to, per the
  // plan) and light THAT body. No bay / unrouted -> the hero receives it, exactly as before (never stalls).
  function onWorkitemDeliver(bx) {
    const p = (bx && bx.payload) || {};
    if (p.outbound) {
      lastOutboxFlash = fnow;   // reply reached the OUTBOX -> flash the chute
      if (agent && !agent.unplaced && activity === 'idle') {   // EXHALE: watch the reply leave, satisfied, then relax (downtime clock resets)
        const ob = geo && geo.props && geo.props.find(q => q.t === 'outbox');
        if (ob) setGlance(dirToward(agent.px, agent.py, (ob.x + 0.5) * T, (ob.y + 0.5) * T), 1100, fnow);
        curiositySay(SELF_DISPATCH, 0.7, fnow); agent.lastTaskAt = fnow;
      }
      return;
    }
    // INBOUND: route the delivered box to its bound agent's bay (the SAME bay it rode to) and light THAT body.
    const aid = (typeof Pipeline !== 'undefined' && routingPlan) ? Pipeline.resolveTarget(routingPlan, { tag: p.tag }) : null;
    const body = bodyForAgent(aid);
    if (body && body !== agent) { sayAt(body, 'received: ' + (p.preview || 'message')); body.wakeAt = fnow; body.workUntil = fnow + 4000; }
    else { say('received: ' + (p.preview || 'message')); wakeIn(); }   // the hero (or an unrouted box) — today's behaviour
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

  /* ---------- CONTEXT-WINDOW gauge: the agent's memory core, made physical ----------
     A segmented "memory bank" standing beside the workstation that fills toward the model's REAL
     context ceiling: latest prompt_tokens / catalog context_length (via Harness.contextState +
     CtxGauge). Green→amber→red as it nears full; the topmost cell pulses at crit (steady under
     reduced-motion). Drawn in world-space, above the lightmap, so it lives at the desk and reads at
     a glance. Honest by construction: an unknown limit shows an empty core + "—" (calibrating),
     never a fabricated fill. NOTE: it shows the window FILLING — there is no "compaction" beat yet
     (context.js is unwired), so nothing animates emptying until that lands. */
  function drawDeskGauge(now) {
    if (!desk || !agent || agent.unplaced) return;
    if (wakeDark > 0.5) return;   // stay out of the awakening cinematic until first light has mostly arrived
    if (typeof Harness === 'undefined' || !Harness.contextState || typeof CtxGauge === 'undefined') return;
    const cs = Harness.contextState();
    const g = CtxGauge.compute(cs.used, cs.limit);

    const gw = 4, gh = 18, N = 6, gap = 1;
    const gx = (desk.tx + desk.w) * T;   // standing just past the desk's right edge
    const gy = desk.ty * T - 6;

    // housing
    fpx(gx - 1, gy - 1, gw + 2, gh + 2, '#05080b');
    fpx(gx, gy, gw, gh, '#0b1014');
    fpx(gx, gy, gw, 1, '#1b2630');        // top rim
    fpx(gx, gy, 1, gh, '#13202a');        // left edge sheen

    const col = g.level === 'crit' ? '#ff5a4a' : g.level === 'warn' ? '#ffb24a' : g.level === 'ok' ? '#3fd07c' : '#243038';
    const dimC = '#13201a';
    const cellH = Math.floor((gh - (N - 1) * gap) / N);
    const lit = (g.known && g.used > 0) ? Math.max(1, Math.round(g.frac * N)) : 0;   // any real fill lights ≥1 cell

    for (let i = 0; i < N; i++) {   // stack bottom-up
      const cy = gy + gh - cellH - i * (cellH + gap);
      const on = i < lit;
      let c = on ? col : dimC;
      if (on && g.level === 'crit' && i === lit - 1 && !reduceMotion() && !fblink(360)) c = U.shade(col, -0.45);
      fpx(gx + 1, cy, gw - 2, cellH, c);
      if (on) fpx(gx + 1, cy, gw - 2, 1, U.shade(c, 0.3));   // cell top highlight
    }
    if (g.known && g.used > 0) fglow(gx, gy, gw, gh, col, g.level === 'crit' ? 0.20 : 0.12);

    // compact readout above the core — percentage when known, a calibrating dash when not.
    // VT323 (the station's typed/terminal font) with a 1px dark backing so it reads over the lit room.
    ctx.font = "10px 'VT323', 'Courier New', monospace"; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const lx = gx + gw / 2, ly = gy - 3;
    ctx.fillStyle = 'rgba(2,4,3,0.85)'; ctx.fillText(g.pctLabel, lx, ly + 1);
    ctx.fillStyle = g.known ? col : '#5a6b62'; ctx.fillText(g.pctLabel, lx, ly);
    ctx.textAlign = 'left';
  }

  return { init, loadStation, spawn, start, stop, setActivity, wakeIn, beginAwakening, setWakeProgress, igniteSpark, camPushIn, camCreep, camPunch, camPullBack, awakenTurn, truthPulse, beginFlood, collapseFlood, endAwakening, releaseAwakening, say, focusAgent, getActivity: () => activity, getUse: () => (agent ? agent.usingProp : null), setOnClick, setOnArcade, refit };
})();
