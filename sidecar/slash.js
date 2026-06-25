/* sidecar/slash.js -- StarNet slash-command registry.

   Pure command metadata + resolution. The sidecar owns the catalog so every UI surface can discover
   the same commands, while the browser still executes local view actions such as retry/stop/copy. */
'use strict';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const BUILTIN_COMMANDS = Object.freeze([
  Object.freeze({
    name: 'retry',
    category: 'Session',
    desc: 're-run the last turn',
    action: 'retry'
  }),
  Object.freeze({
    name: 'stop',
    category: 'Session',
    desc: 'interrupt the running turn',
    action: 'stop'
  }),
  Object.freeze({
    name: 'copy',
    category: 'Info',
    desc: "copy the agent's last reply",
    action: 'copy'
  }),
  Object.freeze({
    name: 'help',
    category: 'Info',
    desc: 'list available commands',
    action: 'help'
  })
]);

function cleanName(s) {
  return String(s || '').trim().replace(/^\//, '').toLowerCase();
}

function visibleCommand(c) {
  const out = {
    name: c.name,
    aliases: (c.aliases || []).slice(),
    category: c.category || 'General',
    desc: c.desc || '',
    argsHint: c.argsHint || '',
    source: c.source || 'builtin',
    action: c.action || '',
    dispatch: c.dispatch || 'client'
  };
  if (c.target) out.target = Object.assign({}, c.target);
  if (Object.prototype.hasOwnProperty.call(c, 'available')) out.available = !!c.available;
  if (Object.prototype.hasOwnProperty.call(c, 'enabled')) out.enabled = !!c.enabled;
  return out;
}

function buildIndex(commands) {
  const byName = new Map();
  const byToken = new Map();
  for (const raw of commands || []) {
    const c = Object.assign({}, raw || {});
    c.name = cleanName(c.name);
    c.aliases = (Array.isArray(c.aliases) ? c.aliases : []).map(cleanName).filter(Boolean);
    if (!NAME_RE.test(c.name)) throw new Error('bad slash command name: ' + c.name);
    if (byName.has(c.name)) throw new Error('duplicate slash command: ' + c.name);
    byName.set(c.name, c);
    for (const token of [c.name].concat(c.aliases)) {
      if (!NAME_RE.test(token)) throw new Error('bad slash command token: ' + token);
      if (byToken.has(token)) throw new Error('duplicate slash command token: ' + token);
      byToken.set(token, c);
    }
  }
  return { byName, byToken };
}

const INDEX = buildIndex(BUILTIN_COMMANDS);

function recipeDesc(r) {
  return ((r && r.emoji) ? String(r.emoji) + ' ' : '')
    + String((r && r.name) || (r && r.id) || 'Recipe')
    + ((r && r.tagline) ? ' - ' + String(r.tagline) : '');
}

function applyRecipeDefaults(recipe, args) {
  let directive = String((recipe && recipe.task) || (recipe && recipe.name) || '');
  const params = Array.isArray(recipe && recipe.params) ? recipe.params : [];
  const required = params.filter(p => p && p.key && p.required !== false);
  if (args && required.length === 1) {
    directive = directive.split('{' + required[0].key + '}').join(args);
  }
  for (const p of params) {
    if (!p || !p.key) continue;
    if (p.required !== false) continue;
    if (p.default != null && p.default !== '') directive = directive.split('{' + p.key + '}').join(p.default);
  }
  return directive.trim();
}

function skillInvocationText(skill, args) {
  const task = args || '{task}';
  const head = 'Use the "' + String((skill && skill.name) || (skill && skill.slug) || 'Skill') + '" skill recipe for this task.';
  const desc = (skill && skill.description) ? '\n\nDescription: ' + String(skill.description) : '';
  const body = (skill && skill.body) ? '\n\nSkill recipe:\n' + String(skill.body).trim() : '';
  return (head + desc + body + '\n\nTask: ' + task).trim();
}

function addCommand(out, used, raw) {
  const c = Object.assign({}, raw || {});
  c.name = cleanName(c.name);
  c.aliases = (Array.isArray(c.aliases) ? c.aliases : []).map(cleanName).filter(Boolean);
  if (!c.name || !NAME_RE.test(c.name) || used.has(c.name)) return false;
  for (const a of c.aliases) if (!a || !NAME_RE.test(a) || used.has(a)) return false;
  out.push(c);
  used.add(c.name);
  for (const a of c.aliases) used.add(a);
  return true;
}

function dynamicCommands(opts) {
  opts = opts || {};
  const out = BUILTIN_COMMANDS.map(c => Object.assign({}, c));
  const used = new Set();
  for (const c of out) {
    used.add(c.name);
    for (const a of c.aliases || []) used.add(a);
  }

  for (const r of (Array.isArray(opts.recipes) ? opts.recipes : [])) {
    if (!r || !r.id) continue;
    addCommand(out, used, {
      name: r.id,
      category: 'Recipes',
      desc: recipeDesc(r),
      source: 'recipe',
      action: 'insert',
      dispatch: 'insert',
      target: { type: 'recipe', id: String(r.id) }
    });
  }

  for (const s of (Array.isArray(opts.skills) ? opts.skills : [])) {
    if (!s || !s.slug || s.available === false) continue;
    const base = cleanName(s.slug);
    const name = used.has(base) ? ('skill-' + base) : base;
    addCommand(out, used, {
      name,
      category: 'Skills',
      desc: String(s.description || s.name || s.slug || ''),
      source: 'skill',
      action: 'insert',
      dispatch: 'insert',
      target: { type: 'skill', slug: String(s.slug) },
      available: s.available !== false,
      enabled: !!s.enabled
    });
  }
  return out;
}

function parseInput(input) {
  const text = String(input || '').trim();
  const noSlash = text.replace(/^\//, '');
  const m = noSlash.match(/^([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return { token: '', args: '' };
  return { token: cleanName(m[1]), args: String(m[2] || '').trim() };
}

function resolve(input) {
  return resolveWith(input, BUILTIN_COMMANDS);
}

function resolveWith(input, commands) {
  const parsed = parseInput(input);
  let command = null;
  if (commands === BUILTIN_COMMANDS) command = parsed.token ? INDEX.byToken.get(parsed.token) : null;
  else {
    const idx = buildIndex(commands);
    command = parsed.token ? idx.byToken.get(parsed.token) : null;
  }
  return command ? { command, args: parsed.args, token: parsed.token } : null;
}

function catalog(opts) {
  return { commands: dynamicCommands(opts).map(visibleCommand) };
}

function findRecipe(id, recipes) {
  id = String(id || '');
  return (recipes || []).find(r => r && String(r.id) === id) || null;
}

function findSkill(slug, skills) {
  slug = String(slug || '');
  return (skills || []).find(s => s && String(s.slug) === slug) || null;
}

function dispatch(input, opts) {
  opts = opts || {};
  const commands = dynamicCommands(opts);
  const hit = resolveWith(input, commands);
  if (!hit) return { ok: false, error: 'unknown slash command', status: 404 };
  const c = hit.command;
  if (c.target && c.target.type === 'recipe') {
    const recipe = findRecipe(c.target.id, opts.recipes);
    if (!recipe) return { ok: false, error: 'unknown recipe', status: 404 };
    return {
      ok: true,
      command: visibleCommand(c),
      args: hit.args,
      directive: {
        type: 'insert',
        source: 'recipe',
        text: applyRecipeDefaults(recipe, hit.args),
        select: 'first-placeholder'
      }
    };
  }
  if (c.target && c.target.type === 'skill') {
    const skill = findSkill(c.target.slug, opts.skills);
    if (!skill || skill.available === false) return { ok: false, error: 'skill unavailable', status: 409 };
    return {
      ok: true,
      command: visibleCommand(c),
      args: hit.args,
      directive: {
        type: 'insert',
        source: 'skill',
        text: skillInvocationText(skill, hit.args),
        select: 'first-placeholder'
      }
    };
  }
  return {
    ok: true,
    command: visibleCommand(c),
    args: hit.args,
    directive: {
      type: 'client',
      action: c.action,
      args: hit.args
    }
  };
}

module.exports = {
  BUILTIN_COMMANDS,
  applyRecipeDefaults,
  buildIndex,
  catalog,
  cleanName,
  dispatch,
  dynamicCommands,
  parseInput,
  resolve,
  resolveWith,
  skillInvocationText,
  visibleCommand
};
