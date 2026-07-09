/* STARNET — safety.js : the emergency-stop (E-STOP) logic, the visible topbar control + Alt+H hotkey.

   The harness autonomously spends the Commander's money and writes files, so it needs a one-click
   "stop EVERYTHING". HALT calls /api/halt — which kills every run on the sidecar (browser AND any
   messaging-hub/Telegram run) — and aborts the local streams. Degrades silently when the API isn't reachable.

   EL-11 FIX 2: error copy tells users to "press E-STOP", but after the old corner button was removed
   (it overlapped the bottom-right status cluster) the path was Alt+H ONLY and the hotkey appeared nowhere
   in the DOM — an instruction pointing at a control that didn't exist. Restored conservatively: a compact
   E-STOP instrument in the topbar's status cluster (existing chrome vocabulary, no corner overlay), which
   itself teaches the Alt+H hotkey in its title. The hotkey stays global. */
'use strict';
(function () {
  if (typeof document === 'undefined') return;

  async function halt() {
    // local first — abort the open browser fetches immediately — then the authoritative server-side kill-all
    // (which also reaches background / Telegram runs the browser has no handle to).
    try { if (typeof Chat !== 'undefined' && Chat.abort) Chat.abort(); } catch (_) {}
    let n = 0;
    try { if (typeof Harness !== 'undefined' && Harness.haltAll) n = await Harness.haltAll(); } catch (_) {}
    try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('HALT — stopped ' + n + ' run' + (n === 1 ? '' : 's'), 'warn'); } catch (_) {}
    try { if (typeof SFX !== 'undefined' && SFX.alarm) SFX.alarm(); } catch (_) {}
  }
  // Alt+H is a global E-STOP — it fires even while typing (an emergency stop must never be swallowed by focus).
  window.addEventListener('keydown', e => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); halt(); }
  });

  // the visible affordance: a compact stop control seated in the topbar status cluster (#topbar .tb-status),
  // to the LEFT of the uplink/status pills so the danger control reads first. Built idempotently after the
  // chrome exists; a missing topbar (title/connect screens) just retries on the next DOM-ready pass.
  function buildEstop() {
    const cluster = document.querySelector('#topbar .tb-status');
    if (!cluster || document.getElementById('estop-btn')) return;
    const b = document.createElement('button');
    b.id = 'estop-btn';
    b.type = 'button';
    b.textContent = '⏹ E-STOP';
    b.title = 'E-STOP — kill every live run, everywhere, now (Alt+H)';
    b.setAttribute('aria-label', 'Emergency stop — halt all runs (Alt+H)');
    b.addEventListener('click', halt);
    cluster.insertBefore(b, cluster.firstChild);
  }
  if (document.readyState !== 'loading') buildEstop();
  else document.addEventListener('DOMContentLoaded', buildEstop);
})();
