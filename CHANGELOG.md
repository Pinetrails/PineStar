# Pine Star changelog

Git is the exact technical history; these entries summarize intent and outcomes. Do not invent commit references before a commit exists.

## Unreleased

### PS-2026-045 — Verified local product artifact admission

- Added an authenticated, configured-root-only path that verifies a declared SHA-256 before copying a local owner-supplied product artifact into canonical Pine Star storage.
- Records hash-bearing provenance as a `verified` deliverable eligible for the existing complete-coverage QA gate, with stable-ID and destination conflict detection.
- Rejects unconfigured/out-of-root sources and hash mismatches, preserves source files, performs no external action, and grants $0 spending authority.

### PS-2026-044 — The Big Bite 200-image reconciliation

- Reconciled the advertised product scope to exactly 200 images while retaining files 201-213 as unadvertised read-only extras.
- Created 21 metadata-only 300-DPI corrected copies with byte-identical IDAT data and matching decoded pixels, plus an internal archive containing exactly images 001-200.
- Added hash manifests, exhaustive technical QA evidence, and 200-image-only listing copy; formal QA and publication remain unapproved.

### PS-2026-043 — Existing Pine Trail product evidence intake

- Added authenticated, idempotent intake for already-built Pine Trail digital products without forcing the printable Letter/A4 preset onto clipart collections.
- Records bounded deliverables, verified source facts, evidence references, and unknowns, then routes reconciliation through Coordinator/Product Designer and dependent independent QA through Quality Reviewer.
- Imports at `production` with `qaState: not_started`, zero spending authority, and no modification, publication, upload, account, purchase, or external-action capability.

### PS-2026-042 — Read-only publication review package

- Added a Reports section that joins each pending protected request with its product listing copy, marketplace targets, and linked QA coverage.
- Escapes all rendered values and states when linked QA coverage falls outside the current shared-report window.
- Exposes no approval, withdrawal, publication, navigation, execution, credential, or spending control.

### PS-2026-041 — Pending review archival guard

- Prevented generic project archival from orphaning a still-pending protected publication review.
- Requires the authenticated audited withdrawal lifecycle before a waiting product can return to an archivable internal state.
- Added no approval, publication, spending, credential, account, or external-action authority.

### PS-2026-040 — Single pending publication review

- Limited each product to one pending protected publication review, refusing a different request ID while one still waits.
- Made withdrawal retain the product approval boundary when legacy concurrent pending work exists and report that remaining objective explicitly.
- Preserved authentication, stopped protected work, audit history, and zero publication/spending authority.

### PS-2026-039 — Terminal publication request identity

- Prevented a withdrawn stable request ID from reactivating its cancelled approval objective or moving a product back to a false waiting state.
- Required revised publication review requests to use a new stable ID, producing new protected stopped work with preserved history.
- Reset the withdrawn project's publication projection to `not_published`; no approval, publication, spending, or external authority was added.

### PS-2026-038 — Protected publication request withdrawal

- Added authenticated, idempotent withdrawal of a still-waiting protected publication approval request.
- Withdrawal cancels the protected objective, records `approvalState: withdrawn` plus audit history, and restores the product to listing readiness.
- Generic product updates cannot bypass the withdrawal workflow; no approval, publication, spending, or external authority was added.

### PS-2026-037 — Evidence-gated publication approval request

- Added an authenticated, idempotent request package linking listing-ready product, complete QA coverage, target marketplaces, shared report, and protected objective.
- Restricted generic project updates from entering `approval_required`; only the internal evidence-gated request seam may make that transition.
- The request remains unassigned and stopped for Commander approval and performs no publication, account creation, spending, or external action.

### PS-2026-036 — Read-only QA coverage inspection

- Added escaped expected-deliverable-to-artifact coverage to product QA reports in Reports.
- Reused the bounded shared-report field and exposed no artifact, approval, publication, navigation, or execution control.

### PS-2026-035 — Complete deliverable coverage gate

- Required passed product QA to map every expected deliverable to verified Workshop artifact evidence.
- Retained the bounded deliverable-to-artifact map in the durable shared QA report for audit.
- Rejected missing, incomplete, extra, or unverified coverage without changing publication or approval authority.

### PS-2026-034 — Unallocated ledger evidence alert

- Added a Business Morning Brief exception and review action when recorded ledger evidence lacks a product-project link.
- Explicitly prohibits inferred attribution and leaves immutable ledger records unchanged.
- Kept exception and next-action lists bounded while retaining existing product actions.

### PS-2026-033 — Read-only product contribution UI

- Added recorded net contribution and evidence-entry counts for known products to the existing Reports portfolio card.
- Excluded unmatched product identifiers and made the missing-cost/no-estimation boundary visible.
- Reused authenticated read data and added no action controls, financial authority, or external connection.

### PS-2026-032 — Evidence-based product contribution

- Added deterministic per-product revenue, expense, refund, and net attribution to existing period summaries from immutable linked ledger entries.
- Added linked-product contribution and negative recorded contribution signals to the product portfolio and Business Morning Brief.
- Preserved unknown-as-absent behavior: no estimates, ROI claims, financial actions, external writes, or new store were added.

### PS-2026-031 — Local business snapshot export

- Added a user-initiated JSON download of bounded product, commerce, and evidence-backed ledger projections from Reports.
- Added a versioned export contract with no destination or external write and an explicit field allowlist that drops unknown credential/private fields.
- Reused existing authenticated reads and added no automatic trigger, sync, publication, payment, account, or spending authority.

### PS-2026-030 — Pine Trail production and QA preset

- Added family-aware editable-source, US Letter PDF, A4 PDF, and bundle-manifest expectations for researched Pine Trail Printables.
- Added original-asset, print-size legibility, clipping, print-margin, and no-StarNet/commercial-game-art QA checks with bounded product-specific additions.
- Delegated to the existing Product Designer/Workshop/Quality Reviewer production planner and retained no-publish, no-account, no-purchase, zero-spend boundaries.

### PS-2026-029 — Read-only commerce and ledger UI

- Added escaped read-only commerce observation cards with project, marketplace, listing-reference, and evidence fields plus explicit no-action copy.
- Added recorded all-time revenue, expense, refund, net, and entry totals plus evidenced entry cards to Reports.
- Reused existing authenticated GET APIs and exposed no external link, payment/refund, purchase, publication, or edit controls.

### PS-2026-028 — Read-only product portfolio UI

- Added a read-only current portfolio card to Reports with deterministic stage, failed-QA, blocker, and evidenced observed-publication counts.
- Expanded product cards with listing state, marketplace targets, blockers, and evidence references while preserving HTML escaping.
- Reused existing authenticated product and commerce GET APIs and exposed no publication, approval, payment, execution, or edit controls.

### PS-2026-027 — Product portfolio Morning Brief

- Added a pure current-state portfolio projection over existing product projects and commerce references, with deterministic stage/QA/listing/approval/observed-publication counts.
- Added bounded failed-QA/blocker attention, protected-approval and listing-review next actions, and source provenance.
- Integrated the projection into the existing deterministic Business Morning Brief with no new store, task engine, model call, or external action.

### PS-2026-026 — Pine Trail Printables workflow preset

- Added a stable Pine Trail Printables intake preset for planner, checklist, tracker, activity-sheet, and bundle families.
- Standardized original Pine Trail-owned assets, print-safe layout, editable-source/PDF deliverables, and US Letter/A4 requirements while allowing bounded product-specific additions.
- Delegated entirely to the existing Product Idea project, Coordinator, Researcher, Idea Lab, report, auth, cancellation, E-stop, and audit systems; added no external commerce authority.

### PS-2026-025 — Bounded growth experiments

- Added a zero-publish, zero-outreach, zero-account, zero-spend Growth Analyst system role at economy tier.
- Added authenticated idempotent growth-experiment planning for listing-ready products and evidence-gated results that require completed linked specialist objectives.
- Added strict stable-ID conflict detection and projected evidenced outcomes into Business Morning Brief without executing, advertising, scaling, or mutating external systems.

### PS-2026-024 — Truthful commerce and business records

- Added authenticated durable commerce references that can record planned, draft, approval-waiting, evidenced observed-publication, and archived state without performing marketplace actions.
- Added immutable evidence-required USD revenue, expense, and refund entries with source/time/project provenance, idempotent stable identities, and truthful period summaries.
- Integrated recorded business totals and entry references into Morning Brief while retaining zero spending authority and no payment, account, credential, or publication capability.

### PS-2026-023 — Evidence-gated QA and listing preparation

- Required a completed linked Quality Reviewer objective plus verified existing Workshop artifact and shared-report evidence before recording QA.
- Added idempotent pass/fail QA reports, truthful failed-QA blockers, and bounded internal listing title/description/tag/SEO metadata.
- Reused existing project QA/listing gates; passed work reaches `listing_ready` but remains `not_published`, and safe APIs still cannot publish.

### PS-2026-022 — Product production and QA planning

- Added authenticated idempotent production planning with bounded specifications, expected deliverables, constraints, and QA checklists.
- Routed specification/preparation to Product Designer and dependent independent verification to Quality Reviewer through normal objectives.
- Reused existing Workshop/file provenance for real artifacts and preserved no-claim, no-publish, no-spend, and approval boundaries.

### PS-2026-021 — Evidence-gated product research decisions

- Added authenticated, idempotent research finalization that requires completed linked Researcher and Idea Lab objectives plus explicit evidence.
- Added bounded shared decision reports and project linkage; supported `go` decisions advance only to planning, while revise/stop decisions hold production with truthful blockers.
- Projected product decisions and next actions into the deterministic Morning Brief without adding another feed or model call.

### PS-2026-020 — Awesome LLM Apps evaluation and selective integration

- Inspected the external Awesome LLM Apps repository as an Apache-2.0 reference library without executing or importing its apps, skills, dependencies, or model proxy.
- Recorded priority and secondary candidates with overlap, dependency, service, cost, security, license, difficulty, recommendation, and role ownership evidence.
- Added a dependency-free, offline, read-only Change-ID scope signal for final diff review; its heuristic output is advisory and grants no staging, commit, install, approval, or execution authority.

### PS-2026-019 — Product Idea / Idea Lab intake

- Added authenticated, deterministic, idempotent product-idea intake over existing product projects, objectives, routing, and shared reports.
- Assigned orchestration to Coordinator, market validation to Researcher, and the dependent concept brief to the economy-tier Idea Lab specialist.
- Preserved zero-spend, no-publish, no-purchase, no-account, and approval boundaries; intake creates records and queued work but does not execute it.

### PS-2026-018 — Digital-product project records

- Added durable digital-product business records with bounded metadata, truthful unknown financials, zero spending authority, and deterministic lifecycle/QA gates.
- Linked projects to existing objectives and shared reports with validated IDs and live progress projection rather than duplicating work or transcripts.
- Added authenticated create/list/inspect/update/link APIs and read-only Reports-window visibility; safe APIs cannot publish externally.

### PS-2026-017 — Away/Night Shift objective bridge

- Added an authenticated durable queue for explicitly selected safe Away objectives with inspection and pre-activation cancellation.
- Reused the existing Night Shift presence, posture, leash, concurrency, halt, timer, and abort behavior before normal objective admission and activation.
- Added atomic claims, one-hour stale-claim recovery, and a three-attempt bound without introducing another unattended scheduler or widening permissions.

### PS-2026-016 — Deterministic Morning Brief

- Added deterministic bounded aggregation of completed, active, failed, cancelled, blocked, and approval-waiting objectives.
- Included actionable Scout discoveries and Auditor exceptions while retaining concise durable evidence references.
- Reported costs only from real in-period run records and added an authenticated idempotent generation API using the existing shared-report store.

### PS-2026-015 — Recurring objective scheduler bridge

- Stored recurring Pine Star definitions as existing durable cron jobs with bounded role-owned objective templates and zero unattended grants.
- Delegated cron fires into idempotent durable objective occurrences and the normal routing, admission, activation, cancellation, E-stop, and settlement lifecycle without a second `runOnce` call.
- Added authenticated recurring create/list/enable/disable APIs with next-run, last-outcome, and bounded failure telemetry; structured Daily Scout schedules reuse the existing Scout report contract.

### PS-2026-014 — Daily Open-Source Scout foundation

- Added idempotent bounded Scout objectives directly assigned to the economy-tier Open-Source Scout role through the existing runtime lifecycle.
- Added an extensible source-adapter contract and structured finding normalization with evidence, deduplication, recommendation classes, and truthful `UNKNOWN` license/cost fields.
- Finalized successful Scout work into the existing shared-report store with durable objective audit linkage and explicit zero-spend, no-install, no-publish boundaries.

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
