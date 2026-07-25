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

// The literal deferral the UI sends when the Commander taps "use your judgment" (fork.js taskAnswerMessage),
// and what a channel user types when they take the same escape hatch ('Reply with a choice, or say "use your
// judgment."'). It must match ONLY a pure deferral: "Use your judgment, but keep it under 3 pages" hands over
// the choice yet still states a real constraint, so counting it as a skip would suppress a dimension the
// Commander is actively steering. Anchored at both ends, with the canned tail optional.
const SKIP_ANSWER = /^\s*use your judgment\b[\s.!,;:—-]*(?:choose the most sensible reversible default and continue the original task\.?)?\s*$/i;

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

  // GROUNDED RECOMMENDATION (2026-07-24). patterns() already knows which answer the Commander keeps choosing
  // for a given question — that is the one suggestion on this surface that is PROVABLE rather than a model
  // guess, and until now it was only whispered into the prompt as weak prose while the UI threw it away.
  // Same question (fingerprint) + an answer that resolves to one of THIS question's options + chosen >= 2
  // times => a suggestion we can defend with a count. Returns canonical option text, or null. Never a guess:
  // if nothing was observed twice, this returns null and the model's own recommendation stands.
  function groundedFor(question, pool) {
    const q = question && typeof question === 'object' ? question : null;
    if (!q || q.answer || !Array.isArray(q.options) || q.options.length < 2) return null;
    const fpText = fingerprintQuestion(q.text);
    if (!fpText) return null;
    const tally = {};
    for (const p of (Array.isArray(pool) ? pool : patterns(50))) {
      if (fingerprintQuestion(p.question) !== fpText) continue;
      // A DEFERRAL is not a choice. "Use your judgment…" is a stored answer like any other, and letting it
      // through produced "you chose this N times before" about an option the Commander declined to pick.
      if (SKIP_ANSWER.test(p.answer)) continue;
      // EQUALITY ONLY — never the rescue matcher. This resolves the COMMANDER'S OWN free text, where a loose
      // match does not merely mis-suggest, it misquotes them: substring matching turned "not operators" into
      // a gold "you chose operators" claim. If their words are not one of these options, there is nothing
      // provable to say.
      const option = Policy.matchOption(q.options, p.answer);
      if (!option) continue;
      // Fold counts across spellings of the SAME option, so history split over "operators"/"operators." is
      // not understated (patterns() bins on the raw answer string; the canonical option is the real key).
      const t = tally[option] || (tally[option] = { option, count: 0, lastAt: 0 });
      t.count += Number(p.count) || 0;
      t.lastAt = Math.max(t.lastAt, Number(p.updatedAt) || 0);
    }
    const ranked = Object.values(tally).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
    const top = ranked[0];
    if (!top || top.count < 2) return null;
    // A DEAD HEAT IS NOT A PREFERENCE. 2x "operators" against 2x "executives" is the Commander having no
    // settled habit; presenting either as "you chose this 2 times before" would dress a coin flip as proof.
    if (ranked[1] && ranked[1].count === top.count) return null;
    return top;
  }

  // ASK-WORTHINESS (2026-07-24). Every "use your judgment" tap is ALREADY persisted as a real answer string
  // (fork.js taskAnswerMessage), so the Commander's own "stop asking me this" signal has been sitting on disk
  // all along, uninterpreted. A dimension they habitually defer is one the agent should decide itself — and
  // then state as a correctable assumption in the read card — rather than burn one of its two questions on.
  // Deliberately CONSERVATIVE: suppressing a question is more consequential than merely suggesting a default,
  // because a false suppression silently guesses at something the Commander cared about. So it needs real
  // repetition (>=3) AND deferrals to be at least half of what they did with that dimension. Marker-path
  // questions carry no dimension and are attributed to none.
  function dimensionDeferrals() {
    const tally = {};
    const done = list({ limit: 200 }).filter(b => b.status === 'done');   // list() sorts newest-first
    done.forEach((b, age) => {                                            // age 0 = most recent completed task
      for (const q of b.questions) {
        const dim = bounded(q.dimension, 24);
        if (!dim || !q.answer) continue;
        const t = tally[dim] || (tally[dim] = { dimension: dim, deferred: 0, answered: 0, lastAskedAge: age, lastAt: -1, lastWasDeferral: false });
        const deferral = SKIP_ANSWER.test(q.answer);
        t.answered++;
        t.lastAskedAge = Math.min(t.lastAskedAge, age);
        if (deferral) t.deferred++;
        const at = Number(q.answeredAt) || Number(q.askedAt) || 0;
        if (at >= t.lastAt) { t.lastAt = at; t.lastWasDeferral = deferral; }
      }
    });
    return Object.values(tally);
  }
  // How many completed tasks may pass before a suppressed dimension is allowed ONE question again.
  const PROBE_GAP = 8;
  function deferredDimensions() {
    return dimensionDeferrals()
      .filter(t => t.deferred >= 3 && t.deferred * 2 >= t.answered)
      // RECOVERY, and it is not optional. Suppression blocks brief_ask, which is the only path that records a
      // dimension at all (marker questions carry none) — so without a way out the latch is permanent BY
      // CONSTRUCTION: no question -> no new answer -> the ratio can never change, and there is no reset route,
      // setting, or UI. A Commander who deferred during two busy tasks would be locked out forever. Two ways
      // back, so recovery never depends on out-waiting a 200-brief history window:
      //   1. a probe: after PROBE_GAP completed tasks with no question here, let one through;
      //   2. the LATEST signal wins: the moment they actually answer one, stop suppressing. Ratio alone would
      //      need four more real answers to outvote three old deferrals — i.e. ~32 tasks at one probe per 8.
      .filter(t => t.lastAskedAge < PROBE_GAP && t.lastWasDeferral)
      .map(t => t.dimension);
  }

  return { read, list, active, prepare, ask, proceed, complete, patterns, groundedFor, dimensionDeferrals, deferredDimensions, fingerprintQuestion, _durable: durable };
}

module.exports = { makeTaskBriefStore, normalize, normalizeBrief, normalizeQuestion, fingerprintQuestion };
