/* node test/composer-paste-limit.test.js — the COMMS composer must accept genuinely large pasted prompts.

   The old HTML maxlength stopped input at 4,000 characters before the send path or sidecar ever saw it.
   Keep the DOM ceiling and chat.js's truthful counter in lockstep, with a high enough limit for large
   documents while retaining a bounded request. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
const chat = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');

const textarea = /<textarea\s+id="chat-input"[^>]*>/i.exec(html);
A.ok(textarea, 'COMMS still renders the chat textarea');
const htmlMax = textarea && /\bmaxlength="(\d+)"/i.exec(textarea[0]);
A.ok(htmlMax, 'the composer retains an explicit bounded maxlength');
A.eq(Number(htmlMax && htmlMax[1]), 100000, 'the composer accepts a 100,000-character paste');

const limits = /const COMPOSER_MAX = (\d+), COMPOSER_WARN_AT = (\d+), COMPOSER_WARN_CHARS = (\d+);/.exec(chat);
A.ok(limits, 'chat.js declares the composer counter limits together');
A.eq(Number(limits && limits[1]), Number(htmlMax && htmlMax[1]), 'the visible counter uses the real DOM ceiling');
A.eq(Number(limits && limits[2]), 90000, 'the counter stays quiet until a paste is near the enlarged cap');
A.eq(Number(limits && limits[3]), 1000, 'the warning state covers the final 1,000 characters');
A.ok(/n >= COMPOSER_MAX - COMPOSER_WARN_CHARS/.test(chat), 'the warning state derives from the declared ceiling');

A.report('composer-paste-limit.test');
