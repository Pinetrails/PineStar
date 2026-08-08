#!/usr/bin/env node
/* dev/crewseam-shots.mjs — proof harness for the draggable CREW rail seam (leftrail.js).
 *
 * The left column was pinned at 232px forever while COMMS had a draggable seam. This drives
 * the new seam end to end at a real window size and records, in VISUAL px (the unit --crew-w
 * is authored in — see the --cz note in app.css):
 *   default rail width · width after a drag · the clamp at both ends · persistence across a
 *   reload · the double-click reset · and that the stage gave up exactly what the rail took.
 * Runs at textScale 100 AND AUTO so the "a dragged width means the same thing at every TEXT
 * SIZE" claim is measured, not assumed.
 *
 *   node dev/crewseam-shots.mjs <label>   → dev/.shots-crewseam/<label>-*.png
 *   ports: SKYNET_SHOT_PORT (default 9757) / SKYNET_CDP_PORT (default 9758)
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, connectCDP, evalJS, capture, sleep, collectDiagnostics } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';

const LABEL = process.argv[2] || 'shot';
const PORT = process.env.SKYNET_SHOT_PORT || '9757';
const CDP_PORT = Number(process.env.SKYNET_CDP_PORT || 9758);
const URL = `http://127.0.0.1:${PORT}/`;
const OUT = process.env.SKYNET_SHOT_OUT || join(process.cwd(), 'dev', '.shots-crewseam');

const setScale = (v) => `(() => {
  const KEY = 'starnet.station.v1';
  const r = JSON.parse(localStorage.getItem(KEY) || '{"v":1}');
  r.settings = Object.assign({}, r.settings, { textScale: ${v} });
  localStorage.setItem(KEY, JSON.stringify(r));
  location.reload();
  return 'reloading';
})()`;

// rects are VISUAL px (they carry the body zoom) — that is exactly the unit --crew-w is written
// in, so this is the right measure here; offsetWidth would report the counter-zoomed CSS px.
const MEASURE = `(() => {
  const left = document.getElementById('left');
  const stage = document.getElementById('stage-wrap');
  const seam = document.getElementById('crew-resizer');
  const game = document.getElementById('screen-game');
  const lr = left.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const seamR = seam ? seam.getBoundingClientRect() : null;
  let stored = null; try { stored = localStorage.getItem('starnet.crewrail.w'); } catch (_) {}
  return {
    innerWidth: window.innerWidth,
    zoom: document.body.style.zoom || '1',
    seamPresent: !!seam,
    seamCursor: seam ? getComputedStyle(seam).cursor : null,
    seamDisplay: seam ? getComputedStyle(seam).display : null,
    seamLeft: seamR ? Math.round(seamR.left) : null,
    railW: Math.round(lr.width), railRight: Math.round(lr.right),
    stageLeft: Math.round(sr.left), stageW: Math.round(sr.width),
    crewVar: game.style.getPropertyValue('--crew-w') || '(unset)',
    stored,
  };
})()`;

// a real pointer drag on the seam: down → move → up, all dispatched on the handle itself
const drag = (toX) => `(() => {
  const seam = document.getElementById('crew-resizer');
  const r = seam.getBoundingClientRect();
  const opts = { pointerId: 1, bubbles: true, cancelable: true, isPrimary: true };
  seam.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ clientX: Math.round(r.left + 5), clientY: 400 }, opts)));
  seam.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientX: ${toX}, clientY: 400 }, opts)));
  seam.dispatchEvent(new PointerEvent('pointerup', Object.assign({ clientX: ${toX}, clientY: 400 }, opts)));
  return document.getElementById('screen-game').style.getPropertyValue('--crew-w');
})()`;

const DBLCLICK = `(() => {
  document.getElementById('crew-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  let stored = null; try { stored = localStorage.getItem('starnet.crewrail.w'); } catch (_) {}
  return { crewVar: document.getElementById('screen-game').style.getPropertyValue('--crew-w') || '(unset)', stored };
})()`;

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'crewseam-'));
  materializeSeedWorkspace(join(scratch, 'ws'));
  const side = bootSeededSidecar({ port: PORT, scratchDir: join(scratch, 'ws') });
  let chrome = null, cdp = null;
  const results = {};
  try {
    if (!(await waitUp(URL))) throw new Error('sidecar never came up on ' + URL);
    chrome = launchChrome({ cdpPort: CDP_PORT, win: '1440,900', profileDir: join(scratch, 'chrome') });
    await sleep(1200);
    cdp = await connectCDP(CDP_PORT);
    await cdp.send('Runtime.enable');
    const diag = collectDiagnostics(cdp);
    await evalJS(cdp, `location.href = ${JSON.stringify(URL)}`);
    if (!(await waitDevReady(cdp, evalJS, { url: URL }))) throw new Error('app never reached the game screen');
    await sleep(1200);
    mkdirSync(OUT, { recursive: true });

    for (const [tag, scale] of [['t100', 100], ['auto', 0]]) {
      await evalJS(cdp, setScale(scale));
      if (!(await waitDevReady(cdp, evalJS, { url: URL }))) throw new Error('app never came back after textScale=' + scale);
      await sleep(1200);
      const R = {};
      R.before = await evalJS(cdp, MEASURE);
      await capture(cdp, OUT, `${LABEL}-${tag}-1-default`);

      // 1 · a normal widening drag: cursor to x=340 → rail = 340 - 11px grid padding = 329
      R.dragTo340 = await evalJS(cdp, drag(340));
      await sleep(500);
      R.afterDrag = await evalJS(cdp, MEASURE);
      await capture(cdp, OUT, `${LABEL}-${tag}-2-wide`);

      // 2 · past the far cap
      await evalJS(cdp, drag(900));
      await sleep(300);
      R.afterMaxDrag = await evalJS(cdp, MEASURE);
      await capture(cdp, OUT, `${LABEL}-${tag}-3-maxed`);

      // 3 · past the near cap
      await evalJS(cdp, drag(40));
      await sleep(300);
      R.afterMinDrag = await evalJS(cdp, MEASURE);

      // 4 · persistence across a reload
      await evalJS(cdp, drag(340));
      await sleep(200);
      await evalJS(cdp, `location.reload()`);
      if (!(await waitDevReady(cdp, evalJS, { url: URL }))) throw new Error('app never came back after reload');
      await sleep(1200);
      R.afterReload = await evalJS(cdp, MEASURE);

      // 5 · double-click resets to the designed width
      R.dblclick = await evalJS(cdp, DBLCLICK);
      await sleep(300);
      R.afterReset = await evalJS(cdp, MEASURE);
      await capture(cdp, OUT, `${LABEL}-${tag}-4-reset`);

      results[tag] = R;
      console.log(tag + ' ' + JSON.stringify(R, null, 1));
    }

    console.log(JSON.stringify({ out: OUT, label: LABEL, consoleErrors: diag.consoleMsgs.filter(m => m.level === 'error').slice(0, 10), exceptions: diag.exceptions.slice(0, 10) }, null, 2));
  } finally {
    try { if (cdp) cdp.close(); } catch {}
    try { if (chrome) chrome.proc ? chrome.proc.kill() : chrome.kill(); } catch {}
    try { side.kill(); } catch {}
  }
}

main().then(() => process.exit(0), e => { console.error(String(e && e.stack || e)); process.exit(1); });
