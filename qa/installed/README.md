# `qa/installed/` — the installed-desktop proof

This directory holds the machine-local receipt written by `npm run qa:smoke:installed`. It is the
only QA detector that attaches to the running packaged Tauri application. Browser/dev-sidecar runs
are not substitutes for installed proof.

## Receipt schema v2

`qa/installed/last-smoke.json` separates the expected candidate from identity observed in the
running binary:

```json
{
  "schemaVersion": 2,
  "stampIso": "2026-07-10T12:00:00.000Z",
  "expectedHead": "<full 40-character candidate SHA>",
  "buildCommit": "<full SHA reported by the packaged Tauri build>",
  "buildDescribe": "v0.4.1-12-g12345678",
  "buildDirty": false,
  "appVersion": "0.4.1",
  "sidecarHarness": "v0.4.1-12-g12345678",
  "mode": "desktop",
  "origin": "http://tauri.localhost",
  "artifact": {
    "path": "C:/Program Files/StarNet/StarNet.exe",
    "sha256": "<64 hexadecimal characters>",
    "size": 123456789
  },
  "runtimeExecutable": {
    "sha256": "<same 64 hexadecimal characters reported by the running Tauri process>",
    "size": 123456789
  },
  "result": "GREEN",
  "evidence": [{
    "path": "qa/installed/smoke-.../probe.json",
    "sha256": "<64 hexadecimal characters>",
    "size": 12345
  }],
  "notes": "..."
}
```

GREEN requires all of the following: a trusted Tauri origin, successful `starnet_build_info`, a
clean full source SHA equal to the explicitly expected candidate, matching shell/sidecar versions
and provenance, and an exact SHA-256/size match between `STARNET_SMOKE_ARTIFACT` and the executable
bytes reported by the running Tauri process. Evidence is also content-bound by SHA-256/size, and
every named smoke assertion must be present and passing. Browser mode, dirty/unknown source,
missing assertions, mismatched candidate/executable, or missing artifact/evidence is BLOCKED. A
parity failure on an otherwise proven candidate is RED.

`npm run qa:ready` re-hashes the artifact and every evidence file, then re-checks that the artifact
identity equals the runtime identity before accepting the receipt. Legacy receipts are intentionally
rejected.

## Operator recipe

Fully quit StarNet, then launch the exact candidate executable with WebView debugging enabled. Set
both explicit proof inputs before running the smoke; neither has an ambient fallback. Point the
artifact variable at the executable launched by `Start-Process`, not an installer or archive. The
receipt deliberately proves byte identity (SHA-256 + size), not the private runtime filesystem path.

```powershell
$candidate = git rev-parse HEAD
$artifact = 'C:\Program Files\StarNet\StarNet.exe'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
$env:STARNET_SMOKE_EXPECTED_HEAD = $candidate
$env:STARNET_SMOKE_ARTIFACT = $artifact
Start-Process $artifact
npm run qa:smoke:installed
```

Open the TASKS board before the sweep so the installed UI assertion is actually observed. Override
the conventional CDP port with `STARNET_SMOKE_CDP_PORT`. Exit codes are `0` GREEN, `1` RED, and `2`
BLOCKED. Evidence and receipts are gitignored; never commit them or any credential.
