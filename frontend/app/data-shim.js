/* SKYNET — data-shim.js
   The reused v7 sprite engine (js/assets.js) recolors a body by looking up
   DATA.AGENT[id].color. v7 shipped a giant 17-agent roster (data.js); the real
   harness has no fixed roster — each user-created agent registers itself here.
   This is the ONLY thing assets.js needs from the old data layer. */
'use strict';

const DATA = { AGENT: {} };

/* register (or recolor) an agent so the sprite engine can tint its suit */
function registerAgent(id, color) {
  DATA.AGENT[id] = { id, color: color || '#5ad0ff' };
  return DATA.AGENT[id];
}
