# Agent system

## Operating model

Pine Star is intended to operate as a team, not one personality through which every task must pass.

- A configurable coordinator / Chief-of-Staff role may clarify, route, synchronize, and summarize.
- Visible agent name and system role are separate.
- Users can speak directly with specialists.
- Work routes to the lowest capable level and escalates for complexity, authority, risk, or missing capability.
- Temporary specialists receive appropriate cost/model tiers rather than silently inheriting expensive coordinator settings.

## Proposed routing

1. Classify objective, capability, sensitivity, cost, and completion evidence.
2. Assign the smallest capable role/team.
3. Escalate only for missing capability, authority, context, or confidence.
4. Return deliverables and evidence.
5. Record durable lessons/costs in the correct memory layer.

Operations, Development, Creative, Business, and Research are seed categories, not a fixed ontology. The registry must permit new roles, tools, models, and relationships without core rewrites.

`PS-2026-007` implements this routing foundation: objectives declare capabilities and an optional tier ceiling; the router selects the lowest-tier active matching specialist, escalates when none fits, and stops protected actions for approval.

`PS-2026-008` composes that foundation into the authenticated runtime. Station-scoped objective records persist outside agent filesystem jails with declared capabilities, routing result, stable assigned role ID, tier ceiling, approval state, timestamps, and completion-evidence references. Protected objectives are recorded as `approval_required`; this API does not approve or execute them. Completion requires at least one evidence reference.

`PS-2026-009` adds a read-only operator view in the Reports window. It displays role assignments, capabilities, tier and approval state, routing reasons, timestamps, and evidence without creating an execution or approval bypass.

`PS-2026-010` adds the fail-closed dispatch-admission boundary. A runtime roster identity must explicitly list the stable system role in `systemRoleIds`; the free-form visible `role` label is never authority. Admission validates objective state, role availability, a unique complete runtime identity, global autonomous halt state, provider/model readiness, and the existing runtime admission adapter. It mints and audits a run ID but returns `executionStarted:false`; provider execution remains a separate next-stage transition through `runOnce`.

`PS-2026-011` activates only admitted tickets through `runOnce` with `surface:'autonomous'`. The pre-minted run ID is registered in the existing live-run maps, so `/api/cancel`, E-stop, snapshots, run journals, billing, permission enforcement, and durable run history remain authoritative. The objective settles from the real run reason with bounded run/artifact references; an orphaned post-restart `in_progress` record fails truthfully instead of re-executing.

`PS-2026-012` makes Coordinator an orchestration role over that same lifecycle. Deterministic intake handles obvious work without a model call; simple objectives route directly to the lowest capable specialist, and an explicit capable `targetRoleId` preserves direct specialist access. Coordinator objectives may atomically create 2–8 children up to depth 3, with stable parent/dependency relationships and independently routed approval states. Admission refuses children until predecessors complete. Child settlement or pre-run cancellation reconciles the parent to active, waiting for approval, blocked, or completed with bounded child-objective evidence. Decomposition itself never admits, approves, or activates work.

`PS-2026-013` adds a useful Auditor entry point without a parallel review engine. An authenticated, idempotent request may create audit work only after its target objective settles. The new objective is directly bound to `operations.auditor`, declares only `audit` and `verify`, links the target, and carries a bounded snapshot of target status, role, settlement summary, and evidence references. It remains merely assigned until the normal admission and activation path accepts an approved runtime identity. The directive explicitly reviews rather than repeats or expands the target action.

`PS-2026-014` implements the permanent Daily Open-Source Scout as a real specialist workflow. An idempotent request directly creates an economy-tier `operations.open_source_scout` objective with a bounded topic/date/license/platform scope and the existing runtime-web-research adapter contract. It remains assigned until normal admission and activation. Successfully settled findings are normalized, deduplicated, bounded to the requested 3–5 ceiling, and written into the existing shared-report store with source/evidence fields and durable objective audit linkage. Unknown license, cost, compatibility, activity, difficulty, or risk remains `UNKNOWN`. The Scout cannot install, execute downloads, spend, subscribe, create accounts, publish, message externally, expose credentials, or approve an integration. See [INTEGRATIONS.md](INTEGRATIONS.md).

Future evaluation may use performance tiers and champion/challenger tests. Assess usefulness, quality, cost, safety, and wasted work—not activity volume. Preserve lessons when configurations retire.
