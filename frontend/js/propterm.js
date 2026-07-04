/* STARNET — propterm.js : per-prop terminal windows.
   v3 — "every prop is a console". Clicking a tagged prop on the station map
   opens a draggable retro window (✕ top-right, click-to-front, remembers its
   position) scoped to that prop's purpose: the Etsy fabricator opens ETSY 1,
   the pixel rig opens the game-asset line, the cal wall opens the publishing
   schedule. Business windows carry a LIVE WORKSTATION feed (progressive ASCII
   deliverable render + streaming agent terminal + token/cost/ctx meters at
   ~7fps), the work order pipeline, today's plan and production telemetry from
   SIM.kindStat. Pure UI — reads SIM state, saves nothing. */
'use strict';

const PROPTERM = (() => {
  const $ = s => document.querySelector(s);
  let host = null;              // window container (#terms — shared with ui.js)
  const wins = {};              // key -> {el, body, def, feeds}
  const lastPos = {};           // key -> {left, top} remembered for the session
  let fastTimer = null, fastN = 0;   // high-rate presentation loop
  let collect = null;           // live-feed agent ids gathered during a build
  let dragKey = null;           // window being dragged (skip its rerender)
  let lastSale = null;          // {amt, t} — fed to LEDGER's live stream
  let spawnN = 0;               // cascade offset for windows opened blind

  const AGENT_COLOR = {}; DATA.AGENTS.forEach(a => AGENT_COLOR[a.id] = a.color);

  /* console designations — every agent has a physical seat */
  const CONSOLE = {
    ULTRON: 'BRIDGE-CORE', NOVA: 'LAB-01', CURIE: 'LAB-02',
    FORGE: 'FAB-01', VECTOR: 'FAB-02', PROMETHEUS: 'FAB-03',
    PIXEL: 'GIG-01', ATLAS: 'GIG-02', QUILL: 'GIG-03', CIPHER: 'GIG-04', VYBES: 'GIG-05',
    HERALD: 'PUB-01', LEDGER: 'TRS-01', ATHENA: 'WAR-01', RAVEN: 'WAR-02',
    RELAY: 'COM-01', SCRIBE: 'ARC-01'
  };

  /* ================= WORK PIPELINES (per deliverable kind) ================= */
  const STAGES = {
    research: ['scrape marketplace listings', 'filter: <24mo age / >1k sales', 'competitor gap analysis', 'price-band + SEO check', 'write actionable brief', 'file brief → factory floor'],
    apparel:  ['pull research brief', 'draft quote candidates ×6', 'GPT-IMAGES-2 render pass', 'Printify mockup + variants', 'SEO title / tags / pricing', 'handoff → HERALD'],
    candle:   ['pull research brief', 'label phrase shortlist ×8', 'label layout render', 'Printify candle template', 'scent pairing + price point', 'handoff → HERALD'],
    custom:   ['parse customer order form', 'reference photo intake', 'style lock + composition', 'GPT-IMAGES-2 render ×4', 'revision + upscale pass', 'handoff → HERALD'],
    fiverr:   ['webhook payload parsed', 'brief + attachments intake', 'composition blockout', 'GPT-IMAGES-2 render', 'headline + arrow pass', 'export 1280×720 <2MB', 'deliver to buyer'],
    assets:   ['scope bundle contents', 'PixelLab batch generation', 'palette + outline unify', 'pack sprite sheets', 'write store page copy', 'handoff → HERALD'],
    article:  ['outline + hook draft', 'draft ~1,400 words', 'insert affiliate links', 'weave in station plugs', 'readability pass', 'handoff → HERALD'],
    saas:     ['spec from pain point', 'scaffold + auth', 'core feature build', 'edge cases + tests', 'landing page', 'beta deploy'],
    song:     ['prompt Suno session', 'generate 4 takes', 'pick + master best take', 'render visualizer loop', 'package for YouTube', 'handoff → HERALD'],
    publish:  ['pull deliverable from queue', 'final QC vs standard', 'platform upload', 'calendar slot confirm', 'listing live check'],
    finance:  ['pull token meters', 'reconcile revenue lines', 'compute burn by model', 'post P&L to board'],
    strategy: ['pull conversion data', 'decay curve analysis', 'stall pattern match', 'write recommendation'],
    pivot:    ['autopsy current strategy', 'draft 3 pivot options', 'pick + write playbook', 'brief the crew'],
    comms:    ['poll all channels', 'classify inbound traffic', 'draft priority replies', 'digest for Commander'],
    archive:  ['collect new context', 'dedupe + index entries', 'link related memories', 'commit to memory banks'],
    directive:['parse Commander intent', 'scope the work', 'execute', 'self-review vs standard', 'report to ULTRON']
  };
  const GENERIC_STAGES = ['intake', 'work in progress', 'self-review', 'deliver'];

  /* ================= LOG LINE POOLS ================= */
  const VERBS = {
    generic: [
      'context window at {pct2}% — compacting', 'tool call #{n2} returned OK ({ms}ms)',
      'checkpoint written to scratch', 'self-eval: on track, continuing',
      '{tok} tokens this step ({ms}ms)', 'retry 1/3 on flaky API call — recovered'
    ],
    research: [
      'scraped {n3} listings ({ms}ms)', 'rejected {n2} listings: older than 24mo',
      'shortlist: {n1} candidates above 1k sales', 'competitor SEO score: {n2}/100 — beatable',
      'price band ${n2}–${n3} confirmed viable', 'review mining: {n2} complaints clustered',
      'proxy rotated — marketplace rate limit dodged', 'trend curve fitted: r²=0.{n2}'
    ],
    apparel: [
      'quote candidate: "{flavor}"', 'GPT-IMAGES-2 seed {seed} — {tok} tokens',
      'render {n1}/6 complete — keeping best 2', 'mockup on unisex heavy-blend template',
      'tag set: {n2} long-tail keywords', 'print area check: 12"×16" — pass',
      'colorway variants: black / sand / sage'
    ],
    candle: [
      'label phrase locked: "{flavor}"', 'label render {n1}/3 at 300dpi',
      'jar template: 9oz amber — Printify SKU ok', 'scent pairing: vanilla+sandalwood',
      'GPT-IMAGES-2 seed {seed} — label art pass', 'margin check at ${n2} price point: {n1}x'
    ],
    custom: [
      'order form parsed — {n1} reference photos', 'style lock: {flavor}',
      'render {n1}/4 — likeness check pending', 'GPT-IMAGES-2 seed {seed}, {tok} tokens',
      'fur/hair detail pass at 2× upscale', 'buyer revision note applied verbatim',
      'final upscale 4096px — print ready'
    ],
    fiverr: [
      'buyer attachment {n1}/{n4} downloaded', 'brief keyword: must match channel style',
      'composition: face top-right, rule of thirds', 'GPT-IMAGES-2 seed {seed} — {tok} tokens',
      'headline pass: 6 words max, all caps', 'saturation +{n2}% on focal point',
      'arrow asset: RED_CHUNKY_03 placed', 'export 1280×720 @ 1.{n1}MB — pass',
      'CTR heuristic score: {n2}/100'
    ],
    assets: [
      'PixelLab job {n3} queued — {n2} sprites', 'tileset seam check: {n2}/64 tiles clean',
      'palette unified to 32 colors', 'animation frames packed 4×4',
      'prop batch {n1}/8 generated', 'preview GIF rendered for store page'
    ],
    article: [
      'hook drafted: {n1} variants', 'word count {n3}/1,400',
      'affiliate link {n1}/3 inserted', 'plug woven in for station store',
      'readability: grade {n1} — target hit', 'header image prompt sent'
    ],
    saas: [
      'commit {n3}: core module', 'tests {n2}/{n3} passing',
      'auth flow wired — magic links', 'edge case found in onboarding — patched',
      'landing copy v{n1} drafted', 'deploy preview spun up ({ms}ms cold start)'
    ],
    song: [
      'Suno take {n1}/4 rendered', 'take {n1} scrapped — chorus too muddy',
      'mastering: -14 LUFS for YouTube', 'visualizer: phosphor bars, {n2}fps',
      'BPM locked at {n2}', 'metadata + thumbnail packaged'
    ],
    publish: [
      'pulled "{flavor}" from outbox', 'QC pass: imagery, copy, price — clean',
      'platform upload {pct2}%', 'calendar slot {hh}:00 confirmed',
      'listing URL live — verified 200 OK'
    ],
    finance: [
      'token meter sweep: {n2} agents read', 'reconciling {n1} revenue lines',
      'burn anomaly check: none', 'P&L draft balanced to the cent'
    ],
    strategy: [
      'conversion delta: {n1}.{n1}% over 48h', 'decay curve knee at day {n1}',
      'pattern match vs {n2} past stalls', 'recommendation drafted — confidence {n2}%'
    ],
    pivot: [
      'autopsy: listing fatigue confirmed', 'option {n1}/3: reposition + price drop',
      'playbook section {n1}/5 written', 'rollout plan: 48h, reversible'
    ],
    comms: [
      '{n2} messages classified', 'platform notice triaged: routine',
      'angry buyer detected — drafting de-escalation', 'Commander digest: {n1} items, {n1} urgent'
    ],
    archive: [
      '{n2} new context entries collected', 'dedupe: {n1} near-duplicates merged',
      'cross-links added: {n1}', 'memory banks committed — fsync ok'
    ],
    directive: [
      'Commander intent parsed — confidence {n2}%', 'scoping: {n1} subtasks identified',
      'executing step {n1}', 'self-review vs station standard'
    ]
  };

  /* live-stream extras: tool calls, reasoning beats, idle heartbeats */
  const TOOLS = {
    research: ['etsy.search {sort:"top_sellers",max_age:"24mo"}', 'trends.fetch {window:"90d"}', 'serp.keywords {batch:{n2}}', 'reviews.mine {depth:{n2}}'],
    apparel:  ['images.generate {model:"gpt-images-2",n:6}', 'printify.products.create {tpl:"heavy-blend"}', 'printify.mockup.render', 'etsy.listings.draft'],
    candle:   ['images.generate {model:"gpt-images-2"}', 'printify.products.create {sku:"9oz-amber"}', 'printify.variants.set {scents:3}', 'etsy.listings.draft'],
    custom:   ['orders.attachments.pull {n:{n1}}', 'images.generate {model:"gpt-images-2",n:4}', 'images.upscale {px:4096}', 'etsy.message.buyer'],
    fiverr:   ['fiverr.orders.pull', 'images.generate {ar:"16:9"}', 'export.png {w:1280,h:720}', 'fiverr.delivery.upload'],
    assets:   ['pixellab.create_topdown_tileset', 'pixellab.create_character {dirs:8}', 'sheet.pack {grid:"4x4"}', 'market.listing.update'],
    article:  ['medium.drafts.create', 'affiliates.link {n:3}', 'seo.score {target:"grade {n1}"}', 'images.generate {hero:1}'],
    saas:     ['git.commit {files:{n1}}', 'tests.run', 'deploy.preview', 'stripe.products.create'],
    song:     ['suno.generate {takes:4}', 'audio.master {lufs:-14}', 'video.visualizer {fps:{n2}}', 'youtube.upload'],
    publish:  ['printify.publish', 'etsy.listings.activate', 'calendar.confirm {slot:"{hh}:00"}', 'health.check {expect:200}'],
    finance:  ['ledger.reconcile {lines:{n2}}', 'meters.poll {agents:17}', 'pnl.post'],
    strategy: ['analytics.query {window:"48h"}', 'decay.fit {curve:"exp"}', 'report.draft'],
    pivot:    ['playbook.draft {sections:5}', 'pricing.simulate {delta:"-12%"}'],
    comms:    ['imap.poll', 'webhooks.drain', 'digest.compose'],
    archive:  ['memory.index {entries:{n2}}', 'dedupe.pass', 'fsync'],
    directive:['scope.parse', 'plan.commit {steps:{n1}}', 'selfreview.run']
  };
  const RESP = ['200 OK', '201 CREATED', '202 ACCEPTED', '200 OK ▪ cache hit'];
  const THINK = [
    'evaluating {n1} candidate directions', 'weighing option {n1} vs {n1} on conversion risk',
    'checking brief constraints before committing', 'grounding against research brief #{n3}',
    'rubric self-check: structure, tone, spec match', 'discarding weak branch — trying angle {n1}',
    'sanity pass vs Commander standard', 'cross-referencing {n2} archived lessons'
  ];
  const IDLE_LINES = [
    'ctx warm — {tok} tokens cached', 'watching dispatch queue…',
    'replaying last deliverable for self-eval', 'prompt patterns defragmented',
    'no work assigned — holding at console', 'memory page-in: prior work loaded'
  ];
  const ULTRON_OVERSIGHT = [
    'delegation matrix recomputed — load balanced', 'verification queue: {n1} pending personal review',
    'standard enforcement sweep: no deviations', 'OPENCLAW heartbeat :18789 — {ms}ms',
    'sampling outbound quality: rolling avg Q{n2}', 'reallocating idle capacity to factory floor',
    'station integrity audit: PASS', 'commander directive ledger synced with SCRIBE'
  ];

  /* ================= NAME POOLS (synth customers) ================= */
  const BUYERS = ['PixelKingTV', 'DanTheGamer99', 'MrsBakesAlot', 'CryptoChadX', 'LofiLoungeVibes', 'TrueCrimeTess', 'FitWithMarco', 'TechTinkerer', 'MidnightSnaxx', 'VloggerVee', 'StonksSensei', 'KiddoArcade', 'GrillDadGary', 'AuntieReviews'];
  const ETSY_BUYERS = ['sarah_m', 'jess.kline', 'mandy_b_84', 'theGiftedAunt', 'kdwilliams', 'plantmom_amy', 'brideTribe22', 'coffeeNcorgi', 'tx_grandma', 'nurse_nat'];
  const CC = ['US', 'UK', 'CA', 'DE', 'AU', 'NL', 'SE', 'BR'];

  /* ================= helpers ================= */
  const esc = U.esc;
  const h = s => U.hash(String(s));
  const stagesOf = t => STAGES[t.kind] || GENERIC_STAGES;
  const stageIdx = t => {
    const st = stagesOf(t);
    return Math.min(st.length - 1, Math.floor((t.prog / t.dur) * st.length));
  };
  const pctOf = t => Math.min(99, Math.round(t.prog / t.dur * 100));
  const buyerOf = t => BUYERS[h(t.id) % BUYERS.length] + ' (' + CC[(h(t.id) >>> 4) % CC.length] + ')';
  const etsyBuyerOf = t => ETSY_BUYERS[h(t.id) % ETSY_BUYERS.length];
  const orderNo = (t, pfx) => '#' + pfx + '-' + (1000 + h(t.id) % 9000);
  const etaOf = t => U.fmtTime(SIM.S.time + Math.max(1, Math.round(t.dur - t.prog)));
  const activeTaskOf = agId => SIM.S.tasks.find(t => t.agentId === agId && t.status === 'active');

  function fill(tpl, t) {
    return tpl
      .replace('{flavor}', t && t.flavor ? String(t.flavor).slice(0, 46) : 'untitled')
      .replace('{seed}', 100000 + (h((t ? t.id : 'x') + Math.floor(SIM.S.time / 3)) % 899999))
      .replace('{tok}', (U.irnd(8, 64) * 100).toLocaleString())
      .replace('{ms}', U.irnd(28, 900))
      .replace('{pct2}', U.irnd(12, 96))
      .replace('{hh}', U.pad2(Math.floor((SIM.S.time % 1440) / 60)))
      .replace(/\{n1\}/g, U.irnd(1, 8))
      .replace(/\{n2\}/g, U.irnd(12, 96))
      .replace(/\{n3\}/g, U.irnd(120, 980))
      .replace(/\{n4\}/g, U.irnd(3, 9));
  }

  /* ================= tiny components ================= */
  const bar = (pct, cls) => '<div class="rt-bar' + (cls ? ' ' + cls : '') + '"><div style="width:' + U.clamp(pct, 0, 100) + '%"></div></div>';
  const kv = (k, v) => '<div class="rt-kv"><span>' + k + '</span><b>' + v + '</b></div>';
  const agTag = id => '<span class="rt-ag" data-agent="' + id + '" style="color:' + AGENT_COLOR[id] + '">' + id + '</span>';
  const dimi = s => '<i class="dim">' + s + '</i>';
  const sub = s => '<div class="rt-sub">' + s + '</div>';
  const cols = (a, b) => '<div class="pw-cols"><div>' + a + '</div><div>' + b + '</div></div>';
  const chainRow = (role, who, info) => '<div class="rt-chain"><span class="rt-chain-role">' + role + '</span><span>' + who + '</span><span class="rt-chain-info">' + info + '</span></div>';

  function spark(vals, colorize) {
    if (!vals.length) return dimi('no history yet');
    const GL = '▁▂▃▄▅▆▇█';
    const mx = Math.max(1, ...vals.map(v => Math.abs(v)));
    return '<span class="rt-spark">' + vals.map(v => {
      const c = GL[U.clamp(Math.round(Math.abs(v) / mx * 7), 0, 7)];
      return (colorize && v < 0) ? '<span class="bad">' + c + '</span>' : c;
    }).join('') + '</span>';
  }

  /* where is this agent's body, physically, right now */
  function presenceOf(id) {
    const b = WORLD.bodies[id]; if (!b) return '—';
    const room = MAP.roomAt(b.tile.x, b.tile.y), home = DATA.AGENT[id].room;
    if (b.state === 'walk') return 'EN ROUTE';
    if (room === home) return (b.state === 'work' && b.sitting) ? 'AT CONSOLE' : 'ON DECK';
    if (room === 'quarters') return 'OFF DECK — QUARTERS';
    return DATA.ROOMS[room] ? ('AT ' + DATA.ROOMS[room].name.split(' —')[0]) : 'IN CORRIDOR';
  }

  /* ============================================================
     LIVE CANVAS ENGINE — progressive ASCII render of the deliverable
     ============================================================ */
  const CW = 34, CH = 13;
  const maskCache = {};
  const SH1 = [' ', '░', '░', '▒'], SH2 = ['▒', '▓', '█', '▓'];

  function grid0() { return new Array(CW * CH).fill(0); }
  function rectG(g, x0, y0, x1, y1, v) {
    for (let y = Math.max(0, y0); y <= Math.min(CH - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(CW - 1, x1); x++) g[y * CW + x] = v;
  }
  function ellipseG(g, cx, cy, rx, ry, v) {
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) g[y * CW + x] = v;
    }
  }

  function maskTee(g) {
    rectG(g, 1, 1, CW - 2, 3, 1);                       // sleeves band
    rectG(g, 8, 1, CW - 9, CH - 1, 1);                  // torso
    rectG(g, 1, 4, 7, CH - 1, 0);                       // trim under left sleeve
    rectG(g, CW - 8, 4, CW - 2, CH - 1, 0);             // trim under right sleeve
    rectG(g, (CW >> 1) - 2, 1, (CW >> 1) + 1, 1, 0);    // collar notch
    rectG(g, 12, 4, CW - 13, CH - 4, 2);                // print zone
  }
  function maskJar(g) {
    rectG(g, 12, 0, CW - 13, 0, 1);                     // knob
    rectG(g, 9, 1, CW - 10, 1, 1);                      // lid
    rectG(g, 8, 2, CW - 9, CH - 1, 1);                  // jar glass
    rectG(g, 10, 4, CW - 11, CH - 4, 2);                // label art
  }
  function maskPortrait(g) {
    rectG(g, 3, 0, CW - 4, CH - 1, 1);                  // canvas
    ellipseG(g, (CW - 1) / 2, 4, 4.4, 3.4, 2);          // head
    rectG(g, (CW >> 1) - 7, 9, (CW >> 1) + 6, CH - 1, 2); // shoulders
  }
  function maskThumb(g) {
    rectG(g, 0, 0, CW - 1, CH - 1, 1);                  // 16:9 frame
    ellipseG(g, CW - 9, 4, 4.6, 3.2, 2);                // face, top-right
    rectG(g, 2, CH - 4, CW - 3, CH - 2, 2);             // headline bar
    [[5, 9], [7, 8], [9, 8], [11, 7], [13, 6], [15, 6], [16, 5], [17, 4], [17, 6], [18, 5]]
      .forEach(p => { g[p[1] * CW + p[0]] = 3; });      // the mandatory red arrow
  }
  function maskTiles(g) {                               // returns reveal order: tile by tile
    const order = [];
    for (let ty = 0; ty < 3; ty++) for (let tx = 0; tx < 8; tx++) {
      const x0 = 1 + tx * 4, y0 = ty * 4;
      for (let y = y0; y < y0 + 3; y++) for (let x = x0; x < x0 + 3; x++) {
        g[y * CW + x] = 2; order.push(y * CW + x);
      }
    }
    return order;
  }
  function maskDoc(g, v) {
    rectG(g, 2, 0, 2 + 10 + (v % 6), 0, 2);             // title line
    for (let y = 2; y < CH; y++) {
      if ((y + v) % 5 === 4) continue;                  // paragraph gaps
      rectG(g, 2, y, 2 + 8 + h('dl' + y + v) % (CW - 12), y, 2);
    }
  }
  function maskCode(g, v) {
    for (let y = 0; y < CH; y++) {
      if ((y + v) % 7 === 6) continue;
      const ind = (h('ci' + y + v) % 4) * 2;
      rectG(g, 2 + ind, y, 2 + ind + 4 + h('cl' + y + v) % (CW - 14 - ind), y, 2);
    }
  }

  function getMask(mode, seed) {
    const seeded = (mode === 'doc' || mode === 'code');
    const key = mode + (seeded ? ':' + (seed % 8) : '');
    if (maskCache[key]) return maskCache[key];
    const g = grid0(); let order = null;
    if (mode === 'tee') maskTee(g);
    else if (mode === 'jar') maskJar(g);
    else if (mode === 'portrait') maskPortrait(g);
    else if (mode === 'thumb') maskThumb(g);
    else if (mode === 'tiles') order = maskTiles(g);
    else if (mode === 'code') maskCode(g, seed % 8);
    else maskDoc(g, seed % 8);
    if (!order) { order = []; for (let i = 0; i < g.length; i++) if (g[i]) order.push(i); }
    const rank = new Int32Array(CW * CH).fill(1 << 30);
    order.forEach((idx, n) => { rank[idx] = n; });
    return maskCache[key] = { g, order, rank };
  }

  function cellChar(v, x, y, seed) {
    if (v === 3) return '█';
    const r = h('cc' + (x >> 1) + ',' + y + ',' + seed); // 2-wide blocks read chunky
    return (v === 1 ? SH1 : SH2)[r % 4];
  }

  function drawMask(mode, t) {
    const seed = h(t.id);
    const mk = getMask(mode, seed);
    const pct = Math.min(100, pctOf(t) + 2);
    const reveal = Math.floor(mk.order.length * pct / 100);
    const rows = [];
    for (let y = 0; y < CH; y++) {
      let r = '';
      for (let x = 0; x < CW; x++) {
        const i = y * CW + x, v = mk.g[i];
        if (!v) { r += h('o' + i + ',' + (fastN >> 3)) % 97 === 0 ? '·' : ' '; continue; }
        const rk = mk.rank[i];
        if (rk < reveal) r += cellChar(v, x, y, seed);
        else if (rk === reveal) r += (fastN % 2 ? '▌' : '▐');     // render head
        else r += h('u' + i + ',' + (fastN >> 2)) % 29 === 0 ? '·' : ' ';
      }
      rows.push(r);
    }
    return rows.join('\n');
  }

  function drawStandby(agId) {
    const rows = [];
    for (let y = 0; y < CH; y++) {
      let r = '';
      for (let x = 0; x < CW; x++) r += h('s' + x + ',' + y + ',' + (fastN >> 3) + agId) % 37 === 0 ? '·' : ' ';
      rows.push(r);
    }
    const put = (yy, msg) => {
      const p = Math.max(0, (CW - msg.length) >> 1);
      rows[yy] = rows[yy].slice(0, p) + msg + rows[yy].slice(p + msg.length);
    };
    put(5, '— AWAITING DISPATCH —');
    put(7, 'console idle ▪ ctx warm');
    return rows.join('\n');
  }

  function drawMatrix() {
    const S = SIM.S;
    const crew = DATA.AGENTS.filter(a => a.id !== 'ULTRON');
    const stateCh = a => {
      const ag = S.agents[a.id];
      if (S.feedback.some(f => f.agentId === a.id && f.status === 'open')) return '▲';
      return ag.taskId ? (fastN % 2 ? '█' : '▓') : '░';
    };
    const cells = r => ' ' + crew.slice(r * 8, r * 8 + 8).map(a => ' ' + stateCh(a) + '  ').join('');
    const names = r => ' ' + crew.slice(r * 8, r * 8 + 8).map(a => (a.id + '   ').slice(0, 3) + ' ').join('');
    const act = S.tasks.filter(t => t.status === 'active').length;
    const todo = S.tasks.filter(t => t.status === 'todo').length;
    const rev = S.feedback.filter(f => f.status === 'open').length;
    const working = crew.filter(a => S.agents[a.id].taskId).length;
    return [
      ' DELEGATION GRID — LIVE LOAD', '',
      cells(0), names(0), '',
      cells(1), names(1), '',
      ' ' + '─'.repeat(CW - 2),
      ' ACTIVE ' + act + ' ▪ QUEUED ' + todo + ' ▪ QC ' + rev,
      ' LOAD  ' + '█'.repeat(working) + '░'.repeat(Math.max(0, 16 - working)),
      ' █ working ░ idle ▲ needs review'
    ].join('\n');
  }

  function drawGraph() {
    const S = SIM.S;
    const hist = S.history.slice(-10).map(d => d.rev - d.costs);
    hist.push(S.dayAcc.rev - S.dayAcc.costs);
    const mx = Math.max(1, ...hist.map(v => Math.abs(v)));
    const plotH = CH - 3;
    const rows = [' NET BY DAY ($)' + ' '.repeat(Math.max(1, CW - 23)) + 'today ▸'];
    for (let y = 0; y < plotH; y++) {
      let r = ' ';
      for (let i = 0; i < hist.length; i++) {
        const hgt = Math.max(1, Math.round(Math.abs(hist[i]) / mx * plotH));
        r += ((plotH - 1 - y) < hgt) ? (hist[i] < 0 ? '▒▒' : '██') : '  ';
        r += ' ';
      }
      rows.push(r);
    }
    rows.push(' ' + hist.map((v, i) => i === hist.length - 1 ? '▔▔' : '──').join(' '));
    rows.push(' ▒ loss day ▪ █ profit day');
    return rows.join('\n');
  }

  const NETCH = ['ETS', 'FVR', 'PRN', 'MED', 'YTB', 'SUN', 'OCG'];
  function drawNet() {
    const rows = [' CHANNEL TRAFFIC — LIVE RX'];
    for (let y = 0; y < CH - 3; y++) {
      let r = ' ';
      for (let c = 0; c < 7; c++) {
        for (let x = 0; x < 3; x++) {
          const v = h('net' + c + ',' + x + ',' + (((y * 7 + c * 3) - (fastN >> 1)) % 97)) % 23;
          r += v < 2 ? '█' : v < 5 ? '·' : ' ';
        }
        r += ' ';
      }
      rows.push(r);
    }
    rows.push(' ' + NETCH.join(' '));
    rows.push(' rx nominal ▪ 0 dropped');
    return rows.join('\n');
  }

  function drawWave() {
    const rows = [' SPECTRUM — MUSIC BAY OUTPUT'];
    for (let y = 0; y < CH - 2; y++) {
      let r = '';
      for (let x = 0; x < CW; x++) {
        const ph = Math.sin(x * 0.42 + fastN * 0.16) + Math.sin(x * 0.19 - fastN * 0.09) + (h('w' + x) % 100) / 125;
        const hgt = U.clamp(Math.round(5.2 + 2.7 * ph), 1, CH - 3);
        const fromBot = CH - 3 - y;
        r += fromBot < hgt ? (fromBot === hgt - 1 ? '▓' : '█') : ' ';
      }
      rows.push(r);
    }
    rows.push(' 84 BPM ▪ -14 LUFS ▪ phosphor mode');
    return rows.join('\n');
  }

  function drawCal() {
    const S = SIM.S;
    const q = S.tasks.filter(t => t.kind === 'publish' && (t.status === 'todo' || t.status === 'active'));
    const today = Math.floor(S.time / 1440);
    const shipped = S.tasks.filter(t => t.kind === 'publish' && t.status === 'done' && Math.floor((t.doneT || 0) / 1440) === today).length;
    const hourNow = Math.floor((S.time % 1440) / 60);
    const states = []; let used = 0;
    for (let hh = 9; hh <= 19; hh++) {
      if (hh < hourNow) { states.push(used < shipped ? 'S' : '-'); used++; }
      else if (hh === hourNow) states.push(q.length ? 'U' : 'o');
      else states.push((hh - hourNow) <= q.length ? 'R' : 'o');
    }
    const rows = [' PUBLISH CALENDAR — TODAY', ''];
    for (let y = 0; y < 6; y++) {
      let r = ' ';
      states.forEach(s => {
        let c = ' ';
        if (s === 'S') c = '█';
        else if (s === 'U') c = (y >= (fastN % 4)) ? '▓' : ' ';
        else if (s === 'R') c = y >= 3 ? '▒' : ' ';
        else c = y === 5 ? '░' : ' ';
        r += c + c + ' ';
      });
      rows.push(r);
    }
    rows.push(' 09 10 11 12 13 14 15 16 17 18 19');
    rows.push(' shipped ' + shipped + ' ▪ queued ' + q.length);
    rows.push(' █ shipped ▓ uploading ▒ reserved');
    return rows.join('\n');
  }

  const CANVAS_KIND = {
    apparel: 'tee', candle: 'jar', custom: 'portrait', fiverr: 'thumb', assets: 'tiles',
    article: 'doc', research: 'doc', saas: 'code', song: 'wave', publish: 'cal',
    finance: 'graph', strategy: 'graph', pivot: 'doc', comms: 'doc', archive: 'doc', directive: 'doc'
  };

  function drawCanvas(agId, t) {
    const cfg = FEEDCFG[agId] || {};
    const mode = cfg.canvas || (t ? CANVAS_KIND[t.kind] : null);
    if (mode === 'matrix') return drawMatrix();
    if (mode === 'net') return drawNet();
    if (mode === 'wave') return drawWave();
    if (mode === 'graph') return drawGraph();
    if (mode === 'cal') return drawCal();
    if (!t || !mode) return drawStandby(agId);
    return drawMask(mode, t);
  }

  /* ============================================================
     LIVE FEED ENGINE — streaming agent terminal, typed char by char
     ============================================================ */
  const FEED = {};   // agId -> {lines, cur, target, pend, tok, lastTask}

  function ultronGen() {
    const S = SIM.S;
    const act = S.tasks.filter(t => t.status === 'active' && t.agentId !== 'ULTRON');
    if (act.length && Math.random() < 0.65) {
      const t = U.pick(act);
      const sgs = stagesOf(t), si = stageIdx(t);
      return '▸ ' + t.agentId + ' step ' + (si + 1) + '/' + sgs.length + ' — ' + sgs[si] + ' [' + pctOf(t) + '%]';
    }
    return fill(U.pick(ULTRON_OVERSIGHT), null);
  }
  function relayGen() {
    if (Math.random() < 0.55) {
      const chn = U.pick(['ETSY-MAIL', 'FIVERR-WH', 'PRINTIFY', 'MEDIUM', 'YOUTUBE', 'SUNO', 'OPENCLAW']);
      return U.pick(['RX', 'TX']) + ' ' + chn + ' ▸ ' + U.irnd(1, 9) + ' pkt / ' + U.irnd(18, 140) + 'ms' + (U.chance(0.12) ? ' ▪ retry ok' : '');
    }
    return null;
  }
  function ledgerGen() {
    if (lastSale && (SIM.S.time - lastSale.t) < 40 && Math.random() < 0.4)
      return 'reconciled +' + U.money(lastSale.amt) + ' → revenue ledger (line ' + U.irnd(200, 900) + ')';
    return null;
  }
  function ravenGen() {
    const S = SIM.S;
    const nm = U.pick(['APPAREL', 'CANDLES', 'PERSONALIZED', 'GAME ASSETS', 'AFFILIATE', 'FIVERR', 'SAAS']);
    const wob = (h(nm + Math.floor(S.time / 180)) % 41) - 20;
    return nm + ' conversion drift ' + (wob >= 0 ? '+' : '') + wob + '% / 48h' + (wob < -14 ? ' ⚠ pivot-ready' : '');
  }
  function heraldGen(t) {
    if (t && t.kind === 'publish')
      return 'uploading "' + String(t.flavor || '').slice(0, 30) + '" — ' + pctOf(t) + '% / slot ' + etaOf(t);
    return null;
  }

  const FEEDCFG = {
    ULTRON: { canvas: 'matrix', alwaysOn: true, gen: ultronGen },
    RELAY:  { canvas: 'net',    alwaysOn: true, gen: relayGen,  kind: 'comms' },
    LEDGER: { canvas: 'graph',  alwaysOn: true, gen: ledgerGen, kind: 'finance' },
    RAVEN:  { canvas: 'graph',  alwaysOn: true, gen: ravenGen,  kind: 'strategy' },
    ATHENA: { canvas: 'graph',  kind: 'strategy' },
    HERALD: { canvas: 'cal',    gen: heraldGen, kind: 'publish' },
    VYBES:  { canvas: 'wave' },
    JUKE:   { canvas: 'wave', canvasOnly: true }
  };

  function pushFsLine(st, txt, cls) {
    st.lines.push({ txt, cls: cls || '' });
    if (st.lines.length > 9) st.lines.splice(0, st.lines.length - 9);
  }

  function nextLine(agId, t) {
    const st = FEED[agId], cfg = FEEDCFG[agId];
    if (st.pend) { const p = st.pend; st.pend = null; return p; }
    if (cfg && cfg.gen) { const l = cfg.gen(t); if (l) return l; }
    const kind = t ? t.kind : (cfg && cfg.kind) || null;
    const r = Math.random();
    if (kind && TOOLS[kind] && r < 0.30) {
      st.pend = '◀ ' + U.pick(RESP) + ' (' + U.irnd(38, 900) + 'ms)';
      return '▶ ' + fill(U.pick(TOOLS[kind]), t);
    }
    if (r < 0.45) return '… ' + fill(U.pick(THINK), t);
    if (kind) return fill(U.pick((VERBS[kind] || []).concat(VERBS.generic)), t);
    return fill(U.pick(IDLE_LINES), null);
  }

  function feedState(agId) {
    let st = FEED[agId];
    if (!st) {
      st = FEED[agId] = { lines: [], cur: '', target: null, pend: null, tok: U.irnd(8, 40) * 100, lastTask: null };
      const t = activeTaskOf(agId);
      for (let i = 0; i < 5; i++) pushFsLine(st, nextLine(agId, t), i % 3 === 2 ? 'dim' : '');
      st.pend = null;
      if (t) st.lastTask = t.id;
    }
    return st;
  }

  function streamHTML(st) {
    return st.lines.slice(-7).map(l =>
      '<div class="rt-fs-ln ' + l.cls + '">' + esc(l.txt) + '</div>').join('') +
      '<div class="rt-fs-ln cur">' + esc(st.cur) + '<span class="rt-cur">█</span></div>';
  }

  const uplinkMs = agId => 22 + h(agId + ':' + (fastN >> 4)) % 130;
  const ctxPct = t => Math.round(t ? 14 + pctOf(t) * 0.62 : 8);
  function estCost(agId, t) {
    const m = DATA.MODELS[DATA.AGENT[agId].model];
    if (!t) return '$0.00';
    return '$' + (m.costMin + (m.costMax - m.costMin) * pctOf(t) / 100).toFixed(2);
  }
  function feedCaption(agId, t) {
    if (!t) return 'no active dispatch — console idle';
    return DATA.KINDS[t.kind].label + ' ▸ ' + String(t.flavor || t.title).slice(0, 40) + ' ▪ WO ' + orderNo(t, 'WO').slice(1);
  }

  function feedHTML(agId) {
    if (collect) collect.push(agId);
    const a = DATA.AGENT[agId], t = activeTaskOf(agId), st = feedState(agId);
    return '<div class="rt-feed">' +
      '<div class="rt-feed-head">' +
        '<span class="rt-live">▮ LIVE</span>' +
        '<span style="color:' + AGENT_COLOR[agId] + '">' + agId + '</span>' +
        '<span class="dim">@ ' + (CONSOLE[agId] || 'CONSOLE') + '</span>' +
        '<span class="rt-feed-fill"></span>' +
        '<span>' + DATA.MODELS[a.model].name + '</span>' +
        '<span class="dim" id="fu-' + agId + '">' + uplinkMs(agId) + 'ms</span>' +
      '</div>' +
      '<div class="rt-feed-cap" id="fcap-' + agId + '">' + esc(feedCaption(agId, t)) + '</div>' +
      '<div class="rt-feed-canvas"><pre id="fc-' + agId + '">' + drawCanvas(agId, t) + '</pre></div>' +
      '<div class="rt-feed-meters">' +
        '<span>TOK <b id="ft-' + agId + '">' + st.tok.toLocaleString() + '</b></span>' +
        '<span>COST <b id="fm-' + agId + '">' + estCost(agId, t) + '</b></span>' +
        '<span class="rt-ctx">CTX <span class="rt-ctxbar"><span id="fx-' + agId + '" style="width:' + ctxPct(t) + '%"></span></span></span>' +
      '</div>' +
      '<div class="rt-feed-stream" id="fs-' + agId + '">' + streamHTML(st) + '</div>' +
    '</div>';
  }

  function fastTick() {
    fastN++;
    const seen = {};
    for (const key in wins) {
      for (const agId of (wins[key].feeds || [])) {
        if (seen[agId]) continue;
        seen[agId] = 1;
        const cfg = FEEDCFG[agId] || {};
        const t = DATA.AGENT[agId] ? activeTaskOf(agId) : null;
        if (cfg.canvasOnly) {
          const fc = $('#fc-' + agId);
          if (fc) fc.textContent = drawCanvas(agId, t);
          continue;
        }
        const st = feedState(agId);
        // job transitions
        if (t && st.lastTask !== t.id) {
          st.lastTask = t.id; st.cur = ''; st.target = null; st.pend = null;
          st.tok = U.irnd(4, 14) * 100;
          pushFsLine(st, '── dispatch accepted: WO ' + orderNo(t, 'WO').slice(1) + ' "' + String(t.flavor || t.title).slice(0, 40) + '"', 'good');
        } else if (!t && st.lastTask) {
          st.lastTask = null; st.cur = ''; st.target = null; st.pend = null;
          pushFsLine(st, '── deliverable handed off — console idle', 'dim');
        }
        // typing
        if (t || cfg.alwaysOn) {
          if (!st.target) st.target = nextLine(agId, t);
          st.cur = st.target.slice(0, st.cur.length + U.irnd(2, 5));
          if (st.cur.length >= st.target.length) {
            pushFsLine(st, st.target, st.target.charAt(0) === '◀' ? 'dim' : '');
            st.cur = ''; st.target = null;
          }
          if (t) st.tok += U.irnd(9, 70);
          else st.tok += U.irnd(0, 9);
        } else if (U.chance(0.025)) {
          pushFsLine(st, fill(U.pick(IDLE_LINES), null), 'dim');
        }
        // DOM
        const fs = $('#fs-' + agId); if (fs) fs.innerHTML = streamHTML(st);
        const fc = $('#fc-' + agId); if (fc) fc.textContent = drawCanvas(agId, t);
        const ft = $('#ft-' + agId); if (ft) ft.textContent = st.tok.toLocaleString();
        const fm = $('#fm-' + agId); if (fm) fm.textContent = estCost(agId, t);
        const fx = $('#fx-' + agId); if (fx) fx.style.width = ctxPct(t) + '%';
        const fcap = $('#fcap-' + agId); if (fcap) fcap.textContent = feedCaption(agId, t);
        if (fastN % 22 === 0) { const fu = $('#fu-' + agId); if (fu) fu.textContent = uplinkMs(agId) + 'ms'; }
      }
    }
  }

  /* ================= STAGE LINE GENERATOR ================= */
  function stageLines(t, si) {
    const pool = (VERBS[t.kind] || []).concat(VERBS.generic);
    const bucket = Math.floor(SIM.S.time / 9);
    const out = [];
    for (let i = 0; i < 2; i++) {
      const idx = h(t.id + String(si * 7 + i * 31 + bucket * 13)) % pool.length;
      out.push(fill(pool[idx], t));
    }
    return out;
  }

  function metaLine(t) {
    const bits = [];
    switch (t.kind) {
      case 'fiverr':
        bits.push('ORDER ' + orderNo(t, 'FVR'), 'BUYER: ' + buyerOf(t), 'DUE ' + etaOf(t)); break;
      case 'custom':
        bits.push('ORDER ' + orderNo(t, 'ETSY'), 'BUYER: ' + etsyBuyerOf(t), 'DUE ' + etaOf(t)); break;
      case 'apparel': bits.push('STORE: APPAREL', 'ETA ' + etaOf(t)); break;
      case 'candle': bits.push('STORE: CANDLES', 'ETA ' + etaOf(t)); break;
      case 'assets': bits.push('MARKET: INDIE GAME-DEV', 'ETA ' + etaOf(t)); break;
      case 'article': bits.push('PLATFORM: MEDIUM', 'ETA ' + etaOf(t)); break;
      case 'song': bits.push('PLATFORM: YOUTUBE', 'ETA ' + etaOf(t)); break;
      case 'saas': bits.push('PROJECT: ' + esc(String(t.flavor || '').slice(0, 28)), 'ETA ' + etaOf(t)); break;
      case 'research': bits.push('TARGET: ' + ({ etsy1: 'APPAREL', etsy2: 'CANDLES', etsy3: 'PERSONALIZED', saas: 'SAAS LEADS' }[t.target] || 'GENERAL'), 'ETA ' + etaOf(t)); break;
      case 'publish': bits.push('PAYLOAD: ' + (DATA.KINDS[t.payloadKind] ? DATA.KINDS[t.payloadKind].label : '—'), 'SLOT ' + etaOf(t)); break;
      default: bits.push('ETA ' + etaOf(t));
    }
    const rv = DATA.KINDS[t.kind] && DATA.KINDS[t.kind].rev;
    if (rv) bits.push('EST $' + rv[0] + '–' + rv[1]);
    if (t.playerOrder) bits.push('<span class="rt-chip gold">COMMANDER ORDER</span>');
    return bits.join(' ▪ ');
  }

  function jobCard(t) {
    const st = stagesOf(t);
    const si = t.status === 'active' ? stageIdx(t) : -1;
    const pct = t.status === 'active' ? pctOf(t) : 0;
    const isActive = t.status === 'active';
    const isQueued = t.status === 'todo';

    const stageWidth = 100 / st.length;
    const stepPct = si >= 0 ? Math.max(0, Math.min(99, Math.round((pct - si * stageWidth) / stageWidth * 100))) : 0;

    let spotlight = '';
    if (isActive && si >= 0) {
      const lines = stageLines(t, si);
      spotlight =
        '<div class="rt-spot">' +
          '<div class="rt-spot-hdr">' +
            '<span class="rt-spot-step">STEP ' + (si + 1) + '/' + st.length + '</span>' +
            '<span class="rt-spot-name">' + st[si].toUpperCase() + '</span>' +
          '</div>' +
          bar(stepPct, 'inner') +
          lines.map(l => '<div class="rt-spot-ln">' + esc(t.agentId) + ' ▸ ' + l + '</div>').join('') +
        '</div>';
    }

    const pipe =
      '<div class="rt-pipe">' +
      st.map((s, i) => {
        const cls = i < si ? 'done' : i === si ? 'cur' : '';
        const lbl = s.replace(/→.*/, '').replace(/[××]\d+/g, '').trim().toUpperCase().slice(0, 11);
        return (i > 0 ? '<div class="rt-pipe-wire' + (i <= si ? ' done' : '') + '"></div>' : '') +
          '<div class="rt-pipe-node ' + cls + '" title="' + esc(s) + '">' +
            '<div class="rt-pipe-dot"></div>' +
            '<div class="rt-pipe-lbl">' + lbl + '</div>' +
          '</div>';
      }).join('') +
      '</div>';

    const flag = t.flagReview;
    const ctrl =
      '<div class="rt-ctrl">' +
        (isQueued ? '<button class="rt-btn" data-job="' + t.id + '" data-action="prioritize">↑ PRIORITY</button>' : '') +
        (isActive && si < st.length - 1 ? '<button class="rt-btn rt-btn-rush" data-job="' + t.id + '" data-action="rush">⏭ RUSH STEP' + (t.rushPenalty ? ' (-' + (t.rushPenalty * 7) + 'Q)' : '') + '</button>' : '') +
        '<button class="rt-btn' + (flag ? ' rt-btn-flag' : '') + '" data-job="' + t.id + '" data-action="flag">' + (flag ? '⚑ FLAGGED' : '⚐ FLAG REVIEW') + '</button>' +
      '</div>';

    return '<div class="rt-job' + (flag ? ' rt-job-flag' : '') + '">' +
      '<div class="rt-job-top">' + agTag(t.agentId) +
        '<span class="rt-job-pct">' + (isActive ? pct + '%' : 'QUEUED') + '</span>' +
      '</div>' +
      '<div class="rt-job-title">' + esc(String(t.flavor || t.title).slice(0, 70)) + '</div>' +
      '<div class="rt-job-meta">' + metaLine(t) + '</div>' +
      (isActive ? bar(pct) : '') +
      spotlight +
      pipe +
      ctrl +
    '</div>';
  }
  const idleCard = (id, txt) => '<div class="rt-job idle">' +
    '<div class="rt-job-top">' + agTag(id) + '<span class="rt-job-pct dim">IDLE</span></div>' +
    '<div class="rt-job-meta">' + esc(txt || SIM.S.agents[id].statusTxt) + '</div></div>';

  function workOrder(agId) {
    const act = activeTaskOf(agId);
    return act ? jobCard(act) : idleCard(agId);
  }

  /* the operator strip — who runs this console, where they physically are,
     what they're doing this second; flags surface the feedback queue */
  function operator(agId) {
    const ag = SIM.S.agents[agId];
    const flagged = SIM.S.feedback.some(f => f.agentId === agId && f.status === 'open');
    return '<div class="pw-op">' + agTag(agId) +
      '<span class="pw-op-pres">' + presenceOf(agId) + '</span>' +
      '<span class="pw-op-status">' + esc(ag.statusTxt) + '</span></div>' +
      (flagged ? '<div class="pw-flagrow" data-fb>⚑ DELIVERABLE AWAITING JUDGEMENT — OPEN FEEDBACK</div>' : '');
  }

  function agentFile(agId) {
    const a = DATA.AGENT[agId], ag = SIM.S.agents[agId];
    return kv('ROLE', a.role) +
      kv('HARNESS', a.harness === 'OPENCLAW' ? '<span class="bad">OPENCLAW</span>' : 'STARNET') +
      kv('MODEL', DATA.MODELS[a.model].name) +
      kv('POSITION', presenceOf(agId)) +
      kv('SKILL', Math.round(ag.skill)) + bar(ag.skill) +
      kv('MORALE', Math.round(ag.morale)) + bar(ag.morale, ag.morale < 45 ? 'low' : '') +
      kv('TASKS DONE', ag.tasksDone) +
      kv('EARNED', '<span class="pos">' + U.money(ag.earned) + '</span>') +
      kv('BURNED', '<span class="bad">' + U.money(ag.spent) + '</span>');
  }

  function recentByAgent(agIds, n) {
    const list = SIM.S.tasks.filter(t => agIds.includes(t.agentId) && t.status === 'done' && t.kind !== 'publish').slice(-(n || 8)).reverse();
    return list.length ? list.map(t => {
      let who = '';
      if (t.kind === 'fiverr') who = ' → ' + buyerOf(t);
      else if (t.kind === 'custom') who = ' → ' + etsyBuyerOf(t);
      return '<div class="rt-row">' + esc(String(t.flavor || t.title).slice(0, 52)) + who +
        '<i>' + (t.quality ? 'Q' + t.quality : '✓') + ' ' + U.fmtTime(t.doneT || t.createdT) + '</i></div>';
    }).join('') : dimi('nothing shipped yet');
  }

  /* live order book for buyer-driven lines (custom portraits, fiverr gigs) */
  function orderBoard(kind, pfx, buyerFn, n) {
    const list = SIM.S.tasks.filter(t => t.kind === kind && ['todo', 'active', 'review'].includes(t.status)).slice(0, n || 5);
    if (!list.length) return dimi('order book clear — listings live, waiting on buyers');
    return list.map(t => {
      const stat = t.status === 'active' ? pctOf(t) + '%' : t.status === 'review' ? '<span class="warn">QC HOLD</span>' : 'QUEUED';
      return '<div class="rt-row"><span class="rt-chip">' + orderNo(t, pfx) + '</span> ' + esc(buyerFn(t)) +
        ' ▪ ' + esc(String(t.flavor || '').slice(0, 30)) + '<i>' + stat + ' ▪ due ' + etaOf(t) + '</i></div>';
    }).join('');
  }

  /* who feeds this business, who builds, who checks, who ships */
  function chainFor(o) {
    const S = SIM.S;
    const pubQ = S.tasks.filter(t => t.kind === 'publish' && t.payloadKind === o.kind && (t.status === 'todo' || t.status === 'active')).length;
    const supply = o.supply || ['NOVA', o.store ? (S.insights[o.store] || 0) + ' briefs ready' : 'intel feed'];
    const supplyWho = DATA.AGENT[supply[0]] ? agTag(supply[0]) : '<span class="dim">' + supply[0] + '</span>';
    const ship = o.ship || ['HERALD', pubQ ? pubQ + ' queued in outbox' : 'outbox clear'];
    const shipWho = DATA.AGENT[ship[0]] ? agTag(ship[0]) : '<span class="dim">' + ship[0] + '</span>';
    return chainRow('SUPPLY', supplyWho, supply[1]) +
      chainRow('BUILD', agTag(o.ag), presenceOf(o.ag)) +
      chainRow('QC', agTag('ULTRON'), 'verifies vs standard') +
      chainRow('SHIP', shipWho, ship[1]);
  }

  /* production + sales telemetry for one business line */
  function bizTelemetry(o) {
    const S = SIM.S;
    const k = SIM.kindStat(o.kind);
    const inProd = S.tasks.filter(t => t.kind === o.kind && (t.status === 'todo' || t.status === 'active')).length;
    const pubQ = S.tasks.filter(t => t.kind === 'publish' && t.payloadKind === o.kind && (t.status === 'todo' || t.status === 'active')).length;
    const avgQ = k.qN ? Math.round(k.qSum / k.qN) : null;
    return (o.teleTop || '') +
      (o.store !== undefined && o.store !== null ? kv('LIVE LISTINGS', '<b>' + S.listings[o.store] + '</b>') : '') +
      (o.store ? kv('BRIEF BACKLOG', (S.insights[o.store] || 0) + ' ready') + bar(Math.min(100, (S.insights[o.store] || 0) * 20)) : '') +
      kv(o.unitName || 'UNITS GENERATED', k.made + ' <span class="dim">(+' + k.madeToday + ' today)</span>') +
      kv('IN PRODUCTION NOW', inProd || '<span class="dim">0</span>') +
      kv('AWAITING PUBLISH', pubQ ? pubQ + ' in outbox' : '<span class="dim">0</span>') +
      kv('UNITS SOLD', k.sold + ' <span class="dim">(+' + k.soldToday + ' today)</span>') +
      kv('REVENUE LIFETIME', '<span class="pos">' + U.money(k.rev) + '</span>') +
      kv('REVENUE TODAY', k.revToday ? '<span class="pos">' + U.money(k.revToday) + '</span>' : '$0.00') +
      (avgQ !== null ? kv('AVG QUALITY', avgQ + ' <span class="dim">/ best ' + k.bestQ + '</span>') + bar(avgQ) : '') +
      kv('LAST SALE', k.lastSaleT ? U.fmtTime(k.lastSaleT) : '<i class="dim">awaiting first</i>') +
      (o.store && S.pivots[o.store] > S.time ? kv('PIVOT BOOST', '<span class="gold">LIVE — ' + Math.round((S.pivots[o.store] - S.time) / 60) + 'h left</span>') : '');
  }

  /* what's planned for the day on this line — the queued builds */
  function planList(o) {
    const S = SIM.S;
    const q = S.tasks.filter(t => t.agentId === o.ag && t.status === 'todo');
    const rows = q.slice(0, 5).map((t, i) =>
      '<div class="rt-row">' + esc(String(t.flavor || t.title).slice(0, 46)) +
      (i > 0 ? '<button class="rt-btn" data-job="' + t.id + '" data-action="prioritize" title="jump the queue">↑</button>' : '') +
      '<i>QUEUED</i></div>').join('') +
      (q.length > 5 ? '<div class="rt-row"><span class="dim">+' + (q.length - 5) + ' more in queue</span></div>' : '');
    return (rows || dimi('queue clear — next run starts on the next brief')) +
      (o.store ? kv('BRIEFS READY TO BUILD', S.insights[o.store] || 0) : '');
  }

  function findingsList(n) {
    const f = SIM.S.tasks.filter(t => ['NOVA', 'CURIE'].includes(t.agentId) && t.status === 'done').slice(-(n || 10)).reverse();
    return f.length ? f.map(t =>
      '<div class="rt-find">' + agTag(t.agentId) + ' <span class="rt-chip">' +
      ({ etsy1: 'APPAREL', etsy2: 'CANDLES', etsy3: 'PERSONALIZED', saas: 'SAAS' }[t.target] || 'INTEL') + '</span> ' +
      esc(t.flavor || t.title) + '</div>').join('') : dimi('first scans still running');
  }

  function inboxList(n) {
    const inb = SIM.S.notifs.slice(-(n || 12)).reverse().map(nf => {
      const tag = /fiverr/i.test(nf.txt) ? 'WEBHOOK' : /sale|net|mrr/i.test(nf.txt) ? 'PLATFORM' : /review|flag/i.test(nf.txt) ? 'INTERNAL' : 'MAIL';
      return '<div class="rt-row"><span class="rt-chip">' + tag + '</span> ' + esc(nf.txt.slice(0, 56)) + '<i>' + U.fmtTime(nf.t) + '</i></div>';
    }).join('');
    return inb || dimi('all channels quiet');
  }

  function channelMatrix() {
    const S = SIM.S;
    const chans = [['ETSY ORDER MAIL', 1], ['FIVERR WEBHOOK :443', 1], ['PRINTIFY API', 1], ['MEDIUM PUBLISH API', 0], ['YOUTUBE DATA API', 0], ['SUNO RENDER FARM', 0], ['OPENCLAW GATEWAY :18789', 1]];
    return chans.map(([c, hot]) => {
      const lat = 18 + (h(c + Math.floor(S.time / 7)) % 90);
      const sync = h(c + Math.floor(S.time / 31)) % 19 === 0;
      return '<div class="rt-row">' + c +
        '<i>' + (sync ? '<span class="warn">RESYNC</span>' : '<span class="pos">' + (hot ? 'HOT' : 'LIVE') + '</span> ' + lat + 'ms') + '</i></div>';
    }).join('');
  }

  function nowPlaying() {
    if (collect) collect.push('JUKE');
    const lastSong = SIM.S.tasks.filter(t => t.kind === 'song' && t.status === 'done').slice(-1)[0];
    const title = lastSong ? lastSong.flavor : 'TERMINAL VELOCITY (drum & bass)';
    return '<div class="rt-feed">' +
      '<div class="rt-feed-head"><span class="rt-live">▮ ON AIR</span><span style="color:' + AGENT_COLOR.VYBES + '">VYBES</span><span class="dim">STATION BROADCAST</span></div>' +
      '<div class="rt-feed-canvas"><pre id="fc-JUKE">' + drawCanvas('JUKE', null) + '</pre></div>' +
      '<div class="rt-feed-cap">NOW PLAYING ▸ ' + esc(String(title).slice(0, 44)) + '</div>' +
    '</div>';
  }

  /* the standard business window: live workstation + chain on the left,
     work order + plan + telemetry on the right */
  function storeWin(o) {
    return cols(
      sub('LIVE WORKSTATION') + feedHTML(o.ag) +
        sub('OPERATOR') + operator(o.ag) +
        sub('CHAIN OF COMMAND') + chainFor(o),
      sub('WORK ORDER — CURRENT') + workOrder(o.ag) +
        (o.mid || '') +
        sub('PLANNED — TODAY\'S PIPELINE') + planList(o) +
        sub('TELEMETRY — ' + o.name) + bizTelemetry(o) +
        sub(o.recent || 'RECENT DELIVERABLES') + recentByAgent([o.ag], 4)
    );
  }

  /* generic lab/desk window: live feed + operator | work order + extras */
  function deskWin(agId, extras) {
    return cols(
      sub('LIVE WORKSTATION') + feedHTML(agId) +
        sub('OPERATOR') + operator(agId),
      sub('WORK ORDER — CURRENT') + workOrder(agId) + (extras || '')
    );
  }

  /* ============================================================
     COMMANDER UPLINK — note + redirect controls at the bottom of
     every agent-backed window. Notes train the agent (SIM.agentNote);
     redirect buttons queue Commander-priority runs (SIM.consoleOrder).
     ============================================================ */
  const noteDraft = {};   // window key -> unsent note text (survives rerenders)
  const flash = {};       // window key -> {t, txt, cls} transient confirmation

  function uplink(key, def) {
    const agId = def.agent;
    const fl = flash[key] && (Date.now() - flash[key].t < 3500) ? flash[key] : null;
    const dirs = (def.dir || []).map((d, i) =>
      '<button class="rt-btn pw-dir" data-dirk="' + key + '" data-diri="' + i + '">' + d.label + '</button>').join('');
    return sub('COMMANDER UPLINK — ' + agId) +
      '<div class="pw-uplink">' +
        '<input class="pw-note" data-notekey="' + key + '" maxlength="140" autocomplete="off" ' +
          'placeholder="leave a note for ' + agId + ' — articulate notes train the agent…" value="' + esc(noteDraft[key] || '') + '">' +
        '<button class="rt-btn pw-send" data-sendkey="' + key + '">▸ SEND</button>' +
      '</div>' +
      (fl ? '<div class="pw-flash ' + fl.cls + '">' + fl.txt + '</div>' : '') +
      (dirs ? '<div class="rt-ctrl pw-dirs">' + dirs + '</div>' : '');
  }

  function sendNote(key) {
    const def = DEFS[key]; if (!def || !def.agent) return;
    const txt = (noteDraft[key] || '').trim();
    if (!txt) {
      flash[key] = { t: Date.now(), txt: '✕ NOTHING TO SEND — type a note first', cls: 'bad' };
      rerender(key);
      return;
    }
    SIM.agentNote(def.agent, txt);
    noteDraft[key] = '';
    flash[key] = { t: Date.now(), txt: '✓ NOTE PINNED TO ' + def.agent + '\'S CONSOLE — training effect applied', cls: 'good' };
    SFX.notify();
    rerender(key);
    const inp = wins[key] && wins[key].body.querySelector('.pw-note');
    if (inp) inp.focus();
  }

  function runDirective(key, idx) {
    const def = DEFS[key]; if (!def) return;
    const spec = (def.dir || [])[idx]; if (!spec) return;
    const agId = spec.agent || def.agent;
    const ok = SIM.consoleOrder(agId, {
      kind: spec.kind, target: spec.target,
      flavor: spec.flavor ? spec.flavor() : undefined,
      title: spec.title || ('Console order: ' + spec.label.replace(/^▸ /, '').toLowerCase())
    });
    flash[key] = ok
      ? { t: Date.now(), txt: '✓ ORDER QUEUED — ' + agId + ' redirected, Commander priority', cls: 'good' }
      : { t: Date.now(), txt: '✕ QUEUE SATURATED — ' + agId + ' already has 5 jobs waiting', cls: 'bad' };
    if (!ok) SFX.bad();
    rerender(key);
  }

  /* head status chip — live state of the console's operator */
  function headState(def) {
    if (!def.agent) return '';
    if (SIM.S.feedback.some(f => f.agentId === def.agent && f.status === 'open'))
      return '<span class="gold">⚑ NEEDS JUDGEMENT</span>';
    const t = activeTaskOf(def.agent);
    return t ? '<span class="pos">● RUNNING ' + pctOf(t) + '%</span>' : '<span class="dim">○ IDLE</span>';
  }

  /* ================= WINDOW DEFINITIONS (one per prop key) ================= */
  const DEFS = {

    /* ---------- FACTORY 01 — the three Etsy stores ---------- */
    etsy1: { title: 'FAB-01 ▪ ETSY 1 — APPAREL', w: 720, accent: '#ff9d2e', agent: 'FORGE',
      dir: [{ label: '▸ QUEUE APPAREL RUN', kind: 'apparel', flavor: () => U.pick(DATA.C.apparel) }],
      build: () =>
      storeWin({ ag: 'FORGE', kind: 'apparel', store: 'etsy1', name: 'APPAREL', unitName: 'DESIGNS GENERATED', recent: 'RECENT DESIGNS' }) },

    etsy2: { title: 'FAB-02 ▪ ETSY 2 — CANDLES', w: 720, accent: '#ffd34a', agent: 'VECTOR',
      dir: [{ label: '▸ QUEUE CANDLE RUN', kind: 'candle', flavor: () => U.pick(DATA.C.candles) }],
      build: () =>
      storeWin({ ag: 'VECTOR', kind: 'candle', store: 'etsy2', name: 'CANDLES', unitName: 'DESIGNS GENERATED', recent: 'RECENT DESIGNS' }) },

    etsy3: { title: 'FAB-03 ▪ ETSY 3 — CUSTOM ART', w: 720, accent: '#ff6ad5', agent: 'PROMETHEUS',
      dir: [{ label: '▸ QUEUE PORTRAIT RUN', kind: 'custom', flavor: () => U.pick(DATA.C.petstyles).replace('{pet}', U.pick(DATA.C.petnames)) }],
      build: () =>
      storeWin({
        ag: 'PROMETHEUS', kind: 'custom', store: 'etsy3', name: 'PERSONALIZED ART',
        unitName: 'PORTRAITS RENDERED', recent: 'RECENT COMMISSIONS',
        mid: sub('OPEN ORDER BOOK') + orderBoard('custom', 'ETSY', etsyBuyerOf)
      }) },

    /* ---------- FACTORY 02 — the gig lines ---------- */
    fiverr: { title: 'GIG-01 ▪ FIVERR — THUMBNAILS', w: 720, accent: '#41ff8a', agent: 'PIXEL',
      dir: [{ label: '▸ PULL NEXT GIG', kind: 'fiverr', flavor: () => U.pick(DATA.C.fiverr) }],
      build() {
      const S = SIM.S;
      return storeWin({
        ag: 'PIXEL', kind: 'fiverr', name: 'FIVERR THUMBNAILS',
        unitName: 'THUMBS DELIVERED', recent: 'RECENT ORDERS',
        supply: ['WEBHOOK :443', 'listening — 0 dropped'],
        ship: ['FIVERR', 'direct delivery to buyer'],
        teleTop: kv('GIG RATING', '★ ' + S.fiverrRating.toFixed(2)) + bar(S.fiverrRating / 5 * 100),
        mid: sub('ORDER BOARD') + orderBoard('fiverr', 'FVR', buyerOf)
      });
    }},

    assets: { title: 'GIG-02 ▪ GAME ASSET FACTORY', w: 720, accent: '#2ee6c8', agent: 'ATLAS',
      dir: [{ label: '▸ QUEUE ASSET BUNDLE', kind: 'assets', flavor: () => U.pick(DATA.C.assets) }],
      build() {
      const S = SIM.S;
      return storeWin({
        ag: 'ATLAS', kind: 'assets', name: 'GAME ASSETS',
        unitName: 'BUNDLES GENERATED', recent: 'RECENT BUNDLES',
        supply: ['PIXELLAB API', 'credits ' + (40 + h('plc' + Math.floor(S.time / 240)) % 55) + '%'],
        teleTop: kv('BUNDLES LISTED', S.listings.assets)
      });
    }},

    press: { title: 'GIG-03 ▪ AFFILIATE PRESS', w: 720, accent: '#d8c9a3', agent: 'QUILL',
      dir: [{ label: '▸ COMMISSION ARTICLE', kind: 'article', flavor: () => U.pick(DATA.C.articles) }],
      build() {
      const S = SIM.S;
      return storeWin({
        ag: 'QUILL', kind: 'article', name: 'AFFILIATE PRESS',
        unitName: 'ARTICLES WRITTEN', recent: 'RECENT ARTICLES',
        supply: ['CURIE', 'trend angles on tap'],
        ship: ['HERALD', 'Medium publish queue'],
        teleTop: kv('ARTICLES LIVE', S.listings.articles)
      });
    }},

    saas: { title: 'GIG-04 ▪ SAAS FOUNDRY', w: 720, accent: '#7fd0ff', agent: 'CIPHER',
      dir: [{ label: '▸ SCOPE NEW PAIN POINT', agent: 'CURIE', kind: 'research', target: 'saas', flavor: () => U.pick(DATA.C.painpoints), title: 'Console order: hunt a SaaS pain point' }],
      build() {
      const S = SIM.S;
      const proj = S.saasProjects.map(p =>
        '<div class="rt-row">' + esc(p.name) + '<i>' + (p.live ? '<span class="gold">LIVE ' + U.money(p.mrr) + '/d</span>' : 'BUILD ' + p.stage + '/3') + '</i></div>' +
        bar(p.live ? 100 : p.stage / 3 * 100)).join('') || dimi('awaiting a pain point from CURIE');
      return cols(
        sub('LIVE WORKSTATION') + feedHTML('CIPHER') +
          sub('OPERATOR') + operator('CIPHER') +
          sub('CHAIN OF COMMAND') + chainFor({ ag: 'CIPHER', kind: 'saas', supply: ['CURIE', (S.insights.saas || 0) + ' leads ready'], ship: ['STRIPE', S.mrr ? 'billing live' : 'no billing yet'] }),
        sub('WORK ORDER — CURRENT') + workOrder('CIPHER') +
          sub('PRODUCT PORTFOLIO') + proj +
          kv('TOTAL MRR', '<span class="pos">' + U.money(S.mrr) + '/d</span>') +
          kv('BUILDS COMPLETED', SIM.kindStat('saas').made) +
          kv('SAAS LEADS READY', S.insights.saas || 0) +
          sub('RECENT BUILDS') + recentByAgent(['CIPHER'], 4)
      );
    }},

    music: { title: 'GIG-05 ▪ MUSIC BAY', w: 720, accent: '#b44aff', agent: 'VYBES',
      dir: [{ label: '▸ DROP NEW TRACK', kind: 'song', flavor: () => U.pick(DATA.C.songs) }],
      build() {
      const S = SIM.S;
      return storeWin({
        ag: 'VYBES', kind: 'song', name: 'MUSIC BAY',
        unitName: 'TRACKS PRODUCED', recent: 'RECENT TRACKS',
        supply: ['SUNO', 'render farm on tap'],
        ship: ['HERALD', 'YouTube upload queue'],
        teleTop: kv('TRACKS ON YOUTUBE', S.listings.songs)
      });
    }},

    /* ---------- BRIDGE ---------- */
    bridge_main: { title: 'BRIDGE ▪ ULTRON — MASTER CONTROL', w: 720, accent: '#ff4a3d', agent: 'ULTRON',
      dir: [{ label: '▸ ORDER STATION SWEEP', kind: 'directive', title: 'Full station sweep — Commander priority' }],
      build() {
      const S = SIM.S;
      const today = Math.floor(S.time / 1440);
      const dToday = S.tasks.filter(t => t.playerOrder && Math.floor(t.createdT / 1440) === today).length;
      const fbOpen = S.feedback.filter(f => f.status === 'open').length;
      const verifiedToday = S.tasks.filter(t => t.playerOrder && t.status === 'done' && Math.floor((t.doneT || 0) / 1440) === today).length;
      return cols(
        sub('ULTRON — LIVE OVERSIGHT') + feedHTML('ULTRON') +
          sub('OPERATOR') + operator('ULTRON'),
        sub('STATION COMMAND') +
          kv('CONN', S.mode === 'AUTO' ? '<span class="gold">AUTOPILOT — ULTRON</span>' : 'MANUAL — COMMANDER') +
          kv('GATEWAY :18789', '<span class="pos">LIVE</span>') +
          kv('STATION LEVEL', S.level) +
          kv('DIRECTIVES TODAY', dToday) +
          kv('VERIFIED TODAY', verifiedToday) +
          kv('AWAITING JUDGEMENT', fbOpen ? '<span class="warn">' + fbOpen + '</span>' : '0') +
          kv('COMM QUEUE', S.ultronQueue.length + ' pending') +
          sub('CHAIN OF COMMAND') +
          chainRow('CONN', '<span class="gold">COMMANDER</span>', 'directive authority') +
          chainRow('ORCH', agTag('ULTRON'), 'decompose ▪ delegate ▪ verify') +
          chainRow('CREW', '<span class="dim">16 AGENTS</span>', 'execution layer') +
          '<div class="rt-note">Every order is decomposed here, delegated, then personally verified against standard before it ships.</div>'
      );
    }},

    bridge_delegation: { title: 'BRIDGE ▪ DELEGATION HOLO', w: 540, accent: '#ff4a3d', build() {
      const S = SIM.S;
      const act = S.tasks.filter(t => t.status === 'active').length;
      const todo = S.tasks.filter(t => t.status === 'todo').length;
      const rev = S.feedback.filter(f => f.status === 'open').length;
      return sub('DELEGATION MATRIX — 16 AGENTS') +
        '<div class="rt-row">STATION LOAD <i>' + act + ' ACTIVE ▪ ' + todo + ' QUEUED ▪ ' + rev + ' AT QC</i></div>' +
        DATA.AGENTS.filter(a => a.id !== 'ULTRON').map(a => {
          const ag = S.agents[a.id];
          const t = ag.taskId ? S.tasks.find(x => x.id === ag.taskId) : null;
          return '<div class="rt-row">' + agTag(a.id) + ' <span class="dim">' + presenceOf(a.id) + '</span> ' +
            (t ? esc(String(t.flavor || t.title).slice(0, 44)) + '<i>' + pctOf(t) + '%</i>'
               : dimi('standing by') + '<i>—</i>') + '</div>' +
            (t ? bar(pctOf(t), 'thin') : '');
        }).join('');
    }},

    bridge_directives: { title: 'BRIDGE ▪ COMMANDER ORDER QUEUE', w: 500, accent: '#ff4a3d', build() {
      const S = SIM.S;
      const dirs = S.tasks.filter(t => t.playerOrder).slice(-12).reverse();
      return sub('COMMANDER DIRECTIVE LOG') + (dirs.length ? dirs.map(t =>
        '<div class="rt-row">' + agTag(t.agentId) + ' ' + esc(t.title.slice(0, 52)) +
        '<i>' + (t.status === 'done' ? '<span class="pos">Q' + t.quality + '</span>' : t.status === 'failed' ? '<span class="bad">FAILED</span>' : t.status.toUpperCase()) + '</i></div>').join('')
        : dimi('no Commander directives logged — issue one in the groupchat')) +
        kv('COMM QUEUE', S.ultronQueue.length + ' pending') +
        '<div class="rt-note">Issue directives in the Station Groupchat — ULTRON decomposes, delegates and verifies.</div>';
    }},

    /* ---------- HUB PLAZA ---------- */
    hub_overview: { title: 'HUB ▪ STATION HOLO — OVERVIEW', w: 460, accent: '#8a8276', build() {
      const S = SIM.S;
      const net = S.rev.total - S.costs;
      const nets = S.history.slice(-14).map(d => d.rev - d.costs);
      return sub('STATION OVERVIEW — LIVE') +
        kv('STATION LEVEL', S.level) +
        kv('TOTAL REVENUE', '<span class="pos">' + U.money(S.rev.total) + '</span>') +
        kv('TOTAL BURN', '<span class="bad">' + U.money(S.costs) + '</span>') +
        kv('NET', '<b class="' + (net >= 0 ? 'pos' : 'bad') + '">' + U.money(net) + '</b>') +
        kv('TOTAL SALES', S.stats.totalSales) +
        kv('TASKS COMPLETED', S.stats.totalTasks) +
        sub('CHANNELS') +
        [['ETSY', S.rev.etsy], ['FIVERR', S.rev.fiverr], ['OTHER', S.rev.other]].map(([n, v]) =>
          kv(n, U.money(v)) + bar(S.rev.total ? v / S.rev.total * 100 : 0)).join('') +
        sub('NET BY DAY') + (nets.length ? spark(nets, true) : dimi('first day still on the books'));
    }},

    /* ---------- RESEARCH LAB ---------- */
    research_nova: { title: 'LAB-01 ▪ NOVA — LEAD RESEARCH', w: 720, accent: '#4ad9ff', agent: 'NOVA',
      dir: [
        { label: '▸ SCAN APPAREL', kind: 'research', target: 'etsy1', flavor: () => U.pick(DATA.C.research), title: 'Console order: scan the apparel meta' },
        { label: '▸ SCAN CANDLES', kind: 'research', target: 'etsy2', flavor: () => U.pick(DATA.C.research), title: 'Console order: scan the candle meta' },
        { label: '▸ SCAN PORTRAITS', kind: 'research', target: 'etsy3', flavor: () => U.pick(DATA.C.research), title: 'Console order: scan the portrait meta' }
      ],
      build: () =>
      deskWin('NOVA',
        kv('REPORTS FILED', SIM.kindStat('research').made + ' <span class="dim">(+' + SIM.kindStat('research').madeToday + ' today)</span>') +
        sub('LATEST FINDINGS') + findingsList(5)) },

    research_curie: { title: 'LAB-02 ▪ CURIE — ANALYST', w: 720, accent: '#8f7bff', agent: 'CURIE',
      dir: [
        { label: '▸ HUNT SAAS PAIN POINTS', kind: 'research', target: 'saas', flavor: () => U.pick(DATA.C.painpoints), title: 'Console order: hunt SaaS pain points' },
        { label: '▸ TREND SWEEP', kind: 'research', target: 'etsy1', flavor: () => U.pick(DATA.C.research), title: 'Console order: full trend sweep' }
      ],
      build: () =>
      deskWin('CURIE',
        kv('SAAS LEADS READY', SIM.S.insights.saas || 0) +
        sub('LATEST FINDINGS') + findingsList(5)) },

    research_briefs: { title: 'LAB ▪ BRIEF INVENTORY', w: 480, accent: '#4ad9ff', build() {
      const S = SIM.S;
      const burn = [['FORGE', 'apparel'], ['VECTOR', 'candle'], ['PROMETHEUS', 'custom'], ['CIPHER', 'saas']];
      return sub('BRIEF INVENTORY — FACTORIES CONSUME THESE') +
        kv('APPAREL BRIEFS', S.insights.etsy1 + ' ready') + bar(Math.min(100, S.insights.etsy1 * 20)) +
        kv('CANDLE BRIEFS', S.insights.etsy2 + ' ready') + bar(Math.min(100, S.insights.etsy2 * 20)) +
        kv('PERSONALIZED BRIEFS', S.insights.etsy3 + ' ready') + bar(Math.min(100, S.insights.etsy3 * 20)) +
        kv('SAAS LEADS', S.insights.saas + ' ready') + bar(Math.min(100, S.insights.saas * 34)) +
        sub('CONSUMPTION — WHO BUILDS ON THE INTEL') +
        burn.map(([agId, kind]) => {
          const k = SIM.kindStat(kind);
          return '<div class="rt-row">' + agTag(agId) + ' consumed → ' + k.made + ' builds <i>+' + k.madeToday + ' today</i></div>';
        }).join('') +
        kv('REPORTS FILED', SIM.kindStat('research').made + ' <span class="dim">(+' + SIM.kindStat('research').madeToday + ' today)</span>') +
        '<div class="rt-note">One brief is consumed per production run. Empty inventory stalls the factory floor.</div>';
    }},

    research_findings: { title: 'LAB ▪ FINDINGS WALL', w: 500, accent: '#4ad9ff', build: () =>
      sub('LATEST FINDINGS') + findingsList(12) },

    /* ---------- COMMUNICATIONS ---------- */
    comms_relay: { title: 'COM-01 ▪ RELAY — LIVE TRAFFIC', w: 720, accent: '#5ad1b3', agent: 'RELAY',
      dir: [{ label: '▸ COMPILE DIGEST NOW', kind: 'comms', title: 'Console order: compile the Commander digest' }],
      build: () =>
      deskWin('RELAY', sub('INBOUND — RECENT') + inboxList(7)) },

    comms_channels: { title: 'COMMS ▪ CHANNEL WALL', w: 460, accent: '#5ad1b3', build() {
      const S = SIM.S;
      const cats = { WEBHOOK: 0, PLATFORM: 0, INTERNAL: 0, MAIL: 0 };
      S.notifs.forEach(nf => {
        const tag = /fiverr/i.test(nf.txt) ? 'WEBHOOK' : /sale|net|mrr/i.test(nf.txt) ? 'PLATFORM' : /review|flag/i.test(nf.txt) ? 'INTERNAL' : 'MAIL';
        cats[tag]++;
      });
      return sub('CHANNEL MATRIX') + channelMatrix() +
        sub('CLASSIFICATION') +
        Object.keys(cats).map(c => kv(c, cats[c])).join('') +
        kv('DROPPED', '<span class="pos">0</span>') +
        kv('DIGESTS FILED', SIM.kindStat('comms').made) +
        '<div class="rt-note">RELAY triages every inbound message so the Commander never has to.</div>';
    }},

    comms_inbox: { title: 'COMMS ▪ INBOUND TRAFFIC', w: 500, accent: '#5ad1b3', build: () =>
      sub('INBOUND — FULL FEED') + inboxList(16) },

    /* ---------- TREASURY ---------- */
    treasury_ledger: { title: 'TRS-01 ▪ LEDGER — RECONCILIATION', w: 720, accent: '#9bff4a', agent: 'LEDGER',
      dir: [{ label: '▸ RUN P&L NOW', kind: 'finance', title: 'Emergency P&L for the Commander' }],
      build() {
      const S = SIM.S;
      return deskWin('LEDGER',
        kv('TODAY REV', '<span class="pos">' + U.money(S.dayAcc.rev) + '</span>') +
        kv('TODAY BURN', '<span class="bad">' + U.money(S.dayAcc.costs) + '</span>') +
        kv('SAAS MRR', '<span class="pos">' + U.money(S.mrr) + '/d</span>') +
        sub('AGENT FILE — LEDGER') + agentFile('LEDGER'));
    }},

    treasury_pnl: { title: 'TREASURY ▪ THE VAULT — P&L', w: 480, accent: '#9bff4a', build() {
      const S = SIM.S;
      const net = S.rev.total - S.costs;
      const nets = S.history.slice(-14).map(d => d.rev - d.costs);
      const hist = S.history.slice(-10).reverse();
      return sub('PROFIT & LOSS') +
        kv('TOTAL REVENUE', '<span class="pos">' + U.money(S.rev.total) + '</span>') +
        kv('— ETSY', U.money(S.rev.etsy)) + kv('— FIVERR', U.money(S.rev.fiverr)) + kv('— OTHER', U.money(S.rev.other)) +
        kv('SAAS MRR', '<span class="pos">' + U.money(S.mrr) + '/d</span>') +
        kv('TOTAL BURN', '<span class="bad">' + U.money(S.costs) + '</span>') +
        kv('NET', '<b class="' + (net >= 0 ? 'pos' : 'bad') + '">' + U.money(net) + '</b>') +
        sub('NET — LAST ' + Math.max(1, nets.length) + ' DAYS') +
        (nets.length ? spark(nets, true) : dimi('first day still on the books')) +
        sub('DAILY LEDGER') + (hist.length ? hist.map(d =>
          '<div class="rt-row">DAY ' + d.day + ' ▪ rev ' + U.money(d.rev) + ' / burn ' + U.money(d.costs) +
          '<i class="' + (d.rev - d.costs >= 0 ? 'pos' : 'bad') + '">' + U.money(d.rev - d.costs) + '</i></div>').join('')
          : dimi('first day still on the books'));
    }},

    treasury_burn: { title: 'TREASURY ▪ BURN TICKER', w: 460, accent: '#9bff4a', build() {
      const S = SIM.S;
      const counts = {};
      DATA.AGENTS.forEach(a => counts[a.model] = (counts[a.model] || 0) + 1);
      return sub('MODEL SUBSCRIPTIONS') + Object.keys(counts).map(m =>
          kv(DATA.MODELS[m].name + ' ×' + counts[m], U.money(DATA.DAILY_SUBS[m] * counts[m]) + '/d ▪ $' +
            DATA.MODELS[m].costMin.toFixed(2) + '–' + DATA.MODELS[m].costMax.toFixed(2) + '/call')).join('') +
        sub('TOP BURNERS') + DATA.AGENTS.map(a => ({ id: a.id, s: S.agents[a.id].spent })).sort((a, b) => b.s - a.s).slice(0, 7)
          .map(r => '<div class="rt-row">' + agTag(r.id) + '<i class="bad">-' + U.money(r.s).slice(1) + '</i></div>').join('');
    }},

    /* ---------- WAR ROOM ---------- */
    war_signal: { title: 'WAR-02 ▪ RAVEN — SIGNAL FEED', w: 720, accent: '#a0a8ff', agent: 'RAVEN',
      dir: [{ label: '▸ DEEP ANALYTICS PASS', kind: 'strategy', title: 'Console order: deep analytics pass' }],
      build: () =>
      deskWin('RAVEN',
        kv('REVIEWS FILED', SIM.kindStat('strategy').made) +
        '<div class="rt-note">RAVEN finds the signal that says something is quietly dying before it loudly dies.</div>') },

    war_lines: { title: 'WAR ROOM ▪ BUSINESS LINE STATUS', w: 540, accent: '#ff5c5c', agent: 'ATHENA',
      dir: [{ label: '▸ FULL STRATEGY REVIEW', kind: 'strategy', title: 'Full strategy review, Commander priority' }],
      build() {
      const S = SIM.S;
      const lines = [
        ['APPAREL', 'etsy1', S.listings.etsy1 + ' listings'], ['CANDLES', 'etsy2', S.listings.etsy2 + ' listings'],
        ['PERSONALIZED', 'etsy3', S.listings.etsy3 + ' listings'], ['GAME ASSETS', null, S.listings.assets + ' bundles'],
        ['AFFILIATE', null, S.listings.articles + ' articles'], ['FIVERR', null, '★ ' + S.fiverrRating.toFixed(1)],
        ['SAAS', null, U.money(S.mrr) + '/d MRR']
      ];
      const pivots = S.tasks.filter(t => t.kind === 'pivot' && ['todo', 'active', 'review'].includes(t.status));
      return sub('BUSINESS LINE STATUS') + lines.map(([name, key, metric]) => {
          const wob = (h(name + Math.floor(S.time / 180)) % 41) - 20;
          const boosted = key && S.pivots[key] > S.time;
          const verdict = boosted ? '<span class="gold">PIVOT LIVE</span>'
            : wob < -14 ? '<span class="bad">PIVOT-READY</span>'
            : wob < -6 ? '<span class="warn">WATCH</span>' : '<span class="pos">HOLD</span>';
          return '<div class="rt-row">' + name + ' <span class="dim">' + metric + '</span> ' +
            (wob >= 0 ? '<span class="pos">▲' : '<span class="bad">▼') + Math.abs(wob) + '%</span><i>' + verdict + '</i></div>';
        }).join('') +
        sub('ATHENA — STRATEGY DESK') + workOrder('ATHENA') +
        kv('PIVOTS IN MOTION', pivots.length || '<span class="dim">0</span>') +
        '<div class="rt-note">RAVEN finds the signal; ATHENA makes the pivot-or-persevere call; the Commander signs off.</div>';
    }},

    war_pivots: { title: 'WAR ROOM ▪ PIVOT BOARD', w: 500, accent: '#ff5c5c', build() {
      const p = SIM.S.tasks.filter(t => t.kind === 'pivot' && ['todo', 'active', 'review'].includes(t.status)).map(jobCard).join('');
      return sub('PIVOT OPERATIONS') + (p || dimi('no pivots in motion — lines holding'));
    }},

    /* ---------- PUBLISHING ROOM ---------- */
    pub_herald: { title: 'PUB-01 ▪ HERALD — UPLINK', w: 720, accent: '#ffe066', agent: 'HERALD',
      dir: [{ label: '▸ AUDIT CALENDAR', kind: 'comms', title: 'Audit the publishing calendar' }],
      build() {
      const S = SIM.S;
      const q = S.tasks.filter(t => t.kind === 'publish' && ['todo', 'active'].includes(t.status));
      const qH = q.length ? q.slice(0, 6).map(t =>
        '<div class="rt-row"><span class="rt-chip">' + (DATA.KINDS[t.payloadKind] ? DATA.KINDS[t.payloadKind].label : 'ITEM') + '</span> ' +
        esc(String(t.flavor || '').slice(0, 30)) + '<i>' + (t.status === 'active' ? pctOf(t) + '%' : 'slot ' + etaOf(t)) + '</i></div>').join('')
        : dimi('outbox empty — factories are mid-run');
      const today = Math.floor(S.time / 1440);
      const shippedToday = S.tasks.filter(t => t.kind === 'publish' && t.status === 'done' && Math.floor((t.doneT || 0) / 1440) === today).length;
      return deskWin('HERALD',
        sub('OUTBOX') + qH +
        kv('SHIPPED TODAY', shippedToday));
    }},

    pub_calendar: { title: 'PUBLISHING ▪ STATION CALENDAR', w: 540, accent: '#ffd34a', build() {
      const S = SIM.S;
      const q = S.tasks.filter(t => t.kind === 'publish' && ['todo', 'active'].includes(t.status));
      const today = Math.floor(S.time / 1440);
      const shippedToday = S.tasks.filter(t => t.kind === 'publish' && t.status === 'done' && Math.floor((t.doneT || 0) / 1440) === today).length;
      const hourNow = Math.floor((S.time % 1440) / 60);
      let used = 0;
      const cal = [];
      for (let hh = 9; hh <= 19; hh++) {
        let cell;
        if (hh < hourNow) { cell = used < shippedToday ? '<span class="pos">SHIPPED</span>' : '<span class="dim">—</span>'; used++; }
        else if (hh === hourNow) cell = q.length ? '<span class="gold">UPLOADING' + (q[0] && q[0].flavor ? ' — ' + esc(String(q[0].flavor).slice(0, 22)) : '') + '</span>' : '<span class="dim">open</span>';
        else cell = (hh - hourNow) <= q.length ? 'RESERVED' + (q[hh - hourNow - 1] && q[hh - hourNow - 1].flavor ? ' — ' + esc(String(q[hh - hourNow - 1].flavor).slice(0, 22)) : '') : '<span class="dim">open</span>';
        cal.push('<div class="rt-row">' + U.pad2(hh) + ':00<i>' + cell + '</i></div>');
      }
      // everything that will be published: the outbox, then what's still on the factory floor
      const inbound = S.tasks.filter(t => t.status === 'active' && ['apparel', 'candle', 'custom', 'assets', 'article', 'song'].includes(t.kind));
      return sub('TODAY\'S SCHEDULE — 09:00–19:00') + cal.join('') +
        sub('PUBLISH OUTLINE — IN THE OUTBOX') +
        (q.length ? q.slice(0, 8).map(t =>
          '<div class="rt-row"><span class="rt-chip">' + (DATA.KINDS[t.payloadKind] ? DATA.KINDS[t.payloadKind].label : 'ITEM') + '</span> ' +
          esc(String(t.flavor || '').slice(0, 32)) + '<i>' + (t.status === 'active' ? pctOf(t) + '%' : 'slot ' + etaOf(t)) + '</i></div>').join('')
          : dimi('outbox empty')) +
        sub('INBOUND FROM THE FACTORY FLOOR') +
        (inbound.length ? inbound.slice(0, 8).map(t =>
          '<div class="rt-row">' + agTag(t.agentId) + ' <span class="rt-chip">' + DATA.KINDS[t.kind].label + '</span> ' +
          esc(String(t.flavor || t.title).slice(0, 28)) + '<i>' + pctOf(t) + '%</i></div>').join('')
          : dimi('factory floor between runs'));
    }},

    pub_totals: { title: 'PUBLISHING ▪ SHIPPED TOTALS', w: 440, accent: '#ffd34a', build() {
      const S = SIM.S;
      const today = Math.floor(S.time / 1440);
      const shippedToday = S.tasks.filter(t => t.kind === 'publish' && t.status === 'done' && Math.floor((t.doneT || 0) / 1440) === today).length;
      const chans = [['ETSY', SIM.kindStat('apparel').shipped + SIM.kindStat('candle').shipped + SIM.kindStat('custom').shipped],
        ['INDIE MARKETS', SIM.kindStat('assets').shipped], ['MEDIUM', SIM.kindStat('article').shipped], ['YOUTUBE', SIM.kindStat('song').shipped]];
      return sub('SHIPPED — BY CHANNEL') +
        chans.map(([c, n]) => kv(c, n)).join('') +
        sub('TOTALS') +
        kv('ETSY LISTINGS', S.listings.etsy1 + S.listings.etsy2 + S.listings.etsy3) +
        kv('ASSET BUNDLES', S.listings.assets) + kv('ARTICLES', S.listings.articles) +
        kv('TRACKS', S.listings.songs) + kv('SHIPPED TODAY', shippedToday) +
        kv('LIFETIME PUBLISH RUNS', SIM.kindStat('publish').made);
    }},

    /* ---------- ARCHIVES ---------- */
    arc_scribe: { title: 'ARC-01 ▪ SCRIBE — MEMORY WRITER', w: 720, accent: '#c0c0c0', agent: 'SCRIBE',
      dir: [{ label: '▸ CONSOLIDATE MEMORY', kind: 'archive', title: 'Console order: consolidate the memory banks' }],
      build() {
      const S = SIM.S;
      const mem = S.archives.slice(-6).reverse().map(a =>
        '<div class="rt-row"><span class="rt-chip">' + a.kind.toUpperCase() + '</span> ' + esc(a.txt.slice(0, 48)) + '<i>' + U.fmtTime(a.t) + '</i></div>').join('');
      return deskWin('SCRIBE',
        sub('MEMORY BANKS — RECENT WRITES') + (mem || dimi('memory banks empty — the station is young')));
    }},

    arc_index: { title: 'ARCHIVES ▪ MEMORY INDEX', w: 480, accent: '#c0c0c0', build() {
      const S = SIM.S;
      const byKind = {};
      S.archives.forEach(a => byKind[a.kind] = (byKind[a.kind] || 0) + 1);
      const mem = S.archives.slice(-8).reverse().map(a =>
        '<div class="rt-row"><span class="rt-chip">' + a.kind.toUpperCase() + '</span> ' + esc(a.txt.slice(0, 48)) + '<i>' + U.fmtTime(a.t) + '</i></div>').join('');
      return sub('INDEX') +
        kv('TOTAL ENTRIES', S.archives.length) +
        Object.keys(byKind).map(k => kv('— ' + k.toUpperCase(), byKind[k])).join('') +
        kv('CONSOLIDATIONS RUN', SIM.kindStat('archive').made) +
        kv('INTEGRITY', '99.' + (3 + h('int' + Math.floor(S.time / 60)) % 7) + '%') +
        kv('LAST FSYNC', U.fmtTime(S.time - (S.time % 30))) +
        sub('RECENT WRITES') + (mem || dimi('memory banks empty — the station is young')) +
        '<div class="rt-note">Every Commander order and every correction is permanent. The crew compounds because nothing is forgotten.</div>';
    }},

    /* ---------- LIVING QUARTERS ---------- */
    juke: { title: 'QUARTERS ▪ STATION JUKEBOX', w: 420, accent: '#b44aff', build: () =>
      sub('NOW PLAYING — STATION BROADCAST') + nowPlaying() +
      kv('STATION ORIGINALS', SIM.S.listings.songs || '<span class="dim">radio static</span>') +
      sub('TRACK ARCHIVE') + recentByAgent(['VYBES'], 5) },

    lounge: { title: 'QUARTERS ▪ THE BAR', w: 440, accent: '#ffb84d', build() {
      const S = SIM.S;
      const here = WORLD.bodiesInRoom('quarters');
      const present = here.length ? here.map(b =>
        '<div class="rt-row">' + agTag(b.id) + '<i>' + (b.state === 'social' ? (b.hasCan ? 'at the bar' : 'lounging') : b.state) + '</i></div>').join('')
        : dimi('nobody here — shift in progress');
      const partyOn = S.party > S.time;
      return sub('PRESENT IN QUARTERS') + present +
        sub('BAR STATUS') +
        kv('STATUS', partyOn ? '<span class="gold">PARTY — ' + (S.party - S.time) + 'min left</span>' : 'open, self-serve') +
        kv('CANS RECYCLED', 14 + Math.floor(S.time / 97) * 3) +
        kv('TAB', '<span class="dim">unpaid (VYBES, mostly)</span>') +
        '<div class="rt-note">Type "party" in the groupchat to call a station-wide break. Morale is a production input.</div>';
    }},

    arcade: { title: 'QUARTERS ▪ ARCADE — BREACH PROTOCOL', w: 430, accent: '#ffb84d', game: true, build() {
      const hi = ARCADE.hi;
      return ARCADE.shell() +
        kv('HOUSE RECORD', hi.name + ' — ' + hi.score.toLocaleString()) +
        '<div class="rt-note">' + (hi.name === 'VYBES'
          ? 'High score broken roughly weekly. Always by VYBES. Nobody knows how.'
          : 'VYBES has been staring at this cabinet for three shifts straight.') + '</div>';
    }},

    morale: { title: 'QUARTERS ▪ CREW MORALE BOARD', w: 440, accent: '#ffb84d', build: () =>
      sub('CREW MORALE') + DATA.AGENTS.map(a => ({ id: a.id, m: SIM.S.agents[a.id].morale }))
        .sort((a, b) => b.m - a.m).map(r =>
          '<div class="rt-kv"><span>' + agTag(r.id) + '</span><b>' + Math.round(r.m) + '</b></div>' + bar(r.m, r.m < 45 ? 'low' : '')).join('') }
  };

  /* ================= WINDOW MANAGER ================= */
  function place(def, pos) {
    const w = def.w || 480;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left, top;
    if (pos) { left = pos.x + 16; top = pos.y - 24; }
    else { left = vw / 2 - w / 2 + (spawnN % 5) * 26; top = 80 + (spawnN % 5) * 26; spawnN++; }
    return {
      left: U.clamp(left, 6, Math.max(6, vw - w - 6)),
      top: U.clamp(top, 6, Math.max(6, vh - 340))
    };
  }

  function spawn(key, def, pos) {
    const el = document.createElement('div');
    el.className = 'term pw';
    el.dataset.key = key;
    el.style.width = (def.w || 480) + 'px';
    const p = lastPos[key] || place(def, pos);
    // remembered positions ride through resizes — clamp back into the viewport
    el.style.left = Math.max(6, Math.min(p.left, window.innerWidth - (def.w || 480) - 6)) + 'px';
    el.style.top = Math.max(6, Math.min(p.top, window.innerHeight - 340)) + 'px';
    el.style.zIndex = U.zTop();
    el.innerHTML =
      '<div class="term-head pw-head" style="border-bottom-color:' + (def.accent || 'var(--ph)') + '">' +
        '<span class="term-title"><span style="color:' + (def.accent || 'var(--ph)') + '">▮</span> ' + def.title + '</span>' +
        '<span class="pw-state">' + headState(def) + '</span>' +
        '<span class="pw-btns">' +
          '<button class="term-x pw-min" title="roll up">▁</button>' +
          '<button class="term-x" title="close">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="term-body pw-body"></div>';
    host.appendChild(el);
    const head = el.querySelector('.pw-head');
    head.addEventListener('mousedown', ev => {
      if (ev.target.closest('.term-x')) return;
      dragKey = key;
      wins[key].dx = ev.clientX - el.offsetLeft;
      wins[key].dy = ev.clientY - el.offsetTop;
      ev.preventDefault();
    });
    head.addEventListener('dblclick', ev => {
      if (ev.target.closest('.term-x')) return;
      el.classList.toggle('pw-rolled');
      if (def.game) el.classList.contains('pw-rolled') ? ARCADE.pause() : ARCADE.resume();
    });
    el.addEventListener('mousedown', () => { el.style.zIndex = U.zTop(); });
    wins[key] = { el, body: el.querySelector('.pw-body'), def, feeds: [], dx: 0, dy: 0 };
  }

  function rerender(key) {
    const w = wins[key]; if (!w) return;
    collect = [];
    const html = w.def.build() + (w.def.agent ? uplink(key, w.def) : '');
    w.feeds = collect; collect = null;
    const st = w.body.scrollTop;
    w.body.innerHTML = html;
    w.body.scrollTop = st;
    if (w.def.game) ARCADE.mount(w.body);
    const state = w.el.querySelector('.pw-state');
    if (state) state.innerHTML = headState(w.def);
  }

  function open(key, pos) {
    const def = DEFS[key]; if (!def) return;
    if (!host) initShell();
    if (wins[key]) { wins[key].el.style.zIndex = U.zTop(); return; }
    spawn(key, def, pos);
    rerender(key);
    if (!fastTimer) fastTimer = setInterval(fastTick, 140);
    SFX.open();
  }

  function close(key) {
    const w = wins[key]; if (!w) return;
    if (w.def.game) ARCADE.unmount();
    lastPos[key] = { left: w.el.offsetLeft, top: w.el.offsetTop };
    w.el.remove();
    delete wins[key];
    if (!Object.keys(wins).length && fastTimer) { clearInterval(fastTimer); fastTimer = null; }
    SFX.close();
  }

  function initShell() {
    host = $('#terms'); // shared floating-window layer with ui.js
    host.addEventListener('click', ev => {
      const winEl = ev.target.closest('.pw'); if (!winEl) return;
      const key = winEl.dataset.key;
      if (ev.target.closest('.pw-min')) {
        SFX.click(); winEl.classList.toggle('pw-rolled');
        const w0 = wins[key];
        if (w0 && w0.def.game) winEl.classList.contains('pw-rolled') ? ARCADE.pause() : ARCADE.resume();
        return;
      }
      if (ev.target.closest('.term-x')) { SFX.click(); close(key); return; }
      const agEl = ev.target.closest('[data-agent]');
      if (agEl) { SFX.click(); UI.openAgent(agEl.dataset.agent); return; }
      if (ev.target.closest('[data-fb]')) { SFX.click(); UI.openFeedback(); return; }
      const sendEl = ev.target.closest('[data-sendkey]');
      if (sendEl) { SFX.click(); sendNote(sendEl.dataset.sendkey); return; }
      const dirEl = ev.target.closest('[data-dirk]');
      if (dirEl) { SFX.click(); runDirective(dirEl.dataset.dirk, +dirEl.dataset.diri); return; }
      const actEl = ev.target.closest('[data-action]');
      if (actEl) {
        SFX.click();
        const act = actEl.dataset.action, jid = actEl.dataset.job;
        if (act === 'prioritize') SIM.prioritize(jid);
        else if (act === 'rush') SIM.rush(jid);
        else if (act === 'flag') SIM.toggleFlag(jid);
        rerender(key);
      }
    });
    // note drafts survive the 1s re-render; Enter sends
    host.addEventListener('input', ev => {
      const inp = ev.target.closest('.pw-note'); if (!inp) return;
      noteDraft[inp.dataset.notekey] = inp.value;
    });
    host.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter') return;
      const inp = ev.target.closest('.pw-note'); if (!inp) return;
      sendNote(inp.dataset.notekey);
    });
    window.addEventListener('mousemove', ev => {
      if (!dragKey || !wins[dragKey]) return;
      const w = wins[dragKey];
      w.el.style.left = U.clamp(ev.clientX - w.dx, -((w.def.w || 480) - 60), window.innerWidth - 60) + 'px';
      w.el.style.top = U.clamp(ev.clientY - w.dy, 0, window.innerHeight - 30) + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (dragKey && wins[dragKey]) {
        const w = wins[dragKey];
        lastPos[dragKey] = { left: w.el.offsetLeft, top: w.el.offsetTop };
      }
      dragKey = null;
    });
    window.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape') return;
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      const keys = Object.keys(wins);
      if (!keys.length) return;
      let top = null, tz = -1;
      keys.forEach(k => { const z = +wins[k].el.style.zIndex || 0; if (z > tz) { tz = z; top = k; } });
      close(top);
    });
  }

  /* 1/sec — re-render every open window so numbers stay live.
     A window whose note input has focus keeps its body frozen (the live feed
     still streams via fastTick's id-targeted updates); the head chip always
     refreshes. */
  function tick() {
    const ae = document.activeElement;
    for (const key in wins) {
      const w = wins[key];
      const state = w.el.querySelector('.pw-state');
      if (state) state.innerHTML = headState(w.def);
      if (key === dragKey) continue;
      if (w.def.game) continue;        // game window runs its own canvas loop
      if (ae && w.el.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) continue;
      if (w.el.classList.contains('pw-rolled')) continue;
      rerender(key);
    }
  }

  U.bus.on('sale', d => { lastSale = { amt: d && d.amt != null ? d.amt : d, t: SIM.S.time }; });

  return { open, close, tick, get isOpen() { return !!Object.keys(wins).length; } };
})();
