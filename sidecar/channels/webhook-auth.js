/* Signed, replay-protected relay ingress. Pure core: no server/global state. */
'use strict';
const crypto = require('node:crypto');

function makeWebhookVerifier(opts) {
  opts = opts || {};
  const secret = String(opts.secret || '');
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const maxSkewMs = Math.max(1000, Number(opts.maxSkewMs) || 300000);
  const maxNonces = Math.max(100, Number(opts.maxNonces) || 10000);
  const seen = new Map();
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
    seen.set(nonce, current + maxSkewMs);
    while (seen.size > maxNonces) seen.delete(seen.keys().next().value);
    return { ok: true, timestamp: at, nonce };
  }
  return { verify, sign: expected, _seen: seen };
}

module.exports = { makeWebhookVerifier };
