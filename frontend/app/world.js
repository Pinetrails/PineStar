/* SKYNET — world.js : a slim, clean ONE-ROOM world.
   Reuses v7's pixel-art sprite engine (js/assets.js -> SPRITES.drawBody) for the
   character's look, but is its own minimal foundation — NOT the v7 station sim.
   The agent wanders the room; when it's "thinking" (a real model call is in flight)
   it walks to the workstation, sits, and types — so the animation literally means work. */
'use strict';

const World = (() => {
  const TILE = 24, COLS = 20, ROWS = 14;
  const ROOMW = COLS * TILE, ROOMH = ROWS * TILE;

  // a single workstation against the north wall; seat tile sits just south of it
  const desk = { tx: 9, ty: 2, w: 2, h: 1 };
  const seat = { tx: 9, ty: 3 };

  let cv, ctx, raf = 0, last = 0, agent = null, thinking = false, running = false, ro = null, wakeAt = 0;
  let PAL = {};

  const cssVar = (n, fb) => (getComputedStyle(document.body).getPropertyValue(n).trim() || fb);
  const footOf = (tx, ty) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE - 3 });

  /* ---------- lifecycle ---------- */
  function init(canvas) {
    cv = canvas; ctx = cv.getContext('2d');
    PAL = {
      ph: cssVar('--ph', '#ffaa33'), phDim: cssVar('--ph-dim', '#b9791c'),
      phBright: cssVar('--ph-bright', '#ffd9a3'), faint: cssVar('--ph-faint', '#1e1404'),
      panel2: cssVar('--panel2', '#0c0704'), bg: cssVar('--bg', '#030201'),
      text: cssVar('--text', '#eec88f'), data: '#5ad0ff'
    };
    resize();
    try { if (ro) ro.disconnect(); ro = new ResizeObserver(() => resize()); ro.observe(cv.parentElement || cv); } catch (e) { /* unsupported */ }
    window.addEventListener('resize', resize);
  }

  function spawn(a) {
    agent = {
      id: a.id, name: a.name, color: a.color || '#5ad0ff',
      px: footOf(10, 9).x, py: footOf(10, 9).y, dir: 'south',
      state: 'idle', sitting: false, working: false,
      phase: U.hash(a.id) % 6, target: null, idleUntil: 0, goal: null,
      say: { text: '', until: 0 }
    };
  }

  function start() {
    if (running) return;
    running = true; last = performance.now();
    frame(last);   // paint the first frame synchronously, then let rAF drive the loop
  }
  function stop() { running = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  function setThinking(v) { thinking = !!v; }
  function wakeIn() { wakeAt = performance.now(); }   // power-on beat (spawn ring)
  function say(text) {
    if (!agent) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    agent.say = { text: t.slice(0, 160), until: performance.now() + 4200 };
  }

  function resize() {
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || cv.parentElement.clientWidth;
    const h = cv.clientHeight || cv.parentElement.clientHeight;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
  }

  /* ---------- simulation ---------- */
  function tick(dt, now) {
    if (!agent) return;
    const SPEED = 46; // room px / s

    if (thinking && agent.goal !== 'work') { agent.goal = 'work'; agent.sitting = false; agent.working = false; agent.target = footOf(seat.tx, seat.ty); agent.state = 'walk'; }
    if (!thinking && agent.goal === 'work') { agent.goal = null; agent.sitting = false; agent.working = false; agent.target = null; agent.state = 'idle'; agent.idleUntil = now + 300; }

    if (agent.target) {
      const dx = agent.target.x - agent.px, dy = agent.target.y - agent.py;
      const d = Math.hypot(dx, dy);
      if (d < 1.3) {
        agent.px = agent.target.x; agent.py = agent.target.y; agent.target = null;
        if (agent.goal === 'work') { agent.sitting = true; agent.working = true; agent.dir = 'north'; agent.state = 'idle'; }
        else { agent.state = 'idle'; agent.idleUntil = now + U.irnd(800, 2600); }
      } else {
        const s = Math.min(d, SPEED * dt / 1000);
        agent.px += dx / d * s; agent.py += dy / d * s; agent.state = 'walk';
        agent.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north');
      }
    } else if (agent.state !== 'walk' && !agent.sitting && agent.goal !== 'work' && now >= agent.idleUntil) {
      const tx = U.irnd(1, COLS - 2), ty = U.irnd(4, ROWS - 2);
      agent.target = footOf(tx, ty); agent.state = 'walk';
    }
  }

  /* ---------- render ---------- */
  function frame(now) {
    const dt = Math.min(64, now - last); last = now;
    tick(dt, now);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = PAL.bg; ctx.fillRect(0, 0, cv.width, cv.height);

    const scale = Math.min(cv.width / ROOMW, cv.height / ROOMH);
    const ox = (cv.width - ROOMW * scale) / 2, oy = (cv.height - ROOMH * scale) / 2;
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    ctx.imageSmoothingEnabled = false;

    drawFloor();
    drawWalls();

    const deskFoot = (desk.ty + desk.h) * TILE;
    const drawDeskFn = () => drawDesk(now);
    const drawAgentFn = () => drawAgent(now);
    if (agent && agent.py < deskFoot) { drawAgentFn(); drawDeskFn(); }
    else { drawDeskFn(); drawAgentFn(); }

    drawLight();
    if (agent) drawBubble(now);

    if (running) raf = requestAnimationFrame(frame);
  }

  function drawFloor() {
    ctx.fillStyle = PAL.panel2;
    ctx.fillRect(0, 0, ROOMW, ROOMH);
    ctx.strokeStyle = PAL.faint; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= COLS; x++) { ctx.moveTo(x * TILE + .5, 0); ctx.lineTo(x * TILE + .5, ROOMH); }
    for (let y = 0; y <= ROWS; y++) { ctx.moveTo(0, y * TILE + .5); ctx.lineTo(ROOMW, y * TILE + .5); }
    ctx.stroke();
    const ao = ctx.createLinearGradient(0, 0, 0, ROOMH);
    ao.addColorStop(0, 'rgba(0,0,0,0.55)'); ao.addColorStop(0.12, 'rgba(0,0,0,0)');
    ao.addColorStop(0.88, 'rgba(0,0,0,0)'); ao.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = ao; ctx.fillRect(0, 0, ROOMW, ROOMH);
    const ao2 = ctx.createLinearGradient(0, 0, ROOMW, 0);
    ao2.addColorStop(0, 'rgba(0,0,0,0.55)'); ao2.addColorStop(0.1, 'rgba(0,0,0,0)');
    ao2.addColorStop(0.9, 'rgba(0,0,0,0)'); ao2.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = ao2; ctx.fillRect(0, 0, ROOMW, ROOMH);
  }

  function drawWalls() {
    ctx.lineWidth = 3; ctx.strokeStyle = PAL.ph;
    ctx.shadowColor = PAL.ph; ctx.shadowBlur = 10;
    ctx.strokeRect(2, 2, ROOMW - 4, ROOMH - 4);
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1; ctx.strokeStyle = PAL.phDim;
    ctx.strokeRect(6, 6, ROOMW - 12, ROOMH - 12);
  }

  function drawLight() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(ROOMW / 2, ROOMH * 0.46, 20, ROOMW / 2, ROOMH * 0.46, ROOMW * 0.6);
    g.addColorStop(0, 'rgba(255,170,51,0.10)'); g.addColorStop(1, 'rgba(255,170,51,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, ROOMW, ROOMH);
    ctx.restore();
  }

  function drawDesk(now) {
    const x = desk.tx * TILE, y = desk.ty * TILE, w = desk.w * TILE, h = desk.h * TILE;
    ctx.fillStyle = '#0a0c10'; ctx.fillRect(x, y + 6, w, h - 2);
    ctx.fillStyle = '#05070a'; ctx.fillRect(x, y + h + 2, w, 4);
    ctx.strokeStyle = U.shade(PAL.data, -0.55); ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + 6.5, w - 1, h - 3);
    const mx = x + 8, my = y - 6, mw = w - 16, mh = 14;
    ctx.fillStyle = '#040608'; ctx.fillRect(mx - 2, my - 2, mw + 4, mh + 4); // bezel
    const lit = agent && agent.working;
    const pulse = lit ? (0.6 + 0.4 * Math.abs(Math.sin(now / 220))) : 0.32;
    ctx.fillStyle = PAL.data; ctx.globalAlpha = pulse; ctx.fillRect(mx, my, mw, mh); ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let i = my; i < my + mh; i += 2) ctx.fillRect(mx, i, mw, 1);
    if (lit) {
      ctx.shadowColor = PAL.data; ctx.shadowBlur = 9;
      ctx.strokeStyle = PAL.data; ctx.lineWidth = 1; ctx.strokeRect(mx + .5, my + .5, mw - 1, mh - 1);
      ctx.shadowBlur = 0;
      ctx.fillStyle = PAL.data; ctx.font = '9px VT323, monospace'; ctx.textAlign = 'center';
      ctx.fillText('● WORKING', x + w / 2, y - 12);
      ctx.textAlign = 'left';
    }
  }

  function drawAgent(now) {
    let geo = null;
    if (SPRITES && SPRITES.ready) geo = SPRITES.drawBody(ctx, agent, now);
    if (!geo) drawFallback(now);
    // power-on spawn ring
    if (wakeAt && now - wakeAt < 1300) {
      const t = (now - wakeAt) / 1300;
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.strokeStyle = agent.color; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(agent.px, agent.py, 6 + t * 24, 3 + t * 11, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawFallback(now) {
    const a = agent, x = Math.round(a.px), y = Math.round(a.py), h = 15;
    const step = a.state === 'walk' ? (Math.floor(now / 140) % 2) : 0;
    const bob = (a.state !== 'walk' && !a.sitting) ? Math.round(Math.sin(now / 600 + a.phase) * 0.7) : 0;
    ctx.globalAlpha = 0.3; ctx.fillStyle = '#000'; ctx.fillRect(x - 5, y - 1, 10, 2); ctx.globalAlpha = 1;
    const top = y - h + bob;
    ctx.fillStyle = a.color; ctx.fillRect(x - 4, top + 3, 8, h - 6);
    ctx.fillStyle = '#f0e6c0'; ctx.fillRect(x - 3, top, 6, 5);
    ctx.fillStyle = U.shade(a.color, -0.45);
    if (a.sitting) ctx.fillRect(x - 4, y - 4, 8, 3);
    else { ctx.fillRect(x - 4 + (step ? 1 : 0), y - 3, 3, 3); ctx.fillRect(x + 1 - (step ? 1 : 0), y - 3, 3, 3); }
  }

  function drawBubble(now) {
    const s = agent.say;
    if (!s.text || s.until < now) return;
    ctx.font = '11px VT323, monospace';
    const maxW = 150, pad = 4, lh = 12;
    const words = s.text.split(' '); const lines = []; let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; if (lines.length >= 3) break; }
      else line = test;
    }
    if (line && lines.length < 3) lines.push(line);
    if (lines.length === 3) lines[2] = lines[2].replace(/.{0,2}$/, '…');
    const bw = Math.min(maxW, Math.max(...lines.map(l => ctx.measureText(l).width))) + pad * 2;
    const bh = lines.length * lh + pad * 2;
    let bx = Math.round(agent.px - bw / 2);
    const by = Math.round(agent.py - 30 - bh);
    bx = Math.max(4, Math.min(ROOMW - bw - 4, bx));
    ctx.fillStyle = 'rgba(3,2,1,0.92)'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = PAL.ph; ctx.lineWidth = 1; ctx.strokeRect(bx + .5, by + .5, bw - 1, bh - 1);
    ctx.fillStyle = PAL.ph; ctx.fillRect(Math.round(agent.px) - 2, by + bh, 4, 3);
    ctx.fillStyle = PAL.phBright; ctx.textAlign = 'left';
    lines.forEach((l, i) => ctx.fillText(l, bx + pad, by + pad + lh * (i + 1) - 3));
  }

  return { init, spawn, start, stop, setThinking, wakeIn, say };
})();
