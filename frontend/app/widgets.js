/* STARNET — widgets.js : the WIDGET RAILS (user-pinnable telemetry instruments).

   Two rails of compact instruments live in the chrome's DEAD SPACE — the empty middle of
   #topbar (between the logo anchor and the instrument cluster) and of #bottombar (between
   the dock groups and #term-strip/.bb-right). The world canvas is NEVER a widget surface:
   widgets belong to the chrome, like the STATION/SPEND wells they sit beside.

   TRUTHFUL TELEMETRY — every widget in the Phase-1 catalog is a read-only projection of
   provable harness state, sourced exactly like topbar.js sources SPEND TODAY:
     - RUNS · 24H   — /api/insights (whole-station fold, 24 hourly buckets) polled ≤1/30s,
                      PLUS live agent.run.end folds between polls (reconciled on next poll).
     - QUEUE        — the live queue.status {queueId, depth} events (per-agent inbound
                      backpressure). Event-driven only: shows an honest "—" until the first
                      event arrives, never a fabricated zero.
     - ROUTINES     — /api/cron {jobs, enabled} polled ≤1/60s + a value pulse on cron.fire.
     - TOKENS       — /api/insights totalTokens (all-time, whole station).

   This module OWNS no data and NEVER emits a bus event (read-only consumer, same contract
   as topbar.js — the frozen shared/events.js stays untouched). Its only writes are to its
   OWN localStorage key (rail layout), never to another module's state.

   Layout is user-arranged: drag a widget by anywhere on its body between the two rails
   (an insert caret previews the slot), add from the ＋ popover, remove via the hover ✕.
   Persisted under starnet.widgets.v1 = {v:1, top:[ids], bot:[ids]}. */
'use strict';
const Widgets = (() => {
  const KEY = 'starnet.widgets.v1';
  const POLL_INSIGHTS_MS = 30000;
  const POLL_CRON_MS = 60000;

  let wired = false;
  let layout = { top: ['runs24'], bot: [] };   // first-run default: one instrument, discoverable ＋ on both rails

  // ---- live data (module-local; all painted from here) ----
  let insights = null;        // last good /api/insights fold (null until first poll lands)
  let liveRunEnds = 0;        // agent.run.end count since the last good poll (the between-poll tick)
  let cron = null;            // last good /api/cron {jobs, enabled}
  const queueMap = new Map(); // queueId -> latest depth (event-driven)
  let queueSeen = false;      // stays honest: "—" until the first queue.status arrives

  const $ = sel => document.querySelector(sel);

  /* ================= pure folds (node-tested; no DOM) ================= */

  // sum the insights overTime buckets → runs in the window, plus the per-bucket series for the spark.
  function foldRuns(st) {
    const ot = (st && Array.isArray(st.overTime)) ? st.overTime : [];
    let runs = 0; const series = [];
    for (const b of ot) { const n = Number(b && b.runs) || 0; runs += n; series.push(n); }
    return { runs, series };
  }

  // all-time token total: prefer the fold's own figure, else sum byModel (defensive, never NaN).
  function foldTokens(st) {
    if (st && isFinite(Number(st.totalTokens))) return Number(st.totalTokens);
    let t = 0;
    for (const m of (st && Array.isArray(st.byModel)) ? st.byModel : []) t += Number(m && m.tokens) || 0;
    return t;
  }

  // compact count: 950 → "950", 12400 → "12.4K", 3200000 → "3.2M" (tabular, no locale surprises)
  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (Math.round(n / 1e5) / 10) + 'M';
    if (n >= 1e3) return (Math.round(n / 1e2) / 10) + 'K';
    return String(Math.round(n));
  }

  // sanitize a persisted layout: known ids only, no dupes across rails, always both arrays.
  function sanitizeLayout(raw, known) {
    const out = { top: [], bot: [] }, seen = new Set();
    for (const rail of ['top', 'bot']) {
      const ids = (raw && Array.isArray(raw[rail])) ? raw[rail] : [];
      for (const id of ids) if (known.indexOf(id) >= 0 && !seen.has(id)) { seen.add(id); out[rail].push(id); }
    }
    return out;
  }

  /* ================= the catalog ================= */
  // paint() returns {val, sub, series?} — null val paints an honest "—".
  const CATALOG = {
    runs24: {
      lbl: 'RUNS · 24H',
      tip: 'Runs across the whole station in the last 24h — folded from the real run history (/api/insights), ticking live on each run end.',
      paint() {
        if (!insights) return { val: null, sub: '' };
        const f = foldRuns(insights);
        return { val: String(f.runs + liveRunEnds), sub: '', series: f.series };
      }
    },
    queue: {
      lbl: 'QUEUE',
      tip: 'Inbound work items waiting across all agents — live queue.status backpressure events. Shows — until the first event arrives.',
      paint() {
        if (!queueSeen) return { val: null, sub: '' };
        let d = 0; for (const v of queueMap.values()) d += v;
        return { val: String(d), sub: d === 1 ? 'item' : 'items' };
      }
    },
    cron: {
      lbl: 'ROUTINES',
      tip: 'Scheduled routines on the sidecar (/api/cron) — count + whether the scheduler is armed. The value pulses when a routine fires.',
      paint() {
        if (!cron) return { val: null, sub: '' };
        const n = Array.isArray(cron.jobs) ? cron.jobs.length : 0;
        return { val: String(n), sub: cron.enabled ? 'armed' : 'disarmed' };
      }
    },
    tokens: {
      lbl: 'TOKENS',
      tip: 'Total tokens across every run the station has ever billed — from the real run-history fold (/api/insights).',
      paint() {
        if (!insights) return { val: null, sub: '' };
        return { val: fmtCount(foldTokens(insights)), sub: 'all-time' };
      }
    }
  };
  const KNOWN = Object.keys(CATALOG);

  /* ================= persistence (own key only) ================= */
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw && raw.v === 1) layout = sanitizeLayout(raw, KNOWN);
    } catch (_) { /* corrupt store: keep the default */ }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ v: 1, top: layout.top, bot: layout.bot })); } catch (_) {}
  }

  /* ================= render ================= */
  function railEl(r) { return document.getElementById(r === 'top' ? 'wr-top' : 'wr-bot'); }

  function sparkSvg(series) {
    const w = 46, h = 16;
    if (!series || series.length < 2) return '';
    const mx = Math.max(1, ...series);
    const pts = series.map((v, i) =>
      ((i / (series.length - 1)) * w).toFixed(1) + ',' + (h - 1 - (v / mx) * (h - 3)).toFixed(1)).join(' ');
    return '<svg class="wg-spark" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">'
      + '<polyline points="' + pts + '" fill="none"/></svg>';
  }

  function makeWidget(id) {
    const def = CATALOG[id];
    const el = document.createElement('div');
    el.className = 'wg';
    el.dataset.wg = id;
    el.title = def.tip;
    el.innerHTML =
      '<span class="wg-meta"><span class="wg-lbl">' + def.lbl + '</span>'
      + '<span class="wg-src"><i class="wg-dot" aria-hidden="true"></i>live</span></span>'
      + '<b class="wg-val">—</b><span class="wg-sub"></span><span class="wg-sparkslot"></span>'
      + '<button class="wg-x" title="remove widget" aria-label="Remove ' + def.lbl + ' widget">✕</button>';
    el.querySelector('.wg-x').addEventListener('click', (e) => { e.stopPropagation(); removeWidget(id); });
    el.addEventListener('pointerdown', (e) => {
      if (e.target && e.target.closest('.wg-x')) return;
      startDrag(e, id);
    });
    paintWidget(el, id);
    return el;
  }

  function paintWidget(el, id) {
    const p = CATALOG[id].paint();
    const val = el.querySelector('.wg-val'), sub = el.querySelector('.wg-sub'), slot = el.querySelector('.wg-sparkslot');
    if (val) { val.textContent = p.val == null ? '—' : p.val; }
    el.setAttribute('data-empty', p.val == null ? '1' : '0');
    if (sub) sub.textContent = p.sub || '';
    if (slot) slot.innerHTML = p.val == null ? '' : sparkSvg(p.series);
  }

  function paintAll(pulseId) {
    for (const el of document.querySelectorAll('.wg')) {
      paintWidget(el, el.dataset.wg);
      if (pulseId && el.dataset.wg === pulseId) {
        el.classList.remove('wg-tick'); void el.offsetWidth; el.classList.add('wg-tick');
      }
    }
  }

  function makeAddBtn(rail) {
    const b = document.createElement('button');
    b.className = 'wg-add';
    b.title = 'add a widget';
    b.setAttribute('aria-label', 'Add a widget to this rail');
    b.setAttribute('aria-haspopup', 'menu');
    b.textContent = '＋';
    b.addEventListener('click', (e) => { e.stopPropagation(); togglePop(b, rail); });
    return b;
  }

  function render() {
    for (const r of ['top', 'bot']) {
      const el = railEl(r); if (!el) continue;
      el.innerHTML = '';
      for (const id of layout[r]) el.appendChild(makeWidget(id));
      el.appendChild(makeAddBtn(r));
      el.setAttribute('data-empty', layout[r].length === 0 ? '1' : '0');
    }
    save();
  }

  function removeWidget(id) {
    layout.top = layout.top.filter(x => x !== id);
    layout.bot = layout.bot.filter(x => x !== id);
    render();
  }

  /* ================= the ＋ popover ================= */
  let popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; document.removeEventListener('click', closePop); } }
  function togglePop(btn, rail) {
    if (popEl) { closePop(); return; }
    const placed = layout.top.concat(layout.bot);
    popEl = document.createElement('div');
    popEl.className = 'wg-pop';
    popEl.setAttribute('role', 'menu');
    for (const id of KNOWN) {
      const def = CATALOG[id], has = placed.indexOf(id) >= 0;
      const item = document.createElement('button');
      item.setAttribute('role', 'menuitem');
      item.className = 'wg-pop-item' + (has ? ' on' : '');
      item.innerHTML = '<span>' + def.lbl + '</span><i>' + (has ? '✓ shown' : '+ add') + '</i>';
      item.title = def.tip;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (has) { removeWidget(id); } else { layout[rail].push(id); render(); }
        closePop();
      });
      popEl.appendChild(item);
    }
    document.body.appendChild(popEl);
    const r = btn.getBoundingClientRect();
    const below = r.top < window.innerHeight / 2;   // top rail → open downward; bottom rail → upward
    popEl.style.left = Math.max(8, Math.min(window.innerWidth - 228, r.left - 40)) + 'px';
    if (below) popEl.style.top = (r.bottom + 6) + 'px';
    else popEl.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    popEl.addEventListener('click', e => e.stopPropagation());
    setTimeout(() => document.addEventListener('click', closePop), 0);
  }

  /* ================= drag between rails ================= */
  let drag = null;
  function startDrag(e, id) {
    // engage only after a small move so an idle click never grows a ghost
    const sx = e.clientX, sy = e.clientY;
    const arm = (ev) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;
      window.removeEventListener('pointermove', arm);
      engage(ev, id);
    };
    const disarm = () => window.removeEventListener('pointermove', arm);
    window.addEventListener('pointermove', arm);
    window.addEventListener('pointerup', disarm, { once: true });
  }
  function engage(e, id) {
    closePop();
    const ghost = makeWidget(id);
    ghost.classList.add('wg-drag');
    document.body.appendChild(ghost);
    const caret = document.createElement('i'); caret.className = 'wg-caret';
    drag = { id, ghost, caret, hot: null, x: 0 };
    for (const r of ['top', 'bot']) { const el = railEl(r); if (el) el.classList.add('wg-armed'); }
    move(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', drop, { once: true });
  }
  function hitRail(x, y) {
    for (const r of ['top', 'bot']) {
      const el = railEl(r); if (!el) continue;
      const bar = el.parentElement.getBoundingClientRect();   // the whole bar is a generous target
      if (x >= bar.left && x <= bar.right && y >= bar.top - 6 && y <= bar.bottom + 6) return r;
    }
    return null;
  }
  function insertIndex(rail, x) {
    const kids = Array.from(railEl(rail).querySelectorAll('.wg')).filter(k => k.dataset.wg !== drag.id);
    for (let i = 0; i < kids.length; i++) {
      const b = kids[i].getBoundingClientRect();
      if (x < b.left + b.width / 2) return i;
    }
    return kids.length;
  }
  function move(e) {
    if (!drag) return;
    drag.ghost.style.left = (e.clientX - 40) + 'px';
    drag.ghost.style.top = (e.clientY - 14) + 'px';
    const hot = hitRail(e.clientX, e.clientY);
    for (const r of ['top', 'bot']) { const el = railEl(r); if (el) el.classList.toggle('wg-hot', r === hot); }
    if (drag.caret.parentElement) drag.caret.remove();
    if (hot) {
      const rail = railEl(hot);
      const kids = Array.from(rail.querySelectorAll('.wg')).filter(k => k.dataset.wg !== drag.id);
      const idx = insertIndex(hot, e.clientX);
      if (idx >= kids.length) rail.insertBefore(drag.caret, rail.querySelector('.wg-add'));
      else rail.insertBefore(drag.caret, kids[idx]);
    }
    drag.hot = hot; drag.x = e.clientX;
  }
  function drop() {
    window.removeEventListener('pointermove', move);
    if (!drag) return;
    const { id, hot, x } = drag;
    if (hot) {
      const idx = insertIndex(hot, x);
      layout.top = layout.top.filter(i => i !== id);
      layout.bot = layout.bot.filter(i => i !== id);
      layout[hot].splice(idx, 0, id);
    }
    drag.ghost.remove();
    if (drag.caret.parentElement) drag.caret.remove();
    for (const r of ['top', 'bot']) { const el = railEl(r); if (el) el.classList.remove('wg-armed', 'wg-hot'); }
    drag = null;
    render();
  }

  /* ================= data wiring (poll + live fold, topbar.js pattern) ================= */
  function pollInsights() {
    fetch('/api/insights', { cache: 'no-store' })
      .then(r => (r && r.ok) ? r.json() : null)
      .then(st => { if (st) { insights = st; liveRunEnds = 0; paintAll(); } })
      .catch(() => { /* sidecar absent: widgets keep their honest "—" */ });
  }
  function pollCron() {
    fetch('/api/cron', { cache: 'no-store' })
      .then(r => (r && r.ok) ? r.json() : null)
      .then(st => { if (st && Array.isArray(st.jobs)) { cron = st; paintAll(); } })
      .catch(() => {});
  }

  function init() {
    if (wired) return;
    wired = true;
    load();
    render();

    if (typeof U !== 'undefined' && U.bus) {
      U.bus.on('agent.run.end', () => { try { liveRunEnds++; paintAll('runs24'); } catch (_) {} });
      U.bus.on('queue.status', p => {
        try {
          if (!p || typeof p.queueId !== 'string') return;
          queueSeen = true;
          queueMap.set(p.queueId, Math.max(0, Number(p.depth) || 0));
          paintAll('queue');
        } catch (_) {}
      });
      U.bus.on('cron.fire', () => { try { paintAll('cron'); } catch (_) {} });
    }

    pollInsights(); setInterval(pollInsights, POLL_INSIGHTS_MS);
    pollCron(); setInterval(pollCron, POLL_CRON_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // read-only dev/verification surface (mirrors topbar.js; inert otherwise)
  return { init, _layout: () => ({ top: layout.top.slice(), bot: layout.bot.slice() }), _paintAll: paintAll,
           _foldRuns: foldRuns, _foldTokens: foldTokens, _fmtCount: fmtCount, _sanitizeLayout: sanitizeLayout };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { Widgets };
