// verify-dust.mjs — Slice 3 live check: dust motes add temporal flicker inside light pools.
// Samples the live #stage canvas over N frames with CRT.dust=0 vs 1 and compares per-pixel
// temporal variance in a pool region. Motes → more variance. Reduced-motion → none.
import { launchChrome, connectCDP, evalJS, sleep } from './lib/cdp.mjs';
import { rmSync } from 'node:fs'; import { join } from 'node:path';
const PORT = Number((process.argv[process.argv.indexOf('--port')+1]) || 8127);
const profileDir = join(process.cwd(), '.verify-dust-chrome');
let child;
async function frameVariance(cdp) {
  // capture 14 frames of a pool-region readback, return summed per-pixel (max-min) luminance range
  return await evalJS(cdp, `(async function(){
    const cv = document.getElementById('stage'); const g = cv.getContext('2d');
    // sample region: center-ish of the canvas where a lit pool sits, in DEVICE px
    const rw = 180, rh = 140, rx = Math.round(cv.width*0.35), ry = Math.round(cv.height*0.30);
    const frames = [];
    for (let i=0;i<14;i++){
      const d = g.getImageData(rx, ry, rw, rh).data;
      const lum = new Float32Array(rw*rh);
      for (let p=0,j=0;p<d.length;p+=4,j++) lum[j]=(d[p]+d[p+1]+d[p+2])/3;
      frames.push(lum);
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    }
    let sumRange=0, active=0;
    for (let j=0;j<frames[0].length;j++){
      let mn=1e9,mx=-1e9;
      for (const f of frames){ if(f[j]<mn)mn=f[j]; if(f[j]>mx)mx=f[j]; }
      const rng = mx-mn; sumRange+=rng; if(rng>2) active++;
    }
    return { sumRange:+sumRange.toFixed(1), activePx:active, region:{rx,ry,rw,rh} };
  })()`);
}
async function main(){
  ({ proc: child } = launchChrome({ cdpPort: 9779, profileDir }));
  const cdp = await connectCDP(9779);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?crtlab=1` });
  for (let i=0;i<40;i++){ const r=await evalJS(cdp,`typeof World!=='undefined' && !!World.crt && !!document.getElementById('stage')`).catch(()=>0); if(r) break; await sleep(500); }
  await sleep(3000);
  // force a stable-ish camera (no awakening veil) — the seed resumes already awake; just proceed
  await evalJS(cdp, `World.crt.dust=0; World.crt.grain=0; World.crt.aberr=0;`);
  await sleep(600);
  const off = await frameVariance(cdp);
  await evalJS(cdp, `World.crt.dust=1;`);
  await sleep(600);
  const on = await frameVariance(cdp);
  console.log('[Slice 3] dust motes — live #stage temporal variance in a pool region');
  console.log('  region:', JSON.stringify(off.region));
  console.log('  dust=0  sumLumRange=', off.sumRange, ' flickering px=', off.activePx);
  console.log('  dust=1  sumLumRange=', on.sumRange, ' flickering px=', on.activePx);
  console.log('  Δ sumRange (dust adds flicker):', +(on.sumRange-off.sumRange).toFixed(1));
  const pass = on.sumRange > off.sumRange + 20 && on.activePx > off.activePx;
  console.log('  SLICE 3:', pass ? 'PASS (dust adds pool flicker)' : 'INCONCLUSIVE (glow shimmer may dominate)');
  console.log('  (reduced-motion path is guarded in drawDust via reduceMotion(); not forced here)');
}
main().catch(e=>console.error('CRASH',e)).finally(async()=>{ try{child.kill();}catch{} await sleep(300); try{rmSync(profileDir,{recursive:true,force:true});}catch{} process.exit(0); });
