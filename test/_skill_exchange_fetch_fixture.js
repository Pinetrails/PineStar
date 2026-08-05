'use strict';
// Loaded only by skill-exchange.http.test.js through NODE_OPTIONS. It makes one reserved hostname
// deterministic while preserving the real fetch implementation for the rest of the booted sidecar.
const fs = require('node:fs');
const originalFetch = globalThis.fetch;
globalThis.fetch = async function skillExchangeFixtureFetch(input, init) {
  const u = new URL(String(input));
  if (u.hostname !== 'example.com' || u.pathname !== '/SKILL.md') return originalFetch(input, init);
  const file = process.env.STARNET_TEST_SKILL_FIXTURE;
  const body = fs.readFileSync(file, 'utf8');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/markdown', 'content-length': String(Buffer.byteLength(body)) } });
};
