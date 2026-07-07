# NEXT.md — current priorities & task queue

**The one moving file.** Update it when you land or invalidate an item; don't write a new
plan doc. Reconciled against trunk `feat/harness-backend` + git log on **2026-07-06 (evening)**.
Verification key: ✅ = grep/log-verified today · ❓ = doc claim, re-verify before building.

## Already DONE — do not rebuild (merged 2026-07-05..06)

Release train v0.2.0→v0.2.2 (4-platform signed draft, runbook, gate-after-bump);
polish-sprint lanes **8/8 MERGED** (lane 8 truth-chrome-instruments landed 8e8e6eef while
this file was being written): ux-topbar-disconnect, ux-popup-escape,
voice-button-reliability, truth-run-lifecycle, truth-channel-tee, truth-props-glow,
dossier-agent-mgmt (DELETE AGENT + CHANGE SKIN); update-safety P0.1 wv-cache-purge,
P0.2 mirror-truth, P1.1+P1.2 roster-honesty; voice-desktop-key; comms-fresh-session;
multiplatform install docs. ✅ (all in git log)

## P0 — code (verify each is still open by grep before starting)

1. **Forward-version save guard** — `frontend/app/save.js:52` still silently adopts
   `doc.version > CURRENT` (downgrade eats newer saves) ✅ open. Refuse + surface.
   (UPDATE_STATE_SAFETY P0.3.)
2. **Frontend token leak to provider hosts** — `frontend/app/harness.js:45`
   `/\/api\//.test(u)` attaches the local API token to ANY url containing `/api/`
   (e.g. openrouter.ai/api/v1) ✅ open. (GROUND_UP 0.6.)
3. **`agent.tool_call` double-emit** — both `chat.js:3964` (local emit) and
   `harness.js:372` (SSE forward) fire ✅ both paths exist; audit says it corrupts the
   recruiter work-signal. Dedupe at one seam. (GROUND_UP 0.4.)
4. **Sidecar spawn failure = silently dead app** — `src-tauri/src/main.rs` ~1161, no retry
   or error dialog ❓. (GROUND_UP 0.2.)
5. **Workspace migration resurrects deleted data on every boot** — `main.rs` ~385-397 ❓;
   needs `.migrated` marker. (GROUND_UP 0.1.) NOTE: workshop CSP (GROUND_UP 0.3) appears
   FIXED — `sidecar/index.js:6049` now sends a sandbox CSP ✅ — verify coverage, then close.

## P0 — Andrew only (nothing above matters to the public until these)

- Publish `starnet-releases` repo (public updater currently 404s) + rescope RELEASES_TOKEN.
- Back up `~/.tauri/starnet-updater.key` to ≥2 offline locations (single point of total loss).
- Rotate the dev OpenRouter key; support email swap.
- **Attended 15-min playtest** (`docs/PLAYTEST_SCRIPT_GATE5.md`) — dodged since 7/02.
- Then per `docs/ROADMAP_2026-07-04_BRUTAL.md`: 10 outside installs; days 8–30 = code-signing
  identity + weekly release cadence; days 31–90 = managed-key starter credits (one SKU).

## P1 — after the P0s (from the 7/06 audits, unverified ❓ unless noted)

- Update flow: flush CloudSave before install (P1.3); automated "update preserves state"
  parity gate (P1.4); stamp `git describe` into the exe (P1.5).
- BYOK provider key still plaintext in `channels/secrets.js` (keychain has the channel
  secrets only).
- Channel-hub runs missing from `runsMeta` → SSE reconnect wipes state.
- `approvalMode` not persisted across restart.
- Prompt-injection via auto-granted `team.*` caps — genuine product fork, needs Andrew.
- P2 hygiene list lives in `docs/GROUND_UP_AUDIT_2026-07-06.md` — do not copy it here.

## Branch triage (18 unmerged `agent/*` branches ✅)

In-flight: `truth-chrome-instruments`. Likely-value parked: `honest-states`,
`quick-model-selector`, `ui-number-format`, `workstreams-sessions-ui`, `cron-staylive`.
Probably stale (pre-date recent reworks — diff before deciding): `belt-reclaim`,
`commission-redux`, `cortex-hermes-plus`, `growth-t4`, `hermes-parity-loop`,
`messaging-platforms`, `parity-finish`, `starnet-api-gate`, `starnet-hardening-5-6-*`,
`starnet-memory-consent`, `starnet-memory-loop`, `starnet-tests-tauri`.
Rule: land it or delete it — an unmerged branch is a claim nobody verified.

## Parked product decisions (need Andrew, don't guess)

- `fullOffice()` autonomous prop placement vs. hand-placed only.
- localLine slash-command restyle; focusAgent global-model overwrite semantics.
- Prompt-injection stance on auto-granted `team.*` (see P1).

## Session handoff format

End every substantive session by:
1. Updating THIS file (move landed items to DONE with the merge hash, add discoveries).
2. If you merged to trunk: the `starnet-merge-ritual` digest in `qa/` (existing convention).
3. A 3-line summary in your final report: **Landed** (verified how) / **Open** (what you
   did NOT verify) / **Next** (the single highest-leverage follow-up).
Do not create new `*_PLAN.md` files for work under ~a week; use this queue.
