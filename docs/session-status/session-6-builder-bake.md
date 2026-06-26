# Session 6 - Builder Bake Status

Updated: 2026-06-26T02:58:49-04:00

## Current Slice

Chunked incremental REFIT bake checkpoint:
- Added `StationBake.bakeIncremental()` with 384px chunk canvases.
- Added dirty rect to dirty chunk mapping with a bake pad for walls/light spill.
- Added chunk reuse stats so tests and future perf probes can prove partial rebakes.
- Wired `Build` to accumulate `WorldPatch.dirtyRects` and reuse untouched bake chunks.
- Preserved the legacy `StationBake.bake()` monolithic API for existing callers.

## Changed Files

- `frontend/app/stationbake.js`
- `frontend/app/build.js`
- `frontend/app/BUILDER.md`
- `test/stationbake.chunk.test.js`
- `package.json`
- `docs/session-status/session-6-builder-bake.md`

## Evidence

- `test/stationbake.chunk.test.js` proves a 900x650 synthetic station uses a 3x2 chunk grid with no canvas larger than 384x384.
- The same test proves a single tile dirty rect maps to chunk `0,0`, rebakes one chunk, and reuses five untouched chunks.
- `npm.cmd run shoot` passed and wrote screenshots to `.uishots`.
- `npm.cmd run golden` showed the Session 6 target frame stable: `build-station diff=0.05` under threshold `1.5`.
- `npm.cmd run audit` passed the builder/moat path: `moat/build-mode`, `moat/place-prop`, `moat/capability-online`, and `moat/caps-well-formed`.

## Tests Run

- `node test/stationbake.chunk.test.js` - PASS, 10 assertions.
- `npm.cmd run test:fast` - PASS, includes `stationbake.chunk`.
- `npm.cmd run shoot` - PASS, all states captured.
- `npm.cmd run golden` - FAIL outside builder target: `crew-roster diff=14.10`, `crew-summon diff=14.46`, `work-recipes diff=14.39`, `build-skills diff=2.43`; `build-station` passed.
- `npm.cmd run audit` - FAIL outside builder bake slice: `summon/bay-open` never saw `.mkt-primary`; builder/moat checks passed.

## Blockers / Holds

- `GOLDEN-UNRELATED-SCREENS`: golden is blocked by non-builder frames. I did not bless unrelated baselines from this Session 6 worktree.
- `AUDIT-SUMMON-UNRELATED`: audit is blocked by summon marketplace behavior outside owned Session 6 files.

## Readiness Claim

Checkpoint is safe to review but not DONE. The chunked REFIT bake slice is implemented and `test:fast` is green. Session 6 cannot claim full done condition until the unrelated visual/audit blockers are resolved or accepted and final golden/audit gates are green.

## Next Loop Condition

After visual baseline blockers are cleared or accepted, rerun `npm.cmd run golden` and `npm.cmd run audit`, then select the next scale slice: visible chunk culling / LRU eviction / seed-station monolithic-vs-chunk pixel tolerance.
