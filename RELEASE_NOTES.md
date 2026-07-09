# StarNet v0.4.1

A truthful-telemetry patch release. Every change here closes a gap where the
station could show state the harness couldn't actually prove — the product's
cardinal sin. No new surface area; the station just stops lying in the corners
where a stranded user used to get stuck.

## Save & backup truth (EL-11)
- Refused or failed writes can no longer masquerade as a healthy backup — a
  save that didn't land is reported as degraded/failed, not green.
- Degraded, corrupt, and out-of-disk save states now render honestly instead
  of silently claiming success.

## Auth & recovery truth (EL-10)
- ChatGPT / codex sign-in no longer claims **SIGNED IN** after its token has
  died. Expired auth shows a truthful **SIGN-IN EXPIRED** state with
  **Re-sign-in** / **Disconnect** actions and a reconnect error door.
- Boot-time reap of orphaned sidecars from our bundled Node runtime — the root
  cause behind the lying "signed in" state and stuck reconnects.

## Halt & error-door truth (EL-11)
- The durable E-STOP night-halt is now **visible**: the panel renders
  ⛔ HALTED and names the dial to lift it, instead of a silent stall.
- A stale boot-token 403 opens a **Reload** door instead of a misleading
  "🔑 Add a key" prompt.
- Pre-stream `/api/run` failures carry their response body into the surfaced
  error, so the reason is shown instead of a generic failure.

## Threads & world polish
- Thread mining gains a **substance veto**: grounded-but-empty banter can no
  longer be minted as a thread.
- The chat-stare beat no longer tracks the mouse continuously — it's a rare,
  throttled glance, not a constant follow.

---
Windows installer (NSIS, unsigned). SmartScreen will ask for
**More info → Run anyway** on first launch until code-signing is in place.
