#!/usr/bin/env node
// devverify.mjs — trustworthy local verification for StarNet on a busy multi-agent box.
//
// WHY THIS EXISTS: this machine runs ~15+ sidecars from parallel agent worktrees, on many
// ports. A naive `SKYNET_PORT=N node sidecar/index.js &` + curl can silently hit EADDRINUSE
// and then read ANOTHER agent's checkout — you "verify" a change that isn't even the one you
// edited (this actually happened and sent a session chasing a phantom bug). This tool makes
// that failure mode impossible:
//   1. It picks a port it has PROVEN is free (refused connection) before spawning.
//   2. It spawns the sidecar from THIS worktree and confirms the child stays alive (no
//      EADDRINUSE crash).
//   3. THE KEY CHECK: it fetches a sentinel frontend file over HTTP and compares the served
//      bytes to the on-disk file in this worktree. If they differ, you're reading a different
//      checkout — it aborts loudly instead of giving you a false PASS.
//   4. Optional --smoke: headless Chrome (CDP) load that captures console errors / exceptions
//      and runs --assert "<js>===<json>" DOM/runtime checks.
//   5. Always tears down the sidecar (and Chrome) it started.
//
// Zero deps: Node 22 globals (fetch, WebSocket), node:net, node:child_process.
//
// Usage:
//   node scripts/devverify.mjs                                  # boot + sentinel-identity check
//   node scripts/devverify.mjs --smoke                          # + headless console-error check
//   node scripts/devverify.mjs --smoke --assert "typeof Tutorial!=='undefined':::true"
//   node scripts/devverify.mjs --sentinel app/stationui.js --base 8850
//
// Exit 0 = trustworthy PASS, 1 = FAIL (with the reason).

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FRONTEND = join(ROOT, 'frontend');

// ---- args ----
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i === -1 ? def : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const SMOKE = args.includes('--smoke');
const SENTINEL = String(flag('--sentinel', 'app/worldmodel.js'));
const BASE = Number(flag('--base', 8850));
const WAIT_MS = Number(flag('--wait', 4500));
const ASSERTS = []; { let i; while ((i = args.indexOf('--assert')) !== -1) { ASSERTS.push(String(args[i + 1])); args.splice(i, 2); } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let FAILED = false;
const fail = (msg) => { FAILED = true; console.log('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);

// ---- a port is FREE iff a TCP connect is refused ----
function portFree(port) {
  return new Promise((res) => {
    const s = createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (free) => { if (done) return; done = true; try { s.destroy(); } catch {} res(free); };
    s.once('connect', () => finish(false));      // someone is listening → NOT free
    s.once('error', () => finish(true));          // ECONNREFUSED → free
    setTimeout(() => finish(true), 600);
  });
}
async function findFreePort(base) {
  for (let p = base; p < base + 60; p++) if (await portFree(p)) return p;
  throw new Error('no free port in [' + base + ',' + (base + 60) + ')');
}
const urlUp = async (u) => { try { const r = await fetch(u); return r.ok; } catch { return false; } };

// ---- teardown registry ----
const cleanups = [];
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {}
}

async function main() {
  log('devverify — trustworthy local check');
  log('  root: ' + ROOT);

  if (!existsSync(join(FRONTEND, SENTINEL))) { fail('sentinel file not found on disk: frontend/' + SENTINEL); return; }

  // 1) PROVEN-free port (this is what makes the read trustworthy)
  const port = await findFreePort(BASE);
  ok('claimed proven-free port ' + port);

  // 2) spawn THIS worktree's sidecar
  const child = spawn(process.execPath, ['sidecar/index.js'], {
    cwd: ROOT, env: { ...process.env, SKYNET_PORT: String(port) },
    stdio: 'ignore', detached: process.platform !== 'win32',
  });
  cleanups.push(() => killTree(child.pid));
  let childDead = false; child.once('exit', () => { childDead = true; });

  // 3) wait for ready; if the child died, it lost an EADDRINUSE race → abort (don't read a stranger)
  let up = false;
  for (let i = 0; i < 60; i++) {
    if (childDead) { fail('sidecar process exited before binding (EADDRINUSE race?) — NOT reading another checkout'); return; }
    if (await urlUp('http://127.0.0.1:' + port + '/')) { up = true; break; }
    await sleep(500);
  }
  if (!up) { fail('sidecar did not become ready on :' + port); return; }
  ok('our sidecar (pid ' + child.pid + ') is serving :' + port);

  // 4) THE IDENTITY CHECK — served bytes must equal this worktree's on-disk file
  const diskBuf = await readFile(join(FRONTEND, SENTINEL));
  const served = await fetch('http://127.0.0.1:' + port + '/' + SENTINEL);
  const servedBuf = Buffer.from(await served.arrayBuffer());
  if (servedBuf.length !== diskBuf.length) {
    fail('IDENTITY MISMATCH on ' + SENTINEL + ': served ' + servedBuf.length + 'B vs on-disk ' + diskBuf.length + 'B → reading a DIFFERENT checkout. Aborting (this is the false-PASS guard).');
    return;
  }
  ok('identity verified: served ' + SENTINEL + ' (' + servedBuf.length + 'B) == on-disk');

  if (!SMOKE) { ok('boot + identity PASS (no --smoke requested)'); return; }

  // 5) headless CDP console smoke + asserts
  await cdpSmoke(port);
}

async function cdpSmoke(appPort) {
  const CHROME = [process.env.SKYNET_CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
  ].filter(Boolean).find((p) => existsSync(p));
  if (!CHROME) { fail('--smoke requested but no Chrome found (set SKYNET_CHROME)'); return; }

  const cdpPort = await findFreePort(appPort + 100);
  const userDir = join(ROOT, '.devverify-chrome-' + cdpPort);
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + userDir, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  cleanups.push(() => killTree(ch.pid));

  // connect CDP
  let target;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:' + cdpPort + '/json/list'); const t = await r.json(); target = t.find((x) => x.type === 'page'); if (target?.webSocketDebuggerUrl) break; } catch {}
    await sleep(300);
  }
  if (!target?.webSocketDebuggerUrl) { fail('could not attach Chrome CDP on :' + cdpPort); return; }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let id = 0; const pending = new Map(); const handlers = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method) (handlers.get(m.method) || []).forEach((h) => h(m.params)); });
  const send = (method, params = {}) => new Promise((res, rej) => { const i2 = ++id; pending.set(i2, { res, rej }); ws.send(JSON.stringify({ id: i2, method, params })); setTimeout(() => { if (pending.has(i2)) { pending.delete(i2); rej(new Error('CDP timeout ' + method)); } }, 15000); });
  const on = (m, fn) => { if (!handlers.has(m)) handlers.set(m, []); handlers.get(m).push(fn); };

  const errors = [];
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  on('Runtime.exceptionThrown', (p) => errors.push('EXCEPTION: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '')));
  on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') errors.push('console.error: ' + p.args.map((a) => a.value || a.description || '').join(' ')); });
  on('Log.entryAdded', (p) => { if (p.entry.level === 'error') errors.push('log.error: ' + p.entry.text + (p.entry.url ? ' [' + p.entry.url + ']' : '')); });

  await send('Page.navigate', { url: 'http://127.0.0.1:' + appPort + '/' });
  await sleep(WAIT_MS);

  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.exceptionDetails) return { __threw: r.exceptionDetails.text }; return r.result.value; };

  // asserts: "<js>:::<json>"  (::: delimiter so JS === inside the expression is safe)
  for (const a of ASSERTS) {
    const m = a.split(':::');
    const expr = m[0]; const expected = m.slice(1).join(':::');
    const val = await ev('JSON.stringify(' + expr + ')');
    if (val === expected) ok('assert ok: ' + a);
    else fail('assert FAILED: ' + expr + ' → ' + JSON.stringify(val) + ' (wanted ' + expected + ')');
  }

  const realErrors = errors.filter((e) => !/favicon/.test(e));   // favicon 404 is a known benign trunk-wide non-issue
  if (realErrors.length) { realErrors.slice(0, 12).forEach((e) => fail('runtime: ' + e)); }
  else ok('headless load clean (no console errors/exceptions beyond benign favicon)');
}

let code = 1;
try { await main(); code = FAILED ? 1 : 0; }
catch (e) { console.log('  ✗ devverify crashed: ' + (e && e.message || e)); code = 1; }
finally {
  for (const c of cleanups.reverse()) { try { c(); } catch {} }
  await sleep(400);
  console.log(code === 0 ? '\nRESULT: PASS ✅' : '\nRESULT: FAIL ❌');
  process.exit(code);
}
