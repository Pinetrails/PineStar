# StarNet v0.10.8

This is a critical reliability and workflow update.

- Long conversations now keep their full working memory through chunked compaction, with safer cross-model fallback handling instead of silently dropping early results.
- Sandboxed work now fails closed when the requested sandbox is unavailable. Shells and tools will no longer fall back to the host while presenting the run as isolated, and checkpoints are enabled by default.
- Provider pricing and budget controls now cover every metered provider family, add an unpriced-token ceiling, and enforce per-line limits for stages, cost per message, and daily spend.
- REFIT gains JOINER fan-in and bounded LOOP machines, editable loop verdicts and exits, truthful sample results, and a run gate that posts the line currently on screen before dispatch.
- Routines are more resilient: repeated failures auto-pause, degraded storage is shown explicitly, schedules that cannot fire are named, and Run Now accounts for the whole line.
- Recovery dead ends now have exits. StarNet can reclaim a stale pre-reboot workspace lock, restart an unreachable station service, quarantine prior station data with START FRESH, and explain an empty linked wallet before WAKE.
- Connector setup arrives at the moment it is needed, including goal-matched CONNECT YOUR WORLD suggestions, same-session link adoption, and a simpler Google setup flow.
- Recipe runs can verify connector writes by reading them back, avoid duplicate writes within a work item, report drift against known-good history, and turn Commander corrections into reviewable skill improvements and golden examples.
- Diagnostics and release checks now expose swallowed-error pressure, enforce source-text integrity, and verify the updater against StarNet's supported Windows and macOS platforms.

Release validation: this critical-fix cut waives the 48-hour attended RC soak. The exact candidate still requires the full fast and HTTP gates plus installed-app smoke; the hosted T0 clean-install and G1 packaged-lifecycle gates remain mandatory before publication.
