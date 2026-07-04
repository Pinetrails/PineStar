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

- 2026-07-03 agent/cron-sessions → trunk 7c2619c8 (test:fast + test:http green): unattended cron/routine runs now surface as READABLE SESSIONS. Scheduled + Run-Now fires run under a per-run stream `cron-<runId>` (sidecar) so their transcripts are durable+fetchable; new frontend/app/autosessions.js adopts a rail session on cron.fire (busy, no focus-steal), folds the real output in on cron.result via /api/transcript, and backfills while-away runs on boot. Fixes "heard cron chimes, output invisible" defect. Live-verified on the mock-cron seed (:8783): scheduled one-shot fired on the 60s tick → titled busy row appeared → real reply folded into COMMS; audit confirmed all other run paths (channels/team/goal/reflection/study) already visible. Desktop hot-patch: first 3 fresh-hash 0.1.7 exes SAC-blocked (install temporarily restored to 0.1.6); 4th fresh-hash build PASSED — INSTALLED NOW 0.1.7 (app+sidecar alive through settle, AutoSessions grep-confirmed in the running exe, install dirs synced to trunk 6d1f3fe9). Trunk pushed to origin; cron-sessions worktree reaped.
- 2026-07-03 agent/postcard-export → trunk 26669c4 (test:fast green): shareable run POSTCARD — ⎙ button on the post-run recap card composites live #stage scene + honest run telemetry (Xp/Pride reducers, stats omitted when unprovable) into a downloadable PNG; live-verified via scripts/verify-postcard.mjs (521KB PNG, on-card numbers === telemetry). First G5 spectacle surface (P2.1).
- 2026-07-03 agent/golden-dismissed-gate → trunk dfeccd4 (test:fast green): golden gate now excuses frames whose fingerprint matches a dismissed/known ledger finding (P0.1b); sys-rewind noise can no longer pin the Guardian RED; novel diffs still exit 3 + file findings (21-assertion test).
- 2026-07-03 agent/desktop-control → trunk a1c22c6a (test:fast + test:http green): visible controlled browser by default, desktop.open, wired win32 computer.use + keyboard, honest browser.vision. Fixes "agent can't open a visible browser / lied about it" defect class. main.rs env line not Rust-compiled in-session (proves on next desktop:build).
- 2026-07-03 agent/refit-ui → trunk 2eac250d (test:fast green): builder-mode UI rebuilt — REFIT dock becomes a full-height LEFT build panel (premium chrome); palette is a real scroll region (old bottom strip clipped the prop gallery with overflow:hidden), category tabs wrap, fitCamera centers the station in the visible viewport. Live-verified: DOM round-trips on seeded :8827 + CDP uishoot captures (build-station, build-prop-gallery); tutorial selectors untouched.

- 2026-07-03 merge: agent/workshop-backend -> feat/harness-backend (5e08d6db) — W1 workshop consent grant + W2 away-work driver; gates test:fast + test:http GREEN (workshop.e2e 19 assertions).
- 2026-07-03 merge: agent/mint-ledger -> feat/harness-backend (54d8f1e4) — W6 mint gate + per-agent minted ledger + dup boot sweep; gates test:fast + test:http GREEN.
- 2026-07-03 agent/env-depth-fx -> 4f4058cf : env depth+polish FX stack (wall shadows, sheen, dust, parallax stars, aberration, grain; CRT LAB Depth+), test:fast GREEN
- 2026-07-03 merge: agent/workshop-frontend -> feat/harness-backend (8b014407) — W3 away-workshop return surface (toggle/queue/return card); gate test:fast GREEN.
- 2026-07-03 agent/env-depth-bake -> e28d17f0 : baked Andrew's live-tuned FX defaults (curve 0.09, grain 0.24, wall.up 9, wallShadow 0.5, sheen 0.14), test:fast GREEN
- 2026-07-03 agent/comms-polish -> e2630472 (ff from 02114dce): COMMS turn-in letter-spill/giant-card fix + per-theme gold accents + rail unread dots; test:fast GREEN (worktree tree == merged tree), live-verified on dev seed :8817
- 2026-07-03 agent/recruit-presets -> f70a4f05 (ff): desktop zero-class-presets fix (shared catalog via API origin + CSP) + summon-flow rec shelf w/ honest cold-start lineup; test:fast green (worktree + trunk)
- 2026-07-03 agent/chan-routing -> trunk 451f05c2: channel-agnostic /agents /talk /model at hub layer; gate test:fast + test:http GREEN
- 2026-07-03 agent/comms-picker -> trunk: COMMS agent selector top bar + roster-backed model readout; gate test:fast GREEN
- 2026-07-03 agent/logo-crisp -> 5715753a (ff from 08d6bfec): STARNET topbar logo hoisted above CRT glass (body-level z960, brand-locked amber glow, anchor-seat layout); test:fast GREEN, live-verified on dev seed :8817
- 2026-07-03 agent/couch-zsort -> trunk 072bf6c4 (--no-ff): couch y-sorts behind ANY seated body, not just the hero — a crew agent lounging on a couch rendered BEHIND it on north/side approach (draw seam wired hero-only); now every sitter sorts by seatPy w/ couch at seatPy-1. test:fast GREEN; deterministic draw-order sim (real consts T=12) OLD 2/3 behind -> NEW 0/3, hero path byte-identical; browser pixel proof deferred (preview pool full).
- 2026-07-03 agent/hover-nameplate -> trunk 0f9dcf8c (--no-ff): hover nameplate now shows NAME + LEVEL for crew/summoned agents, not just the Overseer — agentHit() only tested the hero body + drawNameplate() was hardcoded to `agent`; both generalized to the nearest placed body under the cursor (hover cursor + plate track crew too), per-body XP via xpByAgent.get(who.id). Hero-only self-glance-on-hover + click-to-open-console kept gated to `=== agent` so a crew hover never opens the hero panel. test:fast GREEN (worktree rebased on trunk + trunk after merge); live-verified on dev seed :8821 (rAF pumped past hidden-tab throttle) — hovering a spawned crew body flips cursor->pointer as its own hit cluster + drew ['PROBE','Lv 7'] via a fillText round-trip; hero plate unchanged (['NOVA','Lv 1']).
- 2026-07-03 agent/update-host -> trunk 848ec418 (test:fast GREEN): GitHub Releases updater endpoint + release-cut/verify-host kit + INSTALL.md; signed-build proof pending SAC-trusted tree
- 2026-07-03 agent/byok-coldstart -> trunk (test:fast GREEN): keyless cold-start fixes - key signup links, model prefill, early model-dock no-key warning, post-awakening key CTA banner
- 2026-07-03 agent/recruiter → 04130ea9 merge(recruiter): adaptive recruitment (worksignal+recruiter+curated shelf/beat+prospects); test:fast GREEN
- 2026-07-03 agent/public-shell -> trunk (test:fast GREEN, docs-only): PRIVACY.md + TERMS.md + download page + launch checklist, all claims code-verified; open swaps = support email + license decision
- 2026-07-03 agent/clip-export -> trunk (test:fast GREEN): P2.2 clip export - auto-armed ring buffer + in-page GIF89a encoder + recap-card button, live-verified real GIF, honest overlay (no XP delta)
- 2026-07-03 agent/couch-backside → 8dad4503 — couch redrawn as sofa BACK (faces TV/north) + sitter y-sort flip; test:fast green
- 2026-07-03 agent/comms-reply-name -> 8c723efd (merged onto ffffaf53): COMMS reply name chip follows the selected agent (load() re-resolves speaker name via App.agentName) - fixes chip showing overseer after switching agents; test:fast GREEN, live-verified on dev seed :8835
- 2026-07-03 agent/diagnostics -> trunk (test:fast+test:http GREEN): COPY DIAGNOSTICS - token-gated /api/diagnostics, secret-free block (8-secret leak test), SETTINGS button + error-chip affordance, ANDREW_SUPPORT_EMAIL single-constant swap
- 2026-07-04 agent/retention-p3 -> trunk (test:fast GREEN): P3.1 re-summon beat (bottle mutual-exclusion, defer-not-stack, dismiss=stop-forever) + P3.2 crew XP cost-proportional split (no-proof-no-credit)
- 2026-07-04 merge: agent/workshop-keep-fix -> feat/harness-backend (70ca0009) — keep-decision retires pending (card-resurrection fix, caught by attended live-LLM shift proof); gates test:fast + test:http GREEN. Live away-build proof: real haiku shift built rename_by_date CLI (2 files, $0.05), manifest honest notVerified, keep copied 2 files + pending emptied.
- 2026-07-04 agent/widget-rails -> 17637e59: WIDGET RAILS — pinnable read-only telemetry instruments in the chrome dead space (topbar+bottombar middles): RUNS·24H/QUEUE/ROUTINES/TOKENS, drag-between-rails w/ caret, + popover, hover ✕, own localStorage key, never emits; test:fast GREEN (incl. new widgets.test.js), live-verified on dev seed :8818 (rails/drag/persist/reload/honest-— DOM round-trips; 0×0-viewport gotcha hit, re-verified at 1440×900)
- 2026-07-04 merge: agent/workshop-retry-cap -> feat/harness-backend (baee7a16) — retry cap parks twice-failed build items (token-leak guard); gates test:fast + test:http GREEN.
- 2026-07-04 merge(ux-hints): Lane P hint/glossary tooltip layer + ArmConfirm helper -> trunk cc93f0b1; test:fast green (full suite)
- 2026-07-04 merge(ux-recruit-doors): Lane D recruitment bay UX doors (dismiss confirm, kit blurbs, de-jargon, truthful summon copy) -> trunk b71b780a; test:fast green; 19/19 CDP checks in-lane
- 2026-07-04 merge(ux-error-doors): Lane A error doors (capdenied->REFIT w/ named capability, auth key buttons, modelpicker door, Diag.showBlock) -> trunk 78708c8f; test:fast green; chat.js adoption pending in Lane B
- 2026-07-04 merge(ux-settings-truth): Lane C settings truth (key-save names real store, inline provider key entry, budget source badges) -> trunk bc535e8a; test:fast + test:http green
- 2026-07-04 merge(ux-first-run): Lane E first-run honesty (diegetic no-key beat, desk-placement chip, key overwrite guard, interview N/M) -> trunk 2479e4ae; test:fast green; slices 1/2 found already shipped, slice 5 premise stale (not built)
- 2026-07-04 merge(ux-away-honesty): Lane F away/routines honesty (scheduler-truth arm lines, grant-stall surfacing, tz-honest cadence, cron tz) -> trunk 2d2bb197; test:fast + test:http green; AUDIT CORRECTIONS: routines gate on scheduler not autonomy; /build-away grant-off = silent success-stall; away shift = every-6h while station UP
- 2026-07-04 merge(ux-settings-truth follow-up): routine tz + honest grant copy + openTerm(key,section) -> trunk 0b93a3ec; test:fast green; error-door section routing now active end-to-end
- 2026-07-04 merge(launch-blockers): /api/run failure envelope (500 JSON pre-stream, agent.run.error mid-stream; runroute.js + 13-assertion test) + PRIVACY support email filled + release/ gitignored -> trunk 4ff3d879; test:fast + test:http green; thronglets_unity.html deleted (untracked); OpenRouter dev-key rotation = Andrew manual
- 2026-07-04 merge(email-swap): every ANDREW_SUPPORT_EMAIL placeholder swapped for real support address (diagnostics.js constant, stationui fallback, TERMS.md, DOWNLOAD_PAGE.md) -> trunk a8af0fe7; test:fast green; live-verified Diag.SUPPORT_EMAIL on :8848 seed
- 2026-07-04 merge(floor-palette): DECK PAINT palette 7->16 floor styles — 7 spectrum hues (ember/amber/moss/teal/indigo/violet/orchid) + 2 value poles (bone near-white #e7e3d9, onyx near-black #0e0e12) in FLOOR_STYLES -> trunk 6e03912d; test:fast green (worldmodel 193); hotfile node --check + symbol-uniqueness clean; live CDP-verified: 16 swatches render pixel-perfect + painting a room flips the deck white/black (bone +102k bright px, onyx +227k dark px), 0 console errors
- 2026-07-04 merge(ux-run-truth): Lane B run truth (approval-pause card, beat counter, open-folder deliverables, return card v2, quest dismiss confirm, crash honesty) + all cross-lane adoptions -> trunk 81023b47; test:fast + test:http green. WAVE 1 OF UX_FIX_PLAN_2026-07-04 COMPLETE (7/7 lanes merged).
- 2026-07-04 merge(north-star): adaptive understanding engine — understanding.js per-dim confidence (provenance × recency-decay × signed corroboration) + VOI curiosity targeting + COMMANDER meter honest read + R2 ratings→style confidence (rateWork direct hand-off, clamped ±6, persisted) + R3 stale-belief suggestion probes (probeTarget <0.45 → aimed idea, accept/decline = ±evidence; realizes P4 drift) + R4 briefing receipts at both dossier commit sites + R1 self-retiring mid-task preference forks (FORK marker → chips → banked commander belief → continuation; directive rides only while style conf low, prompt recomposes on gate flip) -> trunk 3f88bc9b (ff); test:fast green on branch AND trunk; live-verified on :8133 incl. attended live-LLM session (Sonnet 5 emitted the FORK marker on attempt 5 after directive tuning — worked example was the unlock; full chip→bank→receipt→continue→gate-retire chain proven with real inference)
- 2026-07-04 agent/widget-feed -> 7b44f33e: WIDGET RAILS Phase 2 — agent-fed instruments: widget.set tool (notebook/memory grant, redact-at-write, 12-cap, clear) + durable station.widgets.json + GET /api/widgets poll (frozen events contract untouched) + feed:* rail widgets w/ provenance LAW (gold dot, 'name · age', honest no-signal) + ticker form for lists; gates test:fast + test:http GREEN (branch AND trunk); live-verified on dev seed :8821 incl. sidecar-restart persistence round-trip + reload + ticker cycling; NOT verified: an end-to-end live-LLM run calling widget.set (keyless seed)
- 2026-07-04 agent/harden-p0 -> trunk b33ac976 : 6 P0 robustness fixes (includeUsage, halt coverage, rAF guard, errno wipe, readBody UTF-8, loop-guard sig); test:fast + test:http green
