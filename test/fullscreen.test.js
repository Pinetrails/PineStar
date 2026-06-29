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
  await Promise.resolve();
  await Promise.resolve();

  let fullscreen = false;
  invoked = '';
  const apiWin = {
    __TAURI__: {
      core: {
        invoke(cmd) { invoked = cmd; return Promise.resolve(true); }
      },
      window: {
        getCurrentWindow() {
          return {
            isFullscreen() { return Promise.resolve(fullscreen); },
            setFullscreen(next) { fullscreen = next; return Promise.resolve(); }
          };
        }
      }
    }
  };
  A.eq(await Fullscreen.toggle(apiWin, null), true, 'Tauri window API enters fullscreen');
  A.eq(fullscreen, true, 'Tauri window API sets fullscreen true');
  A.eq(await Fullscreen.toggle(apiWin, null), false, 'Tauri window API exits fullscreen');
  A.eq(fullscreen, false, 'Tauri window API sets fullscreen false');
  A.eq(invoked, '', 'Tauri window API is preferred before the custom command');

  fullscreen = false;
  const webviewWin = {
    __TAURI__: {
      webviewWindow: {
        getCurrentWebviewWindow() {
          return {
            isFullscreen() { return Promise.resolve(fullscreen); },
            setFullscreen(next) { fullscreen = next; return Promise.resolve(); }
          };
        }
      }
    }
  };
  A.eq(await Fullscreen.toggle(webviewWin, null), true, 'Tauri webviewWindow API is also recognized');
  A.eq(fullscreen, true, 'webviewWindow path sets fullscreen true');

  let resolveSlow;
  let slowInvokes = 0;
  const slowWin = {
    __TAURI__: {
      core: {
        invoke() {
          slowInvokes++;
          return new Promise(resolve => { resolveSlow = resolve; });
        }
      }
    }
  };
  A.eq(Fullscreen.handleKeydown({ key: 'F11', preventDefault() {}, stopPropagation() {} }, slowWin, null), true, 'first F11 starts a pending toggle');
  A.eq(Fullscreen.handleKeydown({ key: 'F11', preventDefault() {}, stopPropagation() {} }, slowWin, null), true, 'second F11 is consumed while pending');
  A.eq(slowInvokes, 1, 'pending F11 does not start a second toggle');
  resolveSlow(true);
  await Promise.resolve();
  await Promise.resolve();

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
