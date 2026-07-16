/* STARNET — taskintent.js : the PURE task-context elicitation protocol.

   A task should start immediately when the Commander supplied enough context. When two plausible
   interpretations would produce materially different work, and the answer cannot be discovered from
   the granted project/history context, the agent may end the turn with ONE machine-readable question:

     TASK_QUESTION: who is this dashboard for? || operators | executives | customers

   The browser removes that protocol line and renders the question as ordinary one-tap COMMS. Messaging
   channels strip the marker but keep the natural question. Answers belong to the durable TASK BRIEF —
   never silently to the station-wide Commander dossier. This module contains no I/O and is shared by the
   browser and Node host, so parsing and prompt doctrine cannot drift. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.TaskIntent = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_QUESTION = 240;
  const MAX_OPTION = 72;
  const MAX_OPTIONS = 3;
  const LINE = /^\s*TASK_QUESTION:\s*(.+?)\s*\|\|\s*(.+?)\s*$/mi;

  function clean(s, max) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max); }

  function parse(text) {
    const m = LINE.exec(String(text == null ? '' : text));
    if (!m) return null;
    const question = clean(m[1], MAX_QUESTION);
    const options = m[2].split('|').map(x => clean(x, MAX_OPTION)).filter(Boolean).slice(0, MAX_OPTIONS);
    if (!question || options.length < 2) return null;
    return { question, options };
  }

  function strip(text) {
    return String(text == null ? '' : text).replace(LINE, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function directive(contextBlock) {
    const lines = [
      'TASK CONTEXT — LISTEN BEFORE YOU BUILD:',
      'Before consequential work, decide whether the Commander already supplied enough context for the result they actually want.',
      'Proceed immediately when the task is clear. Infer low-impact details with reversible defaults; do not turn a good request into an interview.',
      'Research before asking: inspect the granted project, conversation, task brief, and available sources when they can answer the gap.',
      'Ask only when different plausible answers would materially change the outcome, audience, deliverable, source of truth, safety, or acceptance boundary.',
      'Ask ONE concrete question at a time, with 2-3 short, genuinely different options. Never ask vague prompts such as "what does good look like?".',
      'A task may ask at most two questions total; a second is allowed only when the first answer exposed another genuinely blocking decision.',
      'If the Commander said "use your judgment", "just do it", or equivalent, choose the most sensible reversible default and act.',
      'To ask, do no consequential mutation first and END your reply with exactly:',
      'TASK_QUESTION: <one concrete question> || <option A> | <option B> | <option C, optional>',
      'You may inspect/read before asking. Do not emit TASK_QUESTION when you can responsibly proceed. Never repeat a question already answered in the task brief.'
    ];
    const cx = String(contextBlock || '').trim();
    if (cx) lines.push(cx);
    return lines.join('\n');
  }

  function answerMessage(question, answer) {
    const q = clean(question, MAX_QUESTION);
    const a = clean(answer, 500);
    if (!a) return 'Use your judgment. Choose the most sensible reversible default and continue the original task.';
    return a + (q ? ' — for: ' + q : '');
  }

  return { parse, strip, directive, answerMessage, MAX_QUESTION, MAX_OPTION, MAX_OPTIONS };
});
