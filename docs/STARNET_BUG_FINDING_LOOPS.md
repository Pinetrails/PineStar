# StarNet Bug-Finding Loop System

Purpose: turn recurring StarNet failure patterns into automated loops that find
real product bugs, produce reproducible evidence, and route fixes to the right
worktree without clobbering parallel agents.

This is not a replacement for the session runbooks. It is the layer above them:
which loops should be running, what each one is hunting, what counts as evidence,
and when a loop should fix, bless, route, or stop.

## Core Rule

Every loop must produce one of four outcomes:

- PASS: no new bug signal.
- REPRO: a concrete failing test, screenshot, report, log, or HTTP payload.
- FIXED: a minimal patch plus the detector rerun green.
- ROUTED: a finding assigned to the owner lane because the target files are hot
  or outside this loop's write set.

If a loop cannot show the before/after observable, it is not allowed to call the
bug fixed.

## One-Command Sweep

Use the additive runner:

```powershell
node scripts/bug-hunt.mjs
```

Default quick mode runs:

- `node scripts/board.mjs`
- `npm run validate`
- `npm run test:world`
- `node scripts/audit.mjs`
- `node scripts/golden.mjs`

It writes evidence to `.bugloops/bug-hunt-<timestamp>` and refreshes
`.bugloops/bug-hunt-latest`. Golden diffs are treated as REVIEW, not automatic
failure: inspect only the listed PNGs, then fix or intentionally bless.

Before merge, or after a source fix:

```powershell
node scripts/bug-hunt.mjs --full
```

Full mode adds `npm run test:fast` and `npm run test:http`.

Useful variants:

```powershell
node scripts/bug-hunt.mjs --no-visual
node scripts/bug-hunt.mjs --no-audit
node scripts/bug-hunt.mjs --live-audit
```

## Bug Classes To Hunt

These are the patterns that recur across the docs, ledgers, and current session
status files.

| Class | Failure pattern | Best detector |
| --- | --- | --- |
| App lies | UI says a thing is true that the event log, ledger, routing plan, or sidecar cannot prove. | `audit.mjs` truth assertions; HUD/logbook reductions from frozen events. |
| Lifecycle residue | Module singleton state, timers, streams, panels, audio, or bodies survive WAKE/RESUME/DISCONNECT/NEW AGENT/REFIT. | Browser transition fuzzer plus state probes. |
| Renderer authority | Renderer-posted station/capability data grants tools or routes that the sidecar did not derive. | Forged HTTP/save payload tests. |
| Visual incoherence | Panel overlap, native controls, stale scrims, off-center modals, unreadable layers, unreviewed baseline drift. | `golden.mjs` plus visual inspection of flagged frames only. |
| Scheduler/autonomy drift | Cron math, DST, locks, retry claims, disabled scheduler, or unattended run state goes stale or lies. | Pure cron tests plus seeded UI routine scenario. |
| Spend/model dishonesty | Unknown model, unmetered run shown as free, fallback model lost, managed/BYOK ledgers mixed. | Provider replay, ledger, insights, and live smoke with real env. |
| Safe-cell escape | Files/shell/verify/subagent surfaces escape agent workspace, consent, checkpoint, or halt. | Path/shell adversarial fuzz plus safe-cell tests. |
| Release/update false proof | Desktop build, updater, signing, clean install, or migration proof is claimed without machine evidence. | T0-T5 runners, desktop build, updater manifest tests. |
| Parallel-agent damage | Hot files get edited by multiple lanes; stale branches reintroduce old UI or route behavior. | `board.mjs`, sync-before-merge, post-merge bug-hunt sweep. |

## The Loop Portfolio

### 1. Merge Sentry Loop

Goal: detect fresh trunk regressions as soon as branches land.

Cycle:

1. Sync an isolated sentry worktree from trunk.
2. Run `node scripts/bug-hunt.mjs`.
3. If PASS, record the commit hash and sleep until the next trunk merge.
4. If REVIEW, inspect only `.bugloops/bug-hunt-latest/golden-frames`.
5. If FAIL, open a bug lane with the failing log and target owner.

Best owner: orchestrator or a dedicated read-only sentry agent.

### 2. Visual Auditor Loop

Goal: make UI incoherence Andrew's least likely discovery path.

Cycle:

1. Run `npm run golden`.
2. Inspect only frames in `.uigolden/golden-report.json`.
3. Classify each changed frame: regression, intentional improvement, or baseline
   stale due to accepted design movement.
4. Fix small CSS/layout defects in the UI owner lane.
5. Bless only reviewed improvements with `npm run golden:bless`.

This loop already found a real defect in the ROUTINES panel: a
`textarea.key-input` fell through to native white browser styling. The fix was
to include `textarea.key-input` in the shared terminal input styling.

### 3. Behavioral Audit Expansion Loop

Goal: grow `audit.mjs` from "seeded floor sanity" into a living product oracle.

Next scenarios to add:

- Routine create -> preview -> run now -> `cron.fire`/`cron.result` -> visible
  activity -> honest scheduler-disabled state.
- Tool consent prompt -> deny/approve -> no stale prompt residue -> transcript
  and ledger match.
- Workstream switch during/after a run -> COMMS identity, run metadata, and
  title/status stay scoped.
- Summon -> assign station role -> body reaches own desk and never borrows the
  hero voice.

Rule: every added audit scenario should fail on a known or plausible bug class,
not just click through happy paths.

### 4. Lifecycle Residue Fuzzer

Goal: prevent the next singleton-leak family after state-integrity closed the
first batch.

Cycle:

1. Drive transition sequences without page reload:
   WAKE, RESUME, DISCONNECT, NEW AGENT, SUMMON, REFIT, WS-SWITCH.
2. Sample probes after each transition:
   bodies, panels, EventSource, poll timers, speech queue, audio, active runs,
   workstream id, local storage keys, mode classes, scrim/fullscreen surfaces.
3. Compare to expected allowed state.
4. Reduce any leak to one module-level root cause.

Add this as a browser/CDP test harness, because fresh page-load tests miss this
class by construction.

### 5. Authority Forgery Loop

Goal: make "renderer requested it" worthless as authority.

Cycle:

1. Generate invalid Station/SaveDoc/routing/run payloads.
2. Try to grant web/files/shell/connectors from forged `placed`, forged legacy
   routing plans, missing connector ids, or sealed room handoffs.
3. Assert sidecar refuses or keeps last-good state.
4. Add every new exploit attempt as a unit or HTTP regression.

This should wake whenever `sidecar/index.js`, routing, station-store, or
worldmodel serialization changes. Current coordination status shows
`sidecar/index.js` is still the main hot integration file.

### 6. Cron And Autonomy Soak Loop

Goal: catch scheduler bugs that only appear after time, restart, or failure.

Cycle:

1. Run pure cron tests for DST, locks, durability, one-shots, and parse errors.
2. Run a seeded sidecar routine scenario with fake clock/provider.
3. Restart sidecar between fire and settlement.
4. Verify no double-fire, no dropped result, no stale fire claim, and no disabled
   scheduler lie.

Escalate to live smoke only after deterministic replay passes.

### 7. Spend And Model Truth Loop

Goal: make cost/model displays boringly honest.

Cycle:

1. Exercise replay, OpenRouter, Codex OAuth, fallback, unpriced, unmetered, and
   managed-credit paths.
2. Compare provider result, ledger row, spend aggregate, Logbook, Insights, and
   HUD.
3. Reject `(unknown)` unless every identity source is truly missing.
4. Reject `$0.0000` as final truth for unmetered or unpriced paths; label them.

This loop should run with replay by default and a real key only for explicit
paid smoke.

### 8. Safe-Cell Adversarial Loop

Goal: preserve beginner-safe local execution while admitting local shell is not
a hostile-code sandbox.

Cycle:

1. Fuzz file paths, symlink ancestors, sibling workspaces, protected files, UNC
   paths, drive paths, `..`, and null bytes.
2. Fuzz shell cwd changes, parent/absolute references, background processes,
   timeouts, checkpoint restore, halt, and team workers.
3. Assert refusal, checkpoint, killability, and durable worker state.

Run after any files/shell/verify/orchestration change.

### 9. Release Proof Loop

Goal: no release claim without a machine artifact.

Cycle:

1. Run T0 clean install, T1 signing, T2 state safety, T3 release smoke, T4
   update delivery, and T5 public distribution.
2. Run `npm run desktop:build` when Cargo/Rust are installed.
3. Boot the packaged app and capture screenshot/log proof.
4. Treat missing Rust/Cargo as BLOCKED, not passed.

This loop is currently partly blocked by local Rust/Cargo availability in the
session status ledger.

## Triage Priority

Score findings with:

```text
priority = severity + reproducibility + user_visibility + automation_value - ownership_risk
```

Use that to prefer:

1. Bugs that make the app lie.
2. Bugs that spend money, leak authority, or persist bad state.
3. Bugs that recur across merges and can be turned into an automatic detector.
4. Visual defects in first-screen or core-loop surfaces.

Do not spend loop time on speculative refactors without a failing detector.

## Routing Rules

- If `board.mjs` says a target file is hot, record ROUTED/HELD with the exact
  file and owning lanes.
- If the bug crosses `shared/events.js` or `shared/schema.js`, request an
  additive contract change from the owner.
- If a visual frame changed but looks coherent, route to visual baseline review;
  do not bless from a non-visual owner lane.
- If a live-provider or desktop proof needs external state, mark BLOCKED with
  the exact env/toolchain requirement and keep replay/pre-build checks green.

## Current Observed Baseline

From the `agent/bug-loops` sweep on 2026-06-30:

- `npm run validate`: PASS.
- `npm run test:world`: PASS.
- `npm run test:fast`: PASS.
- `npm run audit`: PASS, with one soft work-pose latch note.
- `npm run golden`: REVIEW on `work-routines` after fixing the native textarea
  styling; the remaining diff should be reviewed by the visual baseline owner
  before blessing.

That is a good sign: the regression spine is green, and the loop produced one
small real UI fix plus one visual review item instead of a vague bug list.
