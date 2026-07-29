# TELEGRAM PARITY PLAN — getting StarNet to Hermes' 10/10

Written 2026-07-28, after a live diff of `hermes-ref/plugins/platforms/telegram/adapter.py`
(8,776 lines, 49 dedicated test files, 25 `config.extra` options, 19 `TELEGRAM_*` env knobs)
against StarNet's channel stack (`sidecar/channels/*`, ~1,900 lines shared across five
platforms, 6 Telegram test files).

Grounding note: the Hermes side was read selectively — module header, the streaming /
batching / gating / media functions, and the complete Bot-API call surface. The scorecard
below is a **major-feature** diff, not a line-by-line one. Items marked `VERIFY` are ones I
did not prove on either side and must be checked before they are built.

---

## 0. The crux: why we are behind, and the one decision that unblocks everything

This is not a quality gap. It is an **architectural** one, and it was a deliberate choice.

- **Hermes** has a Telegram-*specific* adapter. It is free to use `message_thread_id`,
  `sendMessageDraft`, forum topics, reactions — anything the platform offers.
- **StarNet** has ONE generic adapter (`channels/adapter.js`) driving Telegram, Discord,
  Slack, Matrix and Signal. Telegram supplies only `normalize()` and a length limit. That
  design bought us five platforms for the price of one — and it caps us at the
  *intersection* of what all five can do.

We do **not** fork into a Telegram-specific adapter. StarNet already has the correct seam
and uses it in four places today: **transport-optional capability methods**. `getFile`,
`answerCallback`, `editMessage` and `setCommands` all return `{ok:false, error}` when the
transport lacks them, and the hub falls back (that is exactly what keeps Discord/Slack
working while Telegram gets real buttons).

> **THE PATTERN, and every phase below obeys it:** a new Telegram capability is
> (1) a method on `telegram.transport.js`, (2) a passthrough on `adapter.js` that answers
> `{ok:false,error}` when the transport lacks it, (3) a hub call-site that **probes and
> degrades**. No hub code may assume Telegram. A platform that cannot do the thing must
> lose the polish, never the message.

Corollary law: **the floor is delivery.** Every enhancement here can fail; none of them may
cost the member the reply. That is already how the markdown→HTML fix works (a 400 on the
entity string resends as plain text) and it is the acceptance bar for all of it.

---

## 1. Scorecard — Hermes' 49 Telegram tests mapped onto StarNet

### HAVE (parity today, some of it better)
| Hermes test | StarNet |
|---|---|
| `approval_buttons` | `/approvals` + `channels/prompts.js` — ours is bounded + token-resolved, Hermes' leaks and FIFO-crosses |
| `callback_auth_fail_closed` | fixed here; an unclaimed owner is not a licence |
| `auth_check`, `bot_auth_bypass` | owner trust-on-first-use in `adapter.js` |
| `conflict` | 409 → `.fatal`, with an actionable message |
| `pending_update_probe` | `dropPendingOnConnect` + the deferred "I was offline" notice |
| `init_deadline`, `start_polling_timeout` | `POLL_DEADLINE_MS` (poll timeout + 15s slack) |
| `network`, `network_reconnect` | fixed backoff ladder, no jitter (determinism) |
| `max_doc_bytes` | `MAX_MEDIA_BYTES` 8MB, refused before buffering |
| `caption_merge` | caption becomes the turn text; album merge via `mediaGroupId` |
| `documents` (inbound) | `getFile` → workspace attachment |
| `model_picker` | `/model` |
| `format`, `rich_messages` | **just shipped** — `telegram.format.js` + HTML with a plain-text floor |

### PARTIAL
| Gap | Where we stand |
|---|---|
| `typing_backoff` | we fire `sendChatAction` and stop on a hard error, but there is **no 429 cooldown** per chat |
| `send_path_health` | delivery events + durable outbox exist; no health/degradation signal |
| `rich_newlines`, `send_draft_format` | only the subset our converter proves safe |
| `text_batching` | we **supersede** (abort run #1, restart) where Hermes **batches** into one turn |

### MISSING (verified absent)
Outbound media (`sendPhoto/Document/Video/Voice/Audio/Animation/MediaGroup`) ·
`audio_vs_voice` + `voice_v0_regressions` (no STT on inbound voice) ·
`status_indicator`, `status_update` · `reactions` · `progress_edit_transient`,
`overflow_partial` (no live streaming) · `topic_mode`, `forum_commands`,
`thread_fallback`, `prune_stale_topic_binding` (no `message_thread_id` anywhere) ·
`group_gating`, `mention_boundaries`, `noise_filter` (we answer **every** group message;
no `is_bot` filter) · `channel_posts` · `reply_mode`, `reply_quote` ·
`clarify_buttons` · `webhook_secret` (poll-only) · `error_redaction` ·
`username_chat_id` · `photo_interrupts` · link-preview control · proxy ·
`allowed_users` (we have owner-TOFU + allowed *chats*, not a user list)

---

## 2. The plan

Ordered by **member-visible value ÷ risk**, not by Hermes' file order. Each phase is
independently shippable and independently gated. Nothing here changes the other four
platforms except through the capability-probe seam.

### P0 — DONE (this lane, on trunk)
`0a7e1771` `/approvals` no longer strips the office · `71806559` `/tools` honesty ·
`12922944` markdown→HTML, `/start`, poll-loop wedge. Baseline for everything below.

### P0.5 — DONE (2026-07-29): inbound context — reply quoting + the silent drops
Found on a SECOND pass (§1.5 below), built ahead of P1 because both are "the bot ignored me"
from the member's side and both are small.

- `reply_to_message` is now read (`telegram.js` `replyOf`). The quoted text rides as a fenced,
  attributed preamble above the member's own words (`hub.js` `replyPreamble`, bounded to 500
  chars); the quoted message's MEDIA is ingested with the turn, tagged `fromReply` so every
  note says where the file came from. **The forum trap is handled:** inside a topic Telegram
  sets `reply_to_message` on EVERY message (pointing at the topic-creation message), so that
  case is suppressed or every group turn would carry a phantom quote.
- Location / venue / contact / poll / dice / story / animated + video stickers no longer fall
  through to `message:null` (`telegram.js` `describeOf`) — they arrive as a descriptor line.
  `describeOf` is an **allowlist of user content**: service messages (joins, leaves, pins,
  title changes) still return `message:null`, or the bot starts narrating group housekeeping.
- The preamble is built from `msg.replyTo` only, never `msg.text`, so command parsing, floor
  routing and task classification still see the raw message.
- Proof: `test/channels.telegram.context.test.js` (57 assertions, in `test/fast.list`), each
  half proven by reverting the fix and watching it go red.

### P1 — Outbound media *(biggest functional hole)*
Today the agent can receive a file and **cannot send one back**. It generates an image or
writes a report and can only describe it.

- `telegram.transport.js`: `sendPhoto/sendDocument/sendVideo/sendAudio/sendVoice/sendMediaGroup`.
  **Real lift:** these need `multipart/form-data`; our transport is JSON-only today. Build one
  small multipart encoder (no new dependency) and unit-test it against a byte fixture.
- `adapter.js`: `sendMedia(chatId, items, opts)` passthrough, `{ok:false}` when unsupported.
- `hub.js`: an outbound attachment path so a run's produced files ride the reply; cap size,
  degrade to "saved to your workspace at `<path>`" when the channel can't carry it.
- Agent-facing: extend `channel.send` to accept attachments — **known-targets-only stays law**
  (`reach-parity` lane); free-form addressing is an exfil path.
- Proof: `channels.telegram.media.test.js` + an e2e that asserts the multipart body.

### P2 — Voice both ways *(highest magic-per-line; we already own both engines)*
Inbound voice is **dead input** today: we save the `.ogg` and tell the model "saved to
`<path>`", which it cannot hear. We already have `/api/stt` (`STT_MODELS`) and TTS.

- Inbound: voice/audio → existing STT → put the **transcript** in the turn text (keep the file
  saved and referenced). Mark it as transcribed so the model never quotes it as verbatim user text.
- Outbound: reply → TTS → `sendVoice`, opt-in per chat (`/voice on|off`), never the default.
- Watch: the `voice-first-word-only` law — a cold-off/backoff must never guillotine work in flight.
- Proof: `channels.telegram.voice.test.js`, incl. an STT failure that still delivers the text reply.

### P3 — Group discipline *(cheap, stops us being noisy and expensive)*
We currently answer **every message in a whitelisted group** and never check `is_bot`.

- `require_mention` (default ON for groups), `mention_patterns`, `observe_unmentioned`
  (store as context, dispatch only when addressed), `allowed_users`, bot-sender filter,
  `guest_mode`.
- This is partly a **spend** fix and partly a security one — put `allowed_users` alongside the
  existing owner gate, not instead of it.
- Proof: `channels.telegram.groups.test.js` — an unmentioned group message must cost zero model calls.

### P4 — Live progress *(most perceived polish; most invasive — do it after P1–P3)*
Hermes edits the message as the model streams (27 `edit_message_text` sites, plus native
`sendMessageDraft`/`sendRichMessageDraft`). This is most of why theirs "feels amazing".

- Placeholder message → throttled `editMessageText` on token deltas → final send.
- Must handle: Telegram edit rate limits, `message is not modified` (a no-op 400), transient
  edit failures (never lose the final), and **overflow continuation** when the stream passes 4096.
- Native drafts (`sendMessageDraft`, Bot API 9.5+) are a **later** optional fast-path — probe and
  degrade to the edit path; do not make it a dependency.
- Proof: `channels.telegram.stream.test.js` — assert the final text is delivered **even when every
  intermediate edit fails**.

### P5 — Threads, forums and reply surface
- Plumb `message_thread_id` end to end: inbound binding, outbound replies, stale-binding prune.
- `topic_mode` / `forum_commands` / `thread_fallback`; `allowed_topics`, `ignored_threads`.
- `reply_quote` / `reply_to_mode`; link-preview control; `channel_post` in `ALLOWED_UPDATES`.
- Reactions as a cheap status ack (`setMessageReaction`) + `status_indicator`.
- Proof: `channels.telegram.topics.test.js` — a forum reply must land in the **originating** topic.

### P6 — Deployment + hardening
- **Webhook mode** + `webhook_secret` (unblocks hosted; we are poll-only). Keep long-poll the default.
- **Error redaction** — we pass raw `e.message` into `console.error`; a fetch error carrying the
  bot-token URL would leak. Hermes redacts explicitly. *Do this one early — it is small and it is a
  secret-leak class.*
- Proxy support, `username → chat_id` resolution, typing 429 cooldown, send-path health.
- **Text batching** to replace supersede-on-rapid-messages (cheaper, loses less).

---

## 3. Where we should NOT copy Hermes

- **Do not fork a Telegram-only adapter.** The capability-probe seam gets us the same result
  and keeps four other platforms alive.
- **Do not adopt their prompt-registry semantics.** Theirs leaks (dicts only emptied on tap) and
  resolves FIFO, so with two live prompts the second tap answers the first. Ours is bounded and
  token-resolved. Keep ours.
- **Native drafts are not a dependency.** They need a very recent Bot API; probe and degrade.
- **Free-form outbound addressing** stays refused whatever Hermes does — known-targets-only.

## 4. Definition of 10/10

1. Every row in §1 is HAVE, or is a documented, deliberate refusal in §3.
2. A Telegram test file per phase, each proven by **reverting the fix and watching it go red**.
3. Every enhancement degrades to a delivered plain-text reply when its API call fails.
4. Discord/Slack/Matrix/Signal behaviour is byte-identical before and after every phase.
5. `npm test` green on trunk after each phase, with its own merge digest in `qa/STATUS.md`.

## 5. Honest sizing

P1–P3 are the ones a member would notice tomorrow, and they are mostly wiring over engines we
already own. P4 is the one that changes how the product *feels* and is where the real
engineering risk sits (rate limits, partial state, overflow). P5–P6 are breadth.

This is a multi-lane program, not a single sitting. Recommended order:
**P6-redaction → P1 → P2 → P3 → P4 → P5 → rest of P6.**
