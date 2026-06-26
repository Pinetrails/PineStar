/* node test/image.test.js — the STUDIO skills: image_generate + image_analyze. Offline + deterministic
   (fetch injected, real temp workspace). Pairs with sidecar/tools/builtin/image.js. Verifies: the OpenRouter
   request shape (modalities for gen; text-then-image_url parts for analyze), base64 data-URL decode + jailed
   save, content-addressed default naming, a 'deliverable' emit, workspace-path read for analysis, jail escape
   refusal, and a clean error when no API key is set. */
'use strict';
const A = require('./_assert.js');
const fsp = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeImageTools } = require('../sidecar/tools/builtin/image.js');

const ROOT = path.join(os.tmpdir(), 'starnet-image-test');

// a 1x1 transparent PNG (real bytes), as base64 — used as the model's "generated" image
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DATA_URL = 'data:image/png;base64,' + PNG_B64;

// build a fetch stub: records the last request body, returns a routed response
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    let body = null; try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) {}
    calls.push({ url: String(url), body, init });
    return handler(String(url), body, init);
  };
  fn.calls = calls;
  return fn;
}

function jsonResp(obj, status) { return { status: status || 200, json: async () => obj, arrayBuffer: async () => Buffer.alloc(0), headers: { get: () => 'application/json' } }; }

(async () => {
  try { await fsp.rm(ROOT, { recursive: true, force: true }); } catch (_) {}

  // ---- A. parseImageFromResponse / dataUrlToBuffer pure helpers ----
  const T0 = makeImageTools({ openrouter: { apiKey: 'k' }, fsp, pathMod: path, root: ROOT, fetchImpl: async () => jsonResp({}) });
  A.eq(T0._internals.parseImageFromResponse({ choices: [{ message: { images: [{ image_url: { url: DATA_URL } } ] } }] }), DATA_URL, 'parses images[].image_url.url');
  A.eq(T0._internals.parseImageFromResponse({ choices: [{ message: { content: [{ type: 'image_url', image_url: { url: DATA_URL } }] } }] }), DATA_URL, 'parses content[] image_url part fallback');
  A.eq(T0._internals.parseImageFromResponse({ choices: [{ message: { content: 'no image here' } }] }), '', 'no image -> empty string');
  const dec = T0._internals.dataUrlToBuffer(DATA_URL);
  A.eq(dec.mime, 'image/png', 'dataUrlToBuffer reads the mime');
  A.ok(dec.buffer.length > 0 && dec.buffer[0] === 0x89 && dec.buffer[1] === 0x50, 'dataUrlToBuffer decodes real PNG bytes (\\x89P…)');

  // ---- B. image_generate: posts modalities, decodes the data URL, saves a content-addressed file, emits deliverable ----
  const genFetch = stubFetch((url) => {
    if (url.indexOf('/chat/completions') >= 0) return jsonResp({ choices: [{ message: { content: 'here you go', images: [{ type: 'image_url', image_url: { url: DATA_URL } }] } }] });
    return jsonResp({}, 404);
  });
  const T1 = makeImageTools({ openrouter: { apiKey: 'sk-test' }, fsp, pathMod: path, root: ROOT, fetchImpl: genFetch });
  const emits = [];
  const ctx = { agentId: 'hero', room: 'office', emit: (n, p) => emits.push({ n, p }) };
  const g = await T1.generateTool.run({ prompt: 'a red cube' }, ctx);
  // request shape
  A.eq(genFetch.calls[0].body.modalities, ['image', 'text'], 'image_generate sends modalities:[image,text]');
  A.eq(genFetch.calls[0].body.model, 'google/gemini-2.5-flash-image', 'image_generate defaults to the image model');
  A.ok(genFetch.calls[0].init.headers.Authorization === 'Bearer sk-test', 'image_generate sends the BYOK key');
  // saved file
  const rel = (g.summary.match(/image → (\S+)/) || [])[1];
  A.ok(rel && rel.indexOf('images/gen-') === 0 && rel.endsWith('.png'), 'image_generate uses a content-addressed images/gen-*.png name');
  const onDisk = fssync.readFileSync(path.join(ROOT, 'hero', rel));
  A.ok(onDisk[0] === 0x89 && onDisk[1] === 0x50, 'the saved PNG matches the decoded bytes');
  A.ok(g.content.indexOf('/api/file?agent=hero&path=') >= 0, 'image_generate returns the /api/file viewer URL');
  A.ok(emits.some(e => e.n === 'deliverable' && e.p.kind === 'image' && e.p.agentId === 'hero'), 'image_generate emits a deliverable event');

  // ---- B2. custom output path + content-addressed idempotency (same bytes -> same default name) ----
  const g2 = await T1.generateTool.run({ prompt: 'x', path: 'art/cube' }, ctx);
  A.ok(g2.summary.indexOf('art/cube.png') >= 0, 'image_generate appends .png to an extensionless custom path');
  const g3 = await T1.generateTool.run({ prompt: 'y' }, ctx);
  A.eq((g3.summary.match(/image → (\S+)/) || [])[1], rel, 'identical image bytes -> identical content-addressed name (idempotent)');

  // ---- C. image_generate errors when the model returns no image ----
  const noImgFetch = stubFetch(() => jsonResp({ choices: [{ message: { content: 'I cannot do that' } }] }));
  const T2 = makeImageTools({ openrouter: { apiKey: 'sk' }, fsp, pathMod: path, root: ROOT, fetchImpl: noImgFetch });
  let threw = false; try { await T2.generateTool.run({ prompt: 'z' }, ctx); } catch (e) { threw = /no image/.test(e.message); }
  A.ok(threw, 'image_generate throws a clear error when no image comes back');

  // ---- D. image_analyze: reads a workspace file, sends text-then-image_url parts, returns model text ----
  const anFetch = stubFetch(() => jsonResp({ choices: [{ message: { content: 'A small red cube on white.' } }] }));
  const T3 = makeImageTools({ openrouter: { apiKey: 'sk' }, fsp, pathMod: path, root: ROOT, fetchImpl: anFetch });
  const a = await T3.analyzeTool.run({ image: rel, prompt: 'what is this?' }, ctx);   // rel was saved under hero/ above
  A.ok(/red cube/i.test(a.content), 'image_analyze returns the vision model text');
  const parts = anFetch.calls[0].body.messages[0].content;
  A.eq(parts[0].type, 'text', 'analyze sends the text part first');
  A.eq(parts[1].type, 'image_url', 'analyze sends an image_url part second');
  A.ok(parts[1].image_url.url.indexOf('data:image/png;base64,') === 0, 'analyze base64-encodes the workspace image into a data URL');

  // ---- E. image_analyze passes an http(s) URL straight through (no file read) ----
  const a2 = await T3.analyzeTool.run({ image: 'https://example.com/cat.jpg' }, ctx);
  A.ok(/red cube/i.test(a2.content), 'image_analyze works with a public URL');
  A.eq(anFetch.calls[1].body.messages[0].content[1].image_url.url, 'https://example.com/cat.jpg', 'a public URL is passed through unchanged');

  // ---- F. jail escape on analyze path is refused ----
  let escaped = false; try { await T3.analyzeTool.run({ image: '../secrets.txt' }, ctx); } catch (e) { escaped = /illegal path|escapes|no such file/i.test(e.message); }
  A.ok(escaped, 'image_analyze refuses a path that escapes the workspace');

  // ---- G. no API key -> clean, actionable error ----
  const T4 = makeImageTools({ openrouter: { apiKey: '' }, fsp, pathMod: path, root: ROOT, fetchImpl: async () => jsonResp({}) });
  let noKey = false; try { await T4.generateTool.run({ prompt: 'q' }, ctx); } catch (e) { noKey = /API key/i.test(e.message); }
  A.ok(noKey, 'image_generate errors helpfully when no OpenRouter key is configured');

  try { await fsp.rm(ROOT, { recursive: true, force: true }); } catch (_) {}
  A.report('image.test');
})().catch(e => { console.log('FATAL', e && e.stack || e); process.exit(1); });
