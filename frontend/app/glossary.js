/* STARNET — glossary.js : the one place the station explains its own words to a first-minute user.

   A pure term -> one-sentence map, consumed by hint.js (data-hint="<term>" tooltips). Copy law:
   lowercase station voice, eerie-not-cute, one plain sentence a beginner can act on. Every entry
   is grounded in how the term is ACTUALLY used in the code (marketplace.js / autonomy.js / stationui.js
   / returnstore.js) — not an aspirational definition. Keys are lowercased on lookup, so
   data-hint="REFIT" and data-hint="refit" resolve the same entry.

   UMD: a `Glossary` global in the browser; module.exports under node/tests. No DOM, no deps. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Glossary = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // term -> one beginner-facing sentence. Keep each to a single sentence; no jargon inside the definition.
  const TERMS = {
    workstream:   "this agent's own chat thread — switch streams to talk to a different agent.",
    orchestrator: 'the lead agent you talk to first — new agents inherit its model unless you pick another.',
    overseer:     'the station itself — it holds shared gear that any specialist can draw on.',
    refit:        'the station’s build mode — open it from the dock to place desks, furniture, and gear.',
    clearance:    'how hard the agent’s model thinks — more diamonds mean deeper (slower) reasoning.',
    lane:         'the kind of work a class is built for: CODE, RESEARCH, or general OPS.',
    dish:         'the WEB gear — with it on station, an agent can search and fetch live pages.',
    cabinet:      'the FILES gear — with it on station, an agent can read, write, and search your workspace.',
    notebook:     'the MEMORY gear — a durable notebook the agent can save to and recall later.',
    workbench:    'the TERMINAL gear — lets an agent run and test real code (each run asks you first).',
    studio:       'the IMAGES gear — lets an agent generate and read visuals.',
    seed:         'a saved idea you can hand back to an agent later so it picks up right where you left off.',
    drafted:      'written up by the station for you to review — nothing is summoned until you confirm it.',
    sidecar:      'the small local program that actually runs your agents — the app talks to it in the background.',
    routine:      'a job set to run on a schedule (e.g. every morning) instead of only when you ask.',
    recipe:       'a ready-made job an agent can pick up and run in a fresh workstream.',
    skill:        'something an agent CAN do — some skills only switch on once their gear is on station.',
    autonomy:     'how far an agent may act on its own between your messages — you set the ceiling.',
    initiative:   'whether an agent starts work on its own: wait for you, propose, short leash, or free-range.',
    reach:        'the farthest a single unattended action may go: observe only, write locally, or reach outside.',
    pace:         'how many small unattended jobs an agent may do per day at most.',
    xp:           'experience an agent earns from work you rate well — it levels up as it proves itself.',
    workspace:    'the folder on your machine where an agent’s files land (workspaces/<agent>/).',
    desk:         'an agent’s own workstation — it needs one placed in REFIT before it can take floor work.',
    recruit:      'summon a new agent class onto your crew, or re-spec the agent you already have.',
    slag:         'a post-mortem of a run that ended without producing anything — its cause, and the fix.',
    kudos:        'the good ratings you give an agent’s work — they raise its satisfaction and earn it XP.',
    leash:        'the cap on how many jobs an agent may do on its own before it stops and waits for you.',
    'e-stop':     'the emergency stop — it halts every unattended job at once until you re-arm autonomy.',
    'restore point': 'a saved snapshot of an agent’s workspace you can roll it back to.',
    uplink:       'the live link to your local sidecar — full bars while telemetry flows, red when it drops.'
  };

  // lookup: case-insensitive, trims surrounding whitespace. Returns the sentence or null (caller shows nothing).
  function lookup(term) {
    if (term == null) return null;
    const key = String(term).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(TERMS, key) ? TERMS[key] : null;
  }

  function has(term) { return lookup(term) != null; }

  return { TERMS, lookup, has };
});
