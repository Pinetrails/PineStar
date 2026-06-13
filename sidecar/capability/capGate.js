/* sidecar/capability/capGate.js — enforcement helpers over a resolved capability set.
   canAgentUse(resolved, toolName) — is this tool granted right now?
   attenuate(resolved, allowedSubset) — a delegated worker's tools = resolved ∩ subset (never the
     union; monotonic attenuation makes the room layout a hard authority ceiling).
   makeCapCtx(resolved, extra) — builds the capCtx the loop/dispatch consume: canRun() is the
     COMPUTE GATE (a model turn needs a computer in the room); canUse(call) gates each tool. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.capability = root.SK.capability || {}).capGate = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function canAgentUse(resolved, toolName) {
    if (!resolved) return { ok: false, reason: 'no resolved capabilities' };
    if (resolved.tools.indexOf(toolName) >= 0) return { ok: true };
    return { ok: false, reason: 'no capability for ' + toolName + (resolved.room ? ' in room ' + resolved.room : '') };
  }

  function attenuate(resolved, allowedSubset) {
    const allow = allowedSubset instanceof Set ? allowedSubset : new Set(allowedSubset || []);
    return Object.assign({}, resolved, { tools: resolved.tools.filter(t => allow.has(t)) });
  }

  function makeCapCtx(resolved, extra) {
    return Object.assign({
      agentId: resolved.agentId,
      room: resolved.room,
      canRun: () => !!resolved.hasCompute,
      computeReason: 'no compute capability — place a computer in the room',
      canUse: (call) => canAgentUse(resolved, call.name),
      approvalRules: resolved.approvalRules
    }, extra || {});
  }

  return { canAgentUse, attenuate, makeCapCtx };
});
