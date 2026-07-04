---
name: starnet-backend-law
description: StarNet sidecar/backend laws — architecture shape, event contract ownership, persistence, route conventions, provider/billing rules. Use for ANY change under sidecar/ or shared/.
---

# StarNet backend law

## Architecture shape (don't fight it)
- ONE process: `npm start` → sidecar on :8787 serving API + frontend. A single `runOnce`
  agent loop drives runs; state flows to the frontend as **U.bus events**, and the world
  renders from replayable state (prefer state-carrying events over fire-and-forget).
- Providers are pluggable (OpenRouter/replay/etc.); billing/budget reconcile token deltas —
  any change to run flow must keep cost reconciliation intact.

## The shared contract is OWNED
- `shared/events.js` and `shared/schema.js` belong to ONE owner lane. You do not edit them.
  Need a new event/field? Request it; changes are **additive only** — never rename/remove.
- After merging any hotfile (loop.js, billing.js, budget.js, router.js, station-store.js,
  orchestration.js, worldmodel.js, build.js, package.json): `node --check` + grep that every
  symbol it calls still exists. Auto-merge lies on these files.

## Route & API conventions
- New sidecar routes must respect the existing auth seam (launch-token/origin restriction),
  never take an unsanitized path (fs jail), and never echo stored secrets back.
- Media/latency endpoints (STT/TTS-style) follow the **200-always contract**: failures return
  200 with an error payload, not 5xx — the frontend depends on it.
- Every API claim a panel shows must come from real store state — never synthesize
  plausible-looking values (truthful telemetry applies to JSON, not just pixels).

## Persistence
- Any state a user would expect to survive must round-trip a sidecar restart — and you must
  TEST that round-trip live before claiming done (top recurring bug class).
- Save-dir writes go through the existing store helpers; no ad-hoc file writes.
- **One sidecar process per WORKSPACES dir is a HARD INVARIANT.** durable-store.js's concurrency
  safety is an IN-PROCESS async mutex — sufficient *because* a save dir has a single sidecar owner
  (`npm start` → one :8787; the desktop shell spawns one sidecar per install). There is no
  cross-process file lock on the general stores by design; running two sidecars on the same dir
  would silently clobber updates. (The cron scheduler, which can't assume single ownership, uses
  its own pid-stamped on-disk lock in cron-lock.js — that's the exception, not the pattern.)

## Naming reality
- Internal `skynet.*` keys/event names/schemas are intentionally kept post-rebrand. Do NOT
  rename them to `starnet.*` — that's a silent save-breaking migration, not a cleanup.
- Channel ingress (Telegram/Discord): owner-only admission enforced; inbound content is data,
  never eval'd or shelled.

## Tests
- `npm run test:fast` is the merge gate; sidecar/route changes also run `npm run test:http`.
- t1/t5 hardcoded mtimes in fixtures are relative-ordering fixtures — never compared to now;
  don't "fix" them as a date bug.
