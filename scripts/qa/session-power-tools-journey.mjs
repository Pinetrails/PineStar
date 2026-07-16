// Wave 4A live DOM journey. Start a seeded StarNet app, then point SKYNET_PORT here.
// Drives real controls for 50-session search, both exports, clear/reload/undo, and exact bulk archive/undo.
import { launchChrome, connectCDP, evalJS, collectDiagnostics, sleep } from '../lib/cdp.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.SKYNET_PORT || '8787';
const CDP_PORT = Number(process.env.STARNET_CDP_PORT || 9774);
const profileDir = mkdtempSync(join(tmpdir(), 'session-power-tools-'));
const { proc } = launchChrome({ cdpPort: CDP_PORT, profileDir });
const failures = [];
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
  if (!ok) failures.push(name);
};
async function waitFor(cdp, expr, label, tries = 80) {
  for (let i = 0; i < tries; i++) { if (await evalJS(cdp, expr).catch(() => false)) return; await sleep(100); }
  throw new Error('timed out waiting for ' + label);
}

let cdp;
try {
  cdp = await connectCDP(CDP_PORT);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const { exceptions } = collectDiagnostics(cdp);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await waitFor(cdp, `typeof App === 'object' && typeof Workstreams === 'object' && !!document.querySelector('#screen-game.active')`, 'seeded station');

  const seeded = await evalJS(cdp, `(() => {
    const now=Date.now(), day=86400000, rows=[{id:'power-general',title:null,kind:'chat',lane:'active',createdAt:now,lastActiveAt:now,history:[]}];
    for(let i=1;i<=50;i++){
      rows.push({id:'power-'+i,title:i===17?'Orchid launch notes':'Session '+i,kind:'chat',lane:i%7===0?'shipped':'active',createdAt:now-i*day,lastActiveAt:now-i*day,pinned:i===49,history:i%5===0?[]:[{role:'user',content:i===23?'body NEBULA-NEEDLE':'Question '+i},{role:'assistant',content:'Answer '+i}]});
    }
    Workstreams.init({workstreams:rows,activeId:'power-17',generalId:'power-general'}); App.persist(); App.refreshRail(); return Workstreams.all().length;
  })()`);
  await sleep(1200);
  check('seeded General plus 50 sessions', seeded === 51, String(seeded));

  await evalJS(cdp, `StationUI.openTerm('sessiontools')`);
  await sleep(200);   // window mount + the deferred search focus (setTimeout 0)
  const opened = await evalJS(cdp, `({inWindow:!!document.querySelector('#ws-tools').closest('.term'),hidden:document.querySelector('#ws-tools').hidden,focused:document.activeElement.id})`);
  check('SESSION TOOLS window opens and focuses search', opened.inWindow && !opened.hidden && opened.focused === 'ws-search', JSON.stringify(opened));
  await evalJS(cdp, `(() => { const q=document.querySelector('#ws-search'); q.value='NEBULA-NEEDLE'; q.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const search = await evalJS(cdp, `[...document.querySelectorAll('#ws-search-results .ws-search-hit')].map(e=>({id:e.dataset.id,text:e.textContent}))`);
  check('body search finds exact known session', search.length === 1 && search[0].id === 'power-23', JSON.stringify(search));

  // Preserve the generated export bundle while neutralizing the browser download navigation.
  await evalJS(cdp, `(() => {
    window.__powerExports=[]; const original=Workstreams.exportConversation;
    Workstreams.exportConversation=(id,format,opts)=>{ const b=original(id,format,opts); window.__powerExports.push(b); return b; };
    URL.createObjectURL=()=> 'blob:starnet-test'; URL.revokeObjectURL=()=>{};
    HTMLAnchorElement.prototype.click=function(){};
    document.querySelector('#ws-export-md').click(); document.querySelector('#ws-export-json').click();
  })()`);
  const exports = await evalJS(cdp, `window.__powerExports.map(x=>({format:x.format,mime:x.mime,text:x.text}))`);
  check('both export controls emit their promised formats', exports.length === 2 && exports[0].format === 'markdown' && exports[1].format === 'json', JSON.stringify(exports.map(x => x.format)));
  check('export carries no hidden roles and JSON round-trips', /# Orchid launch notes/.test(exports[0].text) && JSON.parse(exports[1].text).messages.every(m=>m.role==='user'||m.role==='assistant'));

  await evalJS(cdp, `document.querySelector('#ws-clear').click()`);
  check('first clear click only arms named confirmation', await evalJS(cdp, `/CONFIRM CLEAR/.test(document.querySelector('#ws-clear').textContent) && Workstreams.get('power-17').history.length>0`));
  await evalJS(cdp, `document.querySelector('#ws-clear').click()`);
  check('confirmed clear empties only active transcript and offers undo', await evalJS(cdp, `Workstreams.get('power-17').history.length===0 && !document.querySelector('#ws-undo').hidden && Workstreams.get('power-23').history.length===2`));
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, `typeof Workstreams === 'object' && typeof StationUI === 'object' && !!document.querySelector('#screen-game.active') && !!document.querySelector('#ws-tools')`, 'reload after clear');
  await sleep(300);
  await evalJS(cdp, `StationUI.openTerm('sessiontools')`); await sleep(200);
  check('clear checkpoint survives reload', await evalJS(cdp, `Workstreams.get('power-17').history.length===0 && !document.querySelector('#ws-undo').hidden`));
  await evalJS(cdp, `document.querySelector('#ws-undo').click()`);
  check('clear undo restores exact transcript', await evalJS(cdp, `Workstreams.get('power-17').history.length===2 && !Workstreams.canUndo()`));

  await evalJS(cdp, `(() => { for(const id of ['ws-bulk-completed','ws-bulk-old']){const n=document.querySelector('#'+id);n.checked=true;n.dispatchEvent(new Event('change',{bubbles:true}));} document.querySelector('#ws-bulk-preview').click(); window.__expectedBulk=Workstreams.previewArchive({empty:true,completed:true,olderThanMs:30*86400000}).ids; })()`);
  const preview = await evalJS(cdp, `({expected:window.__expectedBulk,status:document.querySelector('#ws-bulk-status').textContent,disabled:document.querySelector('#ws-bulk-apply').disabled})`);
  check('bulk preview discloses exact non-empty count', preview.expected.length > 0 && !preview.disabled && preview.status.startsWith(preview.expected.length + ' exact'), JSON.stringify(preview));
  await evalJS(cdp, `document.querySelector('#ws-bulk-apply').click()`);
  const archived = await evalJS(cdp, `Workstreams.all().filter(w=>w.archived).map(w=>w.id).sort()`);
  check('bulk apply cannot cross previewed set', JSON.stringify(archived) === JSON.stringify(preview.expected), JSON.stringify({ archived, expected: preview.expected }));
  check('General and pinned remain protected', !archived.includes('power-general') && !archived.includes('power-49'));
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(cdp, `typeof Workstreams === 'object' && typeof StationUI === 'object' && !!document.querySelector('#screen-game.active') && !!document.querySelector('#ws-tools')`, 'reload after bulk');
  await sleep(300);
  await evalJS(cdp, `StationUI.openTerm('sessiontools')`); await sleep(200);
  check('bulk checkpoint survives reload', await evalJS(cdp, `Workstreams.canUndo() && !document.querySelector('#ws-undo').hidden`));
  await evalJS(cdp, `document.querySelector('#ws-undo').click()`);
  check('bulk undo restores every previewed row', (await evalJS(cdp, `Workstreams.all().filter(w=>w.archived).length`)) === 0);
  check('no uncaught page exceptions', exceptions.length === 0, exceptions.join(' ; '));
} catch (e) {
  console.log('FAIL harness :: ' + (e && e.stack || e)); failures.push('harness');
} finally {
  try { cdp?.ws.close(); } catch {}
  try { proc.kill(); } catch {}
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
console.log('\n=== ' + (failures.length ? 'FAILURES: ' + failures.join(', ') : 'ALL CHECKS PASSED') + ' ===');
process.exit(failures.length ? 1 : 0);
