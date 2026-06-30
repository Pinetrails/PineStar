'use strict';
// permissions-ui.test.js — source-lock that the Permissions Panel is wired into the SETTINGS view (stationui.js):
// the never→fully-autonomous level row, the standing-grant list, and the store hooks that drive them. A grep-style
// guard (mirrors autonomy-ui / autojobs-ui) so the panel can't silently regress out of the build.
const assert = require('assert');
const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// the panel header + the live combined-truth blurb
ok(/PERMISSIONS\s*<span class="dim">/.test(src), 'PERMISSIONS section header present');
ok(/id="perm-desc"/.test(src), '#perm-desc combined-level blurb element present');

// the level spectrum: never → suggest → draft → full
ok(/id="perm-level"/.test(src), '#perm-level chooser present');
for (const lvl of ['never', 'suggest', 'draft', 'full']) ok(new RegExp('data-level="' + lvl + '"').test(src), 'level button present: ' + lvl);
ok(/FULLY AUTONOMOUS/.test(src), 'the "fully autonomous" extreme is offered');
ok(/>NEVER</.test(src), 'the "never" extreme is offered');

// the standing-grant list + grant/revoke wiring
ok(/id="perm-grants"/.test(src), '#perm-grants standing-grant list present');
ok(/data-perm-grant=|data-perm-revoke=/.test(src), 'per-capability grant/revoke buttons rendered');

// the store hooks
ok(/PermissionsStore\.setLevel\(/.test(src), 'level click drives PermissionsStore.setLevel');
ok(/PermissionsStore\.grant\(/.test(src) && /PermissionsStore\.revoke\(/.test(src), 'grant + revoke wired to the store');
ok(/PermissionsStore\.refresh\(/.test(src), 'panel refreshes grants from the sidecar on open');

// bidirectional sync: the granular dial repaints the permissions level (syncPerm) and vice versa (repaintDial)
ok(/syncPerm\s*=\s*repaintPerm/.test(src), 'the dial→permissions sync hook is wired');
ok(/repaintDial\(\)/.test(src), 'a level change repaints the granular dial too');

// guarded behind a typeof check so an older bundle without the store never throws
ok(/typeof PermissionsStore !== 'undefined'/.test(src), 'permissions block is feature-guarded');

console.log('permissions-ui.test.js OK —', n, 'assertions');
