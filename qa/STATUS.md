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
| Green Guardian | Is trunk green and does the app still boot + look right? | — | — | 0 |
| Beginner Run | Can a brand-new user reach first value, unassisted? | — | — | 0 |
| Truth Auditor | Does the UI show what actually happened? | — | — | 0 |
| Visual Auditor | Is the rendered game coherent? (needs eyes) | — | — | 0 |
| Overseer | What broke today, what needs Andrew? | — | — | 0 |
| Janitor | What's rotting in the workshop? | 2026-07-01 | 79 findings | 0 |

_(Zeroes are the spine's fresh baseline: no findings filed yet. Each crew lane fills its
row when it lands and runs its first cycle.)_

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
