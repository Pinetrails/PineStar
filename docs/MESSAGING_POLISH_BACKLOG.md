# Telegram Channel — Hermes-Level Polish Backlog

> Companion to `MESSAGING_INTEGRATION_PLAN.md`. Produced by a parallel Hermes-vs-ours audit (60 agents, 53 candidate improvements verified against our real code, 2026-06-14). Every item below is **purely additive to our channel code** — **none requires a `shared/events.js`/`schema.js` change** (the existing `channel.inbound`/`channel.delivery`/`channel.connect` + frozen `permission.prompt`/`permission.response` rungs cover all of it), so **no cortex-memory contract request is needed**. Discipline unchanged: one-commit-sized, gating-test-first, fast suite green before merge.

## 1. Where we stand vs Hermes

Our channel is a clean two-layer pipeline (fetch transport → transport-agnostic adapter → hub → runOnce) that already does the hard correctness things — offset-based dedup with no app-level seen-set, capped exponential reconnect backoff with fatal-vs-transient classification, single-flight polling with clean AbortController shutdown, `allowed_updates` narrowing, race-free one-run-per-chat supersede, durable per-chat transcripts outside the fs jail, atomic secret-at-rest, word/line-boundary chunking to 4096, and live agent-identity sync so a DM runs the **same** agent. The honest gap is **not** transport robustness — it's a few correctness/safety holes Hermes closes by design (unconditional DM admission, offline-backlog replay on restart, a couple of dead-but-extracted fields), plus UX parity (typing indicator, control commands, bot-identity validation, formatted replies). Hermes's heaviest machinery (live edit-streaming, MarkdownV2 table rewriting, pairing codes, DoH/proxy, pool draining, multi-tenant authz) is correctly **out of scope** for a single-user owner-only local harness.

## 2. Prioritized improvements

| Priority | Improvement | Why it matters | Files | Contract |
|---|---|---|---|---|
| **P0** | Owner-only DM admission (first-DM trust-on-first-use; default-deny others) | Today every DM is admitted (`adapter.js:73-76`) — a discoverable bot lets a stranger spend the OpenRouter key + read agent memory | `adapter.js`, `index.js`, (opt) `stationui.js` | additive (ownerId in `channelSecrets.telegram`) |
| **P0** | Drop-pending backlog on connect (`getUpdates({offset:-1})` confirm-and-discard) | Offset defaults to 0 (`adapter.js:79`) → reboot replays ~24h of buffered DMs and autonomously runs stale tasks | `adapter.js` | additive (connect path) |
| **P0** | 409-Conflict → fatal stop + proactive `deleteWebhook` before first poll | A 409 (two pollers / stale webhook on a reused token) is treated transient → backoff-loops forever showing "down", never receives a message | `telegram.transport.js`, `adapter.js` | additive (reuses `onStatus state:'error'`) |
| **P0** | Honor 429 `retry_after` before the one-shot resend | `retryAfter` is extracted (`telegram.transport.js:71`) but never read (`adapter.js:158`) — resend fires instantly into the open flood window and the chunk drops | `adapter.js` | additive (field already on SendResult) |
| **P1** | getMe eager token validation at connect (+ `@handle` in status) | `/connect` returns `connected:true` before any network call (`index.js`) — a bad token only dies seconds later on first poll | `telegram.transport.js`, `index.js`, `stationui.js` | additive (new transport method + status field) |
| **P1** | Typing indicator (`sendChatAction('typing')`) during runs | Runs take many seconds; the hub buffers and sends once at the end → pure silence | `telegram.transport.js`, `telegram.js`, `hub.js` | additive (needs injected timer for deterministic tests) |
| **P1** | `/stop` + `/new`(`/reset`,`/clear`) command interceptor | Owner has no Telegram-side way to abort without restarting, or wipe a stale transcript — control-plane actions an LLM turn can't do | `hub.js`, `store.js` (new `clearHistory`) | additive (reuses inflight Map) |
| **P1** | Static `/help` + one-time `setMyCommands` | `/help` today burns a model call; the blue "/" menu is empty | `hub.js`, `telegram.transport.js`, `index.js` | additive |
| **P1** | MarkdownV2 outbound formatting + per-chunk plain-text fallback | Replies go out plain (`hub.js:99`) → `**bold**`/`` `code` ``/`[links]` render literally | new `telegram.format.js`, `hub.js` | additive (transport already forwards `parse_mode`) |
| **P2** | Interactive consent inline keyboard (C6 / task #11) | `onCallback` is a noop (`hub.js:182`); ungranted writes silently default-deny — no phone approval | `hub.js`, `telegram.transport.js`, `index.js` | additive (existing `permission.*` rungs) |
| **P2** | `/model <slug>` text command | We switch models; validate against `provider.listModels()` + persist | `hub.js`, `index.js` | additive |
| **P2** | Client-side timeout on the SEND path only | A wedged sendMessage socket can stall `deliver()` forever | `telegram.transport.js` | additive |
| **P2** | Message reactions 👀→👍 (default-off flag) | "saw it / working / done" ack without chat spam | transport/adapter/hub/index | additive (`SKYNET_TELEGRAM_REACTIONS`) |
| **P2** | (i/N) multi-part indicator on chunked replies | A long split reply reads as parts, not truncated/duplicated | `hub.js` | additive |
| **P2** | `chmod 0600` on secrets.json | plaintext OR key + bot token; correct hygiene (no-op on Windows) | `index.js` | additive |
| **P2** | Surrogate-pair guard in `chunkText` hard-cut fallback | the no-whitespace hard cut can bisect an emoji/CJK char into a lone surrogate | `hub.js` | additive |
| **P2** | Wrap `dispatch()` body in try/catch | only `normalize()` is guarded (`adapter.js:88`); a throw from `admitted`/`onInbound` kills the detached loop | `adapter.js` | additive |
| **P2** | Strip `key`/`model` from `/sync` | `/sync` accepts a key patch the UI never sends; removing it keeps identity-sync strictly additive | `index.js` | additive/subtractive |

## 3. SKIP (left in the mine)

Live edit-streaming + edit throttle/`_edit_overflow_split` + draft streaming; MarkdownV2 table/spoiler/blockquote rewrite + separate HTML keyboard path; code-fence repair in the chunker (moot for plain text); DoH + fallback-IP transport + proxy auto-detection (censorship/scale); connection-pool drain / pool-size tuning / wedge heartbeat (httpx/PTB artifacts); full pid/argv/psutil single-instance lockfile (EADDRINUSE + 409-fatal cover the realistic double-launch); pairing codes / owner-admin tiers / per-scope slash allowlists / per-user rate-limit (multi-tenant — trust-on-first-use is the right-sized version); clarify inline keyboard (would need a **requested** new `shared/events.js` rung + a clarify tool/loop seam — free-text "which did you mean?" suffices); paginated model-picker keyboard; media in/out (photo/voice/document), edited-message reprocessing, group @mention gating; fsync-before-rename / RLock (already atomic; no Python-threads problem in single-threaded Node).

## STATUS — all P0 SHIPPED (2026-06-14, suite green, additive-only)

- ✅ **P0-A** owner-only DM admission (trust-on-first-use) — `adapter.js` owner gate + `telegram.js`/`index.js` wiring + persisted `ownerId`; tests in `channels.adapter.test.js`.
- ✅ **P0-B** drop-pending backlog on connect — generic `adapter.connect()` opt-in (`dropPendingOnConnect`), ON by default in `telegram.js`; tests in `channels.adapter`/`channels.telegram`.
- ✅ **P0-C** 409→fatal (+ proactive `deleteWebhook` before first poll) — `telegram.transport.js` + `adapter.connect()`.
- ✅ **P0-D** honor 429 `retry_after` before the one-shot resend — `adapter.send()`.

P1 (getMe validation, typing indicator, `/stop`+`/new`+`/help`, MarkdownV2) and P2 remain. Deploy: restart the sidecar to load the P0 backend; the first DM after reconnect claims ownership.

## 4. Recommended first 3 commits

1. **`feat(channels): owner-only DM admission (first-DM trust-on-first-use)`** — P0-A. Close the open-key/open-memory door before anything else.
2. **`feat(channels): drop pending Telegram backlog on connect`** — P0-B. Stop stale-task replay on reboot.
3. **`fix(channels): 409 → fatal (+ deleteWebhook) and honor 429 retry_after`** — P0-C + P0-D bundled (both tiny, both in the transport/adapter error paths).

Each is one-commit-sized, gating-test-first, additive-only, suite green before merge.
