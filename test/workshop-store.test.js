/* node test/workshop-store.test.js — the durable per-agent AWAY WORKSHOP store (grant + backlog + denylist).

   Proves grant persistence round-trips, the backlog queue is idempotent + FIFO-capped, claim/build/release track
   the building runId, and DISCARD both removes the item AND permanently denylists its backlogId so it is never
   silently re-queued (the memory-question "discard = never again" invariant, ported). Runs against an in-memory
   fs so it needs no disk and stays deterministic (timestamps are injected). */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeWorkshopStore, normalize } = require('../sidecar/workshop-store.js');

// ---- a tiny in-memory fs sufficient for durable-store (readFileSync/writeFileSync/rename/mkdirSync/...) ----
function memFs() {
  const files = new Map();
  return {
    _files: files,
    readFileSync(f) { if (!files.has(String(f))) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(String(f)); },
    writeFileSync(f, data) { files.set(String(f), String(data)); },
    renameSync(a, b) { files.set(String(b), files.get(String(a))); files.delete(String(a)); },
    existsSync(f) { return files.has(String(f)); },
    mkdirSync() {},
    unlinkSync(f) { files.delete(String(f)); },
    openSync() { return 1; }, fsyncSync() {}, closeSync() {}
  };
}
// a durable-write shim that just does the atomic replace over the mem fs (no real fsync).
const writeDurable = ({ fs }, file, data) => { fs.writeFileSync(file, data); };

function freshStore() {
  return makeWorkshopStore({ fs: memFs(), path: path, workspaces: '/ws', writeDurable });
}

(async () => {
  // ---- 1. grant defaults false, round-trips true, and a fresh store over the SAME fs reads it back ----
  {
    const fs = memFs();
    const s1 = makeWorkshopStore({ fs, path, workspaces: '/ws', writeDurable });
    A.ok(s1.hasGrant('hero') === false, 'grant defaults to false for a brand-new agent');
    await s1.setGrant('hero', true);
    A.ok(s1.hasGrant('hero') === true, 'grant reads back true after setGrant');
    const s2 = makeWorkshopStore({ fs, path, workspaces: '/ws', writeDurable });   // fresh instance, same disk
    A.ok(s2.hasGrant('hero') === true, 'grant SURVIVES a fresh store (persisted, restart-safe)');
    await s2.setGrant('hero', false);
    A.ok(s2.hasGrant('hero') === false, 'grant flips back to false');
  }

  // ---- 2. queue: idempotent by id, denylisted ids refused, FIFO order preserved ----
  {
    const s = freshStore();
    const a = await s.queue('hero', { id: 'b1', title: 'Build a CSV cleaner', source: 'queued' }, 1000);
    A.ok(a && a.id === 'b1', 'queue returns the stored item');
    const dup = await s.queue('hero', { id: 'b1', title: 'again' }, 2000);
    A.ok(dup && dup.title === 'Build a CSV cleaner', 'queue is idempotent by id (keeps the first)');
    await s.queue('hero', { id: 'b2', title: 'second' }, 3000);
    const bl = s.backlogOf('hero');
    A.eq(bl.map(x => x.id), ['b1', 'b2'], 'backlog preserves FIFO insertion order');
  }

  // ---- 3. claimNext pops the top un-built item and stamps the building runId; empty queue -> null ----
  {
    const s = freshStore();
    A.ok((await s.claimNext('nobody', 'runX')) === null, 'claimNext on an empty backlog returns null (silent no-op)');
    await s.queue('hero', { id: 'b1', title: 'first' }, 1);
    await s.queue('hero', { id: 'b2', title: 'second' }, 2);
    const c = await s.claimNext('hero', 'run-1');
    A.ok(c && c.id === 'b1', 'claimNext returns the TOP item');
    A.eq(s.itemForRun('hero', 'run-1').id, 'b1', 'itemForRun maps the building runId back to the item');
    const c2 = await s.claimNext('hero', 'run-2');
    A.ok(c2 && c2.id === 'b2', 'a second claim skips the already-building item and takes the next');
    A.ok((await s.claimNext('hero', 'run-3')) === null, 'no un-built items left -> null');
  }

  // ---- 4. markBuilt records the runId; releaseClaim frees an un-built claim back to the queue ----
  {
    const s = freshStore();
    await s.queue('hero', { id: 'b1', title: 'x' }, 1);
    await s.claimNext('hero', 'run-1');
    await s.markBuilt('hero', 'b1', 'run-1');
    A.eq(s.itemForRun('hero', 'run-1').builtRunId, 'run-1', 'markBuilt stamps builtRunId');
    // a built item is not re-claimed
    A.ok((await s.claimNext('hero', 'run-2')) === null, 'a built item is not re-claimed by a later shift');

    const s2 = freshStore();
    await s2.queue('hero', { id: 'c1', title: 'y' }, 1);
    await s2.claimNext('hero', 'run-9');
    await s2.releaseClaim('hero', 'run-9');
    const again = await s2.claimNext('hero', 'run-10');
    A.ok(again && again.id === 'c1', 'releaseClaim returns an un-built item to the queue for a later shift');
  }

  // ---- 5. DISCARD removes the item AND denylists its id forever (never re-queued) — the core invariant ----
  {
    const s = freshStore();
    await s.queue('hero', { id: 'b1', title: 'bad idea' }, 1);
    await s.discard('hero', 'b1');
    A.eq(s.backlogOf('hero').map(x => x.id), [], 'discard removes the item from the backlog');
    A.ok(s.isDenied('hero', 'b1') === true, 'discarded id is on the permanent denylist');
    const re = await s.queue('hero', { id: 'b1', title: 'sneaking it back' }, 5);
    A.ok(re === null, 'a discarded id is REFUSED on re-queue (discard = never again)');
    A.eq(s.backlogOf('hero').length, 0, 'the denylisted item never re-enters the backlog');
    // denylist survives a fresh store
    const fs = s._durable; A.ok(fs, 'durable handle exposed');
  }

  // ---- 6. denylist persists across a fresh store instance ----
  {
    const fs = memFs();
    const s1 = makeWorkshopStore({ fs, path, workspaces: '/ws', writeDurable });
    await s1.queue('hero', { id: 'z1', title: 'q' }, 1);
    await s1.discard('hero', 'z1');
    const s2 = makeWorkshopStore({ fs, path, workspaces: '/ws', writeDurable });
    A.ok(s2.isDenied('hero', 'z1') === true, 'denylist survives a restart (durable)');
    A.ok((await s2.queue('hero', { id: 'z1', title: 'q2' }, 2)) === null, 'restart-loaded denylist still refuses');
  }

  // ---- 7. normalize is defensive: partial/legacy/absent records load to a full safe shape ----
  {
    A.eq(normalize(null), { grant: false, backlog: [], denylist: [] }, 'null -> empty safe record');
    A.eq(normalize({ grant: true }).grant, true, 'partial record keeps its grant');
    A.eq(normalize({ backlog: [{ id: 'ok' }, { nope: 1 }, 'junk'] }).backlog.length, 1, 'backlog drops entries without an id');
    A.eq(normalize({ denylist: ['a', 1, null, 'b'] }).denylist, ['a', '1', 'b'], 'denylist coerces to non-empty strings');
  }

  // ---- 8. bad agentId is rejected (no path traversal into the sibling store filename) ----
  {
    const s = freshStore();
    A.ok(s.hasGrant('../evil') === false, 'a traversal agentId cannot read a grant (rejected -> false)');
    let threw = false;
    try { await s.setGrant('../evil', true); } catch (_) { threw = true; }
    A.ok(threw, 'setGrant rejects a bad agentId (fileFor throws before any write)');
  }

  A.report('workshop-store.test');
})();
