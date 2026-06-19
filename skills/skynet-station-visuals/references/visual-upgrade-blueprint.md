# Visual Upgrade Blueprint

Use this before broad station visual work. It adapts the vendored Three.js game-graphics workflow to Skynet's current station.

## Choose The Upgrade Path

Canvas polish:

- Best for near-term improvements to the existing product.
- Work mostly in `frontend/app/stationbake.js`, `frontend/app/world.js`, `frontend/app/propsprites.js`, CSS, and assets.
- Improve materials, lighting, prop sprites, agent states, environmental motion, and verification without architectural churn.

Texture/asset pass:

- Best when floors, walls, hull, props, decals, or sprites need richer surfaces.
- Store generated or edited bitmaps under `frontend/assets/` with a manifest or explicit loader.
- Keep provenance and avoid secrets in browser code.

Three.js renderer path:

- Best for a deliberate 3D station prototype or high-fidelity renderer.
- Isolate it as an alternate renderer that consumes the existing world model.
- Use the vendored Three.js director and graphics-builder references before planning.

## Production Surfaces

Upgrade the weak visible surfaces, not only the easiest one.

- Agent embodiment: clearer silhouette, eyes/visor/status lights, posture, working/resting/curious states, glance/look-up behavior, speech bubble readability, and meaningful animation timing.
- Station architecture: hull depth, room silhouettes, corridor readability, doors, windows, chamfered corners, exterior machinery, and scale cues.
- Materials/textures: named material roles for floor, hull, wall face, trim, glass, hazard, reward, workbench, connector, conveyor, and UI signal colors.
- Props/interactables: authored versions of workbench, intake/outbox, connector portals, conveyors, couch/desk, memory gauge, and high-value room objects.
- Lighting/depth: baked lightmap, door spill, contact shadows, dynamic glows, flickers, and exposure that keeps the agent readable.
- VFX/motion: event-driven effects for wake, tool call, run start/end, queue jam, delivery, compaction, connector pulse, verify result, and level up.
- UI/world cohesion: HUD colors and icons should match in-world signals without covering the agent or work path.
- Performance evidence: canvas/frame diagnostics, screenshot evidence, and test gate.

## Material Roles

Prefer named roles over one-off colors:

- `deckBase`: station floor plates.
- `deckWear`: scratches, stains, scuffs, panel tone variance.
- `hullShell`: exterior slab and dark void-facing mass.
- `wallFace`: tilted wall face and corridor edge.
- `trimLight`: bevels, wall lips, panel rims, door thresholds.
- `glassVoid`: windows, visor glass, connector portal glass.
- `signalGreen`, `signalAmber`, `signalRed`, `signalBlue`: honest state lights.
- `agentCore`: the hero agent's identity accent.
- `workActive`: active workbench/conveyor/tool state.
- `memoryCore`: context gauge and compaction effect.

## Implementation Order

1. Capture the current desktop and mobile station screenshots.
2. Score the current visuals with `station-scorecard.md`.
3. Pick the weakest three categories.
4. Make the smallest renderer/asset changes that improve those categories.
5. Preserve state and interaction behavior.
6. Re-capture screenshots and re-score.
7. Run `npm run test:fast`.

## Three.js Upgrade Order

When the task calls for a real 3D station:

1. Read the vendored `threejs-game-director` and `threejs-aaa-graphics-builder` skills.
2. Build a thin `WorldModel` to Three.js scene adapter.
3. Create material and prop factories before adding post-processing.
4. Implement camera, picking, resize, and mobile framing.
5. Add agent embodiment and path interpolation from existing world state.
6. Keep the 2D renderer behind a flag until the 3D path is verified.
7. Verify canvas nonblank, console errors, screenshots, and interaction.

## Asset Sourcing Ledger

For premium visual work, report:

- Agent/body/sprite source: existing sprite, edited bitmap, generated bitmap, procedural, or 3D.
- Station textures: procedural canvas, generated image, hand-authored asset, or hybrid.
- Props/signature objects: procedural, bitmap, generated image, generated 3D, or hybrid.
- UI/world icons/decals: source and output path.
- External generation blockers: missing key/tool, user declined, offline constraint, or failed attempt.

Procedural-only is valid for low-value repeated station detail. For hero agent surfaces or signature station textures, procedural-only needs a reason.
