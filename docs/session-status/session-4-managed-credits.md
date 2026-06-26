# Session 4 - Managed Credits Status

## Current Slice

- Tightened pure managed-credit refund finalization while route integration remains held.
- Selected invariant: a managed run with unused reserved credit must fail closed if the payment adapter cannot refund the unused reserve.

## Changed Files

- `sidecar/billing.js`
- `test/billing.test.js`
- `docs/session-status/session-4-managed-credits.md`

## Evidence

- `sidecar/billing.js` now requires a working `payment.credit` adapter whenever `finishRun` needs to refund unused managed-credit reserve.
- Missing refund support returns `managed_credit_unavailable` instead of silently settling the run and keeping unused reserved credit.
- The failed finalization remains retryable because the run is not marked settled.
- Final spend is still recorded before refund retry, preserving the existing fail-closed order: durable final record first, refund second, settled marker last.
- Existing managed reservation, failed-run refund, BYOK isolation, debit failure, cap kill, ledger failure, and run identity conflict behavior still passes.
- `AGENTS.md` is absent under `C:\Users\andro\gen-trees`; `CLAUDE.md` and `docs/STARNET_SESSION_LOOPS_1_6.md` were followed.
- `node scripts/board.mjs --files sidecar/billing.js test/billing.test.js docs/session-status/session-4-managed-credits.md` reported no live uncommitted edits for `sidecar/billing.js`.
- `node scripts/board.mjs --files sidecar/index.js sidecar/ledger.js` reported `sidecar/index.js` live-contended by `agent/hermes-settings-audit`, `agent/starnet-replacement-eval`, and `agent/starnet-spend-model-honesty`.

## Tests Run

- `node test\billing.test.js` - OK, 60 assertions.
- `node test\budget.test.js` - OK, 49 assertions.
- `npm.cmd run test:fast` - OK.

## Full Gates

- `npm.cmd run test:fast` - green on 2026-06-26 at 2026-06-26T15:01:22-04:00.
- `npm.cmd run test:http` - not run; this slice added no HTTP route.

## Live Verification

- Not run; this slice is pure backend billing code and does not expose UI or HTTP behavior yet.
- No real managed-credit provider or real-money spend was used.

## Blockers / Holds

- HELD-FOR-COORDINATION: `sidecar/index.js` is still hot/contended by `agent/hermes-settings-audit`, `agent/starnet-replacement-eval`, and `agent/starnet-spend-model-honesty`, so `/api/run` managed-credit admission wiring was not attempted in this loop.
- HELD-FOR-COORDINATION: `sidecar/ledger.js` remains listed in the broader contended-file summary with other lanes, so strict durable managed-ledger persistence was not attempted in this loop.
- `test/billing.test.js` is not wired into `test:fast` because `package.json` is outside the Session 4 owned-file list in the runbook.

## Readiness Claim

- Safe checkpoint slice is ready: managed-credit settlement now fails closed if unused reserved credit cannot be refunded, and the full fast gate is green.
- Session 4 done condition is not yet met; route integration, run-loop/HUD selection, HTTP tests, strict durable managed-ledger persistence, and fake-provider live smoke remain.

## Next Loop Condition

- Retry `node scripts/board.mjs --files sidecar/index.js sidecar/ledger.js`; if `sidecar/index.js` is no longer hot, wire managed-credit authorization plus the budget resume guard into the run admission/resume routes and add fake-provider HTTP coverage. If `sidecar/ledger.js` is no longer contended first, add strict durable append behavior for managed final spend. If both remain held, select another pure backend invariant.
