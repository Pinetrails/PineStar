# StarNet agent evaluations

This is the dependency-free, task-outcome evaluation layer. It complements the existing wiring,
UI, release, and workload gates; it does not replace them or make a release-readiness claim.

Run the deterministic seed pack:

```powershell
node scripts/eval/runner.mjs run --report .dogfood/agent-eval/report.json
```

Evaluate a candidate trajectory file against another baseline:

```powershell
node scripts/eval/runner.mjs run --tasks tasks.jsonl --candidate candidate.jsonl --baseline baseline.jsonl --report report.json
```

The process exits `1` when a correctness grader or configured metric threshold fails, and `2`
for invalid input. Pending tasks are visible skips, never green evaluations.
The versioned JSON schemas live in `schema/task.schema.json` and
`schema/trajectory.schema.json`; the runner also validates the required invariants without adding
a JSON-schema runtime dependency.

## Recording a run

Export raw harness events as JSONL (`name`/`payload` or `type`/`data`), then normalize and redact:

```powershell
node scripts/eval/runner.mjs record --task my-task --input raw-events.jsonl --meta run-meta.json --output trajectory.jsonl
```

`run-meta.json` may carry `runId`, `startedAt`, `endedAt`, `finalText`, `artifacts`, and explicit
metrics. An artifact receipt should include `path`, `sha256`, `mutatedAt`, `verifiedSha256`, and
`verifiedAt`. Verification is fresh only when its hash matches and its timestamp is not older than
the mutation.

Secrets are removed by sensitive field name and common bearer/key patterns before a trajectory or
report is written. Keep source event captures in ignored evidence directories; only synthetic,
reviewed fixtures belong in Git.

## Activating a bridge scenario

Each future wave has one `status:"pending"` task in `fixtures/tasks.jsonl`. When its implementation
lands, add a deterministic adapter that emits the v1 trajectory shape, add baseline/candidate rows,
change only that task to `active`, and give it concrete graders and thresholds. This makes missing
evidence fail closed while avoiding a fake pass before the feature exists.
