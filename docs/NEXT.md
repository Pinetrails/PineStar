# NEXT.md — current priorities & task queue

**The one moving file.** Update it when you land or invalidate an item; don't write a new
plan doc. Reconciled against trunk `feat/harness-backend` + git log on **2026-07-06 (late night, trunk 7cb221ed)**.
Verification key: ✅ = grep/log-verified today · ❓ = doc claim, re-verify before building.

## Already DONE — do not rebuild (merged 2026-07-05..06)

Release train v0.2.0→v0.2.2 (4-platform signed draft, runbook, gate-after-bump);
polish-sprint lanes **8/8 MERGED** (lane 8 truth-chrome-instruments landed 8e8e6eef while
this file was being written): ux-topbar-disconnect, ux-popup-escape,
voice-button-reliability, truth-run-lifecycle, truth-channel-tee, truth-props-glow,
dossier-agent-mgmt (DELETE AGENT + CHANGE SKIN); update-safety P0.1 wv-cache-purge,
P0.2 mirror-truth, P1.1+P1.2 roster-honesty; voice-desktop-key; comms-fresh-session;
multiplatform install docs. ✅ (all in git log)

## P0 — code: ALL LANDED 2026-07-06 night ✅ (do not rebuild — verify in log/code)

The entire P0-code list from the evening reconcile merged during the update-safety /
audit-fix night wave:

1. Forward-version save guard — LANDED; `save.js` now refuses `doc.version > CURRENT`,
   leaves the doc untouched, reports `{status:'future'}` to boot. (P0.3) ✅ code-verified.
2. Frontend token leak — LANDED a17cb6b3; `X-StarNet-Token` scoped same-origin `/api` only
   (GROUND_UP 0.6) ✅ code-verified.
3. `agent.tool_call` double-emit — LANDED d9a79c6c; chat.js synthetic re-emit dropped
   (GROUND_UP 0.4) ✅.
4. + 5. Sidecar spawn failure + workspace-migration resurrect — LANDED e19aaa21
   "three Tauri-shell data-safety fixes (audit 0.1/0.2/P2)" ✅ log-verified (code ❓ —
   spot-check main.rs if touching that area). Workshop CSP (0.3) also landed efd22244
   (opaque-origin sandbox) ✅.

Also landed the same night from the old P1 list: plaintext BYOK provider key → keychain
(03b07b0d), channel-hub runs in `runsMeta`/snapshot (f9d59968 + e19aaa21 test), approvalMode
persisted (fe3fef98), schema provenance / `git describe` stamp (711f42da, P1.5+P2.1+P2.2),
STT key off the query string (623202af), dirstat fs-jail (f9007c4d), deliverable blob-URL
leak (0cccce2d), VT323 shipped locally (01570f17).

## P0 — Andrew only (nothing above matters to the public until these)

- Publish `starnet-releases` repo (public updater currently 404s) + rescope RELEASES_TOKEN.
- Back up `~/.tauri/starnet-updater.key` to ≥2 offline locations (single point of total loss).
- Rotate the dev OpenRouter key; support email swap.
- **Attended 15-min playtest** (`docs/PLAYTEST_SCRIPT_GATE5.md`) — dodged since 7/02.
- Then per `docs/ROADMAP_2026-07-04_BRUTAL.md`: 10 outside installs; days 8–30 = code-signing
  identity + weekly release cadence; days 31–90 = managed-key starter credits (one SKU).

## P1 — what actually remains open (post-night-wave reconcile)

- **Prompt-injection via auto-granted `team.*` caps** — genuine product fork, needs Andrew
  (see Parked decisions). This is now the ONLY surviving item from the old P1 list — the
  rest landed (see DONE above; P1.3 flush ad8b8b5a, P1.4 parity gate a1a60967 ✅).
- Branch triage below is now the main code queue, plus the P2 hygiene list in
  `docs/GROUND_UP_AUDIT_2026-07-06.md` — do not copy it here.

## Branch triage — EXECUTED 2026-07-06 night ✅ (content-verified per branch, then deleted or parked)

**Deleted (13 unmerged — content proven in trunk or superseded; SHAs recoverable from
reflog ~30 days):** commission-redux 9f8cf7c2 (cherry-equiv in trunk) · cron-staylive
d30dfdd0 (KeepAwake + watchdog in main.rs) · honest-states f1011fe0 (launch.json chore
only) · messaging-platforms 16a0fadd (superseded by MCP connector catalog) ·
starnet-api-gate e4a6fd28 (landed as 9574cb74) · cortex-hermes-plus 80583d9a
(memory-store/transcript/recall/skills all in trunk; its provider abstraction was
abandoned) · hermes-parity-loop 8879b646 (42 commits of proof-plumbing superseded by
release-train + t0–t5) · starnet-hardening-5-6-memory-consent 87b04cd7 +
starnet-memory-consent 3b1470b1 (durable todo: keys + test in trunk) · starnet-memory-loop
bb9369a3 (declined: store in trunk) · quick-model-selector 8a40ddd1 (modeldock + reasoning
efforts in openrouter.js) · starnet-tests-tauri cbb155b9 (landed as 4c8b0f98) ·
workstreams-sessions-ui 9ae72942 (23-line net change, rail evolved past it).

**Also torn down: 10 already-MERGED branches + worktrees** (byok-coldstart,
connector-catalog, secrets-keychain, update-host clean; comms-picker, honest-errors,
retention-p3, ux-hints, cron-visibility-plan, prop-upgrade had only launch-config/QA-artifact
dirt — cron plan doc salvaged to docs/archive/).

**KEPT — real value, in priority order:**
1. ~~`agent/belt-reclaim`~~ **MERGED 2026-07-06 ~23:59** (gate green, 260 steps, in the
   synced worktree). Live-app check of drag-clear NOT yet done — next session: RECLAIM
   mode, drag across a belt run, confirm one-undo-slot removal. Worktree teardown pending.
2. `agent/growth-t4` (ac7bf9f5) — T4 beat-balance pass (516 lines: prioritized ask stream,
   no-double-beats proof, beat-audit script + 201-line test) **plus ~411 lines UNCOMMITTED
   in its worktree** (iteration from 7/02). Needs its author-lane to finish or an explicit
   decision to adopt/discard the dirty work. Do NOT tear down.
3. `agent/parity-finish` (1c203a50) — code all landed (fs.patch, V4A parser, mcp stdio),
   but the branch carries far richer tests (549-line fs.patch.test vs trunk's 131).
   Harvest-tests task: port the extra cases against trunk's stricter parser, then delete.
4. `agent/ui-number-format` (4af14e29) — canonical U.usd/U.tokens exist in util.js but
   dupes remain (clip.js fmtUsd, etc.). Low-risk consolidation refactor; low priority.

**Merged-but-DIRTY worktrees left in place** (real uncommitted code deltas — inspect
before any teardown; `-Force` discards): auto-memory, bug-patterns, connector-spine (50
files!), hermes-settings-audit, live-polish, mac-linux-support (23), meeseeks-subagents,
skins (14), starnet-build-skills-crop, starnet-security-check, starnet-spend-model-honesty,
truth-chrome-instruments (tonight's; its orchestrator tears down).
Rule stands: land it or delete it — an unmerged branch is a claim nobody verified.

## DONE 2026-07-07 — timeout + task board fixes (Fable session) ✅

- **provider-connect-timeout** MERGED 46e1cf22: `connectSignal` passed
  `AbortSignal.timeout(30s)` to fetch, which aborts the RESPONSE BODY mid-stream — any turn
  streaming >30s died with "The operation was aborted due to timeout" (killed Andrew's
  tetris run, codex/gpt-5.5). Fixed: `timeouts.connectGuard` (timer disarmed at headers),
  adopted in all 5 adapters; idle watchdog default 120s→300s (env knob kept); regression
  tests (stream-past-connect-window survives, connect expiry = retryable 'timeout', user
  cancel = AbortError). Gate green fast+http. NOT live-run-smoked (transport seam, unit+e2e
  proven).
- **taskboard-truth** MERGED 3822e212: board flooded with every session in IN PROGRESS
  forever. Fixed: `kind: task|chat` on workstreams (board-add/recipe/goal//background =
  task; summon/chat/cron sessions = chat, off the board); legacy saves inferred by lane
  (todo/shipped→task, active→chat — old session flood self-clears); truthful RUNNING /
  DONE—REVIEW & SHIP chip on active cards via Channels.isBusy. SHIP stays human-only.
  Live DOM round-trip NOT done (predicate proven against real module + dev seed).
- Discovered in passing: sidecar/loop.js has a stray NUL byte (~offset 32377) — git/grep
  treat it as BINARY. Fix queued as a spawned task (byte-strip only, semantics untouched).

## DONE 2026-07-07 — SKILLS panel legibility (Fable session) ✅

- **skills-legibility MERGED 9b2c22a4**: the library read as broken ("can't enable
  anything") — 36/38 recipes OFF on a fresh station, ◉/○ glyph didn't read as a switch,
  enabling a gear-gated skill just changed text to "● ON · needs CABINET" with no path to
  a cabinet. Shipped: real ON/OFF pill switch; user-choice vs floor-grant rendered as TWO
  visuals (switch + READY/NEEDS GEAR chip, combined string deleted); `→ PLACE <OBJECT>`
  deep-link that opens REFIT with the prop pre-selected; library regrouped READY→NEEDS
  GEAR→OFF (category = inline tag); `OBJECT AT DESK → CAPABILITY → SKILL` strip +
  capability locked copy now "○ NO DISH AT DESK"; all 5 no-gear recipes default-on
  (catalog ceiling — only 5 empty-`requires` recipes exist, not ~12). Gates fast(260)+http
  green; live-verified in-lane (switch round-trip, group moves, REFIT palette state).
  ⚠️ compose budget now 11952/12000 chars with defaults — any default-on growth needs the
  pinned test (`skills.library.test.js` asserts default⇒gear-free) revisited.
- Guardian P1 `6feab179` (J2b run-survives-close "regression" at 00538abd) triaged at
  merge-gate: 2× `qa:journeys --only J2` on merged trunk = 38/38 PASS. Flake in the
  15×120ms busy-poll window, dismissed with evidence in the finding.

## DONE 2026-07-07 — Station Atlas: the perfection loop (Fable session) ✅

- **Station Atlas MERGED 00538abd** (gate 261 green in-lane AND on merged trunk): the
  goal+loop system for perfecting every surface element. `qa/atlas/` sharded registry
  (every UI control / slash command / API route / bus event / shoot state gets a dossier:
  purpose · promise · wiring · coverage · status), `scripts/qa/cartographer.mjs` mapper
  (sweep enumerates the REAL surface — 1059 live DOM elements across all 16 states + 40
  cmds / 114 routes / 60 events — diffs vs registry, skeletons new, flags missing, files
  deduped P2s; no-fake-green exit 2 on BLOCKED; ports 8920-8929/9320-9329),
  `loops/perfectionist.md` judgment loop (7-point rubric: purpose/promise/works/truthful/
  discoverable/polished/covered; sessions judge, fixes route to feature lanes; staleness
  via git re-queues perfected entries whose wiring files moved). Goal gauge =
  `npm run qa:atlas:status` (PERFECTED-fresh X/Y).
- **Live-proven same session:** trunk re-sweep after the parallel skills-legibility merge
  caught the drift unassisted — created 94 / missing 51 → the mapper detects surface
  change with zero human eyes (39b9c569).
- **Guardian collision diagnosed + routed:** 07:21Z RED (finding 69eff742) = hourly task ×
  watch session overlapping on shared pin/ports; clean re-run all-5-gates GREEN; finding
  routed; guardian-lockfile fix lane spawned (chip). QA_STATION §2 "overlap harmlessly"
  claim is FALSE physically — lock lane updates it.

## QA Escape Loop — standing directive (added 2026-07-07, Fable session)

**Why:** Andrew keeps finding bugs that audits called "up to par." Diagnosed causes:
(1) the QA Station (`qa/QA_STATION.md`) was built 7/01, movie-tested green, and **never
activated** — Guardian last ran 7/03 while ~40 lanes merged unwatched (first re-run 7/07
immediately went RED on 7 stale-baseline golden findings; triaged + re-blessed 79016922);
(2) station coverage is **static/seeded/happy-path** while Andrew's bugs are **dynamic seam
bugs** — sim↔UI↔task-truth diverging *during* real use (taskboard flood, >30s stream abort,
features breaking under interruption); (3) nothing converts an Andrew-found bug into
permanent machine coverage, so coverage never converges on his bug distribution.

**The law (EL-3, mirror into skills when EL-1 lands):** *an escape is a coverage gap, not
just a bug.* Every bug Andrew reports: BEFORE the fix merges, the lane must land a failing
journey/audit assertion that reproduces it — or a ledger KNOWN entry naming why it can't be
automated. Merge ritual gains the question "which journey/assertion covers this feature's
promise?" (sibling of "where's its UI?").

**Queue:**
- **EL-0 · Activate the watch** — ✅ DONE 2026-07-07 (Andrew-approved): 3 scheduled tasks
  registered (`StarNet-QA-Guardian-Hourly` / `Beginner-Daily` / `Janitor-Weekly`, verified
  via schtasks) + session `qa:guardian:watch` running. STILL OPEN: the Overseer `/loop`
  session (QA_STATION §6, the digest+P0-notify half) and a reboot-surviving per-merge watch.
- **EL-1 · Journey Corps** — ✅ MERGED 2026-07-07 (44a513e7, gate 260 green; orchestrator
  live-ran qa:journeys on merged trunk 114/114 PASS). `npm run qa:journeys` = J1 task-
  lifecycle+taskboard truth · J2 E-STOP/panel-close/reload interrupt honesty · J3 double-
  send/rapid-toggle · J4 summon→deliverable→OPEN serve contract · J5 parityCheck sweep;
  Guardian 5th gate (8943/9343). Known limits: mock-provider boundary (proves seams not
  model output); J4 asserts the serve contract over HTTP, not a real tab-nav.
- **EL-2 · Saboteur mutators** — adversarial twist layer over journeys (garbage input, rapid
  panel toggles mid-run, provider-error injection). After EL-1.
- **EL-4 · Installed-app weekly smoke** — CDP-attach to the installed exe and run the parity
  sweep there; the dev sidecar can never see the WebView2-cache class. Session task, weekly.

## Atlas — Perfectionist area claims (one session, one area)

The Station Atlas (`qa/atlas/`) is a registry of every surface element; Perfectionist sessions
(`loops/perfectionist.md`) drive each to `perfected`. **Concurrency law** (`docs/MISTAKES.md` #4 +
`qa/atlas/README.md`): one session claims one area at a time. Before working an area, claim it here
as `IN PROGRESS — <lane> · <area>`; release it (delete the line) when the batch commits. Never work
an area another session has claimed. Priority: escapes-adjacent first, then
`system → crew → work → build → world → commands → routes → events`; stale before unmapped.

Gauge: `npm run qa:atlas:status`. Trunk re-sweep 2026-07-07 (39b9c569): **1339 entries, 0 perfected**
(1288 unmapped queue + 51 missing from the skills-legibility redesign — P2s filed, dedup holds).
The whole surface is the queue. Areas: system, crew, work, build, world, commands, routes, events, props.

_Active claims: (none)._

_Wave-2 DONE 2026-07-07 (3 lanes merged + gated + reaped; **gauge 45/1288 (3%)** + 32 audited):
system +11P/+3A (get-a-key gap a48393ca) · work +3P/+13A/+4M (UI-seam gaps e74ea483,
5c6adcaa) · crew +16P/+1A (DELETE AGENT uncovered 0e475aad). All blockers chipped.
Next wave: world remainder (438 unmapped) · crew remainder (92) · commands/routes/events._

_Wave-1 DONE 2026-07-07 (both lanes merged + reaped, gate 261 green each merge):_
- _build: pruned 51 redesign-removed · 13 SKILLS controls audited (blocked from perfected
  only by EL-3 coverage gap 11c69e21 → J-skills lane chip)._
- _world: **first 15 PERFECTED** (all 3 #bb-* doors + 12 dock items; live DOM round-trips,
  label==title 14/14, dup-purpose 0) · 2 audited (updates 16193fd0 / quests 161206b5 — no
  UI-open coverage → shoot-states chip). Product findings: **E-STOP undiscoverable**
  (b0f9d09f, Alt+H-only — conservative fix chipped; visible-button restore = Andrew call) ·
  topbar instruments un-enumerated (f0fddb55 → cartographer tooling chip)._
- _Gauge after wave 1: **15/1288 perfected·fresh (1%)** + 15 audited. Queue: 1258 unmapped._

## Table-stakes gap audit 2026-07-07 (Fable session) — missing mini-features, code-verified

Four-surface grep audit (COMMS / sessions / global-desktop / harness). Each item below was
verified MISSING or slash-only on trunk 626c017f before listing. Claim an item here before
building it (same law as Atlas areas).

**T1 — chat core (COMMS), daily pain:**
- GA-1 Attachments: ALREADY BUILT on `agent/comms-attach` d9f7d9c7 (unmerged) — MERGE, don't rebuild.
- GA-2 Markdown/code-block rendering + per-code-block copy (renderProse = escape+linkify only; chat.js:314-333).
- GA-3 Edit-and-resend a user message; RETRY as a visible button (exists as /retry only, chat.js:2841).
- GA-4 Input history (up-arrow) + per-session draft persistence (input clears on send, chat.js:417).
- GA-5 Unread badge when COMMS closed / other session active (pill only while scrolled-up in open panel).
- GA-6 Search: session list filter AND in-conversation search (both absent).
- GA-7 Export/copy whole conversation; clear-conversation (per-message copy only).

**T2 — engine-without-UI (violates "where's its UI?" law):**
- GA-8 MCP connector status panel (manager.js emits connector.state; nothing renders it).
- GA-9 Cron/routines UI: next-run, last result, pause (cron-driver full; no surface).
- GA-10 Per-session/per-agent spend readout (workstreams track {tokens,usd,calls}; never displayed).
- GA-11 Provider rate-limit/quota rejection surfaced as friendly error (currently generic).
- GA-12 Steer-while-running button on the presence card (/steer works end-to-end, slash-only).

**T3 — desktop table stakes:**
- GA-13 OS-level (Tauri) notification on background task finish (in-app toast only).
- GA-14 UI zoom / font-size setting.
- GA-15 Tauri window size/position persistence across launches (not in main.rs).
- GA-16 DOM windows not resizable (drag+minimize only).
- GA-17 Replay tour / in-app help re-entry after onboarding; keyboard cheat-sheet overlay.
- GA-18 Settings: clear-all-data + data-location display.

**T4 — harness power features (lower urgency):**
- GA-19 Files-touched summary / diff preview before fs changes apply.
- GA-20 Attach context from UI (point agent at file/folder) — pairs with GA-1.
- GA-21 Prompt templates / quick replies.
- GA-22 Bulk session ops (clear completed, archive old).

**Round 2 (GB) — six deeper audits 2026-07-07: world, REFIT/workshop, skills/routines/voice,
lifecycle, micro-UX, journey-walk. Corrections applied: CHANNELS window EXISTS
(stationui.js:3360-3488 TG+Discord+health), ROUTINES console EXISTS (#rt-add/#rt-arm/run-now);
E-STOP visibility + get-a-key link already chipped by Atlas — not re-listed.**

*GB-T1 — highest pain:*
- GB-1 Transcript SEARCH UI: BM25 search already in transcriptstore.js:81 — zero frontend. One
  search box over all conversations. (Absorbs GA-6.)
- GB-2 Deliverables LIBRARY: browse/search ALL past outputs (returns.js caps at 8/24 pending;
  no archive view, no re-open old runs).
- GB-3 RECORDING MODE: one toggle hiding keys/spend/PII for screen capture (zero code; GTM —
  spectacle is the growth engine and Andrew records constantly).
- GB-4 Quit/update-while-running guards: no "N agents still working" on close (beforeunload
  saves only); updater installs over live runs (main.rs:1418).
- GB-5 Crew bodies: pointer cursor but click falls through (world.js:720 hero-only) — click →
  quick actions (talk/dossier/locate); plus click-roster-name → camera jump to agent.
- GB-6 Prop hover tooltips (name + grants) — belts have tags (world.js:4080), props silent.
- GB-7 Needs-input triage: no roll-up of runs blocked on permission prompts across sessions
  (board shows RUNNING/DONE only; a stuck approval in a background stream is invisible).
- GB-8 "Resume/restore" discoverability: /restore + /resume slash-only; no UI on old sessions.

*GB-T2 — truthful-telemetry violations (backend knows, UI never shows):*
- GB-9 workspaceDegraded flag set (index.js:796) but never rendered — user unaware workspace
  is newer than app.
- GB-10 Disk-write failures fail-open silently (grants degrade to deny on ENOSPC, no surface).
- GB-11 Guardian sidecar respawn is silent — no "connection recovered" toast.
- GB-12 Skill last-fired/last-result never shown ("is this skill even used?").
- GB-13 Routine fire HISTORY absent + timezone mislabel (server ISO labeled "local",
  stationui.js:4168).
- GB-14 Per-run cost breakdown (in/out tokens, per-tool) — totals only.

*GB-T3 — build/world/workshop QoL:*
- GB-15 Prop palette search/filter + per-category counts (build.js:255-280).
- GB-16 Copy/duplicate placed prop; multi-select/bulk ops in REFIT.
- GB-17 Camera: reset/fit + follow exist in code (world.js:812,925) — expose UI + keyboard
  (+/-/F/arrows); mute-all quick toggle in chrome.
- GB-18 Workshop bulk cleanup UI (janitor sees 106 rot findings; user has per-card Discard only).
- GB-19 Inline preview for image/md/csv deliverables (html-only today).
- GB-20 Station layout blueprints (save/share/load layout templates).

*GB-T4 — micro-UX & hygiene:*
- GB-21 Focus trap + focus-restore in modal windows (aria-modal set, no trap; stationui.js:115).
- GB-22 Empty-input guards on create/rename (empty routine name → raw 400).
- GB-23 Copy buttons on ids/paths/tokens beyond diagnostics.
- GB-24 Goal abandon button + quest dismiss beyond dossier-kind (queststate.js:88 gates).
- GB-25 Voice: level indicator while listening, per-agent voice preview, STT language picker.
- GB-26 Automated periodic backup + backup-before-update (manual export only).
- GB-27 .bugloops unbounded (395MB/2066 files) — TTL sweep.
- GB-28 Multi-agent status dashboard (which of N agents stuck/failed/done — superset of GB-7).

## Parked product decisions (need Andrew, don't guess)

- `fullOffice()` autonomous prop placement vs. hand-placed only.
- localLine slash-command restyle; focusAgent global-model overwrite semantics.
- Prompt-injection stance on auto-granted `team.*` (see P1).

## Session handoff format

End every substantive session by:
1. Updating THIS file (move landed items to DONE with the merge hash, add discoveries).
2. If you merged to trunk: the `starnet-merge-ritual` digest in `qa/` (existing convention).
3. A 3-line summary in your final report: **Landed** (verified how) / **Open** (what you
   did NOT verify) / **Next** (the single highest-leverage follow-up).
Do not create new `*_PLAN.md` files for work under ~a week; use this queue.
