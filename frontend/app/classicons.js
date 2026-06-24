/* STARNET — classicons.js : the CLASS SEAL system for the Recruitment Bay.

   A class is identified by an engraved emblem (a "challenge-coin" seal), NEVER by a character
   skin — the skin is the Commander's own choice at summon. This module is the single source for:
     • the bespoke vector emblem per built-in specialty (currentColor SVG, themes to the accent),
     • the 3-letter class code stamped on the coin,
     • the focus LANE a spec reads as (code / research / ops) from its ranking tags,
     • the model tier rendered as gold CLEARANCE pips (◆◆◆ reasoning / ◆◆ balanced / ◆ fast).

   Pure + DOM-free so it unit-tests under node and is reused anywhere a class is shown. The emblems
   are matte (debossed, not glowing) to sit inside the phosphor-CRT chrome. Customs (no bespoke art)
   fall back to their chosen emoji + a derived code. UMD-light: a `ClassIcons` global / node export. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.ClassIcons = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const D = '#0c0704';   // the coin's recessed-floor colour — cut detail in an emblem is "carved" in this

  // bespoke emblems, keyed by built-in specialty id. fill="currentColor" so each rides its class accent.
  const ICONS = {
    chief: '<svg viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M12 1.6 L14.3 9.7 L22.4 12 L14.3 14.3 L12 22.4 L9.7 14.3 L1.6 12 L9.7 9.7 Z M12 8.6 L10.4 12 L12 15.4 L13.6 12 Z"/></svg>',
    engineer: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.8 4.6 L10.3 6.4 L5.5 12 L10.3 17.6 L7.8 19.4 L1.8 12 Z"/><path d="M16.2 4.6 L22.2 12 L16.2 19.4 L13.7 17.6 L18.5 12 L13.7 6.4 Z"/><path d="M14 3.6 L16.1 4.6 L10 20.4 L7.9 19.4 Z"/></svg>',
    researcher: '<svg viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M10.5 2.5 a8 8 0 1 0 0 16 a8 8 0 1 0 0 -16 Z M10.5 5.8 a4.7 4.7 0 1 1 0 9.4 a4.7 4.7 0 1 1 0 -9.4 Z"/><path fill="currentColor" d="M16 14.2 L22 20.2 L20.2 22 L14.2 16 Z"/></svg>',
    reviewer: '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9.6 6.4 L7.4 4.2"/><path d="M14.4 6.4 L16.6 4.2"/><path d="M7.4 12 H3.6"/><path d="M16.6 12 H20.4"/><path d="M7.6 16 H4.4"/><path d="M16.4 16 H19.6"/></g><ellipse cx="12" cy="13.4" rx="4.9" ry="6" fill="currentColor"/><circle cx="12" cy="7.3" r="2.5" fill="currentColor"/><path d="M12 8.6 V18.4" stroke="' + D + '" stroke-width="1.4"/></svg>',
    operator: '<svg viewBox="0 0 24 24"><g fill="currentColor"><rect x="10.9" y="1.8" width="2.2" height="4.3" rx=".4"/><rect x="10.9" y="1.8" width="2.2" height="4.3" rx=".4" transform="rotate(45 12 12)"/><rect x="10.9" y="1.8" width="2.2" height="4.3" rx=".4" transform="rotate(90 12 12)"/><rect x="10.9" y="1.8" width="2.2" height="4.3" rx=".4" transform="rotate(135 12 12)"/><rect x="10.9" y="1.8" width="2.2" height="4.3" rx=".4" transform="rotate(180 12 12)"/><rect x="10.9" y="1.8" width="2.2" height="4.3" rx=".4" transform="rotate(225 12 12)"/><rect x="10.9" y="1.8" width="2.2" height="4.3" rx=".4" transform="rotate(270 12 12)"/><rect x="10.9" y="1.8" width="2.2" height="4.3" rx=".4" transform="rotate(315 12 12)"/><circle cx="12" cy="12" r="6.6"/></g><circle cx="12" cy="12" r="3.5" fill="' + D + '"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>',
    scribe: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 21 l1.3-4.2 L16.5 4.6 l2.9 2.9 L7.2 19.7 Z"/><path fill="' + D + '" d="M4.6 18.4 l1 1 -1.8.6 Z"/><path fill="currentColor" d="M17.6 3.5 l1.4-1.4 a1.6 1.6 0 0 1 2.3 0 l.6.6 a1.6 1.6 0 0 1 0 2.3 l-1.4 1.4 Z"/></svg>',
    analyst: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.5 19.4 H20.5 V21.4 H3.5 Z"/><rect x="5.4" y="12" width="3.5" height="7.4" rx=".6"/><rect x="10.3" y="6.4" width="3.5" height="13" rx=".6"/><rect x="15.2" y="9.4" width="3.5" height="10" rx=".6"/></svg>',
    scout: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 4.6 C5.6 4.6 2 11 2 12 C2 13 5.6 19.4 12 19.4 C18.4 19.4 22 13 22 12 C22 11 18.4 4.6 12 4.6 Z"/><circle cx="12" cy="12" r="4.4" fill="' + D + '"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>',
    archivist: '<svg viewBox="0 0 24 24"><rect x="4" y="3.5" width="16" height="17" rx="2" fill="currentColor"/><g fill="' + D + '"><rect x="6" y="5.6" width="12" height="3.1" rx=".6"/><rect x="6" y="10.4" width="12" height="3.1" rx=".6"/><rect x="6" y="15.3" width="12" height="3.1" rx=".6"/></g><g fill="currentColor"><rect x="10.5" y="6.6" width="3" height="1.1" rx=".5"/><rect x="10.5" y="11.4" width="3" height="1.1" rx=".5"/><rect x="10.5" y="16.3" width="3" height="1.1" rx=".5"/></g></svg>',
    designer: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="11" height="11" rx="1.6" fill="currentColor"/><circle cx="15.5" cy="15.5" r="5.7" fill="none" stroke="currentColor" stroke-width="3"/></svg>',
    liaison: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="2.2" fill="currentColor"/><path fill="' + D + '" d="M4.6 7.4 L12 12.9 L19.4 7.4 L19.4 8.9 L12 14.4 L4.6 8.9 Z"/></svg>',
  };

  const CODE = {
    chief: 'CHF', engineer: 'ENG', researcher: 'RES', reviewer: 'REV', operator: 'OPR',
    scribe: 'SCR', analyst: 'ANL', scout: 'SCT', archivist: 'ARV', designer: 'DSN', liaison: 'LIA'
  };

  const LANE_LABEL = { code: 'CODE', research: 'RESEARCH', general: 'OPS' };
  const TIER_PIPS = { reasoning: 3, balanced: 2, fast: 1 };
  const TIER_LABEL = { reasoning: 'DEEP REASONING', balanced: 'BALANCED', fast: 'FAST & CHEAP' };

  // the bespoke emblem for a spec id, or null when there's no built-in art (a custom → caller draws its emoji).
  function svg(idOrSpec) {
    const id = typeof idOrSpec === 'string' ? idOrSpec : (idOrSpec && idOrSpec.id);
    return ICONS[id] || null;
  }
  // a stamped 3-letter class code: the canon code for built-ins, else derived from the spec name.
  function code(idOrSpec) {
    const id = typeof idOrSpec === 'string' ? idOrSpec : (idOrSpec && idOrSpec.id);
    if (CODE[id]) return CODE[id];
    const name = (typeof idOrSpec === 'object' && idOrSpec && idOrSpec.name) || String(id || '');
    const letters = name.replace(/[^a-z0-9]/gi, '').toUpperCase();
    return (letters.slice(0, 3) || 'CLS').padEnd(3, '·');
  }
  // the dominant focus lane a spec ranks in — the single tag with the most weight (ties → code>research>general).
  function lane(spec) {
    const t = (spec && spec.tags) || {};
    const order = ['code', 'research', 'general'];
    let best = 'general', bestV = -1;
    for (const k of order) { const v = Number(t[k]) || 0; if (v > bestV) { bestV = v; best = k; } }
    return best;
  }
  function laneLabel(spec) { return LANE_LABEL[lane(spec)] || 'OPS'; }
  // model-tier → clearance: filled gold diamonds out of three. Returns {n,label} so callers render to taste.
  function clearance(model) {
    const n = TIER_PIPS[model] || 2;
    return { n, label: TIER_LABEL[model] || TIER_LABEL.balanced };
  }
  // ready-to-inject pip markup: <b>◆</b> for filled (gold via css), ◇ for empty.
  function pipsHTML(model) {
    const n = (TIER_PIPS[model] || 2);
    return '<span class="mkt-pips">' + '<b>◆</b>'.repeat(n) + '◇'.repeat(3 - n) + '</span>';
  }

  return { ICONS, CODE, LANE_LABEL, svg, code, lane, laneLabel, clearance, pipsHTML };
});
