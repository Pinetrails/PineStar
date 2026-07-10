# Props (furniture) — contract

Placeable, animated furniture ported from the v7 StarNet sim. Companion to `BUILDER.md`.

## Data model (worldmodel.js — additive, no `shared/` change)

A prop lives in `doc.props[]`:

```js
{ id: 'p7', t: 'desk', x: 4, y: 2, w: 2, h: 1 }   // x,y top-left in WORLD tiles
```

- `t` is the prop type = the `PropSprites.F` draw-fn key = `CATALOG` id.
- The model is **pure**: it does NOT know the catalog. The builder supplies `w,h` (the
  footprint) from `PropSprites.spec(t)`. The model validates only geometry.

Mutations (snapshot-based undo/redo, like rooms): `addProp`, `removeProp`, `moveProp`.
Validation `canPlaceProp(t,x,y,w,h,ignoreId?)`: every footprint tile must sit on a deck
(`roomAt != null`), no overlap with another prop, non-empty type. Reads: `props()`,
`propById(id)`, `propAt(tx,ty)` (topmost).

`projectGeometry()` emits `props` in the LOCAL frame **and folds each footprint into
`blockedTiles`** — so pathfinding routes agents around furniture for free (the seam the
walkability contract always promised). Props serialize inside `doc`; `migrate()` is total
over legacy/partial blobs (backfills id + default 1×1 footprint, drops junk).

## Art + catalog (propsprites.js)

`PropSprites` is the single source of truth for both the palette and the renderer:

- `CATALOG` — `{ id, label, cat, w, h, animated, blocks }` per prop.
- `F{}` — procedural draw fns ported **verbatim** from v7 `sprites.js` (TILE=12 in both, so
  no rescaling). Helpers (`px/box/inset/bevel/seamH/rivets/wear/scanl/sh/glow/blink/scr`)
  are ported alongside.
- `setCtx(ctx)`, `setNow(t)` per frame, then `draw(f, work)` where `f = {t,x,y,w,h}` in
  the frame the caller draws in. `work` lights screens.

## Rendering

Props ANIMATE, so they are **drawn per-frame OVER the static StationBake base and UNDER the
lightmap** (so they're lit) — never baked.
- `build.js` (REFIT): `drawProps()` between `baseCv` and `lightCv`, in WORLD coords
  (`p.x*TILE`; the bake is origin-shifted to match), `work=true` so the editor previews
  screens alive. Tool `prop` (key 6) — click to stamp; MOVE/RECLAIM prefer props (on top).
- `world.js` (live): props drawn in the existing y-sorted item pass, in LOCAL coords from
  `geo.props`.

## Blocking vs decor

`CATALOG[].blocks` decides whether a prop occupies its tiles for pathfinding. Solid furniture
(desks, tables, the pool table, machines, seating, crates) is `blocks:true`. Flat decor — wall
murals (`bigscreen`, `whiteboard`, `chartwall`, `commswall`, `calwall`, `screens`, `ticker`,
`poster`, wall thumb/index walls) and floor pieces (`rug`, `arc_floorlight`, holo projections) —
is `blocks:false`, so agents walk over/along it. The builder passes the flag to `addProp({block})`;
the model stores `block:false` (omitted when true) and `projectGeometry()` skips those footprints
when filling `blockedTiles`.

## Status

- **Stage 1 (done):** model + module + first props; place/move/reclaim/undo/persist + blocking.
- **Stage 2+3 (done):** all **95** currently placeable procedural props are registered in the
  authoritative `CATALOG`, with v7-authentic footprints and a category-grouped palette
  (work/ops/lab/storage/comms/lounge/decor), `blocks:false` decor. The catalog-to-renderer contract
  and all 95 entries are checked headlessly; the original 84-prop browser pass remains historical
  evidence rather than a claim that the later additions were part of that older run.
- **Stage 4 (later):** conveyor system — `beltH` belt segments + `boxes` that ride them (motion).
- **Possible polish:** rotate/flip (R key), prop-aware footprint hints, an auto-desk-as-real-prop
  unification with the live-world workstation FSM.
