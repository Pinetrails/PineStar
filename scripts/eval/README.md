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

Before the full campaign, probe both harnesses with one explicit comparison model. `--model` is applied
to Hermes and to StarNet's default-model environment; the probe still fails if a persisted StarNet roster
selects a different model, so a nominal CLI flag cannot hide a real mismatch:

```powershell
node scripts/eval/same-model-probe.mjs --model <model> --starnetRoot <installed-root> --starnetHome <active-workspaces> --hermesSource <frozen-checkout> --hermesPython <venv-python> --hermesHome <isolated-home> --output <probe.json> --outputDir <evidence-dir>
```

After exactly three successful attempts, bind and sign their immutable raw evidence. The finalizer
fails closed on a duplicate file, model/provider drift, non-exact output, missing timing/token data,
or either executable no longer matching its manifest:

```powershell
node scripts/eval/same-model-receipt.mjs --probes <probe-1.json>,<probe-2.json>,<probe-3.json> --subject-manifest <starnet-manifest.json> --reference-manifest <hermes-manifest.json> --contract scripts/eval/contracts/v0.9.0.json --signing-key <receipt-private.pem> --receipt <performance-receipt.json>
node scripts/eval/runner.mjs verify-receipt --receipt <performance-receipt.json>
```

This measures StarNet's bound installed runtime node/sidecar path, not desktop UI cold boot, and is
only the provider/model equivalence preflight. It does not replace the 32-scenario gauntlet or the
installed provider-backed 48-hour soak.

Before any provider-backed campaign, run the metadata-only preflight. It fails closed unless the
installed executable exactly matches the bound candidate, the frozen Hermes identity and executable
still match, all 32 tasks have independent fixtures, three attempts are contracted, and the credential
envelope modification time is later than the declared rotation boundary. It never reads credential
contents and never authorizes provider spend:

```powershell
node scripts/eval/campaign-preflight.mjs --contract scripts/eval/contracts/v0.9.0.json --candidate-manifest <starnet-manifest.json> --reference-manifest <hermes-manifest.json> --fixtures scripts/eval/fixtures/parity-v0.9.0.jsonl --tasks scripts/eval/packs/parity-v0.9.0.jsonl --installed-executable <installed-desktop-exe> --credential-envelope <tokens.json> --rotation-after <exposure-utc> --output <preflight.json>
```

The common campaign runner materializes each fixture into a new isolated workspace, exposes one local
HTTP MCP host to the selected harness, and appends every host-observed trajectory immediately. Output is
resumable by `(taskId, attempt)`. Hermes v0.19.1 needs its declared ACP and MCP extras installed in the
isolated comparison venv, its evaluation profile default pinned to the comparison model, and automatic
tool-search collapsing disabled so the Codex-backed ACP session retains and sees its dynamic MCP surface.
The driver verifies the session model and fails closed on drift.

```powershell
node scripts/eval/campaign-runner.mjs --harness starnet --fixtures scripts/eval/fixtures/parity-v0.9.0.jsonl --manifest <starnet-manifest.json> --output <starnet.jsonl> --output-dir <evidence-dir> --attempts 3 --runtime-root <installed-root> --workspaces <active-credential-workspaces>
node scripts/eval/campaign-runner.mjs --harness hermes --fixtures scripts/eval/fixtures/parity-v0.9.0.jsonl --manifest <hermes-manifest.json> --output <hermes.jsonl> --output-dir <evidence-dir> --attempts 3 --source <frozen-hermes-source> --python <frozen-hermes-python> --home <isolated-hermes-home>
```

After parity is green, measure the actual installed desktop process and a provider-backed verified artifact.
The signed result distinguishes desktop process-to-health/station readiness from installed-runtime
send-to-first-token and send-to-verified-artifact latency.

```powershell
node scripts/eval/installed-performance.mjs --desktop-executable <installed-desktop-exe> --runtime-root <installed-root> --workspaces <active-credential-workspaces> --manifest <starnet-manifest.json> --contract scripts/eval/contracts/v0.9.0.json --fixtures scripts/eval/fixtures/parity-v0.9.0.jsonl --tasks scripts/eval/packs/parity-v0.9.0.jsonl --signing-key <receipt-private.pem> --output <performance.json> --receipt <performance-receipt.json> --output-dir <evidence-dir> --samples 5
```

The qualifying soak keeps the installed runtime alive for at least 48 wall-clock hours, samples health and
Windows CPU/RSS every minute, and executes an independently graded provider-backed fixture hourly. It cannot
set `qualifiesRelease:true` for a shorter duration, a missing provider call, a failed host grade, version drift,
an unexpected exit, or less than 99% planned sample coverage.

```powershell
node scripts/eval/installed-provider-soak.mjs --runtime-root <installed-root> --workspaces <active-credential-workspaces> --manifest <starnet-manifest.json> --contract scripts/eval/contracts/v0.9.0.json --fixtures scripts/eval/fixtures/parity-v0.9.0.jsonl --tasks scripts/eval/packs/parity-v0.9.0.jsonl --signing-key <receipt-private.pem> --output <soak.json> --receipt <soak-receipt.json> --output-dir <evidence-dir> --duration-hours 48 --health-interval-seconds 60 --active-interval-seconds 3600
```

Capture the provisional source-harness performance baseline with:

```powershell
npm run eval:baseline -- --samples 15 --receipt .dogfood/eval/performance-baseline.json
```

That baseline covers the deterministic bridge/evaluation rails and process startup. It explicitly
does not stand in for installed cold boot, first-token/useful-artifact latency, or the 48-hour soak.

After a provider-free control soak ends, validate every sample and bind the immutable evidence to the
candidate before signing it. This finalizer checks completion time, at least 99% planned sample coverage,
health/version continuity, process survival, and manifest provenance. Its receipt always retains
`qualifiesRelease:false` and cannot replace the installed provider-backed soak:

```powershell
node scripts/eval/soak-receipt.mjs --soak <soak.json> --manifest <starnet-manifest.json> --contract scripts/eval/contracts/v0.9.0.json --signing-key <receipt-private.pem> --receipt <soak-receipt.json>
node scripts/eval/runner.mjs verify-receipt --receipt <soak-receipt.json>
```

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
