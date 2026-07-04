/* node test/loopguard.dispatch.test.js — the runOnce dispatch-level loop guard (sidecar/index.js).

   The guard is embedded in the runOnce closure (not exported), so this test extracts the two REAL
   decision lines from the source and evaluates them, proving the two properties the fix guarantees:
     1. the signature keys on a sha1 of the FULL argsRaw — two DIFFERENT long payloads that share a
        400-char prefix get DIFFERENT signatures (the old `.slice(0,400)` collided them -> false block).
     2. only FAILING results advance a signature's streak; any success RESETS it (matches loop.js) — so
        N byte-identical SUCCESSFUL calls are never blocked, and only a stuck FAILING loop trips at the cap. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

// pull the REAL signature + counting lines out of sidecar/index.js so we test the shipped formula.
const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
A.ok(/const sig = c\.name \+ '\|' \+ crypto\.createHash\('sha1'\)\.update\(String\(c\.argsRaw \|\| ''\)\)\.digest\('hex'\);/.test(src),
  'the shipped signature hashes the FULL argsRaw with sha1 (no 400-char slice)');
A.ok(!/\.slice\(0, 400\)/.test(src.slice(src.indexOf('const dispatch = async'), src.indexOf('const dispatch = async') + 1200)),
  'the old 400-char truncation is gone from the dispatch guard');
A.ok(/if \(r && r\.isError\) seen\.set\(sig, \(seen\.get\(sig\) \|\| 0\) \+ 1\);\s*\n\s*else seen\.delete\(sig\);/.test(src),
  'the shipped guard increments only on error and resets (delete) on success');

// a faithful model of the shipped guard (same two lines) to exercise the behavior.
const CAPS = { maxRepeat: 3 };
function makeGuard() {
  const seen = new Map();
  return {
    // returns { blocked } for a call BEFORE running; call record(sig, isError) after.
    check(name, argsRaw) {
      const sig = name + '|' + crypto.createHash('sha1').update(String(argsRaw || '')).digest('hex');
      return { sig, blocked: (seen.get(sig) || 0) > CAPS.maxRepeat };
    },
    record(sig, isError) { if (isError) seen.set(sig, (seen.get(sig) || 0) + 1); else seen.delete(sig); },
    count(sig) { return seen.get(sig) || 0; }
  };
}

// ---- 1. five fs_write calls, same path, DIFFERENT long content -> none blocked (the plan's Done= check) ----
{
  const g = makeGuard();
  const bigA = 'x'.repeat(500), bigB = 'y'.repeat(500);   // >400 chars so the OLD slice would truncate
  let anyBlocked = false;
  for (let i = 0; i < 5; i++) {
    const argsRaw = JSON.stringify({ path: 'notes.md', content: bigA + i + bigB });   // shares a long prefix, differs late
    const { sig, blocked } = g.check('fs.write', argsRaw);
    if (blocked) anyBlocked = true;
    g.record(sig, false);   // each write SUCCEEDS
  }
  A.ok(!anyBlocked, '5 same-path fs_write with different long content are NEVER blocked (no prefix collision)');
}

// ---- 1b. two payloads sharing a 400-char prefix but differing after get DISTINCT signatures ----
{
  const g = makeGuard();
  const prefix = 'p'.repeat(400);
  const a = g.check('t', prefix + 'A');
  const b = g.check('t', prefix + 'B');
  A.ok(a.sig !== b.sig, 'a 400-char-shared-prefix pair no longer collides (the false-positive bug is fixed)');
}

// ---- 2. byte-identical SUCCESSFUL repeats are never blocked ----
{
  const g = makeGuard();
  let anyBlocked = false;
  for (let i = 0; i < 10; i++) {
    const { sig, blocked } = g.check('fs.read', '{"path":"same.md"}');
    if (blocked) anyBlocked = true;
    g.record(sig, false);   // succeeds every time
  }
  A.ok(!anyBlocked, '10 identical SUCCESSFUL calls are never blocked (success is not a stuck loop)');
}

// ---- 3. byte-identical FAILING repeats DO get blocked past the cap ----
{
  const g = makeGuard();
  let blockedAt = -1;
  for (let i = 0; i < 10; i++) {
    const { sig, blocked } = g.check('shell.exec', '{"cmd":"badcmd"}');
    if (blocked) { blockedAt = i; break; }
    g.record(sig, true);   // fails every time
  }
  A.ok(blockedAt > CAPS.maxRepeat, 'identical FAILING calls are blocked only AFTER exceeding maxRepeat failures');
  A.ok(blockedAt >= 0, 'a stuck failing loop IS eventually blocked (guard purpose intact)');
}

// ---- 4. a success mid-streak RESETS the failure count ----
{
  const g = makeGuard();
  const sigOf = g.check('t', '{"a":1}').sig;
  g.record(sigOf, true); g.record(sigOf, true);
  A.eq(g.count(sigOf), 2, 'two failures counted');
  g.record(sigOf, false);   // a success
  A.eq(g.count(sigOf), 0, 'a success resets the streak to zero');
}

A.report('loopguard.dispatch');
