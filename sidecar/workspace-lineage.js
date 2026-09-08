/* sidecar/workspace-lineage.js — bounded evidence that this machine had StarNet state before this boot. */
'use strict';
const { note: failNote } = require('./failopen.js');

// The desktop migration transaction seals even an empty first-run generation with a receipt. The receipt is
// bookkeeping, not user state; any files it actually migrated are scanned independently below.
const INFRA = /^(?:\.starnet-workspace-owner\.json|\.schema-version\.json(?:\.bak)?|\.migrated|\.migration-receipt\.json|cron\.lock|proc-ledger\.json|liveprices\.cache\.json)$/i;
const BOOTSTRAP_CONTROL = /^(?:loops\.halt|nightshift\.state)\.json(?:\.bak)?$/i;

function exactKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\n') === keys.slice().sort().join('\n');
}

// E-STOP is available before a station exists. It durably stamps both subsystems even when there are no loops
// and Night Shift has never fired; the resilient writer may also retain the same envelope in .bak. Those exact
// zero-activity envelopes are safety scaffolding, not proof of user station data. Any malformed/extended value,
// spent beat, or prior beat timestamp remains ambiguous and therefore remains evidence.
function isBootstrapControlEntry(fs, file, name) {
  if (!BOOTSTRAP_CONTROL.test(name)) return false;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (/^loops\.halt\.json(?:\.bak)?$/i.test(name)) {
      return exactKeys(value, ['halted']) && typeof value.halted === 'boolean';
    }
    return exactKeys(value, ['v', 'day', 'beatsUsedToday', 'lastBeatAt', 'haltedAt'])
      && value.v === 1
      && Number.isInteger(value.day) && value.day >= 0
      && value.beatsUsedToday === 0
      && value.lastBeatAt === 0
      && Number.isInteger(value.haltedAt) && value.haltedAt >= 0;
  } catch (_) { return false; }
}

function meaningfulEntries(fs, path, root) {
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
    return fs.readdirSync(root).filter(name => {
      // Existing runtime services create top-level cache/journal directories before onboarding. Lineage has
      // historically classified top-level authority files; do not promote directory creation itself to a new
      // gate in this targeted fix. Known station evidence inside candidate roots is handled by recovery.
      try { if (fs.statSync(path.join(root, name)).isDirectory()) return false; } catch (_) { return true; }
      if (INFRA.test(name)) return false;
      if (name === '.fresh-start.json') return false;
      if (/\.tmp(?:\.|$)/i.test(name)) return false;
      if (name === '.browser-profile') return false;
      if (isBootstrapControlEntry(fs, path.join(root, name), name)) return false;
      return true;
    }).slice(0, 40).map(name => ({ name, path: path.join(root, name) }));
  } catch (_) { return []; }
}

// START FRESH marker: the Commander explicitly chose a new station over external prior-install evidence
// (legacy roots, update snapshots) that nothing could recover. It lists the acknowledged roots; evidence from
// those roots no longer gates. It NEVER suppresses current-workspace evidence — real station files in the live
// workspace are always honored. The marker itself is explicit infrastructure, never "prior state".
const FRESH_MARKER = '.fresh-start.json';
const QUARANTINE_DIR = 'workspace-quarantine';

function readFreshMarker(fs, path, current) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(current, FRESH_MARKER), 'utf8'));
    if (!v || v.version !== 1 || !Array.isArray(v.acknowledgedRoots)) return null;
    return v;
  } catch (_) { return null; }
}

function sameRoot(a, b, path, platform) {
  const x = path.resolve(String(a)), y = path.resolve(String(b));
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function inspectWorkspaceLineage(deps) {
  const d = deps || {}, fs = d.fs, path = d.path;
  const current = path.resolve(String(d.workspaceRoot || ''));
  const same = (a, b) => sameRoot(a, b, path, d.platform);
  const marker = readFreshMarker(fs, path, current);
  const acknowledged = root => !!marker && marker.acknowledgedRoots.some(r => same(r, root));
  const evidence = [];
  const currentEntries = meaningfulEntries(fs, path, current);
  if (currentEntries.length) evidence.push({ kind: 'current-workspace', root: current, count: currentEntries.length, examples: currentEntries.map(x => x.name).slice(0, 8) });
  if (fs.existsSync(path.join(current, '.migration-pending'))) {
    evidence.push({ kind: 'migration-pending', root: current, count: 1, examples: ['.migration-pending'] });
  }
  for (const root of Array.isArray(d.candidateRoots) ? d.candidateRoots : []) {
    if (!root || same(root, current)) continue;
    const entries = meaningfulEntries(fs, path, root);
    if (entries.length && !acknowledged(root)) evidence.push({ kind: 'legacy-workspace', root: path.resolve(root), count: entries.length, examples: entries.map(x => x.name).slice(0, 8) });
  }
  const snapshotsRoot = path.resolve(String(d.snapshotsRoot || path.join(path.dirname(current), 'update-snapshots')));
  try {
    const snapshots = fs.existsSync(snapshotsRoot)
      ? fs.readdirSync(snapshotsRoot).filter(name => /\.starnet-backup\.json$/i.test(name)).slice(0, 12) : [];
    if (snapshots.length && !acknowledged(snapshotsRoot)) evidence.push({ kind: 'update-snapshot', root: snapshotsRoot, count: snapshots.length, examples: snapshots });
  } catch (_) {}
  return {
    version: 1,
    priorInstallEvidence: evidence.length > 0,
    onboardingAllowed: evidence.length === 0,
    currentWorkspace: current,
    evidence: evidence
  };
}

/* START FRESH — the gate's third exit (2026-08-22: a first-run whose overseer never woke, then a manual reset,
   left a user on PRIOR STATION DATA FOUND with nothing recoverable and no way forward). Moves every
   current-workspace state file into a sibling quarantine folder (NEVER deletes — a wrong click is
   reversible by hand) and writes the marker acknowledging external evidence roots. Returns what moved.
   Fails closed: any rename error stops the pass with the files that already moved reported, nothing lost. */
function startFresh(deps) {
  const d = deps || {}, fs = d.fs, path = d.path;
  const now = typeof d.now === 'function' ? d.now : function () { return 0; };   // host injects the wall clock (determinism law)
  const current = path.resolve(String(d.workspaceRoot || ''));
  const lineage = inspectWorkspaceLineage(d);
  const stamp = new Date(now()).toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const quarantine = path.join(path.dirname(current), QUARANTINE_DIR, stamp);
  const moved = [];
  const entries = meaningfulEntries(fs, path, current);
  if (entries.length) {
    try { fs.mkdirSync(quarantine, { recursive: true }); }
    catch (e) { return { ok: false, error: 'could not create quarantine folder: ' + String(e && e.message || e), quarantine, moved }; }
    for (const entry of entries) {
      try { fs.renameSync(entry.path, path.join(quarantine, entry.name)); moved.push(entry.name); }
      catch (e) { return { ok: false, error: 'could not move ' + entry.name + ': ' + String(e && e.message || e), quarantine, moved }; }
    }
  }
  const acknowledgedRoots = lineage.evidence
    .filter(row => row.kind === 'legacy-workspace' || row.kind === 'update-snapshot')
    .map(row => row.root);
  const prior = readFreshMarker(fs, path, current);
  const marker = {
    version: 1,
    at: new Date(now()).toISOString(),
    acknowledgedRoots: Array.from(new Set((prior ? prior.acknowledgedRoots : []).concat(acknowledgedRoots))),
    quarantine: moved.length ? quarantine : null,
    moved
  };
  try {
    try { fs.mkdirSync(current, { recursive: true }); } catch (e) { failNote('lineage.startFresh.mkdir', e); }   // the write below reports the real failure
    fs.writeFileSync(path.join(current, FRESH_MARKER), JSON.stringify(marker, null, 2));
  } catch (e) { return { ok: false, error: 'could not write the fresh-start marker: ' + String(e && e.message || e), quarantine, moved }; }
  return { ok: true, quarantine: marker.quarantine, moved, acknowledgedRoots: marker.acknowledgedRoots };
}

module.exports = { inspectWorkspaceLineage: inspectWorkspaceLineage, startFresh: startFresh, FRESH_MARKER: FRESH_MARKER, _internals: { meaningfulEntries: meaningfulEntries, isBootstrapControlEntry: isBootstrapControlEntry } };
