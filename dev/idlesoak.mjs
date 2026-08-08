#!/usr/bin/env node
// dev/idlesoak.mjs — PROOF instrument for the IDLE LIFE pass (W1 subject-facing · W2 prop verbs ·
// W3 roam radius).
//
// None of these three can be judged from a screenshot: they are STATISTICS over minutes of an
// rAF-driven engine (where does the head point, how long is a body at a prop, does it ever leave
// its room). rAF does not run in the preview tab at all, so this boots the real app in headless
// Chrome, lets the world live, and samples World.bodies() on a fixed cadence.
//
// What it measures, per body:
//   FACING   — what is ONE TILE in front of the nose while idle and standing still:
//              wall | prop | belt | body | open. 'wall' is the defect this pass removed.
//   ROOM     — inOwnZone (containment must never break) and inHomeRoom (false = it walked next
//              door on its roam radius, which is the W3 promise).
//   BEATS    — the goals/quirks/prop-kinds actually reached, and gesture emotes actually played.
//
// Usage:  node dev/idlesoak.mjs [--port 8941] [--cdp 9341] [--minutes 4] [--crew 2]
// Exits nonzero if containment breaks or the wall-stare rate is above the bar.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sleep, launchChrome, connectCDP, evalJS } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, isUp, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';

const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : dflt; };
const PORT = arg('--port', '8941');
const CDP_PORT = Number(arg('--cdp', '9341'));
const MINUTES = Number(arg('--minutes', '4'));
const CREW = Number(arg('--crew', '2'));
const OUT = arg('--out', join(process.cwd(), '.idlesoak'));
const APP_URL = `http://127.0.0.1:${PORT}/`;
const SCRATCH = join(OUT, '_seed-workspace');
mkdirSync(OUT, { recursive: true });

// ── the sample: one read of the whole floor, no side effects ────────────────────────────────────
const SAMPLE = `(() => {
  if (typeof World === 'undefined' || typeof World.bodies !== 'function') return { err: 'no World.bodies' };
  return { t: Math.round(performance.now()), bodies: World.bodies() };
})()`;

// BUILD MARKER — a live check must prove it is talking to MY build, not another agent's server that
// happens to answer on this port (the 2026-08-07 lesson: waitUp() true != your server).
const MARKER = `(() => { try {
  const b = (typeof World !== 'undefined' && World.bodies) ? World.bodies()[0] : null;
  return { roam: (typeof Zones !== 'undefined' && Zones.ROAM_RADIUS) || null, facing: !!(b && ('facing' in b)) };
} catch (e) { return { err: String(e) }; } })()`;

/* BUILD A REAL FLOOR before soaking. The dev seed's station is a SINGLE bare room with no leisure
   props, which cannot exercise W2 (per-prop beats) or W3 (roam into the next room) at all — a soak
   on it would report a green nothing. This lays a second room sharing an edge with the first (the
   model auto-opens a threshold on any zone seam) and scatters real catalog props through both,
   through the SAME validated mutation API the REFIT editor uses. */
const BUILD = `(() => { try {
  const st = (typeof Build !== 'undefined' && Build.__test__ && Build.__test__.station && Build.__test__.station()) || null;
  if (!st) return { err: 'no station' };
  const rooms = st.rooms();
  if (!rooms.length) return { err: 'no rooms' };
  const r0 = rooms[0].rects[0];
  const out = { home: r0, added: null, props: [] };
  // a second room to the EAST, same height, 10 wide — sharing r0's east edge so a door opens
  const nx1 = r0.x2 + 1, nx2 = r0.x2 + 10;
  const can = st.canPlaceRoom ? st.canPlaceRoom([{ x1: nx1, y1: r0.y1, x2: nx2, y2: r0.y2 }], 'hab') : { ok: true };
  if (can && can.ok !== false) {
    const res = st.addRoom({ kind: 'hab', rect: { x1: nx1, y1: r0.y1, x2: nx2, y2: r0.y2 } });
    out.added = res && res.ok ? { x1: nx1, y1: r0.y1, x2: nx2, y2: r0.y2 } : (res && res.reason) || 'addRoom failed';
  } else out.added = 'canPlaceRoom: ' + JSON.stringify(can);
  // leisure kit, spread over BOTH rooms (each entry: type, w, h)
  const KIT = [['bookshelf',2,1],['arcade',1,2],['fishtank',2,1],['coffee',1,1],['jukebox',1,2],['pinball',1,2],['terrarium',1,1],['quarters_vending',1,2]];
  const spots = [];
  for (const rr of [r0, out.added && out.added.x1 != null ? out.added : null]) {
    if (!rr) continue;
    for (let i = 0; i < 8; i++) spots.push({ x: rr.x1 + 2 + ((i * 3) % Math.max(1, rr.x2 - rr.x1 - 3)), y: rr.y1 + 1 + (i % Math.max(1, rr.y2 - rr.y1 - 1)) });
  }
  let si = 0;
  for (const [t, w, h] of KIT) {
    for (let tries = 0; tries < spots.length; tries++) {
      const s = spots[(si++) % spots.length];
      const ok = st.canPlaceProp ? st.canPlaceProp(t, s.x, s.y, w, h) : { ok: true };
      if (!ok || ok.ok === false) continue;
      const res = st.addProp({ t, x: s.x, y: s.y, w, h, block: true });
      if (res && res.ok) { out.props.push(t + '@' + s.x + ',' + s.y); break; }
    }
  }
  return out;
} catch (e) { return { err: String(e && e.stack || e) }; } })()`;

const pct = (n, d) => (d ? +(100 * n / d).toFixed(1) : 0);

let proc = null, side = null, cdp = null;
const fail = [];
try {
  if (await isUp(APP_URL)) { console.error(`[idlesoak] ${APP_URL} already answers — someone else owns that port; pick another (--port)`); process.exit(2); }
  rmSync(SCRATCH, { recursive: true, force: true });
  materializeSeedWorkspace(SCRATCH);
  side = bootSeededSidecar({ port: PORT, scratchDir: SCRATCH });
  if (!(await waitUp(APP_URL))) throw new Error('seeded sidecar never came up on :' + PORT);

  ({ proc } = launchChrome({ cdpPort: CDP_PORT, win: '1440,900', profileDir: join(OUT, '_profile') }));
  cdp = await connectCDP(CDP_PORT);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  // Throttle rAF BEFORE boot: a software-rendered station canvas at full tilt starves every
  // Runtime.evaluate (the documented headless gotcha). ~20fps still advances the idle engine
  // correctly — every timer in it is wall-clock (performance.now), not frame-counted.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 50); window.cancelAnimationFrame = (id) => clearTimeout(id);',
  });
  await cdp.send('Page.navigate', { url: APP_URL });
  if (!(await waitDevReady(cdp, evalJS, { tries: 30, url: APP_URL }))) throw new Error('never reached the in-game floor');
  await sleep(5000);

  const marker = await evalJS(cdp, MARKER);
  if (!marker || !marker.roam || !marker.facing) {
    console.error('[idlesoak] BUILD MARKER MISSING — this page is not the idle-life build:', JSON.stringify(marker));
    process.exit(3);
  }
  console.log(`[idlesoak] build marker ok (Zones.ROAM_RADIUS=${marker.roam}, bodies().facing present)`);

  // lay a real floor (a second room + leisure kit) unless told not to
  if (process.argv.indexOf('--no-build') < 0) {
    const built = await evalJS(cdp, BUILD);
    console.log('[idlesoak] floor:', JSON.stringify(built));
    if (!built || built.err) throw new Error('floor build failed: ' + JSON.stringify(built));
    await sleep(2500);
  }

  // put crew on the floor so the roam radius + neighbour-facing have something to be true about
  for (let i = 0; i < CREW; i++) {
    await evalJS(cdp, `(() => { World.spawnAgent({ id: 'probe${i}', name: 'PROBE${i}', color: '#77ffdd' }); return true; })()`);
    await sleep(500);
  }

  const t0 = Date.now(), END = t0 + MINUTES * 60000, samples = [];
  while (Date.now() < END) {
    const s = await evalJS(cdp, SAMPLE).catch(() => null);
    if (s && s.bodies) samples.push(s);
    if (samples.length % 40 === 0) console.log(`[idlesoak] ${samples.length} samples · ${Math.round((END - Date.now()) / 1000)}s left`);
    await sleep(900);
  }

  // ── reduce ──────────────────────────────────────────────────────────────────────────────────
  const per = new Map();
  for (const s of samples) {
    for (const b of s.bodies) {
      if (!b || b.unplaced) continue;
      let r = per.get(b.id);
      if (!r) { r = { id: b.id, name: b.name, n: 0, still: 0, wallDirSum: 0, facing: {}, goals: {}, quirks: {}, useKinds: {}, emotes: 0, outZone: 0, nextDoor: 0, tiles: new Set() }; per.set(b.id, r); }
      r.n++;
      r.tiles.add(b.tile.x + ',' + b.tile.y);
      if (!b.inOwnZone) r.outZone++;
      if (b.inOwnZone && b.inHomeRoom === false) r.nextDoor++;
      if (b.emote) r.emotes++;
      if (b.goal) r.goals[b.goal] = (r.goals[b.goal] || 0) + 1;
      if (b.quirkKind) r.quirks[b.quirkKind] = (r.quirks[b.quirkKind] || 0) + 1;
      if (b.useKind) r.useKinds[b.useKind] = (r.useKinds[b.useKind] || 0) + 1;
      // FACING is only meaningful for a body STANDING STILL and not working: a walker's facing is
      // its heading, and a seated worker faces its own desk by design (out of scope for this pass).
      if (!b.moving && b.state !== 'walk' && !b.working && !b.sitting && b.facing) {
        r.still++; r.facing[b.facing] = (r.facing[b.facing] || 0) + 1;
        if (b.wallDirs != null) r.wallDirSum += b.wallDirs;   // the blind-pick control (see wallDirsAt)
      }
    }
  }

  const report = { minutes: MINUTES, samples: samples.length, bodies: [] };
  for (const r of per.values()) {
    report.bodies.push({
      id: r.id, name: r.name, samples: r.n, stillSamples: r.still,
      wallPct: pct(r.facing.wall || 0, r.still),
      blindPickWallPct: r.still ? +(100 * (r.wallDirSum / r.still) / 4).toFixed(1) : 0,   // what a blind cardinal pick WOULD have scored on these same tiles
      facing: r.facing,
      distinctTiles: r.tiles.size, outOfZone: r.outZone, nextDoorSamples: r.nextDoor,
      goals: r.goals, quirks: r.quirks, useKinds: r.useKinds, emoteSamples: r.emotes,
    });
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n=== IDLE SOAK ===');
  console.log(JSON.stringify(report, null, 2));

  for (const b of report.bodies) {
    if (b.outOfZone > 0) fail.push(`${b.name}: ${b.outOfZone} samples OUT of its zone (containment)`);
    if (b.stillSamples >= 20 && b.wallPct > 12) fail.push(`${b.name}: ${b.wallPct}% of still samples nose-to-wall (bar: <=12%)`);
  }
  console.log(fail.length ? `\nFAIL:\n - ${fail.join('\n - ')}` : '\nPASS: no containment breaks, wall-stare under the bar');
} catch (e) {
  console.error('[idlesoak]', e);
  fail.push(String(e && e.message || e));
} finally {
  try { if (proc) proc.kill(); } catch { }
  try { if (side) side.kill(); } catch { }
}
process.exit(fail.length ? 1 : 0);
