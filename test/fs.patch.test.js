/* node test/fs.patch.test.js - fs.patch V4A parser + fuzzy atomic apply.
   Uses real temp files so rollback and jail behavior are proven against the
   same filesystem edge as the rest of fs.js. */
'use strict';
const A = require('./_assert.js');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { parsePatch } = require('../sidecar/tools/builtin/patchparse.js');
const { fuzzyFindAndReplace } = require('../sidecar/tools/builtin/fuzzymatch.js');

const ROOT = path.join(os.tmpdir(), 'starnet-fs-patch-' + process.pid);
const tools = makeFsTools({ fsp, pathMod: path, root: ROOT, limits: { writeBytes: 4096, readReturn: 4096 } });
const { writeTool, readTool, patchTool } = tools;
const ctx = { agentId: 'ag' };

async function rejects(promise, pattern, msg) {
  try {
    await promise;
    A.ok(false, msg + ' - did NOT reject');
  } catch (e) {
    A.ok(pattern.test((e && e.message) || String(e)), msg + ' - ' + ((e && e.message) || e));
  }
}
function patch(body) {
  return '*** Begin Patch\n' + body + '\n*** End Patch';
}

(async () => {
  // ---- parser-level malformed rejection ----
  {
    const noHeader = parsePatch('*** Begin Patch\n+loose line\n*** End Patch');
    A.ok(!noHeader.ok && /before a file operation|no file operation/.test(noHeader.error), 'parser rejects patch content without a file header');

    const zeroHunk = parsePatch(patch('*** Update File: a.txt'));
    A.ok(!zeroHunk.ok && /no hunks/.test(zeroHunk.error), 'parser rejects update with zero hunks');

    const badMove = parsePatch('*** Begin Patch\n*** Move File: a.txt\n*** End Patch');
    A.ok(!badMove.ok && /missing destination/.test(badMove.error), 'parser rejects move without destination');
  }

  // ---- add + multi-hunk update success ----
  {
    await patchTool.run({ patch: patch('*** Add File: multi.txt\n+alpha\n+beta\n+gamma') }, ctx);
    let r = await readTool.run({ path: 'multi.txt' }, ctx);
    A.eq(r.content, 'alpha\nbeta\ngamma', 'add file writes patch content');

    await patchTool.run({ patch: patch([
      '*** Update File: multi.txt',
      '@@ first @@',
      '-alpha',
      '+ALPHA',
      ' beta',
      '@@ second @@',
      ' beta',
      '-gamma',
      '+GAMMA'
    ].join('\n')) }, ctx);
    r = await readTool.run({ path: 'multi.txt' }, ctx);
    A.eq(r.content, 'ALPHA\nbeta\nGAMMA', 'multi-hunk update applies both hunks');
  }

  // ---- atomic rollback: first hunk matches, second fails, no write ----
  {
    await writeTool.run({ path: 'rollback.txt', content: 'one\ntwo\nthree' }, ctx);
    await rejects(patchTool.run({ patch: patch([
      '*** Update File: rollback.txt',
      '@@ h1 @@',
      '-one',
      '+ONE',
      '@@ h2 @@',
      '-missing',
      '+MISSING'
    ].join('\n')) }, ctx), /Could not find|UPDATE rollback/, 'failed second hunk rejects the whole patch');
    const after = await readTool.run({ path: 'rollback.txt' }, ctx);
    A.eq(after.content, 'one\ntwo\nthree', 'failed patch leaves file byte-identical');
  }

  // ---- jail: escaped path rejected before any in-jail file is touched ----
  {
    await writeTool.run({ path: 'safe.txt', content: 'safe' }, ctx);
    await rejects(patchTool.run({ patch: patch('*** Add File: ../escape.txt\n+pwn') }, ctx), /illegal path|escapes/, 'patch rejects escaped add path');
    A.eq((await readTool.run({ path: 'safe.txt' }, ctx)).content, 'safe', 'jail rejection did not touch existing file');
  }

  // ---- fuzzy whitespace/indent tolerance with file indentation preserved ----
  {
    await writeTool.run({ path: 'indent.js', content: 'function x() {\n    if (ready) {\n        return 1;\n    }\n}' }, ctx);
    await patchTool.run({ patch: patch([
      '*** Update File: indent.js',
      '@@ fuzzy indent @@',
      ' if (ready) {',
      '-  return 1;',
      '+  return 2;',
      ' }'
  ].join('\n')) }, ctx);
  const out = await readTool.run({ path: 'indent.js' }, ctx);
  const lines = out.content.split('\n');
  A.ok(lines.indexOf('        return 2;') >= 0, 'fuzzy match preserves the file indentation');
  A.ok(lines.indexOf('  return 2;') < 0, 'patch indentation was not written verbatim');
  }

  // ---- uniqueness guard: ambiguous fuzzy/exact matches fail with more-context hint ----
  {
    await writeTool.run({ path: 'ambiguous.txt', content: 'same\nx\nsame' }, ctx);
    await rejects(patchTool.run({ patch: patch('*** Update File: ambiguous.txt\n-same\n+other') }, ctx), /provide more context/i, 'ambiguous hunk asks for more context');
    A.eq((await readTool.run({ path: 'ambiguous.txt' }, ctx)).content, 'same\nx\nsame', 'ambiguous patch writes nothing');
  }

  // ---- move and delete stay inside the two-phase patch surface ----
  {
    await writeTool.run({ path: 'move-me.txt', content: 'moved' }, ctx);
    await patchTool.run({ patch: patch('*** Move File: move-me.txt -> moved.txt') }, ctx);
    A.eq((await readTool.run({ path: 'moved.txt' }, ctx)).content, 'moved', 'move writes destination content');
    await rejects(readTool.run({ path: 'move-me.txt' }, ctx), /no such file/, 'move removes source');

    await patchTool.run({ patch: patch('*** Delete File: moved.txt') }, ctx);
    await rejects(readTool.run({ path: 'moved.txt' }, ctx), /no such file/, 'delete removes file');
  }

  // ---- pure matcher sanity: non-exact ambiguity is not guessed ----
  {
    const res = fuzzyFindAndReplace('A\nA', ' A ', 'B');
    A.ok(!res.ok && /provide more context/.test(res.error), 'fuzzy matcher uniqueness guard is direct-testable');
  }

  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
  A.report('fs.patch.test');
})();
