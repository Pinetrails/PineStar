/* node test/fullscreen.test.js
   Locks the F11 fullscreen shortcut: desktop uses the native Tauri window toggle;
   browser preview falls back to the Fullscreen API. */
'use strict';
const A = require('./_assert.js');
const Fullscreen = require('../frontend/app/fullscreen.js');

(async () => {
  A.ok(Fullscreen.isF11({ key: 'F11' }), 'F11 is recognized by key');
  A.ok(Fullscreen.isF11({ code: 'F11' }), 'F11 is recognized by code');
  A.ok(Fullscreen.isF11({ keyCode: 122 }), 'F11 is recognized by legacy keyCode');
  A.ok(!Fullscreen.isF11({ key: 'F10', code: 'F10', keyCode: 121 }), 'other function keys are ignored');

  let invoked = '';
  const ev = {
    key: 'F11',
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; }
  };
  const tauriWin = {
    __TAURI__: {
      core: {
        invoke(cmd) { invoked = cmd; return Promise.resolve(true); }
      }
    }
  };
  A.eq(Fullscreen.handleKeydown(ev, tauriWin, null), true, 'F11 handler claims the shortcut');
  A.eq(invoked, 'starnet_toggle_fullscreen', 'desktop F11 calls the native Tauri fullscreen command');
  A.ok(ev.prevented && ev.stopped, 'F11 is consumed before browser chrome handles it');

  invoked = '';
  A.eq(Fullscreen.handleKeydown({ key: 'F11', repeat: true }, tauriWin, null), false, 'held F11 repeats are ignored');
  A.eq(invoked, '', 'held F11 does not rapid-toggle fullscreen');

  let requested = 0;
  let exited = 0;
  const doc = {
    fullscreenElement: null,
    documentElement: {
      requestFullscreen() { requested++; doc.fullscreenElement = doc.documentElement; return Promise.resolve(); }
    },
    exitFullscreen() { exited++; doc.fullscreenElement = null; return Promise.resolve(); }
  };
  A.eq(await Fullscreen.toggleBrowser(doc), true, 'browser fallback enters fullscreen');
  A.eq(requested, 1, 'browser fallback calls requestFullscreen on the root document');
  A.eq(await Fullscreen.toggleBrowser(doc), false, 'browser fallback exits fullscreen');
  A.eq(exited, 1, 'browser fallback calls exitFullscreen when already active');

  requested = 0;
  const failingTauriWin = {
    __TAURI__: { core: { invoke() { return Promise.reject(new Error('native unavailable')); } } },
    console: { warn() {} }
  };
  A.eq(await Fullscreen.toggle(failingTauriWin, doc), true, 'native failure falls back to browser fullscreen');
  A.eq(requested, 1, 'fallback requestFullscreen still runs after a native error');

  let listener = null;
  const fakeWin = {
    document: {},
    addEventListener(type, fn, capture) {
      if (type === 'keydown' && capture === true) listener = fn;
    }
  };
  A.eq(Fullscreen.install(fakeWin, fakeWin.document), true, 'install wires the key listener');
  A.ok(typeof listener === 'function', 'install uses a real keydown listener');
  A.eq(Fullscreen.install(fakeWin, fakeWin.document), false, 'install is idempotent');

  A.report('fullscreen.test');
})().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
