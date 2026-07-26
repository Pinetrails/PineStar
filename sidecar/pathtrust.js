/* sidecar/pathtrust.js — CONVERSATIONAL PATH TRUST (NS-5 Project Lens core).

   The fs.* tools are jailed to <workspaces>/<agentId>/ (fs.js resolveInside). This module is the ONE
   sanctioned way an fs tool call may reach a path OUTSIDE that jail: it resolves the referenced absolute
   path against a per-station set of BLESSED PROJECT ROOTS and, when the path is not yet under any blessed
   root, mediates a SINGLE consent decision ("work in <root>? always / once / no"). "always" records a
   standing PATH grant (dangerKey `path:<normalized-real-root>`) that the sidecar persists fail-closed and
   the existing /api/permissions surface lists + revokes. Reads flow once a root is blessed; writes stay
   consent-gated by the normal broker scope rules (this module only clears the path boundary, never the
   write-scope boundary).

   HARDLINES that no bless can cross (generalized from fs.js's jail + index.js hardlineFloor):
     • .env / .git internals anywhere in the path            (secret + repo-plumbing floor)
     • NUL bytes, UNC / network paths (\\server\share, //h)  (illegal / off-host)
     • symlink escape: the REAL (realpath-resolved) target must stay inside the blessed root's REAL path,
       re-proven on every access — a symlink planted under a blessed root cannot walk back out.

   THE UNATTENDED RULE (enforced here, not optional): only an INTERACTIVE run with a live prompt() may
   bless a NEW root. An autonomous run (surface !== 'interactive', or no prompt wired) that references an
   un-blessed outside path is a HARD DENY with NO prompt — silence is never consent, and a headless/cron
   run can never widen its own reach.

   makePathTrust({ fsp, pathMod, roots, bless, touch, isGitRepoOf, now, maxWalk }) -> { guard, detectRoot, normalizeRoot }
     fsp        : node:fs/promises (injected) — realpath / stat only, never writes.
     pathMod    : node:path (injected).
     roots      : () => [normalizedRealRoot...]  — the LIVE blessed set (index.js derives it from the
                  `path:*` grants, so a revoke takes effect on the very next call with no restart).
     bless      : async (rootReal, { isGitRepo, now }) => bool  — persist the standing grant + upsert the
                  known-projects store (persist-before-commit in index.js); false ⇒ deny (never committed).
     touch      : (rootReal, absPath) => void  — bump lastTouchedAt on I/O under a known root (best-effort).
     isGitRepoOf: async (rootReal) => bool  — light metadata for the store (has a .git entry).
     now        : injected clock.
     maxWalk    : ancestor-walk cap for git-root detection (default 40).

   guard(absPath, { scope, surface, prompt, agentId }) -> { base, abs }   // throws on any deny
     scope   : 'read' | 'write' (write only reaches here AFTER the broker's own scope consent).
     surface : 'interactive' | 'autonomous'.
     prompt  : async (proposedRoot, { path, scope }) => 'always'|'once'|'full'|'deny'|...  (null ⇒ autonomous).

   Pure decision core over injected node deps (matches fs.js / permgrants.js). No env, no wall-clock. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).pathtrust = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function makePathTrust(deps) {
    deps = deps || {};
    const fsp = deps.fsp, P = deps.pathMod;
    if (!fsp || !P) throw new Error('pathtrust requires { fsp, pathMod }');
    const rootsFn = typeof deps.roots === 'function' ? deps.roots : (() => []);
    const bless = typeof deps.bless === 'function' ? deps.bless : null;
    const touch = typeof deps.touch === 'function' ? deps.touch : (() => {});
    const isGitRepoOf = typeof deps.isGitRepoOf === 'function' ? deps.isGitRepoOf : (async () => false);
    const now = typeof deps.now === 'function' ? deps.now : (() => null);
    const MAX_WALK = Number(deps.maxWalk) > 0 ? Number(deps.maxWalk) : 40;

    const winish = P.sep === '\\';
    function pathInside(abs, base) {
      let a = P.resolve(abs), b = P.resolve(base);
      if (winish) { a = a.toLowerCase(); b = b.toLowerCase(); }
      return a === b || a.indexOf(b + P.sep) === 0;
    }
    async function realpathOrSelf(p) { try { return await fsp.realpath(p); } catch (_) { return p; } }
    // realpath the DEEPEST existing ancestor of a (possibly not-yet-created) absolute path, so a symlink
    // anywhere along the real chain is resolved before the containment test (symlink-escape re-proof).
    async function realpathDeepest(abs) {
      let cur = P.resolve(abs);
      for (;;) {
        try { await fsp.lstat(cur); return await realpathOrSelf(cur); }
        catch (_) {
          const parent = P.dirname(cur);
          if (!parent || parent === cur) return cur;
          cur = parent;
        }
      }
    }

    // stable key for a root: realpath (canonical) — index.js stores this same string as `path:<root>`, so
    // the grant key, the projects-store key, and this comparison are ONE string. Case is left as realpath
    // returns it; pathInside is case-insensitive on win32, so any residual case difference still matches.
    function normalizeRoot(abs) { return P.resolve(String(abs == null ? '' : abs)); }

    // the unconditional floor — throws a reason if the path is illegal or protected regardless of any grant.
    function hardlineReason(rawAbs, resolvedAbs) {
      if (rawAbs.indexOf('\0') >= 0) return 'illegal path (NUL): ' + rawAbs;
      // UNC / network path — off-host, never blessable. Check the RAW string (P.resolve can mangle it).
      if (/^[\\/]{2}/.test(rawAbs)) return 'network paths (UNC) are not permitted: ' + rawAbs;
      const probe = resolvedAbs || rawAbs;
      if (/(^|[\\/])\.env(\.|$)/i.test(probe)) return 'reading ' + probe + ' is blocked by the protected-file floor (.env)';
      if (/(^|[\\/])\.git([\\/]|$)/i.test(probe)) return 'reading ' + probe + ' is blocked by the protected-file floor (.git)';
      return null;
    }

    // propose the project root to bless for a referenced path: the nearest ancestor that is a git repo
    // (natural project boundary), else the directory containing the file. Bounded ancestor walk.
    async function detectRoot(absPath) {
      const abs = P.resolve(absPath);
      let dir = P.dirname(abs);
      try { const st = await fsp.stat(abs); if (st.isDirectory()) dir = abs; } catch (_) {}
      let cur = dir;
      for (let i = 0; i < MAX_WALK; i++) {
        try { await fsp.stat(P.join(cur, '.git')); return cur; } catch (_) {}
        const parent = P.dirname(cur);
        if (!parent || parent === cur) break;
        cur = parent;
      }
      return dir;
    }

    async function guard(absPath, o) {
      o = o || {};
      const scope = o.scope === 'write' ? 'write' : 'read';
      const surface = o.surface === 'interactive' ? 'interactive' : 'autonomous';
      const prompt = typeof o.prompt === 'function' ? o.prompt : null;

      const raw = String(absPath == null ? '' : absPath);
      const norm = P.resolve(raw);
      const hr = hardlineReason(raw, norm);
      if (hr) throw new Error(hr);

      // REAL target (symlinks along the existing chain resolved) — the value every containment test uses.
      const real = await realpathDeepest(norm);
      /* AND THE FLOOR IS RE-PROVEN ON IT. The hardline above only ever saw the RAW and RESOLVED strings, so a
         symlink named innocently (notes.txt -> /proj/.env) sailed through: the name carries no `.env`, the
         real target does. Containment was already re-proven against `real`; the protected-file floor was not,
         which made a one-line symlink inside an ALREADY-blessed root a complete bypass of the .env/.git floor.
         Same function, same rules, now applied to what will actually be opened. */
      const rhr = hardlineReason(real, real);
      if (rhr) throw new Error(rhr + ' (reached via ' + norm + ')');

      // 1. already under a blessed root? reads flow; the write-scope boundary is the broker's job upstream.
      for (const R of rootsFn()) {
        if (!R) continue;
        if (pathInside(real, R)) { touch(R, norm); return { base: R, abs: norm }; }
      }

      // 2. not blessed. THE UNATTENDED RULE: only a watched, prompt-wired interactive run may bless a new root.
      if (surface !== 'interactive' || !prompt)
        throw new Error('path is outside the agent workspace and no project root grant covers it: ' + norm +
          ' — an autonomous run cannot bless a new folder; grant it from a watched session first.');

      // 3. ask ONCE about the proposed project root.
      const proposed = normalizeRoot(await detectRoot(norm));
      const phr = hardlineReason(proposed, proposed);
      if (phr) throw new Error(phr);
      const proposedReal = await realpathOrSelf(proposed);
      // the referenced target must actually live under the proposed root's REAL path (symlink re-proof).
      if (!pathInside(real, proposedReal))
        throw new Error('path escapes the proposed project root via symlink: ' + norm);

      /* BLESS THE REAL PATH. The header calls the grant key "realpath (canonical)", but normalizeRoot is only
         P.resolve — so a root reached through a symlinked ancestor (~/code -> /mnt/data/code, the ordinary
         way people arrange a dev box) was STORED un-canonical while step 1 above compares against the
         realpath. The two could never match, so "always" silently did nothing and the Commander was asked to
         bless the same folder on every single call — consent fatigue that trains people to click through the
         one prompt that widens the agent's filesystem reach. The PROMPT still names the path the Commander
         recognizes; only the recorded key is canonical. */
      const decision = await prompt(proposed, { path: norm, scope: scope });
      if (decision === 'always') {
        if (!bless) throw new Error('path trust is not wired to persist a grant — denied');
        const isGit = await isGitRepoOf(proposedReal);
        const ok = await bless(proposedReal, { isGitRepo: isGit, now: now() });
        if (!ok) throw new Error('could not persist project trust — denied: ' + proposed);
        touch(proposedReal, norm);
        return { base: proposedReal, abs: norm };
      }
      // "once" (and the broker's "full", treated as a one-time allow here — a directory bless is deliberate,
      // never a side effect of a blanket capability grant): allow THIS access without persisting a root.
      if (decision === 'once' || decision === 'full') return { base: proposedReal, abs: norm };
      throw new Error('access to ' + norm + ' was denied');
    }

    return { guard, detectRoot, normalizeRoot, _internals: { pathInside, realpathDeepest, hardlineReason } };
  }

  return { makePathTrust };
});
