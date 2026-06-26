/* sidecar/billing.js - pure managed-credit billing adapter.

   This module owns the managed-credit payment seam only. BYOK runs pass through
   without touching managed balances or credentials. The host injects the payment
   client, ledger, and clock so tests never spend real money.
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).billing = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function num(v) { return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }
  function isManaged(mode) { return String(mode || '').toLowerCase() === 'managed'; }
  function failedResult(v) { return v && typeof v === 'object' && v.ok === false; }

  function makeBilling(opts) {
    opts = opts || {};
    const payment = opts.payment || {};
    const ledger = opts.ledger || null;
    const clock = opts.clock || { now() { return 0; } };
    const runs = new Map();

    function fail(reason, extra) {
      return Object.assign({ ok: false, reason }, extra || {});
    }

    function sameAdmission(prior, mode, o) {
      if (!prior || prior.mode !== mode) return false;
      if (mode !== 'managed') return true;
      return prior.accountId === str(o.accountId) && Math.abs(prior.reservedUsd - num(o.capUsd)) < 1e-9;
    }

    function beginRun(o) {
      o = o || {};
      const runId = str(o.runId);
      const mode = isManaged(o.mode) ? 'managed' : 'byok';
      if (!runId) return fail('run_id_required');
      if (runs.has(runId)) {
        const prior = runs.get(runId);
        if (!sameAdmission(prior, mode, o)) return fail('billing_run_conflict', { runId });
        const out = { ok: true, mode: prior.mode, runId, managed: prior.mode === 'managed' };
        if (prior.mode === 'managed') out.reservedUsd = prior.reservedUsd;
        return out;
      }

      if (mode !== 'managed') {
        runs.set(runId, { mode, runId, settled: false });
        return { ok: true, mode, runId, managed: false };
      }

      const accountId = str(o.accountId);
      const capUsd = num(o.capUsd);
      if (!accountId) return fail('managed_account_required');
      if (capUsd <= 0) return fail('managed_cap_required');
      if (typeof payment.balance !== 'function' || typeof payment.debit !== 'function') {
        return fail('managed_credit_unavailable');
      }

      let balance = 0;
      try { balance = num(payment.balance(accountId)); }
      catch (_) { return fail('managed_credit_unavailable'); }
      if (balance < capUsd) {
        return fail('managed_credits_exhausted', { balance, capUsd });
      }

      try {
        const debited = payment.debit(accountId, capUsd, {
          kind: 'managed.reserve', accountId, runId,
          agentId: str(o.agentId), usd: capUsd, ts: clock.now()
        });
        if (failedResult(debited)) throw new Error('managed debit refused');
      } catch (_) {
        return fail('managed_credit_unavailable');
      }

      const rec = {
        mode, runId, accountId, agentId: str(o.agentId), reservedUsd: capUsd,
        settled: false, recorded: false, startedAt: clock.now()
      };
      runs.set(runId, rec);
      return { ok: true, mode, runId, managed: true, reservedUsd: capUsd, balance: balance - capUsd };
    }

    function finishRun(o) {
      o = o || {};
      const runId = str(o.runId);
      const rec = runs.get(runId);
      if (!rec) return fail('unknown_run');
      if (rec.settled) return { ok: true, mode: rec.mode, runId, usd: rec.finalUsd || 0, settled: true };

      const finalUsd = num(o.usd);
      if (rec.mode !== 'managed') {
        rec.settled = true;
        rec.finalUsd = finalUsd;
        return { ok: true, mode: rec.mode, runId, usd: finalUsd, settled: true };
      }
      if (finalUsd > rec.reservedUsd) {
        return fail('managed_credit_over_cap', { runId, usd: finalUsd, reservedUsd: rec.reservedUsd });
      }

      if (ledger && (typeof ledger.recordStrict === 'function' || typeof ledger.record === 'function') && !rec.recorded) {
        try {
          const record = typeof ledger.recordStrict === 'function' ? ledger.recordStrict : ledger.record;
          record.call(ledger, {
            runId, agentId: rec.agentId, billingMode: 'managed',
            accountId: rec.accountId, reason: str(o.reason || 'done'),
            turns: num(o.turns), usd: finalUsd, tokens: num(o.tokens), ts: clock.now()
          });
          rec.recorded = true;
        } catch (_) {
          return fail('managed_credit_unavailable');
        }
      }

      const refundUsd = rec.reservedUsd - finalUsd;
      if (refundUsd > 0 && typeof payment.credit !== 'function') {
        return fail('managed_credit_unavailable');
      }
      if (refundUsd > 0) {
        try {
          const credited = payment.credit(rec.accountId, refundUsd, {
            kind: 'managed.refund', accountId: rec.accountId, runId,
            agentId: rec.agentId, usd: refundUsd, ts: clock.now()
          });
          if (failedResult(credited)) throw new Error('managed refund refused');
        } catch (_) {
          return fail('managed_credit_unavailable');
        }
      }

      rec.settled = true;
      rec.finalUsd = finalUsd;
      rec.refundUsd = refundUsd;
      return { ok: true, mode: 'managed', runId, usd: finalUsd, refundUsd, settled: true };
    }

    function status(runId) {
      const rec = runs.get(str(runId));
      return rec ? Object.assign({}, rec) : null;
    }

    return { beginRun, finishRun, status };
  }

  return { makeBilling };
});
