#!/usr/bin/env node
// uiprobe.mjs — one-off: dump the dock/panel DOM structure so uishoot can drive precisely.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const PORT = process.env.SKYNET_SHOT_PORT || '8920';
const CDP_PORT = 9326;
const CHROME = ['C:/Users/andro/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP { constructor(ws){this.ws=ws;this.id=0;this.p=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result);}});}
  send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.p.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);reject(new Error('timeout '+method));}},30000);});}}
async function connect(port){for(let i=0;i<40;i++){try{const r=await fetch(`http://127.0.0.1:${port}/json/list`);const t=await r.json();const pg=t.find(x=>x.type==='page');if(pg?.webSocketDebuggerUrl){const ws=new WebSocket(pg.webSocketDebuggerUrl);await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true});});return new CDP(ws);}}catch{}await sleep(250);}throw new Error('no cdp');}
async function ev(cdp,expr){const r=await cdp.send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
const proc=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--hide-scrollbars',`--remote-debugging-port=${CDP_PORT}`,'--window-size=1440,900','--user-data-dir='+join(process.cwd(),'.uishots','_probe'),'about:blank'],{stdio:'ignore'});
try{
  const cdp=await connect(CDP_PORT);
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate',{url:`http://127.0.0.1:${PORT}/`});
  await sleep(9000);
  const dump=await ev(cdp,`(()=>{
    const out={};
    // --- boot state: WHY is dev=false / which screen is up? ---
    let H='no-Harness';
    try{ H=(typeof Harness!=='undefined')?{configured:Harness.configured(),model:Harness.getModel(),prov:Harness.getProv()}:'no-Harness'; }catch(e){ H='Harness-err:'+e.message; }
    out.boot={
      title:document.title,
      devType:typeof window.__STARNET_DEV__,
      devVal:window.__STARNET_DEV__||null,
      apiToken:!!window.__SKYNET_API_TOKEN__,
      harness:H,
      ls:{key:!!localStorage.getItem('skynet.byok.key'),model:localStorage.getItem('skynet.byok.model'),prov:localStorage.getItem('skynet.byok.prov')},
      hasCanvas:!!document.querySelector('canvas'),
      bodyClass:document.body.className,
      newStation:!!([...document.querySelectorAll('button,*')].find(e=>(e.textContent||'').trim()==='NEW STATION')),
    };
    // all buttons with text + id/class
    out.buttons=[...document.querySelectorAll('button,.btn,[role=button],.dock-btn,.tool,.bb,.bb-grp')].slice(0,80).map(b=>({t:(b.textContent||'').trim().slice(0,28),id:b.id||'',cls:(b.className||'').toString().slice(0,40),vis:b.offsetParent!==null}));
    // overlays/panels
    out.overlays=[...document.querySelectorAll('#terms,.panel,.window,.modal,[class*=panel],[class*=overlay]')].slice(0,40).map(e=>({id:e.id||'',cls:(e.className||'').toString().slice(0,50),disp:getComputedStyle(e).display,z:getComputedStyle(e).zIndex}));
    return out;
  })()`);
  console.log(JSON.stringify(dump,null,1));
}finally{proc.kill('SIGKILL');}
