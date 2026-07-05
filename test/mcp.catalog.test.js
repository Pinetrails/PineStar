/* node test/mcp.catalog.test.js — the CURATED connector catalog (sidecar/mcp/catalog.js).
   Locks the shape + selectors AND the honesty invariants the catalog must never regress:
   every seeded endpoint is a Streamable-HTTP url the manager's http transport can actually drive
   (https, no legacy `/sse`), ids are upsert-safe, `installable` tracks the auth tier, and installConfig
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
  // clone guarantee: mutating a returned entry must not leak into the next read.
  all[0].name = 'MUTATED';
  A.ok(C.list()[0].name !== 'MUTATED', 'list() returns defensive clones (seed is immutable)');
}

// ---- B. installable tracks the auth tier exactly (none|apikey today; oauth is listed-but-gated) ----
{
  for (const e of C.list()) {
    const expect = (e.authType === 'none' || e.authType === 'apikey');
    A.eq(e.installable, expect, e.id + ' installable === (auth is none|apikey)');
    A.eq(C.isInstallable(e), expect, e.id + ' isInstallable() agrees');
  }
  A.ok(C.INSTALLABLE_AUTH.indexOf('oauth') < 0, 'oauth is NOT installable today (no flow wired)');
  A.ok(C.INSTALLABLE_AUTH.indexOf('none') >= 0 && C.INSTALLABLE_AUTH.indexOf('apikey') >= 0, 'none+apikey are installable');
}

// ---- C. HONESTY invariants: only endpoints the http transport can drive; installable ⇒ real https url ----
{
  for (const e of C.list()) {
    // never seed a legacy GET-/sse dual-endpoint server — transport.http.js only speaks Streamable HTTP.
    A.ok(String(e.url).indexOf('/sse') < 0, e.id + ' url is not a legacy /sse endpoint');
    if (e.url) A.ok(/^https:\/\//.test(e.url), e.id + ' url (when set) is https');
    // an installable connector MUST have a concrete https endpoint — otherwise "Add" would fail.
    if (e.installable) A.ok(/^https:\/\/\S+/.test(e.url), e.id + ' installable ⇒ has a concrete https url');
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
  A.eq(C.installConfig('notion'), null, 'installConfig is null for an oauth (not-installable) entry');
  A.eq(C.installConfig('nope'), null, 'installConfig is null for an unknown id');
}

// ---- G. determinism: repeated reads are byte-identical (pure, no ambient time/rng) ----
{
  A.eq(JSON.stringify(C.browse(['stripe'])), JSON.stringify(C.browse(['stripe'])), 'browse is deterministic');
  A.eq(JSON.stringify(C.list()), JSON.stringify(C.list()), 'list is deterministic');
}

console.log('ok - mcp.catalog');
