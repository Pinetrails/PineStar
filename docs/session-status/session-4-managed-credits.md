# Session 4 - Managed Credits Status

## Current Slice

- Implemented the pure managed-credit billing adapter beside BYOK.
- Selected invariant: managed account balance, debit-on-run reservation, failed-run refund, BYOK isolation, and fail-closed payment persistence.

## Changed Files

- `sidecar/billing.js`
- `test/billing.test.js`
- `docs/session-status/session-4-managed-credits.md`

## Evidence

- `sidecar/billing.js` exports `makeBilling({ payment, ledger, clock })`.
- Managed runs require an account and positive cap, check balance, and reserve credit before paid work can start.
- Reconciled final spend is settled once; unused reserved credit is refunded once.
- BYOK runs pass through without calling managed payment methods or recording managed-credit debits.
- Managed payment balance/debit failures return closed billing failures before any run is authorized.
- `AGENTS.md` was absent under `C:\Users\andro\gen-trees`; repo-local `CLAUDE.md` and the runbook were followed.

## Tests Run

- `node test\billing.test.js` - OK, 27 assertions.
- `npm.cmd run test:fast` - OK.

## Full Gates

- `npm.cmd run test:fast` - green on 2026-06-26.
- `npm.cmd run test:http` - not run; this slice added no HTTP route.

## Live Verification

- Not run; this slice is pure backend billing code and does not expose UI or HTTP behavior yet.
- No real managed-credit provider or real-money spend was used.

## Blockers / Holds

- No active blocker for the pure billing adapter slice.
- `test/billing.test.js` is not wired into `test:fast` because `package.json` is outside the Session 4 owned-file list in the runbook.

## Readiness Claim

- Safe checkpoint slice is ready: pure managed-credit authorization/settlement invariants are covered and the full fast gate is green.
- Session 4 done condition is not yet met; route integration, run-loop/HUD selection, `budget.resume` managed-credit behavior, HTTP tests, and fake-provider live smoke remain.

## Next Loop Condition

- Select the next backend invariant: wire managed-credit authorization into the run admission path or add route-level fake-provider HTTP coverage after checking ownership for `sidecar/index.js` with `scripts/board.mjs`.
