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
A.ok(saved.id.indexOf('custom-') === 0, 'a saved custom gets a custom- id: ' + saved.id);
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

/* ---------- draft(): the P3 "save what you keep asking for" seam ---------- */
const d = R.draft({ name: 'My Mission', task: 'Do the thing.' });
A.eq(d.name, 'My Mission', 'draft honors a provided name');
A.eq(d.task, 'Do the thing.', 'draft carries the task');
A.ok(Array.isArray(d.params), 'draft has a params array');

A.report('recipes');
