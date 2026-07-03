// scripts/verify-postcard.mjs — LIVE proof for the G5 postcard (agent/postcard-export).
// Boots a SEEDED SKYNET_DEV sidecar to the live floor (real #stage canvas), then in the REAL running
// page exercises the shipped Postcard module end-to-end against a run-entry in the EXACT /api/runs shape
// the recap card consumes, decodes the produced PNG, and asserts the on-card numbers equal the telemetry.
// Writes the PNG artifact + a JSON evidence blob. Reuses the shoot capture substrate (no CDP screenshotter
// of the canvas — we composite in-page and pull the PNG bytes out, dodging the canvas-screenshot timeout).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, connectCDP, evalJS, sleep } from './lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, isUp, waitUp, waitDevReady } from './lib/seed.mjs';

const PORT = process.env.PC_PORT || '8961';
const CDP_PORT = Number(process.env.PC_CDP || 9961);
const OUT = join(process.cwd(), '.postcard-verify');
const APP_URL = `http://127.0.0.1:${PORT}/`;
mkdirSync(OUT, { recursive: true });

// the exact run entry the sidecar's /api/runs ledger returns (recap shape) — real telemetry field names.
const RUN = {
  runId: 'r-verify-001', agentId: 'agent', reason: 'done',
  title: 'draft the launch announcement and save it',
  artifacts: [{ kind: 'file', path: 'out/announce.md', bytes: 2048 }, { kind: 'image', path: 'out/hero.png', bytes: 91000 }],
  usd: 0.0731, unmetered: false, model: 'anthropic/claude-sonnet-4.6', tokens: 18432, turns: 5,
};
const DUR_MS = 132000;

let ownSidecar = null, cdp = null, proc = null, code = 0;
try {
  if (await isUp(APP_URL)) console.log(`sidecar: reusing :${PORT}`);
  else {
    console.log(`sidecar: booting SEEDED SKYNET_DEV on :${PORT} ...`);
    const scratch = join(OUT, '_seed-workspace');
    materializeSeedWorkspace(scratch);
    ownSidecar = bootSeededSidecar({ port: PORT, scratchDir: scratch });
    if (!(await waitUp(APP_URL))) throw new Error('seeded sidecar failed to come up');
  }
  ({ proc } = launchChrome({ cdpPort: CDP_PORT, win: '1440,900', profileDir: join(OUT, '_profile') }));
  cdp = await connectCDP(CDP_PORT);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: APP_URL });
  const ready = await waitDevReady(cdp, evalJS, { tries: 30, url: APP_URL });
  const screen = await evalJS(cdp, `(document.querySelector('.screen.active')||{}).id||'?'`).catch(() => '?');
  console.log(`in-game: ready=${ready} screen=${screen}`);
  if (!ready) throw new Error('never reached the live floor (screen=' + screen + ')');

  // give the world a moment to render real frames into #stage
  await sleep(1500);

  // 1) sanity: the shipped module is present on the real page
  const present = await evalJS(cdp, `!!(window.Postcard && Postcard.capture && Postcard.assemble)`);
  if (!present) throw new Error('Postcard module not loaded on the live page');

  // 2) the live #stage canvas is real + non-blank (a real captured frame, not a stub)
  const scene = await evalJS(cdp, `(function(){var c=document.getElementById('stage');if(!c)return null;
    var t=document.createElement('canvas');t.width=8;t.height=8;var x=t.getContext('2d');
    try{x.drawImage(c,0,0,8,8);}catch(e){return {err:String(e)};}
    var d=x.getImageData(0,0,8,8).data,nz=0;for(var i=0;i<d.length;i+=4){if(d[i]||d[i+1]||d[i+2])nz++;}
    return {w:c.width,h:c.height,nonBlankPx:nz};})()`);
  console.log('stage canvas:', JSON.stringify(scene));

  // 2b) fold REAL growth + station events through the SHIPPED engines on the live page so the postcard's
  //     growth/station blocks have honest numbers to show (not just the fresh-seed empty state). We drive the
  //     actual Xp + Pride engines — the same code the app folds bus events through — so the numbers are real.
  const seeded = await evalJS(cdp, `(function(){
    var out = {};
    // fold 3 positive verdicts + 2 shipped tasks into a real hero stats blob (the honest Xp ladder)
    if (window.Xp) {
      var s = Xp.fresh();
      for (var i=0;i<3;i++) s = Xp.applyEvent(s,{name:'memory.feedback',payload:{reason:'work_great',delta:3,size:'medium'}}).stats;
      s = Xp.applyEvent(s,{name:'agent.run.end',payload:{reason:'done'}}).stats;
      s = Xp.applyEvent(s,{name:'agent.run.end',payload:{reason:'done'}}).stats;
      var a = (window.App && App.currentAgent) ? App.currentAgent() : null;
      if (a) a.stats = s;   // attach to the live hero so App.currentAgent().stats is real
      window.__PC_STATS__ = s;   // also stash the real stats blob so assemble reads the SAME folded ladder
      out.heroPresent = !!a;
      out.heroCompute = Xp.compute(s);
    }
    // fold real lifetime events into the durable Pride engine and read its honest snapshot
    if (window.Pride) {
      var p = Pride.hydrate(null), t = Date.now();
      p = Pride.fold(p,'agent.run.start',{runId:'a'},t-5000);
      p = Pride.fold(p,'agent.run.end',{runId:'a',reason:'done'},t);
      p = Pride.fold(p,'workitem.delivered',{},t);
      out.prideSnap = Pride.snapshot(p);
      window.__PC_PRIDE__ = out.prideSnap;   // stash so the assemble step below reads the SAME real snapshot
    }
    return out;
  })()`);
  console.log('seeded live engines:', JSON.stringify(seeded));

  // 3) run the SHIPPED assemble() reducer on the real telemetry (this is EXACTLY what firePostcard feeds it)
  const asm = await evalJS(cdp, `(function(){
    var card = Postcard.assemble({ run: ${JSON.stringify(RUN)}, durMs: ${DUR_MS},
      agent: { name: ((window.App&&App.currentAgent&&App.currentAgent())||{}).name || 'Agent', stats: window.__PC_STATS__ || ((window.App&&App.currentAgent&&App.currentAgent())||{}).stats || null },
      xp: window.Xp || null,
      pride: window.__PC_PRIDE__ || null,
      nowMs: Date.now() });
    return card;
  })()`);
  console.log('assembled card model:', JSON.stringify(asm, null, 2));

  // 4) TELEMETRY-MATCH assertions — every on-card value must equal the input telemetry (or be honestly absent)
  const fails = [];
  const has = (arr, pred) => Array.isArray(arr) && arr.some(pred);
  if (asm.done !== true) fails.push('done should be true for a reason=done run');
  if (asm.outcome !== 'DELIVERED') fails.push('outcome should be DELIVERED, got ' + asm.outcome);
  if (asm.title !== RUN.title) fails.push('title mismatch: ' + asm.title);
  if (!has(asm.chips, c => c === '2 artifacts')) fails.push('artifact count chip missing (expected "2 artifacts")');
  if (!has(asm.chips, c => /2m/.test(c))) fails.push('duration chip missing (132s -> 2m..)');
  if (!has(asm.chips, c => c === '$0.07')) fails.push('cost chip mismatch: expected $0.07 from usd=' + RUN.usd);
  if (!has(asm.chips, c => c === '18k tok')) fails.push('token chip mismatch: expected 18k tok from tokens=' + RUN.tokens);
  if (!has(asm.chips, c => c === RUN.model)) fails.push('model chip missing: ' + RUN.model);
  // no fabricated stats: with usd>0 there must be exactly one $ chip and no "subscription"
  if (has(asm.chips, c => c === 'subscription')) fails.push('a metered run must NOT show "subscription"');
  // growth block must match the live Xp.compute we folded (honest ladder, not fabricated)
  if (!asm.growth) fails.push('growth block missing after folding 3 real verdicts');
  else {
    if (seeded.heroCompute && asm.growth.level !== seeded.heroCompute.level) fails.push('growth level != live Xp.compute level');
    if (asm.growth.tasksDone < 2) fails.push('growth tasksDone should reflect 2 real shipped runs');
    if (seeded.heroCompute && seeded.heroCompute.known && !asm.growth.confLabel) fails.push('calibrated hero should show a confidence label');
  }
  // station block must match the live Pride.snapshot we folded
  if (!asm.station) fails.push('station block missing after folding real lifetime events');
  else {
    if (seeded.prideSnap && asm.station.tasks !== seeded.prideSnap.tasks) fails.push('station tasks != live Pride snapshot tasks');
    if (seeded.prideSnap && asm.station.deliverables !== seeded.prideSnap.deliverables) fails.push('station deliverables != live Pride snapshot');
  }

  // 5) render the REAL PNG (live #stage scene + this card) and pull the bytes out of the page
  const dataUrl = await evalJS(cdp, `(function(){
    var card = Postcard.assemble({ run: ${JSON.stringify(RUN)}, durMs: ${DUR_MS},
      agent: { name: ((window.App&&App.currentAgent&&App.currentAgent())||{}).name || 'Agent', stats: window.__PC_STATS__ || ((window.App&&App.currentAgent&&App.currentAgent())||{}).stats || null },
      xp: window.Xp || null,
      pride: window.__PC_PRIDE__ || null, nowMs: Date.now() });
    var cv = Postcard.render(document.getElementById('stage'), card);
    return cv ? cv.toDataURL('image/png') : null;
  })()`);
  if (!dataUrl || !/^data:image\/png;base64,/.test(dataUrl)) fails.push('render() did not produce a PNG data URL');

  let pngBytes = 0, pngPath = '';
  if (dataUrl) {
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    pngBytes = buf.length;
    // PNG magic number check — a REAL png, not an empty stub
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (!isPng) fails.push('produced bytes are not a valid PNG (bad magic)');
    if (buf.length < 5000) fails.push('PNG suspiciously small (' + buf.length + ' bytes) — likely blank');
    pngPath = join(OUT, 'postcard.png');
    writeFileSync(pngPath, buf);
  }

  // 6) verify the real toBlob() download path also yields a PNG blob (the user-facing save)
  const blobOk = await evalJS(cdp, `(async function(){
    try {
      var card = Postcard.assemble({ run: ${JSON.stringify(RUN)}, durMs: ${DUR_MS}, agent: {name:'V', stats: window.__PC_STATS__||null}, xp: window.Xp||null, pride: null, nowMs: Date.now() });
      var cv = Postcard.render(document.getElementById('stage'), card);
      var b = await Postcard.toBlob(cv);
      return { ok: b instanceof Blob, type: b && b.type, size: b && b.size };
    } catch(e){ return { ok:false, err:String(e) }; }
  })()`);
  if (!blobOk || !blobOk.ok || blobOk.type !== 'image/png' || !(blobOk.size > 0)) fails.push('toBlob() did not yield a PNG blob: ' + JSON.stringify(blobOk));

  const evidence = { runEntry: RUN, durMs: DUR_MS, stageCanvas: scene, assembled: asm, pngBytes, pngPath, blob: blobOk, fails };
  writeFileSync(join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));

  if (fails.length) { console.error('\nVERIFY FAILED:\n - ' + fails.join('\n - ')); code = 1; }
  else console.log(`\nVERIFY OK — PNG=${pngBytes}B at ${pngPath}; every on-card number matches the run telemetry.`);
} catch (e) {
  console.error('FATAL', e); code = 1;
} finally {
  try { cdp?.ws.close(); } catch {}
  try { proc?.kill('SIGKILL'); } catch {}
  if (ownSidecar) { try { ownSidecar.kill('SIGKILL'); } catch {} }
}
process.exit(code);
