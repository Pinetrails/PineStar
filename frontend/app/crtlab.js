/* crtlab.js — DEV-ONLY live tuning panel for the CRT/fade overlay + the station lighting.
 *
 * Inert unless the page is opened with ?crtlab (e.g. http://127.0.0.1:8791/?crtlab=1).
 * It mutates the SAME live config objects the renderer reads — World.crt (scanlines/fade/
 * glow, applied every frame) and StationBake.LIGHT (the bake; a debounced World.rebake()
 * re-runs it) — so you compare options in real time. "COPY VALUES" puts the exact numbers
 * on the clipboard so they can be baked in as the new defaults. Ships nothing on its own:
 * with no ?crtlab it never builds, and the defaults live in world.js / stationbake.js.
 */
(function () {
  if (!/[?&]crtlab\b/.test(location.search)) return;

  const CRT_DEFAULTS = { scan: 0.43, pitch: 1, fade: 0.25, glow: 0.07, curve: 0.09, vig: 0.30, over: 1.20, dust: 0.5, aberr: 0.35, grain: 0.24 };
  const LIGHT_DEFAULTS = { ambient: 0.77, pool: 1, room: 0.6, corridor: 0.42, door: 0.5, floor: 0.2, crown: 0.45 };
  /* MUST MIRROR StationBake.WALL EXACTLY — these are not just the readout's key list, RESET writes
     them back over the live object. They had drifted (up 9, side 12) behind the shipped 14/7, so
     RESET restored a state that never shipped and side 12 pushed the wall band past the hull
     silhouette it is pinned to. Add a WALL knob, add it here. */
  const WALL_DEFAULTS = { up: 14, corUp: 8, skirt: 32, side: 7, capH: 3, sideCap: 5 };
  const DEPTH_DEFAULTS = { wallShadow: 0.5, sheen: 0.14, cornerAO: 0.55, dither: 0.15, floorWear: 0.55, floorDetail: 1, deckSeam: 0.38, wallDetail: 1 };
  // TUBE APERTURE — the CSS glass vignette over the feed (app.css :root --tube-*). NOT the barrel warp:
  // `curve` bows the picture, these dim its outer band, and they move independently. Seeded from the live
  // custom properties at build time so opening the lab can never itself change the shipped look.
  const TUBE_DEFAULTS = { clear: 68, mid: 88, midA: 0.26, edgeA: 0.70, inset: 40 };
  const TUBE_CSSVAR = { clear: ['--tube-clear', '%'], mid: ['--tube-mid', '%'], midA: ['--tube-mid-a', ''], edgeA: ['--tube-edge-a', ''], inset: ['--tube-inset', 'px'] };

  const PRESETS = {
    'Clean (off)':     { crt: { scan: 0, fade: 0, dust: 0, aberr: 0, grain: 0 } },
    'Soft fade':       { crt: { scan: 0.06, pitch: 2, fade: 1.0 } },
    'Faded film':      { crt: { scan: 0.05, pitch: 2, fade: 2.0 } },
    'Subtle lines':    { crt: { scan: 0.16, pitch: 2.5, fade: 0.6 } },
    'Heavy CRT':       { crt: { scan: 0.32, pitch: 3, fade: 0.4 } },
    'Bright room':     { light: { ambient: 0.52, pool: 0.9, floor: 0.2 } },
    'Balanced':        { light: { ambient: 0.66, pool: 0.95, floor: 0.22 } },
    'Dark + pools':    { light: { ambient: 0.82, pool: 1.0, floor: 0.26 } },
    // side is pinned at `pad` (7) — past it the wall band juts out of the station's own silhouette
    'Flat (old)':      { wall: { up: 0, corUp: 0, skirt: 12, side: 4 }, depth: { wallShadow: 0, sheen: 0, cornerAO: 0, dither: 0, floorWear: 0, floorDetail: 0, deckSeam: 0, wallDetail: 0 } },
    'Tall halls':      { wall: { up: 10, corUp: 6, skirt: 32, side: 7 } },
    'Towering':        { wall: { up: 32, corUp: 15, skirt: 38, side: 7 } },
    'Depth+':          { crt: { dust: 0.5, aberr: 0.35, grain: 0.24 }, depth: { wallShadow: 0.5, sheen: 0.14, cornerAO: 0.55, dither: 0.15, floorWear: 0.55, floorDetail: 1, deckSeam: 0.38, wallDetail: 1 } },
    // A/B the WHOLE aperture — in-canvas vignette + overscan + the CSS glass together. `curve` is 0.09 in
    // every one of them: these change how much of the panel the picture gets, never how hard it bows.
    'Ap: old (tight)': { crt: { vig: 0.55, over: 1 },    tube: { clear: 50, mid: 82, midA: 0.34, edgeA: 0.82, inset: 60 } },
    'Ap: current':     { crt: { vig: 0.30, over: 1.20 }, tube: { clear: 68, mid: 88, midA: 0.26, edgeA: 0.70, inset: 40 } },
    'Ap: wide open':   { crt: { vig: 0.16, over: 1.24 }, tube: { clear: 80, mid: 93, midA: 0.16, edgeA: 0.48, inset: 24 } },
  };

  // World/StationBake are top-level `const`s (global lexical bindings, NOT window props), so
  // reference them bare with a window fallback.
  const W = () => (typeof World !== 'undefined' ? World : window.World);
  const SB = () => (typeof StationBake !== 'undefined' ? StationBake : window.StationBake);
  const crt = () => (W() && W().crt) || {};
  const light = () => (SB() && SB().LIGHT) || {};
  const wall = () => (SB() && SB().WALL) || {};
  const depth = () => (SB() && SB().DEPTH) || {};

  // The tube dials have no engine object behind them (they ARE the CSS), so the lab owns the state: read the
  // shipped custom properties once, then push every edit straight back onto :root.
  const tubeState = {};
  function tube() {
    if (tubeState.clear == null) {
      const cs = getComputedStyle(document.documentElement);
      for (const k of Object.keys(TUBE_DEFAULTS)) {
        const n = parseFloat(cs.getPropertyValue(TUBE_CSSVAR[k][0]));
        tubeState[k] = Number.isFinite(n) ? n : TUBE_DEFAULTS[k];
      }
    }
    return tubeState;
  }
  function applyTube() {
    const t = tube(), s = document.documentElement.style;
    for (const k of Object.keys(TUBE_CSSVAR)) s.setProperty(TUBE_CSSVAR[k][0], t[k] + TUBE_CSSVAR[k][1]);
  }

  let rebakeT = 0;
  function scheduleRebake() {
    clearTimeout(rebakeT);
    rebakeT = setTimeout(() => { try { const w = W(); w && w.rebake && w.rebake(); } catch (e) { console.warn('rebake', e); } }, 90);
  }

  function buildSlider(parent, target, key, min, max, step, onChange) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:3px 0;';
    const label = document.createElement('label');
    label.textContent = key;
    label.style.cssText = 'flex:0 0 62px;font-size:11px;opacity:.85;';
    const input = document.createElement('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step;
    input.value = (target()[key] != null ? target()[key] : 0);
    input.style.cssText = 'flex:1;min-width:0;accent-color:#ffaa33;';
    const val = document.createElement('span');
    val.textContent = (+input.value).toFixed(2);
    val.style.cssText = 'flex:0 0 34px;text-align:right;font-size:11px;color:#ffd9a3;';
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      target()[key] = v; val.textContent = v.toFixed(2);
      onChange && onChange();
      syncReadout();
    });
    row._sync = () => { input.value = (target()[key] != null ? target()[key] : 0); val.textContent = (+input.value).toFixed(2); };
    row.append(label, input, val);
    parent.appendChild(row);
    return row;
  }

  function section(parent, title) {
    const h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'margin:9px 0 2px;font-size:10px;letter-spacing:2px;color:#ffaa33;border-bottom:1px solid rgba(255,170,51,.3);padding-bottom:2px;';
    parent.appendChild(h);
    return parent;
  }

  function btn(parent, text, cb, accent) {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'font:inherit;font-size:10px;padding:4px 6px;cursor:pointer;background:' +
      (accent ? '#ffaa33' : 'rgba(255,170,51,.12)') + ';color:' + (accent ? '#190f02' : '#ffd9a3') +
      ';border:1px solid rgba(255,170,51,.5);border-radius:3px;';
    b.addEventListener('click', cb);
    parent.appendChild(b);
    return b;
  }

  let sliders = [];
  let readout;
  function syncReadout() {
    if (readout) readout.value = JSON.stringify({ crt: pick(crt(), Object.keys(CRT_DEFAULTS)), tube: pick(tube(), Object.keys(TUBE_DEFAULTS)), light: pick(light(), Object.keys(LIGHT_DEFAULTS)), wall: pick(wall(), Object.keys(WALL_DEFAULTS)), depth: pick(depth(), Object.keys(DEPTH_DEFAULTS)) }, null, 0);
  }
  function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] != null) r[k] = +(+o[k]).toFixed(3); return r; }
  function syncAll() { sliders.forEach(s => s._sync && s._sync()); syncReadout(); }

  function applyPreset(p) {
    if (p.crt) Object.assign(crt(), p.crt);
    if (p.tube) { Object.assign(tube(), p.tube); applyTube(); }
    if (p.light) { Object.assign(light(), p.light); scheduleRebake(); }
    if (p.wall) { Object.assign(wall(), p.wall); scheduleRebake(); }
    if (p.depth) { Object.assign(depth(), p.depth); scheduleRebake(); }
    syncAll();
  }

  function build() {
    const box = document.createElement('div');
    box.id = 'crt-lab';
    box.style.cssText = [
      'position:fixed', 'top:64px', 'right:12px', 'width:248px', 'z-index:100000',
      'background:rgba(8,6,4,.94)', 'border:2px solid #ffaa33', 'border-radius:7px',
      'box-shadow:0 8px 30px rgba(0,0,0,.7)', 'padding:10px 11px', 'color:#eec88f',
      "font-family:'VT323','Courier New',monospace", 'user-select:none',
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;';
    const title = document.createElement('b');
    title.textContent = '▮ CRT LAB';
    title.style.cssText = 'color:#ffaa33;letter-spacing:2px;font-size:13px;';
    const collapse = document.createElement('button');
    collapse.textContent = '–';
    collapse.style.cssText = 'font:inherit;cursor:pointer;background:none;border:none;color:#ffaa33;font-size:18px;line-height:1;';
    head.append(title, collapse);
    box.appendChild(head);

    const body = document.createElement('div');
    box.appendChild(body);
    collapse.addEventListener('click', () => {
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      collapse.textContent = hidden ? '–' : '+';
    });

    section(body, 'SCANLINES / FADE / CURVE');
    sliders.push(buildSlider(body, crt, 'scan', 0, 0.5, 0.01));
    sliders.push(buildSlider(body, crt, 'pitch', 1, 6, 0.5));
    sliders.push(buildSlider(body, crt, 'fade', 0, 3, 0.05));
    sliders.push(buildSlider(body, crt, 'glow', 0, 0.4, 0.01));
    sliders.push(buildSlider(body, crt, 'curve', 0, 0.4, 0.01));   // barrel-curve the whole feed (0 = flat)
    // THE TWO THAT ACTUALLY SIZE THE PICTURE (both leave `curve` alone):
    sliders.push(buildSlider(body, crt, 'vig', 0, 0.8, 0.01));     // in-canvas vignette 1−vig·r² — the dominant edge darkener (0.55 crushed corners to black)
    sliders.push(buildSlider(body, crt, 'over', 1, 1.4, 0.01));    // output overscan — ≥1.11 pulls the corners back inside the warp's domain so they stop filling black
    sliders.push(buildSlider(body, crt, 'dust', 0, 1, 0.05));      // dust motes drifting in the light pools
    sliders.push(buildSlider(body, crt, 'aberr', 0, 1, 0.05));     // chromatic aberration at the bowed edges (GPU path)
    sliders.push(buildSlider(body, crt, 'grain', 0, 0.25, 0.01));  // film grain over the warped feed

    // The glass aperture — how much of the panel the picture actually gets to use. Independent of `curve`
    // above: raising `clear` gives back real estate without touching the bulge at all.
    section(body, 'TUBE APERTURE (css glass)');
    sliders.push(buildSlider(body, tube, 'clear', 30, 95, 1, applyTube));    // % out to which the glass stays fully clear
    sliders.push(buildSlider(body, tube, 'mid', 55, 99, 1, applyTube));      // % of the falloff's mid stop
    sliders.push(buildSlider(body, tube, 'midA', 0, 0.6, 0.01, applyTube));  // darkness at the mid stop
    sliders.push(buildSlider(body, tube, 'edgeA', 0, 1, 0.01, applyTube));   // darkness at the very corner
    sliders.push(buildSlider(body, tube, 'inset', 0, 90, 2, applyTube));     // px of inner edge shadow on the panel

    section(body, 'DEPTH FX (re-bakes)');
    sliders.push(buildSlider(body, depth, 'wallShadow', 0, 0.5, 0.01, scheduleRebake)); // wall-cast floor shadow
    sliders.push(buildSlider(body, depth, 'sheen', 0, 0.6, 0.01, scheduleRebake));      // floor gloss under light pools
    sliders.push(buildSlider(body, depth, 'cornerAO', 0, 1, 0.01, scheduleRebake));     // pooled shadow in concave wall corners
    sliders.push(buildSlider(body, depth, 'dither', 0, 1, 0.01, scheduleRebake));       // Bayer-dither the light map's falloff
    sliders.push(buildSlider(body, depth, 'floorWear', 0, 1, 0.01, scheduleRebake));    // deck scuffs / worn patches / traffic lanes
    sliders.push(buildSlider(body, depth, 'floorDetail', 0, 1.5, 0.01, scheduleRebake)); // V2 floor materials: plates/seams/rivets/trim amplitude
    sliders.push(buildSlider(body, depth, 'deckSeam', 0, 1, 0.01, scheduleRebake));      // how hard the joint between deck plates/boards reads (0 = seamless)
    sliders.push(buildSlider(body, depth, 'wallDetail', 0, 1.5, 0.01, scheduleRebake));  // V4 wall materials: ribs/panels/pipes/grain amplitude

    section(body, 'LIGHTING (re-bakes)');
    sliders.push(buildSlider(body, light, 'ambient', 0.3, 0.92, 0.01, scheduleRebake));
    sliders.push(buildSlider(body, light, 'pool', 0.5, 1, 0.01, scheduleRebake));
    sliders.push(buildSlider(body, light, 'floor', 0, 0.5, 0.01, scheduleRebake));
    sliders.push(buildSlider(body, light, 'room', 0.2, 0.8, 0.02, scheduleRebake));
    sliders.push(buildSlider(body, light, 'crown', 0, 0.8, 0.01, scheduleRebake));   // how far ambient gives way over a wall's lit top surface — 0 puts the crown back under the hull skirt

    section(body, 'WALL HEIGHT (re-bakes)');
    sliders.push(buildSlider(body, wall, 'up', 0, 36, 1, scheduleRebake));      // room north face rise
    sliders.push(buildSlider(body, wall, 'corUp', 0, 24, 1, scheduleRebake));   // corridor north face rise
    sliders.push(buildSlider(body, wall, 'skirt', 6, 44, 1, scheduleRebake));   // hull drop below the station
    sliders.push(buildSlider(body, wall, 'side', 4, 7, 1, scheduleRebake));     // e/w wall band width — 7 is the hull's own reach (`pad`); past it the wall juts out of the station silhouette
    sliders.push(buildSlider(body, wall, 'sideCap', 2, 6, 1, scheduleRebake));  // lit top surface of the e/w/s walls — the crown ring's width

    section(body, 'PRESETS');
    const presetWrap = document.createElement('div');
    presetWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
    Object.entries(PRESETS).forEach(([name, p]) => btn(presetWrap, name, () => applyPreset(p)));
    body.appendChild(presetWrap);

    section(body, 'VALUES');
    readout = document.createElement('textarea');
    readout.readOnly = true;
    readout.style.cssText = 'width:100%;height:46px;margin-top:3px;font:inherit;font-size:10px;background:rgba(0,0,0,.5);color:#9adcb0;border:1px solid rgba(255,170,51,.3);border-radius:3px;resize:none;';
    body.appendChild(readout);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;margin-top:7px;';
    btn(actions, 'COPY VALUES', () => {
      const txt = readout.value;
      navigator.clipboard && navigator.clipboard.writeText(txt).then(
        () => flash('copied ✓'), () => { readout.select(); flash('select+copy'); });
    }, true);
    btn(actions, 'RESET', () => { Object.assign(crt(), CRT_DEFAULTS); Object.assign(tube(), TUBE_DEFAULTS); applyTube(); Object.assign(light(), LIGHT_DEFAULTS); Object.assign(wall(), WALL_DEFAULTS); Object.assign(depth(), DEPTH_DEFAULTS); scheduleRebake(); syncAll(); });
    body.appendChild(actions);

    const note = document.createElement('div');
    note.style.cssText = 'margin-top:6px;font-size:10px;opacity:.55;line-height:1.25;';
    note.textContent = 'live: scanlines/fade/glow · lighting re-bakes on release';
    body.appendChild(note);

    let flashT = 0;
    function flash(msg) { note.textContent = msg; clearTimeout(flashT); flashT = setTimeout(() => note.textContent = 'live: scanlines/fade/glow · lighting re-bakes on release', 1200); }

    document.body.appendChild(box);
    syncAll();
  }

  function ready() { return W() && W().crt && SB() && SB().LIGHT; }
  function boot(tries) {
    if (ready()) { build(); return; }
    if (tries <= 0) { console.warn('[crtlab] World/StationBake not ready'); return; }
    setTimeout(() => boot(tries - 1), 200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot(40));
  else boot(40);
})();
