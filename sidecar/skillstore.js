/* sidecar/skillstore.js - the agent's owned, reusable SKILL library.

   Runtime skills are per-agent procedure documents. list() is metadata-only,
   view() loads the body on demand, and manage() owns the lifecycle so the
   agent can create, patch, archive, restore, pin, and attach support files
   without reaching into its own storage through fs tools.

     makeSkillStore({ io, clock, redact?, maxPerAgent?, bodyMax? }) -> {
       write({ agentId, name, summary, body }) -> legacy create/edit wrapper,
       manage({ agentId, action, ... }) -> lifecycle operation,
       list(agentId, opts?) -> metadata only,
       view(agentId, idOrName, opts?) -> full body/support files,
       markUsed(agentId, idOrNames) -> usage telemetry,
       curate(agentId, opts?) -> stale/archive lifecycle pass,
       all(), count()
     } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).skillstore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NAME_MAX = 80, SUMMARY_MAX = 280, CATEGORY_MAX = 80, BODY_MAX = 20000;
  const DEFAULT_MAX_PER_AGENT = 100, SUPPORT_FILE_MAX = 64000;
  const STATES = { active: 1, stale: 1, archived: 1 };
  const ALLOWED_SUPPORT_DIRS = ['references', 'templates', 'scripts', 'assets'];

  function str(v) { return v == null ? '' : String(v); }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function bool(v) { return !!v; }
  function slug(name) {
    return str(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
  }
  const keyOf = (agentId, name) => str(agentId) + '\x00' + str(name).trim().toLowerCase();

  function clone(o) { return JSON.parse(JSON.stringify(o == null ? null : o)); }
  function arr(v) {
    if (Array.isArray(v)) return v.map(x => str(x).trim()).filter(Boolean);
    if (v == null || v === '') return [];
    return [str(v).trim()].filter(Boolean);
  }
  function stateOf(v) {
    const s = str(v || 'active').toLowerCase();
    return STATES[s] ? s : 'active';
  }
  function cleanName(v) {
    const name = str(v).trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
    if (!name) return { ok: false, error: 'a skill needs a name' };
    if (/[\x00-\x1F<>:"|?*\\/]/.test(name)) return { ok: false, error: 'skill name contains unsafe characters' };
    return { ok: true, name };
  }
  function cleanCategory(v) {
    const c = str(v || 'General').trim().replace(/\s+/g, ' ').slice(0, CATEGORY_MAX);
    return c || 'General';
  }
  function normFiles(files) {
    const out = {};
    if (!files) return out;
    if (Array.isArray(files)) {
      for (const f of files) if (f && f.path) out[str(f.path)] = {
        path: str(f.path), content: str(f.content).slice(0, SUPPORT_FILE_MAX),
        updatedAt: num(f.updatedAt)
      };
      return out;
    }
    if (typeof files === 'object') {
      for (const p of Object.keys(files)) {
        const f = files[p];
        if (f && typeof f === 'object') out[str(f.path || p)] = {
          path: str(f.path || p), content: str(f.content).slice(0, SUPPORT_FILE_MAX),
          updatedAt: num(f.updatedAt)
        };
        else out[str(p)] = { path: str(p), content: str(f).slice(0, SUPPORT_FILE_MAX), updatedAt: 0 };
      }
    }
    return out;
  }
  function supportPath(raw) {
    let p = str(raw).trim().replace(/\\/g, '/').replace(/^\/+/, '');
    p = p.replace(/\/+/g, '/');
    if (!p) return { ok: false, error: 'support file path required' };
    if (/^[A-Za-z]:/.test(p) || p.indexOf('..') >= 0 || /[\x00-\x1F]/.test(p)) return { ok: false, error: 'unsafe support file path' };
    const root = p.split('/')[0];
    if (ALLOWED_SUPPORT_DIRS.indexOf(root) < 0 || p === root) {
      return { ok: false, error: 'support files must live under ' + ALLOWED_SUPPORT_DIRS.join(', ') };
    }
    if (p.length > 180) return { ok: false, error: 'support file path is too long' };
    return { ok: true, path: p };
  }

  function normalizeEntry(r) {
    r = r || {};
    const n = cleanName(r.name);
    if (!n.ok) return null;
    const updatedAt = num(r.updatedAt) || num(r.createdAt);
    return {
      id: str(r.id || slug(n.name)),
      agentId: str(r.agentId) || 'agent',
      name: n.name,
      summary: str(r.summary).slice(0, SUMMARY_MAX),
      description: str(r.description || r.summary).slice(0, SUMMARY_MAX),
      body: str(r.body).slice(0, BODY_MAX),
      setup: str(r.setup).slice(0, BODY_MAX),
      category: cleanCategory(r.category),
      requires: arr(r.requires),
      platforms: arr(r.platforms),
      state: stateOf(r.state),
      pinned: bool(r.pinned),
      createdBy: str(r.createdBy || 'agent'),
      sourceRunId: r.sourceRunId ? str(r.sourceRunId) : null,
      createdAt: num(r.createdAt) || updatedAt,
      updatedAt: updatedAt,
      lastUsedAt: r.lastUsedAt == null ? null : num(r.lastUsedAt),
      viewCount: num(r.viewCount),
      useCount: num(r.useCount),
      patchCount: num(r.patchCount),
      packagePath: r.packagePath ? str(r.packagePath) : '',
      scan: r.scan || null,
      guardAction: r.guardAction || '',
      files: normFiles(r.files)
    };
  }

  function projectFile(f, includeContent) {
    const out = { path: f.path, updatedAt: num(f.updatedAt), bytes: str(f.content).length };
    if (includeContent) out.content = str(f.content);
    return out;
  }
  function projectSkill(s, includeBody) {
    const files = Object.keys(s.files || {}).sort().map(p => projectFile(s.files[p], !!includeBody));
    const out = {
      id: s.id, agentId: s.agentId, name: s.name, summary: s.summary, description: s.description || s.summary || '',
      category: s.category, setup: s.setup || '',
      requires: (s.requires || []).slice(), platforms: (s.platforms || []).slice(), state: s.state, pinned: !!s.pinned,
      createdBy: s.createdBy, sourceRunId: s.sourceRunId || null,
      createdAt: s.createdAt || 0, updatedAt: s.updatedAt || 0, lastUsedAt: s.lastUsedAt || null,
      viewCount: s.viewCount || 0, useCount: s.useCount || 0, patchCount: s.patchCount || 0,
      packagePath: s.packagePath || '', scan: s.scan || null, guardAction: s.guardAction || '',
      files
    };
    if (includeBody) out.body = s.body || '';
    return out;
  }

  function makeSkillStore(opts) {
    opts = opts || {};
    const io = opts.io || { readAll() { return []; }, append() {} };
    const clock = opts.clock || { now() { return 0; } };
    const redact = typeof opts.redact === 'function' ? opts.redact : (s) => s;
    const maxPerAgent = opts.maxPerAgent || DEFAULT_MAX_PER_AGENT;
    const bodyMax = opts.bodyMax || BODY_MAX;
    const supportFileMax = opts.supportFileMax || SUPPORT_FILE_MAX;
    const packageStore = opts.packageStore || opts.packages || null;
    const guard = opts.guard || null;

    const latest = new Map();
    try {
      const raw = io.readAll();
      if (Array.isArray(raw)) for (const r of raw) {
        const n = normalizeEntry(r);
        if (n) latest.set(keyOf(n.agentId, n.name), n);
      }
    } catch (e) { /* corrupt log -> empty library (fail-open) */ }

    function now() { return num(clock.now()); }
    function red(s, max) {
      let v = str(s).slice(0, max);
      try { v = str(redact(v)).slice(0, max); } catch (_) {}
      return v;
    }
    // RAM-only bump: update the in-memory `latest` copy WITHOUT appending a JSONL line. view() is called on
    // every skill.view / skill load, many times per run — appending each one is what grows skills.jsonl without
    // bound. The bumped counters (viewCount/useCount/lastUsedAt/state) instead ride along the NEXT real mutation
    // (write/edit/patch/markUsed/curate all persist the skill, and makeEntry carries viewCount/useCount forward),
    // or a low-frequency compaction flush. Returns the projected skill (same shape view() returned before).
    function bumpView(entry) {
      latest.set(keyOf(entry.agentId, entry.name), clone(entry));
      return entry;
    }
    function persist(entry) {
      try {
        if (guard && typeof guard.scanSkillRecord === 'function') {
          const scan = guard.scanSkillRecord(projectSkill(entry, true), { source: entry.createdBy === 'user' ? 'trusted' : 'agent-created' });
          entry.scan = scan;
          if (guard && typeof guard.shouldAllow === 'function') {
            const policy = guard.shouldAllow(scan, { allowAsk: true });
            entry.guardAction = policy.action || '';
          }
        }
      } catch (_) {}
      try {
        if (packageStore && typeof packageStore.writePackage === 'function') {
          const dir = packageStore.writePackage(projectSkill(entry, true));
          if (dir) entry.packagePath = dir;
        }
      } catch (_) {}
      latest.set(keyOf(entry.agentId, entry.name), clone(entry));
      try { io.append(clone(entry)); } catch (_) { /* persistence failure must never crash a run */ }
      return entry;
    }
    function mine(agentId, opts2) {
      opts2 = opts2 || {};
      const out = [];
      const pfx = str(agentId) + '\x00';
      for (const [k, v] of latest) {
        if (k.indexOf(pfx) !== 0) continue;
        if (!opts2.includeArchived && v.state === 'archived') continue;
        if (Array.isArray(opts2.states) && opts2.states.indexOf(v.state) < 0) continue;
        out.push(v);
      }
      out.sort((a, b) => (!!b.pinned - !!a.pinned) || ((b.updatedAt || 0) - (a.updatedAt || 0)) || a.name.localeCompare(b.name));
      return out;
    }
    function countFor(agentId) { return mine(agentId).length; }
    function find(agentId, idOrName, opts2) {
      opts2 = opts2 || {};
      const q = str(idOrName).trim();
      if (!q) return null;
      const byName = latest.get(keyOf(agentId, q));
      if (byName && (opts2.includeArchived || byName.state !== 'archived')) return byName;
      const ql = q.toLowerCase();
      for (const s of mine(agentId, { includeArchived: !!opts2.includeArchived })) {
        if (s.id === q || s.name.toLowerCase() === ql) return s;
      }
      return null;
    }

    function makeEntry(e, existing) {
      e = e || {};
      const n = cleanName(e.name != null ? e.name : (existing && existing.name));
      if (!n.ok) return n;
      const t = now();
      const body = e.body != null ? red(e.body, bodyMax) : (existing ? existing.body : '');
      return { ok: true, entry: {
        id: existing ? existing.id : slug(n.name),
        agentId: str(e.agentId || (existing && existing.agentId) || 'agent'),
        name: n.name,
        summary: e.summary != null ? red(e.summary, SUMMARY_MAX) : (existing ? existing.summary : ''),
        description: e.description != null ? red(e.description, SUMMARY_MAX) : (existing ? (existing.description || existing.summary) : red(e.summary, SUMMARY_MAX)),
        body,
        setup: e.setup != null ? red(e.setup, bodyMax) : (existing ? existing.setup || '' : ''),
        category: cleanCategory(e.category != null ? e.category : (existing && existing.category)),
        requires: e.requires != null ? arr(e.requires) : (existing ? (existing.requires || []).slice() : []),
        platforms: e.platforms != null ? arr(e.platforms) : (existing ? (existing.platforms || []).slice() : []),
        state: stateOf(e.state || (existing && existing.state) || 'active'),
        pinned: e.pinned != null ? !!e.pinned : !!(existing && existing.pinned),
        createdBy: str(e.createdBy || (existing && existing.createdBy) || 'agent'),
        sourceRunId: e.sourceRunId ? str(e.sourceRunId) : ((existing && existing.sourceRunId) || null),
        createdAt: existing ? existing.createdAt : t,
        updatedAt: t,
        lastUsedAt: existing ? existing.lastUsedAt : null,
        viewCount: existing ? existing.viewCount || 0 : 0,
        useCount: existing ? existing.useCount || 0 : 0,
        patchCount: existing ? existing.patchCount || 0 : 0,
        packagePath: existing ? existing.packagePath || '' : '',
        scan: existing ? existing.scan || null : null,
        guardAction: existing ? existing.guardAction || '' : '',
        files: existing ? clone(existing.files || {}) : {}
      } };
    }

    function write(e) {
      e = e || {};
      const agentId = str(e.agentId) || 'agent';
      const n = cleanName(e.name);
      if (!n.ok) return { ok: false, error: n.error };
      const existing = find(agentId, n.name, { includeArchived: true });
      if (!existing && countFor(agentId) >= maxPerAgent) return { ok: false, error: 'skill library is full (max ' + maxPerAgent + ') - edit or archive one first' };
      const made = makeEntry(Object.assign({}, e, { agentId, name: n.name, state: 'active' }), existing);
      if (!made.ok) return { ok: false, error: made.error };
      const entry = persist(made.entry);
      return { ok: true, skill: projectSkill(entry, true), edited: !!existing };
    }

    function patchBody(body, findText, replaceText) {
      const source = str(body);
      const needle = str(findText);
      if (!needle) return { ok: false, error: 'patch needs find text' };
      let idx = source.indexOf(needle);
      if (idx < 0) {
        const lower = source.toLowerCase();
        idx = lower.indexOf(needle.toLowerCase());
      }
      if (idx < 0) return { ok: false, error: 'patch text not found' };
      return { ok: true, body: source.slice(0, idx) + str(replaceText) + source.slice(idx + needle.length) };
    }

    function manage(e) {
      e = e || {};
      const agentId = str(e.agentId) || 'agent';
      const action = str(e.action || 'create').toLowerCase();
      const target = e.target != null ? e.target : (e.id != null ? e.id : e.name);
      let existing = null, made, entry, p, t;

      if (action === 'create') {
        const n = cleanName(e.name);
        if (!n.ok) return { ok: false, error: n.error };
        if (!str(e.body).trim()) return { ok: false, error: 'a new skill needs a body' };
        if (find(agentId, n.name, { includeArchived: true })) return { ok: false, error: 'a skill named "' + n.name + '" already exists - patch or edit it instead' };
        if (countFor(agentId) >= maxPerAgent) return { ok: false, error: 'skill library is full (max ' + maxPerAgent + ') - edit or archive one first' };
        made = makeEntry(Object.assign({}, e, { agentId, name: n.name, state: 'active' }), null);
        if (!made.ok) return { ok: false, error: made.error };
        entry = persist(made.entry);
        return { ok: true, action: 'create', skill: projectSkill(entry, true), edited: false };
      }

      existing = find(agentId, target, { includeArchived: true });
      if (!existing) return { ok: false, error: 'no such skill: ' + str(target || '') };

      if (action === 'edit') {
        made = makeEntry(Object.assign({}, e, { agentId, name: existing.name }), existing);
        if (!made.ok) return { ok: false, error: made.error };
        made.entry.patchCount = (made.entry.patchCount || 0) + 1;
        entry = persist(made.entry);
        return { ok: true, action: 'edit', skill: projectSkill(entry, true), edited: true };
      }

      if (action === 'patch') {
        p = patchBody(existing.body, e.find, e.replace);
        if (!p.ok) return p;
        made = makeEntry(Object.assign({}, existing, { agentId, name: existing.name, body: p.body }), existing);
        made.entry.patchCount = (made.entry.patchCount || 0) + 1;
        entry = persist(made.entry);
        return { ok: true, action: 'patch', skill: projectSkill(entry, true), edited: true };
      }

      if (action === 'archive' || action === 'delete') {
        entry = clone(existing); entry.state = 'archived'; entry.updatedAt = now();
        entry = persist(entry);
        return { ok: true, action: 'archive', skill: projectSkill(entry, true), edited: true };
      }
      if (action === 'restore') {
        entry = clone(existing); entry.state = 'active'; entry.updatedAt = now();
        entry = persist(entry);
        return { ok: true, action: 'restore', skill: projectSkill(entry, true), edited: true };
      }
      if (action === 'pin' || action === 'unpin') {
        entry = clone(existing); entry.pinned = action === 'pin' ? true : (e.pinned != null ? !!e.pinned : false); entry.updatedAt = now();
        entry = persist(entry);
        return { ok: true, action, skill: projectSkill(entry, true), edited: true };
      }
      if (action === 'write_file') {
        p = supportPath(e.path || e.file || e.filePath);
        if (!p.ok) return p;
        t = now();
        entry = clone(existing);
        entry.files = normFiles(entry.files);
        entry.files[p.path] = { path: p.path, content: red(e.content, supportFileMax), updatedAt: t };
        entry.patchCount = (entry.patchCount || 0) + 1;
        entry.updatedAt = t;
        entry = persist(entry);
        return { ok: true, action: 'write_file', path: p.path, skill: projectSkill(entry, true), edited: true };
      }
      if (action === 'remove_file') {
        p = supportPath(e.path || e.file || e.filePath);
        if (!p.ok) return p;
        entry = clone(existing);
        entry.files = normFiles(entry.files);
        delete entry.files[p.path];
        entry.patchCount = (entry.patchCount || 0) + 1;
        entry.updatedAt = now();
        entry = persist(entry);
        return { ok: true, action: 'remove_file', path: p.path, skill: projectSkill(entry, true), edited: true };
      }

      return { ok: false, error: 'unknown skill action: ' + action };
    }

    function list(agentId, opts2) {
      return mine(agentId, opts2).map(s => projectSkill(s, false));
    }
    function view(agentId, idOrName, opts2) {
      opts2 = opts2 || {};
      const s = find(agentId, idOrName, { includeArchived: !!opts2.includeArchived });
      if (!s) return null;
      let out = s;
      if (packageStore && typeof packageStore.hydrate === 'function' && opts2.hydrate !== false) {
        try {
          const h = packageStore.hydrate(projectSkill(s, true));
          if (h) out = Object.assign(clone(s), {
            body: h.body != null ? h.body : s.body,
            files: normFiles(h.files || s.files),
            packagePath: h.packagePath || s.packagePath || ''
          });
        } catch (_) {}
      }
      if (opts2.bump !== false) {
        out = clone(out);
        out.viewCount = (out.viewCount || 0) + 1;
        out.useCount = (out.useCount || 0) + 1;
        out.lastUsedAt = now();
        if (out.state === 'stale') out.state = 'active';
        // RAM-only: the bump rides the next real mutation / compaction flush instead of appending a JSONL line
        // per view (unbounded growth was the whole problem). See bumpView.
        bumpView(out);
      }
      return projectSkill(out, true);
    }
    function markUsed(agentId, idOrNames) {
      const ids = Array.isArray(idOrNames) ? idOrNames : [idOrNames];
      let count = 0;
      for (const id of ids) {
        const s = find(agentId, id, { includeArchived: false });
        if (!s) continue;
        const entry = clone(s);
        entry.useCount = (entry.useCount || 0) + 1;
        entry.lastUsedAt = now();
        if (entry.state === 'stale') entry.state = 'active';
        persist(entry); count++;
      }
      return { ok: true, count };
    }
    /* compact — rewrite the append-only JSONL keeping ONLY the newest entry per (agentId, name). `latest`
       already holds exactly that (the boot load + every persist/bumpView collapse duplicates into it), so the
       compacted file is simply `latest`'s values, one line each. This does two jobs at once:
         1. bounds the file — months of edits/views collapse to one line per distinct skill;
         2. FLUSHES the RAM-only view/use bumps to disk (they became part of `latest` but were never appended).
       Requires an io that can atomically REPLACE the whole file (io.rewrite). Without it, compaction is a no-op
       (the bounded-read boot loader still keeps memory sane) — reported via `ok:false, reason`. Never throws:
       a compaction failure must never crash a run (the RAM mirror still answers). Returns counts for tests. */
    function compact() {
      const entries = Array.from(latest.values()).map(e => clone(e));
      if (!io || typeof io.rewrite !== 'function') return { ok: false, reason: 'io has no rewrite', kept: entries.length };
      try { io.rewrite(entries); return { ok: true, kept: entries.length }; }
      catch (e) { return { ok: false, reason: (e && e.message) || 'rewrite failed', kept: entries.length }; }
    }
    function curate(agentId, opts2) {
      opts2 = opts2 || {};
      const staleMs = opts2.staleMs > 0 ? opts2.staleMs : 30 * 24 * 60 * 60 * 1000;
      const archiveMs = opts2.archiveMs > 0 ? opts2.archiveMs : 90 * 24 * 60 * 60 * 1000;
      const t = opts2.now != null ? num(opts2.now) : now();
      let stale = 0, archived = 0;
      for (const s of mine(agentId, { includeArchived: true })) {
        if (s.pinned || s.state === 'archived') continue;
        const base = s.lastUsedAt || s.updatedAt || s.createdAt || t;
        const age = Math.max(0, t - base);
        const entry = clone(s);
        if (age >= archiveMs) { entry.state = 'archived'; archived++; }
        else if (age >= staleMs) { entry.state = 'stale'; stale++; }
        else continue;
        entry.updatedAt = t;
        persist(entry);
      }
      return { ok: true, stale, archived };
    }

    return {
      write, manage, list, view, markUsed, curate, compact,
      all() { return Array.from(latest.values()).map(s => projectSkill(s, true)); },
      count() { return latest.size; },
      _internals: { slug, keyOf, supportPath, cleanName, normalizeEntry, bumpView }
    };
  }

  return { makeSkillStore };
});
