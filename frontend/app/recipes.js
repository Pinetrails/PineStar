/* SKYNET — recipes.js : THE RECIPE / MISSION LIBRARY — ready-made, parameterized job templates.

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

  const STORE_KEY = 'skynet.recipes.v1';   // localStorage home for custom (save-your-own) recipes

  // the interest vocabulary the personalization recommender ranks against (mirrors classify.js getTag and
  // specialties.js) — a recipe's `tags` map weights these lanes so it ranks honestly in the same feed.
  const TAGS = ['code', 'research', 'general'];

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
      accent: r.accent || '#7df0a0',
      tags: Object.freeze(normTags(r.tags)),          // interest-lane weights the recommender ranks by
      params: Object.freeze(normParams(r.params)),    // the param form: [{ key, label, placeholder, required, default }]
      task: r.task || '',                             // the directive TEMPLATE; {key} tokens get param values
      custom: false
    });
  }

  /* ---------- the curated catalog ---------- *
     Every `task` is written as an imperative DIRECTIVE (so Classify.isTaskDirective fires and the agent does
     the work instead of just chatting), in the harness voice, leading with the bottom-line ask. {tokens} are
     substituted from the param form at launch. tags map each recipe onto the interest lanes for ranking. */
  const BUILTINS = Object.freeze([
    {
      id: 'morning-brief', name: 'Morning Brief', emoji: '☀', tagline: 'Daily what-changed digest', accent: '#46c8ff',
      blurb: 'A tight standup on what moved in your space overnight — answer first, sources under it.',
      tags: { research: 1 },
      params: [
        { key: 'topic', label: 'Topic', placeholder: 'e.g. AI agent tooling' },
        { key: 'window', label: 'Look-back', placeholder: 'the last 24 hours', required: false, default: 'the last 24 hours' }
      ],
      task: 'Brief me on {topic}: what meaningfully changed in {window}. Lead with the bottom line, then the supporting detail with sources. Skip anything stale or trivial — signal only.'
    },
    {
      id: 'deep-research', name: 'Deep-Dive Research', emoji: '◎', tagline: 'Sourced brief on a question', accent: '#46c8ff',
      blurb: 'Digs the live web, cross-checks across independent sources, and briefs it tightly.',
      tags: { research: 1 },
      params: [{ key: 'topic', label: 'Question / topic', placeholder: 'e.g. is X worth adopting?' }],
      task: 'Research {topic} in depth. Cross-check across at least two independent sources, then give me a sourced brief: lead with the answer, then the evidence, and flag what is uncertain or contested.'
    },
    {
      id: 'fact-check', name: 'Fact-Check', emoji: '⊜', tagline: 'Verify a claim, with sources', accent: '#6cd0ff',
      blurb: 'Takes one claim, checks it against the record, and tells you true / false / it-depends.',
      tags: { research: 0.8, general: 0.2 },
      params: [{ key: 'claim', label: 'The claim', placeholder: 'paste the statement to verify' }],
      task: 'Fact-check this claim and cite your sources: "{claim}". Verdict first (true / false / misleading / unverifiable), then the evidence. Never present an unsourced claim as fact.'
    },
    {
      id: 'fix-bug', name: 'Fix a Bug', emoji: '⌗', tagline: 'Diagnose & patch a defect', accent: '#7df0a0',
      blurb: 'Reads the surrounding code first, makes a focused fix, and verifies it actually works.',
      tags: { code: 1 },
      params: [{ key: 'error', label: 'Error / symptom', placeholder: 'paste the error or describe the bug' }],
      task: 'Fix this bug: {error}. Read the surrounding code before changing it, make the smallest focused edit that fixes it, then verify the fix works and report what changed and why.'
    },
    {
      id: 'code-review', name: 'Code Review', emoji: '⊗', tagline: 'Adversarial review pass', accent: '#ff8f8f',
      blurb: 'Stress-tests a change before it ships — bugs, edge cases, weak spots, ranked with fixes.',
      tags: { code: 0.8, general: 0.2 },
      params: [{ key: 'target', label: 'What to review', placeholder: 'a file, a diff, or a plan' }],
      task: 'Review {target} adversarially — actively try to break it. Hunt for bugs, edge cases, and weak spots; rank findings by severity and give a concrete fix for each. Separate real defects from nitpicks.'
    },
    {
      id: 'ship-feature', name: 'Build a Feature', emoji: '⊞', tagline: 'Add something, end to end', accent: '#7df0a0',
      blurb: 'Adds a focused feature in the codebase’s own style and verifies it before calling it done.',
      tags: { code: 1 },
      params: [
        { key: 'feature', label: 'Feature', placeholder: 'what to build' },
        { key: 'where', label: 'Where', placeholder: 'file / module / area', required: false, default: 'the right place in the codebase' }
      ],
      task: 'Add {feature} to {where}. Read the surrounding code first and match its style, keep the diff focused on exactly what the feature needs, then verify it works and summarize what changed.'
    },
    {
      id: 'draft-reply', name: 'Draft a Reply', emoji: '✉', tagline: 'Answer a message in your voice', accent: '#5fd0e0',
      blurb: 'Reads an incoming message and drafts a reply in the tone you pick — ready to send or tweak.',
      tags: { general: 1 },
      params: [
        { key: 'message', label: 'The message', placeholder: 'paste what you’re replying to' },
        { key: 'tone', label: 'Tone', placeholder: 'warm & concise', required: false, default: 'warm and concise' }
      ],
      task: 'Draft a reply to this message in a {tone} tone:\n\n{message}\n\nGive me one clean draft first. Do not send anything — just draft it for my review.'
    },
    {
      id: 'tighten-writing', name: 'Tighten This', emoji: '✎', tagline: 'Cut filler, keep the meaning', accent: '#e6a0ff',
      blurb: 'Edits a passage down — sharper, clearer, no fluff — without changing what it says.',
      tags: { general: 1 },
      params: [{ key: 'text', label: 'The text', placeholder: 'paste the passage to tighten' }],
      task: 'Tighten this writing — cut the filler, favor clear concrete language, and make it land — while preserving the meaning. Flag anything you would change substantively:\n\n{text}'
    },
    {
      id: 'plan-project', name: 'Plan a Project', emoji: '◇', tagline: 'Break a goal into a plan', accent: '#ffb641',
      blurb: 'Turns a big, fuzzy goal into concrete steps, then flags what needs you.',
      tags: { general: 1 },
      params: [{ key: 'goal', label: 'The goal', placeholder: 'what you’re trying to accomplish' }],
      task: 'Break {goal} into a concrete, ordered step-by-step plan. Keep steps small and actionable; call out dependencies, risks, and exactly what needs me before we can move.'
    },
    {
      id: 'summarize', name: 'Summarize', emoji: '▤', tagline: 'TL;DR of anything', accent: '#c8efff',
      blurb: 'Distills a wall of text down to the bottom line plus the few points that matter.',
      tags: { general: 0.6, research: 0.4 },
      params: [{ key: 'content', label: 'Content', placeholder: 'paste the text / notes / thread' }],
      task: 'Summarize this clearly — lead with the bottom line, then the few points that actually matter:\n\n{content}'
    }
  ].map(freezeRecipe));

  /* ---------- custom (save-your-own) recipes ---------- */
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
  function normCustom(r) {
    const name = String(r.name || 'My Recipe');
    const tagline = r.tagline || '', task = r.task || '';
    return {
      id: r.id, name,
      emoji: r.emoji || '▸', tagline, blurb: r.blurb || '',
      accent: r.accent || '#7df0a0',
      // a saved custom carries its own ranking tags; pre-tags customs (or older saves) get them classified
      // from their own text — so the Commander's own recipes rank in the feed just like the built-ins.
      tags: normTags(r.tags && Object.keys(r.tags).length ? r.tags : deriveTags(name + ' ' + tagline + ' ' + task)),
      // an authored custom supplies only the task TEMPLATE — derive its inputs from the {tokens} when no usable
      // params given. Check the NORMALIZED result (not the raw length) so a keyless/garbage params array from a
      // hand-edited or corrupted import still falls through to template derivation instead of shipping ungated.
      params: (function () { const np = normParams(r.params); return np.length ? np : normParams(paramsFromTemplate(task)); })(),
      task,
      custom: true
    };
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
    return out.trim();
  }

  // build a DRAFT custom recipe from a launched one (P3 "save what you keep asking for" seam). Returns a plain
  // draft (no id, custom not set) for saveCustom — mirrors Specialties.fromAgent.
  function draft(over) {
    over = over || {};
    return {
      name: over.name || 'My Recipe',
      emoji: over.emoji || '▸',
      tagline: over.tagline || '',
      blurb: over.blurb || '',
      accent: over.accent || '#7df0a0',
      tags: over.tags || null,
      params: over.params || [],
      task: over.task || ''
    };
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

  return {
    TAGS,
    list, builtins, customs: customList, get, exists,
    fillTask, requiredMissing, paramsFromTemplate, draft, saveCustom, removeCustom
  };
});
