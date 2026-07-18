#!/usr/bin/env node

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const result = spawnSync(process.execPath, [
  join(ROOT, 'scripts', 'release-cut.mjs'),
  '--dry-run',
  '--no-pre-build-ctor'
], { cwd: ROOT, encoding: 'utf8' });

assert.equal(result.status, 0, result.stderr || result.stdout);
const output = result.stdout + result.stderr;
assert.match(output, /desktop:build .*explicit updater signing follows/i);
assert.match(output, /--config .*release-unsigned-updater\.conf\.json/i);
assert.match(output, /signer sign --private-key-path .*starnet-updater\.key --password=/i);
assert.doesNotMatch(output, /TAURI_SIGNING_PRIVATE_KEY\s*=/,
  'the release cutter must not put raw private-key contents in its command output');

console.log('release-cut.test: OK (non-interactive explicit signing path)');
