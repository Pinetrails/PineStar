/* node test/mcp.oauth.test.js — the GENERIC MCP OAuth 2.1 client (sidecar/mcp/oauth.js).
   Drives the whole flow against a FAKE fetch shaped like the real Notion/Linear/Sentry servers probed live:
   WWW-Authenticate parse → RFC 9728 resource metadata → RFC 8414 AS metadata → RFC 7591 dynamic client
   registration → PKCE S256 authorize URL → code exchange → refresh (keeps the old refresh_token). Pure +
   deterministic: injected fetch, injected `now`, injected PKCE bytes; node:crypto only for the (deterministic)
   SHA-256 challenge. */
'use strict';
const A = require('./_assert.js');
const O = require('../sidecar/mcp/oauth.js');

// a fake fetch that routes by URL+method and records what it was called with.
function fakeFetch(routes) {
  const calls = [];
  return async (url, opts) => {
    opts = opts || {};
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body, headers: opts.headers });
    for (const [match, resp] of routes) {
      if (String(url).indexOf(match) >= 0) {
        const r = typeof resp === 'function' ? resp(url, opts) : resp;
        return {
          status: r.status || 200,
          headers: { get: (k) => (r.headers || {})[String(k).toLowerCase()] || null },
          json: async () => r.json,
          text: async () => (r.text != null ? r.text : JSON.stringify(r.json || {}))
        };
      }
    }
    return { status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => 'no route' };
  };
}

const SERVER = 'https://mcp.notion.com/mcp';
const WWW = 'Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", error="invalid_token"';
const REDIRECT = 'http://127.0.0.1:8787/api/connectors/oauth/callback';

(async () => {
// ---- A. WWW-Authenticate parse + default resource-metadata URL ----
{
  const p = O.parseWwwAuthenticate(WWW);
  A.eq(p.resourceMetadata, 'https://mcp.notion.com/.well-known/oauth-protected-resource/mcp', 'pulls resource_metadata pointer');
  A.eq(p.realm, 'OAuth', 'pulls realm');
  A.eq(p.error, 'invalid_token', 'pulls error');
  // when the server hands us no header, we construct the path-suffixed PRM url (what the real servers serve).
  A.eq(O.defaultResourceMetadataUrl(SERVER), 'https://mcp.notion.com/.well-known/oauth-protected-resource/mcp', 'default PRM url is path-suffixed');
  A.eq(O.defaultResourceMetadataUrl('https://x.example/'), 'https://x.example/.well-known/oauth-protected-resource', 'root path → no suffix');
}

// ---- B. discovery: PRM → AS metadata → endpoints (from the WWW-Authenticate pointer) ----
{
  const f = fakeFetch([
    ['/.well-known/oauth-protected-resource/mcp', { json: { resource: SERVER, authorization_servers: ['https://mcp.notion.com'] } }],
    ['/.well-known/oauth-authorization-server', { json: {
      authorization_endpoint: 'https://mcp.notion.com/authorize',
      token_endpoint: 'https://mcp.notion.com/token',
      registration_endpoint: 'https://mcp.notion.com/register',
      code_challenge_methods_supported: ['plain', 'S256']
    } }]
  ]);
  const d = await O.discover({ fetchImpl: f, serverUrl: SERVER, wwwAuthenticate: WWW });
  A.eq(d.authorizationEndpoint, 'https://mcp.notion.com/authorize', 'discovered authorization_endpoint');
  A.eq(d.tokenEndpoint, 'https://mcp.notion.com/token', 'discovered token_endpoint');
  A.eq(d.registrationEndpoint, 'https://mcp.notion.com/register', 'discovered registration_endpoint (DCR supported)');
  A.eq(d.resource, SERVER, 'resource indicator = the canonical MCP server url');
  A.ok(d.codeChallengeMethods.indexOf('S256') >= 0, 'server offers S256 PKCE');
}

// ---- B2. discovery falls back to OpenID configuration when oauth-authorization-server 404s ----
{
  const f = fakeFetch([
    ['/.well-known/oauth-protected-resource', { json: { authorization_servers: ['https://as.example'] } }],
    ['/.well-known/oauth-authorization-server', { status: 404, json: {} }],
    ['/.well-known/openid-configuration', { json: { authorization_endpoint: 'https://as.example/auth', token_endpoint: 'https://as.example/tok' } }]
  ]);
  const d = await O.discover({ fetchImpl: f, serverUrl: 'https://srv.example/mcp' });   // no header → constructed PRM url
  A.eq(d.authorizationEndpoint, 'https://as.example/auth', 'fell back to openid-configuration');
  A.eq(d.registrationEndpoint, '', 'no registration_endpoint → empty (caller must handle no-DCR)');
}

// ---- C. dynamic client registration (RFC 7591): public client, PKCE, our loopback redirect ----
{
  let seen = null;
  const f = fakeFetch([['/register', (url, opts) => { seen = JSON.parse(opts.body); return { json: { client_id: 'dcr-abc-123' } }; }]]);
  const r = await O.registerClient({ fetchImpl: f, registrationEndpoint: 'https://mcp.notion.com/register', redirectUri: REDIRECT, clientName: 'StarNet' });
  A.eq(r.clientId, 'dcr-abc-123', 'registration returns a client_id');
  A.eq(seen.token_endpoint_auth_method, 'none', 'registers as a PUBLIC client (no secret)');
  A.eq(seen.redirect_uris[0], REDIRECT, 'registers our loopback redirect');
  A.ok(seen.grant_types.indexOf('refresh_token') >= 0, 'requests refresh_token grant');
}

// ---- D. PKCE + authorize URL (deterministic verifier/challenge, resource indicator, S256) ----
{
  const verifier = O.makeVerifier(Buffer.alloc(48, 7));     // fixed bytes → deterministic
  const challenge = O.challengeOf(verifier);
  A.ok(verifier.length >= 43 && verifier.length <= 128, 'verifier is a legal PKCE length');
  A.eq(O.challengeOf(verifier), challenge, 'challenge is a pure function of the verifier (S256)');
  const url = O.buildAuthorizeUrl({ authorizationEndpoint: 'https://mcp.notion.com/authorize', clientId: 'dcr-abc-123', redirectUri: REDIRECT, challenge, state: 'st-42', resource: SERVER });
  const q = new URL(url).searchParams;
  A.eq(q.get('response_type'), 'code', 'authorize: response_type=code');
  A.eq(q.get('code_challenge_method'), 'S256', 'authorize: S256');
  A.eq(q.get('code_challenge'), challenge, 'authorize carries the PKCE challenge');
  A.eq(q.get('resource'), SERVER, 'authorize carries the RFC 8707 resource indicator');
  A.eq(q.get('state'), 'st-42', 'authorize carries CSRF state');
  A.eq(q.get('client_id'), 'dcr-abc-123', 'authorize carries the registered client_id');
}

// ---- E. code exchange → tokens; resource indicator is sent; expiresAt computed from injected now ----
{
  let seenBody = null;
  const f = fakeFetch([['/token', (url, opts) => { seenBody = opts.body; return { json: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' } }; }]]);
  const tok = await O.exchangeCode({ fetchImpl: f, tokenEndpoint: 'https://mcp.notion.com/token', code: 'code-xyz', redirectUri: REDIRECT, clientId: 'dcr-abc-123', verifier: 'ver', resource: SERVER, now: 1000 });
  A.eq(tok.accessToken, 'at-1', 'exchange returns the access token');
  A.eq(tok.refreshToken, 'rt-1', 'exchange returns the refresh token');
  A.eq(tok.expiresAt, 1000 + 3600 * 1000, 'expiresAt = now + expires_in (injected clock)');
  A.ok(/grant_type=authorization_code/.test(seenBody) && /code_verifier=ver/.test(seenBody), 'exchange posts the auth code + PKCE verifier');
  A.ok(/resource=/.test(seenBody), 'exchange posts the resource indicator');
}

// ---- F. refresh keeps the prior refresh_token when the AS omits a new one ----
{
  const f = fakeFetch([['/token', { json: { access_token: 'at-2', expires_in: 1800 } }]]);   // no refresh_token in response
  const tok = await O.refreshTokens({ fetchImpl: f, tokenEndpoint: 'https://mcp.notion.com/token', refreshToken: 'rt-1', clientId: 'dcr-abc-123', resource: SERVER, now: 5000 });
  A.eq(tok.accessToken, 'at-2', 'refresh returns a new access token');
  A.eq(tok.refreshToken, 'rt-1', 'refresh KEEPS the prior refresh_token when the AS omits one');
  A.eq(tok.expiresAt, 5000 + 1800 * 1000, 'refresh recomputes expiry from injected now');
}

// ---- G. needsRefresh: skew-aware expiry ----
{
  A.eq(O.needsRefresh(10000, 5000, 60000), true, 'refresh when inside the skew window');
  A.eq(O.needsRefresh(10000, 5000, 1000), false, 'no refresh well before expiry');
  A.eq(O.needsRefresh(0, 5000, 60000), true, 'no expiry recorded → must refresh');
}

console.log('ok - mcp.oauth');
  // report() settles the assertion counter — the .catch below only fires on a THROWN error, so
  // without this a failed assertion still exits 0 and the gate scores it green.
  A.report('mcp.oauth.test');
})().catch(e => { console.log('FAIL: mcp.oauth threw - ' + (e && e.stack || e)); process.exit(1); });
