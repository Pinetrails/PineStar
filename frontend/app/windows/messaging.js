/* STARNET — windows/messaging.js : the CHANNELS (messaging platforms) window (extracted verbatim from stationui.js).
   Loads AFTER stationui.js (see index.html) and registers itself via StationUI.registerWindow;
   the only stationui internals it touches are the enumerated StationUI.h helper surface
   (sfx/notify/openTerm/mountConsole and the live present view). */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow) return;
  const H = StationUI.h;
  const sfx = H.sfx, notify = H.notify, openTerm = H.openTerm;
  const mountConsole = H.mountConsole;

  /* ============== MESSAGING — every messaging platform the agent can be reached on ==============
     One catalog drives the whole CHANNELS panel: each entry supplies the platform copy (setup guide, field
     markup, messages) and the panel generates the card, status painting, and connect/disconnect wiring from
     it — adding a platform is a catalog row, mirroring the sidecar's channel registry. Status truth comes
     from ONE bulk poll (GET /api/channels/status) + live channel.connect bus refreshes. Only platforms the
     LOCAL-FIRST sidecar can honestly drive are listed (webhook-only surfaces like WhatsApp stay out). */
  function buildMessaging(body) {
    // ---- the channel catalog (copy + fields per platform; ids are literal so source-guards can pin them) ----
    // `accent` gives each card its per-platform accent strip + coin (marketplace card grammar); `steps` render as
    // an <ol> inside the setup <details>; `note` is the trailing dim caveat. Secret-input id + type order is
    // load-bearing (the wire source-guard pins e.g. id="sl-bot-token" type="password") — never reorder those.
    const CHANNEL_CATALOG = [
      { id: 'telegram', title: 'TELEGRAM', pre: 'tg', glyph: '✈', accent: '#37aee2',
        tagline: 'DM your agent from Telegram.',
        verb: 'polling',
        steps: [
          'In Telegram open <b>@BotFather</b> → send <code>/newbot</code> → copy the token it gives you.',
          'Paste it below and connect. Your agent answers DMs using this app\'s current provider + model.'
        ],
        note: 'The token is stored locally by the sidecar and never displayed.',
        fieldsHtml: '<label class="ch-lbl" for="tg-token">BOT TOKEN <span class="dim">— from @BotFather</span></label>' +
          '<input id="tg-token" type="password" class="key-input" placeholder="123456789:ABCdef..." autocomplete="off" spellcheck="false">',
        read: (b) => ({ token: (b.querySelector('#tg-token').value || '').trim() }),
        clear: (b) => { b.querySelector('#tg-token').value = ''; },
        emptyMsg: 'paste your @BotFather token first',
        okMsg: '✓ connected — open Telegram and DM your bot',
        // multi-bot: each additional bot is a SEPARATE Telegram contact hard-bound to one agent. The list paints
        // exclusively from the status payload's bots[] (truthful per-instance transport state); the add flow is
        // token + agent — the sidecar validates the token with getMe before anything persists.
        extraHtml:
          '<div class="ch-bots" id="tg-bots">' +
            '<div class="ch-bots-head">AGENT BOTS <span class="dim">— a separate Telegram contact per agent</span></div>' +
            '<div id="tg-bots-list"></div>' +
            '<details class="ch-setup" id="tg-bot-addbox"><summary>ADD A BOT</summary>' +
              '<ol class="ch-steps">' +
                '<li>In Telegram open <b>@BotFather</b> → <code>/newbot</code> → name it after your agent → copy the token.</li>' +
                '<li>Paste it below and pick which agent answers it. That bot <b>is</b> that agent — DM it directly, no /talk needed.</li>' +
              '</ol>' +
              '<label class="ch-lbl" for="tg-bot-token">BOT TOKEN <span class="dim">— from @BotFather</span></label>' +
              '<input id="tg-bot-token" type="password" class="key-input" placeholder="123456789:ABCdef..." autocomplete="off" spellcheck="false">' +
              '<label class="ch-lbl" for="tg-bot-agent">RUNS AS</label>' +
              '<select id="tg-bot-agent" class="key-input"></select>' +
              '<div class="set-save"><button class="bb sm" id="tg-bot-add">+ ADD AGENT BOT</button></div>' +
              '<div id="tg-bots-msg" class="msg"></div>' +
            '</details>' +
          '</div>' },

      { id: 'discord', title: 'DISCORD', pre: 'dc', glyph: '◈', accent: '#7c83f5',
        // HONESTY: server/channel messages need a chat allowlist no production path supplies yet — DMs only today.
        tagline: 'Two-way chat on Discord — DM your bot and it replies. (DMs only for now — server channels aren\'t wired yet.)',
        verb: 'receiving',
        steps: [
          'Open the <b>Discord Developer Portal</b> → <b>New Application</b> → <b>Bot</b> → <b>Reset Token</b> → copy the token.',
          'Enable <b>MESSAGE CONTENT INTENT</b> on the Bot page (required to read your messages), then invite the bot to a server (OAuth2 → URL Generator → <code>bot</code> scope).',
          'Paste the token below and connect.'
        ],
        note: 'The token is stored locally by the sidecar and never displayed.',
        fieldsHtml: '<label class="ch-lbl" for="dc-token">BOT TOKEN <span class="dim">— from the Discord Developer Portal</span></label>' +
          '<input id="dc-token" type="password" class="key-input" placeholder="MTE...Bot token" autocomplete="off" spellcheck="false">',
        read: (b) => ({ token: (b.querySelector('#dc-token').value || '').trim() }),
        clear: (b) => { b.querySelector('#dc-token').value = ''; },
        emptyMsg: 'paste your Discord bot token first',
        okMsg: '✓ connected — DM your bot on Discord',
        errHint: ' — check the bot token / MESSAGE CONTENT intent' },

      { id: 'slack', title: 'SLACK', pre: 'sl', glyph: '⌗', accent: '#b98ec8',
        // HONESTY: channel messages need a chat allowlist no production path supplies yet — DMs only today.
        // audit finding 5: Slack appears in BOTH panels — say which direction THIS one is.
        tagline: 'Your agent inside your Slack workspace — DM it and it replies. (DMs only for now — channels aren\'t wired yet. Want the agent to USE Slack as a tool instead? That\'s ⇄ TOOLSETS.)',
        verb: 'receiving',
        steps: [
          'Open <b>api.slack.com/apps</b> → <b>Create New App</b> → From scratch.',
          'Enable <b>Socket Mode</b> (Settings → Socket Mode) and create an <b>app-level token</b> with <code>connections:write</code> (starts <code>xapp-</code>).',
          'Under <b>OAuth &amp; Permissions</b> add bot scopes <code>chat:write</code>, <code>im:history</code>, <code>channels:history</code> → <b>Install to Workspace</b> → copy the <b>bot token</b> (starts <code>xoxb-</code>).',
          'Under <b>Event Subscriptions</b> subscribe the bot to <code>message.im</code>.'
        ],
        note: 'Both tokens are stored locally by the sidecar and never displayed.',
        fieldsHtml: '<label class="ch-lbl" for="sl-bot-token">BOT TOKEN <span class="dim">— xoxb-…, from OAuth &amp; Permissions</span></label>' +
          '<input id="sl-bot-token" type="password" class="key-input" placeholder="xoxb-..." autocomplete="off" spellcheck="false">' +
          '<label class="ch-lbl" for="sl-app-token">APP-LEVEL TOKEN <span class="dim">— xapp-…, from Socket Mode</span></label>' +
          '<input id="sl-app-token" type="password" class="key-input" placeholder="xapp-..." autocomplete="off" spellcheck="false">',
        read: (b) => {
          const bot = (b.querySelector('#sl-bot-token').value || '').trim();
          const app = (b.querySelector('#sl-app-token').value || '').trim();
          return { token: (bot && app) ? (bot + ' ' + app) : (bot || app) };   // combined secret; sidecar splits by prefix
        },
        clear: (b) => { b.querySelector('#sl-bot-token').value = ''; b.querySelector('#sl-app-token').value = ''; },
        emptyMsg: 'paste BOTH Slack tokens first (xoxb-… and xapp-…)',
        okMsg: '✓ connected — DM your Slack app' },

      { id: 'matrix', title: 'MATRIX', pre: 'mx', glyph: '▣', accent: '#5bd18d',
        tagline: 'Reach your agent from any Matrix client (Element, …) on any homeserver.',
        verb: 'syncing',
        steps: [
          'Create a Matrix account for the agent (e.g. on <b>matrix.org</b> or your homeserver).',
          'Get an <b>access token</b> for that account (Element: Settings → Help &amp; About → Advanced → Access Token).',
          'Enter the homeserver URL + token below and connect, then invite the agent\'s account to a room from YOUR account and accept the invite once from any client.'
        ],
        note: 'Every room is owner-locked: the first person to message the agent claims it.',
        fieldsHtml: '<label class="ch-lbl" for="mx-endpoint">HOMESERVER URL <span class="dim">— e.g. https://matrix.org</span></label>' +
          '<input id="mx-endpoint" type="text" class="key-input" placeholder="https://matrix.org" autocomplete="off" spellcheck="false">' +
          '<label class="ch-lbl" for="mx-token">ACCESS TOKEN <span class="dim">— for the agent\'s Matrix account</span></label>' +
          '<input id="mx-token" type="password" class="key-input" placeholder="syt_..." autocomplete="off" spellcheck="false">',
        read: (b) => ({ token: (b.querySelector('#mx-token').value || '').trim(), endpoint: (b.querySelector('#mx-endpoint').value || '').trim() }),
        clear: (b) => { b.querySelector('#mx-token').value = ''; },
        prefill: (b, st) => { const e = b.querySelector('#mx-endpoint'); if (e && !e.value && st && st.endpoint) e.value = st.endpoint; },
        urlField: 'mx-endpoint', urlScheme: 'https',
        emptyMsg: 'enter the homeserver URL and paste an access token first',
        okMsg: '✓ connected — message the agent\'s Matrix account' },

      { id: 'signal', title: 'SIGNAL', pre: 'sg', glyph: '◉', accent: '#6aa0ff', advanced: true,
        tagline: 'Message your agent on Signal through a self-hosted signal-cli bridge.',
        verb: 'receiving',
        steps: [
          'Run the <b>signal-cli REST API</b> next to StarNet (docker: <code>bbernhard/signal-cli-rest-api</code>).',
          'Register or link a number for the agent (the bridge\'s <code>/v1/register</code> or QR link flow).',
          'Enter the bridge URL + that number below and connect, then message it from your own Signal.'
        ],
        note: 'No token needed — the bridge runs on your machine; keep it bound to localhost.',
        fieldsHtml: '<label class="ch-lbl" for="sg-endpoint">SIGNAL-CLI REST URL <span class="dim">— e.g. http://127.0.0.1:8080</span></label>' +
          '<input id="sg-endpoint" type="text" class="key-input" placeholder="http://127.0.0.1:8080" autocomplete="off" spellcheck="false">' +
          '<label class="ch-lbl" for="sg-account">REGISTERED NUMBER <span class="dim">— the agent\'s Signal number</span></label>' +
          '<input id="sg-account" type="text" class="key-input" placeholder="+15551234567" autocomplete="off" spellcheck="false">',
        read: (b) => ({ endpoint: (b.querySelector('#sg-endpoint').value || '').trim(), account: (b.querySelector('#sg-account').value || '').trim() }),
        clear: () => {},
        prefill: (b, st) => {
          const e = b.querySelector('#sg-endpoint'); if (e && !e.value && st && st.endpoint) e.value = st.endpoint;
          const a = b.querySelector('#sg-account'); if (a && !a.value && st && st.account) a.value = st.account;
        },
        urlField: 'sg-endpoint', urlScheme: 'http',
        emptyMsg: 'enter the signal-cli REST URL and the registered number first',
        okMsg: '✓ connected — message the agent on Signal' }
    ];

    // ---- console shell (the SETTINGS layout): left platform rail, one pane per platform ----
    // OVERVIEW carries the intro copy, the ONE shared autonomous-ping opt-in, and a live per-platform summary
    // (click a row → jump to that platform's pane). Each platform pane hosts the SAME catalog-generated card as
    // the old single-scroll panel — every control id (tg-token, sl-bot-token, …) is unchanged, and mountConsole
    // mounts ALL panes into `body` up-front, so the body.querySelector wiring + wire source-guards are untouched.
    // The "keeps working headless" promise is FULL-CONTRAST (a real capability, not fine print), lifted out of the
    // opacity-.55 intro. The opt-in label reads as a plain sentence with its description on its own line.
    const overviewHtml =
      '<p class="set-about">Reach your agents from real messaging apps. A connected channel talks to the <b>same agent</b> you see here ' +
        '(same memory, tools, and workspace) — and on Telegram you can give <b>each agent its own bot</b>, a separate contact that always answers as that agent (see AGENT BOTS on the TELEGRAM pane).</p>' +
      // HONESTY (2026-07-15): closing the desktop app STOPS the sidecar (the shell reaps it on exit), so "works
      // with the app closed" was a false promise — and some channels deliberately discard the offline backlog on
      // reconnect (anti-stale-directive). Claim exactly what the harness proves: headless of THIS window, alive
      // only while the station runs, with the honest offline notice named instead of implied delivery.
      '<p class="ch-headless">It keeps working <b>headless</b> — a DM runs your agent even with this window closed, as long as the station app is running. Messages sent while the station is fully off are <b>not</b> processed — you get an honest "I was offline" note instead.</p>' +
      '<label class="set-row ch-optin"><input type="checkbox" id="ch-notify"> <span class="ch-optin-t">Message me on my connected channels when my agent finishes autonomous work</span>' +
        '<span class="ch-optin-d dim">A routine that runs on its own and produces something pings you on every channel you\'ve connected.</span></label>' +
      '<div id="ch-notify-msg" class="msg"></div>' +
      // live platform summary — painted from the SAME proven bulk status as the cards (never a second truth).
      '<div class="ch-sum"><div class="ch-bots-head">PLATFORMS <span class="dim">— pick one to set it up</span></div>' +
        CHANNEL_CATALOG.map(c =>
          '<button type="button" class="ch-sum-row" data-ch="' + c.id + '" style="--accent:' + c.accent + '">' +
            '<span class="ch-coin"><span class="ch-glyph">' + c.glyph + '</span></span>' +
            '<span class="ch-sum-t">' + c.title + (c.advanced ? ' <span class="ch-adv">ADVANCED</span>' : '') + '</span>' +
            '<span class="ch-state st-off" id="' + c.pre + '-sum">checking…</span>' +
          '</button>').join('') +
      '</div>';
    function cardHtml(c) {
      return '<div class="ch-card" id="ch-card-' + c.id + '" style="--accent:' + c.accent + '">' +
          '<div class="ch-head">' +
            '<span class="ch-coin"><span class="ch-glyph">' + c.glyph + '</span></span>' +
            '<div class="ch-id">' +
              '<h4 class="ch-title">' + c.title + (c.advanced ? ' <span class="ch-adv">ADVANCED · SELF-HOSTED</span>' : '') + '</h4>' +
              '<span class="ch-answers" id="' + c.pre + '-answers"></span>' +
            '</div>' +
            '<span class="ch-state" id="' + c.pre + '-status">checking…</span>' +
          '</div>' +
          '<p class="set-about ch-tagline">' + c.tagline + '</p>' +
          '<details class="ch-setup"><summary>SETUP GUIDE</summary>' +
            '<ol class="ch-steps"><li>' + c.steps.join('</li><li>') + '</li></ol>' +
            (c.note ? '<p class="ch-note">' + c.note + '</p>' : '') +
          '</details>' +
          c.fieldsHtml +
          '<div class="set-save">' +
            '<button class="bb sm" id="' + c.pre + '-connect">⏼ CONNECT</button> ' +
            '<button class="bb sm danger" id="' + c.pre + '-disconnect" style="display:none">⏏ DISCONNECT</button> ' +
            '<button class="bb xs danger" id="' + c.pre + '-forget" style="display:none" title="' + (c.id === 'signal' ? 'removes the saved bridge URL and registered number from this machine' : 'permanently deletes the saved token from this machine (record + OS keychain) — you’d have to set it up again') + '">' + (c.id === 'signal' ? '✕ REMOVE CONFIGURATION' : '⌫ FORGET') + '</button>' +
          '</div>' +
          '<div id="' + c.pre + '-msg" class="msg"></div>' +
          (c.extraHtml || '') +
        '</div>';
    }
    mountConsole(body, 'messaging', [
      { id: 'overview', label: 'OVERVIEW', glyph: '⌂', build: (pane) => { pane.innerHTML = overviewHtml; } }
    ].concat(CHANNEL_CATALOG.map(c => ({
      id: c.id, label: c.title, glyph: c.glyph,
      build: (pane) => { pane.innerHTML = cardHtml(c); }
    }))));
    // rail truth dots: one per platform tab, painted from the same proven status as its card (paintCard).
    for (const c of CHANNEL_CATALOG) {
      const tab = body.querySelector('#con-tab-messaging-' + c.id);
      if (tab) {
        const d = document.createElement('span');
        d.className = 'ch-rail-dot st-off'; d.id = c.pre + '-dot'; d.textContent = '●';
        tab.appendChild(d);
      }
    }
    // overview rows jump to the platform pane by driving the REAL rail tab (active state/aria stay correct).
    body.querySelectorAll('.ch-sum-row').forEach(row => row.addEventListener('click', () => {
      const t = body.querySelector('#con-tab-messaging-' + row.dataset.ch);
      if (t) { t.click(); sfx('click'); }
    }));

    // per-card mutable UI state kept out of the DOM: are we mid-connect (finalize the msg from the PROVEN status,
    // not the POST), and the saved placeholders (restored when a card goes back to un-configured).
    const configuredById = {};
    const pendingConnect = {};
    const savedPlaceholder = {};

    // status-line colour by state as a CLASS (never inline el.style.color — truthful-telemetry palette lives in css).
    function stateClass(conn, inFlight, state, configured) {
      if (conn) return 'st-up';
      if (state === 'error') return 'st-err';
      if (inFlight) return 'st-wait';
      return configured ? 'st-wait' : 'st-off';
    }
    function setMsg(el, text, kind) {   // kind: 'ok' (success/gold) | 'info' (neutral) | '' (error/red default)
      if (!el) return;
      el.className = 'msg' + (kind === 'ok' ? ' ok' : kind === 'info' ? ' info' : '');
      el.textContent = text || '';
    }

    // ---- multi-bot telegram: paint the AGENT BOTS list from status.bots (per-instance transport truth) ----
    function paintTelegramBots(bots) {
      const list = body.querySelector('#tg-bots-list');
      if (!list) return;
      list.textContent = '';
      for (const bItem of (Array.isArray(bots) ? bots : [])) {
        const row = document.createElement('div');
        row.className = 'tg-bot-row' + (bItem.connected ? ' on' : '');
        row.dataset.bot = String(bItem.botId || '');
        const name = document.createElement('span');
        name.className = 'tg-bot-name';
        name.textContent = (bItem.username ? '@' + bItem.username : 'bot ' + bItem.botId) + ' → ' + (bItem.agentName || bItem.agentId || '?');
        const state = document.createElement('span');
        const inFlight = !bItem.connected && (bItem.state === 'connecting' || bItem.state === 'reconnecting');
        state.className = 'ch-state ' + stateClass(bItem.connected, inFlight, bItem.state, bItem.configured);
        state.textContent = bItem.connected ? '● connected' : inFlight ? '◐ connecting…'
          : bItem.state === 'error' ? ('✕ ' + (bItem.detail || 'error')) : (bItem.enabled === false ? '○ off' : '○ offline');
        if (bItem.ownerLocked) state.title = 'owner-locked';
        row.appendChild(name); row.appendChild(state);
        const btn = (label, act, danger) => {
          const b = document.createElement('button');
          b.className = 'bb xs' + (danger ? ' danger' : ''); b.textContent = label; b.dataset.act = act; b.dataset.bot = String(bItem.botId || '');
          row.appendChild(b); return b;
        };
        if (!bItem.connected && bItem.configured) btn('⏵', 'resume', false).title = 'reconnect this bot';
        if (bItem.connected || bItem.enabled !== false) btn('⏏', 'off', false).title = 'disconnect (token kept)';
        btn('⌫', 'forget', true).title = 'forget this bot — removes its saved token';
        list.appendChild(row);
      }
      const wrap = body.querySelector('#tg-bots');
      if (wrap) wrap.classList.toggle('empty', !(Array.isArray(bots) && bots.length));
    }

    function paintCard(c, st) {
      const el = body.querySelector('#' + c.pre + '-status');
      if (!el) return;
      const conn = !!(st && st.connected);
      const state = st && st.state;
      const inFlight = !conn && (state === 'connecting' || state === 'reconnecting');
      const configured = !!(st && st.configured);
      configuredById[c.id] = configured;
      el.className = 'ch-state ' + stateClass(conn, inFlight, state, configured);
      el.textContent = conn ? ('● CONNECTED — ' + c.verb + (state && state !== 'up' ? ' (' + state + ')' : ''))
        : inFlight ? ('◐ ' + (state === 'reconnecting' ? 'reconnecting' : 'connecting') + '…' + (st.detail ? ' — ' + st.detail : ''))
        : state === 'error' ? ('✕ error' + (st.detail ? ' — ' + st.detail : '') + (c.errHint || ''))
        : configured ? ('○ saved but offline — RESUME to reconnect' + (st.detail ? ' — ' + st.detail : ''))
        : '○ not connected';
      // a standing backend warning (e.g. the owner binding failed to persist) rides EVERY state — real risk
      // the Commander must see, straight from channelStatusPayload (self-heals server-side once the disk agrees).
      if (st && st.warning) el.textContent += ' ⚠ ' + st.warning;
      // rail dot + overview summary row ride the SAME proven status (one truth, three projections)
      const dot = body.querySelector('#' + c.pre + '-dot');
      if (dot) dot.className = 'ch-rail-dot ' + stateClass(conn, inFlight, state, configured);
      const sum = body.querySelector('#' + c.pre + '-sum');
      if (sum) {
        sum.className = 'ch-state ' + stateClass(conn, inFlight, state, configured);
        sum.textContent = conn ? '● connected' : inFlight ? '◐ connecting…'
          : state === 'error' ? '✕ error' : configured ? '○ saved — offline' : '○ not connected';
      }
      if (c.prefill) { try { c.prefill(body, st); } catch (_) {} }
      const card = body.querySelector('#ch-card-' + c.id);
      if (card) card.classList.toggle('on', conn);

      // ANSWERS AS / owner-locked truth line (only once a config exists — never claim an identity for a cold card).
      const ans = body.querySelector('#' + c.pre + '-answers');
      if (ans) {
        const nm = (st && st.agentName || '').trim();
        const bits = [];
        if ((conn || configured) && nm) bits.push('ANSWERS AS: ' + nm);
        if (st && st.ownerLocked) bits.push('owner-locked ✓');
        ans.textContent = bits.join('  ·  ');
        ans.style.display = bits.length ? '' : 'none';
      }

      // buttons follow state: DISCONNECT/FORGET only when there is something to act on; CONNECT relabels to RESUME
      // when saved-but-offline, and disables to a neutral "connecting…" while a round-trip is in flight.
      const cBtn = body.querySelector('#' + c.pre + '-connect');
      const dBtn = body.querySelector('#' + c.pre + '-disconnect');
      const fBtn = body.querySelector('#' + c.pre + '-forget');
      if (cBtn) {
        cBtn.disabled = inFlight;
        cBtn.textContent = inFlight ? '◐ CONNECTING…' : (configured && !conn ? '⏵ RESUME' : '⏼ CONNECT');
      }
      if (dBtn) { dBtn.style.display = (conn || configured) ? '' : 'none'; if (!(conn || configured)) disarm(c.pre + '-disconnect', dBtn, '⏏ DISCONNECT'); }
      if (fBtn) { fBtn.style.display = configured ? '' : 'none'; if (!configured) disarm(c.pre + '-forget', fBtn, c.id === 'signal' ? '✕ REMOVE CONFIGURATION' : '⌫ FORGET'); }

      // saved-but-offline: swap the password placeholder to a non-echoing hint (never render the secret).
      body.querySelectorAll('#ch-card-' + c.id + ' input[type=password]').forEach(inp => {
        if (savedPlaceholder[inp.id] == null) savedPlaceholder[inp.id] = inp.getAttribute('placeholder') || '';
        inp.placeholder = (configured && !inp.value) ? '•••• saved — paste to replace' : savedPlaceholder[inp.id];
      });

      if (c.id === 'telegram') { try { paintTelegramBots(st && st.bots); } catch (_) {} }

      // finalize a pending connect's MESSAGE from the proven status (not the optimistic POST body).
      if (pendingConnect[c.id]) {
        const msgEl = body.querySelector('#' + c.pre + '-msg');
        if (conn) {
          setMsg(msgEl, c.okMsg, 'ok'); delete pendingConnect[c.id];
          // first-steps: only ticked on the PROVEN round-trip (this branch), never on the optimistic POST.
          try { if (typeof Tutorial !== 'undefined' && Tutorial.tickBrief) Tutorial.tickBrief('channel'); } catch (_) {}
        }
        else if (state === 'error') { setMsg(msgEl, '✕ ' + ((st && st.detail) || 'connection failed') + (c.errHint || ''), ''); delete pendingConnect[c.id]; }
        // else still 'connecting' — leave the neutral connecting… line until the transport proves one way or the other.
      }
    }

    // ---- armed-confirm helper: a danger action needs a second click within 2s (no accidental token loss) ----
    const armTimers = {};
    function disarm(id, btn, label) { if (armTimers[id]) { clearTimeout(armTimers[id]); delete armTimers[id]; } if (btn) { btn.classList.remove('armed'); btn.textContent = label; } }
    function armed(id, btn, label, confirmLabel, run) {
      if (btn.dataset.armed === '1') { disarm(id, btn, label); btn.dataset.armed = ''; run(); return; }
      btn.dataset.armed = '1'; btn.classList.add('armed'); btn.textContent = confirmLabel;
      armTimers[id] = setTimeout(() => { btn.dataset.armed = ''; disarm(id, btn, label); }, 2000);
    }

    let zeroChannelHintShown = false;
    async function refreshAll() {
      try {
        const r = await fetch('/api/channels/status');
        const all = await r.json();
        let notifyOn = false, anyConnected = false;
        for (const c of CHANNEL_CATALOG) { const st = all[c.id]; if (st) { paintCard(c, st); notifyOn = notifyOn || !!st.notifyAutonomous; anyConnected = anyConnected || !!st.connected; } }
        const nb = body.querySelector('#ch-notify'); if (nb) nb.checked = notifyOn;
        // notify is on but nothing is connected → it can never fire; say so honestly (don't imply pings will arrive).
        const nMsg = body.querySelector('#ch-notify-msg');
        if (notifyOn && !anyConnected) { setMsg(nMsg, 'no channel connected yet — connect one below so these pings have somewhere to go', 'info'); zeroChannelHintShown = true; }
        else if (zeroChannelHintShown) { setMsg(nMsg, '', 'info'); zeroChannelHintShown = false; }
      } catch (_) {
        for (const c of CHANNEL_CATALOG) {
          const el = body.querySelector('#' + c.pre + '-status');
          if (el) { el.className = 'ch-state st-off'; el.textContent = '○ sidecar offline'; }
          const dot = body.querySelector('#' + c.pre + '-dot');
          if (dot) dot.className = 'ch-rail-dot st-off';
          const sum = body.querySelector('#' + c.pre + '-sum');
          if (sum) { sum.className = 'ch-state st-off'; sum.textContent = '○ sidecar offline'; }
          configuredById[c.id] = false;
        }
      }
    }
    buildMessaging._refresh = refreshAll;
    // live transport health: channel.connect (up/down/error) is emitted + SSE-broadcast by every hub — one
    // subscription refreshes whichever card it names, the moment health changes (not only on panel reopen).
    if (!buildMessaging._wired && typeof U !== 'undefined' && U.bus) {
      buildMessaging._wired = true;
      U.bus.on('channel.connect', p => {
        if (p && p.channel && buildMessaging._refresh && document.querySelector('.ch-card')) buildMessaging._refresh();
      });
    }
    // 30s heartbeat re-poll while the panel is open — a background reconnect/drop repaints without a manual reopen.
    // Self-terminating: the moment this panel's body leaves the DOM (window closed / rerendered) the timer clears.
    if (buildMessaging._poll) { clearInterval(buildMessaging._poll); }
    buildMessaging._poll = setInterval(() => {
      if (!document.body.contains(body)) { clearInterval(buildMessaging._poll); buildMessaging._poll = null; return; }
      refreshAll();
    }, 30000);

    // ---- connect / disconnect / forget wiring, generated per card from the catalog ----
    // the SAME selected agent supplies the id, prompt AND name (previously the id came from the active workstream
    // but the prompt/name came from present[0] — a mismatch whenever the active stream wasn't the first agent).
    function agentIdentity() {
      const ws = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null;
      const wsAgentId = ws && ws.agentId;
      let ag = null;
      if (wsAgentId) ag = H.present.find(a => a && a.id === wsAgentId) || null;
      if (!ag) ag = H.present[0] || null;
      return { agentId: (ag && ag.id) || wsAgentId || 'agent', system: (ag && ag.systemPrompt) || '', agentName: (ag && ag.name) || '' };
    }
    // normalize a URL-shape config field client-side: prepend the scheme when the user typed a bare host, and write
    // the normalized value back so what they see is what we send. Returns '' when there's nothing usable.
    function normalizeUrl(raw, scheme) {
      let v = String(raw || '').trim();
      if (!v) return '';
      if (!/^https?:\/\//i.test(v)) v = scheme + '://' + v.replace(/^\/+/, '');
      try { const u = new URL(v); if (!u.hostname) return ''; return u.origin + (u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : ''); }
      catch (_) { return ''; }
    }
    for (const c of CHANNEL_CATALOG) {
      const msgEl = body.querySelector('#' + c.pre + '-msg');
      body.querySelector('#' + c.pre + '-connect').addEventListener('click', async () => {
        // URL-shape validation + auto-scheme for the endpoint channels, written back into the field before we read.
        if (c.urlField) {
          const inp = body.querySelector('#' + c.urlField);
          if (inp && inp.value.trim()) {
            const norm = normalizeUrl(inp.value, c.urlScheme);
            if (!norm) { sfx('bad'); setMsg(msgEl, '✕ that doesn\'t look like a URL — e.g. ' + inp.getAttribute('placeholder'), ''); return; }
            inp.value = norm;
          }
        }
        const vals = c.read(body);
        const hasFreshAuth = !!(vals.token || vals.endpoint || vals.account);
        // a saved config can be reused (one-click reconnect) — fresh credentials only required on first setup.
        if (!hasFreshAuth && !configuredById[c.id]) { sfx('bad'); setMsg(msgEl, c.emptyMsg, ''); return; }
        if (c.id === 'slack' && vals.token && !(/xoxb-/.test(vals.token) && /xapp-/.test(vals.token))) { sfx('bad'); setMsg(msgEl, c.emptyMsg, ''); return; }
        const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
        const usingCodex = provider === 'codex' || provider === 'openai-codex';
        const key = (typeof Harness !== 'undefined' && Harness.getKey) ? (Harness.getKey(provider) || '') : '';
        const baseUrl = (typeof Harness !== 'undefined' && Harness.getBaseUrl) ? (Harness.getBaseUrl(provider) || '') : '';
        const hasStoredKey = !!(typeof Harness !== 'undefined' && Harness.configured && Harness.configured(provider));
        const model = (typeof Harness !== 'undefined' && Harness.getModel()) || '';
        if (!model || (!usingCodex && !key && !hasStoredKey)) {
          sfx('bad'); setMsg(msgEl, '✕ connect your agent\'s provider + model in SETTINGS first', '');
          // deep-link door: land Settings on PROVIDERS so a beginner can fix it in one hop (pattern: openTerm section).
          const link = document.createElement('button'); link.className = 'ch-door'; link.textContent = 'open SETTINGS → PROVIDERS';
          link.addEventListener('click', () => { try { openTerm('settings', 'providers'); } catch (_) {} });
          msgEl.appendChild(document.createTextNode(' ')); msgEl.appendChild(link);
          return;
        }
        const ident = agentIdentity();
        pendingConnect[c.id] = true;
        setMsg(msgEl, 'connecting… — watch the status above for the verified result', 'info');
        try {
          // Desktop: park the secret in the OS keychain (via Tauri), then connect WITHOUT sending it over HTTP —
          // the sidecar reads it from the keychain-injected runtime layer. Browser: storeChannelToken is a no-op
          // and the token rides the POST body. Non-secret config (endpoint/account) always rides the body.
          let bodyToken = vals.token || '';
          let localFallback = false;
          if (typeof Harness !== 'undefined' && Harness.storeChannelToken && vals.token) {
            const stored = await Harness.storeChannelToken(c.id, vals.token);
            if (stored) bodyToken = '';
            else if (Harness.isDesktop && Harness.isDesktop()) localFallback = true;
          }
          const payload = { token: bodyToken, key, model, provider, baseUrl, agentId: ident.agentId, system: ident.system, agentName: ident.agentName };
          if (vals.endpoint != null) payload.endpoint = vals.endpoint;
          if (vals.account != null) payload.account = vals.account;
          const r = await Harness.api.post('/api/channels/' + c.id + '/connect', payload);
          const j = r.j || {};
          if (!r.ok || j.error) { delete pendingConnect[c.id]; setMsg(msgEl, '✕ ' + (j.error || ('HTTP ' + r.status)), ''); sfx('bad'); }
          else {
            // DERIVE the outcome line from the status refresh (paintCard finalizes pendingConnect), NOT from this
            // POST — the sidecar only reports 'connecting' until the transport actually proves the round-trip.
            if (localFallback) setMsg(msgEl, 'connecting… (token saved locally, not the OS keychain)', 'info');
            sfx('click');
            try { c.clear(body); } catch (_) {}
          }
        } catch (e) { delete pendingConnect[c.id]; setMsg(msgEl, '✕ ' + ((e && e.message) || 'failed to reach the sidecar'), ''); sfx('bad'); }
        refreshAll();
      });
      // DISCONNECT — armed (2s) so a stray click can't drop a live channel; never fires on a never-connected card
      // (the button is hidden then anyway). Marks the config disabled server-side but KEEPS the saved token so
      // RESUME is one click; use FORGET to actually purge the secret.
      const dBtn = body.querySelector('#' + c.pre + '-disconnect');
      dBtn.addEventListener('click', () => {
        if (!(configuredById[c.id])) { return; }   // nothing to disconnect — no lie, no request
        armed(c.pre + '-disconnect', dBtn, '⏏ DISCONNECT', '⏏ CONFIRM DISCONNECT', async () => {
          try { await Harness.api.post('/api/channels/' + c.id + '/disconnect', {}); setMsg(msgEl, 'disconnected — token kept; RESUME to reconnect', 'info'); sfx('click'); }
          catch (_) { setMsg(msgEl, '✕ could not reach the sidecar', ''); }
          refreshAll();
        });
      });
      // FORGET — armed purge of the stored secret (record + OS keychain). Explicit user destruction, so exempt from
      // the never-remove-a-secret-silently law; the record/runtime token is cleared server-side (purge:true) and the
      // desktop keychain entry is overwritten empty.
      const fBtn = body.querySelector('#' + c.pre + '-forget');
      fBtn.addEventListener('click', () => {
        if (!(configuredById[c.id])) { return; }
        const removeLabel = c.id === 'signal' ? '✕ REMOVE CONFIGURATION' : '⌫ FORGET';
        const confirmRemoveLabel = c.id === 'signal' ? '✕ CONFIRM REMOVE' : '⌫ CONFIRM FORGET';
        armed(c.pre + '-forget', fBtn, removeLabel, confirmRemoveLabel, async () => {
          try {
            // Signal has no token. Its destructive action removes the actual durable configuration — endpoint,
            // registered account and adapter ownership — and claims success only from the backend read-back bit.
            if (c.id === 'signal') {
              const r = await Harness.api.post('/api/channels/signal/disconnect', { purge: true });
              const j = r.j || {};
              if (j.removedConfiguration) {
                setMsg(msgEl, 'configuration removed — Signal is no longer configured on this machine', 'info');
                const endpoint = body.querySelector('#sg-endpoint'); if (endpoint) endpoint.value = '';
                const account = body.querySelector('#sg-account'); if (account) account.value = '';
                sfx('click');
              } else if (!r.ok || j.error) { setMsg(msgEl, '✕ ' + (j.error || ('HTTP ' + r.status)), ''); sfx('bad'); }
              else { setMsg(msgEl, '⚠ removal incomplete — could not prove the Signal configuration left disk; try again', ''); sfx('bad'); }
              refreshAll();
              return;
            }
            // Desktop: clear the OS-keychain copy and KEEP the result — a swallowed failure here used to let
            // the "purged" line lie while the token lived on in the keychain. Browser builds have no keychain
            // copy (storeChannelToken is a no-op false there), so only desktop counts it.
            let kcCleared = true;
            if (typeof Harness !== 'undefined' && Harness.storeChannelToken && Harness.isDesktop && Harness.isDesktop()) {
              kcCleared = await Promise.resolve(Harness.storeChannelToken(c.id, '')).then(ok => ok !== false).catch(() => false);
            }
            const r = await Harness.api.post('/api/channels/' + c.id + '/disconnect', { purge: true });
            const j = r.j || {};
            // truthful telemetry: "purged" is a DESTRUCTION claim — assert it only from the backend's
            // read-back-proven bit (j.purged) plus the keychain result, never from the click itself.
            if (j.purged && kcCleared) { setMsg(msgEl, 'forgotten — the stored token was purged', 'info'); sfx('click'); try { c.clear(body); } catch (_) {} }
            else if (!r.ok || j.error) { setMsg(msgEl, '✕ ' + (j.error || ('HTTP ' + r.status)), ''); sfx('bad'); }
            else {
              const where = [];
              if (!j.purged) where.push('the saved record');
              if (!kcCleared) where.push('the OS keychain');
              setMsg(msgEl, '⚠ forget incomplete — could not prove the token left ' + where.join(' or ') + '; try again', ''); sfx('bad');
            }
          } catch (_) { setMsg(msgEl, '✕ could not reach the sidecar', ''); }
          refreshAll();
        });
      });
      // Enter in any of the card's inputs = CONNECT
      body.querySelectorAll('#ch-card-' + c.id + ' input.key-input').forEach(inp => {
        inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); body.querySelector('#' + c.pre + '-connect').click(); } });
      });
    }

    // ---- multi-bot telegram wiring: add / resume / disconnect / forget --------------------------------------
    (function wireTelegramBots() {
      const msgEl = body.querySelector('#tg-bots-msg');
      const sel = body.querySelector('#tg-bot-agent');
      if (!sel) return;
      function fillAgents() {
        const cur = sel.value;
        sel.textContent = '';
        for (const a of (H.present || [])) {
          if (!a || !a.id) continue;
          const o = document.createElement('option');
          o.value = a.id; o.textContent = a.name || a.id;
          sel.appendChild(o);
        }
        if (cur) sel.value = cur;
      }
      fillAgents();
      const addBox = body.querySelector('#tg-bot-addbox');
      if (addBox) addBox.addEventListener('toggle', fillAgents);   // roster may have changed since build
      body.querySelector('#tg-bot-add').addEventListener('click', async () => {
        const tokInp = body.querySelector('#tg-bot-token');
        const token = (tokInp.value || '').trim();
        const agentId = sel.value;
        if (!token) { sfx('bad'); setMsg(msgEl, 'paste a @BotFather token for the new bot first', ''); return; }
        if (!agentId) { sfx('bad'); setMsg(msgEl, 'pick which agent this bot should be', ''); return; }
        const ag = (H.present || []).find(a => a && a.id === agentId) || null;
        const provider = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
        const usingCodex = provider === 'codex' || provider === 'openai-codex';
        const key = (typeof Harness !== 'undefined' && Harness.getKey) ? (Harness.getKey(provider) || '') : '';
        const baseUrl = (typeof Harness !== 'undefined' && Harness.getBaseUrl) ? (Harness.getBaseUrl(provider) || '') : '';
        const hasStoredKey = !!(typeof Harness !== 'undefined' && Harness.configured && Harness.configured(provider));
        const model = (typeof Harness !== 'undefined' && Harness.getModel()) || '';
        if (!model || (!usingCodex && !key && !hasStoredKey)) { sfx('bad'); setMsg(msgEl, '✕ connect your agent\'s provider + model in SETTINGS first', ''); return; }
        setMsg(msgEl, 'checking the token with Telegram…', 'info');
        try {
          const r = await Harness.api.post('/api/channels/telegram/bots/connect', {
            token, agentId, key, model, provider, baseUrl,
            system: (ag && ag.systemPrompt) || '', agentName: (ag && ag.name) || ''
          });
          const j = r.j || {};
          if (!r.ok || j.error) { sfx('bad'); setMsg(msgEl, '✕ ' + (j.error || ('HTTP ' + r.status)), ''); }
          else {
            sfx('click'); tokInp.value = '';
            // the CONNECTED claim stays with the list row (painted from proven per-instance status) — this line
            // only asserts what getMe proved: the token is real and the bot is bound.
            setMsg(msgEl, '✓ @' + (j.username || 'bot') + (j.rebound ? ' re-bound' : ' added') + ' — connecting; DM it on Telegram once the row shows ●', 'ok');
          }
        } catch (e) { sfx('bad'); setMsg(msgEl, '✕ ' + ((e && e.message) || 'failed to reach the sidecar'), ''); }
        refreshAll();
      });
      // row actions by delegation (rows re-render on every status paint)
      body.querySelector('#tg-bots-list').addEventListener('click', (ev) => {
        const b = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
        if (!b) return;
        const botId = b.dataset.bot, act = b.dataset.act;
        if (!botId) return;
        const doPost = async (path, payload, okText) => {
          try { const r = await Harness.api.post(path, payload || {}); const j = r.j || {};
            if (!r.ok || j.error) { sfx('bad'); setMsg(msgEl, '✕ ' + (j.error || ('HTTP ' + r.status)), ''); }
            else { sfx('click'); if (okText) setMsg(msgEl, okText, 'info'); } }
          catch (_) { sfx('bad'); setMsg(msgEl, '✕ could not reach the sidecar', ''); }
          refreshAll();
        };
        if (act === 'resume') doPost('/api/channels/telegram/bots/' + botId + '/connect', {}, null);
        else if (act === 'off') doPost('/api/channels/telegram/bots/' + botId + '/disconnect', {}, 'bot disconnected — token kept; ⏵ to reconnect');
        else if (act === 'forget') armed('tg-bot-forget-' + botId, b, '⌫', '⌫ SURE?', () =>
          doPost('/api/channels/telegram/bots/' + botId + '/disconnect', { purge: true }, 'bot forgotten — its token was removed'));
      });
    })();

    // ---- the ONE global "ping me when I work on my own" opt-in (persisted server-side; cron reads it) ----
    const notifyBox = body.querySelector('#ch-notify');
    const notifyMsg = body.querySelector('#ch-notify-msg');
    if (notifyBox) notifyBox.addEventListener('change', async () => {
      try {
        const r = await Harness.api.post('/api/channels/notify', { on: notifyBox.checked });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        sfx('click'); refreshAll();   // refresh so the zero-channel hint appears/clears from PROVEN status
      } catch (_) { notifyBox.checked = !notifyBox.checked; setMsg(notifyMsg, '✕ couldn\'t save that — the sidecar didn\'t answer', ''); }
    });

    refreshAll();
  }

  StationUI.registerWindow('messaging', 'CHANNELS', buildMessaging, { console: true });   // console mode = the wide SETTINGS-style two-pane window; dock label = window title (it's Telegram/external channels, not COMMS)
})();
