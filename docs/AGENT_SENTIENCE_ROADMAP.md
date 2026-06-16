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
- [ ] **Pause mid-stroll**: stop for a beat, then continue (anticipation/weight)

### Tier 1 — purposeful idle (common)  ✅ shipped
- [x] Lounge on couch + watch TV; tend the desk (lonely); pace (restless); gaze into the void (long downtime)
- [ ] **Caretaker rounds**: a deliberate 2–3 stop lap (belt→machine→desk) with an ownership beat at each
- [ ] **Revisit a favorite spot** (see Tier 3 memory)

### Tier 2 — reactive / aware (uncommon; triggered by the world)  ✅ partly shipped
- [x] Acknowledge the Commander on hover/click (turn, meet your gaze)
- [x] Anticipation at INTAKE / exhale at OUTBOX
- [x] **Startle**: something appears within ~3 tiles → sharp 240ms snap + dir flip + a beat (`pushNovelty`)
- [x] **Settle-scan on arrival** (glance L, R, then commit) + **parting glance** on leaving (`scanThen`, dwell-clear)
- [ ] **Belt-yield while walking**: step to the tile edge, let active cargo pass, continue
- [ ] **React to the work pulse from across the room** (snap toward intake/outbox lighting up, anywhere)

### Tier 3 — the uncanny inner life (rare; the "why did it do that" beats)  ◐ started
- [x] **Quirk layer** (`maybeQuirk`): freeze-and-listen, slow room scan, ponder-facing-away, gaze-out
- [x] **THE LONG STARE** at the Commander — holds eye contact 14–34s, near-silent (rarest quirk)
- [x] **Face a wall/corner** and stand there (eerie, unexplained) — `quirkFaceWall` (9% of quirks)
- [ ] **Anomaly beats**: stop dead-center of a room and face a cardinal direction, motionless
- [ ] **The double-take**: walk past something, stop, slowly walk back to look again
- [ ] **Mimic the cursor**: very rarely, track the Commander's mouse for a few seconds (it sees you moving)
- [ ] **Off-beat timing**: occasionally hold a pose far longer than expected (unsettling duration)
- [ ] **Sleep / power-down** in deep `drift` phase: sits, head dips, near-frozen, until something stirs it

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

### Tier 5 — memory, ritual, identity (rare; pays off over long watching) ⛔ not started
- [ ] **Favorite spot** it returns to + **mourns** if a REFIT deletes it
- [ ] **Wake ritual** + spoken first thought at `releaseAwakening`
- [ ] **Long-arc identity**: temperament expressed as accumulating habits/marks unique to this agent
- [ ] **Names/notices the Commander's patterns** (time-of-day, what you build) — very rare callbacks

### Tier 6 — Easter eggs (ultra-rare wildcards; the screenshot/clip moments) ⛔ not started
- [ ] Ultra-rare cryptic line that breaks the fourth wall just slightly, once
- [ ] A one-frame "glitch" in its own sprite, instantly corrected (is it... aware it's rendered?)
- [ ] Rare constellation-gazing it seems to "recognize"; rare salute; rare it waves back
- [ ] Date/▢-triggered specials (only if a real clock is available, not faked)

## Pass log
- **Pass 1**: rhythm phases (`phaseOf`) + quirk layer (`maybeQuirk`: listen/scan/ponder/gaze-out/long-stare) + this roadmap. The long stare is the headline eerie beat.
- **Pass 2**: embodied reactions — **startle** at sudden nearby change, **settle-scan** on study arrivals + **glance back** when leaving, and a new **face-a-wall** quirk.
- **Pass 3**: ⭐ THE BIG ONE — the agent **acts on the station**: rarely walks to empty floor and places its OWN decor (real `addProp`), and at cap rearranges by removing one of its own. Hard safety rails (validated placement = never the Commander's props; capped; rare). Verified the rails against the real worldmodel (9/9). Next up: caretaker rounds, belt-yield, cross-room work-pulse reactions, sleep/power-down in `drift`, and a silent agent-mutation lane (avoid undo pollution).
