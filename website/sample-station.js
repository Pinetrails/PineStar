/* sample-station.js — an illustrative station scene built from the app's real
   engine sprites. Clearly labeled a sample on the page; not a live feed. */
(function(){
  'use strict';
  var cv = document.getElementById('sample-station');
  if(!cv) return;
  var ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  var W = cv.width, H = cv.height;
  var WALL_H = 78, TILE = 32;

  var FILES = ['sit_north','rot_south','desk','console','plant','crate','screens'];
  for (var i=0;i<6;i++){ FILES.push('walk_east_'+i); FILES.push('walk_west_'+i); }
  var img = {}, loaded = 0, total = FILES.length;
  FILES.forEach(function(n){
    var im = new Image();
    im.onload = im.onerror = function(){ if(++loaded === total) start(); };
    im.src = 'assets/sample/' + n + '.png';
    img[n] = im;
  });

  // layout (canvas px)
  var deskX = 96, deskY = 118;             // desk.png is 96x72
  var consX = 470, consY = 112;            // console
  var seatX = deskX + 26, seatY = deskY + 44;   // where the agent sits (south of desk, facing north)
  var consStandX = consX - 40, standY = seatY;  // where it stands to use the console
  var A = 60;                               // agent draw size (sprites are 92px)

  // phases: work at desk -> walk to console -> use console -> walk back
  var PHASES = [
    { name:'work',  dur:4200, line:'> run live — drafting the report' },
    { name:'east',  dur:2400, line:'> tool needed: web — heading to the uplink console' },
    { name:'use',   dur:2600, line:'> web.fetch … sources pulled (real tool, real grant)' },
    { name:'west',  dur:2400, line:'> back to the desk — filing the deliverable' }
  ];
  var phase = 0, t0 = 0, typed = 0;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function floor(){
    // wall
    ctx.fillStyle = '#141009';
    ctx.fillRect(0, 0, W, WALL_H);
    ctx.fillStyle = '#1c1207';
    ctx.fillRect(0, WALL_H - 8, W, 8);
    ctx.fillStyle = 'rgba(255,157,47,.5)';
    ctx.fillRect(0, WALL_H - 2, W, 2);
    // wall screens prop
    if (img.screens.width) ctx.drawImage(img.screens, 340, WALL_H - 60, 96, 56);
    // floor tiles (two-tone checker like the app's dark deck)
    for (var y = WALL_H; y < H; y += TILE){
      for (var x = 0; x < W; x += TILE){
        var odd = ((x / TILE) + (y / TILE)) % 2;
        ctx.fillStyle = odd ? '#100c08' : '#0d0a07';
        ctx.fillRect(x, y, TILE, TILE);
      }
    }
    ctx.strokeStyle = 'rgba(255,157,47,.05)';
    ctx.lineWidth = 1;
    for (var gx = 0; gx <= W; gx += TILE){ ctx.beginPath(); ctx.moveTo(gx+.5, WALL_H); ctx.lineTo(gx+.5, H); ctx.stroke(); }
    for (var gy = WALL_H; gy <= H; gy += TILE){ ctx.beginPath(); ctx.moveTo(0, gy+.5); ctx.lineTo(W, gy+.5); ctx.stroke(); }
  }

  function glow(x, y, w, h, a){
    var g = ctx.createRadialGradient(x + w/2, y + h/2, 4, x + w/2, y + h/2, w);
    g.addColorStop(0, 'rgba(120,200,255,' + (0.16 * a) + ')');
    g.addColorStop(1, 'rgba(120,200,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - w/2, y - h/2, w*2, h*2);
  }

  function agent(sprite, x, y){
    // foot shadow, then sprite anchored by feet
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.beginPath();
    ctx.ellipse(x, y + A/2 - 3, A*0.28, 6, 0, 0, Math.PI*2);
    ctx.fill();
    if (sprite.width) ctx.drawImage(sprite, x - A/2, y - A/2, A, A);
  }

  function scene(now){
    var ph = PHASES[phase];
    var k = Math.min(1, (now - t0) / ph.dur);
    floor();

    // props
    if (img.plant.width) ctx.drawImage(img.plant, W - 58, WALL_H - 26, 40, 56);
    if (img.crate.width) ctx.drawImage(img.crate, 300, 236, 44, 40);
    if (img.desk.width)  ctx.drawImage(img.desk, deskX, deskY, 96, 72);
    if (img.console.width) ctx.drawImage(img.console, consX, consY, 72, 84);

    var ax = seatX, ay = seatY, sprite = img.sit_north, wf;
    if (ph.name === 'work'){
      glow(deskX + 30, deskY + 8, 40, 22, 0.7 + 0.3 * Math.sin(now / 260));
    } else if (ph.name === 'east'){
      ax = seatX + (consStandX - seatX) * k; ay = standY;
      wf = img['walk_east_' + (Math.floor(now / 110) % 6)];
      sprite = wf;
    } else if (ph.name === 'use'){
      ax = consStandX; ay = standY;
      sprite = img.rot_south.width ? img.rot_south : img.sit_north;
      glow(consX + 16, consY + 14, 40, 26, 0.7 + 0.3 * Math.sin(now / 200));
    } else {
      ax = consStandX + (seatX - consStandX) * k; ay = standY;
      wf = img['walk_west_' + (Math.floor(now / 110) % 6)];
      sprite = wf;
    }
    agent(sprite, ax, ay);

    // status line, typed
    var line = ph.line;
    if (typed < line.length) typed += 1;
    ctx.font = '15px VT323, monospace';
    ctx.fillStyle = 'rgba(255,196,107,.9)';
    ctx.fillText(line.slice(0, typed), 14, H - 12);
    if (Math.floor(now / 500) % 2 === 0){
      var wpx = ctx.measureText(line.slice(0, typed)).width;
      ctx.fillRect(16 + wpx, H - 24, 7, 14);
    }
    // vignette
    var v = ctx.createRadialGradient(W/2, H*0.42, H*0.3, W/2, H*0.42, W*0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,.42)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);

    if (k >= 1){ phase = (phase + 1) % PHASES.length; t0 = now; typed = 0; }
  }

  function start(){
    if (reduce){
      floor();
      if (img.plant.width) ctx.drawImage(img.plant, W - 58, WALL_H - 26, 40, 56);
      if (img.crate.width) ctx.drawImage(img.crate, 300, 236, 44, 40);
      if (img.desk.width)  ctx.drawImage(img.desk, deskX, deskY, 96, 72);
      if (img.console.width) ctx.drawImage(img.console, consX, consY, 72, 84);
      agent(img.sit_north, seatX, seatY);
      ctx.font = '15px VT323, monospace';
      ctx.fillStyle = 'rgba(255,196,107,.9)';
      ctx.fillText('> run live — drafting the report', 14, H - 12);
      return;
    }
    t0 = performance.now();
    (function loop(now){ scene(now); requestAnimationFrame(loop); })(t0);
  }
})();
