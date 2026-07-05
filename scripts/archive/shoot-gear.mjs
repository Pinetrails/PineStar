// scripts/shoot-gear.mjs — targeted headless verification for the Class Loadouts shared-gear rework.
// Boots a SEEDED sidecar, opens the RECRUITMENT BAY, focuses classes, and verifies the dossier renders the
// "DRAWS ON STATION GEAR" block with live present/missing states + 0 console errors. Screenshots the dossier.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sleep, launchChrome, connectCDP, evalJS, capture, collectDiagnostics } from './lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, isUp, waitUp, waitDevReady, DEFAULT_MODEL } from './lib/seed.mjs';

const port = process.env.SKYNET_SHOT_PORT || '8931';
const cdpPort = Number(process.env.SKYNET_CDP_PORT || 9331);
const outDir = process.env.SKYNET_SHOT_DIR || join(process.cwd(), '.uishots-gear');
const APP_URL = `http://127.0.0.1:${port}/`;
const SCRATCH = join(outDir, '_seed-workspace');
const PROFILE = join(outDir, '_profile');
mkdirSync(outDir, { recursive: true });

let ownSidecar = null;
if (await isUp(APP_URL)) { console.log(`sidecar: reusing :${port}`); }
else {
  console.log(`sidecar: booting SEEDED on :${port} (model=${DEFAULT_MODEL})`);
  materializeSeedWorkspace(SCRATCH);
  ownSidecar = bootSeededSidecar({ port, scratchDir: SCRATCH });
  if (!(await waitUp(APP_URL))) throw new Error('seeded sidecar failed on :' + port);
}

const { proc, chrome } = launchChrome({ cdpPort, win: '1440,900', profileDir: PROFILE });
proc.on('error', (e) => { console.error('chrome spawn error', e); process.exit(1); });
let cdp, exitCode = 0;
const out = { states: [] };
try {
  cdp = await connectCDP(cdpPort);
  const diag = collectDiagnostics(cdp);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: APP_URL });
  const ready = await waitDevReady(cdp, evalJS, { tries: 24, url: APP_URL });
  if (!ready) { console.error('FAIL: never reached the floor'); await capture(cdp, outDir, '_FAILED-boot'); exitCode = 2; }
  else {
    // What gear does the seeded station actually have? (informs present/missing expectations.)
    const stationCaps = await evalJS(cdp, `JSON.stringify((window.World && World.stationCaps) ? World.stationCaps().map(c=>c.objectType||c) : 'no-World')`);
    console.log('station caps:', stationCaps);

    // Open the RECRUITMENT BAY (ROSTER → deploy bay). Give it time to render the grid + dossier.
    const openRes = await evalJS(cdp, `(()=>{ const el=document.querySelector('#bb-roster'); if(!el) return 'NOTFOUND'; el.click(); return 'clicked'; })()`);
    console.log('open bay:', openRes);
    await sleep(1800);

    // Walk a few classes and read their DRAWS ON STATION GEAR block. Click each class coin, then scrape.
    const probe = `(()=>{
      const dos = document.querySelector('#mkt-dossier'); if(!dos) return { err:'no-dossier' };
      const bh = [...dos.querySelectorAll('.bh')].map(b=>b.textContent.trim());
      const rows = [...dos.querySelectorAll('.mkt-kit-row')].map(r=>({
        obj: (r.querySelector('.mkt-kit-obj')||{}).textContent||'',
        grant: (r.querySelector('.mkt-kit-grant')||{}).textContent||'',
        state: (r.querySelector('.mkt-kit-state')||{}).textContent||'',
        missing: r.classList.contains('mkt-kit-missing')
      }));
      const note = (dos.querySelector('.mkt-kit-note')||{}).textContent||'';
      const title = (dos.querySelector('.mkt-name, .mkt-dos-name, h2, h3')||{}).textContent||'';
      return { headers: bh, rows, note, title };
    })()`;

    // researcher (kit: dish/notebook/cabinet) — focus by clicking its coin if present
    const focusClass = (id) => `(()=>{ const c=document.querySelector('[data-spec="${id}"],[data-id="${id}"],.mkt-coin[data-spec="${id}"]'); if(c){c.click(); return 'clicked:${id}';} return 'no-coin:${id}'; })()`;
    for (const id of ['researcher','engineer','designer']) {
      const f = await evalJS(cdp, focusClass(id));
      await sleep(700);
      const data = JSON.parse(await evalJS(cdp, `JSON.stringify(${probe})`));
      console.log(`\n[${id}] focus=${f}`);
      console.log('  headers:', JSON.stringify(data.headers));
      console.log('  rows:', JSON.stringify(data.rows));
      console.log('  note:', data.note);
      out.states.push({ id, focus: f, data });
    }
    await capture(cdp, outDir, 'recruitment-dossier');
  }
  out.console = diag.consoleMsgs.slice(0, 40);
  out.exceptions = diag.exceptions.slice(0, 20);
  const errs = (diag.consoleMsgs||[]).filter(m => /error/i.test(m.level||m.type||'') || /error/i.test(String(m.text||m)));
  console.log(`\nconsole errors: ${errs.length}  uncaught exceptions: ${diag.exceptions.length}`);
  errs.slice(0,8).forEach(e=>console.log('  ERR', JSON.stringify(e).slice(0,200)));
  diag.exceptions.slice(0,8).forEach(e=>console.log('  EXC', e));
  if (errs.length || diag.exceptions.length) exitCode = exitCode || 4;
} finally {
  writeFileSync(join(outDir, 'gear-manifest.json'), JSON.stringify(out, null, 2));
  try { cdp?.ws.close(); } catch {}
  try { proc.kill('SIGKILL'); } catch {}
  if (ownSidecar) { try { ownSidecar.kill('SIGKILL'); } catch {} }
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
}
console.log(`\n${exitCode===0?'DONE (ok)':'DONE (exit '+exitCode+')'} → ${outDir}`);
process.exit(exitCode);
