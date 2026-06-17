/* node test/reflect.test.js — Cortex M-mem.5 reflection producer: pure, injected aux model.
   Proves tagged-line parsing -> structured proposals, secret redaction (§5.6), dedup vs the store +
   within a batch, count cap, the NONE/empty/malformed/throw paths (a failed reflection never hurts the
   run), and determinism. Auto-proposals are candidates only — nothing is written here. */
'use strict';
const A = require('./_assert.js');
const { reflect, parse, buildPrompt } = require('../sidecar/reflect.js');
const { redact } = require('../sidecar/context.js');
const { makeClock } = require('../shared/clock-rng.js');

(async () => {
  const run = { agentId: 'ag', runId: 'run_7', messages: [
    { role: 'system', content: 'SYS — should be stripped' },
    { role: 'user', content: 'I prefer terse answers and I deploy with npm publish' },
    { role: 'assistant', content: 'Understood, Commander.' }
  ] };
  const stub = () => 'PREFERENCE: user prefers terse answers\nFACT: deploys with npm publish\nrandom chatter, no tag\nSKILL: can tag releases';

  // ---- happy path: tagged lines -> structured, stamped, scoped proposals (untagged line ignored) ----
  const r = await reflect(run, { propose: stub, clock: makeClock(500), redact });
  A.eq(r.proposals.length, 3, 'three tagged lines -> three proposals (untagged line ignored)');
  A.eq(r.proposals[0].kind, 'profile', 'PREFERENCE maps to profile');
  A.eq(r.proposals[1].kind, 'fact', 'FACT maps to fact');
  A.eq(r.proposals[2].kind, 'skill', 'SKILL maps to skill');
  A.eq(r.proposals[0].content, 'user prefers terse answers', 'content parsed off the tag');
  A.eq(r.proposals[0].scope, 'global', 'proposals are global by default');
  A.eq(r.proposals[0].streamId, null, 'no stream scope until M-mem.2b');
  A.eq(r.proposals[0].sourceRunId, 'run_7', 'provenance: sourceRunId stamped');
  A.eq(r.proposals[0].createdAt, 500, 'createdAt from the injected clock');
  A.eq(r.proposals[0].id, 'prop_1', 'transient proposal id assigned');

  // ---- prompt carries the user/assistant exchange, strips system ----
  const p = buildPrompt(run.messages, 4000);
  A.ok(p.indexOf('npm publish') >= 0 && p.indexOf('USER:') >= 0, 'prompt carries the exchange');
  A.ok(p.indexOf('should be stripped') < 0, 'system turns are stripped from the reflection prompt');

  // ---- guardrail (§5.6): secret-shaped content is redacted before it can be stored ----
  const leak = await reflect(run, { propose: () => 'FACT: the key is sk-or-v1-0123456789abcdef0123', clock: makeClock(0), redact });
  A.ok(leak.proposals[0].content.indexOf('sk-or-v1') < 0, 'raw key shape scrubbed');
  A.ok(leak.proposals[0].content.indexOf('[redacted-key]') >= 0, 'redaction marker present');

  // ---- dedup: vs the existing store AND within the same batch ----
  const dd = await reflect(run, {
    propose: () => 'FACT: already known\nFACT: already known\nFACT: brand new',
    clock: makeClock(0), redact, existing: [{ kind: 'fact', content: 'already known' }]
  });
  A.eq(dd.proposals.length, 1, 'dupes (vs existing AND within-batch) dropped');
  A.eq(dd.proposals[0].content, 'brand new', 'the genuinely new fact survives');

  // ---- count cap: never dump a wall at the turn-in beat ----
  const wall = await reflect(run, { propose: () => 'FACT: a\nFACT: b\nFACT: c\nFACT: d\nFACT: e\nFACT: f', clock: makeClock(0), redact, max: 3 });
  A.eq(wall.proposals.length, 3, 'proposal count capped at max');

  // ---- NONE / empty / untagged / thrown / missing-propose -> no proposals, never throws ----
  A.eq((await reflect(run, { propose: () => 'NONE', clock: makeClock(0), redact })).proposals.length, 0, 'NONE -> nothing');
  A.eq((await reflect(run, { propose: () => '', clock: makeClock(0), redact })).proposals.length, 0, 'empty -> nothing');
  A.eq((await reflect(run, { propose: () => 'just prose, no tags', clock: makeClock(0), redact })).proposals.length, 0, 'untagged prose -> nothing');
  A.eq((await reflect(run, { propose: () => { throw new Error('model down'); }, clock: makeClock(0), redact })).proposals.length, 0, 'a thrown reflection yields nothing (run unaffected)');
  A.eq((await reflect(run, { clock: makeClock(0) })).proposals.length, 0, 'no propose fn -> nothing');

  // ---- determinism ----
  const a = await reflect(run, { propose: stub, clock: makeClock(500), redact });
  const b = await reflect(run, { propose: stub, clock: makeClock(500), redact });
  A.eq(JSON.stringify(a.proposals), JSON.stringify(b.proposals), 'reflect is deterministic for the same inputs');

  A.report('reflect.test');
})();
