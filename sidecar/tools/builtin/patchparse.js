/* sidecar/tools/builtin/patchparse.js — the V4A patch-format PARSER (G5.1).

   A pure, dependency-free port of Hermes' `parse_v4a_patch` (tools/patch_parser.py). It turns
   a V4A patch string into a STRUCTURED op list; it NEVER touches the filesystem and NEVER throws
   on malformed input — it returns `{ ops, error }` so the (G5.2) fs.patch tool can fail closed.

   V4A format:
     *** Begin Patch
     *** Update File: path/to/file.py
     @@ optional context hint @@
      context line (space prefix)
     -removed line (minus prefix)
     +added line (plus prefix)
     *** Add File: path/to/new.py
     +new file content
     *** Delete File: path/to/old.py
     *** Move File: old/path.py -> new/path.py
     *** End Patch

   Return shape:
     parseV4APatch(patchText) -> { ops: PatchOperation[], error: string|null }
       PatchOperation = { operation, filePath, newPath?, hunks: Hunk[] }
       Hunk           = { contextHint: string|null, lines: HunkLine[] }
       HunkLine       = { prefix: ' '|'-'|'+', content: string }   // 1-char prefix stripped
     On malformed input: { ops: [], error: 'Parse error: …' }. An EMPTY patch is NOT an error
     ([] with error:null) — callers decide. UMD-shaped like fs.js / web.js (no deps). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).patchparse = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Operation-type constants (mirror Hermes' OperationType enum).
  const OP = Object.freeze({ ADD: 'add', UPDATE: 'update', DELETE: 'delete', MOVE: 'move' });

  // The file-operation header matchers. `***` may be followed by optional whitespace; the verb
  // is whitespace-insensitive; MOVE requires a `-> dst`. Mirrors patch_parser.py:111-114.
  const RE_UPDATE = /^\*\*\*\s*Update\s+File:\s*(.+)$/;
  const RE_ADD = /^\*\*\*\s*Add\s+File:\s*(.+)$/;
  const RE_DELETE = /^\*\*\*\s*Delete\s+File:\s*(.+)$/;
  const RE_MOVE = /^\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*(.+)$/;
  // A `*** Move File:` header that LACKS the ` -> dst` arrow — recognized so it can be rejected
  // with a clear error rather than silently dropped (G5.1 acceptance: MOVE without dst → error).
  const RE_MOVE_HEADER = /^\*\*\*\s*Move\s+File:\s*(.+)$/;
  const RE_HINT = /^@@\s*(.+?)\s*@@/;

  function mkOp(operation, filePath, newPath) {
    return { operation, filePath, newPath: newPath || null, hunks: [] };
  }

  /* Parse a V4A-format patch. Pure; never throws. */
  function parseV4APatch(patchContent) {
    if (typeof patchContent !== 'string') patchContent = patchContent == null ? '' : String(patchContent);
    const lines = patchContent.split('\n');

    // Find patch boundaries (`*** Begin Patch` / `*** End Patch`). Both tolerate the no-space
    // `***Begin Patch` form (parity patch_parser.py:89-93). Begin is optional (some emitters drop it).
    let startIdx = null, endIdx = null;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (ln.indexOf('*** Begin Patch') >= 0 || ln.indexOf('***Begin Patch') >= 0) startIdx = i;
      else if (ln.indexOf('*** End Patch') >= 0 || ln.indexOf('***End Patch') >= 0) { endIdx = i; break; }
    }
    const hadBeginOrEnd = (startIdx !== null) || (endIdx !== null);   // markers present → clearly intended as a patch
    if (startIdx === null) startIdx = -1;             // parse without an explicit begin marker
    if (endIdx === null) endIdx = lines.length;

    const operations = [];
    const headerErrors = [];  // malformed file-op headers caught during the scan (e.g. MOVE without dst)
    let currentOp = null;     // PatchOperation being built
    let currentHunk = null;   // Hunk being built

    function flushHunkInto(op) { if (op && currentHunk && currentHunk.lines.length) op.hunks.push(currentHunk); }
    function flushOp() { if (currentOp) { flushHunkInto(currentOp); operations.push(currentOp); } }

    for (let i = startIdx + 1; i < endIdx; i++) {
      const line = lines[i];

      const mUpdate = RE_UPDATE.exec(line);
      const mAdd = RE_ADD.exec(line);
      const mDelete = RE_DELETE.exec(line);
      const mMove = RE_MOVE.exec(line);

      if (mUpdate) {
        flushOp();
        currentOp = mkOp(OP.UPDATE, mUpdate[1].trim());
        currentHunk = null;
      } else if (mAdd) {
        flushOp();
        currentOp = mkOp(OP.ADD, mAdd[1].trim());
        // ADD collects its + lines into a single hunk (parity: current_hunk = Hunk()).
        currentHunk = { contextHint: null, lines: [] };
      } else if (mDelete) {
        flushOp();
        // DELETE is self-contained — push immediately, no hunks.
        operations.push(mkOp(OP.DELETE, mDelete[1].trim()));
        currentOp = null;
        currentHunk = null;
      } else if (mMove) {
        flushOp();
        operations.push(mkOp(OP.MOVE, mMove[1].trim(), mMove[2].trim()));
        currentOp = null;
        currentHunk = null;
      } else if (RE_MOVE_HEADER.test(line)) {
        // A `*** Move File:` header that did NOT match RE_MOVE → it lacks the `-> dst` arrow.
        flushOp();
        const src = (RE_MOVE_HEADER.exec(line)[1] || '').trim();
        headerErrors.push('MOVE ' + JSON.stringify(src) + ": missing destination path (expected 'src -> dst')");
        currentOp = null;
        currentHunk = null;
      } else if (line.indexOf('@@') === 0) {
        // Context hint / hunk boundary — only meaningful inside an op.
        if (currentOp) {
          flushHunkInto(currentOp);
          const mHint = RE_HINT.exec(line);
          currentHunk = { contextHint: mHint ? mHint[1] : null, lines: [] };
        }
      } else if (currentOp && line) {
        // A hunk body line. (A blank line outside a + run is ignored, matching the Python
        // `elif current_op and line:` guard — only non-empty lines form hunk lines.)
        if (currentHunk === null) currentHunk = { contextHint: null, lines: [] };
        const c0 = line.charAt(0);
        if (c0 === '+') currentHunk.lines.push({ prefix: '+', content: line.slice(1) });
        else if (c0 === '-') currentHunk.lines.push({ prefix: '-', content: line.slice(1) });
        else if (c0 === ' ') currentHunk.lines.push({ prefix: ' ', content: line.slice(1) });
        else if (c0 === '\\') { /* "\ No newline at end of file" marker — skip */ }
        else currentHunk.lines.push({ prefix: ' ', content: line });   // implicit context line
      }
    }

    flushOp();

    // A malformed file-op header (e.g. MOVE without `-> dst`) is always an error, even if it
    // produced no op.
    if (headerErrors.length) return { ops: [], error: 'Parse error: ' + headerErrors.join('; ') };

    if (!operations.length) {
      // Markers present (clearly INTENDED as a patch) but no file-op header was found → malformed
      // (G5.1: a patch with no `*** Update File:`/etc header → clear error, no ops). A truly empty
      // string with NO markers is not an error — the caller decides (parity patch_parser.py:208-210).
      if (hadBeginOrEnd) return { ops: [], error: 'Parse error: patch contains no file operation header (expected one of *** Update/Add/Delete/Move File:)' };
      return { ops: operations, error: null };
    }

    // Validate the parsed result (parity patch_parser.py:212-222).
    const parseErrors = [];
    for (const op of operations) {
      if (!op.filePath) parseErrors.push('Operation with empty file path');
      if (op.operation === OP.UPDATE && !op.hunks.length) parseErrors.push('UPDATE ' + JSON.stringify(op.filePath) + ': no hunks found');
      if (op.operation === OP.MOVE && !op.newPath) parseErrors.push('MOVE ' + JSON.stringify(op.filePath) + ": missing destination path (expected 'src -> dst')");
    }
    if (parseErrors.length) return { ops: [], error: 'Parse error: ' + parseErrors.join('; ') };

    return { ops: operations, error: null };
  }

  return { parseV4APatch, OP };
});
