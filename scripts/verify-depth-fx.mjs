// scripts/verify-depth-fx.mjs — live headless verification of the env-depth-fx slices.
// Connects to an ALREADY-RUNNING seed on --port (default 8127), drives the page over CDP,
// and samples baked/live canvas pixels to prove each effect actually changes the picture.
// Usage: node scripts/verify-depth-fx.mjs --port 8127
import { launchChrome, connectCDP, evalJS, sleep } from './lib/cdp.mjs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const PORT = Number(arg('--port', 8127));
const CDP_PORT = Number(arg('--cdp', 9777));
const profileDir = join(process.cwd(), '.verify-depth-chrome');

let child;
async function main() {
  ({ proc: child } = launchChrome({ cdpPort: CDP_PORT, profileDir }));
  const cdp = await connectCDP(CDP_PORT);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?crtlab=1` });
  // wait for the world to boot + bake
  for (let i = 0; i < 40; i++) {
    const ready = await evalJS(cdp, `typeof World!=='undefined' && typeof StationBake!=='undefined' && typeof WorldModel!=='undefined' && !!(World.crt)`).catch(()=>false);
    if (ready) break;
    await sleep(500);
  }
  await sleep(2500);

  // Helper: bake the default station geo twice (knob off vs on), full-canvas diff the baseCv, and
  // report how many floor pixels the effect darkens + the mean luminance change over changed pixels.
  const helper = `
  (function(){
    window.__mkGeo = function(){ return WorldModel.create().projectGeometry(); };
    window.__bakeDiff = function(key, a, bVal){
      const geo = window.__mkGeo(), SB = StationBake;
      const saved = Object.assign({}, SB.DEPTH);
      function snap(v){ SB.DEPTH.wallShadow = 0; SB.DEPTH.sheen = 0; SB.DEPTH[key] = v; const bk = SB.bake(geo); const g = bk.baseCv.getContext('2d'); return { d: g.getImageData(0,0,bk.baseCv.width,bk.baseCv.height).data, w: bk.baseCv.width, h: bk.baseCv.height }; }
      const A = snap(a), B = snap(bVal);
      Object.assign(SB.DEPTH, saved);
      let changed=0, darker=0, brighter=0, dsum=0, samp=[];
      for (let i=0;i<A.d.length;i+=4){
        const la=(A.d[i]+A.d[i+1]+A.d[i+2])/3, lb=(B.d[i]+B.d[i+1]+B.d[i+2])/3;
        if (A.d[i]!==B.d[i]||A.d[i+1]!==B.d[i+1]||A.d[i+2]!==B.d[i+2]){
          changed++; const dl=lb-la; dsum+=dl; if(dl<0)darker++; else brighter++;
          if(samp.length<5){const px=(i/4)%A.w, py=Math.floor((i/4)/A.w); samp.push({px,py,off:+la.toFixed(1),on:+lb.toFixed(1)});}
        }
      }
      return { w:A.w, h:A.h, changed, darker, brighter, meanLumΔ:+(dsum/Math.max(1,changed)).toFixed(2), samp };
    };
    return 'ok';
  })()`;
  const hres = await evalJS(cdp, helper);
  console.log('helper install:', hres);

  // ---- SLICE 1: wall-cast floor shadow ----
  const N = JSON.parse(await evalJS(cdp, `JSON.stringify(window.__bakeDiff('wallShadow', 0, 0.28))`));
  console.log('\n[Slice 1] wall-cast floor shadow — default station, baseCv diff (wallShadow 0 → 0.28)');
  console.log('  canvas:', N.w + 'x' + N.h);
  console.log('  pixels changed:', N.changed, ' (darker:', N.darker, ' brighter:', N.brighter + ')');
  console.log('  mean luminance Δ over changed px (negative = darker):', N.meanLumΔ);
  console.log('  sample changed px:', JSON.stringify(N.samp));
  const s1pass = N.changed > 200 && N.meanLumΔ < -1 && N.darker > N.brighter;
  console.log('  SLICE 1:', s1pass ? 'PASS (wall bases darken the floor)' : 'FAIL');

  // ---- SLICE 2: floor sheen under light pools ----
  const S = JSON.parse(await evalJS(cdp, `JSON.stringify(window.__bakeDiff('sheen', 0, 0.6))`));
  console.log('\n[Slice 2] floor sheen — default station, baseCv diff (sheen 0 → 0.6)');
  console.log('  pixels changed:', S.changed, ' (darker:', S.darker, ' brighter:', S.brighter + ')');
  console.log('  mean luminance Δ over changed px (positive = brighter):', S.meanLumΔ);
  console.log('  sample changed px:', JSON.stringify(S.samp));
  const s2pass = S.changed > 50 && S.meanLumΔ > 0.5 && S.brighter > S.darker;
  console.log('  SLICE 2:', s2pass ? 'PASS (floor brighter under pools)' : 'FAIL/INCONCLUSIVE (not yet implemented?)');

  console.log('\n=== SUMMARY ===');
  console.log('slice1_wallShadow:', s1pass);
  console.log('slice2_sheen:', s2pass);
}

main().catch(e=>{ console.error('CRASH', e); }).finally(async()=>{
  try{ child && child.kill(); }catch{}
  await sleep(300);
  try{ rmSync(profileDir,{recursive:true,force:true}); }catch{}
  process.exit(0);
});
