/* node test/summarize-failover.e2e.test.js — production-wiring regression for context compaction
   after credential rotation. Boots the real sidecar, forces fake KEYA to return 429, rotates to fake KEYB,
   triggers one tool turn and therefore compaction, then proves the real summarize closure uses KEYB too.
   No real credentials or external network. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function writeSse(res, deltas, usage, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const delta of deltas) {
    res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  }
  res.write('data: ' + JSON.stringify({
    choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage
  }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

function startMockOpenRouter() {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{
        id: 'compact/model', context_length: 10,
        pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools']
      }] }));
      return;
    }
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404); res.end(); return;
    }

    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/, '');
      const messages = body.messages || [];
      const summary = messages.some(m => String((m && m.content) || '')
        .includes('Summarize this earlier part of the conversation'));
      requests.push({ key, model: body.model, summary, messages, tools: body.tools || [] });

      if (key === 'KEYA') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'primary rate limited', code: 429 } }));
        return;
      }
      if (summary) {
        writeSse(res, [{ content: 'Earlier turns summarized safely.' }],
          { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, 'stop');
        return;
      }
      if (!messages.some(m => m && m.role === 'tool')) {
        writeSse(res, [{ tool_calls: [{
          index: 0, id: 'inspect_once', type: 'function',
          function: { name: 'station_inspect', arguments: '{}' }
        }] }], { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }, 'tool_calls');
        return;
      }
      writeSse(res, [{ content: 'Completed after failover and compaction.' }],
        { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 }, 'stop');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve({
      server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1'
    }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '', settled = false;
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) {}
      reject(new Error('sidecar boot timeout:\n' + output));
    }, 10000);
    const onData = d => {
      output += d.toString();
      if (!settled && output.includes('http://' + HOST + ':' + port)) {
        settled = true; clearTimeout(guard); resolve({ child, port, output: () => output });
      } else if (!settled && /already in use/i.test(output)) {
        settled = true; clearTimeout(guard); try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1));
        else reject(new Error('no free sidecar port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', e => {
      if (!settled) { settled = true; clearTimeout(guard); reject(e); }
    });
  });
}

function stopChild(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode != null) { resolve(); return; }
    const guard = setTimeout(resolve, 2000);
    child.once('exit', () => { clearTimeout(guard); resolve(); });
    try { child.kill(); } catch (_) { clearTimeout(guard); resolve(); }
  });
}

(async () => {
  const mock = await startMockOpenRouter();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-summarize-failover-'));
  let child = null;
  try {
    const env = {
      SKYNET_WORKSPACES: workspace,
      SKYNET_OPENROUTER_BASE: mock.base,
      STARNET_OPENROUTER_BASE: mock.base,
      SKYNET_AUX_BUDGET: '0',
      SKYNET_FULL_ACCESS: '1',
      OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', XAI_API_KEY: ''
    };
    const booted = await boot(8840 + (process.pid % 50), env, 20);
    child = booted.child;
    const base = 'http://' + HOST + ':' + booted.port;
    const token = await bootToken(base, base);
    A.ok(token.length >= 32, 'real sidecar issued a session API token');
    await new Promise(resolve => setTimeout(resolve, 300)); // let the mocked model catalog warm
    const startupErrors = booted.output().split(/\r?\n/).filter(line => /\b(error|failed|failure)\b/i.test(line));
    A.eq(startupErrors, [], 'the isolated sidecar logged no startup errors');

    const messages = [];
    for (let i = 0; i < 10; i++) {
      messages.push({
        role: i % 2 ? 'assistant' : 'user',
        content: 'historical turn ' + i + ' with enough text to fold safely'
      });
    }
    messages.push({ role: 'user', content: 'Fail over, inspect once, compact, then finish.' });
    const response = await fetch(base + '/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: base },
      body: JSON.stringify({
        key: 'KEYA', keyPool: ['KEYB'], model: 'compact/model',
        agentId: 'summarize-failover', isTask: true, messages
      })
    });
    A.eq(response.status, 200, 'the real /api/run stream opened');
    const raw = await response.text();
    const events = raw.split('\n').map(line => line.trim()).filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);

    const fallbacks = events.filter(e => e.name === 'provider.fallback');
    A.eq(fallbacks.length, 1, 'the primary failure emitted one bounded fallback');
    A.eq(fallbacks[0] && fallbacks[0].payload.reason, 'rate_limit', 'the primary failure classified as rate_limit');
    const summaries = mock.requests.filter(r => r.summary);
    A.eq(summaries.length, 1, 'the production summarize closure made one real provider request');
    A.eq(summaries[0] && summaries[0].key, 'KEYB', 'the summarizer used the rotated credential, not failed KEYA');
    A.eq(summaries[0] && summaries[0].model, 'compact/model', 'the summarizer kept the live model');
    A.eq(events.filter(e => e.name === 'agent.compact').length, 1, 'the run emitted one truthful compaction event');
    const end = events.filter(e => e.name === 'agent.run.end').pop();
    A.eq(end && end.payload.reason, 'done', 'the failed-over run completed after compaction');
  } finally {
    await stopChild(child);
    await new Promise(resolve => mock.server.close(resolve));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  A.report('summarize-failover.e2e.test');
})().catch(e => { console.error(e); process.exit(1); });
