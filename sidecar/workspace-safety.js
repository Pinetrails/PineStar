/* sidecar/workspace-safety.js — identify canonical user-data roots that DEV/QA must never mutate. */
'use strict';

function normalize(value, path, platform) {
  let out = path.resolve(String(value || ''));
  const root = path.parse(out).root;
  while (out.length > root.length && /[\\\/]$/.test(out)) out = out.slice(0, -1);
  return platform === 'win32' ? out.toLowerCase() : out;
}

function classifyWorkspace(root, deps) {
  const d = deps || {};
  const path = d.path;
  const env = d.env || {};
  const platform = String(d.platform || '');
  const homedir = typeof d.homedir === 'function' ? d.homedir : function () { return ''; };
  if (!path || typeof path.resolve !== 'function' || typeof path.join !== 'function') {
    throw new Error('workspace-safety: an injected path is required');
  }
  const bases = [env.LOCALAPPDATA, env.APPDATA, env.XDG_DATA_HOME];
  const home = String(homedir() || '');
  if (home) bases.push(path.join(home, '.local', 'share'));
  const candidates = [];
  for (const base of bases.filter(Boolean)) {
    for (const app of ['StarNet', 'Skynet', 'ai.skynet.harness']) {
      candidates.push(path.join(String(base), app, 'workspaces'));
    }
  }
  const actual = normalize(root, path, platform);
  for (const candidate of candidates) {
    if (actual === normalize(candidate, path, platform)) {
      return { protected: true, root: path.resolve(String(root)), matched: path.resolve(candidate) };
    }
  }
  return { protected: false, root: path.resolve(String(root)), matched: '' };
}

module.exports = { classifyWorkspace: classifyWorkspace };
