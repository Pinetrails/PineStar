# Session 4 - Managed Credits Status

## Current Slice

- Tightened pure managed-credit admission conflict handling while route integration remains held.
- Selected invariant: duplicate managed-credit admission retries are idempotent only when the billing identity matches; a reused `runId` cannot switch BYOK/managed mode, managed account, or reserved cap.

## Changed Files

- `sidecar/billing.js`
- `test/billing.test.js`
- `docs/session-status/session-4-managed-credits.md`

## Evidence

- `sidecar/billing.js` now compares duplicate `beginRun` calls against the original billing mode.
- Duplicate BYOK admissions remain idempotent.
- Duplicate managed admissions remain idempotent when account and reserved cap match, preserving the existing exactly-once debit behavior.
- A reused `runId` that attempts to switch from BYOK to managed returns `billing_run_conflict` before any managed payment call.
- A reused managed `runId` that attempts to switch accounts returns `billing_run_conflict` and does not debit the second account.
- A reused managed `runId` that attempts to change the reserved cap returns `billing_run_conflict` and does not debit again.
- `AGENTS.md` is absent under `C:\Users\andro\gen-trees`; `CLAUDE.md` and `docs/STARNET_SESSION_LOOPS_1_6.md` were followed.
- `node scripts/board.mjs --files sidecar/index.js` still reports `sidecar/index.js` as contended by `agent/hermes-settings-audit`, `agent/starnet-replacement-eval`, and `agent/starnet-spend-model-honesty`.
- `node scripts/board.mjs --files sidecar/ledger.js test/ledger.test.js sidecar/billing.js test/billing.test.js docs/session-status/session-4-managed-credits.md` reports `sidecar/ledger.js` as contended by `agent/starnet-replacement-eval` and `agent/starnet-spend-model-honesty`; no live contention was reported for `sidecar/billing.js` or `test/billing.test.js`.

## Tests Run

- `node test\billing.test.js` - OK, 55 assertions.
- `node test\budget.test.js` - OK, 49 assertions.
- `npm.cmd run test:fast` - OK.

## Full Gates

- `npm.cmd run test:fast` - green on 2026-06-26 at 2026-06-26T14:01:18-04:00.
- `npm.cmd run test:http` - not run; this slice added no HTTP route.

## Live Verification

- Not run; this slice is pure backend billing code and does not expose UI or HTTP behavior yet.
- No real managed-credit provider or real-money spend was used.

## Blockers / Holds

- HELD-FOR-COORDINATION: `sidecar/index.js` is still hot/contended by `agent/hermes-settings-audit`, `agent/starnet-replacement-eval`, and `agent/starnet-spend-model-honesty`, so `/api/run` managed-credit admission wiring was not attempted in this loop.
- HELD-FOR-COORDINATION: `sidecar/ledger.js` is hot/contended by `agent/starnet-replacement-eval` and `agent/starnet-spend-model-honesty`, so strict durable managed-ledger persistence was not attempted in this loop.
- `test/billing.test.js` is not wired into `test:fast` because `package.json` is outside the Session 4 owned-file list in the runbook.

## Readiness Claim

- Safe checkpoint slice is ready: pure billing admission now fails closed on conflicting `runId` reuse, and the full fast gate is green.
- Session 4 done condition is not yet met; route integration, run-loop/HUD selection, HTTP tests, strict durable managed-ledger persistence, and fake-provider live smoke remain.

## Next Loop Condition

- Retry `node scripts/board.mjs --files sidecar/index.js sidecar/ledger.js`; if `sidecar/index.js` is no longer hot, wire managed-credit authorization plus the budget resume guard into the run admission/resume routes and add fake-provider HTTP coverage. If `sidecar/ledger.js` is no longer hot first, add strict durable append behavior for managed final spend. If both remain hot, select another pure backend invariant.
