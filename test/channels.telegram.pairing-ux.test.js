/* node test/channels.telegram.pairing-ux.test.js -- a healthy poller is not yet a usable Telegram channel.

   The reported failure was a truthful transport fact rendered as a false product claim: the Bot API poll loop
   was up, but owner enrollment was unfinished, so every ordinary DM was rejected while CHANNELS said CONNECTED
   and told the Commander to DM the bot. Lock both halves of the repair: connect returns the one-time local code,
   and the panel renders the unpaired poller as blocked rather than operational. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'frontend', 'app', 'windows', 'messaging.js'), 'utf8');
const sidecar = fs.readFileSync(path.join(root, 'sidecar', 'index.js'), 'utf8');

A.ok(ui.includes('POLLING — DMs BLOCKED: PAIR OWNER'),
  'an up Telegram poller without an owner is rendered as blocked, never CONNECTED');
A.ok(/j\.pairingCode/.test(ui) && /\/pair /.test(ui),
  'the connect response pairing code is turned into the exact Telegram command the Commander must send');
A.ok(/pairingInstruction/.test(ui),
  'the one-time pairing command is retained across the asynchronous status repaint');
A.ok(/owner pairing/i.test(ui.slice(ui.indexOf("id: 'telegram'"), ui.indexOf("id: 'discord'"))),
  'the Telegram setup guide names owner pairing as part of setup');

A.ok(/out\.pairingCode = pairing\.code/.test(sidecar),
  'the authenticated connect route returns the freshly issued one-time pairing code');
A.ok(/ownerLocked, acceptingDms/.test(sidecar),
  'channel status exposes the operational DM-admission truth separately from poll health');

const mirror = fs.readFileSync(path.join(root, 'website', 'app', 'app', 'windows', 'messaging.js'), 'utf8');
A.ok(mirror.includes('POLLING — DMs BLOCKED: PAIR OWNER') && /j\.pairingCode/.test(mirror),
  'the generated website app mirror carries the same pairing truth');

A.report('channels.telegram.pairing-ux.test');
