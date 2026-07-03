/* sidecar/memory-store.js - durable per-agent memory KV routing.

   The notebook, todo, declined, and minted stores intentionally share one injected store contract, but they
   do not share the same on-disk file: notebook:<agent> is durable long-term memory, todo:<agent> is the active
   task plan that must survive restarts/compaction, declined:<agent> is the permanent reject-list of memory
   proposals the Commander Discarded (so reflection never re-proposes them — §5.6 "discard = never again").
   Unknown keys are rejected instead of being accidentally mapped into a notebook filename. */
'use strict';

const { makeDurableJsonStore } = require('./durable-store.js');

function agentIdFromKey(key, prefix) {
  const raw = String(key || '').replace(prefix, '') || 'agent';
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(raw)) throw new Error('bad memory agentId');
  return raw;
}

function memoryFileFor(workspaces, pathMod, key) {
  const k = String(key || '');
  if (k.indexOf('notebook:') === 0) return pathMod.join(workspaces, agentIdFromKey(k, /^notebook:/) + '.notebook.json');
  if (k.indexOf('todo:') === 0) return pathMod.join(workspaces, agentIdFromKey(k, /^todo:/) + '.todo.json');
  if (k.indexOf('declined:') === 0) return pathMod.join(workspaces, agentIdFromKey(k, /^declined:/) + '.declined.json');
  if (k.indexOf('minted:') === 0) return pathMod.join(workspaces, agentIdFromKey(k, /^minted:/) + '.minted.json');
  throw new Error('unsupported memory store key: ' + k);
}

function makeMemoryStore(deps) {
  deps = deps || {};
  const pathMod = deps.path;
  const workspaces = deps.workspaces;
  if (!pathMod || typeof pathMod.join !== 'function') throw new Error('makeMemoryStore: path module required');
  if (!workspaces) throw new Error('makeMemoryStore: workspaces path required');

  const durable = makeDurableJsonStore({
    fs: deps.fs,
    path: pathMod,
    fileFor: key => memoryFileFor(workspaces, pathMod, key),
    writeDurable: deps.writeDurable,
    onRecover: deps.onRecover,
    onCorrupt: deps.onCorrupt
  });
  const warn = typeof deps.warn === 'function' ? deps.warn : function () {};

  return {
    get(key) {
      try { return durable.get(key); }
      catch (e) { return undefined; }
    },
    set(key, value) {
      try { durable.set(key, value); }
      catch (e) { warn('[memory] persist failed:', (e && e.message) || e); }
    },
    update(key, mutator) {
      return durable.update(key, mutator);
    },
    readKey(key) {
      return durable.readKey(key);
    },
    _durable: durable
  };
}

// Wipe all of ONE agent's per-store memory — its kept notebook, its permanent declined reject-list, and its
// active todo plan — so a re-commissioned hero starts clean (no prior Commander's beliefs bleed in). Best-effort
// per key: a single unwritable file never blocks the others. Pure over the injected store, so it is unit-testable
// without booting the server (the new-hero clean-slate is a named hard rule, not just a source-grep).
async function resetAgentMemory(store, agentId) {
  const id = String(agentId || 'agent');
  for (const key of ['notebook:' + id, 'declined:' + id, 'todo:' + id, 'minted:' + id]) {
    try { await store.update(key, () => []); } catch (_) {}
  }
}

// Remove ONE entry from an agent's permanent declined reject-list (the undo-a-discard escape hatch), so a belief
// the Commander discarded by mistake can be proposed again. Returns whether anything was actually removed. Pure
// over the injected store → unit-testable without booting the server.
async function restoreDeclined(store, agentId, text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return false;
  let removed = false;
  await store.update('declined:' + String(agentId || 'agent'), (stored) => {
    const list = Array.isArray(stored) ? stored.slice() : [];
    const i = list.indexOf(t);
    if (i >= 0) { list.splice(i, 1); removed = true; }
    return list;
  });
  return removed;
}

module.exports = { makeMemoryStore, memoryFileFor, resetAgentMemory, restoreDeclined };
