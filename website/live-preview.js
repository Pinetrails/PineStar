/* live-preview.js — live in-browser render of the actual StarNet starter room.
   The room image IS the app's own render (captured plate, agent removed), and the
   agent IS the app's real `blank` skin sprite frames. The behavior loop here is
   scripted for the page; the caption says so. */
(function(){
  'use strict';
  var cv = document.getElementById('live-preview');
  if(!cv) return;
  var ctx = cv.getContext('2d');
  var W = cv.width, H = cv.height;

  var plate = new Image(); plate.src = 'assets/live/room-plate.png';
  var sheet = new Image(); sheet.src = 'assets/live/blank-sheet.png';
  var map = null;
  fetch('assets/live/blank-sheet.json').then(function(r){ return r.json(); }).then(function(j){ map = j; });

  var A = 50;                                 // agent draw size (matches the capture scale)
  var SEAT = { x: 299, y: 276 };              // the chair below the desk (feet position)
  var WAYPOINTS = [                            // in-room wander spots (kept off the walls)
    { x: 210, y: 410 }, { x: 450, y: 370 }, { x: 340, y: 550 },
    { x: 160, y: 550 }, { x: 530, y: 510 }, { x: 330, y: 350 }
  ];
  var SPEED = 55;                             // px/s, unhurried like the app's idle walk

  function frameRect(name){
    var i = map.names.indexOf(name);
    if (i < 0) i = 0;
    return { sx: (i % map.cols) * map.cell, sy: Math.floor(i / map.cols) * map.cell };
  }

  // state machine: sit/work at the desk, stand, wander a few spots, come back
  var st = { mode: 'sit', until: 0, x: SEAT.x, y: SEAT.y, tx: 0, ty: 0, dir: 'north', wpQueue: [], blinkAt: 0, blinking: 0 };
  function schedule(now){
    if (st.mode === 'sit' && now > st.until){
      st.mode = 'stand'; st.dir = 'south'; st.until = now + 1200 + Math.random()*1500;
      st.x = SEAT.x; st.y = SEAT.y + 14;   // step off the chair
      var n = 1 + Math.floor(Math.random()*3);
      st.wpQueue = [];
      var pool = WAYPOINTS.slice();
      while (n-- > 0 && pool.length) st.wpQueue.push(pool.splice(Math.floor(Math.random()*pool.length),1)[0]);
    } else if (st.mode === 'stand' && now > st.until){
      var next = st.wpQueue.shift();
      if (next){ st.mode = 'walk'; st.tx = next.x; st.ty = next.y; }
      else { st.mode = 'walk'; st.tx = SEAT.x; st.ty = SEAT.y + 14; st.wpQueue = null; }
    } else if (st.mode === 'walk'){
      var dx = st.tx - st.x, dy = st.ty - st.y, d = Math.hypot(dx, dy);
      if (d < 3){
        if (st.wpQueue === null){ st.mode = 'sit'; st.dir = 'north'; st.x = SEAT.x; st.y = SEAT.y; st.until = now + 6000 + Math.random()*6000; st.wpQueue = []; }
        else { st.mode = 'stand'; st.until = now + 900 + Math.random()*2200; st.dir = (Math.random() < 0.5 ? 'south' : (Math.random() < 0.5 ? 'east' : 'west')); }
      }
    }
  }
  function step(dt){
    if (st.mode !== 'walk') return;
    var dx = st.tx - st.x, dy = st.ty - st.y, d = Math.hypot(dx, dy) || 1;
    var v = SPEED * dt / 1000;
    st.x += dx / d * Math.min(v, d); st.y += dy / d * Math.min(v, d);
    st.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north');
  }
  function spriteName(now){
    if (st.mode === 'sit'){
      return 'type_north_' + (Math.floor(now / 240) % 4);        // the app's real typing pose
    }
    if (st.mode === 'walk') return 'walk_' + st.dir + '_' + (Math.floor(now / 120) % 6);
    // standing: rot pose with real blinks
    if (!st.blinkAt || now > st.blinkAt + 4000){ st.blinkAt = now + 2500 + Math.random()*2500; }
    if (now > st.blinkAt && now < st.blinkAt + 160) return 'blink_' + st.dir;
    return 'rot_' + st.dir;
  }

  var last = 0;
  function draw(now){
    if (!last) last = now;
    var dt = Math.min(50, now - last); last = now;
    schedule(now); step(dt);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(plate, 0, 0);
    // foot shadow (the app anchors sprites by their feet over a soft shadow)
    var sitting = st.mode === 'sit';
    var fy = sitting ? SEAT.y : st.y;
    var fx = sitting ? SEAT.x : st.x;
    ctx.fillStyle = 'rgba(0,0,0,.42)';
    ctx.beginPath(); ctx.ellipse(fx, fy + 2, A*0.26, 5, 0, 0, Math.PI*2); ctx.fill();
    // agent — smooth-downscaled like the app draws its skins
    if (map && sheet.complete){
      var r = frameRect(spriteName(now));
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(sheet, r.sx, r.sy, map.cell, map.cell, fx - A/2, fy - A + 8, A, A);
    }
    requestAnimationFrame(draw);
  }

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  plate.onload = function(){
    if (reduce){
      ctx.drawImage(plate, 0, 0);
      var t = setInterval(function(){
        if (map && sheet.complete){
          clearInterval(t);
          var r = frameRect('sit_north');
          ctx.fillStyle = 'rgba(0,0,0,.42)';
          ctx.beginPath(); ctx.ellipse(SEAT.x, SEAT.y + 2, A*0.26, 5, 0, 0, Math.PI*2); ctx.fill();
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(sheet, r.sx, r.sy, 92, 92, SEAT.x - A/2, SEAT.y - A + 8, A, A);
        }
      }, 120);
      return;
    }
    requestAnimationFrame(draw);
  };
})();
