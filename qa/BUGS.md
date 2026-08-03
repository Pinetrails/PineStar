# QA bug register

**GENERATED — do not hand-edit.** Rebuild with `npm run qa:bugs:index`.
One tracked file per bug under `qa/bugs/`; this is only the index. File a new bug with
`node scripts/qa/bugs.mjs --new --title "..." --surface <surface>`.

**3** open (open+claimed) of 36 total — 0 P0 · 0 P1 · 3 P2

| Sev | Status | Surface | Bug | Lane | Fix |
| --- | --- | --- | --- | --- | --- |
| P0 | fixed | autonomy | [After E-STOP the ROUTINES panel still renders "● scheduler armed — routines fire automatically" plus a live countdown; GET /api/cron's `halted` field has zero c](bugs/4962c3ad-after-e-stop-the-routines-panel-still-renders-sc.md) | sweep/autonomy | b7e18ce8 |
| P0 | fixed | onboarding | [Only the skip CHIP is recognized as a skip — the typed word the interview invites ("skip") is stored as a weight:'stated' belief, raising FAMILIARITY, opening t](bugs/e62959ca-only-the-skip-chip-is-recognized-as-a-skip.md) | sweep/onboarding | 6afeb9ee |
| P0 | fixed | providers | [The KEYS-tab UNATTENDED grant is enforced only at web_request — servicekeys.runEnv() has no surface argument, so an unattended shell child receives every ENABLE](bugs/14d4f234-the-keys-tab-unattended-grant-is-enforced-only-a.md) | sweep/providers | 6afeb9ee |
| P0 | fixed | release | [Forward-version gate asserts "no newer build is published yet" for EVERY non-'available' phase — including check 'error' and the busy short-circuit — and the 'u](bugs/9c0664eb-forward-version-gate-asserts-no-newer-build-is-p.md) | sweep/release | 6afeb9ee |
| P0 | fixed | safecell | [The Permissions panel's normalizeGrants regex drops every path: and mcp: standing grant — the ledger prints "No standing approvals yet" while the backend holds](bugs/7274ff21-the-permissions-panel-s-normalizegrants-regex-dr.md) | sweep/safecell | 6afeb9ee |
| P0 | fixed | sessions | [An attachment-bearing user turn is dropped from the durable transcript and the PREVIOUS turn is written in its place — the string-only scan at index.js:11299 fa](bugs/e7dcb889-an-attachment-bearing-user-turn-is-dropped-from.md) | sweep/sessions | 6afeb9ee |
| P0 | fixed | skills | [skill.view's hydrate-then-bump stores the RENDERED SKILL.md as the skill's body, so every view→persist cycle re-appends '## Setup' and '## Support Files' — unbo](bugs/c70f8965-skill-view-s-hydrate-then-bump-stores-the-render.md) | sweep/skills | 598ab4a4 |
| P1 | fixed | autonomy | [cron-store's armAt never receives the host defaultTz, so a tz-less cron routine's FIRST nextRunAt is UTC-anchored while every later advance uses local — the mar](bugs/f47a1e3a-cron-store-s-armat-never-receives-the-host-defau.md) | sweep/autonomy | 226cec3c |
| P1 | fixed | channels | [A lost-race consent tap stamps "▸ ✅ Allow once" onto the message before resolveConsent is asked, so a DENIED request keeps a permanent "approved" record](bugs/64563ad9-a-lost-race-consent-tap-stamps-allow-once-onto-t.md) | sweep/channels | 96fe108d |
| P1 | fixed | channels | [`channel.targets` derives "reachable now" from the adapter handle's existence, so an errored (or still-connecting) channel is reported connected while telegramS](bugs/a199ee3c-channel-targets-derives-reachable-now-from-the-a.md) | sweep/channels | 96fe108d |
| P1 | fixed | providers | [No quota-exhaustion error class exists: a 429 from a spent Codex/subscription weekly quota renders as 'the provider is busy — wait a few seconds' and burns up t](bugs/e89317af-no-quota-exhaustion-error-class-exists.md) | sweep/providers | fdbb12a2 |
| P1 | fixed | release | [migrate_workspace_data writes the .migrated marker unconditionally and drops copy_missing_dir's Err with no log — a partial legacy migration is permanent and lo](bugs/f42a5f46-migrate-workspace-data-writes-the-migrated-marke.md) | sweep/release | 5f8aa7ce |
| P1 | fixed | release | [release-cut.mjs stages latest.json with no cryptographic signature check, and no downstream gate does one either — t1 checks .sig mtime, t5 text-compares it, ve](bugs/26af4a9a-release-cut-mjs-stages-latest-json-with-no-crypt.md) | sweep/release | b315063b |
| P1 | fixed | safecell | [An errored /api/projects is rendered as a CONFIRMED EMPTY trust ledger ("NO TRUSTED PROJECTS") and silently wipes the persisted project scope](bugs/e05cdba8-an-errored-api-projects-is-rendered-as-a-confirm.md) | sweep/safecell | ed200caa |
| P1 | fixed | safecell | [The Projects rail's ADD doorway records a NON-canonical path grant, so blessing a folder reached through a junction/symlink reports success and grants nothing](bugs/cf0cd4cd-the-projects-rail-s-add-doorway-records-a-non-ca.md) | sweep/safecell | 226cec3c |
| P1 | fixed | sessions | [checkpoint snapshot() uses the SYNC loadIndex despite being async — after an index+bak loss it re-stamps a 1-entry index that permanently blocks the git rebuild](bugs/d5621e9b-checkpoint-snapshot.md) | sweep/sessions | b315063b |
| P1 | fixed | skills | [gate.verify()'s tamper branch re-enters decide(), which clears the tamper against the STALE stored contentDigest — one approval permanently blesses whatever is](bugs/76d5dc8a-gate-verify.md) | sweep/skills | 598ab4a4 |
| P1 | fixed | voice | [A stale sidecar token lets Local Live open a silent microphone session after restart](bugs/ff73b79a-a-stale-sidecar-token-lets-local-live-open-a-sil.md) | agent/voice-release-sweep | 8bc9ff9a |
| P1 | fixed | voice | [On a zero-key station every Edge blip is misclassified as 'no key': no retry, a 60s dead-voice cold-off, and a tooltip demanding a credential the station never](bugs/151c8d9a-on-a-zero-key-station-every-edge-blip-is-misclas.md) | sweep/voice | 50a8b07b |
| P1 | fixed | voice | [transcribe() never checks r.ok, so any non-JSON /api/stt error (stale-token 403, 5xx, HTML) is laundered into a confirmed-empty transcript and the spoken senten](bugs/1aa7faf6-transcribe.md) | sweep/voice | 50a8b07b |
| P1 | fixed | voice | [Voice.init (agent focus / persona change / dossier apply) calls reflectToggle without clearing fbNotified, permanently wiping the pinned degrade tooltip while t](bugs/562c293e-voice-init.md) | sweep/voice | 50a8b07b |
| P1 | fixed | world | [A Meeseeks helper sprite whose terminal `task` event is lost stays asserted LIVE forever — the ledger has no TTL, no snapshot reconcile, and no reset on NEW AGE](bugs/c96c4d41-a-meeseeks-helper-sprite-whose-terminal-task-eve.md) | sweep/world | meeseeks layer removed 2026-07-30 (agent/meeseeks-visual) |
| P1 | fixed | world | [ROUTINES › REVOKE ACCESS toasts "access revoked" (green) on a 4xx/5xx — bare `fetch` resolves, so the unattended grant survives its own success message](bugs/fd0f7223-routines-revoke-access-toasts-access-revoked.md) | sweep/world | 3f0d1205 |
| P2 | open | providers | [credPool.penalize() on the run's PRIMARY key is inert — the sole credPool.order() call site (index.js:10580) receives a pool with runKey filtered out](bugs/8d7b0b52-credpool-penalize.md) | sweep/providers | — |
| P2 | open | providers | [The index.js summarize closure captures the pre-failover provider/model — after a credential rotation or provider fallback, two failed summaries flip compaction](bugs/cb8dc6c3-the-index-js-summarize-closure-captures-the-pre.md) | sweep/providers | — |
| P2 | open | providers | [The ledger's `unmetered` flag is a stamped verdict with zero readers — every ledger USD aggregate (/api/budget, day/global caps) counts subscription dollars tha](bugs/4007eb1f-the-ledger-s-unmetered-flag-is-a-stamped-verdict.md) | sweep/providers | — |
| P2 | fixed | autonomy | [routine.create's default `arm:true` bypasses the documented single resume seam and clears the durable cron E-STOP — the workshop auto-arm path at index.js:8214](bugs/300b34ab-routine-create-s-default-arm.md) | sweep/autonomy | 6afeb9ee |
| P2 | fixed | channels | [E-STOP silences the channel reply path via the supersede flag, so a deliberately stopped run is indistinguishable from a crashed bot on the phone](bugs/600f4982-e-stop-silences-the-channel-reply-path-via-the-s.md) | sweep/channels | 96fe108d |
| P2 | fixed | release | [t5.1 prerequisite gate accepts T0–T4 verdicts with no installer-hash or freshness binding, though t3.2 already binds T0's recorded installer sha256 to the binar](bugs/4bd953e0-t5-1-prerequisite-gate-accepts-t0-t4-verdicts-wi.md) | sweep/release | b76e340c |
| P2 | fixed | safecell | [A mid-run "Full access" click writes a per-agent '*' wildcard with no readout and no revoke anywhere, and the same wildcard is read by that agent's UNATTENDED r](bugs/13646d93-a-mid-run-full-access-click-writes-a-per-agent-w.md) | sweep/safecell | 226cec3c |
| P2 | fixed | voice | [Failed Live Voice startup leaves a user mute force-enabled](bugs/d02d029b-failed-live-voice-startup-leaves-a-user-mute-for.md) | agent/voice-release-sweep | 8bc9ff9a |
| P2 | fixed | voice | [Muting the speaker mid-reply in hands-free nulls the only surviving rearm heartbeat — the mic never re-opens while the mode button still reads 'hands-free ON'](bugs/2f7b280c-muting-the-speaker-mid-reply-in-hands-free-nulls.md) | sweep/voice | 50a8b07b |
| P2 | fixed | voice | [The /api/stt degrade reason is written to the status line then overwritten by endListening()'s restore in the same synchronous block, so it is never painted](bugs/562b14a5-the-api-stt-degrade-reason-is-written-to-the-sta.md) | sweep/voice | 50a8b07b |
| P2 | fixed | world | [DELETE announces success on a failed request and leaves the row — same missing `resp.ok` check in ROUTINES, LOOPS and CONNECTORS](bugs/aa9cd1cd-delete-announces-success-on-a-failed-request-and.md) | sweep/world | 8e68bf5c |
| P2 | fixed | world | [`open()` has no `if (chanES) return` guard, so a re-entry (DATA › IMPORT → reentry → enterGame → resumeBridge) inside an SSE retry backoff leaves two live Event](bugs/d459160f-open.md) | sweep/world | f4d03511 |
| P2 | fixed | world | [Station tooltip: pointerout during the 320ms show delay cannot clear the pending timer (`if (!anchor) return` runs before hide()), so a ghost card pops up besid](bugs/01caed27-station-tooltip.md) | sweep/world | f4d03511 |

## Open by surface

| Surface | Open |
| --- | --- |
| channels | 0 |
| autonomy | 0 |
| providers | 3 |
| safecell | 0 |
| sessions | 0 |
| skills | 0 |
| onboarding | 0 |
| world | 0 |
| voice | 0 |
| release | 0 |

