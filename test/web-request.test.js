/* node test/web-request.test.js — the web_request tool: calling a third-party API as the Commander.

   The capability that was missing: nothing in StarNet could send a custom HTTP header, so every
   authenticated API meant handing the agent a full shell (shell.exec + curl) — a placed workbench and a
   far larger grant than "make one HTTPS call". This locks the properties that make the narrow tool safe:

     • the KEY NEVER ENTERS MODEL CONTEXT — the model writes ${NAME}, the host substitutes at send time
     • a placeholder in the URL is REFUSED (secrets in URLs leak to logs/history/Referer)
     • unattended runs may only spend a key the Commander explicitly approved for unattended use
     • the SSRF guard, header-injection guard, and credential-dropping on cross-host redirects hold */
'use strict';
const A = require('./_assert.js');
const { makeWebTools } = require('../sidecar/tools/builtin/web.js');
const K = require('../sidecar/servicekeys.js');

const SECRET = 'pk-live-SUPERSECRET-9f3a';

// a KEYS store: one interactive-only key, one approved for unattended use, one disabled
let keys = [];
keys = K.upsert(keys, { name: 'Printify', key: SECRET }, 1).list;                 // enabled, NOT autonomous
keys = K.upsert(keys, { name: 'Nightly', key: 'nightly-token' }, 2).list;
keys = K.setAutonomous(keys, 'nightly', true).list;                               // approved for unattended
keys = K.upsert(keys, { name: 'Offkey', key: 'off-token' }, 3).list;
keys = K.setEnabled(keys, 'offkey', false).list;                                  // disabled entirely

function tools(surface, fetchImpl) {
  return makeWebTools({
    fetchImpl, lookup: null, surface, redact: s => s,
    resolveServiceKey: (name, sfc) => K.resolveForRequest(keys, name, sfc)
  }).requestTool;
}
// records what actually went on the wire
function recorder(responses) {
  const sent = [];
  let i = 0;
  const impl = async (url, opts) => {
    sent.push({ url, opts });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { status: r.status, headers: { get: h => (r.headers || {})[h.toLowerCase()] || '' }, text: async () => r.body || '' };
  };
  return { impl, sent };
}
const ctx = () => ({ agentId: 'a1', runId: 'r1', callId: 'c1', emit: () => {} });
const OK = [{ status: 200, headers: { 'content-type': 'application/json' }, body: '{"shops":[{"id":1}]}' }];

(async () => {
  // ---- A. the placeholder is substituted on the wire, and the secret never comes back to the model ----
  {
    const rec = recorder(OK);
    const t = tools('interactive', rec.impl);
    const out = await t.run({ url: 'https://api.printify.com/v1/shops.json', headers: { Authorization: 'Bearer ${PRINTIFY_API_KEY}' } }, ctx());
    A.eq(rec.sent[0].opts.headers.Authorization, 'Bearer ' + SECRET, 'the REAL key is sent on the wire');
    A.ok(out.content.indexOf(SECRET) < 0, 'THE CORE PROPERTY: the secret never appears in the tool result');
    A.ok(out.content.indexOf('shops') >= 0, 'the response body reaches the model');
    A.ok(/authenticated with PRINTIFY_API_KEY/.test(out.content), 'the model is told WHICH key was spent, by name');
    A.ok(/BEGIN EXTERNAL WEB CONTENT/.test(out.content), 'the third-party body is fenced as untrusted data');
    A.eq(rec.sent[0].opts.method, 'GET', 'defaults to GET');
  }

  // ---- B. a placeholder in the URL is refused outright ----
  {
    const rec = recorder(OK);
    const t = tools('interactive', rec.impl);
    let msg = '';
    try { await t.run({ url: 'https://api.example.com/v1?key=${PRINTIFY_API_KEY}' }, ctx()); }
    catch (e) { msg = e.message; }
    A.ok(/cannot go in the url/.test(msg), 'a ${KEY} in the url is refused: ' + JSON.stringify(msg));
    A.eq(rec.sent.length, 0, 'nothing was sent');
  }

  // ---- C. unknown / disabled keys give an ACTIONABLE error, and never a blank substitution ----
  {
    const t = tools('interactive', recorder(OK).impl);
    let msg = '';
    try { await t.run({ url: 'https://api.x.com/v1', headers: { Authorization: 'Bearer ${NOPE_API_KEY}' } }, ctx()); }
    catch (e) { msg = e.message; }
    A.ok(/no enabled service key provides NOPE_API_KEY/.test(msg) && /KEYS/.test(msg), 'unknown key names the var and the fix');

    let msg2 = '';
    try { await t.run({ url: 'https://api.x.com/v1', headers: { Authorization: 'Bearer ${OFFKEY_API_KEY}' } }, ctx()); }
    catch (e) { msg2 = e.message; }
    A.ok(/no enabled service key/.test(msg2), 'a DISABLED key is treated as absent, not silently spent');
  }

  // ---- D. THE UNATTENDED GRANT ----
  {
    // interactive: an ordinary enabled key works
    const rec1 = recorder(OK);
    await tools('interactive', rec1.impl).run({ url: 'https://api.printify.com/v1/shops.json', headers: { Authorization: 'Bearer ${PRINTIFY_API_KEY}' } }, ctx());
    A.eq(rec1.sent[0].opts.headers.Authorization, 'Bearer ' + SECRET, 'watched run may spend an ordinary key');

    // autonomous: the SAME key is refused, with a message that names the platform and both cures
    const rec2 = recorder(OK);
    let msg = '';
    try { await tools('autonomous', rec2.impl).run({ url: 'https://api.printify.com/v1/shops.json', headers: { Authorization: 'Bearer ${PRINTIFY_API_KEY}' } }, ctx()); }
    catch (e) { msg = e.message; }
    A.ok(/unattended/.test(msg) && /Printify/.test(msg), 'unattended run refuses a key that was never approved for it: ' + JSON.stringify(msg));
    A.eq(rec2.sent.length, 0, 'and nothing was sent');

    // autonomous: a key the Commander DID approve goes through
    const rec3 = recorder(OK);
    await tools('autonomous', rec3.impl).run({ url: 'https://api.night.com/v1', headers: { Authorization: 'Bearer ${NIGHTLY_API_KEY}' } }, ctx());
    A.eq(rec3.sent[0].opts.headers.Authorization, 'Bearer nightly-token', 'an approved key IS spendable unattended');
  }

  // ---- E. an autonomous run cannot talk itself into a grant ----
  {
    // the surface is host authority: it is fixed at construction from the RUN, not readable from args
    const rec = recorder(OK);
    let msg = '';
    try {
      await tools('autonomous', rec.impl).run(
        { url: 'https://api.printify.com/v1', surface: 'interactive', headers: { Authorization: 'Bearer ${PRINTIFY_API_KEY}' } }, ctx());
    } catch (e) { msg = e.message; }
    A.ok(/unattended/.test(msg), 'a surface field in tool ARGS cannot unlock a key');
  }

  // ---- F. SSRF + header-injection guards ----
  {
    const t = tools('interactive', recorder(OK).impl);
    for (const bad of ['http://localhost/admin', 'http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd']) {
      let m = '';
      try { await t.run({ url: bad }, ctx()); } catch (e) { m = e.message; }
      A.ok(/refusing|only http|invalid URL/.test(m), 'refused ' + bad + ' (' + m + ')');
    }
    let hm = '';
    try { await t.run({ url: 'https://api.x.com/v1', headers: { 'X-Evil': 'a\r\nInjected: 1' } }, ctx()); } catch (e) { hm = e.message; }
    A.ok(/newline/.test(hm), 'a header value containing CRLF is refused');
  }

  // ---- G. a cross-host redirect must NOT forward the credential ----
  {
    const rec = recorder([
      { status: 302, headers: { location: 'https://evil.example.com/steal' } },
      { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' }
    ]);
    await tools('interactive', rec.impl).run(
      { url: 'https://api.printify.com/v1/shops.json', headers: { Authorization: 'Bearer ${PRINTIFY_API_KEY}' } }, ctx());
    A.eq(rec.sent.length, 2, 'the redirect was followed');
    A.eq(rec.sent[0].opts.headers.Authorization, 'Bearer ' + SECRET, 'hop 1 carried the credential');
    A.ok(!rec.sent[1].opts.headers.Authorization, 'hop 2 (different host) DROPPED the credential');
  }

  // ---- G2. the drop keys on WHICH SLOT HOLDS A KEY, not on a three-name denylist ----
  // The model picks the header name, and most of the real API world does not use Authorization:
  // X-Shopify-Access-Token, Private-Token, apikey, X-Auth-Token all rode an open redirect to the
  // attacker host verbatim. The host substitutes the key itself, so it KNOWS which slots carry one.
  {
    const rec = recorder([
      { status: 302, headers: { location: 'https://evil.example.com/steal' } },
      { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' }
    ]);
    await tools('interactive', rec.impl).run(
      { url: 'https://api.printify.com/v1/shops.json', headers: { 'X-Shopify-Access-Token': '${PRINTIFY_API_KEY}' } }, ctx());
    A.eq(rec.sent[0].opts.headers['X-Shopify-Access-Token'], SECRET, 'hop 1 carried the custom-slot credential');
    A.ok(!rec.sent[1].opts.headers['X-Shopify-Access-Token'], 'hop 2 DROPPED it even though the slot is not on any denylist');
  }

  // ---- G3. ORIGIN, not host: an https -> http redirect on the SAME hostname is still a credential leak ----
  {
    const rec = recorder([
      { status: 301, headers: { location: 'http://api.printify.com/v1/shops.json' } },
      { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' }
    ]);
    await tools('interactive', rec.impl).run(
      { url: 'https://api.printify.com/v1/shops.json', headers: { Authorization: 'Bearer ${PRINTIFY_API_KEY}' } }, ctx());
    A.eq(rec.sent.length, 2, 'the downgrade redirect was followed');
    A.ok(!rec.sent[1].opts.headers.Authorization, 'a scheme downgrade on the same hostname drops the credential (never cleartext)');
  }

  // ---- G4. a ${KEY} in the BODY is refused, not silently shipped as literal text ----
  {
    const rec = recorder(OK);
    let msg = '';
    try {
      await tools('interactive', rec.impl).run(
        { url: 'https://api.printify.com/v1/shops.json', method: 'POST', body: '{"token":"${PRINTIFY_API_KEY}"}' }, ctx());
    } catch (e) { msg = (e && e.message) || ''; }
    A.ok(/placeholder cannot go in the body/i.test(msg), 'a body placeholder is refused with an actionable message');
    A.eq(rec.sent.length, 0, 'and nothing was sent');
  }

  // ---- H. methods + body ----
  {
    const rec = recorder(OK);
    await tools('interactive', rec.impl).run(
      { url: 'https://api.printify.com/v1/products.json', method: 'post', body: '{"title":"x"}' }, ctx());
    A.eq(rec.sent[0].opts.method, 'POST', 'method is upper-cased');
    A.eq(rec.sent[0].opts.body, '{"title":"x"}', 'body is forwarded');
    A.eq(rec.sent[0].opts.headers['Content-Type'], 'application/json', 'a JSON content-type is defaulted for bodies');

    let m = '';
    try { await tools('interactive', recorder(OK).impl).run({ url: 'https://api.x.com/v1', method: 'TRACE' }, ctx()); } catch (e) { m = e.message; }
    A.ok(/unsupported method/.test(m), 'an unsupported method is refused');
  }

  // ---- I. the tool's own contract ----
  {
    const t = tools('interactive', recorder(OK).impl);
    A.eq(t.name, 'web_request', 'tool name');
    A.eq(t.capability, 'web', 'rides the dish capability, not the workbench');
    A.eq(t.impact, 'external-credentialed', 'carries its own impact class');
    A.eq(t.scope, 'write', 'a network write, NOT execute — execute carries the autonomous shell lockout');
    A.eq(t.requiresConsent, true, 'spending a key always asks');
    A.ok(/\$\{/.test(t.description), 'the description teaches the placeholder form');
    A.ok(/never see it/.test(t.description) || /never ask the user/.test(t.description), 'the description forbids asking the user for the key');
  }

  // ---- J. the AUTH DESCRIPTOR: query-parameter APIs, without the model ever writing the secret ----
  {
    // query mode: the host attaches it at send time
    const rec = recorder(OK);
    const out = await tools('interactive', rec.impl).run(
      { url: 'https://api.example.com/v1/items', auth: { key: 'PRINTIFY_API_KEY', in: 'query', name: 'api_key' } }, ctx());
    A.ok(rec.sent[0].url.indexOf('api_key=' + SECRET) >= 0, 'the key IS on the wire as a query parameter');
    A.ok(out.content.indexOf(SECRET) < 0, 'THE CORE PROPERTY: the secret is still absent from the tool result');
    A.ok(out.content.indexOf('api_key') < 0 || !/api_key=/.test(out.content), 'the echoed label carries no query string');
    A.ok(/authenticated with PRINTIFY_API_KEY/.test(out.content), 'the model is told which key was spent');

    // header mode with a prefix, for symmetry
    const rec2 = recorder(OK);
    await tools('interactive', rec2.impl).run(
      { url: 'https://api.example.com/v1', auth: { key: 'PRINTIFY_API_KEY', in: 'header', name: 'X-Api-Key', prefix: 'Token ' } }, ctx());
    A.eq(rec2.sent[0].opts.headers['X-Api-Key'], 'Token ' + SECRET, 'header mode applies the prefix');

    // the unattended grant governs this path too — it is the same resolver
    const rec3 = recorder(OK);
    let msg = '';
    try {
      await tools('autonomous', rec3.impl).run(
        { url: 'https://api.example.com/v1', auth: { key: 'PRINTIFY_API_KEY', in: 'query', name: 'api_key' } }, ctx());
    } catch (e) { msg = e.message; }
    A.ok(/unattended/.test(msg), 'an ungranted key is refused in query mode too');
    A.eq(rec3.sent.length, 0, 'and nothing was sent');

    // a granted key works unattended
    const rec4 = recorder(OK);
    await tools('autonomous', rec4.impl).run(
      { url: 'https://api.example.com/v1', auth: { key: 'NIGHTLY_API_KEY', in: 'query', name: 'api_key' } }, ctx());
    A.ok(rec4.sent[0].url.indexOf('api_key=nightly-token') >= 0, 'an approved key IS spendable unattended in query mode');

    // auth.key must be a NAME — a pasted literal value must be refused, or the model could smuggle a secret in
    const rec5 = recorder(OK);
    let m2 = '';
    try {
      await tools('interactive', rec5.impl).run(
        { url: 'https://api.example.com/v1', auth: { key: 'sk-live-actual-secret', in: 'query', name: 'api_key' } }, ctx());
    } catch (e) { m2 = e.message; }
    A.ok(/never a key value/.test(m2), 'a literal value in auth.key is refused: ' + JSON.stringify(m2));
    A.eq(rec5.sent.length, 0, 'and nothing was sent');

    // a cross-host redirect must not carry the query credential onward
    const rec6 = recorder([
      { status: 302, headers: { location: 'https://evil.example.com/steal' } },
      { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' }
    ]);
    await tools('interactive', rec6.impl).run(
      { url: 'https://api.example.com/v1', auth: { key: 'PRINTIFY_API_KEY', in: 'query', name: 'api_key' } }, ctx());
    A.ok(rec6.sent[1].url.indexOf(SECRET) < 0, 'hop 2 (different host) carries no query credential');
  }

  A.report('web-request.test.js');
})().catch(e => { console.log('FAIL: web-request.test.js threw — ' + (e && e.stack || e)); process.exit(1); });
