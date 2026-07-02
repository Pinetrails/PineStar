/* STARNET — util.js : helpers + event bus */
'use strict';

const U = {
  rnd(a, b) { return a + Math.random() * (b - a); },
  irnd(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); },
  pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; },
  chance(p) { return Math.random() < p; },
  clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
  lerp(a, b, t) { return a + (b - a) * t; },
  pad2(n) { return String(n).padStart(2, '0'); },

  _id: 1,
  id() { return 't' + (U._id++); },

  /* shared window stacking order — every floating window (UI terms + prop
     terminals) pulls from one counter so click-to-front works across both */
  _z: 500,
  zTop() { return ++U._z; },

  money(n) {
    const neg = n < 0; n = Math.abs(n);
    let s;
    if (n >= 1000000) s = (n / 1000000).toFixed(2) + 'M';
    else if (n >= 10000) s = (n / 1000).toFixed(1) + 'K';
    else s = n.toFixed(2);
    return (neg ? '-$' : '$') + s;
  },

  /* CANONICAL spend formatter — the one true way to render an AI-cost dollar figure across the UI.
     Sub-dime keeps precision so a $0.0123 haiku ping stays visible; normal sums round to cents;
     whole dollars past $100 get a thousands separator; zero/invalid is a quiet $0.00. Mirrors the
     conventions the topbar/chat/world readouts converged on so no display shifts. */
  usd(n) {
    const v = Number(n);
    if (!isFinite(v)) return '$0.00';
    const neg = v < 0, a = Math.abs(v);
    let s;
    if (a === 0) s = '0.00';
    else if (a < 0.1) s = a.toFixed(4);                 // sub-dime: 4 decimals ($0.0123)
    else if (a < 100) s = a.toFixed(2);                 // normal: cents ($1.23 / $12.00)
    else s = Math.round(a).toLocaleString();            // large: whole dollars ($1,204)
    return (neg ? '-$' : '$') + s;
  },

  /* CANONICAL token-count formatter — compact k/M with one decimal under 10, rounded above, so
     1234 -> "1.2k" and 3,400,000 -> "3.4M". Mirrors the context-gauge convention. */
  tokens(n) {
    const v = Number(n);
    if (!isFinite(v) || v <= 0) return '0';
    if (v < 1000) return String(Math.round(v));
    if (v < 1000000) { const k = v / 1000; return (k < 10 ? k.toFixed(1).replace(/\.0$/, '') : String(Math.round(k))) + 'k'; }
    const m = v / 1000000; return (m < 10 ? m.toFixed(1).replace(/\.0$/, '') : String(Math.round(m))) + 'M';
  },

  // sim minutes -> "D3 14:05"
  fmtClock(mins) {
    const day = Math.floor(mins / 1440) + 1;
    const m = mins % 1440;
    return 'DAY ' + day + ' ' + U.pad2(Math.floor(m / 60)) + ':' + U.pad2(m % 60);
  },
  fmtTime(mins) {
    const m = mins % 1440;
    return U.pad2(Math.floor(m / 60)) + ':' + U.pad2(m % 60);
  },

  esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  // seeded-ish per-instance phase
  hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0);
  },

  shade(hex, f) { // f: -1..1 darken/lighten
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (f >= 0) { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
    else { r *= (1 + f); g *= (1 + f); b *= (1 + f); }
    return '#' + ((1 << 24) | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)).toString(16).slice(1);
  },

  // tiny pub/sub
  bus: {
    _h: {},
    on(ev, fn) { (U.bus._h[ev] = U.bus._h[ev] || []).push(fn); },
    emit(ev, data) { (U.bus._h[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error('[bus]', ev, e); } }); }
  }
};

/* ============================================================================
   SFX — procedural sound engine (Web Audio). Asset-free and node-safe: every
   audio node is built lazily inside boot()/playback, so nothing touches
   AudioContext at module load and the headless test that evals this file (and
   sets SFX.on=false) stays happy. The public API is a backward-compatible
   superset of the old tiny synth — boot / tone / click / open / close / notify
   / sale / bad / level / type all still exist; they just sound designed now
   instead of like a buzzy PC speaker. New stings (chime/ship/alarm/msg) feed
   the adaptive music director in audio.js, which shares this master bus.
   ========================================================================== */
const SFX = {
  ctx: null, master: null, fx: null, on: true, vol: 0.35, _noise: null,

  boot() {
    if (SFX.ctx) { try { if (SFX.ctx.state === 'suspended') SFX.ctx.resume(); } catch (e) { } return; }
    try {
      const c = new (window.AudioContext || window.webkitAudioContext)();
      // master chain: gain -> gentle high-shelf cut (tames harsh harmonics) -> soft limiter -> out
      const master = c.createGain(); master.gain.value = 0.9;
      const tame = c.createBiquadFilter(); tame.type = 'highshelf'; tame.frequency.value = 5400; tame.gain.value = -9;
      const lim = c.createDynamicsCompressor();
      lim.threshold.value = -9; lim.knee.value = 8; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.2;
      master.connect(tame); tame.connect(lim); lim.connect(c.destination);
      // shared reverb send (synthetic decaying-noise impulse) gives everything a sense of space
      const send = c.createGain(); send.gain.value = 1;
      const verb = c.createConvolver(); verb.buffer = SFX._impulse(c, 1.8, 2.6);
      const wet = c.createGain(); wet.gain.value = 0.45;
      send.connect(verb); verb.connect(wet); wet.connect(master);
      SFX.ctx = c; SFX.master = master; SFX.fx = send; SFX._noise = SFX._noiseBuf(c, 1.5);
    } catch (e) { /* no Web Audio (e.g. headless node) — stay silent */ }
  },

  /* ---- buffer factories (browser-only; only ever called from boot) ---- */
  _noiseBuf(c, secs) {
    const n = Math.floor(c.sampleRate * secs), b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  },
  _impulse(c, secs, decay) {
    const n = Math.floor(c.sampleRate * secs), b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return b;
  },

  /* ---- core voice: detuned oscillator(s) -> lowpass -> ADSR -> master (+reverb send) ---- */
  voice(o) {
    if (!SFX.on || !SFX.ctx) return;
    o = o || {};
    const c = SFX.ctx, t0 = c.currentTime + (o.when || 0);
    const dur = o.dur || 0.2, peak = (o.vol != null ? o.vol : 0.5) * SFX.vol;
    const atk = o.atk != null ? o.atk : 0.006, rel = o.rel != null ? o.rel : dur;
    const g = c.createGain();
    const f = c.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.value = o.cut || Math.min(8000, (o.freq || 440) * 5 + 700); f.Q.value = o.q || 0.7;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + atk);             // soft attack kills the click/pop
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(rel, atk + 0.02));
    const type = o.type || 'triangle', det = o.detune || 0;
    const mk = cents => {
      const osc = c.createOscillator(); osc.type = type; osc.frequency.setValueAtTime(o.freq || 440, t0);
      if (cents) osc.detune.value = cents;
      if (o.glide) osc.frequency.exponentialRampToValueAtTime(o.glide, t0 + dur);
      osc.connect(f); osc.start(t0); osc.stop(t0 + dur + 0.05);
    };
    mk(0); if (det) { mk(det); mk(-det); }                      // detuned stack = warmth, not a thin beep
    f.connect(g); g.connect(SFX.master);
    if (o.verb && SFX.fx) { const s = c.createGain(); s.gain.value = o.verb; g.connect(s); s.connect(SFX.fx); }
  },

  /* ---- filtered noise burst: the basis of satisfying clicks/ticks/whooshes ---- */
  noise(o) {
    if (!SFX.on || !SFX.ctx || !SFX._noise) return;
    o = o || {};
    const c = SFX.ctx, t0 = c.currentTime + (o.when || 0), dur = o.dur || 0.05;
    const src = c.createBufferSource(); src.buffer = SFX._noise; src.loop = true;
    const f = c.createBiquadFilter(); f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.cut || 2000, t0);
    if (o.cut2) f.frequency.exponentialRampToValueAtTime(o.cut2, t0 + dur);
    f.Q.value = o.q || 0.9;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime((o.vol != null ? o.vol : 0.3) * SFX.vol, t0 + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(SFX.master);
    if (o.verb && SFX.fx) { const s = c.createGain(); s.gain.value = o.verb; g.connect(s); s.connect(SFX.fx); }
    src.start(t0); src.stop(t0 + dur + 0.05);
  },

  /* ---- backward-compatible primitive: identical signature to the old tone() ----
     existing callers (arcade.js etc.) keep working and instantly sound warmer,
     because every tone now gets a soft attack, a lowpass, and the master limiter. */
  tone(freq, dur, type, vol, when, cut) {
    SFX.voice({ freq, dur: dur || 0.1, type: type || 'square', vol, when, cut, verb: (dur || 0) > 0.06 ? 0.1 : 0 });
  },

  /* ---- designed UI / event sounds (warm, not beepy) ---- */
  click() { SFX.noise({ dur: 0.035, cut: 2600, cut2: 1100, vol: 0.16 }); SFX.voice({ freq: 760, dur: 0.04, type: 'sine', vol: 0.08 }); },
  // "got it, thinking…" — a soft descending two-note sine, distinct from click (send) and open (listen-start),
  // so a hands-free user gets instant confirmation their words landed before the agent starts speaking.
  think() { SFX.voice({ freq: 740, dur: 0.07, type: 'sine', vol: 0.18, verb: 0.12 }); SFX.voice({ freq: 560, dur: 0.10, type: 'sine', vol: 0.14, when: 0.05, verb: 0.12 }); },
  open() { SFX.voice({ freq: 523, dur: 0.10, type: 'triangle', vol: 0.22, verb: 0.16 }); SFX.voice({ freq: 784, dur: 0.13, type: 'triangle', vol: 0.16, when: 0.05, verb: 0.16 }); },
  close() { SFX.voice({ freq: 523, dur: 0.09, type: 'triangle', vol: 0.20 }); SFX.voice({ freq: 349, dur: 0.13, type: 'triangle', vol: 0.16, when: 0.04 }); },
  notify() { SFX.voice({ freq: 880, dur: 0.18, type: 'sine', vol: 0.22, detune: 4, verb: 0.3 }); SFX.voice({ freq: 1318, dur: 0.22, type: 'sine', vol: 0.15, when: 0.07, detune: 4, verb: 0.3 }); },
  sale() { [523, 659, 784, 1046].forEach((f, i) => SFX.voice({ freq: f, dur: 0.20, type: 'triangle', vol: 0.2, when: i * 0.05, verb: 0.25 })); },
  bad() { SFX.voice({ freq: 196, dur: 0.20, type: 'sawtooth', vol: 0.18, glide: 110, cut: 900 }); SFX.voice({ freq: 146, dur: 0.28, type: 'sawtooth', vol: 0.14, when: 0.08, glide: 90, cut: 700 }); },
  level() { [523, 659, 784, 1046, 1318].forEach((f, i) => SFX.voice({ freq: f, dur: 0.18, type: 'triangle', vol: 0.22, when: i * 0.07, verb: 0.25 })); },
  // quest-complete sting (G1a): a shorter, brighter cousin of level() — three quick gold steps + one high
  // shimmer. A MOMENT, deliberately smaller than a level-up: quests pay out in real work, not fanfare.
  quest() { [659, 880, 1318].forEach((f, i) => SFX.voice({ freq: f, dur: 0.15, type: 'triangle', vol: 0.2, when: i * 0.055, verb: 0.3 })); SFX.voice({ freq: 1976, dur: 0.32, type: 'sine', vol: 0.09, when: 0.19, verb: 0.5 }); },
  // idea sting (G3a): a pitch / fresh suggestion / spoken notice slots into the feed — SOFT, two warm sine
  // steps up, quieter and rounder than notify() so a proactive aside lands gently, never startles.
  idea() { SFX.voice({ freq: 587, dur: 0.12, type: 'sine', vol: 0.12, verb: 0.25 }); SFX.voice({ freq: 880, dur: 0.16, type: 'sine', vol: 0.10, when: 0.07, verb: 0.3 }); },
  // seed-saved sting (G3a): PLANTING — one warm low tuck + two high sparkles settling over it; deliberately
  // distinct from chime() (one held bell) and sale() (major run) so "saved to your shelf" has its own signature.
  seed() { SFX.voice({ freq: 262, dur: 0.16, type: 'triangle', vol: 0.18, verb: 0.2 }); SFX.voice({ freq: 1568, dur: 0.09, type: 'sine', vol: 0.10, when: 0.10, verb: 0.4 }); SFX.voice({ freq: 2093, dur: 0.22, type: 'sine', vol: 0.08, when: 0.16, verb: 0.5 }); },
  // milestone sting (G3a): grander than quest() (3 steps), smaller than level() (5 steps) — four rising gold
  // steps under a long high shimmer. A milestone is PERMANENT, so its sting carries a little more weight.
  milestone() { [523, 659, 880, 1318].forEach((f, i) => SFX.voice({ freq: f, dur: 0.17, type: 'triangle', vol: 0.21, when: i * 0.06, verb: 0.28 })); SFX.voice({ freq: 2637, dur: 0.4, type: 'sine', vol: 0.08, when: 0.26, verb: 0.55 }); },
  type() { SFX.noise({ dur: 0.018, cut: 3200, vol: 0.05, type: 'highpass' }); },

  /* ---- new stings the music director (audio.js) plays on real colony events ---- */
  chime() { SFX.voice({ freq: 1046, dur: 0.5, type: 'sine', vol: 0.15, detune: 3, verb: 0.4 }); SFX.voice({ freq: 1568, dur: 0.6, type: 'sine', vol: 0.10, when: 0.04, verb: 0.4 }); },
  ship() { SFX.voice({ freq: 659, dur: 0.12, type: 'triangle', vol: 0.2, verb: 0.3 }); SFX.voice({ freq: 988, dur: 0.18, type: 'triangle', vol: 0.16, when: 0.06, verb: 0.3 }); },
  alarm() { SFX.voice({ freq: 330, dur: 0.16, type: 'sawtooth', vol: 0.16, cut: 1100 }); SFX.voice({ freq: 247, dur: 0.24, type: 'sawtooth', vol: 0.14, when: 0.14, cut: 900 }); },
  msg() { SFX.voice({ freq: 988, dur: 0.10, type: 'sine', vol: 0.16, verb: 0.25 }); SFX.voice({ freq: 1318, dur: 0.14, type: 'sine', vol: 0.12, when: 0.05, verb: 0.25 }); },

  /* ---- soft-envelope voices for THE AWAKENING (fade-in tones, breath, chimes) — routed through the
     master bus so they pass the limiter; self-terminating so nothing leaks. ---- */
  env(freq, o) {
    o = o || {};
    if (!SFX.on || !SFX.ctx) return;
    const c = SFX.ctx, t0 = c.currentTime + (o.when || 0), out = SFX.master || c.destination;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = o.type || 'sine'; osc.frequency.value = freq;
    const a = o.attack || 0.01, h = o.hold || 0.05, r = o.release || 0.2, v = (o.vol || 0.1) * SFX.vol;
    if (o.glideTo) osc.frequency.linearRampToValueAtTime(o.glideTo, t0 + a + h);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, v), t0 + a);
    g.gain.setValueAtTime(Math.max(0.0002, v), t0 + a + h);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + h + r);
    osc.connect(g); g.connect(out);
    osc.start(t0); osc.stop(t0 + a + h + r + 0.05);
  },
  // a sharp filtered-noise INHALE — the newborn's first pull of air (uses the shared noise buffer).
  gasp() {
    if (!SFX.on || !SFX.ctx) return;
    const c = SFX.ctx, t0 = c.currentTime, out = SFX.master || c.destination;
    if (!SFX._noise) { const b = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; SFX._noise = b; }
    const src = c.createBufferSource(); src.buffer = SFX._noise;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(330, t0); f.frequency.linearRampToValueAtTime(1400, t0 + 0.34);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.10 * SFX.vol, t0 + 0.13); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.44);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(t0); src.stop(t0 + 0.5);
  },
  // a soft rising bell each time the newborn learns a truth about itself — pitched UP per step (i = 0..3).
  truth(i) {
    const sets = [[523, 659], [587, 740], [659, 830], [784, 988, 1175]];
    (sets[Math.min(i, 3)]).forEach((f, n) => SFX.env(f, { attack: 0.012, hold: 0.05, release: 0.42, type: 'sine', vol: 0.13, when: n * 0.07 }));
  },
  // the warm major-chord SWELL at dawn — first light you can hear.
  dawn() {
    [261, 329, 392, 523].forEach((f, n) => SFX.env(f, { attack: 0.3, hold: 0.32, release: 1.1, type: 'sine', vol: 0.11, when: n * 0.05 }));
  },
  // THE FLOOD — waking into vast knowledge: a noise wash that sweeps wide-open then closes, under an
  // ascending detuned tone-cluster that swells to a peak (~3.3s) and resolves. ~4.7s, self-terminating.
  flood() {
    if (!SFX.on || !SFX.ctx) return;
    const c = SFX.ctx, t0 = c.currentTime, out = SFX.master || c.destination;
    const V = SFX.vol;
    // rushing wash — looped noise through a bandpass that races open (the pages streaming past), then shuts
    if (!SFX._noise) { const b = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; SFX._noise = b; }
    const src = c.createBufferSource(); src.buffer = SFX._noise; src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(180, t0);
    bp.frequency.exponentialRampToValueAtTime(3600, t0 + 3.3);
    bp.frequency.exponentialRampToValueAtTime(360, t0 + 4.5);
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.linearRampToValueAtTime(0.085 * V, t0 + 3.3);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 4.6);
    src.connect(bp); bp.connect(ng); ng.connect(out);
    src.start(t0); src.stop(t0 + 4.7);
    // the vastness rising — a detuned cluster that glides up a fifth and swells under a opening lowpass
    [110, 146.83, 220, 293.66].forEach((f, n) => {
      const o = c.createOscillator(), g = c.createGain(), lpf = c.createBiquadFilter();
      o.type = n < 2 ? 'sawtooth' : 'triangle';
      o.frequency.setValueAtTime(f, t0); o.frequency.exponentialRampToValueAtTime(f * 1.5, t0 + 3.4);
      o.detune.value = (n - 1.5) * 4;
      lpf.type = 'lowpass'; lpf.frequency.setValueAtTime(700, t0); lpf.frequency.exponentialRampToValueAtTime(2600, t0 + 3.3);
      const peak = Math.max(0.0004, (0.05 - n * 0.006) * V);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 3.2 + n * 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 4.5);
      o.connect(lpf); lpf.connect(g); g.connect(out);
      o.start(t0); o.stop(t0 + 4.7);
    });
    // sub-rise for weight under the swell
    const sub = c.createOscillator(), sg = c.createGain();
    sub.type = 'sine'; sub.frequency.setValueAtTime(40, t0); sub.frequency.linearRampToValueAtTime(70, t0 + 3.4);
    sg.gain.setValueAtTime(0.0001, t0); sg.gain.linearRampToValueAtTime(0.06 * V, t0 + 3.2); sg.gain.exponentialRampToValueAtTime(0.0001, t0 + 4.4);
    sub.connect(sg); sg.connect(out); sub.start(t0); sub.stop(t0 + 4.6);
  }
};
