'use strict';
// permissionsstore.test.js — the thin store behind the Permissions Panel (autonomy B1). Drives BOTH halves of a
// level (posture preset via AutonomyStore + the curated grant reconcile via the api), caches the server's grant
// snapshot, derives the current level, and locks down on new-hero reset. Injected fakes; nothing touches the DOM.
const assert = require('assert');
const fs = require('fs'); const path = require('path');
global.Permissions = require('../frontend/app/permissions.js');
const { PermissionsStore } = require('../frontend/app/permissionsstore.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// a fake sidecar: an in-memory grant Set + the token-gated api the store calls. Records every call.
function harness(initialGrants, startPosture) {
  const calls = { grant: [], revoke: [], load: 0 };
  const server = new Set(initialGrants || []);
  let posture = startPosture || { initiative: 'wait', actsUnattended: false };
  const presetMap = {
    wait:    { initiative: 'wait',    actsUnattended: false },
    suggest: { initiative: 'propose', actsUnattended: false },
    build:   { initiative: 'leash',   actsUnattended: true },
    free:    { initiative: 'free',    actsUnattended: true }
  };
  const api = {
    load: async () => { calls.load++; return { grants: Array.from(server).sort(), grantable: ['cabinet:write'] }; },
    grant: async (k) => { calls.grant.push(k); if (k === 'cabinet:write') server.add(k); return { ok: true, grants: Array.from(server).sort() }; },
    revoke: async (k) => { calls.revoke.push(k); server.delete(k); return { ok: true, grants: Array.from(server).sort() }; }
  };
  return { calls, server, api, applyPreset: (id) => { posture = presetMap[id] || posture; }, getPosture: () => posture };
}
const wire = (h) => PermissionsStore.init({ api: h.api, getPosture: h.getPosture, applyPreset: h.applyPreset, load: false });

(async () => {
  // --- load populates the cache + derives the level ---
  {
    const h = harness([]); wire(h);
    const snap = await PermissionsStore.refresh();
    ok(h.calls.load === 1, 'refresh hit the api');
    eq(snap.grants, [], 'no grants initially');
    eq(snap.grantable, ['cabinet:write'], 'grantable surfaced from the server');
    eq(snap.level, 'never', 'wait posture + no grants → never');
  }

  // --- setLevel('full') applies the free preset AND grants the write capability ---
  {
    const h = harness([]); wire(h);
    await PermissionsStore.refresh();
    const snap = await PermissionsStore.setLevel('full');
    eq(h.getPosture().initiative, 'free', 'full applied the free posture preset');
    ok(h.calls.grant.includes('cabinet:write'), 'full granted the local-write capability');
    ok(snap.grants.includes('cabinet:write'), 'cache reflects the grant');
    eq(snap.level, 'full', 'now fully autonomous');
  }

  // --- setLevel('never') from full revokes the write grant AND applies the wait preset ---
  {
    const h = harness(['cabinet:write'], { initiative: 'free', actsUnattended: true }); wire(h);
    await PermissionsStore.refresh();
    eq(PermissionsStore.snapshot().level, 'full', 'starts at full');
    const snap = await PermissionsStore.setLevel('never');
    eq(h.getPosture().initiative, 'wait', 'never applied the wait preset');
    ok(h.calls.revoke.includes('cabinet:write'), 'never revoked the write grant');
    eq(snap.level, 'never', 'back to never');
  }

  // --- a level change NEVER auto-touches a non-curated standing grant ---
  {
    const h = harness(['cabinet:write', 'net:send'], { initiative: 'free', actsUnattended: true }); wire(h);
    await PermissionsStore.refresh();
    await PermissionsStore.setLevel('draft');
    ok(h.calls.revoke.includes('cabinet:write'), 'draft revoked the curated write grant');
    ok(!h.calls.revoke.includes('net:send'), 'a non-curated standing grant is NEVER auto-revoked by a level change');
    ok(h.server.has('net:send'), 'net:send survived the level change');
  }

  // --- single grant / revoke ---
  {
    const h = harness([]); wire(h);
    await PermissionsStore.refresh();
    await PermissionsStore.grant('cabinet:write');
    ok(PermissionsStore._grants().includes('cabinet:write'), 'grant updates the cache');
    await PermissionsStore.revoke('cabinet:write');
    ok(!PermissionsStore._grants().includes('cabinet:write'), 'revoke updates the cache');
  }

  // --- new-hero reset locks down: clears the cache + best-effort revokes the autonomous write grant ---
  {
    const h = harness(['cabinet:write'], { initiative: 'free', actsUnattended: true }); wire(h);
    await PermissionsStore.refresh();
    const p = PermissionsStore.reset();
    eq(PermissionsStore._grants(), [], 'reset cleared the cache synchronously');
    ok(h.calls.revoke.includes('cabinet:write'), 'reset revoked the write grant (a fresh hero starts locked)');
    ok(p && typeof p.then === 'function', 'reset returns an awaitable promise so onWake can await the lockdown (no inherit-window)');
    await p;
  }

  // --- read-only citizen: never emits, no bus dependency ---
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'permissionsstore.js'), 'utf8');
    ok(!/\.emit\s*\(/.test(src), 'permissionsstore never emits on the bus (read-only citizen)');
    ok(!/U\.bus\.(on|once|emit)\s*\(|require\(['"][^'"]*events/.test(src), 'permissionsstore makes no real U.bus calls / events require (read-only citizen)');
  }

  console.log('permissionsstore.test.js OK —', n, 'assertions');
})().catch(e => { console.error(e); process.exit(1); });
