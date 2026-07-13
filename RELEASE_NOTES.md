# StarNet v0.5.0

The station looks better, works harder while you're away, and understands what you're building.

## Station visuals — the bake overhaul
- New floor materials: per-kind V2 recipes (plate / panel / tile / tread / soft) and V3 dimensional slab tiles with grout and lit bevels.
- Floor wear: scuffs, drag marks, grime films, and corridor traffic lanes.
- Corner AO — shadow pools in concave wall corners — and a Bayer-dithered light map for a hard pixel-idiom look (defaults hand-dialed in crtlab).
- Removed the glitched floating INBOX gauge the CRT warp mangled.

## Quests V3
- Standing 24-hour quest refresh with a caught-up fast path, grounded in your interests and progression.
- North star: the station proposes what it thinks you're aiming at and asks you to confirm — never silently adopts an inference.
- New QUEST V3 panel: north star, REFRESH QUESTS, and the attempt ledger.

## Night Shift honesty
- Raising the dial now records the away-workshop grant explicitly; the panel says whether it will BUILD or DRAFT, with honest readiness lines.
- LAST REPORT can be re-opened from the NIGHT SHIFT panel.
- A nudge surfaces unseen overnight drafts when the app was left open.

## Scout & recruitment
- SCOUT LOG: the scout's attempt ledger rendered in the recruitment bay.
- Scout drafting now cites your open quest slate and confirmed north star.
- Fixed the recruiter warm floor tracking calibration.

## Voice
- ONE locked station voice across all personas, with TTS from any provider credential — preferring the run provider's native voice API.

## COMMS & UI polish
- ROBCO-style composer register with a redrawn fine-line icon set; agent selector shows the full name on a molded chip.
- The COMMS seam now drags as far left as you want.
- ASCII-motion kit: spinners, a cell-tick context gauge, and decode transitions on toasts/broadcasts.
- Premium molded register across shared controls and instrument-styled widgets.
- Context gauge now tracks real occupancy (internal side-runs no longer stomp it).

## Projects & onboarding
- PROJECTS is its own drill-in space; anchored sessions carry their folder into every run.
- The awakening now digs for your actual projects and ambitions, not just categories.

## Under the hood
- Aux model spend is bounded by a joint governor.
- A decline anywhere suppresses re-proposals everywhere (shared declined index).
- Removed the postcard/clip share buttons.
