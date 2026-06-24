/* sidecar/tools/builtin/fuzzymatch.js — the fuzzy find-and-replace MATCHER (G5.1).

   A pure, dependency-free port of the conservative subset of Hermes' `fuzzy_find_and_replace`
   (tools/fuzzy_match.py). It robustly locates a block of text that may have whitespace /
   indentation drift from what the LLM sent, then rewrites it KEEPING THE FILE's indentation.

   The strategy LADDER (tried in order — exact preferred, falls through deterministically):
     1. exact                 — direct substring match
     2. line_trimmed          — strip leading/trailing whitespace per line
     3. whitespace_normalized — collapse runs of spaces/tabs to a single space
     4. indentation_flexible  — ignore leading indentation entirely
     5. block_anchor          — match first+last lines, similarity-gate the middle
                                (conservative thresholds: 0.50 unique / 0.70 multi-candidate)

   DEFERRED (noted parity gap — fail-closed is safer than silent corruption): the
   escape_normalized / unicode_normalized / trimmed_boundary / context_aware strategies and the
   escape-drift / control-char unescape salvage heuristics. They exist to rescue LLM
   serialization artifacts (smart quotes, `\t`/`\'` drift); writing such salvaged text risks
   silently corrupting source. We prefer to return a clear no-match error and let the model
   re-read and retry. (Easy to add later behind a flag.)

   Two guards from Hermes are KEPT:
     - UNIQUENESS guard: >1 match and replaceAll=false → error "provide more context" (no write).
     - REINDENT-on-non-exact: when a NON-exact strategy matched, the file's indentation may
       differ from the patch's; the replacement is re-indented to the file's actual indent
       before substitution (so a 2-space patch on a 4-space file writes 4-space code).

   Return shape (mirrors the Python 4-tuple as a named object):
     fuzzyFindAndReplace(content, oldString, newString, replaceAll=false)
       -> { content, count, strategy, error }
       success: { content: modified, count: N, strategy: 'exact'|…, error: null }
       failure: { content: original, count: 0, strategy: null, error: '…' }
   Pure; NEVER throws. UMD-shaped like fs.js (no deps; no clock/rng). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).fuzzymatch = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // =====================================================================
  // SequenceMatcher.ratio() — a faithful JS port of difflib's ratio (used by block_anchor to
  // gate the middle section). ratio = 2.0 * M / T where M = total matched chars across the
  // longest-matching-block recursion, T = len(a)+len(b). Deterministic, pure.
  // =====================================================================
  function findLongestMatch(a, b, alo, ahi, blo, bhi, b2j) {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = Object.create(null);
    for (let i = alo; i < ahi; i++) {
      const newj2len = Object.create(null);
      const positions = b2j[a[i]];
      if (positions) {
        for (let k = 0; k < positions.length; k++) {
          const j = positions[k];
          if (j < blo) continue;
          if (j >= bhi) break;
          const k2 = (j2len[j - 1] || 0) + 1;
          newj2len[j] = k2;
          if (k2 > bestsize) { besti = i - k2 + 1; bestj = j - k2 + 1; bestsize = k2; }
        }
      }
      j2len = newj2len;
    }
    return [besti, bestj, bestsize];
  }
  function matchBlocksCount(a, b) {
    // Build b2j: char -> sorted positions in b.
    const b2j = Object.create(null);
    for (let j = 0; j < b.length; j++) { const ch = b[j]; (b2j[ch] || (b2j[ch] = [])).push(j); }
    let matched = 0;
    const queue = [[0, a.length, 0, b.length]];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = findLongestMatch(a, b, alo, ahi, blo, bhi, b2j);
      if (k) {
        matched += k;
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    return matched;
  }
  function seqRatio(a, b) {
    const T = a.length + b.length;
    if (T === 0) return 1.0;
    return (2.0 * matchBlocksCount(a, b)) / T;
  }

  // =====================================================================
  // Helpers
  // =====================================================================
  function leadingWhitespace(line) {
    let i = 0;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    return line.slice(0, i);
  }
  function firstMeaningfulLine(text) {
    const parts = text.split('\n');
    for (const ln of parts) if (ln.trim() !== '') return ln;
    return null;
  }
  function rstrip(s) { return s.replace(/\s+$/, ''); }
  function lstrip(s) { return s.replace(/^[\s]+/, ''); }
  function strip(s) { return s.trim(); }

  // Re-indent newString so its indentation matches the file region (after a NON-exact match).
  // Replace the LLM's base indent prefix with the file's base indent prefix, preserving extra
  // nesting. Mirrors fuzzy_match.py:_reindent_replacement.
  function reindentReplacement(fileRegion, oldString, newString) {
    if (!newString) return newString;
    const oldFirst = firstMeaningfulLine(oldString);
    const fileFirst = firstMeaningfulLine(fileRegion);
    if (oldFirst === null || fileFirst === null) return newString;
    const oldIndent = leadingWhitespace(oldFirst);
    const fileIndent = leadingWhitespace(fileFirst);
    if (oldIndent === fileIndent) return newString;
    const out = [];
    for (const line of newString.split('\n')) {
      if (line.trim() === '') { out.push(line); continue; }   // blank lines untouched
      const lineIndent = leadingWhitespace(line);
      if (lineIndent.indexOf(oldIndent) === 0) {
        out.push(fileIndent + line.slice(oldIndent.length));   // swap base prefix, keep extra
      } else {
        out.push(fileIndent + lstrip(line));                    // dedent below base → anchor to file base
      }
    }
    return out.join('\n');
  }

  // Apply replacements at the given [start,end) positions. When oldString is non-null the match
  // came from a non-exact strategy → reindent each replacement to the file's actual indent.
  function applyReplacements(content, matches, newString, oldString) {
    const sorted = matches.slice().sort((x, y) => y[0] - x[0]);   // end→start so offsets hold
    let result = content;
    for (const [start, end] of sorted) {
      const adjusted = (oldString != null) ? reindentReplacement(content.slice(start, end), oldString, newString) : newString;
      result = result.slice(0, start) + adjusted + result.slice(end);
    }
    return result;
  }

  // Compute [start,end) char positions from line indices (lines split WITHOUT newlines).
  function calcLinePositions(contentLines, startLine, endLine, contentLength) {
    let startPos = 0;
    for (let i = 0; i < startLine; i++) startPos += contentLines[i].length + 1;
    let endPos = 0;
    for (let i = 0; i < endLine; i++) endPos += contentLines[i].length + 1;
    endPos -= 1;
    return [startPos, Math.min(contentLength, endPos)];
  }

  // =====================================================================
  // Matching strategies — each returns an array of [start,end) match ranges.
  // =====================================================================

  function strategyExact(content, pattern) {
    const matches = [];
    let start = 0;
    while (true) {
      const pos = content.indexOf(pattern, start);
      if (pos === -1) break;
      matches.push([pos, pos + pattern.length]);
      start = pos + 1;
    }
    return matches;
  }

  // Find a block of `numPatternLines` whose per-line NORMALIZED form equals the normalized
  // pattern, then map back to original char offsets. Shared by line_trimmed / indentation_flexible.
  function findNormalizedMatches(content, contentLines, contentNormLines, patternNormalized) {
    const patternNormLines = patternNormalized.split('\n');
    const n = patternNormLines.length;
    const matches = [];
    for (let i = 0; i + n <= contentNormLines.length; i++) {
      const block = contentNormLines.slice(i, i + n).join('\n');
      if (block === patternNormalized) matches.push(calcLinePositions(contentLines, i, i + n, content.length));
    }
    return matches;
  }

  function strategyLineTrimmed(content, pattern) {
    const patternNormalized = pattern.split('\n').map(strip).join('\n');
    const contentLines = content.split('\n');
    const contentNormLines = contentLines.map(strip);
    return findNormalizedMatches(content, contentLines, contentNormLines, patternNormalized);
  }

  function strategyIndentationFlexible(content, pattern) {
    const contentLines = content.split('\n');
    const contentStripped = contentLines.map(lstrip);
    const patternStripped = pattern.split('\n').map(lstrip).join('\n');
    return findNormalizedMatches(content, contentLines, contentStripped, patternStripped);
  }

  // Whitespace-normalized: collapse [ \t]+ → ' ' (newlines preserved), match in normalized
  // space, map positions back to original via a per-char index map.
  function collapseWs(s) { return s.replace(/[ \t]+/g, ' '); }
  function strategyWhitespaceNormalized(content, pattern) {
    const patternNorm = collapseWs(pattern);
    const contentNorm = collapseWs(content);
    const normMatches = strategyExact(contentNorm, patternNorm);
    if (!normMatches.length) return [];
    return mapNormalizedPositions(content, contentNorm, normMatches);
  }
  // Best-effort map normalized→original positions for whitespace collapse (parity
  // fuzzy_match.py:_map_normalized_positions).
  function mapNormalizedPositions(original, normalized, normMatches) {
    const origToNorm = [];
    let oi = 0, ni = 0;
    while (oi < original.length && ni < normalized.length) {
      if (original[oi] === normalized[ni]) { origToNorm.push(ni); oi++; ni++; }
      else if ((original[oi] === ' ' || original[oi] === '\t') && normalized[ni] === ' ') {
        origToNorm.push(ni); oi++;
        if (oi < original.length && original[oi] !== ' ' && original[oi] !== '\t') ni++;
      } else if (original[oi] === ' ' || original[oi] === '\t') { origToNorm.push(ni); oi++; }
      else { origToNorm.push(ni); oi++; }
    }
    while (oi < original.length) { origToNorm.push(normalized.length); oi++; }
    const normToOrigStart = Object.create(null), normToOrigEnd = Object.create(null);
    for (let op = 0; op < origToNorm.length; op++) {
      const np = origToNorm[op];
      if (!(np in normToOrigStart)) normToOrigStart[np] = op;
      normToOrigEnd[np] = op;
    }
    const out = [];
    for (const [ns, ne] of normMatches) {
      let origStart;
      if (ns in normToOrigStart) origStart = normToOrigStart[ns];
      else { origStart = origToNorm.findIndex(n => n >= ns); if (origStart < 0) continue; }
      let origEnd;
      if ((ne - 1) in normToOrigEnd) origEnd = normToOrigEnd[ne - 1] + 1;
      else origEnd = origStart + (ne - ns);
      while (origEnd < original.length && (original[origEnd] === ' ' || original[origEnd] === '\t')) origEnd++;
      out.push([origStart, Math.min(origEnd, original.length)]);
    }
    return out;
  }

  // Block-anchor: anchor on the first + last lines, gate the middle by similarity. Conservative
  // thresholds (0.50 unique / 0.70 multi) — parity fuzzy_match.py:_strategy_block_anchor.
  function strategyBlockAnchor(content, pattern) {
    const patternLines = pattern.split('\n');
    if (patternLines.length < 2) return [];
    const firstLine = strip(patternLines[0]);
    const lastLine = strip(patternLines[patternLines.length - 1]);
    const contentLines = content.split('\n');
    const n = patternLines.length;

    const potential = [];
    for (let i = 0; i + n <= contentLines.length; i++) {
      if (strip(contentLines[i]) === firstLine && strip(contentLines[i + n - 1]) === lastLine) potential.push(i);
    }
    const threshold = potential.length === 1 ? 0.50 : 0.70;
    const matches = [];
    for (const i of potential) {
      let similarity;
      if (n <= 2) similarity = 1.0;
      else {
        const contentMiddle = contentLines.slice(i + 1, i + n - 1).join('\n');
        const patternMiddle = patternLines.slice(1, -1).join('\n');
        similarity = seqRatio(contentMiddle, patternMiddle);
      }
      if (similarity >= threshold) matches.push(calcLinePositions(contentLines, i, i + n, content.length));
    }
    return matches;
  }

  // =====================================================================
  // The ladder
  // =====================================================================
  const STRATEGIES = [
    ['exact', strategyExact],
    ['line_trimmed', strategyLineTrimmed],
    ['whitespace_normalized', strategyWhitespaceNormalized],
    ['indentation_flexible', strategyIndentationFlexible],
    ['block_anchor', strategyBlockAnchor],
  ];

  function fuzzyFindAndReplace(content, oldString, newString, replaceAll) {
    content = content == null ? '' : String(content);
    oldString = oldString == null ? '' : String(oldString);
    newString = newString == null ? '' : String(newString);
    replaceAll = !!replaceAll;

    if (!oldString) return { content, count: 0, strategy: null, error: 'old_string cannot be empty' };
    if (oldString === newString) return { content, count: 0, strategy: null, error: 'old_string and new_string are identical' };

    for (const [name, fn] of STRATEGIES) {
      let matches;
      try { matches = fn(content, oldString); } catch (_) { matches = []; }   // a strategy never crashes the ladder
      if (matches && matches.length) {
        if (matches.length > 1 && !replaceAll) {
          return {
            content, count: 0, strategy: null,
            error: 'Found ' + matches.length + ' matches for old_string. Provide more context to make it unique, or use replace_all=True.',
          };
        }
        // REINDENT-on-non-exact: signal applyReplacements to re-indent by passing oldString.
        const newContent = applyReplacements(content, matches, newString, name !== 'exact' ? oldString : null);
        return { content: newContent, count: matches.length, strategy: name, error: null };
      }
    }
    return { content, count: 0, strategy: null, error: 'Could not find a match for old_string in the file' };
  }

  return { fuzzyFindAndReplace, _internals: { seqRatio, reindentReplacement, STRATEGIES: STRATEGIES.map(s => s[0]) } };
});
