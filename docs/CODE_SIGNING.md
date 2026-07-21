# Code signing — Windows (Azure Trusted Signing) + macOS (Apple notarization)

Why this exists: unsigned installers hit the Windows SmartScreen "unrecognized app /
potential virus" wall and the macOS Gatekeeper block. Signing + notarization is what
turns "sketchy download" into "opens cleanly". Both CI workflows (desktop-build.yml,
release-train.yml) are already wired — they light up automatically when the secrets
below exist, and degrade to unsigned builds when they don't.

## Windows — Azure Trusted Signing ("Artifact Signing")

### What already exists (created 2026-07-21 via az CLI)

| Thing | Value |
| --- | --- |
| Azure subscription | `Azure subscription 1` (`685b8c19-f09a-4264-ba08-a8127cd31e4d`), upgraded from free tier to pay-as-you-go (Artifact Signing refuses free/trial subs) |
| Tenant | `bb673ff6-ccab-4628-9b90-c8a874c20d65` (androosbotoutlook.onmicrosoft.com) |
| Resource group | `starnet-signing-rg` (eastus) |
| Signing account | `starnet-signing`, SKU Basic ($9.99/mo, 5k signatures/mo), endpoint `https://eus.codesigning.azure.net/` |
| Role granted | `Artifact Signing Identity Verifier` → Andrew's user (needed to run identity validation) |
| Identity validation | **Individual / Public**, "Andrew Sims" — COMPLETED 2026-07-21, id `b19a2faa-4463-4564-8de0-344ecbe00ebe`. (First attempt failed: submitted as *Organization* — no registered business to verify. Individual resubmit passed same day. An inert failed Organization row remains; safe to delete.) |
| Certificate profile | `starnet-public` (PublicTrust) — provisioned Succeeded 2026-07-21. Name is load-bearing: CI's signCommand references it. |
| Service principal | `starnet-ci-signer` (appId `2a51e476-1196-49e4-8ee9-8f31a57045f2`) with role `Artifact Signing Certificate Profile Signer` scoped to the account. Credentials at `%USERPROFILE%\.starnet-signing\azure-ci-signer.json` (delete after first signed build verifies). |

### Remaining operator steps (in order)

1. **Add the three `AZURE_*` secrets** to the repo running the workflows
   (androoAGI/starnet → Settings → Secrets → Actions): AZURE_TENANT_ID
   `bb673ff6-ccab-4628-9b90-c8a874c20d65`, AZURE_CLIENT_ID
   `2a51e476-1196-49e4-8ee9-8f31a57045f2`, AZURE_CLIENT_SECRET = `password` from the
   credentials file above. Next tagged train ships signed.
2. **Verify on the first signed build:** `Get-AuthenticodeSignature` on the setup exe,
   the installed `StarNet.exe`, AND the bundled `node-x86_64-pc-windows-msvc.exe` must
   all say Valid — an unsigned nested exe still trips Defender.

### How CI signs (already wired — no action)

With the AZURE_* secrets present, the Windows leg installs `trusted-signing-cli` and
injects `bundle.windows.signCommand` via `--config`. Tauri then signs the app exe, the
bundled node sidecar (externalBin), and the NSIS installer/uninstaller. Keyless builds
skip all of it (warning, not failure). tauri.conf.json stays untouched so local builds
never reach for Azure.

### Reputation reality check

Signing kills the "potential virus" heuristics but SmartScreen reputation still
accrues per-certificate: expect a softer "unrecognized" prompt for the first
releases/downloads, then silence. Never change the signing identity once shipping —
reputation follows the cert.

## macOS — Apple Developer ID + notarization

No Azure equivalent shortcut: the $99/yr Apple Developer Program is mandatory and
there is no reputation path around Gatekeeper. Both workflows already consume the
secrets (see release-train.yml header): enroll → create a **Developer ID Application**
cert → export .p12 → set `APPLE_CERTIFICATE` (base64 of .p12),
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID` (+ app-specific
password as `APPLE_PASSWORD`), `APPLE_TEAM_ID`. Notarized DMGs open with zero
Gatekeeper friction; INSTALL.md's "Open Anyway" section can then be retired.

## Per-release hygiene (until reputation is established)

- Upload the setup exe to VirusTotal before publishing; note which engines flag it.
- Submit each release to Microsoft's false-positive portal
  (https://www.microsoft.com/en-us/wdsi/filesubmission, "software developer" path) —
  typically cleared in 1–3 days and feeds Defender globally.
- Keep filenames, publisher name, and download host stable across releases.
