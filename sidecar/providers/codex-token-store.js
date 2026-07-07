/* sidecar/providers/codex-token-store.js - helper for finding persisted Codex OAuth tokens across
   workspace-root migrations. Pure path/load/save orchestration; ambient fs/env are injected by index.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.codexTokenStore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function validCodexTokens(raw) {
    return !!(raw && typeof raw === 'object'
      && typeof raw.access_token === 'string'
      && raw.access_token.trim());
  }

  function pathKey(pathMod, file) {
    try { return pathMod.resolve(String(file || '')).toLowerCase(); }
    catch (_) { return String(file || '').toLowerCase(); }
  }

  function candidateCodexTokenFiles(opts) {
    opts = opts || {};
    const pathMod = opts.pathMod || require('node:path');
    const env = opts.env || {};
    const files = [];
    const seen = new Set();

    function addFile(file) {
      if (!file) return;
      const key = pathKey(pathMod, file);
      if (!key || seen.has(key)) return;
      seen.add(key);
      files.push(file);
    }
    function addRoot(root) {
      if (!root) return;
      addFile(pathMod.join(String(root), 'codex', 'tokens.json'));
    }

    addRoot(opts.currentWorkspaces);
    if (typeof opts.defaultWorkspaces === 'function') {
      try { addRoot(opts.defaultWorkspaces()); } catch (_) {}
    }
    for (const root of (Array.isArray(opts.legacyWorkspaces) ? opts.legacyWorkspaces : [])) addRoot(root);

    const appBase = env.LOCALAPPDATA || env.APPDATA || env.XDG_DATA_HOME || '';
    if (appBase) {
      addRoot(pathMod.join(appBase, 'StarNet', 'workspaces'));
      addRoot(pathMod.join(appBase, 'Skynet', 'workspaces'));
      addRoot(pathMod.join(appBase, 'ai.skynet.harness', 'workspaces'));
    }

    if (opts.sidecarDir) {
      addRoot(pathMod.join(opts.sidecarDir, 'workspaces'));
      addRoot(pathMod.join(pathMod.dirname(opts.sidecarDir), 'workspaces'));
    }

    return files;
  }

  function loadCodexTokensWithMigration(opts) {
    opts = opts || {};
    const currentFile = opts.currentFile;
    const load = opts.load;
    const save = opts.save;
    if (typeof load !== 'function') throw new Error('loadCodexTokensWithMigration requires opts.load');

    const current = load(currentFile, 'codex');
    if (validCodexTokens(current)) return current;

    const pathMod = opts.pathMod || require('node:path');
    const currentKey = pathKey(pathMod, currentFile);
    for (const file of (Array.isArray(opts.candidateFiles) ? opts.candidateFiles : [])) {
      if (!file || pathKey(pathMod, file) === currentKey) continue;
      const raw = load(file, 'codex-legacy');
      if (!validCodexTokens(raw)) continue;
      if (typeof save === 'function') save(currentFile, raw);
      if (typeof opts.onMigrate === 'function') opts.onMigrate(file, currentFile);
      return raw;
    }
    return null;
  }

  // Persist Codex OAuth tokens with READ-BACK PROOF, then RETRY ONCE. Motivation: after codexAuth.refreshTokens()
  // the provider may ROTATE the refresh_token and invalidate the old one; if the write to disk silently fails, a
  // sidecar restart reloads the OLD (now-dead) refresh_token -> forced re-sign-in. So a swallowed write error is a
  // real credential-durability hazard. This helper writes, reads the file BACK, and confirms the refresh_token on
  // disk matches what we intended to store. On mismatch/throw it retries once; if it still can't prove the token
  // reached disk, it returns { ok:false } so the caller can surface an HONEST persist-failure signal AND keep the
  // rotated tokens in memory (this session stays live; the truth-telemetry law forbids pretending it's durable).
  //
  // Pure/injectable: caller passes save(obj) (durable write) + load() (resilient read-back). No ambient I/O here.
  //   opts.save(obj)  -> void (may throw)   persist the token object
  //   opts.load()     -> obj|undefined      read the token object back from disk (resilient loader)
  //   opts.tokens                            the token object we are trying to persist (must carry refresh_token)
  // Returns { ok, attempts, verified, error } — ok true ONLY when the read-back proves the intended refresh_token
  // (and access_token) are on disk. When the token being saved has no refresh_token, access_token alone is proof.
  function persistCodexTokensVerified(opts) {
    opts = opts || {};
    const tokens = opts.tokens || {};
    const save = opts.save, load = opts.load;
    if (typeof save !== 'function' || typeof load !== 'function') {
      return { ok: false, attempts: 0, verified: false, error: 'persistCodexTokensVerified requires save+load' };
    }
    const wantRefresh = String(tokens.refresh_token || '');
    const wantAccess = String(tokens.access_token || '');
    // proof = the durable copy carries the SAME access_token AND (when we have one) the SAME refresh_token. Matching
    // the rotated refresh_token is the whole point: an old refresh_token lingering on disk is the exact bug.
    function onDisk() {
      let raw; try { raw = load(); } catch (_) { return false; }
      if (!raw || typeof raw !== 'object') return false;
      if (wantAccess && String(raw.access_token || '') !== wantAccess) return false;
      if (wantRefresh && String(raw.refresh_token || '') !== wantRefresh) return false;
      return true;
    }
    let lastErr = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { save(tokens); } catch (e) { lastErr = (e && e.message) || String(e); }
      if (onDisk()) return { ok: true, attempts: attempt, verified: true, error: '' };
      if (!lastErr) lastErr = 'read-back did not find the intended refresh_token on disk';
    }
    return { ok: false, attempts: 2, verified: false, error: lastErr };
  }

  return { validCodexTokens, candidateCodexTokenFiles, loadCodexTokensWithMigration, persistCodexTokensVerified };
});
