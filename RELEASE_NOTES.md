# StarNet v0.10.0

This candidate consolidates the 0.10.0 execution, reliability, and interface work. Release
readiness remains evidence-bound: implementation and automated coverage are not presented as
live host proof.

## Candidate verification boundaries

- **Attended browser login is not yet release-proven.** The watched-COMMS flow opens a visible
  Chrome window so the Commander can sign in without sharing a password with the agent. On the
  audited Windows host, Chrome connected at browser-level CDP but `Page.enable` failed before a
  page session was adopted, so the Done-card handoff and authenticated-session reuse were not
  proven.
- **Safe Cell stdio MCP is container-only and not yet live-proven.** Local stdio connectors
  require an existing Safe Cell agent and a working Docker runtime through the exact container
  broker path; the installed desktop does not fall back to an interactive host child. The
  audited host had no Docker, Podman, nerdctl, or WSL, so real container stdio could not run.
  Remote HTTP remains the available MCP route on such a host.
