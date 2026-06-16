# GATE — per-workstream COMMS channels (handoff)

Branch: `agent/comms-channels`. This is the v1 GATE from [WARROOM_BUILD_PLAN.md](WARROOM_BUILD_PLAN.md) —
the chat.js single-agent refactor that everything per-agent depends on.

## What landed on this branch
- **`frontend/app/channels.js`** — a pure, DOM-free, UMD model (sibling of `workstreams.js`) that owns
  **per-workstream transient run-state**: `busy`, `runId`, in-flight `acc`, `tools[]`, and the live
  `pending` consent. Keyed by **workstreamId** (NOT agentId — many workstreams share `agentId:'agent'`).
  History is NOT duplicated here; it stays in `Workstreams`.
- **`frontend/app/chat.js`** now keeps all run-state in `Channels` instead of module globals:
  - `send()` gates per-stream (`Channels.isBusy(ws.id)`) — the model supports two streams running at once;
  - `load()` calls **`replayChannel()`** → re-renders a stream's in-flight tool lines / partial reply /
    pending approval from the snapshot (switch-survival), and sets the compose target;
  - `permissionRow(p, ws)` routes consent to **that stream's** runId and clears its pending flag;
  - **`abort()` now cancels EVERY in-flight run**, not just one global (latent DISCONNECT bug fixed).
- **`frontend/index.html`** loads `channels.js` before `chat.js`.
- **`test/channels.test.js`** (wired into `test:fast`) — 37 assertions locking the core: two streams busy
  at once, isolated runId/acc/tools/pending, end/clear one without touching the other, snapshot-is-a-copy,
  compose-target decoupled from selection.

## Verified
- `node test/channels.test.js` → 37 assertions OK; **full `npm run test:fast` green** (incl. lint-emits, lint-determinism).
- `node --check` on both files; **browser boot clean** (no console errors; `Channels`/`Chat` load; live smoke:
  two concurrent isolated streams; `Chat.isBusy()` safe).
- No `shared/events.js` change — the gate is additive (model + DOM only).

## NOT yet done — the dependent slices

### 1. frontend-hud: lift the "can't switch while busy" guard (tiny, unblocks the UX payoff)
Today switching workstreams is **blocked** whenever the displayed stream is busy, so you can't actually
*start* a second concurrent run from the UI. Remove these guards so switching is always allowed (the model
already keeps streams isolated):
- `frontend/app/app.js` — the rail select/open handlers (~L294, ~L300): `if (Chat.isBusy && Chat.isBusy()) return;`
- `frontend/app/stationui.js` — the stream-row handlers (~L420, ~L438): same guard before `Chat.load(s)`
After removal, `Chat.isBusy()` means "the **displayed** stream is busy" — re-entrant send on the same stream
is still correctly blocked inside `send()`.

### 2. comms-channels (next slice): live token re-bind on switch-to-mid-run
`replayChannel()` currently re-renders the partial reply **statically**; the running `send()` closure still
appends to its original DOM row. To make tokens keep flowing into the re-rendered row after you switch *to* a
busy stream, route streaming appends through a module-level "live row for the active stream" that
`replayChannel()` rebinds. Reachable only after slice 1 lifts the guard — verify in-browser with a real key.

## Contract notes
- `composeTargetId` is a **workstreamId**, decoupled from camera/selection (war-room D2).
- The live `AbortController` stays in chat.js (`aborters` Map) — it isn't serializable, so it can't live in the
  pure model; `Channels` holds the `runId` for `Harness.cancel`.
