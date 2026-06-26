# Session 1 - Station Authority

## Current slice

Safe checkpoint: pure SaveDoc.station authority intake. `makeStationStore().setSaveDoc()` accepts a saved envelope only when it carries a valid `SaveDoc.station`, installs that Station as last-good authority, and refuses invalid/missing Station data transactionally.

## Changed files

- `sidecar/station-store.js`
- `sidecar/routing/router.js`
- `frontend/app/worldmodel.js`
- `test/station-authority.test.js`
- `test/routing.b5.test.js`
- `docs/session-status/session-1-station-authority.md`

## Evidence

- Added a routing test proving forged legacy plan objects (`cabinet`, `workbench`) cannot grant files or shell when an authoritative Station document is installed.
- Added a transactional test proving invalid empty Station updates are refused and the last-good Station remains active.
- Preserved `connectorId` through Station deserialize/migration so sidecar-derived connector portal authority keeps the bound server identity.
- Added pure station-store coverage proving `SaveDoc.station` can be accepted from a save envelope, missing Station data is refused, and invalid Station updates leave the last-good Station active.

## Targeted tests

- `node test\routing.b5.test.js` - pass, 30 assertions.
- `node test\station-authority.test.js` - pass, 9 assertions.
- `node test\worldmodel.test.js` - pass, 181 assertions.

## Full gates

- `npm.cmd run test:fast` - pass on 2026-06-26T02:54:34-04:00.
- `npm.cmd run test:fast` - pass on 2026-06-26T03:56:00-04:00.

## Live verification

- Not run in this checkpoint. No frontend runtime flow or HTTP route was changed.

## Blockers / holds

- HELD-FOR-COORDINATION on `sidecar/index.js` for the `/api/station` hook. `node scripts/board.mjs --files sidecar/index.js sidecar/station-store.js sidecar/routing/router.js test/sidecar.http.test.js docs/session-status/session-1-station-authority.md` on 2026-06-26T07:53Z reported active uncommitted edits to `sidecar/index.js` in `agent/hermes-settings-audit`, `agent/starnet-replacement-eval`, and `agent/starnet-spend-model-honesty`. No `sidecar/index.js` edits were made in this checkpoint.

## Readiness claim

- Checkpoint only, not Session 1 READY. Remaining Session 1 loop items include `/api/station` acceptance/persistence hook in `sidecar/index.js`, `/api/run` ignoring forged `body.placed`, HTTP forged-station/routing/capability tests, and live refit/COMMS smoke.

## Next loop condition

- Retry the `sidecar/index.js` board check after the active lanes release it. Then wire `/api/station`/save acceptance through `stationStore.setSaveDoc()` and `router.setStation()` before removing interactive trust in renderer-posted `placed`.
