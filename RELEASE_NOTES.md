# StarNet v0.10.5

This update improves long-running agent work, makes memory and skills more relevant, and expands how the station can be furnished without changing existing saves.

- Agents can issue independent tool calls in parallel where the safety policy permits, reducing avoidable turn-by-turn delays during multi-step work.
- Long runs now scale tool-output budgets to the active model context window and re-evaluate those limits when a provider fallback changes models, preventing both premature truncation and unreachable compaction thresholds.
- Memory recall and the skill library rank against the current conversation, so unrelated recent material stays out while relevant knowledge and reusable skills surface sooner.
- Failed runs can produce carefully filtered lessons for future attempts, with high-stakes suggestions held for review and personalization controls still respected.
- Reflection, study, scouting, compaction, and skill maintenance can use a configurable lower-cost auxiliary model and effort tier, with safe fallback to the active run model where required.
- REFIT now supports honest authored furniture facings and footprint-aware rotation for eligible decor, including chairs, tables, booths, rugs, and floor decals.
- The furniture catalog adds distinct 3x3 and 5x5 rugs, improves several top-down prop projections, and corrects seating behavior for profile chairs.
- Idle crews gather more naturally while retaining wall, visibility, pathing, and personal-space constraints.
- Existing stations, orientation-free props, memory settings, and saved agent configuration continue to load with backward-compatible defaults.
