# Verified stock StarNet baseline

StarNet is Pine Star's upstream technical foundation. Establishing and preserving this verified stock baseline completed **Phase 1 — Stock StarNet Baseline — COMPLETE**.

## Identity and integrity

- StarNet 0.10.10; commit `56c3848e`; permanent tag `starnet-baseline-0.10.10`.
- Final pre-Pine-Star state: clean working tree.
- A transient `src-tauri/Cargo.toml` change was LF/CRLF-only; `git diff --ignore-space-at-eol` found no substantive diff and it was restored.

The tag must remain untouched. `PS-2026-001` does not fix baseline defects.

## Dependencies

`npm ci` succeeded: 73 packages added, 74 audited, 0 vulnerabilities. npm warned some install scripts were not covered by `allowScripts`. Do not change `allowScripts` solely for that warning absent a runtime problem.

## Fast tests — evidence-qualified upstream mismatch

`npm run test:fast` progressed and reported `FAIL: index.js defines checkpointsEnabledFromEnv`. Inspection of baseline commit `56c3848e` shows that `sidecar/index.js` does contain both `checkpointsEnabledFromEnv` and its call site. The test attempts to extract the function with a regex that expects the closing brace at the start of a line (`\n}\n`), while the implementation's closing brace is indented. This evidence supports classifying the observed failure as a test/source formatting mismatch rather than a missing function. It does not establish whether any additional factor affected the original test run.

## Browser/sidecar — PASS

`npm start` launched onboarding at `http://localhost:8787` with `CREATE YOUR OVERSEER`. No provider/credential was configured.

## Desktop development path

Initial `desktop:dev` failed because `src-tauri/voice-deps/node_modules` was absent although `tauri.conf` requires it. `desktop:build` stages it via `scripts/stage-voice-deps.mjs`; `desktop:dev` does not. Manual staging succeeded.

After staging, the shell compiled/launched, bundled Node existed, the sidecar spawned/listened, and direct HTTP returned 200. The UI still showed station-data-unreachable/recovery. Developer Tools showed `http://127.0.0.1:1430/`; same-origin `/api/save` and direct private-sidecar fetch failed. Sidecar security pins origins and requires a launch token. Classification: stock dev origin/API-auth integration mismatch—not Pine Star or Windows/firewall regression.

## Workspace and recovery

An older StarNet workspace was detected/migrated in part. Start Fresh quarantined prior state rather than deleting it. No old workspace data was intentionally deleted.

## Packaged desktop — PASS

`npm run desktop:build` compiled the optimized app and produced the release executable and NSIS installer. Updater signing warned/errored because a public key exists but `TAURI_SIGNING_PRIVATE_KEY` was unavailable; compilation still succeeded. Pine Star must never obtain/imitate StarNet's private key.

The release executable launched, reached recovery, found small state evidence (`loops.halt.json`, `nightshift.state.json`) but no active `agent.save.json`, quarantined it via Start Fresh, and displayed fresh onboarding.

| Surface | Result |
| --- | --- |
| Dependency install/audit | PASS with non-blocking warning |
| Fast tests | Evidence supports an upstream test/source formatting mismatch; function is present |
| Browser/sidecar | PASS |
| Desktop dev | Launch after staging; origin/auth mismatch remains |
| Packaged desktop | PASS |
| Fresh onboarding/recovery | PASS |
| Final integrity | Clean and permanently tagged |
