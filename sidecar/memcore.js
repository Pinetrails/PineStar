/* sidecar/memcore.js — Cortex M-mem.6 "Memory Core": the PURE reductions + record ops behind the
   provenance panel. The stored per-record stats (useCount / lastUsedAt / trust) are a REDUCTION over the
   real memory.* event log — never invented — folded onto the §5.2 record as those events arrive. pin / edit
   / forget are pure array transforms the host binds to the notebook store. No IO, no ambient time: `now`
   is injected, so this is deterministic + lint-determinism-clean (only sidecar/index.js, the composition
   root, may read the wall clock and pass it in). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).memcore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TRUST_STEP = 0.15;   // each signed memory.feedback delta nudges trust by delta*step, clamped to [0,1]
  const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

  // fold ONE memory.feedback delta into a record's [0,1] trust. Honest: a clamped sum of the REAL deltas
  // (keep +2 / edit +1 / discard -1), no decay (the plan specifies none) and no invented prior — a record
  // with no feedback sits at 0, climbing only as the user endorses it.
  function nextTrust(prev, delta) {
    const t = (typeof prev === 'number' && isFinite(prev)) ? prev : 0;
    const d = (typeof delta === 'number' && isFinite(delta)) ? delta : 0;
    return clamp01(t + d * TRUST_STEP);
  }

  // collision-proof record id: one past the HIGHEST existing note_N — NOT positional ('note_'+list.length),
  // which reuses a freed slot after a forget and produces a DUPLICATE id (then every id-keyed op corrupts or
  // deletes the wrong record). Pure + deterministic; shared by both writers (the turn-in keep + notebook.write).
  function nextNoteId(records) {
    let max = 0;
    for (const r of (Array.isArray(records) ? records : [])) {
      const m = /^note_(\d+)$/.exec(r && r.id);
      if (m) { const n = +m[1]; if (n > max) max = n; }
    }
    return 'note_' + (max + 1);
  }

  // reduceStats(records, event, {now}) -> records' : fold ONE memory.* event onto the matching record.
  //   memory.used     -> useCount++ + lastUsedAt = now   (surfacing a record into a prompt IS a use)
  //   memory.feedback -> trust = nextTrust(trust, delta)
  // PURE: returns NEW record objects for what changed, and the SAME array ref when nothing changed (so the
  // host can skip a store write). An unknown event/id is a safe no-op. FIRST match only — so a pre-existing
  // duplicate id (e.g. from an old save written under the positional scheme) can never multi-mutate.
  function reduceStats(records, event, opts) {
    const recs = Array.isArray(records) ? records : [];
    const ev = event || {}, p = ev.payload || {}, name = ev.name;
    const now = (opts && opts.now != null) ? opts.now : 0;
    const id = p.id;
    if (!id || (name !== 'memory.used' && name !== 'memory.feedback')) return recs;
    let changed = false;
    const out = recs.map(r => {
      if (changed || !r || r.id !== id) return r;   // first match only
      changed = true;
      if (name === 'memory.used') return Object.assign({}, r, { useCount: (r.useCount || 0) + 1, lastUsedAt: now });
      return Object.assign({}, r, { trust: nextTrust(r.trust, p.delta) });   // memory.feedback
    });
    return changed ? out : recs;
  }

  // ---- pure record-array ops for the Memory Core management UI (pin / edit / forget) ----
  // each returns { records: newArray, found: bool }; never mutates the input array or any record object.
  function applyPin(records, id, pinned) {
    let found = false;
    const out = (Array.isArray(records) ? records : []).map(r => {
      if (!found && r && r.id === id) { found = true; return Object.assign({}, r, { pinned: !!pinned }); }
      return r;
    });
    return { records: out, found };
  }
  // edit the belief text: mirror it into BOTH `content` (the §5.2 field rank() reads for typed records) and
  // `body` (the legacy field notes + recall + the dossier render). Provenance (sourceRunId / createdAt / kind
  // / title) is preserved — an edit refines a belief, it doesn't change which run earned it.
  function applyEdit(records, id, content) {
    const c = String(content == null ? '' : content);
    let found = false;
    const out = (Array.isArray(records) ? records : []).map(r => {
      if (!found && r && r.id === id) { found = true; return Object.assign({}, r, { content: c, body: c }); }
      return r;
    });
    return { records: out, found };
  }
  function applyForget(records, id) {
    let found = false;
    const out = (Array.isArray(records) ? records : []).filter(r => {
      if (!found && r && r.id === id) { found = true; return false; }   // first match only — never delete a dup too
      return true;
    });
    return { records: out, found };
  }

  // the FULL §5.2 view for the Memory Core panel (the slim /api/notebook projection drops everything but
  // id/title/body/ts). Pure shaping only — the host applies redact() before it leaves the process.
  function projectRecord(r) {
    r = r || {};
    const text = r.content != null ? r.content : (r.body != null ? r.body : '');
    return {
      id: r.id || '', kind: r.kind || 'note',
      title: String(r.title || ''), body: String(text || ''),
      scope: r.scope || 'global', streamId: r.streamId || null,
      sourceRunId: r.sourceRunId || null,
      createdAt: r.createdAt || r.ts || 0, lastUsedAt: r.lastUsedAt || null,
      useCount: r.useCount || 0, trust: clamp01(Number(r.trust) || 0), pinned: !!r.pinned
    };
  }

  return { TRUST_STEP, clamp01, nextTrust, nextNoteId, reduceStats, applyPin, applyEdit, applyForget, projectRecord };
});
