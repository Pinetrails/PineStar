/* sidecar/capability/registry.js — CAP_REGISTRY: objectType -> grant[].
   THE static map that makes "room objects = capability grants" real. The builder UI edits
   rows here (data), never code. A grant is a policy triple, not a boolean.

   grant = { capId, tool, scope:'read'|'write'|'execute', requiresConsent, network, paramConstraints? }

   'computer' grants the special capId 'compute' — the precondition to spend a model turn at all
   (the COMPUTE GATE), not a tool the model invokes. Other objects grant callable tools. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.capability = root.SK.capability || {}).registry = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CAP_REGISTRY = {
    computer: [
      { capId: 'compute', tool: 'model.chat', scope: 'execute', requiresConsent: false, network: true }
    ],
    notebook: [
      { capId: 'memory', tool: 'notebook.write', scope: 'write', requiresConsent: true, network: false },
      { capId: 'memory', tool: 'notebook.read', scope: 'read', requiresConsent: false, network: false }
    ]
    // M5: cabinet (fs.read/write), terminal (shell.exec, jailed), dish (web.fetch, allowlisted)
  };

  function deepFreeze(o) {
    Object.freeze(o);
    for (const k in o) { const v = o[k]; if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v); }
    return o;
  }
  deepFreeze(CAP_REGISTRY);

  return { CAP_REGISTRY };
});
