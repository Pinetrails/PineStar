# StarNet Launch Checklist

One page. Every public-facing artifact and its status, so launch day is a checklist — not a
memory test. Update the Status column as things land.

_Last updated: 2026-07-03._

## Release channel

Public releases repo: **`nonfungiblefunyuns-ship-it/starnet-releases`**
Updater endpoint (baked into the app, `src-tauri/tauri.conf.json`):
`https://github.com/nonfungiblefunyuns-ship-it/starnet-releases/releases/latest/download/latest.json`

## Artifacts

| # | Artifact | Location | Status | Notes |
| - | --- | --- | --- | --- |
| 1 | **Installer** `StarNet_<ver>_x64-setup.exe` | GitHub release asset | ☐ TODO | Windows x64 NSIS. Currently **unsigned** — SmartScreen/SAC caveats apply (see INSTALL.md). |
| 2 | **`latest.json`** update manifest | GitHub release asset (root of endpoint above) | ☐ TODO | Must be uploaded to each release; signed against the pubkey baked in `tauri.conf.json`. |
| 3 | **Updater signature key** | `~/.tauri/starnet-updater.key` (Andrew's machine) | ☐ VERIFY | Pubkey is committed in `tauri.conf.json`; private key must sign every `latest.json`. |
| 4 | **INSTALL.md** | repo root — SHIPPED on trunk | ✅ DONE | SmartScreen + SAC honesty; download + update + uninstall. Public copy must match repo. |
| 5 | **PRIVACY.md** | repo root | ✅ DRAFTED | Audited 2026-07-03. No telemetry; local-first; keychain vs plaintext honest. |
| 6 | **TERMS.md** | repo root | ✅ DRAFTED | As-is, BYOK spend responsibility, not affiliated, **LICENSE-DECISION block open**. |
| 7 | **Download page** | `docs/DOWNLOAD_PAGE.md` | ✅ DRAFTED | Paste into static host / release README. Links INSTALL/PRIVACY/TERMS. |
| 8 | **Screenshots / demo clip** | — | ☐ TODO | Placeholder block in DOWNLOAD_PAGE.md. Real running-station media required. |

## Blocking swaps before public launch

| Item | What to do | Status |
| --- | --- | --- |
| **Support email** | ✅ DONE 2026-07-04: `androo.agi@gmail.com` in diagnostics.js + PRIVACY.md + TERMS.md + DOWNLOAD_PAGE.md (Andrew's pick; supersedes the earlier gmail swap). | ✅ DONE |
| **License decision** | ✅ DONE 2026-07-04: MIT. `LICENSE` at repo root; TERMS.md §7 points to it. | ✅ DONE |
| **Code signing** (optional but removes the SmartScreen/SAC wall) | Procure an Authenticode cert; sign the installer. Until then INSTALL.md + DOWNLOAD_PAGE.md must keep the unsigned caveat. | ☐ FUTURE |

## Cut & publish order (the installer bakes the frontend — order matters)

1. **Swap the support email first** (it lives in `frontend/app/diagnostics.js`, which ships
   inside the exe — an installer cut before the swap shows the literal placeholder to users).
2. **Re-cut LAST**: `npm run release:cut` immediately before upload. A staged installer goes
   stale the moment trunk moves (this bit us on 2026-07-03: the 23:02 cut predated four
   same-night merges). Trunk is multi-session — always re-cut, never trust `release/` dates.
3. Upload + publish the GitHub release (exact tag `vX.Y.Z`), then `npm run release:verify-host`.
4. **Unattended-update proof — mind the legacy-endpoint trap**: installs ≤0.1.7 have the DEAD
   `updates.starnet.app` endpoint baked in and will NEVER see GitHub releases. They need one
   manual (re)install. The real proof of the update loop: manually install the first
   GitHub-era build, then publish a trivial next version and watch System → Updates apply it
   unattended. Do this once before telling the public updates work.

## Consistency gates (do NOT ship until true)

- ☐ SmartScreen / SAC wording is **identical in spirit** across INSTALL.md and DOWNLOAD_PAGE.md
  (unsigned build, "More info → Run anyway", SAC is a hard block).
- ☐ The `latest.json` uploaded matches the version of the installer asset in the same release.
- ☐ `ANDREW_SUPPORT_EMAIL` no longer appears anywhere (grep returns nothing).
- ☐ `LICENSE` file exists and TERMS.md §7 points to it.
- ☐ PRIVACY.md claims still true after any last-minute code changes (re-audit if network or
  storage code changed: providers, channels, Spotify, updater endpoint, keychain paths).
- ☐ `npm run test:fast` green on the release commit.

## Quick verification commands

```bash
# support-email placeholder must be gone before launch — NOT just docs:
# it is also a frontend constant (frontend/app/diagnostics.js) BAKED INTO the exe.
grep -rn "ANDREW_SUPPORT_EMAIL" --include="*.md" --include="*.js" .

# confirm the updater endpoint the app will actually hit:
grep -n "endpoints" -A2 src-tauri/tauri.conf.json

# test gate:
npm run test:fast
```
