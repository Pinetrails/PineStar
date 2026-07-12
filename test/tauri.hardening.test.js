/* node test/tauri.hardening.test.js -- static guard for desktop browser hardening. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const caps = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'capabilities', 'default.json'), 'utf8'));
const mainRs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');

const csp = String(conf.app && conf.app.security && conf.app.security.csp || '');
A.ok(csp.length > 0 && csp !== 'null', 'Tauri CSP is configured');
A.ok(/default-src 'self'/.test(csp), 'CSP defaults to self');
A.ok(/connect-src[^;]*http:\/\/127\.0\.0\.1:\*/.test(csp), 'CSP permits the packaged sidecar bridge');
A.ok(!/connect-src[^;]*localhost:\*/.test(csp), 'CSP does not include broad localhost connect access');
A.ok(/object-src 'none'/.test(csp), 'CSP disables plugin/object loads');
A.ok(/frame-ancestors 'none'/.test(csp), 'CSP blocks framing');
A.ok(/base-uri 'none'/.test(csp), 'CSP blocks base tag rewriting');
A.ok(/form-action 'none'/.test(csp), 'CSP blocks form exfiltration');

const remoteUrls = (caps.remote && caps.remote.urls) || [];
A.ok(remoteUrls.length === 0 || (remoteUrls.length === 1 && remoteUrls[0] === 'http://127.0.0.1:*/api/**'), 'remote capability is absent or narrowed to the 127.0.0.1 sidecar API');
A.ok(remoteUrls.every(u => u.indexOf('localhost') < 0), 'remote capability does not trust localhost aliases');
A.ok(remoteUrls.every(u => /\/api\/\*\*$/.test(u)), 'remote capability does not expose all loopback paths');
A.ok(/fn sidecar_command[\s\S]*?\.env\("STARNET_COMPUTER_DRIVER", "0"\)/.test(mainRs), 'every desktop sidecar launch pins the physical-input driver off');
A.ok(/fn sidecar_command[\s\S]*?\.env\("STARNET_BROWSER_HEADLESS", "1"\)/.test(mainRs), 'every desktop sidecar launch pins controlled browsing headless');
A.ok(/fn sidecar_command[\s\S]*?\.env\("STARNET_USER_CONTROL_MODE", "preserve"\)/.test(mainRs), 'every desktop sidecar launch pins user-control preservation');
A.ok(/fn sidecar_command[\s\S]*?\.env\("STARNET_MCP_STDIO", "0"\)/.test(mainRs), 'installed desktop refuses unsandboxed local MCP children');
A.ok(/fn starnet_open_workshop_file[\s\S]*?inert_deliverable_extension/.test(mainRs), 'native click-only workshop opener allowlists inert files');
A.ok(/active or executable deliverables cannot run on the user's desktop/.test(mainRs), 'native opener refuses active/executable deliverables');
A.ok(/starnet_open_workshop_file[\s\S]*?starnet_open_user_directory[\s\S]*?open_external_url/.test(mainRs), 'click-only open commands are registered with Tauri, not exposed as agent tools');

A.report('tauri.hardening.test');
