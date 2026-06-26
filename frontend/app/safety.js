/* STARNET — safety.js : the always-visible E-STOP + a glanceable spend/cap readout.

   The harness autonomously spends the Commander's money and writes files, so it needs (1) a one-click
   "stop EVERYTHING" and (2) the budget made VISIBLE, not just enforced. HALT calls /api/halt — which kills
   every run on the sidecar (browser AND any messaging-hub/Telegram run) — and aborts the local streams. The
   readout polls /api/budget/status (the existing budget governor: per-run/day/global caps over a persisted
   ledger) so the pools are on screen. Self-contained: it builds its own fixed control, so it needs no HUD
   markup and can't collide with the layout. Degrades silently when the API isn't reachable (e.g. a static
   preview): the readout just hides. */
'use strict';
(function () {
  if (typeof document === 'undefined') return;

  // ---------- the fixed E-STOP control (bottom-right, above the CRT glass) ----------
  const wrap = document.createElement('div');
  wrap.id = 'estop-wrap';
  wrap.innerHTML =
    '<div id="estop-budget" class="estop-budget" hidden></div>' +
    '<button id="estop-btn" type="button" title="HALT every running agent — browser and messaging (Alt+H)">⏹ HALT</button>';
  function mount() { if (document.body && !document.body.contains(wrap)) document.body.appendChild(wrap); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  const btn = wrap.querySelector('#estop-btn');
  const budgetEl = wrap.querySelector('#estop-budget');
  let flashT = 0;

  // one-click RESUME after a SOFT pool cap blocks new runs: POST /api/budget/resume grants another cap of
  // headroom for that scope so the Commander isn't dead-ended. Delegated (the readout HTML is rebuilt each poll).
  budgetEl.addEventListener('click', async ev => {
    const b = ev.target.closest('.bresume'); if (!b) return;
    const scope = b.dataset.scope; if (scope !== 'day' && scope !== 'global') return;
    b.disabled = true; b.textContent = '…';
    try {
      const r = await fetch('/api/budget/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }) });
      if (r.ok) { try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('budget resumed — ' + scope + ' cap raised; agents can run again', 'good'); } catch (_) {} }
    } catch (_) {}
    refreshBudget();
  });

  async function halt() {
    // local first — abort the open browser fetches immediately — then the authoritative server-side kill-all
    // (which also reaches background / Telegram runs the browser has no handle to).
    try { if (typeof Chat !== 'undefined' && Chat.abort) Chat.abort(); } catch (_) {}
    let n = 0;
    try { if (typeof Harness !== 'undefined' && Harness.haltAll) n = await Harness.haltAll(); } catch (_) {}
    flash(n);
    try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('HALT — stopped ' + n + ' run' + (n === 1 ? '' : 's'), 'warn'); } catch (_) {}
    try { if (typeof SFX !== 'undefined' && SFX.alarm) SFX.alarm(); } catch (_) {}
    refreshBudget();
  }
  function flash(n) {
    btn.classList.add('hit'); btn.textContent = '⏹ HALTED (' + n + ')';
    clearTimeout(flashT);
    flashT = setTimeout(() => { btn.classList.remove('hit'); btn.textContent = '⏹ HALT'; }, 1500);
  }
  btn.addEventListener('click', halt);
  // Alt+H is a global E-STOP — it fires even while typing (an emergency stop must never be swallowed by focus).
  window.addEventListener('keydown', e => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); halt(); }
  });

  // ---------- glanceable spend/cap readout (the budget is ENFORCED server-side; this makes it VISIBLE) ----------
  function fmt(n) { return '$' + (Number(n) || 0).toFixed(2); }
  async function refreshBudget() {
    let s;
    try {
      const r = await fetch('/api/budget/status', { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      s = await r.json();
    } catch (_) { budgetEl.hidden = true; return; }   // not served by the sidecar → hide rather than show a fake number
    const parts = [];
    const over = [];   // governed scopes (day/global) past their cap — offer a one-click RESUME
    const seg = (label, scope, pool) => {
      if (!pool || !(pool.cap > 0)) return;
      const frac = pool.usd / pool.cap;
      const isOver = frac >= 1;
      const cls = isOver ? ' over' : (frac >= 0.8 ? ' warn' : '');
      if (isOver && (scope === 'day' || scope === 'global')) over.push(scope);
      parts.push('<span class="bseg' + cls + '">' + label + ' ' + fmt(pool.usd) + '/' + fmt(pool.cap) + '</span>');
    };
    seg('today', 'day', s.day); seg('all', 'global', s.global);
    if (s.perRun) parts.push('<span class="bseg dim">run≤' + fmt(s.perRun) + '</span>');
    if (!parts.length) { budgetEl.hidden = true; return; }
    // a soft cap is blocking new runs — surface the resume control instead of dead-ending the Commander.
    if (over.length) parts.push('<button type="button" class="bseg over bresume" data-scope="' + over[0] + '" style="cursor:pointer" title="grant another ' + over[0] + ' cap of headroom and keep going">↻ RESUME</button>');
    budgetEl.innerHTML = parts.join('');
    budgetEl.hidden = false;
  }
  refreshBudget();
  setInterval(refreshBudget, 10000);
  // also refresh the moment a run ends (cheap: ride the same U.bus the harness already emits onto)
  try { if (typeof U !== 'undefined' && U.bus && U.bus.on) U.bus.on('agent.run.end', () => refreshBudget()); } catch (_) {}
})();
