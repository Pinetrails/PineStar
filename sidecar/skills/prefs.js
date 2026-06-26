/* sidecar/skills/prefs.js — persistence of the user's ENABLE/DISABLE choices for bundled library skills.

   Append-only JSONL folded to latest-per-slug — same discipline as skillstore.js (the host owns the fsync'd disk
   append via an injected `io`). STATION-WIDE: a choice applies to every agent. Per-AGENT availability is NOT here
   — that's the capability gate (catalog.isAvailable, derived from placed objects), kept deliberately separate so
   "is this recipe turned on" and "can this desk run it" stay orthogonal. Fail-open: a persistence hiccup never
   crashes a run; the in-memory mirror still answers. PURE given io+clock (no Date/Math.random/fs of its own). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).skillsPrefs = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function makeSkillPrefs(opts) {
    opts = opts || {};
    const io = opts.io || { readAll() { return []; }, append() {} };
    const clock = opts.clock || { now() { return 0; } };
    const map = new Map();   // slug -> bool (the explicit user choice; absence ⇒ fall back to the skill's frontmatter default)
    try { const raw = io.readAll(); if (Array.isArray(raw)) for (const r of raw) { if (r && typeof r.slug === 'string') map.set(r.slug, !!r.enabled); } }
    catch (_) { /* corrupt log -> no overrides (defaults win) */ }

    function set(slug, enabled) {
      slug = String(slug || '').trim();
      if (!slug) return { ok: false, error: 'a skill slug is required' };
      const e = !!enabled;
      map.set(slug, e);
      try { io.append({ slug: slug, enabled: e, at: clock.now() }); } catch (_) { /* persistence failure must never crash a run */ }
      return { ok: true, slug: slug, enabled: e };
    }
    function overrides() { const o = {}; for (const [k, v] of map) o[k] = v; return o; }

    return { set, overrides, get(slug) { return map.get(slug); }, has(slug) { return map.has(slug); }, count() { return map.size; } };
  }

  return { makeSkillPrefs };
});
