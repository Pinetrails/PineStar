# HOLD — do not merge this branch to trunk

Branch: `claude/starnet-subscription-complete-e95ae8`
Held by: Andrew, 2026-07-27 — *"keep this separated from starnet for a while as i dont plan on
adding this in until after the update that comes out tomorrow."*

**This file exists so the hold survives a session ending.** The instruction lives in a chat log that
the next agent will not read; a merge ritual that starts with a `git log` will read this.

## What is held here

The StarNet Credits client half: device linking, the `starnet` managed provider, the STORE plan rows,
the credits-aware provider card, and the download-page billing wording. Five feature commits plus
their claims re-locks.

## What is NOT held — this already ships

Trunk carries, and tomorrow's cut will include, an **inert** credits client that predates this lane:
`sidecar/billing.js`, `sidecar/credits.js`, `frontend/app/seedcredit.js` and `website/pricing.html`.
They are gated and invisible:

- `/api/credits` 404s unless `STARNET_CREDITS_URL` is set, which no shipped build sets, so the STORE
  panel renders nothing at all.
- `website/site.js` has `CREDITS.live = false`, so every transaction button on the pricing page reads
  `[ SOON ]`.

Nothing on trunk offers an account, a purchase, or a link. That is the separated state, and it holds
without this branch.

## Before merging, whenever that is

1. Confirm with Andrew. The hold is his to lift, not a checklist item.
2. `starnet-cloud` must be DEPLOYED first, or the feature reaches nobody — `CLOUD_LIVE` is `false`
   precisely so a link button never points at a service that does not answer.
3. **The launch is four edits across two repos, in an order that matters. Follow
   `starnet-cloud/LAUNCH.md`.** Earlier revisions of this file said "flip two switches together";
   that is now wrong on both count and order — see that document for why.
4. Follow `starnet-merge-ritual`. Hotfiles in this diff: `sidecar/index.js`, `frontend/app/stationui.js`,
   `frontend/app/harness.js`, `frontend/app/app.js`, `frontend/app/modeldock.js`, `qa/product-perfect/claims.json`.
5. The claims re-lock is always its own commit, after the code commit it describes.
6. Delete this file as part of the merge.

## State — RE-SYNCED 2026-08-03, still held

Trunk `fcb0c7fb` merged IN (932 commits of drift; the lane had not been synced since 07-27), so the
merge conflict is resolved HERE rather than on the shared trunk. Four conflicts, all by hand:

- `src-tauri/src/main.rs` — trunk extracted the keychain block into a new `src-tauri/src/credentials.rs`.
  The conflict read as "lane edited a block trunk deleted", and **taking either side alone was wrong**:
  the block moved. The three credits-token functions now live in `credentials.rs` as `pub(crate)`.
- `frontend/app/harness.js` + mirror — export list; a union, not a pick.
- `qa/product-perfect/claims.json` — trunk's copy, then regenerated in its own commit.

**One thing the clean auto-merge got wrong, caught only by the gate:** trunk adopted a law while this
lane sat unsynced — `frontend/app/*.js` may not call a native window dialog — and the STORE's UNLINK
was raising `window.confirm`. Now the house `ArmConfirm` two-step. Git merged that file with no
conflict at all; a clean merge is not a correct merge.

Gate after the sync: `npm run test:fast` **510 steps green** (was 402 at the hold) · claims gate PASS,
192 measured files · `cargo check` clean on the ported Rust.

Live-proven at the hold, unchanged by the sync: link → STARNET card `● LINKED · $75.00 · $50/MO` →
select → real agent turn → `RUN COMPLETE · 3s · $0.0128` against a cloud ledger debit of `$0.012824`.

The hosted half lives in `C:\Users\andro\Desktop\starnet-cloud` (separate repo, no remote by design —
it holds the pricing economics, which must never enter the public repo). `LAUNCH.md` is the runbook,
`DEPLOY.md` the deploy, and `npm run prove` re-derives every money rule against a booted server
(174 tests + 22 checks + the restore drill, all green 2026-08-03).
