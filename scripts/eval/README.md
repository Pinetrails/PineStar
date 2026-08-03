# StarNet agent evaluations

This is the dependency-free, task-outcome evaluation layer. It complements the existing wiring,
UI, release, and workload gates; it does not replace them or make a release-readiness claim.

## v0.9 reliability and parity contract

The frozen comparison contract is `contracts/v0.9.0.json`. It binds the comparison to Hermes Agent
v0.19.1/tag `v2026.7.30`, classifies every advertised StarNet claim, and freezes the release gates.
Validate it against the live product-perfect claim ledger:

```powershell
npm run eval:contract
```

The 10 run-boundary fault scenarios and 32 shared workload scenarios live under `packs/`. They are
all active: a missing trajectory is a failure, never a pending green. Run captured evidence with:

```powershell
node scripts/eval/runner.mjs fault --candidate fault-trajectories.jsonl --receipt fault-receipt.json
node scripts/eval/runner.mjs compare --starnet starnet.jsonl --reference hermes.jsonl --receipt parity-receipt.json
```

Both commands emit `starnet.eval.receipt.v1`. A source run is truthfully marked
`candidateBound:false`; installed-candidate proof additionally supplies `--executable <path>` so the
receipt records its SHA-256. The zero-tolerance invariants are false completion, wrong destination,
duplicate mutation, and authority escape.

Capture the provisional source-harness performance baseline with:

```powershell
npm run eval:baseline -- --samples 15 --receipt .dogfood/eval/performance-baseline.json
```

That baseline covers the deterministic bridge/evaluation rails and process startup. It explicitly
does not stand in for installed cold boot, first-token/useful-artifact latency, or the 48-hour soak.

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

The five bridge scenarios are active and default runs execute their real adapters from
`adapters/bridge.mjs`: semantic continuation through `runAgentLoop`, restart analysis through the
append-only run journal, isolated `code.run`, stdio LSP edit deltas, and segmented-history recall
after restart. `fixtures/candidate.jsonl` is the reviewed deterministic receipt; the test requires
the live adapters to reproduce it byte-for-byte. New scenarios follow the same pattern: add an
adapter, baseline/candidate evidence, concrete graders, and fail-closed thresholds.
