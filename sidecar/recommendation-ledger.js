/* Durable, cross-surface recommendation evidence + verdict ledger.
   One lifecycle replaces browser-only "recent" arrays and per-lane feedback islands. Every entry records what was
   shown, why it was allowed, which evidence supported it, and what happened next. The pure replay() read is the
   offline evaluation contract: identical history -> identical metrics and preference weights. */
'use strict';

const { makeDurableJsonStore } = require('./durable-store.js');

const STORE_KEY = 'recommendations';
const CAP = 2000;
const STATES = new Set(['shown', 'accepted', 'deferred', 'declined', 'completed']);
const REASONS = new Set(['accepted', 'wrong_thing', 'wrong_time', 'bad_quality', 'already_done', 'not_relevant', 'completed', 'unspecified']);

function clip(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function fingerprint(title) {
  const toks = clip(title, 300).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
  return Array.from(new Set(toks)).sort().join(' ');
}
function normalizeEntry(raw) {
  const x = raw && typeof raw === 'object' ? raw : {};
  const state = STATES.has(x.state) ? x.state : 'shown';
  const reason = REASONS.has(x.reason) ? x.reason : (state === 'shown' ? '' : 'unspecified');
  const createdAt = Number(x.createdAt) || 0;
  const updatedAt = Number(x.updatedAt) || createdAt;
  const transitions = Array.isArray(x.transitions) ? x.transitions.map(t => {
    const st = t && STATES.has(t.state) ? t.state : null;
    if (!st) return null;
    return { state: st, reason: REASONS.has(t.reason) ? t.reason : (st === 'shown' ? '' : 'unspecified'), at: Number(t.at) || 0 };
  }).filter(Boolean).slice(-20) : [];
  // Backfill pre-history entries honestly from the timestamps/state already stored.
  if (!transitions.length && createdAt) transitions.push({ state: 'shown', reason: '', at: createdAt });
  if (state !== 'shown' && (!transitions.length || transitions[transitions.length - 1].state !== state)) transitions.push({ state, reason, at: updatedAt });
  return {
    id: clip(x.id, 120), surface: clip(x.surface, 40), kind: clip(x.kind, 60) || 'idea',
    title: clip(x.title, 240), target: clip(x.target, 240), fingerprint: fingerprint(x.fingerprint || x.title),
    evidence: Array.isArray(x.evidence) ? x.evidence.map(e => ({
      id: clip(e && e.id, 120), type: clip(e && e.type, 40), quote: clip(e && (e.quote || e.text), 280)
    })).filter(e => e.id || e.quote).slice(0, 12) : [],
    readiness: x.readiness && typeof x.readiness === 'object' ? {
      ready: !!x.readiness.ready,
      reasons: Array.isArray(x.readiness.reasons) ? x.readiness.reasons.map(r => clip(r, 40)).filter(Boolean).slice(0, 8) : []
    } : null,
    score: Number.isFinite(x.score) ? x.score : null,
    modelVersion: clip(x.modelVersion, 80), state, reason, transitions: transitions.slice(-20),
    createdAt, updatedAt,
    expiresAt: Number(x.expiresAt) || 0, completedAt: Number(x.completedAt) || 0
  };
}
function normalize(raw) {
  const x = raw && typeof raw === 'object' ? raw : {};
  return { v: 1, entries: Array.isArray(x.entries) ? x.entries.map(normalizeEntry).filter(e => e.id && e.title).slice(-CAP) : [] };
}

function replay(raw, opts) {
  opts = opts || {};
  const rows = normalize(raw).entries.filter(e => !opts.surface || e.surface === opts.surface);
  const counts = { shown: rows.length, accepted: 0, deferred: 0, declined: 0, completed: 0, evidenced: 0, ready: 0, repeats: 0 };
  const seen = new Set(); const kinds = {};
  for (const e of rows) {
    if (e.state === 'completed') { counts.completed++; counts.accepted++; }
    else if (e.state !== 'shown' && counts[e.state] != null) counts[e.state]++;
    if (e.evidence.length) counts.evidenced++;
    if (e.readiness && e.readiness.ready) counts.ready++;
    if (e.fingerprint) { if (seen.has(e.fingerprint)) counts.repeats++; else seen.add(e.fingerprint); }
    const k = kinds[e.kind] || (kinds[e.kind] = { shown: 0, positive: 0, negative: 0, deferred: 0, weight: 0 });
    k.shown++;
    if (e.state === 'accepted' || e.state === 'completed') k.positive++;
    else if (e.state === 'declined') k.negative++;
    else if (e.state === 'deferred') k.deferred++;
  }
  for (const k of Object.keys(kinds)) {
    const x = kinds[k];
    // Bayesian-smoothed, bounded preference shift. A few clicks guide; they never freeze the system.
    x.weight = Math.max(-0.75, Math.min(0.75, (x.positive - x.negative) / (x.shown + 2)));
  }
  const d = Math.max(1, counts.shown);
  return {
    counts,
    acceptanceRate: (counts.accepted / d), completionRate: (counts.completed / d),
    evidenceCoverage: (counts.evidenced / d), readinessCoverage: (counts.ready / d), repeatRate: (counts.repeats / d),
    kinds
  };
}

function makeRecommendationLedger(deps) {
  deps = deps || {};
  if (!deps.path || !deps.workspaces) throw new Error('makeRecommendationLedger: path + workspaces required');
  const durable = makeDurableJsonStore({
    fs: deps.fs, path: deps.path,
    fileFor: () => deps.path.join(deps.workspaces, 'recommendations.json'),
    writeDurable: deps.writeDurable, onRecover: deps.onRecover, onCorrupt: deps.onCorrupt
  });
  function read() { return normalize(durable.get(STORE_KEY)); }
  function list(opts) {
    opts = opts || {}; let rows = read().entries.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    if (opts.surface) rows = rows.filter(e => e.surface === String(opts.surface));
    if (opts.state) rows = rows.filter(e => e.state === String(opts.state));
    return rows.slice(0, Number.isFinite(opts.limit) ? Math.max(0, opts.limit) : 100);
  }
  function record(input, now) {
    const at = Number(now) || 0;
    const rec = normalizeEntry(Object.assign({}, input, { createdAt: at, updatedAt: at, state: 'shown', transitions: [{ state: 'shown', reason: '', at }] }));
    if (!rec.id || !rec.title) return Promise.resolve(null);
    let out = null;
    return durable.update(STORE_KEY, cur => {
      const s = normalize(cur); const prior = s.entries.find(e => e.id === rec.id);
      if (prior) { out = prior; return undefined; }
      s.entries.push(rec); while (s.entries.length > CAP) s.entries.shift(); out = rec; return s;
    }).then(() => out);
  }
  function verdict(id, state, reason, now) {
    const sid = clip(id, 120); const st = STATES.has(state) && state !== 'shown' ? state : null;
    if (!sid || !st) return Promise.resolve(null);
    let out = null;
    return durable.update(STORE_KEY, cur => {
      const s = normalize(cur); const e = s.entries.find(x => x.id === sid); if (!e) return undefined;
      const why = REASONS.has(reason) ? reason : (st === 'deferred' ? 'wrong_time' : st === 'completed' ? 'completed' : st === 'accepted' ? 'accepted' : 'unspecified');
      e.state = st; e.reason = why; e.updatedAt = Number(now) || e.updatedAt;
      if (!Array.isArray(e.transitions)) e.transitions = [];
      const prior = e.transitions[e.transitions.length - 1];
      if (!prior || prior.state !== st || prior.reason !== why) e.transitions.push({ state: st, reason: why, at: e.updatedAt });
      e.transitions = e.transitions.slice(-20);
      if (st === 'completed') e.completedAt = e.updatedAt; out = e; return s;
    }).then(() => out);
  }
  function declinedTexts() { return read().entries.filter(e => e.state === 'declined').map(e => e.title); }
  function summary(opts) { return replay(read(), opts); }
  return { read, list, record, verdict, declinedTexts, summary, _durable: durable };
}

module.exports = { makeRecommendationLedger, normalize, normalizeEntry, replay, fingerprint, STATES, REASONS };
