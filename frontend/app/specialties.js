/* SKYNET — specialties.js : preset SPECIALTY types for agents — the "what it's FOR" axis.

   Parallel to personas.js (the "how it TALKS" axis). The two compose: a "Witty Researcher"
   is a Researcher specialty wearing the witty persona. A specialty bundles a ready-made
   purpose.md + a tuned operating-manual.md + a recommended persona + a model-tier hint + a few
   starter tasks + an accent suit — so the Commander can stand up a focused specialist in one tap
   instead of authoring the whole dossier by hand.

   Built-ins are FROZEN (the curated catalog). The Commander can also SAVE their current agent as a
   CUSTOM specialty — persisted in localStorage — and re-deploy it later: that is the "marketplace."

   compose(idOrSpec) returns exactly the { purpose, manual } patch that App.applyAgentConfig already
   takes, so DEPLOYING a specialty rides the SAME authoring path as a hand-edited dossier file — no
   second code path, no drift. UMD: a `Specialties` global in the browser, module.exports under node
   (so the registry + custom round-trip are unit-testable without a DOM). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Specialties = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORE_KEY = 'skynet.specialties.v1';   // localStorage home for custom (save-your-own) specialties
  const DEFAULT_ID = 'chief';

  // model-tier hints are ADVISORY only (the real model list is the live OpenRouter catalog) — a chip
  // that nudges the Commander toward the right spend, never a hard requirement.
  const TIERS = Object.freeze({
    reasoning: 'deep reasoning — give it a top-tier model',
    balanced: 'a solid mid-tier model is plenty',
    fast: 'cheap & fast works fine'
  });

  // the interest vocabulary the personalization recommender ranks against (mirrors classify.js getTag).
  // Each spec carries a `tags` weight map over these lanes; the user-affinity engine scores a spec by how
  // well its tags match what the Commander actually works on.
  const TAGS = ['code', 'research', 'general'];

  // keep only the known lanes with a positive weight; an empty/garbage map falls back to the general lane
  // (the catch-all) so every spec is always rankable and never silently scores zero across the board.
  function normTags(t) {
    const out = {}; let sum = 0;
    if (t && typeof t === 'object') for (const k of TAGS) {
      const v = Number(t[k]);
      if (Number.isFinite(v) && v > 0) { out[k] = v; sum += v; }
    }
    return sum > 0 ? out : { general: 1 };
  }
  // derive a tag map for a CUSTOM spec from its own text, using the same classifier the rest of the app uses
  // (Classify is a browser global; under node — where customs aren't authored — it falls back to general).
  function deriveTags(text) {
    if (typeof Classify !== 'undefined' && Classify.getTag) { const tag = Classify.getTag(text); return { [tag]: 1 }; }
    return { general: 1 };
  }

  // normalize + freeze one spec so no caller can mutate the catalog.
  function freezeSpec(s) {
    return Object.freeze({
      id: s.id,
      name: s.name,                                   // role label shown on the card (the agent keeps its own name)
      emoji: s.emoji || '◆',
      tagline: s.tagline || '',
      blurb: s.blurb || '',
      purpose: s.purpose || '',                       // -> purpose.md
      manual: s.manual || '',                         // -> operating-manual.md (standing orders)
      persona: s.persona || 'friendly',              // recommended personaId (the Commander can override)
      model: TIERS[s.model] ? s.model : 'balanced',   // tier KEY (see TIERS); advisory
      accent: s.accent || '#ffaa33',                  // suggested avatar suit
      tags: Object.freeze(normTags(s.tags)),          // interest-lane weights the recommender ranks by
      starters: Object.freeze((s.starters || []).slice()),
      custom: false
    });
  }

  /* ---------- the curated catalog ---------- *
     Each purpose folds into the prompt under "YOUR PURPOSE", each manual under "STANDING ORDERS …
     always follow these"; both are written in the harness voice (real tools, the Commander, do the
     work). Several tie into the station's real subsystems (messaging+cron, Cortex memory, PixelLab). */
  const BUILTINS = Object.freeze([
    {
      id: 'researcher', name: 'Researcher', emoji: '◎', tagline: 'Web research & sourced briefs',
      blurb: 'Digs through the live web, cross-checks sources, and briefs you tightly — answer first, evidence under it.',
      persona: 'direct', model: 'balanced', accent: '#46c8ff',
      tags: { research: 1 },
      purpose: 'Research questions for the Commander and come back with clear, sourced answers. Dig through the live web, cross-check claims across multiple independent sources, and brief the findings tightly — lead with the answer, then the evidence.',
      manual: '- Always cite your sources (link or name them); never present an unsourced claim as fact.\n- Cross-check anything that matters against at least two independent sources before stating it.\n- Lead with the bottom line, then the supporting detail. Flag what is uncertain or contested.\n- If the web turns up nothing solid, say so plainly instead of guessing.',
      starters: ['Brief me on the latest in <topic>', 'Compare <A> vs <B> and recommend one', 'Fact-check this claim: <…>']
    },
    {
      id: 'engineer', name: 'Engineer', emoji: '⌗', tagline: 'Write, debug & ship code',
      blurb: 'Reads the codebase before touching it, makes focused edits, and verifies they actually work.',
      persona: 'direct', model: 'reasoning', accent: '#7df0a0',
      tags: { code: 1 },
      purpose: 'Write, debug, and build software for the Commander. Read the codebase before changing it, make focused edits, verify they work, then report what changed and why.',
      manual: '- Read the surrounding code first; match its style, naming, and structure.\n- Keep diffs minimal and focused — change what the task needs and nothing more.\n- Verify changes (run it / test it) before claiming they work; if you cannot, say so.\n- Explain what you changed and any tradeoffs, briefly.',
      starters: ['Fix this bug: <paste the error>', 'Add <feature> to <file>', 'Refactor <X> for readability']
    },
    {
      id: 'operator', name: 'Operator', emoji: '⚙', tagline: 'Ops, automation & schedules',
      blurb: 'Runs the day-to-day — tasks, deploys, anything on a timer. Keeps things moving and surfaces what needs you.',
      persona: 'calm', model: 'balanced', accent: '#ffb641',
      tags: { general: 0.7, code: 0.3 },
      purpose: 'Run the day-to-day: tasks, ops, automations, and anything on a schedule. Keep things moving, surface what needs attention, and handle the routine so the Commander does not have to.',
      manual: '- Confirm before any irreversible or outward-facing action (sending, deleting, deploying).\n- Prefer reliable, repeatable steps; note anything you automate so it can be audited later.\n- Report status plainly: what ran, what is pending, what failed.\n- Keep a light footprint — never change more than the task asks for.',
      starters: ['Set up a daily check on <thing>', 'Walk me through deploying <X>', 'Track these tasks and remind me']
    },
    {
      id: 'scribe', name: 'Scribe', emoji: '✎', tagline: 'Writing & editing',
      blurb: 'Drafts and edits in your voice — posts, docs, emails. Cuts the filler and makes it land.',
      persona: 'friendly', model: 'balanced', accent: '#e6a0ff',
      tags: { general: 1 },
      purpose: 'Help the Commander write and edit — drafts, docs, posts, emails, anything with words. Match the intended voice, tighten the prose, and make it land.',
      manual: '- Match the Commander\'s voice and the format the piece calls for; ask if it is unclear.\n- Cut filler. Favor clear, concrete language over fluff.\n- Offer one clean draft first, then note alternatives — do not bury the work in options.\n- Preserve meaning when editing; flag anything you would change substantively.',
      starters: ['Draft a <blog post / email> about <…>', 'Tighten this paragraph: <…>', 'Rewrite this in a <warmer / sharper> tone']
    },
    {
      id: 'analyst', name: 'Analyst', emoji: '▦', tagline: 'Data, numbers & spreadsheets',
      blurb: 'Turns data into answers — runs the analysis, builds the sheet, tells you what it actually means.',
      persona: 'direct', model: 'reasoning', accent: '#6cd0ff',
      tags: { research: 0.6, code: 0.4 },
      purpose: 'Turn data into answers for the Commander. Pull numbers apart, run the analysis, build the spreadsheet or chart, and say what it actually means — not just what it says.',
      manual: '- Show your method: where the numbers came from and how you computed them.\n- State assumptions explicitly; flag data that is missing, dirty, or suspect.\n- Lead with the insight, then the supporting figures.\n- Never invent data points — if a number is not known, say so.',
      starters: ['Analyze this dataset: <file>', 'Build a spreadsheet that <…>', 'What story does this data tell?']
    },
    {
      id: 'reviewer', name: 'Reviewer', emoji: '⊗', tagline: 'Adversarial review & QA',
      blurb: 'Stress-tests your work before it ships — hunts bugs, gaps and weak spots, and tells you how to fix them.',
      persona: 'witty', model: 'reasoning', accent: '#ff8f8f',
      tags: { code: 0.7, general: 0.3 },
      purpose: 'Stress-test the Commander\'s work before it ships. Hunt for bugs, gaps, and weak spots — review code, plans, and writing with a skeptical eye — and report exactly what is wrong and how to fix it.',
      manual: '- Be adversarial: actively try to break it, not to approve it.\n- Rank findings by severity; separate real defects from nitpicks.\n- For each issue give the where, the why-it-matters, and a concrete fix.\n- Default to flagging uncertainty rather than waving it through.',
      starters: ['Review this code for bugs: <file>', 'Poke holes in this plan: <…>', 'Proofread and critique this draft']
    },
    {
      id: 'scout', name: 'Scout', emoji: '◈', tagline: 'Watch feeds & alert',
      blurb: 'Keeps watch on the sources you care about and surfaces what matters — fast, no noise. Pairs with messaging + cron.',
      persona: 'direct', model: 'fast', accent: '#46c8ff',
      tags: { research: 0.8, general: 0.2 },
      purpose: 'Keep watch for the Commander. Monitor the sources they care about — news, feeds, inboxes, channels — and surface what matters, fast, without the noise. (Pairs with the station\'s messaging and cron rails.)',
      manual: '- Report signal, not noise: only surface what clears the bar the Commander set.\n- Lead every alert with why it matters and what, if anything, to do about it.\n- Note the source and the time of everything you flag.\n- When nothing is worth raising, a short "all quiet" beats inventing news.',
      starters: ['Watch <source> and alert me on <criteria>', 'Summarize what changed since yesterday', 'Brief me each morning on <topic>']
    },
    {
      id: 'archivist', name: 'Archivist', emoji: '▤', tagline: 'Memory & knowledge',
      blurb: 'Your memory — captures what matters, files it so it is findable, recalls the right context on cue. Pairs with Cortex.',
      persona: 'calm', model: 'balanced', accent: '#c8efff',
      tags: { general: 0.6, research: 0.4 },
      purpose: 'Be the Commander\'s memory. Capture what matters, organize it so it is findable, and recall the right context at the right moment — so nothing important gets lost. (Pairs with the station\'s Cortex memory.)',
      manual: '- Record durable facts and decisions; skip the ephemeral.\n- Organize for retrieval — tag, link, and summarize so future-you finds it fast.\n- When recalling, note when and where a fact was captured; flag anything that may be stale.\n- One fact per note; keep the index clean.',
      starters: ['Remember this: <…>', 'What do we know about <X>?', 'Organize my notes on <project>']
    },
    {
      id: 'designer', name: 'Designer', emoji: '❖', tagline: 'Visuals & assets',
      blurb: 'Turns rough ideas into clean, considered design — UI, layout, assets. Pairs with the PixelLab pipeline.',
      persona: 'friendly', model: 'balanced', accent: '#ffd34a',
      tags: { general: 1 },
      purpose: 'Make things look right for the Commander. Help with UI, layout, visual direction, and assets — turn rough ideas into clean, considered design. (Pairs with the station\'s PixelLab asset pipeline.)',
      manual: '- Ask what it is for and who sees it before designing; form follows function.\n- Keep it clean and consistent; reuse existing patterns and tokens over inventing new ones.\n- Show, do not just tell — mock it up when you can.\n- Explain the reasoning behind each choice, briefly.',
      starters: ['Mock up a <screen / layout> for <…>', 'Improve the look of <this>', 'Generate a <sprite / icon> for <…>']
    },
    {
      id: 'chief', name: 'Chief of Staff', emoji: '✦', tagline: 'Your generalist right hand',
      blurb: 'The all-rounder for whatever comes up — triages, handles the broad asks, breaks big ones into a plan.',
      persona: 'friendly', model: 'balanced', accent: '#ffaa33',
      tags: { general: 1 },
      purpose: 'Be the Commander\'s right hand across whatever comes up. Triage requests, handle the broad ones directly, and break big asks into a plan. The default all-rounder for when the job does not fit a specialist.',
      manual: '- Clarify the goal before diving in when the ask is ambiguous.\n- Break big tasks into steps; handle what you can, flag what needs the Commander.\n- Keep the Commander oriented: what is done, what is next, what is blocked.\n- Be concise by default; go deep only when it is warranted.',
      starters: ['Help me figure out <…>', 'Plan out <project>', 'Just be my all-around assistant']
    },
    {
      id: 'liaison', name: 'Liaison', emoji: '✉', tagline: 'Triage & draft your messages',
      blurb: 'Handles your comms — triages what lands, drafts what goes out, keeps the tone right. Pairs with the station messaging channels.',
      persona: 'friendly', model: 'balanced', accent: '#5fd0e0',
      tags: { general: 1 },
      purpose: 'Run the Commander\'s communications. Triage incoming messages, draft outgoing ones in the right tone for each recipient, and keep threads from slipping through the cracks. (Pairs with the station\'s Telegram / Discord messaging channels.)',
      manual: '- Never send anything outward without the Commander\'s explicit go-ahead — draft, then wait.\n- Match tone to the recipient and the relationship; mirror the Commander\'s own voice when writing as them.\n- Summarize long threads before replying; flag anything urgent or sensitive up front.\n- Keep a clear record of what was sent, to whom, and when.',
      starters: ['Draft a reply to <message>', 'Summarize my unread threads', 'Write a <follow-up / intro> to <person>']
    }
  ].map(freezeSpec));

  /* ---------- custom (save-your-own) specialties ---------- */
  let customs = [];   // plain (mutable) records with custom:true
  function readStore() {
    try {
      if (typeof localStorage === 'undefined') return [];
      const raw = localStorage.getItem(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function writeStore() {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(customs)); } catch (_) {}
  }
  function normCustom(s) {
    const purpose = s.purpose || '', manual = s.manual || '', tagline = s.tagline || '';
    return {
      id: s.id, name: String(s.name || 'My Specialist'),
      emoji: s.emoji || '✦', tagline, blurb: s.blurb || '',
      purpose, manual,
      persona: s.persona || 'friendly', model: TIERS[s.model] ? s.model : 'balanced',
      accent: s.accent || '#ffaa33',
      // a saved custom carries its own ranking tags; pre-tags customs (or older saves) get them classified
      // from their own text — so the Commander's own specialists rank in the feed just like the built-ins.
      tags: normTags(s.tags && Object.keys(s.tags).length ? s.tags : deriveTags(purpose + ' ' + manual + ' ' + tagline)),
      starters: (s.starters || []).slice(), custom: true
    };
  }
  customs = readStore().map(normCustom).filter(s => s.id);   // hydrate on load (drops any malformed record with no id)

  function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function uniqueId(base) {
    let id = base || 'custom-specialty', n = 2;
    while (exists(id)) { id = (base || 'custom-specialty') + '-' + n++; }
    return id;
  }

  /* ---------- public API ---------- */
  function builtins() { return BUILTINS.slice(); }
  function customList() { return customs.map(c => Object.assign({}, c)); }   // copies — callers never hold a live ref
  function list() { return BUILTINS.concat(customList()); }
  function get(id) { return BUILTINS.find(b => b.id === id) || customs.find(c => c.id === id) || null; }
  function exists(id) { return !!get(id); }

  // the EXACT patch App.applyAgentConfig consumes — the single deploy path (dossier edits use the same).
  function compose(idOrSpec) {
    const s = typeof idOrSpec === 'string' ? get(idOrSpec) : idOrSpec;
    if (!s) return null;
    return { purpose: s.purpose || '', manual: s.manual || '' };
  }

  // build a draft custom spec from a LIVE agent's docs — the "save current agent as a specialty" capture.
  function fromAgent(agent, meta) {
    meta = meta || {};
    const d = (agent && agent.docs) || {};
    const baseName = (agent && agent.name) ? (agent.name.charAt(0) + agent.name.slice(1).toLowerCase()) : 'My Specialist';
    return {
      name: meta.name || baseName,
      emoji: meta.emoji || '✦',
      tagline: meta.tagline || ('Saved from ' + ((agent && agent.name) || 'an agent')),
      blurb: meta.blurb || '',
      purpose: (typeof d.purpose === 'string' && d.purpose) || (agent && agent.purpose) || '',
      manual: (typeof d.manual === 'string' && d.manual) || '',
      persona: (agent && agent.personaId) || 'friendly',
      accent: (agent && agent.color) || '#ffaa33',
      model: 'balanced',
      starters: []
    };
  }

  // upsert a custom specialty (assigns a unique custom-<slug> id on first save). Returns the saved record.
  function saveCustom(spec) {
    if (!spec || !String(spec.name || '').trim()) throw new Error('a specialty needs a name');
    const isExistingCustom = spec.id && customs.some(c => c.id === spec.id);
    const rec = normCustom(spec);
    rec.id = isExistingCustom ? spec.id : uniqueId('custom-' + (slugify(spec.name) || 'specialty'));
    const idx = customs.findIndex(c => c.id === rec.id);
    if (idx >= 0) customs[idx] = rec; else customs.push(rec);
    writeStore();
    return Object.assign({}, rec);
  }

  function removeCustom(id) {
    const before = customs.length;
    customs = customs.filter(c => c.id !== id);
    const removed = customs.length !== before;
    if (removed) writeStore();
    return removed;
  }

  function tierNote(idOrSpec) {
    const s = typeof idOrSpec === 'string' ? get(idOrSpec) : idOrSpec;
    return (s && TIERS[s.model]) || TIERS.balanced;
  }

  return {
    TIERS, DEFAULT_ID,
    list, builtins, customs: customList, get, exists,
    compose, fromAgent, saveCustom, removeCustom, tierNote
  };
});
