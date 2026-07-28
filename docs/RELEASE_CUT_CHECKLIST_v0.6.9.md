# v0.6.9 cut checklist — prepared 2026-07-27, measured at trunk `1a9aacfd`

> Written as a merge-consistency review of everything that landed **after the v0.6.8 cut**.
> Every line below was measured against the tree, the live GitHub feed or a gate run — not read
> out of a plan doc. `docs/RELEASE_RUNBOOK.md` is the general procedure; this is the
> tonight-specific version.

---

## A. The thing that decides everything else: **v0.6.8 is already live**

| Fact | Measured |
|---|---|
| Latest published release | **v0.6.8**, `androoAGI/starnet-releases`, published **2026-07-27 05:06Z** |
| Assets on it | 9 — win `-setup.exe` + `.sig`, both DMGs, both mac `.app.tar.gz` + `.sig`, `latest.json` |
| Live `latest.json` version | `0.6.8` (`pub_date` 2026-07-27T05:04:06Z) |
| Source tag `v0.6.8` | pushed, at `7af7a1de` — the bump commit. Correct: that IS what was built |
| In-tree version | `0.6.8` in all three files (`package.json`, `tauri.conf.json`, `Cargo.toml`) |
| Commits on trunk since that tag | **~100** (≈52 substantive, the rest qa/claims/status) |

**So the version in the tree is a version that has already shipped.** Cutting from it as-is
produces a build the updater will never offer, because the installed fleet already reports
`0.6.8`. **Tonight's cut is `0.6.9`.**

`scripts/release-bump.mjs` already knows this — it floors the new version against the *highest
published* release, not the in-tree one, and will refuse `0.6.8`. Run it and it does the right
thing.

---

## B. Blocking, in order

1. **⚠ The code-signing certificate expires 2026-07-28.** `CN=Andrew Sims`, issuer
   `Microsoft ID Verified CS AOC CA 03`, via Azure Trusted Signing (`starnet-signing` /
   `starnet-public`, injected in `.github/workflows/release-train.yml`). v0.6.8 stays valid
   because its signature is countersigned by a timestamp authority. **A build signed after the
   expiry date is not signed at all** — every Windows user gets SmartScreen back. If tonight's
   cut runs before it lapses, it signs; if it slips a day, renew first.
2. **Trunk is unpushed.** `origin/feat/harness-backend` is at `436251d1`; local trunk is
   ~66 commits ahead. The release train fires on a pushed `v*` tag and builds *that* tree, so
   the push is not optional — an unpushed trunk means the train builds last night's code.
3. **Release notes.** `RELEASE_NOTES.md` currently holds the **published v0.6.8 copy**, and
   `release:bump` overwrites it with a stub. The v0.6.9 copy — covering everything merged today —
   is drafted at **`docs/RELEASE_NOTES_v0.6.9_DRAFT.md`**. Paste it in *after* the bump.
4. **The live manifest advertises two platforms that do not exist.** `latest.json` on v0.6.8
   lists `linux-x86_64` and `linux-x86_64-deb` pointing at `StarNet_0.6.8_amd64.AppImage` /
   `.deb` — assets that the publish-time strip (Windows + Mac only, per the platforms law)
   removed. Both URLs 404. The train assembles all five platforms and a human deletes the linux
   assets from the draft; nobody re-assembles the manifest afterwards. **This is the v0.6.6 mac
   bug with the axis flipped.** At v0.6.9, after deleting the linux assets, re-assemble with
   `--allow-missing linux-x86_64,linux-x86_64-deb` and re-upload `latest.json`, then prove it:
   `npm run release:verify-host -- --expect-version 0.6.9 --require-platforms windows-x86_64,darwin-aarch64,darwin-x86_64`

---

## C. Gate state at prep time (measured at `1a9aacfd`)

| Gate | Result |
|---|---|
| `npm run test:fast` | **402/402 green** |
| `npm run test:http` | **green, exit 0** |
| claims planning authority | **PASS** — 37 claims, 182 locked surface files |
| `website/app` mirror | in sync (`website-app-sync.test` green) |
| Version fields | consistent across all three files (`0.6.8`, pre-bump) |
| Merge conflict markers in tree | none |

**Gate-reliability fix shipped with this review:** three tests built their fixture directory at a
*fixed* `os.tmpdir()` path and `rm -rf`'d it on entry — `image.test.js`, `autonomy-write.test.js`,
`spotify.store.test.js`. Two gate runs in two worktrees therefore deleted each other's fixtures.
It was caught live: `test/image.test.js` failed on the PNG-magic assertion during this review
while a second `test:fast` was running in another tree, and passed standalone seconds later —
the image is written to a *content-addressed* name, so both runs raced on the same file. All
three now suffix with `process.pid`, like every other test in the directory. **A phantom RED on
merge night costs an hour of chasing product code that was never broken.**

---

## D. The cut, in order

1. Renew / confirm the signing cert (**§B1**) — or accept an unsigned Windows build, deliberately.
2. `git push origin feat/harness-backend`
3. `npm run release:bump 0.6.9` — bumps `package.json`, `package-lock.json`, `tauri.conf.json`,
   `Cargo.toml`, `Cargo.lock`, rewrites `RELEASE_NOTES.md`, commits and tags.
4. Paste `docs/RELEASE_NOTES_v0.6.9_DRAFT.md` into `RELEASE_NOTES.md`, amend the bump commit.
5. Re-lock the claims surface (`RELEASE_NOTES.md` is a locked path) **as its own commit** — the
   audit reads the ledger from the commit, not the worktree.
6. Push the tag → the release train builds Windows + both Macs, signs, and stages a **draft**.
7. On the draft: delete the linux assets, re-assemble and re-upload `latest.json` (**§B4**).
8. Publish. Then `npm run release:verify-host` and an installed-exe update from an older build.
9. Website: `website/site.js`, `index.html`, `pricing.html` now say `0.6.8` (they said `0.6.6`
   through two releases — the live number comes from the GitHub API, this is only the pre-fetch
   fallback). Bump to `0.6.9` at the cut and upload **after** the release is published —
   starnetos.com is a Cloudflare Pages **direct upload**; pushing the branch deploys nothing.

---

## E. What is NOT in this cut

Merged and gated on trunk today, so it ships: wall crown ring · sprite shadow pool · CRT
aperture · CONTROL FLOOR + OS-paints-nothing + input-font floor · PAINT→SURFACE · dossier live
skin preview · COMMS sound board / composer / abort headline / rail layout · Hermes memory
parity (4 gaps) · summon desk seed · skin sit frames + POLISHED install + eye-constrained blink ·
connector "Full access" · folder-card "Full access".

**Built but NOT merged** — none of this ships tonight unless it is merged and gated first:

| Lane | Branch | Ahead |
|---|---|---|
| REACH parity (ACP editor bridge, outbound send) | `claude/starnet-reach-parity-ed4ad7` | 5 |
| Hermes FINAL parity gaps (7.5/8) | `claude/starnet-hermes-gaps-5a71f6` | 19 |
| Conveyor → agentic graphs | `claude/conveyor-agentic-graphs-802819` | 8 |
| Subscriptions / credits gap-close | `claude/starnet-subscription-complete-e95ae8` | 13 |
| LOOP system | `claude/starnet-loop-system-345398` / `missing-looping-system-6e26e6` | 24 / 32 |
| Prop art v6/v7 (bar + crate approved) | `claude/props-visual-improvements-b0ed54` | 4 |
| Prop rotation = yaw (7 conflicts) | `claude/prop-rotation-system-22983e` | 38 |

Extensibility (hooks + MCP + plugins) is also built and unmerged in its own tree.
