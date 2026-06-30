/* STARNET — permissionsstore.js : the thin live wiring around the pure Permissions Panel engine (permissions.js).
   Autonomy Stage B / B1 — the OS-style trust panel where the Commander dials the station never→fully-autonomous
   and sees / revokes every standing capability grant.

   It is the EDGE the pure engine isn't: it owns the api round-trips (the standing grants live SERVER-side in the
   sidecar's permissions.allow.json, reached over the token-gated /api/permissions routes) and the hand-off to
   AutonomyStore for the posture half of a level. Mirrors autonomystore / autojobstore discipline:
   - READ-ONLY citizen of the app — takes NO U.bus dependency and NEVER emits (lint-emits stays green).
   - NO own localStorage key: grants persist server-side; the posture persists in AutonomyStore's key. This store
     just caches the last-fetched grants in memory and derives the level from (live posture + grants).
   - node-exportable for its test (inject a fake api + posture; nothing touches the DOM).

   A "level" composes BOTH systems coherently (see permissions.js): setLevel() applies the posture PRESET via
   AutonomyStore AND reconciles the curated standing GRANTS (grant/revoke only the cabinet:write diff — a non-
   curated grant the user blessed elsewhere is never auto-touched). */
'use strict';
const PermissionsStore = (() => {
  let deps = {};
  let grants = [];        // cached standing grants (dangerKey strings) — last seen from the server
  let grantable = [];     // cached curated catalog keys the server will accept
  let loaded = false;     // a successful load/refresh has happened at least once

  const ready = () => typeof Permissions !== 'undefined';
  const posture = () => { try { return (deps.getPosture ? deps.getPosture() : null) || {}; } catch (_) { return {}; } };
  const norm = (arr) => ready() ? Permissions.normalizeGrants(arr) : (Array.isArray(arr) ? arr.slice() : []);

  // pull the authoritative grant snapshot from the sidecar (token-gated). Failures leave the cache as-is.
  async function refresh() {
    if (deps.api && typeof deps.api.load === 'function') {
      try {
        const r = await deps.api.load();
        if (r && Array.isArray(r.grants)) grants = norm(r.grants);
        if (r && Array.isArray(r.grantable)) grantable = r.grantable.slice();
        loaded = true;
      } catch (_) {}
    }
    return snapshot();
  }

  // best-effort derive the CURRENT level from live posture + standing grants.
  function currentLevel() { return ready() ? Permissions.levelFromState(posture(), grants) : 'never'; }

  function snapshot() {
    return {
      grants: grants.slice(),
      grantable: grantable.length ? grantable.slice() : (ready() ? Permissions.grantableKeys() : []),
      level: currentLevel(),
      loaded
    };
  }

  // grant / revoke ONE capability through the api; refresh the cache from the authoritative response.
  async function grant(key) {
    if (deps.api && typeof deps.api.grant === 'function') {
      try { const r = await deps.api.grant(key); if (r && Array.isArray(r.grants)) grants = norm(r.grants); } catch (_) {}
    }
    return snapshot();
  }
  async function revoke(key) {
    if (deps.api && typeof deps.api.revoke === 'function') {
      try { const r = await deps.api.revoke(key); if (r && Array.isArray(r.grants)) grants = norm(r.grants); } catch (_) {}
    }
    return snapshot();
  }

  // set the whole spectrum level: (1) the posture preset via AutonomyStore, (2) reconcile the curated grants.
  // Only the curated diff is touched — a non-curated standing grant is never auto-revoked by a level change.
  async function setLevel(level) {
    if (!ready()) return snapshot();
    const lv = Permissions.normalizeLevel(level);
    try { if (typeof deps.applyPreset === 'function') deps.applyPreset(Permissions.levelPlan(lv).preset); } catch (_) {}
    const diff = Permissions.reconcileToLevel(lv, grants);
    for (const k of diff.toGrant) await grant(k);
    for (const k of diff.toRevoke) await revoke(k);
    return snapshot();
  }

  // opts: { api:{ load(), grant(key), revoke(key) }, getPosture(), applyPreset(id), load:bool }
  function init(opts) {
    deps = opts || {};
    grants = []; grantable = []; loaded = false;
    if (deps.load !== false) { try { refresh(); } catch (_) {} }
  }

  // a brand-new hero starts LOCKED DOWN: drop the cache and revoke the curated autonomous grants, so a fresh station
  // can never inherit a previous one's standing permission to write files unattended (re-grant via the panel).
  // RETURNS A PROMISE so onWake can AWAIT the lockdown before the new agent enters the game — closing the window
  // where a fresh Commander could briefly inherit the prior write grant (the posture reset to 'wait' is the backstop;
  // this makes the claimed lockdown authoritative, not fire-and-forget). Sync-safe + node-safe (resolves immediately
  // with no api wired); the revoke calls are still INITIATED synchronously. Non-curated grants are left to the user.
  function reset() {
    const keys = ready() ? Permissions.grantableKeys() : ['cabinet:write'];
    grants = []; grantable = []; loaded = false;
    if (!deps.api || typeof deps.api.revoke !== 'function') return Promise.resolve();
    const jobs = [];
    for (const k of keys) { try { jobs.push(Promise.resolve(deps.api.revoke(k)).catch(() => {})); } catch (_) {} }
    return Promise.all(jobs);
  }

  return { init, refresh, snapshot, currentLevel, setLevel, grant, revoke, reset, _grants: () => grants.slice() };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { PermissionsStore };
