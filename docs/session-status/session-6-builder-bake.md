# Session 6 - Builder Bake Status

Updated: 2026-06-26T06:00:11-04:00

## Current Slice

REFIT viewport-wired chunk bake checkpoint:
- Added a `StationBake.missingVisibleChunks()` query so callers can detect when a camera pan exposes chunks that were not retained.
- Added `onlyMissingVisible` incremental bake mode so pan-driven fills bake only newly exposed visible chunks instead of treating a missing dirty rect list as a full-station dirty set.
- Wired `frontend/app/build.js` to pass the current bake-local camera viewport into `StationBake.bakeIncremental()` and `StationBake.drawBase/drawLight()`.
- Bounded REFIT chunk retention with a small visible/dirty chunk cache cap while preserving dirty and visible chunks.
- Documented the live REFIT viewport/culling behavior in `frontend/app/BUILDER.md`.
- Added seam/bounds release evidence for full chunk composites and origin-reset rebuilds.

## Changed Files

- `frontend/app/stationbake.js`
- `frontend/app/build.js`
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
  - retained caches keep dirty and visible chunks while evicting older non-required chunks;
  - complete visible caches report no missing visible chunks;
  - panning a visible-only cache reports the newly exposed chunk;
  - `onlyMissingVisible` fills that newly exposed chunk without dirtying or rebaking the whole station.
  - full-station chunk draw coordinates cover the exact 900x650 bake area with no gaps, overlaps, or seam offsets;
  - origin changes reset stale chunk metadata while still rebuilding only visible chunks and never allocating full-world base/light canvases.
- REFIT caller now computes the current camera viewport in bake-local pixels and uses it for bake, draw culling, and pan-triggered missing chunk fills.
- `npm.cmd run shoot` passed and captured all visual states.
- `npm.cmd run golden` kept Session 6 builder frames stable: `build-station diff=0.11`, `build-manual diff=0.05`, `build-connectors diff=0.84`; the remaining changed frames are non-builder screens already tracked as blockers.
- `npm.cmd run audit` passed all builder/moat checks: `moat/build-mode`, `moat/place-prop`, `moat/capability-online`, and `moat/caps-well-formed`.

## Tests Run

- `node test/stationbake.chunk.test.js` - PASS, 29 assertions.
- `npm.cmd run test:fast` - PASS, includes `stationbake.chunk`.
- `npm.cmd run shoot` - PASS, all states captured.
- `npm.cmd run golden` - FAIL outside builder target: `crew-roster diff=14.11`, `crew-summon diff=14.46`, `work-recipes diff=14.39`, `build-skills diff=2.40`; `build-station`, `build-manual`, and `build-connectors` passed.
- `npm.cmd run audit` - FAIL outside builder bake slice: `summon/bay-open` never saw `.mkt-primary`; builder/moat checks passed and placeholder task lifecycle passed.

## Blockers / Holds

- `GOLDEN-UNRELATED-SCREENS`: golden remains blocked by non-builder frames. I did not bless unrelated baselines from this Session 6 worktree.
- `AUDIT-SUMMON-UNRELATED`: audit summon marketplace behavior is failing outside owned Session 6 files.

## Readiness Claim

Safe checkpoint committed for review, but Session 6 is not DONE. Chunked REFIT bake now has exact dirty chunk mapping, bounded chunk canvases, visible viewport culling, bounded retention, and caller-side pan fills that do not rebake the whole station. `test:fast` is green. Full ready remains blocked by unrelated golden/audit failures outside the Session 6 ownership boundary.

## Next Loop Condition

After unrelated visual/audit blockers are resolved or accepted, rerun `npm.cmd run golden` and `npm.cmd run audit`, then select the next scale slice: live-world chunk cache integration or seed-station monolithic-vs-chunk pixel tolerance.
