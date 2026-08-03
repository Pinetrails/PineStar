/* node test/onboarding-legibility.test.js — replayable first-command tour + total glossary hint coverage. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Glossary = require('../frontend/app/glossary.js');

(function () {
  const root = path.resolve(__dirname, '..');
  const files = [path.join(root, 'frontend', 'index.html')];
  for (const dir of [path.join(root, 'frontend', 'app'), path.join(root, 'frontend', 'app', 'windows')]) {
    for (const name of fs.readdirSync(dir)) if (name.endsWith('.js')) files.push(path.join(dir, name));
  }
  const used = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/data-hint=(?:"|')([^"']+)(?:"|')/g)) {
      // Dynamic template expressions are tested by their producers; this gate owns literal UI vocabulary.
      if (!/[+${}<>]/.test(match[1])) used.add(match[1].trim().toLowerCase());
    }
  }
  const missing = [...used].filter(term => !Glossary.has(term));
  A.eq(missing, [], 'every literal data-hint in the shipped UI resolves to glossary copy');
  for (const term of ['agent', 'crew', 'model', 'provider', 'run', 'approval', 'transcript', 'deliverable', 'artifact', 'verification', 'context', 'fallback', 'settings', 'update', 'restore', 'logbook', 'notification', 'manual']) {
    A.ok(Glossary.has(term), 'everyday harness term is explained: ' + term);
    const sentence = Glossary.lookup(term);
    A.ok(sentence.length >= 25 && /[.!?]$/.test(sentence), term + ' is a useful one-sentence definition');
  }

  // Drive the actual tutorial module with a returning-user state. The ordinary entry remains one-shot,
  // while replayFirstCommand deliberately re-enters the same real tour without clearing saved progress.
  const tutorialSrc = fs.readFileSync(path.join(root, 'frontend', 'app', 'tutorial.js'), 'utf8');
  let opens = 0;
  let closedManual = 0;
  const context = vm.createContext({
    console, setTimeout, clearTimeout, Promise,
    localStorage: { getItem: () => JSON.stringify({ v: 1, firstCommandDone: true, seen: {}, brief: { command: true }, briefDismissed: true, briefComplete: false }), setItem() {} },
    Chat: { typeLine() {}, localLine() {}, choices() {} },
    Dialogue: { open() { opens++; }, node() { return new Promise(() => {}); }, isOpen() { return false; }, close() {} },
    StationUI: { closeTerm(key) { if (key === 'manual') closedManual++; } },
    U: { bus: { on() {} } },
    document: { querySelector() { return null; }, getElementById() { return null; }, body: { contains() { return false; }, appendChild() {}, style: {} } },
    window: { addEventListener() {}, removeEventListener() {} },
    matchMedia: () => ({ matches: true })
  });
  vm.runInContext(tutorialSrc, context, { filename: 'tutorial.js' });
  vm.runInContext('Tutorial.firstCommand({name:"NOVA"})', context);
  A.eq(opens, 0, 'returning users are not forced through the automatic tour again');
  const replayed = vm.runInContext('Tutorial.replayFirstCommand()', context);
  A.ok(replayed && opens === 1, 'Field Manual replay enters the real quick-tour flow for a returning user');
  A.eq(closedManual, 1, 'replay closes the Field Manual before the Dialogue lesson can be covered');
  A.ok(/fm-replay/.test(tutorialSrc) && /replay\.onclick = \(\) =>/.test(tutorialSrc), 'Field Manual renders and wires REPLAY QUICK TOUR');

  A.report('onboarding-legibility.test');
})();
