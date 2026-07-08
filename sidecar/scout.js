/* sidecar/scout.js — the PURE scout engine (Scout lane 2): the scheduled drafting pass that turns the
   station's learned interests into NEW options in the recruitment bay.

   WHY THIS EXISTS — the bay's dynamic shelves used to mint client-side only: ONE attempt per browser
   session, right after a qualifying run, silently swallowing every rejection. In practice the presets never
   changed. The scout moves the DECISION + STATE server-side: a persisted, restart-safe pass that (a) gates
   honestly (named bindings, every outcome written to a visible ledger — no more silent no-mint), and
   (b) drafts BOTH kinds of option the bay recommends:
     · agent PROSPECTS — the existing pure generator (frontend/app/prospect.js) does directive+validation;
       this module owns only the cadence/dedup/ledger around it.
     · recipe DRAFTS   — new here: a constrained reason-only directive proposing ONE recipe (schema v2
       shape) grounded in the interest evidence, with a HARD parse (params must round-trip the task
       template, tags/category/gear clamp to the real vocab, near-duplicates + denylist rejected).

   PROPOSE-AND-CONFIRM, ALWAYS: a staged draft only ever renders on a shelf with its WHY; the Commander
   accepts (graduates it to a real custom class/recipe frontend-side) or dismisses (denylists its
   fingerprint so an equivalent never re-mints). Nothing auto-joins the roster or the library.

   DETERMINISM SPLIT (mirrors nightshift.js / interests.js): pure transforms over (state, args) with `now`
   injected — no Date.now / Math.random / fs / network — lint-determinism-clean, headless-testable. The
   ambient half (aux-model calls, the durable file, ids, the post-run trigger, routes) lives ONLY in
   sidecar/index.js. Dedup math (fingerprint/jaccard) is inlined from prospect.js/mint-ledger.js — same
   thresholds, no cross-tree import, standalone (the mint-ledger precedent).

   THE STATE (one workspaces JSON, persisted by the host):
     { v, staged: [ { id, kind:'prospect'|'recipe', draft, why, fingerprint, at } ],
       denylist: [fp], ledger: [ { at, kind, outcome, reason, title? } ],
       runsSinceMint, lastMintAt, lastKind,
       context: { customClasses:[], customRecipes:[], worksignalSummary, topRecommendation, at } } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).scout = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATE_VERSION = 1;
  const MINT_EVERY_RUNS = 3;                 // moderate loosening: a mint attempt every ~3 qualifying runs…
  const MINT_MIN_GAP_MS = 30 * 60 * 1000;    // …but never two attempts within half an hour…
  const MAX_LIVE = 3;                        // …and never more than 3 undecided drafts per kind on the shelf
  const LEDGER_CAP = 50;                     // the visible "what the scout tried and why" trail
  const DENYLIST_CAP = 60;                   // dismissed-fingerprint memory (FIFO)
  const KINDS = ['prospect', 'recipe'];

  // recipe vocab — mirrors recipe-catalog schema v2 (recipes.js normalizes the rest on accept).
  const TAG_LANES = ['code', 'research', 'general'];
  const CATEGORIES = ['research', 'code', 'writing', 'planning', 'general', 'developer', 'creator', 'ops'];
  const PARAM_KEY_RE = /^[a-z][a-z0-9_]{0,23}$/;
  const MAX_PARAMS = 3;
  const NAME_MAX = 28, TAGLINE_MAX = 60, BLURB_MAX = 160, TASK_MAX = 600, WHY_MAX = 200;

  const str = (v) => (v == null ? '' : String(v));

  /* ---- dedup math (inlined from prospect.js / reflect.js — same thresholds so behavior matches) ---- */
  function fingerprint(text) {
    const toks = str(text).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    return Array.from(new Set(toks)).sort().join(' ');
  }
  function overlap(fpA, fpB) {
    const a = fpA ? fpA.split(' ') : [], b = fpB ? new Set(fpB.split(' ')) : new Set();
    if (!a.length || !b.size) return 0;
    let hit = 0; for (const t of a) if (b.has(t)) hit++;
    return hit / new Set(a.concat(Array.from(b))).size;
  }

  const USAGE_CAP = 100;   // per-recipe launch counters kept (weakest/oldest evicted past the ceiling)

  function fresh(now) {
    return { v: STATE_VERSION, staged: [], denylist: [], ledger: [], runsSinceMint: 0, lastMintAt: 0, lastKind: '', context: null, usage: { launches: {} } };
  }

  // tolerant hydrate: clamp everything; a corrupt/partial save degrades per-field, never throws.
  function normalize(raw, now) {
    const s = fresh(now);
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.staged)) {
        s.staged = raw.staged.filter(it => it && typeof it === 'object' && str(it.id) && KINDS.indexOf(it.kind) !== -1 && it.draft && typeof it.draft === 'object')
          .slice(0, MAX_LIVE * KINDS.length * 2)
          .map(it => ({ id: str(it.id), kind: it.kind, draft: it.draft, why: str(it.why).slice(0, WHY_MAX), fingerprint: str(it.fingerprint), at: Number.isFinite(it.at) ? Math.floor(it.at) : 0 }));
      }
      if (Array.isArray(raw.denylist)) s.denylist = raw.denylist.map(str).filter(Boolean).slice(-DENYLIST_CAP);
      if (Array.isArray(raw.ledger)) {
        s.ledger = raw.ledger.filter(e => e && typeof e === 'object')
          .slice(-LEDGER_CAP)
          .map(e => ({ at: Number.isFinite(e.at) ? Math.floor(e.at) : 0, kind: str(e.kind), outcome: str(e.outcome), reason: str(e.reason).slice(0, 200), title: str(e.title).slice(0, 60) }));
      }
      if (Number.isFinite(raw.runsSinceMint) && raw.runsSinceMint >= 0) s.runsSinceMint = Math.floor(raw.runsSinceMint);
      if (Number.isFinite(raw.lastMintAt) && raw.lastMintAt >= 0) s.lastMintAt = Math.floor(raw.lastMintAt);
      if (KINDS.indexOf(raw.lastKind) !== -1) s.lastKind = raw.lastKind;
      if (raw.context && typeof raw.context === 'object') s.context = raw.context;
      if (raw.usage && raw.usage.launches && typeof raw.usage.launches === 'object') {
        for (const id of Object.keys(raw.usage.launches).slice(0, USAGE_CAP)) {
          const u = raw.usage.launches[id];
          if (!u || typeof u !== 'object' || !str(id)) continue;
          s.usage.launches[str(id).slice(0, 60)] = {
            name: str(u.name).slice(0, 40),
            n: (Number.isFinite(u.n) && u.n > 0) ? Math.floor(u.n) : 0,
            lastAt: Number.isFinite(u.lastAt) ? Math.floor(u.lastAt) : 0
          };
        }
      }
    }
    return s;
  }

  function noteRun(state, now) {
    const s = normalize(state, now);
    return Object.assign({}, s, { runsSinceMint: s.runsSinceMint + 1 });
  }

  const liveCount = (s, kind) => s.staged.filter(it => it.kind === kind).length;

  /* decide — should a mint attempt fire NOW, and for which kind? Named bindings for the ledger
     (cold → cooldown → gap → full), most "not earned yet" first. warm comes from interests.warm().
     kind selection: the kind with FEWER live drafts wins; tie → alternate away from lastKind. */
  function decide(state, inp) {
    const now = Number(inp && inp.now) || 0;
    const s = normalize(state, now);
    if (!(inp && inp.warm)) return { fire: false, binding: 'cold', kind: null };
    if (s.runsSinceMint < MINT_EVERY_RUNS) return { fire: false, binding: 'cooldown', kind: null };
    if (now - s.lastMintAt < MINT_MIN_GAP_MS) return { fire: false, binding: 'gap', kind: null };
    const open = KINDS.filter(k => liveCount(s, k) < MAX_LIVE);
    if (!open.length) return { fire: false, binding: 'full', kind: null };
    let kind;
    if (open.length === 1) kind = open[0];
    else {
      const byLive = open.slice().sort((a, b) => liveCount(s, a) - liveCount(s, b));
      kind = (liveCount(s, byLive[0]) === liveCount(s, byLive[1]))
        ? (s.lastKind === byLive[0] ? byLive[1] : byLive[0])   // tie → alternate
        : byLive[0];
    }
    return { fire: true, binding: null, kind: kind };
  }

  /* ---- the RECIPE drafting directive (mirrors prospect.js discipline: constrained, evidence-grounded,
     NONE-capable). ctx = { interestsBlock, dossierBlock, activityBlock, existingRecipes:[{name,tagline}],
     gearKeys:[..], launchedOften:[name..] (lane-5 signal, optional) } ---- */
  function buildRecipeDirective(ctx) {
    ctx = ctx || {};
    const lines = [];
    lines.push('You are the station\'s recipe author, drafting ONE new one-tap mission recipe tailored to what the Commander ACTUALLY keeps doing.');
    lines.push('');
    lines.push('WHAT THE STATION HAS LEARNED (real observed interests, with evidence):');
    lines.push(str(ctx.interestsBlock).trim() || '(nothing yet)');
    if (ctx.dossierBlock) { lines.push(''); lines.push('COMMANDER DOSSIER:'); lines.push(str(ctx.dossierBlock).trim()); }
    if (ctx.activityBlock) { lines.push(''); lines.push('RECENT ACTIVITY:'); lines.push(str(ctx.activityBlock).trim()); }
    const existing = (ctx.existingRecipes || []).map(r => '• ' + str(r.name) + ' — ' + str(r.tagline)).join('\n');
    lines.push('');
    lines.push('EXISTING RECIPE LIBRARY (do NOT propose anything an entry here already serves):');
    lines.push(existing || '(none)');
    if (Array.isArray(ctx.launchedOften) && ctx.launchedOften.length) {
      lines.push('RECIPES THE COMMANDER LAUNCHES MOST: ' + ctx.launchedOften.join(', ') + ' (adjacent, deeper takes on these lanes are welcome — restatements are not).');
    }
    lines.push('');
    lines.push('HARD CONSTRAINTS:');
    lines.push('- Propose EXACTLY ONE recipe, serving a SPECIFIC observed interest above — never a generic productivity template.');
    lines.push('- TASK is one imperative directive line the agent will execute, containing a {token} for every PARAM you declare.');
    lines.push('- 1-' + MAX_PARAMS + ' PARAM lines; each is: key | Label | placeholder example. Keys are short lowercase identifiers.');
    lines.push('- TAGS weights use only these lanes: ' + TAG_LANES.join(', ') + '. CATEGORY is one of: ' + CATEGORIES.join(', ') + '.');
    if (Array.isArray(ctx.gearKeys) && ctx.gearKeys.length) lines.push('- GEAR (optional, advisory) only from: ' + ctx.gearKeys.join(', ') + '.');
    lines.push('- WHY must cite the REAL evidence above — the interest and its quote — never a generic pitch.');
    lines.push('- If the library above already serves every observed interest, reply with exactly: NONE');
    lines.push('');
    lines.push('REPLY IN EXACTLY THIS FORMAT (one field per line, PARAM may repeat):');
    lines.push('NAME: <2-4 words>');
    lines.push('EMOJI: <one glyph>');
    lines.push('TAGLINE: <one line, what it is for>');
    lines.push('BLURB: <one sentence, what it does and how it behaves>');
    lines.push('CATEGORY: <one of the allowed categories>');
    lines.push('TAGS: <lane=weight, comma-separated (e.g. research=0.8, general=0.2)>');
    lines.push('GEAR: <comma-separated advisory gear keys, or leave blank>');
    lines.push('PARAM: <key> | <Label> | <placeholder>');
    lines.push('TASK: <the one-line imperative directive with {key} tokens>');
    lines.push('WHY: <one sentence grounding this in the observed interest + evidence>');
    return lines.join('\n');
  }

  /* parseRecipe — parse + VALIDATE HARD. opts = { existingRecipes:[{name,tagline}], denylist:[fp],
     gearKeys:[..], grounding? }. Returns null (invalid), { none:true }, or { draft, why, fingerprint }.
     A draft whose params don't round-trip the task template is BROKEN AT LAUNCH — rejected, never staged.
     `grounding` (optional): the real evidence corpus the WHY must cite (interests block + activity lines) —
     same token-overlap guard as interests.parse, so an invented "why" dies here, never on a shelf. */
  function parseRecipe(text, opts) {
    opts = opts || {};
    const raw = str(text);
    if (/^\s*NONE\s*$/im.test(raw) && !/^\s*NAME\s*:/im.test(raw)) return { none: true };

    // same-line grab as prospect.js (horizontal-whitespace classes so an EMPTY field never swallows the next line).
    const grab = label => { const m = new RegExp('^[^\\S\\r\\n]*' + label + '[^\\S\\r\\n]*:[^\\S\\r\\n]*([^\\r\\n]*?)[^\\S\\r\\n]*$', 'im').exec(raw); return m ? m[1].trim() : ''; };
    const name = grab('NAME').slice(0, NAME_MAX);
    const tagline = grab('TAGLINE').slice(0, TAGLINE_MAX);
    const blurb = grab('BLURB').slice(0, BLURB_MAX);
    const task = grab('TASK').slice(0, TASK_MAX);
    const why = grab('WHY').slice(0, WHY_MAX);
    if (!name || !tagline || !task || !why) return null;   // the load-bearing fields — a partial draft is malformed

    // WHY GROUNDING (mirrors interests.parse's evidence guard): when a grounding corpus is provided, at least
    // one significant WHY token must appear in it — a WHY that cites nothing the station actually observed is
    // an invented pitch, rejected (and ledger-visible via the caller), never staged.
    const grounding = str(opts.grounding).toLowerCase();
    if (grounding) {
      const toks = why.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 4);
      if (toks.length && !toks.some(t => grounding.indexOf(t) !== -1)) return null;
    }

    // params: every PARAM line, validated + capped. key | Label | placeholder.
    const params = [];
    const pRe = /^[^\S\r\n]*PARAM[^\S\r\n]*:[^\S\r\n]*([^\r\n]*?)[^\S\r\n]*$/gim;
    let pm;
    while ((pm = pRe.exec(raw)) !== null) {
      const parts = pm[1].split('|').map(p => p.trim());
      const key = str(parts[0]).toLowerCase();
      if (!PARAM_KEY_RE.test(key)) return null;            // a bad key breaks the launch form — reject the draft
      if (params.some(p => p.key === key)) return null;    // duplicate keys are a broken form too
      params.push({ key: key, label: str(parts[1] || key).slice(0, 40), placeholder: str(parts[2] || '').slice(0, 80) });
      if (params.length > MAX_PARAMS) return null;
    }
    // TEMPLATE ROUND-TRIP: every declared param must appear as {key} in the task, and every {token} in the
    // task must be a declared param — otherwise the launch form and the directive disagree (broken at launch).
    for (const p of params) if (task.indexOf('{' + p.key + '}') === -1) return null;
    const tokens = task.match(/\{([a-z][a-z0-9_]*)\}/gi) || [];
    for (const t of tokens) { const key = t.slice(1, -1).toLowerCase(); if (!params.some(p => p.key === key)) return null; }

    // tags: clamp to the real lanes, weights to (0,1]; none valid → honest general.
    const tags = {};
    for (const kv of grab('TAGS').split(',')) {
      const m = /^\s*([a-z]+)\s*=\s*([0-9.]+)\s*$/i.exec(kv);
      if (!m) continue;
      const lane = m[1].toLowerCase();
      const w = Number(m[2]);
      if (TAG_LANES.indexOf(lane) !== -1 && Number.isFinite(w) && w > 0) tags[lane] = Math.min(1, w);
    }
    if (!Object.keys(tags).length) tags.general = 1;

    const catRaw = grab('CATEGORY').toLowerCase();
    const category = CATEGORIES.indexOf(catRaw) !== -1 ? catRaw : 'general';

    // gear is ADVISORY (never gates) — soft-filter unknowns rather than rejecting the draft over a badge.
    const allowedGear = new Set((opts.gearKeys || []).map(g => str(g).toLowerCase()));
    const gear = grab('GEAR').split(/[,\s]+/).map(g => g.trim().toLowerCase()).filter(g => g && allowedGear.has(g));

    // NEAR-DUPLICATE + DENYLIST guards (same thresholds as prospect.js: 0.6 name+tagline, 0.7 tagline-only).
    const draftFp = fingerprint(name + ' ' + tagline);
    const draftTagFp = fingerprint(tagline);
    for (const fp of (opts.denylist || [])) if (fp && overlap(draftFp, fp) >= 0.6) return null;
    for (const r of (opts.existingRecipes || [])) {
      if (name && r.name && name.toLowerCase() === str(r.name).toLowerCase()) return null;
      const rFp = fingerprint(str(r.name) + ' ' + str(r.tagline));
      if (overlap(draftFp, rFp) >= 0.6) return null;
      if (draftTagFp && overlap(draftTagFp, fingerprint(str(r.tagline))) >= 0.7) return null;
    }

    const emoji = (grab('EMOJI') || '✦').slice(0, 2) || '✦';
    return {
      none: false,
      draft: { name: name, emoji: emoji, tagline: tagline, blurb: blurb, category: category, tags: tags, params: params, task: task, gear: gear, source: 'scout' },
      why: why,
      fingerprint: draftFp
    };
  }

  /* ---- reducers (pure: input never mutated; each returns a NEW state) ---- */

  // ledger append, capped. Every outcome — staged, rejected, none, error, skipped — is recorded, so the
  // scout's activity is INSPECTABLE (the anti-silent-no-mint law of this lane).
  function note(state, entry, opts) {
    const now = Number(opts && opts.now) || 0;
    const s = normalize(state, now);
    const e = { at: now, kind: str(entry && entry.kind), outcome: str(entry && entry.outcome), reason: str(entry && entry.reason).slice(0, 200), title: str(entry && entry.title).slice(0, 60) };
    return Object.assign({}, s, { ledger: s.ledger.concat([e]).slice(-LEDGER_CAP) });
  }

  // stage a validated draft: stamps the mint (counter reset + lastMintAt + lastKind) and appends the item.
  function stage(state, item, opts) {
    const now = Number(opts && opts.now) || 0;
    const s = normalize(state, now);
    if (!item || !str(item.id) || KINDS.indexOf(item.kind) === -1 || !item.draft) return s;
    const staged = s.staged.concat([{ id: str(item.id), kind: item.kind, draft: item.draft, why: str(item.why).slice(0, WHY_MAX), fingerprint: str(item.fingerprint), at: now }]);
    return Object.assign({}, s, { staged: staged, runsSinceMint: 0, lastMintAt: now, lastKind: item.kind });
  }

  // a mint ATTEMPT that produced nothing still spends the cadence (counter + stamp) — the scout tried;
  // it must not hammer the model on every following run. The ledger records why via note().
  function stampAttempt(state, kind, opts) {
    const now = Number(opts && opts.now) || 0;
    const s = normalize(state, now);
    return Object.assign({}, s, { runsSinceMint: 0, lastMintAt: now, lastKind: KINDS.indexOf(kind) !== -1 ? kind : s.lastKind });
  }

  // dismiss: remove the item AND denylist its fingerprint — an equivalent draft never re-mints.
  function dismiss(state, id, opts) {
    const now = Number(opts && opts.now) || 0;
    const s = normalize(state, now);
    const item = s.staged.find(it => it.id === str(id));
    if (!item) return s;
    const denylist = item.fingerprint ? s.denylist.concat([item.fingerprint]).slice(-DENYLIST_CAP) : s.denylist;
    return Object.assign({}, s, { staged: s.staged.filter(it => it.id !== item.id), denylist: denylist });
  }

  // accept: the item graduates (the frontend saves the real custom class/recipe) — just remove it here.
  function accept(state, id, opts) {
    const now = Number(opts && opts.now) || 0;
    const s = normalize(state, now);
    return Object.assign({}, s, { staged: s.staged.filter(it => it.id !== str(id)) });
  }

  // context push (frontend-owned facts the server can't see: custom classes/recipes, worksignal summary,
  // the recruiter's top pick). Bounded hard — this is a hint channel, not a data mirror.
  function setContext(state, ctx, opts) {
    const now = Number(opts && opts.now) || 0;
    const s = normalize(state, now);
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const strip = (arr, cap, f) => (Array.isArray(arr) ? arr.slice(0, cap).map(f).filter(Boolean) : []);
    return Object.assign({}, s, {
      context: {
        customClasses: strip(c.customClasses, 40, x => x && str(x.name) ? { name: str(x.name).slice(0, 40), tagline: str(x.tagline).slice(0, 80) } : null),
        customRecipes: strip(c.customRecipes, 80, x => x && str(x.name) ? { name: str(x.name).slice(0, 40), tagline: str(x.tagline).slice(0, 80) } : null),
        worksignalSummary: str(c.worksignalSummary).slice(0, 200),
        topRecommendation: str(c.topRecommendation).slice(0, 40),
        at: now
      }
    });
  }

  /* ---- engagement telemetry (lane 5): per-recipe launch counters ----
     What the Commander actually LAUNCHES is the strongest engagement signal there is: it feeds the FOR-YOU
     rank (frontend) and the "launches most" hint in the recipe directive. Counters only — no content. */
  function noteLaunch(state, rec, opts) {
    const now = Number(opts && opts.now) || 0;
    const s = normalize(state, now);
    const id = str(rec && rec.id).slice(0, 60);
    if (!id) return s;
    const launches = {};
    for (const k of Object.keys(s.usage.launches)) launches[k] = Object.assign({}, s.usage.launches[k]);
    const cur = launches[id];
    launches[id] = { name: str((rec && rec.name) || (cur && cur.name)).slice(0, 40), n: (cur ? cur.n : 0) + 1, lastAt: now };
    // evict past the ceiling: fewest launches first (ties: oldest lastAt) — a long-lived station keeps its heavy hitters.
    const keys = Object.keys(launches);
    if (keys.length > USAGE_CAP) {
      keys.sort((a, b) => (launches[b].n - launches[a].n) || (launches[b].lastAt - launches[a].lastAt));
      for (const k of keys.slice(USAGE_CAP)) delete launches[k];
    }
    return Object.assign({}, s, { usage: { launches: launches } });
  }
  // the "launches most" names for the recipe directive (top by count, ties newest-first).
  function topLaunched(state, limit) {
    const s = normalize(state, 0);
    return Object.keys(s.usage.launches)
      .map(id => s.usage.launches[id])
      .filter(u => u.n > 0 && u.name)
      .sort((a, b) => (b.n - a.n) || (b.lastAt - a.lastAt))
      .slice(0, Math.max(1, Number(limit) || 5))
      .map(u => u.name);
  }

  return {
    fresh, normalize, noteRun, decide, buildRecipeDirective, parseRecipe,
    note, stage, stampAttempt, dismiss, accept, setContext, noteLaunch, topLaunched,
    fingerprint, overlap,
    KINDS, MINT_EVERY_RUNS, MINT_MIN_GAP_MS, MAX_LIVE, LEDGER_CAP, TAG_LANES, CATEGORIES, USAGE_CAP
  };
});
