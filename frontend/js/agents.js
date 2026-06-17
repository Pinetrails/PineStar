/* SKYNET — agents.js : world bodies, movement & behavior
   v8 "PURPOSEFUL STATION": bodies carry plans (step sequences) so every
   journey has a reason — deliverables get hand-carried to the belt and on
   to HERALD, researchers walk their intel to the factories, flagged work
   is presented at the bridge, and off-duty agents live actual lives. */
'use strict';

const WORLD = (() => {
  const T = MAP.TILE;
  const bodies = {};   // id -> body
  let parcels = [];    // conveyor cosmetics — spawned by real deliveries now
  let nowMs = 0;

  /* ---- personality: how each agent moves and unwinds ----
     pace: walk speed mult | restless: wander frequency mult
     social: quarters affinity 0..1 | spot: preferred hangout kind
     buddy: coworker they visit when idle | chat: hallway-encounter mult */
  const PERS = {
    ULTRON:     { pace: 0.95, restless: 0.45, social: 0.00, spot: null,     buddy: null,     chat: 0.3 },
    NOVA:       { pace: 1.05, restless: 1.15, social: 0.55, spot: 'bar',    buddy: 'CURIE',  chat: 1.0 },
    CURIE:      { pace: 1.00, restless: 0.95, social: 0.50, spot: 'window', buddy: 'NOVA',   chat: 0.9 },
    FORGE:      { pace: 1.00, restless: 0.85, social: 0.70, spot: 'bar',    buddy: 'VECTOR', chat: 1.0 },
    VECTOR:     { pace: 0.95, restless: 0.80, social: 0.70, spot: 'bar',    buddy: 'FORGE',  chat: 1.0 },
    PROMETHEUS: { pace: 1.00, restless: 0.90, social: 0.60, spot: 'pool',   buddy: 'PIXEL',  chat: 0.8 },
    PIXEL:      { pace: 1.18, restless: 1.35, social: 0.75, spot: 'arcade', buddy: 'ATLAS',  chat: 1.1 },
    ATLAS:      { pace: 1.05, restless: 1.00, social: 0.65, spot: 'pool',   buddy: 'PIXEL',  chat: 0.9 },
    QUILL:      { pace: 0.90, restless: 0.70, social: 0.35, spot: 'window', buddy: 'VYBES',  chat: 0.7 },
    CIPHER:     { pace: 0.95, restless: 0.60, social: 0.40, spot: 'tv',     buddy: 'CURIE',  chat: 0.6 },
    VYBES:      { pace: 1.15, restless: 1.45, social: 0.95, spot: 'juke',   buddy: 'PIXEL',  chat: 1.2 },
    HERALD:     { pace: 1.05, restless: 0.90, social: 0.45, spot: 'bar',    buddy: 'FORGE',  chat: 0.9 },
    LEDGER:     { pace: 0.90, restless: 0.65, social: 0.25, spot: 'tv',     buddy: 'SCRIBE', chat: 0.6 },
    ATHENA:     { pace: 1.00, restless: 0.55, social: 0.25, spot: 'tv',     buddy: 'RAVEN',  chat: 0.7 },
    RAVEN:      { pace: 1.05, restless: 1.60, social: 0.35, spot: 'arcade', buddy: 'ATHENA', chat: 0.8 },
    RELAY:      { pace: 1.00, restless: 1.00, social: 0.55, spot: 'juke',   buddy: 'HERALD', chat: 1.0 },
    SCRIBE:     { pace: 0.85, restless: 0.60, social: 0.30, spot: 'window', buddy: 'LEDGER', chat: 0.5 }
  };
  const P = id => PERS[id] || { pace: 1, restless: 1, social: 0.5, spot: null, buddy: null, chat: 1 };

  /* the thing each room's crew checks when idle — stand spot computed at init */
  const FOCUS_DEF = {
    bridge:     { t: 'holotable',      label: 'studying the delegation holo' },
    research:   { t: 'whiteboard',     label: 'reading the brief board' },
    comms:      { t: 'commswall',      label: 'scanning the channel wall' },
    factory1:   { t: 'etsy_packbot',   label: 'checking the pack bot' },
    factory2:   { t: 'gigs_thumbwall', label: 'studying the thumbnail wall' },
    treasury:   { t: 'goldcrate',      label: 'counting the gold reserve' },
    warroom:    { t: 'chartwall',      label: 'reading the signal wall' },
    publishing: { t: 'calwall',        label: 'checking the publish calendar' },
    archives:   { t: 'arc_indexwall',  label: 'browsing the memory index' }
  };
  /* two ends of the pool table; a session claims both */
  const POOL_SPOTS = [{ x: 39, y: 49, face: 'south' }, { x: 40, y: 52, face: 'north' }];

  /* computed geometry (init): belt drop spots, HERALD's visitor spot, bridge spot, focus spots */
  const beltInfo = {};   // roomId -> { x, y, face }
  const focus = {};      // roomId -> { x, y, face, label }
  let heraldSpot = null, bridgeSpot = null;
  let poolBusyUntil = 0;
  const pairCd = {};     // "A|B" -> next encounter time
  let scanAcc = 0;
  let lastCrewLook = 0;  // colony-wide gate: only ONE crew member looks up at the Commander at a time

  function mkBody(a) {
    const st = MAP.stations[a.id];
    return {
      id: a.id, color: a.color, robot: !!a.robot,
      px: st.x * T + T / 2, py: st.y * T + T - 1,
      tile: { x: st.x, y: st.y },
      path: [], state: 'work', sitting: true, working: false, dir: 'north',
      hasCan: false, alert: false, bubble: null,
      phase: U.hash(a.id) % 10, breakUntil: 0, nextWander: nowMs + U.rnd(2000, 14000),
      socialSpot: null,
      plan: null, meet: null, glance: null, act: null,
      glanceCd: 0, meetCd: 0, nextFidget: nowMs + U.rnd(6000, 20000), lookCd: 0
    };
  }

  /* ---------- geometry helpers ---------- */
  const free = (x, y) => MAP.walkable(x, y) && !MAP.sitTiles[x + ',' + y];
  function dirToward(fx, fy, tx, ty) {
    const dx = tx - fx, dy = ty - fy;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north');
  }
  function standNearTile(tx, ty) {
    for (const [dx, dy] of [[0, 1], [0, -1], [-1, 0], [1, 0], [-1, 1], [1, 1], [-1, -1], [1, -1]])
      if (free(tx + dx, ty + dy)) return { x: tx + dx, y: ty + dy };
    return null;
  }
  function standNearFurn(f) {
    const cand = [];
    for (let dx = 0; dx < f.w; dx++) cand.push([f.x + dx, f.y + f.h]);      // south row first (visible side)
    for (let dx = 0; dx < f.w; dx++) cand.push([f.x + dx, f.y - 1]);
    for (let dy = 0; dy < f.h; dy++) { cand.push([f.x - 1, f.y + dy]); cand.push([f.x + f.w, f.y + dy]); }
    for (const [x, y] of cand) if (free(x, y))
      return { x, y, face: dirToward(x, y, f.x + (f.w - 1) / 2, f.y + (f.h - 1) / 2) };
    return null;
  }

  function init() {
    DATA.AGENTS.forEach(a => bodies[a.id] = mkBody(a));
    U.bus.on('chat', d => {
      const b = bodies[d.from];
      if (b) b.bubble = { until: nowMs + 4200, txt: d.txt ? (d.txt.length > 26 ? d.txt.slice(0, 25) + '…' : d.txt) : null };
    });
    U.bus.on('agentlevel', d => { const b = bodies[d.agentId]; if (b) b.bubble = { until: nowMs + 2600 }; });
    U.bus.on('sale', d => {
      const b = d.agentId && bodies[d.agentId];
      if (b) {
        b.bubble = { until: nowMs + 2200 };
        for (const o of Object.values(bodies)) {
          if (o !== b && o.tile && Math.abs(o.tile.x - b.tile.x) + Math.abs(o.tile.y - b.tile.y) <= 5)
            setGlance(o, dirToward(o.tile.x, o.tile.y, b.tile.x, b.tile.y), U.rnd(900, 1600));
        }
      }
    });

    /* belts: surface extents for parcel rides + the drop spot at the feed end */
    const belts = {}; // roomId -> belt surface extents in px
    for (const f of MAP.furniture) {
      if (f.t !== 'beltH') continue;
      const room = MAP.roomAt(f.x, f.y);
      if (!room) continue;
      belts[room] = { x0: f.x * T + 4, x1: (f.x + f.w) * T - 4, y: f.y * T + 7 };
      const headX = room === 'factory2' ? f.x + f.w - 1 : f.x; // factory2 feeds west
      for (const dy of [1, -1]) {
        let found = null;
        for (const dx of [0, 1, -1, 2, -2]) if (free(headX + dx, f.y + dy)) { found = { x: headX + dx, y: f.y + dy }; break; }
        if (found) { beltInfo[room] = { x: found.x, y: found.y, face: dy === 1 ? 'north' : 'south' }; break; }
      }
    }
    U.bus.on('parcel', d => {
      const belt = belts[d.room]; if (!belt) return;
      const dir = d.room === 'factory2' ? -1 : 1;
      parcels.push({ x: dir > 0 ? belt.x0 : belt.x1, y: belt.y, dir, exit: dir > 0 ? belt.x1 : belt.x0, room: d.room });
      if (parcels.length > 14) parcels.shift();
    });

    /* focus props per room */
    for (const [room, def] of Object.entries(FOCUS_DEF)) {
      const f = MAP.furniture.find(x => x.t === def.t && MAP.roomAt(x.x, x.y) === room);
      if (!f) continue;
      const s = standNearFurn(f);
      if (s) focus[room] = { x: s.x, y: s.y, face: s.face, label: def.label };
    }
    const hst = MAP.stations.HERALD;
    heraldSpot = standNearTile(hst.x, hst.y);
    const ust = MAP.stations.ULTRON;
    bridgeSpot = standNearTile(ust.x, ust.y);

    /* intentional-movement triggers from the sim */
    U.bus.on('deliverable', d => onDeliverable(d));
    U.bus.on('flagged', d => planBridgeVisit(bodies[d.agentId]));
    U.bus.on('intel', d => planBriefing(bodies[d.agentId], d.dest));
  }

  /* ---------- low-level movement ---------- */
  function goTo(b, tx, ty) {
    const p = MAP.path(b.tile.x, b.tile.y, tx, ty);
    if (!p) return;
    if (!p.length) { b.path = []; arrive(b); return; } // already there — never idle in 'walk'
    b.path = p; b.state = 'walk'; b.sitting = false;
  }

  function arrive(b) {
    const st = MAP.stations[b.id];
    if (b.goal === 'plan') { b.state = 'idle'; return; } // sequencer owns posture
    if (b.goal === 'work' && b.tile.x === st.x && b.tile.y === st.y) {
      b.state = 'work'; b.sitting = true; b.dir = 'north'; b.act = null; // desks face away from camera
    } else if (b.goal === 'social') {
      const spot = b.socialSpot || {};
      const partyOn = SIM.S && SIM.S.party > SIM.S.time;
      b.state = 'social'; b.sitting = !!MAP.sitTiles[b.tile.x + ',' + b.tile.y];
      b.hasCan = (spot.kind === 'bar' || partyOn) && U.chance(0.75);
      // face the thing you came for, not the camera
      b.dir = { bar: 'north', tv: 'north', arcade: 'north', juke: 'west', window: 'south' }[spot.kind] || 'south';
      b.act = {
        bar: 'at the bar', tv: 'watching the morale board', arcade: 'arcade run',
        juke: 'picking a track', window: 'staring into the void'
      }[spot.kind] || 'off duty';
      // spot-flavored chatter — wires the authored arcade/tv banter pools
      const pool = { arcade: 'arcade_banter', tv: 'tv_banter' }[spot.kind];
      if (pool && DATA.C[pool] && U.chance(0.22)) SIM.crewChat(b.id, U.pick(DATA.C[pool]));
    } else { b.state = 'idle'; b.dir = 'south'; }
  }

  function setGlance(b, dir, ms) { b.glance = { dir, until: nowMs + ms }; }

  /* ---------- plan sequencer ----------
     plan: { tag, steps[], i, flush?, onDone? }
     step: {go:{x,y}} | {face:dir} | {sit:bool} | {wait:ms} | {do:fn} */
  function runPlan(b) {
    const p = b.plan; if (!p) return;
    while (p.i < p.steps.length) {
      const s = p.steps[p.i];
      if (s.go) {
        if (!s._issued) {
          s._issued = true;
          if (b.tile.x === s.go.x && b.tile.y === s.go.y) { p.i++; continue; }
          const path = MAP.path(b.tile.x, b.tile.y, s.go.x, s.go.y);
          if (!path || !path.length) return abortPlan(b);
          b.path = path; b.state = 'walk'; b.sitting = false; b.goal = 'plan';
          return;
        }
        if (b.path.length) return; // en route
        if (b.tile.x === s.go.x && b.tile.y === s.go.y) { p.i++; continue; }
        return abortPlan(b); // knocked off course
      }
      if (s.face) { b.dir = s.face; p.i++; continue; }
      if (s.sit !== undefined) { b.sitting = s.sit; p.i++; continue; }
      if (s.do) { s.do(b); p.i++; continue; }
      if (s.wait) {
        if (!s._until) { s._until = nowMs + s.wait; if (b.state === 'walk') b.state = 'idle'; }
        if (nowMs < s._until) return;
        p.i++; continue;
      }
      p.i++;
    }
    const done = p.onDone;
    b.plan = null; b.act = null; b.goal = 'work';
    if (done) done(b);
  }

  function abortPlan(b) {
    if (!b.plan) return;
    const f = b.plan.flush;
    b.plan = null; b.act = null;
    if (b.state === 'walk' && !b.path.length) b.state = 'idle';
    if (f) f();
  }

  /* settle back at the desk after a plan that ends with {go: station} */
  function homeDone(b) {
    const st = MAP.stations[b.id];
    if (b.tile.x === st.x && b.tile.y === st.y) { b.state = 'work'; b.sitting = true; b.dir = 'north'; }
    else b.state = 'idle';
  }

  /* ---------- intentional journeys ---------- */

  /* deliverable: stand up → belt → drop parcel → watch it ride → walk to
     publishing → brief HERALD (publish task is born at that moment) → home */
  function onDeliverable(ship) {
    const b = bodies[ship.agentId];
    const belt = beltInfo[ship.room];
    const partyOn = SIM.S && SIM.S.party > SIM.S.time;
    if (!b || b.plan || partyOn || !belt || !heraldSpot) {
      // can't walk it right now — deliver instantly so nothing is lost
      U.bus.emit('parcel', { room: ship.room });
      SIM.heraldHandoff(ship.id);
      return;
    }
    const thing = (ship.flavor || ship.title || 'deliverable');
    const shortThing = thing.length > 38 ? thing.slice(0, 36) + '…' : thing;
    let dropped = false;
    b.plan = {
      tag: 'ship', i: 0,
      flush: () => { if (SIM.heraldHandoff(ship.id) && !dropped) U.bus.emit('parcel', { room: ship.room }); },
      onDone: homeDone,
      steps: [
        { sit: false },
        { do: bb => { bb.act = 'carrying the deliverable to the belt'; } },
        { go: { x: belt.x, y: belt.y } },
        { face: belt.face },
        { do: bb => { dropped = true; U.bus.emit('parcel', { room: ship.room }); bb.bubble = { until: nowMs + 1500 }; } },
        { wait: 2400 }, // watch it ride
        { do: bb => { bb.act = 'walking it over to publishing'; } },
        { go: { x: heraldSpot.x, y: heraldSpot.y } },
        { do: bb => {
            const hst = MAP.stations.HERALD;
            bb.dir = dirToward(bb.tile.x, bb.tile.y, hst.x, hst.y);
            bb.act = 'briefing HERALD';
            bb.bubble = { until: nowMs + 2600 };
            const hb = bodies.HERALD;
            if (hb) { hb.bubble = { until: nowMs + 3400 }; setGlance(hb, dirToward(hst.x, hst.y, bb.tile.x, bb.tile.y), 2600); }
            SIM.heraldHandoff(ship.id);
            if (U.chance(0.3)) {
              SIM.crewChat(bb.id, U.pick(DATA.C.handoff).replace(/\{thing\}/g, shortThing));
              if (U.chance(0.6)) SIM.crewChat('HERALD', U.pick(DATA.C.handoff_reply));
            }
          } },
        { wait: 1600 },
        { do: bb => { bb.act = 'heading back to station'; } },
        { go: { x: MAP.stations[ship.agentId].x, y: MAP.stations[ship.agentId].y } }
      ]
    };
  }

  /* flagged work: walk to the bridge, present it, walk back, then pace */
  function planBridgeVisit(b) {
    if (!b || b.plan || !bridgeSpot) return;
    const partyOn = SIM.S && SIM.S.party > SIM.S.time;
    if (partyOn) return;
    const ust = MAP.stations.ULTRON;
    b.plan = {
      tag: 'bridge', i: 0, onDone: homeDone,
      steps: [
        { sit: false },
        { do: bb => { bb.act = 'taking flagged work to the bridge'; } },
        { go: { x: bridgeSpot.x, y: bridgeSpot.y } },
        { do: bb => {
            bb.dir = dirToward(bb.tile.x, bb.tile.y, ust.x, ust.y);
            bb.act = 'presenting flagged work';
            bb.bubble = { until: nowMs + 2400 };
            const ub = bodies.ULTRON;
            if (ub) { ub.bubble = { until: nowMs + 3000 }; setGlance(ub, dirToward(ust.x, ust.y, bb.tile.x, bb.tile.y), 2400); }
          } },
        { wait: 2000 },
        { go: { x: MAP.stations[b.id].x, y: MAP.stations[b.id].y } }
      ]
    };
  }

  /* fresh research: walk to the builder's desk and brief them in person */
  function planBriefing(b, destId) {
    const db = bodies[destId];
    if (!b || !db || b.plan || db.state === 'social') return;
    const partyOn = SIM.S && SIM.S.party > SIM.S.time;
    if (partyOn) return;
    const dst = MAP.stations[destId];
    const spot = standNearTile(dst.x, dst.y);
    if (!spot) return;
    b.plan = {
      tag: 'brief', i: 0, onDone: homeDone,
      steps: [
        { sit: false },
        { do: bb => { bb.act = 'walking intel over to @' + destId; } },
        { go: { x: spot.x, y: spot.y } },
        { do: bb => {
            bb.dir = dirToward(bb.tile.x, bb.tile.y, dst.x, dst.y);
            bb.act = 'briefing @' + destId;
            bb.bubble = { until: nowMs + 2400 };
            db.bubble = { until: nowMs + 3200 };
            setGlance(db, dirToward(dst.x, dst.y, bb.tile.x, bb.tile.y), 2600);
          } },
        { wait: 2000 },
        { go: { x: MAP.stations[b.id].x, y: MAP.stations[b.id].y } }
      ]
    };
  }

  /* idle visit: drop by the buddy's desk, trade a few words, head back */
  function planVisit(b, otherId) {
    const ob = bodies[otherId];
    if (!ob || ob.state !== 'work') return false;
    const ost = MAP.stations[otherId];
    const spot = standNearTile(ost.x, ost.y);
    if (!spot) return false;
    b.plan = {
      tag: 'visit', i: 0, onDone: homeDone,
      steps: [
        { sit: false },
        { do: bb => { bb.act = 'visiting @' + otherId; } },
        { go: { x: spot.x, y: spot.y } },
        { do: bb => {
            bb.dir = dirToward(bb.tile.x, bb.tile.y, ost.x, ost.y);
            bb.bubble = { until: nowMs + 2200 };
            ob.bubble = { until: nowMs + 2800 };
            setGlance(ob, dirToward(ost.x, ost.y, bb.tile.x, bb.tile.y), 2600);
            if (U.chance(0.15)) SIM.crewChat(bb.id, U.pick(DATA.C.hallway).replace(/\{o\}/g, '@' + otherId));
          } },
        { wait: 2400 },
        { go: { x: MAP.stations[b.id].x, y: MAP.stations[b.id].y } }
      ]
    };
    return true;
  }

  /* room focus prop: walk over, face it, ponder, drift back later */
  function planProp(b) {
    const room = DATA.AGENT[b.id].room;
    const fc = focus[room];
    if (!fc) return false;
    b.plan = {
      tag: 'prop', i: 0, onDone: null,
      steps: [
        { sit: false },
        { go: { x: fc.x, y: fc.y } },
        { face: fc.face },
        { do: bb => { bb.act = fc.label; } },
        { wait: U.rnd(2800, 5200) }
      ]
    };
    return true;
  }

  /* pool: claim the table, recruit an idle partner for the far end,
     alternate shots, then both wander home */
  function planPool(b) {
    if (poolBusyUntil > nowMs) return false;
    const partner = Object.values(bodies).find(o =>
      o !== b && o.id !== 'ULTRON' && !o.plan && !o.meet && o.state !== 'social' && o.state !== 'walk' &&
      SIM.S && !SIM.S.agents[o.id].taskId && P(o.id).social > 0.3);
    poolBusyUntil = nowMs + 24000;
    startPool(b, POOL_SPOTS[0], partner ? partner.id : null, 0);
    if (partner) startPool(partner, POOL_SPOTS[1], b.id, 1);
    return true;
  }
  function startPool(b, spot, otherId, offset) {
    const steps = [
      { sit: false },
      { do: bb => { bb.act = otherId ? 'pool — vs @' + otherId : 'practicing pool shots'; } },
      { go: { x: spot.x, y: spot.y } },
      { face: spot.face },
      { wait: 600 + offset * 1100 }
    ];
    for (let r = 0; r < 4; r++) {
      steps.push({ wait: 2200 });
      steps.push({ do: bb => {
        bb.bubble = { until: nowMs + 1100 };
        if (U.chance(0.05)) SIM.crewChat(bb.id, U.pick(DATA.C.pool_banter));
      } });
    }
    steps.push({ wait: 1000 });
    steps.push({ go: { x: MAP.stations[b.id].x, y: MAP.stations[b.id].y } });
    b.plan = { tag: 'pool', i: 0, steps, onDone: homeDone };
  }

  /* ULTRON: inspection round — visit the busiest room, look things over */
  function planInspection(b) {
    let best = null, bestN = 0;
    for (const r of MAP.ROOM_IDS) {
      if (r === 'bridge' || r === 'quarters') continue;
      const n = bodiesInRoom(r).filter(o => o.state === 'work').length;
      if (n > bestN) { bestN = n; best = r; }
    }
    if (!best) return false;
    const spot = MAP.randomSpotIn(best);
    if (!spot) return false;
    b.plan = {
      tag: 'inspect', i: 0, onDone: homeDone,
      steps: [
        { sit: false },
        { do: bb => { bb.act = 'inspection round — ' + (DATA.ROOMS[best] ? DATA.ROOMS[best].name.split(' —')[0] : best); } },
        { go: { x: spot.x, y: spot.y } },
        { do: bb => {
            const crew = bodiesInRoom(best).filter(o => o !== bb);
            for (const o of crew) setGlance(o, dirToward(o.tile.x, o.tile.y, bb.tile.x, bb.tile.y), U.rnd(1200, 2400));
            if (crew.length) bb.dir = dirToward(bb.tile.x, bb.tile.y, crew[0].tile.x, crew[0].tile.y);
            bb.bubble = { until: nowMs + 1800 };
          } },
        { wait: 2600 },
        { go: { x: MAP.stations.ULTRON.x, y: MAP.stations.ULTRON.y } }
      ]
    };
    return true;
  }

  /* quarters trip via the social system (bar/tv/arcade/juke/window) */
  function leisureTrip(b, partyMode) {
    const pref = P(b.id).spot;
    const taken = s => Object.values(bodies).some(o => o !== b && o.socialSpot && o.socialSpot.x === s.x && o.socialSpot.y === s.y);
    let pool = MAP.social.filter(s => !taken(s));
    if (!pool.length) pool = MAP.social;
    if (!partyMode && pref && pref !== 'pool') {
      const liked = pool.filter(s => s.kind === pref);
      if (liked.length) pool = liked;
    }
    const spot = U.pick(pool);
    b.socialSpot = spot;
    b.goal = 'social';
    if (!partyMode) b.breakUntil = nowMs + U.rnd(10000, 22000);
    goTo(b, spot.x, spot.y);
  }

  /* ---------- decision-making ---------- */
  function think(b) {
    const S = SIM.S; if (!S) return;
    const ag = S.agents[b.id];
    const partyOn = S.party > S.time;
    const hasTask = !!ag.taskId;
    b.alert = S.feedback.some(f => f.agentId === b.id && f.status === 'open');
    b.working = b.state === 'work' && hasTask;

    if (partyOn && b.id !== 'ULTRON') { // ultron never parties
      if (b.plan) abortPlan(b); // flush() guards any in-flight handoff
      if (b.state !== 'social' && b.goal !== 'social') leisureTrip(b, true);
      return;
    }
    if (b.plan) return;                                  // sequencer owns the body
    if (b.meet && nowMs < b.meet.until) return;          // mid-hallway-chat
    if (b.state === 'social' && !partyOn && nowMs > b.breakUntil) {
      b.goal = 'work'; b.hasCan = false; b.act = null; b.socialSpot = null;
      const st = MAP.stations[b.id];
      goTo(b, st.x, st.y);
      return;
    }
    if (b.state === 'walk') return;

    /* ULTRON walks the floor on a cadence even while orchestrating — command is presence */
    if (b.id === 'ULTRON' && nowMs > (b.nextInspect || 0)) {
      b.nextInspect = nowMs + U.rnd(50000, 110000);
      if (planInspection(b)) return;
    }

    if (hasTask) {
      if (b.socialSpot) { b.socialSpot = null; b.hasCan = false; } // free the seat a task pulled us from
      const st = MAP.stations[b.id];
      if (b.tile.x !== st.x || b.tile.y !== st.y) { b.goal = 'work'; goTo(b, st.x, st.y); }
      else { b.state = 'work'; b.sitting = true; b.hasCan = false; b.act = null; }
      return;
    }

    /* idle behaviors */
    if (nowMs <= b.nextWander) return;
    const PR = P(b.id);
    b.nextWander = nowMs + U.rnd(9000, 26000) / PR.restless;

    if (b.alert) { // pace near the desk, eyes on the bridge, until the Commander rules
      const st = MAP.stations[b.id];
      const spot = standNearTile(st.x, st.y);
      b.goal = 'idle'; b.act = 'awaiting Commander feedback';
      if (spot && U.chance(0.7)) goTo(b, spot.x, spot.y);
      else goTo(b, st.x, st.y);
      b.nextWander = nowMs + U.rnd(4000, 9000);
      return;
    }

    const roll = Math.random();
    if (b.id === 'ULTRON') {
      if (roll < 0.42 && planInspection(b)) return;
      if (roll < 0.62 && planProp(b)) return;
      if (roll < 0.82) { const s = MAP.randomSpotIn('bridge'); if (s) { b.goal = 'idle'; goTo(b, s.x, s.y); } return; }
      b.goal = 'work'; goTo(b, MAP.stations.ULTRON.x, MAP.stations.ULTRON.y);
      return;
    }
    if (roll < 0.20 && PR.buddy && planVisit(b, PR.buddy)) {
      const ag2 = S.agents[b.id];
      ag2.morale = U.clamp(ag2.morale + 1.5, 0, 100);
      return;
    }
    if (roll < 0.20 + 0.28 * PR.social) { // quarters break — off the clock means off the clock
      // pool regulars rack up by preference; anyone social grabs a cue now and then
      if ((PR.spot === 'pool' || (PR.social > 0.5 && U.chance(0.22))) && planPool(b)) { ag.morale = U.clamp(ag.morale + 3, 0, 100); return; }
      leisureTrip(b, false);
      ag.morale = U.clamp(ag.morale + 3, 0, 100);
      return;
    }
    if (roll < 0.62) {
      if (U.chance(0.5) && planProp(b)) return;
      const spot = MAP.randomSpotIn(DATA.AGENT[b.id].room);
      if (spot) { b.goal = 'idle'; goTo(b, spot.x, spot.y); }
      return;
    }
    const st = MAP.stations[b.id];
    b.goal = 'work'; goTo(b, st.x, st.y);
  }

  /* ---------- awareness scans (throttled to ~4Hz) ---------- */
  function scanWorld() {
    const all = Object.values(bodies);
    const walkers = all.filter(o => o.state === 'walk' && o.path.length);

    /* glances: seated/standing agents notice passers-by, parcels, the bridge */
    for (const b of all) {
      if (b.state === 'walk') continue;
      if (b.glance && b.glance.until > nowMs) continue;
      if (b.glanceCd > nowMs) continue;
      // ── THE LOOK-UP (crew, lighter) ───────────────────────────────────────────────────────────────
      // rarely, ONE crew member quietly looks up from whatever it's doing — straight at the Commander
      // (the camera) — holds a beat, then carries on. One at a time (lastCrewLook) + a long per-body floor
      // (b.lookCd): the colony should feel watched, not staring. drawBody renders a glancing worker facing
      // you (the typing pose yields to it), so it reads as "it looked up from its work and saw me."
      if (nowMs - lastCrewLook > 12000 && nowMs > (b.lookCd || 0) && U.chance(0.004)) {
        setGlance(b, 'south', U.rnd(700, 1300));
        b.glanceCd = nowMs + U.rnd(2200, 3600);
        b.lookCd = nowMs + U.rnd(150000, 240000);
        lastCrewLook = nowMs;
        continue;
      }
      let done = false;
      for (const w of walkers) {
        if (w === b) continue;
        if (Math.abs(w.px - b.px) < 26 && Math.abs(w.py - b.py) < 26 && U.chance(0.55)) {
          setGlance(b, dirToward(b.px, b.py, w.px, w.py), U.rnd(450, 850));
          b.glanceCd = nowMs + 6000; done = true; break;
        }
      }
      if (done) continue;
      const room = MAP.roomAt(b.tile.x, b.tile.y);
      if (room === 'factory1' || room === 'factory2') {
        for (const p of parcels) {
          if (p.room === room && Math.abs(p.x - b.px) < 24 && Math.abs(p.y - b.py) < 32 && U.chance(0.4)) {
            setGlance(b, dirToward(b.px, b.py, p.x, p.y), U.rnd(500, 900));
            b.glanceCd = nowMs + 5000; done = true; break;
          }
        }
      }
      if (done) continue;
      if (b.alert && U.chance(0.18)) { // eyes drift to the bridge while waiting on a verdict
        const ust = MAP.stations.ULTRON;
        setGlance(b, dirToward(b.tile.x, b.tile.y, ust.x, ust.y), U.rnd(700, 1200));
        b.glanceCd = nowMs + 7000; continue;
      }
      if (b.working && nowMs > b.nextFidget) { // look up from the screen, think, back to it
        setGlance(b, U.pick(['east', 'west', 'south']), U.rnd(500, 950));
        b.nextFidget = nowMs + U.rnd(9000, 22000);
        b.glanceCd = nowMs + 3000;
      }
    }

    /* hallway encounters: two walkers cross paths, stop, chat, move on */
    for (let i = 0; i < walkers.length; i++) {
      const a = walkers[i];
      if (a.meet || a.meetCd > nowMs) continue;
      for (let j = i + 1; j < walkers.length; j++) {
        const c = walkers[j];
        if (c.meet || c.meetCd > nowMs) continue;
        if (Math.abs(a.px - c.px) > 17 || Math.abs(a.py - c.py) > 17) continue;
        const key = a.id < c.id ? a.id + '|' + c.id : c.id + '|' + a.id;
        if (pairCd[key] > nowMs) continue;
        if (!U.chance(0.45 * Math.min(P(a.id).chat, P(c.id).chat))) { pairCd[key] = nowMs + 30000; continue; }
        const until = nowMs + U.rnd(1700, 3000);
        a.meet = { until, partner: c.id }; c.meet = { until, partner: a.id };
        a.dir = dirToward(a.px, a.py, c.px, c.py); c.dir = dirToward(c.px, c.py, a.px, a.py);
        a.bubble = { until: until - 300 }; c.bubble = { until };
        a.act = a.act || 'hallway sync'; c.act = c.act || 'hallway sync';
        pairCd[key] = nowMs + U.rnd(120000, 300000);
        a.meetCd = nowMs + 45000; c.meetCd = nowMs + 45000;
        if (U.chance(0.22)) {
          const [from, other] = U.chance(0.5) ? [a.id, c.id] : [c.id, a.id];
          SIM.crewChat(from, U.pick(DATA.C.hallway).replace(/\{o\}/g, '@' + other));
        }
        break;
      }
    }
  }

  /* ---------- main tick ---------- */
  function tick(dtMs, tMs) {
    nowMs = tMs;
    const S = SIM.S;
    for (const id in bodies) {
      const b = bodies[id];
      if (b.meet) { // paused mid-hallway: face partner, say nothing with great animation
        if (nowMs >= b.meet.until) { b.meet = null; if (b.act === 'hallway sync') b.act = null; }
        else continue;
      }
      if (b.plan) runPlan(b);
      if (b.path.length) {
        const morSlow = S && S.agents[b.id] && S.agents[b.id].morale < 40 ? 0.85 : 1;
        const speed = 42 * P(id).pace * morSlow * dtMs / 1000;
        const next = b.path[0];
        const txp = next.x * T + T / 2, typ = next.y * T + T - 1;
        const dx = txp - b.px, dy = typ - b.py;
        const d = Math.hypot(dx, dy);
        if (Math.abs(dx) > Math.abs(dy)) b.dir = dx > 0 ? 'east' : 'west';
        else if (Math.abs(dy) > 0.5) b.dir = dy > 0 ? 'south' : 'north';
        if (d <= speed) {
          b.px = txp; b.py = typ; b.tile = { x: next.x, y: next.y }; b.path.shift();
          if (!b.path.length) arrive(b);
        } else { b.px += dx / d * speed; b.py += dy / d * speed; }
      } else if (b.state === 'walk' && !b.plan) arrive(b); // stranded mid-walk — resolve
      else if (!b.plan && U.chance(0.02)) think(b);
      if (!b.plan && U.chance(0.012)) think(b);
    }
    scanAcc += dtMs;
    if (scanAcc >= 250) { scanAcc = 0; scanWorld(); }
    // parcels ride belts
    for (let i = parcels.length - 1; i >= 0; i--) {
      const p = parcels[i];
      p.x += p.dir * 14 * dtMs / 1000;
      if ((p.dir > 0 && p.x > p.exit) || (p.dir < 0 && p.x < p.exit)) parcels.splice(i, 1);
    }
  }

  function bodiesInRoom(roomId) {
    return Object.values(bodies).filter(b => MAP.roomAt(b.tile.x, b.tile.y) === roomId);
  }
  function bodyAt(pxX, pxY) {
    let best = null, bd = 12;
    for (const id in bodies) {
      const b = bodies[id];
      const d = Math.hypot(b.px - pxX, b.py - (pxY + 7));
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }
  /* physical-activity status for the UI — null when nothing noteworthy */
  function statusFor(id) {
    const b = bodies[id];
    return (b && b.act) || null;
  }

  return { init, tick, bodies, get parcels() { return parcels; }, bodiesInRoom, bodyAt, statusFor };
})();
