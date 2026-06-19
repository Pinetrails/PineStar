/* SKYNET — tutorial.js : THE FIRST COMMAND + coachmarks + Field Manual (diegetic onboarding, P0–P3).

   The mind that just woke up (onboarding.js) keeps talking — and teaches the Commander the ONE
   real loop by walking them through a single real command. There is NO tooltip chrome: every word
   is the agent speaking in COMMS (Chat.typeLine), every choice is Chat.choices, and the teaching
   beats are timed to REAL run events on U.bus (agent.run.start / permission.prompt / agent.run.end)
   so the Commander watches the genuine thing happen — the desk trip, the real consent prompt, the
   real result — never a simulation.

   Honest by mandate (this serves the polish-audit through-line "make the one real loop visible +
   shrink what lies"): it names the crew as echoes, never fakes a number, and the very first task is
   a real, near-free file write+read (fs.write + fs.read — the `cabinet`/files capability the default
   browser office grants, and fs.write requires consent) — so the Commander sees the true
   consent→execute→prove loop. NOT shell.exec: that needs a `workbench` object no prop grants yet, so
   it would never dispatch in the default station (it'd be answered in plain text, which would lie).

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
  let sawStart = false, sawPermission = false, sawEnd = false;

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
  // a real, near-free task wired in the DEFAULT station: fs.write + fs.read (the `cabinet`/files
  // capability the browser office grants). fs.write requires consent, so the Commander sees the
  // genuine walk → consent → execute → prove loop for a fraction of a cent. NOT shell.exec — that
  // needs a `workbench` object no prop grants yet, so it would never dispatch here (it'd be answered
  // in plain text, breaking the "i prove it, not claim it" promise). Keep the demo to what's real.
  const TASK = 'write the line "skynet online" to a file called hello.txt, then read it back and show me';

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
    ], () => Chat.choices([{ label: '▸ write & read a file', value: 'run' }], () => {
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
    U.bus.on('permission.prompt', () => { tickBrief('approve'); if (active && !sawPermission) { sawPermission = true; onPermission(); } });
    U.bus.on('agent.run.end', () => { tickBrief('command'); if (active && !sawEnd) { sawEnd = true; onRunEnd(); } });
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
  // wrap-up: honest whether the run passed, failed, or stopped; the consent line bends to what actually happened
  function onRunEnd() {
    if (!active) return;
    const did = sawPermission
      ? 'i walked over, asked your permission first, ran it, and showed you the result instead of just claiming it.'
      : 'i walked over, ran it right here on your machine, and showed you the result instead of just claiming it.';
    setTimeout(() => { if (active) say([seg('and… done. that was the whole loop, for real: ' + did, 42, 600)], beatGauge); }, 500);
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
      seg('  the others in that crew list are echoes — placeholders for minds you haven’t recruited yet. recruit one and it takes a station of its own.', 42, 0)
    ], () => { clearSpot(); beatHandoff(); });
  }
  function beatHandoff() {
    if (!active) return;
    say([
      seg('that’s the shape of it: ask, i work, i prove it, you stay in control.', 44, 420),
      seg('  the belts, the gear, watching me level up — i’ll show you when you get there. go on. i’m yours to point.', 44, 0)
    ], () => Chat.choices([{ label: '▸ START COMMANDING', value: 'done' }], () => finishUp(false)));
  }

  function finishUp(skipped) {
    if (finished) return; finished = true;        // idempotent: a late START-COMMANDING click after a skip can't re-run this
    active = false; clearSpot(); hideSkip();
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
    showCoach('build', '#refit-tools',
      'this is REFIT — the floor isn’t decoration. where you put things changes what i can do. keys 1–7 up top: 6 places gear, 7 lays belts.');
  }
  function onPropPlaced() {
    tickBrief('build');
    showCoach('prop', '#refit-palette',
      'nice. every piece you place is a permission — a desk powers me up to work, a dish reaches the web, a cabinet opens files. drop them in my room to hand me the key.');
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
        + fmEntry('REAL', 'WORKSTATION → compute', 'desk · console · bench · pixel rig. no workstation in my room and i literally can’t run (cost-safe).')
        + fmEntry('REAL', 'CABINET → files', 'intel cab · safe · vault · rack · shelf. read &amp; write files in my workspace.')
        + fmEntry('REAL', 'DISH → web', 'comms dish · uplink · beacon. reach the live web.')
        + fmEntry('REAL', 'SERVER → memory', 'server cart · relay stack · core. a notebook that survives restarts.')
        + fmEntry('REAL', 'CONNECTOR PORTAL → live tools', 'binds one MCP server; its tools land in my hands. lamp = health: green live, amber warming, red broken.')
        + fmEntry('SHOW', 'TERMINAL → run commands', 'real in the engine, but locked — no gear grants it yet. it arrives when a workbench prop ships.')
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
    active = false;
    clearCoach(); clearSpot(); hideSkip(); hideBrief();
  }

  return {
    firstCommand, spotlight, seen, markSeen, _state: () => state,
    onBuildOpen, onPropPlaced, onBeltPlaced, onConnectorPlaced, onLevelUp, clearCoach,
    onEnterGame, fillFieldManual, showBrief, tickBrief, teardown
  };
})();
