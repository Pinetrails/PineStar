/* sidecar/mcp/oauth.js — a GENERIC OAuth 2.1 client for remote MCP connectors (the MCP Authorization spec:
   RFC 9728 protected-resource metadata + RFC 8414 AS metadata + RFC 7591 dynamic client registration + PKCE
   authorization-code, RFC 8707 resource indicator). Verified against the real Notion / Linear / Sentry MCP
   servers, which all implement it identically: an unauthenticated request 401s with
   `WWW-Authenticate: Bearer ... resource_metadata="<url>"`, the PRM lists an `authorization_servers[0]`, and
   its AS metadata exposes authorization/token/registration endpoints with S256 PKCE. ONE flow drives them all —
   no per-provider client id or secret, because the AS mints a public client via dynamic registration.

   PURE + injected: every network call takes an injected `fetchImpl`; the current time is an injected `now`; the
   random PKCE bytes are injected by the composition root (sidecar/index.js owns crypto.randomBytes). node:crypto
   is used only for the deterministic SHA-256 of the PKCE challenge, never for randomness here — so this module is
   reproducible and passes lint-determinism, exactly like spotify/pkce.js.

   The flow, end to end (the routes layer in index.js orchestrates it):
     1. discover(serverUrl[, wwwAuthenticate]) -> { authorizationServer, authorizationEndpoint, tokenEndpoint,
        registrationEndpoint, codeChallengeMethods, resource }
     2. registerClient(registrationEndpoint, redirectUri) -> { clientId }              (cache per AS)
     3. makeVerifier(randomBytes) + challengeOf(verifier); buildAuthorizeUrl(...) -> open in the browser
     4. exchangeCode(tokenEndpoint, code, redirectUri, clientId, verifier, resource, now) -> tokens
     5. refreshTokens(tokenEndpoint, refreshToken, clientId, now) -> tokens   (when needsRefresh) */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('node:crypto'));
  else { root.SK = root.SK || {}; (root.SK.mcp = root.SK.mcp || {}).oauth = factory(null); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nodeCrypto) {
  'use strict';

  function base64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // PKCE verifier := base64url(random bytes) (43–128 chars). Bytes are INJECTED (ambient randomness stays in index.js).
  function makeVerifier(randomBytes) {
    if (!randomBytes || !randomBytes.length) throw new Error('makeVerifier needs random bytes');
    const v = base64url(randomBytes);
    if (v.length < 43) throw new Error('verifier too short — supply >= 32 random bytes');
    return v.slice(0, 128);
  }
  // challenge := base64url(SHA256(verifier)) (the S256 method every probed server supports).
  function challengeOf(verifier) {
    if (!nodeCrypto) throw new Error('challengeOf requires node:crypto');
    return base64url(nodeCrypto.createHash('sha256').update(String(verifier)).digest());
  }

  // Parse an RFC 9728 pointer out of a `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="…"` header.
  function parseWwwAuthenticate(header) {
    const h = String(header || '');
    const out = {};
    const rm = h.match(/resource_metadata\s*=\s*"([^"]+)"/i); if (rm) out.resourceMetadata = rm[1];
    const rl = h.match(/realm\s*=\s*"([^"]+)"/i); if (rl) out.realm = rl[1];
    const er = h.match(/error\s*=\s*"([^"]+)"/i); if (er) out.error = er[1];
    return out;
  }

  // SSRF hardening: the discovery/registration/token URLs come partly from a server-supplied WWW-Authenticate
  // pointer + PRM body, so require https and refuse any endpoint on an internal host (loopback / link-local /
  // private / cloud-metadata) by its literal hostname. redirect:'manual' turns any 3xx into a non-2xx the callers
  // already reject, so a metadata URL can't 302-bounce the fetch to an internal target. (Literal-host guard; if OAuth
  // is ever opened to user-provided — non-catalog — server URLs, add DNS-resolution guarding like tools/web.js.)
  function assertSafeUrl(raw, label) {
    let u; try { u = new URL(raw); } catch (e) { throw new Error((label || 'oauth') + ': invalid url ' + raw); }
    if (u.protocol !== 'https:') throw new Error((label || 'oauth') + ': url must be https (' + raw + ')');
    let h = u.hostname.toLowerCase(); if (h.charAt(0) === '[') h = h.slice(1, -1);
    const internal = h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::' || h === '0.0.0.0'
      || /^127\./.test(h) || /^0\./.test(h) || /^169\.254\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^fe80:/i.test(h) || /^f[cd][0-9a-f]{2}:/i.test(h);
    if (internal) throw new Error((label || 'oauth') + ': refusing an endpoint on an internal host (' + h + ')');
    return u;
  }

  async function getJson(fetchImpl, url, label) {
    assertSafeUrl(url, label);
    let res;
    try { res = await fetchImpl(url, { headers: { 'Accept': 'application/json', 'MCP-Protocol-Version': '2025-06-18' }, redirect: 'manual' }); }
    catch (e) { throw new Error((label || 'fetch') + ' failed: ' + ((e && e.message) || e)); }
    if (!res || res.status < 200 || res.status >= 300) throw new Error((label || 'fetch') + ' HTTP ' + (res && res.status));
    try { return await res.json(); } catch (e) { throw new Error((label || 'fetch') + ' returned non-JSON'); }
  }

  // The default RFC 9728 metadata URL when the server didn't hand one over: origin + /.well-known/oauth-protected-
  // resource + the resource path (path-suffixed, matching what Notion/Linear/Sentry actually serve).
  function defaultResourceMetadataUrl(serverUrl) {
    const u = new URL(serverUrl);
    const path = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : '';
    return u.origin + '/.well-known/oauth-protected-resource' + path;
  }
  function asMetadataUrls(authServer) {
    const base = String(authServer).replace(/\/$/, '');
    // RFC 8414 places the well-known between host and path; we probe the common host-level forms first, then OIDC.
    return [base + '/.well-known/oauth-authorization-server', base + '/.well-known/openid-configuration'];
  }

  // DISCOVERY: server URL (+ optional WWW-Authenticate header) -> the AS endpoints the flow needs.
  async function discover(opts) {
    opts = opts || {};
    const fetchImpl = opts.fetchImpl; if (typeof fetchImpl !== 'function') throw new Error('discover: fetchImpl required');
    const serverUrl = String(opts.serverUrl || ''); if (!serverUrl) throw new Error('discover: serverUrl required');
    const parsed = parseWwwAuthenticate(opts.wwwAuthenticate);
    const prmUrl = parsed.resourceMetadata || defaultResourceMetadataUrl(serverUrl);
    const prm = await getJson(fetchImpl, prmUrl, 'protected-resource metadata');
    const servers = prm.authorization_servers || (prm.authorization_server ? [prm.authorization_server] : []);
    if (!servers.length) throw new Error('no authorization_servers in resource metadata');
    const authServer = String(servers[0]);
    let asMeta = null, lastErr = null;
    for (const asUrl of asMetadataUrls(authServer)) {
      try { asMeta = await getJson(fetchImpl, asUrl, 'authorization-server metadata'); break; } catch (e) { lastErr = e; }
    }
    if (!asMeta) throw lastErr || new Error('no authorization-server metadata');
    if (!asMeta.authorization_endpoint || !asMeta.token_endpoint) throw new Error('authorization-server metadata missing endpoints');
    return {
      authorizationServer: authServer,
      authorizationEndpoint: String(asMeta.authorization_endpoint),
      tokenEndpoint: String(asMeta.token_endpoint),
      registrationEndpoint: asMeta.registration_endpoint ? String(asMeta.registration_endpoint) : '',
      codeChallengeMethods: Array.isArray(asMeta.code_challenge_methods_supported) ? asMeta.code_challenge_methods_supported : ['S256'],
      scopesSupported: Array.isArray(asMeta.scopes_supported) ? asMeta.scopes_supported : null,
      resource: serverUrl,                 // RFC 8707 resource indicator = the canonical MCP server URL
      resourceMetadataUrl: prmUrl
    };
  }

  // RFC 7591 DYNAMIC CLIENT REGISTRATION: mint a public client (no secret; PKCE) bound to our loopback redirect.
  async function registerClient(opts) {
    opts = opts || {};
    const fetchImpl = opts.fetchImpl; if (typeof fetchImpl !== 'function') throw new Error('registerClient: fetchImpl required');
    if (!opts.registrationEndpoint) throw new Error('registerClient: registrationEndpoint required (server has no dynamic registration)');
    if (!opts.redirectUri) throw new Error('registerClient: redirectUri required');
    const body = {
      client_name: opts.clientName || 'StarNet',
      redirect_uris: [opts.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',   // public client — PKCE is the proof, never a secret
      application_type: 'native'
    };
    assertSafeUrl(opts.registrationEndpoint, 'client registration');
    let res;
    try { res = await fetchImpl(opts.registrationEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' }); }
    catch (e) { throw new Error('client registration failed: ' + ((e && e.message) || e)); }
    if (!res || res.status < 200 || res.status >= 300) { let d = ''; try { d = (await res.text()).slice(0, 160); } catch (_) {} throw new Error('client registration HTTP ' + (res && res.status) + (d ? ' — ' + d : '')); }
    let j; try { j = await res.json(); } catch (e) { throw new Error('client registration returned non-JSON'); }
    if (!j.client_id) throw new Error('client registration response had no client_id');
    return { clientId: String(j.client_id), clientSecret: j.client_secret ? String(j.client_secret) : '', raw: j };
  }

  function buildAuthorizeUrl(o) {
    o = o || {};
    if (!o.authorizationEndpoint) throw new Error('buildAuthorizeUrl needs authorizationEndpoint');
    if (!o.clientId) throw new Error('buildAuthorizeUrl needs clientId');
    if (!o.redirectUri) throw new Error('buildAuthorizeUrl needs redirectUri');
    if (!o.challenge) throw new Error('buildAuthorizeUrl needs a PKCE challenge');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: o.clientId,
      redirect_uri: o.redirectUri,
      code_challenge: o.challenge,
      code_challenge_method: 'S256',
      state: o.state || ''
    });
    if (o.resource) q.set('resource', o.resource);               // RFC 8707 — bind the token to this MCP server
    const scope = Array.isArray(o.scope) ? o.scope.join(' ') : (o.scope || '');
    if (scope) q.set('scope', scope);
    const sep = o.authorizationEndpoint.indexOf('?') >= 0 ? '&' : '?';
    return o.authorizationEndpoint + sep + q.toString();
  }

  function tokensFromResponse(resp, fetchedAtMs, priorRefresh) {
    resp = resp || {};
    const expiresInMs = (Number(resp.expires_in) || 3600) * 1000;
    return {
      accessToken: resp.access_token || '',
      refreshToken: resp.refresh_token || priorRefresh || '',
      expiresAt: fetchedAtMs + expiresInMs,
      scope: resp.scope || '',
      tokenType: resp.token_type || 'Bearer'
    };
  }
  // refresh a bit early (skew) so a token never expires mid-request. `now` injected.
  function needsRefresh(expiresAt, now, skewMs) {
    if (!expiresAt) return true;
    return now >= (expiresAt - (skewMs == null ? 60000 : skewMs));
  }

  async function postForm(fetchImpl, tokenEndpoint, params, label) {
    assertSafeUrl(tokenEndpoint, label);
    let res;
    try { res = await fetchImpl(tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body: new URLSearchParams(params).toString(), redirect: 'manual' }); }
    catch (e) { throw new Error((label || 'token request') + ' failed: ' + ((e && e.message) || e)); }
    if (!res || res.status < 200 || res.status >= 300) { let d = ''; try { d = (await res.text()).slice(0, 200); } catch (_) {} throw new Error((label || 'token request') + ' HTTP ' + (res && res.status) + (d ? ' — ' + d : '')); }
    try { return await res.json(); } catch (e) { throw new Error((label || 'token request') + ' returned non-JSON'); }
  }

  async function exchangeCode(o) {
    o = o || {};
    if (!o.fetchImpl) throw new Error('exchangeCode: fetchImpl required');
    const params = {
      grant_type: 'authorization_code',
      code: o.code || '',
      redirect_uri: o.redirectUri || '',
      client_id: o.clientId || '',
      code_verifier: o.verifier || ''
    };
    if (o.resource) params.resource = o.resource;
    const json = await postForm(o.fetchImpl, o.tokenEndpoint, params, 'code exchange');
    return tokensFromResponse(json, o.now || 0, '');
  }

  async function refreshTokens(o) {
    o = o || {};
    if (!o.fetchImpl) throw new Error('refreshTokens: fetchImpl required');
    const params = { grant_type: 'refresh_token', refresh_token: o.refreshToken || '', client_id: o.clientId || '' };
    if (o.resource) params.resource = o.resource;
    const json = await postForm(o.fetchImpl, o.tokenEndpoint, params, 'token refresh');
    return tokensFromResponse(json, o.now || 0, o.refreshToken || '');   // keep the old refresh_token if the AS omits a new one
  }

  return {
    base64url, makeVerifier, challengeOf, parseWwwAuthenticate,
    defaultResourceMetadataUrl, discover, registerClient, buildAuthorizeUrl,
    exchangeCode, refreshTokens, tokensFromResponse, needsRefresh,
    _internals: { asMetadataUrls, getJson, postForm }
  };
});
