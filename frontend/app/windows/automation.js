/* STARNET — windows/automation.js : the AUTOMATION window (ROUTINES + LOOPS, one console).

   NAV CONDENSE (2026-08-04): the WORK dock sold three flavours of "job" — TASKS, ROUTINES, LOOPS —
   and the subtitles were already apologising for it. ROUTINES answer WHEN, LOOPS answer UNTIL; both
   are standing automation over the same crew, and their windows had the identical shape (an ACTIVE
   list + a CREATE flow). So they now share ONE dock item and ONE console window with four sections:
   ACTIVE ROUTINES · CREATE ROUTINE · ACTIVE LOOPS · START A LOOP.

   Mechanics: this file owns the window slot (key `automation`) and a tiny lane registry. Loads AFTER
   stationui.js and BEFORE windows/routines.js + windows/loops.js (see index.html); each of those
   registers a LANE — a function of (body) returning { sections, wire } — instead of mounting its own
   console. buildAutomation concatenates the lanes' sections into one mountConsole call, then runs
   each lane's wire() against the shared body. All panes are mounted up-front (mountConsole's design),
   the two lanes' ids are disjoint (rt-* / lp-*), so both wirings coexist untouched. */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow) return;
  const lanes = [];
  // the seam routines.js / loops.js register through. Kept deliberately tiny: order of registration
  // (script order in index.html) is the section order in the rail — routines first, loops second.
  window.AutomationWindow = { registerLane(fn) { if (typeof fn === 'function') lanes.push(fn); } };

  function buildAutomation(body) {
    const built = lanes.map(fn => fn(body)).filter(b => b && Array.isArray(b.sections));
    const sections = built.reduce((acc, b) => acc.concat(b.sections), []);
    StationUI.h.mountConsole(body, 'automation', sections, { search: false });
    built.forEach(b => { if (typeof b.wire === 'function') b.wire(); });
  }

  StationUI.registerWindow('automation', 'AUTOMATION', buildAutomation, { console: true });
})();
