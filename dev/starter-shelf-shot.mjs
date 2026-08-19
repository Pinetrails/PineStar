#!/usr/bin/env node
/* dev/starter-shelf-shot.mjs — one proof shot for the STARTER-shelf lane: REFIT open on the
 * ⚙ SYSTEMS tier with the pinned starter row above the drawers. Same headless CDP pattern as
 * brightness-shots.mjs / catshot.mjs.
 *
 *   node dev/starter-shelf-shot.mjs
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, connectCDP, evalJS, capture, sleep, collectDiagnostics } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';

const PORT = process.env.SKYNET_SHOT_PORT || '9531';
const CDP_PORT = Number(process.env.SKYNET_CDP_PORT || 9533);
const URL = `http://127.0.0.1:${PORT}/`;
const OUT = process.env.SKYNET_SHOT_OUT || join(process.cwd(), 'dev', '.shots-starter-shelf');

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'startershelf-'));
  materializeSeedWorkspace(join(scratch, 'ws'));
  const side = bootSeededSidecar({ port: PORT, scratchDir: join(scratch, 'ws') });
  let chrome = null, cdp = null;
  try {
    if (!(await waitUp(URL))) throw new Error('sidecar never came up on ' + URL);
    chrome = launchChrome({ cdpPort: CDP_PORT, profileDir: join(scratch, 'chrome') });
    await sleep(1200);
    cdp = await connectCDP(CDP_PORT);
    await cdp.send('Runtime.enable');
    const diag = collectDiagnostics(cdp);
    await evalJS(cdp, `location.href = ${JSON.stringify(URL)}`);
    if (!(await waitDevReady(cdp, evalJS, { url: URL }))) throw new Error('app never reached the game screen');
    await sleep(1500);
    mkdirSync(OUT, { recursive: true });

    const armed = await evalJS(cdp, `(() => {
      Build.open();
      // dismiss the first-run BUILD YOUR STATION guide so the palette is the picture
      const go = [...document.querySelectorAll('button')].find(b => /START BUILDING/i.test(b.textContent || ''));
      if (go) go.click();
      const t = document.querySelector('.refit-tool[data-tool="prop"]'); if (t) t.click();
      const f = document.querySelector('.refit-tier-functional'); if (f) f.click();
      return JSON.stringify({
        shelf: !!document.querySelector('.refit-starternote'),
        tiles: [...document.querySelectorAll('.refit-startergrid .refit-proptile')].map(b => b.dataset.prop)
      });
    })()`);
    console.log('palette ->', armed);
    await sleep(900);   // let the thumb canvases paint a few animated frames
    console.log('shot', await capture(cdp, OUT, 'starter-shelf'));

    if (diag.exceptions.length) console.log('PAGE EXCEPTIONS:', diag.exceptions);
    const errs = diag.consoleMsgs.filter(m => m.type === 'error');
    if (errs.length) console.log('CONSOLE ERRORS:', errs.slice(0, 10));
    console.log('done ->', OUT);
  } finally {
    try { chrome && chrome.proc.kill(); } catch {}
    try { side && side.kill(); } catch {}
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
