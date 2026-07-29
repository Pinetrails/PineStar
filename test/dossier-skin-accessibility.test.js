'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
const start = source.indexOf('  function agCommand(a) {');
const end = source.indexOf('\n  function agGrowth(a) {', start);

A.ok(start >= 0 && end > start, 'the dossier skin renderer can be isolated from stationui.js');

const render = vm.runInNewContext(
  source.slice(start, end) + '\n  agCommand;',
  {
    DATA: {
      DEFAULT_SKIN: 'cadet',
      SKINS: {
        cadet: { name: 'Cadet', set: 'cadet' },
        bear: { name: 'Teddy Bear', set: 'bear' }
      }
    },
    access: { config: { crewCount: () => 1 } },
    present: [{ id: 'agent' }],
    esc: value => String(value)
  }
);

for (const selected of ['cadet', 'bear']) {
  const html = render({ id: 'agent', role: 'orchestrator', skin: selected });
  const buttons = [...html.matchAll(/<button type="button" class="skin-thumb ag-skin-thumb([^"]*)"[^>]*data-skin="([^"]+)"[^>]*aria-pressed="([^"]+)"/g)]
    .map(match => ({ className: match[1], skin: match[2], pressed: match[3] }));

  A.eq(buttons.length, 2, 'every dossier skin button exposes its pressed state');
  A.eq(buttons.filter(button => button.pressed === 'true').length, 1, 'exactly one dossier skin is announced as selected');
  const announced = buttons.find(button => button.pressed === 'true');
  const visual = buttons.find(button => button.skin === selected);
  A.eq(announced && announced.skin, selected, 'aria-pressed follows the skin the agent actually wears');
  A.ok(visual && visual.className.includes('sel'), 'the visual selection matches the announced selection');
  A.ok(buttons.filter(button => button.skin !== selected).every(button => button.pressed === 'false'),
    'every unselected dossier skin is announced as unpressed');
}

A.report('dossier-skin-accessibility.test');
