/* STARNET — stationui.js : the station-management HUD.
   Ports the v7 pip-boy chrome (floating terminal windows, crew manifest,
   bottom-bar panels) but wires every readout to REAL harness data — the
   present agent, the current measured context window, the real tool
   surface, a real persisted task board. No simulated numbers, no fake
   progress bars (truthful-telemetry mandate). State that the user owns
   (task board · UI settings · notifications) persists to localStorage. */
'use strict';

const StationUI = (() => {
  const $ = s => document.querySelector(s);
  const esc = s => U.esc(String(s == null ? '' : s));
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const sfx = n => { try { if (typeof SFX === 'object' && SFX[n]) SFX[n](); } catch (_) {} };

  const KEY = 'starnet.station.v1';
  const THEMES = [['amber', '#ffaa33'], ['green', '#3dff70'], ['blue', '#46c8ff'], ['purple', '#b46bff'], ['red', '#ff4136'], ['white', '#e8f0e8']];

  let present = [];          // agent objects currently on the station
  const runningAgents = new Map();   // agentId -> live-run COUNT (concurrent streams can share an agentId, e.g. 'agent')
  let crewLiveWired = false;         // the crew-status live listener is registered exactly once
  let lastStageSummary = '';         // #8: last screen-reader summary text, so we only update the live region on change
  let access = {};           // { totals(), activity() } injected by app.js
  let sel = 0;               // selected agent index (dossier / crew)
  let routineAgentId = 'agent'; // selected roster agent for new scheduled routines
  let tickTimer = 0;
  const open = {};           // key -> open terminal-window element (stays populated while minimized)
  const minimized = {};      // key -> true while the window is minimized to the strip (element kept alive, hidden)
  let started = false;

  /* ---------- persistence (user-owned UI state) ---------- */
  function defaults() { return { theme: 'amber', scanlines: true, flicker: true, sound: true, music: true, keepComputerAwake: false }; }
  function blank() { return { v: 1, settings: defaults(), tasks: [], notifs: [] }; }
  function load() {
    try {
      const r = JSON.parse(localStorage.getItem(KEY));
      if (r && r.v === 1) {
        r.settings = Object.assign(defaults(), r.settings || {});
        if (!Array.isArray(r.tasks)) r.tasks = [];
        if (!Array.isArray(r.notifs)) r.notifs = [];
        return r;
      }
    } catch (_) {}
    return blank();
  }
  let store = load();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (_) {} }
  const uid = p => p + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

  /* ---------- settings → DOM ---------- */
  function applySettings() {
    const s = store.settings;
    document.body.classList.remove('theme-amber', 'theme-green', 'theme-blue', 'theme-purple', 'theme-red', 'theme-white');
    document.body.classList.add('theme-' + s.theme);
    document.body.classList.toggle('no-scan', !s.scanlines);
    document.body.classList.toggle('no-flicker', !s.flicker);
    if (typeof SFX === 'object') SFX.on = !!s.sound;
    if (typeof MUSIC === 'object') MUSIC.on = (s.music !== false);   // default-on adaptive score; arms on first gesture
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

  /* ---------- activity labels (real World.setActivity state) ---------- */
  function activity() { try { return (access.activity && access.activity()) || 'idle'; } catch (_) { return 'idle'; } }
  function totals() { try { return (access.totals && access.totals()) || { tokens: 0, cost: 0, calls: 0 }; } catch (_) { return { tokens: 0, cost: 0, calls: 0 }; } }
  function crewStatus(act) {
    return act === 'task' ? 'working at the terminal'
      : act === 'talk' ? 'in conversation'
      : 'idle — awaiting orders';
  }
  function pillFor(act) {
    return act === 'task' ? ['WORKING', 'working']
      : act === 'talk' ? ['THINKING', 'thinking']
      : ['ONLINE', ''];
  }

  /* ============== FLOATING TERMINAL WINDOWS (ported v7 ui.js) ============== */
  let termDrag = null;
  let termTitleSeq = 0;   // a11y: gives each window's title a unique id for aria-labelledby
  // a11y: the tabbable controls inside a window, in DOM order, that are actually visible.
  function termFocusables(w) {
    if (!w) return [];
    return Array.from(w.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'))
      .filter(e => e.offsetWidth > 0 || e.offsetHeight > 0 || e === document.activeElement);
  }
  const termPos = {};   // key -> {left,top} remembered drag position — kills the dead-center pile-up
  window.addEventListener('mousemove', ev => {
    if (termDrag) {
      termDrag.moved = true;   // real drag movement — a dblclick-to-minimize must not fire after a drag
      const w = termDrag.w, ww = termDrag.ww;
      // clamp so the title bar can never be dragged off-screen (lost window): keep >=64px of the panel
      // horizontally on each edge and the header row always reachable. (ww/wh cached at grab — no layout read.)
      const nl = Math.max(64 - ww, Math.min(ev.clientX - termDrag.dx, window.innerWidth - 64));
      const nt = Math.max(0, Math.min(ev.clientY - termDrag.dy, window.innerHeight - 36));
      w.style.left = nl + 'px';
      w.style.top = nt + 'px';
      w.style.transform = 'none';
    }
  });
  window.addEventListener('mouseup', () => {
    // remember where the Commander parked this panel so it re-opens there, not back at dead-center
    if (termDrag) {
      const w = termDrag.w, k = Object.keys(open).find(key => open[key] === w);
      if (k && termDrag.moved) termPos[k] = { left: w.offsetLeft, top: w.offsetTop };
      w._lastDragMoved = !!termDrag.moved;   // let dblclick-to-minimize know if this grab was actually a drag
    }
    termDrag = null;
  });

  // Land a freshly-opened window in a tidy left-anchored column, CASCADING each so stacked panels
  // never bury each other (the old default was every .term at left:50%/top:50% — instant pile-up).
  // A remembered drag position always wins. Clamped to the viewport so nothing opens off-screen.
  function placeTerm(w, key) {
    const p = termPos[key];
    if (p) { w.style.left = p.left + 'px'; w.style.top = p.top + 'px'; w.style.transform = 'none'; return; }
    const prior = Math.max(0, Object.keys(open).length - 1);   // how many were already open
    if (prior === 0) {
      // SINGLE window = the focal point: let CSS center it (left/top:50% + translate(-50%,-50%) with a
      // capped max-height), which is ALWAYS on-screen even for tall panels like Settings. We must NOT
      // measure offsetHeight here and pin an inline top: placeTerm runs before the body content (and the
      // power-on animation) settles, so the height read is header-only (~54px) — centering for that pushed
      // tall modals ~200px off the bottom of the viewport. Leaving the CSS centering in place fixes that.
      return;
    }
    // 2nd+ window: cascade off the corner so stacked panels never bury each other.
    const wpx = w.offsetWidth || 480, hpx = w.offsetHeight || 320;
    const baseL = 92, baseT = 80, step = 30, span = 6;
    let left = baseL + (prior % span) * step;
    let top  = baseT + (prior % span) * step;
    left = Math.max(8, Math.min(left, window.innerWidth  - wpx - 8));
    top  = Math.max(8, Math.min(top,  window.innerHeight - hpx - 8));
    w.style.left = left + 'px'; w.style.top = top + 'px'; w.style.transform = 'none';
  }
  function fitTermInViewport(w) {
    if (!w) return;
    const pad = 8;
    const maxLeft = Math.max(pad, window.innerWidth - w.offsetWidth - pad);
    const maxTop = Math.max(pad, window.innerHeight - w.offsetHeight - pad);
    w.style.left = Math.max(pad, Math.min(w.offsetLeft, maxLeft)) + 'px';
    w.style.top = Math.max(pad, Math.min(w.offsetTop, maxTop)) + 'px';
    w.style.transform = 'none';
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
    if (any && !s) { s = el('div', 'term-scrim'); s.id = 'term-scrim'; host.insertBefore(s, host.firstChild); }
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
    strip = el('div', 'term-strip'); strip.id = 'term-strip';
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
    const chip = el('button', 'term-chip');
    chip.dataset.key = key;
    chip.type = 'button';
    chip.setAttribute('aria-label', 'Restore ' + title);
    chip.title = 'Restore ' + title;
    chip.innerHTML = '<span class="term-chip-led" aria-hidden="true"></span>' +
      '<span class="term-chip-t">' + esc(title) + '</span>';
    chip.addEventListener('click', () => { sfx('click'); restoreTerm(key); });
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
      const trig = document.querySelector('.bb[data-term="' + CSS.escape(key) + '"]');
      try { (trig && trig.focus) ? trig.focus() : (active.blur && active.blur()); } catch (_) {}
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
    const clearRestore = () => w.classList.remove('term-restoring');
    w.addEventListener('animationend', clearRestore, { once: true });
    setTimeout(clearRestore, 460);
    // focus back into the window (first control, or the window itself)
    const f0 = termFocusables(w);
    try { (f0[0] || w).focus(); } catch (_) {}
    syncScrim();
    syncBB();
  }
  function closeTerm(key) {
    if (open[key]) {
      const w = open[key];
      if (w._closing) return;   // guard the Esc + ✕ + toggle double-close race
      w._closing = true;
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
  function toggleTerm(key, title, builder, opts) {
    // a minimized window's dock button RESTORES it (never rebuilds, never closes); a visible one toggles closed.
    if (open[key]) { if (minimized[key]) restoreTerm(key); else closeTerm(key); return; }
    // Mode-exclusivity: a dock panel and full-screen REFIT must never be mounted at once.
    // Opening a panel exits refit first so two features can't stack (see COHERENCE_MATRIX dim T).
    if (typeof Build !== 'undefined' && Build.isOpen && Build.isOpen()) { try { Build.close(); } catch (_) {} }
    sfx('open');
    // a11y: remember who opened this so focus can return there on close (the dock item / trigger).
    const opener = (typeof document !== 'undefined' && document.activeElement) || null;
    const w = el('div', 'term');
    w.style.zIndex = U.zTop();
    if (opts && opts.w) w.style.width = opts.w;
    if (opts && opts.className) w.classList.add(opts.className);
    w._onClose = opts && opts.onClose;
    w._opener = opener;
    // a11y: a floating window is a real modal dialog — label it by its title, make it focusable.
    const titleId = 'term-title-' + (++termTitleSeq);
    w.setAttribute('role', 'dialog');
    w.setAttribute('aria-modal', 'true');
    w.setAttribute('aria-labelledby', titleId);
    w.tabIndex = -1;
    // Phase-2 chrome: a subtle status LED at the head's left + the inverted title chip. The LED reads as
    // "this window is live" — pure decoration (static ok-green), pointer-events off so it never eats the drag.
    const head = el('div', 'term-head',
      '<span class="term-led" aria-hidden="true"></span>' +
      '<span class="term-title" id="' + titleId + '">' + title + '</span>');
    // minimize control — sits left of ✕. Collapses the window to a strip chip (keeps it logically open).
    const mn = el('button', 'term-min', '–');
    mn.setAttribute('aria-label', 'Minimize ' + title);
    mn.setAttribute('type', 'button');
    mn.addEventListener('click', ev => { ev.stopPropagation(); minimizeTerm(key); });
    head.appendChild(mn);
    const x = el('button', 'term-x', '✕');
    x.setAttribute('aria-label', 'Close ' + title);
    x.addEventListener('click', () => closeTerm(key));
    head.appendChild(x);
    const body = el('div', 'term-body');
    if (opts && opts.feature) {
      // hero "feature window": wrap the screen in a molded monitor casing
      w.classList.add('feature');
      const screen = el('div', 'term-screen');
      screen.appendChild(head); screen.appendChild(body);
      w.appendChild(screen);
      w.appendChild(el('div', 'term-plate',
        '<span>STARNET DYNAMICS</span><span class="term-knobs"><i class="knob"></i><i class="knob"></i></span>'));
    } else {
      w.appendChild(head); w.appendChild(body);
      // Phase-2 chrome (generic, plain windows only — feature windows carry their own casing):
      //   · four corner L-brackets + a faint top light-grade overlay for glass depth (both pointer-events:none)
      //   · a thin footer plate (status text left, grip dots right). All purely cosmetic — appended AFTER the
      //     body so they never disturb the focus-trap order (term-x remains the last focusable control).
      const chrome = el('div', 'term-chrome');
      chrome.setAttribute('aria-hidden', 'true');
      chrome.innerHTML =
        '<span class="term-brk tl"></span><span class="term-brk tr"></span>' +
        '<span class="term-brk bl"></span><span class="term-brk br"></span>' +
        '<span class="term-grade"></span>';
      w.appendChild(chrome);
      w.appendChild(el('div', 'term-foot',
        '<span class="term-foot-d" aria-hidden="true"></span>' +
        '<span class="term-foot-k">' + esc(String(key).toUpperCase()) + '</span>' +
        '<span class="term-foot-sp"></span>' +
        '<span class="term-foot-grip" aria-hidden="true">···</span>'));
    }
    $('#terms').appendChild(w);
    open[key] = w;
    placeTerm(w, key);   // land in a cascaded slot (or its remembered spot) — never dead-center pile-up
    w.addEventListener('mousedown', () => { w.style.zIndex = U.zTop(); });
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
      const r = w.getBoundingClientRect();
      w.style.left = r.left + 'px';
      w.style.top = r.top + 'px';
      w.style.transform = 'none';
      w.classList.add('term-moved');   // close animation must not re-centre a dragged window
      // cache size once at grab (it can't change mid-drag) so the move handler never forces a layout read.
      termDrag = { w, dx: ev.clientX - r.left, dy: ev.clientY - r.top, ww: r.width, wh: r.height };
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
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeTerm(key); return; }
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
      if (opts && opts.fitViewport) requestAnimationFrame(() => fitTermInViewport(w));
    };
    w._render();
    // a11y: move focus into the freshly-opened dialog — the first control, or the window itself.
    const f0 = termFocusables(w);
    try { (f0[0] || w).focus(); } catch (_) {}
    syncBB(); syncScrim();
  }
  function rerender(key) { if (open[key]) open[key]._render(true); }
  function syncBB() {
    document.querySelectorAll('.bb[data-term]').forEach(b => b.classList.toggle('active', !!open[b.dataset.term]));
  }

  /* ============== CREW MANIFEST (left panel) ============== */
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
      '<li class="crew-row" data-i="' + i + '" data-agent-id="' + a.id + '" style="--ci:' + i + '">' +
      '<span class="dot on"></span>' +
      '<div class="crew-main">' +
      '<div class="crew-name" style="color:' + a.color + '">' + esc(a.name) +
      '<span class="crew-room">HAB-01' + (a.stats && a.stats.level ? ' · Lv ' + a.stats.level : '') + '</span></div>' +
      '<div class="crew-status" id="cs-' + a.id + '">…</div>' +
      // in-flight work bar: hidden until the row is .working (crewTick toggles it from the real run state).
      // The shimmer (.bar-active) reads as live activity; it's an indeterminate sweep, not a % readout.
      '<div class="crew-prog bar-active" id="cp-' + a.id + '" aria-hidden="true"><div></div></div>' +
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
    for (const id of Array.from(runningAgents.keys())) { if (!present.some(a => a.id === id)) runningAgents.delete(id); }
    const act = activity();
    let working = 0;
    present.forEach(a => {
      const live = runningAgents.has(a.id);
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
  // crewTick's runningAgents.has(id) stays a clean "is this agent working?" test.
  function incRun(id) { runningAgents.set(id, (runningAgents.get(id) || 0) + 1); }
  function decRun(id) { const n = (runningAgents.get(id) || 0) - 1; if (n > 0) runningAgents.set(id, n); else runningAgents.delete(id); }
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
  let agTab = 'brief';      // 'brief' | 'growth' | 'memory' | 'skills' | 'config'
  const agEdit = {};        // config fileKey -> true while its editor is open
  let memLiveWired = false, memRefreshTimer = 0;   // M-mem.6: the once-wired, debounced Memory Core live-refresh

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
    const dotCls = act === 'task' ? 'working' : act === 'talk' ? 'thinking' : 'on';
    const statusText = act === 'task' ? 'WORKING' : act === 'talk' ? 'THINKING' : 'ONLINE';
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
      '<div class="ag-name" style="color:' + a.color + '">' + esc(a.name) + (lv ? '<span class="ag-lv">Lv ' + lv + '</span>' : '') + '</div>' +
      '<div class="ag-role-line"><span class="ag-sdot ' + dotCls + '"></span>' + statusText + ' · HAB-01</div>' +
      '<div class="ag-tags">' +
      // the agent's deployed SPECIALTY (set by the Recruitment Bay) — its primary "what it's FOR" identity, shown first.
      ((typeof Specialties !== 'undefined' && a.specialtyId) ? (function () { var s = Specialties.get(a.specialtyId); return s ? '<span class="tag">' + esc(s.emoji + ' ' + s.name) + '</span>' : ''; })() : '') +
      '<span class="tag model">' + esc(a.model || '—') + '</span>' +
      '</div></div></div>';
  }

  function agBrief(a) {
    const t = totals();
    const since = a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '—';
    // BRIEF stat wells — compact 3-up readout from data already on the agent (no new API calls):
    // RUNS (station totals), LEVEL (pure Xp engine), and positive feedback / XP-to-next when known.
    // The full Level/XP/Satisfaction/milestone readout still lives in the GROWTH tab.
    const g = (typeof Xp !== 'undefined' && a.stats) ? Xp.compute(a.stats) : null;
    const lvl = g ? g.level : '—';
    const kudos = g ? g.positiveFeedback : 0;
    return '<div class="stat-grid">' +
      '<div class="stat-cell"><div class="stat-val">' + (t.calls || 0) + '</div><div class="stat-lbl">RUNS</div></div>' +
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
      '</div>';

    const confnum = g.known ? (g.confidence + '<span style="font-size:18px;color:var(--ph-dim);">%</span>') : '—';
    const gauge = '<div class="gx-gauge"><div class="gx-zones"><i></i><i></i><i></i><i></i></div>' +
      (g.known ? '<div class="gx-mark" style="left:' + g.confidence + '%;background:' + mark + ';"></div>' +
                 '<div class="gx-marknum" style="left:' + g.confidence + '%;">' + g.confidence + '</div>' : '') +
      '</div>';
    const confidence =
      '<div>' +
      '<div class="gx-sec"><span class="gx-ref">B</span><span class="gx-title">Satisfaction</span><span class="gx-tag">FEEDBACK EWMA &middot; n' + (g.known ? '&ge;' + Xp.MIN_SAMPLES : '=' + g.samples) + '</span></div>' +
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
    const card = el('div', 'mc-rec mc-declined');
    const bodyEl = el('div', 'mc-body'); bodyEl.textContent = text; card.appendChild(bodyEl);   // textContent — never interpreted
    const btns = el('div', 'consent-btns mc-acts'); card.appendChild(btns);
    let busy = false;
    const b = el('button', 'consent-btn'); b.textContent = 'Restore'; b.title = 'allow this belief to be proposed again';
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
      const es = el('div', 'empty-state');
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
    const card = el('div', 'mc-rec' + (rec.pinned ? ' pinned' : ''));
    const head = el('div', 'mc-head');
    const tag = el('span', 'turnin-kind'); tag.textContent = MEM_KIND[rec.kind] || 'NOTE'; head.appendChild(tag);
    if (rec.kind === 'note' && rec.title) { const t = el('span', 'mc-rectitle'); t.textContent = rec.title; head.appendChild(t); }
    if (rec.scope === 'stream' && rec.streamId) {   // M-mem.2b: working memory scoped to a workstream
      const wsT = (typeof Workstreams !== 'undefined' && Workstreams.get) ? ((Workstreams.get(rec.streamId) || {}).title || null) : null;
      const sc = el('span', 'mc-scope'); sc.textContent = '⊂ ' + (wsT || 'workstream'); sc.title = 'working memory — scoped to this workstream (still cross-stream searchable)'; head.appendChild(sc);
    }
    if (rec.pinned) { const p = el('span', 'mc-pinflag'); p.textContent = '★ pinned'; head.appendChild(p); }
    card.appendChild(head);

    const bodyEl = el('div', 'mc-body'); bodyEl.textContent = rec.body || '(empty)'; card.appendChild(bodyEl);

    const meta = el('div', 'mc-meta');
    const prov = el('span', 'mc-prov');
    const when = rec.createdAt ? new Date(rec.createdAt).toLocaleDateString() : '—';
    prov.textContent = '◉ learned ' + when + (rec.sourceRunId ? ' · run ' + String(rec.sourceRunId).slice(0, 8) : '');
    prov.title = rec.sourceRunId ? ('earned in run ' + rec.sourceRunId) : 'origin run unknown';   // drill-to-the-run (identity)
    meta.appendChild(prov);
    const used = el('span', 'mc-used');
    used.textContent = rec.useCount ? ('used ' + rec.useCount + '×') : 'never recalled';
    meta.appendChild(used);
    const pct = Math.max(0, Math.min(100, Math.round((rec.trust || 0) * 100)));
    const trust = el('span', 'mc-trust', 'trust <span class="mc-trk"><span class="mc-fill" style="width:' + pct + '%;"></span></span>');   // numeric pct only — safe
    meta.appendChild(trust);
    card.appendChild(meta);

    const btns = el('div', 'consent-btns mc-acts'); card.appendChild(btns);
    const reload = () => loadMemoryCore(a);
    let busy = false;   // in-flight guard: a fast double-click must not fire two POSTs (a success reloads the card away)
    const mk = (label, cls, fn) => { const b = el('button', 'consent-btn' + (cls ? ' ' + cls : '')); b.textContent = label; b.onclick = fn; btns.appendChild(b); return b; };
    mk(rec.pinned ? 'Unpin' : 'Pin', '', async () => {
      if (busy) return; busy = true;
      const r = await Harness.memoryPin({ agentId: a.id, id: rec.id, pinned: !rec.pinned });
      if (r && r.ok) { sfx('click'); reload(); } else busy = false;
    });
    mk('Edit', '', () => editMemCard(card, bodyEl, btns, rec, a));
    // forget is destructive → two-step inline confirm (auto-disarms after 3s)
    let armed = false;
    const fbtn = mk('Forget', 'deny', async () => {
      if (!armed) { armed = true; fbtn.textContent = 'Confirm forget'; setTimeout(() => { if (armed) { armed = false; fbtn.textContent = 'Forget'; } }, 3000); return; }
      if (busy) return; busy = true;
      const r = await Harness.memoryForget({ agentId: a.id, id: rec.id });
      if (r && r.ok) { sfx('click'); reload(); } else busy = false;
    });
    return card;
  }

  // inline edit (mirrors the CONFIG file editor + the turn-in beat): swap the body for a textarea + Save/Cancel.
  function editMemCard(card, bodyEl, btns, rec, a) {
    const ta = el('textarea', 'cf-ta mc-edit'); ta.value = rec.body || ''; ta.spellcheck = false;
    card.replaceChild(ta, bodyEl); ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {}
    btns.innerHTML = '';
    const save = el('button', 'consent-btn'); save.textContent = 'Save'; btns.appendChild(save);
    const cancel = el('button', 'consent-btn'); cancel.textContent = 'Cancel'; btns.appendChild(cancel);
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
      if (!open['agents'] || agTab !== 'memory') return;
      clearTimeout(memRefreshTimer);
      memRefreshTimer = setTimeout(() => { const a = present[sel]; if (a) loadMemoryCore(a); }, 400);
    };
    U.bus.on('memory.write', bump); U.bus.on('memory.used', bump);
    U.bus.on('memory.feedback', bump); U.bus.on('memory.forget', bump);
  }

  function agConfig(a) {
    return '<div class="cf-root">▣ station://agents/' + esc(agSlug(a)) + '/</div>' +
      CONFIG_FILES.map(f => fileCard(a, f)).join('');
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
    // keep focus in the editor across the rerender that opened it
    const openKey = Object.keys(agEdit).find(k => agEdit[k]);
    if (openKey) { const ta = body.querySelector('#cf-ta-' + openKey); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
  }

  function buildAgents(body) {
    if (!present.length) { body.innerHTML = '<p class="dim">No agents on station.</p>'; return; }
    if (sel >= present.length) sel = 0;
    const a = present[sel];
    const act = activity();
    const tabContent = agTab === 'config' ? agConfig(a) : agTab === 'skills' ? agSkills(a && a.id) : agTab === 'growth' ? agGrowth(a) : agTab === 'memory' ? agMemory(a) : agBrief(a);
    body.innerHTML =
      '<div class="ag-wrap"><div class="ag-list">' +
      present.map((x, i) => '<div class="ag-item ' + (i === sel ? 'sel' : '') + '" data-i="' + i + '" style="--ci:' + i + '">' +
        '<span style="color:' + x.color + '">●</span> ' + esc(x.name) + '</div>').join('') +
      '</div><div class="ag-detail">' +
      agHead(a, act) +
      '<div class="ag-tabs">' +
      '<button class="ag-tab ' + (agTab === 'brief' ? 'sel' : '') + '" data-tab="brief">BRIEF</button>' +
      '<button class="ag-tab ' + (agTab === 'growth' ? 'sel' : '') + '" data-tab="growth">GROWTH</button>' +
      '<button class="ag-tab ' + (agTab === 'memory' ? 'sel' : '') + '" data-tab="memory">MEMORY</button>' +
      '<button class="ag-tab ' + (agTab === 'skills' ? 'sel' : '') + '" data-tab="skills">SKILLS</button>' +
      '<button class="ag-tab ' + (agTab === 'config' ? 'sel' : '') + '" data-tab="config">CONFIG</button>' +
      '</div>' +
      tabContent +
      '</div></div>';
    body.querySelectorAll('.ag-item').forEach(it =>
      it.addEventListener('click', () => { sel = +it.dataset.i; sfx('click'); rerender('agents'); }));
    body.querySelectorAll('.ag-tab').forEach(tb =>
      tb.addEventListener('click', () => { agTab = tb.dataset.tab; sfx('click'); rerender('agents'); }));
    if (agTab === 'config') wireConfig(body);
    if (agTab === 'memory') { wireMemoryLive(); loadMemoryCore(a); }
    drawPortrait(body.querySelector('#ag-portrait'), a);
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
  function openAgent(i) { sel = i; if (open.agents) { if (minimized.agents) restoreTerm('agents'); rerender('agents'); } else toggleTerm('agents', 'AGENT DOSSIER', buildAgents, { w: '600px', feature: true }); }

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
    body.innerHTML =
      '<div class="sec"><span class="sec-l">CAPABILITIES</span><span class="sec-r"></span><span class="sec-tag">' + on + ' LIVE</span></div>' +
      '<div class="perk-grid">' +
      skills.map((s, i) => '<div class="perk ' + (s.on ? 'on' : '') + '" style="--ci:' + i + '">' +
        '<div class="perk-icon">' + s.icon + '</div>' +
        '<div class="perk-name">' + s.name + '</div>' +
        '<div class="perk-desc">' + s.tools + '</div>' +
        '<div class="perk-stat' + (s.consent ? ' ask' : '') + '">' +
        (s.on ? (s.consent ? '● ASKS OK' : '● ENABLED') : '○ LOCKED') + '</div></div>').join('') +
      '</div>' +
      '<p class="sk-note">Capabilities follow the <b>objects at the workstation</b> — the room layout IS the ' +
      'permission system. <b>File writes</b> and <b>commands</b> pause for one-click approval in COMMS; the private ' +
      '<b>notebook</b> saves freely.</p>' +
      '<div class="sec"><span class="sec-l">SKILL LIBRARY</span><span class="sec-r"></span><span class="sec-nd"></span></div>' +
      '<p class="sk-note sk-lib-intro">Pre-installed <b>recipes</b> your agents follow when a task matches. Each one ' +
      'rides on the capabilities above — it stays <b>locked</b> until ' + esc((a && a.name) || 'the agent') + ' has the ' +
      'objects it needs. Enabling is station-wide; what actually runs is still gated by the floor.</p>' +
      '<div id="sk-lib" class="sk-lib"><div class="sk-loading"><span class="loading pulse">loading the skill library…</span></div></div>';
    loadSkillLibrary(agentId);
    body.innerHTML += '<h4 class="ms-h">AGENT SKILLS</h4>' +
      '<p class="sk-note sk-lib-intro">Reusable procedures this agent created or learned. These appear as a compact index in future runs; the agent loads the full body only when a task matches.</p>' +
      '<div id="sk-agent" class="sk-lib"><div class="sk-loading">Loading agent skills...</div></div>';
    loadAgentSkills(agentId);
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
  function renderSkillLibrary(host, skills, agentId, placed) {
    if (!skills.length) { host.innerHTML = '<div class="sk-loading">No skills in the library yet.</div>'; return; }
    const placedSet = {}; (placed || []).forEach(p => placedSet[p] = true);
    const objLabel = (r) => SK_OBJ_NAME[r] || String(r).toUpperCase();
    const active = skills.filter(s => s.enabled && s.available).length;
    const cats = [], byCat = {};
    for (const s of skills) { if (!byCat[s.category]) { byCat[s.category] = []; cats.push(s.category); } byCat[s.category].push(s); }
    let html = '<div class="sk-lib-sum">' + skills.length + ' recipe' + (skills.length === 1 ? '' : 's') +
      ' · <b>' + active + '</b> active for ' + esc((present[sel] && present[sel].name) || agentId) + '</div>';
    for (const cat of cats) {
      html += '<div class="sec sk-cat-sec"><span class="sec-l">' + esc(cat) + '</span><span class="sec-r"></span><span class="sec-nd"></span></div>';
      let ci = 0;
      for (const s of byCat[cat]) {
        const missing = (s.requires || []).filter(r => !placedSet[r]);
        const state = s.enabled ? (s.available ? 'on' : 'want') : 'off';
        const stat = s.enabled ? (s.available ? '● ACTIVE' : '● ON · needs ' + missing.map(objLabel).join(' + ')) : '○ OFF';
        const reqs = (s.requires || []).length
          ? s.requires.map(r => '<span class="sk-badge ' + (placedSet[r] ? 'have' : 'miss') + '">' + objLabel(r) + '</span>').join('')
          : '<span class="sk-badge free">no gear needed</span>';
        html +=
          '<div class="sk-card ' + state + '" style="--ci:' + (ci++) + '">' +
            '<div class="sk-card-head">' +
              '<button class="sk-toggle" data-toggle="' + esc(s.slug) + '" data-enabled="' + (s.enabled ? 'true' : 'false') + '" title="' + (s.enabled ? 'Disable' : 'Enable') + ' this skill">' + (s.enabled ? '◉' : '○') + '</button>' +
              '<div class="sk-card-main">' +
                '<div class="sk-name-row"><span class="sk-name">' + esc(s.name) + '</span><span class="sk-reqs">' + reqs + '</span></div>' +
                '<div class="sk-desc">' + esc(s.description) + '</div>' +
                '<div class="sk-stat ' + state + '">' + stat + '</div>' +
              '</div>' +
              '<button class="sk-expand" data-expand="' + esc(s.slug) + '" title="Read the recipe">▸</button>' +
            '</div>' +
            '<div class="sk-body"><pre>' + esc(s.body || '') + '</pre>' +
              (s.author ? '<div class="sk-attr">Ported from ' + esc(s.author) + (s.license ? ' · ' + esc(s.license) : '') + '</div>' : '') +
            '</div>' +
          '</div>';
      }
    }
    host.innerHTML = html;
    host.querySelectorAll('[data-toggle]').forEach(btn => btn.addEventListener('click', () => {
      const slug = btn.dataset.toggle, next = btn.dataset.enabled !== 'true';
      btn.classList.add('busy');
      fetch('/api/skills/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: slug, enabled: next }) })
        .then(r => r.ok ? r.json() : null)
        .then(res => { if (res && res.ok) { sfx('click'); loadSkillLibrary(agentId); } else { btn.classList.remove('busy'); } })
        .catch(() => btn.classList.remove('busy'));
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
              '<div class="sk-name-row"><span class="sk-name">' + esc(s.name) + '</span><span class="sk-badge free">' + esc((s.state || 'active').toUpperCase()) + '</span></div>' +
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
    const ta = el('textarea', 'cf-ta mc-edit'); ta.value = skill.body || ''; ta.spellcheck = false;
    if (pre) body.replaceChild(ta, pre);
    if (actions) actions.innerHTML = '';
    const save = el('button', 'consent-btn'); save.textContent = 'Save'; actions.appendChild(save);
    const cancel = el('button', 'consent-btn'); cancel.textContent = 'Cancel'; actions.appendChild(cancel);
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
  const COLS = [['todo', 'TO DO'], ['active', 'IN PROGRESS'], ['shipped', 'SHIPPED']];
  const WS = () => (typeof Workstreams === 'object' && Workstreams) ? Workstreams : null;
  function boardStreams() {
    const w = WS(); if (!w) return [];
    const gid = w.generalId();
    return w.list().filter(x => x.id !== gid);   // list() already drops archived; the board also drops General
  }
  function persistWS() { if (typeof App !== 'undefined' && App.persist) App.persist(); }
  // a board mutation must refresh BOTH views — App.refreshRail re-renders the rail AND calls back into
    // refreshBoard() here, so one call keeps the rail and the board in lockstep.
  function sync() { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); else rerender('tasks'); }

  function addTask(title) {
    const w = WS(); if (!w) return;
    title = String(title || '').trim(); if (!title) return;
    w.create(title.slice(0, 160), { activate: false });   // a new TO DO workstream; don't hijack the active chat
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
    notify('assigned to ' + (present[0] ? present[0].name : 'agent') + ': ' + (s.title || 'workstream'), 'gold');
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
  function card(s, i) {
    const n = s.runIds.length, runs = n ? n + (n === 1 ? ' run' : ' runs') : '';
    const acts = s.lane === 'todo'
      ? '<button class="assign" data-act="assign">▶ ASSIGN</button><button data-act="open">↗ OPEN</button><button data-act="arch">⌫</button>'
      : s.lane === 'active'
        ? '<button data-act="ship">✓ SHIP</button><button data-act="open">↗ OPEN</button><button data-act="arch">⌫</button>'
        : '<button data-act="reopen">↺ REOPEN</button><button data-act="open">↗ OPEN</button><button data-act="arch">⌫</button>';
    return '<div class="kb-card" data-id="' + s.id + '" style="--ci:' + (i || 0) + '">' +
      '<div class="kb-title">' + esc(s.title || 'untitled') + '</div>' +
      '<div class="kb-meta"><span>' + clock(s.lastActiveAt || s.createdAt) + '</span>' +
      (runs ? '<span>' + runs + '</span>' : '') + '</div>' +
      '<div class="kb-acts">' + acts + '</div></div>';
  }
  function buildTasks(body) {
    const streams = boardStreams();
    body.innerHTML =
      '<div class="kb-add"><input id="kb-in" maxlength="160" placeholder="add a workstream for your agent…" autocomplete="off">' +
      '<button class="bb sm" id="kb-add">+ ADD</button></div>' +
      '<div class="kb-cols">' +
      COLS.map(([lane, label]) => {
        const items = streams.filter(s => s.lane === lane);
        return '<div class="kb-col"><h4>' + label + ' <i>' + items.length + '</i></h4>' +
          (items.length ? items.map(card).join('') : kbEmpty(lane)) + '</div>';
      }).join('') +
      '</div>';
    const inp = body.querySelector('#kb-in');
    const submit = () => { addTask(inp.value); };
    body.querySelector('#kb-add').addEventListener('click', () => { sfx('click'); submit(); });
    inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
    // empty-state CTA (TO DO column): focus the add-a-workstream input — no new behaviour, just focus.
    body.querySelectorAll('.kb-empty-col .es-cta').forEach(b =>
      b.addEventListener('click', () => { sfx('click'); inp.focus(); }));
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
  let codexConnectionKnown = null;
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
        const next = !!(j && j.connected);
        if (codexConnectionKnown !== next) { codexConnectionKnown = next; rerender('settings'); }
      })
      .catch(() => {})
      .finally(() => { codexConnectionChecking = false; });
  }
  function codexConnected() {
    if (codexConnectionKnown !== null) return !!codexConnectionKnown;
    const h = H();
    return !!(h && h.getProv && h.getProv() === 'codex');
  }
  function connectedKeys() {
    const h = H(); if (!h) return [];
    const out = [];
    const active = activeProv();
    // Codex first when it's the live provider — an OAuth connection that carries a model but no API key.
    if (codexConnected()) out.push({ provider: 'codex', key: '', model: (h.getModel && h.getModel()) || '', oauth: true });
    // OpenRouter BYOK: desktop keeps the key in the OS keychain (getKey returns ''); configured() reports it's set.
    function addProvider(provider) {
      if (!provider || provider === 'codex' || out.some(k => k.provider === provider)) return;
      if (provider === 'ollama' && provider !== active) return;
      const set = (h.configured && h.configured(provider)) || !!(h.getKey && h.getKey(provider));
      if (set) out.push({ provider, key: h.getKey ? h.getKey(provider) : '', baseUrl: h.getBaseUrl ? h.getBaseUrl(provider) : '', model: (h.getModel && h.getModel()) || '', local: provider === 'ollama' });
    }
    addProvider(active);
    if (active !== 'openrouter') addProvider('openrouter');
    PROVIDERS.forEach(p => addProvider(p.id));
    return out;
  }
  function keysFor(id) { return connectedKeys().filter(x => x.provider === id); }
  function providerAcceptsKey(provider) {
    provider = provider || activeProv();
    return provider !== 'codex' && provider !== 'ollama';
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
      const connected = p.live && ks.length > 0;
      // ACTIVE means this transport can actually run right now: selected provider AND a model is set.
      const runnable = connected && p.id === active && !!ks[0].model;
      const cls = connected ? 'conn' : (p.live ? 'avail' : 'soon');
      const stat = !p.live ? '○ COMING SOON' : connected ? '● CONNECTED' : (p.id === 'codex' ? '○ NOT SIGNED IN' : (p.id === 'ollama' ? '○ LOCAL' : '○ NO KEY'));
      const n = ks.length;
      return '<div class="prov-card ' + cls + '" data-provider="' + esc(p.id) + '" role="button" tabindex="0" style="--ci:' + pi + '">' +
        '<span class="conn-dot"></span>' +
        '<div class="prov-main">' +
        '<div class="prov-name">' + esc(p.name) + (runnable ? '<span class="prov-badge">ACTIVE</span>' : '') + '</div>' +
        '<div class="prov-ep">' + esc(p.endpoint) + ' · ' + esc(p.blurb) + '</div>' +
        '</div>' +
        '<div class="prov-stat">' + stat + (connected ? '<i>' + n + (n === 1 ? ' key' : ' keys') + '</i>' : '') + '</div>' +
        '</div>';
    }).join('');
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
      // ACTIVE only when the key can actually run: selected provider AND a model is set (never overstate runnability).
      const runnable = k.provider === active && !!k.model;
      // Codex (OAuth) has no API key to mask/edit/remove — render it honestly as a sign-in connection.
      if (k.oauth) {
        return '<div class="key-row">' +
          '<span class="conn-dot"></span>' +
          '<div class="key-main">' +
          '<div class="key-top"><span class="key-prov">' + esc(provName(k.provider)) + '</span>' +
          '<code class="key-mask" title="authenticated by ChatGPT sign-in (OAuth) — no API key is stored">ChatGPT OAuth</code></div>' +
          '<div class="key-meta">model <b>' + esc(k.model || '—') + '</b> · ' +
          (runnable ? '<span class="key-stat on">ACTIVE</span>' : '<span class="key-stat">idle</span>') +
          ' · <span class="key-stat">no API key needed</span></div>' +
          '</div></div>';
      }
      if (k.local) {
        return '<div class="key-row">' +
          '<span class="conn-dot"></span>' +
          '<div class="key-main">' +
          '<div class="key-top"><span class="key-prov">' + esc(provName(k.provider)) + '</span>' +
          '<code class="key-mask" title="local OpenAI-compatible endpoint">Local endpoint</code></div>' +
          '<div class="key-meta">model <b>' + esc(k.model || 'â€”') + '</b> Â· ' +
          (runnable ? '<span class="key-stat on">ACTIVE</span>' : '<span class="key-stat">idle</span>') +
          ' Â· <span class="key-stat">no API key needed</span></div>' +
          '</div></div>';
      }
      return '<div class="key-row">' +
        '<span class="conn-dot"></span>' +
        '<div class="key-main">' +
        '<div class="key-top"><span class="key-prov">' + esc(provName(k.provider)) + '</span>' +
        '<code class="key-mask" title="shown masked when a key exists — the full key is never displayed">' + esc(k.key ? maskKey(k.key) : (k.baseUrl || 'keyless endpoint')) + '</code></div>' +
        '<div class="key-meta">model <b>' + esc(k.model || '—') + '</b> · ' +
        (runnable ? '<span class="key-stat on">ACTIVE</span>' : '<span class="key-stat">idle</span>') + '</div>' +
        '</div>' +
        '<div class="key-acts">' +
        '<button class="bb sm" data-act="edit" data-i="' + i + '">✎ UPDATE</button>' +
        '<button class="bb sm danger" data-act="rm" data-i="' + i + '">✕ REMOVE</button>' +
        '</div></div>' +
        '<div class="key-edit" id="key-edit-' + i + '" hidden>' +
        '<input type="password" class="key-input" id="key-in-' + i + '" placeholder="paste new ' + esc(provName(k.provider)) + ' key…" autocomplete="off" spellcheck="false">' +
        '<button class="bb sm" data-act="save" data-i="' + i + '">SAVE</button>' +
        '</div>';
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
        if (!h) return;
        if (act === 'add') {              // empty-state: connect a first key without leaving the game
          const inp = body.querySelector('#key-in-new');
          const v = inp ? inp.value.trim() : '';
          if (!v) { sfx('bad'); return; }
          const provider = b.dataset.provider || activeProv();
          if (h.setKey) h.setKey(v, provider);
          notify('connected ' + provName(provider) + ' API key', 'good');
          rerender('settings');
          return;
        }
        const i = +b.dataset.i, row = connectedKeys()[i];
        if (!row) return;
        if (act === 'edit') {
          const ed = body.querySelector('#key-edit-' + i);
          if (ed) { ed.hidden = !ed.hidden; if (!ed.hidden) { const inp = body.querySelector('#key-in-' + i); if (inp) inp.focus(); } }
        } else if (act === 'save') {
          const inp = body.querySelector('#key-in-' + i);
          const v = inp ? inp.value.trim() : '';
          if (!v) { sfx('bad'); return; }
          if (h.setKey) h.setKey(v, row.provider);
          notify('updated ' + provName(row.provider) + ' API key', 'good');
          rerender('settings');
        } else if (act === 'rm') {
          if (b.dataset.armed) { if (h.setKey) h.setKey('', row.provider); notify('removed ' + provName(row.provider) + ' key — paste a new one here to reconnect', 'warn'); sfx('bad'); rerender('settings'); return; }
          b.dataset.armed = '1'; b.textContent = '✕ CONFIRM'; sfx('bad');
          setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = '✕ REMOVE'; } }, 5000);
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
      card.addEventListener('click', activate);
      card.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        activate();
      });
    });
  }

  // display a USD amount for the spend readout / cap echo. Whole-cent granularity for readability (the ledger
  // itself keeps micro-dollar precision; this is presentation only). No app-wide formatter exists to reuse.
  function fmtUsd(v) { return U.usd(v); }   // canonical spend formatter (util.js U.usd)
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
        const v = (typeof caps[k] === 'number') ? caps[k] : (typeof envd[k] === 'number' ? envd[k] : 0);
        el.value = String(v);
        // annotate whether this value is a saved override or the env default (honest, non-blocking).
        const savedHere = Object.prototype.hasOwnProperty.call(saved, k);
        el.title = savedHere ? 'saved on this machine' : 'environment default (not yet saved here)';
      });
      const anySaved = BG_KEYS.some(k => Object.prototype.hasOwnProperty.call(saved, k));
      if (resetBtn) resetBtn.style.display = anySaved ? '' : 'none';
      if (spendEl) {
        const today = fmtUsd(st && st.spentToday), life = fmtUsd(st && st.lifetime);
        const runs = (st && typeof st.runs === 'number') ? st.runs : 0;
        spendEl.innerHTML = 'SPENT TODAY <b>' + today + '</b> &nbsp;·&nbsp; LIFETIME <b>' + life + '</b> <span class="dim">(' + runs + ' run' + (runs === 1 ? '' : 's') + ')</span>';
      }
    };
    const refresh = () => fetch('/api/budget/status', { cache: 'no-store' }).then(r => r.json()).then(paint)
      .catch(() => { if (spendEl) spendEl.textContent = 'spend unavailable'; });
    refresh();
    if (saveBtn) saveBtn.addEventListener('click', () => {
      const payload = {};
      for (const k of BG_KEYS) {
        const el = inputOf(k); if (!el) continue;
        const raw = String(el.value).trim();
        if (raw === '') { payload[k] = 0; continue; }   // blank -> "no cap" (0), matching the placeholder semantics
        const n = Number(raw);
        if (!isFinite(n) || n < 0) { setMsg(k + ': enter a number ≥ 0 (0 = no cap)'); sfx('bad'); el.focus(); return; }
        payload[k] = n;
      }
      setMsg('saving…');
      fetch('/api/budget/caps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(r => r.json().then(j => ({ ok: r.ok, j })))
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
      fetch('/api/budget/caps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(r => r.json().then(j => ({ ok: r.ok, j })))
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
    fetch('/api/fallback/chain', { cache: 'no-store' }).then(r => r.json()).then(applyStatus)
      .catch(() => { if (listEl) listEl.innerHTML = '<div class="fbc-row dim">chain unavailable — sidecar unreachable</div>'; });
    // catalog for the ADD picker — the same warmed OpenRouter catalog the model dock uses. Best-effort: an empty
    // catalog just leaves the picker with its placeholder (the chain itself still paints + saves fine).
    fetch('/api/models/openrouter', { cache: 'no-store' }).then(r => r.json()).then(j => {
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
      fetch('/api/fallback/chain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ models: models }) })
        .then(r => r.json().then(j => ({ ok: r.ok, j })))
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

  function buildSettings(body) {
    refreshCodexConnectionStatus();
    const s = store.settings;
    const awakeDesktop = !!(typeof KeepAwake !== 'undefined' && KeepAwake.isDesktop && KeepAwake.isDesktop());
    const awakeChecked = awakeDesktop && !!s.keepComputerAwake;
    body.innerHTML =
      '<h4 class="ms-h">PROVIDERS</h4>' +
      '<div class="prov-list">' + providersHtml() + '</div>' +
      '<h4 class="ms-h">API KEYS</h4>' +
      '<div class="key-list">' + keysHtml() + '</div>' +
      '<p class="set-about">Keys live locally on this machine and are sent only to the STARNET sidecar (127.0.0.1) per request — never anywhere else. They are shown masked; the full secret is never displayed. (The shipped desktop build moves keys behind the OS keychain.)</p>' +
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
        '<button class="set-theme" data-reach="reach" title="can send, publish, or contact external services">REACH-OUT</button>' +
      '</div>' +
      // PERMISSIONS — the OS-style standing-grant panel (permissions.js / permissionsstore.js). The LEVEL row is
      // the simple "never → fully autonomous" chooser (sets the posture preset AND the write grant together); the
      // grant list shows + revokes every standing capability. #perm-desc spells out the COMBINED truth, live.
      '<h4 class="ms-h">PERMISSIONS <span class="dim">— what it’s actually allowed to do on its own</span></h4>' +
      '<p class="set-about" id="perm-desc"></p>' +
      '<div class="set-row"><span class="dim">LEVEL — from fully hands-off to fully autonomous</span></div>' +
      '<div class="set-themes" id="perm-level">' +
        '<button class="set-theme" data-level="never" title="does nothing on its own — you drive everything">NEVER</button>' +
        '<button class="set-theme" data-level="suggest" title="lines up ideas you approve — never acts on its own">SUGGEST</button>' +
        '<button class="set-theme" data-level="draft" title="acts on its own and leaves drafts — writes no files">DRAFT FOR ME</button>' +
        '<button class="set-theme" data-level="full" title="acts AND writes real files on its own — logged &amp; reversible">FULLY AUTONOMOUS</button>' +
      '</div>' +
      '<div class="set-row"><span class="dim">STANDING APPROVALS — every capability it may use unattended, when you granted it, and a REVOKE for each (revocable any time)</span></div>' +
      '<div class="key-list" id="perm-grants"></div>' +
      // BUDGET — the four real USD spend caps the sidecar enforces over the ledger (perRun hard stop + soft
      // per-agent / per-day / global pools). Persisted server-side + applied live; a live spend readout below.
      '<h4 class="ms-h">BUDGET <span class="dim">— real USD spend limits</span></h4>' +
      '<p class="set-about">Hard money limits your agents cannot exceed. Enforced by the sidecar against the real spend ledger. <b>0 or blank = no cap.</b> Saved here on this machine; live defaults come from the environment.</p>' +
      '<div id="budget-spend" class="set-row dim">reading spend…</div>' +
      '<div class="mc-form" id="budget-form">' +
        '<div class="set-row"><label for="bg-perRun">PER RUN</label><input id="bg-perRun" class="key-input bg-cap" type="number" min="0" step="0.01" inputmode="decimal" autocomplete="off" placeholder="0 = no cap"></div>' +
        '<div class="mc-hint">Hard ceiling for a single agent run. The run stops the moment it would exceed this.</div>' +
        '<div class="set-row"><label for="bg-perAgent">PER AGENT</label><input id="bg-perAgent" class="key-input bg-cap" type="number" min="0" step="0.01" inputmode="decimal" autocomplete="off" placeholder="0 = no cap"></div>' +
        '<div class="mc-hint">Lifetime cap on any one agent’s total spend across all its runs.</div>' +
        '<div class="set-row"><label for="bg-perDay">PER DAY</label><input id="bg-perDay" class="key-input bg-cap" type="number" min="0" step="0.01" inputmode="decimal" autocomplete="off" placeholder="0 = no cap"></div>' +
        '<div class="mc-hint">Total spend across every agent in a rolling 24-hour window.</div>' +
        '<div class="set-row"><label for="bg-global">GLOBAL</label><input id="bg-global" class="key-input bg-cap" type="number" min="0" step="0.01" inputmode="decimal" autocomplete="off" placeholder="0 = no cap"></div>' +
        '<div class="mc-hint">All-time ceiling across everything. The last line of defence.</div>' +
        '<div class="mc-acts">' +
          '<button class="bb sm" id="bg-save">SAVE LIMITS</button>' +
          '<button class="bb xs" id="bg-reset" title="clear the saved value so this cap follows the environment default again" style="display:none">RESET TO DEFAULTS</button>' +
        '</div>' +
      '</div>' +
      '<div id="budget-msg" class="msg"></div>' +
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
      '<h4 class="ms-h">SCHEDULED TASKS</h4>' +
      '<label class="set-row"><input type="checkbox" id="set-awake" ' + (awakeChecked ? 'checked' : '') + (awakeDesktop ? '' : ' disabled') + '> KEEP COMPUTER AWAKE <span class="dim">- ' + (awakeDesktop ? 'prevent idle sleep while StarNet is open' : 'desktop app only') + '</span></label>' +
      '<h4 class="ms-h">PHOSPHOR THEME</h4><div class="set-themes">' +
      THEMES.map(([t, c]) => '<button class="set-theme ' + (s.theme === t ? 'sel' : '') + '" data-t="' + t + '" style="--sw:' + c + '">' + t.toUpperCase() + '</button>').join('') +
      '</div>' +
      '<h4 class="ms-h">DISPLAY</h4>' +
      '<label class="set-row"><input type="checkbox" id="set-scan" ' + (s.scanlines ? 'checked' : '') + '> CRT SCANLINES</label>' +
      '<label class="set-row"><input type="checkbox" id="set-flicker" ' + (s.flicker ? 'checked' : '') + '> SCREEN FLICKER</label>' +
      '<label class="set-row"><input type="checkbox" id="set-sound" ' + (s.sound ? 'checked' : '') + '> TERMINAL AUDIO</label>' +
      '<label class="set-row"><input type="checkbox" id="set-music" ' + (s.music !== false ? 'checked' : '') + '> STATION MUSIC <span class="dim">— adaptive score</span></label>' +
      ((typeof Updates !== 'undefined' && Updates.settingsHtml) ? Updates.settingsHtml() : '') +
      '<h4 class="ms-h">STATION DATA</h4>' +
      '<div class="set-save"><button class="bb sm danger" id="set-clear">CLEAR NOTIFICATIONS</button></div>' +
      '<p class="set-about">STARNET — gamified AI-agent harness.<br>Theme, display & audio preferences are saved locally on this machine. Manage workstreams from the TASK BOARD or the COMMS rail.</p>';
    wireProviderActions(body);
    wireKeyActions(body);
    wireBudget(body);
    wireFallbackChain(body);
    // switch theme in place — applySettings repaints via the body class; do NOT rerender (it would wipe an open key editor).
    body.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => {
      s.theme = b.dataset.t; applySettings(); save(); sfx('click');
      body.querySelectorAll('[data-t]').forEach(x => x.classList.toggle('sel', x === b));
    }));
    const bind = (id, key) => body.querySelector(id).addEventListener('change', ev => { s[key] = ev.target.checked; applySettings(); save(); });
    bind('#set-scan', 'scanlines'); bind('#set-flicker', 'flicker'); bind('#set-sound', 'sound'); bind('#set-music', 'music');
    const awakeToggle = body.querySelector('#set-awake');
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
    // PERMISSIONS panel repaint hook — set by the permissions block below; called whenever the granular dial
    // changes so the level highlight + #perm-desc stay in sync with the posture. No-op until that block wires it.
    let syncPerm = function () {};
    // AUTONOMY dial — retune Initiative / Reach in place (AutonomyStore persists; no rerender so it won't wipe an
    // open key editor). The describe() line repaints live so the posture is always honestly spelled out.
    if (typeof AutonomyStore !== 'undefined' && AutonomyStore.summary) {
      const initWrap = body.querySelector('#auto-init'), reachWrap = body.querySelector('#auto-reach'), autoDesc = body.querySelector('#auto-desc');
      const paintAuto = () => {
        const a = AutonomyStore.summary() || {};
        if (initWrap) initWrap.querySelectorAll('[data-init]').forEach(x => x.classList.toggle('sel', x.dataset.init === a.initiative));
        if (reachWrap) reachWrap.querySelectorAll('[data-reach]').forEach(x => x.classList.toggle('sel', x.dataset.reach === a.reach));
        if (autoDesc) autoDesc.textContent = AutonomyStore.describe();
        try { syncPerm(); } catch (_) {}   // keep the permissions level highlight + blurb in step with the dial
      };
      if (initWrap) initWrap.querySelectorAll('[data-init]').forEach(b => b.addEventListener('click', () => { AutonomyStore.setInitiative(b.dataset.init); paintAuto(); sfx('click'); }));
      if (reachWrap) reachWrap.querySelectorAll('[data-reach]').forEach(b => b.addEventListener('click', () => { AutonomyStore.setReach(b.dataset.reach); paintAuto(); sfx('click'); }));
      paintAuto();
    }
    // PERMISSIONS panel — the never→fully-autonomous LEVEL chooser + the OS-style standing-grant list
    // (permissionsstore). Grants live server-side, so paint from cache now, refresh from the sidecar, repaint. A
    // level click sets BOTH posture + the write grant (so it repaints the dial); the dial syncs back via syncPerm.
    if (typeof PermissionsStore !== 'undefined' && PermissionsStore.snapshot) {
      const levelWrap = body.querySelector('#perm-level'), grantsWrap = body.querySelector('#perm-grants'), permDesc = body.querySelector('#perm-desc');
      const pdesc = (lvl) => (typeof Permissions !== 'undefined' && Permissions.describeLevel) ? Permissions.describeLevel(lvl) : '';
      const plabel = (k) => (typeof Permissions !== 'undefined' && Permissions.catalogLabel) ? Permissions.catalogLabel(k) : k;
      const pcurated = () => (typeof Permissions !== 'undefined' && Permissions.grantableKeys) ? Permissions.grantableKeys() : [];
      const repaintDial = () => {
        if (typeof AutonomyStore === 'undefined' || !AutonomyStore.summary) return;
        const a = AutonomyStore.summary() || {};
        const iw = body.querySelector('#auto-init'), rw = body.querySelector('#auto-reach'), ad = body.querySelector('#auto-desc');
        if (iw) iw.querySelectorAll('[data-init]').forEach(x => x.classList.toggle('sel', x.dataset.init === a.initiative));
        if (rw) rw.querySelectorAll('[data-reach]').forEach(x => x.classList.toggle('sel', x.dataset.reach === a.reach));
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
            rows.push('<div class="set-row"><span>✓ ' + esc(plabel(k)) + (hint ? ' <span class="dim">— ' + esc(hint) + '</span>' : '') + ' <span class="dim">— ' + esc(pwhen(snap, k)) + '</span></span> <button class="bb sm danger" data-perm-revoke="' + esc(k) + '">✕ REVOKE</button></div>');
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
        grantsWrap.querySelectorAll('[data-perm-revoke]').forEach(b => b.addEventListener('click', () => {
          if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = '✕ CONFIRM'; sfx('bad'); setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = '✕ REVOKE'; } }, 5000); return; }
          sfx('bad'); Promise.resolve(PermissionsStore.revoke(b.getAttribute('data-perm-revoke'))).then(repaintPerm);
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
    if (typeof Updates !== 'undefined' && Updates.wireSettings) Updates.wireSettings(body);
    // two-step arm/confirm — no native dialogs inside the phosphor terminal
    const clr = body.querySelector('#set-clear');
    clr.addEventListener('click', () => {
      if (clr.dataset.armed) { store.notifs = []; save(); badges(); rerender('notifs'); sfx('bad'); return; }
      clr.dataset.armed = '1'; clr.textContent = '✕ CONFIRM CLEAR'; sfx('bad');
      setTimeout(() => { if (clr.isConnected) { delete clr.dataset.armed; clr.textContent = 'CLEAR NOTIFICATIONS'; } }, 5000);
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
  function notify(text, cls) {
    store.notifs.push({ id: uid('n'), t: Date.now(), txt: String(text || ''), cls: cls || '', read: false });
    if (store.notifs.length > 60) store.notifs = store.notifs.slice(-60);
    save(); badges();
    if (open.notifs) rerender('notifs');
    toast(String(text || ''), cls || '');
  }
  // transient on-screen toast — slides in, auto-dismisses with a fade-out, stacks cleanly.
  // The persistent record still lives in the NOTIFICATIONS panel (buildNotifs); this is the
  // ephemeral heads-up so a result isn't silent when that panel is closed.
  function toast(text, cls) {
    if (typeof document === 'undefined' || !text) return;
    let stack = document.getElementById('toast-stack');
    if (!stack) { stack = el('div'); stack.id = 'toast-stack'; document.body.appendChild(stack); }
    const sev = severityOf(cls);
    // keep the caller's raw cls (good/gold/warn/bad already have edge styling) AND add a normalized
    // sev-* class so 'error'/'info' also get an edge + the lead glyph.
    const t = el('div', 'toast' + (cls ? ' ' + cls : '') + ' sev-' + sev);
    t.innerHTML = '<span class="toast-sev" aria-hidden="true">' + esc(SEV_GLYPH[sev]) + '</span>' +
      '<span class="toast-ts">' + clock(Date.now()) + '</span>' + esc(text);
    stack.appendChild(t);
    // cap the visible stack so a burst can't cover the screen
    while (stack.children.length > 4) stack.removeChild(stack.firstChild);
    const kill = () => {
      if (t._killed) return; t._killed = true;
      t.classList.add('leaving');
      const gone = () => { if (t.isConnected) t.remove(); };
      t.addEventListener('animationend', gone, { once: true });
      setTimeout(gone, 360);
    };
    // errors linger a touch longer so a failure isn't gone before it's read
    setTimeout(kill, sev === 'bad' ? 6500 : 4200);
    t.addEventListener('click', kill);   // click to dismiss early
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
    body.innerHTML =
      '<button class="bb sm" id="nf-clear">MARK ALL READ</button>' +
      '<div class="nf-list">' + store.notifs.slice().reverse().map((n, i) => {
        const sev = severityOf(n.cls);
        return '<div class="nf ' + (n.cls || '') + ' sev-' + sev + (n.read ? ' read' : '') + '" style="--ci:' + i + '">' +
          '<span class="nf-sev" aria-hidden="true">' + esc(SEV_GLYPH[sev]) + '</span>' +
          '<span class="nf-ts">' + ts(n.t) + '</span> ' + esc(n.txt) + '</div>';
      }).join('') + '</div>';
    body.querySelector('#nf-clear').addEventListener('click', () => {
      store.notifs.forEach(n => n.read = true); save(); rerender('notifs'); badges(); sfx('click');
    });
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
    const fill = g.querySelector('.ctx-fill'); if (fill) fill.style.width = (s.known ? s.pct : 0) + '%';
    const num = g.querySelector('.ctx-num'); if (num) num.textContent = s.pctLabel;
    const cap = g.querySelector('.ctx-cap'); if (cap) cap.textContent = s.label;
    g.title = 'CONTEXT - ' + (s.known ? s.label + ' - ' + s.pctLabel + ' of the model max context'
      : (s.limit ? 'waiting for a measured prompt on this agent/model' : 'calibrating model context length'));
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
  function tick() {
    crewTick();
    ctxTick();
    // G1b: resolve station-gap quests against the live floor + re-evaluate the standing OUTBOX candidate
    // FIRST, so a gap that just closed (a prop placed) is already flipped done in the projection when the
    // durable quest memory folds it below — the open→done edge then rides G1a's celebration for free.
    if (typeof StationQuestStore !== 'undefined' && StationQuestStore.sync) { try { StationQuestStore.sync(); } catch (_) {} }
    // G1a: fold the live quest projection into the durable quest memory once a second — completion
    // detection must not depend on the QUEST LOG being open (the celebration toast/sting fire regardless).
    if (typeof QuestStateStore !== 'undefined' && QuestStateStore.sync) { try { QuestStateStore.sync(); } catch (_) {} }
    const [txt, cls] = pillFor(activity());
    const p = $('#status-pill');
    if (p) { p.textContent = txt; p.className = cls; }
    // refresh BRIEF's live telemetry only — never on CONFIG or MEMORY, where a rerender would wipe an open
    // editor (and MEMORY self-refreshes via its own debounced memory.* U.bus listener, so it never needs tick)
    if (open.agents && agTab !== 'config' && agTab !== 'memory') rerender('agents');
  }
  function flashSave() {
    const d = $('#save-dot'); if (!d) return;
    d.classList.add('flash'); setTimeout(() => d.classList.remove('flash'), 600);
  }

  /* ============== MESSAGING — connect a Telegram bot so the Commander can DM the agent ==============
     The bot token comes from Telegram's @BotFather; the agent answers DMs using this app's current
     provider + model (OpenRouter key or ChatGPT sign-in, persisted there for headless polling). */
  function buildMessaging(body) {
    body.innerHTML =
      '<h4 class="ms-h">TELEGRAM</h4>' +
      '<div id="tg-status" class="set-row">checking…</div>' +
      '<p class="set-about">DM your agent from Telegram. ' +
        '<b>1.</b> In Telegram open <b>@BotFather</b> → send <code>/newbot</code> → copy the token it gives you. ' +
        '<b>2.</b> Paste it below and connect. Your agent answers DMs using this app\'s current provider + model, ' +
        'with its own memory + workspace per chat. <span class="dim">(The token is stored locally by the sidecar and never displayed.)</span></p>' +
      '<label class="ms-h" for="tg-token">BOT TOKEN <span class="dim">— from @BotFather</span></label>' +
      '<input id="tg-token" type="password" class="key-input" placeholder="123456789:ABCdef..." autocomplete="off" spellcheck="false">' +
      '<div class="set-save"><button class="bb sm" id="tg-connect">⏼ CONNECT</button> ' +
      '<button class="bb sm danger" id="tg-disconnect">⏏ DISCONNECT</button></div>' +
      // B4 — opt in to a Telegram ping when an autonomous (cron) routine runs on its own and produces work. Default
      // off (anti-spam); the global flag persists server-side so the cron path reads it. Only meaningful once connected.
      '<label class="set-row" style="margin-top:6px"><input type="checkbox" id="tg-notify"> PING ME WHEN I WORK ON MY OWN <span class="dim">— message me when a routine runs autonomously and produces something</span></label>' +
      '<div id="tg-msg" class="msg"></div>' +
      // DISCORD — the same agent reachable over a Discord bot. Mirrors the Telegram card idioms exactly (masked
      // token, connect/disconnect, live status, the SHARED global autonomous-ping opt-in). The token is stored by
      // the sidecar and never displayed; a blank token on reconnect reuses the saved one.
      '<h4 class="ms-h" style="margin-top:14px">DISCORD</h4>' +
      '<div id="dc-status" class="set-row">checking…</div>' +
      '<p class="set-about">Two-way chat on Discord — DM your bot (or @-mention it in a server) and it replies, ' +
        'plus pings and reports when it works on its own. ' +
        '<b>1.</b> Open the <b>Discord Developer Portal</b> → <b>New Application</b> → <b>Bot</b> → <b>Reset Token</b> → copy the token. ' +
        '<b>2.</b> Enable <b>MESSAGE CONTENT INTENT</b> on the Bot page (required to read your messages), then invite the bot to a server (OAuth2 → URL Generator → <code>bot</code> scope). ' +
        '<b>3.</b> Paste the token below and connect. <span class="dim">(The token is stored locally by the sidecar and never displayed.)</span></p>' +
      '<label class="ms-h" for="dc-token">BOT TOKEN <span class="dim">— from the Discord Developer Portal</span></label>' +
      '<input id="dc-token" type="password" class="key-input" placeholder="MTE...Bot token" autocomplete="off" spellcheck="false">' +
      '<div class="set-save"><button class="bb sm" id="dc-connect">⏼ CONNECT</button> ' +
      '<button class="bb sm danger" id="dc-disconnect">⏏ DISCONNECT</button></div>' +
      // the SAME global "ping me when I work on my own" opt-in as Telegram (channelSecrets.notifyAutonomous is one
      // flag; the notifier fans out to every connected channel incl. Discord). Reflects + sets the shared state.
      '<label class="set-row" style="margin-top:6px"><input type="checkbox" id="dc-notify"> PING ME WHEN I WORK ON MY OWN <span class="dim">— message me when a routine runs autonomously and produces something</span></label>' +
      '<div id="dc-msg" class="msg"></div>';

    const statusEl = body.querySelector('#tg-status');
    const msgEl = body.querySelector('#tg-msg');
    let configured = false;   // a token is already saved by the sidecar -> Connect can reconnect without re-pasting
    function paint(st) {
      const conn = st && st.connected;
      configured = !!(st && st.configured);
      const color = conn ? 'var(--ok)' : (configured ? 'var(--gold)' : 'var(--ph-dim)');
      statusEl.style.color = color;
      statusEl.textContent = conn ? ('● CONNECTED — polling' + (st.state && st.state !== 'up' ? ' (' + st.state + ')' : ''))
        : configured ? ('○ saved but offline — click CONNECT to reconnect' + (st.detail ? ' — ' + st.detail : ''))
        : '○ not connected';
      const nb = body.querySelector('#tg-notify'); if (nb) nb.checked = !!(st && st.notifyAutonomous);   // B4 opt-in reflects server state
    }
    async function refresh() {
      try { const r = await fetch('/api/channels/telegram/status'); paint(await r.json()); }
      catch (_) { configured = false; statusEl.style.color = 'var(--ph-dim)'; statusEl.textContent = '○ sidecar offline'; }
    }
    buildMessaging._refresh = refresh;
    // live transport health: channel.connect (poll up / network down / fatal token error) is emitted + SSE-broadcast
    // by the hub. Subscribe ONCE so the status line updates the moment health changes — not only on panel reopen.
    if (!buildMessaging._wired && typeof U !== 'undefined' && U.bus) {
      buildMessaging._wired = true;
      U.bus.on('channel.connect', p => {
        if (p && p.channel === 'telegram' && buildMessaging._refresh && document.querySelector('#tg-status')) buildMessaging._refresh();
      });
    }
    body.querySelector('#tg-connect').addEventListener('click', async () => {
      const token = (body.querySelector('#tg-token').value || '').trim();
      // a saved token can be reused (reconnect) — only require a fresh token on first-time setup.
      if (!token && !configured) { sfx('bad'); msgEl.textContent = 'paste your @BotFather token first'; return; }
      const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
      const usingCodex = provider === 'codex' || provider === 'openai-codex';
      const key = (typeof Harness !== 'undefined' && Harness.getKey) ? (Harness.getKey(provider) || '') : '';
      const baseUrl = (typeof Harness !== 'undefined' && Harness.getBaseUrl) ? (Harness.getBaseUrl(provider) || '') : '';
      const hasStoredKey = !!(typeof Harness !== 'undefined' && Harness.configured && Harness.configured(provider));
      const model = (typeof Harness !== 'undefined' && Harness.getModel()) || '';
      if (!model || (!usingCodex && !key && !hasStoredKey)) { sfx('bad'); msgEl.textContent = 'connect your agent (provider + model) on the title screen first'; return; }
      // hand the sidecar the REAL agent identity so Telegram is the SAME agent: the agentId the app uses for runs
      // (shared notebook/memory/workspace) + the composed system prompt (identity.md/purpose.md/manual.md).
      const ag = present[0] || {};
      const ws = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null;
      const agentId = (ws && ws.agentId) || 'agent';
      const system = (ag && ag.systemPrompt) || '';
      const agentName = (ag && ag.name) || '';
      msgEl.textContent = 'connecting…';
      try {
        const r = await fetch('/api/channels/telegram/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, key, model, provider, baseUrl, agentId, system, agentName }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) { msgEl.textContent = '✕ ' + (j.error || ('HTTP ' + r.status)); sfx('bad'); }
        else { msgEl.textContent = '✓ connected — open Telegram and DM your bot'; sfx('click'); notify('Telegram bot connected', 'good'); body.querySelector('#tg-token').value = ''; }
      } catch (e) { msgEl.textContent = '✕ ' + ((e && e.message) || 'failed to reach the sidecar'); sfx('bad'); }
      refresh();
    });
    body.querySelector('#tg-disconnect').addEventListener('click', async () => {
      try { await fetch('/api/channels/telegram/disconnect', { method: 'POST' }); msgEl.textContent = 'disconnected'; sfx('click'); }
      catch (_) { msgEl.textContent = 'could not reach the sidecar'; }
      refresh();
    });
    body.querySelector('#tg-token').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); body.querySelector('#tg-connect').click(); } });
    // B4 — toggle the global "ping me when I work on my own" opt-in (persisted server-side; the cron path reads it).
    const notifyBox = body.querySelector('#tg-notify');
    if (notifyBox) notifyBox.addEventListener('change', async () => {
      try { await fetch('/api/channels/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: notifyBox.checked }) }); sfx('click'); msgEl.textContent = notifyBox.checked ? '✓ i’ll ping you when i work on my own' : 'autonomous pings off'; }
      catch (_) { msgEl.textContent = 'could not reach the sidecar'; }
    });

    // ---- DISCORD card — the exact Telegram flow against the /api/channels/discord/* endpoints ----
    const dcStatusEl = body.querySelector('#dc-status');
    const dcMsgEl = body.querySelector('#dc-msg');
    let dcConfigured = false;   // a token is already saved -> Connect can reconnect without re-pasting
    function dcPaint(st) {
      const conn = st && st.connected;
      const state = st && st.state;
      // the gateway is mid-handshake or recovering — configured but not yet live (amber, not green/grey).
      const inFlight = !conn && (state === 'connecting' || state === 'reconnecting');
      dcConfigured = !!(st && st.configured);
      dcStatusEl.style.color = conn ? 'var(--ok)' : (inFlight || dcConfigured ? 'var(--gold)' : 'var(--ph-dim)');
      dcStatusEl.textContent = conn ? ('● CONNECTED — receiving' + (state && state !== 'up' ? ' (' + state + ')' : ''))
        : inFlight ? ('◐ ' + (state === 'reconnecting' ? 'reconnecting' : 'connecting') + '…' + (st.detail ? ' — ' + st.detail : ''))
        : state === 'error' ? ('✕ error' + (st.detail ? ' — ' + st.detail : '') + ' — check the bot token / MESSAGE CONTENT intent')
        : dcConfigured ? ('○ saved but offline — click CONNECT to reconnect' + (st.detail ? ' — ' + st.detail : ''))
        : '○ not connected';
      const nb = body.querySelector('#dc-notify'); if (nb) nb.checked = !!(st && st.notifyAutonomous);   // shared global opt-in
    }
    async function dcRefresh() {
      try { const r = await fetch('/api/channels/discord/status'); dcPaint(await r.json()); }
      catch (_) { dcConfigured = false; dcStatusEl.style.color = 'var(--ph-dim)'; dcStatusEl.textContent = '○ sidecar offline'; }
    }
    buildMessaging._refreshDiscord = dcRefresh;
    if (!buildMessaging._wiredDiscord && typeof U !== 'undefined' && U.bus) {
      buildMessaging._wiredDiscord = true;
      U.bus.on('channel.connect', p => {
        if (p && p.channel === 'discord' && buildMessaging._refreshDiscord && document.querySelector('#dc-status')) buildMessaging._refreshDiscord();
      });
    }
    body.querySelector('#dc-connect').addEventListener('click', async () => {
      const token = (body.querySelector('#dc-token').value || '').trim();
      if (!token && !dcConfigured) { sfx('bad'); dcMsgEl.textContent = 'paste your Discord bot token first'; return; }
      const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
      const usingCodex = provider === 'codex' || provider === 'openai-codex';
      const key = (typeof Harness !== 'undefined' && Harness.getKey) ? (Harness.getKey(provider) || '') : '';
      const baseUrl = (typeof Harness !== 'undefined' && Harness.getBaseUrl) ? (Harness.getBaseUrl(provider) || '') : '';
      const hasStoredKey = !!(typeof Harness !== 'undefined' && Harness.configured && Harness.configured(provider));
      const model = (typeof Harness !== 'undefined' && Harness.getModel()) || '';
      if (!model || (!usingCodex && !key && !hasStoredKey)) { sfx('bad'); dcMsgEl.textContent = 'connect your agent (provider + model) on the title screen first'; return; }
      const ag = present[0] || {};
      const ws = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null;
      const agentId = (ws && ws.agentId) || 'agent';
      const system = (ag && ag.systemPrompt) || '';
      const agentName = (ag && ag.name) || '';
      dcMsgEl.textContent = 'connecting…';
      try {
        const r = await fetch('/api/channels/discord/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, key, model, provider, baseUrl, agentId, system, agentName }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) { dcMsgEl.textContent = '✕ ' + (j.error || ('HTTP ' + r.status)); sfx('bad'); }
        else { dcMsgEl.textContent = '✓ connected — DM your bot on Discord'; sfx('click'); notify('Discord bot connected', 'good'); body.querySelector('#dc-token').value = ''; }
      } catch (e) { dcMsgEl.textContent = '✕ ' + ((e && e.message) || 'failed to reach the sidecar'); sfx('bad'); }
      dcRefresh();
    });
    body.querySelector('#dc-disconnect').addEventListener('click', async () => {
      try { await fetch('/api/channels/discord/disconnect', { method: 'POST' }); dcMsgEl.textContent = 'disconnected'; sfx('click'); }
      catch (_) { dcMsgEl.textContent = 'could not reach the sidecar'; }
      dcRefresh();
    });
    body.querySelector('#dc-token').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); body.querySelector('#dc-connect').click(); } });
    // the Discord card's notify checkbox drives the SAME global opt-in; keep the Telegram checkbox in sync on change.
    const dcNotifyBox = body.querySelector('#dc-notify');
    if (dcNotifyBox) dcNotifyBox.addEventListener('change', async () => {
      try { await fetch('/api/channels/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: dcNotifyBox.checked }) }); sfx('click'); if (notifyBox) notifyBox.checked = dcNotifyBox.checked; dcMsgEl.textContent = dcNotifyBox.checked ? '✓ i’ll ping you when i work on my own' : 'autonomous pings off'; }
      catch (_) { dcMsgEl.textContent = 'could not reach the sidecar'; }
    });

    refresh();
    dcRefresh();
  }

  /* ============== CONNECTORS — attach MCP servers so agents gain external tools ==============
     A connector is a remote MCP (Model Context Protocol) server. Once added + connected, its tools
     become real agent tools, gated by the same consent prompt as everything else. The server URL +
     optional bearer token are stored by the sidecar (never displayed) via /api/connectors. */
  function buildConnectors(body) {
    body.innerHTML =
      '<h4 class="ms-h">SPOTIFY</h4>' +
      '<p class="set-about">Let your agents <b>search & control your Spotify</b> — play, pause, queue, “what’s playing”. ' +
        'One-time setup: make a free app at <span class="dim">developer.spotify.com/dashboard</span>, add the redirect URI below to it, paste the Client ID, then connect. ' +
        '<span class="dim">(OAuth PKCE — no client secret is ever stored.)</span></p>' +
      '<div id="sp-status" class="mc-url dim">checking…</div>' +
      '<div class="mc-form">' +
        '<input id="sp-client" class="key-input" placeholder="Spotify Client ID" autocomplete="off" spellcheck="false" maxlength="64">' +
        '<div class="mc-url dim">Redirect URI to whitelist: <code id="sp-redir">…</code></div>' +
        '<div class="mc-acts">' +
          '<button class="bb sm" id="sp-connect">▶ CONNECT SPOTIFY</button>' +
          '<button class="bb xs danger" id="sp-disconnect" style="display:none">✕ DISCONNECT</button>' +
        '</div>' +
      '</div>' +
      '<div id="sp-msg" class="msg"></div>' +
      '<h4 class="ms-h">MCP CONNECTORS</h4>' +
      '<p class="set-about">Attach an <b>MCP server</b> to give your agents external tools (GitHub, Slack, a database…). ' +
        'Its tools appear automatically and run through the same approval gate as the built-ins. ' +
        '<span class="dim">(Remote http(s) servers, or a local <code>stdio</code> command. Secrets are stored locally by the sidecar and never displayed.)</span></p>' +
      '<div id="mc-list" class="mc-list"><span class="loading pulse">loading…</span></div>' +
      '<h4 class="ms-h" id="mc-form-h">ADD A CONNECTOR</h4>' +
      '<div class="mc-form" id="mc-form">' +
        '<input id="mc-id" class="key-input" placeholder="id — e.g. github (a-z 0-9 _ -)" autocomplete="off" spellcheck="false" maxlength="40">' +
        '<div class="mc-hint">A short handle for this server. Its tools appear to agents as <code>mcp__&lt;id&gt;__&lt;tool&gt;</code>.</div>' +
        '<input id="mc-label" class="key-input" placeholder="label (optional) — e.g. GitHub" autocomplete="off" spellcheck="false">' +
        '<div class="mc-seg" id="mc-transport" role="tablist">' +
          '<button type="button" class="mc-seg-btn active" data-tp="http" role="tab" aria-selected="true">HTTP</button>' +
          '<button type="button" class="mc-seg-btn" data-tp="stdio" role="tab" aria-selected="false">STDIO (local)</button>' +
        '</div>' +
        // ---- HTTP fields ----
        '<div class="mc-tp-fields" data-tp="http">' +
          '<input id="mc-url" class="key-input" placeholder="https://server.example/mcp" autocomplete="off" spellcheck="false">' +
          '<div class="mc-hint">The server’s Streamable-HTTP endpoint. <code>http://</code> is allowed only for localhost.</div>' +
          '<input id="mc-token" type="password" class="key-input" placeholder="bearer token (optional)" autocomplete="off" spellcheck="false">' +
          '<div class="mc-hint">Sent as <code>Authorization: Bearer …</code>. Leave blank when editing to keep the saved token.</div>' +
          '<textarea id="mc-headers" class="key-input mc-kv" placeholder="extra headers (optional), one per line:&#10;X-Api-Version: 2024-01" spellcheck="false" rows="2"></textarea>' +
          '<div class="mc-hint">Custom request headers as <code>Name: value</code>, one per line.</div>' +
        '</div>' +
        // ---- STDIO fields ----
        '<div class="mc-tp-fields" data-tp="stdio" style="display:none">' +
          '<input id="mc-command" class="key-input" placeholder="command — e.g. npx" autocomplete="off" spellcheck="false">' +
          '<div class="mc-hint">Allowed launchers: <code>node</code>, <code>npx</code>, <code>npm</code>, <code>pnpm</code>, <code>yarn</code>, <code>python</code>, <code>uvx</code>.</div>' +
          '<input id="mc-args" class="key-input" placeholder="args (space-separated) — e.g. -y @modelcontextprotocol/server-github" autocomplete="off" spellcheck="false">' +
          '<input id="mc-cwd" class="key-input" placeholder="working directory (optional)" autocomplete="off" spellcheck="false">' +
          '<textarea id="mc-env" class="key-input mc-kv" placeholder="env vars (optional), one per line:&#10;GITHUB_TOKEN=ghp_…" spellcheck="false" rows="2"></textarea>' +
          '<div class="mc-hint">Environment for the child process as <code>NAME=value</code>, one per line. Secret-looking values are never echoed back.</div>' +
        '</div>' +
        '<input id="mc-timeout" class="key-input" type="number" min="1000" max="600000" placeholder="timeout ms (optional, default 30000)" autocomplete="off">' +
        '<div class="mc-hint">How long to wait for the handshake / a tool call before giving up. Default 30s.</div>' +
        '<div class="mc-acts">' +
          '<button class="bb sm" id="mc-add">+ ADD &amp; CONNECT</button>' +
          '<button class="bb xs" id="mc-cancel" style="display:none">CANCEL EDIT</button>' +
        '</div>' +
      '</div>' +
      '<div id="mc-msg" class="msg"></div>';

    const listEl = body.querySelector('#mc-list');
    const msgEl = body.querySelector('#mc-msg');
    const formH = body.querySelector('#mc-form-h');
    const addBtn = body.querySelector('#mc-add');
    const cancelBtn = body.querySelector('#mc-cancel');
    const idInput = body.querySelector('#mc-id');
    let editing = null;   // id being edited (null = adding a new connector)

    // ----- transport segmented toggle -----
    function transport() { const on = body.querySelector('.mc-seg-btn.active'); return (on && on.dataset.tp) || 'http'; }
    function setTransport(tp) {
      body.querySelectorAll('.mc-seg-btn').forEach(b => { const a = b.dataset.tp === tp; b.classList.toggle('active', a); b.setAttribute('aria-selected', a ? 'true' : 'false'); });
      body.querySelectorAll('.mc-tp-fields').forEach(f => { f.style.display = f.dataset.tp === tp ? '' : 'none'; });
    }
    body.querySelector('#mc-transport').addEventListener('click', ev => {
      const b = ev.target.closest('.mc-seg-btn'); if (!b) return; setTransport(b.dataset.tp); sfx('tick');
    });

    // ----- key:value textarea parsers (headers use ':' , env uses '=') -----
    function parseKV(text, sep) {
      const out = {}; let bad = null;
      for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim(); if (!line) continue;
        const i = line.indexOf(sep); if (i < 1) { bad = line; break; }
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return { out, bad };
    }

    function resetForm() {
      editing = null;
      formH.textContent = 'ADD A CONNECTOR';
      addBtn.textContent = '+ ADD & CONNECT';
      cancelBtn.style.display = 'none';
      idInput.disabled = false;
      ['#mc-id', '#mc-label', '#mc-url', '#mc-token', '#mc-headers', '#mc-command', '#mc-args', '#mc-cwd', '#mc-env', '#mc-timeout']
        .forEach(s => { const el = body.querySelector(s); if (el) el.value = ''; });
      setTransport('http');
    }
    cancelBtn.addEventListener('click', () => { resetForm(); msgEl.textContent = ''; sfx('click'); });

    // populate the form from an existing connector for EDIT (secrets stay blank = keep-saved).
    function startEdit(c) {
      editing = c.id;
      formH.textContent = 'EDIT CONNECTOR — ' + (c.label || c.id);
      addBtn.textContent = '✓ SAVE & RECONNECT';
      cancelBtn.style.display = '';
      idInput.disabled = true;
      idInput.value = c.id;
      body.querySelector('#mc-label').value = c.label && c.label !== c.id ? c.label : '';
      body.querySelector('#mc-timeout').value = (c.timeoutMs && c.timeoutMs !== 30000) ? c.timeoutMs : '';
      setTransport(c.transport === 'stdio' ? 'stdio' : 'http');
      if (c.transport === 'stdio') {
        body.querySelector('#mc-command').value = c.command || '';
        body.querySelector('#mc-args').value = (c.args || []).join(' ');
        body.querySelector('#mc-cwd').value = c.cwd || '';
        // env values are redacted server-side; show keys with a placeholder so the user knows what's set.
        const envKeys = Object.keys(c.env || {});
        body.querySelector('#mc-env').value = envKeys.map(k => k + '=' + (c.env[k] === '<redacted>' ? '' : c.env[k])).join('\n');
      } else {
        body.querySelector('#mc-url').value = c.url || '';
        body.querySelector('#mc-token').value = '';   // never round-trip the token
        const hKeys = Object.keys(c.headers || {});
        body.querySelector('#mc-headers').value = hKeys.map(k => k + ': ' + (c.headers[k] === '<redacted>' ? '' : c.headers[k])).join('\n');
      }
      formH.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      idInput.focus();
      sfx('click');
    }

    function badge(state) {
      return ({ up: ['var(--ok)', '● connected'], connecting: ['var(--gold)', '◌ connecting…'],
                down: ['var(--ph-dim)', '○ disabled'], error: ['var(--bad)', '✕ error'] })[state] || ['var(--ph-dim)', '○ ' + esc(state || 'unknown')];
    }
    function row(c, ri) {
      const b = badge(c.state);
      const tools = (c.tools && c.tools.length) ? '<div class="mc-tools">' + c.tools.map(t => '<code>' + esc(t) + '</code>').join('') + '</div>' : '';
      const detail = (c.state === 'error' && c.detail) ? '<div class="mc-detail">' + esc(c.detail) + '</div>' : '';
      const where = c.transport === 'stdio'
        ? ('<span class="mc-tag">stdio</span> <code>' + esc([c.command].concat(c.args || []).join(' ')) + '</code>' + (c.hasEnv ? ' · env set' : ''))
        : ('<span class="mc-tag">http</span> ' + esc(c.url) + (c.hasToken ? ' · token saved' : '') + (c.hasHeaders ? ' · headers set' : ''));
      const timeout = (c.timeoutMs && c.timeoutMs !== 30000) ? '<span class="dim"> · ' + Math.round(c.timeoutMs / 1000) + 's</span>' : '';
      return '<div class="mc-row" data-id="' + esc(c.id) + '" data-enabled="' + (c.enabled ? '1' : '0') + '" style="--ci:' + (ri || 0) + '">' +
        '<div class="mc-top"><b>' + esc(c.label || c.id) + '</b> <span class="dim">' + esc(c.id) + '</span>' +
          '<span class="mc-state" style="color:' + b[0] + '">' + b[1] + (c.toolCount ? ' · ' + c.toolCount + ' tool' + (c.toolCount === 1 ? '' : 's') : '') + '</span></div>' +
        '<div class="mc-url dim">' + where + timeout + '</div>' + detail + tools +
        '<div class="mc-acts">' +
          '<button class="bb xs" data-act="reload">↻ RELOAD</button>' +
          '<button class="bb xs" data-act="edit">✎ EDIT</button>' +
          '<button class="bb xs" data-act="toggle">' + (c.enabled ? '⏸ DISABLE' : '▶ ENABLE') + '</button>' +
          '<button class="bb xs danger" data-act="remove">✕ REMOVE</button>' +
        '</div></div>';
    }
    let lastList = [];
    async function refresh() {
      try {
        const j = await (await fetch('/api/connectors')).json();
        const list = (j && j.connectors) || []; lastList = list;
        if (list.length) { listEl.innerHTML = list.map(row).join(''); }
        else {
          listEl.innerHTML = '<div class="empty-state"><span class="es-glyph">⧉</span>' +
            '<b>NO CONNECTORS YET</b><span>Attach an MCP server to give your agents external tools — GitHub, Slack, a database.</span>' +
            '<button class="es-cta" id="mc-empty-cta" type="button">+ ADD A CONNECTOR</button></div>';
          const cta = listEl.querySelector('#mc-empty-cta');
          if (cta) cta.addEventListener('click', () => { sfx('click'); const idf = body.querySelector('#mc-id'); if (idf) idf.focus(); });
        }
      } catch (_) { listEl.innerHTML = '<div class="mc-detail">sidecar offline — start it to manage connectors.</div>'; }
    }
    const postJSON = (path, payload) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    listEl.addEventListener('click', async ev => {
      const btn = ev.target.closest('button[data-act]'); if (!btn) return;
      const rowEl = ev.target.closest('.mc-row'); const id = rowEl && rowEl.dataset.id; if (!id) return;
      const act = btn.dataset.act;
      if (act === 'edit') { const c = lastList.find(x => x.id === id); if (c) startEdit(c); return; }
      btn.disabled = true;
      try {
        if (act === 'remove') { await postJSON('/api/connectors/remove', { id }); notify('Connector "' + id + '" removed'); sfx('click'); if (editing === id) resetForm(); }
        else if (act === 'reload') {
          msgEl.classList.remove('ok'); msgEl.textContent = 'reloading ' + id + '…';
          const j = await (await postJSON('/api/connectors/refresh', { id })).json().catch(() => ({}));
          if (j.status && j.status.state === 'up') { msgEl.classList.add('ok'); msgEl.textContent = '✓ ' + id + ' — ' + (j.status.toolCount || 0) + ' tool(s)'; }
          else { msgEl.classList.remove('ok'); msgEl.textContent = '✕ ' + id + ' — ' + ((j.status && j.status.detail) || j.error || 'not connected'); }
          sfx('click');
        } else if (act === 'toggle') {
          const c = lastList.find(x => x.id === id) || {};
          await postJSON('/api/connectors', { id, transport: c.transport, enabled: rowEl.dataset.enabled !== '1' }); sfx('click');
        }
      } catch (e) { msgEl.classList.remove('ok'); msgEl.textContent = '✕ ' + ((e && e.message) || 'request failed'); sfx('bad'); }
      refresh();
    });
    addBtn.addEventListener('click', async () => {
      const id = (idInput.value || '').trim();
      const label = (body.querySelector('#mc-label').value || '').trim();
      const tp = transport();
      if (!id) { sfx('bad'); msgEl.classList.remove('ok'); msgEl.textContent = 'an id is required'; return; }
      const payload = { id, label, transport: tp, enabled: true };
      if (tp === 'http') {
        const url = (body.querySelector('#mc-url').value || '').trim();
        if (!url) { sfx('bad'); msgEl.classList.remove('ok'); msgEl.textContent = 'a server URL is required'; return; }
        payload.url = url;
        const token = body.querySelector('#mc-token').value || '';
        if (token) payload.token = token;   // blank keeps the saved one (on edit)
        const h = parseKV(body.querySelector('#mc-headers').value, ':');
        if (h.bad) { sfx('bad'); msgEl.classList.remove('ok'); msgEl.textContent = 'header needs "Name: value" — check: ' + h.bad; return; }
        payload.headers = h.out;
      } else {
        const command = (body.querySelector('#mc-command').value || '').trim();
        if (!command) { sfx('bad'); msgEl.classList.remove('ok'); msgEl.textContent = 'a stdio command is required'; return; }
        payload.command = command;
        payload.args = (body.querySelector('#mc-args').value || '').trim().split(/\s+/).filter(Boolean);
        const cwd = (body.querySelector('#mc-cwd').value || '').trim(); if (cwd) payload.cwd = cwd;
        const e = parseKV(body.querySelector('#mc-env').value, '=');
        if (e.bad) { sfx('bad'); msgEl.classList.remove('ok'); msgEl.textContent = 'env var needs "NAME=value" — check: ' + e.bad; return; }
        payload.env = e.out;
      }
      const to = (body.querySelector('#mc-timeout').value || '').trim();
      if (to) payload.timeout = Number(to);
      msgEl.classList.remove('ok'); msgEl.textContent = (editing ? 'saving ' : 'connecting ') + id + '…';
      try {
        const j = await (await postJSON('/api/connectors', payload)).json().catch(() => ({}));
        if (j.error) { msgEl.classList.remove('ok'); msgEl.textContent = '✕ ' + j.error; sfx('bad'); }
        else if (j.status && j.status.state === 'up') {
          msgEl.classList.add('ok'); msgEl.textContent = '✓ connected — ' + (j.status.toolCount || 0) + ' tool(s) available'; sfx('click');
          notify('Connector "' + id + '" ' + (editing ? 'saved' : 'connected'), 'good');
          resetForm();
        } else { msgEl.classList.remove('ok'); msgEl.textContent = '✕ ' + ((j.status && j.status.detail) || ('state: ' + (j.state || 'error'))); sfx('bad'); }
      } catch (e) { msgEl.classList.remove('ok'); msgEl.textContent = '✕ ' + ((e && e.message) || 'failed to reach the sidecar'); sfx('bad'); }
      refresh();
    });
    refresh();
    setupSpotify(body);
  }

  /* ---- SPOTIFY connect (OAuth PKCE): open the consent window, then poll /api/spotify/status until the
     callback lands. The Client ID + tokens live in the sidecar; the browser only triggers the flow. ---- */
  function setupSpotify(body) {
    const statusEl = body.querySelector('#sp-status');
    const msgEl = body.querySelector('#sp-msg');
    const redirEl = body.querySelector('#sp-redir');
    const connectBtn = body.querySelector('#sp-connect');
    const disconnectBtn = body.querySelector('#sp-disconnect');
    const clientInput = body.querySelector('#sp-client');
    let pollTimer = null;
    async function refreshStatus() {
      try {
        const j = await (await fetch('/api/spotify/status')).json();
        if (redirEl && j.redirectUri) redirEl.textContent = j.redirectUri;
        if (j.connected) {
          statusEl.innerHTML = '<span style="color:var(--ok)">● connected</span>' + (j.scope ? ' <span class="dim">· ' + esc(j.scope) + '</span>' : '');
          connectBtn.textContent = '↻ RECONNECT';
          disconnectBtn.style.display = '';
        } else {
          statusEl.innerHTML = j.hasClientId ? '<span class="dim">○ not connected (Client ID saved)</span>' : '<span class="dim">○ not connected</span>';
          disconnectBtn.style.display = 'none';
          connectBtn.textContent = '▶ CONNECT SPOTIFY';
        }
        return j;
      } catch (_) { statusEl.textContent = 'sidecar offline — start the full app to connect Spotify.'; return null; }
    }
    connectBtn.addEventListener('click', async () => {
      const clientId = (clientInput.value || '').trim();
      msgEl.textContent = 'opening Spotify…';
      try {
        const j = await (await fetch('/api/spotify/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(clientId ? { clientId } : {}) })).json();
        if (j.error) { msgEl.textContent = '✕ ' + j.error; sfx('bad'); return; }
        window.open(j.url, '_blank', 'noopener');
        msgEl.textContent = 'Approve access in the window that opened, then return here — this updates automatically.';
        sfx('click');
        let n = 0; clearInterval(pollTimer);
        pollTimer = setInterval(async () => {
          n++; const s = await refreshStatus();
          if ((s && s.connected) || n > 60) { clearInterval(pollTimer); if (s && s.connected) { msgEl.textContent = '✓ Spotify connected'; notify('Spotify connected', 'good'); sfx('click'); } }
        }, 2000);
      } catch (e) { msgEl.textContent = '✕ ' + ((e && e.message) || 'failed to reach the sidecar'); sfx('bad'); }
    });
    disconnectBtn.addEventListener('click', async () => {
      try { await fetch('/api/spotify/disconnect', { method: 'POST' }); } catch (_) {}
      clearInterval(pollTimer); msgEl.textContent = 'disconnected'; notify('Spotify disconnected'); sfx('click'); refreshStatus();
    });
    refreshStatus();
  }

  /* ============== ROUTINES — scheduled autonomous runs (server-owned cron) ==============
     A routine wakes on a schedule and runs the agent UNATTENDED. The definitions live SERVER-side
     (schedule + boot-frozen secrets never touch the browser), so this panel is a thin CRUD client over
     /api/cron — render from GET, mutate via POST, re-fetch. Honest by construction: it shows a next-fire /
     last-result only from real server data, and says plainly when the scheduler tick is off. */
  function fmtRel(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso); if (isNaN(t)) return '—';
    const d = t - Date.now(), a = Math.abs(d);
    if (a < 60000) return 'now';
    const span = a < 3600000 ? (Math.round(a / 60000) + 'm') : a < 86400000 ? (Math.round(a / 3600000) + 'h') : (Math.round(a / 86400000) + 'd');
    return d >= 0 ? ('in ' + span) : (span + ' ago');
  }
  function buildRoutines(body) {
    const roster = present.length ? present : [{ id: 'agent', name: 'Agent', color: 'var(--ph)' }];
    const hasSelected = roster.some(a => a && a.id === routineAgentId);
    if (!hasSelected) routineAgentId = (present[sel] && present[sel].id) || (roster[0] && roster[0].id) || 'agent';
    function agentFor(id) { return roster.find(a => a && a.id === id) || null; }
    function agentLabel(id) {
      const a = agentFor(id);
      if (!a) return id || 'agent';
      const nm = a.name || a.id;
      return nm === a.id ? nm : (nm + ' [' + a.id + ']');
    }
    function agentButton(a) {
      const id = (a && a.id) || 'agent';
      const nm = (a && (a.name || a.id)) || id;
      const active = id === routineAgentId;
      return '<button type="button" class="rt-agent-btn' + (active ? ' active' : '') + '" data-agent="' + esc(id) + '" aria-pressed="' + (active ? 'true' : 'false') + '" style="--rt-agent-color:' + esc((a && a.color) || 'var(--ph)') + '">' +
        '<span class="rt-agent-dot"></span><span class="rt-agent-name">' + esc(nm) + '</span><span class="rt-agent-id">' + esc(id) + '</span></button>';
    }
    body.innerHTML =
      '<div class="sec"><span class="sec-l">SCHEDULED ROUTINES</span><span class="sec-r"></span><span class="sec-nd"></span></div>' +
      '<div class="brief-block"><div class="brief-k">HOW IT WORKS</div>' +
        '<div class="brief-v">A routine wakes on a schedule and runs your agent <b>unattended</b>, using your connected key + model. ' +
        'With no one watching, ungranted file writes are denied silently unless you have pre-approved them. ' +
        '<span class="dim">(Schedules: "every 30m", "every 1h", "in 2h", "0 9 * * *", or an ISO timestamp like 2026-07-01T09:00.)</span></div></div>' +
      '<div id="rt-gate" class="set-about"></div>' +
      // SELF-INITIATION (autonomy Slice 2): let the agent propose standing jobs grounded in what it knows about you.
      '<button class="bb sm" id="rt-propose" style="margin:2px 0 6px">✦ SUGGEST ROUTINES</button>' +
      '<div id="rt-list" class="mc-list"><span class="loading pulse">loading…</span></div>' +
      '<div class="sec"><span class="sec-l">ADD A ROUTINE</span><span class="sec-r"></span><span class="sec-nd"></span></div>' +
      '<div class="mc-form">' +
        '<input id="rt-name" class="key-input" placeholder="name — e.g. Morning AI brief" maxlength="80" autocomplete="off">' +
        '<textarea id="rt-prompt" class="key-input" rows="2" placeholder="what should it do each run? e.g. search for new AI-policy news and summarize the top 3" style="resize:vertical"></textarea>' +
        '<input id="rt-sched" class="key-input" placeholder="schedule — every 30m · 0 9 * * * · in 2h" autocomplete="off">' +
        '<div id="rt-preview" class="dim" style="min-height:1em;font-size:.9em"></div>' +
        '<div class="rt-agent-pick" role="group" aria-label="Routine agent">' + roster.map(agentButton).join('') + '</div>' +
        '<input id="rt-agent" type="hidden" value="' + esc(routineAgentId) + '">' +
        '<button class="bb sm" id="rt-add">+ ADD ROUTINE</button>' +
      '</div>' +
      '<div id="rt-msg" class="msg"></div>' +
      '<div id="rt-out" class="msg" hidden style="white-space:pre-wrap;max-height:220px;overflow:auto"></div>';

    const listEl = body.querySelector('#rt-list'), gateEl = body.querySelector('#rt-gate');
    const msgEl = body.querySelector('#rt-msg'), outEl = body.querySelector('#rt-out');
    const post = (path, payload) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

    function lastResult(j) {
      if (!j.lastRunAt) return '<span class="dim">never run</span>';
      const ok = j.lastStatus === 'ok';
      return '<span class="' + (ok ? 'pos' : '') + '"' + (ok ? '' : ' style="color:var(--bad)"') + '>' + (ok ? '✓ ok' : '✕ ' + esc(j.lastReason || 'error')) + '</span> <span class="dim">' + esc(fmtRel(j.lastRunAt)) + '</span>';
    }
    function row(j) {
      const on = j.enabled;
      const stateBadge = on ? '<span style="color:var(--gold)">● scheduled</span>' : '<span class="dim">○ paused</span>';
      const next = on && j.nextRunAt ? esc(fmtRel(j.nextRunAt)) : '—';
      return '<div class="mc-row" data-id="' + esc(j.id) + '" data-on="' + (on ? '1' : '0') + '">' +
        '<div class="mc-top"><b>' + esc(j.name || '(unnamed)') + '</b> <span class="dim">' + esc(j.scheduleDisplay || '') + '</span> ' + stateBadge + '</div>' +
        '<div class="mc-url dim">runs as ' + esc(agentLabel(j.agentId || 'agent')) + ' · next ' + next + ' · last ' + lastResult(j) + '</div>' +
        (j.lastError ? '<div class="mc-detail">' + esc(j.lastError) + '</div>' : '') +
        '<div class="mc-acts">' +
          '<button class="bb xs" data-act="run">▶ RUN NOW</button>' +
          '<button class="bb xs" data-act="toggle">' + (on ? '⏸ DISABLE' : '▶ ENABLE') + '</button>' +
          '<button class="bb xs danger" data-act="remove">✕ DELETE</button>' +
        '</div></div>';
    }
    async function refresh() {
      try {
        const j = await (await fetch('/api/cron')).json();
        const jobs = (j && j.jobs) || [];
        // HONEST disabled-state + one-click ENABLE (G4.6): when the scheduler is OFF, say plainly that routines
        // will NOT fire and offer a one-click ENABLE that arms the live timer (no env edit / restart). When ON,
        // show the armed state + a DISABLE control. `enabled` comes straight from GET /api/cron (the live
        // cronArmed), so the badge reflects a runtime arm/disarm immediately.
        gateEl.innerHTML = j && j.enabled
          ? '<span style="color:var(--gold)">● scheduler armed</span> <span class="dim">— routines fire automatically.</span> ' +
            '<button class="bb xs" id="rt-arm" data-arm="0">⏸ DISABLE SCHEDULING</button>'
          : '<span style="color:var(--bad)">○ scheduling is OFF — routines will <b>NOT</b> fire.</span> ' +
            '<span class="dim">Your routines are saved but dormant until you enable the scheduler.</span> ' +
            '<button class="bb xs" id="rt-arm" data-arm="1">▶ ENABLE SCHEDULING</button>';
        const armBtn = gateEl.querySelector('#rt-arm');
        if (armBtn) armBtn.addEventListener('click', async () => {
          const want = armBtn.dataset.arm === '1';
          armBtn.disabled = true; armBtn.textContent = want ? '… enabling' : '… disabling';
          try {
            const r = await (await post('/api/cron/arm', { enabled: want })).json();
            if (r && r.ok) { notify(want ? 'scheduling enabled — routines will now fire' : 'scheduling disabled', want ? 'good' : 'warn'); sfx('click'); }
            else { notify((r && r.error) || 'could not change scheduling', 'warn'); sfx('bad'); }
          } catch (_) { notify('could not reach the sidecar', 'warn'); sfx('bad'); }
          refresh();   // re-render the badge from the authoritative GET /api/cron enabled
        });
        if (jobs.length) { listEl.innerHTML = jobs.map((j, i) => row(j).replace('<div class="mc-row"', '<div class="mc-row" style="--ci:' + i + '"')).join(''); }
        else {
          listEl.innerHTML = '<div class="empty-state"><span class="es-glyph">◷</span>' +
            '<b>NO ROUTINES YET</b><span>Put your agent to work on a schedule — a morning brief, a nightly summary, a recurring check.</span>' +
            '<button class="es-cta" id="rt-empty-cta" type="button">+ ADD A ROUTINE</button></div>';
          const cta = listEl.querySelector('#rt-empty-cta');
          if (cta) cta.addEventListener('click', () => { sfx('click'); const nm = body.querySelector('#rt-name'); if (nm) nm.focus(); });
        }
      } catch (_) { listEl.innerHTML = '<div class="mc-detail">sidecar offline — start it to manage routines.</div>'; }
    }

    // SELF-INITIATION: the agent reasons out a few standing-job proposals from the dossier, the Commander approves
    // the ones they want (a Dialogue beat), and each approved one is created via POST /api/cron — then we refresh
    // the list so the new routines appear inline. An explicit ask, always allowed (it's the manual counterpart to
    // the one-time proactive offer). Falls back gracefully if the engine/store isn't present.
    const propBtn = body.querySelector('#rt-propose');
    if (propBtn) propBtn.addEventListener('click', async () => {
      if (typeof AutoJobStore === 'undefined' || !AutoJobStore.propose) { notify('self-initiation is unavailable', 'warn'); return; }
      propBtn.disabled = true; sfx('click');
      try {
        const r = await AutoJobStore.propose();
        if (r && r.scheduled) { notify(r.scheduled + ' routine' + (r.scheduled === 1 ? '' : 's') + ' scheduled', 'good'); refresh(); }
      } catch (_) {} finally { propBtn.disabled = false; }
    });

    // live schedule preview (debounced) — the honest "next fires", straight from the server math.
    let pvTimer = null;
    const schedInp = body.querySelector('#rt-sched'), pvEl = body.querySelector('#rt-preview');
    schedInp.addEventListener('input', () => {
      clearTimeout(pvTimer);
      const v = schedInp.value.trim();
      if (!v) { pvEl.textContent = ''; return; }
      pvTimer = setTimeout(async () => {
        try {
          const r = await (await post('/api/cron/preview', { schedule: v })).json();
          if (r && r.ok) {
            // show the LOCAL wall-clock time the routine fires (with its tz), not just a relative delta, so a
            // cron schedule reads honestly across DST (e.g. "next: 9:00 AM EDT (in 3h)"). Falls back to the
            // relative-only line when the server didn't supply a localNext (interval/once).
            const ln = Array.isArray(r.localNext) ? r.localNext : [];
            const tzNote = (r.kind === 'cron' && r.tz && r.tz !== 'UTC') ? ' <span class="dim">[' + esc(r.tz) + ']</span>' : '';
            const nxt = r.next.slice(0, 3).map((t, i) => {
              const local = ln[i] ? esc(ln[i]) : '';
              return local ? (local + ' <span class="dim">(' + esc(fmtRel(t)) + ')</span>') : esc(fmtRel(t));
            }).join(', ');
            pvEl.innerHTML = '✓ ' + esc(r.display) + tzNote + ' → next: ' + nxt;
          }
          else pvEl.innerHTML = '<span style="color:var(--bad)">' + esc((r && r.error) || 'unrecognized schedule') + '</span>';
        } catch (_) {}
      }, 300);
    });

    body.querySelectorAll('.rt-agent-btn').forEach(btn => btn.addEventListener('click', () => {
      routineAgentId = btn.dataset.agent || 'agent';
      const input = body.querySelector('#rt-agent');
      if (input) input.value = routineAgentId;
      body.querySelectorAll('.rt-agent-btn').forEach(b => {
        const on = b.dataset.agent === routineAgentId;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      sfx('click');
    }));

    // row actions: run-now (stream + show the reply), toggle enable/disable, delete (two-step arm/confirm).
    listEl.addEventListener('click', async ev => {
      const btn = ev.target.closest('button[data-act]'); if (!btn) return;
      const rowEl = ev.target.closest('.mc-row'); const id = rowEl && rowEl.dataset.id; if (!id) return;
      const act = btn.dataset.act;
      if (act === 'remove') {
        if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = '✕ CONFIRM'; sfx('bad'); setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = '✕ DELETE'; } }, 5000); return; }
        sfx('bad'); try { await post('/api/cron/remove', { id }); notify('routine deleted'); } catch (_) {} refresh(); return;
      }
      if (act === 'toggle') {
        sfx('click'); const on = rowEl.dataset.on === '1';
        try { await post('/api/cron/update', { id, patch: { enabled: !on } }); } catch (_) {} refresh(); return;
      }
      if (act === 'run') {
        sfx('click'); btn.disabled = true; const old = btn.textContent; btn.textContent = '… running';
        outEl.hidden = false; outEl.textContent = 'running…';
        try {
          const resp = await post('/api/cron/run', { id });
          if (!resp.ok || !resp.body) { const e = await resp.json().catch(() => ({})); outEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((e && e.error) || ('http ' + resp.status)) + '</span>'; sfx('bad'); }
          else {
            const reader = resp.body.getReader(), dec = new TextDecoder(); let sbuf = '', reply = '', err = '';
            for (;;) {
              const r = await reader.read(); if (r.done) break;
              sbuf += dec.decode(r.value, { stream: true });
              let nl; while ((nl = sbuf.indexOf('\n')) >= 0) { const line = sbuf.slice(0, nl); sbuf = sbuf.slice(nl + 1); if (!line.trim()) continue; try { const e = JSON.parse(line); if (e.name === 'agent.token') reply += ((e.payload && e.payload.delta) || ''); else if (e.name === 'agent.run.error') err = (e.payload && e.payload.message) || 'run error'; } catch (_) {} }
            }
            outEl.innerHTML = err ? ('<span style="color:var(--bad)">✕ ' + esc(err) + '</span>') : esc(reply || '(no output)');
            notify(err ? 'routine run failed' : 'routine ran', err ? 'warn' : 'good');
          }
        } catch (e) { outEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((e && e.message) || 'run failed') + '</span>'; sfx('bad'); }
        btn.disabled = false; btn.textContent = old; refresh();
      }
    });

    body.querySelector('#rt-add').addEventListener('click', async () => {
      const name = (body.querySelector('#rt-name').value || '').trim();
      const prompt = (body.querySelector('#rt-prompt').value || '').trim();
      const schedule = (body.querySelector('#rt-sched').value || '').trim();
      const agentId = (body.querySelector('#rt-agent').value || '').trim();
      const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : undefined;
      if (!prompt || !schedule) { sfx('bad'); msgEl.textContent = 'a prompt and a schedule are required'; return; }
      msgEl.textContent = 'saving…';
      try {
        const r = await (await post('/api/cron', { name, prompt, schedule, agentId: agentId || undefined, provider })).json();
        if (r && r.error) { msgEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc(r.error) + '</span>'; sfx('bad'); }
        else {
          msgEl.textContent = ''; notify('routine "' + (name || 'unnamed') + '" scheduled for ' + agentLabel(agentId || 'agent'), 'good'); sfx('click');
          ['#rt-name', '#rt-prompt', '#rt-sched'].forEach(s => { body.querySelector(s).value = ''; });
          pvEl.textContent = '';
        }
      } catch (e) { msgEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((e && e.message) || 'failed to reach the sidecar') + '</span>'; sfx('bad'); }
      refresh();
    });

    refresh();
  }

  /* ============== REWIND — restore points (the execution-spine checkpoint net) ==============
     Every command an agent runs auto-saves a workspace snapshot FIRST; this lists them per agent and
     restores one with a two-step confirm. Server-owned (GET/POST /api/checkpoint); honest — only real
     snapshots show, and it says plainly when there are none yet. */
  function buildRewind(body) {
    const agentId = (present[sel] && present[sel].id) || 'agent';
    body.innerHTML =
      '<h4 class="ms-h">RESTORE POINTS — ' + esc(agentId) + '</h4>' +
      '<p class="set-about">A snapshot of this agent\'s workspace is auto-saved <b>before every command it runs</b> ' +
      '(and before file edits when checkpoints are on). Restoring rolls the workspace back and removes anything ' +
      'created since. <span class="dim">Use it to undo a bad change.</span></p>' +
      '<div id="rw-list" class="mc-list"><span class="loading pulse">loading…</span></div>' +
      '<div id="rw-msg" class="msg"></div>';
    const listEl = body.querySelector('#rw-list'), msgEl = body.querySelector('#rw-msg');
    const post = (path, payload) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    function row(s) {
      const when = s.ts ? esc(fmtRel(new Date(s.ts).toISOString())) : '';
      return '<div class="mc-row" data-id="' + esc(s.id) + '">' +
        '<div class="mc-top"><b>' + esc(s.label || 'snapshot') + '</b> <span class="dim">' + when + '</span></div>' +
        '<div class="mc-url dim">' + esc(String(s.id).slice(0, 12)) + ' · turn ' + (s.turn || 0) + (s.files ? (' · ' + s.files + ' file' + (s.files === 1 ? '' : 's')) : '') + '</div>' +
        '<div class="mc-acts"><button class="bb xs danger" data-act="restore">↶ RESTORE</button></div>' +
        '</div>';
    }
    async function refresh() {
      try {
        const j = await (await fetch('/api/checkpoint?agent=' + encodeURIComponent(agentId))).json();
        const snaps = ((j && j.snapshots) || []).slice().reverse();   // newest first
        // honest empty-state: file-edit snapshots are opt-in (SKYNET_CHECKPOINTS); shell commands ALWAYS snapshot.
        // Tell the user what actually triggers a restore point under their current config, not an aspirational promise.
        const empty = (j && j.enabled)
          ? 'NO RESTORE POINTS YET.<br><span>They appear once this agent runs a command or edits a file at a WORKBENCH.</span>'
          : 'NO RESTORE POINTS YET.<br><span>They appear once this agent runs a <b>shell command</b>. File-edit snapshots aren\'t enabled on this station.</span>';
        listEl.innerHTML = snaps.length ? snaps.map(row).join('') : '<div class="fb-empty">' + empty + '</div>';
      } catch (_) { listEl.innerHTML = '<div class="mc-detail">sidecar offline — start it to manage restore points.</div>'; }
    }
    listEl.addEventListener('click', async ev => {
      const btn = ev.target.closest('button[data-act="restore"]'); if (!btn) return;
      const rowEl = ev.target.closest('.mc-row'); const id = rowEl && rowEl.dataset.id; if (!id) return;
      if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = '↶ CONFIRM'; sfx('bad'); setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = '↶ RESTORE'; } }, 5000); return; }
      sfx('bad'); btn.disabled = true;
      try {
        const r = await (await post('/api/checkpoint/restore', { agentId: agentId, snapshotId: id })).json();
        if (r && r.ok) { notify('rewound ' + agentId + ' to an earlier restore point', 'warn'); msgEl.textContent = '✓ restored.'; }
        else { msgEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((r && r.error) || 'restore failed') + '</span>'; sfx('bad'); }
      } catch (e) { msgEl.innerHTML = '<span style="color:var(--bad)">✕ ' + esc((e && e.message) || 'restore failed') + '</span>'; sfx('bad'); }
      btn.disabled = false; refresh();
    });
    refresh();
  }

  /* ============== LOGBOOK — the reviewable run-history + SLAG post-mortems (the durable record) ==============
     Two read-only surfaces the audit found were written-but-never-read: RUNS folds the append-only run-history
     logbook (GET /api/runs — every finished run's outcome/reason), and SLAG renders World.slagLog() — the
     unproductive-run post-mortems (cause + fix) that used to live only as a fading toast. (WIRING_AUDIT P7.) */
  const LB_REASON = { done: '✓ done', max_iters: '⟳ looped out', budget: 'over budget', cancelled: '⏹ cancelled', error: '✕ error', refusal: '⊘ refused' };
  function buildLogbook(body) {
    const agentId = (present[sel] && present[sel].id) || 'agent';
    body.innerHTML =
      '<h4 class="ms-h">LOGBOOK — ' + esc(agentId) + '</h4>' +
      '<div class="set-save"><button class="bb sm lb-tab active" data-tab="runs">▦ RUNS</button> ' +
      '<button class="bb sm lb-tab" data-tab="slag">⚠ SLAG</button> ' +
      '<button class="bb sm lb-tab" data-tab="insights">📊 INSIGHTS</button></div>' +
      '<p class="set-about" id="lb-about"></p>' +
      '<div id="lb-list" class="mc-list"><span class="loading pulse">loading…</span></div>';
    const listEl = body.querySelector('#lb-list'), aboutEl = body.querySelector('#lb-about');
    let tab = 'runs';
    function runRow(r) {
      const when = r.ts ? esc(fmtRel(new Date(r.ts).toISOString())) : '';
      const rl = LB_REASON[r.reason] || esc(r.reason || 'done');
      const title = r.title ? esc(r.title) : esc(String(r.runId || 'run').slice(0, 12));
      const model = esc(r.model || '(unknown)');
      // H3.2: a run with a streamId can OPEN its transcript inline (the join the audit found was missing).
      const sid = r.streamId ? esc(String(r.streamId)) : '';
      const cls = sid ? 'mc-row lb-run-open' : 'mc-row';
      const attr = sid ? ' data-stream="' + sid + '" title="click to open this run\'s transcript"' : '';
      return '<div class="' + cls + '"' + attr + '><div class="mc-top"><b>' + title + '</b> <span class="dim">' + when + (sid ? ' · ▸ transcript' : '') + '</span></div>' +
        '<div class="mc-url dim">' + rl + ' · ' + model + ' · ' + (r.turns || 0) + ' turn' + (r.turns === 1 ? '' : 's') + '</div>' +
        (sid ? '<div class="lb-tx" hidden></div>' : '') + '</div>';
    }
    function insightsHtml(j) {
      j = j || {};
      if (!j.totalRuns) return '<div class="fb-empty">NO DATA YET.<br><span>Insights appear once this agent finishes some runs.</span></div>';
      const ov = '<div class="mc-row"><div class="mc-top"><b>' + j.totalRuns + ' run' + (j.totalRuns === 1 ? '' : 's') + '</b></div>' +
        '<div class="mc-url dim">' + (j.successPct == null ? '—' : j.successPct + '% success') + '</div></div>';
      const models = (j.byModel || []).slice(0, 8).map(m =>
        '<div class="mc-row"><div class="mc-top"><b>' + esc(m.model) + '</b> <span class="dim">' + m.runs + ' run' + (m.runs === 1 ? '' : 's') + '</span></div></div>').join('');
      const reasons = Object.keys(j.byReason || {}).map(k => esc(k) + ' ' + j.byReason[k]).join(' · ');
      return ov + '<div class="mc-detail" style="margin:6px 0 2px;opacity:.7">BY MODEL</div>' + (models || '<div class="mc-detail dim">—</div>') +
        '<div class="mc-detail" style="margin:6px 0 2px;opacity:.7">OUTCOMES</div><div class="mc-detail dim">' + (reasons || '—') + '</div>';
    }
    function noSpendText(s) {
      return String(s || '')
        .replace(/\bspend\b/ig, 'run resources')
        .replace(/\bdollars?\b/ig, 'limits')
        .replace(/billed at full price every turn/ig, 'processed cold every turn')
        .replace(/~10× cheaper input/ig, 'more efficient input');
    }
    function slagRow(d) {
      return '<div class="mc-row"><div class="mc-top"><b style="color:var(--bad)">⚠ ' + esc(noSpendText(d.title || 'unproductive run')) + '</b></div>' +
        '<div class="mc-url dim">' + esc(noSpendText(d.cause || '')) + '</div>' +
        (d.fix ? '<div class="mc-detail">→ ' + esc(noSpendText(d.fix)) + '</div>' : '') + '</div>';
    }
    async function refresh() {
      if (tab === 'runs') {
        aboutEl.innerHTML = 'Every finished run, newest first — what it produced and why it ended.';
        try {
          const j = await (await fetch('/api/runs?agent=' + encodeURIComponent(agentId) + '&limit=100')).json();
          const runs = (j && j.runs) || [];
          listEl.innerHTML = runs.length ? runs.map(runRow).join('') : '<div class="fb-empty">NO RUNS YET.<br><span>Finished runs appear here once this agent does real work.</span></div>';
          // H3.2: clicking a run opens its durable transcript (GET /api/transcript?stream=) inline — toggle + lazy-load.
          listEl.querySelectorAll('.lb-run-open').forEach(row => row.addEventListener('click', async () => {
            const tx = row.querySelector('.lb-tx'); if (!tx) return;
            if (!tx.hidden) { tx.hidden = true; return; }
            tx.hidden = false;
            if (tx.dataset.loaded) return;
            tx.innerHTML = '<div class="mc-detail"><span class="loading">loading transcript…</span></div>';
            try {
              const t = await (await fetch('/api/transcript?stream=' + encodeURIComponent(row.dataset.stream) + '&agent=' + encodeURIComponent(agentId) + '&limit=50')).json();
              const turns = (t && t.turns) || [];
              tx.innerHTML = turns.length ? turns.map(m => '<div class="mc-detail"><b>' + esc(m.role) + ':</b> ' + esc(String(m.content || '').slice(0, 400)) + '</div>').join('') : '<div class="mc-detail">no transcript recorded for this workstream.</div>';
              tx.dataset.loaded = '1';
            } catch (_) { tx.innerHTML = '<div class="mc-detail">could not load transcript.</div>'; }
          }));
        } catch (_) { listEl.innerHTML = '<div class="mc-detail">sidecar offline — start it to see run history.</div>'; }
      } else if (tab === 'slag') {
        aboutEl.innerHTML = 'Post-mortems for runs that ended without a deliverable, diagnosed into a real, fixable cause.';
        let slag = [];
        try { if (typeof World !== 'undefined' && World.slagLog) slag = World.slagLog().slice().reverse(); } catch (_) {}
        listEl.innerHTML = slag.length ? slag.map(slagRow).join('') : '<div class="fb-empty">NO SLAG — clean line.<br><span>A post-mortem appears here when a run ends without producing a result.</span></div>';
      } else {
        // H3.3: aggregate outcomes folded from the run history (GET /api/insights).
        aboutEl.innerHTML = 'Run totals, success rate, and model distribution.';
        try {
          const j = await (await fetch('/api/insights?agent=' + encodeURIComponent(agentId))).json();
          listEl.innerHTML = insightsHtml(j);
        } catch (_) { listEl.innerHTML = '<div class="mc-detail">sidecar offline — start it to see insights.</div>'; }
      }
    }
    body.querySelectorAll('.lb-tab').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.tab === tab) return;
      tab = b.dataset.tab; sfx('click');
      body.querySelectorAll('.lb-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
      refresh();
    }));
    refresh();
  }

  /* ============== COMMANDER DOSSIER — the station-wide model of the USER (the glass box) ==============
     Phase A of docs/COMMANDER_DOSSIER_PLAN.md. ONE dossier, shared by every agent, that folds into each
     agent's system prompt (DossierStore.composeBlock) so a new agent knows the Commander on day one. This
     panel is the glass box: every belief the station holds about the Commander, grouped by dimension, with
     provenance — add / edit / pin / forget, all local-first. It reads + mutates DossierStore (which
     recomposes the live prompt + persists on each edit); the panel re-renders after a mutation. Belief text
     is rendered as textContent (never interpreted), mirroring the Memory Core's injection-safe discipline. */
  const CD_SOURCE = { onboarding: 'from your awakening', commander: 'you told the station', interview: 'from the intake interview', curiosity: 'you answered a question' };
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
    return el('div', 'cd-record',
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

    // header: the honest familiarity meter + the observed work-mix + the local-first promise
    const pct = Math.round((sum.familiarity || 0) * 100);
    const obs = sum.observed;
    const obsLine = (obs && obs.dominant && !obs.calibrating)
      ? 'Observed: you work mostly on <b>' + esc(obs.dominant) + '</b> tasks.'
      : 'Observed work-mix: <span class="dim">calibrating…</span>';
    const head = el('div', 'gx',
      '<div class="gx-head"><div><div class="gx-kicker">STATION // COMMANDER DOSSIER</div>' +
      '<div class="gx-name">What the station knows about you</div></div>' +
      '<div style="text-align:right;"><div class="gx-kicker" style="margin-bottom:6px;">FAMILIARITY</div>' +
      '<span class="cd-fam"><span class="cd-fk"><span class="cd-ff" style="width:' + pct + '%;"></span></span>' +
      '<span class="cd-fpct">' + (sum.known.length ? pct + '%' : 'calibrating') + '</span></span></div></div>' +
      '<div class="cd-sub">' + sum.known.length + ' of ' + dims.length + ' dimensions known &middot; ' + obsLine + '</div>' +
      '<div class="mc-note">This dossier is <b>shared by every agent on your station</b> and folds into each one\'s briefing, so a freshly-deployed agent already knows you. It is <b>local-first</b> — it never leaves this machine. Add, edit, pin, or forget anything below; you own it.</div>');
    body.appendChild(head);

    // STATION RECORD (G3a pride layer): the durable lifetime counters, honest by construction — a counter
    // with no real sample yet renders "—" (never a fabricated 0). Rendered here, on the station-wide dossier,
    // because it IS the colony's whole-lifetime track record. Absent store → silently omit (nothing to show).
    const rec = cdStationRecord();
    if (rec) body.appendChild(rec);

    // the active "get to know you" trigger — runs the intake interview in COMMS, folding answers into the
    // dossier through the same upsert path the cards use. Gated on a free agent + not-already-running.
    const actRow = el('div', 'cd-actions-row');
    const goBtn = el('button', 'cd-interview');
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
        onCommit: belief => ds.upsert(belief.dim, { text: belief.text, source: belief.source }),
        onDone: () => rerender('commander'),
        onEmpty: () => notify('the station already knows you — edit any belief below to refine', 'good')
      });
      if (began) { sfx('click'); notify('the station is interviewing you — answer in COMMS →', 'good'); }
    };
    actRow.appendChild(goBtn);
    body.appendChild(actRow);

    // one section per dimension
    for (const d of dims) {
      const bs = ds.beliefs(d.key);
      const sec = el('div', 'cd-sec');
      sec.appendChild(el('div', 'cd-sech', '<span class="cd-dim">' + esc(d.label) + '</span><span class="cd-dn">' + (bs.length || '—') + '</span>'));
      if (!bs.length) {
        const e = el('div', 'cd-empty'); e.textContent = 'unknown — the station hasn’t learned this yet.'; sec.appendChild(e);
        sec.appendChild(cdCurioRow(d));   // the question-state readout (asked / paused) + re-enable, when relevant
      }
      else for (const b of bs) sec.appendChild(cdCard(d.key, b));
      sec.appendChild(cdAddRow(d.key));
      body.appendChild(sec);
    }
  }

  // the curiosity question-state for a still-blank dimension: has the station asked about it, and did the Commander
  // wave it off / ignore it to the stop-forever limit? Shows nothing for a never-asked dimension; for a stopped one
  // it offers a re-enable (the escape hatch, mirroring Restore on the memory side). Returns an empty fragment-row
  // when there's nothing to say, so the caller can append unconditionally.
  function cdCurioRow(d) {
    const row = el('div', 'cd-curio');
    if (typeof CuriosityStore === 'undefined' || !CuriosityStore.statusOf) return row;
    const st = CuriosityStore.statusOf(d.key);
    if (!st.stopped && !st.asked) return row;   // never asked → say nothing (keeps the panel quiet)
    const lbl = el('span', 'cd-curio-lbl');
    lbl.textContent = st.stopped
      ? (st.dismissed ? '⏸ you waved this question off' : '⏸ the station stopped asking — you skipped it')
      : ('· the station asked once, waiting');
    row.appendChild(lbl);
    if (st.stopped) {
      const rb = el('button', 'consent-btn cd-reenable'); rb.textContent = 'ask me about this';
      rb.title = 'turn this question back on — the station may ask about your ' + String(d.label).toLowerCase() + ' again';
      rb.onclick = () => { CuriosityStore.reEnable(d.key); sfx('click'); notify('the station will ask about your ' + String(d.label).toLowerCase() + ' again', 'good'); rerender('commander'); };
      row.appendChild(rb);
    }
    return row;
  }

  function cdCard(dim, b) {
    const card = el('div', 'cd-rec' + (b.pinned ? ' pinned' : ''));
    const txt = el('div', 'cd-body'); txt.textContent = b.text; card.appendChild(txt);   // textContent — belief text is never interpreted
    const meta = el('span', 'cd-src');
    meta.textContent = (b.pinned ? '★ pinned · ' : '') + (CD_SOURCE[b.source] || 'you told the station') + (b.createdAt ? ' · ' + new Date(b.createdAt).toLocaleDateString() : '');
    card.appendChild(el('div', 'cd-meta')).appendChild(meta);

    const btns = el('div', 'consent-btns cd-acts'); card.appendChild(btns);
    let busy = false;
    const mk = (label, cls, fn) => { const x = el('button', 'consent-btn' + (cls ? ' ' + cls : '')); x.textContent = label; x.onclick = fn; btns.appendChild(x); return x; };
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
    const ta = el('textarea', 'cd-edit'); ta.value = b.text; ta.spellcheck = false;
    card.replaceChild(ta, txt); ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {}
    btns.innerHTML = '';
    const save = el('button', 'consent-btn'); save.textContent = 'Save'; btns.appendChild(save);
    const cancel = el('button', 'consent-btn'); cancel.textContent = 'Cancel'; btns.appendChild(cancel);
    let saving = false;
    save.onclick = () => { if (saving) return; const v = ta.value.trim(); if (!v) { ta.focus(); return; } saving = true; CDS().upsert(dim, { id: b.id, text: v }); sfx('click'); rerender('commander'); };
    cancel.onclick = () => rerender('commander');
  }

  // a "+ add" affordance per dimension: expands to a textarea so the Commander can teach the station directly.
  function cdAddRow(dim) {
    const row = el('div', 'cd-add');
    const btn = el('button', 'cd-addbtn'); btn.textContent = '+ add'; row.appendChild(btn);
    btn.onclick = () => {
      row.innerHTML = '';
      const ta = el('textarea', 'cd-edit'); ta.placeholder = 'Tell the station something about yourself…'; ta.spellcheck = false; row.appendChild(ta); ta.focus();
      const btns = el('div', 'consent-btns cd-acts'); row.appendChild(btns);
      const save = el('button', 'consent-btn'); save.textContent = 'Save'; btns.appendChild(save);
      const cancel = el('button', 'consent-btn'); cancel.textContent = 'Cancel'; btns.appendChild(cancel);
      let saving = false;
      save.onclick = () => { if (saving) return; const v = ta.value.trim(); if (!v) { ta.focus(); return; } saving = true; CDS().upsert(dim, { text: v, source: 'commander' }); sfx('click'); rerender('commander'); };
      cancel.onclick = () => rerender('commander');
    };
    return row;
  }

  // QUEST LOG (Slice 4 + G1a): the station's REAL progress dressed as quests — a read projection (QuestStore.view),
  // never a new source of truth — now joined with the durable quest memory (QuestStateStore): a dismissed quest
  // never re-renders (the anti-nag law), a freshly-completed row flashes a gold flourish, and get-to-know-you
  // quests carry a dismiss ✕ (milestones are achievements — no dismiss; the engine gates by kind). Honors the
  // honest-loot law: every quest pays out in real capability/work, and nothing here is gated behind a level.
  /* ============== TROPHY CASE (G3b) ==============
     The station-wide surface the TROPHY CASE prop opens: REAL earned achievements made permanent. Every trophy
     is a genuine completion (a completed quest / an earned milestone) projected by the pure Trophies engine over
     the live quest view + the durable QuestState memory. Dates are honest — a completion with no knowable date
     (a resumed pre-fix save) renders "date unknown", NEVER 1969 (the whole point of the G3b hydrate fix). An
     empty case shows honest dust, not placeholder trophies. The LIVING TOOLS shelf lists Commander-saved seeds
     with their real lifetime + 7-day run counts (the seed-reuse aggregate). No XP is minted anywhere here. */
  function buildTrophies(body) {
    // fold the live memory first so a just-completed quest is a trophy the instant this opens (buildQuests idiom).
    const QSS = (typeof QuestStateStore !== 'undefined') ? QuestStateStore : null;
    const SQS = (typeof StationQuestStore !== 'undefined') ? StationQuestStore : null;
    if (SQS && SQS.sync) { try { SQS.sync(); } catch (_) {} }
    if (QSS && QSS.sync) { try { QSS.sync(); } catch (_) {} }
    const v = (typeof QuestStore !== 'undefined' && QuestStore.view) ? QuestStore.view() : null;
    const quests = (v && Array.isArray(v.quests)) ? v.quests : [];
    const stateOf = (QSS && QSS.stateOf) ? (id => QSS.stateOf(id)) : (() => null);
    const tools = (typeof SeedReuseStore !== 'undefined' && SeedReuseStore.livingTools) ? SeedReuseStore.livingTools() : [];
    const surf = (typeof Trophies !== 'undefined' && Trophies.build)
      ? Trophies.build({ quests, stateOf, tools })
      : { trophies: [], tools: [], earned: 0, empty: true };

    const KIND = { milestone: 'MILESTONE', 'station-gap': 'CAPABILITY', station: 'STATION', dossier: 'DOSSIER', idea: 'WORK' };
    const fmtDate = at => { if (at == null) return 'date unknown'; try { return new Date(at).toLocaleDateString(); } catch (_) { return 'date unknown'; } };
    const troRow = t =>
      '<div class="gx-tro on">'
      + '<div style="display:flex;align-items:center;gap:6px;"><span class="gl">&#9733;</span><span class="nm">' + esc(t.title) + '</span>'
      + '<span class="gx-tag" style="margin-left:auto;">' + esc(KIND[t.kind] || 'HONOUR') + '</span></div>'
      + '<div class="sub">' + (t.reward ? '&#9656; ' + esc(t.reward) + ' &middot; ' : '')
      + '<span style="opacity:' + (t.dateKnown ? '1' : '.6') + ';">' + esc(fmtDate(t.completedAt)) + '</span></div></div>';

    const toolRow = tl =>
      '<div class="gx-tro on">'
      + '<div style="display:flex;align-items:center;gap:6px;"><span class="gl">&#9670;</span><span class="nm">' + esc(tl.name) + '</span>'
      + '<span class="gx-tag" style="margin-left:auto;">' + tl.runs + '&times; LIFETIME</span></div>'
      + '<div class="sub">the seed you saved &middot; ' + tl.sevenDay + '&times; in the last 7 days</div></div>';

    const trophiesHtml = surf.trophies.length
      ? '<div class="gx-tros">' + surf.trophies.map(troRow).join('') + '</div>'
      : '<div class="gx-tros"><p class="dim" style="font-style:italic;">the case stands empty &mdash; dust on the glass. ship real work and your first honour lands here.</p></div>';

    const toolsHtml = surf.tools.length
      ? '<div class="gx-sec" style="margin-top:14px;"><span class="gx-title">LIVING TOOLS</span> <span class="gx-tag">' + surf.tools.length + '</span></div>'
        + '<div class="gx-tros">' + surf.tools.map(toolRow).join('') + '</div>'
      : '';

    body.innerHTML = '<div class="gx">'
      + '<div class="dim" style="margin:2px 0 10px;">the station&rsquo;s real achievements, made permanent. every honour here is a completion that genuinely happened &mdash; never points, never invented. no dates are guessed.</div>'
      + '<div class="gx-sec"><span class="gx-title">HONOURS</span> <span class="gx-tag">' + surf.earned + ' EARNED</span></div>'
      + trophiesHtml
      + toolsHtml
      + '</div>';
  }

  function buildQuests(body) {
    const QSS = (typeof QuestStateStore !== 'undefined') ? QuestStateStore : null;
    const SQS = (typeof StationQuestStore !== 'undefined') ? StationQuestStore : null;
    const WQS = (typeof WorkQuestStore !== 'undefined') ? WorkQuestStore : null;
    const MQS = (typeof MaintQuestStore !== 'undefined') ? MaintQuestStore : null;
    if (SQS && SQS.sync) { try { SQS.sync(); } catch (_) {} }   // G1b: resolve station gaps before folding, so a just-closed gap renders done + celebrates
    if (WQS && WQS.sync) { try { WQS.sync(); } catch (_) {} }   // G1c: advance/complete work quests before the fold
    if (MQS && MQS.sync) { try { MQS.sync(); } catch (_) {} }   // G1c: mint/clear maintenance quests before the fold
    if (QSS && QSS.sync) { try { QSS.sync(); } catch (_) {} }   // never render a stale diff — the log always reflects the memory it just folded
    const v = (typeof QuestStore !== 'undefined' && QuestStore.view) ? QuestStore.view() : null;
    if (!v) { body.innerHTML = '<p class="dim">Quest log unavailable.</p>'; return; }
    const m = v.meter, all = Array.isArray(v.quests) ? v.quests : [];
    const qs = (QSS && QSS.visible) ? QSS.visible(all) : all;   // dismissed = gone forever (degrades to the raw list if the store is absent)
    const open = qs.filter(q => q.status !== 'done'), done = qs.filter(q => q.status === 'done');
    // a station-gap / work / maintenance quest is a fix-it or build SUGGESTION — always dismissible while open
    // (the sandbox law); each routes through its OWN store's denylist, not QuestState (whose dismiss is
    // dossier-only). Only the get-to-know-you (dossier) kind falls through to QuestState's dismissible check.
    const dismissibleQ = q => q && q.status !== 'done' && (
      (q.kind === 'station-gap') || (q.kind === 'work') || (q.kind === 'maintenance')
      || (QSS && QSS.dismissible && QSS.dismissible(q)));
    const tro = (q, i) => {
      const glow = QSS && QSS.isCelebrating && QSS.isCelebrating(q.id);
      const dis = dismissibleQ(q);
      return '<div class="gx-tro ' + (q.status === 'done' ? 'on' : 'off') + (glow ? ' q-celebrate' : '') + '" style="--ci:' + (i || 0) + '">'
        + '<div style="display:flex;align-items:center;gap:6px;"><span class="gl">' + (q.status === 'done' ? '&#9733;' : '&#9675;') + '</span><span class="nm">' + esc(q.title) + '</span>'
        + (dis ? '<button class="q-dismiss" data-qid="' + esc(q.id) + '" title="Dismiss — the station will never raise this again">&#10005;</button>' : '')
        + '</div>'
        + '<div class="sub">' + esc(q.status === 'done' ? ('▸ ' + q.reward) : q.desc) + '</div></div>';
    };
    const meterHtml = m
      ? '<div class="gx-sec"><span class="gx-title">STATION</span> <span class="gx-tag">Lv ' + m.level + ' &middot; ' + m.pct + '% to next &middot; ' + esc(String(m.confLabel) + ' ' + String(m.band)) + '</span></div>'
      : '';
    // G4 feature 2 — PROPOSALS: pending autojob proposals the agent pinned to the MISSION BOARD. A distinct
    // amber card with APPROVE (→ the real POST /api/cron) / DECLINE (→ dropped forever). Rendered above OPEN so
    // the "the agent wants to run this for you" ask reads first. Only shown when the ledger has cards.
    const AJS = (typeof AutoJobStore !== 'undefined' && AutoJobStore.pendingList) ? AutoJobStore : null;
    const proposals = AJS ? AJS.pendingList() : [];
    const propRow = p => '<div class="gx-tro off gx-proposal" style="border-left:2px solid var(--gold);">'
      + '<div style="display:flex;align-items:center;gap:6px;"><span class="gl" style="color:var(--gold);">&#9873;</span><span class="nm">' + esc(p.title) + '</span></div>'
      + '<div class="sub">' + esc(p.why || 'a standing job the agent proposes running for you on a schedule.') + '</div>'
      + '<div class="consent-btns" style="margin-top:5px;">'
      + '<button class="consent-btn q-prop-yes" data-pid="' + esc(p.id) + '">Approve</button>'
      + '<button class="consent-btn deny q-prop-no" data-pid="' + esc(p.id) + '">Decline</button>'
      + '</div></div>';
    const proposalsHtml = proposals.length
      ? '<div class="gx-sec"><span class="gx-title">PROPOSALS</span> <span class="gx-tag">' + proposals.length + '</span></div>'
        + '<div class="gx-tros">' + proposals.map(propRow).join('') + '</div>'
      : '';
    body.innerHTML = '<div class="gx gx-quests">'
      + meterHtml
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
      rerender('quests');
    }));
    body.querySelectorAll('.q-prop-no').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      if (!AJS || !AJS.declinePending) return;
      if (AJS.declinePending(b.dataset.pid)) { sfx('click'); rerender('quests'); }
    }));
    // dismissed = stop forever: the row vanishes now and never comes back (and the curiosity nudge for a
    // waved-off dimension stops with it — QuestStateStore.dismiss carries the one anti-nag law end to end).
    body.querySelectorAll('.q-dismiss').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      const q = qs.find(x => x && x.id === b.dataset.qid);
      if (!q) return;
      // each fix-it/build kind routes to its OWN permanent denylist; the dossier kind goes through QuestState.
      // Either way: dismissed = stop forever (the one anti-nag law).
      const took = (q.kind === 'station-gap') ? (SQS && SQS.dismiss && SQS.dismiss(q.id))
        : (q.kind === 'work') ? (WQS && WQS.dismiss && WQS.dismiss(q.id))
        : (q.kind === 'maintenance') ? (MQS && MQS.dismiss && MQS.dismiss(q.id))
        : (QSS && QSS.dismiss && QSS.dismiss(q));
      if (took) { sfx('click'); rerender('quests'); }
    }));
  }

  /* ============== lifecycle ============== */
  const BUILDERS = {
    agents:   ['AGENT DOSSIER',          buildAgents,    { w: '560px' }],
    commander:['COMMANDER DOSSIER',      buildCommander, { w: '560px' }],
    skills:   ['SKILLS & CAPABILITIES',  buildSkills,    { w: '680px', className: 'skills-term', fitViewport: true }],
    tasks:    ['TASK BOARD',             buildTasks,     { w: '760px' }],
    updates:  ['UPDATE CENTER',          buildUpdates,   { w: '540px' }],
    settings: ['SETTINGS',               buildSettings,  { w: '500px' }],
    messaging:['MESSAGING',              buildMessaging, { w: '520px' }],
    connectors:['CONNECTORS',            buildConnectors,{ w: '560px' }],
    routines: ['ROUTINES',               buildRoutines,  { w: '600px' }],
    rewind:   ['RESTORE POINTS',         buildRewind,    { w: '520px' }],
    logbook:  ['LOGBOOK',                buildLogbook,   { w: '600px' }],
    notifs:   ['NOTIFICATIONS',          buildNotifs,    { w: '460px' }],
    // the FIELD MANUAL codex is owned by tutorial.js (P3); this term just hosts its builder
    manual:   ['FIELD MANUAL',           body => { if (typeof Tutorial !== 'undefined' && Tutorial.fillFieldManual) Tutorial.fillFieldManual(body); }, { w: '640px' }],
    quests:   ['QUEST LOG',              buildQuests,    { w: '560px' }],
    trophies: ['TROPHY CASE',            buildTrophies,  { w: '560px' }]   // G3b: the TROPHY CASE prop opens this station-wide surface
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
  function openTerm(key) {
    const def = BUILDERS[key]; if (!def) return;
    if (open[key]) { if (minimized[key]) restoreTerm(key); return; }   // minimized → restore, not duplicate
    toggleTerm(key, def[0], def[1], def[2]);
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
    runningAgents.clear();   // fresh station view — never inherit stale run-state across a (re)connect
    sel = 0;
    importLegacyTasks();
    crewRender();
    wireCompactBeat();
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
    runningAgents.clear();   // a disconnect abandons in-flight streams (their run.end won't arrive) — reset
  }

  /* the phosphor theme picked on the COMMISSION CONSOLE writes through HERE so it survives enterGame:
     StationUI captures `store` once at module-load, so a bare localStorage write would be clobbered by the
     stale in-memory copy when applySettings() runs on enter. Routing through the live store + save() keeps
     the create-screen pick and the in-game Settings panel as one source of truth. */
  function setTheme(t) {
    const ok = THEMES.some(([name]) => name === t); if (!ok) return;
    store.settings.theme = t; applySettings(); save();
  }
  function getTheme() { return store.settings.theme; }

  return { init, enter, setRoster, leave, clearRunning, runningCount: () => runningAgents.size, isAgentRunning: (id) => runningAgents.has(id), notify, flashSave, openAgent, openArcade, toggleTerm, openTerm, rerender, refreshBoard: () => rerender('tasks'), setTheme, getTheme };
})();
