---
name: starnet-verify
description: How to actually prove a StarNet change works — live-app verification mechanics (boot, DOM round-trips, canvas gotchas, test gates, run smoke). Use before claiming ANY task done.
---

# Verifying StarNet work — evidence or it didn't happen

## The gates (always, in order)
1. `node --check` every JS file you touched (catches the paren you dropped in a 3k-line file).
2. `npm run test:fast` — must be fully green. Touched sidecar/ship/route code → also
   `npm run test:http`.
3. Live verification in the REAL app (below). Tests green without a live check is NOT done.

## Booting the app
- `npm start` → http://127.0.0.1:8787. NEVER `npm run serve` (UI-only, dead backend).
- In a worktree, use the per-worktree dev-seed launch config + keyless `dev/.env.dev` so you
  don't need real keys; the replay provider drives real runs deterministically.
- Prefer the preview tools (`preview_start` via `.claude/launch.json`) so you get console,
  network, and DOM access.

## The canvas gotcha (will burn you)
- **Screenshots time out on the game canvas** (rAF-driven). Do NOT verify via screenshot.
- Verify via `preview_eval` DOM/state round-trips instead: query the world model, read
  `U.*` state, assert on DOM panels, or read specific pixels via a canvas sample helper.
- CRT/lighting effects: verify numbers via the crtlab (`?crtlab=1`) values, not eyeballing.

## What counts as proof, per change type
- **Backend behavior:** drive one real run end-to-end (replay provider fine); assert the
  events arrive (`agent.run.end{done}`), token/cost deltas reconcile, and the boot log gained
  no new error lines.
- **Persistence:** do the thing → restart the sidecar → confirm the state survived. A huge
  fraction of past bugs were "worked until restart."
- **UI state claims:** find the backend truth (route/store/event) and confirm the UI matches
  it — the app must never assert what the harness can't prove.
- **Panel/window UI:** preview_snapshot for structure + preview_eval for the specific text/
  class you changed; interactions via preview_click/fill then re-snapshot.
- **Sprites/world drawing:** DOM round-trip on the world model + one canvas pixel sample;
  check feet anchor to the floor line and no NN-crush artifacts (see starnet-frontend-law).

## Reporting the evidence
Paste the actual artifact into your report: the eval result, the log line, the test summary.
Say explicitly what was NOT verified. Unverifiable ≠ done — report it as unverified.
