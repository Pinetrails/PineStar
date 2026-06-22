/* node test/reflect.test.js — Cortex M-mem.5 reflection producer: pure, injected aux model.
   Proves tagged-line parsing -> structured proposals, secret redaction (§5.6), dedup vs the store +
   within a batch, count cap, the NONE/empty/malformed/throw paths (a failed reflection never hurts the
   run), and determinism. Auto-proposals are candidates only — nothing is written here. */
'use strict';
const A = require('./_assert.js');
const { reflect, parse, buildPrompt, worthReflecting, recordFromProposal, feedbackFor } = require('../sidecar/reflect.js');
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

  // ---- near-duplicate (paraphrase) dedup: Jaccard, not just exact text (Hermes-parity) ----
  const near = await reflect(run, {
    propose: () => 'PREFERENCE: Andrew prefers running npm start over serve\nFACT: the reactor gauge is cost-driven',
    clock: makeClock(0), redact, existing: [{ kind: 'profile', content: 'Andrew prefers npm start over serve' }]
  });
  A.eq(near.proposals.length, 1, 'a paraphrase of an existing belief is dropped (exact-text dedup would have missed it)');
  A.eq(near.proposals[0].content, 'the reactor gauge is cost-driven', 'the genuinely-distinct belief survives near-dup dedup');
  // near-dup also applies WITHIN the batch: a reworded repeat of an earlier accepted proposal is dropped
  const nearBatch = await reflect(run, {
    propose: () => 'FACT: deploys to production with npm publish then tag the release\nFACT: deploys to production with npm publish then tags the release',
    clock: makeClock(0), redact
  });
  A.eq(nearBatch.proposals.length, 1, 'a within-batch paraphrase of an earlier proposal is dropped');

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

  // ---- M-mem.5b turn-in helpers (pure) ----

  // worthReflecting: gate one aux call to a real exchange (needs a user + agent turn AND enough substance)
  A.eq(worthReflecting(run.messages, 10), true, 'a real user+agent exchange is worth reflecting');
  A.eq(worthReflecting([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }]), false, 'a trivial exchange is below the substance floor');
  A.eq(worthReflecting([{ role: 'user', content: 'x'.repeat(500) }]), false, 'no agent turn -> not worth reflecting');
  A.eq(worthReflecting([{ role: 'assistant', content: 'x'.repeat(500) }]), false, 'no user turn -> not worth reflecting');
  A.eq(worthReflecting(null), false, 'garbage in -> not worth reflecting (never throws)');

  // recordFromProposal: a Kept proposal becomes the §5.2 notebook record (content mirrors into body for the
  // legacy title/body readers; title is the kind label; stats start at 0; provenance + clock injected).
  const prop = { id: 'prop_2', kind: 'profile', content: 'user prefers terse answers', scope: 'global', streamId: null };
  const rec = recordFromProposal(prop, { now: 900, runId: 'run_7', id: 'note_3' });
  A.eq(rec.id, 'note_3', 'host-assigned store id used');
  A.eq(rec.kind, 'profile', 'kind carried from the proposal');
  A.eq(rec.title, 'Preference', 'profile -> "Preference" label title');
  A.eq(rec.body, 'user prefers terse answers', 'content mirrored into body (legacy readers render it)');
  A.eq(rec.content, 'user prefers terse answers', '§5.2 content field set (rank() reads this)');
  A.eq(rec.sourceRunId, 'run_7', 'provenance: sourceRunId stamped');
  A.eq(rec.createdAt, 900, 'createdAt + ts from the injected clock');
  A.eq(rec.ts, 900, 'ts mirrors createdAt for legacy ordering');
  A.eq(rec.trust, 0, 'trust starts at 0 — it rides the memory.feedback event log, never seeded');
  A.eq(rec.useCount, 0, 'useCount starts at 0');
  A.eq(rec.pinned, false, 'not pinned by default');
  // an Edit supplies replacement content; an unknown kind falls back to a Note label
  const edited = recordFromProposal(prop, { now: 1, id: 'note_4', content: '  fixed up text  ' });
  A.eq(edited.content, 'fixed up text', 'edited content used + trimmed');
  A.eq(recordFromProposal({ kind: 'fact', content: 'f' }, { now: 0 }).title, 'Fact', 'fact -> "Fact" label');
  A.eq(recordFromProposal({ kind: 'weird', content: 'w' }, { now: 0 }).title, 'Note', 'unknown kind -> "Note" label');

  // feedbackFor: Keep/Edit positive (XP + a good confidence sample), Discard negative (a bad sample), else null
  A.eq(feedbackFor('keep').delta, 2, 'keep is the strong positive');
  A.eq(feedbackFor('keep').reason, 'kept', 'keep reason');
  A.eq(feedbackFor('edit').delta, 1, 'edit is the lighter positive (it needed fixing)');
  A.ok(feedbackFor('discard').delta < 0, 'discard is negative (calibrates confidence down)');
  A.eq(feedbackFor('discard').reason, 'discarded', 'discard reason');
  A.eq(feedbackFor('nonsense'), null, 'an unknown verdict yields no feedback');

  A.report('reflect.test');
})();
