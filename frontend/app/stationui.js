/* STARNET — stationui.js : the station-management HUD.
   Ports the v7 pip-boy chrome (floating terminal windows, crew manifest,
   bottom-bar panels) but wires every readout to REAL harness data — the
   present agent, the current measured context window, the real tool
   surface, a real persisted task board. No simulated numbers, no fake
   progress bars (truthful-telemetry mandate). State that the user owns
   (task board · UI settings · notifications) persists to localStorage. */
'use strict';

// Pure geometry seam for floating terminal placement. Kept outside StationUI so its viewport
// invariants can be exercised without a browser DOM.
function visibleTerminalRect(rect, viewport) {
  const vw = Math.max(0, Number(viewport && viewport.width) || 0);
  const vh = Math.max(0, Number(viewport && viewport.height) || 0);
  const width = Math.max(0, Number(rect && rect.width) || 0);
  const height = Math.max(0, Number(rect && rect.height) || 0);
  const left = Number.isFinite(Number(rect && rect.left)) ? Number(rect.left) : 0;
  const top = Number.isFinite(Number(rect && rect.top)) ? Number(rect.top) : 0;
  const padX = Math.min(8, vw / 4);
  const padY = Math.min(8, vh / 4);
  const fitsWidth = width <= Math.max(0, vw - padX * 2);
  const fitsHeight = height <= Math.max(0, vh - padY * 2);
  // If responsive rules have not settled and the old rect is wider than the viewport, align
  // its right edge so the close control remains reachable. The settled-size pass then moves
  // the responsive rect to the normal inset.
  const minLeft = fitsWidth ? padX : vw - padX - width;
  const maxLeft = vw - padX - width;
  const minTop = padY;
  const maxTop = vh - padY - height;
  return {
    left: fitsWidth ? Math.max(minLeft, Math.min(left, maxLeft)) : maxLeft,
    top: fitsHeight ? Math.max(minTop, Math.min(top, maxTop)) : minTop,
    width,
    height
  };
}

// Pure size clamp for floating terminals. Per-window limits win until the viewport is smaller;
// then the viewport temporarily becomes the ceiling (and effective floor) so every control remains reachable.
function clampTerminalSize(size, limits, viewport) {
  limits = limits || {}; viewport = viewport || {};
  const vw = Math.max(0, Number(viewport.width) || 0), vh = Math.max(0, Number(viewport.height) || 0);
  const availW = Math.max(0, vw - Math.min(16, vw / 2));
  const availH = Math.max(0, vh - Math.min(16, vh / 2));
  const maxW = Math.min(Math.max(0, Number(limits.maxWidth) || availW), availW);
  const maxH = Math.min(Math.max(0, Number(limits.maxHeight) || availH), availH);
  const minW = Math.min(Math.max(0, Number(limits.minWidth) || 0), maxW);
  const minH = Math.min(Math.max(0, Number(limits.minHeight) || 0), maxH);
  const rawW = Number(size && size.width), rawH = Number(size && size.height);
  const width = Number.isFinite(rawW) && rawW > 0 ? rawW : minW;
  const height = Number.isFinite(rawH) && rawH > 0 ? rawH : minH;
  return { width: Math.max(minW, Math.min(width, maxW)), height: Math.max(minH, Math.min(height, maxH)) };
}

const StationUI = typeof document === 'undefined' ? {} : (() => {
  const $ = s => document.querySelector(s);
  const esc = s => U.esc(String(s == null ? '' : s));
  const mkEl = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const sfx = n => { try { if (typeof SFX === 'object' && SFX[n]) SFX[n](); } catch (_) {} };

  const KEY = 'starnet.station.v1';
  const THEMES = [['amber', '#ffaa33'], ['green', '#3dff70'], ['blue', '#46c8ff'], ['purple', '#b46bff'], ['red', '#ff4136'], ['white', '#e8f0e8']];

  let present = [];          // agent objects currently on the station
  const runningAgents = new Map();   // agentId -> live-run COUNT (concurrent streams can share an agentId, e.g. 'agent')
  const runSeenAt = new Map();       // agentId -> performance.now() of the last counted run.start (agentLive's veto grace)
  let crewLiveWired = false;         // the crew-status live listener is registered exactly once
  let repaintAutonomyDial = null;    // GROWTH Tier 3: the open Settings AUTONOMY panel's paint fn (null when closed) — lets an accepted trust offer repaint the EARNED badge live
  let lastStageSummary = '';         // #8: last screen-reader summary text, so we only update the live region on change
  let access = {};           // { totals(), activity() } injected by app.js
  let sel = 0;               // selected agent index (dossier / crew)
  let tickTimer = 0;
  const open = {};           // key -> open terminal-window element (stays populated while minimized)
  const minimized = {};      // key -> true while the window is minimized to the strip (element kept alive, hidden)
  let started = false;

  /* ---------- persistence (user-owned UI state) ---------- */
  // themeHue/themeSat drive the CUSTOM phosphor derivation (theme:'custom'); themeGlow (0–150%) is an
  // independent bloom dial that also tames the hand-tuned presets. 100 = the shipped look, untouched.
  function defaults() { return { theme: 'amber', themeHue: 35, themeSat: 100, themeGlow: 100, textScale: 0, flicker: true, sound: true, keepComputerAwake: false, notifyPrefs: notifyDefaults() }; }
  // TEXT SIZE steps (percent → chip label; 0 = AUTO, the default). Applied as a body zoom in
  // applySettings(): zoom scales layout too, so every hard-px face (COMMS included) grows together —
  // a root font-size can't reach the ~800 px-sized declarations. world.js resize() reads the same
  // zoom back so the station canvas re-renders at true device resolution instead of upscaling soft.
  const TEXT_SCALES = [[0, 'AUTO'], [90, 'COMPACT'], [100, 'STANDARD'], [115, 'LARGE'], [130, 'X-LARGE'], [145, 'HUGE']];
  // AUTO: smaller physical screens read at a gently larger face out of the box. screen.width is CSS px
  // (already reflects OS display scaling), so a 13–15" laptop lands at 1280–1536 and a desktop monitor
  // at ≥1920. Long edge guards portrait/rotated displays. Honest: the chip shows the resolved %.
  function autoTextScale() {
    const scr = window.screen || {};
    const long = Math.max(Number(scr.width) || 0, Number(scr.height) || 0) || window.innerWidth || 1920;
    return long <= 1470 ? 115 : long <= 1740 ? 110 : 100;
  }
  function resolveTextScale(v) { const n = Number(v) || 0; return n === 0 ? autoTextScale() : clampN(n, 90, 150, 100); }
  // P1-8 notification preferences: per-category on/off + a notification sound toggle. Every category defaults ON
  // (no silent regression); each is HONORED at emit time in notify() below (a decorative toggle would be a bug).
  function notifyDefaults() { return { runComplete: true, needsApproval: true, cronDigest: true, sound: true }; }
  function blank() { return { v: 1, settings: defaults(), tasks: [], notifs: [], termPos: {}, termSize: {}, consoleSection: {} }; }
  function load() {
    try {
      const r = JSON.parse(localStorage.getItem(KEY));
      if (r && r.v === 1) {
        r.settings = Object.assign(defaults(), r.settings || {});
        r.settings.notifyPrefs = Object.assign(notifyDefaults(), r.settings.notifyPrefs || {});   // merge new keys onto an old save
        if (!Array.isArray(r.tasks)) r.tasks = [];
        if (!Array.isArray(r.notifs)) r.notifs = [];
        if (!r.termPos || typeof r.termPos !== 'object') r.termPos = {};             // remembered drag positions (persisted)
        if (!r.termSize || typeof r.termSize !== 'object') r.termSize = {};          // remembered dimensions (persisted)
        if (!r.consoleSection || typeof r.consoleSection !== 'object') r.consoleSection = {};  // last-active console section per window
        return r;
      }
    } catch (_) {}
    return blank();
  }
  let store = load();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (_) {} }
  const uid = p => p + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

  // brief "✓ saved" flash for an instant-save section (theme/appearance/notifications) so every section answers
  // "did that stick?" — the same .msg.ok idiom the SAVE-button sections use, auto-cleared after a moment.
  function flashSaved(elm, text) {
    if (!elm) return;
    elm.textContent = text || '✓ saved'; elm.className = 'msg ok';
    clearTimeout(elm._flashTimer);
    elm._flashTimer = setTimeout(() => { if (elm.isConnected) { elm.textContent = ''; elm.className = 'msg'; } }, 1600);
  }

  /* ---------- CUSTOM PHOSPHOR derivation ---------- */
  // One hue + saturation → the full themed token set, applied as inline vars on <body> (inline
  // beats the body.theme-* class, and the composite --bezel/--well recipes declared on body
  // resolve their var(--ph) against these — the theming trap stays respected). Derivation math
  // is calibrated against the shipped amber reference (#ffaa33 = hsl(35,100%,60%)), so a custom
  // hue 35 / sat 100 lands visually beside the hand-tuned preset. Semantic status colours
  // (--ok / --bad / --link-down / --warn) are NOT derived — they stay constant by law.
  const THEME_VARS = ['--ph', '--ph-bright', '--ph-dim', '--ph-faint', '--ink', '--ph-glow', '--ph-glow2',
    '--bg', '--panel', '--panel2', '--text', '--gold', '--ph-rgb', '--ph-bright-rgb', '--gold-rgb', '--cam-grade'];
  function hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }
  const rgbHex = a => '#' + a.map(v => v.toString(16).padStart(2, '0')).join('');
  const hexRgb = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const clampN = (v, lo, hi, dflt) => { v = Number(v); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt; };
  function deriveCustomTheme(hue, sat, glowPct) {
    const h = ((clampN(hue, 0, 359, 35) % 360) + 360) % 360;
    const s = clampN(sat, 0, 100, 100);
    const g = clampN(glowPct, 0, 150, 100) / 100;
    const at = (l, so) => hslToRgb(h, so == null ? s : so, l);
    const ph = at(60), bright = at(82), gold = hslToRgb((h + 42) % 360, s, 64);
    return {
      '--ph': rgbHex(ph), '--ph-bright': rgbHex(bright),
      '--ph-dim': rgbHex(at(42, s * 0.75)), '--ph-faint': rgbHex(at(7, s * 0.76)),
      '--ink': rgbHex(at(5, s * 0.85)),
      '--ph-glow': 'rgba(' + ph.join(', ') + ', ' + (0.45 * g).toFixed(3) + ')',
      '--ph-glow2': 'rgba(' + ph.join(', ') + ', ' + (0.14 * g).toFixed(3) + ')',
      '--bg': rgbHex(at(1, s * 0.5)),
      '--panel': 'rgba(' + at(3, s * 0.7).join(', ') + ', 0.93)', '--panel2': rgbHex(at(6, s * 0.65)),
      '--text': rgbHex(at(75, s * 0.74)), '--gold': rgbHex(gold),
      '--ph-rgb': ph.join(', '), '--ph-bright-rgb': bright.join(', '), '--gold-rgb': gold.join(', '),
      '--cam-grade': 'saturate(0.72) contrast(1.08) brightness(0.88)'
    };
  }
  // per-preset base glow alphas (from the hand-tuned body.theme-* blocks) so the GLOW dial can
  // scale a preset's bloom without re-deriving its locked palette.
  const PRESET_GLOW = { amber: [0.5, 0.14], white: [0.35, 0.10] };
  // per-preset hue/sat so clicking a preset snaps the CUSTOM sliders to a matching start point.
  const PRESET_HS = { amber: [35, 100], green: [136, 100], blue: [198, 100], purple: [270, 100], red: [3, 100], white: [120, 8] };

  /* ---------- settings → DOM ---------- */
  function applySettings() {
    const s = store.settings;
    document.body.classList.remove('theme-amber', 'theme-green', 'theme-blue', 'theme-purple', 'theme-red', 'theme-white', 'theme-custom');
    THEME_VARS.forEach(v => document.body.style.removeProperty(v));
    if (s.theme === 'custom') {
      document.body.classList.add('theme-custom');   // vars come from the inline derivation below (falls back to :root amber if JS ever misses)
      const vars = deriveCustomTheme(s.themeHue, s.themeSat, s.themeGlow);
      for (const k in vars) document.body.style.setProperty(k, vars[k]);
    } else {
      document.body.classList.add('theme-' + s.theme);
      // GLOW dial on a preset: scale only the two bloom vars, never the locked palette.
      const gm = clampN(s.themeGlow, 0, 150, 100) / 100;
      const preset = THEMES.find(([name]) => name === s.theme);
      if (preset && Math.abs(gm - 1) > 0.001) {
        const rgb = hexRgb(preset[1]).join(', ');
        const base = PRESET_GLOW[s.theme] || [0.45, 0.14];
        document.body.style.setProperty('--ph-glow', 'rgba(' + rgb + ', ' + (base[0] * gm).toFixed(3) + ')');
        document.body.style.setProperty('--ph-glow2', 'rgba(' + rgb + ', ' + (base[1] * gm).toFixed(3) + ')');
      }
    }
    // CRT scanlines are part of the fixed shipped look — no user toggle. `no-scan` stays an
    // internal flag (set by scripts/verify-stars2.mjs to flatten the feed for star-pixel
    // checks) and is intentionally never driven by settings here.
    // TEXT SIZE — one dial for every hard-px UI face at once (0/absent = AUTO from screen size).
    // Removed (not '1') at 100% so the plain-desktop default leaves no inline style behind.
    const tz = resolveTextScale(s.textScale);
    const priorZoom = document.body.style.zoom || '';
    if (tz === 100) document.body.style.removeProperty('zoom');
    else document.body.style.zoom = String(tz / 100);
    // a zoom change rescales every open window's visual footprint without firing a window resize —
    // re-clamp them into the new local viewport (same pass the resize listener runs) or a window
    // sized/parked at one scale can hang past the frame at another.
    if ((document.body.style.zoom || '') !== priorZoom) {
      requestAnimationFrame(() => {
        try { Object.keys(open).forEach(k => { if (!minimized[k]) fitTermInViewport(open[k], k, false); }); } catch (_) {}
        // re-announce the layout change (fullscreen.js sn-fs idiom): a zoom flip moves every
        // rect without firing a window resize, so fixed-position trackers (#logo via
        // positionLogo) and the canvas re-derive path hold stale pre-zoom coordinates.
        try { window.dispatchEvent(new Event('resize')); } catch (_) {}
      });
    }
    document.body.classList.toggle('no-flicker', !s.flicker);
    if (typeof SFX === 'object') SFX.on = !!s.sound;
    syncKeepAwake(!!s.keepComputerAwake);
  }

  function syncKeepAwake(enabled, opts) {
    if (typeof KeepAwake === 'undefined' || !KeepAwake.apply) return Promise.resolve(null);
    return KeepAwake.apply(!!enabled, opts || {}).catch(err => {
      if (enabled) notify('Keep Computer Awake failed: ' + ((err && err.message) || err), 'warn');
      return (err && err.status) || null;
    });
  }

  /* ---------- time ---------- */
  function clock(ts) {
    const d = new Date(ts || Date.now());
    const p = n => (n < 10 ? '0' : '') + n;
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }
  const ts = t => '<span class="ts">[' + clock(t) + ']</span>';
  const NF_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function sameDay(a, b) { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); }
  // notification stamp: today shows just the clock; an older row prefixes the date so "[14:03]" isn't read as today.
  function notifStamp(t) {
    if (sameDay(t, Date.now())) return ts(t);
    const d = new Date(t);
    return '<span class="ts">[' + NF_MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + clock(t) + ']</span>';
  }

  /* ---------- activity labels (real World.setActivity state) ---------- */
  function activity() { try { return (access.activity && access.activity()) || 'idle'; } catch (_) { return 'idle'; } }
  function crewStatus(act) {
    return act === 'task' ? 'working at the terminal'
      : act === 'talk' ? 'in conversation'
      : 'idle — awaiting orders';
  }
  // E2: the SSE bridge health, read from the same predicate the canvas dims its live telemetry with
  // (World.linkState). ONLINE / the "on" status dot may only show while the link is genuinely up — a
  // dead sidecar must never read as ONLINE (activity() swallows errors → 'idle' → the else-branch, so
  // without this an idle agent looks online even when the harness is gone). Only a genuinely bridged-
  // but-dead link counts as down; a never-opened or deliberately-paused bridge does not (no false alarm).
  function linkDown() {
    try {
      if (typeof World !== 'undefined' && World.linkState) {
        const ls = World.linkState();
        return !!(ls && ls.bridged && !ls.paused && ls.down);
      }
    } catch (_) {}
    return false;
  }
  // the mirror of linkDown: the bridge is genuinely PROVEN up (bridged, not paused, not stale). Until this is
  // true the pill must not assert ONLINE — a never-opened / just-opened bridge reads STANDBY, not a false green.
  function linkUp() {
    try {
      if (typeof World !== 'undefined' && World.linkState) {
        const ls = World.linkState();
        return !!(ls && ls.bridged && !ls.paused && !ls.down);
      }
    } catch (_) {}
    return false;
  }
  function pillFor(act) {
    if (linkDown()) return ['LINK DOWN', 'down'];   // link gone → the pill can't honestly assert ONLINE
    if (!linkUp()) return ['STANDBY', 'standby'];   // bridge not yet proven up → STANDBY, never a premature ONLINE
    return act === 'task' ? ['WORKING', 'working']
      : act === 'talk' ? ['THINKING', 'thinking']
      : ['ONLINE', ''];
  }

  /* ============== FLOATING TERMINAL WINDOWS (ported v7 ui.js) ============== */
  let termDrag = null, termResize = null;
  const termSize = {};  // key -> {width,height} remembered user size
  let termTitleSeq = 0;   // a11y: gives each window's title a unique id for aria-labelledby
  // a11y: the tabbable controls inside a window, in DOM order, that are actually visible.
  function termFocusables(w) {
    if (!w) return [];
    return Array.from(w.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter(e => e.offsetWidth > 0 || e.offsetHeight > 0 || e === document.activeElement);
  }
  const termPos = {};   // key -> {left,top} remembered drag position — kills the dead-center pile-up
  const consoleSection = {};   // console key -> last-active section id, so reopening lands where the user was
  // P2: hydrate the persisted window layout so a panel re-opens where the Commander left it, and consoles land
  // on the last section they were on — across a full reload, not just this session. Saved back on drag-end / retab.
  try { Object.assign(termPos, store.termPos || {}); Object.assign(termSize, store.termSize || {}); Object.assign(consoleSection, store.consoleSection || {}); } catch (_) {}
  function saveWindowState() { try { store.termPos = termPos; store.termSize = termSize; store.consoleSection = consoleSection; save(); } catch (_) {} }
  // TEXT SIZE zoom: element coordinates (style.left / offsetLeft) live in the body-zoomed space while
  // mouse clientX/innerWidth are visual px — they disagree by the zoom factor. uiZoom() is the one
  // conversion; terminalViewport() reports the LOCAL (zoomed-space) viewport so every offset-based
  // clamp below stays consistent, and drag/resize handlers divide their visual mouse reads by it.
  function uiZoom() { const z = parseFloat(document.body && document.body.style ? document.body.style.zoom : ''); return z > 0 ? z : 1; }
  function terminalViewport() { const z = uiZoom(); return { width: window.innerWidth / z, height: window.innerHeight / z }; }
  const DEFAULT_TERM_LIMITS = { minWidth: 320, minHeight: 220, maxWidth: 960, maxHeight: 760 };
  const CONSOLE_TERM_LIMITS = { minWidth: 560, minHeight: 360, maxWidth: 1200, maxHeight: 840 };
  function terminalLimits(opts) {
    const base = opts && opts.console ? CONSOLE_TERM_LIMITS : DEFAULT_TERM_LIMITS;
    return {
      minWidth: Number(opts && opts.minWidth) || base.minWidth,
      minHeight: Number(opts && opts.minHeight) || base.minHeight,
      maxWidth: Number(opts && opts.maxWidth) || base.maxWidth,
      maxHeight: Number(opts && opts.maxHeight) || base.maxHeight
    };
  }
  function rememberTermPosition(key, left, top) {
    if (!key) return;
    const prior = termPos[key];
    if (prior && prior.left === left && prior.top === top) return;
    termPos[key] = { left, top };
    saveWindowState();
  }
  function bakeTermRect(w) {
    w.style.animation = 'none';
    const z = uiZoom(), r = w.getBoundingClientRect();
    // rect is visual px; style.left is zoomed-space — convert so the bake doesn't shift the window.
    const local = { left: r.left / z, top: r.top / z, width: r.width / z, height: r.height / z };
    w.style.left = local.left + 'px'; w.style.top = local.top + 'px'; w.style.transform = 'none';
    w.classList.add('term-moved');
    return local;
  }
  function resizeTermTo(w, key, width, height, persist) {
    if (!w) return null;
    const next = clampTerminalSize({ width, height }, w._sizeLimits || DEFAULT_TERM_LIMITS, terminalViewport());
    w.style.width = next.width + 'px'; w.style.height = next.height + 'px';
    w.style.maxWidth = 'calc(100vw - 16px)'; w.style.maxHeight = 'calc(100vh - 16px)';
    w.classList.add('term-sized');
    // Keep the live map current even during pointermove. fitTermInViewport consults this map, so
    // leaving the prior persisted value here would snap a pointer resize back to its old dimensions.
    if (key) termSize[key] = { width: next.width, height: next.height };
    if (persist !== false) saveWindowState();
    return next;
  }
  function addTermResizeHandle(w, key, title) {
    const grip = mkEl('button', 'term-resize', '◢');
    grip.type = 'button';
    grip.setAttribute('aria-label', 'Resize ' + title);
    grip.title = 'Drag to resize · arrow keys resize';
    grip.addEventListener('pointerdown', ev => {
      if (ev.button != null && ev.button !== 0) return;
      const r = bakeTermRect(w);
      termResize = { w, key, x: ev.clientX, y: ev.clientY, width: r.width, height: r.height, moved: false };
      try { grip.setPointerCapture(ev.pointerId); } catch (_) {}
      ev.preventDefault(); ev.stopPropagation();
    });
    grip.addEventListener('keydown', ev => {
      const dx = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
      const dy = ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowUp' ? -1 : 0;
      if (!dx && !dy) return;
      const r = bakeTermRect(w), step = ev.shiftKey ? 48 : 16;
      resizeTermTo(w, key, r.width + dx * step, r.height + dy * step, true);
      fitTermInViewport(w, key, true);
      ev.preventDefault(); ev.stopPropagation();
    });
    w.appendChild(grip);
    return grip;
  }
  window.addEventListener('mousemove', ev => {
    if (termDrag) {
      termDrag.moved = true;   // real drag movement — a dblclick-to-minimize must not fire after a drag
      const w = termDrag.w;
      // Shared clamp keeps the titlebar and its right-side close control reachable.
      // Its cached size keeps this mousemove path free of layout reads.
      const z = uiZoom();
      const next = visibleTerminalRect({
        left: ev.clientX / z - termDrag.dx,
        top: ev.clientY / z - termDrag.dy,
        width: termDrag.ww,
        height: termDrag.wh
      }, terminalViewport());
      w.style.left = next.left + 'px';
      w.style.top = next.top + 'px';
      w.style.transform = 'none';
    }
  });
  window.addEventListener('mouseup', () => {
    // remember where the Commander parked this panel so it re-opens there, not back at dead-center
    if (termDrag) {
      const w = termDrag.w, k = Object.keys(open).find(key => open[key] === w);
      if (k && termDrag.moved) fitTermInViewport(w, k, true);
      w._lastDragMoved = !!termDrag.moved;   // let dblclick-to-minimize know if this grab was actually a drag
    }
    termDrag = null;
  });
  window.addEventListener('pointermove', ev => {
    if (!termResize) return;
    termResize.moved = true;
    const z = uiZoom();   // mouse deltas are visual px; the window's width/height are zoomed-space
    resizeTermTo(termResize.w, termResize.key,
      termResize.width + (ev.clientX - termResize.x) / z,
      termResize.height + (ev.clientY - termResize.y) / z, false);
    fitTermInViewport(termResize.w, termResize.key, false);
  });
  function finishTermResize() {
    if (!termResize) return;
    const z = uiZoom(), r = termResize.w.getBoundingClientRect();
    resizeTermTo(termResize.w, termResize.key, r.width / z, r.height / z, true);
    fitTermInViewport(termResize.w, termResize.key, true);
    termResize = null;
  }
  window.addEventListener('pointerup', finishTermResize);
  window.addEventListener('pointercancel', finishTermResize);
  // P2: re-clamp every open (non-minimized) window back inside the viewport on a browser resize, so a panel
  // dragged to a corner can't be stranded off-screen when the window shrinks. CSS-centered consoles are skipped
  // by fitTermInViewport (they stay centered); only explicitly-moved windows are pulled back into view.
  let resizeClampTimer = 0;
  window.addEventListener('resize', () => {
    // AUTO text size re-resolves here so dragging the app to a different monitor picks up that
    // screen's tier (window.screen re-reads per monitor). No-op while a fixed % is chosen.
    if (!(Number(store.settings.textScale) || 0)) applySettings();
    clearTimeout(resizeClampTimer);
    requestAnimationFrame(() => { Object.keys(open).forEach(k => { if (!minimized[k]) fitTermInViewport(open[k], k, true); }); });
    resizeClampTimer = setTimeout(() => { Object.keys(open).forEach(k => { if (!minimized[k]) fitTermInViewport(open[k], k, true); }); }, 120);
  });

  // Land a freshly-opened window in a tidy left-anchored column, CASCADING each so stacked panels
  // never bury each other (the old default was every .term at left:50%/top:50% — instant pile-up).
  // A remembered drag position always wins. Clamped to the viewport so nothing opens off-screen.
  function placeTerm(w, key) {
    const p = termPos[key];
    if (p) {
      // The base CRT animation is authored around CSS-centred windows and owns `transform` while it
      // runs. Replaying it over persisted left/top coordinates visually subtracts half the restored
      // window size, stranding the titlebar off-screen until the animation releases. Persisted windows
      // are already established state, so suppress that centred entrance before applying their rect.
      w.style.animation = 'none';
      w.style.left = p.left + 'px'; w.style.top = p.top + 'px'; w.style.transform = 'none';
      w.classList.add('term-moved');
      requestAnimationFrame(() => fitTermInViewport(w, key, true));
      return;
    }
    const candidates = Object.keys(open).filter(k => k !== key && !minimized[k] && open[k]).map(k => ({
      el: open[k], rect: open[k].getBoundingClientRect()
    }));
    let anchor = candidates[candidates.length - 1];
    if (!anchor) {
      // SINGLE window = the focal point: let CSS center it (left/top:50% + translate(-50%,-50%) with a
      // capped max-height), which is ALWAYS on-screen even for tall panels like Settings. We must NOT
      // measure offsetHeight here and pin an inline top: placeTerm runs before the body content (and the
      // power-on animation) settles, so the height read is header-only (~54px) — centering for that pushed
      // tall modals ~200px off the bottom of the viewport. Leaving the CSS centering in place fixes that.
      return;
    }
    // 2nd+ window: cascade from the actual visible rectangle of the topmost existing
    // console. offsetLeft cannot describe a CSS-centred/transformed window.
    const CASCADE_STEP = 32;
    candidates.forEach(item => {
      const z = Number(getComputedStyle(item.el).zIndex) || 0;
      const anchorZ = Number(getComputedStyle(anchor.el).zIndex) || 0;
      if (z >= anchorZ) anchor = item;
    });
    const z = uiZoom();   // anchor rects are visual px; the cascade target is zoomed-space
    const wpx = w.offsetWidth || 480, hpx = w.offsetHeight || 320;
    const left = anchor.rect.left / z + CASCADE_STEP;
    const top = anchor.rect.top / z + CASCADE_STEP;
    const placed = visibleTerminalRect({ left, top, width: wpx, height: hpx }, terminalViewport());
    // Cascaded windows also use explicit coordinates; the centred keyframes are invalid for them.
    w.style.animation = 'none';
    w.style.left = placed.left + 'px'; w.style.top = placed.top + 'px'; w.style.transform = 'none';
    w.classList.add('term-moved');
  }
  function fitTermInViewport(w, key, persist) {
    if (!w) return;
    const resolvedKey = key || Object.keys(open).find(k => open[k] === w);
    const savedSize = termSize[resolvedKey];
    if (savedSize) resizeTermTo(w, resolvedKey, savedSize.width, savedSize.height, persist);
    // A window whose CURRENT box outgrows the viewport (TEXT SIZE zoom-up, or a monitor shrink with
    // no saved size) gets shrunk to fit — clampTerminalSize caps at the viewport, so every control
    // stays reachable instead of hanging past the frame.
    else {
      const vp = terminalViewport();
      if (w.offsetWidth > vp.width || w.offsetHeight > vp.height) resizeTermTo(w, resolvedKey, w.offsetWidth, w.offsetHeight, persist);
    }
    // A never-moved single window stays safely CSS-centered; explicit coordinates are repaired.
    if (!w.classList.contains('term-moved') && !termPos[resolvedKey] && !savedSize && w.style.transform !== 'none') return;
    const repaired = visibleTerminalRect({
      left: w.offsetLeft,
      top: w.offsetTop,
      width: w.offsetWidth,
      height: w.offsetHeight
    }, terminalViewport());
    w.style.left = repaired.left + 'px';
    w.style.top = repaired.top + 'px';
    w.style.transform = 'none';
    if (persist !== false) rememberTermPosition(resolvedKey, repaired.left, repaired.top);
  }

  // how many windows are actually VISIBLE (open but not minimized to the strip). Drives the scrim.
  function visibleCount() { return Object.keys(open).filter(k => !minimized[k]).length; }

  /* focus scrim: one dim layer mounted under the lowest open window so an
     open dossier/settings panel owns the eye. Purely visual (pointer-events
     none); torn down once the last VISIBLE window closes (all-minimized → no scrim). */
  function syncScrim() {
    const host = $('#terms'); if (!host) return;
    let s = document.getElementById('term-scrim');
    const any = visibleCount() > 0;
    if (any && !s) { s = mkEl('div', 'term-scrim'); s.id = 'term-scrim'; host.insertBefore(s, host.firstChild); }
    else if (!any && s) { s.remove(); }
  }

  /* ---------- MINIMIZE-TO-STRIP: window→bottom-bar chip lifecycle ----------
     Minimizing keeps the window element alive (hidden via .term-min-hidden) and its logical `open`
     slot, so the dock stays lit and NO _onClose teardown fires. A chip in #term-strip restores it. */
  const termStrip = () => document.getElementById('term-strip');

  // build the strip container once, docked in #bottombar just before .bb-right. Hidden while empty.
  function ensureStrip() {
    let strip = termStrip();
    if (strip) return strip;
    const bar = document.getElementById('bottombar'); if (!bar) return null;
    strip = mkEl('div', 'term-strip'); strip.id = 'term-strip';
    strip.setAttribute('role', 'group');
    strip.setAttribute('aria-label', 'Minimized windows');
    const right = bar.querySelector('.bb-right');
    if (right) bar.insertBefore(strip, right); else bar.appendChild(strip);
    return strip;
  }
  function syncStripVisibility() {
    const strip = termStrip(); if (!strip) return;
    strip.classList.toggle('has-chips', strip.querySelector('.term-chip') != null);
  }
  function chipTitle(key) {
    const w = open[key];
    // prefer the live title text; fall back to the term key so a chip is never blank
    const t = w && w.querySelector('.term-title');
    return (t && t.textContent.trim()) || String(key).toUpperCase();
  }
  function addChip(key) {
    const strip = ensureStrip(); if (!strip) return;
    if (strip.querySelector('.term-chip[data-key="' + CSS.escape(key) + '"]')) return;   // no dup
    const title = chipTitle(key);
    const chip = mkEl('button', 'term-chip');
    chip.dataset.key = key;
    chip.type = 'button';
    chip.setAttribute('aria-label', 'Restore ' + title);
    chip.title = 'Restore ' + title;
    chip.innerHTML = '<span class="term-chip-led" aria-hidden="true"></span>' +
      '<span class="term-chip-t">' + esc(title) + '</span>';
    chip.addEventListener('click', () => { sfx('click'); restoreTerm(key); });
    // middle-click a chip to CLOSE the minimized window outright (no need to restore-then-✕).
    chip.addEventListener('auxclick', ev => { if (ev.button === 1) { ev.preventDefault(); sfx('close'); closeTerm(key); } });
    chip.addEventListener('mousedown', ev => { if (ev.button === 1) ev.preventDefault(); });   // suppress the middle-click autoscroll cursor
    strip.appendChild(chip);
    // entrance: force a reflow then flip .in so the transform/opacity transition runs
    void chip.offsetWidth; chip.classList.add('in');
    syncStripVisibility();
  }
  function removeChip(key) {
    const strip = termStrip(); if (!strip) return;
    const chip = strip.querySelector('.term-chip[data-key="' + CSS.escape(key) + '"]');
    if (!chip) return;
    chip.classList.add('out'); chip.classList.remove('in');
    chip.disabled = true;
    let gone = false;
    const done = () => { if (gone) return; gone = true; if (chip.isConnected) chip.remove(); syncStripVisibility(); };
    chip.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 260);   // fallback (reduced-motion / detached)
  }
  function isMinimized(key) { return !!minimized[key]; }

  function minimizeTerm(key) {
    const w = open[key]; if (!w || minimized[key] || w._closing) return;
    // remember where it sits so restore lands it back exactly (reuse the drag-position map).
    // Only capture if it was ever positioned explicitly; a never-dragged single window keeps its
    // CSS centering (termPos stays unset → placeTerm re-centres on restore, which is fine).
    if (w.classList.contains('term-moved')) {
      termPos[key] = { left: w.offsetLeft, top: w.offsetTop };
    }
    minimized[key] = true;
    sfx('close');
    // if focus is inside this window, hand it to the dock trigger (or blur) so the hidden window
    // never holds focus (which would keep the Esc handler live on an invisible element).
    const active = document.activeElement;
    // quick collapse: a compressed power-off toward the strip (transform/opacity only), then hide.
    w.classList.add('term-minimizing');
    const hide = () => {
      w.classList.remove('term-minimizing');
      w.classList.add('term-min-hidden');
      w.setAttribute('aria-hidden', 'true');
    };
    let hidden = false;
    const onEnd = () => { if (hidden) return; hidden = true; hide(); };
    w.addEventListener('animationend', onEnd, { once: true });
    setTimeout(onEnd, 240);   // fallback
    if (w.contains(active)) {
      // hand focus to the dock GROUP trigger (always visible), NOT the in-menu item (it lives in a
      // display:none popover when the dock is closed — focusing a hidden node silently drops to <body>).
      const item = document.querySelector('.bb[data-term="' + CSS.escape(key) + '"]');
      const grpBtn = item && item.closest('.bb-group') ? item.closest('.bb-group').querySelector('.bb-grp') : null;
      const target = (grpBtn && grpBtn.offsetParent !== null) ? grpBtn : null;
      try { target ? target.focus() : (active.blur && active.blur()); } catch (_) {}
    }
    addChip(key);
    syncScrim();   // all-minimized → scrim fades; dock .active stays (open slot kept)
    syncBB();
  }

  function restoreTerm(key) {
    const w = open[key]; if (!w || !minimized[key]) return;
    delete minimized[key];
    removeChip(key);
    sfx('open');
    w.classList.remove('term-min-hidden', 'term-minimizing');
    w.removeAttribute('aria-hidden');
    // land it back at the remembered spot (or CSS-centre if never moved), lift to top, replay power-on.
    placeTerm(w, key);
    w.style.zIndex = U.zTop();
    // replay the CRT power-on: clear the inline animation override, restart the base .term-power.
    w.style.animation = '';
    void w.offsetWidth;
    w.classList.add('term-restoring');
    // Do not expose the base .term power-on animation again when this one-shot class is removed.
    // A resized/moved window would otherwise replay the centered keyframes and jump off-screen.
    const clearRestore = () => { w.classList.remove('term-restoring'); w.style.animation = 'none'; fitTermInViewport(w, key, true); };
    w.addEventListener('animationend', clearRestore, { once: true });
    setTimeout(clearRestore, 460);
    // focus back onto the restored dialog itself (not its first control — the minimize button)
    try { w.focus(); } catch (_) {}
    syncScrim();
    syncBB();
  }
  function closeTerm(key) {
    if (open[key]) {
      const w = open[key];
      if (w._closing) return;   // guard the Esc + ✕ + toggle double-close race
      w._closing = true;
      if (w._closeArmTimer) { clearTimeout(w._closeArmTimer); w._closeArmTimer = 0; }   // teardown any pending unsaved-close arm
      // a window closed while minimized (or minimized-then-restored, then torn down) must leave no orphan chip.
      const wasMin = !!minimized[key];
      if (wasMin) { delete minimized[key]; removeChip(key); }
      if (w._onClose) { try { w._onClose(); } catch (_) {} }   // e.g. tear down the live arcade canvas
      const opener = w._opener;   // a11y: the control that opened this window, to restore focus to
      // free the slot NOW so a re-open (toggle) mounts a fresh window while this one animates out.
      delete open[key]; sfx('close');
      // a still-minimized (hidden) window has no visible chrome to power-off — just drop it.
      if (wasMin) {
        try { if (opener && opener.isConnected && opener.focus) opener.focus(); } catch (_) {}
        if (w.isConnected) w.remove();
        syncBB(); syncScrim();
        return;
      }
      // restore keyboard focus to the opener (or its dock trigger) so Tab order isn't lost on close.
      try { if (opener && opener.isConnected && opener.focus) opener.focus(); } catch (_) {}
      // reverse-power CRT off, THEN remove. Clear any running open-animation first so it can play.
      w.style.animation = '';
      w.classList.add('term-closing');
      const done = () => { if (w.isConnected) w.remove(); };
      let removed = false;
      const onEnd = () => { if (removed) return; removed = true; done(); };
      w.addEventListener('animationend', onEnd, { once: true });
      setTimeout(onEnd, 320);   // fallback if animationend never fires (reduced-motion / detached)
      // fade the scrim out in step when this was the last VISIBLE window (any still-minimized don't count)
      const s = document.getElementById('term-scrim');
      if (s && visibleCount() === 0) {
        s.classList.add('term-closing');
        setTimeout(() => { if (s.isConnected && visibleCount() === 0) s.remove(); }, 200);
        syncBB();
        return;   // skip syncScrim() removal — the fade-out handles it
      }
    }
    syncBB(); syncScrim();
  }
  // P0 draft-loss guard: a window that holds a MODIFIED, unsaved editor (a CONFIG file / memory / commander
  // belief textarea the Commander typed into) must not vanish on a stray ✕/Esc. The first close attempt arms a
  // 3s "close anyway" state with a visible banner; a second close within the window discards. Clean windows just
  // close. A field marks itself dirty via the delegated input listener in toggleTerm (sets data-dirty on typing);
  // saving/cancelling rerenders the pane, destroying the dirty textarea, so the flag can never go stale.
  function windowDirty(w) { return !!(w && w.querySelector && w.querySelector('textarea[data-dirty="1"]')); }
  function requestCloseTerm(key) {
    const w = open[key]; if (!w || w._closing) return;
    if (w._closeArmed || !windowDirty(w)) { closeTerm(key); return; }
    // ARM: keep the window, warn, and require a second close within 3s.
    w._closeArmed = true; sfx('bad');
    let bar = w.querySelector('.term-unsaved-bar');
    if (!bar) { bar = mkEl('div', 'term-unsaved-bar', '⚠ UNSAVED — close again to discard, or SAVE first'); bar.setAttribute('role', 'alert'); w.appendChild(bar); }
    bar.hidden = false;
    clearTimeout(w._closeArmTimer);
    w._closeArmTimer = setTimeout(() => { if (!w) return; w._closeArmed = false; w._closeArmTimer = 0; const b = w.querySelector('.term-unsaved-bar'); if (b) b.remove(); }, 3000);
  }
  function toggleTerm(key, title, builder, opts) {
    // a minimized window's dock button RESTORES it; a BURIED visible window is RAISED (not closed); only the
    // topmost visible window toggles closed (through the unsaved-draft guard). This kills the "clicked the dock to
    // reach my panel and it vanished" trap when several windows are stacked.
    if (open[key]) {
      if (minimized[key]) { restoreTerm(key); return; }
      const w = open[key];
      const z = e => (parseInt(e.style.zIndex, 10) || 0);
      const vis = Object.keys(open).filter(k => !minimized[k]).map(k => open[k]);
      const maxZ = vis.reduce((m, e) => Math.max(m, z(e)), 0);
      if (vis.length > 1 && z(w) < maxZ) {   // buried → raise + focus rather than close
        w.style.zIndex = U.zTop();
        sfx('open');
        try { (termFocusables(w)[0] || w).focus(); } catch (_) {}
        return;
      }
      requestCloseTerm(key);
      return;
    }
    // Mode-exclusivity: a dock panel and full-screen REFIT must never be mounted at once.
    // Opening a panel exits refit first so two features can't stack (see COHERENCE_MATRIX dim T).
    if (typeof Build !== 'undefined' && Build.isOpen && Build.isOpen()) { try { Build.close(); } catch (_) {} }
    sfx('open');
    // a11y: remember who opened this so focus can return there on close (the dock item / trigger).
    const opener = (typeof document !== 'undefined' && document.activeElement) || null;
    const w = mkEl('div', 'term');
    w.style.zIndex = U.zTop();
    // CONSOLE MODE: a large two-pane window (section rail + content pane). Its size is owned by CSS
    // (.term.console), so a per-panel opts.w must NOT be applied — an inline 500px would starve the rail.
    if (opts && opts.console) w.classList.add('console');
    else if (opts && opts.w) w.style.width = opts.w;
    if (opts && opts.className) w.classList.add(opts.className);
    w._sizeLimits = terminalLimits(opts);
    const savedSize = termSize[key];
    if (savedSize) resizeTermTo(w, key, savedSize.width, savedSize.height, false);
    w._onClose = opts && opts.onClose;
    w._opener = opener;
    // a11y: a floating window is a real modal dialog — label it by its title, make it focusable.
    const titleId = 'term-title-' + (++termTitleSeq);
    w.setAttribute('role', 'dialog');
    // NOT aria-modal: several windows can be open at once and the scrim is pointer-events:none, so the page
    // behind stays reachable — claiming modal would mislead a screen reader. Focus is still Tab-trapped below.
    w.setAttribute('aria-labelledby', titleId);
    w.tabIndex = -1;
    // Phase-2 chrome: a subtle status LED at the head's left + the inverted title chip. The LED reads as
    // "this window is live" — pure decoration (static ok-green), pointer-events off so it never eats the drag.
    const head = mkEl('div', 'term-head',
      '<span class="term-led" aria-hidden="true"></span>' +
      '<span class="term-title" id="' + titleId + '">' + title + '</span>');
    // minimize control — sits left of ✕. Collapses the window to a strip chip (keeps it logically open).
    const mn = mkEl('button', 'term-min', '–');
    mn.setAttribute('aria-label', 'Minimize ' + title);
    mn.setAttribute('type', 'button');
    mn.addEventListener('click', ev => { ev.stopPropagation(); minimizeTerm(key); });
    head.appendChild(mn);
    const x = mkEl('button', 'term-x', '✕');
    x.setAttribute('aria-label', 'Close ' + title);
    x.addEventListener('click', () => requestCloseTerm(key));   // unsaved-draft guard sits on this path
    head.appendChild(x);
    const body = mkEl('div', 'term-body');
    if (opts && opts.feature) {
      // hero "feature window": wrap the screen in a molded monitor casing
      w.classList.add('feature');
      const screen = mkEl('div', 'term-screen');
      screen.appendChild(head); screen.appendChild(body);
      w.appendChild(screen);
      w.appendChild(mkEl('div', 'term-plate',
        '<span>STARNET DYNAMICS</span><span class="term-knobs"><i class="knob"></i><i class="knob"></i></span>'));
    } else {
      w.appendChild(head); w.appendChild(body);
      // Phase-2 chrome (generic, plain windows only — feature windows carry their own casing):
      //   · four corner L-brackets + a faint top light-grade overlay for glass depth (both pointer-events:none)
      //   · a thin footer plate (status text left, grip dots right). All purely cosmetic — appended AFTER the
      //     body so they never disturb the focus-trap order (term-x remains the last focusable control).
      const chrome = mkEl('div', 'term-chrome');
      chrome.setAttribute('aria-hidden', 'true');
      chrome.innerHTML =
        '<span class="term-brk tl"></span><span class="term-brk tr"></span>' +
        '<span class="term-brk bl"></span><span class="term-brk br"></span>' +
        '<span class="term-grade"></span>';
      w.appendChild(chrome);
      w.appendChild(mkEl('div', 'term-foot',
        '<span class="term-foot-d" aria-hidden="true"></span>' +
        // the plate names the WINDOW (its title), not the internal registry key — so CHANNELS reads CHANNELS,
        // never the stale internal "MESSAGING". Titles are plain strings; strip any markup + uppercase for the plate.
        '<span class="term-foot-k">' + esc(String(title).replace(/<[^>]*>/g, '').toUpperCase()) + '</span>' +
        '<span class="term-foot-sp"></span>' +
        '<span class="term-foot-grip" aria-hidden="true">···</span>'));
    }
    addTermResizeHandle(w, key, String(title).replace(/<[^>]*>/g, ''));
    $('#terms').appendChild(w);
    open[key] = w;
    placeTerm(w, key);   // land in a cascaded slot (or its remembered spot) — never dead-center pile-up
    w.addEventListener('mousedown', ev => {
      w.style.zIndex = U.zTop();
      // pull focus into the dialog on a background click so the window-level Esc/Tab handlers keep working —
      // but never steal focus from a control the user is actually clicking (mousedown fires before its focus lands).
      const t = ev.target;
      const onControl = t && t.closest && t.closest('button, input, textarea, select, a[href], [tabindex]');
      if (!onControl && !w.contains(document.activeElement)) { try { w.focus(); } catch (_) {} }
    });
    // dirty-tracking for the unsaved-draft close guard: any keystroke into a textarea (CONFIG file / memory /
    // commander belief editor) flags THAT textarea modified. Delegated once per window; the flag rides the
    // textarea element, which a save/cancel rerender destroys — so it can never go stale.
    w.addEventListener('input', ev => { const t = ev.target; if (t && t.tagName === 'TEXTAREA') t.dataset.dirty = '1'; });
    head.addEventListener('mousedown', ev => {
      if (ev.target === x || ev.target === mn) return;   // header controls handle their own clicks
      // Bake the window's CURRENT VISUAL position into explicit left/top before dragging. A freshly
      // opened single window is centered purely in CSS (left/top:50% + translate(-50%,-50%)), so its
      // offsetLeft/offsetTop report the PRE-transform corner (viewport centre) — anchoring the drag off
      // that, then dropping the transform, snapped the window half its own size away on grab. We also
      // cancel the power-on animation first: a RUNNING CSS animation overrides inline transform, so
      // without this a grab mid-open still jumped (and the rect would be read mid-scale). With the
      // animation cleared, the rect reflects the settled centered position and the cursor tracks exactly.
      w.style.animation = 'none';
      // rect is visual px, style.left zoomed-space (TEXT SIZE) — divide by uiZoom() so grab doesn't shift.
      const z = uiZoom(), r = w.getBoundingClientRect();
      w.style.left = (r.left / z) + 'px';
      w.style.top = (r.top / z) + 'px';
      w.style.transform = 'none';
      w.classList.add('term-moved');   // close animation must not re-centre a dragged window
      // cache size once at grab (it can't change mid-drag) so the move handler never forces a layout read.
      // dx/dy and ww/wh are LOCAL (zoomed-space) px, matching the mousemove handler's clientX/z reads.
      termDrag = { w, dx: (ev.clientX - r.left) / z, dy: (ev.clientY - r.top) / z, ww: r.width / z, wh: r.height / z };
      ev.preventDefault();
    });
    // double-click the header (not its buttons) minimizes — cheap muscle-memory. Skip if the last grab was
    // an actual drag (a drag-release-quick-click can otherwise register as a dblclick).
    head.addEventListener('dblclick', ev => {
      if (ev.target === x || ev.target === mn) return;
      if (w._lastDragMoved) return;
      ev.preventDefault();
      minimizeTerm(key);
    });
    // a11y: Esc closes; Tab is trapped within the window (focus can't leak to the page behind).
    w.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') {
        ev.preventDefault(); ev.stopPropagation();
        // Esc inside a text field NEVER closes the window (draft-loss trap): the first Esc just leaves the field.
        // A field with its own Esc handler (search-clear, rename-cancel) already stopped propagation before us.
        const ae = document.activeElement;
        const inField = ae && w.contains(ae) && ae.matches && ae.matches('input, textarea, [contenteditable=""], [contenteditable="true"]');
        if (inField) { try { ae.blur(); } catch (_) {} return; }
        requestCloseTerm(key);   // unsaved-draft guard
        return;
      }
      if (ev.key !== 'Tab') return;
      const f = termFocusables(w);
      if (!f.length) { ev.preventDefault(); w.focus(); return; }
      const first = f[0], last = f[f.length - 1], act = document.activeElement;
      if (!w.contains(act)) { ev.preventDefault(); first.focus(); }
      else if (ev.shiftKey && act === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && act === last) { ev.preventDefault(); first.focus(); }
    });
    w._render = (swap) => {
      builder(body);
      // tab/section crossfade: fade the freshly-injected body in on RE-renders (tab swaps,
      // live refreshes) — not on the initial mount, which already plays the CRT power-on.
      if (swap) {
        body.classList.remove('swap-in');
        void body.offsetWidth;   // restart the animation if it was mid-flight
        body.classList.add('swap-in');
      }
      requestAnimationFrame(() => fitTermInViewport(w, key, true));
    };
    w._render();
    // a11y: land focus on the dialog itself (role=dialog, tabIndex -1) — NOT the first control, which was the
    // minimize (–) button and read as a jarring first stop. Esc/Tab work from here; Tab advances into the body.
    // A builder that opened an inline editor (rename / CONFIG file) focuses its own field after this and wins.
    try { w.focus(); } catch (_) {}
    syncBB(); syncScrim();
  }
  function rerender(key) { if (open[key]) open[key]._render(true); }
  function syncBB() {
    document.querySelectorAll('.bb[data-term]').forEach(b => b.classList.toggle('active', !!open[b.dataset.term]));
  }

  /* ============== CONSOLE MODE — the large two-pane window framework ==============
     A dense panel (SETTINGS, SKILLS) opts into this via opts.console. Instead of one long scroll,
     the builder declares SECTIONS ([{id,label,glyph,desc,build(paneEl)}]); mountConsole lays out a
     left section rail + a right content pane that shows ONE section at a time (with the .swap-in
     crossfade), plus an optional cross-section search.

     KEY DESIGN: every section's pane is built up-front and lives in the DOM at once (inactive panes
     hidden, not removed). That lets the caller run its existing wiring (wireBudget/wireFallbackChain/…)
     ONCE against the returned content root and reach every control — no per-section rewire, and no
     regression of the settings behaviour/ids the tests source-lock. The builder returns nothing; it
     calls mountConsole(body, key, sections, opts) and then wires the returned host. */
  function mountConsole(body, key, sections, opts) {
    opts = opts || {};
    body.classList.add('term-console-body');
    body.classList.toggle('con-tabstop', !!opts.tabsTop);
    body.innerHTML = '';
    // pick the section to land on: remembered > first. A stale remembered id (section removed) falls back.
    let activeId = consoleSection[key];
    if (!sections.some(s => s.id === activeId)) activeId = sections[0] && sections[0].id;

    // ---- left: optional rail-top slot (e.g. the dossier roster) + optional search + the section rail (role=tablist) ----
    const left = mkEl('div', 'con-rail');
    // railTop: a caller-owned block above the search + section list (the AGENT DOSSIER mounts its roster here).
    // Settings/Skills pass nothing → the slot is never created, so they are entirely unaffected.
    if (typeof opts.railTop === 'function') {
      const top = mkEl('div', 'con-rail-top');
      try { opts.railTop(top); } catch (_) {}
      left.appendChild(top);
    }
    let searchInput = null;
    if (opts.search) {
      const sw = mkEl('div', 'con-search');
      sw.innerHTML = '<span class="con-search-i" aria-hidden="true">⌕</span>' +
        '<input type="text" class="con-search-in" placeholder="' + esc(opts.searchPlaceholder || 'search settings…') +
        '" autocomplete="off" spellcheck="false" aria-label="Search ' + esc(key) + '">';
      left.appendChild(sw);
      searchInput = sw.querySelector('.con-search-in');
    }
    // tabsTop (additive): the section tabs move OUT of the rail into a horizontal strip at the top of
    // the content pane. The rail then holds only opts.railTop (+ search). Callers that pass nothing get
    // the identical vertical rail — this whole branch is inert for them. The AGENT DOSSIER opts in so its
    // left rail is purely the agent roster.
    const tabsTop = !!opts.tabsTop;
    const rail = mkEl('div', 'con-rail-list');
    rail.setAttribute('role', 'tablist');
    rail.setAttribute('aria-label', String(key).toUpperCase() + ' sections');
    if (!tabsTop) left.appendChild(rail);

    // ---- right: the content host (all panes mounted; one visible) ----
    const host = mkEl('div', 'con-pane');
    // the horizontal tab strip lives at the top of the pane in tabsTop mode; it reuses the tablist role.
    let topTabs = null;
    if (tabsTop) {
      topTabs = mkEl('div', 'con-toptabs');
      topTabs.setAttribute('role', 'tablist');
      topTabs.setAttribute('aria-label', String(key).toUpperCase() + ' sections');
      host.appendChild(topTabs);
    }

    const railItems = {};    // id -> rail/tab button
    const panes = {};        // id -> pane wrapper element
    sections.forEach((sec, i) => {
      const item = mkEl('button', tabsTop ? 'con-rail-item con-toptab' : 'con-rail-item');
      item.type = 'button';
      item.dataset.section = sec.id;
      item.setAttribute('role', 'tab');
      item.id = 'con-tab-' + key + '-' + sec.id;
      item.innerHTML = '<span class="con-rail-glyph" aria-hidden="true">' + (sec.glyph || '▪') + '</span>' +
        '<span class="con-rail-label">' + esc(sec.label) + '</span>';
      item.addEventListener('click', () => selectSection(sec.id, true));
      (tabsTop ? topTabs : rail).appendChild(item);
      railItems[sec.id] = item;

      // build the pane content once, into its own section wrapper (header + description + body slot)
      const pane = mkEl('section', 'con-sec');
      pane.dataset.section = sec.id;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', item.id);
      pane.innerHTML =
        '<div class="sec con-sec-head"><span class="sec-l">' + esc(sec.label) + '</span>' +
          '<span class="sec-r"></span><span class="sec-nd"></span></div>' +
        (sec.desc ? '<p class="con-sec-desc">' + esc(sec.desc) + '</p>' : '');
      const slot = mkEl('div', 'con-sec-body');
      pane.appendChild(slot);
      try { sec.build(slot); } catch (e) { slot.innerHTML = '<p class="con-sec-desc">This section failed to render.</p>'; }
      host.appendChild(pane);
      panes[sec.id] = pane;
    });

    body.appendChild(left);
    body.appendChild(host);

    function selectSection(id, viaClick) {
      if (!panes[id]) return;
      consoleSection[key] = id;
      if (viaClick) saveWindowState();   // remember the section the Commander navigated to, across reloads
      activeId = id;
      Object.keys(panes).forEach(k => {
        const on = k === id;
        railItems[k].classList.toggle('active', on);
        railItems[k].setAttribute('aria-selected', on ? 'true' : 'false');
        railItems[k].tabIndex = on ? 0 : -1;
        panes[k].classList.toggle('con-sec-hidden', !on);
      });
      // crossfade the newly shown pane (never on the very first mount, which rides the CRT power-on)
      if (viaClick) {
        host.classList.remove('swap-in'); void host.offsetWidth; host.classList.add('swap-in');
        host.scrollTop = 0;
      }
      if (viaClick) { try { railItems[id].focus(); } catch (_) {} }
    }

    // Search is temporary context, not navigation: expose which matching section owns the
    // visible results without overwriting the section the user chose and persisted.
    function setSearchContext(id) {
      Object.keys(railItems).forEach(k => {
        const on = k === id;
        railItems[k].classList.toggle('active', on);
        railItems[k].setAttribute('aria-selected', on ? 'true' : 'false');
        railItems[k].tabIndex = on ? 0 : -1;
      });
    }

    // keyboard nav on the tablist: Up/Down (vertical rail) or Left/Right (horizontal top strip) move + activate;
    // Home/End jump ends. Both arrow pairs are accepted regardless of orientation, so this handler is shared.
    (tabsTop ? topTabs : rail).addEventListener('keydown', ev => {
      const ids = sections.map(s => s.id);
      const cur = ids.indexOf(activeId);
      let next = -1;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') next = (cur + 1) % ids.length;
      else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') next = (cur - 1 + ids.length) % ids.length;
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = ids.length - 1;
      else return;
      ev.preventDefault(); selectSection(ids[next], true);
    });

    // ---- search: filter rows across every section, dim empty sections, group matches ----
    if (searchInput) {
      const doFilter = () => {
        const q = (searchInput.value || '').trim().toLowerCase();
        body.classList.toggle('con-searching', !!q);
        if (!q) {
          // restore: show the active section only, clear all row dimming + section flags
          Object.keys(panes).forEach(k => {
            panes[k].classList.remove('con-sec-nomatch', 'con-sec-searchshow');
            panes[k].querySelectorAll('.con-hit, .con-miss').forEach(r => r.classList.remove('con-hit', 'con-miss'));
            railItems[k].classList.remove('con-rail-dim', 'con-rail-hit');
          });
          selectSection(activeId, false);
          return;
        }
        // in search mode every section pane is shown; rows are marked hit/miss; a zero-hit section dims its rail item
        const matches = [];
        sections.forEach(sec => {
          const pane = panes[sec.id];
          pane.classList.remove('con-sec-hidden');
          pane.classList.add('con-sec-searchshow');
          // a "row" = a labelled control block. We match on visible text of these granular blocks.
          const rows = pane.querySelectorAll('.con-sec-body .set-row, .con-sec-body label.set-row, .con-sec-body .prov-card, .con-sec-body .key-row, .con-sec-body .set-about, .con-sec-body .ms-h, .con-sec-body .perk, .con-sec-body .sk-card, .con-sec-body .mc-hint, .con-sec-body .mc-row, .con-sec-body .ts-row');
          let hits = 0;
          rows.forEach(r => {
            const hit = (r.textContent || '').toLowerCase().indexOf(q) >= 0;
            r.classList.toggle('con-hit', hit);
            r.classList.toggle('con-miss', !hit);
            if (hit) hits++;
          });
          // also let a section match by its own label/desc even if no granular row matched
          const secMatch = hits > 0 || sec.label.toLowerCase().indexOf(q) >= 0 || (sec.desc || '').toLowerCase().indexOf(q) >= 0;
          if (secMatch) matches.push(sec.id);
          pane.classList.toggle('con-sec-nomatch', !secMatch);
          railItems[sec.id].classList.toggle('con-rail-dim', !secMatch);
          railItems[sec.id].classList.toggle('con-rail-hit', secMatch);
        });
        setSearchContext(matches[0] || null);
      };
      searchInput.addEventListener('input', doFilter);
      // Esc: first clears a non-empty search (and refocuses), only then lets the window's Esc close it.
      searchInput.addEventListener('keydown', ev => {
        if (ev.key === 'Escape' && (searchInput.value || '').trim()) {
          ev.preventDefault(); ev.stopPropagation();
          searchInput.value = ''; doFilter(); searchInput.focus();
        }
      });
      // clicking a section's mini-header while searching jumps to it (clears search, lands there)
      host.addEventListener('click', ev => {
        if (!body.classList.contains('con-searching')) return;
        const head = ev.target.closest('.con-sec-head'); if (!head) return;
        const pane = head.closest('.con-sec'); if (!pane) return;
        searchInput.value = ''; doFilter(); selectSection(pane.dataset.section, true);
      });
    }

    selectSection(activeId, false);
    return host;   // caller wires its controls against this (spans every section pane)
  }

  /* ============== CREW MANIFEST (left panel) ============== */
  function duplicateAgentName(a) {
    if (!a || !a.name) return '';
    const key = String(a.name).trim().toUpperCase();
    return present.filter(x => x && String(x.name || '').trim().toUpperCase() === key).length > 1 ? String(a.id || '') : '';
  }
  function crewRender() {
    wireCrewLive();   // ensure the per-agent run-state listener is live
    const ul = $('#crew'); if (!ul) return;
    if (!present.length) {
      ul.innerHTML = '<li class="crew-empty"><div class="empty-state"><span class="es-glyph">▯</span><b>NO AGENTS ON STATION</b><span>Commission one from RECRUITMENT to begin.</span></div></li>';
      $('#crew-n').textContent = '';
      $('#crew-sum').innerHTML = '';
      return;
    }
    ul.innerHTML = present.map((a, i) =>
      '<li class="crew-row" data-i="' + i + '" data-agent-id="' + esc(a.id) + '" style="--ci:' + i + '">' +
      '<span class="dot on"></span>' +
      '<div class="crew-main">' +
      '<div class="crew-name" style="color:' + esc(a.color) + '">' + esc(a.name) +
      (duplicateAgentName(a) ? '<span class="crew-id">[' + esc(duplicateAgentName(a)) + ']</span>' : '') +
      '<span class="crew-room">' + (a.stats && a.stats.level ? 'Lv ' + a.stats.level : '') + '</span></div>' +
      '<div class="crew-status" id="cs-' + esc(a.id) + '">…</div>' +
      // in-flight work bar: hidden until the row is .working (crewTick toggles it from the real run state).
      // The shimmer (.bar-active) reads as live activity; it's an indeterminate sweep, not a % readout.
      '<div class="crew-prog bar-active" id="cp-' + esc(a.id) + '" aria-hidden="true"><div></div></div>' +
      '</div></li>').join('');
    $('#crew-n').textContent = present.length + (present.length === 1 ? ' AGENT' : ' AGENTS');
    ul.querySelectorAll('.crew-row').forEach(li =>
      li.addEventListener('click', () => { sfx('click'); openAgent(+li.dataset.i); }));
    crewTick();
  }
  // a crew member is WORKING iff IT has a live run — read from the real agent.run.start/end events, NOT the
  // single global hero activity (which used to mark the whole crew WORKING in lockstep with the hero). The
  // talk/task text flavor still comes from the global activity (right for the common single-agent station).
  function crewTick() {
    if (!present.length) return;
    // self-heal: drop any tracked id no longer on the roster (a left agent, or a stale id left behind when an
    // aborted/dropped run's agent.run.end never reached the bus) so the panel can't get stuck showing it WORKING.
    for (const id of Array.from(runningAgents.keys())) { if (!present.some(a => a.id === id)) { runningAgents.delete(id); runSeenAt.delete(id); } }
    const act = activity();
    let working = 0;
    present.forEach(a => {
      const live = agentLive(a.id);
      if (live) working++;
      const e = $('#cs-' + a.id);
      if (e) e.textContent = live ? (act === 'talk' ? 'in conversation' : 'working at the terminal') : 'idle — awaiting orders';
      // H: mark the row WORKING so the in-flight shimmer bar shows only while it's actually running.
      if (e && e.parentElement && e.parentElement.parentElement) e.parentElement.parentElement.classList.toggle('working', live);
    });
    const sum = $('#crew-sum');
    if (sum) sum.innerHTML =
      '<span class="pos">▮ ' + working + ' WORKING</span>' +
      '<span class="dim">▯ ' + (present.length - working) + ' IDLE</span>';
    // #8: keep the canvas's screen-reader live region in sync (the <canvas> itself is opaque to AT).
    // Update only when the text actually changes so the region doesn't spam announcements every tick.
    const stageSum = $('#stage-summary');
    if (stageSum) {
      const txt = 'Station crew: ' + working + ' working, ' + (present.length - working) + ' idle.';
      if (txt !== lastStageSummary) { lastStageSummary = txt; stageSum.textContent = txt; }
    }
  }
  // ref-counted so two concurrent runs sharing an agentId (e.g. two hero streams as 'agent') both count, and
  // one finishing doesn't prematurely flip the pill to IDLE while the other is still live. Deleted at 0 so
  // crewTick's agentLive(id) stays a clean "is this agent working?" test.
  function incRun(id) { runningAgents.set(id, (runningAgents.get(id) || 0) + 1); runSeenAt.set(id, performance.now()); }
  function decRun(id) { const n = (runningAgents.get(id) || 0) - 1; if (n > 0) runningAgents.set(id, n); else { runningAgents.delete(id); runSeenAt.delete(id); } }
  // THE one "is this agent working?" predicate (crew list, warroom dots, dossier roster). The local count is
  // event-fed only, so a LOST agent.run.end (dropped SSE frame, stream that closed without the end event,
  // sidecar restart) would assert "working at the terminal" forever while the world correctly stands the
  // sprite down — the app claiming state the harness can't prove. World.agentRunsLive is the same run
  // refcount but under the E2 truth nets (chat-teardown dropRun, 5m TTL sweep, snapshot reconciliation), so
  // it is the tie-breaker in BOTH directions: it vetoes a stale local count (after a short grace, since
  // within one bus emit this module's listener may fire before World's), and it lights an agent whose run
  // the local map never saw start (reconnect mid-run — the snapshot rebuilt World, not this map).
  function agentLive(id) {
    let worldN = -1;   // -1 = unknowable (World absent/not started) → fall back to the local event count
    try { if (typeof World !== 'undefined' && World.agentRunsLive) worldN = World.agentRunsLive(id); } catch (_) { worldN = -1; }
    if (!runningAgents.has(id)) return worldN > 0;
    if (worldN === 0 && performance.now() - (runSeenAt.get(id) || 0) > 8000) {
      runningAgents.delete(id); runSeenAt.delete(id);   // self-heal: the world PROVES no live run — drop the stale count
      return false;
    }
    return true;
  }
  // register ONCE: track which agents actually have a live run so the crew panel reflects per-agent truth.
  function wireCrewLive() {
    if (crewLiveWired || typeof U === 'undefined' || !U.bus) return;
    crewLiveWired = true;
    U.bus.on('agent.run.start', p => { if (p && p.agentId) { incRun(p.agentId); crewTick(); } });
    U.bus.on('agent.run.end', p => { if (p && p.agentId) { decRun(p.agentId); crewTick(); } });
  }
  // Called from chat.js's run-teardown ONLY on the abort/throw path, where agent.run.end is LOST (E-STOP /
  // cancel / disconnect / network drop) and would otherwise leave the count stuck >0. Normal completions
  // decrement via the agent.run.end listener above — this must NOT also fire for them (double-decrement).
  function clearRunning(agentId) {
    if (!agentId) return;
    decRun(agentId); crewTick();
  }

  /* ============== AGENTS — DOSSIER ==============
     Two sub-tabs. BRIEF is live agent status. CONFIG is the agent's actual
     markdown config files — identity.md / purpose.md / operating-manual.md compose the EXACT
     system prompt the model runs on, so editing one here re-shapes the agent for real (App's
     applyAgentConfig, injected as access.config.apply). memory.md is the agent's own notebook —
     shown read-only and honestly labelled, because the agent writes it, not the Commander. */
  // DOSSIER is CONSOLE MODE: the five sub-tabs are console sections (ids brief|growth|memory|skills|config),
  // so the ACTIVE section lives in consoleSection['agents'] (not a private var). agSection() reads it with a
  // 'brief' fallback; it's the single source of truth for the memory-live guard + the BRIEF-only tick.
  function agSection() { return consoleSection['agents'] || 'brief'; }
  const agEdit = {};        // config fileKey -> true while its editor is open
  let memLiveWired = false, memRefreshTimer = 0;   // M-mem.6: the once-wired, debounced Memory Core live-refresh
  let skillsLiveWired = false, skillsRefreshTimer = 0;   // A3: the once-wired, debounced AGENT SKILLS live-refresh

  const CONFIG_FILES = [
    { key: 'identity', file: 'identity.md', badge: 'YOU WRITE THIS',
      desc: 'The system prompt sent to the model on every run — the heart of who your agent is.',
      ph: 'You are …' },
    { key: 'purpose', file: 'purpose.md', badge: 'YOU WRITE THIS',
      desc: 'What your agent is for. Folded into the prompt so it colours everything it does.',
      ph: 'e.g. Track AI-policy news and brief me each morning.' },
    { key: 'context', file: 'context.md', badge: 'YOU WRITE THIS',
      desc: 'About you and your world — your project, domain, and what "good" looks like. Grounds every run.',
      ph: 'e.g. I build TypeScript web apps solo; "good" = tested, minimal diffs, no hand-waving.' },
    { key: 'manual', file: 'operating-manual.md', badge: 'YOU WRITE THIS',
      desc: 'House rules appended to every run — tone, format, the do-nots. Always obeyed.',
      ph: '- Cite your sources.\n- Keep it terse.\n- Never message anyone without asking first.' }
  ];

  function docVal(a, key) {
    const d = (a && a.docs) || {};
    if (typeof d[key] === 'string') return d[key];
    if (key === 'purpose') return (a && a.purpose) || '';
    return '';
  }
  function agSlug(a) {
    return ((a && a.name) || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
  }

  function agHead(a, act) {
    const dn = linkDown();   // E2: link gone → the dossier can't honestly say ONLINE either
    const dotCls = dn ? 'down' : act === 'task' ? 'working' : act === 'talk' ? 'thinking' : 'on';
    const statusText = dn ? 'OFFLINE' : act === 'task' ? 'WORKING' : act === 'talk' ? 'THINKING' : 'ONLINE';
    const lv = (typeof Xp !== 'undefined' && a.stats) ? Xp.compute(a.stats).level : null;   // always-visible level chip
    return '<div class="ag-hero">' +
      // recessed portrait WELL: corner ticks + a slow scan-sweep overlay (v2 hero pattern). The sweep +
      // ticks are pointer-events:none cosmetic overlays; the canvas keeps rendering the live agent body.
      '<div class="ag-portrait-wrap"><div class="ag-portrait-well">' +
        '<span class="ag-ptick a"></span><span class="ag-ptick b"></span><span class="ag-ptick c"></span><span class="ag-ptick d"></span>' +
        '<span class="ag-psweep" aria-hidden="true"></span>' +
        '<canvas id="ag-portrait" width="84" height="112"></canvas>' +
      '</div></div>' +
      '<div class="ag-info">' +
      // NAME — read-only with a ✎ rename affordance, or an inline editor while agEdit['__name'] is set (wired in wireHead).
      (agEdit['__name']
        ? '<div class="ag-name-edit">' +
            '<input id="ag-rename-in" class="ag-name-input" type="text" maxlength="18" spellcheck="false" autocomplete="off" value="' + esc(a.name) + '" aria-label="Rename agent" style="color:' + a.color + '">' +
            '<button class="ag-name-ok" id="ag-rename-save" title="save name" aria-label="Save name">✓</button>' +
            '<button class="ag-name-x" id="ag-rename-cancel" title="cancel" aria-label="Cancel rename">✕</button></div>'
        : '<div class="ag-name" style="color:' + a.color + '">' + esc(a.name) +
            (duplicateAgentName(a) ? '<span class="ag-name-id">[' + esc(duplicateAgentName(a)) + ']</span>' : '') +
            '<button class="ag-rename" id="ag-rename-btn" title="rename this agent" aria-label="Rename agent">✎</button>' +
            (lv ? '<span class="ag-lv">Lv ' + lv + '</span>' : '') + '</div>') +
      '<div class="ag-role-line"><span class="ag-sdot ' + dotCls + '"></span>' + statusText + '</div>' +
      '<div class="ag-tags">' +
      // the agent's deployed SPECIALTY (set by the Recruitment Bay) — its primary "what it's FOR" identity, shown first.
      ((typeof Specialties !== 'undefined' && a.specialtyId) ? (function () { var s = Specialties.get(a.specialtyId); return s ? '<span class="tag">' + esc(s.emoji + ' ' + s.name) + '</span>' : ''; })() : '') +
      // MODEL tag doubles as the shortcut into CONFIG › model (wired in wireHead) so "change the model" is one click from anywhere.
      '<span class="tag model" data-goconfig="1" role="button" tabindex="0" title="change this agent’s model">' + esc(a.model || '—') + '</span>' +
      '</div></div></div>';
  }

  function agBrief(a) {
    const since = a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '—';
    // BRIEF stat wells — compact 3-up readout, all THREE per-agent (no station totals wearing an agent label):
    // RUNS (this agent's own attempt counter from the Xp ledger), LEVEL (pure Xp engine), KUDOS (positive
    // feedback). The full Level/XP/Satisfaction/milestone readout still lives in the GROWTH tab.
    const g = (typeof Xp !== 'undefined' && a.stats) ? Xp.compute(a.stats) : null;
    const lvl = g ? g.level : '—';
    const kudos = g ? g.positiveFeedback : 0;
    const runs = (a.stats && a.stats.counters && a.stats.counters.runs) || 0;   // per-agent run count (agent.run.end folds here)
    return '<div class="stat-grid">' +
      '<div class="stat-cell"><div class="stat-val">' + runs + '</div><div class="stat-lbl">RUNS</div></div>' +
      '<div class="stat-cell"><div class="stat-val">' + lvl + '</div><div class="stat-lbl">LEVEL</div></div>' +
      '<div class="stat-cell"><div class="stat-val pos">' + kudos + '</div><div class="stat-lbl">KUDOS</div></div>' +
      '</div>' +
      '<div class="ag-mission"><div class="ag-mission-lbl">PURPOSE</div>' +
      (a.purpose
        ? '<div class="ag-mission-text">' + esc(a.purpose) + '</div>'
        : '<div class="ag-mission-cta">No purpose set — tell your agent what you need in COMMS, or write it in CONFIG › purpose.md.</div>') +
      '</div>' +
      '<div class="ag-foot-row">on station since <b>' + since + '</b></div>';
  }

  // COMMANDER CONTROLS (dossier BRIEF): change this agent's SKIN and DELETE it. Both use the SAME genesis skin
  // catalog (DATA.SKINS — single source of truth) and reuse the .skin-thumb visual vocabulary from the create
  // screen. DELETE is a two-click armed confirm (ArmConfirm) and is disabled — with a stated reason, not a
  // prompt — for the hero and for the last remaining agent. Wired in wireCommand.
  function agCommand(a) {
    const skins = (typeof DATA !== 'undefined' && DATA.SKINS) ? DATA.SKINS : {};
    const cur = (a && a.skin && skins[a.skin]) ? a.skin : (typeof DATA !== 'undefined' ? DATA.DEFAULT_SKIN : '');
    const thumbs = Object.keys(skins).map(id => {
      const sk = skins[id];
      return '<button type="button" class="skin-thumb ag-skin-thumb' + (id === cur ? ' sel' : '') + '" data-skin="' + esc(id) + '" title="' + esc(sk.name || id) + '" aria-label="' + esc(sk.name || id) + '">' +
        '<img src="assets/sprites/' + esc(sk.set) + '/rot_south.png" alt="' + esc(sk.name || id) + '" draggable="false"></button>';
    }).join('');
    // DELETE gating: the hero (orchestrator / id 'agent') is undeletable; so is the last agent on station.
    const isHero = (a && (a.id === 'agent' || a.role === 'orchestrator'));
    const crewCount = (access.config && typeof access.config.crewCount === 'function') ? access.config.crewCount() : present.length;
    const lastOne = crewCount <= 1;
    const disabledReason = isHero ? 'the overseer can’t be deleted' : (lastOne ? 'the last agent can’t be deleted' : '');
    // one statement of the disabled reason (the visible .ag-del-why) — no duplicate tooltip echoing the same words.
    const delBtn = disabledReason
      ? '<button class="bb sm ag-del" id="ag-del-btn" disabled>✕ DELETE AGENT</button>' +
        '<span class="ag-del-why">' + esc(disabledReason) + '</span>'
      : '<button class="bb sm ag-del" id="ag-del-btn" title="archive this agent and remove it from the station">✕ DELETE AGENT</button>' +
        '<span class="ag-del-why">work is archived, not erased</span>';
    return '<div class="ag-command">' +
      '<div class="ag-cmd-sec"><div class="ag-cmd-lbl">SKIN</div>' +
        // role=group, not listbox: the thumbs are <button>s (a picker), not selectable listbox options.
        '<div class="ag-skin-row skin-picker" role="group" aria-label="Agent skin">' + thumbs + '</div></div>' +
      '<div class="ag-cmd-sec ag-cmd-danger"><div class="ag-cmd-lbl">DANGER</div>' +
        '<div class="ag-del-row">' + delBtn + '</div></div>' +
      '</div>';
  }

  // GROWTH tab — the premium agent-growth dossier: XP ladder, a physical satisfaction gauge (honest "—"
  // while calibrating), the milestone trophy case, and the station-prestige rollup. All read off the pure
  // Xp engine; the satisfaction marker rides the agent's own suit colour so it reads as "this unit's measure".
  function agGrowth(a) {
    if (typeof Xp === 'undefined' || !a.stats) return '<p class="dim">Growth metrics unavailable.</p>';
    const g = Xp.compute(a.stats);
    const cat = Xp.milestones(a.stats);
    const earned = cat.filter(m => m.earned).length, locked = cat.length - earned;
    const pad2 = n => (n < 10 ? '0' : '') + n;
    const mark = a.color || 'var(--ph-bright)';

    const progression =
      '<div>' +
      '<div class="gx-sec"><span class="gx-ref">A</span><span class="gx-title">Progression</span><span class="gx-tag">LV ' + g.level + '&rarr;' + (g.level + 1) + '</span></div>' +
      '<div class="gx-row" style="margin-bottom:6px;"><span class="gx-lbl">This level</span>' +
        '<span class="gx-val" style="font-size:15px;">' + g.inLevel + ' <span class="gx-dim">/</span> ' + g.span + ' <span class="gx-dim" style="font-size:11px;">XP</span></span></div>' +
      '<div class="gx-trk" style="margin-bottom:5px;"><div class="gx-fill" style="width:' + g.pct + '%;"></div><div class="gx-mark" style="left:' + g.pct + '%;"></div></div>' +
      '<div class="gx-row"><span class="gx-val gx-dim" style="font-size:12px;">' + g.toNext + ' XP TO LV ' + (g.level + 1) + '</span><span class="gx-val" style="color:var(--ph);font-size:13px;">' + g.pct + '%</span></div>' +
      '<div class="gx-well"><span class="gx-lbl">Positive feedback</span><span class="v">' + g.positiveFeedback + '</span></div>' +
      // what a level actually MEANS (UX sweep 2026-07-15): honest — levels gate nothing (sandbox law);
      // they are the agent's proven track record from work you rated well.
      '<div class="gx-row gx-dim" style="font-size:11px;margin-top:4px;">levels unlock nothing — they’re this agent’s track record, earned from work you rated well</div>' +
      '</div>';

    const confnum = g.known ? (g.confidence + '<span style="font-size:18px;color:var(--ph-dim);">%</span>') : '—';
    const gauge = '<div class="gx-gauge"><div class="gx-zones"><i></i><i></i><i></i><i></i></div>' +
      (g.known ? '<div class="gx-mark" style="left:' + g.confidence + '%;background:' + mark + ';"></div>' +
                 '<div class="gx-marknum" style="left:' + g.confidence + '%;">' + g.confidence + '</div>' : '') +
      '</div>';
    const confidence =
      '<div>' +
      '<div class="gx-sec"><span class="gx-ref">B</span><span class="gx-title">Satisfaction</span><span class="gx-tag">' + (g.known ? 'average of your recent ratings (' + Xp.MIN_SAMPLES + '+ ratings)' : 'calibrating &middot; ' + g.samples + ' of ' + Xp.MIN_SAMPLES + ' ratings so far') + '</span></div>' +
      '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:9px;">' +
        '<span class="gx-confnum' + (g.known ? '' : ' cal') + '">' + confnum + '</span>' +
        '<span class="gx-band' + (g.known ? '' : ' cal') + '">' + (g.known ? g.band.toUpperCase() : 'CALIBRATING') + '</span></div>' +
      gauge +
      '<div class="gx-zlabels"><span>BUILD</span><span>STEADY</span><span>RELIABLE</span><span class="hot">TRUST</span></div>' +
      '<div class="gx-well' + (g.bonus ? ' gold' : '') + '"><span class="gx-lbl">Feedback bonus</span><span class="v">' + (g.bonus ? '+' + g.bonus + '%' : '—') + '</span></div>' +
      '</div>';

    const tros = cat.map(m =>
      '<div class="gx-tro ' + (m.earned ? 'on' : 'off') + '">' +
      '<div style="display:flex;align-items:center;gap:6px;"><span class="gl">' + (m.earned ? '&#9733;' : '&#9675;') + '</span><span class="nm">' + m.label + '</span></div>' +
      '<div class="sub">' + (m.earned ? 'EARNED' : '&#9656; ' + m.hint) + '</div></div>').join('');
    const trophies =
      '<div class="gx-trohead"><div class="gx-sec" style="flex:1;margin:0;border:0;height:auto;"><span class="gx-ref">C</span><span class="gx-title">Trophy case</span></div>' +
      '<span class="gx-tag">' + pad2(earned) + ' earned &middot; ' + pad2(locked) + ' locked</span></div>' +
      '<div class="gx-tros">' + tros + '</div>';

    const sStats = (typeof XpStore !== 'undefined' && XpStore.stationStats) ? XpStore.stationStats() : null;
    const s = sStats ? Xp.compute(sStats) : null;
    const nAg = present.length || 1;
    const station = s ? (
      '<div class="gx-station" style="margin-top:18px;">' +
      '<div class="hd"><span class="badge">D</span><span class="ttl">Station prestige</span><span class="agents">&Sigma; ' + nAg + ' AGENT' + (nAg === 1 ? '' : 'S') + '</span></div>' +
      '<div class="body">' +
        '<div class="lv"><div class="gx-lbl" style="font-size:9px;">STATION</div><div class="n">' + s.level + '</div><div class="gx-lbl" style="font-size:9px;">LEVEL</div></div>' +
        '<div style="flex:1;">' +
          '<div class="gx-row" style="margin-bottom:6px;"><span class="gx-val" style="font-size:13px;">' + s.xp.toLocaleString() + ' <span class="gx-dim">/</span> ' + Xp.xpForLevel(s.level + 1).toLocaleString() + ' <span class="gx-dim" style="font-size:11px;">XP</span></span><span class="gx-val" style="color:var(--gold);font-size:13px;">' + s.pct + '%</span></div>' +
          '<div class="gx-trk"><div class="gx-gfill" style="width:' + s.pct + '%;"></div></div>' +
          '<div class="gx-row" style="margin-top:7px;"><span class="gx-val gx-dim" style="font-size:11px;">' + s.toNext.toLocaleString() + ' XP TO LV ' + (s.level + 1) + '</span>' +
            '<span class="gx-mono" style="font-size:10px;color:var(--ph-dim);">' + s.positiveFeedback + ' APPROVALS &middot; <span style="color:var(--ph);">' + (s.known ? s.band.toUpperCase() : 'CALIBRATING') + '</span></span></div>' +
        '</div>' +
      '</div></div>'
    ) : '';

    return '<div class="gx">' +
      '<div class="gx-head"><div><div class="gx-kicker">AGENT DOSSIER // GROWTH READOUT</div><div class="gx-name">' + esc(a.name) + '</div></div>' +
      '<div style="text-align:right;"><div class="gx-kicker" style="margin-bottom:6px;">CLEARANCE</div><span class="gx-clear"><span class="k">LEVEL</span><span class="v">' + pad2(g.level) + '</span></span></div></div>' +
      '<div class="gx-2">' + progression + confidence + '</div>' +
      trophies + station +
      '</div>';
  }

  function agSkills(agentId) {
    const skills = skillsFor(agentId);
    const on = skills.filter(s => s.on).length;
    return '<h4 class="ms-h">GRANTED — ' + on + ' LIVE</h4>' +
      '<div class="perk-grid">' +
      skills.map((s, i) => '<div class="perk ' + (s.on ? 'on' : '') + '" style="--ci:' + i + '">' +
        '<div class="perk-icon">' + s.icon + '</div>' +
        '<div class="perk-name">' + s.name + '</div>' +
        '<div class="perk-desc">' + s.tools + '</div>' +
        '<div class="perk-stat' + (s.consent ? ' ask' : '') + '">' +
        (s.on ? (s.consent ? '● ASKS OK' : '● ENABLED') : '○ LOCKED') + '</div></div>').join('') +
      '</div>' +
      '<p class="sk-note">Capabilities follow the objects at the workstation. Only <b>file writes</b> pause for one-click approval in COMMS. ' +
      'Browse &amp; toggle pre-installed <b>skill recipes</b> in the <b>SKILLS</b> panel (BUILD dock).</p>';
  }

  function fileCard(a, f) {
    const val = docVal(a, f.key), editing = !!agEdit[f.key];
    const head =
      '<div class="cf-head"><span class="cf-name">▤ ' + f.file + '</span>' +
      '<span class="cf-badge you">' + f.badge + '</span>' +
      '<span class="cf-bytes">' + (val || '').length + ' chars</span>' +
      (editing ? '' : '<button class="bb sm cf-edit" data-edit="' + f.key + '">✎ EDIT</button>') +
      '</div><div class="cf-desc">' + f.desc + '</div>';
    if (editing) {
      return '<div class="cf cf-on">' + head +
        '<textarea class="cf-ta" id="cf-ta-' + f.key + '" spellcheck="false" placeholder="' + esc(f.ph) + '">' + esc(val) + '</textarea>' +
        '<div class="cf-acts"><button class="bb sm" data-save="' + f.key + '">SAVE</button>' +
        '<button class="bb sm" data-cancel="' + f.key + '">CANCEL</button></div></div>';
    }
    const bodyHtml = val.trim()
      ? '<pre class="cf-body">' + esc(val) + '</pre>'
      : '<pre class="cf-body empty">— empty — click EDIT to write ' + f.file + ' —</pre>';
    return '<div class="cf">' + head + bodyHtml + '</div>';
  }

  // ---- M-mem.6 MEMORY CORE: the moat made visible. Every stored belief, its provenance (the run that
  //      earned it), its real useCount/trust (a reduction over the memory.* log — NOT invented), and pin /
  //      edit / forget. Rendered as a .gx-framed placeholder, then filled by loadMemoryCore() after the async
  //      fetch (survives retab without a refetch race). Record cards are built as DOM (textContent bodies —
  //      a poisoned/injection entry is inspectable + deletable here but never interpreted, §5.6). ----
  const MEM_KIND = { profile: 'PREFERENCE', fact: 'FACT', skill: 'SKILL', note: 'NOTE' };

  function agMemory(a) {
    return '<div class="gx">' +
      '<div class="gx-head"><div><div class="gx-kicker">AGENT DOSSIER // MEMORY CORE</div><div class="gx-name">' + esc(a.name) + '</div></div>' +
      '<div style="text-align:right;"><div class="gx-kicker" style="margin-bottom:6px;">PROVENANCE</div><span class="gx-clear"><span class="k">TRACED</span><span class="v">&#10003;</span></span></div></div>' +
      // P1-10 REFLECTION controls — the master on/off + the cooldown, both HONORED live at the reflect gate in the
      // sidecar (station-wide, not per-agent — the reflect loop is a station engine). Plus a plain scope note.
      '<div class="gx-sec"><span class="gx-ref">◈</span><span class="gx-title">Reflection</span></div>' +
      '<div class="mc-note" id="mc-scope">How the station learns from finished work.</div>' +
      '<label class="set-row"><input type="checkbox" id="mc-reflect-on"> REFLECTION ON <span class="dim">— propose memories after a completed task</span></label>' +
      '<div class="set-row"><label for="mc-cooldown">COOLDOWN (MINUTES)</label><input id="mc-cooldown" class="key-input" type="number" min="0" max="60" step="1" style="max-width:90px" title="minimum gap between turn-in beats per agent"></div>' +
      '<div class="mc-acts"><button class="bb sm" id="mc-reflect-save">SAVE</button><span class="msg" id="mc-reflect-msg"></span></div>' +
      '<div class="gx-sec"><span class="gx-ref gold">M</span><span class="gx-title">Stored beliefs</span><span class="gx-tag" id="mc-count">&hellip;</span></div>' +
      '<div class="mc-note">Each belief traces to the run that earned it. <b>Pin</b> to lock it to the top of recall &middot; <b>Edit</b> to refine it &middot; <b>Forget</b> to remove it.</div>' +
      '<div id="mc-list" class="mc-list"><span class="loading pulse">reading memory core&hellip;</span></div>' +
      // observability: the permanent reject-list (Discarded proposals never re-proposed). Hidden until non-empty.
      '<div class="gx-sec" id="mc-declined-sec" style="display:none;"><span class="gx-ref">&#10007;</span><span class="gx-title">Declined</span><span class="gx-tag" id="mc-declined-count"></span></div>' +
      '<div class="mc-note" id="mc-declined-note" style="display:none;">Beliefs you Discarded — the station will <b>never propose these again</b>. <b>Restore</b> one to let it be proposed in future.</div>' +
      '<div id="mc-declined-list" class="mc-list"></div>' +
      '</div>';
  }

  function loadMemoryCore(a) {
    const host = $('#mc-list'); if (!host) return;
    if (!(typeof Harness === 'object' && Harness.memoryRecords)) { host.textContent = 'Memory Core unavailable — start the sidecar to read it.'; return; }
    Harness.memoryRecords(a.id).then(records => {
      const cur = $('#mc-list'); if (!cur) return;   // dossier may have closed/retabbed mid-fetch
      renderMemoryList(cur, records, a);
      const cnt = $('#mc-count'); if (cnt) cnt.textContent = records.length + (records.length === 1 ? ' belief' : ' beliefs');
    }).catch(() => { const cur = $('#mc-list'); if (cur) cur.textContent = 'Could not read the Memory Core.'; });
    loadDeclined(a);   // the reject-list renders alongside (its own fetch; absent/empty → the section stays hidden)
    loadReflectionConfig();   // P1-10 reflection on/off + cooldown (station-wide)
  }

  // P1-10: hydrate the reflection controls from /api/memory/config + wire SAVE (persist + live-apply server-side).
  function loadReflectionConfig() {
    const onBox = $('#mc-reflect-on'), cd = $('#mc-cooldown'), scope = $('#mc-scope'), msg = $('#mc-reflect-msg'), saveBtn = $('#mc-reflect-save');
    if (!onBox || !cd) return;
    const setMsg = (t, ok) => { if (msg) { msg.textContent = t || ''; msg.className = 'msg' + (ok ? ' ok' : ''); } };
    Harness.api.get('/api/memory/config').then(cfg => {
      const o = $('#mc-reflect-on'), c = $('#mc-cooldown'), s = $('#mc-scope');
      if (!o || !c) return;   // retabbed mid-fetch
      o.checked = cfg.reflectEnabled !== false;
      c.value = String(Math.round((cfg.reflectCooldownMs != null ? cfg.reflectCooldownMs : 180000) / 60000));
      if (s && cfg.scopeNote) s.textContent = cfg.scopeNote;
    }).catch(() => { setMsg('could not load reflection settings'); });   // never paint an error body as config
    if (saveBtn && !saveBtn._wired) {
      saveBtn._wired = true;
      saveBtn.addEventListener('click', () => {
        const o = $('#mc-reflect-on'), c = $('#mc-cooldown');
        const mins = Number(String(c.value).trim());
        if (!isFinite(mins) || mins < 0 || mins > 60) { setMsg('cooldown: 0–60 minutes'); sfx('bad'); c.focus(); return; }
        setMsg('saving…');
        Harness.api.post('/api/memory/config', { reflectEnabled: !!o.checked, reflectCooldownMs: Math.floor(mins * 60000) })
          .then(({ ok, j }) => {
            if (!ok) { setMsg((j && j.error) || 'could not save'); sfx('bad'); return; }
            setMsg('✓ saved', true); sfx('click');
          }).catch(() => { setMsg('could not reach the sidecar'); sfx('bad'); });
      });
    }
  }

  // the permanent reject-list, shown below the stored beliefs. Each entry can be Restored (un-declined) so a
  // belief discarded by mistake can be proposed again — the visible, reversible half of "discard = never again".
  function loadDeclined(a) {
    const host = $('#mc-declined-list'); if (!host || !(typeof Harness === 'object' && Harness.memoryDeclined)) return;
    Harness.memoryDeclined(a.id).then(list => {
      const h = $('#mc-declined-list'); if (!h) return;
      const sec = $('#mc-declined-sec'), note = $('#mc-declined-note'), cnt = $('#mc-declined-count');
      h.innerHTML = '';
      const show = list.length > 0;
      if (sec) sec.style.display = show ? '' : 'none';
      if (note) note.style.display = show ? '' : 'none';
      if (cnt) cnt.textContent = String(list.length);
      for (const text of list) h.appendChild(declinedCard(text, a));
    }).catch(() => {});
  }

  function declinedCard(text, a) {
    const card = mkEl('div', 'mc-rec mc-declined');
    const bodyEl = mkEl('div', 'mc-body'); bodyEl.textContent = text; card.appendChild(bodyEl);   // textContent — never interpreted
    const btns = mkEl('div', 'consent-btns mc-acts'); card.appendChild(btns);
    let busy = false;
    const b = mkEl('button', 'consent-btn'); b.textContent = 'Restore'; b.title = 'allow this belief to be proposed again';
    b.onclick = async () => {
      if (busy) return; busy = true;
      const r = await Harness.memoryRestore({ agentId: a.id, text });
      if (r && r.ok) { sfx('click'); loadDeclined(a); } else busy = false;
    };
    btns.appendChild(b);
    return card;
  }

  function renderMemoryList(host, records, a) {
    host.innerHTML = '';
    if (!records.length) {
      // shared .empty-state vocabulary (glyph + title + prose) rather than a bare paragraph
      const es = mkEl('div', 'empty-state');
      es.innerHTML = '<span class="es-glyph">◈</span><b>NO MEMORIES YET</b>' +
        '<span>As ' + esc(a.name) + ' works and you Keep what it learns, durable beliefs collect here — ' +
        'each typed, scored, and traceable to the run that earned it.</span>';
      host.appendChild(es); return;
    }
    // pinned first, then most-trusted, then most-recent — the order recall itself favours
    const sorted = records.slice().sort((x, y) =>
      (!!y.pinned - !!x.pinned) || ((y.trust || 0) - (x.trust || 0)) || ((y.createdAt || 0) - (x.createdAt || 0)));
    sorted.forEach((rec, i) => { const c = memCard(rec, a); c.style.setProperty('--ci', String(i)); host.appendChild(c); });
  }

  function memCard(rec, a) {
    const card = mkEl('div', 'mc-rec' + (rec.pinned ? ' pinned' : ''));
    const head = mkEl('div', 'mc-head');
    const tag = mkEl('span', 'turnin-kind'); tag.textContent = MEM_KIND[rec.kind] || 'NOTE'; head.appendChild(tag);
    if (rec.kind === 'note' && rec.title) { const t = mkEl('span', 'mc-rectitle'); t.textContent = rec.title; head.appendChild(t); }
    if (rec.scope === 'stream' && rec.streamId) {   // M-mem.2b: working memory scoped to a workstream
      const wsT = (typeof Workstreams !== 'undefined' && Workstreams.get) ? ((Workstreams.get(rec.streamId) || {}).title || null) : null;
      const sc = mkEl('span', 'mc-scope'); sc.textContent = '⊂ ' + (wsT || 'workstream'); sc.title = 'working memory — scoped to this workstream (still cross-stream searchable)'; head.appendChild(sc);
    }
    if (rec.pinned) { const p = mkEl('span', 'mc-pinflag'); p.textContent = '★ pinned'; head.appendChild(p); }
    card.appendChild(head);

    const bodyEl = mkEl('div', 'mc-body'); bodyEl.textContent = rec.body || '(empty)'; card.appendChild(bodyEl);

    const meta = mkEl('div', 'mc-meta');
    const prov = mkEl('span', 'mc-prov');
    const when = rec.createdAt ? new Date(rec.createdAt).toLocaleDateString() : '—';
    prov.textContent = '◉ learned ' + when + (rec.sourceRunId ? ' · run ' + String(rec.sourceRunId).slice(0, 8) : '');
    prov.title = rec.sourceRunId ? ('earned in run ' + rec.sourceRunId) : 'origin run unknown';   // drill-to-the-run (identity)
    meta.appendChild(prov);
    const used = mkEl('span', 'mc-used');
    used.textContent = rec.useCount ? ('used ' + rec.useCount + '×') : 'never recalled';
    meta.appendChild(used);
    const pct = Math.max(0, Math.min(100, Math.round((rec.trust || 0) * 100)));
    const trust = mkEl('span', 'mc-trust', 'trust <span class="mc-trk"><span class="mc-fill" style="width:' + pct + '%;"></span></span>');   // numeric pct only — safe
    meta.appendChild(trust);
    card.appendChild(meta);

    const btns = mkEl('div', 'consent-btns mc-acts'); card.appendChild(btns);
    const reload = () => loadMemoryCore(a);
    let busy = false;   // in-flight guard: a fast double-click must not fire two POSTs (a success reloads the card away)
    const mk = (label, cls, fn) => { const b = mkEl('button', 'consent-btn' + (cls ? ' ' + cls : '')); b.textContent = label; b.onclick = fn; btns.appendChild(b); return b; };
    mk(rec.pinned ? 'Unpin' : 'Pin', '', async () => {
      if (busy) return; busy = true;
      const r = await Harness.memoryPin({ agentId: a.id, id: rec.id, pinned: !rec.pinned });
      if (r && r.ok) { sfx('click'); reload(); } else busy = false;
    });
    mk('Edit', '', () => editMemCard(card, bodyEl, btns, rec, a));
    // forget is destructive → two-step inline confirm (auto-disarms after 3s)
    let armed = false;
    const fbtn = mk('Forget', 'deny', async () => {
      if (!armed) { armed = true; fbtn.textContent = 'Confirm forget'; setTimeout(() => { if (armed) { armed = false; fbtn.textContent = 'Forget'; } }, 4000); return; }
      if (busy) return; busy = true;
      const r = await Harness.memoryForget({ agentId: a.id, id: rec.id });
      if (r && r.ok) { sfx('click'); reload(); } else busy = false;
    });
    return card;
  }

  // inline edit (mirrors the CONFIG file editor + the turn-in beat): swap the body for a textarea + Save/Cancel.
  function editMemCard(card, bodyEl, btns, rec, a) {
    const ta = mkEl('textarea', 'cf-ta mc-edit'); ta.value = rec.body || ''; ta.spellcheck = false;
    card.replaceChild(ta, bodyEl); ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {}
    btns.innerHTML = '';
    const save = mkEl('button', 'consent-btn'); save.textContent = 'Save'; btns.appendChild(save);
    const cancel = mkEl('button', 'consent-btn'); cancel.textContent = 'Cancel'; btns.appendChild(cancel);
    let saving = false;
    save.onclick = async () => { if (saving) return; const v = ta.value.trim(); if (!v) { ta.focus(); return; } saving = true; const r = await Harness.memoryEdit({ agentId: a.id, id: rec.id, content: v }); if (r && r.ok) { sfx('click'); loadMemoryCore(a); } else saving = false; };
    cancel.onclick = () => loadMemoryCore(a);
  }

  // register ONCE: a live memory event (write/used/feedback/forget) refreshes the open Memory Core list,
  // debounced so a burst of memory.used during a run repaints just once. Refreshes only the list (not the
  // whole dossier) and only when the MEMORY tab is actually showing.
  function wireMemoryLive() {
    if (memLiveWired || typeof U === 'undefined' || !U.bus) return;
    memLiveWired = true;
    const bump = () => {
      if (!open['agents'] || agSection() !== 'memory') return;
      clearTimeout(memRefreshTimer);
      memRefreshTimer = setTimeout(() => { const a = present[sel]; if (a) loadMemoryCore(a); }, 400);
    };
    U.bus.on('memory.write', bump); U.bus.on('memory.used', bump);
    U.bus.on('memory.feedback', bump); U.bus.on('memory.forget', bump);
  }

  // A3: register ONCE — a deliverable(kind:'skill') (a background review / curator distilled a skill, OR the
  // agent or user saved one) refreshes the AGENT SKILLS list live, so a new skill appears in the open SKILLS
  // panel WITHOUT reopening it. Debounced (a pass can create several), and only when the standalone SKILLS
  // window is open AND the deliverable is for the agent it's showing. #sk-agent is the standalone panel's host.
  function wireSkillsLive() {
    if (skillsLiveWired || typeof U === 'undefined' || !U.bus) return;
    skillsLiveWired = true;
    U.bus.on('deliverable', p => {
      if (!p || p.kind !== 'skill') return;
      if (!open['skills'] || !$('#sk-agent')) return;                 // the AGENT SKILLS host lives in the standalone SKILLS panel
      const a = present[sel]; const shownId = (a && a.id) || 'agent';
      if ((p.agentId || 'agent') !== shownId) return;                 // only refresh the agent the panel is actually showing
      clearTimeout(skillsRefreshTimer);
      skillsRefreshTimer = setTimeout(() => { if (open['skills'] && $('#sk-agent')) loadAgentSkills(shownId); }, 400);
    });
  }

  function agConfig(a) {
    return '<div class="cf-root">▣ station://agents/' + esc(agSlug(a)) + '/</div>' +
      CONFIG_FILES.map(f => fileCard(a, f)).join('') +
      personaCard(a) +
      modelCard(a) +
      approvalCard(a) +
      workshopCard(a) +
      agCommand(a);   // SKIN swap + DANGER delete — lives at the END of CONFIG, off the BRIEF landing tab
  }

  // W3 per-agent AWAY-WORKSHOP surface (rebuilt 2026-07-15 UX audit — the queue was invisible, the cadence
  // unstated, and a broken shift indistinguishable from a waiting one). One card now answers the four questions
  // a Commander actually has: is it on · what's on the build list (with each item's real state) · when does it
  // build next (+ build now) · did the last shift work. Everything renders from /api/workshop/backlog server
  // truth (wireConfig fills #ag-ws-live async); the static shell asserts nothing it can't prove.
  function workshopCard(a) {
    const on = !!(a && a.workshop);
    return '<div class="cf-card">' +
      '<div class="cf-head"><span class="cf-file">◈ while you’re away</span><span class="cf-badge">PER-AGENT</span></div>' +
      '<label class="set-row" style="align-items:flex-start;gap:8px;">' +
        '<input type="checkbox" id="ag-workshop-on"' + (on ? ' checked' : '') + ' aria-label="Build things while I am away">' +
        '<span><b>Build things while I’m away</b>' +
        '<span class="dim" style="display:block;margin-top:2px;line-height:1.35;">A recurring shift (while the station is running) works through the build list below in this agent’s own sandbox. Each finished build arrives as a <b>new session in your rail</b> — nothing touches your files until you review it there.</span></span>' +
      '</label>' +
      '<div id="ag-workshop-msg" class="msg"></div>' +
      '<div id="ag-ws-live"><div class="dim" style="font-size:11px;">reading the build list…</div></div>' +
      '<div class="dim" style="font-size:11px;margin-top:6px;line-height:1.35;">Separate from this: the AUTONOMY dial’s night-shift beats let the agent pick its <i>own</i> small jobs while you’re away — those deliver to your rail the same way. This card is the list <b>you</b> queue (the ◈ on a quest, or /build-away in COMMS).</div>' +
    '</div>';
  }

  // Per-agent APPROVAL posture (dossier CONFIG card): the same ASK / FULL ACCESS choice as the create screen,
  // changeable any time — until now the ONLY post-create path was the /yolo slash command in COMMS, which most
  // Commanders never find (a creation-time picker with no live-app twin — the codex-sign-in escape class).
  // Applies via access.config.setApproval → pushRoster, so the sidecar's per-run consent gate flips with it.
  function approvalCard(a) {
    const full = !!(a && a.approvalMode === 'full');
    const chip = (id, label, desc, sel) =>
      '<button type="button" class="ov-vchip' + (sel ? ' sel' : '') + '" data-approval="' + id + '" data-name="' + esc(label) + '" title="' + esc(desc) + '" aria-pressed="' + (sel ? 'true' : 'false') + '">' + esc(label) + '</button>';
    return '<div class="cf-card">' +
      '<div class="cf-head"><span class="cf-file">✋ approval</span><span class="cf-badge">PER-AGENT</span></div>' +
      '<div class="cf-desc">Whether this agent stops to check with you before it writes, runs, or reaches out — the same choice you made at its creation. Change it any time (<code>/yolo</code> in COMMS is the shortcut).</div>' +
      '<div class="ov-vchips" id="ag-approval-chips">' +
        chip('ask', 'ASK FOR APPROVAL', 'stops to check with you before it writes, runs, or reaches out', !full) +
        chip('full', 'FULL ACCESS', 'runs everything itself — no approval prompts', full) +
      '</div>' +
      '<div id="ag-approval-msg" class="msg"></div>' +
    '</div>';
  }

  // Per-agent PERSONALITY (dossier CONFIG card): the same archetype chips as the create screen, changeable any
  // time — until now the ONLY post-create path was /personality in COMMS, which most Commanders never find.
  // Chips reuse the genesis .ov-vchip vocabulary; the pick applies via access.config.setPersona (App recomposes
  // the live prompt + pushRoster, so chat, delegated work, and cron all speak the new voice). UNHINGED swears
  // for real, so its chip keeps the house two-press confirm (wired in wireConfig). Personality changes the WORDS
  // only — never the audible station voice, and never the work (the personas.js law).
  function personaCard(a) {
    if (typeof Personas === 'undefined' || !Personas.list) return '';
    const cur = Personas.resolve ? Personas.resolve((a && a.personaId) || Personas.DEFAULT_ID) : ((a && a.personaId) || 'professional');
    const p = Personas.get ? Personas.get(cur) : null;
    const chips = Personas.list().map(x =>
      '<button type="button" class="ov-vchip' + (x.id === cur ? ' sel' : '') + '" data-persona="' + esc(x.id) + '" data-name="' + esc(x.name) + '" title="' + esc(x.vibe || '') + '" aria-pressed="' + (x.id === cur ? 'true' : 'false') + '">' + esc(x.name) + '</button>').join('');
    return '<div class="cf-card">' +
      '<div class="cf-head"><span class="cf-file">◉ personality</span><span class="cf-badge">PER-AGENT</span></div>' +
      '<div class="cf-desc">How this agent talks — in chat, delivered work, and its ambient lines on the floor. Changes the delivery only, never the work (or the station voice). Pick one to apply it immediately.</div>' +
      '<div class="ov-vchips" id="ag-persona-chips">' + chips + '</div>' +
      // sample-reply preview REMOVED (Andrew, 2026-07-20) — the sel chip + vibe tooltip carry the choice.
      '<div id="ag-persona-msg" class="msg"></div>' +
    '</div>';
  }

  // P1-6 per-agent MODEL/PROVIDER pin. Shows what this agent runs on and lets you override it independently of the
  // station default. Writes a.model/a.provider via App.setAgentModel → pushRoster, so the sidecar roster records
  // the pin (honored by runOnce when a run carries no explicit model, and by cron). "Follow station default" clears
  // it. The primary interactive model still lives in the COMMS dock; this is the durable per-agent floor.
  function modelCard(a) {
    const model = (a && a.model) ? String(a.model) : '';
    const prov = (a && a.provider) ? String(a.provider) : '';
    const pinned = !!model;
    // PRIMARY control: the shared ModelPicker (grouped catalog + effort), preselected + populated in wireConfig.
    // FALLBACK (when the component is unavailable): the original free-text model/provider inputs, always present in
    // an <details> as an escape hatch for a model id that isn't in the catalog. SAVE reads the picker first.
    const hasPicker = (typeof ModelPicker !== 'undefined');
    const picker = hasPicker
      ? '<div class="set-row mc-pick-row"><label for="ag-model-pick-model">MODEL</label>' +
          '<div class="mc-pick" id="ag-model-pick">' + ModelPicker.shellHTML({ id: 'ag-model-pick', inheritLabel: 'Follow station default', ariaLabel: 'Agent model', effort: true }) + '</div></div>'
      : '';
    return '<div class="cf-card">' +
      '<div class="cf-head"><span class="cf-file">▣ model</span><span class="cf-badge">PER-AGENT</span></div>' +
      '<div class="cf-desc">What this agent runs on. Pick a model to run this agent on it everywhere — chat, delegated work, scheduled routines — independent of the station default in the COMMS dock. “Follow station default” clears the pin.</div>' +
      picker +
      '<details class="mc-adv"' + ((pinned && !hasPicker) ? ' open' : '') + '><summary>advanced — type a model id</summary>' +
        '<div class="set-row"><label for="ag-model-in">MODEL</label><input id="ag-model-in" class="key-input" type="text" spellcheck="false" autocomplete="off" placeholder="e.g. anthropic/claude-sonnet-4-5" value="' + esc(model) + '"></div>' +
        '<div class="set-row"><label for="ag-prov-in">PROVIDER</label><input id="ag-prov-in" class="key-input" type="text" spellcheck="false" autocomplete="off" placeholder="e.g. openrouter · anthropic · codex" value="' + esc(prov) + '"></div>' +
      '</details>' +
      '<div class="mc-hint">' + (pinned ? 'pinned — this agent ignores the station default' : 'following the station default') + '</div>' +
      '<div class="mc-acts">' +
        '<button class="bb sm" id="ag-model-save">SAVE PIN</button>' +
        (pinned ? '<button class="bb xs" id="ag-model-clear" title="run this agent on the station default model again">FOLLOW STATION DEFAULT</button>' : '') +
      '</div>' +
      '<div id="ag-model-msg" class="msg"></div>' +
    '</div>';
  }

  function wireConfig(body) {
    body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
      agEdit[b.dataset.edit] = true; sfx('click'); rerender('agents');
    }));
    body.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => {
      delete agEdit[b.dataset.cancel]; sfx('click'); rerender('agents');
    }));
    body.querySelectorAll('[data-save]').forEach(b => b.addEventListener('click', () => {
      const key = b.dataset.save, ta = body.querySelector('#cf-ta-' + key);
      const val = ta ? ta.value : '';
      if (access.config && access.config.apply) access.config.apply({ [key]: val });
      delete agEdit[key]; sfx('click');
      const meta = CONFIG_FILES.find(f => f.key === key);
      notify('saved ' + (meta ? meta.file : key) + ' — your agent runs on it now', 'good');
      rerender('agents');
    }));
    // keep focus in the editor across the rerender that opened it (ignore reserved '__' keys like the header rename)
    const openKey = Object.keys(agEdit).find(k => agEdit[k] && k.charAt(0) !== '_');
    if (openKey) { const ta = body.querySelector('#cf-ta-' + openKey); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
    // P1-6 per-agent MODEL pin — save / clear via App.setAgentModel (updates a.model/a.provider/a.reasoningEffort + pushRoster).
    const a = present[sel];
    const mSave = body.querySelector('#ag-model-save');
    const mMsg = body.querySelector('#ag-model-msg');
    const setMMsg = (t, ok) => { if (mMsg) { mMsg.textContent = t || ''; mMsg.className = 'msg' + (ok ? ' ok' : ''); } };
    // fill + preselect the picker from the agent's current pin (async — the catalog is fetched on open)
    const pickWrap = body.querySelector('#ag-model-pick');
    if (pickWrap && typeof ModelPicker !== 'undefined') {
      ModelPicker.populate(pickWrap, { current: { model: (a && a.model) || '', provider: (a && a.provider) || '', effort: (a && a.reasoningEffort) || '' } }).catch(() => {});
      // re-fit the effort <select> to the newly-chosen model on every model change (clamps/clears an effort the
      // new model can't do) — without this the effort could stay 'high' on a non-reasoning model and be persisted.
      ModelPicker.onChange(pickWrap, () => {});
    }
    const applyModel = (model, provider, effort) => {
      if (!(access.config && access.config.setModel)) { setMMsg('per-agent model unavailable'); return; }
      const ok = access.config.setModel(a && a.id, model, provider, effort);
      if (ok === false) { setMMsg('could not update this agent'); sfx('bad'); return; }
      sfx('click'); rerender('agents');
    };
    if (mSave) mSave.addEventListener('click', () => {
      // picker is primary; the advanced free-text is the escape hatch for a model id not in the catalog.
      const pick = (pickWrap && typeof ModelPicker !== 'undefined') ? ModelPicker.read(pickWrap) : { model: '', provider: '', effort: '' };
      const advModel = ((body.querySelector('#ag-model-in') || {}).value || '').trim();
      const advProv = ((body.querySelector('#ag-prov-in') || {}).value || '').trim();
      const model = pick.model || advModel;
      const provider = pick.model ? pick.provider : (advModel ? advProv : '');
      // effort belongs to the PICKED model only — never let an effort left in the select leak onto a typed
      // advanced model (or onto a cleared pin). onChange above already keeps pick.effort valid for pick.model.
      applyModel(model, provider, pick.model ? (pick.effort || '') : '');
    });
    const mClear = body.querySelector('#ag-model-clear');
    if (mClear) mClear.addEventListener('click', () => applyModel('', '', ''));
    // PERSONALITY chips — apply via access.config.setPersona, then rerender so the sel chip + preview line
    // reflect the recorded truth (never an optimistic highlight). UNHINGED keeps the house two-press confirm:
    // press one names what it means (warn tint), press two applies; pressing anything else disarms.
    const pWrap = body.querySelector('#ag-persona-chips');
    if (pWrap) {
      const pMsg = body.querySelector('#ag-persona-msg');
      const setPMsg = (t, ok) => { if (pMsg) { pMsg.textContent = t || ''; pMsg.className = 'msg' + (ok ? ' ok' : ''); } };
      let armed = null;
      const disarm = () => { if (armed) { armed.textContent = armed.dataset.name; armed.classList.remove('arm'); armed = null; } };
      const curId = (typeof Personas !== 'undefined' && Personas.resolve) ? Personas.resolve((a && a.personaId) || Personas.DEFAULT_ID) : '';
      pWrap.querySelectorAll('.ov-vchip').forEach(chip => chip.addEventListener('click', () => {
        const id = chip.dataset.persona;
        if (!id || id === curId) { disarm(); return; }
        if (id === 'unhinged' && armed !== chip) {
          disarm(); armed = chip;
          chip.classList.add('arm');
          chip.textContent = 'UNHINGED — SURE? it swears, for real';
          sfx('click');
          return;
        }
        disarm();
        if (!(access.config && access.config.setPersona)) { setPMsg('personality change unavailable', false); sfx('bad'); return; }
        const ok = access.config.setPersona(a && a.id, id);
        if (ok === false) { setPMsg('could not change personality', false); sfx('bad'); return; }
        notify('personality → ' + (chip.dataset.name || id).toUpperCase() + (id === 'unhinged' ? ' — it swears, for real' : ''), 'good');
        sfx('click'); rerender('agents');
      }));
    }
    // APPROVAL chips — apply via access.config.setApproval, then rerender so the sel chip reflects recorded
    // truth. FULL ACCESS is the dangerous pick, so it keeps the house two-press confirm (the personality
    // UNHINGED pattern): press one names what it means (warn tint), press two applies; anything else disarms.
    const apWrap = body.querySelector('#ag-approval-chips');
    if (apWrap) {
      const apMsg = body.querySelector('#ag-approval-msg');
      const setApMsg = (t, ok) => { if (apMsg) { apMsg.textContent = t || ''; apMsg.className = 'msg' + (ok ? ' ok' : ''); } };
      let apArmed = null;
      const apDisarm = () => { if (apArmed) { apArmed.textContent = apArmed.dataset.name; apArmed.classList.remove('arm'); apArmed = null; } };
      const curMode = (a && a.approvalMode === 'full') ? 'full' : 'ask';
      apWrap.querySelectorAll('.ov-vchip').forEach(chip => chip.addEventListener('click', () => {
        const id = chip.dataset.approval;
        if (!id || id === curMode) { apDisarm(); return; }
        if (id === 'full' && apArmed !== chip) {
          apDisarm(); apArmed = chip;
          chip.classList.add('arm');
          chip.textContent = 'FULL ACCESS — SURE? no approval prompts';
          sfx('click');
          return;
        }
        apDisarm();
        if (!(access.config && access.config.setApproval)) { setApMsg('approval change unavailable', false); sfx('bad'); return; }
        const ok = access.config.setApproval(a && a.id, id);
        if (ok === false) { setApMsg('could not change approval', false); sfx('bad'); return; }
        notify(id === 'full' ? '⚡ ' + ((a && a.name) || 'agent') + ' now runs with FULL ACCESS — no approval prompts' : '✋ ' + ((a && a.name) || 'agent') + ' will ask before risky moves again', id === 'full' ? 'warn' : 'good');
        sfx('click'); rerender('agents');
      }));
    }
    // W3 AWAY-WORKSHOP toggle: flip a.workshop via App.setWorkshop (updates the flag + pushRoster + persist).
    // Optimistic UI: on failure we revert the checkbox and say so — never assert a grant the harness didn't record.
    const wOn = body.querySelector('#ag-workshop-on');
    const wMsg = body.querySelector('#ag-workshop-msg');
    const setWMsg = (t, ok) => { if (wMsg) { wMsg.textContent = t || ''; wMsg.className = 'msg' + (ok ? ' ok' : ''); } };
    if (wOn) wOn.addEventListener('change', () => {
      const next = !!wOn.checked;
      if (!(access.config && access.config.setWorkshop)) { setWMsg('away workshop unavailable', false); wOn.checked = !next; return; }
      // OPTIMISTIC then TRUTHFUL: show the intent immediately, but the switch only stays flipped if the sidecar
      // actually recorded the grant (POST /api/workshop/grant). setWorkshop resolves to that real result; on
      // failure we revert the checkbox + say so, so the UI never asserts a grant the harness didn't record.
      wOn.disabled = true;
      sfx('click');
      setWMsg(next ? 'saving…' : 'saving…', true);
      Promise.resolve(access.config.setWorkshop(a && a.id, next)).then(ok => {
        wOn.disabled = false;
        if (!ok) { setWMsg('could not save that — the station didn’t record it', false); sfx('bad'); wOn.checked = !next; return; }
        setWMsg(next ? 'on — this agent can build in its sandbox while you’re away' : 'off — this agent stays idle while you’re away', true);
        loadWsLive();   // grant flips arm/disarm the shift → the next-shift line changes
      });
    });

    /* ---- the LIVE half of the while-you're-away card (2026-07-15 UX audit): build list + cadence + health.
       Renders ONLY /api/workshop/backlog truth. States: queued (removable) · building · built → review (opens
       the delivery session) · parked (2 failed builds — retry re-queues, which un-parks server-side). The
       next-shift line carries a real countdown + a "build now" that force-fires POST /api/workshop/shift and
       reports the shift's actual result reason. Fail-open: a fetch error renders an honest can't-read line. */
    const wsLive = body.querySelector('#ag-ws-live');
    const aid = (a && a.id) || 'agent';
    const rel = (ms) => {
      if (!ms || ms <= 0) return 'now';
      const m = Math.round(ms / 60000);
      if (m < 60) return '~' + Math.max(1, m) + 'm';
      const h = Math.floor(m / 60);
      return '~' + h + 'h ' + (m % 60) + 'm';
    };
    const ago = (t) => { const d = Date.now() - t; return d < 90000 ? 'just now' : rel(d).replace('~', '') + ' ago'; };
    const lastShiftLine = (ls) => {
      if (!ls || !ls.at) return '';
      const when = ago(ls.at);
      const r = String(ls.reason || '');
      if (r === 'built') return '✓ last shift (' + when + '): built “' + esc(ls.title || 'a deliverable') + '” — it’s waiting in your rail';
      if (r === 'empty-backlog') return '· last shift (' + when + '): nothing queued, so it rested';
      if (r === 'no-capability') return '⚠ last shift (' + when + '): couldn’t run — no model/key available for unattended builds. Fix the provider key in SETTINGS.';
      if (r === 'run-failed' || r === 'no-manifest') return '⚠ last shift (' + when + '): tried “' + esc(ls.title || '') + '” but produced nothing reviewable' + (ls.parkedTitle ? ' — it’s now PARKED after repeated failures (retry below to try again)' : ' — it will retry next shift');
      if (r === 'not-granted') return '· last shift (' + when + '): skipped — the grant was off';
      return '· last shift (' + when + '): ' + esc(r);
    };
    function loadWsLive() {
      if (!wsLive) return;
      Harness.api.get('/api/workshop/backlog?agent=' + encodeURIComponent(aid))
        .then(j => { if (j && j.ok) renderWsLive(j); else if (wsLive) wsLive.innerHTML = '<div class="dim" style="font-size:11px;">couldn’t read the build list — the station may be unreachable</div>'; })
        .catch(() => { if (wsLive) wsLive.innerHTML = '<div class="dim" style="font-size:11px;">couldn’t read the build list — the station may be unreachable</div>'; });
    }
    function renderWsLive(j) {
      const items = Array.isArray(j.items) ? j.items : [];
      const STATE = { queued: 'queued', building: 'building…', built: 'built — review it', parked: 'parked (failed twice)' };
      let h = '<div class="ws-bl-head">build list' + (items.length ? ' · ' + items.length : '') + '</div>';
      if (!items.length) h += '<div class="dim" style="font-size:12px;">nothing queued — use ◈ on a quest, or type /build-away in COMMS.</div>';
      h += items.map(it =>
        '<div class="ws-bl-row" data-blid="' + esc(it.id) + '">' +
          '<span class="ws-bl-title">' + esc(it.title || '(untitled)') + '</span>' +
          '<span class="ws-bl-state ' + esc(it.state) + '">' + (STATE[it.state] || esc(it.state)) + '</span>' +
          (it.state === 'built' ? '<button class="ws-bl-review" data-run="' + esc(it.builtRunId || '') + '">review</button>' : '') +
          (it.state === 'parked' ? '<button class="ws-bl-retry" data-title="' + esc(it.title || '') + '">retry</button>' : '') +
          (it.state === 'queued' || it.state === 'parked' ? '<button class="ws-bl-remove" title="take this off the list (it can be queued again later)">✕</button>' : '') +
        '</div>').join('');
      // cadence + build-now + honest last-shift outcome
      // nextRunAt arrives as an ISO string from the cron store — parse, never subtract a string (NaN → "in now")
      const nextAt = j.nextShiftAt ? (Date.parse(j.nextShiftAt) || Number(j.nextShiftAt) || 0) : 0;
      const due = nextAt ? (nextAt - Date.now()) : 0;
      const next = (j.granted && nextAt)
        ? (due <= 60000 ? 'next shift: due now' : 'next shift in ' + rel(due))
        : (j.granted ? 'shift not scheduled yet' : 'shifts are off (grant above)');
      h += '<div class="ws-bl-foot">' +
        '<span class="dim" style="font-size:11px;">' + esc(next) + (j.shiftEvery ? ' · repeats ' + esc(String(j.shiftEvery).replace(/^every /, 'every ')) : '') + '</span>' +
        (j.granted && items.some(it => it.state === 'queued') ? '<button id="ag-ws-now">⚒ build now</button>' : '') +
        '</div>';
      const ls = lastShiftLine(j.lastShift);
      if (ls) h += '<div class="ws-bl-last' + (/^⚠/.test(ls) ? ' warn' : '') + '">' + ls + '</div>';
      wsLive.innerHTML = h;
      // row actions — each posts, then re-renders from server truth (never an optimistic lie)
      wsLive.querySelectorAll('.ws-bl-remove').forEach(b => b.addEventListener('click', () => {
        const id = b.closest('.ws-bl-row').getAttribute('data-blid');
        b.disabled = true;
        Harness.api.post('/api/workshop/remove', { agentId: aid, backlogId: id })
          .then(({ j: res }) => { if (!(res && res.ok)) notify((res && res.error) || 'could not remove that', 'bad'); loadWsLive(); })
          .catch(() => { notify('could not reach the station', 'bad'); loadWsLive(); });
      }));
      wsLive.querySelectorAll('.ws-bl-retry').forEach(b => b.addEventListener('click', () => {
        const id = b.closest('.ws-bl-row').getAttribute('data-blid');
        b.disabled = true;   // re-queueing the SAME id un-parks it server-side (clears the failed-attempt count)
        Harness.api.post('/api/workshop/queue', { agentId: aid, id: id, title: b.getAttribute('data-title') || '' })
          .then(() => loadWsLive())
          .catch(() => { notify('could not reach the station', 'bad'); loadWsLive(); });
      }));
      wsLive.querySelectorAll('.ws-bl-review').forEach(b => b.addEventListener('click', () => {
        const run = b.getAttribute('data-run');
        if (run && access.comms && access.comms.openWorkstream) { sfx('click'); access.comms.openWorkstream('workshop-' + run); }
        else notify('open the ⚒ session in your rail to review it', 'gold');
      }));
      const nowBtn = wsLive.querySelector('#ag-ws-now');
      if (nowBtn) nowBtn.addEventListener('click', () => {
        nowBtn.disabled = true; nowBtn.textContent = 'building…';
        Harness.api.post('/api/workshop/shift', { agentId: aid })
          .then(({ j: res }) => {
            const p = (res && res.payload) || res || {};
            if (p.reason === 'built') notify('⚒ built — it’s waiting as a new session in your rail', 'gold');
            else if (p.reason === 'no-capability') notify('couldn’t build — no model/key available for unattended runs', 'bad');
            else if (p.reason === 'empty-backlog') notify('nothing queued to build', 'warn');
            else if (p.fired) notify('the shift ran but produced nothing reviewable — it will retry', 'warn');
            else notify('the shift didn’t run (' + (p.reason || 'unknown') + ')', 'warn');
            loadWsLive();
          })
          .catch(() => { notify('could not reach the station', 'bad'); loadWsLive(); });
      });
    }
    loadWsLive();
  }

  // header wiring (present on EVERY tab, so it lives here rather than in a per-tab wire): the rename affordance
  // and the "model tag → CONFIG" shortcut. access.config.setName renames; a missing setName degrades to a notice.
  function wireHead(body) {
    const a = present[sel];
    const goCfg = body.querySelector('.ag-tags .tag.model[data-goconfig]');
    if (goCfg) {
      // console mode: "jump to CONFIG" = land the rail on the config section, then rerender (mountConsole reads consoleSection).
      const jump = () => { consoleSection['agents'] = 'config'; sfx('click'); rerender('agents'); };
      goCfg.addEventListener('click', jump);
      goCfg.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); jump(); } });
    }
    const rn = body.querySelector('#ag-rename-btn');
    if (rn) rn.addEventListener('click', () => { agEdit['__name'] = true; sfx('click'); rerender('agents'); });
    const commit = () => {
      const val = ((body.querySelector('#ag-rename-in') || {}).value || '').trim();
      if (!val) { sfx('bad'); return; }
      delete agEdit['__name'];
      if (!(access.config && access.config.setName)) { notify('rename unavailable', 'bad'); rerender('agents'); return; }
      const ok = access.config.setName(a && a.id, val);
      if (ok === false) { notify('could not rename', 'bad'); sfx('bad'); rerender('agents'); return; }
      notify('renamed to ' + val.replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 18), 'good');
      sfx('click'); rerender('agents');
    };
    const rin = body.querySelector('#ag-rename-in');
    if (rin) {
      rin.focus(); try { rin.setSelectionRange(rin.value.length, rin.value.length); } catch (_) {}
      rin.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        // stopPropagation so Esc-to-cancel-rename doesn't ALSO bubble to the window handler and close the dossier.
        else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); delete agEdit['__name']; rerender('agents'); }
      });
    }
    const rsave = body.querySelector('#ag-rename-save');
    if (rsave) rsave.addEventListener('click', commit);
    const rcancel = body.querySelector('#ag-rename-cancel');
    if (rcancel) rcancel.addEventListener('click', () => { delete agEdit['__name']; sfx('click'); rerender('agents'); });
    wireCommand(body, a);
  }

  // wire the COMMANDER CONTROLS block (agCommand): SKIN thumbs → access.config.setSkin (live sprite swap), and
  // DELETE AGENT → an armed 2-click confirm (ArmConfirm) → access.config.deleteAgent. A disabled DELETE (hero /
  // last agent) is left inert. Guarded so a section without the block (or a missing access hook) is a safe no-op.
  function wireCommand(body, a) {
    if (!a) return;
    body.querySelectorAll('.ag-skin-thumb').forEach(btn => {
      btn.addEventListener('click', () => {
        const skin = btn.dataset.skin;
        if (!skin || skin === a.skin) return;
        if (!(access.config && access.config.setSkin)) { notify('skin change unavailable', 'bad'); return; }
        const ok = access.config.setSkin(a.id, skin);
        if (ok === false) { notify('could not change skin', 'bad'); sfx('bad'); return; }
        const nm = ((typeof DATA !== 'undefined' && DATA.SKINS && DATA.SKINS[skin] && DATA.SKINS[skin].name) || skin);
        notify('skin → ' + String(nm).toUpperCase(), 'good');
        sfx('click'); rerender('agents');
      });
    });
    const del = body.querySelector('#ag-del-btn');
    if (del && !del.disabled && typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) {
      ArmConfirm.wire(del, {
        armedLabel: '✕ DELETE — sure?',
        timeoutMs: 4000,
        onConfirm: () => {
          if (!(access.config && access.config.deleteAgent)) { notify('delete unavailable', 'bad'); return; }
          const nm = a.name || a.id;
          Promise.resolve(access.config.deleteAgent(a.id)).then(ok => {
            if (ok === false) { notify('could not delete ' + String(nm).toUpperCase(), 'bad'); sfx('bad'); rerender('agents'); return; }
            notify(String(nm).toUpperCase() + ' deleted — its work is archived', 'warn');
            sfx('bad');
            sel = 0;   // the deleted row is gone; land on the first surviving agent
            rerender('agents');
          });
        }
      });
    }
  }

  function buildAgents(body) {
    if (!present.length) {
      // shared empty-state vocabulary rather than a bare paragraph (no agents = nothing to dossier)
      body.innerHTML = '<div class="empty-state" style="margin:32px auto;"><span class="es-glyph">▯</span>' +
        '<b>NO AGENTS ON STATION</b><span>Commission one from RECRUITMENT to open its dossier.</span></div>';
      return;
    }
    if (sel >= present.length) sel = 0;
    const a = present[sel];
    const act = activity();
    // CONSOLE MODE: the roster is the rail-top; the five former sub-tabs are console sections. Every section
    // pane is built up-front (mountConsole keeps them all in the DOM), so the single wire pass below reaches
    // every control — wireHead (header, all sections), wireConfig (CONFIG pane), loadMemoryCore (MEMORY pane).
    const frag = html => (elx => { elx.innerHTML = html; });
    const host = mountConsole(body, 'agents', [
      { id: 'brief', label: 'BRIEF', glyph: '▤', desc: 'Who this agent is right now — identity, level, purpose, and live status.',
        build: frag(agHead(a, act) + agBrief(a)) },
      { id: 'growth', label: 'GROWTH', glyph: '★', desc: 'XP ladder, satisfaction gauge, trophy case, and station prestige.',
        build: frag(agGrowth(a)) },
      { id: 'memory', label: 'MEMORY', glyph: '◈', desc: 'Every belief this agent has kept, traced to the run that earned it.',
        build: frag(agMemory(a)) },
      { id: 'skills', label: 'SKILLS', glyph: '◇', desc: 'The capabilities granted by the objects at this agent’s workstation.',
        build: frag(agSkills(a && a.id)) },
      { id: 'config', label: 'CONFIG', glyph: '▣', desc: 'The markdown files that compose this agent’s prompt, plus its per-agent model pin.',
        build: frag(agConfig(a)) }
    ], {
      // tabsTop: the five section tabs (BRIEF/GROWTH/MEMORY/SKILLS/CONFIG) render as a horizontal strip at the
      // top of the right pane; the left rail becomes the agent roster full-height (railTop below).
      tabsTop: true,
      search: true, searchPlaceholder: 'search dossier…',
      railTop: (top) => {
        // ROSTER: keep the exact .ag-list / .ag-item class names; upgrade the rows premium (color dot, name,
        // and a cheap live status hint driven by the same run state the crew panel reads).
        const hint = (x) => agentLive(x.id)
          ? '<span class="ag-item-st working">' + (act === 'talk' ? 'talking' : 'working') + '</span>'
          : '<span class="ag-item-st">idle</span>';
        top.innerHTML =
          '<div class="ag-list" role="listbox" aria-label="Agents on station">' +
          present.map((x, i) => '<div class="ag-item ' + (i === sel ? 'sel' : '') + '" data-i="' + i + '" role="option" aria-selected="' + (i === sel ? 'true' : 'false') + '" tabindex="0" style="--ci:' + i + '">' +
            '<span class="ag-item-dot" style="color:' + x.color + '">●</span>' +
            '<span class="ag-item-nm">' + esc(x.name) + '</span>' + hint(x) + '</div>').join('') +
          '</div>';
        const pick = (it) => { sel = +it.dataset.i; delete agEdit['__name']; sfx('click'); rerender('agents'); };
        top.querySelectorAll('.ag-item').forEach(it => {
          it.addEventListener('click', () => pick(it));
          it.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(it); } });
        });
      }
    });
    // ONE wire pass against the all-panes host (mirrors buildSettings/buildSkills). The BRIEF-only tick and the
    // memory live-refresh never wipe CONFIG/MEMORY DOM, so open editors survive.
    wireHead(host);
    wireConfig(host);
    wireMemoryLive();
    loadMemoryCore(a);
    drawPortrait(host.querySelector('#ag-portrait'), a);
  }
  function drawPortrait(cv, a) {
    if (!cv) return;
    const pctx = cv.getContext('2d');
    pctx.clearRect(0, 0, cv.width, cv.height);
    if (!(typeof SPRITES === 'object' && SPRITES.ready)) {
      // procedural fallback (sprites not yet loaded) — a simple body+head sized to the larger frame.
      pctx.imageSmoothingEnabled = false;
      pctx.fillStyle = a.color; pctx.fillRect(cv.width / 2 - 9, cv.height - 64, 18, 44);
      pctx.fillStyle = '#f0e6c0'; pctx.fillRect(cv.width / 2 - 7, cv.height - 80, 14, 16);
      return;
    }
    // drawBody sizes sprites for the FLOOR: each skin at its own small footprint scale (ULTRON ~0.6, most
    // skins ~0.37) on a 92px master that's mostly transparent — reused as-is the body lands tiny and adrift
    // in the frame, and DIFFERENTLY sized per skin. For the portrait we want every agent to FILL the frame
    // the same, independent of how small it walks on the floor. So: render the body once to an offscreen
    // buffer (real skin, noShadow), crop to its actual non-transparent bounds, then blit it in scaled to
    // fill — preserving aspect and foot-anchoring to the bottom. (3× master in the buffer keeps detail.)
    const buf = drawPortrait._buf || (drawPortrait._buf = document.createElement('canvas'));
    const BW = 200, BH = 200; buf.width = BW; buf.height = BH;
    const bctx = buf.getContext('2d');
    bctx.clearRect(0, 0, BW, BH);
    bctx.save();
    bctx.translate(BW / 2, BH - 14);
    bctx.scale(3, 3);
    SPRITES.drawBody(bctx, { id: a.id, skin: a.skin, px: 0, py: 0, dir: 'south', color: a.color, state: 'idle', sitting: false, working: false, phase: 0, noShadow: true }, performance.now());
    bctx.restore();
    // measure the drawn body's real bounds (alpha > 16), so the fit ignores the master's transparent padding
    const d = bctx.getImageData(0, 0, BW, BH).data;
    let minX = BW, minY = BH, maxX = 0, maxY = 0, any = false;
    for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
      if (d[(y * BW + x) * 4 + 3] > 16) { any = true; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (!any) return;
    const sw = maxX - minX + 1, sh = maxY - minY + 1;
    // fit into the frame with a small margin, aspect preserved, feet to the bottom
    const padX = 8, padTop = 8, padBot = 6;
    const k = Math.min((cv.width - padX * 2) / sw, (cv.height - padTop - padBot) / sh);
    const dw = sw * k, dh = sh * k;
    pctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in pctx) pctx.imageSmoothingQuality = 'high';
    pctx.drawImage(buf, minX, minY, sw, sh, (cv.width - dw) / 2, cv.height - padBot - dh, dw, dh);
  }
  // BRIEF live telemetry, painted in place (no DOM rebuild → open CONFIG/MEMORY editors are never wiped).
  // Touches only: the hero status dot + role line (agHead), and the roster idle/working hints (railTop). Every
  // lookup is scoped to the open dossier window and no-ops if the node isn't there (e.g. mid-rename, retab).
  function refreshDossierLive() {
    const w = open.agents; if (!w) return;
    const act = activity();
    const dn = linkDown();   // E2: keep the live-painted status honest — link gone → OFFLINE, not ONLINE
    const dotCls = dn ? 'down' : act === 'task' ? 'working' : act === 'talk' ? 'thinking' : 'on';
    const statusText = dn ? 'OFFLINE' : act === 'task' ? 'WORKING' : act === 'talk' ? 'THINKING' : 'ONLINE';
    // hero: the status dot (class) + the role line's status word
    const dot = w.querySelector('.ag-role-line .ag-sdot');
    if (dot) dot.className = 'ag-sdot ' + dotCls;
    const line = w.querySelector('.ag-role-line');
    if (line) {
      // rebuild the line's TEXT after the dot span without touching the dot node itself
      let node = dot ? dot.nextSibling : null;
      const txt = statusText;
      if (node && node.nodeType === 3) node.textContent = txt;
      else if (line && dot) dot.insertAdjacentText('afterend', txt);
    }
    // roster: recompute each row's idle/working hint from the live run state
    w.querySelectorAll('.ag-list .ag-item').forEach(it => {
      const x = present[+it.dataset.i]; if (!x) return;
      const st = it.querySelector('.ag-item-st'); if (!st) return;
      const live = agentLive(x.id);
      st.textContent = live ? (act === 'talk' ? 'talking' : 'working') : 'idle';
      st.classList.toggle('working', live);
    });
  }
  function openAgent(i) { sel = i; if (open.agents) { if (minimized.agents) restoreTerm('agents'); rerender('agents'); } else toggleTerm('agents', 'AGENT DOSSIER', buildAgents, { console: true, feature: true }); }

  /* ============== SKILLS — capability readout (mirrors the sidecar CAP_REGISTRY) ==============
     The agent's real tools come from the OBJECTS at its workstation (object = capability — see
     sidecar/capability/registry.js). This is an honest readout of that grant set: the real tool
     ids, and which actions pause for a one-click approval in COMMS (the P1.5 consent broker —
     writes to the user's files ask the Commander before they run; the private notebook does not).
     Kept in sync with the registry by hand; TERMINAL (shell.exec) is the registry's own "M5 next". */
  // each skill maps to the capability OBJECT that grants it (object = capability — the moat).
  // cap:null = COMPUTE, the always-on freebie; everything else needs its prop placed on the agent's floor.
  const SKILLS = [
    { icon: '▣', name: 'COMPUTE',     tools: 'model.chat',               cap: null },
    { icon: '⌕', name: 'WEB SEARCH',  tools: 'web_search',               cap: 'dish' },
    { icon: '⇩', name: 'WEB FETCH',   tools: 'web_fetch',                cap: 'dish' },
    { icon: '▤', name: 'READ FILES',  tools: 'fs.read · fs.list',        cap: 'cabinet' },
    { icon: '✎', name: 'WRITE FILES', tools: 'fs.write · append · edit', cap: 'cabinet', consent: true },
    { icon: '◉', name: 'MEMORY',      tools: 'notebook.read · write',    cap: 'notebook' },
    { icon: '⌗', name: 'TERMINAL',    tools: 'shell.exec · verify.run',  cap: 'workbench', consent: true }
  ];
  // TRUTHFUL readout (QA-4): derive each skill's grant from the agent's REAL placed objects via World.heroCaps
  // — the same source the run path resolves caps from. No placed prop = LOCKED on screen, matching the wire.
  function skillsFor(agentId) {
    let caps = [];
    try { caps = (typeof World !== 'undefined' && World.heroCaps) ? World.heroCaps(agentId).map(c => c.objectType) : []; } catch (e) {}
    return SKILLS.map(s => ({ ...s, on: s.cap === null || caps.indexOf(s.cap) !== -1 }));
  }
  function buildSkills(body) {
    const a = present[sel];
    const agentId = (a && a.id) || 'agent';
    const skills = skillsFor(agentId);
    const on = skills.filter(s => s.on).length;
    // CONSOLE MODE: CAPABILITIES · SKILL LIBRARY · AGENT SKILLS as three sections instead of one long scroll.
    // The library categories stay as sub-headers inside the LIBRARY section (renderSkillLibrary emits them);
    // its async loaders target #sk-lib / #sk-agent which live inside the panes below.
    // locked copy is OBJECT-TRUTHFUL: not a disabled toggle, but "no DISH at the desk" — it points at the furniture.
    const capLockedText = (s) => '○ NO ' + (SK_OBJ_NAME[s.cap] || String(s.cap || '').toUpperCase()) + ' AT DESK';
    // a LOCKED-for-missing-gear card (a real cap whose prop isn't on the floor) becomes a one-click deep-link into
    // REFIT to place that prop — the honest fix, never a fake auto-grant. COMPUTE (cap:null) is always on and never
    // locked. data-perk-cap carries the capability objectType so the wiring below routes it to placeGearForSkill.
    const secCaps =
      '<div class="sk-chain">OBJECT AT DESK <span class="sk-chain-arr">→</span> CAPABILITY <span class="sk-chain-arr">→</span> SKILL</div>' +
      '<div class="perk-grid">' +
      skills.map((s, i) => {
        const lockable = !s.on && s.cap;
        return '<div class="perk ' + (s.on ? 'on' : '') + (lockable ? ' perk-locked' : '') + '"' +
          (lockable ? ' data-perk-cap="' + esc(s.cap) + '" role="button" tabindex="0" title="Open REFIT to place a ' + esc(SK_OBJ_NAME[s.cap] || String(s.cap).toUpperCase()) + '"' : '') +
          ' style="--ci:' + i + '">' +
          '<div class="perk-icon">' + s.icon + '</div>' +
          '<div class="perk-name">' + s.name + '</div>' +
          '<div class="perk-desc">' + s.tools + '</div>' +
          '<div class="perk-stat' + (s.consent ? ' ask' : '') + '">' +
          (s.on ? (s.consent ? '● ASKS OK' : '● ENABLED') : capLockedText(s)) + '</div>' +
          (lockable ? '<div class="perk-place">▸ PLACE IN REFIT</div>' : '') + '</div>';
      }).join('') +
      '</div>' +
      '<p class="sk-note">Capabilities follow the <b>objects at the workstation</b> — the room layout IS the ' +
      'permission system. <b>File writes</b> and <b>commands</b> pause for one-click approval in COMMS; the private ' +
      '<b>notebook</b> saves freely.</p>' +
      // Audit finding 1: this readout and TOOLSETS are the SAME tool families under two names, and this panel
      // never said where the switches live. One honest pointer closes the loop.
      '<p class="sk-note">This view is <b>read-only</b> — the on/off switches for these same tool families live in ' +
      'the <b>⇄ TOOLSETS</b> panel on the bottom bar.</p>';
    const secLibrary =
      // "recipes" here collided with the ❒ RECIPES dock feature (audit finding 2) — these are PROCEDURES: how-to
      // guides an agent follows mid-task, not launchable jobs.
      '<p class="sk-note sk-lib-intro">Pre-installed <b>procedures</b> your agents follow when a task matches ' +
      '(not the same as ❒ RECIPES — those are launchable jobs; these are how-to guides). Each one ' +
      'rides on the capabilities above — it stays <b>locked</b> until ' + esc((a && a.name) || 'the agent') + ' has the ' +
      'objects it needs. Enabling is station-wide; what actually runs is still gated by the floor.</p>' +
      '<div id="sk-lib" class="sk-lib"><div class="sk-loading"><span class="loading pulse">loading the skill library…</span></div></div>';
    const secAgent =
      '<p class="sk-note sk-lib-intro">Reusable procedures this agent created or learned. These appear as a compact index in future runs; the agent loads the full body only when a task matches.</p>' +
      '<div id="sk-agent" class="sk-lib"><div class="sk-loading">loading agent skills…</div></div>';
    const frag = html => (el => { el.innerHTML = html; });
    mountConsole(body, 'skills', [
      { id: 'caps', label: 'CAPABILITIES', glyph: '◈', desc: on + ' of ' + skills.length + ' live — what this agent can actually do, driven by the objects at its workstation.', build: frag(secCaps) },
      { id: 'library', label: 'SKILL LIBRARY', glyph: '▤', desc: 'Pre-installed procedures your agents follow when a task matches, grouped by kind.', build: frag(secLibrary) },
      { id: 'agent', label: 'AGENT SKILLS', glyph: '✎', desc: 'Procedures this agent created or learned itself.', build: frag(secAgent) }
    ], { search: true, searchPlaceholder: 'search skills…' });
    loadSkillLibrary(agentId);
    loadAgentSkills(agentId);
    wireSkillsLive();   // A3: keep the AGENT SKILLS list live while the panel is open (registers once)
    // LOCKED capability card → the real REFIT placement surface (same deep-link the SKILL LIBRARY's PLACE uses).
    // A ts-disabled card (gear IS placed, toolset just off) is not locked-for-gear, so it never gets this wiring.
    const agentName = (a && a.name) || agentId;
    body.querySelectorAll('.perk-locked[data-perk-cap]').forEach(p => {
      const go = () => { sfx('click'); placeGearForSkill(p.dataset.perkCap, agentName); };
      p.addEventListener('click', go);
      p.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
    });
    // TOOLSET honesty: a family switched OFF in the TOOLSETS console must read as OFF here too, so the two
    // surfaces can't tell different stories. Cheap best-effort: fetch the toolset state and dim matching perks
    // (mapped by the granting objectType == SKILLS[].cap). Never blocks the panel; a fetch miss leaves perks as-is.
    Harness.api.get('/api/toolsets').then(j => {
      const disabledObjs = {};
      (j && j.toolsets || []).forEach(t => { if (!t.enabled && t.object) disabledObjs[t.object] = true; });
      const perks = body.querySelectorAll('.perk-grid .perk');
      skills.forEach((s, i) => {
        if (s.cap && disabledObjs[s.cap] && perks[i]) {
          perks[i].classList.remove('on'); perks[i].classList.add('ts-disabled');
          const stat = perks[i].querySelector('.perk-stat'); if (stat) { stat.textContent = '○ OFF — switch it on in ⇄ TOOLSETS'; stat.classList.remove('ask'); }
        }
      });
    }).catch(() => {});
  }

  // async: fetch the bundled recipe catalog (with THIS agent's placed objects, so the active/locked readout is
  // truthful) and render it into #sk-lib. Mirrors loadMemoryCore — re-query the host after the await so a panel
  // that was closed mid-fetch is a safe no-op. The global fetch wrapper (harness.js) attaches the API token.
  function loadSkillLibrary(agentId) {
    const host = $('#sk-lib'); if (!host) return;
    let placed = [];
    try { placed = (typeof World !== 'undefined' && World.heroCaps) ? World.heroCaps(agentId).map(c => c.objectType) : []; } catch (e) {}
    fetch('/api/skills?placed=' + encodeURIComponent(placed.join(',')))
      .then(r => r.ok ? r.json() : { skills: [] })
      .then(d => {
        const h = $('#sk-lib');
        if (h) {
          renderSkillLibrary(h, (d && d.skills) || [], agentId, placed);
          requestAnimationFrame(() => fitTermInViewport(open.skills));
        }
      })
      .catch(() => {
        const h = $('#sk-lib');
        if (h) {
          h.innerHTML = '<div class="sk-loading">Could not load the skill library — is the sidecar running?</div>';
          requestAnimationFrame(() => fitTermInViewport(open.skills));
        }
      });
  }

  const SK_OBJ_NAME = { cabinet: 'CABINET', dish: 'DISH', workbench: 'WORKBENCH', studio: 'STUDIO', notebook: 'NOTEBOOK', jukebox: 'JUKEBOX', computer: 'COMPUTER', orchestrator: 'ORCHESTRATOR', connector: 'CONNECTOR' };
  // Each capability objectType → the representative placeable prop (CAP_PROP_MAP) and the REFIT palette category tab
  // that holds it. Lets a locked skill's "PLACE" button land the user on the exact gear in the real build surface.
  const SK_PLACE = {
    cabinet:  { prop: 'safe',      cat: 'capability' },
    dish:     { prop: 'comms_dish', cat: 'capability' },
    workbench:{ prop: 'workbench', cat: 'workstation' },
    studio:   { prop: 'studio',    cat: 'capability' },
    notebook: { prop: 'core',      cat: 'capability' }
  };
  // Deep-link a locked skill's missing gear into the REAL placement surface: minimize SKILLS, open REFIT, drive its
  // palette to the PROP tool → FUNCTIONAL tier → the missing cap's category tab → its prop tile (so the very next
  // floor-click drops it). Mirrors app.js openDeskPlacement() — the honest path, never a fake auto-place. `objType`
  // is a capability objectType (cabinet/dish/workbench/…); `agentName` is only for the guidance toast.
  function placeGearForSkill(objType, agentName) {
    const spot = SK_PLACE[objType];
    const label = SK_OBJ_NAME[objType] || String(objType).toUpperCase();
    if (typeof Build === 'undefined' || !(Build.open || Build.toggle)) {
      notify('Open ⚒ BUILD and place a ' + label + ' to unlock this skill', 'warn'); return;
    }
    try { if (open.skills) minimizeTerm('skills'); } catch (_) {}
    try {
      if (Build.isOpen && Build.isOpen()) { /* already in REFIT */ }
      else if (Build.open) Build.open();
      else Build.toggle();
    } catch (_) { notify('Could not open REFIT — open ⚒ BUILD and place a ' + label, 'warn'); return; }
    notify('Place a ' + label + ' at ' + (agentName || 'the agent') + '’s desk to unlock this skill', 'good');
    if (!spot) return;   // no known prop mapping — REFIT is open, the toast named the gear; that's the floor of acceptable
    // Drive the palette to the PROP tool → FUNCTIONAL tier → the missing cap's category tab → its prop tile so the
    // very next floor-click drops it. REFIT builds its DOM synchronously in open(), so the FIRST pass runs inline
    // (works even where rAF is throttled); a few rAF retries then cover any deferred re-render. Each pass clicks only
    // what isn't already active, so it's idempotent + cheap.
    let tries = 0;
    const arm = () => {
      const q = sel => document.querySelector(sel);
      const propTool = q('.refit-tool[data-tool="prop"]');
      if (propTool && !propTool.classList.contains('active')) propTool.click();
      const fnTier = q('.refit-tier-functional'), curTier = q('.refit-tier.active');
      if (fnTier && curTier && curTier !== fnTier) fnTier.click();
      const catTab = q('.refit-propcat[data-cat="' + spot.cat + '"]');
      if (catTab && !catTab.classList.contains('active')) catTab.click();
      const tile = q('.refit-proptile[data-prop="' + spot.prop + '"]');
      if (tile && !tile.classList.contains('active')) tile.click();
      const armed = tile && tile.classList.contains('active');
      if (!armed && ++tries < 8) requestAnimationFrame(arm);
    };
    arm();                                   // inline first pass (rAF-independent)
    requestAnimationFrame(arm);              // + defensive retries for any deferred render
  }
  // Bucket the catalog by the TWO-AXIS state the redesign shows: a skill is READY (the user turned it on AND the floor
  // grants the gear), NEEDS GEAR (turned on but a required object is missing), or OFF (turned off, gear irrelevant).
  // Pure + stand-alone so it's unit-testable and the render stays declarative. Preserves the catalog's incoming order
  // within each bucket. Exposed on SkillsUI.groupSkillsByState for the node test.
  function groupSkillsByState(skills) {
    const ready = [], needsGear = [], off = [];
    for (const s of (skills || [])) {
      if (!s.enabled) off.push(s);
      else if (s.available) ready.push(s);
      else needsGear.push(s);
    }
    return { ready: ready, needsGear: needsGear, off: off };
  }

  function renderSkillLibrary(host, skills, agentId, placed) {
    if (!skills.length) { host.innerHTML = '<div class="sk-loading">No skills in the library yet.</div>'; return; }
    const placedSet = {}; (placed || []).forEach(p => placedSet[p] = true);
    const objLabel = (r) => SK_OBJ_NAME[r] || String(r).toUpperCase();
    const active = skills.filter(s => s.enabled && s.available).length;
    const agentName = (present[sel] && present[sel].name) || agentId;
    const groups = groupSkillsByState(skills);
    let html = '<div class="sk-lib-sum">' + skills.length + ' recipe' + (skills.length === 1 ? '' : 's') +
      ' · <b>' + active + '</b> active for ' + esc(agentName) + '</div>';
    // A pill SWITCH (the user's choice) — reads unambiguously as a control, not a status dot. data-toggle drives the round-trip.
    const switchHTML = (s) =>
      '<button class="sk-switch ' + (s.enabled ? 'on' : 'off') + '" role="switch" aria-checked="' + (s.enabled ? 'true' : 'false') + '" ' +
        'aria-label="Turn ' + (s.enabled ? 'off' : 'on') + ' ' + esc(s.name) + '" ' +
        'data-toggle="' + esc(s.slug) + '" data-enabled="' + (s.enabled ? 'true' : 'false') + '" title="' + (s.enabled ? 'Turn OFF' : 'Turn ON') + ' this skill station-wide">' +
        '<span class="sk-sw-track"><span class="sk-sw-knob"></span></span>' +
        '<span class="sk-sw-label">' + (s.enabled ? 'ON' : 'OFF') + '</span>' +
      '</button>';
    // A SEPARATE readiness chip — the floor's grant, never merged with the switch. READY (green) or NEEDS GEAR (amber).
    const readyChip = (s, missing) => s.available
      ? '<span class="sk-ready ok">READY</span>'
      : '<span class="sk-ready gear">NEEDS ' + missing.map(objLabel).join(' + ') + '</span>';
    const reqBadges = (s) => (s.requires || []).length
      ? s.requires.map(r => '<span class="sk-badge ' + (placedSet[r] ? 'have' : 'miss') + '">' + objLabel(r) + '</span>').join('')
      : '<span class="sk-badge free">no gear needed</span>';
    // one PLACE button per missing object → the real REFIT placement surface (placeGearForSkill).
    const placeBtns = (missing) => missing.map(r =>
      '<button class="sk-place" data-place="' + esc(r) + '" title="Open REFIT to place a ' + esc(objLabel(r)) + '">→ PLACE ' + esc(objLabel(r)) + '</button>').join('');
    let ci = 0;
    const card = (s) => {
      const missing = (s.requires || []).filter(r => !placedSet[r]);
      const state = s.enabled ? (s.available ? 'on' : 'want') : 'off';
      return '<div class="sk-card ' + state + '" style="--ci:' + (ci++) + '">' +
          '<div class="sk-card-head">' +
            switchHTML(s) +
            '<div class="sk-card-main">' +
              '<div class="sk-name-row"><span class="sk-name">' + esc(s.name) + '</span>' +
                (s.category ? '<span class="sk-badge cat">' + esc(String(s.category).toUpperCase()) + '</span>' : '') +
                readyChip(s, missing) + '</div>' +
              '<div class="sk-desc">' + esc(s.description) + '</div>' +
              '<div class="sk-reqs">' + reqBadges(s) + '</div>' +
              (missing.length ? '<div class="sk-place-row">' + placeBtns(missing) + '</div>' : '') +
            '</div>' +
            '<button class="sk-expand" data-expand="' + esc(s.slug) + '" title="Read the recipe" aria-label="Read the ' + esc(s.name) + ' recipe">▸</button>' +
          '</div>' +
          '<div class="sk-body"><pre>' + esc(s.body || '') + '</pre>' +
            (s.author ? '<div class="sk-attr">Ported from ' + esc(s.author) + (s.license ? ' · ' + esc(s.license) : '') + '</div>' : '') +
          '</div>' +
        '</div>';
    };
    const section = (label, list) => list.length
      ? '<div class="sec sk-state-sec"><span class="sec-l">' + label + '</span><span class="sec-tag">' + list.length + '</span><span class="sec-r"></span><span class="sec-nd"></span></div>' + list.map(card).join('')
      : '';
    html += section('READY TO USE', groups.ready);
    html += section('NEEDS GEAR', groups.needsGear);
    html += section('TURNED OFF', groups.off);
    host.innerHTML = html;
    host.querySelectorAll('[data-toggle]').forEach(btn => btn.addEventListener('click', () => {
      const slug = btn.dataset.toggle, next = btn.dataset.enabled !== 'true';
      btn.classList.add('busy');
      Harness.api.post('/api/skills/toggle', { slug: slug, enabled: next })
        .then(({ ok, j: res }) => { if (ok && res && res.ok) { sfx('click'); loadSkillLibrary(agentId); } else { btn.classList.remove('busy'); } })
        .catch(() => btn.classList.remove('busy'));
    }));
    host.querySelectorAll('[data-place]').forEach(btn => btn.addEventListener('click', () => {
      sfx('click'); placeGearForSkill(btn.dataset.place, agentName);
    }));
    host.querySelectorAll('[data-expand]').forEach(btn => btn.addEventListener('click', () => {
      const card = btn.closest('.sk-card'); if (!card) return;
      const opened = card.classList.toggle('open'); btn.textContent = opened ? '▾' : '▸'; sfx('click');
    }));
  }

  function loadAgentSkills(agentId) {
    const host = $('#sk-agent'); if (!host) return;
    if (!(typeof Harness === 'object' && Harness.agentSkills)) {
      host.innerHTML = '<div class="sk-loading">Agent skillbase unavailable.</div>'; return;
    }
    Harness.agentSkills(agentId, { archived: true, body: true })
      .then(skills => { const h = $('#sk-agent'); if (h) renderAgentSkills(h, skills || [], agentId); })
      .catch(() => { const h = $('#sk-agent'); if (h) h.innerHTML = '<div class="sk-loading">Could not load agent skills.</div>'; });
  }

  function renderAgentSkills(host, skills, agentId) {
    if (!skills.length) {
      host.innerHTML = '<div class="sk-loading">No agent-created skills yet.</div>'; return;
    }
    const active = skills.filter(s => s.state !== 'archived').length;
    const archived = skills.length - active;
    const byId = {};
    skills.forEach(s => { byId[s.id] = s; });
    const sorted = skills.slice().sort((a, b) =>
      (!!b.pinned - !!a.pinned) || ((a.state === 'archived') - (b.state === 'archived')) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
    let html = '<div class="sk-lib-sum">' + active + ' active' + (archived ? ' - ' + archived + ' archived' : '') + '</div>';
    for (const s of sorted) {
      const state = s.state === 'archived' ? 'off' : (s.state === 'stale' ? 'want' : 'on');
      const when = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : 'unknown';
      const files = (s.files || []).length ? '<div class="sk-attr">Support files: ' + esc((s.files || []).map(f => f.path).join(', ')) + '</div>' : '';
      html +=
        '<div class="sk-card ' + state + '" data-agent-skill="' + esc(s.id) + '">' +
          '<div class="sk-card-head">' +
            '<button class="sk-toggle" data-ag-act="pin" title="' + (s.pinned ? 'Unpin' : 'Pin') + ' this skill">' + (s.pinned ? '*' : '+') + '</button>' +
            '<div class="sk-card-main">' +
              '<div class="sk-name-row"><span class="sk-name">' + esc(s.name) + '</span>' +
                (s.category ? '<span class="sk-badge cat">' + esc(String(s.category).toUpperCase()) + '</span>' : '') +
                '<span class="sk-badge free">' + esc((s.state || 'active').toUpperCase()) + '</span></div>' +
              '<div class="sk-desc">' + esc(s.summary || '') + '</div>' +
              '<div class="sk-stat ' + state + '">used ' + (s.useCount || 0) + 'x - viewed ' + (s.viewCount || 0) + 'x - patched ' + (s.patchCount || 0) + 'x - updated ' + esc(when) + '</div>' +
            '</div>' +
            '<button class="sk-expand" data-ag-act="expand" title="Read the skill">&gt;</button>' +
          '</div>' +
          '<div class="sk-body"><pre>' + esc(s.body || '') + '</pre>' + files +
            '<div class="consent-btns mc-acts">' +
              '<button class="consent-btn" data-ag-act="edit">Edit</button>' +
              '<button class="consent-btn" data-ag-act="archive">' + (s.state === 'archived' ? 'Restore' : 'Archive') + '</button>' +
            '</div>' +
          '</div>' +
        '</div>';
    }
    host.innerHTML = html;
    host.querySelectorAll('[data-ag-act]').forEach(btn => btn.addEventListener('click', async () => {
      const card = btn.closest('[data-agent-skill]'); if (!card) return;
      const skill = byId[card.dataset.agentSkill]; if (!skill) return;
      const act = btn.dataset.agAct;
      if (act === 'expand') {
        const opened = card.classList.toggle('open'); btn.textContent = opened ? 'v' : '>'; sfx('click'); return;
      }
      if (act === 'edit') { editAgentSkill(card, skill, agentId); return; }
      btn.classList.add('busy');
      const action = act === 'pin' ? (skill.pinned ? 'unpin' : 'pin') : (skill.state === 'archived' ? 'restore' : 'archive');
      const r = await Harness.agentSkillManage({ agentId, action, target: skill.id });
      if (r && r.ok) { sfx('click'); loadAgentSkills(agentId); } else btn.classList.remove('busy');
    }));
  }

  function editAgentSkill(card, skill, agentId) {
    const body = card.querySelector('.sk-body'); if (!body || body.dataset.editing === '1') return;
    body.dataset.editing = '1';
    if (!card.classList.contains('open')) card.classList.add('open');
    const pre = body.querySelector('pre');
    const actions = body.querySelector('.consent-btns');
    if (!actions) return;
    const ta = mkEl('textarea', 'cf-ta mc-edit'); ta.value = skill.body || ''; ta.spellcheck = false;
    if (pre) body.replaceChild(ta, pre);
    if (actions) actions.innerHTML = '';
    const save = mkEl('button', 'consent-btn'); save.textContent = 'Save'; actions.appendChild(save);
    const cancel = mkEl('button', 'consent-btn'); cancel.textContent = 'Cancel'; actions.appendChild(cancel);
    save.onclick = async () => {
      const r = await Harness.agentSkillManage({ agentId, action: 'edit', target: skill.id, summary: skill.summary || '', body: ta.value, category: skill.category || 'General' });
      if (r && r.ok) { sfx('click'); loadAgentSkills(agentId); }
    };
    cancel.onclick = () => loadAgentSkills(agentId);
    ta.focus();
  }
  /* ============== TASKS — the project-board view of WORKSTREAMS (card ≡ workstream) ==============
     One record, two views: every card here IS a workstream (the same thing you read/switch in the
     COMMS rail). The lane IS the workstream's lifecycle. HYBRID-HONEST lanes: a card auto-advances
     TO DO -> IN PROGRESS the instant a real run fires (Workstreams.appendRun); SHIPPED is only ever a
     deliberate human turn-in (the ✓ SHIP button). The General chat home isn't a project, so it shows
     in the rail but never on this board. App owns persistence + the rail; we drive both via sync(). */
  const COLS = [['todo', 'TO DO'], ['active', 'ACTIVE'], ['shipped', 'SHIPPED']];
  const WS = () => (typeof Workstreams === 'object' && Workstreams) ? Workstreams : null;
  function boardStreams() {
    const w = WS(); if (!w) return [];
    const gid = w.generalId();
    // TASK-BOARD TRUTH: the board is for TASKS, not sessions. Only kind:'task' streams render here (deliberate
    // board directives / recipe missions / goal milestones / /background). Plain chat, summoned-agent home
    // streams, and cron autosessions are kind:'chat' — they live in the COMMS rail, never on the board.
    return w.list().filter(x => x.id !== gid && x.kind === 'task');   // list() already drops archived; board also drops General + all chats
  }
  function persistWS() { if (typeof App !== 'undefined' && App.persist) App.persist(); }
  // a board mutation must refresh BOTH views — App.refreshRail re-renders the rail AND calls back into
    // refreshBoard() here, so one call keeps the rail and the board in lockstep.
  function sync() { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); else rerender('tasks'); }

  function addTask(title) {
    const w = WS(); if (!w) return;
    title = String(title || '').trim(); if (!title) return;
    w.create(title.slice(0, 80), { activate: false, kind: 'task' });   // a new TO DO task card; don't hijack the active chat (clamp matches Workstreams.make's 80)
    persistWS(); sync();
  }
  // open a card's conversation in COMMS (switch the active workstream) — safe mid-run now (per-stream channels)
  function openStream(id) {
    const w = WS(); if (!w) return;
    const s = w.get(id); if (!s) return;
    if (typeof App !== 'undefined' && App.openWorkstream) { App.openWorkstream(id); return; }
    w.switch(id);
    if (typeof Chat === 'object' && Chat.load) Chat.load(s);
    persistWS(); sync();
  }
  function shipTask(id) {
    const w = WS(); if (!w) return;
    if (!w.setLane(id, 'shipped')) return;
    const s = w.get(id); persistWS(); sync();
    notify('shipped ' + ((s && s.title) || 'workstream'), 'gold'); sfx('notify');
  }
  function reopenTask(id) { const w = WS(); if (!w) return; w.setLane(id, 'active'); persistWS(); sync(); }
  function archiveCard(id) { const w = WS(); if (!w) return; w.archive(id, true); persistWS(); sync(); }
  // a card IS a directive: open its conversation and, if it hasn't started yet, hand the agent its title
  function assignTask(id) {
    const w = WS(); if (!w) return;
    const s = w.get(id); if (!s) return;
    if (typeof App !== 'undefined' && App.openWorkstream) App.openWorkstream(id);
    else { w.switch(id); if (typeof Chat === 'object' && Chat.load) Chat.load(s); sync(); }
    const started = s.history.some(m => m.role === 'user');
    if (!started && s.title && typeof Chat === 'object' && Chat.send) Chat.send(s.title);
    // name the stream's OWN bound agent (s.agentId), resolved against the roster — never present[0], which is
    // whoever happens to be first, not who this workstream actually runs as.
    const bound = (Array.isArray(present) ? present.find(a => a && a.id === s.agentId) : null);
    const boundName = bound ? (bound.name || bound.id) : (s.agentId || 'agent');
    notify('assigned to ' + boundName + ': ' + (s.title || 'workstream'), 'gold');
    sfx('notify');
  }

  // purposeful empty-state per kanban lane (Phase 2 · E). The TO DO column gets a CTA that focuses the
  // add-a-workstream input (focus only — no new functionality); ACTIVE/SHIPPED just explain what lands here.
  function kbEmpty(lane) {
    if (lane === 'todo') return '<div class="kb-empty-col"><div class="empty-state">' +
      '<span class="es-glyph">▧</span><b>NO WORKSTREAMS</b>' +
      '<span>Queue the first thing you want your agent to build.</span>' +
      '<button class="es-cta" type="button">+ ADD ONE</button></div></div>';
    if (lane === 'active') return '<div class="kb-empty-col"><div class="empty-state">' +
      '<span class="es-glyph">▶</span><b>NOTHING IN FLIGHT</b>' +
      '<span>Assign a TO DO card and it moves here while the agent works.</span></div></div>';
    return '<div class="kb-empty-col"><div class="empty-state">' +
      '<span class="es-glyph">✓</span><b>NOTHING SHIPPED YET</b>' +
      '<span>Finished workstreams land here as proof of work.</span></div></div>';
  }
  // TRUTHFUL RUN-STATE (IN PROGRESS cards only): the chip maps to a PROVABLE backend state — RUNNING when a run
  // is actually in flight on this stream (Channels.isBusy), else DONE — REVIEW & SHIP once at least one run has
  // landed (the human's SHIP click is the only exit to SHIPPED — never auto-ship). A brand-new active card with
  // no run yet shows nothing. Reuses the rail's live-pulse vocabulary (.kb-live mirrors .ws-dot.running).
  function stateChip(s) {
    if (s.lane !== 'active') return '';
    const running = (typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(s.id));
    if (running) return '<div class="kb-state running"><span class="kb-live"></span>RUNNING</div>';
    if (s.runIds && s.runIds.length) return '<div class="kb-state done">DONE — REVIEW &amp; SHIP</div>';
    return '';
  }
  function activeAggregate(items) {
    let running = 0, ready = 0;
    items.forEach(s => {
      const busy = (typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(s.id));
      if (busy) running++;
      else if (s.runIds && s.runIds.length) ready++;
    });
    const parts = [];
    if (running) parts.push(running + ' RUNNING');
    if (ready) parts.push(ready + ' READY TO REVIEW');
    return parts.length ? '<small class="kb-col-state">' + parts.join(' · ') + '</small>' : '';
  }
  // the card's bound-agent chip: the workstream's OWN agent (s.agentId) resolved to a name + color from the live
  // roster. Truthful — a stream always carries a real agentId (default 'agent'); an unresolvable id shows verbatim,
  // never a made-up placeholder.
  function agentChip(s) {
    const a = (Array.isArray(present) ? present.find(x => x && x.id === s.agentId) : null);
    const nm = a ? (a.name || a.id) : (s.agentId || 'agent');
    const col = (a && a.color) || 'var(--ph-dim)';
    return '<span class="kb-agent" title="runs as ' + esc(nm) + '"><span class="kb-agent-dot" style="background:' + esc(col) + '"></span>' + esc(nm) + '</span>';
  }
  function card(s, i) {
    const n = s.runIds.length, runs = n ? n + (n === 1 ? ' run' : ' runs') : '';
    const dv = (s.deliverables && s.deliverables.length) || 0;   // real produced artifacts (workstreams.recordDeliverable)
    const acts = s.lane === 'todo'
      ? '<button class="assign" data-act="assign">▶ ASSIGN</button><button data-act="open">↗ OPEN</button><button data-act="arch">⌫</button>'
      : s.lane === 'active'
        ? '<button data-act="ship">✓ SHIP</button><button data-act="open">↗ OPEN</button><button data-act="arch">⌫</button>'
        : '<button data-act="reopen">↺ REOPEN</button><button data-act="open">↗ OPEN</button><button data-act="arch">⌫</button>';
    return '<div class="kb-card" data-id="' + s.id + '" role="button" tabindex="0" aria-label="' + esc(s.title || 'untitled') + ' — open conversation" style="--ci:' + (i || 0) + '">' +
      '<div class="kb-title">' + esc(s.title || 'untitled') + '</div>' +
      '<div class="kb-meta">' + agentChip(s) + '<span>' + clock(s.lastActiveAt || s.createdAt) + '</span>' +
      (runs ? '<span>' + runs + '</span>' : '') +
      (dv ? '<span class="kb-deliv">' + dv + ' deliverable' + (dv === 1 ? '' : 's') + '</span>' : '') + '</div>' +
      stateChip(s) +
      '<div class="kb-acts">' + acts + '</div></div>';
  }
  function buildTasks(body) {
    const streams = boardStreams();
    body.innerHTML =
      '<div class="kb-add"><input id="kb-in" maxlength="80" placeholder="add a workstream for your agent…" autocomplete="off">' +
      '<button class="bb sm" id="kb-add">+ ADD</button></div>' +
      '<div class="kb-cols">' +
      COLS.map(([lane, label]) => {
        const items = streams.filter(s => s.lane === lane);
        return '<div class="kb-col"><h4>' + label + ' <i>' + items.length + '</i>' +
          (lane === 'active' ? activeAggregate(items) : '') + '</h4>' +
          (items.length ? items.map(card).join('') : kbEmpty(lane)) + '</div>';
      }).join('') +
      '</div>' +
      // the dead-end this footnote kills (2026-07-16): "a run finished while you were away" sent users
      // hunting HERE, but this board only holds queued directives — finished routine/away runs are
      // readable sessions in COMMS and collectable on the OUTBOX. Shown only when the board is empty
      // (that's exactly when the hunt strands); openTerm('outbox') is the one-click door.
      (streams.length ? '' : '<div class="win-note" style="margin-top:8px">Looking for finished work? Routine and while-away runs aren’t board cards — they land as sessions in COMMS and wait on the <button type="button" class="lb-tx-btn" id="kb-outbox-link">▸ OUTBOX</button>.</div>');
    const inp = body.querySelector('#kb-in');
    const submit = () => { addTask(inp.value); };
    body.querySelector('#kb-add').addEventListener('click', () => { sfx('click'); submit(); });
    inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
    // empty-state CTA (TO DO column): focus the add-a-workstream input — no new behaviour, just focus.
    body.querySelectorAll('.kb-empty-col .es-cta').forEach(b =>
      b.addEventListener('click', () => { sfx('click'); inp.focus(); }));
    const obLink = body.querySelector('#kb-outbox-link');
    if (obLink) obLink.addEventListener('click', () => { sfx('click'); openTerm('outbox'); });
    inp.focus();
    body.querySelectorAll('.kb-card').forEach(c => {
      const id = c.dataset.id;
      c.querySelectorAll('.kb-acts button').forEach(b => b.addEventListener('click', ev => {
        ev.stopPropagation();   // a button click is not a card-body (open) click
        const act = b.dataset.act; sfx('click');
        if (act === 'assign') assignTask(id);
        else if (act === 'open') openStream(id);
        else if (act === 'ship') shipTask(id);
        else if (act === 'reopen') reopenTask(id);
        else if (act === 'arch') archiveCard(id);
      }));
      c.addEventListener('click', () => openStream(id));   // clicking the card body opens its conversation
      // keyboard parity for the role=button card: Enter/Space opens it — but only when the CARD itself is focused,
      // so the action buttons inside keep their own native Enter/Space (no double-fire).
      c.addEventListener('keydown', ev => {
        if (ev.target !== c) return;
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); sfx('click'); openStream(id); }
      });
    });
  }

  /* ============== CONNECTIONS — providers & API keys (real BYOK state) ==============
     User-facing transports. OpenRouter is the ONE live provider (a single BYOK key →
     300+ models); the rest are shown honestly as not-yet-available (same locked treatment
     as the SKILLS panel) — never as connected. Every bit of connection state is READ from
     the real Harness store; nothing here is simulated. Secrets are shown MASKED only — the
     full key is never written into the DOM (truthful-telemetry + don't-leak-the-key). */
  const PROVIDERS = [
    { id: 'openrouter',    name: 'OPENROUTER',        endpoint: 'openrouter.ai/api/v1',      blurb: 'one key · 300+ models',  live: true },
    { id: 'codex',         name: 'CHATGPT (CODEX)',   endpoint: 'OAuth · ChatGPT subscription', blurb: 'sign-in, no API key',  live: true },
    { id: 'grok',          name: 'GROK (XAI)',        endpoint: 'OAuth · SuperGrok / X Premium+', blurb: 'sign-in, no API key', live: true },
    { id: 'kimi',          name: 'KIMI FOR CODING',   endpoint: 'OAuth · Moonshot subscription', blurb: 'sign-in, no API key', live: true },
    { id: 'openai',        name: 'OPENAI API',        endpoint: 'api.openai.com/v1',          blurb: 'OpenAI-compatible', live: true },
    { id: 'anthropic',     name: 'ANTHROPIC',         endpoint: 'api.anthropic.com/v1',       blurb: 'Claude native API', live: true },
    { id: 'gemini',        name: 'GEMINI',            endpoint: 'generativelanguage.googleapis.com/v1beta', blurb: 'Google native API', live: true },
    { id: 'xai',           name: 'XAI',               endpoint: 'api.x.ai/v1',                blurb: 'Grok API', live: true },
    { id: 'groq',          name: 'GROQ',              endpoint: 'api.groq.com/openai/v1',     blurb: 'fast inference', live: true },
    { id: 'mistral',       name: 'MISTRAL',           endpoint: 'api.mistral.ai/v1',          blurb: 'Mistral API', live: true },
    { id: 'deepseek',      name: 'DEEPSEEK',          endpoint: 'api.deepseek.com',           blurb: 'DeepSeek API', live: true },
    { id: 'together',      name: 'TOGETHER',          endpoint: 'api.together.ai/v1',         blurb: 'Together API', live: true },
    { id: 'fireworks',     name: 'FIREWORKS',         endpoint: 'api.fireworks.ai/inference/v1', blurb: 'Fireworks API', live: true },
    { id: 'perplexity',    name: 'PERPLEXITY',        endpoint: 'api.perplexity.ai',          blurb: 'Sonar API', live: true },
    { id: 'cerebras',      name: 'CEREBRAS',          endpoint: 'api.cerebras.ai/v1',         blurb: 'Cerebras API', live: true },
    { id: 'ollama',        name: 'OLLAMA',            endpoint: '127.0.0.1:11434/v1',         blurb: 'local models', live: true },
    { id: 'custom',        name: 'CUSTOM',            endpoint: 'any /v1 base URL',           blurb: 'bring your endpoint', live: true }
  ];
  const H = () => (typeof Harness === 'object' && Harness) ? Harness : null;
  function provName(id) { const p = PROVIDERS.find(x => x.id === id); return p ? p.name : String(id || '').toUpperCase(); }
  function activeProv() { const h = H(); return (h && h.getProv && h.getProv()) || 'openrouter'; }
  let codexStatusKnown = null;        // last /api/auth/codex/status truth: { connected, expired, reason }
  let codexConnectionChecking = false;
  // mask a secret to a provider-recognisable prefix + last 4 — the middle is NEVER emitted.
  function maskKey(k) {
    k = String(k || ''); if (!k) return '';
    const m = k.match(/^(sk-or-v1-|sk-or-|sk-proj-|sk-ant-|gsk_|xai-|pplx-|AIza|sk-)/i);
    const head = m ? m[1] : k.slice(0, 4);
    // only append a last-4 tail when it can't overlap the (non-secret) prefix we already show
    const tail = k.length > head.length + 4 ? k.slice(-4) : '';
    return head + '••••••••' + tail;
  }
  // the REAL connected providers: OpenRouter from the BYOK store, Codex from sidecar OAuth status.
  // They are additive, so signing into ChatGPT must not occupy the OpenRouter key slot.
  function refreshCodexConnectionStatus() {
    if (codexConnectionChecking || typeof fetch !== 'function') return;
    codexConnectionChecking = true;
    fetch('/api/auth/codex/status', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : { connected: false })
      .then(j => {
        // carry the WHOLE truth shape: `connected` alone can't distinguish "never signed in" from the
        // consumed-refresh-token death (`expired` + `reason`) — the row must render those differently.
        const next = { connected: !!(j && j.connected), expired: !!(j && j.expired), reason: (j && j.reason) || '' };
        const prev = codexStatusKnown;
        codexStatusKnown = next;
        if (!prev || prev.connected !== next.connected || prev.expired !== next.expired) rerender('settings');
      })
      .catch(() => {})
      .finally(() => { codexConnectionChecking = false; });
  }
  function codexConnected() {
    if (codexStatusKnown !== null) return !!codexStatusKnown.connected;
    const h = H();
    return !!(h && h.getProv && h.getProv() === 'codex');
  }
  // the KNOWN-dead sign-in (sidecar recorded a relogin-class refresh failure): tokens exist but can't run.
  function codexExpired() { return !!(codexStatusKnown && codexStatusKnown.expired); }
  function codexExpiredReason() { return (codexStatusKnown && codexStatusKnown.reason) || ''; }

  // The OTHER keyless device-code OAuth providers (grok/kimi) follow codex's exact contract but through the
  // SHARED path — one status cache + one refresh + one row/handler parameterized by provider id, so we never
  // copy the codex block per provider. Codex keeps its own literal state above (the source-lock tests pin it).
  const OAUTH_EXTRA = ['grok', 'kimi'];                 // codex is handled by the literal path above
  const OAUTH_ALL = ['codex'].concat(OAUTH_EXTRA);      // every keyless device-code provider
  function isOAuthProvider(id) { return OAUTH_ALL.indexOf(id) >= 0; }
  const oauthLabels = { grok: 'Grok OAuth', kimi: 'Kimi OAuth' };
  function oauthMaskLabel(pid) { return oauthLabels[pid] || (provName(pid) + ' OAuth'); }
  const oauthStatus = { grok: null, kimi: null };       // last /api/auth/<pid>/status truth per provider
  const oauthChecking = { grok: false, kimi: false };
  function refreshOAuthStatus(pid) {
    if (oauthChecking[pid] || typeof fetch !== 'function') return;
    oauthChecking[pid] = true;
    fetch('/api/auth/' + pid + '/status', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : { connected: false })
      .then(j => {
        // carry the WHOLE truth shape (connected + expired + reason), exactly like codex — a lone bool can't
        // distinguish "never signed in" from the dead-refresh-token death the row must render differently.
        const next = { connected: !!(j && j.connected), expired: !!(j && j.expired), reason: (j && j.reason) || '' };
        const prev = oauthStatus[pid];
        oauthStatus[pid] = next;
        if (!prev || prev.connected !== next.connected || prev.expired !== next.expired) rerender('settings');
      })
      .catch(() => {})
      .finally(() => { oauthChecking[pid] = false; });
  }
  function refreshExtraOAuthStatus() { OAUTH_EXTRA.forEach(refreshOAuthStatus); }
  function oauthProvConnected(pid) {
    const s = oauthStatus[pid];
    if (s !== null) return !!s.connected;
    const h = H();
    return !!(h && h.getProv && h.getProv() === pid);
  }
  function oauthProvExpired(pid) { const s = oauthStatus[pid]; return !!(s && s.expired); }
  function oauthProvReason(pid) { const s = oauthStatus[pid]; return (s && s.reason) || ''; }
  // unified accessors that route codex to its literal predicates and grok/kimi to the shared cache, so the
  // render/handler logic below reads one truth interface regardless of which OAuth provider a row is for.
  function oauthConnectedFor(pid) { return pid === 'codex' ? codexConnected() : oauthProvConnected(pid); }
  function oauthExpiredFor(pid) { return pid === 'codex' ? codexExpired() : oauthProvExpired(pid); }
  function oauthReasonFor(pid) { return pid === 'codex' ? codexExpiredReason() : oauthProvReason(pid); }
  // Where do saved API keys actually live? TRUTH SOURCE = the sidecar's keychainMode (DESKTOP_SHELL): the packaged
  // desktop build holds BYOK keys in the OS keychain; the browser holds them in its own local store. We learn this
  // lazily from /api/providers (mirrors the codex-status probe) and cache it so the key-save confirmation can name
  // the REAL store — never claim keychain when the key is in the browser (truthful-telemetry law).
  let keychainModeKnown = null;
  let keychainModeChecking = false;
  function refreshKeychainMode() {
    if (keychainModeKnown !== null || keychainModeChecking || typeof fetch !== 'function') return;
    keychainModeChecking = true;
    fetch('/api/providers', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : {})
      .then(j => { keychainModeKnown = !!(j && j.keychainMode); })
      .catch(() => {})
      .finally(() => { keychainModeChecking = false; });
  }
  // honest one-liner for where a just-saved key was stored. Falls back to the neutral "on this machine" until the
  // probe answers, so we never assert keychain-vs-browser before we actually know it.
  function keyStoreClause() {
    if (keychainModeKnown === true) return 'stored in your OS keychain';
    if (keychainModeKnown === false) return 'stored locally in this browser';
    return 'stored on this machine';
  }
  const providerHealth = Object.create(null);   // last no-generation sidecar probe, keyed by provider id
  const providerProbePending = Object.create(null);
  function invalidateProviderHealth(provider) { delete providerHealth[provider]; delete providerProbePending[provider]; }
  function refreshProviderHealth(provider) {
    const h = H();
    if (!h || !h.probeProvider || providerProbePending[provider]) return;
    providerProbePending[provider] = true;
    Promise.resolve(h.probeProvider(provider)).then(result => { providerHealth[provider] = result || null; })
      .catch(() => { providerHealth[provider] = null; })
      .finally(() => {
        delete providerProbePending[provider];
        // Repaint only while Settings is still open. The cache prevents this repaint from starting a probe loop.
        if (open.settings) rerender('settings');
      });
  }
  function queueProviderHealthRefresh() {
    const h = H(); if (!h) return;
    for (const p of PROVIDERS) {
      const credentialSaved = !!(h.hasStoredCredential && h.hasStoredCredential(p.id));
      const endpointConfigured = p.id === 'ollama' || (p.id === 'custom' && !!(h.getBaseUrl && h.getBaseUrl(p.id)));
      if ((credentialSaved || endpointConfigured || p.id === activeProv()) && providerHealth[p.id] === undefined) refreshProviderHealth(p.id);
    }
  }
  function connectedKeys() {
    const h = H(); if (!h) return [];
    const out = [];
    const active = activeProv();
    // Codex first when it's the live provider — an OAuth connection that carries a model but no API key.
    // A KNOWN-dead sign-in still gets its row (marked expired): the credentials exist on disk and the row is
    // where RE-SIGN-IN / DISCONNECT live — hiding it was the escape where the user had no recovery path.
    if (codexConnected() || codexExpired()) out.push({ provider: 'codex', key: '', model: (h.getModel && h.getModel()) || '', oauth: true, expired: codexExpired() });
    // the other keyless device-code sign-ins (grok/kimi) get the SAME additive row treatment as codex: a live or
    // KNOWN-dead sign-in earns a row (that's where RE-SIGN-IN / DISCONNECT live). The model is only shown when the
    // provider is actually active (truthful telemetry — getModel() is the active-provider model, not this row's).
    OAUTH_EXTRA.forEach(pid => {
      if (oauthProvConnected(pid) || oauthProvExpired(pid)) {
        const activeModel = (h.getProv && h.getProv() === pid && h.getModel) ? (h.getModel() || '') : '';
        out.push({ provider: pid, key: '', model: activeModel, oauth: true, expired: oauthProvExpired(pid) });
      }
    });
    // OpenRouter BYOK: desktop keeps the key in the OS keychain (getKey returns ''); configured() reports it's set.
    function addProvider(provider) {
      if (!provider || isOAuthProvider(provider) || out.some(k => k.provider === provider)) return;
      if (provider === 'ollama' && provider !== active) return;
      // Truthful list: only providers with an ACTUALLY-stored credential show a row/badge (never DEVMODE-fabricated).
      // hasStoredCredential is the honest getter; fall back to the older signals if an old harness lacks it.
      const set = h.hasStoredCredential ? h.hasStoredCredential(provider)
        : ((h.configured && h.configured(provider)) || !!(h.getKey && h.getKey(provider)));
      // A KEYLESS custom endpoint (vLLM / LM Studio / any no-auth OpenAI-compatible server) still earns its row:
      // the ✎ STATION LINK editor lives ONLY on this row, so gating it on a stored key froze the endpoint at
      // whatever onboarding stored — and REMOVE-ing the last custom key stranded a still-active endpoint with no
      // editor. hasStoredCredential('custom') stays false for it (an endpoint is configuration, not a credential).
      const keylessEp = provider === 'custom' && !!(h.getBaseUrl && h.getBaseUrl('custom'));
      if (set || keylessEp) out.push({ provider, key: h.getKey ? h.getKey(provider) : '', baseUrl: h.getBaseUrl ? h.getBaseUrl(provider) : '', model: (h.getModel && h.getModel()) || '', local: provider === 'ollama' });
    }
    addProvider(active);
    if (active !== 'openrouter') addProvider('openrouter');
    PROVIDERS.forEach(p => addProvider(p.id));
    return out;
  }
  function keysFor(id) { return connectedKeys().filter(x => x.provider === id); }
  function providerAcceptsKey(provider) {
    provider = provider || activeProv();
    return !isOAuthProvider(provider) && provider !== 'ollama';
  }
  function addKeyHtml(provider, empty) {
    provider = provider || 'openrouter';
    return '<div class="key-empty">' +
      '<p>' + (empty
        ? 'No API keys connected. Paste a key here to reconnect - it stays on this machine.'
        : 'Add a ' + esc(provName(provider)) + ' key while keeping your ChatGPT sign-in connected.') + '</p>' +
      '<div class="key-edit">' +
      '<input type="password" class="key-input" id="key-in-new" placeholder="paste ' + esc(provName(provider)) + ' key..." autocomplete="off" spellcheck="false">' +
      '<button class="bb sm" data-act="add" data-provider="' + esc(provider) + '">SAVE</button>' +
      '</div></div>';
  }

  function providersHtml() {
    const active = activeProv();
    return PROVIDERS.map((p, pi) => {
      const ks = keysFor(p.id);
      // a keyless device-code sign-in (codex/grok/kimi) can be KNOWN-dead (sidecar recorded a consumed/invalid
      // refresh token) — that must never render as SIGNED IN. The row still exists (ks has the expired entry) so
      // RE-SIGN-IN is reachable. `codexDead` keeps its historical name because the source-lock tests pin
      // `codexDead ? 'avail expired'` / `&& !codexDead`; it now flags a dead sign-in for ANY OAuth provider.
      const codexDead = isOAuthProvider(p.id) && oauthExpiredFor(p.id);
      const h = H();
      const credentialSaved = isOAuthProvider(p.id) ? (ks.length > 0 && !codexDead) : !!(h && h.hasStoredCredential && h.hasStoredCredential(p.id));
      const endpointConfigured = p.id === 'ollama' || (p.id === 'custom' && !!(h && h.getBaseUrl && h.getBaseUrl(p.id)));
      const configured = credentialSaved || endpointConfigured;
      const health = providerHealth[p.id];
      // ACTIVE is reserved for a selected model whose endpoint and credential (when applicable) were proven by
      // the no-generation probe. Selection plus a model id is not evidence that a run can leave the station.
      const runnable = !!(health && health.reachable && health.credentialVerified && p.id === active && h && h.getModel && h.getModel());
      const cls = codexDead ? 'avail expired' : (configured ? 'conn' : (p.live ? 'avail' : 'soon'));
      // E5: `connected` is KEY PRESENCE, not a verified live connection — a saved key can be revoked,
      // rate-limited, or wrong, and we haven't round-tripped it. Label it "KEY SAVED" (or SIGNED IN for
      // the codex OAuth path, which IS real auth) rather than the over-claiming "CONNECTED". The
      // ACTIVE/runnable badge logic below is unchanged — that already gates on selected provider + model.
      const connLabel = isOAuthProvider(p.id) ? '● SIGNED IN' : '● KEY SAVED';
      const keyless = p.id === 'ollama' || (p.id === 'custom' && endpointConfigured && !credentialSaved);
      const localStat = !endpointConfigured ? '○ NO ENDPOINT' : health === undefined ? '◐ LOCAL ENDPOINT CONFIGURED · CHECKING…'
        : health && health.reachable ? '● LOCAL ENDPOINT CONFIGURED · REACHABLE' : '○ LOCAL ENDPOINT CONFIGURED · OFFLINE';
      const keyStat = health === undefined ? connLabel + ' · CHECKING…'
        : health && health.credentialVerified ? connLabel + ' · VERIFIED' : health && health.reachable ? connLabel + ' · NOT VERIFIED' : connLabel + ' · CHECK FAILED';
      const stat = !p.live ? '○ COMING SOON' : codexDead ? '⚠ SIGN-IN EXPIRED — RECONNECT'
        : keyless ? localStat : credentialSaved ? keyStat : (isOAuthProvider(p.id) ? '○ NOT SIGNED IN' : (p.id === 'custom' ? '○ NO ENDPOINT' : '○ NO KEY'));
      const n = ks.length;
      // NO-KEY cards that accept a key get an inline, collapsible paste-and-save row so the user never has to hunt
      // for where keys live. It reuses the SAME save path (Harness.setKey) as the key list below — no duplicate logic.
      const wantsInline = p.live && !credentialSaved && providerAcceptsKey(p.id);
      // A never-signed-in device-code provider (codex/grok/kimi) gets its FIRST sign-in right on the card.
      // Codex is NOT exempt: its connect-screen block only exists on the overseer/brain screen, so after a
      // ✕ DISCONNECT (or on a machine that never signed in there) this button is the ONLY reachable sign-in —
      // without it the row reads NOT SIGNED IN with zero recovery (the 2026-07-21 user-reported escape).
      // The ⏼ RE-SIGN-IN row below can't cover it: that row only exists once a live/known-dead sign-in exists.
      const wantsOAuthSignin = p.live && isOAuthProvider(p.id) && !credentialSaved && !codexDead;
      return '<div class="prov-card ' + cls + '" data-provider="' + esc(p.id) + '" role="button" tabindex="0" style="--ci:' + pi + '">' +
        '<span class="conn-dot"></span>' +
        '<div class="prov-main">' +
        '<div class="prov-name">' + esc(p.name) + (runnable ? '<span class="prov-badge">ACTIVE</span>' : '') + '</div>' +
        '<div class="prov-ep">' + esc(p.endpoint) + ' · ' + esc(p.blurb) + '</div>' +
        '</div>' +
        '<div class="prov-stat">' + stat + (credentialSaved && !isOAuthProvider(p.id) ? '<i>' + n + (n === 1 ? ' key' : ' keys') + '</i>' : '') +
          (wantsInline ? '<button class="bb sm prov-addkey" data-act="prov-add-toggle" data-provider="' + esc(p.id) + '" aria-label="Add a ' + esc(p.name) + ' key" title="paste a ' + esc(p.name) + ' key without leaving this card">＋ ADD KEY</button>' : '') +
          (wantsOAuthSignin ? '<button class="bb sm prov-addkey" data-act="prov-oauth-signin" data-provider="' + esc(p.id) + '" aria-label="Sign in to ' + esc(p.name) + '" title="device-code sign-in — no API key needed">⏼ SIGN IN</button>' : '') +
        '</div>' +
        (wantsInline
          ? '<div class="key-edit prov-key-edit" id="prov-key-edit-' + esc(p.id) + '" hidden>' +
            '<input type="password" class="key-input" id="prov-key-in-' + esc(p.id) + '" placeholder="paste ' + esc(p.name) + ' key…" autocomplete="off" spellcheck="false">' +
            '<button class="bb sm" data-act="prov-add-save" data-provider="' + esc(p.id) + '">SAVE</button>' +
            '</div>'
          : '') +
        (wantsOAuthSignin
          ? '<div class="key-edit codex-inline prov-oauth-inline" id="prov-oauth-inline-' + esc(p.id) + '" hidden>' +
            '<span class="dim" id="prov-oauth-status-' + esc(p.id) + '"></span>' +
            '<code class="key-mask" id="prov-oauth-code-' + esc(p.id) + '" hidden></code>' +
            '<button class="bb sm" id="prov-oauth-open-' + esc(p.id) + '" hidden>↗ OPEN PAGE</button>' +
            '</div>'
          : '') +
        '</div>';
    }).join('');
  }
  // The SHARED credential-row for a keyless device-code OAuth provider (grok/kimi) — the parameterized twin of
  // the codex oauth branch in keysHtml. Same honest contract: SIGN-IN EXPIRED (never SIGNED IN) when dead, a
  // scrubbed reason, and always-present ⏼ RE-SIGN-IN / ✕ DISCONNECT wired to the shared engine + its own inline
  // device-code box (id'd by provider so two rows never collide). No token material is ever rendered.
  function oauthKeyRow(k, runState) {
    const pid = k.provider;
    const dead = !!k.expired;
    const meta = dead
      ? '<span class="key-stat bad">⚠ SIGN-IN EXPIRED — ' + esc(oauthProvReason(pid) || 'the stored sign-in no longer works; reconnect to run again') + '</span>'
      : 'model <b>' + esc(k.model || '—') + '</b> · ' +
        runState +
        ' · <span class="key-stat">no API key needed</span>';
    return '<div class="key-row' + (dead ? ' expired' : '') + '">' +
      '<span class="conn-dot"></span>' +
      '<div class="key-main">' +
      '<div class="key-top"><span class="key-prov">' + esc(provName(pid)) + '</span>' +
      (dead
        ? '<code class="key-mask key-mask-dead" title="the sidecar recorded a dead refresh token — a re-sign-in is the only cure">⚠ EXPIRED</code>'
        : '<code class="key-mask" title="authenticated by OAuth sign-in — no API key is stored">' + esc(oauthMaskLabel(pid)) + '</code>') + '</div>' +
      '<div class="key-meta">' + meta + '</div>' +
      '</div>' +
      '<div class="key-acts">' +
      '<button class="bb sm" data-act="' + esc(pid) + '-resign">⏼ RE-SIGN-IN</button>' +
      '<button class="bb sm danger" data-act="' + esc(pid) + '-logout">✕ DISCONNECT</button>' +
      '</div></div>' +
      // the inline device-code surface the RE-SIGN-IN action fills (same engine as codex: OAuthSignIn.for(pid)
      // → code + verification URL here, poll until the sidecar reports connected).
      '<div class="key-edit codex-inline" id="' + esc(pid) + '-inline-signin" hidden>' +
      '<span class="dim" id="' + esc(pid) + '-inline-status"></span>' +
      '<code class="key-mask" id="' + esc(pid) + '-inline-code" hidden></code>' +
      '<button class="bb sm" id="' + esc(pid) + '-inline-open" hidden>↗ OPEN PAGE</button>' +
      '</div>';
  }
  function keysHtml() {
    const keys = connectedKeys(), active = activeProv();
    const addProvider = active === 'codex' ? 'openrouter' : active;
    const hasAddProvider = keys.some(k => k.provider === addProvider);
    if (!keys.length) return providerAcceptsKey(addProvider) ? addKeyHtml(addProvider, true) : '<div class="key-empty"><p>No API keys connected.</p></div>';
/*
    if (!keys.length) {
      // reachable in-session via REMOVE — let the user reconnect right here, no CONNECT-screen round-trip.
      return '<div class="key-empty">' +
        '<p>No API keys connected. Paste a key here to reconnect — it stays on this machine.</p>' +
        '<div class="key-edit">' +
        '<input type="password" class="key-input" id="key-in-new" placeholder="paste ' + esc(provName(active)) + ' key…" autocomplete="off" spellcheck="false">' +
        '<button class="bb sm" data-act="add">SAVE</button>' +
        '</div></div>';
    }
    return keys.map((k, i) => {
*/
    const rows = keys.map((k, i) => {
      // The credential row follows the same truth contract as the provider card above. Selection is useful context,
      // but ACTIVE is reserved for a selected model whose endpoint/credential probe proved it can run.
      const health = providerHealth[k.provider];
      const selected = k.provider === active && !!k.model;
      const runnable = !!(selected && health && health.reachable && health.credentialVerified);
      const runState = runnable ? '<span class="key-stat on">ACTIVE</span>'
        : selected ? '<span class="key-stat">SELECTED</span>' : '<span class="key-stat">idle</span>';
      // grok/kimi (the other keyless device-code sign-ins) render through the SHARED oauth row below — same
      // semantics as codex, parameterized by provider id, so the codex block is not copy-pasted per provider.
      if (k.oauth && k.provider !== 'codex') return oauthKeyRow(k, runState);
      // Codex (OAuth) has no API key to mask/edit/remove — render it honestly as a sign-in connection.
      // The row always carries its OWN actions (⏼ RE-SIGN-IN / ✕ DISCONNECT): the 2026-07-08 escape was a
      // dead sign-in still labelled SIGNED IN with zero recovery actions on this exact row.
      if (k.oauth) {
        const dead = !!k.expired;
        const meta = dead
          ? '<span class="key-stat bad">⚠ SIGN-IN EXPIRED — ' + esc(codexExpiredReason() || 'the stored sign-in no longer works; reconnect to run again') + '</span>'
          : 'model <b>' + esc(k.model || '—') + '</b> · ' +
            runState +
            ' · <span class="key-stat">no API key needed</span>';
        return '<div class="key-row' + (dead ? ' expired' : '') + '">' +
          '<span class="conn-dot"></span>' +
          '<div class="key-main">' +
          '<div class="key-top"><span class="key-prov">' + esc(provName(k.provider)) + '</span>' +
          (dead
            ? '<code class="key-mask key-mask-dead" title="the sidecar recorded a dead refresh token — a re-sign-in is the only cure">⚠ EXPIRED</code>'
            : '<code class="key-mask" title="authenticated by ChatGPT sign-in (OAuth) — no API key is stored">ChatGPT OAuth</code>') + '</div>' +
          '<div class="key-meta">' + meta + '</div>' +
          '</div>' +
          '<div class="key-acts">' +
          '<button class="bb sm" data-act="codex-resign">⏼ RE-SIGN-IN</button>' +
          '<button class="bb sm danger" data-act="codex-logout">✕ DISCONNECT</button>' +
          '</div></div>' +
          // the inline device-code surface the RE-SIGN-IN action fills (same engine as the brain screen:
          // CodexSignIn.start → code + verification URL here, poll until the sidecar reports connected).
          '<div class="key-edit codex-inline" id="codex-inline-signin" hidden>' +
          '<span class="dim" id="codex-inline-status"></span>' +
          '<code class="key-mask" id="codex-inline-code" hidden></code>' +
          '<button class="bb sm" id="codex-inline-open" hidden>↗ OPEN PAGE</button>' +
          '</div>';
      }
      if (k.local) {
        return '<div class="key-row">' +
          '<span class="conn-dot"></span>' +
          '<div class="key-main">' +
          '<div class="key-top"><span class="key-prov">' + esc(provName(k.provider)) + '</span>' +
          '<code class="key-mask" title="local OpenAI-compatible endpoint">Local endpoint</code></div>' +
          '<div class="key-meta">model <b>' + esc(k.model || '—') + '</b> · ' +
          runState +
          ' · <span class="key-stat">no API key needed</span></div>' +
          '</div></div>';
      }
      // STATION LINK / base-URL edit (post-onboarding, EL-11 #12): a custom OpenAI-compatible endpoint carries an
      // editable base URL. Onboarding is the only other place Harness.setBaseUrl is called; without this control the
      // endpoint was frozen at whatever onboarding stored. Only the 'custom' provider uses a base URL, so gate on it.
      const isCustomEp = k.provider === 'custom';
      const baseBtn = isCustomEp
        ? '<button class="bb sm" data-act="baseurl-edit" data-i="' + i + '" title="change this station link / endpoint URL without re-onboarding">✎ STATION LINK</button>'
        : '';
      const baseBlock = isCustomEp
        ? '<div class="key-edit" id="base-edit-' + i + '" hidden>' +
            '<input type="url" class="key-input base-input" id="base-in-' + i + '" placeholder="https://your-endpoint/v1" value="' + esc(k.baseUrl || '') + '" autocomplete="off" spellcheck="false">' +
            '<button class="bb sm" data-act="baseurl-apply" data-i="' + i + '">APPLY</button>' +
            '<span class="msg" id="base-msg-' + i + '"></span>' +
          '</div>'
        : '';
      return '<div class="key-row">' +
        '<span class="conn-dot"></span>' +
        '<div class="key-main">' +
        '<div class="key-top"><span class="key-prov">' + esc(provName(k.provider)) + '</span>' +
        '<code class="key-mask" title="shown masked when a key exists — the full key is never displayed">' + esc(k.key ? maskKey(k.key) : (k.baseUrl || 'keyless endpoint')) + '</code></div>' +
        '<div class="key-meta">model <b>' + esc(k.model || '—') + '</b> · ' +
        runState + '</div>' +
        '</div>' +
        '<div class="key-acts">' +
        '<button class="bb sm" data-act="edit" data-i="' + i + '">✎ UPDATE</button>' +
        baseBtn +
        '<button class="bb sm danger" data-act="rm" data-i="' + i + '">✕ REMOVE</button>' +
        '</div></div>' +
        '<div class="key-edit" id="key-edit-' + i + '" hidden>' +
        '<input type="password" class="key-input" id="key-in-' + i + '" placeholder="paste new ' + esc(provName(k.provider)) + ' key…" autocomplete="off" spellcheck="false">' +
        '<button class="bb sm" data-act="save" data-i="' + i + '">SAVE</button>' +
        '</div>' +
        baseBlock;
    });
    if (providerAcceptsKey(addProvider) && !hasAddProvider) rows.push(addKeyHtml(addProvider, false));
    return rows.join('');
  }
  // edit-in-place / guarded remove for a stored key. Mirrors the CLEAR arm/confirm pattern
  // (no native dialogs inside the phosphor terminal). All writes go through the Harness store.
  function wireKeyActions(body) {
    body.querySelectorAll('.key-acts button, .key-edit button').forEach(b => {
      b.addEventListener('click', () => {
        const h = H(); const act = b.dataset.act;
        if (act !== 'rm') sfx('click');   // destructive REMOVE owns its own 'bad' cue (matches the CLEAR control)
        // ---- ChatGPT (Codex) OAuth row actions — no Harness store involved; they drive the sidecar's
        //      device-flow endpoints through the SAME shared engine as the brain screen (codexsignin.js). ----
        if (act === 'codex-resign') {
          if (typeof CodexSignIn === 'undefined') return;
          const box = body.querySelector('#codex-inline-signin');
          const st = body.querySelector('#codex-inline-status');
          const code = body.querySelector('#codex-inline-code');
          const open = body.querySelector('#codex-inline-open');
          if (box) box.hidden = false;
          CodexSignIn.start({
            onRequesting: () => { if (st) st.textContent = 'requesting a sign-in code…'; },
            onError: msg => { if (st) st.textContent = msg; sfx('bad'); },
            onTimeout: () => { if (st) st.textContent = 'sign-in timed out — hit RE-SIGN-IN to start again'; },
            onCode: c => {
              if (code) { code.textContent = c.user_code; code.hidden = false; }
              if (st) st.innerHTML = 'enter this code at <b>' + esc(c.verification_uri) + '</b> (opening it now)…';
              if (open) { open.hidden = false; open.onclick = () => { sfx('click'); openExternal(c.verification_uri); }; }
              openExternal(c.verification_uri);
            },
            onConnected: () => {
              // the sidecar just exchanged + persisted fresh tokens — that POLL answer is backend truth.
              codexStatusKnown = { connected: true, expired: false, reason: '' };
              notify('✓ reconnected ChatGPT — your agents can run on your subscription again', 'good');
              if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();
              if (typeof KeyCTA !== 'undefined' && KeyCTA.refresh) KeyCTA.refresh();
              refreshCodexConnectionStatus();   // re-read the durable status (persistError etc.) behind the repaint
              rerender('settings');
            }
          });
          return;
        }
        if (act === 'codex-logout') {
          if (typeof CodexSignIn !== 'undefined') CodexSignIn.cancel();
          const drop = (typeof CodexSignIn !== 'undefined') ? CodexSignIn.logout() : Harness.api.post('/api/auth/codex/logout').catch(() => {});
          Promise.resolve(drop).then(() => {
            codexStatusKnown = { connected: false, expired: false, reason: '' };   // the sidecar just confirmed the drop
            notify('disconnected ChatGPT — sign in again anytime from PROVIDERS', 'warn');
            sfx('bad');
            if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();
            if (typeof KeyCTA !== 'undefined' && KeyCTA.refresh) KeyCTA.refresh();
            rerender('settings');
          });
          return;
        }
        // ---- grok / kimi OAuth row actions — the SHARED path: same wiring as codex, but through the generalized
        //      engine OAuthSignIn.for(pid) and this provider's own inline device-code surface. No Harness store. ----
        const oauthAct = act && act.match(/^(grok|kimi)-(resign|logout)$/);
        if (oauthAct) {
          const pid = oauthAct[1];
          const engine = (typeof OAuthSignIn !== 'undefined') ? OAuthSignIn.for(pid) : null;
          if (oauthAct[2] === 'resign') {
            if (!engine) return;
            const box = body.querySelector('#' + pid + '-inline-signin');
            const st = body.querySelector('#' + pid + '-inline-status');
            const code = body.querySelector('#' + pid + '-inline-code');
            const open = body.querySelector('#' + pid + '-inline-open');
            if (box) box.hidden = false;
            engine.start({
              onRequesting: () => { if (st) st.textContent = 'requesting a sign-in code…'; },
              onError: msg => { if (st) st.textContent = msg; sfx('bad'); },
              onTimeout: () => { if (st) st.textContent = 'sign-in timed out — hit RE-SIGN-IN to start again'; },
              onCode: c => {
                if (code) { code.textContent = c.user_code; code.hidden = false; }
                if (st) st.innerHTML = 'enter this code at <b>' + esc(c.verification_uri) + '</b> (opening it now)…';
                if (open) { open.hidden = false; open.onclick = () => { sfx('click'); openExternal(c.verification_uri); }; }
                openExternal(c.verification_uri);
              },
              onConnected: () => {
                // the sidecar just exchanged + persisted fresh tokens — that POLL answer is backend truth.
                oauthStatus[pid] = { connected: true, expired: false, reason: '' };
                notify('✓ reconnected ' + provName(pid) + ' — your agents can run on your subscription again', 'good');
                if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();
                if (typeof KeyCTA !== 'undefined' && KeyCTA.refresh) KeyCTA.refresh();
                refreshOAuthStatus(pid);   // re-read the durable status (persistError etc.) behind the repaint
                rerender('settings');
              }
            });
            return;
          }
          // logout
          if (engine) engine.cancel();
          const drop = engine ? engine.logout() : Harness.api.post('/api/auth/' + pid + '/logout').catch(() => {});
          Promise.resolve(drop).then(() => {
            oauthStatus[pid] = { connected: false, expired: false, reason: '' };   // the sidecar just confirmed the drop
            notify('disconnected ' + provName(pid) + ' — sign in again anytime from PROVIDERS', 'warn');
            sfx('bad');
            if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();
            if (typeof KeyCTA !== 'undefined' && KeyCTA.refresh) KeyCTA.refresh();
            rerender('settings');
          });
          return;
        }
        if (!h) return;
        if (act === 'add') {              // empty-state: connect a first key without leaving the game
          const inp = body.querySelector('#key-in-new');
          const v = inp ? inp.value.trim() : '';
          if (!v) { sfx('bad'); return; }
          const provider = b.dataset.provider || activeProv();
          if (h.setKey) h.setKey(v, provider);
          invalidateProviderHealth(provider);
          notify('✓ connected ' + provName(provider) + ' API key — ' + keyStoreClause(), 'good');
          if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();   // clear the dock's no-key warning the instant a key lands
          if (typeof KeyCTA !== 'undefined' && KeyCTA.refresh) KeyCTA.refresh();             // …and the world's keyless-brain banner
          rerender('settings');
          return;
        }
        const i = +b.dataset.i, row = connectedKeys()[i];
        if (!row) return;
        if (act === 'edit') {
          const ed = body.querySelector('#key-edit-' + i);
          if (ed) { ed.hidden = !ed.hidden; if (!ed.hidden) { const inp = body.querySelector('#key-in-' + i); if (inp) inp.focus(); } }
        } else if (act === 'baseurl-edit') {
          const ed = body.querySelector('#base-edit-' + i);
          if (ed) { ed.hidden = !ed.hidden; if (!ed.hidden) { const inp = body.querySelector('#base-in-' + i); if (inp) inp.focus(); } }
        } else if (act === 'baseurl-apply') {
          // EL-11 #12: apply an edited base URL post-onboarding, then PROVE the result honestly (truthful telemetry).
          const inp = body.querySelector('#base-in-' + i);
          const msg = body.querySelector('#base-msg-' + i);
          const setMsg = (t, cls) => { if (msg && msg.isConnected) { msg.textContent = t; msg.className = 'msg' + (cls ? ' ' + cls : ''); } };
          const v = inp ? inp.value.trim() : '';
          if (!v) { sfx('bad'); setMsg('enter your endpoint URL', 'bad'); return; }
          // Same validation/normalization onboarding relies on: a non-empty URL; a bare host gets an https:// scheme
          // so the endpoint is well-formed before we store it. Reject anything that still isn't a parseable URL.
          let norm = v; if (!/^https?:\/\//i.test(norm)) norm = 'https://' + norm.replace(/^\/+/, '');
          try { new URL(norm); } catch (_) { sfx('bad'); setMsg('that doesn\'t look like a URL', 'bad'); return; }
          if (inp) inp.value = norm;
          sfx('click');
          setMsg('saved — probing endpoint…', '');
          Promise.resolve(h.setBaseUrl ? h.setBaseUrl(norm, row.provider) : null).then(() => {
            invalidateProviderHealth(row.provider);
            // HONEST reachability check against the REAL endpoint — never claim connected without proof. probeProvider
            // round-trips /api/providers/probe; the same probe result feeds the provider card badge cache.
            if (!h.probeProvider) { setMsg('saved', 'ok'); return; }
            return h.probeProvider(row.provider).then(pr => {
              providerHealth[row.provider] = pr || null;   // keep the card badges consistent with this probe
              if (pr && pr.reachable) setMsg(pr.credentialVerified ? '✓ endpoint reachable · credentials verified' : '✓ endpoint reachable — not verified', 'ok');
              else setMsg('✕ endpoint unreachable' + (pr && pr.error ? ' — ' + pr.error : ''), 'bad');
            });
          }).catch(() => setMsg('✕ could not reach the sidecar to apply', 'bad'));
        } else if (act === 'save') {
          const inp = body.querySelector('#key-in-' + i);
          const v = inp ? inp.value.trim() : '';
          if (!v) { sfx('bad'); return; }
          if (h.setKey) h.setKey(v, row.provider);
          invalidateProviderHealth(row.provider);
          notify('✓ updated ' + provName(row.provider) + ' API key — ' + keyStoreClause(), 'good');
          if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();   // keep the dock's no-key warning honest after an edit
          if (typeof KeyCTA !== 'undefined' && KeyCTA.refresh) KeyCTA.refresh();
          rerender('settings');
        } else if (act === 'rm') {
          // a KEYLESS custom row has no key to clear — its REMOVE disconnects the endpoint itself (setBaseUrl('')),
          // otherwise the armed confirm would "remove" nothing and the row would immortally re-render.
          const keylessCustomRm = row.provider === 'custom' && !row.key && !!row.baseUrl;
          if (b.dataset.armed) {
            if (keylessCustomRm && h.setBaseUrl) { h.setBaseUrl('', 'custom'); notify('removed the custom endpoint — add it again anytime from the CUSTOM card', 'warn'); }
            else { if (h.setKey) h.setKey('', row.provider); notify('removed ' + provName(row.provider) + ' key — paste a new one here to reconnect', 'warn'); }
            invalidateProviderHealth(row.provider); if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect(); if (typeof KeyCTA !== 'undefined' && KeyCTA.refresh) KeyCTA.refresh(); sfx('bad'); rerender('settings'); return;
          }
          // Arm: make the destructive state impossible to miss — filled --bad button + pulse, red hairline on the row,
          // and an inline "click again to confirm" hint. Disarms after 5s, restoring the calm state.
          const rowEl = b.closest('.key-row');
          b.dataset.armed = '1'; b.textContent = '✕ CONFIRM'; b.classList.add('armed'); sfx('bad');
          if (rowEl) rowEl.classList.add('rm-armed');
          let hint = b.parentElement && b.parentElement.querySelector('.rm-hint');
          if (!hint && b.parentElement) { hint = document.createElement('span'); hint.className = 'rm-hint'; hint.textContent = 'click again to confirm removal'; b.parentElement.appendChild(hint); }
          const disarm = () => { if (!b.isConnected) return; delete b.dataset.armed; b.textContent = '✕ REMOVE'; b.classList.remove('armed'); if (rowEl) rowEl.classList.remove('rm-armed'); const hn = b.parentElement && b.parentElement.querySelector('.rm-hint'); if (hn) hn.remove(); };
          setTimeout(disarm, 4000);   // one shared disarm window (ArmConfirm.DEFAULT_TIMEOUT); this site keeps bespoke logic for its row hairline + hint
        }
      });
    });
    // Enter submits the SAVE/ADD button inside the SAME .key-edit (per-row; also covers the empty-state reconnect input).
    body.querySelectorAll('.key-input').forEach(inp => inp.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const btn = inp.closest('.key-edit').querySelector('button');
      if (btn) btn.click();
    }));
  }

  /* ============== SETTINGS — connections + real CRT / theme / audio toggles ============== */
  function wireProviderActions(body) {
    // save a pasted key from a NO-KEY card's inline row, reusing the SAME store path as the key list (Harness.setKey).
    const saveInline = (provider) => {
      const h = H();
      const inp = body.querySelector('#prov-key-in-' + provider);   // provider ids are simple slugs — safe to interpolate
      const v = inp ? inp.value.trim() : '';
      if (!v) { sfx('bad'); if (inp) inp.focus(); return; }
      if (!h || !h.setKey) { sfx('bad'); return; }
      h.setKey(v, provider);
      invalidateProviderHealth(provider);
      notify('✓ connected ' + provName(provider) + ' API key — ' + keyStoreClause(), 'good');
      if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();
      if (typeof KeyCTA !== 'undefined' && KeyCTA.refresh) KeyCTA.refresh();
      sfx('click');
      rerender('settings');
    };
    body.querySelectorAll('.prov-card[data-provider]').forEach(card => {
      const activate = () => {
        const h = H();
        const p = card.dataset.provider;
        if (!h || !p || !h.setProv) return;
        h.setProv(p);
        notify('selected ' + provName(p) + ' provider', 'good');
        sfx('click');
        rerender('settings');
      };
      // FIRST sign-in for a keyless device-code provider (grok/kimi) — the card-local twin of the key-row's
      // ⏼ RE-SIGN-IN, driving the SAME shared engine (OAuthSignIn.for). stopPropagation: the card click selects.
      const oauthSignin = card.querySelector('[data-act="prov-oauth-signin"]');
      if (oauthSignin) oauthSignin.addEventListener('click', ev => {
        ev.stopPropagation();
        sfx('click');
        const pid = card.dataset.provider;
        const engine = (typeof OAuthSignIn !== 'undefined') ? OAuthSignIn.for(pid) : null;
        if (!engine) return;
        const box = card.querySelector('#prov-oauth-inline-' + pid);
        const st = card.querySelector('#prov-oauth-status-' + pid);
        const code = card.querySelector('#prov-oauth-code-' + pid);
        const open = card.querySelector('#prov-oauth-open-' + pid);
        if (box) { box.hidden = false; box.addEventListener('click', e2 => e2.stopPropagation()); }
        engine.start({
          onRequesting: () => { if (st) st.textContent = 'requesting a sign-in code…'; },
          onError: msg => { if (st) st.textContent = msg; sfx('bad'); },
          onTimeout: () => { if (st) st.textContent = 'sign-in timed out — hit ⏼ SIGN IN to start again'; },
          onCode: c => {
            if (code) { code.textContent = c.user_code; code.hidden = false; }
            if (st) st.innerHTML = 'enter this code at <b>' + esc(c.verification_uri) + '</b> (opening it now)…';
            if (open) { open.hidden = false; open.onclick = e2 => { e2.stopPropagation(); sfx('click'); openExternal(c.verification_uri); }; }
            openExternal(c.verification_uri);
          },
          onConnected: () => {
            // the sidecar just exchanged + persisted fresh tokens — that POLL answer is backend truth.
            // codex keeps its own literal status state (source-lock pinned); grok/kimi live in the shared cache.
            if (pid === 'codex') { codexStatusKnown = { connected: true, expired: false, reason: '' }; refreshCodexConnectionStatus(); }
            else { oauthStatus[pid] = { connected: true, expired: false, reason: '' }; refreshOAuthStatus(pid); }
            notify('✓ signed in to ' + provName(pid) + ' — your agents can run on your subscription', 'good');
            if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();
            if (typeof KeyCTA !== 'undefined' && KeyCTA.refresh) KeyCTA.refresh();
            rerender('settings');
          }
        });
      });
      // clicks on the inline key controls must NOT bubble up to provider-select — they toggle/save the key row.
      const inlineToggle = card.querySelector('[data-act="prov-add-toggle"]');
      const inlineSave = card.querySelector('[data-act="prov-add-save"]');
      const inlineEdit = card.querySelector('.prov-key-edit');
      const inlineInput = card.querySelector('.key-input');
      if (inlineToggle) inlineToggle.addEventListener('click', ev => {
        ev.stopPropagation();
        if (inlineEdit) { inlineEdit.hidden = !inlineEdit.hidden; if (!inlineEdit.hidden && inlineInput) inlineInput.focus(); }
        sfx('click');
      });
      if (inlineSave) inlineSave.addEventListener('click', ev => { ev.stopPropagation(); saveInline(card.dataset.provider); });
      if (inlineInput) {
        inlineInput.addEventListener('click', ev => ev.stopPropagation());   // don't select the provider when focusing the field
        inlineInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); saveInline(card.dataset.provider); } });
      }
      card.addEventListener('click', ev => {
        // ignore clicks that originated inside the inline key row (handled above)
        if (ev.target.closest && ev.target.closest('.prov-key-edit, [data-act="prov-add-toggle"]')) return;
        activate();
      });
      card.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        if (ev.target !== card) return;   // let the inline input/buttons handle their own keys
        ev.preventDefault();
        activate();
      });
    });
  }

  // display a USD amount for the spend readout / cap echo. Whole-cent granularity for readability (the ledger
  // itself keeps micro-dollar precision; this is presentation only). No app-wide formatter exists to reuse.
  function fmtUsd(v) { return U.usd(v); }   // canonical spend formatter (util.js U.usd)

  // open a URL in the user's real browser (Tauri shell when packaged, a new tab otherwise). Buying credits is
  // ALWAYS an external link — this app never renders a payment form or handles card data.
  function openExternal(url) {
    if (!url) return;
    try {
      const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
      if (invoke) { invoke('open_external_url', { url }).catch(() => { try { window.open(url, '_blank', 'noopener'); } catch (_) {} }); return; }
    } catch (_) {}
    try { window.open(url, '_blank', 'noopener'); } catch (_) {}
  }

  // Open an interactive sign-in / consent URL and report whether it ACTUALLY opened, so callers can keep
  // their "waiting for sign-in…" copy + status poll honest (truthful-telemetry law: never claim a window
  // exists when it doesn't). Two worlds:
  //   • Desktop (Tauri): a raw window.open silently fails under the window policy, so hand the URL to the OS
  //     browser via open_external_url — a real awaitable success/fail. No window.open fallback here: on desktop
  //     that IS the failing path, so a reject means the browser genuinely didn't open — say so, don't pretend.
  //   • Browser: window.open opens a popup, but returns null when popup-blocked — that null is the honest signal.
  // Returns { opened, where:'browser'|'popup', win } — win is the popup handle (browser only) for a later close().
  async function openSignIn(url) {
    if (!url) return { opened: false, where: 'popup', win: null };
    try {
      const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
      if (invoke) {
        try { await invoke('open_external_url', { url }); return { opened: true, where: 'browser', win: null }; }
        catch (_) { return { opened: false, where: 'browser', win: null }; }
      }
    } catch (_) {}
    let win = null;
    try { win = window.open(url, 'starnet_oauth', 'width=540,height=720'); } catch (_) {}
    return { opened: !!win, where: 'popup', win };
  }

  // STORE / MANAGED CREDITS — populate #credits-store from the real /api/credits payload. The endpoint 404s unless
  // a credits backend is configured, so an UNconfigured install renders NOTHING here (no dead STORE, no fake balance
  // — the honesty law). Balance + history are read from the adapter; PURCHASE opens the external buy page.
  function wireCredits(body) {
    const host = body.querySelector('#credits-store');
    if (!host) return;
    host.innerHTML = '';   // stay empty until we KNOW credits are configured
    Harness.api.get('/api/credits')
      .then(j => {
        if (!j || !j.configured) return;   // unconfigured → no surface at all
        const bal = (j.balanceUsd == null) ? '—' : fmtUsd(j.balanceUsd);
        const reach = j.reachable === false;
        const hist = Array.isArray(j.history) ? j.history : [];
        const rows = hist.length ? hist.slice(0, 12).map(e => {
          const when = e && e.ts ? new Date(e.ts).toLocaleString() : '';
          const kind = esc(String((e && e.kind) || 'entry'));
          const amt = (e && e.usd != null) ? fmtUsd(e.usd) : '';
          return '<div class="mc-row"><div class="mc-top"><b>' + kind + '</b> <span class="dim">' + esc(when) + '</span></div>' +
            '<div class="mc-url dim">' + esc(amt) + (e && e.runId ? ' · run ' + esc(String(e.runId).slice(0, 8)) : '') + '</div></div>';
        }).join('') : '<div class="fb-empty">No credit activity yet.</div>';
        host.innerHTML =
          '<h4 class="ms-h">STORE <span class="dim">— managed credits</span></h4>' +
          '<p class="set-about">This station runs on <b>managed credits</b> — a prepaid balance the operator tops up, so your agents can work without you bringing your own provider key. Each run reserves up to your <b>PER RUN</b> budget and refunds whatever it doesn’t spend. You can always switch to your own key under API KEYS above.</p>' +
          '<div class="set-row"><span class="dim">BALANCE</span><b class="credits-bal" style="margin-left:auto">' + esc(bal) + '</b></div>' +
          (reach ? '<div class="set-row dim">⚠ the credits service didn’t answer — the balance shown may be stale.</div>' : '') +
          '<div class="mc-acts">' +
            '<button class="bb sm" id="credits-buy">＋ ADD CREDITS ↗</button>' +
            '<button class="bb xs" id="credits-refresh" title="re-read the balance">↻ REFRESH</button>' +
          '</div>' +
          '<div class="mc-hint">Adding credits opens your browser — StarNet never handles your payment details.</div>' +
          '<div class="set-row"><span class="dim">RECENT ACTIVITY</span></div>' +
          '<div class="mc-list">' + rows + '</div>';
        const buy = host.querySelector('#credits-buy');
        if (buy) buy.addEventListener('click', () => { sfx('click'); openExternal(j.purchaseUrl); });
        const ref = host.querySelector('#credits-refresh');
        if (ref) ref.addEventListener('click', () => { sfx('click'); wireCredits(body); });
      })
      .catch(() => {});   // sidecar offline / not configured → leave the STORE absent
  }

  // BUDGET panel — read the live caps + real spend from the sidecar, fill the four inputs, wire SAVE / RESET.
  // Caps persist server-side and apply live; this is the ONLY UI for money limits (previously env-var-only).
  const BG_KEYS = ['perRun', 'perAgent', 'perDay', 'global'];
  function wireBudget(body) {
    const form = body.querySelector('#budget-form');
    if (!form) return;
    const spendEl = body.querySelector('#budget-spend');
    const msgEl = body.querySelector('#budget-msg');
    const saveBtn = body.querySelector('#bg-save');
    const resetBtn = body.querySelector('#bg-reset');
    const inputOf = k => body.querySelector('#bg-' + k);
    // .msg is red by default; the `ok` modifier turns it gold. So a success passes ok=true, an error passes nothing.
    const setMsg = (t, ok) => { if (msgEl) { msgEl.textContent = t || ''; msgEl.className = 'msg' + (ok ? ' ok' : ''); } };
    // paint the inputs + spend readout + reset visibility from a /api/budget/status payload.
    const paint = (st) => {
      const caps = (st && st.caps) || {};
      const saved = (st && st.saved) || {};
      const envd = (st && st.envDefaults) || {};
      BG_KEYS.forEach(k => {
        const el = inputOf(k); if (!el) return;
        // show the EFFECTIVE cap (persisted-or-env). An empty string can't represent "0 = no cap", so always fill.
        // Truthful precedence: a value the user SAVED wins (never show the env default over a real saved cap — the
        // status payload's `caps` can be clobbered by the governor's pool-only shape, dropping perRun/perAgent), then
        // the effective `caps` value, then the flat `perRun` back-compat field, then the env default.
        const v = (typeof saved[k] === 'number') ? saved[k]
          : (typeof caps[k] === 'number') ? caps[k]
          : (k === 'perRun' && typeof st.perRun === 'number') ? st.perRun
          : (typeof envd[k] === 'number' ? envd[k] : 0);
        el.value = String(v);
        // annotate whether this value is a saved override or the env default (honest, non-blocking). Visible badge +
        // hover title. Truthful precedence: a saved value WINS here (env is only the fallback default, never an
        // override that silences a saved cap), so the badge says "environment default" — not "ignored".
        const savedHere = Object.prototype.hasOwnProperty.call(saved, k);
        el.title = savedHere ? 'saved on this machine' : 'environment default (not yet saved here)';
        const badge = body.querySelector('#bg-src-' + k);
        if (badge) {
          badge.textContent = savedHere ? 'saved here' : 'environment default';
          badge.title = savedHere ? 'you saved this limit on this machine' : 'follows the environment default until you save your own value here';
          badge.classList.toggle('src-env', !savedHere);
          badge.classList.toggle('src-saved', savedHere);
          badge.hidden = false;
        }
      });
      const anySaved = BG_KEYS.some(k => Object.prototype.hasOwnProperty.call(saved, k));
      if (resetBtn) resetBtn.style.display = anySaved ? '' : 'none';
      if (spendEl) {
        const today = fmtUsd(st && st.spentToday), life = fmtUsd(st && st.lifetime);
        const runs = (st && typeof st.runs === 'number') ? st.runs : 0;
        spendEl.innerHTML = 'SPENT TODAY <b>' + today + '</b> &nbsp;·&nbsp; LIFETIME <b>' + life + '</b> <span class="dim">(' + runs + ' run' + (runs === 1 ? '' : 's') + ')</span>';
      }
      paintPools(st);
    };
    // Soft-pool truth + the one-click RESUME. /api/budget/status carries the governor's live pool reads
    // (day/global: {usd, cap, base} — null when ungoverned). A pool is HIT when spend reached its session cap;
    // before this surface a hit pool silently refused every new run and the station just read as dead.
    // POST /api/budget/resume grants one more base-cap of headroom for the rest of the session (server-enforced).
    const poolsEl = body.querySelector('#budget-pools');
    const paintPools = (st) => {
      if (!poolsEl) return;
      poolsEl.textContent = '';
      for (const scope of ['day', 'global']) {
        const p = st && st[scope];
        if (!p || typeof p.usd !== 'number' || typeof p.cap !== 'number' || !(p.cap > 0)) continue;   // ungoverned — nothing to claim
        if (p.usd < p.cap) continue;   // headroom left — the inputs above already tell the story
        const row = document.createElement('div');
        row.className = 'set-row bg-pool-hit';
        const label = scope === 'day' ? 'DAY POOL' : 'GLOBAL POOL';
        const txt = document.createElement('span');
        txt.innerHTML = label + ' CAP HIT — <b>' + fmtUsd(p.usd) + '</b> of <b>' + fmtUsd(p.cap) + '</b>. New runs are paused by the governor.';
        const btn = document.createElement('button');
        btn.className = 'bb sm';
        btn.textContent = 'RESUME (+' + fmtUsd(p.base) + ' headroom)';
        btn.title = 'grant one more base-cap of ' + scope + ' headroom for the rest of this session';
        btn.addEventListener('click', () => {
          btn.disabled = true; setMsg('resuming…');
          Harness.api.post('/api/budget/resume', { scope })
            .then(({ ok, j }) => {
              if (!ok) { setMsg((j && j.error) || 'could not resume'); sfx('bad'); btn.disabled = false; return; }
              setMsg('✓ ' + scope + ' pool resumed — runs may continue this session', true); sfx('click');
              refresh();   // repaint pools + spend from the server truth (the hit row clears only when the governor says so)
            })
            .catch(() => { setMsg('could not reach the sidecar'); sfx('bad'); btn.disabled = false; });
        });
        row.appendChild(txt); row.appendChild(btn);
        poolsEl.appendChild(row);
      }
    };
    const refresh = () => Harness.api.get('/api/budget/status').then(paint)
      .catch(() => { if (spendEl) spendEl.textContent = 'spend unavailable'; });   // never paint an error body as $0 spend
    refresh();
    if (saveBtn) saveBtn.addEventListener('click', () => {
      const payload = {};
      for (const k of BG_KEYS) {
        const el = inputOf(k); if (!el) continue;
        const raw = String(el.value).trim();
        if (raw === '') { payload[k] = 0; continue; }   // blank -> "no cap" (0), matching the placeholder semantics
        const n = Number(raw);
        if (!isFinite(n) || n < 0) { setMsg(k + ': enter a number ≥ 0 (leave blank or 0 for no cap)'); sfx('bad'); el.focus(); return; }
        payload[k] = n;
      }
      setMsg('saving…');
      Harness.api.post('/api/budget/caps', payload)
        .then(({ ok, j }) => {
          if (!ok) { setMsg((j && j.error) || 'could not save limits'); sfx('bad'); return; }
          paint(j); setMsg('✓ limits saved & applied', true); sfx('click');
        })
        .catch(() => { setMsg('could not reach the sidecar'); sfx('bad'); });
    });
    if (resetBtn) resetBtn.addEventListener('click', () => {
      // clear every saved override -> each cap falls back to its env default, live.
      const payload = {}; BG_KEYS.forEach(k => { payload[k] = null; });
      setMsg('resetting…');
      Harness.api.post('/api/budget/caps', payload)
        .then(({ ok, j }) => { if (!ok) { setMsg((j && j.error) || 'reset failed'); sfx('bad'); return; } paint(j); setMsg('✓ reset to environment defaults', true); sfx('click'); })
        .catch(() => { setMsg('could not reach the sidecar'); sfx('bad'); });
    });
  }

  // MODELS panel (P0-3) — the ordered FALLBACK CHAIN the loop walks when the primary model fails mid-run.
  // Server-persisted (/api/fallback/chain) + applied live; env SKYNET_FALLBACK_MODELS stays the default until
  // saved. Editing is local (add from catalog / remove / reorder) until SAVE posts the whole ordered list.
  function wireFallbackChain(body) {
    const form = body.querySelector('#fbc-form');
    if (!form) return;
    const listEl = body.querySelector('#fbc-list');
    const addSel = body.querySelector('#fbc-add');
    const msgEl = body.querySelector('#fbc-msg');
    const saveBtn = body.querySelector('#fbc-save');
    const resetBtn = body.querySelector('#fbc-reset');
    const maxEl = body.querySelector('#fbc-max');
    const setMsg = (t, ok) => { if (msgEl) { msgEl.textContent = t || ''; msgEl.className = 'msg' + (ok ? ' ok' : ''); } };
    let chain = [];          // the WORKING copy being edited (posted whole on SAVE)
    let savedFlag = false;   // is the server chain a saved override (vs env default)?
    let maxEntries = 8;
    const paint = () => {
      if (maxEl) maxEl.textContent = String(maxEntries);
      if (resetBtn) resetBtn.style.display = savedFlag ? '' : 'none';
      if (!listEl) return;
      if (!chain.length) {
        listEl.innerHTML = '<div class="fbc-row dim">— no fallback: if the model fails, the run fails —</div>';
      } else {
        listEl.innerHTML = chain.map((id, i) =>
          '<div class="fbc-row" data-i="' + i + '">' +
            '<span class="fbc-ord">' + (i + 1) + '.</span>' +
            '<span class="fbc-id" title="' + esc(id) + '">' + esc(id) + '</span>' +
            '<button class="bb xs" data-act="up" title="try this model earlier"' + (i === 0 ? ' disabled' : '') + '>▲</button>' +
            '<button class="bb xs" data-act="dn" title="try this model later"' + (i === chain.length - 1 ? ' disabled' : '') + '>▼</button>' +
            '<button class="bb xs" data-act="rm" title="remove from the chain">✕</button>' +
          '</div>').join('');
      }
      // annotate the source honestly, mirroring the Budget panel's saved-vs-env truthfulness
      listEl.title = savedFlag ? 'saved on this machine' : 'environment default (not yet saved here)';
      listEl.querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', () => {
        const i = Number(b.closest('.fbc-row').dataset.i);
        const act = b.dataset.act;
        if (act === 'rm') chain.splice(i, 1);
        else if (act === 'up' && i > 0) { const t = chain[i - 1]; chain[i - 1] = chain[i]; chain[i] = t; }
        else if (act === 'dn' && i < chain.length - 1) { const t = chain[i + 1]; chain[i + 1] = chain[i]; chain[i] = t; }
        sfx('click'); paint();
      }));
    };
    const applyStatus = (st) => {
      chain = Array.isArray(st && st.chain) ? st.chain.slice() : [];
      savedFlag = !!(st && st.saved);
      if (st && typeof st.maxEntries === 'number') maxEntries = st.maxEntries;
      paint();
    };
    Harness.api.get('/api/fallback/chain').then(applyStatus)
      .catch(() => { if (listEl) listEl.innerHTML = '<div class="fbc-row dim">chain unavailable — sidecar unreachable</div>'; });   // never paint an error body as an empty chain
    // catalog for the ADD picker — the same warmed OpenRouter catalog the model dock uses. Best-effort: an empty
    // catalog just leaves the picker with its placeholder (the chain itself still paints + saves fine).
    Harness.api.get('/api/models/openrouter').then(j => {
      if (!addSel || !j || !Array.isArray(j.models)) return;
      const frag = document.createDocumentFragment();
      j.models.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))).forEach(m => {
        if (!m || !m.id) return;
        const o = document.createElement('option');
        o.value = m.id; o.textContent = (m.name && m.name !== m.id) ? (m.name + '  ·  ' + m.id) : m.id;
        frag.appendChild(o);
      });
      addSel.appendChild(frag);
    }).catch(() => {});
    if (addSel) addSel.addEventListener('change', () => {
      const id = addSel.value; addSel.value = '';
      if (!id) return;
      if (chain.indexOf(id) >= 0) { setMsg('already in the chain'); sfx('bad'); return; }
      if (chain.length >= maxEntries) { setMsg('the chain holds at most ' + maxEntries + ' models'); sfx('bad'); return; }
      chain.push(id); setMsg(''); sfx('click'); paint();
    });
    const post = (models, okText) => {
      setMsg('saving…');
      Harness.api.post('/api/fallback/chain', { models: models })
        .then(({ ok, j }) => {
          if (!ok) { setMsg((j && j.error) || 'could not save the chain'); sfx('bad'); return; }
          applyStatus(j);
          const warn = (j && j.warnings && j.warnings.length) ? ' — not in the catalog (kept anyway): ' + j.warnings.join(', ') : '';
          setMsg('✓ ' + okText + warn, true); sfx('click');
        })
        .catch(() => { setMsg('could not reach the sidecar'); sfx('bad'); });
    };
    if (saveBtn) saveBtn.addEventListener('click', () => post(chain, 'chain saved & applied'));
    if (resetBtn) resetBtn.addEventListener('click', () => post(null, 'reset to environment default'));
  }

  // CLASS TIER MODELS (Class Loadouts S3) — the three tier->model pins the summon path (app.resolveTierModel)
  // reads. Persisted in localStorage under the SAME key app.js reads (starnet.tierModels.v1) so there's no new
  // plumbing between the two IIFEs. The selects are filled from the live OpenRouter catalog (same source the
  // fallback-chain picker uses); an empty value means "(station default)" — the tier inherits the model dock.
  const TIER_MODELS_KEY = 'starnet.tierModels.v1';
  const TM_TIERS = ['reasoning', 'balanced', 'fast'];
  function readTierModels() {
    try { const m = JSON.parse(localStorage.getItem(TIER_MODELS_KEY) || '{}'); return (m && typeof m === 'object') ? m : {}; }
    catch (_) { return {}; }
  }
  function writeTierModels(m) { try { localStorage.setItem(TIER_MODELS_KEY, JSON.stringify(m || {})); } catch (_) {} }
  function wireTierModels(body) {
    const form = body.querySelector('#tm-form');
    if (!form) return;
    const msgEl = body.querySelector('#tm-msg');
    const setMsg = (t, ok) => { if (msgEl) { msgEl.textContent = t || ''; msgEl.className = 'msg' + (ok ? ' ok' : ''); } };
    const map = readTierModels();
    const selOf = tier => body.querySelector('#tm-' + tier);
    // paint the saved pin onto each select (an unknown/stale id is added as an option so it still shows honestly).
    const paint = () => TM_TIERS.forEach(tier => {
      const sel = selOf(tier); if (!sel) return;
      const want = String(map[tier] || '');
      if (want && !Array.prototype.some.call(sel.options, o => o.value === want)) {
        const o = document.createElement('option'); o.value = want; o.textContent = want + '  ·  (not in catalog)'; sel.appendChild(o);
      }
      sel.value = want;
    });
    paint();
    // fill the model catalog into all three selects (same warmed catalog the fallback picker uses).
    Harness.api.get('/api/models/openrouter').then(j => {
      if (!j || !Array.isArray(j.models)) return;
      const opts = j.models.slice().filter(m => m && m.id).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      TM_TIERS.forEach(tier => {
        const sel = selOf(tier); if (!sel) return;
        const frag = document.createDocumentFragment();
        opts.forEach(m => { const o = document.createElement('option'); o.value = m.id; o.textContent = (m.name && m.name !== m.id) ? (m.name + '  ·  ' + m.id) : m.id; frag.appendChild(o); });
        sel.appendChild(frag);
      });
      paint();   // re-apply the saved value now the real options exist
    }).catch(() => {});
    TM_TIERS.forEach(tier => {
      const sel = selOf(tier); if (!sel) return;
      sel.addEventListener('change', () => {
        const v = String(sel.value || '').trim();
        if (v) map[tier] = v; else delete map[tier];
        writeTierModels(map); sfx('click');
        setMsg(v ? ('✓ ' + tier.toUpperCase() + '-class agents will summon on ' + v) : ('✓ ' + tier.toUpperCase() + ' follows the station default'), true);
      });
    });
  }

  // P1-8 NOTIFICATION PREFS — persist per-category on/off + sound to store.settings.notifyPrefs (localStorage);
  // notify() reads it live at emit time, so a toggle takes effect on the very next notification with no rerender.
  function wireNotifyPrefs(body) {
    const s = store.settings;
    if (!s.notifyPrefs) s.notifyPrefs = notifyDefaults();
    const bind = (id, key) => { const el = body.querySelector(id); if (el) el.addEventListener('change', ev => { s.notifyPrefs[key] = !!ev.target.checked; save(); sfx('click'); flashSaved(body.querySelector('#notifs-msg')); }); };
    bind('#ntp-runComplete', 'runComplete');
    bind('#ntp-needsApproval', 'needsApproval');
    bind('#ntp-cronDigest', 'cronDigest');
    bind('#ntp-sound', 'sound');
    const test = body.querySelector('#ntp-test');
    if (test) test.addEventListener('click', () => notify('test notification — this is what a ping looks like', 'good', 'runComplete'));
  }

  // P1-9 ADVANCED runtime knobs — fetch the server's current + effective values, render an editable form, POST
  // saved overrides. Precedence (env > saved > default) is enforced + reported by the sidecar; the UI just shows
  // whether a field is env-locked (read-only + a note) or a saved override.
  const ADV_FIELDS = [
    { key: 'maxIters', label: 'MAX ITERATIONS', hint: 'tool-turns a single run may take before it stops. Higher = deeper multi-step work; more spend.', min: 1, max: 200, step: 1 },
    { key: 'maxConcurrentAgents', label: 'MAX CONCURRENT AGENTS', hint: 'how many agents may run paid loops at once. 0 = unlimited.', min: 0, max: 32, step: 1 },
    { key: 'consentTimeoutMs', label: 'CONSENT TIMEOUT (MS)', hint: 'how long a permission prompt waits for your answer before auto-denying (so a run never hangs).', min: 5000, max: 600000, step: 1000 },
    { key: 'cronTickMs', label: 'ROUTINE TICK (MS)', hint: 'how often the scheduler checks for due routines.', min: 5000, max: 600000, step: 1000 }
  ];
  function wireAdvanced(body) {
    const form = body.querySelector('#adv-form');
    const msgEl = body.querySelector('#adv-msg');
    if (!form) return;
    const setMsg = (t, ok) => { if (msgEl) { msgEl.textContent = t || ''; msgEl.className = 'msg' + (ok ? ' ok' : ''); } };
    const render = (st) => {
      const fields = (st && st.fields) || {};
      form.innerHTML = ADV_FIELDS.map(f => {
        const d = fields[f.key] || {};
        const envLocked = !!d.envLocked;
        const val = (d.effective != null) ? d.effective : (d.default != null ? d.default : '');
        const note = envLocked ? '<span class="dim"> — locked by an environment variable</span>'
          : (d.saved != null ? '<span class="dim"> — saved override</span>' : '<span class="dim"> — default</span>');
        return '<div class="set-row"><label for="adv-' + f.key + '">' + f.label + note + '</label>' +
          '<input id="adv-' + f.key + '" class="key-input adv-in" data-key="' + f.key + '" type="number" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + esc(String(val)) + '"' + (envLocked ? ' disabled' : '') + '></div>' +
          '<div class="mc-hint">' + esc(f.hint) + '</div>';
      }).join('') +
        '<div class="mc-acts"><button class="bb sm" id="adv-save">SAVE</button>' +
        '<button class="bb xs" id="adv-reset" title="clear every saved override so these follow the environment / built-in defaults again">RESET TO DEFAULTS</button></div>';
      const saveBtn = form.querySelector('#adv-save');
      if (saveBtn) saveBtn.addEventListener('click', () => {
        const payload = {};
        for (const f of ADV_FIELDS) {
          const el = form.querySelector('#adv-' + f.key); if (!el || el.disabled) continue;
          const raw = String(el.value).trim();
          if (raw === '') { payload[f.key] = null; continue; }   // blank -> clear override
          const n = Number(raw);
          if (!isFinite(n) || n < f.min || n > f.max) { setMsg(f.label + ': enter ' + f.min + '–' + f.max); sfx('bad'); el.focus(); return; }
          payload[f.key] = Math.floor(n);
        }
        setMsg('saving…');
        Harness.api.post('/api/runtime/knobs', payload)
          .then(({ ok, j }) => {
            if (!ok) { setMsg((j && j.error) || 'could not save'); sfx('bad'); return; }
            render(j); setMsg('✓ saved (some limits apply on next restart)', true); sfx('click');
          }).catch(() => { setMsg('could not reach the sidecar'); sfx('bad'); });
      });
      const resetBtn = form.querySelector('#adv-reset');
      if (resetBtn) resetBtn.addEventListener('click', () => {
        const payload = {}; ADV_FIELDS.forEach(f => { payload[f.key] = null; });
        setMsg('resetting…');
        Harness.api.post('/api/runtime/knobs', payload)
          .then(({ ok, j }) => { if (!ok) { setMsg('reset failed'); sfx('bad'); return; } render(j); setMsg('✓ reset to defaults', true); sfx('click'); })
          .catch(() => { setMsg('could not reach the sidecar'); sfx('bad'); });
      });
    };
    Harness.api.get('/api/runtime/knobs').then(render)
      .catch(() => { form.innerHTML = '<div class="dim">runtime settings unavailable</div>'; });   // never render an error body as knobs
  }

  // P1-7 STATION BACKUP — export/import the whole station config to one JSON file. Export bundles the browser-owned
  // slices (settings/autonomy/notifyPrefs) with the server-side stores; import applies server sections + restores
  // the browser slices locally, then surfaces "re-enter your key" states the server flags. Secrets never travel.
  // T3.9 — COPY DIAGNOSTICS: fetch the sidecar-assembled, secret-free report and put it on the clipboard. The
  // Diag module (frontend/app/diagnostics.js) owns the fetch/copy/notify; here we just wire the button + flash it.
  function wireDiagnostics(body) {
    const btn = body.querySelector('#diag-copy');
    const msgEl = body.querySelector('#diag-msg');
    // P1.5: surface one honest build-provenance line "build <version> @ <commit>[ DIRTY]". Diag.buildLine() returns
    // '' in browser mode (no Tauri binary) — we then leave the element hidden, never faking a commit for a session
    // that wasn't built from any binary. Defensive: Diag may be absent in a stripped build.
    (function paintBuild() {
      const el = body.querySelector('#diag-build');
      if (!el || typeof Diag === 'undefined' || typeof Diag.buildLine !== 'function') return;
      Diag.buildLine().then(line => { if (line) { el.textContent = line; el.hidden = false; } }).catch(() => {});
    })();
    if (!btn) return;
    const setMsg = (t, ok) => { if (msgEl) { msgEl.textContent = t || ''; msgEl.className = 'msg' + (ok ? ' ok' : ''); } };
    btn.addEventListener('click', () => {
      if (typeof Diag === 'undefined' || !Diag.copy) { setMsg('diagnostics unavailable', false); return; }
      btn.disabled = true; sfx('click');
      Diag.copy({ notify: false }).then(ok => {
        btn.disabled = false;
        // Name the support address only when one is really configured (Diag.supportEmail() gates out the unset/
        // placeholder case); otherwise just confirm the copy — never point a user at a fake/placeholder address.
        const diagDest = (typeof Diag !== 'undefined' && Diag.supportEmail) ? Diag.supportEmail() : '';
        setMsg(ok ? (diagDest ? ('✓ copied — paste it into an email to ' + diagDest) : '✓ copied — paste it into a bug report') : 'copy failed — try again', ok);
        // Clipboard-failure fallback: if Lane A's on-screen renderer is present, show the report block so the user can
        // select-and-copy it by hand. Defensive: the helper may not exist in this build yet — keep current behavior then.
        // (Orchestrator reconciles the exact API at merge.)
        if (!ok && typeof Diag !== 'undefined' && typeof Diag.showBlock === 'function') {
          try { Diag.showBlock(body.querySelector('#diag-block') || body); } catch (_) {}
        }
      });
    });
  }

  function wireBackup(body) {
    const msgEl = body.querySelector('#bk-msg');
    const setMsg = (t, ok) => { if (msgEl) { msgEl.textContent = t || ''; msgEl.className = 'msg' + (ok ? ' ok' : ''); } };
    const exportBtn = body.querySelector('#bk-export');
    const importBtn = body.querySelector('#bk-import');
    const fileIn = body.querySelector('#bk-file');
    // gather the browser-owned slices the sidecar can't see (localStorage).
    const browserSections = () => {
      const out = { settings: {
        theme: store.settings.theme, themeHue: store.settings.themeHue,
        themeSat: store.settings.themeSat, themeGlow: store.settings.themeGlow,
        flicker: store.settings.flicker,
        sound: store.settings.sound, keepComputerAwake: store.settings.keepComputerAwake
      }, notifyPrefs: Object.assign({}, store.settings.notifyPrefs || notifyDefaults()) };
      try { if (typeof AutonomyStore !== 'undefined' && AutonomyStore.exportState) out.autonomy = AutonomyStore.exportState(); } catch (_) {}
      return out;
    };
    if (exportBtn) exportBtn.addEventListener('click', () => {
      setMsg('building export…');
      Harness.api.post('/api/config/export', { sections: browserSections() })
        .then(({ ok, status, j: env }) => {   // never download an error body as a "backup"
          if (!ok) throw new Error('http ' + status);
          const blob = new Blob([JSON.stringify(env, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const stamp = new Date().toISOString().slice(0, 10);
          a.href = url; a.download = 'starnet-station-' + stamp + '.json';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          setMsg('✓ exported (secrets excluded — re-enter keys after importing)', true); sfx('sale');
        }).catch(() => { setMsg('export failed'); sfx('bad'); });
    });
    if (importBtn && fileIn) {
      importBtn.addEventListener('click', () => fileIn.click());
      fileIn.addEventListener('change', () => {
        const f = fileIn.files && fileIn.files[0]; if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          let env; try { env = JSON.parse(String(reader.result || '')); } catch (_) { setMsg('that is not a valid StarNet backup file'); sfx('bad'); fileIn.value = ''; return; }
          setMsg('importing…');
          Harness.api.post('/api/config/import', { envelope: env })
            .then(({ ok, j }) => {
              fileIn.value = '';
              if (!ok) { setMsg((j && j.error) || 'import failed'); sfx('bad'); return; }
              // restore the browser-owned slices locally.
              const b = (j && j.browser) || {};
              if (b.settings) { Object.assign(store.settings, b.settings); }
              if (b.notifyPrefs) { store.settings.notifyPrefs = Object.assign(notifyDefaults(), b.notifyPrefs); }
              save(); applySettings();
              try { if (b.autonomy && typeof AutonomyStore !== 'undefined' && AutonomyStore.importState) AutonomyStore.importState(b.autonomy); } catch (_) {}
              // GROWTH Tier 3: an import is a NON-DIAL posture writer — reconcile the earned-rung record against
              // the imported rung (a diverged record is retired; user override wins), so a stale earned record can
              // never later demote FROM a rung the dial isn't even at (the silent-escalation blocker).
              try { if (typeof TrustStore !== 'undefined' && TrustStore.onManualInitiative && typeof AutonomyStore !== 'undefined' && AutonomyStore.get) TrustStore.onManualInitiative((AutonomyStore.get() || {}).initiative); } catch (_) {}
              const need = (j && j.secretsNeeded) || [];
              const needTxt = need.length ? ' — re-enter secrets for: ' + need.map(n => n.id || n.kind).join(', ') : '';
              setMsg('✓ imported ' + ((j.applied || []).length) + ' section' + (((j.applied || []).length) === 1 ? '' : 's') + needTxt, true);
              sfx('level');
              rerender('settings');   // repaint so the imported budgets/chains/prefs show
            }).catch(() => { setMsg('could not reach the sidecar'); sfx('bad'); });
        };
        reader.readAsText(f);
      });
    }
  }

  function buildSettings(body) {
    refreshCodexConnectionStatus();
    refreshExtraOAuthStatus();   // the same live-status probe for the other keyless sign-ins (grok/kimi)
    refreshKeychainMode();   // learn keychain-vs-browser once, so the key-save confirmation can name the real store
    const s = store.settings;
    const awakeDesktop = !!(typeof KeepAwake !== 'undefined' && KeepAwake.isDesktop && KeepAwake.isDesktop());
    const awakeChecked = awakeDesktop && !!s.keepComputerAwake;
    const lifecycleDesktop = !!(typeof Lifecycle !== 'undefined' && Lifecycle.isDesktop && Lifecycle.isDesktop());
    if (!s.notifyPrefs) s.notifyPrefs = notifyDefaults();   // defensive: an old save may predate P1-8
    const npf = k => s.notifyPrefs[k] !== false;            // per-category checked-state (default on)
    // ── SECTION FRAGMENTS ──────────────────────────────────────────────────────────────────
    // Each fragment is the EXACT markup the monolithic panel used, regrouped under a console section.
    // The inner <h4 class="ms-h"> sub-headers stay (they read as sub-labels within a section and every
    // settings test source-locks them). mountConsole builds these panes once and returns a content host
    // that spans them all, so the wireX calls below reach every control with no per-section rewire.
    const secProviders =
      // NB: no inner "PROVIDERS" heading — the console section head already prints PROVIDERS above the pane
      // (a second identical h4 read as a duplicated title in sys-settings.png).
      '<div class="prov-list">' + providersHtml() + '</div>' +
      '<h4 class="ms-h">API KEYS</h4>' +
      '<div class="key-list">' + keysHtml() + '</div>' +
      '<p class="set-about">Keys live locally on this machine and are sent only to the STARNET sidecar (127.0.0.1) per request — never anywhere else. They are shown masked; the full secret is never displayed. (The shipped desktop build moves keys behind the OS keychain.)</p>' +
      // STORE / MANAGED CREDITS — rendered ONLY when the sidecar reports a configured credits backend (/api/credits).
      // When credits aren't wired this stays an empty node (no dead card, no fake balance — the honesty law). wireCredits
      // fetches the real balance + history and the external purchase link; buying opens a browser tab, never an in-app form.
      '<div id="credits-store"></div>';
    const secAutonomy =
      // AUTONOMY — the "alive between sessions" dial: two independent axes (autonomy.js). Reuses the theme-picker
      // button idiom (.set-themes/.set-theme) so it needs no new CSS. The live describe() line keeps it honest.
      '<h4 class="ms-h">AUTONOMY <span class="dim">— how much it runs on its own while you’re away</span></h4>' +
      '<p class="set-about" id="auto-desc">' + esc((typeof AutonomyStore !== 'undefined' && AutonomyStore.describe) ? AutonomyStore.describe() : '') + '</p>' +
      '<div class="set-row"><span class="dim">INITIATIVE — does it start work on its own</span></div>' +
      '<div class="set-themes" id="auto-init">' +
        '<button class="set-theme" data-init="wait" title="nothing runs unless you ask">WAIT</button>' +
        '<button class="set-theme" data-init="propose" title="lines up suggestions you approve — never acts on its own">SUGGEST</button>' +
        '<button class="set-theme" data-init="leash" title="does a few small grounded jobs a day on its own">BUILD</button>' +
        '<button class="set-theme" data-init="free" title="picks &amp; does work toward your goals while you’re away">FREE</button>' +
      '</div>' +
      '<div class="set-row"><span class="dim">REACH — how far an unattended action may go</span></div>' +
      '<div class="set-themes" id="auto-reach">' +
        '<button class="set-theme" data-reach="observe" title="read / research only — writes nothing">OBSERVE</button>' +
        '<button class="set-theme" data-reach="sandbox" title="build &amp; write locally — nothing leaves the machine">SANDBOX</button>' +
        '<button class="set-theme" data-reach="reach" title="the highest rung: unattended actions may leave the machine — send, publish, or contact external services">SEND &amp; PUBLISH</button>' +
      '</div>' +
      '<div class="set-row"><span class="dim">PACE — how many unattended jobs per day</span></div>' +
      '<div class="set-themes" id="auto-pace">' +
        '<button class="set-theme" data-pace="1" title="one small job a day">LIGHT</button>' +
        '<button class="set-theme" data-pace="3" title="a few small jobs a day — the default">STANDARD</button>' +
        '<button class="set-theme" data-pace="6" title="a busier station — up to 6 jobs a day">BUSY</button>' +
        '<button class="set-theme" data-pace="12" title="as much as it&#39;s allowed — up to 12 jobs a day">MAX</button>' +
      '</div>' +
      // DIRECTION (autonomy-tuning 2026-07-17) — the dial says HOW MUCH it may run on its own; this block says
      // WHERE that work should go. Same server truth the Night Shift panel reads (GET/POST/DELETE
      // /api/nightshift/focus + POST/DELETE /api/nightshift/avoid) — one directive, surfaced where the user tunes
      // autonomy, so "tune it" and "aim it" live together. Every line maps to a route field; the cold states are
      // honest, never an invented priority or a fake learned profile.
      '<div class="set-row"><span class="dim">DIRECTION — where its unattended work should go</span></div>' +
      '<div class="set-row"><span class="dim">FOCUS</span> <span id="auto-focus" class="dim">…</span></div>' +
      '<div class="set-row"><input id="auto-steer" class="key-input" type="text" autocomplete="off" placeholder="point it at a project folder, thread:&lt;id&gt;, or goal"><button class="bb xs" id="auto-steer-set">STEER</button><button class="bb xs" id="auto-steer-clear" style="display:none">CLEAR</button></div>' +
      '<div class="mc-hint">a steer outranks learned evidence (~7 days, or until cleared). It only redirects the unattended priority — no new access.</div>' +
      '<div class="set-row"><span class="dim">OFF-LIMITS — it will never pick these on its own</span></div>' +
      '<div class="key-list" id="auto-avoid"><p class="set-about">reading directives…</p></div>' +
      '<div class="set-row"><input id="auto-avoid-ref" class="key-input" type="text" autocomplete="off" placeholder="a project folder, thread:&lt;id&gt;, or goal to rule out"><button class="bb xs" id="auto-avoid-add">RULE OUT</button></div>' +
      '<div class="mc-hint">off-limits holds until you remove it. You can still work there yourself — it only stops the station choosing it unattended.</div>' +
      '<div class="set-row"><span class="dim">LEARNED INTERESTS — what it thinks you keep coming back to</span></div>' +
      '<div class="key-list" id="auto-interests"><p class="set-about">reading interests…</p></div>' +
      // LIVE HELPERS — the real background sub-agents (team.spawn) running RIGHT NOW, from GET /api/subagents
      // (server truth; the floor's ghost sprites are the same ledger). STOP rides POST /api/subagents/interrupt —
      // before this row a runaway helper could not be stopped from anywhere in the UI.
      '<div class="set-row"><span class="dim">LIVE HELPERS — background sub-agents running now</span></div>' +
      '<div class="key-list" id="auto-helpers"><p class="set-about">reading helpers…</p></div>';
    const secNightShift =
      // NIGHT SHIFT — the honest live status of the server-owned night shift (NS-4). Every line maps to a field of
      // GET /api/nightshift/status + /api/autonomy/ledger; painted live from the routes (never invented). The
      // decision trail is the scrollable recent act/decline log. Loading/error states are honest, never fake-zero.
      '<h4 class="ms-h">NIGHT SHIFT <span class="dim">— works on its own whenever you stop using the station</span></h4>' +
      // THE AWAY RULE, up front (clarity fix 2026-07-15): "away" read as "app closed" and the panel made no sense.
      // Painted from panelModel.awayRuleText (the sidecar's REAL idle threshold — never a hardcoded number).
      '<p class="set-about" id="ns-awayrule"></p>' +
      '<div class="set-row"><span class="dim">STATE</span> <span id="ns-state" class="dim">…</span></div>' +
      '<p class="set-about" id="ns-why"></p>' +
      // MODE — build-vs-draft honesty (status.buildMode/draftReason) + the cold-start readiness bars, so a station
      // that is running but degraded (drafts only / still learning) SAYS so instead of silently doing less.
      '<div class="set-row"><span class="dim">MODE</span> <span id="ns-mode" class="dim">…</span></div>' +
      '<p class="set-about" id="ns-readiness"></p>' +
      // FOCUS (NS-5b) — what the night will chase, and the STEER that lets the Commander redirect it. The readout
      // maps to status.focus (server truth); the steer rides GET/POST/DELETE /api/nightshift/focus. A steer only
      // re-ranks the night's ONE priority — it grants nothing and reaches nothing new (route-enforced).
      '<div class="set-row"><span class="dim">FOCUS</span> <span id="ns-focus" class="dim">…</span></div>' +
      '<div class="set-row"><input id="ns-steer" class="key-input" type="text" autocomplete="off" placeholder="point it at a project folder, or type what to focus on"><button class="bb xs" id="ns-steer-set">STEER</button><button class="bb xs" id="ns-steer-clear" style="display:none">CLEAR</button></div>' +
      '<div class="mc-hint">a steer outranks learned evidence (~7 days, or until cleared). It only redirects the night’s one priority — no new access.</div>' +
      // row labels de-jargoned (UX sweep 2026-07-15): LEASH/LAST BEAT/NEXT ELIGIBLE assumed the internal
      // vocabulary; a "beat" is just one small unattended job (glossary carries the term for the value text).
      '<div class="set-row"><span class="dim" data-hint="beat">DAILY LIMIT</span> <span id="ns-leash" class="dim">…</span></div>' +
      '<div class="set-row"><span class="dim" data-hint="beat">LAST JOB</span> <span id="ns-last" class="dim">…</span></div>' +
      '<div class="set-row"><span class="dim">NEXT JOB EARLIEST</span> <span id="ns-next" class="dim">…</span></div>' +
      '<div class="set-row"><span class="dim">RECENT DECISIONS</span></div>' +
      '<div class="key-list" id="ns-trail"><p class="set-about">reading the decision trail…</p></div>' +
      // LAST REPORT (NS visibility 2026-07-13) — the morning-report beat is one-shot (fired=true spends it even on
      // dismiss, and vanish() loses the digest). This re-composes the most recent night's digest ON DEMAND from the
      // SAME routes (status + ledger + drafts) via the pure engine — server truth, never a cached frontend copy.
      '<div class="set-row"><button class="bb sm" id="ns-report-btn">▤ LAST REPORT</button></div>' +
      '<div id="ns-report"></div>';
    const secPermissions =
      // PERMISSIONS — the OS-style standing-grant panel (permissions.js / permissionsstore.js). The LEVEL row is
      // the simple "never → fully autonomous" chooser (sets the posture preset AND the write grant together); the
      // grant list shows + revokes every standing capability. #perm-desc spells out the COMBINED truth, live.
      '<h4 class="ms-h">PERMISSIONS <span class="dim">— what it’s actually allowed to do on its own</span></h4>' +
      '<p class="set-about" id="perm-desc"></p>' +
      // ONE ladder, one vocabulary (UX sweep 2026-07-15): these four rungs ARE the AUTONOMY dial's rungs
      // (Permissions.PLANS maps 1:1 onto the dial presets) — so they carry the SAME primary words the dial uses.
      // Stored data-level values are unchanged; only the labels unify. FULLY AUTONOMOUS stays in the label
      // (test-pinned, and it says the stakes plainly).
      '<div class="set-row"><span class="dim">LEVEL — the same WAIT / SUGGEST / BUILD / FREE ladder as AUTONOMY</span></div>' +
      '<div class="set-themes" id="perm-level">' +
        '<button class="set-theme" data-level="never" title="does nothing on its own — you drive everything">WAIT</button>' +
        '<button class="set-theme" data-level="suggest" title="lines up ideas you approve — never acts on its own">SUGGEST</button>' +
        '<button class="set-theme" data-level="draft" title="acts on its own and leaves drafts — writes no files">BUILD (DRAFTS)</button>' +
        '<button class="set-theme" data-level="full" title="acts AND writes real files on its own — logged &amp; reversible">FREE (FULLY AUTONOMOUS)</button>' +
      '</div>' +
      '<div class="set-row"><span class="dim">STANDING APPROVALS — every capability it may use unattended, when you granted it, and a REVOKE for each (revocable any time)</span></div>' +
      '<div class="key-list" id="perm-grants"></div>';
    const secBudget =
      // BUDGET — the four real USD spend caps the sidecar enforces over the ledger (perRun hard stop + soft
      // per-agent / per-day / global pools). Persisted server-side + applied live; a live spend readout below.
      '<h4 class="ms-h">BUDGET <span class="dim">— real USD spend limits</span></h4>' +
      '<p class="set-about">Hard money limits your agents cannot exceed. Enforced by the sidecar against the real spend ledger. <b>Leave blank or 0 for no cap.</b> Saved here on this machine; until you save, each limit follows its environment default.</p>' +
      '<div id="budget-spend" class="set-row dim">reading spend…</div>' +
      '<div id="budget-pools"></div>' +   // soft-pool cap state + the one-click RESUME (only rendered when a pool is actually hit)
      '<div class="mc-form" id="budget-form">' +
        '<div class="set-row"><label for="bg-perRun">PER RUN <span class="src-badge" id="bg-src-perRun" hidden></span></label><input id="bg-perRun" class="key-input bg-cap" type="number" min="0" step="0.01" inputmode="decimal" autocomplete="off" placeholder="blank or 0 = no cap"></div>' +
        '<div class="mc-hint">Hard ceiling for a single agent run. The run stops the moment it would exceed this.</div>' +
        '<div class="set-row"><label for="bg-perAgent">PER AGENT <span class="src-badge" id="bg-src-perAgent" hidden></span></label><input id="bg-perAgent" class="key-input bg-cap" type="number" min="0" step="0.01" inputmode="decimal" autocomplete="off" placeholder="blank or 0 = no cap"></div>' +
        '<div class="mc-hint">Lifetime cap on any one agent’s total spend across all its runs.</div>' +
        '<div class="set-row"><label for="bg-perDay">PER DAY <span class="src-badge" id="bg-src-perDay" hidden></span></label><input id="bg-perDay" class="key-input bg-cap" type="number" min="0" step="0.01" inputmode="decimal" autocomplete="off" placeholder="blank or 0 = no cap"></div>' +
        '<div class="mc-hint">Total spend across every agent in a rolling 24-hour window.</div>' +
        '<div class="set-row"><label for="bg-global">GLOBAL <span class="src-badge" id="bg-src-global" hidden></span></label><input id="bg-global" class="key-input bg-cap" type="number" min="0" step="0.01" inputmode="decimal" autocomplete="off" placeholder="blank or 0 = no cap"></div>' +
        '<div class="mc-hint">All-time ceiling across everything. The last line of defence.</div>' +
        '<div class="mc-acts">' +
          '<button class="bb sm" id="bg-save">SAVE LIMITS</button>' +
          '<button class="bb xs" id="bg-reset" title="clear the saved value so this cap follows the environment default again" style="display:none">RESET TO DEFAULTS</button>' +
        '</div>' +
      '</div>' +
      '<div id="budget-msg" class="msg"></div>';
    const secModels =
      // MODELS — the ordered FALLBACK CHAIN (P0-3). The primary model is chosen live in the COMMS model dock; this
      // sets what the loop tries NEXT if that model fails mid-run. Persisted server-side + applied live to every run
      // path (browser, cron, channels); env SKYNET_FALLBACK_MODELS is the default until you save one here.
      '<h4 class="ms-h">MODELS <span class="dim">— fallback chain</span></h4>' +
      '<p class="set-about">Your primary model is set in the COMMS model dock. If it <b>fails mid-run</b> — the provider is overloaded (502/503), errors (500), the model is unknown (404), or your key hits a rate-limit / billing / auth wall — the loop retries the same turn on the <b>next model in this list</b>, in order, instead of dying. A failover shows a <b>⤳ failover</b> notice + a LOGBOOK line so you can see it happen. Empty = no fallback. Saved here on this machine; the default comes from the environment.</p>' +
      '<div class="mc-form" id="fbc-form">' +
        '<div id="fbc-list" class="mc-list-fb"><div class="dim">reading chain…</div></div>' +
        '<div class="set-row"><select id="fbc-add" class="fbc-sel"><option value="">＋ add a model from the catalog…</option></select></div>' +
        '<div class="mc-hint">Order is the retry order — the loop walks it top-to-bottom. Up to <span id="fbc-max">8</span> models. Unknown ids are allowed (the catalog can be stale) but flagged.</div>' +
        '<div class="mc-acts">' +
          '<button class="bb sm" id="fbc-save">SAVE CHAIN</button>' +
          '<button class="bb xs" id="fbc-reset" title="clear the saved chain so it follows the environment default again" style="display:none">RESET TO DEFAULT</button>' +
        '</div>' +
      '</div>' +
      '<div id="fbc-msg" class="msg"></div>' +
      // CLASS TIER MODELS (Class Loadouts S3) — map each class clearance tier to a concrete model. A class's
      // model is a TIER indirection (DEEP / BALANCED / FAST); when summoned it resolves through this map. Left
      // at "(station default)" a tier inherits the model dock's primary, so this is purely opt-in. Saved per-machine
      // (localStorage) and read live by the summon path (app.resolveTierModel) — no rerun/rebuild needed.
      '<h4 class="ms-h">CLASS TIER MODELS <span class="dim">— which model each class clearance summons on</span></h4>' +
      '<p class="set-about">Every class carries a clearance <b>tier</b> — ◆◆◆ DEEP, ◆◆ BALANCED, or ◆ FAST. When you summon one, the tier resolves to a real model here. Leave a tier on <b>(station default)</b> and it inherits your primary model from the COMMS model dock. Pin a tier to give every DEEP-class agent a stronger model and every FAST-class agent a cheaper one, automatically. Saved on this machine; you can still re-pin any single agent afterward in its dossier.</p>' +
      '<div class="mc-form" id="tm-form">' +
        '<div class="set-row"><label for="tm-reasoning">◆◆◆ DEEP</label><select id="tm-reasoning" class="fbc-sel" data-tier="reasoning"><option value="">(station default)</option></select></div>' +
        '<div class="set-row"><label for="tm-balanced">◆◆ BALANCED</label><select id="tm-balanced" class="fbc-sel" data-tier="balanced"><option value="">(station default)</option></select></div>' +
        '<div class="set-row"><label for="tm-fast">◆ FAST</label><select id="tm-fast" class="fbc-sel" data-tier="fast"><option value="">(station default)</option></select></div>' +
        '<div class="mc-hint">A pin applies to the next agent you summon of that tier. Empty = follow the model dock. This never overrides a model you set on a specific agent.</div>' +
      '</div>' +
      '<div id="tm-msg" class="msg"></div>';
    const customSw = deriveCustomTheme(s.themeHue, s.themeSat, 100)['--ph'];   // swatch tint for the CUSTOM chip
    const secAppearance =
      '<h4 class="ms-h">PHOSPHOR THEME</h4><div class="set-themes">' +
      THEMES.map(([t, c]) => '<button class="set-theme ' + (s.theme === t ? 'sel' : '') + '" aria-pressed="' + (s.theme === t ? 'true' : 'false') + '" data-t="' + t + '" style="--sw:' + c + '">' + t.toUpperCase() + '</button>').join('') +
      '<button class="set-theme ' + (s.theme === 'custom' ? 'sel' : '') + '" aria-pressed="' + (s.theme === 'custom' ? 'true' : 'false') + '" data-t="custom" id="set-theme-custom" style="--sw:' + customSw + '">CUSTOM</button>' +
      '</div>' +
      // CUSTOM PHOSPHOR — hue + saturation derive a full palette live (moving either switches to CUSTOM);
      // GLOW is independent and scales the bloom on EVERY theme, presets included. All instant-save.
      '<h4 class="ms-h">CUSTOM PHOSPHOR <span class="dim">— dial in any colour</span></h4>' +
      '<p class="set-about">Drag <b>HUE</b> or <b>SATURATION</b> to derive your own phosphor — the whole station recolours live. <b>GLOW</b> tames or boosts the CRT bloom on any theme, including the presets. 100% is the shipped look.</p>' +
      '<label class="set-slider"><span class="set-slider-name">HUE</span><input type="range" id="set-hue" class="set-hue-track" min="0" max="359" step="1" value="' + clampN(s.themeHue, 0, 359, 35) + '"><span class="set-slider-val" id="set-hue-val">' + clampN(s.themeHue, 0, 359, 35) + '°</span></label>' +
      '<label class="set-slider"><span class="set-slider-name">SATURATION</span><input type="range" id="set-sat" min="0" max="100" step="1" value="' + clampN(s.themeSat, 0, 100, 100) + '"><span class="set-slider-val" id="set-sat-val">' + clampN(s.themeSat, 0, 100, 100) + '%</span></label>' +
      '<label class="set-slider"><span class="set-slider-name">GLOW</span><input type="range" id="set-glow" min="0" max="150" step="5" value="' + clampN(s.themeGlow, 0, 150, 100) + '"><span class="set-slider-val" id="set-glow-val">' + clampN(s.themeGlow, 0, 150, 100) + '%</span></label>' +
      '<h4 class="ms-h">DISPLAY</h4>' +
      // TEXT SIZE — the laptop-readability dial (2026-07-19): scales every panel, window and COMMS
      // face together; the station view re-renders sharp at the new scale (world.js resize).
      '<div class="set-row"><span class="dim">TEXT SIZE — AUTO matches this screen; scales all panels &amp; COMMS, the station view stays crisp</span></div>' +
      '<div class="set-themes" id="set-textsize">' +
      TEXT_SCALES.map(([v, name]) => {
        const cur = Number(s.textScale) || 0;
        const title = v === 0 ? 'match this screen — currently ' + autoTextScale() + '%' : v + '%';
        return '<button class="set-theme ' + (cur === v ? 'sel' : '') + '" aria-pressed="' + (cur === v ? 'true' : 'false') + '" data-ts="' + v + '" title="' + title + '">' + name + '</button>';
      }).join('') +
      '</div>' +
      '<label class="set-row"><input type="checkbox" id="set-flicker" ' + (s.flicker ? 'checked' : '') + '> SCREEN FLICKER</label>' +
      // TERMINAL AUDIO is a sound control, not a display one — its own header (it also gates notification chimes).
      '<h4 class="ms-h">SOUND</h4>' +
      '<label class="set-row"><input type="checkbox" id="set-sound" ' + (s.sound ? 'checked' : '') + '> TERMINAL AUDIO <span class="dim">— UI &amp; notification sounds</span></label>' +
      '<span class="msg" id="appearance-msg" aria-live="polite"></span>';
    const secNotifs =
      // NOTIFICATIONS — per-category on/off + a notification sound toggle (P1-8). Each is HONORED at emit time in
      // notify(): a muted category is dropped before it ever reaches the panel/toast (not decorative).
      '<h4 class="ms-h">NOTIFICATIONS <span class="dim">— what pings you, and whether it chimes</span></h4>' +
      '<p class="set-about">Turn off a category to stop those pings (panel + toast). Everything defaults on. A muted category is dropped at the source — nothing important is silently swallowed.</p>' +
      '<label class="set-row"><input type="checkbox" id="ntp-runComplete"' + (npf('runComplete') ? ' checked' : '') + '> RUN COMPLETE <span class="dim">— a run saved or made something</span></label>' +
      '<label class="set-row"><input type="checkbox" id="ntp-needsApproval"' + (npf('needsApproval') ? ' checked' : '') + '> NEEDS APPROVAL <span class="dim">— an agent is waiting on your yes/no</span></label>' +
      '<label class="set-row"><input type="checkbox" id="ntp-cronDigest"' + (npf('cronDigest') ? ' checked' : '') + '> AUTONOMOUS DIGEST <span class="dim">— what it did while you were away</span></label>' +
      '<label class="set-row"><input type="checkbox" id="ntp-sound"' + (npf('sound') ? ' checked' : '') + '> NOTIFICATION SOUND <span class="dim">— a chime on each ping (also needs TERMINAL AUDIO on)</span></label>' +
      // CLEAR NOTIFICATIONS lives WITH the notification controls (it was buried in SYSTEM ›  STATION DATA). Armed
      // 2-click confirm + a "cleared ✓" line so the wipe answers "did that stick?".
      '<div class="set-save"><button class="bb xs" id="ntp-test">TEST NOTIFICATION</button>' +
        '<button class="bb sm danger" id="set-clear">CLEAR NOTIFICATIONS</button></div>' +
      '<span class="msg" id="notifs-msg" aria-live="polite"></span>';
    const secSystem =
      // "POWER" — this header held only KEEP COMPUTER AWAKE, so "SCHEDULED TASKS" mislabelled it.
      '<h4 class="ms-h">POWER</h4>' +
      '<label class="set-row"><input type="checkbox" id="set-awake" ' + (awakeChecked ? 'checked' : '') + (awakeDesktop ? '' : ' disabled') + '> KEEP COMPUTER AWAKE <span class="dim">— ' + (awakeDesktop ? 'prevent idle sleep while StarNet is open' : 'desktop app only') + '</span></label>' +
      // Lane 4D — LAUNCH AT LOGIN (opt-in, default OFF) + the honest background-lifecycle explainer. Both are
      // desktop-only; the checkbox is disabled and the line names the browser reality otherwise. The explainer
      // is filled live from the tray supervisor's REAL armed state (wireLifecycle) so it never over-claims.
      '<label class="set-row"><input type="checkbox" id="set-autostart" disabled> LAUNCH AT LOGIN <span class="dim">— ' + (lifecycleDesktop ? 'start StarNet automatically when you sign in' : 'desktop app only') + '</span></label>' +
      '<p class="set-about" id="lifecycle-desc">' + (lifecycleDesktop ? 'Checking what runs in the background…' : 'In the desktop app, closing the window keeps the station running only when armed work (routines, connected channels, or the night shift) needs it — otherwise closing fully quits. This browser tab has no background process.') + '</p>' +
      // ADVANCED — env-only runtime knobs, now editable + persisted server-side (P1-9). PRECEDENCE is spelled out
      // in the card: an explicit environment variable ALWAYS wins over a value saved here (a deploy stays in control).
      '<h4 class="ms-h">ADVANCED <span class="dim">— runtime limits (usually leave these alone)</span></h4>' +
      '<p class="set-about">Tuning knobs that were environment-only. Saved here on this machine and read by the sidecar at boot. <b>An environment variable always overrides a value saved here</b> — a locked-down deploy stays in control. Blank a field to clear the override (follow the environment / built-in default again).</p>' +
      '<div class="mc-form" id="adv-form"><div class="dim" id="adv-loading">reading runtime settings…</div></div>' +
      '<div id="adv-msg" class="msg"></div>' +
      // DATA / STATION BACKUP — export the whole station config to one JSON file, import it back, reset a section.
      // Secrets NEVER leave the machine (configexport.js redacts to a configured-marker); import surfaces re-enter states.
      '<h4 class="ms-h">STATION BACKUP <span class="dim">— export / import your setup</span></h4>' +
      '<p class="set-about">Save your whole station configuration — settings, budgets, model chains, connectors (without secrets), autonomy, placed-agent metadata — to one JSON file, and load it back on another machine. <b>Your keys and tokens are never included</b>; after importing you re-enter them once. A shareable station recipe.</p>' +
      '<div class="set-save">' +
        '<button class="bb sm" id="bk-export">EXPORT STATION</button>' +
        '<button class="bb sm" id="bk-import">IMPORT STATION…</button>' +
        '<input type="file" id="bk-file" accept="application/json,.json" style="display:none">' +
      '</div>' +
      '<div id="bk-msg" class="msg"></div>' +
      ((typeof Updates !== 'undefined' && Updates.settingsHtml) ? Updates.settingsHtml() : '') +
      // DIAGNOSTICS (T3.9) — one click copies a paste-ready, SECRET-FREE report to email in a bug report. The sidecar
      // assembles + sanitizes it (GET /api/diagnostics); this button just fetches + copies. Destination is ONE constant
      // (Diag.SUPPORT_EMAIL) so it's a one-line swap when the support address is picked. Copy stays honest about where it goes.
      '<h4 class="ms-h">DIAGNOSTICS <span class="dim">— for a bug report</span></h4>' +
      // Name the support address only when Diag reports one is configured; when it's unset/placeholder we omit
      // the "email to X" clause entirely (no placeholder, no fake address) — the copy button still works.
      ((function () {
        const dest = (typeof Diag !== 'undefined' && Diag.supportEmail) ? Diag.supportEmail() : '';
        const lead = dest
          ? ('If something breaks, copy a <b>diagnostic readout</b> and paste it into an email to <b>' + esc(dest) + '</b>. ')
          : 'If something breaks, copy a <b>diagnostic readout</b> and paste it into your bug report. ';
        return '<p class="set-about">' + lead +
          'It carries your app version, platform, provider &amp; model, and the tail of recent errors — ' +
          '<b>never your keys, tokens, messages, or prompts</b>. Assembled and scrubbed by the local sidecar.</p>';
      })()) +
      '<div class="set-save"><button class="bb sm" id="diag-copy">⧉ COPY DIAGNOSTICS</button></div>' +
      '<div id="diag-msg" class="msg"></div>' +
      // P1.5 build provenance — the git commit this desktop binary was compiled from. Hidden until resolved (and
      // stays hidden in a plain browser, where there is no binary to prove). Populated in wireDiagnostics().
      '<div id="diag-build" class="dim" style="margin-top:6px;font-size:11px" hidden></div>' +
      // CLEAR NOTIFICATIONS moved to the NOTIFICATIONS section (where it belongs); this is now just the about note.
      '<h4 class="ms-h">ABOUT</h4>' +
      '<p class="set-about">STARNET — gamified AI-agent harness.<br>Theme, display & audio preferences are saved locally on this machine. Manage workstreams from the TASK BOARD or the COMMS rail.</p>';

    const frag = html => (el => { el.innerHTML = html; });  // curried: fill a pane element with a fragment
    const sections = [
      { id: 'providers', label: 'PROVIDERS', glyph: '⌁', desc: 'Which AI services can run, and the API keys they use — stored on this machine only.', build: frag(secProviders) },
      { id: 'autonomy', label: 'AUTONOMY', glyph: '◈', desc: 'How far your agents may act on their own between your messages — the initiative, reach, and pace dials.', build: frag(secAutonomy) },
      { id: 'nightshift', label: 'NIGHT SHIFT', glyph: '☾', desc: 'What the station is doing unattended right now, and its recent decision trail.', build: frag(secNightShift) },
      { id: 'permissions', label: 'PERMISSIONS', glyph: '⊘', desc: 'The standing approvals that let an agent act unattended — grant or revoke each one.', build: frag(secPermissions) },
      { id: 'budget', label: 'BUDGET', glyph: '$', desc: 'Hard USD spend caps the sidecar enforces against the real ledger.', build: frag(secBudget) },
      { id: 'models', label: 'MODELS', glyph: '⇄', desc: 'The fallback chain — what the loop retries on if your primary model fails mid-run.', build: frag(secModels) },
      { id: 'appearance', label: 'APPEARANCE', glyph: '☀', desc: 'Phosphor colour, CRT effects, and terminal sound.', build: frag(secAppearance) },
      { id: 'notifs', label: 'NOTIFICATIONS', glyph: '◔', desc: 'What pings you while you work, and whether it chimes.', build: frag(secNotifs) },
      { id: 'system', label: 'SYSTEM', glyph: '⚙', desc: 'Keep-awake, advanced runtime limits, station backup, and updates.', build: frag(secSystem) }
    ];
    const host = mountConsole(body, 'settings', sections, { search: true, searchPlaceholder: 'search settings…' });

    wireProviderActions(host);
    wireKeyActions(host);
    queueProviderHealthRefresh();
    wireCredits(host);
    wireBudget(host);
    wireFallbackChain(host);
    wireTierModels(host);
    wireNotifyPrefs(host);
    wireAdvanced(host);
    wireBackup(host);
    wireDiagnostics(host);
    const appMsg = () => host.querySelector('#appearance-msg');
    // switch theme in place — applySettings repaints via the body class; do NOT rerender (it would wipe an open key editor).
    const hueIn = host.querySelector('#set-hue'), satIn = host.querySelector('#set-sat'), glowIn = host.querySelector('#set-glow');
    const sliderVal = (id, txt) => { const e = host.querySelector(id); if (e) e.textContent = txt; };
    const syncCustomChip = () => { const c = host.querySelector('#set-theme-custom'); if (c) c.style.setProperty('--sw', deriveCustomTheme(s.themeHue, s.themeSat, 100)['--ph']); };
    const syncThemeSelection = theme => host.querySelectorAll('[data-t]').forEach(x => {
      const selected = x.dataset.t === theme;
      x.classList.toggle('sel', selected);
      x.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    host.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => {
      s.theme = b.dataset.t;
      // a preset click snaps the CUSTOM hue/sat sliders to a matching start point (GLOW is an
      // independent display dial and survives theme switches on purpose).
      const hs = PRESET_HS[s.theme];
      if (hs) {
        s.themeHue = hs[0]; s.themeSat = hs[1];
        if (hueIn) hueIn.value = hs[0]; if (satIn) satIn.value = hs[1];
        sliderVal('#set-hue-val', hs[0] + '°'); sliderVal('#set-sat-val', hs[1] + '%');
        syncCustomChip();
      }
      applySettings(); save(); sfx('click');
      syncThemeSelection(s.theme);
      flashSaved(appMsg());
    }));
    // CUSTOM sliders — hue/sat derive live (and switch the theme to CUSTOM); glow applies to any theme.
    // 'input' repaints every drag tick; 'change' persists + flashes once on release.
    const selCustom = () => syncThemeSelection('custom');
    const wireSlider = (input, apply) => {
      if (!input) return;
      input.addEventListener('input', ev => { apply(ev.target.value); applySettings(); });
      input.addEventListener('change', () => { save(); sfx('click'); flashSaved(appMsg()); });
    };
    wireSlider(hueIn, v => { s.theme = 'custom'; s.themeHue = clampN(v, 0, 359, 35); sliderVal('#set-hue-val', s.themeHue + '°'); selCustom(); syncCustomChip(); });
    wireSlider(satIn, v => { s.theme = 'custom'; s.themeSat = clampN(v, 0, 100, 100); sliderVal('#set-sat-val', s.themeSat + '%'); selCustom(); syncCustomChip(); });
    wireSlider(glowIn, v => { s.themeGlow = clampN(v, 0, 150, 100); sliderVal('#set-glow-val', s.themeGlow + '%'); });
    const bind = (id, key) => host.querySelector(id).addEventListener('change', ev => { s[key] = ev.target.checked; applySettings(); save(); flashSaved(appMsg()); });
    bind('#set-flicker', 'flicker'); bind('#set-sound', 'sound');
    // TEXT SIZE chips — instant-apply + persist, same idiom as the theme row above.
    const tsChips = host.querySelectorAll('#set-textsize [data-ts]');
    const syncTextSize = () => tsChips.forEach(x => {
      const on = Number(x.dataset.ts) === (Number(s.textScale) || 0);
      x.classList.toggle('sel', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    tsChips.forEach(b => b.addEventListener('click', () => {
      const v = Number(b.dataset.ts) || 0;
      s.textScale = v === 0 ? 0 : clampN(v, 90, 150, 100);
      applySettings(); save(); sfx('click');
      syncTextSize();
      flashSaved(appMsg());
    }));
    const awakeToggle = host.querySelector('#set-awake');
    if (awakeToggle) awakeToggle.addEventListener('change', ev => {
      const desired = !!ev.target.checked;
      s.keepComputerAwake = desired;
      save();
      sfx('click');
      syncKeepAwake(desired, { force: true }).then(status => {
        if (!desired || !status || status.enabled) return;
        s.keepComputerAwake = false;
        save();
        ev.target.checked = false;
        notify(status.message || 'Keep Computer Awake could not be enabled on this desktop.', 'warn');
        sfx('bad');
      });
    });
    // Lane 4D — LAUNCH AT LOGIN toggle + live background-lifecycle explainer. Desktop-only; both read REAL state
    // (the OS autostart registration and the tray supervisor's armed truth), so neither line ever over-claims.
    if (typeof Lifecycle !== 'undefined' && Lifecycle.isDesktop && Lifecycle.isDesktop()) {
      const autostartToggle = host.querySelector('#set-autostart');
      const lifeDesc = host.querySelector('#lifecycle-desc');
      // Reflect the real OS autostart state onto the checkbox (default OFF; opt-in).
      Lifecycle.autostartStatus().then(st => {
        if (!autostartToggle) return;
        autostartToggle.disabled = false;
        autostartToggle.checked = !!(st && st.enabled);
      }).catch(() => {});
      // Fill the explainer from the tray supervisor's live armed summary — truthful about what survives a close.
      const paintLife = () => {
        if (!lifeDesc) return;
        Lifecycle.status().then(v => {
          if (!v || !v.supervised) { lifeDesc.textContent = 'Closing the window keeps the station running only when armed work needs it — otherwise it fully quits.'; return; }
          if (v.armed) {
            const why = (v.reasons && v.reasons.length) ? v.reasons.join(', ') : 'armed background work';
            lifeDesc.textContent = 'Right now, closing the window KEEPS the station running in the background (' + why + '). Quit fully from the tray icon. Otherwise closing would fully quit.';
          } else {
            lifeDesc.textContent = 'Right now, nothing is armed — closing the window fully quits StarNet (no background process). Arm a routine, connect a channel, or turn on the night shift to keep it running while closed.';
          }
        }).catch(() => { lifeDesc.textContent = 'Closing the window keeps the station running only when armed work needs it — otherwise it fully quits.'; });
      };
      paintLife();
      if (autostartToggle) autostartToggle.addEventListener('change', ev => {
        const desired = !!ev.target.checked;
        sfx('click');
        Lifecycle.setAutostart(desired).then(st => {
          const real = !!(st && st.enabled);
          ev.target.checked = real;
          if (real !== desired) notify('Launch at login could not be ' + (desired ? 'enabled' : 'disabled') + ' on this system.', 'warn');
          else flashSaved(appMsg());
        }).catch(err => {
          ev.target.checked = !desired;
          notify('Launch at login failed: ' + ((err && err.message) || err), 'warn');
          sfx('bad');
        });
      });
    }
    // PERMISSIONS panel repaint hook — set by the permissions block below; called whenever the granular dial
    // changes so the level highlight + #perm-desc stay in sync with the posture. No-op until that block wires it.
    let syncPerm = function () {};
    repaintAutonomyDial = null;   // GROWTH Tier 3: re-armed per settings render (the closure below owns the live DOM)
    // AUTONOMY dial — retune Initiative / Reach in place (AutonomyStore persists; no rerender so it won't wipe an
    // open key editor). The describe() line repaints live so the posture is always honestly spelled out.
    if (typeof AutonomyStore !== 'undefined' && AutonomyStore.summary) {
      const initWrap = host.querySelector('#auto-init'), reachWrap = host.querySelector('#auto-reach'), paceWrap = host.querySelector('#auto-pace'), autoDesc = host.querySelector('#auto-desc');
      // GROWTH Tier 3 — the EARNED badge: when the live initiative rung was RAISED by an accepted trust offer (not a
      // manual set), mark it "EARNED" and expose the honest provenance behind it. A manual set above/below the earned
      // rung is just a user grant/override (no badge) — TrustStore.earnedInitiative() only returns a record when the
      // live rung MATCHES the earned one. Pure read; fail-open (no TrustStore → the pre-Tier-3 dial, unchanged).
      const trustProvText = (pv) => {
        if (!pv) return '';
        const parts = [];
        if (pv.runs) parts.push(pv.runs + ' tasks');
        if (pv.confidence) parts.push(pv.confidence + '% satisfaction');
        if (pv.streak) parts.push(pv.streak + ' approvals in a row');
        let when = '';
        try { if (pv.earnedAt && typeof Permissions !== 'undefined' && Permissions.grantAgeText) when = Permissions.grantAgeText(pv.earnedAt, Date.now()).replace(/^granted /, 'earned '); } catch (_) {}
        return 'EARNED — ' + (parts.length ? parts.join(', ') : 'a demonstrated track record') + (when ? ' · ' + when : '');
      };
      const paintEarned = (a) => {
        if (!initWrap) return;
        let badge = initWrap.parentNode ? initWrap.parentNode.querySelector('.auto-earned') : null;
        const earned = (typeof TrustStore !== 'undefined' && TrustStore.earnedInitiative) ? TrustStore.earnedInitiative() : null;
        // clear any prior EARNED marks on the rung buttons
        initWrap.querySelectorAll('[data-init]').forEach(x => x.classList.remove('earned'));
        if (earned && earned.to === a.initiative) {
          const btn = initWrap.querySelector('[data-init="' + earned.to + '"]');
          if (btn) btn.classList.add('earned');
          if (!badge && initWrap.parentNode) { badge = document.createElement('p'); badge.className = 'set-about auto-earned'; initWrap.parentNode.insertBefore(badge, initWrap.nextSibling); }
          if (badge) { badge.textContent = '◈ ' + trustProvText(earned.provenance); badge.hidden = false; }
        } else if (badge) { badge.hidden = true; badge.textContent = ''; }
      };
      const paintAuto = () => {
        const a = AutonomyStore.summary() || {};
        if (initWrap) initWrap.querySelectorAll('[data-init]').forEach(x => x.classList.toggle('sel', x.dataset.init === a.initiative));
        if (reachWrap) reachWrap.querySelectorAll('[data-reach]').forEach(x => x.classList.toggle('sel', x.dataset.reach === a.reach));
        if (paceWrap) paceWrap.querySelectorAll('[data-pace]').forEach(x => x.classList.toggle('sel', Number(x.dataset.pace) === a.leashPerDay));
        if (autoDesc) autoDesc.textContent = AutonomyStore.describe();
        try { paintEarned(a); } catch (_) {}   // GROWTH Tier 3: the EARNED badge on an earned rung
        try { syncPerm(); } catch (_) {}   // keep the permissions level highlight + blurb in step with the dial
      };
      // a MANUAL set retires the earned record (the user override wins, recorded as such) BEFORE the dial writes —
      // so a set above an earned rung reads as a plain user grant, a set below as a user override (no badge either way).
      if (initWrap) initWrap.querySelectorAll('[data-init]').forEach(b => b.addEventListener('click', () => { try { if (typeof TrustStore !== 'undefined' && TrustStore.onManualInitiative) TrustStore.onManualInitiative(b.dataset.init); } catch (_) {} AutonomyStore.setInitiative(b.dataset.init); paintAuto(); sfx('click'); }));
      if (reachWrap) reachWrap.querySelectorAll('[data-reach]').forEach(b => b.addEventListener('click', () => { AutonomyStore.setReach(b.dataset.reach); paintAuto(); sfx('click'); }));
      if (paceWrap) paceWrap.querySelectorAll('[data-pace]').forEach(b => b.addEventListener('click', () => { AutonomyStore.setLeash(Number(b.dataset.pace)); paintAuto(); sfx('click'); }));
      repaintAutonomyDial = paintAuto;   // GROWTH Tier 3: let an accepted trust offer repaint the open panel's EARNED badge live
      paintAuto();
    }
    // DIRECTION (autonomy-tuning) — focus/steer/off-limits/learned-interests, every value painted from a route's
    // response (server truth, never an optimistic local flip). Shares the Night Shift panel's directive routes so
    // both surfaces always tell the SAME story; interests ride GET /api/scout (evidence-cited or honestly empty).
    {
      const dFocus = host.querySelector('#auto-focus'), dSteer = host.querySelector('#auto-steer'),
            dSteerSet = host.querySelector('#auto-steer-set'), dSteerClear = host.querySelector('#auto-steer-clear'),
            dAvoid = host.querySelector('#auto-avoid'), dAvoidRef = host.querySelector('#auto-avoid-ref'),
            dAvoidAdd = host.querySelector('#auto-avoid-add'), dInterests = host.querySelector('#auto-interests');
      const dMsg = (t) => { if (dFocus) dFocus.textContent = t; };
      // "thread:<id>" and the literal "goal" select their kinds; anything else is a project path (the same grammar
      // as the Night Shift steer box, so the two inputs never disagree).
      const parseRef = (raw) => {
        if (raw.toLowerCase() === 'goal') return { ref: 'goal', kind: 'goal' };
        if (/^thread:/i.test(raw)) return { ref: raw.slice(7).trim(), kind: 'thread' };
        return { ref: raw };
      };
      const paintAvoid = (list) => {
        if (!dAvoid) return;
        if (!Array.isArray(list)) { dAvoid.innerHTML = '<p class="set-about">directives unreachable right now.</p>'; return; }
        if (!list.length) { dAvoid.innerHTML = '<p class="set-about">nothing ruled out — it may pick any trusted project, open thread, or your goal.</p>'; return; }
        dAvoid.textContent = '';
        for (const e of list) {
          const row = document.createElement('div');
          row.className = 'set-row';
          const label = document.createElement('span');
          label.className = 'dim';
          label.textContent = String(e.label || e.ref) + (e.kind !== 'project' ? ' [' + e.kind + ']' : '');
          label.title = String(e.ref);
          const rm = document.createElement('button');
          rm.className = 'bb xs';
          rm.textContent = 'ALLOW AGAIN';
          rm.title = 'remove this boundary — the station may pick it unattended again';
          rm.addEventListener('click', () => {
            rm.disabled = true;
            Harness.api.del('/api/nightshift/avoid?ref=' + encodeURIComponent(e.ref))
              .then(({ ok, j }) => {
                if (!ok || !j || j.ok === false) { label.textContent = String(e.label || e.ref) + ' — could not remove: ' + ((j && j.error) || 'error'); sfx('bad'); rm.disabled = false; return; }
                sfx('click'); refreshDirection();   // repaint from the route's truth
              })
              .catch(() => { label.textContent = String(e.label || e.ref) + ' — could not reach the sidecar'; sfx('bad'); rm.disabled = false; });
          });
          row.appendChild(label); row.appendChild(rm);
          dAvoid.appendChild(row);
        }
      };
      const paintDirection = (j) => {
        if (!j || j.ok === false) { dMsg('directives unreachable right now'); paintAvoid(null); return; }
        const f = j.focus;
        const liveSteer = !!(j.steer && j.steer.ref);
        if (dFocus) {
          if (f && (f.label || f.ref)) {
            const why = Array.isArray(f.why) ? f.why.filter(Boolean).join('; ') : '';
            dFocus.textContent = String(f.label || f.ref) + (liveSteer ? ' · you steered this' : '') + (why ? ' — ' + why : '');
          } else {
            dFocus.textContent = 'none declared — it improvises from evidence';
          }
        }
        if (dSteerClear) dSteerClear.style.display = liveSteer ? '' : 'none';
        paintAvoid(Array.isArray(j.avoid) ? j.avoid : []);
      };
      const refreshDirection = () => {
        Harness.api.get('/api/nightshift/focus').catch(() => null)
          .then(paintDirection);
      };
      if (dSteerSet) dSteerSet.addEventListener('click', () => {
        const raw = dSteer ? String(dSteer.value).trim() : '';
        if (!raw) { dMsg('enter a trusted project path, thread:<id>, or goal'); sfx('bad'); return; }
        dMsg('steering…');
        Harness.api.post('/api/nightshift/focus', parseRef(raw))
          .then(({ ok, j }) => {
            if (!ok || !j || j.ok === false) { dMsg((j && j.error) || 'could not steer'); sfx('bad'); return; }
            if (dSteer) dSteer.value = '';
            sfx('click'); refreshDirection();
          })
          .catch(() => { dMsg('could not reach the sidecar'); sfx('bad'); });
      });
      if (dSteerClear) dSteerClear.addEventListener('click', () => {
        dMsg('clearing…');
        Harness.api.del('/api/nightshift/focus')
          .then(({ ok, j }) => {
            if (!ok || !j || j.ok === false) { dMsg((j && j.error) || 'could not clear the steer'); sfx('bad'); return; }
            sfx('click'); refreshDirection();
          })
          .catch(() => { dMsg('could not reach the sidecar'); sfx('bad'); });
      });
      if (dAvoidAdd) dAvoidAdd.addEventListener('click', () => {
        const raw = dAvoidRef ? String(dAvoidRef.value).trim() : '';
        if (!raw) { sfx('bad'); if (dAvoid) dAvoid.innerHTML = '<p class="set-about">enter a trusted project path, thread:&lt;id&gt;, or goal to rule out.</p>'; return; }
        dAvoidAdd.disabled = true;
        Harness.api.post('/api/nightshift/avoid', parseRef(raw))
          .then(({ ok, j }) => {
            dAvoidAdd.disabled = false;
            if (!ok || !j || j.ok === false) { if (dAvoid) dAvoid.innerHTML = '<p class="set-about">' + esc((j && j.error) || 'could not rule that out') + '</p>'; sfx('bad'); return; }
            if (dAvoidRef) dAvoidRef.value = '';
            sfx('click'); refreshDirection();   // the avoid may have dethroned the focus — repaint both from truth
          })
          .catch(() => { dAvoidAdd.disabled = false; if (dAvoid) dAvoid.innerHTML = '<p class="set-about">could not reach the sidecar.</p>'; sfx('bad'); });
      });
      // LEARNED INTERESTS — GET /api/scout's evidence-cited topic histogram. Every row shows the count it earned
      // and quotes the real activity behind it; an empty histogram renders the honest cold state, never a fake profile.
      const paintInterests = (rows) => {
        if (!dInterests) return;
        if (!Array.isArray(rows)) { dInterests.innerHTML = '<p class="set-about">interests unreachable right now.</p>'; return; }
        if (!rows.length) { dInterests.innerHTML = '<p class="set-about">nothing learned yet — it only counts what you actually work on.</p>'; return; }
        dInterests.textContent = '';
        for (const r of rows.slice(0, 8)) {
          const row = document.createElement('div');
          row.className = 'set-row';
          const label = document.createElement('span');
          label.className = 'dim';
          label.textContent = String(r.label || '') + ' · seen ' + (Number(r.count) || 0) + '×';
          const ev = Array.isArray(r.evidence) ? r.evidence.filter(Boolean) : [];
          if (ev.length) label.title = 'because you said: ' + ev.map(q => '"' + q + '"').join(' · ');
          row.appendChild(label);
          dInterests.appendChild(row);
        }
      };
      Harness.api.get('/api/scout').catch(() => null)
        .then(j => paintInterests(j && Array.isArray(j.interests) ? j.interests : null));
      refreshDirection();
    }
    // LIVE HELPERS — the running team.spawn sub-agents, straight from GET /api/subagents?status=running (server
    // truth: the same ledger the floor's ghost sprites fold). One row per live worker + STOP → POST
    // /api/subagents/interrupt; the list repaints from the ROUTE after every action (never an optimistic flip).
    {
      const list = host.querySelector('#auto-helpers');
      const paintHelpers = (rows) => {
        if (!list) return;
        if (!Array.isArray(rows)) { list.innerHTML = '<p class="set-about">helpers unreachable right now.</p>'; return; }
        if (!rows.length) { list.innerHTML = '<p class="set-about">no background helpers running.</p>'; return; }
        list.textContent = '';
        for (const r of rows) {
          const row = document.createElement('div');
          row.className = 'set-row';
          const label = document.createElement('span');
          label.className = 'dim';
          const title = String(r.prompt || '').slice(0, 72) || r.id;
          label.textContent = title + (r.usd ? ' · ' + fmtUsd(r.usd) : '');
          label.title = 'lead: ' + (r.leadId || '—') + ' · started ' + (r.startedAt ? new Date(r.startedAt).toLocaleTimeString() : '—');
          const stop = document.createElement('button');
          stop.className = 'bb xs';
          stop.textContent = 'STOP';
          stop.title = 'interrupt this background helper (its work so far is kept; it can be resumed)';
          stop.addEventListener('click', () => {
            stop.disabled = true;
            Harness.api.post('/api/subagents/interrupt', { id: r.id })
              .then(({ ok, j }) => {
                if (!ok || !j || j.ok === false) { label.textContent = title + ' — could not stop: ' + ((j && j.error) || 'error'); sfx('bad'); stop.disabled = false; return; }
                sfx('click'); refreshHelpers();   // repaint from the ledger (the row leaves only when the server says interrupted)
              })
              .catch(() => { label.textContent = title + ' — could not reach the sidecar'; sfx('bad'); stop.disabled = false; });
          });
          row.appendChild(label); row.appendChild(stop);
          list.appendChild(row);
        }
      };
      const refreshHelpers = () => {
        Harness.api.get('/api/subagents?status=running').catch(() => null)
          .then(j => paintHelpers(j && Array.isArray(j.records) ? j.records : null));
      };
      if (list) refreshHelpers();
    }
    // NIGHT SHIFT status surface (NS-4) — the honest live telemetry for the server-owned night shift. Paints from
    // GET /api/nightshift/status + /api/autonomy/ledger through the PURE nightreport engine (panelModel/trailLine),
    // so every rendered value maps to a route field (truthful telemetry). Fail-open, honest loading/error states.
    if (typeof NightReport !== 'undefined') {
      const nsAwayRule = host.querySelector('#ns-awayrule'),
            nsState = host.querySelector('#ns-state'), nsWhy = host.querySelector('#ns-why'), nsLeash = host.querySelector('#ns-leash'),
            nsLast = host.querySelector('#ns-last'), nsNext = host.querySelector('#ns-next'), nsTrail = host.querySelector('#ns-trail'),
            nsMode = host.querySelector('#ns-mode'), nsReadiness = host.querySelector('#ns-readiness'),
            nsFocus = host.querySelector('#ns-focus'), nsSteer = host.querySelector('#ns-steer'),
            nsSteerSet = host.querySelector('#ns-steer-set'), nsSteerClear = host.querySelector('#ns-steer-clear');
      const tz = () => { try { return -new Date().getTimezoneOffset(); } catch (_) { return 0; } };
      const setDim = (el, txt) => { if (el) el.textContent = txt; };
      const paintPanel = (status) => {
        const m = NightReport.panelModel({ status: status, tzOffsetMin: tz() });
        // EL-11 FIX 1: the durable E-STOP halt must be VISIBLE, not a dim status line — reuse the .up-error card
        // language so the panel reads as an engaged stop, and the why names the lift (re-set the dial above).
        if (nsWhy) nsWhy.classList.toggle('ns-halt', !!m.halted);
        if (nsState) nsState.classList.toggle('ns-halt', !!m.halted);
        if (!m.reachable) {
          setDim(nsState, m.stateText);        // "station telemetry unreachable" — never a fake 0/3
          setDim(nsAwayRule, ''); setDim(nsWhy, ''); setDim(nsLeash, '—'); setDim(nsLast, '—'); setDim(nsNext, '—');
          setDim(nsMode, '—'); setDim(nsReadiness, ''); setDim(nsFocus, '—');
          return;
        }
        setDim(nsAwayRule, m.awayRuleText || '');
        setDim(nsState, m.stateText);
        setDim(nsWhy, m.why || '');
        // MODE + READINESS honesty: modeText '' (older sidecar / halted model) renders as an em-dash, never a guess;
        // ns-halt highlights the no-grant degrade (the dial promises building the harness can't deliver).
        setDim(nsMode, m.modeText || '—');
        if (nsMode) nsMode.classList.toggle('ns-halt', !!m.modeWarn);
        setDim(nsReadiness, m.readinessText || '');
        setDim(nsLeash, m.leashText + ' · ' + m.presence);
        setDim(nsLast, m.lastBeatText);
        setDim(nsNext, m.nextEligibleText);
        paintFocus(status);
      };
      // FOCUS readout + steer visibility — every claim maps to status.focus (nightFocusView: {ref,label,why,source,
      // steered} or null). Null renders the honest cold state, never an invented priority.
      const paintFocus = (status) => {
        if (!nsFocus) return;
        const f = status && status.focus;
        // f.steered is the LIVE steer bit (a durable steer is currently set); f.source is only the focus's
        // provenance — after a CLEAR the focus record lingers with source:'steer' until the next re-resolve,
        // so claiming "you steered this" (or offering CLEAR) off source alone overstates the live state.
        if (f && (f.label || f.ref)) {
          const why = Array.isArray(f.why) ? f.why.filter(Boolean).join('; ') : '';
          nsFocus.textContent = String(f.label || f.ref) + (f.steered ? ' · you steered this' : '') + (why ? ' — ' + why : '');
        } else {
          nsFocus.textContent = 'none declared — the night improvises from evidence';
        }
        if (nsSteerClear) nsSteerClear.style.display = (f && f.steered) ? '' : 'none';
      };
      // STEER — POST/DELETE /api/nightshift/focus; the readout repaints from the ROUTE's response (server truth,
      // never an optimistic local flip). "thread:<id>" and the literal "goal" select their kinds; else project.
      const steerMsg = (t) => { if (nsFocus) nsFocus.textContent = t; };
      if (nsSteerSet) nsSteerSet.addEventListener('click', () => {
        const raw = nsSteer ? String(nsSteer.value).trim() : '';
        if (!raw) { steerMsg('enter a blessed project path, thread:<id>, or goal'); sfx('bad'); return; }
        let ref = raw, kind;
        if (raw.toLowerCase() === 'goal') { kind = 'goal'; }
        else if (/^thread:/i.test(raw)) { kind = 'thread'; ref = raw.slice(7).trim(); }
        steerMsg('steering…');
        fetch('/api/nightshift/focus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(kind ? { ref, kind } : { ref }) })
          .then(r => r.json().then(j => ({ ok: r.ok, j })))
          .then(({ ok, j }) => {
            if (!ok || !j || j.ok === false) { steerMsg((j && j.error) || 'could not steer'); sfx('bad'); return; }
            if (nsSteer) nsSteer.value = '';
            sfx('click'); refreshPanel();   // repaint FOCUS from the status route's truth
          })
          .catch(() => { steerMsg('could not reach the sidecar'); sfx('bad'); });
      });
      if (nsSteerClear) nsSteerClear.addEventListener('click', () => {
        steerMsg('clearing…');
        fetch('/api/nightshift/focus', { method: 'DELETE' })
          .then(r => r.json().then(j => ({ ok: r.ok, j })))
          .then(({ ok, j }) => {
            if (!ok || !j || j.ok === false) { steerMsg((j && j.error) || 'could not clear the steer'); sfx('bad'); return; }
            sfx('click'); refreshPanel();
          })
          .catch(() => { steerMsg('could not reach the sidecar'); sfx('bad'); });
      });
      const paintTrail = (entries) => {
        if (!nsTrail) return;
        // COLLAPSED trail (clarity fix 2026-07-15): the driver records one decision per ~minute, so raw rows were
        // twelve identical "declined · you were here" lines — pure noise. trailLines groups consecutive same-reason
        // rows into "4:26–4:37 PM · declined ×12 · …" (every row still derives from real ledger entries).
        const lines = NightReport.trailLines(Array.isArray(entries) ? entries : [], tz()).slice(0, 12);
        if (!lines.length) { nsTrail.innerHTML = '<p class="set-about">no night-shift decisions yet — nothing has run unattended.</p>'; return; }
        nsTrail.innerHTML = lines.map(t => '<div class="set-row"><span class="dim">' + esc(t) + '</span></div>').join('');
      };
      // paint honest "reading…" first, then replace with the live truth (or an honest unreachable/error state).
      const refreshPanel = () => {
        Harness.api.get('/api/nightshift/status').catch(() => null)
          .then(paintPanel);
        // limit 200 (was 12): collapsing eats duplicates, so 12 raw rows could cover only ~12 minutes of history.
        Harness.api.get('/api/autonomy/ledger?source=nightshift&limit=200').catch(() => null)
          .then(j => { if (j && Array.isArray(j.entries)) paintTrail(j.entries); else if (nsTrail) nsTrail.innerHTML = '<p class="set-about">the decision trail is unreachable right now.</p>'; });
      };
      refreshPanel();
      // LAST REPORT — re-render the most recent night's digest on demand. Fetches the SAME three truthful-telemetry
      // surfaces the morning-report beat uses and composes them through NightReport.compose (server truth, not a
      // cached frontend copy), scoped to the last 24h so it reflects "the last night". Every line maps to a route
      // field. Also marks those drafts SEEN (the panel surfaced them) so the live nudge won't re-announce the set.
      const nsReport = host.querySelector('#ns-report'), nsReportBtn = host.querySelector('#ns-report-btn');
      const tzMin = () => { try { return -new Date().getTimezoneOffset(); } catch (_) { return 0; } };
      const renderLastReport = () => {
        if (!nsReport) return;
        nsReport.innerHTML = '<p class="set-about">composing the last report…</p>';
        const now = Date.now();
        const awaySince = now - 24 * 3600 * 1000;   // the last day's night-shift window
        const getJSON = (u) => Harness.api.get(u).catch(() => null);
        Promise.all([
          getJSON('/api/nightshift/status'),
          getJSON('/api/autonomy/ledger?source=nightshift&limit=200'),
          getJSON('/api/nightshift/drafts?since=' + encodeURIComponent(awaySince) + '&limit=20')
        ]).then(([status, ledgerRes, draftsRes]) => {
          const ledger = (ledgerRes && Array.isArray(ledgerRes.entries)) ? ledgerRes.entries : [];
          const drafts = (draftsRes && Array.isArray(draftsRes.drafts)) ? draftsRes.drafts : [];
          let rep; try { rep = NightReport.compose({ status, ledger, drafts, awaySince, nowMs: now, tzOffsetMin: tzMin() }); } catch (_) { rep = null; }
          if (!rep || !rep.hasReport) {
            nsReport.innerHTML = '<p class="set-about">no report to show — the night shift recorded no acts or declines in the last 24h.</p>';
            return;
          }
          const lines = [];
          if (rep.priorityLine) lines.push(rep.priorityLine);
          lines.push('while you were away: ' + rep.headline);
          for (const l of (rep.actLines || [])) lines.push(l);
          for (const l of (rep.declineLines || [])) lines.push(l);
          if (rep.idleReason) lines.push(rep.idleReason);
          nsReport.innerHTML = lines.map(l => '<div class="set-row"><span class="dim">' + esc(l) + '</span></div>').join('');
          // surfaced → mark the drafts seen so the live unseen-drafts nudge won't re-announce them.
          try {
            if (typeof NightDraftNudge !== 'undefined' && NightDraftNudge.markSeen) {
              let newest = 0; for (const d of drafts) { const a = Number(d && d.at) || 0; if (a > newest) newest = a; }
              if (newest) NightDraftNudge.markSeen(newest);
            }
          } catch (_) {}
        });
      };
      if (nsReportBtn) nsReportBtn.addEventListener('click', () => { renderLastReport(); sfx('click'); });
      // Re-setting the dial / a LEVEL click is the (silent) act that LIFTS a durable E-STOP halt
      // (handleAutonomyPosture → clearHalt) — re-read the status shortly after so the ⛔ HALTED card clears
      // (or appears) from the ROUTE's truth, never from an optimistic guess.
      host.querySelectorAll('#auto-init [data-init], #auto-reach [data-reach], #auto-pace [data-pace], #perm-level [data-level]')
        .forEach(b => b.addEventListener('click', () => { setTimeout(refreshPanel, 600); }));
    }
    // PERMISSIONS panel — the never→fully-autonomous LEVEL chooser + the OS-style standing-grant list
    // (permissionsstore). Grants live server-side, so paint from cache now, refresh from the sidecar, repaint. A
    // level click sets BOTH posture + the write grant (so it repaints the dial); the dial syncs back via syncPerm.
    if (typeof PermissionsStore !== 'undefined' && PermissionsStore.snapshot) {
      const levelWrap = host.querySelector('#perm-level'), grantsWrap = host.querySelector('#perm-grants'), permDesc = host.querySelector('#perm-desc');
      const pdesc = (lvl) => (typeof Permissions !== 'undefined' && Permissions.describeLevel) ? Permissions.describeLevel(lvl) : '';
      const plabel = (k) => (typeof Permissions !== 'undefined' && Permissions.catalogLabel) ? Permissions.catalogLabel(k) : k;
      const pcurated = () => (typeof Permissions !== 'undefined' && Permissions.grantableKeys) ? Permissions.grantableKeys() : [];
      const repaintDial = () => {
        if (typeof AutonomyStore === 'undefined' || !AutonomyStore.summary) return;
        const a = AutonomyStore.summary() || {};
        const iw = host.querySelector('#auto-init'), rw = host.querySelector('#auto-reach'), pw = host.querySelector('#auto-pace'), ad = host.querySelector('#auto-desc');
        if (iw) iw.querySelectorAll('[data-init]').forEach(x => x.classList.toggle('sel', x.dataset.init === a.initiative));
        if (rw) rw.querySelectorAll('[data-reach]').forEach(x => x.classList.toggle('sel', x.dataset.reach === a.reach));
        if (pw) pw.querySelectorAll('[data-pace]').forEach(x => x.classList.toggle('sel', Number(x.dataset.pace) === a.leashPerDay));
        if (ad && AutonomyStore.describe) ad.textContent = AutonomyStore.describe();
      };
      // the agent's LIVE placed caps (cabinet→files …) — so a granted-but-inert capability is shown honestly with a
      // "place a cabinet" nudge instead of a silent "writes files" lie (object=capability: the grant is consent, the
      // placed object is the capability). null = unknown → no false alarm.
      const permAgent = () => (typeof Workstreams !== 'undefined' && Workstreams.active && Workstreams.active() && Workstreams.active().agentId) || 'agent';
      const heroCapsNow = () => (typeof World !== 'undefined' && World.heroCaps) ? (World.heroCaps(permAgent()) || []) : null;
      // "granted <when>" provenance line for a standing grant, from the sidecar meta map (additive B1.1). Legacy
      // grants with no timestamp read "granted earlier" — honest, never fabricated. We never claim a prompt/run id
      // because that provenance isn't persisted.
      const pwhen = (snap, k) => {
        const m = snap.meta && snap.meta[k];
        const at = m ? m.grantedAt : null;
        return (typeof Permissions !== 'undefined' && Permissions.grantAgeText) ? Permissions.grantAgeText(at, Date.now()) : '';
      };
      const pempty = () => (typeof Permissions !== 'undefined' && Permissions.emptyApprovals) ? Permissions.emptyApprovals()
        : 'No standing approvals yet — when you answer ALWAYS to a permission prompt, it appears here.';
      const renderGrants = (snap) => {
        const curated = pcurated(); const caps = heroCapsNow(); const rows = [];
        // THE LEDGER (P0-5) — every capability ACTUALLY blessed right now: what, WHEN, and a per-row REVOKE. A held
        // CURATED cap shows its friendly label + object-effect hint; a NON-curated class (blessed via a past "always"
        // prompt) shows its raw danger key — so nothing the agent can do unattended is ever hidden or irrevocable.
        const held = snap.grants.slice();
        if (held.length) {
          curated.filter(k => held.indexOf(k) >= 0).forEach(k => {
            const eff = (typeof Permissions !== 'undefined' && Permissions.grantEffective) ? Permissions.grantEffective(k, caps) : true;
            const hint = (!eff && typeof Permissions !== 'undefined' && Permissions.objectHint) ? Permissions.objectHint(k) : '';
            // GROWTH Tier 3: a grant blessed via an accepted TRUST OFFER shows its earned provenance in the ledger
            // (honest telemetry — the row says HOW the consent was won, not just when). Fail-open: no record, no line.
            let earnedTxt = '';
            try {
              const eg = (typeof TrustStore !== 'undefined' && TrustStore.earnedGrant) ? TrustStore.earnedGrant(k) : null;
              const pv = eg && eg.provenance;
              if (pv) earnedTxt = ' <span class="dim">— ◈ earned' + (pv.runs ? ' after ' + esc(String(pv.runs)) + ' tasks' : '') + (pv.confidence ? ' at ' + esc(String(pv.confidence)) + '%' : '') + '</span>';
            } catch (_) {}
            rows.push('<div class="set-row"><span>✓ ' + esc(plabel(k)) + (hint ? ' <span class="dim">— ' + esc(hint) + '</span>' : '') + ' <span class="dim">— ' + esc(pwhen(snap, k)) + '</span>' + earnedTxt + '</span> <button class="bb sm danger" data-perm-revoke="' + esc(k) + '">✕ REVOKE</button></div>');
          });
          held.filter(k => curated.indexOf(k) < 0).forEach(k => {
            rows.push('<div class="set-row"><span class="dim">' + esc(k) + ' <span class="dim">— ' + esc(pwhen(snap, k)) + '</span></span> <button class="bb sm danger" data-perm-revoke="' + esc(k) + '">✕ REVOKE</button></div>');
          });
        } else {
          // teaching empty state (P0-5): explains how a row lands here instead of looking broken.
          rows.push('<p class="set-about">' + esc(pempty()) + '</p>');
        }
        // BELOW the ledger: the curated capabilities NOT yet granted — an explicit "pre-bless this" offer (GRANT).
        // Kept visually separate from the ledger so the offer is never mistaken for an active approval.
        const offers = curated.filter(k => held.indexOf(k) < 0);
        if (offers.length) {
          rows.push('<div class="set-row"><span class="dim">— pre-approve a capability —</span></div>');
          offers.forEach(k => {
            rows.push('<div class="set-row"><span>' + esc(plabel(k)) + '</span> <button class="bb sm" data-perm-grant="' + esc(k) + '">GRANT</button></div>');
          });
        }
        return rows.join('');
      };
      const wireGrants = () => {
        if (!grantsWrap) return;
        grantsWrap.querySelectorAll('[data-perm-grant]').forEach(b => b.addEventListener('click', () => { Promise.resolve(PermissionsStore.grant(b.getAttribute('data-perm-grant'))).then(repaintPerm); sfx('click'); }));
        // REVOKE is destructive → two-step arm/confirm (same idiom as cron delete / key remove): first click arms
        // the button, a second within 5s withdraws the grant, so the next occurrence prompts again.
        grantsWrap.querySelectorAll('[data-perm-revoke]').forEach(b => ArmConfirm.wire(b, {
          armedLabel: '✕ CONFIRM', restLabel: '✕ REVOKE', timeoutMs: 4000,
          onArm: () => sfx('bad'),
          onConfirm: () => { sfx('bad'); Promise.resolve(PermissionsStore.revoke(b.getAttribute('data-perm-revoke'))).then(repaintPerm); }
        }));
      };
      const repaintPerm = () => {
        const snap = PermissionsStore.snapshot();
        if (permDesc) permDesc.textContent = pdesc(snap.level);
        if (levelWrap) levelWrap.querySelectorAll('[data-level]').forEach(x => x.classList.toggle('sel', x.dataset.level === snap.level));
        if (grantsWrap) { grantsWrap.innerHTML = renderGrants(snap); wireGrants(); }
      };
      syncPerm = repaintPerm;
      if (levelWrap) levelWrap.querySelectorAll('[data-level]').forEach(b => b.addEventListener('click', () => { Promise.resolve(PermissionsStore.setLevel(b.dataset.level)).then(() => { repaintPerm(); repaintDial(); }); sfx('click'); }));
      repaintPerm();
      if (PermissionsStore.refresh) Promise.resolve(PermissionsStore.refresh()).then(repaintPerm).catch(() => {});
    }
    if (typeof Updates !== 'undefined' && Updates.wireSettings) Updates.wireSettings(host);
    // two-step arm/confirm — no native dialogs inside the phosphor terminal
    const clr = host.querySelector('#set-clear');
    if (clr) ArmConfirm.wire(clr, {
      armedLabel: '✕ CONFIRM CLEAR', restLabel: 'CLEAR NOTIFICATIONS', timeoutMs: 4000,
      onArm: () => sfx('bad'),
      onConfirm: () => {
        const n = store.notifs.length;
        store.notifs = []; save(); badges(); rerender('notifs'); sfx('bad');
        flashSaved(host.querySelector('#notifs-msg'), '✓ cleared ' + n + ' notification' + (n === 1 ? '' : 's'));
      }
    });
  }

  /* ============== NOTIFICATIONS — driven by real harness events ============== */
  // Severity is a WHISPER, not a traffic light: it rides the existing cls the callers already
  // pass (good/gold/warn/bad, plus legacy 'error'→bad). No severity is invented where the caller
  // gave none — an empty cls stays 'info' (a dim edge + a quiet ▸). Each maps to a lead glyph.
  const SEV_GLYPH = { bad: '✗', warn: '⚠', good: '✓', gold: '★', info: '▸' };
  function severityOf(cls) {
    const c = String(cls || '').trim().toLowerCase();
    if (c === 'error' || c === 'bad' || c === 'fail') return 'bad';
    if (c === 'warn' || c === 'warning') return 'warn';
    if (c === 'good' || c === 'ok' || c === 'success') return 'good';
    if (c === 'gold') return 'gold';
    return 'info';
  }
  // P1-8: an optional 3rd `category` gates a whole class of notifications at emit time (persisted per-category
  // toggles in settings.notifyPrefs). A caller with no category ('general') is ALWAYS shown — only the named
  // categories can be muted, so nothing important is ever silently dropped by an unset default. Recognized
  // categories: 'runComplete' (a run finished), 'needsApproval' (consent prompt), 'cronDigest' (autonomous run).
  function notifyPrefOf(category) {
    const p = (store.settings && store.settings.notifyPrefs) || notifyDefaults();
    if (!category || category === 'general') return { show: true, sound: p.sound !== false };
    return { show: p[category] !== false, sound: p.sound !== false };
  }
  // opts (additive, optional): { onClick } — a click-through action for the transient toast (EL-11: a
  // background consent toast opens ITS session). The persistent NOTIFICATIONS record is unchanged.
  function notify(text, cls, category, opts) {
    const pref = notifyPrefOf(category);
    if (!pref.show) return;   // this category is muted — honored here, at the real emit point (not decorative)
    store.notifs.push({ id: uid('n'), t: Date.now(), txt: String(text || ''), cls: cls || '', read: false });
    if (store.notifs.length > 60) store.notifs = store.notifs.slice(-60);
    save(); badges();
    if (open.notifs) rerender('notifs');
    toast(String(text || ''), cls || '', pref.sound, opts);
  }
  // transient on-screen toast — slides in, auto-dismisses with a fade-out, stacks cleanly.
  // The persistent record still lives in the NOTIFICATIONS panel (buildNotifs); this is the
  // ephemeral heads-up so a result isn't silent when that panel is closed.
  function toast(text, cls, playSound, opts) {
    if (typeof document === 'undefined' || !text) return;
    // P1-8: a notification chime, gated by the notification-sound toggle (default on). Rides the existing SFX bank
    // (which itself respects the master TERMINAL AUDIO switch), so muting either silences it. undefined = on.
    if (playSound !== false) sfx(severityOf(cls) === 'bad' ? 'bad' : 'notify');
    let stack = document.getElementById('toast-stack');
    if (!stack) { stack = mkEl('div'); stack.id = 'toast-stack'; document.body.appendChild(stack); }
    const sev = severityOf(cls);
    // keep the caller's raw cls (good/gold/warn/bad already have edge styling) AND add a normalized
    // sev-* class so 'error'/'info' also get an edge + the lead glyph.
    const t = mkEl('div', 'toast' + (cls ? ' ' + cls : '') + ' sev-' + sev);
    // message text rides its own span so the ASCII decode below can target JUST the message —
    // the severity glyph and timestamp stay stable (a scrambling clock would read as broken).
    t.innerHTML = '<span class="toast-sev" aria-hidden="true">' + esc(SEV_GLYPH[sev]) + '</span>' +
      '<span class="toast-ts">' + clock(Date.now()) + '</span><span class="toast-txt">' + esc(text) + '</span>';
    stack.appendChild(t);
    // ASCII-motion (asciifx.js): the toast message DECODES out of glyph-static as it slides in — the same
    // signal-resolving language as the window titles. Short (toasts are frequent); reduced-motion no-op.
    try { if (typeof AsciiFX !== 'undefined') AsciiFX.scramble(t.querySelector('.toast-txt'), { duration: 420 }); } catch (_) {}
    // cap the visible stack so a burst can't cover the screen
    while (stack.children.length > 4) stack.removeChild(stack.firstChild);
    const kill = () => {
      if (t._killed) return; t._killed = true;
      t.classList.add('leaving');
      const gone = () => { if (t.isConnected) t.remove(); };
      t.addEventListener('animationend', gone, { once: true });
      setTimeout(gone, 360);
    };
    // errors linger a touch longer so a failure isn't gone before it's read; an ACTIONABLE toast
    // (opts.onClick — e.g. a background consent that must be answered) lingers longer still.
    const hasAction = !!(opts && typeof opts.onClick === 'function');
    setTimeout(kill, hasAction ? 10000 : sev === 'bad' ? 6500 : 4200);
    if (hasAction) {
      t.classList.add('actionable');
      t.style.cursor = 'pointer';
      t.addEventListener('click', () => { try { opts.onClick(); } catch (_) {} kill(); });   // click-through, then dismiss
    } else {
      t.addEventListener('click', kill);   // click to dismiss early
    }
  }
  function buildUpdates(body) {
    if (typeof Updates !== 'undefined' && Updates.render) Updates.render(body);
    else body.innerHTML = '<div class="fb-empty">UPDATE CENTER UNAVAILABLE.<br><span>Restart the desktop app and try again.</span></div>';
  }
  function buildNotifs(body) {
    if (!store.notifs.length) {
      body.innerHTML = '<div class="empty-state"><span class="es-glyph">▮</span><b>NO NOTIFICATIONS YET</b><span>Run results, saved deliverables and assigned tasks show up here.</span></div>';
      return;
    }
    // backfill ids on any legacy row so per-row dismiss can target it (new rows always carry one via notify()).
    let backfilled = false;
    store.notifs.forEach(n => { if (!n.id) { n.id = uid('n'); backfilled = true; } });
    if (backfilled) save();
    body.innerHTML =
      '<button class="bb sm" id="nf-clear">MARK ALL READ</button>' +
      '<div class="nf-list">' + store.notifs.slice().reverse().map((n, i) => {
        const sev = severityOf(n.cls);
        return '<div class="nf ' + (n.cls || '') + ' sev-' + sev + (n.read ? ' read' : '') + '" style="--ci:' + i + '">' +
          '<span class="nf-sev" aria-hidden="true">' + esc(SEV_GLYPH[sev]) + '</span>' +
          '<span class="nf-ts">' + notifStamp(n.t) + '</span> <span class="nf-txt">' + esc(n.txt) + '</span>' +
          '<button class="nf-x" data-nid="' + esc(n.id) + '" title="dismiss this notification" aria-label="Dismiss ' + esc(n.txt) + '">✕</button>' +
          '</div>';
      }).join('') + '</div>';
    body.querySelector('#nf-clear').addEventListener('click', () => {
      store.notifs.forEach(n => n.read = true); save(); rerender('notifs'); badges(); sfx('click');
    });
    // per-row dismiss ✕ — drop just that notification (the record carries no target surface, so no click-through).
    body.querySelectorAll('.nf-x').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      const id = b.dataset.nid;
      store.notifs = store.notifs.filter(x => x.id !== id);
      save(); badges(); rerender('notifs'); sfx('click');
    }));
  }
  function badges() {
    const n = store.notifs.filter(x => !x.read).length;
    const b = $('#nf-badge');
    if (b) { b.textContent = n || ''; b.style.display = n ? 'inline-block' : 'none'; }
  }

  /* ============== periodic + save dot ============== */
  // CONTEXT-WINDOW gauge in the bottom bar — paint the engraved groove from REAL data
  // (latest prompt tokens / the model's catalog max context) via the same CtxGauge model
  // the desk core used. Honest: an unknown limit paints empty + "—" (calibrating).
  function ctxTick() {
    const g = $('#ctx-gauge'); if (!g) return;
    if (typeof CtxGauge === 'undefined') return;
    const cs = access.context ? access.context() : ((typeof Harness !== 'undefined' && Harness.contextState) ? Harness.contextState() : null);
    if (!cs) return;
    const s = CtxGauge.compute(cs.used, cs.limit, { measured: cs.measured !== false });
    g.dataset.level = s.level;
    // ASCII cell bar (asciifx.js): the gauge ticks in whole ▮/▯ cells instead of sliding — deliberate,
    // chunky, CRT-honest. Same real numbers (CtxGauge.compute), only the presentation is quantized;
    // unknown/calibrating renders all-hollow (the num already reads "—"). When a NEW cell lights, a
    // one-shot brightness tick makes the step visible without any looping animation.
    const cells = g.querySelector('.ctx-cells');
    if (cells) {
      const N = 10;
      const txt = (typeof AsciiFX !== 'undefined' && AsciiFX.bar)
        ? AsciiFX.bar(s.known ? s.pct / 100 : 0, N)
        : '▯'.repeat(N);
      if (cells.textContent !== txt) {
        const prev = parseInt(cells.dataset.on || '0', 10);
        const on = (txt.split('▮').length - 1);
        cells.textContent = txt;
        cells.dataset.on = String(on);
        if (on > prev) { cells.classList.remove('ctx-tick'); void cells.offsetWidth; cells.classList.add('ctx-tick'); }
      }
    }
    const num = g.querySelector('.ctx-num'); if (num) num.textContent = s.pctLabel;
    const cap = g.querySelector('.ctx-cap'); if (cap) cap.textContent = s.label;
    // beginner-facing tooltip (UX sweep 2026-07-15): say what the gauge MEANS and what to do when it fills,
    // not just the raw token fraction.
    g.title = 'MEMORY OF THIS CHAT — ' + (s.known
      ? s.label + ' (' + s.pctLabel + ' full). How much of this conversation the model can still hold; when it fills, older turns are folded into a summary automatically.'
      : (s.limit ? 'measuring… send a message and this fills in' : 'measuring this model’s memory size…'));
  }
  let compactWired = false;
  function wireCompactBeat() {
    if (compactWired || typeof U === 'undefined' || !U.bus) return;
    compactWired = true;
    // M-mem.4: a real auto-compaction fired — flash the engraved groove mint for ~1.2s. The
    // "🧠 context compacted" notify is raised elsewhere; this is the bottom-bar's visual echo.
    U.bus.on('agent.compact', () => {
      const g = $('#ctx-gauge'); if (!g) return;
      g.classList.add('compact');
      setTimeout(() => g.classList.remove('compact'), 1200);
    });
  }
  // resolve every quest generator against the live floor, then fold the projection into the durable memory —
  // the exact resolve→fold sequence the 1s tick runs, factored out so a placement can drive it IMMEDIATELY.
  // Without this an open→done transition (a prop placed) waits for the next tick, where a burst of fast
  // placements can coalesce/miss the per-quest celebration; QuestState.fold celebrates each edge individually,
  // so running it the instant a prop lands makes each close flourish on its own. The 1s tick stays the fallback.
  function pokeQuests() {
    if (typeof QuestLedgerStore !== 'undefined' && QuestLedgerStore.sync) { try { QuestLedgerStore.sync(); } catch (_) {} }   // §C: throttled ledger poll (no-ops network unless the window elapsed)
    if (typeof QuestRefreshStore !== 'undefined' && QuestRefreshStore.sync) { try { QuestRefreshStore.sync(); } catch (_) {} }   // QUEST V3: throttled refresh-status poll (north star + attempt ledger)
    if (typeof StationQuestStore !== 'undefined' && StationQuestStore.sync) { try { StationQuestStore.sync(); } catch (_) {} }
    if (typeof WorkQuestStore !== 'undefined' && WorkQuestStore.sync) { try { WorkQuestStore.sync(); } catch (_) {} }
    if (typeof MaintQuestStore !== 'undefined' && MaintQuestStore.sync) { try { MaintQuestStore.sync(); } catch (_) {} }
    if (typeof QuestStateStore !== 'undefined' && QuestStateStore.sync) { try { QuestStateStore.sync(); } catch (_) {} }
  }
  function tick() {
    crewTick();
    ctxTick();
    // G1b: resolve station-gap quests against the live floor + re-evaluate the standing OUTBOX candidate
    // FIRST, so a gap that just closed (a prop placed) is already flipped done in the projection when the
    // durable quest memory folds it below — the open→done edge then rides G1a's celebration for free.
    // D1: ALL FOUR generator stores must resync before the fold, else a work/maint completion sits undetected
    // until the log opens and then backfills silently. Order mirrors pokeQuests(): generators, then the fold.
    // §C: the harness LEDGER polls here too (throttled inside QuestLedgerStore) so an away-completed / just-
    // confirmed ledger quest folds into the celebration on the 1s tick even with the QUEST LOG closed.
    if (typeof QuestLedgerStore !== 'undefined' && QuestLedgerStore.sync) { try { QuestLedgerStore.sync(); } catch (_) {} }
    if (typeof QuestRefreshStore !== 'undefined' && QuestRefreshStore.sync) { try { QuestRefreshStore.sync(); } catch (_) {} }   // QUEST V3: refresh status polls here too (throttled) so the north-star beat can surface with the QUEST LOG closed
    if (typeof StationQuestStore !== 'undefined' && StationQuestStore.sync) { try { StationQuestStore.sync(); } catch (_) {} }
    if (typeof WorkQuestStore !== 'undefined' && WorkQuestStore.sync) { try { WorkQuestStore.sync(); } catch (_) {} }
    if (typeof MaintQuestStore !== 'undefined' && MaintQuestStore.sync) { try { MaintQuestStore.sync(); } catch (_) {} }
    // G1a: fold the live quest projection into the durable quest memory once a second — completion
    // detection must not depend on the QUEST LOG being open (the celebration toast/sting fire regardless).
    if (typeof QuestStateStore !== 'undefined' && QuestStateStore.sync) { try { QuestStateStore.sync(); } catch (_) {} }
    const [txt, cls] = pillFor(activity());
    const p = $('#status-pill');
    if (p) { p.textContent = txt; p.className = cls; }
    // keep the save-dot's durability state honest even between persists — a mirror can go stale (cross the
    // 60-min line while a failure streak is live) or recover (a backoff retry lands) without a fresh save.
    refreshSaveDurability();
    // refresh BRIEF's live telemetry only. CONSOLE MODE keeps every section pane in the DOM at once, so a full
    // rerender would rebuild (and wipe) an open CONFIG editor / MEMORY list even when BRIEF is showing. Instead
    // surgically repaint just the live nodes (hero status dot + line, roster idle/working hints) in place — no
    // DOM rebuild, so open editors are never touched. (MEMORY self-refreshes via its own debounced U.bus listener.)
    if (open.agents) refreshDossierLive();
  }
  function flashSave() {
    const d = $('#save-dot'); if (!d) return;
    d.classList.add('flash'); setTimeout(() => d.classList.remove('flash'), 600);
    refreshSaveDurability(d);
  }
  // TRUTHFUL save-dot: the green flash means "the LOCAL cache was written" — but the durable mirror
  // (the sidecar copy that survives a webview-profile wipe) can be silently frozen while pushes fail.
  // When CloudSave reports a stale mirror (no confirmed backup in > 60 min + a live failure streak),
  // flip the dot to a distinct amber/warn state + explain it in the title. NO new window, NO nag — just
  // an honest dot state. Never asserts durability the harness can't prove (truthful-telemetry law).
  let degradedNotified = false;   // ONE persistent notice per session for the degraded workspace (the dot carries the ongoing state)
  function refreshSaveDurability(d) {
    d = d || $('#save-dot'); if (!d) return;
    let h = null;
    try { h = (typeof CloudSave !== 'undefined' && CloudSave.health) ? CloudSave.health() : null; } catch (_) { h = null; }
    d.classList.remove('stale', 'degraded');
    if (h && h.degraded) {
      // EL-11 FIX 1: the sidecar is REFUSING writes — this workspace was written by a NEWER StarNet. Persistent
      // red dot + a one-time visible line; never lets a refused write read as a healthy backup.
      d.classList.add('degraded');
      d.title = 'this station’s data was written by a newer StarNet — update the app. Until then, changes are NOT being backed up.';
      if (!degradedNotified) {
        degradedNotified = true;
        try { notify('This station’s data was written by a newer StarNet — update the app. Until you do, your changes are NOT being backed up.', 'bad'); } catch (_) {}
      }
    } else if (h && h.stale) {
      d.classList.add('stale');
      const since = h.lastPushOkAt ? new Date(h.lastPushOkAt).toLocaleString() : 'never';
      d.title = 'world is saved locally; the durable backup copy hasn’t synced since ' + since;
    } else if (h && h.warn) {
      // EL-11 FIX 4: a live streak of failed pushes (3+) warns IMMEDIATELY — no 60-minute blind window while
      // POST /api/save errors (disk full / EPERM / refused). Same amber vocabulary as stale, advising title.
      d.classList.add('stale');
      d.title = 'saves are failing — check disk space / folder permissions (' + (h.consecutiveFailures || 0) + ' failed attempts in a row). Local play continues; the durable backup is not confirming writes.';
    } else {
      d.title = 'autosave';
    }
  }

  // relative-time formatter shared by several windows (ROUTINES/REWIND/LOGBOOK/OUTBOX via StationUI.h, QUESTS inline).
  function fmtRel(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso); if (isNaN(t)) return '—';
    const d = t - Date.now(), a = Math.abs(d);
    if (a < 60000) return 'now';
    const span = a < 3600000 ? (Math.round(a / 60000) + 'm') : a < 86400000 ? (Math.round(a / 3600000) + 'h') : (Math.round(a / 86400000) + 'd');
    return d >= 0 ? ('in ' + span) : (span + ' ago');
  }
  // a compact agent switcher for the per-agent windows (REWIND / LOGBOOK) — mirrors the dossier roster idiom.
  // Empty on a single-agent station (nothing to switch). Wire with wireRosterSwitch(root, key).
  function rosterSwitchHtml(curId) {
    if (present.length <= 1) return '';
    return '<div class="rw-switch" role="group" aria-label="Choose agent">' +
      present.map((x, i) => '<button type="button" class="rw-agent' + (x.id === curId ? ' sel' : '') + '" data-i="' + i + '" style="--ci:' + i + '"' + (x.id === curId ? ' aria-current="true"' : '') + '>' +
        '<span class="rw-agent-dot" style="color:' + esc(x.color) + '">●</span>' + esc(x.name) + '</button>').join('') +
      '</div>';
  }
  function wireRosterSwitch(root, key) {
    root.querySelectorAll('.rw-switch .rw-agent').forEach(b => b.addEventListener('click', () => {
      const i = +b.dataset.i; if (i === sel) return; sel = i; sfx('click'); rerender(key);
    }));
  }

  /* ============== COMMANDER DOSSIER — the station-wide model of the USER (the glass box) ==============
     Phase A of docs/COMMANDER_DOSSIER_PLAN.md. ONE dossier, shared by every agent, that folds into each
     agent's system prompt (DossierStore.composeBlock) so a new agent knows the Commander on day one. This
     panel is the glass box: every belief the station holds about the Commander, grouped by dimension, with
     provenance — add / edit / pin / forget, all local-first. It reads + mutates DossierStore (which
     recomposes the live prompt + persists on each edit); the panel re-renders after a mutation. Belief text
     is rendered as textContent (never interpreted), mirroring the Memory Core's injection-safe discipline. */
  const CD_SOURCE = { onboarding: 'from your awakening', commander: 'you told the station', interview: 'from the intake interview', curiosity: 'you answered a question', study: 'observed from your work' };
  const CDS = () => (typeof DossierStore !== 'undefined') ? DossierStore : null;

  // STATION RECORD — the durable lifetime pride counters (G3a). Reads the pure PrideStore snapshot and renders a
  // compact honest grid: a counter with no real sample shows "—", never a made-up 0 (the floorstats honesty rule).
  // Returns null when the store isn't present (fresh boot / node) so the caller can append unconditionally.
  function cdStationRecord() {
    if (typeof PrideStore === 'undefined' || !PrideStore.snapshot) return null;
    const snap = PrideStore.snapshot();
    if (!snap) return null;
    const cell = (known, n, label) => {
      const val = known ? String(n) : '—';
      return '<div class="cd-stat"><span class="cd-stat-n' + (known ? '' : ' dim') + '">' + esc(val) + '</span>'
        + '<span class="cd-stat-l">' + esc(label) + '</span></div>';
    };
    const grid = cell(snap.tasksKnown, snap.tasks, 'tasks completed')
      + cell(snap.deliverablesKnown, snap.deliverables, 'deliverables shipped')
      + cell(snap.routinesKnown, snap.routines, 'routines fired')
      + cell(snap.workKnown, snap.workMinutes, 'agent-work minutes');
    let founded = '';
    if (snap.founded && snap.foundedAt) {
      let d = ''; try { d = new Date(snap.foundedAt).toLocaleDateString(); } catch (_) { d = ''; }
      if (d) founded = '<div class="cd-founded">station founded <b>' + esc(d) + '</b></div>';
    }
    return mkEl('div', 'cd-record',
      '<div class="cd-record-h">STATION RECORD // LIFETIME</div>'
      + '<div class="cd-record-grid">' + grid + '</div>'
      + founded);
  }

  function buildCommander(body) {
    const ds = CDS();
    const sum = ds ? ds.summary() : null;
    if (!ds || !sum) { body.innerHTML = '<p class="dim">The Commander Dossier warms up once your agent is awake.</p>'; return; }
    const dims = ds.dims();
    body.innerHTML = '';

    // header: the honest familiarity meter + the observed work-mix + the local-first promise.
    // DISPLAY prefers the understanding read (belief count × provenance × recency, weighted toward
    // goals/ambition/pain) over the breadth fraction — it climbs with real learning and sags with drift.
    // Display-only: Dossier.summary().familiarity itself is untouched (the pitch/suggest gates read it).
    let fam = sum.familiarity || 0;
    try {
      if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.read) {
        const u = UnderstandingStore.read();
        if (u && Number.isFinite(u.overall)) fam = u.overall;
      }
    } catch (_) {}
    const pct = Math.round(fam * 100);
    const obs = sum.observed;
    const obsLine = (obs && obs.dominant && !obs.calibrating)
      ? 'Observed: you work mostly on <b>' + esc(obs.dominant) + '</b> tasks.'
      : 'Observed work-mix: <span class="dim">calibrating…</span>';
    const head = mkEl('div', 'gx',
      '<div class="gx-head"><div><div class="gx-kicker">STATION // COMMANDER DOSSIER</div>' +
      '<div class="gx-name">What the station knows about you</div></div>' +
      '<div style="text-align:right;"><div class="gx-kicker" style="margin-bottom:6px;">FAMILIARITY</div>' +
      '<span class="cd-fam"><span class="cd-fk"><span class="cd-ff" style="width:' + pct + '%;"></span></span>' +
      '<span class="cd-fpct">' + (sum.known.length ? pct + '%' : 'calibrating') + '</span></span></div></div>' +
      '<div class="cd-sub">' + sum.known.length + ' of ' + dims.length + ' dimensions known &middot; ' + obsLine + '</div>' +
      '<div class="mc-note">This dossier is <b>shared by every agent on your station</b> and folds into each one\'s briefing, so a freshly-deployed agent already knows you. It is <b>local-first</b> — it never leaves this machine. Add, edit, pin, or forget anything below; you own it.</div>');
    body.appendChild(head);

    // AGENT BRIEFING — the practical payoff surface: the VERBATIM Commander block every agent receives.
    body.appendChild(cdBriefing(ds));

    // the active "get to know you" trigger — runs the intake interview in COMMS, folding answers into the
    // dossier through the same upsert path the cards use. Gated on a free agent + not-already-running.
    const actRow = mkEl('div', 'cd-actions-row');
    const goBtn = mkEl('button', 'cd-interview');
    goBtn.textContent = sum.blank.length ? '▸ LET THE STATION GET TO KNOW YOU' : '▸ REFINE WHAT THE STATION KNOWS';
    goBtn.onclick = () => {
      if (typeof Intake === 'undefined') return;
      if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) { notify('let your agent finish waking up first', ''); return; }
      if (typeof Chat !== 'undefined' && Chat.isBusy && Chat.isBusy()) { sfx('bad'); notify('finish the current run first, then run the interview', 'bad'); return; }
      if (Intake.isRunning && Intake.isRunning()) { notify('the interview is already running — answer in COMMS', ''); return; }
      const s = ds.summary();
      const skip = s.blank.length ? s.known : [];   // ask blank dimensions; if the station knows them all, re-ask everything (refine)
      const began = Intake.start({
        skip: skip,
        onCommit: belief => ds.upsert(belief.dim, { text: belief.text, source: belief.source, weight: belief.weight }),   // V3: weight rides through (canned chip = 'seed', never opens the readiness gate)
        onDone: () => rerender('commander'),
        onLeave: () => { rerender('commander'); notify('left the interview — what you answered is saved', ''); },   // user-launched: leaving is a clean stop (answers banked), nothing to wave off
        onEmpty: () => notify('the station already knows you — edit any belief below to refine', 'good')
      });
      if (began) { sfx('click'); notify('the station is interviewing you — answer in COMMS →', 'good'); }
    };
    actRow.appendChild(goBtn);
    body.appendChild(actRow);

    // one section per dimension, laid out as a two-column grid (the window is 760px wide — a single
    // column of short cards wasted half of it). The composed block is passed down so each card can
    // honestly flag "trimmed from briefing" when the char cap cut it out of the prompt.
    const block = ds.composeBlock();
    const grid = mkEl('div', 'cd-dims');
    for (const d of dims) {
      const bs = ds.beliefs(d.key);
      const sec = mkEl('div', 'cd-sec' + (bs.length ? ' known' : ''));
      sec.appendChild(mkEl('div', 'cd-sech', '<span class="cd-dim">' + esc(d.label) + '</span><span class="cd-dn">' + (bs.length || '—') + '</span>'));
      const addRow = cdAddRow(d.key);
      if (!bs.length) {
        const e = mkEl('div', 'cd-empty'); e.textContent = 'unknown — the station hasn’t learned this yet.'; sec.appendChild(e);
        // an empty dimension shows its starter chips INLINE (tap → the editor opens prefilled) so filling
        // the dossier in is one tap + a finished sentence, not a blank textarea behind a "+ add".
        // (_open hides this row on hand-off — the editor renders its own chips.)
        const st = cdStarterChips(d.key, s => addRow._open(s));
        if (st) sec.appendChild(st);
        sec.appendChild(cdCurioRow(d));   // the question-state readout (asked / paused) + re-enable, when relevant
      }
      else for (const b of bs) sec.appendChild(cdCard(d.key, b, block));
      sec.appendChild(addRow);
      grid.appendChild(sec);
    }
    body.appendChild(grid);

    // STATION RECORD (G3a pride layer): the durable lifetime counters, honest by construction — a counter
    // with no real sample yet renders "—" (never a fabricated 0). Rendered here, on the station-wide dossier,
    // because it IS the colony's whole-lifetime track record. Absent store → silently omit (nothing to show).
    const rec = cdStationRecord();
    if (rec) body.appendChild(rec);
  }

  // AGENT BRIEFING — the panel's practical payoff: renders the VERBATIM Commander block that
  // composeSystemPrompt appends to every agent's system prompt (and DossierStore.pushToSidecar mirrors to
  // server-composed cron/night-shift runs via SK.dossierInject.withDossier). Showing the exact live string —
  // never a summary — is what keeps the glass box honest: what you read here IS what agents are told.
  // Empty dossier → an honest "cold" state (agents receive no block at all), never a fabricated preview.
  function cdBriefing(ds) {
    const block = ds.composeBlock();
    const cap = (typeof Dossier !== 'undefined' && Dossier.BLOCK_CHARS) ? Dossier.BLOCK_CHARS : 1200;
    const wrap = mkEl('div', 'cd-brief');
    const head = mkEl('div', 'cd-brief-head', '<span class="cd-brief-h">AGENT BRIEFING // WHAT EVERY AGENT IS TOLD ABOUT YOU</span>');
    if (block) {
      const meter = mkEl('span', 'cd-brief-meter');
      meter.textContent = block.length + ' / ' + cap + ' chars';
      meter.title = 'the briefing composes from your beliefs below, capped at ' + cap + ' characters — past the cap, every known dimension keeps a fair share and the rest is trimmed';
      head.appendChild(meter);
    }
    wrap.appendChild(head);
    if (!block) {
      const e = mkEl('div', 'cd-brief-empty');
      e.textContent = 'cold — the station knows nothing yet, so agents receive no Commander block. Run the interview or add a belief below and this briefing writes itself.';
      wrap.appendChild(e);
    } else {
      const pre = mkEl('pre', 'cd-brief-text'); pre.textContent = block;   // textContent — belief text is never interpreted
      wrap.appendChild(pre);
    }
    // WIRED INTO — states the wiring (each chip names a real code path), never a wish. Cold station: the
    // chips still state where the block WILL flow, phrased as wiring, since the paths exist regardless.
    const foot = mkEl('div', 'cd-brief-foot');
    const flows = mkEl('div', 'cd-flows',
      '<span class="cd-flow" title="composeSystemPrompt folds this block into the system prompt of every agent on the station — including a freshly-summoned one">▸ every agent’s briefing</span>' +
      '<span class="cd-flow" title="mirrored to the sidecar so autonomous scheduled runs (cron, night shift) that compose their own persona still know who they serve">▸ autonomous &amp; scheduled runs</span>' +
      '<span class="cd-flow" title="the pitch engine and recruitment matcher read your goals, pain points and ambitions to propose work and crew">▸ pitches &amp; recruitment</span>' +
      '<span class="cd-flow" title="the quest board turns still-blank dimensions into get-to-know-you quests">▸ quest board</span>');
    foot.appendChild(flows);
    if (block) {
      const copy = mkEl('button', 'consent-btn cd-brief-copy'); copy.textContent = 'copy briefing';
      copy.onclick = () => {
        try { navigator.clipboard.writeText(block); } catch (_) {}
        copy.textContent = 'copied ✓'; sfx('click');
        setTimeout(() => { copy.textContent = 'copy briefing'; }, 1500);
      };
      foot.appendChild(copy);
    }
    wrap.appendChild(foot);
    return wrap;
  }

  // the curiosity question-state for a still-blank dimension: has the station asked about it, and did the Commander
  // wave it off / ignore it to the stop-forever limit? Shows nothing for a never-asked dimension; for a stopped one
  // it offers a re-enable (the escape hatch, mirroring Restore on the memory side). Returns an empty fragment-row
  // when there's nothing to say, so the caller can append unconditionally.
  function cdCurioRow(d) {
    const row = mkEl('div', 'cd-curio');
    if (typeof CuriosityStore === 'undefined' || !CuriosityStore.statusOf) return row;
    const st = CuriosityStore.statusOf(d.key);
    if (!st.stopped && !st.asked) return row;   // never asked → say nothing (keeps the panel quiet)
    const lbl = mkEl('span', 'cd-curio-lbl');
    lbl.textContent = st.stopped
      ? (st.dismissed ? '⏸ you waved this question off' : '⏸ the station stopped asking — you skipped it')
      : ('· the station asked once, waiting');
    row.appendChild(lbl);
    if (st.stopped) {
      const rb = mkEl('button', 'consent-btn cd-reenable'); rb.textContent = 'ask me about this';
      rb.title = 'turn this question back on — the station may ask about your ' + String(d.label).toLowerCase() + ' again';
      rb.onclick = () => { CuriosityStore.reEnable(d.key); sfx('click'); notify('the station will ask about your ' + String(d.label).toLowerCase() + ' again', 'good'); rerender('commander'); };
      row.appendChild(rb);
    }
    return row;
  }

  function cdCard(dim, b, block) {
    const card = mkEl('div', 'cd-rec' + (b.pinned ? ' pinned' : '') + (b.source === 'study' ? ' cd-observed' : ''));
    const txt = mkEl('div', 'cd-body'); txt.textContent = b.text; card.appendChild(txt);   // textContent — belief text is never interpreted
    const metaRow = mkEl('div', 'cd-meta');
    // GROWTH Tier 1: a STUDY-sourced belief (the station learned it from real work, not the Commander authoring it)
    // gets a distinct "observed" tag so the glass box stays honest about provenance.
    if (b.source === 'study') { const tag = mkEl('span', 'cd-observed-tag'); tag.textContent = 'observed'; tag.title = 'the station proposed this from your work; you kept it'; metaRow.appendChild(tag); }
    // BRIEFING HONESTY: the composed block trims past its char cap (fair-share per dimension), so a belief can
    // exist in the dossier yet be shortened/dropped from the prompt. An exact-substring check against the LIVE
    // block flags that state — otherwise the panel implies every belief reaches the agents, which can be false.
    if (typeof block === 'string' && block && block.indexOf(b.text) < 0) {
      const tt = mkEl('span', 'cd-trim-tag'); tt.textContent = 'trimmed from briefing';
      tt.title = 'the briefing hit its character cap, so this belief was shortened or dropped from what agents are told — pin or shorten what matters most';
      metaRow.appendChild(tt);
    }
    const meta = mkEl('span', 'cd-src');
    const when = (Number.isFinite(b.observedAt) && b.observedAt > 0) ? b.observedAt : b.createdAt;
    meta.textContent = (b.pinned ? '★ pinned · ' : '') + (CD_SOURCE[b.source] || 'you told the station') + (when ? ' · ' + new Date(when).toLocaleDateString() : '');
    card.appendChild(metaRow).appendChild(meta);

    const btns = mkEl('div', 'consent-btns cd-acts'); card.appendChild(btns);
    let busy = false;
    const mk = (label, cls, fn) => { const x = mkEl('button', 'consent-btn' + (cls ? ' ' + cls : '')); x.textContent = label; x.onclick = fn; btns.appendChild(x); return x; };
    mk(b.pinned ? 'Unpin' : 'Pin', '', () => { if (busy) return; busy = true; CDS().setPinned(dim, b.id, !b.pinned); sfx('click'); rerender('commander'); });
    mk('Edit', '', () => cdEdit(card, txt, btns, dim, b));
    let armed = false;
    const fb = mk('Forget', 'deny', () => {
      if (!armed) { armed = true; fb.textContent = 'Confirm forget'; setTimeout(() => { if (armed) { armed = false; fb.textContent = 'Forget'; } }, 3000); return; }
      if (busy) return; busy = true; CDS().forget(dim, b.id); sfx('click'); rerender('commander');
    });
    return card;
  }

  // inline edit (mirrors the Memory Core editor): swap the body for a textarea + Save/Cancel.
  function cdEdit(card, txt, btns, dim, b) {
    const ta = mkEl('textarea', 'cd-edit'); ta.value = b.text; ta.spellcheck = false;
    card.replaceChild(ta, txt); ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {}
    btns.innerHTML = '';
    const save = mkEl('button', 'consent-btn'); save.textContent = 'Save'; btns.appendChild(save);
    const cancel = mkEl('button', 'consent-btn'); cancel.textContent = 'Cancel'; btns.appendChild(cancel);
    let saving = false;
    save.onclick = () => { if (saving) return; const v = ta.value.trim(); if (!v) { ta.focus(); return; } saving = true; CDS().upsert(dim, { id: b.id, text: v }); sfx('click'); rerender('commander'); };
    cancel.onclick = () => rerender('commander');
  }

  // guided starters per dimension — the "+ add" editor and empty dimensions surface these so filling the
  // dossier in never starts from a blank textarea (the "it feels bare" fix). A chip only INSERTS its starter
  // text for the Commander to finish; nothing is saved until they hit Save — a nudge, never a fabricated belief.
  const CD_PROMPTS = {
    identity:        [{ c: 'your role', s: 'I’m a ' }, { c: 'what you’re building', s: 'I’m building ' }, { c: 'where you’re based', s: 'I’m based in ' }],
    stack:           [{ c: 'languages', s: 'I mostly work in ' }, { c: 'daily tools', s: 'My daily tools are ' }, { c: 'don’t use', s: 'Don’t reach for ' }],
    goals:           [{ c: 'right now', s: 'Right now I’m trying to ' }, { c: 'this quarter', s: 'This quarter I want to ' }, { c: 'the big one', s: 'The long-term goal is ' }],
    style:           [{ c: 'report style', s: 'Report to me ' }, { c: 'autonomy', s: 'Before acting on anything significant, ' }, { c: 'formatting', s: 'Deliverables should be ' }],
    standing_orders: [{ c: 'an always', s: '- Always ' }, { c: 'a never', s: '- Never ' }],
    pain:            [{ c: 'what eats your time', s: 'I lose the most time to ' }, { c: 'work you want gone', s: 'I never want to have to ' }],
    ambition:        [{ c: 'back-burner project', s: 'I keep meaning to ' }, { c: 'a skill', s: 'I’ve always wanted to learn ' }],
    people:          [{ c: 'who you build for', s: 'I build for ' }, { c: 'your team', s: 'I work with ' }, { c: 'who sees the work', s: 'My deliverables are read by ' }],
    schedule:        [{ c: 'timezone', s: 'My timezone is ' }, { c: 'work hours', s: 'I usually work ' }, { c: 'when work should land', s: 'Have overnight work ready by ' }]
  };
  // the starter-chip row for a dimension; onPick receives the starter string. null when a dim has no prompts.
  function cdStarterChips(dim, onPick) {
    const ps = CD_PROMPTS[dim];
    if (!ps || !ps.length) return null;
    const row = mkEl('div', 'cd-starters');
    for (const p of ps) {
      const b = mkEl('button', 'cd-starter'); b.textContent = p.c;
      b.title = 'start with: “' + p.s + '…” — you finish the sentence';
      b.onclick = () => { sfx('click'); onPick(p.s); };
      row.appendChild(b);
    }
    return row;
  }

  // a "+ add" affordance per dimension: expands to starter chips + a textarea so the Commander can teach the
  // station directly. row._open(starter) lets an empty dimension's inline chips jump straight into the editor.
  function cdAddRow(dim) {
    const row = mkEl('div', 'cd-add');
    const btn = mkEl('button', 'cd-addbtn'); btn.textContent = '+ add'; row.appendChild(btn);
    const open = starter => {
      // hide a sibling inline starter row (empty-dim state) — the editor renders its own chips, and two
      // identical rows read as a bug. Covers BOTH entries: an inline chip tap and the plain "+ add".
      try { const sib = row.parentElement && row.parentElement.querySelector(':scope > .cd-starters'); if (sib) sib.style.display = 'none'; } catch (_) {}
      row.innerHTML = '';
      const ta = mkEl('textarea', 'cd-edit'); ta.placeholder = 'Tell the station something about yourself…'; ta.spellcheck = false;
      const chips = cdStarterChips(dim, s => { ta.value = s; ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {} });
      if (chips) row.appendChild(chips);
      row.appendChild(ta);
      if (starter) ta.value = starter;
      ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {}
      const btns = mkEl('div', 'consent-btns cd-acts'); row.appendChild(btns);
      const save = mkEl('button', 'consent-btn'); save.textContent = 'Save'; btns.appendChild(save);
      const cancel = mkEl('button', 'consent-btn'); cancel.textContent = 'Cancel'; btns.appendChild(cancel);
      let saving = false;
      save.onclick = () => { if (saving) return; const v = ta.value.trim(); if (!v) { ta.focus(); return; } saving = true; CDS().upsert(dim, { text: v, source: 'commander' }); sfx('click'); rerender('commander'); };
      cancel.onclick = () => rerender('commander');
    };
    btn.onclick = () => open('');
    row._open = open;
    return row;
  }

  // QUEST LOG (Slice 4 + G1a): the station's REAL progress dressed as quests — a read projection (QuestStore.view),
  // never a new source of truth — now joined with the durable quest memory (QuestStateStore): a dismissed quest
  // never re-renders (the anti-nag law), a freshly-completed row flashes a gold flourish, and get-to-know-you
  // quests carry a dismiss ✕ (milestones are achievements — no dismiss; the engine gates by kind). Honors the
  // honest-loot law: every quest pays out in real capability/work, and nothing here is gated behind a level.

  // W3: is the away-workshop grant on for the hero (the agent the quest-log queue button targets)? The queue
  // affordance only appears when the grant is on — never offer to queue into a lane the Commander hasn't opened.
  function heroAgent() {
    if (!Array.isArray(present)) return null;
    return present.find(a => a && a.id === 'agent') || present[0] || null;
  }
  function workshopGrantOn() { const h = heroAgent(); return !!(h && h.workshop); }

  // §C — the honest "what makes this quest complete", in plain words, per kind. Ledger quests derive it from
  // their real completion contract; the v1 kinds get accurate copy matching each generator's true semantics
  // (never a guess). Used to render the "✓ completes when:" sub-line on EVERY open row.
  function questCompletesWhen(q) {
    if (!q) return '';
    if (q.kind === 'ledger') {
      const t = (q.contract && q.contract.type) || 'attest';
      const key = (q.contract && q.contract.key) || '';
      if (t === 'prop') return 'the ' + (key || 'named') + ' capability goes live on your floor';
      if (t === 'run') return 'the bound build runs to completion';
      if (t === 'fact') return 'the station learns this about you';
      if (t === 'artifact') return 'the deliverable lands in the workshop';
      if (t === 'attest') return 'your agent reports it done with evidence and you confirm';
      return 'its completion contract is met';
    }
    switch (q.kind) {
      case 'station-gap': return 'you place the prop that grants this capability';
      case 'work': return 'the build finishes its run';
      case 'maintenance': return 'the recurring failure stops happening';
      case 'dossier': return 'you tell the station this';
      case 'milestone': return String(q.desc || '').replace(/^how:\s*/i, '').trim() || 'you ship the real work behind it';
      case 'station':
        return q.id === 'st:crew' ? 'a second specialist joins your crew'
          : q.id === 'st:belt' ? 'a live work route reaches an agent'
          : q.id === 'st:connector' ? 'a tool portal is bound to real powers'
          : 'the floor reaches this milestone';
      default: return '';
    }
  }
  // §C — the GO destination token for a quest that has a real, already-existing openable surface (never a new
  // window). null → no GO button. dossier → the Commander dossier; work/build → the TASK BOARD; a floor gap → REFIT.
  const GO_LABEL = { commander: 'GO ▸ dossier', tasks: 'GO ▸ task board', refit: 'GO ▸ REFIT' };
  function questGoDest(q) {
    if (!q || q.status === 'done') return null;
    if (q.kind === 'dossier') return 'commander';
    if (q.kind === 'work' || (q.kind === 'ledger' && (q.ledgerKind === 'work' || (q.contract && (q.contract.type === 'run' || q.contract.type === 'artifact'))))) return 'tasks';
    if (q.kind === 'station-gap' || q.kind === 'station') return (typeof Build !== 'undefined' && Build.open) ? 'refit' : null;
    return null;
  }

  // QUEST V3 — relative-time from an epoch-ms stamp (the fmtRel idiom, but for ms not ISO). 0/junk -> '—'.
  function qrRel(ms) {
    const t = Number(ms) || 0; if (!t) return '—';
    const d = t - Date.now(), a = Math.abs(d);
    if (a < 60000) return 'now';
    const span = a < 3600000 ? (Math.round(a / 60000) + 'm') : a < 86400000 ? (Math.round(a / 3600000) + 'h') : (Math.round(a / 86400000) + 'd');
    return d >= 0 ? ('in ' + span) : (span + ' ago');
  }
  // QUEST V3 — the NORTH STAR + standing-refresh surface. Reads the last-good status off QuestRefreshStore
  // (the throttled /api/quests/refresh poll). Every line is real engine state: the long-term goal the station
  // believes the Commander is chasing (with its provenance — a Commander-set goal vs an inference), the manual
  // REFRESH QUESTS action, the most recent honest attempt outcome (minted / rejected: why / skipped: why), and
  // when the next cycle is due. Absent store / no fetch yet -> a quiet, honest placeholder (never a fake value).
  function questRefreshHtml() {
    const QRS = (typeof QuestRefreshStore !== 'undefined') ? QuestRefreshStore : null;
    if (QRS && QRS.sync) { try { QRS.sync(); } catch (_) {} }   // throttled — no-ops the network unless the poll window elapsed
    const s = QRS && QRS.status ? QRS.status() : null;
    const running = QRS && QRS.isRunning ? QRS.isRunning() : false;
    // NORTH STAR line — the goal the station is steering quests toward, with honest provenance + confirm state.
    let starHtml;
    if (s && s.northStar && s.northStar.text) {
      const ns = s.northStar;
      const srcTag = ns.source === 'goal' ? 'your goal' : 'inferred';
      const proposed = ns.status === 'proposed';
      const unconf = proposed ? ' <span class="q-nstag q-unconf" title="the station inferred this — confirm or correct it">unconfirmed</span>' : '';
      // propose-and-confirm: an inferred star is never silently adopted — the Commander confirms (adopt) or
      // corrects (decline → denylisted, re-inferred next cycle). A Commander-set goal needs no verdict.
      const verdictRow = proposed
        ? '<div class="consent-btns q-mt q-ns-verdict">'
          + '<button class="consent-btn q-ns-yes">That’s it ✓</button>'
          + '<button class="consent-btn deny q-ns-no">Not quite</button>'
          + '</div>'
        : '';
      starHtml = '<div class="q-northstar"><span class="q-ns-eyebrow">NORTH STAR &middot; <span class="q-ns-src">' + esc(srcTag) + '</span>' + unconf + '</span>'
        + '<div class="q-ns-text">&#9670; ' + esc(ns.text) + '</div>'
        + (ns.groundedIn ? '<div class="sub q-ns-why">' + esc(ns.groundedIn) + '</div>' : '')
        + verdictRow + '</div>';
    } else {
      starHtml = '<div class="q-northstar"><span class="q-ns-eyebrow">NORTH STAR</span>'
        + '<div class="sub q-ns-text dim">not set yet &mdash; the station learns your long-term goal from your goal arc, dossier, and real activity.</div></div>';
    }
    // LAST OUTCOME — the most recent honest attempt (minted/none/rejected/skipped/error) the refresher recorded.
    const last = s && s.ledger && s.ledger.length ? s.ledger[s.ledger.length - 1] : null;
    const OUTCOME_LABEL = { minted: 'minted a quest', none: 'no new step needed', rejected: 'rejected', skipped: 'skipped', error: 'error' };
    const lastHtml = last
      ? '<div class="sub q-refresh-last"><span class="q-outcome q-oc-' + esc(last.outcome || 'skipped') + '">' + esc(OUTCOME_LABEL[last.outcome] || last.outcome || '—') + '</span> '
          + esc(last.reason || '') + (last.title ? ' &mdash; &ldquo;' + esc(last.title) + '&rdquo;' : '')
          + ' <span class="dim">&middot; ' + esc(qrRel(last.at)) + '</span></div>'
      : '<div class="sub q-refresh-last dim">no refresh has run yet.</div>';
    // DUE — when the next standing cycle lands (or that one is due now). Honest read of the engine's own clock.
    const dueHtml = s
      ? '<div class="sub q-refresh-due dim">' + (s.due ? 'a refresh is due now' : ('next refresh ' + esc(qrRel(s.dueAt)))) + '</div>'
      : '';
    const disabled = (s && !s.enabled);
    const btnLabel = running ? 'REFRESHING&hellip;' : 'REFRESH QUESTS';
    const btn = '<button class="consent-btn q-refresh-btn" ' + (running || disabled ? 'disabled' : '') + '>' + btnLabel + '</button>';
    const disabledNote = disabled ? '<div class="sub dim">the standing refresh is turned off (SKYNET_QUEST_REFRESH=0).</div>' : '';
    return '<div class="gx-sec q-refresh-sec"><span class="gx-title">DIRECTION</span></div>'
      + '<div class="q-refresh-card">' + starHtml
      + '<div class="q-refresh-row">' + btn + dueHtml + '</div>'
      + lastHtml + disabledNote + '</div>';
  }

  function buildQuests(body) {
    const QSS = (typeof QuestStateStore !== 'undefined') ? QuestStateStore : null;
    const SQS = (typeof StationQuestStore !== 'undefined') ? StationQuestStore : null;
    const WQS = (typeof WorkQuestStore !== 'undefined') ? WorkQuestStore : null;
    const MQS = (typeof MaintQuestStore !== 'undefined') ? MaintQuestStore : null;
    const QLS = (typeof QuestLedgerStore !== 'undefined') ? QuestLedgerStore : null;   // QUEST V2 §C: the sidecar ledger's frontend citizen
    if (QLS && QLS.sync) { try { QLS.sync(); } catch (_) {} }   // §C: throttled poll of /api/quests — the last-good cache feeds the projection below
    if (SQS && SQS.sync) { try { SQS.sync(); } catch (_) {} }   // G1b: resolve station gaps before folding, so a just-closed gap renders done + celebrates
    if (WQS && WQS.sync) { try { WQS.sync(); } catch (_) {} }   // G1c: advance/complete work quests before the fold
    if (MQS && MQS.sync) { try { MQS.sync(); } catch (_) {} }   // G1c: mint/clear maintenance quests before the fold
    if (typeof GoalStore !== 'undefined' && GoalStore.sync) { try { GoalStore.sync(); } catch (_) {} }   // Tier 2: retire drift + reconcile completed milestone work before the fold, so the arc meter is never stale
    if (QSS && QSS.sync) { try { QSS.sync(); } catch (_) {} }   // never render a stale diff — the log always reflects the memory it just folded
    const v = (typeof QuestStore !== 'undefined' && QuestStore.view) ? QuestStore.view() : null;
    if (!v) { body.innerHTML = '<p class="dim">Quest log unavailable.</p>'; return; }
    const m = v.meter, all = Array.isArray(v.quests) ? v.quests : [];
    const qs = (QSS && QSS.visible) ? QSS.visible(all) : all;   // dismissed = gone forever (degrades to the raw list if the store is absent)
    const open = qs.filter(q => q.status !== 'done'), done = qs.filter(q => q.status === 'done');
    // a station-gap / work / maintenance quest is a fix-it or build SUGGESTION — always dismissible while open
    // (the sandbox law); each routes through its OWN store's denylist, not QuestState (whose dismiss is
    // dossier-only). Only the get-to-know-you (dossier) kind falls through to QuestState's dismissible check.
    // arc-goal / arc-step (Tier 2) are a persisted GOAL PATH, never a dismissible fix-it: the goal retires only on
    // real drift (the Study engine forgetting its source belief), never by a wave-off — so they fall through the
    // dismissible check entirely.
    // GB-24 — DISMISS EVERYWHERE: every open quest can be waved off. Each kind routes to the store that owns its
    // permanent denylist: station-gap/work/maintenance → their own store; ledger → QuestLedgerStore (backend
    // denylist); everything else QuestState owns (its widened dismissible now returns true for milestone/station/
    // dossier too). arc-goal/arc-step + the idea stay non-dismissible (QSS.dismissible says so — a coupled goal
    // path / the SuggestStore-owned idea are not standalone nags).
    const dismissibleQ = q => q && q.status !== 'done' && (
      (q.kind === 'station-gap') || (q.kind === 'work') || (q.kind === 'maintenance') || (q.kind === 'ledger')
      || (QSS && QSS.dismissible && QSS.dismissible(q)));
    const tro = (q, i) => {
      const glow = QSS && QSS.isCelebrating && QSS.isCelebrating(q.id);
      const dis = dismissibleQ(q);
      // Tier 2 — THE GOAL HEADER: a distinct progress-meter row (a real bar, honest done/total), never actionable,
      // never dismissible. It frames the milestone steps rendered under it.
      if (q.kind === 'arc-goal') {
        const pct = Math.max(0, Math.min(100, q.pct || 0));
        return '<div class="gx-tro arc-goal q-goalbar ' + (q.status === 'done' ? 'on' : 'off') + '" style="--ci:' + (i || 0) + '">'
          + '<div class="q-hd"><span class="gl q-gl-gold">&#9671;</span><span class="nm">' + esc(q.title) + '</span></div>'
          + '<div class="sub">' + esc(q.desc) + '</div>'
          + '<div class="arc-bar q-bar"><div class="q-bar-fill" style="width:' + pct + '%"></div></div>'
          + '</div>';
      }
      // Tier 2 — A MILESTONE STEP: the next OPEN one carries an Accept button (routes through the work-quest path
      // so completing the real work completes the milestone) — UNLESS its bound build is still IN FLIGHT
      // (q.inFlight, fed by GoalStore.questLive): then it reads "in progress" with NO button, so a re-click can
      // never double-mint the build / double-spend a paid run. A stalled/dismissed/dead binding re-offers Accept
      // (the recovery path). Done steps show their evidence; later open steps are shown but not actionable.
      if (q.kind === 'arc-step') {
        const accept = (q.status !== 'done' && q.isNext && !q.inFlight)
          ? '<button class="consent-btn q-arc-accept q-mt" data-gid="' + esc(q.arcGoalId) + '" data-mid="' + esc(q.milestoneId) + '">Accept this step</button>'
          : '';
        return '<div class="gx-tro arc-step q-indent ' + (q.status === 'done' ? 'on' : 'off') + (glow ? ' q-celebrate' : '') + '" style="--ci:' + (i || 0) + '">'
          + '<div class="q-hd"><span class="gl">' + (q.status === 'done' ? '&#9733;' : '&#9675;') + '</span><span class="nm">' + esc(q.title) + '</span></div>'
          + '<div class="sub">' + esc(q.desc) + '</div>' + accept + '</div>';
      }
      // W3: a "build this while I'm away" affordance on an OPEN, buildable quest (an accepted-but-unbuilt
      // pitch/quest). One click queues it onto the focused agent's away-workshop backlog. Only when the
      // grant is on for that agent (else it would queue into a lane the Commander never opened).
      const canQueue = q.status !== 'done' && (q.kind === 'work' || q.kind === 'station-gap') && workshopGrantOn();
      const queueBtn = canQueue
        ? '<button class="q-queue" data-qid="' + esc(q.id) + '" title="Build this while I’m away — queue it for the sandbox">◈</button>'
        : '';
      // §C — a GO affordance where a real, openable destination exists (never invents a window): dossier asks →
      // the Commander dossier; work/build → the TASK BOARD; a floor gap → REFIT. Absent target → no button.
      const goDest = questGoDest(q);
      const goBtn = goDest ? '<button class="q-go" data-dest="' + esc(goDest) + '" title="Open where you do this next">' + esc(GO_LABEL[goDest] || 'GO') + '</button>' : '';
      // §C — EVERY open row answers "what do I do next": the honest completion condition in words.
      const cw = q.status !== 'done' ? questCompletesWhen(q) : '';
      const cwHtml = cw ? '<div class="sub q-cw">✓ completes when: ' + esc(cw) + '</div>' : '';
      // §C — a pending attest (an agent proposed completion with evidence): the awaiting-confirmation badge + the
      // inline Commander verdict. Confirm is single-click (→ done + the QuestState celebration); Not yet declines
      // (→ the quest stays open, a declineNote the agent sees next run). Truthful: only a real pending attest shows.
      const pend = (q.kind === 'ledger' && q.status !== 'done' && q.attest) ? q.attest : null;
      const attestHtml = pend
        ? '<div class="sub q-attest-line">⏳ awaiting your confirmation'
            + (pend.evidence ? ' — &ldquo;' + esc(String(pend.evidence).slice(0, 140)) + '&rdquo;' : '') + '</div>'
          + '<div class="consent-btns q-mt">'
          + '<button class="consent-btn q-attest-yes" data-qid="' + esc(q.id) + '">Confirm &#10003;</button>'
          + '<button class="consent-btn deny q-attest-no" data-qid="' + esc(q.id) + '">Not yet</button>'
          + '</div>'
        : '';
      // §C — a prior declined attest on a still-open ledger quest: show the note so the ask reads honestly.
      const declineHtml = (q.kind === 'ledger' && q.status !== 'done' && !pend && q.declineNote && q.declineNote.note)
        ? '<div class="sub q-note">&#8617; you said not yet: &ldquo;' + esc(String(q.declineNote.note).slice(0, 120)) + '&rdquo;</div>' : '';
      return '<div class="gx-tro ' + (q.status === 'done' ? 'on' : 'off') + (glow ? ' q-celebrate' : '') + '" style="--ci:' + (i || 0) + '">'
        + '<div class="q-hd"><span class="gl">' + (q.status === 'done' ? '&#9733;' : '&#9675;') + '</span><span class="nm">' + esc(q.title) + '</span>'
        + goBtn
        + queueBtn
        + (dis ? '<button class="q-dismiss" data-qid="' + esc(q.id) + '" title="Dismiss — the station will never raise this again">&#10005;</button>' : '')
        + '</div>'
        + '<div class="sub">' + esc(q.status === 'done' ? ('▸ ' + q.reward) : q.desc) + '</div>'
        + cwHtml + attestHtml + declineHtml + '</div>';
    };
    const meterHtml = m
      ? '<div class="gx-sec"><span class="gx-title">STATION</span> <span class="gx-tag">Lv ' + m.level + ' &middot; ' + m.pct + '% to next &middot; ' + esc(String(m.confLabel) + ' ' + String(m.band)) + '</span></div>'
      : '';
    // G4 feature 2 — PROPOSALS: pending autojob proposals the agent pinned to the MISSION BOARD. A distinct
    // amber card with APPROVE (→ the real POST /api/cron) / DECLINE (→ dropped forever). Rendered above OPEN so
    // the "the agent wants to run this for you" ask reads first. Only shown when the ledger has cards.
    const AJS = (typeof AutoJobStore !== 'undefined' && AutoJobStore.pendingList) ? AutoJobStore : null;
    const proposals = AJS ? AJS.pendingList() : [];
    const propRow = p => '<div class="gx-tro off gx-proposal q-goalbar">'
      + '<div class="q-hd"><span class="gl q-gl-gold">&#9873;</span><span class="nm">' + esc(p.title) + '</span></div>'
      + '<div class="sub">' + esc(p.why || 'a standing job the agent proposes running for you on a schedule.') + '</div>'
      + '<div class="consent-btns q-mt">'
      + '<button class="consent-btn q-prop-yes" data-pid="' + esc(p.id) + '">Approve</button>'
      + '<button class="consent-btn deny q-prop-no" data-pid="' + esc(p.id) + '">Decline</button>'
      + '</div></div>';
    const proposalsHtml = proposals.length
      ? '<div class="gx-sec"><span class="gx-title">PROPOSALS</span> <span class="gx-tag">' + proposals.length + '</span></div>'
        + '<div class="gx-tros">' + proposals.map(propRow).join('') + '</div>'
      : '';
    body.innerHTML = '<div class="gx gx-quests">'
      + meterHtml
      + questRefreshHtml()
      + '<div class="dim" style="margin:4px 0 10px;">every quest pays out in real capability or work &mdash; never points. nothing here is locked; the order just shows what tends to come next.</div>'
      + proposalsHtml
      + '<div class="gx-sec"><span class="gx-title">OPEN</span> <span class="gx-tag">' + open.length + '</span></div>'
      + '<div class="gx-tros q-grid q-open">' + (open.map(tro).join('') || '<p class="dim">all caught up.</p>') + '</div>'
      + '<div class="gx-sec"><span class="gx-title">DONE</span> <span class="gx-tag">' + done.length + '</span></div>'
      + '<div class="gx-tros q-grid q-done">' + (done.map(tro).join('') || '<p class="dim">nothing yet.</p>') + '</div>'
      + '</div>';
    // G4 feature 2: approve → the real cron POST (AutoJobStore routes it), then re-render (the card clears);
    // decline → drop the card forever. Both route through AutoJobStore's own paths — no new scheduling logic here.
    body.querySelectorAll('.q-prop-yes').forEach(b => b.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (!AJS || !AJS.acceptPending) return;
      b.disabled = true;
      const r = await AJS.acceptPending(b.dataset.pid);
      if (r && r.ok) { sfx('click'); }
      // ARM-STATE truth: acceptPending reports {disarmed:{text}} when the scheduler that fires this
      // routine is off — surface it here too (the Dialogue flow already does), never approve-and-silence.
      if (r && r.ok && r.disarmed && r.disarmed.text) notify(r.disarmed.text, 'warn');
      rerender('quests');
    }));
    body.querySelectorAll('.q-prop-no').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      if (!AJS || !AJS.declinePending) return;
      if (AJS.declinePending(b.dataset.pid)) { sfx('click'); rerender('quests'); }
    }));
    // dismissed = stop forever: the row vanishes now and never comes back (and the curiosity nudge for a
    // waved-off dimension stops with it — QuestStateStore.dismiss carries the one anti-nag law end to end).
    // Slice 5 (Lane B): permanent by design, so it's a 2-STEP arm/confirm (shared ArmConfirm helper, ~4s
    // auto-disarm) — one misclick can no longer nuke a build plan. The glyph arms to "dismiss forever — sure?".
    body.querySelectorAll('.q-dismiss').forEach(b => {
      const doDismiss = ev => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        const q = qs.find(x => x && x.id === b.dataset.qid);
        if (!q) return;
        // §C — a LEDGER quest dismisses on the sidecar (backend denylist). It's async: fire the POST, then
        // re-render once the store's forced refetch drops the row from its cache (optimistic click feedback now).
        if (q.kind === 'ledger') {
          if (QLS && QLS.dismiss) { sfx('click'); QLS.dismiss(q.id).then(() => rerender('quests')); }
          return;
        }
        // each fix-it/build kind routes to its OWN permanent denylist; dossier/milestone/station go through QuestState.
        const took = (q.kind === 'station-gap') ? (SQS && SQS.dismiss && SQS.dismiss(q.id))
          : (q.kind === 'work') ? (WQS && WQS.dismiss && WQS.dismiss(q.id))
          : (q.kind === 'maintenance') ? (MQS && MQS.dismiss && MQS.dismiss(q.id))
          : (QSS && QSS.dismiss && QSS.dismiss(q));
        if (took) { sfx('click'); rerender('quests'); }
      };
      if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) {
        // arming shouldn't bubble to the tile; keep restLabel = the ✕ glyph so disarm restores it.
        b.addEventListener('click', ev => { if (ev && ev.stopPropagation) ev.stopPropagation(); });
        ArmConfirm.wire(b, { armedLabel: 'dismiss forever — sure?', timeoutMs: 4000, onConfirm: doDismiss });
      } else {
        b.addEventListener('click', doDismiss);   // fallback: immediate (helper absent)
      }
    });
    // W3 — BUILD THIS WHILE I'M AWAY: queue the quest onto the hero's away-workshop backlog (POST
    // /api/workshop/queue via WorkshopStore). One click; a notice confirms. Never launches a live run —
    // it hands the idea to the sandbox for an unattended shift to pick up.
    body.querySelectorAll('.q-queue').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      const q = qs.find(x => x && x.id === b.dataset.qid);
      if (!q) return;
      if (typeof WorkshopStore === 'undefined' || !WorkshopStore.queue) { notify('away workshop unavailable', 'bad'); return; }
      b.disabled = true;
      const text = q.title + (q.desc ? ' — ' + q.desc : '');
      WorkshopStore.queue({ agentId: (heroAgent() && heroAgent().id) || 'agent', text: text, sourceType: 'quest', sourceId: q.id }).then(res => {
        if (res && res.ok) { sfx('click'); notify('◈ queued for the away workshop — it’ll be built in the sandbox while you’re away', 'good'); }
        else { b.disabled = false; notify('could not queue: ' + ((res && res.error) || 'refused'), 'bad'); }
      });
    }));
    // Tier 2 — ACCEPT a milestone step: route the next open milestone through the work-quest path (a real run
    // launches; completing THAT work completes the milestone and chains the next). No manual tick.
    body.querySelectorAll('.q-arc-accept').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      if (typeof GoalStore === 'undefined' || !GoalStore.acceptMilestone) return;
      const m = GoalStore.acceptMilestone(b.dataset.gid, b.dataset.mid);
      if (m) { sfx('click'); rerender('quests'); }
    }));
    // §C — GO: open the existing surface where this quest's next move happens (never a new window). openTerm is
    // idempotent (restores a minimized panel, no-ops if already open); a floor gap opens REFIT via Build.open.
    body.querySelectorAll('.q-go').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      const d = b.dataset.dest;
      if (d === 'refit') { if (typeof Build !== 'undefined' && Build.open) { try { Build.open(); } catch (_) {} } }
      else if (d) openTerm(d);
      sfx('click');
    }));
    // §C — ATTEST VERDICT: the Commander's single-click confirm / decline on a ledger quest the agent reported
    // done. Both route through QuestLedgerStore.confirm (yes → done + the QuestState celebration on the next
    // fold; no → the quest stays open with a declineNote). The store refetches immediately; then we re-render.
    body.querySelectorAll('.q-attest-yes').forEach(b => b.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (!QLS || !QLS.confirm) return;
      b.disabled = true;
      const r = await QLS.confirm(b.dataset.qid, true);
      if (r && r.ok) sfx('click'); else { b.disabled = false; notify('could not record that verdict', 'bad'); }
      rerender('quests');   // the QuestState fold in buildQuests fires the completion celebration for the now-done quest
    }));
    body.querySelectorAll('.q-attest-no').forEach(b => b.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (!QLS || !QLS.confirm) return;
      b.disabled = true;
      const r = await QLS.confirm(b.dataset.qid, false);   // decline: not destructive — the quest stays open, the agent sees the note next run
      if (r && r.ok) sfx('click'); else b.disabled = false;
      rerender('quests');
    }));
    // QUEST V3 — REFRESH QUESTS: force a standing-refresh cycle NOW (POST /api/quests/refresh/run). Honest
    // feedback: the button reports whether a cycle actually launched, or the reason it didn't (already running
    // / disabled). The outcome (minted N / rejected: why / skipped: why) lands in the ledger the panel shows —
    // a re-render on completion surfaces it. Never claims a mint the engine didn't make (truthful telemetry).
    const refreshBtn = body.querySelector('.q-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (typeof QuestRefreshStore === 'undefined' || !QuestRefreshStore.run) return;
      refreshBtn.disabled = true; refreshBtn.innerHTML = 'REFRESHING&hellip;';
      const r = await QuestRefreshStore.run();
      if (r && r.started) { sfx('click'); notify('◆ refreshing quests — the station is re-deriving your direction', 'gold'); }
      else { notify('refresh not started: ' + ((r && r.error) || 'unavailable'), 'warn'); }
      // the cycle is async on the server; re-render now (shows inFlight + the launch), then again shortly so the
      // recorded outcome (mint/reject/skip reason) lands in the panel without the Commander re-opening it.
      rerender('quests');   // no-op if the panel was closed meanwhile (rerender guards on open[key])
      if (r && r.started) setTimeout(() => { try { rerender('quests'); } catch (_) {} }, 3500);
    });
    // QUEST V3 — NORTH STAR verdict: confirm (adopt the inferred star) or correct (decline → denylisted, the
    // station re-infers next cycle). Both route through QuestRefreshStore.verdict → POST /northstar, then re-render
    // so the "unconfirmed" tag clears (confirm) or the star reverts (decline). Truthful: only a real proposal shows these.
    const nsYes = body.querySelector('.q-ns-yes'), nsNo = body.querySelector('.q-ns-no');
    const wireVerdict = (btn, decision, tone) => { if (!btn) return; btn.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (typeof QuestRefreshStore === 'undefined' || !QuestRefreshStore.verdict) return;
      btn.disabled = true;
      const r = await QuestRefreshStore.verdict(decision);
      if (r && r.ok) { sfx('click'); notify(decision === 'confirm' ? '◆ north star confirmed — quests will steer by it' : '↩ got it — the station will re-read your direction', tone); }
      else { btn.disabled = false; notify('could not record that', 'bad'); }
      rerender('quests');
    }); };
    wireVerdict(nsYes, 'confirm', 'gold');
    wireVerdict(nsNo, 'decline', 'warn');
  }

  /* ============== lifecycle ============== */
  const BUILDERS = {
    agents:   ['AGENT DOSSIER',          buildAgents,    { console: true, feature: true }],
    commander:['COMMANDER DOSSIER',      buildCommander, { w: '760px' }],
    skills:   ['SKILLS & CAPABILITIES',  buildSkills,    { console: true }],
    tasks:    ['TASK BOARD',             buildTasks,     { w: '760px' }],
    deliverables:['DELIVERABLES',         body => { if (typeof Deliverables !== 'undefined') Deliverables.mount(body); }, { w: '760px' }],
    updates:  ['UPDATE CENTER',          buildUpdates,   { w: '540px' }],
    settings: ['SETTINGS',               buildSettings,  { console: true }],
    notifs:   ['NOTIFICATIONS',          buildNotifs,    { w: '460px' }],
    // the FIELD MANUAL codex is owned by tutorial.js (P3); this term just hosts its builder
    manual:   ['FIELD MANUAL',           body => { if (typeof Tutorial !== 'undefined' && Tutorial.fillFieldManual) Tutorial.fillFieldManual(body); }, { w: '640px' }],
    quests:   ['QUEST LOG',              buildQuests,    { w: '560px' }],
  };

  /* ============== EXTRACTED-WINDOW SEAM (frontend/app/windows/*.js) ==============
     Per-window builders extracted out of this file register themselves here at load time —
     their <script> tags follow stationui.js in index.html, and init()/openTerm() resolve
     BUILDERS[key] lazily at click time, so a registration landing after this file parses is
     always in place before any window can open. registerWindow is additive: same slot shape
     ([title, buildFn, opts]) the inline entries above use.
     StationUI.h is the DELIBERATE, enumerated helper surface those extracted files may close
     over — nothing else in this closure is reachable from outside. Mutable core state
     (present / sel / store) is exposed as getters so an extracted builder always reads the
     LIVE value; sel writes stay in core (wireRosterSwitch). Do not grow this surface
     casually: anything sharing mutable state with the 1s tick / ctx gauge / notifications
     stays in this file instead of being extracted. */
  function registerWindow(key, title, buildFn, opts) { BUILDERS[key] = [title, buildFn, opts || {}]; }
  const h = {
    // dom + format primitives
    esc, mkEl, sfx, clock, ts, fmtRel,
    // hud + window plumbing
    notify, toast, mountConsole, rerender, openTerm, openSignIn,
    // shared window fragments (roster switcher for the per-agent windows; dossier memory loader)
    rosterSwitchHtml, wireRosterSwitch, loadMemoryCore,
    // workstream + persistence seams
    WS, persistWS, save, consoleSection,
    // live core state (read-only views — never reassign through these)
    get present() { return present; },
    get sel() { return sel; },
    get store() { return store; }
  };

  function init() {
    applySettings();
    document.querySelectorAll('.bb[data-term]').forEach(b =>
      b.addEventListener('click', () => {
        const k = b.dataset.term, def = BUILDERS[k];
        if (def) toggleTerm(k, def[0], def[1], def[2]);
      }));
    badges();
  }

  // OPEN (never toggle-closed) a dock term by key — used by deep links like the COMMS error chip that
  // points a beginner at Settings (fix your model key) or SKILLS (enable a capability). No-op if unknown;
  // if the panel is already open it's left as-is rather than closed.
  function openTerm(key, section) {
    const def = BUILDERS[key]; if (!def) return;
    // optional section arg (Lane A error-door routing): land the console rail on a specific section — same
    // mechanism as the dossier's "jump to CONFIG" (consoleSection is what mountConsole reads at render).
    if (section) consoleSection[key] = section;
    if (open[key]) { if (minimized[key]) restoreTerm(key); if (section) rerender(key); return; }   // minimized → restore, not duplicate
    toggleTerm(key, def[0], def[1], def[2]);
  }

  // the sidecar's bare-string 'notify' bus event (shared/events.js; rides the SSE bridge → U.bus) → one
  // persistent HUD notification. Sole emitter today is the night shift's draft-delivery (immediate
  // while-you-were-away visibility). Category 'cronDigest' so the autonomous-run mute toggle is honored.
  let notifyLiveWired = false;
  function wireNotifyLive() {
    if (notifyLiveWired || typeof U === 'undefined' || !U.bus) return;
    notifyLiveWired = true;
    U.bus.on('notify', s => { if (typeof s === 'string' && s) notify(s, 'gold', 'cronDigest'); });
  }

  // called when entering the game room with the live agent(s)
  // one-shot: fold any legacy starnet.station.v1 kanban cards into real workstreams, then retire tasks[].
  // Guarded by a persisted flag so a refresh never re-imports / duplicates the cards. Runs from enter(),
  // which is called during app.js init() while `const App` is still in its TDZ — so this must NOT touch
  // App. The imported workstreams are written to starnet.save by the trailing persist() in resumeInto/onWake
  // (a direct in-scope call), which always follows enterGame; here we only update our own station store.
  function importLegacyTasks() {
    if (store.tasksImported) return;
    const w = WS();
    if (w && Array.isArray(store.tasks) && store.tasks.length) w.importTasks(store.tasks);
    store.tasks = [];
    store.tasksImported = true;
    save();
  }

  function enter(agents, accessors) {
    present = Array.isArray(agents) ? agents : (agents ? [agents] : []);
    access = accessors || {};
    runningAgents.clear(); runSeenAt.clear();   // fresh station view — never inherit stale run-state across a (re)connect
    sel = 0;
    importLegacyTasks();
    crewRender();
    wireCompactBeat();
    wireNotifyLive();
    tick();
    if (!started) { started = true; tickTimer = setInterval(tick, 1000); }
  }

  // update the live roster WITHOUT re-running enter's one-time setup (legacy-task import, timer) — used
  // after a SUMMON adds a crew member so the crew panel + an open dossier reflect the new agent immediately.
  function setRoster(agents) {
    present = Array.isArray(agents) ? agents : (agents ? [agents] : []);
    if (sel >= present.length) sel = 0;
    crewRender();
    if (open.agents) rerender('agents');
    if (open.routines) rerender('routines');
  }

  /* ============== ARCADE CABINET ==============
     Clicking an arcade cabinet in the world opens BREACH PROTOCOL — the playable
     Space-Invaders descendant ported verbatim from v7 (js/arcade.js). It mounts a
     live canvas into a floating window; _onClose tears the game loop down so closing
     the window stops the RAF + releases the global key handlers. */
  function openArcade() {
    if (typeof ARCADE === 'undefined') return;
    toggleTerm('arcade', 'QUARTERS ▪ ARCADE — BREACH PROTOCOL', body => {
      body.innerHTML = ARCADE.shell();
      ARCADE.mount(body);
    }, { w: '430px', onClose: () => { try { ARCADE.unmount(); } catch (_) {} } });
  }

  // called on disconnect — tear down floating windows, keep persisted state
  function leave() {
    Object.keys(open).forEach(k => closeTerm(k));
    runningAgents.clear(); runSeenAt.clear();   // a disconnect abandons in-flight streams (their run.end won't arrive) — reset
  }

  /* the phosphor theme picked on the COMMISSION CONSOLE writes through HERE so it survives enterGame:
     StationUI captures `store` once at module-load, so a bare localStorage write would be clobbered by the
     stale in-memory copy when applySettings() runs on enter. Routing through the live store + save() keeps
     the create-screen pick and the in-game Settings panel as one source of truth. */
  function setTheme(t) {
    const ok = t === 'custom' || THEMES.some(([name]) => name === t); if (!ok) return;
    store.settings.theme = t;
    const hs = PRESET_HS[t];   // keep the CUSTOM sliders in lockstep with a preset picked at commission
    if (hs) { store.settings.themeHue = hs[0]; store.settings.themeSat = hs[1]; }
    applySettings(); save();
  }
  function getTheme() { return store.settings.theme; }

  // GROWTH Tier 3: repaint the Settings AUTONOMY panel's EARNED badge if it is open (no-op otherwise — the paint fn
  // queries its own (possibly detached) host nodes, so a closed panel costs nothing). Called after a trust accept.
  const repaintAutonomy = () => { try { if (repaintAutonomyDial) repaintAutonomyDial(); } catch (_) {} };
  return { init, enter, setRoster, leave, clearRunning, runningCount: () => runningAgents.size, isAgentRunning: (id) => agentLive(id), notify, flashSave, openAgent, openArcade, toggleTerm, openTerm, rerender, refreshBoard: () => rerender('tasks'), pokeQuests, setTheme, getTheme, repaintAutonomy, registerWindow, h };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { visibleTerminalRect, clampTerminalSize };
