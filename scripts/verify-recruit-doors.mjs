// Lane D live verification: drives the running dev-seed sidecar (SKYNET_PORT=8845) over CDP,
// opens the Recruitment Bay in summon mode, seeds a prospect, and asserts the UX-fix DOM changes.
import { launchChrome, connectCDP, evalJS, collectDiagnostics, sleep } from './lib/cdp.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.SKYNET_PORT || '8845';
const CDP_PORT = 9755;
const profileDir = mkdtempSync(join(tmpdir(), 'recruit-doors-'));

const { proc } = launchChrome({ cdpPort: CDP_PORT, profileDir });
let failures = [];
const check = (name, cond, detail) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); if (!cond) failures.push(name); };

try {
  const cdp = await connectCDP(CDP_PORT);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const { exceptions } = collectDiagnostics(cdp);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(6500); // dev-seed auto-boots into the live station

  // ---- seed a prospect into ProspectStore via localStorage, then re-init ----
  await evalJS(cdp, `(() => {
    const rec = { id: 'prospect-verify-1', fingerprint: 'verify-fp-1', mintedAt: Date.now(),
      why: 'you keep asking for CSV cleanups', draft: { emoji: '📊', name: 'Data Wrangler',
        tagline: 'tames messy spreadsheets', purpose: 'clean and reshape tabular data',
        manual: '', accent: '#33ccff', model: 'balanced', kit: ['cabinet'], skills: [] } };
    localStorage.setItem('starnet.prospects.v1', JSON.stringify({ v:1, prospects:[rec], denylist:[], tasksSinceMint:3 }));
    if (typeof ProspectStore !== 'undefined' && ProspectStore.init) ProspectStore.init({});
    return ProspectStore.list().length;
  })()`);

  // ---- open the bay in summon mode ----
  await evalJS(cdp, `Marketplace.open({ mode:'pick', summon:true, concurrentCap:3, notify:(m,k)=>{ window.__lastNote={m,k}; }, onPick:()=>{} })`);
  await sleep(900);

  // 1) prospect card renders + dismiss button copy admits permanence
  const dismissTitle = await evalJS(cdp, `(document.querySelector('.mkt-prospect-dismiss')||{}).title || ''`);
  check('prospect card present', await evalJS(cdp, `!!document.querySelector('.mkt-prospect')`));
  check('dismiss title admits permanence', /dismiss forever/i.test(dismissTitle), JSON.stringify(dismissTitle));

  // 2) prospect dismiss is 2-step arm/confirm (first click arms, does NOT remove)
  await evalJS(cdp, `document.querySelector('.mkt-prospect-dismiss').click()`);
  await sleep(200);
  const armedText = await evalJS(cdp, `(document.querySelector('.mkt-prospect-dismiss')||{}).textContent || ''`);
  const stillThereAfterArm = await evalJS(cdp, `!!document.querySelector('.mkt-prospect')`);
  check('first click arms (shows DISMISS FOREVER?)', /DISMISS FOREVER\?/i.test(armedText), JSON.stringify(armedText));
  check('first click does NOT remove the prospect', stillThereAfterArm);
  // second click confirms → prospect gone + fingerprint denylisted
  await evalJS(cdp, `document.querySelector('.mkt-prospect-dismiss').click()`);
  await sleep(300);
  const goneAfterConfirm = await evalJS(cdp, `!document.querySelector('.mkt-prospect')`);
  const denied = await evalJS(cdp, `ProspectStore.isDenied('verify-fp-1')`);
  check('second click removes the prospect', goneAfterConfirm);
  check('dismiss denylisted the fingerprint (permanent)', denied === true);

  // 3) dossier de-jargon: data-hint attrs on CLEARANCE/EFFORT/VOICE/FOCUS + TRY ASKING label
  await sleep(300);
  const hints = await evalJS(cdp, `JSON.stringify([...document.querySelectorAll('.mkt-spec [data-hint]')].map(e=>e.getAttribute('data-hint')))`);
  check('dossier rows carry data-hint (clearance/effort/voice/focus)',
    ['clearance','effort','voice','focus'].every(h => hints.includes(h)), hints);
  const bhTexts = await evalJS(cdp, `[...document.querySelectorAll('.mkt-block .bh')].map(e=>e.textContent).join(' | ')`);
  check('TRY ASKING labeled as example prompts', /TRY ASKING — things you can say to it/.test(bhTexts), bhTexts);

  // 3b) gear row copy: optional-you-can-still-summon when gear missing (dossier of a class with kit)
  const gearState = await evalJS(cdp, `(() => {
    // focus a class that has kit; Data Wrangler-like builtins vary — scan any missing kit row on any focused class
    const missing = document.querySelector('.mkt-kit-missing .mkt-kit-state');
    return missing ? missing.textContent : '__no-missing-row-in-current-dossier__';
  })()`);
  check('missing-gear row admits summon is still possible (when a missing row is shown)',
    gearState === '__no-missing-row-in-current-dossier__' || /optional — you can still summon/.test(gearState), JSON.stringify(gearState));

  // 4) summon CTA subtext truth (no "you pick its character next"; describes the chat thread)
  const subText = await evalJS(cdp, `(document.querySelector('.mkt-cta-sub')||{}).textContent || '__not-found__'`);
  check('summon subtext describes the chat thread (truthful)', /opens its own[\s\S]*chat thread[\s\S]*pre-filled from this class/.test(subText), JSON.stringify(subText));
  check('summon subtext no longer says "you pick its character next"', !/you pick its character next/.test(await evalJS(cdp, `document.body.innerHTML`)));
  check('workstream term carries a data-hint', await evalJS(cdp, `!!document.querySelector('.mkt-cta-sub [data-hint="workstream"]')`));

  // 5) shelf trust lines (cold-start / warm) — check the source strings are rendered when a shelf shows
  const shelfHeads = await evalJS(cdp, `[...document.querySelectorAll('.mkt-rec-sect')].map(e=>e.textContent).join(' || ')`);
  check('a recommendation shelf renders', shelfHeads.length > 0, shelfHeads.slice(0,180));
  check('shelf carries a grounding clause',
    /this shelf changes as you use agents|based on your recent runs/.test(shelfHeads) || shelfHeads.length===0, shelfHeads.slice(0,200));

  // ---- open the custom builder to verify kit blurbs + empty-kit validation ----
  await evalJS(cdp, `(() => { const b=document.querySelector('.mkt-build'); if(b){b.click();return 'clicked';} return 'none'; })()`);
  await sleep(700);
  const inBuilder = await evalJS(cdp, `!!document.querySelector('#mkt-b-kit')`);
  check('custom builder opened', inBuilder);
  if (inBuilder) {
    const kitBlurbs = await evalJS(cdp, `[...document.querySelectorAll('#mkt-b-kit .mkt-kitpick-grant')].map(e=>e.textContent)`);
    check('kit checkboxes show capability blurbs', Array.isArray(kitBlurbs) && kitBlurbs.length >= 5 && kitBlurbs.some(t=>/the WEB|FILES|MEMORY|TERMINAL|IMAGES/.test(t)), JSON.stringify(kitBlurbs));
    // empty-kit validation: type a name, clear kit, click CREATE → expect the mirror message, no view change
    await evalJS(cdp, `(() => { const n=document.querySelector('#mkt-b-name'); if(n){n.value='Test Empty Kit'; n.dispatchEvent(new Event('input',{bubbles:true}));}
      // ensure kit is empty by de-selecting any selected chips
      document.querySelectorAll('#mkt-b-kit .mkt-chip.pick.sel').forEach(b=>b.click());
      window.__lastNote=null; })()`);
    await sleep(200);
    await evalJS(cdp, `document.querySelector('.mkt-do-build').click()`);
    await sleep(300);
    const note = await evalJS(cdp, `window.__lastNote ? window.__lastNote.m : ''`);
    const stillInBuilder = await evalJS(cdp, `!!document.querySelector('#mkt-b-kit')`);
    check('empty-kit save shows the mirrored validation message', /a specialist with no gear is not a real role — pick at least one kit item/.test(note), JSON.stringify(note));
    check('empty-kit save does NOT create the class (stays in builder)', stillInBuilder);
  }

  check('no uncaught page exceptions', exceptions.length === 0, exceptions.join(' ; '));
} catch (e) {
  console.log('FAIL harness :: ' + (e && e.stack || e));
  failures.push('harness');
} finally {
  try { proc.kill(); } catch {}
}

console.log('\n=== ' + (failures.length ? 'FAILURES: ' + failures.join(', ') : 'ALL CHECKS PASSED') + ' ===');
process.exit(failures.length ? 1 : 0);
