# Pine Star changelog

Git is the exact technical history; these entries summarize intent and outcomes. Do not invent commit references before a commit exists.

## Unreleased

### PS-2026-013 — Auditor objective foundation

- Added idempotent audit requests for settled durable objectives, directly assigned to the Auditor system role.
- Supplied the Auditor runtime with a bounded target status/settlement/evidence snapshot while excluding raw transcripts and preventing unfinished-target claims.
- Added an authenticated audit API and read-only audit-target inspection without changing admission, execution, approval, or permission authority.

### PS-2026-012 — Atomic coordinator intake and decomposition

- Added deterministic objective intake and explicit capable specialist targeting without model calls or coordinator intermediation for simple work.
- Added crash-atomic bounded parent/child decomposition with durable dependencies, routing, approval states, idempotency, and aggregation evidence.
- Enforced predecessor completion at admission, reconciled child settlement/cancellation into parent state, and exposed authenticated APIs plus read-only relationship inspection.

### PS-2026-011 — Safe objective activation

- Activated admitted objectives through the existing `runOnce` lifecycle with shared cancellation and E-stop controllers.
- Synchronized durable running/completed/failed/cancelled states from real execution outcomes with bounded run/artifact evidence.
- Added authenticated activation/cancellation APIs, duplicate/restart guards, and settlement visibility.

### PS-2026-010 — Objective dispatch admission boundary

- Added a pure fail-closed bridge from durable objective and routed system role to an explicitly bound runtime roster identity.
- Added authenticated objective admission tickets with durable audit evidence and an explicit `executionStarted:false` boundary.
- Preserved protected-objective blocks, autonomous halt checks, provider/model readiness, cancellation state, and existing runtime execution authority.

### PS-2026-009 — Objective and role inspection surface

- Extended the Reports window with escaped, read-only objective and system-role records.
- Made routing, tier, approval state, capabilities, timestamps, and completion evidence visible without adding execution or approval controls.
- Added objective-store health, count, and approval-required backlog to runtime control status.

### PS-2026-008 — Durable objective records and runtime APIs

- Added a crash-safe station objective ledger outside agent filesystem jails.
- Added authenticated role discovery and objective create/list/status APIs that preserve routing and approval decisions.
- Required evidence references for completion and prevented protected objectives from advancing through the status API.

### PS-2026-007 — Extensible role registry and objective router

- Added shared system-role seed data with identity, department, capabilities, tier, permissions, escalation, and availability separated.
- Added deterministic lowest-capable-level routing, tier ceilings, protected-action approval stops, and extensible registration.
- Added focused registry/routing coverage without replacing existing StarNet agent-instance architecture.

### PS-2026-006 — Local shared-report export adapter

- Added user-initiated JSON and Markdown export for bounded shared reports.
- Export receipts select no external destination, perform no external write, and exclude private memory.
- Escaped embedded HTML in Markdown output and added focused adapter tests.

### PS-2026-005 — Reports surface and control status

- Added a read-only, escaped Reports window for concise shared operational history.
- Added a versioned authenticated control-status API reporting memory-store health, report counts, external-sync-off, and zero spending authority.
- Added focused UI, auth, HTTP persistence, and generated-mirror coverage.

### PS-2026-004 — Operational memory and shared reporting boundary

- Added separate crash-safe stores for private operational records and bounded shareable reports.
- Added an authenticated shared-report API and persisted concise Night Shift morning reports without raw drafts, transcripts, notebooks, or internal payloads.
- Added focused durability, privacy-boundary, report projection, authentication, and mirror-sync coverage.

### PS-2026-003 — Release asset safety foundation

- Added a read-only distribution gate for private reference/placeholder material in frontend, website, native icon, and installer asset roots.
- Added focused positive and negative tests without changing or deleting compatibility-era assets.
- This is not a release approval; original art, licensing, native identity, signing, and updater ownership remain deferred.

### PS-2026-002 — Pine Star Foundation & Initial Rebranding

- Began separating Pine Star's visible identity from StarNet while preserving compatibility-sensitive internals and working architecture.
- First batch: project-status rollover, text-only Pine Star primary frontend identity, removal of primary UI dependence on excluded StarNet logo/wordmark assets, branding regression-test adaptation, and generated website mirror synchronization.
- Deferred native identity, executable/package/installer naming, identifiers, icons/art, data paths, persistence namespaces, provider/managed-credit internals, updater/signing, architecture changes, and the future GBA environment.
- Git commit: `43ba5fc555549a7114aab2c5ffcdfa728eee6b69` (committed and pushed).
- Completed the presentation-copy classification cleanup across the frontend and generated website mirror; native package identity, public website conversion, and original art remain deferred.

### PS-2026-001 — Documentation and governance foundation

- Established Pine Star identity, control, policy, architecture direction, safety boundaries, agent/memory/business direction, integration/art rules, roadmap, baseline, and current status.
- Preserved StarNet as the acknowledged upstream technical foundation and retained useful historical documentation.
- Added repository instructions and a per-change record.
- Application/runtime source changed: **No**.
- Git commit: `1c2ef0d42d9a4797bf22020592e54837be5735fb` (committed and pushed).
