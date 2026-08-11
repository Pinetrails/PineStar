/* Signed, replay-protected relay ingress. Pure core: no server/global state.
   Replay protection is durable when a store is injected: accepted nonces are appended to the
   store BEFORE the request is admitted (fail closed — an accepted delivery whose nonce was never
   recorded would re-open the replay window across a restart), and unexpired rows are reloaded
   into the in-memory cache at construction. Without a store the cache is within-process only. */
'use strict';
const crypto = require('node:crypto');

function makeWebhookVerifier(opts) {
  opts = opts || {};
  const secret = String(opts.secret || '');
  const now = opts.now;
  if (typeof now !== 'function') throw new Error('makeWebhookVerifier: an injected now function is required');
  // optional durable nonce inbox: { load(): [{nonce, expiry}], append(row) } — injected, never fs here.
  const store = opts.store || null;
  if (store && (typeof store.load !== 'function' || typeof store.append !== 'function')) {
    throw new Error('makeWebhookVerifier: an injected store must provide load() and append()');
  }
  const maxSkewMs = Math.max(1000, Number(opts.maxSkewMs) || 300000);
  const maxNonces = Math.max(100, Number(opts.maxNonces) || 10000);
  const seen = new Map();
  if (store) {
    // Boot re-hydration: only unexpired nonces matter — anything older is already outside the
    // timestamp skew window and would be refused as stale before the replay check is reached.
    // A broken store must not crash boot (fail-open on LOAD only; APPEND below fails closed).
    let rows = [];
    try { rows = store.load() || []; } catch (_) { rows = []; }
    const current = Number(now());
    for (const row of rows) {
      if (!row || typeof row.nonce !== 'string') continue;
      const expiry = Number(row.expiry);
      if (Number.isFinite(expiry) && expiry > current) seen.set(row.nonce, expiry);
    }
    while (seen.size > maxNonces) seen.delete(seen.keys().next().value);
  }
  function expected(timestamp, nonce, body) {
    return crypto.createHmac('sha256', secret).update(String(timestamp) + '.' + String(nonce) + '.' + String(body)).digest('hex');
  }
  function verify(input) {
    input = input || {};
    if (secret.length < 32) return { ok: false, code: 503, error: 'relay webhook secret is not configured' };
    const timestamp = String(input.timestamp || ''), nonce = String(input.nonce || ''), signature = String(input.signature || '').toLowerCase();
    if (!/^\d{10,16}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) return { ok: false, code: 401, error: 'invalid webhook authentication' };
    const at = Number(timestamp), current = Number(now());
    if (!Number.isFinite(at) || Math.abs(current - at) > maxSkewMs) return { ok: false, code: 401, error: 'stale webhook' };
    for (const [key, expiry] of seen) if (expiry < current) seen.delete(key);
    if (seen.has(nonce)) return { ok: false, code: 409, error: 'webhook replay refused' };
    const want = Buffer.from(expected(timestamp, nonce, input.body || ''), 'hex'), got = Buffer.from(signature, 'hex');
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, code: 401, error: 'invalid webhook signature' };
    const expiry = current + maxSkewMs;
    if (store) {
      // Fail closed: the nonce row must be ON DISK before the delivery is admitted. If the append
      // fails we also leave the in-memory cache untouched — the delivery was refused, so the
      // sender's retry of the SAME signed request must succeed once the store recovers.
      try { store.append({ nonce, expiry, at: current }); }
      catch (_) { return { ok: false, code: 503, error: 'webhook nonce could not be recorded' }; }
    }
    seen.set(nonce, expiry);
    while (seen.size > maxNonces) seen.delete(seen.keys().next().value);
    return { ok: true, timestamp: at, nonce };
  }
  return { verify, sign: expected, _seen: seen };
}

module.exports = { makeWebhookVerifier };
