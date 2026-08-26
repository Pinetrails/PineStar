# Pine Star architecture direction

## Current architecture

Pine Star currently uses stock StarNet 0.10.10 architecture at baseline commit `56c3848e`. No Pine Star application source modification existed when `PS-2026-001` began.

| Area | Current responsibility |
| --- | --- |
| `frontend/` | Browser/desktop renderer and visual workspace |
| `sidecar/` | Local Node runtime, providers, tools, persistence, consent, and budgets |
| `shared/` | Cross-boundary event/schema contracts |
| `src-tauri/` | Tauri desktop shell and bundled runtime |
| `test/` | Automated validation and integration gates |
| `qa/` | Live verification, findings, and release evidence |

For stock detail, see [../CODE_MAP.md](../CODE_MAP.md), [BRAIN.md](BRAIN.md), and [HARNESS_ARCHITECTURE.md](HARNESS_ARCHITECTURE.md). Recheck them against code before changing behavior.

## Transformation rules

1. Trace current behavior before editing.
2. Prefer extension or targeted adaptation over replacement.
3. Require a clear Pine Star need, evidence, and rollback path for architectural change.
4. Keep changes narrow and test affected boundaries.
5. Preserve truthful telemetry, consent, security, audit, and E-stop protections.
6. Record major decisions and failed experiments.

## Directional boundaries

- Preserve multi-provider support; Economy/Balanced/Deep are future policy tiers above adapters.
- Make roles/departments extensible rather than hard-coded to a seed roster.
- Keep private operational memory distinct from shared human-readable history.
- Treat the future world UI as a projection of real state, not a replacement for technical controls.
- Review upstream changes selectively.
- Establish Pine Star's own release/signing process; never seek StarNet private signing material.

## Controlled self-improvement

Future code-level improvement follows `INSPECT -> CREATE DEVELOPMENT CHANGE -> TEST -> REVIEW RESULT -> KEEP OR REVERT -> LOG DECISION`. Initially, final code merges remain user-controlled. Constitutional safeguards are outside autonomous modification authority.

