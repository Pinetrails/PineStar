/* live-preview.js — live in-browser render of the actual StarNet starter room.
   The room image IS the app's own render (captured plate, agent removed) and the agent
   IS the app's real `blank` skin sheet. Movement + drawing replicate the app's own rules
   (world.js tick + assets.js drawBody): tile-grid Manhattan walks at the hero's 34 wpx/s,
   10fps walk / 6fps typing / 4fps sit, idle bob + staggered blink, thin rect contact
   shadow, foot-pad anchoring. The behavior loop is scripted for the page; caption says so. */
(function(){
  'use strict';
  var cv = document.getElementById('live-preview');
  if(!cv) return;
  var ctx = cv.getContext('2d');

  var plate = new Image(); plate.src = 'assets/live/room-plate.png';
  var sheet = new Image(); sheet.src = 'assets/live/blank-sheet.png';
  var map = null;
  fetch('assets/live/blank-sheet.json').then(function(r){ return r.json(); }).then(function(j){ map = j; });

  /* ---- capture-scale constants (world px -> plate px, from the trunk capture) ---- */
  var SX = 3.123, SY = 2.99, OX = -78, OY = -50.3;   // plate = world*S + O
  var TILE = 12.5;                                    // world px per tile (the app's grid)
  function tileC(tx, ty){ return { x: SX*(TILE*tx + TILE/2) + OX, y: SY*(TILE*ty + TILE/2) + OY }; }

  var A = 96;                       // drawn sprite size: the app's 92px master at capture scale (+9% page legibility)
  var FOOT_PAD = 23;                // assets.js DEFAULT_FOOT: transparent rows under the feet in the master
  var GROUND_BITE = -3;             // assets.js: feet ride a hair above the shadow line
  var SPEED = 34 * SX;              // the hero's exact walk speed (34 world px/s) at capture scale

  /* the starter-room grid: zone tiles 3..20 x 3..13; desk+monitor block the top-middle */
  var SEAT_T = { x: 11, y: 5 };     // the chair tile below the desk
  var seatP = tileC(SEAT_T.x, SEAT_T.y); seatP.x = 357; seatP.y = 158;   // measured chair contact point
  var CHAIR = { x: 336, y: 118, w: 42, h: 50 };   // chair patch (plate px) redrawn OVER the seated body
  function walkable(tx, ty){
    if (tx < 4 || tx > 19 || ty < 4 || ty > 12) return false;
    if (tx >= 9 && tx <= 13 && ty <= 6) return false;   // desk + chair block
    return true;
  }
  function randTile(){
    for(;;){ var tx = 4 + Math.floor(Math.random()*16), ty = 4 + Math.floor(Math.random()*9);
      if (walkable(tx, ty)) return { x: tx, y: ty }; }
  }

  function frameRect(name){
    var i = map.names.indexOf(name);
    if (i < 0) i = 0;
    return { sx: (i % map.cols) * map.cell, sy: Math.floor(i / map.cols) * map.cell };
  }
  function frames(prefix){   // how many numbered frames a track has in the sheet
    var n = 0; while (map.names.indexOf(prefix + '_' + n) >= 0) n++;
    return n || 1;
  }

  /* ---- body state (mirrors the app's agent body) ---- */
  var st = {
    mode: 'sit',                    // sit (typing at desk) | idle | walk
    until: 0, x: seatP.x, y: seatP.y,
    tile: { x: SEAT_T.x, y: SEAT_T.y },
    path: [], dir: 'north',
    phase: Math.random()*6.28,      // per-body anim stagger, like b.phase
    glanceUntil: 0, glanceDir: null,
    trips: 0
  };

  /* Manhattan path between tiles (the app A*'s an empty floor into the same L-shape) */
  function pathTo(t){
    var pts = [], cx = st.tile.x, cy = st.tile.y;
    var xFirst = Math.random() < 0.5;
    function pushX(){ while (cx !== t.x){ cx += (t.x > cx ? 1 : -1); pts.push({ x: cx, y: cy }); } }
    function pushY(){ while (cy !== t.y){ cy += (t.y > cy ? 1 : -1); pts.push({ x: cx, y: cy }); } }
    // legs ordered so the corner tile stays walkable
    if (xFirst && walkable(t.x, cy)) { pushX(); pushY(); }
    else if (walkable(cx, t.y)) { pushY(); pushX(); }
    else { pushX(); pushY(); }
    return pts;
  }
  function irnd(a, b){ return a + Math.random()*(b - a); }

  function schedule(now){
    if (st.mode === 'sit' && now > st.until){
      // stand up off the chair, then stroll 1-3 spots (the app's idle wander)
      st.mode = 'idle'; st.dir = 'south'; st.until = now + irnd(600, 1400);
      st.tile = { x: SEAT_T.x, y: SEAT_T.y + 2 };            // step clear of the chair
      var p = tileC(st.tile.x, st.tile.y); st.x = p.x; st.y = p.y;
      st.trips = 1 + Math.floor(Math.random()*3);
    } else if (st.mode === 'idle' && now > st.until){
      if (st.trips > 0){ st.trips--; st.path = pathTo(randTile()); st.mode = 'walk'; }
      else {   // head home: walk to below the chair, then take the seat
        st.path = pathTo({ x: SEAT_T.x, y: SEAT_T.y + 2 }); st.mode = 'walk'; st.trips = -1;
      }
    } else if (st.mode === 'walk' && !st.path.length){
      if (st.trips < 0){   // arrived under the chair -> sit and type (the app's work pose)
        st.mode = 'sit'; st.dir = 'north'; st.x = seatP.x; st.y = seatP.y;
        st.tile = { x: SEAT_T.x, y: SEAT_T.y };
        st.until = now + irnd(7000, 14000); st.trips = 0;
      } else {
        st.mode = 'idle'; st.until = now + irnd(1400, 3000);   // world.js idle re-decide window
        if (Math.random() < 0.5) st.dir = ['south','east','west'][Math.floor(Math.random()*3)];
      }
    }
    // occasional head-turn while standing (maybeGlance)
    if (st.mode === 'idle' && now > st.glanceUntil && Math.random() < 0.006){
      st.glanceDir = ['south','east','west','north'][Math.floor(Math.random()*4)];
      st.glanceUntil = now + irnd(500, 900);
    }
  }

  function step(dt){
    if (st.mode !== 'walk' || !st.path.length) return;
    var t = tileC(st.path[0].x, st.path[0].y);
    var dx = t.x - st.x, dy = t.y - st.y, d = Math.hypot(dx, dy);
    if (d < 1.1){ st.x = t.x; st.y = t.y; st.tile = st.path.shift(); return; }
    var s = Math.min(d, SPEED * dt / 1000);
    st.x += dx / d * s; st.y += dy / d * s;
    st.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north');   // world.js facing rule
  }

  /* assets.js drawBody, at capture scale */
  function drawAgent(now){
    if (!map || !sheet.complete) return;
    var name, fps, bob = 0;
    var glancing = now < st.glanceUntil && st.mode === 'idle';
    var dir = glancing ? st.glanceDir : st.dir;
    if (st.mode === 'sit'){ name = 'type_north'; fps = 6; }
    else if (st.mode === 'walk'){ name = 'walk_' + dir; fps = 10; }
    else {
      name = 'rot_' + dir; fps = 4;
      bob = Math.sin(now / 600 + st.phase) * 0.7 * SX;      // idle sway, scaled like the room
      var bt = (now + st.phase * 900) % 3300;                // staggered blink
      if (bt < 130 && map.names.indexOf('blink_' + dir) >= 0) name = 'blink_' + dir;
    }
    var n = frames(name);
    var fi = n > 1 ? Math.floor(now / (1000 / fps) + st.phase) % n : 0;
    var r = frameRect(n > 1 ? name + '_' + fi : (map.names.indexOf(name) >= 0 ? name : name + '_0'));

    var fx = st.x, fy = st.y;
    // thin rect contact shadow — the app's exact ground cue (alpha .24, 26% of body width)
    var shw = Math.max(6, Math.round(A * 0.26));
    ctx.globalAlpha = 0.24; ctx.fillStyle = '#000';
    ctx.fillRect(Math.round(fx) - (shw >> 1), Math.round(fy) - 1, shw, 3);
    ctx.globalAlpha = 1;
    // foot-pad anchor: feet (not the transparent cell bottom) land on the shadow line
    var fp = FOOT_PAD * (A / map.cell);
    var top = Math.round(fy - A + GROUND_BITE + bob + fp);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sheet, r.sx, r.sy, map.cell, map.cell, Math.round(fx - A/2), top, A, A);
    // seated: the chair front renders over the body, like the app's y-sorted props
    if (st.mode === 'sit' && plate.complete){
      ctx.drawImage(plate, CHAIR.x, CHAIR.y + CHAIR.h/2, CHAIR.w, CHAIR.h/2,
                           CHAIR.x, CHAIR.y + CHAIR.h/2, CHAIR.w, CHAIR.h/2);
    }
  }

  var last = 0;
  function draw(now){
    if (!last) last = now;
    var dt = Math.min(50, now - last); last = now;
    schedule(now); step(dt);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(plate, 0, 0);
    drawAgent(now);
    requestAnimationFrame(draw);
  }

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  plate.onload = function(){
    if (reduce){   // static: seated at the desk, one honest frame
      ctx.drawImage(plate, 0, 0);
      var t = setInterval(function(){
        if (map && sheet.complete){ clearInterval(t); drawAgent(0); }
      }, 120);
      return;
    }
    requestAnimationFrame(draw);
  };
})();
