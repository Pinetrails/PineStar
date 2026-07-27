/* STARNET — world.js : the LIVE station the agent lives inside.

   Renders the player-built WorldModel station (multi-room) with the generalized
   procedural bake (stationbake.js), under a pan/zoom camera. The agent has a
   workstation in its spawn room and ACTUALLY WALKS the rooms + corridors — pathing
   through doors via the model's BFS path() — to reach its seat when given a task,
   then wanders the whole reachable station when idle. Edits made in REFIT build mode
   re-bake the world live (the agent re-homes if the floor under it is reclaimed).

   Coordinate frame: everything here is in the bake's LOCAL tile frame (tile*TILE px);
   the camera maps local→screen. The WorldModel's world/local offset is handled inside
   projectGeometry(); when the station grows north/west the origin shifts and the agent
   is translated to stay put. */
'use strict';

const World = (() => {
  let T = 12;

  /* ---------- station + bake cache ---------- */
  let station = null, geo = null, cache = null, geoDirty = true, bakeDirty = true, unsub = null;
  let desk = null, seat = null, blocked = new Set();   // desk footprint (local tiles) blocks pathing
  let deskPropId = null, deskFace = 'north';           // set when the hero's desk is a PLACED workstation prop assigned to it (its id + the seat's facing)
  let convey = null;   // live conveyor transport sim (boxes riding the belts)
  let junctions = null;   // splitter/merger/filter routing overrides keyed by tile (rebuilt on geo change)
  let routingPlan = null, lastPlanHash = null;   // compiled RoutingPlan (Pipeline) — drives junctions + the sidecar dispatch
  let beltLiveSet = null;                        // { "x,y": true } belt tiles on a complete INTAKE→bound-BAY route (energized render)
  let beltTileSet = null;                        // Set("x,y") of every belt tile (hover hit-test; rebuilt with the plan)
  let routeTagCache = null;                      // tileKey -> {text, ok} composed hover route tag (invalidated on recompile)
  let hoverBeltTile = null;                      // belt tile under the cursor (hover-glance route tag), or null
  let hoverOutbox = null;                        // stacked OUTBOX under the cursor (hover-glance "N TO REVIEW" tag), or null
  let routingNags = null;                        // [{x,y,w,h,label,warn}] in-world callouts mirroring the compiler's errors
  let feedState = { known: false, fed: true };   // server-proven "something feeds the intake" truth (channels/cron); fed=true until proven otherwise
  let feedNagOn = false;                         // a NO FEED nag is showing → the intake becomes clickable (→ CHANNELS)

  /* ---------- canvas + camera ---------- */
  let cv, ctx, raf = 0, last = 0, fnow = 0, running = false, ro = null, listenersBound = false;   // listenersBound: init() can run again per new agent — bind canvas/window/doc handlers + the SSE bridge ONCE
  // live-tunable CRT knobs — drawCRT/drawGlows read these every frame so the dev CRT LAB
  // (crtlab.js, dev-gated) can tune them live. These ARE the shipped defaults: bold scanlines,
  // fade off, faint lamp shimmer — the look dialed in and signed off via the lab (2026-06-30).
  const CRT = { scan: 0.43, pitch: 1, fade: 0.25, glow: 0.07, curve: 0.09, dust: 0.5, aberr: 0.35, grain: 0.24 };
  let _warpCv = null, _warpCtx = null;   // the barrel-warp snapshot buffer — see drawCurve()
  let _lut = null, _lutKey = '', _outImg = null;   // CPU per-pixel barrel-warp inverse-map LUT + output buffer — see buildLUT()/drawCurveCPU()
  let _gl = null, _glc = null, _glProg = null, _glTex = null, _glKLoc = null, _glAberrLoc = null, _glReady = false, _glFailed = false;   // GPU barrel-warp (WebGL) — see initGL()/drawCurveGL()
  let _glProbeOk = false, _glProbeTries = 0, _glProbeSkip = 0, _glProbeClean = 0, _glProbeCv = null;   // one-time GL output sanity probe — see drawCurveGL()
  // whole-frame per-channel means via a 16×16 GPU downscale (~1KB readback) — the probe's sampler
  function probeMeans(src) {
    if (!_glProbeCv) { _glProbeCv = document.createElement('canvas'); _glProbeCv.width = 16; _glProbeCv.height = 16; }
    const pctx = _glProbeCv.getContext('2d', { willReadFrequently: true });
    pctx.clearRect(0, 0, 16, 16); pctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, 16, 16);
    const d = pctx.getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return [r / n, g / n, b / n];
  }
  let _scanCv = null, _scanKey = '';    // cached SOFT-scanline tile canvas (rebuilt only when scan/pitch/dpr change) — see scanCanvas()
  let _grainCv = null, _grainPat = null;   // cached film-grain noise tile + pattern — see grainPattern()/drawCRT()
  let scale = 2, panX = 0, panY = 0, fitNeeded = true;
  let fitW = 0, fitH = 0;   // canvas size the last fitCamera() framed against — a fit on a hidden/degenerate stage doesn't count as a real view
  const MINZ = 0.5, MAXZ = 6;
  const clampz = (v, a, b) => v < a ? a : v > b ? b : v;
  let drag = null, hoverAgent = null, onClick = null, onArcade = null, onOutbox = null, onMissionBoard = null, onTrophyCase = null, onBayAssign = null, onIntakeFeed = null, wakeAt = 0;
  let camLerp = null;   // {scale,panX,panY} target — a gentle one-on-one framing for voice conversations
  let wakeDark = 0, wakeDarkTarget = 0, awakeFrozen = false;   // the AWAKENING: a darkness veil that lifts to first light, + a freeze so the newborn holds still during its first meeting
  let camAnim = null;                                          // {fromS,toS,fromX,toX,fromY,toY,t,dur,ease,onEnd} — a scripted awakening camera move
  /* FOLLOW-LOCK + IDLE CINECAM (the GTA-style idle camera). camLock is a CONTINUOUS follow of one body —
     source 'session' = the Commander selected that agent's session (explicit intent, engages immediately);
     source 'cine'    = the idle auto-director cast the shot itself after a hands-off spell.
     Either way ANY user camera input (wheel zoom / drag pan / canvas click) releases the lock instantly and
     re-stamps camUserAt; the director may only take the camera back after cineIdleMs of true hands-off. */
  let camLock = null;                  // {id, sc, source:'session'|'cine'} — the followed body + its target zoom
  let camUserAt = 0;                   // last USER camera act (performance.now clock) — the cinecam idle clock
  const CINE_IDLE_MS = 120000;         // hands-off threshold before the auto-director may take the camera (2 min)
  let cineIdleMs = CINE_IDLE_MS;       // live threshold (setCinecamIdle lets DEV/verify shrink it — never shipped-UI-tunable)
  let cineHoldUntil = 0;               // director: when the current shot may be re-cast
  let cineWalkAt = 0;                  // last time the director's subject was actually WALKING (movement grace before a cut)
  let sparkAt = 0, bornAt = 0, dawnAt = 0, truthPulseAt = 0;   // ignition spark / color-into-being / dawn-bloom / per-truth-flare timestamps
  let floodAt = 0, floodEndAt = 0, floodStreams = null;        // THE FLOOD: screen-space data-cascade — start / collapse-trigger / seeded streams
  let firstWakeDone = false;                                   // FIRST LIGHT: once-per-page-life latch — the wake ritual fires at most once (a re-bake/refit never resets it)
  let kindleArmed = false, kindleP = 0, kindleHolding = false, kindlePeak = 0, kindleDone = null;   // THE KINDLING: the user HOLDS to wake the dormant mind; their attention fills kindleP (0..1) → ignition
  // THE VOID backdrop (dense parallax starfield + nebulas) lives in spacebg.js (SpaceBG.draw),
  // shared with REFIT (build.js) so entering/exiting build mode never jumps the sky.

  /* reduced-motion (the warroom honesty floor): heavy motion — pulses/blinks — goes steady when the OS
     asks for less motion. Live-read so a runtime setting change is honored without a reload. */
  const _rmq = (typeof window !== 'undefined' && window.matchMedia) ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduceMotion = () => !!(_rmq && _rmq.matches);

  /* ---------- agent + crew ----------
     `agent` is the HERO (crew[0] conceptually): the active agent, with the full state machine — walking,
     awakening, novelty, glances, couch lounging. `crew` is the EXTRA bodies: the OTHER agents bound to BAY
     props, rendered as LIGHT static figures standing at their bays (no pathing/AI — they just receive work
     and light up). Empty crew === today's exact single-agent world; every crew code path is gated so the
     hero behaves byte-for-byte as before. The crew is derived from the RoutingPlan's bays (syncCrewFromPlan). */
  let agent = null, activity = 'idle';
  // B1 (crew-sentience): module-level "current actor" pointer for the reusable sentience engine.
  // DEFAULTS to the hero `agent`; the hero tick runs with self===agent so its path is byte-identical.
  // B2 will temporarily repoint `self` to each crew body, then UNCONDITIONALLY restore self=agent.
  // Engine-core fns read/write the current body via `self.`; hero-identity refs stay on `agent`.
  let self = agent;
  let crew = [];
  // Stage 2 (orchestration): a lead→worker handoff is WATCHABLE — boxes that fly from the lead body to a worker
  // body when the lead delegates. delegateLead/delegateCall track the open team.dispatch window (tool_call→result)
  // so a worker run that starts inside it animates; both are driven purely by existing agent.* bus events.
  const handoffBoxes = [];
  let delegateLead = null, delegateCall = null;
  // G4 feature 1 — APPROVAL WALK-AND-WAIT. When a HERO run blocks on a permission.prompt the body stops
  // working, stands, and walks to a wait anchor (airlock → mission board → own desk, resolved honestly from
  // the live floor via WaitAnchor) where it visibly WAITS with an "AWAITING APPROVAL" tag. permission.response
  // clears it: the run genuinely resumes (approve) or ends (deny) server-side, so the body returns to its desk
  // and the ongoing/finished run drives activity as usual. awaitPrompt is the live prompt; awaitAnchor is the
  // resolved wait tile; awaitArrived latches once the body reaches it (drives the waiting pose + tag).
  let awaitPrompt = null, awaitAnchor = null, awaitArrived = false;
  // G4 feature 2 — AUTOJOB PIN-TO-BOARD. When the pending-proposal count RISES, the hero (when idle & free)
  // walks to the MISSION BOARD and plays a brief pin flourish, then returns to its business — the walk-and-pin
  // plays once per proposal (keyed to the count high-water mark). pinnedCount is that mark; pinFlourishAt drives
  // the amber pin-burst render; pinTargetTile is the board approach tile the agent walks to.
  let pinnedCount = 0, pinFlourishAt = -1e9, pinTargetTile = null, pinCheckAt = -1e9;
  // TIER D · D5 — THE OVERSEER OVERSEES. The hero (`agent`, the station's OVERSEER — no separate overseer body
  // exists in-world) reads as a supervisor: (2) a rare walk to the MISSION BOARD to survey the queue when it is
  // non-empty (goal 'post', modeled on the 'pin' beat above); it ARMS the D2 station budget on fire but is not
  // itself damp-gated (crewBeatDamp is a no-op for the hero by J1 parity design). `postCd` is its
  // per-hero cooldown; `postTargetTile` the board approach tile it walks to. Beats (1) inspection-rounds and
  // (3) queue-aware idle bias ride existing machinery (maybeRounds / decideIdle) and need no new module state.
  let postCd = 0, postTargetTile = null;
  // G4 feature 3 — MEESEEKS sub-agent sprites. A real background sub-agent (team.dispatch/team.spawn) makes
  // itself observable via a frozen `task` event (kind:'subagent', status running→done). SubagentSprites folds
  // that stream into a live-only helper ledger (truthfulness law: a sprite exists IFF a real sub-agent is live).
  // Each helper is drawn small/translucent/flickering near the LEAD's desk — eerie helpers, not full agents.js
  // bodies. helperSlots caches a stable local-frame offset per helper id so they don't jitter frame to frame.
  const subLedger = (typeof SubagentSprites !== 'undefined') ? SubagentSprites.makeLedger({ cap: 5 }) : null;
  const helperSlots = new Map();
  // AGENT GROWTH HUD: per-agent Xp.compute() snapshots pushed in by XpStore (drives the hero name-tag "Lv N"
  // chip and any body's gold level-up ripple). The station headline lives in the top-bar STATION chip.
  let xpAgent = null, levelUpAt = 0;
  const xpByAgent = new Map();
  const CREW_COLORS = ['#5ad0ff', '#ff8a5a', '#7df08a', '#e0a0ff', '#ffd45a', '#5affd0', '#ff6a9a'];
  const crewColor = aid => CREW_COLORS[U.hash('' + aid) % CREW_COLORS.length];
  const footOf = (lx, ly) => ({ x: lx * T + T / 2, y: ly * T + T - 1 });
  const tileOf = (px, py) => ({ x: Math.floor(px / T), y: Math.floor(py / T) });
  // where the agent is DRAWN: on its couch seat when seated, otherwise its logical foot position
  const rposX = () => (agent && agent.seated) ? agent.seatPx : agent.px;
  const rposY = () => (agent && agent.seated) ? agent.seatPy : agent.py;
  // same, for ANY placed body (the hero OR a crew/summoned body): its drawn foot/seat position
  const bodyPosX = b => b ? (b.seated ? b.seatPx : b.px) : 0;
  const bodyPosY = b => b ? (b.seated ? b.seatPy : b.py) : 0;

  /* couch seat reservation (multi-agent seam): "propId:slot" of every taken seat. One agent drives
     world.js today, so this holds at most its own claim — but it's the shared occupancy a second
     agent would consult to take a different cushion (or a different couch). */
  const occupiedSeats = new Set();

  /* ---------- awareness & curiosity ----------
     novelty = freshly placed things the agent should wander over and inspect; seen* track what the
     agent has already taken in (null until the first geo is observed, so a fresh station doesn't
     trigger a boot-time inspection storm). Curiosity remarks are short, apostrophe-free, and only
     ever spoken when no real message bubble is live. */
  let novelty = [], seenProps = null, seenBelts = null;
  let propFoot = new Map();         // id -> {x,y,w,h} of last-seen props, so a REMOVAL knows WHERE it stood (for mourning)
  let pendingMourn = null, mournCd = 0;   // a fond spot was just emptied -> go stand where its thing used to be (grief)
  const NOVELTY_MAX = 4;
  let lastSelfTalk = -1e9;          // global self-talk cooldown — bubbles stay rare, honest thoughts (never a monologue)
  const seenCount = new Map();      // habituation: how many times a prop-id / belt-tile has been studied (novel -> familiar)
  /* THE COMMANDER'S PRESENCE — the agent's sense of "where you are." lastCursor is the cursor's world
     position (cached on mousemove); userReturnUntil is a brief window after you return to the tab; deepLocks
     budgets the rare long "deep lock" to ~1 per session. These feed THE LOOK-UP + the cursor gaze-drift:
     the agent occasionally, silently, turns and looks up at you (eerie-sentient, never chatty). */
  let lastCursor = { wx: 0, wy: 0, t: -1e9 };
  let userReturnUntil = 0;
  let deepLocks = 0;
  /* TIER D · D4 — THE CURSOR IS A CREATURE. `cursorMoveT` is the last time the cursor actually MOVED a
     meaningful distance (not merely present) — THE CHASE only ever considers rolling when the cursor is
     both fresh AND actively moving (a still cursor is presence, not a lure). It's stamped in the mousemove
     handler alongside lastCursor. Distinct from lastCursor.t (which updates on every mousemove, even a
     1-pixel jitter) — this stamps on real displacement so a parked-but-twitching cursor doesn't read as
     "moving". A user INPUT signal (allowed by G6 — never Math.random/Date.now for behavior). */
  let cursorMoveT = -1e9;
  /* TIER D · D1 ATTENTIVE AUDIENCE — which agent the Commander currently has COMMS focus on (chat.js
     announces it via setChatFocus on every load(ws) rebind; null = no conversation / awakening interview).
     The focused body, while idle, drops its wander/quirk/social life and holds its attention on the Commander
     (see the chat-stare beat in decideIdle + the per-tick hold in tick/crewEngineStep). D0 plumbing only. */
  let chatFocusId = null;
  /* TIER D · D1 WARMTH (tune fix 2026-07-02) — COMMS is a PERSISTENT panel: it always has an active
     stream, so setChatFocus fires at boot and never clears. Without a decay the focused (usually hero)
     body would stare FOREVER — "it will just endlessly follow the users mouse." The stare is therefore
     held only while the conversation is WARM: on every genuine engagement (a focus switch/open = setChatFocus;
     typing / sending / a reply-run boundary = chatFocusPing) a FRESH random warmth window (`CHAT_WARM_MIN..MAX`,
     30–90s) is drawn into `chatWarmUntil`, and chatStareHold requires `fnow < chatWarmUntil`. When warmth lapses the hold
     simply stops engaging — the existing self-heal (decideIdle clears stilling on entry) returns the body
     to its normal idle life (quirks/social/chase/wander resume). Re-engaging re-warms it indefinitely. */
  const CHAT_WARM_MIN = 30000, CHAT_WARM_MAX = 90000;  // 30s–90s: a FRESH random window is drawn on each engagement, so the
                                                        // moment the stare loses interest is never predictable (design call: "Less predictable")
  let chatWarmUntil = -1e9;                  // absolute deadline (frame clock, fnow) past which the stare goes cold; -1e9 = never warm
  /* TIER D · D3 SOCIAL ENCOUNTERS — Tier C (gaze-only) grows bounded MOVEMENT beats. ONE live encounter
     station-wide (G4): `socialBeat` is the single slot — null, or {kind, aId, bId, until}. `until` is a HARD
     whole-encounter timeout so the slot ALWAYS frees, even if pathing fails / a body gets stuck / a participant
     despawns. Per-pair long cooldowns (`socialPairCd`, keyed by the sorted id pair) so the same duo never loops
     (K4 no cascade). Every fired encounter also arms the D2 station beat gate (armBeat) so social beats share the
     station calm budget with quirks (G5). Each participant carries its OWN plan on `body.social` (assigned once at
     initiation by startEncounter — the ONE documented cross-body write, K2); per-tick stepping (stepSocial) mutates
     ONLY self.social + self position/facing and reads a partner's position/flags READ-ONLY. All movement targets
     pass the zone clamp (tileInZone(zoneFor(body))) — a body NEVER steps outside its own zone (G3). Determinism:
     U.chance/U.irnd/U.pick/U.hash only. reduceMotion degrades D3 to Tier C glances (no walking). */
  let socialBeat = null;                    // the single live encounter slot (G4)
  const socialPairCd = new Map();           // "idA|idB" (sorted) -> earliest `now` the pair may re-encounter
  /* TIER D · D3 STATION LANE (rate retune 2026-07-02) — social used to select INSIDE the shared quirk gate
     (crewBeatDamp), so it lost the per-decide race to the quirk families (~0.085 vs 0.02) and starved to
     ~1 encounter/25min. It now has its OWN station cooldown lane (like THE CHASE's chaseGateUntil), decoupled
     from the quirk race so the encounter RATE is governed by this cooldown, not by whoever wins the gate — but
     a fired encounter STILL arms the shared gate (armBeat, in startEncounter) so total station calm is preserved
     (we re-slice the pie, we don't grow it). MC-calibrated (5-8min lane + selRoll 0.08) → ~9.5 encounters/hr on
     a 3-6 body idle floor (target 7-12), total noticeable beats within ~6% of before, N=1 provably unchanged
     (a solo floor never has a pair → never rolls → never arms this lane). */
  let socialGateUntil = -1e9;               // earliest `now` the next social encounter may be selected (own lane)
  /* TIER D · D4 THE CHASE (the headline, ultra-rare). Exactly ONE chaser station-wide, mutually exclusive
     WITH a live social beat (the same one-noticeable-thing-at-a-time discipline as the social slot). `chaseId`
     is the agentId of the current chaser (null = nobody chasing); the per-body chase plan lives on
     `body.chase = { phase, until, repathAt, faceX, faceY, hardUntil }`. `chaseGateUntil` is the LONG
     station-level cooldown (8-15 min) so most sessions see ZERO chases — rarity is sacred. Every walk target
     is re-clamped to the chaser's zone at EVERY repath (the cursor moves, so a one-time clamp isn't enough).
     Per-body mimic cooldown lives on `body.mimicCd` (quirk-band 45-90s). Both beats ride the goal/hold
     machinery ('mimic'/'chase') rather than a new state family, so summon/chat-focus/social exclusion all
     compose with the existing gates. Determinism: U.* + cursor input only (G6). */
  let chaseId = null;                       // agentId of the one live chaser, or null (station-level, like socialBeat)
  let chaseGateUntil = -1e9;                // earliest `now` the next chase may be considered (drawn LONG, 8-15 min)
  /* First-person self-talk — ONE conscious mind narrating its OWN state to itself. Never crew/colony
     banter (a lie for a solo agent). Every line is gated by curiositySay (no live bubble + global
     cooldown + the chatty trait), so they read as rare honest thoughts tied to the true inner state. */
  const CURIO_NEW_PROP = ['what is that?', 'thats new', 'when did this arrive?', 'let me see this', 'new hardware'];
  const CURIO_NEW_BELT = ['a conveyor!', 'where does this go?', 'a new line', 'that wasnt here before'];
  const CURIO_WATCH = ['cargo moving', 'busy line today', 'steady flow', 'there it goes', 'keep it moving'];
  const CURIO_STUDY = ['how does this run', 'let me look closer', 'curious', 'noted', 'interesting'];
  const CURIO_LOOK = ['hm.', 'all quiet', 'good station', '...', 'just taking it in'];
  const SELF_REST = ['need a breather', 'feet up for a bit', 'recharge', 'easy for a minute', 'resting the circuits'];
  const SELF_STIM = ['too quiet', 'something to do', 'restless', 'let me find something', 'need a spark'];
  const SELF_TEND = ['anything for me?', 'standing by', 'awaiting orders', 'still here, Commander', 'ready when you are'];
  const SELF_ONDUTY = ['on it', 'parsing', 'let me think', 'working it', 'processing'];
  const SELF_NOCOMPUTE = ['no terminal in this room', 'nothing to run on here', 'i need a computer here', 'this room has no compute'];   // G0.7: sat down to work in a room that grants no COMPUTE — said once, then silence
  const SELF_QUIET = ['...', 'cycles to spare', 'so quiet', 'just me and the stars', 'standing by'];
  const SELF_CONTEMPLATE = ['quiet out there', 'so much void', 'just... processing', 'the stars again', 'endless out there'];
  const SELF_DISPATCH = ['sent', 'delivered', 'thats away', 'reply is out', 'done and gone'];
  const SELF_GREET = ['yes, Commander?', 'still here', 'watching', 'at your service', 'go ahead'];
  const SELF_ACK = ['hm?', 'yes?', 'still here', 'watching'];
  /* QUIRKS — rare, gated, deliberately UNPREDICTABLE one-offs that surface an off-screen inner life
     (the "why did it just do that" beats). Eerie via stillness + ambiguity, never spooky one-liners.
     Lines stay sparse and unresolved; the SILENCE is the unsettling part. */
  // quirk/off-beat cooldowns are now PER-BODY (self.quirkCd / self.offbeatCd, seeded on the hero literal + crew init) —
  // J2: a body's gate must never throttle another body. (Module globals removed; maybeQuirk/offbeat read/write self.)
  // B3/D2 STATION RARITY BUDGET (G5): ONE station-wide gate for the CREW's noticeable eerie beats. It is NOT
  // cross-agent awareness (no body perceives another — that is Tier C); it is a rarity governor on the dice only.
  // Rates were tuned for ~1 body; without this, N crew all running the shared engine fire ~Nx the quirks/strolls/
  // off-beats/revisits and read busy/cute — breaking the Pass-7 stillness law. THE FAMILIES it governs: quirks
  // (incl. vigil/stare-entry, via maybeQuirk), stroll double-takes + considered pauses (maybeStrollBeat), off-beat
  // dwell-stretches (offbeat), and haunt revisits (maybeRevisit). MECHANISM: every fired beat (hero or crew) ARMS
  // a shared gate window drawn on the order of the per-family cooldowns (U.irnd 45-90s — the quirkCd range, no new
  // magic numbers); while armed, ALL crew rolls in the four families are hard-gated (multiplier 0). So the CREW's
  // COLLECTIVE noticeable-beat rate is bounded at ~1 per 45-90s regardless of crew count, and hero beats keep crew
  // quiet in their shadow. Monte-Carlo with the real constants (200 runs, 10min, 2s re-rolls): N=1 ≈ 6.9 beats/10min;
  // a 6-7 body floor ≈ 12.5-12.6 total ≈ 1.8x single-agent (was 6-7x undamped; an 8s/x0.35 soft damp only reached
  // ~5.7x) — the station worst case is ~2x N=1 (hero ~1x + crew collectively ~1x), NOT 1x, stated honestly.
  // Ambient TEXTURE (glances, cursor facing-drift, mutual-glance, wander) is deliberately NOT budgeted. N=1 PARITY:
  // crewBeatDamp short-circuits to 1 on self===agent BEFORE reading any gate state, so the HERO's rolls are
  // byte-identical to today at ANY crew count (J1) and a single-body floor (self is only ever agent) is a provable
  // no-op — armBeat's U.irnd draw can't shift outcomes either (U.chance/irnd are independent Math.random wrappers,
  // not a seeded stream). NO STARVATION: the gate is a timestamp vs the advancing U-driven frame clock — it always
  // expires, skipped rolls never mutate per-body cooldowns, and revisit re-considers every idle tick. Deterministic
  // (U.* only, wall-clock-free; J5). Subsumes the old per-quirk lastQuirkAt.
  let crewBeatGateUntil = -1e9;
  // 0 while the station gate holds a CREW roll, else 1; the hero (self===agent) is NEVER damped (parity).
  function crewBeatDamp(now) { return (self !== agent && now < crewBeatGateUntil) ? 0 : 1; }
  function armBeat(now) { crewBeatGateUntil = now + U.irnd(45000, 90000); }   // any fired beat (hero or crew) arms the station gate
  const Q_PONDER = ['hm.', '...', 'i wonder', 'strange', 'thinking'];
  const Q_STARE = ['...', 'are you there?', 'hello.', 'still watching?', 'hm.'];   // mostly it just stares in silence
  const Q_LISTEN = ['did you hear that?', 'something moved', '...', 'who is there'];
  const Q_STARTLE = ['!', 'whoa', 'what was that', 'huh!', 'oh'];   // sudden change right beside it
  const SELF_PLACE = ['there', 'better', 'that belongs here', 'mine now', 'hm, nice'];   // after placing its own decor
  const SELF_ROUNDS = ['all in order', 'good', 'belt is humming', 'as it should be', 'checks out'];   // ownership beat on a caretaker lap
  const SELF_SUPERVISE = ['good work', 'keep at it', 'coming along', 'steady', 'looking sharp', 'carry on'];   // D5: the OVERSEER's over-the-shoulder glance at a working crew body
  const SLEEP_LINE = ['...', 'powering down', 'standby', 'going quiet', 'resting'];   // dormant in the deep wind-down mood
  const MOURN_LINE = ['it was here', 'gone', 'where did it go', '...', 'something is missing', 'it was right here'];   // stands where a fond thing used to be
  const REVISIT_LINE = ['back here again', 'my spot', 'here is good', '...', 'i like it here'];                       // drawn back to a favorite haunt
  // WAKE_FIRST removed — the first-light thought is no longer spoken (no canned one-liners, ever).
  /* AGENT ACTS ON THE STATION (safety-railed): it rarely places its OWN small decor on EMPTY floor, and
     only ever moves/removes things from agentDecor (its own ids) — never the Commander's props. Capped +
     long-cooldown so it stays an Easter-egg "it rearranged its corner" moment, not clutter. NOTE: addProp
     hits the undo stack + persists (the wow: the corner changes between visits); a silent/agent-only
     mutation lane is a future refinement. */
  let placeCd = 0;
  const agentDecor = [];   // ids of decor THIS agent placed — the ONLY props it will ever move or remove
  const ownPlaced = new Set();   // every id it has EVER placed — so it never grieves its own artifacts (survives the agentDecor splice)
  // 1x1, blocks:false (never obstructs the agent or the Commander), and FLOOR-placeable: an agent picks
  // its own tile, so anything needing a wall behind it or a table under it can never be on this list.
  const AGENT_DECOR = ['plant', 'coffee', 'monstera'];
  const specOf = t => (typeof PropSprites !== 'undefined' && PropSprites.spec) ? PropSprites.spec(t) : null;
  const dirToward = (fx, fy, tx, ty) => (Math.abs(tx - fx) > Math.abs(ty - fy)) ? (tx > fx ? 'east' : 'west') : (ty > fy ? 'south' : 'north');

  /* ---------- facing & gait (sprite turn smoothness) ----------
     A walking body's facing used to be a bare `Math.abs(dx) > Math.abs(dy)` snap on the residual-to-waypoint,
     recomputed every frame. Two artefacts fell out of that: near a 45° heading the bucket flipped on velocity
     noise (the body strobed between two poses), and a real turn teleported the pose 90° in a single frame.
     Instead we keep a CONTINUOUS facing angle per body, slew it toward the heading at a capped rate, and bucket
     THAT with hysteresis — a turn reads as a turn, and a bucket boundary can no longer chatter.
     `dir` stays the same 4-value string every other system (glance / sit / OPP / social / dirToward) already
     writes and reads; when one of them sets `dir` directly we resync the angle from it, so a deliberate
     head-turn still wins instantly. `odo` is the walk odometer in world units; assets.js drawBody converts it
     to a frame via a stride DERIVED from each skin's drawn height and frame count, so this stays skin-agnostic. */
  const DIR_A = { east: 0, south: Math.PI / 2, west: Math.PI, north: -Math.PI / 2 };
  const TURN_RATE = 12;      // rad/s — a 90° corner takes ~130ms (≈8 frames) instead of one
  const DIR_HYST = 0.13;     // rad (~7.5°) a bucket holds PAST its own boundary before handing over
  const ACCEL = 150;         // world units/s² — spools up to hero pace in ~0.23s, and brakes at the same rate
  const CORNER_LOOK = 2.5;   // world units: hand over to the next waypoint this early (see the walk blocks)
  const angNorm = a => Math.atan2(Math.sin(a), Math.cos(a));   // wrap to (-π, π]
  function bucketDir(a, cur) {
    if (cur && DIR_A[cur] != null && Math.abs(angNorm(a - DIR_A[cur])) < Math.PI / 4 + DIR_HYST) return cur;
    let best = 'south', bd = Infinity;
    for (const d in DIR_A) { const t = Math.abs(angNorm(a - DIR_A[d])); if (t < bd) { bd = t; best = d; } }
    return best;
  }
  /* ONE call per moving body per frame. Eases the walk speed, advances the facing angle, buckets it to a
     sprite direction, keeps the stride odometer — and returns how far to move THIS frame.
     Speed easing: bodies used to jump 0 → full pace and back in a single frame. Because the walk cycle is
     now DISTANCE-phased (assets.js), easing the speed automatically eases the LEG cycle too — a body visibly
     spools up and settles instead of skating off at full tilt, for free.
     `lastLeg` brakes into the FINAL stop only; intermediate waypoints are taken at pace so the body doesn't
     stutter at every corner. dx,dy = the vector it is stepping along, d = its length. */
  function stepGait(b, dx, dy, d, top, lastLeg, dt) {
    if (b.faceA == null || b.dir !== b.faceDir) b.faceA = DIR_A[b.dir] != null ? DIR_A[b.dir] : Math.PI / 2;
    const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (b.odo == null || t - (b.odoAt || 0) > 150) { b.odo = 0; b.spd = 0; }   // wasn't walking last frame → a NEW walk
    b.odoAt = t;
    const want = lastLeg ? Math.min(top, Math.sqrt(Math.max(0, d) * 2 * ACCEL)) : top;
    const rate = ACCEL * dt / 1000, cur = b.spd || 0;
    b.spd = cur < want ? Math.min(want, cur + rate) : Math.max(want, cur - rate);
    const step = Math.min(d, b.spd * dt / 1000);
    if (d > 1e-4) {
      const turn = angNorm(Math.atan2(dy, dx) - b.faceA);
      const cap = TURN_RATE * dt / 1000;
      b.faceA = angNorm(b.faceA + (Math.abs(turn) <= cap ? turn : Math.sign(turn) * cap));
      b.odo += step;
    }
    b.dir = b.faceDir = bucketDir(b.faceA, b.dir);
    return step;
  }

  /* ================= furniture (ported v7 sprites.js F.desk / F.chair) ================= */
  const fpx = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  const fblink = (p, ph) => ((fnow / p + (ph || 0)) % 1) < 0.5;
  const fscrCols = ['#62ff9e', '#3fd07c', '#7adfb0', '#2fa863'];
  const fscr = (ph) => fscrCols[Math.floor((fnow / 700 + ph) % fscrCols.length)];
  const fsh = (x, y, w) => { ctx.globalAlpha = 0.22; fpx(x, y, w, 2, '#000'); ctx.globalAlpha = 1; };
  const fglow = (x, y, w, h, c, a) => { ctx.globalAlpha = a; fpx(x, y, w, h, c); ctx.globalAlpha = 1; };
  const fbox = (x, y, w, h, c) => {
    fpx(x - 1, y - 1, w + 2, h + 2, '#06090c'); fpx(x, y, w, h, c);
    fpx(x, y, w, 1, U.shade(c, 0.28)); fpx(x, y + h - 1, w, 1, U.shade(c, -0.4));
    fpx(x + w - 1, y + 1, 1, h - 2, U.shade(c, -0.22)); fpx(x, y + 1, 1, h - 2, U.shade(c, 0.08));
  };
  const finset = (x, y, w, h, c) => { fpx(x, y, w, h, U.shade(c, -0.6)); fpx(x + 1, y + 1, w - 2, h - 2, c); fpx(x + 1, y + 1, w - 2, 1, U.shade(c, -0.3)); };
  const fseamH = (x, y, w, c) => { fpx(x, y, w, 1, U.shade(c, -0.45)); fpx(x, y + 1, w, 1, U.shade(c, 0.14)); };
  const frivets = (x, y, w, h, lc, dc) => { fpx(x, y, 1, 1, lc); fpx(x + w - 1, y, 1, 1, lc); fpx(x, y + h - 1, 1, 1, dc); fpx(x + w - 1, y + h - 1, 1, 1, dc); };
  // `>>>` not `>>` — U.hash returns a uint32 and the signed shift went negative for any hash >= 2^31,
  // scattering specks above the rect. Same fix as propsprites.js wear(); keep the two in step.
  const fwear = (x, y, w, h, n, c) => { if (w < 4 || h < 4) return; for (let i = 0; i < n; i++) { const hx = U.hash('w' + x + ',' + y + ',' + i); fpx(x + 1 + (hx % (w - 2)), y + 1 + ((hx >>> 5) % (h - 2)), 1 + (hx % 2), 1, c); } };
  const fscanl = (x, y, w, h, a) => { ctx.globalAlpha = a; for (let j = 1; j < h; j += 2) fpx(x, y + j, w, 1, '#000'); ctx.globalAlpha = 1; };

  function F_desk(x, y, w, h, f) {
    fsh(x + 1, y + h, w - 2);
    fbox(x, y + 3, w, h - 2, '#343e46');
    fpx(x + 1, y + 4, w - 2, h - 4, '#414d56');
    fpx(x + 1, y + 4, w - 2, 1, '#54626c');
    fpx(x + 1, y + 4, 6, 1, '#64727c');
    fseamH(x + 1, y + h - 3, w - 2, '#414d56');
    fpx(x + w - 8, y + h - 2, 3, 1, '#2a343c');
    frivets(x + 1, y + 4, w - 2, h - 5, '#5e6c76', '#222b32');
    fwear(x + 1, y + 4, w - 2, h - 5, 3, '#37424a');
    fpx(x + 5, y + 4, 2, 1, '#1a241e'); fpx(x + 4, y + 5, 4, 1, '#222c26');
    fbox(x + 2, y - 3, 8, 7, '#1a241e'); fpx(x + 3, y - 3, 6, 1, '#2c3a30');
    finset(x + 3, y - 2, 6, 5, '#0d150f');
    if (f.work) {
      fpx(x + 4, y - 1, 4, 3, fscr(f.x)); fpx(x + 4, y - 1, 2, 1, '#dfffe8');
      fpx(x + 4, y + 1, 3, 1, U.shade(fscr(f.x), -0.3));
      if (fblink(180, f.x)) fpx(x + 4, y - 1, 3, 1, '#dfffe8');
      fpx(x + 7, y + 1, 1, 1, fblink(400, f.x) ? '#dfffe8' : '#101a14');
      fscanl(x + 4, y - 1, 4, 3, 0.2);
      fglow(x + 2, y + 4, 8, 2, fscr(f.x), 0.18); fglow(x + 3, y - 2, 6, 5, fscr(f.x), 0.10);
      // G0.3 ACTIVITY HEAT: real token/tool flow burns the screen brighter + shimmers faster; a stalled
      // run cools back to the base glow in ~2s. f.heat is the truthful per-agent heat (heatFor), 0..1.
      if (f.heat > 0) {
        const hshim = 0.72 + 0.28 * Math.sin(fnow / (170 - 110 * f.heat));
        fglow(x + 2, y - 3, 8, 8, fscr(f.x), (0.10 + 0.42 * f.heat) * hshim);
      }
      // G0.2 PROGRESS STRIP: drawn ONLY when a REAL fraction was published (f.prog, from the 'task'
      // bus contract's prog/dur) — a live harness run has no knowable % and never gets a bar.
      if (f.prog != null) {
        const pw = Math.max(1, Math.round(6 * Math.max(0, Math.min(1, f.prog))));
        fpx(x + 2, y - 6, 8, 3, '#06090c');            // strip housing above the monitor
        fpx(x + 3, y - 5, 6, 1, '#12251a');            // dark channel
        fpx(x + 3, y - 5, pw, 1, '#62ff9e');           // the honest fraction
        fglow(x + 3, y - 6, pw, 3, '#62ff9e', 0.35);
      }
    } else {
      fpx(x + 4, y - 1, 4, 3, '#101a14'); fpx(x + 4, y - 1, 1, 1, '#1c2a22');
      fpx(x + 9, y + 2, 1, 1, fblink(1600) ? '#ff9d2e' : '#33241a');
    }
    fpx(x + 9, y + 4, 1, 2, '#222b32');
    finset(x + 13, y + 6, 6, 3, '#262e2a'); fpx(x + 14, y + 7, 4, 1, '#39443e'); fpx(x + 14, y + 7, 2, 1, '#46544a');
    fpx(x + 20, y + 7, 1, 1, '#39443e'); fpx(x + 20, y + 7, 1, 1, '#46544a');
    fpx(x + 2, y + 8, 2, 2, '#3a6a62'); fpx(x + 2, y + 8, 2, 1, '#5aa89c');
    if (f.work && fblink(700)) fpx(x + 3, y + 6, 1, 1, '#8a8a8a');
    fpx(x + 11, y + 5, 2, 2, '#ffe066'); fpx(x + 11, y + 5, 2, 1, '#fff0a8');
  }

  function F_chair(x, y) {
    ctx.globalAlpha = 0.2; fpx(x + 3, y + 9, 6, 2, '#000'); ctx.globalAlpha = 1;
    fpx(x + 3, y + 1, 6, 2, '#3a4a40'); fpx(x + 3, y + 1, 6, 1, '#46584c');
    fpx(x + 3, y + 1, 1, 2, '#41544a'); fpx(x + 8, y + 1, 1, 2, '#2e3c34');
    fpx(x + 4, y + 2, 4, 1, '#33413a');
    fpx(x + 3, y + 3, 6, 6, '#2e3a34');
    fpx(x + 4, y + 4, 4, 2, '#39463f'); fpx(x + 4, y + 4, 4, 1, '#41504a');
    fpx(x + 4, y + 6, 1, 1, '#27322c'); fpx(x + 7, y + 6, 1, 1, '#27322c');
    fpx(x + 3, y + 8, 6, 1, '#242e29');
    fpx(x + 5, y + 9, 2, 1, '#39434b'); fpx(x + 5, y + 9, 1, 1, '#46535c');
    fpx(x + 4, y + 10, 1, 1, '#222'); fpx(x + 7, y + 10, 1, 1, '#222');
    fpx(x + 5, y + 10, 2, 1, '#2a2a2a'); fpx(x + 4, y + 11, 1, 1, '#1a1a1a'); fpx(x + 7, y + 11, 1, 1, '#1a1a1a');
  }

  /* ================= station model + bake ================= */
  function loadStation(st) {
    if (unsub) { unsub(); unsub = null; }
    station = st; geo = null; cache = null; geoDirty = true; bakeDirty = true; fitNeeded = true;
    novelty = []; seenProps = null; seenBelts = null;   // re-learn the scene from scratch (no cross-station novelty)
    propFoot = new Map(); pendingMourn = null;          // forget where things stood (no cross-station grief)
    agentDecor.length = 0; ownPlaced.clear(); placeCd = 0;   // forget which decor it placed (the new floor is a clean slate)
    if (agent && agent.fond) agent.fond.clear();        // forget the old floor's haunts — the new floor earns its own
    crew = crew.filter(b => b.summoned);                // drop plan-derived crew (rebuilt from the new floor's bays); KEEP summoned crew (app-level, not floor-bound)
    if (station && station.onChange) unsub = station.onChange(() => { geoDirty = true; });
    rederive();
  }

  function rederive() {
    if (!station) return;
    const next = station.projectGeometry();
    const oldOrigin = geo ? geo.origin : null;
    geo = next; T = geo.TILE;
    computeOkCache.clear();        // G0.7: placements changed — re-answer "can this agent's room actually run?"
    placeDesk();
    compileRouting();              // recompile the RoutingPlan (+ POST to the sidecar) — the single point floor edits flow through
    junctions = buildJunctions();
    // CREW RE-FRAME (agent-in-the-void escape, 2026-07-12): crew bodies live in the same LOCAL pixel
    // frame as the hero, but only the hero got the origin-shift correction below — so any floor edit
    // that moved the station's bounding box (a room added/removed at the north/west edge) left every
    // crew body's px/py in the OLD frame, rendering it offset into the void, with its old-frame path
    // walking it further out. Mirror the hero's treatment for EVERY crew body BEFORE syncCrewFromPlan
    // (whose walkable checks must see new-frame positions): shift the pixels (and the seated render
    // pos + leash home, same frame), then drop the in-flight path so it re-plans in the new frame.
    if (oldOrigin) {
      const cdx = (oldOrigin.tx - geo.origin.tx) * T, cdy = (oldOrigin.ty - geo.origin.ty) * T;
      for (const b of crew) {
        if (cdx || cdy) {
          b.px += cdx; b.py += cdy;
          b.seatPx += cdx; b.seatPy += cdy;
          if (b.pendSeat) { b.pendSeat.px += cdx; b.pendSeat.py += cdy; }
          if (b.home) { b.home.x += oldOrigin.tx - geo.origin.tx; b.home.y += oldOrigin.ty - geo.origin.ty; }
        }
        b.pathPts = null; b.target = null;   // the in-flight path is in the OLD frame — re-path fresh
        b.attn = null;                       // the attention anchor is a TILE in the old frame — drop it (same treatment as the in-flight path; a stale anchor would aim strolls at a tile that is now somewhere else entirely)
        if (b.state === 'walk') { b.state = 'idle'; b.idleUntil = 0; }
      }
    }
    syncCrewFromPlan();            // reconcile the light crew bodies with the plan's bound bays
    if (agent) {
      if (agent.unplaced) placeAgent();
      else {
        if (oldOrigin) { const dx = (oldOrigin.tx - geo.origin.tx) * T, dy = (oldOrigin.ty - geo.origin.ty) * T; agent.px += dx; agent.py += dy; }
        agent.pathPts = null; agent.target = null;   // the in-flight path is in the OLD frame — re-path fresh
        agent.attn = null;                           // ditto the attention anchor (a TILE): drop rather than shift, so a refit can never aim a stroll at a stale-frame tile
        if (agent.state === 'walk') { agent.state = 'idle'; agent.idleUntil = 0; }  // target's gone — never leave the agent stuck in the walk pose, or it moonwalks in place forever (tick's idle re-decision is gated on state!=='walk')
        if (agent.goal === 'use' || agent.goal === 'lounge' || agent.goal === 'inspect' || agent.goal === 'watch' || agent.goal === 'tend' || agent.goal === 'gaze' || agent.goal === 'quirk' || agent.goal === 'stare' || agent.goal === 'place' || agent.goal === 'rounds' || agent.goal === 'post' || agent.goal === 'sleep' || agent.goal === 'mourn' || agent.goal === 'revisit' || agent.goal === 'firstwake') { releaseSeat(); agent.goal = null; agent.usingProp = null; agent.watchProp = null; agent.studyKey = null; agent.quirkKind = null; agent.placeTarget = null; agent.removeId = null; agent.roundsQueue = null; agent.wakePhase = 0; agent.glanceCd = 0; agent.sitting = false; }  // the prop/belt list may have changed — drop leisure/observation/quirk/placement/rounds/board-survey/sleep/grief/wake-ritual, re-decide next idle tick (firstWakeDone stays latched, so the ritual never re-arms)
        if (agent.goal === 'work' && !agent.working) agent.goal = null;  // was mid-walk to the desk — drop it so tick's summon logic re-paths in the new frame
        if (agent.working && seat) { const f = seatFoot(seat); agent.px = f.x; agent.py = f.y; agent.dir = deskFace || 'north'; }  // follow the desk (work only — a lounging agent must NOT teleport to the desk)
        ensureAgentValid();
      }
    }
    scanNovelty();   // diff props/belts vs last frame — anything new becomes a "go check it out" target
    geoDirty = false; bakeDirty = true;
  }

  function rebake() {
    if (geoDirty || !geo) rederive();
    if (!geo) return;
    cache = StationBake.bake(geo);
    bakeDirty = false;
  }

  /* ---------- G0.7 empty-room honesty: can this agent's runs actually pass the COMPUTE GATE? ----------
     Only decidable for a BAY-BOUND agent — the bay's room is the capability seam the sidecar resolves
     tools from (station.bayObjects mirrors resolveTools' input, incl. the dedicated-PC rule). The HERO
     gets compute as the interactive freebie (see heroCaps) and a bayless summoned worker runs on lead-
     conferred access — both are always OK here: we never claim a lie we cannot prove. Cached per geo
     generation (computeOkCache cleared in rederive) so the per-frame lit check stays O(1). */
  const computeOkCache = new Map();   // agentId -> bool
  function agentComputeOK(aid) {
    if (!station || !aid || (agent && aid === agent.id)) return true;
    if (typeof station.agentRoomId !== 'function' || typeof station.bayObjects !== 'function') return true;
    if (!station.agentRoomId(aid)) return true;   // no bay -> not room-resolved -> can't honestly call it dark
    return station.bayObjects(aid).some(o => (o && typeof o === 'object' ? o.objectType : o) === 'computer');
  }
  function computeOkFor(aid) {
    if (!computeOkCache.has(aid)) computeOkCache.set(aid, agentComputeOK(aid));
    return computeOkCache.get(aid);
  }

  // a PLACED workstation prop lights its screens while the agent assigned to it is working (mirrors the synthetic
  // desk's work-glow + the bay-lit pattern) — so an assigned desk reads as "its agent is here, working".
  // (The agent's desk + seat are resolved by the shared deskPropFor/deskSeat helpers defined further below.)
  function workstationLit(p) {
    if (!p.agentId || !isWorkstationProp(p.t)) return false;
    if (agent && p.agentId === agent.id) return !!agent.working;
    const b = crew.find(x => x.agentId === p.agentId);
    if (!b || !b.working) return false;
    // G0.7 EMPTY-ROOM HONESTY: a bay whose room grants no COMPUTE cannot actually run — its screens
    // stay dark even in the working pose (the run dies at the compute gate; capdenied shows why).
    return computeOkFor(p.agentId);
  }

  // the workstation: the hero's ASSIGNED desk if it placed one, else a 2-wide desk on the spawn room's north wall.
  function placeDesk() {
    blocked = new Set();
    deskPropId = null; deskFace = 'north';
    // 1) the hero's own assigned workstation prop → THAT desk is its seat (it walks here + sits when tasked).
    //    Uses the SAME desk+seat resolver as crew (deskPropFor/deskSeat) so the hero & crew seat identically.
    const home = agent && deskPropFor(agent.id), hs = home && deskSeat(home);
    if (home && hs) {
      desk = { tx: home.x, ty: home.y, w: home.w || 1, h: home.h || 1 }; seat = { tx: hs.tx, ty: hs.ty, cx: hs.cx };
      deskPropId = home.id; deskFace = hs.face;
      for (let dx = 0; dx < (desk.w || 1); dx++) for (let dy = 0; dy < (desk.h || 1); dy++) blocked.add((desk.tx + dx) + ',' + (desk.ty + dy));
      return;   // the placed prop + its chair are drawn by the render loop (skip the synthetic desk/chair)
    }
    // 2) fallback: the auto workstation on the spawn room's north wall, seat one row below.
    const sid = station.spawnRoomId(), z = sid && geo.zones[sid];
    if (!z || (z.x2 - z.x1) < 1 || (z.y2 - z.y1) < 1) { desk = seat = null; return; }
    let dtx = z.x1 + Math.max(1, Math.floor((z.x2 - z.x1) / 2));
    if (dtx + 1 > z.x2) dtx = Math.max(z.x1, z.x2 - 1);
    const dty = Math.min(z.y1 + 1, z.y2 - 1);
    desk = { tx: dtx, ty: dty, w: 2, h: 1 };
    seat = { tx: dtx, ty: Math.min(dty + 1, z.y2), cx: dtx + 0.5 };   // 2-wide desk -> centre sits on the tile seam
    blocked.add(dtx + ',' + dty); blocked.add((dtx + 1) + ',' + dty);
  }
  // walk the hero to its work seat (or snap onto it if unreachable) + enter the 'work' goal — the shared "now sit
  // and work" step, reached EITHER straight from on-duty OR after the conveyor-fetch leg below.
  function goToSeat() {
    agent.goal = 'work';
    if (!seat || !setPathTo({ x: seat.tx, y: seat.ty })) {
      if (seat) { const f = seatFoot(seat); agent.px = f.x; agent.py = f.y; agent.sitting = true; agent.working = true; agent.dir = deskFace || 'north'; }   // face the assigned desk (deskFace) when teleport-fallback seating
    }
  }
  // G4 feature 1: resolve WHERE the permission-blocked hero waits, honestly from the live floor. Reuses the
  // pure WaitAnchor ladder (airlock → mission board → own desk) + PropAnchor's approach-tile law, and clamps
  // the anchor into the agent's zone (wait at the nearest in-zone tile when the anchor is outside its area).
  // Returns { tx, ty, face, source } | null (null → the caller just stands in place at the desk).
  function resolveWaitAnchor() {
    if (typeof WaitAnchor === 'undefined' || !geo) return null;
    const zone = zoneFor(agent);
    // the nearest walkable, in-zone tile to a target — a small expanding-ring scan (no path, just proximity).
    function nearestInZone(tile) {
      if (!tile) return null;
      for (let r = 0; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // ring shell only
        const tx = tile.tx + dx, ty = tile.ty + dy;
        if (geo.walkable(tx, ty, blocked) && tileInZone(zone, tx, ty)) return { tx, ty };
      }
      return null;
    }
    const home = agent && deskPropFor(agent.id), hs = home && deskSeat(home);
    const fallbackSeat = hs ? { tx: hs.tx, ty: hs.ty, face: 'south' } : (seat ? { tx: seat.tx, ty: seat.ty, face: 'south' } : null);
    return WaitAnchor.resolve({
      props: geo.props || [],
      anchorOf: (prop) => (typeof PropAnchor !== 'undefined' ? PropAnchor.deriveAnchor(prop, geo, { approach: 'south', extra: blocked }) : null),
      seat: fallbackSeat,
      zoneAllows: (tx, ty) => tileInZone(zone, tx, ty),
      nearestInZone
    });
  }
  // ENTER the await state: the hero was just blocked on a permission.prompt. Stop working, stand, and (in tick)
  // walk to the resolved wait anchor. Idempotent per prompt — a second prompt for the same promptId is a no-op.
  function enterAwait(prompt) {
    if (!agent || agent.unplaced) return;
    if (awaitPrompt && prompt && awaitPrompt.promptId === prompt.promptId) return;
    awaitPrompt = prompt || { promptId: '' };
    awaitStampAt = (typeof performance !== 'undefined') ? performance.now() : fnow;   // E2: stamp the await TTL
    awaitArrived = false;
    awaitAnchor = resolveWaitAnchor();
    // seize the body out of the desk pose so tick re-paths it to the anchor (mirrors the summon re-seize)
    releaseSeat();
    agent.goal = 'awaitwalk'; agent.sitting = false; agent.working = false; agent.stilling = false;
    agent.usingProp = null; agent.watchProp = null; agent.target = null; agent.pathPts = null;
    agent.pauseUntil = 0; agent.pauseLook = null; agent.state = 'idle';
    if (awaitAnchor) agent.dir = awaitAnchor.face || 'south';
  }
  // CLEAR the await state (permission.response arrived). The run resumes (approve) or ends (deny) server-side;
  // either way the body leaves the anchor. We drop back to the desk-trip: if the run is still live it re-arms
  // 'task' via its next tool call (chat.js walkToDesk); a denied/ended run flips to idle via run.end.
  function clearAwait() {
    if (!awaitPrompt) return;
    awaitPrompt = null; awaitAnchor = null; awaitArrived = false;
    if (agent && (agent.goal === 'awaitwalk' || agent.goal === 'awaiting')) {
      agent.goal = null; agent.target = null; agent.pathPts = null; agent.state = 'idle'; agent.idleUntil = fnow + 200;
    }
  }
  // G4 feature 2: the MISSION BOARD's approach tile (where the agent stands to pin), via the shared anchor law.
  function boardAnchorTile() {
    if (!geo || !geo.props || typeof PropAnchor === 'undefined') return null;
    const board = geo.props.find(p => p && p.t === 'missionboard');
    if (!board) return null;
    const a = PropAnchor.deriveAnchor(board, geo, { approach: 'south', extra: blocked });
    return a ? { tx: a.tx, ty: a.ty, face: a.face } : null;
  }
  // when the pending-proposal count RISES past the mark, send the idle hero to the board to pin (once per new
  // proposal). Gated to a free, idle hero (never interrupts a task/talk/await/leisure walk) — the pin is a
  // projection, not a gate: if the agent is busy the card still shows on the board; the WALK just plays later.
  function maybePinProposal(now, count) {
    if (now - pinCheckAt < 400) return; pinCheckAt = now;
    if (!agent || agent.unplaced) return;
    if ((count | 0) <= pinnedCount) { if ((count | 0) < pinnedCount) pinnedCount = count | 0; return; }   // count dropped (accepted/declined) → lower the mark so a later re-propose re-pins
    // only launch the walk when the hero is genuinely free (idle, not seized, not already pinning)
    if (activity !== 'idle' || awaitPrompt || agent.working || agent.sitting || agent.goal === 'pin') return;
    const tile = boardAnchorTile();
    if (!tile) { pinnedCount = count | 0; return; }   // no reachable board approach → count as pinned (the card still shows), skip the walk
    pinTargetTile = tile;
    agent.goal = 'pin'; agent.usingProp = null; agent.watchProp = null; agent.target = null; agent.pathPts = null;
    agent.sitting = false; agent.working = false; agent.state = 'idle';
    if (!setPathTo({ x: tile.tx, y: tile.ty })) { pinFlourishAt = now; pinnedCount = count | 0; agent.goal = null; }   // unreachable → count it pinned, no walk
  }
  /* TIER D · D5 beat 2 — MISSION-BOARD POST. When the frontend-visible task/mission queue is NON-EMPTY, the board
     is inside the hero's zone, and the hero is idle+free, occasionally (rare, ~2-4 min cooldown) the OVERSEER walks
     to the MISSION BOARD, faces it, and surveys the queue a beat (3-6s) before returning to its business. Rides the
     goal machinery like the 'pin' beat (goal 'post'); it IS a noticeable beat, so it ARMS the D2 station budget on
     fire (armBeat — quieting crew beats in its shadow). It is NOT itself budget-gated: crewBeatDamp returns 1 for
     the hero unconditionally (J1 parity), and this beat is hero-only, so a damp check here would be provably inert
     — its rarity comes from the 2-4 min postCd. Board out-of-zone or absent ⇒ pure no-op (no reach, no exception). The
     queue count is read from missionPinCounts (mpOpen), state the frontend ALREADY holds (QuestStore projection,
     cached 1Hz) — no new bus round-trip (G1). Hero-only: only ever called for `agent`. */
  function maybeBoardPost(now) {
    if (!agent || agent.unplaced) return false;
    if (now < postCd) return false;
    if ((missionPinCounts(now)[0] | 0) <= 0) return false;       // queue empty → the overseer has nothing to survey (no-op; N=1-with-no-queue path draws no further RNG)
    const tile = boardAnchorTile();
    if (!tile) return false;                                     // no board / no reachable approach → no reach (out-of-zone board is caught below via the zone clamp)
    if (!tileInZone(zoneFor(agent), tile.tx, tile.ty)) return false;   // board approach outside the hero's zone → no-op (containment; with crew present the hero may be caged to its own room)
    if (!setPathTo({ x: tile.tx, y: tile.ty })) return false;    // unreachable → skip (leaves postCd untouched; re-considered next idle tick)
    postTargetTile = tile;
    agent.goal = 'post'; agent.usingProp = null; agent.watchProp = null; agent.sitting = false; agent.working = false; agent.stilling = false; agent.state = 'idle';
    // HARD UNTIL (hunt 3): a walk-cap on studyUntil so a board deleted/refit mid-walk (path cleared, arrive never
    // fires) can NEVER strand the 'post' goal — the dwell-release branch frees it by this ceiling even without an
    // arrival. arrive() overwrites this with the real 3-6s survey hold once the board is reached.
    agent.studyUntil = now + 12000;
    postCd = now + U.irnd(120000, 240000);                       // 2-4 min per-hero cooldown
    armBeat(now);                                                // count it against the shared station beat budget (G5)
    if (!agent.target) arrive(now);                             // already standing on the approach tile → survey now
    return true;
  }
  // the hero's ASSIGNED conveyor: a walkable tile beside the BAY bound to this agent (agentId match, so it never
  // reacts to another agent's bay). null = this agent has no conveyor → no fetch leg (straight to work).
  function assignedConveyorTile(aid) {
    if (!geo || !geo.props || !aid) return null;
    const bay = geo.props.find(p => p.t === 'bay' && p.agentId === aid);
    if (!bay) return null;
    const bw = bay.w || 1, bh = bay.h || 1;
    for (let yy = bay.y - 1; yy <= bay.y + bh; yy++)
      for (let xx = bay.x - 1; xx <= bay.x + bw; xx++) {
        if (xx >= bay.x && xx < bay.x + bw && yy >= bay.y && yy < bay.y + bh) continue;   // skip the footprint itself
        if (geo.walkable(xx, yy, blocked)) return { x: xx, y: yy };
      }
    return null;
  }

  function spawnTileLocal() {
    const sid = station.spawnRoomId(), z = sid && geo.zones[sid];
    const cx = z ? ((z.x1 + z.x2) >> 1) : (geo.COLS >> 1);
    const cy = z ? ((z.y1 + z.y2) >> 1) : (geo.ROWS >> 1);
    if (geo.walkable(cx, cy, blocked)) return { x: cx, y: cy };
    for (let r = 1; r < 14; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (geo.walkable(cx + dx, cy + dy, blocked)) return { x: cx + dx, y: cy + dy };
    }
    return { x: cx, y: cy };
  }

  function placeAgent() {
    releaseSeat();   // re-homing → drop any couch seat claim + on-couch render
    const t = spawnTileLocal(), f = footOf(t.x, t.y);
    agent.px = f.x; agent.py = f.y; agent.unplaced = false;
    agent.pathPts = null; agent.target = null; agent.sitting = false; agent.working = false; agent.state = 'idle';
    agent.goal = null; agent.usingProp = null; agent.watchProp = null;
  }

  /* TRANSIT READING (the phantom-teleport fix). A standing body's tile is its position; a WALKING body's
     is not. footOf anchors a foot to the BOTTOM edge of its tile (ly*T + T - 1) while tileOf floors py/T,
     so the straight segment between two perfectly legal feet passes through pixel rows that belong to the
     tile BELOW the destination. Walk from foot(8,4) to foot(7,3) and the interpolated body reports
     8,4 → 7,4 → 7,3 — and if 7,4 holds a blocking prop (the seed floor's bar), this backstop read a
     healthy body as off-floor and re-homed it to the spawn tile mid-stride. That is what the "it
     teleported out of nowhere" report was: not a body in the void, a body between two tiles.
     So: never re-home a body that is following a path. This costs NO coverage, because every way a body
     can actually become stranded ALSO clears its path — an origin shift drops pathPts/target in
     rederive's re-frame block, and a floor reclaimed underfoot re-derives and does the same. A body with
     a live target is walking a route that was validated against this very grid when it was laid, so the
     backstop simply waits one tick for the path to be dropped and then does its job as before. */
  function ensureAgentValid() {
    const cur = tileOf(agent.px, agent.py);
    if (geo.walkable(cur.x, cur.y, blocked)) return;
    if (agent.target) return;   // mid-walk — the tile reading is a transit artefact, not a stranded body (see TRANSIT READING)
    placeAgent();   // floor reclaimed under the agent — re-home to the spawn room
  }

  /* ---------- agent lifecycle ---------- */
  function spawn(a) {
    // a fresh hero body owns a fresh floor: drop EVERY crew body left over from a previous agent on this
    // same page (NEW AGENT keeps this module alive — nothing tears it down). Otherwise the prior agent's
    // SUMMONED crew (which loadStation deliberately preserves) would haunt the newborn's "fresh" station.
    // Safe for RESUME: enterGame re-derives plan crew (syncCrewFromPlan) and re-spawns the rehydrated
    // summoned crew (spawnAgent loop) immediately after this call, so a resumed crew is rebuilt, not lost.
    crew = [];
    occupiedSeats.clear();   // W5: couch-cushion CLAIMS live in this module-level Set, NOT on the body objects we just
                             // dropped — so without this a body lounging at switch time leaks its seatKey forever, and a
                             // reissued prop id (worldmodel _nid reseeds low on a fresh station) collides → a brand-new
                             // couch reads "full" over a physically EMPTY cushion. spawn()-only, same rationale as below.
    // …and with it every other scrap of the PREVIOUS agent's session that lives on this page. These reset
    // here (the per-agent hero (re)spawn), NOT in loadStation — loadStation also runs on a same-agent REFIT,
    // where the running economy/belts MUST persist. spawn() runs only on wake/resume, so a refit is untouched.
    if (floor) floor.reset();           // W1: factory-floor economy (spend/slag/yield) — no inherited numbers on a new HUD
    if (slaglog) slaglog.reset();       // W1: wasted-spend post-mortems
    if (convey) convey.reset();         // W2: drop the prior agent's in-flight belt crates
    chanQueues.clear(); serverLit.clear();   // W3: no phantom backlog gauge / no body stuck "working" from a prior run
    xpAgent = null; xpByAgent.clear();  // W4: name-tag level chip re-seeds from XpStore on enterGame
    levelUpAt = 0; lastSlagAt = -1e9; lastOutboxFlash = -1e9;   // W4: one-shot beats don't replay into the newborn
    agent = {
      id: a.id, name: a.name, color: a.color || '#5ad0ff', skin: a.skin || DATA.DEFAULT_SKIN,
      px: 0, py: 0, dir: 'south', state: 'idle', sitting: false, working: false, unplaced: true,
      // `phase` MUST stay an INTEGER — phaseOf() uses it as a PHASES[] index (world.js ~2660), so a float
      // there indexes undefined and kills the whole idle/mood engine. `aph` is the separate FLOAT sprite
      // offset: b.phase alone is a whole-frame offset, which left every body ticking its walk cycle on the
      // SAME 100ms boundaries (the crew animated in visible lockstep). A fractional offset de-syncs them.
      phase: U.hash(a.id) % 6, aph: (U.hash(a.id) % 600) / 100, target: null, pathPts: null, pathIdx: 0, idleUntil: 0, goal: null, say: { text: '', until: 0 },
      usingProp: null, useUntil: 0, useFace: 'south', useSit: false,  // idle leisure: which prop the agent is at + dwell timer + pose
      watchProp: null,   // lounge: the TV the couch-sitter is watching (kept lit while it watches)
      // seat-on-couch: logical pos stays on the approach tile, but it RENDERS at seat{Px,Py} ON the couch
      seated: false, seatPx: 0, seatPy: 0, seatKey: null, pendSeat: null,
      // awareness & curiosity: head-turn glance (drawBody reads agent.glance), study/observe dwell, fidget + notice cooldowns
      glance: null, glanceCd: 0, nextFidget: 0, studyUntil: 0, noticeCd: 0, studyKey: null,
      summonGlanceCd: 0,   // Tier C / C-Beat1: per-observer refractory so a summon-glance fires once per event, not every frame (runtime-only)
      neighborGlanceCd: 0, // Tier C / C-Beat2: per-body cooldown so two idle neighbors don't re-roll a mutual glance the instant the last lapses (runtime-only)
      // INNER LIFE: a fixed temperament + three slow-draining needs that drive WHICH goal it pursues
      pers: makePersonality(a.id),
      needs: { rest: U.irnd(72, 92), stim: U.irnd(72, 92), social: U.irnd(72, 92) },   // born content; drifts into wants over the first minute
      lastTaskAt: 0, thinkUntil: 0, settleUntil: 0, trackUntil: 0,   // machine-state timers (think-before-work, settle-before-typing, downtime, body-track)
      quirkKind: null,   // which rare quirk is currently playing (drives the gaze flavor in maybeGlance)
      placeTarget: null, removeId: null,   // pending station edit when goal==='place' (add decor at target, or remove its own)
      roundsQueue: null, roundsCd: 0,   // caretaker-lap stop queue + cooldown
      fond: new Map(), revisitCd: 0,   // SPATIAL MEMORY: tileKey -> affection; builds where it dwells, drives revisit-a-haunt + mourning
      pauseUntil: 0, pauseLook: null, pauseCd: 0, yieldCd: 0, lookBackCd: 0,   // CONSIDERED MOVEMENT: brief mid-stroll holds, belt-yield to cargo, the rare double-take
      attn: null, drive: null, driveUntil: 0,   // CONTINUITY OF ATTENTION: the neighbourhood it is currently occupied with (attn) + the drive it is mid-way through satisfying (drive/driveUntil) — see the CONTINUITY block above decideIdle
      stilling: false,   // STILLNESS: true during a real CONTENT=STILL quiet hold (suppresses the ambient swivel + cargo body-track)
      wakePhase: 0,   // FIRST LIGHT: the wake-ritual sub-beat sequencer (driven by studyUntil; reset on exit + on a REFIT drop)
      quirkCd: 0, offbeatCd: 0   // J2: per-body quirk/off-beat gates (read/written via self in maybeQuirk/offbeat) — uniform with the crew init shape; self===agent keeps the hero byte-identical
    };
    self = agent;   // B1: track the hero from birth so engine helpers called BEFORE the first tick (awakening / mouse handlers via setGlance/releaseSeat) act on the hero — self is restored to agent every tick anyway
    if (geo) placeAgent();
  }

  /* a stable temperament derived from the agent id (no RNG — same agent feels the same across a session).
     pace = walk speed; restless = how fast it re-decides + paces; curious/homebody/chatty bias the idle menu + self-talk. */
  function makePersonality(id) {
    const h = s => U.hash(id + ':' + s);
    return {
      pace: 0.88 + (h('pace') % 30) / 100,       // 0.88 .. 1.17
      restless: 0.55 + (h('restless') % 90) / 100, // 0.55 .. 1.44
      curious: 0.45 + (h('curious') % 75) / 100,  // 0.45 .. 1.19
      homebody: 0.45 + (h('homebody') % 75) / 100, // 0.45 .. 1.19
      chatty: 0.55 + (h('chatty') % 70) / 100,    // 0.55 .. 1.24
    };
  }

  function init(canvas) {
    cv = canvas; ctx = cv.getContext('2d');
    resize();
    camUserAt = performance.now();   // boot / a new agent re-arms the cinecam idle clock — the director never fires into a fresh floor
    // resize() preserves the current view (centre-anchored) — never re-fit here, or every
    // COMMS-seam drag tick / fullscreen toggle snaps the Commander's pan/zoom back to fit-all.
    try { if (ro) ro.disconnect(); ro = new ResizeObserver(() => { resize(); redrawNow(); }); ro.observe(cv.parentElement || cv); } catch (e) {}
    // bind the input/visibility handlers + SSE bridge ONCE — init() re-runs on every NEW AGENT (same canvas
    // element), so without this guard each new agent stacked another full set of listeners and SSE streams.
    if (listenersBound) return;
    listenersBound = true;
    window.addEventListener('resize', resize);

    cv.addEventListener('wheel', ev => {
      ev.preventDefault();
      const c = toCanvas(ev), wx = (c.x - panX) / scale, wy = (c.y - panY) / scale;
      scale = clampz(scale * Math.exp(-ev.deltaY * 0.0015), MINZ, MAXZ);
      panX = c.x - wx * scale; panY = c.y - wy * scale;
      camLerp = null; camLock = null; camUserAt = performance.now();   // the user is driving the camera — stop any focus ease, release any follow-lock, reset the cinecam idle clock
    }, { passive: false });
    cv.addEventListener('mousedown', ev => { if (kindleArmed) { kindleHolding = true; return; } camLerp = null; camLock = null; camUserAt = performance.now(); const c = toCanvas(ev); drag = { sx: c.x, sy: c.y, moved: false }; });
    cv.addEventListener('mousemove', ev => {
      if (drag) {
        const c = toCanvas(ev);
        panX += c.x - drag.sx; panY += c.y - drag.sy; drag.sx = c.x; drag.sy = c.y; drag.moved = true;
        cv.style.cursor = 'grabbing'; return;
      }
      const wp = toWorld(ev);
      const nowMs = performance.now();
      // D4: stamp cursorMoveT only on a REAL displacement (> ~half a tile) — a parked-but-jittering cursor is
      // presence (feeds gaze), not "moving" (which lures THE CHASE). Compared against the PREVIOUS lastCursor.
      if (Math.hypot(wp.x - lastCursor.wx, wp.y - lastCursor.wy) > T * 0.5) cursorMoveT = nowMs;
      lastCursor = { wx: wp.x, wy: wp.y, t: nowMs };   // remember where you are — the agent's sense of your presence (feeds gaze)
      const hit = agentHit(wp);
      // rising edge: the HERO notices the Commander's cursor land on IT and turns to meet you.
      // (crew bodies just raise their nameplate on hover — only the hero self-acknowledges)
      if (agent && hit === agent && hoverAgent !== agent && activity === 'idle' && !agent.working) { setGlance('south', 900, performance.now()); curiositySay(SELF_ACK, 0.3, performance.now()); }
      if (hit !== hoverAgent) hoverAgent = hit;
      // belt under the cursor (and no body over it) → arm the hover-glance route tag for the draw pass
      hoverBeltTile = null;
      if (!hit && beltTileSet) { const bt = tileOf(wp.x, wp.y); if (beltTileSet.has(bt.x + ',' + bt.y)) hoverBeltTile = bt; }
      hoverOutbox = hit ? null : outboxAt(wp);   // arm the hover-glance crate tag (a glance, never a window)
      cv.style.cursor = (hit || hoverOutbox || arcadeAt(wp) || missionBoardAt(wp) || trophyCaseAt(wp) || unboundBayAt(wp) || intakeFeedAt(wp)) ? 'pointer' : 'default';   // arcade cabinets + a stacked OUTBOX + the MISSION BOARD + the TROPHY CASE + an unbound BAY + a starved INTAKE are clickable too
    });
    cv.addEventListener('mouseup', ev => {
      if (kindleArmed) { kindleHolding = false; return; }   // releasing during the kindle lets the spark ebb
      const wasDrag = drag && drag.moved; drag = null; cv.style.cursor = 'default';
      if (wasDrag) return;
      const wp = toWorld(ev);
      // a click opens the HERO's console (StationUI.openAgent(0)); keep it hero-only so a crew
      // body's hover nameplate never turns into a wrong-panel open. Crew clicks fall through.
      if (agent && agentHit(wp) === agent) {
        if (activity !== 'task') { agent.dir = 'south'; setGlance('south', 1000, performance.now()); curiositySay(SELF_GREET, 0.8, performance.now()); }   // eye contact for the Commander
        if (onClick) onClick(); return;
      }
      const arc = arcadeAt(wp);
      if (arc && onArcade) { onArcade(arc); return; }
      // G2.3: a stacked OUTBOX is the collect tap — clicking it opens the oldest pending run's review
      const ob = outboxAt(wp);
      if (ob && onOutbox) { onOutbox(ob); return; }
      // G1b: the MISSION BOARD is the quest log's body — clicking it opens the log (never gated, never dead)
      const mb = missionBoardAt(wp);
      if (mb && onMissionBoard) { onMissionBoard(mb); return; }
      // G3b: the TROPHY CASE opens the trophy surface (honest even when empty — it shows dust, never a dead click)
      const tc = trophyCaseAt(wp);
      if (tc && onTrophyCase) { onTrophyCase(tc); return; }
      // an UNBOUND bay's nag says CLICK — the click opens the assign flow (REFIT bay picker), closing the loop
      const ub = unboundBayAt(wp);
      if (ub && onBayAssign) { onBayAssign(ub.id); return; }
      // a NO-FEED intake's nag says CLICK — the click opens the CHANNELS panel (the fix is wiring a feed)
      const inf = intakeFeedAt(wp);
      if (inf && onIntakeFeed) onIntakeFeed(inf.id);
    });
    cv.addEventListener('mouseleave', () => { if (kindleArmed) kindleHolding = false; hoverAgent = null; hoverBeltTile = null; hoverOutbox = null; if (!drag) cv.style.cursor = 'default'; });
    // you just came back to the tab → for a few seconds the agent is likelier to look up and notice you
    try { document.addEventListener('visibilitychange', () => { if (!document.hidden) userReturnUntil = performance.now() + 3000; }); } catch (e) {}
    connectChannelBridge();   // open the SSE bridge so real inbound work animates as boxes on the belts
    pollFeedState();          // feed truth (channels/cron) for the NO FEED intake nag — server-proven, refreshed slowly
    pollShipStats();          // SHIPPED TODAY truth (completed runs since local midnight) — reload-proof
    setInterval(pollFeedState, 60000);   // listenersBound guards init's one-time block, so these arm exactly once
    setInterval(pollShipStats, 60000);
  }

  function resize() {
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    // TEXT SIZE zoom (stationui applySettings sets body.style.zoom): zoom shrinks the canvas's
    // layout px while the painted box stays the same device size, so without this factor the
    // station upscales soft. Multiplying back keeps the bitmap 1:1 with device pixels; mouse
    // mapping is rect-ratio-based (canvasPoint) so it needs no change.
    const uiz = (() => { const z = parseFloat(document.body && document.body.style ? document.body.style.zoom : ''); return z > 0 ? z : 1; })();
    const w = cv.clientWidth || cv.parentElement.clientWidth, h = cv.clientHeight || cv.parentElement.clientHeight;
    const nw = Math.max(1, Math.round(w * dpr * uiz)), nh = Math.max(1, Math.round(h * dpr * uiz));
    if (cv.width === nw && cv.height === nh) return;   // assigning to canvas.width/height WIPES the bitmap even when unchanged — skip the needless clear
    // keep the world point under the canvas centre anchored through the resize (zoom untouched):
    // the view stays put while the stage grows/shrinks around it. Skipped until the first fit
    // has framed the station (fitNeeded) — there's no meaningful view to preserve yet. A fit
    // that landed on a DEGENERATE canvas (boot while the game screen was still hidden → 1px
    // stage) is no view either — re-fit at the first real size instead of anchoring garbage.
    if (!fitNeeded && cache) {
      if (fitW <= 2 || fitH <= 2) fitNeeded = true;
      else { panX += (nw - cv.width) / 2; panY += (nh - cv.height) / 2; }
    }
    cv.width = nw; cv.height = nh;
  }

  // A canvas resize blanks the bitmap, and the repaint only lands on the NEXT rAF — so dragging the
  // COMMS seam (a stream of ResizeObserver hits) strobes the station black. Repaint synchronously in the
  // observer (after layout, before paint) so the new-size frame is on screen this paint, not next. Cancel
  // the queued rAF first so frame()'s own re-schedule doesn't leave two loops running.
  function redrawNow() {
    if (!running || !cache) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    frame(performance.now());
  }

  function start() { if (running) return; running = true; last = performance.now(); frame(last); }
  function stop() { running = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  function wakeIn() { wakeAt = performance.now(); }

  /* ---------- THE AWAKENING — a witnessed birth (cinematic camera + spark + dark->dawn) ----------
     The room opens near-black with the newborn frozen and facing AWAY; a scripted camera pushes in as it
     stirs, holds close through the four self-discovery beats, then pulls back to reveal its whole world at
     dawn. All self-contained + gated to the awakening so it never fights the general camera path. */
  const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const lerpv = (a, b, k) => a + (b - a) * k;
  function camTweenTo(toS, toX, toY, dur, ease, onEnd) {
    camAnim = { fromS: scale, toS: clampz(toS, MINZ, MAXZ), fromX: panX, toX, fromY: panY, toY, t: 0, dur: dur || 1500, ease: ease || easeInOut, onEnd: onEnd || null };
  }
  // a camera target that centers world point (px,py) on screen at zoom sc — 0.46 height leaves headroom above
  function camCenterOn(px, py, sc) { sc = clampz(sc, MINZ, MAXZ); return [sc, cv.width / 2 - px * sc, cv.height * 0.46 - py * sc]; }
  function beginAwakening() {
    // a brand-new birth: wipe any ceremony state a previous agent left on this page so the newborn gets a
    // pristine dark->dawn ritual. Only a real awakening calls this (never a re-bake/refit), so re-arming the
    // once-per-life first-light latch here keeps "a refit never re-arms it" true while fixing NEW AGENT.
    firstWakeDone = false;
    sparkAt = bornAt = dawnAt = truthPulseAt = 0;
    floodAt = floodEndAt = 0; floodStreams = null;
    kindleArmed = false; kindleP = 0; kindleHolding = false; kindlePeak = 0;
    awakeFrozen = true; wakeDark = 0.92; wakeDarkTarget = 0.92; camAnim = null; if (agent) agent.dir = 'north';   // newborn faces AWAY until the Turn
  }
  // setWakeProgress LIFTS the awakening veil — it must never CREATE darkness in a lit room. The deferred
  // interview replays the meeting beats (bumpTruth) during ordinary play, so outside the ceremony
  // (awakeFrozen false) this is a no-op — the veil only moves while a birth/re-wake actually owns the room.
  function setWakeProgress(p) { if (!awakeFrozen) return; p = p < 0 ? 0 : p > 1 ? 1 : p; wakeDarkTarget = 0.92 * (1 - p); }
  function igniteSpark() { sparkAt = performance.now(); bornAt = performance.now(); wakeDark = 0.985; wakeDarkTarget = 0.985; kindleArmed = false; kindleP = 0; }   // the mind catches fire — snap to near-total dark so the spark is the ONLY light (and end any kindle)
  /* THE KINDLING — the pre-ignition beat: one dim, almost-dead ember sits where the mind will be, and the
     user must HOLD to bring it to life. Sustained attention fills kindleP; releasing lets it ebb. When it
     fills, onDone() fires the ignition. A gentle push-in makes the ember intimate while you hold. */
  function armKindle(onDone) {
    kindleArmed = true; kindleP = 0; kindleHolding = false; kindlePeak = 0; kindleDone = onDone || null;
    wakeDark = 0.985; wakeDarkTarget = 0.985;
    if (cache && agent && !agent.unplaced) { const [s, x, y] = camCenterOn(agent.px, agent.py - 4, 2.4); camTweenTo(s, x, y, 1400); }
  }
  function kindleHold(down) { if (kindleArmed) kindleHolding = !!down; }
  function camPushIn() { if (!cache || !agent || agent.unplaced) return; const [s, x, y] = camCenterOn(agent.px, agent.py - 4, 3.2); camTweenTo(s, x, y, 2600); }
  function camCreep() { if (!cache || !agent || agent.unplaced || camAnim || !awakeFrozen) return; const [s, x, y] = camCenterOn(agent.px, agent.py - 4, scale * 1.035); camTweenTo(s, x, y, 600); }   // a hair closer with each truth — ceremony-only (the deferred interview must never steal the live camera)
  function camPunch() { if (!agent || agent.unplaced || camAnim) return; const b = scale; const [s1, x1, y1] = camCenterOn(agent.px, agent.py - 4, b * 1.06); const [s0, x0, y0] = camCenterOn(agent.px, agent.py - 4, b); camTweenTo(s1, x1, y1, 150, t => t, () => camTweenTo(s0, x0, y0, 240)); }   // eyes finding yours
  function camPullBack() { if (!cache) return; const W = cache.W, H = cache.H; const s = clampz(Math.min(cv.width / W, cv.height / H), MINZ, MAXZ); camTweenTo(s, (cv.width - W * s) / 2, (cv.height - H * s) / 2, 1700); }   // recompute fit at fire time -> no jump on release
  // the Turn: the newborn finds the Commander — head leads, then the body pivots north -> side -> south and holds your gaze
  function awakenTurn() {
    if (!agent) return;
    const side = (cache && agent.px > cache.W / 2) ? 'west' : 'east';
    setGlance(side, 650, performance.now());
    setTimeout(() => { if (agent) agent.dir = side; }, 240);
    setTimeout(() => { if (agent) setGlance('south', 700, performance.now()); }, 760);
    setTimeout(() => { if (agent) agent.dir = 'south'; }, 1000);
  }
  function truthPulse() { truthPulseAt = performance.now(); }
  function endAwakening() { wakeDarkTarget = 0; dawnAt = performance.now(); wakeIn(); }   // DAWN: light floods + ripple fires (agent stays frozen/facing-you for the final line)
  function releaseAwakening() { awakeFrozen = false; sparkAt = 0; floodAt = 0; floodEndAt = 0; floodStreams = null; kindleArmed = false; kindleP = 0; kindleHolding = false; armFirstWake(); }   // hand the newborn back to its own autonomous life — and let it have its FIRST LIGHT
  // FIRST LIGHT: arm the once-per-life wake ritual the instant the newborn owns itself. The activity!=='task'
  // guard makes a summon racing the release win cleanly (the ritual simply never arms).
  function armFirstWake() {
    if (firstWakeDone || !agent || agent.unplaced || activity === 'task') return;
    firstWakeDone = true;
    agent.goal = 'firstwake'; agent.wakePhase = 0; agent.dir = 'south'; agent.state = 'idle';
    agent.sitting = false; agent.working = false; agent.stilling = false; agent.usingProp = null; agent.target = null; agent.pathPts = null;
    agent.studyUntil = performance.now() + U.irnd(900, 1400);   // BEAT 0: the held gaze before any motion or words
  }
  /* THE FLOOD — the rush of waking into vast knowledge. A screen-space cascade of streaming phosphor
     tokens (seeded with REAL forming-prompt + capability fragments passed in, padded with glyph noise —
     never fake facts) builds to overwhelming density, then collapseFlood() pulls every glyph inward into
     the newborn's mind. Deterministic per stream after seeding so the frame is stable. */
  const FLOOD_GLYPHS = '01<>/\\{}[]()=+*#%&@|;:.01_-01アイウエオカキクケコ10サシスセソ01';
  function beginFlood(words) {
    floodAt = performance.now(); floodEndAt = 0;
    const pool = (Array.isArray(words) ? words : []).map(s => String(s || '').trim()).filter(Boolean);
    const N = 30, streams = [];
    for (let i = 0; i < N; i++) {
      const len = 9 + Math.floor(Math.random() * 12), toks = [];
      for (let j = 0; j < len; j++) {
        if (pool.length && Math.random() < 0.24) toks.push(pool[Math.floor(Math.random() * pool.length)]);
        else { let s = ''; const gl = 1 + Math.floor(Math.random() * 2); for (let k = 0; k < gl; k++) s += FLOOD_GLYPHS[Math.floor(Math.random() * FLOOD_GLYPHS.length)]; toks.push(s); }
      }
      streams.push({ x: (i + 0.5) / N + (Math.random() - 0.5) * 0.012, speed: 70 + Math.random() * 150, size: 12 + Math.floor(Math.random() * 7), delay: Math.random() * 1100, toks, len });
    }
    floodStreams = streams;
  }
  function collapseFlood() { if (floodAt && !floodEndAt) floodEndAt = performance.now(); }   // pull the cascade inward into the mind
  function refit() { fitNeeded = true; }
  function say(text, opts) {
    if (!agent) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    agent.say = { text: t.slice(0, 160), until: performance.now() + 4200 };
    // ambient station-life remarks are muttered ALOUD too (when the agent has a voice and isn't
    // mid-conversation) so the station feels lived-in. Real replies are spoken by chat.js, not here,
    // so only {ambient:true} lines speak — and pure filler ("...", "hmm") stays a silent bubble.
    if (opts && opts.ambient && typeof Voice !== 'undefined' && Voice.mutter
        && /[a-z]/i.test(t) && !/^h+m+[.…]?$/i.test(t)) {
      Voice.mutter(t);
    }
  }
  /* kind: 'task' (walk to the workstation + work) | 'talk' (face the Commander) | 'idle' (wander the station) */
  /* TIER D · D1 — the Commander's COMMS focus. chat.js calls this with the active stream's agent id on every
     conversation rebind (load(ws)), and null when there's no live conversation. Stores the id ONLY; all the
     stare behavior reads chatFocusId from the idle path. Airtight cleanup: when focus moves off a body (null
     or another id) its next idle decision restores normal wander (decideIdle clears stilling on entry), so no
     stuck stillness / suppressed-forever wander can leak. Unknown / not-yet-spawned id → the resolver no-ops. */
  function setChatFocus(agentId) {
    const next = agentId || null;
    chatFocusId = next;
    // A switch/open IS engagement — warm the (new) focus so the stare holds for a fresh window. When focus
    // moves to another id the old body just lapses (next decideIdle restores its idle life). null → no warmth.
    if (next) warmChatFocus();
  }
  /* D1 WARMTH ping — re-warm the focus so an ACTIVE conversation never goes cold mid-use. Called from chat.js at the
     genuine engagement points (typing at / sending to / a reply-run boundary of the focused stream). Draws a FRESH
     30–90s window (U.irnd — deterministic-lint-safe) so the lose-interest moment stays unpredictable; no-ops when
     there's no live focus (so pinging a closed panel is inert). */
  function warmChatFocus() { chatWarmUntil = fnow + U.irnd(CHAT_WARM_MIN, CHAT_WARM_MAX); }
  function chatFocusPing() { if (chatFocusId) warmChatFocus(); }
  // the body (hero or crew) the Commander is chatting with, or null. bodyForAgent maps 'agent'→hero + crew by id.
  function chatFocusBody() { return chatFocusId ? bodyForAgent(chatFocusId) : null; }
  /* chatHot — THE single predicate for "the chat-stare is actually engaged": a focus is set AND the conversation
     is still WARM. Every call site that means "this body is (or should be) held by the stare" keys on THIS
     (chatStareHold's own gate, the socialEligible/cursorBeatEligible exclusions, encounterBroken, sweepChase) so
     the definition can never drift apart. COMMS focus never clears in practice (persistent panel), so keying any
     of those on focus ALONE would permanently bar the focused body from social/mimic/chase after warmth lapses —
     hot-focus is the real "held" condition. RNG-free: reads module state + `now` only. */
  function chatHot(now) { return chatFocusId != null && now < chatWarmUntil; }

  function setActivity(kind) {
    activity = kind;
    if (!agent) return;
    if (kind === 'talk') { releaseSeat(); agent.target = null; agent.pathPts = null; agent.state = 'idle'; agent.sitting = false; agent.working = false; agent.goal = null; agent.usingProp = null; agent.watchProp = null; agent.dir = 'south'; }
  }

  /* ---------- camera helpers ---------- */
  // ease the camera to frame the agent for a one-on-one voice conversation — but only NUDGE: bail if he's
  // already comfortably on-screen and not tiny, so it never fights a deliberate pan/zoom. Self-cancels on
  // manual input (wheel/drag clear camLerp). Called from chat.js when a spoken turn begins.
  function focusAgent(opts) {
    if (!agent || agent.unplaced || !cache) return;
    opts = opts || {};
    const sx = agent.px * scale + panX, sy = agent.py * scale + panY;
    const margin = 48;
    const onScreen = sx > margin && sx < cv.width - margin && sy > margin && sy < cv.height - margin;
    const small = scale < 2.2;
    if (onScreen && !small && !opts.force) return;
    const target = clampz(Math.max(scale, 3), MINZ, MAXZ);
    camLerp = { scale: target, panX: cv.width / 2 - agent.px * target, panY: cv.height * 0.56 - agent.py * target };
  }
  // frame the camera on ANY body (hero or a summoned crew member) — used when COMMS focus switches agents.
  function focusBody(id) {
    const b = bodyForAgent(id) || agent;
    if (!b || b.unplaced || !cache) return;
    const bx = (b.seated ? b.seatPx : b.px), by = (b.seated ? b.seatPy : b.py);
    const target = clampz(Math.max(scale, 3), MINZ, MAXZ);
    camLerp = { scale: target, panX: cv.width / 2 - bx * target, panY: cv.height * 0.56 - by * target };
  }
  // FOLLOW-LOCK the camera on one agent's body — the SESSION-SELECT camera contract: picking a session with an
  // agent locks the feed onto that agent immediately (no idle wait) and TRAILS it as it moves, until the
  // Commander grabs the camera (wheel/drag/click → the input handlers release the lock). One-shot focusBody
  // stays for programmatic reframes (boot restore, delete-fallback) — lockBody is only armed by a USER selection.
  function lockBody(id) {
    const b = bodyForAgent(id) || agent;
    if (!b || b.unplaced || !cache || camAnim || awakeFrozen) return;   // nothing to frame yet / the scripted awakening camera owns the transform
    camLerp = null;
    camLock = { id: (b.agentId || b.id), sc: clampz(Math.max(scale, 3), MINZ, MAXZ), source: 'session' };
  }
  /* ---------- IDLE CINECAM — the security-feed auto-director ----------
     After cineIdleMs of true hands-off the camera starts hunting the floor's own life: it follow-locks a
     WALKING body and trails it; if its subject settles and someone ELSE is moving it cuts there; when nothing
     moves it drifts between the crew in calmer, wider shots. Strictly subordinate: a 'session' lock owns the
     camera outright, any user camera input kills the shot instantly (the input handlers null camLock and
     re-stamp camUserAt), the scripted awakening camera always wins, and reduced-motion users never get a
     self-panning camera. Runs once per frame from the camera block — every branch below is O(bodies). */
  function cinecamTick(now) {
    if (camLock && camLock.source !== 'cine') return;                             // an explicit session lock owns the camera
    // NOTE: no document.hidden gate — the rAF loop already pauses in hidden tabs, and embedded webviews
    // (the preview harness, some Tauri states) report hidden while still rendering, which would dead-gate this.
    if (camAnim || awakeFrozen || !cache || reduceMotion() || now - camUserAt < cineIdleMs) {
      if (camLock) camLock = null;                                                // conditions lapsed mid-shot → release; the manual camera resumes untouched
      return;
    }
    const cands = [];
    if (agent && !agent.unplaced) cands.push(agent);
    for (const b of crew) if (b && !b.unplaced) cands.push(b);
    if (!cands.length) { if (camLock) camLock = null; return; }
    const walkers = cands.filter(b => b.state === 'walk');
    const cur = camLock ? bodyForAgent(camLock.id) : null;
    if (cur && cur.state === 'walk') cineWalkAt = now;
    // hold the shot while it's alive: the subject exists, its hold window is open, and it hasn't gone still
    // for >3s while someone ELSE moves (movement is the whole point — cut to it)
    const recast = !cur || now >= cineHoldUntil || (cur.state !== 'walk' && now - cineWalkAt > 3000 && walkers.length > 0);
    if (!recast) return;
    // cast the next shot: movement first — prefer a DIFFERENT walker (variety), and the COMMS-focused agent's
    // movement wins the tie. Nothing moving anywhere → a calmer, wider drift onto someone idle.
    const others = walkers.filter(b => b !== cur);
    const pool = others.length ? others : walkers;
    let next = null, moving = false;
    if (pool.length) { next = (chatFocusId && pool.find(b => (b.agentId || b.id) === chatFocusId)) || pool[U.irnd(0, pool.length - 1)]; moving = true; }
    else { const rest = cands.filter(b => b !== cur); const p2 = rest.length ? rest : cands; next = p2[U.irnd(0, p2.length - 1)]; }
    if (!next) return;
    camLerp = null;
    camLock = { id: (next.agentId || next.id), sc: clampz(moving ? U.irnd(26, 30) / 10 : U.irnd(20, 24) / 10, MINZ, MAXZ), source: 'cine' };
    cineWalkAt = now;
    cineHoldUntil = now + (moving ? U.irnd(9000, 16000) : U.irnd(6000, 11000));
  }
  const cameraMode = () => camLock ? (camLock.source === 'cine' ? 'auto' : 'lock') : 'manual';   // HUD/verify truth: what drives the camera RIGHT NOW
  function setCinecamIdle(ms) { cineIdleMs = Math.max(1000, +ms || CINE_IDLE_MS); }               // DEV knob (console/verify only): shrink the hands-off threshold; floor 1s
  function fitCamera() {
    if (!cache) return;
    const W = cache.W, H = cache.H;
    scale = clampz(Math.min(cv.width / W, cv.height / H), MINZ, MAXZ);
    panX = (cv.width - W * scale) / 2; panY = (cv.height - H * scale) / 2;
    fitW = cv.width; fitH = cv.height;   // remember the size this fit framed — resize() treats a degenerate-size fit as "never fit"
  }
  function toCanvas(ev) {
    const r = cv.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (cv.width / r.width), y: (ev.clientY - r.top) * (cv.height / r.height) };
  }
  function toWorld(ev) { const c = toCanvas(ev); return { x: (c.x - panX) / scale, y: (c.y - panY) / scale }; }
  // the nearest PLACED body under the cursor — the hero (Overseer) OR any crew/summoned body —
  // returned as the body itself (so the hover nameplate can tag whichever one), else null.
  function agentHit(wp) {
    let best = null, bestD = 14 * 14;
    const consider = b => {
      if (!b || b.unplaced) return;
      const dx = wp.x - bodyPosX(b), dy = wp.y - bodyPosY(b);
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = b; }
    };
    consider(agent);
    for (const b of crew) consider(b);
    return best;
  }

  /* ---------- pathing + behaviour ---------- */
  function setPathTo(dest) {
    self.pathPts = null; self.target = null; self.glance = null;
    if (!dest || !geo) return false;
    const cur = tileOf(self.px, self.py);
    const blockers = movementBlockers(self, blocked);
    if (tileBlockedFor(blockers, dest.x, dest.y)) return false;
    // prop awareness: prefer a route that steps around walkable machinery/decor (soft no-tread set),
    // fall back to the plain route when the soft set is the only way through (or the dest sits on it)
    const p = geo.path(cur.x, cur.y, dest.x, dest.y, movementBlockers(self, beltUnion()))
      || geo.path(cur.x, cur.y, dest.x, dest.y, blockers);
    if (!p) return false;
    self.pathPts = p; self.pathIdx = 0; self.state = 'walk';
    nextWaypoint();
    intentTell(dest);   // LEGIBILITY: an idle-life walk turns to face where it is going before the first step
    return true;
  }
  function nextWaypoint() {
    if (!self.pathPts || self.pathIdx >= self.pathPts.length) { self.target = null; return; }
    const wp = self.pathPts[self.pathIdx++];
    self.target = footOf(wp.x, wp.y);
    maybeStrollBeat();   // CONSIDERED MOVEMENT: a casual stroll occasionally hesitates / doubles back — not a sprite on rails
  }
  /* ---------- THE INTENT TELL (legibility, NOT a new beat) ----------
     An idle body used to decide and step off in the SAME frame, so the decision was invisible: the viewer saw
     translation, never intent, and a fully-reasoned move (the want engine always has a reason) read as drift.
     Now the instant an idle-life walk commits, the body turns to FACE where it is going and holds a short beat
     before the first step — "it looked at the couch, then went to the couch." It adds NO new behaviour and
     spends NO rarity budget: it reuses the CONSIDERED-MOVEMENT hold (pauseUntil/pauseLook), which both walk
     steppers already honour and which every seize path (summon / refit / await / encounter-break) already
     clears — so nothing can deadlock on it that could not already deadlock on a double-take.
     NEVER on a purposeful walk. A summon, an approval walk, a chase, or a social rendezvous must leave
     INSTANTLY: hesitation there reads as lag, not thought. The exclusions test live plan objects
     (self.social / self.chase) rather than self.goal, because most idle planners set `goal` only AFTER
     setPathTo returns — a goal test here would read the PREVIOUS goal and miss. Determinism: U.irnd only. */
  const NO_TELL = { summon: 1, fetch: 1, work: 1, awaitwalk: 1, awaiting: 1, chase: 1, social: 1, firstwake: 1 };
  function intentTell(dest) {
    if (!self || self.unplaced || self.working || self.social || self.chase) return;
    if (self === agent && (activity !== 'idle' || awaitPrompt)) return;   // hero on task / blocked on approval — go now
    if (NO_TELL[self.goal]) return;
    const now = fnow;
    if (now < (self.pauseUntil || 0)) return;   // a stroll beat (double-take / belt-yield) already owns this hold — never stomp it
    self.dir = dirToward(self.px, self.py, (dest.x + 0.5) * T, (dest.y + 0.5) * T);
    self.pauseUntil = now + U.irnd(240, 480);
    self.pauseLook = 'intent';   // the walk steppers only re-aim the facing for 'back'/'cargo', so 'intent' simply HOLDS the facing set above
  }
  const OPP = { north: 'south', south: 'north', east: 'west', west: 'east' };
  // only while casually wandering (never a summon/goal walk): a brief considered pause, or the rare eerie double-take
  function maybeStrollBeat() {
    if (!self || self.goal != null || ((self === agent) && activity !== 'idle') || self.unplaced) return;
    const now = fnow;
    if (now < (self.pauseCd || 0)) return;
    // D2 (G5): station budget — a CREW stroll-beat roll is hard-gated (damp=0) while the station gate holds (no-op for the hero).
    const damp = crewBeatDamp(now);
    // THE DOUBLE-TAKE (rare): stop and turn to look back the way it came, as if something caught its attention
    if (now >= (self.lookBackCd || 0) && U.chance(0.045 * (self.pers ? self.pers.curious : 1) * damp)) {
      self.pauseUntil = now + U.irnd(900, 1700); self.pauseLook = 'back';
      self.pauseCd = now + U.irnd(9000, 16000); self.lookBackCd = now + U.irnd(50000, 95000);
      armBeat(now);   // the double-take is a noticeable beat — count it against the station budget
      curiositySay(['hm?', '...', 'did something move', 'thought i saw something'], 0.22, now);
      return;
    }
    // a considered pause mid-stroll: a beat of weight, then on it goes (rarer now — a stroll shouldn't be peppered with stutters)
    if (U.chance(0.07 * damp)) { self.pauseUntil = now + U.irnd(320, 720); self.pauseLook = null; self.pauseCd = now + U.irnd(10000, 18000); armBeat(now); }
  }
  // active cargo passing right in front of it while it walks → wait a beat and let it go by (belt-yield)
  function shouldYieldToCargo() {
    if (!convey || !agent.target) return false;
    const box = nearestBox();
    if (!box) return false;
    // a box is right here (≈1.2 tiles) — either on top of the agent or about to occupy the tile it's stepping toward
    const dxT = box.x - agent.target.x, dyT = box.y - agent.target.y;
    return box.d < 15 || Math.hypot(dxT, dyT) < 15;
  }
  // a quick 2-beat settle-scan (left, then right) before committing the gaze to finalDir — reads as deliberate "taking it in"
  function scanThen(now, finalDir) {
    const body = self;   // B1: capture the scheduling body — the setTimeout closures must animate THIS body, not whatever `self` points to at fire time (self is restored to agent each tick)
    const guard = () => body && (body.goal === 'inspect' || body.goal === 'watch');
    const sides = U.chance(0.5) ? ['west', 'east'] : ['east', 'west'];
    if (body) body.glance = { dir: sides[0], until: now + 380 };
    setTimeout(() => { if (guard()) body.glance = { dir: sides[1], until: performance.now() + 380 }; }, 420);
    setTimeout(() => { if (guard()) { body.glance = null; body.dir = finalDir; } }, 860);
  }
  function arrive(now) {
    self.pathPts = null; self.target = null; self.pauseUntil = 0; self.pauseLook = null; self.stilling = false;
    if (self.goal === 'firstwake') { self.state = 'idle'; return; }   // the wake ritual self-drives via stepFirstWake; the rare 'find feet' arrival is a no-op
    // G4 feature 1: reached the WAIT ANCHOR — stand, face the anchor, and latch the waiting pose (the tag + the
    // eerie weight-shift render off awaitArrived). No dwell timer: it waits until permission.response clears it.
    if (self.goal === 'awaitwalk' || self.goal === 'awaiting') { self.goal = 'awaiting'; self.sitting = false; self.working = false; self.state = 'idle'; self.dir = (awaitAnchor && awaitAnchor.face) || 'south'; awaitArrived = true; return; }
    // G4 feature 2: reached the MISSION BOARD to pin a proposal — face it, play the pin flourish, raise the
    // high-water mark (so this proposal never re-triggers the walk), then drift back to wandering.
    if (self.goal === 'pin') {
      self.sitting = false; self.working = false; self.state = 'idle'; self.dir = (pinTargetTile && pinTargetTile.face) || 'north';
      pinFlourishAt = now;
      if (typeof AutoJobStore !== 'undefined' && AutoJobStore.pendingCount) pinnedCount = AutoJobStore.pendingCount();
      self.goal = null; self.idleUntil = now + U.irnd(600, 1400);
      curiositySay(['pinned.', 'left it on the board', 'proposal up', 'for you to weigh'], 0.5, now);
      return;
    }
    // TIER D · D5 beat 2: reached the MISSION BOARD to SURVEY the queue — face it and HOLD 3-6s (a real read of the
    // board, not the pin's instant flourish), then the tick ladder ('post' dwell-release) drifts back to wandering.
    if (self.goal === 'post') {
      self.sitting = false; self.working = false; self.state = 'idle'; self.dir = (postTargetTile && postTargetTile.face) || 'north';
      self.glanceCd = 0; self.studyUntil = now + U.irnd(3000, 6000);
      curiositySay(['reviewing the queue', 'what needs doing', 'the board', 'checking the docket', 'surveying the work'], 0.4, now);
      return;
    }
    const FOND = { lounge: 3, use: 2, gaze: 1.5, tend: 1.5, inspect: 1, watch: 1, rounds: 0.5, revisit: 0.6 };
    if (FOND[self.goal]) { noteFond(now, FOND[self.goal]); noteAttn(now); }   // dwelling somewhere by choice deepens attachment to that tile — and anchors the neighbourhood it is currently occupied with
    // SIT ON THE CHAIR, NOT ON THE TILE. The walk target is the seat's whole TILE (pathing needs one),
    // but on an even-width desk the chair is rendered on the CENTRED fractional x (seat.cx) — so a body
    // that merely finished its walk stands at the tile centre, half a tile off the chair it is supposed
    // to be sitting in. Snap onto seatFoot here, the same anchor drawSeatChair uses, so arriving on foot
    // lands exactly where the teleport-fallback seating already did. Body moves; the chair does not.
    if (self.goal === 'work') { if (self === agent && seat) { const f = seatFoot(seat); self.px = f.x; self.py = f.y; } self.sitting = true; self.working = false; self.dir = deskFace || 'north'; self.state = 'idle'; self.settleUntil = now + U.irnd(450, 900); }   // sit a beat (loading context) before the screens light + typing starts
    else if (self.goal === 'use') { self.sitting = self.useSit; self.working = false; self.dir = self.useFace; self.state = 'idle'; self.useUntil = now + U.irnd(10000, 22000); takeSeat(); if (self.useSit && self.needs.rest < 35) curiositySay(SELF_REST, 0.4, now); }
    else if (self.goal === 'lounge') {
      // settled ON the couch, watching the paired TV — sit, face the screen, a longer dwell than a one-off prop
      self.sitting = true; self.working = false; self.dir = self.useFace; self.state = 'idle';
      self.useUntil = now + U.irnd(18000, 30000); self.glanceCd = 0; self.nextFidget = now + U.irnd(1500, 3500);
      takeSeat(); curiositySay(self.needs.rest < 35 ? SELF_REST : CURIO_WATCH, 0.45, now);
    }
    else if (self.goal === 'inspect' || self.goal === 'watch' || self.goal === 'tend' || self.goal === 'gaze' || self.goal === 'quirk' || self.goal === 'stare') {
      // reached the thing — stand, face it, observe for a spell. Familiar things hold the gaze less (habituation).
      self.sitting = false; self.working = false; self.dir = self.useFace || 'south'; self.state = 'idle';
      self.glanceCd = 0; self.nextFidget = now + U.irnd(700, 1600);
      if (self.goal === 'quirk' || self.goal === 'stare') { const base = self.quirkKind === 'vigil' ? U.irnd(12000, 26000) : U.irnd(4000, 9000); self.studyUntil = now + offbeat(now, base); return; }   // a walked quirk (face-a-wall) or the VIGIL: hold the pose, silent — vigil holds far longer
      const fam = self.studyKey ? (seenCount.get(self.studyKey) || 0) : 0, famK = 1 / (1 + fam * 0.8);
      if (self.studyKey) seenCount.set(self.studyKey, fam + 1);
      if (self.goal === 'tend') { self.studyUntil = now + offbeat(now, U.irnd(3500, 8000)); curiositySay(self.needs.social < 30 ? SELF_TEND : SELF_QUIET, 0.5, now); }
      else if (self.goal === 'gaze') { self.studyUntil = now + offbeat(now, U.irnd(4000, 8000)); curiositySay(SELF_CONTEMPLATE, 0.5, now); }
      else if (self.goal === 'watch') { self.studyUntil = now + U.irnd(6000, 14000) * famK; curiositySay(CURIO_WATCH, 0.5 * famK, now); if (U.chance(0.5)) scanThen(now, self.useFace); }
      else { self.studyUntil = now + U.irnd(2600, 6000) * famK; curiositySay(self.inspectNovel ? CURIO_NEW_PROP : CURIO_STUDY, (self.inspectNovel ? 0.7 : 0.55) * famK, now); if (U.chance(0.55)) scanThen(now, self.useFace); }
    }
    else if (self.goal === 'rounds') {
      // a stop on the caretaker lap — face it, a brief ownership beat, then tick advances to the next stop.
      // D5 beat 1: a SUPERVISOR stop (behind a working crew body) gets the same brief 1.5-3s hold (a glance, not
      // the D3 watch's 3-7s study) — the shorter hold IS the supervisor's-glance vs a peer's-watch distinction —
      // with an over-the-shoulder flavor line instead of the ownership beat.
      self.sitting = false; self.working = false; self.dir = self.useFace || 'south'; self.state = 'idle';
      self.glanceCd = 0; self.studyUntil = now + U.irnd(1500, 3000);
      curiositySay(self.roundsSup ? SELF_SUPERVISE : SELF_ROUNDS, 0.4, now);
      self.roundsSup = false;
    }
    else if (self.goal === 'mourn') {
      // stands where its thing used to be — a long, near-silent beat (the off-beat duration is the unsettling part)
      self.sitting = false; self.working = false; self.dir = self.useFace || 'south'; self.state = 'idle';
      self.glanceCd = now + 1500; self.studyUntil = now + U.irnd(11000, 22000); curiositySay(MOURN_LINE, 0.4, now);
    }
    else if (self.goal === 'revisit') {
      // back at a favorite haunt, just being there a while
      self.sitting = false; self.working = false; self.dir = self.useFace || 'south'; self.state = 'idle';
      self.glanceCd = 0; self.studyUntil = now + U.irnd(5000, 11000); curiositySay(REVISIT_LINE, 0.35, now);
    }
    else if (self.goal === 'place') {
      // it acts on the station: drops a piece of its OWN decor on the empty tile, or removes one it placed before
      self.sitting = false; self.working = false; self.state = 'idle'; self.dir = self.useFace || 'south';
      if (self.placeTarget && station.addProp) {
        const tg = self.placeTarget, res = station.addProp({ t: tg.t, x: tg.x, y: tg.y, w: 1, h: 1, block: false });
        if (res && res.ok) { agentDecor.push(res.id); ownPlaced.add(res.id); if (seenProps) seenProps.add(res.id); curiositySay(SELF_PLACE, 0.6, now); }   // suppress self-novelty so it doesn't go inspect its own work
      } else if (self.removeId && station.removeProp) {
        station.removeProp(self.removeId); const i = agentDecor.indexOf(self.removeId); if (i >= 0) agentDecor.splice(i, 1); curiositySay(SELF_PLACE, 0.4, now);
      }
      self.placeTarget = null; self.removeId = null; self.goal = null; self.idleUntil = now + U.irnd(900, 2000);
    }
    else if (self.goal === 'social') { self.state = 'idle'; self.target = null; self.pathPts = null; }   // TIER D · D3: reached a social waypoint — stay on goal='social'; stepSocial enters the hold next tick
    else if (self.goal === 'chase') { self.state = 'idle'; self.target = null; self.pathPts = null; }    // TIER D · D4: reached a pursuit leg — stay on goal='chase'; stepChase repaths (or enters the stare) next tick
    else { self.state = 'idle'; self.idleUntil = now + U.irnd(1600, 3600); }
  }
  /* ---------- CONTINUITY OF ATTENTION (the anti-aimlessness fix) ----------
     `wander` samples a UNIFORMLY RANDOM tile of the whole zone, and every idle decision re-rolls from
     scratch — so consecutive strolls ping-ponged across the station and the body never appeared to be
     occupied with anything. That, not a shortage of behaviours, is what reads as aimless.
     An ATTENTION ANCHOR fixes it without adding a single beat: whenever the body chooses to dwell
     somewhere (the same moment `fond` accrues — arrive()'s FOND table), it remembers that tile for a
     while. While the anchor is live, a stroll stays in THAT NEIGHBOURHOOD; when it lapses the body is
     free again and relocates. The result is "explores a corner for a bit, then moves on" instead of
     teleport-tier target picking — one place at a time, which is what having a mind looks like.
     Deliberately SHORT (~25-45s) and never refreshed by wandering itself, so it can't become a leash:
     a body that stops choosing to dwell always drifts free. Determinism: U.irnd only. */
  const ATTN_R = 5;   // tiles: the radius of the neighbourhood a live anchor holds a stroll inside
  function noteAttn(now) {
    if (!self) return;
    const t = tileOf(self.px, self.py);
    self.attn = { x: t.x, y: t.y, until: now + U.irnd(25000, 45000) };
  }
  function wander(now) {
    const rects = geo.allRects;
    if (!rects.length) { self.idleUntil = now + 800; return; }
    const cur = tileOf(self.px, self.py);
    const avoid = beltUnion();   // desk footprint + belt tiles: an idle stroll should step AROUND the machinery
    const zone = zoneFor(self);   // P1: a stroll stays inside the body's own zone
    const attn = (self.attn && now < self.attn.until) ? self.attn : null;   // occupied with a neighbourhood? keep the stroll there
    for (let i = 0; i < 24; i++) {
      // While an anchor is live the first two-thirds of the tries sample its neighbourhood; the tail falls
      // back to the free station-wide pick so a walled-in / exhausted anchor can NEVER strand the stroll.
      // Out-of-bounds samples are impossible to act on — geo.walkable range-checks before anything else.
      let x, y;
      if (attn && i < 16) { x = attn.x + U.irnd(-ATTN_R, ATTN_R); y = attn.y + U.irnd(-ATTN_R, ATTN_R); }
      else { const r = rects[U.irnd(0, rects.length - 1)]; x = U.irnd(r.x1, r.x2); y = U.irnd(r.y1, r.y2); }
      if (!tileInZone(zone, x, y)) continue;                 // off-zone target — never stroll out of the body's area
      if (!geo.walkable(x, y, blocked)) continue;
      if (avoid.has(x + ',' + y)) continue;                  // don't stroll to a belt tile
      const avoidLive = movementBlockers(self, avoid);
      const blockedLive = movementBlockers(self, blocked);
      if (tileBlockedFor(blockedLive, x, y)) continue;
      let p = geo.path(cur.x, cur.y, x, y, avoidLive);       // prefer a belt/body-free route
      if (!p) p = geo.path(cur.x, cur.y, x, y, blockedLive); // fall back: a belt bridges the only way across
      if (p && p.length) { self.goal = null; self.pathPts = p; self.pathIdx = 0; self.state = 'walk'; nextWaypoint(); return; }
    }
    self.idleUntil = now + 800;
  }

  /* desk footprint ∪ all belt tiles ∪ non-blocking prop footprints — the soft no-tread set.
     Non-blocking props (bays, inbox/outbox chutes, filters, dropped decor) stay WALKABLE — bodies
     dock on bay tiles, airlocks are doors — but a body with prop awareness steps AROUND the
     machinery when any other route exists. Rugs and airlocks are meant to be crossed; skip them. */
  const SOFT_CROSS = new Set(['rug', 'airlock']);
  function beltUnion() {
    const s = new Set(blocked);
    const belts = (geo && geo.belts) || [];
    for (const b of belts) s.add(b.x + ',' + b.y);
    const props = (geo && geo.props) || [];
    for (const p of props) {
      if (p.block !== false || SOFT_CROSS.has(p.t)) continue;   // blocking props are already hard-blocked in geo.walkable
      for (let dy = 0; dy < (p.h || 1); dy++) for (let dx = 0; dx < (p.w || 1); dx++) s.add((p.x + dx) + ',' + (p.y + dy));
    }
    return s;
  }

  /* ---------- IDLE ZONE (P1: cage every hero idle picker to the agent's own area) ----------
     A "zone" is the area a body may ROAM while idle, DERIVED on the fly from the room rects +
     props the world already holds (never persisted — shared/events.js/schema.js untouched). It is
     the room enclosing the body's assigned workstation/bay; a leash radius if it sits on open floor;
     null if it has no assignment (then it does not roam). The pure geometry lives in app/zones.js
     (window.Zones), unit-tested headlessly; this thin wrapper just resolves the anchor + room rects
     from `geo` for a given body. Guarded on `typeof Zones` (mirrors the PropAnchor/Conveyor guards)
     so a missing module degrades to "no zone object" rather than a hard error mid-tick.

     INVARIANT I2 (HERO PARITY) / A3 (SOLE OWNERSHIP): when one agent effectively owns the space
     (`soleOwner(body)` — no other bound bay/crew body), its zone WIDENS to the union of every room
     rect (the whole reachable floor = the exact geo.allRects set the pre-change pickers drew from),
     so EVERY previously-valid cross-room target stays in-zone and the 8 sentience passes are
     unchanged — even in a multi-room built-out solo station where the desk room is only ONE room.
     This is the real condition (sole-ownership widening), not "the desk room spans the station"
     (which only holds for a fresh single-room floor). Multi-room lane discipline (caging each body
     to its own room) is the intended NEW behavior ONLY once more than one agent shares the floor.

     anchorFor(body): the body's own workstation/bay foot tile — its STABLE home (never its transient
     px/py, so the zone doesn't drift as it walks). Hero falls back to the module `seat` (its synthetic
     desk) when it has no placed workstation prop; crew resolve purely via deskPropFor/bay (P2/P3). */
  function anchorFor(body) {
    if (!geo) return null;
    const aid = body && body.id;
    const dp = aid && deskPropFor(aid);
    if (dp) return { x: dp.x, y: dp.y };
    if (aid && geo.props) { const bay = geo.props.find(p => p.t === 'bay' && p.agentId === aid); if (bay) return { x: bay.x, y: bay.y }; }
    if (body === agent && seat) return { x: seat.tx, y: seat.ty };   // hero on the synthetic auto-desk
    // A2 leash fallback: a PLACED crew body with no workstation/bay (the common freshly-summoned worker
    // before the user assigns it a PC) anchors on its OWN foot tile, so zoneFor yields a bounded leash
    // around its spawn spot instead of null — keeping it alive (BR-4 'summoned agents move') without
    // letting it roam the whole floor. Unplaced/dormant bodies still return null (A2: no zone, no roam).
    if (body && body.crewBody && !body.unplaced) return body.home ? { x: body.home.x, y: body.home.y } : tileOf(body.px, body.py);
    return null;
  }
  /* soleOwner(body): does this body effectively own the WHOLE station (so its zone must widen to
     the whole floor per A3/I2)? True when no OTHER placed body shares the floor — i.e. every crew
     body is unplaced (dormant at spawn, occupying nothing). The lone hero in a built-out multi-room
     station is the realistic solo case: caging it to its desk room would strip previously-valid
     cross-room idle targets (the I2 regression). When ANY other body is placed, lane discipline
     kicks in and each body is caged to its own room. The hero is the only sole-owner candidate;
     a crew body is, by definition, never alone while the hero is on the floor. */
  function soleOwner(body) {
    if (body !== agent) return false;                 // only the hero can solely own the floor
    if (agent && agent.unplaced) return false;        // an unplaced hero owns nothing
    return crew.every(b => b && b.unplaced);          // no OTHER placed body shares the station
  }
  function zoneFor(body) {
    if (typeof Zones === 'undefined' || !geo) return null;
    return Zones.computeZone({ rects: geo.allRects, props: geo.props, agentId: body && body.id, anchorTile: anchorFor(body), solo: soleOwner(body) });
  }
  // membership shorthands — a null zone admits NOTHING (the body has no roam area → fall through to
  // an in-place beat). When Zones is absent the wrapper returns null; treat that as "uncaged" so a
  // module load failure can never freeze the agent — true(in-zone) for every tile.
  function tileInZone(zone, tx, ty) { return (typeof Zones === 'undefined') ? true : Zones.inZone(zone, tx, ty); }
  function movementBlockers(body, base) {
    const s = new Set(base || []);
    const mark = (b) => {
      if (!b || b === body || b.unplaced) return;
      const t = tileOf(b.px, b.py);
      s.add(t.x + ',' + t.y);
      if (b.target) {
        const tt = tileOf(b.target.x, b.target.y);
        s.add(tt.x + ',' + tt.y);
      }
    };
    mark(agent);
    for (const b of crew) mark(b);
    return s;
  }
  function tileBlockedFor(blockers, tx, ty) {
    return blockers && blockers.has(tx + ',' + ty);
  }

  /* ---------- crew movement helper ----------
     A crew body walks to its assigned chair when working (stepCrewToSeat below). When NOT working it now runs the
     HERO's full sentience engine per-body (crewEngineStep, Tier B2) instead of the old light crewWander stepper —
     so an idle crew body has needs/temperament/want-engine/quirks, caged to its own zone, not just a random stroll.
     crewNextWaypoint is the path-stepper the working-path (stepCrewToSeat) still uses. */
  function crewNextWaypoint(b) {
    if (!b.pathPts || b.pathIdx >= b.pathPts.length) { b.target = null; return; }
    const wp = b.pathPts[b.pathIdx++];
    b.target = footOf(wp.x, wp.y);
  }
  /* a working crew body walks to the chair in front of its assigned desk and sits facing it — the hero's exact
     desk pose, generalised to crew: foot on the front tile, dir north, sitting (the chair sprite y-sorts behind
     so it reads as sitting IN the chair). Returns once seated; until then it advances along a path to the seat. */
  function stepCrewToSeat(b, s, dt, now) {
    const foot = seatFoot(s);
    if (Math.hypot(foot.x - b.px, foot.y - b.py) < 1.1) {   // arrived → sit at the desk
      b.px = foot.x; b.py = foot.y; b.pathPts = null; b.target = null; b.state = 'idle'; b.sitting = true; b.dir = 'north';
      return;
    }
    if (!b.target) {   // plot a fresh path to the chair tile
      const cur = tileOf(b.px, b.py);
      const blockers = movementBlockers(b, blocked);
      if (tileBlockedFor(blockers, s.tx, s.ty)) { b.state = 'idle'; b.sitting = false; return; }
      // prop awareness: prefer the machinery-avoiding route to the chair; fall back when it's the only way
      const p = geo.path(cur.x, cur.y, s.tx, s.ty, movementBlockers(b, beltUnion()))
        || geo.path(cur.x, cur.y, s.tx, s.ty, blockers);
      if (p && p.length) { b.pathPts = p; b.pathIdx = 0; crewNextWaypoint(b); }
      else { b.px = foot.x; b.py = foot.y; b.sitting = true; b.dir = 'north'; b.state = 'idle'; return; }   // unreachable → snap into the seat
    }
    if (b.target) {
      const dx = b.target.x - b.px, dy = b.target.y - b.py, d = Math.hypot(dx, dy);
      const more = !!(b.pathPts && b.pathIdx < b.pathPts.length);
      // CORNER LOOKAHEAD: hand over to the next waypoint EARLY, and — critically — do NOT snap onto it.
      // The old code teleported px/py exactly onto every waypoint, which is what made the body pivot on the
      // spot at each tile. Only the FINAL waypoint still snaps, so an arrival settles on an exact position.
      if (d < (more ? CORNER_LOOK : 1.1)) {
        if (more) crewNextWaypoint(b);
        else { b.px = b.target.x; b.py = b.target.y; b.target = null; }
      } else {
        const sp = stepGait(b, dx, dy, d, 28, !more, dt);
        b.px += dx / d * sp; b.py += dy / d * sp; b.state = 'walk'; b.sitting = false;
      }
    }
  }
  /* ---------- per-body sentience engine (Tier B2) ----------
     The HERO's idle/dwell ladder (tick ~1644-1687), generalised to the CURRENT body (`self`). The caller in
     stepCrew sets self=b, calls this, then UNCONDITIONALLY restores self=agent — so every read/write here lands on
     the crew body, and the hero's own run (self===agent) is byte-identical to before (J1). What is DELIBERATELY left
     out vs the hero tick (hero-identity, not idle life): the summon-seize block (crew route through b.working in
     stepCrew, J4), FIRST LIGHT / stepFirstWake (hero-only G2), maybeGlance + the belt-yield shouldYieldToCargo()
     hold (Commander/camera-coupled; shouldYieldToCargo reads agent.target — hero-only). decideIdle's grief/novelty
     reflexes are already self===agent-gated, so a crew body here only consumes its OWN want-engine + quirks. Every
     target picker it can reach is caged to zoneFor(self)=zoneFor(b) (Tier A), so no body leaves its zone (J3). */
  function crewEngineStep(dt, now) {
    const SPEED = 28 * (self.pers ? self.pers.pace : 1);   // a calm background pace (a touch under the hero's 34), tilted by temperament
    // a just-finished task leaves the desk-sit pose (stepCrewToSeat set sitting=true). The engine only keeps sitting
    // for a leisure dwell (goal use/lounge); any other goal → stand, or the !sitting decideIdle gate freezes it.
    if (self.sitting && self.goal !== 'use' && self.goal !== 'lounge') { self.sitting = false; self.state = 'idle'; self.idleUntil = Math.max(self.idleUntil || 0, now + U.irnd(200, 800)); }
    // self-heal a stuck walker (mirrors the hero tick): walk pose with nowhere to go → drop to idle so this tick re-decides
    if (self.state === 'walk' && !self.target && (!self.pathPts || self.pathIdx >= self.pathPts.length)) { self.state = 'idle'; self.idleUntil = 0; }
    // TIER D · D1 ATTENTIVE AUDIENCE: if the Commander has COMMS focus on THIS crew body and it's idle, hold its
    // attention on you (faces south; rare throttled cursor-follow beat) every tick — crew have no maybeGlance, so the hold drives
    // facing directly. Self-gates OFF while working/walking/mid-goal (b.working is set ABOVE in stepCrew, so a live
    // run never reaches here), so the work-seize always wins (G2). A held body skips the rest of the idle engine.
    if (chatStareHold(now)) return;
    // TIER D · D3: this crew body is in a live social encounter → the guard (hard timeout + partner-broken, G4/K3)
    // then stepSocial ((re)path or hold). Runs BELOW the b.working seize (stepCrew skips this whole fn while working),
    // so a summon always wins (G2). stepSocial (re)establishes self.target; the walk block below then advances it.
    if (self.goal === 'social') { if (!stepSocialGuard(now)) stepSocial(now); }   // may (re)set self.target (walk) or clear goal (ended)
    // TIER D · D4: this crew body's cursor-mimic (head-only) / THE CHASE (walk-pursue-stare) steppers. Below the
    // b.working seize (stepCrew skips this whole fn while working), so a summon always wins (G2). stepChase may
    // (re)set self.target (a pursuit leg); the walk block below then advances it.
    if (self.goal === 'mimic') stepMimic(now);
    if (self.goal === 'chase') stepChase(now);
    if (self.target) {
      if (now < (self.pauseUntil || 0)) {
        self.state = 'idle';                                // a deliberate hold mid-walk (maybeStrollBeat's considered pause / double-take)
        if (self.pauseLook === 'back') self.dir = OPP[self.dir] || self.dir;
      } else {
        const dx = self.target.x - self.px, dy = self.target.y - self.py, d = Math.hypot(dx, dy);
        const more = !!(self.pathPts && self.pathIdx < self.pathPts.length);
        if (d < (more ? CORNER_LOOK : 1.1)) {   // early hand-over, no snap — see stepCrewToSeat's note
          if (more) nextWaypoint();
          else { self.px = self.target.x; self.py = self.target.y; arrive(now); }
        } else {
          const s = stepGait(self, dx, dy, d, SPEED, !more, dt);
          self.px += dx / d * s; self.py += dy / d * s; self.state = 'walk';
        }
      }
    } else if (self.goal === 'social') {
      // TIER D · D3: in a social encounter with no active target = the HOLD phase (or a between-steps beat). stepSocial
      // above already set the facing/until; this branch just STOPS the ladder from falling through to decideIdle, which
      // would clear stilling + pick a wandering beat and stomp the encounter. The guard/stepSocial own the lifecycle.
      self.state = 'idle';
    } else if (self.goal === 'mimic' || self.goal === 'chase') {
      // TIER D · D4: mimic (head-only) / chase (stare or between-repaths) with no active target. stepMimic/stepChase
      // above own the facing + lifecycle; this branch just STOPS the fall-through to decideIdle (which would stomp it).
      self.state = 'idle';
    } else if (self.goal === 'use') {
      if (now >= self.useUntil) { releaseSeat(); self.goal = null; self.usingProp = null; self.sitting = false; self.state = 'idle'; self.idleUntil = now + U.irnd(400, 1200); }
    } else if (self.goal === 'lounge') {
      if (now >= self.useUntil) { releaseSeat(); self.goal = null; self.usingProp = null; self.watchProp = null; self.sitting = false; self.state = 'idle'; self.idleUntil = now + U.irnd(400, 1200); }
    } else if (self.goal === 'rounds') {
      if (now >= self.studyUntil) roundsNext(now);
    } else if (self.goal === 'sleep') {
      if (now >= self.studyUntil) { self.goal = null; self.sitting = false; self.glanceCd = 0; self.state = 'idle'; self.idleUntil = now + U.irnd(600, 1800); }
    } else if (self.goal === 'inspect' || self.goal === 'watch' || self.goal === 'tend' || self.goal === 'gaze' || self.goal === 'quirk' || self.goal === 'stare' || self.goal === 'mourn' || self.goal === 'revisit') {
      if (now >= self.studyUntil) {
        const back = (self.goal === 'inspect' || self.goal === 'watch') ? self.useFace : null;
        self.goal = null; self.usingProp = null; self.studyKey = null; self.quirkKind = null; self.state = 'idle'; self.idleUntil = now + U.irnd(1400, 3000);
        if (back && U.chance(0.5)) setGlance(back, U.irnd(500, 900), now);
      }
    } else if (self.state !== 'walk' && !self.sitting && now >= self.idleUntil) {
      decideIdle(now);   // the want-engine (wander is its fallback) — caged to zoneFor(self)
    }
  }
  // CONTAINMENT BACKSTOP (agent-in-the-void escape, 2026-07-12): a standing body whose feet are not
  // on real floor is out of the world — whatever re-frame/re-foot path was missed, it must never be
  // RENDERED adrift. Prefer the nearest walkable tile (a prop dropped underfoot stays local); a body
  // truly in the void (no floor within the ring) re-homes to the spawn room like the hero's
  // ensureAgentValid. Seated/desk-sitting poses keep their logical foot on a walkable tile (the
  // cushion swap is draw-time only), so a standing-body check is the complete invariant.
  function containBody(b, now) {
    if (b.seated || b.sitting) return;
    const t = tileOf(b.px, b.py);
    if (geo.walkable(t.x, t.y, blocked)) return;
    if (b.target) return;   // mid-walk — a transit artefact of footOf/tileOf, not a stranded body (see TRANSIT READING above ensureAgentValid)
    seizeFromIdle(b);   // off the floor = every in-flight goal/claim is in a broken frame — drop them
    let f = null;
    for (let r = 1; r <= 6 && !f; r++) for (let dy = -r; dy <= r && !f; dy++) for (let dx = -r; dx <= r && !f; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (geo.walkable(t.x + dx, t.y + dy, blocked)) f = footOf(t.x + dx, t.y + dy);
    }
    if (!f) f = workerFoot();
    b.px = f.x; b.py = f.y; b.home = tileOf(f.x, f.y);
    b.pathPts = null; b.target = null; b.state = 'idle'; b.idleUntil = now + U.irnd(400, 1200);
  }
  function stepCrew(dt, now) {
    if (!geo || !crew.length) return;
    for (const b of crew) {
      if (b.unplaced) continue;
      containBody(b, now);   // never step (or render) a body that is off the floor
      if (b.working) {                                 // running → sit at its desk if it has one, else stand where work is delivered
        const dp = deskPropFor(b.agentId), s = dp ? deskSeat(dp) : null;
        if (s) stepCrewToSeat(b, s, dt, now);
        else { b.pathPts = null; b.target = null; b.state = 'idle'; b.sitting = false; }
        continue;                                      // J4: the working seize sits ABOVE the engine — a task always wins
      }
      // PLACED + NON-WORKING → run the full sentience engine on THIS body, caged to its own zone.
      // DESK-STUCK FIX (Andrew escape 2026-07-07): this was gated on `b.summoned`, which starved every
      // PLAN-DERIVED (bay-bound) crew body of the idle engine — so a bay body froze wherever work was last
      // delivered: at its bay when idle ("hidden behind the bays"), and at its workstation seat after a run
      // ended ("walks to its desk and stands there eternally"). crewEngineStep already un-sticks the just-
      // finished desk-sit (its `sitting && goal!==use/lounge → stand + re-decide` line) and every target
      // picker is caged to zoneFor(b) — which anchorFor() resolves to the body's OWN bay tile — so a bay body
      // wanders a bounded area around its bay and is re-seized to it the instant work arrives (b.working above,
      // K3/J4). The `summoned` flag still governs floor-reload retention (it's an app-level, not floor-bound,
      // body), NOT whether a body is alive. Every crew body now has the inner life; none freezes at its post.
      // self=b for the duration, then UNCONDITIONALLY restore self=agent so the next body / the hero tick is clean (J1/J2).
      self = b;
      tickNeeds(dt);          // this body's own meters drain/refill by what IT is doing
      crewEngineStep(dt, now);
      self = agent;           // MANDATORY restore — a single synchronous tick, no re-entrancy once every body restores
    }
  }

  // the catalog `use` descriptor for a placed prop, or null if it isn't a leisure prop
  function propUse(p) {
    if (typeof PropSprites === 'undefined' || typeof PropAnchor === 'undefined') return null;
    const s = PropSprites.spec(p.t);
    return s && s.use ? s.use : null;
  }
  // OWNERSHIP: a prop that gets ASSIGNED to an agent for a gamified capability (a PC/workstation, cabinet, dish,
  // notebook, connector, workbench, or a docking bay) is that agent's ALONE — only its assignee walks over to
  // use/inspect it. Leisure + decor (couch/tv/arcade/plant) stay shared. An UNASSIGNED capability prop belongs to
  // no one yet, so no agent is drawn to it either ("...or simply not assigned to them"). This keeps complex
  // multi-agent factory floors legible: agents never wander to another agent's (or an unclaimed) workstation.
  function isOwnableProp(t) { return !!(station && typeof station.capForProp === 'function' && station.capForProp(t)) || t === 'bay'; }
  function mayTouchProp(agentId, p) { return !p || !isOwnableProp(p.t) || p.agentId === agentId; }

  /* ---------- placed workstations = clones of the hero's desk+chair ----------
     A placed PC (any computer-capability prop) is a real workstation: it gets a chair attached in front and
     its ASSIGNED agent walks over and sits in it to work — the exact desk behaviour the hero has at its
     preinstalled desk, just bound to another agent. These three helpers + stepCrewToSeat (below) are the whole
     of that promise; rendering draws F_chair at deskSeat() so the chair lines up with where the body sits. */
  function isWorkstationProp(t) { return !!(station && typeof station.capForProp === 'function' && station.capForProp(t) === 'computer'); }
  // the placed workstation bound to this agent, or null (first match — one PC per agent is the rule)
  function deskPropFor(aid) {
    if (!geo || !geo.props || !aid) return null;
    for (const p of geo.props) if (p.agentId === aid && isWorkstationProp(p.t)) return p;
    return null;
  }
  // the chair tile in front of a workstation: the south-front approach tile (PropAnchor falls back to other
  // sides if the front is walled), facing INTO the desk — mirrors the hero's seat one row below its desk.
  function deskSeat(prop) {
    if (typeof PropAnchor === 'undefined' || !geo || !prop) return null;
    const a = PropAnchor.deriveAnchor(prop, geo, { approach: 'south', sit: true, extra: blocked });
    // `cx` = the FRACTIONAL tile x that centres a 1-tile chair on the desk. PropAnchor picks the nearest
    // walkable WHOLE tile (pathing needs one), but an even-width desk's centre line falls on a tile
    // boundary — a 2-wide desk seated at either tile sits 6px off-centre, which is exactly the "chair is
    // stuck on the left" report. Only the RENDER + the final foot snap use cx; the walk target stays tx.
    return a ? { tx: a.tx, ty: a.ty, face: a.face, cx: seatCx(prop, a.tx) } : null;
  }
  // centre a 1-wide seat under a prop, but never drift further than one tile from the walkable anchor
  // (a desk whose middle is walled off keeps its chair at the tile the body can actually reach).
  function seatCx(prop, tx) {
    const c = prop.x + ((prop.w || 1) / 2) - 0.5;
    return Math.abs(c - tx) <= 0.5 ? c : tx;
  }
  // where a seated body's foot lands: the seat's centred x, its tile's y. A function declaration (not a
  // const) because callers above this line run before it in source order.
  function seatFoot(s) { return { x: ((s.cx == null ? s.tx : s.cx) + 0.5) * T, y: s.ty * T + T - 1 }; }

  /* ---------- capability-prop resolution (G0.1: which prop does a firing tool light?) ----------
     geo.props are in the bake's LOCAL frame; station.roomAt speaks WORLD tiles — geo.origin bridges them. */
  const roomOfLocalTile = (lx, ly) => (station && geo && geo.origin) ? station.roomAt(lx + geo.origin.tx, ly + geo.origin.ty) : null;
  // the acting agent's ROOM: its BAY's room first (the capability seam — the room whose props granted the
  // tool), else the room its body stands in (hero/summoned workers have no bay).
  function actingRoomId(aid) {
    if (!station || !geo) return null;
    if (aid && typeof station.agentRoomId === 'function') { const r = station.agentRoomId(aid); if (r) return r; }
    const b = bodyForAgent(aid) || agent;
    if (!b) return null;
    const t = tileOf(b.px, b.py);
    return roomOfLocalTile(t.x, t.y);
  }
  // the placed prop a capability pulse should land on: the agent's OWN assigned prop of that type first,
  // then any matching prop in the acting agent's room, then any matching prop on the floor (null = none
  // placed -> nothing pulses; a tool the floor didn't grant a body never invents one).
  function capPropFor(cap, aid) {
    if (!geo || !geo.props || !cap) return null;
    const match = p => (station && station.capForProp && station.capForProp(p.t) === cap) || p.t === cap;   // t===cap covers catalog types named for the capability itself (e.g. jukebox)
    const cands = geo.props.filter(match);
    if (!cands.length) return null;
    if (aid) { const own = cands.find(p => p.agentId === aid); if (own) return own; }
    const room = actingRoomId(aid);
    // TRUTH: the pulse must land in the ACTING agent's OWN room — a matching prop in some OTHER room did not grant
    // this tool, so lighting it is a lie (the audit's wrong-room surge). If we can resolve the acting room, require
    // the prop be in it; no in-room match → no pulse. cands[0] is only a legitimate fallback when NO room can be
    // resolved at all (a roomless single-agent floor, where the sole floor prop unambiguously granted the tool).
    if (room) { return cands.find(p => roomOfLocalTile(p.x, p.y) === room) || null; }
    return cands[0];
  }

  /* free this agent's claimed seat (idempotent) and drop the on-couch render offset */
  function releaseSeat() {
    if (!self) return;
    if (self.seatKey) occupiedSeats.delete(self.seatKey);
    self.seatKey = null; self.seated = false; self.pendSeat = null;
  }
  /* on arrival, snap the render position onto the cushion claimed at plan time (logical pos stays put) */
  function takeSeat() {
    if (self.seatKey && self.pendSeat) { self.seated = true; self.seatPx = self.pendSeat.px; self.seatPy = self.pendSeat.py; self.pendSeat = null; }
  }
  /* B2: drop ANY body's idle/leisure latch (couch cushion claim + the engine goal bookkeeping) when a task SEIZES
     it — the crew analogue of the hero summon-seize's releaseSeat()+goal-clear (tick ~1614). Without this, a crew
     body summoned mid-lounge keeps a stale goal='use'/'lounge' and leaks its occupiedSeats cushion claim forever
     (a permanently-blocked seat). Operates on an explicit body (NOT `self`) so setActivityFor/handoff can call it
     without disturbing the actor pointer. Idempotent. */
  function seizeFromIdle(b) {
    if (!b) return;
    if (b.seatKey) occupiedSeats.delete(b.seatKey);
    b.seatKey = null; b.seated = false; b.pendSeat = null;
    b.goal = null; b.usingProp = null; b.watchProp = null; b.studyKey = null; b.quirkKind = null; b.stilling = false;
    b.pauseUntil = 0; b.pauseLook = null; b.idleUntil = 0;
    if (chaseId === b.agentId) chaseId = null; b.chase = null; b.mimic = null;   // TIER D · D4: a summon seizes the body → drop any live chase/mimic + free the station chaser lock (G2)
  }

  /* v7 sit-ON-the-couch: a couch is a blocking prop (you can't path onto it), so the agent walks to
     a tile ADJACENT to a free cushion, then RENDERS on that cushion while the couch (drawn as the sofa's
     BACK — it faces north) y-sorts just in front, so the sitter peeks over the backrest. Seats are the inner footprint columns (an arm
     is skipped at each end on a wide couch). Each cushion is reserved in occupiedSeats so a second
     agent takes a different one (or, when the couch is full, planProp moves on to another couch).
     tvId != null → goal 'lounge' (watch + light the TV); else a plain couch sit. */
  const LOUNGE_MAXT = 7;
  const SEAT_NB = [[0, 1], [0, -1], [1, 0], [-1, 0]];   // approach a cushion from any walkable neighbour
  function planCouchSit(now, couch, tvId, faceDir, zone) {
    const w = couch.w || 1, h = couch.h || 1;
    const lo = w >= 3 ? 1 : 0, hi = w >= 3 ? w - 2 : w - 1;   // skip an arm tile each end when wide
    const slots = [];
    for (let i = lo; i <= hi; i++) if (!occupiedSeats.has(couch.id + ':' + i)) slots.push(i);
    if (!slots.length) return false;                          // couch full → caller tries another couch
    const order = U.irnd(0, slots.length - 1);                // vary which cushion is taken
    for (let k = 0; k < slots.length; k++) {
      const slot = slots[(order + k) % slots.length];
      const sx = couch.x + slot, sy = couch.y;                // the couch tile the agent will sit on
      if (!tileInZone(zone, sx, sy)) continue;                // P1: the cushion the body RENDERS on must be in-zone (a wide couch can straddle a wall)
      for (const [dx, dy] of SEAT_NB) {
        const ax = sx + dx, ay = sy + dy;
        if (!tileInZone(zone, ax, ay)) continue;              // P1: the approach tile the body WALKS to must be in-zone too
        if (!geo.walkable(ax, ay, blocked)) continue;
        if (!setPathTo({ x: ax, y: ay })) continue;
        occupiedSeats.add(couch.id + ':' + slot); self.seatKey = couch.id + ':' + slot;
        self.pendSeat = { px: (sx + 0.5) * T, py: (couch.y + h) * T - 2 };   // render foot at the cushion front
        self.goal = tvId ? 'lounge' : 'use'; self.usingProp = couch.id; self.watchProp = tvId || null;
        self.useSit = true; self.useFace = faceDir || 'south';
        if (!self.target) arrive(now);                       // already adjacent → sit immediately
        return true;
      }
    }
    return false;
  }

  /* couch + a TV nearby → sit on the couch and watch it. The pairing is derived live (gen has no
     authored couch/TV pairs): for each couch, the nearest TV within range, faced from the couch. */
  function tryLounge(now) {
    const zone = zoneFor(self);   // P1: only lounge on a couch INSIDE the body's zone (the body sits there)
    const couches = [], tvs = [];
    for (const p of geo.props) {
      const use = propUse(p); if (!use) continue;
      if (use.kind === 'couch') { couches.push(p); }   // cushion/approach are caged per-slot in planCouchSit (a wide couch can straddle a wall)
      else if (use.kind === 'tv') tvs.push({ p, cx: p.x + (p.w || 1) / 2, cy: p.y + (p.h || 1) / 2 });   // the TV is only WATCHED from the couch (no walk) — may sit anywhere in view
    }
    if (!couches.length || !tvs.length) return false;
    const order = U.irnd(0, couches.length - 1);   // don't always favour the same couch
    for (let k = 0; k < couches.length; k++) {
      const couch = couches[(order + k) % couches.length];
      const cx = couch.x + (couch.w || 1) / 2, cy = couch.y + (couch.h || 1) / 2;
      let best = null;
      for (const tv of tvs) { const d = Math.hypot(tv.cx - cx, tv.cy - cy); if (d <= LOUNGE_MAXT && (!best || d < best.d)) best = { tv, d }; }
      if (!best) continue;
      const face = dirToward(cx, cy, best.tv.cx, best.tv.cy);   // turn to the TV from the couch
      if (planCouchSit(now, couch, best.tv.p.id, face, zone)) return true;
    }
    return false;
  }

  // idle leisure: pick a reachable interactive prop (couch/tv/arcade/jukebox/bar), walk to
  // its approach tile, and commit to goal='use'. Returns false if none is reachable (→ wander).
  function planProp(now) {
    if (!geo || !geo.props || !geo.props.length) return false;
    if (tryLounge(now)) return true;   // couch + TV nearby → sit ON the couch and watch (the v7 lounge)
    const zone = zoneFor(self);   // P1: only use leisure props the body can reach WITHOUT leaving its zone
    const cands = [];
    for (const p of geo.props) {
      const use = propUse(p); if (!use) continue;
      if (use.kind === 'couch') { cands.push({ couch: p }); continue; }   // cushion/approach are caged per-slot in planCouchSit (a wide couch can straddle a wall)
      const a = PropAnchor.deriveAnchor(p, geo, { approach: use.approach || 'south', sit: !!use.sit, extra: blocked });
      if (a && tileInZone(zone, a.tx, a.ty)) cands.push({ id: p.id, a });   // the APPROACH tile (where the body stands) must be in-zone
    }
    if (!cands.length) return false;
    const start = U.irnd(0, cands.length - 1);   // random offset, but try each prop at most once
    for (let k = 0; k < cands.length; k++) {
      const c = cands[(start + k) % cands.length];
      if (c.couch) { if (planCouchSit(now, c.couch, null, 'north', zone)) return true; continue; }   // lone couch → sit on it facing UP (back to the viewer)
      if (setPathTo({ x: c.a.tx, y: c.a.ty })) {
        self.goal = 'use'; self.usingProp = c.id; self.useFace = c.a.face; self.useSit = c.a.sit;
        if (!self.target) arrive(now);   // already standing on the approach tile
        return true;
      }
    }
    return false;
  }

  /* ---------- awareness: notice new placements ---------- */
  // diff this frame's props/belts against what the agent has already taken in; queue the additions
  function scanNovelty() {
    const props = (geo && geo.props) || [], belts = (geo && geo.belts) || [];
    const propIds = new Set(props.map(p => p.id));
    const beltKeys = new Set(belts.map(b => b.x + ',' + b.y));
    const foot = new Map();
    for (const p of props) foot.set(p.id, { x: p.x, y: p.y, w: p.w || 1, h: p.h || 1 });
    if (seenProps === null) { seenProps = propIds; seenBelts = beltKeys; propFoot = foot; return; }   // first look: learn the scene, react to nothing
    const zone = zoneFor(agent);   // P1: only queue novelties INSIDE the hero's zone (it won't walk out to inspect)
    for (const p of props) {
      if (seenProps.has(p.id)) continue;
      if (!mayTouchProp(agent && agent.id, p)) continue;   // another agent's (or unclaimed) workstation isn't "novel" to this one — don't walk over
      const tx = Math.floor(p.x + (p.w || 1) / 2), ty = Math.floor(p.y + (p.h || 1) / 2);
      if (!tileInZone(zone, tx, ty)) continue;             // out-of-zone placement — noticed, but not walked to
      pushNovelty(tx, ty, 'prop', p.id);
    }
    for (const b of belts) {                       // a long run lands as one tile-flag, not a spam of them
      if (seenBelts.has(b.x + ',' + b.y)) continue;
      if (!tileInZone(zone, b.x, b.y)) continue;            // a new belt outside the zone isn't an inspect target
      pushNovelty(b.x, b.y, 'belt', null); break;
    }
    // REMOVALS -> grief: a prop the Commander deletes, if it stood on a spot this agent loved, is mourned
    for (const id of seenProps) {
      if (propIds.has(id)) continue;               // still there
      if (ownPlaced.has(id)) continue;             // its OWN decor it tidied away — never mourn that
      const f = propFoot.get(id); if (f) maybeMourn(f);
    }
    seenProps = propIds; seenBelts = beltKeys; propFoot = foot;
  }
  /* a prop at footprint f was just removed. Sum the agent's affection for the tiles around where it stood;
     if it loved that spot, queue a quiet grief beat. Rate-limited so tearing down a whole room = one mourn. */
  function maybeMourn(f) {
    if (!agent || !agent.fond || activity === 'task' || agent.unplaced) return;
    if (fnow < (mournCd || 0)) return;
    let sum = 0, bestKey = null, bv = 0;
    for (const [k, v] of agent.fond) {
      const [x, y] = k.split(',').map(Number);
      // radius-2 halo: a BLOCKING prop (couch/machine) pushes the agent's dwell tile up to 2 tiles off its footprint,
      // so affection for "that spot" lands a tile or two away — verified live (a couch sit logs at couch.y+2)
      if (x >= f.x - 2 && x <= f.x + f.w + 1 && y >= f.y - 2 && y <= f.y + f.h + 1) { sum += v; if (v > bv) { bv = v; bestKey = k; } }
    }
    if (sum < 6 || !bestKey) return;               // it never really cared about this corner — let it go unremarked
    if (pendingMourn && pendingMourn.fond >= sum) return;   // keep only the deepest grief if several land at once
    pendingMourn = { tx: Math.floor(f.x + f.w / 2), ty: Math.floor(f.y + f.h / 2), spotKey: bestKey, fond: sum };
    mournCd = fnow + 45000;
    if (activity === 'idle') { if (agent.goal === 'sleep') { agent.goal = null; agent.sitting = false; } agent.idleUntil = Math.min(agent.idleUntil || 0, fnow + 300); }
  }
  function pushNovelty(tx, ty, kind, pid) {
    novelty = novelty.filter(n => !(n.tx === tx && n.ty === ty));   // dedupe the same tile
    novelty.push({ tx, ty, kind, pid });
    if (novelty.length > NOVELTY_MAX) novelty.shift();
    if (agent && activity === 'idle') {
      if (agent.goal === 'sleep') { agent.goal = null; agent.sitting = false; agent.glanceCd = 0; agent.studyUntil = 0; }   // a placement stirs it from dormancy
      agent.idleUntil = Math.min(agent.idleUntil || 0, fnow + 350);   // react within ~1s (then it walks over to inspect)
      // STARTLE: something materialized right beside it → a sharp snap toward it + a beat, distinct from the calm far-off notice
      if (!agent.working && !agent.unplaced) {
        const d = Math.hypot((tx + 0.5) * T - agent.px, (ty + 0.5) * T - agent.py);
        if (d < 3.4 * T) { const dir = dirToward(agent.px, agent.py, (tx + 0.5) * T, (ty + 0.5) * T); setGlance(dir, 240, fnow); agent.dir = dir; agent.glanceCd = fnow + 600; curiositySay(Q_STARTLE, 0.5, fnow); }
      }
    }
  }

  /* pixel position of the nearest riding belt box, or null (for gaze-tracking cargo) */
  function nearestBox() {
    if (!convey || !convey.peekBoxes) return null;
    const boxes = convey.peekBoxes(); if (!boxes || !boxes.length) return null;
    const DV = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
    let best = null, bd = Infinity;
    for (const b of boxes) {
      if (b.sink > 0) continue;
      const v = DV[b.dir] || [0, 0];
      const bx = (b.x + 0.5 + (b.prog - 0.5) * v[0]) * T, by = (b.y + 0.5 + (b.prog - 0.5) * v[1]) * T;
      const d = Math.hypot(bx - self.px, by - self.py);
      if (d < bd) { bd = d; best = { x: bx, y: by, d }; }
    }
    return best;
  }

  function setGlance(dir, ms, now) { if (self) self.glance = { dir, until: now + ms }; }

  /* ================= Tier C (cross-agent awareness) — C0 plumbing =================
     INVIOLABLE RULE: perceive across zones, ACT (move) only within your own. These two helpers are the
     GAZE-ONLY foundation — they READ neighbor positions and turn a head; they NEVER introduce a path,
     target, goal, or any movement (K1). Wired to NO trigger in C0 — this phase changes zero behavior. */

  // Every body = the hero `agent` + the crew[] array. Bounded O(N) (hero + a handful of crew).
  const allBodies = () => (agent ? [agent].concat(crew) : crew.slice());

  // neighborsOf — READ-ONLY. Returns the OTHER bodies within `radius` tiles of `body` AND in a basic
  // sightline (same zone — the containment-aware "can see" test; reads px/py/tile only, mutates NOTHING).
  // Skips: itself, unplaced bodies. N is tiny, so an O(N) scan gated to the idle cadence is cheap (K4).
  function neighborsOf(body, radius) {
    const out = [];
    if (!body || body.unplaced) return out;
    const rPx = radius * T;                       // compare in pixels (px/py are the canonical coords)
    const zone = zoneFor(body);                   // basic sightline = the observer's own zone (read-only)
    for (const other of allBodies()) {
      if (other === body || !other || other.unplaced) continue;
      if (Math.hypot(other.px - body.px, other.py - body.py) > rPx) continue;   // proximity (deterministic)
      const ot = tileOf(other.px, other.py);      // logical tile (seated bodies still carry px/py here)
      if (!tileInZone(zone, ot.x, ot.y)) continue;   // sightline: neighbor stands within the observer's zone
      out.push(other);
    }
    return out;
  }

  // glanceAt — turn `self` to FACE otherBody for `dur` ms. Calls ONLY setGlance (head-turn, auto-reverts at
  // render via assets.js). It mutates ONLY self's own glance state — never a path/target/goal/position (K1),
  // never another body (K2). MUST run with `self` pointing at the GLANCING body (Tier B self discipline).
  function glanceAt(self_, otherBody, dur, now) {
    if (!self_ || !otherBody) return;
    const dir = dirToward(self_.px, self_.py, otherBody.px, otherBody.py);
    if (self_ === self) { setGlance(dir, dur, now); return; }   // current actor: reuse setGlance (writes self.glance)
    self_.glance = { dir, until: now + dur };                   // non-current body: direct glance write (no self repoint)
  }

  // bodyIsIdle — READ-ONLY: is `b` free to notice (not tasked, not walking, no active goal)? The hero's busy
  // flag is the module-scope `activity` (HERO-ONLY); crew busyness is per-body (b.working/b.workUntil). Every
  // PLACED crew body now runs the inner life (stepCrew no longer gates the engine on b.summoned — desk-stuck
  // fix), so a free bay-bound body is a first-class idle body here too. Reads only — mutates nothing.
  function bodyIsIdle(b, now) {
    if (!b || b.unplaced || b.state === 'walk' || b.working || b.goal != null) return false;
    if (agent && b === agent) return activity === 'idle';                 // hero: the single module-scope busy flag
    return b.workUntil <= now;                                            // crew (summoned OR bay-bound): alive unless mid-run
  }

  /* ================= Tier C — C-Beat1: SUMMON GLANCE =================
     When a body is summoned to a task, each OTHER body that is currently IDLE and within sight has a 50% chance
     to turn its head toward the summoned body for a brief beat, then resume. GAZE-ONLY (glanceAt → setGlance/direct
     .glance write — no path/target/goal/movement, K1). Fires off the summon EVENT only (never off another body's
     glance, K4 no cascade). A short per-observer refractory makes it fire ONCE per event, not every frame. The
     glance is ADDITIVE and NEVER delays the summon — this runs AFTER the work-seize (K3 summon-wins). The summoned
     body itself does NOT glance (it's tasked, excluded as the scan target). Determinism: U.chance(0.5) + U.irnd (K5).
     CRITICAL self-discipline (K2): this runs OUTSIDE the per-body engine loop (from setActivityFor/handoff/bus where
     `self` points at the hero or a stale body), so it writes each observer's glance via glanceAt's DIRECT path —
     it enumerates bodies explicitly and never re-points the module `self`. */
  const SUMMON_GAZE_RADIUS = 7;   // tiles — same zone + within sight; neighborsOf already caps to the observer's zone
  function summonGlance(summonedBody, now) {
    if (!summonedBody) return;
    for (const obs of neighborsOf(summonedBody, SUMMON_GAZE_RADIUS)) {
      if (obs === summonedBody) continue;            // the tasked body goes to work, never glances (defensive; neighborsOf already excludes self)
      if (!bodyIsIdle(obs, now)) continue;           // only free bodies notice (a busy/walking body keeps its task — K3)
      if (now < (obs.summonGlanceCd || 0)) continue; // per-observer refractory: once per summon event, not every frame
      obs.summonGlanceCd = now + U.irnd(1600, 2800); // arm refractory whether or not the roll lands (no re-roll storm)
      if (!U.chance(0.5)) continue;                  // 50% — half notice, half stay absorbed
      glanceAt(obs, summonedBody, U.irnd(650, 1050), now);   // brief head-turn toward the summoned, auto-reverts at render
    }
  }

  /* ================= Tier C — C-Beat2: MUTUAL IDLE GLANCE =================
     When `self` (the deciding idle body) has a neighbor that is ALSO idle within sight, occasionally — rarity-gated
     behind a long PER-BODY cooldown (self.neighborGlanceCd) — both bodies turn their heads toward each other for a
     held beat, then the normal glance timeout ENDS it. A quiet, silent "they noticed each other." GAZE-ONLY: glanceAt
     calls setGlance / writes .glance only — no path/target/goal/movement (K1). Each body mutates ONLY its OWN glance
     state — self via setGlance, the neighbor via glanceAt's DIRECT .glance write — never any other field (K2).
     K4 no deadlock: the mutual glance self-terminates by `until` at render (assets.js); nothing re-arms it until the
     cooldown elapses, so two facing idle bodies can't lock into a sustained stare. K4 no cascade: this fires off
     both-idle PROXIMITY + the cooldown ONLY — it reads neighbor px/py/idle-state, NEVER neighbor.glance, so A glancing
     can't make B glance. Called from decideIdle (idle-cadence gated, NOT every frame) with self set to the deciding
     body, so hero (self===agent) and crew (self===b) behave uniformly. Returns true iff a mutual glance was struck.
     Determinism: U.chance / U.irnd / U.pick only (K5). */
  const MUTUAL_GAZE_RADIUS = 4;   // tiles — a near neighbor; neighborsOf already caps to the deciding body's zone
  function maybeMutualGlance(now) {
    if (!self || self.stilling) return false;          // never interrupt a deliberate stilling hold (eerie calm wins — K8)
    if (now < (self.neighborGlanceCd || 0)) return false;   // long per-body cooldown so it's occasional, not busy (K8/K4)
    const cands = [];
    for (const other of neighborsOf(self, MUTUAL_GAZE_RADIUS)) {
      if (!bodyIsIdle(other, now)) continue;           // only a free neighbor can lock eyes back (read-only idle test)
      if (other.stilling) continue;                    // respect the neighbor's deliberate hold too (don't yank it out)
      cands.push(other);
    }
    if (!cands.length) { self.neighborGlanceCd = now + U.irnd(8000, 16000); return false; }   // arm a short re-scan gap even on a miss (no per-frame rescans)
    self.neighborGlanceCd = now + U.irnd(14000, 26000);   // arm the cooldown whether or not the roll lands (no re-roll storm)
    if (!U.chance(0.18)) return false;                 // rare — a quiet noticing, not a constant swivel (K8 eerie restraint)
    const other = U.pick(cands);
    const dur = U.irnd(900, 1500);                      // a HELD beat (longer than an ambient flick) — they regard each other, then break
    glanceAt(self, other, dur, now);                   // self looks at the neighbor (self===self -> setGlance)
    glanceAt(other, self, dur, now);                   // the neighbor looks back — glanceAt's DIRECT .glance write (K2: only its glance)
    // Protect the partner's held look-back the same way decideIdle protects the INITIATOR (idleUntil at the call site):
    // bodyIsIdle ignores idleUntil, so `other` may be at/past its idle hold and re-decide via decideIdle before `dur`
    // elapses — standStill (62%)/lookAround/wander would then stomp other.glance, degrading C-Beat2 to one-sided. Hold
    // its idle past the glance so the mutual beat survives, then ends cleanly by the glance timeout (K4: still self-
    // terminating, no movement — idleUntil/glance/cooldown only, never a path/target/goal — K1/K2 intact).
    other.idleUntil = Math.max(other.idleUntil || 0, now + dur + U.irnd(200, 600));
    other.neighborGlanceCd = now + U.irnd(14000, 26000);   // arm the partner's cooldown too so it doesn't immediately re-initiate
    // Protect the INITIATOR's held glance symmetrically: bodyIsIdle ignores idleUntil, so if self's idle hold expired
    // mid-glance the crew/hero engine would re-enter decideIdle and standStill(62%)/lookAround/wander could stomp self's
    // own still-live glance (degrading C-Beat2 to one-sided on the initiator side). Hold self's idle past dur the same
    // way the partner is held — gaze/timer-only, no path/target/goal (K1/K2 intact, K4 still self-terminating).
    self.idleUntil = Math.max(self.idleUntil || 0, now + dur + U.irnd(200, 600));
    return true;
  }

  /* ================= TIER D · D3 — SOCIAL ENCOUNTERS (Tier C grows legs) =================
     Bounded, SILENT movement beats between two idle bodies. The four kinds:
       'huddle'  — two SAME-ZONE bodies converge to adjacent tiles, face each other, hold, break.
       'watch'   — an idle body stands ~2 tiles behind a WORKING body in its own zone, faces the desk, holds.
       'border'  — two ADJACENT-zone bodies each walk to the nearest tile of their shared edge (each INSIDE its
                   own zone), face each other across the line, hold, break.
       'follow'  — an idle body notices a walking body passing nearby, half-follows 2-4 tiles (zone-clamped), then
                   loses interest and STOPS. It NEVER completes the follow — the incompleteness is the design.
     INVARIANTS (each is a named review hunt): containment (every target zone-clamped, G3/K1); work seizes
     instantly (any participant summoned → abandons; the survivor releases within the hard timeout, G2/K3);
     one live encounter (the `socialBeat` slot + hard `until`, G4); no deadlock/cascade (idle-cadence selection off
     neighborsOf, per-pair cooldowns, a beat never spawns another, K4); station rarity (consult crewBeatDamp + arm
     via armBeat, G5); Tier B self-discipline (startEncounter is the ONE cross-body write; stepSocial mutates only
     self, K2); chat-stare exclusion (a chatFocus body never joins). */
  const SOCIAL_SEL_ROLL = 0.08;             // per idle re-decide, when a candidate pair exists + the social LANE is open (G5: rare; the lane cooldown — not this roll — sets the rate)
  const SOCIAL_STATION_CD_MIN = 300000, SOCIAL_STATION_CD_MAX = 480000;   // dedicated social station cooldown LANE (5-8 min) — the rate governor (MC: ~9.5 encounters/hr on a 3-6 body floor; one at a time, G4)
  const SOCIAL_HOLD_MIN = 3000, SOCIAL_HOLD_MAX = 7000;   // the silent face-each-other hold (varied)
  const SOCIAL_HARD_MS = 25000;             // whole-encounter hard timeout — the slot ALWAYS frees by this (G4)
  const SOCIAL_PAIR_CD_MIN = 180000, SOCIAL_PAIR_CD_MAX = 360000;   // per-pair cooldown (minutes) so a duo never loops (K4)
  const SOCIAL_NEAR_RADIUS = 5;             // tiles — huddle/watch candidate proximity (within the observer's zone via neighborsOf)
  const SOCIAL_FOLLOW_MIN = 2, SOCIAL_FOLLOW_MAX = 4;   // half-follow distance (tiles) — bounded, never completes

  /* armSocialBudget — the two station-level side-effects EVERY fired encounter must do, at ALL fire sites
     (startEncounter for huddle/border, and the one-sided planWatch/planFollow which set the slot inline):
     (1) armBeat — count it against the SHARED station calm budget so quirks stay quiet in its shadow (total
     station beat rate is preserved — G5), and (2) draw the dedicated social LANE cooldown (5-8min) so the
     encounter RATE is governed here, decoupled from the quirk-gate race. Kept as one helper so a new social
     beat can never forget one half (a lane-arm-without-armBeat would grow the total rate; the reverse would
     let social loop). */
  function armSocialBudget(now) { armBeat(now); socialGateUntil = now + U.irnd(SOCIAL_STATION_CD_MIN, SOCIAL_STATION_CD_MAX); }

  // stable sorted-pair key for the per-pair cooldown map
  function pairKey(aId, bId) { return (String(aId) < String(bId)) ? (aId + '|' + bId) : (bId + '|' + aId); }
  function pairOnCd(aId, bId, now) { return now < (socialPairCd.get(pairKey(aId, bId)) || 0); }
  function armPairCd(aId, bId, now) { socialPairCd.set(pairKey(aId, bId), now + U.irnd(SOCIAL_PAIR_CD_MIN, SOCIAL_PAIR_CD_MAX)); }

  // is body `b` a valid social participant right now? idle, placed, not chat-focused, not already in a beat.
  // Reuses bodyIsIdle (the Tier C read-only idle test) — so it excludes tasked/walking/mid-goal/mid-run bodies.
  function socialEligible(b, now) {
    if (!b || b.unplaced || b.social) return false;              // already in an encounter, or nobody
    if (b.stilling) return false;                                // don't yank a deliberate stillness hold (eerie calm wins)
    if (chatHot(now) && b === chatFocusBody()) return false;     // chat-stare exclusion (D1): never recruit the HOT-focused body (cold focus = the body is living its life — fully eligible)
    return bodyIsIdle(b, now);                                   // idle, not tasked/walking/mid-goal (hero: activity idle; crew: summoned+free)
  }

  // free the whole encounter + clear both participants' plans. Idempotent. Called on: hard timeout, partner-gone,
  // a participant seized by work, or a clean natural end. NEVER leaves the slot occupied (G4).
  function endEncounter(now, armCd) {
    const s = socialBeat; socialBeat = null;
    if (!s) return;
    const a = bodyForAgent(s.aId), b = bodyForAgent(s.bId);
    for (const body of [a, b]) {
      if (!body || !body.social) continue;
      // only tear down OUR plan; if a body was already re-tasked (working / summon), leave its live state alone —
      // just drop the social plan so it stops trying to rendezvous. Its own tick owns the rest.
      body.social = null;
      if (body.goal === 'social') { body.goal = null; body.state = 'idle'; body.pathPts = null; body.target = null; body.idleUntil = Math.max(body.idleUntil || 0, now + U.irnd(300, 900)); }
    }
    if (armCd !== false && s.aId != null && s.bId != null) armPairCd(s.aId, s.bId, now);   // arm the per-pair cooldown on any end (so a loop can't restart it)
  }

  // has the encounter been pulled apart (a participant seized by work / despawned / chat-focused)? ⇒ tear down so
  // the survivor releases (K3). READ-ONLY on the bodies. TWO-SIDED beats (huddle/border) give BOTH bodies a plan —
  // either losing its plan or being seized breaks it. ONE-SIDED beats (watch/follow) give only the OBSERVER (aId) a
  // plan; the passive subject (bId) just needs to still EXIST — a WATCH subject working / a FOLLOW subject walking is
  // the whole point, not a break. Chat-focus on either body breaks it (the Commander now owns that body's attention).
  function encounterBroken(now) {
    const s = socialBeat; if (!s) return true;
    const a = bodyForAgent(s.aId), b = bodyForAgent(s.bId);
    if (!a || !b || a.unplaced || b.unplaced) return true;                 // a participant despawned
    const oneSided = (s.kind === 'watch' || s.kind === 'follow');
    // the OBSERVER (aId) always carries the plan — its loss/seizure always breaks the beat.
    if (a.social == null) return true;                                     // observer's plan cleared out from under us
    if (a.working) return true;                                            // observer's crew run seized it
    if (a === agent && activity === 'task') return true;                   // observer (hero) got summoned
    if (chatHot(now) && (a === chatFocusBody() || b === chatFocusBody())) return true;   // either pulled into a LIVE (hot) chat-stare — a cold focus doesn't seize, so it doesn't break the beat
    if (!oneSided) {
      // TWO-SIDED: the partner (bId) must also still be holding its own plan and not seized.
      if (b.social == null) return true;
      if (b.working) return true;
      if (b === agent && activity === 'task') return true;
    }
    return false;
  }

  /* startEncounter — THE ONE coordinator (K2). Assigns each body its OWN plan on `body.social` at initiation
     (this is the sanctioned cross-body write, done once, explicitly, here). Each plan is fully self-contained so
     per-tick stepSocial(self) mutates only self. Every walk target is zone-clamped to the MOVER's own zone (G3).
     Returns true iff an encounter was armed (⇒ caller should not fall through to a normal idle beat). */
  function startEncounter(a, b, kind, now, planA, planB) {
    if (socialBeat) return false;                                         // G4: one live encounter station-wide
    a.social = planA; b.social = planB;
    a.social.partnerId = b.id; b.social.partnerId = a.id;
    a.social.kind = kind; b.social.kind = kind;
    a.goal = 'social'; b.goal = 'social';
    // drop any in-flight idle state so the social plan owns each body cleanly (does NOT touch working/task — those
    // paths are excluded by socialEligible, so a/b are genuinely idle here).
    for (const body of [a, b]) { body.stilling = false; body.usingProp = null; body.sitting = false; body.pauseUntil = 0; body.pauseLook = null; body.studyKey = null; }
    socialBeat = { kind, aId: a.id, bId: b.id, until: now + SOCIAL_HARD_MS };
    armSocialBudget(now);                                                 // G5 shared-gate arm + the 5-8min social LANE draw (total calm preserved; rate governed by the lane)
    return true;
  }

  /* stepSocial — per-tick stepper for the CURRENT body (self) while self.goal === 'social'. Mutates ONLY self
     (self.social, self position/facing via the existing walk/arrive machinery) and reads the partner READ-ONLY
     (position/tile only). Phases per plan:
       plan = { phase:'walk'|'hold', tx,ty, faceTile:{x,y}|'partner', until, followLeft }
     'walk': path toward (tx,ty) (already zone-clamped at plan time; re-derive path via setPathTo, reusing the
             existing pather). On arrival → face the target and enter 'hold'. For 'follow', decrement followLeft
             and re-target the next step toward the (still-moving) partner, zone-clamped; when followLeft hits 0 or
             the partner stops/leaves the zone, it just STOPS (never completes).
     'hold': stand still, face the partner (or the fixed faceTile), until `plan.until`; then the encounter ends.
     The whole-encounter hard timeout + the partner-broken check are enforced by the caller (stepSocialGuard) BEFORE
     this runs, so stepSocial only handles the happy path. Determinism: U.* only. */
  function stepSocial(now) {
    const pl = self.social; if (!pl) return;
    // face resolution
    const facePartner = () => { const p = bodyForAgent(pl.partnerId); if (p) self.dir = dirToward(self.px, self.py, p.px, p.py); };
    if (pl.phase === 'walk') {
      if (self.state === 'walk' || self.target) return;   // still walking — the walk machinery in tick/crewEngineStep drives it
      const cur = tileOf(self.px, self.py);
      if (pl.kind === 'follow') {
        // half-follow: take bounded steps toward the (moving) partner, zone-clamped; NEVER complete.
        const p = bodyForAgent(pl.partnerId);
        if (!p || (pl.followLeft || 0) <= 0) { enterHold(now, pl); return; }          // lost interest / budget spent / partner gone → stop + a brief stare, then end
        const zone = zoneFor(self);
        const pt = tileOf(p.px, p.py);
        const stepX = Math.sign(pt.x - cur.x), stepY = Math.sign(pt.y - cur.y);       // one tile toward the partner's CURRENT tile
        let stepped = false;
        for (const [dx, dy] of [[stepX, stepY], [stepX, 0], [0, stepY]]) {
          if (!dx && !dy) continue;
          const tx = cur.x + dx, ty = cur.y + dy;
          if (tileInZone(zone, tx, ty) && geo.walkable(tx, ty, blocked) && setPathTo({ x: tx, y: ty })) {
            pl.tx = tx; pl.ty = ty; pl.followLeft = (pl.followLeft || 0) - 1; self.goal = 'social'; stepped = true; break;
          }
        }
        if (!stepped) enterHold(now, pl);                                             // can't advance in-zone → stop where it is
        return;
      }
      // huddle / watch / border: a single fixed walk target. `started` distinguishes "not yet en route" (→ path to
      // it) from "arrived / path exhausted" (→ hold). Without it, a freshly-armed plan with no path would read as
      // "already arrived" on tick 1 and hold in place without ever walking.
      if (cur.x === pl.tx && cur.y === pl.ty) { enterHold(now, pl); return; }         // standing on it already → hold
      if (pl.started) { enterHold(now, pl); return; }                                 // was en route, now stopped (arrived or path ran out) → hold where it is
      if (setPathTo({ x: pl.tx, y: pl.ty })) { pl.started = true; self.goal = 'social'; }   // begin the walk (path set → walk block advances it next)
      else enterHold(now, pl);                                                        // unreachable → hold in place (never strand the slot)
      return;
    }
    if (pl.phase === 'hold') {
      self.state = 'idle'; self.sitting = false;
      if (pl.faceTile === 'partner') facePartner();
      else if (pl.faceTile) self.dir = dirToward(self.px, self.py, (pl.faceTile.x + 0.5) * T, (pl.faceTile.y + 0.5) * T);
      if (now >= pl.until) endEncounter(now);                                         // natural end → free the slot + arm the pair cooldown
    }
  }
  // enter the silent face-each-other hold (varied duration). Both bodies enter their own hold independently; the
  // encounter ends when EITHER reaches its `until` (endEncounter frees both) — a hard cap already bounds it.
  function enterHold(now, pl) {
    pl.phase = 'hold'; pl.until = now + U.irnd(SOCIAL_HOLD_MIN, SOCIAL_HOLD_MAX);
    self.pathPts = null; self.target = null; self.state = 'idle'; self.goal = 'social';
  }

  /* stepSocialGuard — called every tick for a body whose goal==='social', BEFORE stepSocial. Enforces the two
     global safety nets: (1) whole-encounter hard timeout (G4 — the slot frees no matter what), and (2) the
     partner-broken check (K3 — if the OTHER party was seized/despawned/chat-focused, the survivor releases now
     rather than waiting forever at a rendezvous). Returns true if it handled (ended) the beat this tick. */
  function stepSocialGuard(now) {
    if (!socialBeat) { if (self.social) { self.social = null; if (self.goal === 'social') { self.goal = null; self.state = 'idle'; self.idleUntil = now + 300; } } return true; }
    if (now >= socialBeat.until || encounterBroken(now)) { endEncounter(now); return true; }
    return false;
  }

  /* maybeSocial — SELECTION hook, called from decideIdle at the existing idle cadence with self = the deciding
     idle body (K4: never triggered by observing another encounter — only off neighborsOf at re-decide time). Rolls
     rarely (SOCIAL_SEL_ROLL) and only when: the station gate is open (crewBeatDamp — shared G5 budget), no encounter
     is live (G4), self is eligible, and a concrete candidate pair exists. Tries the beats in order; the first that
     assembles a zone-legal plan wins. reduceMotion → no walking beats (degrade to Tier C: return false, let the
     normal gaze life run). Returns true iff an encounter was started (⇒ decideIdle stops). */
  function maybeSocial(now) {
    if (reduceMotion()) return false;                                    // reduceMotion: no walking social beats (Tier C glances only)
    if (socialBeat) return false;                                        // G4: one live encounter
    if (chaseId != null) return false;                                   // TIER D · D4: mutual exclusion — no social beat while THE CHASE is live (one noticeable station-level thing at a time, from EITHER body's decideIdle)
    if (self.social) return false;                                       // already in one (defensive)
    if (!socialEligible(self, now)) return false;
    if (now < socialGateUntil) return false;                             // TIER D · D3 LANE: social has its OWN station cooldown (5-8min) — decoupled from the quirk-gate race so the RATE is governed here, not by whoever wins the shared gate. RNG-free (N=1 parity preserved). A fired encounter STILL arms the shared gate (armBeat) so total station calm holds.
    // in-sight SAME-ZONE neighbors (Tier C read-only scan) + whether ANY other placed body exists (adjacent-zone
    // border candidates aren't same-zone, so the border precheck scans allBodies). CRITICAL N=1 PARITY (hunt 6):
    // the U.chance roll is gated BEHIND candidate existence — a solo floor (no other body) returns here BEFORE the
    // roll, so it consumes ZERO extra RNG draws and stays byte-identical to pre-D3 (U.* are independent Math.random
    // wrappers, so a skipped draw shifts nothing). No candidate ⇒ no roll ⇒ provable no-op.
    const near = neighborsOf(self, SOCIAL_NEAR_RADIUS);
    const anyOther = allBodies().some(b => b !== self && !b.unplaced);   // is there any OTHER placed body at all (border candidates aren't same-zone)?
    if (!near.length && !anyOther) return false;                         // no same-zone neighbor AND no other placed body → not a candidate; skip the roll (N=1 parity: solo floor never rolls)
    if (!U.chance(SOCIAL_SEL_ROLL)) return false;                        // RARE (only reached when a real candidate could exist)
    // 1) WATCH-A-PEER-WORK: a WORKING neighbor in my zone → stand ~2 tiles behind it, face its desk.
    for (const w of near) {
      if (!(w.working)) continue;
      if (pairOnCd(self.id, w.id, now)) continue;
      if (planWatch(self, w, now)) return true;
    }
    // 2) HUDDLE: an eligible same-zone idle neighbor → converge to adjacent tiles.
    const idleCands = near.filter(o => socialEligible(o, now) && !pairOnCd(self.id, o.id, now));
    if (idleCands.length && planHuddle(self, U.pick(idleCands), now)) return true;
    // 3) HALF-FOLLOW: a WALKING body passing nearby (may be tasked/idle-walking) → half-follow its path.
    for (const w of near) {
      if (w.state !== 'walk') continue;
      if (pairOnCd(self.id, w.id, now)) continue;
      if (planFollow(self, w, now)) return true;
    }
    // 4) BORDER MEETING: an eligible idle body in an ADJACENT zone with a shared edge → meet at the border.
    if (planBorderMeeting(self, now)) return true;
    return false;
  }

  // ---- per-kind plan builders (each returns true iff it armed a zone-legal encounter) ----

  // HUDDLE: pick a walkable in-zone tile for each body that is ADJACENT to the other's approach, so they end up
  // facing each other a tile apart. Simplest robust form: each walks to a tile adjacent to the midpoint, inside its
  // OWN zone. We resolve concrete tiles so both plans are fixed at initiation (K2 — no mid-tick partner reads for the target).
  function planHuddle(a, b, now) {
    const zA = zoneFor(a), zB = zoneFor(b);
    const ca = tileOf(a.px, a.py), cb = tileOf(b.px, b.py);
    const mx = Math.round((ca.x + cb.x) / 2), my = Math.round((ca.y + cb.y) / 2);
    const ta = nearestWalkableInZone(zA, mx, my, ca, 4);
    if (!ta) return false;
    // b aims for a tile adjacent to a's target, still in b's own zone (so they end up ~1 tile apart, facing)
    const tb = nearestWalkableInZone(zB, ta.x, ta.y, cb, 4, ta);   // exclude a's exact tile
    if (!tb) return false;
    return startEncounter(a, b, 'huddle', now,
      { phase: 'walk', tx: ta.x, ty: ta.y, faceTile: 'partner' },
      { phase: 'walk', tx: tb.x, ty: tb.y, faceTile: 'partner' });
  }

  // WATCH-A-PEER-WORK: stand ~2 tiles behind the worker (on the side away from its desk facing), inside the
  // observer's zone, and face the worker's desk. Only the observer moves; the worker keeps working untouched.
  function planWatch(obs, worker, now) {
    if (pairOnCd(obs.id, worker.id, now)) return false;
    const zone = zoneFor(obs);
    const wt = tileOf(worker.px, worker.py);
    // "behind" = the direction from the worker back toward the observer (so it approaches from where it already is)
    const dx = Math.sign(obs.px - worker.px) || 0, dy = Math.sign(obs.py - worker.py) || 0;
    const cands = [];
    for (const dist of [2, 3, 1]) cands.push({ x: wt.x + dx * dist, y: wt.y + dy * dist });
    cands.push({ x: wt.x + 2, y: wt.y }, { x: wt.x - 2, y: wt.y }, { x: wt.x, y: wt.y + 2 }, { x: wt.x, y: wt.y - 2 });
    const oc = tileOf(obs.px, obs.py);
    for (const c of cands) {
      if (!tileInZone(zone, c.x, c.y) || !geo.walkable(c.x, c.y, blocked)) continue;
      if (c.x === wt.x && c.y === wt.y) continue;
      // observer-only encounter: the worker has NO social plan (it keeps working). Use a one-sided beat: give the
      // worker a null plan but still register the slot so no other encounter starts. endEncounter tolerates a
      // partner with no social plan (it just won't tear anything down for it).
      if (socialBeat) return false;
      obs.social = { phase: 'walk', tx: c.x, ty: c.y, faceTile: { x: wt.x, y: wt.y }, kind: 'watch', partnerId: worker.id };
      obs.goal = 'social'; obs.stilling = false; obs.usingProp = null; obs.sitting = false; obs.pauseUntil = 0; obs.pauseLook = null; obs.studyKey = null;
      socialBeat = { kind: 'watch', aId: obs.id, bId: worker.id, until: now + SOCIAL_HARD_MS };
      armSocialBudget(now);   // shared-gate arm + social LANE draw (same as startEncounter — one-sided beats govern the lane too)
      return true;
    }
    return false;
  }

  // HALF-FOLLOW: begin trailing the walking body. The observer gets a 'follow' plan with a step budget; stepSocial
  // takes it 2-4 tiles toward the (moving) partner, zone-clamped, then STOPS (never completes). One-sided: the
  // walker has no plan (it's just passing through / on its own task).
  function planFollow(obs, walker, now) {
    if (socialBeat) return false;
    const zone = zoneFor(obs);
    const oc = tileOf(obs.px, obs.py), wc = tileOf(walker.px, walker.py);
    // first step toward the walker, in-zone
    const sx = Math.sign(wc.x - oc.x), sy = Math.sign(wc.y - oc.y);
    let first = null;
    for (const [dx, dy] of [[sx, sy], [sx, 0], [0, sy]]) {
      if (!dx && !dy) continue;
      const tx = oc.x + dx, ty = oc.y + dy;
      if (tileInZone(zone, tx, ty) && geo.walkable(tx, ty, blocked)) { first = { x: tx, y: ty }; break; }
    }
    if (!first) return false;
    obs.social = { phase: 'walk', tx: first.x, ty: first.y, faceTile: 'partner', kind: 'follow', partnerId: walker.id, followLeft: U.irnd(SOCIAL_FOLLOW_MIN, SOCIAL_FOLLOW_MAX) };
    obs.goal = 'social'; obs.stilling = false; obs.usingProp = null; obs.sitting = false; obs.pauseUntil = 0; obs.pauseLook = null; obs.studyKey = null;
    if (!setPathTo({ x: first.x, y: first.y })) { obs.social = null; obs.goal = null; return false; }
    obs.social.followLeft -= 1;
    socialBeat = { kind: 'follow', aId: obs.id, bId: walker.id, until: now + SOCIAL_HARD_MS };
    armSocialBudget(now);   // shared-gate arm + social LANE draw (same as startEncounter)
    return true;
  }

  /* BORDER MEETING: find an eligible idle body in an ADJACENT zone (a shared rect edge exists), then send each body
     to the nearest walkable tile of the shared edge INSIDE ITS OWN zone (never a crossing — G3 staged, not hidden).
     Shared-edge geometry is computed directly from the two zone rects (no zones.js API change). A zone that isn't a
     single rect ('leash'/'multi') can't cleanly express a shared edge → those pairs simply aren't border candidates
     (documented skip, not a zones.js edit). */
  function planBorderMeeting(a, now) {
    const zA = zoneFor(a);
    const ra = zoneRect(zA); if (!ra) return false;                      // only single-rect (room) zones border-meet
    for (const b of allBodies()) {
      if (b === a) continue;
      if (!socialEligible(b, now) || pairOnCd(a.id, b.id, now)) continue;
      const zB = zoneFor(b); const rb = zoneRect(zB); if (!rb) continue;
      const edge = sharedEdge(ra, rb); if (!edge) continue;              // no shared edge → not a border pair
      // each body walks to the nearest tile of the shared line INSIDE its own rect
      const walk = (x, y) => geo.walkable(x, y, blocked);   // injected so borderTileFor stays pure (headless-testable)
      const ta = borderTileFor(ra, edge, tileOf(a.px, a.py), walk);
      const tb = borderTileFor(rb, edge, tileOf(b.px, b.py), walk);
      if (!ta || !tb) continue;
      if (!tileInZone(zA, ta.x, ta.y) || !tileInZone(zB, tb.x, tb.y)) continue;   // belt-and-suspenders containment
      return startEncounter(a, b, 'border', now,
        { phase: 'walk', tx: ta.x, ty: ta.y, faceTile: 'partner' },
        { phase: 'walk', tx: tb.x, ty: tb.y, faceTile: 'partner' });
    }
    return false;
  }
  // the single normalized rect of a 'room' zone, else null (leash/multi don't express a clean shared edge)
  function zoneRect(zone) { return (zone && zone.kind === 'room' && zone.rect) ? zone.rect : null; }
  /* D3-PURE-GEOMETRY-BEGIN — sharedEdge + borderTileFor are PURE (no module state, no RNG, no DOM; the walkable
     test is injected). test/social-border.test.js extracts THIS marked block from the source and executes it
     headlessly (the world IIFE itself can't load under node), so the shipped code — not a copy — is what's under
     test. Keep this block self-contained: only Math.* + its own params. Also exposed read-only on the World API
     as _dbgSocialGeom for the in-browser dev harness. */
  // shared edge between two inclusive rects that are ADJACENT (abut along a full or partial line). Returns
  // { axis:'v'|'h', line, lo, hi } — a vertical shared edge at column `line` spanning rows lo..hi (or horizontal).
  // Adjacency = the rects touch along one line (one's right edge == the other's left edge (±0/1), overlapping span).
  function sharedEdge(ra, rb) {
    // vertical edge: ra is left of rb (ra.x2 abuts rb.x1) or vice-versa
    const vpairs = [[ra, rb], [rb, ra]];
    for (const [l, r] of vpairs) {
      if (Math.abs(l.x2 - r.x1) <= 1 || l.x2 + 1 === r.x1 || l.x2 === r.x1) {
        const lo = Math.max(l.y1, r.y1), hi = Math.min(l.y2, r.y2);
        if (hi >= lo && (l.x2 + 1 === r.x1 || l.x2 === r.x1 || Math.abs(l.x2 - r.x1) <= 1)) return { axis: 'v', line: l.x2, lo, hi, lx: l.x2, rx: r.x1 };
      }
    }
    // horizontal edge: l above r (l.y2 abuts r.y1)
    for (const [t, b] of [[ra, rb], [rb, ra]]) {
      if (t.y2 + 1 === b.y1 || t.y2 === b.y1 || Math.abs(t.y2 - b.y1) <= 1) {
        const lo = Math.max(t.x1, b.x1), hi = Math.min(t.x2, b.x2);
        if (hi >= lo) return { axis: 'h', line: t.y2, lo, hi, ty: t.y2, by: b.y1 };
      }
    }
    return null;
  }
  // nearest walkable tile of `rect` along the shared edge (inside rect), closest to the body's current tile.
  // `walkableFn(x,y)` is injected so the function stays pure (callers pass the live geo.walkable+blocked).
  function borderTileFor(rect, edge, cur, walkableFn) {
    const cands = [];
    if (edge.axis === 'v') {
      // the column of THIS rect that sits on the shared edge: rect.x2 if rect is the left one, else rect.x1
      const col = (rect.x2 === edge.lx) ? rect.x2 : ((rect.x1 === edge.rx) ? rect.x1 : (Math.abs(rect.x2 - edge.line) <= 1 ? rect.x2 : rect.x1));
      for (let y = edge.lo; y <= edge.hi; y++) cands.push({ x: col, y });
    } else {
      const row = (rect.y2 === edge.ty) ? rect.y2 : ((rect.y1 === edge.by) ? rect.y1 : (Math.abs(rect.y2 - edge.line) <= 1 ? rect.y2 : rect.y1));
      for (let x = edge.lo; x <= edge.hi; x++) cands.push({ x, y: row });
    }
    cands.sort((p, q) => (Math.abs(p.x - cur.x) + Math.abs(p.y - cur.y)) - (Math.abs(q.x - cur.x) + Math.abs(q.y - cur.y)));
    for (const c of cands) if (walkableFn(c.x, c.y)) return c;
    return null;
  }
  /* D3-PURE-GEOMETRY-END */
  // nearest walkable in-zone tile to (tx,ty), searching a small ring; `cur` biases toward reachability; `excl` an
  // optional tile to skip (so a huddle partner doesn't target the same tile). Deterministic ring scan (no RNG).
  function nearestWalkableInZone(zone, tx, ty, cur, radius, excl) {
    for (let r = 0; r <= radius; r++) {
      const ring = [];
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // only the ring at Chebyshev distance r
        ring.push({ x: tx + dx, y: ty + dy });
      }
      ring.sort((p, q) => (Math.abs(p.x - cur.x) + Math.abs(p.y - cur.y)) - (Math.abs(q.x - cur.x) + Math.abs(q.y - cur.y)));
      for (const c of ring) {
        if (excl && c.x === excl.x && c.y === excl.y) continue;
        if (tileInZone(zone, c.x, c.y) && geo.walkable(c.x, c.y, blocked)) return c;
      }
    }
    return null;
  }

  /* ================= TIER D · D4 — THE CURSOR IS A CREATURE (mimic + THE CHASE) =================
     Both beats build on the EXISTING Commander-presence stack (lastCursor + cursorMoveT) — NO second cursor
     tracker. They ride the goal/hold machinery ('mimic'/'chase'), not a new state family, so summon-seize,
     chat-focus, and social exclusion all compose. Cursor freshness = lastCursor.t within 8s; cursor MOVING =
     cursorMoveT within 1.5s (real displacement, not mere presence). All U.* + cursor input only (G6). */
  const CURSOR_FRESH_MS = 8000;           // shared freshness window (matches ambientGazeDir / THE LOOK-UP)
  const CURSOR_MOVING_MS = 1500;          // "actively moving" = a real displacement stamped within this window

  // eligible to be pulled into a D4 cursor beat right now? idle, placed, not chat-focused, not already in a
  // social/mimic/chase hold. Reuses bodyIsIdle (excludes tasked/walking/mid-goal). Read-only.
  function cursorBeatEligible(b, now) {
    if (!b || b.unplaced || b.social || b.chase) return false;
    if (b.goal != null) return false;                              // any held goal suppresses it (never yank a deliberate beat)
    if (chatHot(now) && b === chatFocusBody()) return false;       // chat-stare exclusion (D1): HOT focus only — a cold-focused body may mimic/chase (it's living its life)
    return bodyIsIdle(b, now);
  }

  /* ---- BEAT 2 — CURSOR-MIMIC (head-only follow; rare, quirk-band) ----
     An IDLE body TRACKS the moving cursor with continuously-updated FACING for 3-6s (a follow, not one glance),
     then snaps away and resumes. No movement — facing only (rides self.goal='mimic', stepped every tick). Cursor
     must be fresh at start AND stay fresh (stale mid-beat → end early). Per-body cooldown in the quirk band
     (45-90s); consults + arms the D2 station gate (crewBeatDamp/armBeat) so it shares the calm budget. reduceMotion
     → degrade to a single glance. Selected from decideIdle at the idle cadence (self = the deciding body). */
  const MIMIC_MIN_MS = 3000, MIMIC_MAX_MS = 6000;
  const MIMIC_CD_MIN = 45000, MIMIC_CD_MAX = 90000;   // quirk-cooldown band (per-body)
  const MIMIC_SEL_ROLL = 0.03;                        // rare (a quirk-band beat), only rolled when cursor is fresh + body eligible
  function maybeMimic(now) {
    if (!cursorBeatEligible(self, now)) return false;
    if (now < (self.mimicCd || 0)) return false;                  // per-body quirk-band cooldown
    if ((now - lastCursor.t) >= CURSOR_FRESH_MS) return false;    // cursor must be fresh at START
    if (crewBeatDamp(now) === 0) return false;                    // G5: station calm budget (no-op for hero)
    if (reduceMotion()) {                                          // reduceMotion: degrade the follow to ONE glance toward you
      const dir = dirToward(self.px, self.py, lastCursor.wx, lastCursor.wy);
      setGlance(dir === 'north' ? 'south' : dir, U.irnd(600, 1000), now);
      self.mimicCd = now + U.irnd(MIMIC_CD_MIN, MIMIC_CD_MAX);
      armBeat(now);
      return true;
    }
    if (!U.chance(MIMIC_SEL_ROLL)) { self.mimicCd = now + U.irnd(8000, 16000); return false; }   // miss → short re-scan gap (no per-tick re-roll storm)
    self.goal = 'mimic'; self.stilling = false; self.usingProp = null; self.sitting = false; self.state = 'idle';
    self.mimic = { until: now + U.irnd(MIMIC_MIN_MS, MIMIC_MAX_MS) };
    self.mimicCd = now + U.irnd(MIMIC_CD_MIN, MIMIC_CD_MAX);
    self.trackUntil = 0; self.glance = null;                      // attention is on YOU — drop any in-flight box-track / head-turn
    armBeat(now);                                                 // a noticeable beat — count it against the station budget (G5)
    stepMimic(now);                                               // face you THIS tick (no one-frame lag)
    return true;
  }
  // per-tick stepper for goal==='mimic': keep facing the cursor while it's fresh; end (snap away) on time or staleness.
  function stepMimic(now) {
    const pl = self.mimic; if (!pl) { if (self.goal === 'mimic') { self.goal = null; self.state = 'idle'; } return; }
    const stale = (now - lastCursor.t) >= CURSOR_FRESH_MS;
    if (now >= pl.until || stale) { endMimic(now, !stale); return; }   // time up (snap away) or cursor gone (just release)
    let dir = dirToward(self.px, self.py, lastCursor.wx, lastCursor.wy);
    if (dir === 'north') dir = 'south';                           // never turn its back on you — the face is the point (mirrors THE LOOK-UP)
    self.dir = dir; self.state = 'idle';
  }
  // end the mimic: on a natural time-up, SNAP AWAY to a cardinal that isn't the cursor (the "it looked, then
  // dismissed you" beat); on a stale-cursor end, just release. Clears the plan + goal → idle.
  function endMimic(now, snap) {
    const pl = self.mimic; self.mimic = null;
    if (snap && pl) { const away = U.pick(['east', 'west', 'north']); self.dir = away; setGlance(away, U.irnd(400, 800), now); }
    if (self.goal === 'mimic') { self.goal = null; self.state = 'idle'; self.idleUntil = now + U.irnd(600, 1400); }
  }

  /* ---- BEAT 3 — THE CHASE (the headline; ultra-rare) ----
     An idle body breaks toward the cursor and PURSUES it (repathing ~1/s so it lags like a real pursuer) for
     3-6s, then STOPS and stares at where the cursor was (2-4s), then walks off as if nothing happened. Rarity
     is sacred: a LONG station cooldown (8-15 min), one chaser EVER (chaseId), mutually exclusive with a live
     social beat (socialBeat), only considered when the D2 gate is open + cursor fresh AND actively MOVING. If
     the cursor leaves the chaser's zone mid-chase → halt at the clamped boundary tile and stare across the
     border, then release. reduceMotion → no chase (degrade to the mimic's single glance). */
  const CHASE_MIN_MS = 3000, CHASE_MAX_MS = 6000;         // pursuit duration (hard cap)
  const CHASE_STARE_MIN = 2000, CHASE_STARE_MAX = 4000;   // the held stare at where the cursor was
  const CHASE_HARD_MS = 15000;                            // absolute whole-beat timeout (belt-and-suspenders)
  const CHASE_REPATH_MS = 1000;                           // low repath cadence → it LAGS the cursor (a real pursuer)
  const CHASE_GATE_MIN = 480000, CHASE_GATE_MAX = 900000; // 8-15 min station cooldown between chases (RARITY IS SACRED)
  // roll THE CHASE. Selected from decideIdle at the idle cadence with self = the deciding idle body. Returns true
  // iff a chase was armed (⇒ decideIdle stops). Most sessions return false forever — that is correct.
  function maybeChase(now) {
    if (reduceMotion()) return false;                            // reduceMotion → no chase (mimic already gave a single glance)
    if (chaseId != null) return false;                          // one chaser EVER (station-level)
    if (socialBeat) return false;                              // mutually exclusive with a live social beat (one noticeable thing at a time)
    if (now < chaseGateUntil) return false;                    // LONG station cooldown — the rarity backbone
    if (crewBeatDamp(now) === 0) return false;                 // only when the D2 station gate is open (G5)
    if (!cursorBeatEligible(self, now)) return false;          // idle, placed, goal==null, not chat-focused, not already in a beat
    if ((now - lastCursor.t) >= CURSOR_FRESH_MS) return false; // cursor must be FRESH
    if ((now - cursorMoveT) >= CURSOR_MOVING_MS) return false; // AND actively MOVING (recent real displacement, not mere presence)
    // arm the chase. Draw the LONG station cooldown NOW (from chase start) so nothing re-rolls for minutes.
    chaseId = self.id; chaseGateUntil = now + U.irnd(CHASE_GATE_MIN, CHASE_GATE_MAX);
    self.goal = 'chase'; self.stilling = false; self.usingProp = null; self.sitting = false; self.state = 'idle';
    self.chase = { phase: 'pursue', endAt: now + U.irnd(CHASE_MIN_MS, CHASE_MAX_MS), hardUntil: now + CHASE_HARD_MS, repathAt: now, faceX: lastCursor.wx, faceY: lastCursor.wy, border: false };
    self.trackUntil = 0; self.glance = null;
    armBeat(now);                                               // a noticeable beat (G5)
    return true;
  }
  // per-tick stepper for goal==='chase'. Repaths toward the cursor's CURRENT tile at a low cadence (re-clamping
  // to the chaser's zone EVERY repath — the cursor moves, so a one-time clamp isn't enough), then STOP + stare.
  function stepChase(now) {
    const pl = self.chase; if (!pl) { if (self.goal === 'chase') { self.goal = null; self.state = 'idle'; } return; }
    if (now >= pl.hardUntil) { endChase(now); return; }                         // absolute cap — always frees
    const stale = (now - lastCursor.t) >= CURSOR_FRESH_MS;
    if (pl.phase === 'pursue') {
      if (stale) { pl.phase = 'stare'; pl.until = now + U.irnd(CHASE_STARE_MIN, CHASE_STARE_MAX); self.pathPts = null; self.target = null; self.state = 'idle'; return; }   // cursor gone → immediate stop + stare (at its last spot)
      if (now >= pl.endAt) { pl.phase = 'stare'; pl.until = now + U.irnd(CHASE_STARE_MIN, CHASE_STARE_MAX); pl.faceX = lastCursor.wx; pl.faceY = lastCursor.wy; self.pathPts = null; self.target = null; self.state = 'idle'; return; }   // pursuit done → stop + stare at where you were
      if (self.state === 'walk' || self.target) return;                          // still walking a leg — let the walk machinery advance it
      if (now < pl.repathAt) { self.state = 'idle'; return; }                     // between repaths → stand a beat (lags the cursor)
      pl.repathAt = now + CHASE_REPATH_MS;
      const zone = zoneFor(self);
      const cur = tileOf(self.px, self.py);
      const ct = tileOf(lastCursor.wx, lastCursor.wy);                            // the cursor's CURRENT world tile
      pl.faceX = lastCursor.wx; pl.faceY = lastCursor.wy;                         // remember the live cursor spot for the eventual stare
      if (tileInZone(zone, ct.x, ct.y) && geo.walkable(ct.x, ct.y, blocked)) {
        pl.border = false;
        if (!(cur.x === ct.x && cur.y === ct.y)) setPathTo({ x: ct.x, y: ct.y }); // in-zone → chase the real tile
      } else {
        // cursor is OUTSIDE the chaser's zone → clamp to the nearest in-zone walkable tile toward it (the border),
        // then STOP there and stare out across the boundary (the containment beat again).
        const clamp = nearestWalkableInZone(zone, ct.x, ct.y, cur, 6);
        if (clamp && !(cur.x === clamp.x && cur.y === clamp.y)) { pl.border = true; pl.borderTx = clamp.x; pl.borderTy = clamp.y; setPathTo({ x: clamp.x, y: clamp.y }); }
        else { pl.phase = 'stare'; pl.until = now + U.irnd(CHASE_STARE_MIN, CHASE_STARE_MAX); self.pathPts = null; self.target = null; self.state = 'idle'; }   // already at the boundary → stare out now
      }
      return;
    }
    // phase 'stare': stand at where it stopped, face where the cursor was (or its actual position for a border
    // stare — face toward the real cursor across the line), hold, then release to normal idle.
    self.state = 'idle'; self.sitting = false;
    self.dir = dirToward(self.px, self.py, pl.faceX, pl.faceY);
    if (now >= (pl.until || 0)) endChase(now);
  }
  // free THE CHASE: clear the station chaser lock + this body's plan/goal → idle. Idempotent. The long station
  // cooldown was drawn at chase START (maybeChase), so endChase does NOT re-draw it.
  function endChase(now) {
    if (chaseId != null && self && self.id === chaseId) chaseId = null;
    if (self) { self.chase = null; if (self.goal === 'chase') { self.goal = null; self.state = 'idle'; self.pathPts = null; self.target = null; self.idleUntil = now + U.irnd(800, 1800); } }
  }
  // STATION-LEVEL CHASE SWEEP (mirrors the social slot sweep) — run every tick from the hero tick(), independent
  // of the chaser's own stepper, so a summoned / despawned / chat-focused chaser ALWAYS frees the lock same-tick.
  // Reads only; the actual clear happens by re-pointing self to the chaser (endChaseFor) so the plan is torn down.
  function sweepChase(now) {
    if (chaseId == null) return;
    const c = bodyForAgent(chaseId);
    let broken = false;
    if (!c || c.unplaced) broken = true;                                          // despawned
    else if (c.goal !== 'chase' || !c.chase) broken = true;                       // plan cleared out from under us
    else if (c.working) broken = true;                                            // crew run seized it
    else if (c === agent && activity === 'task') broken = true;                   // hero got summoned
    else if (chatHot(now) && c === chatFocusBody()) broken = true;                // pulled into a LIVE (hot) chat-stare — a warm re-engage mid-chase seizes attention; a cold focus does NOT break the chase (the body is living its life)
    if (!broken) return;
    // tear the chaser's plan down on the correct body (endChase mutates `self`); restore self after.
    const keep = self; self = c || agent; endChase(now); self = keep;
    if (!c || c.unplaced) chaseId = null;                                          // despawn: force-clear the lock even if the body is gone
  }

  // CURSOR GAZE-DRIFT: a slice of the ambient idle glances drift toward the Commander's cursor — the quiet
  // Petz "it knows where you are". RETUNED 2026-07-02 (design call: "not constantly following the mouse, only so
  // often"): at the old shares (hero 0.32 / crew 0.15) an actively-moving cursor stayed fresh continuously, so
  // roughly a third of ALL ambient glances (which re-fire every ~4-11s) pointed at the mouse — it read as
  // tracking, not noticing. Now a cursor-directed ambient glance is (a) rarer per roll (0.12 / 0.06) and
  // (b) throttled by a per-body cooldown (one cursor glance per ~20-45s at most), so even under constant mousing
  // it's an occasional flick of attention. The deliberate follow moments stay where they belong: the rare D4
  // cursor-mimic beat and the HOT chat-stare (both separately gated).
  function ambientGazeDir(now) {
    // Crew keep a smaller share than the hero (the hero stays the most Commander-attuned). This is the ONLY
    // spot crew ambient facing is randomized (via lookAround/standStill), so it never fights a held goal, a
    // glance, a chat-stare, or work facing (those don't route through here). Ambient TEXTURE, not a noticeable
    // beat → NOT gated by the D2 station budget (G5). cursorGazeCd is undefined on fresh bodies → `|| 0` = ready.
    const drift = self === agent ? 0.12 : 0.06;
    if ((now - lastCursor.t) < 8000 && now >= (self.cursorGazeCd || 0) && U.chance(drift)) {
      self.cursorGazeCd = now + U.irnd(20000, 45000);
      return dirToward(self.px, self.py, lastCursor.wx, lastCursor.wy);
    }
    return U.pick(['east', 'west', 'south', 'north']);
  }

  // go inspect the freshest queued placement (pops the queue; tries each until one is reachable)
  function planInspect(now) {
    const zone = zoneFor(self);   // P1: never walk OUT of the zone to inspect (defensive even though the queue is zone-filtered at enqueue)
    while (novelty.length) {
      const n = novelty.pop();
      let foot = { x: n.tx, y: n.ty, w: 1, h: 1 };
      if (n.kind === 'prop' && n.pid && geo.props) { const p = geo.props.find(q => q.id === n.pid); if (!p || !mayTouchProp(self.id, p)) continue; foot = p; }
      const extra = n.kind === 'belt' ? beltUnion() : blocked;   // for a belt, stand beside it — not on the machinery
      const a = PropAnchor.deriveAnchor(foot, geo, { approach: 'auto', extra });
      if (a && tileInZone(zone, a.tx, a.ty) && setPathTo({ x: a.tx, y: a.ty })) {
        self.goal = 'inspect'; self.useFace = a.face; self.usingProp = null; self.inspectNovel = true;
        self.studyKey = n.kind === 'belt' ? ('belt:' + n.tx + ',' + n.ty) : n.pid;
        if (!self.target) arrive(now);
        return true;
      }
    }
    return false;
  }

  // ambient curiosity (no fresh placement): study a machine or watch a belt go by
  function planPOI(now) {
    const zone = zoneFor(self);   // P1: study/watch only kit reachable inside the zone
    const cands = [];
    const belts = (geo && geo.belts) || [];
    // pick a belt tile that is itself in-zone (the body stands BESIDE it, but an in-zone belt keeps the approach in-zone)
    const inBelts = belts.filter(b => tileInZone(zone, b.x, b.y));
    if (inBelts.length) { const b = inBelts[U.irnd(0, inBelts.length - 1)]; cands.push({ kind: 'watch', key: 'belt:' + b.x + ',' + b.y, foot: { x: b.x, y: b.y, w: 1, h: 1 }, extra: beltUnion() }); }
    const props = (geo && geo.props) || [];
    // non-leisure kit (leisure is planProp's job), skipping the over-familiar — it has become furniture (habituation); in-zone only
    const machines = props.filter(p => { const s = specOf(p.t); return s && !s.use && s.blocks && (seenCount.get(p.id) || 0) < 4 && mayTouchProp(self.id, p) && tileInZone(zone, p.x, p.y); });
    if (machines.length) { const p = machines[U.irnd(0, machines.length - 1)]; cands.push({ kind: 'inspect', key: p.id, foot: p, extra: blocked }); }
    if (cands.length === 2 && U.chance(0.5)) cands.reverse();
    for (const c of cands) {
      const a = PropAnchor.deriveAnchor(c.foot, geo, { approach: 'auto', extra: c.extra });
      if (a && tileInZone(zone, a.tx, a.ty) && setPathTo({ x: a.tx, y: a.ty })) {
        self.goal = c.kind; self.useFace = a.face; self.usingProp = null; self.inspectNovel = false; self.studyKey = c.key;
        if (!self.target) arrive(now);
        return true;
      }
    }
    return false;
  }

  // pan the gaze around without moving — "taking the place in"
  function lookAround(now) {
    const dir = ambientGazeDir(now);
    setGlance(dir, U.irnd(600, 1100), now); self.dir = dir;
    self.idleUntil = now + U.irnd(2200, 4200);
    if (U.chance(0.15)) curiositySay(CURIO_LOOK, 1, now);
  }
  // CONTENT = STILL: the calm default — just be here, holding the facing, genuinely motionless for a long beat.
  // maybeGlance's `stilling` early-out suppresses the ambient swivel AND the cargo body-track, so it's true stillness.
  function standStill(now) {
    self.goal = null; self.stilling = true; self.usingProp = null; self.state = 'idle';
    self.glance = null; self.trackUntil = 0;   // drop any in-flight head-turn / box-track so nothing bleeds into the hold
    self.idleUntil = now + offbeat(now, U.irnd(4500, 9000));
  }
  /* TIER D · D1 ATTENTIVE AUDIENCE — the chat-stare hold. While the Commander has COMMS focus on THIS body
     (self === chatFocusBody()) and the body is genuinely idle, it drops its wander/quirk/social life, stands
     genuinely still (reusing the CONTENT=STILL `stilling` machinery — same as standStill), and HOLDS its
     attention on the Commander: facing south, drifting toward lastCursor while the cursor is fresh (<8s) so it
     tracks you around the screen. ONE tracker — reuses the existing dirToward(→lastCursor) pattern, no second
     cursor sampler. Called TWO ways: (a) as an early-out from decideIdle so the body never CHOOSES to wander
     while held, and (b) every tick as a HOLD from the hero tick / crewEngineStep idle branch so the facing keeps
     tracking the cursor between idle decisions (crew have no maybeGlance, so the hold drives facing directly).
     Returns true when it took/holds the body. G2: reachable ONLY while free (never while activity==='task' /
     working / walking / mid-goal) — it sits BELOW the summon-seize, which the callers gate for us. */
  /* CHAT-STARE-TRACK-PURE-BEGIN — the chat-stare follow-beat throttle, extracted PURE (params + injected rnd
     only; no module state / RNG / DOM) so its cadence is unit-testable headlessly. WHY headless: the game tick is
     rAF-driven and a backgrounded CDP/preview tab freezes rAF to 0fps, so "mostly faces the Commander, only rarely
     follows the cursor" cannot be observed live — test/chat-stare-throttle.test.js extracts THIS marked block from
     source and executes it (same spirit as the D3-PURE-GEOMETRY block). Decides the chat-stare facing SOURCE —
     'commander' (face south, at the Commander) vs 'cursor' (turn to the live cursor) — and advances the per-body
     follow schedule on `b`: b.chatTrackCd = earliest time the next follow beat may open; b.chatTrackUntil = end of
     the currently-open beat. `fresh` = cursor seen within the freshness window; `reduce` = reduceMotion. rnd(lo,hi)
     is injected (U.irnd in prod) so the block carries no RNG token and stays deterministic-lint clean. */
  function chatStareTrack(b, now, fresh, reduce, rnd) {
    if (reduce) return 'commander';                                              // motion-sensitive: hold the gaze on the Commander, never chase the cursor
    if (b.chatTrackCd == null) { b.chatTrackCd = now + rnd(8000, 20000); return 'commander'; }   // first beat is delayed too — don't pounce on the cursor the instant COMMS warms
    if (fresh && now < (b.chatTrackUntil || 0)) return 'cursor';                 // mid-beat: keep following the live cursor for this short window
    if (fresh && now >= b.chatTrackCd) {                                         // cooldown elapsed + a fresh cursor → open a brief follow beat...
      b.chatTrackUntil = now + rnd(1200, 2500);
      b.chatTrackCd = b.chatTrackUntil + rnd(16000, 34000);                      // ...then a long cooldown before it may follow the cursor again
      return 'cursor';
    }
    return 'commander';                                                          // the steady state: attention on the Commander, not the mouse
  }
  /* CHAT-STARE-TRACK-PURE-END */
  function chatStareHold(now) {
    if (!self || !chatHot(now) || self !== chatFocusBody()) return false; // not the HOT-focused body → normal life. chatHot = focus set + warm (the ONE shared predicate — same definition the socialEligible/cursorBeatEligible exclusions, encounterBroken, and sweepChase key on). Cold → stop holding; the body falls to normal idle (decideIdle clears stilling on entry) and its quirks/social/mimic/chase/wander ALL resume (the exclusions key on hot too)
    if (self === agent && activity !== 'idle') return false;            // G2: working-at-desk (task) wins; and a live VOICE conversation ('talk') keeps its own listening-glances (maybeGlance) — the stare is an IDLE beat only
    if (self.working || self.unplaced) return false;                    // a live run owns the body (crew) — never stare mid-work
    if (self.state === 'walk' || self.target) return false;             // let an in-flight walk finish before holding
    if (self.goal != null && self.goal !== 'stare-chat') return false;  // don't yank it out of a deliberate goal (leisure/inspect/etc.) — it'll fall to the hold on its NEXT free decision
    // hold: genuine stillness + attention on the Commander (reuse the stilling latch so maybeGlance's stilling
    // branch and the cargo body-track stay suppressed for the hero; crew facing is driven directly below).
    self.goal = 'stare-chat'; self.stilling = true; self.usingProp = null; self.state = 'idle'; self.sitting = false;
    self.trackUntil = 0;                                                 // drop any in-flight box-track — attention is on YOU, not cargo
    // ATTENTION, NOT TRACKING (2026-07-08): the warm hold is a STEADY gaze at the Commander (south = facing YOU),
    // punctuated by the RARE cursor-follow beat — never continuous mouse-tracking. Before, any fresh cursor pointed
    // the body at it on EVERY 400ms re-affirm (and the hero re-affirms EVERY tick), so an actively-moving mouse made
    // the focused body follow the cursor for the whole 30–90s warm window, re-warmed on every message — the "it
    // follows the mouse every single time I talk to it" complaint. chatStareTrack now throttles that to a brief
    // beat (~1.2–2.5s) behind a per-body cooldown (~16–34s): under constant mousing it's an occasional flick, per
    // the gaze-drift design call ("not constantly following the mouse, only so often"). Time-based (no per-tick
    // dice), so the hero's every-tick cadence and the crew's ~400ms cadence land in the same rhythm.
    const fresh = (now - lastCursor.t) < 8000;
    const face = chatStareTrack(self, now, fresh, reduceMotion(), U.irnd);   // 'commander' (south, at YOU) vs a rare 'cursor' follow beat; advances self.chatTrackCd / self.chatTrackUntil
    self.dir = face === 'cursor' ? dirToward(self.px, self.py, lastCursor.wx, lastCursor.wy) : 'south';
    if (self.dir === 'north') self.dir = 'south';                       // never turn its back on the Commander — the face is the point (mirrors THE LOOK-UP)
    self.glance = null;                                                 // the whole body faces you; no lingering head-turn bleeding through
    self.idleUntil = now + 400;                                         // re-affirm the hold soon so the cursor beat stays live (cheap; no motion)
    return true;
  }
  // OFF-BEAT HOLD: rarely (and on its own long cooldown) stretch a single dwell to ~2.2x-3.0x — a learned rhythm that
  // suddenly refuses to end. Skipped under reduceMotion so motion-sensitive users keep the normal cadence.
  function offbeat(now, ms) {
    if (reduceMotion()) return ms;
    // J2: per-body off-beat gate — a crew dwell-stretch must NOT throttle hero/siblings (was the shared module global).
    // D2 (G5): a CREW roll is also hard-gated by the station budget (no-op for the hero); a fire arms the station gate.
    if (now >= (self.offbeatCd || 0) && U.chance(0.09 * crewBeatDamp(now))) { self.offbeatCd = now + U.irnd(70000, 140000); armBeat(now); return Math.round(ms * (220 + U.irnd(0, 80)) / 100); }
    return ms;
  }
  /* FIRST LIGHT — the newborn's first autonomous act: hold the gaze, take one slow look at the room it now
     owns, then a single dry first thought, then it just gets on with existing. Driven by studyUntil; every
     phase finite; terminates in goal=null -> decideIdle. maybeGlance is hard-gated off so the sweep is the
     ONLY head motion, and a summon seizes it (the seize block runs before this branch in the tick ladder). */
  function stepFirstWake(now) {
    if (now < agent.studyUntil) return;
    if (agent.wakePhase === 0) {
      if (U.chance(0.15)) {   // rare "finding its feet": one bounded step to an adjacent walkable tile (may no-op)
        const c = tileOf(agent.px, agent.py);
        for (const [ax, ay] of SEAT_NB) { if (geo.walkable(c.x + ax, c.y + ay, blocked)) { setPathTo({ x: c.x + ax, y: c.y + ay }); break; } }
      }
      agent.wakePhase = 1; agent.studyUntil = now + U.irnd(700, 1100); setGlance(U.pick(['east', 'west']), U.irnd(700, 1100), now); return;
    }
    if (agent.wakePhase === 1) { agent.wakePhase = 2; agent.studyUntil = now + U.irnd(700, 1100); setGlance(U.pick(['west', 'east', 'north']), U.irnd(700, 1100), now); return; }
    if (agent.wakePhase === 2) { agent.wakePhase = 3; agent.dir = 'south'; setGlance('south', U.irnd(600, 1000), now); agent.studyUntil = now + U.irnd(500, 800); return; }
    // phase 3: settle, then the one first thought, then dissolve into ordinary life (seeding the birth tile as its first haunt)
    sayFirstThought(now); noteFond(now, 1.2);
    agent.goal = null; agent.quirkKind = null; agent.wakePhase = 0; agent.state = 'idle'; agent.idleUntil = now + U.irnd(800, 1600);
  }
  // FIRST LIGHT is SILENT by design — the newborn takes in the room and says NOTHING out loud. The
  // look-around sweep (wakePhases above) carries the beat; silence is eerier and honours "no idle one-liners".
  function sayFirstThought() { /* no spoken wake line — removed */ }

  /* ---------- inner life: needs + temperament decide WHICH goal it pursues ---------- */
  // the desk-seat tile of the CURRENT body (self): the hero falls back to its synthetic module `seat`; a crew body
  // resolves its OWN assigned workstation's chair (deskSeat(deskPropFor(self.id))) — never the hero's seat, so the
  // social-refill tether (nearDesk) + the lonely planner (planSeekDesk) measure/path to each body's own desk (J2/J3).
  // null when the body has no desk (a deskless crew body simply never gets the desk-proximity social refill).
  function seatFor(body) {
    if (body === agent) return seat;
    const dp = body && deskPropFor(body.id);
    return dp ? deskSeat(dp) : null;
  }
  // is the agent loitering near its desk (its tether to the Commander)?
  function nearDesk() {
    const s = seatFor(self);
    if (!s) return false;
    const c = tileOf(self.px, self.py);
    return Math.abs(c.x - s.tx) <= 2 && Math.abs(c.y - s.ty) <= 2;
  }
  // three slow meters decay/refill by what the agent is doing; clamped 0..100. O(1), every tick.
  function tickNeeds(dt) {
    const s = dt / 1000, n = self.needs;
    const sitLeisure = self.goal === 'lounge' || (self.goal === 'use' && self.sitting);
    const observing = self.goal === 'inspect' || self.goal === 'watch' || self.goal === 'lounge' || self.goal === 'gaze';
    n.rest = U.clamp(n.rest + (self.working ? -2.1 : sitLeisure ? 3.4 : 0.35) * s, 0, 100);
    n.stim = U.clamp(n.stim + (observing ? 2.6 : self.working ? 0.6 : self.state === 'walk' ? 0.2 : -1.25) * s, 0, 100);
    n.social = U.clamp(n.social + (((self === agent) && (activity === 'task' || activity === 'talk')) ? 2.2 : (self.goal === 'tend' || nearDesk()) ? 1.6 : -0.45) * s, 0, 100);
  }
  // lonely → drift to a tile by the desk and face south (its window to the Commander); refills social
  function planSeekDesk(now) {
    const seat = seatFor(self);   // the CURRENT body's own desk (hero → synthetic `seat`; crew → its workstation chair) — never the hero's seat for a crew body (J2/J3)
    if (!seat) return false;
    const zone = zoneFor(self);   // J3: the desk spots derive from the seat with +2 south / ±1 offsets; clamp them to the body's OWN zone like every sibling picker
    const spots = [[seat.tx, seat.ty + 1], [seat.tx - 1, seat.ty], [seat.tx + 1, seat.ty], [seat.tx, seat.ty]];
    for (const [tx, ty] of spots) {
      if (!tileInZone(zone, tx, ty)) continue;   // J3: never tether OUT of the body's zone (hero whole-floor 'multi' zone admits its own spots → byte-parity)
      if (!geo.walkable(tx, ty, blocked)) continue;
      if (setPathTo({ x: tx, y: ty })) { self.goal = 'tend'; self.useFace = 'south'; self.usingProp = null; self.studyKey = null; if (!self.target) arrive(now); return true; }
    }
    return false;
  }
  // restless → short back-and-forth hops near the current tile (paces in place instead of strolling far off)
  function pace(now) {
    const cur = tileOf(self.px, self.py), dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const zone = zoneFor(self);   // P1: pace in place, but never a hop OUT of the zone
    for (let i = 0; i < 5; i++) {
      const d = dirs[U.irnd(0, 3)], step = U.irnd(1, 2), tx = cur.x + d[0] * step, ty = cur.y + d[1] * step;
      if (tileInZone(zone, tx, ty) && geo.walkable(tx, ty, blocked) && setPathTo({ x: tx, y: ty })) { self.goal = null; curiositySay(SELF_STIM, 0.4, now); return true; }
    }
    return false;
  }
  // deep downtime → walk to the station edge and contemplate the void (faces outward, long quiet dwell)
  function planGazeOut(now) {
    if (!geo || !geo.allRects || !geo.allRects.length) return false;
    const zone = zoneFor(self);   // P1: gaze at the OWN-ZONE edge — clamped, not the whole-station edge (a solo whole-station zone keeps the true edge)
    const cx = geo.COLS / 2, cy = geo.ROWS / 2, cands = [];
    for (const r of geo.allRects) {
      cands.push({ tx: r.x1, ty: (r.y1 + r.y2) >> 1, face: 'west' }); cands.push({ tx: r.x2, ty: (r.y1 + r.y2) >> 1, face: 'east' });
      cands.push({ tx: (r.x1 + r.x2) >> 1, ty: r.y1, face: 'north' }); cands.push({ tx: (r.x1 + r.x2) >> 1, ty: r.y2, face: 'south' });
    }
    cands.sort((a, b) => ((b.tx - cx) ** 2 + (b.ty - cy) ** 2) - ((a.tx - cx) ** 2 + (a.ty - cy) ** 2));   // furthest-out first
    for (const c of cands) {
      if (!tileInZone(zone, c.tx, c.ty)) continue;   // only the edges of the agent's own zone
      if (geo.walkable(c.tx, c.ty, blocked) && setPathTo({ x: c.tx, y: c.ty })) { self.goal = 'gaze'; self.useFace = c.face; self.usingProp = null; self.studyKey = null; if (!self.target) arrive(now); return true; }
    }
    return false;
  }

  /* ---------- rhythm: a free-running mood that re-weights the idle menu over minutes ----------
     Repeated watching reveals structure — it is clearly 'in a different mode' than ten minutes ago.
     Never overrides a summon (decideIdle only runs while idle); just tilts what it gravitates to. */
  const PHASES = [
    { tag: 'focus', rest: 0.8, stim: 0.9, soc: 1.25, restless: 1.25 },   // hovers near the desk, antsy for work
    { tag: 'roam', rest: 0.8, stim: 1.4, soc: 0.9, restless: 1.15 },     // wants to wander + study
    { tag: 'ease', rest: 1.4, stim: 0.85, soc: 1.0, restless: 0.7 },     // gravitates to the couch
    { tag: 'drift', rest: 1.2, stim: 0.7, soc: 0.85, restless: 0.55 },   // sleepy, sparse, long dwells
  ];
  // B3 DISTINCTNESS: the hero keeps the exact original clock (skew 0 → self===agent byte-parity, J1). Crew bodies
  // get a deterministic per-body TIME skew (0..PHASE_MS, from U.hash on the stable id) so their phase TRANSITIONS
  // desync — without it every body flips mood at the same now/210000 boundary (offset-but-lockstep). Now a floor of
  // N agents is in genuinely different modes AND changes mode at different instants — distinct minds, not a swarm (G3).
  const PHASE_MS = 210000;
  function phaseOf(now) {
    if (!self) return PHASES[Math.floor(now / PHASE_MS) % PHASES.length];
    const skew = self === agent ? 0 : (U.hash('ph:' + self.id) % PHASE_MS);   // hero unchanged (J1); crew time-shifted
    return PHASES[(Math.floor((now + skew) / PHASE_MS) + self.phase) % PHASES.length];   // ~3.5 min per phase, offset + skewed per body
  }

  /* ---------- quirks: rare, gated, UNPREDICTABLE one-offs — the off-screen inner life surfacing ----------
     Eerie through stillness + ambiguity (the "why did it just do that"), never spooky one-liners. */
  function maybeQuirk(now) {
    if (now < (self.quirkCd || 0)) return false;   // J2: per-body cooldown — a crew quirk must NOT throttle the hero or siblings (was the shared module global)
    let p = 0.085 * (0.6 + self.pers.restless * 0.4);
    // B3/D2: the hero's probability is UNCHANGED (J1 byte-parity). A CREW body's roll is hard-gated (p*=0) while the
    // station-wide beat gate holds — any noticeable beat anywhere on the floor (a quirk OR a D2-budgeted stroll/
    // off-beat/revisit) armed it — so the floor never beats in unison and the crew's COLLECTIVE rate stays bounded
    // (G3/G5). Not awareness: the body learns nothing about the other; it's a global rarity governor on the dice only.
    p *= crewBeatDamp(now);
    if (!U.chance(p)) return false;
    self.quirkCd = now + U.irnd(45000, 90000);    // quirks stay special — even rarer now, so each lands with weight
    armBeat(now);                                 // D2 (G5): arm the floor-wide governor — a quirk is a noticeable beat, so it also damps the NEXT crew quirk AND the station's stroll/off-beat/revisit budget (subsumes the old per-quirk lastQuirkAt)
    const r = U.irnd(0, 999);
    if (r < 320) return quirkListen(now);    // 32% — freeze + snap toward a sound only it heard
    if (r < 520) return quirkScan(now);      // 20% — a slow, deliberate sweep of the room
    if (r < 680) return quirkPonder(now);    // 16% — stops, faces away, lost in thought
    if (r < 790) return planGazeOut(now);    // 11% — drifts to the edge and stares into the void
    if (r < 870) return quirkFaceWall(now);  //  8% — walks to a wall and just faces it (unexplained)
    if (r < 945 && quirkVigil(now)) return true;   // ~7.5% — the VIGIL: dead-center, faces one wall, holds (falls through to the stare if no center is free)
    return quirkStare(now);                  // ~5.5% — the long stare straight at YOU (rarest, eeriest)
  }
  function startQuirk(now, kind, ms, face) {
    self.goal = 'quirk'; self.quirkKind = kind; self.usingProp = null; self.studyKey = null;
    self.sitting = false; self.working = false; self.state = 'idle'; self.studyUntil = now + ms; self.glanceCd = 0;
    if (face) { self.dir = face; setGlance(face, U.irnd(300, 600), now); }
    return true;
  }
  function quirkListen(now) { const d = U.pick(['east', 'west', 'south', 'north']); startQuirk(now, 'listen', U.irnd(2200, 4500), d); setGlance(d, 260, now); curiositySay(Q_LISTEN, 0.22, now); return true; }
  function quirkScan(now) {
    startQuirk(now, 'scan', U.irnd(3200, 4600), 'north');
    const body = self;   // B1: capture the scheduling body — the deferred sweep must turn THIS body, not whatever `self` points to at fire time
    ['north', 'east', 'south', 'west'].forEach((d, i) => setTimeout(() => { if (body && body.goal === 'quirk' && body.quirkKind === 'scan') { body.dir = d; body.glance = { dir: d, until: performance.now() + 900 }; } }, i * 850));
    return true;
  }
  function quirkPonder(now) { startQuirk(now, 'ponder', U.irnd(4000, 7000), U.pick(['north', 'east', 'west'])); curiositySay(Q_PONDER, 0.4, now); return true; }
  function quirkFaceWall(now) {   // walks to a wall and just... faces it. no explanation. (uses arrive's quirk dwell)
    if (!geo || !geo.allRects || !geo.allRects.length) return false;
    const zone = zoneFor(self);   // P1: face a wall WITHIN the zone, not a wall across the station
    const DIRS = [['north', 0, -1], ['south', 0, 1], ['east', 1, 0], ['west', -1, 0]];
    for (let tries = 0; tries < 30; tries++) {
      const r = geo.allRects[U.irnd(0, geo.allRects.length - 1)];
      const tx = U.irnd(r.x1, r.x2), ty = U.irnd(r.y1, r.y2);
      if (!tileInZone(zone, tx, ty)) continue;
      if (!geo.walkable(tx, ty, blocked)) continue;
      const walls = DIRS.filter(([d, dx, dy]) => !geo.walkable(tx + dx, ty + dy, blocked));
      if (!walls.length) continue;
      if (!setPathTo({ x: tx, y: ty })) continue;
      self.goal = 'quirk'; self.quirkKind = 'wall'; self.useFace = U.pick(walls)[0]; self.usingProp = null; self.studyKey = null;
      if (!self.target) arrive(now);
      return true;
    }
    return false;
  }
  function quirkVigil(now) {   // walks to a room's center, faces ONE cardinal, holds dead still — the held emptiness (silent)
    if (!geo || !geo.allRects || !geo.allRects.length) return false;
    const zone = zoneFor(self);   // P1: the vigil stands at a rect-center INSIDE the zone (a solo whole-station zone admits every center)
    for (let t = 0; t < 24; t++) {
      const r = geo.allRects[U.irnd(0, geo.allRects.length - 1)];
      const tx = (r.x1 + r.x2) >> 1, ty = (r.y1 + r.y2) >> 1;
      if (!tileInZone(zone, tx, ty)) continue;
      if (!geo.walkable(tx, ty, blocked)) continue;
      if (!setPathTo({ x: tx, y: ty })) continue;
      self.goal = 'quirk'; self.quirkKind = 'vigil'; self.useFace = U.pick(['north', 'south', 'east', 'west']); self.usingProp = null; self.studyKey = null;
      if (!self.target) arrive(now);
      return true;
    }
    return false;
  }
  function quirkStare(now) {   // turns to the Commander and holds eye contact, mostly in silence
    self.goal = 'stare'; self.quirkKind = 'stare'; self.usingProp = null; self.studyKey = null;
    self.sitting = false; self.working = false; self.state = 'idle'; self.studyUntil = now + U.irnd(14000, 34000); self.glanceCd = now + 1200;
    self.dir = 'south'; setGlance('south', 700, now); curiositySay(Q_STARE, 0.18, now);   // mostly silent — the stillness is the unsettling part
    return true;
  }

  /* ---------- the agent ACTS ON the station: place / rearrange its OWN decor (rare, safety-railed) ---------- */
  function emptySpotNear() {
    if (!geo || !station || !station.canPlaceProp) return null;
    const cur = tileOf(self.px, self.py);
    const belts = new Set(((geo && geo.belts) || []).map(b => b.x + ',' + b.y));
    for (let tries = 0; tries < 40; tries++) {
      const x = cur.x + U.irnd(-5, 5), y = cur.y + U.irnd(-5, 5);
      if (Math.abs(x - cur.x) + Math.abs(y - cur.y) < 2) continue;
      if (!geo.walkable(x, y, blocked)) continue;                 // free floor (no blocking prop / desk / chamfer)
      if (belts.has(x + ',' + y)) continue;                       // not on a belt
      if (seat && x === seat.tx && y === seat.ty) continue;       // not the work seat
      const t = AGENT_DECOR[U.irnd(0, AGENT_DECOR.length - 1)];
      if (!station.canPlaceProp(t, x, y, 1, 1).ok) continue;      // model: on a deck, no prop overlap (never the Commander's stuff)
      for (const [ax, ay] of SEAT_NB) if (geo.walkable(x + ax, y + ay, blocked) && !belts.has((x + ax) + ',' + (y + ay))) return { x, y, t, ax: x + ax, ay: y + ay };
    }
    return null;
  }
  function maybePlace(now) {
    if (now < placeCd || !station || !station.addProp || !geo) return false;
    if (!U.chance(0.5)) return false;                              // even when eligible, only sometimes
    if (agentDecor.length >= 3) {                                  // at cap -> sometimes REARRANGE: remove one of ITS OWN (a fresh one may return later)
      if (!U.chance(0.5) || !station.removeProp) return false;
      const id = agentDecor[U.irnd(0, agentDecor.length - 1)];
      const p = geo.props && geo.props.find(q => q.id === id);
      if (!p) { const i = agentDecor.indexOf(id); if (i >= 0) agentDecor.splice(i, 1); return false; }
      let ap = null; for (const [ax, ay] of SEAT_NB) if (geo.walkable(p.x + ax, p.y + ay, blocked)) { ap = { x: p.x + ax, y: p.y + ay }; break; }
      if (!ap || !setPathTo({ x: ap.x, y: ap.y })) return false;
      placeCd = now + U.irnd(120000, 240000);
      self.goal = 'place'; self.placeTarget = null; self.removeId = id; self.useFace = dirToward(ap.x * T, ap.y * T, (p.x + 0.5) * T, (p.y + 0.5) * T);
      if (!self.target) arrive(now);
      return true;
    }
    if ((geo.props || []).filter(p => AGENT_DECOR.indexOf(p.t) >= 0).length >= 5) return false;   // floor-wide decor cap (reload-safe; never clutters a station already full of decor)
    const spot = emptySpotNear();
    if (!spot || !setPathTo({ x: spot.ax, y: spot.ay })) return false;
    placeCd = now + U.irnd(120000, 240000);
    self.goal = 'place'; self.placeTarget = spot; self.removeId = null; self.useFace = dirToward(spot.ax * T, spot.ay * T, (spot.x + 0.5) * T, (spot.y + 0.5) * T);
    if (!self.target) arrive(now);
    return true;
  }

  /* ---------- power-down: in the deep wind-down mood it goes dormant where it stands (the eerie "is it off?") ---------- */
  function sleep(now) {
    self.goal = 'sleep'; self.usingProp = null; self.studyKey = null; self.quirkKind = null;
    self.sitting = false; self.working = false; self.state = 'idle';   // dormant STANDING where it stands — never seated: a sit pose on a chairless tile reads as "sitting on air"; the sit anim is reserved for an actual seat (desk/couch)
    self.glance = null;                                      // frozen: maybeGlance skips goal==='sleep', so no lingering cooldown to leak
    self.studyUntil = now + U.irnd(20000, 55000);
    curiositySay(SLEEP_LINE, 0.3, now);
    return true;
  }

  /* ---------- caretaker rounds: a deliberate 2-3 stop lap of the station, an ownership beat at each ----------
     TIER D · D5 beat 1 — INSPECTION ROUNDS: for the HERO (the OVERSEER) only, when crew are WORKING in the hero's
     zone, the rounds prefers a supervisor stop ~2 tiles behind each working crew body (reusing the D3 watch-a-peer
     stand-point geometry) with a shorter FACE-THE-WORKER hold than a D3 social watch (a glance, not a study). With
     no working crew in-zone (incl. every N=1 floor), rounds behave EXACTLY as before — the worker scan appends
     nothing, draws no RNG, and the shuffle/pick run over the identical stop list. */
  // D5 beat 1: the supervisor stand-point ~2 tiles behind a working body, inside the observer's zone, facing the
  // worker. Same "behind" geometry as planWatch (approach from where the observer already is), returned as a
  // ready {tx,ty,face} stand so it slots straight into the rounds queue. null if no in-zone stand-tile resolves.
  function supStandBehind(obs, worker) {
    const zone = zoneFor(obs);
    const wt = tileOf(worker.px, worker.py);
    const dx = Math.sign(obs.px - worker.px) || 0, dy = Math.sign(obs.py - worker.py) || 0;
    const cands = [];
    for (const dist of [2, 3, 1]) cands.push({ x: wt.x + dx * dist, y: wt.y + dy * dist });
    cands.push({ x: wt.x + 2, y: wt.y }, { x: wt.x - 2, y: wt.y }, { x: wt.x, y: wt.y + 2 }, { x: wt.x, y: wt.y - 2 });
    for (const c of cands) {
      if (!tileInZone(zone, c.x, c.y) || !geo.walkable(c.x, c.y, blocked)) continue;
      if (c.x === wt.x && c.y === wt.y) continue;
      return { tx: c.x, ty: c.y, face: dirToward((c.x + 0.5) * T, (c.y + 0.5) * T, (wt.x + 0.5) * T, (wt.y + 0.5) * T), sup: true };
    }
    return null;
  }
  function maybeRounds(now) {
    if (now < (self.roundsCd || 0) || !geo || typeof PropAnchor === 'undefined') return false;
    const zone = zoneFor(self);   // P1: a caretaker lap stays inside the zone (no straddling into the next room)
    const cur = tileOf(self.px, self.py), stops = [];
    for (const p of (geo.props || [])) { const s = specOf(p.t); if (s && s.blocks && mayTouchProp(self.id, p) && tileInZone(zone, p.x, p.y) && (Math.abs(p.x - cur.x) + Math.abs(p.y - cur.y)) <= 11) stops.push({ prop: p }); }   // no ownership beat at another body's (or unclaimed) workstation, and never out of zone
    const belts = (geo.belts || []).filter(b => tileInZone(zone, b.x, b.y)); if (belts.length) stops.push({ belt: belts[U.irnd(0, belts.length - 1)] });
    // D5 beat 1 (HERO-ONLY): fold in a supervisor stop behind each crew body WORKING in the hero's zone. Guarded on
    // self===agent so crew rounds are byte-identical (crew never scan crew — zero crew-side diff); the whole block is
    // skipped (no RNG) when there are no working crew in-zone, so an N=1 floor is unchanged.
    if (self === agent) {
      for (const b of crew) {
        if (!b || !b.working || b === self) continue;
        const bt = tileOf(b.px, b.py);
        if (!tileInZone(zone, bt.x, bt.y)) continue;   // only supervise crew inside the hero's own zone (containment)
        const stand = supStandBehind(self, b);
        if (stand) stops.push({ sup: stand });
      }
    }
    if (stops.length < 2) return false;
    for (let i = stops.length - 1; i > 0; i--) { const j = U.irnd(0, i), t = stops[i]; stops[i] = stops[j]; stops[j] = t; }   // shuffle
    const q = [];
    for (const st of stops.slice(0, U.irnd(2, 3))) {
      if (st.sup) { q.push(st.sup); continue; }   // D5: a ready supervisor stand — already {tx,ty,face,sup} + zone-checked
      const foot = st.belt ? { x: st.belt.x, y: st.belt.y, w: 1, h: 1 } : st.prop;
      const a = PropAnchor.deriveAnchor(foot, geo, { approach: 'auto', extra: st.belt ? beltUnion() : blocked });
      if (a && tileInZone(zone, a.tx, a.ty)) q.push({ tx: a.tx, ty: a.ty, face: a.face });   // the stand-tile of each stop stays in-zone too
    }
    if (q.length < 2) return false;
    self.roundsQueue = q; self.roundsCd = now + U.irnd(60000, 130000);
    return roundsNext(now);
  }
  function roundsNext(now) {
    while (self.roundsQueue && self.roundsQueue.length) {
      const s = self.roundsQueue.shift();
      if (setPathTo({ x: s.tx, y: s.ty })) { self.goal = 'rounds'; self.useFace = s.face; self.roundsSup = !!s.sup; if (!self.target) arrive(now); return true; }
    }
    self.goal = null; self.roundsQueue = null; self.idleUntil = now + U.irnd(400, 1400); return true;   // lap complete -> back to the menu
  }

  /* SPATIAL MEMORY — affection accrues at a tile each time the agent chooses to dwell there. Over a long
     watch one or two haunts emerge: it starts drifting back to them, and grieves if one is taken away. */
  function noteFond(now, amt) {
    if (!self || !self.fond) return;
    const t = tileOf(self.px, self.py), k = t.x + ',' + t.y;
    self.fond.set(k, Math.min(40, (self.fond.get(k) || 0) + amt));   // cap so a haunt can fade and shift over time
    if (self.fond.size > 28) { let lo = Infinity, lk = null; for (const [kk, v] of self.fond) if (v < lo) { lo = v; lk = kk; } if (lk) self.fond.delete(lk); }
  }
  // the one haunt that clearly leads the pack, or null (so revisits read as a real favorite, not random)
  function favTile() {
    if (!self || !self.fond) return null;
    let best = null, bv = 0, second = 0;
    for (const [k, v] of self.fond) { if (v > bv) { second = bv; bv = v; best = k; } else if (v > second) second = v; }
    if (bv < 8 || bv < second + 3) return null;
    const [x, y] = best.split(',').map(Number); return { x, y, score: bv };
  }
  // rarely, drawn back to its favorite spot just to be there a while (gated by a long cooldown + a real favorite)
  function maybeRevisit(now) {
    if (now < (self.revisitCd || 0)) return false;
    // D2 (G5): station budget — a CREW body skips a haunt-revisit while the station gate holds, so N crew don't all
    // drift to their favorites at once (no-op for the hero → N=1 parity). A skip leaves revisitCd untouched, so the
    // beat simply re-considers on the next idle tick once the gate expires — no starvation.
    if (crewBeatDamp(now) < 1) return false;
    const f = favTile(); if (!f) return false;
    if (!tileInZone(zoneFor(self), f.x, f.y)) return false;   // P1: a remembered haunt outside the new zone isn't revisited (a zone change must not strand revisit — it just no-ops this beat)
    const cur = tileOf(self.px, self.py);
    if (cur.x === f.x && cur.y === f.y) { self.revisitCd = now + U.irnd(40000, 80000); return false; }
    if (!geo.walkable(f.x, f.y, blocked) || !setPathTo({ x: f.x, y: f.y })) return false;
    self.goal = 'revisit'; self.useFace = U.pick(['south', 'north', 'east', 'west']); self.usingProp = null; self.studyKey = null;
    self.revisitCd = now + U.irnd(60000, 120000);
    armBeat(now);   // D2 (G5): a haunt-revisit walk is a noticeable beat — count it against the station budget
    if (!self.target) arrive(now);
    return true;
  }
  // grief walk: return to the very spot it used to stand and face where its thing was, then let go
  function planMourn(now) {
    if (!pendingMourn) return false;
    const m = pendingMourn; const [sx, sy] = m.spotKey.split(',').map(Number);
    let dest = null;
    if (geo.walkable(sx, sy, blocked)) dest = { x: sx, y: sy };
    else { const a = PropAnchor.deriveAnchor({ x: m.tx, y: m.ty, w: 1, h: 1 }, geo, { approach: 'auto', extra: blocked }); if (a && geo.walkable(a.tx, a.ty, blocked)) dest = { x: a.tx, y: a.ty }; }
    if (!dest) { pendingMourn = null; return false; }
    // P1 (A1): grief never walks OUT of the zone. The mourned spot is normally in-zone already (fond
    // accrues where the body dwells, which is in-zone), but a cross-zone removal is released unmourned
    // rather than dragging the body across the floor — containment outranks the singleton grief beat.
    if (!tileInZone(zoneFor(self), dest.x, dest.y)) { self.fond.delete(m.spotKey); pendingMourn = null; return false; }
    const cur = tileOf(self.px, self.py), here = cur.x === dest.x && cur.y === dest.y;
    if (!here && !setPathTo({ x: dest.x, y: dest.y })) { pendingMourn = null; return false; }
    self.goal = 'mourn'; self.usingProp = null; self.studyKey = null;
    self.useFace = dirToward((dest.x + 0.5) * T, (dest.y + 0.5) * T, (m.tx + 0.5) * T, (m.ty + 0.5) * T);
    self.fond.delete(m.spotKey);                  // grieve it, then release it — don't loop on an empty tile forever
    pendingMourn = null;
    if (here || !self.target) arrive(now);        // already standing on the spot? grieve in place
    return true;
  }

  // THE WANT ENGINE — replaces the flat dice roll. Whichever drive is most unmet (tilted by temperament,
  // the current mood phase, + how long since real work) leads; novelty + rare quirks interrupt. The SAME
  // planners run, but now there is a legible reason behind every move so it stops reading as aimless.
  function decideIdle(now) {
    self.stilling = false;                            // every fresh decision starts clean (standStill re-sets it)
    if (chatStareHold(now)) return;                   // TIER D · D1: the Commander has COMMS focus on this body → give it your attention, don't choose to wander (G2: chatStareHold self-gates OFF while activity==='task'/working, so a summon still wins)
    // The grief + novelty reflexes read the MODULE pendingMourn/novelty queues, which are the HERO's awareness
    // (scanNovelty/maybeMourn only run for the hero). A crew body must NOT consume the hero's queue (J2) — gate
    // both reflexes to self===agent so only the hero acts on them. Crew get their idle life from the want-engine below.
    if (self === agent) {
      if (pendingMourn && planMourn(now)) return;      // grief reflex: a beloved spot was just emptied — go stand where it was
      if (novelty.length && planInspect(now)) return;  // curiosity reflex: a fresh placement always wins
      if (maybeBoardPost(now)) return;                 // TIER D · D5 beat 2: OVERSEER surveys the MISSION BOARD when the queue is non-empty (rare, 2-4min cd, board in-zone; ARMS the station budget on fire — not damp-gated, crewBeatDamp is a hero no-op). HERO-ONLY. Draws ZERO RNG when the queue is empty / cd unexpired ⇒ a no-queue floor is byte-identical.
    }
    if (maybeQuirk(now)) return;                       // rare unpredictable detour — the eerie inner life surfacing
    // AUTONOMOUS PROP PLACEMENT — REMOVED (Thronglet direction). The agent no longer drops
    // plant/coffee/cans/poster on random floor tiles (it read as nonsensical clutter). It still
    // USES the Commander's placed props (couch/TV/arcade) via planProp below — that stays.
    const n = self.needs, p = self.pers, ph = phaseOf(now), idleAge = now - (self.lastTaskAt || now);
    if (ph.tag === 'drift' && idleAge > 45000 && n.rest > 50 && U.chance(0.22) && sleep(now)) return;   // deep downtime in the wind-down mood -> power down where it stands
    /* TIER D SELECTION (hoisted 2026-07-02 — live-soak fix): these three used to sit INSIDE the `top < 28`
       CONTENT branch below, but contentment is correct-but-rare in practice (stim/social decay while idle —
       the Pass-7 note), so chase/social/mimic were almost never even CONSULTED and the observed live rate was
       ~zero despite correctly-tuned lanes. They now run at EVERY idle re-decide (matching the rate model the
       D3/D4 constants were calibrated against). Safe to hoist: each maybe* is fully self-gated (the 8-15min
       chase gate + cursor fresh/moving, the 5-8min social lane + slot + pair cooldowns, the mimic per-body
       cooldown + cursor gate + D2 station budget, and all the eligibility/goal==null checks) — consulting more
       often changes WHEN they're considered, never their budgets; the lanes remain the rate governors. Position
       preserves every existing precedence: chat-stare > hero reflexes > quirk > sleep > chase > social > mimic
       > the want-engine — identical RNG draw ORDER on the old (content) reachable passes, and on quiet paths
       (stale cursor / no pair / lanes closed) all three no-op BEFORE any roll, so N=1 unattended stays
       byte-identical. */
    if (maybeChase(now)) return;         // TIER D · D4 THE CHASE: ultra-rare (8-15 min station cooldown, one chaser ever, mutually exclusive with a live social beat, cursor fresh+MOVING) — breaks toward the cursor, pursues, stops+stares, walks off. Rolled FIRST but hardest-gated: most idle decisions never even reach the roll.
    if (maybeSocial(now)) return;        // TIER D · D3: a rare SILENT social encounter (huddle/watch/border/half-follow) between idle neighbors — bounded movement, one live station-wide, zone-clamped, per-pair cooldown (G3/G4/G5); selected here at the idle cadence off neighborsOf (K4 — never off observing another encounter)
    if (maybeMimic(now)) return;         // TIER D · D4 CURSOR-MIMIC: a rare quirk-band head-only follow of the moving cursor (3-6s, per-body 45-90s cooldown, station-gated); reduceMotion → a single glance
    /* FOLLOW-THROUGH (continuity of attention, drive half). The three drives were re-raced from scratch on
       every re-decide, so PARTLY satisfying one could flip the winner and send the body off to an unrelated
       category mid-thought — the same incoherence `attn` fixes spatially. The drive that most recently took
       the wheel now keeps a small edge (x1.25) for a short window, so a thought gets finished before the next
       one starts. It is a NUDGE, never a lock: the hold is only armed when the winner CHANGES (never extended
       by winning again), so it always lapses and the body is re-raced free — and 1.25 is far too small to
       out-argue a genuinely unmet need. */
    const held = (now < (self.driveUntil || 0)) ? self.drive : null;
    const HOLD = 1.25;
    const wRest = (100 - n.rest) * (0.7 + 0.6 * p.homebody) * ph.rest * (held === 'rest' ? HOLD : 1);
    const wStim = ((100 - n.stim) * (0.7 + 0.6 * p.curious) + Math.min(35, idleAge / 4500) * p.restless) * ph.stim * (held === 'stim' ? HOLD : 1);   // boredom climbs with downtime
    const wSoc = (100 - n.social) * ph.soc * (held === 'soc' ? HOLD : 1);
    const top = Math.max(wRest, wStim, wSoc);
    if (top < 28) {                                                                    // content -> mostly STILL (the eerie calm); the old 100%-motion calm read as restless
      // (chase/social/mimic selection HOISTED above — see the TIER D SELECTION block — so it runs on every
      // idle re-decide, not only the rare content pass. This branch keeps its CONTENT=STILL character.)
      if (maybeMutualGlance(now)) return;  // C-Beat2: a quiet noticing between two idle neighbors — gaze-only; maybeMutualGlance holds self.idleUntil past its own glance so the beat stays two-sided, then ends by timeout
      if (U.chance(0.10) && maybeRevisit(now)) return;                                 //   occasionally drift back to its favorite spot
      const r = U.irnd(0, 99);
      if (r < 62) standStill(now);                                                      //   62% just stand and be here
      else if (r < 84) lookAround(now);                                                 //   22% a slow look around
      else wander(now);                                                                 //   16% a short stroll
      return;
    }
    // a drive is about to LEAD (the content branch above returned, so none of this arms while merely content):
    // arm the follow-through window if — and only if — the wheel has changed hands. Ties keep the branch
    // ladder's own precedence below (rest > soc > stim) so the two can never disagree about who won.
    const win = top === wRest ? 'rest' : top === wSoc ? 'soc' : 'stim';
    if (win !== held) { self.drive = win; self.driveUntil = now + U.irnd(12000, 22000); }
    if (top === wRest) { if (planProp(now)) return; }                                  // tired -> lounge / couch
    else if (top === wSoc) { if (planSeekDesk(now)) return; }                          // lonely -> the desk, face the Commander
    else {                                                                             // bored / restless
      // TIER D · D5 beat 3 — QUEUE-AWARE IDLE BIAS: while the visible task/mission queue is non-empty, the OVERSEER
      // (hero only) leans harder into a purposeful caretaker lap (which visits desks / belts / the board — the
      // work-adjacent points) rather than an aimless beat — a WEIGHT shift (x1.5, never absolute), not new movement.
      // The multiplier derives from missionPinCounts (cached, no RNG) so the U.chance draw count is UNCHANGED; a
      // no-queue floor keeps the exact 0.3 (byte-identical), and crew (self!==agent) always use 0.3.
      const roundsBias = (self === agent && (missionPinCounts(now)[0] | 0) > 0) ? 0.45 : 0.3;
      if (U.chance(roundsBias) && maybeRounds(now)) return;                             //   do a deliberate caretaker lap (purpose, not aimless)
      if (n.stim < 42 && planPOI(now)) return;                                         //   study a machine / watch a belt
      if (idleAge > 30000 && U.chance(0.35) && planGazeOut(now)) return;               //   long quiet -> contemplate the void
      if (p.restless * ph.restless > 1.0 && pace(now)) return;                          //   antsy -> pace in place
    }
    // graceful fallbacks so it never freezes
    if (U.chance(0.45 * p.curious) && planPOI(now)) return;
    if (U.chance(0.4 * p.homebody) && planProp(now)) return;
    if (U.chance(0.45)) lookAround(now); else wander(now);
  }

  // head-turns that sell "alive": track passing cargo, fidget at the desk, glance at new kit, look around
  function maybeGlance(now) {
    if (!agent || agent.unplaced) return;
    if (activity === 'talk') {
      // a voice conversation: don't let the gaze wander, but if he's actively LISTENING to the Commander,
      // give small acknowledging looks (mostly toward the camera) so he reads as engaged, not frozen.
      const lst = typeof Voice !== 'undefined' && Voice.isListening && Voice.isListening();
      if (lst && agent.state !== 'walk' && now >= (agent.glanceCd || 0) && !(agent.glance && agent.glance.until > now)) {
        setGlance(U.pick(['south', 'south', 'east', 'west']), U.irnd(450, 850), now);
        agent.glanceCd = now + U.irnd(1400, 2800);
      }
      return;
    }
    if (agent.state === 'walk') return;                              // walking owns the facing
    if (agent.goal === 'sleep') return;                             // dormant: hold dead still (no head-turns)
    if (agent.goal === 'firstwake') return;                         // FIRST LIGHT: stepFirstWake is the SOLE facing driver — no random flicks polluting the deliberate sweep
    if (agent.goal === 'mimic' || agent.goal === 'chase') return;   // TIER D · D4: stepMimic/stepChase is the SOLE facing driver — no cargo-track/ambient flick hijacking the cursor follow / pursuit-stare
    if (agent.glance && agent.glance.until > now) return;
    if (now < (agent.glanceCd || 0)) return;
    // ── THE LOOK-UP ───────────────────────────────────────────────────────────────────────────────────
    // The eerie centerpiece (Thronglet direction): rarely, while idle, the agent STOPS, turns to face you —
    // tracking your cursor, never showing its back — holds the gaze a beat too long, then turns back and
    // carries on as if nothing happened. Silent. The self-interruption + the held stare is what reads as
    // "it chose to look at ME," not animation. setGlance alone turns the whole sprite then auto-reverts, so
    // it resumes cleanly. A long hard floor (agent.lookCd) means look-ups never cluster; the chance jumps
    // right after you do something (cursor hovering near it, or you just returned to the tab).
    if (activity !== 'task' && !agent.working && now >= (agent.lookCd || 0)
        && (agent.stilling || agent.goal == null || agent.goal === 'inspect' || agent.goal === 'tend'
            || agent.goal === 'gaze' || agent.goal === 'rounds' || agent.goal === 'revisit'
            || agent.goal === 'watch' || agent.goal === 'lounge')) {
      let p = 0.03;                                                                 // ambient: ~one look-up every few minutes
      if ((now - lastCursor.t) < 4000 && Math.hypot(lastCursor.wx - agent.px, lastCursor.wy - agent.py) < 3.2 * T) p = 0.30;   // you're hovering near it
      if (now < userReturnUntil) p = Math.max(p, 0.30);                             // you just came back to the tab
      if (U.chance(p)) {
        const stale = (now - lastCursor.t) > 8000;
        let dir = stale ? 'south' : dirToward(agent.px, agent.py, lastCursor.wx, lastCursor.wy);
        if (dir === 'north') dir = 'south';                                         // never turn its back for the look-up — the face is the point
        let hold;
        if (deepLocks < 1 && U.chance(0.12)) { hold = U.irnd(2000, 2500); deepLocks++; }   // the rare long "deep lock" (~1 per session)
        else hold = U.irnd(650, 1200);                                              // the common micro look-up — a beat too long
        agent.trackUntil = 0;                                                       // drop any in-flight cargo body-track
        setGlance(dir, hold, now);                                                  // glance only → turns to you, then auto-reverts (clean resume)
        agent.glanceCd = now + hold + U.irnd(500, 1100);                            // a quiet beat before normal glancing resumes
        agent.lookCd = now + U.irnd(90000, 130000);                                 // HARD FLOOR: look-ups never cluster
        return;
      }
    }
    // watching a belt → follow the nearest box
    if (agent.goal === 'watch') {
      const box = nearestBox();
      if (box && box.d < 80) { setGlance(dirToward(agent.px, agent.py, box.x, box.y), U.irnd(500, 900), now); agent.glanceCd = now + U.irnd(700, 1400); return; }
    }
    // lounging on the couch: eyes settle on the TV (base facing), with the odd glance around the room
    if (agent.goal === 'lounge') {
      if (U.chance(0.25)) { setGlance(U.pick(['east', 'west', 'south']), U.irnd(400, 800), now); agent.glanceCd = now + U.irnd(2600, 5200); }
      else agent.glanceCd = now + U.irnd(1200, 2400);
      return;
    }
    // THE LONG STARE: hold the gaze on the Commander, only the rare slow head-tilt — the stillness is the point
    if (agent.goal === 'stare') {
      if (U.chance(0.15)) { setGlance(U.pick(['south', 'east', 'west']), U.irnd(500, 1100), now); agent.glanceCd = now + U.irnd(2200, 4500); }
      else { agent.dir = 'south'; agent.glanceCd = now + U.irnd(1600, 3200); }
      return;
    }
    // GRIEF: hold the gaze on the empty spot, only the rarest slow shift — the stillness carries it
    if (agent.goal === 'mourn') {
      if (U.chance(0.08)) { setGlance(agent.useFace, U.irnd(600, 1200), now); agent.glanceCd = now + U.irnd(3000, 6000); }
      else { agent.glanceCd = now + U.irnd(1600, 3200); }
      return;
    }
    // a quirk in progress: scan pans itself (timed); the others mostly hold their pose with a rare flick
    if (agent.goal === 'quirk') {
      if (agent.quirkKind === 'vigil') { agent.glanceCd = now + 6000; return; }   // the VIGIL holds dead still — zero head-turns, the held emptiness
      if (agent.quirkKind !== 'scan' && U.chance(0.3)) setGlance(U.pick(['east', 'west', 'south', 'north']), U.irnd(400, 800), now);
      agent.glanceCd = now + U.irnd(1200, 2600);
      return;
    }
    // working at the desk: glance at a freshly placed thing nearby, else fidget-look up from the screen
    if (agent.working) {
      if (novelty.length) {
        const n = novelty[novelty.length - 1], nx = (n.tx + 0.5) * T, ny = (n.ty + 0.5) * T;
        if (Math.hypot(nx - agent.px, ny - agent.py) < 130) {
          setGlance(dirToward(agent.px, agent.py, nx, ny), U.irnd(700, 1200), now); agent.glanceCd = now + U.irnd(3000, 5000);
          curiositySay(n.kind === 'belt' ? CURIO_NEW_BELT : CURIO_NEW_PROP, 0.4, now); return;
        }
      }
      if (now > (agent.nextFidget || 0)) { setGlance(U.pick(['east', 'west', 'south']), U.irnd(500, 950), now); agent.nextFidget = now + U.irnd(9000, 20000); agent.glanceCd = now + 3000; }
      return;
    }
    // a true quiet hold (CONTENT=STILL): suppress BOTH the cargo body-track below AND the ambient swivel — only a rare slow shift breaks it
    if (agent.stilling) {
      if (now < (agent.glanceCd || 0)) return;
      if (U.chance(0.18)) { setGlance(ambientGazeDir(now), U.irnd(450, 800), now); agent.glanceCd = now + U.irnd(6000, 11000); }
      else agent.glanceCd = now + U.irnd(5000, 9000);
      return;
    }
    // a box trundles past an idle agent → turn the WHOLE BODY to track it (held by trackUntil in tick), not just the eyes
    if (U.chance(0.6)) { const box = nearestBox(); if (box && box.d < 56) { const bd = dirToward(agent.px, agent.py, box.x, box.y); setGlance(bd, U.irnd(500, 1000), now); agent.dir = bd; agent.trackUntil = now + U.irnd(1200, 2600); agent.glanceCd = now + U.irnd(3000, 5500); return; } }
    // idle / studying / tending / gazing / on a rounds stop: occasional ambient look around
    if ((agent.goal === 'inspect' || agent.goal === 'tend' || agent.goal === 'gaze' || agent.goal === 'rounds' || agent.goal == null) && U.chance(0.32)) { setGlance(ambientGazeDir(now), U.irnd(450, 850), now); agent.glanceCd = now + U.irnd(4500, 8000); }
  }

  // IDLE CHATTER — REMOVED (Thronglet direction). The agent no longer narrates itself with random
  // one-liners while idle: the sentient/eerie read now comes from GAZE and STILLNESS, not captions.
  // Kept as a no-op so every existing call site stays valid without edits. say() is untouched, so real
  // task replies AND the one-shot FIRST-LIGHT thought (which routes through say() directly) still speak.
  function curiositySay() { /* silenced by design — the stillness is the point */ }

  function tick(dt, now) {
    if (!agent || agent.unplaced || !geo || awakeFrozen) return;   // frozen during the awakening: the newborn holds still, facing the Commander
    self = agent;                                                  // B1: the hero tick runs with self===agent (engine core reads the current body via self) — byte-identical hero path
    if (!agent.lastTaskAt) agent.lastTaskAt = now;                 // anchor downtime at the first live tick
    // TIER D · D3 — STATION-LEVEL SLOT SWEEP (G4): the whole-encounter hard timeout + broken-participant check run
    // here EVERY tick, independent of any body's own stepper — so even if BOTH participants get seized in the same
    // tick (neither runs its per-body guard), the slot ALWAYS frees. self===agent here (set below/above), and
    // endEncounter is idempotent; this is the belt-and-suspenders that makes the slot un-leakable.
    if (socialBeat && (now >= socialBeat.until || encounterBroken(now))) endEncounter(now);
    sweepChase(now);                                              // TIER D · D4: station-level chase sweep (G4) — a seized/despawned/chat-focused chaser ALWAYS frees the lock same-tick, independent of its own stepper
    tickNeeds(dt);                                                 // the inner meters drain/refill by what it is doing
    if (!agent.sitting && !agent.seated) ensureAgentValid();       // CONTAINMENT BACKSTOP (2026-07-12): a standing hero off the floor re-homes NOW, not at the next refit (rederive was the only caller — any missed frame-shift left it adrift until then)
    stepCrew(dt, now);                                             // the OTHER agents wander the station while idle (the hero is below)
    const SPEED = 34 * (agent.pers ? agent.pers.pace : 1);         // temperament: each agent walks at its own pace
    // settle: a beat of sitting (loading context) before the screens light + typing latches on
    if (agent.goal === 'work' && !agent.working && agent.settleUntil && now >= agent.settleUntil) { agent.working = true; agent.settleUntil = 0; }
    // body-track: keep the torso turned to a tracked box for a beat after the glance (whole-body attention, eased by glanceCd)
    if (agent.goal == null && agent.state !== 'walk' && agent.trackUntil > now) { const box = nearestBox(); if (box && box.d < 90) agent.dir = dirToward(agent.px, agent.py, box.x, box.y); }
    // self-heal a stuck walker: the walk pose with nowhere to go (target + path both gone —
    // e.g. a REFIT re-bake cleared the in-flight path, or a path came back empty). The idle
    // re-decision below is gated on state !== 'walk', so without this the legs cycle in place
    // forever (moonwalk). Drop to idle and let this same tick re-path / re-summon.
    if (agent.state === 'walk' && !agent.target && (!agent.pathPts || agent.pathIdx >= agent.pathPts.length)) {
      agent.state = 'idle'; agent.idleUntil = 0;
    }
    // G4 feature 1 — THE AWAIT INVARIANT (runs ABOVE the desk-trip): while blocked on a permission.prompt the
    // hero is seized to its WAIT ANCHOR instead of its desk. It walks there, then holds an eerie waiting pose
    // (drawn as 'awaiting'). This overrides the desk-trip (gated on !awaitPrompt below) so a run that blocks
    // mid-task visibly leaves the desk and waits — the honest "needs you" body. Cleared by permission.response.
    if (awaitPrompt) {
      if (awaitArrived) {
        // WAITING: stand at the anchor, facing it, shifting weight (a slow, patient, unsettling stillness).
        agent.sitting = false; agent.working = false; agent.state = 'idle';
        if (awaitAnchor && awaitAnchor.face) agent.dir = awaitAnchor.face;
      } else if (!awaitAnchor) {
        // no anchor resolvable (walled-in board, no seat) — wait in place, standing, facing the camera.
        agent.goal = 'awaiting'; agent.sitting = false; agent.working = false; agent.state = 'idle'; agent.dir = 'south'; awaitArrived = true;
      } else if (agent.goal === 'awaitwalk' && agent.state !== 'walk' && (!agent.pathPts || agent.pathIdx >= agent.pathPts.length)) {
        // start (or, if already at the tile, finish) the walk to the anchor.
        const cur = tileOf(agent.px, agent.py);
        if (cur.x === awaitAnchor.tx && cur.y === awaitAnchor.ty) { agent.goal = 'awaiting'; awaitArrived = true; agent.dir = awaitAnchor.face || 'south'; }
        else if (!setPathTo({ x: awaitAnchor.tx, y: awaitAnchor.ty })) { agent.goal = 'awaiting'; awaitArrived = true; agent.dir = awaitAnchor.face || 'south'; }   // unreachable → wait where it stands
      }
      maybeGlance(now);   // the occasional camera glance while waiting rides the existing glance system
    }
    // THE DESK-TRIP INVARIANT: while activity==='task' the agent is seized HERE — this block runs ABOVE every
    // idle/leisure branch in the tick ladder, and all of those are gated on activity==='idle', so the agent
    // walks to the workstation and STAYS seated working until activity flips off 'task' (the branch below then
    // stands it up). Never add a branch that moves the body while activity==='task'. NOTE: chat.js now ARMS
    // 'task' REACTIVELY — the moment a run makes its first real tool call (walkToDesk), not the instant the
    // Commander sends a message — so a question answered from memory never triggers this. Once armed it holds
    // for the rest of the run. The talk/task mapping still lives in classify.js (stanceFor) + classify.test.js.
    // SUMMONED → don't teleport: pause where it stands (loading context) facing the desk, THEN walk over
    if (!awaitPrompt && activity === 'task' && agent.goal !== 'work') {
      if (agent.goal !== 'summon' && agent.goal !== 'fetch') { releaseSeat(); if (chaseId === agent.id) chaseId = null; agent.chase = null; agent.mimic = null; agent.goal = 'summon'; agent.sitting = false; agent.working = false; agent.stilling = false; agent.usingProp = null; agent.watchProp = null; agent.target = null; agent.pathPts = null; agent.pauseUntil = 0; agent.pauseLook = null; agent.state = 'idle'; agent.dir = 'north'; agent.thinkUntil = now + U.irnd(400, 1200); curiositySay(SELF_ONDUTY, 0.9, now); }
      // CONVEYOR-DELIVERED work (cron/channel): first walk UP TO this agent's ASSIGNED conveyor (its bound bay),
      // THEN to the workstation. Only when the work actually rode a belt (taskViaConveyor) AND this agent owns a
      // reachable bay; otherwise straight to the seat (in-app chat is byte-identical — no detour).
      else if (agent.goal === 'summon' && now >= agent.thinkUntil) {
        const conv = agent.taskViaConveyor ? assignedConveyorTile(agent.id) : null;
        if (conv && setPathTo({ x: conv.x, y: conv.y })) agent.goal = 'fetch'; else goToSeat();
      }
      // reached the conveyor → now head to the workstation and work
      else if (agent.goal === 'fetch' && agent.state !== 'walk' && (!agent.pathPts || agent.pathIdx >= agent.pathPts.length)) goToSeat();
    }
    if (activity !== 'task' && (agent.goal === 'work' || agent.goal === 'summon' || agent.goal === 'fetch')) {
      agent.goal = null; agent.sitting = false; agent.working = false; agent.thinkUntil = 0; agent.settleUntil = 0; agent.pathPts = null; agent.target = null; agent.state = 'idle'; agent.idleUntil = now + 200; agent.lastTaskAt = now; agent.taskViaConveyor = false;   // just finished real work → relaxed, downtime clock resets
    }
    // freshly placed thing + free to roam → divert and go check it out (even mid-stroll), throttled
    if (activity === 'idle' && novelty.length && agent.goal === null && !agent.working && !agent.sitting && now >= (agent.noticeCd || 0)) {
      if (planInspect(now)) agent.noticeCd = now + 1500;
    }
    maybeGlance(now);   // head-turns over the top of whatever else the agent is doing
    chatStareHold(now); // TIER D · D1: if the Commander has COMMS focus on the hero + it's idle, hold its attention on you (faces south; rare throttled cursor-follow beat) — runs AFTER maybeGlance so the stare owns the final facing. Self-gates OFF while activity==='task'/mid-goal/walking, so the summon-seize above always wins (G2)
    // TIER D · D3: a live social encounter drives the body (walk-to-rendezvous → hold → break). The guard enforces
    // the whole-encounter hard timeout + the partner-broken check EVERY tick (G4/K3), then stepSocial (re)paths or
    // holds. It sits BELOW the summon-seize block above (which flips goal off 'social' via encounterBroken → the
    // survivor releases this tick, K3), so work always wins (G2). Only runs while genuinely idle+on the social goal.
    if (activity === 'idle' && agent.goal === 'social') { if (!stepSocialGuard(now)) stepSocial(now); }
    // TIER D · D4: the hero's cursor-mimic (head-only) / THE CHASE (walk-pursue-stare) steppers. Both sit BELOW the
    // summon-seize block (which flips goal off 'mimic'/'chase') so work always wins (G2). Only while genuinely idle.
    if (activity === 'idle' && agent.goal === 'mimic') stepMimic(now);
    if (activity === 'idle' && agent.goal === 'chase') stepChase(now);
    if (agent.target) {
      // belt-yield: about to cross a belt with cargo bearing down → pause and let it pass (only on a casual stroll)
      if (now >= (agent.pauseUntil || 0) && now >= (agent.yieldCd || 0) && agent.goal == null && shouldYieldToCargo()) {
        agent.pauseUntil = now + U.irnd(450, 850); agent.pauseLook = 'cargo'; agent.yieldCd = now + 2600;
      }
      if (now < (agent.pauseUntil || 0)) {
        // a deliberate hold mid-walk: stand, and (for a look-back / yield) turn toward what stopped it
        agent.state = 'idle';
        if (agent.pauseLook === 'back') agent.dir = OPP[agent.dir] || agent.dir;
        else if (agent.pauseLook === 'cargo') { const b = nearestBox(); if (b) agent.dir = dirToward(agent.px, agent.py, b.x, b.y); }
      } else {
        const dx = agent.target.x - agent.px, dy = agent.target.y - agent.py, d = Math.hypot(dx, dy);
        const more = !!(agent.pathPts && agent.pathIdx < agent.pathPts.length);
        if (d < (more ? CORNER_LOOK : 1.1)) {   // early hand-over, no snap — see stepCrewToSeat's note
          if (more) nextWaypoint();
          else { agent.px = agent.target.x; agent.py = agent.target.y; arrive(now); }
        } else {
          const s = stepGait(agent, dx, dy, d, SPEED, !more, dt);
          agent.px += dx / d * s; agent.py += dy / d * s; agent.state = 'walk';
        }
      }
    } else if (agent.goal === 'use') {
      // lounging at a prop: hold the pose until the dwell timer ends, then drift back to wandering
      if (now >= agent.useUntil) { releaseSeat(); agent.goal = null; agent.usingProp = null; agent.sitting = false; agent.state = 'idle'; agent.idleUntil = now + U.irnd(400, 1200); }
    } else if (agent.goal === 'lounge') {
      // sitting on the couch watching the TV: maybeGlance animates the gaze; clear both props when done
      if (now >= agent.useUntil) { releaseSeat(); agent.goal = null; agent.usingProp = null; agent.watchProp = null; agent.sitting = false; agent.state = 'idle'; agent.idleUntil = now + U.irnd(400, 1200); }
    } else if (agent.goal === 'rounds') {
      if (now >= agent.studyUntil) roundsNext(now);   // ownership pause done -> walk to the next stop (or end the lap)
    } else if (agent.goal === 'sleep') {
      if (now >= agent.studyUntil) { agent.goal = null; agent.sitting = false; agent.glanceCd = 0; agent.state = 'idle'; agent.idleUntil = now + U.irnd(600, 1800); }   // wakes naturally from dormancy
    } else if (agent.goal === 'inspect' || agent.goal === 'watch' || agent.goal === 'tend' || agent.goal === 'gaze' || agent.goal === 'quirk' || agent.goal === 'stare' || agent.goal === 'mourn' || agent.goal === 'revisit' || agent.goal === 'post') {
      // observing / tending / gazing / a quirk / the long stare / grief / a haunt revisit / D5 board-survey: hold until the dwell ends (maybeGlance animates it), then re-decide
      if (now >= agent.studyUntil) {
        const back = (agent.goal === 'inspect' || agent.goal === 'watch') ? agent.useFace : null;   // a glance back at what it studied as it turns away
        agent.goal = null; agent.usingProp = null; agent.studyKey = null; agent.quirkKind = null; agent.state = 'idle'; agent.idleUntil = now + U.irnd(1400, 3000);
        if (back && U.chance(0.5)) setGlance(back, U.irnd(500, 900), now);
      }
    } else if (agent.goal === 'firstwake') {
      stepFirstWake(now);   // FIRST LIGHT ritual sequencer (sits BELOW the summon-seize block, so a summon always wins)
    } else if (agent.goal === 'social') {
      // TIER D · D3: hero in a social encounter with no active target = the HOLD phase. The guard/stepSocial (run
      // above, before `if (agent.target)`) own the facing + lifecycle; this branch only STOPS the ladder from
      // reaching decideIdle, which would stomp the encounter with a wandering beat.
      agent.state = 'idle';
    } else if (agent.goal === 'mimic' || agent.goal === 'chase') {
      // TIER D · D4: mimic (head-only follow) / chase (stare phase, or a between-repaths beat) with no active
      // target. stepMimic/stepChase (run above) own the facing + lifecycle; this branch only STOPS the ladder
      // from reaching decideIdle, which would stomp the beat with a wandering pick.
      agent.state = 'idle';
    } else if (activity === 'idle' && agent.state !== 'walk' && !agent.sitting && now >= agent.idleUntil) {
      decideIdle(now);
    }
  }

  /* ---------- render ----------
     frame() is a CRASH-GUARD WRAPPER around frameBody(): it schedules the NEXT rAF FIRST (so a throw in the
     render body can never permanently kill the loop), then runs the body in try/catch. A throwing frame is
     logged ONCE per distinct message (no per-frame spam); after RENDER_FAULT_LIMIT consecutive throws it paints
     an honest "RENDER FAULT" overlay while still attempting frames, and a single clean frame resets the counter.
     frameBody() therefore NEVER reschedules rAF itself — the wrapper owns scheduling, so exactly one callback is
     ever alive (double-scheduling was the old early-out bug). */
  let renderFaults = 0;         // consecutive throwing frames
  let lastFaultMsg = '';        // de-dupe console spam: only log a NEW error message
  const RENDER_FAULT_LIMIT = 30;

  /* The backdrop the station floats in — THE VOID by default, or whichever the commander picked
     (SpaceBG owns the registry + the selection; StationUI's appearance section sets it). Base
     fill included, so callers never pre-fill. `cam` lets finite-distance layers parallax; the
     fallback exists because a missing SpaceBG must still leave a black stage, not a stale frame. */
  function drawBackdrop(now, cam) {
    if (typeof SpaceBG !== 'undefined') SpaceBG.draw(ctx, cv.width, cv.height, now, cam);
    else { ctx.fillStyle = '#040302'; ctx.fillRect(0, 0, cv.width, cv.height); }
  }
  function frame(now) {
    if (running) raf = requestAnimationFrame(frame);   // schedule next frame FIRST — a throw below can't kill the loop
    try {
      frameBody(now);
      if (renderFaults) { renderFaults = 0; lastFaultMsg = ''; }   // a clean frame clears the fault state
    } catch (e) {
      renderFaults++;
      const msg = (e && e.message) || String(e);
      if (msg !== lastFaultMsg) { lastFaultMsg = msg; try { console.error('[world] render frame threw (x' + renderFaults + '):', e); } catch (_) {} }
      if (renderFaults >= RENDER_FAULT_LIMIT) { try { drawRenderFault(); } catch (_) {} }
    }
  }

  // an honest fault overlay: the station render loop is faulting, and the app SAYS SO rather than freezing on a
  // stale frame (truthful telemetry). Screen-space, VT323 + phosphor glow, drawn on the raw device pixels.
  function drawRenderFault() {
    if (!ctx || !cv) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const cx = cv.width / 2, cy = cv.height / 2;
    ctx.font = Math.round(28 * (window.devicePixelRatio || 1)) + 'px VT323, monospace';
    ctx.shadowColor = 'rgba(255,80,60,0.9)'; ctx.shadowBlur = 12 * (window.devicePixelRatio || 1);
    ctx.fillStyle = '#ff5a3c';
    ctx.fillText('RENDER FAULT', cx, cy);
    ctx.font = Math.round(14 * (window.devicePixelRatio || 1)) + 'px VT323, monospace';
    ctx.shadowBlur = 6 * (window.devicePixelRatio || 1);
    ctx.fillStyle = '#ffb0a0';
    ctx.fillText('the station render loop is faulting — reload if this persists', cx, cy + Math.round(26 * (window.devicePixelRatio || 1)));
    ctx.shadowBlur = 0; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  let linkStaleDim = false;   // E1: set once per frame — dims the live-telemetry draws when the SSE bridge is down
  let lastTtlSweepAt = 0;     // E2: throttle the paired-state TTL sweep to once per second (never per-frame)
  function frameBody(now) {
    const dt = Math.min(64, now - last); last = now; fnow = now;
    linkStaleDim = linkDown(now);   // recompute the honest link state before any telemetry is drawn this frame
    if (now - lastTtlSweepAt >= 1000) { lastTtlSweepAt = now; try { sweepStaleStates(now); } catch (_) {} }   // E2: degrade any paired state whose end-event was lost
    if (wakeDark !== wakeDarkTarget) { wakeDark += (wakeDarkTarget - wakeDark) * Math.min(1, dt / 260); if (Math.abs(wakeDark - wakeDarkTarget) < 0.002) wakeDark = wakeDarkTarget; }
    if (kindleArmed) {   // THE KINDLING: the user's hold fills the spark; release lets it ebb; full → ignite
      kindleP = kindleHolding ? Math.min(1, kindleP + dt / 1500) : Math.max(0, kindleP - dt / 900);
      if (kindleP > kindlePeak) kindlePeak = kindleP;
      wakeDarkTarget = 0.985 - 0.05 * kindleP;   // the room hints awake as it kindles (still dark until ignition)
      if (kindleP >= 1) { kindleArmed = false; kindleHolding = false; const cb = kindleDone; kindleDone = null; if (cb) cb(); }
    }
    if (camAnim) {   // the scripted awakening camera owns {scale,panX,panY} while a move runs
      camAnim.t = Math.min(1, camAnim.t + dt / camAnim.dur);
      const k = camAnim.ease(camAnim.t);
      scale = lerpv(camAnim.fromS, camAnim.toS, k); panX = lerpv(camAnim.fromX, camAnim.toX, k); panY = lerpv(camAnim.fromY, camAnim.toY, k);
      if (camAnim.t >= 1) { const oe = camAnim.onEnd; camAnim = null; if (oe) oe(); }
    }
    if (geoDirty) rederive();
    if (bakeDirty || !cache) rebake();
    tick(dt, now);

    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
    if (!cache) {
      // no bake yet — still paint the backdrop so the stage is never a blank rect. No camera to
      // parallax against here (the settle block below is what resolves it), so pass none.
      drawBackdrop(now, null);
      return;   // wrapper frame() already scheduled the next rAF — never double-schedule here
    }
    if (fitNeeded && !camAnim) { fitCamera(); fitNeeded = false; }   // the scripted awakening camera owns the transform while it runs
    cinecamTick(now);   // the idle auto-director: may cast/re-cast a 'cine' follow-lock (never touches a 'session' lock; inert while the Commander is active)
    if (camLock && !camAnim) {   // FOLLOW-LOCK: continuously trail the locked body (session select or the idle cinecam)
      const lb = bodyForAgent(camLock.id);
      if (!lb || lb.unplaced) camLock = null;   // subject despawned / off-floor → release (the director re-casts next frame if it owns the camera)
      else {
        const ts = camLock.sc, lx = cv.width / 2 - bodyPosX(lb) * ts, ly = cv.height * 0.56 - bodyPosY(lb) * ts;
        const k = 0.08;   // softer than the one-shot focus ease (0.16): a trailing, cinematic follow of a moving body
        scale += (ts - scale) * k; panX += (lx - panX) * k; panY += (ly - panY) * k;
      }
    }
    if (camLerp && !camAnim && !camLock) {   // gently ease toward a conversation framing (set by focusAgent); the awakening camera + a follow-lock win
      const k = 0.16;
      scale += (camLerp.scale - scale) * k; panX += (camLerp.panX - panX) * k; panY += (camLerp.panY - panY) * k;
      if (Math.abs(camLerp.scale - scale) < 0.01 && Math.abs(camLerp.panX - panX) < 1 && Math.abs(camLerp.panY - panY) < 1) {
        scale = camLerp.scale; panX = camLerp.panX; panY = camLerp.panY; camLerp = null;
      }
    }
    /* THE BACKDROP — what the station floats in (SpaceBG). Drawn AFTER the camera settle block
       above so its parallax reads THIS frame's pan: sampling the camera before camAnim/camLock/
       camLerp ran would leave every finite-distance layer a frame behind the station, which is
       exactly the "picture behind a picture" tell the parallax exists to kill. Still screen
       space, still under the identity transform, still first — nothing has drawn yet. */
    drawBackdrop(now, { panX, panY, scale });

    ctx.setTransform(scale, 0, 0, scale, panX, panY); ctx.imageSmoothingEnabled = false;

    ctx.drawImage(cache.baseCv, 0, 0);

    // conveyor belts (floor machinery) + the live transport sim — local frame, under entities
    if (geo && geo.belts && typeof Conveyor !== 'undefined') {
      if (!convey) convey = Conveyor.create({ onDeliver: onWorkitemDeliver });
      // stops = bound-bay hookup tiles (crate-physics truth: an inbound crate is CONSUMED at its dock,
      // never riding past it toward the outbox — an addressed crate stops only at its OWNER's dock)
      convey.tick(dt, now, geo.belts, junctions, routingPlan ? routingPlan.bayTileToAgent : null);
      convey.drawBelts(ctx, now, T, geo.belts, beltLiveSet);
    }

    const items = [];
    // placeable props (furniture) — drawn over the bake, y-sorted with agents, under the lightmap
    if (geo && geo.props && geo.props.length && typeof PropSprites !== 'undefined') {
      PropSprites.setCtx(ctx); PropSprites.setNow(now);
      if (PropSprites.setOutboxCrates) PropSprites.setOutboxCrates(returnCrates());   // G2.3: uncollected while-away work stacks on the chute
      if (PropSprites.setMissionPins) { const mp = missionPinCounts(now); PropSprites.setMissionPins(mp[0], mp[1], mp[2], mp[3]); maybePinProposal(now, mp[3]); }   // G1b/G1c: open quests pin to the MISSION BOARD; a station-gap keeps it breathing; a jammed routine flags an amber JAM stub; G4: pending proposals + the walk-and-pin body
      if (PropSprites.setTrophyCount) PropSprites.setTrophyCount(trophyCount(now));   // G3b: earned trophies stand behind glass in the TROPHY CASE
      const outboxLit = now - lastOutboxFlash < 600;   // the OUTBOX flares for 600ms after a reply dispatches
      for (const p of geo.props) {
        const work = (p.t === 'outbox' && outboxLit) || (p.t === 'bay' && bayLit(p, now)) || workstationLit(p) || !!(agent && (agent.usingProp === p.id || agent.watchProp === p.id));
        // G0.2/G0.3 live desk truth: a LIT assigned workstation carries its agent's real activity heat
        // (token/tool-driven, heatFor) + a task-progress fraction ONLY when a real one was published
        // (deskProgFor — a live harness run has none and renders none).
        const live = (p.agentId && workstationLit(p)) ? { heat: heatFor(p.agentId), prog: deskProgFor(p.agentId) } : null;
        // a couch with a seated agent (hero OR crew) sorts JUST IN FRONT of its sitter: the couch art is the
        // BACK of the sofa (it faces north, toward the TV wall), so the tall rear panel occludes the sitter's
        // body and only head/shoulders peek over the cap. Any body lounging on THIS prop counts. All cushions
        // share one seatPy ((couch.y+h)*T-2), so any sitter's seatPy+1 places the couch in front of them all.
        const sitter = (agent && agent.seated && agent.usingProp === p.id) ? agent
          : crew.find(b => b.seated && b.usingProp === p.id);
        let sy = sitter ? sitter.seatPy + 1 : (p.y + (p.h || 1)) * T;
        // MOUNT LIFT, resolved per FRAME rather than stored on the prop: a table-top prop only rides the
        // table while the table is actually under it. Reclaim the table and the prop drops back to the
        // deck instead of floating — which is why no saved station ever needs migrating for this.
        const mspec = (PropSprites.spec && PropSprites.spec(p.t)) || null;
        let mounted = null;
        if (mspec && mspec.mount === 'surface' && station && station.surfaceHostOf) {
          if (station.surfaceHostOf(p)) mounted = 'surface';
        }
        // a table-top object must draw AFTER its table: both occupy the same tiles, so their sort keys are
        // equal and array order would decide it — which is whichever the player happened to place first
        if (mounted === 'surface') sy += 0.5;
        const dp = mounted ? Object.assign({}, p, { mount: mounted }) : p;
        items.push({ y: sy, draw: () => PropSprites.draw(dp, work, live) });
        // an ASSIGNED workstation is the hero's desk with another name: give it the same chair, in front,
        // y-sorted exactly like the hero's (one row below the desk) so its agent reads as sitting IN it. Scoped
        // to assigned PCs so a decorative/unmanned console keeps its existing look and the chair only ever
        // appears where an agent will actually sit (chair + sitter stay in lockstep — see stepCrewToSeat).
        if (p.agentId && isWorkstationProp(p.t)) { const s = deskSeat(p); if (s) items.push({ y: (s.ty + 1) * T, draw: () => drawSeatChair(s.tx, s.ty, s.cx) }); }
      }
    }
    // one chair art everywhere: seats route through the canonical prop renderer (old F_chair = fallback)
    function drawSeatChair(tx, ty, cx) {
      const sx = (cx == null ? tx : cx);   // fractional x centres the chair on an even-width desk
      if (typeof PropSprites !== 'undefined' && PropSprites.has('chair')) {
        PropSprites.setCtx(ctx); PropSprites.setNow(now);
        PropSprites.draw({ t: 'chair', x: sx, y: ty, w: 1, h: 1 }, false);
      } else F_chair(sx * T, ty * T);
    }
    if (desk && !deskPropId) items.push({ y: (desk.ty + desk.h) * T, draw: () => {   // skip the synthetic desk when a PLACED workstation prop is the hero's desk (the prop draws itself)
      // one desk art everywhere: the synthetic auto-desk routes through the canonical prop renderer,
      // carrying the truthful G0.2/G0.3 live data (heat + published progress) into the prop desk
      const work = !!(agent && agent.working);
      const live = work ? { heat: heatFor(agent.id), prog: deskProgFor(agent.id) } : null;
      if (typeof PropSprites !== 'undefined' && PropSprites.has('desk')) {
        PropSprites.setCtx(ctx); PropSprites.setNow(now);
        PropSprites.draw({ t: 'desk', x: desk.tx, y: desk.ty, w: desk.w, h: desk.h }, work, live);
      } else F_desk(desk.tx * T, desk.ty * T, desk.w * T, desk.h * T, { x: desk.tx, work, heat: live ? live.heat : 0, prog: live ? live.prog : null });
    } });
    if (seat && !deskPropId) items.push({ y: (seat.ty + 1) * T, draw: () => drawSeatChair(seat.tx, seat.ty, seat.cx) });
  // a PLACED hero desk's chair is drawn by the workstation loop above; draw here only for the synthetic auto-desk
    if (agent && !agent.unplaced) items.push({ y: rposY(), draw: () => drawAgent(now) });
    for (const b of crew) items.push({ y: (b.seated ? b.seatPy : b.py), draw: () => drawAgent(now, b) });   // the other agents, at their bays (seated → sort by the cushion pos like the hero's rposY, so a couch-lounging crew body tucks just behind the back-facing couch panel, head over the cap)
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
    if (convey) convey.drawBoxes(ctx, now, T);   // boxes ride on top of the belts
    drawHandoffBoxes(now);   // Stage 2: lead→worker delegation boxes fly over the entities
    drawMeeseeks(now);   // G4.3: the ephemeral sub-agent helper sprites clustered near the lead's desk (over the entities)
    drawQueueJam(now);   // the live backlog as a physical jam of waiting crates at the INTAKE (world-space, under the lightmap)
    drawShippedPallet(now);   // SHIPPED TODAY: completed jobs stack as product crates at the OUTBOX (server-truth count)

    ctx.drawImage(cache.lightCv, 0, 0);
    drawGlows(now);
    drawDust(now);   // Slice 3: tiny motes drifting through the light pools (world-space, additive, over the glows)
    drawDeskFlashes(now);   // G0.4/G0.8: red distress strobe over a desk whose run just died (additive, with the glows)
    drawAwakenLight(now);   // the soul kindling: ignition spark + a growing halo + motes (world-space additive, awakening only)
    // the AWAKENING veil — now a SPOTLIGHT on the newborn (center light, corners dark) that warms cold->dawn,
    // drawn UNDER the speech bubble so its first words still glow while the room is dark.
    if (wakeDark > 0.002) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const prog = Math.max(0, Math.min(1, 1 - wakeDark / 0.92));
      const tr = Math.round(2 + prog * 12), tg = Math.round(3 + prog * 5), tb = Math.round(8 - prog * 4);   // cold blue-black -> warm ember
      if (agent && !agent.unplaced) {
        const ax = agent.px * scale + panX, ay = (agent.py - 8) * scale + panY;
        const r0 = 22 * scale, r1 = Math.max(r0 + 12, Math.min(cv.width, cv.height) * 0.62);
        const g = ctx.createRadialGradient(ax, ay, r0, ax, ay, r1);
        g.addColorStop(0, 'rgba(' + tr + ',' + tg + ',' + tb + ',' + (wakeDark * 0.16).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(' + tr + ',' + tg + ',' + tb + ',' + wakeDark.toFixed(3) + ')');
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = 'rgba(' + tr + ',' + tg + ',' + tb + ',' + wakeDark.toFixed(3) + ')';
      }
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.setTransform(scale, 0, 0, scale, panX, panY);
    }
    if (kindleArmed || kindleP > 0) drawKindle(now);   // THE KINDLING — dormant ember + hold prompt + awareness bar (pre-ignition)
    if (floodAt) drawFlood(now);   // THE FLOOD — the cascade of knowledge streaming in, over the dark room
    if (dawnAt && now - dawnAt < 1300) drawDawnBloom(now);   // the room takes its first breath of light
    // (the context-window gauge now lives engraved in the bottom bar — StationUI.ctxTick, not the desk)
    drawRunClocks(now);   // G0.2: the honest elapsed-time tag at every desk with a live run (world-space, over the lightmap)
    drawWorkGlyphs(now);  // stage-ticker STRETCH: the "▸ TOOL" tag at a desk with a real tool in flight (one line below the run clock)
    drawAwaitTag(now);    // G4.1: the amber AWAITING APPROVAL tag over a permission-blocked hero
    drawRoutingNags(now); // BELT LEGIBILITY: the compiled plan's errors as in-world callouts on the broken piece
    drawBeltHoverTag(now);// BELT LEGIBILITY: hover a belt tile → where does this line flow (a glance, never a window)
    drawOutboxHoverTag(now);// OUTBOX LEGIBILITY: hover the stacked chute → what the crates are + what a click does
    drawDockFlashes(now); // LONE-BAY dock arrival: the bay visibly catches work when no belt line exists
    drawPinFlourish(now); // G4.2: the amber pin-burst at the board the instant a proposal is pinned
    if (agent && !agent.unplaced) drawBubble(now);
    for (const b of crew) drawBubble(now, b);   // crew speech bubbles (e.g. "received: …" when work routes to them)
    if (hoverAgent && !hoverAgent.unplaced) drawNameplate(now, hoverAgent);
    // FLOOR-STATS OVERLAY REMOVED (2026-07-09 decision): the YIELD/RUNS/CACHE/SLAG/THRU/DWELL box no
    // longer floats over the world sim. The FloorStats engine stays live (event-fed) so any panel or
    // widget consumer keeps honest numbers — only the floating canvas readout is gone.
    if (linkStaleDim) drawLinkDown(now);   // E1: honest "the live telemetry is not live" marker in the chrome
    // (station growth headline now lives in the top bar's STATION chip — see xpstore.pushTopbar)
    drawCurve(now); // barrel-warp the whole feed IN-CANVAS — the original (dot-matrix-era) curve, no dots
    drawCRT(now);   // scanlines + fade, painted in-canvas at device-px OVER the warped feed (no moiré)
    // NOTE: the next rAF is scheduled by the frame() crash-guard wrapper, BEFORE this body runs — never here.
  }

  // ---- CRT SCANLINES + FADE (screen-space, drawn last, OVER the curved feed) --------
  // Runs AFTER drawCurve, so the scanlines sit straight on TOP of the already-warped picture and are
  // painted at EXACT device pixels (integer pitch/line) — no resampling, so no moiré. (The earlier CSS
  // overlay rasterised the line gradient against the display grid and beat into wide stripes; in-canvas
  // device-px lines, the proven desktop look, don't.) Honors body.no-scan.
  // SOFT scanline pattern — a smooth raised-cosine darkening per period, NOT hard on/off bars. Hard bars
  // carry sharp edges (lots of high-frequency harmonics) that beat into diagonal moiré stripes the moment
  // the canvas is resampled (display scaling, any non-1:1 mapping). A pure-sine profile carries only its
  // fundamental, so when scaled down it averages into gentle uniform dimming instead of striping, and at
  // 1:1 it still reads as CRT lines. Cached; rebuilt only when scan/pitch/dpr change.
  function scanCanvas(scan, pitch, dpr) {
    const P = Math.max(2, Math.round(pitch * dpr));
    const key = scan.toFixed(3) + '|' + P;
    if (_scanKey === key && _scanCv) return _scanCv;
    const pc = document.createElement('canvas'); pc.width = 1; pc.height = P;
    const pctx = pc.getContext('2d'), id = pctx.createImageData(1, P);
    for (let y = 0; y < P; y++) {
      const a = scan * (0.5 + 0.5 * Math.cos(2 * Math.PI * y / P));   // darkest at the line, smoothly transparent between
      id.data[y * 4] = 0; id.data[y * 4 + 1] = 0; id.data[y * 4 + 2] = 0; id.data[y * 4 + 3] = Math.round(a * 255);
    }
    pctx.putImageData(id, 0, 0);
    _scanCv = pc; _scanKey = key;
    return _scanCv;
  }
  function drawCRT(now) {
    if (!cv || document.body.classList.contains('no-scan')) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    const W = cv.width, H = cv.height;
    if (CRT.scan > 0) {                               // soft neutral scanlines, drawn straight on top of the feed
      ctx.globalCompositeOperation = 'source-over';
      const sc = scanCanvas(CRT.scan, CRT.pitch, dpr);
      ctx.fillStyle = ctx.createPattern(sc, 'repeat'); ctx.fillRect(0, 0, W, H);
    }
    if (CRT.fade > 0) {                               // soft faded matte (cool-neutral, no yellow) — CRT.fade
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(' + Math.round(11 * CRT.fade) + ',' + Math.round(12 * CRT.fade) + ',' + Math.round(15 * CRT.fade) + ',1)';
      ctx.fillRect(0, 0, W, H);
    }
    if (CRT.grain > 0.001) {                          // FILM GRAIN — one cached noise tile, jittered per frame (CRT.grain)
      // 'overlay' around mid-gray so grain modulates without lifting black levels; the tile is built
      // ONCE and only its pattern offset changes each frame (a whole-number jitter derived from `now`,
      // quantized to ~15fps so it reads as phosphor noise, not smooth scrolling texture).
      const fi = Math.floor(now / 66);
      const jx = (fi * 53) % 128, jy = (fi * 97) % 128;
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = Math.min(0.25, CRT.grain);
      ctx.translate(jx, jy);
      ctx.fillStyle = grainPattern();
      ctx.fillRect(-jx, -jy, W, H);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  // Cached 128px mid-gray noise tile for the film grain — built once, reused forever (only the
  // draw offset animates). Mid-gray (128) is the 'overlay' neutral, so ±spread is pure texture.
  function grainPattern() {
    if (_grainPat) return _grainPat;
    const S = 128;
    _grainCv = document.createElement('canvas'); _grainCv.width = S; _grainCv.height = S;
    const gctx = _grainCv.getContext('2d'), id = gctx.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const v = 128 + Math.round((Math.random() - 0.5) * 110);
      id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
    }
    gctx.putImageData(id, 0, 0);
    _grainPat = ctx.createPattern(_grainCv, 'repeat');
    return _grainPat;
  }

  // ---- BARREL CURVE — bows the whole feed like a CRT tube --------------------------------------
  // Same signed-off warp (f = 1 - curve·r²): the picture is pulled toward center as r² grows so the rooms
  // bow and the corners fall away into dark, plus the edge vignette (1 - 0.55·r²). Rendered as an EXACT
  // PER-PIXEL remap — each output pixel reads its source through a precomputed inverse-map LUT. NOT a
  // triangle mesh: a mesh draws the picture as thousands of triangles whose seams line up into the diagonal
  // stripes; a per-pixel remap has no triangles, so there are no seams and no diagonal lines. Curve is identical.
  function buildLUT(k, W, H) {
    const key = k.toFixed(4) + '|' + W + 'x' + H;
    if (_lutKey === key && _lut) return;
    const hw = W / 2, hh = H / 2, lut = new Int32Array(W * H);
    for (let oy = 0; oy < H; oy++) {
      const ny = (oy + 0.5 - hh) / hh;
      for (let ox = 0; ox < W; ox++) {
        const nx = (ox + 0.5 - hw) / hw, ro = Math.sqrt(nx * nx + ny * ny);
        let scale = 1;
        if (ro > 1e-6) {                    // invert ro = rs·(1 - k·rs²) for rs (Newton); source dir = output dir
          let rs = ro;
          for (let it = 0; it < 6; it++) {
            const g = rs * (1 - k * rs * rs) - ro, dg = 1 - 3 * k * rs * rs;
            if (Math.abs(dg) < 1e-9) break;
            rs -= g / dg;
          }
          scale = rs / ro;
        }
        const sx = (hw + nx * scale * hw) | 0, sy = (hh + ny * scale * hh) | 0;
        lut[oy * W + ox] = (sx >= 0 && sx < W && sy >= 0 && sy < H) ? (sy * W + sx) : -1;
      }
    }
    _lut = lut; _lutKey = key;
  }
  function drawCurve(now) {
    if (!cv || CRT.curve <= 0 || document.body.classList.contains('no-scan')) return;
    const k = CRT.curve, W = cv.width, H = cv.height;
    if (!_glFailed && drawCurveGL(k, W, H)) return;   // GPU path (near-free); on any failure it flips _glFailed
    drawCurveCPU(k, W, H);                             // CPU fallback (per-pixel LUT) — identical look, heavier
  }

  // GPU barrel warp: upload the frame as a texture and remap it in a fragment shader (same inverse of
  // ro = rs·(1 - k·rs²), same vignette). No per-pixel CPU loop, no getImageData/putImageData → near-free.
  function initGL(W, H) {
    if (_glReady || _glFailed) return _glReady;
    try {
      _glc = document.createElement('canvas'); _glc.width = W; _glc.height = H;
      _gl = _glc.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true }) ||
            _glc.getContext('experimental-webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (!_gl) throw new Error('no webgl');
      const gl = _gl;
      const vs = 'attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }';
      const fs = 'precision highp float; varying vec2 vUv; uniform sampler2D uTex; uniform float uK; uniform float uAberr;\n' +
        'void main(){\n' +
        '  vec2 n = (vUv-0.5)*2.0; float ro = length(n); float rs = ro;\n' +
        '  for(int i=0;i<6;i++){ float g = rs*(1.0-uK*rs*rs)-ro; float dg = 1.0-3.0*uK*rs*rs; rs = rs - g/dg; }\n' +
        '  float scale = ro>1e-5 ? rs/ro : 1.0; vec2 sUv = n*scale*0.5+0.5;\n' +
        '  if(sUv.x<0.0||sUv.x>1.0||sUv.y<0.0||sUv.y>1.0){ gl_FragColor = vec4(0.0,0.0,0.0,1.0); return; }\n' +
        // CHROMATIC ABERRATION (Slice 5a): fringe the channels along the radial direction, offset ∝ curve·r²,
        // so edges split R/B and the center stays clean. uAberr scales the whole effect (0 = none).
        '  vec3 col;\n' +
        '  if(uAberr>0.0001){\n' +
        '    vec2 dir = ro>1e-5 ? n/ro : vec2(0.0);\n' +
        '    float amt = uAberr * (0.008 + uK*0.06) * ro*ro;\n' +   // grows toward the bowed edges
        '    vec2 offs = dir * amt;\n' +
        '    float r = texture2D(uTex, sUv + offs).r;\n' +
        '    float gg = texture2D(uTex, sUv).g;\n' +
        '    float b = texture2D(uTex, sUv - offs).b;\n' +
        '    col = vec3(r, gg, b);\n' +
        '  } else { col = texture2D(uTex, sUv).rgb; }\n' +
        '  float vig = clamp(1.0-0.55*ro*ro, 0.0, 1.0);\n' +
        '  gl_FragColor = vec4(col*vig, 1.0);\n' +
        '}';
      const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s)); return s; };
      const prog = gl.createProgram();
      gl.attachShader(prog, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);   // one big triangle covers the quad
      const loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      _glTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, _glTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);   // NEAREST → crisp pixel art, matches the CPU path
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);   // canvas row 0 is top; flip so texcoords line up right-side-up
      gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
      _glKLoc = gl.getUniformLocation(prog, 'uK'); _glAberrLoc = gl.getUniformLocation(prog, 'uAberr'); _glProg = prog; _glReady = true;
      return true;
    } catch (e) { console.warn('[crt] WebGL curve unavailable, using CPU fallback:', e && e.message); _glFailed = true; _gl = null; return false; }
  }
  function drawCurveGL(k, W, H) {
    try {
      if (!initGL(W, H)) return false;
      const gl = _gl;
      if (_glc.width !== W || _glc.height !== H) { _glc.width = W; _glc.height = H; }
      // OUTPUT SANITY PROBE (2026-07-20, the mac theme-wash report): the warp only MOVES pixels and
      // applies a channel-NEUTRAL vignette, so the frame's global per-channel ratios must survive it.
      // WKWebView's GL sits on a different backend (ANGLE-on-Metal) than Windows — a channel-order/
      // tint divergence there recolors the ENTIRE feed while every 2D pass stays correct. Compare the
      // whole frame's channel ratios (16×16 GPU downscale, ~1KB read) before/after on a few chromatic
      // frames; on divergence, warn with both readings and hand the session to drawCurveCPU
      // (pixel-identical by construction). Zero cost after validation.
      const probing = !_glProbeOk && _glProbeTries < 30 && (_glProbeSkip++ % 45) === 0;
      let pre = null;
      if (probing) { try { pre = probeMeans(cv); } catch (_) { _glProbeTries = 30; pre = null; } }
      gl.viewport(0, 0, W, H);
      gl.bindTexture(gl.TEXTURE_2D, _glTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);   // upload the composited frame
      gl.uniform1f(_glKLoc, k);
      if (_glAberrLoc) gl.uniform1f(_glAberrLoc, Math.max(0, CRT.aberr || 0));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, W, H); ctx.drawImage(_glc, 0, 0);   // blit the warped result back onto the visible feed
      if (pre) {
        const post = probeMeans(cv);   // cv now holds the blitted GL output
        const preSum = pre[0] + pre[1] + pre[2], postSum = post[0] + post[1] + post[2];
        const fail = why => {
          console.warn('[crt] WebGL warp output diverges from its source (in ' + pre.map(v => v.toFixed(0))
            + ' → out ' + post.map(v => v.toFixed(0)) + ', ' + why
            + ') — platform GL bug; switching to the identical CPU warp');
          _glFailed = true;   // this frame already blitted; every following frame takes drawCurveCPU
        };
        if (preSum >= 15) {   // a lit frame carries full judgment; each consumes one bounded try
          _glProbeTries++;
          const spr = m => { const s = m[0] + m[1] + m[2]; if (s <= 0) return 0; return (Math.max(m[0], m[1], m[2]) - Math.min(m[0], m[1], m[2])) / s; };
          // a healthy warp DARKENS a little (vignette) and never invents chroma; the failure class
          // seen in the wild is a wildly brighter/saturated wash, so judge magnitude + minted tint,
          // plus channel-ratio drift when the source frame carries real chroma to compare.
          const plausibleMag = postSum >= preSum * 0.35 - 8 && postSum <= preSum * 1.15 + 12;
          const mintedTint = spr(post) > spr(pre) + 0.15;
          let ratioDrift = false;
          if (spr(pre) >= 0.04 && postSum > 0) {
            const ri = pre.map(v => v / preSum), ro = post.map(v => v / postSum);
            ratioDrift = (Math.abs(ri[0] - ro[0]) + Math.abs(ri[1] - ro[1]) + Math.abs(ri[2] - ro[2])) > 0.08;
          }
          if (!plausibleMag || mintedTint || ratioDrift) fail(!plausibleMag ? 'implausible magnitude' : mintedTint ? 'minted tint' : 'channel-ratio drift');
          else if (++_glProbeClean >= 3) _glProbeOk = true;   // three clean readings — trust this GL stack for the session
        } else if (postSum > preSum * 1.15 + 45) {
          // the reported mac scenario EXACTLY: the wash appeared over the DARK awakening — a
          // near-black input cannot brighten through a darkening warp, so this alone is damning.
          // No try consumed on dark frames either way: a long dark scene must never exhaust the
          // probe budget before the room first lights.
          fail('bright output minted from a dark input');
        }
      }
      return true;
    } catch (e) { console.warn('[crt] WebGL curve draw failed, using CPU fallback:', e && e.message); _glFailed = true; return false; }
  }
  function drawCurveCPU(k, W, H) {
    const hw = W / 2, hh = H / 2;
    if (!_warpCv) { _warpCv = document.createElement('canvas'); _warpCtx = _warpCv.getContext('2d', { willReadFrequently: true }); }
    if (_warpCv.width !== W || _warpCv.height !== H) { _warpCv.width = W; _warpCv.height = H; }
    _warpCtx.setTransform(1, 0, 0, 1, 0, 0); _warpCtx.clearRect(0, 0, W, H); _warpCtx.drawImage(cv, 0, 0);
    buildLUT(k, W, H);
    const src = _warpCtx.getImageData(0, 0, W, H), s32 = new Uint32Array(src.data.buffer);
    if (!_outImg || _outImg.width !== W || _outImg.height !== H) _outImg = ctx.createImageData(W, H);
    const d32 = new Uint32Array(_outImg.data.buffer), lut = _lut, BLACK = 0xFF000000;
    for (let i = 0; i < d32.length; i++) { const s = lut[i]; d32[i] = s < 0 ? BLACK : s32[s]; }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.putImageData(_outImg, 0, 0);
    // edge vignette (matches the dot-matrix's 1 - 0.55·r²): darken toward the bowed corners
    ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.translate(hw, hh); ctx.scale(hw, hh);
    const vg = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.SQRT2);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(0.5, 'rgba(0,0,0,0.275)');     // r²≈0.5
    vg.addColorStop(0.707, 'rgba(0,0,0,0.55)');    // r²≈1 (edge midpoints)
    vg.addColorStop(1, 'rgba(0,0,0,1)');           // r²≈2 (corners) → black
    ctx.fillStyle = vg; ctx.fillRect(-Math.SQRT2, -Math.SQRT2, 2 * Math.SQRT2, 2 * Math.SQRT2);
    ctx.restore();
  }

  function drawGlows(now) {
    if (!cache || !cache.flickers) return;
    ctx.globalCompositeOperation = 'lighter';
    for (const f of cache.flickers) {
      const a = Math.max(0, CRT.glow * (0.55 + 0.45 * Math.sin(now / 210 + f.x) * Math.sin(now / 83 + f.y)));
      const g = ctx.createRadialGradient(f.x, f.y, 1, f.x, f.y, f.r * 0.7);
      g.addColorStop(0, 'rgba(240,230,206,' + a + ')'); g.addColorStop(1, 'rgba(240,230,206,0)');
      ctx.fillStyle = g; ctx.fillRect(f.x - f.r * 0.7, f.y - f.r * 0.7, f.r * 1.4, f.r * 1.4);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // Slice 3 — DUST MOTES. Tiny specks drifting slowly THROUGH the baked light pools (only there — a mote
  // is only visible where light catches it). Purely cosmetic atmosphere; never encodes agent/run state.
  // Deterministic from `now` + each fixture's position seed (no state array, no per-frame allocation —
  // the awakening-motes idiom at drawAwakenLight). ~2-3 motes per fixture, additive, each breathing its
  // alpha 0→~0.35→0 over a long period with a gentle sinusoidal drift confined to the pool radius.
  // Steady (motes hidden) under prefers-reduced-motion; CRT.dust scales/zeroes the whole effect.
  function drawDust(now) {
    if (!cache || !cache.flickers || CRT.dust <= 0.001 || reduceMotion()) return;
    ctx.globalCompositeOperation = 'lighter';
    const amp = CRT.dust;
    for (const f of cache.flickers) {
      const per = 3;                                   // 2-3 motes per fixture
      const R = f.r * 0.5;                             // keep motes inside the visible pool
      for (let k = 0; k < per; k++) {
        const seed = (f.x * 0.11 + f.y * 0.07) + k * 2.399;
        // slow, long-period drift — each mote traces a lazy Lissajous within the pool
        const dx = Math.sin(now / (5200 + k * 900) + seed) * R * 0.7;
        const dy = Math.cos(now / (6100 + k * 700) + seed * 1.7) * R * 0.5;
        // alpha breathes 0 → ~0.35 → 0 over a long, per-mote period (fully off part of the cycle)
        const br = 0.5 + 0.5 * Math.sin(now / (3400 + k * 600) + seed * 2.3);
        const a = amp * 0.35 * br * br;               // squared → longer dark valleys, brief glints
        if (a < 0.01) continue;
        const mx = f.x + dx, my = f.y + dy;
        ctx.fillStyle = 'rgba(246,240,220,' + a.toFixed(3) + ')';
        ctx.fillRect(mx - 0.5, my - 0.5, 1.2, 1.2);   // ~1px speck
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // THE KINDLING render — a dim dormant ember the user's hold brings to life: it brightens and pulls motes
  // inward as kindleP fills, under a screen-space prompt ("hold to wake it") + an awareness bar. Pre-ignition.
  function drawKindle(now) {
    if (!kindleArmed && kindleP <= 0) return;
    const p = kindleP;
    if (agent && !agent.unplaced) {
      const hx = agent.px, hy = agent.py - 12;
      ctx.globalCompositeOperation = 'lighter';
      const breathe = 0.6 + 0.4 * Math.sin(now / (kindleHolding ? 200 : 900));   // faster pulse while held
      const er = 2 + p * 11, a = Math.min(1, (0.10 + 0.9 * p) * (0.65 + 0.35 * breathe));
      const g = ctx.createRadialGradient(hx, hy, 0.4, hx, hy, er + 3);
      g.addColorStop(0, 'rgba(255,240,205,' + a.toFixed(3) + ')'); g.addColorStop(1, 'rgba(255,240,205,0)');
      ctx.fillStyle = g; ctx.fillRect(hx - er - 3, hy - er - 3, (er + 3) * 2, (er + 3) * 2);
      const n = Math.floor(4 + 11 * p);   // motes pulled inward as it kindles
      for (let k = 0; k < n; k++) {
        const seed = k * 1.7, ang = now / 1300 + seed * 2.4, rad = (17 - 12 * p) + (k % 4) * 3 + Math.sin(now / 600 + seed) * 2;
        const mx = hx + Math.cos(ang) * rad, my = hy + Math.sin(ang) * rad * 0.5;
        ctx.fillStyle = 'rgba(255,244,214,' + (0.32 * p).toFixed(3) + ')';
        ctx.fillRect(mx - 0.6, my - 0.6, 1.4, 1.4);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const cw = cv.width, ch = cv.height;
    const promptA = (1 - p) * (0.45 + 0.55 * Math.abs(Math.sin(now / 700)));   // a breathing prompt that fades as it fills
    if (promptA > 0.02) {
      const label = (kindlePeak > 0.12 && !kindleHolding && p > 0.01) ? 'don’t stop —' : 'hold to wake it';
      ctx.font = "16px 'VT323', 'Courier New', monospace";
      ctx.fillStyle = 'rgba(255,170,60,' + promptA.toFixed(3) + ')';
      ctx.fillText(label, cw / 2, ch * 0.74);
    }
    const bw = Math.min(260, cw * 0.42), bh = 6, bx = Math.round((cw - bw) / 2), by = Math.round(ch * 0.78);   // the awareness bar
    ctx.fillStyle = 'rgba(8,10,9,0.55)'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = 'rgba(255,170,60,0.5)'; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    ctx.fillStyle = '#ffcf6a'; ctx.fillRect(bx + 1, by + 1, Math.max(0, (bw - 2) * p), bh - 2);
    ctx.textAlign = 'left';
    ctx.setTransform(scale, 0, 0, scale, panX, panY);
  }

  // the soul kindling: an ignition spark at the head, a halo that grows with consciousness, drifting motes.
  function drawAwakenLight(now) {
    if (!agent || agent.unplaced) return;
    const live = awakeFrozen || (dawnAt && now - dawnAt < 1200);
    if (!live && !(sparkAt && now - sparkAt < 1200)) return;
    const prog = Math.max(0, Math.min(1, 1 - wakeDark / 0.92));
    const pulse = (truthPulseAt && now - truthPulseAt < 360) ? (1 - (now - truthPulseAt) / 360) : 0;   // a flare as each truth is written in
    const hx = agent.px, hy = agent.py - 12;
    ctx.globalCompositeOperation = 'lighter';
    // halo
    const hr = 14 + prog * 30 + pulse * 10;
    let g = ctx.createRadialGradient(hx, hy, 1, hx, hy, hr);
    g.addColorStop(0, 'rgba(255,236,200,' + (0.05 + 0.13 * prog + pulse * 0.12).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255,236,200,0)');
    ctx.fillStyle = g; ctx.fillRect(hx - hr, hy - hr, hr * 2, hr * 2);
    // ignition spark — the discrete instant the mind catches fire (the ONLY light in the dark)
    if (sparkAt && now - sparkAt < 1100) {
      const t = (now - sparkAt) / 1100;
      const flick = t < 0.4 ? (Math.sin(now / 26) > 0 ? 1 : 0.35) : 1;
      const sr = 2 + t * 9, a = flick * (t < 0.5 ? 0.95 : Math.max(0, 0.95 * (1 - (t - 0.5) / 0.5)));
      const gs = ctx.createRadialGradient(hx, hy, 0.5, hx, hy, sr);
      gs.addColorStop(0, 'rgba(255,252,240,' + a.toFixed(3) + ')'); gs.addColorStop(1, 'rgba(255,252,240,0)');
      ctx.fillStyle = gs; ctx.fillRect(hx - sr, hy - sr, sr * 2, sr * 2);
    }
    // motes of consciousness — slow orbital, thicken as it wakes (computed from time, no state to leak)
    if (live) {
      const n = Math.floor(5 + 9 * prog);
      for (let i = 0; i < n; i++) {
        const seed = i * 1.7, ang = now / 1500 + seed * 2.4, rad = 9 + (i % 5) * 4 + Math.sin(now / 760 + seed) * 2;
        const mx = hx + Math.cos(ang) * rad, my = hy + Math.sin(ang) * rad * 0.5;
        const tw = 0.3 + 0.5 * Math.abs(Math.sin(now / 520 + seed));
        ctx.fillStyle = 'rgba(255,244,214,' + (0.38 * tw * (0.4 + 0.6 * prog)).toFixed(3) + ')';
        ctx.fillRect(mx - 0.6, my - 0.6, 1.4, 1.4);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  // dawn bloom — a brief warm wash flooding the whole room as the veil reaches light
  function drawDawnBloom(now) {
    const t = (now - dawnAt) / 1300, a = Math.sin(Math.min(1, t) * Math.PI) * 0.2;
    if (a <= 0.003) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'lighter';
    const cx = cv.width / 2, cy = cv.height * 0.46, r = Math.max(cv.width, cv.height) * 0.75;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,214,150,' + a.toFixed(3) + ')'); g.addColorStop(1, 'rgba(255,214,150,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.globalCompositeOperation = 'source-over'; ctx.setTransform(scale, 0, 0, scale, panX, panY);
  }
  // THE FLOOD — screen-space matrix-rain of real prompt/capability fragments + glyph noise; ramps to
  // overwhelming density, then collapses every glyph inward into the newborn. Amber/gold phosphor to sit
  // with the CRT + dawn palette; hot-white leading glyph. Self-terminating once the collapse completes.
  function drawFlood(now) {
    if (!floodAt || !floodStreams) return;
    const t = now - floodAt;
    const rampIn = Math.min(1, t / 1400);
    let collapse = 0;
    if (floodEndAt) {
      collapse = (now - floodEndAt) / 1000;
      if (collapse >= 1) { floodAt = 0; floodEndAt = 0; floodStreams = null; return; }
    }
    const ec = collapse <= 0 ? 0 : (collapse < 0.5 ? 2 * collapse * collapse : 1 - Math.pow(-2 * collapse + 2, 2) / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'lighter'; ctx.textBaseline = 'top';
    let ax = cv.width / 2, ay = cv.height * 0.46;
    if (agent && !agent.unplaced) { ax = agent.px * scale + panX; ay = (agent.py - 8) * scale + panY; }
    const lineH = 15, H = cv.height, span = (Math.ceil(H / lineH) + 9) * lineH, tail = 8;
    const base = rampIn * (1 - ec * 0.9);
    for (const st of floodStreams) {
      const tt = t - st.delay; if (tt < 0) continue;
      const x = st.x * cv.width;
      ctx.font = st.size + 'px VT323, monospace';
      const headRow = Math.floor((tt / 1000 * st.speed) / lineH);
      for (let k = 0; k < tail; k++) {
        const row = headRow - k;
        let y = (row * lineH) % span; if (y < 0) y += span; y -= tail * lineH;
        if (y < -lineH || y > H) continue;
        let a = base * (k === 0 ? 1 : Math.max(0, (1 - k / tail)) * 0.62);
        let dx = x, dy = y;
        if (ec > 0) { dx = x + (ax - x) * ec; dy = y + (ay - y) * ec; a *= (1 - ec); }
        if (a <= 0.02) continue;
        const tok = st.toks[((row % st.len) + st.len) % st.len];
        ctx.fillStyle = k === 0 ? 'rgba(255,250,235,' + Math.min(1, a * 1.25).toFixed(3) + ')' : 'rgba(255,200,120,' + a.toFixed(3) + ')';
        ctx.fillText(tok, dx, dy);
      }
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.textBaseline = 'alphabetic'; ctx.setTransform(scale, 0, 0, scale, panX, panY);   // restore the baseline we changed, so later text drawers don't inherit 'top'
  }

  function drawAgent(now, who) {
    who = who || agent;   // default = the hero; a crew body passes itself. Hero path is byte-identical (who===agent).
    // voice cues animate the body while the HERO is actually speaking + a "listening" foot-pulse when the mic is
    // live (drawBody/drawFallback read who.speaking). Crew bodies don't use Voice, so these are hero-only.
    const listening = (who === agent) && (typeof Voice !== 'undefined' && Voice.isListening && Voice.isListening());
    if (who === agent) who.speaking = (typeof Voice !== 'undefined' && Voice.isSpeaking && Voice.isSpeaking());
    // while seated on a couch the agent draws on the cushion, not its (adjacent) logical tile — swap
    // px/py for the draw and restore after, so movement/pathing keep using the real logical position.
    const ox = who.px, oy = who.py;
    if (who.seated) { who.px = who.seatPx; who.py = who.seatPy; }
    try {
      // color-into-being: the body fades up from a faint silhouette to full as the spark blooms (HERO only)
      let bornA = 1;
      if (who === agent && bornAt && now - bornAt < 1000) bornA = 0.16 + 0.84 * ((now - bornAt) / 1000);
      const prevA = ctx.globalAlpha;
      if (bornA < 1) ctx.globalAlpha = prevA * bornA;
      let geom = null;
      if (typeof SPRITES !== 'undefined' && SPRITES.ready) geom = SPRITES.drawBody(ctx, who, now);
      if (!geom) drawFallback(now, who);
      // remember the visible head-top (world px) so overlays (nameplate, speech bubble) anchor
      // above the ACTUAL drawn sprite — skins are taller than the old 15px assumption, which
      // parked bubbles over the face. Fallback bodies keep the legacy 15px estimate (null).
      who.visTopPy = geom ? geom.top : null;
      ctx.globalAlpha = prevA;
      // the wake ripple — a triple-ringed sonar pulse of first breath, in the suit color (hero's awakening
      // uses the module wakeAt; a crew body uses its own per-body wakeAt set when it receives work)
      const wa = (who === agent) ? wakeAt : (who.wakeAt || 0);
      if (wa && now - wa < 1500) {
        ctx.save(); ctx.strokeStyle = who.color;
        for (let k = 0; k < 3; k++) {
          const tk = (now - wa) / 1300 - k * 0.18;
          if (tk <= 0 || tk >= 1) continue;
          ctx.globalAlpha = (1 - tk) * 0.6 * (1 - k * 0.22); ctx.lineWidth = Math.max(0.5, 1.5 - tk);
          ctx.beginPath(); ctx.ellipse(who.px, who.py, 4 + tk * 22, 2 + tk * 9, 0, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.restore();
      }
      // SUMMONED-WORKER "working" glow — a soft sustained pulse at the feet of a crew body while ITS real run
      // is in flight (workUntil set by setActivityFor). The honest "this agent is actually working" cue for a
      // deskless summoned worker; hero-exempt (the hero shows work at its desk).
      if (who !== agent && who.workUntil && now < who.workUntil) {
        const wp = 0.35 + 0.25 * Math.sin(now / 360);
        ctx.save(); ctx.globalAlpha = wp * 0.7; ctx.strokeStyle = who.color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(who.px, who.py, 7 + 1.5 * Math.sin(now / 360), 3, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
      // the LEVEL-UP surge: a brief GOLD phosphor bloom localized to this body — a bloom pulse behind the
      // sprite + the same sonar ring as waking. Time-limited (~1.2s), driven by who.levelUpAt (set in
      // pulseLevelUp); piggybacks this render pass (no rAF added). Under reduced motion the moving ring is
      // dropped and only a brief steady bloom remains (an honest "it happened" cue without strobe/travel).
      const lva = (who && who.levelUpAt) || ((who === agent) ? levelUpAt : 0);
      if (lva && now - lva < 1200) {
        const lt = (now - lva) / 1200;                    // 0..1 across the surge window
        // the phosphor BLOOM: a soft radial gold glow that swells early then fades — the "surge" itself
        const bloom = Math.sin(Math.min(1, lt * 1.9) * Math.PI);   // 0→1→0, peaks ~mid
        if (bloom > 0.01) {
          ctx.save();
          ctx.shadowBlur = 16 * bloom; ctx.shadowColor = '#ffd45a';
          ctx.globalAlpha = 0.30 * bloom; ctx.fillStyle = '#ffd45a';
          ctx.beginPath(); ctx.ellipse(who.px, who.py - 5, 6 + 4 * bloom, 8 + 5 * bloom, 0, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
        if (!reduceMotion()) {
          ctx.save(); ctx.strokeStyle = '#ffd45a';
          for (let k = 0; k < 3; k++) {
            const tk = (now - lva) / 1300 - k * 0.18;
            if (tk <= 0 || tk >= 1) continue;
            ctx.globalAlpha = (1 - tk) * 0.7 * (1 - k * 0.2); ctx.lineWidth = Math.max(0.5, 1.6 - tk);
            ctx.beginPath(); ctx.ellipse(who.px, who.py, 5 + tk * 26, 2.5 + tk * 11, 0, 0, Math.PI * 2); ctx.stroke();
          }
          ctx.restore();
        }
      }
      // a soft "I'm listening to you" pulse at the feet — an in-world cue the mic is open and he's hearing
      // you (distinct from just standing facing the Commander). Only while the mic is actually live (hero).
      if (listening) {
        const lp = 0.4 + 0.35 * Math.sin(now / 320);
        ctx.save(); ctx.globalAlpha = lp * 0.7; ctx.strokeStyle = who.color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(who.px, who.py, 8 + 2 * Math.sin(now / 320), 3.5, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
    } finally { who.px = ox; who.py = oy; }
  }

  function drawFallback(now, who) {
    const a = who || agent, x = Math.round(a.px), y = Math.round(a.py), h = 13;
    const step = a.state === 'walk' ? (Math.floor(now / 140) % 2) : 0;
    const bob = (a.state !== 'walk' && !a.sitting)
      ? Math.round(a.speaking ? Math.sin(now / 170 + a.phase) * 1.1 : Math.sin(now / 600 + a.phase) * 0.7) : 0;
    ctx.globalAlpha = 0.3; ctx.fillStyle = '#000'; ctx.fillRect(x - 4, y - 1, 8, 2); ctx.globalAlpha = 1;
    const top = y - h + bob;
    ctx.fillStyle = a.color; ctx.fillRect(x - 3, top + 3, 6, h - 6);
    ctx.fillStyle = '#f0e6c0'; ctx.fillRect(x - 2, top, 5, 4);
    ctx.fillStyle = U.shade(a.color, -0.45);
    if (a.sitting) ctx.fillRect(x - 3, y - 3, 6, 2);
    else { ctx.fillRect(x - 3 + (step ? 1 : 0), y - 2, 2, 2); ctx.fillRect(x + 1 - (step ? 1 : 0), y - 2, 2, 2); }
  }

  /* ---------- hover nameplate: a compact terminal tag for the agent under the cursor ----------
     Screen-space (always sharp — not the zoom-blurred world-space sliver it replaced): a slim CRT
     plate in the station's own VT323 face (the same font stack the DOM uses, so it matches whether
     VT323 is loaded or falls back to Courier), with a faint phosphor glow + scanlines. Codename,
     level, and the 1px XP-to-next sliver along the bottom all share the suit color — one tiny extra.
     Anchored just above the head, clamped to the viewport. Intentionally small: a glance, not a window. */
  const PLATE_FONT = '"VT323","Courier New",monospace';   // the station terminal face (mirrors the body font stack)
  function floorDisplayName(who) {
    const raw = String((who && who.name) || '');
    const key = raw.trim().toUpperCase();
    const bodies = [agent].concat(crew || []).filter(Boolean);
    const duplicate = key && bodies.filter(b => String(b.name || '').trim().toUpperCase() === key).length > 1;
    return duplicate ? raw + ' [' + String(who.id || who.agentId || '') + ']' : raw;
  }
  function drawNameplate(now, who) {
    who = who || agent;
    if (!cache || !who) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false;
    const Wc = cv.width / dpr, Hc = cv.height / dpr;
    const suit = who.color || '#ffaa33';
    const name = floorDisplayName(who);
    // per-body XP: the hero keeps its exact xpByAgent-or-xpAgent fallback; a crew body reads its own snapshot
    const xp = xpByAgent.get(who.id) || (who === agent ? xpAgent : null);
    const lvl = (xp && xp.level) ? ('Lv ' + xp.level) : null;
    const frac = (xp && typeof xp.frac === 'number') ? Math.max(0, Math.min(1, xp.frac)) : 0;

    const nameSz = 17, lvlSz = 16;
    ctx.font = nameSz + 'px ' + PLATE_FONT; const nameW = ctx.measureText(name).width;
    ctx.font = lvlSz + 'px ' + PLATE_FONT;  const lvlW = lvl ? ctx.measureText(lvl).width : 0;
    const padX = 8, gap = lvl ? 9 : 0, h = 21, barH = 2;
    const w = Math.round(padX * 2 + nameW + gap + lvlW);

    // anchor centered just above the head, crisp + clamped to the canvas
    const ax = (bodyPosX(who) * scale + panX) / dpr, ay = (bodyPosY(who) * scale + panY) / dpr;
    // same head-top anchor as drawBubble: real drawn geometry when known, legacy 15px estimate otherwise
    const topY = (who.visTopPy != null) ? (who.visTopPy * scale + panY) / dpr : ay - 15 * scale / dpr;
    const x = Math.round(Math.max(4, Math.min(Wc - w - 4, ax - w / 2)));
    const y = Math.round(Math.max(4, Math.min(Hc - h - 4, topY - 9 - h)));

    // plate: dark CRT glass + scanlines + an amber structural frame with a suit accent along the top
    ctx.fillStyle = 'rgba(6,5,4,0.92)'; ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 0.13; ctx.fillStyle = '#000';
    for (let sy = y + 2; sy < y + h - 1; sy += 3) ctx.fillRect(x + 1, sy, w - 2, 1);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#b9791c'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.globalAlpha = 0.6; ctx.fillStyle = suit; ctx.fillRect(x + 1, y, w - 2, 1); ctx.globalAlpha = 1;

    // codename (suit) + level (gold) in VT323, with a faint phosphor bloom (mirrors the DOM text-shadow)
    const tcy = y + Math.round((h - barH) / 2) + 1;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.shadowBlur = 4; ctx.shadowColor = suit;
    ctx.font = nameSz + 'px ' + PLATE_FONT; ctx.fillStyle = suit; ctx.fillText(name, x + padX, tcy);
    if (lvl) {
      // LEVEL-UP GLINT: right after a level gain the "Lv N" ticks to a gold bloom and settles back to the
      // suit colour over ~1.2s — the plate number itself catches the light. Piggybacks this draw; no timer.
      const lva = who.levelUpAt || (who === agent ? levelUpAt : 0) || 0;
      const gt = lva ? (now - lva) / 1200 : 1;   // now is the shared render clock (fnow); >=1 → settled
      if (gt >= 0 && gt < 1) {
        const glint = Math.sin(Math.min(1, gt * 1.7) * Math.PI);   // 0→1→0 over the window
        ctx.shadowBlur = 4 + 8 * glint; ctx.shadowColor = '#ffd45a';
        // the number catches the light: the suit hue lifted toward a bright gold-white at the glint peak
        ctx.fillStyle = (U && U.shade) ? U.shade(suit, 0.55 * glint) : suit;
      } else {
        ctx.shadowColor = suit; ctx.fillStyle = suit;
      }
      ctx.font = lvlSz + 'px ' + PLATE_FONT; ctx.fillText(lvl, x + padX + nameW + gap, tcy);
    }
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';

    // the one tiny useful extra: a hairline XP-to-next bar along the bottom inside edge (honest — hidden at 0)
    if (frac > 0) {
      const bx0 = x + 1, bw0 = w - 2, byb = y + h - barH - 1;
      ctx.fillStyle = '#140c03'; ctx.fillRect(bx0, byb, bw0, barH);
      ctx.fillStyle = suit; ctx.fillRect(bx0, byb, Math.max(1, Math.round(bw0 * frac)), barH);
    }
  }

  /* ---------- the RUN CLOCK (G0.2): tiny elapsed-time tag at each working desk ----------
     A live harness run has NO knowable percent, so the desk shows the one thing that IS knowable:
     how long the run has actually been going (agent.run.start -> .end, runStartByAgent). World-space,
     the station's VT323 terminal face with a faint phosphor bloom — a glance, never a window. */
  const RUN_FONT = "7px 'VT323','Courier New',monospace";
  function drawRunClocks(now) {
    if (!runStartByAgent.size) return;
    ctx.save();
    if (linkStaleDim) ctx.globalAlpha = 0.3;   // E1: link down → these clocks are last-known, not live; dim them
    for (const [aid, t0] of runStartByAgent) {
      const b = bodyForAgent(aid);
      if (!b || b.unplaced) continue;
      // only at a desk that is honestly in the working pose — a talk-only run never grows a clock
      const working = (b === agent) ? !!agent.working : !!(b.working || (b.workUntil && now < b.workUntil));
      if (!working) continue;
      const sec = Math.max(0, Math.floor((now - t0) / 1000));
      const mm = Math.floor(sec / 60), ss = String(sec % 60).padStart(2, '0');
      const label = 'RUN ' + (mm >= 60 ? Math.floor(mm / 60) + ':' + String(mm % 60).padStart(2, '0') + ':' + ss : mm + ':' + ss);
      // anchor beside the desk's crown (placed workstation, or the hero's synthetic desk), else above the body
      let ax, ay;
      const dp = deskPropFor(aid);
      if (dp) { ax = (dp.x + (dp.w || 1)) * T + 1; ay = dp.y * T + 3; }
      else if (b === agent && desk) { ax = (desk.tx + desk.w) * T + 1; ay = desk.ty * T + 3; }
      else { ax = b.px + 7; ay = b.py - 16; }
      ctx.save();
      ctx.font = RUN_FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.shadowBlur = 3; ctx.shadowColor = '#62ff9e';
      ctx.fillStyle = '#9adcb0';
      ctx.fillText(label, ax, ay);
      ctx.restore();
    }
    ctx.restore();   // E1: close the link-stale dim wrapper
  }

  /* ---------- the DESK WORK-GLYPH (stage ticker STRETCH): a tiny "▸ TOOL" tag at a desk while that agent has
     a tool in flight (agent.tool_call → its tool_result, tracked in glyphByAgent). Complements the RUN clock
     (which sits at the crown, y+3) by sitting one line BELOW it (y+13) so the two never collide. World-space,
     VT323 amber phosphor like drawRunClocks; event-driven state, zero cost when nothing is in flight. */
  const GLYPH_FONT = "8px 'VT323','Courier New',monospace";
  function drawWorkGlyphs(now) {
    if (!glyphByAgent.size) return;
    for (const [aid, g] of glyphByAgent) {
      const b = bodyForAgent(aid);
      if (!b || b.unplaced) continue;
      const working = (b === agent) ? !!agent.working : !!(b.working || (b.workUntil && now < b.workUntil));
      if (!working) continue;
      const label = '▸ ' + tickerTool(g && g.name);
      // anchor beside the same desk the run clock uses, but one line lower (RUN clock is at dp.y*T+3).
      let ax, ay;
      const dp = deskPropFor(aid);
      if (dp) { ax = (dp.x + (dp.w || 1)) * T + 1; ay = dp.y * T + 13; }
      else if (b === agent && desk) { ax = (desk.tx + desk.w) * T + 1; ay = desk.ty * T + 13; }
      else { ax = b.px + 7; ay = b.py - 6; }
      ctx.save();
      ctx.font = GLYPH_FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.shadowBlur = 4; ctx.shadowColor = '#ffae3a';
      ctx.fillStyle = '#ffc978';
      ctx.fillText(label, ax, ay);
      ctx.restore();
    }
  }

  /* ---------- the AWAIT tag (G4 feature 1): a tiny amber "AWAITING APPROVAL" plate above the blocked hero.
     World-space, VT323 with an amber phosphor bloom (the consent-warning colour), a slow blink so it reads as
     a live pending state — a glance, never a window. Only while the hero is genuinely blocked (awaitPrompt). */
  const AWAIT_FONT = "8px 'VT323','Courier New',monospace";
  function drawAwaitTag(now) {
    if (!awaitPrompt || !agent || agent.unplaced) return;
    const x = rposX(), y = rposY();
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(now / 380));   // slow breathing so it never looks frozen
    const label = 'AWAITING APPROVAL';
    ctx.save();
    ctx.font = AWAIT_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const tw = ctx.measureText(label).width, ty = y - 22, pad = 3;
    // a small dark plate behind the text so it stays legible over any floor
    ctx.globalAlpha = 0.72; ctx.fillStyle = '#160d02';
    ctx.fillRect(x - tw / 2 - pad, ty - 9, tw + pad * 2, 12);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 5; ctx.shadowColor = '#ffae3a';
    ctx.fillStyle = `rgba(255,201,120,${pulse.toFixed(3)})`;
    ctx.fillText(label, x, ty);
    // a tiny blinking caret so the "still waiting" read is unmistakable
    if (Math.sin(now / 300) > 0) { ctx.fillStyle = '#ffd9a3'; ctx.fillRect(x + tw / 2 + pad + 1, ty - 7, 1, 8); }
    ctx.restore();
  }

  /* ---------- the PIN FLOURISH (G4 feature 2): a brief amber pin-burst at the MISSION BOARD the instant the
     agent pins a proposal there. World-space, over the board; a short expanding ring of amber motes + a "PINNED"
     phosphor tick. Self-expires (~900ms). A juicy confirmation that the proposal now has a body. */
  function drawPinFlourish(now) {
    const DUR = 900;
    if (now - pinFlourishAt > DUR || !geo || !geo.props) return;
    const board = geo.props.find(p => p && p.t === 'missionboard');
    if (!board) return;
    const cx = (board.x + (board.w || 1) / 2) * T, cy = (board.y) * T + 4;
    const t = (now - pinFlourishAt) / DUR, e = 1 - Math.pow(1 - t, 2), a = (1 - t);
    ctx.save();
    ctx.globalAlpha = 0.9 * a;
    // expanding amber ring
    ctx.strokeStyle = '#ffc24a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, 3 + e * 12, 0, Math.PI * 2); ctx.stroke();
    // a few motes flung outward
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2, r = 2 + e * 14;
      ctx.fillStyle = i % 2 ? '#ffdc8a' : '#ff9a3a';
      ctx.fillRect(Math.round(cx + Math.cos(ang) * r), Math.round(cy + Math.sin(ang) * r), 1, 1);
    }
    // the phosphor confirmation tick
    ctx.globalAlpha = a; ctx.shadowBlur = 4; ctx.shadowColor = '#ffae3a';
    ctx.fillStyle = '#ffd9a3'; ctx.font = "7px 'VT323','Courier New',monospace";
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('PINNED', cx, cy - 6 - e * 4);
    ctx.restore();
  }

  /* ---------- MEESEEKS helper sprites (G4 feature 3): a lightweight, dedicated layer (NOT agents.js bodies).
     Each LIVE sub-agent is one small, translucent, faintly-flickering helper that materializes near the lead's
     desk, works in place (a tight shimmer + micro-wander), and dissolves in a brief amber-cyan poof when its
     sub-agent completes. Cap 5 + a '+N' badge. The ledger is the ONLY source — a sprite exists iff a real
     sub-agent is live (the truthfulness law). Colours are cool/pale so they read as spectral helpers, not crew. */
  function helperSlot(id) {
    let s = helperSlots.get(id);
    if (!s) {
      // a stable fan of offsets around the lead's foot (local px), hash-seeded so a given helper keeps its spot
      const h = U.hash('ms' + id);
      const ang = (h % 360) * Math.PI / 180, rad = 10 + (h % 7);
      s = { ox: Math.cos(ang) * rad, oy: -6 - (h % 5), ph: (h % 100) / 100 * Math.PI * 2 };
      helperSlots.set(id, s);
    }
    return s;
  }
  function drawMeeseeks(now) {
    if (!subLedger) return;
    subLedger.prune(now);
    const view = subLedger.list(now);
    if (!view.shown.length) { for (const k of helperSlots.keys()) helperSlots.delete(k); return; }
    for (const s of view.shown) {
      const lead = bodyForAgent(s.leadId) || agent;
      if (!lead || lead.unplaced) continue;
      const lx = lead.seated ? lead.seatPx : lead.px, ly = lead.seated ? lead.seatPy : lead.py;
      const slot = helperSlot(s.id);
      // micro-wander: a small lissajous drift so the helper works "in place" without standing dead-still
      const wob = s.phase === 'materialize' ? 1 : 0.4;
      const hx = Math.round(lx + slot.ox + Math.sin(now / 520 + slot.ph) * 2.2 * wob);
      const hy = Math.round(ly + slot.oy + Math.cos(now / 610 + slot.ph) * 1.6 * wob);
      // flicker: a fast, shallow alpha jitter on top of the materialize/dissolve alpha (eerie, unstable presence)
      const flick = 0.82 + 0.18 * Math.sin(now / 90 + slot.ph * 3);
      const a = Math.max(0, Math.min(1, s.alpha)) * flick;
      const scale = s.phase === 'materialize' ? (0.55 + 0.45 * Math.min(1, s.alpha)) : (0.4 + 0.6 * s.alpha);   // scale-in on birth, shrink on poof
      ctx.save();
      ctx.globalAlpha = 0.85 * a;
      // a small spectral body: pale-cyan torso + head, a faint amber core, a soft contact shadow
      const bodyH = Math.round(9 * scale), bodyW = Math.max(2, Math.round(3 * scale));
      ctx.globalAlpha = 0.28 * a; ctx.fillStyle = '#0b1416'; ctx.fillRect(hx - bodyW, hy, bodyW * 2, 1);   // shadow
      ctx.globalAlpha = 0.8 * a;
      ctx.fillStyle = '#8fe6df'; ctx.fillRect(hx - (bodyW >> 1), hy - bodyH, bodyW, bodyH);                 // torso
      ctx.fillStyle = '#c7f4ef'; ctx.fillRect(hx - (bodyW >> 1), hy - bodyH - Math.max(2, Math.round(3 * scale)), bodyW, Math.max(2, Math.round(3 * scale)));   // head
      ctx.globalAlpha = 0.5 * a; ctx.fillStyle = '#ffd9a3'; ctx.fillRect(hx - 1, hy - Math.round(bodyH * 0.6), 1, 1);   // amber work-core spark
      // the poof: a couple of rising motes while dissolving
      if (s.phase === 'dissolve') {
        ctx.globalAlpha = 0.7 * s.alpha; ctx.fillStyle = '#a7f0ea';
        for (let i = 0; i < 3; i++) { const t = (1 - s.alpha); ctx.fillRect(hx - 2 + i * 2, hy - bodyH - Math.round(t * 8) - i, 1, 1); }
      }
      ctx.restore();
    }
    // the '+N' badge: more live helpers than the cap — a tiny cyan counter near the lead
    if (view.overflow > 0) {
      const lead = agent;
      if (lead && !lead.unplaced) {
        ctx.save();
        ctx.globalAlpha = 0.9; ctx.font = "7px 'VT323','Courier New',monospace"; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.shadowBlur = 3; ctx.shadowColor = '#8fe6df'; ctx.fillStyle = '#c7f4ef';
        ctx.fillText('+' + view.overflow, (lead.seated ? lead.seatPx : lead.px) + 14, (lead.seated ? lead.seatPy : lead.py) - 14);
        ctx.restore();
      }
    }
  }

  /* ---------- the SPEECH BUBBLE: what a body is saying right now (a routed "received: …" beat, a muttered
     aside, an error line, a LEVEL tick). Rendered in the SAME material as the nameplate — screen-space + no
     smoothing so the VT323 stays crisp instead of being scaled-then-barrel-warped into mush, dark CRT glass
     with scanlines, an amber structural frame with a suit accent, a warm phosphor bloom, and a small tail
     pointing down at the head. A glance, never a window (hover law). */
  const BUBBLE_MAXW = 152;   // CSS px — a spoken line wraps within this before ellipsizing
  function drawBubble(now, who) {
    who = who || agent;
    if (!cache || !who) return;
    const s = who.say;
    // keep the HERO's caption up while it's still SPEAKING (a streamed neural reply can outlast the bubble's
    // fixed timer) — so the on-screen line and the voice stay in phase. Crew bodies just follow the timer.
    const speakingNow = (who === agent) && typeof Voice !== 'undefined' && Voice.isSpeaking && Voice.isSpeaking();
    if (!s.text || (s.until < now && !speakingNow)) return;

    // draw in SCREEN space (mirrors drawNameplate): pixel-snapped, unsmoothed VT323 that reads cleanly at any
    // zoom, then it rides the same barrel-curve/scanline pass the rest of the feed does. All geometry is CSS px.
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false;
    const Wc = cv.width / dpr, Hc = cv.height / dpr;
    const suit = who.color || '#ffaa33';

    // wrap to <=3 lines within BUBBLE_MAXW; ellipsize a truncated tail so an overrun reads as "…", not a hard cut
    const fontSz = 15, lh = 16, padX = 6, padY = 5, tailW = 5, tailH = 6;
    ctx.font = fontSz + 'px ' + PLATE_FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const words = String(s.text).split(' '), lines = []; let line = '', truncated = false;
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > BUBBLE_MAXW && line) {
        lines.push(line); line = w;
        if (lines.length >= 3) { truncated = true; break; }
      } else line = test;
    }
    if (line && lines.length < 3) lines.push(line);
    else if (line) truncated = true;
    if (truncated && lines.length) {
      let last = lines[lines.length - 1];
      while (last && ctx.measureText(last + '…').width > BUBBLE_MAXW) last = last.slice(0, -1);
      lines[lines.length - 1] = last.replace(/\s+$/, '') + '…';
    }
    const textW = lines.length ? Math.max.apply(null, lines.map(l => ctx.measureText(l).width)) : 1;
    const bw = Math.round(Math.max(26, Math.min(BUBBLE_MAXW, textW) + padX * 2));
    const bh = lines.length * lh + padY * 2;

    // anchor centered above the head, crisp + clamped to the canvas (same body->screen math as the nameplate)
    const ax = (bodyPosX(who) * scale + panX) / dpr, ay = (bodyPosY(who) * scale + panY) / dpr;
    // anchor off the sprite's ACTUAL drawn head-top when known (set each frame in drawAgent);
    // the old fixed 15-world-px estimate undershot real skins and parked the bubble on the face
    const topY = (who.visTopPy != null) ? (who.visTopPy * scale + panY) / dpr : ay - 15 * scale / dpr;
    const cx = Math.round(Math.max(bw / 2 + 4, Math.min(Wc - bw / 2 - 4, ax)));
    const bx = Math.round(cx - bw / 2);
    const by = Math.round(Math.max(4, Math.min(Hc - bh - tailH - 4, topY - 6 - tailH - bh)));
    const tx = Math.round(Math.max(bx + tailW + 1, Math.min(bx + bw - tailW - 1, ax)));   // tail apex tracks the head, kept inside the box

    // CRT glass card + faint scanlines (nameplate material)
    ctx.fillStyle = 'rgba(6,5,4,0.94)'; ctx.fillRect(bx, by, bw, bh);
    // the pointing tail (glass, so box + tail read as one poured surface)
    ctx.beginPath(); ctx.moveTo(tx - tailW, by + bh); ctx.lineTo(tx + tailW, by + bh); ctx.lineTo(tx, by + bh + tailH); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 0.13; ctx.fillStyle = '#000';
    for (let sy = by + 2; sy < by + bh - 1; sy += 3) ctx.fillRect(bx + 1, sy, bw - 2, 1);
    ctx.globalAlpha = 1;

    // amber structural frame: the box outline + the two slanted tail edges, then re-glass the seam so the tail
    // opens into the box instead of being fenced off by the box's bottom stroke
    ctx.strokeStyle = '#b9791c'; ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    ctx.beginPath(); ctx.moveTo(tx - tailW, by + bh - 0.5); ctx.lineTo(tx, by + bh + tailH); ctx.lineTo(tx + tailW, by + bh - 0.5); ctx.stroke();
    ctx.fillStyle = 'rgba(6,5,4,0.94)'; ctx.fillRect(tx - tailW + 1, by + bh - 1, tailW * 2 - 1, 2);
    // suit accent along the top edge (the body's own colour, like the nameplate's crown)
    ctx.globalAlpha = 0.6; ctx.fillStyle = suit; ctx.fillRect(bx + 1, by, bw - 2, 1); ctx.globalAlpha = 1;

    // the line(s): VT323 in warm phosphor, with any leading "label:" (received:, working…) dimmed to a tag
    ctx.font = fontSz + 'px ' + PLATE_FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.shadowBlur = 4; ctx.shadowColor = suit;
    ctx.fillStyle = '#ffe0b0';
    lines.forEach((l, i) => ctx.fillText(l, bx + padX, by + padY + lh * (i + 1) - 4));
    const label = lines.length ? (lines[0].match(/^\S+:/) || [])[0] : null;
    if (label) { ctx.shadowBlur = 3; ctx.fillStyle = 'rgba(255,171,64,0.72)'; ctx.fillText(label, bx + padX, by + padY + lh - 4); }
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  }

  function setOnClick(fn) { onClick = fn; }
  function setOnArcade(fn) { onArcade = fn; }
  function setOnOutbox(fn) { onOutbox = fn; }
  function setOnBayAssign(fn) { onBayAssign = fn; }   // click an UNBOUND bay → open the assign flow (app wires to REFIT's picker)
  function setOnIntakeFeed(fn) { onIntakeFeed = fn; } // click a NO-FEED intake → open the CHANNELS panel (app wires it)

  /* ---------- BELT LEGIBILITY: the floor teaches its own routing ----------
     The single failure this layer kills: a user lays belts, sees crates or dead machinery, and cannot tell
     WHY the line isn't doing anything. Three glances answer it, all derived from the SAME compiled plan the
     sidecar dispatches by (never a parallel guess):
       1. dead-vs-live tiles (drawBelts liveSet — wired in compileRouting above);
       2. in-world nags on the broken piece (this section — the compiler's own errors, made physical);
       3. a hover route tag on any belt tile ("▸ CODER" / "DEAD END").
     All world-space VT323 phosphor, drawRunClocks idiom. A glance, never a window (hover law). */
  const NAG_FONT = "8px 'VT323','Courier New',monospace";
  // compiler error code -> the in-world callout. Wording says what to DO, not what went wrong internally.
  // Every label NAMES THE FIX, never just the fault ("NO LINE FROM INTAKE", not the old "NO ROUTE IN").
  // A finding only exists when it's true: a lone assigned bay is a COMPLETE build and gets no callout;
  // a bay->OUTBOX ship-out lane is valid and GLOWS instead of nagging (the 2026-07-05 playtest bug class).
  const NAG_LABEL = {
    UNBOUND_BAY: 'NO AGENT — CLICK', ORPHAN_BAY: 'NOT ON THE LINE', ORPHAN_SOURCE: 'NO BELT OUT',
    BAY_NOT_FED: 'NOT CONNECTED — FIX IN REFIT', CYCLE: 'LOOP!', FILTER_NO_DEFAULT: 'NO DEFAULT LANE', DUP_AGENT: 'DUP AGENT',
    SPLIT_ONE_LANE: 'SPLITTER — ONE LANE'
  };
  // project the compiled plan's error list onto floor rectangles once per recompile (zero per-frame walk)
  function buildRoutingNags() {
    const out = [];
    feedNagOn = false;
    if (!routingPlan || !routingPlan.errors || !geo || !geo.props) return out;
    const byId = {};
    for (const p of geo.props) byId[p.id] = p;
    for (const e of routingPlan.errors) {
      const label = NAG_LABEL[e.code];
      if (!label) continue;
      if (e.tile) out.push({ x: e.tile.x, y: e.tile.y, w: 1, h: 1, label, warn: !!e.warn });
      else { const p = e.propId != null && byId[e.propId]; if (p) out.push({ x: p.x, y: p.y, w: p.w || 1, h: p.h || 1, label, warn: !!e.warn }); }
    }
    // beyond the compiler — two silent failure modes the floor must also confess:
    // (a) a BOUND bay whose room grants no computer: routed work arrives and the run can't act (the compute
    //     gate stays shut). Same bayObjects check as REFIT's NO COMPUTE ghost, now visible in the live world.
    //     Walks dockBays (EVERY bound bay, belt-hooked or standalone) — a lone dock deserves the same truth.
    if (routingPlan.dockBays && station && typeof station.bayObjects === 'function') {
      for (const b of routingPlan.dockBays) {
        let objs = [];
        try { objs = station.bayObjects(b.agentId) || []; } catch (_) {}
        if (objs.indexOf('computer') >= 0) continue;
        out.push({ x: b.x, y: b.y, w: b.w || 1, h: b.h || 1, label: 'NO COMPUTE — ADD A PC', warn: true });
      }
    }
    // (b) a COMPLETE line with nothing wired to feed it: no channel configured and no armed routine means no
    //     crate will EVER enter the intake. Claimed only once the server actually answered (feedState.known) —
    //     never a nag on ignorance. The click-through opens the CHANNELS panel (onIntakeFeed).
    if (feedState.known && !feedState.fed && beltLiveSet && Object.keys(beltLiveSet).length) {
      for (const p of geo.props) {
        if (p.t !== 'intake') continue;
        out.push({ x: p.x, y: p.y, w: p.w || 1, h: p.h || 1, label: 'NO FEED — CLICK', warn: true });
        feedNagOn = true;
      }
    }
    return out;
  }
  /* FEED TRUTH: is anything actually wired to drop work onto this floor? ANY registry channel configured
     (the bulk /api/channels/status covers telegram/discord/slack/matrix/signal — polling only the first two
     falsely nagged a slack/matrix/signal-only floor), or the cron scheduler armed with at least one enabled
     routine. Server-proven only — `fed` stays true until a real response says otherwise, so a fetch hiccup
     can never fire the nag. */
  function pollFeedState() {
    if (typeof fetch === 'undefined') return;
    const get = u => { try { return fetch(apiUrl(u)).then(r => (r.ok ? r.json() : null)).catch(() => null); } catch (_) { return Promise.resolve(null); } };
    Promise.all([get('/api/channels/status'), get('/api/cron')]).then(([chans, cron]) => {
      if (!chans && !cron) return;   // nothing answered — keep the last known truth
      const chan = !!(chans && typeof chans === 'object' && Object.keys(chans).some(id => chans[id] && chans[id].configured));
      const jobs = (cron && Array.isArray(cron.jobs)) ? cron.jobs : [];
      const cronFeeds = !!(cron && cron.enabled && jobs.some(j => j && j.enabled !== false));
      const next = { known: true, fed: chan || cronFeeds };
      const changed = next.known !== feedState.known || next.fed !== feedState.fed;
      feedState = next;
      if (changed) routingNags = buildRoutingNags();   // feed truth changed → refresh the callouts
    });
  }
  // hit-test: an INTAKE currently showing the NO FEED nag (its click-through opens the CHANNELS panel)
  function intakeFeedAt(wp) {
    if (!feedNagOn || !geo || !geo.props) return null;
    for (const p of geo.props) {
      if (p.t !== 'intake') continue;
      const x0 = p.x * T, y0 = p.y * T - 10, x1 = (p.x + (p.w || 1)) * T, y1 = (p.y + (p.h || 1)) * T + 2;
      if (wp.x >= x0 && wp.x < x1 && wp.y >= y0 && wp.y < y1) return p;
    }
    return null;
  }
  // hit-test: an UNBOUND bay under a world-space point (its nag says CLICK, so the footprint must be clickable)
  function unboundBayAt(wp) {
    if (!geo || !geo.props) return null;
    for (const p of geo.props) {
      if (p.t !== 'bay' || p.agentId) continue;
      const x0 = p.x * T, y0 = p.y * T - 10;   // the nag text floats above the crown — keep it clickable too
      const x1 = (p.x + (p.w || 1)) * T, y1 = (p.y + (p.h || 1)) * T + 2;
      if (wp.x >= x0 && wp.x < x1 && wp.y >= y0 && wp.y < y1) return p;
    }
    return null;
  }
  // the hover answer for one belt tile, cached until the next recompile. ok=true → the flow reaches a bound bay.
  function routeTagFor(tx, ty) {
    if (!routingPlan || typeof Pipeline === 'undefined' || !Pipeline.routeFrom) return null;
    const k = tx + ',' + ty;
    if (routeTagCache && routeTagCache[k] !== undefined) return routeTagCache[k];
    const r = Pipeline.routeFrom(routingPlan, tx, ty);
    let tag;
    if (r.agents.length) {
      const names = r.agents.map(a => { const b = bodyForAgent(a); return ((b && b.name) ? String(b.name) : String(a).slice(0, 8)).toUpperCase(); });
      tag = { text: '▸ ' + names.join(' · ') + (r.deadEnd ? ' +DEAD END' : ''), ok: !r.deadEnd };
    }
    else if (r.outbox) tag = { text: '▸ OUTBOX — SHIPS OUT', ok: !r.deadEnd };   // a pure outbound lane is a WORKING lane
    else if (r.unbound) tag = { text: '▸ BAY — NO AGENT', ok: false };
    else tag = { text: '▸ DEAD END', ok: false };
    (routeTagCache = routeTagCache || {})[k] = tag;
    return tag;
  }
  // amber (warn) / red (blocker) corner brackets + a one-line instruction over the broken piece, gently pulsing
  // label collision (2026-07-11): neighboring nags on one row — or two nags on the SAME prop (e.g.
  // BAY_NOT_FED + NO COMPUTE) — used to print on a shared baseline and mash into garble. Each label
  // claims a box; a collider steps UP one line at a time until it fits. Rebuilt per draw call.
  function placeNagLabel(placed, cx, y, w, h) {
    const hits = b => cx - w / 2 < b.x + b.w && cx + w / 2 > b.x && y < b.y + b.h && y + h > b.y;
    let guard = 24;
    while (guard-- > 0 && placed.some(hits)) y -= h + 1;
    placed.push({ x: cx - w / 2, y, w, h });
    return y;
  }
  function drawRoutingNags(now) {
    if (!routingNags || !routingNags.length) return;
    const pulse = 0.55 + 0.35 * Math.sin(now / 280);
    const placed = [];
    for (const n of routingNags) {
      const X = n.x * T, Y = n.y * T, Wd = n.w * T, Hd = n.h * T;
      const col = n.warn ? '#ffbe3c' : '#ff5046';
      const L = Math.max(3, Math.floor(T / 3));
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath();   // corner brackets, not a full box — a machinery callout, not a selection
      ctx.moveTo(X + .5, Y + .5 + L); ctx.lineTo(X + .5, Y + .5); ctx.lineTo(X + .5 + L, Y + .5);
      ctx.moveTo(X + Wd - .5 - L, Y + .5); ctx.lineTo(X + Wd - .5, Y + .5); ctx.lineTo(X + Wd - .5, Y + .5 + L);
      ctx.moveTo(X + .5, Y + Hd - .5 - L); ctx.lineTo(X + .5, Y + Hd - .5); ctx.lineTo(X + .5 + L, Y + Hd - .5);
      ctx.moveTo(X + Wd - .5, Y + Hd - .5 - L); ctx.lineTo(X + Wd - .5, Y + Hd - .5); ctx.lineTo(X + Wd - .5 - L, Y + Hd - .5);
      ctx.stroke();
      ctx.font = NAG_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.shadowBlur = 3; ctx.shadowColor = col; ctx.fillStyle = col;
      // alphabetic baseline at y: label box spans roughly [y-8, y] (8px VT323)
      const ly = placeNagLabel(placed, X + Wd / 2, Y - 3 - 8, ctx.measureText(n.label).width, 9);
      ctx.fillText(n.label, X + Wd / 2, ly + 8);
      ctx.restore();
    }
  }
  // the hover-glance tag over a clickable OUTBOX: crates pending → "N TO REVIEW — CLICK"; pallet only →
  // the LOGBOOK click-through. Names what the stacked boxes ARE and what the click does (the 2026-07-16
  // confusion: "boxes showing output but I can't see it"). A glance, never a window (hover law).
  function drawOutboxHoverTag(now) {
    if (!hoverOutbox) return;
    const n = returnCrates();
    const text = n > 0 ? (n + ' TO REVIEW — CLICK') : 'FINISHED WORK — CLICK';
    ctx.save();
    ctx.font = NAG_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.shadowBlur = 3; ctx.shadowColor = n > 0 ? '#ffd88a' : '#62ff9e';
    ctx.fillStyle = n > 0 ? '#ffe9bd' : '#9adcb0';
    ctx.fillText(text, (hoverOutbox.x + (hoverOutbox.w || 1) / 2) * T, hoverOutbox.y * T - 40);
    ctx.restore();
  }
  // the hover-glance route tag over the belt tile under the cursor (green = flows to a bound bay, amber = doesn't)
  function drawBeltHoverTag(now) {
    if (!hoverBeltTile) return;
    const tag = routeTagFor(hoverBeltTile.x, hoverBeltTile.y);
    if (!tag) return;
    ctx.save();
    ctx.font = NAG_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.shadowBlur = 3; ctx.shadowColor = tag.ok ? '#62ff9e' : '#ffbe3c';
    ctx.fillStyle = tag.ok ? '#9adcb0' : '#ffd9a3';
    ctx.fillText(tag.text, (hoverBeltTile.x + 0.5) * T, hoverBeltTile.y * T - 4);
    ctx.restore();
  }
  function setOnMissionBoard(fn) { onMissionBoard = fn; }   // G1b: click a placed MISSION BOARD → open the quest log
  function setOnTrophyCase(fn) { onTrophyCase = fn; }   // G3b: click a placed TROPHY CASE → open the trophy surface
  // G2.3 — the live uncollected-crate count (ReturnStore's pending ledger). Read per-frame for the
  // OUTBOX sprite stack and by the hit-test below; 0 when the store isn't loaded (headless tests).
  function returnCrates() {
    try { return (typeof ReturnStore !== 'undefined' && ReturnStore.pendingCount) ? (ReturnStore.pendingCount() | 0) : 0; } catch (_) { return 0; }
  }
  // hit-test: the OUTBOX chute under a world-space point — ALWAYS clickable while placed (2026-07-16:
  // the click opens the OUTBOX window, which has honest content in every state — pending crates,
  // or the "finished work lands here" empty state — so the affordance is never dead, mirroring the
  // MISSION BOARD). The stacks spill above AND below the footprint, so the box extends both ways.
  function outboxAt(wp) {
    if (!geo || !geo.props) return null;
    for (const p of geo.props) {
      if (p.t !== 'outbox') continue;
      const x0 = p.x * T, y0 = p.y * T - 34;
      const x1 = (p.x + (p.w || 1)) * T, y1 = (p.y + (p.h || 1)) * T + 12;
      if (wp.x >= x0 && wp.x < x1 && wp.y >= y0 && wp.y < y1) return p;
    }
    return null;
  }
  /* ---------- G1b MISSION BOARD: the quest log's body ----------
     missionPinCounts — the board's truthful readout, recomputed at most once a second (the projection walk
     is too heavy for every frame): [how many quests are OPEN in the visible log, whether a station-gap
     fix-it is among them]. Zeroes when the quest stores aren't loaded (headless tests / title screen). */
  let mpAt = -1e9, mpOpen = 0, mpHot = false, mpJam = false, mpProp = 0;
  function missionPinCounts(t) {
    if (t - mpAt > 1000) {
      mpAt = t;
      try {
        const v = (typeof QuestStore !== 'undefined' && QuestStore.view) ? QuestStore.view() : null;
        const all = (v && Array.isArray(v.quests)) ? v.quests : [];
        const vis = (typeof QuestStateStore !== 'undefined' && QuestStateStore.visible) ? QuestStateStore.visible(all) : all;
        mpOpen = vis.filter(q => q && q.status !== 'done').length;
        mpHot = (typeof StationQuestStore !== 'undefined' && StationQuestStore.openCount) ? StationQuestStore.openCount() > 0 : false;
        // G1c: a repeatedly-skipped routine reads as a JAM — an amber stub pins on the board (pure Factorio).
        mpJam = (typeof MaintQuestStore !== 'undefined' && MaintQuestStore.jammedJobs) ? (MaintQuestStore.jammedJobs().length > 0) : false;
        // G4 feature 2: pending autojob PROPOSAL cards the agent pinned to the board.
        mpProp = (typeof AutoJobStore !== 'undefined' && AutoJobStore.pendingCount) ? AutoJobStore.pendingCount() : 0;
      } catch (_) { mpOpen = 0; mpHot = false; mpJam = false; mpProp = 0; }
    }
    return [mpOpen, mpHot, mpJam, mpProp];
  }
  // hit-test: a placed MISSION BOARD under a world-space point. Always clickable while placed — the click
  // opens the QUEST LOG, which always has content, so the affordance is never dead (unlike the OUTBOX,
  // whose click needs crates). The wall lugs + casing spill above the footprint; extend the box up.
  function missionBoardAt(wp) {
    if (!geo || !geo.props) return null;
    for (const p of geo.props) {
      if (p.t !== 'missionboard') continue;
      const x0 = p.x * T, y0 = p.y * T - 6;
      const x1 = (p.x + (p.w || 1)) * T, y1 = (p.y + (p.h || 1)) * T + 4;
      if (wp.x >= x0 && wp.x < x1 && wp.y >= y0 && wp.y < y1) return p;
    }
    return null;
  }
  /* ---------- G3b TROPHY CASE: the station's achievements made permanent ----------
     trophyCount — the case's truthful readout, recomputed at most once a second (the trophy walk is heavy):
     how many REAL trophies are earned (completed quests + earned milestones, via the Trophies projection over
     the live quest view + durable QuestState memory). Zero when the surface isn't loaded (headless / title). */
  let tcAt = -1e9, tcWon = 0;
  function trophyCount(t) {
    if (t - tcAt > 1000) {
      tcAt = t;
      try {
        const v = (typeof QuestStore !== 'undefined' && QuestStore.view) ? QuestStore.view() : null;
        const quests = (v && Array.isArray(v.quests)) ? v.quests : [];
        const stateOf = (typeof QuestStateStore !== 'undefined' && QuestStateStore.stateOf) ? (id => QuestStateStore.stateOf(id)) : (() => null);
        const surf = (typeof Trophies !== 'undefined' && Trophies.build) ? Trophies.build({ quests, stateOf }) : null;
        tcWon = surf ? surf.earned : quests.filter(q => q && q.status === 'done').length;
      } catch (_) { tcWon = 0; }
    }
    return tcWon;
  }
  // hit-test: a placed TROPHY CASE under a world-space point. Always clickable while placed — the click opens
  // the TROPHY CASE surface (honest even when empty: it shows dust, never a dead affordance). The glass casing
  // sits within its 2×2 footprint; a small down-spill for the base shadow keeps the bottom row clickable.
  function trophyCaseAt(wp) {
    if (!geo || !geo.props) return null;
    for (const p of geo.props) {
      if (p.t !== 'trophycase') continue;
      const x0 = p.x * T, y0 = p.y * T - 2;
      const x1 = (p.x + (p.w || 1)) * T, y1 = (p.y + (p.h || 1)) * T + 4;
      if (wp.x >= x0 && wp.x < x1 && wp.y >= y0 && wp.y < y1) return p;
    }
    return null;
  }
  // hit-test: the arcade cabinet prop under a world-space point (null if none). The cabinet
  // art spills a few px below its tile footprint, so extend the box down to keep it clickable.
  function arcadeAt(wp) {
    if (!geo || !geo.props) return null;
    for (const p of geo.props) {
      const s = specOf(p.t);
      if (!s || !s.use || s.use.kind !== 'arcade') continue;
      const x0 = p.x * T, y0 = p.y * T - 2;
      const x1 = (p.x + (p.w || s.w || 1)) * T, y1 = (p.y + (p.h || s.h || 1)) * T + 8;
      if (wp.x >= x0 && wp.x < x1 && wp.y >= y0 && wp.y < y1) return p;
    }
    return null;
  }

  /* ---------- work-item pipeline: the conveyor carries REAL inbound work to the agent ----------
     A real admitted message (Telegram) arrives over the SSE bridge as `workitem.placed`; we drop a
     box at the INTAKE prop so it rides the player-laid belts to the desk. Pure visualization — if no
     INTAKE/belt path exists, nothing rides (the sidecar already ran the work either way). */
  const chanQueues = new Map();   // queueId -> depth (from queue.status) — drives the backpressure HUD
  const serverLit = new Set();    // agentIds lit by an AUTONOMOUS run (cron/channel) — its run.end clears them
  /* ---------- per-agent ACTIVITY HEAT (G0.3) ----------
     A truthful "how hard is this run streaming RIGHT NOW" scalar per agent: every real agent.token /
     agent.tool_call bumps it, and it decays exponentially (~2s time-constant) between bumps — so a
     hot-streaming run burns visibly brighter at the desk than a stalled one, with zero invented signal.
     Read lazily (decay computed at read time) so an idle map entry costs nothing per frame. */
  const heatByAgent = new Map();  // agentId -> { v, at } (v = heat at time `at`; decays exp(-(now-at)/TAU))
  const HEAT_TAU = 2000;
  function heatBump(aid, inc) {
    const id = aid || (agent && agent.id) || 'agent';
    const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
    const h = heatByAgent.get(id);
    const v = h ? h.v * Math.exp(-(now - h.at) / HEAT_TAU) : 0;
    heatByAgent.set(id, { v: Math.min(1, v + inc), at: now });
  }
  function heatFor(aid) {
    const h = heatByAgent.get(aid || (agent && agent.id) || 'agent');
    if (!h) return 0;
    const v = h.v * Math.exp(-(fnow - h.at) / HEAT_TAU);
    return v < 0.01 ? 0 : v;
  }
  /* ---------- honest desk activity (G0.2): two truth sources, never conflated ----------
     deskProg — a REAL task-progress fraction, if some producer published one on the 'task' bus event
     (t.prog/t.dur — the crew-task sim's contract). The strip renders ONLY from this map; a live
     harness run publishes no fraction and so gets NO bar — it shows elapsed time + heat instead.
     runStartByAgent — when each agent's live run actually started (agent.run.start/end), driving the
     tiny elapsed-time tag at the desk. Time is knowable; percent is not; we show exactly what is. */
  const deskProg = new Map();        // agentId -> 0..1 (real published fraction only)
  const runStartByAgent = new Map(); // agentId -> performance.now() at agent.run.start
  const deskProgFor = aid => deskProg.has(aid) ? deskProg.get(aid) : null;
  /* ---------- Lane E2 — paired-state TTLs (the second net under reconnect reconciliation) ----------
     A run clock / work pose / await-prompt is asserted off a START event and cleared off its matching END event.
     If the END event is LOST (sidecar crash mid-run, a dropped SSE frame), the frontend would assert "RUN 47:12"
     forever — the app lying about state. As an independent net, every reinforcing event (run.start/token/tool_call)
     stamps a last-seen time; a once-per-second sweep degrades any paired state with no reinforcement for its TTL to
     cleared/unknown rather than asserted-forever. Kept cheap: one Map of timestamps, swept once per second (never
     per-frame). Reconnect reconciliation (snapshot fetch, below) is the PRIMARY correction; this TTL is the
     belt-and-suspenders that also covers the no-snapshot-endpoint case. */
  const runLastSeenByAgent = new Map();          // agentId -> performance.now() of the last reinforcing run event
  const RUN_TTL_MS = 300000;                     // 5m of NO token/tool/start event ⇒ the run clock degrades to unknown
  const AWAIT_TTL_MS = 660000;                   // consent max (600s) + grace ⇒ a stuck await clears if its response was lost
  let awaitStampAt = 0;                           // performance.now() when the current awaitPrompt was last reinforced
  function stampRun(aid, rid) {
    if (!aid) return;
    const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
    runLastSeenByAgent.set(aid, now);
    // per-RUN reinforcement: a leaked runId (lost run.end) must go stale on ITS OWN clock — the agent-level
    // stamp above stays fresh as long as ANY run of this agent emits, which used to keep a leaked refcount
    // alive forever on a busy agent (the crew panel then asserted WORKING between every run).
    if (rid) { const s = liveRunsByAgent.get(aid); if (s && s.has(rid)) s.set(rid, now); }
  }
  /* OVERLAP-SAFE RUN REFCOUNT (the black-screen-while-working fix). The work pose, serverLit set and the
     run clock are all AGENT-keyed, but an agent's runs can OVERLAP (a scheduled routine ending while a chat
     run streams, two channel runs, a background workstream). Extinguishing on the FIRST run.end used to
     tear the desk pose + darken the workstation screens of an agent that was still genuinely working — the
     app asserting idle while the harness could prove a live run (truthful-telemetry violation, inverted).
     So every live run registers by runId here, and only the LAST live run's end may extinguish agent-keyed
     state. noteRunEnd is IDEMPOTENT per runId (Set.delete), so every run.end consumer can call it and read
     the remaining count without depending on listener registration order. */
  const liveRunsByAgent = new Map();   // agentId -> Map(runId -> lastSeen ms), every live run regardless of trigger
  function noteRunStart(aid, rid) { if (!aid || !rid) return; let s = liveRunsByAgent.get(aid); if (!s) { s = new Map(); liveRunsByAgent.set(aid, s); } s.set(rid, (typeof performance !== 'undefined') ? performance.now() : fnow); }
  function noteRunEnd(aid, rid) {
    const s = aid ? liveRunsByAgent.get(aid) : null; if (!s) return 0;
    if (rid) s.delete(rid); else s.clear();   // a runId-less end can't be matched — treat it as agent-terminal (old behavior)
    if (!s.size) liveRunsByAgent.delete(aid);
    return s.size;
  }
  function agentRunsLive(aid) { const s = aid ? liveRunsByAgent.get(aid) : null; return s ? s.size : 0; }
  /* the once-per-second TTL sweep (E2). Degrades paired states whose reinforcing event was lost:
       • a run clock with no token/tool/start event for RUN_TTL_MS ⇒ clear runStartByAgent (+ its work pose,
         glyph, serverLit, and any leftover crew workUntil for that agent) so no eternal RUN clock is asserted.
       • an awaitPrompt with no reinforcement for AWAIT_TTL_MS (consent-max + grace) ⇒ clearAwait(), since a
         lost permission.response would otherwise strand the hero at the wait anchor forever.
     Cheap: iterates only the (usually tiny) live maps, once per second. */
  function sweepStaleStates(now) {
    if (runStartByAgent.size) {
      for (const aid of Array.from(runStartByAgent.keys())) {
        const seen = runLastSeenByAgent.get(aid) || runStartByAgent.get(aid) || 0;
        if (now - seen > RUN_TTL_MS) {
          runStartByAgent.delete(aid); runLastSeenByAgent.delete(aid);
          liveRunsByAgent.delete(aid);                    // a leaked refcount (lost run.end) degrades with the clock
          glyphByAgent.delete(aid);                       // the in-flight tool glyph is just as stale
          if (serverLit.has(aid)) { serverLit.delete(aid); setActivityFor(aid, 'idle'); }   // drop an autonomous body out of the working pose
          const b = bodyForAgent(aid); if (b && b !== agent && b.workUntil) b.workUntil = 0;  // clear a stuck crew work pose
        }
      }
    }
    // per-RUN sweep: a single leaked runId (its run.end lost) on an otherwise BUSY agent never trips the
    // agent-level clock above — its siblings keep runLastSeenByAgent fresh forever. Each tracked run now
    // carries its own last-reinforced stamp; one that has gone RUN_TTL_MS silent is dropped individually.
    // When that empties an agent's set, release the same agent-keyed state the agent-level branch does.
    for (const [aid, s] of Array.from(liveRunsByAgent)) {
      for (const [rid, seen] of Array.from(s)) if (now - seen > RUN_TTL_MS) s.delete(rid);
      if (!s.size) {
        liveRunsByAgent.delete(aid);
        runStartByAgent.delete(aid); runLastSeenByAgent.delete(aid); glyphByAgent.delete(aid);
        if (serverLit.has(aid)) { serverLit.delete(aid); setActivityFor(aid, 'idle'); }
        const b = bodyForAgent(aid); if (b && b !== agent && b.workUntil) b.workUntil = 0;
      }
    }
    // a serverLit entry whose agent has NO live run and NO run clock is a leftover from an overlap window
    // (the scheduled run ended while a chat run kept the pose; the chat teardown owned the extinguish) — drop it.
    for (const aid of Array.from(serverLit)) if (!agentRunsLive(aid) && !runStartByAgent.has(aid)) serverLit.delete(aid);
    if (awaitPrompt && awaitStampAt && (now - awaitStampAt > AWAIT_TTL_MS)) clearAwait();   // a lost permission.response never strands the hero
  }
  /* Lane E2 — reconnect reconciliation (the PRIMARY correction). On every SSE (re)open, ask the sidecar for the
     authoritative live state and rebuild the paired-state maps to match, CLEARING anything the server no longer
     reports (a run that ended during the outage, a prompt already answered). Backend endpoint GET /api/state/snapshot
     MUST be consumed 404/failure-tolerantly: on any non-OK / malformed response we do nothing and lean on the TTL
     net above. The server's real shape (sidecar handleStateSnapshot) is
       { ts, runs:[{runId, agentId, startedAt, source}], prompts:[{runId, agentId, promptId}], summons:[], queues:[] }
     with startedAt in epoch ms — normalizeSnapshot() maps it onto the internal shape below (all fields optional):
       { activeRuns:[{agentId, startedMsAgo?}], pendingPrompts:[{promptId, agentId}], inflightTools:[{agentId, name, callId}],
         serverLitAgents:[agentId] }  */
  function normalizeSnapshot(snap) {
    if (!snap || typeof snap !== 'object' || snap.activeRuns) return snap;   // already internal-shaped (dbg/test paths)
    if (!Array.isArray(snap.runs) && !Array.isArray(snap.prompts)) return snap;
    const ts = +snap.ts || 0;
    const out = Object.assign({}, snap);
    if (Array.isArray(snap.runs)) out.activeRuns = snap.runs.map(r => r && r.agentId ? {
      agentId: r.agentId,
      runId: r.runId || null,
      startedMsAgo: (ts && +r.startedAt) ? Math.max(0, ts - (+r.startedAt)) : 0
    } : null).filter(Boolean);
    if (Array.isArray(snap.prompts)) out.pendingPrompts = snap.prompts;
    return out;
  }
  function reconcileFromSnapshot(snap) {
    snap = normalizeSnapshot(snap);
    if (!snap || typeof snap !== 'object') return;
    const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
    // ---- active runs: keep/refresh reported ones, DROP any run clock the server no longer knows about ----
    if (Array.isArray(snap.activeRuns)) {
      const live = new Set();
      for (const r of snap.activeRuns) {
        if (!r || !r.agentId) continue;
        live.add(r.agentId);
        const startedAgo = Math.max(0, +r.startedMsAgo || 0);
        if (!runStartByAgent.has(r.agentId)) runStartByAgent.set(r.agentId, now - startedAgo);
        // ORPHAN RUN → WORK POSE: the server proves this run live but no local stream ever saw it start
        // (app reloaded mid-run, or the run belongs to another client). Nothing will ever drive this body —
        // chat.js only poses runs it launched, and the schedule/event listener only fires on the live bus
        // event — so the crew panel would honestly say "working at the terminal" over a standing sprite.
        // Light it through the existing autonomous-work channel (serverLit), whose extinguish paths
        // (run.end refcount, TTL sweep, this reconcile's ended-during-outage branch) already release it.
        const tracked = liveRunsByAgent.get(r.agentId);
        const orphan = !!(r.runId && !(tracked && tracked.has(r.runId)));
        noteRunStart(r.agentId, r.runId);   // rebuild the overlap refcount from the authoritative live set
        stampRun(r.agentId, r.runId);
        if (orphan && !serverLit.has(r.agentId)) { serverLit.add(r.agentId); setActivityFor(r.agentId, 'task'); }
      }
      for (const aid of Array.from(runStartByAgent.keys())) if (!live.has(aid)) {   // ended during the outage
        runStartByAgent.delete(aid); runLastSeenByAgent.delete(aid); glyphByAgent.delete(aid); liveRunsByAgent.delete(aid);
        if (serverLit.has(aid)) { serverLit.delete(aid); setActivityFor(aid, 'idle'); }
        const b = bodyForAgent(aid); if (b && b !== agent && b.workUntil) b.workUntil = 0;
      }
    }
    // ---- inflight tool glyphs: authoritative rebuild ----
    if (Array.isArray(snap.inflightTools)) {
      const liveTool = new Set();
      for (const t of snap.inflightTools) { if (t && t.agentId && t.name) { glyphByAgent.set(t.agentId, { name: t.name, callId: t.callId || null }); liveTool.add(t.agentId); } }
      for (const aid of Array.from(glyphByAgent.keys())) if (!liveTool.has(aid)) glyphByAgent.delete(aid);
    }
    // ---- serverLit (autonomous run pose): reconcile to the reported set ----
    if (Array.isArray(snap.serverLitAgents)) {
      const want = new Set(snap.serverLitAgents.filter(Boolean));
      for (const aid of Array.from(serverLit)) if (!want.has(aid)) { serverLit.delete(aid); setActivityFor(aid, 'idle'); }
      for (const aid of want) if (!serverLit.has(aid)) { serverLit.add(aid); setActivityFor(aid, 'task'); }
    }
    // ---- pending permission prompt: enter it if the server still has one for the hero, else clear a stale await ----
    if ('pendingPrompts' in snap) {
      const prompts = Array.isArray(snap.pendingPrompts) ? snap.pendingPrompts : [];
      const mine = prompts.find(p => p && (!p.agentId || (agent && p.agentId === agent.id)));
      if (mine) enterAwait({ promptId: mine.promptId || '', agentId: mine.agentId || (agent && agent.id) });
      else if (awaitPrompt) clearAwait();   // the prompt was answered during the outage
    }
    // ---- delegation window: the server no longer reports an open dispatch we tracked ----
    if (Array.isArray(snap.activeRuns)) {
      // if no reported run belongs to the tracked delegate lead, the delegation window is stale
      if (delegateLead && !snap.activeRuns.some(r => r && r.agentId === delegateLead)) { delegateLead = null; delegateCall = null; }
    }
  }
  /* ---------- desk DISTRESS flash (G0.4 capdenied / G0.8 run-error) ----------
     A brief red warning strobe over the acting agent's desk when its run genuinely dies — the floor's
     honest "something just went wrong HERE" beat. Additive light over the entities (drawn with the
     glow pass); goes steady (no strobe) under prefers-reduced-motion, like every other pulse. */
  const deskFlash = new Map();       // agentId -> { at, color }
  const FLASH_MS = 950;
  function flashDesk(aid, color) {
    const id = aid || (agent && agent.id) || 'agent';
    deskFlash.set(id, { at: (typeof performance !== 'undefined') ? performance.now() : fnow, color: color || '#ff4a3d' });
  }
  function drawDeskFlashes(now) {
    if (!deskFlash.size) return;
    for (const [aid, f] of deskFlash) {
      const k = 1 - (now - f.at) / FLASH_MS;
      if (k <= 0) { deskFlash.delete(aid); continue; }
      // the desk rect (placed workstation / the hero's synthetic desk), else the body's own spot
      let x, y, w, h;
      const b = bodyForAgent(aid), dp = deskPropFor(aid);
      if (dp) { x = dp.x * T; y = dp.y * T; w = (dp.w || 1) * T; h = (dp.h || 1) * T; }
      else if (b === agent && desk) { x = desk.tx * T; y = desk.ty * T; w = desk.w * T; h = desk.h * T; }
      else if (b) { x = b.px - 8; y = b.py - 14; w = 16; h = 16; }
      else { deskFlash.delete(aid); continue; }
      const strobe = reduceMotion() ? 0.8 : ((Math.floor((now - f.at) / 130) % 2 === 0) ? 1 : 0.45);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.38 * k * strobe;
      ctx.fillStyle = f.color; ctx.fillRect(x - 3, y - 6, w + 6, h + 9);
      ctx.globalAlpha = 0.7 * k * strobe;
      ctx.strokeStyle = f.color; ctx.lineWidth = 1; ctx.strokeRect(x - 3.5, y - 6.5, w + 7, h + 10);
      ctx.restore();
    }
  }
  let bridged = false, lastOutboxFlash = -1e9;
  // N1/N2/N3: the channel SSE stream + the connector poll are "opened once" but used to be NEVER released —
  // after a DISCONNECT they kept polling /api/connectors every 5s and the EventSource self-reconnected forever
  // from the title screen. Hoisted here so pauseBridge() (on disconnect) can release them and resumeBridge()
  // (on re-entry) can re-arm them. The U.bus.on(...) subscriptions stay put (idempotent under `bridged`).
  // E6f — API base consistency: the SSE bridge already prefixes window.__STARNET_API__ (the sidecar's loopback
  // origin) so it resolves in the desktop build, where the page origin is the Tauri asset host, NOT the sidecar.
  // Bare /api/* fetches (routing POST, connectors poll) skipped that prefix and would hit the wrong origin there.
  // apiUrl() is the single source of truth so all three use the same base. (Auth token is attached by harness.js's
  // window.fetch monkey-patch for /api/ URLs; the SSE path can't send a header so it appends ?token= separately.)
  function apiBase() { return (typeof window !== 'undefined' && window.__STARNET_API__) ? window.__STARNET_API__ : ''; }
  function apiUrl(path) { return apiBase() + path; }
  let chanES = null, connPollTimer = null, connPollFn = null, connOpenFn = null, bridgePaused = false;
  let spotifyPollTimer = null, spotifyPollFn = null;   // JUKEBOX dead-vs-live poll (shares the bridge pause/resume lifecycle)
  // LINK-DOWN HONESTY (Lane E1): the live station telemetry (queue gauges, run clocks) is only truthful while
  // the SSE bridge is actually delivering events. Track the last DATA event's wall-clock and the socket's
  // readyState so a dead/stalled link renders an honest degraded state instead of freezing the last-known truth.
  // The server sends a keep-alive COMMENT (`: ka`) every 25s (see index.js handleChannelEvents) — comment lines
  // do NOT surface to EventSource.onmessage, so a healthy-but-quiet stream can legitimately look silent for up to
  // 25s. LINK_STALE_MS sits comfortably above that so a quiet stream is never mislabelled down; the readyState
  // check is the primary, fast signal (a truly dropped socket flips to CONNECTING/CLOSED within the retry window).
  let lastSseEventAt = 0;              // performance.now() of the last DATA frame actually received over chanES
  const LINK_STALE_MS = 40000;         // 40s: keep-alive is 25s; only flag stale well beyond one missed keep-alive
  // link is DOWN when the bridge is meant to be live (not deliberately paused to the title screen) and EITHER the
  // socket is not OPEN, OR it has gone stale (no data for > LINK_STALE_MS AND not currently OPEN). Never "down"
  // when bridgePaused (the user disconnected on purpose) or before the bridge was ever opened (no chanES yet AND
  // never stamped) — an un-opened bridge shows nothing rather than a false alarm.
  function linkDown(now) {
    if (bridgePaused) return false;                                   // deliberately disconnected — not a fault
    if (!bridged) return false;                                       // bridge never set up yet (pre-entry)
    const open = !!(chanES && typeof EventSource !== 'undefined' && chanES.readyState === EventSource.OPEN);
    if (!open) return true;                                           // socket missing / connecting / closed → down
    if (lastSseEventAt && (now - lastSseEventAt) > LINK_STALE_MS) return true;   // half-open: bytes stopped flowing
    return false;
  }
  function pauseBridge() {
    bridgePaused = true;
    if (connPollTimer) { clearInterval(connPollTimer); connPollTimer = null; }
    if (spotifyPollTimer) { clearInterval(spotifyPollTimer); spotifyPollTimer = null; }
    if (chanES) { try { chanES.close(); } catch (_) {} chanES = null; }
  }
  // E1: the ONE public read of the SSE bridge health — the SAME predicate the canvas dims its live
  // telemetry with (linkStaleDim). Chrome instruments outside world.js (topbar #sig / #status-pill,
  // widget rail, model dock) read this so a dead sidecar reads as down everywhere, not just on the
  // canvas. `down` is the honest fault; `paused` = user deliberately disconnected (title screen);
  // `bridged` = the bridge was ever opened (pre-entry, both are false — instruments show a neutral
  // "not yet live" state, never a false alarm).
  function linkState() {
    const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
    return { down: linkDown(now), paused: bridgePaused, bridged: bridged };
  }
  function resumeBridge() {
    if (!bridged) return;                 // never set up yet (no agent has entered) — connectChannelBridge will open it
    bridgePaused = false;
    if (!connPollTimer && connPollFn) { connPollFn(); connPollTimer = setInterval(connPollFn, 5000); }
    if (!spotifyPollTimer && spotifyPollFn) { spotifyPollFn(); spotifyPollTimer = setInterval(spotifyPollFn, 5000); }
    if (!chanES && connOpenFn) connOpenFn();
  }
  let floor = null, lastSlagAt = -1e9;   // FloorStats: the factory-floor economy fold + a fresh-slag pulse clock
  let slaglog = null, lastCacheFrac = null;   // SlagLog: wasted-spend post-mortems + the last reconciled cache ratio (for the diagnosis)

  // a belt tile on/adjacent to a footprint (its tiles + a 1-tile ring), used as a box spawn point (local frame)
  function beltTileNear(tx, ty, tw, th) {
    if (!geo || !geo.belts || !geo.belts.length) return null;
    const beltSet = new Set(geo.belts.map(b => b.x + ',' + b.y));
    for (let yy = ty - 1; yy <= ty + th; yy++)
      for (let xx = tx - 1; xx <= tx + tw; xx++)
        if (beltSet.has(xx + ',' + yy)) return { x: xx, y: yy };
    return null;
  }
  function intakeTile() {
    const intake = geo && geo.props && geo.props.find(p => p.t === 'intake');
    return intake ? beltTileNear(intake.x, intake.y, intake.w || 1, intake.h || 1) : null;
  }
  /* compile the floor into a RoutingPlan and push it to the sidecar. ONE compiler (pipeline.js) feeds BOTH
     the visual junctions below AND the server's autonomous dispatch, so "the box you watch ride to a bay" and
     "the agent that actually runs" can never drift. The plan is derived from the same local-frame geo the
     conveyor animates. If Pipeline isn't loaded, routingPlan stays null and buildJunctions() falls back. */
  function compileRouting() {
    routingPlan = (typeof Pipeline !== 'undefined' && geo) ? Pipeline.compileRoutingPlan(geo) : null;
    // the energized-belt set: derived from the SAME plan the sidecar routes by, so a glowing line always
    // means "a complete route runs here" and a cold line always means the chain is incomplete
    beltLiveSet = (routingPlan && Pipeline.liveTiles) ? Pipeline.liveTiles(routingPlan) : null;
    beltTileSet = new Set(((geo && geo.belts) || []).map(b => b.x + ',' + b.y));
    routeTagCache = null; hoverBeltTile = null;   // the floor changed — every cached hover answer is stale
    routingNags = buildRoutingNags();
    // B5: enrich each bay with the capability objectTypes in its room, so the sidecar can isolate that agent's
    // tools to exactly what the floor placed there (the bay->agent binding decides WHO; the room decides WHAT).
    // dockBays too — a LONE bay (no belt) is a complete dock and isolates identically (sense pass 2026-07-05).
    if (routingPlan && station && typeof station.bayObjects === 'function') {
      for (const b of (routingPlan.bays || [])) b.objects = station.bayObjects(b.agentId);
      for (const b of (routingPlan.dockBays || [])) b.objects = station.bayObjects(b.agentId);
    }
    postRoutingPlan(routingPlan);
  }
  // fire-and-forget the plan to /api/routing, but only when the floor TOPOLOGY actually changed (hash dedupe —
  // rederive() also runs on pure camera/agent moves). The sidecar REFUSES a non-deployable plan (cycle/orphan)
  // and falls back to its default resolution, so a broken floor disables routed-mode rather than stalling work.
  function postRoutingPlan(plan) {
    if (typeof fetch === 'undefined') return;
    // dedupe on topology hash + per-bay caps, so equipping a bay (a capability change with no belt change) still re-POSTs
    const objKey = o => (o && typeof o === 'object') ? (o.objectType + '#' + (o.connectorId || '')) : o;   // connector objs carry a binding; stringify it so a re-bind re-POSTs
    const hash = plan ? ((plan.hash || '') + '|' + (plan.bays || []).map(b => b.agentId + ':' + ((b.objects || []).map(objKey).join(','))).join(';')) : '';
    if (hash === lastPlanHash) return;
    lastPlanHash = hash;
    try { fetch(apiUrl('/api/routing'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan || {}) }).catch(() => {}); } catch (_) {}
  }
  // junction props (splitter/filter/merger) keyed by tile — derived from the compiled plan so the VISUAL engine
  // animates filters + mergers (not just splitters) using the SAME config the dispatch router routes by.
  function buildJunctions() {
    if (routingPlan && routingPlan.junctions) {
      let j = null;
      // enrich each junction with its lanes' reachable OWNERS so addressed crates ride home (a shallow
      // copy — never mutate the plan object itself; the sidecar-posted plan/hash stays untouched)
      const owners = (typeof Pipeline !== 'undefined' && Pipeline.junctionLaneOwners) ? Pipeline.junctionLaneOwners(routingPlan) : {};
      for (const k in routingPlan.junctions) (j = j || new Map()).set(k, owners[k] ? Object.assign({}, routingPlan.junctions[k], { owners: owners[k] }) : routingPlan.junctions[k]);
      return j;
    }
    // fallback (Pipeline unavailable): the original splitter-only scan keeps belts animating
    let j = null;
    if (geo && geo.props) for (const p of geo.props) {
      if (p.t === 'splitter') (j = j || new Map()).set(p.x + ',' + p.y, { kind: 'split' });
    }
    return j;
  }
  // a real inbound message arrived — drop a box at the INTAKE so it rides the belts to the desk. The box carries
  // a CONTENT TAG (the same getTag the sidecar routes by) so a FILTER junction visibly sorts it toward the
  // matching agent's bay — frontend sort == backend dispatch.
  function intakeMessage(payload) {
    if (!convey) return;
    // tag the box with its content kind (the same getTag the sidecar routes by) so a FILTER sorts it visibly
    const p = payload || {};
    if (!p.tag && typeof Classify !== 'undefined' && Classify.getTag) p.tag = Classify.getTag(p.preview || p.text || '');
    // ride inbound work as ORE — a UNIFORM raw chunk: every incoming request is one identical piece of raw
    // material on the line. We deliberately DON'T size it; product-vs-slag is the rewarded signal,
    // bound to real outcomes, never to this inbound request. (WIRING_AUDIT P4: lie #5.)
    p.box = 'ore';
    if (p.weight == null) p.weight = 0.3;
    // WHERE does this work ENTER the floor? (multi-network law, 2026-07-05 — Andrew's two-room bug):
    //  • a COMMS directive is a DIRECT order to a specific agent — it skips the station doors entirely and
    //    lands at that agent's BAY (the model sentence: "COMMS orders skip the ride in");
    //  • addressed channel/cron work enters through the INBOX whose line actually REACHES its agent's dock
    //    (Pipeline.sourceFor — each room's INBOX feeds its own network, never another room's outbox);
    //  • unaddressed work takes the first INBOX (unchanged);
    //  • no reaching line → the work lands directly at the agent's BAY dock (a lone bay is a complete build).
    let t = null;
    if (p.kind !== 'directive') {
      t = (p.agentId && routingPlan && typeof Pipeline !== 'undefined' && Pipeline.sourceFor)
        ? Pipeline.sourceFor(routingPlan, p.agentId)
        : intakeTile();
    }
    if (t) convey.enqueueAt(t.x, t.y, p);
    else dockArrival(p);
    // ANTICIPATE: an idle agent senses work on the line and perks up toward the door it ACTUALLY entered
    // (the chosen entry tile — on a multi-inbox floor the first-intake glance pointed at the wrong door).
    if (agent && !agent.unplaced && activity === 'idle' && !agent.working) {
      const at = t || (geo && geo.props && geo.props.find(q => q.t === 'intake'));
      if (at) setGlance(dirToward(agent.px, agent.py, (at.x + 0.5) * T, (at.y + 0.5) * T), 1100, fnow);
      curiositySay(['incoming?', 'work inbound', 'something is coming', 'heads up'], 0.6, fnow);
      if (agent.goal == null) agent.idleUntil = Math.min(agent.idleUntil || 0, fnow + 200);
    }
  }
  /* LONE-BAY DOCK ARRIVAL: with no intake/belt route, work addressed to an agent still lands VISIBLY at its
     bay — a dock flash + the same "received:" beat the belt delivery rings. This is what makes a single
     assigned BAY a complete, working build (belts become the upgrade for watching work travel, never a
     prerequisite). Purely visual: the sidecar already ran the work either way (belt-is-never-a-gate law). */
  const dockFlashes = new Map();   // bay propId -> flash t0 (drawn by drawDockFlashes, ~1.1s decay)
  function dockArrival(p) {
    const aid = p && p.agentId;
    const docks = (routingPlan && routingPlan.dockBays) || [];
    // ADDRESSED work flashes ONLY its own agent's dock — never another agent's (that's a wrong-agent
    // reaction, the exact confusion this lane kills). Only UNADDRESSED work falls back to the first dock.
    const dock = aid ? docks.find(d => d.agentId === aid) : docks[0];
    if (!dock) return;                                             // no (matching) bay → nothing to show (today's behavior)
    dockFlashes.set(dock.propId, fnow);
    const body = bodyForAgent(aid);
    if (body && body !== agent) { sayAt(body, 'received: ' + (p.preview || 'message')); body.wakeAt = fnow; if (!(body.workUntil > fnow + 5000)) body.workUntil = fnow + 4000; }
    else if (agent && !agent.unplaced) { say('received: ' + (p.preview || 'message')); wakeIn(); }
  }
  // the dock catching a delivery: a bright ring + rim flash over the bay, ~1.1s, additive (with the glows)
  function drawDockFlashes(now) {
    if (!dockFlashes.size || !routingPlan || !routingPlan.dockBays) return;
    for (const [pid, t0] of dockFlashes) {
      const k = 1 - (now - t0) / 1100;
      if (k <= 0) { dockFlashes.delete(pid); continue; }
      const d = routingPlan.dockBays.find(b => b.propId === pid);
      if (!d) { dockFlashes.delete(pid); continue; }
      const X = d.x * T, Y = d.y * T, Wd = (d.w || 1) * T, Hd = (d.h || 1) * T;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 * k;
      ctx.strokeStyle = '#e8c860'; ctx.lineWidth = 1.5;
      const grow = (1 - k) * 5;
      ctx.strokeRect(X - grow, Y - grow, Wd + grow * 2, Hd + grow * 2);   // the expanding catch ring
      ctx.globalAlpha = 0.35 * k; ctx.fillStyle = '#e8c860';
      ctx.fillRect(X, Y, Wd, 2);                                          // hot rim on the dock's crown
      ctx.restore();
    }
  }
  // a belt tile to ship an outbound box from — beside the PRODUCING agent's own bay, not always the hero's.
  // The hero ships from its desk (byte-identical); a crew/summoned agent ships from a belt tile beside ITS
  // body; an unknown agent falls back to the hero desk. (WIRING_AUDIT P3: kill the single-hero-desk assumption.)
  function outboundBeltTile(aid) {
    // 1) the PRODUCING agent's own BAY hookup — finished work leaves from the dock, riding the bay→OUTBOX
    //    lane exactly like a ▸ TEST crate (2026-07-05 fix: the old desk-first order meant a hero with a
    //    belted BAY never shipped a riding crate, because no belt runs to the desk by design).
    if (aid && routingPlan && routingPlan.bays) {
      const b = routingPlan.bays.find(x => x.agentId === aid);
      const cand = b ? ((b.tiles && b.tiles.length) ? b.tiles : (b.tile ? [b.tile] : [])) : [];
      // a dock can touch several lanes (inbound + outbound): prefer the hookup whose ONWARD flow ships
      // to an OUTBOX — probe from the tile past it, since the hookup itself reads as the bay
      if (cand.length && typeof Pipeline !== 'undefined' && Pipeline.routeFrom && routingPlan.belts) {
        const DV = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
        for (const c of cand) {
          const d = routingPlan.belts[c.x + ',' + c.y], v = d && DV[d];
          if (!v) continue;
          const nx = c.x + v[0], ny = c.y + v[1];
          if (!routingPlan.belts[nx + ',' + ny]) continue;
          const r = Pipeline.routeFrom(routingPlan, nx, ny);
          if (r && r.outbox) return c;
        }
      }
      if (cand.length) return cand[0];
    }
    // 2) a crew body ships from a belt tile beside where it stands
    if (aid && agent && aid !== agent.id) {
      const b = bodyForAgent(aid);
      if (b && b !== agent) { const tt = tileOf(b.px, b.py); return beltTileNear(tt.x, tt.y, 1, 1); }
      // a CREW agent with no bay and no body has NO honest spawn point — no crate beats a crate
      // materializing on the HERO's lane (wrong-agent reaction; 2026-07-06 audit).
      return null;
    }
    // 3) legacy fallback (HERO only): a belt beside the hero's desk
    return desk ? beltTileNear(desk.tx, desk.ty, desk.w, desk.h) : null;
  }
  /* A COMPLETED RUN SHIPS A CRATE — BUT ONLY IF IT ACTUALLY WORKED (crate-honesty, Andrew's ruling
     2026-07-05): reason 'done' alone is NOT success — a run that ends by politely explaining it couldn't
     do the job is 'done' too. A crate (and the SHIPPED count) requires PROVEN work: ≥1 successful tool
     result or a produced deliverable during the run, tracked from the same bus events the tickers ride.
     The single crate source stays agent.run.end (no double-crate from workitem.delivered); no lane → no
     riding crate (the pallet + counter still tell the server's truth). */
  const runWork = new Map();         // agentId -> { tools, dels } observed during the CURRENT run
  const shippedRunIds = new Set();   // dedup: run.end can be observed twice (local harness + SSE echo)
  function runWorked(aid) {
    const w = runWork.get(aid || 'agent');
    return !!(w && (w.tools > 0 || w.dels > 0));
  }
  function shipProductCrate(p) {
    if (!convey) return;
    const rid = (p && p.runId) || '';
    if (rid) { if (shippedRunIds.has(rid)) return; shippedRunIds.add(rid); if (shippedRunIds.size > 400) shippedRunIds.clear(); }
    const t = outboundBeltTile(p && p.agentId);
    if (t) convey.enqueueAt(t.x, t.y, { outbound: true, box: 'product', weight: 0.3, workitemId: (p && p.workitemId) || '' });
  }
  // an unproductive run produced no deliverable — ride a red-hot SLAG crate off the PRODUCING agent's bay
  // carrying its post-mortem one-liner, so the failed outcome is visible leaving the line.
  function enqueueSlag(diag, aid) {
    if (!convey) return;
    const t = outboundBeltTile(aid);
    const clean = s => String(s || '').replace(/\bspend\b/ig, 'run resources').replace(/\bdollars?\b/ig, 'limits');
    if (t) convey.enqueueAt(t.x, t.y, { outbound: true, box: 'slag', postmortem: (diag && (clean(diag.title) + ' - ' + clean(diag.fix))) || 'unproductive run' });
  }
  /* ---------- crew bodies (the OTHER agents, standing at their bays) ---------- */
  // a LIGHT body: the full agent field-shape (so SPRITES.drawBody/drawFallback never choke) but STATIC —
  // it never ticks/paths. It only receives work (a say bubble + a wake ripple + a bay work-glow).
  function makeCrewBody(aid, name, color, fx, fy, skin) {
    return {
      id: aid, agentId: aid, name: name || aid, color: color || '#5ad0ff', skin: skin || DATA.DEFAULT_SKIN, crewBody: true,
      // P2 STABLE HOME: the spawn foot tile, pinned ONCE here. anchorFor's deskless leash-fallback reads this
      // (never the live px/py) so a wandering body's leash stays CENTRED ON ITS SPAWN SPOT and does not ratchet
      // across the floor in DEFAULT_LEASH hops as it strolls (A2 'bounded leash' / world.js anchor note: stable home).
      home: tileOf(fx, fy),
      px: fx, py: fy, dir: 'south', state: 'idle', sitting: false, working: false, unplaced: false,
      // `phase` stays an INTEGER (phaseOf indexes PHASES[] with it); `aph` is the FLOAT sprite offset — see the hero's note.
      phase: U.hash('' + aid) % 6, aph: (U.hash('' + aid) % 600) / 100, target: null, pathPts: null, pathIdx: 0, idleUntil: 0, goal: null, say: { text: '', until: 0 },
      usingProp: null, useUntil: 0, useFace: 'south', useSit: false, watchProp: null,
      seated: false, seatPx: 0, seatPy: 0, seatKey: null, pendSeat: null,
      glance: null, glanceCd: 0, nextFidget: 0, studyUntil: 0, noticeCd: 0, studyKey: null,
      summonGlanceCd: 0,   // Tier C / C-Beat1: per-observer refractory (mirrors the hero literal) — runtime-only
      neighborGlanceCd: 0, // Tier C / C-Beat2: per-body mutual-glance cooldown (mirrors the hero literal) — runtime-only
      wakeAt: 0, workUntil: 0,
      // B0 — FULL ENGINE STATE SHAPE (additive, runtime-only): mirror the hero literal (spawn ~346-367) so a
      // crew body reads real meters/temperament when Tier B2 routes the sentience engine through it (stepCrew →
      // crewEngineStep, with self=b). Every field is per-body: a FRESH needs object and a NEW fond Map (never a
      // shared reference) so no body ever
      // reads/mutates another's state (J2). Determinism: needs seeded via U.irnd, temperament via makePersonality
      // (U.hash, no RNG) — no Math.random/Date.now (J5).
      pers: makePersonality(aid),
      needs: { rest: U.irnd(72, 92), stim: U.irnd(72, 92), social: U.irnd(72, 92) },   // born content (same init as the hero)
      lastTaskAt: 0, thinkUntil: 0, settleUntil: 0, trackUntil: 0,
      quirkKind: null,
      placeTarget: null, removeId: null,
      roundsQueue: null, roundsCd: 0,
      fond: new Map(), revisitCd: 0,   // SPATIAL MEMORY: a NEW Map per body — never shared
      pauseUntil: 0, pauseLook: null, pauseCd: 0, yieldCd: 0, lookBackCd: 0,
      attn: null, drive: null, driveUntil: 0,   // CONTINUITY OF ATTENTION — per-body like every sibling field (never shared)
      stilling: false,
      inspectNovel: null, lookCd: 0,   // lazily-read engine fields (arrive/planInspect/maybeGlance) seeded so first read isn't undefined
      // per-body cooldown gates the engine reads via self (quirkCd/offbeatCd are now per-body in maybeQuirk/offbeat —
      // no swarm-wide lockstep; placeCd/mournCd seeded for the same per-body discipline as B3 generalizes those gates).
      quirkCd: 0, offbeatCd: 0, placeCd: 0, mournCd: 0
    };
  }
  // reconcile `crew` with the plan's bound bays: one light body per bay (except the hero's own), standing at
  // the bay prop's foot. Reuses existing bodies by agentId so a re-bake doesn't wipe a live say bubble.
  function syncCrewFromPlan() {
    // No bound bays (or no geo yet): drop the plan-derived crew, but KEEP summoned bodies — a summoned-but-unbound
    // agent has no bay, so an empty plan must NOT wipe it (else it vanishes on the next rederive, e.g. a build toggle).
    if (!routingPlan || !routingPlan.bays || !routingPlan.bays.length || !geo) {
      crew = crew.filter(b => b.summoned);
      if (geo) refootStranded();   // the no-bays plan used to SKIP the stranded re-foot entirely — a summoned body off the floor (pre-geo {0,0} park, a refit) stayed in the void forever (2026-07-12)
      sweepAgentMaps(); return;
    }
    const want = new Map();
    for (const bay of routingPlan.bays) {
      if (agent && bay.agentId === agent.id) continue;                 // the hero already represents its own bay
      const p = geo.props && geo.props.find(pp => pp.id === bay.propId);
      if (!p) continue;
      // foot IN FRONT of the bay (south approach, PropAnchor side-fallback) — never inside the bay's own
      // footprint: a body footed on the bay's bottom tile sits one pixel above the bay's y-sort line, so the
      // taller bay sprite draws OVER it and the agent reads as missing (the every-relaunch "agents hiding
      // behind their bay" bug, 2026-07-07). A walled-in bay / missing module falls back to the old
      // bottom-centre foot so the body still exists somewhere rather than nowhere.
      let f = null;
      if (typeof PropAnchor !== 'undefined') {
        const a = PropAnchor.deriveAnchor(p, geo, { approach: 'south', extra: blocked });
        if (a) f = footOf(a.tx, a.ty);
      }
      want.set(bay.agentId, f || { x: (p.x + (p.w > 1 ? 1 : 0)) * T + T / 2, y: (p.y + (p.h || 1) - 1) * T + T - 1 });
    }
    crew = crew.filter(b => b.summoned || want.has(b.agentId));        // drop plan bodies whose bay is gone; KEEP summoned crew
    for (const [aid, pos] of want) {
      const b = crew.find(x => x.agentId === aid && !x.summoned);
      if (b) { b.px = pos.x; b.py = pos.y; }
      else if (!crew.some(x => x.agentId === aid)) crew.push(makeCrewBody(aid, aid, crewColor(aid), pos.x, pos.y));
    }
    refootStranded();   // a refit may have moved the floor under a summoned body — re-foot any that no longer stand on a walkable tile.
    sweepAgentMaps();   // E6b: an agent dropped from the roster leaves per-agent map entries — evict them here
  }
  // re-foot every SUMMONED body that no longer stands on a walkable tile (plan-derived bodies are
  // re-set at their bay foot by syncCrewFromPlan itself; a deliberately-fallback bay foot may sit on
  // the bay footprint, so they are excluded). Re-pins the leash home too: the spawn spot genuinely
  // moved (A2 stays centred on the new home). Seated/desk-sitting bodies legitimately render on a
  // prop tile — never evict those.
  function refootStranded() {
    if (!geo) return;
    for (const b of crew) {
      if (!b.summoned || b.seated || b.sitting) continue;
      const t = tileOf(b.px, b.py);
      if (!geo.walkable(t.x, t.y, blocked)) { const f = workerFoot(); b.px = f.x; b.py = f.y; b.home = tileOf(f.x, f.y); }
    }
  }
  /* Lane E6b — roster-change map sweep. The per-agent maps (heat/deskProg/xp/computeOk) and the pairwise social
     cooldown accumulate an entry per agent id that appears; a roster removal (a bay unbound, a summoned worker
     retired) used to leave those entries behind to grow unbounded on a 24/7 station. Called from the one place
     roster membership is reconciled (syncCrewFromPlan), it clears entries for ids no longer present (hero + live
     crew are always kept). NOTE: `seenCount` is deliberately EXCLUDED — it is keyed by prop-id/belt studyKey, not
     agentId (see its set/get sites), so sweeping it here by agent id would wrongly drop prop-familiarity state. */
  function sweepAgentMaps() {
    const live = new Set();
    if (agent && agent.id) live.add(agent.id);
    for (const b of crew) if (b && b.agentId) live.add(b.agentId);
    for (const m of [heatByAgent, deskProg, xpByAgent, computeOkCache]) {
      for (const k of Array.from(m.keys())) if (!live.has(k)) m.delete(k);
    }
    for (const k of Array.from(socialPairCd.keys())) {      // "idA|idB" — drop the pair if EITHER side is gone
      const parts = String(k).split('|');
      if (!live.has(parts[0]) || !live.has(parts[1])) socialPairCd.delete(k);
    }
  }
  // the body that runs a given agentId: the hero, a crew body, or null (caller falls back to the hero)
  function bodyForAgent(aid) {
    if (!aid) return null;
    if (agent && aid === agent.id) return agent;
    return crew.find(b => b.agentId === aid) || null;
  }

  /* ---------- summoned workers (real, independent crew bodies) ----------
     A SUMMONED agent (App.summonAgent) has no routing-plan bay, so it isn't a plan-derived crew body — it's
     an app-level worker that stands at its own spot in the spawn room and visibly WORKS (lit + typing pose)
     while its REAL run is in flight. It reuses the crew render path entirely; the hero is never touched. */
  // a distinct walkable standing spot, fanned out from the spawn-room centre so summoned crew don't stack.
  function workerFoot() {
    const t = spawnTileLocal();
    const ring = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [3, 1], [-3, 1], [1, 3], [-1, -3], [3, -2]];
    const seen = new Set(crew.filter(b => b.summoned).map(b => { const tt = tileOf(b.px, b.py); return tt.x + ',' + tt.y; }));
    for (let i = 0; i < ring.length; i++) {
      const tx = t.x + ring[i][0], ty = t.y + ring[i][1];
      if (geo && geo.walkable(tx, ty, blocked) && !seen.has(tx + ',' + ty)) return footOf(tx, ty);
    }
    return footOf(t.x, t.y);
  }
  // give a summoned agent a real floor body (idempotent). Static like crew, but flagged `summoned` so the
  // floor-reset paths (loadStation / syncCrewFromPlan) preserve it, and lit by setActivityFor on a real run.
  function spawnAgent(a) {
    if (!a || !a.id || (agent && a.id === agent.id)) return;
    // already on the floor as a plan-derived bay body (loadStation's rederive runs before this on boot):
    // REHYDRATE its inner life instead of bailing. `summoned` is runtime-only, so across a relaunch a
    // bay-bound roster agent otherwise freezes at its bay foot (stepCrew gates the sentience engine on the
    // flag) and VANISHES outright if its bay is later deleted (syncCrewFromPlan keeps only summoned bodies
    // when a bay disappears) — while the manifest/dossier still list it. The law this restores: a roster
    // agent ALWAYS has a live floor body; its bay decides where it homes, never whether it exists (2026-07-07).
    const ex = crew.find(b => b.agentId === a.id);
    if (ex) { ex.summoned = true; return; }
    const f = geo ? workerFoot() : { x: 0, y: 0 };                        // pre-geo: parked at origin, re-footed on first syncCrewFromPlan
    const b = makeCrewBody(a.id, a.name || a.id, a.color || crewColor(a.id), f.x, f.y, a.skin);
    b.summoned = true; b.wakeAt = fnow;                                   // a small materialize ripple
    b.idleUntil = fnow + U.irnd(1400, 3200);                              // hold a beat after materializing, then it strolls
    crew.push(b);
  }
  // rename a placed body (hero or crew) so its floor nameplate follows a dossier rename. DISPLAY-ONLY: the
  // agentId that keys crew/anchors/engine-state never changes, so this can't disturb any body's identity.
  function relabel(id, name) {
    const nm = String(name || '').trim();
    if (!id || !nm) return false;
    if (agent && agent.id === id) { agent.name = nm; return true; }
    const b = crew.find(x => x.agentId === id);
    if (b) { b.name = nm; return true; }
    return false;
  }
  // DOSSIER › DELETE AGENT: pull a summoned crew body off the floor for real. Only ever removes a CREW body —
  // the hero (agent) is never a crew entry and can't be reached here (guarded by the caller too). Idempotent:
  // returns true if a body was removed. Any transient locks referencing the body (a chase, a social encounter)
  // self-heal next tick because their partner-broken checks already treat a missing/absent body as torn.
  function despawnAgent(agentId) {
    if (!agentId || (agent && agentId === agent.id)) return false;   // never the hero
    const i = crew.findIndex(b => b.agentId === agentId);
    if (i < 0) return false;
    if (chaseId === agentId) chaseId = null;   // drop any active chase lock addressed to the gone body (sweepChase would clear it next tick anyway)
    crew.splice(i, 1);
    return true;
  }
  // DOSSIER › CHANGE SKIN: repoint a live body's sprite set. Display-only — the agentId, position, engine state
  // and foot-anchor are untouched; only which DATA.SKINS entry drawBody looks up changes, so the LOCKED
  // pixelation + foot-padding rules still apply (we change WHICH skin, not how a skin renders). Works for the
  // hero and for a summoned crew body.
  function setSkin(agentId, skin) {
    const sk = String(skin || '').trim();
    if (!sk || (typeof DATA === 'undefined' || !DATA.SKINS || !DATA.SKINS[sk])) return false;
    const b = bodyForAgent(agentId);
    if (!b) return false;
    b.skin = sk;
    return true;
  }
  // per-agent activity: the HERO routes to setActivity (byte-identical single-agent path); a summoned crew
  // body lights + takes the working pose while its run is live, and extinguishes when it ends.
  function setActivityFor(agentId, kind) {
    const now0 = (typeof performance !== 'undefined') ? performance.now() : fnow;
    if (!agentId || (agent && agentId === agent.id)) {
      setActivity(kind);                                                  // HERO: byte-identical single-agent path (the seize itself is in tick)
      if (kind === 'task' || kind === 'thinking') summonGlance(agent, now0);   // C-Beat1: AFTER the activity flips to task — observers (crew) may glance at the summoned hero (K3 never blocks the seize)
      return;
    }
    const b = crew.find(x => x.agentId === agentId);
    if (!b) return;                                                       // not yet spawned (e.g. summon mid-flight) — nothing to animate
    const working = (kind === 'task' || kind === 'thinking');
    b.working = working; b.sitting = false; b.dir = working ? 'north' : 'south';   // face away = "at work"; stepCrew seats it at its desk if it has one, else it stands here
    if (working) { b.target = null; b.pathPts = null; seizeFromIdle(b); }   // drop any in-flight stroll AND any couch/leisure latch so stepCrew re-paths straight to the chair (J4)
    const now = now0;
    if (working) { b.workUntil = now + 3600000; if (!b.wakeAt || now - b.wakeAt > 1500) b.wakeAt = now; sayAt(b, 'working…'); }
    else { b.workUntil = 0; if (b.say && /working/.test(b.say.text || '')) b.say = { text: '', until: 0 }; }
    if (working) gripeNoCompute(b);      // G0.7: sat down to work in a computeless room — one honest complaint, then silence
    if (working) summonGlance(b, now);   // C-Beat1: AFTER the work-seize (K3 summon-wins) — OTHER idle in-sight bodies 50% glance at the newly-summoned `b`
  }

  // the WATCHABLE HANDOFF: the lead delegated to worker `toId`. 'spawned' lights the worker (chat.js does NOT
  // drive a DELEGATED worker — its run rides the lead's stream) and flies a box from the lead body to it; 'done'
  // dims it. A direct lerp (no belts needed) so the handoff always reads. No-op for the hero / an unknown body.
  function handoff(fromId, toId, phase) {
    const to = bodyForAgent(toId);
    if (!to || to === agent) return;
    const now = (typeof performance !== 'undefined') ? performance.now() : fnow;
    if (phase === 'done') { to.working = false; to.workUntil = 0; to.dir = 'south'; return; }
    to.working = true; to.sitting = false; to.dir = 'north'; to.target = null; to.pathPts = null; seizeFromIdle(to);   // re-path straight to its desk if it has one (stepCrew), else stand; drop any leisure latch (J4)
    to.workUntil = now + 3600000; if (!to.wakeAt || now - to.wakeAt > 1500) to.wakeAt = now;
    sayAt(to, 'on it…');
    gripeNoCompute(to);   // G0.7: a delegated worker in a computeless room complains once too
    const from = bodyForAgent(fromId) || agent;
    if (from && from !== to) handoffBoxes.push({ fromX: from.px, fromY: from.py - 6, toX: to.px, toY: to.py - 6, t0: now, color: to.color || '#5ad0ff' });
    summonGlance(to, now);   // C-Beat1: a delegated worker just started — OTHER idle in-sight bodies 50% glance at it (AFTER its seize, K3)
  }
  // draw the in-flight handoff boxes (world space, over the entities). A small arced lerp that self-expires.
  function drawHandoffBoxes(now) {
    if (!handoffBoxes.length) return;
    const DUR = 720;
    for (let i = handoffBoxes.length - 1; i >= 0; i--) {
      const b = handoffBoxes[i];
      const t = (now - b.t0) / DUR;
      if (t >= 1) { handoffBoxes.splice(i, 1); continue; }
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // easeInOutQuad
      const x = Math.round(b.fromX + (b.toX - b.fromX) * e);
      const y = Math.round(b.fromY + (b.toY - b.fromY) * e - Math.sin(t * Math.PI) * 7);   // a little arc
      ctx.save();
      ctx.globalAlpha = 0.28; ctx.fillStyle = '#000'; ctx.fillRect(x - 2, Math.round(b.toY), 4, 1);   // ground shadow at the destination
      ctx.globalAlpha = 0.92; ctx.fillStyle = b.color; ctx.fillRect(x - 2, y - 2, 4, 4);
      ctx.fillStyle = U.shade(b.color, 0.45); ctx.fillRect(x - 2, y - 2, 4, 1);
      ctx.restore();
    }
  }
  function sayAt(body, text) {
    if (!body) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    body.say = { text: t.slice(0, 160), until: performance.now() + 4200 };
  }
  // G0.7: the one-time "I need a computer here" complaint — spoken the first time a body takes the
  // working pose while its bay room grants no COMPUTE (screens stay dark; the run dies at the gate).
  // The latch resets if the room is later fixed, so a re-broken room earns exactly one fresh gripe.
  function gripeNoCompute(b) {
    if (!b || !b.agentId) return;
    if (computeOkFor(b.agentId)) { b.noComputeGriped = false; return; }
    if (b.noComputeGriped) return;
    b.noComputeGriped = true;
    sayAt(b, U.pick(SELF_NOCOMPUTE));
  }
  // is a BAY prop's bound agent actively working (so the bay lights up)?
  function bayLit(p, now) {
    if (!p.agentId) return false;
    if (agent && p.agentId === agent.id) return !!agent.working;
    const b = crew.find(x => x.agentId === p.agentId);
    return !!(b && b.workUntil > now);
  }
  // a payload box reached an open end: route it to the bound agent's bay (the SAME bay the box rode to, per the
  // plan) and light THAT body. No bay / unrouted -> the hero receives it, exactly as before (never stalls).
  function onWorkitemDeliver(bx) {
    const p = (bx && bx.payload) || {};
    if (p.outbound) {
      lastOutboxFlash = fnow;   // box reached the OUTBOX -> flash the chute
      // slag is NOT a satisfying delivery — skip the relaxed exhale; the post-mortem already fired at run.end
      if (p.box !== 'slag' && agent && !agent.unplaced && activity === 'idle') {   // EXHALE: watch the reply leave, satisfied, then relax (downtime clock resets)
        const ob = geo && geo.props && geo.props.find(q => q.t === 'outbox');
        if (ob) setGlance(dirToward(agent.px, agent.py, (ob.x + 0.5) * T, (ob.y + 0.5) * T), 1100, fnow);
        curiositySay(SELF_DISPATCH, 0.7, fnow); agent.lastTaskAt = fnow;
      }
      return;
    }
    // INBOUND: prefer the agentId the box CARRIES — cron/channel address it explicitly to the run's agent, so the
    // "received" beat lands on exactly the body that runs (server-authoritative; no re-derivation drift). Fall
    // back to the landing tile, then resolveTarget(tag), for an unaddressed box. The work POSE itself is owned by
    // the run-lifecycle binding above, so here we only ring the "received: <instruction>" beat and NEVER cut short
    // an already-working body (an active run's glow must outlast this 4s pulse).
    const landed = (routingPlan && routingPlan.bayTileToAgent) ? routingPlan.bayTileToAgent[bx.x + ',' + bx.y] : null;
    const aid = p.agentId || landed || ((typeof Pipeline !== 'undefined' && routingPlan) ? Pipeline.resolveTarget(routingPlan, { tag: p.tag }) : null);
    const body = bodyForAgent(aid);
    if (body && body !== agent) { sayAt(body, 'received: ' + (p.preview || 'message')); body.wakeAt = fnow; if (!(body.workUntil > fnow + 5000)) body.workUntil = fnow + 4000; }
    else { say('received: ' + (p.preview || 'message')); wakeIn(); }   // the hero (or an unrouted box) — today's behaviour
  }
  /* ---------- the CAM-HUD ACTIVITY TICKER (stage narration) ----------
     A single diegetic security-camera line at the bottom of the .cam-hud overlay that names WHAT the station
     is doing RIGHT NOW, driven purely by real harness events (agent.run.* / agent.tool_call|result /
     provider.fallback). Truthful telemetry law: nothing shows unless the harness actually emitted it.
     Event-driven only — no rAF loop. Rapid bursts coalesce to ~2 updates/sec, always ending on the latest
     event; after IDLE_MS with no events the line fades to a clean frame. Page reload starts empty. */
  let tickerEl = null;              // the <span class="cam-ticker"> in .cam-hud (created lazily, once)
  let tickerReady = false;          // DOM was set up (or setup was attempted + the overlay was missing)
  let tickerPending = null;         // coalescing buffer: the latest {text, cls} not yet painted
  let tickerLastPaint = 0;          // performance.now() of the last DOM write (throttle floor)
  let tickerCoalesceT = 0;          // setTimeout id for the trailing-edge flush
  let tickerFadeT = 0;              // setTimeout id for the idle fade-out
  const TICKER_MIN_MS = 500;        // ≤ ~2 updates/sec
  const TICKER_IDLE_MS = 7000;      // clean frame after 7s of no activity
  // tool-in-flight state for the STRETCH desk glyph: agentId -> { name, callId } while a tool_call is open.
  const glyphByAgent = new Map();

  // codename for an agentId (hero or crew body), else a short id fallback — never throws.
  function tickerName(aid) {
    const b = bodyForAgent(aid);
    if (b && b.name) return String(b.name);
    return aid ? String(aid).slice(0, 8) : 'AGENT';
  }
  // suit colour for an agentId (inline colour is the established exception for suit tint), else null.
  function tickerSuit(aid) {
    const b = bodyForAgent(aid);
    return (b && b.color) ? String(b.color) : null;
  }
  // tool name → terse HUD glyph: mcp__foo__bar → FOO::BAR, web.search → WEB.SEARCH, else UPPERCASED.
  function tickerTool(name) {
    let n = String(name || '').trim();
    if (!n) return 'TOOL';
    const m = /^mcp__(.+?)__(.+)$/.exec(n);
    if (m) n = m[1] + '::' + m[2];
    return n.replace(/[_-]+/g, '.').toUpperCase();
  }
  function tickerClip(s, max) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  // create the ticker span inside the existing .cam-hud overlay (never touches index.html). Idempotent.
  function setupTicker() {
    if (tickerReady) return;
    tickerReady = true;
    if (typeof document === 'undefined') return;
    const host = document.querySelector('.cam-hud');
    if (!host) return;
    const el = document.createElement('span');
    el.className = 'cam-ticker';
    el.setAttribute('aria-hidden', 'true');   // the SR summary (#stage-summary) is the accessible channel; this is decorative HUD dressing
    host.appendChild(el);
    tickerEl = el;
  }

  // paint one line NOW (bypasses coalescing) — sets HTML (name span may carry a suit tint), tint class, and
  // arms the CRT blip + idle fade. transform/opacity only; instant swap under reduced motion.
  function paintTicker(text, cls, suit) {
    if (!tickerEl) return;
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    tickerLastPaint = now;
    // structure: "<name> ▸ <rest>" — split on the first " ▸ " so only the codename gets the suit tint.
    let html;
    const sep = ' ▸ ';
    const i = text.indexOf(sep);
    const esc = s => U.esc(s == null ? '' : s);   // one complete impl (escapes & < > " ' — quote-safe if this ever moves into an attr)
    if (i > 0) {
      const nm = esc(text.slice(0, i)), rest = esc(text.slice(i + sep.length));
      const style = suit ? ' style="color:' + suit + '"' : '';
      html = '<b class="ct-name"' + style + '>' + nm + '</b><span class="ct-sep"> ▸ </span>' + rest;
    } else {
      html = esc(text);
    }
    tickerEl.innerHTML = html;
    tickerEl.classList.toggle('cam-ticker--bad', cls === 'bad');
    // CRT blip: retrigger the one-step enter transition unless the OS asked for less motion.
    tickerEl.classList.remove('cam-ticker--on', 'cam-ticker--blip');
    if (!reduceMotion()) { void tickerEl.offsetWidth; tickerEl.classList.add('cam-ticker--blip'); }
    tickerEl.classList.add('cam-ticker--on');
    // (re)arm the idle fade — a fresh event resets the 7s clock.
    if (tickerFadeT) clearTimeout(tickerFadeT);
    tickerFadeT = setTimeout(() => { if (tickerEl) tickerEl.classList.remove('cam-ticker--on', 'cam-ticker--blip'); tickerFadeT = 0; }, TICKER_IDLE_MS);
  }

  // public entry: queue a line, coalescing bursts to ≤ ~2/sec and always ending on the latest event.
  function pushTicker(text, cls, suit) {
    if (!text) return;
    setupTicker();
    if (!tickerEl) return;
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    const since = now - tickerLastPaint;
    if (since >= TICKER_MIN_MS && !tickerCoalesceT) { paintTicker(text, cls, suit); return; }
    // inside the throttle window: stash as the pending trailing-edge line and (re)arm one flush timer.
    tickerPending = { text, cls, suit };
    if (!tickerCoalesceT) {
      const wait = Math.max(0, TICKER_MIN_MS - since);
      tickerCoalesceT = setTimeout(() => {
        tickerCoalesceT = 0;
        if (tickerPending) { const q = tickerPending; tickerPending = null; paintTicker(q.text, q.cls, q.suit); }
      }, wait);
    }
  }

  // one app-level EventSource: re-emit validated channel/work-item events onto U.bus, and react in-world
  function connectChannelBridge() {
    if (bridged || typeof U === 'undefined' || !U.bus) return;
    bridged = true;
    setupTicker();   // join the .cam-hud overlay (starts empty — no fake backfill)
    // ── CAM-HUD ACTIVITY TICKER: narrate the latest REAL harness event as one diegetic camera line. ──
    U.bus.on('agent.run.start', p => {
      if (!p || !p.agentId) return;
      const trig = String(p.trigger || '').toLowerCase();
      const tag = (trig === 'schedule') ? ' · ROUTINE' : (trig === 'event') ? ' · EVENT' : (trig === 'nightshift') ? ' · NIGHT SHIFT' : '';
      pushTicker(tickerName(p.agentId) + ' ▸ RUN INITIATED' + tag, '', tickerSuit(p.agentId));
    });
    U.bus.on('agent.tool_call', p => {
      if (!p || !p.name) return;
      const arg = tickerClip(p.argsSummary, 48);
      pushTicker(tickerName(p.agentId) + ' ▸ ' + tickerTool(p.name) + (arg ? ' · ' + arg : ''), '', tickerSuit(p.agentId));
    });
    // successes replace themselves via the next tool_call; only surface a genuine tool FAILURE tick.
    U.bus.on('agent.tool_result', p => {
      if (!p || !p.isError) return;
      pushTicker(tickerName(p.agentId) + ' ▸ ✗ ' + tickerClip(p.summary || 'tool error', 40), 'bad', tickerSuit(p.agentId));
    });
    U.bus.on('agent.run.error', p => {
      if (!p) return;
      pushTicker(tickerName(p.agentId) + ' ▸ RUN FAULT · ' + tickerClip(p.message || 'error', 40).toUpperCase(), 'bad', tickerSuit(p.agentId));
    });
    U.bus.on('agent.run.end', p => {
      if (!p) return;
      const turns = (p.turns | 0);
      const usd = +p.usd;
      let line = tickerName(p.agentId) + ' ▸ RUN COMPLETE';
      if (turns > 0) line += ' · ' + turns + ' TURN' + (turns === 1 ? '' : 'S');
      if (isFinite(usd) && usd > 0) line += ' · ' + U.usd(usd);
      // a DONE run that PROVABLY WORKED (tool result / deliverable) is a shipped job: bump the pallet
      // + tell the day's score in the same breath. A clean-but-workless finish is just RUN COMPLETE.
      if (p.reason === 'done' && runWorked(p.agentId)) line += ' · ' + bumpShipped() + ' SHIPPED TODAY';
      pushTicker(line, '', tickerSuit(p.agentId));
    });
    // PROVEN-WORK tracker (crate-honesty): what did the CURRENT run actually do? Reset on run.start;
    // successful tool results + deliverables accumulate; run.end consumers read it, then it's dropped.
    U.bus.on('agent.run.start', p => { if (p && p.agentId) runWork.set(p.agentId, { tools: 0, dels: 0 }); });
    U.bus.on('agent.tool_result', p => { if (p && !p.isError) { const w = runWork.get(p.agentId || 'agent'); if (w) w.tools++; } });
    U.bus.on('deliverable', p => { const w = runWork.get((p && p.agentId) || 'agent'); if (w) w.dels++; });
    U.bus.on('provider.fallback', p => {
      if (!p || !p.toModel) return;
      const to = String(p.toModel).split('/').pop();
      pushTicker('STATION ▸ REROUTE · ' + tickerClip(to, 32).toUpperCase(), '', null);
    });
    // ── STRETCH: desk work-glyph state — a tool in flight (tool_call → its tool_result) marks the agent;
    //    the render pass (drawWorkGlyphs) draws a tiny tag at that desk. run.end clears any stale mark. ──
    U.bus.on('agent.tool_call', p => { if (p && p.agentId && p.name) glyphByAgent.set(p.agentId, { name: p.name, callId: p.callId || null }); });
    U.bus.on('agent.tool_result', p => {
      if (!p || !p.agentId) return;
      const g = glyphByAgent.get(p.agentId);
      if (g && (!p.callId || !g.callId || g.callId === p.callId)) glyphByAgent.delete(p.agentId);
    });
    U.bus.on('agent.run.end', p => { if (p && p.agentId) glyphByAgent.delete(p.agentId); });
    U.bus.on('workitem.placed', p => intakeMessage(p));
    // (workitem.delivered no longer spawns a crate — the run.end 'done' handler below is the single
    //  crate source, so channel replies can't double-crate. delivered still feeds the floor stats fold.)
    U.bus.on('workitem.superseded', p => { if (p && p.workitemId && convey) convey.dropWorkitem(p.workitemId); });
    // queue.status drives BOTH the numeric backpressure gauge (chanQueues) and the FloorStats backlog fold.
    U.bus.on('queue.status', p => { if (p && p.queueId != null) chanQueues.set(p.queueId, Math.max(0, p.depth | 0)); if (floor) floor.onEvent('queue.status', p); });
    // THE FLOOR ECONOMY — fold the harness's real cost/outcome events into FloorStats (the floating
    // canvas readout was removed 2026-07-09; the fold stays for panel/widget consumers). harness.js
    // re-emits every sidecar event onto U.bus, and routed/crew runs arrive the same way over the SSE
    // bridge, so these tally the WHOLE station's spend->yield, not just the hero.
    if (!floor && typeof FloorStats !== 'undefined') floor = FloorStats.create();
    if (!slaglog && typeof SlagLog !== 'undefined') slaglog = SlagLog.create();
    U.bus.on('agent.cost', p => {
      if (floor) floor.onEvent('agent.cost', p, Date.now());
      // remember the most recent RECONCILED cache ratio — the smelter temperature a slag diagnosis reads
      if (p && (p.tokensIn | 0) > 0) lastCacheFrac = Math.max(0, Math.min(1, (p.cachedTokens || 0) / p.tokensIn));
      // E2 + Stage 2: a cost event reinforces the run TTL. A DELEGATED worker's stream is lifecycle+cost
      // ONLY (orchestration forwards no token/tool events), so without this the worker's sprite decayed to
      // idle at RUN_TTL while its run was still genuinely working (2026-07-07 escape: "the researcher just
      // stopped"). Cost fires every completed worker turn — the honest per-turn heartbeat we do have.
      if (p && p.agentId && runStartByAgent.has(p.agentId)) stampRun(p.agentId, p.runId);
    });
    // H3.1: a mid-run model/credential FAILOVER was invisible (provider.fallback had no consumer). Fold it into
    // the floor stats AND surface a LOGBOOK line so the operator sees the harness rerouting around a bad provider.
    U.bus.on('provider.fallback', p => {
      if (floor) floor.onEvent('provider.fallback', p, Date.now());
      if (p && typeof StationUI !== 'undefined' && StationUI.notify) {
        const how = p.rotate ? 'rotated credential' : 'switched model';
        StationUI.notify('⤳ failover (' + (p.reason || 'error') + ') · ' + how + ': ' + (p.fromModel || '?') + ' → ' + (p.toModel || '?'), 'warn');
      }
    });
    // THROUGHPUT + DWELL: pair each work-item's placement with its delivery (a reliable Date.now() clock,
    // since the box's belt-ride spans real wall-clock seconds) to fold items/min + time-on-line.
    U.bus.on('workitem.placed', p => { if (floor) floor.onEvent('workitem.placed', p, Date.now()); });
    U.bus.on('workitem.delivered', p => { if (floor) floor.onEvent('workitem.delivered', p, Date.now()); });
    U.bus.on('agent.run.end', p => {
      if (floor) floor.onEvent('agent.run.end', p, Date.now());
      const r = p && p.reason;
      // A clean finish that PROVABLY WORKED ships: one product crate leaves the producing agent's bay
      // and rides to the OUTBOX. A done-but-workless run ("I couldn't do that") ships NOTHING.
      if (r === 'done' && runWorked(p && p.agentId)) shipProductCrate(p);
      if (p && p.agentId) runWork.delete(p.agentId);   // the run is over — drop its work tally either way
      if (r !== 'max_iters' && r !== 'budget' && r !== 'error' && r !== 'refusal') return;
      // UNPRODUCTIVE RUN: pulse the SLAG cell, then turn the failed outcome into a lesson — a real post-mortem in the
      // notifications panel + a red-hot slag crate that rides off the line (if a desk belt exists). The
      // lesson lands regardless of belts; the belt only shows it.
      lastSlagAt = performance.now();
      if (!slaglog) return;
      const diag = slaglog.record(r, { cacheFrac: lastCacheFrac, turns: p && p.turns, usd: p && p.usd });
      if (typeof StationUI !== 'undefined' && StationUI.notify) {
        const clean = s => String(s || '').replace(/\bspend\b/ig, 'run resources').replace(/\bdollars?\b/ig, 'limits');
        StationUI.notify('⚠ SLAG (a run died with nothing to show) · ' + clean(SlagLog.line(diag)), 'warn');
      }
      enqueueSlag(diag, p && p.agentId);
    });
    // Stage 2: WATCH the lead delegate. A team.dispatch tool call opens a delegation window (until its tool_result);
    // any WORKER run that starts inside it flies a box lead→worker + lights the worker. Contract-free — rides the
    // existing agent.tool_call / agent.run.* events (the delegated child's lifecycle is forwarded onto the lead's stream).
    U.bus.on('agent.tool_call', p => { if (p && /^team[._]dispatch$/.test(p.name || '')) { delegateLead = p.agentId; delegateCall = p.callId; } });
    U.bus.on('agent.tool_result', p => { if (p && p.callId && p.callId === delegateCall) { delegateLead = null; delegateCall = null; } });
    // OVERLAP REFCOUNT: register every live run by runId (any trigger) BEFORE the extinguish consumers below —
    // only the LAST live run's end may darken an agent's pose/screens (see noteRunStart/noteRunEnd).
    U.bus.on('agent.run.start', p => { if (p && p.agentId) noteRunStart(p.agentId, p.runId); });
    U.bus.on('agent.run.start', p => { if (p && delegateLead) { const b = bodyForAgent(p.agentId); if (b && b !== agent) handoff(delegateLead, p.agentId, 'spawned'); } });
    U.bus.on('agent.run.end', p => { if (p) { const b = bodyForAgent(p.agentId); if (b && b !== agent && !noteRunEnd(p.agentId, p.runId)) handoff(null, p.agentId, 'done'); } });
    // AUTONOMOUS WORK (cron / channel / night shift): a server-initiated run has no in-app chat driving its body,
    // so bind its run lifecycle to the work pose HERE — the agent goes to its workstation and works for the run's
    // REAL duration, then stands when it ends. This is what makes an unattended run VISIBLE: the conveyor box rides
    // in (kind 'cron'/'telegram') AND the agent actually runs to its PC and types until done. Interactive chat
    // (trigger 'directive') drives its own body via chat.js and is excluded; a delegated worker (also 'directive')
    // is handled by the handoff bindings above — so this never double-drives a body. Any OTHER trigger is by
    // construction server-initiated (schedule/event/nightshift today) and takes the pose — the old
    // schedule|event whitelist silently dropped trigger 'nightshift', so a self-initiated task ran while the
    // body wandered idle (2026-07-18: the app asserting idle over a provably live run).
    U.bus.on('agent.run.start', p => { if (p && p.agentId && p.trigger && p.trigger !== 'directive') { serverLit.add(p.agentId); if (agent && p.agentId === agent.id) agent.taskViaConveyor = true; setActivityFor(p.agentId, 'task'); } });
    U.bus.on('agent.run.end', p => { if (p && p.agentId && !noteRunEnd(p.agentId, p.runId) && serverLit.has(p.agentId)) { serverLit.delete(p.agentId); setActivityFor(p.agentId, 'idle'); } });
    // M-mem.4: a real auto-compaction fired (the loop folded older context into a summary) — raise a
    // one-line notify. Truthful: driven by the event's own before/after token counts. The bottom-bar
    // CTX gauge flashes its own mint "compacted" echo (StationUI listens to agent.compact directly).
    U.bus.on('agent.compact', p => {
      const freed = (p && p.beforeTokens) ? Math.round((p.removed || 0) / p.beforeTokens * 100) : 0;
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('◈ context compacted' + (freed > 0 ? ' — freed ' + freed + '%' : ''), 'good');
    });
    // ── consume-side telemetry that was already validated + SSE-broadcast but had NO frontend listener
    //    (the wiring-honesty pass: render the events already on the bus so the floor reflects real activity). ──
    const hudNote = (txt, cls) => { try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(txt, cls || ''); } catch (_) {} };
    // CRON war-room pulse: an unattended routine actually fired / finished. cron.fire + cron.result are emitted
    // and SSE-broadcast by the tick driver; surface them so an autonomous fire is VISIBLE, not just in the log.
    U.bus.on('cron.fire', () => hudNote('◷ routine fired', 'good'));
    // cron.result outcomes (cron-driver.js finishFire): 'failed' warns; 'ok' celebrates (G0.9 — the win
    // case used to show nothing); 'silent' stays silent BY DESIGN — it means a clean run whose reply was
    // exactly the [SILENT] marker, i.e. the routine itself chose to report nothing.
    U.bus.on('cron.result', p => {
      if (!p) return;
      if (p.outcome === 'failed') hudNote('✕ routine failed' + (p.reason ? ' — ' + p.reason : ''), 'warn');
      else if (p.outcome === 'ok') hudNote('◷ routine completed', 'good');
    });
    // REWIND: the rare, important "we rolled the workspace back" beat. checkpoint.created is frequent + quiet
    // (the workbench already pulses on shell), so only the restore is toasted.
    U.bus.on('checkpoint.restored', () => hudNote('↶ rewound to an earlier restore point', 'warn'));
    // G0.6 CHANNEL ARRIVAL MADE VISIBLE: a real Telegram/Discord message just reached the station
    // (hub.js emits { channel, chatId, agentId, kind } on every admitted inbound). It used to be a
    // chime only — now the receiving agent's DISH fires (the web/comms on-ramp lighting up) and the
    // HUD names the channel. The riding crate + queue gauge still come from workitem.*/queue.status.
    U.bus.on('channel.inbound', p => {
      const dish = capPropFor('dish', p && p.agentId);
      if (dish && PropSprites.pulseProp) PropSprites.pulseProp(dish.id, 'dish');
      // channel may be an instance id ('telegram:<botId>' — multi-bot); the HUD names the PLATFORM, not internals.
      hudNote('📡 message received — ' + String((p && p.channel) || 'channel').split(':')[0].toUpperCase(), 'good');
    });
    // G0.6 CHANNEL REPLY MADE VISIBLE: the outbound side of the same on-ramp. hub.js emits channel.delivery
    // { channel, chatId, runId, ok, chunks, reason, agentId? } on every reply-send. Mirror the inbound copy
    // (pulse the DISH, name the channel), only on a genuine successful send — a failed delivery isn't a reply out.
    U.bus.on('channel.delivery', p => {
      if (!p || !p.ok) return;   // honesty: only confirm a reply that actually left
      // agentId (additive 2026-07-06) names WHICH agent replied. On a multi-agent floor, pulse ONLY that agent's
      // dish: its own dish, else a dish in its room. If the acting agent has NO dish in its room, pulse NOTHING —
      // it is a lie to strobe an unrelated agent's dish (do NOT fall back to any/cands[0]). Legacy sends with no
      // agentId keep the old any-dish behavior so a single-agent station still lights.
      let dish;
      if (p.agentId) {
        dish = (geo && geo.props) ? geo.props.filter(pr => (station && station.capForProp && station.capForProp(pr.t) === 'dish') || pr.t === 'dish')
          .find(pr => pr.agentId === p.agentId) : null;
        if (!dish) {
          const room = actingRoomId(p.agentId);
          if (room && geo && geo.props) dish = geo.props.filter(pr => (station && station.capForProp && station.capForProp(pr.t) === 'dish') || pr.t === 'dish')
            .find(pr => roomOfLocalTile(pr.x, pr.y) === room);
        }
        if (!dish) return;   // acting agent has no dish in reach -> no pulse (truthful telemetry, no wrong-dish strobe)
      } else {
        dish = capPropFor('dish', null);   // legacy/command send (no attribution): any dish, single-agent floor
      }
      if (dish && PropSprites.pulseProp) PropSprites.pulseProp(dish.id, 'dish');
      hudNote('📤 reply sent · ' + String(p.channel || 'channel').split(':')[0].toLowerCase(), 'good');   // instance ids ('telegram:<botId>') stay internal
    });
    // EL-11 #11 CHANNEL TROUBLE MADE VISIBLE: transport health (channel.connect) used to be seen ONLY inside the open
    // CHANNELS panel. A drop/fatal-token that happens while you're anywhere else in the station now surfaces a single
    // honest HUD line naming the channel + state — so a silently-dead channel can't swallow your messages unnoticed.
    // Enum is FROZEN to ['up','down','error'] (shared/events.js): only the unhealthy states toast; 'up' stays quiet.
    U.bus.on('channel.connect', p => {
      if (!p || !p.channel) return;
      const state = String(p.state || '').toLowerCase();
      if (state !== 'down' && state !== 'error') return;   // healthy reconnects are not alarms
      // 'telegram:<botId>' (an agent-bound bot instance) reads as 'TELEGRAM BOT' — platform truth without leaking ids.
      const raw = String(p.channel);
      const name = raw.indexOf(':') >= 0 ? (raw.split(':')[0].toUpperCase() + ' BOT') : raw.toUpperCase();
      const why = p.detail ? ' — ' + String(p.detail) : '';
      hudNote((state === 'error' ? '⚠ ' + name + ' sign-in/token error' : '⚠ ' + name + ' connection down') + why, 'bad');
    });
    // G0.5 BUDGET MADE VISIBLE: budget.threshold was alarm-audio only. The payload is the frozen
    // { scope: run|day|global, usd, cap } triple (sidecar/budget.js, one emit per scope+band crossing
    // per run) — the band isn't carried, so derive it from the numbers: at/over cap = stopped.
    U.bus.on('budget.threshold', p => {
      if (!p || !isFinite(+p.usd) || !isFinite(+p.cap) || +p.cap <= 0) return;
      const usd = +p.usd, cap = +p.cap;
      const scopeWord = p.scope === 'run' ? 'this run' : (p.scope === 'day' ? 'today' : 'the global pool');
      const money = v => U.usd(v);
      if (usd >= cap) hudNote('⛔ budget cap hit for ' + scopeWord + ' — ' + money(usd) + ' of ' + money(cap), 'warn');
      else hudNote('⚠ budget warning for ' + scopeWord + ' — ' + money(usd) + ' of ' + money(cap) + ' (' + Math.round(usd / cap * 100) + '%)', 'warn');
    });
    // LOW CREDITS MADE VISIBLE (2026-07-25): the balance the user BOUGHT is running out. Distinct from
    // budget.threshold above — that is spend against a cap they set; this is money running down. Fired once
    // per crossing by credits.js, so this can be a plain note without any de-dup of its own.
    // Says the real number and what happens next; never a percentage bar (a balance has no denominator).
    U.bus.on('credits.low', p => {
      if (!p || !isFinite(+p.balanceUsd)) return;
      const bal = U.usd(+p.balanceUsd);
      if (p.exhausted) hudNote('⛔ out of credits — ' + bal + ' left; managed runs will refuse until you add more', 'warn');
      else hudNote('⚠ credits running low — ' + bal + ' left, under the ' + U.usd(+p.thresholdUsd) + ' a run can reserve', 'warn');
    });
    // G0.4 CAPDENIED MADE VISIBLE: the run genuinely STOPPED at the capability gate (loop.js emits this
    // before ending the run) — flash the acting agent's desk red + say it plainly. Today this was
    // audio-only; the fix-it quest generator built on it is G1b's, not ours.
    U.bus.on('capdenied', p => {
      flashDesk(p && p.agentId, '#ff4a3d');
      const need = (p && p.need) || 'capability';
      hudNote('⛔ run blocked — ' + (need === 'compute' ? 'no computer in its room' : ('missing ' + need)), 'warn');
    });
    // G0.8 RUN-ERROR DISTRESS: the run died mid-flight (model call / dispatcher / loop guard). The chat
    // panel already prints the message; now the FLOOR reacts too — the red desk strobe + one short flat
    // line (eerie, never chatty; never stomps a live bubble). The stand-up itself rides the
    // agent.run.end (reason 'error') that loop.js guarantees after every run.error — consumed by the
    // serverLit / handoff run.end bindings above, so no body is ever left typing at a dead run.
    const ERROR_LINE = ['it broke', 'lost the thread', 'error state', 'something failed', '...no.'];
    U.bus.on('agent.run.error', p => {
      flashDesk(p && p.agentId, '#ff4a3d');
      const b = bodyForAgent(p && p.agentId);
      if (b && !(b.say && b.say.text && b.say.until > performance.now())) sayAt(b, U.pick(ERROR_LINE));
    });
    // MEMORY: a recall fence was injected into this run's prompt — surface the count so recall feels ALIVE, not silent.
    U.bus.on('memory.recall', p => { const c = p && (p.count | 0); if (c > 0) hudNote('◈ recalled ' + c + ' memor' + (c === 1 ? 'y' : 'ies'), 'good'); });
    // MEMORY WRITE: a durable memory was just committed (notebook tool or a Keep/Edit turn-in). Light the acting
    // agent's NOTEBOOK — the prop that grants the memory rung, same room-lookup the tool-family pulses use — and
    // say it plainly. { agentId, runId, id, kind, scope } (shared/events.js) — guard the agentId like neighbours.
    U.bus.on('memory.write', p => {
      const nb = capPropFor('notebook', p && p.agentId);
      if (nb && PropSprites.pulseProp) PropSprites.pulseProp(nb.id, 'notebook');
      hudNote('✎ memory saved', 'good');
    });
    // MEMORY FORGET: a memory was dropped (user discard / decay). A quiet HUD line, no pulse — nothing lit up.
    U.bus.on('memory.forget', () => hudNote('✕ memory forgotten', 'warn'));
    // G4 feature 1 — APPROVAL WALK-AND-WAIT. The run PAUSED on the sidecar awaiting a human yes/no (permission.prompt,
    // {promptId, agentId}). For the HERO, walk the body off its desk to the wait anchor and hold the waiting pose;
    // permission.response ({promptId, decision}) resumes (approve) or ends (deny) the run server-side, so we clear
    // the await and let the ongoing/finished run drive the body back to work or idle. (A DELEGATED worker's block
    // rides the lead's stream — hero-scoped here; crew await is future work.)
    U.bus.on('permission.prompt', p => { if (p && (!p.agentId || (agent && p.agentId === agent.id))) enterAwait({ promptId: p.promptId || '', agentId: p.agentId || (agent && agent.id) }); });
    U.bus.on('permission.response', p => { if (p && awaitPrompt && (!p.promptId || p.promptId === awaitPrompt.promptId)) clearAwait(); });
    // CONNECTOR PORTALS — make the external on-ramp LIVE: poll each configured server's state so a placed
    // portal glows green/amber/red, and pulse it when ITS tools fire (an mcp__<connectorId>__* tool call).
    const connIds = [];
    function pollConnectors() {
      if (typeof fetch === 'undefined' || typeof PropSprites === 'undefined') return;
      fetch(apiUrl('/api/connectors')).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }).then(j => {
        const list = (j && j.connectors) || []; connIds.length = 0;
        for (const c of list) {
          connIds.push(c.id);
          PropSprites.setConnectorState(c.id, c.state === 'up' ? 'connected' : (c.state === 'error' ? 'error' : 'offline'), c.toolCount);
        }
        // T3: a SUCCESSFUL poll is authoritative — drop any tracked portal absent from it so a removed/unbound
        // connector stops glowing green (a FAILED poll stays in .catch below and keeps the last-known state).
        if (PropSprites.reconcileConnectors) PropSprites.reconcileConnectors(connIds);
      }).catch(() => {});   // E4/E6f: on failure keep the last-known portal states — never blank them from an error body
    }
    connPollFn = pollConnectors; pollConnectors(); connPollTimer = setInterval(pollConnectors, 5000);
    // JUKEBOX dead-vs-live: poll Spotify's OAuth connected state so a placed jukebox reads DEAD (unplugged)
    // until the user connects Spotify in TOOLSETS, then comes alive. Same keep-last-known-on-failure contract.
    function pollSpotify() {
      if (typeof fetch === 'undefined' || typeof PropSprites === 'undefined' || !PropSprites.setSpotifyConnected) return;
      fetch(apiUrl('/api/spotify/status')).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
        .then(j => PropSprites.setSpotifyConnected(!!(j && j.connected)))
        .catch(() => {});   // keep last-known on a failed poll (mirrors the connector contract)
    }
    spotifyPollFn = pollSpotify; pollSpotify(); spotifyPollTimer = setInterval(pollSpotify, 5000);
    // TRUTH (audit T1 finding 5): the per-prop capability SURGE must reflect the tool's REAL OUTCOME, not the
    // mere attempt. agent.tool_call fires BEFORE the capability/consent gate (loop.js), so a denied or errored
    // call emits a tool_call identically to a success — pulsing the granting prop green on tool_call was a lie.
    // We now DEFER the surge to agent.tool_result: success → the green capability surge; error → a distinct RED
    // failure cue (the workbench verify-red model). agent.tool_result carries no `name`, so we correlate it back
    // to the call via callId (surgeCall). Heat/run-TTL still stoke on tool_call — a call WAS made + tokens flowed,
    // which is real activity regardless of the gate's verdict; only the object=capability SURGE waits for truth.
    const surgeCall = new Map();   // callId -> { cap, agentId } captured at tool_call, consumed at tool_result
    U.bus.on('agent.tool_call', p => {            // chat.js re-emits the hero's tool calls here; routed agents arrive via SSE
      const n = p && p.name;
      if (!n) return;
      heatBump(p.agentId, 0.35);                  // G0.3: any real tool fire is activity — stoke the desk heat
      stampRun(p.agentId, p.runId);               // E2: a tool fire reinforces the run TTL (its own run's clock too)
      if (typeof PropSprites === 'undefined') return;   // E6e: prop layer not loaded — heat still stoked, no throw
      if (n.indexOf('mcp__') === 0) {             // connector portals: pulse the BOUND portal (fires a packet on call — its LIVE/error glow is polled separately)
        if (!PropSprites.pulseConnector) return;
        for (const cid of connIds) if (n.indexOf('mcp__' + cid + '__') === 0) { PropSprites.pulseConnector(cid); break; }
        return;
      }
      // map the firing tool to the capability prop that GRANTS it (toolprops.js: fs.*→cabinet · web/browser→dish ·
      // notebook/skill/recall/todo→notebook · image_*→studio · spotify_*→jukebox). shell/verify keep their dedicated
      // workbench events below — the mapper returns null for them, so nothing ever double-fires. STASH it for the
      // result to resolve the surge; the callId join keeps a denied call from ever lighting the prop green.
      const cap = (typeof ToolProps !== 'undefined') ? ToolProps.toolPropType(n) : null;
      if (cap && p.callId) surgeCall.set(p.callId, { cap: cap, agentId: p.agentId });
    });
    U.bus.on('agent.tool_result', p => {
      if (!p || typeof PropSprites === 'undefined' || !PropSprites.pulseProp) return;
      const rec = p.callId ? surgeCall.get(p.callId) : null;
      if (!rec) return;                           // not a capability-prop tool (or no callId join) — nothing to surge
      surgeCall.delete(p.callId);
      const tgt = capPropFor(rec.cap, rec.agentId);   // the granting prop in the ACTING agent's OWN room (or none)
      if (tgt) PropSprites.pulseProp(tgt.id, rec.cap, !p.isError);   // green on success, RED on error/denied
    });
    // bound the correlation map: a run ending drops any of its still-open calls so a lost tool_result never leaks.
    U.bus.on('agent.run.end', () => { if (surgeCall.size > 64) surgeCall.clear(); });
    // workbench pulse: a shell command running glows the bench green; a verify result glows green/red by outcome.
    // ROOM-SCOPED: resolve the ACTING agent's OWN workbench (both events carry agentId) so only that bench glows —
    // not every placed bench on the floor. A roomless fallback (no resolvable target) uses the global pulse.
    const pulseWb = (agentId, ok) => {
      if (typeof PropSprites === 'undefined' || !PropSprites.pulseWorkbench) return;
      const tgt = capPropFor('workbench', agentId);
      if (tgt) PropSprites.pulseWorkbench(ok, tgt.id);
      else PropSprites.pulseWorkbench(ok);   // roomless single-bench floor — global fallback
    };
    U.bus.on('shell.exec', p => pulseWb(p && p.agentId, true));
    U.bus.on('verify.result', p => pulseWb(p && p.agentId, !!(p && p.passed)));
    // G0.3 TOKEN HEAT: every streamed token stokes the acting agent's desk heat —
    // the working screens burn by REAL token flow, never a faked flicker.
    U.bus.on('agent.token', p => { heatBump(p && p.agentId, 0.06); stampRun(p && p.agentId, p && p.runId); });   // E2: a token reinforces the run TTL (its own run's clock too)
    // G0.2 RUN CLOCK: elapsed-time bookkeeping keyed to the REAL run lifecycle (a run.error is always
    // followed by run.end reason 'error', so end is the one cleanup point). Internal reason-only runs
    // never reach U.bus (harness.js suppresses their start/end), so no clock ever shows for self-talk.
    U.bus.on('agent.run.start', p => { if (p && p.agentId) { if (!runStartByAgent.has(p.agentId)) runStartByAgent.set(p.agentId, performance.now()); stampRun(p.agentId); } });   // an overlapping start keeps the EARLIEST clock (the agent has been running since then)
    U.bus.on('agent.run.end', p => { if (p && p.agentId && !noteRunEnd(p.agentId, p.runId)) { runStartByAgent.delete(p.agentId); runLastSeenByAgent.delete(p.agentId); } });
    // G0.2 SIM-TASK PROGRESS: store a desk fraction ONLY when a producer publishes a real prog/dur pair
    // on the 'task' event (subagent status events carry none and store none). Terminal states clear it.
    U.bus.on('task', t => {
      if (!t || !t.agentId) return;
      // G4 feature 3: a sub-agent lifecycle event (kind:'subagent') folds into the Meeseeks helper ledger. The
      // lead is whoever is currently delegating (the open team.dispatch window), else the hero — so helpers
      // cluster near the desk that spawned them. The fold itself enforces the "live sub-agent ⇒ one sprite" law.
      if (subLedger && t.kind === 'subagent') subLedger.fold(t, performance.now(), delegateLead || (agent && agent.id) || null);
      if (t.status && t.status !== 'active' && t.status !== 'running' && t.status !== 'queued') { deskProg.delete(t.agentId); return; }
      const prog = +t.prog, dur = +t.dur;
      if (isFinite(prog) && isFinite(dur) && dur > 0) deskProg.set(t.agentId, Math.max(0, Math.min(1, prog / dur)));
    });
    if (typeof EventSource === 'undefined') return;
    let backoff = 1000;
    const open = () => {
      if (bridgePaused) return;   // disconnected to the title screen — do not (re)open
      try {
        // EventSource can't send the custom auth header, so pass the per-launch token as ?token=… and
        // prefix the sidecar base in the desktop build (where the page origin isn't the loopback http origin).
        const _tok = (typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) ? encodeURIComponent(String(window.__STARNET_API_TOKEN__)) : '';
        chanES = new EventSource(apiUrl('/api/channels/events') + (_tok ? ('?token=' + _tok) : ''));
      } catch (_) { return; }
      chanES.onopen = () => { backoff = 1000; lastSseEventAt = (typeof performance !== 'undefined') ? performance.now() : fnow; fetchSnapshot(); };
      chanES.onmessage = ev => { lastSseEventAt = (typeof performance !== 'undefined') ? performance.now() : fnow; try { const m = JSON.parse(ev.data); if (m && m.name) U.bus.emit(m.name, m.payload); } catch (_) {} };
      chanES.onerror = () => { try { chanES.close(); } catch (_) {} chanES = null; if (bridgePaused) return; setTimeout(open, backoff); backoff = Math.min(15000, backoff * 2); };
    };
    connOpenFn = open;
    open();
    // E2+ (2026-07-16): the snapshot reconcile used to fire ONLY on SSE (re)open, so a lost run.end inside a
    // HEALTHY link waited out the full 5m TTL before the floor/panel stopped asserting WORKING. Poll the same
    // authoritative snapshot on a slow cadence: truth converges within ~30s in BOTH directions (a dead run is
    // cleared; a genuinely live one is re-stamped, which also keeps the per-run TTL from biting a long quiet
    // run, e.g. one paused on a consent prompt). Paused bridge = deliberate silence — no polling.
    setInterval(() => { if (!bridgePaused) fetchSnapshot(); }, 30000);
  }
  /* E2: fetch the authoritative live-state snapshot on every SSE (re)open and reconcile the paired-state maps.
     404/failure-tolerant: the endpoint is owned by the lifecycle lane and may not exist here — any non-OK/throw
     just falls through to the TTL net. Uses apiUrl() (desktop-origin safe) + the harness fetch monkey-patch adds
     the auth header for /api/ URLs, matching every other frontend fetch. */
  function fetchSnapshot() {
    if (typeof fetch === 'undefined') return;
    try {
      fetch(apiUrl('/api/state/snapshot'), { cache: 'no-store' })
        .then(r => { if (!r.ok) return null; return r.json(); })
        .then(snap => { if (snap) { try { reconcileFromSnapshot(snap); } catch (_) {} } })
        .catch(() => {});   // endpoint absent / offline: TTL net covers it
    } catch (_) {}
  }
  // the live backlog total — FloorStats owns it (tested), with the chanQueues sum as a fallback if
  // FloorStats isn't loaded. Both the numeric gauge and the physical jam read this one source.
  function queueDepthNow() {
    if (floor) return floor.snapshot().queueDepth | 0;
    let d = 0; for (const v of chanQueues.values()) d += v; return d;
  }
  // (the bottom-right screen-space "INBOX n" queue-depth gauge was REMOVED 2026-07-12 — the CRT
  //  barrel warp skewed it into a "glitched panel" floating in the void at the canvas corner. The
  //  backlog stays visible through the physical crate jam at the INTAKE (drawQueueJam), which
  //  reads the same queueDepthNow() truth.)

  /* LINK DOWN marker (E1) — the honest "the live station telemetry has gone dark" chrome tag. Screen-space,
     top-center in the canvas chrome (never over a desk), VT323 + red phosphor bloom + a slow breathing blink so
     it reads as a live fault, not a frozen label. A glance, never a window (hover law). Only drawn while the SSE
     bridge is genuinely down (linkStaleDim) — clears itself the frame the link recovers. */
  const LINK_FONT = "13px 'VT323','Courier New',monospace";
  function drawLinkDown(now) {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false;
    const W = cv.width / dpr;
    const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(now / 300));   // slow breathing so it never looks stuck
    const label = '⚠ LINK DOWN';
    ctx.save();
    ctx.font = LINK_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const tw = ctx.measureText(label).width, cx = Math.round(W / 2), y = 6, padX = 6, padY = 3;
    ctx.fillStyle = 'rgba(20,6,4,0.82)'; ctx.fillRect(cx - tw / 2 - padX, y - padY, tw + padX * 2, 18);
    ctx.strokeStyle = 'rgba(255,80,60,0.55)'; ctx.lineWidth = 1;
    ctx.strokeRect(cx - tw / 2 - padX + 0.5, y - padY + 0.5, tw + padX * 2 - 1, 17);
    ctx.shadowColor = 'rgba(255,80,60,0.9)'; ctx.shadowBlur = 6 * dpr;
    ctx.globalAlpha = pulse; ctx.fillStyle = '#ff6a4c';
    ctx.fillText(label, cx, y);
    ctx.restore();
  }

  /* THE JAM — the live backlog made PHYSICAL: park N amber "waiting" crates climbing off the INTAKE so
     the jam's LENGTH is the real queue depth (straight from queue.status). World-space, lit with the floor
     like the riding crates. Honest: it shows the backend's pending-work count, never a guessed frontend hold. */
  function drawQueueJam(now) {
    const depth = queueDepthNow();
    if (depth <= 0 || !geo || !geo.props) return;
    const intake = geo.props.find(p => p.t === 'intake');
    if (!intake) return;
    // MAXVIS 3 (was 6): a deep backlog made a six-crate tower that dominated the room —
    // the pile stays a short glanceable jam and the '+N' counter carries the real depth.
    const MAXVIS = 3, shown = Math.min(depth, MAXVIS);
    const cx = (intake.x + (intake.w || 1) / 2) * T;       // centered on the intake footprint
    const top = intake.y * T - 3;                          // crates climb upward off the intake's top edge
    ctx.save();
    if (linkStaleDim) ctx.globalAlpha = 0.3;   // E1: link down → this jam length is last-known, not live; dim it
    for (let i = 0; i < shown; i++) drawWaitCrate(cx, top - i * 6 + Math.sin(now / 360 + i * 0.7) * 0.6);   // gentle idle bob
    if (depth > MAXVIS) {
      ctx.fillStyle = '#e8c860'; ctx.font = "7px 'VT323','Courier New',monospace"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('+' + (depth - MAXVIS), cx, top - shown * 6 - 3);
    }
    ctx.restore();
  }
  // one parked amber crate (waiting ore) — matches the riding-box silhouette/palette
  function drawWaitCrate(cx, cy) {
    const x = Math.round(cx - 4), y = Math.round(cy - 4);
    ctx.fillStyle = '#161210'; ctx.fillRect(x - 1, y - 1, 11, 8);   // dark outline
    ctx.fillStyle = '#8a7330'; ctx.fillRect(x, y + 3, 9, 3);        // shaded front face
    ctx.fillStyle = '#caa84a'; ctx.fillRect(x, y, 9, 3);           // lit amber top
    ctx.fillStyle = '#e8c860'; ctx.fillRect(x, y, 9, 1);           // top sheen
  }

  /* SHIPPED TODAY — the production pride display. Every job completed today stacks a green PRODUCT
     crate on a pallet in front of the OUTBOX, with a VT323 counter above ("SHIPPED 14"). The count is
     SERVER truth: completed runs (reason 'done') since LOCAL midnight via /api/runs — bumped
     optimistically on agent.run.end and reconciled by a 60s poll, so a page reload never zeroes the
     day. No OUTBOX on the floor → no pallet (the outbox IS the shipping surface); nothing draws until
     the server has actually answered (known), so it can never flash a fake number. Clicking the outbox
     with no pending return-crates opens the LOGBOOK — the shift record behind the stack. */
  let shipStats = { day: '', done: 0, known: false };
  let shipFlash = -1e9;   // fnow of the latest shipped job — the newest crate pops for ~0.9s
  const shipDay = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  const shipMidnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  function pollShipStats() {
    if (typeof fetch === 'undefined') return;
    try {
      fetch(apiUrl('/api/runs?agent=*&limit=500&since=' + shipMidnight()))
        .then(r => (r.ok ? r.json() : null))
        .then(j => {
          if (!j || !Array.isArray(j.runs)) return;   // no answer — keep the last known truth
          // SHIPPED = done AND provably worked (successful tools or artifacts on the server's run row).
          // Rows older than the toolsOk field count only via artifacts — under-claiming, never over.
          shipStats = { day: shipDay(), done: j.runs.filter(r => r && r.reason === 'done' && (((r.toolsOk | 0) > 0) || (Array.isArray(r.artifacts) && r.artifacts.length > 0))).length, known: true };
        }).catch(() => {});
    } catch (_) {}
  }
  // optimistic bump the moment a run lands (the 60s poll reconciles); returns the fresh count for the ticker
  function bumpShipped() {
    const day = shipDay();
    if (shipStats.day !== day) shipStats = { day, done: 0, known: shipStats.known };
    shipStats.done++; shipFlash = fnow;
    return shipStats.done;
  }
  function drawShippedPallet(now) {
    if (!shipStats.known || shipStats.done <= 0 || !geo || !geo.props) return;
    const ob = geo.props.find(p => p.t === 'outbox');
    if (!ob) return;
    const done = shipStats.done;
    const PERROW = 4, MAXVIS = 12, shown = Math.min(done, MAXVIS);
    const baseX = (ob.x + (ob.w || 1) / 2) * T;
    const baseY = (ob.y + (ob.h || 1)) * T + 6;   // the pallet sits on the floor in front of the chute
    ctx.save();
    if (linkStaleDim) ctx.globalAlpha = 0.3;   // E1: link down → this count is last-known, not live
    for (let i = 0; i < shown; i++) {
      const row = (i / PERROW) | 0, col = i % PERROW;
      const pop = (i === shown - 1 && now - shipFlash < 900) ? 1 - (now - shipFlash) / 900 : 0;
      drawShipCrate(baseX + (col - (PERROW - 1) / 2) * 10, baseY - row * 6, pop);
    }
    ctx.font = NAG_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.shadowBlur = 3; ctx.shadowColor = '#62ff9e'; ctx.fillStyle = '#9adcb0';
    ctx.fillText('SHIPPED ' + done, baseX, baseY - (((shown + PERROW - 1) / PERROW) | 0) * 6 - 4);
    ctx.shadowBlur = 0;
    ctx.restore();
  }
  // one banked PRODUCT crate — the green economy family (same read as the outbound product box)
  function drawShipCrate(cx, cy, pop) {
    const lift = pop > 0 ? Math.round(pop * 3) : 0;
    const x = Math.round(cx - 4), y = Math.round(cy - 4) - lift;
    ctx.fillStyle = '#0e1a12'; ctx.fillRect(x - 1, y - 1, 11, 8);   // dark outline
    ctx.fillStyle = '#2e6b40'; ctx.fillRect(x, y + 3, 9, 3);        // shaded front face
    ctx.fillStyle = '#3fa86a'; ctx.fillRect(x, y, 9, 3);            // lit green top
    ctx.fillStyle = '#7ee2a8'; ctx.fillRect(x, y, 9, 1);            // top sheen
    if (pop > 0.4) { const a = ctx.globalAlpha; ctx.globalAlpha = a * (pop - 0.4); ctx.fillStyle = '#c9ffe0'; ctx.fillRect(x, y, 9, 7); ctx.globalAlpha = a; }   // arrival glint
  }


  // E2 verification hooks (dev/test only): seed a run clock, force-age it past the TTL, or drive a reconcile with a
  // synthetic snapshot — so the paired-state TTL + reconnect reconciliation can be proven without a 5-minute wait or
  // the real /api/state/snapshot endpoint. Read-only paths (dbg()) already expose ttl counts.
  const _dbgSeedRun = (aid) => { if (!aid) return; runStartByAgent.set(aid, (typeof performance !== 'undefined') ? performance.now() : fnow); stampRun(aid); };
  const _dbgAgeRun = (aid, ms) => { const t = runLastSeenByAgent.get(aid); if (t != null) runLastSeenByAgent.set(aid, t - (+ms || 0)); const s = runStartByAgent.get(aid); if (s != null) runStartByAgent.set(aid, s - (+ms || 0)); const m = liveRunsByAgent.get(aid); if (m) for (const [rid, tt] of m) m.set(rid, tt - (+ms || 0)); };
  const _dbgReconcile = (snap) => { try { reconcileFromSnapshot(snap); } catch (_) {} };
  const _dbgSweep = () => { sweepStaleStates((typeof performance !== 'undefined') ? performance.now() : fnow); };   // drive the TTL sweep directly (rAF is throttled in a headless preview tab)
  // E1 verification: report the live link predicate, and force the real chanES closed (a genuine dropped socket)
  // so the DOWN branch can be observed against a real non-OPEN readyState without killing the whole process.
  const _dbgLinkState = () => ({ es: !!chanES, readyState: (chanES ? chanES.readyState : -1), lastEventMsAgo: (lastSseEventAt ? Math.round(((typeof performance !== 'undefined') ? performance.now() : fnow) - lastSseEventAt) : null), linkDown: linkDown((typeof performance !== 'undefined') ? performance.now() : fnow) });
  const _dbgDropBridge = () => { if (chanES) { try { chanES.close(); } catch (_) {} } return _dbgLinkState(); };
  // belt-legibility readout for CDP verify scripts: the EXACT state the renderer draws from (never a re-derivation)
  const _dbgBeltLegibility = () => ({
    beltCount: beltTileSet ? beltTileSet.size : 0,
    liveCount: beltLiveSet ? Object.keys(beltLiveSet).length : 0,
    liveKeys: beltLiveSet ? Object.keys(beltLiveSet).sort() : [],
    nags: routingNags ? routingNags.map(n => n.label) : [],
    feed: { known: feedState.known, fed: feedState.fed, nagOn: feedNagOn },
    ship: { known: shipStats.known, day: shipStats.day, done: shipStats.done },
    boxes: convey ? convey.peekBoxes() : [],   // the crates riding RIGHT NOW (id/tile/dir/payload)
    work: (() => { const o = {}; for (const [k, v] of runWork) o[k] = { tools: v.tools, dels: v.dels }; return o; })(),   // proven-work tally per in-flight run
    routeAt: (x, y) => routeTagFor(x, y),
    outboundAt: aid => outboundBeltTile(aid),   // where would this agent's product crate spawn (verify hook)
    sourceAt: aid => (routingPlan && typeof Pipeline !== 'undefined' && Pipeline.sourceFor) ? Pipeline.sourceFor(routingPlan, aid) : null,   // which INBOX would an addressed item enter through (verify hook)
    pollFeed: () => pollFeedState(),
    pollShip: () => pollShipStats()
  });
  return { init, rebake, crt: CRT, slagLog: () => (slaglog ? slaglog.recent() : []), loadStation, spawn, spawnAgent, despawnAgent, setSkin, relabel, setActivityFor, agentRunsLive, dropRun: noteRunEnd, focusBody, lockBody, cameraMode, setCinecamIdle, setChatFocus, chatFocusPing, start, stop, setActivity, wakeIn, beginAwakening, setWakeProgress, igniteSpark, armKindle, kindleHold, camPushIn, camCreep, camPunch, camPullBack, awakenTurn, truthPulse, beginFlood, collapseFlood, endAwakening, releaseAwakening, say, focusAgent, getActivity: () => activity, getUse: () => (agent ? agent.usingProp : null), setOnClick, setOnArcade, setOnOutbox, setOnMissionBoard, setOnTrophyCase, setOnBayAssign, setOnIntakeFeed, refit, pauseBridge, resumeBridge, linkState, _dbgSeedRun, _dbgAgeRun, _dbgReconcile, _dbgSweep, _dbgLinkState, _dbgDropBridge, _dbgBeltLegibility,
    // AGENT GROWTH: XpStore pushes pre-computed Xp.compute() snapshots here; pulseLevelUp fires
    // the addressed body's gold ring. The colony headline is the top-bar STATION chip.
    setXp: (agentId, a) => {
      if (a === undefined && (agentId == null || typeof agentId === 'object')) { a = agentId; agentId = agent && agent.id; }   // old one-arg shape
      const id = agentId || (agent && agent.id) || 'agent';
      if (a) xpByAgent.set(id, a); else xpByAgent.delete(id);
      xpAgent = agent ? (xpByAgent.get(agent.id) || null) : null;
    },
    pulseLevelUp: (agentId, level) => {
      if (level === undefined && typeof agentId === 'number') { level = agentId; agentId = agent && agent.id; }   // old one-arg shape
      const now = performance.now();   // one clock read so the ripple + caption share an origin
      const b = bodyForAgent(agentId || (agent && agent.id)) || (!agentId ? agent : null);
      if (!b) return;
      b.levelUpAt = now;
      if (b === agent) levelUpAt = now;
      // a brief "LEVEL N" caption rides the gold ripple — but never stomp a live, NON-EMPTY (real) message bubble
      if (level != null && !(b.say && b.say.text && b.say.until > now)) b.say = { text: 'LEVEL ' + level, until: now + 2600 };
    },
    // read-only introspection for live verification of idle behavior (no side effects)
    dbg: () => agent && { goal: agent.goal, quirkKind: agent.quirkKind, sitting: agent.sitting, state: agent.state, stilling: !!agent.stilling, firstWakeDone, wakePhase: agent.wakePhase, moving: !!agent.target, paused: fnow < (agent.pauseUntil || 0), pauseLook: agent.pauseLook, dir: agent.dir, attn: (agent.attn && fnow < agent.attn.until) ? { x: agent.attn.x, y: agent.attn.y, inMs: Math.round(agent.attn.until - fnow) } : null, drive: (fnow < (agent.driveUntil || 0)) ? agent.drive : null, tile: tileOf(agent.px, agent.py), idleUntil: Math.round((agent.idleUntil || 0) - fnow), quirkCd: Math.round(Math.max(0, (agent.quirkCd || 0) - fnow)), offbeatCd: Math.round(Math.max(0, (agent.offbeatCd || 0) - fnow)), fond: [...agent.fond.entries()], pendingMourn: pendingMourn && { tx: pendingMourn.tx, ty: pendingMourn.ty, fond: pendingMourn.fond }, decor: agentDecor.length, crew: crew.length, spendUsd: floor ? (floor.snapshot().spendUsd || 0) : 0, boxes: convey ? convey.boxCount() : 0, queueDepth: queueDepthNow(), bridge: { paused: bridgePaused, es: !!chanES, poll: !!connPollTimer, readyState: (chanES ? chanES.readyState : -1), lastEventMsAgo: (lastSseEventAt ? Math.round((typeof performance !== 'undefined' ? performance.now() : fnow) - lastSseEventAt) : null), linkDown: linkDown((typeof performance !== 'undefined') ? performance.now() : fnow) }, ttl: { runClocks: runStartByAgent.size, glyphs: glyphByAgent.size, serverLit: serverLit.size, runTtlMs: RUN_TTL_MS, awaitTtlMs: AWAIT_TTL_MS }, await: awaitPrompt ? { promptId: awaitPrompt.promptId, arrived: awaitArrived, source: awaitAnchor ? awaitAnchor.source : null, anchor: awaitAnchor ? { tx: awaitAnchor.tx, ty: awaitAnchor.ty } : null } : null, helpers: subLedger ? subLedger.count() : 0, proposalsPinned: pinnedCount, social: socialBeat && { kind: socialBeat.kind, aId: socialBeat.aId, bId: socialBeat.bId }, chase: chaseId != null && { id: chaseId, phase: (bodyForAgent(chaseId) && bodyForAgent(chaseId).chase && bodyForAgent(chaseId).chase.phase) || null }, chaseGateIn: Math.round(Math.max(0, chaseGateUntil - fnow)), cursorFresh: (fnow - lastCursor.t) < CURSOR_FRESH_MS, cursorMoving: (fnow - cursorMoveT) < CURSOR_MOVING_MS },
    // read-only camera truth for the DEV verify harness (+ the war-room HUD chip): who drives the camera
    // ('manual' | 'lock' = session follow | 'auto' = idle cinecam), which body is locked, and how long the
    // Commander has been hands-off. Pure read, no side effects — the testapi idiom.
    cameraDbg: () => ({ mode: cameraMode(), lockId: camLock ? camLock.id : null, source: camLock ? camLock.source : null, idleMs: Math.round(performance.now() - camUserAt), thresholdMs: cineIdleMs, scale: +scale.toFixed(3), panX: Math.round(panX), panY: Math.round(panY), gates: { anim: !!camAnim, frozen: awakeFrozen, cache: !!cache, reduceMotion: reduceMotion() } }),
    // TEST/DEBUG ONLY — the D3 border-meeting pure geometry (sharedEdge/borderTileFor), exposed read-only for the
    // DEV harness. No world state touched (both are pure; borderTileFor takes an injected walkable predicate).
    // The headless coverage lives in test/social-border.test.js (extracts the D3-PURE-GEOMETRY block from source).
    _dbgSocialGeom: { sharedEdge: (ra, rb) => sharedEdge(ra, rb), borderTileFor: (rect, edge, cur, walkableFn) => borderTileFor(rect, edge, cur, walkableFn) },
    // TEST/DEBUG ONLY — containment harness: raw-place a body (bypassing every walkable-checked picker)
    // so the per-tick containment backstop (containBody / hero ensureAgentValid) is provable live.
    _dbgTeleport: (aid, px, py) => { const b = bodyForAgent(aid); if (!b) return false; b.pathPts = null; b.target = null; b.sitting = false; b.seated = false; b.px = +px; b.py = +py; return true; },
    // read-only body snapshot for the DEV test harness (window.__SKYNET_TEST__) — the Tier A/B/C substrate.
    // Pure read, no side effects: the hero + every crew body, each with tile/zone/glance/goal/moving so the
    // floor invariants (idle stays in-zone · awareness is gaze-only · summoned walks to its OWN workstation)
    // can be auto-asserted instead of eyeballed. Mirrors dbg()'s clock (fnow) and helpers (tileOf/zoneFor).
    bodies: () => {
      const snap = (b, hero) => {
        if (!b) return null;
        const t = tileOf(b.px, b.py);
        const z = zoneFor(b);
        return {
          id: b.id, name: b.name, hero: !!hero,
          tile: t, px: Math.round(b.px), py: Math.round(b.py), dir: b.dir, state: b.state,
          goal: b.goal || null, moving: !!b.target, working: !!b.working, sitting: !!b.sitting,
          seated: !!b.seated, unplaced: !!b.unplaced, summoned: !!b.summoned,   // summoned = carries the idle inner life (roster bodies must, post-relaunch too)
          visTopPy: (b.visTopPy != null) ? Math.round(b.visTopPy) : null,       // drawn head-top (world px) — the overlay anchor drawBubble/drawNameplate use
          say: (b.say && b.say.text && b.say.until > fnow) ? b.say.text : null,
          target: b.target ? { tile: tileOf(b.target.x, b.target.y), x: Math.round(b.target.x), y: Math.round(b.target.y) } : null,
          glance: b.glance ? { dir: b.glance.dir, ms: Math.max(0, Math.round((b.glance.until || 0) - fnow)) } : null,
          zone: z, inOwnZone: tileInZone(z, t.x, t.y)
        };
      };
      return [snap(agent, true), ...crew.map((b) => snap(b, false))].filter(Boolean);
    },
    // does this agent have a WORKBENCH placed (-> shell.exec + verify.run)? An equipped BAY governs; with no bay
    // (simple single-agent floor) any placed workbench grants it. The run client sends this so the hero's run
    // gains shell ADDITIVELY on top of its default office (the room layout is the permission system, for the hero too).
    heroWorkbench: (agentId) => {
      if (!station) return false;
      const viaBay = (station.bayObjects && agentId) ? station.bayObjects(agentId) : [];
      if (viaBay && viaBay.length) return viaBay.indexOf('workbench') >= 0;
      return !!(station.propsByType && station.propsByType('workbench').length);
    },
    // THE MOAT (FLOOR-REAL): the agent's REAL placed capability set — the EARNED reach the run client sends so the
    // sidecar grants exactly what's on the floor (dish→web · cabinet→files · workbench→terminal · notebook→memory ·
    // studio→image · jukebox→spotify). COMPUTE is the harness FREEBIE (always granted to an interactive agent, so it
    // is never a dead wall) and CONNECTORS are account-level (added server-side), so both are excluded here — this is
    // purely the placed-on-top set. An equipped BAY governs; with no bay (the simple single-agent floor) every distinct
    // cap-prop placed anywhere is the hero's. Returns [{objectType}] room-object entries the sidecar appends as extras.
    // QUEST-LOG read: honest floor counts for the station-arc quests (belts laid, portals placed). A pure
    // projection of the live station doc — read-only, no caching, gates nothing.
    stationCounts: () => {
      if (!station || !station.doc) return { belts: 0, connectors: 0, liveRoute: 0 };
      const d = station.doc() || {};
      return {
        belts: d.belts ? Object.keys(d.belts).length : 0,
        connectors: d.props ? d.props.filter(p => p && p.t === 'connector_portal').length : 0,
        // tiles on a COMPLETE intake→bound-bay route (the same energized set the renderer draws) — the
        // st:belt quest completes on THIS, not on belts laid, so it can never reward a dead line.
        liveRoute: beltLiveSet ? Object.keys(beltLiveSet).length : 0
      };
    },
    // the live station document (read-only) — the station-quest generator reads props[] to detect the
    // OUTBOX / MISSION-BOARD standing gaps and to resolve a placement. Null when no station is loaded (headless).
    stationDoc: () => (station && station.doc ? station.doc() : null),
    // G1c — the live SlagLog ring (read-only): the most-recent wasted-spend post-mortems the floor has diagnosed.
    // The maintenance-quest generator (maintqueststore.js) tallies these by cause; a recurring cause mints a
    // fix-it quest. Returns a fresh copy (slaglog owns the ring); [] when the log isn't loaded (headless/title).
    slagPostmortems: () => { try { return (slaglog && slaglog.recent) ? slaglog.recent() : []; } catch (_) { return []; } },
    // DEV/proof read surface (pure, no side effects — the testapi idiom): where a placed prop of type `t`
    // sits ON SCREEN (CSS px), derived from the live camera + the local-frame geometry. Lets a headless
    // driver dispatch a REAL mouse click at the MISSION BOARD instead of faking the seam. Null when absent.
    propScreenRect: (t) => {
      if (!cv || !geo || !geo.props) return null;
      const p = geo.props.find(q => q.t === t);
      if (!p) return null;
      const r = cv.getBoundingClientRect();
      const kx = r.width / cv.width, ky = r.height / cv.height;
      const toScr = (wx, wy) => ({ x: r.left + (wx * scale + panX) * kx, y: r.top + (wy * scale + panY) * ky });
      const a = toScr(p.x * T, p.y * T), b = toScr((p.x + (p.w || 1)) * T, (p.y + (p.h || 1)) * T);
      return { left: a.x, top: a.y, right: b.x, bottom: b.y, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    },
    heroCaps: (agentId) => {
      if (!station) return [];
      const viaBay = (station.bayObjects && agentId) ? station.bayObjects(agentId) : [];
      const norm = o => (o && typeof o === 'object') ? o.objectType : o;   // bayObjects entries are strings or {objectType}
      const src = (viaBay && viaBay.length)
        ? viaBay.map(norm)
        : ((station.doc && station.doc().props) || []).map(p => (station.capForProp ? station.capForProp(p.t) : null));
      const out = [], seen = {};
      for (const cap of src) {
        if (!cap || cap === 'computer' || cap === 'connector') continue;   // compute = freebie; connectors = added server-side
        if (seen[cap]) continue; seen[cap] = true;
        out.push({ objectType: cap });
      }
      return out;
    },
    // STATION-WIDE gear (Class Loadouts shared-gear model): every capability objectType placed ANYWHERE on the
    // station, deduped — the shared gear any agent draws on under the overseer, regardless of whose desk it is in.
    // Used for SKILL availability only (a class's recipes need the station to have the gear, not the agent's own
    // room). Tool reach stays room-scoped via heroCaps. Returns [{objectType}] like heroCaps; [] on any hiccup.
    stationCaps: () => {
      if (!station) return [];
      const props = (station.doc && station.doc().props) || [];
      const out = [], seen = {};
      for (const p of props) {
        const cap = station.capForProp ? station.capForProp(p.t) : null;
        if (!cap || cap === 'computer' || cap === 'connector') continue;   // compute = freebie; connectors = server-side
        if (seen[cap]) continue; seen[cap] = true;
        out.push({ objectType: cap });
      }
      return out;
    }
  };
})();
