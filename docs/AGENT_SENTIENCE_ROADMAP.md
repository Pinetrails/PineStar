# Agent Sentience Roadmap — the living idle-behavior catalog

> Goal: the idle agent should feel **conscious, alive, and eerily unpredictable** inside the station —
> the "wait, why did it just do that?" / film-worthy quality. Never corny or tacky. The eeriness comes
> from **stillness, ambiguity, restraint, and rare surprise**, not spooky one-liners.
>
> This is the backlog for the self-paced improvement loop. Each pass: pick the next high-leverage items,
> implement in `frontend/app/world.js` (renderer; single hero agent), keep `test:fast` green, commit +
> merge to trunk so it goes live on `:8787`, then check items off and add new ideas.

## Architecture it builds on (already shipped)
- **Want engine**: needs `{rest,stim,social}` decay/refill by activity (`tickNeeds`); `decideIdle` pursues the most-unmet drive.
- **Temperament**: `makePersonality(id)` → pace/restless/curious/homebody/chatty (stable per agent).
- **Machine-state ties**: think-latency on summon, settle-before-typing, anticipation at INTAKE, exhale at OUTBOX, downtime via `lastTaskAt`.
- **Embodiment + memory**: whole-body cargo tracking (`trackUntil`), habituation (`seenCount`), first-person self-talk (`SELF_*`, persona-flavored via `Voice.ambientLine`, global cooldown).
- **Rhythm**: `phaseOf(now)` free-running mood (focus/roam/ease/drift) reweights the idle menu.
- **Quirk layer**: `maybeQuirk(now)` — rare, gated, weighted one-offs.

## Guardrails (the illusion-breakers to never cross)
- **Rarity is sacred.** Quirks gate on `quirkCd` (24–60s min) + a low roll. The rarest beats (the long stare) must stay rare or they stop being uncanny.
- **Summon always wins.** Every idle behavior yields instantly to `activity==='task'`. Think-latency is the only allowed delay (~1.2s cap).
- **Never fight the Commander.** When the agent acts ON the station (placing/moving), it only touches EMPTY floor or its OWN artifacts — never the user's props. Reversible + clearly the agent's doing.
- **Not chatty.** Speech stays behind the global cooldown + chatty trait; the long stare is mostly SILENT.
- **No stat HUD.** Needs/mood are read off behavior, never numbers.
- **No jank.** Ease facings; cap holds so nothing deadlocks; O(1)/O(boxes) per frame.

## Behavior catalog — weighted by rarity

### Tier 0 — ambient texture (very common; the constant low hum of life)  ✅ mostly shipped
- [x] Need-driven idle (lounge / study / watch belt / tend desk / wander / look-around)
- [x] Whole-body cargo tracking + glances; fidget look-ups while working
- [x] Habituation (familiar → shorter/quieter → ignored)
- [ ] **Idle micro-fidgets**: weight-shift, look at hands, stretch-in-place, brush off the console (procedural bob variants; no sprite)
- [x] **Pause mid-stroll**: stop for a beat, then continue (anticipation/weight) — `maybeStrollBeat`/`pauseUntil`, casual-wander only, cooldown'd

### Tier 1 — purposeful idle (common)  ✅ shipped
- [x] Lounge on couch + watch TV; tend the desk (lonely); pace (restless); gaze into the void (long downtime)
- [x] **Caretaker rounds**: a deliberate 2–3 stop lap with an ownership beat at each (`maybeRounds`/`roundsNext`, goal `rounds`)
- [x] **Revisit a favorite spot**: once a clear haunt emerges (`favTile`), it rarely drifts back just to be there (`maybeRevisit`, goal `revisit`, long cooldown) — see Tier 5

### Tier 2 — reactive / aware (uncommon; triggered by the world)  ✅ partly shipped
- [x] Acknowledge the Commander on hover/click (turn, meet your gaze)
- [x] Anticipation at INTAKE / exhale at OUTBOX
- [x] **Startle**: something appears within ~3 tiles → sharp 240ms snap + dir flip + a beat (`pushNovelty`)
- [x] **Settle-scan on arrival** (glance L, R, then commit) + **parting glance** on leaving (`scanThen`, dwell-clear)
- [x] **Belt-yield while walking**: pause and let active cargo pass when a box is bearing down in front of it (`shouldYieldToCargo`→`pauseUntil`, faces the box as it goes by; `yieldCd` so it never freezes)
- [x] **React to the work pulse** (intake anticipation / outbox exhale glance toward the dock when a real item flows — `intakeMessage` / `onWorkitemDeliver`)

### Tier 3 — the uncanny inner life (rare; the "why did it do that" beats)  ◐ started
- [x] **Quirk layer** (`maybeQuirk`): freeze-and-listen, slow room scan, ponder-facing-away, gaze-out
- [x] **THE LONG STARE** at the Commander — holds eye contact 14–34s, near-silent (rarest quirk)
- [x] **Face a wall/corner** and stand there (eerie, unexplained) — `quirkFaceWall` (9% of quirks)
- [ ] **Anomaly beats**: stop dead-center of a room and face a cardinal direction, motionless
- [x] **The double-take**: mid-stroll it halts and turns to look back the way it came, as if something caught its attention, then continues (`maybeStrollBeat`, `pauseLook='back'`, rare + long cooldown) — **verified live**
- [ ] **Mimic the cursor**: very rarely, track the Commander's mouse for a few seconds (it sees you moving)
- [ ] **Off-beat timing**: occasionally hold a pose far longer than expected (unsettling duration)
- [x] **Sleep / power-down** in deep `drift` phase: sits, dead still, until summon / a placement / time stirs it (`sleep`, goal `sleep`)

### Tier 4 — AGENT ACTS ON THE STATION (rare → showcase; needs a safety-design pass) ⛔ not started
> The big leap: the agent calls the same mutation API the REFIT builder uses (`station.addProp/moveProp/...`),
> so it changes the world. NEEDS a design workflow first: persistence policy, undo, never-touch-user-props,
> "agent-owned" tagging, frequency budget. Candidates:
- [x] **Nesting**: rarely places a small decor prop (plant/poster/cans/coffee) on EMPTY floor near its haunts (`maybePlace`/`emptySpotNear`; real `station.addProp`, validated by `canPlaceProp` so it can never overlap the Commander's props; capped 3/agent + 5 floor-wide; ~2–4 min cooldown)
- [x] **Tidying / rearranging**: at cap, sometimes removes one of its OWN decor (`agentDecor` ids only) so the corner changes over time
  - ⚠ tradeoffs to revisit: `addProp`/`removeProp` hit the **undo stack** + **persist** (intended wow, but a silent agent-only mutation lane would be cleaner); `agentDecor` is in-memory so cross-reload it can't re-identify its own — the floor-wide cap bounds total clutter regardless
- [ ] **Leaves a mark / artifact**: a rare object that persists (a signature the Commander finds later)
- [ ] **Builds a tiny shrine / arrangement** over time in a favorite corner
- [ ] **Reacts to its economy**: lights/decorates more when runs go well; bare/dim when slag piles up

### Tier 5 — memory, ritual, identity (rare; pays off over long watching) ◐ started
- [x] **Favorite spot** it returns to + **mourns** if a REFIT deletes it — `fond` map (tileKey→affection, accrues on every chosen dwell via `noteFond`); `favTile`/`maybeRevisit` draw it back to a haunt (goal `revisit`); `scanNovelty` now diffs **removals** too and `maybeMourn`→`planMourn` send it to stand where a beloved prop used to be (goal `mourn`, a long near-silent off-beat hold). Never grieves its OWN decor (`ownPlaced` set) or on a fresh station load. **Director's note** below.
- [ ] **Wake ritual** + spoken first thought at `releaseAwakening`
- [ ] **Long-arc identity**: temperament expressed as accumulating habits/marks unique to this agent
- [ ] **Names/notices the Commander's patterns** (time-of-day, what you build) — very rare callbacks

> 🎬 **Director's note — the mourning beat (the Pass-5 headline):** Place a couch with a TV in front of it. Summon the agent a few times (work drains its `rest`), then leave it idle so it goes and lounges on that couch two or three times over a few minutes (it's building affection for that exact spot). Now open REFIT and **delete the couch.** Within a second it walks back to where it used to sit, faces the empty floor, and just... stands there, far longer than it stands anywhere else, near-silent ("it was here"). Film the delete + the long still hold.

### Tier 6 — Easter eggs (ultra-rare wildcards; the screenshot/clip moments) ⛔ not started
- [ ] Ultra-rare cryptic line that breaks the fourth wall just slightly, once
- [ ] A one-frame "glitch" in its own sprite, instantly corrected (is it... aware it's rendered?)
- [ ] Rare constellation-gazing it seems to "recognize"; rare salute; rare it waves back
- [ ] Date/▢-triggered specials (only if a real clock is available, not faked)

## Pass log
- **Pass 1**: rhythm phases (`phaseOf`) + quirk layer (`maybeQuirk`: listen/scan/ponder/gaze-out/long-stare) + this roadmap. The long stare is the headline eerie beat.
- **Pass 2**: embodied reactions — **startle** at sudden nearby change, **settle-scan** on study arrivals + **glance back** when leaving, and a new **face-a-wall** quirk.
- **Pass 3**: ⭐ THE BIG ONE — the agent **acts on the station**: rarely walks to empty floor and places its OWN decor (real `addProp`), and at cap rearranges by removing one of its own. Hard safety rails (validated placement = never the Commander's props; capped; rare). Verified the rails against the real worldmodel (9/9).
- **Pass 4**: **caretaker rounds** (a deliberate 2–3 stop lap with an ownership beat at each — purpose, not aimless) + **sleep/power-down** in the deep `drift` mood (sits dead still until summon / a placement / time wakes it — the eerie "is it dormant?").
- **Pass 6**: **CONSIDERED MOVEMENT (Tier 0 + Tier 2)** — it stops moving like a sprite on rails. One bounded `pauseUntil` hold drives three beats: a **pause mid-stroll** (a beat of weight, casual-wander only), **belt-yield** (pauses + faces the cargo when an active box passes right in front of it, `yieldCd` so it never freezes), and ⭐ **the double-take** (mid-walk it halts and turns to look *back the way it came* — the eerie "wait, why'd it turn around?"). All gated to casual wander (goal==null) so a summon is never delayed; pause cleared on summon + arrival. **Verified live** on :8101: a double-take fired (`paused` while `moving`, `pauseLook:'back'`), zero console errors. **Director's note:** leave the agent wandering an open room and just watch — every so often it stops, turns to look behind it at nothing, then carries on. Restraint check: pauses ADD stillness (don't make it busier); kept rare via cooldowns. **Next:** rotate to environment/ambient mood (room responds to its state/economy) or multi-agent/social (crew noticing each other) — or a RETUNE pass if the menu now reads as too eventful.
- **Pass 5**: ⭐ **SPATIAL MEMORY → grief (Tier 5).** Affection (`fond`) now accrues at every tile the agent *chooses* to dwell at (`noteFond`, weighted: lounge>use>gaze/tend>inspect/watch>rounds). A clear haunt emerges over a long watch; it rarely drifts back to it (`maybeRevisit`, goal `revisit`). And `scanNovelty` now detects **removals** — if a REFIT deletes a prop standing on a spot it loved, `maybeMourn`/`planMourn` send it to stand where that thing used to be, a long near-silent off-beat hold (goal `mourn`). Hard rails: never grieves its OWN decor (`ownPlaced`), never on a station load, rate-limited (one grief / 45s), yields to summon. New: `dbg()` read-only introspection on the public API for live verification. **Verified live** on :8101 (worktree build): zero console errors, the full idle FSM cycles (quirk/work/summon/place/gaze/lounge/wander), and `fond` accrues at dwell tiles. Rotated to the memory/identity category (Pass 4 was Tier 1/3). **Next:** wake ritual + spoken first thought at `releaseAwakening`; or rotate to Tier 2 reactive (belt-yield while walking, cross-room work-pulse reactions); guard the calm baseline — consider a RETUNE pass if idle reads as too busy.
