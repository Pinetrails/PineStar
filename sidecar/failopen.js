'use strict';
/* failopen.js — the ONE way to swallow an error on a fire-and-forget seam.

   Why this exists: reflection was silently dead on trunk for weeks because its caller's bare
   empty catch handler hid a 100% failure rate (see the runReflection note in index.js). A background
   pass is ALLOWED to fail — it must never hurt the run — but it is not allowed to fail invisibly.
   `swallow(tag)` keeps the fail-open contract (never rethrows, never blocks) while leaving a trace:
   a tagged console.warn plus a per-tag counter that tests and diagnostics can read. A liveness test
   can now prove an envelope fires by rejecting into it and reading counts().

   Usage:  somePass().catch(swallow('aux.reflection.envelope'))
           await store.claim(id).catch(swallow('workshop.claim', null))   // value-default form

   Warn throttle: the first WARN_EVERY_HEAD hits per tag always warn (a one-off failure is fully
   visible), then every WARN_EVERY_TAILth — so a 60s maintenance loop that breaks permanently keeps
   saying so without drowning the log. The counter always increments. */

const WARN_EVERY_HEAD = 5;
const WARN_EVERY_TAIL = 50;

const tally = new Map();   // tag -> total swallowed since boot

function swallow(tag, rv) {
  const t = String(tag || 'untagged');
  return (e) => {
    const n = (tally.get(t) || 0) + 1;
    tally.set(t, n);
    if (n <= WARN_EVERY_HEAD || n % WARN_EVERY_TAIL === 0) {
      try { console.warn('[failopen] ' + t + ' (x' + n + '):', (e && e.message) || e); } catch (_) {}
    }
    return rv;
  };
}

// read-only copy for tests / diagnostics; never expose the live Map (a caller clearing it would blind the trace)
function counts() { const o = {}; for (const [k, v] of tally) o[k] = v; return o; }
function resetForTests() { tally.clear(); }

module.exports = { swallow, counts, resetForTests };
