# Session 5 - Subagent Iteration Budget

## Current Slice

H6.3 subagent budget containment: worker `maxIters` propagation and no-op turn refund.

## Changed Files

- `sidecar/loop.js`
- `sidecar/tools/builtin/orchestration.js`
- `test/loop.replay.test.js`
- `test/orchestration.test.js`
- `docs/HERMES_PARITY_PLAN.md`
- `docs/session-status/session-5-iteration-budget.md`

## Evidence

- `runAgentLoop` default iteration ceiling now matches the lead default of 40 when no caller supplies `limits.maxIters`.
- Empty/no-assistant/no-tool turns refund to that turn's starting count.
- Refunds do not erase earlier productive tool turns.
- `team.dispatch`, background dispatch, `team.resume`, and `team.spawn` pass an explicit worker iteration cap of 10 by default.
- `workerMaxIters` dependency override is covered for tuned worker caps.

## Tests Run

- `node test/loop.replay.test.js` - pass at 2026-06-26 07:52 UTC
- `node test/orchestration.test.js` - pass at 2026-06-26 07:52 UTC

## Full Gate

- `npm.cmd run test:fast` - pass at 2026-06-26 07:53 UTC

## Live Verification

- Not applicable for this backend loop/accounting slice.

## Blockers / Holds

- `sidecar/index.js` is required to consume `o.maxIters` in production `runOnce`, but board check at 2026-06-26 07:52 UTC showed it is contended by `agent/hermes-settings-audit`, `agent/starnet-replacement-eval`, and `agent/starnet-spend-model-honesty`. Held instead of editing the contended run host.
- `sidecar/index.js` is also outside the Session 5 owned-file list in `docs/STARNET_SESSION_LOOPS_1_6.md`; final production plumbing needs owner/orchestrator coordination before this session can touch it.

## Readiness Claim

HELD-FOR-COORDINATION. The owned loop and orchestration surfaces are implemented and targeted/full tests pass, but the session is not READY until `sidecar/index.js` can be safely updated to thread `o.maxIters` into `runAgentLoop` limits.

## Next Loop Condition

Wake after the `sidecar/index.js` contention clears, then add the narrow production run host plumbing, run targeted tests plus `npm.cmd run test:fast`, and commit or mark READY.
