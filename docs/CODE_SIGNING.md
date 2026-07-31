# Code signing — Windows (Azure Trusted Signing) + macOS (Apple notarization)

Why this exists: unsigned installers hit the Windows SmartScreen "unrecognized app /
potential virus" wall and the macOS Gatekeeper block. Signing + notarization is what
turns "sketchy download" into "opens cleanly". Both CI workflows (desktop-build.yml,
release-train.yml) are wired. Manual `desktop-build` runs sign when credentials are
available and may degrade to unsigned internal-test artifacts. The tagged public
`release-train` fails closed if either platform's production credentials or trust proof
is missing.

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

### Live status (verified 2026-07-31)

- The three `AZURE_*` Actions secrets are installed in `androoAGI/starnet`.
- Non-publishing `desktop-build` run `30606849654` authenticated as the signing service
  principal and used account `starnet-signing`, public-trust profile `starnet-public`.
- Azure successfully signed `skynet-desktop.exe`, the NSIS components, and
  `StarNet_0.7.0_x64-setup.exe` with zero signing errors.
- The downloaded CI installer passed the native Windows check:
  `Get-AuthenticodeSignature` returned `Valid` / `Signature verified`, publisher
  `Andrew Sims`, a Microsoft verified code-signing issuer, and a Microsoft timestamp.
- The checksum-verified Node runtime that is bundled by `externalBin` independently
  returns `Valid`, publisher `OpenJS Foundation`, with a DigiCert timestamp. Preserve
  that upstream signature rather than replacing it.

### How CI signs (already wired — no action)

With the AZURE_* secrets present, the Windows leg installs `trusted-signing-cli` and
injects `bundle.windows.signCommand` via `--config`. Tauri signs the app executable,
NSIS components, and final installer. The bundled Node sidecar keeps its upstream
OpenJS signature. `tauri.conf.json` stays untouched so local builds never reach for
Azure.

The tagged public train requires all three Azure credentials before compiling, then
uses `Get-AuthenticodeSignature` to require a valid timestamped signature on the app,
installer, and bundled Node runtime. Any missing credential, wrong publisher, unsigned
file, invalid chain, or missing timestamp stops the release before staging.

### Reputation reality check

Signing removes the unknown-publisher condition and reduces malware heuristics, but
SmartScreen reputation still accrues over real downloads. Azure's short-lived
certificates rotate automatically; reputation follows the verified publisher identity.
Early releases can still receive a reputation warning even when the signature is fully
valid, so record clean-machine results rather than promising instant SmartScreen silence.

## macOS — Apple Developer ID + notarization

The paid Apple Developer Program is active. StarNet is distributed directly as a DMG,
not through the Mac App Store, so the required identity is **Developer ID Application**
(not Apple Distribution, Mac App Distribution, or Developer ID Installer).

### One-time operator setup

Do this on a Mac. The private key created with the certificate signing request must stay
with the certificate when it is exported.

1. In **Keychain Access → Certificate Assistant → Request a Certificate From a
   Certificate Authority**, create a CSR and select **Saved to disk**.
2. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list),
   add a certificate, choose **Developer ID Application**, upload the CSR, and download
   the resulting `.cer`.
3. Open the `.cer` so it joins its private key in the login keychain. Under **My
   Certificates**, expand the new `Developer ID Application: …` row and confirm a private
   key appears beneath it. If there is no private key, do not continue—the `.p12` would be
   unusable.
4. Export that certificate **and its private key** as a `.p12`. Give the export a strong,
   unique password; this becomes `APPLE_CERTIFICATE_PASSWORD`.
5. Record the exact identity:

   ```sh
   security find-identity -v -p codesigning
   ```

   Copy the full `Developer ID Application: Name (TEAMID)` string as
   `APPLE_SIGNING_IDENTITY`.
6. Find the 10-character Team ID on the Apple Developer membership page. This becomes
   `APPLE_TEAM_ID`.
7. At [account.apple.com](https://account.apple.com/), create an app-specific password
   dedicated to `StarNet notarization`. This—not the normal Apple Account password—is
   `APPLE_PASSWORD`. The Apple Account email is `APPLE_ID`.
8. Convert the `.p12` to one unwrapped base64 line:

   ```sh
   openssl base64 -A -in StarNet-Developer-ID.p12 -out StarNet-Developer-ID.base64.txt
   ```

   The contents of that text file become `APPLE_CERTIFICATE`.

### GitHub Actions secrets

In `androoAGI/starnet` go to **Settings → Secrets and variables → Actions** and create
all six repository secrets:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Entire one-line base64 `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | Exact `Developer ID Application: Name (TEAMID)` identity |
| `APPLE_ID` | Apple Account email |
| `APPLE_PASSWORD` | App-specific notarization password |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |

Never commit the CSR private key, `.p12`, base64 export, passwords, or GitHub secret
values. Keep an encrypted backup of the `.p12` and its password outside the repository;
losing them prevents signing the next release with the same identity.

### First proof

1. Run the manual `desktop-build` workflow with `publish-test=false`. Both Mac legs
   should show Tauri signing and notarization rather than the unsigned-build warning.
2. On the first tagged release train, the Mac legs must show all of these:
   `Authority=Developer ID Application`, hardened runtime, Node `allow-jit`,
   `DMG notarized + stapled`, and `source=Notarized Developer ID`.
3. Download each staged DMG on a clean Intel and Apple Silicon Mac. Drag StarNet to
   Applications and launch it normally while online, then repeat offline. There must be
   no “damaged,” unidentified developer, or Open Anyway path.
4. Only after that live proof, remove the temporary unsigned-build instructions from
   README.md, DOWNLOAD_PAGE.md, INSTALL.md/release notes, and launch checklists.

The tagged public release train now fails closed if any Apple secret is absent or if
Gatekeeper does not return the notarized Developer ID verdict. Manual test builds can
still be unsigned so contributor CI remains usable.

## Per-release hygiene (until reputation is established)

- Upload the setup exe to VirusTotal before publishing; note which engines flag it.
- Submit each release to Microsoft's false-positive portal
  (https://www.microsoft.com/en-us/wdsi/filesubmission, "software developer" path) —
  typically cleared in 1–3 days and feeds Defender globally.
- Keep filenames, publisher name, and download host stable across releases.
