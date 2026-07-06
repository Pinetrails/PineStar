#!/usr/bin/env node
'use strict';

// Fast, fixture-based unit test for scripts/release-bump.mjs.
// No network. No git side effects on THIS repo — the real-commit path runs inside a
// throwaway temp git repo created and torn down here.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const script = path.join(ROOT, 'scripts', 'release-bump.mjs');

let assertions = 0;
function check(cond, msg) { assert.ok(cond, msg); assertions++; }
function eq(a, b, msg) { assert.equal(a, b, msg); assertions++; }

// Build a fixture "repo root": just the files release-bump reads/writes.
function makeFixture(dir, version, opts) {
  opts = opts || {};
  fs.mkdirSync(path.join(dir, 'src-tauri'), { recursive: true });
  const conf = { $schema: 'x', productName: 'StarNet', version, identifier: 'ai.skynet.harness' };
  fs.writeFileSync(
    path.join(dir, 'src-tauri', 'tauri.conf.json'),
    (opts.bom ? '﻿' : '') + JSON.stringify(conf, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(dir, 'src-tauri', 'Cargo.toml'),
    '[package]\nname = "skynet-desktop"\nversion = "' + version + '"\nedition = "2021"\n\n' +
    '[dependencies]\nserde = "1"\n'
  );
  fs.writeFileSync(
    path.join(dir, 'src-tauri', 'Cargo.lock'),
    '# auto-generated\nversion = 3\n\n' +
    '[[package]]\nname = "serde"\nversion = "1.0.0"\n\n' +
    '[[package]]\nname = "skynet-desktop"\nversion = "' + version + '"\ndependencies = [\n "serde",\n]\n'
  );
  if (opts.notes) fs.writeFileSync(path.join(dir, 'RELEASE_NOTES.md'), opts.notes);
}

function run(args, root, extraEnv) {
  return spawnSync(process.execPath, [script].concat(args), {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { STARNET_BUMP_ROOT: root }, extraEnv || {})
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-bump-'));
try {
  // ---- 1. --dry-run: prints changes, writes nothing ----
  {
    const dir = path.join(tmp, 'dry');
    makeFixture(dir, '0.1.9');
    const res = run(['0.2.0', '--dry-run'], dir);
    eq(res.status, 0, res.stderr || res.stdout);
    check(/0\.1\.9 -> 0\.2\.0/.test(res.stdout), 'dry-run shows version delta');
    check(/no files written/.test(res.stdout), 'dry-run says nothing written');
    // Files untouched.
    const conf = JSON.parse(fs.readFileSync(path.join(dir, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    eq(conf.version, '0.1.9', 'dry-run left tauri.conf.json version alone');
    check(!fs.existsSync(path.join(dir, 'RELEASE_NOTES.md')), 'dry-run did not scaffold notes');
  }

  // ---- 2. Rejects non-SemVer ----
  {
    const dir = path.join(tmp, 'bad-semver');
    makeFixture(dir, '0.1.9');
    const res = run(['v1.2', '--dry-run'], dir);
    eq(res.status, 1, 'non-semver should fail');
    check(/not a valid SemVer/.test(res.stderr), 'reports semver error');
  }

  // ---- 3. Rejects non-strictly-greater (equal and lower) ----
  {
    const dir = path.join(tmp, 'not-greater');
    makeFixture(dir, '0.2.0');
    const same = run(['0.2.0', '--dry-run'], dir);
    eq(same.status, 1, 'equal version rejected');
    check(/not strictly greater/.test(same.stderr), 'reports not-greater (equal)');
    const lower = run(['0.1.5', '--dry-run'], dir);
    eq(lower.status, 1, 'lower version rejected');
    check(/not strictly greater/.test(lower.stderr), 'reports not-greater (lower)');
  }

  // ---- 4. Real bump inside a throwaway git repo: files edited, committed, tagged, no push ----
  {
    const dir = path.join(tmp, 'realgit');
    makeFixture(dir, '0.1.9', { notes: '# StarNet v0.1.9\n\n- old notes\n', bom: true });
    // init a self-contained repo (no remote -> a push would fail loudly if attempted)
    const gitEnv = {
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t'
    };
    function g(a) {
      const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: Object.assign({}, process.env, gitEnv) });
      assert.equal(r.status, 0, 'git ' + a.join(' ') + ': ' + (r.stderr || r.stdout));
      return r.stdout;
    }
    g(['init', '-q']);
    g(['add', '-A']);
    g(['commit', '-qm', 'seed']);
    // An untracked stray file that must NOT be swept into the release commit.
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'do not commit me');

    const res = run(['0.2.0'], dir, gitEnv);
    eq(res.status, 0, res.stderr || res.stdout);

    // Files actually updated in lockstep.
    const conf = JSON.parse(fs.readFileSync(path.join(dir, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    eq(conf.version, '0.2.0', 'tauri.conf.json bumped');
    const cargo = fs.readFileSync(path.join(dir, 'src-tauri', 'Cargo.toml'), 'utf8');
    check(/^version = "0\.2\.0"$/m.test(cargo), 'Cargo.toml bumped');
    const lock = fs.readFileSync(path.join(dir, 'src-tauri', 'Cargo.lock'), 'utf8');
    check(/name = "skynet-desktop"\nversion = "0\.2\.0"/.test(lock), 'Cargo.lock app pin bumped');
    check(/name = "serde"\nversion = "1\.0\.0"/.test(lock), 'Cargo.lock other pins untouched');
    const notes = fs.readFileSync(path.join(dir, 'RELEASE_NOTES.md'), 'utf8');
    check(/^# StarNet v0\.2\.0/.test(notes), 'RELEASE_NOTES.md overwritten with new header');
    check(/TODO/.test(notes), 'RELEASE_NOTES.md has TODO bullet');

    // Commit exists with the right message.
    const subject = spawnSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    eq(subject, 'release: v0.2.0', 'commit subject');

    // ONLY the 4 files are in the release commit — the stray file is NOT.
    const files = spawnSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: dir, encoding: 'utf8' })
      .stdout.split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(files, [
      'RELEASE_NOTES.md', 'src-tauri/Cargo.lock', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json'
    ], 'exactly the 4 pinned files committed'); assertions++;
    const straySt = spawnSync('git', ['status', '--porcelain', 'stray.txt'], { cwd: dir, encoding: 'utf8' }).stdout;
    check(/^\?\? stray\.txt/.test(straySt), 'stray file left untracked (pathspec commit, not -A)');

    // Tag created, pointing at HEAD.
    const tags = spawnSync('git', ['tag'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    eq(tags, 'v0.2.0', 'tag v0.2.0 created');
  }

  // ---- 5. --no-tag: commits but creates no tag ----
  {
    const dir = path.join(tmp, 'notag');
    makeFixture(dir, '0.1.9');
    const gitEnv = {
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t'
    };
    spawnSync('git', ['init', '-q'], { cwd: dir, env: Object.assign({}, process.env, gitEnv) });
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-qm', 'seed'], { cwd: dir, env: Object.assign({}, process.env, gitEnv) });
    const res = run(['0.3.0', '--no-tag'], dir, gitEnv);
    eq(res.status, 0, res.stderr || res.stdout);
    const subject = spawnSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    eq(subject, 'release: v0.3.0', '--no-tag still commits');
    const tags = spawnSync('git', ['tag'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    eq(tags, '', '--no-tag created no tag');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('release-bump.test: OK (' + assertions + ' assertions)');
