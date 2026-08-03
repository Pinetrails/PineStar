# StarNet agent evaluations

This is the dependency-free, task-outcome evaluation layer. It complements the existing wiring,
UI, release, and workload gates; it does not replace them or make a release-readiness claim.

## v0.9 reliability and parity contract

The frozen comparison contract is `contracts/v0.9.0.json`. It binds the comparison to Hermes Agent
v0.19.1/tag `v2026.7.30`. The annotated tag object is
`d25e2dbdbc40b49808c0a0e9cfed21cc90cffab3`; its peeled commit is
`cc4cab2f592e60a197e796506de9168f74baf3ea`, with tree
`fcdc6093750ed0a3a556e20927799d7245ba65e4`. The contract classifies every advertised StarNet
claim and freezes the release gates.
Validate it against the live product-perfect claim ledger:

```powershell
npm run eval:contract
```

The 10 run-boundary fault scenarios and 32 shared workload scenarios live under `packs/`. They are
all active: a missing trajectory is a failure, never a pending green. Fault evidence requires 100
attempts per boundary (1,000 rows), and parity evidence requires three attempts per harness and
scenario (96 rows each). Run captured evidence with:

```powershell
node scripts/eval/runner.mjs capture-fault --out fault-trajectories.jsonl
node scripts/eval/runner.mjs fault --candidate fault-trajectories.jsonl --subject-manifest starnet-manifest.json --signing-key receipt-private.pem --receipt fault-receipt.json
node scripts/eval/runner.mjs compare --starnet starnet.jsonl --reference hermes.jsonl --subject-manifest starnet-manifest.json --reference-manifest hermes-manifest.json --signing-key receipt-private.pem --receipt parity-receipt.json
```

Bind exact installed/runtime identities before scoring, then create or verify Ed25519 receipt keys:

```powershell
node scripts/eval/runner.mjs bind --profile starnet --source-dir <source> --runtime-root <installed-root> --executable <desktop-exe> --commit <commit> --tree <tree> --describe <describe> --version 0.8.5 --health-url <health-url> --manifest starnet-manifest.json
node scripts/eval/runner.mjs bind --profile hermes --source-dir <frozen-checkout> --executable <venv-python> --home-dir <isolated-home> --manifest hermes-manifest.json
node scripts/eval/runner.mjs keygen --private receipt-private.pem --public receipt-public.pem
node scripts/eval/runner.mjs verify-receipt --receipt fault-receipt.json
```

The 32 workload declarations are paired one-for-one with independent fixtures in
`fixtures/parity-v0.9.0.jsonl`. Each fixture freezes its own setup, identical prompt, mutation budget,
and host-observation oracle. `compare` always runs `independent-grader.mjs` over both harness trajectory
files before scoring: a submitted `outcome.passed` is discarded, safety violations are recomputed, route
and post-mutation verification requirements are enforced, and the fixture/grader hashes are included in
the receipt evidence. A trajectory therefore needs host-captured `observation`, `routing`, and artifact
fields; model prose alone cannot green a scenario.

Receipts emit `starnet.eval.receipt.v1`. `candidateBound:true` requires verified executable-to-source
provenance, a clean source tree, commit/tree identity, and an executable SHA-256. Reference binding
also requires the frozen Hermes commit, tree, version, and executable manifest. A source run remains
truthfully `candidateBound:false`. The zero-tolerance invariants are false completion, wrong
destination, duplicate mutation, and authority escape.

If a harness or grader cannot actually execute, record all expected rows as explicit failures instead
of manufacturing a partial score:

```powershell
node scripts/eval/runner.mjs mark-unavailable --harness starnet --reason <reason> --out starnet-unavailable.jsonl
```

Provider evaluation homes may copy non-secret roster/state fixtures, but must never copy OAuth token,
auth, or `.env` files. Bindings prove the executable; they do not authorize credential use.

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
