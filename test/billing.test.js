/* node test/billing.test.js - managed-credit billing invariants, with an injected
   payment client and no real money/provider calls. */
'use strict';
const A = require('./_assert.js');
const { makeBilling } = require('../sidecar/billing.js');

function fakePayment(seed) {
  const balances = Object.assign({}, seed || {});
  const calls = [];
  return {
    calls,
    balance(accountId) {
      calls.push({ op: 'balance', accountId });
      return balances[accountId] || 0;
    },
    debit(accountId, usd, meta) {
      calls.push({ op: 'debit', accountId, usd, meta });
      if ((balances[accountId] || 0) < usd) throw new Error('insufficient');
      balances[accountId] = (balances[accountId] || 0) - usd;
      return { ok: true, balance: balances[accountId] };
    },
    credit(accountId, usd, meta) {
      calls.push({ op: 'credit', accountId, usd, meta });
      balances[accountId] = (balances[accountId] || 0) + usd;
      return { ok: true, balance: balances[accountId] };
    },
    get(accountId) { return balances[accountId] || 0; }
  };
}

function fakeLedger() {
  const rows = [];
  return { rows, record(e) { rows.push(e); return e; } };
}

// ---- managed run: reserve once before paid work, then refund unused headroom on reconciled final spend ----
{
  const payment = fakePayment({ acct: 10 });
  const ledger = fakeLedger();
  const billing = makeBilling({ payment, ledger, clock: { now: () => 123 } });

  const auth = billing.beginRun({ mode: 'managed', accountId: 'acct', runId: 'r1', agentId: 'a', capUsd: 4 });
  A.eq(auth.ok, true, 'managed beginRun authorizes when balance covers the run cap');
  A.eq(payment.get('acct'), 6, 'beginRun reserves the run cap before paid work starts');
  A.eq(payment.calls.filter(c => c.op === 'debit').length, 1, 'reserve debits exactly once');

  const settled = billing.finishRun({ runId: 'r1', reason: 'done', usd: 1.25, tokens: 100, turns: 2 });
  A.eq(settled.ok, true, 'finishRun settles the managed run');
  A.eq(settled.usd, 1.25, 'settlement reports reconciled final spend');
  A.ok(Math.abs(payment.get('acct') - 8.75) < 1e-9, 'unused reserved credit is refunded');
  A.eq(payment.calls.filter(c => c.op === 'credit').length, 1, 'refund is emitted once');
  A.eq(ledger.rows.length, 1, 'managed final spend is recorded once');
  A.eq(ledger.rows[0].billingMode, 'managed', 'ledger entry is marked managed');

  const again = billing.finishRun({ runId: 'r1', reason: 'done', usd: 1.25 });
  A.eq(again.ok, true, 'settlement is idempotent');
  A.eq(payment.calls.filter(c => c.op === 'credit').length, 1, 'idempotent settlement does not refund twice');
  A.eq(ledger.rows.length, 1, 'idempotent settlement does not double-record');
}

// ---- exhausted balance: block before any debit/provider work can happen ----
{
  const payment = fakePayment({ acct: 0.5 });
  const billing = makeBilling({ payment });
  const auth = billing.beginRun({ mode: 'managed', accountId: 'acct', runId: 'r2', capUsd: 1 });
  A.eq(auth.ok, false, 'insufficient managed balance is refused');
  A.eq(auth.reason, 'managed_credits_exhausted', 'exhaustion reason is explicit');
  A.eq(payment.calls.filter(c => c.op === 'debit').length, 0, 'no debit occurs after an exhausted preflight');
}

// ---- failed/cancelled managed run: full unused amount returns, still with exactly-one final record ----
{
  const payment = fakePayment({ acct: 3 });
  const ledger = fakeLedger();
  const billing = makeBilling({ payment, ledger });
  A.eq(billing.beginRun({ mode: 'managed', accountId: 'acct', runId: 'r3', capUsd: 2 }).ok, true, 'reserve succeeds');
  const settled = billing.finishRun({ runId: 'r3', reason: 'error', usd: 0, tokens: 0, turns: 0 });
  A.eq(settled.ok, true, 'failed run settles cleanly');
  A.eq(payment.get('acct'), 3, 'failed zero-spend run gets a full refund');
  A.eq(ledger.rows[0].reason, 'error', 'failed managed run records its terminal reason');
}

// ---- BYOK isolation: BYOK never touches managed balances or payment credentials ----
{
  const payment = fakePayment({ acct: 10 });
  const ledger = fakeLedger();
  const billing = makeBilling({ payment, ledger });
  A.eq(billing.beginRun({ mode: 'byok', accountId: 'acct', runId: 'r4', capUsd: 5 }).ok, true, 'BYOK beginRun succeeds');
  A.eq(payment.calls.length, 0, 'BYOK beginRun performs no managed payment calls');
  const settled = billing.finishRun({ runId: 'r4', reason: 'done', usd: 2, tokens: 10, turns: 1 });
  A.eq(settled.ok, true, 'BYOK finishRun succeeds');
  A.eq(payment.calls.length, 0, 'BYOK finishRun performs no managed payment calls');
  A.eq(ledger.rows.length, 0, 'BYOK is not recorded as a managed-credit debit');
}

// ---- payment persistence failures fail closed for managed credits ----
{
  const payment = {
    balance() { return 10; },
    debit() { throw new Error('store unavailable'); },
    credit() { throw new Error('store unavailable'); }
  };
  const ledger = fakeLedger();
  const billing = makeBilling({ payment, ledger });
  const auth = billing.beginRun({ mode: 'managed', accountId: 'acct', runId: 'r5', capUsd: 1 });
  A.eq(auth.ok, false, 'debit failure refuses the managed run');
  A.eq(auth.reason, 'managed_credit_unavailable', 'debit failure is a closed billing failure');
  A.eq(ledger.rows.length, 0, 'failed authorization records no spend');
}

// ---- final spend persistence failures fail closed before refunding reserved credit ----
{
  const payment = fakePayment({ acct: 5 });
  const ledger = { record() { throw new Error('ledger unavailable'); } };
  const billing = makeBilling({ payment, ledger });
  A.eq(billing.beginRun({ mode: 'managed', accountId: 'acct', runId: 'r6', capUsd: 3 }).ok, true, 'managed run reserves credit');
  const settled = billing.finishRun({ runId: 'r6', reason: 'done', usd: 1, tokens: 10, turns: 1 });
  A.eq(settled.ok, false, 'ledger failure refuses managed finalization');
  A.eq(settled.reason, 'managed_credit_unavailable', 'ledger failure is a closed billing failure');
  A.eq(payment.get('acct'), 2, 'no refund is issued before final spend is recorded');
  A.eq(payment.calls.filter(c => c.op === 'credit').length, 0, 'failed finalization does not credit managed balance');
  A.eq((billing.status('r6') || {}).settled, false, 'failed finalization remains retryable');
}

A.report('billing.test');
