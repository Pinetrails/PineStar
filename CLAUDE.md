# StarNet harness — multi-agent operating protocol

This project is built by **many agents at once** (commonly 7–10). This file is the contract
that keeps them from overwriting each other. Read it before you touch anything.

**Orientation (the project brain):** [docs/BRAIN.md](docs/BRAIN.md) — what StarNet is,
architecture, where truth lives. Then [docs/DECISIONS.md](docs/DECISIONS.md) (locked
decisions), [docs/MISTAKES.md](docs/MISTAKES.md) (recurring failures), and
[docs/NEXT.md](docs/NEXT.md) (current priorities + task queue).

## Prime directive

You are ONE of many agents working this repo simultaneously. **Stay inside your own
workspace and never clobber another agent's.** Overlap that isn't caught becomes silent
data loss — that is the single failure mode this protocol exists to prevent.

## Where work happens

- **Integration tree** — `C:\Users\andro\Desktop\gen` on branch `feat/harness-backend`.
  This is the **trunk**: the place branches MERGE INTO. Do **not** do feature editing here.
- **Your workspace** — a git *worktree* at `C:\Users\andro\gen-trees\<name>` on branch
  `agent/<name>`. ALL your editing and committing happens there, in isolation.
- **The live registry** — run `git worktree list` to see every active workspace and which
  branch each is on. That is the source of truth for "who is working where."

## Before you start

1. Run `git worktree list`. If a worktree was assigned to you, `cd` into it and work on its
   `agent/<name>` branch.
2. If you have no worktree, create one — from `C:\Users\andro\gen-trees`:
   `.\new-agent-tree.ps1 <short-task-name>` — then work in the new directory.
3. **Never** open, edit, or commit inside a directory another agent's session is using.
   One agent per worktree, always.

## The rules (non-negotiable)

1. **One agent per worktree.** Never edit another agent's worktree or `agent/*` branch.
2. **Never feature-edit the integration tree directly.** Branch a worktree off it instead.
3. **Commit small, commit often, commit only YOUR files.** Use pathspecs
   (`git add path/to/file ...`). Never `git add -A` / `git add .` — that sweeps up other
   agents' in-flight work.
4. **The shared contract is owned.** `shared/events.js` and `shared/schema.js` are the files
   everything depends on. They are owned by ONE agent (currently the `cortex-memory`
   workstream). Changes there must be **additive only** (new events/fields — never rename or
   remove). If you need a change, request it from the owner; do not edit these yourself.
5. **Green before merge.** `npm run test:fast` must pass fully before your branch merges into
   `feat/harness-backend`.
6. **Sync before merge.** Rebase your branch onto trunk first (`sync-agent-tree.ps1`) so any
   conflict surfaces in YOUR worktree, not on the shared trunk.

## Commands

| Need                        | Command                                                          |
| --------------------------- | --------------------------------------------------------------- |
| Create your workspace       | `gen-trees\new-agent-tree.ps1 <name>`                           |
| Pull latest trunk into it   | `gen-trees\sync-agent-tree.ps1 <name>`                          |
| Run the test gate           | `npm run test:fast`                                             |
| Merge your branch to trunk  | (from integration tree) `git merge agent/<name>` then test gate |
| Tear down when merged       | `gen-trees\remove-agent-tree.ps1 <name> -DeleteBranch`         |

## Operating doctrine — MANDATORY skills (all models)

This repo ships its senior engineer's judgment as skills in `.claude/skills/`. They are not
optional reading; they encode the project's locked decisions and recurring failure modes.

1. **Before your first edit on any task**, invoke the Skill tool with `starnet-task-doctrine`
   and follow it. It routes you to the others:
   - `starnet-verify` — before claiming ANYTHING done (live-app proof, canvas gotchas).
   - `starnet-frontend-law` — any change under frontend/ or to the rendered world.
   - `starnet-backend-law` — any change under sidecar/ or shared/.
   - `starnet-debugging` — when a behavior is broken and the cause is unknown.
   - `starnet-merge-ritual` — when integrating any branch into trunk.
2. The two laws that override everything else: **only claim what you verified live**, and
   **the app must never assert state the harness can't prove** (truthful telemetry).

## Why this is set up this way

Many agents sharing a single checkout overwrite each other with no warning (last-write-wins;
git never even sees a conflict because it's all one uncommitted tree). Separate worktrees turn
that invisible overlap into **visible, resolvable merge conflicts**. The full control-plane
doc (with the migration steps and gotchas) lives at `C:\Users\andro\gen-trees\README.md`.
