/* node test/credits.test.js — the managed-credit BACKEND adapter (sidecar/credits.js): config-gating (unconfigured
   = ZERO surface) + the HTTP contract (fake fetch, no real network/money), incl. the sync-balance / optimistic
   debit-credit design billing.js relies on. */
'use strict';
const A = require('./_assert.js');
const { makeCredits } = require('../sidecar/credits.js');

const flush = () => new Promise(r => setTimeout(r, 0));   // let a fire-and-forget POST's .then run

// a fake credits backend: records every request, answers balance/debit/credit/history from an in-memory book.
function fakeFetch(seed) {
  const book = Object.assign({ default: 0 }, seed || {});
  const calls = [];
  const json = (obj, ok) => Promise.resolve({ ok: ok !== false, status: ok === false ? 500 : 200, json: () => Promise.resolve(obj) });
  return {
    calls, book,
    fetch(url, init) {
      const u = String(url);
      const method = (init && init.method) || 'GET';
      let body = {};
      try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (_) {}
      calls.push({ url: u, method, headers: (init && init.headers) || {}, body });
      if (u.indexOf('/v1/balance') >= 0) { const acct = /account=([^&]+)/.exec(u); const id = acct ? decodeURIComponent(acct[1]) : 'default'; return json({ balanceUsd: book[id] || 0 }); }
      if (u.indexOf('/v1/debit') >= 0) { const id = body.account || 'default'; book[id] = (book[id] || 0) - (body.usd || 0); return json({ ok: true, balanceUsd: book[id] }); }
      if (u.indexOf('/v1/credit') >= 0) { const id = body.account || 'default'; book[id] = (book[id] || 0) + (body.usd || 0); return json({ ok: true, balanceUsd: book[id] }); }
      if (u.indexOf('/v1/history') >= 0) { return json({ entries: [{ ts: 1, kind: 'debit', usd: 1 }] }); }
      return json({}, false);
    }
  };
}

// ---- CONFIG GATING: no url => fully inert, zero surface, no payment calls ever ----
(async () => {
  {
    const ff = fakeFetch();
    const c = makeCredits({ url: '', fetch: ff.fetch });
    A.eq(c.configured(), false, 'no CREDITS_URL => configured() is false (renders no UI, /api/credits 404s)');
    A.eq(c.snapshot().configured, false, 'inert snapshot reports unconfigured');
    A.eq(c.mode(), 'byok', 'inert adapter is byok mode');
    const b = c.beginRun({ runId: 'r1', agentId: 'a', capUsd: 5 });
    A.eq(b.ok, true, 'inert beginRun is a pass-through (never blocks a BYOK run)');
    A.eq(b.managed, false, 'inert beginRun never marks a run managed');
    A.eq(c.finishRun({ runId: 'r1', usd: 1 }).ok, true, 'inert finishRun is a no-op success');
    await c.refresh();
    A.eq(ff.calls.length, 0, 'inert adapter makes NO network calls at all');
  }

  // ---- CONFIGURED: configured() true, snapshot exposes balance + purchaseUrl, no secret leaks ----
  {
    const ff = fakeFetch({ acct: 10 });
    const c = makeCredits({ url: 'https://credits.example/', apiKey: 'sekret-key', accountId: 'acct', purchaseUrl: 'https://buy.example', fetch: ff.fetch });
    A.eq(c.configured(), true, 'a CREDITS_URL makes the adapter live');
    A.eq(c.mode(), 'managed', 'configured adapter is managed mode');
    A.eq(c.purchaseUrl(), 'https://buy.example', 'purchase url is the configured external link');
    const bal = await c.refresh('acct');
    A.eq(bal, 10, 'refresh() reads the authoritative balance from the backend');
    A.eq(c.snapshot().balanceUsd, 10, 'snapshot reflects the refreshed balance');
    // the api key rides Authorization, never the account/display surface
    const auth = ff.calls[0].headers['Authorization'];
    A.eq(auth, 'Bearer sekret-key', 'the api key is sent as a bearer header (never in the snapshot payload)');
    A.eq(JSON.stringify(c.snapshot()).indexOf('sekret-key'), -1, 'the api key never appears in the snapshot (no secret leak)');
  }

  // ---- MANAGED RUN via the backend: reserve holds the balance, refund returns the unspent headroom ----
  {
    const ff = fakeFetch({ acct: 10 });
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: ff.fetch });
    await c.refresh('acct');
    const adm = c.beginRun({ runId: 'run-1', agentId: 'a', capUsd: 4 });
    A.eq(adm.ok, true, 'managed admission succeeds when the balance covers the cap');
    A.eq(adm.managed, true, 'a run with a cap + a configured backend is a managed run');
    await flush();
    const debited = ff.calls.filter(x => x.url.indexOf('/v1/debit') >= 0);
    A.eq(debited.length, 1, 'admission posts exactly one debit (the reservation) to the backend');
    A.eq(debited[0].body.usd, 4, 'the reservation debits the full per-run cap');
    A.eq(ff.book.acct, 6, 'backend balance is reduced by the reservation');

    const done = c.finishRun({ runId: 'run-1', agentId: 'a', usd: 1.5, turns: 2, tokens: 100 });
    A.eq(done.ok, true, 'managed settle succeeds');
    await flush();
    const credited = ff.calls.filter(x => x.url.indexOf('/v1/credit') >= 0);
    A.eq(credited.length, 1, 'settle posts exactly one credit (the refund) to the backend');
    A.eq(credited[0].body.usd, 2.5, 'refund returns the unused headroom (cap 4 − spend 1.5)');
    A.ok(Math.abs(ff.book.acct - 8.5) < 1e-9, 'backend balance ends at start − actual spend (10 − 1.5)');
  }

  // ---- EXHAUSTED balance: admission fails CLOSED before any debit/model work ----
  {
    const ff = fakeFetch({ acct: 0.5 });
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: ff.fetch });
    await c.refresh('acct');
    const adm = c.beginRun({ runId: 'run-x', agentId: 'a', capUsd: 3 });
    A.eq(adm.ok, false, 'insufficient managed balance refuses the run');
    A.eq(adm.reason, 'managed_credits_exhausted', 'exhaustion reason is explicit (drives the STORE upsell)');
    await flush();
    A.eq(ff.calls.filter(x => x.url.indexOf('/v1/debit') >= 0).length, 0, 'no debit is posted after an exhausted preflight');
  }

  // ---- unknown balance (backend never answered): fail CLOSED, never spend against an unknown balance ----
  {
    const ff = fakeFetch({ acct: 10 });
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: ff.fetch });
    // deliberately DO NOT refresh — the cache is empty
    const adm = c.beginRun({ runId: 'run-u', agentId: 'a', capUsd: 3 });
    A.eq(adm.ok, false, 'a managed run with an unknown balance is refused (fail closed)');
    A.eq(adm.reason, 'managed_credit_unavailable', 'unknown balance surfaces as unavailable, not a false success');
  }

  // ---- no cap => a byok pass-through even when configured (an ungoverned run can't be pre-authorized) ----
  {
    const ff = fakeFetch({ acct: 10 });
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: ff.fetch });
    await c.refresh('acct');
    const adm = c.beginRun({ runId: 'run-nocap', agentId: 'a', capUsd: 0 });
    A.eq(adm.ok, true, 'a capless run admits');
    A.eq(adm.managed, false, 'a capless run is byok (no reservation held)');
  }

  // ---- history: reads the backend ledger for the STORE card ----
  {
    const ff = fakeFetch({ acct: 5 });
    const c = makeCredits({ url: 'https://credits.example', accountId: 'acct', fetch: ff.fetch });
    const h = await c.history('acct', 10);
    A.eq(Array.isArray(h.entries), true, 'history returns an entries array');
    A.eq(h.entries.length, 1, 'history surfaces the backend rows for the STORE activity list');
  }

  A.report('credits.test');
})();
