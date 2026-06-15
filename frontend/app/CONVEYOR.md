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
  ride above it. This keeps pathfinding robust across a factory floor.

Mutations (snapshot undo/redo): `setBelt(x,y,dir)`, `removeBelt(x,y)`, `placeBeltRun(a,b)` (lays a
straight run from a→b, direction = the drag axis). Validation: each tile must sit on a deck
(`roomAt != null`) and not on a *blocking* prop. Reads: `belts()` (→ `[{x,y,dir}]`),
`beltAt(x,y)` (→ dir|null). `projectGeometry()` emits `belts` in the LOCAL frame; belts serialize
inside `doc`; `migrate()` is total (drops malformed keys/dirs).

## Runtime (conveyor.js) — `Conveyor.create()`

A self-contained transport sim + renderer. Frame-agnostic: it's handed a belt map in whatever
tile frame the caller draws in (build.js = world coords, world.js = local coords), so one
factory powers both REFIT preview and the live world, each with its own box state.

- `tick(dtMs, nowMs, beltMap)` — advance boxes. Boxes are **never auto-spawned**: a box exists only
  for a real work-item dropped via `enqueueAt` (see *Work-item pipeline*). A box advances `progress`
  along its tile's dir; at `progress>=1` it steps to the next tile and adopts THAT tile's dir
  (corners), or sinks (fade) at an open end — firing `onDeliver` if it carries a payload.
  Deterministic — no RNG, no wall-clock (nowMs is injected).
- `enqueueAt(x,y,payload)` — place a real work-item box at a source tile; `dropWorkitem(id)` —
  early-sink a riding box whose run was superseded (it never delivers); `Conveyor.create({onDeliver})`
  — `onDeliver(box,x,y)` fires once when a payload box rides off the end.
- `drawBelts(ctx, nowMs, TILE, beltMap)` — each tile: rails on the cross-axis, tread chevrons
  scrolling in the flow direction (ported from v7 `F.beltH`, generalized to 4 dirs + 1 tile),
  drive-LED. Direction is legible at a glance.
- `drawBoxes(ctx, nowMs, TILE)` — riding crates with contact shadows; a short sink-fade at the end.

Belts draw at floor level (over the bake, under the lightmap); boxes just above, y-sorted with
agents/props.

## Builder (build.js)

`BELT` tool (key 7): **drag to lay a run** — flow follows the dominant drag axis (drag east → `E`
belts, drag up → `N`, …). Ghost previews the run + a flow arrow, green/red via validation.
RECLAIM removes belt tiles. Belts stay **quiet** until a real work-item rides them (no decorative flow).

## Cargo, motion & belt craft (polish pass)

The boxes encode the station's SEMANTIC COLOR ECONOMY — each box hashes deterministically (by id)
to a cargo type, weighted so loud colours stay rare: **utility/steel 34% · production/amber 30% ·
data/cyan 16% · command/red 13% · money/gold 7%**. All share one 2.5D `cargoChassis` (lit top face
+ shaded front face + leading-edge rim light keyed to travel dir); data is a flatter cassette and
money is stacked bullion (silhouette breaks for instant read). Per-box variety is `U.hash(''+id)`;
the only `nowMs` uses are the amber LED, command strobe, data read-head, and gold sheen — blooms
gate behind `globalAlpha>0.6` so fading boxes skip them.

**Motion** (`boxMotion`, translate-only — no `ctx.scale`): hash-phased ride bob, lean into travel,
bob-coupled contact shadow, spawn-pop (easeOutBack lift + alpha ramp via `t0`), a corner jolt on
heading change (`turn0`), and a sink that falls into the chute (slide in dir + fade + shrink shadow).

**Sim**: min-gap backpressure — a box never advances within `MIN_GAP` (0.82 tile) of the box ahead
(measured pre-move so it's order-independent and overlap-free), so work-items queue behind a stalled
one. There is **no auto-spawn** — belts carry only real work.

**Belt tiles** (`drawBelts` classifies each tile from the belt map): source = amber feeder hatch
(the belt's start, where an INTAKE feeds it); sink = dark chute mouth + lip shadow; corner = an elbow glyph bending
flow toward the exit; straight = axis-aware treads + a **dim-neutral** marching chevron (NOT an
economy accent — keeps cyan/green meaningful) + a small drive LED.

## Status

- **Stage 4a/4b (done):** directional belts + semantic cargo art + motion juice + min-gap
  backpressure; place/reclaim/undo/persist; REFIT + live world; deterministic sim; tests.
- **Work-item pipeline (done — Stages 1–2):** belts are the wiring of the agent work-pipeline. A
  real inbound message (Telegram) becomes a payload box via `enqueueAt`, rides the player-laid belts
  to the agent's desk, and fires `onDeliver`; a superseded run's box drops off the belt
  (`dropWorkitem`). The decorative auto-spawn was **removed** — every crate now means real work.
  Additive events: `workitem.placed/delivered/superseded`, `queue.status`. Plan:
  `docs/CONVEYOR_PIPELINE_PLAN.md`.
- **Later:** outbound belt (reply rides desk→OUTBOX); merge/split/filter junctions; RPG economy.
