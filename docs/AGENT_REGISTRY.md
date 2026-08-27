# Agent registry direction

## Status

`PS-2026-007` implements the first pure, data-driven registry and lowest-capable-level router. It is not yet the complete durable runtime registry or objective queue.

A future data-driven registry should support stable role ID, display name, department, purpose, capabilities, tool grants, escalation targets, model tier, cost limits, protected-action boundaries, availability, evaluation profile, and memory/report destinations. Names may change without changing role identity.

The implemented foundation currently separates stable role ID, display label, department, capabilities, Economy/Balanced/Deep tier, escalation targets, permissions, and availability. Remaining fields will be added as runtime objective ownership and evaluation mature.

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
