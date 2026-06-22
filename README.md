# ▲ STARNET — Real Gamified AI-Agent Harness

A **real**, downloadable desktop app where you create AI agents, raise them through a gamified
onboarding, and watch them do real work — real model calls, real tools, real cost — inside a living
pixel-art station **you build yourself**.

It's a **station builder**: you spawn into one shabby starter room and expand outward — placing rooms,
dragging hallways, painting floors, upgrading from rusty to pristine. The twist: **the way you build the
station literally configures your real multi-agent org.** A room is a capability-scoped team, a hallway is
an authorized handoff lane, a placed object is a real capability grant — projected onto the agent's allowed
tools every turn (`sidecar/capability/resolve.js`). The layout you draw *is* the workflow the agents run.

You start with **one** real agent; place bays or summon specialists to run **more, concurrently** — each a
genuinely distinct, bounded agent run, not a cosmetic sprite.

## Quick start

**Requirements:** [Node.js](https://nodejs.org) 18+ (the sidecar uses only Node core modules — no
`npm install` needed to run it). To build the desktop installer you additionally need Rust + the Tauri CLI.

```bash
# 1. run the harness (the Node sidecar serves the frontend AND the agent runtime)
node sidecar/index.js
# then open http://localhost:8787 and connect:
#   • bring your own OpenRouter API key (BYOK), or
#   • sign in with a ChatGPT subscription (Codex OAuth)

# 2. run the headless test gate
npm run test:fast

# 3. (optional) build the Windows desktop app — Tauri shell around the sidecar
npm run desktop:dev      # run the desktop shell against your source
npm run desktop:build    # produce the NSIS installer
```

> Data (agent memory, spend ledger, saves, secrets) is stored per-user under your OS app-data dir
> (`%LOCALAPPDATA%\StarNet` on Windows). Secrets are held by the sidecar / OS keychain, never in the frontend.

## How it works (the one-line bet)

Keep v7 StarNet's entire vanilla-JS canvas world (renderer, tile map, movement/sit/work state machine, sprite
recolor, CRT theme) and make it real by replacing the simulation with a **thin bridge that re-emits real
agent-runtime events** onto the same `U.bus` event vocabulary the frontend already listens for. The agent
loop, tools (web/files/notebook/MCP connectors), cost accounting, memory (Cortex), and budget governance
all live in the **Node sidecar**.

## Stack

Tauri desktop shell · Node.js agent-host sidecar (owns secrets) · OpenRouter as the default model gateway
(plus ChatGPT-subscription via Codex OAuth) · **JSON-file persistence on disk** (a SQLite store is planned) ·
**newline-delimited JSON over localhost HTTP** for the run stream, with SSE for channel/work-item telemetry,
carrying the frozen `U.bus` event schema (`shared/events.js`).

## Design history

The original product + architecture plans (written before the build) live alongside the code and are kept
as design history, not as the entry point:

- **[SKYNET_BUILD_PLAN.md](SKYNET_BUILD_PLAN.md)** — product plan: locked decisions, the object→capability
  abstraction, onboarding, monetization.
- **[BUILDER_AND_WORLD_FOUNDATION.md](BUILDER_AND_WORLD_FOUNDATION.md)** — the `Station` data model, Mutation
  API, save versioning, renderer, and station-as-workflow.
- **[INCREMENTAL_ROADMAP.md](INCREMENTAL_ROADMAP.md)** — the step-by-step port order with per-step DoD.
- **[docs/](docs/)** — subsystem analysis, design proposals, and the memory/context (Cortex), cron, and
  channels integration plans.

## Source project

The v7 StarNet simulation this was grown from lives at `../v7` — we copied its engine + assets in unchanged.
