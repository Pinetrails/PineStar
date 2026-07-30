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

## Mount axis — standing on a table

Three states, declared per catalog row and enforced by `checkProp`:

| row flag | meaning |
| --- | --- |
| `surface: true` | this prop IS a table — other props may stand on it (`sidetable`/`loungetable`/`longtable`) |
| `mount: 'surface'` | REQUIRES a table; refused on bare deck with `NEEDS_SURFACE` |
| `stack: true` | MAY use a table, equally at home on the deck |
| *(none)* | deck only — a table is a solid obstacle like any other prop |

A mounted prop's footprint must lie **wholly** on ONE host, and that host alone is exempt from the
overlap check. Mount is **resolved per frame, never stored on the prop doc** — reclaim the table and
the prop drops back to the deck, which is why no saved station needs migrating.

`stack` was added 2026-07-29: without it the only two props that could ever be placed on a table were
the two that were *forced* to, so a mug, a plant or a stack of printouts hit `OVERLAP` the moment a
table sat under it, and tables read as unusable. A required-mount flag cannot express "belongs on the
floor OR on a table", and forcing `plant`/`coffee` onto tables would have broken the agents that place
their own decor on open deck (`world.js AGENT_DECOR`). What earns the flag is what the **art draws**,
never the name: an object whose contact is its own base (mug, pot, papers, tote, speaker cab) stacks;
anything drawing legs, a stand or a `deckPlate` is floor furniture (`arc_microfiche` is a reader DESK,
`comms_inbox` is bolted down, `tank`/`monstera` are explicitly floor pieces).

**Renderers must ask `station.mountOf(prop)` and nothing else** — it folds both halves of the question
(may this type mount, AND is a host under it right now) and re-resolves the prop from the doc by id, so
it is frame-proof. Both halves had already gone wrong independently: `build.js` resolved neither, so in
REFIT — the view you place props in — a table-top prop drew `SURFACE_RISE` px low and with a sort key
tied to its table's; and `world.js` passed the LOCAL props `projectGeometry()` emits into a lookup that
compared them against WORLD-tile tables, so on any station whose origin wasn't (0,0) the live world
never lifted anything at all. A mounted prop also sorts **+0.5** after its host (same tiles = equal sort
keys, so array order would otherwise decide). Locked by `test/prop-mount.test.js`.

## Leisure — `use` makes a prop a DESTINATION

A catalog row may carry `use: {kind, sit, approach}`. That is what makes an idle agent walk to a prop
and dwell there (`world.js planProp` → `PropAnchor.deriveAnchor` → `goal:'use'`). Without it a prop is
scenery an agent will never touch, which is what 102 of the 108 props were until 2026-07-29 — the
station was full of pool tables and vending machines nobody used.

- `kind` is a free string. Only three values are special-cased anywhere: `couch`/`tv` (paired by
  `tryLounge` into the sit-and-watch beat) and `arcade` (the clickable minigame hit-test). **Every
  other kind needs no engine change at all** — `planProp` handles any of them generically, so adding a
  leisure prop is a catalog edit. `world.js USE_LINE` optionally maps a kind to a flavour thought; a
  kind with no entry simply says nothing.
- `sit: true` seats the body; `approach` biases which edge it walks to (`'auto'` tries all four).
- **`kind: 'bed'` is also the power-down target.** `planBedSleep` claims the mattress through the same
  `occupiedSeats` + `pendSeat` machinery a couch cushion uses (one sleeper per bed) and `sleep()` falls
  back to going dormant standing when no bed is reachable in-zone. Anything that wakes a sleeper must
  `releaseSeat()`/`seizeFromIdle()` or the bed is blocked for the session — there are four such sites.

## Drawing a new prop — the two things that bite

1. **`w` and `h` arrive in PIXELS**, not tiles: `draw()` multiplies the footprint by `TILE` before
   calling. Writing `w * TILE` inside a draw function puts the body hundreds of pixels off-canvas, and
   every other check still passes (the row exists, `has(id)` is true, the module parses). Three props
   shipped invisible this way. `test/prop-render-smoke.test.js` walks the whole catalog through a
   recording context stub and fails on both "painted nothing" and "painted off its own footprint".
2. **Scale.** A tile is 12px and an agent is ~35px, so a tabletop object that fills its tile is the
   size of a torso. Author smalls 5–9px wide with margin around them — the margin is what reads as
   "small object", and it is what lets several sit along one LONG TABLE without merging into a mass.

## Blocking vs decor

`CATALOG[].blocks` decides whether a prop occupies its tiles for pathfinding. Solid furniture
(desks, tables, the pool table, machines, seating, crates) is `blocks:true`. Flat decor — wall
murals (`bigscreen`, `whiteboard`, `chartwall`, `commswall`, `calwall`, `screens`, `ticker`,
`poster`, wall thumb/index walls) and floor pieces (`rug`, `arc_floorlight`, holo projections) —
is `blocks:false`, so agents walk over/along it. The builder passes the flag to `addProp({block})`;
the model stores `block:false` (omitted when true) and `projectGeometry()` skips those footprints
when filling `blockedTiles`.

The 2×2 workflow docks (`intake`/INBOX, `bay`, `outbox`) are **solid** (`blocks:true`): belts hook
to their ring tiles (the auto-router never paths under a prop footprint), so nothing needs to stand
on them and agents route around. They shipped as `blocks:false` for a while — `migrate()` strips
that stale flag from saved docs so old stations heal on load. The 1×1 junctions (`filter`,
`splitter`, `merger`) stay `blocks:false`: they sit ON a belt line (a belt tile underneath), and
belts are walkable floor machinery by contract. `airlock` (a door) and `missionboard`
(wall-mounted) are also intentionally non-blocking.

## Status

- **Stage 1 (done):** model + module + first props; place/move/reclaim/undo/persist + blocking.
- **Stage 2+3 (done):** all **111** currently placeable procedural props are registered in the
  authoritative `CATALOG`, with v7-authentic footprints and a category-grouped palette
  (work/ops/lab/storage/comms/lounge/decor), `blocks:false` decor. The catalog-to-renderer contract
  and all 95 entries are checked headlessly; the original 84-prop browser pass remains historical
  evidence rather than a claim that the later additions were part of that older run.
- **Stage 4 (later):** conveyor system — `beltH` belt segments + `boxes` that ride them (motion).
- **Possible polish:** rotate/flip (R key), prop-aware footprint hints, an auto-desk-as-real-prop
  unification with the live-world workstation FSM.
