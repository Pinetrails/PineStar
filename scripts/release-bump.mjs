#!/usr/bin/env node
/*
 * release-bump.mjs — one-command version bumper for a StarNet desktop release cut.
 *
 * Bumps the version in lockstep across every file the release train reads, scaffolds
 * fresh release notes, then commits + tags so a `v<version>` tag push can trigger the
 * train. It is the human-run first step of the release train (see
 * docs/RELEASE_TRAIN_BUILD_PLAN_2026-07-06.md, contract C1).
 *
 * WHAT IT TOUCHES (and ONLY these — commit uses explicit pathspecs, never `git add -A`):
 *   1. src-tauri/tauri.conf.json  — .version
 *   2. src-tauri/Cargo.toml       — [package] version = "..."
 *   3. src-tauri/Cargo.lock       — the app package's version pin (textual patch, no network)
 *   4. RELEASE_NOTES.md           — overwritten with a fresh header + TODO bullet
 *
 * WHY A TEXTUAL Cargo.lock PATCH: `release-cut.mjs` preflight fails if Cargo.toml and
 * tauri.conf.json disagree, and a stale lockfile pin trips `cargo build --locked` in CI.
 * We rewrite ONLY the app package's own `version = "..."` line inside its `[[package]]`
 * block (matched by `name = "skynet-desktop"`), which needs no registry access — the
 * package is local, so no checksum changes. We never run cargo (no network dependency).
 *
 * VALIDATION: <version> must be SemVer and STRICTLY GREATER THAN the current
 * tauri.conf.json version — a bump can only ever go up, never sideways or backward.
 *
 * SAFETY: never pushes. `--no-tag` skips the tag. `--dry-run` prints every change and
 * touches nothing (no writes, no git).
 *
 * USAGE:
 *   node scripts/release-bump.mjs <version> [--dry-run] [--no-tag]
 *
 * Env overrides (used by the unit test to run against a throwaway fixture repo):
 *   STARNET_BUMP_ROOT   default: repo root (parent of scripts/)
 */

import {
  existsSync, readFileSync, writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.STARNET_BUMP_ROOT
  ? resolve(process.env.STARNET_BUMP_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The Cargo package name of the desktop app — the only [[package]] block we rewrite.
const APP_CRATE = 'skynet-desktop';

const args = process.argv.slice(2);
const argSet = new Set(args);
const DRY_RUN = argSet.has('--dry-run');
const NO_TAG = argSet.has('--no-tag');
const positional = args.filter(a => !a.startsWith('--'));

function log(msg) { process.stdout.write(msg + '\n'); }
function fail(msg) { process.stderr.write('release-bump: ' + msg + '\n'); process.exit(1); }
// Strip a UTF-8 BOM so JSON.parse / regex matching never chokes on it.
function readText(f) { return readFileSync(f, 'utf8').replace(/^﻿/, ''); }
function readJson(f) { return JSON.parse(readText(f)); }

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?/.exec(v);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

// Returns >0 if a>b, <0 if a<b, 0 if equal. A release (no -pre) outranks its own prerelease.
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] - pb[k];
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;   // release > prerelease of same core
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1; // lexical is enough for the strictly-greater gate
}

// ---- Pure file-edit planners (return {path, before, after}); no side effects. ----

function planTauriConf(version) {
  const path = join(ROOT, 'src-tauri', 'tauri.conf.json');
  const before = readText(path);
  const conf = JSON.parse(before);
  const current = conf.version;
  conf.version = version;
  // Re-serialize with 2-space indent + trailing newline to match the file's own style.
  const after = JSON.stringify(conf, null, 2) + '\n';
  return { path, before, after, current, label: 'tauri.conf.json .version' };
}

function planCargoToml(version) {
  const path = join(ROOT, 'src-tauri', 'Cargo.toml');
  const before = readText(path);
  // Only the first `version = "..."` under [package] — it is the first version line in the file.
  const re = /^(\s*version\s*=\s*")([^"]+)(")/m;
  const m = re.exec(before);
  if (!m) fail('Cargo.toml: could not find a package version line');
  const after = before.replace(re, `$1${version}$3`);
  return { path, before, after, current: m[2], label: 'Cargo.toml [package] version' };
}

function planCargoLock(version) {
  const path = join(ROOT, 'src-tauri', 'Cargo.lock');
  if (!existsSync(path)) return null; // lockfile is optional; skip silently if absent
  const before = readText(path);
  // Match the app crate's own [[package]] block and rewrite the version line inside it.
  // Anchor on `name = "skynet-desktop"` then the following `version = "..."`.
  const re = new RegExp(
    '(name = "' + APP_CRATE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\r?\\nversion = ")([^"]+)(")'
  );
  const m = re.exec(before);
  if (!m) return { path, before, after: before, current: null, label: 'Cargo.lock (app pin not found — skipped)', skipped: true };
  const after = before.replace(re, `$1${version}$3`);
  return { path, before, after, current: m[2], label: 'Cargo.lock ' + APP_CRATE + ' version' };
}

function planReleaseNotes(version) {
  const path = join(ROOT, 'RELEASE_NOTES.md');
  const before = existsSync(path) ? readText(path) : '';
  const after = '# StarNet v' + version + '\n\n- TODO: summarize what changed in this release.\n';
  return { path, before, after, current: null, label: 'RELEASE_NOTES.md (scaffold)' };
}

function git(gitArgs) {
  const res = spawnSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' });
  if (res.error) fail('git ' + gitArgs.join(' ') + ' failed to spawn: ' + res.error.message);
  if (res.status !== 0) {
    fail('git ' + gitArgs.join(' ') + ' failed (exit ' + res.status + ')\n' + (res.stderr || res.stdout || '').trim());
  }
  return res.stdout || '';
}

function main() {
  const version = positional[0];
  if (!version) fail('usage: node scripts/release-bump.mjs <version> [--dry-run] [--no-tag]');
  if (!SEMVER_RE.test(version)) fail('"' + version + '" is not a valid SemVer version (expected X.Y.Z).');

  const confPath = join(ROOT, 'src-tauri', 'tauri.conf.json');
  if (!existsSync(confPath)) fail('cannot find ' + confPath + ' (is STARNET_BUMP_ROOT correct?)');
  const current = readJson(confPath).version;
  if (!current) fail('tauri.conf.json has no current version');
  if (compareSemver(version, current) <= 0) {
    fail('new version ' + version + ' is not strictly greater than current ' + current + '.');
  }

  log('== release-bump preflight ==');
  log('  root            : ' + ROOT);
  log('  current version : ' + current);
  log('  new version     : ' + version);
  log('  dry-run         : ' + DRY_RUN);
  log('  tag             : ' + (NO_TAG ? '(skipped, --no-tag)' : 'v' + version));

  const plans = [
    planTauriConf(version),
    planCargoToml(version),
    planCargoLock(version),
    planReleaseNotes(version)
  ].filter(Boolean);

  log('\n== changes ==');
  const changedPaths = [];
  for (const p of plans) {
    const changed = p.before !== p.after;
    log('  [' + (changed ? 'edit' : 'no-op') + '] ' + p.label
      + (p.current ? ('  (' + p.current + ' -> ' + version + ')') : ''));
    if (changed) changedPaths.push(p.path);
  }

  if (DRY_RUN) {
    log('\n[dry-run] no files written, no git commit, no tag. Nothing was touched.');
    return;
  }

  // Write the edits.
  for (const p of plans) {
    if (p.before !== p.after) writeFileSync(p.path, p.after);
  }
  log('\n== wrote ' + changedPaths.length + ' file(s) ==');

  // Commit ONLY our four files, by pathspec (never -A).
  const pathspecs = plans
    .filter(p => p.before !== p.after)
    .map(p => p.path);
  git(['add', '--'].concat(pathspecs));
  git(['commit', '-m', 'release: v' + version, '--'].concat(pathspecs));
  log('committed: release: v' + version);

  if (!NO_TAG) {
    git(['tag', 'v' + version]);
    log('tagged: v' + version);
  } else {
    log('tag skipped (--no-tag).');
  }

  log('\n============================================================');
  log(' BUMPED to v' + version + ' — NOT pushed.');
  log('============================================================');
  log(' Next: push the tag to trigger the release train:');
  log('   git push origin HEAD ' + (NO_TAG ? '' : 'v' + version));
  log(' Nothing ships until the draft is reviewed and Published by a human.');
  log('============================================================');
}

main();
