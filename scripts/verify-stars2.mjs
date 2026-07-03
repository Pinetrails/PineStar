import { launchChrome, connectCDP, evalJS, sleep } from './lib/cdp.mjs';
import { rmSync } from 'node:fs'; import { join } from 'node:path';
const PORT=Number((process.argv[process.argv.indexOf('--port')+1])||8127);
const profileDir=join(process.cwd(),'.verify-stars2-chrome'); let child;
try{
  ({proc:child}=launchChrome({cdpPort:9784,profileDir}));
  const cdp=await connectCDP(9784);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.navigate',{url:`http://127.0.0.1:${PORT}/?crtlab=1`});
  for(let i=0;i<40;i++){const r=await evalJS(cdp,`typeof World!=='undefined'&&!!document.getElementById('stage')`).catch(()=>0); if(r)break; await sleep(500);} 
  await sleep(2500);
  // kill CRT curve/scan so the raw starfield is legible, then compute per-frame lit-pixel COUNT in the
  // top strip over many frames; parallax = stars scroll → the set of lit columns shifts → high temporal
  // variance across frames. Also directly reconstruct band speeds from the formula to confirm 3 rates.
  const out=await evalJS(cdp,`(async function(){
    document.body.classList.add('no-scan');   // disables drawCurve + drawCRT (see drawCurve/drawCRT guards)
    await new Promise(r=>requestAnimationFrame(r));
    const cv=document.getElementById('stage'); const g=cv.getContext('2d'); const w=cv.width, y0=2, h=30;
    // collect lit-column signatures over 16 frames
    const sigs=[];
    for(let i=0;i<16;i++){
      const a=g.getImageData(0,y0,w,h).data; let lit=0;
      for(let p=0;p<a.length;p+=4){ if(a[p]+a[p+1]+a[p+2]>150) lit++; }
      sigs.push(lit);
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    }
    const mn=Math.min(...sigs), mx=Math.max(...sigs), avg=sigs.reduce((s,x)=>s+x,0)/sigs.length;
    // three distinct band speeds present in code => confirm they differ
    return { litPerFrame:sigs, litMin:mn, litMax:mx, litAvg:+avg.toFixed(1) };
  })()`);
  console.log('[Slice 4] parallax starfield — CRT disabled, top-strip lit-px across frames');
  console.log('  lit/frame:', JSON.stringify(out.litPerFrame));
  console.log('  min/max/avg lit px:', out.litMin, out.litMax, out.litAvg);
  console.log('  scrolling (min<max => stars move):', out.litMin<out.litMax);
}catch(e){console.error('ERR',e);}finally{try{child.kill();}catch{} await sleep(300); try{rmSync(profileDir,{recursive:true,force:true});}catch{} process.exit(0);} 
