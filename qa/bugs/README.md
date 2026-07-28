# qa/bugs — the durable bug register

One **tracked** markdown file per bug: `<fingerprint>-<slug>.md`. `../BUGS.md` is the
**generated** index over this directory — never hand-edit it, rebuild it.

## Why this exists next to `qa/findings/`

They are different spines and both are needed:

| | `qa/findings/*.json` | `qa/bugs/*.md` (here) |
| --- | --- | --- |
| Written by | detector **scripts** (`scripts/qa/ledger.mjs`) | **sweep lanes** (agents/humans) |
| Tracked in git? | **No** — machine-local | **Yes** — travels with the repo |
| Lifetime | one machine, one run | forever, across worktrees and sessions |
| Job | "did trunk just regress?" | "what is still wrong, and who owns it?" |

Findings are gitignored on purpose: their `evidence[]` paths are absolute `.bugloops/`
artifacts and their triage is ephemeral. That is correct for a detector and fatal for a
hunt — when ten lanes sweep in ten worktrees, every lane re-finds the same defects and
everything dies with the session. **This directory is the hunt's shared memory.**

## Why one file per bug

A single appended register is a hotfile: ten lanes appending rows conflict on every merge.
Distinct filenames never conflict. `../BUGS.md` is generated, so a conflict there is
resolved by regenerating it, never by hand.

## Commands

```bash
node scripts/qa/bugs.mjs --new --title "..." --surface channels --severity P1 --lane sweep/channels
```

```bash
node scripts/qa/bugs.mjs --list --status open --surface channels
```

```bash
node scripts/qa/bugs.mjs --set <fingerprint> --status fixed --fix <commit-sha>
```

```bash
node scripts/qa/bugs.mjs --validate
```

`--validate` runs in `test:fast` (`test/qa-bugs.test.js` guards the logic;
`test/qa-bugs-register.test.js` guards the real on-disk register), so the register cannot rot.

## The laws it enforces

1. **Evidence** — every bug carries a non-empty `## Evidence`. No artifact, no bug.
2. **Repro** — every bug carries a non-empty `## Repro`. A defect nobody can re-trigger can
   never be proven fixed.
3. **No-fake-fixed** — `status: fixed` requires a non-empty `fix:` commit.
4. **Verdict** — `wontfix`/`duplicate` require a written `## Verdict`. A bug leaves the
   backlog fixed, or argued out of it in writing.
5. **Filename authority** — the filename must be `<fingerprint>-<slug>.md` and the
   frontmatter must agree.
6. **No duplicates**, and no `open` bug whose fingerprint sits on the `../KNOWN_ISSUES.md`
   baseline (anti-nag — accept it or retire the baseline row).

Identity is **(surface + slug)**, frozen at creation. Re-wording a title never re-keys a bug.
