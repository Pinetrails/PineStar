# Tier D — LIVING CREW (the cherry-on-top liveliness pass)

> Continues the eerie/idle charter: Tier A containment → Tier B self-pointer → Tier C gaze-only
> awareness → **Tier D: the crew acts like it lives here.** Four beats, all deterministic canvas
> behavior. **ZERO LLM calls, ZERO tokens** — this lane is pure engagement/Thronglets-feel; every
> token stays reserved for real work. Andrew's directive (2026-07-02): chat-stare, richer
> agent↔agent interaction, less-aimless idle, cursor glance/chase.
>
> Extends `docs/AGENT_SENTIENCE_ROADMAP.md` (the hero idle catalog — D4 checks off its unchecked
> "Mimic the cursor" item) and `docs/CREW_AWARENESS_PLAN.md` (Tier C — D3 is its designed growth).
> Same build discipline as Tier C: worktree lane, one writer on world.js, adversarial verify per
> phase, build does NOT self-merge.

## The live substrate (recon 2026-07-02 — anchors verified against trunk)

The live page loads `frontend/app/world.js` (+ `app/zones.js`) — **NOT** `frontend/js/agents.js`
(that file + `js/data.js` rosters are the v7 legacy sim; do not build there, do not copy its
patterns). What Tier D builds on, all in `frontend/app/world.js`:

- **Bodies**: hero `agent` + `crew[]` (world.js:56-67). Crew already get `pers: makePersonality(aid)`
  + seeded needs (world.js:3197-3199) and run `decideIdle` (world.js:1847) — the want engine is
  ALREADY shared. Some beats are hero-only by gate (e.g. shouldYieldToCargo reads `agent.target`,
  world.js:~1032; deep-lock; most of the quirk catalog) — D2 audits exactly which.
- **Gaze primitives**: `setGlance` / `maybeGlance` / `dirToward` (Tier C's no-move head-turn) +
  Tier C's `neighborsOf(body, radius)` / `glanceAt` (world.js:1352, 1424).
- **Commander presence**: `lastCursor = {wx, wy, t}` cached on mousemove (world.js:120-126, 570);
  cursor gaze-drift (world.js:1459-1465, 32% when fresh); hover rising-edge notice (world.js:572);
  deep-lock budget (~1/session). D4 extends this — it does not add a second cursor tracker.
- **Work-wins law**: summon/task seizes any body instantly (`activity==='task'` block sits above all
  idle branches). Chat replies already drive `World.setActivity('task')` from `frontend/app/chat.js`
  (walk-to-desk-and-type). Every Tier D beat yields to it, no exceptions.
- **Zone containment**: `Z.computeZone` / `Z.inZone` / `Z.clampPickable` (app/zones.js:119-149,
  tested in test/zones.test.js). Any Tier D movement target passes the zone clamp.

## Guardrails (inherited + new; breaking any = NOT done)

- **G1. ZERO TOKENS.** No model calls, no new bus round-trips to the harness. Pure client-side
  behavior off state the frontend already has.
- **G2. Work always wins.** Every beat yields instantly to summon/task. A chat-stare drops the
  moment the agent starts a reply run (it goes to its desk to type — that existing beat is kept).
- **G3. Containment holds.** No body ever leaves its zone for a Tier D behavior. Movement targets
  are zone-clamped; adjacent-zone social resolves to the border, never a crossing.
- **G4. No deadlock / no cascade / no pileup.** Every beat is finite (hard `until`), per-pair and
  per-station cooldowns, at most ONE social encounter and ONE cursor-chase live per station. A beat
  never triggers another beat.
- **G5. Rarity budgeted PER STATION, not per body.** N crew × per-body rates = a busy cute mess.
  Quirk/encounter/chase rolls draw from station-level budgets so a 6-agent floor stays as calm as a
  1-agent floor. Restraint is the aesthetic (Pass-7 law: stillness > motion).
- **G6. Determinism lint green.** `U.chance`/`U.irnd`/`U.pick`/`U.hash` only; cursor position is a
  user INPUT (allowed), never sample `Math.random`/`Date.now`.
- **G7. Blast radius**: `frontend/app/world.js` + one tiny announce hook in `frontend/app/chat.js`
  (D1) + this doc. No shared-contract edits, no persistence, pathspec commits only.
- **G8. Green + adversarially verified per phase** (`npm run test:fast` incl. determinism lint;
  adversarial round returns zero confirmed defects before the next phase starts).

## The four beats

### D1 — ATTENTIVE AUDIENCE (chat-stare) — ship first, highest feel-per-line
When the Commander is chatting with agent X, X gives you its full attention.
- **Bridge**: `chat.js` announces `World.setChatFocus(agentId)` on open / `setChatFocus(null)` on
  close (one call each; world.js owns all behavior). No other chat.js changes.
- **Behavior**: while chatFocus is on an idle body: it stops (reuse `standStill`/stilling), turns,
  and HOLDS on the Commander — facing south, drifting with `lastCursor` like the existing gaze-drift
  so it tracks you around the screen. Wander/quirks/social suppressed for that body while held.
- **The loop with typing**: when the agent starts its reply run, `setActivity('task')` seizes it as
  today — it breaks the stare, walks to its desk, types. When the run ends and chat is still open,
  it returns to the stare. Watching-you-type ↔ working-the-answer is the whole "it's really in
  there with me" beat.
- **Gates**: working-at-desk wins (no stare while `activity==='task'`); if the body can't see the
  "camera" nothing special — the stare is facing + stillness, always safe.

### D2 — CREW PARITY AUDIT (kill aimless walking for the whole cast)
The hero has an inner life; the crew mostly wanders. Close the gap.
- **Audit first**: enumerate every hero-only gate in the idle stack (quirk layer `maybeQuirk`,
  rounds, revisit/fond, off-beat hold, vigil, stroll-beats, sleep, belt-yield). Produce the list in
  this doc before extending anything.
- **Extend the safe set to crew**: quirks (listen/scan/ponder/face-wall), stroll-beats/double-take,
  off-beat hold, sleep-in-drift, caretaker rounds. Each crew body's temperament already differs via
  `makePersonality(aid)` — same catalog, different weights = persistent individual habits (the
  pacer, the corner-starer, the one who sleeps). Persistence is what reads as personality.
- **Keep hero-exclusive**: THE LONG STARE, deep-lock, FIRST LIGHT, mourning (the intimate
  Commander-relationship beats stay special to the hero).
- **Retune under G5**: station-level quirk budget replaces per-body rates before this merges.

### D3 — SOCIAL ENCOUNTERS (Tier C grows legs — movement-based, still safe)
Tier C proved perceive-across-zones/act-in-your-own with gaze. D3 adds bounded movement beats,
same invariants, per-pair long cooldowns, ONE live encounter station-wide:
- **The huddle**: two idle same-zone bodies converge to adjacent tiles, face each other, hold a
  silent beat (with the existing habituation-style variance), break, drift apart. No speech — the
  silence IS the eerie.
- **Watching a peer work**: an idle body walks to stand a couple tiles behind a WORKING body in its
  zone, faces the worker's desk, holds, leaves. (The Overseer-checks-your-work feel, for free, for
  everyone.)
- **The border meeting**: adjacent-zone idle pair each walk to the nearest tile of their shared
  zone edge, face each other ACROSS the line, hold, break. Containment isn't hidden — it's staged.
  This is the clip beat.
- **The half-follow**: an idle body notices a walking body pass (Tier C notice), follows its path
  2-4 tiles, loses interest, stops. Never completes the follow — the incompleteness is the point.
- Encounter *selection* runs at the existing idle cadence off `neighborsOf`; movement targets are
  zone-clamped; both parties released instantly on summon (either one — the other reads the
  departure via the existing parting-glance machinery).

### D4 — THE CURSOR IS A CREATURE (glance + THE CHASE)
Extends the existing Commander-presence stack; checks off the roadmap's "Mimic the cursor".
- **Crew cursor-drift**: give crew bodies a small share of the existing gaze-drift (hero keeps the
  larger share) — occasionally an idle crew member is just... watching your cursor.
- **Cursor-mimic (head-only)**: rare quirk-band beat — an idle body TRACKS the moving cursor with
  continuous facing updates for 3-6s (not one glance — a follow), then snaps away. Requires cursor
  freshness; ends immediately when the cursor goes stale.
- **THE CHASE (the headline)**: very rare (station-level cooldown, minutes; idle-only; never during
  chat focus; one chaser ever): an idle body breaks toward the cursor's world tile — zone-clamped —
  repathing at a low cadence (~1/s, so it lags you like a real pursuer), for 3-6 seconds. Then it
  just STOPS, stares at where the cursor was for a held beat, and walks away as if nothing
  happened. If the cursor leaves its zone mid-chase it halts at the border and stares out — the
  containment beat again. Rarity is sacred: at the designed rate most sessions see ZERO chases;
  that's what makes the one you see land.
- **reduceMotion**: chase no-ops; mimic falls back to a single glance.

## Phases (strictly sequential; verify-loop after each; D1 can ship alone)
- **D0 — scope-lock**: pin every anchor above against the live file; write the D2 hero-only-gate
  audit table into this doc; add the `setChatFocus` no-op plumbing (zero behavior change). Gate.
- **D1 — chat-stare.** Gate: G2 (reply run seizes correctly, returns after), no suppression leak
  (chatFocus null always restores idle), blast radius (chat.js = one announce).
- **D2 — crew parity + station-budget retune.** Gate: G5 crowd-calm hunt (max-crew floor soak),
  determinism, no hero-beat regression.
- **D3 — social encounters.** Gate: G3/G4 hunts — containment leak, convergence pileup, deadlock
  (both released on any seize), per-pair cooldown actually per-pair.
- **D4 — cursor mimic + chase.** Gate: chase zone-clamp, one-chaser lock, chat-focus exclusion,
  reduceMotion, rarity audit (soak: chases/hour within design).

## Verification (honest limits, same as Tier B/C)
No automated behavioral test drives the canvas FSM, and headless tabs pause rAF. Per phase:
`node --check` + full `npm run test:fast` (incl. determinism lint) + adversarial code-review round
with the G-hunts above + a live foreground `?dev` soak for the observable beats (D1 stare and D4
chase ARE observable on demand — open chat / move the mouse; record both). D2/D3 rates verified via
the `dbg()` read-only introspection pattern from Pass 5.

## Anti-overlap protocol
Lane worktree only (suggest `gen-trees\new-agent-tree.ps1 living-crew` → `agent/living-crew`);
world.js has ONE writer; never `git add -A`; never edit `shared/*`; build stops at
green+verified+ready — merge is a separate explicit decision from the integration tree.
