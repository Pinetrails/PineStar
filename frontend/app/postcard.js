/* STARNET — postcard.js : the SHAREABLE POSTCARD engine (Game session, Phase G5 / Spectacle slice 1).

   The station's first shareable surface. On a COMPLETED run the Commander can capture a styled
   PNG "postcard" — the live station scene under a run summary + the agent's growth — and drag/save
   it anywhere. This is the growth-engine seed: watchability = the thing people pass around.

   HONESTY RULES (the floorstats/pride/trophies law — the product's core promise, truthful telemetry):
     • Every number on the card is a fold of REAL run telemetry the frontend already holds:
         - the run OUTCOME (reason/title/artifacts/cost/duration/model) from the recorded run entry
           (the same GET /api/runs ledger the recap card reads — the sidecar's append-only artifacts log),
         - the agent's LEVEL + in-level XP from Xp.compute(agent.stats) — the honest, user-approved ladder,
         - the station's LIFETIME record from PrideStore.snapshot() — tasks shipped, founding date.
     • A stat with no provable value is OMITTED, never faked: a run with no priced spend shows no "$0",
       an uncalibrated confidence shows nothing, a station with no founded date shows no birthday. The
       assemble() reducer decides inclusion PURELY from the inputs and is unit-tested for exactly this.
     • The station SCENE is the live #stage canvas pixels at capture time — a real frame, not a mockup.

   assemble() is PURE (no DOM/clock/canvas) so the "what goes on the card" contract is node-testable.
   render()/save() are the browser half: composite onto an offscreen canvas in the CRT/VT323 grade,
   then toBlob → a draggable + downloadable PNG. Reuses the in-browser canvas capture substrate (the
   same drawImage-from-canvas the world already runs on) — it does NOT rebuild the QA CDP screenshotter,
   which is an external test tool, not a user affordance.

   NEVER emits on U.bus (the frozen shared/events.js contract is owned elsewhere; lint-emits stays green).
   A `Postcard` global in the browser, module.exports under node — the pure reducer is headless-testable. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Postcard = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const str = v => (v == null ? '' : String(v));
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
  const posNum = v => Math.max(0, num(v));

  // clamp a title so a monster directive can't blow out the card layout.
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
    if (s <= 0) return '';                 // sub-second → omit rather than show a fake "0s"
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return r ? m + 'm ' + r + 's' : m + 'm';
    const h = Math.floor(m / 60), rm = m % 60;
    return rm ? h + 'h ' + rm + 'm' : h + 'h';
  }
  // a whole-date stamp from an epoch-ms, or '' when unknown (never epoch-0/1969 — the pride/trophies law).
  function fmtDate(ms) {
    const n = num(ms);
    if (!(n > 0)) return '';
    try {
      const d = new Date(n);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_) { return ''; }
  }

  /* THE PURE REDUCER — decide EXACTLY what goes on the card from real inputs. No inclusion of any stat
     that isn't provable from the inputs. input:
       run    — the recorded run entry (recap shape): { reason, title, artifacts[], usd, unmetered, model, tokens }
       durMs  — the run's real wall-clock duration (ms), from the run teardown
       agent  — { name, id, stats } — stats is the Xp engine's persisted blob (or absent → no growth line)
       xp     — the Xp module (for compute); optional — absent means no growth line
       pride  — PrideStore.snapshot() (or null) — the lifetime station record with its honest known flags
       nowMs  — injected wall-clock for the "captured" stamp (pure: caller passes Date.now())
     Returns a render-agnostic card model. Fields are present ONLY when honestly known. Exported + tested. */
  function assemble(input) {
    input = input || {};
    const run = input.run || {};
    const agent = input.agent || {};
    const xp = input.xp || (typeof Xp !== 'undefined' ? Xp : null);
    const pride = input.pride || null;

    const reason = str(run.reason) || 'done';
    const done = reason === 'done';
    const arts = Array.isArray(run.artifacts) ? run.artifacts : [];

    // OUTCOME line — the headline of what this run did.
    const card = {
      agentName: brief(str(agent.name) || 'AGENT', 28),
      done: done,
      outcome: done ? 'DELIVERED' : ('ENDED · ' + reason.toUpperCase()),
      title: brief(str(run.title), 60),
      capturedAt: fmtDate(input.nowMs),
    };

    // RUN META chips — each included ONLY when it has a real value.
    const chips = [];
    if (arts.length > 0) chips.push(arts.length + (arts.length === 1 ? ' artifact' : ' artifacts'));
    const dur = fmtMs(input.durMs);
    if (dur) chips.push(dur);
    const toks = posNum(run.tokens);   // real token count from the run entry (runStore); 0 → omitted
    if (toks > 0) chips.push((toks >= 1000 ? (toks / 1000).toFixed(toks >= 10000 ? 0 : 1) + 'k' : toks) + ' tok');
    if (run.unmetered) chips.push('subscription');
    else { const c = fmtUsd(run.usd); if (c) chips.push(c); }
    const model = str(run.model);
    if (model && model !== '(unknown)') chips.push(model);
    card.chips = chips;

    // GROWTH line — the agent's honest, user-approved ladder. Only when we can compute it.
    let growth = null;
    if (xp && xp.compute && agent.stats) {
      try {
        const c = xp.compute(agent.stats);
        growth = {
          level: posNum(c.level) || 1,
          pct: Math.max(0, Math.min(100, posNum(c.pct))),   // progress into the current level
          lifetimeXp: posNum(c.lifetimeXp),
          tasksDone: posNum(c.tasksDone),
          // confidence % ONLY when calibrated (c.known) — never a fabricated number before MIN_SAMPLES.
          confLabel: c.known ? str(c.confLabel) : '',
          band: str(c.band),
        };
      } catch (_) { growth = null; }
    }
    card.growth = growth;

    // STATION lifetime record — each counter gated on its OWN honest known flag (the pride "—" law).
    let station = null;
    if (pride && typeof pride === 'object') {
      station = {
        founded: pride.founded ? fmtDate(pride.foundedAt) : '',
        tasks: pride.tasksKnown ? posNum(pride.tasks) : null,
        deliverables: pride.deliverablesKnown ? posNum(pride.deliverables) : null,
        workMinutes: pride.workKnown ? posNum(pride.workMinutes) : null,
      };
      // if NOTHING in the station record is known yet, drop the whole block rather than show a hollow one.
      if (!station.founded && station.tasks == null && station.deliverables == null && station.workMinutes == null) station = null;
    }
    card.station = station;

    return card;
  }

  // ---------- the browser half: composite the card model + the live scene onto an offscreen canvas ----------
  // (guarded so the module still loads + the reducer still tests under node, where there is no DOM/canvas.)

  const CARD_W = 1200, CARD_H = 750;   // a comfortable 16:10 share tile

  // resolve a themed phosphor colour from the live CSS vars so the PNG matches the current CRT theme.
  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return (v && v.trim()) || fallback;
    } catch (_) { return fallback; }
  }

  // draw VT323 text with a soft phosphor glow (the canvas-text law). Returns the measured width.
  function phosphorText(ctx, text, x, y, size, color, glow, align) {
    ctx.save();
    ctx.font = size + 'px VT323, monospace';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = Math.max(4, size * 0.28); }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    const w = ctx.measureText(text).width;
    ctx.restore();
    return w;
  }

  // paint the composed postcard onto `canvas` (created by the caller at CARD_W×CARD_H). `scene` is the live
  // #stage canvas (or null → a flat panel). `card` is the assemble() model. Pure-ish: only touches canvas.
  function paint(canvas, scene, card) {
    const ctx = canvas.getContext('2d');
    const ph = cssVar('--ph', '#ffaa33').trim();
    const phBright = cssVar('--ph-bright', '#ffd9a3').trim();
    const phDim = cssVar('--ph-dim', '#b9791c').trim();
    const gold = cssVar('--gold', '#ffd34a').trim();
    const glow = cssVar('--ph-glow', 'rgba(255,170,51,0.5)').trim();

    // 1 — black glass backdrop
    ctx.fillStyle = '#050301';
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // 2 — the live station scene, letterboxed into the top ~62% (a real captured frame, not a mockup)
    const sceneH = Math.round(CARD_H * 0.60);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, CARD_W, sceneH); ctx.clip();
    if (scene && scene.width && scene.height) {
      // cover-fit the scene into the band, centered
      const sr = scene.width / scene.height, dr = CARD_W / sceneH;
      let sw, sh, sx, sy;
      if (sr > dr) { sh = scene.height; sw = Math.round(sh * dr); sx = Math.round((scene.width - sw) / 2); sy = 0; }
      else { sw = scene.width; sh = Math.round(sw / dr); sx = 0; sy = Math.round((scene.height - sh) / 2); }
      try { ctx.drawImage(scene, sx, sy, sw, sh, 0, 0, CARD_W, sceneH); } catch (_) { ctx.fillStyle = '#0a0602'; ctx.fillRect(0, 0, CARD_W, sceneH); }
    } else { ctx.fillStyle = '#0a0602'; ctx.fillRect(0, 0, CARD_W, sceneH); }
    // scanline veil over the scene (the CRT grade — subtle, baked into the share)
    ctx.globalAlpha = 0.10; ctx.fillStyle = '#000';
    for (let y = 0; y < sceneH; y += 3) ctx.fillRect(0, y, CARD_W, 1);
    ctx.globalAlpha = 1;
    // a phosphor gradient vignette fading the scene into the info band
    const grad = ctx.createLinearGradient(0, sceneH - 120, 0, sceneH);
    grad.addColorStop(0, 'rgba(5,3,1,0)'); grad.addColorStop(1, 'rgba(5,3,1,0.95)');
    ctx.fillStyle = grad; ctx.fillRect(0, sceneH - 120, CARD_W, 120);
    ctx.restore();

    // 3 — outer bezel frame
    ctx.strokeStyle = phDim; ctx.lineWidth = 4; ctx.strokeRect(6, 6, CARD_W - 12, CARD_H - 12);
    ctx.strokeStyle = ph; ctx.lineWidth = 1; ctx.strokeRect(12, 12, CARD_W - 24, CARD_H - 24);

    // 4 — masthead (top-left, over the scene) — the STARNET wordmark
    phosphorText(ctx, 'STARNET', 40, 66, 42, phBright, glow, 'left');
    phosphorText(ctx, '// STATION LOG', 40, 96, 22, phDim, '', 'left');
    if (card.capturedAt) phosphorText(ctx, card.capturedAt, CARD_W - 40, 66, 26, phDim, '', 'right');

    // 5 — the info band (bottom ~40%)
    const bandY = sceneH + 46;
    // outcome headline + agent
    phosphorText(ctx, card.agentName.toUpperCase(), 40, bandY, 40, phBright, glow, 'left');
    phosphorText(ctx, card.outcome, CARD_W - 40, bandY, 34, card.done ? gold : phDim, card.done ? glow : '', 'right');
    // the directive/title
    let y = bandY + 40;
    if (card.title) { phosphorText(ctx, '“' + card.title + '”', 40, y, 26, ph, '', 'left'); y += 34; } else { y += 6; }
    // run meta chips
    if (card.chips && card.chips.length) {
      phosphorText(ctx, card.chips.join('   ·   '), 40, y, 24, phDim, '', 'left'); y += 40;
    } else { y += 14; }

    // divider
    ctx.strokeStyle = phDim; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(40, y - 12); ctx.lineTo(CARD_W - 40, y - 12); ctx.stroke();

    // 6 — growth + station record, two columns
    const colY = y + 26;
    if (card.growth) {
      phosphorText(ctx, 'AGENT', 40, colY, 20, phDim, '', 'left');
      const g = card.growth;
      let line = 'Lv ' + g.level;
      if (g.pct > 0) line += '  ·  ' + g.pct + '% to next';
      phosphorText(ctx, line, 40, colY + 34, 30, phBright, glow, 'left');
      const sub = [];
      if (g.tasksDone > 0) sub.push(g.tasksDone + ' shipped');
      if (g.confLabel) sub.push(g.confLabel + ' ' + (g.band || '').toUpperCase());
      if (sub.length) phosphorText(ctx, sub.join('   ·   '), 40, colY + 64, 22, phDim, '', 'left');
    }
    if (card.station) {
      const rx = CARD_W - 40;
      phosphorText(ctx, 'STATION RECORD', rx, colY, 20, phDim, '', 'right');
      const s = card.station;
      const parts = [];
      if (s.tasks != null) parts.push(s.tasks + ' tasks');
      if (s.deliverables != null) parts.push(s.deliverables + ' delivered');
      if (s.workMinutes != null) parts.push(s.workMinutes + ' min worked');
      if (parts.length) phosphorText(ctx, parts.join('   ·   '), rx, colY + 34, 26, phBright, '', 'right');
      if (s.founded) phosphorText(ctx, 'founded ' + s.founded, rx, colY + 64, 22, phDim, '', 'right');
    }

    return canvas;
  }

  // build the offscreen canvas, paint it, and return it. `scene` = live #stage canvas (App wires this in).
  function render(scene, card) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = CARD_W; canvas.height = CARD_H;
    return paint(canvas, scene, card);
  }

  // canvas → Blob (PNG). Promise. Falls back to a dataURL blob if toBlob is unavailable (older webviews).
  function toBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (!canvas) return reject(new Error('no canvas'));
      if (canvas.toBlob) { canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob null')), 'image/png'); return; }
      try {
        const url = canvas.toDataURL('image/png');
        const bin = atob(url.split(',')[1]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        resolve(new Blob([arr], { type: 'image/png' }));
      } catch (e) { reject(e); }
    });
  }

  // a stable, filesystem-safe filename for the download.
  function filename(card) {
    const nm = str(card && card.agentName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
    const stamp = new Date().toISOString().slice(0, 10);
    return 'starnet-' + nm + '-' + stamp + '.png';
  }

  // trigger a browser download of `blob` as `name` (the classic object-URL anchor; revoked after the click).
  function download(blob, name) {
    if (typeof document === 'undefined' || !blob) return;
    let url = null;
    try {
      url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name || 'starnet-postcard.png';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally { if (url) setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 4000); }
  }

  /* THE ONE BROWSER ENTRYPOINT the app calls. Assembles the honest card model, grabs the LIVE #stage
     scene, composites the PNG, and both (a) hands back a data-URL preview canvas so the caller can show
     a draggable thumbnail and (b) downloads the file. opts:
       { run, durMs, agent, pride, scene }  — scene defaults to the live #stage canvas.
     Returns a Promise<{ card, canvas, blob, name }>. Fail-loud to the caller (it decides the UX). */
  async function capture(opts) {
    opts = opts || {};
    const scene = opts.scene || (typeof document !== 'undefined' ? document.getElementById('stage') : null);
    const card = assemble({
      run: opts.run, durMs: opts.durMs, agent: opts.agent,
      xp: (typeof Xp !== 'undefined' ? Xp : null),
      pride: opts.pride, nowMs: Date.now(),
    });
    const canvas = render(scene, card);
    const blob = await toBlob(canvas);
    const name = filename(card);
    download(blob, name);
    return { card, canvas, blob, name };
  }

  return { assemble, render, paint, toBlob, download, capture, filename, CARD_W, CARD_H, _fmt: { usd: fmtUsd, ms: fmtMs, date: fmtDate } };
});
