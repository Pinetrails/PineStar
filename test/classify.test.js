/* node test/classify.test.js — the TASK-vs-CHAT classifier that gates the entire tool-delivery path.
   A missed task leaves the agent tool-less ("I can't reach the web"), so the bias is toward TASK and
   courtesy-wrapped missions MUST classify as tasks. This table is the guardrail for that promise. */
'use strict';
const A = require('./_assert.js');
const { isTaskDirective, getTag, stanceFor } = require('../frontend/app/classify.js');

// every one of these is a real mission -> MUST be a task (so the agent is handed tools)
const TASKS = [
  'research the 2026 candle market and write candles.md',
  'Hey, can you research the candle market?',
  'thanks, now find the best budget keyboard',
  'good morning! please summarize the EU AI Act',
  'ok go fetch the latest news on AI',
  'nice, write a report on solar prices',
  'yo research bitcoin price',
  'cool can you look up the weather',
  'summarize the news',
  'find me a good pasta recipe and save it',
  'what are you waiting for? search for X',
  'download the spec and extract the API limits',
  'compare the top 3 GPUs and make a table',
  'build me a landing page',
  'investigate why sales dropped in Q2'
];

// pure small-talk / questions about the agent -> MUST be chat (no tools, quick reply)
const CHATS = [
  'hi', 'hey there', 'hello!', 'yo', 'how are you?', "how's it going",
  'who are you', 'what is your name', 'what are you', 'are you alive?',
  'thanks!', 'thank you', 'ty', 'nice', 'cool', 'good job', 'well done',
  'ok', 'okay', 'lol', 'nvm', 'bye', 'see ya'
];

for (const t of TASKS) A.ok(isTaskDirective(t) === true, 'TASK: ' + JSON.stringify(t));
for (const c of CHATS) A.ok(isTaskDirective(c) === false, 'chat: ' + JSON.stringify(c));

// edge cases
A.ok(isTaskDirective('') === false, 'empty -> not a task');
A.ok(isTaskDirective('   ') === false, 'whitespace -> not a task');
A.ok(isTaskDirective('how are you, and can you research llamas?') === true, 'courtesy + intent -> task');

/* ---------- getTag — the FILTER content-router input (code | research | general) ---------- */
// code work -> 'code' (so a FILTER sorts it to the coder agent's bay)
const CODE = [
  'debug this python function',
  'fix the bug in app.js',
  'refactor the auth module',
  'write a regex for emails',
  'why does this throw an exception',
  'deploy the api to staging',
  'review my git commit',
  'the build is failing, check the stack trace'
];
// research work -> 'research' (sorts to the researcher agent's bay)
const RESEARCH = [
  'research the 2026 candle market',
  'look up the population of France',
  'find out who won the 2024 election',
  'gather sources on solar pricing',
  'search the latest AI news',
  'survey the competitor landscape',
  'fact-check this headline'
];
// neither signal -> 'general' (the filter's default / catch-all lane, never dropped)
const GENERAL = [
  'help me plan my day',
  'draft a thank-you note',
  'what should I have for lunch',
  'organize my schedule',
  ''
];
for (const t of CODE) A.eq(getTag(t), 'code', 'code: ' + JSON.stringify(t));
for (const t of RESEARCH) A.eq(getTag(t), 'research', 'research: ' + JSON.stringify(t));
for (const t of GENERAL) A.eq(getTag(t), 'general', 'general: ' + JSON.stringify(t));

// precedence + robustness
A.eq(getTag('research how to refactor this typescript module'), 'code', 'code intent wins over a research verb');
A.eq(getTag(null), 'general', 'null -> general (default lane, never throws)');
A.eq(getTag('   '), 'general', 'whitespace -> general');
A.eq(getTag('Build the API'), getTag('build the api'), 'case-insensitive + deterministic (replay-stable)');

/* ---------- stanceFor — THE HARD INVARIANT: a task ALWAYS commands the desk trip ----------
   The bug we shipped a fix for: the speaker/voice toggle leaked into the stance, so an on-speaker task was
   answered one-on-one in place and the agent never walked to its workstation. These assertions make that
   regression impossible to reintroduce silently — a task is a task is a desk trip, no matter what. */
A.eq(stanceFor(true), 'task', 'a TASK always -> task stance (walk to the workstation + stay seated until done)');
A.eq(stanceFor(false), 'talk', 'a non-task -> talk stance (face the Commander one-on-one)');
// structural guarantee: stanceFor reads NOTHING but isTask, so no voice/speaker/mic/UI state can ever turn a
// task into a one-on-one chat. Any extra argument is ignored — the desk trip cannot be suppressed.
A.eq(stanceFor(true, { voiceOn: true }), 'task', 'voice ON must NOT change a task (extra args ignored)');
A.eq(stanceFor(true, true, 'anything'), 'task', 'no other input can suppress a task’s desk trip');
A.eq(stanceFor(false, { voiceOn: true }), 'talk', 'voice ON must NOT promote a chat into a desk trip');
// every real mission classifies as a task AND therefore takes the desk trip (end-to-end through the classifier)
for (const t of TASKS) A.eq(stanceFor(isTaskDirective(t)), 'task', 'mission -> desk trip: ' + JSON.stringify(t));
for (const c of CHATS) A.eq(stanceFor(isTaskDirective(c)), 'talk', 'small talk -> one-on-one: ' + JSON.stringify(c));

A.report('classify.test');
