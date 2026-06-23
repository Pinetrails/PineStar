/* SKYNET — tutorial.js : THE FIRST COMMAND + coachmarks + Field Manual (diegetic onboarding, P0–P3).

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
   Fully skippable; a self-owned localStorage flag (skynet.tutorial.v1) means it never repeats.
   P2 = just-in-time coachmarks (seen()/markSeen()); P3 = the Field Manual codex + Station Briefing. */
'use strict';

const Tutorial = (() => {
  const KEY = 'skynet.tutorial.v1';
  let state = load();
  let active = false, wired = false, finished = false;
  let agentName = 'AGENT';
  // one-shot latches so a repeated bus event can never double-narrate a beat
  let sawStart = false, sawPermission = false, sawEnd = false, sawDeny = false;
  let stallTimer = null;   // failsafe: if the real run never reaches the bus (sidecar down / bad key), narrate honestly instead of freezing
  // THE KIT-OUT (the floor is REAL): the first lesson is the moat — the Commander PLACES the capability gear
  // (cabinet→FILES · dish→WEB · workbench→TERMINAL · server→MEMORY) and each placement hands the agent a genuine
  // power (heroCaps → the run's real tools), so the first real job runs against tools that actually exist.
  let kitMode = false, kitNeeded = null, kitComplete = false, kitWasOpen = false, kitPollTimer = null;

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
  // when its prop lands (cabinet→FILES, dish→WEB, workbench→TERMINAL, server→MEMORY); FILES is first so the demo
  // that follows is honest. COMPUTE isn't here (it's the always-on freebie + a synthetic desk) and a WORKSTATION
  // prop is editable (it doesn't fire onPropPlaced), so neither belongs in the placement loop.
  const KIT = [
    { grant: 'FILES',    look: 'the CABINET',     power: 'FILES',       got: 'now i can read and write files — that’s where i keep anything that matters.' },
    { grant: 'WEB',      look: 'the DISH',        power: 'the WEB',     got: 'and now the live web — real search, real pages, not just what i woke up knowing.' },
    { grant: 'TERMINAL', look: 'the WORKBENCH',   power: 'a TERMINAL',  got: 'a real terminal — i can run commands and check what they did, and you approve each one.' },
    { grant: 'MEMORY',   look: 'the SERVER CART', power: 'MEMORY',      got: 'memory that survives a restart, so i don’t wake up blank every time.' }
  ];

  function firstCommand(opts) {
    if (state.firstCommandDone) return;       // learned once, never again
    if (!hasChat()) return;
    agentName = (opts && opts.name) || agentName;
    active = true; finished = false; sawStart = sawPermission = sawEnd = sawDeny = false;   // C1: un-latch finishUp for this fresh run (it's symmetric with the saw-flags; without it a prior agent's completed lesson left finishUp a no-op)
    kitMode = false; kitComplete = false; kitWasOpen = false; kitNeeded = null;
    wireBus(); showSkip();
    // Beat 1 — orient. Picks up the awakening's closing "so — where do we begin?" as one continuous voice, then
    // names the one rule that runs the whole place: an empty room is an empty agent; what you build, i can do.
    setTimeout(() => say([
      seg('where we begin — look around. this room’s bare, and a bare room means i can’t actually touch anything yet.', 46, 460),
      seg('  here’s the one rule of this whole place: what you build, i can do. so let’s kit me out — every piece you place hands me a real power. a minute, tops.', 46, 0)
    ], () => Chat.choices(
      [{ label: '▸ KIT ME OUT', value: 'go' }, { label: 'skip', value: 'skip' }],
      it => (it.value === 'skip') ? finishUp(true) : beatKitIntro()
    )), 600);
  }

  /* ---- THE KIT-OUT: guided REFIT placement. REFIT is a full-screen overlay (it covers COMMS), so guidance in
     there is a floating coach bubble over the palette; the narrative beats before/after use COMMS. kitWatch polls
     the REFIT open/closed state so a close (early or complete) always advances cleanly — no freeze, no app-lie. */
  function beatKitIntro() {
    if (!active) return;
    kitMode = true; kitComplete = false; kitWasOpen = false;
    kitNeeded = new Set(KIT.map(k => k.grant));
    spotlight('#bb-build');
    say([
      seg('see that REFIT button, bottom bar? open it — that’s where you build my floor.', 46, 380),
      seg('  i’ll talk you through it from in there. we start with the CABINET.', 46, 0)
    ], () => { clearSpot(); kitWatch(); });
  }
  // single source of truth for REFIT open/close transitions during the kit-out (more robust than the one-shot
  // onBuildOpen hook — catches a close from any path). Self-clears on finishUp/teardown.
  function kitWatch() {
    if (!active || !kitMode) return;
    const open = !!(typeof Build !== 'undefined' && Build.isOpen && Build.isOpen());
    if (open && !kitWasOpen) { kitWasOpen = true; kitOnRefitOpen(); }
    else if (!open && kitWasOpen) { kitWasOpen = false; return kitClosedDuringPlace(); }
    kitPollTimer = setTimeout(kitWatch, 300);
  }
  function nextKit() { return kitNeeded ? KIT.find(k => kitNeeded.has(k.grant)) : null; }
  function kitOnRefitOpen() {
    if (!active || !kitMode) return;
    clearSpot();
    kitPrompt(true);
  }
  function kitPrompt(first) {
    if (!active || !kitMode) return;
    const k = nextKit();
    if (!k) return beatKitReady();
    kitCoach((first ? 'press 6 for PROP, open the CAPABILITY tab, and drop ' : 'now drop ') + k.look + ' in my room — that one hands me ' + k.power + '.');
  }
  // a placement landed while the kit-out is running (build.js → onPropPlaced → here). grant is the power-word, or
  // null for inert decor. Forgiving + order-free: any needed cap checks off; a spare or decor just nudges onward.
  function kitOnPropPlaced(grant) {
    if (!active || !kitMode) return;
    tickBrief('build');
    if (!grant) { kitCoach('that one’s just set dressing — grants nothing. i need the gear that wears a power-word' + (nextKit() ? ': ' + nextKit().look + '.' : '.')); return; }
    if (!kitNeeded.has(grant)) {
      const m = nextKit();
      kitCoach('already running ' + grant + ' — that’s a spare, no harm. ' + (m ? 'still need ' + m.power + ': ' + m.look + '.' : ''));
      if (!m) beatKitReady();
      return;
    }
    kitNeeded.delete(grant);
    sfx('truth');
    const k = KIT.find(x => x.grant === grant);
    const more = nextKit();
    kitCoach('✓ ' + (k ? k.power : grant) + ' — ' + (k ? k.got : '') + (more ? ' next: ' + more.look + ' (' + more.power + ').' : ' that’s the whole kit.'));
    if (!more) setTimeout(() => { if (active && kitMode) beatKitReady(); }, 1500);
  }
  function beatKitReady() {
    if (!active || !kitMode) return;
    kitComplete = true;
    kitCoach('that’s a fully-equipped agent — files, web, a terminal, memory. hit ✓ DONE up top to close REFIT, and i’ll prove it on a real job.');
    // kitWatch sees the close → kitClosedDuringPlace → beatCommand
  }
  // REFIT closed during the kit-out (complete, or early). With FILES placed we can run the honest file demo; with
  // nothing placed there are genuinely no tools to demo, so we say so plainly and finish the shape in words.
  function kitClosedDuringPlace() {
    if (!active) return;
    kitMode = false; clearCoach();
    if (kitPollTimer) { clearTimeout(kitPollTimer); kitPollTimer = null; }
    const hasFiles = kitNeeded && !kitNeeded.has('FILES');
    if (hasFiles) return beatCommand();
    say([
      seg('closed up early — your call, it’s your floor. but straight with you: with nothing placed i can’t actually do much yet. an empty room is an empty agent.', 44, 460),
      seg('  drop a cabinet in REFIT whenever you like and i’ll show you the real loop. here’s the rest of the shape for now:', 44, 0)
    ], beatGauge);
  }

  // Beat 2 — the real command, now that the agent is genuinely equipped. COMMS is lit; one real-task chip.
  function beatCommand() {
    if (!active) return;
    spotlight('#chat-panel');
    say([
      seg('now the real thing. you’ve been talking to me here in COMMS the whole time — but watch what happens when i get an actual job, now that i’ve got hands.', 46, 420),
      seg('  i’ll use the files you just gave me: write a line, read it back. tap it — and watch me stop to ask before i touch anything.', 46, 0)
    ], () => Chat.choices([{ label: '▸ write & read a file', value: 'run' }], () => {
      clearSpot();
      say([seg('watch the floor — heading to my station, and i’ll ask before i write anything.', 44, 0)],
        () => { if (typeof Chat.send === 'function') Chat.send(TASK); armStall(); });   // hand off to the REAL loop (+ a failsafe if it never reaches the bus)
    }));
  }
  // the floating coach bubble used INSIDE REFIT (which covers COMMS). Reuses the coachmark placement machinery,
  // but without the one-shot/seen guards — it's a live, replaceable prompt that re-anchors each kit step and
  // self-clears when REFIT (its anchor) closes. No "got it" button: the kit-out advances on real placement.
  function kitCoach(text) {
    clearCoach();
    const anchor = document.querySelector('#refit-palette') || document.querySelector('#refit-tools');
    const bubble = document.createElement('div');
    bubble.className = 'tut-coach' + (reduceMotion() ? ' no-anim' : '');
    bubble.setAttribute('role', 'status'); bubble.setAttribute('aria-live', 'polite');
    const who = document.createElement('div'); who.className = 'tut-coach-who'; who.textContent = agentLabel();
    const body = document.createElement('div'); body.className = 'tut-coach-body'; body.textContent = text;
    bubble.appendChild(who); bubble.appendChild(body);
    document.body.appendChild(bubble);
    let ring = null;
    if (anchor) { ring = document.createElement('div'); ring.className = 'tut-ring' + (reduceMotion() ? ' no-anim' : ''); document.body.appendChild(ring); }
    coach = { bubble, ring, anchor, raf: 0, onKey: null };
    placeCoach();
    sfx('open');
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
    say([seg('that little bank by my desk is my memory filling up — green’s fine, red means i’m near full and start losing the early stuff. you’ll learn to read it.', 42, 0)], beatCrew);
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
    say([
      seg('that’s the shape of it: ask, i work, i prove it, you stay in control.', 44, 420),
      seg('  you’ve already kitted me out and seen me work. the belts, the leveling, the rest of the gear — i’ll show you when you get there. go on. i’m yours to point.', 44, 0)
    ], () => Chat.choices([{ label: '▸ START COMMANDING', value: 'done' }], () => finishUp(false)));
  }

  function finishUp(skipped) {
    if (finished) return; finished = true;        // idempotent: a late START-COMMANDING click after a skip can't re-run this
    active = false; kitMode = false; clearStall(); clearSpot(); clearCoach(); hideSkip();
    if (kitPollTimer) { clearTimeout(kitPollTimer); kitPollTimer = null; }   // drop the kit-out REFIT poll if they bailed mid-placement
    state.firstCommandDone = true;
    if (skipped) state.briefDismissed = true;     // opting out of the tour opts out of the nag — reopen in 📖 MANUAL
    save();
    if (skipped) { if (hasChat()) Chat.localLine('right. i’m here when you need me — just type. the field manual’s in the bottom bar when you want it.'); }
    else { sfx('level'); if (!state.briefDismissed && !state.briefComplete) setTimeout(showBrief, 600); }   // hand them the first-steps map
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
    if (kitMode) return;   // during the guided kit-out, kitWatch drives REFIT — don't stack the generic coachmark on top
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
    const foot = document.createElement('div'); foot.className = 'tut-brief-foot'; foot.textContent = 'reopen any time in 📖 MANUAL';
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
     Opened from the bottom-bar 📖 MANUAL term (stationui BUILDERS delegates here). Every entry is tagged
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
        + fmEntry('REAL', 'SERVER → memory', 'server cart · relay stack · core. a notebook that survives restarts.')
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
    if (kitPollTimer) { clearTimeout(kitPollTimer); kitPollTimer = null; }
    clearCoach(); clearSpot(); hideSkip(); hideBrief();
  }

  return {
    firstCommand, spotlight, seen, markSeen, _state: () => state,
    onBuildOpen, onPropPlaced, onBeltPlaced, onConnectorPlaced, onLevelUp, clearCoach,
    onEnterGame, fillFieldManual, showBrief, tickBrief, teardown
  };
})();
