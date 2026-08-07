/* Real-host live doctor proof: actual sidecar + local OpenAI-compatible provider + actual local execution
   backend. No external network, credentials, or channel delivery. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

function providerFixture() {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'doctor/model', context_length: 8000, pricing: { prompt: '0', completion: '0' } }] }));
        return;
      }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        requests.push(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}

test('real host proves selected model and effective execution backend without leaking secrets', async () => {
  const provider = await providerFixture();
  const secret = 'sk-or-v1-live-doctor-fixture-secret';
  const fixture = SidecarFixture.create({ prefix: 'sk-live-doctor-', env: {
    SKYNET_OPENROUTER_BASE: provider.baseUrl, STARNET_OPENROUTER_BASE: provider.baseUrl,
    SKYNET_OPENROUTER_KEY: secret, STARNET_OPENROUTER_KEY: secret,
    SKYNET_DEFAULT_MODEL: 'doctor/model', STARNET_DEFAULT_MODEL: 'doctor/model'
  } });
  try {
    await fixture.start();
    const roster = await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{
      agentId: 'doctor', name: 'Doctor', system: 'diagnose', provider: 'openrouter', model: 'doctor/model', executionProfile: 'trusted-project'
    }] });
    assert.equal(roster.status, 200);

    const refused = await fixture.json('POST', '/api/diagnostics/live', {});
    assert.equal(refused.status, 409);
    assert.equal(provider.requests.length, 0, 'missing consent performs no provider request');

    const result = await fixture.json('POST', '/api/diagnostics/live', { confirmedLiveProbes: true, agentId: 'doctor' });
    assert.equal(result.status, 200, result.text);
    assert.equal(provider.requests.length, 1, 'exactly one selected-model request was made');
    assert.deepEqual(provider.requests[0].messages, [{ role: 'user', content: 'Reply exactly OK.' }]);
    const rows = result.body.report.rows;
    const model = rows.find(r => r.kind === 'provider');
    const execution = rows.find(r => r.kind === 'execution');
    assert.equal(model.state, 'round-trip-proven');
    assert.equal(execution.state, 'round-trip-proven');
    assert.match(execution.detail, /effective local backend executed the sentinel/);
    assert.ok(rows.filter(r => r.kind === 'channel').every(r => r.state === 'not-configured'));
    assert.equal(rows.find(r => r.kind === 'mcp').state, 'not-configured');
    assert.doesNotMatch(JSON.stringify(result.body), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(result.body.text, /No keys, tokens, prompts, transcripts/);
  } finally {
    await fixture.dispose();
    await new Promise(resolve => provider.server.close(resolve));
  }
});
