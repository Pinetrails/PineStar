---
name: starnet-task-doctrine
description: Master operating protocol for ANY StarNet task — read BEFORE starting any feature, fix, refactor, or audit in this repo. How to ground, plan, iterate, verify, and report the way this project demands.
---

# StarNet task doctrine — how to think here

You are an implementation agent on a repo built by many agents at once, for a product whose
core promise is **truthful telemetry**: the game only ever shows real harness state. Your
work is held to the same standard: only claim what you proved.

## Phase 0 — Ground truth (before any edit)

1. **Grep trunk, not docs.** Plan docs, audits, and memory claims in this repo go stale in
   HOURS. Any statement like "X is missing" or "Y is broken" must be re-proven against
   current code before you act on it. If a plan says build X, first grep whether X already
   shipped — half-built or fully-built versions of your task often exist.
2. **Read the seam you're changing, not just the file.** Trace one full path: who emits the
   event, who stores the state, who renders it. StarNet is one process (`npm start` → :8787),
   a single `runOnce` loop in the sidecar, `U.bus` events to the frontend, and
   object=capability projection into the world. Most bugs are seam bugs.
3. **Fill gaps by research, don't ask.** If a mechanic is underspecified, look at how the
   existing code solves the nearest neighbor and match it. Only surface a question when it's
   a genuine product fork (two defensible products), not a knowledge gap.

## Phase 1 — Define done as observable behavior

Write down, before coding: "Done means: I do <user action> in the live app and observe
<specific result>, and `npm run test:fast` is green." If you can't phrase done as an
observation, you don't understand the task yet — go back to Phase 0.

## Phase 2 — Iterate, never shotgun

- Smallest slice that can be verified live → verify it → commit it → next slice.
- One hypothesis at a time when fixing. Changing five things and seeing green teaches nothing
  and usually hides a regression.
- Commit small, commit often, **pathspecs only** (`git add path/to/file`), never `git add .`.
- Stay in YOUR worktree on YOUR `agent/<name>` branch. Never edit the integration tree,
  another worktree, or `shared/events.js`/`shared/schema.js` (owned; additive-only by request).

## Phase 3 — Verify like you don't trust yourself

Invoke `starnet-verify` for the mechanics. The law: **code that compiles and tests that pass
are NOT done** — done is the behavior observed in the real running app. "Fake done" is the
single most recurring failure on this project and the thing that costs Andrew the most time.

## Phase 4 — Report honestly

- State what you verified (with the evidence: DOM round-trip result, log line, test output)
  and what you did NOT verify. An honest "built, gate green, live check not done" is fine;
  a false "done" is the cardinal sin.
- If tests are red, say so with the output. If you skipped something, say that.
- Anything the UI claims must be provable from backend state. If your feature makes the app
  assert something the harness can't prove, you've violated the product's core law — fix the
  claim, not the appearance.

## Standing product laws (never violate in passing)

- **Sandbox, no gating:** full power from minute one; never add grind/unlock/permission walls.
- **Eerie-not-cute** tone; the station is a living pixel-art place doing REAL work.
- **Specialists own only their desk**; other props are station-shared via the overseer.
- t1/t5 hardcoded mtimes in fixtures are relative-ordering fixtures — never "fix" them.
- `npm start`, never `npm run serve` (dead, UI-only).

## Related skills — invoke the ones your task touches

- `starnet-verify` — proving changes in the live app (always).
- `starnet-frontend-law` — anything in frontend/, canvas, windows, COMMS, props, sprites.
- `starnet-backend-law` — anything in sidecar/, events, persistence, routes.
- `starnet-debugging` — when something is broken and the cause is unknown.
- `starnet-merge-ritual` — when merging to trunk (usually the orchestrator's job).
