/* ============================================================================
   SKYNET — audio.js : generative adaptive music + the colony "Director".

   There are no music files. The score is synthesised live on the SAME Web-Audio
   master bus that SFX uses (see util.js), so music and sound effects share one
   limiter and one reverb and sit together. A lookahead scheduler clocks a 16th-
   note grid; layers (drone pad / bass / arpeggio / hat / lead) switch in and out
   with an INTENSITY value, and that intensity is driven by REAL colony activity:
   the Director subscribes to the U.bus event contract (agent runs, tool calls,
   work-items on the belts, deliverables, sales, errors…) and pushes energy in.
   Idle station → a sparse brooding hum. Busy station → faster, brighter, denser.

   Node-safe: this file is browser-only (never loaded by the headless tests) and
   only ever LISTENS on the bus — it emits nothing, so the emit linter ignores it.
   ========================================================================== */
'use strict';

const MUSIC = (function () {
  const BASE = 55;                                   // A1 (Hz) — the key's root
  const SCALE = [0, 2, 3, 5, 7, 8, 10];              // natural minor (Aeolian) — broody, "machine"
  // chord progressions as scale-degree roots (indices into a stacked-thirds scale).
  // calm runs in the home key; tension swaps to a darker, more restless set.
  const PROG_CALM = [0, 5, 3, 4];                    // i  VI  iv  v
  const PROG_TENSE = [0, 1, 6, 4];                   // i  ii° VII v  — unsettled
  const STEPS = 16;                                  // sixteenths per bar (4/4)

  const M = {
    on: true, vol: 0.5, _armed: false, running: false,
    mGain: null, timer: null,
    // director state
    intensity: 0.12, energy: 0, tension: 0, runs: 0,
    // sequencer state
    step: 0, bar: 0, chordIx: 0, nextTime: 0, arpDir: 1, arpN: 0
  };

  /* ---- helpers ---- */
  const hz = degree => BASE * Math.pow(2, Math.floor(degree / 7) + SCALE[((degree % 7) + 7) % 7] / 12);
  const prog = () => (M.tension > 0.5 ? PROG_TENSE : PROG_CALM);
  const chordRoot = () => prog()[M.chordIx % prog().length];
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ---- a music note: own filter+ADSR, routed through the music sub-bus ---- */
  function mNote(o) {
    if (!M.mGain || !SFX.ctx) return;
    const c = SFX.ctx, t0 = o.at, dur = o.dur || 0.3, peak = (o.vol || 0.2);
    const g = c.createGain(), f = c.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = o.cut || 1600; f.Q.value = o.q || 0.6;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + (o.atk || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const type = o.type || 'triangle', det = o.detune || 0;
    const mk = cents => {
      const osc = c.createOscillator(); osc.type = type; osc.frequency.value = o.freq;
      if (cents) osc.detune.value = cents;
      osc.connect(f); osc.start(t0); osc.stop(t0 + dur + 0.05);
    };
    mk(0); if (det) { mk(det); mk(-det); }
    f.connect(g); g.connect(M.mGain);
    if (o.verb && SFX.fx) { const s = c.createGain(); s.gain.value = o.verb; g.connect(s); s.connect(SFX.fx); }
  }

  function mHat(at, vol) {
    if (!M.mGain || !SFX.ctx || !SFX._noise) return;
    const c = SFX.ctx, src = c.createBufferSource(); src.buffer = SFX._noise; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(vol, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
    src.connect(f); f.connect(g); g.connect(M.mGain);
    src.start(at); src.stop(at + 0.06);
  }

  /* ---- schedule everything that should sound on one 16th-note step ---- */
  function scheduleStep(step, at) {
    const I = M.intensity;
    const root = chordRoot();
    const triad = [root, root + 2, root + 4];        // diatonic stacked thirds
    const bright = lerp(650, 4200, I);               // filters open up as the colony heats up

    // PAD / DRONE — always on; refreshed each bar. The hum of the machine.
    if (step === 0) {
      mNote({ freq: hz(root), at, dur: lerp(3.2, 1.9, I), type: 'sawtooth', vol: 0.05 + 0.03 * I, detune: 7, cut: bright * 0.6, verb: 0.5, atk: 0.4 });
      mNote({ freq: hz(root + 4), at, dur: lerp(3.2, 1.9, I), type: 'sawtooth', vol: 0.035 + 0.02 * I, detune: 7, cut: bright * 0.6, verb: 0.5, atk: 0.6 });
    }

    // BASS — on the beat once there's any activity.
    if (I > 0.16 && step % 4 === 0) {
      const bn = step === 8 ? root + 2 : root;       // a little movement mid-bar
      mNote({ freq: hz(bn) / 2, at, dur: 0.42, type: 'triangle', vol: 0.16, cut: 700, atk: 0.005 });
    }

    // ARPEGGIO — agents are working. 8ths warming to 16ths as it gets busier.
    const arpRate = I > 0.62 ? 1 : 2;                 // every 16th vs every 8th
    if (I > 0.4 && step % arpRate === 0) {
      const note = triad[M.arpN % 3] + 7 * (M.arpN % 2 ? 1 : 0);   // ride up into the next octave
      mNote({ freq: hz(note + 7), at, dur: 0.16, type: 'square', vol: 0.07 + 0.05 * I, cut: bright, q: 1.2, verb: 0.18 });
      M.arpN += M.arpDir;
      if (M.arpN > 8 || M.arpN < 0) { M.arpDir *= -1; M.arpN += M.arpDir; }
    }

    // HAT — throughput tick on the offbeats once it's genuinely busy.
    if (I > 0.6 && step % 2 === 1) mHat(at, 0.04 + 0.05 * I);

    // LEAD — a sparse high counter-melody only at full tilt.
    if (I > 0.84 && (step === 6 || step === 14)) {
      mNote({ freq: hz(triad[(M.bar + step) % 3] + 14), at, dur: 0.5, type: 'triangle', vol: 0.09, cut: bright, verb: 0.4, atk: 0.02 });
    }
  }

  /* ---- lookahead scheduler: advance the grid, ease intensity toward target ---- */
  function tick() {
    if (!M.running || !SFX.ctx) return;
    const c = SFX.ctx;
    const bpm = lerp(64, 128, M.intensity);
    const stepDur = 60 / bpm / 4;
    const horizon = c.currentTime + 0.2;             // schedule ~200ms ahead

    while (M.nextTime < horizon) {
      // swing: nudge the odd 16ths a touch late for groove
      const swing = (M.step % 2) ? stepDur * 0.18 : 0;
      scheduleStep(M.step, M.nextTime + swing);
      M.nextTime += stepDur;
      M.step++;
      if (M.step >= STEPS) {
        M.step = 0; M.bar++;
        M.chordIx++;                                 // next chord each bar
      }
    }

    // director easing: energy decays, tension decays slowly, intensity follows the floor+energy target
    const floor = Math.min(0.78, 0.10 + M.runs * 0.22);
    const target = Math.max(floor, M.energy);
    M.intensity += (target - M.intensity) * 0.09;
    M.intensity = Math.max(0.06, Math.min(1, M.intensity));
    M.energy *= 0.92;
    M.tension *= 0.985;

    // gently track the music bus volume to intensity so quiet stays quiet
    if (M.mGain) M.mGain.gain.setTargetAtTime(M.vol * lerp(0.55, 1, M.intensity), c.currentTime, 0.3);
  }

  /* ---- director inputs ---- */
  const bump = a => { M.energy = Math.min(1, M.energy + a); };
  const tense = a => { M.tension = Math.min(1, M.tension + (a || 0.3)); };

  function start() {
    SFX.boot();
    if (!SFX.ctx) return;                             // no Web Audio — silently do nothing
    if (M.running) return;
    if (!M.mGain) { M.mGain = SFX.ctx.createGain(); M.mGain.gain.value = 0; M.mGain.connect(SFX.master); }
    M.running = true;
    M.nextTime = SFX.ctx.currentTime + 0.1;
    M.timer = setInterval(tick, 40);
  }

  function stop() {
    M.running = false;
    if (M.timer) { clearInterval(M.timer); M.timer = null; }
    if (M.mGain && SFX.ctx) M.mGain.gain.setTargetAtTime(0, SFX.ctx.currentTime, 0.2);
  }

  /* ---- public surface ---- */
  const api = {
    get on() { return M.on; },
    set on(v) { M.on = !!v; if (M._armed) { v ? start() : stop(); } },
    get vol() { return M.vol; },
    set vol(v) { M.vol = Math.max(0, Math.min(1, v)); },
    start, stop,
    intensity: () => M.intensity,
    setIntensity: v => { M.intensity = Math.max(0.06, Math.min(1, v)); M.energy = Math.max(M.energy, v); },
    bump, tense,
    _state: M
  };

  /* ---- wire the colony Director to the bus (browser only) ---- */
  function wire() {
    if (typeof U === 'undefined' || !U.bus) return;
    const B = U.bus, on = (ev, fn) => B.on(ev, fn);

    // sustained intensity: while agents are actually running, the floor stays up
    on('agent.run.start', () => { M.runs++; bump(0.4); });
    on('agent.run.end', () => { M.runs = Math.max(0, M.runs - 1); });
    on('run.cancel', () => { M.runs = Math.max(0, M.runs - 1); });

    // the texture of work
    on('agent.tool_call', () => bump(0.14));
    on('agent.tool_result', p => { if (p && p.isError) { tense(0.2); SFX.alarm(); } });
    on('agent.token', () => bump(0.012));

    // work-items riding the belts = the pipeline pulsing
    on('workitem.placed', () => { bump(0.22); SFX.msg(); });
    on('workitem.delivered', () => { bump(0.18); SFX.ship(); });
    on('queue.status', p => { if (p && p.depth) bump(Math.min(0.3, p.depth * 0.05)); });

    // task lifecycle (re-emitted v7 names from real transitions)
    on('task', p => { if (!p) return; if (p.status === 'running' || p.status === 'queued') bump(0.22); if (p.status === 'done') SFX.ship(); if (p.status === 'failed') { tense(); SFX.alarm(); } });
    on('deliverable', () => { bump(0.3); SFX.ship(); });
    on('sale', () => bump(0.25));

    // celebrations brighten; problems darken
    on('level', () => { bump(0.5); M.tension *= 0.5; });
    on('party', () => { bump(0.6); M.tension *= 0.4; });
    on('agent.run.error', () => { tense(); SFX.alarm(); });
    on('hazard', () => tense(0.2));
    on('flagged', () => { tense(); SFX.alarm(); });
    on('capdenied', () => { tense(0.2); SFX.alarm(); });
    on('budget.threshold', () => { tense(0.25); SFX.alarm(); });

    // attention chimes
    on('channel.inbound', () => { bump(0.12); SFX.msg(); });
    on('memory.write', () => SFX.chime());
    on('memory.recall', () => bump(0.06));
    on('permission.prompt', () => SFX.chime());

    // generic heartbeats keep the bed alive across both the harness and the v7 sim
    on('notify', () => bump(0.10));
    on('chat', () => bump(0.08));
    on('ops', () => bump(0.04));
    on('stats', () => bump(0.02));
  }

  /* ---- autoplay: browsers block audio until a gesture, so arm on first input ---- */
  function arm() {
    if (M._armed) return; M._armed = true;
    ['pointerdown', 'keydown', 'touchstart'].forEach(e => { try { window.removeEventListener(e, arm); } catch (_) { } });
    SFX.boot();
    if (M.on) start();
  }

  if (typeof window !== 'undefined') {
    wire();
    ['pointerdown', 'keydown', 'touchstart'].forEach(e => window.addEventListener(e, arm, { passive: true }));
  }

  return api;
})();
