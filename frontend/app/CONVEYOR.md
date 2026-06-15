# Conveyor system — contract

Directional conveyor belts you lay like a path, with boxes that flow along them. Companion to
`BUILDER.md` / `PROPS.md`. Built on the props infrastructure; additive (no `shared/` change).

## Data model (worldmodel.js)

Belts are a first-class keyed layer (NOT props) — a conveyor is a graph, and transport needs
O(1) topology lookups:

```js
doc.belts = { "12,7": "E", "13,7": "E", "13,8": "S", ... }   // "x,y" (WORLD tile) -> dir
```

- `dir` ∈ `E|W|N|S` — the flow direction OUT of that tile. 1×1 tiles.
- Belts are **walkable** — they never enter `blockedTiles`. A belt is floor machinery; boxes
  ride above it and are cosmetic. This keeps pathfinding robust across a factory floor.

Mutations (snapshot undo/redo): `setBelt(x,y,dir)`, `removeBelt(x,y)`, `placeBeltRun(a,b)` (lays a
straight run from a→b, direction = the drag axis). Validation: each tile must sit on a deck
(`roomAt != null`) and not on a *blocking* prop. Reads: `belts()` (→ `[{x,y,dir}]`),
`beltAt(x,y)` (→ dir|null). `projectGeometry()` emits `belts` in the LOCAL frame; belts serialize
inside `doc`; `migrate()` is total (drops malformed keys/dirs).

## Runtime (conveyor.js) — `Conveyor.create()`

A self-contained transport sim + renderer. Frame-agnostic: it's handed a belt map in whatever
tile frame the caller draws in (build.js = world coords, world.js = local coords), so one
factory powers both REFIT preview and the live world, each with its own box state.

- `tick(dtMs, nowMs, beltMap)` — advance boxes; spawn at *sources* (belt tiles nothing feeds
  into) on a fixed cadence staggered by tile hash; cap total. A box advances `progress` along its
  tile's dir; at `progress>=1` it steps to the next tile and adopts THAT tile's dir (corners), or
  sinks (fade) at an open end. Deterministic — no RNG, no wall-clock (nowMs is injected).
- `drawBelts(ctx, nowMs, TILE, beltMap)` — each tile: rails on the cross-axis, tread chevrons
  scrolling in the flow direction (ported from v7 `F.beltH`, generalized to 4 dirs + 1 tile),
  drive-LED. Direction is legible at a glance.
- `drawBoxes(ctx, nowMs, TILE)` — riding crates with contact shadows; a short sink-fade at the end.

Belts draw at floor level (over the bake, under the lightmap); boxes just above, y-sorted with
agents/props.

## Builder (build.js)

`BELT` tool (key 7): **drag to lay a run** — flow follows the dominant drag axis (drag east → `E`
belts, drag up → `N`, …). Ghost previews the run + a flow arrow, green/red via validation.
RECLAIM removes belt tiles. The editor runs the transport sim live, so boxes flow as you build.

## Status

- **Stage 4a (this):** directional belts + auto-flowing boxes; place/reclaim/undo/persist;
  REFIT + live world; deterministic sim; tests.
- **Later polish:** belt corners with curved tread art; explicit source/sink machines (the v7
  `fabricator`/`packbot` props as emitters/consumers); boxes carrying a visible payload tied to
  real agent deliveries (the v7 `parcel` event); merge/split junction art.
