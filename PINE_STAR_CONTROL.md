# Pine Star control

The concise front door for current project state.

Pine Star is built on StarNet, its upstream technical foundation.

| Field | Current value |
| --- | --- |
| Previous phase | **Phase 1 — Stock StarNet Baseline — COMPLETE** |
| Current phase | **Phase 2 — Foundation** |
| Last milestone | Clean stock StarNet baseline established and tagged `starnet-baseline-0.10.10` |
| Current change | `PS-2026-001` — documentation and governance foundation |
| Application source modified yet | **No** |
| Packaged desktop baseline | **PASS** |
| Fresh onboarding baseline | **PASS** |
| Documentation state | **Complete; review/approval pending** |
| Next goal | Review and approve this documentation, then begin controlled Pine Star foundation/rebranding under a separate Change ID |

## Known stock-baseline issues

- `test:fast`: the checkpoint test's function-extraction regex did not match the baseline source even though `checkpointsEnabledFromEnv` is present; see the evidence-qualified detail in `docs/BASELINE.md`.
- `desktop:dev`: voice-dependency staging omission.
- `desktop:dev`: frontend-origin/sidecar API-auth mismatch.
- Packaged build: StarNet updater private signing key unavailable to the fork.

These are baseline findings, not Pine Star regressions. See [docs/BASELINE.md](docs/BASELINE.md).

## Next references

[Working rules](AGENTS.md) · [Detailed status](docs/CURRENT_STATUS.md) · [Roadmap](docs/ROADMAP.md) · [Decisions](docs/DECISIONS.md) · [Current change](docs/change-records/PS-2026-001.md) · [Docs index](docs/INDEX.md)
