/* node test/readbody.test.js — the sidecar's readBody() must decode a UTF-8 body ONCE at the end, so a
   multi-byte char split across two TCP chunks round-trips intact (the old `b += c` per-chunk toString
   mangled it into replacement chars). readBody is not exported from the server entry (index.js has no
   module.exports), so we EXTRACT its real source text and evaluate that exact function — testing the
   shipped code, not a copy. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// pull the real readBody() out of sidecar/index.js by its source signature.
const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
const m = src.match(/function readBody\(req, max(?:, res)?\) \{[\s\S]*?\n\}/);
A.ok(m, 'located the real readBody() source in sidecar/index.js');
// eslint-disable-next-line no-new-func
const readBody = new Function('Buffer', m[0] + '\nreturn readBody;')(Buffer);

// a mock req that emits the given Buffer chunks then 'end' (an EventEmitter is enough for readBody).
function mockReq(chunks) {
  const req = new EventEmitter();
  req.destroy = () => { req.destroyed = true; };
  process.nextTick(() => { for (const c of chunks) req.emit('data', c); req.emit('end'); });
  return req;
}

(async () => {
  // ---- 1. a 4-byte emoji SPLIT across two chunks round-trips intact ----
  {
    const full = Buffer.from('hi 😀 there', 'utf8');   // 😀 = F0 9F 98 80 (4 bytes)
    const at = full.indexOf(0xf0);                     // split in the MIDDLE of the emoji's bytes
    const a = full.slice(0, at + 2), b = full.slice(at + 2);   // 2 bytes of the emoji in each chunk
    A.ok(a[a.length - 1] >= 0x80, 'the split lands mid-multibyte-char (a real torn char)');
    const out = await readBody(mockReq([a, b]), 1 << 20);
    A.eq(out, 'hi 😀 there', 'a mid-char split still decodes to the intact emoji (no replacement chars)');
    A.eq(out.indexOf('�'), -1, 'no U+FFFD replacement character in the result');
  }

  // ---- 2. multiple multibyte chars (CJK) across many small chunks ----
  {
    const full = Buffer.from('日本語テスト', 'utf8');
    const chunks = [];
    for (let i = 0; i < full.length; i += 1) chunks.push(full.slice(i, i + 1));   // 1 byte per chunk (worst case)
    const out = await readBody(mockReq(chunks), 1 << 20);
    A.eq(out, '日本語テスト', 'CJK text split to single-byte chunks reassembles exactly');
  }

  // ---- 3. the byte cap still fires on an oversized body ----
  {
    let threw = null;
    try { await readBody(mockReq([Buffer.alloc(100), Buffer.alloc(100)]), 150); } catch (e) { threw = e; }
    A.ok(threw && /too large/.test(threw.message), 'the max-bytes cap still rejects an oversized body');
  }

  // ---- 4. a plain ASCII body is unaffected ----
  {
    const out = await readBody(mockReq([Buffer.from('{"a":1}')]), 1 << 20);
    A.eq(out, '{"a":1}', 'ASCII JSON body unchanged');
  }

  A.report('readbody');
})();
