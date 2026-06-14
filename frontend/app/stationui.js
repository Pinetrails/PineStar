/* SKYNET — stationui.js : the station-management HUD.
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

  const KEY = 'skynet.station.v1';
  const THEMES = [['amber', '#ffaa33'], ['green', '#3dff70'], ['blue', '#46c8ff'], ['white', '#e8f0e8']];

  let present = [];          // agent objects currently on the station
  let access = {};           // { totals(), activity() } injected by app.js
  let sel = 0;               // selected agent index (dossier / crew)
  let tickTimer = 0;
  const open = {};           // key -> open terminal-window element
  let started = false;

  /* ---------- persistence (user-owned UI state) ---------- */
  function defaults() { return { theme: 'amber', scanlines: true, flicker: true, sound: true }; }
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
  window.addEventListener('mousemove', ev => {
    if (termDrag) {
      termDrag.w.style.left = (ev.clientX - termDrag.dx) + 'px';
      termDrag.w.style.top = (ev.clientY - termDrag.dy) + 'px';
      termDrag.w.style.transform = 'none';
    }
  });
  window.addEventListener('mouseup', () => termDrag = null);

  function closeTerm(key) {
    if (open[key]) { open[key].remove(); delete open[key]; sfx('close'); }
    syncBB();
  }
  function toggleTerm(key, title, builder, opts) {
    if (open[key]) { closeTerm(key); return; }
    sfx('open');
    const w = el('div', 'term');
    w.style.zIndex = U.zTop();
    if (opts && opts.w) w.style.width = opts.w;
    const head = el('div', 'term-head', '<span class="term-title">▮ ' + title + '</span>');
    const x = el('button', 'term-x', '✕');
    x.addEventListener('click', () => closeTerm(key));
    head.appendChild(x);
    const body = el('div', 'term-body');
    w.appendChild(head); w.appendChild(body);
    $('#terms').appendChild(w);
    open[key] = w;
    w.addEventListener('mousedown', () => { w.style.zIndex = U.zTop(); });
    head.addEventListener('mousedown', ev => {
      if (ev.target === x) return;
      termDrag = { w, dx: ev.clientX - w.offsetLeft, dy: ev.clientY - w.offsetTop };
      ev.preventDefault();
    });
    w._render = () => builder(body);
    w._render();
    syncBB();
  }
  function rerender(key) { if (open[key]) open[key]._render(); }
  function syncBB() {
    document.querySelectorAll('.bb[data-term]').forEach(b => b.classList.toggle('active', !!open[b.dataset.term]));
  }

  /* ============== CREW MANIFEST (left panel) ============== */
  function crewRender() {
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
      '<span class="crew-room">HAB-01</span></div>' +
      '<div class="crew-status" id="cs-' + a.id + '">…</div>' +
      '</div></li>').join('');
    $('#crew-n').textContent = present.length + (present.length === 1 ? ' UNIT' : ' UNITS');
    ul.querySelectorAll('.crew-row').forEach(li =>
      li.addEventListener('click', () => { sfx('click'); openAgent(+li.dataset.i); }));
    crewTick();
  }
  function crewTick() {
    if (!present.length) return;
    const act = activity();
    present.forEach(a => { const e = $('#cs-' + a.id); if (e) e.textContent = crewStatus(act); });
    const working = act === 'task' ? present.length : 0;
    const sum = $('#crew-sum');
    if (sum) sum.innerHTML =
      '<span class="pos">▮ ' + working + ' WORKING</span>' +
      '<span class="dim">▯ ' + (present.length - working) + ' IDLE</span>';
  }

  /* ============== AGENTS — DOSSIER ============== */
  function buildAgents(body) {
    if (!present.length) { body.innerHTML = '<p class="dim">No agents on station.</p>'; return; }
    if (sel >= present.length) sel = 0;
    const a = present[sel];
    const t = totals();
    const act = activity();
    const price = (typeof Harness === 'object' && Harness.priceOf) ? Harness.priceOf(a.model) : null;
    const since = a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '—';
    body.innerHTML =
      '<div class="ag-wrap"><div class="ag-list">' +
      present.map((x, i) => '<div class="ag-item ' + (i === sel ? 'sel' : '') + '" data-i="' + i + '">' +
        '<span style="color:' + x.color + '">●</span> ' + esc(x.name) + '</div>').join('') +
      '</div><div class="ag-detail">' +
      '<div class="ag-head"><canvas id="ag-portrait" width="34" height="44"></canvas>' +
      '<div><div class="ag-name" style="color:' + a.color + '">' + esc(a.name) + '</div>' +
      '<div class="ag-role">▸ ' + crewStatus(act) + '</div>' +
      '<div class="ag-tags">' +
      '<span class="tag model">' + esc(a.model || '—') + '</span>' +
      '<span class="tag">HAB-01</span>' +
      (price ? '<span class="tag">$' + price.in.toFixed(2) + ' / $' + price.out.toFixed(2) + ' per 1M</span>' : '') +
      '</div></div></div>' +
      '<p class="ag-desc">' + (a.purpose
        ? '“' + esc(a.purpose) + '”'
        : '<span class="dim">No purpose set yet — tell your agent what it is for in COMMS.</span>') + '</p>' +
      '<div class="ag-task-block"><div class="ag-task-label">LIFETIME USAGE — REAL SPEND</div>' +
      '<div class="ag-stats">' +
      '<span>TOKENS <b>' + Number(t.tokens || 0).toLocaleString() + '</b></span>' +
      '<span>SPEND <b class="pos">$' + Number(t.cost || 0).toFixed(4) + '</b></span>' +
      '<span>CALLS <b>' + (t.calls || 0) + '</b></span>' +
      '</div></div>' +
      '<div class="ag-stats"><span>ON STATION SINCE <b>' + since + '</b></span></div>' +
      '<div class="ag-note">Every figure here is read straight from this agent\'s real model usage — nothing is simulated.</div>' +
      '</div></div>';
    body.querySelectorAll('.ag-item').forEach(it =>
      it.addEventListener('click', () => { sel = +it.dataset.i; sfx('click'); rerender('agents'); }));
    drawPortrait(body.querySelector('#ag-portrait'), a);
  }
  function drawPortrait(cv, a) {
    if (!cv) return;
    const pctx = cv.getContext('2d'); pctx.imageSmoothingEnabled = false;
    pctx.clearRect(0, 0, cv.width, cv.height);
    if (typeof SPRITES === 'object' && SPRITES.ready) {
      SPRITES.drawBody(pctx, { id: a.id, px: cv.width / 2, py: cv.height - 4, dir: 'south', color: a.color, state: 'idle', sitting: false, working: false, phase: 0 }, performance.now());
    } else {
      // procedural mini-avatar if the sprite sheet isn't ready
      pctx.fillStyle = a.color; pctx.fillRect(cv.width / 2 - 5, 14, 10, 22);
      pctx.fillStyle = '#f0e6c0'; pctx.fillRect(cv.width / 2 - 4, 6, 8, 8);
    }
  }
  function openAgent(i) { sel = i; if (open.agents) rerender('agents'); else toggleTerm('agents', 'AGENT DOSSIER', buildAgents, { w: '560px' }); }

  /* ============== SKILLS — capability readout (the real tool surface) ============== */
  // The agent's real tools, granted by the WORKSTATION object (object = capability).
  // Granted skills (.on) activate when you assign a task; locked ones are honestly
  // labelled as not-yet-available (shell / mutating HTTP are deferred in the harness).
  const SKILLS = [
    { icon: '🔎', name: 'WEB SEARCH', desc: 'search the live web', on: true },
    { icon: '📥', name: 'WEB FETCH', desc: 'read any web page', on: true },
    { icon: '📄', name: 'FILE READ', desc: 'read workspace files', on: true },
    { icon: '✏️', name: 'FILE WRITE', desc: 'write & edit files', on: true },
    { icon: '🗂️', name: 'FILE LIST', desc: 'browse the workspace', on: true },
    { icon: '🧠', name: 'NOTEBOOK', desc: 'persistent memory', on: true },
    { icon: '⌨️', name: 'SHELL', desc: 'run commands', on: false },
    { icon: '🌐', name: 'HTTP POST', desc: 'mutating requests', on: false }
  ];
  function buildSkills(body) {
    const on = SKILLS.filter(s => s.on).length;
    body.innerHTML =
      '<h4 class="ms-h">GRANTED — ' + on + ' ACTIVE</h4>' +
      '<div class="perk-grid">' +
      SKILLS.map(s => '<div class="perk ' + (s.on ? 'on' : '') + '">' +
        '<div class="perk-icon">' + s.icon + '</div>' +
        '<div class="perk-name">' + s.name + '</div>' +
        '<div class="perk-desc">' + s.desc + '</div>' +
        '<div class="perk-stat">' + (s.on ? '● ENABLED' : '○ LOCKED') + '</div></div>').join('') +
      '</div>' +
      '<p class="sk-note">Skills follow your <b>WORKSTATION</b> — placing objects in the room is what grants ' +
      'capability (the room layout IS the permission system). Granted skills switch on automatically when you ' +
      'assign your agent a task. Locked skills are coming as the harness grows.</p>';
  }

  /* ============== TASKS — real, persisted kanban ============== */
  const COLS = [['todo', 'TO DO'], ['doing', 'IN PROGRESS'], ['done', 'DONE']];
  function addTask(title) {
    title = String(title || '').trim(); if (!title) return;
    store.tasks.unshift({ id: uid('t'), title: title.slice(0, 160), col: 'todo', t: Date.now() });
    save(); rerender('tasks');
  }
  function moveTask(id, col) {
    const tk = store.tasks.find(x => x.id === id); if (!tk) return;
    tk.col = col; save(); rerender('tasks');
  }
  function delTask(id) { store.tasks = store.tasks.filter(x => x.id !== id); save(); rerender('tasks'); }
  function assignTask(id) {
    const tk = store.tasks.find(x => x.id === id); if (!tk) return;
    // a card IS a directive — hand it to the agent for real, then track it as in-progress
    if (typeof Chat === 'object' && Chat.send) Chat.send(tk.title);
    tk.col = 'doing'; save(); rerender('tasks');
    notify('assigned to ' + (present[0] ? present[0].name : 'agent') + ': ' + tk.title, 'gold');
    sfx('notify');
  }
  function card(tk) {
    const acts = tk.col === 'todo'
      ? '<button class="assign" data-act="assign">▶ ASSIGN</button><button data-act="doing">→</button><button data-act="del">✕</button>'
      : tk.col === 'doing'
        ? '<button data-act="done">✓ DONE</button><button data-act="todo">←</button><button data-act="del">✕</button>'
        : '<button data-act="todo">↺ REOPEN</button><button data-act="del">✕</button>';
    return '<div class="kb-card" data-id="' + tk.id + '">' +
      '<div class="kb-title">' + esc(tk.title) + '</div>' +
      '<div class="kb-meta"><span>' + clock(tk.t) + '</span></div>' +
      '<div class="kb-acts">' + acts + '</div></div>';
  }
  function buildTasks(body) {
    body.innerHTML =
      '<div class="kb-add"><input id="kb-in" maxlength="160" placeholder="add a task for your agent…" autocomplete="off">' +
      '<button class="bb sm" id="kb-add">+ ADD</button></div>' +
      '<div class="kb-cols">' +
      COLS.map(([c, label]) => {
        const items = store.tasks.filter(t => t.col === c);
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
      c.querySelectorAll('.kb-acts button').forEach(b => b.addEventListener('click', () => {
        const act = b.dataset.act; sfx('click');
        if (act === 'assign') assignTask(id);
        else if (act === 'del') delTask(id);
        else moveTask(id, act);
      }));
    });
  }

  /* ============== SETTINGS — real CRT / theme / audio toggles ============== */
  function buildSettings(body) {
    const s = store.settings;
    body.innerHTML =
      '<h4 class="ms-h">PHOSPHOR THEME</h4><div class="set-themes">' +
      THEMES.map(([t, c]) => '<button class="set-theme ' + (s.theme === t ? 'sel' : '') + '" data-t="' + t + '" style="--sw:' + c + '">' + t.toUpperCase() + '</button>').join('') +
      '</div>' +
      '<h4 class="ms-h">DISPLAY</h4>' +
      '<label class="set-row"><input type="checkbox" id="set-scan" ' + (s.scanlines ? 'checked' : '') + '> CRT SCANLINES</label>' +
      '<label class="set-row"><input type="checkbox" id="set-flicker" ' + (s.flicker ? 'checked' : '') + '> SCREEN FLICKER</label>' +
      '<label class="set-row"><input type="checkbox" id="set-sound" ' + (s.sound ? 'checked' : '') + '> TERMINAL AUDIO</label>' +
      '<h4 class="ms-h">STATION DATA</h4>' +
      '<div class="set-save"><button class="bb sm danger" id="set-clear">CLEAR BOARD & NOTIFS</button></div>' +
      '<p class="set-about">SKYNET — gamified AI-agent harness.<br>Theme, display & audio preferences and your task board are saved locally on this machine.</p>';
    body.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => {
      s.theme = b.dataset.t; applySettings(); save(); sfx('click'); rerender('settings');
    }));
    const bind = (id, key) => body.querySelector(id).addEventListener('change', ev => { s[key] = ev.target.checked; applySettings(); save(); });
    bind('#set-scan', 'scanlines'); bind('#set-flicker', 'flicker'); bind('#set-sound', 'sound');
    // two-step arm/confirm — no native dialogs inside the phosphor terminal
    const clr = body.querySelector('#set-clear');
    clr.addEventListener('click', () => {
      if (clr.dataset.armed) { store.tasks = []; store.notifs = []; save(); badges(); rerender('tasks'); rerender('notifs'); rerender('settings'); sfx('bad'); return; }
      clr.dataset.armed = '1'; clr.textContent = '✕ CONFIRM CLEAR'; sfx('bad');
      setTimeout(() => { if (clr.isConnected) { delete clr.dataset.armed; clr.textContent = 'CLEAR BOARD & NOTIFS'; } }, 5000);
    });
  }

  /* ============== NOTIFICATIONS — driven by real harness events ============== */
  function notify(text, cls) {
    store.notifs.push({ id: uid('n'), t: Date.now(), txt: String(text || ''), cls: cls || '', read: false });
    if (store.notifs.length > 60) store.notifs = store.notifs.slice(-60);
    save(); badges();
    if (open.notifs) rerender('notifs');
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
  function tick() {
    crewTick();
    const [txt, cls] = pillFor(activity());
    const p = $('#status-pill');
    if (p) { p.textContent = txt; p.className = cls; }
    if (open.agents) rerender('agents');
  }
  function flashSave() {
    const d = $('#save-dot'); if (!d) return;
    d.classList.add('flash'); setTimeout(() => d.classList.remove('flash'), 600);
  }

  /* ============== lifecycle ============== */
  const BUILDERS = {
    agents:   ['AGENT DOSSIER',          buildAgents,   { w: '560px' }],
    skills:   ['SKILLS & CAPABILITIES',  buildSkills,   { w: '520px' }],
    tasks:    ['TASK BOARD',             buildTasks,    { w: '760px' }],
    settings: ['SETTINGS',               buildSettings, { w: '440px' }],
    notifs:   ['NOTIFICATIONS',          buildNotifs,   { w: '460px' }]
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

  // called when entering the game room with the live agent(s)
  function enter(agents, accessors) {
    present = Array.isArray(agents) ? agents : (agents ? [agents] : []);
    access = accessors || {};
    sel = 0;
    crewRender();
    tick();
    if (!started) { started = true; tickTimer = setInterval(tick, 1000); }
  }

  // called on disconnect — tear down floating windows, keep persisted state
  function leave() {
    Object.keys(open).forEach(k => closeTerm(k));
  }

  return { init, enter, leave, notify, flashSave, openAgent, toggleTerm, rerender };
})();
