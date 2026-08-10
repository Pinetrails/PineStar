/* sidecar/workspace-lineage.js — bounded evidence that this machine had StarNet state before this boot. */
'use strict';

// The desktop migration transaction seals even an empty first-run generation with a receipt. The receipt is
// bookkeeping, not user state; any files it actually migrated are scanned independently below.
const INFRA = /^(?:\.starnet-workspace-owner\.json|\.schema-version\.json(?:\.bak)?|\.migrated|\.migration-receipt\.json|cron\.lock|proc-ledger\.json|liveprices\.cache\.json)$/i;
// Positive evidence only. The former "anything not on the infrastructure denylist" rule made every newly
// introduced cache/receipt a fake prior station. This covers the harness-owned durable authorities without
// treating an arbitrary future `*.cache.json` as proof that a Commander already created a station.
const STATE_EVIDENCE = /^(?:agent\.save\.json(?:\.bak|\.corrupt-\d+)?|agent\.roster\.json(?:\.bak)?|(?:transcript|ledger|runs|growth-ratings|skills|skillprefs|autonomy\.ledger|deliverables\.library)\.jsonl|(?:budget|fallback|station\.widgets|memory\.config|study\.state|projects|personalization|recommendations|task-briefs|threads|execution-settings|terminal-sessions|subagents|routing\.plan|toolsets|usercommands)\.json(?:\.bak)?|(?:skills-allowed|skill-registries|skill-exchange-metrics|permissions\.(?:allow|bypass)|hooks(?:-allowed)?|plugins-allowed|cron\.(?:jobs|armed|halt)|loops(?:\.halt)?|nightshift\.(?:state|drafts|learn|acts)|nightfocus\.state|scout\.(?:interests|state))\.json(?:\.bak)?|_(?:station|commander)\.[a-z0-9._-]+\.json(?:\.bak)?|[a-z0-9_-]+\.(?:notebook|todo|declined|minted|pending|workshop|deliverables)\.json(?:\.bak)?|.*\.starnet-(?:backup|recovery)\.json)$/i;

function meaningfulEntries(fs, path, root) {
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
    return fs.readdirSync(root).filter(name => {
      if (INFRA.test(name)) return false;
      if (/\.tmp(?:\.|$)/i.test(name)) return false;
      if (name === '.browser-profile') return false;
      return STATE_EVIDENCE.test(name);
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

module.exports = { inspectWorkspaceLineage: inspectWorkspaceLineage, _internals: { meaningfulEntries: meaningfulEntries, STATE_EVIDENCE: STATE_EVIDENCE } };
