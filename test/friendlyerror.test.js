/* node test/friendlyerror.test.js — the beginner-facing error translator (frontend/app/friendlyerror.js).
   Focus: the zero-to-value paths — managed-credit exhaustion routes to the STORE, and the no-provider/auth
   state offers BOTH the ChatGPT sign-in and the add-a-key path (never a single dead-end). */
'use strict';
const A = require('./_assert.js');
const { friendlyError, KINDS } = require('../frontend/app/friendlyerror.js');

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

A.report('friendlyerror.test');
