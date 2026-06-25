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

A.report('slash.test');
