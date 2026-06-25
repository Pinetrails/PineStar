/* STARNET — agentid.js : allocate a stable, unique agentId for a SUMMONED agent.

   The backend keys notebooks, the fs jail, checkpoints, cost and the run loop by agentId, and the
   wire grammar for those paths is ^[A-Za-z0-9_-]{1,40}$ (sidecar/tools/builtin/fs.js + index.js
   notebookFile). The hero is the reserved id 'agent'; every summoned agent must get a DIFFERENT,
   conforming, collision-free id. This is the one pure rule worth unit-testing on its own (summon
   itself is DOM-coupled), so it lives in its own zero-dep UMD module like workstreams.js.

   AgentId.alloc(seed, taken) -> a valid id derived from `seed`, never 'agent', unique vs `taken`
   (a Set/Map or anything with .has). AgentId.slug(seed) -> the sanitized base. AgentId.RE -> the
   backend's id grammar (exported so callers/tests assert against the SAME source of truth). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.AgentId = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RE = /^[A-Za-z0-9_-]{1,40}$/;

  // sanitize any seed (specialty id/name) into a valid base: lowercase, non-id chars → '-', trim
  // stray dashes, cap at 32 so a '-N' disambiguator can never push the result past the 40-char limit.
  function slug(seed) {
    const s = String(seed == null ? '' : seed).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    return s || 'agent';
  }

  // allocate a unique id from `seed`: the slug, then '-2', '-3', … until it is neither 'agent' (the
  // hero's reserved id) nor already present in `taken`. Always matches RE (base≤32 + '-' + a small int).
  function alloc(seed, taken) {
    const has = (taken && typeof taken.has === 'function') ? (id => taken.has(id)) : (() => false);
    const base = slug(seed);
    let id = base, n = 1;
    while (id === 'agent' || has(id)) { id = base + '-' + (++n); }
    return id;
  }

  return { slug, alloc, RE };
});
