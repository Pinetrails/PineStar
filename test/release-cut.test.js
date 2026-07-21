#!/usr/bin/env node

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
// A fixture key FILE (never real key material): --dry-run only proves the key path exists and
// prints the signing command; it never signs. Without this, the test needs the operator's real
// ~/.tauri key and goes red on any CI runner (v0.6.3 train run 4). Named starnet-updater.key so
// the printed-command assertions below still see the canonical filename.
const keyDir = mkdtempSync(join(tmpdir(), 'starnet-cut-key-'));
const keyFile = join(keyDir, 'starnet-updater.key');
writeFileSync(keyFile, 'dW50-fixture-not-a-real-key\n');
const result = spawnSync(process.execPath, [
  join(ROOT, 'scripts', 'release-cut.mjs'),
  '--dry-run',
  '--no-pre-build-ctor'
], { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { STARNET_UPDATER_KEY_FILE: keyFile }) });

assert.equal(result.status, 0, result.stderr || result.stdout);
const output = result.stdout + result.stderr;
assert.match(output, /desktop:build .*explicit updater signing follows/i);
assert.match(output, /--config .*release-unsigned-updater\.conf\.json/i);
assert.match(output, /signer sign --private-key-path .*starnet-updater\.key --password=/i);
assert.doesNotMatch(output, /TAURI_SIGNING_PRIVATE_KEY\s*=/,
  'the release cutter must not put raw private-key contents in its command output');

const source = readFileSync(join(ROOT, 'scripts', 'release-cut.mjs'), 'utf8');
assert.match(source, /TAURI_SIGNING_PRIVATE_KEY:\s*null/,
  'explicit path signing must remove a legacy inline key from the child environment');
assert.match(source, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD:\s*null/,
  'explicit password signing must remove a legacy password variable from the child environment');

console.log('release-cut.test: OK (non-interactive explicit signing path)');
