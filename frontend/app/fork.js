/* STARNET — fork.js : the PURE engine for MID-TASK PREFERENCE FORKS (R1 — questions that ARE work).

   When an agent hits a genuine fork whose answer is a DURABLE preference (format, tone, ask-first vs
   run-with-it — never a one-off task detail), it may ask ONCE instead of guessing: the question rides its
   normal reply (ending the turn — the honest mechanic; no fake mid-stream pause), the Commander answers via
   chips at the run boundary, and the pick does double duty — it steers the task immediately AND banks into
   the dossier's style dimension as a Commander-authored belief (the highest-quality evidence there is:
   given in context, about a real decision, immediately acted on).

   SELF-RETIRING by construction: the fork instruction only enters the system prompt while the style model's
   confidence is LOW (the same understanding.js floor that aims the VOI question and the belief probes) —
   once the station knows how the Commander likes work done, the forks stop appearing at all. The system
   asks LESS the longer it's used.

   This engine is the pure half: the directive block, the reply-marker parser, the confidence gate, and the
   banked-belief composer. The live wiring (prompt injection, chip render, dossier commit) lives in app.js /
   chat.js. PURE + node-testable, mirroring pitch.js / curiosity.js: a `Fork` global in the browser,
   module.exports under node. No clocks, no randomness. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Fork = api; root.TaskIntent = api.TaskIntent; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CONF_FLOOR = 0.45;   // the fork instruction rides only while style confidence sits below this —
                             // the same "real doubt exists" floor understanding-probes use. Above it the
                             // agent is told nothing and forks never appear (self-retiring).
  const MAX_OPTS = 3;        // a fork is 2–3 concrete options, never a menu
  const Q_CHARS = 160;       // the question line is capped (a fork is short or it isn't a fork)
  const OPT_CHARS = 48;      // each option is a compact label, not a paragraph

  // the reply marker the agent is instructed to emit — one line, machine-findable, human-readable:
  //   FORK: terse summary or full detail? || terse | full detail
  const LINE = /^\s*FORK:\s*(.+?)\s*\|\|\s*(.+?)\s*$/m;

  // is the fork instruction earned right now? `read` is the understanding read (UnderstandingStore.read()).
  // Fail-closed: no read / malformed → NOT offered (an unearned fork is exactly the interruption Andrew
  // is wary of; when in doubt, the agent just guesses like today).
  function shouldOffer(read) {
    if (!read || !read.dims || !read.dims.style) return false;
    const c = read.dims.style.conf;
    return Number.isFinite(c) && c < CONF_FLOOR;
  }

  // the conditional system-prompt block. Only composed when shouldOffer() said yes — the caller never
  // includes it otherwise, so a well-understood Commander's prompt carries zero fork machinery.
  function directive() {
    return [
      'MID-TASK PREFERENCE FORK (you may use this AT MOST ONCE per task, or not at all):',
      'If — and only if — you hit a genuine fork where the choice reveals a DURABLE preference about how your',
      'Commander likes work done (format, tone, depth, ask-first vs run-with-it), you may ask instead of guessing.',
      'Never use it for one-off task details (which file, which URL — just ask those normally or decide).',
      'To ask, end your reply with exactly one line in this format (2-3 short options, || and | are literal):',
      'FORK: <the question, one short line> || <option A> | <option B> | <option C, optional>',
      'HARD FORMAT RULE while this block is present: if your reply ends by offering the Commander a choice or',
      'asking their preference (formats, tone, length, "want A or B?", "should I keep/save/shorten…?"), that',
      'question MUST be the FORK line — never plain prose. Same question, but the Commander answers with one',
      'tap and the station keeps the answer permanently. A reply that needs no question needs no FORK line.',
      'Example — instead of ending with "Want me to keep this casual, or make it formal?", end with:',
      'FORK: keep this casual, or formal? || casual | formal',
      'Your Commander answers with one tap; their answer arrives as their next message AND the station remembers',
      'it permanently — so never ask a fork twice, and never ask what the briefing above already tells you.'
    ].join('\n');
  }

  // find the fork in an agent reply. Returns { question, options: [2..3] } or null (no marker / malformed /
  // too few options — a broken marker renders as plain text, never a broken chip row).
  function parse(text) {
    const m = LINE.exec(String(text == null ? '' : text));
    if (!m) return null;
    const question = m[1].trim().slice(0, Q_CHARS);
    const options = m[2].split('|').map(s => s.trim()).filter(Boolean).slice(0, MAX_OPTS)
      .map(s => s.length > OPT_CHARS ? s.slice(0, OPT_CHARS - 1) + '…' : s);
    if (!question || options.length < 2) return null;
    return { question, options };
  }

  // strip the marker line from the rendered reply (the chips replace it; the raw FORK: line never shows).
  function strip(text) {
    return String(text == null ? '' : text).replace(LINE, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  // the dossier belief a pick banks: the Commander's answer, with the question kept as context so the
  // belief stays legible in the COMMANDER panel ("bullets — asked: summary format?").
  function beliefText(question, answer) {
    const a = String(answer == null ? '' : answer).trim();
    const q = String(question == null ? '' : question).trim().replace(/\?+$/, '');
    if (!a) return '';
    return q ? (a + ' (asked: ' + q + '?)') : a;
  }

  // TASK CONTEXT is the complementary, task-local decision protocol. It intentionally lives beside durable
  // preference forks so the browser and Node host share one already-shipped decision-protocol module without
  // adding another release-surface path. Unlike FORK, its answers stay in the Task Brief, never the dossier.
  const TASK_LINE = /^\s*TASK_QUESTION:\s*(.+?)\s*\|\|\s*(.+?)\s*$/mi;
  const TASK_Q_CHARS = 240, TASK_OPT_CHARS = 72, TASK_MAX_OPTS = 3;
  function taskClean(s, max) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max); }
  function taskParse(text) {
    const m = TASK_LINE.exec(String(text == null ? '' : text));
    if (!m) return null;
    const question = taskClean(m[1], TASK_Q_CHARS);
    const options = m[2].split('|').map(x => taskClean(x, TASK_OPT_CHARS)).filter(Boolean).slice(0, TASK_MAX_OPTS);
    return question && options.length >= 2 ? { question, options } : null;
  }
  function taskStrip(text) {
    return String(text == null ? '' : text).replace(TASK_LINE, '').replace(/\n{3,}/g, '\n\n').trim();
  }
  function taskDirective(contextBlock) {
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
  function taskAnswerMessage(question, answer) {
    const q = taskClean(question, TASK_Q_CHARS), a = taskClean(answer, 500);
    if (!a) return 'Use your judgment. Choose the most sensible reversible default and continue the original task.';
    return a + (q ? ' — for: ' + q : '');
  }
  const TaskIntent = {
    parse: taskParse, strip: taskStrip, directive: taskDirective, answerMessage: taskAnswerMessage,
    MAX_QUESTION: TASK_Q_CHARS, MAX_OPTION: TASK_OPT_CHARS, MAX_OPTIONS: TASK_MAX_OPTS
  };

  return { shouldOffer, directive, parse, strip, beliefText, CONF_FLOOR, MAX_OPTS, TaskIntent };
});
