# StarNet v0.8.5

This candidate brings together the work completed since v0.8.0. It is being staged for local
desktop testing before publication.

## Agent runs and developer workflow

- Durable run journals, transcript history, output continuation, code composition, LSP
  diagnostics, and agent evaluation tooling make longer technical runs easier to recover,
  inspect, and continue.
- Telegram can act as a full remote control surface for the station, including richer threaded
  conversations and agent orchestration.
- `station.inspect` exposes bounded, truthful station state for agent-driven diagnosis.

## Browser and connected services

- Browser automation now reports reachability and page status more honestly, handles challenge
  pages more safely, and uses more deterministic input and host-polite request behavior.
- Connector credentials, OAuth flows, and restart recovery have been hardened across the
  supported integration paths.

## Reliability and control

- Routine execution, persistence, task briefs, mobile controls, keyboard paths, and E-STOP
  handling received reliability and truthfulness fixes.
- Recommendation and personalization signals now have a stronger evidence trail, including a
  replay scorecard for evaluating their behavior.

## Station and interface

- Panel chrome and station props were refined while preserving the existing dark visual theme.
- All 36 agent skins now include eight-direction movement plus gesture and stretch animation
  coverage, with their matching website assets.

## Release engineering

- Release checks, installed-build verification, Guardian coverage, and macOS workflow handling
  were strengthened for safer candidate testing and future publication.
