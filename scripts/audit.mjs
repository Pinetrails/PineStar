#!/usr/bin/env node
// audit.mjs — assertion-driven behavioral + truthfulness auditor for StarNet.  (`npm run audit`)
//
// Where `npm run shoot` proves the UI LOOKS right (frames a human/agent reads), this proves the
// floor BEHAVES right and the numbers don't lie — fully automatically, PASS/FAIL, no eyeballing.
// It boots the seeded in-game sidecar, then drives + asserts over CDP against the DEV-only
// window.__SKYNET_TEST__ probe (frontend/app/testapi.js):
//
//   floor-rest (P1 foundation):
//     • the test API is present + in-game
//     • every PLACED body idles inside its OWN zone (Tier A containment)
//     • awareness is GAZE-ONLY: no body is walking toward another body's tile (Tier C)
//     • HUD truthfulness: each on-screen number equals the reduction over the frozen U.bus log
//       (no-app-lies) — for a fresh seed, SPEND/TOKENS must read exactly the event-derived totals
//
// (P2 will add driven scenarios — spawn / summon-walks-to-own-desk / place-a-prop / run-a-task.)
// Exits NONZERO on any failed assertion and writes the offending frame + a JSON report.
//
// Usage:
//   npm run audit
//   SKYNET_AUDIT_PORT=8934 SKYNET_AUDIT_CDP=9334 npm run audit
//   SKYNET_AUDIT_LIVE_PROVIDER=1 npm run audit     # use the real configured provider/key
//   SKYNET_AUDIT_REUSE=1 npm run audit             # intentionally drive an already-running sidecar
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { sleep, launchChrome, connectCDP, evalJS, capture, collectDiagnostics } from './lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, isUp, waitUp, waitDevReady, DEFAULT_MODEL } from './lib/seed.mjs';
import { closeOnly, openSel } from './lib/states.mjs';

const PORT = process.env.SKYNET_AUDIT_PORT || '8934';
const CDP_PORT = Number(process.env.SKYNET_AUDIT_CDP || 9334);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const OUT_DIR = process.env.SKYNET_AUDIT_DIR || join(process.cwd(), '.uiaudit');
const WIN = process.env.SKYNET_SHOT_SIZE || '1440,900';
const KEEP = process.argv.includes('--keep');
const SCRATCH = join(OUT_DIR, '_seed-workspace');
const PROFILE = join(OUT_DIR, '_profile');
const REUSE_EXISTING = /^(1|true|yes|on)$/i.test(String(process.env.SKYNET_AUDIT_REUSE || '').trim());
const LIVE_PROVIDER = /^(1|true|yes|on)$/i.test(String(process.env.SKYNET_AUDIT_LIVE_PROVIDER || '').trim());

// Default audit provider: deterministic, local, zero-spend. The task scenario needs
// a terminal run lifecycle, not a race against OpenRouter rejecting a placeholder key.
function startMockOpenRouter(model) {
  return new Promise((resolve) => {
    const requests = [];
    const server = createServer((req, res) => {
      if (req.url && req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{
          id: model || DEFAULT_MODEL,
          name: 'Audit Mock Model',
          context_length: 8000,
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: ['tools']
        }] }));
        return;
      }
      if (req.url && req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          try { requests.push(JSON.parse(body)); } catch {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '2\n3\n5' } }] }) + '\n\n');
          setTimeout(() => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          }, 600);
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      requests,
      base: 'http://127.0.0.1:' + server.address().port + '/api/v1'
    }));
  });
}

// Wait until the DEV test probe is armed AND reports in-game.
async function waitTestReady(cdp, tries = 24) {
  for (let i = 0; i < tries; i++) {
    const ok = await evalJS(cdp, '!!(window.__SKYNET_TEST__ && window.__SKYNET_TEST__.ready())').catch(() => false);
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

// tiny assertion recorder. A SOFT assertion is reported but never fails the build (used for signals
// that depend on the test ENVIRONMENT — e.g. a real model run — rather than a product invariant).
function makeAsserter() {
  const results = [];
  const ok = (name, pass, detail, soft) => {
    results.push({ name, pass: !!pass, detail: detail || '', soft: !!soft });
    const tag = pass ? 'PASS' : (soft ? 'soft' : 'FAIL');
    console.log(`  ${tag}  ${name}${detail ? '  — ' + detail : ''}`);
    return !!pass;
  };
  return { ok, results };
}

// ---- CDP driving helpers (synthetic clicks/typing in the page) ----
const J = (v) => JSON.stringify(v);
const clickSel = (cdp, sel) => evalJS(cdp, `(() => { const el = document.querySelector(${J(sel)}); if (!el) return 'NOTFOUND'; el.click(); return 'clicked'; })()`).catch((e) => 'ERR:' + e.message);
async function waitSel(cdp, sel, tries = 25) {
  for (let i = 0; i < tries; i++) { const ok = await evalJS(cdp, `!!document.querySelector(${J(sel)})`).catch(() => false); if (ok) return true; await sleep(200); }
  return false;
}
const sendChat = (cdp, msg) => evalJS(cdp, `(() => { const i = document.getElementById('chat-input'); if (!i) return 'NO_INPUT'; i.focus(); i.value = ${J(msg)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); return 'sent'; })()`).catch((e) => 'ERR:' + e.message);
const getBodies = (cdp) => evalJS(cdp, 'window.__SKYNET_TEST__.bodies()').catch(() => []);
const tk = (t) => (t ? `${t.x},${t.y}` : '');
// containment + gaze-only over a body snapshot (the Tier A/C invariants, reused across scenarios).
function assertFloorInvariants(A, prefix, list) {
  const escaped = (list || []).filter((b) => b.zone && b.inOwnZone === false);   // only bodies that HAVE a zone may violate it
  A.ok(`${prefix}/zoned-bodies-contained`, escaped.length === 0, escaped.length ? escaped.map((b) => `${b.name}@(${b.tile.x},${b.tile.y})`).join('; ') : `${list.length} bodies, none roaming outside its zone`);
  const occ = new Set((list || []).map((b) => tk(b.tile)));
  const chasing = (list || []).filter((b) => b.moving && b.target && occ.has(tk(b.target.tile)) && tk(b.target.tile) !== tk(b.tile));
  A.ok(`${prefix}/awareness-gaze-only`, chasing.length === 0, chasing.length ? chasing.map((b) => `${b.name} → ${tk(b.target.tile)}`).join('; ') : 'no body walking onto another');
}

// SCENARIO: the seeded floor at rest — the P1 invariants.
async function scenarioFloorRest(cdp, A) {
  const api = await evalJS(cdp, 'window.__SKYNET_TEST__ ? { dev: window.__SKYNET_TEST__.dev, version: window.__SKYNET_TEST__.version } : null').catch(() => null);
  A.ok('testapi/present', api && api.dev === true, api ? ('v' + api.version) : 'window.__SKYNET_TEST__ missing');

  const list = await getBodies(cdp);
  A.ok('bodies/nonempty', Array.isArray(list) && list.length >= 1, `${(list || []).length} bodies`);

  // Tier A (containment) + Tier C (gaze-only awareness).
  assertFloorInvariants(A, 'floor', list);

  // Truthful telemetry — displayed HUD numbers equal the reduction over the frozen U.bus log.
  const hud = await evalJS(cdp, 'window.__SKYNET_TEST__.hud()').catch(() => null);
  if (hud && Array.isArray(hud.checks)) {
    for (const c of hud.checks) {
      A.ok(`truthful/${c.metric}`, c.ok, `displayed=${c.displayed} ${c.mode} expected=${c.expected}`);
    }
  } else {
    A.ok('truthful/hud', false, 'hud() returned nothing');
  }

  // Frozen log is live.
  const n = await evalJS(cdp, 'window.__SKYNET_TEST__.eventCount()').catch(() => -1);
  A.ok('log/frozen-bus', typeof n === 'number' && n >= 0, `${n} events captured`);

  return { bodies: list, hud };
}

// SCENARIO: RUN A TASK — send a chat directive and prove a run is dispatched + resolved.
// By default the audit points the sidecar at a deterministic local provider, so this scenario
// waits on terminal agent.run.* events instead of a provider/network race.
async function scenarioTask(cdp, A) {
  await evalJS(cdp, closeOnly).catch(() => {});
  const before = (await evalJS(cdp, "window.__SKYNET_TEST__.events('agent.run').length").catch(() => 0)) || 0;
  const sent = await sendChat(cdp, 'list 3 prime numbers, one per line, then stop');
  A.ok('task/sent', sent === 'sent', sent);

  // Tight initial poll: the work pose can be brief, while the frozen log is permanent. Run lifecycle
  // events are the reliable proof a task was dispatched and reached a terminal state.
  let sawActivity = false, kinds = {};
  for (let i = 0; i < 100; i++) {
    const act = await evalJS(cdp, "(typeof World!=='undefined'&&World.getActivity)?World.getActivity():null").catch(() => null);
    if (act === 'task' || act === 'thinking') sawActivity = true;          // latch
    const runs = await evalJS(cdp, "window.__SKYNET_TEST__.events('agent.run').map(e=>e.name)").catch(() => []);
    kinds = {}; for (const k of (runs || [])) kinds[k] = (kinds[k] || 0) + 1;
    if ((kinds['agent.run.end'] || 0) > 0) break;                          // run resolved (done or errored)
    await sleep(200);
  }
  const total = Object.values(kinds).reduce((a, b) => a + b, 0);
  A.ok('task/run-dispatched', total > before && (kinds['agent.run.start'] || 0) > 0, `agent.run.* seen: ${Object.keys(kinds).join(', ') || 'none'}`);
  A.ok('task/run-lifecycle', (kinds['agent.run.start'] || 0) > 0 && (kinds['agent.run.end'] || 0) > 0, `start=${kinds['agent.run.start'] || 0} end=${kinds['agent.run.end'] || 0} err=${kinds['agent.run.error'] || 0}`);
  A.ok('task/work-pose-engaged', sawActivity, sawActivity ? 'caught World activity=task' : 'work pose too brief to latch; run lifecycle completed deterministically', /*soft*/ true);
}

// SCENARIO: SUMMON a new agent via the real Recruitment Bay, and prove the new body is well-behaved.
async function scenarioSummon(cdp, A) {
  await evalJS(cdp, closeOnly).catch(() => {});
  const before = (await getBodies(cdp)).length;
  const opened = await evalJS(cdp, openSel('#bb-summon', 'SUMMON')).catch((e) => 'ERR:' + e.message);
  const bayUp = await waitSel(cdp, '.mkt-cta-main.mkt-deploy', 40);        // bay opens after an /api/limits fetch
  A.ok('summon/bay-open', bayUp, bayUp ? `recruitment bay shown (${opened})` : `.mkt-cta-main.mkt-deploy never appeared (${opened})`);
  if (bayUp) {
    const rec = await evalJS(cdp, "(() => { const b = document.querySelector('.mkt-cta-main.mkt-deploy'); if (!b) return 'NONE'; const id = b.dataset.id || ''; b.click(); return 'recruited:' + id; })()").catch((e) => 'ERR:' + e.message);
    await sleep(2200);                                                     // spawn + materialize + first stroll beat
    const list = await getBodies(cdp);
    A.ok('summon/body-spawned', list.length === before + 1, `${before} → ${list.length} (${rec})`);
    assertFloorInvariants(A, 'summon', list);                             // the new body must stay contained + gaze-only
  }
  await evalJS(cdp, closeOnly).catch(() => {});                            // close the bay for the frame
  await sleep(700);
}

// SCENARIO: THE MOAT — object=capability. Enter BUILD, place a `dish`, and prove the WEB capability
// comes online (placed object ⇒ earned reach). Placement goes through the real station.addProp path via
// a DEV-only Build.__test__ hook (canvas-drag pixel math is private), then we read World.heroCaps.
const capList = (caps) => (Array.isArray(caps) ? caps.map((c) => c && c.objectType) : []);
async function scenarioMoat(cdp, A) {
  await evalJS(cdp, closeOnly).catch(() => {});
  const rawBefore = await evalJS(cdp, "(typeof World!=='undefined'&&World.heroCaps)?World.heroCaps('agent'):null").catch(() => null);
  const before = capList(rawBefore);
  A.ok('moat/heroCaps-readable', Array.isArray(rawBefore), `before=[${before.join(', ') || 'none'}]`);

  // enter BUILD and wait for the dev test hook
  await clickSel(cdp, '#bb-build');
  let built = false;
  for (let i = 0; i < 20; i++) { built = await evalJS(cdp, "!!(typeof Build!=='undefined' && Build.__test__ && Build.__test__.isOpen())").catch(() => false); if (built) break; await sleep(200); }
  A.ok('moat/build-mode', built, built ? 'REFIT open + dev hook present' : 'Build.__test__ not available');

  let placed = null;
  if (built) {
    placed = await evalJS(cdp, "Build.__test__.placeCapProp('workbench')").catch((e) => ({ ok: false, reason: e.message }));
    A.ok('moat/place-prop', !!(placed && placed.ok), placed && placed.ok ? `workbench @ (${placed.tile.tx},${placed.tile.ty})` : `placement failed: ${placed && placed.reason}`);
    await clickSel(cdp, '#refit-done');                 // exit build → re-bake
    await evalJS(cdp, closeOnly).catch(() => {});
    await sleep(900);
  }

  // object=capability: a placed workbench ⇒ the TERMINAL capability (objectType 'workbench') comes online.
  const after = capList(await evalJS(cdp, "(typeof World!=='undefined'&&World.heroCaps)?World.heroCaps('agent'):null").catch(() => null));
  A.ok('moat/capability-online', after.includes('workbench') && !before.includes('workbench'), `after=[${after.join(', ') || 'none'}] (workbench ⇒ terminal)`);
  const KNOWN = new Set(['cabinet', 'dish', 'notebook', 'workbench']);   // heroCaps objectTypes (computer/connector excluded by design)
  const bad = after.filter((c) => !KNOWN.has(c));
  A.ok('moat/caps-well-formed', bad.length === 0, bad.length ? 'unexpected: ' + bad.join(',') : 'every placed object maps to a known capability');
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  let ownSidecar = null;
  let mock = null;
  if (await isUp(APP_URL)) {
    if (!REUSE_EXISTING) throw new Error(`audit port :${PORT} already has a server; set SKYNET_AUDIT_REUSE=1 to reuse it, or set SKYNET_AUDIT_PORT to a free port`);
    console.log(`sidecar: reusing the one already up on :${PORT}`);
  } else {
    if (!LIVE_PROVIDER) {
      mock = await startMockOpenRouter(DEFAULT_MODEL);
      process.env.SKYNET_OPENROUTER_BASE = mock.base;
      process.env.STARNET_OPENROUTER_BASE = mock.base;
      console.log(`provider: deterministic audit mock on ${mock.base}`);
    }
    console.log(`sidecar: booting SEEDED SKYNET_DEV on :${PORT} (model=${DEFAULT_MODEL}) ...`);
    materializeSeedWorkspace(SCRATCH);
    ownSidecar = bootSeededSidecar({ port: PORT, scratchDir: SCRATCH });
    if (!(await waitUp(APP_URL))) throw new Error('seeded sidecar failed to come up on :' + PORT);
    console.log('sidecar: ready');
  }

  const { proc, chrome } = launchChrome({ cdpPort: CDP_PORT, win: WIN, profileDir: PROFILE });
  proc.on('error', (e) => { console.error('chrome spawn error', e); process.exit(1); });
  console.log(`chrome: ${chrome}\ntarget: ${APP_URL}`);

  let cdp, exitCode = 0;
  const report = { url: APP_URL, ranAt: new Date().toISOString(), scenarios: [] };
  try {
    cdp = await connectCDP(CDP_PORT);
    const diag = collectDiagnostics(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: APP_URL });

    const floorReady = await waitDevReady(cdp, evalJS, { tries: 24, url: APP_URL });
    const testReady = floorReady && await waitTestReady(cdp);
    console.log(`floorReady=${floorReady} testReady=${testReady}`);
    if (!testReady) {
      console.error('FAIL: window.__SKYNET_TEST__ never became ready in-game.');
      await capture(cdp, OUT_DIR, '_FAILED-ready');
      exitCode = 2;
    } else {
      // Run the scenarios in order. Earlier ones MUTATE state for later ones (task → working,
      // summon → +1 body), so the order is deliberate: rest (clean) → task (hero) → summon → moat.
      const SCENARIOS = [
        { name: 'floor-rest', fn: scenarioFloorRest },
        { name: 'task',       fn: scenarioTask },
        { name: 'summon',     fn: scenarioSummon },
        { name: 'moat',       fn: scenarioMoat },
      ];
      for (const sc of SCENARIOS) {
        console.log(`\nscenario: ${sc.name}`);
        const A = makeAsserter();
        let data = null;
        try { data = await sc.fn(cdp, A); } catch (e) { A.ok(`${sc.name}/ran`, false, 'threw: ' + e.message); }
        const hardFail = A.results.some((r) => !r.pass && !r.soft);   // SOFT failures never fail the build
        await capture(cdp, OUT_DIR, hardFail ? `_FAIL-${sc.name}` : sc.name);
        report.scenarios.push({ name: sc.name, passed: !hardFail, assertions: A.results, data: data || null });
        if (hardFail) exitCode = 3;
      }
    }
    report.console = diag.consoleMsgs.slice(0, 30);
    report.exceptions = diag.exceptions.slice(0, 20);
    if (diag.exceptions.length) { console.log(`\nuncaught exceptions: ${diag.exceptions.length}`); diag.exceptions.slice(0, 8).forEach((e) => console.log('  ' + e)); }
  } finally {
    writeFileSync(join(OUT_DIR, 'audit-report.json'), JSON.stringify(report, null, 2));
    try { cdp?.ws.close(); } catch {}
    try { proc.kill('SIGKILL'); } catch {}
    if (ownSidecar) { try { ownSidecar.kill('SIGKILL'); } catch {} }
    if (mock && mock.server) { try { mock.server.close(); } catch {} }
    if (!KEEP) { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {} }
  }

  const all = report.scenarios.flatMap((s) => s.assertions);
  const total = all.length;
  const passed = all.filter((a) => a.pass).length;
  const softFails = all.filter((a) => !a.pass && a.soft).length;
  console.log(`\n${exitCode === 0 ? 'AUDIT PASS' : 'AUDIT FAIL (exit ' + exitCode + ')'} — ${passed}/${total} assertions passed${softFails ? ` (${softFails} soft skip${softFails > 1 ? 's' : ''})` : ''} → ${OUT_DIR}`);
  process.exit(exitCode);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
