/* node test/tauri.hardening.test.js -- static guard for desktop browser hardening. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const caps = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'capabilities', 'default.json'), 'utf8'));
const mainRs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');
const indexJs = fs.readFileSync(path.join(root, 'sidecar', 'index.js'), 'utf8');
const browserJs = fs.readFileSync(path.join(root, 'sidecar', 'tools', 'builtin', 'browser.js'), 'utf8');

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
A.ok(/fn sidecar_command[\s\S]*?\.env\("STARNET_COMPUTER_DRIVER", "1"\)/.test(mainRs), 'desktop host enables the native driver; paired remote-owner authority still gates every call in the sidecar');
A.ok(!/fn sidecar_command[\s\S]*?\.env\("STARNET_BROWSER_HEADLESS", "1"\)/.test(mainRs), 'desktop sidecar does not globally disable the attended browser-login exception');
A.ok(/runBrowser = makeBrowserTools\([\s\S]*?forceHeadless:\s*true[\s\S]*?syntheticInputOnly:\s*true[\s\S]*?attendedLogin:/.test(indexJs), 'ordinary desktop research stays headless and input-isolated while the watched login channel is wired separately');
A.ok(/relaunch\(\{ headed: true, forceHeadless: false, headless: false, syntheticInputOnly: false \}\)/.test(browserJs), 'browser.login is the narrow human-consented exception that may open a real visible Chrome window');
A.ok(/fn sidecar_command[\s\S]*?\.env\("STARNET_USER_CONTROL_MODE", "preserve"\)/.test(mainRs), 'every desktop sidecar launch pins user-control preservation');
A.ok(/fn sidecar_command[\s\S]*?\.env\("STARNET_MCP_STDIO", "0"\)/.test(mainRs), 'installed desktop refuses unsandboxed local MCP children');
A.ok(/fn set_sidecar_branded_env[\s\S]*?strip_prefix\("SKYNET_"\)[\s\S]*?STARNET_\{suffix\}/.test(mainRs), 'desktop-owned sidecar values replace both brand aliases');
for (const suffix of ['PORT', 'IPC_TOKEN', 'API_TOKEN', 'WORKSPACES', 'OPENROUTER_KEY']) {
  A.ok(new RegExp(`set_sidecar_branded_env\\(&mut cmd, "SKYNET_${suffix}"`).test(mainRs), `desktop pins both aliases for ${suffix}`);
}
A.ok(/for \(provider, env_name\) in SIDECAR_PROVIDER_KEY_ENVS[\s\S]*?set_sidecar_branded_env\(&mut cmd, env_name, key\)/.test(mainRs), 'provider keychain values cannot be shadowed by inherited canonical aliases');
A.ok(/for \(channel, env_name\) in SIDECAR_CHANNEL_TOKEN_ENVS[\s\S]*?set_sidecar_branded_env\(&mut cmd, env_name, token\)/.test(mainRs), 'channel keychain values cannot be shadowed by inherited canonical aliases');
A.ok(/fn desktop_owned_env_replaces_poisoned_brand_aliases[\s\S]*?poisoned-parent-value[\s\S]*?fresh-launch-token/.test(mainRs), 'Rust regression test poisons both alias directions before applying desktop-owned values');
A.ok(!/starnet_open_workshop_file/.test(mainRs), 'webview IPC exposes no workshop file launcher');
A.ok(!/starnet_open_user_directory/.test(mainRs), 'webview IPC exposes no directory launcher');

A.report('tauri.hardening.test');
