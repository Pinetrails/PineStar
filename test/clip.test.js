/* node test/clip.test.js — the pure CLIP overlay reducer + the vendored GIF89a encoder (frontend/app/clip.js).
   Locks the G5-slice-2 spectacle honesty contract for the shareable ~10s run GIF:
     • EVERY number burned into the overlay is a fold of REAL run telemetry the frontend already holds, and any
       stat with no provable value is OMITTED — never faked (identical gate to the postcard, minus growth).
     • There is DELIBERATELY NO per-run XP delta on a clip: XP mints only from user feedback, so a run's XP change
       is unknowable at clip time — the reducer must never expose one. (Asserted structurally.)
     • the CLIP self-stamp (seconds/frames) reflects the REAL captured recording, never a claimed round number.
   Plus a headless GIF-encoder roundtrip: buildPalette + lzwEncode + writeGif are pure array math (no DOM), so we
   can assemble a real GIF89a byte stream from synthetic indexed frames and assert its structural validity.
   Pure + deterministic — no DOM/canvas/clock is touched by assemble() or the encoder primitives under test. */
'use strict';
const A = require('./_assert.js');
const C = require('../frontend/app/clip.js');

/* ---------- a clean run with real spend/tokens/artifacts renders every honest chip ---------- */
{
  const run = { reason: 'done', title: 'summarise the Q3 deck', artifacts: [{ path: 'out.md' }, { path: 'a.png' }], usd: 0.042, model: 'anthropic/claude', tokens: 12500 };
  const card = C.assemble({ run, durMs: 95000, agent: { name: 'Ultron' }, clip: { seconds: 10.2, fps: 10, frames: 101 } });
  A.eq(card.done, true, 'a done run is done');
  A.eq(card.outcome, 'DELIVERED', 'the outcome headline is DELIVERED');
  A.eq(card.agentName, 'Ultron', 'the agent name is carried');
  A.eq(card.title, 'summarise the Q3 deck', 'the real directive title is on the overlay');
  A.ok(card.chips.indexOf('2 artifacts') !== -1, '2 real artifacts → a chip');
  A.ok(card.chips.some(c => /1m/.test(c)), '95s duration renders as a minute chip');
  A.ok(card.chips.indexOf('$0.04') !== -1, 'the real reconciled cost shows');
  A.ok(card.chips.indexOf('13k tok') !== -1, 'the real token count shows (k-formatted, 0dp at/above 10k)');
  A.ok(card.chips.indexOf('anthropic/claude') !== -1, 'the real model shows');
}

/* ---------- NO XP delta ever — a clip carries NO growth ladder (that lives on the still postcard) ---------- */
{
  const run = { reason: 'done', title: 't', artifacts: [{ path: 'x' }], usd: 0.01, model: 'm', tokens: 100 };
  const card = C.assemble({ run, durMs: 5000, agent: { name: 'A', stats: { anything: 1 } }, clip: { seconds: 5, fps: 10, frames: 50 } });
  A.eq(card.growth, undefined, 'a clip overlay has NO growth block (XP is unknowable at clip time)');
  A.eq(card.station, undefined, 'a clip overlay has NO station record (that is the postcard surface)');
  A.ok(!JSON.stringify(card).match(/xp/i), 'nothing in the clip model references XP at all');
}

/* ---------- HONESTY: a free/unpriced run shows NO "$0"; an abnormal end reads honestly ---------- */
{
  const run = { reason: 'max_iters', title: 'endless loop', artifacts: [], usd: 0, model: '(unknown)' };
  const card = C.assemble({ run, durMs: 0, agent: { name: 'X' }, clip: { seconds: 8, fps: 10, frames: 80 } });
  A.eq(card.done, false, 'a max_iters run is not done');
  A.eq(card.outcome, 'ENDED · MAX_ITERS', 'the honest non-done outcome');
  A.ok(!card.chips.some(c => /\$/.test(c)), 'a $0 run shows NO fake cost chip');
  A.ok(!card.chips.some(c => /tok/.test(c)), 'no tokens → no token chip');
  A.ok(card.chips.indexOf('(unknown)') === -1, 'the "(unknown)" model sentinel is suppressed');
  A.eq(card.chips.length, 0, 'nothing provable → an empty chip row, not fabricated filler');
}

/* ---------- a subscription (unmetered) run reads "subscription", never $0 ---------- */
{
  const run = { reason: 'done', title: 't', artifacts: [{ path: 'x' }], usd: 0, unmetered: true, model: 'm', tokens: 400 };
  const card = C.assemble({ run, durMs: 5000, agent: { name: 'A' }, clip: { seconds: 5, fps: 10, frames: 50 } });
  A.ok(card.chips.indexOf('subscription') !== -1, 'an unmetered run labels its spend "subscription"');
  A.ok(!card.chips.some(c => /\$/.test(c)), 'and shows no dollar figure');
  A.ok(card.chips.indexOf('1 artifact') !== -1, 'a single artifact is singular');
  A.ok(card.chips.indexOf('400 tok') !== -1, 'a sub-1k token count shows raw');
}

/* ---------- the CLIP self-stamp reflects the REAL recording (seconds/frames), or is omitted when unknown ---------- */
{
  const run = { reason: 'done', title: 't', artifacts: [{ path: 'x' }] };
  const card = C.assemble({ run, durMs: 1000, agent: { name: 'A' }, clip: { seconds: 10.24, fps: 10, frames: 103 } });
  A.ok(!!card.capture, 'a real capture yields a self-stamp block');
  A.eq(card.capture.frames, 103, 'the REAL captured frame count is carried (never a claimed round number)');
  A.eq(card.capture.seconds, 10.2, 'the real span is shown to 1dp');
  A.eq(card.capture.fps, 10, 'the real fps is carried');
}
{
  // no capture facts (e.g. an empty ring) → no self-stamp, never a fabricated "0s"
  const card = C.assemble({ run: { reason: 'done', artifacts: [{ path: 'x' }] }, durMs: 1000, agent: { name: 'A' }, clip: { seconds: 0, fps: 0, frames: 0 } });
  A.eq(card.capture, null, 'an empty/absent capture shows NO fabricated clip stamp');
}

/* ---------- a monster directive title is clamped so it can't blow out the overlay ---------- */
{
  const long = 'x'.repeat(200);
  const card = C.assemble({ run: { reason: 'done', title: long, artifacts: [{ path: 'x' }] }, durMs: 1, agent: { name: 'A' }, clip: { seconds: 5, fps: 10, frames: 50 } });
  A.ok(card.title.length <= 57, 'the title is clamped (<= 56 + ellipsis)');
  A.ok(/…$/.test(card.title), 'a clamped title ends with an ellipsis');
}

/* ---------- formatters: cost + duration are honest ---------- */
{
  A.eq(C._fmt.usd(0), '', 'zero cost formats to empty (no fake $0)');
  A.eq(C._fmt.usd(0.5), '$0.50', 'a normal cost formats to 2dp');
  A.eq(C._fmt.ms(0), '', 'zero duration formats to empty');
  A.eq(C._fmt.ms(45000), '45s', 'under a minute → seconds');
  A.ok(/2m/.test(C._fmt.ms(125000)), 'over a minute → minutes');
}

/* ================= the vendored GIF89a encoder — headless (pure array math, no DOM) ================= */

/* ---------- buildPalette reduces a pixel union to a bounded palette of real colours ---------- */
{
  // two synthetic frames' worth of RGBA: half black, half a phosphor amber
  const mk = (r, g, b, n) => { const a = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i++) { a[i*4]=r; a[i*4+1]=g; a[i*4+2]=b; a[i*4+3]=255; } return a; };
  const f1 = mk(0, 0, 0, 200), f2 = mk(255, 170, 51, 200);
  const pal = C.buildPalette([f1, f2], 256);
  A.ok(Array.isArray(pal) && pal.length >= 2, 'a palette with at least the two present colours is built');
  A.ok(pal.length <= 256, 'the palette never exceeds 256 colours');
  A.ok(pal.every(c => Array.isArray(c) && c.length === 3 && c.every(v => v >= 0 && v <= 255)), 'every palette entry is a valid RGB triple');
  // the mapper must resolve a present colour to an exact (or near) match
  const map = C.makeMapper(pal);
  const iBlack = map(0, 0, 0), iAmber = map(255, 170, 51);
  A.ok(iBlack !== iAmber, 'distinct input colours map to distinct palette indices');
}

/* ---------- lzwEncode + writeGif produce a structurally valid GIF89a byte stream ---------- */
{
  const W = 4, H = 4, N = W * H;
  const pal = [[0, 0, 0], [255, 170, 51]];       // 2-colour palette
  // two 4x4 indexed frames (checkerboard + inverse) — real index arrays
  const fa = new Uint8Array(N), fb = new Uint8Array(N);
  for (let i = 0; i < N; i++) { fa[i] = (i % 2); fb[i] = (i % 2) ? 0 : 1; }
  const gif = C.writeGif(W, H, pal, [fa, fb], 10, 0);
  A.ok(gif instanceof Uint8Array && gif.length > 20, 'writeGif returns a non-trivial byte stream');
  // GIF89a header magic
  const hdr = String.fromCharCode(gif[0], gif[1], gif[2], gif[3], gif[4], gif[5]);
  A.eq(hdr, 'GIF89a', 'the stream begins with the GIF89a signature');
  // logical screen dimensions little-endian
  A.eq(gif[6] | (gif[7] << 8), W, 'the logical screen width is written LE');
  A.eq(gif[8] | (gif[9] << 8), H, 'the logical screen height is written LE');
  // trailer byte
  A.eq(gif[gif.length - 1], 0x3b, 'the stream ends with the 0x3B GIF trailer');
  // NETSCAPE looping extension present (0x21 0xFF ... "NETSCAPE2.0")
  const asStr = Array.from(gif).map(b => String.fromCharCode(b)).join('');
  A.ok(asStr.indexOf('NETSCAPE2.0') !== -1, 'the NETSCAPE2.0 looping extension is embedded (an animated, looping GIF)');
  // two Graphic Control Extension blocks (0x21 0xF9) → two frames
  let gce = 0; for (let i = 0; i < gif.length - 1; i++) { if (gif[i] === 0x21 && gif[i+1] === 0xf9) gce++; }
  A.eq(gce, 2, 'two frames → two Graphic Control Extension blocks');
}

/* ---------- lzwEncode is self-consistent for a trivial all-same-index stream ---------- */
{
  const idx = new Uint8Array(16).fill(1);
  const out = C.lzwEncode(2, idx);   // minCodeSize 2 → clearCode 4
  A.ok(Array.isArray(out) && out.length > 0, 'lzwEncode yields a non-empty byte array');
  A.ok(out.every(b => b >= 0 && b <= 255), 'every emitted LZW byte is a real octet');
}

A.report('clip');
