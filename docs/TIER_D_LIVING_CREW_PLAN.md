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

---

## D0 — SCOPE-LOCK (verified against the live worktree files, 2026-07-02)

Fork point: trunk `feat/harness-backend` @ `95325fc`. All anchors below are REAL line numbers grepped
in `C:\Users\andro\gen-trees\living-crew` at the time of D0 (they will drift as D1+ edits land — treat
as "was here at D0"). world.js is 3914 lines pre-edit; chat.js 1762; zones.js 203.

### Verified anchors (plan claim → live reality)

| Thing | Plan said | Live reality | Match? |
| --- | --- | --- | --- |
| hero `agent` + `crew[]` | :56-67 | `let agent = null` :61; `let crew = []` :67; `let self = agent` :66 | ✔ |
| `decideIdle` | :1847 | `function decideIdle(now)` :1847 | ✔ |
| `setGlance` | :1345 | `function setGlance(dir,ms,now)` :1345 | ✔ |
| `maybeGlance` | — | `function maybeGlance(now)` :1904 (operates on `agent` ONLY — hero head-anim layer; see note) | ✔ |
| `dirToward` | :176 | `const dirToward = (fx,fy,tx,ty) => ...` :176 | ✔ |
| `standStill`/`stilling` | — | `function standStill(now)` :1533 (sets `self.stilling=true`, `goal=null`, holds via `idleUntil`) | ✔ |
| `lastCursor` | :120-126,570 | `let lastCursor = {wx,wy,t:-1e9}` :124; set on mousemove :570 | ✔ |
| cursor gaze-drift | :1459-1465 | `ambientGazeDir(now)` :1462 (32% toward cursor when `<8000ms` fresh) | ✔ |
| summon/task seize | `activity==='task'` block above idle | hero: `tick()` :2042 `if (!awaitPrompt && activity==='task' && agent.goal!=='work')`; the idle re-decide branch :2103 sits BELOW it. crew: `stepCrew` :1080 `if (b.working) {...continue}` above `crewEngineStep` | ✔ |
| Tier C `neighborsOf`/`glanceAt` | :1352,1424 | `neighborsOf(body,radius)` :1358; `glanceAt(self_,otherBody,dur,now)` :1376 | ✔ (±6 lines) |
| `bodyForAgent` | — | `function bodyForAgent(aid)` :3243 — `'agent'`→hero, else `crew.find(b=>b.agentId===aid)` | ✔ |
| per-tick actor pointer | — | `self` repointed to each crew body in `stepCrew` :1089 then `self=agent` :1092; hero tick `self=agent` :1998 | ✔ |

### chat.js lifecycle (how a conversation binds to an agent)

- COMMS is a **persistent panel**, NOT a per-agent modal that opens/closes. `chat.js` `activeWs` (:31) is
  the on-screen stream; `load(ws)` (:325) is the **single rebind boundary** — it sets `activeWs = ws` and
  re-renders. It's called by app.js on: summon/create (:396,:430), stream switch (:1598), resume (:1603),
  and first-build launch (:1340). The agent id of the on-screen conversation is `activeWs.agentId || 'agent'`
  (the app-wide hero sentinel — hero's real `agent.id` IS the literal `'agent'`, app.js :1151).
- `World.setActivity('task')` is driven from chat.js `walkToDesk()` on the first real tool call of a run
  (:1487 `onToolCall → walkToDesk()`), and the run route arms it at :1421 (`setActivityFor(turnAgentId,'task')`).
  Run end → `'idle'`/`'talk'` at :1595-1596. **DISCOVERED DISCREPANCY vs plan §"The live substrate":** the plan
  says "Chat replies already drive `World.setActivity('task')`" as if on send — reality is REACTIVE (armed on
  the first tool call, not the message), per the desk-trip invariant note at world.js :2034-2040. This does not
  change D1 (the stare simply sits below `activity==='task'` regardless of when it arms).
- **No genuine close event exists** in this COMMS model (you're always in *some* conversation once the game
  starts). So D1's announce is: call `World.setChatFocus(activeWs.agentId || 'agent')` at the tail of `load(ws)`
  (covers open + every switch in one hook), and `World.setChatFocus(null)` when `load` resolves no stream
  (pre-game / no active ws). This is the cleanest single announce point and keeps chat.js blast radius to that
  one hook (G7). Documented here because it deviates from the plan's literal "open/close" framing.

### D2 hero-only-gate AUDIT TABLE (deliverable for the future D2 phase)

Method: a beat is **SHARED** if its body-state reads/writes go through the module `self` pointer (so
`stepCrew` running it with `self=b` acts on the crew body) AND it is reachable from `decideIdle`/`crewEngineStep`
/`nextWaypoint` (the crew-run paths). It is **HERO-ONLY** if it references `agent` directly, or is gated behind
`if (self === agent)`, or is only ever called from the hero `tick()`.

| Beat | Gate location | Hero-only? | Why |
| --- | --- | --- | --- |
| **quirk layer** `maybeQuirk` | :1656 (called from `decideIdle` :1856) | **NO — shared** | all `self.*`; crew-damped by floor governor `lastQuirkAt` (:1662). Sub-quirks listen/scan/ponder/faceWall/gazeOut/vigil/stare all `self`-based |
| **caretaker rounds** `maybeRounds`/`roundsNext` | :1781 / :1799 (from `decideIdle` :1878) | **NO — shared** | all `self.*`, zone-clamped via `zoneFor(self)` |
| **revisit (fond/haunt)** `maybeRevisit`/`favTile`/`noteFond` | :1824 / :1816 / :1809 (from `decideIdle` :1868) | **NO — shared** | all `self.fond` (per-body Map, seeded in crew literal :3205) |
| **mourning** `planMourn`/`maybeMourn` | :1837 / :1312 | **YES — hero-only** | `decideIdle` gates `if (self===agent){ if(pendingMourn && planMourn) }` :1852-1853; `pendingMourn` is a MODULE var fed only by the hero's `maybeMourn` (removal reflex). Plan keeps this hero-exclusive |
| **novelty inspect** `planInspect` | :1468 (from `decideIdle` :1854 + tick :2058) | **hero-only *reflex*, shared *mechanism*** | `decideIdle` gates the novelty-queue reflex `if(self===agent)`; `novelty[]` is a module queue the hero fills. `planInspect` itself is `self`-based but crew never have queued novelty |
| **off-beat hold** `offbeat` | :1540 (from `standStill` :1536) | **NO — shared** | `self.offbeatCd` per-body gate (:1542); reduceMotion-skipped |
| **vigil** `quirkVigil` | :1707 (via `maybeQuirk` :1672) | **NO — shared** | `self`-based, zone-clamped |
| **stroll-beats / double-take** `maybeStrollBeat` | :799 (from `nextWaypoint` :795 — a shared path) | **NO — shared** | `self.*`; the `activity!=='idle'` guard only applies `(self===agent)` so crew are unaffected by it |
| **sleep / power-down** `sleep` | :1771 (from `decideIdle` :1861) | **NO — shared** | all `self.*`; `phaseOf` drift is per-body-skewed (:1650) |
| **belt-yield** `shouldYieldToCargo` | :814 (from hero `tick` :2064 only) | **YES — hero-only** | reads `agent.target`/`agent.px` directly; only wired into the hero `tick` walk block. Crew `crewEngineStep` has no belt-yield |
| **deep-lock** (rare long look-up) | inside `maybeGlance` :1926 (`deepLocks` module var) | **YES — hero-only** | `maybeGlance` runs on `agent` only + `deepLocks` is a module budget |
| **cursor gaze-drift (ambient)** `ambientGazeDir` | :1462 | **shared *fn*, hero-only *as an idle head layer*** | `ambientGazeDir` is `self`-based and IS used by crew via `lookAround`/`standStill`. BUT the dedicated per-tick cursor drift lives inside `maybeGlance` (agent-only, :1919-1934) so crew get cursor-drift only at idle-decision moments, not continuously |
| **THE LOOK-UP** | `maybeGlance` :1914-1934 | **YES — hero-only** | `maybeGlance` on `agent`; `userReturnUntil`/`lastCursor`/`deepLocks` module state |
| **THE LONG STARE** `quirkStare` + its hold | :1722 (quirk) + `maybeGlance` hold :1961 | **stare ENTRY shared, HOLD hero-only** | `quirkStare` sets `self.goal='stare'` (crew CAN enter it via maybeQuirk); but the per-tick stare *hold* animation (:1961-1965) is in `maybeGlance` → `agent` only. Plan lists LONG STARE as hero-exclusive — to honor that in D2, gate `quirkStare` behind `self===agent` |
| **FIRST LIGHT** `stepFirstWake` | :1549 (from hero `tick` :2101, `agent.goal==='firstwake'`) | **YES — hero-only** | references `agent` directly; the birth ritual, wired only into the hero tick |
| **pace (antsy)** `pace` | :1608 (from `decideIdle` :1881) | **NO — shared** | `self`-based, zone-clamped |
| **gaze-out (contemplate void)** `planGazeOut` | :1618 (from `decideIdle` :1880 + `maybeQuirk` :1670) | **NO — shared** | `self`-based, own-zone-edge clamped |
| **mutual glance (Tier C)** `maybeMutualGlance` | :1441 (from `decideIdle` :1867) | **NO — shared** | already crew↔crew by design |
| **autonomous decor place** `maybePlace` | :1746 | **hero-only in practice** | uses module `agentDecor`/`placeCd`; the plan already removed autonomous placement from the idle menu (`decideIdle` comment :1857) |

**KEY D2 INSIGHT (for the future phase, not this lane):** the want-engine (`decideIdle` + most beats) is
ALREADY shared via `self`. The real hero/crew gap is the **head-animation layer**: `maybeGlance` runs on
`agent` only and is called only from the hero `tick()`. Crew get glances just at idle-decision moments (via
`lookAround`/`ambientGazeDir`) and Tier C. So "kill aimless crew walking" is mostly a RETUNE (station budget,
G5) + porting `maybeGlance`-class continuous facing to crew, NOT rebuilding the want-engine. The truly
hero-exclusive beats to KEEP special (per plan): mourning, belt-yield, deep-lock, THE LOOK-UP, FIRST LIGHT,
and (by intent) THE LONG STARE hold.

### D0 plumbing added (zero behavior change)
- `let chatFocusId = null;` module-local (world.js, near `lastCursor`/`userReturnUntil`).
- `function setChatFocus(agentId) { chatFocusId = agentId || null; }` + a `chatFocusBody()` resolver
  (`chatFocusId ? bodyForAgent(chatFocusId) : null`), exported on the public API. **No caller wired in D0.**
- No read of `chatFocusId` anywhere in D0 → provably zero behavior change (verified: `node --check` +
  full `test:fast` green).

## D1 — implementation notes (as built)
- **chat.js hook:** ONE announce at the tail of `load(ws)` (:325): `World.setChatFocus(activeWs.agentId || 'agent')`
  when a stream is resolved, else `World.setChatFocus(null)`. Covers open + every switch (the only rebind
  boundary); the persistent-panel COMMS model has no separate close (documented above). Blast radius = this
  one hook (G7).
- **world.js behavior:** a shared `chatStareHold(now)` runs for the focused body while it is genuinely idle
  (not walking, not working, not mid-goal, `activity!=='task'`): sets `stilling` (reusing the Pass-7
  CONTENT=STILL machinery), faces south, and drifts toward `lastCursor` when fresh (`<8000ms`) via the
  existing `dirToward` pattern — one tracker, no second cursor sampler. It is invoked:
  - from `decideIdle` as an **early-out** (before quirk/social/wander) so the focused body never *chooses* to
    wander while held; and
  - every tick as a **hold** in the hero `tick()` idle branch and in `crewEngineStep`, so the facing tracks the
    cursor continuously (crew have no `maybeGlance`, so the hold must drive facing directly — see D0 KEY INSIGHT).
- **Work always wins (G2):** the hold is only reachable while `activity!=='task'` and `goal==null` — it sits
  strictly BELOW the summon/task-seize block (unchanged). When a reply run arms `task`, the existing
  walk-to-desk beat runs untouched; when the run ends and focus is still set, the next idle tick resumes the stare.
- **Cleanup:** `setChatFocus(null)` (or focus moving to another id) needs no teardown — the previously-focused
  body's next `decideIdle` clears `stilling` on entry (:1848) and re-enters the normal menu. If the focused id
  doesn't resolve to a live body, `chatStareHold` no-ops.
