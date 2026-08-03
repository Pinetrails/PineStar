/* node test/summon-desk-prompt.test.js — THE POST-SUMMON DESK STEP IS OWNED BY THE SESSION.

   A hand-summoned specialist arrives with no desk on purpose (the Commander chooses where it sits), and it
   cannot take floor work until one exists. That step used to be printed ONCE by summonAgent as a DOM-only
   line — so the first stream switch or reload erased the only place it was ever stated (load() rebuilds the
   log from ws.history, and a local line is not history), and a live beat could drop it outright. A brand-new
   agent's session then looked like any other empty stream, with the required next step nowhere on screen.

   Locked here: the prompt is re-derived from the LIVE FLOOR on every open of that agent's session, and it
   stops for good the moment the desk exists. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const app = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
const chat = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');

/* ---- the read: a truthful floor query, never a stored flag ---- */
const need = /function needsWorkstation\(agentId\)[\s\S]{0,900}?\n  \}/.exec(app);
A.ok(need, 'app.js owns a needsWorkstation(agentId) read');
A.ok(/propsByAgent\(id\)\.some\(p => station\.capForProp\(p\.t\) === 'computer'\)/.test(need[0]),
  'it answers from the props actually bound to that agent on the live floor (capability = computer), not a flag');
A.ok(/id === 'agent'[\s\S]{0,40}return false/.test(need[0]),
  'the hero is excluded — its starter desk is seeded at wake and its stream owns the first-run hint');
A.ok(/!agents\.has\(id\)[\s\S]{0,40}return false/.test(need[0]),
  'an id that is not on the live roster is never claimed to owe a desk');
A.ok(/if \(!station \|\|[\s\S]{0,180}return false/.test(need[0]),
  'it fails CLOSED without a station — the app never claims a floor state it cannot prove');
A.ok(/needsWorkstation: needsWorkstation/.test(app) && /openDeskPlacement: openDeskPlacement/.test(app),
  'both the read and the door it offers are exposed on the App API for the session to use');

/* ---- the session states it on EVERY open, not once at summon ---- */
A.ok(/maybeEmptyState\(\);[\s\S]{0,140}maybeDeskPrompt\(\);/.test(chat),
  'chat.js load() runs maybeDeskPrompt on every stream open, right after the empty-state hint');
const beat = /function maybeDeskPrompt\(\)[\s\S]{0,1400}?\n  \}/.exec(chat);
A.ok(beat, 'chat.js owns maybeDeskPrompt');
A.ok(/App\.needsWorkstation\(id\)/.test(beat[0]),
  'the prompt is gated on the live read, so placing the desk retires it for good with no dismissal to store');
A.ok(/activeWs\.agentId \|\| 'agent'/.test(beat[0]),
  'it asks about THIS stream\'s agent — never the focused one (a switch must not move the prompt)');
A.ok(/nowhere to sit yet/.test(beat[0]) && /before it can take floor work/.test(beat[0]),
  'it states plainly what is missing and what it blocks');
A.ok(/'▤ PLACE ITS DESK'[\s\S]{0,220}App\.openDeskPlacement\(\)/.test(beat[0]),
  'the chip under it opens REFIT armed for placement — the step is actionable, never a passing remark');
A.ok(/if \(!log \|\| interview \|\| !activeWs \|\| isBusy\(\)\) return/.test(beat[0]),
  'silent only while that stream is mid-run or awakening — it returns on the next open');
A.ok(!/beatBusy\(\)/.test(beat[0]),
  'a live beat elsewhere can no longer swallow the required step (the old one-shot line was dropped, never queued)');

/* ---- and summonAgent no longer keeps a second, weaker copy of it ---- */
A.ok(!/Chat\.localLine\([\s\S]{0,120}nowhere to sit/.test(app),
  'summonAgent no longer prints its own one-shot desk line — the session is the single source');
A.ok(!/Chat\.choices\(\[\{ label: '▤ PLACE ITS DESK'/.test(app),
  '…nor its own chip row, which could otherwise drift from the session\'s');

/* ---- the door itself still lands on the workstation palette ---- */
const door = /function openDeskPlacement\(\)[\s\S]{0,1400}?\n  \}/.exec(app);
A.ok(door && /refit-tool\[data-tool="prop"\]/.test(door[0]) && /refit-propcat\[data-cat="workstation"\]/.test(door[0]),
  'openDeskPlacement drives REFIT to the PROP tool on the WORKSTATIONS category so the next floor click drops the desk');

A.report('summon-desk-prompt.test');
