/* node test/pathtrust.test.js — CONVERSATIONAL PATH TRUST (NS-5 Project Lens core).
   Security-critical: proven against a REAL temp filesystem so blessed-root containment, symlink escape,
   the protected-file floor, and — above all — the UNATTENDED RULE (an autonomous run can NEVER bless a
   new root) are exercised on the actual path/realpath semantics of the host. */
'use strict';
const A = require('./_assert.js');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makePathTrust } = require('../sidecar/pathtrust.js');

const ROOT = path.join(os.tmpdir(), 'starnet-pathtrust-' + process.pid);

async function rejects(promise, msg) { try { await promise; A.ok(false, msg + ' — did NOT reject'); } catch (e) { A.ok(true, msg); } }

// a fake blessed-roots + bless + touch harness backed by a plain Set (the sidecar derives roots from the
// `path:*` grants; here the Set stands in for that live derivation, so removing a member models a revoke).
function harness(opts) {
  opts = opts || {};
  const roots = new Set(opts.roots || []);
  const touched = [];
  let blessOk = opts.blessOk !== false;
  const blessed = [];
  const pt = makePathTrust({
    fsp, pathMod: path,
    roots: () => Array.from(roots),
    bless: async (rootReal, meta) => { if (!blessOk) return false; roots.add(rootReal); blessed.push({ rootReal, meta }); return true; },
    touch: (rootReal, abs) => touched.push({ rootReal, abs }),
    isGitRepoOf: async (r) => { try { await fsp.stat(path.join(r, '.git')); return true; } catch (_) { return false; } },
    now: () => 1700000000000
  });
  return { pt, roots, touched, blessed, setBlessOk(v) { blessOk = v; } };
}

// a prompt that records its calls and returns a scripted decision (or throws if it should NEVER be asked).
function scriptPrompt(decision) {
  const calls = [];
  const fn = async (proposedRoot, info) => { calls.push({ proposedRoot, info }); return decision; };
  fn.calls = calls;
  return fn;
}

(async () => {
  await fsp.mkdir(ROOT, { recursive: true });
  const proj = path.join(ROOT, 'project');
  await fsp.mkdir(path.join(proj, 'src'), { recursive: true });
  await fsp.writeFile(path.join(proj, 'src', 'main.js'), 'console.log(1)\n');
  await fsp.writeFile(path.join(proj, 'README.md'), '# hi\n');
  await fsp.mkdir(path.join(proj, '.git'), { recursive: true });          // makes `proj` a git-repo root
  await fsp.writeFile(path.join(proj, '.env'), 'SECRET=1\n');

  const fileAbs = path.join(proj, 'src', 'main.js');

  // ---- 1. UNATTENDED RULE: autonomous run (no prompt) referencing an un-blessed outside path = HARD DENY ----
  {
    const h = harness();
    const p = scriptPrompt('always');   // if this is ever called, the rule is broken
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'autonomous', prompt: p }),
      'autonomous run with no standing grant is DENIED for an outside path');
    A.eq(p.calls.length, 0, 'autonomous deny NEVER invokes the prompt (silence is not consent)');
    A.eq(h.roots.size, 0, 'autonomous run did not bless anything');
  }

  // ---- 2. interactive but NO prompt wired = fail-closed hard deny ----
  {
    const h = harness();
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: null }),
      'interactive run with no prompt channel fails closed');
  }

  // ---- 3. interactive + "always" → blesses the git-repo ROOT, records the grant, subsequent reads flow ----
  {
    const h = harness();
    const p = scriptPrompt('always');
    const r = await h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: p });
    A.eq(p.calls.length, 1, 'exactly ONE consent prompt for the first outside reference');
    A.ok(h.blessed.length === 1, 'bless was called once');
    // the PROPOSED root is the git repo root (walked up from src/), not the file's own dir
    A.ok(path.resolve(p.calls[0].proposedRoot).toLowerCase() === path.resolve(proj).toLowerCase(),
      'proposed root is the git-repo root, not the immediate directory');
    A.ok(h.blessed[0].meta.isGitRepo === true, 'bless carried isGitRepo:true for a .git-bearing root');
    A.ok(path.resolve(r.abs).toLowerCase() === path.resolve(fileAbs).toLowerCase(), 'guard returns the resolved absolute path');
    // a SUBSEQUENT reference under the now-blessed root flows with NO prompt
    const p2 = scriptPrompt('deny');   // must not be consulted
    const r2 = await h.pt.guard(path.join(proj, 'README.md'), { scope: 'read', surface: 'interactive', prompt: p2 });
    A.eq(p2.calls.length, 0, 'a second file under the blessed root does NOT re-prompt');
    A.ok(r2 && r2.base, 'second read resolved under the blessed root');
    A.ok(h.touched.length >= 2, 'each I/O under the blessed root bumps lastTouchedAt (touch called)');
    // and the SAME blessed root now serves an AUTONOMOUS run (the standing grant, not the surface, is what matters)
    const r3 = await h.pt.guard(fileAbs, { scope: 'read', surface: 'autonomous', prompt: null });
    A.ok(r3 && r3.base, 'once blessed, an autonomous run reads under the root with no prompt');
  }

  // ---- 4. "once" allows THIS access but does NOT persist a root (next reference re-prompts) ----
  {
    const h = harness();
    const p = scriptPrompt('once');
    const r = await h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: p });
    A.ok(r && r.abs, '"once" allows the single access');
    A.eq(h.roots.size, 0, '"once" did NOT record a standing root');
    A.eq(h.blessed.length, 0, '"once" did not call bless');
    const p2 = scriptPrompt('deny');
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: p2 }),
      'after a "once", the very next reference is asked again (and here denied)');
    A.eq(p2.calls.length, 1, '"once" left no standing grant → the next reference DID re-prompt');
  }

  /* ---- 4b. "full" is AT LEAST as strong as "always": it records the standing root and never re-prompts ----
     Regression for the live-caught 2026-07-27 loop: "full" fell through to the "once" branch, so a Commander
     clicking the card's STRONGEST button ("Full access") bought nothing and was asked again on the very next
     file touch in the same folder. Five reads = five identical cards. The grades must never invert. */
  {
    const h = harness();
    const p = scriptPrompt('full');
    const r = await h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: p });
    A.ok(r && r.abs, '"full" allows the access');
    A.eq(p.calls.length, 1, 'exactly ONE prompt for the first outside reference');
    A.eq(h.blessed.length, 1, '"full" RECORDED a standing root grant (it is not a one-time allow)');
    A.ok(h.blessed[0] && path.resolve(h.blessed[0].rootReal).toLowerCase() === path.resolve(proj).toLowerCase(),
      '"full" blessed the same git-repo root "always" would have');
    // every subsequent file in that folder must flow silently — this is the loop the user actually hit
    const p2 = scriptPrompt('deny');   // must not be consulted
    for (const f of ['README.md', 'src/main.js']) {
      const r2 = await h.pt.guard(path.join(proj, f), { scope: 'read', surface: 'interactive', prompt: p2 });
      A.ok(r2 && r2.base, 'subsequent read under the "full"-blessed root resolved');
    }
    A.eq(p2.calls.length, 0, 'after "full", NO further card is raised for that folder');
    // and the grant is a real, revocable standing root — same shape "always" produces
    A.eq(h.roots.size, 1, '"full" left exactly one revocable standing root behind');
  }

  // ---- 4c. a failed persist under "full" DENIES (fail-closed, exactly as "always" does) ----
  {
    const h = harness();
    h.setBlessOk(false);
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: scriptPrompt('full') }),
      '"full" that could not persist its grant is DENIED, never silently allowed');
    A.eq(h.roots.size, 0, 'a failed "full" bless recorded nothing');
  }

  // ---- 5. "no" (deny) throws and blesses nothing ----
  {
    const h = harness();
    const p = scriptPrompt('deny');
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: p }), 'a denied prompt throws');
    A.eq(h.roots.size, 0, 'a denied prompt blesses nothing');
  }

  // ---- 6. REVOKE takes effect on the next run: dropping the root from the live set re-prompts/denies ----
  {
    const h = harness({ roots: [path.resolve(proj)] });
    // blessed → reads flow, no prompt
    const okp = scriptPrompt('deny');
    await h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: okp });
    A.eq(okp.calls.length, 0, 'pre-revoke: blessed root reads with no prompt');
    // simulate the /api/permissions/revoke removing the standing grant
    h.roots.delete(path.resolve(proj));
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'autonomous', prompt: null }),
      'post-revoke: an autonomous run is denied again (grant is the authority, not history)');
  }

  // ---- 7. HARDLINES: .env / .git internals / NUL / UNC are denied EVEN under a blessed root ----
  {
    const h = harness({ roots: [path.resolve(proj)] });
    await rejects(h.pt.guard(path.join(proj, '.env'), { scope: 'read', surface: 'autonomous', prompt: null }),
      '.env is denied even inside a blessed root');
    await rejects(h.pt.guard(path.join(proj, '.git', 'config'), { scope: 'read', surface: 'autonomous', prompt: null }),
      '.git internals are denied even inside a blessed root');
    await rejects(h.pt.guard(path.join(proj, 'src', 'ma\0in.js'), { scope: 'read', surface: 'autonomous', prompt: null }),
      'a NUL byte in the path is illegal');
    await rejects(h.pt.guard('\\\\server\\share\\x', { scope: 'read', surface: 'interactive', prompt: scriptPrompt('always') }),
      'a UNC / network path is never blessable');
  }

  // ---- 8. SYMLINK ESCAPE: a link under a blessed root pointing OUT is denied (real target re-proven) ----
  {
    const outside = path.join(ROOT, 'outside-secret');
    try {
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'loot.txt'), 'nope');
      await fsp.symlink(outside, path.join(proj, 'escape'), 'dir');
      const h = harness({ roots: [path.resolve(proj)] });
      await rejects(h.pt.guard(path.join(proj, 'escape', 'loot.txt'), { scope: 'read', surface: 'autonomous', prompt: null }),
        'a symlink under a blessed root that escapes it is denied (realpath re-proof)');
    } catch (e) {
      A.ok(true, 'symlink escape regression skipped — this filesystem disallows symlinks');
    }
  }

  // ---- 9. non-git folder: proposed root falls back to the file's own directory ----
  {
    const loose = path.join(ROOT, 'loose');
    await fsp.mkdir(loose, { recursive: true });
    await fsp.writeFile(path.join(loose, 'note.txt'), 'x');
    const h = harness();
    const p = scriptPrompt('always');
    await h.pt.guard(path.join(loose, 'note.txt'), { scope: 'read', surface: 'interactive', prompt: p });
    A.ok(path.resolve(p.calls[0].proposedRoot).toLowerCase() === path.resolve(loose).toLowerCase(),
      'no .git anywhere up → proposed root is the file\'s own directory');
    A.ok(h.blessed[0].meta.isGitRepo === false, 'a non-git root is stamped isGitRepo:false');
  }

  // ---- 10. bless persistence failure = deny (fail-closed) ----
  {
    const h = harness({ blessOk: false });
    const p = scriptPrompt('always');
    await rejects(h.pt.guard(fileAbs, { scope: 'read', surface: 'interactive', prompt: p }),
      'if the standing grant cannot be persisted, the access is DENIED (fail-closed)');
    A.eq(h.roots.size, 0, 'a failed bless leaves no root');
  }

  /* ---- the protected-file floor is re-proven on the REAL target ----
     It only ever saw the raw/resolved STRINGS, so a symlink named innocently inside an ALREADY-blessed root
     (notes.txt -> /proj/.env) walked straight through it. Containment was re-proven on the realpath; the
     floor was not. Injected fs so the case runs on a host that cannot create symlinks. ---- */
  {
    const PP = require('node:path').posix;
    const PM = Object.assign({}, PP, { sep: '/' });
    const LINK = '/proj/notes.txt', ENV = '/proj/.env';
    const fspFake = {
      async realpath(p) { return p === LINK ? ENV : p; },
      async lstat(p) { if (p === LINK || p === ENV || p === '/proj') return {}; throw new Error('ENOENT'); },
      async stat(p) { if (p === '/proj') return { isDirectory: () => true }; throw new Error('ENOENT'); }
    };
    const pt = makePathTrust({ fsp: fspFake, pathMod: PM, roots: () => ['/proj'] });
    let blocked = false;
    try { await pt.guard(ENV, { scope: 'read', surface: 'interactive' }); } catch (e) { blocked = /protected-file floor/.test(e.message); }
    A.ok(blocked, 'the direct .env path is blocked (unchanged)');
    blocked = false;
    try { await pt.guard(LINK, { scope: 'read', surface: 'interactive' }); } catch (e) { blocked = /protected-file floor/.test(e.message); }
    A.ok(blocked, 'a symlink inside a blessed root that RESOLVES to .env is blocked too');
    // an ordinary file under the same blessed root still flows
    const ok = await pt.guard('/proj/src/a.js', { scope: 'read', surface: 'interactive' });
    A.eq(ok.base, '/proj', 'an ordinary in-root read is unaffected');
  }

  /* ---- "always" must actually stick when the root is reached through a symlinked ancestor ----
     The grant was stored as P.resolve(...) while lookup compares the realpath, so ~/code -> /mnt/data/code
     never matched again and the Commander was re-prompted on every call — consent fatigue on the one prompt
     that widens filesystem reach. ---- */
  {
    const PP = require('node:path').posix;
    const PM = Object.assign({}, PP, { sep: '/' });
    const SYM = '/home/me/code', REALROOT = '/mnt/data/code';
    const blessed = [];
    const fspFake = {
      async realpath(p) { return p.indexOf(SYM) === 0 ? REALROOT + p.slice(SYM.length) : p; },
      async lstat() { return {}; },
      async stat(p) { if (p === SYM || p === REALROOT) return { isDirectory: () => true }; throw new Error('ENOENT'); }
    };
    const pt = makePathTrust({ fsp: fspFake, pathMod: PM, roots: () => blessed.slice(),
      bless: async (r) => { blessed.push(r); return true; } });
    await pt.guard(SYM + '/src/a.js', { scope: 'read', surface: 'interactive', prompt: async () => 'always' });
    A.ok(blessed[0].indexOf(REALROOT) === 0, 'the grant is recorded under the CANONICAL (realpath) root');
    let asked = 0;
    const second = await pt.guard(SYM + '/src/b.js', { scope: 'read', surface: 'interactive', prompt: async () => { asked++; return 'always'; } });
    A.eq(asked, 0, 'a second file under the same root does NOT re-prompt');
    A.ok(second.base.indexOf(REALROOT) === 0, 'and resolves against the blessed canonical root');
  }

  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
  A.report('pathtrust.test');
})();
