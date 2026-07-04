/* STARNET — clip.js : the SHAREABLE CLIP engine (Game session, Phase G5 / Spectacle slice 2, T4.11/P2.2).

   The station's second shareable surface, the moving sibling of the still POSTCARD (postcard.js). During a
   run's active beat a bounded RING BUFFER quietly samples the live #stage canvas at a capped fps; when the run
   completes the Commander can mint the LAST ~10 SECONDS of the floor into a small animated GIF — the CRT scene
   in motion under an honest run-summary overlay — and drag/save it anywhere. GIFs drag into any chat/DM with no
   codec worries, so the format is chosen for shareability over quality (a webm path is a later stretch).

   HONESTY RULES (truthful telemetry — the product's core promise, same law as the postcard):
     • Every number burned into the overlay is a fold of REAL run telemetry the frontend already holds:
         the run OUTCOME (reason/title/artifacts/cost/duration/model/tokens) from the recorded /api/runs entry
         the recap card consumes — the sidecar's append-only artifacts ledger.
     • There is deliberately NO per-run XP delta on a clip: XP mints ONLY from the user's feedback verdict, so a
       run's XP change is not knowable at clip time — showing one would be a fabricated number. Omitted, always.
     • A stat with no provable value is OMITTED, never faked: a free run shows no "$0", an unknown model is dropped.
     • The frames are the LIVE #stage pixels captured over real wall-clock — a real recording, not a mockup.

   assemble() is PURE (no DOM/clock/canvas) so the overlay contract is node-testable, mirroring postcard.assemble.
   The RECORDER + GIF encoder are the browser half (guarded so the reducer still loads + tests under node):
     • Recorder samples #stage on its OWN setInterval at capFps into a fixed-length ring of downscaled frames —
       it is fully decoupled from world.js's rAF loop (no second rAF, no per-frame tap), so the render loop is
       never touched. The ring is memory-bounded: it holds at most capFps*seconds frames and overwrites oldest.
     • encodeGif() is a small vendored GIF89a writer (median-cut palette + LZW) — in-page, NO network, no service.

   NEVER emits on U.bus (the frozen shared/events.js contract is owned elsewhere; lint-emits stays green).
   A `Clip` global in the browser, module.exports under node — the pure reducer + encoder are headless-testable. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Clip = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const str = v => (v == null ? '' : String(v));
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
  const posNum = v => Math.max(0, num(v));

  function brief(s, max) {
    s = str(s).replace(/\s+/g, ' ').trim();
    max = max || 64;
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function fmtUsd(v) {
    v = num(v);
    if (v <= 0) return '';
    if (v < 0.01) return '$' + v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return '$' + v.toFixed(2);
  }
  function fmtMs(ms) {
    ms = posNum(ms);
    if (ms <= 0) return '';
    const s = Math.round(ms / 1000);
    if (s <= 0) return '';
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return r ? m + 'm ' + r + 's' : m + 'm';
    const h = Math.floor(m / 60), rm = m % 60;
    return rm ? h + 'h ' + rm + 'm' : h + 'h';
  }

  /* THE PURE REDUCER — decide EXACTLY what the clip overlay shows, from real inputs only. NO XP delta ever.
     input:
       run   — the recorded run entry (recap shape): { reason, title, artifacts[], usd, unmetered, model, tokens }
       durMs — the run's real wall-clock duration (ms)
       agent — { name } — only the name; a clip carries NO growth ladder (that lives on the still postcard)
       clip  — { seconds, fps, frames } — the REAL captured-clip facts (its own honest length/rate), optional
     Returns a render-agnostic overlay model; fields present ONLY when honestly known. Exported + unit-tested. */
  function assemble(input) {
    input = input || {};
    const run = input.run || {};
    const agent = input.agent || {};
    const clip = input.clip || {};

    const reason = str(run.reason) || 'done';
    const done = reason === 'done';
    const arts = Array.isArray(run.artifacts) ? run.artifacts : [];

    const card = {
      agentName: brief(str(agent.name) || 'AGENT', 28),
      done: done,
      outcome: done ? 'DELIVERED' : ('ENDED · ' + reason.toUpperCase()),
      title: brief(str(run.title), 56),
    };

    // RUN META chips — each included ONLY when it has a real value (identical honesty gate to the postcard).
    const chips = [];
    if (arts.length > 0) chips.push(arts.length + (arts.length === 1 ? ' artifact' : ' artifacts'));
    const dur = fmtMs(input.durMs);
    if (dur) chips.push(dur);
    const toks = posNum(run.tokens);
    if (toks > 0) chips.push((toks >= 1000 ? (toks / 1000).toFixed(toks >= 10000 ? 0 : 1) + 'k' : toks) + ' tok');
    if (run.unmetered) chips.push('subscription');
    else { const c = fmtUsd(run.usd); if (c) chips.push(c); }
    const model = str(run.model);
    if (model && model !== '(unknown)') chips.push(model);
    card.chips = chips;

    // CLIP self-description — the recording's OWN honest facts (how long / how many real frames). Only when real.
    let capture = null;
    const secs = posNum(clip.seconds), fps = posNum(clip.fps), frames = posNum(clip.frames);
    if (frames > 0 && secs > 0) {
      capture = {
        seconds: Math.round(secs * 10) / 10,
        fps: fps > 0 ? Math.round(fps) : 0,
        frames: Math.round(frames),
      };
    }
    card.capture = capture;

    return card;
  }

  // ---------- the browser half: RING-BUFFER recorder + per-frame overlay composite + vendored GIF89a encoder ----------
  // (all guarded so the module still loads + the reducer still tests under node, where there is no DOM/canvas.)

  const CLIP_W = 480, CLIP_H = 300;   // a compact 16:10 share tile — small on purpose (GIF weight, drag-anywhere)
  const DEFAULT_FPS = 10;             // 8–12fps target; 10 = smooth-enough motion at a sane frame count
  const DEFAULT_SECONDS = 10;         // "the last ~10 seconds"

  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return (v && v.trim()) || fallback;
    } catch (_) { return fallback; }
  }

  function phosphorText(ctx, text, x, y, size, color, glow, align) {
    ctx.save();
    ctx.font = size + 'px VT323, monospace';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = Math.max(3, size * 0.28); }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /* THE RECORDER — a fixed-length ring of downscaled #stage frames, sampled on its OWN interval. Decoupled from
     the world rAF loop (never taps it), so arming never tanks the render loop. Memory-bounded: at most cap frames.
     Usage: r = Clip.recorder({fps,seconds,source}); r.arm(); … r.disarm(); r.frames() → [{canvas,t}, …] oldest→newest. */
  function recorder(opts) {
    opts = opts || {};
    const fps = Math.max(4, Math.min(15, posNum(opts.fps) || DEFAULT_FPS));
    const seconds = Math.max(3, Math.min(20, posNum(opts.seconds) || DEFAULT_SECONDS));
    const cap = Math.ceil(fps * seconds);
    const src = () => (opts.source ? opts.source() : (typeof document !== 'undefined' ? document.getElementById('stage') : null));
    let ring = [];           // [{canvas, t}] — small offscreen canvases, oldest first once full
    let timer = 0;
    let armed = false;

    // one sample: draw the live #stage (downscaled) into a fresh small canvas, push, evict oldest past cap.
    function sample() {
      const scene = src();
      if (!scene || !scene.width || !scene.height) return;
      let c;
      if (ring.length >= cap) { c = ring.shift().canvas; }   // reuse the evicted canvas — no per-frame alloc churn
      else { c = document.createElement('canvas'); c.width = CLIP_W; c.height = CLIP_H; }
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = true;
      // cover-fit the scene into the tile
      const sr = scene.width / scene.height, dr = CLIP_W / CLIP_H;
      let sw, sh, sx, sy;
      if (sr > dr) { sh = scene.height; sw = Math.round(sh * dr); sx = Math.round((scene.width - sw) / 2); sy = 0; }
      else { sw = scene.width; sh = Math.round(sw / dr); sx = 0; sy = Math.round((scene.height - sh) / 2); }
      try { cx.drawImage(scene, sx, sy, sw, sh, 0, 0, CLIP_W, CLIP_H); }
      catch (_) { cx.fillStyle = '#0a0602'; cx.fillRect(0, 0, CLIP_W, CLIP_H); }
      ring.push({ canvas: c, t: Date.now() });
    }

    return {
      arm() {
        if (armed || typeof document === 'undefined') return;
        armed = true; ring = [];
        sample();                                  // grab an immediate first frame
        timer = setInterval(sample, Math.round(1000 / fps));
      },
      disarm() { if (timer) { clearInterval(timer); timer = 0; } armed = false; },
      armed() { return armed; },
      frames() { return ring.slice(); },           // shallow copy, oldest → newest
      fps() { return fps; },
      seconds() { return seconds; },
      cap() { return cap; },
      clear() { ring = []; },
    };
  }

  // paint the honest overlay (VT323 + phosphor glow, same grade as the postcard) onto ONE clip frame canvas.
  // Every frame gets the identical overlay so the burned-in numbers are stable across the GIF.
  function overlayFrame(ctx, card) {
    const ph = cssVar('--ph', '#ffaa33').trim();
    const phBright = cssVar('--ph-bright', '#ffd9a3').trim();
    const phDim = cssVar('--ph-dim', '#b9791c').trim();
    const gold = cssVar('--gold', '#ffd34a').trim();
    const glow = cssVar('--ph-glow', 'rgba(255,170,51,0.5)').trim();

    // scanline veil (baked CRT grade)
    ctx.save();
    ctx.globalAlpha = 0.10; ctx.fillStyle = '#000';
    for (let y = 0; y < CLIP_H; y += 3) ctx.fillRect(0, y, CLIP_W, 1);
    ctx.globalAlpha = 1; ctx.restore();

    // top masthead scrim + wordmark
    const topGrad = ctx.createLinearGradient(0, 0, 0, 42);
    topGrad.addColorStop(0, 'rgba(5,3,1,0.85)'); topGrad.addColorStop(1, 'rgba(5,3,1,0)');
    ctx.fillStyle = topGrad; ctx.fillRect(0, 0, CLIP_W, 42);
    phosphorText(ctx, 'STARNET', 14, 26, 22, phBright, glow, 'left');
    phosphorText(ctx, '// LIVE FLOOR', CLIP_W - 14, 24, 14, phDim, '', 'right');

    // bottom info scrim
    const botGrad = ctx.createLinearGradient(0, CLIP_H - 78, 0, CLIP_H);
    botGrad.addColorStop(0, 'rgba(5,3,1,0)'); botGrad.addColorStop(1, 'rgba(5,3,1,0.95)');
    ctx.fillStyle = botGrad; ctx.fillRect(0, CLIP_H - 78, CLIP_W, 78);

    // outcome headline + agent
    phosphorText(ctx, card.agentName.toUpperCase(), 14, CLIP_H - 46, 22, phBright, glow, 'left');
    phosphorText(ctx, card.outcome, CLIP_W - 14, CLIP_H - 46, 18, card.done ? gold : phDim, card.done ? glow : '', 'right');
    // title
    if (card.title) phosphorText(ctx, '“' + card.title + '”', 14, CLIP_H - 26, 15, ph, '', 'left');
    // chips row
    if (card.chips && card.chips.length) phosphorText(ctx, card.chips.join('  ·  '), 14, CLIP_H - 8, 14, phDim, '', 'left');
    // clip self-stamp (honest length/frames) bottom-right — reads "10.0s · 100f"
    if (card.capture) {
      const cap = card.capture;
      const stamp = cap.seconds + 's' + (cap.frames ? ' · ' + cap.frames + 'f' : '');
      phosphorText(ctx, stamp, CLIP_W - 14, CLIP_H - 8, 14, phDim, '', 'right');
    }

    // thin bezel
    ctx.strokeStyle = phDim; ctx.lineWidth = 2; ctx.strokeRect(2, 2, CLIP_W - 4, CLIP_H - 4);
  }

  // composite ONE recorded frame (scene canvas) + the overlay into a fresh RGBA ImageData-source canvas.
  function composeFrame(sceneCanvas, card) {
    const c = document.createElement('canvas'); c.width = CLIP_W; c.height = CLIP_H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#050301'; ctx.fillRect(0, 0, CLIP_W, CLIP_H);
    if (sceneCanvas) { try { ctx.drawImage(sceneCanvas, 0, 0, CLIP_W, CLIP_H); } catch (_) {} }
    overlayFrame(ctx, card);
    return c;
  }

  /* ---------------- vendored GIF89a encoder (in-page, no network) ----------------
     A compact animated-GIF writer: a single shared 256-colour palette (median-cut over a sample of all frames),
     then LZW-compressed indexed frames with a per-frame delay. Sized for small clips (≤~200 frames @480×300).
     This is intentionally minimal — good-enough share quality, not a codec — matching the "shareability > quality"
     locked decision. No external dependency; the whole thing is a few hundred lines of pure array math. */

  // ---- median-cut quantizer: reduce the union of frame pixels to a 256-colour palette ----
  function buildPalette(framesRGBA, maxColors) {
    maxColors = maxColors || 256;
    // gather a subsampled pixel set (every Nth pixel across all frames) to keep the cut cheap + representative
    const pts = [];
    const stride = 4 * 7;   // sample ~1/7 of pixels
    for (const data of framesRGBA) {
      for (let i = 0; i < data.length; i += stride) {
        pts.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
    if (!pts.length) return [[0, 0, 0]];

    function box(points) {
      let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
      for (const p of points) {
        if (p[0] < rmin) rmin = p[0]; if (p[0] > rmax) rmax = p[0];
        if (p[1] < gmin) gmin = p[1]; if (p[1] > gmax) gmax = p[1];
        if (p[2] < bmin) bmin = p[2]; if (p[2] > bmax) bmax = p[2];
      }
      return { points, rmin, rmax, gmin, gmax, bmin, bmax,
        r: rmax - rmin, g: gmax - gmin, b: bmax - bmin };
    }
    let boxes = [box(pts)];
    while (boxes.length < maxColors) {
      // split the box with the largest single-channel range
      let bi = -1, best = -1;
      for (let i = 0; i < boxes.length; i++) {
        const bx = boxes[i];
        const r = Math.max(bx.r, bx.g, bx.b);
        if (r > best && bx.points.length > 1) { best = r; bi = i; }
      }
      if (bi < 0) break;
      const bx = boxes[bi];
      const ch = (bx.r >= bx.g && bx.r >= bx.b) ? 0 : (bx.g >= bx.b ? 1 : 2);
      bx.points.sort((a, b) => a[ch] - b[ch]);
      const mid = bx.points.length >> 1;
      const a = bx.points.slice(0, mid), b2 = bx.points.slice(mid);
      if (!a.length || !b2.length) break;
      boxes.splice(bi, 1, box(a), box(b2));
    }
    // average each box to its palette colour
    return boxes.map(bx => {
      let r = 0, g = 0, b = 0; const n = bx.points.length || 1;
      for (const p of bx.points) { r += p[0]; g += p[1]; b += p[2]; }
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });
  }

  // nearest-palette lookup with a small cache (packed-rgb → index) so mapping frames is fast.
  function makeMapper(palette) {
    const cache = new Map();
    return function nearest(r, g, b) {
      const key = (r << 16) | (g << 8) | b;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      let bi = 0, bd = Infinity;
      for (let i = 0; i < palette.length; i++) {
        const p = palette[i];
        const dr = r - p[0], dg = g - p[1], db = b - p[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; bi = i; if (d === 0) break; }
      }
      cache.set(key, bi);
      return bi;
    };
  }

  // ---- LZW (GIF variant) compressor over an index stream ----
  function lzwEncode(minCodeSize, indices) {
    const out = [];
    let cur = 0, curBits = 0;
    function emit(code, size) {
      cur |= code << curBits; curBits += size;
      while (curBits >= 8) { out.push(cur & 0xff); cur >>= 8; curBits -= 8; }
    }
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let dict = new Map();
    function resetDict() {
      dict = new Map();
      for (let i = 0; i < clearCode; i++) dict.set(String.fromCharCode(i), i);
      codeSize = minCodeSize + 1;
    }
    resetDict();
    emit(clearCode, codeSize);
    let next = eoiCode + 1;
    let prefix = String.fromCharCode(indices[0]);
    for (let i = 1; i < indices.length; i++) {
      const k = String.fromCharCode(indices[i]);
      const combo = prefix + k;
      if (dict.has(combo)) { prefix = combo; }
      else {
        emit(dict.get(prefix), codeSize);
        dict.set(combo, next++);
        if (next > (1 << codeSize) && codeSize < 12) codeSize++;
        if (next > 4095) { emit(clearCode, codeSize); resetDict(); next = eoiCode + 1; }
        prefix = k;
      }
    }
    emit(dict.get(prefix), codeSize);
    emit(eoiCode, codeSize);
    if (curBits > 0) out.push(cur & 0xff);
    return out;
  }

  // pack a byte array into GIF sub-blocks (max 255 bytes each), terminated by a 0-length block.
  function subBlockify(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i += 255) {
      const chunk = bytes.slice(i, i + 255);
      out.push(chunk.length);
      for (const b of chunk) out.push(b);
    }
    out.push(0);
    return out;
  }

  // ---- assemble a full GIF89a from indexed frames + a shared global palette ----
  function writeGif(width, height, palette, indexedFrames, delayCs, loop) {
    const bytes = [];
    const put = b => bytes.push(b & 0xff);
    const putStr = s => { for (let i = 0; i < s.length; i++) put(s.charCodeAt(i)); };
    const put16 = n => { put(n & 0xff); put((n >> 8) & 0xff); };

    // palette must be a power-of-two size; pad to next pow2 up to 256
    let gctSize = 2; let bits = 1;
    while (gctSize < palette.length) { gctSize <<= 1; bits++; }
    if (gctSize > 256) { gctSize = 256; bits = 8; }

    putStr('GIF89a');
    put16(width); put16(height);
    put(0x80 | ((bits - 1) << 4) | (bits - 1));   // global colour table, colour resolution, size
    put(0);   // background colour index
    put(0);   // pixel aspect ratio
    // global colour table
    for (let i = 0; i < gctSize; i++) {
      const c = palette[i] || [0, 0, 0];
      put(c[0]); put(c[1]); put(c[2]);
    }
    // NETSCAPE looping extension
    put(0x21); put(0xff); put(11);
    putStr('NETSCAPE2.0');
    put(3); put(1); put16(loop == null ? 0 : loop); put(0);

    const minCode = Math.max(2, bits);
    for (const idx of indexedFrames) {
      // graphic control extension (delay + no transparency)
      put(0x21); put(0xf9); put(4);
      put(0x00);            // no disposal, no transparency
      put16(delayCs);       // delay in hundredths of a second
      put(0); put(0);
      // image descriptor
      put(0x2c);
      put16(0); put16(0); put16(width); put16(height);
      put(0);               // no local colour table
      put(minCode);
      const lzw = lzwEncode(minCode, idx);
      const blocks = subBlockify(lzw);
      for (const b of blocks) put(b);
    }
    put(0x3b);   // trailer
    return new Uint8Array(bytes);
  }

  /* encode composed RGBA frames → a GIF Uint8Array. frames = [canvas,…] (already CLIP_W×CLIP_H with overlay).
     Builds one shared palette across all frames, maps each to indices, writes the GIF89a. Pure array math. */
  function encodeGif(canvasFrames, opts) {
    opts = opts || {};
    const fps = Math.max(4, Math.min(15, posNum(opts.fps) || DEFAULT_FPS));
    const delayCs = Math.max(2, Math.round(100 / fps));   // GIF delay is in 1/100s; clamp to a legal minimum
    const rgbaFrames = [];
    for (const c of canvasFrames) {
      const ctx = c.getContext('2d');
      rgbaFrames.push(ctx.getImageData(0, 0, CLIP_W, CLIP_H).data);
    }
    const palette = buildPalette(rgbaFrames, 256);
    const mapper = makeMapper(palette);
    const indexed = [];
    for (const data of rgbaFrames) {
      const idx = new Uint8Array(CLIP_W * CLIP_H);
      for (let p = 0, i = 0; i < data.length; i += 4, p++) {
        idx[p] = mapper(data[i], data[i + 1], data[i + 2]);
      }
      indexed.push(idx);
    }
    return writeGif(CLIP_W, CLIP_H, palette, indexed, delayCs, 0);
  }

  function filename(card) {
    const nm = str(card && card.agentName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
    const stamp = new Date().toISOString().slice(0, 10);
    return 'starnet-' + nm + '-' + stamp + '.gif';
  }

  function download(blob, name) {
    if (typeof document === 'undefined' || !blob) return;
    let url = null;
    try {
      url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name || 'starnet-clip.gif';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally { if (url) setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 4000); }
  }

  /* THE ONE BROWSER ENTRYPOINT the app calls when the Commander mints a clip. Reads the recorder's captured
     frames, assembles the honest overlay from REAL telemetry, composites each frame + overlay, encodes the GIF,
     downloads it, and hands back the blob + facts. opts:
       { run, durMs, agent, recorder }  — recorder is a Clip.recorder() with frames already captured.
     Returns Promise<{ card, blob, name, frames, seconds, fps }>. Fail-loud to the caller (it owns the UX). */
  async function capture(opts) {
    opts = opts || {};
    const rec = opts.recorder;
    const raw = (rec && rec.frames) ? rec.frames() : [];
    if (!raw.length) throw new Error('no captured frames — recorder was never armed');
    const fps = (rec && rec.fps) ? rec.fps() : DEFAULT_FPS;
    // honest clip facts: real frame count + real span between first & last sample (never a claimed round number).
    const spanMs = raw.length > 1 ? (raw[raw.length - 1].t - raw[0].t) : (raw.length * (1000 / fps));
    const seconds = Math.max(0.1, spanMs / 1000);
    const card = assemble({
      run: opts.run, durMs: opts.durMs, agent: opts.agent,
      clip: { seconds: seconds, fps: fps, frames: raw.length },
    });
    const composed = raw.map(f => composeFrame(f.canvas, card));
    const gif = encodeGif(composed, { fps: fps });
    const blob = new Blob([gif], { type: 'image/gif' });
    const name = filename(card);
    download(blob, name);
    return { card, blob, name, frames: raw.length, seconds: Math.round(seconds * 10) / 10, fps: Math.round(fps) };
  }

  return {
    assemble, recorder, capture, encodeGif, composeFrame, overlayFrame, filename, download,
    buildPalette, makeMapper, lzwEncode, writeGif,
    CLIP_W, CLIP_H, DEFAULT_FPS, DEFAULT_SECONDS,
    _fmt: { usd: fmtUsd, ms: fmtMs },
  };
});
