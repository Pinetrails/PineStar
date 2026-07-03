/* sidecar/workshop-store.js — durable per-agent AWAY-WORKSHOP state (grant + backlog + discard denylist).

   The Away Workshop lets an agent BUILD a reviewable deliverable inside its own jailed workspace while the
   Commander is away (see docs/AWAY_WORKSHOP_PLAN.md). Three pieces of per-agent state must survive a sidecar
   restart, so they live in one durable single-file store per agent — `<agentId>.workshop.json` under WORKSPACES:

     grant     — boolean: the Commander's recorded "Build things while I'm away" consent for THIS agent. A
                 recorded yes (never self-granted); flipping it OFF revokes the write refinement AND disarms the
                 shift routine (index.js owns the cron side). NOT an XP unlock — a plain consent toggle.
     backlog   — the ordered queue of things to build: explicit user-queued items + accepted quests only
                 (goal-arc milestones opt-in later). Each item: { id, title, detail, source, ts, decidedRunId? }.
                 An item is POPPED (marked in-flight) when a shift builds it; a built item carries the runId that
                 produced its deliverable so the return-card can find the manifest.
     denylist  — the permanent set of backlogIds the Commander DISCARDED (reuse of the memory-question
                 "discard = never again" pattern) so a discarded item is never silently re-queued/retried.

   Pure over an injected durable store (makeDurableJsonStore from durable-store.js) — crash-safe (fsync + .bak
   last-known-good), concurrency-safe (per-key async mutex + re-read-under-lock in update()), and unit-testable
   against an in-memory fs. The Node host (index.js) injects the real fs/path and the WORKSPACES root. No ambient
   clock/rng in this module: a timestamp is passed in by the caller (now), matching the memory-store discipline. */
'use strict';

const { makeDurableJsonStore } = require('./durable-store.js');

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DENYLIST_CAP = 500;   // FIFO cap on the permanent discarded-backlogId list (per agent)
const BACKLOG_CAP = 200;    // FIFO cap on queued items (oldest un-built drop off if the queue floods)

function agentIdOf(key) {
  const raw = String(key || '').replace(/^workshop:/, '') || 'agent';
  if (!ID_RE.test(raw)) throw new Error('bad workshop agentId');
  return raw;
}

// the on-disk shape, normalized so a partial/legacy/absent file always loads to a full, safe record.
function normalize(stored) {
  const s = (stored && typeof stored === 'object') ? stored : {};
  return {
    grant: s.grant === true,
    backlog: Array.isArray(s.backlog) ? s.backlog.filter(it => it && typeof it === 'object' && it.id) : [],
    denylist: Array.isArray(s.denylist) ? s.denylist.filter(x => x != null).map(String).filter(Boolean) : []
  };
}

function makeWorkshopStore(deps) {
  deps = deps || {};
  const pathMod = deps.path;
  const workspaces = deps.workspaces;
  if (!pathMod || typeof pathMod.join !== 'function') throw new Error('makeWorkshopStore: path module required');
  if (!workspaces) throw new Error('makeWorkshopStore: workspaces path required');

  const durable = makeDurableJsonStore({
    fs: deps.fs,
    path: pathMod,
    fileFor: key => pathMod.join(workspaces, agentIdOf(key) + '.workshop.json'),
    writeDurable: deps.writeDurable,
    onRecover: deps.onRecover,
    onCorrupt: deps.onCorrupt
  });
  const warn = typeof deps.warn === 'function' ? deps.warn : function () {};
  const keyOf = id => 'workshop:' + String(id || 'agent');

  // ---- reads (sync, recovery-aware) ----
  function read(agentId) {
    try { return normalize(durable.get(keyOf(agentId))); }
    catch (e) { warn('[workshop] read failed:', (e && e.message) || e); return normalize(null); }
  }
  function hasGrant(agentId) { return read(agentId).grant === true; }
  // undecided = queued items NOT on the denylist and NOT already built-and-awaiting-decision is handled by
  // the caller (pending manifests come from run dirs); here `backlog` is the raw queue for the driver.
  function backlogOf(agentId) { return read(agentId).backlog.slice(); }
  function isDenied(agentId, backlogId) { return read(agentId).denylist.indexOf(String(backlogId)) >= 0; }

  // ---- writes (serialized per agent via the durable mutex) ----
  function setGrant(agentId, on) {
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      rec.grant = on === true;
      return rec;
    });
  }

  // add a build request to the queue. item: { id, title, detail?, source? }. now = injected ms. A duplicate id or
  // a denylisted id is a no-op (returns the item that already exists / null). Returns the stored item.
  function queue(agentId, item, now) {
    const it = item || {};
    const id = String(it.id || '').trim();
    if (!id) throw new Error('workshop.queue: item.id required');
    let out = null;
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      if (rec.denylist.indexOf(id) >= 0) { out = null; return rec; }          // discarded once → never re-queue
      const existing = rec.backlog.find(b => b.id === id);
      if (existing) { out = existing; return rec; }                            // idempotent add
      out = {
        id: id,
        title: String(it.title || '').slice(0, 200),
        detail: String(it.detail || '').slice(0, 4000),
        source: String(it.source || 'queued').slice(0, 40),   // 'queued' | 'quest'
        ts: Number(now) || 0
      };
      rec.backlog.push(out);
      while (rec.backlog.length > BACKLOG_CAP) rec.backlog.shift();
      return rec;
    }).then(() => out);
  }

  // pop the TOP un-built backlog item for a shift. Returns the item (leaving it in the backlog, stamped with the
  // runId that is building it) or null when the queue is empty. Stamping in-flight lets a completed build map its
  // manifest back to the backlogId and lets the driver skip an item already being built.
  function claimNext(agentId, runId) {
    let claimed = null;
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      const next = rec.backlog.find(b => !b.buildingRunId && !b.builtRunId);
      if (!next) { claimed = null; return undefined; }   // no change, no write
      next.buildingRunId = String(runId || '');
      claimed = next;
      return rec;
    }).then(() => claimed);
  }

  // mark a claimed item BUILT (a valid manifest landed) — records the runId so the return-card finds the dir.
  function markBuilt(agentId, backlogId, runId) {
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      const it = rec.backlog.find(b => b.id === String(backlogId));
      if (!it) return undefined;
      delete it.buildingRunId; it.builtRunId = String(runId || '');
      return rec;
    });
  }

  // release a claim without building (empty/invalid/failed shift) so the item stays queued for a later shift.
  function releaseClaim(agentId, runId) {
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      let changed = false;
      for (const b of rec.backlog) { if (b.buildingRunId === String(runId || '')) { delete b.buildingRunId; changed = true; } }
      return changed ? rec : undefined;
    });
  }

  // DISCARD: remove the item from the backlog AND denylist its id forever (never silently re-queued/retried).
  function discard(agentId, backlogId) {
    const id = String(backlogId || '');
    if (!id) return Promise.resolve();
    return durable.update(keyOf(agentId), (cur) => {
      const rec = normalize(cur);
      rec.backlog = rec.backlog.filter(b => b.id !== id);
      if (rec.denylist.indexOf(id) < 0) { rec.denylist.push(id); while (rec.denylist.length > DENYLIST_CAP) rec.denylist.shift(); }
      return rec;
    });
  }

  // find the backlog item a given build run produced (by builtRunId or buildingRunId) — used on decide.
  function itemForRun(agentId, runId) {
    const rid = String(runId || '');
    return read(agentId).backlog.find(b => b.builtRunId === rid || b.buildingRunId === rid) || null;
  }

  return {
    read, hasGrant, setGrant, backlogOf, isDenied,
    queue, claimNext, markBuilt, releaseClaim, discard, itemForRun,
    _durable: durable
  };
}

module.exports = { makeWorkshopStore, normalize, _internals: { agentIdOf } };
