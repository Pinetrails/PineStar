/* Host-side policy for Task Brief decisions. This is the reliability boundary: models may
   propose a question or a settled brief, but only this module decides whether it is usable. */
'use strict';

const DIMENSIONS = new Set(['objective', 'audience', 'deliverable', 'scope', 'constraints', 'sources', 'acceptance', 'safety']);
const VAGUE = /\b(what does good look like|tell me more|can you elaborate|any preferences|what do you want|how should i proceed)\b/i;
const CANCEL = /^\s*(cancel|stop|never\s*mind|nevermind|forget\s+(?:it|that)|drop\s+(?:it|that))\s*[.!]?\s*$/i;
const REPLACE = /^\s*(?:new\s+task\s*:|instead\s*,?|forget\s+that\s*[,;:]?|change\s+of\s+plan\s*[:,]?)\s*(.+)$/i;

function clean(v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); }
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
  const options = Array.isArray(c.options)
    ? c.options.map(x => clean(x, 72)).filter(Boolean).filter((x, i, a) => a.findIndex(y => y.toLowerCase() === x.toLowerCase()) === i).slice(0, 3)
    : [];
  const recommended = clean(c.recommended || c.defaultOption, 72);
  const reason = clean(c.reason, 240);
  const prior = brief && Array.isArray(brief.questions) ? brief.questions : [];
  if (!DIMENSIONS.has(dimension)) return { ok: false, error: 'dimension must be one of: ' + Array.from(DIMENSIONS).join(', ') };
  if (!question || VAGUE.test(question)) return { ok: false, error: 'ask one concrete, non-vague question' };
  if (options.length < 2) return { ok: false, error: 'provide 2-3 genuinely different options' };
  if (!recommended || !options.some(x => x.toLowerCase() === recommended.toLowerCase())) return { ok: false, error: 'recommended must exactly match one option' };
  if (!reason) return { ok: false, error: 'state why this decision materially changes the result' };
  if (c.discoverable !== false) return { ok: false, error: 'inspect available context first; discoverable must be false' };
  if (prior.length >= 2) return { ok: false, error: 'this task already used its two-question limit' };
  if (prior.length === 1 && (c.newBlocker !== true || !prior[0].answer)) return { ok: false, error: 'a second question requires an answered first question and a newly exposed blocker' };
  return { ok: true, question: { dimension, question, text: question, options, recommended: options.find(x => x.toLowerCase() === recommended.toLowerCase()), reason, newBlocker: c.newBlocker === true } };
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
  if (!brief || !tool || tool.scope === 'read') return { ok: true };
  return brief.status === 'executing'
    ? { ok: true }
    : { ok: false, reason: 'settle the Task Brief with brief_proceed, or ask the one material question with brief_ask, before consequential work' };
}

module.exports = { DIMENSIONS, routeReply, validateQuestion, validateProceed, canMutate, clean };
