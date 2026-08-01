/* Host-side policy for Task Brief decisions. This is the reliability boundary: models may
   propose a question or a settled brief, but only this module decides whether it is usable. */
'use strict';
const TaskIntent = require('../frontend/app/fork.js').TaskIntent;   // the shared decision-protocol module (index.js already speaks it)

const DIMENSIONS = new Set(['objective', 'audience', 'deliverable', 'scope', 'constraints', 'sources', 'acceptance', 'safety']);
const VAGUE = /\b(what does good look like|tell me more|can you elaborate|any preferences|what do you want|how should i proceed)\b/i;
const CANCEL = /^\s*(cancel|stop|never\s*mind|nevermind|forget\s+(?:it|that)|drop\s+(?:it|that))\s*[.!]?\s*$/i;
const REPLACE = /^\s*(?:new\s+task\s*:|instead\s*,?|forget\s+that\s*[,;:]?|change\s+of\s+plan\s*[:,]?)\s*(.+)$/i;

function clean(v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); }

// RECOMMENDATION MATCHING (2026-07-24). The model writes `recommended` as free text and near-misses its own
// option list constantly — a trailing period, a leading article, a smart quote, an "A." enumerator. Requiring
// byte-equality made every one of those a HARD REJECT, and because brief_ask is a hidden tool the failure was
// invisible in both the transcript and the logs; the retry advice then steers the model to the plain marker
// path, which stores NO recommendation at all. So a formatting slip silently cost the Commander the ★ chip and
// looked identical to "the agent had no opinion".
// Matching is EQUALITY-ONLY, on the normalized form. It always returns the CANONICAL option text.
//
// A substring tier used to live here to rescue enumerators ("A. keep it" vs "keep it"). It was removed
// 2026-07-24 after review: substring containment silently INVERTS negations, because the negated option
// contains the positive one but not the reverse. Every one of these resolved to the OPPOSITE of the intent:
//     ["publish" | "do not publish"]      + "don't publish"        -> "publish"
//     ["include tests" | "skip tests"]    + "do not include tests" -> "include tests"
//     ["operators" | "executives"]        + "not operators"        -> "operators"
// The per-tier uniqueness guard could not catch it — exactly one option matches, it is just the wrong one.
// Enumerator prefixes are handled inside `loosen` instead (fork.js), which is meaning-preserving. Anything
// that is not an equality match after normalization is a genuine miss and fails closed.
const loosen = TaskIntent.loosen;
function matchOption(options, candidate) {
  const list = Array.isArray(options) ? options.filter(Boolean) : [];
  const c = clean(candidate, 72);
  if (!list.length || !c) return '';
  const exact = list.find(o => o.toLowerCase() === c.toLowerCase());
  if (exact) return exact;                                        // tier 1 — unchanged legacy behaviour
  const lc = loosen(c);
  if (!lc) return '';
  const near = list.filter(o => loosen(o) === lc);                // tier 2 — punctuation/quote/article/enumerator
  return near.length === 1 ? near[0] : '';                        // ambiguous or absent -> fail closed
}
function routeReply(text, explicit) {
  const raw = clean(text, 4000);
  const action = clean(explicit, 16).toLowerCase();
  if (action === 'cancel') return { action: 'cancel', text: raw };
  if (action === 'replace') return { action: 'replace', text: raw };
  if (action === 'answer') return { action: 'answer', text: raw };
  if (CANCEL.test(raw)) return { action: 'cancel', text: raw };
  const m = REPLACE.exec(raw);
  if (m && clean(m[1], 4000)) return { action: 'replace', text: clean(m[1], 4000) };
  return { action: 'answer', text: raw };
}

function validateQuestion(candidate, brief) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const dimension = clean(c.dimension, 24).toLowerCase();
  const question = clean(c.question || c.text, 240);
  // Dedupe on the LOOSENED form: exact-string dedupe let "operators" / "operators." / "the operators" through
  // as three distinct chips, which is the same choice offered three times dressed as a real decision. Collapsing
  // them means such a question now fails the >=2 check below instead of rendering a fake trilemma.
  const options = TaskIntent.dedupeOptions(c.options);
  const recommended = clean(c.recommended || c.defaultOption, 72);
  const reason = clean(c.reason, 240);
  const prior = brief && Array.isArray(brief.questions) ? brief.questions : [];
  if (!DIMENSIONS.has(dimension)) return { ok: false, error: 'dimension must be one of: ' + Array.from(DIMENSIONS).join(', ') };
  if (!question || VAGUE.test(question)) return { ok: false, error: 'ask one concrete, non-vague question' };
  if (options.length < 2) return { ok: false, error: 'provide 2-3 genuinely different options' };
  const pick = matchOption(options, recommended);
  if (!pick) return { ok: false, error: 'recommended must match one option (copy it verbatim from options)' };
  if (!reason) return { ok: false, error: 'state why this decision materially changes the result' };
  if (c.discoverable !== false) return { ok: false, error: 'inspect available context first; discoverable must be false' };
  if (prior.length >= 2) return { ok: false, error: 'this task already used its two-question limit' };
  if (prior.length === 1 && (c.newBlocker !== true || !prior[0].answer)) return { ok: false, error: 'a second question requires an answered first question and a newly exposed blocker' };
  return { ok: true, question: { dimension, question, text: question, options, recommended: pick, reason, newBlocker: c.newBlocker === true } };
}

function validateProceed(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const objective = clean(c.objective, 500);
  if (objective.length < 4) return { ok: false, error: 'objective is required before consequential work' };
  const out = { objective };
  for (const k of ['deliverable', 'audience', 'success']) { const v = clean(c[k], 500); if (v) out[k] = v; }
  out.assumptions = Array.isArray(c.assumptions) ? c.assumptions.map(x => clean(x, 300)).filter(Boolean).slice(0, 8) : [];
  out.sources = Array.isArray(c.sources) ? c.sources.map(x => clean(x, 300)).filter(Boolean).slice(0, 8) : [];
  return { ok: true, brief: out };
}

function canMutate(brief, tool) {
  if (!brief || !tool) return { ok: true };
  // Built-in reads are non-consequential, but MCP tools are deliberately `external-unknown` even when an
  // untrusted server advertises readOnlyHint. That annotation may shape grants; it cannot bypass the brief gate.
  if (tool.scope === 'read' && tool.impact !== 'external-unknown') return { ok: true };
  return brief.status === 'executing'
    ? { ok: true }
    : { ok: false, reason: 'settle the Task Brief with brief_proceed, or ask the one material question with brief_ask, before consequential work' };
}

module.exports = { DIMENSIONS, routeReply, validateQuestion, validateProceed, canMutate, clean, matchOption };
