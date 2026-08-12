# StarNet v0.10.1

This release candidate is a focused trust and reliability patch for v0.10.0.

## Fixed

- Overseer follow-through now catches realistic promises such as “I’ll work on that,” “I’ll take care of it,” and multi-day commitments. A run cannot silently finish after promising work without taking an action; durable future work is created when the appropriate tool is available.
- Telegram HTTP 409 polling conflicts now trigger a bounded re-probe and recovery path instead of leaving the channel offline until a manual reconnect or restart.
- Etsy is now labelled honestly as manual, watched-session OAuth only. StarNet does not yet own Etsy’s consent and access-token refresh lifecycle, so unattended, scheduled, messaged, and Night Shift authority is disabled for Etsy credentials.
- The Windows soak observer now uses a persistent watcher instead of spawning PowerShell every minute, reducing observer resource pressure and separating observer failures from product failures.

## Candidate verification boundaries

- Attended browser-login reuse remains outside this patch and still requires release-candidate proof on a host where the headed Chrome page session can be adopted.
- Safe Cell stdio MCP remains container-only and requires a working Docker-compatible runtime; remote HTTP remains the available MCP route on hosts without one.
- This candidate is not public until the exact installed artifact completes the release soak and the draft release is explicitly reviewed and published.
