#!/usr/bin/env node
// dev/wallprobe.mjs — measure the CROWN RING in a real browser bake.
//
// The world canvas is drawn at a fractional uiZoom, so measuring a screenshot measures a
// RESAMPLE, not the art (the "never judge pixel art at a non-integer scale" law). This bakes a
// station offscreen at 1:1 through the shipped StationBake and reads pixels back, so every number
// below is the actual baked+lit tone the player sees.
//
// Composites over MAGENTA on purpose: anything painted outside the hull is invisible against a
// dark void fill and only shows against the real starfield, so the leak check counts non-magenta
// pixels beyond the silhouette instead of eyeballing them.
//
//   node dev/wallprobe.mjs            # boots its own sidecar + chrome
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, connectCDP, evalJS, sleep } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';

const PORT = process.env.SKYNET_SHOT_PORT || '8952';
const CDP_PORT = Number(process.env.SKYNET_CDP_PORT || 9352);
const URL = `http://127.0.0.1:${PORT}/`;

const PROBE = `(() => {
  const st = WorldModel.create(WorldModel.defaultDoc());
  const geo = st.projectGeometry();
  const bk = StationBake.bake(geo);
  const W = bk.W, H = bk.H, T = geo.TILE;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
  g.fillStyle = '#ff00ff'; g.fillRect(0, 0, W, H);
  g.drawImage(bk.baseCv, 0, 0); g.drawImage(bk.lightCv, 0, 0);
  const px = g.getImageData(0, 0, W, H).data;
  const lum = (x, y) => { const i = ((y * W + x) << 2); return Math.round(0.299*px[i] + 0.587*px[i+1] + 0.114*px[i+2]); };
  const isMagenta = (x, y) => { const i = ((y * W + x) << 2); return px[i] > 200 && px[i+1] < 60 && px[i+2] > 200; };

  // the one room in a fresh station, in bake-pixel coords (origin-relative)
  const r = geo.allRects[0];
  const x1 = r.x1 * T, y1 = r.y1 * T, x2 = (r.x2 + 1) * T, y2 = (r.y2 + 1) * T;
  const midY = ((y1 + y2) / 2) | 0, midX = ((x1 + x2) / 2) | 0;

  const scanH = (y, a, b) => { const o = []; for (let x = a; x <= b; x++) o.push(lum(x, y)); return o; };
  const scanV = (x, a, b) => { const o = []; for (let y = a; y <= b; y++) o.push(lum(x, y)); return o; };

  // LEAK CHECK — the decisive per-layer test: ambient mask lying over pixels the art never painted.
  const bg = bk.baseCv.getContext('2d').getImageData(0, 0, W, H).data;
  const lg = bk.lightCv.getContext('2d').getImageData(0, 0, W, H).data;
  let leak = 0;
  for (let i = 3; i < bg.length; i += 4) if (bg[i] === 0 && lg[i] > 0) leak++;

  // CROWN CONTINUITY — for each side, the brightest PAINTED pixel in the wall band, sampled along
  // the run. A ring is continuous when no sample position comes back dark. Magenta is void, not a
  // reading: without excluding it the void scores 105 and every gap in the ring looks like a peak.
  // The north band has to reach past WALL.up — its crown is extruded up-screen, the others are not.
  const bestAlong = (fixedFrom, fixedTo, band, sample) => {
    const o = [];
    for (let t = fixedFrom; t <= fixedTo; t += 4) {
      let m = 0;
      for (let d = 1; d <= band; d++) { const v = sample(t, d); if (v != null) m = Math.max(m, v); }
      o.push(m);
    }
    return o;
  };
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H || isMagenta(x, y)) ? null : lum(x, y);
  const nBand = 22, sBand = 9;
  const north = bestAlong(x1 + 16, x2 - 17, nBand, (x, d) => at(x, y1 - d));
  const south = bestAlong(x1 + 16, x2 - 17, sBand, (x, d) => at(x, y2 + d - 1));
  const west  = bestAlong(y1 + 16, y2 - 17, sBand, (y, d) => at(x1 - d, y));
  const east  = bestAlong(y1 + 16, y2 - 17, sBand, (y, d) => at(x2 + d - 1, y));
  const stat = a => ({ min: Math.min(...a), max: Math.max(...a), avg: Math.round(a.reduce((s,v)=>s+v,0)/a.length) });

  // CORNER RING — walk each chamfer's arc and report the brightest PAINTED pixel just outside the
  // deck curve at each step. This is the measurement that says whether the crown turns the corner.
  const arcOf = (kindWanted) => {
    const cor = geo.chamfers.find(c => c[2] === kindWanted);
    if (!cor) return null;
    const sx = kindWanted[1] === 'l' ? 1 : 0, sy = kindWanted[0] === 't' ? 1 : 0;
    const ax = (cor[0] + sx) * T, ay = (cor[1] + sy) * T;
    const a0 = { tl: Math.PI, tr: 1.5 * Math.PI, bl: 0.5 * Math.PI, br: 0 }[kindWanted];
    const o = [];
    for (let s = 0; s <= 18; s++) {
      const th = a0 + (s / 18) * (Math.PI / 2);
      let m = 0;
      for (let d = 0; d <= 20; d++) {
        const v = at(Math.round(ax + Math.cos(th) * (T + d)), Math.round(ay + Math.sin(th) * (T + d)));
        if (v != null) m = Math.max(m, v);
      }
      o.push(m);
    }
    return o;
  };

  // 1:1 CROPS written to disk by the caller — the only honest way to LOOK at a bake (the game
  // canvas draws at a fractional uiZoom, and a non-integer scale invents artifacts that are not
  // in the art). Nearest-neighbour upscale only.
  /* A BARE composite — baseCv with NO light map. The corners live at the darkest end of the room,
     where the ambient mask crushes the ring into the hull skirt beside it and geometry becomes
     impossible to judge by eye. Every SHAPE question is answered here; every TONE question needs
     the lit composite above. Judging the bottom corners on the lit view cost a whole round. */
  const bare = document.createElement('canvas'); bare.width = W; bare.height = H;
  const gb = bare.getContext('2d'); gb.imageSmoothingEnabled = false;
  gb.fillStyle = '#ff00ff'; gb.fillRect(0, 0, W, H); gb.drawImage(bk.baseCv, 0, 0);
  const cropBare = (cx, cy, cw, ch, z) => {
    const c2 = document.createElement('canvas'); c2.width = cw * z; c2.height = ch * z;
    const g2 = c2.getContext('2d'); g2.imageSmoothingEnabled = false;
    g2.drawImage(bare, cx, cy, cw, ch, 0, 0, cw * z, ch * z);
    return c2.toDataURL('image/png').split(',')[1];
  };

  const crop = (cx, cy, cw, ch, z) => {
    const c2 = document.createElement('canvas'); c2.width = cw * z; c2.height = ch * z;
    const g2 = c2.getContext('2d'); g2.imageSmoothingEnabled = false;
    g2.fillStyle = '#05060c'; g2.fillRect(0, 0, cw * z, ch * z);
    g2.drawImage(cv, cx, cy, cw, ch, 0, 0, cw * z, ch * z);
    return c2.toDataURL('image/png').split(',')[1];
  };

  /* THE ACCEPTANCE TEST for the crown cut: the DIMMEST crown pixel anywhere on the ring must beat
     the BRIGHTEST hull-skirt pixel. The skirt hangs outside the ambient plate at flat raw tones, so
     it is the thing the wall has to out-shine, and the corners are where the two meet. */
  let skirtMax = 0;
  for (let y = y2 + 6; y < Math.min(H, y2 + 44); y++)
    for (let x = x1 + 60; x < x2 - 60; x++) { const v = at(x, y); if (v != null && v > skirtMax) skirtMax = v; }

  return JSON.stringify({
    W, H, T, room: [x1, y1, x2, y2], leak, skirtMax,
    westScan: scanH(midY, x1 - 20, x1 + 12),
    eastScan: scanH(midY, x2 - 12, x2 + 20),
    northScan: scanV(midX, y1 - 24, y1 + 14),
    southScan: scanV(midX, y2 - 14, y2 + 20),
    ring: { north: stat(north), south: stat(south), west: stat(west), east: stat(east) },
    arcTL: arcOf('tl'), arcTR: arcOf('tr'), arcBL: arcOf('bl'), arcBR: arcOf('br'),
    crops: {
      tl: crop(x1 - 16, y1 - 26, 46, 46, 11),
      bl: crop(x1 - 16, y2 - 20, 46, 46, 11),
      br: crop(x2 - 30, y2 - 20, 46, 46, 11),
      blBare: cropBare(x1 - 12, y2 - 22, 38, 38, 14),
      tlBare: cropBare(x1 - 12, y1 - 26, 38, 38, 14),
      whole: crop(0, 0, W, H, 3)
    }
  });
})()`;

const scratch = mkdtempSync(join(tmpdir(), 'wallprobe-'));
materializeSeedWorkspace(scratch);
const side = bootSeededSidecar({ port: PORT, scratchDir: scratch });
await waitUp(URL);
const { proc } = launchChrome({ cdpPort: CDP_PORT, profileDir: join(scratch, 'chrome') });
await sleep(1200);
const cdp = await connectCDP(CDP_PORT);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.navigate', { url: URL });
await waitDevReady(cdp, evalJS, { url: URL });
const out = await evalJS(cdp, PROBE);
const data = JSON.parse(typeof out === 'string' ? out : JSON.stringify(out));
const dir = process.env.SKYNET_PROBE_DIR || join(process.cwd(), '.wallprobe');
mkdirSync(dir, { recursive: true });
for (const [name, b64] of Object.entries(data.crops || {})) writeFileSync(join(dir, name + '.png'), Buffer.from(b64, 'base64'));
delete data.crops;
console.log(JSON.stringify(data));
console.error('crops → ' + dir);
try { proc.kill(); } catch {}
try { side.kill(); } catch {}
process.exit(0);
