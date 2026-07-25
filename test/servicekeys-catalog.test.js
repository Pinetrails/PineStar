/* node test/servicekeys-catalog.test.js — the KEYS platform directory (sidecar/servicekeys-catalog.js).

   This directory exists because most platforms ship NO remote MCP server (probed 2026-07-24: printify,
   printful, etsy, woocommerce, shopify all 404 or do not resolve), so the generic KEYS + web_request path
   is their route and the picker is how a user finds it. A row here is a PROMISE that picking it works —
   so the invariants below are the honesty gate:

     • picking a row must PREFILL a name whose derived env var is exactly the one advertised, or the
       agent's ${PLACEHOLDER} would name a variable that does not exist
     • every row must survive a REAL upsert, so no row can be a dead click (a model-provider name would be
       refused as reserved — that trap shipped in a draft of this file and is locked out here)
     • every row must carry a docs URL: it rides into the system prompt and is what lets the agent find the
       right endpoint instead of guessing */
'use strict';
const A = require('./_assert.js');
const C = require('../sidecar/servicekeys-catalog.js');
const K = require('../sidecar/servicekeys.js');

// stand-in for the host's real reserved set (every model-provider keyEnv + its scoped forms)
const RESERVED = new Set(['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'STARNET_OPENROUTER_API_KEY', 'SKYNET_OPENROUTER_API_KEY']);

A.ok(C.PLATFORMS.length >= 8, 'the directory is seeded (' + C.PLATFORMS.length + ' platforms)');

// ---- A. per-row invariants ----
const ids = new Set();
for (const p of C.PLATFORMS) {
  const at = ' [' + p.id + ']';
  A.ok(/^[a-z0-9-]+$/.test(p.id), 'id is a slug' + at);
  A.ok(!ids.has(p.id), 'id is unique' + at); ids.add(p.id);
  A.ok(!!p.name && !!p.category && !!p.blurb, 'name/category/blurb present' + at);

  // THE LOAD-BEARING ONE: the picker prefills `name`, and servicekeys derives the env var from it.
  A.eq(K.deriveEnvVar(p.name), p.envVar, 'deriveEnvVar(name) === advertised envVar' + at);

  // docsUrl rides into the prompt — an agent with no docs link guesses endpoints.
  A.ok(/^https:\/\//.test(p.docsUrl || ''), 'has an https docs URL' + at);
  A.ok(/^https:\/\//.test(p.apiBase || '') || /\{/.test(p.apiBase || ''), 'apiBase is https or an explicit template' + at);

  // an authHint must actually reference THIS row's key, or it teaches the wrong placeholder
  if (p.authHint) A.ok(p.authHint.indexOf('${' + p.envVar + '}') >= 0, 'authHint uses this row\'s placeholder' + at);

  // NO DEAD CLICKS: the row must survive the real upsert path, reserved-name guard included.
  const r = K.upsert([], { name: p.name, key: 'probe-key', docsUrl: p.docsUrl }, 1, { reservedEnv: RESERVED });
  A.ok(!r.error, 'a real upsert accepts this row' + at + (r.error ? ' — ' + r.error : ''));
  if (!r.error) A.eq(r.record.envVar, p.envVar, 'the saved record carries the advertised envVar' + at);
}

// ---- B. no model providers (their env names are reserved; the row would always fail on save) ----
for (const p of C.PLATFORMS) {
  A.ok(!RESERVED.has(p.envVar), 'no reserved provider env var in the directory [' + p.id + ']');
  A.ok(!/^(openrouter|anthropic|openai)$/i.test(p.id), 'no model-provider row [' + p.id + ']');
}

// ---- C. the commerce gap this whole lane came from is actually covered ----
{
  const byId = id => C.PLATFORMS.find(p => p.id === id);
  for (const id of ['printify', 'printful', 'shopify', 'etsy']) {
    A.ok(!!byId(id), 'the directory covers ' + id + ' — the case with no MCP server anywhere');
  }
  A.eq(byId('printify').envVar, 'PRINTIFY_API_KEY', 'Printify resolves to the env var the docs promise');
  A.ok(/Bearer/.test(byId('printify').authHint || ''), 'Printify carries its verified bearer hint');
  // Etsy needs OAuth for most endpoints — it must SAY so rather than imply a key is enough
  A.ok(/OAuth/i.test(byId('etsy').note || ''), 'Etsy warns that a keystring alone is not enough');
  // Shopify is per-store, so a fixed apiBase would be a lie
  A.ok(/\{/.test(byId('shopify').apiBase || ''), 'Shopify apiBase is templated on the store host');
}

// ---- D. grouping / selectors ----
{
  const groups = C.grouped(['PRINTIFY_API_KEY']);
  A.ok(groups.length >= 3, 'grouped() returns categories');
  const flat = groups.flatMap(g => g.platforms);
  A.eq(flat.length, C.PLATFORMS.length, 'grouping loses no platform');
  A.eq(flat.find(p => p.id === 'printify').installed, true, 'an existing key marks its platform installed');
  A.eq(flat.find(p => p.id === 'printful').installed, false, 'others are not marked installed');
  A.ok(groups[0].category === C.CATEGORY_ORDER[0], 'declared category order leads');
  // no secret-bearing FIELD may ride the payload (the word "key" legitimately appears in blurbs/notes,
  // so assert on property names, not on the serialized text).
  const secretish = flat.filter(p => ['key', 'token', 'secret', 'apiKey'].some(f => Object.prototype.hasOwnProperty.call(p, f)));
  A.eq(secretish.length, 0, 'no platform row carries a key/token/secret field');
  A.eq(C.grouped([]).flatMap(g => g.platforms).every(p => p.installed === false), true, 'nothing installed on an empty store');
  A.eq(C.byId('printify').id, 'printify', 'byId resolves');
  A.eq(C.byId('nope'), null, 'byId is null for an unknown id');
}

A.report('servicekeys-catalog.test.js');
