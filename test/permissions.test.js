/* node test/permissions.test.js — the informed-consent broker (roadmap P1.5a).
   Proves the four-tier ladder is pure, deterministic, fail-closed, and session-scoped:
   hardline floor sits BELOW the bypass flag, mutations default-deny under an autonomous surface,
   grants are per-session (not process-global), and an 'always' grant only sticks if it persisted. */
'use strict';
const A = require('./_assert.js');
const { makeConsentBroker, ANTI_RETRY, SILENCE } = require('../sidecar/permissions.js');

// tool shapes as produced by makeTool (carry scope/capability, NOT network)
const WRITE = { name: 'fs.write', capability: 'files', scope: 'write', requiresConsent: true };
const READ = { name: 'fs.read', capability: 'files', scope: 'read' };
const NET_READ = { name: 'web_fetch', capability: 'web', scope: 'read', network: true };
const writeCall = { name: 'fs.write', args: { path: 'report.md' } };

// a hardline floor like the one index.js will inject: protected files, even inside the jail.
const hardline = (call) => (call && call.args && /(^|\/)(\.env|permissions\.allow\.json)$/.test(call.args.path)) ? 'protected file' : null;

// ---- 1. HARDLINE sits below BYPASS: a floor file is denied even with Full Access ----
{
  const consent = makeConsentBroker({ bypass: true, hardline: hardline });
  const r = consent({ name: 'fs.write', args: { path: '.env' } }, WRITE);
  A.ok(!r.allow, 'hardline denies even with bypass=true');
  A.ok(r.hardline === true, 'denial flagged hardline');
  A.ok(r.reason.indexOf('protected file') >= 0, 'hardline reason names the cause');
  A.ok(r.reason.indexOf('do not retry') >= 0, 'hardline reason carries the anti-retry suffix');
  A.ok(ANTI_RETRY.length > 0, 'ANTI_RETRY constant exported');

  // a NON-floor write WITH bypass is allowed (bypass still works above the floor)
  const ok = consent(writeCall, WRITE);
  A.ok(ok.allow, 'bypass allows a non-hardline write');
  A.eq(ok.reason, 'full-access', 'bypass reason is full-access');
  A.eq(ok.scope, 'write', 'scope echoed back');
}

// ---- 2. RESOLVE: read-only & non-network auto-allows; read+network does NOT ----
{
  const consent = makeConsentBroker({ surface: 'autonomous' });
  A.ok(consent({ name: 'fs.read', args: {} }, READ).allow, 'read-only non-network auto-allows');
  const netr = consent({ name: 'web_fetch', args: {} }, NET_READ);
  A.ok(!netr.allow, 'read-but-network is NOT auto-allowed (the !network clause)');
  A.eq(netr.reason, SILENCE, 'network read falls through to default-deny');
}

// ---- 3. un-granted mutation under autonomous -> default-deny (silence is not consent) ----
{
  const consent = makeConsentBroker(); // surface defaults to autonomous, bypass defaults false
  const r = consent(writeCall, WRITE);
  A.ok(!r.allow, 'ungranted mutation default-denies');
  A.eq(r.reason, SILENCE, 'default-deny reason is the silence rule');
}

// ---- 4. a 'session' grant is per-session, not process-global ----
{
  const grantsSession = new Map();              // shared store across both run brokers
  const run1 = makeConsentBroker({ sessionKey: 'run1', grantsSession: grantsSession });
  const run2 = makeConsentBroker({ sessionKey: 'run2', grantsSession: grantsSession });

  A.ok(!run1(writeCall, WRITE).allow, 'before grant: run1 denies');
  run1.grant('session', writeCall, WRITE);
  const after = run1(writeCall, WRITE);
  A.ok(after.allow, 'after session grant: SAME session allows');
  A.eq(after.reason, 'previously granted', 'allowed via the cache tier');
  A.ok(!run2(writeCall, WRITE).allow, 'a DIFFERENT session is unaffected (session-scoped, not global)');
}

// ---- 5. an 'always' grant persists exactly once and survives a fresh broker ----
{
  let saved = null, calls = 0;
  const persist = (arr) => { calls++; saved = arr.slice(); };
  const broker = makeConsentBroker({ sessionKey: 'r', persist: persist });

  const g = broker.grant('always', writeCall, WRITE);
  A.ok(g.allow, 'always grant succeeds when persist succeeds');
  A.eq(calls, 1, 'persist called exactly once');
  A.eq(saved, ['files:write'], 'persisted the danger CLASS only (capability:scope), never args/paths');

  // rebuild a brand-new broker from the persisted set, under an UNRELATED session
  const reborn = makeConsentBroker({ sessionKey: 'other', grantsPermanent: new Set(saved) });
  const r = reborn(writeCall, WRITE);
  A.ok(r.allow, 'permanent grant survives a fresh broker and ignores sessionKey');
  A.eq(r.reason, 'previously granted', 'allowed via the cache tier');
}

// ---- 6. a thrown persist degrades to deny and records nothing (fail-closed) ----
{
  const broker = makeConsentBroker({ persist: () => { throw new Error('disk full'); } });
  const g = broker.grant('always', writeCall, WRITE);
  A.ok(!g.allow, 'always grant denied when persist throws');
  A.ok(g.reason.indexOf('persist') >= 0, 'reason explains the persist failure');
  A.ok(!broker(writeCall, WRITE).allow, 'the failed grant was NOT recorded — consent still denies');
  A.eq(broker.snapshot().permanent.length, 0, 'snapshot shows nothing committed');
}

// ---- 7. snapshot reflects committed grants (read-only view) ----
{
  const broker = makeConsentBroker({ sessionKey: 's1' });
  broker.grant('session', writeCall, WRITE);
  broker.grant('always', writeCall, WRITE); // no persist injected -> in-memory only
  const snap = broker.snapshot();
  A.eq(snap.permanent, ['files:write'], 'snapshot lists permanent grants');
  A.eq(snap.session.s1, ['files:write'], 'snapshot lists session grants by key');
}

// ---- 8. 'once' allows without recording; 'deny'/unknown denies ----
{
  const broker = makeConsentBroker({ sessionKey: 'o' });
  A.ok(broker.grant('once', writeCall, WRITE).allow, 'once allows');
  A.ok(!broker(writeCall, WRITE).allow, 'once did not record a standing grant');
  A.ok(!broker.grant('deny', writeCall, WRITE).allow, 'explicit deny denies');
  A.ok(!broker.grant('weird', writeCall, WRITE).allow, 'unknown decision denies');
}

// ---- 9-11. the INTERACTIVE surface (async: the human-prompt branch is the only one that returns a Promise) ----
(async () => {
  const brokerWith = (decision, extra) =>
    makeConsentBroker(Object.assign({ surface: 'interactive', prompt: () => Promise.resolve(decision) }, extra || {}));

  // 9. once allows without recording; deny/unknown deny; always persists the CLASS and then short-circuits (no re-ask)
  A.ok((await brokerWith('once')(writeCall, WRITE)).allow, 'interactive once -> allow');
  A.ok(!(await brokerWith('deny')(writeCall, WRITE)).allow, 'interactive deny -> deny');
  A.ok(!(await brokerWith('zzz')(writeCall, WRITE)).allow, 'interactive unknown decision -> deny');
  let saved = null;
  const bAlways = brokerWith('always', { sessionKey: 'iv', persist: a => { saved = a.slice(); } });
  A.ok((await bAlways(writeCall, WRITE)).allow, 'interactive always -> allow');
  A.eq(saved, ['files:write'], 'interactive always persisted the danger CLASS only');
  const again = bAlways(writeCall, WRITE);   // CACHE tier now -> a SYNC object, proving no second prompt
  A.ok(again.allow === true && again.reason === 'previously granted', 'a granted class no longer prompts');

  // 10. full access: a blanket grant covers EVERY danger class, but the hardline floor still wins
  const blanket = new Set();
  const bFull = makeConsentBroker({ surface: 'interactive', prompt: () => Promise.resolve('full'), grantsBlanket: blanket, hardline: hardline });
  A.ok((await bFull(writeCall, WRITE)).allow, 'full access -> allow');
  A.ok(blanket.has('*'), 'full access recorded the blanket wildcard');
  const otherClass = bFull({ name: 'shell.exec', args: {} }, { name: 'shell.exec', capability: 'shell', scope: 'write' });
  A.ok(otherClass.allow === true && otherClass.reason === 'previously granted', 'blanket covers a DIFFERENT danger class without asking');
  const floor = bFull({ name: 'fs.write', args: { path: '.env' } }, WRITE);
  A.ok(!floor.allow && floor.hardline === true, 'hardline still denies under full access');

  // 11. interactive needs a wired prompt (else fail closed); autonomous IGNORES a prompt (surface gates the ask)
  const nc = makeConsentBroker({ surface: 'interactive' })(writeCall, WRITE);   // interactive, no prompt
  A.ok(!nc.allow && /no consent channel/.test(nc.reason), 'interactive with no prompt fails closed');
  let asked = false;
  const ar = makeConsentBroker({ surface: 'autonomous', prompt: () => { asked = true; return Promise.resolve('once'); } })(writeCall, WRITE);
  A.ok(!ar.allow && ar.reason === SILENCE && asked === false, 'autonomous default-denies and never consults the prompt');

  A.report('permissions.test');
})();
