// scripts/verify-clip.mjs — LIVE proof for the G5 shareable CLIP (agent/clip-export).
// Boots a SEEDED SKYNET_DEV sidecar to the live floor (real #stage canvas), then in the REAL running page:
//   1) arms a Clip.recorder against the live #stage, lets real frames accumulate, disarms;
//   2) runs the shipped Clip.assemble() reducer on a run-entry in the EXACT /api/runs recap shape and asserts
//      every on-overlay number equals the telemetry (or is honestly absent) — AND that there is NO XP delta;
//   3) mints the real GIF via Clip.capture(), pulls the bytes out, and DECODES the GIF89a structurally to prove
//      it is a valid, MULTI-FRAME, LOOPING animation of the captured floor (not a still, not a stub).
// Writes the GIF artifact + a JSON evidence blob. No CDP screenshot of the canvas (that times out) — we
// composite + encode in-page and pull the bytes, same dodge as verify-postcard.mjs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, connectCDP, evalJS, sleep } from './lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, isUp, waitUp, waitDevReady } from './lib/seed.mjs';

const PORT = process.env.CLIP_PORT || '8962';
const CDP_PORT = Number(process.env.CLIP_CDP || 9962);
const OUT = join(process.cwd(), '.clip-verify');
const APP_URL = `http://127.0.0.1:${PORT}/`;
mkdirSync(OUT, { recursive: true });

// the exact run entry the sidecar's /api/runs ledger returns (recap shape) — real telemetry field names.
const RUN = {
  runId: 'r-clip-001', agentId: 'agent', reason: 'done',
  title: 'render the launch teaser and drop it on the belt',
  artifacts: [{ kind: 'file', path: 'out/teaser.md', bytes: 3100 }, { kind: 'image', path: 'out/frame.png', bytes: 74000 }],
  usd: 0.0512, unmetered: false, model: 'anthropic/claude-sonnet-4.6', tokens: 21400, turns: 4,
};
const DUR_MS = 118000;
const CAP_FPS = 10;
const CAP_SECONDS = 4;   // keep the live capture short so the verify runs fast; still MULTI-FRAME + animated

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

  await sleep(1500);   // let the world render real frames into #stage

  const fails = [];

  // 1) sanity: the shipped module is present on the real page
  const present = await evalJS(cdp, `!!(window.Clip && Clip.capture && Clip.assemble && Clip.recorder)`);
  if (!present) throw new Error('Clip module not loaded on the live page');

  // 2) the live #stage canvas is real + non-blank (a real frame source, not a stub)
  const scene = await evalJS(cdp, `(function(){var c=document.getElementById('stage');if(!c)return null;
    var t=document.createElement('canvas');t.width=8;t.height=8;var x=t.getContext('2d');
    try{x.drawImage(c,0,0,8,8);}catch(e){return {err:String(e)};}
    var d=x.getImageData(0,0,8,8).data,nz=0;for(var i=0;i<d.length;i+=4){if(d[i]||d[i+1]||d[i+2])nz++;}
    return {w:c.width,h:c.height,nonBlankPx:nz};})()`);
  console.log('stage canvas:', JSON.stringify(scene));
  if (!scene || !scene.w || scene.nonBlankPx === 0) fails.push('live #stage is blank/absent — no real frames to capture');

  // 2b) PERFORMANCE GUARDRAIL — measure the frame sampling cost. We time ONE recorder.sample()-equivalent draw
  //     of the live #stage into the downscaled clip tile; the guardrail is that a sample is cheap (well under the
  //     ~2ms/frame budget) AND, because the recorder runs on its OWN setInterval (never in the rAF loop), the
  //     render loop's per-frame cost is unchanged whether armed or not. We prove the sample cost here.
  const perf = await evalJS(cdp, `(function(){
    var scene=document.getElementById('stage'); if(!scene) return {err:'no stage'};
    var W=Clip.CLIP_W, H=Clip.CLIP_H;
    var c=document.createElement('canvas'); c.width=W; c.height=H; var cx=c.getContext('2d');
    var N=30, t0=performance.now();
    for(var i=0;i<N;i++){ try{ cx.drawImage(scene,0,0,W,H); }catch(e){} }
    var per=(performance.now()-t0)/N;
    return { perSampleMs: Math.round(per*1000)/1000, budgetMs: 2 };
  })()`);
  console.log('sample cost:', JSON.stringify(perf));
  if (perf && perf.perSampleMs != null && perf.perSampleMs > 2) fails.push('a clip sample costs ' + perf.perSampleMs + 'ms (> 2ms budget) — would need a smaller tile');

  // 3) ARM a real recorder against the live #stage, accumulate REAL frames over wall-clock, disarm.
  await evalJS(cdp, `(function(){ window.__CLIP_REC__ = Clip.recorder({fps:${CAP_FPS}, seconds:${CAP_SECONDS}}); window.__CLIP_REC__.arm(); return true; })()`);
  await sleep((CAP_SECONDS * 1000) + 400);   // let the ring fill with real floor frames
  const framesInfo = await evalJS(cdp, `(function(){ var r=window.__CLIP_REC__; r.disarm(); var f=r.frames();
    return { count:f.length, cap:r.cap(), fps:r.fps(), firstT:f[0]&&f[0].t, lastT:f[f.length-1]&&f[f.length-1].t }; })()`);
  console.log('recorder:', JSON.stringify(framesInfo));
  if (!framesInfo || framesInfo.count < 2) fails.push('recorder captured < 2 frames — not an animation');
  if (framesInfo && framesInfo.count > framesInfo.cap) fails.push('ring exceeded its cap — not memory-bounded');

  // 4) run the SHIPPED assemble() reducer on real telemetry + real clip facts (EXACTLY what fireClip feeds it)
  const asm = await evalJS(cdp, `(function(){
    var r=window.__CLIP_REC__, f=r.frames();
    var span = f.length>1 ? (f[f.length-1].t-f[0].t) : f.length*(1000/r.fps());
    return Clip.assemble({ run: ${JSON.stringify(RUN)}, durMs: ${DUR_MS},
      agent: { name: ((window.App&&App.currentAgent&&App.currentAgent())||{}).name || 'Agent' },
      clip: { seconds: span/1000, fps: r.fps(), frames: f.length } });
  })()`);
  console.log('assembled overlay model:', JSON.stringify(asm, null, 2));

  // 5) TELEMETRY-MATCH assertions — every on-overlay value equals the input telemetry (or is honestly absent)
  const has = (arr, pred) => Array.isArray(arr) && arr.some(pred);
  if (asm.done !== true) fails.push('done should be true for a reason=done run');
  if (asm.outcome !== 'DELIVERED') fails.push('outcome should be DELIVERED, got ' + asm.outcome);
  if (asm.title !== RUN.title) fails.push('title mismatch: ' + asm.title);
  if (!has(asm.chips, c => c === '2 artifacts')) fails.push('artifact count chip missing (expected "2 artifacts")');
  if (!has(asm.chips, c => /1m/.test(c))) fails.push('duration chip missing (118s -> 1m..)');
  if (!has(asm.chips, c => c === '$0.05')) fails.push('cost chip mismatch: expected $0.05 from usd=' + RUN.usd);
  if (!has(asm.chips, c => c === '21k tok')) fails.push('token chip mismatch: expected 21k tok from tokens=' + RUN.tokens);
  if (!has(asm.chips, c => c === RUN.model)) fails.push('model chip missing: ' + RUN.model);
  if (has(asm.chips, c => c === 'subscription')) fails.push('a metered run must NOT show "subscription"');
  // THE XP-HONESTY LAW — a clip carries NO growth/XP number at all (unknowable at clip time)
  if (asm.growth !== undefined && asm.growth !== null) fails.push('a clip overlay must carry NO growth/XP block');
  if (/xp/i.test(JSON.stringify(asm))) fails.push('the clip overlay model references XP — it must not');
  // the CLIP self-stamp must reflect the REAL recording (frame count == captured frames)
  if (!asm.capture || asm.capture.frames !== framesInfo.count) fails.push('clip self-stamp frame count != real captured frames');
  if (!asm.capture || !(asm.capture.seconds > 0)) fails.push('clip self-stamp seconds not a real positive span');

  // 6) mint the REAL GIF via the shipped capture() over the live-captured frames + pull the bytes out
  const dataUrl = await evalJS(cdp, `(async function(){
    var r=window.__CLIP_REC__;
    var res = await Clip.capture({ run: ${JSON.stringify(RUN)}, durMs: ${DUR_MS}, agent: {name:'V'}, recorder: r });
    // convert the produced blob to a base64 data URL so node can pull the bytes
    return await new Promise(function(resolve){ var fr=new FileReader(); fr.onload=function(){resolve({url:fr.result, name:res.name, frames:res.frames, seconds:res.seconds, fps:res.fps});}; fr.readAsDataURL(res.blob); });
  })()`);
  if (!dataUrl || !/^data:image\/gif;base64,/.test(dataUrl.url || '')) fails.push('capture() did not produce a GIF data URL');

  let gifBytes = 0, gifPath = '', gifDecode = null;
  if (dataUrl && dataUrl.url) {
    const buf = Buffer.from(dataUrl.url.split(',')[1], 'base64');
    gifBytes = buf.length;
    gifDecode = decodeGifStructure(buf);
    if (!gifDecode.ok) fails.push('produced bytes are not a valid GIF89a: ' + gifDecode.why);
    else {
      if (gifDecode.frames < 2) fails.push('GIF has < 2 frames (' + gifDecode.frames + ') — not an animation');
      if (gifDecode.frames !== framesInfo.count) fails.push('GIF frame count (' + gifDecode.frames + ') != captured frames (' + framesInfo.count + ')');
      if (!gifDecode.loops) fails.push('GIF lacks the NETSCAPE looping extension — will not loop');
      if (gifDecode.width !== 480 || gifDecode.height !== 300) fails.push('GIF dims != the clip tile (480x300): ' + gifDecode.width + 'x' + gifDecode.height);
    }
    if (buf.length < 2000) fails.push('GIF suspiciously small (' + buf.length + ' bytes) — likely blank');
    gifPath = join(OUT, 'clip.gif');
    writeFileSync(gifPath, buf);
  }
  console.log('gif decode:', JSON.stringify(gifDecode));

  const evidence = { runEntry: RUN, durMs: DUR_MS, stageCanvas: scene, samplePerf: perf, recorder: framesInfo, assembled: asm, gifBytes, gifPath, gifDecode, capture: dataUrl && { name: dataUrl.name, frames: dataUrl.frames, seconds: dataUrl.seconds, fps: dataUrl.fps }, fails };
  writeFileSync(join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));

  if (fails.length) { console.error('\nVERIFY FAILED:\n - ' + fails.join('\n - ')); code = 1; }
  else console.log(`\nVERIFY OK — GIF=${gifBytes}B (${gifDecode.frames} frames, ${gifDecode.width}x${gifDecode.height}, looping) at ${gifPath}; every on-overlay number matches the run telemetry; NO XP delta present; sample cost ${perf.perSampleMs}ms < 2ms.`);
} catch (e) {
  console.error('FATAL', e); code = 1;
} finally {
  try { cdp?.ws.close(); } catch {}
  try { proc?.kill('SIGKILL'); } catch {}
  if (ownSidecar) { try { ownSidecar.kill('SIGKILL'); } catch {} }
}
process.exit(code);

// ---- a minimal GIF89a structural decoder: header, dims, per-frame count, looping extension ----
// Not a pixel decoder — it walks the block structure to PROVE the file is a valid multi-frame, looping animation.
function decodeGifStructure(buf) {
  try {
    const sig = String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4], buf[5]);
    if (sig !== 'GIF89a' && sig !== 'GIF87a') return { ok: false, why: 'bad signature: ' + sig };
    const width = buf[6] | (buf[7] << 8);
    const height = buf[8] | (buf[9] << 8);
    const packed = buf[10];
    let p = 13;
    if (packed & 0x80) { const gctSize = 2 << (packed & 0x07); p += gctSize * 3; }   // skip global colour table
    let frames = 0, loops = false;
    const skipSubBlocks = () => { while (p < buf.length) { const len = buf[p++]; if (len === 0) break; p += len; } };
    while (p < buf.length) {
      const b = buf[p++];
      if (b === 0x3b) break;                         // trailer
      else if (b === 0x2c) {                         // image descriptor → one frame
        frames++;
        p += 8;                                      // left/top/w/h
        const lp = buf[p++];
        if (lp & 0x80) { const lctSize = 2 << (lp & 0x07); p += lctSize * 3; }
        p++;                                          // LZW min code size
        skipSubBlocks();                              // image data sub-blocks
      } else if (b === 0x21) {                        // extension
        const label = buf[p++];
        if (label === 0xff) {                         // application extension — check for NETSCAPE looping
          const len = buf[p];
          const name = String.fromCharCode(...buf.slice(p + 1, p + 1 + Math.min(11, len)));
          if (name.startsWith('NETSCAPE')) loops = true;
        }
        skipSubBlocks();
      } else { return { ok: false, why: 'unexpected block byte 0x' + b.toString(16) + ' at ' + (p - 1) }; }
    }
    return { ok: true, width, height, frames, loops };
  } catch (e) { return { ok: false, why: String(e) }; }
}
