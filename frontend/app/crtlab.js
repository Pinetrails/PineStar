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

  const CRT_DEFAULTS = { scan: 0.43, pitch: 1, fade: 0.25, glow: 0.07, curve: 0.09, dust: 0.5, aberr: 0.35, grain: 0.24 };
  const LIGHT_DEFAULTS = { ambient: 0.77, pool: 1, room: 0.6, corridor: 0.42, door: 0.5, floor: 0.2 };
  const WALL_DEFAULTS = { up: 9, corUp: 0, skirt: 32, side: 12 };
  const DEPTH_DEFAULTS = { wallShadow: 0.5, sheen: 0.14, cornerAO: 0.55, dither: 0.8, floorWear: 0.55 };

  const PRESETS = {
    'Clean (off)':     { crt: { scan: 0, fade: 0, dust: 0, aberr: 0, grain: 0 } },
    'Soft fade':       { crt: { scan: 0.06, pitch: 2, fade: 1.0 } },
    'Faded film':      { crt: { scan: 0.05, pitch: 2, fade: 2.0 } },
    'Subtle lines':    { crt: { scan: 0.16, pitch: 2.5, fade: 0.6 } },
    'Heavy CRT':       { crt: { scan: 0.32, pitch: 3, fade: 0.4 } },
    'Bright room':     { light: { ambient: 0.52, pool: 0.9, floor: 0.2 } },
    'Balanced':        { light: { ambient: 0.66, pool: 0.95, floor: 0.22 } },
    'Dark + pools':    { light: { ambient: 0.82, pool: 1.0, floor: 0.26 } },
    'Flat (old)':      { wall: { up: 0, corUp: 0, skirt: 12, side: 4 }, depth: { wallShadow: 0, sheen: 0, cornerAO: 0, dither: 0, floorWear: 0 } },
    'Tall halls':      { wall: { up: 10, corUp: 0, skirt: 32, side: 12 } },
    'Towering':        { wall: { up: 32, corUp: 15, skirt: 38, side: 9 } },
    'Depth+':          { crt: { dust: 0.5, aberr: 0.35, grain: 0.24 }, depth: { wallShadow: 0.5, sheen: 0.14, cornerAO: 0.55, dither: 0.8, floorWear: 0.55 } },
  };

  // World/StationBake are top-level `const`s (global lexical bindings, NOT window props), so
  // reference them bare with a window fallback.
  const W = () => (typeof World !== 'undefined' ? World : window.World);
  const SB = () => (typeof StationBake !== 'undefined' ? StationBake : window.StationBake);
  const crt = () => (W() && W().crt) || {};
  const light = () => (SB() && SB().LIGHT) || {};
  const wall = () => (SB() && SB().WALL) || {};
  const depth = () => (SB() && SB().DEPTH) || {};

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
    if (readout) readout.value = JSON.stringify({ crt: pick(crt(), Object.keys(CRT_DEFAULTS)), light: pick(light(), Object.keys(LIGHT_DEFAULTS)), wall: pick(wall(), Object.keys(WALL_DEFAULTS)), depth: pick(depth(), Object.keys(DEPTH_DEFAULTS)) }, null, 0);
  }
  function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] != null) r[k] = +(+o[k]).toFixed(3); return r; }
  function syncAll() { sliders.forEach(s => s._sync && s._sync()); syncReadout(); }

  function applyPreset(p) {
    if (p.crt) Object.assign(crt(), p.crt);
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
    sliders.push(buildSlider(body, crt, 'dust', 0, 1, 0.05));      // dust motes drifting in the light pools
    sliders.push(buildSlider(body, crt, 'aberr', 0, 1, 0.05));     // chromatic aberration at the bowed edges (GPU path)
    sliders.push(buildSlider(body, crt, 'grain', 0, 0.25, 0.01));  // film grain over the warped feed

    section(body, 'DEPTH FX (re-bakes)');
    sliders.push(buildSlider(body, depth, 'wallShadow', 0, 0.5, 0.01, scheduleRebake)); // wall-cast floor shadow
    sliders.push(buildSlider(body, depth, 'sheen', 0, 0.6, 0.01, scheduleRebake));      // floor gloss under light pools
    sliders.push(buildSlider(body, depth, 'cornerAO', 0, 1, 0.01, scheduleRebake));     // pooled shadow in concave wall corners
    sliders.push(buildSlider(body, depth, 'dither', 0, 1, 0.01, scheduleRebake));       // Bayer-dither the light map's falloff
    sliders.push(buildSlider(body, depth, 'floorWear', 0, 1, 0.01, scheduleRebake));    // deck scuffs / worn patches / traffic lanes

    section(body, 'LIGHTING (re-bakes)');
    sliders.push(buildSlider(body, light, 'ambient', 0.3, 0.92, 0.01, scheduleRebake));
    sliders.push(buildSlider(body, light, 'pool', 0.5, 1, 0.01, scheduleRebake));
    sliders.push(buildSlider(body, light, 'floor', 0, 0.5, 0.01, scheduleRebake));
    sliders.push(buildSlider(body, light, 'room', 0.2, 0.8, 0.02, scheduleRebake));

    section(body, 'WALL HEIGHT (re-bakes)');
    sliders.push(buildSlider(body, wall, 'up', 0, 36, 1, scheduleRebake));      // room north face rise
    sliders.push(buildSlider(body, wall, 'corUp', 0, 24, 1, scheduleRebake));   // corridor north face rise
    sliders.push(buildSlider(body, wall, 'skirt', 6, 44, 1, scheduleRebake));   // hull drop below the station
    sliders.push(buildSlider(body, wall, 'side', 4, 12, 1, scheduleRebake));    // e/w wall-top band width

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
    btn(actions, 'RESET', () => { Object.assign(crt(), CRT_DEFAULTS); Object.assign(light(), LIGHT_DEFAULTS); Object.assign(wall(), WALL_DEFAULTS); Object.assign(depth(), DEPTH_DEFAULTS); scheduleRebake(); syncAll(); });
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
