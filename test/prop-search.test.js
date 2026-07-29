/* test/prop-search.test.js — the PURE palette search matcher (frontend/app/propsearch.js).

   Asserted against the REAL PropSprites.CATALOG, so a renamed/relabelled prop that would quietly
   become unfindable in REFIT fails HERE rather than in front of the Commander. The load-bearing
   law is the last block: EVERY prop in the catalog must be reachable by typing its own label. */
'use strict';
const A = require('./_assert.js');
const PropSearch = require('../frontend/app/propsearch.js');
const PropSprites = require('../frontend/app/propsprites.js');

const C = PropSprites.CATALOG;
const ids = q => PropSearch.matchProps(C, q, catLabel).map(c => c.id);
// build.js owns CAT_LABEL; the matcher takes it as a parameter, so the test supplies the same shape.
const CAT_LABEL = {
  workstation: 'WORKSTATIONS', workflow: 'WORKFLOW', capability: 'CAPABILITY', isolation: 'ISOLATION',
  command: 'COMMAND', screens: 'SCREENS', lab: 'LAB', storage: 'STORAGE', comms: 'COMMS',
  lounge: 'LOUNGE', decor: 'DECOR',
};
const catLabel = c => CAT_LABEL[c];

A.ok(C.length > 100, 'catalog is the real one (' + C.length + ' props)');

/* ---- active(): a blank query is BROWSING, not a zero-result search ---- */
A.eq(PropSearch.active(''), false, 'empty query is not a search');
A.eq(PropSearch.active('   '), false, 'whitespace-only query is not a search');
A.eq(PropSearch.active('mug'), true, 'a real word is a search');
A.eq(ids('').length, 0, 'no query matches nothing (the caller shows the tabs instead)');

/* ---- the basics ---- */
A.ok(ids('mug').indexOf('mug') >= 0, 'MUG is findable by name');
A.ok(ids('MUG').indexOf('mug') >= 0, 'search is case-insensitive');
A.ok(ids('pinball').indexOf('pinball') >= 0, 'PINBALL is findable');
A.eq(ids('zzzznotaprop').length, 0, 'an unknown word matches nothing');

/* ---- tokens are ANDed, not ORed: "desk lamp" must NARROW to the lamp, not list every desk ---- */
const deskLamp = ids('desk lamp');
A.ok(deskLamp.indexOf('desklamp') >= 0, '"desk lamp" finds DESK LAMP');
A.eq(deskLamp.indexOf('desk'), -1, '"desk lamp" does NOT drag in the plain DESK (tokens are ANDed)');
A.eq(deskLamp.join(','), ids('lamp desk').join(','), 'token order does not matter');

/* ---- one query reaches ACROSS both tiers — the whole point of the box ---- */
const desks = PropSearch.matchProps(C, 'desk', catLabel);
A.ok(desks.some(c => c.tier === 'functional'), '"desk" reaches the functional tier');
A.ok(desks.some(c => c.tier === 'cosmetic'), '"desk" reaches the cosmetic tier too');

/* ---- a category is searchable by id AND by its display label ---- */
const lounge = PropSearch.matchProps(C, 'lounge', catLabel);
const loungeIds = lounge.map(c => c.id);
for (const id of ['couch', 'bookshelf', 'beanbag', 'pinball']) {
  A.ok(loungeIds.indexOf(id) >= 0, '"lounge" returns the whole lounge shelf (' + id + ')');
}
// LOUNGE TABLE is catalogued under `decor` and still matches — by NAME, which is correct and is
// exactly why the box exists. The invariant is that every hit earned it somewhere visible.
A.ok(lounge.every(c => (c.label + ' ' + c.id + ' ' + c.cat).toLowerCase().indexOf('lounge') >= 0),
  'every "lounge" hit carries the word in its label, id or category');
A.ok(ids('workstations').indexOf('desk') >= 0, 'the DISPLAY label ("WORKSTATIONS") is searchable');

/* ---- ranking: a label that starts with the query comes first ---- */
A.eq(String(desks[0].label).toLowerCase().indexOf('desk'), 0, 'a label-prefix match ranks first');

/* ---- THE LAW: no prop may be unfindable by its own label ---- */
for (const c of C) {
  A.ok(PropSearch.matchProps(C, c.label, catLabel).some(x => x.id === c.id),
    c.id + ' is findable by typing its own label ("' + c.label + '")');
}

A.report('prop-search');
