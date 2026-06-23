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

/* SKIN REGISTRY — each agent picks a skin (a natively-colored sprite set) at
   creation. assets.js drawBody maps agent.skin -> DATA.SKINS[skin].set -> the
   manifest's "<set>.<state>.<dir>" frames. ADDITIVE: new skins = new entries
   here + a matching sprite set in assets/sprites/manifest.json. `scale` is the
   per-set downscale applied at tint time (crew sprites render on a 92px canvas). */
DATA.SKINS = {
  bear:       { name: 'Teddy Bear', set: 'bear',       scale: 0.36 },
  pepe:       { name: 'Pepe',       set: 'pepe',       scale: 0.36 },
  steve:      { name: 'Steve',      set: 'steve',      scale: 0.414 },
  alien:      { name: 'Alien',      set: 'alien',      scale: 0.376 },
  skeleton:   { name: 'Skeleton',   set: 'skeleton',   scale: 0.414 },
  crewmate:   { name: 'Crewmate',   set: 'crewmate',   scale: 0.385 },
  capybara:   { name: 'Capybara',   set: 'capybara',   scale: 0.425 },
  robot:      { name: 'Robot',      set: 'robot',      scale: 0.385 },
  vaultboy:   { name: 'Vault Boy',  set: 'vaultboy',   scale: 0.376 },
  blank:      { name: 'Blank',      set: 'blank',      scale: 0.385 },
  heisenberg: { name: 'Heisenberg', set: 'heisenberg', scale: 0.36  },
};
DATA.DEFAULT_SKIN = 'bear';
