/* sidecar/credits-link.js — device pairing client for StarNet Cloud + the durable link-config store.

   Slice 2 of the subscriptions plan: turn a static CREDITS_ACCOUNT env var into a real, user-driven LINK
   STATION flow. This module owns two things and NOTHING else (no billing, no admission — that stays in
   credits.js / billing.js):

     1. The cloud device-linking HTTP dance (mirrors the codex device-code shape):
          POST {cloud}/v1/link/start { deviceName } -> { code:"STAR-XXXX", verifyUrl, pollSecret, expiresAt }
          POST {cloud}/v1/link/poll  { code, pollSecret } ->
              { status:'pending' } | { status:'confirmed', deviceToken, accountId } | { status:'expired'|'consumed' }
        The `pollSecret` is a SECRET: it is held in memory keyed by code and NEVER returned to the frontend
        or persisted. Only the sidecar polls the cloud with it.

     2. Durable link config at WORKSPACES/.secrets/credits.json (same posture as spotify.json — atomic
        tmp+rename, 0600) so a linked station survives a sidecar restart. The record is
          { url, deviceToken, accountId, linkedAt }
        and is read back at boot (loadSavedSync) to construct the live credits adapter. deviceToken is a
        re-issuable bearer credential (relinking mints a new one), so unlink deleting the file is safe
        under the secret-durability law.

   HONESTY LAW: when STARNET_CLOUD_URL is unset, configured() is false — start() refuses, the /api/credits/*
   link routes 404, and the STORE shows no LINK card. Pure/injected IO (fetch, fs, fsp, path, clock) so the
   whole flow is unit-testable offline (see test/credits-link.test.js). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).creditsLink = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function str(v) { return v == null ? '' : String(v); }
  function trimSlash(u) { return str(u).replace(/\/+$/, ''); }

  /* deps: {
       cloudUrl,                 // STARNET_CLOUD_URL (empty => inert, everything 404s)
       fetch, fsp, fs, pathMod,  // injected IO
       dir,                      // WORKSPACES/.secrets — where credits.json lives
       now                       // () => ms wall clock
     } */
  function makeCreditsLink(deps) {
    deps = deps || {};
    const cloudUrl = trimSlash(deps.cloudUrl);
    const doFetch = deps.fetch || (typeof fetch === 'function' ? fetch : null);
    const fsp = deps.fsp;
    const fs = deps.fs;
    const P = deps.pathMod;
    const DIR = deps.dir;
    const now = deps.now || (() => 0);   // host (index.js) injects the wall clock; default is inert (determinism law)
    const file = (P && DIR) ? P.join(DIR, 'credits.json') : '';

    // code -> { pollSecret, at }. The pollSecret is the secret half of the pairing; it never leaves the sidecar.
    const pending = new Map();

    function configured() { return !!cloudUrl; }

    async function postJson(pathName, payload) {
      if (!doFetch) throw new Error('no fetch');
      const r = await doFetch(cloudUrl + pathName, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
      const body = (r && typeof r.json === 'function') ? await r.json().catch(() => ({})) : {};
      if (!r || !r.ok) { const e = new Error('link POST ' + pathName + ' failed'); e.status = r && r.status; e.body = body; throw e; }
      return body || {};
    }

    // Ask the cloud for a fresh pairing code. Stashes the pollSecret in memory; returns only the public bits.
    async function start(deviceName) {
      if (!configured()) return { ok: false, error: 'not_configured' };
      const j = await postJson('/v1/link/start', { deviceName: str(deviceName) || 'StarNet Station' });
      const code = str(j.code);
      if (!code) return { ok: false, error: 'no_code' };
      pending.set(code, { pollSecret: str(j.pollSecret), at: now() });
      for (const [k, v] of pending) { if (!v || (now() - v.at) > 15 * 60 * 1000) pending.delete(k); }   // prune stale
      return { ok: true, code, verifyUrl: str(j.verifyUrl), expiresAt: j.expiresAt || 0 };
    }

    // Poll the cloud ONCE for this code. On 'confirmed' persists the device token and returns the record so the
    // host can rebuild the live credits adapter. 'unknown' = we hold no pollSecret for this code (never started
    // here, or already resolved) — the frontend should restart the flow.
    async function poll(code) {
      if (!configured()) return { status: 'not_configured' };
      code = str(code);
      const p = pending.get(code);
      if (!p) return { status: 'unknown' };
      const j = await postJson('/v1/link/poll', { code, pollSecret: p.pollSecret });
      const status = str(j.status) || 'pending';
      if (status === 'confirmed' && j.deviceToken) {
        const rec = { url: cloudUrl, deviceToken: str(j.deviceToken), accountId: str(j.accountId), linkedAt: now() };
        await persist(rec);
        pending.delete(code);
        return { status: 'confirmed', accountId: rec.accountId, record: rec };
      }
      if (status === 'expired' || status === 'consumed') pending.delete(code);
      return { status };
    }

    async function persist(rec) {
      if (!file) throw new Error('no dir');
      await fsp.mkdir(DIR, { recursive: true });
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(rec), { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(tmp, file);
      try { await fsp.chmod(file, 0o600); } catch (_) {}   // best-effort tighten (no-op on Windows)
      return rec;
    }

    // Synchronous read for boot-time credits construction (the credits adapter must be built at require-time,
    // before the event loop turns). Returns null when there is no valid linked record.
    function loadSavedSync() {
      if (!file || !fs) return null;
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const j = JSON.parse(raw);
        if (j && j.url && j.deviceToken) {
          return { url: trimSlash(j.url), deviceToken: str(j.deviceToken), accountId: str(j.accountId), linkedAt: j.linkedAt || 0 };
        }
      } catch (_) {}
      return null;
    }

    function hasSaved() { return !!loadSavedSync(); }

    // Unlink: delete the persisted device token. Safe under the secret-durability law — the token is re-issuable
    // (relinking mints a new one). ENOENT is a success (already inert).
    async function clearSaved() {
      if (!file) return { ok: true, removed: false };
      try { await fsp.unlink(file); return { ok: true, removed: true }; }
      catch (e) { if (e && e.code === 'ENOENT') return { ok: true, removed: false }; return { ok: false, error: (e && e.message) || String(e) }; }
    }

    return { configured, cloudUrl: () => cloudUrl, start, poll, persist, loadSavedSync, hasSaved, clearSaved, _internals: { file, pending } };
  }

  return { makeCreditsLink };
});
