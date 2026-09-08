/* node test/workspace-lineage.test.js — prior-state evidence structurally dominates onboarding. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectWorkspaceLineage } = require('../sidecar/workspace-lineage.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-lineage-'));
const current = path.join(root, 'current', 'workspaces');
const legacy = path.join(root, 'legacy', 'workspaces');
const snapshots = path.join(root, 'current', 'update-snapshots');
fs.mkdirSync(current, { recursive: true });
try {
  fs.writeFileSync(path.join(current, '.starnet-workspace-owner.json'), '{}');
  fs.writeFileSync(path.join(current, '.schema-version.json'), '{}');
  fs.writeFileSync(path.join(current, '.migrated'), '1');
  fs.writeFileSync(path.join(current, '.migration-receipt.json'), JSON.stringify({ version: 1, validated: true, sourceRoots: [], files: [] }));
  let v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, false, 'runtime/schema/migration infrastructure, including an empty migration receipt, is a genuine first run');
  A.eq(v.onboardingAllowed, true, 'onboarding is allowed only with zero evidence');

  fs.writeFileSync(path.join(current, 'future-cache-v2.json'), '{"cache":true}');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, true, 'unknown workspace files remain ambiguous and conservatively block onboarding');
  fs.unlinkSync(path.join(current, 'future-cache-v2.json'));

  const controls = {
    'loops.halt.json': { halted: true },
    'loops.halt.json.bak': { halted: true },
    'nightshift.state.json': { v: 1, day: 20691, beatsUsedToday: 0, lastBeatAt: 0, haltedAt: 1788829800533 },
    'nightshift.state.json.bak': { v: 1, day: 20691, beatsUsedToday: 0, lastBeatAt: 0, haltedAt: 1788829328167 }
  };
  for (const [name, value] of Object.entries(controls)) fs.writeFileSync(path.join(current, name), JSON.stringify(value));
  const controlBytes = Object.fromEntries(Object.keys(controls).map(name => [name, fs.readFileSync(path.join(current, name))]));
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, false, 'zero-activity loop/Night Shift E-STOP state and exact backups are pre-station scaffolding');
  A.eq(v.onboardingAllowed, true, 'control-only workspace permits genuine first-run onboarding');
  for (const name of Object.keys(controls)) {
    A.eq(fs.existsSync(path.join(current, name)), true, name + ' remains present after read-only lineage inspection');
    A.eq(Buffer.compare(controlBytes[name], fs.readFileSync(path.join(current, name))), 0, name + ' retains its exact safety state');
  }

  fs.writeFileSync(path.join(current, 'nightshift.state.json'), JSON.stringify({ v: 1, day: 20691, beatsUsedToday: 1, lastBeatAt: 1788829000000, haltedAt: 0 }));
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, true, 'Night Shift activity is station evidence even though the filename is also used for bootstrap state');
  fs.writeFileSync(path.join(current, 'nightshift.state.json'), JSON.stringify(controls['nightshift.state.json']));

  fs.writeFileSync(path.join(current, 'loops.halt.json'), '{bad json');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, true, 'an unreadable known control file stays ambiguous and blocks onboarding');
  fs.writeFileSync(path.join(current, 'loops.halt.json'), JSON.stringify(controls['loops.halt.json']));

  fs.writeFileSync(path.join(current, 'other.halt.json'), JSON.stringify({ halted: true }));
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, true, 'bootstrap exclusion is exact-name, not extension or suffix based');
  fs.unlinkSync(path.join(current, 'other.halt.json'));
  for (const name of Object.keys(controls)) fs.unlinkSync(path.join(current, name));

  fs.writeFileSync(path.join(current, 'ledger.jsonl'), '{"event":"prior-work"}\n');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, true, 'known durable station ledgers still block destructive first-run inference when the save is missing');
  fs.unlinkSync(path.join(current, 'ledger.jsonl'));

  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'agent.save.json'), '{"version":5}');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, true, 'state in a legacy workspace is prior-install evidence');
  A.eq(v.evidence[0].kind, 'legacy-workspace', 'evidence names its legacy source');

  fs.rmSync(legacy, { recursive: true, force: true });
  fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(path.join(snapshots, 'pre-2.0-1.starnet-backup.json'), '{}');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.evidence[0].kind, 'update-snapshot', 'verified update-snapshot presence blocks genesis');

  fs.rmSync(snapshots, { recursive: true, force: true });
  fs.writeFileSync(path.join(current, '.migration-pending'), '1');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.evidence.some(x => x.kind === 'migration-pending'), true, 'interrupted migration blocks genesis');

  fs.unlinkSync(path.join(current, '.migration-pending'));
  fs.writeFileSync(path.join(current, 'agent.save.json.corrupt-9'), 'forensic');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, true, 'forensic corrupt generation remains prior-state evidence');
  A.eq(v.onboardingAllowed, false, 'an unreadable save blocks onboarding even when recovery cannot produce a candidate');
  fs.unlinkSync(path.join(current, 'agent.save.json.corrupt-9'));

  fs.writeFileSync(path.join(current, 'agent.roster.json'), '{"version":1,"agents":[]}');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, true, 'station identity/configuration remains prior-station evidence');
  fs.unlinkSync(path.join(current, 'agent.roster.json'));

  fs.writeFileSync(path.join(current, 'manual.starnet-recovery.json'), '{}');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, true, 'recovery evidence remains a conservative onboarding gate');
  fs.unlinkSync(path.join(current, 'manual.starnet-recovery.json'));

  const app = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
  const check = app.indexOf('lineage.priorInstallEvidence === true');
  const splash = app.indexOf('showSplash();', check);
  A.ok(check > 0 && splash > check, 'lineage gate structurally dominates the final onboarding call');
  const fn = app.slice(app.indexOf('function showPriorStateGate'), app.indexOf('/* ---------- boot ---------- */'));
  A.eq(fn.includes('startCreation('), false, 'Recovery Mode has no route into fresh creation');
  A.ok(fn.includes("show('screen-lineage')"), 'prior-state evidence renders the dedicated recovery screen');
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  const screen = html.slice(html.indexOf('<section id="screen-lineage"'), html.indexOf('<!-- ============ GAME', html.indexOf('<section id="screen-lineage"')));
  A.ok(screen.includes('READ ONLY') && screen.includes('btn-lineage-restore') && screen.includes('btn-lineage-retry'), 'Recovery Mode offers restore/retry and declares read-only posture');
  A.ok(screen.includes('btn-lineage-recover') && screen.includes('btn-lineage-report'), 'Recovery Mode offers verified candidate recovery and a redacted report without Terminal work');
  A.ok(fn.includes('/api/lineage/recover') && fn.includes('/api/lineage/report'), 'Recovery Mode wires both actions to authenticated sidecar truth');
  // START FRESH is NOT a bypass: it is sidecar-backed (quarantine + marker, never a delete) and the page still
  // has no route into startCreation. The lock is the SHAPE — the button exists, it is wired to the sidecar
  // route, and nothing on the screen creates a station client-side.
  A.ok(screen.includes('btn-lineage-fresh'), 'Recovery Mode offers START FRESH (the third exit)');
  A.ok(fn.includes('/api/lineage/start-fresh'), 'START FRESH is wired to the sidecar quarantine route, never a client-side wipe');
  A.eq(/CREATE.*STATION/i.test(screen), false, 'Recovery Mode exposes no client-side create-station bypass');

  // startFresh(): quarantines current-workspace state (never deletes), acknowledges external roots, and the
  // next inspection allows onboarding.
  const { startFresh } = require('../sidecar/workspace-lineage.js');
  fs.writeFileSync(path.join(current, 'ledger.jsonl'), '{"event":"failed-first-run"}\n');
  fs.writeFileSync(path.join(current, 'loops.halt.json'), '{"halted":true}');
  fs.writeFileSync(path.join(current, 'liveprices.cache.json'), '{}');   // infra: stays put
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'agent.save.json'), '{"version":5}');
  fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(path.join(snapshots, 'x.starnet-backup.json'), '{}');
  let before = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(before.priorInstallEvidence, true, 'fixture: the gate would fire');
  const fresh = startFresh({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform, now: () => Date.UTC(2026, 7, 22, 12, 0, 0) });
  A.eq(fresh.ok, true, 'start fresh succeeds');
  A.ok(fresh.moved.includes('ledger.jsonl'), 'station evidence moves to quarantine');
  A.eq(fresh.moved.includes('loops.halt.json'), false, 'verified bootstrap control state is not moved or altered');
  A.eq(fresh.moved.includes('liveprices.cache.json'), false, 'infrastructure never moves');
  A.eq(fs.existsSync(path.join(fresh.quarantine, 'ledger.jsonl')), true, 'moved files live on in quarantine (never deleted)');
  A.eq(fs.existsSync(path.join(current, 'ledger.jsonl')), false, 'the live workspace no longer holds the stale state');
  A.eq(fs.existsSync(path.join(current, 'liveprices.cache.json')), true, 'infrastructure files are untouched');
  A.eq(fs.existsSync(path.join(current, 'loops.halt.json')), true, 'loop E-STOP state remains in the live workspace');
  A.eq(fs.existsSync(path.join(legacy, 'agent.save.json')), true, 'a legacy root is acknowledged, never moved or deleted');
  A.eq(fresh.quarantine.indexOf(path.join(root, 'current', 'workspace-quarantine')) === 0, true, 'quarantine is a SIBLING of the workspace, so it is never re-read as evidence');
  const after = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(after.priorInstallEvidence, false, 'after START FRESH the gate no longer fires');
  A.eq(after.onboardingAllowed, true, 'onboarding is allowed');
  // the marker never suppresses CURRENT-workspace evidence: a real save that appears later still counts.
  fs.writeFileSync(path.join(current, 'agent.save.json'), '{"version":5}');
  const later = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(later.priorInstallEvidence, true, 'live-workspace state after a fresh start is still honored as evidence');
  fs.unlinkSync(path.join(current, 'agent.save.json'));
  fs.unlinkSync(path.join(current, 'loops.halt.json'));
  fs.rmSync(legacy, { recursive: true, force: true });
  fs.rmSync(snapshots, { recursive: true, force: true });
  fs.unlinkSync(path.join(current, '.fresh-start.json'));
  A.report('workspace-lineage.test');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
