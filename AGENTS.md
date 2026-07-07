# StarNet harness — multi-agent operating protocol

This project is built by **many agents at once** (commonly 7–10). This file is the contract
that keeps them from overwriting each other. Read it before you touch anything.

**Orientation:** read [docs/BRAIN.md](docs/BRAIN.md) first (what this is, architecture,
where truth lives), then [docs/DECISIONS.md](docs/DECISIONS.md) (locked — don't re-litigate),
[docs/MISTAKES.md](docs/MISTAKES.md) (don't repeat), and [docs/NEXT.md](docs/NEXT.md)
(current queue). The operating doctrine lives in `.claude/skills/starnet-*` — those files
are plain markdown; non-Claude agents must read `starnet-task-doctrine/SKILL.md` and follow
it too.

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
   everything depends on. Changes there must be **additive only** (new events/fields — never
   rename or remove), and only by request to the owner lane; do not edit these yourself.
5. **Green before merge.** `npm run test:fast` must pass fully before your branch merges into
   `feat/harness-backend`.
6. **Sync before merge.** Rebase your branch onto trunk first (`sync-agent-tree.ps1`) so any
   conflict surfaces in YOUR worktree, not on the shared trunk. (Exception: Codex-authored
   branches are MERGED, never rebased — see `.claude/skills/starnet-merge-ritual`.)

## The two laws above everything

- **Only claim what you verified in the live running app** (tests green ≠ done).
- **The app must never assert state the harness can't prove** (truthful telemetry).

## Commands

| Need                        | Command                                                          |
| --------------------------- | --------------------------------------------------------------- |
| Create your workspace       | `gen-trees\new-agent-tree.ps1 <name>`                           |
| Pull latest trunk into it   | `gen-trees\sync-agent-tree.ps1 <name>`                          |
| Run the test gate           | `npm run test:fast`                                             |
| Run the app for live proof  | `node dev/seed.js --keep` (dev-seeded; NEVER `npm run serve`)   |
| Merge your branch to trunk  | (from integration tree) `git merge agent/<name>` then test gate |
| Tear down when merged       | `gen-trees\remove-agent-tree.ps1 <name> -DeleteBranch`         |

## Why this is set up this way

Many agents sharing a single checkout overwrite each other with no warning (last-write-wins;
git never even sees a conflict because it's all one uncommitted tree). Separate worktrees turn
that invisible overlap into **visible, resolvable merge conflicts**. The full control-plane
doc (with the migration steps and gotchas) lives at `C:\Users\andro\gen-trees\README.md`
(note: its "current worktree map" section is stale — trust `git worktree list`).
