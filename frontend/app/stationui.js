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
  window.addEventListener('mousemove', ev => {
    if (termDrag) {
      termDrag.w.style.left = (ev.clientX - termDrag.dx) + 'px';
      termDrag.w.style.top = (ev.clientY - termDrag.dy) + 'px';
      termDrag.w.style.transform = 'none';
    }
  });
  window.addEventListener('mouseup', () => termDrag = null);

  function closeTerm(key) {
    if (open[key]) {
      const w = open[key];
      if (w._onClose) { try { w._onClose(); } catch (_) {} }   // e.g. tear down the live arcade canvas
      w.remove(); delete open[key]; sfx('close');
    }
    syncBB();
  }
  function toggleTerm(key, title, builder, opts) {
    if (open[key]) { closeTerm(key); return; }
    sfx('open');
    const w = el('div', 'term');
    w.style.zIndex = U.zTop();
    if (opts && opts.w) w.style.width = opts.w;
    w._onClose = opts && opts.onClose;
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
      '<span class="crew-room">HAB-01' + (a.stats && a.stats.level ? ' · Lv ' + a.stats.level : '') + '</span></div>' +
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

  /* ============== AGENTS — DOSSIER ==============
     Two sub-tabs. BRIEF is live telemetry (real lifetime spend). CONFIG is the agent's actual
     markdown config files — identity.md / purpose.md / operating-manual.md compose the EXACT
     system prompt the model runs on, so editing one here re-shapes the agent for real (App's
     applyAgentConfig, injected as access.config.apply). memory.md is the agent's own notebook —
     shown read-only and honestly labelled, because the agent writes it, not the Commander. */
  let agTab = 'brief';      // 'brief' | 'config'
  const agEdit = {};        // config fileKey -> true while its editor is open

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
    return '<div class="ag-hero">' +
      '<div class="ag-portrait-wrap"><canvas id="ag-portrait" width="52" height="68"></canvas></div>' +
      '<div class="ag-info">' +
      '<div class="ag-name" style="color:' + a.color + '">' + esc(a.name) + '</div>' +
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
    // AGENT GROWTH — Level / Confidence / progress-to-next. Confidence reads "—" until calibrated (honest cold-start).
    const g = (typeof Xp !== 'undefined' && a.stats) ? Xp.compute(a.stats) : null;
    const growth = g ? ('<div class="stat-grid">' +
      '<div class="stat-cell"><div class="stat-val">' + g.level + '</div><div class="stat-lbl">LEVEL</div></div>' +
      '<div class="stat-cell"><div class="stat-val' + (g.known ? ' pos' : '') + '">' + g.confLabel + '</div><div class="stat-lbl">CONFIDENCE</div></div>' +
      '<div class="stat-cell"><div class="stat-val">' + g.pct + '%</div><div class="stat-lbl">TO LV ' + (g.level + 1) + '</div></div>' +
      '</div>' +
      '<div class="ag-foot-row">reliability <b>' + g.band + '</b>' + (g.bonus ? ' · +' + g.bonus + '% XP' : '') + ' · ' + g.milestones.length + ' milestone' + (g.milestones.length === 1 ? '' : 's') + '</div>') : '';
    return growth + '<div class="stat-grid">' +
      '<div class="stat-cell"><div class="stat-val">' + (t.calls || 0) + '</div><div class="stat-lbl">RUNS</div></div>' +
      '<div class="stat-cell"><div class="stat-val">' + fmtTok(t.tokens) + '</div><div class="stat-lbl">TOKENS</div></div>' +
      '<div class="stat-cell"><div class="stat-val pos">$' + Number(t.cost || 0).toFixed(4) + '</div><div class="stat-lbl">SPENT</div></div>' +
      '</div>' +
      '<div class="ag-mission"><div class="ag-mission-lbl">MISSION</div>' +
      (a.purpose
        ? '<div class="ag-mission-text">' + esc(a.purpose) + '</div>'
        : '<div class="ag-mission-cta">No mission set — tell your agent what you need in COMMS, or write it in CONFIG › purpose.md.</div>') +
      '</div>' +
      '<div class="ag-foot-row">on station since <b>' + since + '</b> · all figures are real spend</div>';
  }

  function agSkills() {
    const on = SKILLS.filter(s => s.on).length;
    return '<h4 class="ms-h">GRANTED — ' + on + ' LIVE</h4>' +
      '<div class="perk-grid">' +
      SKILLS.map(s => '<div class="perk ' + (s.on ? 'on' : '') + '">' +
        '<div class="perk-icon">' + s.icon + '</div>' +
        '<div class="perk-name">' + s.name + '</div>' +
        '<div class="perk-desc">' + s.tools + '</div>' +
        '<div class="perk-stat' + (s.consent ? ' ask' : '') + '">' +
        (s.on ? (s.consent ? '● ASKS OK' : '● ENABLED') : '○ LOCKED') + '</div></div>').join('') +
      '</div>' +
      '<p class="sk-note">Capabilities follow the objects at the workstation. Only <b>file writes</b> pause for one-click approval in COMMS.</p>';
  }

  function fileCard(a, f) {
    const val = docVal(a, f.key), editing = !!agEdit[f.key];
    const head =
      '<div class="cf-head"><span class="cf-name">📄 ' + f.file + '</span>' +
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

  // memory.md is the agent's REAL notebook, read live from the sidecar (Harness.notebook). The agent writes
  // these notes itself with the notebook tool; the card is read-only. Rendered as a placeholder, then filled
  // by loadMemory() after the async fetch — so it survives the (config-tab) rerenders without a refetch race.
  function memoryCard(a) {
    return '<div class="cf cf-ro">' +
      '<div class="cf-head"><span class="cf-name">📄 memory.md</span>' +
      '<span class="cf-badge agent">AGENT-WRITTEN</span>' +
      '<span class="cf-bytes" id="cf-mem-cnt"></span></div>' +
      '<div class="cf-desc">' + esc(a.name) + '\'s own notebook — the durable notes it saves with its ' +
      'notebook tool while working, read live from its workspace. Read-only here; the agent owns it.</div>' +
      '<pre class="cf-body ro" id="cf-mem">reading notebook…</pre></div>';
  }
  // render the fetched notes as markdown-ish text (textContent, so note contents are never interpreted).
  function notesText(notes, name) {
    if (!notes.length) return name + ' hasn\'t saved any notes yet. Give it a task and it\'ll record durable ' +
      'facts here with its notebook tool — they show up in COMMS and NOTIFICATIONS as 📄 note deliverables.';
    return notes.map(n => {
      const when = n.ts ? new Date(n.ts).toLocaleString() : '';
      return '## ' + (n.title || '(untitled)') + (when ? '   — ' + when : '') + '\n' + (n.body || '');
    }).join('\n\n');
  }
  function loadMemory(a) {
    const pre = $('#cf-mem');
    if (!pre) return;
    if (!(typeof Harness === 'object' && Harness.notebook)) { pre.textContent = 'Notebook unavailable — start the sidecar to read it.'; return; }
    Harness.notebook(a.id).then(notes => {
      const cur = $('#cf-mem'); if (!cur) return;   // dossier may have closed/retabbed mid-fetch
      cur.textContent = notesText(notes, a.name);
      const cnt = $('#cf-mem-cnt');
      if (cnt) cnt.textContent = notes.length + (notes.length === 1 ? ' note' : ' notes');
    }).catch(() => { const cur = $('#cf-mem'); if (cur) cur.textContent = 'Could not read the notebook.'; });
  }

  function agConfig(a) {
    return '<div class="cf-root">📁 station://agents/' + esc(agSlug(a)) + '/</div>' +
      CONFIG_FILES.map(f => fileCard(a, f)).join('') +
      memoryCard(a);
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
    const tabContent = agTab === 'config' ? agConfig(a) : agTab === 'skills' ? agSkills() : agBrief(a);
    body.innerHTML =
      '<div class="ag-wrap"><div class="ag-list">' +
      present.map((x, i) => '<div class="ag-item ' + (i === sel ? 'sel' : '') + '" data-i="' + i + '">' +
        '<span style="color:' + x.color + '">●</span> ' + esc(x.name) + '</div>').join('') +
      '</div><div class="ag-detail">' +
      agHead(a, act, price) +
      '<div class="ag-tabs">' +
      '<button class="ag-tab ' + (agTab === 'brief' ? 'sel' : '') + '" data-tab="brief">BRIEF</button>' +
      '<button class="ag-tab ' + (agTab === 'skills' ? 'sel' : '') + '" data-tab="skills">SKILLS</button>' +
      '<button class="ag-tab ' + (agTab === 'config' ? 'sel' : '') + '" data-tab="config">CONFIG</button>' +
      '</div>' +
      tabContent +
      '</div></div>';
    body.querySelectorAll('.ag-item').forEach(it =>
      it.addEventListener('click', () => { sel = +it.dataset.i; sfx('click'); rerender('agents'); }));
    body.querySelectorAll('.ag-tab').forEach(tb =>
      tb.addEventListener('click', () => { agTab = tb.dataset.tab; sfx('click'); rerender('agents'); }));
    if (agTab === 'config') { wireConfig(body); loadMemory(a); }
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
  function openAgent(i) { sel = i; if (open.agents) rerender('agents'); else toggleTerm('agents', 'AGENT DOSSIER', buildAgents, { w: '600px' }); }

  /* ============== SKILLS — capability readout (mirrors the sidecar CAP_REGISTRY) ==============
     The agent's real tools come from the OBJECTS at its workstation (object = capability — see
     sidecar/capability/registry.js). This is an honest readout of that grant set: the real tool
     ids, and which actions pause for a one-click approval in COMMS (the P1.5 consent broker —
     writes to the user's files ask the Commander before they run; the private notebook does not).
     Kept in sync with the registry by hand; TERMINAL (shell.exec) is the registry's own "M5 next". */
  const SKILLS = [
    { icon: '🖥️', name: 'COMPUTE',     tools: 'model.chat',               on: true },
    { icon: '🔎', name: 'WEB SEARCH',  tools: 'web_search',               on: true },
    { icon: '📥', name: 'WEB FETCH',   tools: 'web_fetch',                on: true },
    { icon: '📂', name: 'READ FILES',  tools: 'fs.read · fs.list',        on: true },
    { icon: '✏️', name: 'WRITE FILES', tools: 'fs.write · append · edit', on: true, consent: true },
    { icon: '🧠', name: 'MEMORY',      tools: 'notebook.read · write',    on: true },
    { icon: '⌨️', name: 'TERMINAL',    tools: 'shell.exec',               on: false }
  ];
  function buildSkills(body) {
    const on = SKILLS.filter(s => s.on).length;
    body.innerHTML =
      '<h4 class="ms-h">GRANTED — ' + on + ' LIVE</h4>' +
      '<div class="perk-grid">' +
      SKILLS.map(s => '<div class="perk ' + (s.on ? 'on' : '') + '">' +
        '<div class="perk-icon">' + s.icon + '</div>' +
        '<div class="perk-name">' + s.name + '</div>' +
        '<div class="perk-desc">' + s.tools + '</div>' +
        '<div class="perk-stat' + (s.consent ? ' ask' : '') + '">' +
        (s.on ? (s.consent ? '● ASKS OK' : '● ENABLED') : '○ LOCKED') + '</div></div>').join('') +
      '</div>' +
      '<p class="sk-note">Skills follow your <b>WORKSTATION</b> — each object you place grants a capability ' +
      '(<b>computer</b> → compute · <b>antenna</b> → web · <b>cabinet</b> → files · <b>notebook</b> → memory), ' +
      'so the room layout IS the permission system. Read-only skills run freely, and the agent\'s own private ' +
      '<b>notebook memory</b> saves without asking; only <b>writing to your files</b> pauses for a one-click ' +
      'approval in COMMS before it runs. TERMINAL (sandboxed shell) is the next capability coming online.</p>';
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
  function connectedKeys() {
    const h = H(); if (!h || !h.getKey) return [];
    const k = h.getKey();
    if (!k) return [];
    return [{ provider: 'openrouter', key: k, model: (h.getModel && h.getModel()) || '' }];
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
      const stat = !p.live ? '○ COMING SOON' : connected ? '● CONNECTED' : '○ NO KEY';
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
      '<p class="set-about">Keys live locally on this machine and are sent only to the SKYNET sidecar (127.0.0.1) per request — never anywhere else. They are shown masked; the full secret is never displayed. (The shipped desktop build moves keys behind the OS keychain.)</p>' +
      '<h4 class="ms-h">PHOSPHOR THEME</h4><div class="set-themes">' +
      THEMES.map(([t, c]) => '<button class="set-theme ' + (s.theme === t ? 'sel' : '') + '" data-t="' + t + '" style="--sw:' + c + '">' + t.toUpperCase() + '</button>').join('') +
      '</div>' +
      '<h4 class="ms-h">DISPLAY</h4>' +
      '<label class="set-row"><input type="checkbox" id="set-scan" ' + (s.scanlines ? 'checked' : '') + '> CRT SCANLINES</label>' +
      '<label class="set-row"><input type="checkbox" id="set-flicker" ' + (s.flicker ? 'checked' : '') + '> SCREEN FLICKER</label>' +
      '<label class="set-row"><input type="checkbox" id="set-sound" ' + (s.sound ? 'checked' : '') + '> TERMINAL AUDIO</label>' +
      '<label class="set-row"><input type="checkbox" id="set-music" ' + (s.music !== false ? 'checked' : '') + '> STATION MUSIC <span class="dim">— adaptive score</span></label>' +
      '<h4 class="ms-h">STATION DATA</h4>' +
      '<div class="set-save"><button class="bb sm danger" id="set-clear">CLEAR NOTIFICATIONS</button></div>' +
      '<p class="set-about">SKYNET — gamified AI-agent harness.<br>Theme, display & audio preferences are saved locally on this machine. Manage workstreams from the TASK BOARD or the COMMS rail.</p>';
    wireKeyActions(body);
    // switch theme in place — applySettings repaints via the body class; do NOT rerender (it would wipe an open key editor).
    body.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => {
      s.theme = b.dataset.t; applySettings(); save(); sfx('click');
      body.querySelectorAll('[data-t]').forEach(x => x.classList.toggle('sel', x === b));
    }));
    const bind = (id, key) => body.querySelector(id).addEventListener('change', ev => { s[key] = ev.target.checked; applySettings(); save(); });
    bind('#set-scan', 'scanlines'); bind('#set-flicker', 'flicker'); bind('#set-sound', 'sound'); bind('#set-music', 'music');
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
    // refresh BRIEF's live telemetry only — never on CONFIG, where a rerender would wipe an open editor
    if (open.agents && agTab !== 'config') rerender('agents');
  }
  function flashSave() {
    const d = $('#save-dot'); if (!d) return;
    d.classList.add('flash'); setTimeout(() => d.classList.remove('flash'), 600);
  }

  /* ============== MESSAGING — connect a Telegram bot so the Commander can DM the agent ==============
     The bot token comes from Telegram's @BotFather; the agent answers DMs using this app's current
     OpenRouter key + model (handed to the sidecar on connect and persisted there for headless polling). */
  function buildMessaging(body) {
    body.innerHTML =
      '<h4 class="ms-h">TELEGRAM</h4>' +
      '<div id="tg-status" class="set-row">checking…</div>' +
      '<p class="set-about">DM your agent from Telegram. ' +
        '<b>1.</b> In Telegram open <b>@BotFather</b> → send <code>/newbot</code> → copy the token it gives you. ' +
        '<b>2.</b> Paste it below and connect. Your agent answers DMs using this app\'s current OpenRouter key + model, ' +
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
      const color = conn ? '#8f8' : (configured ? '#fc6' : '#999');
      statusEl.style.color = color;
      statusEl.textContent = conn ? ('● CONNECTED — polling' + (st.state && st.state !== 'up' ? ' (' + st.state + ')' : ''))
        : configured ? ('○ saved but offline — click CONNECT to reconnect' + (st.detail ? ' — ' + st.detail : ''))
        : '○ not connected';
    }
    async function refresh() {
      try { const r = await fetch('/api/channels/telegram/status'); paint(await r.json()); }
      catch (_) { configured = false; statusEl.style.color = '#999'; statusEl.textContent = '○ sidecar offline'; }
    }
    body.querySelector('#tg-connect').addEventListener('click', async () => {
      const token = (body.querySelector('#tg-token').value || '').trim();
      // a saved token can be reused (reconnect) — only require a fresh token on first-time setup.
      if (!token && !configured) { sfx('bad'); msgEl.textContent = 'paste your @BotFather token first'; return; }
      const key = (typeof Harness !== 'undefined' && Harness.getKey()) || '';
      const model = (typeof Harness !== 'undefined' && Harness.getModel()) || '';
      if (!key || !model) { sfx('bad'); msgEl.textContent = 'connect your agent (API key + model) on the title screen first'; return; }
      // hand the sidecar the REAL agent identity so Telegram is the SAME agent: the agentId the app uses for runs
      // (shared notebook/memory/workspace) + the composed system prompt (identity.md/purpose.md/manual.md).
      const ag = present[0] || {};
      const ws = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null;
      const agentId = (ws && ws.agentId) || 'agent';
      const system = (ag && ag.systemPrompt) || '';
      const agentName = (ag && ag.name) || '';
      msgEl.textContent = 'connecting…';
      try {
        const r = await fetch('/api/channels/telegram/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, key, model, agentId, system, agentName }) });
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

  /* ============== lifecycle ============== */
  const BUILDERS = {
    agents:   ['AGENT DOSSIER',          buildAgents,    { w: '560px' }],
    skills:   ['SKILLS & CAPABILITIES',  buildSkills,    { w: '520px' }],
    tasks:    ['TASK BOARD',             buildTasks,     { w: '760px' }],
    settings: ['SETTINGS',               buildSettings,  { w: '500px' }],
    messaging:['MESSAGING',              buildMessaging, { w: '520px' }],
    notifs:   ['NOTIFICATIONS',          buildNotifs,    { w: '460px' }]
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
  // one-shot: fold any legacy skynet.station.v1 kanban cards into real workstreams, then retire tasks[].
  // Guarded by a persisted flag so a refresh never re-imports / duplicates the cards. Runs from enter(),
  // which is called during app.js init() while `const App` is still in its TDZ — so this must NOT touch
  // App. The imported workstreams are written to skynet.save by the trailing persist() in resumeInto/onWake
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
    sel = 0;
    importLegacyTasks();
    crewRender();
    tick();
    if (!started) { started = true; tickTimer = setInterval(tick, 1000); }
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
  }

  return { init, enter, leave, notify, flashSave, openAgent, openArcade, toggleTerm, rerender, refreshBoard: () => rerender('tasks') };
})();
