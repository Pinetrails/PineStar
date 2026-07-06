/* node test/apiauth.test.js — the loopback API auth/guard logic (sidecar/apiauth.js). Pure unit test, no
   server boot. Proves the HARDENED posture: every /api route requires the per-launch token (GET data routes
   INCLUDED) except a documented header-less set; tokens are constant-time compared; origin/host gating holds. */
'use strict';
const A = require('./_assert.js');
const auth = require('../sidecar/apiauth.js');

const PORT = 8787;
const TOK = 'a'.repeat(64);
const req = (method, url, headers) => ({ method, url, headers: headers || {} });

// ---- requiresApiToken: every data route now needs the token (the C2 hole: GETs used to be exempt) ----
A.eq(auth.requiresApiToken(req('GET', '/api/budget/status')), true, 'GET data route requires token');
A.eq(auth.requiresApiToken(req('GET', '/api/transcript?agent=x')), true, 'GET transcript (with query) requires token');
A.eq(auth.requiresApiToken(req('GET', '/api/notebook?agent=x')), true, 'GET notebook requires token');
A.eq(auth.requiresApiToken(req('GET', '/api/file?agent=a&path=p')), true, 'GET file requires token');
A.eq(auth.requiresApiToken(req('GET', '/api/memory/records?agent=x')), true, 'GET memory records requires token');
A.eq(auth.requiresApiToken(req('GET', '/api/runs')), true, 'GET runs requires token');
A.eq(auth.requiresApiToken(req('POST', '/api/run')), true, 'POST run requires token');
A.eq(auth.requiresApiToken(req('POST', '/api/save')), true, 'POST save now requires token (was exempt)');
A.eq(auth.requiresApiToken(req('GET', '/api/save?slot=1')), true, 'GET save now requires token (was exempt)');
A.eq(auth.requiresApiToken(req('POST', '/api/session')), true, 'POST session now requires token (no token vending)');

// ---- the documented header-less exempt set (routes that cannot carry the custom header) ----
A.eq(auth.requiresApiToken(req('POST', '/api/key')), false, 'key push exempt (own IPC_TOKEN guard)');
A.eq(auth.requiresApiToken(req('GET', '/api/health')), false, 'health probe exempt');
A.eq(auth.requiresApiToken(req('GET', '/api/spotify/callback?code=abc')), false, 'spotify OAuth redirect exempt');
A.eq(auth.requiresApiToken(req('GET', '/api/connectors/oauth/callback?code=abc&state=xyz')), false, 'connector OAuth redirect exempt (state is the CSRF fence)');
A.eq(auth.requiresApiToken(req('GET', '/api/channels/events')), false, 'SSE exempt from header token (uses ?token=)');
A.eq(auth.requiresApiToken(req('OPTIONS', '/api/run')), false, 'CORS preflight exempt');
// non-/api requests never need a token (static assets / app shell)
A.eq(auth.requiresApiToken(req('GET', '/index.html')), false, 'static asset needs no token');
A.eq(auth.requiresApiToken(req('GET', '/')), false, 'root needs no token');

// ---- apiTokenOk: custom-header path, exact + constant-time ----
A.eq(auth.apiTokenOk(req('POST', '/api/run', { 'x-starnet-token': TOK }), TOK), true, 'correct header token accepted');
A.eq(auth.apiTokenOk(req('POST', '/api/run', { 'x-skynet-token': TOK }), TOK), true, 'legacy header name accepted');
A.eq(auth.apiTokenOk(req('POST', '/api/run', { 'x-starnet-token': 'b'.repeat(64) }), TOK), false, 'wrong token rejected');
A.eq(auth.apiTokenOk(req('POST', '/api/run', { 'x-starnet-token': 'a'.repeat(63) }), TOK), false, 'length mismatch rejected (no throw)');
A.eq(auth.apiTokenOk(req('POST', '/api/run', {}), TOK), false, 'missing header rejected');
A.eq(auth.apiTokenOk(req('POST', '/api/run', { 'x-starnet-token': TOK }), ''), false, 'empty server token rejects everything');

// ---- queryTokenOk: SSE path (EventSource can't set headers) ----
A.eq(auth.queryTokenOk(req('GET', '/api/channels/events?token=' + TOK), TOK), true, 'correct query token accepted');
A.eq(auth.queryTokenOk(req('GET', '/api/channels/events?token=' + 'b'.repeat(64)), TOK), false, 'wrong query token rejected');
A.eq(auth.queryTokenOk(req('GET', '/api/channels/events'), TOK), false, 'missing query token rejected');
A.eq(auth.queryTokenOk(req('GET', '/api/channels/events?foo=1&token=' + TOK), TOK), true, 'query token found among other params');

// ---- isAllowedApiOrigin: foreign sites rejected; absent allowed (token gates those) ----
A.eq(auth.isAllowedApiOrigin('', PORT), true, 'absent origin allowed (token is the fence for header-less callers)');
A.eq(auth.isAllowedApiOrigin('http://127.0.0.1:' + PORT, PORT), true, 'loopback origin allowed');
A.eq(auth.isAllowedApiOrigin('http://localhost:' + PORT, PORT), true, 'localhost origin allowed');
A.eq(auth.isAllowedApiOrigin('tauri://localhost', PORT), true, 'desktop (tauri) origin allowed');
A.eq(auth.isAllowedApiOrigin('https://evil.example', PORT), false, 'foreign web origin rejected');
A.eq(auth.isAllowedApiOrigin('null', PORT), false, 'null/sandboxed origin rejected');
A.eq(auth.isAllowedApiOrigin('http://127.0.0.1:1234', PORT), false, 'wrong-port loopback origin rejected');

// ---- isAllowedHost: DNS-rebinding defense ----
A.eq(auth.isAllowedHost('127.0.0.1:' + PORT), true, 'loopback host allowed');
A.eq(auth.isAllowedHost('localhost:' + PORT), true, 'localhost host allowed');
A.eq(auth.isAllowedHost('[::1]:' + PORT), true, 'ipv6 loopback host allowed');
A.eq(auth.isAllowedHost('evil.example'), false, 'foreign host rejected (rebinding defense)');
A.eq(auth.isAllowedHost('169.254.169.254'), false, 'cloud-metadata host rejected');

// ---- constant-time compare never throws on odd input ----
A.eq(auth.constTimeEq(null, TOK), false, 'null vs token -> false, no throw');
A.eq(auth.constTimeEq(TOK, TOK), true, 'equal strings compare true');
A.eq(auth.constTimeEq('x', 'yy'), false, 'unequal-length -> false');

A.report('apiauth.test');
