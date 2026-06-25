# Cortex Hermes-Superiority Loop

> Active goal: make StarNet's Cortex/memory system stronger than Hermes on the five concrete gaps found in the
> 2026-06-24 comparison. This file is the durable loop brain: every iteration resumes at the first item whose
> condition is not met, works only that item, gates it, updates this file, then advances.

## Loop Rules

1. Work only in `C:\Users\andro\gen-trees\cortex-hermes-plus` on `agent/cortex-hermes-plus`.
2. Address items strictly top to bottom. Do not start item N+1 until item N meets its standard.
3. Every item needs deterministic unit tests plus `npm run test:fast` before it is marked DONE.
4. Favor local, auditable, dependency-light infrastructure before cloud/provider abstractions.
5. Preserve Cortex's moat: provenance, user-visible state, consent/turn-in, and fail-open runtime behavior.
6. Commit each completed item separately with only the touched files staged by pathspec.

## Standards

### 1. FTS-Backed Transcript / Session Search

Status: DONE

Condition is met when StarNet has an agent-callable session search that beats Hermes' `session_search` shape:

- Local full-text index over durable transcript rows.
- Browse recent streams/sessions.
- Discover by query across streams, deduping to session-level hits.
- Read a bounded full session by id.
- Scroll around a stable message id.
- Include match windows plus bookend start/end context.
- Keep the old workstream-scoped `recall_conversation` path working.

### 2. Memory-Provider Lifecycle

Status: TODO

Condition is met when StarNet has a local-first provider interface comparable to Hermes' `MemoryProvider`, with:

- `systemPromptBlock`, `prefetch`, `queuePrefetch`, `syncTurn`, `onTurnStart`, `onSessionEnd`,
  `onSessionSwitch`, `onPreCompress`, `onMemoryWrite`, and provider tool hooks.
- Built-in local Cortex provider implemented through the interface.
- At most one external provider slot, so future Honcho/Mem0-style providers cannot bloat tool surfaces.
- Async background drain/flush behavior that never blocks a user-visible run.

### 3. Hardened Notebook Persistence

Status: TODO

Condition is met when notebook memory is safer than Hermes' `MEMORY.md` / `USER.md` store:

- Hard per-record and per-agent budgets.
- Atomic batch add/edit/forget/pin operations.
- Near-duplicate detection on write/proposal keep.
- File-lock or compare-and-swap protection against concurrent clobber.
- Drift detection for out-of-band edits.
- Existing provenance/trust/use stats preserved.

### 4. Package-Style Skill Memory

Status: TODO

Condition is met when agent-authored skills are more than JSON note bodies:

- Skill packages have `SKILL.md` plus optional `references/`, `templates/`, `scripts/`, and `assets/`.
- Progressive disclosure still holds: list/search summaries first, view body/files on demand.
- Saved skill summaries are auto-searchable/injectable when relevant.
- Skill writes support create, patch, full edit, support-file write/remove, and archive.
- Existing simple `skill.write/list/view` remains backward compatible.

### 5. Background Review / Turn-In Learning

Status: TODO

Condition is met when the learning loop is broader than Hermes while preserving StarNet's consent model:

- Review can run for browser, cron, channel, and delegated surfaces.
- Review produces memory and skill proposals, not silent writes, unless the user explicitly enables auto-keep.
- A bounded background worker owns review queueing, timeout, spend accounting, and drain.
- Turn-in UI/API can accept, edit, discard, snooze, or bulk-resolve proposals.
- Review outcomes feed trust/XP/observability without double-counting.

## Progress Log

- 2026-06-25: Goal created; isolated worktree `agent/cortex-hermes-plus` created.
- 2026-06-25: Item 1 DONE. Added stable transcript message ids, local full-text session discovery,
  browse/read/scroll modes, match windows, bookends, `session_search`, and regression coverage. `npm.cmd run
  test:fast` green.
