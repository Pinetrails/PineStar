/* STARNET — recipes.js : THE RECIPE / MISSION LIBRARY — ready-made, parameterized job templates.

   The sibling of specialties.js. A SPECIALTY answers "who should my agent BE" (its purpose + standing
   orders); a RECIPE answers "what should my agent DO right now" — a one-tap mission like "morning research
   brief on {topic}" or "review {target} for bugs". Each recipe carries a tiny param form + a directive
   TEMPLATE; filling the params and launching it opens a fresh workstream and sends the agent that directive.

   Built-ins are a FROZEN curated catalog. The Commander can also save their own (persisted in localStorage,
   the same marketplace pattern as custom specialties) — the substrate the Phase-3 "auto-mint a recipe from
   what you keep asking for" moat move writes into.

   fillTask(idOrRecipe, values) -> the directive string the agent receives (params substituted). It is THE
   single launch primitive — pure + deterministic + node-testable, the recipe analogue of Specialties.compose.
   The app's launchRecipe() takes that string, mints a workstream, and Chat.send()s it (which classifies it as
   a real task directive, so the agent walks to the workstation and works — and the send folds the recipe's
   interest tag into the personalization profile, so launching recipes sharpens future recommendations).

   Recipes carry `tags` (interest-lane weights over the SAME {code|research|general} vocabulary as specialties)
   so the personalization recommender ranks them in the bay's "RECOMMENDED FOR YOU" shelf with no engine change.

   UMD-light: a `Recipes` global in the browser, module.exports under node (so the registry + the launch
   primitives are unit-testable without a DOM). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Recipes = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORE_KEY = 'starnet.recipes.v2';        // localStorage home for custom (save-your-own) recipes (schema v2)
  const STORE_KEY_V1 = 'starnet.recipes.v1';     // legacy v1 home — read once + migrated forward, then left in place

  // the interest vocabulary the personalization recommender ranks against (mirrors classify.js getTag and
  // specialties.js) — a recipe's `tags` map weights these lanes so it ranks honestly in the same feed.
  const TAGS = ['code', 'research', 'general'];

  // ---- schema v2 vocabularies (all ADVISORY — a recipe NEVER gates execution) ----
  // GEAR = the capability objectTypes a use case draws on, same vocabulary as the skills catalog `requires`
  // (dish=web, cabinet=files, notebook=memory, workbench=terminal, studio=images, computer, connector). A recipe
  // renders a WANT badge for gear the station lacks; it never blocks the launch (sandbox/no-gating law).
  const GEAR_TYPES = ['dish', 'cabinet', 'notebook', 'workbench', 'studio', 'computer', 'connector'];
  // the SUGGESTED-cadence ids a recipe may carry (mirrors autojobs.js CADENCES). null = one-shot by nature.
  const CADENCES = ['morning', 'weekly', 'sixhourly', 'hourly'];
  // browse buckets for the marketplace category rail (R6 discovery front: developer / research / creator / ops /
  // general). The R4 persona catalog (dev.js / creator.js / ops.js) authors 'developer'/'creator'/'ops' — they
  // MUST be known buckets or normCategory collapses them to 'general' and the rail can't group them. 'code',
  // 'writing' and 'planning' stay valid legacy aliases (older customs) that the rail maps into developer/general.
  // 'general' is the catch-all fallback. Additive only — no bucket is ever renamed or removed.
  const CATEGORIES = ['developer', 'research', 'creator', 'ops', 'general', 'code', 'writing', 'planning'];
  // provenance: where a recipe came from. 'builtin' = curated; 'custom' = hand-authored; 'fork' = tweaked from another.
  const SOURCES = ['builtin', 'custom', 'fork'];

  // keep only the known gear objectTypes, de-duped, order preserved. Garbage → []. Advisory list, never a gate.
  function normGear(arr) {
    const seen = {}, out = [];
    (Array.isArray(arr) ? arr : []).forEach(g => {
      const t = String(g == null ? '' : g).trim();
      if (t && GEAR_TYPES.indexOf(t) >= 0 && !seen[t]) { seen[t] = true; out.push(t); }
    });
    return out;
  }
  // keep only non-empty string skill slugs, de-duped, order preserved.
  function normSkills(arr) {
    const seen = {}, out = [];
    (Array.isArray(arr) ? arr : []).forEach(s => {
      const t = String(s == null ? '' : s).trim();
      if (t && !seen[t]) { seen[t] = true; out.push(t); }
    });
    return out;
  }
  // a valid suggested cadence id, else null (null = one-shot; never a bogus id the routine picker can't resolve).
  function normCadence(c) { const t = String(c == null ? '' : c).trim(); return CADENCES.indexOf(t) >= 0 ? t : null; }
  // a known category, else 'general' (every recipe is always browsable under some bucket).
  function normCategory(c) { const t = String(c == null ? '' : c).trim(); return CATEGORIES.indexOf(t) >= 0 ? t : 'general'; }
  // a known source, else the supplied fallback ('builtin' for the catalog, 'custom' for a save-your-own).
  function normSource(s, fallback) { const t = String(s == null ? '' : s).trim(); return SOURCES.indexOf(t) >= 0 ? t : fallback; }

  // keep only the known lanes with a positive weight; an empty/garbage map falls back to the general lane
  // (the catch-all) so every recipe is always rankable and never silently scores zero across the board.
  function normTags(t) {
    const out = {}; let sum = 0;
    if (t && typeof t === 'object') for (const k of TAGS) {
      const v = Number(t[k]);
      if (Number.isFinite(v) && v > 0) { out[k] = v; sum += v; }
    }
    return sum > 0 ? out : { general: 1 };
  }
  // derive a tag map for a CUSTOM recipe from its own text, using the same classifier the rest of the app uses
  // (Classify is a browser global; under node — where customs aren't authored — it falls back to general).
  function deriveTags(text) {
    if (typeof Classify !== 'undefined' && Classify.getTag) { const tag = Classify.getTag(text); return { [tag]: 1 }; }
    return { general: 1 };
  }

  // normalize + freeze one param descriptor ({ key, label, placeholder, required, default }). A param with no
  // key is dropped by the caller (filter on key). default is the value substituted when an optional field is
  // left blank; required params have no default (the UI blocks launch until they're filled).
  function freezeParam(p) {
    return Object.freeze({
      key: String(p.key),
      label: p.label || p.key,
      placeholder: p.placeholder || '',
      required: p.required !== false,                 // params are required by default; opt out with required:false
      default: typeof p.default === 'string' ? p.default : ''
    });
  }
  function normParams(arr) {
    return (Array.isArray(arr) ? arr : [])
      .filter(p => p && p.key != null && String(p.key).length)
      .map(freezeParam);
  }

  // TASK BRIEF v2 — a recipe's declared MATERIAL decisions, settled by one tap at launch (or aimed at mid-run).
  // dimension must be one of the taskbrief-policy decision dimensions — mirrored here because this browser module
  // never requires sidecar code; the taskintent test pins the two lists together. Malformed entries drop silently
  // (author error is never a crash); a recipe without valid intake simply has none and launches exactly as before.
  const INTAKE_DIMENSIONS = { objective: 1, audience: 1, deliverable: 1, scope: 1, constraints: 1, sources: 1, acceptance: 1, safety: 1 };
  function normIntake(arr) {
    return Object.freeze((Array.isArray(arr) ? arr : []).map(e => {
      if (!e || typeof e !== 'object') return null;
      const dimension = String(e.dimension || '').toLowerCase();
      const question = String(e.question || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const options = (Array.isArray(e.options) ? e.options : []).map(x => String(x == null ? '' : x).trim().slice(0, 72)).filter(Boolean).slice(0, 3);
      const recommended = String(e.recommended || '').trim().slice(0, 72);
      const reason = String(e.reason || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!INTAKE_DIMENSIONS[dimension] || !question || options.length < 2) return null;
      if (!recommended || !options.some(o => o.toLowerCase() === recommended.toLowerCase())) return null;
      return Object.freeze({ dimension, question, options: Object.freeze(options), recommended, reason });
    }).filter(Boolean).slice(0, 3));
  }

  // humanize a param key into a form label: snake_case / camelCase -> Title-cased words ('look_back' -> 'Look Back').
  // (Tokens are \w+ — see the fillTask/paramsFromTemplate regex — so hyphens never reach here.)
  function humanize(key) {
    return String(key || '')
      .replace(/_+/g, ' ')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // acronym boundary: 'HTTPStatus' -> 'HTTP Status'
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')       // camelCase boundary: 'lookBack' -> 'look Back'
      .trim()
      .replace(/\b\w/g, c => c.toUpperCase());       // Title-Case each word ('look_back' -> 'Look Back')
  }
  // derive the param form from a task TEMPLATE: each DISTINCT {token} becomes a required text input (humanized
  // label). This is how an AUTHORED custom recipe gets its inputs — the template IS the spec, so the Commander
  // only writes the directive and the blanks fall out of it. A template with no tokens yields a one-tap mission.
  function paramsFromTemplate(task) {
    const seen = {}, out = [];
    const re = /\{(\w+)\}/g; let m;
    while ((m = re.exec(String(task || ''))) !== null) {
      const key = m[1];
      if (seen[key]) continue;
      seen[key] = true;
      out.push({ key: key, label: humanize(key) || key, placeholder: '', required: true });   // never a blank label
    }
    // keep every launch-form field identifiable: if two distinct tokens humanize to the SAME label
    // ({look_back} vs {lookBack}, {topic} vs {Topic}), append the raw key so they can be told apart.
    const counts = {};
    out.forEach(p => { counts[p.label] = (counts[p.label] || 0) + 1; });
    out.forEach(p => { if (counts[p.label] > 1) p.label = p.label + ' (' + p.key + ')'; });
    return out;
  }

  // normalize + freeze one recipe so no caller can mutate the catalog (deep: outer + tags + params).
  function freezeRecipe(r) {
    return Object.freeze({
      id: r.id,
      name: r.name,
      emoji: r.emoji || '▸',
      tagline: r.tagline || '',
      blurb: r.blurb || '',
      accent: r.accent || '#7bc88a',
      tags: Object.freeze(normTags(r.tags)),          // interest-lane weights the recommender ranks by
      params: Object.freeze(normParams(r.params)),    // the param form: [{ key, label, placeholder, required, default }]
      task: r.task || '',                             // the directive TEMPLATE; {key} tokens get param values
      // ---- schema v2 (all ADVISORY; never gate execution) ----
      intake: normIntake(r.intake),                   // TASK BRIEF v2: material decisions offered as one-tap chips at launch
      gear: Object.freeze(normGear(r.gear)),          // capability objectTypes this use case draws on (WANT badge)
      skills: Object.freeze(normSkills(r.skills)),    // bundled-skill references (pairs-with hints)
      cadence: normCadence(r.cadence),                // suggested cadence id, or null (one-shot by nature)
      category: normCategory(r.category),             // browse bucket
      source: normSource(r.source, 'builtin'),        // provenance
      forkedFrom: r.forkedFrom != null ? String(r.forkedFrom) : null,
      sourceRunId: r.sourceRunId != null ? String(r.sourceRunId) : null,   // R5: the interactive run this was bottled from (null for the catalog)
      custom: false
    });
  }

  /* ---------- the curated catalog ---------- *
     The built-in records are DATA now, authored in recipe-catalog/ (core.js today; persona files under R4). We
     read the aggregate (recipe-catalog/index.js) and freeze each here — the same freeze pass every built-in went
     through when they lived inline, so nothing downstream can tell the difference. Under node the module requires
     the catalog; in the browser it's the `RecipeCatalog` global set by recipe-catalog/index.js (loaded first).
     Fallback [] keeps recipes.js from throwing if the catalog is somehow unavailable (empty library, never a crash). */
  function loadCatalog() {
    if (typeof require === 'function' && typeof module !== 'undefined') {
      try { const c = require('./recipe-catalog/index.js'); return Array.isArray(c) ? c : []; } catch (_) { return []; }
    }
    const g = (typeof RecipeCatalog !== 'undefined') ? RecipeCatalog : null;
    return Array.isArray(g) ? g : [];
  }
  const BUILTINS = Object.freeze(loadCatalog().map(freezeRecipe));

  /* ---------- custom (save-your-own) recipes ---------- */
  let customs = [];   // plain (mutable) records with custom:true
  // read one localStorage key as an array (tolerant: missing/garbage -> []).
  function readKey(key) {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(key);
      if (raw == null) return null;
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  // migrate the v1 custom store forward to v2 ONCE. The record shape is a strict superset (v2 only ADDS
  // gear/skills/cadence/category/source/forkedFrom), so migration is: read v1 rows, hand them to normCustom
  // (which fills v2 defaults — normSource(...,'custom') stamps provenance, category derives from tags), and
  // persist under the v2 key. NEVER loses a user recipe: we only migrate if v2 is absent AND v1 has rows, and
  // we leave the v1 key untouched (a belt-and-braces fallback if a downgrade ever re-reads it).
  function readStore() {
    const v2 = readKey(STORE_KEY);
    if (v2 != null) return v2;                       // v2 already exists (even if empty) — authoritative
    const v1 = readKey(STORE_KEY_V1);
    if (v1 && v1.length) {                           // first run since the v2 upgrade with real v1 recipes
      try {
        const migrated = v1.map(normCustom).filter(r => r.id);
        if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(migrated));
      } catch (_) {}
      return v1;                                     // hydrate from v1 this run; the write above persists v2
    }
    return [];
  }
  function writeStore() {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(customs)); } catch (_) {}
  }
  function normCustom(r) {
    const name = String(r.name || 'My Recipe');
    const tagline = r.tagline || '', task = r.task || '';
    return {
      id: r.id, name,
      emoji: r.emoji || '▸', tagline, blurb: r.blurb || '',
      accent: r.accent || '#7bc88a',
      // a saved custom carries its own ranking tags; pre-tags customs (or older saves) get them classified
      // from their own text — so the Commander's own recipes rank in the feed just like the built-ins.
      tags: normTags(r.tags && Object.keys(r.tags).length ? r.tags : deriveTags(name + ' ' + tagline + ' ' + task)),
      // an authored custom supplies only the task TEMPLATE — derive its inputs from the {tokens} when no usable
      // params given. Check the NORMALIZED result (not the raw length) so a keyless/garbage params array from a
      // hand-edited or corrupted import still falls through to template derivation instead of shipping ungated.
      params: (function () { const np = normParams(r.params); return np.length ? np : normParams(paramsFromTemplate(task)); })(),
      task,
      // ---- schema v2 (all ADVISORY; never gate execution) ----
      gear: normGear(r.gear),                         // capability objectTypes this custom draws on
      skills: normSkills(r.skills),                   // bundled-skill references
      cadence: normCadence(r.cadence),                // suggested cadence id (for MAKE ROUTINE), or null
      // a v1 record (or a hand-authored save) carries no category → derive one from its dominant ranking lane, so
      // it still lands in a browse bucket. code→code, research→research, general→general (the catch-all).
      category: normCategory(r.category || dominantCategory(r.tags && Object.keys(r.tags).length ? r.tags : deriveTags(name + ' ' + tagline + ' ' + task))),
      // provenance: a TWEAK mints source:'fork' + forkedFrom; a hand-authored save is 'custom'. A v1 record has
      // neither field → normSource falls back to 'custom'. forkedFrom is only meaningful on a fork.
      source: normSource(r.source, 'custom'),
      forkedFrom: r.forkedFrom != null ? String(r.forkedFrom) : null,
      // R5 "Bottle a run": a custom minted from a completed interactive run carries that run's id (the agent-skill
      // sourceRunId pattern) — honest provenance for a bottled recipe. A hand-authored / forked save leaves it null.
      sourceRunId: r.sourceRunId != null ? String(r.sourceRunId) : null,
      custom: true,
      // G3a seed callouts: a recipe the AGENT authored from an observed pattern (seedstore.save) carries this
      // durable flag, so a later pitch/suggestion/digest that reuses it can CREDIT the Commander's saved seed.
      // A hand-authored save-your-own recipe leaves it false — only agent-minted seeds get the callout.
      seedborn: !!r.seedborn
    };
  }
  // the browse category implied by a tag map: the highest-weighted known lane, or 'general'. code/research map
  // 1:1 to their category bucket; anything else falls to general (writing/planning are author-set, not derived).
  function dominantCategory(tags) {
    if (!tags || typeof tags !== 'object') return 'general';
    let best = null, bestW = 0;
    for (const k of TAGS) { const w = Number(tags[k]) || 0; if (w > bestW) { bestW = w; best = k; } }
    return best === 'code' ? 'code' : best === 'research' ? 'research' : 'general';
  }
  customs = readStore().map(normCustom).filter(r => r.id);   // hydrate on load (drops any malformed record with no id)

  function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function uniqueId(base) {
    let id = base || 'custom-recipe', n = 2;
    while (exists(id)) { id = (base || 'custom-recipe') + '-' + n++; }
    return id;
  }

  /* ---------- public API ---------- */
  function builtins() { return BUILTINS.slice(); }
  function customList() { return customs.map(c => Object.assign({}, c)); }   // copies — callers never hold a live ref
  function list() { return BUILTINS.concat(customList()); }
  function get(id) { return BUILTINS.find(b => b.id === id) || customs.find(c => c.id === id) || null; }
  function exists(id) { return !!get(id); }

  // the param keys a recipe still needs before it can launch (required + still blank). The launch UI blocks
  // on a non-empty result; node-testable so the gate can't silently drift from the template.
  function requiredMissing(idOrRecipe, values) {
    const r = typeof idOrRecipe === 'string' ? get(idOrRecipe) : idOrRecipe;
    if (!r || !r.params) return [];
    const v = values || {};
    return r.params
      .filter(p => p.required && !(typeof v[p.key] === 'string' && v[p.key].trim()))
      .map(p => p.key);
  }

  // THE launch primitive: substitute the param values into the recipe's directive template and return the
  // string the agent receives. Returns null for an unknown id/recipe. The recipe analogue of Specialties.compose
  // — the single, no-drift launch path. A FILLED value is inserted VERBATIM, so pasted code / logs / indentation
  // / aligned tables survive untouched (the agent must run exactly what the Commander supplied). A blank optional
  // falls back to its param default; only when a token resolves to nothing do we drop the seam whitespace it
  // would otherwise leave behind — and that trim only ever touches the LITERAL template segment, never user text.
  // Tokens that aren't params of this recipe are left as-is (author error, never a crash).
  function fillTask(idOrRecipe, values) {
    const r = typeof idOrRecipe === 'string' ? get(idOrRecipe) : idOrRecipe;
    if (!r) return null;
    const v = values || {};
    const byKey = {};
    (r.params || []).forEach(p => { byKey[p.key] = p; });
    const tmpl = String(r.task || '');
    const re = /\{(\w+)\}/g;
    let out = '', cursor = 0, m;
    while ((m = re.exec(tmpl)) !== null) {
      let literal = tmpl.slice(cursor, m.index);
      const key = m[1];
      cursor = m.index + m[0].length;
      if (!Object.prototype.hasOwnProperty.call(byKey, key)) { out += literal + m[0]; continue; }   // foreign token → leave as-is
      const val = (typeof v[key] === 'string' && v[key].trim()) ? v[key] : (byKey[key].default || '');
      if (!val) literal = literal.replace(/[ \t]+$/, '');   // gone token → close the gap (literal segment only)
      out += literal + val;
    }
    out += tmpl.slice(cursor);
    out = out.trim();
    // TASK BRIEF v2: launch-time intake decisions ride the directive ITSELF — never a new run-body field
    // (handleRun whitelists body fields). values.__intake maps dimension -> the tapped answer; a skipped
    // decision says nothing (the agent resolves or asks per the task-context doctrine).
    const intake = v.__intake && typeof v.__intake === 'object' ? v.__intake : null;
    if (out && intake && r.intake && r.intake.length) {
      const lines = r.intake
        .filter(e => typeof intake[e.dimension] === 'string' && intake[e.dimension].trim())
        .map(e => '- ' + e.dimension + ': ' + intake[e.dimension].trim().slice(0, 72));
      if (lines.length) out += '\n\nDecisions (chosen at launch — treat these as answered; do not re-ask them):\n' + lines.join('\n');
    }
    return out;
  }

  // build a DRAFT custom recipe from a launched one (P3 "save what you keep asking for" seam). Returns a plain
  // draft (no id, custom not set) for saveCustom — mirrors Specialties.fromAgent. Carries the v2 authoring fields
  // through so a caller (e.g. the TWEAK editor) can prefill every picker.
  function draft(over) {
    over = over || {};
    return {
      name: over.name || 'My Recipe',
      emoji: over.emoji || '▸',
      tagline: over.tagline || '',
      blurb: over.blurb || '',
      accent: over.accent || '#7bc88a',
      tags: over.tags || null,
      params: over.params || [],
      task: over.task || '',
      gear: Array.isArray(over.gear) ? over.gear.slice() : [],
      skills: Array.isArray(over.skills) ? over.skills.slice() : [],
      cadence: over.cadence != null ? over.cadence : null,
      category: over.category || null,
      source: over.source || null,
      forkedFrom: over.forkedFrom != null ? over.forkedFrom : null,
      sourceRunId: over.sourceRunId != null ? over.sourceRunId : null,   // R5: carried through so a bottled run keeps its provenance on save
      seedborn: !!over.seedborn   // carried through so an agent-authored seed keeps its provenance on save
    };
  }

  // FORK a recipe (R2 TWEAK): produce a DRAFT prefilled from an existing recipe's authoring surface, stamped
  // source:'fork' + forkedFrom:<id>. The draft has NO id (saveCustom mints a fresh custom-recipe-<slug>), so the
  // original — builtin OR custom — is never touched. Every editable field (name/emoji/params/task/gear/cadence/
  // category) is copied so the editor opens fully populated; the caller adjusts and saves a new custom recipe.
  // Returns null for an unknown id. The name gets a distinguishing suffix so the fork doesn't look like a dupe.
  function forkFrom(idOrRecipe) {
    const r = typeof idOrRecipe === 'string' ? get(idOrRecipe) : idOrRecipe;
    if (!r) return null;
    return draft({
      name: (r.name || 'Recipe') + ' (my version)',
      emoji: r.emoji, tagline: r.tagline, blurb: r.blurb, accent: r.accent,
      // copy params as plain objects (the source's are frozen); the editor mutates these freely.
      params: (r.params || []).map(p => ({ key: p.key, label: p.label, placeholder: p.placeholder, required: p.required, default: p.default })),
      task: r.task,
      gear: (r.gear || []).slice(), skills: (r.skills || []).slice(),
      cadence: r.cadence || null, category: r.category || null,
      source: 'fork', forkedFrom: r.id
    });
  }

  /* R5 "Bottle a run" — mint a DRAFT custom recipe from a completed interactive run's DIRECTIVE. Pure +
     deterministic + node-testable (the beat's decide-half lives in bottlestore.js; this is its templating half).
     Agent-side templating is out of scope, so we derive everything with honest heuristics:
       • NAME   — the first few meaningful words of the directive, Title-Cased (stopwords trimmed off the front).
       • TASK   — the directive VERBATIM, except obvious parameter candidates are wrapped in {tokens} so the R2
                  editor's paramsFromTemplate() surfaces them as fill-ins. Zero candidates is fine — a one-tap recipe.
       • PARAMS — derived from those {tokens} (so the editor opens with the fill-in grid pre-populated).
     Parameter candidates (kept SIMPLE + honest): "double-quoted"/'single-quoted' strings and http(s) URLs. Each
     distinct candidate becomes one param, keyed topic/topic2/… (quotes) or url/url2/… (links). We NEVER invent a
     value the user didn't type; a directive with none yields a faithful one-tap recipe. The draft is unsaved
     (no id, custom not set) and stamped source:'custom' + sourceRunId — the caller opens the R2 editor on it and
     the user confirms/edits/saves. Returns null for an empty/whitespace directive (nothing real to bottle). */
  const NAME_STOP = { the: 1, a: 1, an: 1, please: 1, kindly: 1, could: 1, can: 1, you: 1, i: 1, we: 1, let: 1, lets: 1, "let's": 1, my: 1, our: 1, this: 1, that: 1, go: 1, now: 1 };
  function deriveName(directive) {
    // first line only (a multi-line directive names off its headline), words → drop leading stopwords → take up to 5.
    const firstLine = String(directive || '').split(/\r?\n/)[0] || '';
    const words = firstLine.replace(/[`"'*_>#]/g, ' ').split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && NAME_STOP[words[i].toLowerCase().replace(/[^a-z']/g, '')]) i++;
    const picked = words.slice(i, i + 5).map(w => w.replace(/[^\w'-]+$/, ''));   // trim trailing punctuation
    const name = picked.join(' ').trim();
    if (!name) return 'My Recipe';
    return name.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 48);
  }
  function mintFromRun(directive, opts) {
    const text = String(directive == null ? '' : directive);
    if (!text.trim()) return null;                    // no real directive → nothing honest to bottle
    opts = opts || {};
    // find parameter candidates in ORDER of appearance, de-duped by their literal value. Quoted strings first
    // (topic-shaped), then bare URLs (url-shaped). We wrap each in a {token} in the task template.
    const params = [];                                // { key, raw, label }
    const seen = {};
    let quoteN = 0, urlN = 0;
    // quoted strings: "…" or '…' (non-empty, no embedded newline). The captured inner value is the substitution.
    const QUOTE_RE = /"([^"\n]+)"|'([^'\n]+)'/g;
    // bare URLs not already inside quotes (those are handled above; a quoted URL becomes a topic param, fine).
    const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/g;
    let out = text, m;
    // pass 1 — quotes. Rebuild the string so replacements don't shift subsequent match indices.
    let rebuilt = '', cursor = 0;
    while ((m = QUOTE_RE.exec(text)) !== null) {
      const inner = (m[1] != null ? m[1] : m[2]);
      rebuilt += text.slice(cursor, m.index);
      cursor = m.index + m[0].length;
      if (Object.prototype.hasOwnProperty.call(seen, inner)) { rebuilt += '{' + seen[inner] + '}'; continue; }
      const key = quoteN === 0 ? 'topic' : 'topic' + (quoteN + 1); quoteN++;
      seen[inner] = key;
      params.push({ key: key, raw: inner, label: humanize(key) });
      rebuilt += '{' + key + '}';
    }
    rebuilt += text.slice(cursor);
    out = rebuilt;
    // pass 2 — URLs, over the quote-substituted string (so a quoted URL isn't double-wrapped).
    rebuilt = ''; cursor = 0;
    while ((m = URL_RE.exec(out)) !== null) {
      const raw = m[0];
      rebuilt += out.slice(cursor, m.index);
      cursor = m.index + m[0].length;
      if (Object.prototype.hasOwnProperty.call(seen, raw)) { rebuilt += '{' + seen[raw] + '}'; continue; }
      const key = urlN === 0 ? 'url' : 'url' + (urlN + 1); urlN++;
      seen[raw] = key;
      params.push({ key: key, raw: raw, label: humanize(key) });
      rebuilt += '{' + key + '}';
    }
    rebuilt += out.slice(cursor);
    const task = rebuilt.trim();
    return draft({
      name: deriveName(text),
      emoji: '✦',
      task: task,
      // fill-in grid pre-populated from the detected candidates (placeholder = the value the user actually typed,
      // so the editor shows a concrete example). Empty → a one-tap recipe (paramsFromTemplate finds no tokens).
      params: params.map(p => ({ key: p.key, label: p.label, placeholder: p.raw, required: true })),
      source: 'custom',
      sourceRunId: opts.runId != null ? String(opts.runId) : null
    });
  }

  // upsert a custom recipe (assigns a unique custom-recipe-<slug> id on first save). Returns the saved record.
  function saveCustom(recipe) {
    if (!recipe || !String(recipe.name || '').trim()) throw new Error('a recipe needs a name');
    const isExistingCustom = recipe.id && customs.some(c => c.id === recipe.id);
    const rec = normCustom(recipe);
    // mint under a custom-recipe- prefix so a mission id can never collide with a custom SPECIALTY (custom-<slug>),
    // which share the bay's preview-state map; specialties mint custom-<slug>, missions custom-recipe-<slug>.
    rec.id = isExistingCustom ? recipe.id : uniqueId('custom-recipe-' + (slugify(recipe.name) || 'mission'));
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

  // R3 soft-warning heuristic: does this recipe's directive template imply an OUTBOUND action (a send / post /
  // message / publish / file write / commit)? Scheduling such a recipe as an UNATTENDED routine deserves a warn
  // line (never a block — law 1). Pure string scan over the task template; a false positive just shows a warning.
  const OUTBOUND_RE = /\b(send|reply|post|publish|message|email|e-mail|dm|tweet|commit|push|deploy|write\s+(?:to\s+)?(?:the\s+)?(?:file|disk)|save\s+(?:to\s+)?(?:the\s+)?(?:file|disk)|delete|remove)\b/i;
  function impliesOutbound(idOrRecipe) {
    const r = typeof idOrRecipe === 'string' ? get(idOrRecipe) : idOrRecipe;
    if (!r) return false;
    return OUTBOUND_RE.test(String(r.task || ''));
  }

  /* ================= R6: marketplace surface (export / import / ranking) =================
     Pure, node-testable helpers appended near the public API. They do NOT touch the launch primitives above —
     export/import move a recipe as a portable JSON unit; rankRecipes powers the "FOR YOU" row deterministically. */

  // the on-disk format marker. Bump only on a breaking format change; importers accept any value they understand.
  const EXPORT_FORMAT = 1;
  // the fields an exported recipe carries — the v2 authoring surface, nothing runtime/derived. `custom`,
  // `seedborn`, timestamps and any live-routine state are deliberately NOT exported (they're local provenance).
  const EXPORT_FIELDS = ['id', 'name', 'emoji', 'tagline', 'blurb', 'accent', 'tags', 'params', 'task', 'gear', 'skills', 'cadence', 'category', 'source', 'forkedFrom'];

  // EXPORT: a plain, JSON-serializable object for ONE recipe (built-in or custom), stamped with a format marker.
  // Returns null for an unknown id. The result is a deep copy (never a live/frozen ref) so a caller can pretty-print
  // and hand it to a file download. It is the seed of the open-core marketplace unit — a clean portable format,
  // no network. The original recipe's `id` is kept as provenance; importRecipe re-homes it into forkedFrom.
  function exportRecipe(idOrRecipe) {
    const r = typeof idOrRecipe === 'string' ? get(idOrRecipe) : idOrRecipe;
    if (!r) return null;
    const out = { starnetRecipe: EXPORT_FORMAT };
    for (const k of EXPORT_FIELDS) {
      const v = r[k];
      if (v == null) { out[k] = (k === 'cadence' || k === 'forkedFrom') ? null : v; continue; }
      if (k === 'tags') out.tags = Object.assign({}, v);
      else if (k === 'params') out.params = (Array.isArray(v) ? v : []).map(p => ({ key: p.key, label: p.label, placeholder: p.placeholder, required: p.required, default: p.default }));
      else if (k === 'gear' || k === 'skills') out[k] = (Array.isArray(v) ? v : []).slice();
      else out[k] = v;
    }
    return out;
  }

  // validate the SHAPE of a parsed import object (never executes anything from it). Returns { ok:true, recipe } with
  // a sanitized DRAFT (unknown fields stripped, arrays coerced) or { ok:false, error } with an honest reason. This is
  // the trust boundary: an imported file is data, so we only ever read strings/arrays out of it and re-run them
  // through the same normalizers a hand-authored save uses — a malformed file can NEVER produce an ungated or
  // ambiguous recipe, and there is no code path from the file into the agent's directive beyond the task TEMPLATE.
  function validateImport(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'not a recipe file (expected a JSON object)' };
    // required: a name and a task template. `id` is used only for provenance (forkedFrom), never to overwrite.
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const task = typeof obj.task === 'string' ? obj.task.trim() : '';
    if (!name) return { ok: false, error: 'the file has no recipe name' };
    if (!task) return { ok: false, error: 'the file has no directive (task) template' };
    // params: an array of sane {key,...} descriptors. A non-array (or garbage) is dropped → normCustom re-derives
    // from the template tokens, so the recipe is never left with a literal {token} it can't fill.
    const rawParams = Array.isArray(obj.params) ? obj.params : [];
    const params = rawParams
      .filter(p => p && typeof p === 'object' && !Array.isArray(p) && typeof p.key === 'string' && p.key.trim())
      .map(p => ({
        key: String(p.key).trim(),
        label: typeof p.label === 'string' ? p.label : '',
        placeholder: typeof p.placeholder === 'string' ? p.placeholder : '',
        required: p.required !== false,
        default: typeof p.default === 'string' ? p.default : ''
      }));
    // a sanitized DRAFT (plain strings/arrays only) — saveCustom/normCustom apply the real freezing + defaults.
    // provenance: if the file carried an id, keep it as forkedFrom (source:'fork') so the import reads as "from
    // <original>"; else it's a plain 'custom'. A file that already declared forkedFrom keeps that lineage.
    const originId = (obj.id != null && String(obj.id).trim()) ? String(obj.id).trim() : null;
    const carriedFork = (obj.forkedFrom != null && String(obj.forkedFrom).trim()) ? String(obj.forkedFrom).trim() : null;
    const forkedFrom = carriedFork || originId;
    const recipe = draft({
      name, task,
      emoji: typeof obj.emoji === 'string' ? obj.emoji : '',
      tagline: typeof obj.tagline === 'string' ? obj.tagline : '',
      blurb: typeof obj.blurb === 'string' ? obj.blurb : '',
      accent: typeof obj.accent === 'string' ? obj.accent : '',
      tags: (obj.tags && typeof obj.tags === 'object' && !Array.isArray(obj.tags)) ? obj.tags : null,
      params,
      gear: Array.isArray(obj.gear) ? obj.gear : [],
      skills: Array.isArray(obj.skills) ? obj.skills : [],
      cadence: obj.cadence != null ? obj.cadence : null,
      category: typeof obj.category === 'string' ? obj.category : null,
      // an imported recipe is never a builtin — it's always yours. If it named a parent, mark it a fork of that.
      source: forkedFrom ? 'fork' : 'custom',
      forkedFrom
    });
    return { ok: true, recipe };
  }

  // IMPORT: validate a parsed object, then SAVE it as a fresh custom (mints a new custom-recipe-<slug> id so it can
  // never collide with — or overwrite — an existing recipe). Returns { ok:true, recipe:<saved> } or { ok:false,
  // error }. Nothing from the file is executed; only the recipe's own launch (later, by the user) ever runs its task.
  function importRecipe(obj) {
    const v = validateImport(obj);
    if (!v.ok) return v;
    // strip any id from the draft so saveCustom always mints a fresh one (the file's id lives on in forkedFrom).
    const clean = Object.assign({}, v.recipe); delete clean.id;
    try {
      const saved = saveCustom(clean);
      return { ok: true, recipe: saved };
    } catch (e) { return { ok: false, error: (e && e.message) || 'could not save the imported recipe' }; }
  }

  // does a recipe's browsable text match a free-text goal string? A deterministic keyword overlap over the goal's
  // words (>=3 chars, de-duped) against the recipe's name+tagline+tags — returns a small count used as a ranking
  // nudge (never the sole signal). Pure + case-insensitive; punctuation is split on. No fuzzy matching (honest).
  function goalKeywordScore(recipe, goalText) {
    if (!recipe || !goalText) return 0;
    const words = String(goalText).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    if (!words.length) return 0;
    const seen = {}; const uniq = [];
    for (const w of words) if (!seen[w]) { seen[w] = true; uniq.push(w); }
    const hay = ((recipe.name || '') + ' ' + (recipe.tagline || '') + ' ' + Object.keys(recipe.tags || {}).join(' ')).toLowerCase();
    let hits = 0;
    for (const w of uniq) if (hay.indexOf(w) >= 0) hits++;
    return hits;
  }

  // RANK the "FOR YOU" row deterministically. `opts`:
  //   score(itemTags) -> number  — the profile affinity scorer (ProfileStore.score), or null when learning is off/thin.
  //   goalText        -> string  — the user's goals belief text (keyword-matched into the ranking as a small nudge).
  //   launches        -> {id: {n, rated?}} or {id: n} — REAL per-recipe launch counts (the scout usage read), each
  //                      optionally carrying rate-the-work outcome counters {great, ok, miss}. Launching ranks a
  //                      recipe up (capped nudge); the Commander's own verdicts rank what actually HELPED.
  //   exclude         -> id      — a recipe to omit (e.g. the one already in the dossier).
  //   limit           -> N       — how many to return (default 4).
  // Signal blend: (profile affinity × 4) + (goal-keyword hits × 2) + min(launches, 5) + OUTCOME, where OUTCOME =
  // min(great, 3) − 2·min(miss, 3) — asymmetric on purpose: a recipe the Commander keeps rating 👎 sinks fast and
  // can drop out of the row entirely (score ≤ 0 is filtered — the honest sink), while 👍 lifts it gently. Ratings
  // never count as a signal on their own (a rating implies a launch, which already signals). Tie-broken by original
  // catalog order so the result is STABLE for a fixed input (test-friendly). If EVERY signal is silent (no profile
  // + no goal match + never launched), we fall back to an HONEST category spread — one recipe per distinct category
  // in catalog order — so a cold-start user still sees a varied, non-arbitrary row (never a fake "popular"
  // ordering; truthful-telemetry law — the launch counts are the user's OWN real launches, never anyone else's).
  function rankRecipes(items, opts) {
    opts = opts || {};
    const list0 = Array.isArray(items) ? items : builtins();
    const exclude = opts.exclude || null;
    const limit = opts.limit != null ? opts.limit : 4;
    const scoreFn = typeof opts.score === 'function' ? opts.score : null;
    const goalText = opts.goalText || '';
    const launches = (opts.launches && typeof opts.launches === 'object') ? opts.launches : null;
    const launchCount = (id) => {
      if (!launches || !id) return 0;
      const u = launches[id];
      const n = (u && typeof u === 'object') ? u.n : u;
      return (Number.isFinite(n) && n > 0) ? Math.min(5, Math.floor(n)) : 0;
    };
    // the outcome term (lane B): the Commander's OWN rate-the-work verdicts on this recipe's runs. Capped both
    // ways and miss-heavy on purpose (a 👎 is rarer and better-informed than a 👍); bad counters read as zeros.
    const outcomeScore = (id) => {
      if (!launches || !id) return 0;
      const u = launches[id];
      const r = (u && typeof u === 'object') ? u.rated : null;
      if (!r || typeof r !== 'object') return 0;
      const g = (Number.isFinite(r.great) && r.great > 0) ? Math.min(3, Math.floor(r.great)) : 0;
      const m = (Number.isFinite(r.miss) && r.miss > 0) ? Math.min(3, Math.floor(r.miss)) : 0;
      return g - 2 * m;
    };
    const pool = list0.filter(r => r && r.id !== exclude);
    let anySignal = false;
    const scored = pool.map((r, idx) => {
      const aff = scoreFn ? (Number(scoreFn(r.tags || {})) || 0) : 0;
      const goal = goalKeywordScore(r, goalText);
      const use = launchCount(r.id);
      if (aff > 0 || goal > 0 || use > 0) anySignal = true;   // ratings never signal alone: a rating implies a launch
      return { r, idx, s: aff * 4 + goal * 2 + use + outcomeScore(r.id) };
    });
    if (anySignal) {
      const top = scored
        .filter(x => x.s > 0)
        .sort((a, b) => (b.s - a.s) || (a.idx - b.idx))
        .slice(0, limit)
        .map(x => x.r);
      // …unless the SINK TOOK EVERYTHING. The outcome term is negative-heavy on purpose, so a station whose only
      // engagement on record is a 👎 (launched one recipe, rated it miss — the exact first-session shape: no
      // profile affinity, no goal text) scores every candidate <= 0 and this filter returns NOTHING. The caller
      // renders no row at all, so honest feedback would DELETE the FOR YOU shelf. Fall through to the cold-start
      // spread instead: "nothing has earned the row yet" is the same honest state as never having launched one.
      if (top.length) return top;
    }
    // honest cold-start fallback: a category spread (first recipe of each distinct category, catalog order), topped
    // up with the next recipes in order if there aren't enough distinct categories to fill the row.
    const byCat = [], usedCat = {}, rest = [];
    pool.forEach(r => {
      const c = r.category || 'general';
      if (!usedCat[c]) { usedCat[c] = true; byCat.push(r); } else rest.push(r);
    });
    return byCat.concat(rest).slice(0, limit);
  }

  return {
    TAGS, GEAR_TYPES, CADENCES, CATEGORIES, SOURCES,
    list, builtins, customs: customList, get, exists,
    fillTask, requiredMissing, paramsFromTemplate, draft, forkFrom, mintFromRun, saveCustom, removeCustom, impliesOutbound,
    // R6 marketplace surface
    EXPORT_FORMAT, exportRecipe, validateImport, importRecipe, rankRecipes, goalKeywordScore
  };
});
