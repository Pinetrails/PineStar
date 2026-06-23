#!/usr/bin/env node
// one-off geometry probe: open SETTINGS, report rects + scrim presence.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const PORT = process.env.SKYNET_SHOT_PORT || '8920';
const CDP_PORT = 9327;
const CHROME = ['C:/Users/andro/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP { constructor(ws){this.ws=ws;this.id=0;this.p=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result);}});}
  send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.p.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);reject(new Error('timeout '+method));}},30000);});}}
async function connect(port){for(let i=0;i<40;i++){try{const r=await fetch(`http://127.0.0.1:${port}/json/list`);const t=await r.json();const pg=t.find(x=>x.type==='page');if(pg?.webSocketDebuggerUrl){const ws=new WebSocket(pg.webSocketDebuggerUrl);await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true});});return new CDP(ws);}}catch{}await sleep(250);}throw new Error('no cdp');}
async function ev(cdp,expr){const r=await cdp.send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
const proc=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--hide-scrollbars',`--remote-debugging-port=${CDP_PORT}`,'--window-size=1440,900','--user-data-dir='+join(process.cwd(),'.uishots','_measure'),'about:blank'],{stdio:'ignore'});
try{
  const cdp=await connect(CDP_PORT);
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate',{url:`http://127.0.0.1:${PORT}/`});
  await sleep(9000);
  // open settings
  await ev(cdp,`(()=>{const el=[...document.querySelectorAll('.bb')].find(e=>(e.textContent||'').includes('SETTINGS'));el&&el.click();return !!el;})()`);
  await sleep(1400);
  const m=await ev(cdp,`(()=>{
    const rect=el=>{if(!el)return null;const r=el.getBoundingClientRect();const cs=getComputedStyle(el);return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),pos:cs.position,z:cs.zIndex,disp:cs.display,trans:cs.transform.slice(0,30)};};
    const out={vw:innerWidth,vh:innerHeight};
    out.terms=rect(document.getElementById('terms'));
    out.term=rect(document.querySelector('.term'));
    out.termClasses=document.querySelector('.term')?.className||null;
    out.scrim=rect(document.querySelector('.term-scrim'));
    out.scrimExists=!!document.querySelector('.term-scrim');
    out.chatPanel=rect(document.getElementById('chat-panel'));
    out.stageWrap=rect(document.getElementById('stage-wrap'));
    out.app=rect(document.getElementById('app'));
    // is .term a child of #terms or elsewhere?
    out.termParent=document.querySelector('.term')?.parentElement?.id||document.querySelector('.term')?.parentElement?.className||null;
    return out;
  })()`);
  console.log(JSON.stringify(m,null,1));
}finally{proc.kill('SIGKILL');}
