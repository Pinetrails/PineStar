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
  return {
    name: c.name,
    aliases: (c.aliases || []).slice(),
    category: c.category || 'General',
    desc: c.desc || '',
    argsHint: c.argsHint || '',
    source: c.source || 'builtin',
    action: c.action || '',
    dispatch: c.dispatch || 'client'
  };
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

function parseInput(input) {
  const text = String(input || '').trim();
  const noSlash = text.replace(/^\//, '');
  const m = noSlash.match(/^([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return { token: '', args: '' };
  return { token: cleanName(m[1]), args: String(m[2] || '').trim() };
}

function resolve(input) {
  const parsed = parseInput(input);
  const command = parsed.token ? INDEX.byToken.get(parsed.token) : null;
  return command ? { command, args: parsed.args, token: parsed.token } : null;
}

function catalog() {
  return { commands: BUILTIN_COMMANDS.map(visibleCommand) };
}

function dispatch(input) {
  const hit = resolve(input);
  if (!hit) return { ok: false, error: 'unknown slash command', status: 404 };
  const c = hit.command;
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
  buildIndex,
  catalog,
  cleanName,
  dispatch,
  parseInput,
  resolve,
  visibleCommand
};
