# Archived one-off scripts

Moved here 2026-07-05 (debt-tier0 cleanup). None are referenced by package.json,
other scripts, tests, qa, or loops — verified by grep before the move. Kept in
the tree (not deleted) because they encode CDP/capture recipes that may be worth
mining; delete freely if they rot.

| Script | What it was |
|--------|-------------|
| bug-hunt.mjs | standalone debug probe |
| devverify.mjs | orphaned UI verify routine |
| shoot-class-edit.mjs | one-off UI capture (class editor), pulls in shoot-gear |
| shoot-gear.mjs | one-off UI capture (shared-gear dossier) |
| shoot-meeseeks.mjs | one-off UI capture (meeseeks swarm) |
| uimeasure.mjs | DOM geometry probe |
| uiprobe.mjs | DOM probe superseded by uishoot/uiplay lib |

NOT archived despite looking dead: `starnet-release-manifest.mjs` — it is
required by `scripts/t5-public-distribution.mjs` (live t5 gate).
