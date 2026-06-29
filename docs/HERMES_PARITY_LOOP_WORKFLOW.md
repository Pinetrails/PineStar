# Hermes Parity Loop Workflow

## Goal Condition

The loop is complete when each of the five Hermes-parity areas has:

1. A Hermes reference invariant identified from `C:\Users\andro\hermes-ref`.
2. A StarNet gap assessment against the current JS/Tauri harness.
3. A concrete code or test change for the highest-risk gap.
4. Passing targeted verification and `npm run test:fast`.
5. A scoped commit on the active agent worktree.

## Automated Loop

Repeat until all five areas are green:

1. Pick the highest-risk unchecked area.
2. Read Hermes source and tests for the invariant, not just docs.
3. Read the StarNet implementation and current tests.
4. Classify the gap as `implementation`, `coverage`, or `already-covered`.
5. Add the smallest regression test that would catch the Hermes-class failure.
6. Patch StarNet using existing modules and contracts.
7. Run the narrow test, then the relevant suite.
8. Update this file with the result.
9. Commit only the touched files.

## Areas

| Area | Hermes invariant | StarNet gap | Loop status |
| --- | --- | --- | --- |
| 1. Routines / cron | Manual run must claim/fire immediately through the same observable run body as scheduled fires. Scheduled/manual fires must be visible outside the local panel. | Closed: `/api/cron/run` now shares the scheduled-fire work-item helper, broadcasts run lifecycle SSE, and has source-lock plus real sidecar e2e coverage. | Green: `node test/cron.run-now.test.js`, `node test/cron.tick.test.js`, and `npm.cmd run test:http` passed. |
| 2. Messaging channels | Inbound platform messages must drive the same run host, keep session/delivery boundaries durable, and survive transport edge cases with fake-transport tests. | Telegram/Discord substrate exists; missing true sidecar e2e proof that an inbound fake transport causes provider call, SSE lifecycle, and outbound delivery. | Pending |
| 3. Subagents / delegation | Background workers need durable lifecycle records, interrupt/resume, bounded nesting, and no approval deadlocks. | Unit coverage exists; missing sidecar e2e proof through the real run host and SSE/floor lifecycle for a delegated background worker. | Pending |
| 4. MCP / connectors | Connectors must keep tool discovery and tool calls behind a stable manager with safe transport behavior, refresh, and portal visibility. | Protocol/manager/UI exist; missing end-to-end proof from `/api/connectors` through a real model tool call and connector portal activity. | Pending |
| 5. State safety | Critical state has atomic writes, snapshots/checkpoints before mutation, restore paths, and safety nets against silent loss. | Checkpoints and state safety tests exist; missing a Hermes-style protected-state snapshot/restore check for routine job loss during update/migration. | Pending |
