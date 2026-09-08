/* PS-2026-075: real sidecar CORS composition for the Tauri development WebView origin. */
'use strict';
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { TAURI_DEV_ORIGIN } = require('../sidecar/apiauth.js');

async function request(base, path, options) {
  const response = await fetch(base + path, options);
  return response;
}

(async () => {
  const packaged = SidecarFixture.create({ prefix: 'ps075-prod-', env: { STARNET_DESKTOP_SHELL: '1' } });
  const dev = SidecarFixture.create({ prefix: 'ps075-dev-', env: { STARNET_DESKTOP_SHELL: '1', STARNET_TAURI_DEV: '1' } });
  try {
    await packaged.start();
    const packagedOrigin = 'http://tauri.localhost';
    const packagedGet = await request(packaged.baseUrl, '/api/save?agent=agent', {
      headers: { Origin: packagedOrigin, 'X-StarNet-Token': packaged.token }
    });
    A.eq(packagedGet.status, 200, 'packaged Tauri origin remains allowed with authentication');
    A.eq(packagedGet.headers.get('access-control-allow-origin'), packagedOrigin, 'packaged origin is returned exactly');
    const prodDevOrigin = await request(packaged.baseUrl, '/api/save?agent=agent', {
      headers: { Origin: TAURI_DEV_ORIGIN, 'X-StarNet-Token': packaged.token }
    });
    A.eq(prodDevOrigin.status, 403, 'release-shaped desktop sidecar rejects the dev origin');
    A.eq(prodDevOrigin.headers.get('access-control-allow-origin'), null, 'production never emits CORS permission for the dev origin');

    await dev.start();
    const preflight = await request(dev.baseUrl, '/api/save?agent=agent', {
      method: 'OPTIONS',
      headers: {
        Origin: TAURI_DEV_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-StarNet-Token'
      }
    });
    A.eq(preflight.status, 204, 'authenticated-header preflight succeeds for the fixed Tauri dev origin');
    A.eq(preflight.headers.get('access-control-allow-origin'), TAURI_DEV_ORIGIN, 'preflight returns only the exact dev origin');
    A.ok((preflight.headers.get('access-control-allow-methods') || '').split(',').map(x => x.trim()).includes('GET'), 'preflight permits GET');
    A.ok((preflight.headers.get('access-control-allow-headers') || '').split(',').map(x => x.trim().toLowerCase()).includes('x-starnet-token'), 'preflight permits X-StarNet-Token');
    A.ok(preflight.headers.get('access-control-allow-origin') !== '*', 'wildcard origin is never returned');

    const noToken = await request(dev.baseUrl, '/api/save?agent=agent', { headers: { Origin: TAURI_DEV_ORIGIN } });
    A.eq(noToken.status, 403, 'dev-origin protected route still requires authentication');
    const save = await request(dev.baseUrl, '/api/save?agent=agent', {
      headers: { Origin: TAURI_DEV_ORIGIN, 'X-StarNet-Token': dev.token }
    });
    A.eq(save.status, 200, 'authenticated save GET reaches the sidecar from the dev origin');
    A.eq(save.headers.get('access-control-allow-origin'), TAURI_DEV_ORIGIN, 'authenticated response returns the exact dev origin');

    for (const origin of ['http://localhost:1430', 'http://127.0.0.1:1431', 'https://evil.example']) {
      const rejected = await request(dev.baseUrl, '/api/loops', {
        headers: { Origin: origin, 'X-StarNet-Token': dev.token }
      });
      A.eq(rejected.status, 403, origin + ' is rejected');
      A.eq(rejected.headers.get('access-control-allow-origin'), null, origin + ' receives no CORS permission');
    }
  } finally {
    await packaged.dispose();
    await dev.dispose();
  }
  A.report('sidecar-dev-cors');
})().catch(error => { console.error(error); process.exit(1); });
