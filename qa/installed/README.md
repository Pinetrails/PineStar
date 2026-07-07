# `qa/installed/` — the installed-exe smoke stamp

This directory holds the receipt written by the **installed-exe smoke**
(`scripts/qa/installed-smoke.mjs`, `npm run qa:smoke:installed`) — the one detector that proves
behavior of the **packaged desktop exe** instead of a dev sidecar. Every other crew member
(Guardian / Beginner / Journeys / Cartographer) boots a DEV sidecar and drives headless Chrome, so
none of them can ever see the WebView2-cache class of bug (`docs/MISTAKES.md` → "Desktop /
installed-app traps"): the desktop UI is the frontend **compiled into the exe**, served over
`http://tauri.localhost`, and WebView2 caches it and never revalidates. CDP-attaching to the running
exe is the only proof.

## The pinned stamp — `qa/installed/last-smoke.json`

`npm run qa:ready` (the READY-GATE, lane `agent/ready-gate`) READS this exact shape. **Do not change
it without flagging the ready-gate lane.**

```json
{
  "stampIso":   "2026-07-07T12:00:00.000Z",   // when this smoke ran (ISO 8601)
  "appVersion": "0.3.0",                        // the installed build's /api/version app (BLANK iff BLOCKED)
  "trunkHead":  "e01831ab…",                    // the trunk HEAD sha the smoke ran against
  "result":     "GREEN",                        // "GREEN" | "RED" | "BLOCKED"
  "evidence":   ["qa/installed/smoke-…/probe.json"],
  "notes":      "appVersion=0.3.0 mode=desktop checks 6/6 pass"
}
```

- **GREEN** — attached, the app version was proven, and every parity assertion passed.
- **RED** — attached + versioned, but a parity assertion failed on the installed build (files a **P1**
  ledger finding).
- **BLOCKED** — could not attach, or could not prove the app version, or the in-page probe threw
  (files a **P0** ledger finding). No-fake-green: a smoke that can't prove the build never reads GREEN.

Findings are filed through `scripts/qa/ledger.mjs` (the one dedup/known authority); the smoke never
notifies. Per-run evidence lands in `qa/installed/smoke-<stampIso>/`. Both the stamp and the run dirs
are gitignored machine-local artifacts (the ready-gate reads them via fs, never from git).

## Running it — the operator recipe (Andrew's machine, weekly / at soak end)

The installed exe does **not** open a debug port by default. Relaunch it with the WebView2 debug arg,
then run the smoke:

```powershell
# 1. Fully quit StarNet (and its msedgewebview2.exe children), then relaunch with the debug port open:
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
Start-Process "$env:LOCALAPPDATA\..\StarNet\StarNet.exe"   # or the Start-menu shortcut
# 2. Once the station has rendered, attach + sweep:
npm run qa:smoke:installed
```

`9333` is the port convention prior installed-exe CDP work used (desktop-bundles / voice-system
memory). Override with `STARNET_SMOKE_CDP_PORT`. Exit codes: **0** GREEN · **1** RED · **2** BLOCKED.

This is a **SMOKE** (minutes, a handful of assertions), not the full Atlas. It is a session/operator
task, not a headless scheduled job — the packaged exe must be running and reachable first.
