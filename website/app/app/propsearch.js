/* STARNET — propsearch.js : PURE prop-palette search matcher.

   The REFIT palette browses 120+ props through two TIERS and ~11 category tabs. That taxonomy is
   fine when you know which drawer a thing lives in and useless when you don't — "where is the
   MUG?" costs a tier guess plus a scan of every tab. This is the flat way in: type a word, get
   every prop that matches ACROSS both tiers and every category.

   Matching rules (deliberately boring — a palette filter must be predictable, not clever):
     - the query is TOKENIZED on whitespace and every token must match (AND, not OR), so
       "desk lamp" narrows rather than widening the way a raw substring search would;
     - a token matches anywhere in the prop's label, its id, its category id, or the category's
       DISPLAY label — so "lounge" finds the lounge shelf and "pixel" finds PIXEL RIG;
     - case-insensitive, order-independent ("lamp desk" == "desk lamp").

   Ranking: props whose LABEL starts with the first token float to the top; everything else holds
   catalog order (functional before cosmetic). Array#sort is stable, so equal keys never shuffle.

   Pure + headless-safe: no DOM, no clock, no state — a catalog and a string go in, a filtered
   array comes out. Loads under require() for the unit tests exactly like toolprops.js. */
'use strict';

const PropSearch = (() => {

  /* the query, reduced to lowercase whitespace-separated tokens ([] when there's nothing to search) */
  function tokens(q) {
    if (!q || typeof q !== 'string') return [];
    return q.toLowerCase().split(/\s+/).filter(Boolean);
  }

  /* is the user actually searching? the caller uses this to tell "browsing" from "no results",
     because an empty result set and an empty query need very different UI. */
  function active(q) { return tokens(q).length > 0; }

  /* everything about a prop a token is allowed to match, as one lowercase string */
  function haystack(c, catLabel) {
    if (!c) return '';
    const cat = c.cat || '';
    const shown = (typeof catLabel === 'function' ? (catLabel(cat) || '') : '');
    return (String(c.label || '') + ' ' + String(c.id || '') + ' ' + cat + ' ' + shown).toLowerCase();
  }

  /* catalog + query -> the matching entries, ranked. `catLabel` is OPTIONAL and is the caller's
     own cat-id -> display-name lookup (build.js owns CAT_LABEL; it is not duplicated here). */
  function matchProps(catalog, q, catLabel) {
    const toks = tokens(q);
    if (!toks.length || !catalog || !catalog.length) return [];
    const first = toks[0];
    const hit = [];
    for (const c of catalog) {
      const hay = haystack(c, catLabel);
      let all = true;
      for (const t of toks) { if (hay.indexOf(t) < 0) { all = false; break; } }
      if (all) hit.push(c);
    }
    // label-prefix matches first; stable sort keeps catalog order within each group
    return hit.sort((a, b) => {
      const ap = String(a.label || '').toLowerCase().indexOf(first) === 0 ? 0 : 1;
      const bp = String(b.label || '').toLowerCase().indexOf(first) === 0 ? 0 : 1;
      return ap - bp;
    });
  }

  return { tokens, active, haystack, matchProps };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PropSearch;
