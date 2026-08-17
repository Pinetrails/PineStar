/* node test/mcp.catalog.test.js — the CURATED connector catalog (sidecar/mcp/catalog.js).
   Locks the shape + selectors AND the honesty invariants the catalog must never regress:
   every seeded endpoint is a Streamable-HTTP url the manager's http transport can actually drive
   (https or explicit loopback, no legacy `/sse`), ids are upsert-safe, `installable` tracks the auth tier, and installConfig
   never leaks a token. Pure + deterministic — two reads deep-equal. */
'use strict';
const A = require('./_assert.js');
const C = require('../sidecar/mcp/catalog.js');

const AUTH = { none: 1, apikey: 1, oauth: 1 };
// the exact id shape POST /api/connectors accepts (index.js handleConnectorUpsert) — a catalog id that
// fails this could never be installed, so the catalog would be lying about it.
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

// ---- A. list(): entries exist, carry the full shape, and are CLONED (no mutating the seed) ----
{
  const all = C.list();
  A.ok(Array.isArray(all) && all.length >= 10, 'catalog lists a real seed (>=10 connectors)');
  for (const e of all) {
    A.ok(ID_RE.test(e.id), 'id "' + e.id + '" is upsert-safe');
    A.ok(!!e.name, e.id + ' has a name');
    A.ok(!!e.category, e.id + ' has a category');
    A.ok(AUTH[e.authType] === 1, e.id + ' authType is none|apikey|oauth (got ' + e.authType + ')');
    A.eq(e.transport, 'http', e.id + ' transport is http (Streamable HTTP)');
    A.eq(typeof e.installable, 'boolean', e.id + ' exposes an installable flag');
    A.ok(!!e.blurb, e.id + ' has a human blurb');
  }
  // ids are unique (a dupe would collide on install / in the manager's config list).
  const ids = all.map(e => e.id);
  A.eq(new Set(ids).size, ids.length, 'connector ids are unique');
  const names = all.map(e => e.name.toLowerCase());
  A.eq(new Set(names).size, names.length, 'connector names are unique');
  const urls = all.map(e => String(e.url || '').replace(/\/+$/, '').toLowerCase()).filter(Boolean);
  A.eq(new Set(urls).size, urls.length, 'canonical connector URLs are unique');
  // clone guarantee: mutating a returned entry must not leak into the next read.
  all[0].name = 'MUTATED';
  A.ok(C.list()[0].name !== 'MUTATED', 'list() returns defensive clones (seed is immutable)');
  const composio = all.find(e => e.id === 'composio');
  composio.presets[0] = 'MUTATED';
  A.eq(C.get('composio').presets[0], 'Gmail', 'nested presets are defensively cloned');
}

// ---- B. installable tracks the auth tier exactly (none|apikey today; oauth is listed-but-gated) ----
{
  for (const e of C.list()) {
    const expect = (e.authType === 'none' || e.authType === 'apikey');
    A.eq(e.installable, expect, e.id + ' installable === (auth is none|apikey)');
    A.eq(C.isInstallable(e), expect, e.id + ' isInstallable() agrees');
  }
  A.ok(C.INSTALLABLE_AUTH.indexOf('oauth') < 0, 'oauth is not a direct-install tier — it is stood up by its own sign-in flow');
  A.ok(C.INSTALLABLE_AUTH.indexOf('none') >= 0 && C.INSTALLABLE_AUTH.indexOf('apikey') >= 0, 'none+apikey are installable');
}

// ---- C. HONESTY invariants: only endpoints the http transport can drive; cleartext is loopback-only ----
{
  for (const e of C.list()) {
    // never seed a legacy GET-/sse dual-endpoint server — transport.http.js only speaks Streamable HTTP.
    A.ok(String(e.url).indexOf('/sse') < 0, e.id + ' url is not a legacy /sse endpoint');
    if (e.url) {
      const u = new URL(e.url);
      const loopback = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1');
      A.ok(u.protocol === 'https:' || (e.local && loopback), e.id + ' url is https or explicitly local loopback');
      if (e.local) A.ok(loopback, e.id + ' local flag never excuses a non-loopback cleartext URL');
    }
    // an installable connector MUST have a concrete transport-safe endpoint — otherwise "Add" would fail.
    if (e.installable) A.ok(/^https?:\/\/\S+/.test(e.url), e.id + ' installable ⇒ has a concrete http(s) url');
  }
}

// ---- D. categories(): stable known-first order, no dupes, covers every entry's category ----
{
  const cats = C.categories();
  A.eq(new Set(cats).size, cats.length, 'categories() has no duplicates');
  const seedCats = new Set(C.list().map(e => e.category));
  for (const c of seedCats) A.ok(cats.indexOf(c) >= 0, 'category "' + c + '" appears in categories()');
  A.eq(cats.length, seedCats.size, 'categories() lists exactly the categories in use');
  // known-first: 'Docs & Knowledge' (first in CATEGORY_ORDER) precedes any ad-hoc category.
  A.eq(cats[0], 'Docs & Knowledge', 'the ordered head is the first known category');
}

// ---- E. browse(installedIds): marks installed, groups cover all connectors in category order ----
{
  const b = C.browse(['deepwiki', 'not-a-real-id']);
  A.ok(Array.isArray(b.groups) && b.groups.length === b.categories.length, 'a group per category');
  const flat = b.groups.reduce((n, g) => n + g.connectors.length, 0);
  A.eq(flat, b.connectors.length, 'groups partition every connector exactly once');
  A.eq(b.connectors.length, C.list().length, 'browse covers the whole catalog');
  const dw = b.connectors.find(e => e.id === 'deepwiki');
  A.eq(dw.installed, true, 'a configured id is marked installed');
  A.eq(b.connectors.find(e => e.id === 'context7').installed, false, 'an unconfigured id is not installed');
  // group order follows categories() order.
  A.eq(b.groups.map(g => g.category).join('|'), b.categories.join('|'), 'group order == category order');
  // empty/absent input ⇒ nothing installed (never throws).
  A.ok(C.browse().connectors.every(e => e.installed === false), 'no input ⇒ nothing marked installed');
  // TRUTHFUL TELEMETRY: with {id,url}, a config that reuses a catalog id but points at a FOREIGN url is NOT installed;
  // the entry's real url IS. (Guards against a manual connector named 'stripe' flipping the vetted vendor card.)
  A.eq(C.browse([{ id: 'stripe', url: 'https://evil.example/mcp' }]).connectors.find(e => e.id === 'stripe').installed, false, 'foreign-url id collision is not installed');
  A.eq(C.browse([{ id: 'stripe', url: C.get('stripe').url }]).connectors.find(e => e.id === 'stripe').installed, true, 'the real catalog url marks it installed');
  A.eq(C.browse([{ id: 'stripe', url: C.get('stripe').url + '/' }]).connectors.find(e => e.id === 'stripe').installed, true, 'url match is trailing-slash tolerant');
}

// ---- F. installConfig(): upsert-shaped for installable entries, null for oauth, NEVER a token ----
{
  const cfg = C.installConfig('deepwiki');
  A.ok(cfg && cfg.id === 'deepwiki', 'installConfig returns a config for an installable entry');
  A.eq(cfg.transport, 'http', 'config carries transport');
  A.ok(/^https:\/\//.test(cfg.url), 'config carries the https url');
  A.eq(cfg.label, 'DeepWiki', 'config carries a friendly label');
  A.eq(cfg.enabled, true, 'config enables the connector');
  A.ok(!('token' in cfg), 'installConfig NEVER embeds a token (the user supplies it)');
  const composio = C.installConfig('composio');
  A.eq(composio.keyHeader, 'x-consumer-api-key', 'Composio declares its official non-Bearer key header');
  A.ok(!('token' in composio), 'custom-header install config still never embeds the user secret');
  A.eq(C.installConfig('notion'), null, 'installConfig is null for an oauth (not-installable) entry');
  A.eq(C.installConfig('nope'), null, 'installConfig is null for an unknown id');
}

// ---- G. determinism: repeated reads are byte-identical (pure, no ambient time/rng) ----
{
  A.eq(JSON.stringify(C.browse(['stripe'])), JSON.stringify(C.browse(['stripe'])), 'browse is deterministic');
  A.eq(JSON.stringify(C.list()), JSON.stringify(C.list()), 'list is deterministic');
}

// ---- H. the named common paste-a-key connectors (X, aggregator, search) are present + installable ----
{
  for (const id of ['x-twitter', 'composio', 'tavily']) {
    const e = C.get(id);
    A.ok(e, id + ' is in the catalog');
    A.eq(e.authType, 'apikey', id + ' is a paste-a-key (apikey) connector');
    A.eq(e.installable, true, id + ' is installable today');
    A.ok(/^https:\/\/\S+/.test(e.url), id + ' has a concrete https endpoint (verified reachable)');
    const cfg = C.installConfig(id);
    A.ok(cfg && !('token' in cfg), id + ' installConfig carries no token (the user pastes the key)');
  }
  A.eq(C.get('composio').keyHeader, 'x-consumer-api-key', 'Composio public metadata carries the required header name, never its value');
  A.ok(C.categories().indexOf('Social') >= 0, 'Social category is present (home for X)');
  A.eq(C.get('x-twitter').category, 'Social', 'X is filed under Social');
}

// ---- I. wave-2 additions: present, correctly tiered, and the Design category exists ----
{
  A.ok(C.categories().indexOf('Design') >= 0, 'Design category present (Canva/Webflow/Wix)');
  for (const id of ['gitlab', 'vercel', 'asana', 'canva', 'paypal', 'square', 'neon', 'netlify', 'monday', 'webflow', 'wix']) A.eq((C.get(id) || {}).authType, 'oauth', id + ' is an oauth connector');
  for (const id of ['airtable', 'prisma', 'intercom']) A.eq((C.get(id) || {}).authType, 'apikey', id + ' is a paste-a-key connector');
  for (const id of ['cloudflare-docs', 'microsoft-learn']) { const e = C.get(id); A.eq(e.authType, 'none', id + ' is zero-setup'); A.eq(e.installable, true, id + ' installs with no key'); }
  A.ok(C.list().length >= 30, 'catalog now carries a substantial verified set (30+)');
}

// ---- J. OAuth-audit retiers (2026-07-18): GitHub is a PAT connector; url-less oauth entries carry `via` ----
{
  // github.com/login/oauth has NO dynamic client registration (live-probed), so an oauth tier could never
  // complete a sign-in — the honest tier is apikey (PAT as bearer, GitHub's documented remote-server path).
  const gh = C.get('github');
  A.eq(gh.authType, 'apikey', 'github is a paste-a-key (PAT) connector — its AS has no dynamic registration');
  A.eq(gh.installable, true, 'github is installable today');
  A.ok(!('token' in (C.installConfig('github') || {})), 'github installConfig carries no token');
  // `via` honesty: only url-less oauth entries carry it, and it must point at a REAL installable catalog
  // entry — otherwise the "VIA <name>" jump would land nowhere (a dead click with extra steps).
  for (const e of C.list()) {
    if (e.via) {
      A.eq(e.authType, 'oauth', e.id + ' via is only for oauth entries');
      A.eq(e.url, '', e.id + ' via is only for url-less entries (a direct endpoint signs in directly)');
      const target = C.get(e.via);
      A.ok(target && target.installable, e.id + ' via targets a real, installable catalog entry (' + e.via + ')');
    }
  }
  for (const id of ['google-workspace', 'atlassian']) A.ok(!!(C.get(id) || {}).via, id + ' points at its aggregator route (via)');
}

// ---- K. requested parity additions are present once, and pre-existing routes stay singular ----
{
  const parallel = C.get('parallel-search');
  A.eq(parallel.url, 'https://search.parallel.ai/mcp', 'Parallel uses its verified anonymous Streamable-HTTP endpoint');
  A.eq(parallel.authType, 'none', 'Parallel anonymous tier is zero-setup');

  const unreal = C.get('unreal-engine');
  A.eq(unreal.category, 'Advanced / Developer', 'Unreal Engine is filed under Advanced / Developer');
  A.eq(unreal.url, 'http://127.0.0.1:8000/mcp', 'Unreal uses Epic\'s documented local editor endpoint');
  A.eq(unreal.local, true, 'Unreal is explicitly marked local');

  const composio = C.get('composio');
  A.eq(composio.presets, ['Gmail', 'Outlook'], 'one existing connector exposes the Gmail + Outlook presets');
  A.ok(composio.aliases.indexOf('email') >= 0 && composio.aliases.indexOf('microsoft outlook') >= 0, 'email searches resolve to the preset-bearing connector');
  A.eq(C.list().filter(e => /^(gmail|outlook|email)$/i.test(e.name)).length, 0, 'email presets do not create duplicate connector cards');

  A.eq(C.list().filter(e => /duckduckgo/i.test(e.id + ' ' + e.name)).length, 0, 'DuckDuckGo is not duplicated as a connector (it is built into web_search)');
  A.eq(C.get('atlassian').via, 'zapier', 'Atlassian stays on the proven route until an authenticated direct tool call exists');
}

// report() LAST — it is what calls process.exit(fail?1:0). This file used to end in a bare
// console.log, so every assertion failure printed FAIL and STILL exited 0: the fast gate scored
// it green no matter what broke. Never end an _assert.js test any other way.
A.report('mcp.catalog.test');
