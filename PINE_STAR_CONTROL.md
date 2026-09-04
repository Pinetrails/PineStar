# Pine Star control

The concise front door for current project state.

Pine Star is built on StarNet, its upstream technical foundation.

| Field | Current value |
| --- | --- |
| Previous phase | **Phase 1 — Stock StarNet Baseline — COMPLETE** |
| Current phase | **Phase 6 — Business System foundation (earlier adapter work remains)** |
| Last milestone | `PS-2026-001` documentation/governance foundation committed and pushed as `1c2ef0d4` |
| Current change | `PS-2026-039` — Terminal Publication Request Identity — **COMPLETE** |
| Application source modified yet | **Yes — presentation-only frontend identity in the first PS-2026-002 batch** |
| Packaged desktop baseline | **PASS** |
| Fresh onboarding baseline | **PASS** |
| Documentation state | `PS-2026-001` **complete and approved**; `PS-2026-002` **complete for the presentation foundation** |
| Next goal | Continue internal Phase 6 work while publication approval/execution remain deliberately unavailable |

## Known stock-baseline issues

- `test:fast`: the checkpoint test's function-extraction regex did not match the baseline source even though `checkpointsEnabledFromEnv` is present; see the evidence-qualified detail in `docs/BASELINE.md`.
- `desktop:dev`: voice-dependency staging omission.
- `desktop:dev`: frontend-origin/sidecar API-auth mismatch.
- Packaged build: StarNet updater private signing key unavailable to the fork.

These are baseline findings, not Pine Star regressions. See [docs/BASELINE.md](docs/BASELINE.md).

## Next references

[Working rules](AGENTS.md) · [Detailed status](docs/CURRENT_STATUS.md) · [Roadmap](docs/ROADMAP.md) · [Decisions](docs/DECISIONS.md) · [Current change](docs/change-records/PS-2026-039.md) · [Docs index](docs/INDEX.md)
