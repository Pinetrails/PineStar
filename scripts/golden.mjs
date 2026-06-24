#!/usr/bin/env node
// golden.mjs — golden-frame CHANGE DETECTION for StarNet's UI.  (`npm run golden`)
//
// The point (mission DoD #3/#4): a no-code-change re-run is all-PASS with zero human input; a real
// visual change is FLAGGED with the offending frame; and the vision model then judges ONLY the
// flagged frames — never re-judging everything every run.
//
// HOW it tolerates the always-animating floor: it doesn't pixel-diff. It reduces each frame to a
// small downscaled grayscale SIGNATURE (scripts/lib/png.mjs) and compares mean-abs-diff against a
// committed baseline (scripts/goldens.json). Local animation jitter averages out (tiny diff);
// structural change — a panel that moved, a layout break, a colour shift — spikes the diff past the
// threshold. Tune the threshold to sit above the measured animation-noise floor.
//
// Usage:
//   npm run golden:bless     # capture current UI as the baseline (scripts/goldens.json)
//   npm run golden           # capture + diff vs baseline; nonzero exit + list of CHANGED frames
//   SKYNET_GOLDEN_THRESHOLD=8 npm run golden
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShoot } from './lib/shootRun.mjs';
import { fileSignature, sigDiff } from './lib/png.mjs';

const SIG_W = 64, SIG_H = 40;
// mean-abs-diff (0..255). Tuned from measured behavior: the same-state animation-noise floor is
// ~0.0–0.5 (two captures of one state differ only by the wandering agent / pulsing reactor), while
// the SMALLEST real difference between two distinct centred modals is ~2.0 and structural breaks
// (floor↔modal, full-bleed↔centred, a panel that didn't open) are 10–18. 1.5 sits above the noise
// ceiling with margin yet below the smallest real change — biased toward sensitivity (a false flag
// just makes the vision model re-look; a missed regression is the real cost).
const THRESHOLD = Number(process.env.SKYNET_GOLDEN_THRESHOLD || 1.5);
const GOLDENS = join(dirname(fileURLToPath(import.meta.url)), 'goldens.json');
const PORT = process.env.SKYNET_GOLDEN_PORT || '8935';
const CDP_PORT = Number(process.env.SKYNET_GOLDEN_CDP || 9335);
const OUT = process.env.SKYNET_GOLDEN_DIR || join(process.cwd(), '.uigolden');
const BLESS = process.argv.includes('--bless');

async function captureSignatures() {
  const code = await runShoot({ port: PORT, cdpPort: CDP_PORT, outDir: OUT, only: null, keep: false });
  if (code !== 0) throw new Error('capture failed (shoot exit ' + code + ') — fix `npm run shoot` first');
  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
  const sigs = {};
  for (const s of manifest.states) {
    const p = join(OUT, s.name + '.png');
    if (existsSync(p)) sigs[s.name] = Array.from(fileSignature(p, SIG_W, SIG_H));
  }
  return sigs;
}

async function main() {
  const sigs = await captureSignatures();

  if (BLESS) {
    writeFileSync(GOLDENS, JSON.stringify({ w: SIG_W, h: SIG_H, threshold: THRESHOLD, blessedAt: new Date().toISOString(), states: sigs }));
    console.log(`\nblessed ${Object.keys(sigs).length} golden signatures (thr ${THRESHOLD}) → ${GOLDENS}`);
    process.exit(0);
  }

  if (!existsSync(GOLDENS)) { console.error('no baseline — run `npm run golden:bless` first'); process.exit(2); }
  const golden = JSON.parse(readFileSync(GOLDENS, 'utf8'));
  const thr = golden.threshold || THRESHOLD;
  const flagged = [];
  console.log('');
  for (const name of Object.keys(sigs)) {
    const g = golden.states[name];
    if (!g) { console.log(`  NEW      ${name.padEnd(16)} (no golden)`); flagged.push({ name, diff: null, reason: 'new state (no golden)', frame: join(OUT, name + '.png') }); continue; }
    const d = sigDiff(Uint8Array.from(sigs[name]), Uint8Array.from(g));
    const changed = d > thr;
    console.log(`  ${changed ? 'CHANGED' : 'ok     '} ${name.padEnd(16)} diff=${d.toFixed(2)} (thr ${thr})`);
    if (changed) flagged.push({ name, diff: +d.toFixed(2), frame: join(OUT, name + '.png') });
  }
  for (const name of Object.keys(golden.states)) if (!sigs[name]) flagged.push({ name, diff: null, reason: 'missing this run' });

  writeFileSync(join(OUT, 'golden-report.json'), JSON.stringify({ threshold: thr, flaggedCount: flagged.length, flagged }, null, 2));
  if (flagged.length) {
    console.log(`\n${flagged.length} frame(s) CHANGED beyond animation noise — the vision model should read ONLY these:`);
    flagged.forEach((f) => console.log(`  ${f.frame || f.name}  ${f.reason || 'diff=' + f.diff}`));
    process.exit(3);
  }
  console.log('\nGOLDEN PASS — no visual regressions (every frame within the animation-noise threshold)');
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
