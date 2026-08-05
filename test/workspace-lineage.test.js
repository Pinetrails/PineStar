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
  let v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, false, 'runtime/schema/migration infrastructure alone is a genuine first run');
  A.eq(v.onboardingAllowed, true, 'onboarding is allowed only with zero evidence');

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
  A.eq(/CONTINUE.*FRESH|CREATE.*STATION/i.test(screen), false, 'Recovery Mode exposes no fresh-station bypass');
  A.report('workspace-lineage.test');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
