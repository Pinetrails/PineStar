/* STARNET — stationui.js : the station-management HUD.
   Ports the v7 pip-boy chrome (floating terminal windows, crew manifest,
   bottom-bar panels) but wires every readout to REAL harness data — the
   present agent, real lifetime spend/tokens from Harness, the real tool
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
  const THEMES = [['amber', '#ffaa33'], ['green', '#3dff70'], ['blue', '#46c8ff'], ['white', '#e8f0e8']];

  let present = [];          // agent objects currently on the station
  const runningAgents = new Map();   // agentId -> live-run COUNT (concurrent streams can share an agentId, e.g. 'agent')
  let crewLiveWired = false;         // the crew-status live listener is registered exactly once
  let lastStageSummary = '';         // #8: last screen-reader summary text, so we only update the live region on change
  let access = {};           // { totals(), activity() } injected by app.js
  let sel = 0;               // selected agent index (dossier / crew)
  let routineAgentId = 'agent'; // selected roster agent for new scheduled routines
  let tickTimer = 0;
  const open = {};           // key -> open terminal-window element
  let started = false;

  /* ---------- persistence (user-owned UI state) ---------- */
  function defaults() { return { theme: 'amber', scanlines: true, flicker: true, sound: true, music: true }; }
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
    document.body.classList.remove('theme-amber', 'theme-green', 'theme-blue', 'theme-white');
    document.body.classList.add('theme-' + s.theme);
    document.body.classList.toggle('no-scan', !s.scanlines);
    document.body.classList.toggle('no-flicker', !s.flicker);
    if (typeof SFX === 'object') SFX.on = !!s.sound;
    if (typeof MUSIC === 'object') MUSIC.on = (s.music !== false);   // default-on adaptive score; arms on first gesture
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
      if (k) termPos[k] = { left: w.offsetLeft, top: w.offsetTop };
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

  /* focus scrim: one dim layer mounted under the lowest open window so an
     open dossier/settings panel owns the eye. Purely visual (pointer-events
     none); torn down once the last window closes. */
  function syncScrim() {
    const host = $('#terms'); if (!host) return;
    let s = document.getElementById('term-scrim');
    const any = Object.keys(open).length > 0;
    if (any && !s) { s = el('div', 'term-scrim'); s.id = 'term-scrim'; host.insertBefore(s, host.firstChild); }
    else if (!any && s) { s.remove(); }
  }
  function closeTerm(key) {
    if (open[key]) {
      const w = open[key];
      if (w._onClose) { try { w._onClose(); } catch (_) {} }   // e.g. tear down the live arcade canvas
      const opener = w._opener;   // a11y: the control that opened this window, to restore focus to
      w.remove(); delete open[key]; sfx('close');
      // restore keyboard focus to the opener (or its dock trigger) so Tab order isn't lost on close.
      try { if (opener && opener.isConnected && opener.focus) opener.focus(); } catch (_) {}
    }
    syncBB(); syncScrim();
  }
  function toggleTerm(key, title, builder, opts) {
    if (open[key]) { closeTerm(key); return; }
    // Mode-exclusivity: a dock panel and full-screen REFIT must never be mounted at once.
    // Opening a panel exits refit first so two features can't stack (see COHERENCE_MATRIX dim T).
    if (typeof Build !== 'undefined' && Build.isOpen && Build.isOpen()) { try { Build.close(); } catch (_) {} }
    sfx('open');
    // a11y: remember who opened this so focus can return there on close (the dock item / trigger).
    const opener = (typeof document !== 'undefined' && document.activeElement) || null;
    const w = el('div', 'term');
    w.style.zIndex = U.zTop();
    if (opts && opts.w) w.style.width = opts.w;
    w._onClose = opts && opts.onClose;
    w._opener = opener;
    // a11y: a floating window is a real modal dialog — label it by its title, make it focusable.
    const titleId = 'term-title-' + (++termTitleSeq);
    w.setAttribute('role', 'dialog');
    w.setAttribute('aria-modal', 'true');
    w.setAttribute('aria-labelledby', titleId);
    w.tabIndex = -1;
    const head = el('div', 'term-head', '<span class="term-title" id="' + titleId + '">▮ ' + title + '</span>');
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
    }
    $('#terms').appendChild(w);
    open[key] = w;
    placeTerm(w, key);   // land in a cascaded slot (or its remembered spot) — never dead-center pile-up
    w.addEventListener('mousedown', () => { w.style.zIndex = U.zTop(); });
    head.addEventListener('mousedown', ev => {
      if (ev.target === x) return;
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
      // cache size once at grab (it can't change mid-drag) so the move handler never forces a layout read.
      termDrag = { w, dx: ev.clientX - r.left, dy: ev.clientY - r.top, ww: r.width, wh: r.height };
      ev.preventDefault();
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
    w._render = () => builder(body);
    w._render();
    // a11y: move focus into the freshly-opened dialog — the first control, or the window itself.
    const f0 = termFocusables(w);
    try { (f0[0] || w).focus(); } catch (_) {}
    syncBB(); syncScrim();
  }
  function rerender(key) { if (open[key]) open[key]._render(); }
  function syncBB() {
    document.querySelectorAll('.bb[data-term]').forEach(b => b.classList.toggle('active', !!open[b.dataset.term]));
  }

  /* ============== CREW MANIFEST (left panel) ============== */
  function crewRender() {
    wireCrewLive();   // ensure the per-agent run-state listener is live
    const ul = $('#crew'); if (!ul) return;
    if (!present.length) {
      ul.innerHTML = '<li class="crew-empty">No agents on station.</li>';
      $('#crew-n').textContent = '';
      $('#crew-sum').innerHTML = '';
      return;
    }
    ul.innerHTML = present.map((a, i) =>
      '<li class="crew-row" data-i="' + i + '">' +
      '<span class="dot on"></span>' +
      '<div class="crew-main">' +
      '<div class="crew-name" style="color:' + a.color + '">' + esc(a.name) +
      '<span class="crew-room">HAB-01' + (a.stats && a.stats.level ? ' · Lv ' + a.stats.level : '') + '</span></div>' +
      '<div class="crew-status" id="cs-' + a.id + '">…</div>' +
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
     Two sub-tabs. BRIEF is live telemetry (real lifetime spend). CONFIG is the agent's actual
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

  function agHead(a, act, price) {
    const dotCls = act === 'task' ? 'working' : act === 'talk' ? 'thinking' : 'on';
    const statusText = act === 'task' ? 'WORKING' : act === 'talk' ? 'THINKING' : 'ONLINE';
    const lv = (typeof Xp !== 'undefined' && a.stats) ? Xp.compute(a.stats).level : null;   // always-visible level chip
    return '<div class="ag-hero">' +
      '<div class="ag-portrait-wrap"><canvas id="ag-portrait" width="52" height="68"></canvas></div>' +
      '<div class="ag-info">' +
      '<div class="ag-name" style="color:' + a.color + '">' + esc(a.name) + (lv ? '<span class="ag-lv">Lv ' + lv + '</span>' : '') + '</div>' +
      '<div class="ag-role-line"><span class="ag-sdot ' + dotCls + '"></span>' + statusText + ' · HAB-01</div>' +
      '<div class="ag-tags">' +
      // the agent's deployed SPECIALTY (set by the Recruitment Bay) — its primary "what it's FOR" identity, shown first.
      ((typeof Specialties !== 'undefined' && a.specialtyId) ? (function () { var s = Specialties.get(a.specialtyId); return s ? '<span class="tag">' + esc(s.emoji + ' ' + s.name) + '</span>' : ''; })() : '') +
      '<span class="tag model">' + esc(a.model || '—') + '</span>' +
      (price ? '<span class="tag dim">$' + price.in.toFixed(2) + '/$' + price.out.toFixed(2) + '/1M</span>' : '') +
      '</div></div></div>';
  }

  function agBrief(a) {
    const t = totals();
    const since = a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '—';
    const fmtTok = n => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); };
    // BRIEF is operational telemetry; the full Level/XP/Confidence/milestone readout lives in the GROWTH tab.
    return '<div class="stat-grid">' +
      '<div class="stat-cell"><div class="stat-val">' + (t.calls || 0) + '</div><div class="stat-lbl">RUNS</div></div>' +
      '<div class="stat-cell"><div class="stat-val">' + fmtTok(t.tokens) + '</div><div class="stat-lbl">TOKENS</div></div>' +
      '<div class="stat-cell"><div class="stat-val pos">$' + Number(t.cost || 0).toFixed(4) + '</div><div class="stat-lbl">SPENT</div></div>' +
      '</div>' +
      '<div class="ag-mission"><div class="ag-mission-lbl">PURPOSE</div>' +
      (a.purpose
        ? '<div class="ag-mission-text">' + esc(a.purpose) + '</div>'
        : '<div class="ag-mission-cta">No purpose set — tell your agent what you need in COMMS, or write it in CONFIG › purpose.md.</div>') +
      '</div>' +
      '<div class="ag-foot-row">on station since <b>' + since + '</b> · all figures are real spend</div>';
  }

  // GROWTH tab — the premium agent-growth dossier: XP ladder, a physical confidence gauge (honest "—"
  // while calibrating), the milestone trophy case, and the station-prestige rollup. All read off the pure
  // Xp engine; the confidence marker rides the agent's own suit colour so it reads as "this unit's measure".
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
      '<div class="gx-well"><span class="gx-lbl">Tasks done</span><span class="v">' + g.tasksDone + '</span></div>' +
      '</div>';

    const confnum = g.known ? (g.confidence + '<span style="font-size:18px;color:var(--ph-dim);">%</span>') : '—';
    const gauge = '<div class="gx-gauge"><div class="gx-zones"><i></i><i></i><i></i><i></i></div>' +
      (g.known ? '<div class="gx-mark" style="left:' + g.confidence + '%;background:' + mark + ';"></div>' +
                 '<div class="gx-marknum" style="left:' + g.confidence + '%;">' + g.confidence + '</div>' : '') +
      '</div>';
    const confidence =
      '<div>' +
      '<div class="gx-sec"><span class="gx-ref">B</span><span class="gx-title">Confidence</span><span class="gx-tag">EWMA &middot; n' + (g.known ? '&ge;' + Xp.MIN_SAMPLES : '=' + g.samples) + '</span></div>' +
      '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:9px;">' +
        '<span class="gx-confnum' + (g.known ? '' : ' cal') + '">' + confnum + '</span>' +
        '<span class="gx-band' + (g.known ? '' : ' cal') + '">' + (g.known ? g.band.toUpperCase() : 'CALIBRATING') + '</span></div>' +
      gauge +
      '<div class="gx-zlabels"><span>BUILD</span><span>STEADY</span><span>RELIABLE</span><span class="hot">TRUST</span></div>' +
      '<div class="gx-well' + (g.bonus ? ' gold' : '') + '"><span class="gx-lbl">XP trust bonus</span><span class="v">' + (g.bonus ? '+' + g.bonus + '%' : '—') + '</span></div>' +
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
            '<span class="gx-mono" style="font-size:10px;color:var(--ph-dim);">' + s.tasksDone + ' TASKS &middot; <span style="color:var(--ph);">' + (s.known ? s.band.toUpperCase() : 'CALIBRATING') + '</span></span></div>' +
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
      skills.map(s => '<div class="perk ' + (s.on ? 'on' : '') + '">' +
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
      '<div id="mc-list" class="mc-list"><span class="dim">reading memory core&hellip;</span></div>' +
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
  }

  function renderMemoryList(host, records, a) {
    host.innerHTML = '';
    if (!records.length) {
      const p = el('div', 'mc-empty');
      p.textContent = a.name + ' has no stored memories yet. As it works and you Keep what it learns, durable '
        + 'beliefs collect here — each typed, scored, and traceable to the run that earned it.';
      host.appendChild(p); return;
    }
    // pinned first, then most-trusted, then most-recent — the order recall itself favours
    const sorted = records.slice().sort((x, y) =>
      (!!y.pinned - !!x.pinned) || ((y.trust || 0) - (x.trust || 0)) || ((y.createdAt || 0) - (x.createdAt || 0)));
    for (const rec of sorted) host.appendChild(memCard(rec, a));
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
    const price = (typeof Harness === 'object' && Harness.priceOf) ? Harness.priceOf(a.model) : null;
    const tabContent = agTab === 'config' ? agConfig(a) : agTab === 'skills' ? agSkills(a && a.id) : agTab === 'growth' ? agGrowth(a) : agTab === 'memory' ? agMemory(a) : agBrief(a);
    body.innerHTML =
      '<div class="ag-wrap"><div class="ag-list">' +
      present.map((x, i) => '<div class="ag-item ' + (i === sel ? 'sel' : '') + '" data-i="' + i + '">' +
        '<span style="color:' + x.color + '">●</span> ' + esc(x.name) + '</div>').join('') +
      '</div><div class="ag-detail">' +
      agHead(a, act, price) +
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
    const pctx = cv.getContext('2d'); pctx.imageSmoothingEnabled = false;
    pctx.clearRect(0, 0, cv.width, cv.height);
    if (typeof SPRITES === 'object' && SPRITES.ready) {
      SPRITES.drawBody(pctx, { id: a.id, px: cv.width / 2, py: cv.height - 4, dir: 'south', color: a.color, state: 'idle', sitting: false, working: false, phase: 0 }, performance.now());
    } else {
      pctx.fillStyle = a.color; pctx.fillRect(cv.width / 2 - 5, 20, 10, 30);
      pctx.fillStyle = '#f0e6c0'; pctx.fillRect(cv.width / 2 - 4, 10, 8, 9);
    }
  }
  function openAgent(i) { sel = i; if (open.agents) rerender('agents'); else toggleTerm('agents', 'AGENT DOSSIER', buildAgents, { w: '600px', feature: true }); }

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
      '<h4 class="ms-h">CAPABILITIES — ' + on + ' LIVE</h4>' +
      '<div class="perk-grid">' +
      skills.map(s => '<div class="perk ' + (s.on ? 'on' : '') + '">' +
        '<div class="perk-icon">' + s.icon + '</div>' +
        '<div class="perk-name">' + s.name + '</div>' +
        '<div class="perk-desc">' + s.tools + '</div>' +
        '<div class="perk-stat' + (s.consent ? ' ask' : '') + '">' +
        (s.on ? (s.consent ? '● ASKS OK' : '● ENABLED') : '○ LOCKED') + '</div></div>').join('') +
      '</div>' +
      '<p class="sk-note">Capabilities follow the <b>objects at the workstation</b> — the room layout IS the ' +
      'permission system. <b>File writes</b> and <b>commands</b> pause for one-click approval in COMMS; the private ' +
      '<b>notebook</b> saves freely.</p>' +
      '<h4 class="ms-h">SKILL LIBRARY</h4>' +
      '<p class="sk-note sk-lib-intro">Pre-installed <b>recipes</b> your agents follow when a task matches. Each one ' +
      'rides on the capabilities above — it stays <b>locked</b> until ' + esc((a && a.name) || 'the agent') + ' has the ' +
      'objects it needs. Enabling is station-wide; what actually runs is still gated by the floor.</p>' +
      '<div id="sk-lib" class="sk-lib"><div class="sk-loading">Loading the skill library…</div></div>';
    loadSkillLibrary(agentId);
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
      .then(d => { const h = $('#sk-lib'); if (h) renderSkillLibrary(h, (d && d.skills) || [], agentId, placed); })
      .catch(() => { const h = $('#sk-lib'); if (h) h.innerHTML = '<div class="sk-loading">Could not load the skill library — is the sidecar running?</div>'; });
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
      html += '<div class="sk-cat">' + esc(cat) + '</div>';
      for (const s of byCat[cat]) {
        const missing = (s.requires || []).filter(r => !placedSet[r]);
        const state = s.enabled ? (s.available ? 'on' : 'want') : 'off';
        const stat = s.enabled ? (s.available ? '● ACTIVE' : '● ON · needs ' + missing.map(objLabel).join(' + ')) : '○ OFF';
        const reqs = (s.requires || []).length
          ? s.requires.map(r => '<span class="sk-badge ' + (placedSet[r] ? 'have' : 'miss') + '">' + objLabel(r) + '</span>').join('')
          : '<span class="sk-badge free">no gear needed</span>';
        html +=
          '<div class="sk-card ' + state + '">' +
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
  // refreshBoard() here, so one call keeps the rail, the board and the cost chip in lockstep.
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
    w.switch(id);
    if (typeof Chat === 'object' && Chat.load) Chat.load(s);
    sync();
    const started = s.history.some(m => m.role === 'user');
    if (!started && s.title && typeof Chat === 'object' && Chat.send) Chat.send(s.title);
    notify('assigned to ' + (present[0] ? present[0].name : 'agent') + ': ' + (s.title || 'workstream'), 'gold');
    sfx('notify');
  }

  function card(s) {
    const cost = (s.cost && s.cost.usd) ? '$' + s.cost.usd.toFixed(4) : '';
    const n = s.runIds.length, runs = n ? n + (n === 1 ? ' run' : ' runs') : '';
    const acts = s.lane === 'todo'
      ? '<button class="assign" data-act="assign">▶ ASSIGN</button><button data-act="open">↗ OPEN</button><button data-act="arch">⌫</button>'
      : s.lane === 'active'
        ? '<button data-act="ship">✓ SHIP</button><button data-act="open">↗ OPEN</button><button data-act="arch">⌫</button>'
        : '<button data-act="reopen">↺ REOPEN</button><button data-act="open">↗ OPEN</button><button data-act="arch">⌫</button>';
    return '<div class="kb-card" data-id="' + s.id + '">' +
      '<div class="kb-title">' + esc(s.title || 'untitled') + '</div>' +
      '<div class="kb-meta"><span>' + clock(s.lastActiveAt || s.createdAt) + '</span>' +
      (runs ? '<span>' + runs + '</span>' : '') + (cost ? '<span class="pos">' + cost + '</span>' : '') + '</div>' +
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
          (items.length ? items.map(card).join('') : '<div class="kb-empty-col">— empty —</div>') + '</div>';
      }).join('') +
      '</div>';
    const inp = body.querySelector('#kb-in');
    const submit = () => { addTask(inp.value); };
    body.querySelector('#kb-add').addEventListener('click', () => { sfx('click'); submit(); });
    inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
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
    { id: 'local',         name: 'LOCAL',             endpoint: '127.0.0.1 · Ollama/llama.cpp', blurb: 'run models on-device', live: false },
    { id: 'openai-compat', name: 'OPENAI-COMPATIBLE', endpoint: 'any /v1 base URL',          blurb: 'bring a custom endpoint', live: false }
  ];
  const H = () => (typeof Harness === 'object' && Harness) ? Harness : null;
  function provName(id) { const p = PROVIDERS.find(x => x.id === id); return p ? p.name : String(id || '').toUpperCase(); }
  function activeProv() { const h = H(); return (h && h.getProv && h.getProv()) || 'openrouter'; }
  // mask a secret to a provider-recognisable prefix + last 4 — the middle is NEVER emitted.
  function maskKey(k) {
    k = String(k || ''); if (!k) return '';
    const m = k.match(/^(sk-or-v1-|sk-or-|sk-proj-|sk-ant-|sk-)/i);
    const head = m ? m[1] : k.slice(0, 4);
    // only append a last-4 tail when it can't overlap the (non-secret) prefix we already show
    const tail = k.length > head.length + 4 ? k.slice(-4) : '';
    return head + '••••••••' + tail;
  }
  // the REAL connected keys, read from the BYOK store. Today that's a single OpenRouter key;
  // the shape is a LIST so extra providers slot in later without touching this view.
  // Codex authenticates by ChatGPT OAuth (no API key). The runnable signal is the persisted provider the runs
  // actually use — getProv()==='codex'. (QA-1: without this the panel reported "No API keys connected" while a
  // Codex session was live and running.)
  function codexConnected() { const h = H(); return !!(h && h.getProv && h.getProv() === 'codex'); }
  function connectedKeys() {
    const h = H(); if (!h) return [];
    const out = [];
    // Codex first when it's the live provider — an OAuth connection that carries a model but no API key.
    if (codexConnected()) out.push({ provider: 'codex', key: '', model: (h.getModel && h.getModel()) || '', oauth: true });
    // OpenRouter BYOK: desktop keeps the key in the OS keychain (getKey returns ''); configured() reports it's set.
    if (h.getKey) {
      const set = (h.configured && h.configured()) || !!h.getKey();
      if (set) out.push({ provider: 'openrouter', key: h.getKey(), model: (h.getModel && h.getModel()) || '' });
    }
    return out;
  }
  function keysFor(id) { return connectedKeys().filter(x => x.provider === id); }

  function providersHtml() {
    const active = activeProv();
    return PROVIDERS.map(p => {
      const ks = keysFor(p.id);
      const connected = p.live && ks.length > 0;
      // ACTIVE means this transport can actually run right now: selected provider AND a model is set.
      const runnable = connected && p.id === active && !!ks[0].model;
      const cls = connected ? 'conn' : (p.live ? 'avail' : 'soon');
      const stat = !p.live ? '○ COMING SOON' : connected ? '● CONNECTED' : (p.id === 'codex' ? '○ NOT SIGNED IN' : '○ NO KEY');
      const n = ks.length;
      return '<div class="prov-card ' + cls + '">' +
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
    if (!keys.length) {
      // reachable in-session via REMOVE — let the user reconnect right here, no CONNECT-screen round-trip.
      return '<div class="key-empty">' +
        '<p>No API keys connected. Paste a key here to reconnect — it stays on this machine.</p>' +
        '<div class="key-edit">' +
        '<input type="password" class="key-input" id="key-in-new" placeholder="paste OpenRouter key…" autocomplete="off" spellcheck="false">' +
        '<button class="bb sm" data-act="add">SAVE</button>' +
        '</div></div>';
    }
    return keys.map((k, i) => {
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
      return '<div class="key-row">' +
        '<span class="conn-dot"></span>' +
        '<div class="key-main">' +
        '<div class="key-top"><span class="key-prov">' + esc(provName(k.provider)) + '</span>' +
        '<code class="key-mask" title="shown masked — the full key is never displayed">' + esc(maskKey(k.key)) + '</code></div>' +
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
    }).join('');
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
          if (h.setKey) h.setKey(v);
          notify('connected ' + provName('openrouter') + ' API key', 'good');
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
          if (h.setKey) h.setKey(v);
          notify('updated ' + provName(row.provider) + ' API key', 'good');
          rerender('settings');
        } else if (act === 'rm') {
          if (b.dataset.armed) { if (h.setKey) h.setKey(''); notify('removed ' + provName(row.provider) + ' key — paste a new one here to reconnect', 'warn'); sfx('bad'); rerender('settings'); return; }
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
  function buildSettings(body) {
    const s = store.settings;
    body.innerHTML =
      '<h4 class="ms-h">PROVIDERS</h4>' +
      '<div class="prov-list">' + providersHtml() + '</div>' +
      '<h4 class="ms-h">API KEYS</h4>' +
      '<div class="key-list">' + keysHtml() + '</div>' +
      '<p class="set-about">Keys live locally on this machine and are sent only to the STARNET sidecar (127.0.0.1) per request — never anywhere else. They are shown masked; the full secret is never displayed. (The shipped desktop build moves keys behind the OS keychain.)</p>' +
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
    wireKeyActions(body);
    // switch theme in place — applySettings repaints via the body class; do NOT rerender (it would wipe an open key editor).
    body.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => {
      s.theme = b.dataset.t; applySettings(); save(); sfx('click');
      body.querySelectorAll('[data-t]').forEach(x => x.classList.toggle('sel', x === b));
    }));
    const bind = (id, key) => body.querySelector(id).addEventListener('change', ev => { s[key] = ev.target.checked; applySettings(); save(); });
    bind('#set-scan', 'scanlines'); bind('#set-flicker', 'flicker'); bind('#set-sound', 'sound'); bind('#set-music', 'music');
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
  function notify(text, cls) {
    store.notifs.push({ id: uid('n'), t: Date.now(), txt: String(text || ''), cls: cls || '', read: false });
    if (store.notifs.length > 60) store.notifs = store.notifs.slice(-60);
    save(); badges();
    if (open.notifs) rerender('notifs');
  }
  function buildUpdates(body) {
    if (typeof Updates !== 'undefined' && Updates.render) Updates.render(body);
    else body.innerHTML = '<div class="fb-empty">UPDATE CENTER UNAVAILABLE.<br><span>Restart the desktop app and try again.</span></div>';
  }
  function buildNotifs(body) {
    if (!store.notifs.length) {
      body.innerHTML = '<div class="fb-empty">NO NOTIFICATIONS YET.<br><span>Run results, saved deliverables and assigned tasks show up here.</span></div>';
      return;
    }
    body.innerHTML =
      '<button class="bb sm" id="nf-clear">MARK ALL READ</button>' +
      '<div class="nf-list">' + store.notifs.slice().reverse().map(n =>
        '<div class="nf ' + n.cls + (n.read ? ' read' : '') + '">' + ts(n.t) + ' ' + esc(n.txt) + '</div>').join('') + '</div>';
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
    if (typeof Harness === 'undefined' || !Harness.contextState || typeof CtxGauge === 'undefined') return;
    const cs = Harness.contextState();
    const s = CtxGauge.compute(cs.used, cs.limit);
    g.dataset.level = s.level;
    const fill = g.querySelector('.ctx-fill'); if (fill) fill.style.width = (s.known ? s.pct : 0) + '%';
    const num = g.querySelector('.ctx-num'); if (num) num.textContent = s.pctLabel;
    const cap = g.querySelector('.ctx-cap'); if (cap) cap.textContent = s.label;
    g.title = 'CONTEXT — ' + (s.known ? s.label + '  ·  ' + s.pctLabel + ' of the model’s max context'
                                       : 'calibrating (the model’s max context length is still unknown)');
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
      '<div id="tg-msg" class="msg"></div>';

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
      const key = (typeof Harness !== 'undefined' && Harness.getKey()) || '';
      const hasStoredKey = !!(typeof Harness !== 'undefined' && Harness.configured && Harness.configured());
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
        const r = await fetch('/api/channels/telegram/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, key, model, provider, agentId, system, agentName }) });
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
    refresh();
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
        '<span class="dim">(Remote http(s) servers; bearer token optional. The token is stored locally by the sidecar and never displayed.)</span></p>' +
      '<div id="mc-list" class="mc-list">loading…</div>' +
      '<h4 class="ms-h">ADD A CONNECTOR</h4>' +
      '<div class="mc-form">' +
        '<input id="mc-id" class="key-input" placeholder="id — e.g. github (a-z 0-9 _ -)" autocomplete="off" spellcheck="false" maxlength="40">' +
        '<input id="mc-label" class="key-input" placeholder="label (optional)" autocomplete="off" spellcheck="false">' +
        '<input id="mc-url" class="key-input" placeholder="https://server.example/mcp" autocomplete="off" spellcheck="false">' +
        '<input id="mc-token" type="password" class="key-input" placeholder="bearer token (optional)" autocomplete="off" spellcheck="false">' +
        '<button class="bb sm" id="mc-add">+ ADD &amp; CONNECT</button>' +
      '</div>' +
      '<div id="mc-msg" class="msg"></div>';

    const listEl = body.querySelector('#mc-list');
    const msgEl = body.querySelector('#mc-msg');

    function badge(state) {
      return ({ up: ['var(--ok)', '● connected'], connecting: ['var(--gold)', '◌ connecting…'],
                down: ['var(--ph-dim)', '○ disabled'], error: ['var(--bad)', '✕ error'] })[state] || ['var(--ph-dim)', '○ ' + esc(state || 'unknown')];
    }
    function row(c) {
      const b = badge(c.state);
      const tools = (c.tools && c.tools.length) ? '<div class="mc-tools">' + c.tools.map(t => '<code>' + esc(t) + '</code>').join('') + '</div>' : '';
      const detail = (c.state === 'error' && c.detail) ? '<div class="mc-detail">' + esc(c.detail) + '</div>' : '';
      return '<div class="mc-row" data-id="' + esc(c.id) + '" data-url="' + esc(c.url) + '" data-enabled="' + (c.enabled ? '1' : '0') + '">' +
        '<div class="mc-top"><b>' + esc(c.label || c.id) + '</b> <span class="dim">' + esc(c.id) + '</span>' +
          '<span class="mc-state" style="color:' + b[0] + '">' + b[1] + (c.toolCount ? ' · ' + c.toolCount + ' tool' + (c.toolCount === 1 ? '' : 's') : '') + '</span></div>' +
        '<div class="mc-url dim">' + esc(c.url) + (c.hasToken ? ' · token saved' : '') + '</div>' + detail + tools +
        '<div class="mc-acts">' +
          '<button class="bb xs" data-act="refresh">↻ REFRESH</button>' +
          '<button class="bb xs" data-act="toggle">' + (c.enabled ? '⏸ DISABLE' : '▶ ENABLE') + '</button>' +
          '<button class="bb xs danger" data-act="remove">✕ REMOVE</button>' +
        '</div></div>';
    }
    async function refresh() {
      try {
        const j = await (await fetch('/api/connectors')).json();
        const list = (j && j.connectors) || [];
        listEl.innerHTML = list.length ? list.map(row).join('')
          : '<div class="fb-empty">NO CONNECTORS YET.<br><span>Add an MCP server below to give your agents new tools.</span></div>';
      } catch (_) { listEl.innerHTML = '<div class="mc-detail">sidecar offline — start it to manage connectors.</div>'; }
    }
    listEl.addEventListener('click', async ev => {
      const btn = ev.target.closest('button[data-act]'); if (!btn) return;
      const rowEl = ev.target.closest('.mc-row'); const id = rowEl && rowEl.dataset.id; if (!id) return;
      const post = (path, payload) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      btn.disabled = true;
      try {
        if (btn.dataset.act === 'remove') { await post('/api/connectors/remove', { id }); notify('Connector "' + id + '" removed'); sfx('click'); }
        else if (btn.dataset.act === 'refresh') {
          msgEl.textContent = 'refreshing ' + id + '…';
          const j = await (await post('/api/connectors/refresh', { id })).json().catch(() => ({}));
          msgEl.textContent = (j.status && j.status.state === 'up') ? ('✓ ' + id + ' — ' + (j.status.toolCount || 0) + ' tool(s)') : ('✕ ' + id + ' — ' + ((j.status && j.status.detail) || j.error || 'not connected'));
          sfx('click');
        } else if (btn.dataset.act === 'toggle') {
          await post('/api/connectors', { id, url: rowEl.dataset.url, enabled: rowEl.dataset.enabled !== '1' }); sfx('click');
        }
      } catch (e) { msgEl.textContent = '✕ ' + ((e && e.message) || 'request failed'); sfx('bad'); }
      refresh();
    });
    body.querySelector('#mc-add').addEventListener('click', async () => {
      const id = (body.querySelector('#mc-id').value || '').trim();
      const url = (body.querySelector('#mc-url').value || '').trim();
      const label = (body.querySelector('#mc-label').value || '').trim();
      const token = (body.querySelector('#mc-token').value || '').trim();
      if (!id || !url) { sfx('bad'); msgEl.textContent = 'an id and a server URL are required'; return; }
      msgEl.textContent = 'connecting ' + id + '…';
      try {
        const j = await (await fetch('/api/connectors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, url, label, token }) })).json().catch(() => ({}));
        if (j.error) { msgEl.textContent = '✕ ' + j.error; sfx('bad'); }
        else if (j.status && j.status.state === 'up') {
          msgEl.textContent = '✓ connected — ' + (j.status.toolCount || 0) + ' tool(s) available'; sfx('click'); notify('Connector "' + id + '" connected', 'good');
          ['#mc-id', '#mc-label', '#mc-url', '#mc-token'].forEach(s => { body.querySelector(s).value = ''; });
        } else { msgEl.textContent = '✕ ' + ((j.status && j.status.detail) || ('state: ' + (j.state || 'error'))); sfx('bad'); }
      } catch (e) { msgEl.textContent = '✕ ' + ((e && e.message) || 'failed to reach the sidecar'); sfx('bad'); }
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
      '<h4 class="ms-h">SCHEDULED ROUTINES</h4>' +
      '<p class="set-about">A routine wakes on a schedule and runs your agent <b>unattended</b>, using your connected key + model. ' +
        'With no one watching, ungranted file writes are denied silently unless you have pre-approved them. ' +
        '<span class="dim">(Schedules: "every 30m", "every 1h", "in 2h", "0 9 * * *", or an ISO timestamp like 2026-07-01T09:00.)</span></p>' +
      '<div id="rt-gate" class="set-about"></div>' +
      '<div id="rt-list" class="mc-list">loading…</div>' +
      '<h4 class="ms-h">ADD A ROUTINE</h4>' +
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
        listEl.innerHTML = jobs.length ? jobs.map(row).join('')
          : '<div class="fb-empty">NO ROUTINES YET.<br><span>Add one below to put your agent to work on a schedule.</span></div>';
      } catch (_) { listEl.innerHTML = '<div class="mc-detail">sidecar offline — start it to manage routines.</div>'; }
    }

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
      '<div id="rw-list" class="mc-list">loading…</div>' +
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
     logbook (GET /api/runs — every finished run's outcome/cost/reason), and SLAG renders World.slagLog() — the
     wasted-spend post-mortems (cause + fix) that used to live only as a fading toast. (WIRING_AUDIT P7.) */
  const LB_REASON = { done: '✓ done', max_iters: '⟳ looped out', budget: '$ over budget', cancelled: '⏹ cancelled', error: '✕ error', refusal: '⊘ refused' };
  function buildLogbook(body) {
    const agentId = (present[sel] && present[sel].id) || 'agent';
    body.innerHTML =
      '<h4 class="ms-h">LOGBOOK — ' + esc(agentId) + '</h4>' +
      '<div class="set-save"><button class="bb sm lb-tab active" data-tab="runs">▦ RUNS</button> ' +
      '<button class="bb sm lb-tab" data-tab="slag">⚠ SLAG</button> ' +
      '<button class="bb sm lb-tab" data-tab="insights">📊 INSIGHTS</button></div>' +
      '<p class="set-about" id="lb-about"></p>' +
      '<div id="lb-list" class="mc-list">loading…</div>';
    const listEl = body.querySelector('#lb-list'), aboutEl = body.querySelector('#lb-about');
    let tab = 'runs';
    function runRow(r) {
      const when = r.ts ? esc(fmtRel(new Date(r.ts).toISOString())) : '';
      const rl = LB_REASON[r.reason] || esc(r.reason || 'done');
      const title = r.title ? esc(r.title) : esc(String(r.runId || 'run').slice(0, 12));
      // H3.2: a run with a streamId can OPEN its transcript inline (the join the audit found was missing).
      const sid = r.streamId ? esc(String(r.streamId)) : '';
      const cls = sid ? 'mc-row lb-run-open' : 'mc-row';
      const attr = sid ? ' data-stream="' + sid + '" title="click to open this run\'s transcript"' : '';
      return '<div class="' + cls + '"' + attr + '><div class="mc-top"><b>' + title + '</b> <span class="dim">' + when + (sid ? ' · ▸ transcript' : '') + '</span></div>' +
        '<div class="mc-url dim">' + rl + ' · $' + (Number(r.usd) || 0).toFixed(4) + ' · ' + (r.turns || 0) + ' turn' + (r.turns === 1 ? '' : 's') + (r.tokens ? (' · ' + r.tokens + ' tok') : '') + '</div>' +
        (sid ? '<div class="lb-tx" hidden></div>' : '') + '</div>';
    }
    function insightsHtml(j) {
      j = j || {};
      if (!j.totalRuns) return '<div class="fb-empty">NO DATA YET.<br><span>Insights appear once this agent finishes some runs.</span></div>';
      const ov = '<div class="mc-row"><div class="mc-top"><b>' + j.totalRuns + ' run' + (j.totalRuns === 1 ? '' : 's') + ' · $' + (Number(j.totalUsd) || 0).toFixed(4) + '</b></div>' +
        '<div class="mc-url dim">avg $' + (Number(j.avgUsdPerRun) || 0).toFixed(4) + '/run · ' + (j.successPct == null ? '—' : j.successPct + '% success') + ' · ' + (j.totalTokens || 0) + ' tok</div></div>';
      const models = (j.byModel || []).slice(0, 8).map(m =>
        '<div class="mc-row"><div class="mc-top"><b>' + esc(m.model) + '</b> <span class="dim">' + m.runs + ' run' + (m.runs === 1 ? '' : 's') + '</span></div>' +
        '<div class="mc-url dim">$' + (Number(m.usd) || 0).toFixed(4) + ' · ' + (m.tokens || 0) + ' tok</div></div>').join('');
      const reasons = Object.keys(j.byReason || {}).map(k => esc(k) + ' ' + j.byReason[k]).join(' · ');
      return ov + '<div class="mc-detail" style="margin:6px 0 2px;opacity:.7">BY MODEL</div>' + (models || '<div class="mc-detail dim">—</div>') +
        '<div class="mc-detail" style="margin:6px 0 2px;opacity:.7">OUTCOMES</div><div class="mc-detail dim">' + (reasons || '—') + '</div>';
    }
    function slagRow(d) {
      return '<div class="mc-row"><div class="mc-top"><b style="color:var(--bad)">⚠ ' + esc(d.title || 'wasted spend') + '</b></div>' +
        '<div class="mc-url dim">' + esc(d.cause || '') + '</div>' +
        (d.fix ? '<div class="mc-detail">→ ' + esc(d.fix) + '</div>' : '') + '</div>';
    }
    async function refresh() {
      if (tab === 'runs') {
        aboutEl.innerHTML = 'Every finished run, newest first — what it produced, what it cost, and why it ended. The durable record behind the spend.';
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
            tx.innerHTML = '<div class="mc-detail">loading transcript…</div>';
            try {
              const t = await (await fetch('/api/transcript?stream=' + encodeURIComponent(row.dataset.stream) + '&agent=' + encodeURIComponent(agentId) + '&limit=50')).json();
              const turns = (t && t.turns) || [];
              tx.innerHTML = turns.length ? turns.map(m => '<div class="mc-detail"><b>' + esc(m.role) + ':</b> ' + esc(String(m.content || '').slice(0, 400)) + '</div>').join('') : '<div class="mc-detail">no transcript recorded for this workstream.</div>';
              tx.dataset.loaded = '1';
            } catch (_) { tx.innerHTML = '<div class="mc-detail">could not load transcript.</div>'; }
          }));
        } catch (_) { listEl.innerHTML = '<div class="mc-detail">sidecar offline — start it to see run history.</div>'; }
      } else if (tab === 'slag') {
        aboutEl.innerHTML = 'Wasted-spend post-mortems: every run that burned dollars without a deliverable, diagnosed into a real, fixable cause. Optimise these down.';
        let slag = [];
        try { if (typeof World !== 'undefined' && World.slagLog) slag = World.slagLog().slice().reverse(); } catch (_) {}
        listEl.innerHTML = slag.length ? slag.map(slagRow).join('') : '<div class="fb-empty">NO SLAG — clean line.<br><span>A post-mortem appears here when a run burns spend without producing a result.</span></div>';
      } else {
        // H3.3: aggregate usage — overview + per-model spend + outcomes, folded from the run history (GET /api/insights).
        aboutEl.innerHTML = 'How this agent spends: total runs and cost, average per run, success rate, and where the money goes by model.';
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
      if (!bs.length) { const e = el('div', 'cd-empty'); e.textContent = 'unknown — the station hasn’t learned this yet.'; sec.appendChild(e); }
      else for (const b of bs) sec.appendChild(cdCard(d.key, b));
      sec.appendChild(cdAddRow(d.key));
      body.appendChild(sec);
    }
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

  /* ============== lifecycle ============== */
  const BUILDERS = {
    agents:   ['AGENT DOSSIER',          buildAgents,    { w: '560px' }],
    commander:['COMMANDER DOSSIER',      buildCommander, { w: '560px' }],
    skills:   ['SKILLS & CAPABILITIES',  buildSkills,    { w: '680px' }],
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
    manual:   ['FIELD MANUAL',           body => { if (typeof Tutorial !== 'undefined' && Tutorial.fillFieldManual) Tutorial.fillFieldManual(body); }, { w: '640px' }]
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
    if (open[key]) return;
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
