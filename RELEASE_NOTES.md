# StarNet v0.3.0

Multi-agent reliability, honest telemetry, and headless research.

## Multi-agent workflows
- **Cross-provider delegation fixed.** When an overseer delegated to crew on a different
  provider (e.g. a codex overseer handing off to an Anthropic-modelled researcher), the
  worker ran its own model down the overseer's provider wire and 400'd the instant it
  started — the delegate appeared to "stop working" seconds in, and later workers in the
  chain never got their turn. Workers now run on their OWN provider with the station's
  stored credential; with no credential they fall back to the overseer's provider+model and
  say so honestly.
- **Run streams no longer go silent.** A long delegation left the run's connection
  event-silent for minutes, which idle layers could kill (~5-minute failures). Every run
  stream now sends a keep-alive heartbeat so a working run is provably alive.
- **Delegated workers stay animated.** A worker's desk no longer decays to idle while its
  run is genuinely still going.

## Diagnostics & truth
- **Real version in the bug report.** Diagnostics now show the actual build (this was
  "unknown" before) so a support report names the version you're on.
- **Errors survive a restart.** The diagnostics error tail is persisted, so restarting
  after a failure no longer erases the one artifact that explains it.

## Browser / research
- **Research is headless by default.** Agents no longer pop a visible browser window onto
  your screen to do background research. A controlled window appears only when you explicitly
  ask to watch ("open it on my screen"); `desktop.open` remains the consent-gated way to open
  something in your own browser.

## Under the hood
- De-binaried a core loop file that tooling had been mis-reading as binary.
- Full fast + HTTP test gates green; the multi-agent and browser fixes ship with
  regression tests that reproduce the original failures.
