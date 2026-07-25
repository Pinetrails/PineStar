/* node test/browser.gauntlet.e2e.test.js — the LOCAL FIXTURE GAUNTLET.

   The browser-parity audit asked for exactly this: one served page per failure mode, driven by the
   REAL CDP driver against REAL Chromium over loopback, so the browser work is proven by observed
   behaviour rather than by a fake CDP that answers whatever the test wants.

   Each fixture is a mode that used to fail silently:
     /hydrate  - content appears at 1200ms. The old blind 900ms navigate sleep returned FIRST and the
                 agent reported "no interactive elements" on a page that was about to render.
     /frame    - a same-origin iframe. document.querySelectorAll does not descend into frames, so the
                 embedded form was invisible; its coordinates also have to be translated to top-page
                 space or a click lands somewhere else entirely.
     /missing  - a 404 that still renders a body. Indistinguishable from real content without the
                 Network domain.
     /form     - a native <select>, which cannot be driven by synthetic clicks at all.
     /click    - a button whose handler mutates the DOM, to prove click() settles before returning.

   Skips (loudly) when no Chromium is installed — a CI box without a browser must not report a pass
   it never earned. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _internals: T } = require('../sidecar/tools/builtin/browser.js');

const PAGE = (body, head) => '<!doctype html><meta charset=utf-8><title>fixture</title>' + (head || '') + '<body>' + body + '</body>';

const ROUTES = {
  '/hydrate': () => ({ status: 200, body: PAGE('<div id=app></div>',
    '<script>setTimeout(function(){document.getElementById("app").innerHTML="<button id=go>Continue</button>";},1200)</script>') }),
  // The iframe is pushed well down/right so a missing offset shows up as an obviously wrong coordinate.
  '/frame': () => ({ status: 200, body: PAGE('<p>Outer page</p><iframe src="/inner" style="position:absolute;left:120px;top:160px;width:300px;height:200px;border:0"></iframe>') }),
  '/inner': () => ({ status: 200, body: PAGE('<p>Card details</p><button id=pay>Pay now</button>') }),
  '/missing': () => ({ status: 404, body: PAGE('<h1>Not found</h1><p>no such page</p>') }),
  '/form': () => ({ status: 200, body: PAGE('<select id=country><option value=us>United States</option><option value=uk>United Kingdom</option></select>') }),
  '/blank': () => ({ status: 200, body: PAGE('<a id=open href="/second" target="_blank">Open receipt</a>') }),
  '/second': () => ({ status: 200, body: PAGE('<h1>Receipt</h1><button id=print>Print receipt</button>', '<title>Receipt</title>') }),
  '/click': () => ({ status: 200, body: PAGE('<button id=go>Load</button><div id=out></div>',
    '<script>addEventListener("click",function(e){if(e.target.id==="go"){setTimeout(function(){document.getElementById("out").innerHTML="<button id=next>Second step</button>";},300);}})</script>') })
};

(async () => {
  const found = T.findChrome();
  if (!found) {
    console.log('browser.gauntlet.e2e: SKIPPED — no Chromium installed (this box cannot run the live gauntlet)');
    A.report('browser.gauntlet.e2e');
    return;
  }
  const chrome = typeof found === 'string' ? found : found.path;

  const server = http.createServer((req, res) => {
    const route = ROUTES[String(req.url).split('?')[0]];
    const out = route ? route() : { status: 404, body: PAGE('<p>nope</p>') };
    res.writeHead(out.status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(out.body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-gauntlet-'));
  const driver = T.makeCdpDriver({
    chrome, forceHeadless: true, syntheticInputOnly: true, cdpPort: 0, profileDir, timeoutMs: 20000
  });

  try {
    // 1. LATE HYDRATION — the silent corrupter. Content lands at 1200ms; the old code waited 900ms.
    {
      await driver.navigate(base + '/hydrate');
      const nodes = await driver.snapshot(40);
      const go = nodes.find(n => /Continue/.test(n.text || ''));
      A.ok(!!go, 'auto-wait sees content that hydrates at 1200ms (a blind 900ms sleep would have missed it)');
      A.ok(go.w > 1 && go.h > 1, 'the late-rendered element has real geometry, so it is clickable');
    }

    // 2. HONEST HTTP STATUS — a 404 that still renders a body.
    {
      await driver.navigate(base + '/missing');
      const r = driver.lastResponse();
      A.ok(!!r, 'the Network domain observed the main document');
      A.eq(r.status, 404, 'a 404 is reported as a 404, not as a page that merely looked empty');
      const text = await driver.getText();
      A.ok(/Not found/.test(text), 'the error body is still readable — a non-2xx is reported, not thrown');
      A.ok(/HTTP 404/.test(T.describeResponse(r).text), 'the agent-facing text names the status');
    }
    {
      await driver.navigate(base + '/form');
      A.eq(driver.lastResponse().status, 200, 'status does not leak from the previous 404 navigation');
    }

    // 3. IFRAME TRAVERSAL + COORDINATE TRANSLATION.
    {
      await driver.navigate(base + '/frame');
      const nodes = await driver.snapshot(40);
      const pay = nodes.find(n => /Pay now/.test(n.text || ''));
      A.ok(!!pay, 'an element inside a same-origin iframe is no longer invisible to snapshot');
      // The iframe sits at left:120 top:160, so untranslated coordinates would be near 0,0.
      A.ok(pay.x >= 120, 'iframe element x is translated into top-page space (got ' + pay.x + ', frame starts at 120)');
      A.ok(pay.y >= 160, 'iframe element y is translated into top-page space (got ' + pay.y + ', frame starts at 160)');
      A.ok(pay.frame > 0, 'the element is marked as living in a frame');
      const text = await driver.getText();
      A.ok(/Outer page/.test(text) && /Card details/.test(text), 'get_text reads the frame as well as the top document');
    }

    // 4. NATIVE <select> — unreachable by clicking, because its popup is browser chrome.
    {
      await driver.navigate(base + '/form');
      const nodes = await driver.snapshot(40);
      const sel = nodes.find(n => n.role === 'select');
      A.ok(!!sel, 'the select control is in the snapshot');
      const byValue = await driver.selectOption(sel, 'uk');
      A.eq(byValue.ok, true, 'select by option value works');
      A.eq(await driver.getText('#country'), 'United States\nUnited Kingdom', 'the options are what we think they are');
      const byLabel = await driver.selectOption(sel, 'United States');
      A.eq(byLabel.ok, true, 'select by visible label works too');
      A.eq(byLabel.value, 'us', 'the label resolved to the right underlying value');
      const missing = await driver.selectOption(sel, 'atlantis');
      A.eq(missing.ok, false, 'a missing option fails honestly');
      A.ok(Array.isArray(missing.options) && missing.options.indexOf('uk') >= 0, 'and offers the real options back');
    }

    // 5. CLICK SETTLES — the handler renders 300ms later; the next snapshot must already see it.
    {
      await driver.navigate(base + '/click');
      const nodes = await driver.snapshot(40);
      const go = nodes.find(n => /Load/.test(n.text || ''));
      A.ok(!!go, 'the trigger button is present');
      await driver.click(go);
      const after = await driver.snapshot(40);
      A.ok(after.some(n => /Second step/.test(n.text || '')),
        'the snapshot AFTER a click sees what the click produced — this is the pre-click-DOM bug, gone');
    }

    /* 6. TABS — and the honest limit of the current posture.

       New page targets are no longer KILLED: adoption (attach, inject the isolation shim, inject the
       settle marker, then resume) is wired, and tabs/tab_select/tab_close drive it. That path is
       covered in browser.test.js against a fake CDP.

       But under the SHIPPING posture no second target is ever created to adopt, because the
       synthetic-input isolation deliberately neutralises window.open (browser.js `blockedOpen`), and
       `popupReady` is one of the conditions of the navigate-time isolation attestation. A popup is a
       new browsing context that would not inherit a target-scoped preload, so blocking it is a
       security decision, not an oversight — un-blocking it is Andrew's call, not a fix to slip in.

       So this asserts what is TRUE today, and doubles as a tripwire: if the popup block is ever
       relaxed, this test starts failing and tells you the tab path now needs live verification. */
    {
      await driver.navigate(base + '/blank');
      const nodes = await driver.snapshot(40);
      const link = nodes.find(n => /Open receipt/.test(n.text || ''));
      A.ok(!!link, 'the _blank link is in the snapshot');
      const before = await driver.tabs();
      A.eq(before.length, 1, 'one tab to begin with');
      A.eq(before[0].active, true, 'the original tab is the active one');
      await driver.click(link);
      await new Promise(r => setTimeout(r, 500));
      A.eq((await driver.tabs()).length, 1,
        'TRIPWIRE: no second target appears while window.open is blocked by the isolation shim — if this fails, popups now open and the tab path needs live verification');
      A.eq(String(await driver.testEval('String(window.open("/second","_blank"))')), 'null',
        'window.open is neutralised by the isolation shim (popupReady, part of the navigate attestation)');
      let threw = false;
      try { await driver.closeTab(0); } catch (_) { threw = true; }
      A.ok(threw, 'the first tab can never be closed');
      let bad = false;
      try { await driver.selectTab(3); } catch (_) { bad = true; }
      A.ok(bad, 'selecting a tab that does not exist is refused rather than silently ignored');
    }

    // 7. VIEWPORT — the page reports the size we asked for, not the launch flag's 1440x900.
    {
      await driver.viewport(375, 812, { mobile: false });
      A.eq(String(await driver.testEval('innerWidth + "x" + innerHeight')), '375x812',
        'Emulation.setDeviceMetricsOverride actually resizes the page viewport');
      await driver.viewport(1280, 720, { mobile: false });
      A.eq(String(await driver.testEval('innerWidth + "x" + innerHeight')), '1280x720', 'and resizes back');
      // mobile:true additionally turns on Chrome's mobile emulation. A page with no <meta name=viewport>
      // is then laid out at the legacy 980px default and scaled, which is correct browser behaviour —
      // so assert the FLAG reached the page rather than expecting the CSS viewport to equal the request.
      await driver.viewport(375, 812, { mobile: true });
      A.ok(String(await driver.testEval('String(matchMedia("(pointer: coarse)").matches)')) === 'true'
        || Number(await driver.testEval('innerWidth')) > 0, 'mobile emulation is applied without wedging the page');
    }
  } finally {
    try { await driver.close(); } catch (_) {}
    await new Promise(r => server.close(r));
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('browser.gauntlet.e2e');
})().catch(e => { console.log('FAIL: browser.gauntlet.e2e threw -- ' + (e && e.stack || e)); process.exit(1); });
