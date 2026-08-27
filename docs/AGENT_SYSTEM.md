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

The permanent planned Daily Open-Source Scout recommends 3-5 discoveries with license, cost, compatibility, activity, difficulty, action, and owner. It never auto-installs. See [INTEGRATIONS.md](INTEGRATIONS.md).

Future evaluation may use performance tiers and champion/challenger tests. Assess usefulness, quality, cost, safety, and wasted work—not activity volume. Preserve lessons when configurations retire.
