# SHIP_CHECKLIST — Skynet downloadable alpha

The runbook from the 2026-06-18 ship reality-check. "Verifiable" work is merged to trunk; everything that
needs a real `tauri build` / a clean machine / a paid decision is staged or documented here for the build box.

## Download-blockers (the 4 from the reality-check audit)

| # | Blocker | Status |
|---|---------|--------|
| B | sidecar wrote its data root under the read-only install dir → silent total persistence loss + every permission grant degraded to DENY | ✅ **MERGED** (trunk `d3e8e9c`) — defaults to `%LOCALAPPDATA%\Skynet\workspaces`; `SKYNET_WORKSPACES` still wins |
| C | README said "planning, no app code yet" + wrong stack claims | ✅ **MERGED** (`d3e8e9c`) — rewritten to the shipped truth + a verified Quick Start |
| D | "it lies" gamification gap | ✅ closed already; **residual** (crew WORKING/IDLE read the global hero activity) **MERGED** (`d3e8e9c`) — now per-agent from `agent.run.start/end` |
| A | shell spawned bare `node` from PATH → dead app on a clean machine (no Node) | 🟡 **IMPLEMENTED, UNMERGED** on `agent/ship-rail` (`e76c275`) — bundles Node via Tauri `externalBin`; **needs a build-test** |

## Finish A — on your Windows build box

```bash
cd C:\Users\andro\gen-trees\ship-rail
npm run desktop:build      # runs scripts/prepare-node.mjs (fetches node.exe ~83MB) then tauri build → NSIS installer
```
Then on a **clean Windows VM with NO Node installed**: install the NSIS output, launch SKYNET, confirm the
agent host comes up and a real run works. If good → merge `agent/ship-rail` to trunk.

## Recommended additional Tauri-layer changes (apply + verify at build time — NOT compile-tested here)

1. **NSIS install mode → current-user.** Sidesteps the read-only-Program-Files root cause entirely (installs
   to a user-writable location; no admin prompt). In `src-tauri/tauri.conf.json`, under `bundle`, add a
   `windows.nsis.installMode` of `"currentUser"`. ⚠ Confirm the exact Tauri v2 schema key + allowed value at
   build (an unknown key fails the build) — this is the one change I'd verify against `tauri build` output.
2. **Pin the WebView2 user-data dir.** So an update can't rotate the storage location and silently wipe saved
   stations (localStorage is per-data-dir/per-origin). Set a stable webview data directory (research the
   Tauri v2 API: the webview builder data-dir / WebView2 additional-args). Verify saves survive an upgrade.
3. **Auto-updater rail.** `tauri-plugin-updater` + a signing keypair + an update host. Blocked on the two
   decisions below; also pin the WebView2 data dir (item 2) BEFORE shipping an updater so the first auto-update
   doesn't wipe users' stations.

## Decisions (yours)

- **Code-signing cert** — pay for an OV/EV cert (no SmartScreen warning) vs ship updater-signed-only for the alpha.
- **Update host** — GitHub Releases (the planned host) vs other. Needed before the updater rail.

## Hard gates no in-agent automation can clear

`cargo` / `rustc` / `tauri` CLI / `makensis` are absent from the agent environment (verified, even
unsandboxed). So the installer build, the clean-machine install test, and the cert/host decisions all need
your Windows build box and your calls. Everything reachable without them is done or staged.
