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

## D2 — implementation notes (as built)

### Half 1 — hero-only-beat extension: per-beat disposition
The D0 audit had already confirmed the **want-engine is shared** via the `self` pointer — quirks (listen/scan/
ponder/faceWall/gazeOut/vigil), caretaker rounds, revisit/fond, off-beat hold, sleep, pace, gaze-out, mutual-glance
and the stroll-beats are ALL already reachable by every summoned+placed crew body through `crewEngineStep`/`decideIdle`.
So the only OPEN candidates for D2 were the remaining hero-only beats. Each was verified against the live file (the
audit table is the map, the code is the truth) and disposed of as follows:

| Beat | Live gate (verified) | Disposition | Rationale |
| --- | --- | --- | --- |
| quirks (listen/scan/ponder/faceWall/gazeOut) | `maybeQuirk` :1703, all `self.*` | **already shared** | crew run it via `decideIdle`; only retuned under G5 (Half 2) |
| caretaker rounds, revisit, off-beat, sleep, pace, gaze-out, mutual-glance | all `self.*`, from crew paths | **already shared** | no change needed; revisit/off-beat now also G5-budgeted (Half 2) |
| stroll-beats / double-take | `maybeStrollBeat` :809, `self.*`; `activity` guard only applies to hero | **already shared** | crew already double-take; now G5-budgeted (Half 2) |
| **THE LOOK-UP** | inside `maybeGlance` :1969; references `agent` directly; called ONLY from hero `tick()` :2124; entangled with hero-only `deepLocks`/`userReturnUntil` | **SKIPPED (kept hero-only)** | NOT crew-wide today (verified: `lookCd` is a hero field; no `lastCrewLook`/crew look-up exists). Porting requires building the whole `maybeGlance`-class continuous-facing layer onto crew — exactly the larger, non-mechanical effort the D0 KEY INSIGHT flags, and the KEY INSIGHT lists THE LOOK-UP in the hero-exclusive keep set. Out of a mechanical-safe D2 extension. |
| **belt-yield** (`shouldYieldToCargo`) | :824, reads `agent.target`/`agent.px` directly; wired ONLY into the hero walk block (:2112); crew `crewEngineStep` has no belt-yield hook | **SKIPPED (hero-coupled)** | The `self`-rename looks mechanical, but the beat is hero-coupled in practice: belts run through the central concourse the hero occupies, while crew wander is zone-clamped to their assigned zones — a crew body rarely (if ever) paths across a live belt, so a ported check would be dead code where it can't fire and a pileup/stall risk where it could (a crew body freezing on a shared belt). Per brief: hero-coupled ⇒ document + skip rather than force. |
| **novelty-inspect reflex** (`planInspect`/`novelty[]`) | reflex gated `if(self===agent)` in `decideIdle`; `novelty[]` is a single MODULE queue filled only by the hero | **SKIPPED (queue doesn't generalize per-body)** | `novelty[]` is one shared queue, not per-body. Extending as-is → all crew inspect the same placed prop (swarm, violates G3/G5); making it per-body is a rebuild, out of D2 scope. |
| mourning, deep-lock, FIRST LIGHT, THE LONG STARE hold | hero-only by audit | **KEPT hero-exclusive** | design-intent per plan §D2 keep-list — untouched. |

**Net for Half 1:** zero new extensions were needed or safe — the safe set was already shared (D0's finding), and every
remaining hero-only beat is either design-intent-exclusive, hero-coupled, or a non-mechanical rebuild. The crew liveliness
gain in D2 therefore comes entirely from Half 2 (the retune that lets the already-shared beats run at a *calm* station rate).

### Half 2 — G5 station-level rarity budget (the retune; landed, then RE-TUNED after adversarial review)
- **Review finding (F1) that forced the retune:** the first cut (an 8s window with a x0.35 soft damp, mirroring the
  B3 quirk governor) was correct but **barely bound at scale** — the 8s damp shadow covers only ~5-18% of the 45-140s
  per-family cooldowns, so a Monte-Carlo of a 6-body floor showed only ~7% reduction (≈5.7x single-agent cadence,
  vs the G5 target). The claim "floors at ~1 agent's" was overstated and is retracted; the shipped design below is
  measured, and its honest worst case is **~2x single-agent**, not 1x.
- **Shape (a station-wide SHARED cooldown for crew rolls):** one module-local `crewBeatGateUntil` + two helpers —
  `armBeat(now)` sets `crewBeatGateUntil = now + U.irnd(45000, 90000)` (a window drawn on the order of the per-family
  cooldowns — deliberately the same range as `quirkCd`, no new magic numbers), and `crewBeatDamp(now)` returns `0`
  for a CREW body while `now < crewBeatGateUntil`, else `1` — and **always `1` for the hero** (the `self === agent`
  short-circuit runs BEFORE any gate-state read). Every fired beat (hero or crew) arms the gate, so the CREW's
  COLLECTIVE noticeable-beat rate is bounded at ~1 per 45-90s regardless of crew count, and hero beats keep the crew
  quiet in their shadow. This generalizes and subsumes the old per-quirk `lastQuirkAt` (removed — write-only after this).
- **Governed families (the noticeable beats only):** quirks (`maybeQuirk`, incl. vigil + long-stare entry), stroll
  double-takes + considered pauses (`maybeStrollBeat`), off-beat dwell-stretches (`offbeat`), and haunt revisits
  (`maybeRevisit`). Each **arms** the governor when it fires and hard-gates its own crew roll (`p *= crewBeatDamp(now)`,
  or an early skip for revisit which has no chance-roll). Ambient **texture** — glances, cursor facing-drift,
  mutual-glance, wander, needs — is deliberately NOT budgeted (per G5: only noticeable beats).
- **MEASURED CALIBRATION (Monte-Carlo, real constants: 2s idle re-rolls, p=0.085·(0.6+0.4·restless), 45-90s per-body
  quirkCd; 200 runs × 10min):**
  | Config | beats/10min | × N=1 |
  | --- | --- | --- |
  | N=1 (hero only) baseline | 6.9 | 1.00x |
  | 6 bodies, undamped | 41.8 | 6.06x |
  | 6 bodies, first-cut 8s/x0.35 damp | 39.3 | 5.70x (the F1 finding — barely binds) |
  | 6 bodies, **shipped gate 45-90s** | **12.5** | **1.81x** (hero 6.9 + crew collectively 5.6) |
  | 7 bodies, shipped gate 45-90s | 12.6 | 1.83x (crew-count-invariant: crew stays ~5.6) |
  Alternatives tried: 30-70s window → 2.17x (passes but less margin); 60-120s → 1.47x (quieter than needed).
  45-90s chosen: within the ~2-2.5x target with margin, and symmetric with the existing `quirkCd` range.
- **Why N=1 is a provable no-op:** `crewBeatDamp` short-circuits to `1` on `self === agent` before reading the gate.
  A single-agent floor never populates `crew[]`, so `self` is only ever `agent` → every multiplier is `* 1`
  (byte-identical in IEEE754) and the revisit skip (`1 < 1`) is never taken. `armBeat`'s writes (and its `U.irnd`
  draw) are inert in N=1 — `U.chance`/`U.irnd` are independent `Math.random` wrappers, not a seeded stream, so an
  extra draw cannot shift any other roll's outcome. **⇒ N=1 behaves EXACTLY as pre-D2, and the hero's rolls stay
  byte-identical at ANY crew count (J1 parity).**
- **No deadlock / no starvation:** the gate is a timestamp compared against the advancing U-driven frame clock —
  it always expires; a gated roll (`U.chance(0)`) fails BEFORE any per-body cooldown write, so skipped rolls never
  mutate `quirkCd`/`offbeatCd`/`pauseCd`/`revisitCd`; revisit's binary skip re-considers every idle tick once the
  window lapses. Crew families still fire — collectively ~1 per 45-90s, individually rotated by whoever rolls first.
- **Determinism (G6):** `now` is the U-driven frame clock; only `U.chance`/`U.irnd` + arithmetic used; no
  `Math.random`/`Date.now`/`new Date`. `lint-determinism` green.
- **Blast radius (G7):** `frontend/app/world.js` + this doc only. No chat.js, no shared/*, no new modules.
- **Verification:** `node --check` clean; full `npm run test:fast` green incl. `lint-determinism` + `lint-emits`.
  Behavioral rates are not headless-testable (rAF pauses; plan's honest-limits section) — verified by code review
  against the G-hunts (N=1 drift, non-summoned-body fire, deadlock, cross-body mutation, determinism) all clear.

## D3 — implementation notes (as built)

**All FOUR beats shipped** (huddle, watch-a-peer-work, half-follow, border meeting) — none skipped. Single
writer: `frontend/app/world.js` (+ this doc). All SILENT (no speech/bubbles). Commit: `tier-d D3: social
encounters …` (557dccb2) + the fall-through / one-sided-break fixes.

### The coordinator (assignment / stepping / release)
- **The slot (G4):** ONE module-local `socialBeat = null | { kind, aId, bId, until }`. `until` = `now +
  SOCIAL_HARD_MS` (25 s) is the whole-encounter HARD timeout. A **station-level sweep at the top of `tick()`**
  (`if (socialBeat && (now >= until || encounterBroken)) endEncounter`) frees the slot EVERY frame independent of
  any body's stepper — so even if BOTH participants get seized in the same tick (neither runs its own guard) the
  slot is never leaked. `socialPairCd` (Map, sorted `"idA|idB"` key) is the per-pair cooldown.
- **Assignment — `startEncounter(a,b,kind,now,planA,planB)`** is the SINGLE sanctioned cross-body write (K2): it
  assigns each body its OWN self-contained plan on `body.social` (`{ phase, tx, ty, faceTile, partnerId, kind, … }`),
  sets `goal='social'` on both, arms the slot + `armBeat(now)` (G5). Two-sided beats (huddle/border) go through it;
  the ONE-SIDED beats (watch/follow) inline-assign only the OBSERVER's plan (the passive subject keeps working /
  walking — that's the beat) and set the slot directly, still `if (socialBeat) return false` guarded.
- **Stepping — `stepSocial(now)`** runs per-tick for the current body (`self`) and mutates ONLY `self` (its plan +
  position/facing via the existing `setPathTo`/walk machinery) and reads the partner READ-ONLY (position only, via
  `bodyForAgent`). Phases: `walk` (path to the fixed target — `pl.started` distinguishes "not yet en route" from
  "arrived"; follow re-steps 2-4 tiles toward the moving partner, zone-clamped, then STOPS — never completes) →
  `hold` (stand, face partner/faceTile, until `pl.until` = `now + U.irnd(3-7 s)`) → `endEncounter`. Wired into BOTH
  loops (hero `tick()` and `crewEngineStep`) after the D1 chat-stare hook, BELOW the summon/`b.working` seize; a
  dedicated `goal==='social'` branch in each idle ladder stops the fall-through to `decideIdle` (which would stomp
  the hold with a wandering beat). `arrive()` gained a `goal==='social'` case so a reached waypoint stays on-goal.
- **Selection — `maybeSocial(now)`** is called from `decideIdle` at the existing idle cadence (K4 — off
  `neighborsOf`, never off observing another encounter). Order of gates: reduceMotion → no walking beats (degrade to
  Tier C glances); slot free; self eligible (`socialEligible`: idle + placed + not chat-focused + not already in a
  beat); station gate open (`crewBeatDamp`); **candidate exists** (a same-zone neighbor OR any other placed body)
  BEFORE the `U.chance(0.02)` roll — so a solo-hero floor never even rolls (N=1 parity, hunt 6); then try
  watch→huddle→follow→border, first legal plan wins.
- **Release — `endEncounter(now)`** frees the slot, clears each body's own plan (`goal==='social'` → idle), and arms
  the per-pair cooldown. Idempotent. `encounterBroken(now)` (READ-ONLY) is the tear-down trigger: despawn, the
  observer losing its plan / being seized (working / hero `activity==='task'`), or EITHER body pulled into a
  chat-stare. Two-sided beats additionally require the partner to still hold its plan; one-sided beats tolerate the
  subject working/walking (that IS the beat).

### Border meeting (the shared-edge geometry)
Computed **directly from the two zone rects** — no `zones.js` API change. `zoneRect(zone)` yields the single rect
of a `'room'` zone (`'leash'`/`'multi'` zones can't express a clean shared edge → those pairs are simply NOT
border candidates, a documented skip, not a `zones.js` edit). `sharedEdge(ra,rb)` returns a vertical/horizontal
shared line iff the rects abut with an overlapping span; `borderTileFor(rect,edge,cur)` returns the nearest walkable
tile of that line INSIDE the given rect. Each body walks to its OWN rect's edge tile — they meet ACROSS the line,
never crossing (containment staged, not hidden). 16/16 pure-geometry smoke assertions pass (each body's target is
inside its own rect only; gaps yield no edge; partial overlaps span correctly; blocked edge tiles are skipped).

### Final tuning constants
`SOCIAL_SEL_ROLL = 0.02` (per idle re-decide, only when a candidate pair exists + gate open); hold `U.irnd(3000,
7000)` ms; whole-encounter hard timeout `SOCIAL_HARD_MS = 25000` ms; per-pair cooldown `U.irnd(180000, 360000)` ms
(3-6 min); candidate radius 5 tiles; half-follow `U.irnd(2,4)` tiles. These start from the brief's suggested values
unchanged — RARE by design (a 6-agent floor sees an encounter every few minutes at most; the station beat gate
(G5/`armBeat`) further keeps social beats inside the same calm budget as quirks).

### The 7 self-review hunts — how each was cleared
1. **Social target outside the mover's zone** — every plan builder clamps via `tileInZone(zoneFor(mover))`
   (huddle via `nearestWalkableInZone`, watch/follow per-candidate, border double-checked belt-and-suspenders); the
   follow re-clamps each incremental step. Border bodies each target their OWN rect's edge tile (geometry test proves
   containment). CLEAR.
2. **Rendezvous deadlock (partner summoned/despawned/chat-focused mid-beat)** — the survivor frees within one tick
   via `encounterBroken` (checked both by the per-body guard AND the station-level sweep) → `endEncounter` frees the
   slot AND clears the survivor's plan. The hard `until` is the final backstop. CLEAR.
3. **Slot leaking / double-occupied** — the station sweep makes it un-leakable (frees even if both seize same tick);
   `startEncounter` + both one-sided builders early-return on `socialBeat`, and bodies are stepped sequentially in a
   frame (crew then hero), so no two encounters arm in one tick. CLEAR.
4. **An encounter starting during another** — every entry path guards `if (socialBeat) return false`; `maybeSocial`
   guards it first. Selection is off `neighborsOf` at idle cadence, never off observing an encounter (K4). CLEAR.
5. **Cross-body mid-tick mutation** — `startEncounter`/`endEncounter` are the ONLY functions that write a partner,
   and they are the explicit initiation/teardown coordinators (not per-tick stepping). `stepSocial` writes only
   `self` and reads the partner's position READ-ONLY. CLEAR.
6. **N=1 floor (no partner ever exists)** — `maybeSocial` returns BEFORE the `U.chance` roll when no other placed
   body exists, so a solo-hero floor consumes zero extra RNG (U.* are independent `Math.random` wrappers → a skipped
   draw shifts nothing); byte-identical to pre-D3. CLEAR.
7. **Summon latency** — the hero summon-seize block (sets `goal='summon'`) and the crew `b.working` seize both sit
   ABOVE the social step; the social branch is gated on `activity==='idle'` / `!b.working`. A summoned participant's
   task walk starts THIS tick (the seize block runs the same frame the sweep frees the slot). CLEAR.

### Residual risks / unverifiable
- **Live feel** (does an encounter read as eerie-and-alive vs busy?) is not headless-testable (rAF pauses; the
  plan's honest-limits section). Rates/timings are code-review + geometry-test verified; a foreground `?dev`
  multi-crew soak (2+ summoned crew sharing a floor) is the only way to SEE the beats — expected, deferred to an
  attended check.
- **Border meeting requires two `'room'`-zone bodies with abutting rects.** A solo hero (`'multi'` zone) or a
  leashed deskless crew body never border-meets — by design (documented skip), not a bug.
