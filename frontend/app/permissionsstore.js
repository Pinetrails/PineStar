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
  let meta = {};          // cached provenance { dangerKey: { grantedAt } } — additive, may be {} for legacy stores
  /* The master FULL BYPASS switch (2026-08-05) — server truth from /api/permissions (additive fields).
     envFullAccess = the boot SKYNET_FULL_ACCESS env forces bypass regardless of the switch; the panel
     renders the toggle pinned + explained rather than a switch that appears to do nothing. */
  let masterBypass = false;
  let envFullAccess = false;
  let loaded = false;     // a successful load/refresh has happened at least once
  let error = '';         // last authority/mutation failure; never replace confirmed grants with guessed emptiness

  const ready = () => typeof Permissions !== 'undefined';
  const posture = () => { try { return (deps.getPosture ? deps.getPosture() : null) || {}; } catch (_) { return {}; } };
  const norm = (arr) => ready() ? Permissions.normalizeGrants(arr) : (Array.isArray(arr) ? arr.slice() : []);
  const failure = (r, fallback) => String((r && r.reason) || fallback || 'permissions service unavailable');
  // keep only well-formed provenance rows ({ grantedAt:number|null }) so a malformed payload can't poison the cache.
  const normMeta = (m) => {
    const out = {};
    if (m && typeof m === 'object') for (const k of Object.keys(m)) {
      const g = m[k] && typeof m[k] === 'object' ? m[k].grantedAt : null;
      out[k] = { grantedAt: (typeof g === 'number' && isFinite(g)) ? g : null };
    }
    return out;
  };

  // pull the authoritative grant snapshot from the sidecar (token-gated). Failures leave the cache as-is.
  async function refresh() {
    if (deps.api && typeof deps.api.load === 'function') {
      try {
        const r = await deps.api.load();
        if (!r || r.ok === false || !Array.isArray(r.grants)) {
          error = failure(r, 'permissions service unavailable');
          return snapshot();
        }
        if (r && Array.isArray(r.grants)) grants = norm(r.grants);
        if (r && Array.isArray(r.grantable)) grantable = r.grantable.slice();
        meta = normMeta(r && r.meta);   // additive: absent → {}, no provenance shown (legacy store)
        masterBypass = !!(r && r.masterBypass);
        envFullAccess = !!(r && r.envFullAccess);
        loaded = true;
        error = '';
      } catch (e) { error = String((e && e.message) || 'permissions service unavailable'); }
    }
    return snapshot();
  }

  // best-effort derive the CURRENT level from live posture + standing grants.
  function currentLevel() { return ready() ? Permissions.levelFromState(posture(), grants) : 'never'; }

  function snapshot() {
    return {
      grants: grants.slice(),
      grantable: grantable.length ? grantable.slice() : (ready() ? Permissions.grantableKeys() : []),
      meta: Object.assign({}, meta),   // provenance { key: { grantedAt } } — additive; {} when the store is legacy
      masterBypass,
      envFullAccess,
      level: currentLevel(),
      loaded,
      error
    };
  }

  // flip the master FULL BYPASS switch through the token-gated route. Server truth only: the cached flag
  // updates from the response, never optimistically — a torn persist reports ok:false with state unchanged.
  async function setBypass(on) {
    if (deps.api && typeof deps.api.bypass === 'function') {
      try {
        const r = await deps.api.bypass(on === true);
        if (!r || r.ok === false) { error = failure(r, 'could not flip the bypass switch'); return snapshot(); }
        masterBypass = !!r.masterBypass;
        if (typeof r.envFullAccess === 'boolean') envFullAccess = r.envFullAccess;
        error = '';
      } catch (e) { error = String((e && e.message) || 'could not flip the bypass switch'); }
    }
    return snapshot();
  }

  // grant / revoke ONE capability through the api; refresh the cache from the authoritative response. The grant
  // response may carry no meta (the sidecar snapshot does), so we re-read provenance on the next refresh; a grant
  // that DOES return meta updates it here so the "granted just now" line shows without a round-trip.
  async function grant(key) {
    if (deps.api && typeof deps.api.grant === 'function') {
      try {
        const r = await deps.api.grant(key);
        if (!r || r.ok === false) { error = failure(r, 'could not confirm permission grant'); return snapshot(); }
        if (Array.isArray(r.grants)) grants = norm(r.grants);
        if (r.meta) meta = normMeta(r.meta);
        error = '';
      } catch (e) { error = String((e && e.message) || 'could not confirm permission grant'); }
    }
    return snapshot();
  }
  async function revoke(key) {
    if (deps.api && typeof deps.api.revoke === 'function') {
      try {
        const r = await deps.api.revoke(key);
        if (!r || r.ok === false) { error = failure(r, 'could not confirm permission revoke'); return snapshot(); }
        if (Array.isArray(r.grants)) grants = norm(r.grants);
        if (r.meta) meta = normMeta(r.meta); else { const m = Object.assign({}, meta); delete m[key]; meta = m; }
        error = '';
      } catch (e) { error = String((e && e.message) || 'could not confirm permission revoke'); }
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
    grants = []; grantable = []; meta = {}; masterBypass = false; envFullAccess = false; loaded = false; error = '';
    if (deps.load !== false) { try { refresh(); } catch (_) {} }
  }

  // a brand-new hero starts LOCKED DOWN: revoke the curated autonomous grants before the fresh station commits.
  // A revoke failure must preserve the last confirmed cache and REJECT — clearing first made the UI claim lockdown
  // while the server still held cabinet:write. Non-curated grants remain visible and untouched.
  async function reset() {
    const keys = ready() ? Permissions.grantableKeys() : ['cabinet:write'];
    if (!deps.api || typeof deps.api.revoke !== 'function') {
      grants = []; grantable = []; meta = {}; loaded = false; error = '';
      return snapshot();
    }
    error = '';
    for (const k of keys) {
      const snap = await revoke(k);
      if (snap.error) throw new Error('could not lock down standing permissions — ' + snap.error);
    }
    // the master FULL BYPASS switch outranks every row above — a "lockdown" that left it ON would be the
    // same lie as leaving any broader authority standing. Same fail-closed contract: a refused flip REJECTS.
    if (masterBypass) {
      const snap = await setBypass(false);
      if (snap.error) throw new Error('could not lock down standing permissions — ' + snap.error);
    }
    return snapshot();
  }

  return { init, refresh, snapshot, currentLevel, setLevel, grant, revoke, setBypass, reset, _grants: () => grants.slice() };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { PermissionsStore };
