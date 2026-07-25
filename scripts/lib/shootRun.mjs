// scripts/lib/shootRun.mjs — the shared in-game capture run used by both `npm run shoot`
// (scripts/shoot.mjs) and the legacy scripts/uishoot.mjs alias. ONE implementation so the
// seeded-boot + cold-boot-race guard + selector list never drift between two entrypoints.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sleep, launchChrome, connectCDP, evalJS, capture, collectDiagnostics } from './cdp.mjs';
import { buildStates } from './states.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, isUp, waitUp, waitDevReady, DEFAULT_MODEL } from './seed.mjs';

// opts: { port, cdpPort, outDir, win, only, keep }
// Returns an exit code: 0 all-ok · 2 never reached the floor · 3 a panel failed to open · 1 fatal.
export async function runShoot({ port, cdpPort, outDir, win = '1440,900', only = null, keep = false }) {
  const APP_URL = `http://127.0.0.1:${port}/`;
  const SCRATCH = join(outDir, '_seed-workspace');
  const PROFILE = join(outDir, '_profile');
  mkdirSync(outDir, { recursive: true });

  // 1. Ensure a SEEDED sidecar is serving the port (reuse if up, else boot one we own).
  let ownSidecar = null;
  if (await isUp(APP_URL)) {
    console.log(`sidecar: reusing the one already up on :${port}`);
  } else {
    console.log(`sidecar: booting SEEDED SKYNET_DEV on :${port} (model=${DEFAULT_MODEL}) ...`);
    materializeSeedWorkspace(SCRATCH);
    ownSidecar = bootSeededSidecar({ port, scratchDir: SCRATCH });
    if (!(await waitUp(APP_URL))) throw new Error('seeded sidecar failed to come up on :' + port);
    console.log('sidecar: ready');
  }

  // 2. Launch Chrome + connect CDP.
  const { proc, chrome } = launchChrome({ cdpPort, win, profileDir: PROFILE });
  proc.on('error', (e) => { console.error('chrome spawn error', e); process.exit(1); });
  console.log(`chrome: ${chrome}`);
  console.log(`target: ${APP_URL}`);

  let cdp, exitCode = 0;
  const manifest = { port: String(port), url: APP_URL, capturedAt: new Date().toISOString(), states: [] };
  try {
    cdp = await connectCDP(cdpPort);
    const diag = collectDiagnostics(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 3. Navigate + wait until verifiably IN-GAME (defeats the cold-boot title-screen race).
    console.log('navigating + booting to the floor...');
    await cdp.send('Page.navigate', { url: APP_URL });
    const ready = await waitDevReady(cdp, evalJS, { tries: 24, url: APP_URL });
    const dev = await evalJS(cdp, '!!window.__STARNET_DEV__').catch(() => false);
    const screen = await evalJS(cdp, `(document.querySelector('.screen.active')||{}).id || '?'`).catch(() => '?');
    console.log(`  dev=${dev} activeScreen=${screen} ready=${ready}`);
    manifest.ready = ready; manifest.dev = dev; manifest.activeScreen = screen;
    if (!ready) {
      console.error('FAIL: never reached the in-game floor (still on ' + screen + ').');
      await capture(cdp, outDir, '_FAILED-boot');
      exitCode = 2;
    } else {
      // 4. Capture every state.
      const states = buildStates();
      for (const st of states) {
        if (only && st.name !== only) continue;
        let driveResult = 'n/a';
        if (st.drive) { try { driveResult = await evalJS(cdp, st.drive); } catch (e) { driveResult = 'DRIVE_ERR:' + e.message; } }
        await sleep(st.wait ?? 1400);
        // Golden frames represent durable panel layout, not timing-dependent transient toasts.
        // A BUILD STATION close emits "Station layout saved"; depending on capture speed it used
        // to overlap a later panel and poison the blessed signature. Remove only the ephemeral DOM
        // stack immediately before capture; persistent notification records remain untouched.
        // Also FINISH any still-running CSS animation before the frame is read. The card family
        // (motion.css `cardIn`) enters with a per-index stagger of up to ~540ms, and a panel that
        // opens slowly can leave cards mid-entrance when the fixed wait expires — so the capture
        // lands at a random point on the animation curve. That made build-skills nondeterministic
        // across three consecutive runs at ONE commit (diff 2.37 / 0.05 / 1.52 against a 1.5
        // threshold): the visual gate failed at random and trained everyone to ignore it. Snapping
        // animations to their end state is the fix — widening the threshold past 2.4 would have
        // blinded the gate to real regressions, which start around 2.0.
        try {
          await evalJS(cdp, `(() => {
            const s = document.getElementById('toast-stack'); if (s) s.remove();
            let n = 0;
            try { for (const a of document.getAnimations()) { try { a.finish(); n++; } catch (_) {} } } catch (_) {}
            return 'toasts-cleared, animations-finished:' + n;
          })()`);
        } catch {}
        const { kb } = await capture(cdp, outDir, st.name);
        const bad = /^(NOTFOUND|CLICK_ERR|DRIVE_ERR)/.test(String(driveResult));
        if (bad) exitCode = 3;
        console.log(`  ${bad ? 'FAIL' : 'ok  '} ${st.name.padEnd(16)} ${String(kb).padStart(4)}KB  ${driveResult}`);
        manifest.states.push({ name: st.name, kb, driveResult, ok: !bad });
      }
    }

    manifest.console = diag.consoleMsgs.slice(0, 30);
    manifest.exceptions = diag.exceptions.slice(0, 20);
    if (diag.exceptions.length) { console.log(`\nuncaught exceptions: ${diag.exceptions.length}`); diag.exceptions.slice(0, 8).forEach(e => console.log('  ' + e)); }
  } finally {
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    try { cdp?.ws.close(); } catch {}
    try { proc.kill('SIGKILL'); } catch {}
    if (ownSidecar) { try { ownSidecar.kill('SIGKILL'); } catch {} }
    if (!keep) { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {} }
  }

  console.log(`\n${exitCode === 0 ? 'DONE (all states ok)' : 'DONE WITH FAILURES (exit ' + exitCode + ')'} → ${outDir}`);
  return exitCode;
}
