/* node test/desktop-build-macos-notarization.test.js
   Ensures manual/test Mac builds preserve asynchronous Apple submissions so a long
   notarization queue can be resumed without rebuilding or resubmitting the app. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'desktop-build.yml'), 'utf8');

const buildStep = yml.match(/- name: Build desktop bundles([\s\S]*?)(?=\n      - name: Submit macOS DMG)/);
A.ok(buildStep, 'manual workflow has a desktop build step');
for (const credential of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) {
  A.ok(!buildStep[1].includes(`secrets.${credential}`),
    `manual Tauri build does not receive ${credential}`);
}

A.ok(/Submit macOS DMG for asynchronous notarization/.test(yml),
  'manual workflow submits the completed DMG asynchronously');
A.ok(/os: macos-15-intel[\s\S]{0,120}target: darwin-x64/.test(yml),
  'manual Intel Mac builds run on an actual x86_64 hosted runner');
A.ok(/Verify v0\.8\.5 station recovery on Intel macOS[\s\S]{0,220}uname -m[\s\S]{0,120}upgrade-085-090\.test\.js/.test(yml),
  'manual Intel Mac builds exercise the released workspace upgrade on x86_64 hardware');
A.ok(/matrix\.target == 'darwin-x64'[\s\S]{0,220}hydrate-sharp-macos-x64\.sh/.test(yml),
  'manual Intel Mac builds hydrate the lockfile-pinned x64 Sharp runtime');
A.ok(/Prepare bundled macOS native dependencies for signing[\s\S]{0,1400}sign-macos-native-deps\.sh/.test(yml),
  'credentialed manual Mac builds sign the staged native dependency closure');
A.ok(/present" -eq 0[\s\S]{0,300}internal testing only/.test(yml),
  'keyless manual Mac builds remain explicitly unsigned internal-test artifacts');
A.ok(/partial Apple signing credentials[\s\S]{0,120}mixed-trust app/.test(yml),
  'partial Apple credentials fail instead of producing a mixed-trust app');
A.ok(/name: notarization-input-\$\{\{ matrix\.target \}\}/.test(yml),
  'manual workflow preserves submitted DMG and Apple id');
A.ok(/notarize-macos:[\s\S]*?timeout-minutes: 350/.test(yml),
  'manual workflow finalizes notarization in an independent bounded job');
A.ok(/notarize-macos-finalize\.sh/.test(yml), 'manual workflow uses the retryable finalizer');
A.ok(/name: starnet-\$\{\{ matrix\.target \}\}/.test(yml),
  'only the final notarized DMG receives the distributable artifact name');
A.ok(/needs: \[build, notarize-macos\]/.test(yml),
  'test publication waits for both Mac finalizers');
A.ok(/pattern: starnet-\*/.test(yml),
  'test publication excludes unstapled notarization-input artifacts');

A.report('desktop-build-macos-notarization.test');
