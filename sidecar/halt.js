/* sidecar/halt.js — the E-STOP kill logic, factored out of the host so it is unit-testable.
   killAll aborts EVERY in-flight run in one call: the browser runs (a Map runId -> AbortController) and the
   messaging-hub runs (a Map chatId -> { abort, superseded }). MULTIPLE hub maps may be passed (Telegram AND
   Discord share the same hub shape) — every trailing argument is treated as a hub inflight map. Hub runs are
   marked `superseded` BEFORE aborting so the hub does not deliver their now-stale partial reply after the kill
   (mirrors how the hub supersedes a run when a newer message arrives). Tolerant of null/absent maps and of an
   individual abort throwing — an E-STOP must never itself throw. Returns the number of runs aborted. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).halt = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function killAll(runs, ...hubInflights) {
    let halted = 0;
    if (runs && typeof runs.values === 'function') {
      for (const ac of runs.values()) { try { if (ac && typeof ac.abort === 'function') ac.abort(); halted++; } catch (_) { halted++; } }
    }
    for (const hubInflight of hubInflights) {
      if (!hubInflight || typeof hubInflight.values !== 'function') continue;
      for (const rec of hubInflight.values()) {
        try {
          if (rec) { rec.superseded = true; if (rec.abort && typeof rec.abort.abort === 'function') rec.abort.abort(); }
        } catch (_) { /* an E-STOP must not throw */ }
        halted++;
      }
    }
    return halted;
  }

  return { killAll };
});
