/* node test/fs.patch.test.js — G5.1: the V4A patch PARSER + fuzzy MATCHER, the two pure
   modules behind the (G5.2) fs.patch tool. Pure + dependency-free: NO disk, NO file ops,
   NO clock/rng. Ports Hermes' parse_v4a_patch (tools/patch_parser.py) + fuzzy_find_and_replace
   (tools/fuzzy_match.py) into JS. This iteration is parser+matcher only — fs.js is untouched.

   Covers the G5.1 acceptance:
   - MALFORMED rejection: no `*** Update File:` header / UPDATE with zero hunks / MOVE without
     `-> dst` → clear error, RETURNS (never throws), produces NO file ops.
   - WHITESPACE/FUZZY tolerance: a hunk whose context has 2-vs-4-space indent drift still
     matches via the ladder; the produced replacement REINDENTS to the FILE's indentation; the
     uniqueness guard errors ("provide more context") when >1 match and replaceAll is false.
   - Strategy LADDER order honored: exact preferred, falls through deterministically. */
'use strict';
const A = require('./_assert.js');
const { parseV4APatch, OP } = require('../sidecar/tools/builtin/patchparse.js');
const { fuzzyFindAndReplace } = require('../sidecar/tools/builtin/fuzzymatch.js');

// fuzzyFindAndReplace returns a structured result; never throws on bad match.
function ffr(content, oldS, newS, all) { return fuzzyFindAndReplace(content, oldS, newS, !!all); }

(function () {
  // =====================================================================
  // PART 1 — parseV4APatch (the V4A format)
  // =====================================================================

  // ---- basic UPDATE: headers, context hint, line prefixes ----
  {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/main.py',
      '@@ def greet @@',
      ' def greet():',
      '-    print("hello")',
      '+    print("hi")',
      '*** End Patch',
    ].join('\n');
    const { ops, error } = parseV4APatch(patch);
    A.eq(error, null, 'basic update: no parse error');
    A.eq(ops.length, 1, 'basic update: one op');
    A.eq(ops[0].operation, OP.UPDATE, 'basic update: op type UPDATE');
    A.eq(ops[0].filePath, 'src/main.py', 'basic update: file path parsed + trimmed');
    A.eq(ops[0].hunks.length, 1, 'basic update: one hunk');
    A.eq(ops[0].hunks[0].contextHint, 'def greet', 'basic update: @@ context hint @@ extracted');
    const prefixes = ops[0].hunks[0].lines.map(l => l.prefix);
    A.ok(prefixes.indexOf(' ') >= 0 && prefixes.indexOf('-') >= 0 && prefixes.indexOf('+') >= 0, 'basic update: space/-/+ prefixes all present');
    // content has the 1-char prefix stripped
    const minus = ops[0].hunks[0].lines.find(l => l.prefix === '-');
    A.eq(minus.content, '    print("hello")', 'basic update: prefix stripped, indentation of content preserved');
  }

  // ---- multiple hunks in one UPDATE ----
  {
    const patch = [
      '*** Begin Patch',
      '*** Update File: f.py',
      '@@ first @@',
      ' a',
      '-b',
      '+c',
      '@@ second @@',
      ' x',
      '-y',
      '+z',
      '*** End Patch',
    ].join('\n');
    const { ops, error } = parseV4APatch(patch);
    A.eq(error, null, 'multi-hunk: no error');
    A.eq(ops.length, 1, 'multi-hunk: one op');
    A.eq(ops[0].hunks.length, 2, 'multi-hunk: two hunks');
    A.eq(ops[0].hunks[0].contextHint, 'first', 'multi-hunk: first hint');
    A.eq(ops[0].hunks[1].contextHint, 'second', 'multi-hunk: second hint');
  }

  // ---- ADD File: + lines become content ----
  {
    const patch = [
      '*** Begin Patch',
      '*** Add File: new/module.py',
      '+import os',
      '+',
      '+print("hello")',
      '*** End Patch',
    ].join('\n');
    const { ops, error } = parseV4APatch(patch);
    A.eq(error, null, 'add: no error');
    A.eq(ops.length, 1, 'add: one op');
    A.eq(ops[0].operation, OP.ADD, 'add: op type ADD');
    A.eq(ops[0].filePath, 'new/module.py', 'add: file path');
    const added = ops[0].hunks.reduce((acc, h) => acc.concat(h.lines.filter(l => l.prefix === '+').map(l => l.content)), []);
    A.eq(added[0], 'import os', 'add: first added line');
    A.eq(added[1], '', 'add: blank added line preserved');
    A.eq(added[2], 'print("hello")', 'add: third added line');
  }

  // ---- DELETE File: ----
  {
    const patch = ['*** Begin Patch', '*** Delete File: old/stuff.py', '*** End Patch'].join('\n');
    const { ops, error } = parseV4APatch(patch);
    A.eq(error, null, 'delete: no error');
    A.eq(ops.length, 1, 'delete: one op');
    A.eq(ops[0].operation, OP.DELETE, 'delete: op type DELETE');
    A.eq(ops[0].filePath, 'old/stuff.py', 'delete: file path');
  }

  // ---- MOVE File: src -> dst ----
  {
    const patch = ['*** Begin Patch', '*** Move File: old/path.py -> new/path.py', '*** End Patch'].join('\n');
    const { ops, error } = parseV4APatch(patch);
    A.eq(error, null, 'move: no error');
    A.eq(ops.length, 1, 'move: one op');
    A.eq(ops[0].operation, OP.MOVE, 'move: op type MOVE');
    A.eq(ops[0].filePath, 'old/path.py', 'move: src path');
    A.eq(ops[0].newPath, 'new/path.py', 'move: dst path parsed from "-> dst"');
  }

  // ---- multiple operations in one patch (ADD then DELETE then UPDATE) ----
  {
    const patch = [
      '*** Begin Patch',
      '*** Add File: a.py',
      '+content_a',
      '*** Delete File: b.py',
      '*** Update File: c.py',
      ' keep',
      '-remove',
      '+add',
      '*** End Patch',
    ].join('\n');
    const { ops, error } = parseV4APatch(patch);
    A.eq(error, null, 'multi-op: no error');
    A.eq(ops.length, 3, 'multi-op: three ops');
    A.eq(ops[0].operation, OP.ADD, 'multi-op: [0] ADD');
    A.eq(ops[1].operation, OP.DELETE, 'multi-op: [1] DELETE');
    A.eq(ops[2].operation, OP.UPDATE, 'multi-op: [2] UPDATE');
  }

  // ---- implicit context line (no prefix) treated as a space/context line ----
  {
    const patch = [
      '*** Begin Patch',
      '*** Update File: f.py',
      'bare context line',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const { ops, error } = parseV4APatch(patch);
    A.eq(error, null, 'implicit-context: no error');
    const ctx = ops[0].hunks[0].lines.find(l => l.content === 'bare context line');
    A.eq(ctx.prefix, ' ', 'implicit-context: a prefix-less non-empty line is treated as a context line');
  }

  // ---- empty patch is NOT an error (returns [] for callers to decide) ----
  {
    const { ops, error } = parseV4APatch('');
    A.eq(error, null, 'empty patch: no error');
    A.eq(ops.length, 0, 'empty patch: zero ops');
  }

  // =====================================================================
  // MALFORMED rejection (G5.1 acceptance) — clear error, RETURNS, NO ops
  // =====================================================================

  // (a) a Begin/End-wrapped patch with content lines but NO `*** Update File:` (or any) header →
  //     no ops formed → error, no throw. (A bare string with no markers is a no-op empty patch,
  //     tested separately above — the error case is a patch that's CLEARLY intended as one.)
  {
    let res;
    A.notThrows(() => { res = parseV4APatch(['*** Begin Patch', ' some context', '-old', '+new', '*** End Patch'].join('\n')); }, 'malformed no-header: does not throw');
    A.ok(typeof res.error === 'string' && res.error.length > 0, 'malformed no-header: a clear error string is returned');
    A.ok(/file operation header/i.test(res.error), 'malformed no-header: error names the missing file-op header');
    A.eq(res.ops.length, 0, 'malformed no-header: NO file ops produced');
  }

  // (b) UPDATE with ZERO hunks → error, no ops
  {
    let res;
    A.notThrows(() => { res = parseV4APatch(['*** Begin Patch', '*** Update File: f.py', '*** End Patch'].join('\n')); }, 'malformed update-no-hunks: does not throw');
    A.ok(typeof res.error === 'string' && /no hunks/i.test(res.error), 'malformed update-no-hunks: error names the missing hunks');
    A.ok(res.error.indexOf('f.py') >= 0, 'malformed update-no-hunks: error names the file');
    A.eq(res.ops.length, 0, 'malformed update-no-hunks: NO file ops produced');
  }

  // (c) MOVE without `-> dst` → error, no ops
  {
    let res;
    A.notThrows(() => { res = parseV4APatch(['*** Begin Patch', '*** Move File: only/src.py', '*** End Patch'].join('\n')); }, 'malformed move-no-dst: does not throw');
    A.ok(typeof res.error === 'string' && res.error.length > 0, 'malformed move-no-dst: a clear error is returned');
    A.ok(/->|destination|dst/i.test(res.error), 'malformed move-no-dst: error mentions the missing destination');
    A.eq(res.ops.length, 0, 'malformed move-no-dst: NO file ops produced');
  }

  // garbage / non-string never throws
  {
    A.notThrows(() => parseV4APatch(null), 'parse(null) does not throw');
    A.notThrows(() => parseV4APatch(undefined), 'parse(undefined) does not throw');
    A.notThrows(() => parseV4APatch(12345), 'parse(number) does not throw');
    const r = parseV4APatch(null);
    A.eq(r.ops.length, 0, 'parse(null): zero ops');
  }

  // =====================================================================
  // PART 2 — fuzzyFindAndReplace (the strategy LADDER + guards)
  // =====================================================================

  // ---- empty / identical old_string guards ----
  {
    const r1 = ffr('abc', '', 'x');
    A.eq(r1.count, 0, 'empty old_string: 0 matches');
    A.ok(typeof r1.error === 'string', 'empty old_string: clear error');
    const r2 = ffr('abc', 'abc', 'abc');
    A.eq(r2.count, 0, 'identical old/new: 0 matches');
    A.ok(typeof r2.error === 'string', 'identical old/new: clear error');
  }

  // ---- STRATEGY LADDER: exact preferred ----
  {
    const content = 'line one\nline two\nline three';
    const r = ffr(content, 'line two', 'LINE TWO');
    A.eq(r.strategy, 'exact', 'ladder: exact match preferred when available');
    A.eq(r.count, 1, 'ladder: exact unique match count 1');
    A.eq(r.content, 'line one\nLINE TWO\nline three', 'ladder: exact replacement applied');
    A.eq(r.error, null, 'ladder: exact no error');
  }

  // ---- LADDER falls through deterministically: exact MISSES (whitespace differs), a fuzzier
  //      strategy catches it. The chosen strategy is NOT 'exact'. ----
  {
    // file uses trailing-space-free lines; the pattern has trailing whitespace per line →
    // exact misses, line_trimmed catches.
    const content = 'def f():\n    return 1';
    const pattern = 'def f():  \n    return 1  ';   // trailing spaces the file lacks
    const r = ffr(content, pattern, 'def f():\n    return 2');
    A.ok(r.count === 1, 'ladder fallthrough: a non-exact strategy matches when exact misses');
    A.ok(r.strategy && r.strategy !== 'exact', 'ladder fallthrough: the chosen strategy is a fuzzier one, not exact (strategy=' + r.strategy + ')');
  }

  // ---- WHITESPACE/FUZZY tolerance + REINDENT-on-non-exact (the core G5.1 case) ----
  // The file's `def` line is 4-space-indented with an 8-space body; the patch sends the SAME
  // block shifted shallower — `def` at 2-space with a 6-space body (same 4-space relative step).
  // A ladder strategy that ignores indentation matches; the WRITTEN replacement is re-indented
  // so its base anchors to the FILE's 4-space `def` indent (→ body back at 8-space), NOT the
  // patch's shallow 2-space base written verbatim. (Hermes _reindent_replacement: swap the base
  // indent prefix, preserve the LLM's relative nesting.)
  {
    const fileContent = [
      'class C:',
      '    def method(self):',
      '        x = 1',
      '        return x',
    ].join('\n');
    // patch sent 2 spaces shallower than the file at the base, same 4-space body step
    const oldStr = ['  def method(self):', '      x = 1', '      return x'].join('\n');
    const newStr = ['  def method(self):', '      x = 2', '      return x'].join('\n');
    const r = ffr(fileContent, oldStr, newStr);
    A.eq(r.count, 1, 'reindent: drifted-indent hunk matches via the ladder');
    A.ok(r.strategy !== 'exact', 'reindent: matched via a fuzzy (non-exact) strategy');
    // the written result must carry the FILE's indent (base anchored to the 4-space def → 8-space body)
    A.ok(r.content.indexOf('        x = 2') >= 0, 'reindent: replacement re-indented to the file\'s 8-space body indent');
    A.ok(/^    def method\(self\):$/m.test(r.content), 'reindent: the context line is re-indented to the file\'s 4-space base');
    A.ok(!/^  def method\(self\):$/m.test(r.content), 'reindent: the shallow 2-space patch base indent is NOT written verbatim');
    A.ok(!/^      x = 2$/m.test(r.content), 'reindent: the patch\'s 6-space body indent is NOT written verbatim');
    // surrounding structure preserved
    A.ok(/^class C:/m.test(r.content), 'reindent: untouched lines preserved');
  }

  // ---- UNIQUENESS guard: >1 match and replaceAll=false → error "provide more context" ----
  {
    const content = 'foo\nbar\nfoo\nbaz';
    const r = ffr(content, 'foo', 'QUX', false);
    A.eq(r.count, 0, 'uniqueness: ambiguous match yields 0 (no write)');
    A.ok(typeof r.error === 'string' && /more context|unique/i.test(r.error), 'uniqueness: error tells the model to provide more context');
    A.eq(r.content, content, 'uniqueness: content returned UNCHANGED on ambiguity');
  }

  // ---- replaceAll=true: the same ambiguous pattern replaces every occurrence ----
  {
    const content = 'foo\nbar\nfoo\nbaz';
    const r = ffr(content, 'foo', 'QUX', true);
    A.eq(r.count, 2, 'replaceAll: both occurrences replaced');
    A.eq(r.content, 'QUX\nbar\nQUX\nbaz', 'replaceAll: every occurrence rewritten');
  }

  // ---- no match at all → 0, content unchanged, clear error, never throws ----
  {
    let r;
    A.notThrows(() => { r = ffr('alpha\nbeta', 'this is not present anywhere', 'X'); }, 'no-match: never throws');
    A.eq(r.count, 0, 'no-match: 0 matches');
    A.ok(typeof r.error === 'string', 'no-match: clear error');
    A.eq(r.content, 'alpha\nbeta', 'no-match: content unchanged');
  }

  // ---- block_anchor: first+last line anchor a multi-line block whose middle drifts slightly ----
  {
    const content = [
      'function wrap() {',
      '  const a = compute(1);',
      '  return a;',
      '}',
    ].join('\n');
    // first + last lines match exactly; middle differs but is highly similar → block_anchor
    const pattern = [
      'function wrap() {',
      '  const a = compute(1)',   // missing semicolon — drift in the middle
      '  return a;',
      '}',
    ].join('\n');
    const replacement = [
      'function wrap() {',
      '  const a = compute(2);',
      '  return a;',
      '}',
    ].join('\n');
    const r = ffr(content, pattern, replacement);
    A.eq(r.count, 1, 'block_anchor: a multi-line block with a similar middle matches');
    A.ok(r.content.indexOf('compute(2)') >= 0, 'block_anchor: replacement applied');
  }

  A.report('fs.patch.test');
})();
