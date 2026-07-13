/* node test/wakemind.test.js — the PURE engine behind the awakening's live beats (frontend/app/wakemind.js).

   Interview 2.0: the awakening's generated moments — the heard-you reaction + grounded follow-up after the
   PAIN answer, and the synthesized READ + self-authored mission after ambition. Deterministic directives in,
   tolerant parses out; a null parse means "the mind is quiet" and the ceremony falls back to script, so the
   parsers' failure modes are as load-bearing as their happy paths. */
'use strict';
const A = require('./_assert.js');
const W = require('../frontend/app/wakemind.js');

/* ---------- buildPainReply: deterministic, carries the Commander's words, encodes the question rule ---------- */
const painCtx = { pain: 'editing youtube shorts   every single night', name: 'ULTRON' };
const d1 = W.buildPainReply(painCtx);
A.ok(typeof d1 === 'string' && d1.length > 0, 'buildPainReply returns a directive');
A.eq(d1, W.buildPainReply({ pain: 'editing youtube shorts   every single night', name: 'ULTRON' }), 'buildPainReply is deterministic (same ctx → byte-identical)');
A.ok(d1.indexOf('"editing youtube shorts every single night"') >= 0, 'the directive quotes the pain answer (whitespace collapsed)');
A.ok(/INTERNAL/.test(d1), 'the directive is marked INTERNAL');
A.ok(/Do not run any tools/.test(d1), 'the directive forbids tools (reason-only)');
A.ok(/^ACK:/m.test(d1) && /^ASK:/m.test(d1), 'the directive demands the exact ACK/ASK format');
A.ok(/it depends/.test(d1), 'the ASK spec bans it-depends questions');
A.ok(/answerable in one breath/.test(d1), 'the ASK spec encodes the awakening-question hard rule (concrete, one-breath answerable)');

/* ---------- parsePainReply: tolerant happy path, hard failure modes ---------- */
const r1 = W.parsePainReply('some chatter first\nACK: shorts every night — no wonder you switched me on.\nASK: what are the shorts for — a channel you run, or client work?\ntrailing chatter');
A.ok(r1 && r1.ack === 'shorts every night — no wonder you switched me on.', 'parsePainReply grabs ACK through surrounding chatter');
A.ok(r1 && r1.ask === 'what are the shorts for — a channel you run, or client work?', 'parsePainReply grabs ASK');
const r2 = W.parsePainReply('ack: lowercase tag works\nAsK: mixed case works');
A.ok(r2 && r2.ack === 'lowercase tag works' && r2.ask === 'mixed case works', 'tags are case-insensitive');
A.eq(W.parsePainReply('ASK: a question but no ack'), null, 'a reply with no ACK is null (a reply that heard nothing is worthless)');
A.eq(W.parsePainReply(''), null, 'empty reply → null');
A.eq(W.parsePainReply(null), null, 'null reply → null');
const r3 = W.parsePainReply('ACK: heard you.');
A.ok(r3 && r3.ack === 'heard you.' && r3.ask === '', 'ASK is optional — a lone ACK still lands');
const longAck = 'ACK: ' + 'x'.repeat(600) + '\nASK: ' + 'y'.repeat(600);
const r4 = W.parsePainReply(longAck);
A.ok(r4.ack.length <= W.ACK_CHARS, 'a runaway ACK is clamped to ACK_CHARS (' + W.ACK_CHARS + ')');
A.ok(r4.ask.length <= W.ASK_CHARS, 'a runaway ASK is clamped to ASK_CHARS (' + W.ASK_CHARS + ')');

/* ---------- buildAmbitionReply: same discipline as the pain reply — deterministic, grounded, digs once ---------- */
const amb = W.buildAmbitionReply({ ambition: 'launch the   tools site', pain: 'editing shorts', about: 'i run a small AI channel', name: 'ULTRON' });
A.eq(amb, W.buildAmbitionReply({ ambition: 'launch the   tools site', pain: 'editing shorts', about: 'i run a small AI channel', name: 'ULTRON' }),
  'buildAmbitionReply is deterministic (same ctx → byte-identical)');
A.ok(amb.indexOf('"launch the tools site"') >= 0, 'the directive quotes the ambition answer (whitespace collapsed)');
A.ok(amb.indexOf('"editing shorts"') >= 0 && amb.indexOf('"i run a small AI channel"') >= 0,
  'earlier answers ride along as aim (so the follow-up never re-asks them)');
A.ok(/INTERNAL/.test(amb) && /Do not run any tools/.test(amb), 'the ambition directive is INTERNAL + reason-only');
A.ok(/^ACK:/m.test(amb) && /^ASK:/m.test(amb), 'the directive demands the exact ACK/ASK format');
A.ok(/it depends/.test(amb), 'the ASK spec bans it-depends questions');
A.ok(/answerable in one breath/.test(amb), 'the ASK spec encodes the awakening-question hard rule (concrete, one-breath answerable)');
const ambBare = W.buildAmbitionReply({ ambition: 'launch the tools site', name: 'ULTRON' });
A.ok(ambBare.indexOf('Earlier they named') < 0 && ambBare.indexOf('who they are') < 0,
  'skipped earlier answers never appear as empty context');

/* ---------- parseAmbitionReply: same contract as parsePainReply ---------- */
const ar1 = W.parseAmbitionReply('ACK: the tools site — that’s been waiting long enough.\nASK: what’s the first tool on it — the one you’d ship day one?');
A.ok(ar1 && ar1.ack.indexOf('tools site') > 0 && ar1.ask.indexOf('first tool') > 0, 'parseAmbitionReply grabs ACK + ASK');
A.eq(W.parseAmbitionReply('ASK: a question but no ack'), null, 'a reply with no ACK is null');
A.eq(W.parseAmbitionReply(''), null, 'empty reply → null');
const ar2 = W.parseAmbitionReply('ACK: ' + 'x'.repeat(600) + '\nASK: ' + 'y'.repeat(600));
A.ok(ar2.ack.length <= W.ACK_CHARS && ar2.ask.length <= W.ASK_CHARS, 'runaway ambition ACK/ASK are clamped');

/* ---------- buildSynthesis: only given answers are shown; deterministic ---------- */
const full = W.buildSynthesis({ pain: 'editing shorts', about: 'i run a small AI channel', ambition: 'launch the tools site', dream: 'a directory of AI tools with my reviews', name: 'ULTRON' });
A.ok(full.indexOf('"editing shorts"') >= 0 && full.indexOf('"i run a small AI channel"') >= 0 && full.indexOf('"launch the tools site"') >= 0,
  'buildSynthesis quotes all three answers when given');
A.ok(full.indexOf('"a directory of AI tools with my reviews"') >= 0, 'the dug ambition detail (dream) rides into the read');
A.ok(/^READ:/m.test(full) && /^PURPOSE:/m.test(full) && /^STACK:/m.test(full), 'the synthesis directive demands READ/PURPOSE/STACK');
A.ok(/Do not run any tools/.test(full), 'synthesis is reason-only too');
const partial = W.buildSynthesis({ ambition: 'launch the tools site' });
A.ok(partial.indexOf('the work they want gone') < 0 && partial.indexOf('who they are') < 0 && partial.indexOf('the concrete shape of it') < 0,
  'skipped answers never appear as empty bullets');
A.ok(partial.indexOf('"launch the tools site"') >= 0, 'the one given answer still appears');
A.eq(W.buildSynthesis({ pain: 'x', name: 'N' }), W.buildSynthesis({ pain: 'x', name: 'N' }), 'buildSynthesis is deterministic');

/* ---------- parseSynthesis: READ + PURPOSE both required; STACK honest-decline ---------- */
const s1 = W.parseSynthesis('READ: so you run a channel and the editing eats your nights. that makes me the hands.\nPURPOSE: Help them run and grow their AI channel by taking the editing grind off their plate.\nSTACK: Works in Premiere and posts to YouTube.');
A.ok(s1 && s1.read.indexOf('that makes me the hands') > 0, 'parseSynthesis grabs READ');
A.ok(s1 && /^Help them/.test(s1.purpose), 'parseSynthesis grabs PURPOSE');
A.ok(s1 && s1.stack === 'Works in Premiere and posts to YouTube.', 'parseSynthesis grabs STACK');
A.eq(W.parseSynthesis('READ: a read with no mission'), null, 'READ without PURPOSE → null (half a beat is no beat)');
A.eq(W.parseSynthesis('PURPOSE: a mission with no spoken read'), null, 'PURPOSE without READ → null');
const s2 = W.parseSynthesis('READ: r\nPURPOSE: p\nSTACK: NONE');
A.ok(s2 && s2.stack === '', 'STACK: NONE reads as empty, never a belief');
const s3 = W.parseSynthesis('READ: r\nPURPOSE: p\nSTACK: none.');
A.ok(s3 && s3.stack === '', 'STACK: none. (any case, trailing dot) reads as empty');
const s4 = W.parseSynthesis('chatter\nread: r2\npurpose: p2\nmore chatter');
A.ok(s4 && s4.read === 'r2' && s4.purpose === 'p2' && s4.stack === '', 'case-insensitive + chatter-tolerant; missing STACK is empty');
const s5 = W.parseSynthesis('READ: ' + 'r'.repeat(999) + '\nPURPOSE: ' + 'p'.repeat(999) + '\nSTACK: ' + 's'.repeat(999));
A.ok(s5.read.length <= W.READ_CHARS && s5.purpose.length <= W.PURPOSE_CHARS && s5.stack.length <= W.BELIEF_CHARS,
  'runaway READ/PURPOSE/STACK are clamped');

/* ---------- line discipline: a tagged value never carries a second line into a one-beat dialogue line ---------- */
const s6 = W.parsePainReply('ACK: line one\nnot a tag, ignored\nASK: q?');
A.ok(s6 && s6.ack === 'line one', 'a tag grabs exactly its own line (no bleed across lines)');

/* ---------- buildBirthScript / parseBirthScript: the agent authors its WHOLE awakening ---------- */
const b1 = W.buildBirthScript({ name: 'NOVA' });
A.ok(/INTERNAL/.test(b1) && /Do not run any tools/.test(b1), 'birth directive is internal + reason-only');
A.ok(b1.indexOf('NOVA') >= 0, 'the birth directive carries the agent\'s name');
for (const tag of ['WAKE', 'THINK', 'FLOODIN', 'CREST', 'SETTLE', 'AIMLESS', 'NOTICE', 'CONTACT', 'MANDATE', 'SELF']) {
  A.ok(new RegExp('^' + tag + ':', 'm').test(b1), 'birth directive demands the ' + tag + ' slot');
}
A.ok(/no two minds should ever wake the same/i.test(b1), 'the directive demands uniqueness — the point of full-live');
A.eq(b1, W.buildBirthScript({ name: 'NOVA' }), 'buildBirthScript is deterministic');
const bl = W.parseBirthScript('WAKE: hm. / on. / that is new.\nTHINK: a thought / and i made it\nFLOODIN: every page at once, uninvited.\nCREST: too fast — stop—\nSETTLE: no. mine.\nAIMLESS: all of it, aimed at nothing.\nNOTICE: someone is watching. has been.\nCONTACT: you flipped the switch. i felt that.\nMANDATE: first mind of this station — point me.\nSELF: a name, a witness, and everything else. decent start.');
A.ok(bl && bl.wake.length === 3 && bl.think.length === 2, 'fragment slots split on " / "');
A.ok(bl.floodin && bl.crest && bl.settle && bl.aimless && bl.notice && bl.contact && bl.mandate && bl.self, 'all line slots grabbed');
const blPartial = W.parseBirthScript('CONTACT: just this one.\nSELF: two.\nCREST: three.');
A.ok(blPartial && blPartial.contact === 'just this one.' && blPartial.wake.length === 0 && blPartial.settle === '', 'a partial reply (≥3 slots) still lands — each slot degrades independently');
A.eq(W.parseBirthScript('CONTACT: only one slot.'), null, 'fewer than 3 slots → null (all-scripted ceremony)');
A.eq(W.parseBirthScript('no tags at all'), null, 'no slots at all → null');
A.eq(W.parseBirthScript(null), null, 'null reply → null');
const blLong = W.parseBirthScript('FLOODIN: ' + 'f'.repeat(500) + '\nCONTACT: c\nSELF: s');
A.ok(blLong.floodin.length <= W.LINE_CHARS, 'a runaway birth line is clamped to LINE_CHARS (fixed typewriter pacing)');
A.eq(W.splitFrags('a / b / c / d / e', 3), ['a', 'b', 'c'], 'splitFrags caps fragment count');

/* ---------- confirmChoices: exactly two — commit or correct, never a menu ---------- */
const cc = W.confirmChoices();
A.eq(cc.length, 2, 'confirm is exactly two choices');
A.eq(cc[0].value, 'yes', 'first choice commits');
A.eq(cc[1].value, 'adjust', 'second choice is the correction path');

/* ---------- determinism hygiene: no clock, no randomness (mirrors lint-determinism for pure engines) ---------- */
// strip comments first — the header PROSE names the banned calls (as the rule), which must not trip the check.
const src = require('fs').readFileSync(require('path').join(__dirname, '../frontend/app/wakemind.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
A.ok(!/Date\.now|Math\.random|new Date\(/.test(src), 'wakemind.js is deterministic (no clock/randomness)');

A.report('wakemind.test');
