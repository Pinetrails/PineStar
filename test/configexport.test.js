'use strict';
/* configexport.test.js — pure-engine tests for the STATION BACKUP module (P1-7): buildExport / parseImport +
   the secret-redaction law. No IO — the module is dependency-free (index.js wires the live stores). Proves:
     - the envelope is schema-versioned (starnetExport: 1) so future imports can migrate;
     - a full round-trip (build -> parse) preserves the non-secret config;
     - SECRETS NEVER travel: connector tokens/headers/url-auth are redacted to a configured-marker only;
     - import is forward-tolerant (unknown sections dropped, newer schema accepted with a note) + fail-soft
       (a malformed section is skipped, never a throw), and validated (budget clamps, chain capped/cleaned). */
const assert = require('assert');
const C = require('../sidecar/configexport.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

// ---- schema + shape ----
eq(C.SCHEMA, 1, 'schema version is 1');
ok(Array.isArray(C.SECTIONS) && C.SECTIONS.indexOf('budget') >= 0, 'SECTIONS enumerates the known sections');

// ---- buildExport: only present sections are emitted; the version marker + app are stamped ----
const env = C.buildExport({
  settings: { theme: 'green', sound: false },
  budget: { perRun: 2, perDay: 40 },
  fallback: ['a/one', 'b/two'],
  autonomy: { initiative: 'wait', reach: 'sandbox' },
  roster: [{ agentId: 'lead', name: 'Lead', model: 'x/y', provider: 'openrouter', role: 'boss', system: 'SECRET PROMPT' }],
  dossier: 'the commander block',
  permissions: ['fs.write:workspace', 'shell.exec:*'],
  connectors: [{ id: 'gh', url: 'https://mcp.example/api?token=SEKRET', headers: { Authorization: 'Bearer abc', 'X-Foo': 'ok' } }],
  notifyPrefs: { runComplete: true, sound: false }
}, { now: 123, app: 'StarNet' });

eq(env.starnetExport, 1, 'envelope carries the starnetExport:1 version pivot');
eq(env.exportedAt, 123, 'exportedAt stamped from injected clock');
eq(env.app, 'StarNet', 'app name stamped');
eq(env.sections.budget.perRun, 2, 'budget section carried');
eq(env.sections.fallback.models.length, 2, 'fallback chain carried as {models}');
eq(env.sections.dossier.block, 'the commander block', 'dossier carried');
eq(env.sections.permissions.allow.length, 2, 'permission grants carried');

// roster carries metadata only — NO raw system prompt, just a hasSystem marker
eq(env.sections.roster[0].model, 'x/y', 'roster model carried');
eq(env.sections.roster[0].hasSystem, true, 'roster notes hasSystem without leaking the prompt');
ok(JSON.stringify(env).indexOf('SECRET PROMPT') < 0, 'the raw system prompt is NEVER exported');

// ---- SECURITY LAW: connector secrets are redacted, configured-marker kept ----
const c = env.sections.connectors[0];
eq(c.id, 'gh', 'connector id kept');
ok(!('token' in (c.headers || {})), 'no token key leaks into exported headers');
eq(c.headers.Authorization, undefined, 'Authorization header value redacted');
eq(c.headers['X-Foo'], 'ok', 'a non-secret header value is preserved');
eq(c.configured, true, 'connector marked configured (so import can prompt re-entry)');
ok(c.redactedFields.indexOf('Authorization') >= 0, 'Authorization listed as a redacted field');
ok(c.redactedFields.indexOf('url:auth') >= 0, 'the token-bearing url is flagged url:auth');
eq(c.url, 'https://mcp.example/api', 'the url is stripped of its token query');
ok(JSON.stringify(env).indexOf('SEKRET') < 0 && JSON.stringify(env).indexOf('Bearer abc') < 0, 'NO connector secret appears anywhere in the envelope');

// ---- round-trip: parseImport recovers the non-secret config ----
const p = C.parseImport(env);
ok(p.ok, 'parseImport accepts the envelope we built');
eq(p.schema, 1, 'parsed schema is 1');
eq(p.sections.budget.perRun, 2, 'budget round-trips');
eq(p.sections.fallback.models.length, 2, 'fallback round-trips');
eq(p.sections.roster[0].model, 'x/y', 'roster metadata round-trips');
eq(p.sections.permissions.allow.length, 2, 'permissions round-trip');
ok(Array.isArray(p.secretsNeeded) && p.secretsNeeded.length === 1, 'the redacted connector surfaces exactly one re-enter-your-key prompt');
eq(p.secretsNeeded[0].id, 'gh', 'the secretsNeeded prompt names the connector');

// ---- validation: budget clamps out junk; fallback is cleaned + capped at 8 ----
const badBudget = C.parseImport({ starnetExport: 1, sections: { budget: { perRun: -5, perDay: 'oops', global: 10 } } });
eq(badBudget.sections.budget.perRun, undefined, 'a negative budget value is dropped');
eq(badBudget.sections.budget.perDay, undefined, 'a non-numeric budget value is dropped');
eq(badBudget.sections.budget.global, 10, 'a valid budget value survives');

const bigChain = C.parseImport({ starnetExport: 1, sections: { fallback: { models: Array.from({ length: 20 }, (_, i) => 'm/' + i) } } });
eq(bigChain.sections.fallback.models.length, 8, 'the fallback chain is capped at 8 on import');

// ---- forward-tolerance: unknown sections dropped (noted), newer schema accepted with a note ----
const fwd = C.parseImport({ starnetExport: 99, sections: { budget: { perRun: 1 }, futureThing: { x: 1 } } });
ok(fwd.ok, 'a newer-schema file still imports what we understand');
ok(fwd.notes.some(x => /newer StarNet/.test(x)), 'a newer schema is noted');
ok(fwd.notes.some(x => /futureThing/.test(x)), 'an unknown section is noted, not fatal');
eq(fwd.sections.futureThing, undefined, 'the unknown section is not applied');
eq(fwd.sections.budget.perRun, 1, 'the known section still applies alongside the unknown one');

// ---- fail-soft + hard guards ----
eq(C.parseImport({}).ok, false, 'a file with no version marker is rejected');
eq(C.parseImport(null).ok, false, 'null is rejected, not thrown');
eq(C.parseImport({ starnetExport: 1, sections: { budget: 'not an object' } }).ok, true, 'a malformed section does not fail the whole import');

console.log('configexport.test.js OK —', n, 'assertions');
