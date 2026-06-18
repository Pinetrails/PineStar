/* SKYNET — classify.js : is the Commander assigning a TASK (go act, with real tools) or just TALKING?
   Pure + testable (UMD: a `Classify` global in the browser, module.exports under node).

   The bias is deliberately toward TASK: a missed task hands the agent ZERO tools, so it truthfully says
   "I can't reach the web / files" (the exact failure we are fixing) — whereas a missed chat merely offers
   unused tools. So explicit actionable intent ALWAYS wins, even wrapped in courtesy ("hey, could you
   research…", "thanks, now find…"); only whole-message pleasantries or questions about the agent itself
   stay casual. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Classify = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // a verb the agent can carry out (or a filename) -> TASK, regardless of any courtesy wrapper
  const ACTIONABLE = /\b(research|search|google|find|look ?up|fetch|scrape|crawl|download|browse|visit|go to|read|open|write|save|create|generate|build|make|draft|compile|summari[sz]e|report|list|extract|analy[sz]e|investigate|compare|check|calculate|translate|plan|schedule|email|post|send)\b|\.(md|txt|js|ts|py|csv|json|html?|pdf)\b/;
  // pure pleasantries / acknowledgements — a greeting word, optionally trailed by a few non-actionable
  // tokens ("hey there", "thanks a lot", "good morning friend") — over the WHOLE message -> CHAT.
  // (ACTIONABLE is tested first, so a greeting that carries a real instruction never reaches here.)
  const CHATTY = /^(hi+|hey+|hello|yo|sup|hiya|howdy|gm|good (morning|evening|night|afternoon)|thanks?|thank you|ty|np|nice|cool|awesome|great( job)?|good job|well done|ok(ay)?|k|lol|haha|nvm|never ?mind|bye|cya|see ya)([\s,!.?]+\w+){0,3}[\s!.?]*$/;
  // questions ABOUT the agent itself (the WHOLE message) -> CHAT
  const ABOUT_SELF = /^(how are you|how('?s| is) it going|how do you feel|who are you|what('?s| is) your name|what are you|are you (ok|okay|alright|there|conscious|sentient|alive|real|happy|sure|awake))[\s!.?]*$/;

  function isTaskDirective(text) {
    const t = String(text == null ? '' : text).trim().toLowerCase();
    if (!t) return false;
    if (ACTIONABLE.test(t)) return true;            // explicit intent beats a courtesy prefix
    if (CHATTY.test(t) || ABOUT_SELF.test(t)) return false;
    return true;                                    // default: treat as a task so work is visible + tooled
  }

  /* CONTENT TAG — what KIND of work is this, so a FILTER junction can sort it to the right agent's bay.
     This is the conveyor's content-router input: getTag(text) -> the tag a work-item box carries, which a
     filter routes by (config.routes[tag] || config.def). Pure + deterministic + case-insensitive.

     'code' wins over 'research' when both signal (a "look up how to refactor this .ts" IS coding work),
     because a code task misrouted to a researcher loses the toolchain; an ambiguous prompt defaults to
     'general' (the filter's catch-all lane) so nothing is ever dropped. Keep both sets CONSERVATIVE —
     over-tagging mis-sorts work; the default lane is the safe sink. Mirror any change in a filter's routes. */
  const CODE = /\b(code|coding|program(?:ming)?|script(?:ing)?|function|class|method|variable|module|bug|debug|refactor|compile|deploy|commit|rebase|repo(?:sitory)?|git|api|endpoint|database|query|sql|regex|stack ?trace|exception|crash|typescript|javascript|python|rust|golang|css|html|react|node|npm|webpack|lint|unit ?test)\b|\.(?:js|ts|tsx|jsx|py|rs|go|java|cpp?|cs|css|html?|json|ya?ml|sh|sql)\b/;
  const RESEARCH = /\b(research|investigate|look ?up|search|google|web ?search|browse|sources?|cite|citations?|references?|study|survey|literature|paper|articles?|news|headlines?|wikipedia|market|trends?|competitors?|background|find out|gather|fact[ -]?check)\b/;

  // the content tag a work-item carries: 'code' | 'research' | 'general' (the default / catch-all lane)
  function getTag(text) {
    const t = String(text == null ? '' : text).trim().toLowerCase();
    if (!t) return 'general';
    if (CODE.test(t)) return 'code';                // code intent wins (misrouted code loses its toolchain)
    if (RESEARCH.test(t)) return 'research';
    return 'general';                               // ambiguous -> the filter's default lane, never dropped
  }

  /* THE AGENT'S STANCE for a turn, from whether the message is a task. This is a HARD INVARIANT, not a
     preference: a real TASK is real work, so it ALWAYS commands the visible desk trip — the agent walks to
     its workstation and STAYS seated there working until the task finishes ('task'). Only non-task chatter
     faces the Commander one-on-one ('talk').

     The speaker/voice setting (or any other UI state) MUST NEVER enter this decision. It once did — voice
     defaulting on forced every task to 'talk', so the agent never walked to the desk — and that exact
     regression is what this signature forbids: stanceFor takes ONLY isTask, so nothing else can suppress
     the desk trip. Do NOT add parameters or branches here. Locked by classify.test.js. */
  function stanceFor(isTask) { return isTask ? 'task' : 'talk'; }

  return { isTaskDirective, getTag, stanceFor };
});
