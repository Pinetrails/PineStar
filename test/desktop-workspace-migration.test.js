/* node test/desktop-workspace-migration.test.js - source-lock the desktop launcher's workspace migration.

   Public downloads must not strand user state when a previous build wrote to an older app-data root. The
   Rust launcher is not easily unit-loaded from Node, so this test pins the important source invariants:
   known legacy roots are considered, migration is non-overwriting, and it runs before the sidecar starts. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../src-tauri/src/main.rs'), 'utf8');

A.ok(/fn\s+legacy_workspace_paths\s*\(/.test(src), 'desktop launcher declares legacy_workspace_paths');
A.ok(/base\.join\("StarNet"\)\.join\("workspaces"\)/.test(src), 'legacy StarNet app-data workspace is considered');
A.ok(/base\.join\("Skynet"\)\.join\("workspaces"\)/.test(src), 'legacy Skynet app-data workspace is considered');
A.ok(/base\.join\("ai\.skynet\.harness"\)\.join\("workspaces"\)/.test(src), 'identifier-based app-data workspace is considered');
A.ok(/join\("sidecar"\)\.join\("workspaces"\)/.test(src), 'old install-sidecar workspace is considered');

A.ok(/fn\s+copy_missing_dir\s*\(/.test(src), 'desktop launcher declares copy_missing_dir');
A.ok(/if\s+!\s*dst\.exists\(\)\s*\{[\s\S]{0,220}std::fs::copy\(src,\s*dst\)/.test(src), 'migration copies files only when destination is missing');
A.ok(/file_type\(\)\.is_symlink\(\)[\s\S]{0,80}return\s+Ok\(\(\)\)/.test(src), 'migration skips symlinks');

// Audit 0.1: migration must be a ONE-SHOT, gated by a done-marker, or a stale legacy root
// resurrects files the user deleted on every boot. Source-lock the marker gate so this never
// regresses back to unconditional copying.
A.ok(/const\s+MIGRATION_MARKER\s*:\s*&str\s*=\s*"\.migrated"/.test(src), 'migration declares a .migrated done-marker');
A.ok(/const\s+MIGRATION_PENDING_MARKER\s*:\s*&str\s*=\s*"\.migration-pending"/.test(src), 'migration declares an in-progress receipt');
A.ok(/if\s+marker\.exists\(\)\s*\{[\s\S]{0,60}return/.test(src), 'migration skips entirely once the marker exists');
A.ok(/workspace_has_content\(current\)/.test(src), 'migration skips when the live workspace already has content');
A.ok(/if\s+copy_failed\s*\{[\s\S]{0,80}return\s+migrated/.test(src), 'a copy failure returns before the done-marker is written');
A.ok(/workspace-migration:\s+RETRY required/.test(src), 'copy failures are named as retryable in the startup log');

const setupMigration = src.indexOf('let migrated_workspaces = migrate_workspace_data');
// Setup kicks off the sidecar via spawn_sidecar_with_retry(&state) (audit 0.2 wrapped the bare
// spawn so a first-run failure shows a Retry dialog); accept either the wrapper or a bare spawn so
// this invariant is about ORDERING, not the exact helper name.
const sidecarSpawn = src.search(/spawn_sidecar(?:_with_retry)?\(&state\)/);
A.ok(setupMigration >= 0, 'setup invokes workspace migration');
A.ok(sidecarSpawn >= 0, 'setup spawns the sidecar');
A.ok(setupMigration < sidecarSpawn, 'workspace migration runs before sidecar spawn');
A.ok(/migrated_from=/.test(src), 'startup log records migrated workspace roots');

A.report('desktop-workspace-migration.test');
