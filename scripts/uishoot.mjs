#!/usr/bin/env node
// uishoot.mjs — reliable in-game UI screenshotter for StarNet.
//
// WHY THIS EXISTS: preview_screenshot and `chrome --screenshot --virtual-time-budget`
// both hang on StarNet's always-animating canvas (it never reaches "idle", and virtual
// time never drains because rAF/timers are always pending). This drives Chrome over the
// DevTools Protocol and captures on a FIXED wall-clock wait instead — the proven unlock.
//
// Zero dependencies: Node 22 has global fetch + global WebSocket.
//
// Usage:
//   node scripts/uishoot.mjs                 # capture every UI state to .uishots/
//   node scripts/uishoot.mjs --only ingame   # one state
//   SKYNET_SHOT_PORT=8920 node scripts/uishoot.mjs
//
// Assumes a SKYNET_DEV sidecar is already serving (default :8920):
//   SKYNET_DEV=1 SKYNET_PORT=8920 node sidecar/index.js
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APP_PORT = process.env.SKYNET_SHOT_PORT || '8920';
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;
const OUT_DIR = process.env.SKYNET_SHOT_DIR || join(process.cwd(), '.uishots');
const CDP_PORT = Number(process.env.SKYNET_CDP_PORT || 9325);
const WIN = process.env.SKYNET_SHOT_SIZE || '1440,900';

const CHROME_CANDIDATES = [
  process.env.SKYNET_CHROME,
  'C:/Users/andro/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe',
  'C:/Users/andro/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error('No Chrome/Chromium binary found. Set SKYNET_CHROME.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ensure a SKYNET_DEV sidecar is serving the target port; boot one from cwd if not.
// Lets the Visual-Auditor loop be a single self-contained command.
async function ensureSidecar() {
  const up = async () => { try { const r = await fetch(APP_URL); return r.ok; } catch { return false; } };
  if (await up()) { console.log(`sidecar: already up on :${APP_PORT}`); return null; }
  if (process.argv.indexOf('--boot') === -1) {
    console.log(`sidecar: down on :${APP_PORT} (pass --boot to auto-start, or start it yourself)`);
    return null;
  }
  console.log(`sidecar: booting SKYNET_DEV on :${APP_PORT} from ${process.cwd()} ...`);
  const sc = spawn(process.execPath, ['sidecar/index.js'], {
    env: { ...process.env, SKYNET_DEV: '1', SKYNET_PORT: String(APP_PORT) },
    stdio: 'ignore', detached: false,
  });
  for (let i = 0; i < 60; i++) { if (await up()) { console.log('sidecar: ready'); return sc; } await sleep(500); }
  throw new Error('sidecar failed to come up on :' + APP_PORT);
}

// ---- minimal CDP client over the page target's websocket ----
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) { (this.handlers.get(m.method) || []).forEach((h) => h(m.params)); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
}

async function connectCDP(port) {
  // poll the version endpoint, then the page target list
  let targets;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await r.json();
      const page = targets.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
        return new CDP(ws);
      }
    } catch {}
    await sleep(250);
  }
  throw new Error('Could not connect to CDP on ' + port);
}

async function evalJS(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

async function capture(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(OUT_DIR, `${name}.png`);
  writeFileSync(path, Buffer.from(r.data, 'base64'));
  const kb = Math.round(Buffer.from(r.data, 'base64').length / 1024);
  console.log(`  shot: ${name}.png (${kb} KB)`);
  return path;
}

async function main() {
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;
  mkdirSync(OUT_DIR, { recursive: true });
  const ownSidecar = await ensureSidecar();
  const chrome = findChrome();
  console.log(`chrome: ${chrome}`);
  console.log(`target: ${APP_URL}`);

  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--mute-audio', `--remote-debugging-port=${CDP_PORT}`,
    `--window-size=${WIN}`, `--user-data-dir=${join(OUT_DIR, '_profile')}`,
    'about:blank',
  ], { stdio: 'ignore' });
  proc.on('error', (e) => { console.error('chrome spawn error', e); process.exit(1); });

  let cdp;
  try {
    cdp = await connectCDP(CDP_PORT);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // boot the game once
    console.log('navigating + booting...');
    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(9000); // FIXED wait — beats the never-idle canvas

    const title = await evalJS(cdp, 'document.title').catch(() => '?');
    const dev = await evalJS(cdp, '!!window.__SKYNET_DEV__').catch(() => false);
    console.log(`  title="${title}" dev=${dev}`);

    const states = buildStates();
    for (const st of states) {
      if (only && st.name !== only) continue;
      console.log(`state: ${st.name}`);
      if (st.drive) { try { await evalJS(cdp, st.drive); } catch (e) { console.log('  drive warn:', e.message); } }
      await sleep(st.wait ?? 1400);
      await capture(cdp, st.name);
    }
    console.log(`\nDONE → ${OUT_DIR}`);
  } finally {
    try { cdp?.ws.close(); } catch {}
    proc.kill('SIGKILL');
    if (ownSidecar) { try { ownSidecar.kill('SIGKILL'); } catch {} }
  }
}

// Each state: optional `drive` JS run in the page to open a panel/mode, then a wait, then a shot.
// The bottom dock = groups (.bb-grp: CREW/WORK/BUILD/SYSTEM) whose flyout items (.bb) open
// full panels into the #terms z50 overlay. We close any open overlay, then click the .bb/.bb-grp
// item by its text (.click() fires the handler even while the flyout is visually hidden).
function buildStates() {
  // Close whatever panel/overlay is currently open so panels don't stack between shots.
  const CLOSE = `(() => {
    // exit REFIT/BUILD mode first (a full-canvas mode, not a #terms panel)
    const rd = document.getElementById('refit-done'); if (rd) { try { rd.click(); } catch {} }
    document.querySelectorAll('.refit-overlay').forEach(o => { try { o.remove(); } catch {} });
    document.body.classList.remove('refit-on');
    // Click the REAL close button on every open window (.term-x) so the app's own
    // closeTerm() runs and its internal open{} map is cleared. (Nuking #terms.innerHTML
    // leaves that map populated, which corrupts the single-vs-cascade placement logic.)
    document.querySelectorAll('.term-x, #terms .x, #terms .close, #terms [data-close], .term-close, .panel-close, .win-close, .rb-close, .recruit-close').forEach(b => { try { b.click(); } catch {} });
    // Escape as a backstop for panels that honor it (recruitment bay, etc.)
    ['keydown','keyup'].forEach(type => document.dispatchEvent(new KeyboardEvent(type, { key:'Escape', code:'Escape', keyCode:27, which:27, bubbles:true })));
    return 'closed';
  })()`;
  // Click a dock item (.bb or .bb-grp) by its text; falls back to any button.
  const open = (needle) => `(() => {
    ${CLOSE};
    const pick = sel => [...document.querySelectorAll(sel)].find(el => (el.textContent||'').includes(${JSON.stringify(needle)}));
    const el = pick('.bb') || pick('.bb-grp') || pick('button,.btn,[role=button]');
    if (!el) return 'NOTFOUND:'+${JSON.stringify(needle)};
    el.click();
    return 'opened:'+(el.textContent||'').trim().slice(0,28);
  })()`;
  const closeOnly = `(() => { ${CLOSE}; return 'reset'; })()`;
  return [
    { name: 'ingame',          drive: closeOnly,                wait: 900 },
    // CREW group
    { name: 'crew-agents',     drive: open('☻ AGENTS') },
    { name: 'crew-roster',     drive: open('ROSTER') },
    { name: 'crew-summon',     drive: open('SUMMON'),           wait: 1800 },
    { name: 'crew-commander',  drive: open('COMMANDER') },
    // WORK group
    { name: 'work-tasks',      drive: open('TASKS') },
    { name: 'work-recipes',    drive: open('RECIPES') },
    { name: 'work-routines',   drive: open('ROUTINES') },
    // BUILD group
    { name: 'build-station',   drive: open('BUILD STATION'),    wait: 2000 },
    { name: 'build-skills',    drive: open('SKILLS') },         // QA-4 lie panel
    { name: 'build-connectors',drive: open('CONNECTORS') },
    // SYSTEM group
    { name: 'sys-settings',    drive: open('SETTINGS') },       // QA-1 lie panel
    { name: 'sys-messaging',   drive: open('MESSAGING') },
    { name: 'sys-rewind',      drive: open('REWIND') },
    { name: 'sys-logbook',     drive: open('LOGBOOK') },
  ];
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
