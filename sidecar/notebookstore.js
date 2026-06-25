/* sidecar/notebookstore.js - hardened persistent notebook store.

   Keeps the legacy { get(key), set(key, records) } contract while adding:
     - CAS drift detection against out-of-band edits
     - durable atomic writes via writeFileDurable when injected
     - hard record/count/agent-size budgets
     - mutate()/batch() for atomic read-modify-write operations

   Stored file format stays the existing plain JSON array for backward compatibility. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.notebookstore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  const DEFAULT_LIMITS = {
    maxRecords: 240,
    maxRecordChars: 4096,
    maxAgentBytes: 512 * 1024
  };

  function fnv1a(s) {
    s = String(s == null ? '' : s);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function cloneRecords(records) {
    return (Array.isArray(records) ? records : []).map(r => (r && typeof r === 'object') ? Object.assign({}, r) : r);
  }
  function recordText(r) {
    if (!r) return '';
    if (r.content != null) return String(r.content);
    return String(r.title || '') + ' ' + String(r.body || '');
  }
  function validateRecords(records, limits) {
    const recs = Array.isArray(records) ? records : [];
    if (recs.length > limits.maxRecords) throw new Error('notebook budget exceeded: too many records');
    const ids = {};
    for (const r of recs) {
      if (!r || typeof r !== 'object') throw new Error('notebook record must be an object');
      if (r.id != null) {
        const id = String(r.id);
        if (ids[id]) throw new Error('notebook has duplicate memory id: ' + id);
        ids[id] = true;
      }
      if (recordText(r).length > limits.maxRecordChars) throw new Error('notebook budget exceeded: record is too large');
    }
    const data = JSON.stringify(recs);
    if (data.length > limits.maxAgentBytes) throw new Error('notebook budget exceeded: agent memory is too large');
    return data;
  }
  function normalizeMutationResult(result) {
    if (Array.isArray(result)) return { records: result };
    if (result && typeof result === 'object' && Array.isArray(result.records)) return result;
    throw new Error('notebook mutation must return records');
  }

  function makeNotebookStore(deps) {
    const d = deps || {};
    const fs = d.fs;
    const pathMod = d.pathMod;
    const rootDir = d.root;
    const clock = d.clock;
    const writeFileDurable = d.writeFileDurable;
    const limits = Object.assign({}, DEFAULT_LIMITS, d.limits || {});
    if (!fs || typeof fs.readFileSync !== 'function' || typeof fs.writeFileSync !== 'function' || typeof fs.renameSync !== 'function')
      throw new Error('makeNotebookStore: an injected fs (readFileSync/writeFileSync/renameSync) is required');
    if (!pathMod || typeof pathMod.join !== 'function' || typeof pathMod.dirname !== 'function') throw new Error('makeNotebookStore: an injected pathMod is required');
    if (!rootDir) throw new Error('makeNotebookStore: a root dir is required');
    if (!clock || typeof clock.now !== 'function') throw new Error('makeNotebookStore: an injected clock is required');

    const seen = {};
    let tmpSeq = 0;

    function keyAgent(key) {
      const aid = String(key).replace(/^notebook:/, '') || 'agent';
      if (!AID_RE.test(aid)) throw new Error('bad notebook agentId');
      return aid;
    }
    function fileForKey(key) { return pathMod.join(rootDir, keyAgent(key) + '.notebook.json'); }
    function ensureRoot(file) { try { if (fs.mkdirSync) fs.mkdirSync(pathMod.dirname(file), { recursive: true }); } catch (_) {} }
    function readFile(file) {
      try {
        const text = String(fs.readFileSync(file, 'utf8'));
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) return { exists: true, corrupt: true, text: text, hash: fnv1a(text), records: undefined };
        return { exists: true, corrupt: false, text: text, hash: fnv1a(text), records: parsed };
      } catch (e) {
        if (e && e.code === 'ENOENT') return { exists: false, corrupt: false, text: '', hash: fnv1a(''), records: undefined };
        if (e && e.code) return { exists: false, corrupt: true, text: '', hash: fnv1a(''), records: undefined };
        return { exists: true, corrupt: true, text: '', hash: fnv1a(''), records: undefined };
      }
    }
    function writeAtomic(file, data) {
      ensureRoot(file);
      if (typeof writeFileDurable === 'function') {
        writeFileDurable({ fs: fs, path: pathMod, randomTmpId: () => String(++tmpSeq) }, file, data);
        return;
      }
      const tmp = file + '.' + (++tmpSeq) + '.tmp';
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, file);
    }
    function checkExpected(file, before, expectedHash) {
      if (expectedHash && before.hash !== expectedHash) {
        const e = new Error('notebook drift detected: file changed since it was read');
        e.code = 'NOTEBOOK_DRIFT';
        throw e;
      }
    }

    function get(key) {
      const file = fileForKey(key);
      const before = readFile(file);
      seen[file] = before.hash;
      return Array.isArray(before.records) ? cloneRecords(before.records) : undefined;
    }

    function set(key, value) {
      const file = fileForKey(key);
      const before = readFile(file);
      checkExpected(file, before, seen[file]);
      const records = cloneRecords(value);
      const data = validateRecords(records, limits);
      writeAtomic(file, data);
      seen[file] = fnv1a(data);
      return { ok: true, hash: seen[file], count: records.length };
    }

    function mutate(key, fn, opts) {
      if (typeof fn !== 'function') throw new Error('notebook mutate requires a function');
      opts = opts || {};
      const file = fileForKey(key);
      const before = readFile(file);
      checkExpected(file, before, opts.expectedHash || seen[file]);
      const current = Array.isArray(before.records) ? cloneRecords(before.records) : [];
      const result = normalizeMutationResult(fn(current, { hash: before.hash, file: file, now: clock.now() }));
      const records = cloneRecords(result.records);
      if (!result.skipWrite) {
        const data = validateRecords(records, limits);
        writeAtomic(file, data);
        seen[file] = fnv1a(data);
      } else {
        seen[file] = before.hash;
      }
      return Object.assign({ ok: true, before: current, records: records, hash: seen[file] }, result);
    }

    function batch(key, ops) {
      return mutate(key, list => {
        let records = cloneRecords(list);
        for (const op of (Array.isArray(ops) ? ops : [])) {
          if (!op || typeof op !== 'object') continue;
          if (op.op === 'add') {
            if (!op.record || typeof op.record !== 'object') throw new Error('batch add requires record');
            records = records.concat([Object.assign({}, op.record)]);
          } else if (op.op === 'edit') {
            let found = false;
            records = records.map(r => {
              if (!found && r && r.id === op.id) { found = true; return Object.assign({}, r, { content: String(op.content || ''), body: String(op.content || '') }); }
              return r;
            });
            if (!found) throw new Error('batch edit missing id: ' + op.id);
          } else if (op.op === 'forget') {
            let found = false;
            records = records.filter(r => {
              if (!found && r && r.id === op.id) { found = true; return false; }
              return true;
            });
            if (!found) throw new Error('batch forget missing id: ' + op.id);
          } else if (op.op === 'pin') {
            let found = false;
            records = records.map(r => {
              if (!found && r && r.id === op.id) { found = true; return Object.assign({}, r, { pinned: !!op.pinned }); }
              return r;
            });
            if (!found) throw new Error('batch pin missing id: ' + op.id);
          } else {
            throw new Error('unknown notebook batch op: ' + op.op);
          }
        }
        return { records: records };
      });
    }

    return { get, set, mutate, batch, fileForKey, limits: () => Object.assign({}, limits), _internals: { fnv1a, validateRecords, AID_RE } };
  }

  return { makeNotebookStore, _internals: { AID_RE, DEFAULT_LIMITS, fnv1a, validateRecords } };
});
