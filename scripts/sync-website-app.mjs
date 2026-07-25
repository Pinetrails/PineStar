#!/usr/bin/env node
/*
 * sync-website-app.mjs — mirror frontend/ into website/app/ (`npm run sync:website`)
 *
 * WHY THIS EXISTS. website/app is the live demo embedded on starnetos.com, and both
 * website/app/demo-boot.js and website/live-preview.js describe it as "a verbatim copy of the app
 * frontend". It was not one. On 2026-07-24 the copy had drifted to 59 differing files and 394 files
 * missing outright — a months-old snapshot still advertising retired copy ("IMPORT AGENT" for a
 * button the app renamed to "RESTORE BACKUP", a provider picker with no grok/kimi). A marketing
 * surface that misrepresents the shipped product is a truthfulness bug, not a housekeeping chore,
 * and hand-patching whichever files a lane happened to touch is how it drifted in the first place.
 *
 * So the copy is now GENERATED, never edited, and test/website-app-sync.test.js runs `--check` in
 * the fast gate: any lane that changes frontend/ and forgets to re-sync fails immediately.
 *
 * THE EMBED IS NOT A PURE COPY. Three differences are deliberate and are re-applied here every run,
 * so they can never be lost to a sync and never rot into "mystery local edits":
 *   1. website-only files (demo.css, demo-boot.js) are preserved and never sourced from frontend/;
 *   2. the secondary Google Fonts <link> is stripped — the public site promises ZERO third-party
 *      requests, and VT323 already ships locally as a woff2, so the embed loses nothing;
 *   3. demo.css + demo-boot.js are injected immediately BEFORE the first app script, because
 *      demo-boot seeds the captured save and must run ahead of any store read.
 * Every anchor below is asserted. If the markup moves, this fails loudly rather than silently
 * emitting an embed that phones out to Google or boots with no demo save.
 *
 * Usage:
 *   node scripts/sync-website-app.mjs           # write the mirror
 *   node scripts/sync-website-app.mjs --check   # verify only; exit 1 (and list drift) if stale
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'frontend');
const DEST = join(ROOT, 'website', 'app');
const CHECK = process.argv.includes('--check');

// Files that live ONLY in the embed. Never deleted, never taken from frontend/.
const WEBSITE_ONLY = new Set(['demo-boot.js', 'demo.css']);

const EMBED_FONT_COMMENT =
  '<!-- VT323 ships LOCALLY via @font-face in css/style.css (assets/fonts/vt323.woff2, SIL OFL).\n' +
  '     WEBSITE EMBED ONLY: the app\'s secondary Google Fonts link is removed here — the public\n' +
  '     site promises zero third-party requests, and the local woff2 fully covers the embed. -->';
const EMBED_TAGS =
  '<link rel="stylesheet" href="demo.css"><!-- WEBSITE EMBED ONLY: half-strength glass for the downscaled iframe -->\n' +
  '<script src="demo-boot.js"></script><!-- WEBSITE EMBED ONLY: seeds the captured demo save + DEV seam before any store reads -->';

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

function fail(msg) { console.error('sync-website-app: ' + msg); process.exit(1); }

// The one transformed file. Pure function of the frontend source, so --check can recompute it.
function embedIndexHtml(src) {
  let out = src;

  // 1. Drop the secondary Google Fonts link + its now-wrong comment.
  const fontBlock = /<!-- VT323 \(the house typeface\)[\s\S]*?<link href="https:\/\/fonts\.googleapis\.com[^>]*>\n/;
  if (!fontBlock.test(out)) fail('index.html: the VT323/Google-Fonts block anchor was not found — re-check the transform against frontend/index.html');
  out = out.replace(fontBlock, EMBED_FONT_COMMENT + '\n');
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(out)) {
    fail('index.html: a third-party font request survived the strip — the public site promises zero third-party requests');
  }

  // 2. Inject the embed tags before the FIRST app script (demo-boot must precede any store read).
  const firstApp = out.indexOf('<script src="app/');
  if (firstApp < 0) fail('index.html: no <script src="app/..."> found — cannot place demo-boot ahead of the first store read');
  out = out.slice(0, firstApp) + EMBED_TAGS + '\n' + out.slice(firstApp);
  return out;
}

function expectedFor(rel) {
  const raw = readFileSync(join(SRC, rel));
  return rel === 'index.html' ? Buffer.from(embedIndexHtml(raw.toString('utf8')), 'utf8') : raw;
}

const srcFiles = walk(SRC);
const destFiles = new Set(walk(DEST));
const written = [];
const stale = [];
const removed = [];

for (const rel of srcFiles) {
  if (WEBSITE_ONLY.has(rel)) fail('frontend/' + rel + ' collides with a website-only file — rename one of them');
  const want = expectedFor(rel);
  const target = join(DEST, rel);
  let same = false;
  if (destFiles.has(rel)) { try { same = readFileSync(target).equals(want); } catch (_) { same = false; } }
  if (same) continue;
  stale.push(rel);
  if (!CHECK) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, want); written.push(rel); }
}

// Anything in the embed that frontend no longer ships (and isn't embed-only) is stale weight.
const srcSet = new Set(srcFiles);
for (const rel of destFiles) {
  if (srcSet.has(rel) || WEBSITE_ONLY.has(rel)) continue;
  removed.push(rel);
  if (!CHECK) { try { rmSync(join(DEST, rel)); } catch (_) {} }
}

for (const only of WEBSITE_ONLY) {
  if (!destFiles.has(only)) fail('website/app/' + only + ' is missing — the embed cannot boot without it');
}

if (CHECK) {
  const drift = stale.length + removed.length;
  if (!drift) { console.log('website-app-sync: OK — website/app matches frontend (' + srcFiles.length + ' files + ' + WEBSITE_ONLY.size + ' embed-only)'); process.exit(0); }
  console.error('website-app-sync: STALE — website/app has drifted from frontend/');
  for (const f of stale.slice(0, 20)) console.error('  differs/missing: ' + f);
  if (stale.length > 20) console.error('  ...and ' + (stale.length - 20) + ' more');
  for (const f of removed.slice(0, 10)) console.error('  no longer in frontend: ' + f);
  if (removed.length > 10) console.error('  ...and ' + (removed.length - 10) + ' more');
  console.error('Run: npm run sync:website');
  process.exit(1);
}

console.log('website-app-sync: wrote ' + written.length + ' file(s), removed ' + removed.length +
  ' (mirrored ' + srcFiles.length + ' from frontend/, preserved ' + WEBSITE_ONLY.size + ' embed-only)');
