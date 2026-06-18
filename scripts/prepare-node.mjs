// Fetch the Node runtime that ships inside the desktop installer.
//
// Download-blocker A: the Tauri shell used to spawn "node" from PATH, so a
// clean Windows machine without Node installed could not start the sidecar.
// Tauri externalBin expects the binary named with the build target triple under
// src-tauri/binaries, then copies it beside the packaged app executable.
//
// Run directly: node scripts/prepare-node.mjs
// Override version: SKYNET_BUNDLE_NODE=v22.12.0
import { createWriteStream, mkdirSync, existsSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { get } from 'node:https';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = process.env.SKYNET_BUNDLE_NODE || 'v22.12.0';
const TRIPLE = 'x86_64-pc-windows-msvc';
const DIST_URL = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;
const SHASUMS_URL = `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`;
const SHASUMS_ENTRY = 'win-x64/node.exe';

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
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const f = createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve()));
      f.on('error', reject);
    }).on('error', reject);

    req.setTimeout(60000, () => {
      req.destroy(new Error('download timed out (no data for 60s)'));
    });
  });
}

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.setEncoding('utf8');
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);

    req.setTimeout(60000, () => {
      req.destroy(new Error('checksum download timed out (no data for 60s)'));
    });
  });
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function expectedSha256() {
  const sums = await fetchText(SHASUMS_URL);
  for (const line of sums.split(/\r?\n/)) {
    const m = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (m && m[2] === SHASUMS_ENTRY) return m[1].toLowerCase();
  }
  throw new Error(`missing ${SHASUMS_ENTRY} in ${SHASUMS_URL}`);
}

(async () => {
  mkdirSync(outDir, { recursive: true });
  if (existsSync(out) && !process.env.SKYNET_BUNDLE_FORCE) {
    console.log(`[prepare-node] ${out} already present; skipping (set SKYNET_BUNDLE_FORCE=1 to re-fetch)`);
    return;
  }

  console.log(`[prepare-node] fetching Node ${NODE_VERSION} (win-x64) -> ${out}`);
  const tmp = out + '.partial';
  try {
    await fetchTo(DIST_URL, tmp);
    const expected = await expectedSha256();
    const actual = sha256(tmp);
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${SHASUMS_ENTRY}: expected ${expected}, got ${actual}`);
    }
    rmSync(out, { force: true });
    renameSync(tmp, out);
    console.log('[prepare-node] done (checksum verified; gitignored build input)');
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    console.error(`[prepare-node] FAILED: ${e.message}`);
    console.error('[prepare-node] the desktop build needs this Node runtime; check connectivity or set SKYNET_BUNDLE_NODE to a valid version.');
    process.exit(1);
  }
})();
