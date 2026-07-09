/* STARNET — safety.js : the emergency-stop (E-STOP) logic + Alt+H hotkey.

   The harness autonomously spends the Commander's money and writes files, so it needs a one-click
   "stop EVERYTHING". HALT calls /api/halt — which kills every run on the sidecar (browser AND any
   messaging-hub/Telegram run) — and aborts the local streams. The always-visible corner button and its
   attached budget chip were removed (they overlapped the bottom-right status cluster); the emergency-stop
   path now lives entirely behind the global Alt+H hotkey. Degrades silently when the API isn't reachable. */
'use strict';
(function () {
  if (typeof document === 'undefined') return;

  async function halt() {
    // SERVER first — the authoritative kill-all (it reaches background / cron / night-shift / Telegram runs the
    // browser has no handle to) — THEN abort the local fetch streams. Order is load-bearing for the toast's
    // honesty: aborting locally first closed the /api/run request, whose close-handler deleted the run from the
    // server's `runs` map BEFORE /api/halt counted it — so the toast said "stopped 0 runs" while runs were in
    // fact being stopped. Counting on the server before local teardown keeps the number real; the local abort
    // still lands milliseconds later (and the server-side abort has already ended the loops' spend either way).
    let n = 0;
    try { if (typeof Harness !== 'undefined' && Harness.haltAll) n = await Harness.haltAll(); } catch (_) {}
    try { if (typeof Chat !== 'undefined' && Chat.abort) Chat.abort(); } catch (_) {}
    try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('HALT — stopped ' + n + ' run' + (n === 1 ? '' : 's'), 'warn'); } catch (_) {}
    try { if (typeof SFX !== 'undefined' && SFX.alarm) SFX.alarm(); } catch (_) {}
  }
  // Alt+H is a global E-STOP — it fires even while typing (an emergency stop must never be swallowed by focus).
  window.addEventListener('keydown', e => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); halt(); }
  });
})();
