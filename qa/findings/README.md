# QA findings

One JSON file per finding, written by `scripts/qa/ledger.mjs` (schema below). This
directory ships **empty** of findings — the known baseline lives in `../KNOWN_ISSUES.md`,
not here. Real findings accumulate as the crew runs.

**Finding schema** (`qa/findings/<id>.json`):

```json
{
  "id": "…",
  "fingerprint": "…",
  "ts": 0,
  "crew": "Green Guardian | Beginner Run | Truth Auditor | Visual Auditor | Overseer | Janitor",
  "severity": "P0 | P1 | P2",
  "title": "…",
  "detail": "…",
  "evidence": ["path/to/artifact"],
  "status": "open | routed | fixed | dismissed | known",
  "routedTo": "…"
}
```

Laws (Part 5): every finding carries at least one `evidence` path; the same
`fingerprint` never files twice; a `dismissed`/`known` fingerprint never re-files.
Evidence typically lives under `.bugloops/` (gitignored) or alongside the finding.
