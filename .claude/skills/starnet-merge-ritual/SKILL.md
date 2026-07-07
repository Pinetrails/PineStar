---
name: starnet-merge-ritual
description: The full ritual for merging an agent branch into trunk feat/harness-backend — snapshot, merge-vs-rebase rules, hotfile hazards, gate, rollback. Use whenever integrating any branch to trunk.
---

# Merging to trunk — the ritual (no steps optional)

Trunk = `feat/harness-backend` in the integration tree. It is the serialization point; one
merge at a time, always from the integration tree.

## Per branch
1. **Snapshot:** record trunk SHA — this is your reset point.
2. **Merge, never rebase, any branch a live session (Codex or a loop) may still commit to.**
   Rebasing a live branch orphans their in-flight commits. Only small, provably-dead branches
   may sync-rebase (`sync-agent-tree.ps1`) first.
3. **Prefer conflicts to auto-merge on hotfiles.** The no-touch/high-risk set: sidecar
   loop.js, billing.js, budget.js, routing/router.js, station-store.js, orchestration.js,
   frontend worldmodel.js, build.js, package.json, and their tests. After ANY merge touching
   one:
   - `node --check` the file;
   - grep that every symbol it calls/exports is still defined exactly once (auto-merge
     silently drops and duplicates functions here — this has happened repeatedly).
4. **package.json conflicts:** union both sides' script/deps entries; trunk order canonical.
   After ANY package.json resolution, verify strict JSON + no BOM:
   `node -e "const b=require('fs').readFileSync('package.json'); if(b[0]===0xEF) throw 'BOM'; JSON.parse(b.toString())"`
   — PowerShell-side edits love to prepend a UTF-8 BOM; npm tolerates it, strict JSON.parse
   consumers (release-cut, tooling) do not. This landed on trunk twice on 2026-07-03.
5. **Gate:** `npm run test:fast` green, plus `npm run test:http` if sidecar/route/ship files
   changed. Red → `git reset --hard <snapshot>`, mark the lane BLOCKED with the failing
   output, and move on. Never merge-then-fix-forward on trunk.
6. **shared/events.js / shared/schema.js in the diff?** Verify the change is purely additive
   (new events/fields only). A rename or removal there fails the merge regardless of tests.
7. **Does the diff move/strip/clear/migrate any credential** (bot token, provider key, OAuth
   token, connector secret, keychain entry)? Then demand the read-back proof: the code must
   verify the new home durably holds the secret BEFORE the old copy is removed, and a test
   must cover the write-failure path. No proof → the merge fails regardless of green tests
   (Telegram-token escape, 2026-07-07; docs/MISTAKES.md "never destroy the last copy").
8. Post-merge: one-line digest (branch → trunk SHA, gate result) to qa/STATUS.md.

## Reaping
Merged + clean worktree → `git worktree remove <path>` + `git branch -d` (`-d` only; if git
refuses, it's not merged — stop). Dirty-but-merged worktrees: leave and flag, never delete.
