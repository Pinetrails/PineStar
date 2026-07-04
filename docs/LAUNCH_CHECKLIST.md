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
| **Support email** | Replace every `ANDREW_SUPPORT_EMAIL` placeholder with the real address. Appears in: PRIVACY.md, TERMS.md, docs/DOWNLOAD_PAGE.md. Grep the repo for `ANDREW_SUPPORT_EMAIL` to catch them all. | ☐ TODO |
| **License decision** | Choose the source-code license, add a `LICENSE` file at repo root, then replace the `LICENSE-DECISION` block in TERMS.md §7 with a real pointer. Until then, no code license is granted. | ☐ TODO |
| **Code signing** (optional but removes the SmartScreen/SAC wall) | Procure an Authenticode cert; sign the installer. Until then INSTALL.md + DOWNLOAD_PAGE.md must keep the unsigned caveat. | ☐ FUTURE |

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
# support-email placeholder must be gone before launch:
grep -rn "ANDREW_SUPPORT_EMAIL" . --include="*.md"

# confirm the updater endpoint the app will actually hit:
grep -n "endpoints" -A2 src-tauri/tauri.conf.json

# test gate:
npm run test:fast
```
