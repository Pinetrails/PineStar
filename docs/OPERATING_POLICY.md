# Operating policy

## Work policy

- Work at the lowest capable level and escalate only when needed.
- Inspect before editing; preserve demonstrated working architecture.
- Prefer local, reversible, scoped actions over needless confirmation.
- Protected actions require approval under [AUTONOMY_AND_SAFETY.md](AUTONOMY_AND_SAFETY.md).
- Distinguish current implementation, planned work, and future proposals.

## Change control

Every intentional Pine Star development change receives a `PS-YYYY-###` identifier. History has three layers:

1. **Git:** exact technical history.
2. **Project documentation / later Obsidian:** rationale, evidence, lessons, and decisions.
3. **`PINE_STAR_CONTROL.md`:** concise state and navigation.

Meaningful changes should update their record, [CURRENT_STATUS.md](CURRENT_STATUS.md), [../CHANGELOG.md](../CHANGELOG.md), and affected architecture/decision docs. Add commit references only after they exist.

## Discipline

- No blind upstream merges, giant unrelated refactors, hidden failures, speculative claims, or secrets in Git/logs.
- Test proportionally to risk and preserve failure evidence.
- Record experiments as keep/revert with lessons.
- Major roadmap changes require a [decision](DECISIONS.md).
- End work with status, changed files, checks, unresolved issues, and next action.

## Away and recurring work

Future Away/Night operation may continue authorized objectives, research, product preparation, scouting, organization, analysis, safe improvement, and clearly separated simulations. It may not create obligations, publish externally, or bypass approval boundaries.

Morning/daily reports should favor decisions and exceptions: completed work, objectives, money/costs, products/channels, agent performance, errors, learning, decisions, and next actions.

