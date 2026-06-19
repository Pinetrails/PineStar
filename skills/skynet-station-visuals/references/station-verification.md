# Station Verification

Use this before finalizing station visual changes.

## Local Commands

- `npm run test:fast`: required merge gate for this repo.
- `npm start`: full app at `http://127.0.0.1:8787`.
- `npm run serve`: UI-only static server at `http://127.0.0.1:8087`; use only for pure UI/canvas work and clearly report that agent APIs are not live.

## Browser Evidence

Minimum after meaningful visual work:

- Desktop active-station screenshot.
- Mobile or narrow viewport active-station screenshot unless explicitly out of scope.
- Browser console/page error check.
- Canvas nonblank or equivalent visual inspection.
- Main interaction path still works: open station, pan/zoom or click agent/prop, and verify no broken overlay.
- If assets changed, verify missing/failed asset paths do not blank the station.

## Canvas Inspector

When Playwright is available, run:

```bash
node skills/skynet-station-visuals/scripts/inspect-station-canvas.mjs --url http://127.0.0.1:8787
node skills/skynet-station-visuals/scripts/inspect-station-canvas.mjs --url http://127.0.0.1:8787 --mobile
```

For UI-only checks:

```bash
npm run serve
node skills/skynet-station-visuals/scripts/inspect-station-canvas.mjs --url http://127.0.0.1:8087
```

The script samples `canvas#stage`, writes JSON and screenshots to `artifacts/station-canvas`, and exits nonzero for blank/low-variance canvas or browser errors.

## Final Evidence

Report:

- Files changed.
- Reference ledger.
- Station scorecard.
- Asset sourcing ledger when assets/textures changed.
- Test commands and results.
- Screenshot/report paths when captured.
- Residual risks.
