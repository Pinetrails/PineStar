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
