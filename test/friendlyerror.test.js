/* node test/friendlyerror.test.js — the beginner-facing error translator (frontend/app/friendlyerror.js).
   Focus: the zero-to-value paths — managed-credit exhaustion routes to the STORE, and the no-provider/auth
   state offers BOTH the ChatGPT sign-in and the add-a-key path (never a single dead-end). */
'use strict';
const A = require('./_assert.js');
const { friendlyError, actionButton, KINDS, CAP_INFO } = require('../frontend/app/friendlyerror.js');

// ---- managed-credit exhaustion => STORE upsell (only reachable when a credits backend is wired) ----
{
  const v = friendlyError('Out of managed credit — add credits in the STORE to keep running (or connect your own provider key).');
  A.eq(v.kind, 'managed_credit', 'a managed-credit-out message classifies as managed_credit');
  A.eq(v.action, 'store', 'managed_credit routes the CTA to the STORE, not a blind retry');
  A.eq(v.retryable, false, 'an exhausted managed balance is not retryable as-is');
  A.ok(/credit/i.test(v.userMessage) && /store/i.test(v.userMessage), 'the message names the credit problem and the STORE plainly');
}

// ---- the "credits unavailable" (service didn't answer) admission message also reads as managed_credit ----
{
  const v = friendlyError('Managed credits are unavailable right now — the credits service did not answer (try again, or use your own provider key).');
  A.eq(v.kind, 'managed_credit', 'the unavailable-credits admission message also maps to managed_credit');
  A.eq(v.action, 'store', 'it still points at the STORE (top up / switch key)');
}

// ---- no provider / auth => BOTH paths offered (ChatGPT sign-in OR add a key), pointed at Settings ----
{
  const v = friendlyError(new Error('no API key set'));
  A.eq(v.kind, 'auth', 'a pre-flight "no API key set" is an auth/misconfig, not a fault');
  A.eq(v.action, 'settings', 'auth points at Settings/CONNECTIONS where both paths live');
  A.ok(/chatgpt/i.test(v.userMessage) && /key/i.test(v.userMessage), 'the auth message offers BOTH the ChatGPT sign-in and the add-a-key path');
}

// ---- expired ChatGPT sign-in => oauth, and still offers the key alternative ----
{
  const v = friendlyError(new Error('codex_not_connected'));
  A.eq(v.kind, 'oauth', 'a codex_not_connected error is an oauth reconnection case');
  A.eq(v.action, 'settings', 'oauth points at Settings to reconnect');
  A.ok(/key/i.test(v.userMessage), 'the oauth message still names the add-a-key alternative (never a single dead-end)');
}

// ---- a plain provider billing error (BYOK) stays `billing` -> Settings (NOT the managed STORE) ----
{
  const e = new Error('insufficient credit'); e.status = 402;
  const v = friendlyError(e, 402);
  A.eq(v.kind, 'billing', 'a BYOK provider out-of-credit is the generic billing kind');
  A.eq(v.action, 'settings', 'BYOK billing points at Settings (its own provider account), not the managed STORE');
}

// ---- the managed_credit kind exists in the table with the store action ----
{
  A.ok(KINDS.managed_credit && KINDS.managed_credit.action === 'store', 'KINDS carries a managed_credit entry actioned to the store');
}

// ---- capdenied v2: name the exact power + gear, and route to REFIT (the true unlock), NOT the SKILLS list ----
{
  // the sidecar/harness build a room-cap denial as "no <need> — <reason>"
  const v = friendlyError(new Error('no web — no capability for web.search in room comms'));
  A.eq(v.kind, 'capdenied', 'a "no web — …" denial classifies as capdenied');
  A.eq(v.cap, 'web', 'the missing capability is parsed off the raw message');
  A.eq(v.action, 'refit', 'capdenied routes to REFIT (place the gear), never the SKILLS list');
  A.ok(/WEB ACCESS/.test(v.userMessage), 'the copy names the human power (WEB ACCESS)');
  A.ok(/DISH/.test(v.userMessage), 'the copy names the placeable GEAR (DISH)');
  A.ok(/REFIT/.test(v.userMessage), 'the copy points at REFIT as the door');
}
{
  // a files denial names FILE ACCESS + the CABINET
  const v = friendlyError(new Error('no cabinet — no capability for fs.write in room ops'));
  A.eq(v.cap, 'cabinet', 'a cabinet denial parses to cabinet');
  A.ok(/FILE ACCESS/.test(v.userMessage) && /CABINET/.test(v.userMessage), 'the copy names FILE ACCESS + the CABINET');
}
{
  // the compute (turn-precondition) denial the loop emits: "no compute — no compute capability …"
  const v = friendlyError(new Error('no compute — no compute capability — place a computer in the room'));
  A.eq(v.kind, 'capdenied', 'the compute gate denial is a capdenied');
  A.eq(v.cap, 'compute', 'compute parses as the capability');
  A.eq(v.action, 'refit', 'the compute gate also routes to REFIT (place a DESK)');
}
{
  // an unparseable capdenied still classifies + routes to REFIT with the generic (no-cap) copy
  const v = friendlyError(new Error('capdenied'));
  A.eq(v.kind, 'capdenied', 'a bare "capdenied" token still classifies');
  A.eq(v.action, 'refit', 'it still routes to REFIT');
  A.eq(v.cap, null, 'no capability could be parsed → cap is null');
  A.ok(/REFIT/.test(v.userMessage), 'the fallback copy still names REFIT');
  A.ok(!/undefined/.test(v.userMessage), 'the fallback copy never leaks "undefined"');
}

// ---- no "max_iters"-style raw token leaks in any KINDS message (jargon hygiene) ----
{
  const bad = /max_iters|max_tokens|sidecar HTTP|429|4\d\d|\bnull\b|undefined|capdenied|_[a-z]+_/;
  for (const [k, def] of Object.entries(KINDS)) {
    A.ok(!bad.test(def.msg), 'KINDS.' + k + ' message carries no technical token: ' + def.msg);
  }
}

// ---- actionButton: maps a verdict to a wireable { label, run } door; null when there is no door ----
{
  const cap = friendlyError(new Error('no web — denied'));
  const btn = actionButton(cap);
  A.ok(btn && /REFIT/i.test(btn.label) && typeof btn.run === 'function', 'a capdenied verdict yields a REFIT button with a run()');
  A.eq(actionButton({ action: null, retryable: true }), null, 'a plain-retry verdict yields no action button');
  A.eq(actionButton(null), null, 'a null verdict yields no button (never throws)');
  // run() is safe to call with no globals present (Build/StationUI undefined in node) — must not throw.
  let threw = false; try { btn.run(); } catch (_) { threw = true; }
  A.ok(!threw, "the REFIT button's run() degrades quietly when no surface is loaded");
  // auth (no ChatGPT connected in node) → a key/settings door
  const authBtn = actionButton(friendlyError(new Error('no API key set')));
  A.ok(authBtn && typeof authBtn.run === 'function' && /key|settings/i.test(authBtn.label), 'an auth verdict yields a key/settings door');
}

// ---- CAP_INFO covers every capId the sidecar can deny (parity guard against a missing gear entry) ----
{
  for (const id of ['compute', 'web', 'cabinet', 'workbench', 'memory', 'studio', 'jukebox', 'orchestrator']) {
    A.ok(CAP_INFO[id] && CAP_INFO[id].power && CAP_INFO[id].gear, 'CAP_INFO names a power + gear for ' + id);
  }
}

A.report('friendlyerror.test');
