# StarNet v0.10.2

This update turns the latest autonomy, recovery, deliverables, and station-interface work into one release candidate.

## Highlights

- Fully Autonomous now aims at finished, reviewable work. When a Workshop run produces a plan, StarNet can build the plan into a separate deliverable while preserving the source, the Commander's steer, and the learning provenance.
- Implement is now a real build path rather than a file-copy shortcut. Its manifest link, backlog registration, and source retirement are durable, read-back verified, retryable, and fail closed under injected storage faults.
- Interrupted agent work now has bounded, persisted recovery decisions, safe alternate-path retries, structured completion evidence, and typed postcondition verification.
- Deliverables has been rebuilt around named work, project and crew provenance, better search and filtering, a details drawer, working OPEN actions, honest fileless-item handling, and clearer OUTBOX integration.
- Routine and line setup is easier to operate: schedule pickers replace hand-authored cron in the common path, INBOX can distinguish line triggers, remote bays resolve capabilities from the agent's desk room, and Full Power applies host-wide.
- Task clarification supports batched questions, multi-select answers, and one-tap escape while avoiding invented style, tone, or aesthetic assumptions.
- Voice setup is faster: standard microphone mode is a two-click path and live turns use the lower-latency endpoint by default.
- Station presentation received a broad polish pass across window sizing, settings and key panels, ability seals, quest and goal views, task status, corner geometry, nursery framing, agent conversations, and compact session rows.

## Reliability and safety

- Recovery behavior is covered across restart, cancellation, consent refusal, capability denial, trusted-read failure, mutation replay, and duplicate-work boundaries.
- The overnight reliability campaign is resumable and records cycle evidence rather than silently losing an interrupted run.
- Implement durability is fault-injected at the manifest, registration, and source-retirement commit seams; retries recover without exposing an unregistered build or spending a duplicate run after a proven build.

## Release boundaries

- The exact installer must pass installed-app smoke and the requested eight-hour stress campaign before launch preparation.
- The repository's formal release-candidate policy still requires a 48-hour installed real-provider soak. An eight-hour campaign is valuable release evidence but does not satisfy that longer qualification by itself.
- This candidate remains private until its exact artifact identity, signatures, update metadata, installed behavior, and QA authority are reviewed. Nothing is published by the version bump or local installer build.
