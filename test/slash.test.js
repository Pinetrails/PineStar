/* node test/slash.test.js -- slash-command registry and dispatch descriptors. */
'use strict';

const A = require('./_assert.js');
const S = require('../sidecar/slash.js');

{
  const cat = S.catalog();
  const names = cat.commands.map(c => c.name).sort();
  A.eq(names, ['copy', 'help', 'retry', 'stop'], 'catalog exposes the Plan 1 built-ins');
  A.ok(cat.commands.every(c => c.source === 'builtin'), 'catalog marks built-ins');
  A.ok(cat.commands.every(c => c.dispatch === 'client'), 'catalog commands dispatch to client directives');
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
