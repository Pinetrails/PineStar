/* node test/recipes.test.js — the Recipe / Mission library (frontend/app/recipes.js).
   Locks the catalog's integrity (every built-in is well-formed, deep-frozen, ids unique), that the param
   form is sane (declared params, no dangling {tokens}), that fillTask() — THE launch primitive — substitutes
   params, honors optional defaults, tidies blank substitutions, and leaves a recipe untouched it doesn't own;
   that requiredMissing() gates launch honestly; that every filled recipe READS AS A REAL TASK DIRECTIVE (so it
   actually launches work) and carries ranking tags consistent with what the app's own classifier tags it as;
   and that the custom (save-your-own) round-trip behaves — including a built-in-id collision. Runs under node
   with no DOM and no localStorage, so the custom store lives in-memory here (the browser persists it). */
'use strict';
const A = require('./_assert.js');
const R = require('../frontend/app/recipes.js');
const C = require('../frontend/app/classify.js');   // the same task/tag classifier the live app uses

/* ---------- catalog integrity ---------- */
const builtins = R.builtins();
A.ok(builtins.length >= 8, 'catalog ships a real library (>= 8 recipes), got ' + builtins.length);

const seen = {};
for (const b of builtins) {
  A.ok(!seen[b.id], 'built-in id is unique: ' + b.id);
  seen[b.id] = true;
  A.ok(typeof b.id === 'string' && b.id.length > 0, 'has id');
  A.ok(typeof b.name === 'string' && b.name.length > 0, b.id + ' has a name');
  A.ok(typeof b.emoji === 'string' && b.emoji.length > 0, b.id + ' has an emoji');
  A.ok(typeof b.tagline === 'string' && b.tagline.length > 0, b.id + ' has a tagline');
  A.ok(typeof b.blurb === 'string' && b.blurb.length > 0, b.id + ' has a blurb');
  A.ok(typeof b.accent === 'string' && b.accent.length > 0, b.id + ' has an accent color');
  A.ok(typeof b.task === 'string' && b.task.length > 20, b.id + ' has a real directive template');
  A.eq(b.custom, false, b.id + ' is a built-in (custom=false)');

  // ranking tags: the recommender's fuel — at least one positive weight over the known lanes, frozen.
  A.ok(b.tags && typeof b.tags === 'object', b.id + ' carries ranking tags');
  const tagKeys = Object.keys(b.tags);
  A.ok(tagKeys.length >= 1, b.id + ' has at least one interest lane');
  A.ok(tagKeys.every(k => R.TAGS.indexOf(k) >= 0), b.id + ' tags use only the known lanes');
  A.ok(tagKeys.every(k => b.tags[k] > 0), b.id + ' tag weights are all positive');
  A.throws(() => { b.tags.general = 9; }, b.id + ' tags are frozen (catalog is immutable)');

  // params: a frozen array of frozen {key,label,...} descriptors with unique keys.
  A.ok(Array.isArray(b.params), b.id + ' params is an array');
  A.throws(() => { b.params.push({ key: 'x' }); }, b.id + ' params array is frozen');
  const pkeys = {};
  for (const p of b.params) {
    A.ok(typeof p.key === 'string' && p.key.length > 0, b.id + ' param has a key');
    A.ok(typeof p.label === 'string' && p.label.length > 0, b.id + ' param ' + p.key + ' has a label');
    A.ok(typeof p.required === 'boolean', b.id + ' param ' + p.key + ' has a required flag');
    A.ok(!pkeys[p.key], b.id + ' param keys are unique: ' + p.key);
    pkeys[p.key] = true;
    A.throws(() => { p.required = !p.required; }, b.id + ' param ' + p.key + ' is frozen');
  }

  // no DANGLING tokens: every {token} in the template is a declared param (else fillTask can't resolve it).
  const tokens = (b.task.match(/\{(\w+)\}/g) || []).map(t => t.slice(1, -1));
  for (const tok of tokens) A.ok(pkeys[tok], b.id + ' template token {' + tok + '} is a declared param');
}

/* built-ins are frozen — a stray mutation must not poison the shared catalog */
A.throws(() => { builtins[0].name = 'hacked'; }, 'a built-in recipe is frozen');

/* ---------- fillTask(): THE launch primitive ---------- */
A.eq(R.fillTask('no-such-recipe', {}), null, 'fillTask of an unknown id is null');

// substitutes a required param; the value lands and the token is gone
const fb = R.fillTask('fix-bug', { error: 'the login screen crashes on submit' });
A.ok(fb.indexOf('the login screen crashes on submit') >= 0, 'fillTask substitutes the param value');
A.ok(fb.indexOf('{error}') < 0, 'fillTask leaves no unresolved token for a filled param');

// accepts a recipe OBJECT too, not just an id
const fb2 = R.fillTask(R.get('fix-bug'), { error: 'X' });
A.ok(fb2.indexOf('X') >= 0, 'fillTask accepts a recipe object, not just an id');

// an optional param left blank falls back to its DEFAULT (morning-brief.window default = "the last 24 hours")
const mb = R.fillTask('morning-brief', { topic: 'AI agents' });
A.ok(mb.indexOf('the last 24 hours') >= 0, 'a blank optional param uses its default');
A.ok(mb.indexOf('{window}') < 0 && mb.indexOf('{topic}') < 0, 'no tokens survive when defaults cover the blanks');

// a clean single-line prose recipe stays clean (no stray double spaces / space-before-punctuation)
A.ok(!/\s{2,}/.test(mb) && !/\s[.,;:!?]/.test(mb), 'a filled single-line prose recipe reads clean');

// CRITICAL: a filled value is inserted VERBATIM — pasted code / logs / indentation / aligned text must survive
// untouched, because the agent has to run exactly what the Commander supplied (not a whitespace-flattened version).
const code = 'def f():\n    return  1   # 4-space indent + intentional double spaces';
A.ok(R.fillTask('summarize', { content: code }).indexOf(code) >= 0, 'fillTask preserves multi-line / indented / multi-space pasted content verbatim');
const trace = '  at foo (a.js:1)\n  at bar (b.js:2)';
A.ok(R.fillTask('fix-bug', { error: trace }).indexOf(trace) >= 0, 'fillTask preserves a pasted stack trace (leading indent on every line)');

// a defaultless optional left blank drops cleanly — the seam space the gone token leaves is closed (template-only)
const optRec = R.saveCustom({ name: 'Opt', task: 'Do {a} now.', params: [{ key: 'a', required: false }] });
A.eq(R.fillTask(optRec.id, {}), 'Do now.', 'a blank defaultless optional closes its seam (no doubled space)');
R.removeCustom(optRec.id);

// a token the recipe does NOT declare is left untouched (author-error safe, never crashes)
const dangling = R.saveCustom({ name: 'Dangler', task: 'Do {thing} with {undeclared}.', params: [{ key: 'thing' }] });
const dfill = R.fillTask(dangling.id, { thing: 'it' });
A.ok(dfill.indexOf('Do it with {undeclared}.') >= 0, 'an undeclared token is left as-is');
R.removeCustom(dangling.id);

/* every built-in, filled with sample values, must READ AS A REAL TASK DIRECTIVE (so it launches work, not
   chatter) AND carry a ranking lane consistent with what the app's own classifier tags the filled task as. */
for (const b of builtins) {
  const vals = {};
  b.params.forEach(p => { if (p.required) vals[p.key] = 'something concrete to work on'; });
  const filled = R.fillTask(b.id, vals);
  A.ok(filled && filled.length > 0, b.id + ' produces a non-empty directive');
  A.ok(!/\{\w+\}/.test(filled), b.id + ' leaves no unresolved tokens once required params are filled');
  A.ok(C.isTaskDirective(filled), b.id + ' filled task reads as a real task directive (launches work)');
  const tag = C.getTag(filled);
  A.ok((b.tags[tag] || 0) > 0, b.id + ' ranking tags honestly include the lane the task classifies as (' + tag + ')');
}

/* ---------- requiredMissing(): the launch gate ---------- */
A.eq(R.requiredMissing('no-such-recipe', {}).length, 0, 'requiredMissing of an unknown id is empty');
A.eq(R.requiredMissing('fix-bug', {}), ['error'], 'a required param with no value is reported missing');
A.eq(R.requiredMissing('fix-bug', { error: 'boom' }).length, 0, 'a filled required param is not missing');
A.eq(R.requiredMissing('fix-bug', { error: '   ' }), ['error'], 'a whitespace-only value still counts as missing');
// an OPTIONAL param left blank is NOT missing (it has a default) — only required-and-blank blocks launch
A.eq(R.requiredMissing('morning-brief', { topic: 'x' }).length, 0, 'a blank optional param does not block launch');
A.eq(R.requiredMissing('morning-brief', {}), ['topic'], 'only the required param blocks, not the optional one');

/* ---------- custom (save-your-own) round-trip ---------- */
A.eq(R.customs().length, 0, 'no customs at first (node has no localStorage)');
const saved = R.saveCustom({ name: 'Nightly Standup', emoji: '🌙', tagline: 'end-of-day rollup', task: 'Summarize what shipped today and what is blocked.', params: [] });
A.ok(saved.id.indexOf('custom-recipe-') === 0, 'a saved mission id is namespaced custom-recipe- (never collides with a custom specialty): ' + saved.id);
A.eq(saved.custom, true, 'a saved custom is flagged custom=true');
A.ok(saved.tags && Object.keys(saved.tags).length >= 1, 'a saved custom carries ranking tags (classified in-browser; general fallback under node)');
A.ok(Array.isArray(saved.params), 'a saved custom carries a params array');
A.ok(R.exists(saved.id), 'the custom is now in the registry');
A.eq(R.customs().length, 1, 'exactly one custom after one save');
A.eq(R.list().length, builtins.length + 1, 'list() = built-ins + customs');

// a custom is launchable through the same fillTask primitive
A.ok(R.fillTask(saved.id, {}).indexOf('Summarize what shipped today') >= 0, 'a custom recipe fills like a built-in');

// editing the same id upserts (no duplicate)
const edited = R.saveCustom(Object.assign({}, saved, { tagline: 'changed' }));
A.eq(edited.id, saved.id, 'editing keeps the same id');
A.eq(R.customs().length, 1, 'upsert does not duplicate');
A.eq(R.get(saved.id).tagline, 'changed', 'the edit persisted');

// a missing name is rejected
A.throws(() => R.saveCustom({ name: '' }), 'a nameless recipe is rejected');

// id collision against a BUILT-IN must not clobber it — saving a custom literally named like a built-in id
const clash = R.saveCustom({ name: 'Fix Bug', task: 'mine', params: [] });
A.ok(clash.id !== 'fix-bug', 'a custom never steals a built-in id (' + clash.id + ' != fix-bug)');
A.eq(R.get('fix-bug').custom, false, 'the built-in Fix a Bug is untouched');

// remove
A.eq(R.removeCustom(saved.id), true, 'removeCustom returns true when it removed one');
A.ok(!R.exists(saved.id), 'the removed custom is gone');
A.eq(R.removeCustom('nope'), false, 'removeCustom returns false for an unknown id');
R.removeCustom(clash.id);   // tidy up the collision custom too

/* ---------- paramsFromTemplate(): authoring derives the input form from the task template ---------- */
A.eq(R.paramsFromTemplate('a fixed mission with no tokens').length, 0, 'a template with no tokens yields a one-tap mission (no params)');
const pp = R.paramsFromTemplate('Brief me on {topic} since {look_back} — more on {topic}');
A.eq(pp.length, 2, 'distinct tokens become params (duplicates collapsed)');
A.eq(pp.map(p => p.key), ['topic', 'look_back'], 'params follow first-seen token order, de-duplicated');
A.eq(pp[1].label, 'Look Back', 'a snake_case token gets a humanized Title-Case label');
A.ok(pp.every(p => p.required), 'authored template params are required by default');

// humanize handles acronym boundaries and NEVER yields a blank or indistinguishable label (review hardening)
A.eq(R.paramsFromTemplate('Check {HTTPStatus}')[0].label, 'HTTP Status', 'humanize splits an acronym boundary (HTTPStatus -> HTTP Status)');
A.eq(R.paramsFromTemplate('Do {_} now.')[0].label, '_', 'a token that humanizes to empty falls back to the raw key (never a blank launch field)');
const dupL = R.paramsFromTemplate('{look_back} vs {lookBack}');
A.eq(dupL.length, 2, 'snake and camel variants are distinct params (de-duped by key, not label)');
A.ok(dupL[0].label !== dupL[1].label, 'two tokens that would collapse to the same label are disambiguated');
A.ok(dupL[0].label.indexOf('look_back') >= 0 && dupL[1].label.indexOf('lookBack') >= 0, 'the disambiguator appends the raw key');
const caseL = R.paramsFromTemplate('Compare {topic} vs {Topic}.');
A.ok(caseL[0].label !== caseL[1].label, 'case-variant tokens ({topic} vs {Topic}) get distinguishable labels');

// auto-derive is driven by the NORMALIZED params: a keyless/garbage params array still falls through to derivation
// (a hand-edited / corrupted import can't produce an ungated mission that ships a literal {token})
const garbage = R.saveCustom({ name: 'Garbage In', task: 'Do {x} please.', params: [{ label: 'no key here' }] });
A.eq(garbage.params.map(p => p.key), ['x'], 'a keyless params array does not suppress template derivation');
A.eq(R.requiredMissing(garbage.id, {}), ['x'], 'the re-derived param still gates launch (no ungated {tokens})');
A.ok(R.fillTask(garbage.id, { x: 'it' }).indexOf('Do it please.') >= 0, 'the re-derived mission fills correctly');
R.removeCustom(garbage.id);

// an authored custom (only name + task template) gets its params auto-derived and launches like a built-in
const authored = R.saveCustom({ name: 'Standup', task: 'Summarize {project} progress and flag blockers.' });
A.eq(authored.params.map(p => p.key), ['project'], 'a saved custom auto-derives its params from the template');
A.eq(R.requiredMissing(authored.id, {}), ['project'], 'the derived param gates launch');
A.ok(R.fillTask(authored.id, { project: 'StarNet' }).indexOf('Summarize StarNet progress') >= 0, 'the authored custom fills + launches via the same primitive');
R.removeCustom(authored.id);

// explicit params still win over derivation (back-compat for an imported custom that supplies its own)
const explicit = R.saveCustom({ name: 'Explicit', task: 'Do {x}.', params: [{ key: 'x', label: 'The X', required: false, default: 'nothing' }] });
A.eq(explicit.params[0].label, 'The X', 'explicit params override template derivation');
A.eq(explicit.params[0].required, false, 'explicit optional flag is honored over the required-by-default derivation');
A.eq(R.fillTask(explicit.id, {}), 'Do nothing.', 'an explicit optional default fills when blank');
R.removeCustom(explicit.id);

/* ---------- draft(): the P3 "save what you keep asking for" seam ---------- */
const d = R.draft({ name: 'My Mission', task: 'Do the thing.' });
A.eq(d.name, 'My Mission', 'draft honors a provided name');
A.eq(d.task, 'Do the thing.', 'draft carries the task');
A.ok(Array.isArray(d.params), 'draft has a params array');

/* ---------- R1: schema v2 — gear / skills / cadence / category / source / forkedFrom ---------- */
// every built-in carries the v2 fields, normalized + frozen. gear/skills are frozen arrays of known values;
// cadence is a valid id or null; category is one of the known buckets; source is 'builtin'; forkedFrom is null.
for (const b of builtins) {
  A.ok(Array.isArray(b.gear), b.id + ' has a gear array');
  A.ok(b.gear.every(g => R.GEAR_TYPES.indexOf(g) >= 0), b.id + ' gear entries are known capability objectTypes');
  A.throws(() => { b.gear.push('dish'); }, b.id + ' gear array is frozen');
  A.ok(Array.isArray(b.skills), b.id + ' has a skills array');
  A.ok(b.cadence === null || R.CADENCES.indexOf(b.cadence) >= 0, b.id + ' cadence is a valid id or null');
  A.ok(R.CATEGORIES.indexOf(b.category) >= 0, b.id + ' category is a known browse bucket');
  A.eq(b.source, 'builtin', b.id + ' source is builtin');
  A.eq(b.forkedFrom, null, b.id + ' forkedFrom is null (a built-in is not a fork)');
}
// the honest values the plan calls out: morning-brief draws on the WEB (dish), suggests 'morning', browses under research.
const mbr = R.get('morning-brief');
A.ok(mbr.gear.indexOf('dish') >= 0, 'morning-brief gear includes dish (the WEB)');
A.eq(mbr.cadence, 'morning', 'morning-brief suggests the morning cadence');
A.eq(mbr.category, 'research', 'morning-brief browses under research');
// a code recipe wants FILES; deep-research is one-shot by nature (no suggested cadence).
A.ok(R.get('code-review').gear.indexOf('cabinet') >= 0, 'code-review gear includes cabinet (FILES)');
A.eq(R.get('deep-research').cadence, null, 'deep-research is one-shot by nature (no cadence)');

// gear normalization drops unknown/garbage objectTypes; a hand-authored custom keeps only real caps.
const geared = R.saveCustom({ name: 'Geared', task: 'Do {x}.', gear: ['dish', 'bogus', 'cabinet', 'dish'] });
A.eq(geared.gear, ['dish', 'cabinet'], 'gear drops unknown types and de-dups (dish, cabinet)');
A.eq(geared.source, 'custom', 'a hand-authored save defaults to source:custom');
A.eq(geared.forkedFrom, null, 'a hand-authored save has no forkedFrom');
R.removeCustom(geared.id);

// a custom with no explicit category derives one from its dominant lane (a code-tagged task → code bucket).
const codey = R.saveCustom({ name: 'Codey', task: 'Fix the bug in {file} and verify the code compiles.' });
A.ok(['code', 'research', 'general'].indexOf(codey.category) >= 0, 'a categoryless custom derives a browse bucket from its tags: ' + codey.category);
R.removeCustom(codey.id);

// an explicit cadence/category on a custom is honored (and validated).
const routiney = R.saveCustom({ name: 'Routiney', task: 'Brief me on {topic}.', cadence: 'morning', category: 'research' });
A.eq(routiney.cadence, 'morning', 'an explicit valid cadence is kept');
A.eq(routiney.category, 'research', 'an explicit valid category is kept');
const badcad = R.saveCustom({ name: 'BadCad', task: 'Do {x}.', cadence: 'yearly', category: 'nonsense' });
A.eq(badcad.cadence, null, 'an unknown cadence id normalizes to null (never an unschedulable id)');
A.eq(badcad.category, 'general', 'an unknown category normalizes to the general bucket');
R.removeCustom(routiney.id); R.removeCustom(badcad.id);

/* ---------- R2: forkFrom() — TWEAK mints a fork prefilled from any recipe, original untouched ---------- */
A.eq(R.forkFrom('no-such-recipe'), null, 'forkFrom of an unknown id is null');
const forkDraft = R.forkFrom('morning-brief');
A.ok(forkDraft && forkDraft.source === 'fork', 'forkFrom stamps source:fork');
A.eq(forkDraft.forkedFrom, 'morning-brief', 'forkFrom records the parent id');
A.ok(forkDraft.task === mbr.task, 'the fork copies the parent task template verbatim');
A.ok(Array.isArray(forkDraft.gear) && forkDraft.gear.indexOf('dish') >= 0, 'the fork copies the parent gear');
A.eq(forkDraft.cadence, 'morning', 'the fork copies the parent suggested cadence');
A.ok(!forkDraft.id, 'a fork draft has no id (saveCustom mints a fresh one — the original is never overwritten)');
// saving the fork mints a NEW custom and leaves the built-in intact.
const savedFork = R.saveCustom(forkDraft);
A.ok(savedFork.id.indexOf('custom-recipe-') === 0, 'a saved fork gets a fresh custom id: ' + savedFork.id);
A.eq(savedFork.source, 'fork', 'a saved fork keeps source:fork');
A.eq(savedFork.forkedFrom, 'morning-brief', 'a saved fork keeps its parent id');
A.eq(R.get('morning-brief').custom, false, 'the forked built-in is untouched (still a built-in)');
A.ok(R.fillTask(savedFork.id, { topic: 'X' }).length > 0, 'the fork launches through the same fillTask primitive');
R.removeCustom(savedFork.id);

/* ---------- R3: impliesOutbound() — the soft unattended-run warning heuristic ---------- */
A.ok(R.impliesOutbound('draft-reply'), 'draft-reply implies outbound (it drafts a reply)');
A.ok(!R.impliesOutbound('summarize'), 'summarize does not imply an outbound action');
A.ok(!R.impliesOutbound('no-such-recipe'), 'impliesOutbound of an unknown id is false');
const sendy = R.saveCustom({ name: 'Sendy', task: 'Post the update to the channel every morning.' });
A.ok(R.impliesOutbound(sendy.id), 'a task that says "post" implies outbound');
R.removeCustom(sendy.id);

A.report('recipes');
