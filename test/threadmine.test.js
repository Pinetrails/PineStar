/* node test/threadmine.test.js — the PURE post-run thread-mining producer (NS-6).

   Proves: tagged THREAD/QUOTE blocks parse into candidates; the GROUNDING VETO drops any idea whose quote is NOT
   verbatim in the conversation (invented ideas die); fingerprint dedup vs the live ledger AND the permanent
   declined denylist (a declined idea is never re-mined); the count cap; the NONE/empty/throw paths (a failed mine
   never hurts the run); and that mining STASHES candidates only — it never writes (stash, not auto-commit). */
'use strict';
const A = require('./_assert.js');
const { mine, parse, buildPrompt, mineSalient, fingerprint } = require('../sidecar/threadmine.js');
const { makeClock } = require('../shared/clock-rng.js');

(async () => {
  const run = { agentId: 'ag', runId: 'run_3', streamId: 's1', messages: [
    { role: 'system', content: 'SYS — stripped' },
    { role: 'user', content: 'Can you fix this bug in my parser? Also, unrelated, I keep thinking I should build a price watcher for GPUs someday so I can snag one at MSRP, and honestly I want a Discord bot for my server too for moderation — but not now, just fix the parser bug for me today please.' },
    { role: 'assistant', content: 'Fixed the parser bug — it was an off-by-one in the tokenizer. The other two ideas (price watcher, Discord bot) were not acted on in this run.' }
  ] };

  // ---- happy path: two grounded threads parse, each with a verbatim quote that IS in the conversation ----
  const stub = () =>
    'THREAD: GPU price watcher\nQUOTE: build a price watcher for GPUs someday\n' +
    'THREAD: Discord bot\nQUOTE: I want a Discord bot for my server\n' +
    'THREAD: A totally invented CRM\nQUOTE: build me a CRM for my sales team';   // this quote is NOT in the convo
  const r = await mine(run, { propose: stub, clock: makeClock(500) });
  A.eq(r.proposals.length, 2, 'two grounded threads survive; the invented one (no verbatim quote) is vetoed');
  A.eq(r.proposals[0].title, 'GPU price watcher', 'title parsed off the THREAD tag');
  A.ok(r.proposals[0].spec.indexOf('price watcher for GPUs') >= 0, 'the verbatim QUOTE becomes the spec/evidence');
  A.eq(r.proposals[0].sourceRef.runId, 'run_3', 'provenance: sourceRef.runId stamped');
  A.eq(r.proposals[0].createdAt, 500, 'createdAt from the injected clock');
  A.ok(r.proposals[0].fingerprint === fingerprint('GPU price watcher'), 'fingerprint stamped for dedup');

  // ---- GROUNDING VETO is load-bearing: an all-invented reply mines NOTHING ----
  const invented = await mine(run, { propose: () => 'THREAD: Build a spaceship\nQUOTE: please build me a spaceship', clock: makeClock(0) });
  A.eq(invented.proposals.length, 0, 'a thread whose quote never appears in the conversation is dropped');

  // ---- dedup vs the live ledger + the permanent declined denylist (known fingerprints from the store) ----
  const known = {};
  known[fingerprint('GPU price watcher')] = 'thread';       // already an open thread
  known[fingerprint('Discord bot')] = 'declined';           // permanently declined
  const dd = await mine(run, { propose: stub, clock: makeClock(0), known });
  A.eq(dd.proposals.length, 0, 'a candidate matching a live thread OR a declined fingerprint is not re-mined');

  // ---- count cap ----
  const words = ['alpha bravo', 'charlie delta', 'echo foxtrot', 'golf hotel', 'india juliet', 'kilo lima'];
  const many = () => words.map(w => 'THREAD: build ' + w + ' tool\nQUOTE: build a price watcher for GPUs someday').join('\n');
  // (all share the SAME verbatim quote so they pass the veto; distinct titles so they don't dedup)
  const capped = await mine(run, { propose: many, clock: makeClock(0), max: 3 });
  A.ok(capped.proposals.length === 3, 'proposals are capped at max');

  // ---- NONE / empty / throw: a failed or empty mine never throws and yields no proposals ----
  A.eq((await mine(run, { propose: () => 'NONE', clock: makeClock(0) })).proposals.length, 0, 'NONE → no proposals');
  A.eq((await mine(run, { propose: () => '', clock: makeClock(0) })).proposals.length, 0, 'empty → no proposals');
  A.notThrows(() => {}, 'baseline');
  const threw = await mine(run, { propose: () => { throw new Error('boom'); }, clock: makeClock(0) });
  A.eq(threw.proposals.length, 0, 'a throwing propose is caught — no proposals, no crash');

  // ---- STASH-NOT-AUTOCOMMIT: mine returns candidates and TOUCHES NO STORE. The result is a plain object; there
  //      is no store dependency in mine's signature at all — proving it cannot auto-commit. ----
  A.ok(typeof r === 'object' && Array.isArray(r.proposals) && !r.committed && !r.written, 'mine only produces candidates — never writes / commits');

  // ---- prompt strips system, carries the exchange + a verbatim-quote demand ----
  const built = buildPrompt(run.messages, 6000);
  A.ok(built.prompt.indexOf('price watcher for GPUs') >= 0 && built.prompt.indexOf('VERBATIM') >= 0, 'prompt carries the exchange + demands a verbatim quote');
  A.ok(built.prompt.indexOf('SYS — stripped') < 0, 'system turns stripped from the mining prompt');

  // ---- salience gate ----
  A.ok(mineSalient(run.messages) === true, 'a substantive exchange is mine-salient');
  A.ok(mineSalient([{ role: 'user', content: 'hi' }]) === false, 'a trivial run is not mine-salient');

  A.report('threadmine');
})();
