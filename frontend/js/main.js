/* STARNET — main.js : boot, game loop, persistence */
'use strict';

const GAME = (() => {
  const SAVE_KEY = 'starnet_save_v1';
  const settings = { theme: 'amber', themeV2: true, scanlines: true, flicker: true, sound: true, speed: 1 };
  let running = false, lastT = 0, simAcc = 0;

  function applySettings() {
    document.body.className = 'theme-' + settings.theme;
    document.body.classList.toggle('no-scan', !settings.scanlines);
    document.body.classList.toggle('no-flicker', !settings.flicker);
    SFX.on = settings.sound;
  }

  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ sim: SIM.serialize(), settings }));
      const d = document.querySelector('#save-dot');
      if (d) { d.classList.add('flash'); setTimeout(() => d.classList.remove('flash'), 900); }
    } catch (e) { console.warn('save failed', e); }
  }
  function load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const o = JSON.parse(raw);
      if (o.settings) Object.assign(settings, o.settings);
      // one-time migration: NV-amber reference build becomes the default skin
      if (!o.settings || !o.settings.themeV2) { settings.theme = 'amber'; settings.themeV2 = true; }
      return SIM.load(o.sim);
    } catch (e) { return false; }
  }
  function reset() {
    window.removeEventListener('beforeunload', save); // or the unload autosave resurrects the wiped state
    localStorage.removeItem(SAVE_KEY);
    location.reload();
  }

  /* ---------- boot sequence ---------- */
  const BOOT_LINES = [
    'STARNET (R) TERMLINK PROTOCOL — STATION OS v2.077',
    'COPYRIGHT 2077-2086 STARNET ORBITAL DYNAMICS',
    'INITIALIZING PHOSPHOR BOOT AGENT v2.3.0',
    '64KB PHOSPHOR DISPLAY ............ OK',
    'HULL INTEGRITY ................... 100%',
    'LIFE SUPPORT (CREW: 1 HUMAN) ..... OK',
    'OPENCLAW GATEWAY :18789 .......... LIVE',
    'HERMES HARNESS MESH x16 .......... LIVE',
    'MODEL UPLINKS: GPT 5.5 / OPUS 4.8 / FABLE 5',
    'PRINTIFY API ..................... CONNECTED',
    'FIVERR WEBHOOK ................... LISTENING',
    'PIXELLAB / SUNO RENDER FARM ...... IDLE',
    'PROP CONSOLES x34 ................ MAPPED — CLICK ANY WORKSTATION',
    'WAKING 17 AGENTS ................. DONE',
    '',
    'ULTRON> Commander authentication accepted.',
    'ULTRON> The station is yours.'
  ];

  function bootSeq(done) {
    const box = document.querySelector('#boot-lines');
    const boot = document.querySelector('#boot');
    // E6c: the boot overlay may be absent (a variant page, or already removed) — never throw on a missing node,
    // just run the caller's `done` so the app still starts.
    if (!box || !boot) { if (done) done(); return; }
    const showGo = () => { const go = document.querySelector('#boot-go'); if (go) go.style.display = 'block'; };
    let i = 0;
    const typeLine = () => {
      if (i < BOOT_LINES.length) {
        const div = document.createElement('div');
        div.textContent = BOOT_LINES[i].length ? '> ' + BOOT_LINES[i] : ' ';
        box.appendChild(div);
        i++;
        setTimeout(typeLine, BOOT_LINES[i - 1] === '' ? 240 : 90 + Math.random() * 110);
      } else {
        showGo();
      }
    };
    typeLine();
    const start = () => {
      if (i < BOOT_LINES.length) { // skip
        i = BOOT_LINES.length; box.innerHTML = BOOT_LINES.map(l => '<div>' + (l ? '&gt; ' + l : '&nbsp;') + '</div>').join('');
        showGo();
        return;
      }
      boot.classList.add('off');
      setTimeout(() => { const b = document.querySelector('#boot'); if (b) b.remove(); }, 700);
      document.removeEventListener('click', start);
      document.removeEventListener('keydown', start);
      SFX.boot(); SFX.level();
      done();
    };
    document.addEventListener('click', start);
    document.addEventListener('keydown', start);
  }

  /* ---------- main loop ---------- */
  function loop(t) {
    const dt = Math.min(100, t - lastT); lastT = t;
    if (running) {
      // sim: 1 game-minute per (1000/speed) ms
      simAcc += dt * settings.speed;
      const mins = Math.floor(simAcc / 1000);
      if (mins > 0) { simAcc -= mins * 1000; SIM.tick(Math.min(mins, 30)); }
      WORLD.tick(dt, t);
      RENDER.frame(t);
    }
    requestAnimationFrame(loop);
  }

  function start() {
    const had = load();
    if (!had) SIM.init();
    applySettings();
    SPRITES.init(); // async — procedural fallback until loaded
    WORLD.init();
    RENDER.init(document.querySelector('#station'), (propKey, agentId, pos) => {
      SFX.click();
      if (agentId) UI.openAgent(agentId);
      else if (propKey) PROPTERM.open(propKey, pos);
    });
    UI.init();
    bootSeq(() => {
      SFX.boot();
      running = true;
      setInterval(() => UI.slowTick(), 1000);
      setInterval(save, 30000);
      window.addEventListener('beforeunload', save);
    });
    requestAnimationFrame(t => { lastT = t; requestAnimationFrame(loop); });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('pointerdown', () => SFX.boot(), { once: true });
    start();
  });

  return { settings, applySettings, save, reset };
})();
