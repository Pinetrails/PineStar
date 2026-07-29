/* node test/friendlyerror.test.js — the beginner-facing error translator (frontend/app/friendlyerror.js).
   Focus: the zero-to-value paths — managed-credit exhaustion routes to the STORE, and the no-provider/auth
   state offers BOTH the ChatGPT sign-in and the add-a-key path (never a single dead-end). */
'use strict';
const A = require('./_assert.js');
const { friendlyError, actionButton, KINDS, CAP_INFO } = require('../frontend/app/friendlyerror.js');

/* ---- transport loss during an established SSE stream => retryable `network`, never "unknown" ----
   THIS BLOCK USED TO ASSERT THE DEFECT (fixed 2026-07-29). It required every one of these strings to produce
   "local service / reload / restart" guidance. But these five are precisely the shapes undici emits when the
   MODEL PROVIDER's stream dies mid-answer, which the sidecar forwards verbatim — so the assertion was pinning
   in place a message that told users with a perfectly healthy install to restart and reinstall. A 0.7.0 user
   lost a day to it. The kind and retryability are unchanged (they drive behavior); what is now locked is that
   the COPY only ever names the local service when liveness was actually MEASURED. */
for (const raw of [
  'terminated',
  'socket hang up',
  'other side closed',
  'premature close',
  'read ECONNRESET'
]) {
  const v = friendlyError(new Error(raw));
  A.eq(v.kind, 'network', raw + ' classifies as a transport disconnect');
  A.eq(v.retryable, true, raw + ' remains retryable after the station returns');
  A.ok(/try again/i.test(v.userMessage), raw + ' still gives a concrete next step');
  // the regression guard: unprobed, it must not blame (or absolve) the local engine.
  A.eq(v.engineAlive, null, raw + ' unprobed => engineAlive null');
  A.ok(!/local service|restart/i.test(v.userMessage), raw + ' unprobed must NOT prescribe restarting the app');

  // measured DOWN => the restart advice is earned, and only here.
  const down = friendlyError(new Error(raw), null, { engineAlive: false });
  A.ok(/local service/i.test(down.userMessage), raw + ' + proven-down engine names the local service');
  A.ok(/restart/i.test(down.userMessage), raw + ' + proven-down engine prescribes a restart');

  // measured UP => naming the local service would be a lie; it must point at the stream instead.
  const up = friendlyError(new Error(raw), null, { engineAlive: true });
  A.ok(!/Can't reach/i.test(up.userMessage), raw + ' + proven-up engine never claims it is unreachable');
  A.ok(/reply stream/i.test(up.userMessage), raw + ' + proven-up engine names the reply stream');
  A.eq(up.retryable, true, raw + ' + proven-up engine is still retryable');
}

// ---- managed-credit exhaustion => STORE upsell (only reachable when a credits backend is wired) ----
{
  const v = friendlyError('Out of managed credit — add credits in the STORE to keep running (or connect your own provider key).');
  A.eq(v.kind, 'managed_credit', 'a managed-credit-out message classifies as managed_credit');
  A.eq(v.action, 'store', 'managed_credit routes the CTA to the STORE, not a blind retry');
  A.eq(v.retryable, false, 'an exhausted managed balance is not retryable as-is');
  // 2026-07-15 UX sweep: the copy now names the SAME door the CTA button opens (SETTINGS → PROVIDERS) —
  // "the STORE" was a surface that exists nowhere as a button (the old copy/button mismatch).
  A.ok(/credit/i.test(v.userMessage) && /providers/i.test(v.userMessage), 'the message names the credit problem and the PROVIDERS door (the same one the button opens)');
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

// ---- EL-11 FIX 2: sidecar 403 (stale X-StarNet-Token after crash+respawn) => the RELOAD door, never the key door ----
{
  // the exact shape Harness.chat throws after the body-preserving fix (body: "forbidden token")
  const v = friendlyError(new Error('sidecar HTTP 403 — forbidden token'));
  A.eq(v.kind, 'stale_session', 'a sidecar 403 classifies as stale_session, not auth');
  A.eq(v.action, 'reload', 'the door is a reload, never the provider-key field');
  A.eq(v.retryable, false, 'a stale token is not fixed by a blind retry');
  A.ok(/restart/i.test(v.userMessage) && /reload/i.test(v.userMessage), 'the copy says the station restarted and to reload');
  const btn = actionButton(v);
  A.ok(btn && /reload/i.test(btn.label) && typeof btn.run === 'function', 'actionButton yields a RELOAD door');
  A.ok(!/key/i.test(btn.label), 'the label never offers "Add a key" for a stale session');
  let threw = false; try { btn.run(); } catch (_) { threw = true; }
  A.ok(!threw, 'the reload run() degrades quietly with no location global (node)');
}
{
  // the pre-fix bare shape (no body) must ALSO take the reload door — old streams/paths still throw it
  A.eq(friendlyError(new Error('sidecar HTTP 403')).kind, 'stale_session', 'a bare "sidecar HTTP 403" is a stale session');
  // and a caller passing the status separately with the sidecar's raw body text
  A.eq(friendlyError(new Error('forbidden token'), 403).kind, 'stale_session', 'status 403 + "forbidden token" body is a stale session');
  // a PROVIDER 403 (no sidecar-gate marker) keeps the auth path — only the sidecar's own gate means "reload"
  A.eq(friendlyError(new Error('invalid api key'), 403).kind, 'auth', 'a provider 403 (key rejected) still classifies as auth');
}

// ---- EL-11 FIX 3 (ladder half): a pre-stream sidecar failure that CARRIES its body reaches the oauth door ----
{
  // handleRun throws pre-stream via runRouteFailure: 500 {"error":"sidecar failure: Not signed in to ChatGPT …"}.
  // With the body preserved by Harness.chat, the ladder must land on oauth → RECONNECT CHATGPT (EL-10 family).
  const v = friendlyError(new Error('sidecar HTTP 500 — sidecar failure: Not signed in to ChatGPT — connect a ChatGPT subscription first. (codex_not_connected)'));
  A.eq(v.kind, 'oauth', 'a pre-stream codex_not_connected body classifies as oauth once the body survives');
  const btn = actionButton(v);
  A.ok(btn && /RECONNECT CHATGPT/i.test(btn.label), 'the door is RECONNECT CHATGPT, not a generic retry');
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
