/* node test/classify.test.js — the TASK-vs-CHAT classifier that gates the entire tool-delivery path.
   A missed task leaves the agent tool-less ("I can't reach the web"), so the bias is toward TASK and
   courtesy-wrapped missions MUST classify as tasks. This table is the guardrail for that promise. */
'use strict';
const A = require('./_assert.js');
const { isTaskDirective } = require('../frontend/app/classify.js');

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

A.report('classify.test');
