/* node test/ctxgauge.test.js — the CONTEXT-WINDOW gauge model. Pure transform from two REAL numbers
   (latest prompt_tokens, model context_length) to a render-agnostic gauge state. The honesty rule under
   test: an unknown limit NEVER produces a fabricated percentage — it reports known:false so the renderer
   shows "calibrating" instead of a made-up fill. */
'use strict';
const A = require('./_assert.js');
const { compute, fmtTokens, WARN, CRIT } = require('../frontend/app/ctxgauge.js');

// ---- fmtTokens: compact, deterministic human counts ----
A.eq(fmtTokens(0), '0', '0 tokens');
A.eq(fmtTokens(850), '850', 'under 1k stays raw');
A.eq(fmtTokens(999), '999', '999 stays raw');
A.eq(fmtTokens(1000), '1k', '1000 -> 1k');
A.eq(fmtTokens(1500), '1.5k', '1500 -> 1.5k');
A.eq(fmtTokens(64000), '64k', '64000 -> 64k');
A.eq(fmtTokens(128000), '128k', '128000 -> 128k');
A.eq(fmtTokens(200000), '200k', '200000 -> 200k');
A.eq(fmtTokens(1500000), '1.5M', '1.5M');
A.eq(fmtTokens(2000000), '2M', '2M');

// ---- known limit: real fill, thresholds, labels ----
const half = compute(64000, 128000);
A.ok(half.known === true, 'known when limit > 0');
A.ok(half.frac === 0.5 && half.pct === 50, 'half full -> 0.5 / 50%');
A.eq(half.level, 'ok', 'half full is ok');
A.eq(half.label, '64k / 128k', 'label = used / limit');
A.eq(half.pctLabel, '50%', 'pctLabel');

A.eq(compute(0, 128000).level, 'idle', 'empty (known) -> idle');
A.eq(compute(0, 128000).pct, 0, 'empty -> 0%');

// WARN boundary (0.75) is inclusive; just below is still ok
A.eq(compute(Math.round(WARN * 128000), 128000).level, 'warn', 'at WARN -> warn');
A.eq(compute(Math.round(WARN * 128000) - 200, 128000).level, 'ok', 'just below WARN -> ok');

// CRIT boundary (0.90) is inclusive
A.eq(compute(Math.round(CRIT * 128000), 128000).level, 'crit', 'at CRIT -> crit');
A.eq(compute(Math.round(CRIT * 128000) - 200, 128000).level, 'warn', 'just below CRIT -> warn');

// overflow is clamped, never > 100% / > 1.0, and reads crit
const over = compute(200000, 128000);
A.ok(over.frac === 1 && over.pct === 100, 'overflow clamps to full');
A.eq(over.level, 'crit', 'overflow -> crit');

// ---- unknown limit: NO fabricated percentage (the honesty guarantee) ----
const cold = compute(64000, 0);
A.ok(cold.known === false, 'limit 0 -> not known');
A.ok(cold.frac === 0 && cold.pct === 0, 'unknown -> no fill asserted');
A.eq(cold.level, 'unknown', 'unknown level');
A.eq(cold.pctLabel, '—', 'unknown -> dash, never a number');
A.eq(cold.label, '64k', 'unknown still shows the real used count');
A.eq(compute(0, 0).label, '—', 'nothing known at all -> dash');

// ---- defensive coercion: garbage in -> safe, never a crash or NaN ----
A.eq(compute(-5, 128000).level, 'idle', 'negative used coerces to 0');
A.eq(compute(NaN, NaN).level, 'unknown', 'NaN -> unknown, not a throw');
A.ok(compute(64000.7, 128000).used === 64000, 'fractional used floored');

A.report('ctxgauge.test');
