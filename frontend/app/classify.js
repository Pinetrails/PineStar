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

  return { isTaskDirective };
});
