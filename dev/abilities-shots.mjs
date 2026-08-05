#!/usr/bin/env node
/* dev/abilities-shots.mjs — live proof shots for the ABILITIES console.
 *
 * Boots a seeded sidecar from THIS worktree, drives the REAL app over CDP (the established
 * headless pattern — see dev/brightness-shots.mjs / scripts/lib/cdp.mjs), opens ABILITIES and
 * captures EVERY tab. The console mounts all panes at once and tab clicks only toggle visibility,
 * so a shot per tab is the only way to see what a Commander actually lands on.
 *
 *   node dev/abilities-shots.mjs                 (ports: SKYNET_SHOT_PORT / SKYNET_CDP_PORT)
 *   node dev/abilities-shots.mjs --only keys
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, connectCDP, evalJS, capture, sleep, collectDiagnostics } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';

const PORT = process.env.SKYNET_SHOT_PORT || '9541';
const CDP_PORT = Number(process.env.SKYNET_CDP_PORT || 9543);
const URL = `http://127.0.0.1:${PORT}/`;
const OUT = process.env.SKYNET_SHOT_OUT || join(process.cwd(), 'dev', '.shots-abilities');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1]
  || (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null);

// Every section the console registers. The lane sections (skill library / agent skills) are pushed
// by stationui.js at build time, so they are driven by rail label rather than a hardcoded id.
const TABS = ['toolsets', 'catalog', 'keys', 'mcp', 'extensions'];

// Click the REAL rail button — never call selectSection directly. The rail click is what a
// Commander does, and it is the path that carries the pane-repoll wiring (e.g. the KEYS tab
// re-reads /api/servicekeys on click).
const clickTab = (id) => `(() => {
  const b = document.querySelector('#con-tab-connectors-${id}');
  if (!b) return 'no-tab:${id}';
  b.click();
  return 'clicked:${id}';
})()`;

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'abilityshots-'));
  materializeSeedWorkspace(join(scratch, 'ws'));
  const side = bootSeededSidecar({ port: PORT, scratchDir: join(scratch, 'ws') });
  let chrome = null, cdp = null;
  try {
    if (!(await waitUp(URL))) throw new Error('sidecar never came up on ' + URL);
    chrome = launchChrome({ cdpPort: CDP_PORT, profileDir: join(scratch, 'chrome') });
    await sleep(1200);
    cdp = await connectCDP(CDP_PORT);
    await cdp.send('Runtime.enable');
    const diag = collectDiagnostics(cdp);
    await evalJS(cdp, `location.href = ${JSON.stringify(URL)}`);
    if (!(await waitDevReady(cdp, evalJS, { url: URL }))) throw new Error('app never reached the game screen');
    await sleep(1500);
    mkdirSync(OUT, { recursive: true });
    // Freeze the world so a translucent panel does not inherit a different agent position per run.
    await evalJS(cdp, `(() => { if (document.body) document.body.classList.add('no-flicker');
      if (typeof World !== 'undefined' && World.stop) { World.stop(); return 'frozen'; } return 'no-world'; })()`);

    await evalJS(cdp, `StationUI.openTerm('connectors')`);
    await sleep(1800);   // the panes fetch /api/toolsets, /api/connectors/catalog, /api/servicekeys

    for (const id of TABS) {
      if (ONLY && id !== ONLY) continue;
      console.log(id, await evalJS(cdp, clickTab(id)));
      await sleep(1100);
      console.log('shot', await capture(cdp, OUT, 'abilities-' + id));
    }

    // ---- behavioural round-trips: prove the new controls DO something, not just that they render ----
    if (!ONLY || ONLY === 'catalog') {
      await evalJS(cdp, clickTab('catalog'));
      await sleep(600);
      const filterProbe = await evalJS(cdp, `(() => {
        const vis = () => [...document.querySelectorAll('#cc-list .cc-card')].filter(c => !c.hidden).length;
        const groups = () => [...document.querySelectorAll('#cc-list .cc-group')].filter(g => !g.hidden).length;
        const hit = (f) => {
          const b = document.querySelector('.cc-filter[data-cc-filter="' + f + '"]');
          if (!b) return 'no-btn:' + f;
          b.click();
          return { cards: vis(), groups: groups(), active: b.classList.contains('active') };
        };
        const out = { all: hit('all'), none: hit('none'), apikey: hit('apikey'), oauth: hit('oauth'), installed: hit('installed') };
        // RENDERED truth, not the property I just set: .cc-card/.cc-group carry an explicit display:flex,
        // which outranks the UA [hidden]{display:none} rule — so a card can be "hidden" and fully visible.
        document.querySelector('.cc-filter[data-cc-filter="none"]').click();
        const cards = [...document.querySelectorAll('#cc-list .cc-card')];
        out.painted = { flaggedHidden: cards.filter(c => c.hidden).length,
                        actuallyPainted: cards.filter(c => c.offsetParent !== null).length,
                        groupsPainted: [...document.querySelectorAll('#cc-list .cc-group')].filter(g => g.offsetParent !== null).length };
        document.querySelector('.cc-filter[data-cc-filter="all"]').click();
        // the group counter must re-state what is SHOWN, never the authored total
        document.querySelector('.cc-filter[data-cc-filter="none"]').click();
        const g0 = document.querySelector('#cc-list .cc-group:not([hidden])');
        out.countMatchesShown = g0
          ? (g0.querySelector('.sec-tag').textContent === String([...g0.querySelectorAll('.cc-card')].filter(c => !c.hidden).length))
          : 'no-visible-group';
        document.querySelector('.cc-filter[data-cc-filter="all"]').click();
        return out;
      })()`);
      console.log('FILTER PROBE', JSON.stringify(filterProbe));
      await evalJS(cdp, `document.querySelector('.cc-filter[data-cc-filter="none"]').click()`);
      await sleep(500);
      console.log('shot', await capture(cdp, OUT, 'abilities-catalog-filtered'));
      await evalJS(cdp, `document.querySelector('.cc-filter[data-cc-filter="all"]').click()`);
    }

    if (!ONLY || ONLY === 'mcp') {
      // the front door must actually navigate, and the empty-state jump must use the same contract
      await evalJS(cdp, clickTab('toolsets'));
      await sleep(400);
      const routeProbe = await evalJS(cdp, `(() => {
        const active = () => (document.querySelector('.con-rail-item.active') || {}).dataset?.section || '?';
        const r = {};
        r.landedOn = active();
        document.querySelector('.ab-route[data-ab-to="catalog"]').click();
        r.afterCatalogRoute = active();
        document.querySelector('.ab-route[data-ab-to="mcp"]').click();
        r.afterMcpRoute = active();
        // the advanced fold must exist, be shut by default, and still hold the two power fields
        const adv = document.querySelector('.mc-adv');
        // NB: a closed <details> in Chrome uses content-visibility, not display:none, so its children
        // keep a non-null offsetParent. Height + checkVisibility are the honest "did it paint" probes.
        const ta = adv && adv.querySelector('#mc-headers');
        r.advanced = adv ? { open: adv.open,
          holdsHeaders: !!ta, holdsTimeout: !!adv.querySelector('#mc-timeout'),
          shutHeight: Math.round(ta.getBoundingClientRect().height),
          shutVisible: ta.checkVisibility ? ta.checkVisibility({ contentVisibilityAuto: true }) : 'n/a' } : 'missing';
        if (adv) { adv.open = true;
          r.advanced.openHeight = Math.round(ta.getBoundingClientRect().height);
          r.advanced.openVisible = ta.checkVisibility ? ta.checkVisibility({ contentVisibilityAuto: true }) : 'n/a';
          adv.open = false; }
        // KEYS empty-state jump — the button added beside a cured dead end must not be a new one
        document.querySelector('#con-tab-connectors-keys').click();
        const kb = document.querySelector('#ky-platforms [data-ab-to="catalog"]');
        if (kb) { kb.click(); r.emptyStateJump = active(); } else r.emptyStateJump = 'no-button';
        return r;
      })()`);
      console.log('ROUTER PROBE', JSON.stringify(routeProbe));
      await evalJS(cdp, clickTab('mcp'));
      await sleep(700);
      console.log('shot', await capture(cdp, OUT, 'abilities-mcp-form'));
    }

    if (!ONLY || ONLY === 'toolsets') {
      await evalJS(cdp, clickTab('toolsets'));
      await sleep(600);
      const moreProbe = await evalJS(cdp, `(() => {
        const row = document.querySelector('.ts-row .ts-tools button[data-ts-more]');
        if (!row) return 'no-more-button';
        const wrap = row.parentElement;
        // painted, not flagged — same trap the catalog filter fell into
        const painted = () => [...wrap.querySelectorAll('code')].filter(c => c.offsetParent !== null).length;
        const before = painted();
        row.click();
        return { paintedBefore: before, paintedAfter: painted(), total: wrap.querySelectorAll('code').length,
                 buttonGone: !wrap.querySelector('button[data-ts-more]') };
      })()`);
      console.log('TOOL-CHIP EXPANDER PROBE', JSON.stringify(moreProbe));
      // the inert row's cure: it must reach the REAL placement surface (REFIT), not no-op.
      const placeProbe = await evalJS(cdp, `(() => {
        const btn = document.querySelector('.ts-inert button[data-ts-place]');
        if (!btn) return 'no-place-button';
        const obj = btn.dataset.tsPlace;
        btn.click();
        return { object: obj,
                 refitOpen: !!(typeof Build !== 'undefined' && Build.isOpen && Build.isOpen()),
                 refitOn: document.body.classList.contains('refit-on'),
                 armedTile: (document.querySelector('.refit-proptile.active') || {}).dataset ? document.querySelector('.refit-proptile.active').dataset.prop : null };
      })()`);
      console.log('PLACE-ONE PROBE', JSON.stringify(placeProbe));
      await sleep(900);
      console.log('shot', await capture(cdp, OUT, 'abilities-place-refit'));
    }

    // ---- NO WHITE HTML CONTROLS (standing order). The three OS-paint signatures are a white/near-white
    //      buttonface, the grey ButtonBorder, and black Arial. Sweep every control this console renders.
    if (!ONLY) {
      const paint = await evalJS(cdp, `(() => {
        const OS_BG = ['rgb(255, 255, 255)', 'rgb(239, 239, 239)'];
        const OS_BORDER = 'rgb(118, 118, 118)';
        const bad = [];
        const scope = document.querySelector('#terms .term');
        if (!scope) return 'no-console-open';
        scope.querySelectorAll('button, select, textarea, input, summary, details').forEach(el => {
          const cs = getComputedStyle(el);
          const hits = [];
          if (OS_BG.includes(cs.backgroundColor)) hits.push('bg:' + cs.backgroundColor);
          if (cs.borderTopColor === OS_BORDER) hits.push('border:' + cs.borderTopColor);
          if (/arial|sans-serif/i.test(cs.fontFamily) && !/VT323/i.test(cs.fontFamily)) hits.push('font:' + cs.fontFamily);
          if (hits.length) bad.push({ sel: el.tagName.toLowerCase() + '.' + (el.className || '(none)'), hits });
        });
        return { scanned: scope.querySelectorAll('button, select, textarea, input, summary, details').length, offenders: bad.slice(0, 12) };
      })()`);
      console.log('OS-PAINT SWEEP', JSON.stringify(paint));
    }

    if (diag.exceptions.length) console.log('PAGE EXCEPTIONS:', diag.exceptions);
    const errs = diag.consoleMsgs.filter(m => m.type === 'error');
    if (errs.length) console.log('CONSOLE ERRORS:', errs.slice(0, 10));
    console.log('done ->', OUT);
  } finally {
    try { if (chrome && chrome.proc) chrome.proc.kill(); } catch {}
    try { if (side && side.kill) side.kill(); } catch {}
  }
}
main().catch(e => { console.error(e); process.exit(1); });
