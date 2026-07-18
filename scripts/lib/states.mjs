// scripts/lib/states.mjs — the canonical list of UI states the screenshotter drives.
//
// The bottom dock (#bottombar) groups items into 4 popovers (CREW / WORK / BUILD / SYSTEM).
// Each item keeps a STABLE id or data-term (see frontend/index.html / navdock.js), so we click
// by id/[data-term] instead of by visible text — text drifts, ids don't. The popover need not
// be open: .click() fires the item's bound handler even while the flyout is visually hidden.
//
// Re-derived from current trunk (index.html lines 166-200): adds MANUAL + NOTIFS panels that
// the old text-matched list missed, and fixes ROSTER (it opens the full-bleed RECRUITMENT BAY).

// Close whatever panel/overlay/mode is open so panels don't stack between shots.
// Hardened against an early call (guards document.body) — the cold-boot race could fire this
// before the page finished, which is what threw the old "classList of null" warning.
export const CLOSE = `(() => {
  if (!document.body) return 'no-body';
  // exit REFIT/BUILD mode first (a full-canvas mode, not a #terms panel)
  const rd = document.getElementById('refit-done'); if (rd) { try { rd.click(); } catch {} }
  document.querySelectorAll('.refit-overlay').forEach(o => { try { o.remove(); } catch {} });
  try { document.body.classList.remove('refit-on'); } catch {}
  // Click the REAL close button on every open window so the app's own closeTerm() runs and its
  // internal open{} map clears (nuking #terms.innerHTML leaves that map populated → corrupts the
  // single-vs-cascade placement logic).
  document.querySelectorAll('.term-x, #terms .x, #terms .close, #terms [data-close], .term-close, .panel-close, .win-close, .rb-close, .recruit-close').forEach(b => { try { b.click(); } catch {} });
  // Escape as a backstop for panels that honor it (recruitment bay, etc.)
  ['keydown','keyup'].forEach(type => document.dispatchEvent(new KeyboardEvent(type, { key:'Escape', code:'Escape', keyCode:27, which:27, bubbles:true })));
  return 'closed';
})()`;

// Open a dock panel by a STABLE selector (id or [data-term]); reports NOTFOUND if absent.
export const openSel = (sel, label) => `(() => {
  ${CLOSE};
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return 'NOTFOUND:' + ${JSON.stringify(sel)};
  try { el.click(); } catch (e) { return 'CLICK_ERR:' + e.message; }
  return 'opened:' + ${JSON.stringify(label || sel)};
})()`;

// The notifications panel is intentionally user-owned state, so its rows carry
// wall-clock timestamps and whatever the capture run happened to emit. Normalize
// only the rendered rows for this screenshot frame; the app store is untouched.
export const openStableNotifs = `(() => {
  ${openSel('[data-term="notifs"]', 'NOTIFS')};
  const list = document.querySelector('.nf-list');
  if (list) {
    const rows = [
      ['07:00', 'Station layout saved', 'good'],
      ['07:01', 'NOVA is online - anthropic/claude-3.5-sonnet', 'good'],
      ['07:02', 'Connector "local" connected', 'good'],
      ['07:03', 'saved briefing.md - your agent runs on it now', 'gold'],
      ['07:04', 'routine ran', 'good'],
      ['07:05', 'budget resumed - global cap raised; agents can run again', 'good'],
      ['07:06', 'StarNet is up to date', 'good'],
      ['07:07', 'routine "morning check" scheduled for NOVA', 'good'],
      ['07:08', 'copied the last reply', 'good'],
      ['07:09', 'rewound agent to an earlier restore point', 'warn'],
      ['07:10', 'Connector "local" removed', ''],
      ['07:11', 'first steps complete - you have got the controls', 'gold']
    ];
    list.innerHTML = rows.map(r => '<div class="nf ' + r[2] + '"><span class="ts">[' + r[0] + ']</span> ' + r[1] + '</div>').join('');
  }
  return 'opened:NOTIFS';
})()`;

export const closeOnly = `(() => { ${CLOSE}; return 'reset'; })()`;

// REFIT first-use guide: on a fresh browser profile, build.js showGuide() paints a full-canvas
// "▮ BUILD YOUR STATION" modal (.refit-guide) OVER the canvas. It intercepts every pointer event, so
// synthetic canvas input (CDP Input.dispatchMouseEvent) hits the guide, not the grid. The Truth-Auditor
// prop-place scenario must clear it before any real-mouse placement. Clicking #refit-guide-go marks it
// seen (localStorage) so it never re-shows; remove() is the backstop. Returns the count dismissed.
export const dismissRefitGuide = `(() => {
  let n = 0;
  document.querySelectorAll('.refit-guide').forEach(g => {
    const go = g.querySelector('#refit-guide-go');
    try { if (go) { go.click(); n++; } else { g.remove(); n++; } } catch (_) {}
  });
  return n;
})()`;

// Every key UI state: the floor at rest + each of the 17 dock panels.
export function buildStates() {
  return [
    { name: 'ingame',          drive: closeOnly,                                   wait: 900 },
    // CREW group
    { name: 'crew-agents',     drive: openSel('[data-term="agents"]', 'AGENTS') },
    // ONE recruit door now (#bb-recruit): the old ROSTER/SUMMON split collapsed into a single
    // bay whose class dossier carries both verbs, so one state captures it.
    { name: 'crew-recruit',    drive: openSel('#bb-recruit', 'RECRUIT'),           wait: 1800 },
    { name: 'crew-commander',  drive: openSel('[data-term="commander"]', 'COMMANDER') },
    // WORK group
    { name: 'work-tasks',      drive: openSel('[data-term="tasks"]', 'TASKS') },
    { name: 'work-recipes',    drive: openSel('#bb-missions', 'RECIPES') },
    { name: 'work-routines',   drive: openSel('[data-term="routines"]', 'ROUTINES') },
    // DELIVERABLES (WORK group): the backend-backed run-artifact + Workshop library. Its dock button
    // carries [data-term="deliverables"] (frontend/index.html). Registered as state/work-deliverables in
    // the Atlas; buildStates() previously omitted it, so every sweep false-flagged the entry missing
    // (finding 206d3ceb). The panel fetches GET /api/deliverables on open, so give it a wait to let the
    // async rows/toolbar settle before the enumerator probe runs.
    { name: 'work-deliverables', drive: openSel('[data-term="deliverables"]', 'DELIVERABLES'), wait: 1200 },
    // BUILD group
    { name: 'build-station',   drive: openSel('#bb-build', 'BUILD STATION'),       wait: 2000 },
    { name: 'build-manual',    drive: openSel('[data-term="manual"]', 'MANUAL') },
    { name: 'build-skills',    drive: openSel('[data-term="skills"]', 'SKILLS') },
    { name: 'build-connectors',drive: openSel('[data-term="connectors"]', 'CONNECTORS') },
    // SYSTEM group
    { name: 'sys-settings',    drive: openSel('[data-term="settings"]', 'SETTINGS') },
    { name: 'sys-messaging',   drive: openSel('[data-term="messaging"]', 'MESSAGING') },
    { name: 'sys-rewind',      drive: openSel('[data-term="rewind"]', 'REWIND') },
    { name: 'sys-logbook',     drive: openSel('[data-term="logbook"]', 'LOGBOOK') },
    { name: 'sys-notifs',      drive: openStableNotifs },
  ];
}
