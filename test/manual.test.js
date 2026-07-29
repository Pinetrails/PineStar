/* node test/manual.test.js — the StarNet operator manual appended to the system prompt so an agent
   can guide a stuck Commander. Verifies it is deterministic, structurally defers to the authoritative
   capabilities block (so it can never over-promise THIS agent's powers), and names props/UI with the
   SAME labels the live floor uses (guards label drift). */
'use strict';
const A = require('./_assert.js');
const { starnetManual } = require('../sidecar/manual.js');

(function () {
  const m = starnetManual();

  // 1) non-empty string, and deterministic (resume-safe — same bytes every call, ignores any arg)
  A.eq(typeof m, 'string', 'returns a string');
  A.ok(m.length > 200, 'manual is substantive');
  A.eq(starnetManual(), m, 'deterministic: identical across calls');
  A.eq(starnetManual({ surface: 'interactive', role: 'lead' }), m, 'argless: ignores opts, same bytes');

  // 2) fenced as a manual block (so it reads as a distinct section, like <capabilities_ground_truth>)
  A.ok(/<starnet_operator_manual>/.test(m) && /<\/starnet_operator_manual>/.test(m), 'wrapped in the manual fence');

  // 3) NO-CONTRADICTION GUARANTEE: it explicitly defers to <capabilities_ground_truth> and disclaims
  //    that it is the agent's own power list — this is what keeps it from ever lying about what the agent can do.
  A.ok(/capabilities_ground_truth/.test(m), 'defers to the authoritative capabilities block');
  A.ok(/NOT a list of your own powers/i.test(m), 'disclaims being the agent\'s own capability list');

  // 4) prop → power pairings use the REAL live labels (worldmodel CAP_LABEL / capsummary). A mismatch here
  //    means the manual would tell the Commander to place the wrong thing — exactly the drift we guard against.
  A.ok(/DISH[^\n]*WEB/.test(m), 'pairing: DISH → WEB');
  A.ok(/INTEL CAB[^\n]*FILES/.test(m), 'pairing: INTEL CAB → FILES');
  A.ok(/WORKBENCH[^\n]*TERMINAL/.test(m), 'pairing: WORKBENCH → TERMINAL');
  A.ok(/SERVER CART[^\n]*MEMORY/.test(m), 'pairing: SERVER CART → MEMORY');
  A.ok(/WORKSTATION[^\n]*COMPUTE/.test(m), 'pairing: WORKSTATION → COMPUTE');

  // 5) the user-facing surfaces are named so the agent points at the right control
  A.ok(/REFIT/.test(m), 'names REFIT (the builder)');
  A.ok(/COMMS/.test(m), 'names COMMS (where you task an agent)');
  A.ok(/ROUTINES/.test(m), 'names ROUTINES (built-in scheduled work)');
  A.ok(/Recruitment Bay/.test(m), 'names the Recruitment Bay (summon)');
  A.ok(/APPROVAL/.test(m), 'names APPROVAL/APPROVALS');

  // 6) troubleshooting cues a stuck Commander actually hits
  A.ok(/NO COMPUTE/.test(m), 'troubleshoots the NO COMPUTE / needs-a-workstation case');
  A.ok(/place the matching prop/i.test(m), 'tells the agent to place the matching prop for a missing power');
  A.ok(/Windows Task Scheduler/.test(m) && /OS crontab/.test(m), 'routine guidance points away from OS schedulers');

  // 7) hygiene: no template leakage
  A.ok(!/undefined|null|\[object/.test(m), 'no junk leaks into the manual');

  A.report('manual.test');
})();
