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

  /* main draw: foot-anchored at (x, y) */
  function drawBody(ctx, b, nowMs) {
    const set = b.id === 'ULTRON' ? 'ultron'
      : ((DATA.SKINS[b.skin] && DATA.SKINS[b.skin].set) || DATA.SKINS[DATA.DEFAULT_SKIN].set);
    const glancing = b.glance && b.glance.until > nowMs;   // brief look-up: overrides facing & typing
    const meeting = b.meet && b.meet.until > nowMs;        // hallway chat: stand still, face partner
    const dir = glancing ? b.glance.dir : (b.dir || 'south');
    let key = null, fps = 8, bob = 0;

    if (meeting) {
      key = pick(set, ['rot'], dir); fps = 4;
    } else if (b.state === 'walk') {
      key = pick(set, ['walk'], dir); fps = 10;
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
        ? Math.sin(nowMs / 600 + b.phase) * 0.7
        : Math.sin(nowMs / 170 + b.phase) * 1.1 - (Math.floor(nowMs / 150) % 2 ? 1 : 0);
    } else {
      key = pick(set, ['rot'], dir);
      bob = Math.sin(nowMs / 600 + b.phase) * 0.7;
    }

    // life-like idle blink: while standing on a 'rot' pose, briefly shut the eyes.
    // staggered per-agent via b.phase so the crew doesn't blink in unison.
    if (key && key.indexOf('.rot.') !== -1 && b.state !== 'walk') {
      const bk = set + '.blink.' + dir;
      if (frames[bk]) {
        const bt = (nowMs + (b.phase || 0) * 900) % 3300;
        if (bt < 130) key = bk;
      }
    }
    if (!key) return null;

    const fr = tintFrames(b.id, key);
    if (!fr || !fr.length) return null;
    const f = fr.length > 1 ? fr[Math.floor(nowMs / (1000 / fps) + b.phase) % fr.length] : fr[0];
    // footprint = native master × per-set scale → identical on-floor size as before, but f is now the
    // full-resolution master. Draw it DOWN to that size with smoothing ON so the detail survives (and
    // stays sharp if the camera zooms in, since it resamples straight from the 92px master each frame).
    const sc = drawScaleFor(set);
    const dw = f.width * sc, dh = f.height * sc;
    const x = Math.round(b.px - dw / 2);
    // anchor the FEET (not the transparent image bottom) near the floor line so the contact shadow
    // reads as sitting under them. `fp` is the scaled padding below the feet; GROUND_BITE lifts the
    // feet a few px ABOVE the shadow so it shows just beneath them — flush (0/positive) looks sunk,
    // and the old image-bottom anchor left every skin hovering well above it.
    const GROUND_BITE = -3;
    const fp = getFootPad(set) * sc;
    const y = Math.round(b.py - dh + GROUND_BITE + bob + fp);
    // soft shadow scaled to the body's footprint (kept narrower than the body so it reads as a
    // tight contact pool under the feet, not a wide slab)
    const shw = Math.max(6, Math.round(dw * 0.26));
    // the contact shadow (and ULTRON's red spill) is a GROUND cue — skip it for off-floor renders
    // like the dossier portrait (b.noShadow), where there's no floor and it scales into a blocky bar.
    if (!b.noShadow) {
      if (set === 'ultron') {
        // menacing red spill under the station's leader
        ctx.globalAlpha = 0.18 + 0.08 * Math.sin(nowMs / 400);
        ctx.fillStyle = '#ff4a3d';
        ctx.fillRect(Math.round(b.px) - (shw >> 1) - 2, Math.round(b.py) - 2, shw + 4, 4);
      }
      ctx.globalAlpha = 0.24;
      ctx.fillStyle = '#000';
      ctx.fillRect(Math.round(b.px) - (shw >> 1), Math.round(b.py) - 1, shw, 2);
      ctx.globalAlpha = 1;
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

  return { init, drawBody, get ready() { return ready; } };
})();
