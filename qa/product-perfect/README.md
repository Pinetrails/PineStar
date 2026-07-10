# StarNet product-perfection convergence

This directory defines the literal product bar requested by the owner: every created feature,
release-facing UI implementation, and backend promise must be fully polished and work in the running
product. It is deliberately stricter than `qa:ready`, which is a release-readiness aggregate rather
than an exhaustive product-perfection proof.

`waves.json` is the tracked goal contract. Runtime status is always derived; nobody edits a `done`
flag. `scripts/qa/product-perfect.mjs` runs the verifier for the first non-passing wave and writes
candidate-bound receipts beneath `.dogfood/product-perfect/` (gitignored). A receipt is reusable only
when all of these still match:

- the exact Git commit;
- the exact wave definition hash;
- the wave ID and dependency order;
- a real verifier exit code of zero.

Changing source or a wave condition re-queues the affected proof. Missing/unreadable evidence is
`BLOCKED`, never green. The controller serializes the campaign: later waves do not run while an
earlier wave is failing or stale.

## Commands

```powershell
node scripts/qa/product-perfect.mjs --status
node scripts/qa/product-perfect.mjs --run
node scripts/qa/product-perfect.mjs --wave W0
```

`--status` is read-only. `--run` reuses current valid pass receipts, runs forward in order, and stops
at the first non-pass. `--wave` is mainly for focused development and refuses to run when a dependency
is not current and green.

Exit codes are `0` only for a passing requested wave or the terminal `PRODUCT PERFECT` aggregate,
`1` for a verifier-proved failure, and `2` for missing/unverifiable/blocked proof.

The final verdict remains product validation only. Publishing or other external release operations
require separate owner authorization.
