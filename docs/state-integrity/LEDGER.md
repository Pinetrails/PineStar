# State Integrity — living ledger

Backlog + status for the reset-on-transition hardening pass. One row per finding.
Status: **OPEN** → **FIXED** | **HELD** (ready, awaiting coordination on a hot file) |
**NEEDS-PRODUCT-CALL** | **WONTFIX** (with rationale).

Discovery: parallel read-only audit, 2026-06-23 (4 module clusters). 13 real leaks + 3
product-call borderlines. The founding crew bug is FIXED and shipped on trunk.

## Matrix (transition × stateful module)

✅ audited-clean · ⚠ leak-found · 🛠 fixed · — n/a

| module \ transition | WAKE | RESUME | DISCONNECT | NEW AGENT | SUMMON | REFIT |
|---|---|---|---|---|---|---|
| World: crew/listeners/firstWake | 🛠 | 🛠 | 🛠 | 🛠 | ✅ | ✅ |
| World: FloorStats/SlagLog | ⚠ W1 | ⚠ W1 | — | ⚠ W1 | — | — |
| World: Conveyor | ⚠ W2 | ✅ | — | ⚠ W2 | — | ⚠ W2 |
| World: chanQueues/serverLit | ⚠ W3 | ⚠ W3 | — | ⚠ W3 | — | — |
| World: xp/beat clocks | ⚠ W4 | ✅ | — | ⚠ W4 | — | — |
| World: connector poll | — | — | ⚠ N1 | — | — | — |
| World: channels SSE | — | — | ⚠ N2 | — | — | — |
| Voice: speak queue/watchdog | ⚠ C4 | ⚠ C4 | ✅ | ⚠ C4 | — | — |
| Voice: forcedSpeak | ⚠ C3 | ⚠ C3 | ✅ | ⚠ C3 | — | — |
| Chat: proposalRunsSeen/wiQDepth | ⚠ C2 | ⚠ C2 | ✅ | ⚠ C2 | — | — |
| Tutorial: finished latch | ✅ | ✅ | ✅ | ⚠ C1 | — | — |
| MintStore (skynet.mint.v1) | ⚠ S1 | ✅ | — | ⚠ S1 | — | — |
| CuriosityStore (.curiosity.v1) | ⚠ S2 | ✅ | — | ⚠ S2 | — | — |
| Marketplace ack / Build seen | — | — | — | ⚠ S3/S4 | — | — |
| Workstreams / Xp / Profile / Dossier | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| StationUI panels | ✅ | ✅ | ✅ | ✅ | — | — |
| Harness fetch / CloudSave / codexPoll | ✅ | ✅ | ✅ | ✅ | — | — |

## Findings (ranked)

| ID | Sev | Conf | Status | File | Leak (one line) |
|---|---|---|---|---|---|
| **W1** | Med | High | OPEN | world.js loadStation | FloorStats economy (spend/slag/yield) + SlagLog not reset → new agent's HUD shows prior agent's numbers. `floor.reset()`/`slaglog.reset()` exist. |
| **W2** | Med | High | OPEN | world.js loadStation | Conveyor boxes not reset → prior agent's belt crates ride the new floor (and stale coords after REFIT). `convey.reset()` exists. |
| **N1** | Med | High | OPEN | world.js connectChannelBridge | `setInterval(pollConnectors,5000)` handle never captured → permanent `/api/connectors` poll from the title screen after disconnect. |
| **N2** | Med | High | OPEN | world.js connectChannelBridge | `EventSource('/api/channels/events')` never closed on disconnect; `onerror` self-reconnects forever from the title screen. |
| **S1** | Med | High | OPEN | mintstore.js + onWake | `skynet.mint.v1` survives `Save.clear()` (which only wipes `skynet.save`) → new agent inherits prior agent's recurring-task memory + SUGGESTED shelf. |
| **C4** | Med | Med | OPEN | voice.js init | `Voice.init()` doesn't `stopSpeaking()` → if WAKE isn't preceded by a draining disconnect, prior agent's TTS finishes into the new agent + leaked watchdog interval. |
| **W3** | Low | Med | OPEN | world.js loadStation | `chanQueues` Map + `serverLit` Set never cleared → phantom backlog gauge / a body stuck "working" after a mid-run disconnect. |
| **W4** | Low | Med | OPEN | world.js spawn | `xpAgent` + one-shot beat clocks (levelUp/compact/slag/outbox) not reset → brief stale level chip / a beat replays one frame into the new agent. |
| **S2** | Low | High | OPEN | curiositystore.js + onWake | `skynet.curiosity.v1` (`dismissed` dims) survives `Save.clear()` → new agent's curiosity nudges suppressed by prior agent's dismissals. |
| **C1** | Low | Med | OPEN | tutorial.js | `finished` latch set in finishUp, never reset → diverges from the persisted gate; a re-triggered first-command becomes a silent no-op. |
| **N3** | Low | High | OPEN | world.js | Structural: `listenersBound`/`bridged` latched, no paired disconnect-time release — the root that makes N1/N2 leak. Fix alongside N1/N2. |
| **C2** | Low | Low | OPEN | chat.js init | `proposalRunsSeen` Set + `wiQDepth` Map (keyed by the literal `'agent'`) not cleared on init → possible phantom queue depth for the new hero. |
| **C3** | Low | Low | OPEN | voice.js init | `forcedSpeak` bookkeeping flag not reset in init → an unpaired set can make the next agent wrongly restore-mute the speaker. |
| **S3** | Low | Med | NEEDS-PRODUCT-CALL | marketplace.js | `skynet.profile.ack.v1` consent flag is global; new agent's profile resets to zero but consent note stays suppressed. Per-user or per-profile? |
| **S4** | Low | Med | NEEDS-PRODUCT-CALL | build.js | `skynet.refit.seen` global → new agent skips the BUILD first-use guide. Per-user or per-agent? |
| **C5** | Low | Low | NEEDS-PRODUCT-CALL | tutorial.js | `skynet.tutorial.v1` station-wide; NEW AGENT doesn't re-teach First Command. Intended once-ever, or per-agent? |

## Verified-clean (do not re-audit)

Workstreams.reset (full wipe), XpStore (explicit fresh fallback + `wired` guard),
ProfileStore/DossierStore (pendingX null on WAKE → fresh; first-seed keys off the fresh
slice), StationUI.enter/leave (closes terminal windows, clears runningAgents; once-guards),
Harness fetch-hardening (`__SKYNET_FETCH_HARDENED__` guard), CloudSave.installUnloadFlush
(boot-once, not per-enterGame), codexPoll (cleared on every exit), World ResizeObserver
(disconnects before re-observe), audio.js (clears its interval; self-stopping oscillators),
`stars` (seeded once), Chat.abort (aborts every per-stream controller + stops convo),
onboarding/intake stop() (clear timers/flags), Tutorial bus handlers (gated by `active`).

## Iteration log

- _(iteration 1 — see status updates above as rows move to FIXED)_
