/* node test/workspace-safety.test.js — DEV/QA roots can never alias canonical StarNet user data. */
'use strict';
const A = require('./_assert.js');
const win = require('node:path').win32;
const posix = require('node:path').posix;
const { classifyWorkspace } = require('../sidecar/workspace-safety.js');

const winDeps = {
  path: win,
  platform: 'win32',
  env: { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local', APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' },
  homedir: () => 'C:\\Users\\Ada'
};
A.eq(classifyWorkspace('c:\\users\\ada\\appdata\\local\\STARNET\\workspaces\\', winDeps).protected, true,
  'current Windows root is protected case-insensitively');
A.eq(classifyWorkspace('C:\\Users\\Ada\\AppData\\Roaming\\Skynet\\workspaces', winDeps).protected, true,
  'legacy rename root is protected');
A.eq(classifyWorkspace('C:\\Users\\Ada\\AppData\\Roaming\\ai.skynet.harness\\workspaces', winDeps).protected, true,
  'Tauri production identifier root is protected');
A.eq(classifyWorkspace('C:\\Users\\Ada\\AppData\\Roaming\\ai.skynet.harness.canary\\workspaces', winDeps).protected, false,
  'isolated canary identifier is not confused with production');
A.eq(classifyWorkspace('D:\\scratch\\starnet-eval-123', winDeps).protected, false,
  'an unrelated scratch root is allowed');

const posixDeps = { path: posix, platform: 'linux', env: {}, homedir: () => '/home/ada' };
A.eq(classifyWorkspace('/home/ada/.local/share/StarNet/workspaces', posixDeps).protected, true,
  'POSIX fallback production root is protected');
A.eq(classifyWorkspace('/tmp/starnet-test', posixDeps).protected, false, 'POSIX scratch root is allowed');

A.report('workspace-safety.test');
