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
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sleep, launchChrome, connectCDP, evalJS, capture, collectDiagnostics } from './lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, isUp, waitUp, waitDevReady, DEFAULT_MODEL } from './lib/seed.mjs';

const PORT = process.env.SKYNET_AUDIT_PORT || '8934';
const CDP_PORT = Number(process.env.SKYNET_AUDIT_CDP || 9334);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const OUT_DIR = process.env.SKYNET_AUDIT_DIR || join(process.cwd(), '.uiaudit');
const WIN = process.env.SKYNET_SHOT_SIZE || '1440,900';
const KEEP = process.argv.includes('--keep');
const SCRATCH = join(OUT_DIR, '_seed-workspace');
const PROFILE = join(OUT_DIR, '_profile');

// Wait until the DEV test probe is armed AND reports in-game.
async function waitTestReady(cdp, tries = 24) {
  for (let i = 0; i < tries; i++) {
    const ok = await evalJS(cdp, '!!(window.__SKYNET_TEST__ && window.__SKYNET_TEST__.ready())').catch(() => false);
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

// tiny assertion recorder
function makeAsserter() {
  const results = [];
  const ok = (name, pass, detail) => { results.push({ name, pass: !!pass, detail: detail || '' }); console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); return !!pass; };
  return { ok, results };
}

// SCENARIO: the seeded floor at rest — the P1 invariants.
async function scenarioFloorRest(cdp, A) {
  const api = await evalJS(cdp, 'window.__SKYNET_TEST__ ? { dev: window.__SKYNET_TEST__.dev, version: window.__SKYNET_TEST__.version } : null').catch(() => null);
  A.ok('testapi/present', api && api.dev === true, api ? ('v' + api.version) : 'window.__SKYNET_TEST__ missing');

  const bodies = await evalJS(cdp, 'window.__SKYNET_TEST__.bodies()').catch(() => []);
  A.ok('bodies/nonempty', Array.isArray(bodies) && bodies.length >= 1, `${(bodies || []).length} bodies`);

  const placed = (bodies || []).filter((b) => !b.unplaced);
  // Tier A — every placed body idles inside its own zone.
  const outOfZone = placed.filter((b) => b.inOwnZone === false);
  A.ok('tierA/idle-in-own-zone', outOfZone.length === 0,
    outOfZone.length ? outOfZone.map((b) => `${b.name}@(${b.tile.x},${b.tile.y}) zone=${b.zone ? b.zone.kind : 'null'}`).join('; ') : `${placed.length} placed bodies all in-zone`);

  // Tier C — awareness is gaze-only: no body is WALKING toward another body's current tile.
  const tileKey = (t) => t ? `${t.x},${t.y}` : '';
  const occupied = new Set(placed.map((b) => tileKey(b.tile)));
  const chasing = placed.filter((b) => b.moving && b.target && occupied.has(tileKey(b.target.tile)) && tileKey(b.target.tile) !== tileKey(b.tile));
  A.ok('tierC/awareness-gaze-only', chasing.length === 0,
    chasing.length ? chasing.map((b) => `${b.name} → ${tileKey(b.target.tile)}`).join('; ') : 'no body walking onto another body');

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

  return { bodies, hud };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  let ownSidecar = null;
  if (await isUp(APP_URL)) {
    console.log(`sidecar: reusing the one already up on :${PORT}`);
  } else {
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
      console.log('\nscenario: floor-rest');
      const A = makeAsserter();
      const data = await scenarioFloorRest(cdp, A);
      const passed = A.results.every((r) => r.pass);
      await capture(cdp, OUT_DIR, passed ? 'floor-rest' : '_FAIL-floor-rest');
      report.scenarios.push({ name: 'floor-rest', passed, assertions: A.results, bodies: data.bodies, hud: data.hud });
      if (!passed) exitCode = 3;
    }
    report.console = diag.consoleMsgs.slice(0, 30);
    report.exceptions = diag.exceptions.slice(0, 20);
    if (diag.exceptions.length) { console.log(`\nuncaught exceptions: ${diag.exceptions.length}`); diag.exceptions.slice(0, 8).forEach((e) => console.log('  ' + e)); }
  } finally {
    writeFileSync(join(OUT_DIR, 'audit-report.json'), JSON.stringify(report, null, 2));
    try { cdp?.ws.close(); } catch {}
    try { proc.kill('SIGKILL'); } catch {}
    if (ownSidecar) { try { ownSidecar.kill('SIGKILL'); } catch {} }
    if (!KEEP) { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {} }
  }

  const total = report.scenarios.reduce((n, s) => n + s.assertions.length, 0);
  const failed = report.scenarios.reduce((n, s) => n + s.assertions.filter((a) => !a.pass).length, 0);
  console.log(`\n${exitCode === 0 ? 'AUDIT PASS' : 'AUDIT FAIL (exit ' + exitCode + ')'} — ${total - failed}/${total} assertions passed → ${OUT_DIR}`);
  process.exit(exitCode);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
