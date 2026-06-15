/* SKYNET — propanchor.js : where an agent STANDS or SITS to use a prop.

   The gen prop model (worldmodel.js) stores props as pure rectangles; a blocking
   prop's whole footprint is unwalkable, so an agent can never path ONTO a couch/
   arcade/TV — only to an adjacent floor tile. This module derives that approach
   tile + the facing dir, porting v7's standNearFurn (agents.js): prefer the front
   (south) edge, then the other sides; the first walkable, non-blocked tile wins.

   PURE: depends on nothing but a `geo` exposing walkable(lx,ly,extra). No DOM, no
   time, no RNG — so it is unit-tested headlessly (test/propanchor.test.js). Both
   the live world (world.js, global PropAnchor) and Node tests (require) use it. */
'use strict';

const PropAnchor = (() => {

  /* facing dir from an approach tile INTO the prop — perpendicular to the edge the
     tile sits on (so a sitter at the front of a wide couch faces straight at it, not
     diagonally toward its far end). Tiles only ever come from sideTiles (edge-adjacent). */
  function facingToward(tx, ty, prop) {
    const x = prop.x, y = prop.y, w = prop.w || 1, h = prop.h || 1;
    if (ty >= y + h) return 'north';   // approaching from the south → face north into the prop
    if (ty < y) return 'south';        // from the north
    if (tx >= x + w) return 'west';    // from the east
    if (tx < x) return 'east';         // from the west
    return 'north';
  }

  /* the row/column of tiles immediately outside one edge of the footprint */
  function sideTiles(prop, side) {
    const x = prop.x, y = prop.y, w = prop.w || 1, h = prop.h || 1, out = [];
    if (side === 'south') for (let i = 0; i < w; i++) out.push({ tx: x + i, ty: y + h });
    else if (side === 'north') for (let i = 0; i < w; i++) out.push({ tx: x + i, ty: y - 1 });
    else if (side === 'east') for (let j = 0; j < h; j++) out.push({ tx: x + w, ty: y + j });
    else if (side === 'west') for (let j = 0; j < h; j++) out.push({ tx: x - 1, ty: y + j });
    return out;
  }

  const ORDER = ['south', 'north', 'east', 'west'];   // south = the visible/usable front, tried first

  /* deriveAnchor(prop, geo, opts) -> {tx,ty,face,sit} | null
       prop : { x, y, w, h } in the geo's LOCAL tile frame (a geo.props entry)
       geo  : { walkable(lx,ly,extra) }
       opts : { approach:'south'|'north'|'east'|'west'|'auto', sit:bool, extra:Set }
     Returns the first walkable tile adjacent to the footprint (preferred side first),
     or null when the prop is walled in with no reachable approach tile. */
  function deriveAnchor(prop, geo, opts) {
    opts = opts || {};
    const extra = opts.extra || null, sit = !!opts.sit, approach = opts.approach || 'south';
    const sides = approach === 'auto'
      ? ORDER.slice()
      : [approach].concat(ORDER.filter(s => s !== approach));
    for (const side of sides) {
      for (const t of sideTiles(prop, side)) {
        if (geo.walkable(t.tx, t.ty, extra)) {
          return { tx: t.tx, ty: t.ty, face: facingToward(t.tx, t.ty, prop), sit };
        }
      }
    }
    return null;
  }

  return { deriveAnchor, facingToward, sideTiles };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PropAnchor;
