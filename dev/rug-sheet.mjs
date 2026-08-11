/* dev/rug-sheet.mjs — RENDER SHEET for the rug candidates (taste dial: show renders, then decide).
 *
 * Drives the already-running dev server over CDP and draws each rug variant into a scratch canvas at
 * 6x nearest-neighbour, on the station's own deck colour, so the choice is made on pixels rather than
 * on a description. Writes .rugbed-shots/rug-sheet.png.
 *
 * node dev/rug-sheet.mjs           (env: RUG_SHEET_URL, SKYNET_CDP_PORT)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep, launchChrome, connectCDP, evalJS } from '../scripts/lib/cdp.mjs';

const URL = process.env.RUG_SHEET_URL || 'http://127.0.0.1:8791/';
const IDS = (process.env.RUG_IDS || 'rug').split(',');   // any F.* prop id — candidates need not be in the CATALOG
const cdpPort = Number(process.env.SKYNET_CDP_PORT || 9351);
const OUT = join(process.cwd(), '.rugbed-shots');
mkdirSync(OUT, { recursive: true });

const { proc } = launchChrome({ cdpPort, win: '1440,900', profileDir: join(OUT, '_sheet-profile') });
let cdp;
try {
  cdp = await connectCDP(cdpPort);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 120);',
  });
  await cdp.send('Page.navigate', { url: URL });
  await sleep(9000);

  const data = await evalJS(cdp, `(() => {
    const T = PropSprites.TILE, W = 4, H = 3, Z = 6;
    const ids = (${JSON.stringify(IDS)}), labels = ids;
    const cellW = (W * T + 6), cellH = (H * T + 8);
    const src = document.createElement('canvas'); src.width = cellW; src.height = cellH;
    const sctx = src.getContext('2d');
    const out = document.createElement('canvas');
    out.width = cellW * Z * ids.length + 20 * (ids.length + 1);
    out.height = cellH * Z + 54;
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = false;
    octx.fillStyle = '#0e1114'; octx.fillRect(0, 0, out.width, out.height);
    ids.forEach((id, i) => {
      sctx.clearRect(0, 0, cellW, cellH);
      sctx.fillStyle = '#2a2622'; sctx.fillRect(0, 0, cellW, cellH);          // the deck it has to read against
      sctx.fillStyle = '#242019';
      for (let gy = 0; gy < cellH; gy += T) for (let gx = 0; gx < cellW; gx += T) sctx.fillRect(gx, gy, T - 1, 1);
      PropSprites.setCtx(sctx); PropSprites.setNow(2400);
      PropSprites.draw({ t: id, x: 3 / T, y: 4 / T, w: W, h: H, id: 'sheet' }, false);
      const dx = 20 + i * (cellW * Z + 20);
      octx.drawImage(src, 0, 0, cellW, cellH, dx, 34, cellW * Z, cellH * Z);
      octx.fillStyle = '#e8c860'; octx.font = '20px "VT323","Courier New",monospace';
      octx.fillText(labels[i], dx, 24);
    });
    return out.toDataURL('image/png');
  })()`);
  if (!data || !String(data).startsWith('data:image/png')) throw new Error('no sheet: ' + String(data).slice(0, 200));
  writeFileSync(join(OUT, 'rug-sheet.png'), Buffer.from(String(data).split(',')[1], 'base64'));
  console.log('wrote', join(OUT, 'rug-sheet.png'));
} finally {
  try { if (cdp) cdp.close && cdp.close(); } catch {}
  try { proc.kill(); } catch {}
}
