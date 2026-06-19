# Station Surface Map

Use this map before editing visuals. The current station is a 2D canvas system, with some legacy fixed-map code still present.

## Live App Surface

- `frontend/index.html`: loads the game screen, `canvas#stage`, CSS, and all browser modules.
- `frontend/app/app.js`: app lifecycle, title/connect/game transitions, saved state resume.
- `frontend/app/world.js`: live station renderer and agent embodiment. Owns camera, wake/idle behavior, agent motion, crew bodies, conveyors, speech bubbles, queue jam, floor economy overlays, context gauge, VFX, and canvas input.
- `frontend/app/worldmodel.js`: persisted station geometry, rooms, corridors, props, colors, and projection into bake geometry. Treat this as the source of truth for station structure.
- `frontend/app/stationbake.js`: generalized static station bake: floors, hull, walls, chamfers, lightmap, room lighting, corridor dressing, and material detail. This is usually the safest file for station texture/material upgrades.
- `frontend/app/propsprites.js`: rendered prop artwork, connector states, workbench pulses, arcade objects, and placed furniture/object visuals.
- `frontend/app/conveyor.js`, `frontend/app/pipeline.js`, `frontend/app/propanchor.js`: physical work-item flow, routing, and prop anchoring that visual changes must not break.
- `frontend/app/stationui.js`: in-app panels, SKILLS surface, notifications, agent dossier, settings, and bottom bar.
- `frontend/css/app.css`, `frontend/css/style.css`, `frontend/css/warroom.css`: shell and UI styling. Check text fit after visual changes.
- `frontend/assets/sprites/manifest.json` and `frontend/assets/sprites/*`: agent sprite sheets.
- `frontend/assets/furniture/*`: furniture bitmap assets exist, but much of the live station uses procedural prop drawing. Confirm usage before replacing assets.

## Legacy/Reference Surface

- `frontend/js/render.js`: older fixed-map station renderer. Useful as a vocabulary reference for hulls, walls, windows, stars, baked light, and glows.
- `frontend/js/assets.js`: sprite loading and per-agent recoloring for the legacy renderer.
- `frontend/js/sim.js`, `frontend/js/map.js`: older fixed v7 simulation/map references.

## Invariants

- Do not edit `shared/events.js` or `shared/schema.js` for visual work. They are shared-contract files owned by another workstream.
- Preserve `WorldModel` as the model source. Renderer changes should consume projected geometry, not duplicate station state.
- Preserve event-driven visual honesty: queues, spend, runs, tool calls, connectors, and context gauges should reflect real bus/API events when they claim to.
- Keep canvas rendering pixel-crisp unless a deliberate high-resolution/Three.js path is chosen.
- Keep mobile and reduced-motion behavior in scope for heavy animation, flashes, camera moves, or post-processing.

## Three.js Path Rules

Use Three.js only when the task explicitly asks for 3D/high-fidelity work or a scoped prototype. If adding it:

- Add a new renderer module such as `frontend/app/station3d.js` or `frontend/app/world3d.js`.
- Keep `WorldModel.projectGeometry()` or a thin adapter as the data bridge.
- Keep the 2D canvas path available until the user accepts the 3D replacement.
- Do not put asset-generation API calls in browser code.
- Add diagnostics equivalent to renderer/canvas visibility, entity counts, and active state.
