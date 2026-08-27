# Memory and Obsidian direction

| Layer | Purpose | Typical content |
| --- | --- | --- |
| Internal Pine Star memory | Private operational brain; machine-readable runtime state | agent context, working memory, tool/runtime state, private operational metadata |
| Obsidian | Shared human-readable operational history | decisions, reports, research, project history, lessons, approved summaries |

## Implemented boundary

`PS-2026-004` establishes separate durable station stores for private operational records and concise shared reports. The authenticated `/api/reports` seam exposes only bounded report fields; notebook records, draft bodies, transcripts, raw ledgers, and private payloads are not part of that projection. Morning reports are the first producer.

This does not write to the external Obsidian vault. Obsidian synchronization remains a later adapter with explicit mapping, privacy, conflict, audit, and write-scope rules.

`PS-2026-005` adds a read-only in-app Reports surface and a versioned `/api/control/status` contract. The status truthfully reports external synchronization disabled and preserves the `$0` spending boundary.

`PS-2026-006` adds user-initiated local JSON/Markdown exports with a versioned envelope that explicitly records no destination and no external write. This is an adapter input, not Obsidian synchronization.

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
