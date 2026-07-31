/* node test/taskbrief.clarify.test.js — IN-TURN CLARIFY (2026-07-31, Hermes-parity): on a watched run,
   brief.ask blocks on a live asker and resumes the SAME turn with the Commander's answer; every other
   outcome (no asker, no answer, a throwing asker, a stale store write) falls back byte-identically to
   the durable end-run question. The store's answerInTurn mirrors the next-run answer path without
   minting a new brief, and refuses stale writes. Offline + deterministic (fake disk, fake asker). */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { makeTaskBriefStore } = require('../sidecar/taskbrief-store.js');
const { registerTaskBriefTools } = require('../sidecar/taskbrief-tools.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

function fakeDisk() {
  const files = new Map();
  return {
    readFileSync(f) { if (!files.has(f)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(f); },
    writeFileSync(f, d) { files.set(f, d); }, renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
    existsSync(f) { return files.has(f); }, mkdirSync() {}, unlinkSync(f) { files.delete(f); },
    openSync() { return 1; }, fsyncSync() {}, closeSync() {}, _files: files
  };
}
const writeDurable = ({ fs }, file, data) => fs.writeFileSync(file, data);
const makeStore = () => makeTaskBriefStore({ fs: fakeDisk(), path, workspaces: '/ws', writeDurable });

const material = () => ({
  dimension: 'audience',
  question: 'who is this dashboard primarily for?',
  options: ['operators', 'executives', 'customers'],
  recommended: 'operators', reason: 'Audience changes information density and navigation.',
  discoverable: false
});

(async () => {
  // ---- A. an answered live question resumes the SAME turn: answer in content, NO final control ----
  {
    const store = makeStore();
    const brief = await store.prepare({ id: 'tb_a', key: 'stream:a', text: 'Build the dashboard' }, 100);
    const state = { brief };
    const registry = makeRegistry();
    const askedWith = [];
    registerTaskBriefTools(registry, store, state, {
      now: () => 110,
      askCommander: async (f) => { askedWith.push(f); return { answered: true, text: 'executives' }; }
    });
    const r = await registry.dispatch({ name: 'brief.ask', args: material(), argsRaw: '{}' }, {});
    A.ok(r.ok, 'an answered clarify dispatches ok: ' + JSON.stringify(r.content));
    A.ok(!r.control, 'NO final control — the run keeps going in the same turn');
    A.ok(/The Commander answered: "executives"/.test(r.content), 'the answer reaches the model as tool content');
    A.eq(askedWith[0].question, 'who is this dashboard primarily for?', 'the asker sees the validated question');
    A.eq(askedWith[0].recommended, 'operators', 'and the recommendation for the ★ chip');
    A.eq(state.brief.status, 'ready', 'the brief is back to ready — brief.proceed can settle it this turn');
    A.eq(state.brief.questions[0].answer, 'executives', 'the durable record carries the in-turn answer');
    const onDisk = store.active('stream:a');
    A.eq(onDisk.status, 'ready', 'the persisted brief agrees (no split-brain with the in-memory state)');
  }

  // ---- B. an UNANSWERED live question falls back to today's end-run flow, exactly ----
  {
    const store = makeStore();
    const brief = await store.prepare({ id: 'tb_b', key: 'stream:b', text: 'Build it' }, 100);
    const state = { brief };
    const registry = makeRegistry();
    registerTaskBriefTools(registry, store, state, { now: () => 110, askCommander: async () => ({ answered: false }) });
    const r = await registry.dispatch({ name: 'brief.ask', args: material(), argsRaw: '{}' }, {});
    A.eq(r.control && r.control.final, true, 'no live answer -> the durable end-run question, unchanged');
    A.ok(/^TASK_QUESTION: /.test(r.control.text), 'with the marker line the next-run resume path parses');
    A.eq(state.brief.status, 'clarifying', 'the brief stays clarifying for the next reply');
  }

  // ---- C. a THROWING asker can never break the run — same fallback ----
  {
    const store = makeStore();
    const brief = await store.prepare({ id: 'tb_c', key: 'stream:c', text: 'Build it' }, 100);
    const state = { brief };
    const registry = makeRegistry();
    registerTaskBriefTools(registry, store, state, { now: () => 110, askCommander: async () => { throw new Error('transport died'); } });
    const r = await registry.dispatch({ name: 'brief.ask', args: material(), argsRaw: '{}' }, {});
    A.eq(r.control && r.control.final, true, 'a dead asker degrades to the end-run question, never an error');
  }

  // ---- D. NO asker wired (unattended/channel run) = byte-identical old behavior ----
  {
    const store = makeStore();
    const brief = await store.prepare({ id: 'tb_d', key: 'stream:d', text: 'Build it' }, 100);
    const state = { brief };
    const registry = makeRegistry();
    registerTaskBriefTools(registry, store, state, { now: () => 110 });
    const r = await registry.dispatch({ name: 'brief.ask', args: material(), argsRaw: '{}' }, {});
    A.eq(r.control && r.control.final, true, 'without an asker the question ends the run as before');
    A.eq(r.content, 'Waiting for the Commander\'s decision.', 'same content');
  }

  // ---- E. the tool's own timeout covers the wait (the default 30s ctx budget would kill it) ----
  {
    const registry = makeRegistry();
    const store = makeStore();
    registerTaskBriefTools(registry, store, { brief: { id: 'x', status: 'ready', questions: [] } }, { now: () => 0 });
    const def = registry.get('brief.ask');
    A.ok(def.timeoutMs >= 15 * 60 * 1000, 'brief.ask declares a ceiling above the consent timer + ack extension');
  }

  // ---- F. answerInTurn store semantics: open-question only, no new brief, stale writes refused ----
  {
    const store = makeStore();
    const b = await store.prepare({ id: 'tb_f', key: 'stream:f', text: 'Build it' }, 100);
    A.eq(await store.answerInTurn(b.id, 'early', 105), null, 'no open question -> refused');
    await store.ask(b.id, material(), 110);
    const answered = await store.answerInTurn(b.id, 'customers', 120);
    A.eq(answered.status, 'ready', 'answering flips clarifying -> ready');
    A.eq(answered.questions[0].answer, 'customers', 'the open question carries the answer');
    A.eq(answered.questions[0].answeredAt, 120, 'stamped with the answer time');
    A.eq(store.list({}).length, 1, 'no new brief was minted — the SAME record advanced');
    A.eq(await store.answerInTurn(b.id, 'operators', 130), null, 'a second answer to the same question is refused');
    A.eq(answered.questions[0].answer, 'customers', 'and the first answer stands');
    A.eq(await store.answerInTurn('tb_missing', 'x', 140), null, 'an unknown brief id is a harmless no-op');
  }

  A.report('taskbrief.clarify.test');
})();
