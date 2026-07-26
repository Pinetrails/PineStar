/* sidecar/subagents.js - durable background subagent registry.

   team.dispatch(background:true) starts worker runs that outlive the tool call.
   This manager owns their observable state: status, event tail, result, abort
   controller, stale-on-restart marking, and resume. It deliberately emits only
   existing frozen events (task + agent.* forwarded by the runner), so it does
   not need shared/events.js changes.
*/
'use strict';
(function (root, factory) {
  let dw = null;
  try { dw = typeof require === 'function' ? require('./durable-write.js') : (root.SK && root.SK.durableWrite); } catch (_) {}
  const api = factory(dw && dw.writeFileDurable);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).subagents = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (writeFileDurableInjected) {
  'use strict';

  // durable single-file replace (fsync-before-rename); degrades to writeFileSync+rename for a test fs w/o fsync.
  const writeFileDurable = typeof writeFileDurableInjected === 'function' ? writeFileDurableInjected
    : function (deps, file, data) { const f = deps.fs; const tmp = file + '.' + (typeof process !== 'undefined' ? process.pid : 'p') + '.tmp'; f.writeFileSync(tmp, data); f.renameSync(tmp, file); };

  const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
  // Sets, not object literals: `({a:1})['constructor']` is truthy, so an object-literal allowlist
  // silently admits every Object.prototype key — and these keys come off persisted/model-supplied data.
  const TERMINAL = new Set(['done', 'error', 'refused', 'interrupted', 'stale']);
  const WATCH_EVENTS = new Set(['agent.run.start', 'agent.run.end', 'agent.run.error', 'agent.cost', 'checkpoint.created', 'verify.result', 'shell.exec']);

  function safeId(id, label) {
    id = String(id || '');
    if (!ID_RE.test(id)) throw new Error('bad ' + (label || 'id'));
    return id;
  }
  function clip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '...' : s;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function makeSubagentManager(deps) {
    deps = deps || {};
    const fs = deps.fs, P = deps.pathMod, file = deps.file;
    const now = (deps.clock && typeof deps.clock.now === 'function') ? deps.clock.now : function () { return 0; };
    const emit = typeof deps.emit === 'function' ? deps.emit : function () {};
    const keep = deps.keep || 200;
    let seq = 0;
    const newId = typeof deps.newId === 'function' ? deps.newId : function () { return 'sub_' + (++seq); };
    if (!fs || !P || !file) throw new Error('subagents.js requires { fs, pathMod, file }');

    let records = [];
    const controllers = new Map();

    function load() {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        records = raw && Array.isArray(raw.records) ? raw.records.filter(r => r && r.id) : [];
      } catch (_) { records = []; }
      let changed = false;
      records = records.map(r => {
        if (r.status === 'running' || r.status === 'queued') {
          changed = true;
          return Object.assign({}, r, { status: 'stale', reason: 'sidecar restarted before this worker finished', canResume: true, updatedAt: now() });
        }
        return r;
      });
      if (changed) save();
    }
    function save() {
      try {
        const dir = P.dirname(file);
        fs.mkdirSync(dir, { recursive: true });
        const body = { version: 1, records: records.slice(-keep) };
        // durable (fsync-before-rename) so a hard kill can't leave the registry zero-length; a persistence
        // failure is now surfaced (loud warn) instead of silently swallowed — the registry drives resume/stale
        // marking, so a write we can't complete is worth knowing about.
        writeFileDurable({ fs: fs, path: P }, file, JSON.stringify(body));
      } catch (e) { try { console.warn('[subagents] registry save failed:', (e && e.message) || e); } catch (_) {} }
    }
    function findIndex(id) { return records.findIndex(r => r && r.id === id); }
    function get(id) {
      const i = findIndex(String(id || ''));
      return i >= 0 ? clone(records[i]) : null;
    }
    function view(r) {
      if (!r) return null;
      return {
        id: r.id, leadId: r.leadId, agentId: r.agentId, runId: r.runId, status: r.status,
        prompt: r.prompt, result: r.result || '', reason: r.reason || '', usd: r.usd || 0,
        attempts: r.attempts || 0, startedAt: r.startedAt || 0, updatedAt: r.updatedAt || 0,
        completedAt: r.completedAt || 0, canInterrupt: !!controllers.get(r.id), canResume: !!r.canResume,
        events: Array.isArray(r.events) ? r.events.slice(-50) : []
      };
    }
    function list(filter) {
      filter = filter || {};
      return records.filter(r => {
        if (filter.leadId && r.leadId !== filter.leadId) return false;
        if (filter.agentId && r.agentId !== filter.agentId) return false;
        if (filter.status && r.status !== filter.status) return false;
        return true;
      }).map(view);
    }
    function patch(id, fields) {
      const i = findIndex(id);
      if (i < 0) return null;
      records[i] = Object.assign({}, records[i], fields || {}, { updatedAt: now() });
      save();
      return records[i];
    }
    function appendEvent(id, name, payload) {
      if (!WATCH_EVENTS.has(name)) return;
      const i = findIndex(id);
      if (i < 0) return;
      const r = records[i];
      const ev = { ts: now(), name: name, payload: payload || {} };
      const events = (Array.isArray(r.events) ? r.events : []).concat([ev]).slice(-80);
      records[i] = Object.assign({}, r, { events: events, updatedAt: now() });
      save();
    }
    function publishTask(r, status) {
      try { emit('task', { id: r.id, agentId: r.agentId, status: status, kind: 'subagent', title: clip(r.prompt, 80) }); } catch (_) {}
    }
    function upsertStart(meta) {
      const id = meta.id ? safeId(meta.id, 'subagent id') : safeId(newId(), 'subagent id');
      const t = now();
      const oldIndex = findIndex(id);
      const old = oldIndex >= 0 ? records[oldIndex] : null;
      const rec = {
        id: id,
        leadId: safeId(meta.leadId || 'agent', 'leadId'),
        agentId: safeId(meta.agentId || 'agent', 'agentId'),
        runId: safeId(meta.runId || newId(), 'runId'),
        prompt: String(meta.prompt || ''),
        status: 'running',
        reason: '',
        result: old && old.result ? old.result : '',
        usd: 0,
        events: old && Array.isArray(old.events) ? old.events.slice(-80) : [],
        attempts: (meta.attempts || 0) + 1,
        startedAt: (old && old.startedAt) || meta.startedAt || t,
        updatedAt: t,
        completedAt: 0,
        canResume: false
      };
      const i = oldIndex;
      if (i >= 0) records[i] = Object.assign({}, records[i], rec);
      else records.push(rec);
      save();
      publishTask(rec, 'running');
      return rec;
    }

    function start(meta, runner) {
      if (typeof runner !== 'function') throw new Error('subagent runner required');
      const rec = upsertStart(meta || {});
      const ac = new AbortController();
      controllers.set(rec.id, ac);
      const runEmit = function (name, payload) {
        appendEvent(rec.id, name, payload);
        try { emit(name, payload); } catch (_) {}
      };
      Promise.resolve().then(function () {
        return runner({ id: rec.id, runId: rec.runId, signal: ac.signal, emit: runEmit, record: view(rec) });
      }).then(function (result) {
        controllers.delete(rec.id);
        const cur = get(rec.id);
        if (cur && cur.status === 'interrupted') return;
        const status = !result ? 'refused' : (result.status || (result.reason === 'done' ? 'done' : 'done'));
        const fields = {
          status: status,
          reason: (result && result.reason) || (status === 'refused' ? 'refused' : 'done'),
          result: (result && result.result) || '',
          usd: (result && result.usd) || 0,
          completedAt: now(),
          canResume: status !== 'done'
        };
        const done = patch(rec.id, fields);
        publishTask(done || rec, status === 'done' ? 'done' : 'failed');
      }, function (e) {
        controllers.delete(rec.id);
        const cur = get(rec.id);
        if (cur && cur.status === 'interrupted') return;
        const done = patch(rec.id, { status: 'error', reason: 'error', result: 'worker run failed: ' + ((e && e.message) || e), completedAt: now(), canResume: true });
        publishTask(done || rec, 'failed');
      });
      return view(rec);
    }

    function interrupt(id, leadId) {
      id = safeId(id, 'subagent id');
      const rec = get(id);
      if (!rec) return { ok: false, error: 'no such subagent' };
      if (leadId && rec.leadId !== String(leadId)) return { ok: false, error: 'subagent belongs to another lead' };
      const ac = controllers.get(id);
      if (ac) { try { ac.abort(); } catch (_) {} controllers.delete(id); }
      if (TERMINAL.has(rec.status) && rec.status !== 'running') return { ok: true, alreadyDone: true, record: rec };
      const next = patch(id, { status: 'interrupted', reason: 'interrupted', completedAt: now(), canResume: true });
      publishTask(next || rec, 'failed');
      return { ok: true, record: view(next || rec) };
    }

    function interruptAll(leadId) {
      let n = 0;
      for (const r of records.slice()) {
        if (leadId && r.leadId !== String(leadId)) continue;
        if (r.status === 'running' || controllers.get(r.id)) {
          const out = interrupt(r.id, r.leadId);
          if (out && out.ok) n++;
        }
      }
      return n;
    }

    function resume(id, runner) {
      id = safeId(id, 'subagent id');
      const rec = get(id);
      if (!rec) return { ok: false, error: 'no such subagent' };
      if (controllers.get(id)) return { ok: false, error: 'subagent is already running' };
      if (rec.status === 'done') return { ok: false, error: 'subagent already completed' };
      const started = start(Object.assign({}, rec, { id: rec.id, runId: newId(), attempts: rec.attempts || 0, startedAt: rec.startedAt || now() }), runner);
      return { ok: true, record: started };
    }

    load();
    return { list: list, get: get, start: start, interrupt: interrupt, interruptAll: interruptAll, resume: resume, _internals: { records: function () { return records; }, controllers: controllers, load: load, save: save, appendEvent: appendEvent } };
  }

  return { makeSubagentManager: makeSubagentManager };
});
