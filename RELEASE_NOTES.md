# StarNet v0.5.1

Everything merged since v0.5.0, cut from the READY-certified rc/0.5.1 line.

## New
- **6 new agent skins** — CRT-head, astronaut, endoskeleton, Ultron (true regen), xenomorph, void wizard.
- **Voice decoupled from the LLM** — free keyless Edge neural TTS floor, dedicated ASR chain (Groq whisper), robotic fallback voice removed.
- **Provider compatibility hardening** — reasoning-effort reaches the wire, unsupported-param self-heal (tools never dropped), xAI cost normalization, Perplexity Sonar roster, plus a live provider-certification harness (`npm run certify:providers`).

## Reliability
- **Scheduler**: missed routines fire once instead of being discarded, transactional dispatch (no fire-over-unpersisted), zombie-run generation fencing, ticker health + delivery outcomes on `/api/cron`.
- **Messaging**: Slack reconnect truth, E-STOP/snapshot across all five channels, durable reply outbox, FORGET honesty.
- **Run honesty**: client disconnects detected on all run routes (no more ghost runs), COMMS folds sidecar death into "station unreachable", idle steer no longer mints a paid run, `/model` warns on unknown model ids.
- **Windows updater**: the NSIS node.exe lock hang is fixed — in-app updates complete cleanly and relaunch (proven end-to-end by the update canary).

## UX
- Confusion-audit rounds: unified labels, SEND & PUBLISH clarity, channel first-step guidance, quest-refresh wording, tour beat polish.
- Nightshift panel legibility: honest "away = idle 15 min" wording, collapsed per-tick decline rows.
- Crew panel run-state reads the world's truth (no stale RUNNING badges).
- Recruit bay recuration: 12 core classes + 9 archetypes in a searchable specialist archive, archetype-seeded scouting.
