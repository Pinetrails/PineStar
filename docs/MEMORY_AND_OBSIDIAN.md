# Memory and Obsidian direction

| Layer | Purpose | Typical content |
| --- | --- | --- |
| Internal Pine Star memory | Private operational brain; machine-readable runtime state | agent context, working memory, tool/runtime state, private operational metadata |
| Obsidian | Shared human-readable operational history | decisions, reports, research, project history, lessons, approved summaries |

Obsidian is not a raw mirror of private runtime memory.

## Existing external vault

A separate vault exists outside this repository with `00 System`, `10 Projects`, `20 Business`, `30 Research`, `40 Daily Reports`, and `90 Archive`. `PS-2026-001` does **not** modify it.

Later integration requires deliberate mapping, privacy rules, conflict handling, audit behavior, and user-approved write scope.

## Future rules

- Minimize secrets/private data in shared notes.
- Write durable conclusions/evidence, not hidden chain-of-thought or unfiltered transcripts.
- Make sources and Change IDs traceable when useful.
- Define authority per data class before synchronization.
- Make writes inspectable and recoverable; avoid silent bulk mutation.
- Keep morning/daily reports concise, decision-oriented, and cost-aware.

