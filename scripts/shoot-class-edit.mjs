// scripts/shoot-class-edit.mjs — headless verification for the custom-class EDIT loadout pickers.
// Boots a SEEDED sidecar, mints a custom class carrying a loadout (kit/skills/effort), opens the RECRUITMENT BAY,
// clicks that class's ✎ EDIT, and verifies the BUILDER form opens in edit mode with all three pickers PREFILLED
// (kit chips selected, effort segment selected, skill chips selected once the live catalog resolves) + 0 console
// errors. Screenshots the edit form. Mirrors scripts/shoot-gear.mjs's CDP pattern.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sleep, launchChrome, connectCDP, evalJS, capture, collectDiagnostics } from './lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, isUp, waitUp, waitDevReady, DEFAULT_MODEL } from './lib/seed.mjs';

const port = process.env.SKYNET_SHOT_PORT || '8934';
const cdpPort = Number(process.env.SKYNET_CDP_PORT || 9334);
const outDir = process.env.SKYNET_SHOT_DIR || join(process.cwd(), '.uishots-class-edit');
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
const out = {};
try {
  cdp = await connectCDP(cdpPort);
  const diag = collectDiagnostics(cdp);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: APP_URL });
  const ready = await waitDevReady(cdp, evalJS, { tries: 24, url: APP_URL });
  if (!ready) { console.error('FAIL: never reached the floor'); await capture(cdp, outDir, '_FAILED-boot'); exitCode = 2; }
  else {
    // Mint a custom class carrying a full loadout — this is exactly what the builder's CREATE handler produces.
    const KIT = ['cabinet', 'notebook'], EFFORT = 'high';
    const mint = await evalJS(cdp, `(()=>{ try {
      const s = Specialties.saveCustom({ name:'Edit Probe', emoji:'✎', tagline:'edit round-trip probe',
        purpose:'seed purpose', manual:'- seed order', accent:'#7bc88a', model:'reasoning',
        kit:${JSON.stringify(KIT)}, skills:['web-research'], reasoningEffort:'${EFFORT}' });
      return JSON.stringify({ id:s.id, kit:s.kit, skills:s.skills, effort:s.reasoningEffort });
    } catch(e){ return 'ERR:'+e.message; } })()`);
    console.log('minted custom class:', mint);
    const spec = JSON.parse(mint);

    // Open the RECRUITMENT BAY (the one #bb-recruit door), let the grid render, focus the new custom class.
    await evalJS(cdp, `(()=>{ const el=document.querySelector('#bb-recruit'); if(el) el.click(); return 'clicked'; })()`);
    await sleep(1800);
    // click the custom class coin to open its dossier (which carries the ✎ EDIT button)
    const focus = await evalJS(cdp, `(()=>{ const c=document.querySelector('[data-spec="${spec.id}"],[data-id="${spec.id}"]'); if(c){c.click(); return 'focused';} return 'no-coin'; })()`);
    console.log('focus custom:', focus);
    await sleep(700);
    // click ✎ EDIT — must route into the BUILDER form (not the rename-only save form).
    const edit = await evalJS(cdp, `(()=>{ const b=document.querySelector('.mkt-edit[data-id="${spec.id}"]'); if(b){b.click(); return 'edited';} return 'no-edit-btn'; })()`);
    console.log('click EDIT:', edit);
    await sleep(1600); // give the async skill catalog time to populate + re-select chips

    // Scrape the builder form: is it in EDIT mode, and are all three pickers PREFILLED from the spec?
    const probe = `(()=>{
      const form = document.querySelector('.mkt-build-form'); if(!form) return { err:'no-build-form' };
      const title = (form.querySelector('.mkt-save-h')||{}).textContent||'';
      const cta = (form.querySelector('.mkt-do-build')||{}).textContent||'';
      const name = (form.querySelector('#mkt-b-name')||{}).value||'';
      const tagline = (form.querySelector('#mkt-b-tag')||{}).value||'';
      const purpose = (form.querySelector('#mkt-b-purpose')||{}).value||'';
      const manual = (form.querySelector('#mkt-b-manual')||{}).value||'';
      const emoji = (form.querySelector('#mkt-b-emoji')||{}).value||'';
      const kitSel = [...form.querySelectorAll('#mkt-b-kit .mkt-chip.pick.sel')].map(c=>c.dataset.kit);
      const kitAll = [...form.querySelectorAll('#mkt-b-kit .mkt-chip.pick')].map(c=>c.dataset.kit);
      const effSel = [...form.querySelectorAll('#mkt-b-effort .mkt-seg.sel')].map(s=>s.dataset.effort);
      const skillSel = [...form.querySelectorAll('#mkt-b-skills .mkt-chip.pick.sel')].map(c=>c.dataset.skill);
      const skillCount = form.querySelectorAll('#mkt-b-skills .mkt-chip.pick').length;
      const intro = (form.querySelector('.mkt-hint')||{}).textContent||'';
      return { title, cta, name, tagline, purpose, manual, emoji, kitSel, kitAll, effSel, skillSel, skillCount, intro };
    })()`;
    const data = JSON.parse(await evalJS(cdp, `JSON.stringify(${probe})`));
    out.form = data;
    console.log('\n--- EDIT FORM ---');
    console.log('title:', data.title, '| cta:', data.cta);
    console.log('name:', data.name, '| tagline:', data.tagline, '| emoji:', data.emoji);
    console.log('kit selected:', JSON.stringify(data.kitSel), 'of', JSON.stringify(data.kitAll));
    console.log('effort selected:', JSON.stringify(data.effSel));
    console.log('skill chips rendered:', data.skillCount, '| selected:', JSON.stringify(data.skillSel));
    console.log('intro:', data.intro);
    await capture(cdp, outDir, 'class-edit-form');

    // Assertions (prefilled from the minted spec).
    const fails = [];
    if (!/EDIT/i.test(data.title)) fails.push('title not EDIT mode: ' + data.title);
    if (!/SAVE CHANGES/i.test(data.cta)) fails.push('CTA not SAVE CHANGES: ' + data.cta);
    if (data.name !== 'Edit Probe') fails.push('name not prefilled: ' + data.name);
    if (data.purpose !== 'seed purpose') fails.push('purpose not prefilled: ' + data.purpose);
    const kitOk = spec.kit.every(k => data.kitSel.includes(k)) && data.kitSel.length === spec.kit.length;
    if (!kitOk) fails.push('kit picker not prefilled: sel=' + JSON.stringify(data.kitSel) + ' expected=' + JSON.stringify(spec.kit));
    if (!data.effSel.includes('high')) fails.push('effort picker not prefilled to high: ' + JSON.stringify(data.effSel));
    // skill chips only render once the live /api/skills catalog resolves; if it did, the seeded skill must be selected.
    if (data.skillCount > 0 && !data.skillSel.includes('web-research')) fails.push('skill picker rendered but web-research not selected: ' + JSON.stringify(data.skillSel));
    if (!/already-summoned/i.test(data.intro)) fails.push('honest edit copy missing (already-summoned agents keep their loadout): ' + data.intro);
    out.fails = fails;
    if (fails.length) { console.error('\nPREFILL FAILURES:'); fails.forEach(f => console.error('  ✗', f)); exitCode = 5; }
    else console.log('\nALL PREFILL CHECKS PASSED ✓');
  }
  out.console = diag.consoleMsgs.slice(0, 40);
  out.exceptions = diag.exceptions.slice(0, 20);
  const errs = (diag.consoleMsgs || []).filter(m => /error/i.test(m.level || m.type || '') || /error/i.test(String(m.text || m)));
  console.log(`\nconsole errors: ${errs.length}  uncaught exceptions: ${diag.exceptions.length}`);
  errs.slice(0, 8).forEach(e => console.log('  ERR', JSON.stringify(e).slice(0, 200)));
  diag.exceptions.slice(0, 8).forEach(e => console.log('  EXC', e));
  if (errs.length || diag.exceptions.length) exitCode = exitCode || 4;
} finally {
  writeFileSync(join(outDir, 'edit-manifest.json'), JSON.stringify(out, null, 2));
  try { cdp?.ws.close(); } catch {}
  try { proc.kill('SIGKILL'); } catch {}
  if (ownSidecar) { try { ownSidecar.kill('SIGKILL'); } catch {} }
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
}
console.log(`\n${exitCode === 0 ? 'DONE (ok)' : 'DONE (exit ' + exitCode + ')'} → ${outDir}`);
process.exit(exitCode);
