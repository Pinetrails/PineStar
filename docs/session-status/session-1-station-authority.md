# Session 1 - Station Authority

## Current slice

Safe checkpoint: router-side Station authority seam. `router.setStation()` accepts a validated Station document and `router.stationFor()` derives bay capability room objects from that last-good Station instead of trusting forged `RoutingPlan.bays[].objects`.

## Changed files

- `sidecar/station-store.js`
- `sidecar/routing/router.js`
- `frontend/app/worldmodel.js`
- `test/routing.b5.test.js`
- `docs/session-status/session-1-station-authority.md`

## Evidence

- Added a routing test proving forged legacy plan objects (`cabinet`, `workbench`) cannot grant files or shell when an authoritative Station document is installed.
- Added a transactional test proving invalid empty Station updates are refused and the last-good Station remains active.
- Preserved `connectorId` through Station deserialize/migration so sidecar-derived connector portal authority keeps the bound server identity.

## Targeted tests

- `node test\routing.b5.test.js` - pass, 30 assertions.
- `node test\worldmodel.test.js` - pass, 181 assertions.

## Full gates

- `npm.cmd run test:fast` - pass on 2026-06-26T02:54:34-04:00.

## Live verification

- Not run in this checkpoint. No frontend runtime flow or HTTP route was changed.

## Blockers / holds

- No current coordination hold. `scripts/board.mjs --files` showed no uncommitted edits for `sidecar\routing\router.js` or `frontend\app\worldmodel.js`; contended tracked files noted by the board were not edited except the allowed narrow `worldmodel.js` serialization fix.

## Readiness claim

- Checkpoint only, not Session 1 READY. Remaining Session 1 loop items include `/api/station` acceptance/persistence, `/api/run` ignoring forged `body.placed`, HTTP forged-station/routing/capability tests, and live refit/COMMS smoke.

## Next loop condition

- Select `/api/station` sidecar acceptance/persistence, then wire accepted SaveDoc.station updates into `router.setStation()` before removing interactive trust in renderer-posted `placed`.
