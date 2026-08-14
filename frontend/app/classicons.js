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
    analyst: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.5 19.4 H20.5 V21.4 H3.5 Z"/><rect x="5.4" y="12" width="3.5" height="7.4" rx=".6"/><rect x="10.3" y="6.4" width="3.5" height="13" rx=".6"/><rect x="15.2" y="9.4" width="3.5" height="10" rx=".6"/></svg>',
    scout: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 4.6 C5.6 4.6 2 11 2 12 C2 13 5.6 19.4 12 19.4 C18.4 19.4 22 13 22 12 C22 11 18.4 4.6 12 4.6 Z"/><circle cx="12" cy="12" r="4.4" fill="' + D + '"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>',
    archivist: '<svg viewBox="0 0 24 24"><rect x="4" y="3.5" width="16" height="17" rx="2" fill="currentColor"/><g fill="' + D + '"><rect x="6" y="5.6" width="12" height="3.1" rx=".6"/><rect x="6" y="10.4" width="12" height="3.1" rx=".6"/><rect x="6" y="15.3" width="12" height="3.1" rx=".6"/></g><g fill="currentColor"><rect x="10.5" y="6.6" width="3" height="1.1" rx=".5"/><rect x="10.5" y="11.4" width="3" height="1.1" rx=".5"/><rect x="10.5" y="16.3" width="3" height="1.1" rx=".5"/></g></svg>',
    designer: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="11" height="11" rx="1.6" fill="currentColor"/><circle cx="15.5" cy="15.5" r="5.7" fill="none" stroke="currentColor" stroke-width="3"/></svg>',
    // envoy: the envelope (inherited from the retired liaison — same job, wider desk).
    envoy: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="2.2" fill="currentColor"/><path fill="' + D + '" d="M4.6 7.4 L12 12.9 L19.4 7.4 L19.4 8.9 L12 14.4 L4.6 8.9 Z"/></svg>',
    // ---- recuration new class seals (2026-07-14, same engraved-coin style) ----
    // navigator: a compass rose carved into a coin — plotting the route.
    navigator: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.8" fill="currentColor"/><path fill="' + D + '" d="M12 3.8 L13.8 10.2 L20.2 12 L13.8 13.8 L12 20.2 L10.2 13.8 L3.8 12 L10.2 10.2 Z"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/></svg>',
    // curator: a folder with sorted (descending) rules — order imposed on the pile.
    curator: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M2.6 4.6 h6.4 l1.8 2.4 h10.6 v12.4 a1.6 1.6 0 0 1 -1.6 1.6 H4.2 a1.6 1.6 0 0 1 -1.6 -1.6 Z"/><g fill="' + D + '"><rect x="6" y="10.6" width="12" height="1.8" rx=".5"/><rect x="6" y="13.8" width="9" height="1.8" rx=".5"/><rect x="6" y="17" width="6" height="1.8" rx=".5"/></g></svg>',
    // muse: a lightbulb with a carved filament spark — the idea landing.
    muse: '<svg viewBox="0 0 24 24"><circle cx="12" cy="9.4" r="6.6" fill="currentColor"/><path fill="currentColor" d="M9.2 14.6 h5.6 v3.6 a1.4 1.4 0 0 1 -1.4 1.4 h-2.8 a1.4 1.4 0 0 1 -1.4 -1.4 Z"/><g fill="none" stroke="' + D + '" stroke-width="1.5" stroke-linecap="round"><path d="M9.6 16.8 H14.4"/><path d="M9.9 8.6 L12 10.8 L14.1 8.6"/><path d="M12 10.8 V13.2"/></g></svg>',
    // ---- S2 new class seals (same matte/debossed engraved-coin style, currentColor) ----
    // broker: a scale/balance — weighing the deal.
    broker: '<svg viewBox="0 0 24 24"><g fill="currentColor"><rect x="11" y="3.4" width="2" height="15.4" rx=".5"/><rect x="6" y="18.6" width="12" height="2" rx=".8"/><path d="M4 6.6 H20 V8 H4 Z"/></g><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7.3 L1.8 12.4"/><path d="M4 7.3 L6.2 12.4"/><path d="M20 7.3 L17.8 12.4"/><path d="M20 7.3 L22.2 12.4"/></g><path fill="' + D + '" d="M1.8 12.4 A2.6 2.6 0 0 0 6.2 12.4 Z"/><path fill="' + D + '" d="M17.8 12.4 A2.6 2.6 0 0 0 22.2 12.4 Z"/></svg>',
    // marketer: the megaphone (inherited from the retired publicist — the campaign broadcast).
    marketer: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 9.5 L11 9.5 L18.5 4.5 V19.5 L11 14.5 L3 14.5 Z"/><rect x="4.4" y="14.5" width="3.4" height="5.4" rx=".8" fill="currentColor"/><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20.6 8 L22.4 6.8"/><path d="M20.9 12 H23"/><path d="M20.6 16 L22.4 17.2"/></g></svg>',
    // tutor: an open book with a rising spark — teaching.
    tutor: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M2.6 6 C5.4 4.6 8.6 4.6 11 6 V19 C8.6 17.6 5.4 17.6 2.6 19 Z"/><path fill="currentColor" d="M21.4 6 C18.6 4.6 15.4 4.6 13 6 V19 C15.4 17.6 18.6 17.6 21.4 19 Z"/><path fill="' + D + '" d="M11.2 6.2 H12.8 V18.8 H11.2 Z"/><path fill="currentColor" d="M12 1.4 L13 3.6 L15.2 4.6 L13 5.6 L12 7.8 L11 5.6 L8.8 4.6 L11 3.6 Z"/></svg>',
    // auditor: a shield with a magnifier — the security sweep.
    auditor: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2 L20 5 V11 C20 16 16.5 19.4 12 21.4 C7.5 19.4 4 16 4 11 V5 Z"/><circle cx="10.6" cy="10.4" r="3.3" fill="none" stroke="' + D + '" stroke-width="1.8"/><path d="M13 12.8 L16 15.8" stroke="' + D + '" stroke-width="2.1" stroke-linecap="round"/></svg>',
    // treasurer: the ledger book with ruled lines and a balance mark (inherited from the retired bookkeeper).
    treasurer: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="15" height="18" rx="1.6" fill="currentColor"/><rect x="4" y="3" width="3" height="18" fill="' + D + '"/><g fill="none" stroke="' + D + '" stroke-width="1.5" stroke-linecap="round"><path d="M9.4 7.4 H16"/><path d="M9.4 10.6 H16"/><path d="M9.4 13.8 H16"/></g><path fill="' + D + '" d="M9.2 16.4 L11 18.2 L15.4 15 L16.4 16 L11 20 L8.2 17.4 Z"/></svg>',
    // ---- 2026-07-16 business-roster seals (same matte engraved-coin style, currentColor + deboss only) ----
    // opportunist: the cut gem half-buried in ground — value spotted where others walked past.
    opportunist: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 3.4 H17 L21.4 8.6 L12 20.6 L2.6 8.6 Z"/><g fill="none" stroke="' + D + '" stroke-width="1.5" stroke-linejoin="round"><path d="M2.6 8.6 H21.4"/><path d="M7 3.4 L9.6 8.6 L12 20.6"/><path d="M17 3.4 L14.4 8.6 L12 20.6"/></g></svg>',
    // strategist: an arrow striking the target's center — the chosen direction, committed.
    strategist: '<svg viewBox="0 0 24 24"><circle cx="13.4" cy="10.6" r="8.4" fill="currentColor"/><circle cx="13.4" cy="10.6" r="5" fill="' + D + '"/><circle cx="13.4" cy="10.6" r="1.9" fill="currentColor"/><path fill="currentColor" d="M2 22 L11.9 12.1 L13.4 13.6 L3.5 23.5 Z"/><path fill="currentColor" d="M2 17.4 L2 22 L6.6 22 L4.9 20.3 L6.4 18.8 L3.5 18.9 Z"/></svg>',
    // publisher: the calendar grid with one slot lit — the piece scheduled to ship.
    publisher: '<svg viewBox="0 0 24 24"><rect x="3" y="4.4" width="18" height="17" rx="1.8" fill="currentColor"/><rect x="5" y="9.2" width="14" height="10.2" fill="' + D + '"/><g fill="currentColor"><rect x="6.6" y="2" width="2.2" height="4.4" rx=".8"/><rect x="15.2" y="2" width="2.2" height="4.4" rx=".8"/><rect x="6.4" y="10.7" width="3.4" height="3.2" rx=".4"/><rect x="10.6" y="10.7" width="3.4" height="3.2" rx=".4"/><rect x="10.6" y="15" width="3.4" height="3.2" rx=".4"/><rect x="14.8" y="10.7" width="3.4" height="3.2" rx=".4"/></g></svg>',
    // producer: the clapperboard — the shoot, ready to roll.
    producer: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M2.6 9.2 L20.2 4 L21.4 8 L3.8 13.2 Z"/><rect x="2.6" y="10.4" width="18.8" height="10.6" rx="1.4" fill="currentColor"/><g fill="' + D + '"><path d="M6.2 8.2 L9.4 7.2 L11.2 9.4 L8 10.4 Z"/><path d="M12.6 6.3 L15.8 5.3 L17.6 7.5 L14.4 8.5 Z"/><path d="M9.6 13.4 L15.6 16 L9.6 18.6 Z"/></g></svg>',
    // writer: the script page, beat lines marked with the play cue.
    writer: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M5 2.6 H15.4 L19.6 6.8 V21.4 H5 Z"/><path fill="' + D + '" d="M15.4 2.6 L19.6 6.8 H15.4 Z"/><g fill="none" stroke="' + D + '" stroke-width="1.5" stroke-linecap="round"><path d="M7.6 9.4 H16.8"/><path d="M7.6 12.4 H16.8"/><path d="M7.6 15.4 H12.4"/></g><path fill="' + D + '" d="M14.4 14.2 L17.8 16.2 L14.4 18.2 Z"/></svg>',
    // prospector: the funnel — the wide field narrowed to the qualified few.
    prospector: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M2.6 3.6 H21.4 L14.6 12.2 V19.4 L9.4 22.4 V12.2 Z"/><g fill="none" stroke="' + D + '" stroke-width="1.5" stroke-linecap="round"><path d="M6.2 6.4 H17.8"/><path d="M8.8 9.2 H15.2"/></g></svg>',
    // closer: the contract signed and sealed — the deal done.
    closer: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 2.6 H16.2 L20 6.4 V21.4 H4 Z"/><g fill="none" stroke="' + D + '" stroke-width="1.5" stroke-linecap="round"><path d="M6.6 8 H17"/><path d="M6.6 11 H17"/><path d="M6.6 14 H11.4"/></g><circle cx="15.4" cy="16.6" r="4.2" fill="' + D + '"/><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M13.4 16.6 L14.9 18.1 L17.5 15.3"/></svg>',
    // steward: two speech bubbles in conversation — the tended community.
    steward: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M2.6 3.6 H15 a1.8 1.8 0 0 1 1.8 1.8 V11 a1.8 1.8 0 0 1 -1.8 1.8 H8.4 L4.6 16 v-3.2 H4.4 a1.8 1.8 0 0 1 -1.8 -1.8 Z"/><path fill="currentColor" d="M9.8 14.8 H19.6 a1.8 1.8 0 0 1 1.8 1.8 v3 a1.8 1.8 0 0 1 -1.8 1.8 h-2 v2.2 L14.6 21.4 H9.8 Z"/><g fill="none" stroke="' + D + '" stroke-width="1.5" stroke-linecap="round"><path d="M5.4 6.6 H13.6"/><path d="M5.4 9.4 H11"/></g></svg>',
    // optimizer: the magnifier over rising bars — found, and climbing.
    optimizer: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="8" fill="currentColor"/><path fill="currentColor" d="M16 14.2 L22 20.2 L20.2 22 L14.2 16 Z"/><g fill="' + D + '"><rect x="6.2" y="10.4" width="2.2" height="4" rx=".4"/><rect x="9.4" y="8.4" width="2.2" height="6" rx=".4"/><rect x="12.6" y="6.2" width="2.2" height="8.2" rx=".4"/></g></svg>',
    // translator: two-way arrows over two script marks — swapping languages. The glyphs are stroke PATHS (a Latin
    // "A" top-left, an abstract CJK mark bottom-right), not <text> — <text> was the only seal that rendered with a
    // system font, so it scaled + themed inconsistently against the other engraved paths.
    translator: '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11 L5.5 3.6 L8 11 M3.9 8.6 H7.1"/><path d="M16 13.2 L18 14 M13.8 15.6 H20.2 M18 16 L14.2 21.4 M15.8 17.4 L20.2 21.4"/></g><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5 H21 M18 2.4 L21 5 L18 7.6"/><path d="M11 19 H3 M6 16.4 L3 19 L6 21.6"/></g></svg>',
    // ---- 2026-08-03 catalog expansion seals (same matte engraved-coin style: currentColor + deboss only) ----
    // pilot: the ship's helm — hands actually on the controls of a live site.
    pilot: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.4" fill="currentColor"/><circle cx="12" cy="12" r="6.2" fill="' + D + '"/><g fill="currentColor"><rect x="11" y="2.2" width="2" height="19.6" rx=".6"/><rect x="2.2" y="11" width="19.6" height="2" rx=".6"/><circle cx="12" cy="12" r="2.6"/></g></svg>',
    // foreman: one line splitting into three parallel bars — the job cut into pieces that run at once.
    foreman: '<svg viewBox="0 0 24 24"><g fill="currentColor"><rect x="2.2" y="10.6" width="7" height="2.8" rx=".6"/><rect x="14.4" y="3.2" width="7.4" height="2.8" rx=".6"/><rect x="14.4" y="10.6" width="7.4" height="2.8" rx=".6"/><rect x="14.4" y="18" width="7.4" height="2.8" rx=".6"/></g><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.4 12 H12.4 V4.6 H14.4"/><path d="M12.4 12 H14.4"/><path d="M10.4 12 H12.4 V19.4 H14.4"/></g></svg>',
    // nightwatch: the crescent with a lit watch-eye — someone is awake while the station sleeps.
    nightwatch: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M20.6 15.8 A9.6 9.6 0 1 1 11 3 A7.5 7.5 0 0 0 20.6 15.8 Z"/><circle cx="18.2" cy="5.2" r="1.7" fill="currentColor"/><ellipse cx="8.4" cy="11.2" rx="2.5" ry="1.6" fill="' + D + '"/><circle cx="8.4" cy="11.2" r="0.9" fill="currentColor"/></svg>',
    // ghostwriter: the nib with a hollow shaft — the writer who is not there.
    ghostwriter: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M2.8 21.2 L4.6 15.2 L16.4 3.4 L20.6 7.6 L8.8 19.4 Z"/><path fill="' + D + '" d="M6.2 16.4 L7.8 18 L5.4 18.8 Z"/><path fill="' + D + '" d="M14.6 7 L17 9.4 L9.6 16.8 L7.2 14.4 Z"/><circle cx="19" cy="18.8" r="2.8" fill="currentColor"/><circle cx="19" cy="18.8" r="1.2" fill="' + D + '"/></svg>',
    // paralegal: the page with ONE clause struck out of the deboss — the line that will bite you.
    paralegal: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4.4 2.6 H15 L19.6 7.2 V21.4 H4.4 Z"/><path fill="' + D + '" d="M15 2.6 L19.6 7.2 H15 Z"/><g fill="none" stroke="' + D + '" stroke-width="1.4" stroke-linecap="round"><path d="M7 10.2 H17"/><path d="M7 17 H14.6"/><path d="M7 19.4 H11.4"/></g><rect x="6.2" y="12.4" width="11.6" height="2.8" rx=".5" fill="' + D + '"/><rect x="6.9" y="13" width="1.3" height="1.6" rx=".3" fill="currentColor"/></svg>',
    // negotiator: two block arrows aimed past each other — the offer and the counter.
    negotiator: '<svg viewBox="0 0 24 24"><g fill="currentColor"><path d="M1.6 7.2 H7.8 V3.9 L13.6 8.8 L7.8 13.7 V10.4 H1.6 Z"/><path d="M22.4 16.8 H16.2 V20.1 L10.4 15.2 L16.2 10.3 V13.6 H22.4 Z"/></g></svg>',
    // jobhunter: the case, with the clasp carved out — the role, packed for.
    jobhunter: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8.6 3 h6.8 a1.8 1.8 0 0 1 1.8 1.8 V7.4 h-2.2 V5.2 h-6 V7.4 H6.8 V4.8 A1.8 1.8 0 0 1 8.6 3 Z"/><rect x="2.4" y="7.4" width="19.2" height="13.6" rx="1.8" fill="currentColor"/><path fill="' + D + '" d="M2.4 12.2 H10.2 V14 H2.4 Z"/><path fill="' + D + '" d="M13.8 12.2 H21.6 V14 H13.8 Z"/><rect x="10.4" y="11.2" width="3.2" height="3.8" rx=".6" fill="' + D + '"/></svg>',
    // anchor: the studio microphone — the briefing spoken, not printed.
    anchor: '<svg viewBox="0 0 24 24"><rect x="8.9" y="2.2" width="6.2" height="11.4" rx="3.1" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M5.2 11.6 a6.8 6.8 0 0 0 13.6 0"/><path fill="currentColor" d="M11 17.2 H13 V21 H11 Z"/><path fill="currentColor" d="M7.2 20.4 H16.8 V22 H7.2 Z"/><path fill="' + D + '" d="M10.2 4.6 H13.8 V6.1 H10.2 Z"/></svg>',
    // ---- 2026-08-03 second wave (same matte engraved-coin style: currentColor + deboss only) ----
    // drafter: the drafting triangle over a marked rule — the fuzzy idea squared up.
    drafter: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M2.4 19.6 L12 3 L21.6 19.6 Z"/><path fill="' + D + '" d="M12 7.6 L18 18 H6 Z"/><rect x="2.2" y="19.8" width="19.6" height="2.6" rx=".7" fill="currentColor"/><g fill="none" stroke="' + D + '" stroke-width="1.3" stroke-linecap="round"><path d="M6.4 20.2 V22"/><path d="M9.6 20.2 V22"/><path d="M12.8 20.2 V22"/><path d="M16 20.2 V22"/></g></svg>',
    // harvester: the filled table with its LAST cell missing — the honest gap that ships with the dataset.
    harvester: '<svg viewBox="0 0 24 24"><rect x="2.6" y="4" width="18.8" height="16" rx="1.6" fill="currentColor"/><g fill="' + D + '"><rect x="4.6" y="8.4" width="4.6" height="2.6" rx=".3"/><rect x="10.2" y="8.4" width="4.6" height="2.6" rx=".3"/><rect x="15.8" y="8.4" width="3.6" height="2.6" rx=".3"/><rect x="4.6" y="12" width="4.6" height="2.6" rx=".3"/><rect x="10.2" y="12" width="4.6" height="2.6" rx=".3"/><rect x="15.8" y="12" width="3.6" height="2.6" rx=".3"/><rect x="4.6" y="15.6" width="4.6" height="2.6" rx=".3"/><rect x="10.2" y="15.6" width="4.6" height="2.6" rx=".3"/></g></svg>',
    // sentinel: the radar sweep with one blip — what is already out there about you.
    sentinel: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.6" fill="currentColor"/><g fill="none" stroke="' + D + '" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="6.4"/><circle cx="12" cy="12" r="3.2"/><path d="M12 12 L19.2 6.8"/></g><circle cx="16.8" cy="8.2" r="1.8" fill="' + D + '"/></svg>',
    // registrar: the index card — one person, their face, what they said, and the line you owe them.
    registrar: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6.4 3.2 H17.6 V5.6 H6.4 Z"/><rect x="3" y="6.2" width="18" height="14" rx="1.6" fill="currentColor"/><g fill="' + D + '"><rect x="5.4" y="9.2" width="4.6" height="4.6" rx="2.3"/><rect x="11.6" y="9.6" width="7" height="1.7" rx=".6"/><rect x="11.6" y="12.4" width="5.2" height="1.7" rx=".6"/><rect x="5.4" y="16" width="13.2" height="1.7" rx=".6"/></g></svg>',
    // provisioner: the pot with its lid on — the week actually cooked, not the week imagined.
    provisioner: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3.4 9.6 H20.6 V16.2 a3.6 3.6 0 0 1 -3.6 3.6 H7 a3.6 3.6 0 0 1 -3.6 -3.6 Z"/><path fill="currentColor" d="M1.8 7.2 H22.2 V9.2 H1.8 Z"/><path fill="currentColor" d="M11 4.2 H13 V6.9 H11 Z"/><rect x="6.2" y="12.2" width="11.6" height="1.7" rx=".6" fill="' + D + '"/><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M20.8 11.8 H22.4"/><path d="M3.2 11.8 H1.6"/></g></svg>',
    // taskmaster: the stopwatch with the mark struck through it — the promise, and the date it carried.
    taskmaster: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13.4" r="8.4" fill="currentColor"/><path fill="currentColor" d="M9.6 1.6 H14.4 V4.2 H9.6 Z"/><path fill="currentColor" d="M18.4 4.8 L21 7.4 L19.1 9.3 L16.5 6.7 Z"/><path fill="none" stroke="' + D + '" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" d="M8.4 13.6 L11 16.2 L15.8 10.4"/></svg>',
    // medic: the cross cut INTO the coin — clerical, not clinical; the record, not the diagnosis.
    medic: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.6" fill="currentColor"/><path fill="' + D + '" d="M10.4 5.4 H13.6 V10.4 H18.6 V13.6 H13.6 V18.6 H10.4 V13.6 H5.4 V10.4 H10.4 Z"/></svg>',
    // diplomat: the span holding between two sides — the message that keeps the relationship standing.
    diplomat: '<svg viewBox="0 0 24 24"><g fill="currentColor"><rect x="2.4" y="8.8" width="3.2" height="11.4" rx=".6"/><rect x="18.4" y="8.8" width="3.2" height="11.4" rx=".6"/><rect x="1.4" y="19.6" width="21.2" height="2.4" rx=".6"/></g><path fill="none" stroke="currentColor" stroke-width="2.2" d="M4 9.6 a8 8 0 0 1 16 0"/><g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 10.8 V19.6"/><path d="M12 8.9 V19.6"/><path d="M16 10.8 V19.6"/></g></svg>',
    // ---- 2026-08-03 third wave: the build lane + marketing sub-niches (same engraved-coin style) ----
    // apptester: the cursor caught mid-click on a live surface — the app used, not read.
    apptester: '<svg viewBox="0 0 24 24"><rect x="2.4" y="3" width="19.2" height="15" rx="1.8" fill="currentColor"/><path fill="' + D + '" d="M4.4 7 H19.6 V15.6 H4.4 Z"/><path fill="currentColor" d="M9.6 9 L17 13.2 L13.6 14 L15.4 17.4 L13.6 18.4 L11.8 15 L9.6 17.4 Z"/><rect x="8.4" y="19.4" width="7.2" height="1.8" rx=".6" fill="currentColor"/></svg>',
    // deployer: the payload leaving the pad — from your machine to live.
    deployer: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 1.6 L15.6 7.4 V14 H8.4 V7.4 Z"/><path fill="' + D + '" d="M10.6 6.6 a1.4 1.4 0 0 1 2.8 0 a1.4 1.4 0 0 1 -2.8 0 Z"/><path fill="currentColor" d="M8.4 10.4 L5.2 14.4 V17 L8.4 15.2 Z"/><path fill="currentColor" d="M15.6 10.4 L18.8 14.4 V17 L15.6 15.2 Z"/><g fill="currentColor"><rect x="10.8" y="16" width="2.4" height="3.4" rx=".8"/><rect x="7.6" y="20.2" width="8.8" height="1.8" rx=".7"/></g></svg>',
    // dbhelper: the stacked drum with one band locked — the rows, and who may read them.
    dbhelper: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8.4" ry="3.2" fill="currentColor"/><path fill="currentColor" d="M3.6 8 v4 a8.4 3.2 0 0 0 16.8 0 v-4 a8.4 3.2 0 0 1 -16.8 0 Z"/><path fill="currentColor" d="M3.6 14 v4 a8.4 3.2 0 0 0 16.8 0 v-4 a8.4 3.2 0 0 1 -16.8 0 Z"/><path fill="' + D + '" d="M10.6 15.4 h2.8 v3.4 h-2.8 Z"/><path fill="' + D + '" d="M11 14.2 a1 1 0 0 1 2 0 v1.4 h-2 Z"/></svg>',
    // landingwriter: the page with the fold marked and one call to action under it.
    copywriter: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 21 l1.3-4.2 L16.5 4.6 l2.9 2.9 L7.2 19.7 Z"/><path fill="' + D + '" d="M4.6 18.4 l1 1 -1.8.6 Z"/><path fill="currentColor" d="M17.6 3.5 l1.4-1.4 a1.6 1.6 0 0 1 2.3 0 l.6.6 a1.6 1.6 0 0 1 0 2.3 l-1.4 1.4 Z"/></svg>',
    webdesigner: '<svg viewBox="0 0 24 24"><rect x="3" y="2.6" width="18" height="18.8" rx="1.6" fill="currentColor"/><g fill="' + D + '"><rect x="5.2" y="5" width="13.6" height="2.6" rx=".5"/><rect x="5.2" y="8.8" width="9.4" height="1.6" rx=".5"/></g><path fill="' + D + '" d="M4.4 12.4 H19.6 V13.4 H4.4 Z"/><rect x="7.6" y="15.6" width="8.8" height="3.4" rx="1.2" fill="' + D + '"/><rect x="9.2" y="16.8" width="5.6" height="1" rx=".4" fill="currentColor"/></svg>',
    // support: the handset with the answered line.
    support: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6.8 2.6 a2.2 2.2 0 0 1 2.6 1.2 l1.6 3.4 a2.2 2.2 0 0 1 -.6 2.6 L8.8 11 a13 13 0 0 0 4.2 4.2 l1.2-1.6 a2.2 2.2 0 0 1 2.6-.6 l3.4 1.6 a2.2 2.2 0 0 1 1.2 2.6 l-.6 2.2 a2.2 2.2 0 0 1 -2.4 1.6 C10.6 20.2 3.8 13.4 2.8 5.6 a2.2 2.2 0 0 1 1.6-2.4 Z"/><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M15.6 2.4 a6 6 0 0 1 6 6"/></g></svg>',
    // a11y: the figure with arms out inside the ring — the standing accessibility mark.
    a11y: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.6" fill="currentColor"/><circle cx="12" cy="6.6" r="1.9" fill="' + D + '"/><g fill="none" stroke="' + D + '" stroke-width="1.9" stroke-linecap="round"><path d="M5.6 10.2 H18.4"/><path d="M12 9.6 V14"/><path d="M12 14 L9 19.4"/><path d="M12 14 L15 19.4"/></g></svg>',
    // hiring: two candidate cards, one marked.
    hiring: '<svg viewBox="0 0 24 24"><rect x="2.2" y="4" width="9" height="16" rx="1.4" fill="currentColor"/><rect x="12.8" y="4" width="9" height="16" rx="1.4" fill="currentColor"/><circle cx="6.7" cy="9" r="2.1" fill="' + D + '"/><g fill="' + D + '"><rect x="3.8" y="13" width="5.8" height="1.5" rx=".5"/><rect x="3.8" y="16" width="4" height="1.5" rx=".5"/><circle cx="17.3" cy="9" r="2.1"/><rect x="14.4" y="13" width="5.8" height="1.5" rx=".5"/></g><path fill="none" stroke="' + D + '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M14.8 17.2 L16.6 19 L20 15.6"/></svg>',
    // processwriter: the numbered run of steps with a branch.
    processwriter: '<svg viewBox="0 0 24 24"><g fill="currentColor"><rect x="2.4" y="3.4" width="4.4" height="4.4" rx="1.2"/><rect x="2.4" y="9.8" width="4.4" height="4.4" rx="1.2"/><rect x="2.4" y="16.2" width="4.4" height="4.4" rx="1.2"/><rect x="9.4" y="4.6" width="12.2" height="2" rx=".7"/><rect x="9.4" y="11" width="12.2" height="2" rx=".7"/><rect x="9.4" y="17.4" width="8.4" height="2" rx=".7"/></g><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4.6 7.8 V9.8"/><path d="M4.6 14.2 V16.2"/></g></svg>',
    // pitchwriter: the deck on the easel — one slide, one argument.
    pitchwriter: '<svg viewBox="0 0 24 24"><rect x="2.6" y="2.6" width="18.8" height="13" rx="1.4" fill="currentColor"/><g fill="' + D + '"><rect x="4.8" y="4.8" width="9.6" height="2.2" rx=".5"/><rect x="4.8" y="8.4" width="6.4" height="1.6" rx=".5"/></g><path fill="' + D + '" d="M13.4 12.8 L16.2 8.6 L19.2 12.8 Z"/><g fill="currentColor"><rect x="11.2" y="15.6" width="1.6" height="4" rx=".5"/><path d="M6.4 21.4 L11.6 16.4 L12.8 17.6 L7.6 22.4 Z"/><path d="M17.6 21.4 L12.4 16.4 L11.2 17.6 L16.4 22.4 Z"/></g></svg>',
    // herald: a banner/pennant on a staff — the periodic broadcast.
    herald: '<svg viewBox="0 0 24 24"><rect x="5" y="2.6" width="2" height="18.8" rx=".6" fill="currentColor"/><path fill="currentColor" d="M7 3.4 H20 L16.8 7.6 L20 11.8 H7 Z"/><g fill="none" stroke="' + D + '" stroke-width="1.4" stroke-linecap="round"><path d="M9.6 6 H16"/><path d="M9.6 9 H14"/></g></svg>',
  };

  /* (The 2026-07-14 "typed ASCII mark" layer was REMOVED 2026-07-16 on Andrew's call — the typed
     emblems read as noise next to the engraved coins. The SVG seals above are the ONE class emblem
     system again: clean, accent-themed, unique per class. Custom classes fall back to their emoji.) */

  const CODE = {
    chief: 'CHF', engineer: 'ENG', researcher: 'RES', reviewer: 'REV', operator: 'AUT',
    analyst: 'ANL', scout: 'SCT', archivist: 'ARV', designer: 'DSN',
    broker: 'DLF', tutor: 'TCH', auditor: 'SEC', translator: 'XLT', herald: 'DGS',
    navigator: 'TRP', curator: 'FIL', muse: 'BRN',
    strategist: 'STG', marketer: 'MKT', publisher: 'CNT', producer: 'VID', writer: 'SCR',
    prospector: 'LED', envoy: 'INB', treasurer: 'TRE',
    closer: 'CLO', steward: 'COM', optimizer: 'SEO', opportunist: 'OPF',
    // 2026-08-03 catalog expansion
    pilot: 'VAS', foreman: 'TML', nightwatch: 'NGT', ghostwriter: 'GHW', paralegal: 'LGL',
    negotiator: 'NEG', jobhunter: 'JOB', anchor: 'NWS',
    // 2026-08-03 second wave
    drafter: 'PDM', harvester: 'DAT', sentinel: 'PRG', registrar: 'REL', provisioner: 'HOM',
    taskmaster: 'CCH', medic: 'HLT', diplomat: 'MED',
    // 2026-08-03 third wave — the build lane, marketing sub-niches, and business roles
    apptester: 'QAT', deployer: 'OPS', dbhelper: 'DBE', support: 'SUP', a11y: 'ACS', hiring: 'HIR', processwriter: 'SOP',
    pitchwriter: 'PCH',
    // 2026-08-03 consolidation: broad roles replace the marketing micro-classes
    copywriter: 'CPY', webdesigner: 'WDS'
  };

  // bespoke emblems for the built-in RECIPES (missions) — same matte/debossed style, keyed by recipe id.
  // Custom missions (no built-in art) fall back to their chosen emoji, exactly like custom classes.
  const MISSION_ICONS = {
    'morning-brief': '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 7 a5 5 0 0 1 5 5 H7 a5 5 0 0 1 5-5 Z"/><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2.5 16 H21.5"/><path d="M5 19.5 H19"/><path d="M12 3.4 V5.2"/><path d="M5.8 5.8 L7 7"/><path d="M18.2 5.8 L17 7"/></g></svg>',
    'deep-research': '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="8" fill="currentColor"/><path fill="currentColor" d="M16 14.2 L22 20.2 L20.2 22 L14.2 16 Z"/><g fill="none" stroke="' + D + '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 8.5 L10.5 12 L14 8.5"/><path d="M7 11.8 L10.5 15.3 L14 11.8"/></g></svg>',
    'fact-check': '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2 L20 5 V11 C20 16 16.5 19.4 12 21.4 C7.5 19.4 4 16 4 11 V5 Z"/><path fill="none" stroke="' + D + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M8.2 11.4 L11 14.2 L16 8.6"/></svg>',
    'fix-bug': '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M16.7 2.6 a6 6 0 0 0 -5.2 9 L3.3 19.7 a2.3 2.3 0 0 0 3.2 3.2 l8.1-8.1 a6 6 0 0 0 7.4-7.7 l-3 3 -2.9-.8 -.8-2.9 Z"/><circle cx="5.2" cy="18.8" r="1.1" fill="' + D + '"/></svg>',
    'code-review': '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="8" fill="currentColor"/><path fill="currentColor" d="M16 14.2 L22 20.2 L20.2 22 L14.2 16 Z"/><g fill="none" stroke="' + D + '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8.8 7.8 L6 10.5 L8.8 13.2"/><path d="M12.2 7.8 L15 10.5 L12.2 13.2"/></g></svg>',
    'ship-feature': '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3.3" y="3.3" width="8" height="8" rx="1.4"/><rect x="12.7" y="3.3" width="8" height="8" rx="1.4"/><rect x="3.3" y="12.7" width="8" height="8" rx="1.4"/><path d="M16.7 13.2 v3 h3 v2 h-3 v3 h-2 v-3 h-3 v-2 h3 v-3 Z"/></svg>',
    'draft-reply': '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 5.6 a2 2 0 0 1 2-2 h14 a2 2 0 0 1 2 2 v8.8 a2 2 0 0 1 -2 2 H9.5 L5 20 v-3.6 a2 2 0 0 1 -2-2 Z"/><g fill="none" stroke="' + D + '" stroke-width="1.7" stroke-linecap="round"><path d="M7 8.6 H15"/><path d="M7 11.6 H12"/></g></svg>',
    'tighten-writing': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6.2" r="2.6"/><circle cx="6" cy="17.8" r="2.6"/><path d="M8.3 7.7 L19.5 16.8"/><path d="M8.3 16.3 L19.5 7.2"/></svg>',
    'plan-project': '<svg viewBox="0 0 24 24"><rect x="4.5" y="3.6" width="15" height="16.8" rx="2" fill="currentColor"/><rect x="9" y="2" width="6" height="3.4" rx="1.2" fill="currentColor" stroke="' + D + '" stroke-width="1.2"/><g fill="none" stroke="' + D + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7.4 10 L8.5 11.1 L10.1 9.2"/><path d="M12 10.2 H16.4"/><path d="M7.4 14.6 L8.5 15.7 L10.1 13.8"/><path d="M12 14.8 H16.4"/></g></svg>',
    'summarize': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M4 5.5 H20"/><path d="M4 9.7 H20"/><path d="M4 13.9 H14"/><path d="M4 18.1 H9"/></svg>'
  };
  const MISSION_CODE = {
    'morning-brief': 'BRF', 'deep-research': 'DIG', 'fact-check': 'CHK', 'fix-bug': 'FIX', 'code-review': 'CRV',
    'ship-feature': 'BLD', 'draft-reply': 'RPL', 'tighten-writing': 'CUT', 'plan-project': 'PLN', 'summarize': 'TLD'
  };

  /* ---- CATEGORY SEALS (2026-08-13) — the recipe library's fallback, in the same engraved style ----
     MISSION_ICONS covers ten hero recipes. The other NINETY-ONE had no vector art at all, so the coin
     rendered `item.emoji` instead — and those emoji are geometric symbol characters (⌦ ⊟ ⊡ ⊘ ⊞ ⌘ ◱ ⊛ ◭).
     VT323 carries no glyph for any of them, so every one fell through to a system FALLBACK FONT: wrong
     weight, wrong metrics, wrong colour discipline, and on several rows a plain tofu box. They also
     collided badly — 43 distinct marks across 91 recipes, ◐ on five different recipes, ⚠ / ◈ / ◉ on
     four each — so the mark told you nothing about the row anyway.
     Authoring 91 bespoke emblems is not the answer; a recipe's CATEGORY is the honest grouping the
     browse rail already sorts by, so one engraved seal per category gives every row real vector art
     that says something true about it. Same rules as the class seals above: 24x24, currentColor so it
     rides the station phosphor, cut detail in the deboss colour, no <text> (that was the one seal that
     ever picked up a system font). A CUSTOM recipe still falls back to the emoji its author chose. */
  const CATEGORY_ICONS = {
    // developer: the terminal pane with a live prompt caret — the machine you actually type at.
    developer: '<svg viewBox="0 0 24 24"><rect x="2.2" y="3.6" width="19.6" height="16.8" rx="1.8" fill="currentColor"/><rect x="2.2" y="3.6" width="19.6" height="3.4" rx="1.8" fill="' + D + '"/><g fill="none" stroke="' + D + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.6 11 L8.4 13.6 L5.6 16.2"/><path d="M10.8 16.8 H17"/></g></svg>',
    // code: the two angle brackets around a slash — the oldest mark for "this is source".
    code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6.4 L2.6 12 L8 17.6"/><path d="M16 6.4 L21.4 12 L16 17.6"/><path d="M13.6 4.2 L10.4 19.8"/></svg>',
    // research: the lens laid over ruled evidence — reading something, with the sources kept.
    research: '<svg viewBox="0 0 24 24"><rect x="3" y="2.6" width="14.4" height="18.8" rx="1.6" fill="currentColor"/><g fill="none" stroke="' + D + '" stroke-width="1.5" stroke-linecap="round"><path d="M5.8 6.4 H14.6"/><path d="M5.8 9.4 H14.6"/><path d="M5.8 12.4 H10.2"/></g><circle cx="15.6" cy="14.6" r="4.6" fill="currentColor" stroke="' + D + '" stroke-width="1.6"/><path d="M18.8 17.8 L22 21" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
    // writing: the nib, cut and inked — the draft itself.
    writing: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3.4 20.6 L5.2 14.8 L15.4 4.6 L19.4 8.6 L9.2 18.8 Z"/><path fill="' + D + '" d="M13.8 7 L17 10.2 L9.6 17.6 L6.4 14.4 Z"/><path fill="currentColor" d="M16.6 3.4 L18 2 a1.6 1.6 0 0 1 2.3 0 l1.7 1.7 a1.6 1.6 0 0 1 0 2.3 l-1.4 1.4 Z"/><path fill="currentColor" d="M2.6 22.4 L4 18.6 L6.4 21 Z"/></svg>',
    // creator: the frame with the play mark struck into it — something made to be watched or read.
    creator: '<svg viewBox="0 0 24 24"><rect x="2.4" y="3.6" width="19.2" height="16.8" rx="2" fill="currentColor"/><path fill="' + D + '" d="M9.6 8.2 L16.4 12 L9.6 15.8 Z"/><g fill="' + D + '"><rect x="4.4" y="5.6" width="2.2" height="2.2" rx=".5"/><rect x="4.4" y="16.2" width="2.2" height="2.2" rx=".5"/><rect x="17.4" y="5.6" width="2.2" height="2.2" rx=".5"/><rect x="17.4" y="16.2" width="2.2" height="2.2" rx=".5"/></g></svg>',
    // planning: the board with the route stepped across it — a goal broken into moves.
    planning: '<svg viewBox="0 0 24 24"><rect x="2.6" y="3.4" width="18.8" height="17.2" rx="1.8" fill="currentColor"/><g fill="none" stroke="' + D + '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16.6 L10 16.6 L10 12 L14 12 L14 7.4 L18 7.4"/></g><g fill="' + D + '"><circle cx="6" cy="16.6" r="1.7"/><circle cx="14" cy="12" r="1.7"/><circle cx="18" cy="7.4" r="1.7"/></g></svg>',
    // ops: the gear — the thing that runs on its own schedule.
    ops: '<svg viewBox="0 0 24 24"><g fill="currentColor"><rect x="10.8" y="1.4" width="2.4" height="4.6" rx=".5"/><rect x="10.8" y="18" width="2.4" height="4.6" rx=".5"/><rect x="1.4" y="10.8" width="4.6" height="2.4" rx=".5"/><rect x="18" y="10.8" width="4.6" height="2.4" rx=".5"/><rect x="10.8" y="1.4" width="2.4" height="4.6" rx=".5" transform="rotate(45 12 12)"/><rect x="10.8" y="18" width="2.4" height="4.6" rx=".5" transform="rotate(45 12 12)"/><rect x="1.4" y="10.8" width="4.6" height="2.4" rx=".5" transform="rotate(45 12 12)"/><rect x="18" y="10.8" width="4.6" height="2.4" rx=".5" transform="rotate(45 12 12)"/><circle cx="12" cy="12" r="7"/></g><circle cx="12" cy="12" r="3.2" fill="' + D + '"/></svg>',
    // business: the case with its clasp cut out — the client-facing job.
    business: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 2.6 h6 a2 2 0 0 1 2 2 V7 h-2.4 V5 H9.4 V7 H7 V4.6 A2 2 0 0 1 9 2.6 Z"/><rect x="2" y="7" width="20" height="14.4" rx="1.8" fill="currentColor"/><path fill="' + D + '" d="M2 12.4 H10 V14.2 H2 Z"/><path fill="' + D + '" d="M14 12.4 H22 V14.2 H14 Z"/><rect x="10.2" y="11.4" width="3.6" height="4" rx=".6" fill="' + D + '"/></svg>',
    // money: the stacked coins — what it is worth, counted.
    money: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5.4" rx="8.6" ry="3.4" fill="currentColor"/><path fill="currentColor" d="M3.4 8.4 v3 a8.6 3.4 0 0 0 17.2 0 v-3 a8.6 3.4 0 0 1 -17.2 0 Z"/><path fill="currentColor" d="M3.4 14.2 v3 a8.6 3.4 0 0 0 17.2 0 v-3 a8.6 3.4 0 0 1 -17.2 0 Z"/><path fill="' + D + '" d="M11.2 3.2 h1.6 v4.4 h-1.6 Z"/><path fill="' + D + '" d="M9.6 4.2 a3.4 1.4 0 0 1 4.8 0 a3.4 1.4 0 0 1 -4.8 0 Z"/></svg>',
    // data: the drum with the bars read off it — rows turned into an answer.
    data: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="4.6" rx="8.2" ry="3" fill="currentColor"/><path fill="currentColor" d="M3.8 7.4 v3.2 a8.2 3 0 0 0 16.4 0 V7.4 a8.2 3 0 0 1 -16.4 0 Z"/><g fill="currentColor"><rect x="4.4" y="17" width="3.4" height="4.6" rx=".5"/><rect x="10.3" y="14" width="3.4" height="7.6" rx=".5"/><rect x="16.2" y="11" width="3.4" height="10.6" rx=".5"/></g></svg>',
    // general: the station rosette — no claim about the kind of work, just the station's own mark.
    general: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.6" fill="currentColor"/><path fill="' + D + '" d="M12 4.4 L14 10 L19.6 12 L14 14 L12 19.6 L10 14 L4.4 12 L10 10 Z"/></svg>'
  };
  // the 3-letter stamp for a category-sealed recipe still derives from its NAME (see `code()`), so two
  // recipes sharing a category seal are never mistaken for each other.
  function categoryIcon(item) {
    if (!item || typeof item !== 'object' || item.custom) return null;   // a custom author's own emoji wins
    const c = String(item.category || '').toLowerCase();
    return CATEGORY_ICONS[c] || null;
  }

  const LANE_LABEL = { code: 'CODE', research: 'RESEARCH', general: 'OPS' };
  const TIER_PIPS = { reasoning: 3, balanced: 2, fast: 1 };
  const TIER_LABEL = { reasoning: 'DEEP REASONING', balanced: 'BALANCED', fast: 'FAST & CHEAP' };

  // The emblem for a spec/recipe: its bespoke art first, then — for a built-in recipe with none — the
  // seal for its CATEGORY. Only a CUSTOM item (or a bare id string, which carries no category) returns
  // null, and only then does the caller draw the author's chosen emoji.
  function svg(idOrSpec) {
    const id = typeof idOrSpec === 'string' ? idOrSpec : (idOrSpec && idOrSpec.id);
    return ICONS[id] || MISSION_ICONS[id] || categoryIcon(idOrSpec) || null;
  }
  // a stamped 3-letter class code: the canon code for built-ins, else derived from the spec name.
  function code(idOrSpec) {
    const id = typeof idOrSpec === 'string' ? idOrSpec : (idOrSpec && idOrSpec.id);
    if (CODE[id]) return CODE[id];
    if (MISSION_CODE[id]) return MISSION_CODE[id];
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

  return { ICONS, CODE, CATEGORY_ICONS, LANE_LABEL, svg, code, categoryIcon, lane, laneLabel, clearance, pipsHTML };
});
