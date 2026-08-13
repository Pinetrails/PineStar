/* node test/quest-log-window.test.js — the QUEST LOG window contract (2026-08-13).

   Locks the four repairs of the quest-log lane so they cannot silently regress:
     1. NO FLASHING — journeystore compares a serialized SIGNATURE, never object identity, against
        polled JSON (identity never holds for a fresh JSON.parse; that guard was the 4s repaint loop).
        And every quest store's background poke is a DATA poke (rerender('quests', false)) — a poll
        must never play the body crossfade over a panel the Commander is reading.
     2. REFRESH FOLLOWS ITS CYCLE — the store runs a BOUNDED settle-watch on real status; the panel
        carries no blind setTimeout guess, and the outcome reads in plain language.
     3. A QUEST STARTS IN ITS OWN SESSION — work/ledger GO routes to 'session' (never the TASK BOARD),
        idempotent by title, composer PREFILLED never sent, ledger quests bind their OWN agent.
     4. QUESTS LEAD THE PANEL — direction, then quests, then bookkeeping; kind badges name the source;
        the window is a steady-height shell so a data poke cannot re-centre it mid-read.

   stationui.js is browser-flow — like outbox-window.test.js we lock its invariants by reading the
   shipped source. quests.js IS pure and node-loadable, so its contract is asserted by execution. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const station = read('frontend/app/stationui.js');
const journey = read('frontend/app/journeystore.js');
const refresh = read('frontend/app/questrefreshstore.js');
const css = read('frontend/css/app.css');
const motion = read('frontend/css/motion.css');

/* ---- 1. the flashing stays dead: signature guard + data pokes ---- */
A.ok(/function signatureOf/.test(journey) && /JSON\.stringify\(journey\)/.test(journey), 'journeystore compares a serialized signature (identity never holds for polled JSON — the 4s repaint bug)');
A.ok(/sig === lastSig/.test(journey), 'an unchanged journey (same signature, new object) repaints NOTHING');
A.eq((journey.match(/lastSig = null/g) || []).length >= 2, true, 'BOTH reset paths clear the signature (a re-init must not suppress the first repaint)');
A.ok(/function rerender\(key, swap\)/.test(station), 'StationUI.rerender accepts the data-poke form (swap=false → no body crossfade)');
for (const f of ['goalstore', 'journeystore', 'maintqueststore', 'stationqueststore', 'workqueststore', 'queststatestore', 'questledgerstore', 'questrefreshstore']) {
  const src = read('frontend/app/' + f + '.js');
  A.ok(!/StationUI\.rerender\('quests'\)(?!, )/.test(src.replace(/StationUI\.rerender\('quests', false\)/g, '')), f + ': every background poke is a DATA poke (rerender(\'quests\', false)) — no crossfade blink from a poll');
}

/* ---- 2. refresh follows its cycle to the end, boundedly ---- */
A.ok(/SETTLE_MAX_MS/.test(refresh) && /SETTLE_POLL_MS/.test(refresh), 'the settle-watch is BOUNDED (poll cadence + hard ceiling — never an unbounded spinner)');
A.ok(/if \(out\.started\) watchSettle\(\)/.test(refresh), 'a started refresh is FOLLOWED (watchSettle), not guessed at');
A.ok(/finally \{ watching = false; poke\(\); \}/.test(refresh), 'the watch pokes on give-up too — the button always comes back');
const buildFn = station.slice(station.indexOf('function buildQuests'), station.indexOf('function journeyHtml'));
A.ok(!/setTimeout\([^)]*rerender\('quests'\)/.test(buildFn), 'the panel carries NO blind re-render timer (the stuck-REFRESHING… bug)');
A.ok(/the station had nothing it could honestly ground/.test(station), 'a rejected cycle reads in plain language (the engine wording rides the tooltip)');

/* ---- 3. a quest starts in its own session ---- */
const stationFns = station.slice(station.indexOf('function questGoDest'), station.indexOf('function buildQuests'));
A.ok(/return 'session'/.test(station) && !/GO ▸ task board/.test(station), 'work/ledger quests route to their OWN session — the TASK BOARD misroute is dead');
A.ok(/function questOpenSession/.test(station) && /\.find\(s => s && !s\.archived && s\.title === title\)/.test(station), 'START QUEST is idempotent by title (a second click returns to the same conversation)');
A.ok(/Chat\.prefill\(/.test(station.slice(station.indexOf('function questOpenSession'), station.indexOf('function questSessionTitle') + 4000)), 'the ask is PREFILLED, never sent — no fabricated turns');
A.ok(/q\.agentId && String\(q\.agentId\)/.test(station), 'a ledger quest binds its OWN agent; agent-less kinds fall to the hero');

/* ---- 4. quests lead the panel; the shell holds steady ---- */
const render = station.slice(station.indexOf("body.innerHTML = '<div class=\"gx gx-quests\">"), station.indexOf("body.innerHTML = '<div class=\"gx gx-quests\">") + 900);
const orderOk = render.indexOf('questRefreshHtml()') < render.indexOf('q-open') && render.indexOf('q-open') < render.indexOf('journeyHtml()');
A.ok(orderOk, 'panel order: direction → quests → bookkeeping (quests were the FOURTH thing; never again below the fold)');
A.ok(/QUEST_KIND_TAG/.test(station) && /FOR YOU/.test(station), 'cards carry a kind badge naming which real source minted them');
A.ok(/className: 'quests-win'/.test(station), 'the window declares the steady-height shell class');
A.ok(/\.term\.quests-win \{ --con-h:/.test(css), 'quests-win RESTATES --con-h (declared only on .term.console — an undefined var would silently fall back to content-fit)');
A.ok(/\.gx-quests \.q-grid \{ grid-template-columns: repeat\(auto-fill/.test(motion), 'the quest grid follows the window width at its CANONICAL rule in motion.css (app.css copies are silent no-ops)');
A.ok(/align-items: stretch/.test(motion), 'cards in a row share a height — one action baseline per row');

/* ---- the pure engine: per-dimension WHY (executed, not grepped) ---- */
const Quests = require('../frontend/app/quests.js');
const dims = [
  { key: 'stack', label: 'Stack & tools', known: false },
  { key: 'pain', label: 'Pain points', known: false },
  { key: 'schedule', label: 'Schedule & cadence', known: false },
  { key: 'brand_new_dim', label: 'Brand new', known: false }
];
const built = Quests.build({ dossierDims: dims });
const descs = built.filter(q => q.kind === 'dossier').map(q => q.desc);
A.eq(descs.length, 4, 'one quest per dossier dimension');
A.eq(new Set(descs.slice(0, 3)).size, 3, 'known dimensions carry DISTINCT explanations (nine identical sentences read as one wall)');
A.ok(/every agent on the station will know this about you/.test(descs[3]), 'an unknown dimension keeps the honest generic line rather than an invented claim');

A.report('quest-log-window.test');
