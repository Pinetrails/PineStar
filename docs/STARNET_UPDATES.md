# StarNet Desktop Updates

StarNet desktop updates are delivered through Tauri's signed updater. The app checks a HTTPS `latest.json` manifest, verifies the downloaded installer signature against the public key embedded in `src-tauri/tauri.conf.json`, then runs the installer from inside the app.

## User Goal Loop

Goal: keep the installed StarNet desktop app on the newest trusted release with the least user friction.

Loop:

1. On app boot, `Updates.init()` asks Rust for local updater status and starts the timer.
2. If automatic checks are enabled and the loop is due, `starnet_update_check` fetches the signed release manifest.
3. If no update exists, the next check is scheduled for 6 hours later.
4. If the check fails, the loop retries with exponential backoff from 15 minutes up to 6 hours.
5. If an update exists, StarNet posts one notification per version and shows it in System -> Updates.
6. When the user clicks Install Update, `starnet_update_install` downloads, verifies, installs, and restarts or exits into the installer as the platform requires.
7. Remind Tomorrow suppresses prompts until the reminder deadline. Skip Version suppresses non-critical updates for that version. Critical updates bypass skip/reminder suppression.

## Release Endpoint

The desktop build currently checks:

```text
https://updates.starnet.app/desktop/latest.json
```

The endpoint should serve the static Tauri updater JSON:

```json
{
  "version": "0.2.0",
  "notes": "Release notes shown inside StarNet.",
  "pub_date": "2026-06-24T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "contents of the .sig file",
      "url": "https://updates.starnet.app/desktop/StarNet_0.2.0_x64-setup.exe"
    }
  }
}
```

Optional top-level `critical: true` is understood by StarNet's UI and notification loop.

## Signing Key

The public updater key is embedded in `src-tauri/tauri.conf.json`. The matching private key was generated outside the repository at:

```text
C:\Users\andro\.tauri\starnet-updater.key
```

Do not commit the private key. Back it up in a password manager or release vault before shipping a public build. If that private key is lost after release, existing users will not be able to install future signed updates from this update channel.

For production signing:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.tauri\starnet-updater.key"
npm run desktop:build
```

## Build And Publish

1. Bump both desktop versions:
   - `src-tauri/Cargo.toml` -> `[package].version`
   - `src-tauri/tauri.conf.json` -> top-level `version`
2. Build the desktop app with the signing key environment variable set:

   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.tauri\starnet-updater.key"
   npm run desktop:build
   ```

3. Upload the generated NSIS installer and its `.sig` file from `src-tauri/target/release/bundle/nsis/`.
4. Generate `latest.json`:

   ```powershell
   node scripts/starnet-release-manifest.mjs `
     --version 0.2.0 `
     --url https://updates.starnet.app/desktop/StarNet_0.2.0_x64-setup.exe `
     --signature-file src-tauri/target/release/bundle/nsis/StarNet_0.2.0_x64-setup.exe.sig `
     --notes-file RELEASE_NOTES.md `
     --out release/latest.json
   ```

5. Upload `release/latest.json` to `https://updates.starnet.app/desktop/latest.json`.
6. Test with an older installed StarNet build and confirm System -> Updates sees the new version, downloads it, verifies it, and launches the installer.

## Files

- `src-tauri/src/main.rs`: native updater commands and pending update cache.
- `frontend/app/updatecore.js`: pure autonomous goal/loop planner.
- `frontend/app/updates.js`: Update Center UI and Tauri command bridge.
- `test/updatecore.test.js`: planner regression tests.
- `scripts/starnet-release-manifest.mjs`: release manifest generator.
