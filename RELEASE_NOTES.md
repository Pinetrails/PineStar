# StarNet v0.9.0

StarNet 0.9.0 is the reliability and harness-parity release. It focuses on truthful completion,
safe recovery, durable autonomous work, and a smoother first-use experience.

## Highlights

- Hardened run finalization, compaction recovery, retries, routing, and subagent/routine completion
  so the station does not report work as done before the backing result is durable and verified.
- Added complete-station recovery bundles, authorized project-root checkpoints, exact-root rewind,
  safer workspace ownership, and guarded 0.8.5-to-0.9.0 migration behavior.
- Added inspect-first Skill Exchange installation with immutable source bytes, provenance, quarantine,
  approval gates, and update checks.
- Improved Telegram owner pairing truth and added offline Ogg/Opus voice-note transcription through
  the bundled local speech path.
- Expanded independent parity fixtures, graders, signed receipts, host observers, installed-desktop
  performance measurement, and fail-closed soak tooling.
- Refined onboarding, recommendations, permissions, dock layout, accessibility, station visuals, and
  the shared Windows/macOS release contract.

## Upgrade notes

- Existing 0.8.5 workspaces are migrated through a staged, verified path. StarNet retains recovery
  information and refuses destructive migration when verification cannot complete.
- Provider and channel credentials remain machine-local and may require reauthentication after a
  recovery or machine move.
- The public desktop train supports Windows and macOS. Linux packages are not part of the supported
  public release train for 0.9.0.
