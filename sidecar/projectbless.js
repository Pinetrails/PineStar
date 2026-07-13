/* sidecar/projectbless.js — the ADD-A-PROJECT bless core (NS-5c Projects rail).

   POST /api/projects/bless {path} is the SECOND doorway to the SAME standing path-grant machinery as
   conversational path trust (pathtrust.js): the Commander types or picks a folder in the Projects rail and
   blessing it records the identical `path:<normalized-real-root>` grant + known-projects row — one consent
   flow, two doorways, never a parallel store. Here the CLICK is the consent, so unlike a run there is no
   mid-stream prompt() — but the exact same rules gate it:

     • INTERACTIVE ONLY. THE UNATTENDED RULE holds at this doorway too — an autonomous/headless caller can never
       widen its own reach through the API any more than through a tool. surface must be 'interactive' or DENY.
     • the identical HARDLINES (pathtrust's hardlineReason): no .env / .git internals, no NUL, no UNC/network path.
     • the path must EXIST and be a DIRECTORY (a typed path to a file or a missing folder is an honest error).
     • the blessed root is the PROPOSED git-repo root (detectRoot) — the same natural project boundary the
       conversational prompt offers — so blessing C:\proj\src\main.js blesses C:\proj, matching pathtrust.

   makeProjectBless({ fsp, pathMod, detectRoot, normalizeRoot, hardlineReason, bless, isGitRepoOf, now })
     fsp         : node:fs/promises (injected) — stat only, never writes.
     pathMod     : node:path (injected) — isAbsolute + resolve.
     detectRoot  : async (absPath) => proposedRoot     (pathTrustCore.detectRoot — nearest .git ancestor / dir).
     normalizeRoot: (abs) => canonical key             (pathTrustCore.normalizeRoot — SAME string as the grant key).
     hardlineReason: (rawAbs, resolvedAbs) => reason|null (pathTrustCore._internals.hardlineReason).
     bless       : async (rootReal, { isGitRepo, now }) => bool  — index.js blessProjectRoot (persist-before-commit).
     isGitRepoOf : async (rootReal) => bool.
     now         : injected clock.

   -> { blessPath }
   async blessPath({ path, surface }) -> { ok, root?, isGitRepo?, reason?, code? }   // never throws; honest errors.

   Pure decision core over injected node deps (matches pathtrust.js / permgrants.js). No env, no wall-clock. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).projectbless = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function makeProjectBless(deps) {
    deps = deps || {};
    const fsp = deps.fsp, P = deps.pathMod;
    if (!fsp || !P) throw new Error('projectbless requires { fsp, pathMod }');
    const detectRoot = typeof deps.detectRoot === 'function' ? deps.detectRoot : (async (a) => P.dirname(P.resolve(a)));
    const normalizeRoot = typeof deps.normalizeRoot === 'function' ? deps.normalizeRoot : ((a) => P.resolve(String(a == null ? '' : a)));
    const hardlineReason = typeof deps.hardlineReason === 'function' ? deps.hardlineReason : (() => null);
    const bless = typeof deps.bless === 'function' ? deps.bless : null;
    const isGitRepoOf = typeof deps.isGitRepoOf === 'function' ? deps.isGitRepoOf : (async () => false);
    const now = typeof deps.now === 'function' ? deps.now : (() => null);

    async function blessPath(o) {
      o = o || {};
      const surface = o.surface === 'interactive' ? 'interactive' : 'autonomous';
      // THE UNATTENDED RULE: only a live, user-initiated (interactive) surface may bless a new root.
      if (surface !== 'interactive')
        return { ok: false, code: 'autonomous', reason: 'blessing a project folder is a user action — an autonomous run cannot add a project.' };

      const raw = (o.path == null ? '' : String(o.path)).trim();
      if (!raw) return { ok: false, code: 'missing', reason: 'no folder path given' };
      // a typed path MUST be absolute — a relative path has no meaning without a cwd the user can't see.
      if (!P.isAbsolute(raw)) return { ok: false, code: 'relative', reason: 'enter an absolute folder path (e.g. C:\\Users\\you\\project or /home/you/project)' };

      const norm = normalizeRoot(raw);
      const hr = hardlineReason(raw, norm);
      if (hr) return { ok: false, code: 'hardline', reason: hr };

      // must exist AND be a directory — the honest failure a typo or a file path deserves.
      let st;
      try { st = await fsp.stat(norm); }
      catch (_) { return { ok: false, code: 'missing', reason: 'that folder does not exist: ' + norm }; }
      if (!st.isDirectory()) return { ok: false, code: 'notdir', reason: 'that path is a file, not a folder: ' + norm };

      // propose the git-repo ROOT (nearest .git ancestor) — the same boundary the conversational prompt offers.
      const proposed = normalizeRoot(await detectRoot(norm));
      const phr = hardlineReason(proposed, proposed);
      if (phr) return { ok: false, code: 'hardline', reason: phr };

      if (!bless) return { ok: false, code: 'unwired', reason: 'project trust is not wired to persist a grant — denied' };
      const isGit = await isGitRepoOf(proposed);
      const ok = await bless(proposed, { isGitRepo: isGit, now: now() });
      if (!ok) return { ok: false, code: 'persist', reason: 'could not persist project trust — denied: ' + proposed };
      return { ok: true, root: proposed, isGitRepo: isGit };
    }

    return { blessPath };
  }

  // The PROJECT-SCOPED SESSION context line (Hermes-parity working folder). A session anchored to a project
  // sends its root with each /api/run; this composes the ONE line that rides the system prompt — and ONLY when
  // the caller proved the root is still a standing blessed grant (truthful telemetry: injecting a folder claim
  // for an un-blessed root would assert access the harness can't prove, so `blessed:false` returns '').
  // Pure + bounded; the root is display-trusted (it came from the grant store, not the user message).
  function projectScopeLine(root, blessed) {
    const r = String(root == null ? '' : root).trim();
    if (!r || !blessed) return '';
    return '\n\nPROJECT FOLDER: this session is anchored to the trusted project folder ' + r.slice(0, 1024) +
      ' — unless the user names a different location, file work in this conversation happens there.';
  }

  return { makeProjectBless, projectScopeLine };
});
