# Visual-Auditor loop (L6) — the 24/7 "SEE the rendered game and fix incoherence" loop

**Why this exists:** the game UI *is* the product, and every prior audit was text-based
(DOM/API/source) because `preview_screenshot` and `chrome --virtual-time-budget` both hang
on StarNet's always-animating canvas. Visual incoherence (overlap, clash, off-center,
unpolished, layers that don't complement) is invisible to text checks. `scripts/uishoot.mjs`
is the unlock: it drives headless Chrome over CDP and captures on a **fixed wall-clock wait**.

**Andrew's mandate:** he must NOT be the one who finds UI problems. This loop finds + fixes them.

## One cycle

1. **Capture every state** (auto-boots a SKYNET_DEV sidecar if none is up):
   ```
   node scripts/uishoot.mjs --boot
   ```
   Output → `.uishots/*.png` (ingame, crew-*, work-*, build-*, sys-*). ~40s for the full sweep.
   Override target with `SKYNET_SHOT_PORT`; output dir with `SKYNET_SHOT_DIR`.

2. **Read each PNG** and judge it against the incoherence rubric:
   - **Overlap** — panels/layers stacking so content is buried or competes.
   - **Off-center / dead space** — a lone panel shoved to a corner; >40% empty.
   - **Clash** — two paradigms fighting (e.g. a translucent floating box next to a
     full-bleed overlay), inconsistent panel widths/chrome, bright live floor bleeding
     through text.
   - **Disconnected** — a panel that ignores its neighbors (COMMS lit + undimmed beside a modal).
   - **Unpolished** — truncation, misalignment, default/placeholder styling, jagged spacing.
   - **Truthfulness** (carry-over from QA): does any panel claim state the harness can't prove?

3. **File + fix.** Append concrete findings to `SESSIONS.md` (state name + what's wrong +
   owning dept). Fix small/cross-cutting issues directly in the live-polish worktree and
   **re-shoot to confirm** (the detect→fix→verify loop must close — a verbal "fixed" counts
   for zero). Route larger structural fixes to UI-SHELL (panels/CSS) or WORLD-GAME (floor/canvas).

4. **Re-run** next cycle. Compare against the prior `.uishots/` to catch regressions a
   newly-merged branch introduced (parallel-agent breakage is recurring).

## Baseline (known good, established 2026-06-22)
- Full-screen overlays (RECRUITMENT BAY for summon/roster, REFIT MODE for build) are coherent.
- `#terms` panels now **center when single** + sit under a **deepened focus scrim** — fixed in
  `8f3dda8`. If a future shot shows a `#terms` panel back in the top-left corner with a bright
  floor behind it, that fix regressed.

## Wiring
Run as a dedicated self-paced `/loop` on Andrew's machine (needs the live app + vision).
Sibling of the Overseer+ loop (L1, git/board) — see the loop set in memory
`skynet-recurring-problems-and-loops`. Pairs with a single UI design authority so new
features conform to the centered-modal + full-bleed-overlay paradigms instead of inventing a third.
