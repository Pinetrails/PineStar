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
})();
