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
  const cp = typeof require === 'function' ? require('./checkpoint.js') : (root.SK && root.SK.checkpoint);
  // durable single-file replace (fsync-before-rename); the injected-fs primitive degrades to writeFileSync+rename
  // for a test/in-memory fs without fsync, so it stays deterministic + testable.
  let dw = null;
  try { dw = typeof require === 'function' ? require('./durable-write.js') : (root.SK && root.SK.durableWrite); } catch (_) {}
  const api = factory(cp, dw && dw.writeFileDurable);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).checkpointStore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (cp, writeFileDurableInjected) {
  'use strict';

  // fallback: if durable-write couldn't be loaded (browser bundle), do a plain atomic temp+rename.
  const writeFileDurable = typeof writeFileDurableInjected === 'function' ? writeFileDurableInjected
    : function (deps, file, data) { const f = deps.fs; const tmp = file + '.' + (typeof process !== 'undefined' ? process.pid : 'p') + '.tmp'; f.writeFileSync(tmp, data); f.renameSync(tmp, file); };

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
        '-c', 'user.email=starnet@local', '-c', 'user.name=starnet'];
    }
    const git = (aid, args) => runGit(base(aid).concat(args), { cwd: workTreeFor(aid) });

    // read the index file into a tagged result so the caller can distinguish a genuinely-empty index (no
    // snapshots recorded) from a torn/corrupt one that should trigger a git-log rebuild.
    //   { status:'ok', index }   — parsed to a non-empty index
    //   { status:'empty' }       — parsed but zero snapshots (or a legitimately empty index)
    //   { status:'corrupt' }     — file present but unparseable / absent
    function readIndexRaw(aid) {
      let raw;
      try { raw = fs.readFileSync(indexFileFor(aid), 'utf8'); }
      catch (e) { return { status: 'corrupt' }; }     // absent OR unreadable — try recovery/rebuild
      if (raw == null || String(raw).length === 0) return { status: 'corrupt' };   // torn write
      let obj; try { obj = JSON.parse(raw); } catch (e) { return { status: 'corrupt' }; }
      const idx = cp.loadIndex(obj);
      return idx.snapshots.length ? { status: 'ok', index: idx } : { status: 'empty', index: idx };
    }
    // SYNC load: main index file, else its <file>.bak last-known-good, else empty. Never rebuilds (git is async).
    // Callers that CAN await use loadIndexResilient below to rebuild from the commit history when both are gone.
    function loadIndex(aid) {
      const m = readIndexRaw(aid);
      if (m.status === 'ok' || m.status === 'empty') return m.index;
      // main torn/corrupt/absent -> try the .bak snapshot.
      try {
        const braw = fs.readFileSync(indexFileFor(aid) + '.bak', 'utf8');
        if (braw && String(braw).length) { const b = cp.loadIndex(JSON.parse(braw)); if (b.snapshots.length) return b; }
      } catch (_) {}
      return cp.toIndex([]);                           // missing/corrupt + no .bak -> empty (fail-closed)
    }
    function saveIndex(aid, index) {                  // atomic + durable temp+rename with a .bak snapshot; throws on failure (the caller fail-opens)
      const f = indexFileFor(aid);
      fs.mkdirSync(pathMod.dirname(f), { recursive: true });
      // snapshot the current clean index to <file>.bak (durably) before overwriting, so a torn replace of the
      // index can be recovered from the prior committed copy. Best-effort — a .bak failure never blocks the save.
      try {
        const cur = fs.readFileSync(f, 'utf8');
        if (cur && String(cur).length) { try { JSON.parse(cur); writeFileDurable({ fs: fs, path: pathMod }, f + '.bak', cur); } catch (_) {} }
      } catch (_) {}
      writeFileDurable({ fs: fs, path: pathMod }, f, JSON.stringify(cp.toIndex(index.snapshots)));
    }

    // does this agent have a real shadow git repo on disk? (its commits are the ground truth for a rebuild.)
    function repoExists(aid) {
      try { return fs.existsSync(pathMod.join(gitDirFor(aid), 'HEAD')); } catch (_) { return false; }
    }
    /* rebuildIndexFromGit — the shadow git COMMITS are the truth; the index.json is just a cache of them. When
       the index is empty/corrupt but the repo has commits, reconstruct the index by walking `git log`. The
       commit subject is what snapshot() wrote as `label`; runId/turn aren't recoverable from git, so they come
       back empty/0 (rollback-by-run degrades, but per-id restore + the list view are fully restored). Oldest-
       first so lineage (parentId defaults to the prior snapshot) threads correctly through cp.record. */
    async function rebuildIndexFromGit(aid) {
      if (!repoExists(aid)) return cp.toIndex([]);
      // %H = full sha, %ct = committer unix seconds, %s = subject (the snapshot label). tab-separated, reverse
      // so the oldest commit is first (matches append order + parent lineage).
      const r = await git(aid, ['log', '--reverse', '--format=%H%x09%ct%x09%s']);
      if (!r || r.code !== 0 || !r.stdout) return cp.toIndex([]);
      let index = cp.toIndex([]);
      for (const line of r.stdout.split('\n')) {
        if (!line.trim()) continue;
        const tab1 = line.indexOf('\t'); if (tab1 < 0) continue;
        const tab2 = line.indexOf('\t', tab1 + 1);
        const sha = line.slice(0, tab1).trim();
        const ctSec = Number(line.slice(tab1 + 1, tab2 < 0 ? undefined : tab2).trim());
        const label = tab2 < 0 ? '' : line.slice(tab2 + 1);
        if (!cp.isValidId(sha)) continue;
        try {
          index = cp.record(index, { id: sha, runId: '', turn: 0, label: label, files: 0, bytes: 0 },
            { now: isFinite(ctSec) ? ctSec * 1000 : clock.now(), keep: keep });
        } catch (_) { /* skip a record git surfaced that cp rejects */ }
      }
      return index;
    }
    /* loadIndexResilient — the ASYNC load: the sync index/.bak first, and if BOTH are gone/empty while the
       shadow repo still holds commits, rebuild the index from git and RE-PERSIST it so subsequent sync reads
       are fast again. Used by every await-capable caller (snapshot/restore/the list route). */
    async function loadIndexResilient(aid) {
      const m = readIndexRaw(aid);
      if (m.status === 'ok') return m.index;
      // main empty/corrupt -> try .bak (sync), then git rebuild.
      const viaBak = loadIndex(aid);                   // consults main + .bak
      if (viaBak.snapshots.length) return viaBak;
      const rebuilt = await rebuildIndexFromGit(aid);
      if (rebuilt.snapshots.length) {
        try { saveIndex(aid, rebuilt); } catch (_) { /* rebuild still usable in-memory even if re-persist fails */ }
        try { console.warn('[checkpoint] rebuilt index for ' + aid + ' from ' + rebuilt.snapshots.length + ' shadow-git commits (index.json was empty/corrupt)'); } catch (_) {}
        return rebuilt;
      }
      return m.status === 'empty' ? m.index : cp.toIndex([]);
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
      // resilient load: if index.json was wiped but the commit still exists, a git-log rebuild re-admits it so
      // a rollback target survives an index loss (the commits are the truth).
      if (!cp.findById(await loadIndexResilient(aid), sha)) return false;         // refuse an id we didn't record
      try {
        const reset = await git(aid, ['reset', '--hard', '-q', sha]);
        if (reset.code !== 0) return false;
        await git(aid, ['clean', '-fd', '-q']);                                  // drop files added after the snapshot
        return true;
      } catch (e) { return false; }
    }

    function list(agentId) { return AID_RE.test(String(agentId || '')) ? loadIndex(String(agentId)) : cp.toIndex([]); }
    // async list that rebuilds from the shadow git commits when the index.json is empty/corrupt but the repo
    // has history — so the "rewind" UI repopulates after an index loss. The route awaits this.
    async function listResilient(agentId) {
      if (!AID_RE.test(String(agentId || ''))) return cp.toIndex([]);
      return await loadIndexResilient(String(agentId));
    }

    return { snapshot: snapshot, restore: restore, list: list, listResilient: listResilient, rebuild: rebuildIndexFromGit, isValidId: cp.isValidId };
  }

  return { makeCheckpointStore: makeCheckpointStore };
});
