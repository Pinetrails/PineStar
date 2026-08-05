/* sidecar/workspace-lineage.js — bounded evidence that this machine had StarNet state before this boot. */
'use strict';

const INFRA = /^(?:\.starnet-workspace-owner\.json|\.schema-version\.json(?:\.bak)?|\.migrated|cron\.lock|proc-ledger\.json|liveprices\.cache\.json)$/i;

function meaningfulEntries(fs, path, root) {
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
    return fs.readdirSync(root).filter(name => {
      if (INFRA.test(name)) return false;
      if (/\.tmp(?:\.|$)/i.test(name)) return false;
      if (name === '.browser-profile') return false;
      return true;
    }).slice(0, 40).map(name => ({ name, path: path.join(root, name) }));
  } catch (_) { return []; }
}

function inspectWorkspaceLineage(deps) {
  const d = deps || {}, fs = d.fs, path = d.path;
  const current = path.resolve(String(d.workspaceRoot || ''));
  const same = (a, b) => {
    const x = path.resolve(String(a)), y = path.resolve(String(b));
    return d.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
  };
  const evidence = [];
  const currentEntries = meaningfulEntries(fs, path, current);
  if (currentEntries.length) evidence.push({ kind: 'current-workspace', root: current, count: currentEntries.length, examples: currentEntries.map(x => x.name).slice(0, 8) });
  if (fs.existsSync(path.join(current, '.migration-pending'))) {
    evidence.push({ kind: 'migration-pending', root: current, count: 1, examples: ['.migration-pending'] });
  }
  for (const root of Array.isArray(d.candidateRoots) ? d.candidateRoots : []) {
    if (!root || same(root, current)) continue;
    const entries = meaningfulEntries(fs, path, root);
    if (entries.length) evidence.push({ kind: 'legacy-workspace', root: path.resolve(root), count: entries.length, examples: entries.map(x => x.name).slice(0, 8) });
  }
  const snapshotsRoot = path.resolve(String(d.snapshotsRoot || path.join(path.dirname(current), 'update-snapshots')));
  try {
    const snapshots = fs.existsSync(snapshotsRoot)
      ? fs.readdirSync(snapshotsRoot).filter(name => /\.starnet-backup\.json$/i.test(name)).slice(0, 12) : [];
    if (snapshots.length) evidence.push({ kind: 'update-snapshot', root: snapshotsRoot, count: snapshots.length, examples: snapshots });
  } catch (_) {}
  return {
    version: 1,
    priorInstallEvidence: evidence.length > 0,
    onboardingAllowed: evidence.length === 0,
    currentWorkspace: current,
    evidence: evidence
  };
}

module.exports = { inspectWorkspaceLineage: inspectWorkspaceLineage, _internals: { meaningfulEntries: meaningfulEntries } };
