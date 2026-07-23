/* STARNET — toolprops.js : PURE tool-name -> capability-prop mapper (G0.1).

   The single source for "which placed prop does a firing tool light up?" — the render-side
   mirror of the sidecar's CAP_REGISTRY (sidecar/capability/registry.js), keyed the same way
   worldmodel's CAP_PROP_MAP keys prop types to capability objectTypes:

     fs.*                                        -> 'cabinet'   (files)
     web_search / web_fetch / public browser.*   -> 'dish'      (web)
     notebook.* / skill.* / recall_conversation
       / todo                                    -> 'notebook'  (memory)
     image_*                                     -> 'studio'    (media)
     spotify_*                                   -> 'jukebox'   (spotify)

   Everything else maps to null ON PURPOSE — those tools already have their own dedicated
   floor visual, so mapping them here would double-fire:
     mcp__<id>__*      -> the connector PORTAL pulse (world.js polls + pulseConnector)
     shell.* / verify.* / browser.test_* -> the WORKBENCH pulse (shell.exec / verify.result events)
     team.* / routine.*                -> the lead->worker handoff boxes (orchestration visuals)
     model.chat                        -> the compute gate, not a callable prop tool

   Pure + headless-safe: no DOM, no clock, no state — a name goes in, a prop type (or null)
   comes out. Loads under require() for the unit tests exactly like worldmodel.js. */
'use strict';

const ToolProps = (() => {
  // exact-name grants that don't share a family prefix (from CAP_REGISTRY's notebook rows)
  const EXACT = {
    web_search: 'dish',
    web_fetch: 'dish',
    todo: 'notebook',
    recall_conversation: 'notebook',
    'widget.set': 'notebook'   // WIDGET RAILS Phase 2: agent-fed rail readout — a notebook-object (memory) grant
    // QUEST V2 §B: quest.update is DELIBERATELY absent here → null. It moved from the notebook object to the `computer`
    // object (the 'quest' freebie capId), and the compute gate has no cap-prop pulse (model.chat is null for the same
    // reason). So updating a quest lights no placed-cap prop — correct: it rides compute, not a placeable object.
  };
  // family prefix -> prop type (checked after EXACT; first match wins)
  const PREFIX = [
    ['fs.', 'cabinet'],
    ['browser.', 'dish'],
    ['notebook.', 'notebook'],
    ['skill.', 'notebook'],
    ['image_', 'studio'],
    ['spotify_', 'jukebox']
  ];

  /* the mapper: real tool name -> capability prop type ('cabinet'|'dish'|'notebook'|'studio'|'jukebox') or null */
  function toolPropType(name) {
    if (!name || typeof name !== 'string') return null;
    if (name.indexOf('mcp__') === 0) return null;          // connector portals own their own pulse
    if (name.indexOf('browser.test_') === 0) return null;  // local synthetic testing rides workbench, not dish
    if (EXACT[name]) return EXACT[name];
    for (const [pre, t] of PREFIX) if (name.indexOf(pre) === 0) return t;
    return null;                                           // shell/verify/team/routine/model + unknowns: no cap-prop pulse
  }

  return { toolPropType };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ToolProps;
