/* sidecar/workspace-safety.js — identify canonical user-data roots that DEV/QA must never mutate. */
'use strict';

function normalize(value, path, platform) {
  let out = path.resolve(String(value || ''));
  const root = path.parse(out).root;
  while (out.length > root.length && /[\\\/]$/.test(out)) out = out.slice(0, -1);
  return platform === 'win32' ? out.toLowerCase() : out;
}

function workspaceCandidates(deps) {
  const d = deps || {};
  const path = d.path;
  const env = d.env || {};
  const homedir = typeof d.homedir === 'function' ? d.homedir : function () { return ''; };
  if (!path || typeof path.join !== 'function') throw new Error('workspace-safety: an injected path is required');
  const bases = [env.LOCALAPPDATA, env.APPDATA, env.XDG_DATA_HOME];
  const home = String(homedir() || '');
  if (home) bases.push(path.join(home, '.local', 'share'));
  const out = [];
  for (const base of bases.filter(Boolean)) {
    for (const app of ['StarNet', 'Skynet', 'ai.skynet.harness']) out.push(path.join(String(base), app, 'workspaces'));
  }
  return out;
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
  const candidates = workspaceCandidates({ path: path, env: env, homedir: homedir });
  const actual = normalize(root, path, platform);
  for (const candidate of candidates) {
    if (actual === normalize(candidate, path, platform)) {
      return { protected: true, root: path.resolve(String(root)), matched: path.resolve(candidate) };
    }
  }
  return { protected: false, root: path.resolve(String(root)), matched: '' };
}

module.exports = { classifyWorkspace: classifyWorkspace, workspaceCandidates: workspaceCandidates };
