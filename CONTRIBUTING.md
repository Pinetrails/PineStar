# Contributing to StarNet

StarNet is a real, downloadable AI-agent harness: a Node sidecar (the agent runtime) that
also serves a vanilla-JS pixel-art station world, wrapped in a Tauri desktop shell. This is
the practical guide to running it, testing it, and working in the repo alongside other agents.

## Run it

The sidecar uses only Node core modules, so no install is needed to run the harness itself:

```bash
node sidecar/index.js          # or: npm start
```

This boots the agent runtime **and** serves the frontend on `http://localhost:8787`. Open that
URL, then connect a model provider — bring your own OpenRouter key (BYOK) or sign in with a
ChatGPT subscription (Codex OAuth). Data (memory, ledger, saves, secrets) is written under your
OS app-data dir; secrets are held by the sidecar / OS keychain, never the frontend.

`npm install` is only needed for the desktop build/dev tooling (the `@tauri-apps/cli`
devDependency); building the installer also needs Rust + the Tauri CLI. See `INSTALL.md` for the
end-user desktop install path.

## Test it

```bash
npm run test:fast     # THE MERGE GATE — must be fully green before any branch merges to trunk
npm run test:http     # the longer HTTP/e2e suite (sidecar boot, runs, cron, channels, workshop)
npm test              # everything: validate + world + fast + http
```

`test:fast` is the gate you must run and pass before merging. `test:http` is the slower
end-to-end suite worth running when you touch sidecar routes or the run stream.

## Repo layout

| Dir          | What it is |
| ------------ | ---------- |
| `frontend/`  | Vanilla-JS canvas + DOM app (the pixel-art station world), served by the sidecar. |
| `sidecar/`   | Node-core-only agent runtime: the run loop, tools, providers, memory, capability projection. |
| `shared/`    | The **FROZEN** cross-boundary event contract (`events.js` + `schema.js`). Additive changes only, and owned — see below. |
| `src-tauri/` | The Tauri desktop shell (Rust) that bundles the sidecar + frontend into an installer. |
| `test/`      | Headless test suites (the gate lives here). |
| `qa/`        | QA harness, ledgers, and capture/audit substrate. |
| `scripts/`   | Build, release, phase-proof, and QA driver scripts. |

## The multi-agent worktree protocol

This repo is built by **many agents at once**. The rule that prevents silent overwrites: one
agent per git worktree, never edit the trunk directly.

- **Trunk** is `feat/harness-backend` — the branch everything merges *into*. Do not feature-edit
  it directly.
- **Your workspace** is a git *worktree* under `gen-trees/`, on branch `agent/<name>`. All your
  editing and committing happens there, in isolation. Run `git worktree list` to see who is
  working where.
- **Commit only your own files, with pathspecs** (`git add path/to/file`). Never `git add -A` or
  `git add .` — that sweeps up other agents' in-flight work.
- **`shared/events.js` and `shared/schema.js` are owned** by one workstream. Never edit them
  yourself; request additive changes (new events/fields — never rename or remove) from the owner.
- **Green before merge:** `npm run test:fast` must pass fully.
- **Sync before merge:** rebase your branch onto trunk first so conflicts surface in *your*
  worktree, not on the shared trunk.

The full control-plane doc (worktree create/sync/remove scripts and gotchas) lives in
`CLAUDE.md` at the repo root.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
`refactor:`, `test:`, `chore:`, with an optional scope, e.g.
`fix(sidecar): guard empty finishReason` or `docs(qa): record merge digest`.

## Engineering doctrine

The senior engineer's judgment for this project ships as skills in `.claude/skills/` — they are
not optional reading; they encode the project's locked decisions and recurring failure modes.
Start with `starnet-task-doctrine` before your first edit on any task; it routes you to the
others (`starnet-verify`, `starnet-frontend-law`, `starnet-backend-law`, `starnet-debugging`,
`starnet-merge-ritual`).

The two laws that override everything else: **only claim what you verified in the live app**,
and **the app must never assert state the harness can't prove** (truthful telemetry).
