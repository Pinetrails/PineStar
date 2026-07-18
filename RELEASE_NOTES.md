# StarNet v0.5.3

Your station now runs on its own schedule — supervised background lifecycle, concurrent sessions, and a big honesty-and-polish sweep.

## Highlights

- **Supervised background lifecycle (Wave 4D):** a tray supervisor keeps scheduled work running with opt-in launch-at-login — no hidden daemon, with a durable emergency cron halt.
- **Multiple concurrent sessions:** run several sessions at once; workspaces are leased so parallel runs never trample each other.
- **KEYS tab:** paste a key for any platform and your agents can use it — keys go to the process environment, never into prompts.
- **Agent personalities & new roster:** fun-five personality modes with a PERSONALITY card in the dossier, plus a redesigned business roster (12 builtins + archetypes).
- **Session rail redesign:** the SESSION TOOLS window is gone — search lives on the rail itself, export in each row's menu.

## Fixes & polish

- Night Shift: agents stay visible on the floor while working away; panel legibility improvements.
- Workshop: honest ◈ resolution marker when a run is no longer pending, plus keep-UNDO for deliverables.
- COMMS/UI: spacing sweep across windows, room shadow fix, commander dossier polish with starter briefing chips, outbox review accordion, task-board popup focus fix, links open reliably again.
- Presence: a live run counts as presence; the away clock starts from run end.
- Models: continuation guard, markup scrub, and empty-response nudge for flaky providers.
- Security & reliability: constant-time IPC token check, untrusted-content fence for web fetch/search, connector OAuth cancel cleanup, channel-trouble notifications, ROUTINES cron health, architecture-audit Tier 1 hardening.
- Settings: edit provider base URLs in-app.

StarNet source is now MIT-licensed.
