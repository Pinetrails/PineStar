/* sidecar/credits.js — the managed-credit BACKEND adapter that turns sidecar/billing.js's injected
   `payment` client into a real thing, behind explicit config.

   billing.js owns the run-scoped admission math (reserve on beginRun, refund headroom on finishRun) and
   calls its payment client SYNCHRONOUSLY — `payment.balance(accountId)` must return a number right now,
   not a promise. A live HTTP round-trip can't answer synchronously, so this module keeps a CACHED balance
   (refreshed out-of-band by the host before admission) and makes debit/credit OPTIMISTIC: they adjust the
   cache immediately and POST the truth to the backend in the background. The backend ledger stays the
   source of truth; refresh() reconciles the cache to it.

   HONESTY LAW: when STARNET_CREDITS_URL is unset, configured() is false and NOTHING here is live — no
   payment client is built, beginRun/finishRun are inert pass-throughs, and the host renders no STORE UI
   and exposes no /api/credits surface. A managed-credit account only exists when the operator wires it.

   Contract with the credits backend (all under the configured base URL, bearer-authed when a key is set):
     GET  {url}/v1/balance?account=<id>            -> { balanceUsd: number }
     POST {url}/v1/debit   { account, usd, meta }  -> { ok: true, balanceUsd? } | { ok:false, reason }
     POST {url}/v1/credit  { account, usd, meta }  -> { ok: true, balanceUsd? } | { ok:false, reason }
     GET  {url}/v1/history?account=<id>&limit=<n>  -> { entries: [{ ts, kind, usd, runId?, balanceUsd? }] }
   The PURCHASE flow is deliberately NOT an API: buying credits opens {purchaseUrl} in the browser — this
   app never renders a payment form or touches card data.

   Pure-ish: all IO is the injected `fetch` + `clock`; no globals. Unit-testable with a fake fetch. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./billing.js') : (root.SK && root.SK.billing));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).credits = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (billingMod) {
  'use strict';

  const makeBilling = billingMod && billingMod.makeBilling;

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }
  function trimSlash(u) { return str(u).replace(/\/+$/, ''); }

  // an inert credits adapter — the shape the host always gets, so call sites never branch on null. When
  // unconfigured every method is a no-op and configured() is false, so no managed run, UI, or API appears.
  function inert() {
    return {
      configured() { return false; },
      accountId() { return ''; },
      purchaseUrl() { return ''; },
      mode() { return 'byok'; },
      beginRun() { return { ok: true, mode: 'byok', managed: false, skipped: true }; },
      finishRun() { return { ok: true, settled: true, skipped: true }; },
      refresh() { return Promise.resolve(null); },
      snapshot() { return { configured: false, accountId: '', balanceUsd: null, purchaseUrl: '' }; },
      history() { return Promise.resolve({ entries: [] }); }
    };
  }

  /* opts: {
       url, apiKey, accountId, purchaseUrl,   // config (url empty => inert)
       fetch, clock, ledger,                  // injected IO + the shared spend ledger (managed final truth)
       onError                                // optional: (stage, err) => void — background POST failures
     } */
  function makeCredits(opts) {
    opts = opts || {};
    const url = trimSlash(opts.url);
    if (!url || typeof makeBilling !== 'function') return inert();

    const apiKey = str(opts.apiKey);
    const accountId = str(opts.accountId) || 'default';
    const purchaseUrl = str(opts.purchaseUrl) || (url + '/buy');
    const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    const clock = opts.clock || { now() { return 0; } };   // host injects the wall clock (index.js); default is inert (determinism law)
    const onError = typeof opts.onError === 'function' ? opts.onError : function () {};

    // cached balance snapshot the SYNC payment client reads. null = never fetched -> fail closed (a managed
    // run refuses rather than spending against an unknown balance). refresh() populates/reconciles it.
    const cache = { balanceUsd: null, at: 0 };

    function headers(extra) {
      const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
      if (apiKey) h['Authorization'] = 'Bearer ' + apiKey;
      return h;
    }
    function acct(id) { return str(id) || accountId; }

    async function getJson(pathAndQuery) {
      if (!doFetch) throw new Error('no fetch');
      const r = await doFetch(url + pathAndQuery, { method: 'GET', headers: headers() });
      if (!r || !r.ok) { const e = new Error('credits GET ' + pathAndQuery + ' failed'); e.status = r && r.status; throw e; }
      return r.json();
    }
    async function postJson(pathName, payload) {
      if (!doFetch) throw new Error('no fetch');
      const r = await doFetch(url + pathName, { method: 'POST', headers: headers(), body: JSON.stringify(payload || {}) });
      const body = (r && typeof r.json === 'function') ? await r.json().catch(() => ({})) : {};
      if (!r || !r.ok) { const e = new Error('credits POST ' + pathName + ' failed'); e.status = r && r.status; e.body = body; throw e; }
      return body || {};
    }

    // pull the authoritative balance and reconcile the cache. Awaited by the host at boot and right before
    // a managed run's admission, so the sync balance() below is fresh. Never throws to the caller.
    async function refresh(id) {
      try {
        const j = await getJson('/v1/balance?account=' + encodeURIComponent(acct(id)));
        const b = num(j && (j.balanceUsd != null ? j.balanceUsd : j.balance));
        cache.balanceUsd = b; cache.at = clock.now();
        return b;
      } catch (e) { onError('refresh', e); return null; }
    }

    // the SYNCHRONOUS payment client billing.js drives. balance() reads the cache; debit/credit adjust it
    // optimistically and POST the truth in the background (fire-and-forget, reconciled on the next refresh).
    const payment = {
      balance(id) {
        if (cache.balanceUsd == null) throw new Error('credit_balance_unknown');   // -> managed_credit_unavailable (fail closed)
        return cache.balanceUsd;
      },
      debit(id, usd, meta) {
        const amt = num(usd);
        if (cache.balanceUsd != null) cache.balanceUsd = Math.max(0, cache.balanceUsd - amt);   // optimistic hold
        postJson('/v1/debit', { account: acct(id), usd: amt, meta: meta || {} })
          .then(body => { if (body && body.balanceUsd != null) { cache.balanceUsd = num(body.balanceUsd); cache.at = clock.now(); } })
          .catch(e => onError('debit', e));
        return { ok: true };
      },
      credit(id, usd, meta) {
        const amt = num(usd);
        if (cache.balanceUsd != null) cache.balanceUsd = cache.balanceUsd + amt;   // optimistic refund
        postJson('/v1/credit', { account: acct(id), usd: amt, meta: meta || {} })
          .then(body => { if (body && body.balanceUsd != null) { cache.balanceUsd = num(body.balanceUsd); cache.at = clock.now(); } })
          .catch(e => onError('credit', e));
        return { ok: true };
      }
    };

    const billing = makeBilling({ payment, ledger: opts.ledger || null, clock });

    // wrap billing so callers pass a run and we stamp the managed mode + account automatically. Callers still
    // get billing.js's exact result shape (ok/mode/managed/reason/...). Missing capUsd => byok fall-through.
    function beginRun(o) {
      o = o || {};
      const capUsd = num(o.capUsd);
      if (!(capUsd > 0)) return billing.beginRun({ mode: 'byok', runId: str(o.runId), agentId: str(o.agentId) });
      return billing.beginRun({ mode: 'managed', accountId: acct(o.accountId), runId: str(o.runId), agentId: str(o.agentId), capUsd });
    }
    function finishRun(o) { return billing.finishRun(o || {}); }

    async function history(id, limit) {
      try {
        const j = await getJson('/v1/history?account=' + encodeURIComponent(acct(id)) + '&limit=' + (Number(limit) > 0 ? Math.floor(Number(limit)) : 20));
        return { entries: Array.isArray(j && j.entries) ? j.entries : [] };
      } catch (e) { onError('history', e); return { entries: [], error: 'unreachable' }; }
    }

    return {
      configured() { return true; },
      mode() { return 'managed'; },
      accountId() { return accountId; },
      purchaseUrl() { return purchaseUrl; },
      beginRun, finishRun, refresh, history,
      snapshot() { return { configured: true, accountId, balanceUsd: cache.balanceUsd, at: cache.at, purchaseUrl }; }
    };
  }

  return { makeCredits, _internals: { inert } };
});
