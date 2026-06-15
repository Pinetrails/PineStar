/* SKYNET — util.js : helpers + event bus */
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

/* tiny synth */
const SFX = {
  ctx: null, on: true, vol: 0.35,
  boot() { if (!SFX.ctx) { try { SFX.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { } } },
  tone(freq, dur, type, vol, when) {
    if (!SFX.on || !SFX.ctx) return;
    const c = SFX.ctx, t0 = c.currentTime + (when || 0);
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime((vol || 0.5) * SFX.vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  },
  click() { SFX.tone(660, 0.05, 'square', 0.25); },
  // "got it, thinking…" — a soft descending sine, distinct from click (send) and open (listen-start), so a
  // hands-free user gets instant confirmation their words landed before the agent starts speaking.
  think() { SFX.tone(740, 0.05, 'sine', 0.22); SFX.tone(560, 0.08, 'sine', 0.18, 0.05); },
  open() { SFX.tone(440, 0.06, 'square', 0.3); SFX.tone(880, 0.08, 'square', 0.22, 0.05); },
  close() { SFX.tone(520, 0.05, 'square', 0.25); SFX.tone(330, 0.07, 'square', 0.2, 0.04); },
  notify() { SFX.tone(880, 0.09, 'square', 0.3); SFX.tone(1318, 0.12, 'square', 0.22, 0.08); },
  sale() { SFX.tone(523, 0.08, 'square', 0.35); SFX.tone(784, 0.1, 'square', 0.3, 0.07); SFX.tone(1046, 0.16, 'square', 0.25, 0.15); },
  bad() { SFX.tone(220, 0.12, 'sawtooth', 0.25); SFX.tone(140, 0.2, 'sawtooth', 0.2, 0.1); },
  level() { [523, 659, 784, 1046].forEach((f, i) => SFX.tone(f, 0.12, 'square', 0.3, i * 0.09)); },
  type() { SFX.tone(1200 + Math.random() * 600, 0.015, 'square', 0.06); }
};
