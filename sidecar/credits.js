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
       onError,                               // optional: (stage, err) => void — background POST failures
       lowBalanceUsd,                         // number OR () => number — warn at/below this balance; 0 disables
       emit                                   // optional: (name, payload) => void — bus emit for 'credits.low'
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

    /* ---- LOW-BALANCE WARNING ------------------------------------------------------------------
       Without this, a managed run just stops at $0 with no warning — the user's first signal that
       they ran out is work failing. That is the same dishonesty as a silent gauge: the harness knew
       and did not say.

       WHY IT LIVES HERE: every path that can move the balance (refresh, the optimistic debit, the
       authoritative debit/credit responses) funnels through setBalance() below, so this is the one
       choke point where "the balance went down" is observable. Detecting it at the call sites would
       mean four detectors and a missed one.

       LATCHING: fire ONCE per crossing, not once per run. Nagging every turn is how a warning gets
       ignored, and the balance moves on every debit. The latch clears only when the balance climbs
       back above threshold × REARM (hysteresis) — a bare `> threshold` re-arm would re-fire on the
       cent-level jitter of a refund settling against a debit.

       TWO LEVELS, SEPARATE LATCHES: 'low' (you should top up) and 'exhausted' (<= 0, work WILL be
       refused). Exhausted must be able to fire even when low already did, or the one that actually
       stops the station is the one that stays silent. */
    const REARM = 1.25;
    const warned = { low: false, exhausted: false };
    const emitFn = typeof opts.emit === 'function' ? opts.emit : null;
    // number or getter — index.js passes a getter so a live per-run cap change is picked up without a restart
    function lowThreshold() {
      const raw = typeof opts.lowBalanceUsd === 'function' ? opts.lowBalanceUsd() : opts.lowBalanceUsd;
      const n = num(raw);
      return n > 0 ? n : 0;   // 0 (or unset/garbage) disables the warning entirely
    }

    // The ONLY writer of cache.balanceUsd. Every caller goes through here so the crossing check cannot be
    // bypassed. `null` means "unknown" (fail-closed) and must never be treated as a low balance — that would
    // fire a scary warning every time a background POST invalidates the cache.
    function setBalance(v) {
      const b = (v == null) ? null : num(v);
      cache.balanceUsd = b;
      cache.at = clock.now();
      if (b == null) return;                      // unknown ≠ low
      const t = lowThreshold();
      if (!emitFn || !(t > 0)) return;

      if (b <= 0 && !warned.exhausted) {
        warned.exhausted = true; warned.low = true;
        try { emitFn('credits.low', { balanceUsd: b, thresholdUsd: t, purchaseUrl, exhausted: true }); } catch (_) {}
        return;
      }
      if (b > 0 && b <= t && !warned.low) {
        warned.low = true;
        try { emitFn('credits.low', { balanceUsd: b, thresholdUsd: t, purchaseUrl, exhausted: false }); } catch (_) {}
        return;
      }
      if (b > t * REARM) { warned.low = false; warned.exhausted = false; }   // topped up — arm for next time
    }

    // A background debit/credit POST FAILED, so the optimistic cache no longer reflects a state we can trust
    // (the debit may or may not have landed on the backend). Rather than let the cache DRIFT — and admit later
    // runs against a fictional balance — INVALIDATE it (null). The next admission then fail-closes cleanly
    // (payment.balance() throws -> billing returns managed_credit_unavailable) and refresh() re-reads the
    // authoritative backend balance right before that admission, self-healing the drift. Loud on the way out.
    function onPostFailure(stage, e) {
      setBalance(null);          // fail-closed until the next authoritative refresh reconciles ('unknown', never 'low')
      try { console.warn('[credits] ' + stage + ' POST failed (status ' + ((e && e.status) || '?') + '); invalidating cached balance -> next managed run fail-closes until refresh reconciles'); } catch (_) {}
      onError(stage, e);
    }

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
        setBalance(b);
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
        // The optimistic hold is what makes the warning TIMELY: it lands the moment the run reserves,
        // not a round-trip later. The authoritative response below re-runs the same check with the
        // real number — the latch means the user still only sees it once.
        if (cache.balanceUsd != null) setBalance(Math.max(0, cache.balanceUsd - amt));
        postJson('/v1/debit', { account: acct(id), usd: amt, meta: meta || {} })
          .then(body => { if (body && body.balanceUsd != null) setBalance(num(body.balanceUsd)); })
          .catch(e => onPostFailure('debit', e));
        return { ok: true };
      },
      credit(id, usd, meta) {
        const amt = num(usd);
        if (cache.balanceUsd != null) setBalance(cache.balanceUsd + amt);   // optimistic refund
        postJson('/v1/credit', { account: acct(id), usd: amt, meta: meta || {} })
          .then(body => { if (body && body.balanceUsd != null) setBalance(num(body.balanceUsd)); })
          .catch(e => onPostFailure('credit', e));
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
