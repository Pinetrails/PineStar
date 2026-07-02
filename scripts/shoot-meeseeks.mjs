#!/usr/bin/env node
// scripts/shoot-meeseeks.mjs — DEV-ONLY visual proof for the Meeseeks sub-agent helper sprites
// (G4 feature 3 / P2-A). Boots a SEEDED SKYNET_DEV sidecar, lands on the live floor, then INJECTS
// SYNTHETIC `task` events (kind:'subagent') straight onto the page's U.bus — the exact payload
// shape sidecar/subagents.js emits ({ id, agentId, status, kind:'subagent', title }). The frontend
// ledger (subagentsprites.js) folds them and world.js draws one small translucent helper per live
// sub-agent near the LEAD's desk; on a terminal event each dissolves in an amber-cyan poof.
//
// It captures three frames so a human/agent can EYEBALL the lifecycle:
//   1. meeseeks-0-none    — floor at rest, zero helpers (truthful baseline)
//   2. meeseeks-1-live    — N running sub-agents → N helper sprites materialized near the desk
//   3. meeseeks-2-dissolve— sub-agents completed → helpers mid-poof (fading out)
//
// This ONLY emits on the browser's own event bus (the same one a real team.spawn drives); it never
// touches server state and is gated behind the dev seed. Production stays truthful — a helper can
// only ever appear for a live sub-agent because the ledger fold is the single source of the set.
//
// Usage:  SKYNET_MS_PORT=8960 SKYNET_MS_CDP=9360 node scripts/shoot-meeseeks.mjs
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sleep, launchChrome, connectCDP, evalJS, capture, collectDiagnostics } from './lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, isUp, waitUp, waitDevReady, DEFAULT_MODEL } from './lib/seed.mjs';

const PORT = process.env.SKYNET_MS_PORT || '8960';
const CDP_PORT = Number(process.env.SKYNET_MS_CDP || 9360);
const OUT = process.env.SKYNET_MS_DIR || join(process.cwd(), '.uishots-meeseeks');
const WIN = process.env.SKYNET_MS_SIZE || '1440,900';
const KEEP = process.argv.includes('--keep');
const APP_URL = `http://127.0.0.1:${PORT}/`;
const SCRATCH = join(OUT, '_seed-workspace');
const PROFILE = join(OUT, '_profile');

// Capture a magnified CLIP around a screen rect — the helper sprites are ~9px, so a full frame
// buries them. rect is {x,y,width,height} in CSS px; scale magnifies (deviceScaleFactor).
async function captureClip(cdp, outDir, name, rect, scale = 5) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale } });
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(join(outDir, `${name}.png`), buf);
  return { kb: Math.round(buf.length / 1024) };
}

// Emit a batch of synthetic subagent lifecycle events onto the live U.bus, exactly as
// sidecar/subagents.js does. `n` running helpers, all attributed to the hero (leadId defaults
// to the hero in world.js's fold call, so no agentId targeting is needed). Returns a probe of
// the ledger's live count so we can assert the fold actually took.
const emitSubagents = (n, status) => `(() => {
  if (typeof U === 'undefined' || !U.bus) return { err: 'no U.bus' };
  // the hero id, so the event's agentId matches a real body (leadId is resolved to the hero inside
  // world.js's fold call regardless, but keep the payload faithful to what subagents.js emits).
  let heroId = 'agent';
  try { const bs = (window.World && World.bodies) ? World.bodies() : []; const h = bs.find(b => b.hero); if (h) heroId = h.id; } catch (_) {}
  const ids = [];
  for (let i = 0; i < ${n}; i++) {
    const id = 'sub-proof-' + i;
    ids.push(id);
    U.bus.emit('task', { id, agentId: heroId, status: ${JSON.stringify(status)}, kind: 'subagent', title: 'proof subtask ' + (i + 1) });
  }
  return { emitted: ids.length, status: ${JSON.stringify(status)}, heroId };
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  let ownSidecar = null;
  if (await isUp(APP_URL)) {
    console.log(`sidecar: reusing one already up on :${PORT}`);
  } else {
    console.log(`sidecar: booting SEEDED SKYNET_DEV on :${PORT} (model=${DEFAULT_MODEL}) ...`);
    materializeSeedWorkspace(SCRATCH);
    ownSidecar = bootSeededSidecar({ port: PORT, scratchDir: SCRATCH });
    if (!(await waitUp(APP_URL))) throw new Error('seeded sidecar failed to come up on :' + PORT);
    console.log('sidecar: ready');
  }

  const { proc } = launchChrome({ cdpPort: CDP_PORT, win: WIN, profileDir: PROFILE });
  proc.on('error', (e) => { console.error('chrome spawn error', e); });
  let cdp, exitCode = 0;
  const manifest = { port: String(PORT), url: APP_URL, capturedAt: new Date().toISOString(), frames: [] };
  try {
    cdp = await connectCDP(CDP_PORT);
    const diag = collectDiagnostics(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('navigating + booting to the floor...');
    await cdp.send('Page.navigate', { url: APP_URL });
    const ready = await waitDevReady(cdp, evalJS, { tries: 24, url: APP_URL });
    manifest.ready = ready;
    if (!ready) {
      console.error('FAIL: never reached the in-game floor.');
      await capture(cdp, OUT, 'meeseeks-_FAILED-boot');
      exitCode = 2;
    } else {
      // The 9px translucent helpers are tiny at 1440x900, so also grab a magnified CLIP around the
      // hero. Compute the hero's on-screen center rect once (canvas-space -> CSS px via bodies()).
      const heroBox = await evalJS(cdp, `(() => {
        try {
          const bs = (window.World && World.bodies) ? World.bodies() : [];
          const h = bs.find(b => b.hero); const cv = document.querySelector('#screen-game canvas') || document.querySelector('canvas');
          if (!h || !cv) return null;
          const rect = cv.getBoundingClientRect();
          // hero px are canvas-internal; the seeded lone floor keeps the hero centered, so derive a
          // clip window from the canvas rect proportion around the drawn body (px/py map through the
          // internal->CSS scale). We over-size the window so helpers around the feet are included.
          const kx = rect.width / cv.width, ky = rect.height / cv.height;
          const cx = rect.left + h.px * kx, cy = rect.top + h.py * ky;
          // the helpers cluster around the hero's FEET/body (drawn a bit below the body origin), and
          // the body itself sits low in the canvas transform — bias the window DOWN so hero+helpers
          // are centered, not the desk prop above them.
          const w = 120, hgt = 120;
          return { x: Math.max(0, cx - w/2), y: Math.max(0, cy - hgt/2 + 40), width: w, height: hgt, cx, cy };
        } catch (e) { return { err: String(e) }; }
      })()`).catch(e => ({ err: e.message }));
      const clip = (heroBox && heroBox.width) ? heroBox : { x: 560, y: 260, width: 180, height: 180 };
      const probe = () => evalJS(cdp, `(() => { try { const d = World.dbg(); return (d && typeof d.helpers === 'number') ? d.helpers : 'NULLDBG'; } catch (e) { return 'ERR:' + e.message; } })()`).catch((e) => 'EVALERR:' + e.message);

      // 0. baseline — no helpers
      await sleep(1200);
      const h0 = await probe();
      let r = await capture(cdp, OUT, 'meeseeks-0-none');
      await captureClip(cdp, OUT, 'meeseeks-0-none.clip', clip);
      console.log(`  ok   meeseeks-0-none      ${r.kb}KB  helpers=${h0} (baseline)`);
      manifest.frames.push({ name: 'meeseeks-0-none', kb: r.kb, helpers: h0 });

      // 1. spawn 4 running sub-agents -> 4 helper sprites materialize near the desk
      const emit1 = await evalJS(cdp, emitSubagents(4, 'running')).catch(e => ({ err: e.message }));
      await sleep(1500);   // let materialize (~520ms) finish + a few flicker frames
      const h1 = await probe();
      r = await capture(cdp, OUT, 'meeseeks-1-live');
      await captureClip(cdp, OUT, 'meeseeks-1-live.clip', clip);
      const live_ok = h1 === 4;
      console.log(`  ${live_ok ? 'ok  ' : 'FAIL'} meeseeks-1-live      ${r.kb}KB  helpers=${h1} (want 4)  emit=${JSON.stringify(emit1)}`);
      manifest.frames.push({ name: 'meeseeks-1-live', kb: r.kb, helpers: h1, want: 4, ok: live_ok });
      if (!live_ok) exitCode = 3;

      // 2. complete them -> helpers begin the dissolve poof (captured mid-fade)
      const emit2 = await evalJS(cdp, emitSubagents(4, 'done')).catch(e => ({ err: e.message }));
      await sleep(300);   // DISSOLVE_MS=640 — grab it while still visibly fading
      const h2 = await probe();
      r = await capture(cdp, OUT, 'meeseeks-2-dissolve');
      await captureClip(cdp, OUT, 'meeseeks-2-dissolve.clip', clip);
      console.log(`  ok   meeseeks-2-dissolve  ${r.kb}KB  helpers=${h2} (dissolving)  emit=${JSON.stringify(emit2)}`);
      manifest.frames.push({ name: 'meeseeks-2-dissolve', kb: r.kb, helpers: h2 });

      // 3. after the dissolve fully completes, confirm the floor returns to zero helpers
      await sleep(1200);
      const h3 = await probe();
      r = await capture(cdp, OUT, 'meeseeks-3-gone');
      await captureClip(cdp, OUT, 'meeseeks-3-gone.clip', clip);
      const gone_ok = (h3 === 0);
      console.log(`  ${gone_ok ? 'ok  ' : 'FAIL'} meeseeks-3-gone      ${r.kb}KB  helpers=${h3} (want 0)`);
      manifest.frames.push({ name: 'meeseeks-3-gone', kb: r.kb, helpers: h3, want: 0, ok: gone_ok });
      if (!gone_ok) exitCode = 3;
    }

    manifest.console = diag.consoleMsgs.slice(0, 30);
    manifest.exceptions = diag.exceptions.slice(0, 20);
    if (diag.exceptions.length) { console.log(`\nuncaught exceptions: ${diag.exceptions.length}`); diag.exceptions.slice(0, 8).forEach(e => console.log('  ' + e)); }
  } finally {
    writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
    try { cdp?.ws.close(); } catch {}
    try { proc.kill('SIGKILL'); } catch {}
    if (ownSidecar) { try { ownSidecar.kill('SIGKILL'); } catch {} }
    if (!KEEP) { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {} }
  }
  console.log(`\n${exitCode === 0 ? 'DONE' : 'DONE WITH FAILURES (exit ' + exitCode + ')'} -> ${OUT}`);
  return exitCode;
}

process.exit(await main().catch((e) => { console.error('FATAL', e); return 1; }));
