# NEXT.md — current priorities & task queue

## 2026-07-16 — CLASS ROSTER REDESIGN LANDED (agent-class-redesign lane)

The recruit catalog is now 12 SPECIALIZED business-grade builtins (strategist · researcher ·
engineer · analyst · marketer · publisher · producer · scriptwright · prospector · envoy ·
treasurer · scout) + 17 archetypes (8 demoted generalists, 6 kept deep cuts, 3 new long-tail
seeds: closer/steward/optimizer). liaison/publicist/bookkeeper RETIRED (superseded by envoy /
marketer+publisher / treasurer). Typed-ASCII class marks REMOVED — the engraved SVG coin seal is
the one emblem system again. Scout matchArchetype now coverage-scores (majority-token rule);
prospect directive demands specialized roles. 7 new kit-grounded skills. W0 re-stamped in-branch.
Open follow-ups: regenerate qa/atlas crew evidence (stale "18 builtins" notes); consider a
first-run default-class experiment (strategist is now the bay's default card).

## 2026-07-15 — POWER-USER DEEP-DIVE AUDIT (3 isolated agents, no fixes)

Full evidence and repros: `docs/POWERUSER_AUDIT_2026-07-15.md`. Baseline gates were green
(`test:fast` 328 steps, full `test:http`, `qa:journeys` 123/123), but live adversarial use
confirmed **14 new defects: 4 P1 · 8 P2 · 2 P3**. Highest priority:

**Fix execution plan (2026-07-16):** `docs/POWERUSER_FIX_PLAN_2026-07-16.md` — four waves,
EL-3 reproduction per defect, serialized `index.js` / `stationui.js` / `chat.js` ownership,
live restart criteria, composed gates, and a final installed-app proof. Wave 4D (tray-supervised
background lifecycle) remains an explicit owner decision checkpoint; the plan recommends opt-in
launch-at-login plus visible tray ownership, never a hidden daemon.

**2026-07-16 (late) — ALL 14 PU FINDINGS RE-VERIFIED FIXED AT TRUNK `f2c6d92a`** (post-merge-review
lane; 5-agent code-verification sweep with file:line evidence). The plan above was written at
baseline `bf99df2a`; the subsequent power-user loop repairs merge (`8ce4c967`), the summon-naming
lane, the nightfocus validator, and the Task Brief chat.js waves closed every seam. Each has a
dedicated regression test on trunk:

- [x] **PU-03 P1:** backup.js `isCredentialKey` denylist (default-deny `starnet.byok.*`), export
      `secretsIncluded:false`, import guard. — [x] **PU-01 P1:** `validateNightFocusSteer`
      (index.js ~8368): 404 missing path, 403 unblessed, thread/goal checked; nothing persists on
      reject. — [x] **PU-02 P1:** disabled connectors are durable management rows (boot registers
      all, list merges, EL-3 restart test in e2e.mcp-connector). — [x] **PU-04 P1:**
      `visibleTerminalRect` clamp on drag/restore/resize + repaired coords persisted
      (terminal-resize journey asserts reachability incl. phone viewport).
- [x] **PU-05..PU-12 P2:** clearSteer drops steer-derived focus; Signal ✕ REMOVE CONFIGURATION
      (read-back proven, no token lie); Ollama/custom = LOCAL ENDPOINT CONFIGURED/OFFLINE with
      reachability-gated ACTIVE; `allocName` uniquifies defaults + `[id]` badge on collisions;
      `busyPeerFor` preflight = BUSY IN <session> + VIEW ACTIVE RUN; `formatRunHolderAge` "just
      now"; mid-stream sidecar death classified station-unreachable; `persistPartial` keeps
      streamed text + disconnect marker on both error branches.
- [x] **PU-13..PU-14 P3:** `Workstreams.startSession` reuses the untouched blank; stopped runs
      offer Try again (incl. after reload; clarifying end correctly excluded).

Remaining from this audit: Wave 4D (background lifecycle) = Andrew's product decision; minor
coverage gaps noted in the review lane (route-level test for validateNightFocusSteer; explicit
poisoned-termPos reload assert). EL-3 law applies to any NEW finding. Do not infer station-wide
readiness from the green baseline; Atlas at this head is 444 stale · 123 unmapped · 1 missing.

## IMPLEMENTED 2026-07-16 — TASK-BRIEF RELIABILITY HARDENING (`agent/briefing-reliability`)

The intent layer now has a host-enforced decision boundary before settings are exposed. Structured
`brief.ask` / `brief.proceed` controls validate question quality and settle a compact execution brief;
write/execute tools stay locked until settlement, while read tools remain available for research. The host
enforces the two-question ceiling and second-blocker rule, stops same-batch actions after a question, routes
cancel/pivot/answer replies without contaminating the prior task, resumes terse messaging-channel answers from
durable state, and derives weak relationship patterns only from completed briefs. Internal controls are hidden
from ordinary tool telemetry; the existing natural COMMS chips and numbered channel fallback remain compatible.
Deterministic coverage is expanded to 73 task-intent assertions spanning validation, restart, cancellation,
pivots, completed-only learning, mutation gates, registry control preservation, call pairing, and one-turn pause.

## READY TO MERGE 2026-07-15 — TASK-CONTEXT ELICITATION (`agent/intent-engine`)

StarNet now listens before it builds without turning every request into an interview: a shared
discover-before-ask doctrine; one natural 2–3 choice question only for material, non-discoverable
gaps; a hard two-question task cap; and an explicit “use your judgment” escape. Answers resume the
same durable Task Brief after reload/restart, remain task-local, flow into delegated workers, and only
compound into weak relationship evidence after the same decision is observed twice. COMMS strips the
protocol into chips; Telegram/Discord/Slack/Matrix/Signal use the same continuity with numbered text.
Clarification turns are neutral (no product/XP/First-Pitch/learning sweep); unattended cron/night-shift
runs stay unchanged. Live-proven in the real seeded app: question → reload → restored choices →
“operators” → clean continuation, with `task-briefs.json` recording `status:"done"` and the clean answer.
Gate: 328/328 runnable fast steps green; the sole stop is the documented 9-assertion W0 candidate-SHA
worktree baseline in `qa-product-perfect-claims`; `test:http` fully green (404 sidecar assertions + all e2e).

## 2026-07-15 — v0.5.1 CUT + INSTALLED LOCALLY (trunk `3d70d7b1`, tag `v0.5.1`)

Signed release cut at trunk head (rc/0.5.1 content + docs + real RELEASE_NOTES.md; W0 surface
re-stamped, claims authority PASS). minisign verify OK against the baked pubkey; artifacts staged
in `release/` (StarNet_0.5.1_x64-setup.exe + .sig + latest.json, sha256 75bf43e4…). Installed on
Andrew's machine (registry 0.5.1, exe ProductVersion 0.5.1, app relaunched, sidecar up + token-gated).
- [ ] **Andrew: PUBLISH** — GitHub Release `v0.5.1` on `nonfungiblefunyuns-ship-it/starnet-releases`
      with the three `release/` assets (checklist in the release-cut output); then
      `node scripts/verify-update-host.mjs` + the public update canary.

## 2026-07-16 — RELEASE CANDIDATE PINNED: `rc/0.5.1` @ `503ba26f` (READY + beyond-gate proofs)

`npm run qa:ready` = **READY at `503ba26f`** (2026-07-16 00:41Z; all 5 receipts, W0 wave PASS) and
that exact commit is pinned as branch `rc/0.5.1` + tag `rc/0.5.1-rc.1` — trunk keeps moving (3
sibling merges landed during the pass; freeze-first is the law), the RC pin holds the proven bytes.
Beyond the gate, proven this session (receipts `.bugloops/release-prep-2026-07-15/`):
- **Update canary CLEAN end-to-end**: canary 0.5.0 → 0.5.1 through the REAL machinery — signed
  manifest via release-assemble-manifest, minisign verify against the baked pubkey, NSIS passive
  install with NO node.exe lock hang (the 72dea45a fix holding), installer exited, app relaunched
  as the new version. `release:cut --dry-run` clean; verify-sig wired.
- **Real-provider run on the installed binary**: live OpenRouter run in the installed 0.5.0
  (@503ba26f), went busy, streamed, completed — agent replied RELEASE-CHECK-OK.
- **Installed smoke GREEN v3** (reproducible-source, 9/9), Guardian GREEN (incl. one hourly cycle
  under the real scheduler token proving the shell-machine-state fix), Beginner PASS, journeys
  123/123, golden re-blessed 2× (recruit/messaging + UX-clarity copy drifts, eyeballed).
- Guardian-RED-under-load = KNOWN flake class (spawnSync null / J2 poll windows while cargo builds
  run) — re-run isolated before believing an hourly RED that overlaps builds.
REMAINING, honestly out of this machine's reach:
- [x] **Andrew: attended 15-min playtest** — DONE per Andrew 2026-07-15: "ran perfectly for me as
      a user" (the docs/PLAYTEST_SCRIPT_GATE5.md item dodged since 7/02 is cleared). NOTE: the W1
      WAVE is a separate, stricter proof — attended FRESH-PROFILE first-run on the exact rc binary
      through `scripts/qa/installed-first-run.mjs`, with isolation authority `separate-windows-user`
      / `virtual-machine` / `clean-machine` (this login doesn't qualify). Cheapest honest path on
      this PC: create a second Windows user, install the rc exe there, run the W1 driver attended
      (~15 min). Folds naturally into the 10-outside-installs step otherwise.
- [ ] **Andrew: publish `starnet-releases` + key backups + dev-key rotation**, then the public
      per-platform update canaries; 48h RC soak per docs/RELEASE_READINESS.md.
- [x] Outside installs on other hardware — ATTESTED by Andrew 2026-07-15: installed on a separate
      Windows machine AND a Mac, both "worked perfectly" as a user. This clears the practical
      clean-machine concern; the FORMAL T0/T3.2 gates still want their evidence JSON captured
      during such an install (`STARNET_T0_CLEAN_EVIDENCE` — see scripts/t0-clean-install.mjs) —
      capture it on the next outside install rather than re-doing these.
- [ ] Mac AUTO-UPDATE remains the one unproven mechanism (install ≠ update): one run of
      docs/MAC_UPDATE_TEST.md on that Mac after the next release publishes. The guaranteed manual
      fallback + data-preservation guarantee (1884393f) bound the damage if it fails.

## 2026-07-15 — RELEASE PREP (lane `claude/release-prep-d04205`): qa:ready burn-down

`qa:ready` said NOT READY (4 reasons). This lane's disposition of each:
1. **Ledger P0/P1 → 0 P0 · 1 P1**: F1/F2/F3 flipped `fixed` (all trunk-verified: 6923ed05/73f376fa/
   f488ed11 via eaf36032). **F4 FIXED in this lane** — `/model` now warns against the warmed catalog
   on unknown ids (warn-not-block, empty catalog never warns; test/model-ack-honesty.test.js, 15
   assertions; live-proven: garbage id → warning naming the id + 342-catalog, real id → clean ack;
   receipt `.bugloops/release-prep-2026-07-15/f4-model-warn-live-proof.txt`). Flip F4 `fixed` at merge.
   **F5 REFUTED as a product bug** — in REAL headless Chrome, stage / refit-canvas / #ag-portrait all
   track css across 1280x720→375x812→1280x800→900x1000 (aspectDelta ≤ 0.009). The sweep's distortion
   was the rAF-frozen CDP preview pane, where resize events AND ResizeObserver deliveries never fire
   (proven: freshly-armed RO logged zero on a real viewport change there). Finding dismissed with
   receipts `.bugloops/release-prep-2026-07-15/f5-*.json`.
2. **Guardian RED root cause fixed**: shell-machine-state's Start-Process probe asserted the CHILD's
   exit code, which reads unreliably under the Task-Scheduler batch-logon token — the probe now
   asserts the actual claim (colon form binds FilePath + launches). Next hourly cycle should be green.
3. **Beginner Run stale** — re-run on post-merge trunk (below).
4. **Installed-exe v3 proof** — requires a desktop build whose buildCommit/sourceTree pin the exact
   final trunk head: build + install + `qa:smoke:installed` AFTER this lane merges.


## MERGED 2026-07-15 — SCHEDULER RELIABILITY (lane `claude/starnet-scheduler-audit-1b33c2`, trunk `5dcd3868`)

Four of the six 2026-07-15 scheduler-audit gaps closed in sidecar cron (digest in qa/STATUS.md):
misfire policy (missed daily/cron work fires ONCE by default instead of being discarded —
job.misfire additive/editable), transactional dispatch (launch conditional on a verified durable
advance/claim; failed persist ⇒ defer + retry, never fire-over-unpersisted), generation-fenced
settlement (a zombie-swept run can no longer overwrite its replacement's record), ticker health on
GET /api/cron (lastTickAt/lastSuccessAt/lastTickError/healthy) + durable notification delivery
outcomes (markDelivery; {ok:false} SendResults are real failures). test/cron.dispatch.test.js locks
the launch-integrity guarantees. Live-proven on a real booted sidecar, zero spend.

- [ ] OPEN (audit gap 1, CRITICAL, product-level): routines are not 24/7 — the sidecar dies with
      the desktop process. Needs a supervised background lifecycle (launch-at-login / detached
      sidecar / tray supervisor — Tauri + product decision, Andrew's call on UX).
- [ ] OPEN (audit gap 6b): transient delivery-failure RETRY (outcomes are now recorded; a bounded
      resend on retryable channel errors is the remaining half).
- [ ] OPEN: ROUTINES panel could surface the new health + lastDelivery fields (GA-9 adjacent).


## MERGED 2026-07-15 — VOICE DECOUPLED FROM THE LLM (lane `claude/hermes-voice-system-analysis-910f29`, trunk `dc2c8809` + W0 `e5e60914`)

Voice is now a STATION subsystem (analysis + acceptance bar: docs/HERMES_VOICE_ANALYSIS_2026-07-14.md).
Shipped: sidecar/edgetts.js zero-dep FREE KEYLESS Edge neural floor in /api/tts (keyed chain →
edge → 200 {fallback}); /api/stt dedicated ASR (Groq whisper-large-v3-turbo → whisper-1 →
chat-model); frontend neural-only (robotic speechSynthesis path DELETED — degrade = silence +
speaker tooltip; 'no key' latch → 60s cold-off). Live-proven keyless end-to-end (real Edge MP3
through the real page, play() resolved). Installed exe picks this up at the next build cut.

- [ ] OPEN: local-ASR floor for desktop Anthropic-only stations (sherpa-onnx-node / whisper.cpp
      spike; the last acceptance-bar gap — browser stations have webSpeech, desktop keyless STT doesn't).
- [ ] OPEN: Edge-voice audition vs Algenib (en-US-ChristopherNeural chosen as nearest bass;
      Andrew's ear decides; swap via SKYNET_EDGE_TTS_VOICE).
- [ ] OPEN: V-ACK (spoken ack on first tool call from the prewarmed cache + ducking), V-HYGIENE
      (VAD confirm stage, quiet-take discard, hallucination filter, single chunker), V-PROSODY
      (taste-gated) — ranked in the analysis doc.

## 2026-07-15 — PROVIDER COMPATIBILITY (lane `claude/starnet-provider-compatibility-24131e`, MERGED `29fa54e2`)

The "all providers properly compatible?" audit's four concrete wire risks are FIXED on the shared
openai-compatible seam (digest in qa/STATUS.md): reasoning_effort reaches the wire (was silently
dropped); unsupported-param self-heal (400/422 naming an optional param → strip + retry, per-model
memo; `tools` NEVER silently dropped); Perplexity `supportsTools:false` from the profile → task runs
refuse up front; xAI `usage.cost_in_usd_ticks` normalized in cost.js (REAL field, 1 USD = 1e10 ticks).
Capability facts sourced from official provider docs 2026-07 (registry.js wire hints carry citations).
- [x] **Certification HARNESS shipped + first real-key PASS** (2026-07-15, same lane):
      `npm run certify:providers` (scripts/provider-certify.mjs) proves the wire seam live per
      provider — models → streamed chat → tool round-trip → mid-stream cancel → cost reconcile.
      Keys ONLY from the registry-documented env names; no credential = honest SKIP env-blocked;
      receipts land in gitignored `.dogfood/provider-certify/`. **OpenRouter: PASS all five steps
      against the live endpoint** (343 models, streamed "OK" w/ usage, starnet_ping tool call
      finish=tool_calls, clean abort, provider-reported cost reconciled).
- [ ] **REAL-KEY runs for the other 12 keyed providers** — needs Andrew to export the documented
      env keys (or drop them where the app stores creds) and run `npm run certify:providers`;
      the harness does the rest. Codex certifies via the live app (OAuth), Ollama when a local
      daemon is up. Restart/auth persistence + one autonomous cycle remain APP-level proofs
      (live app + real save), not wire-script scope.
- [x] Perplexity static Sonar roster shipped (same lane): 4 docs-sourced models (2026-07;
      sonar-reasoning removed 2025-12-15) fill the empty-catalog seam — context limits flow to
      compaction, connect screen not empty; deliberately UNPRICED (per-request search fees make
      token-only pricing dishonest).

## 2026-07-14 — COMPREHENSIVE AUDIT ATTACK-ORDER (lane `claude/starnet-audit-80a98c`, Andrew-approved sequence)

Five-agent audit + the approved fix sequence, all lane-committed (digest lands in qa/STATUS.md at merge):
- **QA watch RE-ARMED on the new PC**: `schtasks` had ZERO StarNet tasks (the EL-0 registrations died with
  the old machine). Re-registered via `scripts/qa/register-watch.ps1 -Apply` against the integration tree
  (Guardian-Hourly / Beginner-Daily / Janitor-Weekly, verified in the scheduler) + a fresh manual cycle:
  **GREEN all 6 gates** @ trunk `38818fbc` (guardian-20260715-023723) — replaces the unreproducible
  21-commit-stale RED snapshot whose evidence was gitignored and absent.
- **Stranded-work rescue commits**: meeseeks sprite layer (`7091cabd` on agent/meeseeks-subagents) and
  growth-t4 anti-nag iteration (`d4a75a6f` on agent/growth-t4) — both existed ONLY as uncommitted diffs;
  `archive/*-rescue-2026-07-14` tags pinned. Their PORT queue items below remain open.
- **Channel-secrets verified persist** (the audit's P1): saveChannelSecrets rides saveJsonVerified
  (read-back proof); connect/sync routes surface `persisted`; disconnect never claims `purged` unproven;
  notify's 500 guard now reachable. EL-3 failing scenario locked in channels.secrets.test.
- **Last-hop surfaces**: BUDGET pool-cap RESUME (/api/budget/resume) · NIGHT SHIFT FOCUS + STEER
  (live-DOM round-trips proven: steer set/clear, marker rides the LIVE steered bit) · AUTONOMY LIVE
  HELPERS + STOP (/api/subagents/interrupt) · world.js pollFeedState reads bulk /api/channels/status
  (slack/matrix/signal-only floors no longer falsely nagged NO FEED).
- **team.dispatch/team.spawn now consent-gated** (closes the parked P1 prompt-injection fork; Andrew
  approved via the audit attack-order): APPROVAL beat in 'ask' mode, Full Access bypasses — summon parity;
  registry + tool defs flipped together, test-locked (orchestration 116).
- **W0/pp branch-mass verdict (NON-destructive)**: the ~65-branch W0/pp complex is a LIVE lane, not
  abandonware (`agent/w0-*`/`w1-*` all sit in checked-out worktrees; `agent/pp-*` W2 work = preserved refs
  per the W0 checkpoint below) — left to the w0-claims-verdict lane owner. The 11 self-labeled
  `codex/snapshot-w0-*` / `codex/rejected-w0-*` insurance branches ARE inert: tips pinned under
  `archive/codex/...` tags — safe to delete those branches whenever Andrew signs off (tags keep the SHAs).

STILL OPEN from the audit (unclaimed): codex OAuth refresh token keychain home (the one plaintext-only
credential) · web_fetch/channel-content untrusted-content fence (recall/MCP have one; the highest-volume
input doesn't) · IPC_TOKEN constant-time compare · index.js channel-route dedup (~9× repeated persist
shape) · nightshiftPrecheck fails OPEN on exception (budget gate off on throw) · Cartographer re-sweep +
re-bless (187 perfected all stale; props/events/routes areas never mapped) · fresh installed-exe smoke
stamp for qa:ready · remaining orphaned routes (workshop/shift, nightshift/beat force-fire, config/reset,
execution view, threads-ledger browse).

RE-ARMED-WATCH FALLOUT (found by the watch itself, 2026-07-15 — both are INSTRUMENT-environment, not
product; the same commit passes all suites in interactive shells):
- [ ] **Hourly Guardian RED @ every cycle until fixed**: `test/shell-machine-state.test.js` fails ONLY
      under the Task-Scheduler context ("host accepts safe inline Start-Process -FilePath:cmd.exe form —
      expected 0, got 9"; guardian-20260715-040003, test-fast step 66/325; http-e2e/shoot/golden/audit/
      journeys all green same cycle). Fix = make the suite (or the guardian task's execution context)
      interactive-agnostic; until then the hourly row RED means THIS, not a product regression.
- [ ] **Integration-tree test:fast stalls at the 600s wrapper** right after lint-evidence-secrets
      (reproduced 2× at 70cdc178; the known `.dogfood` bloat). Gate trunk commits in a clean worktree
      FF'd to the same SHA (receipt pattern used for this merge). Real fix = product-perfect lane makes
      the claims step skip-honestly when `.dogfood` is absent + the scanner step bounded.

## 2026-07-14 — ADVERSARIAL SWEEP: interrupt/disconnect seams (branch `agent/adversarial-sweep`)

Fresh-eyes skeptical sweep of the seams happy-path QA is blind to (full ledger with repro steps:
`.bugloops/adversarial-sweep-2026-07-14/LEDGER.md` in the lane worktree; digest in qa/STATUS.md;
P0/P1s in the qa findings ledger, crew `Adversarial`). FIXED in-lane with EL-3 escape tests:
- F1 P0 client disconnect never detected on /api/run (dead `req.on('close')` after readBody —
  Node ≥15 emits it at message completion): ghost runs spent unwatched, mutex held, reloaded UI
  contradicted the harness. All three run routes now use `res.on('close')` (`6923ed05`).
- F2 P0 COMMS `online` asserted forever over a dead sidecar — now folds `World.linkState` →
  `station unreachable` (`73f376fa`).
- F3 P1 idle `/steer` minted a paid run from a steering note — now refuses honestly (`f488ed11`).
OPEN (routed, repros in the ledger):
- F4 P1 `/model` accepts garbage ids with a confident ack — warn-not-block against the warmed
  catalog at the ack seam (slash lane).
- F5 P1 canvas buffers never re-derive on viewport resize; `object-fit:fill` distorts the pixel
  world; `#ag-portrait` renders 88×1 (canvas lane; cheap DOM oracle: css aspect ≈ buffer aspect).
- F6 P2 hero body stays `idle` + stale say while its run streams (crew latch rides run phase,
  hero latch is desk-trip-only — world.js:5060/5077 vs :3027); F7 P2 first summon spawns ON the
  hero tile (3/3); F8 P2 cancelled runs persist `content:""` assistant turns (partial streamed
  text lost from the durable transcript); F9 P2-suspect NIGHT SHIFT trophy minted with zero
  night-shift activity (trophy condition needs reading).
- KNOWN pre-existing: `test/qa-product-perfect-claims.test.js` is ENVIRONMENT-DEPENDENT — red
  (9 fails) in ANY fresh worktree because it needs the integration tree's gitignored `.dogfood`
  candidate state; green in the integration tree (64 assertions). Every lane gating in a clean
  worktree loses the fast-gate tail behind step ~133 — product-perfect lane should make it
  skip-honestly (with a visible SKIPPED note) when `.dogfood` is absent.

## 2026-07-13 — FLAGSHIP WAVE: last-hop surfaces + cross-wiring (branch `claude/flagship-features-audit-d0e1a1`)

Three-agent code audit of the flagship trio (autonomy / quests / recommendations) found the engines
solid and test-locked but the value trapped server-side (the recurring last-hop pattern). Five lanes
shipped and merged to the audit branch (trunk-synced, gates green, in-lane live-DOM proofs; digest in
qa/STATUS.md):
- QUEST V3 surface: DIRECTION card (north star + provenance + confirm/correct), REFRESH QUESTS button,
  visible refresh-outcome ledger. CLOSES the V3 OPEN items "frontend surface" + "north-star CONFIRM
  beat". Slate-full fast path: at OPEN_GENERATED_CAP the cycle skips the model call with an honest note.
- NIGHT SHIFT visibility: dial-raise now speaks an honest outlook (mode + readiness from status);
  unseen-drafts COMMS nudge during live sessions (closes the "drafts pile up unseen" follow-up);
  LAST REPORT re-open. The onboarding-readiness follow-up is addressed at the dial, not the ceremony.
- SCOUT LOG: the attempt ledger finally renders in the recruitment bay (closes "scout-ledger UI" OPEN).
- AUX GOVERNOR: joint budget over the 6 post-run extraction passes (SKYNET_AUX_BUDGET, default 2,
  priority reflection>study>threadmine>scout>skill-review>curator; deferrals visible, cooldowns unarmed).
  Closes the unbudgeted run-end cost risk; the NS-8 full composer remains open (this is the cost half).
- CROSS-WIRE: nightfocus ranks open WORK quests + confirmed north star as focus evidence (consent law:
  unconfirmed proposals never steer autonomy); scout directives cite the quest slate + star (grounded);
  shared declined index (read-side NS-8 lite) — explicit declines suppress re-proposals across ALL
  engines; expiries never suppress.
STILL OPEN after this wave: first real-provider quest-refresh + scout cycles on Andrew's save (runtime
proof, not code); NS-8 full unified composer (extraction consolidation — the declined/cost halves are
done); cold-state → targeted awakening question; thread/trust beat starvation fallback; reflection
auto-save consent posture (deliberate design, revisit on user feedback).

## 2026-07-13 — NIGHT-SHIFT "never does anything" fix (dial-is-the-consent + honesty)

Root cause of "idle for hours, zero autonomous work": at dial free/sandbox every beat silently
degraded to a reason-only draft because the SEPARATE per-agent away-workshop grant was never
recorded (`workshopOf()` false ⇒ `runNightshiftActShift` unreachable), and the cold-start
readiness gate declined every beat for hours with nothing in the UI saying why. Shipped:
- POST /api/autonomy/posture with `buildsUnattended` now records the night-shift agent's grant
  through `workshopStore.grantIfUndecided` (same authority as /api/workshop/grant; an EXPLICIT
  per-agent decision is never overridden; the standalone workshop-shift cron stays opt-in).
- GET /api/nightshift/status adds `workshopGranted` / `buildMode` / `draftReason` / `readiness`
  (dims + recent-run bars); the NIGHT SHIFT panel renders MODE + a "still learning you" line;
  a dial-says-build-but-no-grant degrade is a visible warning AND an autonomy-ledger note.
- Proof: test/nightshift-grant.e2e.test.js (auto-grant, restart round-trip, revoke-wins,
  status honesty) + nightreport/workshop-store unit coverage; live-verified on the dev seed.
OPEN follow-ups: consider surfacing the readiness bars during onboarding (the first idle hours
are still gated cold by design), and a COMMS nudge when drafts pile up unseen.

## BUILT 2026-07-13 — QUEST V3 STANDING REFRESH (branch `claude/starnet-quest-system-25fae6`, `fd8823d8`)

Andrew's report: a live save sat 3 days with an unchanged quest slate and a NEVER-created
`_station.quests.json` — V2 made completion honest but generation passive (agents mint only mid-run,
doctrine bar rarely met). The fix is a standing harness refresh (the scout mint-cycle mold):
- `sidecar/questrefresh.js` (pure) + index.js ambient half: 24h cadence + caught-up fast path (zero
  open ledger quests → refresh after 1h cooldown), 5-min tick + boot catch-up look (desktop sessions
  are short — the 24h mark usually passes while the app is closed).
- Each cycle names the NORTH STAR (Commander's active goal ALWAYS outranks the model's inference),
  then ONE aux model call proposes ≤3 step-quests toward it; parse enforces the contract rule at the
  seam (no `run`, prop keys clamp to placeables, fact keys sweepable, WHY must cite shown evidence,
  dedup vs open slate + denylist); mints ride `questStore.mint` (station-wide `kind:generated`).
- Every outcome in a visible ledger; `GET /api/quests/refresh` = north star + due state + ledger.
  Opt-out `SKYNET_QUEST_REFRESH=0`. Gates green: test:fast, test:http full, new pure suite (45
  assertions) + true e2e (boot→due→mock model→real mints on disk; ungrounded reply rejected, 0 mints).
- W0 claims surface checked: byte-identical (surface locks frontend/docs only; no sidecar paths).
- POLISH PASS (`71d08515`, same branch): progression anchor (directive shows recently COMPLETED
  quests + "propose the natural NEXT step"; done titles join dedup), interests-histogram grounding,
  `POST /api/quests/refresh/run` manual force-fire, cold-save guard (no evidence → skip the model
  call with an honest ledger note; provider/codex-token construction moved after the evidence gate).
  Suites now 55 pure + 22 e2e (3 boots); both gates re-run green.
- OPEN: merge to trunk (merge ritual), first real-provider cycle on Andrew's save, frontend surface
  for the north star + a "refresh quests" button (both APIs already serve them), north-star
  CONFIRM beat (propose-and-confirm instead of silent adoption — flagged as the right next polish),
  cold-state → targeted awakening question instead of inference.

## MERGED 2026-07-12 — PER-RUN PHYSICAL-INPUT ISOLATION (`cf7984ba`)

Transcript-first forensics changed the diagnosis. FPS stream `ws_mrhb6bm3cpz4` made zero
`computer.use` calls and launched no headed test browser. Shell-authored Puppeteer/CDP clicked
Deploy in headless Chromium; the game then called the real DOM `requestPointerLock()`, which entered
Chromium's Win32 `ClipCursor` path. CDP clicks were synthetic; native pointer lock was not. The
boot/shutdown/E-STOP guardrails below are recovery layers and cannot prevent confinement mid-run.

This lane closes both reproduced routes:
- Ordinary runs expose neither `computer.use` nor `desktop.open`; both are removed from capability
  telemetry/provider wire/dispatch, the computer driver is inert, physical input has a separate
  danger class, and the packaged sidecar forces `STARNET_COMPUTER_DRIVER=0` + headless browsing.
- Local UI/game tests use owned `browser.test_*` only: the agent's running background-server handle
  and advertised origin are required; each run gets a private profile + ephemeral CDP port; pointer
  and keyboard locks are emulated before navigation; popups are paused/closed; arbitrary eval is not
  exposed; CDP/page input is synthetic; and Chromium exit is awaited in the outer `finally`.
- `shell.exec` and `verify.run` categorically refuse direct browsers/browser automation, native input
  APIs, GUI/native runtimes, local executables, `--open`, and normal npm/node/Python/PowerShell/cmd/
  Bun/Deno indirection. Build/unit/HTTP work remains available.

The follow-up audit extends this from the FPS route to a harness-wide user-control policy:
- A central impact authority runs before capability grants, Full Access, and cached consent. Missing
  run surfaces are autonomous; autonomous runs cannot start workspace processes, control media, use
  unknown connectors, launch a desktop app, or access physical input. Physical-input and visible-
  desktop impacts are unconditionally unavailable until a future native one-shot gesture lease exists.
- Every custom MCP tool is `external-unknown` regardless of transport or server-supplied `readOnlyHint`.
  It is absent from autonomous runs and requires an exact live, non-cacheable confirmation per call in
  a watched run. MCP stdio defaults off and only a broker-proven isolated worker can enable it.
- Child processes receive a minimal environment with StarNet/API/provider/channel credentials and
  execution hooks stripped. Host safety pins force headless browsing, disable the computer driver and
  local MCP stdio, and preserve user control.
- `verify.run` uses the same command decision seam as `shell.exec` and scans the exact nearest nested
  project it executes. Fullscreen, pointer/keyboard lock, wake lock, orientation lock, and popup APIs
  are neutralized inside the owned CDP test browser. Inputguard is observation-only: cleanup never calls
  global `ClipCursor(NULL)` and therefore cannot disturb a game or app the user owns.
- Workshop HTTP routes, decision payloads, frontend code, and Tauri IPC contain no file/folder launcher.
  A token or renderer message is not accepted as proof of a human gesture; the user opens kept paths
  manually. The task sidecar contains no Win32 input/capture implementation; its computer factory and
  legacy `desktop.open` tool are inert and never projected.

Focused gates are green (browser 79, computer 58, desktop 34, shell isolation 29, input policy 31,
shell-bg 31, shell machine-state 74, harness integration 90). A hands-off FPS substrate run used an
owned ephemeral CDP port (`51772`) and completed deploy, movement, relative aim, ADS, fire, reload,
pause, resume, tamper-resistance checks, and confirmed browser exit; 255 continuous Win32 samples
showed zero confinement, unchanged cursor position, and unchanged `GetLastInputInfo`.
The stricter QA now refuses a pre-confined baseline. That refusal caught a pre-existing real-window
lock live: foreground user Chrome titled `IRON & ASH — Free For All` owned clip rectangle
`[5,92,1915,1027]` before the proof began and retained it afterward — the proof browser was never
started. The observer cannot attribute who opened that Chrome window, but it independently confirms
why real-window routes cannot remain ordinary agent tools.

Residual release blocker: supported/modelled StarNet paths are closed, but a hostile or obfuscated
arbitrary binary in the same interactive Windows session cannot be made absolutely input-safe by regex,
environment variables, or a Job Object. A literal unknown-code guarantee requires a restricted process
token plus private non-input desktop/session, or a container/VM such as Windows Sandbox/Hyper-V. The
current machine has no available container/sandbox worker. Do not advertise the stronger OS boundary as
shipped; do not enable unattended local execution while that boundary is absent.

Ship blockers:
- [x] Merged through the controller at `cf7984ba`; the merged tree is byte-identical to the reviewed
      feature head. `test:fast` 315/315, full `test:http`, and
      `cargo check --locked --all-targets` are green on trunk.
- [x] Rebuilt the trunk 0.4.2 desktop executable and NSIS bundle. The source, release, and debug
      sidecars match and contain no Win32 physical-input driver symbols. Artifact signing stopped
      because `TAURI_SIGNING_PRIVATE_KEY` is unavailable; the already-created local bundle is unsigned.
- [ ] Sign/reinstall the desktop app, then run a real installed FPS agent task while the Win32 observer
      spans the entire run and browser teardown; grep its new transcript for `browser.test_*` and
      absence of shell browser / `computer.use` / `desktop.open`.
- [ ] Phase-5 computer evidence deliberately remains `blocked` until that installed receipt exists.

## LANDED 2026-07-14 — RECRUIT RECURATION: 12 majority-use classes + archetype-seeded minting

Andrew's read: most of the 18 preconfigured recruit listings were redundant — beginners picked none.
The catalog now has TWO shelves (`shared/specialties.js`):
- **BUILTINS (12)** — one class per distinct majority-use job: chief / researcher / engineer / scribe /
  analyst / operator / scout / designer / tutor + 3 NEW practical classes: **navigator** (trips &
  logistics; verifies every price/hour live, never claims a booking), **curator** (local file tidying;
  move-never-delete + quarantine — the local-first differentiator), **muse** (diverge-then-converge
  ideation). 2 new kit-grounded skill recipes: `itinerary-planning`, `file-curation`.
- **ARCHETYPES (9)** — the demoted deep cuts (reviewer/auditor/liaison/publicist/herald/broker/
  bookkeeper/translator/archivist), full specs, NEVER gated: `Specialties.get()` resolves them (old
  saves + summon-by-id still work), and the bay lists them in a collapsible **SPECIALIST ARCHIVE**
  that search/lane filters auto-expand.
- **Archetype-seeded minting** (`Scout.matchArchetype`, wired in `runScoutCycle`): on a prospect turn
  the cycle first checks — deterministically, ZERO model spend — whether a dormant archetype covers a
  WARM learned interest; a match stages its FULL spec on the DRAFTED-FOR-YOU shelf with a WHY from the
  real topic counters. Dedup: held names never re-pitch, dismissed shapes stay denylisted, LLM near-dup
  guard now counts archetypes (the model never re-authors one). No match → LLM authorship unchanged.
- Proof: class-loadouts re-pinned (all laws over BOTH shelves), scout.test matcher coverage,
  scout.e2e BOOT 3 (real sidecar stages the Broker archetype off a warm interest, zero model calls,
  persisted), live bay round-trips (12-card roster, archive expand/search, builder prefill with full
  loadout). Gate 318 green; W0 release surface re-stamped in-branch.

## LANDED 2026-07-12 — BOOT/SHUTDOWN MOUSE-CONFINEMENT GUARDRAILS (merged as `c069cba3`)

Incident: an agent-built pointer-lock FPS left a smoke browser + dev server alive after StarNet
was force-closed, and a stuck win32 ClipCursor walled the user's REAL mouse until cleared by hand
(desktop-shell stop = TerminateProcess, so gracefulShutdown never ran). Four guardrails, gate 306
green, boot-sweep + clip-release live-proven on an isolated sidecar (planted orphan reaped, decoy
chrome untouched, planted clip released):
- sidecar/procledger.js — persistent child-PID ledger; NEXT boot sweeps force-kill orphans
  (token-wise cmdline match = PID-reuse guard). Wired: shell.bg + agent browser + boot.
- sidecar/inputguard.js originally released global ClipCursor state at boot / shutdown / E-STOP. The
  per-run lane supersedes that behavior with observation-only telemetry: StarNet must not mutate clip
  state it cannot prove it owns, including clip state belonging to the user's own game.
- `shell.exec` originally blocked visible launches while allowing `--headless`; the per-run isolation
  lane above supersedes that exception because headless Chromium can still reach native pointer lock.
- Open-it card warns "captures your mouse (pointer lock) — Esc releases" via disk-proven
  manifest.capturesInput scan in validateWorkshopManifest.
- [ ] OPEN: walk the capture-warning card live in a full workshop round-trip (code+gate only so far).

## IN PROGRESS — Codex W0 claims/provenance verdict (`agent/w0-claims-verdict`)

Scope is the amended W0 only: code-verified SHIPPED/PARTIAL/MISSING/REFUTED verdicts before
W2–W6 tasks, the open-source build-provenance taxonomy (official / reproducible-source /
custom / dirty-dev), a finite advertised-claims ledger with experimental labeling, and the
explicit retirement of TPM/VHDX/anti-admin work if grep confirms it was never a product
requirement. No W1 implementation or W2+ fix lane starts until this bounded W0 audit commits.
Controller owns `docs/NEXT.md`, the W0 ledger/provenance planning surfaces, and any narrowly
required tests; it does not own `shared/events.js` or `shared/schema.js`.

W0 grep-verdict checkpoint (`ef16fa08`, 2026-07-12):
- **SHIPPED â€” do not rebuild:** durable E-STOP, background consent visibility, Night Shift
  pre-spend/leash refusal, truthful `/api/version`, MCP mutation consent, cold-boot recap,
  durable rejected-idea suppression, and the locked HTTP `200 {ok:false,degraded:true}`
  workspace refusal.
- **PARTIAL:** child-environment isolation, DNS-safe controlled-browser navigation, recursive
  link/junction containment, Slack/Matrix keychain custody, channel pairing, the unified work
  ledger, Settings full export, post-onboarding base URL, capability enforcement across run
  modes, Commander-context composition, and reason-aware learning.
- **MISSING:** scoped Workshop/file URL capabilities, zero-unconsented boot egress, attended
  real integration lifecycle receipts, and complete point-of-use experimental labels.
- **REFUTED:** work continuing after the desktop app closes, hallway-as-authorized-handoff,
  blanket no-phone-home copy, and a Signal token-keychain requirement (Signal has no token in
  the current adapter contract).
- **Preserved refs checked:** completed-looking W2 security work remains held on the existing
  `agent/pp-*` branches and will be re-audited only when W2 is active. The released dirty
  `pp-w0-open-source-reset` and `pp-w0-open-source-promises` worktrees remain untouched and are
  salvage-only, not merge authority.

W1 read-only preflight (do not implement until W0 passes):
- Beginner `STUCK@title` is a driver race, not a product splash bug. `beginner-run.mjs` waits for
  the static connect element, samples the active screen once while it is still `screen-loader`,
  and never retries Enter when `screen-splash` appears. Add a loader-to-splash fail-first test and
  retry the advance against observed screen state.
- Healthy-idle `LINK DOWN` is false because `world.js` ages only `onopen/onmessage`, while the
  server's 25-second SSE keepalive is a comment that `EventSource` never exposes. Held commit
  `9298c52f` already replaces this with header-auth fetch streaming and timestamps keepalive bytes;
  audit and merge-forward it in W1 rather than rebuilding it.
- `world.js` ownership must first be serialized with the stale
  `link-down-starnet-b85d52`, chat-bubble, and conveyor worktrees; no lane may overlap them.

## LANDED 2026-07-09 — LOST-WORK RESTORE: 7 built-but-unmerged features recovered to trunk (5b9cde3f) ✅

Andrew noticed the new start menu + upgraded CREATE YOUR OVERSEER were missing from his build —
root cause: the branch (claude/starnet-launch-overseer-ux-28d3f2) was **never merged**. A 6-agent
audit of EVERY unmerged branch + stale worktree then found six more finished features in the same
state. All 7 restored, gates green on trunk, live-proven (see qa/STATUS.md 2026-07-09 digest):
splash+overseer menus · CRT speech bubbles · scanlines toggle removed (Andrew: always-on) ·
selectable transcript+input history+Open-it fix · PROJECTS-tab fix+beat flatten ·
Slack/Matrix/Signal + CHANNELS panel · photo/file attachments.

**LANDED 2026-07-09 (late eve) — LAUNCH-POLISH SESSION ✅ (all gates green on trunk e96079d7; digest in qa/STATUS.md):**
rescue-merged BOTH stranded EL-11 fix branches (187724e3 hung-stream+wedged-beat-halt, 8b5aae04
consent-visibility+visible-E-STOP — live DOM round-trips done) · connector-spine COMMIT-rescued
(9d2e2d93 + archive tag; port = separate lane, 3 known conflicts incl. slack add/add vs trunk) ·
backend polish batch merged (64b20752..9a4f0e6c): /api/version harness truth (live-proven) ·
night-beat leash burn fixed (budget + no-provider pre-spend gates) · scout draft 14d TTL sweep
(live-proven un-wedge) · .bugloops evidence sweep + guardian hook (real sweep fires next guardian
cycle; manual run needs Andrew: `npm run qa:sweep`, dry first) · shipped-docs truth (PRIVACY
channels, RC-soak doc-fiction, runbook staleness) · release-train provenance UNBLOCKED (real cause
= CI shallow-checkout describe≠tag, NOT the binary stamp; fetch-depth:0 + parity test) · Quest V2
celebration round-trip PROVEN live (21/21, item closed below). GB-9 was REFUTED — already shipped
as EL-11 FIX 1; 200 {ok:false,degraded:true} is a LOCKED test-asserted design, do not "fix" to 5xx.

**Task Brief v2 (2026-07-16, branch `claude/starnet-context-extraction-a06d70`, docs/TASKBRIEF_V2_PLAN.md):**
- [x] Lanes A/B/C built + live-verified in-branch: marker-path questions persist honestly
      (no fabricated dimension/recommended), the host-validated recommendation renders on
      every question surface (COMMS gold ★ chip + why, restore, channel fallback), and six
      flagship recipes declare launch-time intake (one-tap material decisions ride the
      directive; `<recipe_intake>` aims mid-run questions). W0 surface re-stamped in-branch;
      receipt mint at merge. Catalog intake completed in round 2 (see Lane D entry).
- [x] Lane D DONE (Andrew-approved additive change, merged 11435856): 'clarifying' joined the
      agent.run.end reason enum; the buffered task-end emits it, hub endNote and COMMS treat it
      as the clean decision turn it is; additivity pinned by test (all prior reasons asserted).
      Catalog intake also DONE same merge: 29/50 recipes declare their material decision.

**NEW QUEUE from the launch-polish session (claim before building):**
- [ ] EL-11 leftovers 8-13, all frontend-owned (stationui.js/chat.js — was blocked on the 7/09 UI
      session; fix shapes with file:line evidence in the 2026-07-09 launch-polish triage, session
      transcript): 8 undo for out-of-jail artifacts (backend route + card affordance) · 9 EXPORT
      AGENT full backup button in SETTINGS (Backup.exportAll exists, connect-screen-only) · 10
      connector.state SSE bridge (needs ADDITIVE shared/events.js entry via owner) + global error
      notify · 11 global channel.connect error notify (listener is panel-scoped today) · 12
      base-URL edit post-onboarding (Harness.setBaseUrl exists, settings never calls it) · 13
      connector OAuth cancel affordance + poller cleanup on panel close.
- [ ] PRIVACY.md storage-table rows (channel tokens + message history) still enumerate only
      Discord/Telegram — extend for slack/matrix/signal once each one's exact persistence
      (keychain vs plaintext fallback) is verified (lane-D flag).
- [ ] Provenance CI proof: after next trunk push, throwaway tag `v0.0.0-provtest` → watch the
      train's provenance step go green → delete tag+draft (Andrew or any session with push).
- [ ] Janitor teardown (classifier-blocked in-session, needs human-approved pass): worktree
      .claude/worktrees/chat-bubbles-styling-c17d0f + branch claude/chat-bubbles-styling-c17d0f
      (SUPERSEDED — patch-id-identical to trunk 970260e8; archive/chat-bubbles-styling tag pinned);
      dead subagent worktrees agent-a2609846513e19866 + agent-afaa4833c73b46244 (both branches now
      MERGED to trunk, trees clean).

**QUEUE — audited unmerged gems, NOT yet restored (claim here before building):**
- [ ] **connector-spine PORT** — rescue ✅ DONE (committed `9d2e2d93` on `agent/connector-spine`
      + tag `archive/connector-spine-rescue-2026-07-09`; tree verified CLEAN 2026-07-14): email/
      sms/webhook/whatsapp adapters + tests (new-file clean) + managed-credits billing seam. Its
      slack = superseded by trunk's; its org/derive = orphaned (orgvalidator.js deleted).
      Remaining = the port: manual re-wire of index.js/stationui.js in a fresh lane.
- [ ] **Settings V2 control-plane PORT** — rescue ✅ DONE 2026-07-14 (committed verbatim as
      `02d872f9` on `agent/hermes-settings-audit` + tag `archive/hermes-settings-audit-rescue-2026-07-14`;
      tree CLEAN; its own settings-store test 21/21 green at its base). Contents: schema-driven
      settings-store.js (schema/defaults/current triple, ~50 fields) + GET/POST `/api/settings`
      + `/defaults` + `/schema` + schema-rendered panel (stationui.js +378). Port assessment
      (2026-07-14, base 1867 behind): trunk STILL has no `/api/settings` — backend half genuinely
      missing. But port must be SELECTIVE, not a merge: (a) reconcile with trunk's newer
      `/api/runtime/knobs` (P1-9 — same protected-sibling persistence; don't ship two knob
      stores); (b) drop fields refuted by locked decisions (appearance.music — music DELETED;
      appearance.scanlines — toggle removed, always-on) and every `status:'planned'` no-op field
      (tool surface must never exceed wired reality); (c) render new sections INTO the existing
      premium SETTINGS window, don't replace it; (d) index.js/stationui.js hunks won't merge at
      1867-commit drift — hand re-port using the rescue as reference; settings-store.js + test
      port nearly clean after field re-curation.
- [ ] **growth-t4 anti-nag budget** — global one-interactive-ask-per-task-end + starvation
      fairness. Do NOT merge the branch (chat.js +1386 drift, new thread/autopilot lanes it's
      blind to) — fresh re-port of the design.
- [ ] **meeseeks frontend sprites** — 38-line world.js layer completing the merged team.spawn
      backend; VERIFY trunk forwards sub-* agent.run.* events before building, else sprites never light.
- [ ] Restored-feature follow-ups: real-token pass on slack/matrix/signal; live file-upload
      round-trip (e2e-proven only); bubble-restyle visual check at zoom.
      (2026-07-15 messaging-reliability lane, merged acfd82b5: slack reconnect truth, E-STOP/
      snapshot cover all five channels, owner-binding persist warning, durable reply outbox,
      FORGET honesty, DM-only copy honesty — see qa/STATUS.md digest. Still open here: the
      real-token soak + mention-gated group messaging, chip spawned.)

**SUPERSEDED — safe to delete, do not re-audit:** agent/parity-finish (fs.patch/MCP-stdio landed
via bb398960), agent/ui-number-format (trunk U.usd/U.tokens better), spend-model-honesty +
mac-linux-support worktree drafts (trunk superset).

## LANDED 2026-07-08 (evening) — GAP-AUDIT SPRINT: last-hop fixes on everything shipped today (Fable session) ✅

Six-agent code-verified audit of the day's merges found ONE pattern: every flagship shipped its
ENGINE but was missing the last hop that delivers user value — and the standing gates were blind
to all of it (Guardian/qa:ready never ran test:http, where every new system's integration proof
lives; atlas had zero tiles for the new routes). All fixes MERGED to trunk same evening, full
ritual per merge (fast + http gates green on trunk after each):

1. **E-STOP durable night-shift halt** (be03e5d0) — escape: `isHalted: () => false` meant beats
   RESUMED ~45min after E-STOP; now durable `haltedAt` (survives restart), truthful
   `binding:'halt'`, dial re-write lifts. Escape tests: planner + driver + real-sidecar e2e
   (nightshift-halt.e2e, in test:http).
2. **Guardian http-e2e P0 step + atlas sweep** (be03e5d0) — qa:ready now vouches for
   scout/threads/nightshift/pathtrust integration proofs; 23 new atlas tiles (all 18 new-system
   routes). OPEN: one behavioral JOURNEY per new system (queued, not claimed).
3. **Quest V2 completion sweeps** (0b017a70) — audit found only `attest` could ever complete
   (bindRun 0 callers; prop/fact/artifact unhooked; attest unscoped → spoofable). Now all 4
   mechanical types complete at real truth points (sidecar/questsweeps.js) + attest enforces
   openForAgent. ✅ live-DOM celebration round-trip PROVEN 2026-07-09 (launch-polish lane Q:
   8/8 backend + 13/13 frontend CDP asserts — open→done edge, .q-celebrate, gold toast, COMMS
   broadcast, restart-durable; gotcha: mock /models must advertise supported_parameters:['tools']).
4. **NS-6 thread TURN-IN CARD** (5106e671) — the ledger was a GHOST (no frontend hit
   /api/threads*; openThreads() forever empty). Now threadstore.js + gold-inset card via the
   beat arbiter (5th participant, memory>study>arc>trust>thread); LIVE DOM round-trip proven
   (mined idea → card → KEEP → open thread server-side). "You mentioned X — here's the thread"
   is now reachable end-to-end.
5. **Scout honest cold state + WHY grounding + true e2e** (d5c8dcfe) — shelf no longer silently
   '' when cold (CALIBRATING/n-of-N states from /api/scout truth, CDP-proven); ungroundable WHY
   rejected; scout.e2e proves the full post-run chain incl. the anti-silent-no-op path. OPEN:
   draft TTL/interest-decay eviction; scout attempt-ledger panel.
6. **computer.use focus-truth guard merged off the vine** (04ae3797) — the Spotify
   screen-puppeteering fix was stranded on a dead branch; landed clean, 100 assertions.

**Audit findings REFUTED (do not re-fix):** morning report IS rendered; autonomous beats can
never bless a root; event contract clean; guardian lock on trunk; Quest V2 was real-provider
proven; night-shift timer cross-process lock is BY-DESIGN absent (one-sidecar invariant).
**NEW QUEUE from the audit (not yet built):** per-new-system journeys (J8+) · NS-9 learning cap
±0.5 < one confidence step = tie-breaks only, no decline REASON captured, no compounding test ·
user-understanding SILOS (6 aux-model passes per run-end re-extract the same signal into 5-6
stores; scout interests duplicated vs browser profile; "declined" in 3 unsynced places — the
NS-8 unified composer is the fix) · messaging-connectors merge (1555 lines, tested, rotting —
70-commit divergence; NOTE 2026-07-09: now COMMITTED as 9d2e2d93 on agent/connector-spine) ·
EL-2 saboteur mutators. (✅ CLOSED 2026-07-09 launch-polish: .bugloops TTL GB-27 · /api/version
harness placeholder · night-beat leash burn. REFUTED: GB-9 workspaceDegraded — already shipped
as EL-11 FIX 1, the 200 {ok:false,degraded:true} shape is LOCKED + test-asserted, don't "fix".)

## LANDED 2026-07-08 — GATE BURN-DOWN: qa:ready code side driven to zero (Fable session) ✅

All 4 qa:ready blockers cleared in one afternoon; every "P0" was the QA apparatus, not the
product (pattern for docs/MISTAKES.md: before fixing "the app", prove the instrument):
1. **Installed-exe smoke FIRST RUN → GREEN 6/6** (app 0.3.1). Initial BLOCKED was the probe
   sending `Authorization: Bearer` — sidecar CORS only allows `X-StarNet-Token`, so the
   packaged cross-origin (tauri.localhost→127.0.0.1) preflight died pre-response. Probe fixed
   + EL-3 guard (Bearer forbidden in SMOKE_PROBE). Version chain PROVEN correct live
   (appSource:env). Merged 648d7212.
2. **Beginner STUCK@first-directive = instrument budget**: awakening is intentionally
   cinematic (~93s measured to first chip under load) vs unmeasured 60s step budget from
   runner birth. 60s→180s + stale `.msg`→`.cmsg` probe + lock (budget ≥120s). Post-merge
   RUN PASS 87.5s/6 steps.
3. **Guardian wedge = NO cross-process lock** (hourly × watch × manual raced the shared pin
   worktree + 8940-43 ports → all 4 BLOCKED P0s, all 3 "visual regressions" (within threshold
   clean — NO re-bless), work-tasks "failure" = overlapping teardown). Fixed: heartbeat
   lockfile (%TEMP%/starnet-qa-guardian.lock, stale reclaim) + review-clean verdict (all-
   dismissed red gate ≠ red; BLOCKED never excused) mirrored into journeys.mjs; QA_STATION §2
   corrected. Guardian findings 10→0.
4. **J7 slash INPUT-path truth journey** (12 assertions, non-vacuous: reintroduced 7/05 bug →
   FAIL exit 3) pays Perfectionist 070e8aca — the last open P1. Atlas coverage refs added.
Ledger: 12 open P0/P1 → **0**. Remaining qa:ready reasons at session end = none code-side
(fresh guardian stamp on final head pending its cycle). OPEN (non-blocking): packaged
/api/version `harness:""` blank; desktop exe orphans sidecar node processes on kill (chipped);
installed exe on 0.3.1 vs v0.3.3 shipped (run the updater = also proves update path).
**Andrew-only P0s unchanged and now THE critical path:** publish starnet-releases repo,
updater-key backup, dev-key rotation, 15-min attended playtest. Then RC freeze + 48h soak.

## LANDED 2026-07-08 — SCOUT: recruitment-bay recommendations actually evolve now
Branch `claude/recruitment-bay-recommendations-52df53` (merge pending): the bay's dynamic
shelves were wired but starved (client-session one-shot mint, silent rejections, hero-only
5-sample warm floor, zero topic signal — presets forever). Now: sidecar-owned **interest
engine** (`sidecar/interests.js` — reason-only topic extraction over real activity, EWMA
histogram + evidence quotes) + **scout cycle** (`sidecar/scout.js` + index.js post-run hook —
persisted cadence, drafts agent prospects AND recipes, every attempt in a visible ledger) +
`/api/scout*` routes + frontend rewire (prospectstore = scout client; SUGGESTED shelf gains
station-drafted recipe cards; launch telemetry feeds FOR-YOU rank). Signal loosened: all-agent
tool counting, CALIBRATING_N 5→3. Live-verified on dev seed (restart hydration, both shelves,
accept/dismiss round-trips, telemetry). OPEN: first real-provider scout cycle unobserved;
optional nightshift catch-up pass; scout-ledger surfacing in a UI panel. (✅ 2026-07-09
launch-polish: staged-draft 14d TTL sweep landed — stale drafts can no longer wedge minting.)

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

## P0 — Windows update sidecar-lock hang (canary-caught 2026-07-14)

The local update canary (`npm run release:canary`) caught a UNIVERSAL Windows in-app-update
failure the whole test suite could never see: the updater plugin launches the NSIS installer
then hard-exits via `std::process::exit(0)`, which does NOT fire Tauri's `ExitRequested`
handler — so `kill_sidecar()` never runs, the old `node.exe` sidecar stays alive holding a
write lock, and NSIS FREEZES on "error opening file for writing: node.exe" (Retry/Abort/Ignore)
forever. Every Windows user, every in-app update. FIX: wire the plugin's `on_before_exit` hook
in `starnet_update_check` (main.rs) to set `shutting_down` + `kill_sidecar()` before the exit;
the hook rides the pending Update into the install path. Compiles; being re-proven through the
canary (rebuild old-with-fix → reinstall → drive to clean completion). The canary's `drive`
was also hardened — it now requires installer-exited + app-relaunched, not just the version
resource (which flips BEFORE the hang, so version-only was a false green).

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
  Pipeline hardening landed 2026-07-14 (update-blockers lane): signed `linux-x86_64-deb`
  manifest key (was: every .deb self-update failed on the AppImage fallback), real minisign
  crypto verification of every artifact/.sig in assemble (`npm run release:verify-sig`),
  published releases immutable to train re-runs. Next release train run exercises all three.
  Then run the older-install → publish → restart update canary per platform (Win NSIS, both
  mac arches, AppImage, .deb) — still ZERO public end-to-end update proofs.
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
1. ~~`agent/belt-reclaim`~~ **MERGED 2026-07-06 ~23:59** (gate green, 260 steps). Live-app
   check ✅ DONE 2026-07-07 by Atlas wave-3 REFIT lane: drag-clear of a 3-belt run → 0,
   ONE undo restored all 3 (evidence .bugloops/perfectionist-build2-20260707/refit-verify.json).
   Worktree teardown pending.
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
  treat it as BINARY. ✅ FIXED 2026-07-07 in agent/multiagent-truth (2 raw NULs → u0000
  escapes, runtime-identical; loop suites green).

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
- **Guardian collision FIXED 2026-07-08 (branch `worktree-agent-a587eb4a789044522`, unmerged):**
  root cause = the hourly task, the `--watch` process, and manual runs all target the SAME pinned
  worktree + the SAME 8940-8943 ports, so overlapping runs raced on the shared
  `.git/worktrees/**/index.lock` (finding 90fe0bcc) and timed the visual gates out into BLOCKED
  P0s (9b077d5e/6fc6c002/328bc698/69eff742). Fix = a **machine-global cross-process lock** in
  `guardian.mjs` (heartbeat lockfile at `%TEMP%/starnet-qa-guardian.lock`, PID-liveness +
  stale-reclaim; one-shot SKIPs when held, `--watch` skips-and-retries, `--wait` queues) — the
  three launch styles now serialize. Also: a red gate whose every finding is dismissed/known is
  now **review-clean** at the cycle verdict (mirrors golden), so the dismissed J2b panel-close
  busy-poll flake (`6feab179`, reproduced 3/3 PASS isolated) no longer pins the release gate RED;
  `journeys.mjs` mirrors it for its own exit code. QA_STATION §2 "overlap harmlessly" claim
  corrected to the truth. GREEN all-5-gates cycle proven on trunk 42803552 (guardian-20260708-195105);
  all 10 stale Guardian findings closed → Green Guardian 0 open. OPEN = merge to trunk (the live
  hourly task runs trunk code, so the lock only protects production after merge).

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
- **EL-5 · ESCAPE 2026-07-07: Telegram bot token silently destroyed** — ✅ FIX MERGED
  a1f8cc66 (gates fast 261 + http green; failing scenario landed with the fix per EL-3;
  lane live-smoked restart round-trips both directions). Andrew must re-paste the BotFather
  token once (old one unrecoverable); it now persists plaintext until the keychain verifiably
  adopts it. EL-5b lane `agent/secrets-durability` IN PROGRESS (Fable session). Desktop keychain migration stripped the plaintext
  token without read-back proof the keychain held it (3 paths: main.rs `let _=set_password`,
  saveChannelSecrets unconditional strip, sidecar boot migration). Live-verified on Andrew's
  install: `channel:telegram` absent from Credential Manager, config intact. Per EL-3 the
  failing scenario lands WITH the fix. Follow-on: secrets-durability sweep of ALL credential
  stores (provider keys / codex OAuth / connector OAuth / .bak recovery) — findings will be
  queued here. NEW MERGE-RITUAL QUESTION: "does this change move/strip/clear any credential —
  and where is the read-back proof?"
- **EL-5b · Secrets-durability sweep findings — ✅ ALL 4 FIXED + MERGED 2026-07-07 (lane
  agent/secrets-durability, gates fast 261 + http green; every finding re-verified real,
  failing-test-first).** Shared root causes = silent `catch{warn}` on secret saves +
  multi-step persists without confirmation. New shared primitive: `saveJsonVerified()` in
  sidecar/durable-store.js (write → read-back → proof predicate → retry once → honest
  ok:false) — USE IT for any future credential persist. Details in qa/STATUS.md digest.
  Historical findings:
  - **F4 HIGH — Codex OAuth refresh persist:** `ensureCodexAccessToken` (sidecar/index.js
    ~1737-46) rotates the refresh_token in memory; if `saveCodexTokens` write fails
    (swallowed), a crash strands the OLD dead refresh_token on disk → forced re-sign-in.
    Fix shape: verify the write (read-back) before treating the rotation as durable; surface
    failure.
  - **F1/F3 HIGH — Connector OAuth tokens/clientId:** `saveConnectorOauth` failures are
    silent (index.js ~1837-39, ~3345-3400); DCR clientId + refresh_token can both exist only
    in memory after a successful sign-in → next boot the connector is unsigned and the
    orphaned clientId can't be reused. Fix shape: same read-back law + fail the sign-in flow
    loudly if the token didn't reach disk.
  - **F2 MED — Spotify refresh clear:** spotify/store.js ~86-108 — `clear()` must fire ONLY
    on explicit `invalid_grant`; harden the malformed-response path (`res.json()→null`) so a
    weird 400 can never wipe a live refresh_token.
  - **F6 LOW — .bak scrub gap:** scrubChannelSecretsBak returns silently on unreadable .bak,
    leaving plaintext key in the .bak (hygiene, not loss).
  - Audited CLEAN: roster/knobs/budget/allowlist/cron/ledger via saveResilient+.bak;
    localStorage creds not touched by version purge.
- **EL-6 · ESCAPE 2026-07-07: multi-agent run died ~5min + visuals lied + research not
  headless — ✅ FIXED + MERGED (lane agent/multiagent-truth → 957384bf, gates fast 266 +
  http green, escape-first tests, live-verified dev seed).** Andrew's overseer→researcher→
  peter dispatch: worker ran its roster MODEL on the LEAD's provider wire (instant 400 when
  they differ — the fast worker death), run stream byte-silent for minutes during dispatch
  (silent-socket kill class), diag error ring RAM-only (restart erased the evidence), worker
  sprite decayed at RUN_TTL because only lifecycle+cost forward, and browser.* launched a
  VISIBLE window for research. All seven fixes in the qa/STATUS.md digest. STILL OPEN from
  this escape:
  - **EL-6a · queued-worker floor affordance** — team.dispatch's later workers show NOTHING
    until their turn (sequential by design). Needs an ADDITIVE shared/events.js event (e.g.
    dispatch-intent carrying worker ids) — REQUEST TO CONTRACT OWNER (cortex-memory lane);
    argsSummary's 80-char clip cannot carry the list. Then world.js renders a "queued" chip.
  - **EL-6b · single worker turn >5min** — agent.cost stamps the TTL per completed turn; a
    single silent turn longer than RUN_TTL still decays the sprite. Acceptable edge unless
    escapes recur; revisit with EL-6a's event.
  - **EL-6c · Andrew's exact trigger unconfirmed** — his install predates the diag
    persistence, so the original error text is gone. If it recurs on a build with this lane,
    /api/diagnostics now carries the error across restarts; pin it then.
  - NOTE: his diagnostics said `App version: unknown / Mode: browser` — expected for npm
    start/browser mode (packaged desktop sets STARNET_APP_VERSION + tauri origin). If he was
    IN the installed exe, that's an origin-detection bug worth a look on a repro.

## EL-11 · STRANDED-USER SWEEP 2026-07-08 (5 live-driven domains; THE ship gate) — 12 STRANDED + 1 lock / 22 ROUGH

**STATUS 2026-07-09 (launch-polish session, code-verified per item):** items 1,3,5 ✅ FIXED via
rescue merges 187724e3 + 8b5aae04 (fixes were finished-but-unmerged on dead subagent worktrees —
lost-work law strikes again); items 2,4,6,7 ✅ were already fixed on trunk (a996da07 + b7f984b3);
items 8-13 STILL OPEN, all frontend-owned, queued with fix shapes at the top of this file.

LAW (memory stranded-user-testing-law): shippable = zero STRANDED. Each item = fix lane + EL-3 test.
STRANDED (ranked): 1. hung provider stream ends RUN COMPLETE reason:done (provider.js:146-160 reader.cancel settles read as done — watchdog cannot fire; night beats inherit) 2. degraded workspace: writes refused 200 ok:false while save-dot healthy + cloudsave stamps success (cloudsave.js~105/app.js~990 check r.ok not body) 3. background-session consent invisible → auto-DENY at 120s (notify gated on isActiveWs; warroom hotspot removed) 4. night-shift durable halt (TONIGHT'S fix) invisible: panel says ACTIVE/standing-by + NEXT ELIGIBLE while halted:true never read by any frontend; lift (dial re-write) documented nowhere 5. wedged beat run holds agent mutex forever; /api/halt misses handleNightshiftBeatNow AC (index.js:7085) + E-STOP button doesn't exist (hotkey-only, error copy names it) 6. post-sidecar-respawn stale token → all 403 + "Add a key" misdirection (classify 403 as reload/re-auth) 7. double-corrupt save → silent GENESIS (quarantine works, zero disclosure) 8. no undo for out-of-jail artifacts (ns/ branches, workshop KEEP) 9. full-agent backup (save+memory) unreachable in-app (connect-screen only; STATION BACKUP = 1.4KB settings, no memories) 10. dead MCP connector invisible outside panel (connector.state → console.log only, GA-8) 11. dead channel invisible outside panel 12. custom/Ollama base-URL uneditable post-onboarding + 13. connector OAuth 5-min uncancelable lock survives panel reopen.
ROUGH highlights: harness.js:355 discards error body (EL-10 door lost pre-stream) · key REMOVE doesn't revoke server-side · provider-down blamed on app · TG/DC "connected" lie pre-auth (1c09b36f) · 402 top-up URL not a link · budget stops never name cap/door (/api/budget/resume zero callers) · HALT toast "stopped 0 runs" lie · readiness-gate jargon hides the grant · awakening full-replay on reload · broken-brain invisible until failure · fresh workspace inherits codex tokens cross-root (sign-out violation) · disk-fail 60-min blind window · silent .bak recovery · no bulk memory delete · no tour replay.
Full evidence: session scratchpad stranded/ + shots; agent reports 2026-07-08 evening. Stale claims corrected: GC-7 browse EXISTS, GB-22 cleanup EXISTS, GA-3 retry chip EXISTS.

## EL-10 · ESCAPE 2026-07-08 (Andrew, post-0.4.0 install): ChatGPT OAuth died + settings LIED "SIGNED IN" + zero recovery UI — fixes IN FLIGHT

First message after the 0.4.0 update: "ChatGPT sign-in expired… refresh token already consumed
by another client." Three compounding defects, none caught by any gate:
1. **Root cause = orphan sidecars** (the chip previously classed cosmetic — now P0): 3 stale
   node.exe sidecars were alive pre-install, all sharing the codex token file; OAuth refresh
   ROTATION means they consume each other's tokens. Violates one-sidecar-per-WORKSPACES.
2. **Settings→Providers asserted "● SIGNED IN · 1 key" while the token was dead** (sidecar knew
   — it had just errored the run) and the CHATGPT row renders NO actions (no re-sign-in, no
   disconnect; key providers get UPDATE/REMOVE). Truthful-telemetry violation in the flagship
   settings panel.
3. **Recovery engine existed, unreachable**: /api/auth/codex/start|poll|logout + a full sign-in
   UI exist — mounted ONLY in the new-agent brain screen. Error card offers only ADD A KEY.
RECOVERED live same session by driving the device flow via CDP through the installed app
(connected:true, persistError:""). FIXES in flight (2 lanes): (a) honest expired status +
RE-SIGN-IN/DISCONNECT row actions + error-card RECONNECT deep link, EL-3 tests; (b) main.rs
boot-time reap of orphaned bundled-node processes (fail-open, install-path-scoped).
COVERAGE GAP TO CLOSE (the meta-lesson): NO gate drives a provider AUTH LIFECYCLE
(sign-in → token death → in-UI recovery). Queue a journey/e2e for it (rides the same lane as
the queued per-system journeys). NOTE: the main.rs fix reaches Andrew's install only at the
NEXT desktop build.

## Ready Gate · RC Soak · Dogfood — process-fix wave 2 (added 2026-07-07, Fable session)

**Why (session audit 2026-07-07):** the EL loop fixed *detection* but not the *repeat*: (a) the
aggregate "ready / go public" claim was never gated on anything — sessions reported lane-green as
project-green while the Guardian sat RED; (b) nothing ever uses the product the way Andrew does
(installed exe · real providers · long multi-step work), so he is structurally the first tester;
(c) no freeze — merging 10+ lanes/day means readiness is audited against a moving target.

**The law (READY-GATE, mirror into starnet-verify + DECISIONS.md when EL-7 lands):** no session,
report, or doc may claim StarNet is "ready", "perfect standing", or "go-public-able" without a
fresh `npm run qa:ready` receipt printed alongside the claim. Lane-level done stays lane-level:
"lane X verified; station-wide status is whatever qa:ready says."

**Queue:**
- **EL-7 · qa:ready gate** — ✅ MERGED 2026-07-07 (lane agent/ready-gate → 7f737a93, gate 267
  green): `npm run qa:ready` = one machine verdict READY/NOT-READY with per-check receipts
  (ledger P0/P1 via openBySeverity() · Guardian green+fresh+saw-current-trunk via git drift ·
  journeys · beginner · installed-smoke stamp ≤7d). No-fake-green. LOCKED LAW in DECISIONS.md +
  starnet-verify: no "ready/perfect/go-public" claim without a pasted fresh qa:ready receipt.
  First live trunk verdict: honest NOT READY — 5 reasons (6 P0 · 6 P1 open; runner stamps unwritten
  until each runner's next cycle; installed exe unverified).
- **EL-8 · RC freeze + installed-exe soak (absorbs EL-4)** — ✅ MERGED 2026-07-07 (lane
  agent/rc-soak → bf72e8bb, gate 268 green): docs/RELEASE_READINESS.md (rc/<ver> freeze — only
  P0/P1 cherry-picks with their EL-3 scenario; ≥48h installed-exe real-provider soak, dogfood-
  driven; P0 restarts the clock; pass = 0 new P0/P1 + qa:ready READY) + scripts/qa/installed-
  smoke.mjs (CDP attach 9333 via scripts/lib/cdp.mjs; GREEN/RED/BLOCKED stamp qa/installed/
  last-smoke.json — cross-lane read PROVEN live vs qa:ready; BLOCKED files P0, RED files P1) +
  RELEASE_RUNBOOK step 0 (no READY, no release:bump). STILL OPEN: first real run against
  Andrew's installed exe (relaunch with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
  --remote-debugging-port=9333, then `npm run qa:smoke:installed`).
- **EL-9 · Dogfood loop (Andrew stops being QA)** — ✅ MERGED 2026-07-07 (lane agent/dogfood →
  41b189fc, gate 266 green): loops/dogfood.md 9-step real-user shift + crew row/ports 8970–8979 +
  first proof shift in qa/dogfood/SHIFTS.md (mock, labelled; interrupt truthfully cancelled,
  diagnostics survived restart, 0 anomalies). STILL OPEN: first REAL-provider shift (needs key in
  dev/.env.dev; pennies on a haiku-class model) and installed-exe shifts as the RC-soak driver.

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

_**CAMPAIGN COMPLETE 2026-07-07** (7 waves, 17 lanes, every merge through the full ritual):
**0 unmapped / 1288.** End gauge: 184 perfected·fresh · 235 audited · 842 mapped · 27
honest-stale (conditional-render). The loop is now STANDING WORK, not a campaign:_
1. _Promotions blocked ONLY on coverage — the chips are the unlock: probe layer
   (task_6453f643, HIGHEST leverage), slash-input P1 (task_a3433760), then the coverage
   set. Each landed chip lets the next Perfectionist pass promote dozens of audited
   entries._
2. _842 mapped = seam-traced clusters awaiting deeper per-instance passes — future
   sessions pick areas per loops/perfectionist.md priority as needed; the registry is
   the queue._
3. _Cartographer re-sweep after any UI-adding merge (skeletons new surface); staleness
   auto-requeues; nightly reprove once the probe layer lands._
4. _Overseer morning triage owns the 10 open Guardian + 1 Beginner P0 from today's
   merge storm (3 golden re-bless deltas · 4 collision-BLOCKED (lock chip!) · 1 flake-
   class · beginner first-directive stall needs a quiet-machine re-run)._

_Wave-6 DONE 2026-07-07 (3 lanes merged + gated 266 + reaped): **build/crew areas COMPLETE,
world 429→15 unmapped**. 18 seals===catalog + 5 loadout-law dossiers + custom-class round-trip;
props gallery contracts (38/38 skills, 37/37 connectors, mouse-place dish=cap re-proven);
model-dock family 376 rows + honest offline-fallback labels. Zero truth defects; 3 KNOWN
coverage notes (75af5388, cbc5b114, fc9beb65) — all probe-layer candidates._

_Wave-5 DONE 2026-07-07 (3 lanes merged + gated 265 + reaped): **work / system / events areas
COMPLETE (0 unmapped each)**. Truth bug found+chipped: telegram connect lies 'connected'
pre-auth (1c09b36f). Dead listener 'flagged' + 16 aspirational event slots → cortex-memory
wire-or-retire (1019f6e1, 9c5ec90c). Catalog UI-dispatch seam unguarded (3717ef2e). Restale
37/37 HELD mid-wave, then NS-4 (stationui.js+index.js) re-decayed 329 — final restale sweep
scheduled as wave-7 closing step; probe chip = the structural fix._

_Wave-4 DONE 2026-07-07 (3 lanes merged + gated + reaped; gate 261→264 under parallel
merges): **restale 76/76 HELD, 0 regressions** (sidecar token/OAuth commits moved no
audited seam — proven) · **routes ALL 114 mapped**, 19 core contracts proven (tts/stt
200-always + diagnostics secret-free + snapshot==store all HOLD; /api/session = no-op
stub b1248295; six core routes only covered by non-gate test:http 6887ef72) · **crew**
12 restale held + 16 new, SKILLS-honesty + XP-truth laws proven live (CHANGE SKIN
uncovered d2121f51). Staleness churned again mid-wave (night-shift merges → 42 stale)
→ **executable-probe upgrade chipped** (probe-per-dossier → nightly script reprove;
that chip is now the highest-leverage Atlas click). Gauge: **67 fresh / 42 stale /
50 audited / 125 mapped / 1004 unmapped**. Janitor item: gen-trees/perfect-crew2 dir
locked by stray handle (git-pruned, inert). Next: system remainder (132) · world
remainder (429) · events (60) · re-prove routes' 19 when probe layer lands._

_Wave-3 DONE 2026-07-07 (3 lanes merged + gated 261 + reaped): world/COMMS +4P/+3A
(chat-stop never machine-clicked bd391f68 · voice press-flips c3fa1f39) · build/REFIT +11P
(**object=capability proven live: place=grant/undo=revoke/redo=re-grant**; belt-reclaim
one-undo live check DONE — item #1 above closed) · commands ALL 40 mapped, 14P via the real
input path (**P1 070e8aca: the 7/05 args-bug seam has only source-grep tests — behavioral
journey chipped**). **Staleness fired for real**: parallel merge b1af72a5 touched
sidecar/index.js → 76 wired entries decayed perfected→stale (re-proof queue, by design).
Gauge: 25 fresh / 76 stale / 11 audited / 30 mapped / 1146 unmapped. Next wave: re-proof
the 76 stale (cheap — behavior unchanged unless channels-token work moved seams) · crew
remainder (92) · routes/events._

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
- GB-4 Quit/update-while-running guards: BOTH halves FIXED 2026-07-14 (update-blockers lane).
  Update: Updates.install() checks Channels.busyCount(), amber guard card WAIT/INSTALL ANYWAY.
  Quit: quitguard.js intercepts close-requested (titlebar X, Alt+F4, taskbar), modal STAY /
  CLOSE ANYWAY when agents live, bounded state drain before EVERY allowed close (destroy()
  skips beforeunload), fail-open so a broken Channels never wedges the window shut. Needs
  the next desktop rebuild (capabilities +core:window:allow-destroy) to be live in the exe.
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
- ~~GB-27 .bugloops unbounded (395MB/2066 files) — TTL sweep.~~ ✅ 2026-07-09 launch-polish:
  evidence-sweep.mjs + qa:sweep + guardian-cycle hook (was 1,048MB when fixed).
- GB-28 Multi-agent status dashboard (which of N agents stuck/failed/done — superset of GB-7).

**Round 3 (GC) — closing sweeps 2026-07-07: external parity (ChatGPT/Claude Desktop/Cursor/
LM Studio) + final corners. Convergence reached: 18/28 parity candidates and most corner items
were already shipped or on GA/GB — the audit is saturated; below is the residue. AUDIT CLOSED.**

*GC-T1 — the OS-integration layer (the entire theme parity surfaced; StarNet has none of it):*
- GC-1 System tray + close-to-tray: app fully DIES on window close — contradicts the "agents
  keep working / 24-7 routines+channels" pitch. No TrayIcon anywhere in src-tauri.
- GC-2 Global summon hotkey / quick-entry window (ChatGPT Alt+Space class; no global-shortcut
  plugin in Cargo.toml).
- GC-3 Launch-at-login toggle (no tauri-plugin-autostart) — pairs with GC-1 for real 24/7.
- GC-4 Screenshot capture-and-attach (companion to GA-1; only canvas postcard capture exists).
- GC-5 App shortcut set: new session / focus input / palette (only ctrl-handlers in ALL of
  frontend = REFIT undo/redo + Alt+H) — makes GA-17 cheat-sheet worth having.
- GC-6 Always-on-top compact companion mode (capability in Tauri schema, never invoked).

*GC-T2 — chat + trust residue:*
- GC-7 Memory VIEW surface: user can veto ("forget this") at write time but can NEVER browse/
  bulk-delete what agents remember — trust/privacy gap (chat.js ~1070 deck is write-time only).
- GC-8 Temporary/incognito chat (no transcript/memory writes) — complements GB-3.
- GC-9 Branch conversation from a message keeping both (GA-3 edit is destructive).
- GC-10 Quote-selection-to-reply; @-mention agent autocomplete in input.
- GC-11 Session folders/projects grouping (flat list; matters past ~30 sessions).
- GC-12 Spend click-through: topbar total → per-agent/per-day breakdown (data tracked, no UI).

*GC-T3 — board + small residue:*
- GC-13 Task cards: drag between lanes, notes/description field, optional due-date (title +
  deliverable link is ALL a card holds today).
- GC-14 Recruit: preview class system prompt before summon; custom-class DELETE (edit exists);
  skin preview before confirm.
- GC-15 Factory-reset (fresh station) from settings without reinstall.
- GC-16 Widget resize (reorder/remove exist); maxlength counters (18-char rename truncates
  silently); spellcheck attr on chat textarea; emoji-in-names canvas rendering unvalidated.
- GC-17 Parked/low: proxy settings, app locale, migration guide doc (export covers data).

## NIGHT SHIFT — autonomy rebuild (added 2026-07-07, Fable session; Andrew-approved direction)

**Escape:** Andrew left the station overnight at MAX autonomy → exactly 1 autonomous act, then
10.7h of silence (live-verified in `runs.jsonl`: last self-directed beat 02:24, next activity =
the 1PM cron). Root causes code-verified this session — the autonomy layer is a demo, not a shift:

1. **One-beat-per-idle-episode**: `armed` flag (autopilotstore.js:92) spends the single beat on
   first idle fire and only re-arms on pointerdown/keydown. Overnight ceiling = 1, by design.
2. **Acts are reason-only**: "Do not run any tools" hardcoded in both directives
   (autopilot.js:196,273). Max overnight output = one text draft (its own self-review called one
   "Busywork"). Leash cap 3/day on top.
3. **The scheduler is a webview setInterval** (autopilotstore.js:229) with state in localStorage —
   sleep/throttle/restart kills autonomy silently. Nothing server-side drives idle work.
4. **leashPerDay is decorative** — no runtime enforcement anywhere; conversely cron ignores the
   dial entirely (routines fire even at initiative 'wait').
5. **Cron lease timeout duplicates long runs**: maxRunMs 8min < a real research run → live run
   declared zombie, reclaimed, re-fired. LIVE EVIDENCE: daily news routine fired 4× in ~6min on
   2026-07-07 (runs 03f65b81/d5324ce4/fa179d96/be6646e3, one errored).
6. **Silent decisions**: at-capacity deferral event stubbed "pending" (cron-driver.js:237),
   disabled/no-capability skips invisible, autopilot logs nothing about why it did/didn't act.
7. **AutoJobs `proposed` flag is fire-once-per-lifetime** (autojobstore.js:95) — standing-job
   proposals can never re-offer.

**Andrew's locked direction (2026-07-07):** the SOUL is dossier/understanding-driven improv —
the agent digests what the user actually works on daily (runs, chats, projects, habits, values)
and self-generates genuinely useful needle-moving work. NO explicit night queue ("that's just a
cron with extra steps"). Acts = REAL tool runs confined to the jail. Pacing = steady beats,
leash-capped. Deliverable shape = "while you were gone I finished X — approve and I'll ship"
(approve/deny; deny feeds learning). Simple, powerful.

**Lane queue (claim in-file before building; shared/events.js changes are additive-only via its
owner):**

**ALL FIVE LANES MERGED 2026-07-07 (same day as diagnosis)** — NS-0 night-core · NS-1
night-shift · NS-3 night-hands · NS-4 night-report · NS-2 night-brain. Gates green after
every merge (final trunk: test:fast 266 + test:http full). **Composed live proof on merged
trunk (orchestrator-run, no force-fire):** seeded activity + mock provider + shrunk knobs,
posture free/sandbox/leash 3, zero user input → the SCHEDULED driver fired 3 real tool-run
beats at steady cadence, each built a real artifact in the workshop jail (3 jail dirs on
disk), the 4th tick declined binding:'leash', and /api/autonomy/ledger tells the entire
night truthfully (present→act/outcome→cooldown→leash). The overnight-1-task failure mode is
structurally gone: server-owned timer (webview demoted to EARN-only), restart-resume state,
enforced leash, multi-beat cadence, every decision ledgered.

**Residuals (honest):**
- End-to-end beat with a REAL keyed provider not yet observed (all lanes + orchestrator
  proved against mock providers per repo convention; first real overnight = the true test).
- NS-4 morning-report beat proven via real modules against a live sidecar in a node/vm shim —
  rendered-canvas DOM round-trip in the installed app still worth one attended morning.
- Workshop "kept vs discarded" context only joins night-shift deliverables, not user-workshop
  verdicts (no clean title+verdict source; NS-2 report).
- PRODUCT FORK for Andrew: should reach ≥ sandbox auto-imply the away-workshop write grant?
  Kept separate (no silent consent widening) — dial 'build'/'free' still needs the workshop
  grant once before night acts can write. Flip = ~5 lines in the posture write handler.

- **NS-0 · truth first (small, immediate):** (a) cron lease HEARTBEAT — renew while the run is
  provably alive, reclaim only on dead heartbeat; kills the duplicate-fire storm (test: run
  longer than maxRunMs fires exactly once). (b) emit the stubbed skip/defer reasons
  (at-capacity, disabled, no-capability) — needs the governed event-enum addition. (c) autonomy
  DECISION LEDGER: every beat records inputs + outcome (acted/earned/declined + which gate
  bound) durably; morning-readable. Truthful-telemetry law: if the dial shows "free", the
  station must be able to prove what it did with that freedom.
- **NS-1 · sidecar night-shift driver:** move the loop out of the webview. Server-owned
  away-detection (last user-triggered activity, frontend beacons on input; NOT DOM-only),
  beat attempt every ~30–60min while away, leash enforced + persisted server-side (survives
  restart), respects E-STOP/budget caps/same-agent mutex. Dial posture synced to sidecar
  (POST /api/autonomy/write exists). Frontend autopilot demotes to UI + activity beacon;
  `armed` one-shot logic retired. AutoJobs `proposed` fire-once reworked (re-offer on cadence).
- **NS-2 · the brain (understanding-fed improv):** context-pack builder — digest of recent runs
  /chat topics/projects touched/dossier dims/approve-deny history feeds the propose step, so
  grounding = what the user ACTUALLY did lately, not 6 static dossier strings. Reuse the pure
  propose→grounding-veto→score→select pipeline (autopilot.js) with the richer evidence; keep
  the confidence gate + learn-weights (deny = down-weight archetype).
- **NS-3 · real hands + approve-to-ship:** selected job executes as a REAL runOnce task run
  (surface 'autonomous', isTask), reach-gated: sandbox = jailed writes (workshop/cabinet) +
  web read; NEVER send/publish/spend (consent default-deny stays). Deliverable lands as a
  return card: "finished X while you were gone — approve to ship" with open-it action;
  approve = apply/unjail, deny = one-tap reason → NS-2 learning.
- **NS-4 · morning report + honest dial:** one welcome-back beat (one at a time law): what ran,
  what it built (open links), what it declined and WHY (from the ledger), one-tap undo
  (digestSummary/undo snapshot plumbing exists in autopilot.js B3). Dial copy updated to match
  enforced reality; GA-9/GB-13 routine UI items pair naturally here.

Done means (per lane, live-app): leave the station idle with dial at 'free' + dev clock/short
beat interval → observe ≥2 real jailed tool-run deliverables + a truthful ledger of every
decision, gate green. NS-0a done means the >8min-run duplicate repro fires once.

## NIGHT SHIFT wave 2 — relevance, not just autonomy (added 2026-07-08, Fable session)

**The gap (code-verified 2026-07-08):** NS-0..NS-4 made the shift *reliable and safe*
(server-owned beats, enforced leash, jailed real tool runs, grounding veto, ledger, morning
report — all release-grade). What it did NOT make is *relevant*. Andrew's bar: "I come back
and the agent found bugs in MY project" / "it picked an idea we talked about and prototyped
it." Structurally impossible today because:

1. **The agent never sees the user's actual work.** Context pack = run TITLES + chat
   FIRST-LINES (contextpack.js, labels-not-documents by design) + 6 dossier dims. No file,
   repo, diff, or document is ever read. Jail builds are greenfield-only.
2. **No durable idea memory.** Candidates are regenerated from scratch every beat; "things
   the user mentioned but never did" is stored NOWHERE server-side. Rejected-idea history
   (suggeststore/curiositystore) is frontend localStorage, invisible to autonomy.
3. **Behavioral signals stranded in the browser.** worksignal capability histogram,
   ProfileStore interests, UnderstandingStore — zero sidecar sync (no fetch in
   worksignalstore.js). Autonomy is blind to the richest "what does this user actually do"
   data in the product.
4. **Cron is the thinnest lane** — no context pack, no history; dossier block + goal note only.

**Lane queue (claim in-file before building; shared/events.js additive-only via owner):**

- **NS-5 · Project Lens core — ✅ MERGED 2026-07-08 (agent/ns5-path-trust → b6ef5092, gates fast 279 + http full green; live e2e vs real sidecar: one prompt → always → read → grant listed → restart survives → revoke re-prompts). Direction was LOCKED: no prop/picker, Hermes-fluid. OPEN: autonomous hard-deny proven at unit layer only (no live autonomous HTTP drive); consent card render not screenshotted; night-shift CONSUMPTION of blessed roots = part of the NS-5b lane (focus resolver picks the root, beats scan it).** The user just *tells* the agent a path in chat
  ("go to C:\...\myproject and fix X") and it works there. Mechanics (verified 2026-07-08:
  fs.js:73 rejects ALL absolute paths; permgrants GRANTABLE = ['cabinet:write'] only — this
  is a new capability, not a UX swap):
  (a) **Conversational path trust** — first time a run touches a path outside the jail, ONE
  consent prompt ("work in C:\...\myproject? always/once/no"); "always" records a standing
  PATH grant (provenance-stamped, listed + revocable in the Permissions Panel, same
  fail-closed persist as permgrants). resolveInside generalizes to resolve-inside-any-
  blessed-root; .env/.git-internals/symlink-escape hardlines stay.
  (b) **Known-project memory** — every blessed root is durably remembered server-side with
  last-touched metadata; this set IS the autonomy surface.
  (c) **Night shift may only revisit previously-blessed roots** — reads at reach ≥ sandbox
  (git log/status/diff since last visit, TODO/FIXME, run tests via existing jailed exec
  rules); it can NEVER bless a new root unattended. Deliverable = patch through the existing
  /pending → /decide gate: "found N bugs while you were away — approve and I'll commit."
  Approve applies to a branch in the user's repo (never main, never push); deny feeds learn.
  OPEN (Andrew, small): approve = auto-commit-to-branch (recommended) vs drop-the-.patch.
- **NS-5c · Projects rail — ✅ MERGED 2026-07-08 b635cbab (trunk gates fast 281 + http full green).** SESSIONS↔PROJECTS toggle in the rail head; PROJECTS view lists GET /api/projects in the .ws-row vocabulary (git badge + last-touched); blessed:false rows render REVOKED (never hidden). + ADD → POST /api/projects/bless (new interactive-only route, pure projectbless.js core; native Tauri picker if the shell exposes one — it does not yet, so typed-path fallback like the KEEP flow, no allowlist widened). Row click jumps into a session anchored to the root (Chat.prefill 'work in <path> —'). Remove revokes the path grant via the existing /api/permissions/revoke; list mirrors the grant store. Live-proven in the dev app (:8879 DOM round-trips): toggle→ADD subdir→resolves git root→row blessed w/ git+now→same grant in /api/permissions→jump-in seeds session+composer→remove→grant gone server-side→row flips REVOKED. Tests: projectbless (16) + projects-view (32) + e2e.pathtrust bless route (live). OPEN: desktop native folder dialog (starnet_pick_folder not implemented in the shipped Tauri shell — falls back to typed path).
- **NS-5b · Focus resolver — ✅ MERGED 2026-07-08 (agent/ns5b-focus → 9fc6fccc, trunk gates fast 285 + http full green;
  full test:http green incl. a new live e2e). Landed: pure resolver sidecar/nightfocus.js
  (evidence-ranked single priority, steer-outranks-derived w/ ~7d stale, day-keyed persist) ·
  directive LEADS "TONIGHT'S FOCUS: <ref> — because <evidence>" (autopilot.js, reason + V2) +
  same-night compounding block · bounded harness PROJECT SNAPSHOT scan sidecar/projectscan.js
  (consults blessedRoots() directly, NEVER blesses; its lines join the grounding-veto pool) ·
  project deliverable = a .patch in the jail; decide KEEP git-applies to a NEW branch
  ns/<date>-<slug> (never main/master, never push, clean-tree only, apply-failure reported
  honestly — sidecar/nightpatch.js + applyNightPatch) · durable steer POST/DELETE
  /api/nightshift/focus (no consent widening) · morning report + status carry the focus.
  LIVE-PROVEN vs a real sidecar + real git repo (test/nightshift-focus.e2e.test.js): beat
  declares focus citing evidence → patch in /pending → keep applies to an ns/ branch verified
  with git (original branch untouched) → discard wipes → steer sets/clears → focus persists.
  OPEN: driver-timer idle path unit-only (e2e force-fires via the sanctioned /api/nightshift/beat
  proxy); no frontend steer UI (route only); real-provider overnight unrun.**
- **NS-6 · Thread ledger — ✅ MERGED 2026-07-08 (agent/ns6-threads → fd4a6adf, gates fast 277 + http full green; e2e proves mine→stash→keep→propose→picked→discard→declined vs the real sidecar). OPEN: frontend turn-in card (reuse study card family + beat arbiter, fetch on agent.run.end) · real-provider mining run.** Server-side store of "threads": ideas
  mined from chats/study/pitches with state open/picked/delivered/declined + decline reason.
  Mint via a post-run aux pass (same pattern as reflect/study, stash → turn-in) and/or a
  nightly digest pass. Night-shift PROPOSE draws from open threads FIRST, improv second;
  deny/discard writes back permanently (kills the re-propose-rejected-idea failure mode).
  This is what makes "you mentioned X two weeks ago, here's a prototype" possible.
- **NS-7 · Signal sync.** Mirror worksignal histogram + profile interests + declined-idea
  fingerprints to the sidecar (same pattern as POST /api/autonomy/posture and /api/dossier);
  fold into the context pack + grounding-veto vocabulary.
- **NS-8 · One commander-context composer.** Unify dossier + goals + context pack + recall +
  threads into a single server-side composer used by ALL autonomous lanes (night-shift AND
  cron). Deepen chat mining beyond first-lines to a redacted topic digest.
- **NS-9 · Learning depth ("gets better over time" is real, not decorative).** Today the ONLY
  learn signal is per-archetype up/down weights capped ±0.5 (autopilot.js learnFold) — a deny
  teaches "less of that CATEGORY," never "not that idea / not that project / here's why."
  Build: (a) approve/deny captures an optional one-tap reason (wrong-thing / wrong-time /
  bad-quality / did-it-myself); (b) verdicts + reasons fold into the thread ledger (NS-6) at
  idea level and the context pack at project level; (c) the PROPOSE prompt cites past verdict
  patterns ("you kept the last 3 test-fix patches, discarded both blog drafts"). North-star
  product test (the Andrew framing, 2026-07-08): *the ceiling on autonomous relevance must be
  the user's granted context, never the architecture — and relevance must measurably compound
  with weeks of use.* Done means: same seeded station, 10 simulated beat/verdict cycles →
  proposal mix provably shifts toward kept-kind work (assertable from ledger + learn state).

Done means (per lane, live-app): NS-5 = grant a real repo, seed a planted bug, leave idle at
dial 'free' → morning report offers a correct patch through /pending, approve applies it to a
branch, deny is remembered. NS-6 = mention an idea in chat, never act on it, leave idle →
a beat proposes THAT idea, citing the thread; decline it → it is never re-proposed.

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
