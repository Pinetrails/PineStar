# ▲ SKYNET — Real Gamified AI-Agent Harness

Turning the **v7 Skynet** simulation into a **real**, downloadable desktop app where you
create AI agents like Terraria characters, raise them through a gamified onboarding, and
watch them do real work — real model calls, real tools, real cost — inside a living
pixel-art station **you build yourself**.

It's a **station builder** (think PewDiePie's *Tuber Simulator*): you spawn into one shabby
starter room and expand outward — placing rooms, dragging hallways, painting floors, upgrading
from rusty to pristine. The twist: **the way you build the station literally configures your real
multi-agent org.** A room is a capability-scoped team, a hallway is an authorized handoff lane, a
placed object is a real capability grant. The layout you draw *is* the workflow the agents run.

> **Status: planning.** No app code yet. This folder currently holds the build plan.

## Read these in order

1. **[SKYNET_BUILD_PLAN.md](SKYNET_BUILD_PLAN.md)** — the product plan. **§0 Locked Decisions**,
   architecture, the object→capability abstraction, onboarding, monetization, the proposed
   folder structure, and the 15 open product decisions. **Start here for the *what*.**
2. **[BUILDER_AND_WORLD_FOUNDATION.md](BUILDER_AND_WORLD_FOUNDATION.md)** — **the architectural
   bible.** The mutable `Station` data model, Mutation API, save versioning, chunked/camera
   renderer, the builder & "shabby → glorious" arc, and station-as-workflow. Decisive: it locks
   the cross-cutting design choices. **The *how*.**
3. **[INCREMENTAL_ROADMAP.md](INCREMENTAL_ROADMAP.md)** — the step-by-step. Every step has a
   one-line goal, the exact v7 files to port, a definition-of-done, and the test that gates it.
   Opens with the universal 12-point DoD checklist. **The *in what order*.**
4. **[docs/v7-subsystem-analysis.md](docs/v7-subsystem-analysis.md)** — deep reuse-vs-rebuild map
   of every v7 module.
5. **[docs/design-proposals.md](docs/design-proposals.md)** · **[docs/builder-pillar-designs.md](docs/builder-pillar-designs.md)**
   — the raw design tracks both plans were synthesized from.
6. **[docs/raw-workflow-output.json](docs/raw-workflow-output.json)** ·
   **[docs/raw-builder-foundation-output.json](docs/raw-builder-foundation-output.json)** — full structured output.

## The one-line bet

Keep v7's entire vanilla-JS canvas world **unchanged** (renderer, tile map, movement/sit/work
state machine, sprite recolor, prop-terminal, CRT theme) and make it real by **replacing the
fake `sim.js` with a thin bridge that re-emits real agent-runtime events onto the same `U.bus`
event vocabulary the frontend already listens for.**

## Chosen stack (see plan §3)

Tauri shell · Node.js agent-host sidecar (owns secrets) · OpenRouter default gateway ·
SQLite persistence · localhost WebSocket carrying the existing `U.bus` event schema.

## Source project

The v7 simulation lives at `../v7`. We copy its engine + assets in; we do not modify it.
