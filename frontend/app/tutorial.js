/* STARNET — tutorial.js : THE FIRST COMMAND + coachmarks + Field Manual (diegetic onboarding, P0–P3).

   The mind that just woke up (onboarding.js) keeps talking — and teaches the Commander the ONE
   real loop. It opens with the KIT-OUT: the floor is REAL, so a fresh station is compute-only and the
   Commander must PLACE the capability gear (cabinet→FILES · dish→WEB · workbench→TERMINAL · server→
   MEMORY) — each placement genuinely hands the agent that power (heroCaps → the run's real tools). Most
   beats speak in COMMS (Chat.typeLine); the placement guidance is a floating coach bubble over REFIT
   (which covers COMMS). Choices are Chat.choices.

   Honest by mandate (this serves the polish-audit through-line "make the one real loop visible +
   shrink what lies"): it names the crew as echoes, never fakes a number, and — crucially — only runs
   the first real job AFTER the Commander has placed the CABINET, so the file write+read (fs.write +
   fs.read, fs.write consent-gated) executes against tools that ACTUALLY EXIST. A fresh station grants
   none of these out of the box (the moat — sidecar/capability/office.js + capgate F1), so the kit-out
   is what makes the consent→execute→prove demo true instead of an app-lie. The bus-timed beats
   (agent.run.start / permission.prompt / agent.run.end) then narrate the genuine run, never a sim.

   Lifecycle: fires once, right after the awakening lands (app.js passes Onboarding.start({ taught })).
   Fully skippable; a self-owned localStorage flag (starnet.tutorial.v1) means it never repeats.
   P2 = just-in-time coachmarks (seen()/markSeen()); P3 = the Field Manual codex + Station Briefing. */
'use strict';

const Tutorial = (() => {
  const KEY = 'starnet.tutorial.v1';
  let state = load();
  let active = false, wired = false, finished = false;
  let agentName = 'AGENT';
  // one-shot latches so a repeated bus event can never double-narrate a beat
  let sawStart = false, sawPermission = false, sawEnd = false, sawDeny = false;
  let cleanRunId = null;   // the demo run's id — captured ONLY on a clean, un-denied finish (it gates the handoff pitch)
  let stallTimer = null;   // failsafe: if the real run never reaches the bus (sidecar down / bad key), narrate honestly instead of freezing
  // THE KIT-OUT (the floor is REAL): the first lesson is the moat — the Commander PLACES the capability gear
  // (cabinet→FILES · dish→WEB · workbench→TERMINAL · server→MEMORY) and each placement hands the agent a genuine
  // power (heroCaps → the run's real tools), so the first real job runs against tools that actually exist.
  let kitMode = false, kitNeeded = null, kitComplete = false, kitWasOpen = false, kitPollTimer = null;
  let kitHold = false, kitFlashTimer = null, kitFocusKey = null, kitReadyTimer = null;   // kit-out: flash-hold + the current sub-step's spotlight key + the post-flash "ready" timer

  function load() {
    let r = null;
    try { r = JSON.parse(localStorage.getItem(KEY)); } catch (_) {}
    if (!r || r.v !== 1) r = { v: 1 };
    if (typeof r.firstCommandDone !== 'boolean') r.firstCommandDone = false;
    if (!r.seen || typeof r.seen !== 'object') r.seen = {};
    if (!r.brief || typeof r.brief !== 'object') r.brief = {};          // P3 first-steps progress
    if (typeof r.briefDismissed !== 'boolean') r.briefDismissed = false;
    if (typeof r.briefComplete !== 'boolean') r.briefComplete = false;
    return r;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }

  const hasChat = () => typeof Chat !== 'undefined' && Chat.typeLine && Chat.localLine && Chat.choices;
  const seg = (t, cps, hold) => ({ text: t, cps: cps || 46, holdAfter: hold || 0 });
  function say(segs, onDone) {            // an agent line (or lines) in COMMS, via the awakening typewriter
    if (!hasChat()) { if (onDone) onDone(); return; }
    Chat.typeLine(typeof segs === 'string' ? [seg(segs)] : segs, onDone);
  }
  function sfx(n) { try { if (typeof SFX !== 'undefined' && SFX[n]) SFX[n](); } catch (_) {} }

  /* ---- spotlight: a soft scrim with a cut-out hole over the surface being discussed ----
     The hole is a positioned div whose huge box-shadow IS the scrim; pointer-events:none so the
     highlighted control stays fully clickable underneath (chips, the consent buttons, etc.). */
  let spot = null, spotEl = null;
  function place(r) {
    const pad = 6;
    spot.style.left = (r.left - pad) + 'px'; spot.style.top = (r.top - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px'; spot.style.height = (r.height + pad * 2) + 'px';
  }
  function reposition() { if (spot && spotEl) place(spotEl.getBoundingClientRect()); }
  function spotlight(sel) {
    clearSpot();
    const el = (typeof sel === 'string') ? document.querySelector(sel) : sel;
    if (!el) return;
    spot = document.createElement('div'); spot.className = 'tut-spot';
    spotEl = el; place(el.getBoundingClientRect());
    document.body.appendChild(spot);
    window.addEventListener('resize', reposition);
  }
  function clearSpot() {
    if (spot) { window.removeEventListener('resize', reposition); spot.remove(); spot = null; spotEl = null; }
  }

  /* ---- the always-available bail-out (no-gating sandbox: skipping is one click, always) ---- */
  let skipBtn = null;
  function showSkip() {
    if (skipBtn) return;
    skipBtn = document.createElement('button');
    skipBtn.className = 'tut-skip'; skipBtn.textContent = 'skip intro ✕';
    skipBtn.onclick = () => finishUp(true);
    document.body.appendChild(skipBtn);
  }
  function hideSkip() { if (skipBtn) { skipBtn.remove(); skipBtn = null; } }

  /* ================= THE FIRST COMMAND ================= */
  // The demo is fs.write + fs.read — but the fresh station is COMPUTE-ONLY (the moat: web/files/terminal must be
  // PLACED, see sidecar/capability/office.js + capgate F1). So the FIRST lesson is the kit-out: the Commander
  // places the real capability gear, the agent genuinely gains files (heroCaps → fs.read/fs.write), and ONLY THEN
  // does this run — so the walk → consent → execute → prove loop is real, never an app-lie. fs.write requires
  // consent, so the Commander still sees the genuine consent gate; placing the CABINET first is what makes it true.
  const TASK = 'write the line "starnet online" to a file called hello.txt, then read it back and show me';

  // the capability gear the kit-out walks through, in order. `grant` is the power-word grantLabelForProp returns
  // when its prop lands; `prop` is the catalog id we point at. The display LABEL and the CATEGORY tab are resolved
  // from the LIVE catalog at runtime (resolveKit) so the coach can never name a prop or tab that doesn't exist —
  // the root of the old "the CABINET"/"REFIT button" drift. FILES is first so the fs demo that follows is honest.
  // (COMPUTE isn't here — always-on freebie + a synthetic desk; a SEATED workstation is editable so it doesn't
  // fire onPropPlaced, but the WORKBENCH does, which is why TERMINAL can ride the placement loop. Note the
  // workbench lives under WORKSTATIONS, the other three under CAPABILITY — resolveKit carries that, so the loop
  // guides the category switch instead of stranding the Commander.)
  const KIT_SPEC = [
    { grant: 'FILES',    prop: 'war_intelcab',    label: 'INTEL CAB',   power: 'FILES',      got: 'now i can read and write files — that’s where i keep anything that matters.' },
    { grant: 'WEB',      prop: 'comms_dish',      label: 'DISH',        power: 'the WEB',    got: 'and now the live web — real search, real pages, not just what i woke up knowing.' },
    { grant: 'TERMINAL', prop: 'workbench',       label: 'WORKBENCH',   power: 'a TERMINAL', got: 'a real terminal — i can run commands and check what they did, and you approve each one.' },
    { grant: 'MEMORY',   prop: 'gigs_servercart', label: 'SERVER CART', power: 'MEMORY',     got: 'memory that survives a restart — and my skill library, where i save and reload the procedures i work out, so i don’t wake up blank every time.' }
  ];
  let KIT = KIT_SPEC.slice();   // resolveKit() rebuilds this with live labels/categories at kit start

  const hasDialogue = () => typeof Dialogue !== 'undefined';
  // a felt list: ["FILES","WEB","TERMINAL"] -> "FILES, WEB and TERMINAL"
  function listWords(a) { a = (a || []).slice(); if (a.length <= 1) return a[0] || ''; const last = a.pop(); return a.join(', ') + ' and ' + last; }
  // a Dialogue narration beat that no-ops gracefully if the panel is gone (keeps the async chains safe)
  function dsay(text, cps, hold) { return hasDialogue() ? Dialogue.say([seg(text, cps, hold)]) : Promise.resolve(); }

  function firstCommand(opts) {
    if (state.firstCommandDone) return;       // learned once, never again
    if (!hasChat()) return;
    agentName = (opts && opts.name) || agentName;
    active = true; finished = false; sawStart = sawPermission = sawEnd = sawDeny = false; cleanRunId = null;   // C1: un-latch finishUp for this fresh run (it's symmetric with the saw-flags; without it a prior agent's completed lesson left finishUp a no-op)
    kitMode = false; kitComplete = false; kitWasOpen = false; kitNeeded = null;
    wireBus(); showSkip();
    // The handoff from the awakening: the DIALOGUE panel is already open (onboarding's closeOut left it up).
    // Offer the tour EXPLICITLY — a clear "SHOW ME AROUND" vs "dive in myself" choice, not a buried chip. This
    // kills the old rhetorical "where do we begin?" self-answer the Commander found confusing.
    if (!hasDialogue()) { finishUp(true); return; }   // no panel → don't trap the Commander in a half-built tour
    Dialogue.open({ name: agentName });
    Dialogue.node({
      lines: [seg('before you put me to work — want the quick tour? i’ll show you how this place actually runs, starting with why my room being bare matters.', 44, 0)],
      options: [
        { label: '▸ SHOW ME AROUND (recommended)', value: 'tour' },
        { label: 'I’ll dive in myself', value: 'skip', skip: true }
      ]
    }).then(res => { if (!active) return; if (res.skip) return finishUp(true); beatShowAround(); });
  }

  /* ---- THE ROLEPLAY COLD-OPEN: the agent walks to its own workstation and DISCOVERS it's boxed in ----
     Truthful by construction: a fresh station really is compute-only (the moat), so "i reach for files and
     there's nothing" is the literal state — which is exactly what motivates the kit-out. The panel clears so
     the walk is visible, then reopens at the desk so the realization reads. A failsafe advances even if the
     walk never lands (sidecar down / no seat), so the tour can never freeze here. */
  function beatShowAround() {
    if (!active) return;
    if (hasDialogue()) Dialogue.close();                 // clear COMMS so the walk + the agent are fully visible
    try { if (typeof World !== 'undefined' && World.setActivity) World.setActivity('task'); } catch (_) {}   // send the hero to its desk (pure roleplay — emits no run, claims no work)
    try { if (typeof World !== 'undefined' && World.camPushIn) World.camPushIn(); } catch (_) {}
    rpWalkPoll(0);
  }
  function rpWalkPoll(tries) {
    if (!active) return;
    let arrived = false;
    try { const d = (typeof World !== 'undefined' && World.dbg) ? World.dbg() : null; arrived = !!(d && d.goal === 'work' && d.sitting); } catch (_) {}
    if (arrived || tries > 60) return rpArrived();        // ~6s failsafe @100ms — never freeze waiting on the walk
    setTimeout(() => rpWalkPoll(tries + 1), 100);
  }
  async function rpArrived() {
    if (!active) return;
    if (hasDialogue()) Dialogue.open({ name: agentName });
    try { World.say('my desk.'); } catch (_) {}
    await dsay('okay — i made it to my desk. i can think, and i can talk to you. that’s compute, and it’s always mine.', 44, 360);
    if (!active) return;
    try { if (World.truthPulse) World.truthPulse(); World.say('…nothing.'); } catch (_) {}
    await dsay('but watch — i reach for the files… the live web… a terminal… a memory of my own…', 44, 360);
    if (!active) return;
    await dsay('nothing. none of it’s wired up yet. i’m a mind in a bare room.', 44, 280);
    if (!active) return;
    beatKitInvite();
  }
  function beatKitInvite() {
    if (!active) return;
    if (!hasDialogue()) return beatKitIntro();
    Dialogue.open({ name: agentName });
    Dialogue.node({
      lines: [seg('here’s the one rule of this whole place: what you build, i can do. every piece you place in my room hands me a real power. want me to walk you through kitting me out? a minute, tops.', 44, 0)],
      options: [
        { label: '▸ Kit me out (recommended)', value: 'go' },
        { label: 'I’ll explore on my own', value: 'skip', skip: true }
      ]
    }).then(res => { if (!active) return; if (res.skip) return finishUp(true); beatKitIntro(); });
  }

  /* ---- THE KIT-OUT: a guided, GLOW-DRIVEN placement loop. One self-rescheduling tick (kitTick) is the whole
     goal system: each pass it reads the live UI and lights exactly the single next control along the real path —
     BUILD dock ▸ REFIT STATION ▸ ⚇ PROP ▸ the right CATEGORY tab ▸ the exact gear tile — naming each with the
     REAL catalog label. A category switch, a placement, or closing REFIT all advance it cleanly: no stale copy,
     no covered buttons, no freeze. resolveKit() pins the labels/categories to the live catalog so they can't drift. */
  const q = sel => document.querySelector(sel);
  const CATLABEL = { workstation: 'WORKSTATIONS', workflow: 'WORKFLOW', capability: 'CAPABILITY', isolation: 'ISOLATION' };
  function resolveKit() {
    const cat = (typeof PropSprites !== 'undefined' && PropSprites.CATALOG) ? PropSprites.CATALOG : [];
    const grantOf = id => (typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp) ? WorldModel.grantLabelForProp(id) : null;
    return KIT_SPEC.map(s => {
      const c = cat.find(x => x.id === s.prop) || cat.find(x => grantOf(x.id) === s.grant) || null;
      return Object.assign({}, s, {
        prop: c ? c.id : s.prop,
        label: c ? c.label : s.label,
        cat: c ? c.cat : 'capability',
        catLabel: c ? (CATLABEL[c.cat] || String(c.cat).toUpperCase()) : 'CAPABILITY'
      });
    });
  }

  function beatKitIntro() {
    if (!active) return;
    if (hasDialogue()) Dialogue.close();              // reveal the bottom bar so the BUILD-dock glow is visible
    kitMode = true; kitComplete = false; kitWasOpen = false; kitHold = false; kitFocusKey = null;
    KIT = resolveKit();
    kitNeeded = new Set(KIT.map(k => k.grant));
    try { if (typeof World !== 'undefined' && World.say) World.say('build me a floor.'); } catch (_) {}
    kitTick();                                        // the loop takes over: glow BUILD ▸ REFIT STATION, then guide inside
  }
  // the goal loop. Catches REFIT open/close from any path; self-clears on finishUp/teardown.
  function kitTick() {
    if (!active || !kitMode) return;
    const open = !!(typeof Build !== 'undefined' && Build.isOpen && Build.isOpen());
    if (open && !kitWasOpen) { kitWasOpen = true; clearSpot(); kitFocusKey = null; }       // just entered REFIT — drop the bottom-bar scrim
    else if (!open && kitWasOpen) { kitWasOpen = false; return kitClosedDuringPlace(); }   // just left REFIT
    if (open) kitInRefit(); else kitGuideToRefit();
    kitPollTimer = setTimeout(kitTick, 180);
  }
  function nextKit() { return kitNeeded ? KIT.find(k => kitNeeded.has(k.grant)) : null; }

  // OUTSIDE REFIT: light the REAL path into the builder — the BUILD dock, then REFIT STATION once that dock opens.
  function kitGuideToRefit() {
    const station = q('#bb-build');
    const menuOpen = !!(station && station.getClientRects().length);   // REFIT STATION is only visible once its dock is open
    if (menuOpen) kitFocus(station, 'now hit ⌂ REFIT STATION — that opens REFIT, where you build my floor.', 'to-refit-station', { scrim: true, zone: 'bottom' });
    else kitFocus(q('.bb-group[data-group="build"] .bb-grp'), 'open the ⚒ BUILD dock down in the bar, then ⌂ REFIT STATION — that’s where you kit me out.', 'to-refit-grp', { scrim: true, zone: 'bottom' });
  }

  // INSIDE REFIT: compute the single next sub-step and glow exactly that control, named with the REAL label + tab.
  function kitInRefit() {
    if (kitHold) return;                              // a "✓ placed" flash is breathing — don't fight it
    const k = nextKit();
    if (!k) return beatKitReady();
    const tool = (q('.refit-tool.active') || {}).dataset;
    if (!tool || tool.tool !== 'prop')
      return kitFocus(q('.refit-tool[data-tool="prop"]'), 'tap ⚇ PROP (key 6) up top — that opens the gear menu.', 'step-prop');
    // all capability + workstation gear is on the ⚙ SYSTEMS tier; if they wandered into ✦ DECOR, bring them back
    const tierActive = q('.refit-tier.active'), tierFn = q('.refit-tier-functional');
    if (tierFn && tierActive && tierActive !== tierFn)
      return kitFocus(tierFn, 'switch to ⚙ SYSTEMS — the gear that grants powers lives here, not in DECOR.', 'step-tier');
    const catA = (q('.refit-propcat.active') || {}).dataset;
    if (!catA || catA.cat !== k.cat)
      return kitFocus(q('.refit-propcat[data-cat="' + k.cat + '"]'), 'open the ' + k.catLabel + ' tab — that’s where ' + k.label + ' lives.', 'step-cat-' + k.cat);
    // right tool, right tier, right tab — light the exact tile, named with its REAL catalog label.
    // COMPRESSION: the first placement teaches the loop; reps 2–4 teach nothing new. Once one needed cap is
    // down, every remaining tile step carries a one-tap "requisition the rest" — the agent places its own
    // remaining gear through the REAL path (Build.requisition), each landing scored by the normal hook.
    const offerReq = kitNeeded && kitNeeded.size < KIT.length && typeof Build !== 'undefined' && !!Build.requisition;
    return kitFocus(q('.refit-proptile[data-prop="' + k.prop + '"]'),
      'pick ' + k.label + ' (' + k.power + '), then click a spot in my room to drop it in.' + (offerReq ? ' — or say the word and i’ll requisition the rest myself.' : ''),
      'step-tile-' + k.prop + (offerReq ? '-req' : ''),
      offerReq ? { action: { label: '⚡ requisition the rest', onClick: runRequisition } } : undefined);
  }
  // "requisition the rest" — the agent places its own remaining gear through the REAL placement path
  // (Build.requisition → station.addProp at a validated tile). Each landing fires the normal placement hook
  // (build.js → onPropPlaced → kitOnPropPlaced), so the loop scores/flashes/completes exactly as if the
  // Commander dropped it by hand. Staggered so each ✓ + chime reads; a floor with no clear tile for a piece
  // degrades honestly back to hand placement (the tick re-lights that tile).
  function runRequisition() {
    if (!active || !kitMode || !kitNeeded) return;
    const left = KIT.filter(k => kitNeeded.has(k.grant));
    if (!left.length) return;
    clearCoach(); kitFocusKey = null;
    let di = 0;
    for (const k of left) {
      setTimeout(() => {
        if (!active || !kitMode || !kitNeeded || !kitNeeded.has(k.grant)) return;   // hand-placed meanwhile / tour over
        const res = (typeof Build !== 'undefined' && Build.requisition) ? Build.requisition(k.prop) : null;
        if (!res || !res.ok) kitFlash('no clear floor for ' + k.label + ' — drop it by hand wherever you like.');
      }, 260 + (di++) * 820);
    }
  }
  // a placement landed (build.js → onPropPlaced → here). grant is the power-word, or null for inert decor.
  // Forgiving + order-free: any needed cap checks off; a spare or decor just flashes a nudge. The tick re-lights
  // the next step automatically once the flash clears — so this only scores the placement, it never has to re-aim.
  function kitOnPropPlaced(grant) {
    if (!active || !kitMode) return;
    tickBrief('build');
    if (!grant) { kitFlash('that one’s just set dressing — it grants nothing. i need the gear that wears a power-word.'); return; }
    if (!kitNeeded.has(grant)) {
      kitFlash('already running ' + grant + ' — that’s a spare, no harm.');
      if (!nextKit()) kitReadyTimer = setTimeout(() => { kitReadyTimer = null; if (active && kitMode) beatKitReady(); }, 1700);
      return;
    }
    kitNeeded.delete(grant);
    const k = KIT.find(x => x.grant === grant);
    kitFlash('✓ ' + (k ? k.power : grant) + ' — ' + (k ? k.got : ''));
    if (!nextKit()) kitReadyTimer = setTimeout(() => { kitReadyTimer = null; if (active && kitMode) beatKitReady(); }, 1700);   // else: the tick lights the next step after the flash
  }
  function beatKitReady() {
    if (!active || !kitMode || kitComplete) return;   // latch: the tick + the post-flash timer both reach here — run once
    kitComplete = true;
    kitFocus(q('#refit-done'), 'that’s the whole kit — files, web, a terminal, memory. hit ✓ DONE up top to step back out.', 'step-done');
    // kitTick sees REFIT close → kitClosedDuringPlace → (all placed) → beatFullyEquipped
  }
  // REFIT closed during the kit-out. The tutorial's COMPLETION CONDITION is "every capability prop placed" —
  // when that's met we celebrate + offer an optional real-job demo, then END. If they closed early we never
  // dead-end (Theme 3): name what's wired vs still dark and offer to keep going or stop here. The Commander's
  // floor, always.
  function kitClosedDuringPlace() {
    if (!active) return;
    clearCoach(); clearSpot();
    clearKitTimers();
    kitHold = false; kitFocusKey = null;
    const allPlaced = kitComplete || (kitNeeded && kitNeeded.size === 0);
    if (allPlaced) { kitMode = false; return beatFullyEquipped(); }
    // closed before the kit is complete — honest accounting, then a path forward (never a trap)
    kitMode = false;
    const placed = KIT.filter(k => kitNeeded && !kitNeeded.has(k.grant)).map(k => k.grant);
    const left = KIT.filter(k => kitNeeded && kitNeeded.has(k.grant)).map(k => k.grant);
    const have = placed.length ? 'you’ve wired me ' + listWords(placed) + ' so far. ' : 'nothing placed yet — an empty room is an empty agent. ';
    const dark = left.length ? 'still dark: ' + listWords(left) + '.' : '';
    if (!hasDialogue()) return placed.length ? beatEquippedPartial() : finishUp(true);
    Dialogue.open({ name: agentName });
    Dialogue.node({
      lines: [seg(have + dark + ' want to finish kitting me out?', 44, 0)],
      options: [
        { label: '▸ Keep kitting me out', value: 'go' },
        { label: placed.length ? 'That’s enough for now' : 'Skip for now', value: 'skip', skip: true }
      ]
    }).then(res => {
      if (!active) return;
      if (res.skip) return placed.length ? beatEquippedPartial() : finishUp(true);
      if (hasDialogue()) Dialogue.close();
      kitMode = true; kitWasOpen = false; kitHold = false; kitFocusKey = null;   // re-arm; the tick re-lights the path back in
      kitTick();
    });
  }

  // FULLY EQUIPPED — the completion beat. Every capability prop is placed; the agent is whole. Offer the
  // optional "watch me actually use it" demo, then hand the Commander the free station. This is where the
  // tutorial ENDS (the user's bar: end the tour when full capability is placed).
  function beatFullyEquipped() {
    if (!active) return;
    sfx('level');
    if (!hasDialogue()) return beatCommand();
    Dialogue.open({ name: agentName });
    Dialogue.node({
      lines: [seg('look at that — files, the web, a terminal, and a memory of my own. that’s a whole agent. the room isn’t bare anymore, and neither am i.', 44, 460)],
      options: [
        { label: '▸ Watch me use it on a real job', value: 'demo' },
        { label: 'I’ve got it from here', value: 'done', skip: true }
      ]
    }).then(res => { if (!active) return; if (res.value === 'demo') return beatCommand(); finishUp(false); });
  }
  // they stopped with SOME gear placed — a real, partial agent. Acknowledge honestly and bow out (no nag).
  function beatEquippedPartial() {
    if (!active) return;
    dsay('fair. i’ll work with what you’ve given me — wire the rest in REFIT whenever you like. you’re in control.', 44, 320).then(() => finishUp(false));
  }

  // THE OPTIONAL DEMO — the real fs.write + fs.read loop, now that the agent is genuinely equipped. The panel
  // CLOSES so the real run (the consent gate, the tool lines) is visible in COMMS; the bus-timed beats narrate
  // the genuine run, never a sim. Reached only from beatFullyEquipped, so the Commander already opted in — no
  // extra chip, straight to the run.
  function beatCommand() {
    if (!active) return;
    if (hasDialogue()) Dialogue.close();                 // reveal COMMS so the real loop is watchable
    demoPreflight().then(ready => {
      if (!active) return;
      if (!ready.ok) return beatSidecarDown(ready.why);  // can't actually run → own it in words, no scary error, no 8s freeze
      spotlight('#chat-panel');
      say([
        seg('watch, then. i’ll use the files you just gave me — write a line, read it back — right here on your machine.', 46, 380),
        seg('  and watch me stop to ask before i touch anything. heading to my station now.', 46, 0)
      ], () => { clearSpot(); if (typeof Chat.send === 'function') Chat.send(TASK); armStall(); });   // hand off to the REAL loop (+ a failsafe if it never reaches the bus)
    });
  }
  // the demo is a REAL run — only attempt it when it can actually land: a configured brain AND a reachable sidecar.
  // Without both, Chat.send throws a raw "no key" / "cannot reach the STARNET sidecar" line and the run never walks
  // (the user's "the end test fails" report). Preflight, and if it can't run, narrate the truth and teach on.
  function demoPreflight() {
    const model = (typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : '';
    const prov = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
    const cfg = (typeof Harness !== 'undefined' && Harness.configured) ? Harness.configured() : false;
    if (!model || (prov !== 'codex' && !cfg)) return Promise.resolve({ ok: false, why: 'brain' });
    if (typeof fetch === 'undefined') return Promise.resolve({ ok: false, why: 'sidecar' });
    let ctrl = null, to = null;
    try { ctrl = new AbortController(); to = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 2500); } catch (_) {}
    // require the literal 'ok' body, not just a 200 — a static host with a catch-all 200 (serving index.html for
    // /api/health) would otherwise pass preflight and then throw the raw "cannot reach the sidecar" on /api/run.
    return fetch('/api/health', ctrl ? { signal: ctrl.signal } : undefined)
      .then(r => (r && r.ok) ? r.text().catch(() => '') : '')
      .then(t => { if (to) clearTimeout(to); return { ok: String(t).trim() === 'ok', why: 'sidecar' }; })
      .catch(() => { if (to) clearTimeout(to); return { ok: false, why: 'sidecar' }; });
  }
  function beatSidecarDown(why) {
    if (!active) return;
    const line = (why === 'brain')
      ? 'one honest thing before i fake anything: i don’t have a brain wired up yet — no model or key set — so i can’t actually run this. set one in CONNECT, then point me at a real job and watch the loop for real.'
      : 'and… i can’t reach my own hands yet. the local sidecar — the thing that actually runs me (`npm start`) — isn’t answering, so nothing ran and i won’t pretend it did. start it up, then give me a real job and watch the whole loop.';
    say([seg(line, 44, 480)], beatGauge);
  }
  /* ---- the kit-out spotlight: a coach bubble PINNED to a safe zone (.tut-coach.kit — so it can never cover the
     control it points at, the old "guidance covers the buttons" bug) + a pulsing ring on the exact target + an
     optional scrim. Only rebuilds when the sub-step KEY changes; between rebuilds the ring just tracks the live
     element (no per-tick flicker). The live target is re-queried each tick, so a palette re-render can't strand it. */
  function kitFocus(target, text, key, opts) {
    opts = opts || {};
    if (key === kitFocusKey && coach && coach.bubble && coach.kit) { coach.anchor = target || null; return; }   // same step — just retarget the live ring
    kitFocusKey = key;
    clearCoach();
    if (opts.scrim && target) spotlight(target); else clearSpot();
    const bubble = document.createElement('div');
    bubble.className = 'tut-coach kit ' + (opts.zone === 'bottom' ? 'kit-bottom' : 'kit-top') + (reduceMotion() ? ' no-anim' : '');
    bubble.setAttribute('role', 'status'); bubble.setAttribute('aria-live', 'polite');
    const who = document.createElement('div'); who.className = 'tut-coach-who'; who.textContent = agentLabel();
    const body = document.createElement('div'); body.className = 'tut-coach-body'; body.textContent = text;
    bubble.appendChild(who); bubble.appendChild(body);
    // an optional one-tap ACTION in the bubble (the coach is the only UI visible over REFIT) — used by the
    // kit-out's "requisition the rest" offer. Reuses the .tut-coach-ok button styling.
    if (opts.action && opts.action.label) {
      const act = document.createElement('button'); act.className = 'tut-coach-ok'; act.type = 'button'; act.textContent = opts.action.label;
      act.onclick = () => { sfx('click'); try { if (opts.action.onClick) opts.action.onClick(); } catch (_) {} };
      bubble.appendChild(act);
    }
    document.body.appendChild(bubble);
    let ring = null;
    if (target) { ring = document.createElement('div'); ring.className = 'tut-ring' + (reduceMotion() ? ' no-anim' : ''); document.body.appendChild(ring); }
    coach = { bubble, ring, anchor: target, raf: 0, onKey: null, kit: true };
    placeCoach();
    sfx('open');
  }
  // a transient "✓ placed / spare / decor" acknowledgement — pinned top, no ring. Holds the loop for a beat so the
  // win reads before the tick re-lights the next target.
  function kitFlash(text) {
    kitHold = true; kitFocusKey = 'flash';
    clearCoach(); clearSpot();
    const bubble = document.createElement('div');
    bubble.className = 'tut-coach kit kit-top' + (reduceMotion() ? ' no-anim' : '');
    bubble.setAttribute('role', 'status'); bubble.setAttribute('aria-live', 'polite');
    const who = document.createElement('div'); who.className = 'tut-coach-who'; who.textContent = agentLabel();
    const body = document.createElement('div'); body.className = 'tut-coach-body'; body.textContent = text;
    bubble.appendChild(who); bubble.appendChild(body);
    document.body.appendChild(bubble);
    coach = { bubble, ring: null, anchor: null, raf: 0, onKey: null, kit: true };
    sfx('truth');
    if (kitFlashTimer) clearTimeout(kitFlashTimer);
    kitFlashTimer = setTimeout(() => { kitHold = false; kitFocusKey = null; }, 1600);
  }

  /* ---- bus-timed beats: the real run drives the rest of the lesson ----
     util.js's bus has no off(); every handler is guarded by `active` so post-tutorial runs are ignored. */
  function wireBus() {
    if (wired || typeof U === 'undefined' || !U.bus) return;
    wired = true;
    U.bus.on('agent.run.start', () => { if (active && !sawStart) { sawStart = true; clearStall(); onRunStart(); } });
    U.bus.on('permission.prompt', () => { tickBrief('approve'); if (active && !sawPermission) { sawPermission = true; onPermission(); } });
    U.bus.on('permission.response', p => { if (active && p && p.decision === 'deny') sawDeny = true; });   // so onRunEnd narrates a Deny honestly, never "i ran it and showed you the result"
    // FIRST-STEPS "give a command" tracks any CLEAN run (tutorial or not) — outside the active guard so it keeps
    // working for the whole session; gated on reason==='done' so an errored run no longer falsely ticks it.
    // The NARRATION (onRunEnd) is separate, active-guarded, and branches on the real outcome.
    U.bus.on('agent.run.end', p => {
      if (p && p.reason === 'done') tickBrief('command');
      if (active && !sawEnd) { sawEnd = true; clearStall(); onRunEnd(p); }
    });
  }
  function clearStall() { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } }
  // armed right after Chat.send(TASK): if neither run.start nor run.end has fired, the run never reached the
  // sidecar (it isn't running, or the key's bad) — so the agent NEVER walked. Own that honestly and finish the
  // lesson in words instead of leaving the Commander staring at a frozen "i'm heading to my station".
  function armStall() {
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (!active || sawStart || sawEnd) return;
      sawEnd = true;   // latch so a very-late bus event can't double-narrate
      say([
        seg('huh — i didn’t actually move. i can’t reach my own hands yet.', 44, 420),
        seg('  the sidecar isn’t running, or the key’s off — so nothing ran, and i won’t pretend it did. start it up and tap me again. here’s the rest in words for now:', 44, 0)
      ], beatGauge);
    }, 8000);
  }

  // the agent is now walking to the desk (chat.js set World.setActivity('task') the instant the chip fired)
  function onRunStart() {
    if (!active) return;
    say([seg('there i go. that desk is where i actually go to work — for real, on your machine. this isn’t a cutscene.', 44, 0)]);
  }
  // the real consent prompt has just appeared in COMMS (harness emits on the bus around when chat.js draws the row).
  // Copy avoids spatial words ("below") so it stays correct under trunk's pinned-reply COMMS ordering after a sync.
  function onPermission() {
    if (!active) return;
    say([
      seg('stop — see that prompt? before i touch anything that matters, it surfaces right here and waits for you.', 44, 360),
      seg('  approve once, always, or kill it. that pause is your hand on the switch. go ahead — approve it.', 44, 0)
    ]);
  }
  // wrap-up: tell the TRUTH about what actually happened. agent.run.end fires for done/stop/limit/error, and a
  // Deny ends the run without writing anything — so we never assert "ran it and showed you the result" unless it
  // genuinely did. Each path still lands on beatGauge so the lesson completes; only a clean run earns the win.
  function onRunEnd(p) {
    if (!active) return;
    const reason = p && p.reason;
    let line;
    if (sawDeny) {
      line = 'and you killed it — good. that wasn’t for show: your “deny” stuck, nothing got written, and the run stopped cold. that pause is your hand on the switch, every time.';
    } else if (reason === 'done') {
      cleanRunId = (p && p.runId) || null;   // a clean, un-denied demo run — the ONLY ticket to the handoff pitch
      const did = sawPermission
        ? 'i walked over, asked your permission first, ran it, and showed you the result instead of just claiming it.'
        : 'i walked over, ran it right here on your machine, and showed you the result instead of just claiming it.';
      line = 'and… done. that was the whole loop, for real: ' + did;
    } else {
      // the run reached the desk but didn't finish clean (error / stopped / limit) — never claim a result we don't have.
      line = 'and… that one didn’t land — it errored out before it finished. that’s the honest part: it’s real, so real things can fail sometimes. the loop’s still the loop — ask, i work, i prove it, you stay in control.';
    }
    setTimeout(() => { if (active) say([seg(line, 42, 600)], beatGauge); }, 500);
  }
  // every post-run beat early-outs on !active, so a "skip intro" mid-run halts the chain cleanly
  function beatGauge() {
    if (!active) return;
    say([seg('that little bank by my desk is my memory filling up — green fine, red means i’m losing the early stuff.', 42, 0)], beatCrew);
  }
  function beatCrew() {
    if (!active) return;
    spotlight('#left');
    say([
      seg('one honest thing, because i won’t lie to you: right now it’s just me.', 42, 360),
      seg('  the others in that crew list are echoes — minds you haven’t recruited yet. recruit one and it takes a station of its own — and i start handing it the pieces. that’s the real job: i grow the crew, then i point it.', 42, 0)
    ], () => { clearSpot(); beatHandoff(); });
  }
  function beatHandoff() {
    if (!active) return;
    say([seg('that’s the shape of it: ask, i work, i prove it, you stay in control.', 44, 420)], () => {
      if (!active) return;
      // THE GRADUATION HANDOFF. The demo was a real completed task, so if the station also knows enough about
      // its Commander, the agent ends the tour by POINTING — the First Pitch fires right here instead of the
      // dead-end "go on, i'm yours to point" (a beginner has no idea where to point; that's the whole reason
      // the pitch exists). The auto pitch path correctly stood down while the tour's panel was up
      // (dialogue-open guard); this is the tour handing it the stage deliberately at its close. Falls back to
      // the classic close whenever the pitch can't land (skipped/denied/failed demo, cold dossier, no brain,
      // model hiccup) — the tour never stalls on it, and the un-fired pitch stays armed for a later real task.
      const classicClose = () => {
        if (!active) return;
        say([seg('you’ve already kitted me out and seen me work. your next moves stay pinned under ⚑ QUESTS in the ▤ WORK dock — recruit a specialist, lay a belt, bind a portal. go on. i’m yours to point.', 44, 0)],
          () => Chat.choices([{ label: '▸ START COMMANDING', value: 'done' }], () => finishUp(false)));
      };
      const offered = (cleanRunId && typeof PitchStore !== 'undefined' && PitchStore.offerAtHandoff)
        ? PitchStore.offerAtHandoff(cleanRunId) : Promise.resolve(false);
      Promise.resolve(offered).then(delivered => {
        if (!active) return;
        if (delivered) return finishUp(false);   // the pitch (and any "let's build it" run) IS the handoff
        classicClose();
      }, classicClose);
    });
  }

  // clear every kit-out timer in one place so finishUp/teardown/close can't leak one (the teardown contract).
  function clearKitTimers() {
    if (kitPollTimer) { clearTimeout(kitPollTimer); kitPollTimer = null; }
    if (kitFlashTimer) { clearTimeout(kitFlashTimer); kitFlashTimer = null; }
    if (kitReadyTimer) { clearTimeout(kitReadyTimer); kitReadyTimer = null; }
  }

  function finishUp(skipped) {
    if (finished) return; finished = true;        // idempotent: a late START-COMMANDING click after a skip can't re-run this
    active = false; kitMode = false; clearStall(); clearSpot(); clearCoach(); hideSkip();
    clearKitTimers();   // drop the kit-out poll + flash + ready timers if they bailed mid-placement
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) Dialogue.close();   // reveal COMMS — the tour is over
    // release the roleplay sit (the tour walked the hero to its desk via setActivity('task')); only when no
    // REAL run drove it (a demo's post-run state is owned by the harness — don't yank it).
    if (!sawStart) { try { if (typeof World !== 'undefined' && World.setActivity) World.setActivity('idle'); } catch (_) {} }
    state.firstCommandDone = true;
    if (skipped) state.briefDismissed = true;     // opting out of the tour opts out of the nag — reopen in § FIELD MANUAL
    save();
    if (skipped) { if (hasChat()) Chat.localLine('right. i’m here when you need me — just type. the field manual’s in the bottom bar when you want it.'); }
    else { sfx('level'); if (!state.briefDismissed && !state.briefComplete) setTimeout(showBrief, 600); }   // hand them the first-steps map
    // THE FLOOR — the tour NEVER ends in silence, the skip path included. Two guaranteed beats, both
    // one-shot: (1) the station offers one concrete first move (PitchStore.offerStarter — generated from
    // the dossier when the brain is live, the quest-log pointer when it isn't; moot if the handoff pitch
    // already delivered), and (2) a coachmark points at the quest log itself — the map says NOTHING glowed
    // at tour end, so a skipper never even learned quests exist. Anchored on the always-visible WORK dock
    // button (never a hidden menu item — the dock-menu spotlight trap).
    setTimeout(() => {
      if (typeof PitchStore !== 'undefined' && PitchStore.offerStarter) PitchStore.offerStarter();
      showCoach('quests', '.bb-group[data-group="work"] .bb-grp',
        'your next moves are pinned under ▤ WORK ▸ ⚑ QUESTS — real progress, tracked as quests. nothing in there is ever gated.');
    }, skipped ? 900 : 1400);
  }

  function seen(key) { return !!state.seen[key]; }
  function markSeen(key) { state.seen[key] = true; save(); }

  /* ================= P2 — JUST-IN-TIME COACHMARKS =================
     One short, agent-voiced hint the first time the Commander touches a surface. Unlike the First
     Command's focused scrim, these DON'T block — a small panel glued to the surface + a soft ring, so
     you keep building while you read. Fired by DIRECT calls (build.js / app.js / xpstore.js), never a
     bus emit, so the owned shared/events.js contract + the lint-emits gate stay untouched. Each fires
     once ever (persisted on show), is suppressed during the First Command, and respects reduced-motion. */

  function reduceMotion() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } }
  function agentLabel() {                 // the live agent name from the topbar, so a coach reads in-voice
    const e = document.getElementById('gt-agent');
    const n = e && e.textContent && e.textContent.trim();
    return (n && n !== '—') ? n : (agentName !== 'AGENT' ? agentName : 'your agent');
  }

  let coach = null;   // { bubble, ring, anchor, raf, onKey }
  function clearCoach() {
    if (!coach) return;
    if (coach.raf) cancelAnimationFrame(coach.raf);
    if (coach.onKey) window.removeEventListener('keydown', coach.onKey);
    if (coach.ring) coach.ring.remove();
    if (coach.bubble) coach.bubble.remove();
    coach = null;
  }
  // glue the bubble (and ring) to the anchor every frame — survives camera/layout shifts and self-clears
  // the moment the surface is gone (e.g. REFIT closed out from under a REFIT coach).
  function placeCoach() {
    if (!coach) return;
    const a = coach.anchor, b = coach.bubble;
    // kit-out coaches are CSS-pinned to a safe zone (.tut-coach.kit); only the ring tracks the live target, and a
    // momentarily-missing target (palette re-render) just hides the ring rather than tearing down the bubble.
    if (coach.kit) {
      if (coach.ring) {
        if (a && document.contains(a)) {
          const r = a.getBoundingClientRect(), p = 5;
          coach.ring.style.display = '';
          coach.ring.style.left = (r.left - p) + 'px'; coach.ring.style.top = (r.top - p) + 'px';
          coach.ring.style.width = (r.width + p * 2) + 'px'; coach.ring.style.height = (r.height + p * 2) + 'px';
        } else { coach.ring.style.display = 'none'; }
      }
      coach.raf = requestAnimationFrame(placeCoach);
      return;
    }
    if (a && !document.contains(a)) { clearCoach(); return; }
    if (a) {
      const r = a.getBoundingClientRect();
      if (coach.ring) { const p = 5; coach.ring.style.left = (r.left - p) + 'px'; coach.ring.style.top = (r.top - p) + 'px'; coach.ring.style.width = (r.width + p * 2) + 'px'; coach.ring.style.height = (r.height + p * 2) + 'px'; }
      const bw = b.offsetWidth || 300, bh = b.offsetHeight || 90, gap = 12;
      const vw = window.innerWidth || 1280, vh = window.innerHeight || 800;   // fallback so a 0×0 report can't fling it off-screen
      const left = Math.max(8, Math.min(r.left, vw - bw - 8));               // clamp-min last: never below 8, even in a narrow window
      let top = r.bottom + gap;
      if (top + bh > vh - 8) top = Math.max(8, r.top - bh - gap);            // flip above if it would clip the bottom
      b.style.left = left + 'px'; b.style.top = top + 'px';
    }
    coach.raf = requestAnimationFrame(placeCoach);
  }
  function showCoach(key, anchorSel, text, opts) {
    opts = opts || {};
    if (active || seen(key)) return;     // never during the First Command; once ever
    // don't paint over an open panel (e.g. the Field Manual) — defer (not marked seen) until it's closed.
    // EXCEPT a one-shot whose trigger never re-fires (level-up): show it over the panel rather than lose it forever.
    if (!opts.overTerms && document.querySelector('#terms .term')) return;
    markSeen(key);                       // mark on SHOW so an ignored hint still never repeats
    clearCoach();
    const anchor = anchorSel ? (typeof anchorSel === 'string' ? document.querySelector(anchorSel) : anchorSel) : null;
    const bubble = document.createElement('div');
    bubble.className = 'tut-coach' + (reduceMotion() ? ' no-anim' : '');
    bubble.setAttribute('role', 'status'); bubble.setAttribute('aria-live', 'polite');   // announce the hint to assistive tech
    const who = document.createElement('div'); who.className = 'tut-coach-who'; who.textContent = agentLabel();
    const body = document.createElement('div'); body.className = 'tut-coach-body'; body.textContent = text;
    const ok = document.createElement('button'); ok.className = 'tut-coach-ok'; ok.textContent = opts.ok || '✓ got it';
    ok.onclick = () => { sfx('click'); clearCoach(); };
    bubble.appendChild(who); bubble.appendChild(body); bubble.appendChild(ok);
    document.body.appendChild(bubble);
    let ring = null;
    if (anchor) { ring = document.createElement('div'); ring.className = 'tut-ring' + (reduceMotion() ? ' no-anim' : ''); document.body.appendChild(ring); }
    const onKey = e => { if (e.key === 'Escape') clearCoach(); };
    window.addEventListener('keydown', onKey);
    coach = { bubble, ring, anchor, raf: 0, onKey };
    placeCoach();
    sfx('open');
  }

  /* ---- the catalog: one direct hook per surface (callers guard with typeof Tutorial) ---- */
  function onBuildOpen() {
    if (kitMode) return;   // during the guided kit-out, kitTick drives REFIT — don't stack the generic coachmark on top
    showCoach('build', '#refit-tools',
      'this is REFIT — the floor isn’t decoration. where you put things changes what i can do. keys 1–7 up top: 6 places gear, 7 lays belts.');
  }
  function onPropPlaced(propType) {
    const grant = (typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp) ? WorldModel.grantLabelForProp(propType) : null;
    if (kitMode) return kitOnPropPlaced(grant);   // the kit-out owns placement while it runs
    tickBrief('build');
    let msg;
    // HONEST (truthful-telemetry): a fresh solo station is COMPUTE-ONLY, so placing a cap-prop genuinely UNLOCKS
    // that power for the hero (heroCaps picks it up) — it did NOT "already come with it". Frame it as a real unlock.
    if (grant === 'COMPUTE') {                   // compute is the always-on freebie; a desk just gives the body a real seat to work at
      msg = 'that’s a workstation — compute’s already mine (i can always think), so this just gives my body a real desk to walk to and work at. the powers that actually unlock are files, web, terminal, memory.';
    } else if (grant) {                          // cabinet/dish/workbench/server: a REAL unlock on the solo station
      msg = 'that just switched ' + grant + ' on for me — i can use it now, for real. drop the same gear in a CREW agent’s room later and it’s their key too. place a power, gain a power — that’s the whole game.';
    } else {                                     // inert decor
      msg = 'nice. the gear that grants a power wears its name — a workbench gives me a TERMINAL, a dish reaches the WEB, a cabinet opens FILES. the rest is yours to decorate.';
    }
    showCoach('prop', '#refit-palette', msg);
  }
  function onBeltPlaced() {
    tickBrief('belt');
    showCoach('belt', '#refit-test',
      'belts show real work moving between us. want to see it without waiting for a message? hit ▸ TEST — i’ll send dummy crates down the line so you can watch them sort.');
  }
  function onConnectorPlaced() {
    tickBrief('build'); tickBrief('connector');
    showCoach('connector', '#refit-palette',
      'that’s a portal — it wires me to a live tool server. the panel here lists them; bind one and its powers show up in my hands. the lamp says it’s alive: green good, red broken.');
  }
  function onLevelUp() {
    tickBrief('level');
    showCoach('levelup', '#tb-station',
      'i leveled — that’s real work shipped, not flattery. open my dossier → GROWTH to see how reliable i’ve actually been. it stays honest: “—” until it’s earned enough runs to judge.',
      { overTerms: true });   // a level transition fires exactly once — show it even over an open panel rather than drop it
  }

  /* ================= P3 — STATION BRIEFING (first-steps checklist) =================
     A small, dismissible in-game checklist that ticks off REAL first actions. NOT a gate — a soft map,
     skippable, sandbox-friendly. Auto-completes and bows out; reopenable from the Field Manual. */

  const STEPS = [
    { k: 'command',   label: 'Give your agent a command' },
    { k: 'approve',   label: 'Approve a tool request' },
    { k: 'build',     label: 'Place a piece of gear in REFIT' },
    { k: 'belt',      label: 'Lay a conveyor belt' },
    { k: 'connector', label: 'Bind a connector portal' },
    { k: 'level',     label: 'Reach Level 2' }
  ];
  const briefDone = k => !!state.brief[k];
  const briefCount = () => STEPS.reduce((n, s) => n + (briefDone(s.k) ? 1 : 0), 0);
  const briefAll = () => briefCount() === STEPS.length;

  let briefEl = null, briefDoneTimer = 0, briefResize = null, briefKey = null;
  // sit just RIGHT of the interactive left rail (crew + workstreams), over the stage gutter — never
  // covering the rail's controls. Recomputed on resize. Falls back to a fixed inset if the rail is absent.
  function placeBrief() {
    if (!briefEl) return;
    const rail = document.getElementById('left');
    const railRight = rail && rail.getBoundingClientRect ? rail.getBoundingClientRect().right : 0;
    const comms = document.getElementById('chat-panel');
    const vw = window.innerWidth || 1280;
    const commsLeft = comms && comms.getBoundingClientRect ? comms.getBoundingClientRect().left : vw;
    const bw = briefEl.offsetWidth || 246;
    let left = railRight > 0 ? railRight + 12 : 14;
    left = Math.min(left, commsLeft - bw - 12, vw - bw - 12);   // never overlap COMMS or run off the right edge (narrow windows)
    briefEl.style.left = Math.max(8, left) + 'px';
  }
  function renderBrief() {
    if (!briefEl) return;
    briefEl.querySelector('.tut-brief-count').textContent = briefCount() + '/' + STEPS.length;
    const list = briefEl.querySelector('.tut-brief-list');
    list.innerHTML = '';
    for (const s of STEPS) {
      const li = document.createElement('li');
      li.className = 'tut-brief-item' + (briefDone(s.k) ? ' done' : '');
      const box = document.createElement('span'); box.className = 'tut-brief-box'; box.textContent = briefDone(s.k) ? '✓' : '▫';
      const lbl = document.createElement('span'); lbl.textContent = s.label;
      li.appendChild(box); li.appendChild(lbl); list.appendChild(li);
    }
  }
  function dismissBrief() { state.briefDismissed = true; save(); sfx('click'); hideBrief(); }
  function showBrief() {
    if (state.briefDismissed || state.briefComplete) return;
    if (document.querySelector('#terms .term')) return;   // don't cover an open panel — onEnterGame re-offers later
    if (briefEl) { renderBrief(); return; }
    const game = document.getElementById('screen-game');
    if (!game || !game.classList.contains('active')) return;   // game room only
    briefEl = document.createElement('div'); briefEl.className = 'tut-brief' + (reduceMotion() ? ' no-anim' : '');
    briefEl.setAttribute('role', 'status'); briefEl.setAttribute('aria-live', 'polite');
    const head = document.createElement('div'); head.className = 'tut-brief-head';
    const title = document.createElement('span'); title.className = 'tut-brief-title'; title.textContent = '▸ FIRST STEPS';
    // scope the live-region to the count so each tick announces "3/6", not a re-read of all six rows
    const count = document.createElement('span'); count.className = 'tut-brief-count'; count.setAttribute('aria-live', 'polite'); count.setAttribute('aria-atomic', 'true');
    const x = document.createElement('button'); x.className = 'tut-brief-x'; x.title = 'dismiss'; x.textContent = '✕';
    x.onclick = dismissBrief;
    head.appendChild(title); head.appendChild(count); head.appendChild(x);
    const list = document.createElement('ul'); list.className = 'tut-brief-list'; list.setAttribute('aria-live', 'off');   // suppress full-list re-read on each tick (the count carries the delta)
    const foot = document.createElement('div'); foot.className = 'tut-brief-foot'; foot.textContent = 'reopen any time — § FIELD MANUAL in the ▣ SYSTEM dock';
    briefEl.appendChild(head); briefEl.appendChild(list); briefEl.appendChild(foot);
    document.body.appendChild(briefEl);
    placeBrief();
    briefResize = () => placeBrief(); window.addEventListener('resize', briefResize);
    // Esc dismisses (matching the coachmark) — but not while REFIT or another panel owns Esc
    briefKey = e => { if (e.key === 'Escape' && !document.querySelector('.refit-overlay') && !document.querySelector('#terms .term')) dismissBrief(); };
    window.addEventListener('keydown', briefKey);
    renderBrief();
  }
  function hideBrief() {
    if (briefDoneTimer) { clearTimeout(briefDoneTimer); briefDoneTimer = 0; }
    if (briefResize) { window.removeEventListener('resize', briefResize); briefResize = null; }
    if (briefKey) { window.removeEventListener('keydown', briefKey); briefKey = null; }
    if (briefEl) { briefEl.remove(); briefEl = null; }
  }
  function tickBrief(k) {
    if (!state.brief[k]) {
      state.brief[k] = true; save();
      if (briefEl) {
        renderBrief();
        const item = briefEl.querySelectorAll('.tut-brief-item')[STEPS.findIndex(s => s.k === k)];
        if (item && !reduceMotion()) item.classList.add('flash');
        sfx('truth');
      }
    }
    if (briefAll() && !state.briefComplete) {
      state.briefComplete = true; save();
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('first steps complete — you’ve got the controls', 'gold');
      if (briefEl) {
        briefEl.classList.add('complete');
        const t = briefEl.querySelector('.tut-brief-title'); if (t) t.textContent = '✓ FIRST STEPS COMPLETE';
        briefDoneTimer = setTimeout(hideBrief, 4200);
      }
    }
  }

  /* ================= P3 — FIELD MANUAL (the reopenable codex) =================
     Opened from the bottom-bar § FIELD MANUAL term, SYSTEM dock (stationui BUILDERS delegates here). Every entry is tagged
     REAL or FOR SHOW, sourced from the live CAP_PROP_MAP + conveyor contract — the honesty mandate, on a page. */

  function fmEntry(tag, title, body) {
    const t = tag ? '<span class="fm-tag ' + (tag === 'REAL' ? 'real">REAL' : 'show">FOR SHOW') + '</span>' : '';
    return '<div class="fm-entry">' + t + '<div class="fm-entry-h">' + title + '</div><div class="fm-entry-b">' + body + '</div></div>';
  }
  const FM_TABS = ['FIRST STEPS', 'THE LOOP', 'GEAR', 'WIRING', 'GROWTH'];
  function fmContent(tab) {
    if (tab === 'FIRST STEPS') {
      let h = '<p class="fm-lead">a soft checklist — not a gate. any order, or skip them. each ticks when you actually do it.</p><ul class="fm-steps">';
      for (const s of STEPS) h += '<li class="' + (briefDone(s.k) ? 'done' : '') + '"><span>' + (briefDone(s.k) ? '✓' : '▫') + '</span> ' + s.label + '</li>';
      return h + '</ul>';
    }
    if (tab === 'THE LOOP') {
      return '<p class="fm-lead">one loop runs everything here, and it’s all real:</p>'
        + fmEntry('REAL', '1 · ASK', 'type a job in COMMS. small talk i answer in place; a real task and i get up.')
        + fmEntry('REAL', '2 · WALK', 'i cross to my workstation. that desk is where i actually go to work, on your machine.')
        + fmEntry('REAL', '3 · CONSENT', 'before i touch a file or reach out i stop and ask — approve once, always, or kill it.')
        + fmEntry('REAL', '4 · RUN', 'i execute the real tools you’ve granted me — web search, file read/write — and stream the result to COMMS.')
        + fmEntry('REAL', '5 · PROVE', 'i verify the work and show the outcome instead of just claiming it.')
        + '<p class="fm-note">the crew in the left rail are echoes for now — placeholders until you recruit more minds. today it’s one of me, running the whole loop.</p>';
    }
    if (tab === 'GEAR') {
      return '<p class="fm-lead">a prop in my room is a PERMISSION. drop these in a bay’s room to grant a power; most other furniture is set dressing.</p>'
        + fmEntry('REAL', 'WORKSTATION → a desk to work at', 'desk · console · bench · pixel rig. compute to think is always mine — a workstation just gives my body a real desk to walk to and sit at, and its screens light while i work.')
        + fmEntry('REAL', 'CABINET → files', 'intel cab · safe · vault · rack · shelf. read &amp; write files in my workspace.')
        + fmEntry('REAL', 'DISH → web', 'comms dish · uplink · beacon. reach the live web.')
        + fmEntry('REAL', 'SERVER → memory + skills', 'server cart · relay stack · core. a notebook that survives restarts — and the skill library where i save &amp; reload reusable procedures.')
        + fmEntry('REAL', 'CONNECTOR PORTAL → live tools', 'binds one MCP server; its tools land in my hands. lamp = health: green live, amber warming, red broken.')
        + fmEntry('REAL', 'WORKBENCH → terminal', 'the powered bench. place it in my room and i can run real shell commands and verify what they did — consent-gated, like every tool. it glows while i’m running code.')
        + fmEntry('SHOW', 'everything else', 'plants, rugs, screens, lounge gear — flavour. they grant nothing; place them because the place is yours.');
    }
    if (tab === 'WIRING') {
      return '<p class="fm-lead">belts let you SEE work move between stations — and route it. heads up: real work runs server-side whether or not you’ve laid a belt. the belt only ever shows it.</p>'
        + fmEntry('REAL', 'BELT (key 7)', 'lay a line; boxes ride it. a box is a real work-item, not decoration.')
        + fmEntry('REAL', 'INTAKE / OUTBOX', 'work enters at an intake; the reply leaves at an outbox.')
        + fmEntry('REAL', 'BAY', 'binds a spot to an agent — work reaching it runs as that agent, with that room’s gear.')
        + fmEntry('REAL', 'FILTER / MERGER / SPLITTER', 'route by tag, gather many into one, or fan out across agents — real branching of the pipeline.')
        + fmEntry('REAL', 'AIRLOCK', 'seal a room and the agent can’t path out — an unmerged worktree, made physical.')
        + fmEntry('REAL', '▸ TEST', 'no message handy? hit TEST in REFIT — dummy crates ride your belts so you can watch them sort.')
        + fmEntry('SHOW', 'box bob · chevrons · cargo colours', 'pure juice — they make the flow legible, they don’t change what runs.');
    }
    return '<p class="fm-lead">your agent grows off real outcomes — no fake bars.</p>'
      + fmEntry('REAL', 'LEVEL / XP', 'climbs only on real shipped work; never drops. the top-bar STATION chip is every agent’s level, rolled up.')
      + fmEntry('REAL', 'CONFIDENCE', 'a reliability read that moves both ways. shows “—” until it has enough real runs to be honest.')
      + fmEntry(null, 'where to look', 'open a dossier → GROWTH for the bars, the confidence gauge, and the milestone case.');
  }
  function fillFieldManual(body) {
    if (!body) return;
    let curTab = 'FIRST STEPS';
    body.classList.add('fm-body');
    const render = () => {
      body.innerHTML =
        '<div class="fm-tabs">' + FM_TABS.map(t => '<button class="fm-tab' + (t === curTab ? ' on' : '') + '" data-t="' + t + '">' + t + '</button>').join('') +
        '</div><div class="fm-content">' + fmContent(curTab) + '</div>';
      body.querySelectorAll('.fm-tab').forEach(b => { b.onclick = () => { curTab = b.dataset.t; sfx('click'); render(); }; });
    };
    render();
  }

  /* lifecycle entry from app.js enterGame: arm the bus ticks (even for skippers/returners) and, for a
     returning user mid-progress, re-offer the first-steps map. Fresh users get it from finishUp instead. */
  function onEnterGame() {
    wireBus();
    if (state.firstCommandDone && !state.briefDismissed && !state.briefComplete) setTimeout(showBrief, 900);
  }

  // full teardown for DISCONNECT (app.js): drop every body-appended overlay + its loop/listeners so none
  // leak onto the title screen (a live coachmark otherwise keeps a self-rescheduling rAF + a keydown bound).
  function teardown() {
    active = false; kitMode = false; clearStall();
    clearKitTimers();
    clearCoach(); clearSpot(); hideSkip(); hideBrief();
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) Dialogue.close();
  }

  // G1c coordination — is the tutorial ACTIVELY coaching right now (a live coach bubble / the kit-out loop /
  // the awakening tour)? The deferred BUILD-dock glow (dockglow.js) checks this and stands down while true —
  // the tutorial's own targeting always wins, so the two never glow different controls at once.
  function isCoaching() { return !!(active || kitMode || coach); }

  return {
    firstCommand, spotlight, seen, markSeen, _state: () => state,
    onBuildOpen, onPropPlaced, onBeltPlaced, onConnectorPlaced, onLevelUp, clearCoach,
    onEnterGame, fillFieldManual, showBrief, tickBrief, teardown, isCoaching
  };
})();
