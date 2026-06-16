/* SKYNET — assets.js : PixelLab sprite loading + per-agent recoloring */
'use strict';

const SPRITES = (() => {
  let ready = false;
  const frames = {};   // key "minion.walk.south" -> [Image]
  const tinted = {};   // key "FORGE|minion.walk.south" -> [canvas]

  /* base suit color of the generated minion is bright yellow (~hue 50).
     each agent gets a css-filter recolor toward their accent color. */
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
  const BASE_HUE = 50, BASE_SAT = 0.85;
  function filterFor(agentId) {
    const a = DATA.AGENT[agentId];
    if (!a || a.id === 'ULTRON') return '';
    const { h, s, l } = hexToHsl(a.color);
    const rot = Math.round(h - BASE_HUE);
    const sat = Math.max(0.1, Math.min(2, s / BASE_SAT));
    const bri = Math.max(0.75, Math.min(1.25, 0.85 + l * 0.45));
    return 'hue-rotate(' + rot + 'deg) saturate(' + sat.toFixed(2) + ') brightness(' + bri.toFixed(2) + ')';
  }

  /* sprites are generated at 24px on a ~40px canvas — too large for 12px tiles.
     downscale once at recolor time (cached), nearest-neighbor for crispness.
     ultron keeps more of his source size so he towers over the crew (~2x). */
  const SCALE = { minion: 2 / 3, ultron: 0.85 };
  function tintFrames(agentId, key) {
    const ck = agentId + '|' + key;
    if (tinted[ck]) return tinted[ck];
    const src = frames[key];
    if (!src) return null;
    const filt = filterFor(agentId);
    const sc = SCALE[key.split('.')[0]] || 2 / 3;
    tinted[ck] = src.map(img => {
      const w = Math.max(1, Math.round(img.width * sc));
      const h = Math.max(1, Math.round(img.height * sc));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = false;
      if (filt) x.filter = filt;
      x.drawImage(img, 0, 0, w, h);
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
    const set = b.id === 'ULTRON' ? 'ultron' : 'minion';
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
      // talking out loud: no dedicated talk sprite exists, so sell it with a livelier bob + a subtle
      // 1px head bounce so the agent visibly animates while its voice plays (not a frozen idle pose).
      key = pick(set, ['rot'], dir); fps = 6;
      bob = Math.sin(nowMs / 170 + b.phase) * 1.1 - (Math.floor(nowMs / 150) % 2 ? 1 : 0);
    } else {
      key = pick(set, ['rot'], dir);
      bob = Math.sin(nowMs / 600 + b.phase) * 0.7;
    }
    if (!key) return null;

    const fr = tintFrames(b.id, key);
    if (!fr || !fr.length) return null;
    const f = fr.length > 1 ? fr[Math.floor(nowMs / (1000 / fps) + b.phase) % fr.length] : fr[0];
    const x = Math.round(b.px - f.width / 2);
    const y = Math.round(b.py - f.height + 4 + bob);
    // soft shadow scaled to the body's footprint
    const shw = Math.max(8, Math.round(f.width * 0.38));
    if (set === 'ultron') {
      // menacing red spill under the station's leader
      ctx.globalAlpha = 0.18 + 0.08 * Math.sin(nowMs / 400);
      ctx.fillStyle = '#ff4a3d';
      ctx.fillRect(Math.round(b.px) - (shw >> 1) - 2, Math.round(b.py) - 2, shw + 4, 4);
    }
    ctx.globalAlpha = 0.30;
    ctx.fillStyle = '#000';
    ctx.fillRect(Math.round(b.px) - (shw >> 1), Math.round(b.py) - 1, shw, 2);
    ctx.globalAlpha = 1;
    ctx.drawImage(f, x, y);
    // geometry for overlays (alert icon, bubble, selection box) — top of the visible body
    return { top: y + Math.round(f.height * 0.22), w: Math.round(f.width * 0.6), h: f.height };
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
      if (frames['minion.rot.south']) {
        ready = true;
        console.log('[SPRITES] pixellab crew loaded:', Object.keys(frames).length, 'animation tracks');
      }
    } catch (e) { console.warn('[SPRITES] manifest missing — procedural fallback', e); }
  }

  return { init, drawBody, get ready() { return ready; } };
})();
