/* sidecar/deliverable-store.js — durable lifecycle index for Workshop deliverables.

   Run artifacts already live in runs.jsonl and pending Workshop builds already live in the Workshop backlog.
   This store records only the truth those authorities otherwise erase: kept/discarded/failed lifecycle rows and
   bounded cleanup undo batches. It owns metadata, never artifact bytes. */
'use strict';

const { makeDurableJsonStore } = require('./durable-store.js');

// Sets, not object literals: `({a:1})['constructor']` is truthy, so an object-literal allowlist
// silently admits every Object.prototype key — and these keys come off persisted/model-supplied data.
const STATUS = new Set(['kept', 'discarded', 'failed']);
const SOURCE_MAX = 40, TEXT_MAX = 260, ROW_CAP = 2000, UNDO_CAP = 20, FILE_CAP = 50;

function text(v, n) { return String(v == null ? '' : v).slice(0, n || TEXT_MAX); }
function filesOf(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, FILE_CAP).map(f => {
    const row = { path: text(f && f.path) };
    if (f && Number.isFinite(f.bytes) && f.bytes >= 0) row.bytes = Math.floor(f.bytes);
    return row;
  }).filter(f => f.path);
}
function rowOf(v, now) {
  v = v && typeof v === 'object' ? v : {};
  const id = text(v.id);
  if (!id) return null;
  return {
    id,
    agentId: text(v.agentId, 40), runId: text(v.runId, 80), title: text(v.title, 200),
    source: text(v.source || 'workshop', SOURCE_MAX), status: STATUS.has(v.status) ? v.status : 'failed',
    kind: text(v.kind || 'files', 20), summary: text(v.summary, 1000), files: filesOf(v.files),
    createdAt: Number(v.createdAt) || Number(now) || 0, updatedAt: Number(now) || Number(v.updatedAt) || 0
  };
}
function normalize(v) {
  const s = v && typeof v === 'object' ? v : {};
  const rows = Array.isArray(s.rows) ? s.rows.map(r => rowOf(r, r && r.updatedAt)).filter(Boolean).slice(-ROW_CAP) : [];
  const undo = Array.isArray(s.undo) ? s.undo.filter(x => x && x.token && Array.isArray(x.rows)).slice(-UNDO_CAP) : [];
  return { v: 1, rows, undo };
}
function fingerprint(rows) {
  return rows.map(r => [r.id, r.status, r.updatedAt].join(':')).sort().join('|');
}

function makeDeliverableStore(deps) {
  deps = deps || {};
  if (!deps.path || !deps.workspaces) throw new Error('makeDeliverableStore: path/workspaces required');
  const durable = makeDurableJsonStore({
    fs: deps.fs, path: deps.path,
    fileFor: () => deps.path.join(deps.workspaces, 'deliverables.library.json'),
    writeDurable: deps.writeDurable, onRecover: deps.onRecover, onCorrupt: deps.onCorrupt
  });
  const KEY = 'deliverables';
  function read() { try { return normalize(durable.get(KEY)); } catch (_) { return normalize(null); } }
  function list() { return read().rows.slice().sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id)).map(r => Object.assign({}, r, { files: r.files.map(f => Object.assign({}, f)) })); }
  function record(row, now) {
    const clean = rowOf(row, now);
    if (!clean) return Promise.reject(new Error('deliverable id required'));
    return durable.update(KEY, cur => {
      const s = normalize(cur);
      const i = s.rows.findIndex(r => r.id === clean.id);
      if (i >= 0) { clean.createdAt = s.rows[i].createdAt || clean.createdAt; s.rows[i] = clean; }
      else s.rows.push(clean);
      while (s.rows.length > ROW_CAP) s.rows.shift();
      return s;
    }).then(() => clean);
  }
  function previewCleanup(opts) {
    opts = opts || {};
    const wanted = Array.isArray(opts.statuses) && opts.statuses.length ? opts.statuses.filter(s => STATUS.has(s)) : ['discarded', 'failed'];
    const all = list();
    const targets = all.filter(r => wanted.indexOf(r.status) >= 0);
    const protectedRows = all.filter(r => wanted.indexOf(r.status) < 0);
    return { statuses: wanted, targets, protected: protectedRows, fingerprint: fingerprint(targets) };
  }
  function applyCleanup(preview, token, now) {
    preview = preview || {};
    token = text(token, 100);
    if (!token) return Promise.resolve({ ok: false, reason: 'undo-token-required' });
    let out = { ok: false, reason: 'preview-stale' };
    return durable.update(KEY, cur => {
      const s = normalize(cur);
      const wanted = Array.isArray(preview.statuses) ? preview.statuses.filter(x => STATUS.has(x)) : [];
      const current = s.rows.filter(r => wanted.indexOf(r.status) >= 0);
      if (fingerprint(current) !== String(preview.fingerprint || '')) return undefined;
      const ids = new Set(current.map(r => r.id));
      s.rows = s.rows.filter(r => !ids.has(r.id));
      s.undo = s.undo.filter(b => b.token !== token);
      s.undo.push({ token, at: Number(now) || 0, rows: current });
      while (s.undo.length > UNDO_CAP) s.undo.shift();
      out = { ok: true, removed: current.length, undoToken: token };
      return s;
    }).then(() => out);
  }
  function undoCleanup(token, now) {
    token = text(token, 100);
    let out = { ok: false, reason: 'not-found', restored: 0 };
    return durable.update(KEY, cur => {
      const s = normalize(cur);
      const i = s.undo.findIndex(b => b.token === token);
      if (i < 0) return undefined;
      const batch = s.undo[i]; s.undo.splice(i, 1);
      let restored = 0;
      for (const old of batch.rows) {
        if (s.rows.some(r => r.id === old.id)) continue;
        const row = rowOf(old, old.updatedAt || now); if (row) { s.rows.push(row); restored++; }
      }
      out = { ok: true, restored };
      return s;
    }).then(() => out);
  }
  return { read, list, record, previewCleanup, applyCleanup, undoCleanup, _durable: durable };
}

module.exports = { makeDeliverableStore, normalize };
