'use strict';
// projectbless.test.js — the ADD-A-PROJECT bless core (NS-5c Projects rail).
// The pure decision core behind POST /api/projects/bless: interactive-only (the unattended rule at the second
// doorway), absolute-path required, must exist + be a directory, the identical hardline floor as pathtrust, and it
// blesses the PROPOSED git-repo root through the injected bless() (the SAME blessProjectRoot the chat prompt calls).
const assert = require('assert');
const path = require('path');
const { makeProjectBless } = require('../sidecar/projectbless.js');
// reuse the REAL pathtrust core so detectRoot/normalizeRoot/hardlineReason are the exact code the sidecar wires —
// the whole point is that a typed folder produces the byte-identical grant key a chat mention would.
const { makePathTrust } = require('../sidecar/pathtrust.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// a fake fs/promises whose directory tree + .git markers are declared inline. abs paths use forward slashes so
// the test is platform-neutral (path.resolve on POSIX leaves them; on win32 they normalize the same either way).
function fakeFsp(tree) {
  // tree: { '<abs>': { dir:true } | { file:true } }  — a missing key => ENOENT.
  const norm = (p) => path.resolve(String(p));
  return {
    async stat(p) {
      const e = tree[norm(p)];
      if (!e) { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err; }
      return { isDirectory: () => !!e.dir, isFile: () => !!e.file };
    },
    async realpath(p) { return norm(p); },
    async lstat(p) { return this.stat(p); }
  };
}

function coreOver(tree, blessSink) {
  const fsp = fakeFsp(tree);
  const pt = makePathTrust({ fsp, pathMod: path, roots: () => [], isGitRepoOf: async () => false });
  return makeProjectBless({
    fsp, pathMod: path,
    detectRoot: pt.detectRoot,
    normalizeRoot: pt.normalizeRoot,
    hardlineReason: pt._internals.hardlineReason,
    bless: blessSink,
    isGitRepoOf: async (root) => !!(tree[path.resolve(root + '/.git')]),
    now: () => 4242
  });
}

(async () => {
  const R = path.resolve('/home/me/proj');
  const baseTree = () => ({
    [R]: { dir: true },
    [path.resolve(R + '/.git')]: { dir: true },
    [path.resolve(R + '/src')]: { dir: true },
    [path.resolve(R + '/src/main.js')]: { file: true },
    [path.resolve(R + '/README.md')]: { file: true },
    [path.resolve('/home/me/plain')]: { dir: true },       // a dir with NO .git
    [path.resolve('/home/me/file.txt')]: { file: true }
  });

  // --- AUTONOMOUS surface is a hard deny with NO bless (the unattended rule at the second doorway) ---
  {
    const blessed = []; const core = coreOver(baseTree(), async (r) => { blessed.push(r); return true; });
    const r = await core.blessPath({ path: R, surface: 'autonomous' });
    ok(r.ok === false && r.code === 'autonomous', 'autonomous surface is denied');
    ok(blessed.length === 0, 'autonomous deny never calls bless()');
    // a MISSING surface is treated as autonomous (fail-closed default), never interactive.
    const r2 = await core.blessPath({ path: R });
    ok(r2.ok === false && r2.code === 'autonomous', 'absent surface defaults to autonomous-deny');
  }

  // --- RELATIVE path is rejected (no cwd the user can see) ---
  {
    const core = coreOver(baseTree(), async () => true);
    const r = await core.blessPath({ path: 'some/rel/dir', surface: 'interactive' });
    ok(r.ok === false && r.code === 'relative', 'relative path rejected');
    const r2 = await core.blessPath({ path: '', surface: 'interactive' });
    ok(r2.ok === false && r2.code === 'missing', 'empty path rejected as missing');
  }

  // --- MISSING dir + a FILE path are honest errors ---
  {
    const core = coreOver(baseTree(), async () => true);
    const rm = await core.blessPath({ path: path.resolve('/home/me/nope'), surface: 'interactive' });
    ok(rm.ok === false && rm.code === 'missing', 'nonexistent folder rejected');
    const rf = await core.blessPath({ path: path.resolve('/home/me/file.txt'), surface: 'interactive' });
    ok(rf.ok === false && rf.code === 'notdir', 'a file path rejected (not a folder)');
  }

  // --- HARDLINE floor: .env / .git targets are blocked regardless of the interactive click ---
  {
    const core = coreOver(baseTree(), async () => true);
    const re = await core.blessPath({ path: path.resolve('/home/me/proj/.env'), surface: 'interactive' });
    ok(re.ok === false && re.code === 'hardline', '.env target blocked by the hardline floor');
    const rg = await core.blessPath({ path: path.resolve('/home/me/proj/.git'), surface: 'interactive' });
    ok(rg.ok === false && rg.code === 'hardline', '.git target blocked by the hardline floor');
  }

  // --- HAPPY: an interactive bless of a folder INSIDE a git repo blesses the git ROOT, not the subdir ---
  {
    const blessed = []; let gitFlag = null;
    const core = coreOver(baseTree(), async (r, m) => { blessed.push(r); gitFlag = m.isGitRepo; return true; });
    const r = await core.blessPath({ path: path.resolve(R + '/src'), surface: 'interactive' });
    ok(r.ok === true, 'interactive bless of a subdir succeeds');
    ok(path.resolve(r.root) === R, 'the blessed root is the git-repo root (walked up from src): ' + r.root);
    ok(r.isGitRepo === true && gitFlag === true, 'reported + persisted as a git repo');
    ok(blessed.length === 1 && path.resolve(blessed[0]) === R, 'bless() called exactly once with the git root');
  }

  // --- HAPPY: a plain (non-git) folder blesses ITSELF, isGitRepo:false ---
  {
    const blessed = [];
    const core = coreOver(baseTree(), async (r) => { blessed.push(r); return true; });
    const r = await core.blessPath({ path: path.resolve('/home/me/plain'), surface: 'interactive' });
    ok(r.ok === true && path.resolve(r.root) === path.resolve('/home/me/plain'), 'plain folder blesses itself');
    ok(r.isGitRepo === false, 'plain folder reports isGitRepo:false');
  }

  // --- FAIL-CLOSED: a bless() that returns false (torn durable write) surfaces ok:false, never a phantom grant ---
  {
    const core = coreOver(baseTree(), async () => false);
    const r = await core.blessPath({ path: R, surface: 'interactive' });
    ok(r.ok === false && r.code === 'persist', 'a failed durable write denies the bless (fail-closed)');
  }

  console.log('projectbless.test: ' + n + ' assertions passed');
})().catch(e => { console.error(e); process.exit(1); });
