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
3. Flip the two switches **together**, in the release you are cutting:
   - `sidecar/index.js` → `CLOUD_LIVE = true` (and `CLOUD_URL_DEFAULT` matching the real domain)
   - `website/site.js` → `CREDITS.live = true`
   The site's buy buttons and the app's link button have to tell the same story on the same day.
4. Follow `starnet-merge-ritual`. Hotfiles in this diff: `sidecar/index.js`, `frontend/app/stationui.js`,
   `frontend/app/harness.js`, `frontend/app/app.js`, `frontend/app/modeldock.js`, `qa/product-perfect/claims.json`.
5. The claims re-lock is always its own commit, after the code commit it describes.
6. Delete this file as part of the merge.

## State at the time of the hold

`npm run test:fast` 402 green · `npm run test:http` green · claims gate PASS.
Live-proven: link → STARNET card `● LINKED · $75.00 · $50/MO` → select → real agent turn →
`RUN COMPLETE · 3s · $0.0128` against a cloud ledger debit of `$0.012824`.

The hosted half lives in `C:\Users\andro\Desktop\starnet-cloud` (separate repo, no remote by design —
it holds the pricing economics, which must never enter the public repo). Its `DEPLOY.md` covers the
deploy; `npm run prove` re-derives every money rule against a booted server.
