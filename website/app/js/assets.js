/* STARNET — assets.js : PixelLab sprite loading + per-agent recoloring */
'use strict';

const SPRITES = (() => {
  let ready = false;
  const frames = {};   // key "minion.walk.south" -> [Image]
  const tinted = {};   // key "FORGE|minion.walk.south" -> [canvas]
  let meta = { minion: { fw: 0, fh: 0 }, ultron: { fw: 0, fh: 0 } };

  /* the crew base is a white space-suit astronaut with glowing CYAN visor eyes
     (~hue 190). the light suit is ~desaturated so hue-rotate barely shifts it;
     the saturated eyes are what recolor — so each agent's accent color lands on
     the eyes (their identity) while the suit stays a clean premium white. */
  function hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16);
    let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h = 0, s = 0; const l = (mx + mn) / 2;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (mx === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }
    return { h, s, l };
  }
  const BASE_HUE = 190, BASE_SAT = 0.80;
  function filterFor(agentId) {
    // Skins are natively-colored sprite sets, so there is no per-agent hue-rotate.
    // (An agent's `color` still drives its name-tag / UI accents — just not the sprite.)
    return '';
  }

  /* crew sprites are authored on a 92px master — far larger than their ~35px on-floor footprint.
     We DON'T pre-shrink here any more: the old nearest-neighbor crush to ~35px dropped most of the
     master's pixels and mushed every agent into a shapeless blob (the picker, which shows the full
     master, looked far better than the floor). Instead we cache frames at NATIVE resolution and apply
     the per-set downscale at DRAW time with smoothing ON (drawBody) — full detail survives onto the
     floor at the SAME size, and stays sharp when the camera zooms in.
     ultron keeps more of his source size so he towers over the crew. */
  const SCALE = { ultron: 0.60 };   // skins read their scale from DATA.SKINS; ULTRON is special
  function drawScaleFor(setName) {
    return SCALE[setName] || (DATA.SKINS[setName] && DATA.SKINS[setName].scale) || 2 / 3;
  }

  /* foot-line measurement — every PixelLab master leaves transparent padding BELOW the feet
     (the crew sets all sit ~23px up from the 92px canvas bottom). The contact shadow is drawn
     at the floor anchor (b.py), so if we anchored the IMAGE bottom there, that padding pushed
     the visible feet up off the shadow — and because the gap is `pad × scale`, the bigger skins
     (and ULTRON) floated worst. We measure the padding once per set from a STABLE idle frame
     (rot/blink/sit — never a walk frame, whose lifted foot would shift the body each stride) and
     anchor the FEET to the floor instead. Auto-derived so new skins self-correct. */
  const footPad = {};                 // set -> transparent rows below the feet, in master px
  const DEFAULT_FOOT = 23;            // crew authoring constant; only used if a frame can't be read
  function measureFootPad(img) {
    try {
      const w = img.width | 0, h = img.height | 0;
      if (!w || !h) return DEFAULT_FOOT;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      const data = x.getImageData(0, 0, w, h).data;
      for (let y = h - 1; y >= 0; y--) {
        const row = y * w * 4;
        for (let px = 0; px < w; px++) {
          if (data[row + px * 4 + 3] > 16) return (h - 1) - y;   // first opaque row from the bottom
        }
      }
      return DEFAULT_FOOT;
    } catch (e) { return DEFAULT_FOOT; }   // tainted/unreadable → safe fallback
  }
  function getFootPad(set) {
    if (footPad[set] != null) return footPad[set];
    let ref = null;
    for (const d of ['south', 'east', 'west', 'north']) {
      const fr = frames[set + '.rot.' + d] || frames[set + '.blink.' + d] || frames[set + '.sit.' + d];
      if (fr && fr[0]) { ref = fr[0]; break; }
    }
    if (!ref) {   // last resort: any frame of the set
      const k = Object.keys(frames).find(kk => kk.indexOf(set + '.') === 0);
      if (k && frames[k][0]) ref = frames[k][0];
    }
    return (footPad[set] = ref ? measureFootPad(ref) : DEFAULT_FOOT);
  }
  function tintFrames(agentId, key) {
    const ck = agentId + '|' + key;
    if (tinted[ck]) return tinted[ck];
    const src = frames[key];
    if (!src) return null;
    const filt = filterFor(agentId);
    tinted[ck] = src.map(img => {
      if (!filt) return img;   // no recolor (skins are natively colored) → use the master image directly, full res
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const x = c.getContext('2d');
      x.filter = filt;
      x.drawImage(img, 0, 0);
      return c;
    });
    return tinted[ck];
  }

  /* ---------- the contact shadow ----------
     A body used to stand on a 2px black bar: a sticker, not a shadow. It read as a little line
     under the feet and gave the crew no weight on the deck. This paints a real pooled shadow.

       shape   a foreshortened ellipse at the station's floor ratio (ry ~ 0.42*rx) — the SAME
               ratio world.js already uses for its ground cues (wake ripple, listening pulse,
               work ring), so every circle that claims to lie on the deck agrees.
       falloff nested ellipses penumbra->umbra instead of one flat blob. The alphas compound
               (1 - PI(1-a)) to ~0.43 at the contact core and 0.09 at the rim — a soft edge for
               no per-frame gradient object, which matters at ~10 bodies x 60fps. The core sits
               deliberately ABOVE propsprites' shadow2 (~0.34): that is a prop's edge contact,
               while this is a whole body standing on the deck, and the deck it has to read
               against is DARK — measured at 26/255 luma under the hero. At 0.34 the pool took
               6 luma off it (23%); a body needs to look planted, not stickered. Do not tune
               these by eye — `node dev/shadowprobe.mjs` measures the pool on the real deck.
       bias    nudged SOUTH-EAST. The station's key light is high and north-west; that is the
               light every prop already assumes (west-biased sheen, north-lit top faces).
       life    `lift` is how far the idle/talk bob has raised the body off the deck. The pool
               shrinks and fades with it, so a breathing body's shadow breathes too and a body
               that rises never drags a full-weight pool up with it.
       seated  a seated body's feet are on a cushion, not the deck — callers hand it a tighter,
               fainter pool rather than claim a full contact it doesn't have.

     Alpha is applied RELATIVE to the incoming ctx.globalAlpha and restored afterwards, so the
     hero's color-into-being fade-up (drawAgent's bornA) survives the shadow pass — the old code
     slammed globalAlpha back to 1 here and silently cancelled that fade for the sprite too. */
  const SHADOW_RINGS = [[1, 0.09], [0.80, 0.12], [0.58, 0.14], [0.34, 0.17]];
  const SHADOW_SQUASH = 0.42;        // floor foreshortening; matches world.js's ground ellipses
  function groundShadow(ctx, cx, cy, rx, opts) {
    const o = opts || {};
    const lift = Math.max(0, o.lift || 0);              // px the body has risen off the deck
    const k = 1 - Math.min(0.5, lift * 0.14);           // lifted => smaller AND fainter
    const spread = rx * k * (o.spread || 1);
    if (!(spread > 0.5)) return;
    const a0 = ctx.globalAlpha;
    const fade = k * (o.alpha != null ? o.alpha : 1);
    const dx = spread * 0.10, dy = spread * 0.04;       // south-east, under the high north-west key
    ctx.fillStyle = o.color || '#000';
    for (const r of SHADOW_RINGS) {
      ctx.globalAlpha = a0 * r[1] * fade;
      ctx.beginPath();
      ctx.ellipse(cx + dx, cy + dy, spread * r[0], spread * r[0] * SHADOW_SQUASH, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = a0;
  }

  /* pick best available animation key for a body state */
  function pick(set, names, dir) {
    for (const n of names) {
      const exact = set + '.' + n + '.' + dir;
      if (frames[exact]) return exact;
    }
    // fall back to any direction of first available name, then south rot
    for (const n of names) {
      for (const d of ['south', 'east', 'west', 'north']) {
        const k = set + '.' + n + '.' + d;
        if (frames[k]) return k;
      }
    }
    return frames[set + '.rot.south'] ? set + '.rot.south' : null;
  }

  /* ---------- 8-direction render facing ----------
     world.js keeps game-logic facing 4-valued (`b.dir`) — glance/sit/OPP/social all speak that
     vocabulary and must keep doing so. Smooth turning is a RENDER concern, so it lives here:
     each body carries a render-side facing angle that slews toward what the game wants (the
     continuous walk heading `b.faceA` while walking, the bucketed `dir` otherwise) at the SAME
     rate stepGait turns a walking body, then buckets into EIGHT sectors with hysteresis. A body
     turning 180° therefore walks its pose through the diagonal in ~2 steps instead of teleporting
     it, and a body that stops on a diagonal eases to its cardinal instead of popping.
     Sets that don't ship diagonal frames are untouched: pick8 falls straight back to the old
     4-dir pick on `b.dir`, so this is a no-op for every skin until its diagonals exist. */
  const DIR8_A = {
    east: 0, 'south-east': Math.PI / 4, south: Math.PI / 2, 'south-west': 3 * Math.PI / 4,
    west: Math.PI, 'north-west': -3 * Math.PI / 4, north: -Math.PI / 2, 'north-east': -Math.PI / 4
  };
  const RENDER_TURN_RATE = 12;   // rad/s — matches world.js TURN_RATE so walk turns and stand turns read alike
  const DIR8_HYST = 0.10;        // rad a sector holds past its boundary (sectors are π/8 half-width)
  const ang = a => Math.atan2(Math.sin(a), Math.cos(a));
  function renderDir8(b, dir, glancing, nowMs) {
    // while walking (and not glancing) follow the true continuous heading; otherwise the game dir
    const want = (!glancing && b.state === 'walk' && b.faceA != null) ? ang(b.faceA) : DIR8_A[dir];
    if (want == null) return dir;
    const dt = Math.max(0, Math.min(100, nowMs - (b._rAt || 0)));   // clamp: first frame / tab-restore must not spin
    b._rAt = nowMs;
    if (b._rA == null) b._rA = want;   // new body (or dossier portrait's fresh object): snap, no tween
    else {
      const turn = ang(want - b._rA), cap = RENDER_TURN_RATE * dt / 1000;
      b._rA = ang(Math.abs(turn) <= cap ? want : b._rA + Math.sign(turn) * cap);
    }
    const cur = b._rD8;
    if (cur && DIR8_A[cur] != null && Math.abs(ang(b._rA - DIR8_A[cur])) < Math.PI / 8 + DIR8_HYST) return cur;
    let best = dir, bd = Infinity;
    for (const d in DIR8_A) {
      const t = Math.abs(ang(b._rA - DIR8_A[d]));
      if (t < bd) { bd = t; best = d; }
    }
    return (b._rD8 = best);
  }
  /* prefer the 8-bucket direction when the set ships it, else the exact old 4-dir path */
  function pick8(set, names, dir8, dir) {
    if (dir8 !== dir) {
      for (const n of names) {
        const k = set + '.' + n + '.' + dir8;
        if (frames[k]) return k;
      }
    }
    return pick(set, names, dir);
  }

  /* main draw: foot-anchored at (x, y) */
  function drawBody(ctx, b, nowMs) {
    const set = b.id === 'ULTRON' ? 'ultron'
      : ((DATA.SKINS[b.skin] && DATA.SKINS[b.skin].set) || DATA.SKINS[DATA.DEFAULT_SKIN].set);
    const glancing = b.glance && b.glance.until > nowMs;   // brief look-up: overrides facing & typing
    const meeting = b.meet && b.meet.until > nowMs;        // hallway chat: stand still, face partner
    const dir = glancing ? b.glance.dir : (b.dir || 'south');
    // per-agent animation offset. Prefer the FLOAT `aph`: `phase` is an integer (world.js needs it as a
    // PHASES[] index for the mood engine), and a whole-frame offset ticks every body's cycle on the same
    // 100ms boundaries — the crew animated in lockstep. Bodies without `aph` (dossier portrait) fall back.
    const aph = (b.aph != null ? b.aph : (b.phase || 0));
    // 8-sector render facing — only locomotion + standing poses use it; seated/desk states keep
    // the plain 4-dir vocabulary (their frames are cardinal-only and their facing is furniture-set)
    const dir8 = renderDir8(b, dir, glancing, nowMs);
    let key = null, fps = 8, bob = 0;

    if (meeting) {
      key = pick8(set, ['rot'], dir8, dir); fps = 4;
    } else if (b.state === 'walk') {
      key = pick8(set, ['walk'], dir8, dir); fps = 10;
    } else if (b.working && !glancing) {
      key = pick(set, ['type', 'sit'], 'north') || pick(set, ['rot'], 'north'); fps = 6;
    } else if (b.state === 'social' && b.sitting) {
      // can in hand reads best from the front; otherwise face what you came for
      key = b.hasCan ? (pick(set, ['drink', 'sit'], 'south')) : pick(set, ['sit'], dir); fps = 6;
    } else if (b.sitting) {
      key = pick(set, ['sit', 'rot'], dir); fps = 4;
    } else if (b.speaking) {
      // talking out loud: prefer a dedicated talk track (open/closed mouth chatter) when the set
      // ships one — the mouth carries the speech, so keep only the gentle idle sway. Sets without
      // a talk track keep the livelier bob + 1px head bounce so speech never reads as a frozen pose.
      key = pick(set, ['talk', 'rot'], dir); fps = 6;
      bob = (key && key.indexOf('.talk.') !== -1)
        ? Math.sin(nowMs / 600 + aph) * 0.7
        : Math.sin(nowMs / 170 + aph) * 1.1 - (Math.floor(nowMs / 150) % 2 ? 1 : 0);
    } else {
      key = pick8(set, ['rot'], dir8, dir);
      bob = Math.sin(nowMs / 600 + aph) * 0.7;
    }

    // life-like idle gesture: a standing body occasionally plays its set's one-shot `gesture`
    // track (stretch / arm movement) ONCE through, then returns to the rot pose. Staggered per
    // agent like the blink so the crew never moves in unison. The index is derived from the
    // window's own progress (fixedIdx), NOT the free-running clock — a clock index would enter
    // the animation mid-cycle. Sets without a gesture track skip this entirely.
    let fixedIdx = null;
    if (key && key.indexOf('.rot.') !== -1 && b.state !== 'walk'
        && !b.working && !b.sitting && !b.speaking && !meeting && !glancing) {
      const kd = key.slice(key.lastIndexOf('.') + 1);
      const gk = frames[set + '.gesture.' + kd] ? set + '.gesture.' + kd
        : (frames[set + '.gesture.' + dir] ? set + '.gesture.' + dir : null);
      if (gk) {
        const GFPS = 8, glen = frames[gk].length, gdur = glen * (1000 / GFPS);
        const gt = (nowMs + aph * 1300) % 11000;
        if (gt < gdur) {
          key = gk; fixedIdx = Math.min(glen - 1, Math.floor(gt / (1000 / GFPS)));
          bob = 0;   // the frames carry the motion; bobbing on top reads as jitter
        }
      }
    }

    // life-like idle blink: while standing on a 'rot' pose, briefly shut the eyes.
    // staggered per-agent via b.phase so the crew doesn't blink in unison.
    // keyed off the RESOLVED key's own direction (may be a diagonal): swapping to a cardinal
    // blink frame under a diagonal pose would snap the head 45° for the blink's 130ms.
    if (key && key.indexOf('.rot.') !== -1 && b.state !== 'walk') {
      const bk = set + '.blink.' + key.slice(key.lastIndexOf('.') + 1);
      if (frames[bk]) {
        const bt = (nowMs + aph * 900) % 3300;
        if (bt < 130) key = bk;
      }
    }
    if (!key) return null;

    const fr = tintFrames(b.id, key);
    if (!fr || !fr.length) return null;
    // WALK advances on DISTANCE TRAVELLED (b.odo, world units — stepGait in world.js keeps it), not the wall
    // clock. A fixed-fps cycle made every body's feet skate, because pace is NOT fixed: crew temperament tilts
    // it 0.88-1.17x and the hero (34 u/s) outruns the crew (28 u/s), so one cycle length could never fit them all.
    //
    // The cycle DISTANCE is DERIVED per set, never hardcoded, so it stays correct for any skin without retuning:
    // stride length scales with leg length (≈ the character's DRAWN height), divided by however many walk frames
    // that set actually ships. Both vary today — ULTRON walks in 4 frames at 0.60 scale while the other 38 sets
    // use 6 frames at 0.36-0.425 — and a future skin with a different frame count or size is handled for free.
    // Do NOT replace this with a constant units-per-frame: that silently over-spins short or oversized sets.
    // Every other state keeps the clock; those aren't locomotion.
    const sc = drawScaleFor(set);
    const CYCLE_PER_HEIGHT = 0.56;   // world units of ground covered per drawn pixel of character height
    const stride = (fr[0].height * sc * CYCLE_PER_HEIGHT) / fr.length;
    const idx = fixedIdx != null ? fixedIdx
      : (key.indexOf('.walk.') !== -1 && b.odo != null && stride > 0)
        ? Math.floor(b.odo / stride + aph)
        : Math.floor(nowMs / (1000 / fps) + aph);
    const f = fr.length > 1 ? fr[((idx % fr.length) + fr.length) % fr.length] : fr[0];
    // footprint = native master × per-set scale → identical on-floor size as before, but f is now the
    // full-resolution master. Draw it DOWN to that size with smoothing ON so the detail survives (and
    // stays sharp if the camera zooms in, since it resamples straight from the 92px master each frame).
    const dw = f.width * sc, dh = f.height * sc;   // `sc` resolved above (the stride derivation needs it)
    // SUB-UNIT positioning. This used to be Math.round() on the raw world coordinate — i.e. a snap to integer
    // WORLD units. But the camera scales 0.5-6x (default 2), so one unit of rounding landed as a 2-6 DEVICE-pixel
    // jump, and at 34 u/s (~0.57 units per frame) the body held still for ~2 frames and then hopped a whole unit.
    // That was the loudest "sprites aren't smooth" artefact, in every direction, independent of turning. Note the
    // camera's own panX/panY were never rounded, so the world was already sub-pixel while the body alone snapped.
    // We round to the nearest DEVICE pixel instead: still crisply pixel-aligned (no resample blur at rest), but
    // sub-unit in world space, so motion is continuous. Do NOT put Math.round back on the world coordinate.
    const _m = ctx.getTransform ? ctx.getTransform() : null;
    const zs = (_m && _m.a > 0) ? _m.a : 1;
    const snap = v => Math.round(v * zs) / zs;
    const x = snap(b.px - dw / 2);
    // anchor the FEET (not the transparent image bottom) near the floor line so the contact shadow
    // reads as sitting under them. `fp` is the scaled padding below the feet; GROUND_BITE lifts the
    // feet a few px ABOVE the shadow so it shows just beneath them — flush (0/positive) looks sunk,
    // and the old image-bottom anchor left every skin hovering well above it.
    const GROUND_BITE = -3;
    const fp = getFootPad(set) * sc;
    const y = snap(b.py - dh + GROUND_BITE + bob + fp);
    // the pool's outer half-width, taken from the body's DRAWN footprint. Masters carry side
    // padding, so this lands well under dw/2 — a pool wider than the boots reads as a puddle.
    const shR = Math.max(4.5, dw * 0.21);
    // the contact shadow (and ULTRON's red spill) is a GROUND cue — skip it for off-floor renders
    // like the dossier portrait (b.noShadow), where there's no floor and it scales into a blocky bar.
    // NOTE: fed the RAW b.px/b.py, not the device-snapped ones. Snapping the pool while the body
    // itself is sub-unit would let the shadow tick a pixel while the feet slid smoothly over it.
    if (!b.noShadow) {
      const lift = Math.max(0, -bob);           // bob is +down; a negative bob has raised the body
      if (set === 'ultron') {
        // the station leader's menacing red spill — a wider, slower pulse beneath his own pool
        groundShadow(ctx, b.px, b.py, shR * 1.55, { lift, color: '#ff4a3d', alpha: 0.55 + 0.25 * Math.sin(nowMs / 400) });
      }
      groundShadow(ctx, b.px, b.py, shR, b.sitting ? { lift, alpha: 0.6, spread: 0.8 } : { lift });
    }
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(f, x, y, dw, dh);
    ctx.imageSmoothingEnabled = prevSmooth;
    // geometry for overlays (alert icon, bubble, selection box) — top of the visible body
    return { top: y + Math.round(dh * 0.22), w: Math.round(dw * 0.6), h: dh };
  }

  /* loading */
  function loadImage(path) {
    return new Promise(res => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = path;
    });
  }

  async function init() {
    try {
      const resp = await fetch('assets/sprites/manifest.json', { cache: 'no-store' });
      if (!resp.ok) return;
      const man = await resp.json();
      const jobs = [];
      for (const [key, paths] of Object.entries(man.sprites)) {
        jobs.push(Promise.all(paths.map(p => loadImage('assets/sprites/' + p))).then(imgs => {
          const ok = imgs.filter(Boolean);
          if (ok.length) frames[key] = ok;
        }));
      }
      await Promise.all(jobs);
      // ready when the DEFAULT skin's base pose loaded (the old `minion` astronaut set
      // was retired in favour of DATA.SKINS — gating on it left ready=false forever, so
      // every body fell through to the procedural fallback regardless of picked skin).
      const defSet = (typeof DATA !== 'undefined' && DATA.SKINS && DATA.DEFAULT_SKIN
        && DATA.SKINS[DATA.DEFAULT_SKIN] && DATA.SKINS[DATA.DEFAULT_SKIN].set) || 'bear';
      if (frames[defSet + '.rot.south'] || frames['ultron.rot.south'] || Object.keys(frames).length) {
        ready = true;
        console.log('[SPRITES] crew loaded:', Object.keys(frames).length, 'animation tracks (default skin:', defSet + ')');
      }
    } catch (e) { console.warn('[SPRITES] manifest missing — procedural fallback', e); }
  }

  return { init, drawBody, groundShadow, get ready() { return ready; } };
})();
