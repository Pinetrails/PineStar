/* SKYNET — testapi.js : DEV-ONLY behavioral + truthfulness test surface (window.__SKYNET_TEST__).

   GATED ON window.__SKYNET_DEV__ — this entire module is INERT in a normal/shipped build (the dev
   hook is only ever injected by a SKYNET_DEV sidecar; a packaged Tauri build never sets it). So it
   can live in the always-served frontend without leaking a debug API to users.

   WHY: the game floor + HUD ARE the product, but they were only ever checkable by eyeballing a
   screenshot. This exposes the live substrate so scripts/audit (P2) can AUTO-ASSERT, over CDP:
     • Tier A/B/C floor behavior — bodies()/hero()/crew() give each body's tile, zone, glance, goal,
       moving flag + target tile, so "idle stays in its zone", "awareness is gaze-only (no body walks
       toward another)", and "a summoned agent walks to ITS OWN workstation" become PASS/FAIL.
     • Truthful telemetry (the no-app-lies mandate) — a FROZEN U.bus event log + INDEPENDENT reducers
       (the same pure folds the app uses: FloorStats / Xp / CtxGauge) so every on-screen number can be
       checked to equal a reduction over the real agent.* events, not a free-floating counter.

   It only READS (plus one harmless monkeypatch of U.bus.emit to record the log). No game state is
   mutated, so turning it on cannot change what a normal session would do. */
'use strict';
(() => {
  if (typeof window === 'undefined' || !window.__SKYNET_DEV__) return;   // DEV gate — inert otherwise

  const VERSION = '1';
  const LOG_CAP = 5000;
  // The events worth freezing for reduction/assertions — the agent.* economy + work/queue/provider +
  // memory + channels + deliverables. (Keeps render-frequency noise, if any ever rides the bus, out.)
  const TRACK = /^(agent\.|workitem\.|queue\.|provider\.|memory\.|channel\.|deliverable|permission\.)/;
  const _log = [];
  let baseline = null;   // displayed HUD captured at first in-game ready — the zero point for delta checks

  const nowMs = () => { try { return Date.now(); } catch (_) { return 0; } };
  function record(name, payload) {
    _log.push({ name, payload, t: nowMs() });
    if (_log.length > LOG_CAP) _log.splice(0, _log.length - LOG_CAP);
  }

  // FROZEN LOG: U.bus keeps no history of its own, so wrap emit ONCE to mirror every event into _log.
  // The wrapper is transparent (records, then calls the original) — behavior is unchanged.
  function hookBus() {
    if (typeof U === 'undefined' || !U.bus || typeof U.bus.emit !== 'function') return false;
    if (U.bus.__skytap) return true;
    const orig = U.bus.emit.bind(U.bus);
    U.bus.emit = function (ev, data) { try { if (TRACK.test(String(ev))) record(ev, data); } catch (_) {} return orig(ev, data); };
    U.bus.__skytap = true;
    return true;
  }

  // ---- behavioral substrate (bodies / zones / glances) ----
  const W = () => (typeof World !== 'undefined' ? World : null);
  function bodies() { try { const w = W(); return (w && w.bodies) ? w.bodies() : []; } catch (_) { return []; } }
  function hero() { return bodies().find((b) => b.hero) || null; }
  function crew() { return bodies().filter((b) => !b.hero); }
  function dbg() { try { const w = W(); return (w && w.dbg) ? w.dbg() : null; } catch (_) { return null; } }

  // ---- frozen event log ----
  const events = (prefix) => (prefix ? _log.filter((e) => e.name.indexOf(prefix) === 0) : _log).map((e) => ({ name: e.name, payload: e.payload, t: e.t }));
  const eventCount = () => _log.length;
  const clearEvents = () => { _log.length = 0; baseline = null; return 0; };

  // ---- independent reducers (the source-of-truth side of "does the number lie?") ----
  function reduceFloor() {
    try { if (typeof FloorStats === 'undefined') return null; const f = FloorStats.create(); for (const e of _log) f.onEvent(e.name, e.payload, e.t); return f.snapshot(nowMs()); } catch (_) { return null; }
  }
  function reduceXp() {
    try { if (typeof Xp === 'undefined') return null; let s = Xp.fresh(); for (const e of _log) s = Xp.applyEvent(s, { name: e.name, payload: e.payload }).stats; return Xp.compute(s); } catch (_) { return null; }
  }
  // a raw, dependency-free sum of the cost firehose — mirrors Harness.totals() shape so the SPEND/TOKENS
  // HUD chips can be checked even if FloorStats is unavailable.
  function reduceTotals() {
    let cost = 0, tokensIn = 0, tokensOut = 0, calls = 0;
    for (const e of _log) {
      if (e.name === 'agent.cost') { const p = e.payload || {}; cost += (+p.usd || 0); tokensIn += (+p.tokensIn || 0); tokensOut += (+p.tokensOut || 0); }
      else if (e.name === 'agent.run.start') calls++;
    }
    return { cost, tokens: tokensIn + tokensOut, tokensIn, tokensOut, calls };
  }
  function ctx() { try { if (typeof CtxGauge === 'undefined' || typeof Harness === 'undefined') return null; const cs = Harness.contextState(); return CtxGauge.compute(cs.used, cs.limit); } catch (_) { return null; } }

  // ---- HUD truthfulness: displayed (DOM) vs reduced-over-events ----
  // Parse a HUD chip's text into a number, honoring k/M/B suffixes ("234.9k" -> 234900, "Lv 3" -> 3).
  function parseNum(s) {
    if (s == null) return null;
    const m = String(s).match(/(-?\d+(?:\.\d+)?)\s*([kmb])?/i);
    if (!m) return null;
    let v = parseFloat(m[1]); if (!isFinite(v)) return null;
    const suf = (m[2] || '').toLowerCase();
    if (suf === 'k') v *= 1e3; else if (suf === 'm') v *= 1e6; else if (suf === 'b') v *= 1e9;
    return v;
  }
  function displayedHud() {
    const txt = (id) => { const el = document.getElementById(id); return el ? (el.textContent || '').trim() : null; };
    const c = txt('gt-cost'), t = txt('gt-tok'), s = txt('gt-station');
    return {
      cost: { text: c, value: parseNum(c) },        // SPEND, e.g. "$0.000000"
      tokens: { text: t, value: parseNum(t) },      // TOKENS, e.g. "0" / "234.9k"
      station: { text: s, value: parseNum(s) },     // STATION, e.g. "Lv 3"
    };
  }
  const captureBaseline = () => { if (!baseline) baseline = displayedHud(); return baseline; };

  // Returns the displayed values, the baseline captured at log-start, the reduced (event-derived) values,
  // and PASS/FAIL checks. For a fresh dev-seed session the baseline spend/tokens are 0, so displayed must
  // EQUAL the reduced session totals exactly (no-app-lies). Station level is cumulative-with-history, so it
  // is checked as a monotonic lower bound (session XP can only have raised it; it must be >= baseline).
  function hud() {
    const displayed = displayedHud();
    const base = baseline || displayed;
    const totals = reduceTotals();
    const floor = reduceFloor();
    const xp = reduceXp();
    const checks = [];
    const chk = (metric, displayedV, expectedV, tol, mode) => {
      const ok = displayedV != null && expectedV != null && (mode === 'gte' ? displayedV >= expectedV - (tol || 0) : Math.abs(displayedV - expectedV) <= (tol || 0));
      checks.push({ metric, displayed: displayedV, expected: expectedV, mode: mode || 'eq', ok });
    };
    const baseCost = (base.cost && base.cost.value) || 0;
    const baseTok = (base.tokens && base.tokens.value) || 0;
    const baseSta = (base.station && base.station.value) || 1;
    chk('spendUsd', displayed.cost.value, baseCost + (floor ? floor.spendUsd : totals.cost), 5e-4, 'eq');
    chk('tokens', displayed.tokens.value, baseTok + totals.tokens, 100, 'eq');      // tolerance absorbs k-suffix rounding
    chk('stationLevel', displayed.station.value, Math.max(baseSta, xp ? xp.level : 1), 0, 'gte');
    return { displayed, baseline: base, reduced: { totals, floor, xp, ctx: ctx() }, checks, allOk: checks.every((c) => c.ok) };
  }

  // ---- readiness + one-call probe ----
  function ready() {
    try {
      if (!window.__SKYNET_DEV__) return false;
      const g = document.getElementById('screen-game');
      const inGame = !!(g && g.classList.contains('active'));
      return inGame && bodies().length > 0;
    } catch (_) { return false; }
  }
  const summary = () => ({ ready: ready(), version: VERSION, bodyCount: bodies().length, eventCount: _log.length, hud: hud() });

  const api = {
    dev: true, version: VERSION, ready,
    bodies, hero, crew, dbg,
    events, eventCount, clearEvents,
    reduceTotals, reduceFloor, reduceXp, ctx,
    captureBaseline, hud, summary,
  };

  // Tap the bus immediately (U is loaded long before this module); retry briefly as a backstop.
  (function arm(tries) { if (hookBus()) return; if (tries > 0) setTimeout(() => arm(tries - 1), 200); })(50);
  // Capture the HUD zero-point once the floor is up, so delta-truthfulness has a baseline.
  (function armBaseline(tries) { if (ready()) { captureBaseline(); return; } if (tries < 150) setTimeout(() => armBaseline(tries + 1), 200); })(0);

  window.__SKYNET_TEST__ = api;
  try { console.log('[testapi] window.__SKYNET_TEST__ armed (DEV) v' + VERSION); } catch (_) {}
})();
