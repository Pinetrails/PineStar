# QA STATION — dashboard

One-page status for the Self-Testing Station crew. Scripts detect + write findings to
`qa/findings/`; sessions (Overseer) read the ledger, judge, and notify. The live
per-crew roll-up below can be regenerated any time with:

```
node scripts/qa/ledger.mjs --status
```

## Crew last-run

Last-run / result per crew member. `Last run` and `Result` are filled in by each crew's
own runner (Q1 Guardian, Q2 Beginner Run, Q4 Janitor) or the Overseer digest; the
`Findings/Open/Worst` columns mirror what `--status` reports from the live ledger.

| Crew member | Question it answers | Last run | Result | Open findings |
| --- | --- | --- | --- | --- |
| Green Guardian | Is trunk green and does the app still boot + look right? | 2026-07-03 @ 91b9415e | GREEN | 0 |
| Beginner Run | Can a brand-new user reach first value, unassisted? | 2026-07-01T23:30:22.312Z · ui-only · 84014ms | PASS | 0 |
| Truth Auditor | Does the UI show what actually happened? | 2026-07-01 23:28Z (in Guardian cycle) | GREEN | 0 |
| Visual Auditor | Is the rendered game coherent? (needs eyes) | — (local /loop; not headless) | — | 0 |
| Overseer | What broke today, what needs Andrew? | 2026-07-01 (digest rendered) | 0 P0 · 106 P2 | — |
| Janitor | What's rotting in the workshop? | 2026-07-01 | 106 findings | 106 |

_The rows above are the Q5 **movie test** (2026-07-01): one real cycle of every headless
crew member against trunk `ef47f9d`. Guardian ran all four gates GREEN (Truth Auditor is the
`audit` step inside that cycle — green, so it filed nothing); Beginner Run passed the fresh
path UI-only in 84s; Janitor swept the live repo and filed 106 P2 hygiene findings; the
Overseer digest rendered 0 P0 · 0 P1 · 106 P2 (no Andrew ping — P0 gate is the notify trigger).
Visual Auditor is the eyes-required local `/loop` (`scripts/VISUAL_AUDITOR.md`), not part of a
headless cycle. **The `Open findings` column is a snapshot — the live source of truth is
`node scripts/qa/ledger.mjs --status`.**_

## Port registry

Loops must not collide — multiple sidecars may run at once. Each crew boots sidecars
**only** in its assigned range (Part 3 / Part 5 port law):

| Range | Owner |
| --- | --- |
| 8930–8939 | Visual Auditor (documented; see `scripts/VISUAL_AUDITOR.md`) |
| 8940–8949 | Green Guardian |
| 8950–8959 | Beginner Run |
| 8960+ | Ad-hoc / manual |

## Green Guardian (lane Q1)

One cycle = pin trunk into a **dedicated** checkout and run the four detectors against it:
`test:fast` → `shoot` → `golden` → `audit`. One deduped ledger finding per regression
(fingerprinted per failing suite/frame/assertion so the same defect never re-nags), the
row above refreshed, nonzero exit on any red. Run it:

```
npm run qa:guardian            # one cycle; exits nonzero if trunk is red/blocked
npm run qa:guardian -- --skip-visual   # test:fast + audit only (no Chrome; CI-lite)
npm run qa:guardian:watch      # poll trunk HEAD; run a cycle when it moves
```

**Pinned checkout (read-only law).** Gates NEVER run in the integration tree or another
agent's worktree. The Guardian owns a detached `git worktree` at `../_qa-guardian-pin`
(override with `SKYNET_GUARDIAN_PIN`), `git reset --hard`'d to the current trunk head each
cycle (created + `npm install`'d on first run). Sidecar/CDP ports stay in the Guardian
range: shoot `8940/9340`, golden `8941/9341`, audit `8942/9342`.

**STATUS.md + findings target the guardian's OWN repo, not the pin.** The row above and
`qa/findings/*.json` are written into the qa/ dir of the repo the guardian *script* lives
in (resolved from `import.meta.url`), so the dashboard reflects live state and survives the
pinned checkout's next `reset --hard`. Evidence (logs, flagged golden PNGs, gate reports)
is copied into `.bugloops/guardian-<stamp>/` for the same reason. Findings are filed
through `scripts/qa/ledger.mjs --add` so dedup / known-refusal stays the ONE implementation.

**No-fake-green.** A step that cannot run (git/npm/spawn failure, timeout, missing report)
files a **P0 BLOCKED** finding loudly and the cycle exits nonzero — it never silently
passes. Scheduling (Task Scheduler vs. a `/loop` session) is lane Q5's job; this script is
schedule-agnostic.

**Dismissed-frame gate (golden).** A golden frame whose *current* fingerprint is already
**dismissed/known** in the ledger is **review-clean**, not a regression: `scripts/golden.mjs`
asks the ledger's `suppressedFingerprints()` (the ONE dedup/known authority) and computes each
frame's Green-Guardian fingerprint (`goldenFrameFingerprint(name)` == `fingerprintOf({crew:'Green
Guardian', checkId:'golden', subject:'frame/'+name})`). A match is logged as `review-clean …
matches dismissed finding <fp>` and kept OUT of `flagged`, so golden exits 0 and the row above
stays GREEN. This exists because `sys-rewind` (the one modal that doesn't full-bleed over the
animated CRT floor) diffs forever as animation noise — its finding `01c40465` was triaged and
**dismissed**, yet a naïve golden gate would re-flag it every cycle and pin this row RED with 0
open findings (a lying dashboard). **Narrow by design:** only a frame whose fingerprint is on the
dismissed/known baseline is excused; a new frame, a different frame, or a diff on a non-dismissed
frame STILL flags → exit 3 → the Guardian files it through the ledger exactly as before. Fail-open:
if the ledger can't be read, nothing is suppressed. Covered by `test/golden.test.js`.

## Ledger quick reference

```
# file a finding (rejected without evidence; refused if known/dismissed; deduped by fingerprint)
node scripts/qa/ledger.mjs --add --json '{"crew":"Green Guardian","severity":"P0","title":"...","detail":"...","evidence":["path/to/artifact"],"checkId":"...","subject":"..."}'

# morning report (grouped by severity then crew); --write persists to qa/digests/<date>.md
node scripts/qa/ledger.mjs --digest [--date YYYY-MM-DD] [--write]

# is this fingerprint already filed / known?
node scripts/qa/ledger.mjs --dedup-check <fingerprint>

# per-crew roll-up (the table above, live)
node scripts/qa/ledger.mjs --status
```

- 2026-07-03 agent/cron-sessions → trunk 7c2619c8 (test:fast + test:http green): unattended cron/routine runs now surface as READABLE SESSIONS. Scheduled + Run-Now fires run under a per-run stream `cron-<runId>` (sidecar) so their transcripts are durable+fetchable; new frontend/app/autosessions.js adopts a rail session on cron.fire (busy, no focus-steal), folds the real output in on cron.result via /api/transcript, and backfills while-away runs on boot. Fixes "heard cron chimes, output invisible" defect. Live-verified on the mock-cron seed (:8783): scheduled one-shot fired on the 60s tick → titled busy row appeared → real reply folded into COMMS; audit confirmed all other run paths (channels/team/goal/reflection/study) already visible. Desktop hot-patch to 0.1.7 ATTEMPTED but SAC-blocked 3× (unsigned exe, aggressive today) → install restored to working 0.1.6; the on-disk sidecar carries the fix, but the embedded-UI half needs a SAC-passing exe (retry another day or sign). Test via `npm start` localhost meanwhile.
- 2026-07-03 agent/postcard-export → trunk 26669c4 (test:fast green): shareable run POSTCARD — ⎙ button on the post-run recap card composites live #stage scene + honest run telemetry (Xp/Pride reducers, stats omitted when unprovable) into a downloadable PNG; live-verified via scripts/verify-postcard.mjs (521KB PNG, on-card numbers === telemetry). First G5 spectacle surface (P2.1).
- 2026-07-03 agent/golden-dismissed-gate → trunk dfeccd4 (test:fast green): golden gate now excuses frames whose fingerprint matches a dismissed/known ledger finding (P0.1b); sys-rewind noise can no longer pin the Guardian RED; novel diffs still exit 3 + file findings (21-assertion test).
- 2026-07-03 agent/desktop-control → trunk a1c22c6a (test:fast + test:http green): visible controlled browser by default, desktop.open, wired win32 computer.use + keyboard, honest browser.vision. Fixes "agent can't open a visible browser / lied about it" defect class. main.rs env line not Rust-compiled in-session (proves on next desktop:build).
- 2026-07-03 agent/refit-ui → trunk 2eac250d (test:fast green): builder-mode UI rebuilt — REFIT dock becomes a full-height LEFT build panel (premium chrome); palette is a real scroll region (old bottom strip clipped the prop gallery with overflow:hidden), category tabs wrap, fitCamera centers the station in the visible viewport. Live-verified: DOM round-trips on seeded :8827 + CDP uishoot captures (build-station, build-prop-gallery); tutorial selectors untouched.

- 2026-07-03 merge: agent/workshop-backend -> feat/harness-backend (5e08d6db) — W1 workshop consent grant + W2 away-work driver; gates test:fast + test:http GREEN (workshop.e2e 19 assertions).
- 2026-07-03 merge: agent/mint-ledger -> feat/harness-backend (54d8f1e4) — W6 mint gate + per-agent minted ledger + dup boot sweep; gates test:fast + test:http GREEN.
- 2026-07-03 agent/env-depth-fx -> 4f4058cf : env depth+polish FX stack (wall shadows, sheen, dust, parallax stars, aberration, grain; CRT LAB Depth+), test:fast GREEN
