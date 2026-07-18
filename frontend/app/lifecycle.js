/* Lifecycle: desktop bridge for Lane 4D — launch-at-login (opt-in) and the live "what keeps running when you
   close the window" summary. In the browser preview the Tauri commands are absent, so every call degrades to an
   honest no-op shape (supervised:false, autostart unavailable) — the Settings panel stays truthful without
   branching everywhere. The tray supervisor (Rust) owns the real close-to-tray decision; this module only reads
   its state and toggles the login setting. */
'use strict';

const Lifecycle = (() => {
  const AUTOSTART_STATUS = 'starnet_autostart_status';
  const AUTOSTART_SET = 'starnet_set_autostart';
  const LIFECYCLE_STATUS = 'starnet_lifecycle_status';

  function currentWindow() {
    return (typeof window !== 'undefined') ? window : null;
  }

  function tauriCore(win) {
    return win && win.__TAURI__ && win.__TAURI__.core && typeof win.__TAURI__.core.invoke === 'function'
      ? win.__TAURI__.core
      : null;
  }

  function isDesktop(win) {
    return !!tauriCore(win || currentWindow());
  }

  // Launch-at-login: OFF by default, opt-in. Returns { desktop, enabled } — enabled reflects the REAL OS state
  // (read back after any change), never an assumed value. In the browser it's { desktop:false, enabled:false }.
  async function autostartStatus(opts) {
    opts = opts || {};
    const core = tauriCore(opts.win || currentWindow());
    if (!core) return { desktop: false, enabled: false };
    try {
      const raw = await core.invoke(AUTOSTART_STATUS, {});
      return { desktop: !!(raw && raw.desktop), enabled: !!(raw && raw.enabled) };
    } catch (_) {
      return { desktop: true, enabled: false };
    }
  }

  async function setAutostart(enabled, opts) {
    opts = opts || {};
    const core = tauriCore(opts.win || currentWindow());
    if (!core) return { desktop: false, enabled: false };
    const raw = await core.invoke(AUTOSTART_SET, { enabled: !!enabled });
    return { desktop: !!(raw && raw.desktop), enabled: !!(raw && raw.enabled) };
  }

  // The live armed-work summary: { supervised, armed, reasons[] }. `supervised` is true only in the desktop tray
  // build — the ONLY build where closing the window can keep the station running. Browser => supervised:false.
  async function status(opts) {
    opts = opts || {};
    const core = tauriCore(opts.win || currentWindow());
    if (!core) return { supervised: false, armed: false, reasons: [] };
    try {
      const raw = await core.invoke(LIFECYCLE_STATUS, {});
      return {
        supervised: !!(raw && raw.supervised),
        armed: !!(raw && raw.armed),
        reasons: (raw && Array.isArray(raw.reasons)) ? raw.reasons.slice() : []
      };
    } catch (_) {
      return { supervised: true, armed: false, reasons: [] };
    }
  }

  return {
    isDesktop,
    autostartStatus,
    setAutostart,
    status,
    _internals: { AUTOSTART_STATUS, AUTOSTART_SET, LIFECYCLE_STATUS, tauriCore }
  };
})();

if (typeof module !== 'undefined') module.exports = Lifecycle;
