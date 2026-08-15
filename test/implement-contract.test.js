/* node test/implement-contract.test.js — the PROMPT/MANIFEST contract behind the delivery card's Implement action.

   THE BUG THIS LOCKS (2026-07-07 → 2026-08-14, five weeks live): the night-shift build directive told the agent
   "set the manifest kind to patch" for a project change, while the manifest SHAPE printed two lines below it
   listed `"kind": "tool|fix|draft|doc|other"` — no `patch`. A model following the shape emitted kind:"doc", and
   the whole apply-to-a-branch path (nightpatch.patchTargetFrom fires ONLY on kind === 'patch') became dead code.
   Worse, the savedOnly/patchRefused honesty fields are keyed on the SAME kind, so a patch that was merely COPIED
   still reported "✓ implemented". The rule and the shape must never disagree again — that is what this asserts.

   Also locks the `planOnly` declaration the card reads to decide whether Implement means "land the files" or
   "build what this describes". */
'use strict';
const A = require('./_assert.js');
const AP = require('../frontend/app/autopilot.js');

const selected = { title: 'Add a retry to the uploader', grounds: 'they said uploads fail', spec: 'a patch that retries 3x' };

(function shapeListsPatch() {
  const d = AP.buildDoDirectiveV2(selected, { runId: 'r1', dir: 'workshop/r1', backlogId: 'b1' });
  const shape = d.split('\n').find(l => l.indexOf('"kind"') >= 0) || '';
  A.ok(shape, 'the build directive prints a manifest shape line naming "kind"');
  A.ok(/patch/.test(shape), 'the kind enum LISTS patch — without it the apply path is unreachable (regression 2026-07-07)');
  // every other kind the validator accepts must still be offered, so this fix never narrows the contract.
  ['tool', 'fix', 'draft', 'doc', 'other'].forEach(k => A.ok(shape.indexOf(k) >= 0, 'the kind enum still offers "' + k + '"'));
})();

(function ruleAndShapeAgree() {
  const ctx = { runId: 'r2', dir: 'workshop/r2', backlogId: 'b2', targetRoot: 'C:/proj/alpha', projectSnapshot: 'HEAD: abc123\nM src/up.js' };
  const d = AP.buildDoDirectiveV2(selected, ctx);
  A.ok(/THIS IS A PROJECT PATCH/.test(d), 'with a project target the directive carries the PROJECT PATCH rule');
  A.ok(/"kind":"patch"/.test(d), 'and the rule tells the agent to set kind:"patch"');
  const shape = d.split('\n').find(l => l.indexOf('"kind":') >= 0 && l.indexOf('|') >= 0) || '';
  A.ok(/patch/.test(shape), 'and the manifest SHAPE offers patch too — the rule and the shape agree');
})();

(function planOnlyIsDeclared() {
  const d = AP.buildDoDirectiveV2(selected, { runId: 'r3', dir: 'workshop/r3', backlogId: 'b3' });
  A.ok(/"planOnly"/.test(d), 'the manifest shape asks the shift to declare planOnly');
  A.ok(/DESCRIBES work/.test(d), 'and defines it as "describes work rather than being the finished thing"');
})();

A.report();
