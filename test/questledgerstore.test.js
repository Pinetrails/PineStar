/* node test/questledgerstore.test.js — the pure shaping surface of the QUEST V2 ledger's frontend citizen
   (frontend/app/questledgerstore.js). The live poll/fetch/beat wiring is browser-only; here we lock the two
   pure pieces the projection depends on: _shape (backend record → the shared quest shape) and _apply (the
   cache-rebuild that feeds quests()/pendingAttests()). No fetch/Chat/DOM is touched at module load or by these. */
'use strict';
const A = require('./_assert.js');
const { QuestLedgerStore: QLS } = require('../frontend/app/questledgerstore.js');

/* ---------- _shape: a backend record → the shared quest shape ---------- */
const s = QLS._shape({ id: 'q:5', kind: 'generated', title: 'Automate the digest', desc: 'the agent proposed this', reward: 'a standing digest', status: 'open', contract: { type: 'prop', key: 'dish' }, steps: [{ key: 'a', label: 'A', done: false }], attest: null, declineNote: null, groundedIn: 'goals dim' });
A.eq(s.id, 'q:5', 'shape keeps the ledger id (already q:N)');
A.eq(s.kind, 'ledger', 'shape stamps kind:ledger so handlers/dismiss route unambiguously');
A.eq(s.ledgerKind, 'generated', 'the backend kind rides along as ledgerKind (for the row copy)');
A.eq(s.contract, { type: 'prop', key: 'dish' }, 'the completion contract is carried through');
A.eq(s.status, 'open', 'open status preserved');
A.eq(s.groundedIn, 'goals dim', 'the grounding cite survives');
A.eq(s.steps.length, 1, 'steps carry through');

/* ---------- _shape: a pending attest is present only while confirmed:null ---------- */
const pend = QLS._shape({ id: 'q:6', kind: 'user', title: 'Ship the report', status: 'open', contract: { type: 'attest', key: '' }, attest: { agentId: 'agent', runId: 'r1', evidence: 'built and tested the report', at: 5, confirmed: null } });
A.ok(pend.attest && pend.attest.evidence === 'built and tested the report', 'a pending attest (confirmed:null) is surfaced with its evidence');
const settled = QLS._shape({ id: 'q:7', kind: 'user', title: 'X', status: 'done', contract: { type: 'attest', key: '' }, attest: { agentId: 'agent', evidence: 'e', at: 5, confirmed: true } });
A.eq(settled.attest, null, 'a confirmed attest is history, never a pending ask on the row');

/* ---------- _shape: fail-soft on junk ---------- */
const junk = QLS._shape({ id: 'q:8' });
A.eq(junk.contract, { type: 'attest', key: '' }, 'a record with no contract degrades to a safe attest shape, never throws');
A.eq(junk.status, 'open', 'a record with no status defaults open');

/* ---------- _apply + quests()/pendingAttests(): dismissed filtered, open+done kept ---------- */
QLS._apply([
  { id: 'q:1', status: 'open', kind: 'user', title: 'a', contract: { type: 'attest', key: '' }, attest: { agentId: 'agent', evidence: 'did the real thing', at: 1, confirmed: null } },
  { id: 'q:2', status: 'dismissed', kind: 'user', title: 'b', contract: { type: 'attest', key: '' } },
  { id: 'q:3', status: 'done', kind: 'work', title: 'c', contract: { type: 'run', key: 'run-9' } }
]);
const qs = QLS.quests();
A.eq(qs.length, 2, 'dismissed records are filtered out; open + done are kept');
A.ok(qs.every(x => x.kind === 'ledger'), 'every cached quest is shaped to kind:ledger');
A.ok(qs.some(x => x.id === 'q:3' && x.status === 'done'), 'a done ledger quest stays (so the QuestState fold sees its open→done edge and celebrates)');
A.eq(QLS.pendingAttests().length, 1, 'exactly one open quest carries a pending attest');
A.eq(QLS.pendingAttests()[0].id, 'q:1', '…and it is the attesting quest');

/* ---------- _apply is defensive ---------- */
A.notThrows(() => QLS._apply(null), '_apply(null) never throws');
A.eq(QLS.quests().length, 0, '…and clears the cache to empty');

A.report('questledgerstore.test');
