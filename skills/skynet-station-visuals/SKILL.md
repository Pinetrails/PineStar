---
name: skynet-station-visuals
description: "Improve or redesign the Skynet station's visual simulation of AI agents living and working inside the station. Use for station canvas polish, richer agent embodiment, station textures/materials, lighting, props, VFX, responsive visual QA, or planning a Three.js-based station renderer. This is a project-local replica/adaptation of the downloaded Three.js game skills; it does not install global Codex skills."
---

# Skynet Station Visuals

## Overview

Upgrade the station as a living visual simulation, not just a decorative shell. Start from the current Skynet canvas renderer and use the vendored Three.js game-skill mirror only when the task benefits from its game-graphics workflow, scoring gates, or a deliberate 3D renderer path.

This skill is project-local. Do not write to `C:\Users\andro\.codex\skills` unless the user explicitly asks to install a global skill.

## Required Context

Load these references before making visual changes:

- `references/station-surface-map.md` before choosing files or architecture.
- `references/visual-upgrade-blueprint.md` before broad station, agent, lighting, material, prop, VFX, or Three.js work.
- `references/station-scorecard.md` before claiming visuals are premium, richer, better looking, or complete.
- `references/station-verification.md` before final verification.

Load `references/texture-asset-recipes.md` before creating or editing station textures, sprite sheets, decals, icons, material references, or generated bitmap assets.

For broad Three.js game-style work, also read the vendored upstream skill files under `../vendor/threejs-game-skills/skills/`, especially:

- `threejs-game-director/SKILL.md`
- `threejs-aaa-graphics-builder/SKILL.md`
- `threejs-game-ui-designer/SKILL.md`
- `threejs-debug-profiler/SKILL.md`
- `threejs-qa-release/SKILL.md`

Track a reference ledger in the final response: reference path, loaded yes/no, and failure reason.

## Workflow

1. Inspect the current station surface first. The live station is a 2D canvas with a generalized bake, live agents, props, conveyors, wake animation, UI overlays, and browser-side state. Do not assume it is already a Three.js app.
2. Choose one path:
   - Canvas polish: improve `frontend/app/world.js`, `frontend/app/stationbake.js`, props, sprites, lighting, motion, or assets without changing renderer architecture.
   - Texture/asset pass: create or integrate station materials, decals, sprite updates, generated bitmaps, or manifests.
   - Three.js renderer path: only when explicitly requested or clearly valuable; preserve `WorldModel` and existing interaction/event contracts, and isolate the 3D renderer behind a new module rather than gutting the canvas path.
3. Keep the station readable. The agent, workbench, conveyors, queues, props, and UI state must remain legible during motion and on mobile.
4. Build in small increments. Keep world model/state ownership separate from rendering; keep baked static environment separate from per-frame actors/effects.
5. Verify with tests and browser evidence. Use `scripts/inspect-station-canvas.mjs` when Playwright is available, or use the repo/browser tools to capture desktop and mobile screenshots plus console errors.

## Quality Bar

Do not call the result premium, richer, better looking, or complete until:

- The station scorecard has no category below 2.
- The agent has clearer embodiment or behavior evidence, not only a palette change.
- The station material language includes authored floor/wall/hull/prop detail, not only darker colors or bloom.
- Lighting improves depth without hiding the agent or important props.
- Desktop and mobile screenshots are checked for canvas visibility, text overlap, and playable interaction.
- `npm run test:fast` passes, unless a pre-existing unrelated failure is documented.

## Vendored Source

The upstream skill package is mirrored at `skills/vendor/threejs-game-skills` in this repo. It is MIT licensed; keep its `LICENSE` file with any copied substantial portions.
