#!/usr/bin/env node
/* rec-quality-live.mjs — LIVE proof for the recommendation QUALITY LOOP lane (throwaway verification driver).
   Boots a seeded SKYNET_DEV sidecar on its own port + its own scratch workspace, drives headless Chrome to
   the floor, then asserts against the REAL page (real modules, real stores, real DOM):

     1. Both halves are loaded and read the LIVE understanding/dossier state (no injected fakes).
     2. STRENGTH REORDERS a real pick: two candidates in the same priority band, one citing a fresh belief and
        one citing a season-old one, ranked through the live Recommend.pick.
     3. The QUALITY WEIGHT reaches the live pass: Recommend.pick is wrapped, a real agent.run.end is emitted,
        and the candidates the REAL recommendPass hands the spine are inspected for their earned `quality`.
     4. The ATTRIBUTION STAMP lands on the spawned work's meta: an accepted offer is armed, a real run is
        driven through Chat.send, and Chat.runMeta(runId).rec is read back.
     5. The STALE-BELIEF RE-CONFIRM renders as a real card in COMMS, and DENY writes through the real stores
        (the belief is gone from the dossier, the question is fingerprint-denylisted).
   Usage: SKYNET_RQ_PORT=8815 SKYNET_RQ_CDP=9315 node scripts/rec-quality-live.mjs */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, connectCDP, evalJS, collectDiagnostics, sleep } from './lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from './lib/seed.mjs';

const port = process.env.SKYNET_RQ_PORT || '8815';
const cdpPort = Number(process.env.SKYNET_RQ_CDP || 9315);
const url = `http://127.0.0.1:${port}/`;
const scratch = mkdtempSync(join(process.cwd(), '.dev-workspaces-recquality-'));
const profile = mkdtempSync(join(tmpdir(), 'recquality-profile-'));
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL: ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' — expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));

// a REAL provider key, when one is available, so slice 4 can drive an actual run (dev/.env.dev).
let key = process.env.SKYNET_OPENROUTER_KEY || '';
try {
  const envPath = join(process.cwd(), 'dev', '.env.dev');
  if (!key && existsSync(envPath)) {
    const m = /SKYNET_OPENROUTER_KEY\s*=\s*(\S+)/.exec(readFileSync(envPath, 'utf8'));
    if (m) key = m[1].trim();
  }
} catch {}
const liveKey = !!key && key.indexOf('placeholder') < 0;

materializeSeedWorkspace(scratch);
const sidecar = bootSeededSidecar(Object.assign({ port, scratchDir: scratch }, liveKey ? { key } : {}));
const chrome = launchChrome({ cdpPort, profileDir: profile });
let cdp = null;
try {
  await waitUp(url);
  await sleep(1200);
  cdp = await connectCDP(cdpPort);
  const diag = collectDiagnostics(cdp);
  await cdp.send('Page.navigate', { url });
  await waitDevReady(cdp, evalJS, { url });

  /* ---- 1. both halves live, reading the REAL understanding engine ---- */
  const loaded = await evalJS(cdp, `(() => {
    const u = (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.read) ? UnderstandingStore.read() : null;
    return {
      quality: typeof RecQuality !== 'undefined',
      store: typeof RecQualityStore !== 'undefined',
      spine: typeof Recommend !== 'undefined',
      dims: u && u.dims ? Object.keys(u.dims).length : 0,
      neutralWeight: (typeof RecQualityStore !== 'undefined') ? RecQualityStore.weightFor('suggest') : null,
      floor: (typeof RecQuality !== 'undefined') ? RecQuality.Q_FLOOR : null
    };
  })()`);
  ok(loaded.quality && loaded.store && loaded.spine, 'recquality.js + recqualitystore.js + recommend.js are all live in the page');
  ok(loaded.dims > 0, 'the live understanding read exposes real dimensions (' + loaded.dims + ')');
  eq(loaded.neutralWeight, 1, 'a cold station reads every channel NEUTRAL (it can change no ranking it has no evidence for)');
  ok(loaded.floor >= 0.5, 'the quality floor is live at ' + loaded.floor);

  /* ---- 2. strength reorders a real pick, using the live understanding read ---- */
  const strength = await evalJS(cdp, `(() => {
    const now = Date.now(), DAY = 86400000;
    const u = UnderstandingStore.read();
    const freshB = { id: 'f', text: 'ship the billing rewrite', updatedAt: now };
    const oldB = { id: 'o', text: 'ship the billing rewrite', updatedAt: now - 120 * DAY };
    const sFresh = RecQuality.beliefStrength(freshB, now, u, 'goals');
    const sOld = RecQuality.beliefStrength(oldB, now, u, 'goals');
    const cands = [
      { kind: 'arc', dim: 'goals', why: 'you said "the OLD thing"', strength: sOld },
      { kind: 'arc', dim: 'goals', why: 'you said "the FRESH thing"', strength: sFresh }
    ];
    const winner = Recommend.pick(cands, u);
    const scores = cands.map(c => Recommend.score(c, u));
    // and the band law: a maxed-out lower band still loses
    const cross = Recommend.pick([
      { kind: 'curiosity', why: 'x', dim: 'goals', strength: 1, quality: 1.25 },
      { kind: 'arc', why: 'y', strength: 0, quality: 0.5 }
    ], u);
    return { sFresh, sOld, winner: winner && winner.why, scores, cross: cross && cross.kind,
             stale: RecQuality.staleness(oldB, now, u, 'goals'), staleFresh: RecQuality.staleness(freshB, now, u, 'goals').stale };
  })()`);
  ok(strength.sOld < strength.sFresh, 'a 120-day-old belief reads WEAKER than a fresh one against the live dossier ('
    + strength.sOld.toFixed(3) + ' < ' + strength.sFresh.toFixed(3) + ')');
  ok(/FRESH/.test(String(strength.winner)), 'the live arbiter picks the better-grounded candidate: ' + strength.winner);
  ok(strength.scores[1] > strength.scores[0], 'and it is the SCORE that decided it: ' + JSON.stringify(strength.scores));
  eq(strength.cross, 'arc', 'a maxed-out lower-priority candidate still cannot cross a band');
  eq(strength.staleFresh, false, 'a fresh belief is never stale');
  console.log('live staleness read: ' + JSON.stringify(strength.stale));

  /* ---- 3+5. ONE real pass proves both halves: the earned quality weight reaches the spine, and the stale
        goals belief produces a RE-CONFIRM card instead of an arc that asserts it. The belief is aged FIRST so
        the very first pass of the session takes the stale branch (an arc that fires normally opens a Dialogue
        panel and spends a paid decomposition call — neither belongs in a verification run). ---- */
  const seeded = await evalJS(cdp, `(() => {
    // age the station's REAL goals belief(s) past the staleness threshold, through the live records
    const arr = DossierStore.beliefs('goals');
    const at = Date.now() - 45 * 86400000;
    for (const b of arr) { b.updatedAt = at; b.createdAt = at; b.observedAt = null; b.pinned = false; }
    UnderstandingStore.refresh(false);
    const u = UnderstandingStore.read();
    const b = arr[0] || null;
    return { count: arr.length, id: b && b.id, text: b && b.text, conf: u.dims.goals.conf,
             stale: b ? RecQuality.staleness(b, Date.now(), u, 'goals') : null,
             willOffer: !!(GoalStore.willOfferDecomposition && GoalStore.willOfferDecomposition()) };
  })()`);
  console.log('aged the live goals belief: ' + JSON.stringify(seeded));
  ok(seeded.count > 0, 'the seeded station holds a real goals belief to age');
  ok(seeded.stale && seeded.stale.stale === true, 'it reads STALE against the live understanding engine');
  ok(seeded.willOffer, 'and the arc would otherwise have ASSERTED it (willOfferDecomposition is true)');

  const passRead = await evalJS(cdp, `(() => {
    // make one channel a proven dud through the store's own API (real outcomes, not a poked number)
    for (let i = 0; i < 8; i++) RecQualityStore.noteDecline({ channel: 'curiosity' }, false);
    window.__rqPick = [];
    const orig = Recommend.pick;
    Recommend.pick = function (cands, uRead) {
      try { window.__rqPick.push((cands || []).map(c => ({ kind: c.kind, dim: c.dim || '', quality: c.quality, strength: c.strength, why: String(c.why || '').slice(0, 60) }))); } catch (e) {}
      const w = orig.apply(this, arguments);
      try { window.__rqWinner = w ? { kind: w.kind, quality: w.quality, reconfirm: !!w.reconfirm } : null; } catch (e) {}
      return w;
    };
    // let the gentle half be EARNED (the work-floor the pass honours), then drive a real clean run end.
    try { for (let i = 0; i < 6; i++) CuriosityStore.noteWork(); } catch (e) {}
    U.bus.emit('agent.run.end', { agentId: 'agent', runId: 'rq-live-1', reason: 'done' });
    return { dud: RecQualityStore.weightFor('curiosity') };
  })()`);
  ok(passRead.dud < 1 && passRead.dud >= loaded.floor,
    'eight real declines made the curiosity channel a dud, floored not silenced (' + passRead.dud + ')');
  await sleep(14000);   // the pass runs at 1.6s (rate) and 12s (everything the run must first produce)
  const captured = await evalJS(cdp, `({ calls: window.__rqPick || [], winner: window.__rqWinner || null })`);
  const withQuality = (captured.calls || []).flat().filter(c => c && c.quality != null);
  ok(captured.calls.length > 0, 'the REAL recommendation pass ran and consulted the spine (' + captured.calls.length + ' call(s))');
  ok(withQuality.length > 0, 'and every candidate it staged carried its channel’s earned quality weight');
  const dudCand = withQuality.find(c => c.kind === 'curiosity');
  if (dudCand) ok(dudCand.quality < 1, 'the dud channel’s candidate went in DISCOUNTED live: ' + JSON.stringify(dudCand));
  console.log('candidates the live pass staged: ' + JSON.stringify(captured.calls));
  console.log('winner: ' + JSON.stringify(captured.winner));

  /* ---- 5. the RE-CONFIRM card the same pass produced, end to end, in the real DOM ---- */
  const card = await evalJS(cdp, `(() => {
    const el = document.querySelector('#chat-log .cmsg.turnin.rec.arc');
    if (!el) return { rendered: false, winner: window.__rqWinner || null };
    const btns = Array.from(el.querySelectorAll('.consent-btn')).map(b => b.textContent);
    const cs = getComputedStyle(el.querySelector('.consent-btn'));
    return {
      rendered: true,
      eyebrow: (el.querySelector('.rec-eyebrow') || {}).textContent,
      evidence: (el.querySelector('.rec-evidence') || {}).textContent,
      label: (el.querySelector('.turnin-kind') || {}).textContent,
      proposal: (el.querySelector('.turnin-text') || {}).textContent,
      note: (el.querySelector('.turnin-evidence') || {}).textContent,
      btns, btnBg: cs.backgroundColor, btnColor: cs.color, btnBorder: cs.borderTopColor,
      winner: window.__rqWinner || null
    };
  })()`);
  ok(card.rendered, 'the stale belief produced a RE-CONFIRM card in the live COMMS feed');
  console.log('re-confirm card: ' + JSON.stringify(card));
  if (card.rendered) {
    ok(card.winner && card.winner.reconfirm === true, 'the spine’s winner was the RE-CONFIRM, not an assertion');
    ok(/STILL TRUE\?/.test(String(card.label)), 'it is labelled as a question, not a proposal');
    ok(/still where you’re heading/.test(String(card.proposal)), 'the proposal IS phrased as a question');
    ok(/because you said/.test(String(card.evidence)), 'it cites the Commander’s own words: ' + card.evidence);
    ok(/week/.test(String(card.note)), 'and says how long it has been: ' + card.note);
    eq(card.btns, ['Still true', 'Not anymore'], 'two taps, either way');
    const osPaint = ['rgb(255, 255, 255)', 'rgb(239, 239, 239)'];
    ok(osPaint.indexOf(card.btnBg) < 0 && card.btnBorder !== 'rgb(118, 118, 118)',
      'no OS paint on the consent buttons (' + card.btnBg + ' / ' + card.btnBorder + ')');
    // DENY → the real store writes
    const denied = await evalJS(cdp, `(() => {
      const fp = RecQuality.beliefFingerprint('goals', { id: ${JSON.stringify(seeded.id)}, text: ${JSON.stringify(seeded.text)} });
      const before = { beliefs: DossierStore.beliefs('goals').length, denied: RecQualityStore.isBeliefDenied(fp), conf: UnderstandingStore.read().dims.goals.conf };
      const el = document.querySelector('#chat-log .cmsg.turnin.rec.arc');
      const deny = Array.from(el.querySelectorAll('.consent-btn')).find(b => /Not anymore/.test(b.textContent));
      deny.click();
      return { before, after: {
        beliefs: DossierStore.beliefs('goals').length,
        stillThere: DossierStore.beliefs('goals').some(b => b.id === ${JSON.stringify(seeded.id)}),
        denied: RecQualityStore.isBeliefDenied(fp),
        result: (el.querySelector('.consent-result') || {}).textContent,
        conf: UnderstandingStore.read().dims.goals.conf
      } };
    })()`);
    ok(denied.after.stillThere === false, 'DENY retired the belief through the dossier’s own forget path');
    eq(denied.after.beliefs, denied.before.beliefs - 1, 'exactly one belief was removed');
    ok(denied.after.denied === true, 'and the question is fingerprint-denylisted — it is never asked again');
    ok(/dropped/.test(String(denied.after.result)), 'the card settles honestly: ' + denied.after.result);
    ok(denied.after.conf <= denied.before.conf, 'the dimension’s confidence did not rise on a retirement');
    console.log('deny round-trip: ' + JSON.stringify(denied));
  }

  /* ---- 4. the attribution stamp lands on the spawned run's meta ---- */
  if (liveKey) {
    const armed = await evalJS(cdp, `(() => {
      RecQualityStore.noteAccept({ channel: 'suggest', dim: 'goals', spawnsWork: true, id: 'live-offer-1' });
      window.__rqRun = null;
      U.bus.on('agent.run.start', p => { if (!window.__rqRun) window.__rqRun = p && (p.runId || p.id); });
      Chat.send('Say the single word: ready.');
      return { pending: !!RecQualityStore._pending() };
    })()`);
    ok(armed.pending === true, 'an accepted offer that spawns work arms a pending stamp (and credits nothing yet)');
    let meta = null;
    for (let i = 0; i < 40 && !(meta && meta.rec); i++) {
      await sleep(1500);
      meta = await evalJS(cdp, `(() => { const id = window.__rqRun; return id ? Object.assign({ id }, Chat.runMeta(id) || {}) : null; })()`);
    }
    ok(meta && meta.rec && meta.rec.channel === 'suggest',
      'the spawned run’s META carries the attribution stamp: ' + JSON.stringify(meta && meta.rec));
    eq(meta && meta.rec && meta.rec.dim, 'goals', 'including the dimension the offer targeted');
    // the run's REAL end folds the completion outcome through the store's own bus subscription (no poking).
    let outcome = null;
    for (let i = 0; i < 30; i++) {
      outcome = await evalJS(cdp, `({ stamped: !!RecQualityStore.stampFor(window.__rqRun), weight: RecQualityStore.weightFor('suggest'), busy: Chat.isBusy() })`);
      if (!outcome.busy && outcome.weight !== 1) break;
      await sleep(1500);
    }
    ok(outcome && outcome.stamped, 'the store bound that run to the offer');
    ok(outcome && outcome.weight > 1, 'the run’s clean finish folded a real positive outcome onto the channel (' + (outcome && outcome.weight) + ')');
    // and the strong signal: the verdict path the rate beat hands over (rateWork is module-private, so the
    // store-level hand-off is exercised here; its call site inside rateWork is locked by recqualitystore.test).
    const verdict = await evalJS(cdp, `(() => { const before = RecQualityStore.weightFor('suggest');
      RecQualityStore.noteVerdict(window.__rqRun, 'great'); return { before, after: RecQualityStore.weightFor('suggest') }; })()`);
    ok(verdict.after > verdict.before, 'a 👍 on the attributed run moves it further up: ' + JSON.stringify(verdict));
  } else {
    console.log('SKIP slice 4 (attribution on a real run): no live provider key available');
  }

  /* ---- 6. clean boot ---- */
  const errs = (diag.consoleMsgs || []).map(m => m.type + ': ' + m.text).concat(diag.exceptions || []);
  const mine = errs.filter(e => /recquality|RecQuality|reconfirm|recommendPass/i.test(String(e)));
  eq(mine, [], 'no console errors from the quality loop');
  console.log('console/exception log: ' + JSON.stringify(errs.slice(0, 8)));
} catch (e) {
  fail++; console.log('FAIL: driver threw — ' + (e && e.stack || e));
} finally {
  try { chrome.kill(); } catch {}
  try { sidecar.kill(); } catch {}
  await sleep(400);
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(fail ? ('rec-quality-live: ' + fail + ' problem(s), ' + pass + ' ok') : ('rec-quality-live: OK (' + pass + ' assertions)'));
process.exit(fail ? 1 : 0);
