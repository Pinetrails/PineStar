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
const submitScript = fs.readFileSync(path.join(root, 'scripts', 'notarize-macos-submit.sh'), 'utf8');
const finalizeScript = fs.readFileSync(path.join(root, 'scripts', 'notarize-macos-finalize.sh'), 'utf8');

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

const nativeStep = yml.match(
  /- name: Prepare and sign bundled macOS native dependencies([\s\S]*?)(?=\n      - name: Build desktop bundles)/
);
A.ok(nativeStep, 'release train has a pre-bundle native dependency signing step');
const native = nativeStep[1];
A.ok(/if: runner\.os == 'macOS'/.test(native), 'native signing only runs on macOS legs');
A.ok(/security import/.test(native) && /security set-key-partition-list/.test(native),
  'native signing imports the Developer ID certificate into an unlocked CI keychain');
A.ok(/sharp-darwin-arm64/.test(native) && /sharp-darwin-x64/.test(native),
  'each macOS leg prunes Sharp to its matching architecture');
A.ok(/file -b "\$native" \| grep -q 'Mach-O'/.test(native),
  'native signing discovers every Mach-O file instead of relying on filename extensions');
A.ok(/codesign --force --options runtime --timestamp --sign "\$APPLE_SIGNING_IDENTITY" "\$native"/.test(native),
  'every staged Mach-O dependency receives Developer ID signing with a secure timestamp');

const buildStep = yml.match(
  /- name: Build desktop bundles \(signed updater artifacts required\)([\s\S]*?)(?=\n      # P1\.5)/
);
A.ok(buildStep, 'release train has a desktop build step');
for (const credential of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) {
  A.ok(!buildStep[1].includes(`secrets.${credential}`),
    `Tauri build does not receive ${credential} and cannot block on built-in notarization`);
}

const trustStep = yml.match(
  /- name: Verify macOS Developer ID signing before notarization([\s\S]*?)(?=\n      # Tauri names)/
);
A.ok(trustStep, 'release train has a pre-notarization macOS trust proof');
const trust = trustStep[1];
A.ok(/Authority=Developer ID Application/.test(trust), 'trust proof rejects ad-hoc signatures');
A.ok(/flags=\.\*runtime/.test(trust), 'trust proof requires hardened runtime');
A.ok(/allow-jit/.test(trust), 'trust proof checks the bundled Node JIT entitlement');
A.ok(/find "\$app\/Contents\/Resources\/node_modules" -type f -print0/.test(trust),
  'trust proof scans the complete bundled native dependency tree');
A.ok(/nested native dependency is not Developer ID signed/.test(trust),
  'trust proof rejects unsigned or ad-hoc nested native dependencies');
A.ok(/nested native dependency has no secure timestamp/.test(trust),
  'trust proof rejects nested native dependencies without secure timestamps');
A.ok(/notarization-input-\$\{\{ matrix\.target \}\}/.test(yml),
  'exact submitted DMG and submission id are preserved as a retryable artifact');
A.ok(/notarize-macos:[\s\S]*?needs: build[\s\S]*?timeout-minutes: 350/.test(yml),
  'notarization finalization is an independent bounded job');
A.ok(/needs: \[build, notarize-macos\]/.test(yml),
  'release assembly waits for notarized Mac artifacts');

A.ok(/notarytool submit/.test(submitScript) && !/notarytool submit[\s\S]*?--wait/.test(submitScript),
  'submission is asynchronous and never consumes a runner waiting on Apple');
A.ok(/\.id/.test(submitScript), 'submission id is required and persisted');
A.ok(/notarytool info/.test(finalizeScript), 'finalizer resumes the saved Apple submission');
A.ok(/temporary failure polling Apple/.test(finalizeScript), 'transient polling failures are retried');
A.ok(/exit 75/.test(finalizeScript), 'an Apple queue timeout fails retryably before GitHub cancels the runner');
A.ok(/stapler staple/.test(finalizeScript) && /stapler validate/.test(finalizeScript),
  'accepted DMG is stapled and validated');
A.ok(/source=Notarized Developer ID/.test(finalizeScript),
  'finalizer asks Gatekeeper for the notarized verdict');
A.ok(/source=Notarized Developer ID[\s\S]*?exit 1/.test(finalizeScript),
  'a non-notarized Gatekeeper source is a hard failure');
A.ok(!/no Apple cert[\s\S]*?exit 0/.test(finalizeScript),
  'shipping trust proof has no unsigned-success escape hatch');

A.report('release-train-macos-trust.test');
