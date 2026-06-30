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

const setupMigration = src.indexOf('let migrated_workspaces = migrate_workspace_data');
const sidecarSpawn = src.indexOf('let _ = spawn_sidecar(&state);');
A.ok(setupMigration >= 0, 'setup invokes workspace migration');
A.ok(sidecarSpawn >= 0, 'setup spawns the sidecar');
A.ok(setupMigration < sidecarSpawn, 'workspace migration runs before sidecar spawn');
A.ok(/migrated_from=/.test(src), 'startup log records migrated workspace roots');

A.report('desktop-workspace-migration.test');
