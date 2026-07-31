/* node test/release-train-windows-trust.test.js
   Locks the public release train's Windows trust boundary. Manual/test builds may remain
   unsigned, but a tagged shipping train must require Azure Artifact Signing credentials
   and prove the app, installer, and bundled Node runtime have valid timestamped signatures. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-train.yml'), 'utf8');

const requiredStep = yml.match(
  /- name: Require complete Azure Artifact Signing credentials([\s\S]*?)(?=\n      - name:)/
);
A.ok(requiredStep, 'release train has a pre-build Azure credential gate');
const gate = requiredStep[1];

for (const secret of [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET'
]) {
  A.ok(gate.includes(`secrets.${secret}`), `credential gate receives ${secret}`);
}
A.ok(gate.includes('for v in AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET'),
  'credential gate checks the complete Azure secret set');
A.ok(/if: runner\.os == 'Windows'/.test(gate), 'credential gate only runs on Windows legs');
A.ok(/exit 1/.test(gate), 'missing Azure credentials fail the release train');

const buildStep = yml.match(
  /- name: Build desktop bundles \(signed updater artifacts required\)([\s\S]*?)(?=\n      - name:)/
);
A.ok(buildStep, 'release train has the signed desktop build step');
const build = buildStep[1];
A.ok(/cargo install trusted-signing-cli --locked/.test(build),
  'Windows build installs the Artifact Signing client');
A.ok(/starnet-signing/.test(build) && /starnet-public/.test(build),
  'Windows build selects the production signing account and public-trust profile');
A.ok(!/Windows exe\/installer will be UNSIGNED/.test(build),
  'shipping Windows build has no unsigned-success escape hatch');

const trustStep = yml.match(
  /- name: Verify Windows Authenticode signing \+ timestamp([\s\S]*?)(?=\n      # macOS trust proof)/
);
A.ok(trustStep, 'release train has a Windows Authenticode trust proof');
const trust = trustStep[1];
A.ok(/if: runner\.os == 'Windows'/.test(trust), 'trust proof only runs on Windows legs');
A.ok(/shell: pwsh/.test(trust), 'trust proof uses Windows signature APIs');
A.ok(/Get-AuthenticodeSignature/.test(trust) && /Status -ne 'Valid'/.test(trust),
  'trust proof requires Windows to validate each embedded signature');
A.ok(/TimeStamperCertificate/.test(trust), 'trust proof requires a trusted timestamp');
A.ok(/skynet-desktop\.exe/.test(trust), 'trust proof checks the StarNet executable');
A.ok(/\*-setup\.exe/.test(trust), 'trust proof checks the NSIS installer');
A.ok(/node-x86_64-pc-windows-msvc\.exe/.test(trust),
  'trust proof checks the bundled Node runtime');
A.ok(/CN=Andrew Sims/.test(trust), 'StarNet binaries must carry the verified publisher identity');
A.ok(/CN=OpenJS Foundation/.test(trust), 'bundled Node must retain its upstream publisher identity');

A.report('release-train-windows-trust.test');
