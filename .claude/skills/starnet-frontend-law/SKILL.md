---
name: starnet-frontend-law
description: LOCKED StarNet frontend/canvas/UI laws — windows, COMMS beats, sprites, props, CRT look, hover rules, theming traps. Use for ANY change under frontend/ or to the rendered world.
---

# StarNet frontend law — locked decisions, do not relitigate

## Visual language
- Pixel-art station, **eerie-not-cute**, CRT phosphor aesthetic. BOLD effects, not subtle —
  tune via crtlab (`?crtlab=1`) and COPY VALUES back into code; never guess constants.
- Canvas text = **VT323 + phosphor glow**. UI chrome uses the shipped motion.css tokens +
  CRT window chrome + card language — reuse that vocabulary; don't invent new motion/easing.
- Barrel/curvature = per-pixel LUT remap (WebGL fast path) — never mesh/SVG tricks.

## Windows, hover, COMMS
- **Hover = glance:** a tiny nameplate only. NEVER open a window on hover.
- COMMS beats: decided cards must `vanish()`; **one post-run beat at a time** (a single shared
  slot); asides use the gold-inset beat family, never `.reply`.
- Dock targets stay hidden until their window opens; never hardcode prop labels — resolve via
  `resolveKit`.

## Sprites & world drawing
- Author sprites chunky ~48px; in-world draw = **smooth-downscale the 92px master in
  drawBody** — never NN-crush.
- drawBody anchors agent **FEET** (per-skin foot padding) to the floor line, not image bottom.
- Walls follow the tall-walls bake laws (WALL knobs live in crtlab).
- Props follow the v3 LOCKED STYLE LAW; no bare `require()` in prop modules.
- Specialists own only their desk; other props are station-shared via the overseer — never
  build per-agent prop kits.

## Theming trap
- Composite shadow vars that reference `--ph` must live on `body`, NOT `:root`, or theme
  switches silently break bezels.

## Product-behavior laws that bind UI work
- **Truthful telemetry:** every badge/status/count must map to a provable backend state.
  Building a UI that asserts unprovable state is a bug even if it looks great.
- **Sandbox, no gating:** never add unlock/grind walls to make a flow "guided".
- Reactive desk trip: agents walk to workstations on REAL tool use (`isTask` gates tools
  only) — do not revert to eager-walk.
- Object = capability: a prop in the world IS the projection of a real capability; cosmetic-
  only functional props are lies.

## Verification
Screenshots time out on the game canvas — verify via preview_eval DOM/world-model round-trips
and canvas pixel samples (see `starnet-verify`).
