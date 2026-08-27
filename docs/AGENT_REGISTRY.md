# Agent registry direction

## Status

`PS-2026-007` implements the first pure, data-driven registry and lowest-capable-level router. `PS-2026-008` now exposes authenticated read-only runtime role discovery and a durable station-scoped objective ledger. Runtime role mutation, agent-instance binding, execution dispatch, and approval-grant workflows remain deferred.

A future data-driven registry should support stable role ID, display name, department, purpose, capabilities, tool grants, escalation targets, model tier, cost limits, protected-action boundaries, availability, evaluation profile, and memory/report destinations. Names may change without changing role identity.

The implemented foundation currently separates stable role ID, display label, department, capabilities, Economy/Balanced/Deep tier, escalation targets, permissions, and availability. Remaining fields will be added as runtime objective ownership and evaluation mature.

Runtime contracts:

- `GET /api/roles` returns `pine-star.roles.v1` discovery records without visible agent identities.
- `GET|POST /api/objectives` lists or creates `pine-star.objective.v1` records.
- `POST /api/objectives/status` records lifecycle changes; completion requires evidence references and `approval_required` records cannot be advanced through this route.
- `POST /api/objectives/admit` validates an explicit `systemRoleIds` roster binding and records a dispatch ticket. It never treats a display name or free-form roster role as authority and does not start execution.

| Department | Example roles |
| --- | --- |
| Operations | Coordinator/Chief of Staff, Morning Brief Reporter, Auditor, Experiment Manager, Librarian, File Manager, Daily Open-Source Scout |
| Development | Integration Engineer, Software Engineer, QA/testing, system/tool specialists |
| Creative | Image/design, video, product art, creative QA |
| Business | Digital Product, Commerce, Pine Trail Printables/social, Growth, Finance, Idea Lab |
| Research | General, market/product, tool scouting, technical investigation |

## Rules

- Do not hard-code product logic around this exact list.
- Separate role, agent identity, model/provider configuration, and permissions.
- Default new roles to least necessary authority and explicit budgets.
- Declare ownership/escalation paths and preserve evaluation history.
- Direct user access to specialists remains supported.
- A runtime agent may implement a system role only through an explicit stable-ID binding. Zero or multiple bindings fail closed.
