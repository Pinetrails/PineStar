# Session 6 - Builder Bake Status

Updated: 2026-06-26T03:59:47-04:00

## Current Slice

Visible chunk culling and bounded chunk retention checkpoint:
- Added `StationBake.visibleChunks()` for local-pixel viewport to chunk selection.
- Extended `StationBake.drawBase()` and `StationBake.drawLight()` to accept an optional `visibleRect` and skip off-viewport chunks.
- Extended `StationBake.bakeIncremental()` with optional `{ visibleRect, maxRetainedChunks }` so large-station callers can cold-bake only visible chunks and evict older non-required chunks.
- Preserved the default full-composite behavior when callers omit those options.
- Documented the opt-in culling/LRU contract in `frontend/app/BUILDER.md`.

## Changed Files

- `frontend/app/stationbake.js`
- `frontend/app/BUILDER.md`
- `test/stationbake.chunk.test.js`
- `docs/session-status/session-6-builder-bake.md`

## Evidence

- `test/stationbake.chunk.test.js` now proves:
  - a 900x650 synthetic station uses a 3x2 chunk grid with no canvas larger than 384x384;
  - a single tile dirty rect maps to chunk `0,0`, rebakes one chunk, and reuses five untouched chunks;
  - visible viewport selection returns only intersecting chunks;
  - `drawBase(..., visibleRect)` draws only the visible chunk while preserving its world offset;
  - cold visible-only bake renders only requested chunks;
  - retention with `maxRetainedChunks: 2` keeps the dirty and visible chunks while evicting older non-required chunks.
- `npm.cmd run shoot` passed and refreshed `.uishots`.
- `npm.cmd run golden` kept the Session 6 target frame stable: `build-station diff=0.32` under threshold `1.5`.
- `npm.cmd run audit` passed the builder/moat checks: `moat/build-mode`, `moat/place-prop`, `moat/capability-online`, and `moat/caps-well-formed`.

## Tests Run

- `node test/stationbake.chunk.test.js` - PASS, 20 assertions.
- `npm.cmd run test:fast` - PASS, includes `stationbake.chunk`.
- `npm.cmd run shoot` - PASS, all states captured.
- `npm.cmd run golden` - FAIL outside builder target: `crew-roster diff=14.11`, `crew-summon diff=14.46`, `work-recipes diff=14.41`, `build-skills diff=2.41`; `build-station` passed.
- `npm.cmd run audit` - FAIL outside builder bake slice: `task/run-lifecycle` expected placeholder-key error end state and did not see one; `summon/bay-open` never saw `.mkt-primary`; builder/moat checks passed.

## Blockers / Holds

- `GOLDEN-UNRELATED-SCREENS`: golden is blocked by non-builder frames. I did not bless unrelated baselines from this Session 6 worktree.
- `AUDIT-TASK-UNRELATED`: audit task placeholder lifecycle is failing outside the builder bake/culling slice.
- `AUDIT-SUMMON-UNRELATED`: audit summon marketplace behavior is failing outside owned Session 6 files.

## Readiness Claim

Checkpoint is safe to review but not DONE. Chunked REFIT bake now has exact dirty chunk mapping, opt-in visible chunk culling, and bounded retention evidence. `test:fast` is green. Session 6 cannot claim full done condition until the unrelated golden/audit blockers are resolved or accepted and final visual/audit gates are green.

## Next Loop Condition

After visual/audit blockers are cleared or accepted, rerun `npm.cmd run golden` and `npm.cmd run audit`, then select the next scale slice: seed-station monolithic-vs-chunk pixel tolerance or caller-side viewport wiring.
