/* node test/desktop-api-bridge.test.js -- PS-2026-074 desktop sidecar bridge regression. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'desktop-api-bridge.js'), 'utf8');

function install(token) {
  const calls = [];
  const window = {
    __STARNET_API__: 'http://127.0.0.1:61800',
    __STARNET_API_TOKEN__: token,
    location: { origin: 'http://tauri.localhost' },
    fetch: async (input, init) => { calls.push({ input, init }); return { status: 200 }; }
  };
  const context = { window, Request, Headers, URL };
  vm.runInNewContext(BRIDGE, context, { filename: 'desktop-api-bridge.js' });
  return { fetch: window.fetch, calls };
}

(async () => {
  const first = install('launch-token');
  const controller = new AbortController();
  await first.fetch('/api/save?agent=agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Caller': 'kept' },
    body: '{"ok":true}',
    cache: 'no-store',
    credentials: 'include',
    signal: controller.signal
  });
  const routed = first.calls[0];
  A.eq(routed.input, 'http://127.0.0.1:61800/api/save?agent=agent', 'root-relative API URL is routed to the private sidecar');
  A.eq(routed.init.headers.get('X-StarNet-Token'), 'launch-token', 'routed API request receives the launch token');
  A.eq(routed.init.headers.get('Content-Type'), 'application/json', 'caller Content-Type survives');
  A.eq(routed.init.headers.get('X-Caller'), 'kept', 'other caller headers survive');
  A.eq([routed.init.method, routed.init.body, routed.init.cache, routed.init.credentials], ['POST', '{"ok":true}', 'no-store', 'include'], 'request options survive');
  A.eq(routed.init.signal, controller.signal, 'caller abort signal survives');

  const requestInput = new Request('http://tauri.localhost/api/objectives?x=1', {
    method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Request': 'kept' }, body: 'payload'
  });
  await first.fetch(requestInput);
  const requestCall = first.calls[1];
  A.ok(requestCall.input instanceof Request, 'Request-object input remains a Request');
  A.eq(requestCall.input.url, 'http://127.0.0.1:61800/api/objectives?x=1', 'same-origin Request API input is routed');
  A.eq(requestCall.init.headers.get('X-StarNet-Token'), 'launch-token', 'Request-object route receives the token');
  A.eq(requestCall.init.headers.get('Content-Type'), 'text/plain', 'Request-object headers survive');
  A.eq(requestCall.init.headers.get('X-Request'), 'kept', 'all Request-object caller headers survive');
  A.eq(requestCall.input.method, 'POST', 'Request-object method survives');

  await first.fetch('/assets/app.js');
  await first.fetch('https://provider.example/api/run', { headers: { Authorization: 'Bearer provider' } });
  await first.fetch(new Request('https://evil.example/api/save'));
  for (const call of first.calls.slice(2)) {
    const headers = new Headers(call.init && call.init.headers ? call.init.headers : call.input.headers);
    A.eq(headers.has('X-StarNet-Token'), false, 'non-routed and external requests never receive the token');
  }

  const restarted = install('launch-token');
  await restarted.fetch('/api/save');
  A.eq(restarted.calls[0].init.headers.get('X-StarNet-Token'), 'launch-token', 'same-launch bridge retains the token contract after sidecar restart');

  A.report('desktop-api-bridge');
})().catch((error) => { console.error(error); process.exit(1); });
