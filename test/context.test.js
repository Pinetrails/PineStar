/* node test/context.test.js — pure context-transform tests (zero IO). */
'use strict';
const A = require('./_assert.js');
const { makeContext, redact, renderRecall, injectRecall } = require('../sidecar/context.js');

const ctx = makeContext({ contextLimit: 1000, compactAt: 0.65, keepTail: 2 });
const m = (role, content) => ({ role, content });

// ---- systemPrompt: sectioned + frozen-shaped ----
const sp = ctx.systemPrompt({ identity: 'ULTRON', capabilities: 'notebook.write', rules: 'be concise' });
A.ok(sp.indexOf('<identity>\nULTRON') >= 0, 'identity section present');
A.ok(sp.indexOf('<capabilities>\nnotebook.write') >= 0, 'capabilities section present');
A.ok(sp.indexOf('<rules>\nbe concise') >= 0, 'rules section present');
A.eq(ctx.systemPrompt({ identity: 'X' }), ctx.systemPrompt({ identity: 'X' }), 'systemPrompt deterministic');

// ---- assemble: system first, summary as 2nd system msg, history after ----
const h = [m('user', 'hi'), m('assistant', 'hello')];
const a1 = ctx.assemble({ system: 'SYS', history: h });
A.eq(a1[0], m('system', 'SYS'), 'system goes first');
A.eq(a1.length, 3, 'no summary -> system + 2 history');
const a2 = ctx.assemble({ system: 'SYS', summary: 'earlier stuff', history: h });
A.eq(a2[0].role, 'system', 'system prefix first');
A.eq(a2[1].role, 'system', 'summary is a 2nd system message');
A.ok(a2[1].content.indexOf('earlier stuff') >= 0, 'summary content embedded');
A.eq(a2.length, 4, 'system + summary + 2 history');

// ---- estimateTokens monotonic ----
A.ok(ctx.estimateTokens('a'.repeat(40)) > ctx.estimateTokens('a'.repeat(4)), 'longer text -> more tokens');

// ---- fit: preserve system + newest, trim oldest first ----
const sys = m('system', 'SYS');
const msgs = [sys, m('user', 'u1 oldest'), m('assistant', 'a1 mid'), m('user', 'u2 newer'), m('assistant', 'NEWEST reply')];
A.eq(ctx.fit(msgs, { maxTokens: 1000000 }), msgs, 'generous budget keeps everything');

const tinyBudget = ctx.estimateMessages([sys]) + ctx.estimateMessages([msgs[4]]);
const tiny = ctx.fit(msgs, { maxTokens: tinyBudget });
A.eq(tiny.length, 2, 'tiny budget keeps only system + newest');
A.eq(tiny[0], sys, 'system preserved');
A.eq(tiny[1], msgs[4], 'newest preserved');

const midBudget = ctx.estimateMessages([sys, msgs[2], msgs[3], msgs[4]]);
const mid = ctx.fit(msgs, { maxTokens: midBudget });
A.eq(mid, [sys, msgs[2], msgs[3], msgs[4]], 'oldest user turn dropped first; newest + system kept');

// fit does not mutate input
const before = JSON.stringify(msgs);
ctx.fit(msgs, { maxTokens: tinyBudget });
A.eq(JSON.stringify(msgs), before, 'fit does not mutate input');

// ---- shouldCompact ----
A.ok(ctx.shouldCompact({ prompt_tokens: 700 }), 'over 65% of 1000 -> compact');
A.ok(!ctx.shouldCompact({ prompt_tokens: 100 }), 'under threshold -> no compact');
A.ok(!makeContext({}).shouldCompact({ prompt_tokens: 1e9 }), 'unknown contextLimit -> never compact');

// ---- compact (pure given summarize) ----
const longH = [m('user', '1'), m('assistant', '2'), m('user', '3'), m('assistant', '4'), m('user', '5')];
const fakeSummarize = older => 'SUM(' + older.length + ')';
const c = ctx.compact(longH, fakeSummarize);
A.eq(c.summary, 'SUM(3)', 'older 3 turns summarized (keepTail=2)');
A.eq(c.tail.length, 2, 'tail keeps last 2 turns');
A.eq(c.tail[1], m('user', '5'), 'tail ends at newest');
A.eq(ctx.compact(longH, fakeSummarize), c, 'compact deterministic given summarize');
const shortH = [m('user', 'x')];
A.eq(ctx.compact(shortH, fakeSummarize), { summary: '', tail: shortH }, 'history <= keepTail -> no summary');

// ---- redact: strips key-shaped secrets, recurses, never mutates ----
A.ok(redact('my key is sk-or-v1-abcdef0123456789zzzz here').indexOf('sk-or-v1-') < 0, 'openrouter key redacted');
A.ok(redact('sk-ant-api03-AAAA1111BBBB2222').indexOf('sk-ant-') < 0, 'anthropic key redacted');
A.ok(redact('Authorization: Bearer abcdef0123456789ABCDEF').indexOf('abcdef0123456789ABCDEF') < 0, 'bearer token redacted');
A.eq(redact('just a normal sentence'), 'just a normal sentence', 'non-secrets untouched');
const obj = { note: 'token sk-or-v1-deadbeefdeadbeef99', list: ['sk-ant-zzzzzzzzzzzzzzzz', 'safe'] };
const red = redact(obj);
A.ok(JSON.stringify(red).indexOf('sk-or-v1-') < 0 && JSON.stringify(red).indexOf('sk-ant-') < 0, 'recursive redaction');
A.eq(red.list[1], 'safe', 'safe values preserved in arrays');
A.ok(JSON.stringify(obj).indexOf('sk-or-v1-') >= 0, 'redact did NOT mutate the input object');

// ---- renderRecall (Cortex M-mem.1): pure, char-capped recalled-memory fence ----
A.eq(renderRecall([], { limit: 1500 }), { text: '', count: 0, chars: 0 }, 'no records -> empty recall');
A.eq(renderRecall(null), { text: '', count: 0, chars: 0 }, 'null records -> empty recall (tolerant)');

const recNotes = [
  { id: 'note_2', title: 'User tz', body: 'PST', ts: 2 },
  { id: 'note_1', title: 'API base', body: 'openrouter.ai/api/v1', ts: 1 }
];
const rec = renderRecall(recNotes, { limit: 1500 });
A.eq(rec.count, 2, 'both notes rendered');
A.eq(rec.text.indexOf('<recalled-memory>'), 0, 'fence opens with the tag');
A.ok(/<\/recalled-memory>$/.test(rec.text), 'fence closes with the tag');
A.ok(rec.text.indexOf('User tz — PST') >= 0, 'title — body line present');
A.eq(rec.chars, rec.text.length, 'chars matches rendered length');
A.eq(renderRecall(recNotes, { limit: 1500 }), rec, 'renderRecall deterministic');

// content-only and title-only both render; fully-blank records are skipped
const mixed = renderRecall([{ content: 'just a body' }, { title: 'just a title' }, { title: '', body: '' }], { limit: 1500 });
A.eq(mixed.count, 2, 'blank record skipped; body-only + title-only kept');
A.ok(mixed.text.indexOf('• just a body') >= 0, 'content field used when no body');

// char cap bounds how many records are included (but always keeps at least one)
const many = [];
for (let i = 0; i < 50; i++) many.push({ title: 'n' + i, body: 'x'.repeat(80) });
const capped = renderRecall(many, { limit: 300 });
A.ok(capped.count >= 1 && capped.count <= 5, 'char cap limits how many records are included');
A.ok(capped.count < many.length, 'not all records included under a tight budget');

// ---- injectRecall: splice the fence before the newest user message; pure ----
const convo = [m('system', 'SYS'), m('user', 'u1'), m('assistant', 'a1'), m('user', 'u2 newest')];
const injected = injectRecall(convo, rec.text);
A.eq(injected.length, 5, 'one extra message injected');
A.eq(injected[4], convo[3], 'fence lands immediately before the newest user message');
A.ok(injected[3].role === 'system' && injected[3].content.indexOf('<recalled-memory>') === 0, 'injected message is the fence');
A.eq(injected[0], convo[0], 'leading system prefix untouched');

// empty recall -> a fresh COPY equal to input (byte-identical run), not the same reference, no mutation
const noop = injectRecall(convo, '');
A.eq(JSON.stringify(noop), JSON.stringify(convo), 'empty recall -> byte-identical messages');
A.ok(noop !== convo, 'returns a fresh array, not the same reference');
const beforeInject = JSON.stringify(convo);
injectRecall(convo, rec.text);
A.eq(JSON.stringify(convo), beforeInject, 'injectRecall does not mutate input');

// no user message -> fence appended at the end (edge case, never crashes)
const noUser = [m('system', 'SYS'), m('assistant', 'a1')];
const appended = injectRecall(noUser, rec.text);
A.eq(appended.length, 3, 'fence appended when there is no user message');
A.eq(appended[2].role, 'system', 'appended fence is a system note');

A.report('context.test');
