/* SKYNET — tutorial.js : THE FIRST COMMAND (diegetic onboarding — P0 scaffold + P1).

   The mind that just woke up (onboarding.js) keeps talking — and teaches the Commander the ONE
   real loop by walking them through a single real command. There is NO tooltip chrome: every word
   is the agent speaking in COMMS (Chat.typeLine), every choice is Chat.choices, and the teaching
   beats are timed to REAL run events on U.bus (agent.run.start / permission.prompt / agent.run.end)
   so the Commander watches the genuine thing happen — the desk trip, the real consent prompt, the
   real result — never a simulation.

   Honest by mandate (this serves the polish-audit through-line "make the one real loop visible +
   shrink what lies"): it names the crew as echoes, never fakes a number, and the very first task is
   a real, near-free shell command (echo) — so the Commander sees the true consent→execute→prove loop.

   Lifecycle: fires once, right after the awakening lands (app.js passes Onboarding.start({ taught })).
   Fully skippable; a self-owned localStorage flag (skynet.tutorial.v1) means it never repeats. The
   seen()/markSeen() helpers are the hook for P2 just-in-time coachmarks (not wired yet). */
'use strict';

const Tutorial = (() => {
  const KEY = 'skynet.tutorial.v1';
  let state = load();
  let active = false, wired = false;
  let agentName = 'AGENT';
  // one-shot latches so a repeated bus event can never double-narrate a beat
  let sawStart = false, sawPermission = false, sawEnd = false;

  function load() {
    try { const r = JSON.parse(localStorage.getItem(KEY)); if (r && r.v === 1) return r; } catch (_) {}
    return { v: 1, firstCommandDone: false, seen: {} };
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
  // a real, near-free, unambiguously tool-requiring task: the Commander sees the genuine
  // walk → consent → shell.exec → result loop for a fraction of a cent.
  const TASK = 'run this in your shell and show me the output: echo "skynet online"';

  function firstCommand(opts) {
    if (state.firstCommandDone) return;       // learned once, never again
    if (!hasChat()) return;
    agentName = (opts && opts.name) || agentName;
    active = true; sawStart = sawPermission = sawEnd = false;
    wireBus(); showSkip();
    // Beat 1 — orient
    setTimeout(() => say([
      seg('actually — before you point me anywhere, let me show you how i actually work. about a minute.', 46, 520),
      seg('  or skip it. i won’t be offended. much.', 46, 0)
    ], () => Chat.choices(
      [{ label: '▸ SHOW ME', value: 'go' }, { label: 'skip', value: 'skip' }],
      it => (it.value === 'skip') ? finishUp(true) : beatCommand()
    )), 600);
  }

  // Beat 2 — the command. COMMS is lit; one real-task chip, plus a heads-up for what they'll see.
  function beatCommand() {
    spotlight('#chat-panel');
    say([
      seg('this box is COMMS — you talk to me here. small talk, and i answer from this chair.', 46, 420),
      seg('  but hand me a real job and i get up and go to work. watch what that looks like — tap this:', 46, 0)
    ], () => Chat.choices([{ label: '▸ run: echo "skynet online"', value: 'run' }], () => {
      clearSpot();
      say([seg('watch the floor — i’m heading to my station, and i’ll stop to ask before i touch anything.', 44, 0)],
        () => { if (typeof Chat.send === 'function') Chat.send(TASK); });   // hand off to the REAL loop
    }));
  }

  /* ---- bus-timed beats: the real run drives the rest of the lesson ----
     util.js's bus has no off(); every handler is guarded by `active` so post-tutorial runs are ignored. */
  function wireBus() {
    if (wired || typeof U === 'undefined' || !U.bus) return;
    wired = true;
    U.bus.on('agent.run.start', () => { if (active && !sawStart) { sawStart = true; onRunStart(); } });
    U.bus.on('permission.prompt', () => { if (active && !sawPermission) { sawPermission = true; onPermission(); } });
    U.bus.on('agent.run.end', () => { if (active && !sawEnd) { sawEnd = true; onRunEnd(); } });
  }

  // the agent is now walking to the desk (chat.js set World.setActivity('task') the instant the chip fired)
  function onRunStart() {
    say([seg('there i go. that desk is where i actually run code — for real, on your machine. this isn’t a cutscene.', 44, 0)]);
  }
  // the real consent prompt has just been rendered below this line (harness emits on the bus BEFORE chat.js draws the row)
  function onPermission() {
    say([
      seg('stop — see that, just below? before i touch anything that matters it surfaces right here and waits for you.', 44, 360),
      seg('  approve once, always, or kill it. that pause is your hand on the switch. go ahead — approve it.', 44, 0)
    ]);
  }
  // wrap-up: honest whether the run passed, failed, or stopped; the consent line bends to what actually happened
  function onRunEnd() {
    const did = sawPermission
      ? 'i walked over, asked your permission first, ran it, and showed you the result instead of just claiming it.'
      : 'i walked over, ran it right here on your machine, and showed you the result instead of just claiming it.';
    setTimeout(() => say([seg('and… done. that was the whole loop, for real: ' + did, 42, 600)], beatGauge), 500);
  }
  function beatGauge() {
    say([seg('that little bank by my desk is my memory filling up — green’s fine, red means i’m near full and start losing the early stuff. you’ll learn to read it.', 42, 0)], beatCrew);
  }
  function beatCrew() {
    spotlight('#left');
    say([
      seg('one honest thing, because i won’t lie to you: right now it’s just me.', 42, 360),
      seg('  the others in that crew list are echoes — placeholders for minds you haven’t recruited yet. recruit one and it takes a station of its own.', 42, 0)
    ], () => { clearSpot(); beatHandoff(); });
  }
  function beatHandoff() {
    say([
      seg('that’s the shape of it: ask, i work, i prove it, you stay in control.', 44, 420),
      seg('  the belts, the gear, watching me level up — i’ll show you when you get there. go on. i’m yours to point.', 44, 0)
    ], () => Chat.choices([{ label: '▸ START COMMANDING', value: 'done' }], () => finishUp(false)));
  }

  function finishUp(skipped) {
    active = false; clearSpot(); hideSkip();
    state.firstCommandDone = true; save();
    if (skipped) { if (hasChat()) Chat.localLine('right. i’m here when you need me — just type.'); }
    else sfx('level');
  }

  /* ---- P2 hook (defined now, wired later): one-shot contextual coachmarks keyed by surface ---- */
  function seen(key) { return !!state.seen[key]; }
  function markSeen(key) { state.seen[key] = true; save(); }

  return { firstCommand, seen, markSeen, spotlight, _state: () => state };
})();
