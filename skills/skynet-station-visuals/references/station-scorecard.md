# Station Visual Scorecard

Score active station screenshots, not title screens. Use desktop and mobile screenshots when mobile is in scope.

## Scale

- 0: Placeholder or broken. Blank canvas, unreadable station, debug-only visuals, or no evidence.
- 1: Basic styled. Themed and functional, but flat, sparse, repetitive, or mostly palette changes.
- 2: Premium stylized. Authored surfaces, readable agent life, cohesive material language, responsive evidence.
- 3: Showcase. Memorable station identity, expressive agent embodiment, dense readable detail, polished motion, measured performance.

## Categories

1. Agent embodiment.
   - 0: Agent is missing, static, or unreadable.
   - 1: Basic sprite with limited states.
   - 2: Clear states for idle, moving, working, resting, attention, and status.
   - 3: Expressive behavior with strong silhouette, timing, and personality cues.
2. Station architecture.
   - 0: Flat or broken room layout.
   - 1: Rooms exist but read as rectangles.
   - 2: Hull depth, corridors, doors, windows, and room silhouettes are readable.
   - 3: Station feels like a physical place with memorable spatial identity.
3. Materials/textures.
   - 0: Flat colors.
   - 1: Some panel lines or grime.
   - 2: Cohesive deck, hull, wall, glass, trim, prop, and signal materials.
   - 3: Rich material language with variation, wear, decals, and disciplined asset use.
4. Lighting/depth.
   - 0: Default or unreadable darkness.
   - 1: Glows/flicker are mostly decoration.
   - 2: Baked and dynamic lighting ground rooms, props, and the agent.
   - 3: Cinematic but readable depth with contact and event lighting.
5. Live behavior.
   - 0: Static scene.
   - 1: Agent walks or idles but little else changes.
   - 2: Work, queues, connectors, compaction, deliveries, and wake states visibly change.
   - 3: The station feels alive through stateful, honest, varied behaviors.
6. Props/interactables.
   - 0: Generic or missing props.
   - 1: Repeated basic props.
   - 2: Key props have authored forms and state changes.
   - 3: Props tell the station's workflow at a glance.
7. UI/world cohesion.
   - 0: UI overlaps or contradicts the scene.
   - 1: UI is readable but generic.
   - 2: UI and world signals share hierarchy and color roles.
   - 3: UI, HUD, and in-world feedback feel like one product.
8. Texture/asset sourcing.
   - 0: No asset plan for high-value surfaces.
   - 1: Procedural-only without tradeoff notes.
   - 2: Appropriate procedural/generated/edited asset choices with paths.
   - 3: Strong source ledger and optimized assets for hero surfaces.
9. Responsive readability.
   - 0: Canvas or text breaks on mobile.
   - 1: Desktop only checked.
   - 2: Desktop and mobile screenshots reviewed with no major overlap.
   - 3: Responsive framing, touch targets, and text fit are verified.
10. Performance/evidence.
   - 0: No tests or screenshots.
   - 1: Informal manual check.
   - 2: Test gate plus browser/canvas screenshot evidence.
   - 3: Before/after evidence, diagnostics, and known risk list.

## Thresholds

Premium station pass:

- Every category at least 2.
- Average at least 2.3.
- Desktop and mobile screenshots captured or explicitly out of scope.
- `npm run test:fast` passes or known unrelated failures are documented.

Showcase station pass:

- At least six categories score 3.
- No category below 2.
- Average at least 2.7.
- Includes before/after screenshots or an equivalent visual audit.

## Automatic Failures

Any of these blocks a premium/showcase claim:

- No active station screenshot.
- Agent is visually unchanged when agent embodiment was in scope.
- Visual changes are only darker colors, bloom, or noise.
- UI covers the agent, props, or work path.
- Mobile canvas is blank, clipped, or unusable.
- Tests or console errors are ignored.
- Shared contract files were edited for visual-only work.

## Report Format

```text
Station visual scorecard:
- Agent embodiment: before X / after Y - evidence:
- Station architecture: before X / after Y - evidence:
- Materials/textures: before X / after Y - evidence:
- Lighting/depth: before X / after Y - evidence:
- Live behavior: before X / after Y - evidence:
- Props/interactables: before X / after Y - evidence:
- UI/world cohesion: before X / after Y - evidence:
- Texture/asset sourcing: before X / after Y - evidence:
- Responsive readability: before X / after Y - evidence:
- Performance/evidence: before X / after Y - evidence:
Average:
Automatic failures remaining:
```
