/* node test/slash.test.js -- slash-command registry and dispatch descriptors. */
'use strict';

const A = require('./_assert.js');
const S = require('../sidecar/slash.js');

{
  const cat = S.catalog();
  const names = cat.commands.map(c => c.name).sort();
  const required = [
    'agents', 'background', 'blueprint', 'branch', 'bundles', 'clear', 'compress', 'copy', 'cron',
    'debug', 'fast', 'goal', 'help', 'history', 'insights', 'memory', 'model', 'new', 'personality', 'queue',
    'reasoning', 'reload-mcp', 'reload-skills', 'resume', 'retry', 'save', 'skills',
    'status', 'steer', 'stop', 'subgoal', 'suggestions', 'title', 'tools', 'undo',
    'usage', 'version', 'voice', 'whoami', 'yolo'
  ];
  A.eq(names, required.slice().sort(), 'catalog exposes the built-in workflow commands');
  A.ok(cat.commands.every(c => c.source === 'builtin'), 'catalog marks built-ins');
  A.ok(cat.commands.every(c => c.dispatch === 'client'), 'catalog commands dispatch to client directives');
  A.ok(cat.commands.find(c => c.name === 'new').aliases.indexOf('reset') >= 0, 'new exposes /reset alias');
  A.ok(cat.commands.find(c => c.name === 'branch').aliases.indexOf('fork') >= 0, 'branch exposes /fork alias');
  A.ok(cat.commands.find(c => c.name === 'queue').aliases.indexOf('q') >= 0, 'queue exposes /q alias');
  A.ok(cat.commands.find(c => c.name === 'resume').aliases.indexOf('sessions') >= 0, 'resume exposes /sessions alias');
  A.ok(cat.commands.find(c => c.name === 'background').aliases.indexOf('bg') >= 0, 'background exposes /bg alias');
  A.ok(cat.commands.find(c => c.name === 'suggestions').aliases.indexOf('suggest') >= 0, 'suggestions exposes /suggest alias');
  A.ok(cat.commands.find(c => c.name === 'blueprint').aliases.indexOf('bp') >= 0, 'blueprint exposes /bp alias');
  A.ok(cat.commands.find(c => c.name === 'reload-mcp').aliases.indexOf('reload_mcp') >= 0, 'reload-mcp exposes underscore alias');
  A.ok(cat.commands.find(c => c.name === 'reload-skills').aliases.indexOf('reload_skills') >= 0, 'reload-skills exposes underscore alias');
  A.ok(cat.commands.find(c => c.name === 'version').aliases.indexOf('v') >= 0, 'version exposes /v alias');
}

{
  const r = S.dispatch('/retry');
  A.ok(r.ok, 'dispatch resolves /retry');
  A.eq(r.command.name, 'retry', 'dispatch returns canonical command name');
  A.eq(r.directive, { type: 'client', action: 'retry', args: '' }, 'dispatch returns a typed client directive');
}

{
  const r = S.dispatch(' /help  details please ');
  A.ok(r.ok, 'dispatch accepts optional leading slash and whitespace');
  A.eq(r.command.name, 'help', 'dispatch resolves help');
  A.eq(r.args, 'details please', 'dispatch preserves trailing args');
  A.eq(r.directive.args, 'details please', 'directive carries args');
}

{
  const fork = S.dispatch('/fork copy this thread');
  A.ok(fork.ok, 'dispatch resolves /fork alias');
  A.eq(fork.command.name, 'branch', 'fork alias canonicalizes to branch');
  A.eq(fork.directive, { type: 'client', action: 'branch', args: 'copy this thread' }, 'branch dispatch returns a client directive with args');
  const q = S.dispatch('/q next note');
  A.eq(q.command.name, 'queue', 'q alias canonicalizes to queue');
  A.eq(q.directive.action, 'queue', 'q dispatch runs queue action');
  const reload = S.dispatch('/reload_skills');
  A.eq(reload.command.name, 'reload-skills', 'reload_skills alias canonicalizes');
  A.eq(reload.directive.action, 'reload-skills', 'reload alias runs reload-skills action');
  const model = S.dispatch('/model openai/gpt-5');
  A.eq(model.directive, { type: 'client', action: 'model', args: 'openai/gpt-5' }, 'model dispatch carries model id args');
  const reset = S.dispatch('/reset');
  A.eq(reset.command.name, 'new', 'reset alias canonicalizes to new');
  const sessions = S.dispatch('/sessions 2');
  A.eq(sessions.directive, { type: 'client', action: 'resume', args: '2' }, 'sessions alias dispatches to resume');
  const bg = S.dispatch('/bg write a report');
  A.eq(bg.command.name, 'background', 'bg alias canonicalizes to background');
  A.eq(bg.directive.action, 'background', 'bg dispatch runs background action');
  const bp = S.dispatch('/bp morning-brief');
  A.eq(bp.directive, { type: 'client', action: 'blueprint', args: 'morning-brief' }, 'bp alias dispatches to blueprint');
  const mcp = S.dispatch('/reload_mcp github');
  A.eq(mcp.command.name, 'reload-mcp', 'reload_mcp alias canonicalizes');
  A.eq(mcp.directive.action, 'reload-mcp', 'reload_mcp dispatch runs reload-mcp action');
  const ver = S.dispatch('/v');
  A.eq(ver.directive.action, 'version', 'v alias dispatches to version');
  // slash-parity: the Hermes-parity commands resolve, aliases canonicalize, and args flow through.
  A.eq(S.dispatch('/clear').directive, { type: 'client', action: 'clear', args: '' }, 'clear dispatches to clear');
  A.eq(S.dispatch('/cls').command.name, 'clear', 'cls alias canonicalizes to clear');
  A.eq(S.dispatch('/history 5').directive, { type: 'client', action: 'history', args: '5' }, 'history dispatch carries the count arg');
  A.eq(S.dispatch('/hist').command.name, 'history', 'hist alias canonicalizes to history');
  A.eq(S.dispatch('/whoami').directive.action, 'whoami', 'whoami dispatches to whoami');
  A.eq(S.dispatch('/insights').directive.action, 'insights', 'insights dispatches to insights');
  const catP = S.catalog();
  A.ok(catP.commands.find(c => c.name === 'clear').aliases.indexOf('cls') >= 0, 'clear exposes /cls alias');
  A.ok(catP.commands.find(c => c.name === 'history').aliases.indexOf('hist') >= 0, 'history exposes /hist alias');
}

{
  const r = S.dispatch('/nope');
  A.eq(r.ok, false, 'unknown command is not ok');
  A.eq(r.status, 404, 'unknown command asks endpoint to return 404');
}

{
  const idx = S.buildIndex([
    { name: 'new', aliases: ['reset'], action: 'new' },
    { name: 'queue', aliases: ['q'], action: 'queue' }
  ]);
  A.eq(idx.byToken.get('reset').name, 'new', 'aliases resolve to their canonical command');
  A.eq(idx.byToken.get('q').name, 'queue', 'short aliases resolve');
}

{
  A.throws(() => S.buildIndex([{ name: 'retry' }, { name: 'retry' }]), 'duplicate canonical command rejected');
  A.throws(() => S.buildIndex([{ name: 'new', aliases: ['n'] }, { name: 'notes', aliases: ['n'] }]), 'duplicate alias rejected');
  A.throws(() => S.buildIndex([{ name: 'bad command' }]), 'invalid command token rejected');
}

{
  const recipe = {
    id: 'morning-brief',
    name: 'Morning Brief',
    emoji: 'sun',
    tagline: 'Daily digest',
    params: [
      { key: 'topic', required: true },
      { key: 'window', required: false, default: 'the last 24 hours' }
    ],
    task: 'Brief me on {topic} in {window}.'
  };
  const skill = {
    slug: 'plan',
    name: 'Make a Plan',
    description: 'Write the approach first.',
    body: 'PLANBODY',
    available: true,
    enabled: false
  };
  const cat = S.catalog({ recipes: [recipe], skills: [skill] });
  const names = cat.commands.map(c => c.name);
  A.ok(names.indexOf('morning-brief') >= 0, 'dynamic catalog includes built-in recipes');
  A.ok(names.indexOf('plan') >= 0, 'dynamic catalog includes available skills');
  A.ok(cat.commands.find(c => c.name === 'plan').enabled === false, 'skill command preserves enabled metadata');

  const recipeRun = S.dispatch('/morning-brief AI tooling', { recipes: [recipe], skills: [skill] });
  A.eq(recipeRun.directive.type, 'insert', 'recipe command dispatch inserts text');
  A.eq(recipeRun.directive.source, 'recipe', 'recipe directive names its source');
  A.eq(recipeRun.directive.text, 'Brief me on AI tooling in the last 24 hours.', 'recipe dispatch fills one required arg plus optional defaults');

  const skillRun = S.dispatch('/plan refactor the slash registry', { recipes: [recipe], skills: [skill] });
  A.eq(skillRun.directive.type, 'insert', 'skill command dispatch inserts text');
  A.ok(skillRun.directive.text.indexOf('PLANBODY') >= 0, 'skill dispatch includes the skill body');
  A.ok(skillRun.directive.text.indexOf('refactor the slash registry') >= 0, 'skill dispatch preserves slash args as the task');
}

{
  const recipe = { id: 'code-review', name: 'Code Review', params: [], task: 'Review {target}.' };
  const skill = { slug: 'code-review', name: 'Code Review Skill', body: 'SKILLBODY', available: true };
  const cat = S.catalog({ recipes: [recipe], skills: [skill] });
  const names = cat.commands.map(c => c.name);
  A.ok(names.indexOf('code-review') >= 0, 'recipe keeps the natural colliding slash name');
  A.ok(names.indexOf('skill-code-review') >= 0, 'colliding skill receives a safe prefixed slash name');
  A.eq(S.dispatch('/code-review', { recipes: [recipe], skills: [skill] }).directive.source, 'recipe', 'colliding natural command dispatches to recipe');
  A.eq(S.dispatch('/skill-code-review', { recipes: [recipe], skills: [skill] }).directive.source, 'skill', 'prefixed collision command dispatches to skill');
}

{
  const skill = { slug: 'test-driven-development', name: 'TDD', body: 'TDDBODY', available: false };
  const cat = S.catalog({ skills: [skill] });
  A.ok(cat.commands.every(c => c.name !== 'test-driven-development'), 'unavailable skills are omitted from slash catalog');
  A.eq(S.dispatch('/test-driven-development', { skills: [skill] }).status, 404, 'unavailable skill command is not dispatchable');
}

A.report('slash.test');
