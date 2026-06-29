/* STARNET fullscreen.js
   F11 toggles the real desktop window in Tauri, with a browser Fullscreen API
   fallback for the local preview. */
'use strict';

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Fullscreen = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  let pendingToggle = null;

  function tauriCore(win) {
    return win && win.__TAURI__ && win.__TAURI__.core && typeof win.__TAURI__.core.invoke === 'function'
      ? win.__TAURI__.core
      : null;
  }

  function tauriWindow(win) {
    const api = win && win.__TAURI__;
    if (!api) return null;
    const windowApi = api.window || api.webviewWindow;
    if (!windowApi) return null;
    if (typeof windowApi.getCurrentWindow === 'function') return windowApi.getCurrentWindow();
    if (typeof windowApi.getCurrentWebviewWindow === 'function') return windowApi.getCurrentWebviewWindow();
    if (windowApi.Window && typeof windowApi.Window.getCurrent === 'function') return windowApi.Window.getCurrent();
    if (windowApi.WebviewWindow && typeof windowApi.WebviewWindow.getCurrent === 'function') return windowApi.WebviewWindow.getCurrent();
    if (windowApi.appWindow) return windowApi.appWindow;
    return null;
  }

  function isF11(ev) {
    return !!ev && (ev.key === 'F11' || ev.code === 'F11' || ev.keyCode === 122 || ev.which === 122);
  }

  function stopEvent(ev) {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
  }

  function toggleBrowser(doc) {
    doc = doc || (root && root.document);
    if (!doc || !doc.documentElement) return Promise.resolve(false);

    const active = doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement;
    if (active) {
      const exit = doc.exitFullscreen || doc.webkitExitFullscreen || doc.msExitFullscreen;
      return exit ? Promise.resolve(exit.call(doc)).then(() => false) : Promise.resolve(false);
    }

    const request = doc.documentElement.requestFullscreen
      || doc.documentElement.webkitRequestFullscreen
      || doc.documentElement.msRequestFullscreen;
    return request ? Promise.resolve(request.call(doc.documentElement)).then(() => true) : Promise.resolve(false);
  }

  function toggle(win, doc) {
    win = win || root;
    doc = doc || (win && win.document) || (root && root.document);
    const appWindow = tauriWindow(win);
    if (appWindow && typeof appWindow.isFullscreen === 'function' && typeof appWindow.setFullscreen === 'function') {
      return Promise.resolve(appWindow.isFullscreen()).then(on => {
        const next = !on;
        return Promise.resolve(appWindow.setFullscreen(next)).then(() => next);
      }).catch(err => {
        if (win && win.console && typeof win.console.warn === 'function') {
          win.console.warn('[fullscreen] Tauri window API toggle failed, trying command fallback', err);
        }
        const core = tauriCore(win);
        if (!core) return toggleBrowser(doc);
        return Promise.resolve(core.invoke('starnet_toggle_fullscreen')).catch(commandErr => {
          if (win && win.console && typeof win.console.warn === 'function') {
            win.console.warn('[fullscreen] native toggle failed, falling back to browser fullscreen', commandErr);
          }
          return toggleBrowser(doc);
        });
      });
    }
    const core = tauriCore(win);
    if (core) {
      return Promise.resolve(core.invoke('starnet_toggle_fullscreen')).catch(err => {
        if (win && win.console && typeof win.console.warn === 'function') {
          win.console.warn('[fullscreen] native toggle failed, falling back to browser fullscreen', err);
        }
        return toggleBrowser(doc);
      });
    }
    return toggleBrowser(doc);
  }

  function handleKeydown(ev, win, doc) {
    if (!isF11(ev) || ev.repeat) return false;
    stopEvent(ev);
    if (pendingToggle) return true;
    pendingToggle = toggle(win || root, doc).catch(err => {
      const consoleRef = (win && win.console) || (root && root.console);
      if (consoleRef && typeof consoleRef.warn === 'function') consoleRef.warn('[fullscreen] toggle failed', err);
    }).finally(() => {
      pendingToggle = null;
    });
    return true;
  }

  function install(win, doc) {
    win = win || root;
    doc = doc || (win && win.document);
    if (!win || typeof win.addEventListener !== 'function') return false;
    if (win.__STARNET_FULLSCREEN_WIRED__) return false;
    win.__STARNET_FULLSCREEN_WIRED__ = true;
    win.addEventListener('keydown', ev => handleKeydown(ev, win, doc), true);
    return true;
  }

  if (root && root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', () => install(root, root.document), { once: true });
    } else {
      install(root, root.document);
    }
  }

  return { isF11, toggleBrowser, toggle, handleKeydown, install };
});
