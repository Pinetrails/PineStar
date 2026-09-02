# Pine Star roadmap

Phases express dependencies and intent, not rigid architecture. Discoveries may alter implementation order; major changes require a decision record.

## Phase 0 — Preparation

- Archive/preserve prior Pine Star work.
- Establish control folder and dedicated Obsidian vault.
- Prepare the development machine.

## Phase 1 — Stock StarNet baseline — COMPLETE

- Fork/clone; upstream remote; `pine-star` branch.
- Install/test stock system and identify baseline defects.
- Verify packaged desktop and create permanent baseline tag.

## Phase 2 — Foundation — IN PROGRESS

- Pine Star identity, permanent instructions, documentation, change ledger, upstream policy, configuration philosophy, and baseline record.
- Later begin controlled foundation/rebranding modifications under separate Change IDs.
- Completed initial presentation separation (`PS-2026-002`) and a machine-checkable reference/placeholder asset gate (`PS-2026-003`); native identity and original replacement art remain deferred.

## Phase 3 — Memory & Control — STARTED

- Internal/shared memory boundaries, Obsidian integration, control/status synchronization, reporting architecture.
- Internal/shared durable-store boundary and the first concise morning-report record completed in `PS-2026-004`; control synchronization, report UI, and deliberate Obsidian adaptation remain.
- Readable report UI and a machine-readable runtime control-status contract completed in `PS-2026-005`; deliberate Obsidian adaptation remains.
- User-initiated local shared-report export completed in `PS-2026-006`; no external vault writes occur.

## Phase 4 — Agents & Objectives — STARTED

- Coordinator model, registry, departments, objective routing, Scout, Auditor, specialist workflows.
- Pure extensible role registry and lowest-capable-level routing foundation completed in `PS-2026-007`.
- Durable station-scoped objective records plus authenticated role discovery and objective lifecycle APIs completed in `PS-2026-008`; UI, execution dispatch, and approval-grant design remain.
- Read-only objective and role inspection plus objective control-status telemetry completed in `PS-2026-009`; execution dispatch and approval-grant design remain.
- Fail-closed objective dispatch admission and explicit stable-role-to-roster binding completed in `PS-2026-010`; admitted-ticket execution and outcome settlement remain.
- Safe admitted-ticket activation through the shared StarNet run lifecycle completed in `PS-2026-011`.
- Deterministic coordinator intake, explicit direct-specialist targeting, atomic bounded decomposition, dependency admission, parent aggregation, and relationship inspection completed in `PS-2026-012`; useful Auditor and Scout workflows remain.
- Idempotent settled-objective audit requests with bounded evidence snapshots and direct Auditor assignment completed in `PS-2026-013`; Scout and recurring objective workflows remain.
- Daily Open-Source Scout request, runtime directive, structured normalization, shared-report finalization, and audit linkage completed in `PS-2026-014`; recurring objective scheduling remains.
- Recurring objective definitions and idempotent occurrences now delegate from the existing durable cron scheduler into normal Pine Star admission/activation/settlement in `PS-2026-015`.
- Deterministic Morning Brief aggregation now publishes concise shared reports from durable objective, Scout, Auditor, approval, and measured run-cost evidence in `PS-2026-016`; Away/Night Shift objective integration remains.
- Explicit safe objective queues now enter the existing Night Shift beat only after its presence, posture, leash, concurrency, and durable halt gates clear, then reuse normal objective admission/activation/settlement (`PS-2026-017`).

## Phase 5 — Autonomous Operations

- Away/Night Shift, reports, safe recurring work, zero-spend default, approval refinements.
- Existing cron now schedules durable Pine Star objective occurrences with scheduler-owned pause, halt, retry, recovery, and inspection (`PS-2026-015`).
- Authenticated Morning Brief generation now reuses the shared-report store and requires no model call (`PS-2026-016`).
- Away objective work now reuses the existing Night Shift timer and safety gates with durable bounded claims/recovery instead of a new unattended loop (`PS-2026-017`).

## Phase 6 — Business System

- Digital products, commerce, Pine Trail Printables/social, pipeline, growth experiments, revenue/cost tracking.
- Durable digital-product project records now coordinate existing objectives and reports through idea, research, planning, production, QA, listing readiness, and protected publication stages (`PS-2026-018`).
- Authenticated Product Idea intake now creates an idempotent project, Coordinator-owned dependency graph, specialist market-validation and Idea Lab objectives, and a linked shared intake report (`PS-2026-019`).
- Completed linked Researcher and Idea Lab objectives can now produce an evidence-required research decision report; only a supported `go` advances the project to planning, and decisions flow into Morning Brief (`PS-2026-021`).
- Planned projects now create bounded specification, product-preparation, and dependent independent-QA objectives while real artifacts remain owned by existing Workshop/file provenance (`PS-2026-022`).
- Completed linked Quality Reviewer work now finalizes only against verified Workshop artifact and shared-report evidence, records pass/fail reports, and prepares bounded internal listing/SEO copy without publication (`PS-2026-023`).
- Durable commerce references and immutable evidence-backed revenue, expense, and refund entries now provide authenticated project-linked business truth and Morning Brief totals without external commerce or payment authority (`PS-2026-024`).
- Listing-ready products can now route bounded hypotheses to a zero-authority Growth Analyst and record immutable evidence-backed outcomes in shared reports and Business Morning Brief (`PS-2026-025`).
- Pine Trail Printables now has a bounded family/asset/layout intake preset that delegates to the existing Product Idea workflow rather than creating a parallel production system (`PS-2026-026`).
- Business Morning Brief now includes a deterministic current portfolio snapshot with stage, QA, listing, approval, blocker, commerce-observation, action, and provenance signals (`PS-2026-027`).
- The existing Reports UI now exposes a read-only product portfolio snapshot plus listing, marketplace, blocker, evidence, and next-action readiness detail without mutation controls (`PS-2026-028`).
- Reports now includes escaped read-only commerce observations and evidence-backed business-ledger totals/entries using existing authenticated GET APIs without external navigation or mutation controls (`PS-2026-029`).
- Researched Pine Trail Printables now have a family-aware production/QA preset that delegates to the existing Product Designer, Workshop provenance, and independent Quality Reviewer workflow (`PS-2026-030`).
- Reports can now produce an explicit user-initiated local JSON snapshot from allowlisted product, commerce, and ledger fields, with no external destination or automatic action (`PS-2026-031`).
- Existing period summaries now attribute immutable ledger evidence to known products so portfolio and Business Morning Brief can report recorded contribution without estimates or ROI claims (`PS-2026-032`).
- The Reports portfolio card now shows recorded contribution and evidence-entry counts for known products while explicitly preserving missing costs as unknown (`PS-2026-033`).
- Business Morning Brief now exposes unallocated ledger evidence as a review exception instead of silently omitting or guessing product attribution (`PS-2026-034`).
- Passed product QA now requires complete expected-deliverable coverage by verified Workshop artifacts and retains the bounded mapping in its shared report (`PS-2026-035`).

## Phase 7 — Evolution

- Performance measurement, experiments, champion/challenger, safe self-improvement, agent/configuration evolution.
- External development patterns are research inputs only. `PS-2026-020` added an advisory native Change-ID scope signal while rejecting unverified context proxies and autonomous third-party self-rewriting authority.

## Phase 8 — Pine Star World

- Original GBA-style environment, departments/buildings, visible agent activity, original sprites/tiles, day/night, activity visualization, polished identity.
