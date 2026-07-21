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
| Identity validation | **Individual / Public**, legal name "Andrew Sims" — SUBMITTED 2026-07-21, pending Microsoft approval (hours–days). Watch for the Au10tix verification email. |

### Remaining operator steps (in order)

1. **Wait for identity validation = Approved** (portal → Artifact Signing Accounts →
   starnet-signing → Identity validations). Nothing below works until then.
2. **Create the certificate profile** (name is load-bearing: CI references
   `starnet-public`). Grab the identity-validation id from the portal, then:
   ```
   az resource create -g starnet-signing-rg \
     --resource-type "Microsoft.CodeSigning/codeSigningAccounts/certificateProfiles" \
     -n starnet-signing/starnet-public --location eastus \
     --api-version 2024-09-30-preview \
     --properties '{"profileType":"PublicTrust","identityValidationId":"<VALIDATION_ID>"}'
   ```
3. **Create the CI service principal** and give it signing rights:
   ```
   az ad sp create-for-rbac -n starnet-ci-signer \
     --role "Artifact Signing Certificate Profile Signer" \
     --scopes /subscriptions/685b8c19-f09a-4264-ba08-a8127cd31e4d/resourceGroups/starnet-signing-rg/providers/Microsoft.CodeSigning/codeSigningAccounts/starnet-signing
   ```
   Output maps to the GitHub secrets: `appId` → AZURE_CLIENT_ID, `password` →
   AZURE_CLIENT_SECRET, `tenant` → AZURE_TENANT_ID.
4. **Add the three `AZURE_*` secrets** to the repo running the workflows
   (androoAGI/starnet → Settings → Secrets → Actions). Next tagged train ships signed.
5. **Verify on the first signed build:** `Get-AuthenticodeSignature` on the setup exe,
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
