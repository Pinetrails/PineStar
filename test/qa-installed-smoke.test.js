/* node test/qa-installed-smoke.test.js — the installed-exe smoke's pure core (EL-4/EL-8),
   fed injected fakes for attach / io / clock (zero disk, zero CDP). Asserts:
   the classifier's no-fake-green order (unreachable→BLOCKED, unversioned→BLOCKED, failed
   assertion→RED, all-pass→GREEN), the stamp writer/validator shape the ready-gate reads,
   the BLOCKED-on-unreachable path (stamp written + a P0 ledger finding filed, never a silent
   green), and that a GREEN run files NO finding. Pure + deterministic — the ISO stamp always
   comes from the injected clock, never Date.now(). */
'use strict';
const A = require('./_assert.js');
const {
  RESULTS, SMOKE_CREW, SMOKE_PROBE, classifyResult, normalizeStamp, validateStamp, buildFinding, makeSmoke
} = require('../scripts/qa/installed-smoke.mjs');

const ISO = '2026-07-07T12:00:00.000Z';
const clock = { nowIso: () => ISO };

// a fake io that records everything into inspectable arrays (no disk).
function memIo() {
  const evidence = [], stamps = [], findings = [], logs = [];
  return {
    evidence, stamps, findings, logs,
    log: (...a) => logs.push(a.join(' ')),
    writeEvidence(name, text) { const p = 'qa/installed/run/' + name; evidence.push({ name, text, path: p }); return p; },
    writeStamp(obj) { stamps.push(obj); return 'qa/installed/last-smoke.json'; },
    fileFinding(f) { findings.push(f); return true; }
  };
}
// a session whose probe returns a canned result.
const sessionWith = (probeResult) => ({
  async probe() { return probeResult; },
  diagnostics() { return { consoleMsgs: [], exceptions: [] }; },
  async close() {}
});
const GREEN_PROBE = {
  appVersion: '0.3.0', appSource: 'env', harness: '0.3.0', mode: 'desktop', bootSane: true,
  checks: [
    { name: 'boot/api-token-present', ok: true, detail: 'ok' },
    { name: 'version/app-nonblank', ok: true, detail: 'app=0.3.0' },
    { name: 'boot/world-present', ok: true, detail: 'canvas' },
    { name: 'boot/stage-rendered', ok: true, detail: 'stage' },
    { name: 'store/workstreams-wellformed', ok: true, detail: '3 workstreams' },
    { name: 'board/no-forever-running', ok: true, detail: 'idle' }
  ],
  notes: 'checks=6 mode=desktop'
};

/* ---- A0. SMOKE_PROBE auth-header contract (regression for ledger finding 4d9992d9) ----
   The in-page probe MUST authenticate with X-StarNet-Token — the ONLY scheme the sidecar accepts (Authorization is
   rejected as "forbidden token") AND the only auth header in its CORS Access-Control-Allow-Headers. On the packaged
   desktop build the page origin (http://tauri.localhost) differs from the sidecar (http://127.0.0.1:<port>), so every
   /api/* call is cross-origin: a stray Authorization header makes the OPTIONS preflight request a header the sidecar
   won't allow, the preflight is rejected, and fetch() dies with "Failed to fetch" BEFORE any response — so appVersion
   reads blank and the smoke goes BLOCKED even though /api/version is serving the honest version. Same-origin
   dev/headless never preflights, which is why this only ever surfaced on the installed exe. The probe is a string
   eval'd in a real browser, so this guards its source directly (it can't be exercised headlessly). */
{
  A.ok(/X-StarNet-Token/.test(SMOKE_PROBE), 'SMOKE_PROBE authenticates with the X-StarNet-Token header (sidecar auth + CORS allow-list)');
  A.ok(!/Authorization/i.test(SMOKE_PROBE), 'SMOKE_PROBE sends NO Authorization header (it trips the packaged build cross-origin preflight)');
  A.ok(!/Bearer/.test(SMOKE_PROBE), 'SMOKE_PROBE uses NO Bearer scheme (the sidecar rejects Bearer as forbidden token)');
}

/* ---- A. classifyResult encodes the no-fake-green order ---- */
{
  A.eq(classifyResult({ attached: false }), RESULTS.BLOCKED, 'unreachable -> BLOCKED');
  A.eq(classifyResult({ attached: true, appVersion: '', checks: [] }), RESULTS.BLOCKED, 'attached but unversioned -> BLOCKED');
  A.eq(classifyResult({ attached: true, appVersion: '0.3.0', checks: [{ name: 'x', ok: true }] }), RESULTS.GREEN, 'versioned + all pass -> GREEN');
  A.eq(classifyResult({ attached: true, appVersion: '0.3.0', checks: [{ name: 'x', ok: true }, { name: 'y', ok: false }] }), RESULTS.RED, 'versioned + a failed check -> RED');
}

/* ---- B. normalizeStamp coerces to the exact contract shape; unknown result clamps to BLOCKED ---- */
{
  const s = normalizeStamp({ appVersion: ' 0.3.0 ', trunkHead: ' abc123 ', result: 'GREEN', evidence: ['a', '  ', 'b'], notes: ' hi ' }, { clock });
  A.eq(s.stampIso, ISO, 'stampIso stamped from the injected clock');
  A.eq(s.appVersion, '0.3.0', 'appVersion trimmed');
  A.eq(s.trunkHead, 'abc123', 'trunkHead trimmed');
  A.eq(s.result, 'GREEN', 'valid result kept');
  A.eq(s.evidence, ['a', 'b'], 'evidence trimmed + blanks dropped');
  A.eq(s.notes, 'hi', 'notes trimmed');
  // exact key set the ready-gate reads — no extra/missing keys.
  A.eq(Object.keys(s).sort(), ['appVersion', 'evidence', 'notes', 'result', 'stampIso', 'trunkHead'], 'stamp has exactly the contract keys');
  // an unknown/blank result is clamped to BLOCKED (never silently "" or GREEN).
  A.eq(normalizeStamp({ result: 'WAT' }, { clock }).result, RESULTS.BLOCKED, 'unknown result clamps to BLOCKED');
  A.eq(normalizeStamp({}, { clock }).result, RESULTS.BLOCKED, 'missing result clamps to BLOCKED');
  // a lone evidence string coerces to a one-element array.
  A.eq(normalizeStamp({ evidence: 'only.json' }, { clock }).evidence, ['only.json'], 'string evidence -> one-element array');
}

/* ---- C. validateStamp accepts a well-formed stamp and rejects each contract violation ---- */
{
  const good = normalizeStamp({ appVersion: '0.3.0', trunkHead: 'abc', result: 'GREEN', evidence: ['e.json'], notes: 'n' }, { clock });
  A.eq(validateStamp(good).ok, true, 'a well-formed GREEN stamp validates');
  A.eq(validateStamp({}).ok, false, 'empty object fails validation');
  A.eq(validateStamp(null).ok, false, 'null fails validation');
  A.ok(validateStamp({ stampIso: 'not-a-date', result: 'GREEN', appVersion: '0.3.0', trunkHead: 'a', evidence: ['e'], notes: '' }).errors.some(e => /ISO/.test(e)), 'a non-ISO stampIso is flagged');
  A.ok(validateStamp({ stampIso: ISO, result: 'MAYBE', appVersion: '0.3.0', trunkHead: 'a', evidence: ['e'], notes: '' }).errors.some(e => /GREEN\|RED\|BLOCKED/.test(e)), 'a bad result enum is flagged');
  A.ok(validateStamp({ stampIso: ISO, result: 'GREEN', appVersion: '', trunkHead: 'a', evidence: ['e'], notes: '' }).errors.some(e => /appVersion/.test(e)), 'GREEN without appVersion is a lie -> flagged');
  A.ok(validateStamp({ stampIso: ISO, result: 'GREEN', appVersion: '0.3.0', trunkHead: 'a', evidence: [], notes: '' }).errors.some(e => /evidence/.test(e)), 'GREEN without evidence is flagged');
  // a BLOCKED stamp with a blank appVersion is legitimately valid (that's exactly what BLOCKED means).
  A.eq(validateStamp({ stampIso: ISO, result: 'BLOCKED', appVersion: '', trunkHead: 'a', evidence: ['e'], notes: 'n' }).ok, true, 'BLOCKED with blank appVersion is valid');
}

/* ---- D. buildFinding: BLOCKED -> P0, RED -> P1, evidence never empty ---- */
{
  const b = buildFinding(RESULTS.BLOCKED, 'could not attach', [], [], 'qa/installed/last-smoke.json');
  A.eq(b.severity, 'P0', 'BLOCKED finding is P0');
  A.eq(b.crew, SMOKE_CREW, 'finding is filed under the smoke crew');
  A.ok(b.evidence.length >= 1, 'BLOCKED finding still carries an evidence path (stamp fallback)');
  A.ok(/BLOCKED/.test(b.title), 'BLOCKED title says so');
  const r = buildFinding(RESULTS.RED, 'appVersion=0.3.0 checks 5/6 pass', [{ name: 'board/no-forever-running', detail: 'stuck: w1' }], ['qa/installed/run/probe.json'], 'qa/installed/last-smoke.json');
  A.eq(r.severity, 'P1', 'RED finding is P1');
  A.ok(/board\/no-forever-running/.test(r.subject), 'RED subject names the failed assertion (stable fingerprint)');
  A.eq(r.evidence, ['qa/installed/run/probe.json'], 'RED finding uses the real probe evidence');
}

/* ---- E. makeSmoke: BLOCKED-on-unreachable — stamp written BLOCKED + a P0 finding, never silent green ---- */
(async () => {
  const io = memIo();
  const attach = async () => { throw new Error('ECONNREFUSED 127.0.0.1:9333'); };
  const smoke = makeSmoke({ attach, clock, gitHead: 'deadbeef', io });
  const res = await smoke.run();
  A.eq(res.result, RESULTS.BLOCKED, 'unreachable exe -> BLOCKED');
  A.eq(io.stamps.length, 1, 'a stamp was still written (no silent skip)');
  A.eq(io.stamps[0].result, RESULTS.BLOCKED, 'the written stamp reads BLOCKED');
  A.eq(io.stamps[0].trunkHead, 'deadbeef', 'stamp pins the trunk head it ran against');
  A.eq(io.stamps[0].appVersion, '', 'BLOCKED stamp has no proven appVersion');
  A.eq(validateStamp(io.stamps[0]).ok, true, 'the BLOCKED stamp is a valid contract object');
  A.eq(io.findings.length, 1, 'exactly one ledger finding filed on BLOCKED');
  A.eq(io.findings[0].severity, 'P0', 'the BLOCKED finding is a P0');
  A.ok(io.findings[0].evidence.length >= 1, 'the filed finding carries evidence (evidence-law safe)');
  A.ok(/ECONNREFUSED/.test(io.stamps[0].notes), 'the block reason is captured in the stamp notes');

  /* ---- F. makeSmoke: attach ok but appVersion blank -> BLOCKED (can not prove the build) ---- */
  const io2 = memIo();
  const unversioned = Object.assign({}, GREEN_PROBE, { appVersion: '', checks: GREEN_PROBE.checks.map(c => c.name === 'version/app-nonblank' ? { name: c.name, ok: false, detail: 'blank' } : c) });
  const smoke2 = makeSmoke({ attach: async () => sessionWith(unversioned), clock, gitHead: 'aaa', io: io2 });
  const res2 = await smoke2.run();
  A.eq(res2.result, RESULTS.BLOCKED, 'attached but unversioned -> BLOCKED (no-fake-green)');
  A.eq(io2.findings[0].severity, 'P0', 'unversioned is a P0');

  /* ---- G. makeSmoke: attached + versioned + a failed assertion -> RED + P1 finding ---- */
  const io3 = memIo();
  const redProbe = Object.assign({}, GREEN_PROBE, { checks: GREEN_PROBE.checks.map(c => c.name === 'board/no-forever-running' ? { name: c.name, ok: false, detail: 'RUNNING chip with nothing busy: w1' } : c) });
  const smoke3 = makeSmoke({ attach: async () => sessionWith(redProbe), clock, gitHead: 'bbb', io: io3 });
  const res3 = await smoke3.run();
  A.eq(res3.result, RESULTS.RED, 'a failed parity assertion -> RED');
  A.eq(io3.stamps[0].result, RESULTS.RED, 'stamp reads RED');
  A.eq(io3.stamps[0].appVersion, '0.3.0', 'RED stamp still pins the proven version');
  A.eq(io3.findings.length, 1, 'one finding filed on RED');
  A.eq(io3.findings[0].severity, 'P1', 'a RED parity divergence is P1');

  /* ---- H. makeSmoke: full green run -> GREEN stamp + NO finding filed ---- */
  const io4 = memIo();
  const smoke4 = makeSmoke({ attach: async () => sessionWith(GREEN_PROBE), clock, gitHead: 'ccc', io: io4 });
  const res4 = await smoke4.run();
  A.eq(res4.result, RESULTS.GREEN, 'all pass -> GREEN');
  A.eq(io4.stamps[0].result, RESULTS.GREEN, 'stamp reads GREEN');
  A.eq(validateStamp(io4.stamps[0]).ok, true, 'the GREEN stamp is a valid contract object');
  A.ok(io4.stamps[0].evidence.length >= 1, 'GREEN stamp carries the probe evidence');
  A.eq(io4.findings.length, 0, 'a GREEN run files NO ledger finding (nothing to report)');

  /* ---- I. makeSmoke: attach ok but the in-page probe throws -> BLOCKED (proved nothing) ---- */
  const io5 = memIo();
  const throwingSession = { async probe() { throw new Error('Runtime.evaluate detached'); }, diagnostics() { return {}; }, async close() {} };
  const smoke5 = makeSmoke({ attach: async () => throwingSession, clock, gitHead: 'ddd', io: io5 });
  const res5 = await smoke5.run();
  A.eq(res5.result, RESULTS.BLOCKED, 'a probe that throws -> BLOCKED, not green');
  A.eq(io5.findings[0].severity, 'P0', 'probe-threw is a P0');

  A.report('qa-installed-smoke.test');
})();
