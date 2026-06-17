/* node test/provider.codex-auth.test.js — the Codex OAuth device-code flow, fed canned HTTP responses
   through an injected fake fetch. Asserts the EXACT wire OpenAI's Codex CLI uses (endpoints, grant types,
   client_id, PKCE code_verifier) plus the refresh classification (rate-limit vs relogin) and the JWT-exp
   freshness check. Zero network. */
'use strict';
const A = require('./_assert.js');
const auth = require('../sidecar/providers/codex-auth.js');

const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
// records every call so we can assert the request shape, and replies from a queue/handler
function recordingFetch(handler) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init: init || {} }); return handler(url, init || {}, calls.length - 1); };
  f.calls = calls;
  return f;
}
function bodyObj(init) { try { return JSON.parse(init.body); } catch (e) { return {}; } }
function formObj(init) { const o = {}; for (const [k, v] of new URLSearchParams(init.body)) o[k] = v; return o; }
// minimal unsigned JWT carrying the given claims (only the payload segment is read)
function jwt(claims) {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b64({ alg: 'none' }) + '.' + b64(claims) + '.' + 'sig';
}

(async () => {
  // A. startDeviceLogin: POSTs client_id to the usercode endpoint; returns code + poll metadata
  {
    const f = recordingFetch(() => json({ user_code: 'WXYZ-1234', device_auth_id: 'dev_abc', interval: '5' }));
    const r = await auth.startDeviceLogin({ fetch: f });
    A.eq(f.calls[0].url, 'https://auth.openai.com/api/accounts/deviceauth/usercode', 'usercode endpoint');
    A.eq(f.calls[0].init.method, 'POST', 'usercode is POST');
    A.eq(bodyObj(f.calls[0].init).client_id, 'app_EMoamEEZ73f0CkXaXp7hrann', 'sends the Codex CLI public client_id');
    A.eq(r.user_code, 'WXYZ-1234', 'returns user_code');
    A.eq(r.device_auth_id, 'dev_abc', 'returns device_auth_id');
    A.eq(r.verification_uri, 'https://auth.openai.com/codex/device', 'verification_uri is the device page');
    A.eq(r.interval, 5, 'interval parsed');
  }

  // A2. interval is floored at 3 (a tiny server value never busy-polls)
  {
    const f = recordingFetch(() => json({ user_code: 'C', device_auth_id: 'd', interval: '1' }));
    const r = await auth.startDeviceLogin({ fetch: f });
    A.eq(r.interval, 3, 'interval floored at 3 seconds');
  }

  // A3. a non-200 from usercode is an error
  {
    const f = recordingFetch(() => json({}, 500));
    let code = '';
    try { await auth.startDeviceLogin({ fetch: f }); } catch (e) { code = e.code; }
    A.eq(code, 'device_code_request_error', 'usercode non-200 surfaces a request error');
  }

  // B. pollDeviceLogin: 403/404 => pending; 200 => the authorization_code + server-minted code_verifier
  {
    const pending = recordingFetch(() => json({}, 403));
    A.eq((await auth.pollDeviceLogin({ fetch: pending, device_auth_id: 'd', user_code: 'c' })).pending, true, '403 => pending');
    const pending404 = recordingFetch(() => json({}, 404));
    A.eq((await auth.pollDeviceLogin({ fetch: pending404, device_auth_id: 'd', user_code: 'c' })).pending, true, '404 => pending');

    const done = recordingFetch(() => json({ authorization_code: 'auth_123', code_verifier: 'ver_456' }));
    const r = await auth.pollDeviceLogin({ fetch: done, device_auth_id: 'dev_abc', user_code: 'WXYZ-1234' });
    A.eq(done.calls[0].url, 'https://auth.openai.com/api/accounts/deviceauth/token', 'poll endpoint');
    A.eq(bodyObj(done.calls[0].init), { device_auth_id: 'dev_abc', user_code: 'WXYZ-1234' }, 'poll body carries device_auth_id + user_code');
    A.eq(r.pending, false, '200 => not pending');
    A.eq(r.authorization_code, 'auth_123', 'returns authorization_code');
    A.eq(r.code_verifier, 'ver_456', 'returns code_verifier');
  }

  // B2. a 200 missing the code fields is a hard error (not a silent pending)
  {
    const bad = recordingFetch(() => json({ authorization_code: 'x' }));   // no code_verifier
    let code = '';
    try { await auth.pollDeviceLogin({ fetch: bad, device_auth_id: 'd', user_code: 'c' }); } catch (e) { code = e.code; }
    A.eq(code, 'device_code_incomplete_exchange', 'a 200 missing code_verifier errors');
  }

  // C. exchangeCode: form-encoded authorization_code grant with the PKCE verifier; returns the tokens
  {
    const f = recordingFetch(() => json({ access_token: 'acc_tok', refresh_token: 'ref_tok' }));
    const r = await auth.exchangeCode({ fetch: f, authorization_code: 'auth_123', code_verifier: 'ver_456', now: 0 });
    A.eq(f.calls[0].url, 'https://auth.openai.com/oauth/token', 'token endpoint');
    A.eq(f.calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded', 'exchange is form-encoded');
    const form = formObj(f.calls[0].init);
    A.eq(form.grant_type, 'authorization_code', 'grant_type=authorization_code');
    A.eq(form.code, 'auth_123', 'sends the authorization_code');
    A.eq(form.code_verifier, 'ver_456', 'sends the PKCE code_verifier');
    A.eq(form.redirect_uri, 'https://auth.openai.com/deviceauth/callback', 'device redirect_uri');
    A.eq(form.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann', 'public client_id');
    A.eq(r.access_token, 'acc_tok', 'returns access_token');
    A.eq(r.refresh_token, 'ref_tok', 'returns refresh_token');
    A.eq(r.auth_mode, 'chatgpt', 'tags auth_mode=chatgpt');
  }

  // D. refreshTokens success: new access_token; keep the old refresh unless a new one is returned
  {
    const keep = recordingFetch(() => json({ access_token: 'acc_2' }));   // no new refresh_token
    const r1 = await auth.refreshTokens({ fetch: keep, refresh_token: 'ref_old', now: 0 });
    const form = formObj(keep.calls[0].init);
    A.eq(form.grant_type, 'refresh_token', 'grant_type=refresh_token');
    A.eq(form.refresh_token, 'ref_old', 'sends the refresh_token');
    A.eq(r1.access_token, 'acc_2', 'new access_token applied');
    A.eq(r1.refresh_token, 'ref_old', 'old refresh_token retained when none returned');

    const rotate = recordingFetch(() => json({ access_token: 'acc_3', refresh_token: 'ref_new' }));
    const r2 = await auth.refreshTokens({ fetch: rotate, refresh_token: 'ref_old', now: 0 });
    A.eq(r2.refresh_token, 'ref_new', 'rotated refresh_token applied when returned');
  }

  // D2. refresh 429 => rate-limited, NOT relogin (credentials still valid)
  {
    const f = recordingFetch(() => json({ error: { message: 'quota' } }, 429));
    let code = '', relogin = null;
    try { await auth.refreshTokens({ fetch: f, refresh_token: 'r' }); } catch (e) { code = e.code; relogin = e.reloginRequired; }
    A.eq(code, 'codex_rate_limited', '429 => codex_rate_limited');
    A.eq(relogin, false, '429 does NOT force relogin');
  }

  // D3. refresh invalid_grant => relogin required
  {
    const f = recordingFetch(() => json({ error: { code: 'invalid_grant', message: 'expired' } }, 400));
    let code = '', relogin = null;
    try { await auth.refreshTokens({ fetch: f, refresh_token: 'r' }); } catch (e) { code = e.code; relogin = e.reloginRequired; }
    A.eq(code, 'invalid_grant', 'surfaces the OpenAI error code');
    A.eq(relogin, true, 'invalid_grant forces relogin');
  }

  // D4. a 401 with an unknown body code still forces relogin
  {
    const f = recordingFetch(() => json({ error: { code: 'weird' } }, 401));
    let relogin = null;
    try { await auth.refreshTokens({ fetch: f, refresh_token: 'r' }); } catch (e) { relogin = e.reloginRequired; }
    A.eq(relogin, true, '401 always forces relogin');
  }

  // D5. missing refresh_token => relogin (nothing to refresh with)
  {
    let code = '', relogin = null;
    try { await auth.refreshTokens({ fetch: async () => json({}), refresh_token: '' }); } catch (e) { code = e.code; relogin = e.reloginRequired; }
    A.eq(code, 'codex_auth_missing_refresh_token', 'missing refresh_token is its own error');
    A.eq(relogin, true, 'missing refresh_token forces relogin');
  }

  // E. JWT claims decode + the exp-based freshness check
  {
    A.eq(auth.decodeJwtClaims(jwt({ exp: 12345, sub: 'u' })).sub, 'u', 'decodes JWT payload claims');
    A.eq(auth.decodeJwtClaims('not-a-jwt'), {}, 'a non-JWT decodes to {}');

    const now = 1_000_000;   // ms basis below uses /1000 internally
    const fresh = jwt({ exp: (now / 1000) + 600 });    // 10 min out
    const stale = jwt({ exp: (now / 1000) + 30 });     // 30s out, inside the 120s skew
    A.eq(auth.accessTokenIsExpiring(fresh, 120, now), false, 'a token 10min out is fresh');
    A.eq(auth.accessTokenIsExpiring(stale, 120, now), true, 'a token 30s out is expiring (inside 120s skew)');
    A.eq(auth.accessTokenIsExpiring('opaque-no-exp', 120, now), false, 'an opaque token without exp is treated as fresh');
  }

  A.report('provider.codex-auth.test');
})();
