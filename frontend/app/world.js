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

  /* ---------- canvas + camera ---------- */
  let cv, ctx, raf = 0, last = 0, fnow = 0, running = false, ro = null, listenersBound = false;   // listenersBound: init() can run again per new agent — bind canvas/window/doc handlers + the SSE bridge ONCE
  // live-tunable CRT knobs — drawCRT/drawGlows read these every frame so the dev CRT LAB
  // (crtlab.js, dev-gated) can tune them live. These ARE the shipped defaults: bold scanlines,
  // fade off, faint lamp shimmer — the look dialed in and signed off via the lab (2026-06-30).
  const CRT = { scan: 0.43, pitch: 1, fade: 0.25, glow: 0.07, curve: 0.13 };
  let _warpCv = null, _warpCtx = null;   // the barrel-warp snapshot buffer — see drawCurve()
  let _lut = null, _lutKey = '', _outImg = null;   // CPU per-pixel barrel-warp inverse-map LUT + output buffer — see buildLUT()/drawCurveCPU()
  let _gl = null, _glc = null, _glProg = null, _glTex = null, _glKLoc = null, _glReady = false, _glFailed = false;   // GPU barrel-warp (WebGL) — see initGL()/drawCurveGL()
  let _scanCv = null, _scanKey = '';    // cached SOFT-scanline tile canvas (rebuilt only when scan/pitch/dpr change) — see scanCanvas()
  let scale = 2, panX = 0, panY = 0, fitNeeded = true;
  const MINZ = 0.5, MAXZ = 6;
  const clampz = (v, a, b) => v < a ? a : v > b ? b : v;
  let drag = null, hoverAgent = false, onClick = null, onArcade = null, onOutbox = null, onMissionBoard = null, onTrophyCase = null, wakeAt = 0;
  let camLerp = null;   // {scale,panX,panY} target — a gentle one-on-one framing for voice conversations
  let wakeDark = 0, wakeDarkTarget = 0, awakeFrozen = false;   // the AWAKENING: a darkness veil that lifts to first light, + a freeze so the newborn holds still during its first meeting
  let camAnim = null;                                          // {fromS,toS,fromX,toX,fromY,toY,t,dur,ease,onEnd} — a scripted awakening camera move
  let sparkAt = 0, bornAt = 0, dawnAt = 0, truthPulseAt = 0;   // ignition spark / color-into-being / dawn-bloom / per-truth-flare timestamps
  let floodAt = 0, floodEndAt = 0, floodStreams = null;        // THE FLOOD: screen-space data-cascade — start / collapse-trigger / seeded streams
  let firstWakeDone = false;                                   // FIRST LIGHT: once-per-page-life latch — the wake ritual fires at most once (a re-bake/refit never resets it)
  let kindleArmed = false, kindleP = 0, kindleHolding = false, kindlePeak = 0, kindleDone = null;   // THE KINDLING: the user HOLDS to wake the dormant mind; their attention fills kindleP (0..1) → ignition
  const stars = [];

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
  // B3 RESTRAINT-AT-SCALE: a single FLOOR-WIDE "a quirk just fired somewhere" timestamp. It is NOT cross-agent
  // awareness (no body perceives another — that is Tier C); it is a light rarity governor so a floor of N agents
  // doesn't burst into simultaneous quirks/stares. Only CREW quirk rolls are damped by it (the hero's roll stays
  // byte-identical → J1 parity); every quirk (hero or crew) arms it. lastQuirkAt is wall-clock-free (set from the
  // tick's `now`, which is U-driven), so it stays deterministic (J5).
  let lastQuirkAt = -1e9;
  const Q_PONDER = ['hm.', '...', 'i wonder', 'strange', 'thinking'];
  const Q_STARE = ['...', 'are you there?', 'hello.', 'still watching?', 'hm.'];   // mostly it just stares in silence
  const Q_LISTEN = ['did you hear that?', 'something moved', '...', 'who is there'];
  const Q_STARTLE = ['!', 'whoa', 'what was that', 'huh!', 'oh'];   // sudden change right beside it
  const SELF_PLACE = ['there', 'better', 'that belongs here', 'mine now', 'hm, nice'];   // after placing its own decor
  const SELF_ROUNDS = ['all in order', 'good', 'belt is humming', 'as it should be', 'checks out'];   // ownership beat on a caretaker lap
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
  const AGENT_DECOR = ['plant', 'coffee', 'cans', 'poster'];   // 1x1, blocks:false (never obstructs the agent or the Commander)
  const specOf = t => (typeof PropSprites !== 'undefined' && PropSprites.spec) ? PropSprites.spec(t) : null;
  const dirToward = (fx, fy, tx, ty) => (Math.abs(tx - fx) > Math.abs(ty - fy)) ? (tx > fx ? 'east' : 'west') : (ty > fy ? 'south' : 'north');

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
  const fwear = (x, y, w, h, n, c) => { if (w < 4 || h < 4) return; for (let i = 0; i < n; i++) { const hx = U.hash('w' + x + ',' + y + ',' + i); fpx(x + 1 + (hx % (w - 2)), y + 1 + ((hx >> 5) % (h - 2)), 1 + (hx % 2), 1, c); } };
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
    syncCrewFromPlan();            // reconcile the light crew bodies with the plan's bound bays
    if (agent) {
      if (agent.unplaced) placeAgent();
      else {
        if (oldOrigin) { const dx = (oldOrigin.tx - geo.origin.tx) * T, dy = (oldOrigin.ty - geo.origin.ty) * T; agent.px += dx; agent.py += dy; }
        agent.pathPts = null; agent.target = null;   // the in-flight path is in the OLD frame — re-path fresh
        if (agent.state === 'walk') { agent.state = 'idle'; agent.idleUntil = 0; }  // target's gone — never leave the agent stuck in the walk pose, or it moonwalks in place forever (tick's idle re-decision is gated on state!=='walk')
        if (agent.goal === 'use' || agent.goal === 'lounge' || agent.goal === 'inspect' || agent.goal === 'watch' || agent.goal === 'tend' || agent.goal === 'gaze' || agent.goal === 'quirk' || agent.goal === 'stare' || agent.goal === 'place' || agent.goal === 'rounds' || agent.goal === 'sleep' || agent.goal === 'mourn' || agent.goal === 'revisit' || agent.goal === 'firstwake') { releaseSeat(); agent.goal = null; agent.usingProp = null; agent.watchProp = null; agent.studyKey = null; agent.quirkKind = null; agent.placeTarget = null; agent.removeId = null; agent.roundsQueue = null; agent.wakePhase = 0; agent.glanceCd = 0; agent.sitting = false; }  // the prop/belt list may have changed — drop leisure/observation/quirk/placement/rounds/sleep/grief/wake-ritual, re-decide next idle tick (firstWakeDone stays latched, so the ritual never re-arms)
        if (agent.goal === 'work' && !agent.working) agent.goal = null;  // was mid-walk to the desk — drop it so tick's summon logic re-paths in the new frame
        if (agent.working && seat) { const f = footOf(seat.tx, seat.ty); agent.px = f.x; agent.py = f.y; agent.dir = deskFace || 'north'; }  // follow the desk (work only — a lounging agent must NOT teleport to the desk)
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
      desk = { tx: home.x, ty: home.y, w: home.w || 1, h: home.h || 1 }; seat = { tx: hs.tx, ty: hs.ty };
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
    seat = { tx: dtx, ty: Math.min(dty + 1, z.y2) };
    blocked.add(dtx + ',' + dty); blocked.add((dtx + 1) + ',' + dty);
  }
  // walk the hero to its work seat (or snap onto it if unreachable) + enter the 'work' goal — the shared "now sit
  // and work" step, reached EITHER straight from on-duty OR after the conveyor-fetch leg below.
  function goToSeat() {
    agent.goal = 'work';
    if (!seat || !setPathTo({ x: seat.tx, y: seat.ty })) {
      if (seat) { const f = footOf(seat.tx, seat.ty); agent.px = f.x; agent.py = f.y; agent.sitting = true; agent.working = true; agent.dir = deskFace || 'north'; }   // face the assigned desk (deskFace) when teleport-fallback seating
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

  function ensureAgentValid() {
    const cur = tileOf(agent.px, agent.py);
    if (geo.walkable(cur.x, cur.y, blocked)) return;
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
      phase: U.hash(a.id) % 6, target: null, pathPts: null, pathIdx: 0, idleUntil: 0, goal: null, say: { text: '', until: 0 },
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
    if (!stars.length) for (let i = 0; i < 90; i++) stars.push({ x: Math.random(), y: Math.random(), r: Math.random() < 0.85 ? 1 : 2, ph: Math.random() * 10 });
    resize();
    try { if (ro) ro.disconnect(); ro = new ResizeObserver(() => { resize(); fitNeeded = true; redrawNow(); }); ro.observe(cv.parentElement || cv); } catch (e) {}
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
      camLerp = null;   // the user is driving the camera — stop any in-progress focus ease
    }, { passive: false });
    cv.addEventListener('mousedown', ev => { if (kindleArmed) { kindleHolding = true; return; } camLerp = null; const c = toCanvas(ev); drag = { sx: c.x, sy: c.y, moved: false }; });
    cv.addEventListener('mousemove', ev => {
      if (drag) {
        const c = toCanvas(ev);
        panX += c.x - drag.sx; panY += c.y - drag.sy; drag.sx = c.x; drag.sy = c.y; drag.moved = true;
        cv.style.cursor = 'grabbing'; return;
      }
      const wp = toWorld(ev);
      lastCursor = { wx: wp.x, wy: wp.y, t: performance.now() };   // remember where you are — the agent's sense of your presence (feeds gaze)
      const hit = agentHit(wp);
      // rising edge: it notices the Commander's cursor land on it and turns to meet you
      if (hit && !hoverAgent && agent && activity === 'idle' && !agent.working) { setGlance('south', 900, performance.now()); curiositySay(SELF_ACK, 0.3, performance.now()); }
      if (hit !== hoverAgent) hoverAgent = hit;
      cv.style.cursor = (hit || arcadeAt(wp) || outboxAt(wp) || missionBoardAt(wp) || trophyCaseAt(wp)) ? 'pointer' : 'default';   // arcade cabinets + a stacked OUTBOX + the MISSION BOARD + the TROPHY CASE are clickable too
    });
    cv.addEventListener('mouseup', ev => {
      if (kindleArmed) { kindleHolding = false; return; }   // releasing during the kindle lets the spark ebb
      const wasDrag = drag && drag.moved; drag = null; cv.style.cursor = 'default';
      if (wasDrag) return;
      const wp = toWorld(ev);
      if (agentHit(wp)) {
        if (agent && activity !== 'task') { agent.dir = 'south'; setGlance('south', 1000, performance.now()); curiositySay(SELF_GREET, 0.8, performance.now()); }   // eye contact for the Commander
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
      if (tc && onTrophyCase) onTrophyCase(tc);
    });
    cv.addEventListener('mouseleave', () => { if (kindleArmed) kindleHolding = false; hoverAgent = false; if (!drag) cv.style.cursor = 'default'; });
    // you just came back to the tab → for a few seconds the agent is likelier to look up and notice you
    try { document.addEventListener('visibilitychange', () => { if (!document.hidden) userReturnUntil = performance.now() + 3000; }); } catch (e) {}
    connectChannelBridge();   // open the SSE bridge so real inbound work animates as boxes on the belts
  }

  function resize() {
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || cv.parentElement.clientWidth, h = cv.clientHeight || cv.parentElement.clientHeight;
    const nw = Math.max(1, Math.round(w * dpr)), nh = Math.max(1, Math.round(h * dpr));
    if (cv.width === nw && cv.height === nh) return;   // assigning to canvas.width/height WIPES the bitmap even when unchanged — skip the needless clear
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
  function setWakeProgress(p) { p = p < 0 ? 0 : p > 1 ? 1 : p; wakeDarkTarget = 0.92 * (1 - p); }
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
  function camCreep() { if (!cache || !agent || agent.unplaced || camAnim) return; const [s, x, y] = camCenterOn(agent.px, agent.py - 4, scale * 1.035); camTweenTo(s, x, y, 600); }   // a hair closer with each truth
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
  function fitCamera() {
    if (!cache) return;
    const W = cache.W, H = cache.H;
    scale = clampz(Math.min(cv.width / W, cv.height / H), MINZ, MAXZ);
    panX = (cv.width - W * scale) / 2; panY = (cv.height - H * scale) / 2;
  }
  function toCanvas(ev) {
    const r = cv.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (cv.width / r.width), y: (ev.clientY - r.top) * (cv.height / r.height) };
  }
  function toWorld(ev) { const c = toCanvas(ev); return { x: (c.x - panX) / scale, y: (c.y - panY) / scale }; }
  function agentHit(wp) {
    if (!agent || agent.unplaced) return false;
    const dx = wp.x - rposX(), dy = wp.y - rposY();
    return (dx * dx + dy * dy) < 14 * 14;
  }

  /* ---------- pathing + behaviour ---------- */
  function setPathTo(dest) {
    self.pathPts = null; self.target = null; self.glance = null;
    if (!dest || !geo) return false;
    const cur = tileOf(self.px, self.py);
    const blockers = movementBlockers(self, blocked);
    if (tileBlockedFor(blockers, dest.x, dest.y)) return false;
    const p = geo.path(cur.x, cur.y, dest.x, dest.y, blockers);
    if (!p) return false;
    self.pathPts = p; self.pathIdx = 0; self.state = 'walk';
    nextWaypoint();
    return true;
  }
  function nextWaypoint() {
    if (!self.pathPts || self.pathIdx >= self.pathPts.length) { self.target = null; return; }
    const wp = self.pathPts[self.pathIdx++];
    self.target = footOf(wp.x, wp.y);
    maybeStrollBeat();   // CONSIDERED MOVEMENT: a casual stroll occasionally hesitates / doubles back — not a sprite on rails
  }
  const OPP = { north: 'south', south: 'north', east: 'west', west: 'east' };
  // only while casually wandering (never a summon/goal walk): a brief considered pause, or the rare eerie double-take
  function maybeStrollBeat() {
    if (!self || self.goal != null || ((self === agent) && activity !== 'idle') || self.unplaced) return;
    const now = fnow;
    if (now < (self.pauseCd || 0)) return;
    // THE DOUBLE-TAKE (rare): stop and turn to look back the way it came, as if something caught its attention
    if (now >= (self.lookBackCd || 0) && U.chance(0.045 * (self.pers ? self.pers.curious : 1))) {
      self.pauseUntil = now + U.irnd(900, 1700); self.pauseLook = 'back';
      self.pauseCd = now + U.irnd(9000, 16000); self.lookBackCd = now + U.irnd(50000, 95000);
      curiositySay(['hm?', '...', 'did something move', 'thought i saw something'], 0.22, now);
      return;
    }
    // a considered pause mid-stroll: a beat of weight, then on it goes (rarer now — a stroll shouldn't be peppered with stutters)
    if (U.chance(0.07)) { self.pauseUntil = now + U.irnd(320, 720); self.pauseLook = null; self.pauseCd = now + U.irnd(10000, 18000); }
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
    const FOND = { lounge: 3, use: 2, gaze: 1.5, tend: 1.5, inspect: 1, watch: 1, rounds: 0.5, revisit: 0.6 };
    if (FOND[self.goal]) noteFond(now, FOND[self.goal]);   // dwelling somewhere by choice deepens attachment to that tile
    if (self.goal === 'work') { self.sitting = true; self.working = false; self.dir = deskFace || 'north'; self.state = 'idle'; self.settleUntil = now + U.irnd(450, 900); }   // sit a beat (loading context) before the screens light + typing starts
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
      // a stop on the caretaker lap — face it, a brief ownership beat, then tick advances to the next stop
      self.sitting = false; self.working = false; self.dir = self.useFace || 'south'; self.state = 'idle';
      self.glanceCd = 0; self.studyUntil = now + U.irnd(1500, 3000); curiositySay(SELF_ROUNDS, 0.4, now);
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
    else { self.state = 'idle'; self.idleUntil = now + U.irnd(1600, 3600); }
  }
  function wander(now) {
    const rects = geo.allRects;
    if (!rects.length) { self.idleUntil = now + 800; return; }
    const cur = tileOf(self.px, self.py);
    const avoid = beltUnion();   // desk footprint + belt tiles: an idle stroll should step AROUND the machinery
    const zone = zoneFor(self);   // P1: a stroll stays inside the body's own zone
    for (let i = 0; i < 24; i++) {
      const r = rects[U.irnd(0, rects.length - 1)];
      const x = U.irnd(r.x1, r.x2), y = U.irnd(r.y1, r.y2);
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

  /* desk footprint ∪ all belt tiles — the soft no-tread set for casual wandering */
  function beltUnion() {
    const s = new Set(blocked);
    const belts = (geo && geo.belts) || [];
    for (const b of belts) s.add(b.x + ',' + b.y);
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
    const foot = footOf(s.tx, s.ty);
    if (Math.hypot(foot.x - b.px, foot.y - b.py) < 1.1) {   // arrived → sit at the desk
      b.px = foot.x; b.py = foot.y; b.pathPts = null; b.target = null; b.state = 'idle'; b.sitting = true; b.dir = 'north';
      return;
    }
    if (!b.target) {   // plot a fresh path to the chair tile
      const cur = tileOf(b.px, b.py);
      const blockers = movementBlockers(b, blocked);
      if (tileBlockedFor(blockers, s.tx, s.ty)) { b.state = 'idle'; b.sitting = false; return; }
      const p = geo.path(cur.x, cur.y, s.tx, s.ty, blockers);
      if (p && p.length) { b.pathPts = p; b.pathIdx = 0; crewNextWaypoint(b); }
      else { b.px = foot.x; b.py = foot.y; b.sitting = true; b.dir = 'north'; b.state = 'idle'; return; }   // unreachable → snap into the seat
    }
    if (b.target) {
      const dx = b.target.x - b.px, dy = b.target.y - b.py, d = Math.hypot(dx, dy);
      if (d < 1.1) {
        b.px = b.target.x; b.py = b.target.y;
        if (b.pathPts && b.pathIdx < b.pathPts.length) crewNextWaypoint(b); else b.target = null;
      } else {
        const sp = Math.min(d, 28 * dt / 1000);
        b.px += dx / d * sp; b.py += dy / d * sp; b.state = 'walk'; b.sitting = false;
        b.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north');
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
    if (self.target) {
      if (now < (self.pauseUntil || 0)) {
        self.state = 'idle';                                // a deliberate hold mid-walk (maybeStrollBeat's considered pause / double-take)
        if (self.pauseLook === 'back') self.dir = OPP[self.dir] || self.dir;
      } else {
        const dx = self.target.x - self.px, dy = self.target.y - self.py, d = Math.hypot(dx, dy);
        if (d < 1.1) {
          self.px = self.target.x; self.py = self.target.y;
          if (self.pathPts && self.pathIdx < self.pathPts.length) nextWaypoint();
          else arrive(now);
        } else {
          const s = Math.min(d, SPEED * dt / 1000);
          self.px += dx / d * s; self.py += dy / d * s; self.state = 'walk';
          self.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north');
        }
      }
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
  function stepCrew(dt, now) {
    if (!geo || !crew.length) return;
    for (const b of crew) {
      if (b.unplaced) continue;
      if (b.working) {                                 // running → sit at its desk if it has one, else stand where work is delivered
        const dp = deskPropFor(b.agentId), s = dp ? deskSeat(dp) : null;
        if (s) stepCrewToSeat(b, s, dt, now);
        else { b.pathPts = null; b.target = null; b.state = 'idle'; b.sitting = false; }
        continue;                                      // J4: the working seize sits ABOVE the engine — a task always wins
      }
      if (!b.summoned) { b.sitting = false; continue; }   // bay-bound bodies stay where work is delivered (never seated when not working); only summoned workers get the inner life
      // PLACED + NON-WORKING + summoned → run the full sentience engine on THIS body, caged to its own zone.
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
    return a ? { tx: a.tx, ty: a.ty, face: a.face } : null;
  }

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
    if (room) { const inRoom = cands.find(p => roomOfLocalTile(p.x, p.y) === room); if (inRoom) return inRoom; }
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
  }

  /* v7 sit-ON-the-couch: a couch is a blocking prop (you can't path onto it), so the agent walks to
     a tile ADJACENT to a free cushion, then RENDERS on that cushion while the couch is y-sorted just
     behind it — exactly v7's sitTiles + sitPy trick. Seats are the inner footprint columns (an arm
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
  // flag is the module-scope `activity` (HERO-ONLY); crew busyness is per-body (b.working/b.workUntil), and only
  // SUMMONED crew have the inner life (stepCrew gates the engine on b.summoned). Reads only — mutates nothing.
  function bodyIsIdle(b, now) {
    if (!b || b.unplaced || b.state === 'walk' || b.working || b.goal != null) return false;
    if (agent && b === agent) return activity === 'idle';                 // hero: the single module-scope busy flag
    return !!b.summoned && b.workUntil <= now;                            // crew: only summoned bodies are alive; not mid-run
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

  // CURSOR GAZE-DRIFT: a slice of the ambient idle glances drift toward the Commander's cursor — the quiet
  // Petz "it knows where you are" (continuous tracking, NOT the rare dramatic look-up). Falls back to a
  // random cardinal when the cursor's gone quiet, so it never reads as locked-on.
  function ambientGazeDir(now) {
    if ((now - lastCursor.t) < 8000 && U.chance(0.32)) return dirToward(self.px, self.py, lastCursor.wx, lastCursor.wy);
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
  // OFF-BEAT HOLD: rarely (and on its own long cooldown) stretch a single dwell to ~2.2x-3.0x — a learned rhythm that
  // suddenly refuses to end. Skipped under reduceMotion so motion-sensitive users keep the normal cadence.
  function offbeat(now, ms) {
    if (reduceMotion()) return ms;
    if (now >= (self.offbeatCd || 0) && U.chance(0.09)) { self.offbeatCd = now + U.irnd(70000, 140000); return Math.round(ms * (220 + U.irnd(0, 80)) / 100); }   // J2: per-body off-beat gate — a crew dwell-stretch must NOT throttle hero/siblings (was the shared module global)
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
    // B3: the hero's probability is UNCHANGED (J1 byte-parity). For a crew body, if a quirk fired ANYWHERE on the
    // floor in the last ~8s, soften this roll so the floor doesn't quirk in unison — eerie restraint at scale (G3).
    // Not awareness: the body learns nothing about the other; it's a global rarity governor on the dice only.
    if (self !== agent && (now - lastQuirkAt) < 8000) p *= 0.35;
    if (!U.chance(p)) return false;
    self.quirkCd = now + U.irnd(45000, 90000);    // quirks stay special — even rarer now, so each lands with weight
    lastQuirkAt = now;                            // arm the floor-wide governor (hero or crew) so the NEXT crew quirk is damped if it clusters
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

  /* ---------- caretaker rounds: a deliberate 2-3 stop lap of the station, an ownership beat at each ---------- */
  function maybeRounds(now) {
    if (now < (self.roundsCd || 0) || !geo || typeof PropAnchor === 'undefined') return false;
    const zone = zoneFor(self);   // P1: a caretaker lap stays inside the zone (no straddling into the next room)
    const cur = tileOf(self.px, self.py), stops = [];
    for (const p of (geo.props || [])) { const s = specOf(p.t); if (s && s.blocks && mayTouchProp(self.id, p) && tileInZone(zone, p.x, p.y) && (Math.abs(p.x - cur.x) + Math.abs(p.y - cur.y)) <= 11) stops.push({ prop: p }); }   // no ownership beat at another body's (or unclaimed) workstation, and never out of zone
    const belts = (geo.belts || []).filter(b => tileInZone(zone, b.x, b.y)); if (belts.length) stops.push({ belt: belts[U.irnd(0, belts.length - 1)] });
    if (stops.length < 2) return false;
    for (let i = stops.length - 1; i > 0; i--) { const j = U.irnd(0, i), t = stops[i]; stops[i] = stops[j]; stops[j] = t; }   // shuffle
    const q = [];
    for (const st of stops.slice(0, U.irnd(2, 3))) {
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
      if (setPathTo({ x: s.tx, y: s.ty })) { self.goal = 'rounds'; self.useFace = s.face; if (!self.target) arrive(now); return true; }
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
    const f = favTile(); if (!f) return false;
    if (!tileInZone(zoneFor(self), f.x, f.y)) return false;   // P1: a remembered haunt outside the new zone isn't revisited (a zone change must not strand revisit — it just no-ops this beat)
    const cur = tileOf(self.px, self.py);
    if (cur.x === f.x && cur.y === f.y) { self.revisitCd = now + U.irnd(40000, 80000); return false; }
    if (!geo.walkable(f.x, f.y, blocked) || !setPathTo({ x: f.x, y: f.y })) return false;
    self.goal = 'revisit'; self.useFace = U.pick(['south', 'north', 'east', 'west']); self.usingProp = null; self.studyKey = null;
    self.revisitCd = now + U.irnd(60000, 120000);
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
    // The grief + novelty reflexes read the MODULE pendingMourn/novelty queues, which are the HERO's awareness
    // (scanNovelty/maybeMourn only run for the hero). A crew body must NOT consume the hero's queue (J2) — gate
    // both reflexes to self===agent so only the hero acts on them. Crew get their idle life from the want-engine below.
    if (self === agent) {
      if (pendingMourn && planMourn(now)) return;      // grief reflex: a beloved spot was just emptied — go stand where it was
      if (novelty.length && planInspect(now)) return;  // curiosity reflex: a fresh placement always wins
    }
    if (maybeQuirk(now)) return;                       // rare unpredictable detour — the eerie inner life surfacing
    // AUTONOMOUS PROP PLACEMENT — REMOVED (Thronglet direction). The agent no longer drops
    // plant/coffee/cans/poster on random floor tiles (it read as nonsensical clutter). It still
    // USES the Commander's placed props (couch/TV/arcade) via planProp below — that stays.
    const n = self.needs, p = self.pers, ph = phaseOf(now), idleAge = now - (self.lastTaskAt || now);
    if (ph.tag === 'drift' && idleAge > 45000 && n.rest > 50 && U.chance(0.22) && sleep(now)) return;   // deep downtime in the wind-down mood -> power down where it stands
    const wRest = (100 - n.rest) * (0.7 + 0.6 * p.homebody) * ph.rest;
    const wStim = ((100 - n.stim) * (0.7 + 0.6 * p.curious) + Math.min(35, idleAge / 4500) * p.restless) * ph.stim;   // boredom climbs with downtime
    const wSoc = (100 - n.social) * ph.soc;
    const top = Math.max(wRest, wStim, wSoc);
    if (top < 28) {                                                                    // content -> mostly STILL (the eerie calm); the old 100%-motion calm read as restless
      if (maybeMutualGlance(now)) return;  // C-Beat2: a quiet noticing between two idle neighbors — gaze-only; maybeMutualGlance holds self.idleUntil past its own glance so the beat stays two-sided, then ends by timeout
      if (U.chance(0.10) && maybeRevisit(now)) return;                                 //   occasionally drift back to its favorite spot
      const r = U.irnd(0, 99);
      if (r < 62) standStill(now);                                                      //   62% just stand and be here
      else if (r < 84) lookAround(now);                                                 //   22% a slow look around
      else wander(now);                                                                 //   16% a short stroll
      return;
    }
    if (top === wRest) { if (planProp(now)) return; }                                  // tired -> lounge / couch
    else if (top === wSoc) { if (planSeekDesk(now)) return; }                          // lonely -> the desk, face the Commander
    else {                                                                             // bored / restless
      if (U.chance(0.3) && maybeRounds(now)) return;                                    //   do a deliberate caretaker lap (purpose, not aimless)
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
    tickNeeds(dt);                                                 // the inner meters drain/refill by what it is doing
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
      if (agent.goal !== 'summon' && agent.goal !== 'fetch') { releaseSeat(); agent.goal = 'summon'; agent.sitting = false; agent.working = false; agent.stilling = false; agent.usingProp = null; agent.watchProp = null; agent.target = null; agent.pathPts = null; agent.pauseUntil = 0; agent.pauseLook = null; agent.state = 'idle'; agent.dir = 'north'; agent.thinkUntil = now + U.irnd(400, 1200); curiositySay(SELF_ONDUTY, 0.9, now); }
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
        if (d < 1.1) {
          agent.px = agent.target.x; agent.py = agent.target.y;
          if (agent.pathPts && agent.pathIdx < agent.pathPts.length) nextWaypoint();
          else arrive(now);
        } else {
          const s = Math.min(d, SPEED * dt / 1000);
          agent.px += dx / d * s; agent.py += dy / d * s; agent.state = 'walk';
          agent.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north');
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
    } else if (agent.goal === 'inspect' || agent.goal === 'watch' || agent.goal === 'tend' || agent.goal === 'gaze' || agent.goal === 'quirk' || agent.goal === 'stare' || agent.goal === 'mourn' || agent.goal === 'revisit') {
      // observing / tending / gazing / a quirk / the long stare / grief / a haunt revisit: hold until the dwell ends (maybeGlance animates it), then re-decide
      if (now >= agent.studyUntil) {
        const back = (agent.goal === 'inspect' || agent.goal === 'watch') ? agent.useFace : null;   // a glance back at what it studied as it turns away
        agent.goal = null; agent.usingProp = null; agent.studyKey = null; agent.quirkKind = null; agent.state = 'idle'; agent.idleUntil = now + U.irnd(1400, 3000);
        if (back && U.chance(0.5)) setGlance(back, U.irnd(500, 900), now);
      }
    } else if (agent.goal === 'firstwake') {
      stepFirstWake(now);   // FIRST LIGHT ritual sequencer (sits BELOW the summon-seize block, so a summon always wins)
    } else if (activity === 'idle' && agent.state !== 'walk' && !agent.sitting && now >= agent.idleUntil) {
      decideIdle(now);
    }
  }

  /* ---------- render ---------- */
  function frame(now) {
    const dt = Math.min(64, now - last); last = now; fnow = now;
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
    ctx.fillStyle = '#040302'; ctx.fillRect(0, 0, cv.width, cv.height);
    for (const s of stars) {
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(now / (900 + s.ph * 300) + s.ph));
      ctx.fillStyle = 'rgba(180,200,230,' + tw + ')';
      ctx.fillRect((s.x * cv.width + now / 1000 * 8) % cv.width, s.y * cv.height, s.r, s.r);
    }

    if (!cache) { if (running) raf = requestAnimationFrame(frame); return; }
    if (fitNeeded && !camAnim) { fitCamera(); fitNeeded = false; }   // the scripted awakening camera owns the transform while it runs
    if (camLerp && !camAnim) {   // gently ease toward a conversation framing (set by focusAgent); the awakening camera wins
      const k = 0.16;
      scale += (camLerp.scale - scale) * k; panX += (camLerp.panX - panX) * k; panY += (camLerp.panY - panY) * k;
      if (Math.abs(camLerp.scale - scale) < 0.01 && Math.abs(camLerp.panX - panX) < 1 && Math.abs(camLerp.panY - panY) < 1) {
        scale = camLerp.scale; panX = camLerp.panX; panY = camLerp.panY; camLerp = null;
      }
    }
    ctx.setTransform(scale, 0, 0, scale, panX, panY); ctx.imageSmoothingEnabled = false;

    ctx.drawImage(cache.baseCv, 0, 0);

    // conveyor belts (floor machinery) + the live transport sim — local frame, under entities
    if (geo && geo.belts && typeof Conveyor !== 'undefined') {
      if (!convey) convey = Conveyor.create({ onDeliver: onWorkitemDeliver });
      convey.tick(dt, now, geo.belts, junctions);
      convey.drawBelts(ctx, now, T, geo.belts);
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
        // a couch with a seated agent sorts JUST BEHIND the sitter, so the agent renders ON it (v7's sitPy trick)
        const sy = (agent && agent.seated && agent.usingProp === p.id) ? agent.seatPy - 1 : (p.y + (p.h || 1)) * T;
        items.push({ y: sy, draw: () => PropSprites.draw(p, work, live) });
        // an ASSIGNED workstation is the hero's desk with another name: give it the same chair, in front,
        // y-sorted exactly like the hero's (one row below the desk) so its agent reads as sitting IN it. Scoped
        // to assigned PCs so a decorative/unmanned console keeps its existing look and the chair only ever
        // appears where an agent will actually sit (chair + sitter stay in lockstep — see stepCrewToSeat).
        if (p.agentId && isWorkstationProp(p.t)) { const s = deskSeat(p); if (s) items.push({ y: (s.ty + 1) * T, draw: () => drawSeatChair(s.tx, s.ty) }); }
      }
    }
    // one chair art everywhere: seats route through the canonical prop renderer (old F_chair = fallback)
    function drawSeatChair(tx, ty) {
      if (typeof PropSprites !== 'undefined' && PropSprites.has('chair')) {
        PropSprites.setCtx(ctx); PropSprites.setNow(now);
        PropSprites.draw({ t: 'chair', x: tx, y: ty, w: 1, h: 1 }, false);
      } else F_chair(tx * T, ty * T);
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
    if (seat && !deskPropId) items.push({ y: (seat.ty + 1) * T, draw: () => drawSeatChair(seat.tx, seat.ty) });   // a PLACED hero desk's chair is drawn by the workstation loop above; draw here only for the synthetic auto-desk
    if (agent && !agent.unplaced) items.push({ y: rposY(), draw: () => drawAgent(now) });
    for (const b of crew) items.push({ y: b.py, draw: () => drawAgent(now, b) });   // the other agents, at their bays
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
    if (convey) convey.drawBoxes(ctx, now, T);   // boxes ride on top of the belts
    drawHandoffBoxes(now);   // Stage 2: lead→worker delegation boxes fly over the entities
    drawMeeseeks(now);   // G4.3: the ephemeral sub-agent helper sprites clustered near the lead's desk (over the entities)
    drawQueueJam(now);   // the live backlog as a physical jam of waiting crates at the INTAKE (world-space, under the lightmap)

    ctx.drawImage(cache.lightCv, 0, 0);
    drawGlows(now);
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
    drawPinFlourish(now); // G4.2: the amber pin-burst at the board the instant a proposal is pinned
    if (agent && !agent.unplaced) drawBubble(now);
    for (const b of crew) drawBubble(now, b);   // crew speech bubbles (e.g. "received: …" when work routes to them)
    if (agent && !agent.unplaced && hoverAgent) drawNameplate(now);
    drawQueueDepth();   // screen-space backpressure gauge (resets transform; drawn last)
    drawFloorStats(now);   // screen-space factory-floor economy readout (spend / yield / slag / cache)
    // (station growth headline now lives in the top bar's STATION chip — see xpstore.pushTopbar)
    drawCurve(now); // barrel-warp the whole feed IN-CANVAS — the original (dot-matrix-era) curve, no dots
    drawCRT(now);   // scanlines + fade, painted in-canvas at device-px OVER the warped feed (no moiré)

    if (running) raf = requestAnimationFrame(frame);
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
    ctx.globalCompositeOperation = 'source-over';
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
      const fs = 'precision highp float; varying vec2 vUv; uniform sampler2D uTex; uniform float uK;\n' +
        'void main(){\n' +
        '  vec2 n = (vUv-0.5)*2.0; float ro = length(n); float rs = ro;\n' +
        '  for(int i=0;i<6;i++){ float g = rs*(1.0-uK*rs*rs)-ro; float dg = 1.0-3.0*uK*rs*rs; rs = rs - g/dg; }\n' +
        '  float scale = ro>1e-5 ? rs/ro : 1.0; vec2 sUv = n*scale*0.5+0.5;\n' +
        '  if(sUv.x<0.0||sUv.x>1.0||sUv.y<0.0||sUv.y>1.0){ gl_FragColor = vec4(0.0,0.0,0.0,1.0); return; }\n' +
        '  vec3 col = texture2D(uTex, sUv).rgb; float vig = clamp(1.0-0.55*ro*ro, 0.0, 1.0);\n' +
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
      _glKLoc = gl.getUniformLocation(prog, 'uK'); _glProg = prog; _glReady = true;
      return true;
    } catch (e) { console.warn('[crt] WebGL curve unavailable, using CPU fallback:', e && e.message); _glFailed = true; _gl = null; return false; }
  }
  function drawCurveGL(k, W, H) {
    try {
      if (!initGL(W, H)) return false;
      const gl = _gl;
      if (_glc.width !== W || _glc.height !== H) { _glc.width = W; _glc.height = H; }
      gl.viewport(0, 0, W, H);
      gl.bindTexture(gl.TEXTURE_2D, _glTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);   // upload the composited frame
      gl.uniform1f(_glKLoc, k);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, W, H); ctx.drawImage(_glc, 0, 0);   // blit the warped result back onto the visible feed
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
      // the LEVEL-UP pulse: the same sonar ring as waking, but GOLD, fired on this body's level gain.
      const lva = (who && who.levelUpAt) || ((who === agent) ? levelUpAt : 0);
      if (lva && now - lva < 1500) {
        ctx.save(); ctx.strokeStyle = '#ffd45a';
        for (let k = 0; k < 3; k++) {
          const tk = (now - lva) / 1300 - k * 0.18;
          if (tk <= 0 || tk >= 1) continue;
          ctx.globalAlpha = (1 - tk) * 0.7 * (1 - k * 0.2); ctx.lineWidth = Math.max(0.5, 1.6 - tk);
          ctx.beginPath(); ctx.ellipse(who.px, who.py, 5 + tk * 26, 2.5 + tk * 11, 0, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.restore();
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
  function drawNameplate(now) {
    if (!cache) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false;
    const Wc = cv.width / dpr, Hc = cv.height / dpr;
    const suit = agent.color || '#ffaa33';
    const name = String(agent.name || '');
    const xp = (agent && xpByAgent.get(agent.id)) || xpAgent;
    const lvl = (xp && xp.level) ? ('Lv ' + xp.level) : null;
    const frac = (xp && typeof xp.frac === 'number') ? Math.max(0, Math.min(1, xp.frac)) : 0;

    const nameSz = 17, lvlSz = 16;
    ctx.font = nameSz + 'px ' + PLATE_FONT; const nameW = ctx.measureText(name).width;
    ctx.font = lvlSz + 'px ' + PLATE_FONT;  const lvlW = lvl ? ctx.measureText(lvl).width : 0;
    const padX = 8, gap = lvl ? 9 : 0, h = 21, barH = 2;
    const w = Math.round(padX * 2 + nameW + gap + lvlW);

    // anchor centered just above the head, crisp + clamped to the canvas
    const ax = (rposX() * scale + panX) / dpr, ay = (rposY() * scale + panY) / dpr;
    const spriteH = 15 * scale / dpr;
    const x = Math.round(Math.max(4, Math.min(Wc - w - 4, ax - w / 2)));
    const y = Math.round(Math.max(4, Math.min(Hc - h - 4, ay - spriteH - 9 - h)));

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
      ctx.font = lvlSz + 'px ' + PLATE_FONT; ctx.fillStyle = suit; ctx.fillText(lvl, x + padX + nameW + gap, tcy);
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

  function drawBubble(now, who) {
    who = who || agent;
    const s = who.say;
    // keep the HERO's caption up while it's still SPEAKING (a streamed neural reply can outlast the bubble's
    // fixed timer) — so the on-screen line and the voice stay in phase. Crew bodies just follow the timer.
    const speakingNow = (who === agent) && typeof Voice !== 'undefined' && Voice.isSpeaking && Voice.isSpeaking();
    if (!s.text || (s.until < now && !speakingNow)) return;
    ctx.font = '8px monospace';
    const maxW = 96, padb = 3, lh = 9;
    const words = s.text.split(' '), lines = []; let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; if (lines.length >= 3) break; } else line = test;
    }
    if (line && lines.length < 3) lines.push(line);
    if (lines.length === 3) lines[2] = lines[2].replace(/.{0,2}$/, '…');
    const bw = Math.min(maxW, Math.max(...lines.map(l => ctx.measureText(l).width))) + padb * 2;
    const bh = lines.length * lh + padb * 2;
    const rx = who.seated ? who.seatPx : who.px, ry = who.seated ? who.seatPy : who.py;
    let bx = Math.round(rx - bw / 2); const by = Math.round(ry - 22 - bh);
    bx = Math.max(2, Math.min((cache ? cache.W : 9999) - bw - 2, bx));
    ctx.fillStyle = 'rgba(3,2,1,0.92)'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#ffaa33'; ctx.lineWidth = 1; ctx.strokeRect(bx + .5, by + .5, bw - 1, bh - 1);
    ctx.fillStyle = '#ffaa33'; ctx.fillRect(Math.round(rx) - 1, by + bh, 3, 2);
    ctx.fillStyle = '#ffd9a3'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';   // own our baseline — never inherit a stray one (the line-y math assumes alphabetic)
    lines.forEach((l, i) => ctx.fillText(l, bx + padb, by + padb + lh * (i + 1) - 2));
  }

  function setOnClick(fn) { onClick = fn; }
  function setOnArcade(fn) { onArcade = fn; }
  function setOnOutbox(fn) { onOutbox = fn; }
  function setOnMissionBoard(fn) { onMissionBoard = fn; }   // G1b: click a placed MISSION BOARD → open the quest log
  function setOnTrophyCase(fn) { onTrophyCase = fn; }   // G3b: click a placed TROPHY CASE → open the trophy surface
  // G2.3 — the live uncollected-crate count (ReturnStore's pending ledger). Read per-frame for the
  // OUTBOX sprite stack and by the hit-test below; 0 when the store isn't loaded (headless tests).
  function returnCrates() {
    try { return (typeof ReturnStore !== 'undefined' && ReturnStore.pendingCount) ? (ReturnStore.pendingCount() | 0) : 0; } catch (_) { return 0; }
  }
  // hit-test: the OUTBOX chute under a world-space point — clickable ONLY while crates are stacked
  // (an empty chute keeps plain floor behavior; no dead affordance). The stack climbs above the
  // footprint, so extend the box up so the crates themselves are clickable too.
  function outboxAt(wp) {
    if (!geo || !geo.props || returnCrates() <= 0) return null;
    for (const p of geo.props) {
      if (p.t !== 'outbox') continue;
      const x0 = p.x * T, y0 = p.y * T - 34;
      const x1 = (p.x + (p.w || 1)) * T, y1 = (p.y + (p.h || 1)) * T + 4;
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
  let chanES = null, connPollTimer = null, connPollFn = null, connOpenFn = null, bridgePaused = false;
  function pauseBridge() {
    bridgePaused = true;
    if (connPollTimer) { clearInterval(connPollTimer); connPollTimer = null; }
    if (chanES) { try { chanES.close(); } catch (_) {} chanES = null; }
  }
  function resumeBridge() {
    if (!bridged) return;                 // never set up yet (no agent has entered) — connectChannelBridge will open it
    bridgePaused = false;
    if (!connPollTimer && connPollFn) { connPollFn(); connPollTimer = setInterval(connPollFn, 5000); }
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
    // B5: enrich each bay with the capability objectTypes in its room, so the sidecar can isolate that agent's
    // tools to exactly what the floor placed there (the bay->agent binding decides WHO; the room decides WHAT).
    if (routingPlan && routingPlan.bays && station && typeof station.bayObjects === 'function') {
      for (const b of routingPlan.bays) b.objects = station.bayObjects(b.agentId);
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
    try { fetch('/api/routing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan || {}) }).catch(() => {}); } catch (_) {}
  }
  // junction props (splitter/filter/merger) keyed by tile — derived from the compiled plan so the VISUAL engine
  // animates filters + mergers (not just splitters) using the SAME config the dispatch router routes by.
  function buildJunctions() {
    if (routingPlan && routingPlan.junctions) {
      let j = null;
      for (const k in routingPlan.junctions) (j = j || new Map()).set(k, routingPlan.junctions[k]);
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
    const t = intakeTile();
    // tag the box with its content kind (the same getTag the sidecar routes by) so a FILTER sorts it visibly
    const p = payload || {};
    if (!p.tag && typeof Classify !== 'undefined' && Classify.getTag) p.tag = Classify.getTag(p.preview || p.text || '');
    // ride inbound work as ORE — a UNIFORM raw chunk: every incoming request is one identical piece of raw
    // material on the line. We deliberately DON'T size it; product-vs-slag is the rewarded signal,
    // bound to real outcomes, never to this inbound request. (WIRING_AUDIT P4: lie #5.)
    p.box = 'ore';
    if (p.weight == null) p.weight = 0.3;
    if (t) convey.enqueueAt(t.x, t.y, p);
    // ANTICIPATE: an idle agent senses work on the line and perks up toward the dock before any summon lands
    if (agent && !agent.unplaced && activity === 'idle' && !agent.working) {
      const intake = geo && geo.props && geo.props.find(q => q.t === 'intake');
      if (intake) setGlance(dirToward(agent.px, agent.py, (intake.x + 0.5) * T, (intake.y + 0.5) * T), 1100, fnow);
      curiositySay(['incoming?', 'work inbound', 'something is coming', 'heads up'], 0.6, fnow);
      if (agent.goal == null) agent.idleUntil = Math.min(agent.idleUntil || 0, fnow + 200);
    }
  }
  // a belt tile to ship an outbound box from — beside the PRODUCING agent's own bay, not always the hero's.
  // The hero ships from its desk (byte-identical); a crew/summoned agent ships from a belt tile beside ITS
  // body; an unknown agent falls back to the hero desk. (WIRING_AUDIT P3: kill the single-hero-desk assumption.)
  function outboundBeltTile(aid) {
    if (aid && agent && aid !== agent.id) {
      const b = bodyForAgent(aid);
      if (b && b !== agent) { const tt = tileOf(b.px, b.py); return beltTileNear(tt.x, tt.y, 1, 1); }
    }
    return desk ? beltTileNear(desk.tx, desk.ty, desk.w, desk.h) : null;
  }
  // the agent's reply heads out — enqueue an OUTBOUND box at a belt tile beside the PRODUCING agent's bay
  function outboundMessage(payload) {
    if (!convey) return;
    const t = outboundBeltTile(payload && payload.agentId);
    // the reply rode out and was actually sent (workitem.delivered fires only after a successful send),
    // so this box is a banked PRODUCT (green). Failed/superseded runs emit none.
    const w = 0.3;
    if (t) convey.enqueueAt(t.x, t.y, { outbound: true, box: 'product', weight: w, workitemId: (payload && payload.workitemId) || '' });
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
      phase: U.hash('' + aid) % 6, target: null, pathPts: null, pathIdx: 0, idleUntil: 0, goal: null, say: { text: '', until: 0 },
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
    if (!routingPlan || !routingPlan.bays || !routingPlan.bays.length || !geo) { crew = crew.filter(b => b.summoned); return; }
    const want = new Map();
    for (const bay of routingPlan.bays) {
      if (agent && bay.agentId === agent.id) continue;                 // the hero already represents its own bay
      const p = geo.props && geo.props.find(pp => pp.id === bay.propId);
      if (!p) continue;
      const fx = (p.x + (p.w > 1 ? 1 : 0)) * T + T / 2;                // foot at the bay's bottom-centre — stepCrew walks it to its desk's chair when working
      const fy = (p.y + (p.h || 1) - 1) * T + T - 1;
      want.set(bay.agentId, { x: fx, y: fy });
    }
    crew = crew.filter(b => b.summoned || want.has(b.agentId));        // drop plan bodies whose bay is gone; KEEP summoned crew
    for (const [aid, pos] of want) {
      const b = crew.find(x => x.agentId === aid && !x.summoned);
      if (b) { b.px = pos.x; b.py = pos.y; }
      else if (!crew.some(x => x.agentId === aid)) crew.push(makeCrewBody(aid, aid, crewColor(aid), pos.x, pos.y));
    }
    // a refit may have moved the floor under a summoned body — re-foot any that no longer stand on a walkable tile.
    for (const b of crew) {
      if (!b.summoned) continue;
      const t = tileOf(b.px, b.py);
      if (!geo.walkable(t.x, t.y, blocked)) { const f = workerFoot(); b.px = f.x; b.py = f.y; b.home = tileOf(f.x, f.y); }   // re-foot AND re-pin the leash home: the spawn spot genuinely moved (A2 stays centred on the new home)
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
    if (crew.some(b => b.agentId === a.id)) return;                       // already present
    const f = geo ? workerFoot() : { x: 0, y: 0 };                        // pre-geo: parked at origin, re-footed on first syncCrewFromPlan
    const b = makeCrewBody(a.id, a.name || a.id, a.color || crewColor(a.id), f.x, f.y, a.skin);
    b.summoned = true; b.wakeAt = fnow;                                   // a small materialize ripple
    b.idleUntil = fnow + U.irnd(1400, 3200);                              // hold a beat after materializing, then it strolls
    crew.push(b);
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
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
      const tag = (trig === 'schedule') ? ' · ROUTINE' : (trig === 'event') ? ' · EVENT' : '';
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
      if (isFinite(usd) && usd > 0) line += ' · $' + (Math.round(usd * 100) / 100).toFixed(2);
      pushTicker(line, '', tickerSuit(p.agentId));
    });
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
    U.bus.on('workitem.delivered', p => outboundMessage(p));
    U.bus.on('workitem.superseded', p => { if (p && p.workitemId && convey) convey.dropWorkitem(p.workitemId); });
    // queue.status drives BOTH the numeric backpressure gauge (chanQueues) and the FloorStats backlog fold.
    U.bus.on('queue.status', p => { if (p && p.queueId != null) chanQueues.set(p.queueId, Math.max(0, p.depth | 0)); if (floor) floor.onEvent('queue.status', p); });
    // THE FLOOR ECONOMY — fold the harness's real cost/outcome events into the at-a-glance floor HUD
    // (drawFloorStats). harness.js re-emits every sidecar event onto U.bus, and routed/crew runs arrive
    // the same way over the SSE bridge, so these tally the WHOLE station's spend->yield, not just the hero.
    if (!floor && typeof FloorStats !== 'undefined') floor = FloorStats.create();
    if (!slaglog && typeof SlagLog !== 'undefined') slaglog = SlagLog.create();
    U.bus.on('agent.cost', p => {
      if (floor) floor.onEvent('agent.cost', p, Date.now());
      // remember the most recent RECONCILED cache ratio — the smelter temperature a slag diagnosis reads
      if (p && (p.tokensIn | 0) > 0) lastCacheFrac = Math.max(0, Math.min(1, (p.cachedTokens || 0) / p.tokensIn));
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
      // A clean finish is shown by a product crate; crate mass is intentionally fixed in the UI.
      if (r !== 'max_iters' && r !== 'budget' && r !== 'error' && r !== 'refusal') return;
      // UNPRODUCTIVE RUN: pulse the SLAG cell, then turn the failed outcome into a lesson — a real post-mortem in the
      // notifications panel + a red-hot slag crate that rides off the line (if a desk belt exists). The
      // lesson lands regardless of belts; the belt only shows it.
      lastSlagAt = performance.now();
      if (!slaglog) return;
      const diag = slaglog.record(r, { cacheFrac: lastCacheFrac, turns: p && p.turns, usd: p && p.usd });
      if (typeof StationUI !== 'undefined' && StationUI.notify) {
        const clean = s => String(s || '').replace(/\bspend\b/ig, 'run resources').replace(/\bdollars?\b/ig, 'limits');
        StationUI.notify('⚠ SLAG · ' + clean(SlagLog.line(diag)), 'warn');
      }
      enqueueSlag(diag, p && p.agentId);
    });
    // Stage 2: WATCH the lead delegate. A team.dispatch tool call opens a delegation window (until its tool_result);
    // any WORKER run that starts inside it flies a box lead→worker + lights the worker. Contract-free — rides the
    // existing agent.tool_call / agent.run.* events (the delegated child's lifecycle is forwarded onto the lead's stream).
    U.bus.on('agent.tool_call', p => { if (p && /^team[._]dispatch$/.test(p.name || '')) { delegateLead = p.agentId; delegateCall = p.callId; } });
    U.bus.on('agent.tool_result', p => { if (p && p.callId && p.callId === delegateCall) { delegateLead = null; delegateCall = null; } });
    U.bus.on('agent.run.start', p => { if (p && delegateLead) { const b = bodyForAgent(p.agentId); if (b && b !== agent) handoff(delegateLead, p.agentId, 'spawned'); } });
    U.bus.on('agent.run.end', p => { if (p) { const b = bodyForAgent(p.agentId); if (b && b !== agent) handoff(null, p.agentId, 'done'); } });
    // AUTONOMOUS WORK (cron / channel): a server-initiated run has no in-app chat driving its body, so bind its
    // run lifecycle to the work pose HERE — the agent goes to its workstation and works for the run's REAL
    // duration, then stands when it ends. This is what makes a scheduled routine VISIBLE: the conveyor box rides
    // in (kind 'cron'/'telegram') AND the agent actually runs to its PC and types until done. Interactive chat
    // (trigger 'directive') drives its own body via chat.js and is excluded; a delegated worker (also 'directive')
    // is handled by the handoff bindings above — so this never double-drives a body.
    U.bus.on('agent.run.start', p => { if (p && p.agentId && (p.trigger === 'schedule' || p.trigger === 'event')) { serverLit.add(p.agentId); if (agent && p.agentId === agent.id) agent.taskViaConveyor = true; setActivityFor(p.agentId, 'task'); } });
    U.bus.on('agent.run.end', p => { if (p && p.agentId && serverLit.has(p.agentId)) { serverLit.delete(p.agentId); setActivityFor(p.agentId, 'idle'); } });
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
      hudNote('📡 message received — ' + String((p && p.channel) || 'channel').toUpperCase(), 'good');
    });
    // G0.5 BUDGET MADE VISIBLE: budget.threshold was alarm-audio only. The payload is the frozen
    // { scope: run|day|global, usd, cap } triple (sidecar/budget.js, one emit per scope+band crossing
    // per run) — the band isn't carried, so derive it from the numbers: at/over cap = stopped.
    U.bus.on('budget.threshold', p => {
      if (!p || !isFinite(+p.usd) || !isFinite(+p.cap) || +p.cap <= 0) return;
      const usd = +p.usd, cap = +p.cap;
      const scopeWord = p.scope === 'run' ? 'this run' : (p.scope === 'day' ? 'today' : 'the global pool');
      const money = v => '$' + (Math.round(v * 100) / 100).toFixed(2);
      if (usd >= cap) hudNote('⛔ budget cap hit for ' + scopeWord + ' — ' + money(usd) + ' of ' + money(cap), 'warn');
      else hudNote('⚠ budget warning for ' + scopeWord + ' — ' + money(usd) + ' of ' + money(cap) + ' (' + Math.round(usd / cap * 100) + '%)', 'warn');
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
      fetch('/api/connectors').then(r => r.json()).then(j => {
        const list = (j && j.connectors) || []; connIds.length = 0;
        for (const c of list) {
          connIds.push(c.id);
          PropSprites.setConnectorState(c.id, c.state === 'up' ? 'connected' : (c.state === 'error' ? 'error' : 'offline'), c.toolCount);
        }
      }).catch(() => {});
    }
    connPollFn = pollConnectors; pollConnectors(); connPollTimer = setInterval(pollConnectors, 5000);
    U.bus.on('agent.tool_call', p => {            // chat.js re-emits the hero's tool calls here; routed agents arrive via SSE
      const n = p && p.name;
      if (!n) return;
      heatBump(p.agentId, 0.35);                  // G0.3: any real tool fire is activity — stoke the desk heat
      if (n.indexOf('mcp__') === 0) {             // connector portals: pulse the BOUND portal (unchanged)
        if (!PropSprites.pulseConnector) return;
        for (const cid of connIds) if (n.indexOf('mcp__' + cid + '__') === 0) { PropSprites.pulseConnector(cid); break; }
        return;
      }
      // G0.1 PER-TOOL PROP PULSE: a real tool fire lights the prop that GRANTS it (toolprops.js maps
      // fs.*→cabinet · web/browser→dish · notebook/skill/recall/todo→notebook · image_*→studio ·
      // spotify_*→jukebox), preferring the acting agent's own/room prop. shell/verify keep their dedicated
      // workbench events below — the mapper returns null for them, so nothing ever double-fires.
      const cap = (typeof ToolProps !== 'undefined') ? ToolProps.toolPropType(n) : null;
      if (!cap || !PropSprites.pulseProp) return;
      const tgt = capPropFor(cap, p.agentId);
      if (tgt) PropSprites.pulseProp(tgt.id, cap);
    });
    // workbench pulse: a shell command running glows the bench green; a verify result glows green/red by outcome.
    U.bus.on('shell.exec', () => { if (PropSprites.pulseWorkbench) PropSprites.pulseWorkbench(true); });
    U.bus.on('verify.result', p => { if (PropSprites.pulseWorkbench) PropSprites.pulseWorkbench(!!(p && p.passed)); });
    // G0.3 TOKEN HEAT: every streamed token stokes the acting agent's desk heat (audio.js already rides this
    // same event for music intensity) — the working screens burn by REAL token flow, never a faked flicker.
    U.bus.on('agent.token', p => heatBump(p && p.agentId, 0.06));
    // G0.2 RUN CLOCK: elapsed-time bookkeeping keyed to the REAL run lifecycle (a run.error is always
    // followed by run.end reason 'error', so end is the one cleanup point). Internal reason-only runs
    // never reach U.bus (harness.js suppresses their start/end), so no clock ever shows for self-talk.
    U.bus.on('agent.run.start', p => { if (p && p.agentId) runStartByAgent.set(p.agentId, performance.now()); });
    U.bus.on('agent.run.end', p => { if (p && p.agentId) runStartByAgent.delete(p.agentId); });
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
        const _base = (typeof window !== 'undefined' && window.__STARNET_API__) ? window.__STARNET_API__ : '';
        const _tok = (typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) ? encodeURIComponent(String(window.__STARNET_API_TOKEN__)) : '';
        chanES = new EventSource(_base + '/api/channels/events' + (_tok ? ('?token=' + _tok) : ''));
      } catch (_) { return; }
      chanES.onopen = () => { backoff = 1000; };
      chanES.onmessage = ev => { try { const m = JSON.parse(ev.data); if (m && m.name) U.bus.emit(m.name, m.payload); } catch (_) {} };
      chanES.onerror = () => { try { chanES.close(); } catch (_) {} chanES = null; if (bridgePaused) return; setTimeout(open, backoff); backoff = Math.min(15000, backoff * 2); };
    };
    connOpenFn = open;
    open();
  }
  // the live backlog total — FloorStats owns it (tested), with the chanQueues sum as a fallback if
  // FloorStats isn't loaded. Both the numeric gauge and the physical jam read this one source.
  function queueDepthNow() {
    if (floor) return floor.snapshot().queueDepth | 0;
    let d = 0; for (const v of chanQueues.values()) d += v; return d;
  }
  // bottom-right INTAKE queue-depth gauge — backpressure made visible (screen-space overlay)
  function drawQueueDepth() {
    const depth = queueDepthNow();
    if (depth <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false;
    const W = cv.width / dpr, H = cv.height / dpr, pad = 8, bw = 88, bh = 16;
    const x = W - bw - pad, y = H - bh - pad;
    ctx.fillStyle = 'rgba(8,10,9,0.85)'; ctx.fillRect(x, y, bw, bh);
    ctx.strokeStyle = '#caa84a'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
    ctx.fillStyle = '#e8c860'; ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('INTAKE ' + '▮'.repeat(Math.min(6, depth)) + ' ' + depth, x + 6, y + bh / 2 + 0.5);
  }

  /* THE JAM — the live backlog made PHYSICAL: park N amber "waiting" crates climbing off the INTAKE so
     the jam's LENGTH is the real queue depth (straight from queue.status). World-space, lit with the floor
     like the riding crates. Honest: it shows the backend's pending-work count, never a guessed frontend hold. */
  function drawQueueJam(now) {
    const depth = queueDepthNow();
    if (depth <= 0 || !geo || !geo.props) return;
    const intake = geo.props.find(p => p.t === 'intake');
    if (!intake) return;
    const MAXVIS = 6, shown = Math.min(depth, MAXVIS);
    const cx = (intake.x + (intake.w || 1) / 2) * T;       // centered on the intake footprint
    const top = intake.y * T - 3;                          // crates climb upward off the intake's top edge
    for (let i = 0; i < shown; i++) drawWaitCrate(cx, top - i * 6 + Math.sin(now / 360 + i * 0.7) * 0.6);   // gentle idle bob
    if (depth > MAXVIS) {
      ctx.fillStyle = '#e8c860'; ctx.font = '7px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('+' + (depth - MAXVIS), cx, top - shown * 6 - 3);
    }
  }
  // one parked amber crate (waiting ore) — matches the riding-box silhouette/palette
  function drawWaitCrate(cx, cy) {
    const x = Math.round(cx - 4), y = Math.round(cy - 4);
    ctx.fillStyle = '#161210'; ctx.fillRect(x - 1, y - 1, 11, 8);   // dark outline
    ctx.fillStyle = '#8a7330'; ctx.fillRect(x, y + 3, 9, 3);        // shaded front face
    ctx.fillStyle = '#caa84a'; ctx.fillRect(x, y, 9, 3);           // lit amber top
    ctx.fillStyle = '#e8c860'; ctx.fillRect(x, y, 9, 1);           // top sheen
  }

  /* THE FLOOR ECONOMY READOUT — the running station made legible at a glance (the Factorio dashboard).
     Four real, folded numbers (FloorStats): YIELD (productive-run rate), RUNS (decisive runs),
     CACHE (the prompt-cache "smelter" signal), SLAG (runs that produced no deliverable — it
     pulses red the instant a fresh waste run lands). Honest by construction: yield/cache show "—" until
     they have a real sample. Stacks just above the INTAKE queue gauge; stays hidden on a quiet floor. */
  function drawFloorStats(now) {
    if (!floor) return;
    const fs = floor.snapshot(Date.now());   // live wall-clock anchor so throughput decays honestly when deliveries stop
    if (fs.runs === 0 && fs.delivered === 0) return;   // nothing has happened yet - stay dark
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false;
    const W = cv.width / dpr, H = cv.height / dpr, pad = 8, bw = 160, bh = 46;
    let qDepth = 0; for (const d of chanQueues.values()) qDepth += d;
    const x = W - bw - pad, y = H - bh - pad - (qDepth > 0 ? 20 : 0);        // sit above the queue gauge when it's showing
    ctx.fillStyle = 'rgba(8,10,9,0.85)'; ctx.fillRect(x, y, bw, bh);
    ctx.strokeStyle = '#2e3a34'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
    ctx.font = '9px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const cell = (cxp, cyp, label, val, col) => {
      ctx.fillStyle = '#6a7a72'; ctx.fillText(label, cxp, cyp);
      ctx.fillStyle = col; ctx.fillText(val, cxp + 36, cyp);
    };
    const cA = x + 7, cB = x + bw / 2 + 3, r1 = y + 10, r2 = y + 23, r3 = y + 36;
    cell(cA, r1, 'YIELD', fs.yieldKnown ? fs.yieldPct + '%' : '—', fs.yieldKnown ? (fs.yieldFrac >= 0.6 ? '#62c487' : '#e8c860') : '#5a6a62');
    cell(cB, r1, 'RUNS', String(fs.runs), '#aeb9c4');
    cell(cA, r2, 'CACHE', fs.cacheKnown ? fs.cachePct + '%' : '—', fs.cacheKnown ? (fs.cacheFrac >= 0.4 ? '#5ad0ff' : '#7a8a82') : '#5a6a62');
    const flash = (now - lastSlagAt) < 900 && (Math.floor((now - lastSlagAt) / 150) % 2 === 0);   // fresh-slag pulse
    cell(cB, r2, 'SLAG', String(fs.slag), fs.slag > 0 ? (flash ? '#ff9a7a' : '#ef6a4a') : '#3f8a5a');
    cell(cA, r3, 'THRU', fs.thruOutPerMin + '/m', fs.thruOutPerMin > 0 ? '#aeb9c4' : '#5a6a62');
    cell(cB, r3, 'DWELL', fs.dwellKnown ? fs.avgDwellSec.toFixed(1) + 's' : '—', fs.dwellKnown ? '#aeb9c4' : '#5a6a62');
  }

  return { init, rebake, crt: CRT, slagLog: () => (slaglog ? slaglog.recent() : []), loadStation, spawn, spawnAgent, setActivityFor, focusBody, start, stop, setActivity, wakeIn, beginAwakening, setWakeProgress, igniteSpark, armKindle, kindleHold, camPushIn, camCreep, camPunch, camPullBack, awakenTurn, truthPulse, beginFlood, collapseFlood, endAwakening, releaseAwakening, say, focusAgent, getActivity: () => activity, getUse: () => (agent ? agent.usingProp : null), setOnClick, setOnArcade, setOnOutbox, setOnMissionBoard, setOnTrophyCase, refit, pauseBridge, resumeBridge,
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
    dbg: () => agent && { goal: agent.goal, quirkKind: agent.quirkKind, sitting: agent.sitting, state: agent.state, stilling: !!agent.stilling, firstWakeDone, wakePhase: agent.wakePhase, moving: !!agent.target, paused: fnow < (agent.pauseUntil || 0), pauseLook: agent.pauseLook, dir: agent.dir, tile: tileOf(agent.px, agent.py), idleUntil: Math.round((agent.idleUntil || 0) - fnow), quirkCd: Math.round(Math.max(0, (agent.quirkCd || 0) - fnow)), offbeatCd: Math.round(Math.max(0, (agent.offbeatCd || 0) - fnow)), fond: [...agent.fond.entries()], pendingMourn: pendingMourn && { tx: pendingMourn.tx, ty: pendingMourn.ty, fond: pendingMourn.fond }, decor: agentDecor.length, crew: crew.length, spendUsd: floor ? (floor.snapshot().spendUsd || 0) : 0, boxes: convey ? convey.boxCount() : 0, queueDepth: queueDepthNow(), bridge: { paused: bridgePaused, es: !!chanES, poll: !!connPollTimer }, await: awaitPrompt ? { promptId: awaitPrompt.promptId, arrived: awaitArrived, source: awaitAnchor ? awaitAnchor.source : null, anchor: awaitAnchor ? { tx: awaitAnchor.tx, ty: awaitAnchor.ty } : null } : null, helpers: subLedger ? subLedger.count() : 0, proposalsPinned: pinnedCount },
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
          seated: !!b.seated, unplaced: !!b.unplaced,
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
      if (!station || !station.doc) return { belts: 0, connectors: 0 };
      const d = station.doc() || {};
      return {
        belts: d.belts ? Object.keys(d.belts).length : 0,
        connectors: d.props ? d.props.filter(p => p && p.t === 'connector_portal').length : 0
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
    }
  };
})();
