# Session 4 - Managed Credits Status

## Current Slice

- Tightened pure managed-credit admission and cap-kill behavior while route integration remains held.
- Selected invariant: managed-credit admission retries must not reserve twice, and reconciled final spend above the reserved cap must fail closed.

## Changed Files

- `sidecar/billing.js`
- `test/billing.test.js`
- `docs/session-status/session-4-managed-credits.md`

## Evidence

- `sidecar/billing.js` exports `makeBilling({ payment, ledger, clock })`.
- Managed runs require an account and positive cap, check balance, and reserve credit before paid work can start.
- Reconciled managed final spend is recorded before unused reserved credit is refunded.
- If the managed final ledger write throws, `finishRun` returns `managed_credit_unavailable`, does not refund, and leaves the run unsettled/retryable.
- Reconciled final spend is settled once; unused reserved credit is refunded once after durable recording.
- Duplicate managed `beginRun` calls return the original managed reservation metadata and do not issue a second debit.
- Managed final spend above the reserved cap returns `managed_credit_over_cap`, records no final spend, issues no refund, and leaves the run unsettled for explicit recovery.
- BYOK runs pass through without calling managed payment methods or recording managed-credit debits.
- Managed payment balance/debit failures return closed billing failures before any run is authorized.
- `makeBudget({ resumeGuard })` can veto a resume before override headroom is applied.
- A managed-credit resume veto leaves budget overrides unchanged, so soft budget resume cannot continue an exhausted managed paid path.
- BYOK/non-managed resume remains unchanged when the guard allows it, and existing callers without a guard keep current behavior.
- `AGENTS.md` was absent in this worktree; `C:\Users\andro\Desktop\gen\AGENTS.md` and the runbook were followed.
- `node scripts/board.mjs --files sidecar/index.js` reported `sidecar/index.js` as contended by `agent/hermes-settings-audit`, `agent/starnet-replacement-eval`, and `agent/starnet-spend-model-honesty`, so route integration was held for this loop.
- `node scripts/board.mjs --files sidecar/budget.js test/budget.test.js sidecar/billing.js test/billing.test.js` reported no live uncommitted tracked edits for `sidecar/budget.js`.

## Tests Run

- `node test\budget.test.js` - OK, 49 assertions.
- `node test\billing.test.js` - OK, 46 assertions.
- `npm.cmd run test:fast` - OK.

## Full Gates

- `npm.cmd run test:fast` - green on 2026-06-26 at 2026-06-26T05:55:51-04:00.
- `npm.cmd run test:http` - not run; this slice added no HTTP route.

## Live Verification

- Not run; this slice is pure backend billing code and does not expose UI or HTTP behavior yet.
- No real managed-credit provider or real-money spend was used.

## Blockers / Holds

- HELD-FOR-COORDINATION: `sidecar/index.js` is still hot/contended by `agent/hermes-settings-audit`, `agent/starnet-replacement-eval`, and `agent/starnet-spend-model-honesty`, so `/api/run` managed-credit admission wiring was not attempted in this loop.
- `test/billing.test.js` is not wired into `test:fast` because `package.json` is outside the Session 4 owned-file list in the runbook.

## Readiness Claim

- Safe checkpoint slice is ready: pure managed-credit authorization/settlement, admission retry, cap-kill, and guarded budget-resume invariants are covered, and the full fast gate is green.
- Session 4 done condition is not yet met; route integration, run-loop/HUD selection, `budget.resume` managed-credit behavior, HTTP tests, and fake-provider live smoke remain.

## Next Loop Condition

- Retry `node scripts/board.mjs --files sidecar/index.js`; if it is no longer hot, wire managed-credit authorization plus the budget resume guard into the run admission/resume routes and add fake-provider HTTP coverage. If still hot, select another pure backend invariant.
