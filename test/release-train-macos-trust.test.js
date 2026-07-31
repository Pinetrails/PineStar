/* node test/release-train-macos-trust.test.js
   Locks the public release train's macOS trust boundary. Manual/test builds may remain
   unsigned, but a tagged shipping train must fail closed unless all Developer ID and
   notarization credentials exist, and it must require Gatekeeper's notarized verdict. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-train.yml'), 'utf8');

const requiredStep = yml.match(
  /- name: Require complete Apple signing credentials([\s\S]*?)(?=\n      - name:)/
);
A.ok(requiredStep, 'release train has a pre-build Apple credential gate');
const gate = requiredStep[1];

for (const secret of [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID'
]) {
  A.ok(gate.includes(`secrets.${secret}`), `credential gate receives ${secret}`);
}
A.ok(gate.includes(
  'for v in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID'
), 'credential gate checks the complete Apple secret set');
A.ok(/if: runner\.os == 'macOS'/.test(gate), 'credential gate only runs on macOS legs');
A.ok(/exit 1/.test(gate), 'missing Apple credentials fail the release train');
A.ok(/Developer ID Application:/.test(gate), 'signing identity must be Developer ID Application');

const trustStep = yml.match(
  /- name: Verify macOS signing \+ notarization, staple DMG([\s\S]*?)(?=\n      - name:)/
);
A.ok(trustStep, 'release train has a macOS trust proof');
const trust = trustStep[1];
A.ok(/Authority=Developer ID Application/.test(trust), 'trust proof rejects ad-hoc signatures');
A.ok(/flags=\.\*runtime/.test(trust), 'trust proof requires hardened runtime');
A.ok(/allow-jit/.test(trust), 'trust proof checks the bundled Node JIT entitlement');
A.ok(/notarytool submit/.test(trust) && /stapler staple/.test(trust) && /stapler validate/.test(trust),
  'trust proof notarizes, staples, and validates the DMG');
A.ok(/source=Notarized Developer ID/.test(trust), 'trust proof asks Gatekeeper for the notarized verdict');
A.ok(/source=Notarized Developer ID[\s\S]*?exit 1/.test(trust),
  'a non-notarized Gatekeeper source is a hard failure');
A.ok(!/no Apple cert[\s\S]*?exit 0/.test(trust),
  'shipping trust proof has no unsigned-success escape hatch');

A.report('release-train-macos-trust.test');
