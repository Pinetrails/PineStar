/* sidecar/capability/resolve.js — resolveTools: the PURE projection of placed objects onto
   the tools an agent may use THIS turn. Capability follows the agent's ASSIGNED room (the desk),
   not its body tile. room.capabilities is derived, never hand-stored. Called fresh every turn so
   placing/reclaiming an object changes the agent's reach on the very next model call.

   station = {
     rooms:  { <roomId>: { id, objects: [ { instanceId, objectType } ] } },
     agents: { <agentId>: { id, room: <roomId> } }
   }
   resolveTools(agentId, station, capRegistry?) ->
     { agentId, room, hasCompute, tools[], grants[], approvalRules{}, networkCaps{} } */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./registry.js'));
  else { root.SK = root.SK || {}; root.SK.capability = root.SK.capability || {}; root.SK.capability.resolve = factory(root.SK.capability.registry); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (capReg) {
  'use strict';

  const DEFAULT = capReg.CAP_REGISTRY;

  function resolveTools(agentId, station, capRegistry) {
    capRegistry = capRegistry || DEFAULT;
    const agent = station && station.agents && station.agents[agentId];
    const roomId = agent && agent.room;
    const room = roomId && station.rooms && station.rooms[roomId];
    const objects = (room && room.objects) || [];

    const tools = [], grants = [], approvalRules = {}, networkCaps = {};
    let hasCompute = false;
    const seen = {};

    for (const obj of objects) {
      const list = capRegistry[obj.objectType] || [];
      for (const g of list) {
        if (g.capId === 'compute') { hasCompute = true; continue; } // gates the run; not a callable tool
        if (seen[g.tool]) continue;
        seen[g.tool] = true;
        tools.push(g.tool);
        grants.push(g);
        approvalRules[g.tool] = { requiresConsent: !!g.requiresConsent, scope: g.scope, network: !!g.network };
        networkCaps[g.tool] = !!g.network;
      }
    }

    return { agentId, room: roomId || null, hasCompute, tools, grants, approvalRules, networkCaps };
  }

  return { resolveTools };
});
