# Pine Star repository instructions

This is the persistent working agreement for humans and coding agents. Read [PINE_STAR_CONTROL.md](PINE_STAR_CONTROL.md) and [docs/CURRENT_STATUS.md](docs/CURRENT_STATUS.md) before meaningful work.

## Start every change

- Inspect `git status`, confirm the branch, and inspect relevant code and docs before editing.
- Work on `pine-star` unless explicitly directed otherwise.
- Use a `PS-YYYY-###` Change ID for every intentional Pine Star development change.
- Trace unfamiliar architecture end to end. Code is the authority for implemented behavior; dated plans are history until reverified.

## Git and upstream

- Never modify, move, recreate, retag, or delete `starnet-baseline-0.10.10`.
- Do not rewrite history. Do not push, merge, tag, publish, or commit without explicit instruction.
- Preserve `upstream` as a review source. Never blindly merge upstream; prefer deliberate cherry-picks or adaptations after review.
- Do not erase upstream attribution, licensing, or useful technical history.

## Architecture and implementation

- Preserve working StarNet architecture first; transform gradually for demonstrated Pine Star needs.
- Prefer small, reversible, targeted changes. Avoid unrelated refactors and formatting churn.
- Preserve multi-provider support initially. Do not integrate Hermes without a later recorded approval.
- Test code changes in proportion to risk. Do not hide, weaken, or silently skip failures.
- Distinguish baseline/upstream defects from Pine Star regressions. Record discrepancies rather than invent explanations.
- Never commit secrets, credentials, keys, passwords, tokens, private workspaces, or signing material.

## Autonomy, product, and art

- Follow [docs/AUTONOMY_AND_SAFETY.md](docs/AUTONOMY_AND_SAFETY.md); prefer reversible action.
- No unauthorized spending, trading, purchases, subscriptions, accounts, external publication/messages, security changes, destructive operations, or system-wide changes. Default external spending authority is `$0`.
- Never weaken approval boundaries, audit trails, E-stop controls, financial/security safeguards, or constitutional rules autonomously.
- Separate visible agent names from system roles. Support direct specialist conversation and route work to the lowest capable level.
- Distributable Pine Star branding/art must be original. Never ship StarNet brand assets or copyrighted commercial-game assets.
- Mark future private study assets `REFERENCE / PLACEHOLDER — DO NOT DISTRIBUTE`; release checks should reject remaining placeholders.

## Documentation and handoff

- For meaningful changes, update `docs/CURRENT_STATUS.md`, `CHANGELOG.md`, the change record, and relevant decision/architecture docs.
- Keep `PINE_STAR_CONTROL.md` concise and current. Preserve lessons from failed experiments.
- Record major roadmap changes in `docs/DECISIONS.md`.
- Near a context limit, leave a useful handoff rather than rushing.
- At completion, state **FINISHED** and summarize changes, checks/tests, unresolved issues, and the recommended next step.

