# Summon Fixes — plan

Three bugs in the **multi-agent summon flow**, all traced to the live `frontend/app/` engine
(NOT the dead `frontend/js/` v7 sim, which only `v7-reference.html` loads).

## Architecture context (why these bugs exist)

`frontend/app/world.js` has a hard split:

- **`agent`** (the "hero", `world.js:52`) — the single active agent with the FULL state machine:
  `tick()` (`world.js:1300`), `wander()` (`world.js:614`), `decideIdle`, `nextWaypoint`, `arrive`.
  `tick()` early-returns on the hero alone (`world.js:1301`).
- **`crew`** (`world.js:53`) — every OTHER agent (summoned or bay-bound), described in the file's
  own header as *"LIGHT static figures... no pathing/AI — they just receive work and light up"*
  (`world.js:49-50`). Crew bodies are only **drawn** (`world.js:1444`), never **stepped**.

Summoned agents (`App.summonAgent`, `app.js:198`) become crew bodies via `World.spawnAgent`
(`world.js:1947`). That single design fact is the source of Bugs 2 and 3.

---

## Bug 1 — No "needs a computer" guidance on summon

**Root cause.** `summonAgent` (`app.js:198-223`) fires one generic toast — `"<name> summoned — give
it a task"` (`app.js:221`) — with **no capability check**. A summoned agent has no bay and no
compute by default. The only "NO COMPUTE" warning that exists is buried inside build mode
(`build.js:998-1006`), so a new user never sees it.

**Decision: Toast + persistent marker.**

**Fix (Phase 2).** After `World.spawnAgent`, check the agent's compute capability via
`station.bayObjects(agentId)` / `CAP_PROP_MAP` (`worldmodel.js:56-68`). If no `computer`:
- Replace the generic toast with actionable guidance: *"Place a computer so `<name>` can work —
  open REFIT to add one."*
- Show a **persistent "needs computer" marker** over the agent body that clears once a computer
  is placed/bound (re-checked on the routing-plan / floor change that already fires `geoDirty`).

---

## Bug 2 — Second agent vanishes after entering/exiting build mode  ✅ FIXED (Phase 1)

**Root cause.** `syncCrewFromPlan`'s early-return guard (`world.js:1900`):

```js
if (!routingPlan || !routingPlan.bays || !routingPlan.bays.length || !geo) { if (crew.length) crew = []; return; }
```

When there are **no bound bays**, it wiped the ENTIRE crew array — including summoned bodies. The
rest of the function carefully preserves summoned crew (`crew.filter(b => b.summoned)`,
`world.js:1910`), but this guard did not. A freshly summoned agent with no bay is exactly the
no-bays case. Toggling build fires a rederive (`station.onChange` → `geoDirty`, `world.js:211`),
which calls `syncCrewFromPlan` → the guard nuked the summoned body.

**Fix (applied).** Mirror the existing preservation in the guard:

```js
if (!routingPlan || !routingPlan.bays || !routingPlan.bays.length || !geo) { crew = crew.filter(b => b.summoned); return; }
```

**Verification.** `world.js` is a browser IIFE with no node coverage and `syncCrewFromPlan` is
private, so this is verified via (a) the existing `test:fast` gate staying green and (b) live
preview: summon an agent → toggle REFIT → confirm the body survives.

---

## Bug 3 — Summoned agent never moves / no idle wander

**Root cause.** By design: the entire movement+idle machine operates ONLY on the hero `agent`.
`tick()` early-returns on the hero (`world.js:1301`); crew bodies are never advanced. So a summoned
agent has no code path that moves it.

**Decision: Light wander only** (kept SEPARATE from the hero's rich leisure/prop/couch AI, to
respect the "crew = light bodies" boundary and avoid destabilizing the delicate hero code).

**Fix (Phase 3).** Add a lightweight per-crew idle stepper, invoked from `tick()` for each
non-hero `crew` body:
- When the body is not `working` and its `idleUntil` has elapsed, pick a random reachable tile
  (`geo.path` from its current tile, avoiding the belt/desk union like `wander()` does at
  `world.js:614-628`) and walk it via the SAME movement integrator pattern used for the hero
  (`world.js:1335-1356`), advancing `pathPts`/`pathIdx`.
- No props, couch, quirks, or leisure — just "walk around the station waiting for a task."
- A body with a live run (`working`) stays put in its working pose (current behavior preserved).

---

## Sequencing

1. **Phase 1 — Bug 2 one-line guard fix + test gate green.** ← done, pending verification.
2. **Phase 2 — Bug 1 prop guidance** (toast + persistent marker).
3. **Phase 3 — Bug 3 light crew idle-wander.**

All work in the `agent/summon-fixes` worktree. `npm run test:fast` green + rebase onto trunk
before merging to `feat/harness-backend`, per `CLAUDE.md` harness protocol.
