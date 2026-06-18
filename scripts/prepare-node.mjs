// scripts/prepare-node.mjs — fetch the Node runtime that ships INSIDE the desktop installer.
//
// Download-blocker A: the Tauri shell used to spawn a bare `node` from the user's PATH, so a clean machine
// with no Node installed got a dead app. We now bundle a Node runtime via Tauri `externalBin`. Tauri expects
// the binary named with the BUILD TARGET TRIPLE (e.g. node-x86_64-pc-windows-msvc.exe) under src-tauri/binaries;
// at `tauri build` it copies the matching one next to the app exe (renamed to plain `node[.exe]`), and main.rs
// spawns THAT instead of PATH. This script fetches the binary so `npm run desktop:build` is one command.
//
// The fetched binary is large (~80MB) and is .gitignored — it's a build input, never committed.
// Run directly: `node scripts/prepare-node.mjs`  (override version with SKYNET_BUNDLE_NODE=v20.18.1)
import { createWriteStream, mkdirSync, existsSync, rmSync } from 'node:fs';
import { get } from 'node:https';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = process.env.SKYNET_BUNDLE_NODE || 'v22.12.0';   // the LTS runtime to ship
// Windows x64 is the ship target. (To add macOS/Linux later: map process.platform/arch → the dist path +
// the Tauri target triple, and fetch each — Tauri picks the one matching the build host at bundle time.)
const TRIPLE = 'x86_64-pc-windows-msvc';
const DIST_URL = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'src-tauri', 'binaries');
const out = join(outDir, `node-${TRIPLE}.exe`);

function fetchTo(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchTo(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const f = createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve()));
      f.on('error', reject);
    }).on('error', reject);
    // a stalled mid-body connection would otherwise hang `npm run desktop:build` forever with no diagnostic;
    // destroy() surfaces as a request 'error' → the existing reject → loud process.exit(1).
    req.setTimeout(60000, () => req.destroy(new Error('download timed out (no data for 60s)')));
  });
}

(async () => {
  mkdirSync(outDir, { recursive: true });
  if (existsSync(out) && !process.env.SKYNET_BUNDLE_FORCE) {
    console.log(`[prepare-node] ${out} already present — skipping (set SKYNET_BUNDLE_FORCE=1 to re-fetch)`);
    return;
  }
  console.log(`[prepare-node] fetching Node ${NODE_VERSION} (win-x64) → ${out}`);
  const tmp = out + '.partial';
  try {
    await fetchTo(DIST_URL, tmp);
    rmSync(out, { force: true });
    (await import('node:fs')).renameSync(tmp, out);
    console.log('[prepare-node] done. (gitignored — a build input, never committed.)');
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    console.error(`[prepare-node] FAILED: ${e.message}`);
    console.error('[prepare-node] the desktop build needs this Node runtime; check connectivity or set SKYNET_BUNDLE_NODE to a valid version.');
    process.exit(1);
  }
})();
