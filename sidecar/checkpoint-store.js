/* sidecar/checkpoint-store.js — the AMBIENT edge of the checkpoint rollback net (execution-spine Commit 1).

   The pure half (sidecar/checkpoint.js) owns the snapshot INDEX + rollback math; this file owns the actual
   content-addressed shadow store: a per-agent shadow GIT repo whose git-dir lives OUTSIDE the agent's fs jail
   (WORKSPACES/.checkpoints/<agentId>/git) with the agent's workspace (WORKSPACES/<agentId>) as its work-tree.
   `git add -A` + commit per snapshot gives content-addressing, dedup, and cheap restore for free with zero deps.
   Because the git-dir is a SIBLING of the jail (never inside WORKSPACES/<agentId>/), the agent's own fs.* and
   shell tools can neither read nor rewrite their own history.

   Every ambient dependency is INJECTED (fs, path, the git runner, the clock) so it is headless-testable with a
   real temp dir + real git + a fake clock; there is NO Date.now / Math.random / new Date() here (the snapshot id
   IS the git commit sha, content-derived, never minted), so it passes lint-determinism.js. core.autocrlf/safecrlf
   are forced off so an agent's files are stored and restored BYTE-EXACT (no line-ending mangling = no silent
   corruption). All git failures FAIL-OPEN (a snapshot/restore problem must never crash a run); the host decides
   whether a missing checkpoint should block a dangerous tool.

   makeCheckpointStore({ fs, pathMod, root, runGit, clock, keep? }) -> { snapshot, restore, list, isValidId }
     runGit(args:string[], { cwd }) -> Promise<{ code:int|string, stdout, stderr }>   // resolves, never rejects
     snapshot(agentId, { runId, turn, label }) -> Promise<{ id, created:bool, files, bytes } | null>
     restore(agentId, snapshotId)              -> Promise<bool>   // only restores an id IN this agent's index
     list(agentId)                             -> { version, snapshots } */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./checkpoint.js') : (root.SK && root.SK.checkpoint));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).checkpointStore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (cp) {
  'use strict';

  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;            // the notebook/fs-jail agentId grammar
  const KEEP_DEFAULT = 50;                            // snapshots retained per agent (prune oldest beyond this)

  function makeCheckpointStore(deps) {
    const d = deps || {};
    const fs = d.fs, pathMod = d.pathMod, root = d.root, runGit = d.runGit;
    const clock = d.clock || { now: function () { return 0; } };
    const keep = d.keep != null ? d.keep : KEEP_DEFAULT;
    if (!fs || !pathMod || !root || typeof runGit !== 'function') throw new Error('checkpoint-store: fs/pathMod/root/runGit are required');

    const gitDirFor = (aid) => pathMod.join(root, '.checkpoints', aid, 'git');
    const workTreeFor = (aid) => pathMod.join(root, aid);
    const indexFileFor = (aid) => pathMod.join(root, '.checkpoints', aid, 'index.json');

    // the leading git args that pin the shadow git-dir + work-tree and force byte-exact, identity-stable commits.
    function base(aid) {
      return ['--git-dir', gitDirFor(aid), '--work-tree', workTreeFor(aid),
        '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
        '-c', 'user.email=skynet@local', '-c', 'user.name=skynet'];
    }
    const git = (aid, args) => runGit(base(aid).concat(args), { cwd: workTreeFor(aid) });

    function loadIndex(aid) {
      try { return cp.loadIndex(fs.readFileSync(indexFileFor(aid), 'utf8')); }
      catch (e) { return cp.toIndex([]); }            // missing/corrupt -> empty (fail-closed)
    }
    function saveIndex(aid, index) {                  // atomic temp+rename; throws on failure (the caller fail-opens)
      const f = indexFileFor(aid);
      fs.mkdirSync(pathMod.dirname(f), { recursive: true });
      const tmp = f + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cp.toIndex(index.snapshots)));
      fs.renameSync(tmp, f);
    }

    // best-effort size of the snapshot (cosmetic, for the event) — tracked file count + summed bytes.
    async function measure(aid) {
      try {
        const r = await git(aid, ['ls-files']);
        const files = r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
        let bytes = 0;
        for (const rel of files) { try { bytes += fs.statSync(pathMod.join(workTreeFor(aid), rel)).size; } catch (_) {} }
        return { files: files.length, bytes: bytes };
      } catch (e) { return { files: 0, bytes: 0 }; }
    }

    /* snapshot — capture the agent's CURRENT workspace state (taken BEFORE a mutating tool, so it is the
       pre-mutation rollback point). Deduped by content: if nothing changed since the last snapshot, no new
       commit is made and the existing head is returned (created:false). Fail-open: returns null on any git error. */
    async function snapshot(agentId, meta) {
      meta = meta || {};
      if (!AID_RE.test(String(agentId || ''))) return null;
      const aid = String(agentId);
      try {
        fs.mkdirSync(workTreeFor(aid), { recursive: true });
        fs.mkdirSync(gitDirFor(aid), { recursive: true });
        // init the shadow repo once (idempotent: re-running init on an existing repo is harmless).
        if (!fs.existsSync(pathMod.join(gitDirFor(aid), 'HEAD'))) {
          const ini = await git(aid, ['init', '-q']);
          if (ini.code !== 0) return null;
        }
        const add = await git(aid, ['add', '-A']);
        if (add.code !== 0) return null;
        const hasHead = (await git(aid, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
        if (hasHead) {
          const diff = await git(aid, ['diff', '--cached', '--quiet', 'HEAD']);   // code 0 => nothing staged changed
          if (diff.code === 0) {
            const head = (await git(aid, ['rev-parse', 'HEAD'])).stdout.trim();
            return cp.isValidId(head) ? { id: head, created: false, files: 0, bytes: 0 } : null;
          }
        }
        const label = meta.label != null ? String(meta.label) : 'snapshot';
        const commitArgs = ['commit', '-q', '-m', label];
        if (!hasHead) commitArgs.push('--allow-empty');                          // baseline even for an empty workspace
        const com = await git(aid, commitArgs);
        if (com.code !== 0) return null;
        const sha = (await git(aid, ['rev-parse', 'HEAD'])).stdout.trim();
        if (!cp.isValidId(sha)) return null;
        const size = await measure(aid);
        try {
          const index = cp.record(loadIndex(aid),
            { id: sha, runId: meta.runId, turn: meta.turn, label: label, files: size.files, bytes: size.bytes },
            { now: clock.now(), keep: keep });
          saveIndex(aid, index);
        } catch (e) { /* index persistence failed — the git commit still exists + is restorable; don't crash */ }
        return { id: sha, created: true, files: size.files, bytes: size.bytes };
      } catch (e) { return null; }                                               // fail-open
    }

    /* restore — hard-reset the agent's work-tree to a snapshot (and remove files created since). Only restores a
       snapshotId that is RECORDED in this agent's index — never an arbitrary ref. Returns false on any failure. */
    async function restore(agentId, snapshotId) {
      if (!AID_RE.test(String(agentId || '')) || !cp.isValidId(String(snapshotId || ''))) return false;
      const aid = String(agentId), sha = String(snapshotId);
      if (!cp.findById(loadIndex(aid), sha)) return false;                        // refuse an id we didn't record
      try {
        const reset = await git(aid, ['reset', '--hard', '-q', sha]);
        if (reset.code !== 0) return false;
        await git(aid, ['clean', '-fd', '-q']);                                  // drop files added after the snapshot
        return true;
      } catch (e) { return false; }
    }

    function list(agentId) { return AID_RE.test(String(agentId || '')) ? loadIndex(String(agentId)) : cp.toIndex([]); }

    return { snapshot: snapshot, restore: restore, list: list, isValidId: cp.isValidId };
  }

  return { makeCheckpointStore: makeCheckpointStore };
});
