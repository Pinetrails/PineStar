/* STARNET — skinstage.js : a shared LIVE skin preview.
   A 40px still of a chunky pixel sprite is unreadable, so wherever a player picks a skin
   (the create screen, the recruitment bay) a STAGE plays that skin's real south-facing walk
   cycle, big. Frames come straight from the sprite manifest — the same art the floor engine
   walks — with a rot_south fallback for sets lacking a walk cycle, so the demo never lies.
   One module, one rAF loop, self-throttled to idle while its <img> is off-screen. */
'use strict';

const SkinStage = (() => {
  let manifest = null;          // cached sprite manifest (frame lists keyed "<set>.<state>.<dir>")
  let frames = [];              // preloaded <img>s for whatever skin is on the stage right now
  let ix = 0, last = 0, looping = false;
  let imgEl = null, nameEl = null;

  // the frames to play for a set: prefer the south-facing walk cycle, fall back to the idle
  // rotation, then the bare still — straight from the manifest, so the demo matches the floor.
  function frameList(set) {
    const m = manifest && manifest.sprites;
    const walk = m && m[set + '.walk.south'];
    const rot  = m && m[set + '.rot.south'];
    const list = (walk && walk.length) ? walk : ((rot && rot.length) ? rot : [set + '/rot_south.png']);
    return list.map(p => 'assets/sprites/' + p);
  }

  // put a skin on the stage: preload its frames, reset the cycle, update the name label
  function show(id) {
    const sk = (typeof DATA !== 'undefined' && DATA.SKINS) ? DATA.SKINS[id] : null;
    if (!sk) return;
    ix = 0;
    frames = frameList(sk.set).map(src => { const im = new Image(); im.src = src; return im; });
    if (nameEl) nameEl.textContent = sk.name || id;
    if (imgEl && frames[0]) imgEl.src = frames[0].src;
  }

  // ~8fps walk, but only while the stage <img> is actually on screen (offsetParent === null when
  // hidden), so a closed panel/modal costs nothing.
  function tick(now) {
    if (imgEl && imgEl.offsetParent && frames.length > 1 && now - last > 120) {
      last = now;
      ix = (ix + 1) % frames.length;
      const f = frames[ix];
      if (f && f.complete) imgEl.src = f.src;
    }
    requestAnimationFrame(tick);
  }

  // bind the stage's <img> + name element, show an initial skin, and start the loop once. Loads
  // the manifest on first use, then reuses it. Re-callable: the latest mount owns the stage (only
  // one stage is ever visible at a time — the create screen XOR the recruitment-bay modal).
  function mount(img, name, id) {
    imgEl = img; nameEl = name || null;
    const start = () => {
      show(id);
      if (!looping) { looping = true; requestAnimationFrame(tick); }
    };
    if (manifest) start();
    else fetch('assets/sprites/manifest.json', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }).then(j => { manifest = j; start(); })
      .catch(() => { manifest = { sprites: {} }; start(); });
  }

  return { mount, show, frameList };
})();
