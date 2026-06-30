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

  return { validCodexTokens, candidateCodexTokenFiles, loadCodexTokensWithMigration };
});
