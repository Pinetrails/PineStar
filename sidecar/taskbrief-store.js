/* sidecar/taskbrief-store.js — durable per-conversation task briefs for intent elicitation.

   The brief is execution context, not chain-of-thought: original directive, visible question/answer,
   explicit assumptions, and lifecycle. It survives restart so a question asked tonight can be answered
   tomorrow without losing the task it belonged to. Task-specific choices never enter the global dossier. */
'use strict';

const { makeDurableJsonStore } = require('./durable-store.js');
const Policy = require('./taskbrief-policy.js');

const STORE_KEY = 'task-briefs';
const CAP = 500;
const STATES = { ready: 1, clarifying: 1, executing: 1, done: 1, cancelled: 1 };

function bounded(s, n) { return String(s == null ? '' : s).trim().slice(0, n); }
function normalizeQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const text = bounded(q.text || q.question, 240);
  const options = Array.isArray(q.options) ? q.options.map(x => bounded(x, 72)).filter(Boolean).slice(0, 3) : [];
  if (!text) return null;
  return {
    id: bounded(q.id, 80), text, options, dimension: bounded(q.dimension, 24),
    recommended: bounded(q.recommended, 72), reason: bounded(q.reason, 240), newBlocker: q.newBlocker === true,
    answer: bounded(q.answer, 500), askedAt: Number(q.askedAt) || 0, answeredAt: Number(q.answeredAt) || 0
  };
}
function normalizeBrief(b) {
  const x = b && typeof b === 'object' ? b : {};
  return {
    id: bounded(x.id, 100), key: bounded(x.key, 160), streamId: bounded(x.streamId, 80),
    agentId: bounded(x.agentId || 'agent', 40), source: bounded(x.source || 'interactive', 24),
    originalDirective: bounded(x.originalDirective, 4000), currentInput: bounded(x.currentInput, 4000),
    status: STATES[x.status] ? x.status : 'ready',
    questions: Array.isArray(x.questions) ? x.questions.map(normalizeQuestion).filter(Boolean).slice(-8) : [],
    assumptions: Array.isArray(x.assumptions) ? x.assumptions.map(v => bounded(v, 300)).filter(Boolean).slice(-12) : [],
    settled: x.settled && typeof x.settled === 'object' ? {
      objective: bounded(x.settled.objective, 500), deliverable: bounded(x.settled.deliverable, 500),
      audience: bounded(x.settled.audience, 500), success: bounded(x.settled.success, 500),
      assumptions: Array.isArray(x.settled.assumptions) ? x.settled.assumptions.map(v => bounded(v, 300)).filter(Boolean).slice(0, 8) : [],
      sources: Array.isArray(x.settled.sources) ? x.settled.sources.map(v => bounded(v, 300)).filter(Boolean).slice(0, 8) : []
    } : null,
    createdAt: Number(x.createdAt) || 0, updatedAt: Number(x.updatedAt) || Number(x.createdAt) || 0,
    completedAt: Number(x.completedAt) || 0, runId: bounded(x.runId, 100)
  };
}
function normalize(raw) {
  const x = raw && typeof raw === 'object' ? raw : {};
  return { briefs: Array.isArray(x.briefs) ? x.briefs.map(normalizeBrief).filter(b => b.id && b.key).slice(-CAP) : [] };
}

function fingerprintQuestion(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3)
    .filter(t => !/^(this|that|with|from|what|which|should|would|could|your|their|about)$/.test(t))
    .filter((t, i, a) => a.indexOf(t) === i).sort().join(' ');
}

function makeTaskBriefStore(deps) {
  deps = deps || {};
  const pathMod = deps.path, workspaces = deps.workspaces;
  if (!pathMod || !workspaces) throw new Error('makeTaskBriefStore: path + workspaces required');
  const durable = makeDurableJsonStore({
    fs: deps.fs, path: pathMod, fileFor: () => pathMod.join(workspaces, 'task-briefs.json'),
    writeDurable: deps.writeDurable, onRecover: deps.onRecover, onCorrupt: deps.onCorrupt
  });
  const warn = typeof deps.warn === 'function' ? deps.warn : function () {};
  function read() { try { return normalize(durable.get(STORE_KEY)); } catch (e) { warn('[taskbrief] read failed', e); return normalize(null); } }
  function list(opts) {
    opts = opts || {}; let rows = read().briefs;
    if (opts.key) rows = rows.filter(b => b.key === String(opts.key));
    if (opts.status) rows = rows.filter(b => b.status === String(opts.status));
    rows = rows.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    return Number.isFinite(opts.limit) ? rows.slice(0, Math.max(0, opts.limit)) : rows;
  }
  function active(key) { return list({ key, limit: 1 })[0] || null; }

  function prepare(input, now) {
    input = input || {}; const key = bounded(input.key, 160); const text = bounded(input.text, 4000);
    if (!key || !text) return Promise.resolve(null);
    let out = null;
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); const ts = Number(now) || 0;
      const prior = rec.briefs.filter(b => b.key === key).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
      if (prior && prior.status === 'clarifying') {
        const routed = Policy.routeReply(text, input.taskAction);
        if (routed.action === 'cancel') {
          prior.status = 'cancelled'; prior.currentInput = text; prior.updatedAt = ts;
          out = Object.assign({}, prior, { inputAction: 'cancel' }); return rec;
        }
        if (routed.action === 'replace') {
          prior.status = 'cancelled'; prior.updatedAt = ts;
          out = normalizeBrief({
            id: bounded(input.id, 100) || ('tb_' + bounded(input.runId, 80)), key,
            streamId: bounded(input.streamId, 80), agentId: bounded(input.agentId || prior.agentId || 'agent', 40),
            source: bounded(input.source || prior.source || 'interactive', 24), originalDirective: routed.text, currentInput: routed.text,
            status: 'ready', createdAt: ts, updatedAt: ts, runId: bounded(input.runId, 100)
          });
          rec.briefs.push(out); while (rec.briefs.length > CAP) rec.briefs.shift();
          out = Object.assign({}, out, { inputAction: 'replace' }); return rec;
        }
        const q = prior.questions[prior.questions.length - 1];
        if (q && !q.answer) { q.answer = routed.text; q.answeredAt = ts; }
        prior.currentInput = text; prior.status = 'ready'; prior.updatedAt = ts; out = prior;
      } else {
        out = normalizeBrief({
          id: bounded(input.id, 100) || ('tb_' + bounded(input.runId, 80)), key,
          streamId: bounded(input.streamId, 80), agentId: bounded(input.agentId || 'agent', 40),
          source: bounded(input.source || 'interactive', 24), originalDirective: text, currentInput: text,
          status: 'ready', createdAt: ts, updatedAt: ts, runId: bounded(input.runId, 100)
        });
        rec.briefs.push(out); while (rec.briefs.length > CAP) rec.briefs.shift();
      }
      return rec;
    }).then(() => out);
  }

  function ask(id, question, now, opts) {
    const key = String(id || ''); const fromMarker = !!(opts && opts.source === 'marker'); let out = null;
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); const b = rec.briefs.find(x => x.id === key); if (!b) return undefined;
      let fields;
      if (fromMarker) {
        // Marker path: the model asked via the plain TASK_QUESTION reply line, so only the question and
        // options actually exist. Record exactly that — an empty dimension/recommended/reason is honest;
        // stamping placeholder values would let an unvalidated question masquerade as a host-validated one
        // (and a fabricated recommendation would surface in the UI). The whole-task question budget still holds.
        const base = normalizeQuestion(question); if (!base || base.options.length < 2) return undefined;
        if (b.questions.length >= 2) return undefined;
        if (b.questions.length === 1 && !b.questions[0].answer) return undefined;
        fields = { text: base.text, options: base.options };
      } else {
        const checked = Policy.validateQuestion(question, b); if (!checked.ok) return undefined;
        fields = checked.question;
      }
      const q = normalizeQuestion(Object.assign({ id: key + '_q' + (b.questions.length + 1), askedAt: now }, fields));
      b.questions.push(q); b.status = 'clarifying'; b.updatedAt = Number(now) || b.updatedAt; out = b; return rec;
    }).then(() => out);
  }

  function proceed(id, candidate, now) {
    const key = String(id || ''); let out = null;
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); const b = rec.briefs.find(x => x.id === key); if (!b) return undefined;
      const checked = Policy.validateProceed(candidate); if (!checked.ok || b.status === 'clarifying' || b.status === 'done' || b.status === 'cancelled') return undefined;
      b.settled = checked.brief; b.assumptions = checked.brief.assumptions;
      b.status = 'executing'; b.updatedAt = Number(now) || b.updatedAt; out = b; return rec;
    }).then(() => out);
  }

  function complete(id, runId, now, assumptions) {
    const key = String(id || ''); let out = null;
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); const b = rec.briefs.find(x => x.id === key); if (!b) return undefined;
      b.status = 'done'; b.runId = bounded(runId, 100); b.completedAt = Number(now) || 0; b.updatedAt = b.completedAt;
      if (Array.isArray(assumptions)) b.assumptions = assumptions.map(x => bounded(x, 300)).filter(Boolean).slice(-12);
      out = b; return rec;
    }).then(() => out);
  }

  // Weak relationship evidence only: the same concrete question answered the same way at least twice.
  // The prompt labels these OBSERVED PATTERNS, never standing orders, so they cannot override the current task.
  // The bin key is dimension AND question fingerprint: dimension alone merged unrelated questions that
  // happened to share an answer, and a marker-path question (empty dimension) still bins by its text.
  function patterns(limit) {
    const bins = {};
    for (const b of list({ limit: 200 })) {
      if (b.status !== 'done') continue;
      for (const q of b.questions) {
      if (!q.answer) continue; const fpText = fingerprintQuestion(q.text); const ans = q.answer.toLowerCase(); if (!fpText || !ans) continue;
      const fp = (q.dimension ? 'dimension:' + q.dimension + ':' : '') + fpText;
      const k = fp + '::' + ans; if (!bins[k]) bins[k] = { question: q.text, answer: q.answer, count: 0, updatedAt: q.answeredAt || b.updatedAt };
      bins[k].count++; bins[k].updatedAt = Math.max(bins[k].updatedAt, q.answeredAt || b.updatedAt);
      }
    }
    return Object.values(bins).filter(x => x.count >= 2).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Number.isFinite(limit) ? limit : 5);
  }

  return { read, list, active, prepare, ask, proceed, complete, patterns, fingerprintQuestion, _durable: durable };
}

module.exports = { makeTaskBriefStore, normalize, normalizeBrief, normalizeQuestion, fingerprintQuestion };
