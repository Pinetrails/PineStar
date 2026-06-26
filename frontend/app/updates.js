/* STARNET updates.js
   Desktop Update Center: autonomous check loop + native Tauri updater bridge. */
'use strict';

const Updates = (() => {
  const KEY = 'starnet.updates.v1';
  const CORE = (typeof UpdateCore !== 'undefined') ? UpdateCore : null;
  const TAURI = (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
  const invoke = (cmd, args) => TAURI.invoke(cmd, args || {});
  const esc = s => (typeof U !== 'undefined' && U.esc) ? U.esc(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let prefs = loadPrefs();
  let notify = () => {};
  let rerender = () => {};
  let timer = 0;
  let busy = false;
  let state = {
    desktop: !!TAURI,
    phase: TAURI ? 'idle' : 'unsupported',
    currentVersion: '',
    target: '',
    update: null,
    error: '',
    downloaded: 0,
    contentLength: 0,
    lastCheckedAt: prefs.lastCheckAt || 0
  };

  function loadPrefs() {
    if (!CORE) return { v: 1, autoCheck: false, lastCheckAt: 0, nextCheckAt: 0, remindAfter: 0, ignoredVersion: '', notifiedVersion: '', failureCount: 0 };
    try { return CORE.hydrateSettings(JSON.parse(localStorage.getItem(KEY))); }
    catch (_) { return CORE.hydrateSettings(null); }
  }
  function savePrefs() {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (_) {}
  }
  function cleanError(e) {
    const text = (e && (e.message || e.toString && e.toString())) || String(e || 'unknown error');
    return text.replace(/^Error:\s*/, '').trim();
  }
  function fmtTime(ts) {
    if (!ts) return 'never';
    try { return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (_) { return 'recently'; }
  }
  function shortNotes(text) {
    text = String(text || '').trim();
    if (!text) return '';
    if (text.length > 520) text = text.slice(0, 520).trim() + '...';
    return text;
  }
  function snapshot() {
    return Object.assign({}, state, { prefs: Object.assign({}, prefs) });
  }
  function emit() {
    try { rerender('updates'); } catch (_) {}
  }

  async function init(opts) {
    opts = opts || {};
    notify = typeof opts.notify === 'function' ? opts.notify : notify;
    rerender = typeof opts.rerender === 'function' ? opts.rerender : rerender;
    await refreshStatus();
    runLoop('startup');
  }

  async function refreshStatus() {
    if (!TAURI || !CORE) {
      state.desktop = false;
      state.phase = 'unsupported';
      emit();
      return snapshot();
    }
    try {
      const r = await invoke('starnet_update_status');
      state.desktop = !!r.desktop;
      state.currentVersion = r.currentVersion || '';
      state.target = r.target || '';
      if (r.pending) {
        state.update = r.pending;
        state.phase = 'available';
      } else if (state.phase === 'idle') {
        state.phase = 'idle';
      }
      state.error = '';
    } catch (e) {
      state.phase = 'unsupported';
      state.error = cleanError(e);
    }
    emit();
    return snapshot();
  }

  function schedule() {
    clearTimeout(timer);
    if (!CORE) return;
    const now = Date.now();
    const action = CORE.nextAction({
      settings: prefs,
      runtime: { desktop: state.desktop, phase: state.phase, hasUpdate: !!state.update },
      now
    });
    if (action.action === 'check') {
      timer = setTimeout(() => runLoop('due'), 1000);
      return;
    }
    const nextAt = action.nextAt || (now + 60 * 60 * 1000);
    timer = setTimeout(() => runLoop(action.reason), Math.max(15000, nextAt - now));
  }

  function runLoop(reason) {
    if (!CORE) return;
    const action = CORE.nextAction({
      settings: prefs,
      runtime: { desktop: state.desktop, phase: state.phase, hasUpdate: !!state.update },
      now: Date.now()
    });
    if (action.action === 'check') {
      check(false, reason);
    } else {
      schedule();
    }
  }

  async function check(manual, reason) {
    if (!TAURI || !CORE || busy) return snapshot();
    busy = true;
    state.phase = 'checking';
    state.error = '';
    emit();
    try {
      const r = await invoke('starnet_update_check');
      prefs = CORE.recordCheckResult(prefs, r, Date.now());
      state.lastCheckedAt = r.checkedAt || Date.now();
      if (r.available && r.update) {
        state.update = r.update;
        state.phase = 'available';
        if (CORE.shouldNotify(prefs, r.update.version, Date.now(), !!r.update.critical)) {
          notify((r.update.critical ? 'Critical update' : 'StarNet update') + ' v' + r.update.version + ' is ready in Update Center', r.update.critical ? 'warn' : 'gold');
          prefs = CORE.recordNotified(prefs, r.update.version);
        }
      } else {
        state.update = null;
        state.phase = 'current';
        if (manual) notify('StarNet is up to date', 'good');
      }
      savePrefs();
    } catch (e) {
      state.phase = 'error';
      state.error = cleanError(e);
      prefs = CORE.recordCheckError(prefs, Date.now());
      savePrefs();
      if (manual) notify('Update check failed - ' + state.error, 'warn');
    } finally {
      busy = false;
      schedule();
      emit();
    }
    return snapshot();
  }

  async function install() {
    if (!TAURI || !CORE || busy || !state.update) {
      notify('No StarNet update is ready to install', 'warn');
      return snapshot();
    }
    const Channel = TAURI.Channel;
    if (!Channel) {
      notify('Update progress channel is unavailable in this build', 'warn');
      return snapshot();
    }
    busy = true;
    state.phase = 'downloading';
    state.downloaded = 0;
    state.contentLength = 0;
    state.error = '';
    const onEvent = new Channel(event => handleInstallEvent(event));
    emit();
    try {
      await invoke('starnet_update_install', { onEvent });
      state.phase = 'restarting';
      notify('StarNet update installed - restarting', 'good');
    } catch (e) {
      state.phase = 'available';
      state.error = cleanError(e);
      notify('Update install failed - ' + state.error, 'warn');
    } finally {
      busy = false;
      emit();
    }
    return snapshot();
  }

  function handleInstallEvent(event) {
    if (!event || !event.event) return;
    if (event.event === 'Started') {
      state.phase = 'downloading';
      state.contentLength = +(event.data && event.data.contentLength) || 0;
      state.downloaded = 0;
    } else if (event.event === 'Progress') {
      state.phase = 'downloading';
      state.downloaded += +(event.data && event.data.chunkLength) || 0;
    } else if (event.event === 'Finished') {
      state.phase = 'installing';
    } else if (event.event === 'Installing') {
      state.phase = 'restarting';
    }
    emit();
  }

  function setAutoCheck(on) {
    prefs = CORE.setAutoCheck(prefs, !!on, Date.now());
    savePrefs();
    schedule();
    emit();
  }
  function remindLater() {
    if (!state.update) return;
    prefs = CORE.remindLater(prefs, state.update.version, Date.now());
    savePrefs();
    notify('Update reminder moved to tomorrow', '');
    schedule();
    emit();
  }
  function ignoreVersion() {
    if (!state.update) return;
    prefs = CORE.ignoreVersion(prefs, state.update.version);
    savePrefs();
    state.update = null;
    state.phase = 'idle';
    notify('StarNet v' + prefs.ignoredVersion + ' will be skipped', 'warn');
    schedule();
    emit();
  }

  function phaseLabel() {
    if (state.phase === 'unsupported') return 'desktop updater unavailable';
    if (state.phase === 'checking') return 'checking for updates';
    if (state.phase === 'available') return 'update ready';
    if (state.phase === 'downloading') return 'downloading update';
    if (state.phase === 'installing') return 'preparing installer';
    if (state.phase === 'restarting') return 'restarting';
    if (state.phase === 'current') return 'up to date';
    if (state.phase === 'error') return 'check failed';
    return 'ready';
  }

  function settingsHtml() {
    const auto = prefs.autoCheck !== false;
    return '<h4 class="ms-h">UPDATES</h4>' +
      '<div class="up-mini">' +
      '<div><b>' + esc(phaseLabel().toUpperCase()) + '</b><span>current v' + esc(state.currentVersion || 'unknown') + ' - last check ' + esc(fmtTime(state.lastCheckedAt)) + '</span></div>' +
      '<button class="bb sm" id="set-updates-open">UPDATE CENTER</button>' +
      '</div>' +
      '<label class="set-row"><input type="checkbox" id="set-updates-auto" ' + (auto ? 'checked' : '') + '> AUTO-CHECK FOR UPDATES</label>';
  }

  function wireSettings(body) {
    const auto = body.querySelector('#set-updates-auto');
    if (auto) auto.addEventListener('change', ev => setAutoCheck(ev.target.checked));
    const open = body.querySelector('#set-updates-open');
    if (open && typeof StationUI !== 'undefined' && StationUI.toggleTerm) {
      open.addEventListener('click', () => StationUI.toggleTerm('updates', 'UPDATE CENTER', render, { w: '540px' }));
    }
  }

  function render(body) {
    body.innerHTML = html();
    wire(body);
  }

  function html() {
    if (!TAURI) {
      return '<div class="fb-empty">DESKTOP UPDATES ARE AVAILABLE IN THE PACKAGED STARNET APP.<br><span>This browser preview cannot install native releases.</span></div>';
    }
    const update = state.update;
    const pct = CORE.progress(state.downloaded, state.contentLength);
    const notes = update ? shortNotes(update.body) : '';
    const auto = prefs.autoCheck !== false;
    let out = '<div class="up-center">' +
      '<div class="up-head"><div><b>' + esc(phaseLabel().toUpperCase()) + '</b><span>current v' + esc(state.currentVersion || 'unknown') + (state.target ? ' - ' + esc(state.target) : '') + '</span></div>' +
      '<button class="bb sm" id="up-check" ' + (busy ? 'disabled' : '') + '>CHECK NOW</button></div>' +
      '<label class="set-row up-auto"><input type="checkbox" id="up-auto" ' + (auto ? 'checked' : '') + '> CHECK AUTOMATICALLY</label>';
    if (update) {
      out += '<div class="up-card ' + (update.critical ? 'critical' : '') + '">' +
        '<div class="up-version"><span>AVAILABLE</span><b>v' + esc(update.version) + '</b></div>' +
        (update.date ? '<div class="up-meta">published ' + esc(update.date) + '</div>' : '') +
        (notes ? '<pre class="up-notes">' + esc(notes) + '</pre>' : '<div class="up-meta">No release notes were provided.</div>') +
        '<div class="up-actions"><button class="bb sm" id="up-install" ' + (busy ? 'disabled' : '') + '>INSTALL UPDATE</button>' +
        '<button class="bb sm" id="up-remind">REMIND TOMORROW</button>' +
        (update.critical ? '' : '<button class="bb sm danger" id="up-ignore">SKIP VERSION</button>') + '</div></div>';
    } else {
      out += '<div class="up-empty">No update is pending. StarNet will keep checking in the background while automatic checks are on.</div>';
    }
    if (state.phase === 'downloading' || state.phase === 'installing' || state.phase === 'restarting') {
      out += '<div class="up-progress"><div style="width:' + pct + '%"></div></div>' +
        '<div class="up-meta">' + (state.contentLength ? (pct + '% downloaded') : phaseLabel()) + '</div>';
    }
    if (state.error) out += '<div class="up-error">' + esc(state.error) + '</div>';
    out += '<div class="up-foot">Last checked: ' + esc(fmtTime(state.lastCheckedAt)) + '</div></div>';
    return out;
  }

  function wire(body) {
    const auto = body.querySelector('#up-auto');
    if (auto) auto.addEventListener('change', ev => setAutoCheck(ev.target.checked));
    const checkBtn = body.querySelector('#up-check');
    if (checkBtn) checkBtn.addEventListener('click', () => check(true, 'manual'));
    const installBtn = body.querySelector('#up-install');
    if (installBtn) installBtn.addEventListener('click', install);
    const remindBtn = body.querySelector('#up-remind');
    if (remindBtn) remindBtn.addEventListener('click', remindLater);
    const ignoreBtn = body.querySelector('#up-ignore');
    if (ignoreBtn) ignoreBtn.addEventListener('click', ignoreVersion);
  }

  return {
    init, refreshStatus, check, install, snapshot, settingsHtml, wireSettings, render,
    phase: () => state.phase,
    prefs: () => Object.assign({}, prefs)
  };
})();
