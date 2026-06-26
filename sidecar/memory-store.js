/* sidecar/memory-store.js - durable per-agent memory KV routing.

   The notebook and todo tools intentionally share one injected store contract, but they do not share the
   same on-disk file: notebook:<agent> is durable long-term memory, while todo:<agent> is the active task
   plan that must survive restarts/compaction. Unknown keys are rejected instead of being accidentally
   mapped into a notebook filename. */
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

module.exports = { makeMemoryStore, memoryFileFor };
