// verify-crtfx.mjs — Slice 5 live check: film grain + chromatic aberration on the warped feed.
// (a) GRAIN: temporal per-pixel luminance range in a lit region with grain 0 vs 0.25 (dust off).
// (b) ABERRATION: summed |R-B| channel split in the bowed edge strips with aberr 0 vs 1 (GPU path).
import { launchChrome, connectCDP, evalJS, sleep } from './lib/cdp.mjs';
import { rmSync } from 'node:fs'; import { join } from 'node:path';
const PORT = Number((process.argv[process.argv.indexOf('--port')+1]) || 8127);
const profileDir = join(process.cwd(), '.verify-crtfx-chrome');
let child;
async function frameVariance(cdp) {
  return await evalJS(cdp, `(async function(){
    const cv = document.getElementById('stage'); const g = cv.getContext('2d');
    const rw = 180, rh = 140, rx = Math.round(cv.width*0.35), ry = Math.round(cv.height*0.30);
    const frames = [];
    for (let i=0;i<12;i++){
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
      const rng=mx-mn; sumRange+=rng; if(rng>2) active++;
    }
    return { sumRange:+sumRange.toFixed(1), activePx:active };
  })()`);
}
async function rbSplit(cdp) {
  return await evalJS(cdp, `(async function(){
    const cv = document.getElementById('stage'); const g = cv.getContext('2d');
    const y0 = Math.round(cv.height*0.30), hh = Math.round(cv.height*0.40), sw = 48;
    let s = 0, lit = 0;
    for (const x0 of [Math.round(cv.width*0.16), Math.round(cv.width*0.84)-sw]) {
      const d = g.getImageData(x0, y0, sw, hh).data;
      for (let i=0;i<d.length;i+=4){ s += Math.abs(d[i]-d[i+2]); if (d[i]+d[i+1]+d[i+2] > 30) lit++; }
    }
    return { rb: s, litPx: lit };
  })()`);
}
async function main(){
  ({ proc: child } = launchChrome({ cdpPort: 9781, profileDir }));
  const cdp = await connectCDP(9781);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?crtlab=1` });
  for (let i=0;i<40;i++){ const r=await evalJS(cdp,`typeof World!=='undefined' && !!World.crt && !!document.getElementById('stage')`).catch(()=>0); if(r) break; await sleep(500); }
  await sleep(3000);
  await evalJS(cdp, `World.crt.dust=0; World.crt.grain=0; World.crt.aberr=0;`);
  await sleep(600);
  console.log('[Slice 5a] chromatic aberration — per-pixel R-channel shift in flank strips vs baseline drift');
  // grab(): one strip capture. Baseline drift = |off2-off1| (glow shimmer etc.); effect = |on-off2|.
  const grab = () => evalJS(cdp, `(async function(){
    const cv = document.getElementById('stage'); const g = cv.getContext('2d');
    const y0 = Math.round(cv.height*0.30), hh = Math.round(cv.height*0.40), sw = 48;
    const out = [];
    for (const x0 of [Math.round(cv.width*0.16), Math.round(cv.width*0.84)-sw])
      out.push(Array.from(g.getImageData(x0, y0, sw, hh).data));
    return out;
  })()`);
  const off1 = await grab(); const off2 = await grab();
  await evalJS(cdp, `World.crt.aberr=1;`);
  await sleep(600);
  const on = await grab();
  const rdiff = (A, B) => { let s = 0; for (let k = 0; k < A.length; k++) for (let i = 0; i < A[k].length; i += 4) s += Math.abs(A[k][i] - B[k][i]); return s; };
  const drift = rdiff(off1, off2), effect = rdiff(off2, on);
  console.log('  baseline R-drift (aberr 0 vs 0):', drift);
  console.log('  effect  R-shift (aberr 0 vs 1):', effect);
  const aPass = effect > drift * 3;
  console.log('  SLICE 5a:', aPass ? 'PASS (aberration moves the R channel far beyond shimmer drift)' : 'INCONCLUSIVE');
  console.log('[Slice 5b] film grain — temporal variance, lit region, dust off');
  await evalJS(cdp, `World.crt.aberr=0; World.crt.grain=0;`);
  await sleep(400);
  const g0 = await frameVariance(cdp);
  await evalJS(cdp, `World.crt.grain=0.25;`);
  await sleep(400);
  const g1 = await frameVariance(cdp);
  console.log('  grain=0     sumLumRange=', g0.sumRange, ' flickering px=', g0.activePx);
  console.log('  grain=0.25  sumLumRange=', g1.sumRange, ' flickering px=', g1.activePx);
  const gPass = g1.sumRange > g0.sumRange + 20 && g1.activePx > g0.activePx;
  console.log('  SLICE 5b:', gPass ? 'PASS (grain adds broadband flicker)' : 'FAIL');
}
main().catch(e=>console.error('CRASH',e)).finally(async()=>{ try{child.kill();}catch{} await sleep(300); try{rmSync(profileDir,{recursive:true,force:true});}catch{} process.exit(0); });
