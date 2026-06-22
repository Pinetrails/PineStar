/* SKYNET — ui.js : pip-boy interface layer */
'use strict';

const UI = (() => {
  const $ = s => document.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const ts = t => '<span class="ts">[' + U.fmtTime(t) + ']</span>';

  const AGENT_COLOR = {};
  DATA.AGENTS.forEach(a => AGENT_COLOR[a.id] = a.color);
  AGENT_COLOR.COMMANDER = '#ffd34a';

  function mentions(txt) {
    return U.esc(txt).replace(/@([A-Z][A-Z0-9]+)/g, (m, name) =>
      AGENT_COLOR[name] ? '<span class="mn" style="color:' + AGENT_COLOR[name] + '">@' + name + '</span>' : m);
  }

  /* ============== TOP BAR ============== */
  function topbar() {
    const S = SIM.S;
    $('#tb-total').textContent = U.money(S.rev.total);
    $('#tb-etsy').textContent = U.money(S.rev.etsy);
    $('#tb-fiverr').textContent = U.money(S.rev.fiverr);
    const net = S.rev.total - S.costs;
    const netEl = $('#tb-net');
    netEl.textContent = U.money(net);
    netEl.className = net >= 0 ? 'pos' : 'neg';
    const modeBtn = $('#tb-mode');
    modeBtn.textContent = S.mode === 'AUTO' ? '◉ AUTOPILOT' : '◎ MANUAL';
    modeBtn.classList.toggle('auto', S.mode === 'AUTO');
    $('#tb-lvl').textContent = S.level;
    $('#xpfill').style.width = Math.min(100, S.xp / SIM.xpNext(S.level) * 100) + '%';
  }

  /* ============== CREW LIST ============== */
  function crewInit() {
    const ul = $('#crew');
    ul.innerHTML = '';
    DATA.AGENTS.forEach(a => {
      const li = el('li', 'crew-row');
      li.dataset.agent = a.id;
      li.innerHTML =
        '<span class="dot on"></span>' +
        '<div class="crew-main"><div class="crew-name" style="color:' + a.color + '">' + a.id +
        '<span class="crew-room">' + DATA.ROOMS[a.room].name.split(' —')[0].replace('THE ', '') + '</span></div>' +
        '<div class="crew-status" id="cs-' + a.id + '">…</div>' +
        '<div class="crew-prog"><div id="cp-' + a.id + '"></div></div></div>';
      li.addEventListener('click', () => { SFX.click(); openAgent(a.id); });
      ul.appendChild(li);
    });
    $('#crew-n').textContent = DATA.AGENTS.length + ' UNITS';
  }
  function crewTick() {
    const S = SIM.S;
    let working = 0, flagged = 0;
    DATA.AGENTS.forEach(a => {
      const ag = S.agents[a.id];
      const e = $('#cs-' + a.id);
      // physical activity (errands, pool, hallway syncs) wins over canned idle text —
      // even mid-task: a maker hand-carrying a deliverable IS the pipeline step
      if (e) e.textContent = WORLD.statusFor(a.id) || ag.statusTxt;
      const isFlagged = S.feedback.some(f => f.agentId === a.id && f.status === 'open');
      if (isFlagged) flagged++;
      const row = document.querySelector('[data-agent="' + a.id + '"]');
      if (row) row.querySelector('.dot').classList.toggle('alert', isFlagged);
      // live task progress sliver
      const t = ag.taskId ? S.tasks.find(x => x.id === ag.taskId) : null;
      if (t) working++;
      const cp = $('#cp-' + a.id);
      if (cp) {
        cp.style.width = t ? Math.min(99, Math.round(t.prog / t.dur * 100)) + '%' : '0%';
        cp.parentElement.classList.toggle('off', !t);
      }
    });
    $('#crew-sum').innerHTML =
      '<span class="pos">▮ ' + working + ' WORKING</span>' +
      '<span class="dim">▯ ' + (DATA.AGENTS.length - working) + ' IDLE</span>' +
      (flagged ? '<span class="warn">⚑ ' + flagged + ' FLAGGED</span>' : '<span class="dim">⚑ 0</span>');
  }

  /* ============== RIGHT COLUMN ============== */
  function renderOps() {
    const box = $('#ops');
    const S = SIM.S;
    box.innerHTML = S.ops.slice(-34).map(o =>
      '<div class="op ' + o.cls + '">' + ts(o.t) + ' ' + U.esc(o.txt) + '</div>').join('');
    box.scrollTop = box.scrollHeight;
  }

  function renderMission() {
    const S = SIM.S;
    const act = S.tasks.filter(t => t.status === 'active');
    const todo = S.tasks.filter(t => t.status === 'todo').length;
    const quota = 10 + S.level * 2;
    const pct = Math.min(100, Math.round(S.dayAcc.tasks / quota * 100));
    $('#mc-aux').textContent = 'DAY ' + pct + '%';
    const feat = act.slice(0, 2);
    $('#mc').innerHTML =
      '<div class="mc-row"><span>ACTIVE <b>' + act.length + '</b></span><span>WAITING <b>' + todo + '</b></span><span>DAY <b>' + pct + '%</b></span></div>' +
      '<div class="mc-bar"><div style="width:' + pct + '%"></div></div>' +
      feat.map(t => {
        const p = Math.min(99, Math.round(t.prog / t.dur * 100));
        return '<div class="mc-task"><span class="mc-agent" style="color:' + AGENT_COLOR[t.agentId] + '">' + t.agentId + '</span> ' +
          U.esc(t.title.length > 38 ? t.title.slice(0, 36) + '…' : t.title) +
          '<div class="mc-bar sm"><div style="width:' + p + '%"></div></div></div>';
      }).join('');
  }

  function renderObjectives() {
    const S = SIM.S;
    $('#obj-aux').textContent = S.objectives.filter(o => o.done).length + '/' + S.objectives.length;
    $('#objs').innerHTML = S.objectives.map(o =>
      '<div class="obj ' + (o.done ? 'done' : '') + '"><span class="obj-chk">' + (o.done ? '■' : '□') + '</span> ' +
      U.esc(o.txt) + ' <span class="obj-n">' + o.prog + '/' + o.target + '</span></div>').join('');
  }

  function renderChat() {
    const box = $('#chat');
    const S = SIM.S;
    box.innerHTML = S.chat.slice(-40).map(c => {
      const col = AGENT_COLOR[c.from] || '#9adcb0';
      return '<div class="msg">' + ts(c.t) + ' <b style="color:' + col + '">' + c.from + '</b> ' + mentions(c.txt) + '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  /* ============== TERMINAL WINDOWS ============== */
  const open = {}; // key -> el
  let termDrag = null; // {w, dx, dy} — one shared drag state, registered once (leak-free)
  window.addEventListener('mousemove', ev => {
    if (termDrag) {
      termDrag.w.style.left = (ev.clientX - termDrag.dx) + 'px';
      termDrag.w.style.top = (ev.clientY - termDrag.dy) + 'px';
      termDrag.w.style.transform = 'none';
    }
  });
  window.addEventListener('mouseup', () => termDrag = null);
  function closeTerm(key) {
    if (open[key]) { open[key].remove(); delete open[key]; SFX.close(); }
    syncBB();
  }
  function toggleTerm(key, title, builder, opts) {
    if (open[key]) { closeTerm(key); return; }
    SFX.open();
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
    w.addEventListener('mousedown', () => { w.style.zIndex = U.zTop(); }); // bring to front
    // drag — handled by the single module-level listener pair (no per-window window listeners)
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
    document.querySelectorAll('.bb').forEach(b => b.classList.toggle('active', !!open[b.dataset.term]));
  }

  /* ============== AGENTS TERMINAL ============== */
  let agentSel = 'ULTRON';
  function buildAgents(body) {
    const S = SIM.S;
    const a = DATA.AGENT[agentSel], ag = S.agents[agentSel];
    const curTask = ag.taskId ? S.tasks.find(t => t.id === ag.taskId) : null;
    const taskPct = curTask ? Math.min(99, Math.round(curTask.prog / curTask.dur * 100)) : 0;
    const queued = S.tasks.filter(t => t.agentId === agentSel && t.status === 'todo').length;
    const pendingFB = S.feedback.filter(f => f.agentId === agentSel && f.status === 'open').length;
    const totalFB = ag.fbApproved + ag.fbDenied;
    const approvalRate = totalFB > 0 ? Math.round(ag.fbApproved / totalFB * 100) : null;
    const net = ag.earned - ag.spent;
    body.innerHTML =
      '<div class="ag-wrap"><div class="ag-list">' +
      DATA.AGENTS.map(x => '<div class="ag-item ' + (x.id === agentSel ? 'sel' : '') + '" data-id="' + x.id + '"><span style="color:' + x.color + '">●</span> ' + x.id + '</div>').join('') +
      '</div><div class="ag-detail">' +
      '<div class="ag-head"><canvas id="ag-portrait" width="26" height="34"></canvas>' +
      '<div><div class="ag-name" style="color:' + a.color + '">' + a.id + '</div>' +
      '<div class="ag-role">' + a.role + '</div>' +
      '<div class="ag-tags"><span class="tag ' + (a.harness === 'OPENCLAW' ? 'claw' : '') + '">' + a.harness + '</span>' +
      '<span class="tag model">' + DATA.MODELS[a.model].name + '</span>' +
      '<span class="tag">' + DATA.ROOMS[a.room].name + '</span>' +
      '<span class="tag">RELY ' + Math.round(a.reliability) + '</span></div></div></div>' +
      '<p class="ag-desc">' + a.desc + '</p>' +
      '<div class="stat-row"><span>AUTONOMY</span><div class="stat-bar"><div style="width:' + ag.autonomy + '%;background:#7fd0ff"></div></div><b>' + Math.round(ag.autonomy) + '</b></div>' +
      '<div class="ag-task-block">' +
      '<div class="ag-task-label">CURRENT TASK</div>' +
      (curTask
        ? '<div class="ag-task-title">' + U.esc(curTask.title.length > 62 ? curTask.title.slice(0, 60) + '…' : curTask.title) + '</div>' +
          '<div class="mc-bar sm"><div style="width:' + taskPct + '%"></div></div>' +
          '<div class="ag-task-pct">' + taskPct + '% complete</div>'
        : '<div class="ag-task-idle">▸ ' + U.esc(WORLD.statusFor(a.id) || ag.statusTxt) + '</div>'
      ) +
      '</div>' +
      '<div class="ag-stats">' +
      '<span>LVL <b>' + ag.level + '</b></span>' +
      '<span>TASKS <b>' + ag.tasksDone + '</b></span>' +
      '<span>QUEUE <b>' + queued + '</b></span>' +
      (pendingFB > 0 ? '<span>REVIEW <b class="neg">' + pendingFB + '</b></span>' : '') +
      '</div>' +
      (totalFB > 0
        ? '<div class="ag-stats"><span>RATE <b>' + approvalRate + '%</b></span><span>APPROVED <b class="pos">' + ag.fbApproved + '</b></span><span>DENIED <b class="neg">' + ag.fbDenied + '</b></span></div>'
        : '<div class="ag-stats"><span class="ag-no-fb">no feedback on record</span></div>'
      ) +
      '<div class="ag-note">Flags work below Q' + SIM.flagBelow(a.id) + ' — feedback raises autonomy, autonomy lowers that bar.</div>' +
      '</div></div>';
    body.querySelectorAll('.ag-item').forEach(it =>
      it.addEventListener('click', () => { agentSel = it.dataset.id; SFX.click(); rerender('agents'); }));
    // portrait
    const pc = body.querySelector('#ag-portrait');
    const pctx = pc.getContext('2d'); pctx.imageSmoothingEnabled = false;
    SPR.setCtx(pctx); SPR.setNow(performance.now());
    SPR.drawAgent({ id: a.id, px: 13, py: 31, dir: 'south', color: a.color, robot: a.robot, state: 'idle', phase: 0, sitting: false, working: false }, false);
  }
  function openAgent(id) { agentSel = id; if (open.agents) rerender('agents'); else toggleTerm('agents', 'AGENT DOSSIER', buildAgents, { w: '560px' }); }

  /* ============== TASKS (KANBAN) ============== */
  let kanbanFilter = 'all';
  function buildTasks(body) {
    const S = SIM.S;
    const card = t => {
      const room = DATA.ROOMS[DATA.AGENT[t.agentId].room].name.split(' —')[0];
      const p = t.status === 'active' ? Math.min(99, Math.round(t.prog / t.dur * 100)) : null;
      return '<div class="kb-card ' + (t.status === 'failed' ? 'failed' : '') + (t.playerOrder ? ' order' : '') + '">' +
        '<div class="kb-title">' + U.esc(t.title.length > 52 ? t.title.slice(0, 50) + '…' : t.title) + '</div>' +
        '<div class="kb-meta"><span style="color:' + AGENT_COLOR[t.agentId] + '">' + t.agentId + '</span><span>' + room + '</span>' +
        (t.quality ? '<span>Q' + t.quality + '</span>' : '') + '</div>' +
        (p !== null ? '<div class="mc-bar sm"><div style="width:' + p + '%"></div></div>' : '') + '</div>';
    };
    const flt = t => kanbanFilter === 'all' || DATA.AGENT[t.agentId].room === kanbanFilter;
    const todo = S.tasks.filter(t => t.status === 'todo' && flt(t));
    const act = S.tasks.filter(t => (t.status === 'active' || t.status === 'review') && flt(t));
    const done = S.tasks.filter(t => (t.status === 'done' || t.status === 'failed') && flt(t)).slice(-14).reverse();
    body.innerHTML =
      '<div class="kb-filter">DEPT: <select id="kb-sel">' +
      '<option value="all">ALL STATION</option>' +
      MAP.ROOM_IDS.map(r => '<option value="' + r + '"' + (kanbanFilter === r ? ' selected' : '') + '>' + DATA.ROOMS[r].name + '</option>').join('') +
      '</select></div>' +
      '<div class="kb-cols">' +
      '<div class="kb-col"><h4>TO DO <i>' + todo.length + '</i></h4>' + todo.map(card).join('') + '</div>' +
      '<div class="kb-col"><h4>IN PROGRESS <i>' + act.length + '</i></h4>' + act.map(card).join('') + '</div>' +
      '<div class="kb-col"><h4>DONE <i>' + done.length + '</i></h4>' + done.map(card).join('') + '</div></div>';
    body.querySelector('#kb-sel').addEventListener('change', ev => { kanbanFilter = ev.target.value; rerender('tasks'); });
  }

  /* ============== MILESTONES ============== */
  function buildMilestones(body) {
    const S = SIM.S;
    body.innerHTML =
      '<div class="ms-level"><div class="ms-lvl-num">STATION LEVEL ' + S.level + '</div>' +
      '<div class="mc-bar"><div style="width:' + Math.min(100, S.xp / SIM.xpNext(S.level) * 100) + '%"></div></div>' +
      '<div class="ms-xp">' + S.xp + ' / ' + SIM.xpNext(S.level) + ' XP</div></div>' +
      '<h4 class="ms-h">PERKS</h4><div class="perk-grid">' +
      DATA.C.perks.map(p => '<div class="perk ' + (S.level >= p.lvl ? 'on' : '') + '">' +
        '<div class="perk-icon">' + p.icon + '</div><div class="perk-name">' + p.name + '</div>' +
        '<div class="perk-desc">' + p.desc + '</div><div class="perk-lvl">LVL ' + p.lvl + '</div></div>').join('') +
      '</div><h4 class="ms-h">MILESTONES</h4><div class="ms-list">' +
      DATA.C.milestones.map(m => {
        const got = S.milestones.includes(m.id);
        return '<div class="ms-item ' + (got ? 'on' : '') + '"><span>' + (got ? '★' : '☆') + '</span> <b>' + m.name + '</b> — ' + m.desc + ' <i>+' + m.xp + 'xp</i></div>';
      }).join('') + '</div>';
  }

  /* ============== STATS ============== */
  function buildStats(body) {
    const S = SIM.S;
    const net = S.rev.total - S.costs;
    const lb = DATA.AGENTS.map(a => ({ id: a.id, e: S.agents[a.id].earned, t: S.agents[a.id].tasksDone, s: S.agents[a.id].spent }))
      .sort((a, b) => b.e - a.e).slice(0, 8);
    body.innerHTML =
      '<div class="st-cards">' +
      '<div class="st-card"><i>TOTAL REV</i><b class="pos">' + U.money(S.rev.total) + '</b></div>' +
      '<div class="st-card"><i>TOTAL BURN</i><b class="neg">' + U.money(S.costs) + '</b></div>' +
      '<div class="st-card"><i>NET</i><b class="' + (net >= 0 ? 'pos' : 'neg') + '">' + U.money(net) + '</b></div>' +
      '<div class="st-card"><i>SALES</i><b>' + S.stats.totalSales + '</b></div>' +
      '<div class="st-card"><i>TASKS</i><b>' + S.stats.totalTasks + '</b></div>' +
      '<div class="st-card"><i>SAAS MRR</i><b class="pos">' + U.money(S.mrr) + '/d</b></div>' +
      '<div class="st-card"><i>FIVERR ★</i><b>' + S.fiverrRating.toFixed(1) + '</b></div>' +
      '<div class="st-card"><i>LISTINGS</i><b>' + (S.listings.etsy1 + S.listings.etsy2 + S.listings.etsy3 + S.listings.assets) + '</b></div>' +
      '</div>' +
      '<h4 class="ms-h">REVENUE BY DAY</h4><canvas id="st-chart" width="460" height="110"></canvas>' +
      '<h4 class="ms-h">CHANNELS</h4><div class="st-ch">' +
      [['ETSY', S.rev.etsy, '#ff9d2e'], ['FIVERR', S.rev.fiverr, '#41ff8a'], ['OTHER', S.rev.other, '#7fd0ff']].map(([n, v, c]) => {
        const pct = S.rev.total ? v / S.rev.total * 100 : 0;
        return '<div class="st-chrow"><span>' + n + '</span><div class="stat-bar"><div style="width:' + pct + '%;background:' + c + '"></div></div><b>' + U.money(v) + '</b></div>';
      }).join('') + '</div>' +
      '<h4 class="ms-h">AGENT LEADERBOARD (EARNED)</h4><table class="st-tbl"><tr><th>AGENT</th><th>EARNED</th><th>TASKS</th><th>BURNED</th></tr>' +
      lb.map(r => '<tr><td style="color:' + AGENT_COLOR[r.id] + '">' + r.id + '</td><td class="pos">' + U.money(r.e) + '</td><td>' + r.t + '</td><td class="neg">' + U.money(r.s) + '</td></tr>').join('') +
      '</table>';
    // chart
    const c = body.querySelector('#st-chart').getContext('2d');
    const hist = S.history.slice(-14);
    const all = hist.concat([{ rev: S.dayAcc.rev, costs: S.dayAcc.costs }]);
    const max = Math.max(20, ...all.map(d => Math.max(d.rev, d.costs)));
    const bw = 460 / Math.max(7, all.length);
    c.fillStyle = '#090502'; c.fillRect(0, 0, 460, 110);
    all.forEach((d, i) => {
      const x = i * bw + 3;
      c.fillStyle = 'rgba(80,255,140,0.75)';
      c.fillRect(x, 105 - d.rev / max * 95, bw / 2 - 2, d.rev / max * 95);
      c.fillStyle = 'rgba(255,90,80,0.65)';
      c.fillRect(x + bw / 2 - 1, 105 - d.costs / max * 95, bw / 2 - 2, d.costs / max * 95);
    });
    c.fillStyle = '#eec88f'; c.font = '9px monospace';
    c.fillText('■ rev', 6, 10); c.fillStyle = '#ff7a6a'; c.fillText('■ burn', 46, 10);
  }

  /* ============== FEEDBACK ============== */
  let fbNote = {};
  function buildFeedback(body) {
    const S = SIM.S;
    const items = S.feedback.filter(f => f.status === 'open');
    if (!items.length) {
      body.innerHTML = '<div class="fb-empty">NO DELIVERABLES AWAITING JUDGEMENT.<br><span>The crew flags work it isn\'t confident in. Feedback — especially with notes — makes them better.</span></div>';
      return;
    }
    body.innerHTML = items.map(f => {
      const a = DATA.AGENT[f.agentId];
      const conf = U.clamp(f.quality + (U.hash(f.id) % 11) - 5, 10, 95);
      return '<div class="fb-item" data-id="' + f.id + '">' +
        '<div class="fb-head"><b style="color:' + a.color + '">' + f.agentId + '</b> <span class="fb-kind">' + DATA.KINDS[f.kind].label + '</span>' + ts(f.t) + '</div>' +
        '<div class="fb-title">' + U.esc(f.title) + '</div>' +
        '<div class="fb-msg">"' + U.esc(f.msg) + '"</div>' +
        '<div class="fb-conf">AGENT CONFIDENCE: <span class="' + (conf < 50 ? 'neg' : '') + '">' + conf + '%</span></div>' +
        '<input class="fb-note" placeholder="optional note — articulate feedback trains the agent…" maxlength="140" value="' + U.esc(fbNote[f.id] || '') + '">' +
        '<div class="fb-btns">' +
        '<button class="fb-b ap">APPROVE</button><button class="fb-b rt">RETRY</button>' +
        '<button class="fb-b dn">DENY</button><button class="fb-b ar">ARCHIVE FOREVER</button></div></div>';
    }).join('');
    body.querySelectorAll('.fb-item').forEach(it => {
      const id = it.dataset.id;
      it.querySelector('.fb-note').addEventListener('input', ev => fbNote[id] = ev.target.value);
      const act = v => () => { SFX.click(); SIM.feedback(id, v, fbNote[id]); delete fbNote[id]; };
      it.querySelector('.ap').addEventListener('click', act('approve'));
      it.querySelector('.rt').addEventListener('click', act('retry'));
      it.querySelector('.dn').addEventListener('click', act('deny'));
      it.querySelector('.ar').addEventListener('click', act('archive'));
    });
  }

  /* ============== NOTIFS ============== */
  function buildNotifs(body) {
    const S = SIM.S;
    body.innerHTML =
      '<button class="bb sm" id="nf-clear">MARK ALL READ</button>' +
      '<div class="nf-list">' + S.notifs.slice().reverse().map(n =>
        '<div class="nf ' + n.cls + (n.read ? ' read' : '') + '">' + ts(n.t) + ' ' + U.esc(n.txt) + '</div>').join('') + '</div>';
    body.querySelector('#nf-clear').addEventListener('click', () => {
      S.notifs.forEach(n => n.read = true); rerender('notifs'); badges(); SFX.click();
    });
    // unread stays unread until acknowledged — the badge is an honest signal
  }

  /* ============== SETTINGS ============== */
  function buildSettings(body) {
    const st = GAME.settings;
    body.innerHTML =
      '<h4 class="ms-h">PHOSPHOR THEME</h4><div class="set-themes">' +
      [['amber', '#ffaa33'], ['green', '#33ff66'], ['blue', '#46c8ff'], ['white', '#e8f0e8']].map(([t, c]) =>
        '<button class="set-theme ' + (st.theme === t ? 'sel' : '') + '" data-t="' + t + '" style="--sw:' + c + '">' + t.toUpperCase() + '</button>').join('') +
      '</div>' +
      '<h4 class="ms-h">DISPLAY</h4>' +
      '<label class="set-row"><input type="checkbox" id="set-scan" ' + (st.scanlines ? 'checked' : '') + '> CRT SCANLINES</label>' +
      '<label class="set-row"><input type="checkbox" id="set-flicker" ' + (st.flicker ? 'checked' : '') + '> SCREEN FLICKER</label>' +
      '<label class="set-row"><input type="checkbox" id="set-sound" ' + (st.sound ? 'checked' : '') + '> TERMINAL AUDIO</label>' +
      '<h4 class="ms-h">SIMULATION SPEED</h4><div class="set-themes">' +
      [1, 2, 4].map(s => '<button class="set-theme ' + (st.speed === s ? 'sel' : '') + '" data-s="' + s + '">' + s + '×</button>').join('') +
      '</div>' +
      '<h4 class="ms-h">SAVE DATA</h4>' +
      '<div class="set-save"><button class="bb sm" id="set-save">SAVE NOW</button> <button class="bb sm danger" id="set-reset">RESET STATION</button></div>' +
      '<p class="set-about">STARNET STATION OS v2.077 — autosaves every 30s.<br>17 agents · HERMES/OPENCLAW harnesses · simulated GPT 5.5 / OPUS 4.8 / FABLE 5 workloads.</p>';
    body.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => {
      st.theme = b.dataset.t; GAME.applySettings(); SFX.click(); rerender('settings');
    }));
    body.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => {
      st.speed = +b.dataset.s; GAME.applySettings(); SFX.click(); rerender('settings');
    }));
    body.querySelector('#set-scan').addEventListener('change', ev => { st.scanlines = ev.target.checked; GAME.applySettings(); });
    body.querySelector('#set-flicker').addEventListener('change', ev => { st.flicker = ev.target.checked; GAME.applySettings(); });
    body.querySelector('#set-sound').addEventListener('change', ev => { st.sound = ev.target.checked; GAME.applySettings(); });
    body.querySelector('#set-save').addEventListener('click', () => { GAME.save(); SFX.notify(); });
    // two-step in-panel arm/confirm — no native OS dialogs inside the phosphor terminal
    const resetBtn = body.querySelector('#set-reset');
    resetBtn.addEventListener('click', () => {
      if (resetBtn.dataset.armed) { GAME.reset(); return; }
      resetBtn.dataset.armed = '1';
      resetBtn.textContent = '✕ CONFIRM WIPE';
      SFX.bad();
      setTimeout(() => { // 5s auto-disarm
        if (resetBtn.isConnected) { delete resetBtn.dataset.armed; resetBtn.textContent = 'RESET STATION'; }
      }, 5000);
    });
  }

  /* ============== FEEDBACK SHORTCUT ============== */
  /* rooms are no longer clickable — props open their own terminal windows (propterm.js) */
  function openFeedback() { if (!open.feedback) toggleTerm('feedback', 'FEEDBACK QUEUE', buildFeedback, { w: '540px' }); }

  /* ============== BADGES / CLOCK ============== */
  function badges() {
    const S = SIM.S;
    const fb = S.feedback.filter(f => f.status === 'open').length;
    const nf = S.notifs.filter(n => !n.read).length;
    const fbB = $('#fb-badge'), nfB = $('#nf-badge');
    fbB.textContent = fb || ''; fbB.style.display = fb ? 'inline-block' : 'none';
    nfB.textContent = nf || ''; nfB.style.display = nf ? 'inline-block' : 'none';
  }

  /* ============== INIT ============== */
  const BUILDERS = {
    settings: ['SETTINGS', buildSettings, { w: '420px' }],
    agents: ['AGENT DOSSIER', buildAgents, { w: '560px' }],
    tasks: ['STATION KANBAN', buildTasks, { w: '720px' }],
    milestones: ['MILESTONES & PERKS', buildMilestones, { w: '520px' }],
    stats: ['STATION STATISTICS', buildStats, { w: '520px' }],
    feedback: ['FEEDBACK QUEUE', buildFeedback, { w: '540px' }],
    notifs: ['NOTIFICATIONS', buildNotifs, { w: '440px' }]
  };

  function init() {
    crewInit();
    document.querySelectorAll('.bb[data-term]').forEach(b =>
      b.addEventListener('click', () => {
        const k = b.dataset.term;
        const [title, fn, opts] = BUILDERS[k];
        toggleTerm(k, title, fn, opts);
      }));
    $('#tb-mode').addEventListener('click', () => { SFX.click(); SIM.toggleMode(); topbar(); });
    const input = $('#chat-input');
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && input.value.trim()) {
        SIM.playerMessage(input.value);
        input.value = '';
      } else if (ev.key.length === 1) SFX.type();
    });

    // bus wiring
    U.bus.on('ops', renderOps);
    U.bus.on('chat', renderChat);
    U.bus.on('objectives', renderObjectives);
    U.bus.on('stats', () => { topbar(); });
    U.bus.on('notify', () => { badges(); if (open.notifs) rerender('notifs'); });
    U.bus.on('feedback', () => {
      badges();
      if (!open.feedback) return;
      // never rebuild while the Commander is typing a note — articulate notes are the core loop
      const ae = document.activeElement;
      if (ae && ae.classList && ae.classList.contains('fb-note') && open.feedback.contains(ae)) {
        if (!ae._fbFlush) {
          ae._fbFlush = true;
          ae.addEventListener('blur', () => { if (open.feedback) rerender('feedback'); badges(); }, { once: true });
        }
        return;
      }
      rerender('feedback');
    });
    U.bus.on('task', () => { if (open.tasks) rerender('tasks'); });
    U.bus.on('level', () => { if (open.milestones) rerender('milestones'); });

    renderOps(); renderChat(); renderObjectives(); renderMission(); topbar(); badges();
  }

  function slowTick() { // 1/sec
    topbar(); crewTick(); renderMission(); badges();
    $('#clock').textContent = U.fmtClock(SIM.S.time);
    if (open.agents) rerender('agents');
    if (open.stats) rerender('stats');
    PROPTERM.tick();
  }

  return { init, slowTick, openAgent, openFeedback, toggleTerm, rerender };
})();
