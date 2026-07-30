/* test/prop-mount.test.js — the MOUNT AXIS: what may stand on a table, and where it draws.

   This seam shipped with no coverage at all and rotted three ways at once (2026-07-29):
     1. only the two mount:'surface' props could EVER be placed on a table — every other small
        object hit OVERLAP, so tables read as unusable ("it doesn't let you place any props on
        top of the tables");
     2. build.js (REFIT — the view you actually place props in) resolved no mount at all, so a
        table-top prop drew SURFACE_RISE px low and with a sort key tied to its table's;
     3. surfaceHostOf measured whatever frame the CALLER held. world.js passes the LOCAL props
        projectGeometry() emits, the doc's tables are in WORLD tiles, so on any station whose
        origin isn't (0,0) the live world found no host and never lifted anything.
   Each assertion below fails if one of those returns. */
'use strict';
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');
const fs = require('node:fs');
const path = require('node:path');

/* the catalog is INJECTED, never imported by the model — mirror the real app.js seam */
const RULES = {
  sidetable: { surface: true },
  longtable: { surface: true },
  lavalamp: { mount: 'surface' },   // REQUIRES a table
  plant: { stack: true },           // may use one, equally at home on the deck
  papers: { stack: true },
  gachapon: {},                     // deck only
};
const install = () => WM.setPropRules(t => RULES[t] || null);
const uninstall = () => WM.setPropRules(null);

/* a station with one room big enough to hold everything below */
function station() {
  const s = WM.create();
  const r = s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 44, y2: 8 } });
  A.ok(r.ok, 'test room placed');
  return s;
}

/* ---- the three states are distinct ---- */
install();
{
  const s = station();
  A.ok(s.addProp({ t: 'sidetable', x: 34, y: 4, w: 1, h: 1 }).ok, 'table places');

  // REQUIRED
  A.eq(s.canPlaceProp('lavalamp', 39, 4, 1, 1).error, 'NEEDS_SURFACE', 'required-mount refused off a table');
  A.eq(s.canPlaceProp('lavalamp', 34, 4, 1, 1).ok, true, 'required-mount accepted on a table');

  // OPTIONAL — the whole bug: before `stack` existed the table placement returned OVERLAP
  A.eq(s.canPlaceProp('plant', 34, 4, 1, 1).ok, true, 'stack prop accepted on a table');
  A.eq(s.canPlaceProp('plant', 39, 4, 1, 1).ok, true, 'stack prop still accepted on bare deck');

  // DECK ONLY — everything else still treats a table as a solid obstacle
  A.eq(s.canPlaceProp('gachapon', 34, 4, 1, 1).error, 'OVERLAP', 'non-stack prop refused on a table');
  A.eq(s.canPlaceProp('gachapon', 39, 4, 1, 1).ok, true, 'non-stack prop fine on bare deck');
}

/* ---- a stacked prop must fit WHOLLY on one host ---- */
{
  const s = station();
  s.addProp({ t: 'sidetable', x: 34, y: 4, w: 1, h: 1 });
  A.eq(s.canPlaceProp('papers', 34, 4, 2, 1).error, 'OVERLAP', 'partial overlap is not a mount');
  s.addProp({ t: 'longtable', x: 38, y: 4, w: 3, h: 1 });
  A.eq(s.canPlaceProp('papers', 38, 4, 2, 1).ok, true, 'fully contained on a 3-wide table is a mount');
}

/* ---- mountOf answers the same in EVERY coordinate frame ---- */
{
  const s = station();
  s.addProp({ t: 'sidetable', x: 34, y: 4, w: 1, h: 1 });
  const lamp = s.addProp({ t: 'lavalamp', x: 34, y: 4, w: 1, h: 1 });
  s.addProp({ t: 'plant', x: 39, y: 4, w: 1, h: 1 });          // on bare deck

  const doc = s.props().find(p => p.id === lamp.id);
  const geo = s.projectGeometry().props.find(p => p.id === lamp.id);
  A.ok(geo.x !== doc.x || geo.y !== doc.y, 'the local frame really is shifted (else this proves nothing)');

  A.eq(s.mountOf(doc), 'surface', 'mounted in the WORLD frame (build.js)');
  A.eq(s.mountOf(geo), 'surface', 'mounted in the LOCAL frame (world.js) — the frame bug');
  A.eq(s.surfaceHostOf(geo), s.props().find(p => p.t === 'sidetable').id, 'host resolves in the local frame too');

  const potDoc = s.props().find(p => p.t === 'plant');
  const potGeo = s.projectGeometry().props.find(p => p.id === potDoc.id);
  A.eq(s.mountOf(potDoc), null, 'a stack prop on bare deck is NOT lifted');
  A.eq(s.mountOf(potGeo), null, 'and not in the local frame either');
}

/* ---- mount is resolved per frame, never stored ---- */
{
  const s = station();
  const tbl = s.addProp({ t: 'sidetable', x: 34, y: 4, w: 1, h: 1 });
  const lamp = s.addProp({ t: 'lavalamp', x: 34, y: 4, w: 1, h: 1 });
  const get = () => s.props().find(p => p.id === lamp.id);

  A.eq(s.mountOf(get()), 'surface', 'starts mounted');
  A.ok(!('mount' in get()), 'the doc never stores a mount field (so no save needs migrating)');
  A.eq(s.removeProp(tbl.id).ok, true, 'table reclaimed');
  A.eq(s.mountOf(get()), null, 'the lamp drops back to the deck rather than floating');
  A.eq(s.undo().ok, true, 'undo restores the table');
  A.eq(s.mountOf(get()), 'surface', 'and the lamp rides it again');
}

/* ---- with NO rules installed nothing mounts (plain node callers / older saves) ---- */
uninstall();
{
  const s = station();
  const t = s.addProp({ t: 'sidetable', x: 34, y: 4, w: 1, h: 1 });
  A.eq(s.canPlaceProp('lavalamp', 39, 4, 1, 1).ok, true, 'no rules => no NEEDS_SURFACE');
  A.eq(s.canPlaceProp('lavalamp', 34, 4, 1, 1).error, 'OVERLAP', 'no rules => a table is just a prop');
  A.eq(s.mountOf(s.props().find(p => p.id === t.id)), null, 'no rules => nothing is mounted');
}

/* ---- the catalog's own rows obey the axis ----
   Tables are 1x1 / 2x1 / 3x1, all one tile deep, so a prop that may stand on one has to fit. */
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'propsprites.js'), 'utf8');
  const rows = [...src.matchAll(/\{ id: "([a-zA-Z_0-9]+)", label: "[^"]+", cat: "\w+", tier: "\w+"([^\n]*)/g)]
    .map(m => ({ id: m[1], rest: m[2] }));
  A.ok(rows.length > 100, 'parsed the catalog (' + rows.length + ' rows)');

  const tables = rows.filter(r => /surface: true/.test(r.rest));
  A.ok(tables.length >= 3, 'the three tables are still tagged surface:true');
  for (const t of tables) A.eq((/h: (\d+)/.exec(t.rest) || [])[1], '1', t.id + ' is one tile deep');
  const widest = tables.reduce((n, r) => Math.max(n, +(/w: (\d+)/.exec(r.rest) || [0, 0])[1]), 0);

  const mountable = rows.filter(r => /mount: "surface"/.test(r.rest) || /stack: true/.test(r.rest));
  A.ok(mountable.length >= 10, 'a table has more than a token few things to hold (' + mountable.length + ')');
  for (const m of mountable) {
    const w = +(/w: (\d+)/.exec(m.rest) || [0, 0])[1], h = +(/h: (\d+)/.exec(m.rest) || [0, 0])[1];
    A.ok(w <= widest, m.id + ' is ' + w + ' wide; the widest table is ' + widest);
    A.eq(h, 1, m.id + ' must be one tile deep to sit on a table');
    A.ok(!(/mount: "surface"/.test(m.rest) && /stack: true/.test(m.rest)), m.id + ' picks ONE mount state');
  }
}

A.report('prop-mount');
