'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const stage = read('scripts/stage-voice-deps.mjs');
const buildRs = read('src-tauri/build.rs');
const desktopCi = read('.github/workflows/desktop-build.yml');
const releaseCi = read('.github/workflows/release-train.yml');
const canary = read('scripts/update-canary.mjs');

assert.match(
  pkg.scripts['desktop:build'],
  /prepare-node\.mjs[\s\S]*stage-voice-deps\.mjs[\s\S]*tauri build/,
  'a local desktop build stages the voice runtime before Tauri packages resources'
);
assert.equal(
  tauri.bundle.resources['voice-deps/node_modules'],
  'node_modules',
  'the staged runtime lands beside sidecar/ so ordinary Node resolution finds it'
);
assert.match(buildRs, /"voice-deps\/node_modules"/, 'Cargo treats the staged voice runtime as a shipped build input');

for (const [name, source] of [['desktop CI', desktopCi], ['release CI', releaseCi]]) {
  assert.match(
    source,
    /prepare-node\.mjs \$\{\{ matrix\.target \}\}[\s\S]{0,160}stage-voice-deps\.mjs --target \$\{\{ matrix\.target \}\}/,
    name + ' stages the matching platform/architecture voice runtime'
  );
}
assert.match(canary, /stage-voice-deps\.mjs'\), '--target', 'win-x64'/, 'canary installers ship the same Windows voice engine');

assert.match(stage, /\^\(win\|darwin\|linux\)-\(x64\|arm64\)\$/, 'the staging script validates release target names');
assert.match(stage, /pruneOnnxBinaries\(dest\)/, 'foreign ONNX native binaries are removed from the staged closure');
assert.match(stage, /if \(!pruned\.kept\.length\)/, 'the build fails closed when no target ONNX runtime survives');
assert.match(stage, /for \(const dep of runtimeDeps\)/, 'every declared production dependency must exist in the staged tree');
assert.match(stage, /DROP_ANYWHERE = new Set\(\['onnxruntime-web'\]\)/, 'the unused browser ONNX backend is not shipped in the Node sidecar bundle');

console.log('desktop voice bundle tests passed');
