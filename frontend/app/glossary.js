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
    // the WORK vocabulary, each on ONE axis (UX confusion audit 2026-07-15: recipe=WHAT to run,
    // routine=WHEN it runs, task=WHERE live work sits, quest=progress/suggestions — never a place work lives).
    routine:      'a recipe or job put on a schedule (every morning, hourly) — WHEN work runs; manage them in ⏱ ROUTINES.',
    recipe:       'a ready-made job an agent can run right now — WHAT to run; launching one lands it on the ☑ TASK BOARD.',
    task:         'one piece of work in flight — every run you or a recipe starts lives on the ☑ TASK BOARD.',
    quest:        'a suggestion or progress marker from the station — accepting one starts real work; it is never a second to-do list.',
    skill:        'something an agent CAN do — some skills only switch on once their gear is on station.',
    toolset:      'a family of tools you can switch on or off for agents (web, files, terminal…) — the switches live in the TOOLSETS panel.',
    capability:   'the same tool families as TOOLSETS, read-only — what an agent is equipped with right now.',
    connector:    'an outside service you plug IN so agents can use it as a tool (calendar, Slack actions, databases).',
    channel:      'your way IN from a messaging app — connect Telegram/Slack/Discord and talk to your agents from your pocket.',
    autonomy:     'how far an agent may act on its own between your messages — you set the ceiling.',
    initiative:   'whether an agent starts work on its own — the same four rungs everywhere: WAIT, SUGGEST, BUILD, FREE.',
    reach:        'the farthest a single unattended action may go: observe only, write locally, or reach outside.',
    pace:         'how many small unattended jobs an agent may do per day at most.',
    xp:           'experience an agent earns from work you rate well — it levels up as it proves itself.',
    workspace:    'the folder on your machine where an agent’s files land (workspaces/<agent>/).',
    desk:         'an agent’s own workstation — it needs one placed in REFIT before it can take floor work.',
    recruit:      'summon a new agent class onto your crew, or re-spec the agent you already have.',
    slag:         'a post-mortem of a run that ended without producing anything — its cause, and the fix.',
    kudos:        'the good ratings you give an agent’s work — they raise its satisfaction and earn it XP.',
    leash:        'the cap on how many jobs an agent may do on its own before it stops and waits for you.',
    beat:         'one small unattended job the station does while you’re away — the daily limit caps how many.',
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
