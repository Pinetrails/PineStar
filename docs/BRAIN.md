# BRAIN.md — start here

**The 5-minute orientation for any agent session (Claude, Codex, or human) opening this repo.**
Last full reconciliation: **2026-07-06** (grounded against trunk + git log, not doc claims).

## What this is

**StarNet** — a real, local-first AI-agent harness wrapped in a living pixel-art space
station, shipped as a downloadable desktop app. You create agents, build the station, and
the layout IS the org: rooms = capability scopes, placed props = real tool grants
(**object = capability**), conveyor items = real work. The core product law is **truthful
telemetry**: the UI never asserts anything the harness can't prove.

- Thesis: a beginners product — sandbox freedom, real work, Factorio-style pride loop.
- Lineage: UltronOS (banned from Claude API 2026-04-04) → "v7" fake sim → this real harness
  (reuses v7's canvas + U.bus). Rebranded Skynet→StarNet 2026-06-22; internal `skynet.*`
  keys are intentionally kept.
- Current shipped desktop version: **v0.2.2** staged as a signed 4-platform draft on the
  private `starnet-releases` repo; Andrew's installed app ~0.2.4-dev. Repo `package.json`
  stays `0.0.0` (versions live in `src-tauri/tauri.conf.json` + `Cargo.toml`).

## Architecture in one screen

```
npm start  →  node sidecar/index.js  (ONE process, port 8787)
              ├─ sidecar/loop.js      runAgentLoop() — THE agentic loop (messages array,
              │                       tool accumulation/repair; stateless between runs)
              ├─ sidecar/index.js     HTTP + SSE server (~6.5k lines) — /api/run, serves
              │                       frontend/, emits frozen U.bus events as ndjson
              ├─ providers/           anthropic, openrouter, openai-compat, codex(OAuth), gemini
              ├─ capability/          station layout → tool allowlist (object=capability)
              ├─ tools/ (14)          web/browser/computer/fs/shell/notebook/recall/skills/…
              ├─ channels/            telegram, discord, SSE hub, keychain-split secrets
              ├─ mcp/                 MCP connector manager + curated catalog + OAuth 2.1
              ├─ cron*.js             schedules → real runs (auto-notify to channels)
              └─ *-store.js (10+)     atomic fsync-rename persistence per subsystem

frontend/  (no build step; index.html loads ~80 app/*.js modules in order)
              ├─ app/world.js (~5.6k) canvas station renderer — hero agent + crew[] bodies
              ├─ app/app.js           U.bus wiring, roster, run state (frontend OWNS roster)
              ├─ app/chat.js          COMMS window, streaming, beats
              └─ app/*                dossier, quests, recruiter, build mode, stores, voice…

shared/    FROZEN contract — events.js (~60 event types) + schema.js validator.
           OWNED files: additive changes only, by request to the owner lane.

src-tauri/ desktop shell (Tauri 2, NSIS/dmg, embedded node, keyring; updater feeds from
           GitHub Releases: nonfungiblefunyuns-ship-it/starnet-releases)
```

Most bugs are **seam bugs**: emitter → store → renderer. Trace the full path before editing.

### Task-context elicitation (2026-07-15)

Interactive COMMS and messaging-channel tasks pass through one intent layer in `runOnce`. The model
proceeds immediately when context is sufficient; only a materially outcome-changing, non-discoverable
gap may produce one `TASK_QUESTION` with 2–3 choices (two questions maximum for the whole task, with
the second reserved for a newly exposed blocker). COMMS strips the protocol into a natural one-tap
choice; text channels render numbered choices. The answer resumes the same durable Task Brief, survives
reload/restart, and is injected into delegated workers. Task-local answers never silently become global
dossier beliefs; only an identical decision repeated across two completed briefs appears later as
bounded, explicitly weak relationship evidence. Unattended cron and night-shift runs remain unchanged.

## How to work here (non-negotiable)

1. **Read `CLAUDE.md`** (repo root) — the multi-agent worktree protocol. You are one of many
   concurrent agents; work in your own worktree under `C:\Users\andro\gen-trees\`, never
   feature-edit the integration tree (`C:\Users\andro\Desktop\gen`).
2. **Invoke the skills** in `.claude/skills/` — `starnet-task-doctrine` first, always;
   then the law skill for your area (frontend/backend), `starnet-verify` before claiming
   done, `starnet-merge-ritual` to integrate. They encode the locked judgment; they win
   over anything conflicting in older docs.
3. **Gate:** `npm run test:fast` (~254 steps) green before merge. Live-app verification via
   `node dev/seed.js --keep` (pre-onboarded workspace, no ceremony) + preview/CDP DOM
   round-trips (canvas screenshots time out — see MISTAKES.md).
4. Read [DECISIONS.md](DECISIONS.md) (locked, don't re-litigate) and
   [MISTAKES.md](MISTAKES.md) (don't repeat) before your first edit.
5. Current work queue: [NEXT.md](NEXT.md).

## Where truth lives (in freshness order)

| Question | Source of truth |
| --- | --- |
| What just happened on trunk | `git log --oneline` + `qa/digests/` merge digests |
| Is trunk green / app healthy | `npm run qa:guardian` · dashboard `qa/STATUS.md` |
| Known/suppressed defects | `qa/KNOWN_ISSUES.md` (fingerprint ledger) |
| Open findings | `node scripts/qa/ledger.mjs --status` |
| Who is working where | `git worktree list` (18+ unmerged `agent/*` branches exist; many are parked) |
| Current priorities | [NEXT.md](NEXT.md) — reconciled 2026-07-06; re-verify by grep before building |
| What the user saw break | `docs/GROUND_UP_AUDIT_2026-07-06.md` + the two UPDATE_*_AUDIT docs |

**Doc-trust rule:** any doc older than ~a day is a hypothesis. This project merges many
lanes per day; grep trunk before acting on any doc claim, including this file's.

## Doc map (what to read, what to ignore)

**Living (keep current, safe to trust after grep-check):**
`CLAUDE.md`, `AGENTS.md`, this file + `DECISIONS.md` / `MISTAKES.md` / `NEXT.md`,
`.claude/skills/*`, `qa/{STATUS,KNOWN_ISSUES,QA_STATION}.md`, `docs/RELEASE_RUNBOOK.md`,
`INSTALL.md`, `PRIVACY.md`, `TERMS.md`, `NOTICE.md`, `loops/*.md` (QA crew directives),
`scripts/VISUAL_AUDITOR.md`, `CODE_MAP.md` (rebuilt 2026-07-06).

**Recent audits still driving work (2026-07-04..06):** `docs/GROUND_UP_AUDIT_2026-07-06.md`,
`docs/UPDATE_PIPELINE_AUDIT_2026-07-06.md`, `docs/UPDATE_STATE_SAFETY_AUDIT_2026-07-06.md`,
`docs/ROADMAP_2026-07-04_BRUTAL.md` (the strategic 7/30/90 plan),
`docs/POLISH_SPRINT_2026-07-06.md` (7 of 8 lanes already merged — see NEXT.md).

**Historical — do NOT plan from these** (they describe finished or superseded work; kept
for archaeology): `SKYNET_BUILD_PLAN.md`, `INCREMENTAL_ROADMAP.md`, `WIRING_AUDIT.md`,
`BUILDER_AND_WORLD_FOUNDATION.md` (architecture ideas partially adopted; the code is the
authority), `docs/STARNET_HERMES_REPLACEMENT_*` and `docs/STARNET_PHASE*` evidence
templates, `docs/HERMES_*` parity docs, most `docs/*_PLAN.md` files (nearly every plan
doc marked "SHIPPED/EXECUTED" in its header or superseded by the 2026-07-06 audits), and
everything in `docs/archive/`.

When in doubt: the newer date wins, the audit beats the plan, and trunk beats both.

## The biggest bottlenecks right now (brutal, 2026-07-06)

1. **Everything user-facing is bottlenecked on Andrew's ~1 hour of launch chores** — publish
   the releases repo (updater 404s for the public until then), rotate the dev OpenRouter
   key, support email, updater-key offline backup. No code lane can substitute.
2. **Zero outside users** — the 15-min attended playtest (gate 5) and "10 outside installs"
   have been dodged repeatedly; the audit backlog is now lower-value than 5 real user
   sessions.
3. **Unsigned binaries** — SmartScreen/Gatekeeper kill the install funnel; signing identity
   is the single highest-leverage trust purchase (days 8–30 in the roadmap).
4. **18 unmerged `agent/*` branches** — undecided inventory; each is either value to land
   or noise to delete. Triage list in NEXT.md.
5. **Doc sprawl** (~100 md files, most historical) — mitigated by this brain; keep it that
   way by updating NEXT.md instead of writing new plan docs.
